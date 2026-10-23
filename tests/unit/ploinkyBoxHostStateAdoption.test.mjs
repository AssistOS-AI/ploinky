import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGpuGrantStore } from '../../ploinky-box/gpuGrant.mjs';
import {
    HOST_STATE_SKELETON_NAMES,
    adoptWorkspaceHostState,
    readWorkspaceRecord,
    sweepStaleHostStaging,
} from '../../ploinky-box/hostState/adoption.mjs';
import { createHostStateGuard } from '../../ploinky-box/hostState/guard.mjs';
import { createHostStaging } from '../../ploinky-box/hostState/staging.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { LIVENESS } from '../../ploinky-box/lockLiveness.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { createRouterBindingStore } from '../../ploinky-box/routerBinding.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';

const GPU_GRANT = Object.freeze({ vendor: 'nvidia', agents: ['R/A'], denied: [], workspaceDenied: false });

function workspaceFixture(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-adoption-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const checkout = path.join(base, 'checkout');
    const workspace = path.join(base, 'workspace');
    fs.mkdirSync(checkout);
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    return { base, checkout, workspace, identity: buildWorkspaceIdentity(workspace, { markerFound: true }) };
}

function treeDigest(target) {
    const hash = crypto.createHash('sha256');
    const visit = (current) => {
        const stat = fs.lstatSync(current);
        hash.update(`${path.relative(target, current)}:${stat.mode}:`);
        if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
        else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(current));
        else hash.update(fs.readFileSync(current));
    };
    visit(target);
    return hash.digest('hex');
}

// A forged host-state tree that a host would honour if it trusted it: a
// wildcard Router binding and a GPU grant for R/A, written through the real
// stores so they are well-formed records.
function plantForgedTree(identity, lock) {
    createRouterBindingStore().write(identity, { address: '0.0.0.0', hostPort: 18080 }, lock);
    createGpuGrantStore().write(identity, GPU_GRANT, lock);
    fs.mkdirSync(path.join(identity.hostStateRoot, 'update-recovery'), { mode: 0o700 });
    fs.writeFileSync(path.join(identity.hostStateRoot, 'update-recovery', `${identity.instance}.json`), '{}\n', { mode: 0o600 });
}

const passGate = () => {};

test('first-use adoption quarantines every non-skeleton entry by exact name, then records the workspace', async (t) => {
    const { identity } = workspaceFixture(t);
    const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: identity.workspaceRoot });
    t.after(() => { try { lock.release(); } catch (_) {} });
    plantForgedTree(identity, lock);
    // Names that merely start like skeleton names are content, not skeleton.
    fs.mkdirSync(path.join(identity.hostStateRoot, 'locks-old'), { mode: 0o700 });
    fs.writeFileSync(path.join(identity.hostStateRoot, 'tmpfile'), 'x', { mode: 0o600 });
    const before = treeDigest(identity.hostStateRoot);
    assert.equal(readWorkspaceRecord(identity).state, 'absent');
    let gateRuns = 0;
    const result = adoptWorkspaceHostState(identity, lock, {
        assertQuiescent: () => { gateRuns += 1; },
        now: () => new Date('2026-10-22T10:11:12.345Z'),
        random: () => 'abcdef123456',
    });
    assert.equal(gateRuns, 1, 'adoption runs behind the quiescence gate');
    assert.equal(result.adopted, true);
    assert.deepEqual(result.moved, ['gpu-grants', 'locks-old', 'router-bindings', 'tmpfile', 'update-recovery']);
    assert.equal(result.quarantine, path.join(identity.hostStateRoot, 'quarantine', '20261022T101112Z-abcdef123456'));
    const live = fs.readdirSync(identity.hostStateRoot).sort();
    assert.deepEqual(live, [...HOST_STATE_SKELETON_NAMES.filter((name) => name !== 'tmp'), 'workspace.json'].sort());
    // Nothing is deleted or trusted: the quarantine holds the exact content.
    assert.deepEqual(fs.readdirSync(result.quarantine).sort(), result.moved);
    assert.notEqual(before, treeDigest(identity.hostStateRoot));
    assert.equal(createRouterBindingStore().read(identity), null, 'the forged binding is no longer read');
    assert.equal(createGpuGrantStore().read(identity), null, 'the forged GPU grant is no longer read');
    assert.equal(readWorkspaceRecord(identity).state, 'valid');
    const record = fs.statSync(path.join(identity.hostStateRoot, 'workspace.json'));
    assert.equal(record.mode & 0o777, 0o600);
    lock.release();
});

