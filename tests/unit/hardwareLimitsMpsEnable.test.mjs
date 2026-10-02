import assert from 'node:assert/strict';
import test from 'node:test';
import { enableAgent, previewAgentEnable, withMpsEnablePreparation } from '../../cli/utils/agents.js';

const predecessor = { type: 'agent', repoName: 'demo', agentName: 'a', instanceId: 'old-i', enableGeneration: 'old-g', containerId: 'a'.repeat(64) };
const desired = { type: 'agent', repoName: 'demo', agentName: 'a', instanceId: 'new-i', enableGeneration: 'new-g', profile: 'gpu' };
function fixture({ existing = false } = {}) {
    const events = [];
    const capability = {};
    const mpsLaunch = {};
    const plan = { containerName: 'a', record: desired, instanceId: desired.instanceId, enableGeneration: desired.enableGeneration,
        manifest: {}, agentPath: '/fixture/demo/a', shortAgentName: 'a', repoName: 'demo', routeKey: 'a',
        alias: '', profileResolution: { resolvedProfileName: 'gpu', network: { mode: 'default' } }, runtimeAdmission: {}, routerEndpoint: {} };
    const mps = {
        prepareMpsClientLaunch: async (target, options) => {
            events.push('cohort'); assert.equal(target.record, existing ? predecessor : desired);
            assert.equal(options.desiredRecord, desired); assert.equal(options.networkLifecycleCapability, capability);
            return mpsLaunch;
        },
        trackMpsRuntimePending: (result, scope) => { assert.equal(scope.mpsLaunch, mpsLaunch); assert.equal(scope.key, 'a'); events.push('pending'); },
        verifyMpsRuntimeReady: () => events.push('verify'),
        acknowledgeMpsRuntimeReady: async () => events.push('ack'),
    };
    const deps = {
        network: async (callback) => { events.push('lock'); try { return await callback(capability); } finally { events.push('unlock'); } },
        preview: () => { events.push('preview'); return { plan, predecessor: existing ? predecessor : null }; }, loadMps: async () => mps,
    };
    return { events, deps, capability, mpsLaunch, plan, mps };
}

test('ME.existing cohort is coordinated under network ownership before additive generation staging', async () => {
    const f = fixture({ existing: true });
    await withMpsEnablePreparation({}, async (scope, capability) => {
        assert.equal(scope.mpsLaunch, f.mpsLaunch); assert.equal(capability, f.capability); f.events.push('stage');
    }, f.deps);
    assert.deepEqual(f.events, ['lock', 'preview', 'cohort', 'stage', 'unlock']);
});
test('ME.new target uses detached desired identity without publishing it before cohort preparation', async () => {
    const f = fixture(); await withMpsEnablePreparation({}, async () => f.events.push('stage'), f.deps);
    assert.deepEqual(f.events, ['lock', 'preview', 'cohort', 'stage', 'unlock']);
});
test('ME.invalid preview and failed cohort never stage an enable generation', async () => {
    for (const phase of ['preview', 'cohort']) {
        const f = fixture();
        if (phase === 'preview') f.deps.preview = () => { throw new Error('invalid request'); };
        else f.mps.prepareMpsClientLaunch = async () => { throw new Error('cohort refused'); };
        await assert.rejects(withMpsEnablePreparation({}, async () => assert.fail('must not stage'), f.deps));
        assert.equal(f.events.at(-1), 'unlock');
    }
});
test('ME.actual preview plans on detached registry and routing objects', () => {
    const registry = { other: { ...predecessor, agentName: 'other' } };
    const routing = { routes: { other: { container: 'other', hostPort: 8000 } } };
    const before = structuredClone({ registry, routing });
    const resolved = { agentPath: '/fixture/demo/a', manifest: { container: 'node:20', network: { mode: 'none' } },
        manifestBytes: Buffer.from('{}'), manifestPath: '/fixture/demo/a/manifest.json', normalized: { mode: 'global' },
        profile: '', profileResolution: { resolvedProfileName: 'default', network: { mode: 'none' } }, repoName: 'demo',
        routerEndpoint: null, runtimeAdmission: {}, shortAgentName: 'a' };
    const result = previewAgentEnable({ agentName: 'demo/a', mode: 'global' }, {
        readRegistry: () => registry, readRouting: () => routing, resolveInput: () => resolved,
    });
    assert.deepEqual({ registry, routing }, before);
    assert.equal(result.plan.record.agentName, 'a'); assert.equal(result.predecessor, null);
    assert.equal(typeof result.plan.instanceId, 'string');
});

