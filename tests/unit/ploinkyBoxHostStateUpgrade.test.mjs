import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_IMAGE_REFERENCE, INCOMPATIBLE_BOX_GUIDANCE } from '../../ploinky-box/constants.mjs';
import { adoptWorkspaceHostState, readWorkspaceRecord } from '../../ploinky-box/hostState/adoption.mjs';
import { UNMASKED_BOX_RESIDUAL, createHostStateGuard } from '../../ploinky-box/hostState/guard.mjs';
import { ensureHostStateSkeleton, hostStatePaths, tightenHostStateRoot } from '../../ploinky-box/hostState/root.mjs';
import { HOST_STAGING_LABEL } from '../../ploinky-box/hostState/staging.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { containerCreateArgs } from '../../ploinky-box/lifecycle/container.mjs';
import { LOCK_OWNER_SCHEMA, LOCK_OWNER_VERSION, OWNER_FILE, serializeOwner } from '../../ploinky-box/lockFiles.mjs';
import { createLockLiveness } from '../../ploinky-box/lockLiveness.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { createRouterBindingStore } from '../../ploinky-box/routerBinding.mjs';
import { nestedPodmanSeccompProfilePath } from '../../ploinky-box/seccomp.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { createUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { OUTER_IMAGE_ID_FIXTURE, imageAgentLibFixture } from '../helpers/agentlibFixture.mjs';
import { handleFromCreateArgs } from '../helpers/hostStateFixture.mjs';

// Upgrading a workspace whose `.ploinky-box` an older, unmasked Box could
// write: the root mode it left (F1), and what a refused start and the old Box
// itself can leave in the skeleton.

const DATA_FINGERPRINTS = Object.freeze({ dependencies: 'd'.repeat(64), images: 'f'.repeat(64) });
const SKELETON = ['empty', 'locks', 'quarantine', 'tmp'];

function scratch(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-upgrade-')));
    t.after(() => {
        // `empty/` is 0555: open every real directory up before removal.
        const openUp = (current) => {
            const stat = fs.lstatSync(current);
            if (!stat.isDirectory()) return;
            fs.chmodSync(current, 0o700);
            for (const name of fs.readdirSync(current)) openUp(path.join(current, name));
        };
        openUp(base);
        fs.rmSync(base, { recursive: true, force: true });
    });
    return base;
}

function seedCheckout(checkout) {
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const seccomp = nestedPodmanSeccompProfilePath(checkout);
    fs.mkdirSync(path.dirname(seccomp), { recursive: true });
    fs.copyFileSync(new URL('../../ploinky-box/seccomp/podman-nested-pid-fallback.json', import.meta.url), seccomp);
    return checkout;
}

function treeDigest(target) {
    const hash = crypto.createHash('sha256');
    const visit = (current) => {
        const stat = fs.lstatSync(current);
        hash.update(`${path.relative(target, current)}:${stat.mode}:${stat.mtimeMs}:`);
        if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
        else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(current));
        else hash.update(fs.readFileSync(current));
    };
    visit(target);
    return hash.digest('hex');
}

const modeOf = (target) => fs.lstatSync(target).mode & 0o7777;

// Writes into a skeleton directory the way the old Box (same user) could:
// `empty/` is read-only, so it is opened up for the write and closed again.
function plantInto(directory, name, body = 'planted') {
    const mode = modeOf(directory);
    fs.chmodSync(directory, 0o700);
    try {
        fs.writeFileSync(path.join(directory, name), body, { mode: 0o600 });
    } finally {
        fs.chmodSync(directory, mode);
    }
}