test('N22: a second adoption of a recorded workspace changes nothing and does not run the gate', async (t) => {
    const { identity } = workspaceFixture(t);
    const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: identity.workspaceRoot });
    t.after(() => { try { lock.release(); } catch (_) {} });
    adoptWorkspaceHostState(identity, lock, { assertQuiescent: passGate });
    // Records written by the host after adoption are trusted and kept.
    createRouterBindingStore().write(identity, { address: '0.0.0.0', hostPort: 18080 }, lock);
    const before = treeDigest(identity.hostStateRoot);
    const again = adoptWorkspaceHostState(identity, lock, {
        assertQuiescent: () => assert.fail('an adopted workspace needs no gate'),
    });
    assert.deepEqual(again, { adopted: false, quarantine: null, moved: [] });
    assert.equal(treeDigest(identity.hostStateRoot), before);
    assert.equal(createRouterBindingStore().read(identity).address, '0.0.0.0');
    lock.release();
});

test('a foreign, malformed or misspelled record is not an adoption record and is quarantined', async (t) => {
    for (const [name, body] of [
        ['workspace.json', JSON.stringify({ schema: 'ploinky-box-workspace', version: 1, instance: 'ploinky-box-other-123456789abc' })],
        ['workspace.json', '{oops'],
        ['Workspace.json', null],
    ]) {
        const { identity } = workspaceFixture(t);
        const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: identity.workspaceRoot });
        const target = path.join(identity.hostStateRoot, name);
        if (body === null) {
            // A record under another spelling (a case-insensitive filesystem
            // would open it as workspace.json) is never accepted.
            fs.writeFileSync(target, `${JSON.stringify({ schema: 'ploinky-box-workspace', version: 1, instance: identity.instance })}\n`, { mode: 0o600 });
        } else {
            fs.writeFileSync(target, body, { mode: 0o600 });
        }
        if (name === 'workspace.json') assert.equal(readWorkspaceRecord(identity).state, 'invalid');
        else assert.notEqual(readWorkspaceRecord(identity).state, 'valid');
        const result = adoptWorkspaceHostState(identity, lock, { assertQuiescent: passGate });
        assert.deepEqual(result.moved, [name], name);
        assert.equal(readWorkspaceRecord(identity).state, 'valid', name);
        lock.release();
    }
});

