import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_IMAGE_REFERENCE, INCOMPATIBLE_BOX_GUIDANCE } from '../../ploinky-box/constants.mjs';
import { updateWorkspacePloinkySource } from '../../ploinky-box/command/hostUpdate.mjs';
import {
    assertCheckoutPlacement,
    checkoutShadowArgs,
    checkoutShadowMount,
} from '../../ploinky-box/contract/checkoutAlias.mjs';
import { validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';
import { UNMASKED_BOX_RESIDUAL, createHostStateGuard } from '../../ploinky-box/hostState/guard.mjs';
import { createQuiescenceGate } from '../../ploinky-box/hostState/quiescence.mjs';
import { readWorkspaceRecord } from '../../ploinky-box/hostState/adoption.mjs';
import { hostStatePaths } from '../../ploinky-box/hostState/root.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { createRouterBindingStore } from '../../ploinky-box/routerBinding.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { containerCreateArgs } from '../../ploinky-box/lifecycle/container.mjs';
import { nestedPodmanSeccompProfilePath } from '../../ploinky-box/seccomp.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { OUTER_IMAGE_ID_FIXTURE, imageAgentLibFixture } from '../helpers/agentlibFixture.mjs';
import { handleFromCreateArgs } from '../helpers/hostStateFixture.mjs';

const DATA_FINGERPRINTS = Object.freeze({ dependencies: 'd'.repeat(64), images: 'f'.repeat(64) });

function scratch(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-checkout-alias-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
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
        hash.update(`${path.relative(target, current)}:${stat.mode}:`);
        if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
        else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(current));
        else hash.update(fs.readFileSync(current));
    };
    visit(target);
    return hash.digest('hex');
}

function qaLayout(t) {
    const base = scratch(t);
    const workspace = path.join(base, 'W');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const checkout = seedCheckout(path.join(workspace, '.runtime', 'ploinky'));
    return { base, workspace, checkout, identity: buildWorkspaceIdentity(workspace, { markerFound: true }) };
}

function createArgs(identity, repositoryRoot) {
    return containerCreateArgs({
        identity,
        dataFingerprints: DATA_FINGERPRINTS,
        agentLib: imageAgentLibFixture(),
        imageId: OUTER_IMAGE_ID_FIXTURE,
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 18080,
        repositoryRoot,
        cidfile: path.join(identity.workspaceRoot, 'candidate.cid'),
    });
}

const volumesOf = (args) => args.flatMap((value, index) => (value === '--volume' ? [args[index + 1]] : []));

function desiredFor(identity, repositoryRoot) {
    return {
        identity,
        agentLib: imageAgentLibFixture(),
        repositoryRoot,
        imageId: OUTER_IMAGE_ID_FIXTURE,
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 18080,
    };
}