function realEnableWithDependencies(f, { failReadiness = false } = {}) {
    const lease = { mode: 'additive' };
    const started = { containerName: 'a', containerId: 'b'.repeat(64), registryRecord: { ...desired, containerId: 'b'.repeat(64) } };
    const bindings = {
        withMpsEnablePreparation: (request, stage) => withMpsEnablePreparation(request, stage, f.deps),
        prepareAgentEnableBatch: () => { f.events.push('prepare'); return { plans: [f.plan], preparedGeneration: { preparationLease: lease, generation: { agents: {}, routing: { routes: {} } } } }; },
        withNetworkLifecycleLock: async (callback) => callback(f.capability),
        ensureAgentService: async (_name, _manifest, _path, options) => { assert.equal(options.mpsLaunch, f.mpsLaunch); assert.equal(options.preparationLease, lease); f.events.push('ensure'); return started; },
        verifyEnabledAgentStarted: () => f.events.push('started'),
        waitForEnabledAgentReadiness: async () => { f.events.push('readiness'); if (failReadiness) throw new Error('not ready'); },
        mergeRuntimeRoute: (_old, next) => next,
        withEdgeGenerationApplyLock: (callback) => callback({}),
        commitAdditiveEdgeRoutingGeneration: () => f.events.push('commit'),
        saveAgents: () => assert.fail('additive must not overwrite registry directly'),
        writeRoutingConfig: () => assert.fail('additive must not overwrite routing directly'),
        applyEdgeRoutingGeneration: () => assert.fail('additive has its own commit'),
        retireRuntimeCandidate: () => {}, cleanupExactAgentRuntimeCandidate: () => {},
        abortEdgeRoutingPreparation: () => f.events.push('abort'),
        wrapLifecycleError: (message, cause) => Object.assign(new Error(message), { cause }),
        console: { log() {}, warn() {} },
    };
    return new Function(...Object.keys(bindings), `return (${enableAgent.toString()});`)(...Object.values(bindings));
}
test('ME.actual enable lifecycle carries branded launch through readiness and acknowledges after additive commit', async () => {
    const f = fixture(); await realEnableWithDependencies(f)('demo/a', 'global');
    assert.deepEqual(f.events, ['lock', 'preview', 'cohort', 'prepare', 'ensure', 'pending', 'started', 'readiness', 'verify', 'commit', 'ack', 'unlock']);
});
test('ME.failed enable readiness aborts its lease and retains pending MPS target without acknowledgement', async () => {
    const f = fixture(); await assert.rejects(realEnableWithDependencies(f, { failReadiness: true })('demo/a', 'global'), /not ready/);
    assert.equal(f.events.includes('pending'), true); assert.equal(f.events.includes('commit'), false); assert.equal(f.events.includes('ack'), false);
    assert.equal(f.events.includes('abort'), true); assert.equal(f.events.at(-1), 'unlock');
});

test('ME.prepublication MPS verification is awaited and failure cannot commit the additive generation', async () => {
    const f = fixture();
    f.mps.verifyMpsRuntimeReady = async () => { await new Promise((resolve) => setImmediate(resolve)); throw new Error('generation changed'); };
    await assert.rejects(realEnableWithDependencies(f)('demo/a', 'global'), /generation changed/);
    assert.equal(f.events.includes('commit'), false); assert.equal(f.events.includes('ack'), false); assert.equal(f.events.includes('abort'), true);
});