// A Box created before the host state mask existed.
function legacyHandle(identity, repositoryRoot) {
    const handle = handleFromCreateArgs(containerCreateArgs({
        identity,
        dataFingerprints: DATA_FINGERPRINTS,
        agentLib: imageAgentLibFixture(),
        imageId: OUTER_IMAGE_ID_FIXTURE,
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 18080,
        repositoryRoot,
        cidfile: path.join(identity.workspaceRoot, 'candidate.cid'),
    }));
    handle.runtime.mounts = handle.runtime.mounts.filter((mount) => mount.destination !== `${identity.workspaceRoot}/.ploinky-box`);
    return handle;
}

/**
 * The live upgrade sequence over a fake engine and the real lock manager,
 * stores and adoption: an old unmasked Box runs. `onStop` runs when the old
 * Box is stopped (what it writes in its last moments). `discover`, when given,
 * replaces the engine's ownership answer: `({ call, state, old, engine })`,
 * where `call` counts the supervisor's inspections from 1.
 */
function upgradeWorld(t, { onStop = () => {}, discover = null } = {}) {
    const base = scratch(t);
    const workspace = path.join(base, 'W');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const checkout = seedCheckout(path.join(base, 'ploinky'));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const paths = hostStatePaths(workspace);
    const old = legacyHandle(identity, checkout);
    const state = { present: true, gateRuns: 0, reconciled: 0, discoveries: 0, notices: [], calls: [] };
    const runner = {
        run(_command, args) {
            state.calls.push(args.join(' '));
            if (args[1] === 'stop') {
                onStop({ identity, paths });
                old.runtime.running = false;
            }
            if (args[1] === 'rm') state.present = false;
        },
    };
    const engine = { name: 'podman', identity: 'engine' };
    const view = () => (state.present ? [{
        id: old.id, name: identity.instance, running: old.runtime.running, labels: old.labels,
        mounts: old.runtime.mounts.map(({ source, destination, rw }) => ({ type: 'bind', source, destination, rw })),
    }] : []);
    const supervisor = () => createBoxSupervisor({
        hostStateGuard: createHostStateGuard({
            repositoryRoot: checkout,
            observeEngine: view,
            gate: { assert() { state.gateRuns += 1; } },
            stderr: { write: (text) => state.notices.push(text) },
        }),
        resolveIdentity: () => identity,
        launchCwd: workspace,
        repositoryRoot: checkout,
        discover: discover
            ? () => discover({ call: (state.discoveries += 1), state, old, engine })
            : () => (state.present ? { state: 'owned', engine, handles: { container: old } } : { state: 'absent', engine, handles: null }),
        runner,
        readNetworkInterfaces: () => ({}),
        scanGpuAgents: () => [],
        selectAgentLib: async () => ({ selection: null }),
        reconcile: async () => {
            state.reconciled += 1;
            throw Object.assign(new Error('stop after reconcile input'), { code: 'FIXTURE_STOP' });
        },
        stdout: { write() {} },
        stderr: { write: (text) => state.notices.push(text) },
    });
    return { base, workspace, identity, paths, old, state, supervisor };
}

// What the old Box left: its own root mode, a wildcard Router binding and a
// well-formed adoption record (the entries the destroy quarantine moves).
async function plantOldBoxTree(w, rootMode) {
    fs.mkdirSync(w.paths.root);
    fs.chmodSync(w.paths.root, rootMode);
    const lock = await createMutationLockManager().acquire(w.identity.instance, { workspaceRoot: w.workspace });
    createRouterBindingStore().write(w.identity, { address: '0.0.0.0', hostPort: 18080 }, lock);
    lock.release();
    fs.writeFileSync(path.join(w.paths.root, 'workspace.json'),
        `${JSON.stringify({ schema: 'ploinky-box-workspace', version: 1, instance: w.identity.instance })}\n`, { mode: 0o600 });
    assert.equal(modeOf(w.paths.root), rootMode, 'the skeleton accepted the root as it was');
}