test('A4: every Box masks .ploinky-box and shadows a checkout inside the workspace, in order, and the contract requires both exactly', (t) => {
    const { workspace, checkout, identity } = qaLayout(t);
    const args = createArgs(identity, checkout);
    assert.deepEqual(volumesOf(args), [
        `${checkout}:/opt/ploinky:ro`,
        `${workspace}:${workspace}`,
        `${workspace}/.ploinky-box/empty:${workspace}/.ploinky-box:ro`,
        `${workspace}/.runtime:${workspace}/.runtime`,
        `${checkout}:${checkout}:ro`,
        `${identity.dataPaths.dependencies}:/opt/ploinky/node_modules`,
        `${identity.dataPaths.images}:/home/podman/.local/share/ploinky-images`,
    ], 'the mask, the checkout parent self-bind and the shadow follow the writable workspace bind they cover');
    const handle = handleFromCreateArgs(args);
    assert.doesNotThrow(() => validateContainerConfiguration(handle, desiredFor(identity, checkout)));
    const variants = {
        'mask missing': (mounts) => mounts.filter((mount) => mount.destination !== `${workspace}/.ploinky-box`),
        'mask writable': (mounts) => mounts.map((mount) => (mount.destination === `${workspace}/.ploinky-box` ? { ...mount, rw: true } : mount)),
        'mask from another source': (mounts) => mounts.map((mount) => (mount.destination === `${workspace}/.ploinky-box` ? { ...mount, source: `${workspace}/.ploinky-box/quarantine` } : mount)),
        'shadow missing': (mounts) => mounts.filter((mount) => mount.destination !== checkout),
        'shadow writable': (mounts) => mounts.map((mount) => (mount.destination === checkout ? { ...mount, rw: true } : mount)),
        'parent self-bind missing': (mounts) => mounts.filter((mount) => mount.destination !== `${workspace}/.runtime`),
        'parent self-bind from another source': (mounts) => mounts.map((mount) => (mount.destination === `${workspace}/.runtime`
            ? { ...mount, source: `${workspace}/.runtime.x` } : mount)),
        'extra self-bind': (mounts) => [...mounts, { type: 'bind', name: '', source: `${workspace}/.data`, destination: `${workspace}/.data`, rw: true }],
    };
    for (const [label, change] of Object.entries(variants)) {
        const changed = { ...handle, runtime: { ...handle.runtime, mounts: change(handle.runtime.mounts) } };
        assert.throws(() => validateContainerConfiguration(changed, desiredFor(identity, checkout)),
            (error) => error.code === 'PLOINKY_BOX_PUBLICATION_INCOMPATIBLE' && error.message.endsWith(INCOMPATIBLE_BOX_GUIDANCE), label);
    }
});

test('A19/N21: no shadow for a checkout outside the workspace; the shadow source and alias path for one inside', (t) => {
    const base = scratch(t);
    const workspace = path.join(base, 'W');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const outside = seedCheckout(path.join(base, 'ploinky'));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    assert.equal(checkoutShadowMount(workspace, outside), null);
    const args = createArgs(identity, outside);
    assert.equal(volumesOf(args).some((volume) => volume.startsWith(`${outside}:${outside}`)), false);
    assert.equal(volumesOf(args).filter((volume) => volume.endsWith(':ro') && volume.includes('.ploinky-box')).length, 1, 'the mask is always present');
    // A checkout inside, reached through a link spelling of the workspace.
    const inside = seedCheckout(path.join(workspace, '.runtime', 'ploinky'));
    const alias = path.join(base, 'alias');
    fs.symlinkSync(workspace, alias);
    assert.deepEqual(checkoutShadowMount(alias, inside), {
        source: inside, destination: `${alias}/.runtime/ploinky`, rw: false,
        parents: [{ source: `${alias}/.runtime`, destination: `${alias}/.runtime`, rw: true }],
    });
    assert.deepEqual(checkoutShadowArgs(checkoutShadowMount(workspace, inside)), [
        '--volume', `${workspace}/.runtime:${workspace}/.runtime`, '--volume', `${inside}:${inside}:ro`,
    ]);
    // A direct child of the workspace needs no self-bind; a deeper one gets one per level.
    const direct = seedCheckout(path.join(workspace, 'ploinky'));
    assert.deepEqual(checkoutShadowMount(workspace, direct).parents, []);
    const deep = seedCheckout(path.join(workspace, 'a', 'b', 'ploinky'));
    assert.deepEqual(checkoutShadowMount(workspace, deep).parents.map((parent) => parent.source), [`${workspace}/a`, `${workspace}/a/b`]);
    // A linked parent is refused rather than bound.
    fs.mkdirSync(path.join(workspace, 'real'));
    fs.symlinkSync('real', path.join(workspace, 'linked'));
    const throughLink = seedCheckout(path.join(workspace, 'real', 'ploinky'));
    assert.deepEqual(checkoutShadowMount(workspace, path.join(workspace, 'linked', 'ploinky')).parents.map((parent) => parent.source),
        [`${workspace}/real`], 'the resolved path is bound, never the link');
    void throughLink;
});

