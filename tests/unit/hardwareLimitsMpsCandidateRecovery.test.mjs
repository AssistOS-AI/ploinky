import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeAppliedObservation, readAppliedObservation } from '../../cli/sandbox/hardwareLimits/runtimeState.mjs';
import { coordinateMpsLifecycle, trackMpsRuntimePending } from '../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs';
import { prepareMpsGraph } from '../../cli/sandbox/hardwareLimits/mpsGraph.mjs';
import { MpsError } from '../../cli/sandbox/hardwareLimits/mpsEligibility.mjs';

// Fix round 3, M1: a created share-client candidate whose readiness failed,
// or whose process died before readiness, is settled through its own exact
// tuple and immutable ID. The real coordinator, readiness tracking, runtime
// state and graph preparation run here; only the engine and daemon are fakes,
// and every cohort drain still passes the coordinator's registry check.
const uuid = 'GPU-12345678-1234-1234-1234-123456789012';
const share = (sm) => ({ smPercent: sm, vramPercent: sm, vramMiB: 1024 * sm / 25, memoryMiB: 1024 * sm / 25, memoryBytes: 1024 * sm / 25 * 1048576, deviceUuid: uuid, driverVersion: '595.91.07', wiringFingerprint: 'f'.repeat(64) });
const serverDefault = (sm) => ({ smPercent: sm, memoryMiB: 1024 * sm / 25, deviceUuid: uuid, driverVersion: '595.91.07', wiringFingerprint: 'f'.repeat(64) });
const oldId = 'a'.repeat(64), newId = 'c'.repeat(64), cpuId = 'd'.repeat(64);