test('adoption refuses before moving anything when the gate refuses, a skeleton alias exists, or a running container binds an entry', async (t) => {
    const { identity } = workspaceFixture(t);
    const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: identity.workspaceRoot });
    t.after(() => { try { lock.release(); } catch (_) {} });
    plantForgedTree(identity, lock);
    const before = treeDigest(identity.hostStateRoot);
    const active = Object.assign(new Error('active'), { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' });
    assert.throws(() => adoptWorkspaceHostState(identity, lock, { assertQuiescent: () => { throw active; } }), active);
    assert.equal(treeDigest(identity.hostStateRoot), before, 'a refused gate moves nothing');

    const store = path.join(identity.hostStateRoot, 'hardware-limits', identity.instance, 'store');
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
    const bound = [{
        id: 'e'.repeat(64), name: identity.instance, running: true, labels: {},
        mounts: [{ type: 'bind', source: store, destination: '/run/ploinky/hardware-limits', rw: true }],
    }];
    const withStore = treeDigest(identity.hostStateRoot);
    assert.throws(() => adoptWorkspaceHostState(identity, lock, { view: bound, assertQuiescent: passGate }),
        { code: 'PLOINKY_BOX_HOST_STATE_BOUND' });
    assert.equal(treeDigest(identity.hostStateRoot), withStore, 'a live store bind is never moved');
    assert.equal(readWorkspaceRecord(identity).state, 'absent', 'and the workspace is not recorded');

    // An entry that is a skeleton directory under another spelling.
    fs.symlinkSync('unused', path.join(identity.hostStateRoot, 'probe'));
    const aliasFs = {
        ...fs,
        lstatSync(target, options) {
            if (target === path.join(identity.hostStateRoot, 'probe')) return fs.lstatSync(path.join(identity.hostStateRoot, 'locks'), options);
            return fs.lstatSync(target, options);
        },
    };
    assert.throws(() => adoptWorkspaceHostState(identity, lock, { fsApi: aliasFs, assertQuiescent: passGate }),
        /is the host state directory's own locks\/ under another spelling/);
    lock.release();
});

test('the staging sweep removes only directories whose owner is proven gone', async (t) => {
    const { identity } = workspaceFixture(t);
    const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: identity.workspaceRoot });
    t.after(() => { try { lock.release(); } catch (_) {} });
    const stale = createHostStaging(identity);
    const live = createHostStaging(identity);
    const tmp = path.dirname(stale.root);
    const ownerless = path.join(tmp, 'ownerless');
    fs.mkdirSync(ownerless, { mode: 0o700 });
    fs.writeFileSync(path.join(tmp, 'note'), 'x');
    fs.symlinkSync(stale.root, path.join(tmp, 'link'));
    // Both records name this process; give the stale one a PID that the
    // fixture liveness classifies as gone. Liveness alone decides, never age.
    const ownerPath = path.join(stale.root, 'owner.json');
    const staleOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    staleOwner.pid = 999999;
    fs.writeFileSync(ownerPath, `${JSON.stringify(staleOwner)}\n`);
    const removed = sweepStaleHostStaging(identity, lock, {
        liveness: { classify: (owner) => ({ state: owner.pid === 999999 ? LIVENESS.stale : LIVENESS.live, reason: 'fixture' }) },
    });
    assert.deepEqual(removed, [stale.root]);
    assert.equal(fs.existsSync(stale.root), false);
    for (const kept of [live.root, ownerless, path.join(tmp, 'note')]) assert.equal(fs.existsSync(kept), true, kept);
    assert.equal(fs.lstatSync(path.join(tmp, 'link')).isSymbolicLink(), true, 'a link is never followed or removed');
    // Undetermined liveness never removes anything.
    const before = treeDigest(tmp);
    sweepStaleHostStaging(identity, lock, { liveness: { classify: () => ({ state: LIVENESS.undetermined, reason: 'fixture' }) } });
    assert.equal(treeDigest(tmp), before);
    live.release();
    lock.release();
});

// ---------------------------------------------------------------------------
// Through the public supervisor
// ---------------------------------------------------------------------------

function supervisorFor(state, { view = [], gate = { assert() {} }, reconcile, discover, events = [] } = {}) {
    const guard = createHostStateGuard({
        repositoryRoot: state.checkout,
        observeEngine: () => view,
        gate,
        stderr: { write: (text) => events.push(`stderr:${text}`) },
    });
    return createBoxSupervisor({
        hostStateGuard: guard,
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        repositoryRoot: state.checkout,
        discover: discover || (() => ({ state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: null })),
        runner: { run(_command, args) { events.push(`run:${args.join(' ')}`); } },
        readNetworkInterfaces: () => ({}),
        scanGpuAgents: () => [],
        selectAgentLib: async () => ({ selection: null }),
        reconcile: reconcile || (async (options) => {
            events.push({ routerBinding: options.routerBinding, gpu: options.gpu });
            throw Object.assign(new Error('stop after reconcile input'), { code: 'FIXTURE_STOP' });
        }),
        stdout: { write() {} },
        stderr: { write: (text) => events.push(`stderr:${text}`) },
    });
}

test('N2b: a forged pre-existing tree is quarantined at first use and never selects a binding or grant', async (t) => {
    const state = workspaceFixture(t);
    const manager = createMutationLockManager();
    const planting = await manager.acquire(state.identity.instance, { workspaceRoot: state.identity.workspaceRoot });
    plantForgedTree(state.identity, planting);
    planting.release();
    const events = [];
    await assert.rejects(supervisorFor(state, { events }).prepareBoxForCommand(), { code: 'FIXTURE_STOP' });
    const inputs = events.find((event) => typeof event === 'object');
    assert.equal(inputs.routerBinding, null, 'loopback: the forged wildcard binding is not used');
    assert.equal(inputs.gpu, null, 'no GPU grant from the forged record');
    assert.match(events.find((event) => typeof event === 'string' && event.startsWith('stderr:[ploinky] Moved')), /gpu-grants, router-bindings, update-recovery/);
    assert.equal(readWorkspaceRecord(state.identity).state, 'valid');

    // Control: the same records written after adoption are honoured, so the
    // quarantine is what kept the forged ones out.
    const control = workspaceFixture(t);
    const lock = await manager.acquire(control.identity.instance, { workspaceRoot: control.identity.workspaceRoot });
    adoptWorkspaceHostState(control.identity, lock, { assertQuiescent: passGate });
    createRouterBindingStore().write(control.identity, { address: '0.0.0.0', hostPort: 18080 }, lock);
    lock.release();
    const controlEvents = [];
    await assert.rejects(supervisorFor(control, { events: controlEvents }).prepareBoxForCommand(), { code: 'FIXTURE_STOP' });
    assert.equal(controlEvents.find((event) => typeof event === 'object').routerBinding.address, '0.0.0.0');
});

