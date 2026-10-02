import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareMpsGraph } from '../../cli/sandbox/hardwareLimits/mpsGraph.mjs';
import { drainTargetedContainer } from '../../cli/sandbox/docker/targetedContainerLifecycle.js';

const share = { smPercent: 25, memoryMiB: 1024, deviceUuid: 'GPU-fixture', driverVersion: '550.1', wiringFingerprint: 'wiring' };
const record = (key) => ({ type: 'agent', repoName: 'demo', agentName: key, instanceId: `i-${key}`, enableGeneration: `g-${key}`, containerId: key.repeat(64) });
const tuple = (client) => [client.key, client.instanceId, client.enableGeneration, client.containerId || ''].join('\0');
function fixture({ changed = true, stopped = false, absent = false } = {}) {
    const registry = { a: record('a'), b: record('b') };
    const nodes = Object.keys(registry).map((key) => ({ key, node: { manifest: { container: 'fixture', network: { mode: 'default' } } } }));
    let state = { schema: 1, daemon: { pid: 1000 }, status: 'ready', daemonGeneration: 'old', configurationGeneration: 'config',
        serverDefault: share, oldClients: [], drainedClients: [], pendingClients: [] };
    const nextShare = { ...share, smPercent: changed ? 50 : 25 };
    const context = { gate: 'on', storeToken: { epoch: 'a'.repeat(32), revision: 1 }, overrides: new Map([['demo/a', { gpu: nextShare }], ['demo/b', { gpu: share }]]) };
    const selection = { state: 'inactive', generation: 'prepared', selectorDigest: 'digest' };
    const events = [];
    const deps = {
        observeClients: () => [],
        readContext: () => context, loadRegistry: () => registry, readApplied: (key) => ({ ...registry[key], gpuShare: share, mpsGeneration: 'old:config' }),
        store: { read: () => structuredClone(state), write: (next) => { state = structuredClone(next); events.push('journal'); } },
        backend: { observe: () => ({ state: 'owned' }), verify: () => true }, assertCapability: () => {},
        readSelection: () => ({ selector: structuredClone(selection) }), resolveShare: (policy) => policy,
        runtime: () => 'podman', inspect: (client) => ({ state: absent ? 'absent' : 'exact', id: client.containerId, running: !stopped }),
        drain: (key, options) => {
            events.push(`drain:${key}`);
            assert.equal(state.oldClients.some((client) => client.key === key), true);
            assert.equal(options.assertSelectorsInactive(), true);
        },
    };
    return { registry, nodes, context, selection, events, deps, state: () => state,
        run: () => prepareMpsGraph({ nodes, networkLifecycleCapability: {} }, deps) };
}

