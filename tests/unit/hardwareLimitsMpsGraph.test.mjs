import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareMpsGraph } from '../../cli/sandbox/hardwareLimits/mpsGraph.mjs';
import { drainTargetedContainer } from '../../cli/sandbox/docker/targetedContainerLifecycle.js';
import { resolveMpsServerDefault } from '../../cli/sandbox/hardwareLimits/mpsTransition.mjs';

const share = { smPercent: 25, memoryMiB: 1024, deviceUuid: 'GPU-fixture', driverVersion: '550.1', wiringFingerprint: 'wiring' };
const record = (key) => ({ type: 'agent', repoName: 'demo', agentName: key, instanceId: `i-${key}`, enableGeneration: `g-${key}`, containerId: key.repeat(64) });
const tuple = (client) => [client.key, client.instanceId, client.enableGeneration, client.containerId || ''].join('\0');
function fixture({ changed = true, stopped = false, absent = false } = {}) {
    const registry = { a: record('a'), b: record('b') };
    const nodes = Object.keys(registry).map((key) => ({ key, node: { manifest: { container: 'fixture', network: { mode: 'default' } } } }));
    let state = { schema: 1, daemon: { pid: 1000 }, status: 'ready', daemonGeneration: 'old', configurationGeneration: 'config',
        serverDefault: resolveMpsServerDefault([{ share }]), oldClients: [], drainedClients: [], pendingClients: [] };
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
    assert.deepEqual(f.state().serverDefault, resolveMpsServerDefault([{ share }])); assert.equal(f.state().desiredServerDefault.smPercent, 50);
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
    // A live client outside the graph refuses only the graph's GPU agents
    // before any effect (fix round 3, M2: contained, not a failed start).
    const f = fixture(); f.nodes.pop(); f.deps.inspectPresence = () => ({ state: 'present', id: 'b'.repeat(64) });
    const result = await f.run();
    assert.deepEqual(result.refusals.map((value) => value.key), ['a']); assert.match(result.refusals[0].reason, /outside the admitted graph/);
    assert.deepEqual(f.events, []);
});
test('MG.foreign peer refuses before draining selected client', async () => {
    const f = fixture(); f.deps.inspect = (client) => ({ state: client.key === 'b' ? 'foreign' : 'exact', id: client.containerId, running: true });
    const result = await f.run();
    assert.deepEqual(result.refusals.map((value) => value.key), ['a', 'b']); assert.match(result.refusals[0].reason, /ownership/);
    assert.deepEqual(f.events, []);
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

// --- Aliased MPS clients through journal recovery -------------------------
// The fixture below is the review reproducer's: a real network lifecycle
// adapter validates the full alias network identity of an immutable client.
import { inspectMpsClient, resolveMpsClientAlias } from '../../cli/sandbox/hardwareLimits/mpsInventory.mjs';
import { createNetworkLifecycleAdapter, NETWORK_LABELS, workspaceNetworkIdentity, physicalNetworkName } from '../../cli/sandbox/networkLifecycle.js';
import { networkContractHash, logicalNetworkAttachments, deriveNetworkAlias } from '../../cli/sandbox/networkContract.js';
import { effectiveInstanceKey } from '../../cli/utils/workspaceDependencyGraph.js';
import { coordinateMpsLifecycle } from '../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs';
import { planMpsTransition } from '../../cli/sandbox/hardwareLimits/mpsTransition.mjs';
import { createMpsStateStore } from '../../cli/sandbox/hardwareLimits/mps.mjs';

function aliasClientFixture(t, alias = 'router') {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mpsinspect-'))); t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const identity = workspaceNetworkIdentity(workspaceRoot), network = { mode: 'default' }, id = 'a'.repeat(64);
    const client = { key: 'opaque-registry-key', ref: 'repo/gpu', alias, containerId: id, instanceId: 'instance', enableGeneration: 'generation' };
    const logical = logicalNetworkAttachments(network, 'gpu', { instanceKey: effectiveInstanceKey('repo', 'gpu', alias) })[0].name;
    const physical = physicalNetworkName(identity.hash, logical);
    const record = { Id: id, Name: client.key, Config: { Labels: { [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'agent', [NETWORK_LABELS.schema]: '2', [NETWORK_LABELS.workspace]: identity.hash, [NETWORK_LABELS.contract]: networkContractHash(network), [NETWORK_LABELS.instanceId]: client.instanceId, [NETWORK_LABELS.enableGeneration]: client.enableGeneration } }, HostConfig: { Init: true, HostsFile: 'none', ExtraHosts: ['host.containers.internal:host-gateway'] }, NetworkSettings: { Networks: { [physical]: { Aliases: [deriveNetworkAlias('gpu'), id.slice(0, 12)] } } }, State: { Running: true, Status: 'running' } };
    const bridge = { Name: physical, Driver: 'bridge', Internal: false, IPv6Enabled: false, DNSEnabled: true, Options: { isolate: 'true' }, IPAM: { Driver: 'host-local', Options: {} }, Subnets: [{ Subnet: '10.89.0.0/24', Gateway: '10.89.0.1' }], Labels: { [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'network', [NETWORK_LABELS.schema]: '2', [NETWORK_LABELS.workspace]: identity.hash, [NETWORK_LABELS.logical]: logical } };
    const ok = (stdout) => ({ ok: true, status: 0, stdout, stderr: '' });
    const run = (_runtime, args) => {
        if (args[0] === 'container') { assert.equal(args[2], id, 'inspection selects immutable CID rather than registry/name'); return ok(JSON.stringify([record])); }
        if (args[0] === 'info') return ok(JSON.stringify({ rootless: true, networkBackend: 'netavark', pasta: { executable: '/usr/bin/pasta', version: 'test' }, serviceIsRemote: false }));
        if (args[0] === 'version') return ok('5.4.0'); if (args[0] === 'unshare') return ok('pasta test');
        if (args[0] === 'network' && args[1] === 'inspect') return args[2] === physical ? ok(JSON.stringify([bridge])) : { ok: false, status: 125, stderr: 'no such network' };
        if (args[0] === 'exec') { assert.equal(args[1], id); return ok('127.0.0.1 localhost\n10.89.0.1 host.containers.internal\n'); }
        assert.fail(`unexpected ${args[0]}`);
    };
    const createAdapter = (options) => createNetworkLifecycleAdapter({ ...options, run, workspaceRoot, containersConfigPaths: [], env: {}, runtimeProofRetryDelaysMs: [] });
    return { client, network, createAdapter, inspect: (override = {}, options = {}) => inspectMpsClient({ ...client, ...override }, { network, runtime: 'podman', createAdapter, ...options }) };
}
const aliasShare = (smPercent) => ({ smPercent, memoryMiB: 1024, deviceUuid: 'GPU-12345678-1234-1234-1234-123456789012', driverVersion: '550.1', wiringFingerprint: 'f'.repeat(64) });
function memoryStore(initial) {
    let state = initial;
    return { read: () => structuredClone(state), write: (value) => { state = structuredClone(value); }, get state() { return state; } };
}
// A real private state store (validator and atomic write) over a temporary
// directory, as hardwareLimitsMps.test.mjs runs it.
function privateStore(t, initial) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-mps-alias-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.chmodSync(root, 0o700);
    const fsApi = new Proxy(fs, { get(target, property) { if (['lstatSync', 'fstatSync'].includes(property)) return (...args) => { const result = target[property](...args); result.uid = 1000; return result; }; return target[property]; } });
    const store = createMpsStateStore({ root, fsApi, uid: 1000 }); store.write(initial);
    return { read: () => store.read(), write: (value) => store.write(value), get state() { return store.read(); } };
}
// The real coordinator journals an aliased cohort and dies before its first
// drain; the graph then recovers from that journal with the current registry.
async function interruptedAliasWorld(t, { alias = 'router', store: makeStore = memoryStore } = {}) {
    const f = aliasClientFixture(t, alias), key = f.client.key;
    const record = { type: 'agent', repoName: 'repo', agentName: 'gpu', ...(alias ? { alias } : {}), instanceId: f.client.instanceId, enableGeneration: f.client.enableGeneration, containerId: f.client.containerId };
    const store = makeStore({ schema: 1, status: 'ready', daemon: { pid: 1000 }, daemonGeneration: 'old', configurationGeneration: 'config', serverDefault: aliasShare(25), oldClients: [], pendingClients: [], drainedClients: [] });
    const context = { gate: 'on', storeToken: { epoch: 'e'.repeat(32), revision: 1 }, overrides: new Map([['repo/gpu', { gpu: aliasShare(50) }]]), gpu: { grant: { mps: {} } } };
    const events = []; let registry = { [key]: structuredClone(record) };
    const deps = { readContext: () => context, loadRegistry: () => structuredClone(registry), readApplied: () => ({ ...record, gpuShare: aliasShare(25), mpsGeneration: 'old:config' }), loadPlan: () => ({ runtime: 'podman', image: 'image:tag', profile: { network: f.network } }), prepareImage: () => {}, inspectImage: () => ({ Id: 'c'.repeat(64), Config: { User: '1000:1000' } }), store, backend: { observe: () => ({ state: 'owned' }), verify: () => true }, network: (callback) => callback({}), assertCapability: () => {}, policyCheck: () => {}, resolveShare: (value) => value, observeClients: () => [], drainClient: () => { throw Error('crash-before-first-drain'); } };
    await assert.rejects(coordinateMpsLifecycle({ target: { key, record }, options: {}, launchTarget: () => { throw Error('unexpected launch'); } }, deps), /crash-before-first-drain/);
    const nodes = [{ key, node: { manifest: { container: 'node:22-alpine', network: { mode: 'default' } }, agentRef: 'repo/gpu' } }];
    const graphDeps = { ...deps, runtime: () => 'podman', readSelection: () => ({ selector: { state: 'inactive', generation: 'graph', selectorDigest: 'digest' } }),
        inspect: (client, network, runtime) => { const observed = inspectMpsClient(client, { network, runtime, createAdapter: f.createAdapter }); events.push({ alias: client.alias, state: observed.state }); return observed; },
        drain: () => events.push('drain') };
    return { key, store, events, setRegistry: (next) => { registry = next; }, record,
        journal: (mutate) => { const value = store.read(); mutate(value); store.write(value); },
        dropJournal: () => { const value = store.read(); value.oldClients = []; store.write(value); },
        run: () => prepareMpsGraph({ nodes, networkLifecycleCapability: {} }, graphDeps) };
}

test('GRAPH.alias-journal-generated-by-real-coordinator-recovery', async (t) => {
    const f = await interruptedAliasWorld(t);
    assert.equal(f.store.state.oldClients[0].alias, 'router', 'the coordinator journals the client alias');
    await assert.doesNotReject(f.run());
    assert.deepEqual(f.events, [{ alias: 'router', state: 'exact' }, 'drain']);
});
test('GRAPH.alias-fresh-registry-control', async (t) => {
    const f = await interruptedAliasWorld(t); f.dropJournal();
    const result = await f.run();
    assert.equal(result.replacedKeys.has('opaque-registry-key'), true);
    assert.deepEqual(f.events, [{ alias: 'router', state: 'exact' }, 'drain']);
});
test('GRAPH.alias-interrupted-router-cohort-journal-and-registry', async (t) => {
    const f = await interruptedAliasWorld(t, { store: (initial) => privateStore(t, initial) });
    const journaled = f.store.state;
    assert.equal(journaled.status, 'pending'); assert.deepEqual(journaled.oldClients.map((client) => [client.key, client.alias]), [[f.key, 'router']]);
    assert.deepEqual(journaled.desiredClients.map((client) => client.alias), ['router']);
    assert.deepEqual(journaled.pendingClients.map((client) => client.alias), ['router']);
    // The saved journal and the current registry observe the same exact tuple.
    const result = await f.run();
    assert.equal(result.replacedKeys.has(f.key), true);
    assert.deepEqual(f.events, [{ alias: 'router', state: 'exact' }, 'drain']);
    const recovered = f.store.state;
    assert.equal(recovered.oldClients.length, 1); assert.equal(recovered.oldClients[0].alias, 'router');
    assert.deepEqual(recovered.drainedClients, [[f.key, f.record.instanceId, f.record.enableGeneration, f.record.containerId].join('\0')]);
});
test('GRAPH.alias-legacy-journal-enriched-from-exact-registry', async (t) => {
    const f = await interruptedAliasWorld(t, { store: (initial) => privateStore(t, initial) });
    // A journal written before aliases were recorded is still readable.
    f.journal((value) => { for (const field of ['oldClients', 'desiredClients', 'pendingClients']) for (const client of value[field]) delete client.alias; });
    assert.equal(Object.hasOwn(f.store.state.oldClients[0], 'alias'), false);
    await assert.doesNotReject(f.run());
    assert.deepEqual(f.events, [{ alias: 'router', state: 'exact' }, 'drain']);
    assert.equal(f.store.state.oldClients[0].alias, 'router');
});
test('GRAPH.alias-journal-registry-mismatch-refused', async (t) => {
    const f = await interruptedAliasWorld(t);
    f.journal((value) => { value.oldClients[0].alias = 'other'; });
    const before = JSON.stringify(f.store.state);
    // Contained before any effect (fix round 3, M2): the GPU agent is refused.
    const refused = await f.run();
    assert.deepEqual(refused.refusals.map((value) => value.key), [f.key]); assert.equal(refused.diagnostic.code, 'identity_changed');
    assert.deepEqual(f.events, []); assert.equal(JSON.stringify(f.store.state), before);
    // The registry record changing alias under the same tuple is refused too.
    const g = await interruptedAliasWorld(t); g.setRegistry({ [g.key]: { ...g.record, alias: 'other' } });
    const other = await g.run();
    assert.deepEqual(other.refusals.map((value) => value.key), [g.key]); assert.equal(other.diagnostic.code, 'identity_changed'); assert.deepEqual(g.events, []);
    // The lifecycle drain and the transition plan refuse the same mismatch.
    const client = { key: 'k', ref: 'repo/gpu', alias: 'router', instanceId: 'i', enableGeneration: 'g', containerId: 'a'.repeat(64), share: aliasShare(25), mpsGeneration: 'old:config' };
    assert.throws(() => resolveMpsClientAlias(client, { instanceId: 'i', enableGeneration: 'g', containerId: 'a'.repeat(64), alias: 'other' }), { code: 'identity_changed' });
    assert.throws(() => resolveMpsClientAlias(client, { instanceId: 'i', enableGeneration: 'g', containerId: 'a'.repeat(64) }), { code: 'identity_changed' });
    const state = { schema: 1, status: 'ready', daemon: { pid: 1 }, daemonGeneration: 'old', configurationGeneration: 'config', serverDefault: aliasShare(25), oldClients: [{ ...client, alias: 'other' }], pendingClients: [] };
    assert.throws(() => planMpsTransition({ oldClients: [client], desiredClients: [{ ...client, share: aliasShare(50) }], state, observedDaemon: { state: 'owned' }, defaultsVerified: true }), { code: 'identity_changed' });
    const merged = planMpsTransition({ oldClients: [client], desiredClients: [client], state: { ...state, oldClients: [{ ...client, alias: undefined }].map(({ alias, ...rest }) => rest) }, observedDaemon: { state: 'owned' }, defaultsVerified: true });
    assert.equal(merged.oldClients.length, 1); assert.equal(merged.oldClients[0].alias, 'router');
});
test('GRAPH.alias-unaliased-client-unchanged', async (t) => {
    const f = await interruptedAliasWorld(t, { alias: '' });
    assert.equal(Object.hasOwn(f.record, 'alias'), false);
    assert.equal(f.store.state.oldClients[0].alias, '');
    await assert.doesNotReject(f.run());
    assert.deepEqual(f.events, [{ alias: '', state: 'exact' }, 'drain']);
    const g = await interruptedAliasWorld(t, { alias: '' });
    g.journal((value) => { delete value.oldClients[0].alias; });
    await assert.doesNotReject(g.run()); assert.deepEqual(g.events, [{ alias: '', state: 'exact' }, 'drain']);
});
test('GRAPH.alias-inspection-never-defaults-to-canonical', (t) => {
    const f = aliasClientFixture(t);
    assert.equal(f.inspect().state, 'exact');
    const { alias, ...legacy } = f.client;
    assert.throws(() => inspectMpsClient(legacy, { network: f.network, runtime: 'podman', createAdapter: f.createAdapter }), { code: 'identity_changed' });
    assert.equal(f.inspect({ alias: '' }).state, 'owned-drift');
    // Without an exact registry record only a journaled alias can be used.
    const stale = { instanceId: 'other', enableGeneration: f.client.enableGeneration, containerId: f.client.containerId, alias: '' };
    assert.equal(resolveMpsClientAlias(f.client, stale), 'router');
    assert.equal(resolveMpsClientAlias(f.client, undefined), 'router');
    assert.throws(() => resolveMpsClientAlias(legacy, stale), { code: 'identity_changed' });
    assert.equal(resolveMpsClientAlias(legacy, { instanceId: 'instance', enableGeneration: 'generation', containerId: f.client.containerId, alias: 'router' }), 'router');
    assert.equal(resolveMpsClientAlias(legacy, { instanceId: 'instance', enableGeneration: 'generation', containerId: f.client.containerId }), '');
});
test('GRAPH.alias-journal-validator-legacy-and-bounds', (t) => {
    const base = { schema: 1, status: 'pending', oldClients: [{ key: 'a' }], pendingClients: [{ key: 'b', alias: 'router' }], desiredClients: [{ key: 'c', alias: '' }] };
    const store = privateStore(t, base);
    assert.deepEqual(store.read().oldClients, [{ key: 'a' }]); assert.equal(store.read().pendingClients[0].alias, 'router');
    for (const alias of ['_config', '-lead', 'a/b', 'a b', 7, null, 'x'.repeat(1025)]) {
        for (const field of ['oldClients', 'desiredClients', 'pendingClients']) {
            assert.throws(() => store.write({ ...base, [field]: [{ key: 'a', alias }] }), /Invalid private MPS client cohort/, `${field} ${String(alias).slice(0, 12)}`);
        }
    }
    assert.equal(store.read().pendingClients[0].alias, 'router');
});
