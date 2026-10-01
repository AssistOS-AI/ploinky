import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import {
    authorityHelperPlacementFromContext,
    cleanupStaleLeaves,
    ensureAgentCgroupParents,
    helperPlacement,
    readDelegationState,
    verifyNestedBackend,
} from '../../cli/sandbox/hardwareLimits/delegation.mjs';
import { verifyBoxRuntime } from '../../ploinky-box/hardwareLimits/status.mjs';
import { admitManifestRuntimeCapabilities } from '../../cli/sandbox/runtimeCapabilities.js';
import { HARDWARE_UNENFORCEABLE } from '../../cli/sandbox/hardwareLimits/errors.mjs';
import {
    ROUTER_AUTHORITY_HELPER_IMAGE,
    runContainerAuthorityProbe,
} from '../../cli/sandbox/routerAuthorityAttestation.js';
import { FakeCgroupFs, preparedCgroupFs } from '../hardware-limits/fakeCgroupFs.mjs';

const ROOT = '/sys/fs/cgroup';
const ALL = ['cpu', 'memory', 'pids'];

function readyQuery(calls = []) {
    return (command, args, options) => {
        calls.push({ command, args, options });
        return { ok: true, stdout: JSON.stringify({ host: { ociRuntime: { name: 'crun' }, cgroupManager: 'cgroupfs' } }) };
    };
}

test('DG.no-aggregate-write', () => {
    const fake = preparedCgroupFs();
    const state = readDelegationState({ fsApi: fake, query: readyQuery() });
    assert.equal(state.backendReady, true);
    assert.ok(fake.writes.length > 0);
    for (const entry of fake.writes) {
        assert.match(entry.path, /^\/sys\/fs\/cgroup\/ploinky\/(agents|system)\/cgroup\.subtree_control$/);
        assert.match(entry.data, /^\+(cpu|memory|pids)$/);
    }
    for (const parent of ['/ploinky/agents', '/ploinky/system']) {
        const group = fake.groups.get(parent);
        assert.deepEqual([...group.values.keys()], [], `no aggregate limit file written in ${parent}`);
        assert.deepEqual([...group.subtree].sort(), ALL);
    }
    // Retry is idempotent: existing parents are kept, nothing aggregate appears.
    ensureAgentCgroupParents({ fsApi: fake, controllers: ALL });
    assert.equal(fake.writes.some((entry) => /memory\.(swap\.)?max|cpu\.max|pids\.max/.test(entry.path)), false);
});

test('DG.nonroot-parents', () => {
    const fake = preparedCgroupFs();
    assert.equal(fake.actorUid, 1000);
    readDelegationState({ fsApi: fake, query: readyQuery() });
    assert.deepEqual(fake.mkdirs.map((entry) => [entry.path, entry.uid]), [
        [`${ROOT}/ploinky/agents`, 1000],
        [`${ROOT}/ploinky/system`, 1000],
    ]);
    assert.equal(fake.lstatSync(`${ROOT}/ploinky/agents`).uid, 1000);
    assert.equal(fake.writes.some((entry) => !entry.path.startsWith(`${ROOT}/ploinky/`)), false, 'never writes namespace-root files');
    // Stale cleanup rmdirs only empty libpod-ID leaves whose IDs the engine no longer lists.
    const live = 'a'.repeat(64);
    const staleEmpty = 'b'.repeat(64);
    const staleBusy = 'c'.repeat(64);
    for (const id of [live, staleEmpty, staleBusy]) fake.addGroup(`/ploinky/agents/libpod-${id}`, { uid: 1000 });
    fake.addGroup('/ploinky/system/not-a-leaf', { uid: 1000 });
    fake.placePid(4321, `/ploinky/agents/libpod-${staleBusy}`);
    const cleaned = cleanupStaleLeaves({ fsApi: fake, liveIds: new Set([live]) });
    assert.deepEqual(cleaned.removed, [`${ROOT}/ploinky/agents/libpod-${staleEmpty}`]);
    assert.deepEqual(cleaned.retained, [{ leaf: `${ROOT}/ploinky/agents/libpod-${staleBusy}`, reason: 'not empty' }]);
    assert.ok(fake.groups.has(`/ploinky/agents/libpod-${live}`) && fake.groups.has('/ploinky/system/not-a-leaf'));
    assert.equal(fake.pidGroup.get(4321), `/ploinky/agents/libpod-${staleBusy}`, 'tasks are never killed or moved');
    // Parent-creation failure is reported as backend unavailable.
    const denied = preparedCgroupFs();
    denied.hooks.beforeMkdir = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const state = readDelegationState({ fsApi: denied, query: readyQuery() });
    assert.equal(state.structurallyPrepared, true);
    assert.equal(state.backendReady, false);
    assert.match(state.reason, /agent cgroup parents are unavailable/);
    assert.deepEqual(state.helperControllers, []);
});