test('MG.changed default drains complete exact cohort and defers daemon and runtime mutations', async () => {
    const f = fixture(); const result = await f.run();
    assert.deepEqual([...result.replacedKeys], ['a', 'b']);
    assert.deepEqual(f.events.filter((value) => value.startsWith('drain:')), ['drain:a', 'drain:b']);
    assert.equal(f.state().graphPrepared, true); assert.equal(f.state().graphNeedsTransition, true);
    assert.deepEqual(f.state().serverDefault, share); assert.equal(f.state().desiredServerDefault.smPercent, 50);
    assert.deepEqual(f.state().drainedClients, f.state().oldClients.map(tuple));
    assert.deepEqual(f.registry.a, record('a')); assert.equal(f.selection.state, 'inactive');
});
test('MG.healthy unchanged graph leaves clients and daemon untouched', async () => {
    const f = fixture({ changed: false }); const result = await f.run();
    assert.equal(result.replacedKeys.size, 0); assert.equal(f.events.some((value) => value.startsWith('drain:')), false);
    assert.equal(f.state().graphNeedsTransition, false); assert.equal(f.state().status, 'ready');
});
for (const mode of ['stopped', 'absent']) test(`MG.${mode} exact predecessor receives durable drain receipt without signalling`, async () => {
    const f = fixture({ [mode]: true }); await f.run();
    assert.equal(f.events.some((value) => value.startsWith('drain:')), false); assert.equal(f.state().drainedClients.length, 2);
});
test('MG.graph omission refuses before first journal or client drain', async () => {
    const f = fixture(); f.nodes.pop();
    await assert.rejects(f.run(), /outside the admitted graph/); assert.deepEqual(f.events, []);
});
test('MG.foreign peer refuses before draining selected client', async () => {
    const f = fixture(); f.deps.inspect = (client) => ({ state: client.key === 'b' ? 'foreign' : 'exact', id: client.containerId, running: true });
    await assert.rejects(f.run(), /ownership/); assert.deepEqual(f.events, []);
});
test('MG.post-provider pass preserves prior exact receipts after expected registry rotation', async () => {
    const f = fixture(); await f.run(); const previous = f.state().graphPreparationId;
    f.registry.a = { ...f.registry.a, instanceId: 'fresh-a', enableGeneration: 'fresh-a' };
    f.registry.b = { ...f.registry.b, instanceId: 'fresh-b', enableGeneration: 'fresh-b' };
    f.deps.readApplied = () => null; f.events.length = 0;
    const result = await f.run();
    assert.notEqual(f.state().graphPreparationId, previous); assert.equal(f.state().drainedClients.length, 2);
    assert.equal(result.replacedKeys.size, 2); assert.equal(f.events.includes('drain:a'), false);
});
test('MG.active or changed selector cannot authorize graph drains', async () => {
    const f = fixture(); f.selection.state = 'active';
    await assert.rejects(f.run(), /inactive selector/); assert.deepEqual(f.events, []);
});
test('MG.policy change between exact inspections and drain refuses without journal mutation', async () => {
    const f = fixture(); let reads = 0; f.deps.readContext = () => (++reads === 1 ? f.context : { ...f.context, storeToken: { ...f.context.storeToken, revision: 2 } });
    await assert.rejects(f.run(), { code: 'revision_conflict' }); assert.deepEqual(f.events, []);
});
test('MG.real bounded drain primitive completes before its receipt', async () => {
    const f = fixture(); const running = new Set(['a', 'b']);
    f.deps.drain = (key, options) => drainTargetedContainer(key, { ...options,
        exists: () => true, isRunning: () => running.has(key),
        retireControlSocket: () => {}, signal: () => { assert.equal(f.state().drainedClients.some((value) => value.startsWith(`${key}\0`)), false); running.delete(key); return { status: 0 }; },
        inspect: () => ({ State: { ExitCode: 0 } }),
    });
    await f.run(); assert.equal(running.size, 0); assert.equal(f.state().drainedClients.length, 2);
});
test('MG.gate-off never reads MPS state or inspects GPU clients', async () => {
    const f = fixture(); f.deps.readContext = () => ({ gate: 'off' }); f.deps.store.read = () => { throw new Error('must not read'); };
    assert.equal((await f.run()).replacedKeys.size, 0);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureGraphNodesEnabled, reprepareGraphAfterStartupProviders, startWorkspace } from '../../cli/commands/workspaceUtil.js';

test('MG.real graph batch rotates drained cohort once and retains authoritative lease through provider reprepare', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-graph-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const f = fixture();
    const nodes = new Map(f.nodes.map(({ key }) => [`demo/${key}`, { id: `demo/${key}`, agentRef: `demo/${key}`, repoName: 'demo', shortAgentName: key,
        alias: '', enableSpec: `demo/${key} global`, profile: 'default' }]));
    for (const record of Object.values(f.registry)) Object.assign(record, { runMode: 'global', projectPath: root, profile: 'default' });
    const routing = { routes: Object.fromEntries(Object.keys(f.registry).map((key) => [key, { container: key, repo: 'demo', agent: key, hostPort: 8000 }])) };
    const preparation = await f.run();
    const events = [];
    const dependencies = {
        observeClients: () => [],
        inactivateGeneration: () => events.push('inactive'), loadRouting: () => routing,
        saveRouting: () => events.push('targetless'), saveAgents: () => events.push('save'), retireNoWaitMarkers: () => {},
        prepareAgentEnableBatch: () => ({ plans: [], preparedGeneration: { selector: { state: 'inactive' }, preparationLease: { transactionId: 'graph-lease' } } }),
        runtimeReplacementReason: (plan) => preparation.replacedKeys.has(plan.existing.key) ? 'mpsCohortTransition' : '',
        executionRecordOptions: { workspaceRoot: root },
        removeAgentContainerForRecreate: (key, _reason, predecessor) => {
            assert.equal(f.state().drainedClients.includes(tuple({ key, ...predecessor })), true);
            assert.notEqual(f.registry[key].instanceId, predecessor.instanceId); events.push(`remove:${key}`);
        },
    };
    const prepared = ensureGraphNodesEnabled({ nodes }, f.registry, dependencies);
    assert.deepEqual(prepared.changedContainers, ['a', 'b']);
    const freshRecords = structuredClone(f.registry);
    f.deps.readApplied = () => null;
    await f.run();
    const afterProviders = reprepareGraphAfterStartupProviders({ nodes }, f.registry, prepared, {
        abortPreparation: () => events.push('abort'), graphEnableOptions: dependencies,
        runtimeReplacementReason: () => { throw new Error('fresh staged tuple must not rotate again'); },
    });
    assert.deepEqual(f.registry, freshRecords);
    assert.equal(afterProviders.preparedGraph.preparedGeneration.selector.state, 'inactive');
    assert.deepEqual(events.filter((event) => event.startsWith('remove:')), ['remove:a', 'remove:b']);
});

