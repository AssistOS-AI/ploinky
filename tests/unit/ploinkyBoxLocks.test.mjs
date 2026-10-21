import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { LIVENESS } from '../../ploinky-box/lockLiveness.mjs';
import {
    MUTATION_LOCK_LOCATION,
    createMutationLockManager,
    parseLockOwner,
    withWorkspaceMutationLock,
} from '../../ploinky-box/locks.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const locksModuleUrl = pathToFileURL(path.join(projectRoot, 'ploinky-box/locks.mjs')).href;

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-lock-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function workspaceIn(root, name = 'workspace') {
    const workspace = path.join(root, name);
    fs.mkdirSync(workspace);
    return { workspace, identity: buildWorkspaceIdentity(workspace) };
}

const lockPathOf = (workspace) => path.join(workspace, '.ploinky-host', 'locks', 'workspace.lock');
const ownerOf = (workspace) => JSON.parse(fs.readFileSync(path.join(lockPathOf(workspace), 'owner.json'), 'utf8'));
const mode = (target) => fs.statSync(target).mode & 0o777;

// A liveness stand-in: `self` names this "process"; `dead` lists PIDs proven gone.
function fakeLiveness({ pid = 4242, dead = [], undetermined = [] } = {}) {
    const local = { hostname: 'test-host', machineId: 'm'.repeat(32), bootId: '11111111-1111-4111-8111-111111111111', pidNamespace: 'pid:[1]' };
    return {
        localIdentity: () => local,
        selfFields: () => ({ ...local, pid, processStart: `linux:${pid}` }),
        processStart: (value) => `linux:${value}`,
        classify(owner) {
            if (dead.includes(owner.pid)) return { state: LIVENESS.stale, reason: 'its process no longer exists' };
            if (undetermined.includes(owner.pid)) return { state: LIVENESS.undetermined, reason: 'it is held on another machine' };
            return { state: LIVENESS.live, reason: 'its process is running' };
        },
    };
}