test('N21b: a workspace equal to or inside the checkout, or a checkout inside .ploinky-box, is refused', (t) => {
    const base = scratch(t);
    const checkout = seedCheckout(path.join(base, 'ploinky'));
    fs.mkdirSync(path.join(checkout, 'cli'));
    for (const workspace of [checkout, path.join(checkout, 'cli')]) {
        assert.throws(() => assertCheckoutPlacement(workspace, checkout), { code: 'PLOINKY_BOX_CHECKOUT_ALIAS_INVALID' });
        assert.throws(() => createArgs(buildWorkspaceIdentity(workspace), checkout), { code: 'PLOINKY_BOX_CHECKOUT_ALIAS_INVALID' });
    }
    const workspace = path.join(base, 'W');
    const hidden = seedCheckout(path.join(workspace, '.ploinky-box', 'tmp', 'ploinky'));
    assert.throws(() => checkoutShadowMount(workspace, hidden), /inside the host state directory/);
    const folded = seedCheckout(path.join(workspace, 'x', '.Ploinky-Box', 'ploinky'));
    assert.throws(() => checkoutShadowMount(workspace, folded), { code: 'PLOINKY_BOX_CHECKOUT_ALIAS_INVALID' });
    const colon = seedCheckout(path.join(workspace, 'a:b', 'ploinky'));
    assert.throws(() => checkoutShadowMount(workspace, colon), { code: 'PLOINKY_BOX_CHECKOUT_ALIAS_INVALID' });
});

test('N21b through the supervisor: refused before anything is written, the checkout and its .git unchanged', async (t) => {
    const base = scratch(t);
    const checkout = seedCheckout(path.join(base, 'ploinky'));
    for (const workspace of [checkout, path.join(checkout, 'cli')]) {
        fs.mkdirSync(workspace, { recursive: true });
        const before = treeDigest(checkout);
        const identity = buildWorkspaceIdentity(workspace);
        const supervisor = createBoxSupervisor({
            hostStateGuard: createHostStateGuard({ repositoryRoot: checkout, observeEngine: () => [], gate: { assert() {} } }),
            resolveIdentity: () => identity,
            launchCwd: workspace,
            repositoryRoot: checkout,
            discover: () => ({ state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: null }),
            runner: { run() { assert.fail('no engine mutation'); } },
            stdout: { write() {} },
            stderr: { write() {} },
        });
        await assert.rejects(supervisor.prepareBoxForCommand(), { code: 'PLOINKY_BOX_CHECKOUT_ALIAS_INVALID' });
        assert.equal(treeDigest(checkout), before, workspace);
        assert.equal(fs.existsSync(path.join(workspace, '.ploinky-box')), false);
    }
});