function world(t, { policy = 50, journal = null } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-candidate-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const applied = path.join(root, 'applied');
    const X = { type: 'agent', repoName: 'repo', agentName: 'x', alias: '', instanceId: 'ix', enableGeneration: 'gx', containerId: oldId };
    const CPU = { type: 'agent', repoName: 'repo', agentName: 'cpu', instanceId: 'ic', enableGeneration: 'gc', containerId: cpuId };
    writeAppliedObservation({ key: 'x_key', containerId: oldId, instanceId: 'ix', enableGeneration: 'gx', limitsHash: 'e'.repeat(64), gpuShare: share(25), mpsGeneration: 'd0:c0' }, { root: applied });
    let state = journal || { schema: 1, status: 'ready', daemon: { pid: 9, startTime: '1' }, daemonGeneration: 'd0', configurationGeneration: 'c0',
        pipeDirectory: `/run/ploinky/mps/pipe-${'1'.repeat(32)}`, logDirectory: `/run/ploinky/mps/log-${'1'.repeat(32)}`, serverDefault: serverDefault(25), oldClients: [], pendingClients: [] };
    let alive = true; let generation = 0;
    const events = [];
    const live = new Set([oldId, cpuId]);
    const store = { read: () => structuredClone(state), write: (value) => { state = structuredClone(value); } };
    const backend = {
        observe: () => ({ state: alive ? 'owned' : 'gone', daemon: state.daemon }), verify: (value) => alive && Boolean(value?.daemon),
        stop: () => { events.push('quit'); alive = false; }, cleanup: () => events.push('cleanup'),
        start: (defaults, { onState }) => {
            generation += 1; events.push('start');
            const next = { ...state, daemon: { pid: 10 + generation, startTime: String(generation + 1) }, daemonGeneration: `d${generation}`, configurationGeneration: `c${generation}`, serverDefault: defaults,
                pipeDirectory: `/run/ploinky/mps/pipe-${String(generation + 1).repeat(32)}`, logDirectory: `/run/ploinky/mps/log-${String(generation + 1).repeat(32)}` };
            onState(next); alive = true; return { ...next, status: 'ready' };
        },
    };
    const registry = { x_key: X, cpu_key: CPU };
    // Engine fakes: an exact runtime is one that is live under its own ID.
    const removed = [];
    const exactById = (candidate) => (live.has(candidate.containerId) ? { state: 'exact', id: candidate.containerId, running: true } : { state: 'absent', id: null });
    const deps = {
        readContext: () => ({ gate: 'on', storeToken: null, overrides: new Map([['repo/x', { gpu: { smPercent: policy, vramPercent: policy } }]]), gpu: { grant: { mps: {} } } }),
        loadRegistry: () => structuredClone(registry), readApplied: (key, containerId) => readAppliedObservation(key, containerId, { root: applied }),
        loadPlan: () => ({ runtime: 'podman', image: 'img', profile: { network: { mode: 'default' } } }), prepareImage: () => {},
        inspectImage: () => ({ Id: `sha256:${'e'.repeat(64)}`, Config: { User: '1000:1000' } }),
        store, backend, network: async (callback) => callback({}), assertCapability: () => {}, observeClients: () => [], policyCheck: () => {},
        resolveShare: (value) => share(value.smPercent),
        // Called by the coordinator only after its registry identity check.
        drainClient: async (client) => { events.push(`drain:${client.containerId.slice(0, 4)}`); live.delete(client.containerId); },
        inspectCandidate: (candidate) => exactById(candidate),
        removeCandidate: (candidate) => { removed.push(candidate.containerId); live.delete(candidate.containerId); return { removed: true, state: 'removed' }; },
    };
    const graphDeps = {
        readContext: () => ({ gate: 'on', overrides: new Map([['repo/x', { gpu: { smPercent: policy, vramPercent: policy } }]]), storeToken: { epoch: '0'.repeat(32), revision: 1 }, gpu: {} }),
        loadRegistry: () => structuredClone(registry), readApplied: deps.readApplied, store,
        backend: { observe: () => ({ state: alive ? 'owned' : 'gone' }), verify: () => alive }, assertCapability: () => {}, observeClients: () => [],
        readSelection: () => ({ selector: { state: 'inactive' } }), resolveShare: (value) => share(value.smPercent), runtime: () => 'podman',
        inspect: (client) => exactById(client), inspectPresence: (client) => (live.has(client.containerId) ? { state: 'present', id: client.containerId } : { state: 'absent', id: null }),
        removeCandidate: (candidate) => { removed.push(candidate.containerId); live.delete(candidate.containerId); return { removed: true, state: 'removed' }; },
        drain: (key) => events.push(`graph-drain:${key}`),
    };
    const nodes = [{ key: 'x_key', node: { agentRef: 'repo/x', manifest: {} } }, { key: 'cpu_key', node: { agentRef: 'repo/cpu', manifest: {} } }];
    const target = { key: 'x_key', record: X };
    // The targeted reconcile: create (afterLaunch writes the per-key applied
    // observation), journal readiness, wait; a failed readiness removes the
    // candidate as cleanupFailedTargetedAgentRestart does.
    const failingLaunch = ({ cleanup = true } = {}) => async (next) => {
        live.add(newId);
        const launch = next.mpsLaunch;
        writeAppliedObservation({ key: 'x_key', containerId: newId, instanceId: 'ix', enableGeneration: 'gx', limitsHash: 'e'.repeat(64), gpuShare: share(policy), mpsGeneration: `d${generation}:c${generation}` }, { root: applied });
        trackMpsRuntimePending({ containerName: 'x_key', containerId: newId, registryRecord: { ...X } }, { mpsLaunch: launch, key: 'x_key' }, { store });
        if (cleanup) live.delete(newId);
        throw new Error('Readiness deadline expired.');
    };
    const succeedingLaunch = async () => { events.push('launch'); return { state: 'applied', key: 'x_key' }; };
    return { deps, graphDeps, nodes, target, events, removed, live, failingLaunch, succeedingLaunch, get state() { return state; }, registry, applied };
}
const run = (w, launchTarget) => coordinateMpsLifecycle({ target: w.target, options: { networkLifecycleCapability: {} }, launchTarget }, w.deps);
const candidates = (state) => (state.pendingClients || []).filter((entry) => entry.containerId === newId);

test('MC.readiness-failure-then-retry-succeeds', async (t) => {
    const w = world(t);
    await assert.rejects(run(w, w.failingLaunch()), /Readiness deadline expired/);
    assert.equal(candidates(w.state).length, 1, 'the created candidate is journaled with its exact identity');
    assert.equal(candidates(w.state)[0].phase, 'readiness');
    await run(w, w.succeedingLaunch);
    assert.equal(candidates(w.state).length, 0, 'the settled candidate leaves the journal');
    assert.deepEqual(w.removed, [], 'an absent candidate needs no removal');
    assert.equal(w.state.status, 'ready');
    assert.equal(w.state.oldClients.length, 0);
    // A further coordination is not wedged either.
    await run(w, w.succeedingLaunch);
    assert.equal(w.events.filter((value) => value === 'launch').length, 2);
});