function plantLock(workspace, owner) {
    const lockPath = lockPathOf(workspace);
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    if (owner !== undefined) {
        fs.writeFileSync(path.join(lockPath, 'owner.json'), typeof owner === 'string' ? owner : `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    }
    return lockPath;
}

function v2Owner(overrides = {}) {
    return {
        schema: 'ploinky-lock', version: 2, label: 'workspace', instance: null, workspaceRoot: null,
        hostname: 'test-host', machineId: 'm'.repeat(32), bootId: '11111111-1111-4111-8111-111111111111',
        pidNamespace: 'pid:[1]', pid: 999999, processStart: 'linux:1', startedAt: new Date(0).toISOString(),
        ...overrides,
    };
}

test('the lock module declares the workspace generation and lives in the workspace skeleton', async (t) => {
    assert.equal(MUTATION_LOCK_LOCATION, 'workspace');
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    const manager = createMutationLockManager({ homeDirectory: path.join(root, 'home') });
    const lock = await manager.acquire(identity.instance, { workspaceRoot: workspace });
    assert.equal(lock.path, lockPathOf(workspace));
    assert.equal(mode(path.join(workspace, '.ploinky-host')), 0o700);
    assert.equal(mode(path.join(workspace, '.ploinky-host', 'locks')), 0o700);
    assert.equal(mode(path.join(workspace, '.ploinky-host', 'quarantine')), 0o700);
    assert.equal(mode(path.join(workspace, '.ploinky-host', 'empty')), 0o555);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.ploinky-host', 'empty')), []);
    assert.equal(mode(lock.path), 0o700);
    assert.equal(fs.statSync(path.join(lock.path, 'owner.json')).mode & 0o777, 0o600);
    const owner = ownerOf(workspace);
    assert.deepEqual(Object.keys(owner), ['schema', 'version', 'label', 'instance', 'workspaceRoot', 'hostname',
        'machineId', 'bootId', 'pidNamespace', 'pid', 'processStart', 'startedAt']);
    assert.equal(owner.schema, 'ploinky-lock');
    assert.equal(owner.version, 2);
    assert.equal(owner.label, 'workspace');
    assert.equal(owner.instance, identity.instance);
    assert.equal(owner.workspaceRoot, workspace);
    assert.equal(owner.pid, process.pid);
    lock.release();
    assert.equal(fs.existsSync(lock.path), false);
    assert.equal(fs.existsSync(path.join(root, 'home')), false, 'nothing is written under the home directory');
    // The skeleton is never removed by code.
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.ploinky-host')).sort(), ['empty', 'locks', 'quarantine']);
});

test('acquire requires an existing absolute workspace root', async (t) => {
    const root = fixture(t);
    const { identity } = workspaceIn(root);
    const manager = createMutationLockManager();
    await assert.rejects(() => manager.acquire(identity.instance), { code: 'PLOINKY_BOX_LOCK_WORKSPACE_REQUIRED' });
    await assert.rejects(() => manager.acquire(identity.instance, { workspaceRoot: 'relative/ws' }),
        { code: 'PLOINKY_BOX_LOCK_WORKSPACE_REQUIRED' });
    await assert.rejects(() => manager.acquire(identity.instance, { workspaceRoot: path.join(root, 'missing') }),
        { code: 'PLOINKY_BOX_WORKSPACE_ABSENT' });
    fs.writeFileSync(path.join(root, 'file'), 'x');
    await assert.rejects(() => manager.acquire(identity.instance, { workspaceRoot: path.join(root, 'file') }),
        { code: 'PLOINKY_BOX_WORKSPACE_INVALID' });
    assert.equal(fs.existsSync(path.join(root, 'missing')), false, 'an absent workspace is never created');
});

test('requireNewSkeleton refuses a pre-existing .ploinky-host and accepts a fresh workspace', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    const manager = createMutationLockManager();
    const fresh = await manager.acquire(identity.instance, { workspaceRoot: workspace, requireNewSkeleton: true });
    fresh.release();
    await assert.rejects(() => manager.acquire(identity.instance, { workspaceRoot: workspace, requireNewSkeleton: true }),
        { code: 'PLOINKY_BOX_HOST_STATE_NOT_NEW' });
    const again = await manager.acquire(identity.instance, { workspaceRoot: workspace });
    again.release();
});

test('skeleton components must be private real directories and the mask source must stay empty', async (t) => {
    const root = fixture(t);
    const manager = createMutationLockManager({ timeoutMs: 20 });

    const linked = workspaceIn(root, 'linked');
    const evil = path.join(root, 'evil');
    fs.mkdirSync(evil);
    fs.symlinkSync(evil, path.join(linked.workspace, '.ploinky-host'), 'dir');
    await assert.rejects(() => manager.acquire(linked.identity.instance, { workspaceRoot: linked.workspace }),
        { code: 'PLOINKY_BOX_HOST_STATE_INVALID' });
    assert.deepEqual(fs.readdirSync(evil), [], 'nothing is created through a symlinked skeleton');

    const filled = workspaceIn(root, 'filled');
    fs.mkdirSync(path.join(filled.workspace, '.ploinky-host', 'empty'), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(filled.workspace, '.ploinky-host', 'empty', 'planted'), 'x');
    fs.chmodSync(path.join(filled.workspace, '.ploinky-host', 'empty'), 0o555);
    await assert.rejects(() => manager.acquire(filled.identity.instance, { workspaceRoot: filled.workspace }),
        { code: 'PLOINKY_BOX_HOST_STATE_INVALID' });
    fs.chmodSync(path.join(filled.workspace, '.ploinky-host', 'empty'), 0o755);

    const shared = workspaceIn(root, 'shared');
    fs.mkdirSync(path.join(shared.workspace, '.ploinky-host', 'locks'), { recursive: true });
    fs.chmodSync(path.join(shared.workspace, '.ploinky-host'), 0o700);
    fs.chmodSync(path.join(shared.workspace, '.ploinky-host', 'locks'), 0o777);
    await assert.rejects(() => manager.acquire(shared.identity.instance, { workspaceRoot: shared.workspace }),
        { code: 'PLOINKY_BOX_HOST_STATE_INVALID' });
    assert.equal(mode(path.join(shared.workspace, '.ploinky-host', 'locks')), 0o777, 'existing modes are not rewritten');
});

test('A6/N12: a stale holder is reclaimed only on positive evidence and never with residue', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    fs.mkdirSync(path.join(workspace, '.ploinky-host'), { mode: 0o700 });
    const dead = 999999;
    const liveness = fakeLiveness({ dead: [dead], undetermined: [123] });
    const manager = createMutationLockManager({ liveness, retryMs: 1, timeoutMs: 30 });

    plantLock(workspace, v2Owner({ pid: dead }));
    // A reclaim is retried at once, so even a zero timeout acquires a freed lock.
    const recovered = await createMutationLockManager({ liveness, retryMs: 1, timeoutMs: 0 })
        .acquire(identity.instance, { workspaceRoot: workspace });
    assert.equal(ownerOf(workspace).pid, 4242);
    recovered.release();

    plantLock(workspace, v2Owner({ pid: 123, machineId: 'f'.repeat(32), processStart: 'linux:77' }));
    const busy = await manager.acquire(identity.instance, { workspaceRoot: workspace }).then(() => null, (error) => error);
    assert.equal(busy?.lockBusy, true);
    assert.match(busy.message, /pid 123 on test-host/);
    assert.match(busy.message, new RegExp(`machine ${'f'.repeat(32)}`));
    assert.match(busy.message, /boot 11111111-1111-4111-8111-111111111111/);
    assert.match(busy.message, /process started linux:77/);
    assert.match(busy.message, /it is held on another machine/);
    assert.match(busy.message, /`ploinky unlock`/);
    assert.match(busy.message, new RegExp(`ploinky unlock --force-holder 123@${'f'.repeat(32)}`));
    assert.equal(ownerOf(workspace).pid, 123, 'an undetermined holder keeps the lock');
    fs.rmSync(lockPathOf(workspace), { recursive: true });

    const lockPath = plantLock(workspace, v2Owner({ pid: dead }));
    fs.writeFileSync(path.join(lockPath, 'candidate-0123456789abcdef.cid'), 'abc\n');
    const residue = await manager.acquire(identity.instance, { workspaceRoot: workspace }).then(() => null, (error) => error);
    assert.equal(residue?.lockResidue, true);
    assert.deepEqual(residue.residue, ['candidate-0123456789abcdef.cid']);
    assert.match(residue.message, /`ploinky unlock`/);
    assert.deepEqual(fs.readdirSync(lockPath).sort(), ['candidate-0123456789abcdef.cid', 'owner.json'], 'the lock was left in place');
});

test('ownerless and non-v2 locks are busy, never reclaimed', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    fs.mkdirSync(path.join(workspace, '.ploinky-host'), { mode: 0o700 });
    const manager = createMutationLockManager({ liveness: fakeLiveness({ dead: [999999] }), retryMs: 1, timeoutMs: 25 });

    // An empty directory at the lock name holds nothing: the atomic publish
    // replaces it. One with content but no owner was abandoned: never reclaimed.
    const empty = plantLock(workspace);
    const replaced = await manager.acquire(identity.instance, { workspaceRoot: workspace });
    assert.equal(ownerOf(workspace).pid, 4242);
    replaced.release();
    assert.equal(fs.existsSync(empty), false);
    const ownerless = plantLock(workspace);
    fs.writeFileSync(path.join(ownerless, 'candidate-0123456789abcdef.cid'), 'abc\n');
    const first = await manager.acquire(identity.instance, { workspaceRoot: workspace }).then(() => null, (error) => error);
    assert.equal(first?.lockBusy, true);
    assert.match(first.message, /no owner record but is not empty/);
    assert.deepEqual(fs.readdirSync(ownerless), ['candidate-0123456789abcdef.cid']);
    fs.rmSync(ownerless, { recursive: true });

    // An earlier (v1) owner record is not trusted, even for a dead pid.
    plantLock(workspace, { hostname: 'test-host', pid: 999999, instance: identity.instance, startedAt: new Date(0).toISOString() });
    const legacy = await manager.acquire(identity.instance, { workspaceRoot: workspace }).then(() => null, (error) => error);
    assert.equal(legacy?.lockBusy, true);
    assert.match(legacy.message, /cannot be attributed/);
    assert.equal(parseLockOwner(fs.readFileSync(path.join(lockPathOf(workspace), 'owner.json'))), null);
});

test('reclaimers are serialized: a second reclaimer never removes the lock the first one acquired', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    fs.mkdirSync(path.join(workspace, '.ploinky-host'), { mode: 0o700 });
    const dead = 999999;
    plantLock(workspace, v2Owner({ pid: dead }));
    const first = createMutationLockManager({ liveness: fakeLiveness({ pid: 111, dead: [dead] }), retryMs: 1, timeoutMs: 1000 });
    let firstLock = null;
    // The second waiter has already classified the dead owner as stale. Just
    // before it enters its reclaim, the first waiter reclaims and acquires.
    const interleaving = {
        ...fs,
        mkdirSync(target, options) {
            if (!firstLock && String(target).endsWith('workspace.lock.reclaim')) {
                firstLock = first.acquireSync(identity.instance, { workspaceRoot: workspace });
            }
            return fs.mkdirSync(target, options);
        },
    };
    const second = createMutationLockManager({ fsApi: interleaving, liveness: fakeLiveness({ pid: 222, dead: [dead] }), retryMs: 1, timeoutMs: 40 });
    const error = await second.acquire(identity.instance, { workspaceRoot: workspace }).then(() => null, (failure) => failure);
    assert.ok(firstLock, 'the interleaving ran');
    assert.equal(error?.lockBusy, true, 'the second waiter waits for the live holder');
    assert.equal(ownerOf(workspace).pid, 111, 'the first holder still owns the lock');
    firstLock.assertHeld(identity.instance);
    firstLock.release();
    assert.equal(fs.existsSync(`${lockPathOf(workspace)}.reclaim`), false, 'the reclaim guard is removed');
});

function holderScript({ workspaceRoot, instance, holdMs, events, who }) {
    return `
        import fs from 'node:fs';
        const { createMutationLockManager } = await import(${JSON.stringify(locksModuleUrl)});
        const lock = await createMutationLockManager({ retryMs: 5 }).acquire(${JSON.stringify(instance)}, { workspaceRoot: ${JSON.stringify(workspaceRoot)} });
        fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ who: ${JSON.stringify(who)}, event: 'acquired', t: Date.now(), path: lock.path }) + '\\n');
        await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
        fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ who: ${JSON.stringify(who)}, event: 'releasing', t: Date.now() }) + '\\n');
        lock.release();
    `;
}

function runNode(script) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stderr }));
    });
}

test('N13: two processes acquiring through the workspace and through an alias spelling are serialized', async (t) => {
    const root = fixture(t);
    const { workspace } = workspaceIn(root);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(workspace, alias, 'dir');
    const events = path.join(root, 'events.log');
    const viaWorkspace = buildWorkspaceIdentity(workspace).instance;
    const viaAlias = buildWorkspaceIdentity(alias).instance;
    assert.notEqual(viaWorkspace, viaAlias, 'the two spellings are different identities');
    const [a, b] = await Promise.all([
        runNode(holderScript({ workspaceRoot: workspace, instance: viaWorkspace, holdMs: 300, events, who: 'workspace' })),
        runNode(holderScript({ workspaceRoot: alias, instance: viaAlias, holdMs: 300, events, who: 'alias' })),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const log = fs.readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const span = (who) => [log.find((e) => e.who === who && e.event === 'acquired').t, log.find((e) => e.who === who && e.event === 'releasing').t];
    const [ws, we] = span('workspace');
    const [as, ae] = span('alias');
    assert.ok(we <= as || ae <= ws, `lock intervals overlap: workspace ${ws}-${we}, alias ${as}-${ae}`);
    assert.equal(fs.existsSync(lockPathOf(workspace)), false);
});

test('N13b: a waiter re-creates a deleted skeleton and acquires', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    const manager = createMutationLockManager({ retryMs: 2, timeoutMs: 2000 });
    const held = await manager.acquire(identity.instance, { workspaceRoot: workspace });
    const waiting = manager.acquire(identity.instance, { workspaceRoot: workspace });
    await delay(30);
    // Released and deleted in one synchronous step: the waiter never sees the gap.
    held.release();
    fs.rmSync(path.join(workspace, '.ploinky-host'), { recursive: true, force: true });
    const acquired = await waiting;
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky-host', 'empty')), true, 'the skeleton was re-created');
    acquired.assertHeld(identity.instance);
    acquired.release();
});

test('N13c: a renamed workspace relocates the held lock; release follows it by inode', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    const manager = createMutationLockManager();
    const lock = await manager.acquire(identity.instance, { workspaceRoot: workspace });
    assert.throws(() => lock.assertHeld('ploinky-box-other-0123456789ab'), { code: 'PLOINKY_BOX_LOCK_INSTANCE_MISMATCH' });
    const moved = path.join(root, 'backup');
    fs.renameSync(workspace, moved);
    assert.throws(() => lock.assertHeld(identity.instance), { code: 'PLOINKY_BOX_LOCK_RELOCATED' });
    assert.throws(() => lock.release(), { code: 'PLOINKY_BOX_LOCK_RELOCATED' });
    lock.assertHeldAt(moved);

    // Same owner bytes at another inode: refused.
    const decoy = path.join(root, 'decoy');
    fs.mkdirSync(decoy);
    const decoyLock = plantLock(decoy, fs.readFileSync(path.join(lockPathOf(moved), 'owner.json'), 'utf8'));
    assert.throws(() => lock.assertHeldAt(decoy), { code: 'PLOINKY_BOX_LOCK_NOT_AT_PATH' });
    assert.throws(() => lock.releaseRelocated(decoy), { code: 'PLOINKY_BOX_LOCK_NOT_AT_PATH' });
    assert.equal(fs.existsSync(path.join(decoyLock, 'owner.json')), true, 'the decoy lock was not touched');

    // A recreated workspace takes its own lock while the relocated one is held.
    fs.mkdirSync(workspace);
    const successor = await manager.acquire(identity.instance, { workspaceRoot: workspace, requireNewSkeleton: true });
    lock.releaseRelocated(moved);
    assert.equal(fs.existsSync(lockPathOf(moved)), false);
    assert.throws(() => lock.assertHeld(identity.instance), { code: 'PLOINKY_BOX_LOCK_NOT_HELD' });
    successor.assertHeld(identity.instance);
    successor.release();
});

test('relinquishDeleted succeeds only once the workspace is gone', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    const manager = createMutationLockManager({ timeoutMs: 20 });
    const lock = await manager.acquire(identity.instance, { workspaceRoot: workspace });
    assert.throws(() => lock.relinquishDeleted(), { code: 'PLOINKY_BOX_WORKSPACE_PRESENT' });
    lock.assertHeld(identity.instance);
    const doomed = path.join(root, 'workspace.deleting');
    fs.renameSync(workspace, doomed);
    fs.rmSync(doomed, { recursive: true });
    lock.relinquishDeleted();
    assert.throws(() => lock.release(), { code: 'PLOINKY_BOX_LOCK_NOT_HELD' });
    await assert.rejects(() => manager.acquire(identity.instance, { workspaceRoot: workspace }), { code: 'PLOINKY_BOX_WORKSPACE_ABSENT' });
});

test('acquireAt takes a labelled lock at an exact path inside an existing directory', async (t) => {
    const root = fixture(t);
    const manager = createMutationLockManager();
    const lockPath = path.join(root, 'ploinky-source.lock');
    const lock = await manager.acquireAt(lockPath, 'ploinky-box-source-0123456789ab');
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    assert.equal(owner.label, 'ploinky-box-source-0123456789ab');
    assert.equal(owner.instance, null);
    assert.equal(owner.workspaceRoot, null);
    lock.assertHeld('ploinky-box-source-0123456789ab');
    assert.throws(() => lock.relinquishDeleted(), { code: 'PLOINKY_BOX_LOCK_WORKSPACE_REQUIRED' });
    lock.release();
    assert.equal(fs.existsSync(lockPath), false);
    await assert.rejects(() => manager.acquireAt(path.join(root, 'missing', 'x.lock'), 'label'), /parent directory is missing/);
    await assert.rejects(() => manager.acquireAt('relative.lock', 'label'), /must be absolute/);
    await assert.rejects(() => manager.acquireAt(lockPath, 'Bad Label'), /Invalid lock label/);
});

test('lock before anchor: the identity hand-off releases the provisional lock and anchors only under the final one', async (t) => {
    const root = fixture(t);
    const parent = path.join(root, 'parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    const provisional = buildWorkspaceIdentity(child);
    const resolved = buildWorkspaceIdentity(parent);
    const manager = createMutationLockManager();
    const events = [];
    let resolutions = 0;
    const result = await withWorkspaceMutationLock({
        resolveIdentity() {
            resolutions += 1;
            return resolutions === 1 ? provisional : resolved;
        },
        lockManager: {
            async acquire(instance, options) {
                events.push(`acquire:${instance}:${options.workspaceRoot}`);
                assert.equal(fs.existsSync(path.join(options.workspaceRoot, '.ploinky')), false, 'no anchor before the lock');
                return manager.acquire(instance, options);
            },
        },
        beforeLock(identity) {
            events.push(`beforeLock:${identity.instance}`);
            assert.equal(fs.existsSync(path.join(identity.workspaceRoot, '.ploinky-host')), false, 'beforeLock runs before any write');
        },
        beforeAnchor(identity, lock) {
            lock.assertHeld(identity.instance);
            assert.equal(fs.existsSync(lockPathOf(child)), false, 'the provisional lock was released');
            assert.equal(fs.existsSync(path.join(parent, '.ploinky')), false, 'the anchor follows beforeAnchor');
            events.push('beforeAnchor');
        },
        execute(identity, lock) {
            lock.assertHeld(identity.instance);
            assert.equal(fs.statSync(path.join(parent, '.ploinky')).isDirectory(), true);
            assert.equal(ownerOf(parent).instance, resolved.instance);
            events.push(`execute:${identity.instance}`);
            return 'done';
        },
    });
    assert.equal(result, 'done');
    assert.deepEqual(events, [
        `beforeLock:${provisional.instance}`,
        `acquire:${provisional.instance}:${child}`,
        `beforeLock:${resolved.instance}`,
        `acquire:${resolved.instance}:${parent}`,
        'beforeAnchor',
        `execute:${resolved.instance}`,
    ]);
    assert.equal(fs.existsSync(lockPathOf(parent)), false, 'the final lock was released');
});

test('a refused workspace is never written: beforeLock runs before the skeleton exists', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    const error = await withWorkspaceMutationLock({
        resolveIdentity: () => identity,
        lockManager: createMutationLockManager(),
        beforeLock() { throw Object.assign(new Error('unmountable'), { code: 'PLOINKY_BOX_WORKSPACE_ROOT_INVALID' }); },
        execute() { throw new Error('must not run'); },
    }).then(() => null, (failure) => failure);
    assert.equal(error?.code, 'PLOINKY_BOX_WORKSPACE_ROOT_INVALID');
    assert.equal(error.workspaceTransactionStarted, false);
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky-host')), false);
});

test('release refuses while the lock still holds residue and keeps the owner for recovery', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: workspace });
    const receipt = path.join(lock.path, 'candidate-0123456789abcdef.cid');
    fs.writeFileSync(receipt, 'f'.repeat(64));
    assert.throws(() => lock.release(), (error) => error.lockResidue === true
        && error.residue.includes('candidate-0123456789abcdef.cid'));
    assert.equal(ownerOf(workspace).pid, process.pid, 'the owner record stays');
    lock.assertHeld(identity.instance);
    fs.unlinkSync(receipt);
    lock.release();
    assert.equal(fs.existsSync(lock.path), false);
});

test('a held lock whose owner record was rewritten in place is no longer held', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: workspace });
    const ownerPath = path.join(lock.path, 'owner.json');
    const rewritten = { ...ownerOf(workspace), startedAt: new Date(1).toISOString() };
    fs.writeFileSync(ownerPath, `${JSON.stringify(rewritten)}\n`);
    assert.throws(() => lock.assertHeld(identity.instance), { code: 'PLOINKY_BOX_LOCK_RELOCATED' });
    assert.throws(() => lock.release(), { code: 'PLOINKY_BOX_LOCK_RELOCATED' });
    assert.equal(fs.existsSync(ownerPath), true, 'a lock it no longer owns is not removed');
});

test('a reclaim that observed one owner record never removes a lock whose record has changed', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    fs.mkdirSync(path.join(workspace, '.ploinky-host'), { mode: 0o700 });
    const lockPath = plantLock(workspace, v2Owner({ pid: 999999 }));
    const guards = [];
    const rewriting = {
        ...fs,
        mkdirSync(target, options) {
            if (String(target).endsWith('workspace.lock.reclaim')) {
                guards.push(target);
                // Between the observation and the reclaim, the record in the
                // same directory changes (still a dead owner).
                if (guards.length === 1) fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify(v2Owner({ pid: 999998 }))}\n`);
            }
            return fs.mkdirSync(target, options);
        },
    };
    const manager = createMutationLockManager({ fsApi: rewriting, liveness: fakeLiveness({ dead: [999999, 999998] }), retryMs: 1, timeoutMs: 1000 });
    const lock = await manager.acquire(identity.instance, { workspaceRoot: workspace });
    assert.equal(guards.length, 2, 'the first reclaim aborted on the changed record; a second one re-observed it');
    lock.release();
});

