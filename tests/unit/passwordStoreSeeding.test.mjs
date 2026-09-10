import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { withPasswordStoreLock } from '../../cli/utils/security/passwordStoreLock.mjs';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-password-seeding-'));
const originalEnv = { ...process.env };
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = 'password-seeding-test-master-seed';
const storeUrl = new URL('../../cli/utils/security/encryptedPasswordStore.js', import.meta.url).href;
const store = await import(storeUrl);
const saved = { version: 1, users: [{ username: 'saved', rev: 7 }] };
const defaults = { version: 1, users: [{ username: 'manifest', rev: 1 }] };

test.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(workspace, { recursive: true, force: true });
});
test.beforeEach(() => {
    fs.rmSync(path.join(workspace, '.ploinky'), { recursive: true, force: true });
});

test('single and batch seeds preserve existing empty entries and unchanged ciphertext', () => {
    store.setUsersPayload('EXISTING', saved);
    store.setUsersPayload('EMPTY', { version: 1, users: [] });
    const before = fs.readFileSync(store.PASSWORD_STORE_FILE);
    assert.deepEqual(store.setUsersPayload('EXISTING', defaults, { ifAbsent: true }), saved);
    assert.deepEqual(store.setUsersPayload('EMPTY', defaults, { ifAbsent: true }), { version: 1, users: [] });
    const rollback = store.setUsersPayloadBatchTransactional([
        { usersVar: 'EXISTING', payload: defaults, ifAbsent: true },
        { usersVar: 'EMPTY', payload: defaults, ifAbsent: true },
    ]);
    assert.deepEqual(fs.readFileSync(store.PASSWORD_STORE_FILE), before);
    store.setUsersPayload('LATER', saved);
    const later = fs.readFileSync(store.PASSWORD_STORE_FILE);
    rollback();
    assert.deepEqual(fs.readFileSync(store.PASSWORD_STORE_FILE), later);
    assert.throws(rollback, /already consumed/);
});

test('batch seeds fresh routes once, honors ordered explicit updates, and restores exact bytes', () => {
    store.setUsersPayload('EXISTING', saved);
    const before = fs.readFileSync(store.PASSWORD_STORE_FILE);
    const rollback = store.setUsersPayloadBatchTransactional([
        { usersVar: 'FRESH', payload: defaults, ifAbsent: true },
        { usersVar: 'FRESH', payload: saved, ifAbsent: true },
        { usersVar: 'EXPLICIT', payload: saved },
        { usersVar: 'EXPLICIT', payload: defaults, ifAbsent: true },
        { usersVar: 'OVERRIDE', payload: defaults, ifAbsent: true },
        { usersVar: 'OVERRIDE', payload: saved },
    ]);
    assert.deepEqual(store.getUsersPayload('FRESH'), defaults);
    assert.deepEqual(store.getUsersPayload('EXPLICIT'), saved);
    assert.deepEqual(store.getUsersPayload('OVERRIDE'), saved);
    assert.deepEqual(store.getUsersPayload('EXISTING'), saved);
    rollback();
    assert.deepEqual(fs.readFileSync(store.PASSWORD_STORE_FILE), before);
});

test('new-store rollback removes only its own publication and refuses later writes', () => {
    const rollback = store.setUsersPayloadBatchTransactional([{ usersVar: 'NEW', payload: defaults, ifAbsent: true }]);
    rollback();
    assert.equal(fs.existsSync(store.PASSWORD_STORE_FILE), false);
    const staleRollback = store.setUsersPayloadBatchTransactional([{ usersVar: 'NEW', payload: defaults, ifAbsent: true }]);
    store.setUsersPayload('LATER', saved);
    const later = fs.readFileSync(store.PASSWORD_STORE_FILE);
    assert.throws(staleRollback, /refusing stale rollback/);
    assert.deepEqual(fs.readFileSync(store.PASSWORD_STORE_FILE), later);
});

test('invalid batch and corrupt saved envelope fail without publishing manifest defaults', () => {
    store.setUsersPayload('EXISTING', saved);
    const before = fs.readFileSync(store.PASSWORD_STORE_FILE);
    assert.throws(() => store.setUsersPayloadBatchTransactional([
        { usersVar: 'NEW', payload: defaults, ifAbsent: true }, { usersVar: '' },
    ]), /requires usersVar/);
    assert.deepEqual(fs.readFileSync(store.PASSWORD_STORE_FILE), before);
    fs.writeFileSync(store.PASSWORD_STORE_FILE, 'corrupt-envelope');
    assert.throws(() => store.setUsersPayload('EXISTING', defaults, { ifAbsent: true }), /Unable to decrypt/);
    assert.equal(fs.readFileSync(store.PASSWORD_STORE_FILE, 'utf8'), 'corrupt-envelope');
    assert.equal(fs.existsSync(`${store.PASSWORD_STORE_FILE}.lock`), false);
});

