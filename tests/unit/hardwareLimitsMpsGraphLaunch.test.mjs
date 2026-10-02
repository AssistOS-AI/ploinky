import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureMpsGraphAgentService, acknowledgeMpsRuntimeReady, verifyMpsRuntimeReady, finalizeMpsGraph } from '../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs';
import { readMpsLaunch } from '../../cli/sandbox/hardwareLimits/mpsLaunch.mjs';

const imageId = `sha256:${'a'.repeat(64)}`;
const share = (smPercent = 25) => ({ smPercent, memoryMiB: 1024, deviceUuid: 'GPU-fixture', driverVersion: '550.1', wiringFingerprint: 'wiring' });
const record = (key) => ({ type: 'agent', repoName: 'demo', agentName: key, instanceId: `i-${key}`, enableGeneration: `g-${key}`, containerId: key.repeat(64) });
const client = (key, value = share()) => ({ key, ref: `demo/${key}`, ...record(key), share: value, mpsGeneration: 'old:config' });
const tuple = (value) => [value.key, value.instanceId, value.enableGeneration, value.containerId || ''].join('\0');
const ready = (value = share()) => ({ schema: 1, status: 'ready', daemon: { pid: 1000 }, daemonGeneration: 'old', configurationGeneration: 'config',
    pipeDirectory: `/run/ploinky/mps/pipe-${'a'.repeat(32)}`, logDirectory: `/run/ploinky/mps/log-${'a'.repeat(32)}`, serverDefault: value,
    pendingClients: [], oldClients: [], drainedClients: [], graphPrepared: true, graphPreparationId: 'graph-1', graphNeedsTransition: false });

function fixture({ state: initial = null, policies = [['demo/a', { gpu: share() }]] } = {}) {
    let state = structuredClone(initial);
    const events = [];
    const registry = { a: record('a'), b: record('b') };
    const context = { gate: 'on', storeToken: { epoch: 'e'.repeat(32), revision: 1 }, overrides: new Map(policies), gpu: { grant: { mps: {} } } };
    const store = { read: () => structuredClone(state), write: (value) => { state = structuredClone(value); events.push(`journal:${value.status}`); } };
    const backend = {
        observe: () => ({ state: state?.daemon ? 'owned' : 'gone' }), verify: (value) => Boolean(value?.daemon),
        stop: () => events.push('stop'), cleanup: () => events.push('cleanup'),
        start: (value, { onState }) => { events.push('start'); const next = { ...ready(value), daemonGeneration: 'new' }; onState(next); return next; },
    };
    const deps = {
        observeClients: () => [],
        readContext: () => context, loadRegistry: () => registry, store, backend,
        loadPlan: () => ({ runtime: 'podman', image: 'mutable:tag', profile: { network: { mode: 'default' } } }),
        prepareImage: () => events.push('prepare-image'), inspectImage: () => ({ Id: imageId, Config: { User: '1000:1000' } }),
        assertCapability: () => {}, policyCheck: () => {}, resolveShare: (policy) => policy,
        ensure: async (key, _manifest, _path, options) => {
            const desired = context.overrides.get(`demo/${key}`)?.gpu || null;
            const launch = readMpsLaunch(options.mpsLaunch, key, desired);
            assert.equal(launch.imageId, desired ? imageId : null);
            events.push(`ensure:${key}`);
            return { containerName: key, containerId: registry[key].containerId, registryRecord: structuredClone(registry[key]) };
        },
    };
    const launch = (key = 'a') => ensureMpsGraphAgentService(key, {}, `/fixture/demo/${key}`, {
        containerName: key, preparationLease: { transactionId: 'graph-1' }, networkLifecycleCapability: {},
    }, deps);
    return { launch, deps, events, registry, context, store, backend, state: () => state,
        finalize: () => finalizeMpsGraph({ networkLifecycleCapability: {} }, deps),
        ack: (result) => acknowledgeMpsRuntimeReady(result, { store, backend, loadRegistry: () => registry, report: () => {} }) };
}