test('DG.runtime-contexts', () => {
    const off = readDelegationState({ gate: 'off', fsApi: preparedCgroupFs(), query: readyQuery() });
    assert.deepEqual([off.structurallyPrepared, off.backendReady, off.reason], [false, false, 'hardware limits are off']);

    // The caller (core) is not in /ploinky/core: unprepared, with the host fix.
    const unprepared = new FakeCgroupFs();
    const notPlaced = readDelegationState({ fsApi: unprepared, query: readyQuery() });
    assert.equal(notPlaced.structurallyPrepared, false);
    assert.match(notPlaced.reason, /core placement is \/ .*not \/ploinky\/core/);
    assert.match(notPlaced.fix, /ploinky limits status.*ploinky restart/);

    // Structurally prepared but the nested backend is not verified.
    const unverified = readDelegationState({ fsApi: preparedCgroupFs(), query: null });
    assert.deepEqual([unverified.structurallyPrepared, unverified.backendReady], [true, false]);
    const calls = [];
    const runc = readDelegationState({
        fsApi: preparedCgroupFs(),
        query: (command, args) => {
            calls.push(args);
            return { ok: true, stdout: JSON.stringify({ host: { ociRuntime: { name: 'runc' }, cgroupManager: 'systemd' } }) };
        },
    });
    assert.equal(runc.backendReady, false);
    assert.match(runc.reason, /nested runtime runc with manager systemd/);
    assert.match(runc.fix, /verified crun and nested cgroupfs/);
    // The effective invocation is queried, not the configured default.
    assert.deepEqual(calls[0], ['--cgroup-manager=cgroupfs', 'info', '--format', 'json']);
    assert.equal(verifyNestedBackend({ query: () => ({ ok: false }) }).ready, false);
    assert.equal(verifyNestedBackend({ query: () => ({ ok: true, stdout: 'not json' }) }).ready, false);

    // Ready.
    const ready = readDelegationState({ fsApi: preparedCgroupFs(), query: readyQuery() });
    assert.deepEqual([ready.structurallyPrepared, ready.backendReady, ready.reason, ready.fix], [true, true, null, null]);
});

test('DG.outer-inspect-runtime', () => {
    assert.deepEqual(verifyBoxRuntime({ configuredRuntime: 'crun', inspectedRuntime: '' }).verified, false);
    assert.match(verifyBoxRuntime({ configuredRuntime: 'crun', inspectedRuntime: '' }).reason, /not recorded/);
    // A changed engine default never vouches for an existing Box's runtime.
    const runc = verifyBoxRuntime({ configuredRuntime: 'crun', inspectedRuntime: 'runc' });
    assert.equal(runc.verified, false);
    assert.equal(runc.observed, 'crun/runc');
    assert.equal(verifyBoxRuntime({ configuredRuntime: '', inspectedRuntime: '/usr/bin/crun' }).verified, true);
    assert.equal(verifyBoxRuntime({ configuredRuntime: 'runc', inspectedRuntime: 'crun' }).verified, true);
    assert.equal(verifyBoxRuntime({ configuredRuntime: 'crun', inspectedRuntime: 'krun' }).verified, false);
});

// Minimal authority-helper runtime: records every raw argv (including any
// engine prefix) and answers the probe protocol.
const HELPER_ID = 'e'.repeat(64);
const NETWORK = 'fixture-network';
const HOST_MAPPING = 'host.containers.internal:host-gateway';
const PLAN = Object.freeze({
    alias: 'fixture-agent',
    attachments: Object.freeze([{ name: NETWORK, primary: true }]),
    args: Object.freeze(['--network', NETWORK, '--network-alias', 'fixture-agent', '--add-host', HOST_MAPPING]),
});
const INTENT = Object.freeze({
    physicalOrigin: 'http://host.containers.internal:8080',
    requestAuthority: '127.0.0.1:18080',
    publicAuthority: '127.0.0.1:18080',
});
const NONCE = 'a'.repeat(64);

