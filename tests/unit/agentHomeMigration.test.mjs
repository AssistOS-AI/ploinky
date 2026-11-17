import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateAgentHomes } from '../../cli/utils/agentHomeMigration.js';
import { ensureDataLayout } from '../../cli/utils/dataLayoutMigration.js';

const admitted = { assertMigrationAllowed() {} };
const plan = [{ repoName: 'product', agentName: 'app', sourceKey: 'legacy' }];
function fixture(t, records = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    ensureDataLayout(root, { ...admitted, log() {} });
    fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
    fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify(records));
    const file = (key, value, bytes = 'preserved') => {
        const target = path.join(root, '.data', 'agents', key, value);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return target;
    };
    return { root, file, home: key => path.join(root, '.data', 'agents', key) };
}
test('merges product data with the implicit home, preserving inodes, logs and WAL files', t => {
    const { root, file, home } = fixture(t);
    const database = file('legacy', 'state.sqlite');
    file('legacy', 'state.sqlite-wal'); file('legacy', 'logs/run.log');
    file('app', '.tasksQueue', '[]'); file('app', 'logs/controller.log');
    const inode = fs.statSync(database).ino;
    assert.equal(migrateAgentHomes(root, plan, admitted)[0].action, 'migrated');
    assert.equal(fs.statSync(path.join(home('app'), 'state.sqlite')).ino, inode);
    for (const entry of ['state.sqlite-wal', 'logs/run.log', 'logs/controller.log', '.tasksQueue']) assert.ok(fs.existsSync(path.join(home('app'), entry)));
    assert.equal(fs.existsSync(home('legacy')), false);
    assert.equal(migrateAgentHomes(root, plan, admitted)[0].action, 'unchanged');
});
test('uses the recorded alias, rather than creating a second canonical home', t => {
    const { root, file, home } = fixture(t, { instance: { type: 'agent', repoName: 'product', agentName: 'app', alias: 'remote-alias' } });
    file('legacy', 'model');
    migrateAgentHomes(root, plan, admitted);
    assert.ok(fs.existsSync(path.join(home('remote-alias'), 'model')));
    assert.equal(fs.existsSync(home('app')), false);
});
test('preflights all files before moving anything when a destination conflicts', t => {
    const { root, file, home } = fixture(t);
    const source = file('legacy', 'z.sqlite', 'old'); file('legacy', 'a.log');
    const target = file('app', 'z.sqlite', 'new');
    assert.throws(() => migrateAgentHomes(root, plan, admitted), /conflict/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'old'); assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.ok(fs.existsSync(path.join(home('legacy'), 'a.log')));
});
test('continues a partially completed merge without overwriting the moved entries', t => {
    const { root, file, home } = fixture(t);
    file('legacy', 'remaining'); file('app', 'already-moved');
    migrateAgentHomes(root, plan, admitted);
    assert.deepEqual(fs.readdirSync(home('app')).sort(), ['already-moved', 'remaining']);
});
test('refuses symlinks before moving preceding entries', t => {
    const { root, file, home } = fixture(t);
    file('legacy', 'a'); fs.symlinkSync('/tmp', path.join(home('legacy'), 'z'));
    assert.throws(() => migrateAgentHomes(root, plan, admitted), /symbolic link/);
    assert.ok(fs.existsSync(path.join(home('legacy'), 'a')));
});
test('refuses ambiguous shared old storage and a home owned by another agent', t => {
    const { root, file } = fixture(t, {
        first: { type: 'agent', repoName: 'product', agentName: 'app', alias: 'one' },
        second: { type: 'agent', repoName: 'product', agentName: 'app', alias: 'two' },
    });
    file('legacy', 'db');
    assert.throws(() => migrateAgentHomes(root, plan, admitted), /multiple instances/);
    fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({ foreign: { type: 'agent', repoName: 'other', agentName: 'app' } }));
    assert.throws(() => migrateAgentHomes(root, plan, admitted), /belongs to another/);
});
test('requires offline admission and rejects traversal, reserved names and overlapping moves', t => {
    const { root, file } = fixture(t); file('legacy', 'db');
    assert.throws(() => migrateAgentHomes(root, plan), /offline admission/);
    assert.throws(() => migrateAgentHomes(root, plan, { assertMigrationAllowed() { throw new Error('runtime active'); } }), /runtime active/);
    for (const sourceKey of ['../dpu-data', 'shared', '/etc']) assert.throws(() => migrateAgentHomes(root, [{ ...plan[0], sourceKey }], admitted), /Invalid/);
    assert.throws(() => migrateAgentHomes(root, [...plan, ...plan], admitted), /Overlapping/);
});
test('unchanged canonical homes do not move or rewrite files', t => {
    const { root, file } = fixture(t); const source = file('app', 'model'); const inode = fs.statSync(source).ino;
    assert.equal(migrateAgentHomes(root, [{ ...plan[0], sourceKey: 'app' }], admitted)[0].action, 'unchanged');
    assert.equal(fs.statSync(source).ino, inode);
});