// A child process that crashes (exits without cleanup) at one point of the
// lock protocol, through an fsApi that ends the process there.
function crashScript({ workspaceRoot, instance, point }) {
    return `
        import fs from 'node:fs';
        const { createMutationLockManager } = await import(${JSON.stringify(locksModuleUrl)});
        const point = ${JSON.stringify(point)};
        const crash = () => process.exit(0);
        const fsApi = {
            ...fs,
            openSync(target, ...rest) {
                if (point === 'staged-empty' && String(target).includes('.staging-')) crash();
                return fs.openSync(target, ...rest);
            },
            renameSync(from, to) {
                if (point === 'staged-owner' && String(from).includes('.staging-')) crash();
                const result = fs.renameSync(from, to);
                if (point === 'retired' && String(to).includes('.released-')) crash();
                return result;
            },
            unlinkSync(target) {
                const result = fs.unlinkSync(target);
                if (point === 'retired-empty' && String(target).includes('.released-')) crash();
                return result;
            },
        };
        const lock = await createMutationLockManager({ fsApi }).acquire(${JSON.stringify(instance)}, { workspaceRoot: ${JSON.stringify(workspaceRoot)} });
        if (point === 'held') crash();
        lock.release();
        process.exit(3);
    `;
}

test('a crash at any point of the lock protocol never leaves a lock that cannot be taken', async (t) => {
    const root = fixture(t);
    for (const point of ['staged-empty', 'staged-owner', 'held', 'retired', 'retired-empty']) {
        const { workspace, identity } = workspaceIn(root, point);
        const run = await runNode(crashScript({ workspaceRoot: workspace, instance: identity.instance, point }));
        assert.equal(run.code, 0, `${point}: ${run.stderr}`);
        const locks = path.join(workspace, '.ploinky-host', 'locks');
        const left = fs.readdirSync(locks);
        const lockPath = lockPathOf(workspace);
        if (point === 'held') {
            assert.deepEqual(left, ['workspace.lock']);
        } else {
            assert.equal(fs.existsSync(lockPath), false, `${point}: no lock is visible`);
            assert.equal(left.length, 1, `${point}: one debris directory: ${left}`);
            assert.match(left[0], point.startsWith('staged') ? /^workspace\.lock\.staging-/ : /^workspace\.lock\.released-/);
        }
        // This process started before the debris existed, so an empty staging
        // directory stays inert for it; everything else is removed or reclaimed.
        const lock = await createMutationLockManager({ timeoutMs: 2000 }).acquire(identity.instance, { workspaceRoot: workspace });
        lock.release();
        const after = fs.readdirSync(locks);
        assert.deepEqual(after, point === 'staged-empty' ? left : [], `${point}: ${after}`);
        if (point === 'staged-empty') {
            // A process that starts after the debris was left removes it.
            const later = await runNode(holderScript({ workspaceRoot: workspace, instance: identity.instance, holdMs: 0, events: path.join(root, `${point}.log`), who: 'later' }));
            assert.equal(later.code, 0, later.stderr);
            assert.deepEqual(fs.readdirSync(locks), []);
        }
    }
});