class HelperRuntime {
    constructor() {
        this.raw = [];
        this.events = [];
        this.container = null;
    }

    run(_command, rawArgs) {
        this.raw.push(rawArgs);
        const args = rawArgs[0] === '--cgroup-manager=cgroupfs' ? rawArgs.slice(1) : rawArgs;
        const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
        if (args[0] === 'image' && args[1] === 'inspect') {
            if (args.includes('{{.Config.User}}')) return ok('1000:1000');
            return ok(args.at(-1) === ROUTER_AUTHORITY_HELPER_IMAGE ? `sha256:${'d'.repeat(64)}` : `sha256:${'c'.repeat(64)}`);
        }
        if (args[0] === 'ps') return ok('');
        if (args[0] === 'create') {
            this.events.push('create');
            this.container = {
                id: HELPER_ID, name: args[args.indexOf('--name') + 1], created: new Date().toISOString(),
                image: `sha256:${'d'.repeat(64)}`, user: '65534:65534', entrypoint: ['node'], init: true,
                readonlyRootfs: true, pidsLimit: 32, memory: 64 * 1024 * 1024, nanoCpus: 250_000_000,
                networkMode: NETWORK, extraHosts: [HOST_MAPPING], mountCount: 0, bindCount: 0, tmpfsCount: 0,
                portBindingCount: 0, capDrop: ['ALL'], capAdd: [], securityOpt: ['no-new-privileges'],
                env: ['PATH=/usr/bin'], helperLabel: NONCE, networks: { [NETWORK]: {} }, running: false, status: 'created',
            };
            return ok(HELPER_ID);
        }
        if (args[0] === 'container' && args[1] === 'inspect') {
            if (!this.container) return { status: 1, stdout: '', stderr: 'absent' };
            return ok(JSON.stringify(this.container));
        }
        if (args[0] === 'container' && args[1] === 'exists') return this.container ? ok() : { status: 1, stdout: '', stderr: 'absent' };
        if (args[0] === 'start') {
            this.events.push('start');
            Object.assign(this.container, { running: true, status: 'running' });
            return ok();
        }
        if (args[0] === 'exec') {
            this.events.push('exec');
            return ok(JSON.stringify([
                { host: '127.0.0.1:18080', status: 401, body: '{"error":"fixture"}' },
                { host: 'host.containers.internal:8080', status: 421, body: '{"error":"UNKNOWN_HOST"}' },
            ]));
        }
        if (args[0] === 'stop') {
            this.events.push('stop');
            Object.assign(this.container, { running: false, status: 'exited' });
            return ok();
        }
        if (args[0] === 'rm') {
            this.events.push('rm');
            this.container = null;
            return ok();
        }
        throw new Error(`unexpected command ${args.join(' ')}`);
    }
}

function probeWith(placement, observeCompletedProbe) {
    const runtime = new HelperRuntime();
    const observe = observeCompletedProbe
        ? (info) => { runtime.events.push('observe'); observeCompletedProbe(info); }
        : null;
    runContainerAuthorityProbe({
        runtime: 'podman', plan: PLAN, image: 'example.invalid/agent@sha256:fixture', intent: INTENT, nonce: NONCE,
        commandRunner: runtime,
        registerObservation: () => runtime.events.push('register'),
        consumeObservation: () => { runtime.events.push('consume'); return []; },
        placement,
        observeCompletedProbe: observe,
    });
    return runtime;
}

function createArgv(runtime) {
    return runtime.raw.find((args) => args.includes('create'));
}

function placementForSubset(subset) {
    return authorityHelperPlacementFromContext({ gate: 'on', prepared: true, backendReady: true, controllers: subset });
}