test('MC.readiness-failure-leaving-the-candidate-removes-it-by-id', async (t) => {
    const w = world(t);
    await assert.rejects(run(w, w.failingLaunch({ cleanup: false })), /Readiness deadline expired/);
    assert.ok(w.live.has(newId));
    await run(w, w.succeedingLaunch);
    assert.deepEqual(w.removed, [newId]);
    assert.equal(w.live.has(newId), false);
    assert.equal(candidates(w.state).length, 0);
});

test('MC.non-exact-candidate-is-refused-without-daemon-change', async (t) => {
    const w = world(t);
    await assert.rejects(run(w, w.failingLaunch({ cleanup: false })), /Readiness deadline expired/);
    w.deps.inspectCandidate = (candidate) => ({ state: 'owned-drift', id: candidate.containerId, reason: 'runtime-identity' });
    const before = w.events.length;
    await assert.rejects(run(w, w.succeedingLaunch), { code: 'identity_changed' });
    assert.equal(candidates(w.state).length, 1, 'the journal keeps the unsettled candidate');
    assert.deepEqual(w.removed, []);
    assert.equal(w.events.slice(before).some((value) => ['quit', 'start', 'cleanup', 'launch'].includes(value)), false);
});

test('MC.crash-during-readiness-then-recovery', async (t) => {
    // The process died while the targeted candidate awaited readiness: the
    // journal is mid-transition, the candidate is still running and the
    // registry still names the predecessor.
    const journal = { schema: 1, status: 'transitioning', transitionId: 't', daemon: { pid: 9, startTime: '1' }, daemonGeneration: 'd0', configurationGeneration: 'c0',
        pipeDirectory: `/run/ploinky/mps/pipe-${'1'.repeat(32)}`, logDirectory: `/run/ploinky/mps/log-${'1'.repeat(32)}`, serverDefault: serverDefault(25),
        oldClients: [], desiredClients: [], drainedClients: [], lastProblem: null,
        pendingClients: [{ key: 'x_key', ref: 'repo/x', alias: '', instanceId: 'ix', enableGeneration: 'gx', containerId: newId, share: share(25), mpsGeneration: 'd0:c0', phase: 'readiness' }] };
    for (const path of ['coordinator', 'graph']) {
        const w = world(t, { policy: 25, journal: structuredClone(journal) });
        w.live.add(newId);
        writeAppliedObservation({ key: 'x_key', containerId: newId, instanceId: 'ix', enableGeneration: 'gx', limitsHash: 'e'.repeat(64), gpuShare: share(25), mpsGeneration: 'd0:c0' }, { root: w.applied });
        if (path === 'coordinator') {
            await run(w, w.succeedingLaunch);
            assert.equal(w.state.status, 'ready');
        } else {
            const result = await prepareMpsGraph({ nodes: w.nodes, networkLifecycleCapability: {} }, w.graphDeps);
            assert.equal(result.refusals, undefined, 'graph start is not refused');
        }
        assert.deepEqual(w.removed, [newId], `${path}: the exact candidate is removed by its ID`);
        assert.equal(candidates(w.state).length, 0, `${path}: its journal entry is dropped`);
    }
});

test('MC.graph-start-after-failed-apply-starts-cpu-agents', async (t) => {
    const w = world(t);
    await assert.rejects(run(w, w.failingLaunch()), /Readiness deadline expired/);
    const result = await prepareMpsGraph({ nodes: w.nodes, networkLifecycleCapability: {} }, w.graphDeps);
    assert.equal(result.refusals, undefined, JSON.stringify(result.refusals));
    assert.ok(result.graphPreparationId, 'the graph prepared normally');
    assert.equal(candidates(w.state).length, 0);
    assert.equal(w.events.includes('graph-drain:cpu_key'), false, 'the CPU-only agent is untouched');
});

