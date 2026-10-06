import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initializeWorkspaceMasterKey } from '../../ploinky-box/entrypoint/initialize-workspace.mjs';

const masterKeyModule = await import('../../cli/utils/security/masterKey.js');
const { createSubkeyDeriver, MASTER_KEY_VAR } = masterKeyModule;

const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);

function expectedSubkey(seed, purpose, length = 32) {
    const ikm = crypto.createHash('sha256').update(seed, 'utf8').digest();
    return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(`ploinky/${purpose}/v1`, 'utf8'), length));
}

function createWorkspace(t, seed = KEY_A) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-subkey-')));
    t.after(() => {
        for (const dir of [workspace, path.join(workspace, '.ploinky'), path.join(workspace, '.ploinky', 'data')]) {
            try { fs.chmodSync(dir, 0o700); } catch (_) { }
        }
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    initializeWorkspaceMasterKey({
        workspaceRoot: workspace,
        randomBytes: () => Buffer.from(seed, 'hex'),
    });
    return {
        workspace,
        keyPath: path.join(workspace, '.ploinky', 'data', 'master-key'),
        dataDir: path.join(workspace, '.ploinky', 'data'),
    };
}

// Counts readWorkspaceMasterKey calls: each read opens the key file exactly once.
function countingFs(keyPath) {
    const counts = { keyReads: 0 };
    const api = Object.create(fs);
    api.openSync = (target, ...rest) => {
        if (target === keyPath) counts.keyReads += 1;
        return fs.openSync(target, ...rest);
    };
    return { api, counts };
}

function replaceKeyFile(keyPath, seed) {
    const staged = `${keyPath}.next`;
    fs.writeFileSync(staged, `${seed}\n`, { mode: 0o600 });
    fs.chmodSync(staged, 0o600);
    fs.renameSync(staged, keyPath);
}

function managedDeriver(workspace, api, clock) {
    return createSubkeyDeriver({
        isManaged: true,
        workspaceRoot: workspace,
        fsApi: api,
        now: () => clock.now,
    });
}

test('managed subkeys: 100 derives within the revalidation window read the master key once', (t) => {
    const { workspace, keyPath } = createWorkspace(t);
    const { api, counts } = countingFs(keyPath);
    const clock = { now: 10_000 };
    const deriver = managedDeriver(workspace, api, clock);

    const expected = expectedSubkey(KEY_A, 'router-browser-csrf');
    for (let index = 0; index < 100; index += 1) {
        clock.now = 10_000 + index * 9; // stays inside the 1000 ms window
        assert.deepEqual(deriver.derive('router-browser-csrf'), expected);
    }
    assert.equal(counts.keyReads, 1);
    assert.equal(deriver.cacheSize(), 1);
});

test('managed subkeys: a replaced key file yields a different subkey after the revalidation window', (t) => {
    const { workspace, keyPath } = createWorkspace(t);
    const { api, counts } = countingFs(keyPath);
    const clock = { now: 50_000 };
    const deriver = managedDeriver(workspace, api, clock);

    const first = deriver.derive('session');
    assert.deepEqual(first, expectedSubkey(KEY_A, 'session'));
    replaceKeyFile(keyPath, KEY_B);

    clock.now += 1001;
    const second = deriver.derive('session');
    assert.notDeepEqual(second, first);
    assert.deepEqual(second, expectedSubkey(KEY_B, 'session'));
    assert.equal(counts.keyReads, 2);
});

test('managed subkeys: a deleted key file fails closed and empties the cache', (t) => {
    const { workspace, keyPath } = createWorkspace(t);
    const { api } = countingFs(keyPath);
    const clock = { now: 1_000 };
    const deriver = managedDeriver(workspace, api, clock);

    deriver.derive('session');
    deriver.derive('invocation');
    assert.equal(deriver.cacheSize(), 2);
    fs.rmSync(keyPath);

    clock.now += 1001;
    const unreadable = (error) => error?.code === 'PLOINKY_BOX_WORKSPACE_INITIALIZATION_FAILED'
        && /Unable to read managed workspace master key/.test(error.message);
    assert.throws(() => deriver.derive('session'), unreadable);
    assert.equal(deriver.cacheSize(), 0);
    // Still closed on the next call: no cached subkey survives the failure.
    assert.throws(() => deriver.derive('invocation'), unreadable);
    assert.equal(deriver.cacheSize(), 0);
});

test('managed subkeys: a state directory mode change fails closed and empties the cache',
    { skip: process.getuid?.() === 0 && 'root bypasses directory permission checks' }, (t) => {
        const { workspace, keyPath, dataDir } = createWorkspace(t);
        const { api } = countingFs(keyPath);
        const clock = { now: 1_000 };
        const deriver = managedDeriver(workspace, api, clock);

        deriver.derive('session');
        assert.equal(deriver.cacheSize(), 1);
        fs.chmodSync(dataDir, 0o000);

        clock.now += 1001;
        assert.throws(() => deriver.derive('session'), /Unable to read managed workspace master key/);
        assert.equal(deriver.cacheSize(), 0);
    });

test('managed subkeys: any state directory fingerprint change re-reads the key through every check', (t) => {
    const { workspace, keyPath } = createWorkspace(t);
    const { api, counts } = countingFs(keyPath);
    const clock = { now: 1_000 };
    const deriver = managedDeriver(workspace, api, clock);
    const expected = expectedSubkey(KEY_A, 'session');

    assert.deepEqual(deriver.derive('session'), expected);
    clock.now += 1001;
    assert.deepEqual(deriver.derive('session'), expected);
    assert.equal(counts.keyReads, 1, 'an unchanged stamp must not re-read the key');

    // A permission change on .ploinky leaves the key file's lstat untouched.
    fs.chmodSync(path.join(workspace, '.ploinky'), 0o711);
    clock.now += 500;
    assert.deepEqual(deriver.derive('session'), expected);
    assert.equal(counts.keyReads, 1, 'the stamp is re-checked at most once per window');
    clock.now += 501;
    assert.deepEqual(deriver.derive('session'), expected);
    assert.equal(counts.keyReads, 2);
});

test('managed subkeys: a retired controller secret appearing later is refused like a fresh read', (t) => {
    const { workspace, keyPath } = createWorkspace(t);
    const { api } = countingFs(keyPath);
    const clock = { now: 1_000 };
    const deriver = managedDeriver(workspace, api, clock);

    deriver.derive('session');
    fs.writeFileSync(path.join(workspace, '.ploinky', '.secrets'), 'X=1\n', { mode: 0o600 });

    clock.now += 1001;
    assert.throws(() => deriver.derive('session'), (error) => error?.code === 'PLOINKY_RETIRED_CONTROLLER_SECRETS');
    assert.equal(deriver.cacheSize(), 0);
});

test('managed subkeys: mutating a returned buffer does not change the next result', (t) => {
    const { workspace, keyPath } = createWorkspace(t);
    const { api, counts } = countingFs(keyPath);
    const clock = { now: 1_000 };
    const deriver = managedDeriver(workspace, api, clock);
    const expected = expectedSubkey(KEY_A, 'derived-master');

    const first = deriver.derive('derived-master');
    first.fill(0);
    const second = deriver.derive('derived-master');
    assert.deepEqual(second, expected);
    second.fill(0xff);
    assert.deepEqual(deriver.derive('derived-master'), expected);
    assert.equal(counts.keyReads, 1);
});

test('managed subkeys: the cache is bounded and keyed by purpose and length', (t) => {
    const { workspace, keyPath } = createWorkspace(t);
    const { api, counts } = countingFs(keyPath);
    const clock = { now: 1_000 };
    const deriver = createSubkeyDeriver({
        isManaged: true, workspaceRoot: workspace, fsApi: api, now: () => clock.now, maxEntries: 2,
    });

    assert.deepEqual(deriver.derive('a', 16), expectedSubkey(KEY_A, 'a', 16));
    assert.deepEqual(deriver.derive('a', 32), expectedSubkey(KEY_A, 'a', 32));
    assert.deepEqual(deriver.derive('b'), expectedSubkey(KEY_A, 'b'));
    assert.equal(deriver.cacheSize(), 2);
    assert.equal(counts.keyReads, 3);
    // The oldest entry ('a'|16) was evicted and is re-derived from a fresh read.
    assert.deepEqual(deriver.derive('a', 16), expectedSubkey(KEY_A, 'a', 16));
    assert.equal(counts.keyReads, 4);
});

test('unmanaged subkeys stay uncached and follow the current environment seed', (t) => {
    const previous = process.env[MASTER_KEY_VAR];
    t.after(() => {
        if (previous === undefined) delete process.env[MASTER_KEY_VAR];
        else process.env[MASTER_KEY_VAR] = previous;
    });
    const deriver = createSubkeyDeriver({ isManaged: false });

    process.env[MASTER_KEY_VAR] = KEY_A;
    assert.deepEqual(deriver.derive('session'), expectedSubkey(KEY_A, 'session'));
    process.env[MASTER_KEY_VAR] = KEY_B;
    assert.deepEqual(deriver.derive('session'), expectedSubkey(KEY_B, 'session'));
    assert.equal(deriver.cacheSize(), 0);
});
