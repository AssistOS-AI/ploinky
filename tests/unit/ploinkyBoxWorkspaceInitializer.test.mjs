import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { initializeWorkspaceMasterKey } from '../../ploinky-box/entrypoint/initialize-workspace.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-key-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('empty workspace gets one private random key that remains byte-stable', (t) => {
    const root = fixture(t);
    const first = initializeWorkspaceMasterKey({ workspaceRoot: root });
    const bytes = fs.readFileSync(first.path);
    assert.equal(first.created, true);
    assert.match(bytes.toString('utf8'), /^PLOINKY_MASTER_KEY=[a-f0-9]{64}\n$/);
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);

    fs.chmodSync(first.path, 0o644);
    const second = initializeWorkspaceMasterKey({ workspaceRoot: root });
    assert.equal(second.created, false);
    assert.deepEqual(fs.readFileSync(first.path), bytes);
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
});

test('current resolveMasterKey succeeds without a host-provided key', (t) => {
    const root = fixture(t);
    initializeWorkspaceMasterKey({ workspaceRoot: root });
    const moduleUrl = pathToFileURL(path.join(repositoryRoot, 'cli/utils/security/masterKey.js')).href;
    const script = [
        `const { resolveMasterKey } = await import(${JSON.stringify(moduleUrl)});`,
        "process.stdout.write(String(resolveMasterKey().length));",
    ].join('\n');
    const env = { ...process.env };
    delete env.PLOINKY_MASTER_KEY;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        env,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '32');
});

test('existing invalid content fails without changing bytes or mode', (t) => {
    const root = fixture(t);
    const target = path.join(root, '.env');
    fs.writeFileSync(target, 'UNRELATED=value\n', { mode: 0o640 });
    const before = fs.readFileSync(target);
    const beforeMode = fs.statSync(target).mode & 0o777;
    assert.throws(() => initializeWorkspaceMasterKey({ workspaceRoot: root }), /content was not changed/);
    assert.deepEqual(fs.readFileSync(target), before);
    assert.equal(fs.statSync(target).mode & 0o777, beforeMode);
});

test('symlink, directory, FIFO, and hard-linked targets fail closed', (t) => {
    const types = ['symlink', 'directory', 'fifo', 'hardlink'];
    for (const type of types) {
        const parent = path.join(fixture(t), type);
        fs.mkdirSync(parent);
        const target = path.join(parent, '.env');
        if (type === 'symlink') {
            const foreign = path.join(parent, 'foreign');
            fs.writeFileSync(foreign, `PLOINKY_MASTER_KEY=${'a'.repeat(64)}\n`);
            fs.symlinkSync(foreign, target);
        } else if (type === 'directory') {
            fs.mkdirSync(target);
        } else if (type === 'fifo') {
            const result = spawnSync('mkfifo', [target]);
            assert.equal(result.status, 0);
        } else {
            const foreign = path.join(parent, 'foreign');
            fs.writeFileSync(foreign, `PLOINKY_MASTER_KEY=${'a'.repeat(64)}\n`);
            fs.linkSync(foreign, target);
        }
        assert.throws(() => initializeWorkspaceMasterKey({ workspaceRoot: parent }), /not a private regular file/);
    }
});

test('exclusive creation handles a concurrent winner without overwriting it', (t) => {
    const root = fixture(t);
    const winner = `PLOINKY_MASTER_KEY=${'b'.repeat(64)}\n`;
    let openCalls = 0;
    const fsApi = Object.create(fs);
    fsApi.openSync = (...args) => {
        openCalls += 1;
        if (openCalls === 1) {
            fs.writeFileSync(path.join(root, '.env'), winner, { mode: 0o600 });
            throw Object.assign(new Error('winner'), { code: 'EEXIST' });
        }
        return fs.openSync(...args);
    };
    const result = initializeWorkspaceMasterKey({ workspaceRoot: root, fsApi });
    assert.equal(result.created, false);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), winner);
});

test('write or permission failure removes only the newly created incomplete file', (t) => {
    const root = fixture(t);
    const fsApi = Object.create(fs);
    fsApi.fsyncSync = () => { throw Object.assign(new Error('unwritable'), { code: 'EIO' }); };
    assert.throws(() => initializeWorkspaceMasterKey({ workspaceRoot: root, fsApi }), /Unable to initialize/);
    assert.equal(fs.existsSync(path.join(root, '.env')), false);
});
