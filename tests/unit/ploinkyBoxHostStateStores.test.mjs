import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    clearAgentLimits,
    guardHostPath,
    hardwareStorePaths,
    initializeStore,
    readBarrier,
    readStoreSnapshot,
    recoverAuditOutbox,
    setAgentLimits,
} from '../../cli/sandbox/hardwareLimits/store.mjs';
import { acquireStoreLock, readStoreLockOwner, recoverStaleStoreLock } from '../../cli/sandbox/hardwareLimits/storeLock.mjs';
import { createGpuGrantStore, gpuGenerationDirectory, gpuGrantDirectory } from '../../ploinky-box/gpuGrant.mjs';
import {
    createHardwareGateStore,
    hardwareGenerationDirectory,
    runLimitsClear,
} from '../../ploinky-box/hardwareLimitsGate.mjs';
import { createTransitionStore } from '../../ploinky-box/hardwareLimitsTransition.mjs';
import { HOST_STATE_KNOWN_NAMES, HOST_STATE_UPDATE_KINDS } from '../../ploinky-box/hostState/root.mjs';
import { createHostStaging } from '../../ploinky-box/hostState/staging.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { parseLockOwner } from '../../ploinky-box/lockFiles.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { createRouterBindingStore } from '../../ploinky-box/routerBinding.mjs';
import { refreshDeferredHostExclusions } from '../../ploinky-box/update/hostExclusions.mjs';
import {
    UPDATE_STATE_KINDS,
    createMemoryUpdateHostState,
    createUpdateHostState,
} from '../../ploinky-box/update/hostState.mjs';

const ACTOR = { id: 'admin', name: 'Admin' };
const INSTALLED = new Set(['demo/agent']);
const ENVELOPE = Object.freeze({ cpus: 8, memoryBytes: 16 * 1024 ** 3 });
const CAPABILITIES = Object.freeze({ gate: 'on', controllers: ['cpu', 'memory', 'pids'] });
const FINGERPRINT = 'a'.repeat(64);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// A real workspace directory; every store path is derived from its identity.
function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-stores-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    return { root, workspace, identity, lock, state: identity.hostStateRoot };
}

// An isolated HOME so that a store which fell back to the home directory would be caught.
function isolatedHome(t, root) {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const saved = process.env.HOME;
    process.env.HOME = home;
    t.after(() => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; });
    assert.equal(os.homedir(), home);
    return home;
}

function initialized(t) {
    const context = fixture(t);
    const paths = hardwareStorePaths({ identity: context.identity });
    const snapshot = initializeStore({ paths, identity: context.identity });
    return { ...context, paths, token: snapshot.token };
}

function setLimits(context, token, limits = { cpus: 2 }, extra = {}) {
    return setAgentLimits({
        paths: context.paths, identity: context.identity, expectedToken: token, agentRef: 'demo/agent', limits, actor: ACTOR,
        installedRefs: INSTALLED, capabilities: CAPABILITIES, envelope: ENVELOPE, ...extra,
    });
}

const mode = (target) => fs.statSync(target).mode & 0o777;

// ---------------------------------------------------------------------------
// Layout: every store lives under <workspace>/.ploinky-box

test('every host store is rooted at identity.hostStateRoot with its per-instance file names', (t) => {
    const { identity, lock, state, workspace } = fixture(t);
    assert.equal(state, path.join(workspace, '.ploinky-box'));
    const { instance } = identity;

    const router = createRouterBindingStore();
    router.write(identity, { address: '127.0.0.1', hostPort: 8083 }, lock);
    assert.equal(router.pathFor(identity), path.join(state, 'router-bindings', `${instance}.json`));
    assert.ok(fs.statSync(router.pathFor(identity)).isFile());

    const gpu = createGpuGrantStore();
    gpu.write(identity, { vendor: 'nvidia', agents: ['demo/agent'] }, lock);
    assert.equal(gpu.pathFor(identity), path.join(state, 'gpu-grants', `${instance}.json`));
    assert.equal(gpuGrantDirectory(identity), path.join(state, 'gpu-grants'));
    assert.equal(gpuGenerationDirectory(identity, FINGERPRINT), path.join(state, 'gpu-grants', instance, FINGERPRINT));
    assert.ok(fs.statSync(gpu.pathFor(identity)).isFile());

    const gate = createHardwareGateStore();
    gate.write(identity, true, lock);
    assert.equal(gate.recordPath(identity), path.join(state, 'hardware-limits', `${instance}.json`));
    assert.ok(fs.statSync(gate.recordPath(identity)).isFile());
    assert.equal(hardwareGenerationDirectory(identity, FINGERPRINT), path.join(state, 'hardware-limits', instance, FINGERPRINT));
    const paths = hardwareStorePaths({ identity });
    assert.equal(paths.storeRoot, path.join(state, 'hardware-limits', instance, 'store'));
    initializeStore({ paths, identity });
    assert.equal(mode(paths.storeRoot), 0o700);
    assert.equal(createTransitionStore({ identity }).directory, path.join(state, 'hardware-limits', instance, 'transitions'));

    const update = createUpdateHostState({ identity });
    assert.equal(update.root, state);
    for (const kind of UPDATE_STATE_KINDS) {
        update.write(kind, instance, { kind });
        assert.ok(fs.statSync(path.join(state, kind, `${instance}.json`)).isFile(), kind);
        assert.equal(mode(path.join(state, kind)), 0o700, kind);
    }

    // The Step 2 skeleton underlies every store, and nothing else is created.
    for (const [name, expected] of [['locks', 0o700], ['quarantine', 0o700], ['empty', 0o555]]) {
        assert.equal(mode(path.join(state, name)), expected, name);
    }
    assert.deepEqual(fs.readdirSync(path.join(state, 'empty')), []);
    assert.deepEqual(fs.readdirSync(state).sort(), [
        'empty', 'gpu-grants', 'hardware-limits', 'locks', 'quarantine', 'router-bindings', ...UPDATE_STATE_KINDS,
    ].sort());
    // A hygiene scan of the directory must recognise every name the stores create.
    for (const name of fs.readdirSync(state)) assert.ok(HOST_STATE_KNOWN_NAMES.includes(name), `${name} is a known host-state name`);
    assert.deepEqual([...UPDATE_STATE_KINDS], [...HOST_STATE_UPDATE_KINDS]);
});