test('D-I: the in-Box update is told to skip the shadowed host checkout at the shadow path', async (t) => {
    const base = scratch(t);
    const workspace = path.join(base, 'W');
    const checkout = path.join(workspace, 'ploinky');
    fs.mkdirSync(checkout, { recursive: true });
    execFileSync('git', ['init', '-q', checkout], { stdio: 'ignore' });
    fs.mkdirSync(path.join(checkout, 'bin'));
    fs.mkdirSync(path.join(checkout, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'ploinky-cloud', bin: { ploinky: './bin/ploinky' } }));
    fs.writeFileSync(path.join(checkout, 'bin', 'ploinky'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(checkout, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// fixture\n');
    const identity = buildWorkspaceIdentity(workspace);
    const result = await updateWorkspacePloinkySource({
        identity,
        lock: { assertHeld(instance) { assert.equal(instance, identity.instance); } },
        repositoryRoot: checkout,
        updateScopeRoot: workspace,
        updateSelf() { throw new Error('the shadowed host checkout must not be pulled from the workspace side'); },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.duplicateOfHost, true);
    // The exclusion the in-Box update receives is exactly the shadow's path.
    assert.equal(result.boxRepoPath, checkoutShadowMount(workspace, checkout).destination);
});

// A Box created before the host state mask existed.
function legacyHandle(identity, repositoryRoot) {
    const handle = handleFromCreateArgs(createArgs(identity, repositoryRoot));
    handle.runtime.mounts = handle.runtime.mounts.filter((mount) => mount.destination !== `${identity.workspaceRoot}/.ploinky-box`);
    return handle;
}

test('A8: a Box without the mask gets the existing incompatible guidance; stop and destroy still remove it', async (t) => {
    const base = scratch(t);
    const workspace = path.join(base, 'W');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const checkout = seedCheckout(path.join(base, 'ploinky'));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const old = legacyHandle(identity, checkout);
    assert.throws(() => validateContainerConfiguration(old, desiredFor(identity, checkout)),
        { message: `Owned Box mount set is incompatible${INCOMPATIBLE_BOX_GUIDANCE}` });
    let present = true;
    const calls = [];
    const runner = {
        run(_command, args) {
            calls.push(args.join(' '));
            if (args[1] === 'stop') old.runtime.running = false;
            if (args[1] === 'rm') present = false;
        },
    };
    const view = () => (present ? [{
        id: old.id, name: identity.instance, running: old.runtime.running, labels: old.labels,
        mounts: old.runtime.mounts.map(({ source, destination, rw }) => ({ type: 'bind', source, destination, rw })),
    }] : []);
    const engine = { name: 'podman', identity: 'engine' };
    const supervisor = () => createBoxSupervisor({
        // The real gate (macOS evidence with a quiet host) over the engine view.
        hostStateGuard: createHostStateGuard({
            repositoryRoot: checkout,
            observeEngine: view,
            gate: createQuiescenceGate({ platform: 'darwin', execFile: () => '', kill: () => {} }),
        }),
        resolveIdentity: () => identity,
        launchCwd: workspace,
        repositoryRoot: checkout,
        discover: () => (present ? { state: 'owned', engine, handles: { container: old } } : { state: 'absent', engine, handles: null }),
        runner,
        stdout: { write() {} },
        stderr: { write() {} },
    });
    // A configuring command gets the same guidance, before anything is
    // written into the workspace's host state.
    for (const invoke of [(box) => box.prepareBoxForCommand(), (box) => box.runStartTransaction(['start', 'explorer'])]) {
        await assert.rejects(invoke(supervisor()), {
            code: 'PLOINKY_BOX_PUBLICATION_INCOMPATIBLE',
            message: `Owned Box mount set is incompatible${INCOMPATIBLE_BOX_GUIDANCE}.${UNMASKED_BOX_RESIDUAL}`,
        });
    }
    assert.equal(calls.length, 0);
    assert.equal(readWorkspaceRecord(identity).state, 'absent');
    assert.equal((await supervisor().runStopTransaction()).action, 'stopped');
    const destroyed = await supervisor().runDestroyTransaction(old.id);
    assert.equal(destroyed.action, 'destroyed');
    assert.equal(present, false);
    assert.ok(calls.includes(`container rm -f ${old.id}`), calls.join('\n'));
    assert.equal(readWorkspaceRecord(identity).state, 'absent', 'stop and destroy never adopt the workspace');
});

// B2: an old, unmasked Box could write `.ploinky-box`. In-Box code plants a
// well-formed adoption record and a wildcard Router binding; the operator then
// follows the guidance (stop, destroy, start).
async function upgradeWorld(t, { stopStops = true } = {}) {
    const base = scratch(t);
    const workspace = path.join(base, 'W');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const checkout = seedCheckout(path.join(base, 'ploinky'));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const old = legacyHandle(identity, checkout);
    const lock = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: workspace });
    createRouterBindingStore().write(identity, { address: '0.0.0.0', hostPort: 18080 }, lock);
    lock.release();
    const paths = hostStatePaths(workspace);
    fs.writeFileSync(path.join(paths.root, 'workspace.json'),
        `${JSON.stringify({ schema: 'ploinky-box-workspace', version: 1, instance: identity.instance })}\n`, { mode: 0o600 });
    assert.equal(readWorkspaceRecord(identity).state, 'valid', 'the forged record is well formed');
    const state = { present: true, gateRuns: 0, inputs: [], notices: [], calls: [] };
    const runner = {
        run(_command, args) {
            state.calls.push(args.join(' '));
            if (args[1] === 'stop' && stopStops) old.runtime.running = false;
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
        discover: () => (state.present ? { state: 'owned', engine, handles: { container: old } } : { state: 'absent', engine, handles: null }),
        runner,
        readNetworkInterfaces: () => ({}),
        scanGpuAgents: () => [],
        selectAgentLib: async () => ({ selection: null }),
        reconcile: async (options) => {
            state.inputs.push(options.routerBinding);
            throw Object.assign(new Error('stop after reconcile input'), { code: 'FIXTURE_STOP' });
        },
        stdout: { write() {} },
        stderr: { write: (text) => state.notices.push(text) },
    });
    return { identity, old, paths, state, supervisor };
}

const liveEntries = (paths) => fs.readdirSync(paths.root).filter((name) => !['locks', 'empty', 'quarantine', 'tmp'].includes(name)).sort();

test('B2: destroying an unmasked Box quarantines a forged record, and the next start adopts behind the gate with loopback', async (t) => {
    const w = await upgradeWorld(t);
    const destroyed = await w.supervisor().runDestroyTransaction(w.old.id);
    assert.equal(destroyed.action, 'destroyed');
    assert.equal(destroyed.hostStateQuarantine.quarantined, true);
    assert.deepEqual([...destroyed.hostStateQuarantine.moved], ['router-bindings', 'workspace.json']);
    assert.deepEqual(liveEntries(w.paths), []);
    assert.equal(readWorkspaceRecord(w.identity).state, 'absent');
    await assert.rejects(w.supervisor().prepareBoxForCommand(), { code: 'FIXTURE_STOP' });
    assert.equal(w.state.gateRuns, 1, 'the next start adopted behind the gate');
    assert.deepEqual(w.state.inputs, [null], 'the forged wildcard binding is not honoured');
    assert.equal(readWorkspaceRecord(w.identity).state, 'valid');
});

test('B2: stopping an unmasked Box quarantines a forged record; a start still refuses that Box with the guidance', async (t) => {
    const w = await upgradeWorld(t);
    const stopped = await w.supervisor().runStopTransaction();
    assert.equal(stopped.action, 'stopped');
    assert.deepEqual([...stopped.hostStateQuarantine.moved], ['router-bindings', 'workspace.json']);
    assert.deepEqual(liveEntries(w.paths), []);
    await assert.rejects(w.supervisor().prepareBoxForCommand(), { code: 'PLOINKY_BOX_PUBLICATION_INCOMPATIBLE' });
    assert.equal(w.state.gateRuns, 0);
    assert.deepEqual(w.state.inputs, []);
});

test('B2: an unmasked Box that still runs after stop is not quarantined, and that is reported', async (t) => {
    const w = await upgradeWorld(t, { stopStops: false });
    const before = liveEntries(w.paths);
    const stopped = await w.supervisor().runStopTransaction();
    assert.deepEqual(stopped.hostStateQuarantine, { quarantined: false, reason: 'box-running' });
    assert.deepEqual(liveEntries(w.paths), before);
    assert.ok(w.state.notices.some((text) => text.includes('was not quarantined: the old Box') && text.includes('still runs')));
});

test('B2: a live bind source inside .ploinky-box is never moved by the stop-path quarantine', async (t) => {
    const w = await upgradeWorld(t);
    const store = path.join(w.paths.root, 'hardware-limits', w.identity.instance, 'store');
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
    // Another running container binds the store (an old Box never does; guard anyway).
    const guardOnly = createHostStateGuard({
        repositoryRoot: w.paths.root,
        observeEngine: () => [{ id: 'f'.repeat(64), name: 'other', running: true, labels: {}, mounts: [{ type: 'bind', source: store, destination: '/s', rw: true }] }],
        gate: { assert() {} },
        stderr: { write() {} },
    });
    const lock = await createMutationLockManager().acquire(w.identity.instance, { workspaceRoot: w.identity.workspaceRoot });
    w.old.runtime.running = false;
    const result = guardOnly.retireUnmaskedHostState(w.identity, lock, {
        container: w.old, observe: () => ({ state: 'owned', handles: { container: w.old }, engine: {} }),
    });
    lock.release();
    assert.deepEqual([...result.kept], ['hardware-limits']);
    assert.deepEqual([...result.moved], ['router-bindings', 'workspace.json']);
    assert.ok(fs.existsSync(store));
});

test('B3: the check before create admits the checkout parent self-binds exactly, and the Box workspace bind is still found', async (t) => {
    const { assertCreateArgsConfined, resolveBoxDataSources } = await import('../../ploinky-box/hostState/confinement.mjs');
    const { boxWorkspaceBindSource } = await import('../../ploinky-box/hostState/nested.mjs');
    const { workspace, checkout, identity } = qaLayout(t);
    const args = createArgs(identity, checkout);
    const { sources } = resolveBoxDataSources(identity, { repositoryRoot: checkout });
    assert.doesNotThrow(() => assertCreateArgsConfined(identity, args, { repositoryRoot: checkout, dataSources: sources }));
    for (const extra of [`${workspace}/.data:${workspace}/.data`, `${workspace}/.runtime:/elsewhere`, `${workspace}/.runtime/ploinky:${workspace}/.runtime/ploinky`]) {
        assert.throws(() => assertCreateArgsConfined(identity, [...args.slice(0, -1), '--volume', extra, args.at(-1)], { repositoryRoot: checkout, dataSources: sources }),
            { code: 'PLOINKY_BOX_DATA_PATH_ESCAPES' }, extra);
    }
    // Without the checkout inside the workspace, no self-bind is admitted.
    assert.throws(() => assertCreateArgsConfined(identity, args, { repositoryRoot: null, dataSources: sources }), { code: 'PLOINKY_BOX_DATA_PATH_ESCAPES' });
    const handle = handleFromCreateArgs(args);
    assert.equal(boxWorkspaceBindSource({ labels: { 'io.assistos.ploinky-box.role': 'box' }, mounts: handle.runtime.mounts }), workspace);
});

test('B2: stopping or destroying a masked Box leaves an adopted workspace\'s host state alone', async (t) => {
    const w = await upgradeWorld(t);
    const masked = handleFromCreateArgs(createArgs(w.identity, w.paths.root.replace(/\/W\/\.ploinky-box$/, '/ploinky')));
    w.old.runtime.mounts = masked.runtime.mounts;
    const before = liveEntries(w.paths);
    const stopped = await w.supervisor().runStopTransaction();
    assert.equal(stopped.hostStateQuarantine, null);
    const destroyed = await w.supervisor().runDestroyTransaction(w.old.id);
    assert.equal(destroyed.hostStateQuarantine, null);
    assert.deepEqual(liveEntries(w.paths), before);
});

test('B3: a checkout parent that turns into a link between resolution and inspection is refused, not bound', (t) => {
    const { workspace, checkout } = qaLayout(t);
    const parent = path.join(fs.realpathSync(workspace), '.runtime');
    const racing = {
        ...fs,
        lstatSync(target, ...rest) {
            const stat = fs.lstatSync(target, ...rest);
            return target === parent ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { isSymbolicLink: () => true }) : stat;
        },
    };
    assert.throws(() => checkoutShadowMount(workspace, checkout, { fsApi: racing }),
        { code: 'PLOINKY_BOX_CHECKOUT_ALIAS_INVALID', message: /above the Ploinky checkout is not a real directory/ });
});