test('SQLite references are rebased offline while unrelated JSON and logs remain unchanged', async t => {
    const { DatabaseSync } = await import('node:sqlite');
    const { root, file, home } = fixture(t);
    file('legacy', 'jobs/a.log', 'historical /data/jobs/a.log');
    const db = new DatabaseSync(path.join(home('legacy'), 'state.sqlite'));
    db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY, result_json TEXT)');
    const result = { files: ['/data/jobs/a.log', `${root}/.data/legacy/jobs/b`, `${root}/.data/agents/legacy/jobs/c`, '/other/file', '/database/file'], message: '/data/keep-history' };
    db.prepare('INSERT INTO jobs VALUES (?,?)').run('job', JSON.stringify(result)); db.close();
    const migration = [{ ...plan[0], sqliteJsonPaths: [{ file: 'state.sqlite', table: 'jobs', key: 'id', column: 'result_json', array: 'files' }] }];
    migrateAgentHomes(root, migration, admitted);
    const moved = new DatabaseSync(path.join(home('app'), 'state.sqlite'));
    const after = JSON.parse(moved.prepare('SELECT result_json FROM jobs').get().result_json);
    assert.deepEqual(after, { ...result, files: ['/root/jobs/a.log', '/root/jobs/b', '/root/jobs/c', '/other/file', '/database/file'] });
    assert.equal(moved.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); moved.close();
    assert.equal(fs.readFileSync(path.join(home('app'), 'jobs/a.log'), 'utf8'), 'historical /data/jobs/a.log');
    assert.equal(fs.existsSync(path.join(root, '.ploinky', 'agent-home-migration-pending.json')), false);
    migrateAgentHomes(root, migration, admitted);
    assert.equal(fs.existsSync(home('legacy')), false);
});

test('failed SQL migration blocks launch after the directory move, rolls back rows, and resumes', async t => {
    const { DatabaseSync } = await import('node:sqlite');
    const { assertNoPendingHomeMigration } = await import('../../cli/utils/runtime/agentHomeMigrationPolicy.js');
    const { root, file, home } = fixture(t); file('legacy', 'log');
    const db = new DatabaseSync(path.join(home('legacy'), 'state.sqlite'));
    db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, result_json TEXT);
        INSERT INTO jobs VALUES ('a','{"files":["/data/a"]}'), ('b','{"files":["/data/b"]}');
        CREATE TRIGGER fail_update BEFORE UPDATE ON jobs WHEN old.id='b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
    db.close();
    const migration = [{ ...plan[0], sqliteJsonPaths: [{ file: 'state.sqlite', table: 'jobs', key: 'id', column: 'result_json', array: 'files' }] }];
    assert.throws(() => migrateAgentHomes(root, migration, admitted), /fixture failure/);
    assert.equal(fs.existsSync(home('legacy')), false);
    assert.throws(() => assertNoPendingHomeMigration(root), /interrupted migration/);
    assert.throws(() => migrateAgentHomes(root, [], admitted), /same plan/);
    const moved = new DatabaseSync(path.join(home('app'), 'state.sqlite'));
    assert.deepEqual(moved.prepare('SELECT result_json FROM jobs ORDER BY id').all().map(r => JSON.parse(r.result_json).files[0]), ['/data/a', '/data/b']);
    moved.exec('DROP TRIGGER fail_update'); moved.close();
    migrateAgentHomes(root, migration, admitted);
    assert.doesNotThrow(() => assertNoPendingHomeMigration(root));
});

test('SQLite preflight refuses unsafe references without moving or creating a replacement database', async t => {
    const { DatabaseSync } = await import('node:sqlite');
    const { root, file, home } = fixture(t); file('legacy', 'log');
    const db = new DatabaseSync(path.join(home('legacy'), 'state.sqlite'));
    db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, result_json TEXT); INSERT INTO jobs VALUES('a','{"files":["/data/../secret"]}');`); db.close();
    const migration = [{ ...plan[0], sqliteJsonPaths: [{ file: 'state.sqlite', table: 'jobs', key: 'id', column: 'result_json', array: 'files' }] }];
    assert.throws(() => migrateAgentHomes(root, migration, admitted), /Unsafe legacy/);
    assert.equal(fs.existsSync(home('app')), false);
    assert.equal(fs.existsSync(path.join(root, '.ploinky', 'agent-home-migration-pending.json')), false);
    file('app', 'state.sqlite', 'new database');
    assert.throws(() => migrateAgentHomes(root, migration, admitted), /conflict/);
    assert.equal(fs.readFileSync(path.join(home('app'), 'state.sqlite'), 'utf8'), 'new database');
});