test('default-constructed stores never read or create anything in the home directory', async (t) => {
    const context = fixture(t);
    const home = isolatedHome(t, context.root);
    const { identity, lock } = context;
    createRouterBindingStore().write(identity, { address: '127.0.0.1', hostPort: 8083 }, lock);
    createGpuGrantStore().write(identity, { vendor: 'nvidia', agents: ['demo/agent'] }, lock);
    createHardwareGateStore().write(identity, true, lock);
    const paths = hardwareStorePaths({ identity });
    initializeStore({ paths, identity });
    createTransitionStore({ identity }).receiptPath('b'.repeat(32));
    createUpdateHostState({ identity }).write('update-pending', identity.instance, { ok: true });
    const manager = createMutationLockManager();
    const held = await manager.acquire(identity.instance, { workspaceRoot: identity.workspaceRoot });
    held.release();
    assert.deepEqual(fs.readdirSync(home), [], 'nothing is created under the home directory');
    assert.equal(fs.existsSync(path.join(home, '.ploinky-box')), false);
    // The lock manager keeps no state root, so the update store cannot be selected from it.
    assert.equal('stateRoot' in manager, false);
});

test('stores are built from the exact identity and refuse a hand-built or redirected root', (t) => {
    const { identity, lock, root } = fixture(t);
    const redirected = { ...identity, hostStateRoot: path.join(root, 'elsewhere', '.ploinky-box') };
    const missing = { ...identity };
    delete missing.hostStateRoot;
    for (const bad of [redirected, missing, { ...identity, hostStateRoot: path.join(identity.workspaceRoot, '.ploinky-state') }]) {
        assert.throws(() => createRouterBindingStore().write(bad, { address: '127.0.0.1', hostPort: 8083 }, lock), /exact workspace identity/);
        assert.throws(() => createGpuGrantStore().write(bad, { vendor: 'nvidia', agents: ['demo/agent'] }, lock), /exact workspace identity/);
        assert.throws(() => createHardwareGateStore().write(bad, true, lock), /exact workspace identity/);
        assert.throws(() => hardwareStorePaths({ identity: bad }), (error) => error.code === 'identity_changed');
        assert.throws(() => createTransitionStore({ identity: bad }), (error) => error.code === 'identity_changed');
        assert.throws(() => createUpdateHostState({ identity: bad }), /exact workspace identity/);
    }
    assert.equal(fs.existsSync(path.join(root, 'elsewhere')), false);
    assert.equal(fs.existsSync(identity.hostStateRoot), false, 'a refused identity creates nothing');
});

test('store directories are created one level at a time under the skeleton, never recursively', (t) => {
    const { root, identity, lock } = fixture(t);
    // The workspace is gone: no store may re-create it (or anything above `.ploinky-box`).
    fs.rmSync(identity.workspaceRoot, { recursive: true });
    const before = fs.readdirSync(root);
    const refused = (fn) => assert.throws(fn, (error) => error.code === 'PLOINKY_BOX_WORKSPACE_ABSENT');
    refused(() => createRouterBindingStore().write(identity, { address: '127.0.0.1', hostPort: 8083 }, lock));
    refused(() => createGpuGrantStore().write(identity, { vendor: 'nvidia', agents: ['demo/agent'] }, lock));
    refused(() => createHardwareGateStore().write(identity, true, lock));
    refused(() => initializeStore({ paths: hardwareStorePaths({ identity }), identity }));
    refused(() => createUpdateHostState({ identity }).write('update-pending', identity.instance, {}));
    refused(() => createHostStaging(identity));
    assert.deepEqual(fs.readdirSync(root), before);
    assert.equal(fs.existsSync(identity.workspaceRoot), false);
});

test('a tampered skeleton component is reported through the store, not silently repaired', (t) => {
    const { identity, lock, root } = fixture(t);
    fs.mkdirSync(path.join(root, 'outside'), { mode: 0o700 });
    fs.symlinkSync(path.join(root, 'outside'), identity.hostStateRoot);
    assert.throws(
        () => createRouterBindingStore().write(identity, { address: '127.0.0.1', hostPort: 8083 }, lock),
        (error) => error.code === 'PLOINKY_BOX_ROUTER_BINDING_STATE_INVALID',
    );
    assert.deepEqual(fs.readdirSync(path.join(root, 'outside')), []);
});

// ---------------------------------------------------------------------------
// D1 store write rules: the Box writes hardware-limits/<inst>/store, the host
// must never follow a link planted there.