test('crash debris whose owner is live or undetermined, or that holds anything else, stays inert', async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    fs.mkdirSync(path.join(workspace, '.ploinky-host', 'locks'), { recursive: true, mode: 0o700 });
    const locks = path.join(workspace, '.ploinky-host', 'locks');
    const plant = (name, owner, extra) => {
        const directory = path.join(locks, name);
        fs.mkdirSync(directory, { mode: 0o700 });
        if (owner) fs.writeFileSync(path.join(directory, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
        if (extra) fs.writeFileSync(path.join(directory, extra), 'x');
        return name;
    };
    const kept = [
        plant('workspace.lock.staging-live', v2Owner({ pid: 111 })),
        plant('workspace.lock.released-foreign', v2Owner({ pid: 123 })),
        plant('workspace.lock.released-extra', v2Owner({ pid: 999999 }), 'candidate-0123456789abcdef.cid'),
        plant('workspace.lock.staging-v1', { hostname: 'h', pid: 999999, instance: identity.instance, startedAt: 'x' }),
    ];
    const removed = plant('workspace.lock.released-dead', v2Owner({ pid: 999999 }));
    const manager = createMutationLockManager({ liveness: fakeLiveness({ dead: [999999], undetermined: [123] }) });
    const lock = await manager.acquire(identity.instance, { workspaceRoot: workspace });
    lock.release();
    const left = fs.readdirSync(locks).sort();
    assert.deepEqual(left, [...kept].sort());
    assert.equal(left.includes(removed), false);
});