test('MGL.first share pins prepared immutable image before lazy daemon start and keeps readiness pending', async () => {
    const f = fixture(); const result = await f.launch();
    assert(f.events.indexOf('prepare-image') < f.events.indexOf('start'));
    assert(f.events.indexOf('start') < f.events.indexOf('ensure:a'));
    assert.equal(f.state().pendingClients[0].phase, 'readiness');
    assert.equal(result.mpsReadiness.client.containerId, f.registry.a.containerId);
});
test('MGL.unchanged daemon generation is reused without stop or start', async () => {
    const f = fixture({ state: ready() }); await f.launch();
    assert.equal(f.state().daemonGeneration, 'old'); assert.equal(f.events.includes('stop'), false); assert.equal(f.events.includes('start'), false);
});
test('MGL.changed defaults refuse before daemon effects until every old exact tuple has a receipt', async () => {
    const oldClients = [client('a'), client('b')];
    const state = { ...ready(), graphNeedsTransition: true, oldClients, drainedClients: [tuple(oldClients[0])] };
    const f = fixture({ state, policies: [['demo/a', { gpu: share(50) }]] });
    await assert.rejects(f.launch(), /completely drained/);
    assert.equal(f.events.includes('stop'), false); assert.equal(f.events.includes('ensure:a'), false);
    assert.deepEqual(f.state(), state);
    f.store.write({ ...state, drainedClients: oldClients.map(tuple) });
    await f.launch(); assert(f.events.indexOf('stop') < f.events.indexOf('start'));
    assert.equal(f.state().serverDefault.smPercent, 50);
});
test('MGL.own share change under unchanged server default keeps daemon generation', async () => {
    const old = client('a');
    const f = fixture({ state: { ...ready(share(75)), oldClients: [old], drainedClients: [tuple(old)] },
        policies: [['demo/a', { gpu: share(50) }], ['demo/b', { gpu: share(75) }]] });
    await f.launch(); assert.equal(f.state().daemonGeneration, 'old');
    assert.equal(f.events.includes('stop'), false); assert.equal(f.events.includes('start'), false);
});
test('MGL.two graph launches share daemon while the first awaits readiness', async () => {
    const f = fixture({ policies: [['demo/a', { gpu: share() }], ['demo/b', { gpu: share() }]] });
    await f.launch('a'); await f.launch('b');
    assert.equal(f.events.filter((event) => event === 'start').length, 1);
    assert.equal(f.events.includes('stop'), false); assert.deepEqual(f.state().pendingClients.map((value) => value.key), ['a', 'b']);
});
test('MGL.final clear without any launch retires daemon only after complete drain', async () => {
    const old = client('a');
    const f = fixture({ state: { ...ready(), oldClients: [old], drainedClients: [tuple(old)], graphNeedsTransition: true }, policies: [] });
    await f.finalize(); assert(f.events.indexOf('stop') < f.events.indexOf('cleanup'));
    assert.equal(f.state().status, 'inactive'); assert.equal(f.state().daemon, null);
    assert.equal(f.state().pipeDirectory, null); assert.deepEqual(f.state().pendingClients, []);
    assert.equal(f.events.some((event) => event.startsWith('ensure:')), false);
});
test('MGL.final clear preserves journal when old predecessor is undrained', async () => {
    const state = { ...ready(), oldClients: [client('a')], graphNeedsTransition: true };
    const f = fixture({ state, policies: [] });
    await assert.rejects(f.finalize(), /undrained/); assert.deepEqual(f.state(), state); assert.deepEqual(f.events, []);
});
test('MGL.readiness acknowledgement clears only exact published identity', async () => {
    const f = fixture({ policies: [['demo/a', { gpu: share() }], ['demo/b', { gpu: share() }]] });
    const a = await f.launch('a'); await f.launch('b');
    const current = structuredClone(f.registry.a);
    f.registry.a = { ...current, enableGeneration: 'replacement' };
    assert.equal((await f.ack(a)).acknowledged, false);
    assert.equal(f.state().pendingClients.length, 2);
    f.registry.a = current;
    await f.ack(a); assert.deepEqual(f.state().pendingClients.map((value) => value.key), ['b']);
});
test('MGL.failed runtime create keeps a journaled target available for retry', async () => {
    const f = fixture(); f.deps.ensure = async () => { throw new Error('create failed'); };
    await assert.rejects(f.launch(), /create failed/);
    assert.equal(f.state().daemonGeneration, 'new');
    assert.equal(f.state().pendingClients.some((value) => value.key === 'a'), true);
});
test('MGL.daemon start interruption retains graph ownership and old drain evidence', async () => {
    const old = client('a');
    const f = fixture({ state: { ...ready(), oldClients: [old], drainedClients: [tuple(old)], graphNeedsTransition: true } });
    f.backend.start = () => { throw new Error('start failed'); };
    await assert.rejects(f.launch(), /start failed/);
    assert.equal(f.state().graphPrepared, true); assert.deepEqual(f.state().drainedClients, [tuple(old)]);
    assert.equal(f.state().daemon, null); assert.equal(f.events.includes('ensure:a'), false);
});

test('MGL.readiness acknowledgement refuses replaced daemon generation without losing pending identity', async () => {
    const f = fixture(); const result = await f.launch();
    f.store.write({ ...f.state(), daemonGeneration: 'replacement' });
    const before = f.state();
    await assert.rejects(verifyMpsRuntimeReady(result, { store: f.store, backend: f.backend, verifyRuntime: () => {} }), /generation|defaults/);
    assert.equal((await f.ack(result)).acknowledged, false);
    assert.deepEqual(f.state(), before);
});
test('MGL.finalizing a sharing graph preserves readiness-pending clients', async () => {
    const f = fixture({ state: ready() }); await f.launch();
    const pending = f.state().pendingClients;
    await f.finalize();
    assert.deepEqual(f.state().pendingClients, pending);
    assert.equal(f.events.includes('stop'), false); assert.equal(f.events.includes('cleanup'), false);
});
test('MGL.invalid image refuses before daemon ownership or target mutation', async () => {
    const f = fixture(); f.deps.inspectImage = () => ({ Id: imageId, Config: { User: 'root' } });
    await assert.rejects(f.launch(), /UID|user|root/i);
    assert.equal(f.events.includes('start'), false); assert.equal(f.events.includes('ensure:a'), false);
    assert.equal(f.state(), null);
});