test('store lock releases failed mutations and preserves an occupied lock', () => {
    assert.throws(() => withPasswordStoreLock(store.PASSWORD_STORE_FILE, () => { throw new Error('test failure'); }), /test failure/);
    assert.equal(fs.existsSync(`${store.PASSWORD_STORE_FILE}.lock`), false);
    fs.writeFileSync(`${store.PASSWORD_STORE_FILE}.lock`, 'unknown-owner');
    let called = false;
    assert.throws(() => withPasswordStoreLock(store.PASSWORD_STORE_FILE, () => { called = true; }, { waitMs: 0 }), {
        code: 'PLOINKY_PASSWORD_STORE_BUSY',
    });
    assert.equal(called, false);
    assert.equal(fs.readFileSync(`${store.PASSWORD_STORE_FILE}.lock`, 'utf8'), 'unknown-owner');
});

test('release cannot remove another acquisition that replaced its lock path', () => {
    const lockPath = `${store.PASSWORD_STORE_FILE}.lock`;
    assert.throws(() => withPasswordStoreLock(store.PASSWORD_STORE_FILE, () => {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, 'replacement-owner', { flag: 'wx' });
    }), /lock changed before release/);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'replacement-owner');
});

async function waitForFile(file) {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file)) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for test child');
        await delay(10);
    }
}

test('a concurrent explicit writer waits for the seed transaction and retains both route updates', async () => {
    store.setUsersPayload('EXISTING', saved);
    const paused = path.join(workspace, 'paused');
    const release = path.join(workspace, 'release');
    const entered = path.join(workspace, 'entered');
    const completed = path.join(workspace, 'completed');
    const children = [];
    function child(source) {
        const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], {
            env: globalThis.process.env, stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        process.stderr.on('data', (data) => { stderr += data; });
        const completion = new Promise((resolve) => process.once('close', (code) => resolve({ code, stderr })));
        children.push({ process, completion });
        return completion;
    }
    try {
        const seed = child(`
            import fs from 'node:fs';
            const store = await import(${JSON.stringify(storeUrl)});
            const read = fs.readFileSync;
            let paused = false;
            fs.readFileSync = function(file, ...args) {
                const result = read.call(this, file, ...args);
                if (!paused && file === store.PASSWORD_STORE_FILE) {
                    paused = true;
                    fs.writeFileSync(${JSON.stringify(paused)}, 'ready');
                    const deadline = Date.now() + 5000;
                    while (!fs.existsSync(${JSON.stringify(release)})) {
                        if (Date.now() >= deadline) throw new Error('seed pause timed out');
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                    }
                }
                return result;
            };
            store.setUsersPayload('NEW', ${JSON.stringify(defaults)}, { ifAbsent: true });
        `);
        await waitForFile(paused);
        const explicit = child(`
            import fs from 'node:fs';
            const store = await import(${JSON.stringify(storeUrl)});
            fs.writeFileSync(${JSON.stringify(entered)}, 'entered');
            store.setUsersPayloadBatchTransactional([
                { usersVar: 'NEW', payload: ${JSON.stringify(saved)} },
                { usersVar: 'OTHER', payload: ${JSON.stringify(saved)} }
            ]);
            fs.writeFileSync(${JSON.stringify(completed)}, 'completed');
        `);
        await waitForFile(entered);
        await delay(75);
        assert.equal(fs.existsSync(completed), false, 'writer cannot publish while the seed owns the store mutation');
        fs.writeFileSync(release, 'release');
        assert.deepEqual(await seed, { code: 0, stderr: '' });
        assert.deepEqual(await explicit, { code: 0, stderr: '' });
        assert.deepEqual(store.getUsersPayload('NEW'), saved);
        assert.deepEqual(store.getUsersPayload('OTHER'), saved);
        assert.deepEqual(store.getUsersPayload('EXISTING'), saved);
        assert.equal(fs.existsSync(`${store.PASSWORD_STORE_FILE}.lock`), false);
    } finally {
        fs.writeFileSync(release, 'release');
        await Promise.all(children.map(({ completion }) => completion));
    }
});