test('N20: a symlink planted in the hardware store is never followed by a host read or write', (t) => {
    const context = initialized(t);
    const { paths, identity, lock } = context;
    const outside = path.join(context.root, 'outside-sentinel.json');
    const valid = fs.readFileSync(paths.policyPath);
    // The target holds a perfectly valid policy document: a followed link would read as `valid`.
    fs.writeFileSync(outside, valid, { mode: 0o600 });
    const sentinel = sha256(outside);
    const passwd = fs.existsSync('/etc/passwd') ? sha256('/etc/passwd') : null;

    for (const [name, target] of [['limits.json', outside], ['identity.json', outside], ['limits.json', '/etc/passwd']]) {
        if (target === '/etc/passwd' && passwd === null) continue;
        const link = path.join(paths.storeRoot, name);
        const original = fs.readFileSync(link);
        fs.rmSync(link);
        fs.symlinkSync(target, link);
        assert.equal(fs.realpathSync(link), fs.realpathSync(target), 'the link resolves to its target');
        const snapshot = readStoreSnapshot({ paths, identity });
        assert.equal(snapshot.status, 'unreadable', `${name} -> ${target}`);
        assert.match(snapshot.diagnostic, /symlinked component/);
        assert.throws(() => setLimits(context, context.token), (error) => error.code === 'store_unreadable');
        assert.throws(() => runLimitsClear({ identity, lock, all: true }), (error) => error.code === 'store_unreadable');
        assert.throws(() => runLimitsClear({ identity, lock, agentRef: 'demo/agent' }), /cannot be read safely/);
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link was left in place for inspection');
        assert.equal(sha256(outside), sentinel, 'the target is unchanged');
        if (passwd) assert.equal(sha256('/etc/passwd'), passwd);
        fs.rmSync(link);
        fs.writeFileSync(link, original, { mode: 0o600 });
    }
    assert.equal(readStoreSnapshot({ paths, identity }).status, 'valid', 'the fixture is healthy again once the links are gone');
});