// A host staging directory (the createHostStaging layout) whose owner record
// names this machine and PID namespace but a PID that does not exist: the
// real liveness rules classify it stale.
function plantStaleStaging(identity, parent) {
    const self = createLockLiveness().selfFields();
    const entry = path.join(parent, 'stale');
    fs.mkdirSync(entry, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(entry, OWNER_FILE), serializeOwner({
        schema: LOCK_OWNER_SCHEMA, version: LOCK_OWNER_VERSION, label: HOST_STAGING_LABEL,
        instance: identity.instance, workspaceRoot: identity.workspaceRoot, hostname: self.hostname,
        machineId: self.machineId, bootId: self.bootId, pidNamespace: self.pidNamespace,
        pid: 99999999, processStart: self.processStart, startedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    assert.equal(createLockLiveness().classify({ ...self, pid: 99999999 }).state, 'stale', 'the fixture owner is stale');
}

const INCOMPATIBLE = {
    code: 'PLOINKY_BOX_PUBLICATION_INCOMPATIBLE',
    message: `Owned Box mount set is incompatible${INCOMPATIBLE_BOX_GUIDANCE}.${UNMASKED_BOX_RESIDUAL}`,
};

// ---------------------------------------------------------------------------
// F1: a 0755 root left by an older Box
// ---------------------------------------------------------------------------

test('F1: a 0755 .ploinky-box is refused at start, quarantined at destroy, then adopted private and the start proceeds', async (t) => {
    const outcomes = {};
    for (const rootMode of [0o700, 0o755]) {
        const w = upgradeWorld(t);
        await plantOldBoxTree(w, rootMode);
        await assert.rejects(w.supervisor().runStartTransaction(['start', 'explorer']), INCOMPATIBLE);
        const destroyed = await w.supervisor().runDestroyTransaction(w.old.id);
        assert.equal(destroyed.action, 'destroyed');
        // Every later start: adopted behind the gate, then the update records
        // (the recovery barrier is read first) and on to the Box reconciliation.
        for (const attempt of [1, 2]) {
            await assert.rejects(w.supervisor().runStartTransaction(['start', 'explorer']), { code: 'FIXTURE_STOP' }, `start ${attempt}`);
        }
        assert.equal(w.state.reconciled, 2);
        assert.equal(w.state.gateRuns, 1, 'one adoption, behind the gate');
        assert.equal(modeOf(w.paths.root) & 0o077, 0, `the ${rootMode.toString(8)} root is private after adoption`);
        assert.equal(readWorkspaceRecord(w.identity).state, 'valid');
        const [quarantine] = fs.readdirSync(w.paths.quarantine);
        outcomes[rootMode.toString(8)] = {
            quarantined: destroyed.hostStateQuarantine.quarantined,
            moved: [...destroyed.hostStateQuarantine.moved],
            quarantineEntries: fs.readdirSync(w.paths.quarantine).length,
            content: fs.readdirSync(path.join(w.paths.quarantine, quarantine)).sort(),
            live: fs.readdirSync(w.paths.root).sort(),
        };
    }
    assert.deepEqual(outcomes['755'], outcomes['700'], 'the root mode changes nothing about the quarantine');
    assert.deepEqual(outcomes['755'].moved, ['router-bindings', 'workspace.json']);
    assert.deepEqual(outcomes['755'].live, ['empty', 'locks', 'quarantine', 'workspace.json']);
});

test('F1: adoption makes a 0755 root private only behind the gate, and the update records then work', async (t) => {
    const w = upgradeWorld(t);
    fs.mkdirSync(w.paths.root);
    fs.chmodSync(w.paths.root, 0o755);
    fs.writeFileSync(path.join(w.paths.root, 'stray'), 'x', { mode: 0o600 });
    const lock = await createMutationLockManager().acquire(w.identity.instance, { workspaceRoot: w.workspace });
    t.after(() => { try { lock.release(); } catch (_) {} });
    assert.equal(modeOf(w.paths.root), 0o755);
    const store = createUpdateHostState({ identity: w.identity });
    assert.throws(() => store.read('update-recovery', w.identity.instance), {
        code: 'PLOINKY_BOX_UPDATE_STATE_INVALID',
        message: `Update state directory must be private to the current user: ${w.paths.root}. After checking that it and `
            + `its contents belong to you, run \`chmod 700 ${w.paths.root}\`.`,
    });
    const refused = Object.assign(new Error('host agent 41 runs'), { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' });
    assert.throws(() => adoptWorkspaceHostState(w.identity, lock, { assertQuiescent: () => { throw refused; } }), refused);
    assert.equal(modeOf(w.paths.root), 0o755, 'a refused gate leaves the root as it was');
    const { ino } = fs.lstatSync(w.paths.root);
    const adopted = adoptWorkspaceHostState(w.identity, lock, { assertQuiescent: () => {} });
    assert.deepEqual([...adopted.moved], ['stray']);
    assert.equal(modeOf(w.paths.root), 0o700);
    assert.equal(fs.lstatSync(w.paths.root).ino, ino, 'the same directory, re-moded in place');
    store.write('update-recovery', w.identity.instance, { fixture: true });
    assert.deepEqual(store.read('update-recovery', w.identity.instance), { fixture: true });
    lock.release();
});

test('F1: tightenHostStateRoot refuses a link, a foreign owner or a swapped directory and changes no mode', (t) => {
    const base = scratch(t);
    const workspace = path.join(base, 'W');
    fs.mkdirSync(workspace);
    const root = path.join(workspace, '.ploinky-box');

    // A link to a directory of this user: refused, the target keeps its mode.
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, root, 'dir');
    assert.throws(() => tightenHostStateRoot(workspace), { code: 'PLOINKY_BOX_HOST_STATE_INVALID', message: /is not a real directory/ });
    assert.equal(modeOf(target), 0o755);
    fs.unlinkSync(root);

    // A directory owned by someone else (an injected uid): refused unchanged.
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o755);
    const uid = process.getuid();
    assert.throws(() => tightenHostStateRoot(workspace, { uid: uid + 1 }),
        { code: 'PLOINKY_BOX_HOST_STATE_INVALID', message: /is not owned by the current user/ });
    assert.equal(modeOf(root), 0o755);
    // Owned as seen by lstat, but the opened descriptor reports another owner.
    const foreignWhenOpened = { ...fs, fstatSync: (fd, options) => Object.assign(fs.fstatSync(fd, options), { uid: uid + 1 }) };
    assert.throws(() => tightenHostStateRoot(workspace, { fsApi: foreignWhenOpened, uid }),
        { message: /is not owned by the current user when opened/ });
    assert.equal(modeOf(root), 0o755);

    // The directory is replaced between lstat and open: the descriptor names
    // another directory, which is never re-moded.
    const swapped = path.join(base, 'swapped');
    fs.mkdirSync(swapped);
    fs.chmodSync(swapped, 0o755);
    const swapping = { ...fs, openSync: (file, flags) => fs.openSync(file === root ? swapped : file, flags) };
    assert.throws(() => tightenHostStateRoot(workspace, { fsApi: swapping, uid }), { message: /changed while it was opened/ });
    assert.equal(modeOf(swapped), 0o755);
    assert.equal(modeOf(root), 0o755);

    // A non-directory is refused.
    fs.rmdirSync(root);
    fs.writeFileSync(root, 'x', { mode: 0o644 });
    assert.throws(() => tightenHostStateRoot(workspace), { message: /is not a real directory/ });
    assert.equal(modeOf(root), 0o644);
    fs.unlinkSync(root);

    // The positive case, through a descriptor: only group and other bits go.
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o775);
    const used = [];
    const recording = { ...fs, fchmodSync: (fd, mode) => { used.push('fchmod'); return fs.fchmodSync(fd, mode); },
        chmodSync: () => assert.fail('the root is never re-moded by path') };
    assert.equal(tightenHostStateRoot(workspace, { fsApi: recording }), true);
    assert.deepEqual(used, ['fchmod']);
    assert.equal(modeOf(root), 0o700);
    assert.equal(tightenHostStateRoot(workspace, { fsApi: recording }), false, 'a private root is left alone');
});

test('F1: the skeleton refusal names the remedy with the expected mode', (t) => {
    const base = scratch(t);
    const workspace = path.join(base, 'W');
    fs.mkdirSync(workspace);
    const paths = hostStatePaths(workspace);
    fs.mkdirSync(paths.root);
    fs.chmodSync(paths.root, 0o775);
    assert.throws(() => ensureHostStateSkeleton(workspace), {
        code: 'PLOINKY_BOX_HOST_STATE_INVALID',
        message: `Host state directory has unsafe write permissions: ${paths.root}. After checking that its contents `
            + `belong to you, run \`chmod 700 ${paths.root}\`.`,
    });
    fs.chmodSync(paths.root, 0o700);
    ensureHostStateSkeleton(workspace);
    fs.chmodSync(paths.empty, 0o755);
    assert.throws(() => ensureHostStateSkeleton(workspace), { message: new RegExp(`run \`chmod 555 ${paths.empty}\``) });
});

// ---------------------------------------------------------------------------
// A refused start writes nothing; what the old Box itself can plant
// ---------------------------------------------------------------------------

test('a start refused for an unmasked Box writes nothing into the workspace, with or without .ploinky-box', async (t) => {
    const fresh = upgradeWorld(t);
    for (const invoke of [(box) => box.prepareBoxForCommand(), (box) => box.runStartTransaction(['start', 'explorer'])]) {
        await assert.rejects(invoke(fresh.supervisor()), INCOMPATIBLE);
    }
    assert.equal(fs.existsSync(fresh.paths.root), false, 'no skeleton, no lock, no mtime change');

    const existing = upgradeWorld(t);
    await plantOldBoxTree(existing, 0o755);
    const before = treeDigest(existing.paths.root);
    await assert.rejects(existing.supervisor().runStartTransaction(['start', 'explorer']), INCOMPATIBLE);
    assert.equal(treeDigest(existing.paths.root), before, 'names, modes and mtimes are unchanged');
    assert.equal(existing.state.calls.length, 0);
});

test('content the old Box plants in the skeleton never reaches a new Box: empty/ refuses every lock, the rest is inert', async (t) => {
    // Planted while the old Box still ran, before destroy: every lock
    // acquisition refuses, destroy included, until the operator empties it.
    const before = upgradeWorld(t);
    await plantOldBoxTree(before, 0o700);
    plantInto(before.paths.empty, 'mask-content');
    const emptyRefusal = { code: 'PLOINKY_BOX_HOST_STATE_INVALID', message: /Host state mask source must be empty/ };
    await assert.rejects(before.supervisor().runDestroyTransaction(before.old.id), emptyRefusal);
    assert.equal(before.state.present, true, 'nothing was removed');
    plantInto(before.paths.empty, 'mask-content');
    fs.chmodSync(before.paths.empty, 0o755);
    fs.rmSync(path.join(before.paths.empty, 'mask-content'));
    fs.chmodSync(before.paths.empty, 0o555);
    assert.equal((await before.supervisor().runDestroyTransaction(before.old.id)).action, 'destroyed');

    // Planted in its last moments, while destroy holds the lock: destroy
    // quarantines everything but the skeleton; the next start refuses the
    // non-empty mask source before it adopts or creates anything.
    // The `tmp` link points at a directory outside `.ploinky-box` holding a
    // staging entry whose owner the real liveness rules call gone: the sweep
    // would remove it if it followed the link.
    let outside = null;
    const late = upgradeWorld(t, {
        onStop: ({ identity, paths }) => {
            plantInto(paths.empty, 'mask-content');
            plantInto(paths.quarantine, 'forged');
            outside = path.join(path.dirname(identity.workspaceRoot), 'outside-staging');
            plantStaleStaging(identity, outside);
            fs.symlinkSync(outside, path.join(paths.root, 'tmp'));
            fs.writeFileSync(path.join(paths.locks, 'note'), 'x');
        },
    });
    await plantOldBoxTree(late, 0o700);
    const destroyed = await late.supervisor().runDestroyTransaction(late.old.id);
    assert.equal(destroyed.action, 'destroyed');
    await assert.rejects(late.supervisor().runStartTransaction(['start', 'explorer']), emptyRefusal);
    assert.equal(late.state.gateRuns, 0);
    assert.equal(late.state.reconciled, 0);
    assert.equal(readWorkspaceRecord(late.identity).state, 'absent', 'not adopted');

    // Once emptied, the start adopts; the planted quarantine entry, `tmp`
    // link and `locks/note` are kept as they are and nothing follows them.
    const anchor = treeDigest(outside);
    fs.chmodSync(late.paths.empty, 0o755);
    fs.rmSync(path.join(late.paths.empty, 'mask-content'));
    fs.chmodSync(late.paths.empty, 0o555);
    await assert.rejects(late.supervisor().runStartTransaction(['start', 'explorer']), { code: 'FIXTURE_STOP' });
    assert.equal(late.state.gateRuns, 1);
    assert.equal(treeDigest(outside), anchor, 'the tmp link target is untouched');
    assert.equal(fs.existsSync(path.join(outside, 'stale')), true, 'the stale-looking entry behind the link is kept');
    assert.equal(fs.lstatSync(path.join(late.paths.root, 'tmp')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(late.paths.quarantine, 'forged')), true);
    assert.deepEqual(fs.readdirSync(late.paths.empty), []);
    assert.deepEqual(fs.readdirSync(late.paths.root).filter((name) => !SKELETON.includes(name)), ['workspace.json']);

    // Control: the same entry in a real `tmp/` is removed by the next
    // configuring command's sweep, so the kept entry above was not followed.
    fs.unlinkSync(path.join(late.paths.root, 'tmp'));
    fs.mkdirSync(path.join(late.paths.root, 'tmp'), { mode: 0o700 });
    plantStaleStaging(late.identity, path.join(late.paths.root, 'tmp'));
    await assert.rejects(late.supervisor().runStartTransaction(['start', 'explorer']), { code: 'FIXTURE_STOP' });
    assert.equal(fs.existsSync(path.join(late.paths.root, 'tmp', 'stale')), false, 'the sweep removes it from a real tmp/');
});

test('the under-lock check refuses an unmasked Box that appears after the unlocked inspection, before the gate or any adoption', async (t) => {
    // The unlocked inspection (before the lock) sees no Box; the inspection
    // under the lock sees the old unmasked one: only the under-lock check
    // can refuse it.
    const w = upgradeWorld(t, {
        discover: ({ call, old, engine }) => (call === 1
            ? { state: 'absent', engine, handles: null }
            : { state: 'owned', engine, handles: { container: old } }),
    });
    fs.mkdirSync(w.paths.root, { mode: 0o700 });
    fs.writeFileSync(path.join(w.paths.root, 'stray'), 'x', { mode: 0o600 });
    await assert.rejects(w.supervisor().runStartTransaction(['start', 'explorer']), INCOMPATIBLE);
    assert.ok(w.state.discoveries >= 2, 'the Box was inspected again under the lock');
    assert.equal(w.state.gateRuns, 0, 'the quiescence gate never ran');
    assert.equal(w.state.reconciled, 0);
    assert.equal(readWorkspaceRecord(w.identity).state, 'absent', 'workspace.json was not written');
    assert.equal(fs.existsSync(path.join(w.paths.root, 'stray')), true, 'nothing was quarantined');
    assert.deepEqual(fs.readdirSync(w.paths.quarantine), []);
    assert.deepEqual(w.state.calls, [], 'no engine command ran');
});