test('N22 through the supervisor: a second start of an adopted workspace quarantines nothing and leaves records unchanged', async (t) => {
    const state = workspaceFixture(t);
    const events = [];
    await assert.rejects(supervisorFor(state, { events }).prepareBoxForCommand(), { code: 'FIXTURE_STOP' });
    const lock = await createMutationLockManager().acquire(state.identity.instance, { workspaceRoot: state.identity.workspaceRoot });
    createRouterBindingStore().write(state.identity, { address: '0.0.0.0', hostPort: 18080 }, lock);
    lock.release();
    const before = treeDigest(state.identity.hostStateRoot);
    const second = [];
    await assert.rejects(supervisorFor(state, { events: second, gate: { assert: () => assert.fail('no gate for an adopted workspace') } })
        .prepareBoxForCommand(), { code: 'FIXTURE_STOP' });
    assert.equal(treeDigest(state.identity.hostStateRoot), before);
    assert.equal(fs.readdirSync(path.join(state.identity.hostStateRoot, 'quarantine')).length, 0);
    assert.equal(second.some((event) => typeof event === 'string' && event.includes('Moved')), false);
});

test('a refused quiescence gate refuses a configuring command before adoption, and stop and destroy still run', async (t) => {
    const state = workspaceFixture(t);
    const manager = createMutationLockManager();
    const planting = await manager.acquire(state.identity.instance, { workspaceRoot: state.identity.workspaceRoot });
    plantForgedTree(state.identity, planting);
    planting.release();
    const before = treeDigest(state.identity.hostStateRoot);
    const refuse = { assert() { throw Object.assign(new Error('host agent 41 runs'), { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' }); } };
    await assert.rejects(supervisorFor(state, { gate: refuse }).prepareBoxForCommand(), { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' });
    assert.equal(treeDigest(state.identity.hostStateRoot), before, 'nothing was moved or recorded');
    // Restricting transactions never adopt, so the gate does not bind them.
    const stopped = await supervisorFor(state, { gate: refuse }).runStopTransaction();
    assert.equal(stopped.action, 'absent');
    assert.equal(readWorkspaceRecord(state.identity).state, 'absent');
});

test('N1 through the supervisor: a .ploinky-box replaced by a link is refused and its target is never written', async (t) => {
    const state = workspaceFixture(t);
    const evil = path.join(state.base, 'evil');
    fs.mkdirSync(evil);
    fs.writeFileSync(path.join(evil, 'keep'), 'x');
    fs.symlinkSync(evil, state.identity.hostStateRoot, 'dir');
    const before = treeDigest(evil);
    await assert.rejects(supervisorFor(state).prepareBoxForCommand(), { code: 'PLOINKY_BOX_HOST_STATE_INVALID' });
    assert.equal(treeDigest(evil), before);
});

test('stop never fails on host-state hygiene: an unreadable tmp/ is left alone', async (t) => {
    const state = workspaceFixture(t);
    const lock = await createMutationLockManager().acquire(state.identity.instance, { workspaceRoot: state.identity.workspaceRoot });
    adoptWorkspaceHostState(state.identity, lock, { assertQuiescent: passGate });
    lock.release();
    const tmp = path.join(state.identity.hostStateRoot, 'tmp');
    fs.mkdirSync(tmp, { mode: 0o700 });
    fs.chmodSync(tmp, 0o000);
    try {
        assert.throws(() => sweepStaleHostStaging(state.identity, { assertHeld() {} }), { code: 'EACCES' });
        const stopped = await supervisorFor(state).runStopTransaction();
        assert.equal(stopped.action, 'absent');
    } finally {
        fs.chmodSync(tmp, 0o700);
    }
});