test('DG.helper-complete-flags', () => {
    const unplaced = new HelperRuntime();
    try {
        runContainerAuthorityProbe({
            runtime: 'podman', plan: PLAN, image: 'x@sha256:f', intent: INTENT, nonce: NONCE, commandRunner: unplaced,
            registerObservation() {}, consumeObservation: () => [], placement: placementForSubset(['cpu', 'pids']),
        });
    } catch (_) { /* probe outcome is irrelevant here */ }
    const unplacedCreate = createArgv(unplaced);
    assert.equal(unplacedCreate[0], 'create', 'no engine prefix without placement');
    const at = unplacedCreate.indexOf('--pids-limit');
    assert.deepEqual(unplacedCreate.slice(at, at + 6), ['--pids-limit', '32', '--memory', '64m', '--cpus', '0.25']);
    assert.equal(unplacedCreate.some((arg) => String(arg).startsWith('--cgroup')), false);
    assert.equal(unplaced.raw.some((args) => args[0] === '--cgroup-manager=cgroupfs'), false);

    const placed = new HelperRuntime();
    try {
        runContainerAuthorityProbe({
            runtime: 'podman', plan: PLAN, image: 'x@sha256:f', intent: INTENT, nonce: NONCE, commandRunner: placed,
            registerObservation() {}, consumeObservation: () => [], placement: placementForSubset(ALL),
        });
    } catch (_) { /* probe outcome is irrelevant here */ }
    const placedCreate = createArgv(placed);
    assert.deepEqual(placedCreate.slice(0, 2), ['--cgroup-manager=cgroupfs', 'create']);
    const placedAt = placedCreate.indexOf('--pids-limit');
    assert.deepEqual(placedCreate.slice(placedAt, placedAt + 6), ['--pids-limit', '32', '--memory', '64m', '--cpus', '0.25']);
    for (const flag of ['--cgroups=enabled', '--cgroupns=private', '--cgroup-parent=/ploinky/system']) assert.ok(placedCreate.includes(flag), flag);
    // The helper never goes under /ploinky/agents and is never admitted as an agent.
    assert.equal(placedCreate.includes('--cgroup-parent=/ploinky/agents'), false);
    assert.equal(placedCreate.some((arg) => String(arg).startsWith('ploinky.limitshash=')), false);
    const start = placed.raw.find((args) => args.includes('start'));
    assert.equal(start[0], '--cgroup-manager=cgroupfs');
});

test('DG.helper-proof', () => {
    // Placed or not, the helper is proven against the same recorded values it was created with.
    for (const placement of [placementForSubset([]), placementForSubset(ALL)]) {
        const runtime = probeWith(placement);
        assert.deepEqual(runtime.events.slice(0, 2), ['create', 'start']);
        assert.ok(runtime.events.includes('rm'));
    }
    const source = fs.readFileSync(new URL('../../cli/sandbox/routerAuthorityAttestation.js', import.meta.url), 'utf8');
    assert.match(source, /'--pids-limit', '32', '--memory', '64m', '--cpus', '0\.25'/);
    assert.match(source, /Number\(inspected\?\.pidsLimit\) !== 32/);
    assert.match(source, /Number\(inspected\?\.memory\) !== 64 \* 1024 \* 1024/);
    assert.match(source, /Number\(inspected\?\.nanoCpus\) !== 250_000_000/);
    // A proof mismatch (e.g. a silently dropped memory limit) still fails closed.
    const runtime = new HelperRuntime();
    const run = runtime.run.bind(runtime);
    runtime.run = (command, args) => {
        const result = run(command, args);
        if (args.includes('create')) runtime.container.memory = 0;
        return result;
    };
    assert.throws(() => runContainerAuthorityProbe({
        runtime: 'podman', plan: PLAN, image: 'x@sha256:f', intent: INTENT, nonce: NONCE, commandRunner: runtime,
        registerObservation() {}, consumeObservation: () => [], placement: placementForSubset(ALL),
    }), /identity or confinement could not be proven/);
});

test('DG.helper-peak-after-probe-before-cleanup', () => {
    let observed = null;
    let eventsAtObservation = null;
    const runtime = probeWith(placementForSubset(ALL), (info) => {
        observed = info;
        eventsAtObservation = 'pending';
    });
    assert.equal(observed.helperId, HELPER_ID);
    assert.equal(observed.placement, 'enforced');
    assert.equal(eventsAtObservation, 'pending');
    const events = runtime.events;
    assert.ok(events.indexOf('exec') < events.indexOf('consume'));
    assert.ok(events.indexOf('consume') < events.indexOf('observe'));
    assert.ok(events.indexOf('observe') < events.indexOf('stop'));
    assert.ok(events.indexOf('observe') < events.indexOf('rm'));
    // Without placement the observation reports recorded, not enforced.
    let unplaced = null;
    probeWith(null, (info) => { unplaced = info; });
    assert.equal(unplaced.placement, 'recorded, not enforced');
});