test('MG.graph hooks surround both authoritative preparations and acknowledge only after final publication', () => {
    const source = startWorkspace.toString();
    assert.match(source, /const prepareGraphMps = async/);
    assert.match(source, /await prepareMpsGraph/);
    const first = source.indexOf('await prepareGraphMps(');
    assert(first >= 0 && first < source.indexOf('ensureGraphNodesEnabled(dependencyGraph'));
    const second = source.indexOf('await prepareGraphMps(', first + 1);
    assert(second > source.indexOf('applyStartupConfigProvidersForGraph'));
    assert(second < source.indexOf('reprepareGraphAfterStartupProviders('));
    assert(source.indexOf('await acknowledgeMpsRuntimeReady') > source.indexOf("reason: 'workspace-runtime-graph-ready'"));
    assert.match(source, /readyAgentKeys\.includes\(runtimeResult\?\.containerName\)/);
});

test('MG.unavailable daemon contains GPU refusals without failing unrelated graph members', async () => {
    const f = fixture(); f.deps.backend.observe = () => ({state: 'unknown'});
    f.registry.c = record('c'); f.nodes.push({key:'c',node:{manifest:{container:'fixture'}}});
    const priorRead = f.deps.readApplied; f.deps.readApplied = (key) => key === 'c' ? null : priorRead(key);
    const result = await f.run();
    assert.deepEqual(result.refusals.map((value) => value.key), ['a','b']);
    assert.equal(result.refusals.every((value) => value.code === 'PLOINKY_HARDWARE_LIMITS_UNENFORCEABLE'), true);
    assert.deepEqual(f.events, []);
});

for (const code of ['EACCES', 'malformed']) {
    test(`MG.CPU-only graph preserves unavailable MPS state and continues: ${code}`, async () => {
        const f = fixture();
        f.context.overrides = new Map(); f.deps.readApplied = () => null;
        f.deps.store.read = () => { throw Object.assign(new Error('private state unreadable'), { code }); };
        const result = await f.run();
        assert.deepEqual(result.refusals, []); assert.equal(result.replacedKeys.size, 0);
        assert.equal(result.diagnostic.code, 'mps_backend_unavailable');
        assert.match(result.diagnostic.fix, /restart this Box/);
        assert.deepEqual(f.events, []);
    });
}
