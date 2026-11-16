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