// Fix round 3, M2: every pre-mutation MPS graph failure is a typed refusal of
// the graph's GPU-share agents only; CPU-only agents start, no daemon change.
function graphWorld(t, mutate, { policy = 25 } = {}) {
    const w = world(t, { policy });
    let writes = 0;
    const store = w.graphDeps.store;
    w.graphDeps.store = { read: () => store.read(), write: (value) => { writes += 1; store.write(value); } };
    w.graphDeps.backend = { observe: () => ({ state: 'owned' }), verify: () => true, stop: () => assert.fail('no daemon change'), start: () => assert.fail('no daemon change') };
    mutate(w);
    return { w, writes: () => writes };
}
const refusedOnlyGpu = async (label, g) => {
    const result = await prepareMpsGraph({ nodes: g.w.nodes, networkLifecycleCapability: {} }, g.w.graphDeps);
    assert.deepEqual(result.refusals.map((value) => value.key), ['x_key'], label);
    const refusal = result.refusals[0];
    assert.equal(refusal.code, 'PLOINKY_HARDWARE_LIMITS_UNENFORCEABLE', label);
    assert.ok(refusal.reason && refusal.fix, `${label}: reason and fix`);
    assert.equal(g.writes(), 0, `${label}: no journal or daemon change`);
    return result;
};
test('MG2.inventory-query-failure', async (t) => {
    await refusedOnlyGpu('inventory', graphWorld(t, (w) => { w.graphDeps.observeClients = () => { throw new MpsError('The complete MPS client inventory is unavailable'); }; }));
});
test('MG2.unknown-labelled-container', async (t) => {
    await refusedOnlyGpu('unknown label', graphWorld(t, (w) => { w.graphDeps.observeClients = () => { throw new MpsError('An MPS client is outside the exact registry and transition journal. Recover this Box on the host before changing its daemon.'); }; }));
});
test('MG2.journaled-non-member', async (t) => {
    const outsider = { key: 'gone_key', ref: 'repo/gone', alias: '', instanceId: 'ig', enableGeneration: 'gg', containerId: 'b'.repeat(64), share: share(25), mpsGeneration: 'd0:c0' };
    // Still running outside the graph: refused, never drained.
    const running = graphWorld(t, (w) => { w.live.add(outsider.containerId); const state = w.graphDeps.store.read(); w.graphDeps.store.write({ ...state, oldClients: [outsider] }); });
    await refusedOnlyGpu('non-member running', { w: running.w, writes: () => running.writes() - 1 });
    // Proven absent: drained, and the graph prepares normally.
    const absent = graphWorld(t, (w) => { const state = w.graphDeps.store.read(); w.graphDeps.store.write({ ...state, oldClients: [outsider] }); });
    const result = await prepareMpsGraph({ nodes: absent.w.nodes, networkLifecycleCapability: {} }, absent.w.graphDeps);
    assert.equal(result.refusals, undefined); assert.ok(result.graphPreparationId);
    // Already drained by an exact receipt: no inspection at all.
    const drained = graphWorld(t, (w) => { w.graphDeps.inspectPresence = () => assert.fail('a drained receipt needs no inspection'); const state = w.graphDeps.store.read(); w.graphDeps.store.write({ ...state, oldClients: [outsider], drainedClients: [[outsider.key, outsider.instanceId, outsider.enableGeneration, outsider.containerId].join('\0')] }); });
    assert.equal((await prepareMpsGraph({ nodes: drained.w.nodes, networkLifecycleCapability: {} }, drained.w.graphDeps)).refusals, undefined);
});
test('MG2.registry-drift', async (t) => {
    // The journal names x_key with an identity the registry no longer has,
    // and a changed default needs that predecessor drained.
    const g = graphWorld(t, (w) => { const state = w.graphDeps.store.read(); w.graphDeps.store.write({ ...state, oldClients: [{ key: 'x_key', ref: 'repo/x', alias: '', instanceId: 'stale', enableGeneration: 'stale', containerId: 'b'.repeat(64), share: share(25), mpsGeneration: 'd0:c0' }] }); }, { policy: 50 });
    const result = await refusedOnlyGpu('registry drift', { w: g.w, writes: () => g.writes() - 1 });
    assert.match(result.refusals[0].reason, /registry changed/);
});
test('MG2.alias-mismatch', async (t) => {
    const g = graphWorld(t, (w) => { const state = w.graphDeps.store.read(); w.graphDeps.store.write({ ...state, oldClients: [{ key: 'x_key', ref: 'repo/x', alias: 'other', instanceId: 'ix', enableGeneration: 'gx', containerId: oldId, share: share(25), mpsGeneration: 'd0:c0' }] }); });
    const result = await refusedOnlyGpu('alias mismatch', { w: g.w, writes: () => g.writes() - 1 });
    assert.equal(result.diagnostic.code, 'identity_changed');
});
test('MG2.transaction-checks-still-fail-the-start', async (t) => {
    const g = graphWorld(t, (w) => { w.graphDeps.readSelection = () => ({ selector: { state: 'active' } }); });
    await assert.rejects(prepareMpsGraph({ nodes: g.w.nodes, networkLifecycleCapability: {} }, g.w.graphDeps), /inactive selector/);
});