function inBox(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-dg-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const markerPath = path.join(root, 'ploinky-box');
    fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
    return { boxMarkerOptions: { markerPath }, workspaceRoot: root };
}

const SUBSETS = Object.freeze({
    none: [],
    cpu: ['cpu'],
    memory: ['memory'],
    pids: ['pids'],
    'cpu-memory': ['cpu', 'memory'],
    'cpu-pids': ['cpu', 'pids'],
    'memory-pids': ['memory', 'pids'],
    'cpu-memory-pids': ['cpu', 'memory', 'pids'],
});
const RESOURCE_CASES = Object.freeze([
    { field: 'memory', controller: 'memory', resources: { memory: '512m' } },
    { field: 'cpus', controller: 'cpu', resources: { cpus: 0.5 } },
    { field: 'pidsLimit', controller: 'pids', resources: { pidsLimit: 128 } },
]);

for (const [name, subset] of Object.entries(SUBSETS)) {
    test(`DG.controllers.${name}`, (t) => {
        const fake = preparedCgroupFs({ controllers: subset });
        const state = readDelegationState({ fsApi: fake, query: readyQuery() });
        assert.equal(state.structurallyPrepared, true, 'structural readiness never depends on the controller set');
        assert.equal(state.backendReady, true);
        assert.deepEqual([...state.controllers].sort(), [...subset].sort());
        const placement = helperPlacement(state);
        assert.equal(placement.enforced, subset.length === 3, 'helper placement only with all three controllers');
        assert.equal(placement.status, subset.length === 3 ? 'enforced' : 'recorded, not enforced');
        // Per-resource admission follows the subset: each resource checks only its controller.
        const box = inBox(t);
        const hardwareContext = { gate: 'on', prepared: true, backendReady: true, controllers: state.controllers, storeState: 'valid' };
        for (const entry of RESOURCE_CASES) {
            const admission = admitManifestRuntimeCapabilities(
                { container: 'node:20-alpine', llmRuntime: { runtimePolicy: { resources: entry.resources } } },
                { ...box, agentId: `demo/${entry.field}`, runtime: 'podman', hardwareAdmission: 'metadata', hardwareContext },
            );
            const refused = admission.hardwareEligibility.state === 'refused';
            assert.equal(refused, !subset.includes(entry.controller), `${entry.field} with ${name}`);
            if (refused) {
                assert.equal(admission.hardwareEligibility.refusal.code, HARDWARE_UNENFORCEABLE);
                assert.equal(admission.hardwareEligibility.refusal.reasonCode, 'controller_unavailable');
            } else {
                assert.ok(admission.descriptor.hardwarePlacement, `${entry.field} placed with ${name}`);
            }
        }
    });
}

test('hardware prerequisite diagnostics list exact fixes for each missing prerequisite', async () => {
    const { hardwarePrerequisiteChecks } = await import('../../ploinky-box/diagnose/host.mjs');
    const ready = hardwarePrerequisiteChecks({ host: { cgroupVersion: 'v2', ociRuntime: { name: 'crun' }, cgroupControllers: ['cpu', 'memory', 'pids'] } }, { platform: 'linux' });
    assert.deepEqual(ready.map((check) => [check.id, check.status]), [
        ['host.hardware.cgroup', 'pass'], ['host.hardware.runtime', 'pass'], ['host.hardware.controllers', 'pass'],
    ]);
    const missing = hardwarePrerequisiteChecks({ host: { cgroupVersion: 'v1', ociRuntime: { name: 'runc' }, cgroupControllers: ['memory'] } }, { platform: 'linux' });
    assert.deepEqual(missing.map((check) => check.status), ['fail', 'fail', 'warn']);
    assert.match(missing[0].next, /writable cgroup v2 with nsdelegate/);
    assert.match(missing[1].next, /runtime="crun" in the \[engine\] section/);
    assert.match(missing[2].detail, /requesting cpu, pids limits will be refused; unrelated agents still start/);
    assert.match(missing[2].next, /Delegate=cpu memory pids.*daemon-reload alone does not change an existing session/s);
    const mac = hardwarePrerequisiteChecks({ host: { cgroupVersion: 'v2', ociRuntime: { name: 'crun' }, cgroupControllers: [] } }, { platform: 'darwin' });
    assert.match(mac[2].next, /inside podman machine ssh/);
});
