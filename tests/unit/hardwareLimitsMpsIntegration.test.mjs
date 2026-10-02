import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinateMpsLifecycle } from '../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs';
import { createMpsLaunch, readMpsLaunch, verifyMpsLaunch } from '../../cli/sandbox/hardwareLimits/mpsLaunch.mjs';
import { reconcileExactHardwareInstance } from '../../cli/sandbox/hardwareLimits/reconcile.mjs';

const imageId = 'a'.repeat(64);
const share = { smPercent: 25, vramPercent: 25, vramMiB: 1024, memoryMiB: 1024, memoryBytes: 1024 ** 3, deviceUuid: 'GPU-fixture', driverVersion: '550.1', wiringFingerprint: 'wiring' };
const defaults = (value) => ({ smPercent: value.smPercent, memoryMiB: value.memoryMiB, deviceUuid: value.deviceUuid, driverVersion: value.driverVersion, wiringFingerprint: value.wiringFingerprint });
const daemon = (value = share, generation = 'old') => ({ schema: 1, status: 'ready', daemon: { pid: 123 }, daemonGeneration: generation, configurationGeneration: 'config', pipeDirectory: `/run/ploinky/mps/pipe-${'a'.repeat(32)}`, serverDefault: defaults(value), pendingClients: [] });
const clone = (value) => structuredClone(value);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture({ old = true, nextShare = share, peer = false } = {}) {
    const events = [];
    const capability = {};
    const record = (name) => ({ type: 'agent', repoName: 'demo', agentName: name, instanceId: `i-${name}`, enableGeneration: `g-${name}`, containerId: (name === 'a' ? 'a' : 'b').repeat(64) });
    const registry = { a: record('a'), ...(peer ? { b: record('b') } : {}) };
    const policies = new Map(nextShare ? [['demo/a', { gpu: nextShare }], ...(peer ? [['demo/b', { gpu: share }]] : [])] : []);
    let state = old ? daemon() : null;
    const plans = () => ({ runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' });
    const dependencies = {
        observeClients: () => [],
        readContext: () => ({ storeToken: { epoch: 'e'.repeat(32), revision: 1 }, overrides: policies, gpu: { eligible: true, grant: { mps: {} } } }),
        loadRegistry: () => registry,
        readApplied: (key) => old ? { instanceId: registry[key].instanceId, enableGeneration: registry[key].enableGeneration, gpuShare: share, mpsGeneration: 'old:config' } : null,
        loadPlan: plans, prepareImage: () => events.push('prepare-image'), inspectImage: () => ({ Id: imageId, Config: { User: '1000:1000' } }),
        resolveShare: (policy) => policy, policyCheck: () => events.push('policy'),
        store: { read: () => clone(state), write: (value) => { state = clone(value); events.push(`journal:${value.status}`); } },
        backend: {
            observe: () => ({ state: state?.daemon ? 'owned' : 'gone' }), verify: () => true,
            stop: () => events.push('stop-daemon'), cleanup: () => events.push('cleanup-daemon'),
            start: (value) => { events.push('start-daemon'); return daemon(value, 'new'); },
        },
        network: async (fn) => { events.push('network-enter'); try { return await fn(capability); } finally { events.push('network-exit'); } },
        assertCapability: (value) => assert.equal(value, capability),
        drainClient: async (client) => { events.push(`drain:${client.key}`); },
        reconcile: async (captured, options) => { events.push(`reconcile:${captured.key}`); assert.equal(options.networkLifecycleCapability, capability); return { key: captured.key, state: 'applied' }; },
        beforePlan: (plan) => { events.push(`plan:${plan.action}`); },
    };
    const input = { target: { key: 'a', record: registry.a }, options: {}, launchTarget: async (options) => { const launch = readMpsLaunch(options.mpsLaunch, 'a', nextShare); events.push('launch:a'); assert.equal(launch.imageId, nextShare ? imageId : null); return { containerName: 'a', containerId: 'c'.repeat(64) }; } };
    return { events, registry, dependencies, input, state: () => state, policies };
}

test('MI.first share prepares immutable image before daemon and client', async () => {
    const f = fixture({ old: false });
    await coordinateMpsLifecycle(f.input, f.dependencies);
    assert.ok(f.events.indexOf('prepare-image') < f.events.indexOf('start-daemon'));
    assert.ok(f.events.indexOf('start-daemon') < f.events.indexOf('launch:a'));
    assert.equal(f.state().status, 'ready');
});
test('MI.default change awaits every drain before daemon stop and async recreate before completion', async () => {
    const f = fixture({ nextShare: { ...share, smPercent: 50 }, peer: true });
    const drain = deferred(); const ready = deferred();
    f.dependencies.drainClient = async ({ key }) => { f.events.push(`drain:${key}`); if (key === 'a') await drain.promise; };
    f.dependencies.reconcile = async ({ key }) => { f.events.push(`reconcile:${key}`); await ready.promise; f.events.push(`ready:${key}`); return { key, state: 'applied' }; };
    const running = coordinateMpsLifecycle(f.input, f.dependencies);
    await tick(); assert.equal(f.events.includes('stop-daemon'), false); assert.equal(f.events.includes('drain:b'), false);
    drain.resolve(); await tick();
    assert.ok(f.events.indexOf('drain:b') < f.events.indexOf('stop-daemon'));
    assert.equal(f.state().status, 'transitioning'); assert.equal(f.events.includes('network-exit'), false);
    ready.resolve(); await running; assert.equal(f.state().status, 'ready'); assert.ok(f.events.indexOf('ready:b') < f.events.indexOf('network-exit'));
});
test('MI.unchanged healthy generation does not drain or restart daemon', async () => {
    const f = fixture(); await coordinateMpsLifecycle(f.input, f.dependencies);
    assert.ok(f.events.includes('plan:reuse')); assert.equal(f.events.includes('drain:a'), false); assert.equal(f.events.includes('stop-daemon'), false); assert.equal(f.events.includes('start-daemon'), false);
});
test('MI.final clear drains old applied client and retires daemon before unshared launch', async () => {
    const f = fixture({ nextShare: null }); await coordinateMpsLifecycle(f.input, f.dependencies);
    assert.ok(f.events.indexOf('drain:a') < f.events.indexOf('stop-daemon')); assert.ok(f.events.indexOf('stop-daemon') < f.events.indexOf('launch:a'));
    assert.equal(f.events.includes('start-daemon'), false); assert.equal(f.state().status, 'inactive');
});
test('MI.invalid prepared image refuses before daemon mutation or launch', async () => {
    const f = fixture({ old: false }); f.dependencies.inspectImage = () => ({ Id: imageId, Config: { User: 'root' } });
    await assert.rejects(coordinateMpsLifecycle(f.input, f.dependencies), { code: 'PLOINKY_HARDWARE_LIMITS_UNENFORCEABLE' });
    assert.equal(f.events.includes('start-daemon'), false); assert.equal(f.events.includes('launch:a'), false);
});
test('MI.cancellation after asynchronous drain prevents daemon stop and retains pending journal', async () => {
    const f = fixture({ nextShare: { ...share, smPercent: 50 } }); let cancelled = false;
    f.input.options.isCancelled = () => cancelled;
    f.dependencies.drainClient = async () => { await tick(); cancelled = true; };
    await assert.rejects(coordinateMpsLifecycle(f.input, f.dependencies), /cancelled/);
    assert.equal(f.events.includes('stop-daemon'), false); assert.equal(f.state().status, 'pending'); assert.ok(f.state().pendingClients.length > 0);
});
test('MI.cohort expansion announced before first drain', async () => {
    const f = fixture({ nextShare: { ...share, smPercent: 50 }, peer: true });
    f.dependencies.beforePlan = (plan) => { assert.deepEqual(plan.expandedKeys, ['b']); assert.equal(f.events.some((entry) => entry.startsWith('drain:')), false); };
    await coordinateMpsLifecycle(f.input, f.dependencies);
});
test('MI.registry replacement during drain cannot be adopted by cohort recreate', async () => {
    const f = fixture({ nextShare: { ...share, smPercent: 50 }, peer: true });
    f.dependencies.drainClient = async ({ key }) => { if (key === 'b') { await tick(); f.registry.b = { ...f.registry.b, instanceId: 'replacement', enableGeneration: 'replacement' }; } };
    await assert.rejects(coordinateMpsLifecycle(f.input, f.dependencies), /identity|changed/);
    assert.equal(f.events.includes('reconcile:b'), false);
});
test('MI.launch rejects wrong key share and new daemon generation', () => {
    const state = daemon(); const launch = createMpsLaunch({ key: 'a', share, state, imageId });
    assert.throws(() => readMpsLaunch(launch, 'b', share), /identity/);
    assert.throws(() => readMpsLaunch(launch, 'a', { ...share, smPercent: 50 }), /share/);
    assert.throws(() => verifyMpsLaunch(launch, 'a', share, { store: { read: () => daemon(share, 'replacement') }, backend: { verify: () => true } }), /generation/);
});
test('MI.launch captures immutable generation rather than caller mutable state', () => {
    const state = daemon(); const launch = createMpsLaunch({ key: 'a', share: clone(share), state, imageId });
    state.daemonGeneration = 'replacement';
    assert.throws(() => verifyMpsLaunch(launch, 'a', share, { store: { read: () => state }, backend: { verify: () => true } }), /generation/);
});

test('MI.actual reconciliation awaits ensure and readiness before activation', async () => {
    const events = []; const record = { type: 'agent', repoName: 'demo', agentName: 'a', instanceId: 'i', enableGeneration: 'g', containerId: 'a'.repeat(64) }; const ready = deferred();
    const token = createMpsLaunch({ key: 'a', share: null });
    const running = reconcileExactHardwareInstance({ key: 'a', record }, { mpsLaunch: token }, {
        loadRegistry: () => ({ a: record }), loadRouting: () => ({ routes: {} }), policyCheck: () => {},
        loadPlan: () => ({ runtime: 'podman', runtimeAdmission: { descriptor: {} }, profileResolution: {}, manifest: {}, agentPath: '/fixture', routerEndpoint: null }),
        maintenance: async (_key, _options, callback) => callback(), network: async (callback) => callback({}),
        ensure: async (_name, _manifest, _path, options) => { assert.equal(options.mpsLaunch, token); await tick(); events.push('ensure-done'); return { containerName: 'a', containerId: 'b'.repeat(64), registryRecord: record }; },
        readiness: async () => { events.push('readiness'); await ready.promise; }, activate: async () => events.push('activate'),
        cleanupPrepared: () => events.push('cleanup'),
    });
    await tick(); await tick(); assert.deepEqual(events, ['ensure-done', 'readiness']); ready.resolve();
    const result = await running; assert.equal(result.state, 'applied'); assert.deepEqual(events, ['ensure-done', 'readiness', 'activate']);
});

import { prepareTargetedAgentRestart } from '../../cli/commands/targetedAgentRestart.js';
test('MI.real route withdrawal preserves exact predecessor identity for MPS drain', async () => {
    const record = { type: 'agent', repoName: 'demo', agentName: 'a', instanceId: 'i', enableGeneration: 'g', containerId: 'a'.repeat(64) };
    const routing = { routes: { a: { container: 'a', repo: 'demo', agent: 'a' } } };
    const active = { selector: { state: 'active', generation: 'gen', activationId: 'activate', selectorDigest: 'digest' }, generation: { agents: { a: record }, routing, compiled: { hosts: {} } } };
    const before = clone(record);
    const transition = await prepareTargetedAgentRestart({ containerName: 'a', routeKey: 'a', record }, { mergeRouting: async (mutate) => mutate(routing), loadActive: () => active, loadAgents: () => ({ a: record }) });
    assert.deepEqual(record, before); assert.deepEqual(transition.identity, { instanceId: 'i', enableGeneration: 'g' });
    assert.equal(routing.routes.a.draining, true); assert.equal(transition.targetedRestart.assertSelectorsInactive({ containerName: 'a', affectedSelectors: transition.targetedRestart.affectedSelectors }), true);
});
test('MI.changed policy after drain prevents any daemon mutation', async () => {
    const f = fixture({ nextShare: { ...share, smPercent: 50 } }); let changed = false;
    f.dependencies.policyCheck = () => { if (changed) throw Object.assign(new Error('policy changed'), { code: 'revision_conflict' }); };
    f.dependencies.drainClient = async () => { await tick(); changed = true; };
    await assert.rejects(coordinateMpsLifecycle(f.input, f.dependencies), { code: 'revision_conflict' });
    assert.equal(f.events.includes('stop-daemon'), false); assert.equal(f.state().status, 'pending');
});
test('MI.launch rejects missing immutable image and insufficient changed defaults', () => {
    assert.throws(() => createMpsLaunch({ key: 'a', share, state: daemon(), imageId: 'mutable:tag' }), /immutable/);
    const state = daemon(); const launch = createMpsLaunch({ key: 'a', share, state, imageId });
    assert.throws(() => verifyMpsLaunch(launch, 'a', share, { store: { read: () => ({ ...state, serverDefault: { ...state.serverDefault, smPercent: 1 } }) }, backend: { verify: () => true } }), /defaults/);
});

test('MI.authorization loss after awaited drain aborts before daemon mutation as a control error', async () => {
    const f = fixture({ nextShare: { ...share, smPercent: 50 } }); let authorized = true;
    f.input.options.authorize = () => authorized;
    f.dependencies.drainClient = async () => { await tick(); authorized = false; };
    await assert.rejects(coordinateMpsLifecycle(f.input, f.dependencies), { code: 'identity_changed' });
    assert.equal(f.events.includes('stop-daemon'), false);
    assert.equal(f.events.includes('launch:a'), false);
});

test('MI.p7-peer-ineligible-image-or-missing-manifest-never-refuses-the-target', async () => {
    const peerShare = { ...share };
    for (const [label, change] of [
        ['peer image runs as root', (f) => { f.dependencies.inspectImage = (image) => image === 'peer:tag' ? { Id: 'd'.repeat(64), Config: { User: '0' } } : { Id: imageId, Config: { User: '1000:1000' } }; f.dependencies.loadPlan = (ref) => ({ runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: ref === 'demo/b' ? 'peer:tag' : 'prepared:tag' }); }],
        ['peer manifest removed', (f) => { f.dependencies.loadPlan = (ref) => { if (ref === 'demo/b') throw new Error('Agent demo/b not found'); return { runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' }; }; }],
    ]) {
        const f = fixture({ nextShare: peerShare, peer: true });
        change(f);
        await coordinateMpsLifecycle(f.input, f.dependencies);
        assert.ok(f.events.includes('launch:a'), `${label}: ${f.events.join(' ')}`);
    }
});

// One coordination's per-agent outcomes, through the real coordinator and,
// for Apply, the real applyHardwareLimits. Only the engine, daemon, registry
// and route publication are fakes; drains pass the registry identity check.
import { applyHardwareLimits } from '../../cli/sandbox/hardwareLimits/reconcile.mjs';
import { findHardwareOutcome } from '../../cli/sandbox/hardwareLimits/errors.mjs';
import { MpsError } from '../../cli/sandbox/hardwareLimits/mpsEligibility.mjs';
import { readMpsStatus } from '../../cli/sandbox/hardwareLimits/mpsStatus.mjs';
const cohortShare = (smPercent = 25) => ({ ...share, smPercent, vramPercent: smPercent });
function cohortWorld({ keys = ['a', 'b', 'c'], nextSm = 50, fail = {}, peerPlan = null, inspectImage = null } = {}) {
    const token = { epoch: 'e'.repeat(32), revision: 1 };
    let counter = 16;
    const record = (key) => ({ type: 'agent', repoName: 'demo', agentName: key, instanceId: `i-${key}-${counter}`, enableGeneration: `g-${key}-${counter}`, containerId: (counter++).toString(16).padStart(64, '0') });
    const registry = Object.fromEntries(keys.map((key) => [key, record(key)]));
    const applied = Object.fromEntries(keys.map((key) => [key, { ...registry[key], gpuShare: cohortShare(), mpsGeneration: 'd0:c0' }]));
    const policies = new Map(keys.map((key) => [`demo/${key}`, { gpu: cohortShare(key === keys[0] ? nextSm : 25) }]));
    let state = { ...daemon(cohortShare(), 'd0'), configurationGeneration: 'c0', oldClients: [], drainedClients: [] };
    let daemons = 0; let alive = true;
    const events = []; const unavailable = [];
    const replace = (key, launch) => {
        events.push(`create:${key}`);
        if (fail[key]) { const make = fail[key]; if (make.once) delete fail[key]; throw make(); }
        const next = record(key); registry[key] = next;
        applied[key] = { ...next, gpuShare: clone(launch.share), mpsGeneration: `${launch.state.daemonGeneration}:${launch.state.configurationGeneration}` };
        return { key, state: 'applied', containerId: next.containerId };
    };
    const dependencies = {
        observeClients: () => [], readContext: () => ({ storeToken: token, overrides: policies, gpu: { grant: { mps: {} } } }),
        loadRegistry: () => clone(registry), readApplied: (key, containerId) => (applied[key]?.containerId === containerId ? clone(applied[key]) : null),
        loadPlan: peerPlan || (() => ({ runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' })),
        prepareImage: () => {}, inspectImage: inspectImage || (() => ({ Id: imageId, Config: { User: '1000:1000' } })), resolveShare: (policy) => policy, policyCheck: () => {},
        store: { read: () => clone(state), write: (value) => { state = clone(value); } },
        backend: {
            observe: () => ({ state: alive ? 'owned' : 'gone', daemon: state.daemon }), verify: (value) => alive && Boolean(value?.daemon),
            stop: () => { events.push('quit'); alive = false; }, cleanup: () => events.push('cleanup'),
            start: (value) => { daemons += 1; events.push('start'); alive = true; return { ...daemon(value, `d${daemons}`), configurationGeneration: `c${daemons}` }; },
        },
        network: async (fn) => fn({}), assertCapability: () => {},
        drainClient: async (client) => { events.push(`drain:${client.key}`); },
        reconcile: async (captured, options) => replace(captured.key, readMpsLaunch(options.mpsLaunch, captured.key, policies.get(`demo/${captured.key}`).gpu)),
        markUnavailable: async (outcome) => { unavailable.push(outcome.key); },
    };
    const coordinate = (key, options = {}) => coordinateMpsLifecycle({ target: { key, record: clone(registry[key]) }, options,
        launchTarget: async (next) => replace(key, readMpsLaunch(next.mpsLaunch, key, policies.get(`demo/${key}`).gpu)) }, dependencies);
    const apply = (containers) => applyHardwareLimits({ expectedToken: token, containers }, {
        lease: (_options, callback) => callback(), loadRegistry: () => clone(registry), loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => {},
        loadPlan: () => ({}), isUnchanged: () => false,
        onPlan: (plan) => events.push(`plan:${plan.expandedContainers.join(',')}`),
        reconcile: (instance, options) => coordinate(instance.key, { onMpsPlan: options.onMpsPlan, onMpsResult: options.onMpsResult }),
    });
    return { events, registry, unavailable, coordinate, apply, policies, get state() { return state; } };
}

test('MI.peer-failure-is-a-partial-result-and-apply-reports-207', async () => {
    for (const [label, make] of [['generic readiness error', () => new Error('Readiness deadline expired.')], ['MPS error', () => new MpsError('MPS daemon generation or defaults changed before runtime admission')]]) {
        const direct = cohortWorld({ fail: { b: make } });
        let thrown;
        await assert.rejects(direct.coordinate('a'), (error) => { thrown = error; return true; });
        assert.equal(thrown.code, 'mps_partial_failure', label);
        assert.equal(findHardwareOutcome(thrown), null, `${label}: the peer's failure is never the target's refusal`);
        assert.equal(thrown.targetResult.state, 'applied', `${label}: the target was recreated`);
        assert.deepEqual(thrown.mpsTransitionResults.map((value) => [value.key, value.state]), [['a', 'applied'], ['b', 'pending'], ['c', 'applied']]);
        // Apply: the target is applied, the peer pending, and the status is 207.
        const f = cohortWorld({ fail: { b: make } });
        const result = await f.apply(['a']);
        assert.equal(result.status, 207, label);
        assert.deepEqual(result.results.map((value) => [value.key, value.state, value.problem ? value.problem.key : null]), [['a', 'applied', null], ['b', 'pending', null], ['c', 'applied', null]], label);
        assert.deepEqual(result.pendingContainers, ['b'], label);
        assert.equal(result.error, undefined, label);
    }
});

test('MI.ineligible-peer-is-refused-reported-before-drain-and-journaled', async () => {
    for (const [label, peerPlan, inspect] of [
        ['peer image runs as root', null, (image) => (image === 'peer:tag' ? { Id: 'd'.repeat(64), Config: { User: '0' } } : { Id: imageId, Config: { User: '1000:1000' } })],
        ['peer manifest removed', (ref) => { if (ref === 'demo/b') throw new Error('Agent demo/b not found'); return { runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' }; }, null],
    ]) {
        const f = cohortWorld({ keys: ['a', 'b'], inspectImage: inspect,
            peerPlan: peerPlan || ((ref) => ({ runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: ref === 'demo/b' ? 'peer:tag' : 'prepared:tag' })) });
        const result = await f.apply(['a']);
        assert.equal(result.status, 207, label);
        const peer = result.results.find((value) => value.key === 'b');
        assert.equal(peer.state, 'refused', label);
        assert.ok(peer.problem.reason && peer.problem.fix, `${label}: the peer's own reason and fix`);
        assert.equal(peer.problem.key, 'b');
        assert.equal(result.results.find((value) => value.key === 'a').state, 'applied', label);
        assert.deepEqual(result.expandedContainers, ['b'], `${label}: listed in the expansion`);
        const firstDrain = f.events.findIndex((value) => value.startsWith('drain:'));
        assert.ok(f.events.findIndex((value) => value === 'plan:b') >= 0 && f.events.findIndex((value) => value === 'plan:b') < firstDrain, `${label}: expansion reported before the first drain: ${f.events.join(' ')}`);
        assert.deepEqual(f.unavailable, ['b'], `${label}: its routes are marked unavailable`);
        assert.deepEqual(f.state.pendingClients.map((value) => [value.key, value.phase]), [['b', 'pending']], `${label}: it stays journaled`);
        assert.equal(f.state.lastProblem.code, 'mps_client_failed');
    }
});

// §11.3 "Healthy daemon, unchanged default: reuse it": after one client was
// not recreated, a retry recreates only that client and never restarts the
// healthy cohort or its daemon.
test('MI.retry-recreates-only-the-failed-client', async () => {
    const f = cohortWorld({ fail: { b: Object.assign(() => new Error('Readiness deadline expired.'), { once: true }) } });
    await assert.rejects(f.coordinate('a'), { code: 'mps_partial_failure' });
    const healthy = { a: f.registry.a.containerId, c: f.registry.c.containerId };
    const offset = f.events.length;
    await f.coordinate('b');
    assert.deepEqual(f.events.slice(offset), ['create:b'], f.events.slice(offset).join(' '));
    assert.deepEqual({ a: f.registry.a.containerId, c: f.registry.c.containerId }, healthy);
    assert.equal(f.state.status, 'ready');
    assert.deepEqual(f.state.pendingClients, []);
    assert.deepEqual(f.state.oldClients, []);
});

test('MI.watchdog-retries-of-a-failing-client-cause-no-healthy-churn', async () => {
    const f = cohortWorld({ fail: { b: () => new Error('Readiness deadline expired.') } });
    await assert.rejects(f.coordinate('a'), { code: 'mps_partial_failure' });
    const healthy = { a: f.registry.a.containerId, c: f.registry.c.containerId };
    const daemonGeneration = f.state.daemonGeneration;
    // The watchdog's not_running restarts of b, each through the coordinator.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const offset = f.events.length;
        await assert.rejects(f.coordinate('b', { origin: 'cli' }), /Readiness deadline expired/);
        assert.deepEqual(f.events.slice(offset), ['create:b'], `attempt ${attempt}: ${f.events.slice(offset).join(' ')}`);
    }
    assert.deepEqual({ a: f.registry.a.containerId, c: f.registry.c.containerId }, healthy, 'healthy clients are never recreated');
    assert.equal(f.state.daemonGeneration, daemonGeneration, 'the daemon is never restarted');
    // The daemon the monitor observes stays ready, so healthy clients are not restarted either.
    const status = readMpsStatus({ workspaceRoot: '/w', readGrant: () => ({ valid: true, state: 'active', mps: {}, fingerprint: share.wiringFingerprint }),
        observeGpu: () => ({ uuid: share.deviceUuid, driverVersion: share.driverVersion, memoryModel: 'dedicated', name: 'RTX', memoryMiB: 8192 }),
        readState: () => f.state, backend: { observe: () => ({ state: 'owned' }), verify: () => true } });
    assert.equal(status.daemonStatus, 'ready');
    assert.equal(status.mpsGeneration, `${f.state.daemonGeneration}:${f.state.configurationGeneration}`);
});

test('MI.graph-start-after-client-only-failure-keeps-the-daemon', async () => {
    const { prepareMpsGraph } = await import('../../cli/sandbox/hardwareLimits/mpsGraph.mjs');
    const f = cohortWorld({ fail: { b: () => new Error('Readiness deadline expired.') } });
    await assert.rejects(f.coordinate('a'), { code: 'mps_partial_failure' });
    const journal = clone(f.state);
    let state = clone(journal);
    const drained = [];
    const result = await prepareMpsGraph({ nodes: ['a', 'b', 'c'].map((key) => ({ key, node: { agentRef: `demo/${key}`, manifest: {} } })), networkLifecycleCapability: {} }, {
        readContext: () => ({ gate: 'on', overrides: f.policies, storeToken: { epoch: '0'.repeat(32), revision: 1 }, gpu: {} }),
        loadRegistry: () => clone(f.registry), readApplied: (key, containerId) => (f.registry[key]?.containerId === containerId && key !== 'b' ? { instanceId: f.registry[key].instanceId, enableGeneration: f.registry[key].enableGeneration, gpuShare: f.policies.get(`demo/${key}`).gpu, mpsGeneration: `${journal.daemonGeneration}:${journal.configurationGeneration}` } : null),
        store: { read: () => clone(state), write: (value) => { state = clone(value); } },
        backend: { observe: () => ({ state: 'owned' }), verify: () => true }, assertCapability: () => {}, observeClients: () => [],
        readSelection: () => ({ selector: { state: 'inactive' } }), resolveShare: (policy) => policy, runtime: () => 'podman',
        inspect: (client) => ({ state: 'exact', id: client.containerId, running: true }), inspectPresence: () => ({ state: 'absent', id: null }),
        drain: (key) => drained.push(key),
    });
    assert.equal(result.refusals, undefined);
    assert.equal(state.graphNeedsTransition, false, 'the verified daemon with only a failed client is reused');
    assert.deepEqual(drained, [], 'no healthy client is drained');
    assert.deepEqual([...result.replacedKeys], ['b'], 'only the client that was not recreated is replaced');
});

// A drained peer whose manifest no longer resolves goes through the REAL
// drain composition (no injected drainClient): it is retired only from its
// recorded identity, observed through fake low-level engine replies.
import { NETWORK_LABELS, workspaceNetworkIdentity } from '../../cli/sandbox/networkLifecycle.js';
function recordedPeerWorld({ labels = {}, init = true, healthyPeer = false, unprovableSecondPeer = false, cancelAfter = null } = {}) {
    const token = { epoch: 'e'.repeat(32), revision: 1 };
    const bId = 'b'.repeat(64);
    const registry = {
        b: { type: 'agent', repoName: 'demo', agentName: 'b', runtime: 'podman', instanceId: 'i-b', enableGeneration: 'g-b', containerId: bId },
        z: { type: 'agent', repoName: 'demo', agentName: 'z', runtime: 'podman', instanceId: 'i-z', enableGeneration: 'g-z', containerId: 'f'.repeat(64) },
    };
    // An optional healthy old client 'a' that sorts before b: it must not be
    // drained when b cannot be proven, so b is drained first.
    if (healthyPeer) registry.a = { type: 'agent', repoName: 'demo', agentName: 'a', runtime: 'podman', instanceId: 'i-a', enableGeneration: 'g-a', containerId: 'a'.repeat(64) };
    // An optional second peer c, whose manifest is also gone and whose
    // recorded runtime cannot be proven: it sorts after b.
    const cId = 'c'.repeat(64);
    if (unprovableSecondPeer) registry.c = { type: 'agent', repoName: 'demo', agentName: 'c', runtime: 'podman', instanceId: 'i-c', enableGeneration: 'g-c', containerId: cId };
    const applied = { b: { ...registry.b, gpuShare: cohortShare(25), mpsGeneration: 'd0:c0' }, ...(healthyPeer ? { a: { ...registry.a, gpuShare: cohortShare(25), mpsGeneration: 'd0:c0' } } : {}), ...(unprovableSecondPeer ? { c: { ...registry.c, gpuShare: cohortShare(25), mpsGeneration: 'd0:c0' } } : {}) };
    // z takes a first share above the current default: a cohort restart whose
    // only old client is the peer b, whose manifest is gone.
    const policies = new Map([['demo/z', { gpu: cohortShare(50) }], ['demo/b', { gpu: cohortShare(25) }], ...(healthyPeer ? [['demo/a', { gpu: cohortShare(25) }]] : []), ...(unprovableSecondPeer ? [['demo/c', { gpu: cohortShare(25) }]] : [])]);
    let state = { ...daemon(cohortShare(), 'd0'), configurationGeneration: 'c0', oldClients: [], drainedClients: [] };
    let alive = true; let running = true;
    const events = []; const engine = []; const unavailable = []; const results = [];
    const containerLabels = {
        [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'agent', [NETWORK_LABELS.schema]: '2',
        [NETWORK_LABELS.workspace]: workspaceNetworkIdentity().hash, [NETWORK_LABELS.contract]: 'c'.repeat(64),
        [NETWORK_LABELS.instanceId]: 'i-b', [NETWORK_LABELS.enableGeneration]: 'g-b', 'ploinky.mpsgeneration': 'd0:c0', ...labels,
    };
    const engineRun = (runtime, args) => {
        engine.push([runtime, ...args].join(' '));
        if (args[0] === 'container' && args[1] === 'inspect' && args[2] === bId) {
            return { ok: true, status: 0, stdout: JSON.stringify([{ Id: bId, Config: { Labels: containerLabels }, HostConfig: { Init: init }, State: { Running: running } }]), stderr: '' };
        }
        if (args[0] === 'container' && args[1] === 'stop' && args.at(-1) === bId) { running = false; events.push('stop:b'); return { ok: true, status: 0, stdout: '', stderr: '' }; }
        // c's runtime carries none of the recorded labels: not provable.
        if (args[0] === 'container' && args[1] === 'inspect' && args[2] === cId) {
            return { ok: true, status: 0, stdout: JSON.stringify([{ Id: cId, Config: { Labels: {} }, HostConfig: { Init: true }, State: { Running: true } }]), stderr: '' };
        }
        return { ok: false, status: 125, stdout: '', stderr: 'no such container' };
    };
    const dependencies = {
        observeClients: () => [], readContext: () => ({ storeToken: token, overrides: policies, gpu: { grant: { mps: {} } } }),
        loadRegistry: () => clone(registry), readApplied: (key, containerId) => (applied[key]?.containerId === containerId ? clone(applied[key]) : null),
        loadPlan: (ref) => { if (ref === 'demo/b' || ref === 'demo/c') throw new Error(`Agent ${ref} not found`); return { runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' }; },
        prepareImage: () => {}, inspectImage: () => ({ Id: imageId, Config: { User: '1000:1000' } }), resolveShare: (policy) => policy, policyCheck: () => {},
        store: { read: () => clone(state), write: (value) => { state = clone(value); } },
        backend: {
            observe: () => ({ state: alive ? 'owned' : 'gone', daemon: state.daemon }), verify: (value) => alive && Boolean(value?.daemon),
            stop: () => { events.push('quit'); alive = false; }, cleanup: () => events.push('cleanup'),
            start: (value) => { events.push('start'); alive = true; return { ...daemon(value, 'd1'), configurationGeneration: 'c1' }; },
        },
        network: async (fn) => fn({}), assertCapability: () => {},
        markUnavailable: async (outcome) => { unavailable.push(outcome.key); events.push(`unavailable:${outcome.key}`); },
        engineRun,
    };
    const launchTarget = async (next) => { readMpsLaunch(next.mpsLaunch, 'z', policies.get('demo/z').gpu); events.push('launch:z'); return { key: 'z', state: 'applied', containerId: 'e'.repeat(64) }; };
    const apply = () => applyHardwareLimits({ expectedToken: token, containers: ['z'] }, {
        lease: (_options, callback) => callback(), loadRegistry: () => clone(registry), loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => {},
        loadPlan: () => ({}), isUnchanged: () => false, onPlan: (plan) => events.push(`plan:${plan.expandedContainers.join(',')}`),
        onResult: (value) => results.push(value),
        reconcile: (instance, options) => coordinateMpsLifecycle({ target: { key: instance.key, record: clone(registry[instance.key]) }, options: { onMpsPlan: options.onMpsPlan, onMpsResult: options.onMpsResult, ...(cancelAfter ? { isCancelled: () => events.includes(cancelAfter) } : {}) }, launchTarget }, dependencies),
    });
    return { apply, events, engine, unavailable, results, get state() { return state; } };
}

test('MI.missing-manifest-peer-is-retired-by-its-recorded-identity', async () => {
    const f = recordedPeerWorld();
    const result = await f.apply();
    assert.equal(result.status, 207, JSON.stringify(result));
    assert.deepEqual(result.results.map((value) => [value.key, value.state]), [['b', 'refused'], ['z', 'applied']]);
    const peer = result.results.find((value) => value.key === 'b');
    assert.equal(peer.problem.key, 'b'); assert.ok(peer.problem.reason.includes('Agent demo/b not found') && peer.problem.fix);
    assert.deepEqual(result.expandedContainers, ['b']);
    // Recorded identity only: an inspection and a stop by the immutable ID,
    // the route revoked before the stop, all before the daemon changes.
    assert.deepEqual(f.engine, [`podman container inspect ${'b'.repeat(64)}`, `podman container stop --time 30 ${'b'.repeat(64)}`, `podman container inspect ${'b'.repeat(64)}`]);
    const order = (value) => f.events.indexOf(value);
    assert.ok(order('plan:b') < order('unavailable:b') && order('unavailable:b') < order('stop:b') && order('stop:b') < order('quit') && order('quit') < order('launch:z'), f.events.join(' '));
    assert.ok(f.unavailable.includes('b'));
    assert.deepEqual(f.state.pendingClients.map((value) => [value.key, value.phase]), [['b', 'pending']], 'the peer stays journaled');
    assert.equal(f.state.lastProblem.code, 'mps_client_failed');
});

// A refused peer that was already stopped keeps its outcome when a later
// peer's identity cannot be proven (the drain order puts b before c).
test('MI.two-refused-peers-keep-the-stopped-peers-outcome-when-the-second-is-unprovable', async () => {
    const f = recordedPeerWorld({ unprovableSecondPeer: true });
    const result = await f.apply();
    assert.equal(result.status, 207, JSON.stringify(result));
    const byKey = Object.fromEntries(result.results.map((value) => [value.key, value]));
    assert.deepEqual(Object.keys(byKey).sort(), ['b', 'c', 'z'], JSON.stringify(result.results));
    // b: stopped, with its own typed refusal and unavailable routes.
    assert.equal(byKey.b.state, 'refused');
    assert.equal(byKey.b.problem.key, 'b');
    assert.ok(byKey.b.problem.reason.includes('Agent demo/b not found') && byKey.b.problem.fix);
    assert.ok(f.unavailable.includes('b'));
    // c: refused, NOT stopped, no route touched.
    assert.equal(byKey.c.state, 'refused');
    assert.equal(byKey.c.problem.key, 'c');
    assert.ok(byKey.c.problem.reason.includes('Agent demo/c not found') && byKey.c.problem.fix);
    assert.equal(f.unavailable.includes('c'), false);
    assert.equal(f.engine.some((line) => line.includes('stop') && line.includes('c'.repeat(64))), false, f.engine.join('\n'));
    // z: pending, stopped before any daemon change.
    assert.equal(byKey.z.state, 'pending');
    assert.match(byKey.z.message, /stopped before any daemon change/);
    assert.deepEqual(result.pendingContainers, ['z']);
    assert.deepEqual(result.expandedContainers, ['b', 'c']);
    // No daemon change and no launch; b is the only peer stopped.
    assert.equal(f.events.some((value) => ['quit', 'start', 'launch:z', 'stop:c'].includes(value)), false, f.events.join(' '));
    assert.equal(f.events.filter((value) => value === 'stop:b').length, 1);
    // The journal keeps b's pending intent: b is drained and pending.
    assert.ok(f.state.drainedClients.length >= 1 && f.state.pendingClients.some((value) => value.key === 'b' && value.phase === 'pending'), JSON.stringify(f.state.pendingClients));
});

test('MI.refused-peer-outcome-survives-a-cancellation-after-its-drain', async () => {
    const f = recordedPeerWorld({ unprovableSecondPeer: true, cancelAfter: 'stop:b' });
    const result = await f.apply();
    const byKey = Object.fromEntries(result.results.map((value) => [value.key, value]));
    assert.equal(byKey.b?.state, 'refused', JSON.stringify(result));
    assert.ok(byKey.b.problem.reason.includes('Agent demo/b not found') && byKey.b.problem.fix);
    assert.ok(f.unavailable.includes('b'));
    assert.equal(result.ok, false);
    assert.equal(result.status, 504, JSON.stringify(result));
    assert.equal(byKey.z?.state, 'pending', JSON.stringify(result));
    // The abort happened right after b: c was never touched and the daemon is unchanged.
    assert.equal(f.events.some((value) => ['quit', 'start', 'launch:z', 'stop:c'].includes(value)), false, f.events.join(' '));
    assert.ok(f.state.pendingClients.some((value) => value.key === 'b' && value.phase === 'pending'), JSON.stringify(f.state.pendingClients));
});

test('MI.unprovable-peer-identity-fails-closed-with-every-outcome', async () => {
    for (const [label, world] of [
        ['instance identity label differs', { labels: { [NETWORK_LABELS.instanceId]: 'another-instance' } }],
        ['network contract label missing', { labels: { [NETWORK_LABELS.contract]: '' } }],
        ['another workspace', { labels: { [NETWORK_LABELS.workspace]: '000000000000' } }],
        ['another MPS generation', { labels: { 'ploinky.mpsgeneration': 'd9:c9' } }],
        ['no init reaper', { init: false }],
        ['labels differ, with a healthy client that sorts first', { labels: { [NETWORK_LABELS.instanceId]: 'another-instance' }, healthyPeer: true }],
    ]) {
        const f = recordedPeerWorld(world);
        const result = await f.apply();
        assert.equal(result.status, 207, `${label}: ${JSON.stringify(result)}`);
        const peer = result.results.find((value) => value.key === 'b');
        const target = result.results.find((value) => value.key === 'z');
        assert.equal(peer?.state, 'refused', label); assert.ok(peer.problem.reason && peer.problem.fix, label);
        assert.equal(target?.state, 'pending', label);
        assert.match(target.message, /stopped before any daemon change/, label);
        assert.deepEqual(result.pendingContainers, ['z'], label);
        // Nothing drained, no route touched, no daemon change, no launch.
        assert.deepEqual(f.engine, [`podman container inspect ${'b'.repeat(64)}`], label);
        assert.equal(f.events.some((value) => ['stop:b', 'quit', 'start', 'launch:z'].includes(value) || value.startsWith('unavailable:')), false, `${label}: ${f.events.join(' ')}`);
    }
});