test('N20: O_NOFOLLOW still refuses a link swapped in after the path walk', (t) => {
    const context = initialized(t);
    const { paths, identity } = context;
    const outside = path.join(context.root, 'outside-sentinel.json');
    fs.copyFileSync(paths.policyPath, outside);
    fs.chmodSync(outside, 0o600);
    const link = paths.policyPath;
    fs.rmSync(link);
    fs.symlinkSync(outside, link);
    // The walk sees a regular file (the swap happens after it); only the open can refuse.
    const racing = new Proxy(fs, {
        get(target, property) {
            if (property === 'lstatSync') {
                return (file, ...rest) => (String(file) === link ? fs.statSync(file, ...rest) : fs.lstatSync(file, ...rest));
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    assert.equal(guardHostPath(racing, paths, link), link, 'the walk is fooled');
    const snapshot = readStoreSnapshot({ paths, identity, fsApi: racing });
    assert.equal(snapshot.status, 'unreadable');
    assert.match(snapshot.diagnostic, /limits\.json is not a readable regular file \(ELOOP\)/);
});

test('N20: audit.log, transition.json and the store lock owner are never followed either', (t) => {
    const context = initialized(t);
    const { paths, identity } = context;
    const outside = path.join(context.root, 'outside-sentinel.log');
    fs.writeFileSync(outside, 'host file\n', { mode: 0o600 });
    const sentinel = sha256(outside);

    // audit.log: a committed policy change must not append through the link.
    fs.symlinkSync(outside, paths.auditPath);
    assert.throws(() => setLimits(context, context.token), (error) => error.code === 'audit_pending' && error.committed === true);
    assert.equal(sha256(outside), sentinel, 'no audit line was appended to the target');
    fs.rmSync(paths.auditPath);

    // transition.json: a linked barrier is malformed, which blocks writes, and is never read through.
    const policy = path.join(context.root, 'barrier-target.json');
    fs.writeFileSync(policy, '{"schema":"x"}\n', { mode: 0o600 });
    fs.symlinkSync(policy, paths.barrierPath);
    assert.throws(() => setLimits(context, readStoreSnapshot({ paths, identity }).token, { cpus: 3 }), (error) => error.code === 'hardware_limits_transition');
    assert.equal(readBarrier({ paths }).malformed, true, 'a linked barrier reads as malformed, never as its target');
    fs.rmSync(paths.barrierPath);

    // write.lock is a single file holding the owner record: a link, a hard link and a directory in its place
    // all read as malformed, never as the JSON they lead to.
    const lockFile = path.join(paths.storeRoot, 'write.lock');
    const ownerTarget = path.join(context.root, 'owner-target.json');
    fs.writeFileSync(ownerTarget, `${JSON.stringify({ token: 'a'.repeat(32), pid: 1, hostname: 'h', domain: 'host', operation: 'x' })}\n`, { mode: 0o600 });
    fs.symlinkSync(ownerTarget, lockFile);
    assert.equal(readStoreLockOwner(paths.storeRoot).malformed, true, 'a linked lock reads as malformed');
    assert.match(readStoreLockOwner(paths.storeRoot).reason, /not a single regular file/);
    fs.rmSync(lockFile);
    // A hard link shares the target's inode, so its valid stamp must not be accepted as this lock's owner.
    fs.linkSync(ownerTarget, lockFile);
    assert.equal(readStoreLockOwner(paths.storeRoot).malformed, true, 'a hard-linked lock reads as malformed');
    assert.match(readStoreLockOwner(paths.storeRoot).reason, /not a single regular file/);
    fs.rmSync(lockFile);
    fs.mkdirSync(lockFile, { mode: 0o700 });
    assert.equal(readStoreLockOwner(paths.storeRoot).malformed, true, 'a directory is not a lock');
    fs.rmdirSync(lockFile);
    assert.equal(readStoreLockOwner(paths.storeRoot), null, 'an absent lock reads as null');
});

test('N20: the audit duplicate check opens audit.log without following a link swapped in after the path walk', (t) => {
    const context = initialized(t);
    const { paths } = context;
    const transactionId = 'f'.repeat(32);
    // The target already carries the pending transaction, so a read through the link would count the event as flushed.
    const outside = path.join(context.root, 'outside-audit.log');
    fs.writeFileSync(outside, `${JSON.stringify({ transactionId })}\n`, { mode: 0o600 });
    const sentinel = sha256(outside);
    fs.symlinkSync(outside, paths.auditPath);
    const policyBefore = sha256(paths.policyPath);
    // The walk and the lstat check see a regular file; only the open can refuse.
    const racing = new Proxy(fs, {
        get(target, property) {
            if (property === 'lstatSync') {
                return (file, ...rest) => (String(file) === paths.auditPath ? fs.statSync(file, ...rest) : fs.lstatSync(file, ...rest));
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const document = JSON.parse(fs.readFileSync(paths.policyPath, 'utf8'));
    const result = recoverAuditOutbox({
        paths, snapshot: { document: { ...document, auditOutbox: { transactionId } } }, fsApi: racing,
    });
    assert.equal(result.auditPending, true, 'the linked audit.log is refused, so the outbox stays pending');
    assert.equal(result.error?.code, 'ELOOP');
    assert.equal(sha256(outside), sentinel);
    assert.equal(sha256(paths.policyPath), policyBefore, 'the policy was not rewritten as if the audit were flushed');
});

test('N20b: a link toward a sibling host record, or a hard link to it, is neither followed nor written through', (t) => {
    const context = initialized(t);
    const { paths, identity, lock } = context;
    createRouterBindingStore().write(identity, { address: '127.0.0.1', hostPort: 8083 }, lock);
    const binding = createRouterBindingStore().pathFor(identity);
    const bindingHash = sha256(binding);
    const bindingBytes = fs.readFileSync(binding);

    // The Box-side spelling of the plan: from <store>, three levels up is `.ploinky-box`.
    const relative = `../../../router-bindings/${identity.instance}.json`;
    const link = path.join(paths.storeRoot, 'limits.json');
    const originalPolicy = fs.readFileSync(link);
    fs.rmSync(link);
    fs.symlinkSync(relative, link);
    assert.equal(fs.realpathSync(link), fs.realpathSync(binding), 'the relative link really resolves to the binding');

    for (const attempt of [
        () => runLimitsClear({ identity, lock, all: true }),
        () => runLimitsClear({ identity, lock, agentRef: 'demo/agent' }),
        () => setLimits(context, context.token),
        () => clearAgentLimits({ paths, identity, agentRef: 'demo/agent', actor: ACTOR }),
    ]) {
        assert.throws(attempt, (error) => ['store_unreadable', 'PLOINKY_BOX_HARDWARE_STATE_INVALID'].includes(error.code));
        assert.equal(sha256(binding), bindingHash, 'the router binding is byte-identical');
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the symlink is refused, never replaced through');
    }
    assert.equal(readStoreSnapshot({ paths, identity }).status, 'unreadable');

    // A hard link shares the inode, so a write through it would change the binding.
    fs.rmSync(link);
    fs.linkSync(binding, link);
    assert.equal(fs.statSync(link).ino, fs.statSync(binding).ino);
    assert.equal(readStoreSnapshot({ paths, identity }).status, 'unreadable');
    assert.match(readStoreSnapshot({ paths, identity }).diagnostic, /links/);
    for (const attempt of [
        () => runLimitsClear({ identity, lock, all: true }),
        () => setLimits(context, context.token),
    ]) {
        assert.throws(attempt, (error) => error.code === 'store_unreadable');
        assert.deepEqual(fs.readFileSync(binding), bindingBytes, 'the binding bytes did not change');
    }
    assert.equal(sha256(binding), bindingHash);

    fs.rmSync(link);
    fs.writeFileSync(link, originalPolicy, { mode: 0o600 });
    assert.equal(readStoreSnapshot({ paths, identity }).status, 'valid');
});

test('N20b: a hard-linked but otherwise valid policy is refused only because of its link count', (t) => {
    const context = initialized(t);
    const { paths, identity } = context;
    const link = paths.policyPath;
    const copy = path.join(context.root, 'policy-copy.json');
    fs.copyFileSync(link, copy);
    fs.chmodSync(copy, 0o600);
    fs.rmSync(link);
    fs.linkSync(copy, link);
    assert.equal(fs.statSync(link).nlink, 2);
    const snapshot = readStoreSnapshot({ paths, identity });
    assert.equal(snapshot.status, 'unreadable', 'the content is a valid policy, so only the link count can refuse it');
    assert.match(snapshot.diagnostic, /links/);
});

// ---------------------------------------------------------------------------
// The store lock under an in-Box adversary. The Box writes `store/`, so write.lock can be replaced at any
// instant. Every host operation on it is one component below `store/` and never follows a link, so whatever
// the swap points at, nothing outside `store/` may change.

// A digest of everything under `root` except `skip`: paths, types, link targets and file contents.
function treeDigest(root, skip) {
    const lines = [];
    const walk = (directory) => {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name);
            if (target === skip) continue;
            const relative = path.relative(root, target);
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink()) lines.push(`${relative} L ${fs.readlinkSync(target)}`);
            else if (stat.isDirectory()) { lines.push(`${relative} D`); walk(target); }
            else lines.push(`${relative} F ${sha256(target)}`);
        }
    };
    walk(root);
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

// The workspace lock (D4) stand-in the store lock must never be steered into.
function d4Sentinel(context) {
    const d4 = path.join(context.state, 'locks', 'workspace.lock');
    fs.mkdirSync(d4, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(d4, 'owner.json'), '{"schema":"ploinky-lock"}\n', { mode: 0o600 });
    return { d4, owner: path.join(d4, 'owner.json') };
}

// What an in-Box writer can put at write.lock: a link to the D4 directory, a link to its owner record, or a hard link to it.
const SWAP_KINDS = {
    'symlink to the D4 lock directory': (lock) => fs.symlinkSync('../../../locks/workspace.lock', lock),
    'symlink to the D4 owner record': (lock) => fs.symlinkSync('../../../locks/workspace.lock/owner.json', lock),
    'hard link to the D4 owner record': (lock, d4) => fs.linkSync(d4.owner, lock),
    // A new inode that carries the very same owner record: only the identity comparison can tell it from the lock.
    'regular copy of the owner record': (lock) => {
        if (fs.existsSync(`${lock}.moved`)) fs.copyFileSync(`${lock}.moved`, lock);
        else fs.writeFileSync(lock, '{"token":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}\n', { mode: 0o600 });
    },
};
const LINK_KINDS = new Set(['symlink to the D4 lock directory', 'symlink to the D4 owner record', 'hard link to the D4 owner record']);

// An fsApi that performs the swap just before the first matching call. The instant is named by what the lock code does:
//   before-create    the call that creates write.lock
//   before-write     the first write of the owner record after creation
//   after-read       the first call on write.lock after release has read the owner record
//   before-unlink    the call that removes write.lock at release
//   before-rename    the call that quarantines a stale write.lock
function racingFsFor(point, lockFile, swap) {
    const state = { swapped: false, armed: false, read: false };
    const O_CREAT = fs.constants.O_CREAT;
    const touches = (value) => typeof value === 'string' && (value === lockFile || value.startsWith(`${lockFile}${path.sep}`));
    const due = (method, args) => {
        switch (point) {
            case 'before-create': return state.armed && ((method === 'openSync' && args[0] === lockFile && (args[1] & O_CREAT)) || (method === 'mkdirSync' && args[0] === lockFile));
            case 'before-write': return state.armed && ((method === 'writeFileSync' && typeof args[0] === 'number')
                || (method === 'openSync' && touches(args[0]) && args[0] !== lockFile && (args[1] & O_CREAT)));
            case 'after-read': return state.armed && state.read && ['lstatSync', 'unlinkSync', 'renameSync', 'rmdirSync'].includes(method) && touches(args[0]);
            case 'before-unlink': return state.armed && method === 'unlinkSync' && touches(args[0]);
            case 'before-rename': return state.armed && method === 'renameSync' && args[0] === lockFile;
            default: throw new Error(point);
        }
    };
    const api = { ...fs, constants: fs.constants };
    for (const method of ['openSync', 'mkdirSync', 'writeFileSync', 'lstatSync', 'unlinkSync', 'renameSync', 'rmdirSync']) {
        api[method] = (...args) => {
            if (!state.swapped && due(method, args)) {
                state.swapped = true;
                // The adversary moves the real entry aside (when there is one) and leaves its link in the lock's place.
                if (fs.existsSync(lockFile) || fs.lstatSync(lockFile, { throwIfNoEntry: false })) fs.renameSync(lockFile, `${lockFile}.moved`);
                swap();
            }
            const result = fs[method](...args);
            if (method === 'openSync' && touches(args[0]) && ((args[1] & fs.constants.O_ACCMODE) === fs.constants.O_RDONLY)) state.read = true;
            return result;
        };
    }
    return { api, state };
}

function swapWorld(t, kind) {
    const context = initialized(t);
    const d4 = d4Sentinel(context);
    const lockFile = path.join(context.paths.storeRoot, 'write.lock');
    const before = treeDigest(context.root, context.paths.storeRoot);
    return {
        context, d4, lockFile, before,
        swap: () => SWAP_KINDS[kind](lockFile, d4),
        assertOutsideUntouched() {
            assert.equal(treeDigest(context.root, context.paths.storeRoot), before, 'nothing outside the store was created, changed or deleted');
            assert.equal(fs.readFileSync(d4.owner, 'utf8'), '{"schema":"ploinky-lock"}\n', 'the D4 owner record is intact');
        },
    };
}

const entryAt = (lockFile) => fs.lstatSync(lockFile, { throwIfNoEntry: false }) ?? null;

for (const kind of Object.keys(SWAP_KINDS)) {
    test(`N20: write.lock swapped for a ${kind} never reaches outside the store: acquire`, (t) => {
        // Before creation: the link occupies the name, so the exclusive create is refused (busy).
        let world = swapWorld(t, kind);
        let race = racingFsFor('before-create', world.lockFile, world.swap);
        race.state.armed = true;
        assert.throws(() => acquireStoreLock({ storeRoot: world.context.paths.storeRoot, fsApi: race.api, deadlineMs: 30, sleep: () => {} }), (error) => error.code === 'store_busy');
        assert.equal(race.state.swapped, true, 'the swap really happened');
        assert.equal(entryAt(world.lockFile) !== null, true, 'the planted entry is left in place');
        world.assertOutsideUntouched();

        // Between creation and the owner write: the record goes to the created file, release then refuses the link.
        world = swapWorld(t, kind);
        race = racingFsFor('before-write', world.lockFile, world.swap);
        race.state.armed = true;
        let lock = null;
        let failure = null;
        try {
            lock = acquireStoreLock({ storeRoot: world.context.paths.storeRoot, fsApi: race.api });
            lock.release();
        } catch (error) { failure = error; }
        assert.equal(race.state.swapped, true, 'the swap really happened');
        assert.equal(failure?.code, 'store_busy', 'a replaced lock is refused, not used');
        assert.equal(entryAt(world.lockFile) !== null, true, 'the planted entry is left in place');
        world.assertOutsideUntouched();
    });

    test(`N20: write.lock swapped for a ${kind} never reaches outside the store: release`, (t) => {
        // Right at the start of release, after it read the record, and just before the unlink.
        for (const point of ['start', 'after-read', 'before-unlink']) {
            const world = swapWorld(t, kind);
            const race = racingFsFor(point === 'start' ? 'before-unlink' : point, world.lockFile, world.swap);
            const lock = acquireStoreLock({ storeRoot: world.context.paths.storeRoot, fsApi: race.api });
            if (point === 'start') { race.state.swapped = true; fs.renameSync(world.lockFile, `${world.lockFile}.moved`); world.swap(); }
            race.state.armed = true;
            let failure = null;
            try { lock.release(); } catch (error) { failure = error; }
            assert.equal(race.state.swapped, true, `${point}: the swap really happened`);
            if (point === 'before-unlink') {
                // unlink removes the entry itself, never what it points to.
                assert.equal(failure, null, `${point}: nothing was refused`);
                assert.equal(entryAt(world.lockFile), null, `${point}: only the planted entry was removed`);
            } else {
                assert.equal(failure?.code, 'store_busy', `${point}: the replaced lock is refused`);
                assert.equal(entryAt(world.lockFile) !== null, true, `${point}: the planted entry is left in place`);
            }
            world.assertOutsideUntouched();
        }
    });

    test(`N20: write.lock swapped for a ${kind} never reaches outside the store: stale recovery`, (t) => {
        const stale = (world) => {
            fs.writeFileSync(world.lockFile, `${JSON.stringify({
                token: 'd'.repeat(32), pid: 424242, hostname: os.hostname(), domain: 'host', operation: 'crashed-writer', acquiredAt: new Date().toISOString(),
            })}\n`, { mode: 0o600 });
            // Quarantine and recovery are decided under the host workspace lock, with the holder proven dead and the Box stopped.
            return (extra = {}) => recoverStaleStoreLock({
                storeRoot: world.context.paths.storeRoot, hostLock: world.context.lock, instance: world.context.identity.instance,
                inspectBox: () => ({ state: 'absent' }), kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }, ...extra,
            });
        };
        // Before recovery looks: the link is not a lock record at all, so recovery refuses and removes nothing.
        let world = swapWorld(t, kind);
        let recover = stale(world);
        if (LINK_KINDS.has(kind)) {
            fs.rmSync(world.lockFile);
            world.swap();
            assert.throws(() => recover(), (error) => error.code === 'store_busy');
            assert.equal(entryAt(world.lockFile) !== null, true);
            world.assertOutsideUntouched();
        }

        // After the holder was proven dead and before the quarantine rename: rename moves the link itself.
        world = swapWorld(t, kind);
        recover = stale(world);
        const race = racingFsFor('before-rename', world.lockFile, world.swap);
        race.state.armed = true;
        const result = recover({ fsApi: race.api });
        assert.equal(race.state.swapped, true, 'the swap really happened');
        assert.equal(result.recovered, true);
        assert.equal(entryAt(result.quarantine).isSymbolicLink() || entryAt(result.quarantine).isFile(), true, 'the planted entry itself was quarantined');
        assert.equal(entryAt(world.lockFile), null);
        world.assertOutsideUntouched();
    });
}

test('N20: an empty lock file and a directory at write.lock are malformed, block acquire and are never removed automatically', (t) => {
    for (const [label, plant] of [
        ['an empty file (created, owner record not written yet)', (lockFile) => fs.writeFileSync(lockFile, '', { mode: 0o600 })],
        ['a directory', (lockFile) => fs.mkdirSync(lockFile, { mode: 0o700 })],
    ]) {
        const context = initialized(t);
        const { paths } = context;
        const lockFile = path.join(paths.storeRoot, 'write.lock');
        plant(lockFile);
        const owner = readStoreLockOwner(paths.storeRoot);
        assert.equal(owner.malformed, true, label);
        assert.throws(() => acquireStoreLock({ storeRoot: paths.storeRoot, deadlineMs: 20, sleep: () => {} }), (error) => error.code === 'store_busy', label);
        // Even with the Box stopped, a holder that cannot be identified is never proof of death.
        assert.throws(() => recoverStaleStoreLock({
            storeRoot: paths.storeRoot, hostLock: context.lock, instance: context.identity.instance, inspectBox: () => ({ state: 'absent' }),
        }), (error) => error.code === 'store_busy' && /has no valid owner/.test(error.message), label);
        assert.equal(fs.lstatSync(lockFile).isDirectory(), label === 'a directory', `${label}: left in place`);
        assert.deepEqual(fs.readdirSync(paths.storeRoot).filter((name) => name.startsWith('write.lock.stale-')), [], `${label}: nothing quarantined`);
    }
});

test('N20: a store lock is one regular file, released by unlinking it, and leaves nothing behind', (t) => {
    const context = initialized(t);
    const { paths } = context;
    const lock = acquireStoreLock({ storeRoot: paths.storeRoot, operation: 'plain' });
    const lockFile = path.join(paths.storeRoot, 'write.lock');
    const stat = fs.lstatSync(lockFile);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(readStoreLockOwner(paths.storeRoot).owner.token, lock.token);
    // The exclusive create refuses a second holder instead of waiting forever.
    assert.throws(() => acquireStoreLock({ storeRoot: paths.storeRoot, deadlineMs: 20, sleep: () => {} }), (error) => error.code === 'store_busy');
    lock.release();
    assert.deepEqual(fs.readdirSync(paths.storeRoot).filter((name) => name.startsWith('write.lock')), []);
    // No host path inside the store has an intermediate component: only files sit directly below it.
    assert.equal(fs.readdirSync(paths.storeRoot).every((name) => !fs.lstatSync(path.join(paths.storeRoot, name)).isDirectory()), true);
});

test('a linked intermediate store component is refused even though the files behind it are regular', (t) => {
    const context = initialized(t);
    const { paths, identity, lock, state } = context;
    const instanceDirectory = path.dirname(paths.storeRoot);
    const hardwareDirectory = path.dirname(instanceDirectory);

    // The store lock is a directory made inside the store: it must never be made through a linked component.
    const lockDirectories = [];
    const realMkdir = fs.mkdirSync;
    t.mock.method(fs, 'mkdirSync', (target, ...rest) => {
        if (path.basename(String(target)) === 'write.lock') lockDirectories.push(String(target));
        return realMkdir.call(fs, target, ...rest);
    });
    // Each link points at a complete, healthy copy of what it replaces: only the walk can refuse it.
    for (const component of [instanceDirectory, hardwareDirectory, state]) {
        const copy = path.join(context.root, `copy-${path.basename(component)}`);
        fs.cpSync(component, copy, { recursive: true });
        const parked = `${component}.parked`;
        fs.renameSync(component, parked);
        fs.symlinkSync(copy, component);
        const copyHash = sha256(path.join(copy, ...path.relative(component, paths.policyPath).split(path.sep)));
        assert.equal(fs.lstatSync(paths.storeRoot).isDirectory(), true, 'the store directory itself looks like a real directory');
        assert.equal(readStoreSnapshot({ paths, identity }).status, 'unreadable', component);
        assert.throws(() => guardHostPath(fs, paths, paths.policyPath), (error) => error.code === 'store_unreadable' && /symlinked component/.test(error.message));
        assert.throws(() => setLimits(context, context.token), (error) => error.code === 'store_unreadable');
        // Replacing `.ploinky-box` itself is refused one layer earlier, by the confinement check.
        assert.throws(() => runLimitsClear({ identity, lock, all: true }), (error) => (
            component === state ? /does not resolve inside its workspace/.test(error.message) : error.code === 'store_unreadable'));
        assert.deepEqual(lockDirectories, [], 'no store lock was created behind the link');
        assert.equal(sha256(path.join(copy, ...path.relative(component, paths.policyPath).split(path.sep))), copyHash);
        fs.unlinkSync(component);
        fs.renameSync(parked, component);
    }
    assert.equal(readStoreSnapshot({ paths, identity }).status, 'valid');
    assert.equal(guardHostPath(fs, paths, paths.policyPath), paths.policyPath);
});

test('host writes into the Box-writable store use exclusive private temp files, no-follow reads and an atomic rename', (t) => {
    const context = initialized(t);
    const { paths } = context;
    const events = [];
    const fsApi = new Proxy(fs, {
        get(target, property) {
            if (property === 'openSync') {
                return (file, flags, ...rest) => {
                    events.push({ call: 'open', file: String(file), flags, mode: rest[0] });
                    return fs.openSync(file, flags, ...rest);
                };
            }
            if (property === 'renameSync') {
                return (from, to) => {
                    events.push({ call: 'rename', from: String(from), to: String(to) });
                    return fs.renameSync(from, to);
                };
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const { constants } = fs;
    setLimits(context, context.token, { cpus: 2 }, { fsApi });
    const temporary = events.find((event) => event.call === 'open' && path.basename(event.file).startsWith('.limits.json.') && event.file.endsWith('.tmp'));
    assert.ok(temporary, 'the policy is written through a temporary file in the store directory');
    assert.equal(path.dirname(temporary.file), paths.storeRoot);
    const required = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    assert.equal(temporary.flags & required, required, 'exclusive, no-follow creation');
    assert.equal(temporary.mode, 0o600);
    const rename = events.find((event) => event.call === 'rename' && event.from === temporary.file);
    assert.ok(rename, 'the temporary file is renamed over the target');
    assert.equal(rename.to, paths.policyPath);
    const reads = events.filter((event) => event.call === 'open' && event.file === paths.policyPath);
    assert.ok(reads.length > 0);
    for (const read of reads) assert.equal(read.flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW, 'store reads never follow a link');
    assert.equal(fs.readdirSync(paths.storeRoot).some((name) => name.endsWith('.tmp')), false, 'no temp file is left behind');
});

// ---------------------------------------------------------------------------
// Update records

test('the durable update store refuses a linked kind directory and records it only below the skeleton', (t) => {
    const { identity, root, state } = fixture(t);
    const store = createUpdateHostState({ identity });
    assert.equal(store.read('update-pending', identity.instance), null, 'reading creates nothing');
    assert.equal(fs.existsSync(state), false);
    store.write('update-pending', identity.instance, { ok: true });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.renameSync(path.join(state, 'update-pending'), path.join(root, 'moved'));
    fs.symlinkSync(outside, path.join(state, 'update-pending'));
    assert.throws(() => store.write('update-pending', identity.instance, { ok: false }), { code: 'PLOINKY_BOX_UPDATE_STATE_INVALID' });
    assert.throws(() => store.read('update-pending', identity.instance), { code: 'PLOINKY_BOX_UPDATE_STATE_INVALID' });
    assert.deepEqual(fs.readdirSync(outside), []);
    // The memory store (fixtures) is unaffected and touches no disk.
    const memory = createMemoryUpdateHostState();
    memory.write('update-pending', 'x', { ok: true });
    assert.deepEqual(memory.read('update-pending', 'x'), { ok: true });
});

// ---------------------------------------------------------------------------
// Host staging (inventory row 11)

test('host staging is a private directory under .ploinky-box/tmp with a D4 owner record, released exactly', (t) => {
    const { identity, state } = fixture(t);
    const staging = createHostStaging(identity);
    assert.equal(path.dirname(staging.root), path.join(state, 'tmp'));
    assert.match(path.basename(staging.root), /^[0-9a-f]{16}$/);
    assert.equal(mode(staging.root), 0o700);
    assert.equal(mode(path.join(state, 'tmp')), 0o700);
    const ownerFile = path.join(staging.root, 'owner.json');
    assert.equal(mode(ownerFile), 0o600);
    const owner = parseLockOwner(fs.readFileSync(ownerFile));
    assert.ok(owner, 'the record parses as a version-2 lock owner');
    assert.equal(owner.label, 'host-staging');
    assert.equal(owner.instance, identity.instance);
    assert.equal(owner.workspaceRoot, identity.workspaceRoot);
    assert.equal(owner.pid, process.pid);
    for (const key of ['machineId', 'bootId', 'pidNamespace', 'processStart']) assert.ok(owner[key] !== undefined, key);
    fs.writeFileSync(path.join(staging.root, 'scratch'), 'x');
    assert.equal(staging.release(), true);
    assert.equal(fs.existsSync(staging.root), false);
    assert.equal(fs.existsSync(path.join(state, 'tmp')), true, 'the tmp directory itself is kept');

    // A directory that is no longer the one that was created is left for the later liveness sweep.
    const replaced = createHostStaging(identity);
    fs.rmSync(replaced.root, { recursive: true });
    const other = path.join(state, 'tmp', 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'keep'), 'x');
    fs.symlinkSync(other, replaced.root);
    assert.equal(replaced.release(), false);
    assert.equal(fs.readFileSync(path.join(other, 'keep'), 'utf8'), 'x');

    // A different real directory under the same name is not ours either. The original is moved aside
    // (not deleted) so that the replacement cannot reuse its inode number.
    const swapped = createHostStaging(identity);
    const aside = `${swapped.root}.aside`;
    fs.renameSync(swapped.root, aside);
    fs.mkdirSync(swapped.root, { mode: 0o700 });
    fs.writeFileSync(path.join(swapped.root, 'keep'), 'y');
    assert.notEqual(fs.statSync(swapped.root).ino, fs.statSync(aside).ino);
    assert.equal(swapped.release(), false, 'a replaced real directory is refused');
    assert.equal(fs.readFileSync(path.join(swapped.root, 'keep'), 'utf8'), 'y', 'its contents were not removed');
    assert.equal(fs.existsSync(path.join(aside, 'owner.json')), true);
});

test('the host exclusions refresh stages in .ploinky-box/tmp and passes it down as an explicit stagingRoot', async (t) => {
    const { identity, workspace, state } = fixture(t);
    fs.mkdirSync(path.join(workspace, 'project'));
    const seen = [];
    const records = await refreshDeferredHostExclusions({
        folders: [`${workspace}/project`],
        identity,
        createPlanner: (options) => {
            seen.push({ planner: options.stagingRoot, exists: fs.existsSync(options.stagingRoot) });
            return { planner: true };
        },
        refresh: (folder, options) => {
            seen.push({ refresh: options.stagingRoot, planner: options.exclusions.planner, exists: fs.existsSync(options.stagingRoot) });
            return { exclusions: { status: 'unchanged' } };
        },
    });
    assert.deepEqual(records.map((record) => record.outcome), ['unchanged']);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].planner, seen[1].refresh, 'the planner and the refresh share one staging directory');
    assert.equal(path.dirname(seen[0].planner), path.join(state, 'tmp'));
    assert.equal(seen[0].exists && seen[1].exists, true);
    assert.deepEqual(fs.readdirSync(path.join(state, 'tmp')), [], 'the staging directory is removed afterwards');

    // The same holds when the refresh itself fails.
    await refreshDeferredHostExclusions({
        folders: [`${workspace}/project`], identity,
        createPlanner: () => ({}),
        refresh: () => { throw new Error('boom'); },
    });
    assert.deepEqual(fs.readdirSync(path.join(state, 'tmp')), []);
});

test('an unavailable host staging directory refuses the refresh instead of falling back to os.tmpdir()', async (t) => {
    const { identity, workspace } = fixture(t);
    fs.mkdirSync(path.join(workspace, 'project'));
    const calls = [];
    const records = await refreshDeferredHostExclusions({
        folders: [`${workspace}/project`],
        identity,
        createStaging: () => { throw new Error('no space'); },
        createPlanner: () => { calls.push('planner'); return {}; },
        refresh: () => { calls.push('refresh'); return { exclusions: { status: 'published' } }; },
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(records.map((record) => [record.outcome, record.code]), [['uncertain', 'exclusions-staging-unavailable']]);
    assert.equal(records[0].required, false);
});
