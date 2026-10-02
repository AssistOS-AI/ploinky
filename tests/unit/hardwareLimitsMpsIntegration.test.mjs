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
