import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

const originalCwd = process.cwd();
const originalEnv = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
};
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-outcomes-')));
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '8080';
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);

const markerPath = path.join(workspace, 'box-marker');
fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
const boxMarkerOptions = { markerPath };

function writeManifest(repo, agent, manifest) {
    const directory = path.join(workspace, '.ploinky', 'repos', repo, agent);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return path.join(directory, 'manifest.json');
}

const base = { container: 'node:20-alpine', network: { mode: 'default' } };
const limited = (resources) => ({ ...base, llmRuntime: { runtimePolicy: { resources } } });
writeManifest('demo', 'root', { ...base, enable: ['demo/needy', 'demo/plain', 'demo/opt no-wait'] });
writeManifest('demo', 'needy', limited({ memory: '512m' }));
writeManifest('demo', 'plain', base);
writeManifest('demo', 'opt', { ...base, enable: ['demo/grand'] });
writeManifest('demo', 'grand', limited({ cpus: '1' }));
writeManifest('demo', 'priv', { ...base, containerSecurity: { privileged: true } });
writeManifest('demo', 'privroot', { ...base, enable: ['demo/priv'] });
writeManifest('demo', 'aliasroot', { ...base, enable: ['demo/needy as n1', 'demo/plain as p2'] });
writeManifest('demo', 'optroot', { ...base, enable: ['demo/needy no-wait'] });
writeManifest('demo', 'cyca', { ...base, enable: ['demo/cycb'] });
writeManifest('demo', 'cycb', { ...limited({ memory: '128m' }), enable: ['demo/cyca'] });
writeManifest('demo', 'cycc', { ...base, enable: ['demo/cycd'] });
writeManifest('demo', 'cycd', { ...limited({ memory: '128m' }), enable: ['demo/cycc no-wait'] });
writeManifest('demo', 'firstEnable', limited({ pidsLimit: 64 }));

const workspaceUtil = await import(new URL('../../cli/commands/workspaceUtil.js', import.meta.url).href);
const graphModule = await import(new URL('../../cli/utils/workspaceDependencyGraph.js', import.meta.url).href);
const runtimeCapabilities = await import(new URL('../../cli/sandbox/runtimeCapabilities.js', import.meta.url).href);
const outcomes = await import(new URL('../../cli/sandbox/hardwareLimits/outcomes.mjs', import.meta.url).href);
const errors = await import(new URL('../../cli/sandbox/hardwareLimits/errors.mjs', import.meta.url).href);
const requestedLimits = await import(new URL('../../cli/sandbox/hardwareLimits/requestedLimits.mjs', import.meta.url).href);
const noWaitWorker = await import(new URL('../../cli/commands/noWaitWorker.js', import.meta.url).href);
const edge = await import(new URL('../../cli/sandbox/edgeGeneration.js', import.meta.url).href);
const routing = await import(new URL('../../cli/server/routingFile.js', import.meta.url).href);
const agents = await import(new URL('../../cli/utils/agents.js', import.meta.url).href);
const workspaceSvc = await import(new URL('../../cli/utils/workspace.js', import.meta.url).href);

const {
    admitWorkspaceGraphRuntimeCapabilities,
    assertWorkspaceGraphAdmissionsCurrent,
    buildNoWaitLaunchSchedule,
    classifyWorkspaceGraphAvailability,
    ensureGraphNodesEnabled,
    preflightWorkspaceStartRuntimeCapabilities,
} = workspaceUtil;

test.after(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

function refusalFor(admissions, ref) {
    const record = admissions.find((entry) => entry.admission.agentId === ref);
    assert.ok(record, `no admission for ${ref}`);
    return record.hardwareRefusal;
}

const REFUSED_OUTCOME = (key, ref) => requestedLimits.buildDirectRefusal({
    key,
    ref,
    refusalParts: {
        reasonCode: 'controller_unavailable',
        reason: 'The host does not delegate memory to rootless Podman.',
        fix: 'Apply the delegation commands, then run ploinky restart.',
        requested: [{ field: 'memory', value: '64m', source: 'settings' }],
    },
    inputFingerprint: 'f'.repeat(64),
});

function availabilityNode(key, refusal = null) {
    return { key, ref: `demo/${key}`, alias: null, refusal };
}

test('O.prelock-preflight-refusal', () => {
    const preflight = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions });
    const refusal = refusalFor(preflight.admissions, 'demo/needy');
    assert.equal(refusal.state, 'refused');
    assert.equal(refusal.reasonCode, 'gate_off');
    assert.equal(refusalFor(preflight.admissions, 'demo/plain'), null);
    assert.equal(refusalFor(preflight.admissions, 'demo/root'), null);
});

test('O.locked-preflight-refusal', () => {
    const prelock = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions });
    assert.doesNotThrow(() => assertWorkspaceGraphAdmissionsCurrent(prelock.admissions, { boxMarkerOptions }));
    const locked = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions });
    assert.deepEqual(refusalFor(locked.admissions, 'demo/needy'), refusalFor(prelock.admissions, 'demo/needy'));
});

test('O.defensive-preflight-refusal', () => {
    const preflight = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions });
    const batches = [];
    assert.doesNotThrow(() => ensureGraphNodesEnabled(preflight.graph, {}, {
        boxMarkerOptions,
        prepareAgentEnableBatch(requests, options) {
            batches.push({ requests: structuredClone(requests), options: structuredClone(options) });
            return { plans: requests };
        },
        saveAgents() {},
        retireNoWaitMarkers() {},
    }));
    assert.equal(batches.length, 1);
    assert.equal(batches[0].options.hardwareAdmission, 'metadata', 'staging records refusal instead of throwing');
    assert.ok(batches[0].requests.some((request) => request.agentName === 'demo/needy'));
});

test('O.batch-first-enable-refusal', () => {
    edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    routing.writeRoutingConfig({ port: 8080, routes: {} }, { coordinate: false });
    assert.throws(
        () => agents.prepareAgentEnableBatch([{ agentName: 'demo/firstEnable', mode: 'global' }], { boxMarkerOptions }),
        (error) => error.code === errors.HARDWARE_UNENFORCEABLE,
        'strict individual enable returns the typed refusal',
    );
    const prepared = agents.prepareAgentEnableBatch([{ agentName: 'demo/firstEnable', mode: 'global' }], {
        boxMarkerOptions,
        hardwareAdmission: 'metadata',
        availabilityMode: 'replacement',
    });
    const plan = prepared.plans.find((entry) => entry.shortAgentName === 'firstEnable');
    assert.ok(plan, 'a first-enable refused agent is still staged');
    assert.equal(plan.runtimeAdmission.hardwareEligibility.state, 'refused');
    const registry = workspaceSvc.loadAgents();
    assert.equal(registry[plan.containerName]?.agentName, 'firstEnable');
    if (prepared.preparedGeneration?.preparationLease) {
        edge.abortEdgeRoutingPreparation(prepared.preparedGeneration.preparationLease, { reason: 'test-cleanup' });
    }
});

test('O.digest-refusal-current', () => {
    const { admissions } = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions });
    assert.doesNotThrow(() => assertWorkspaceGraphAdmissionsCurrent(admissions, { boxMarkerOptions }));
    assert.doesNotThrow(() => assertWorkspaceGraphAdmissionsCurrent(admissions, { boxMarkerOptions }));
});

test('O.digest-input-change', () => {
    const { admissions } = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions });
    // A changed hardware input (gate turned on and prepared) makes the
    // refused record stale even though the manifest bytes are unchanged.
    assert.throws(
        () => assertWorkspaceGraphAdmissionsCurrent(admissions, {
            boxMarkerOptions,
            hardwareContext: { gate: 'on', prepared: true, backendReady: true, controllers: ['cpu', 'memory', 'pids'] },
        }),
        { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' },
    );
    const manifestPath = path.join(workspace, '.ploinky', 'repos', 'demo', 'needy', 'manifest.json');
    const original = fs.readFileSync(manifestPath);
    try {
        fs.writeFileSync(manifestPath, JSON.stringify(limited({ memory: '256m' }), null, 2));
        assert.throws(() => assertWorkspaceGraphAdmissionsCurrent(admissions, { boxMarkerOptions }),
            { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' });
    } finally {
        fs.writeFileSync(manifestPath, original);
    }
});

test('O.metadata-cannot-render', () => {
    const { admissions } = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions });
    for (const record of admissions) {
        assert.throws(
            () => runtimeCapabilities.renderRuntimePolicyArgs(record.admission.descriptor, { runtime: 'podman' }),
            { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' },
            `metadata admission of ${record.nodeId} must not authorize rendering`,
        );
    }
});

test('O.nonhardware-still-strict', () => {
    assert.throws(
        () => preflightWorkspaceStartRuntimeCapabilities('demo/privroot', { boxMarkerOptions }),
        (error) => error.name === 'RuntimeCapabilityError' && /privileged/.test(error.message),
    );
});

test('O.blocking-diamond', () => {
    const edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]
        .map(([fromKey, toKey]) => outcomes.availabilityEdge({ fromKey, toKey, kind: 'blocking', source: 'manifest' }));
    const result = outcomes.classifyAvailability({
        nodes: [availabilityNode('a'), availabilityNode('b'), availabilityNode('c'), availabilityNode('d', REFUSED_OUTCOME('d', 'demo/d'))],
        edges,
    });
    assert.equal(result.get('d').state, 'refused');
    for (const key of ['a', 'b', 'c']) assert.equal(result.get(key).state, 'blocked', key);
    const a = result.get('a').outcome;
    assert.deepEqual(a.causalPath, ['a', 'b', 'd'], 'deterministic shortest path, lexicographic tie-break');
    assert.equal(a.additionalCauseCount, 0, 'one distinct root cause');
    assert.equal(a.rootCause.key, 'd');
});

test('O.blocking-transitive', () => {
    const result = outcomes.classifyAvailability({
        nodes: [availabilityNode('a'), availabilityNode('b'), availabilityNode('c', REFUSED_OUTCOME('c', 'demo/c')), availabilityNode('u')],
        edges: [
            outcomes.availabilityEdge({ fromKey: 'a', toKey: 'b', kind: 'blocking', source: 'manifest' }),
            outcomes.availabilityEdge({ fromKey: 'b', toKey: 'c', kind: 'blocking', source: 'manifest' }),
        ],
    });
    const a = result.get('a').outcome;
    assert.equal(a.state, 'blocked');
    assert.deepEqual(a.blockedBy, { key: 'b', ref: 'demo/b' });
    assert.deepEqual(a.causalPath, ['a', 'b', 'c']);
    assert.equal(result.get('u').state, 'eligible', 'an unrelated agent is not blocked');
    assert.match(errors.formatHardwareOutcome(a),
        /^Blocked \(dependency\): demo\/a \[a\] requires demo\/b \[b\]\. Root refusal: demo\/c \[c\], memory: The host does not delegate memory/);
});

test('O.enabled-extra', () => {
    const preflight = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions });
    const manifestPath = path.join(workspace, '.ploinky', 'repos', 'demo', 'grand', 'manifest.json');
    const extra = {
        id: 'extra:ploinky_extra_grand', agentRef: 'demo/grand', agentPath: path.dirname(manifestPath),
        alias: '', manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifestPath, profile: '',
        repoName: 'demo', shortAgentName: 'grand',
    };
    const admissions = admitWorkspaceGraphRuntimeCapabilities(preflight.graph, { additionalNodes: [extra], boxMarkerOptions });
    const availability = classifyWorkspaceGraphAvailability(preflight.graph, admissions);
    assert.equal(availability.byKey.get('ploinky_extra_grand').state, 'refused');
    assert.equal(availability.byNodeId.get('demo/plain').state, 'eligible');
});

test('O.alias-identity', () => {
    const preflight = preflightWorkspaceStartRuntimeCapabilities('demo/aliasroot', { boxMarkerOptions });
    const needy = preflight.admissions.find((record) => record.nodeId === 'demo/needy as n1');
    const plain = preflight.admissions.find((record) => record.nodeId === 'demo/plain as p2');
    assert.ok(needy.key.includes('n1'), 'an alias instance has its own exact key');
    assert.equal(needy.hardwareRefusal.key, needy.key);
    assert.equal(needy.hardwareRefusal.alias, 'n1');
    assert.equal(plain.hardwareRefusal, null);
    const availability = classifyWorkspaceGraphAvailability(preflight.graph, preflight.admissions);
    assert.equal(availability.byNodeId.get('demo/aliasroot').state, 'blocked');
    assert.equal(availability.byNodeId.get('demo/aliasroot').outcome.blockedBy.key, needy.key);
});

test('O.optional-no-wait-parent-ready', () => {
    const preflight = preflightWorkspaceStartRuntimeCapabilities('demo/optroot', { boxMarkerOptions });
    const availability = classifyWorkspaceGraphAvailability(preflight.graph, preflight.admissions);
    assert.equal(availability.byNodeId.get('demo/needy').state, 'refused');
    assert.equal(availability.byNodeId.get('demo/optroot').state, 'eligible',
        'a refused optional no-wait child never blocks its parent');
});

test('O.optional-eligibility-asynchronous', (t) => {
    const preflight = preflightWorkspaceStartRuntimeCapabilities('demo/optroot', { boxMarkerOptions });
    const waits = graphModule.classifyDependencyGraphWaitMode(preflight.graph);
    assert.ok(waits.noWait.has('demo/needy'), 'the optional child stays in the background launch set');
    // The parent publishes the known terminal outcome without a worker or
    // runtime; nothing in its synchronous path waits on the child.
    const runningDir = path.join(workspace, '.ploinky', 'running');
    const runId = '12345678-1234-4234-8234-1234567890ab';
    const schedule = workspaceUtil.bindNoWaitLaunchScheduleIdentity(buildNoWaitLaunchSchedule([
        [{ node: preflight.graph.nodes.get('demo/needy'), registryName: 'ploinky_needy_optional' }],
    ], { runId, runStartedAtMs: 1_700_000_000_000 }), {
        ploinky_needy_optional: {
            type: 'agent', repoName: 'demo', agentName: 'needy', instanceId: 'i-1', enableGeneration: 'g-1',
        },
    });
    const refusal = refusalFor(preflight.admissions, 'demo/needy');
    fs.mkdirSync(path.join(runningDir, 'no-wait'), { recursive: true, mode: 0o700 });
    workspaceUtil.writeNoWaitHardwareOutcome(schedule[0][0], { ...refusal, key: 'ploinky_needy_optional', causalPath: ['ploinky_needy_optional'], rootCause: { ...refusal.rootCause, key: 'ploinky_needy_optional' } });
    t.after(() => fs.rmSync(path.join(runningDir, 'no-wait'), { recursive: true, force: true }));
    const status = JSON.parse(fs.readFileSync(path.join(runningDir, 'no-wait', 'ploinky_needy_optional.json'), 'utf8'));
    assert.equal(status.state, 'failed');
    assert.equal(status.phase, 'admission');
    assert.equal(status.error.code, errors.HARDWARE_UNENFORCEABLE);
    assert.equal(status.error.hardwareOutcome.state, 'refused');
});

test('O.optional-child-blocking-grandchild', () => {
    const preflight = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions });
    const availability = classifyWorkspaceGraphAvailability(preflight.graph, preflight.admissions);
    assert.equal(availability.byNodeId.get('demo/grand').state, 'refused');
    assert.equal(availability.byNodeId.get('demo/opt').state, 'blocked', 'the optional child is blocked by its blocking grandchild');
    // root is blocked only by its blocking dependency needy, never by opt.
    const root = availability.byNodeId.get('demo/root').outcome;
    assert.equal(root.blockedBy.ref, 'demo/needy');
    assert.equal(root.additionalCauseCount, 0, 'the optional branch contributes no cause');
});

test('O.explicit-status-wait-blocked', async () => {
    const nodes = [availabilityNode('consumer'), availabilityNode('producer', REFUSED_OUTCOME('producer', 'demo/producer'))];
    const withoutWait = outcomes.classifyAvailability({ nodes, edges: [] });
    assert.equal(withoutWait.get('consumer').state, 'eligible');
    const withWait = outcomes.classifyAvailability({
        nodes,
        edges: outcomes.blockingEdgesFromGraph({ nodes: new Map() }, () => '', {
            explicitWaits: [{ fromKey: 'consumer', toKey: 'producer' }],
        }),
    });
    assert.equal(withWait.get('consumer').state, 'blocked');
    // The barrier converts a waited-on producer's refusal into the
    // consumer's own blocked outcome with explicit-wait causality.
    const producer = REFUSED_OUTCOME('ploinky_producer', 'demo/producer');
    const entry = { path: '/x/no-wait/ploinky_producer.r.json', runId: 'r', waveIndex: 0, directDependency: true, relation: 'explicit-status-wait' };
    await assert.rejects(
        noWaitWorker.waitForNoWaitStatusBarrier([entry], {
            runId: '12345678-1234-4234-8234-1234567890ab',
            runStartedAtMs: 1_700_000_000_000,
            waveIndex: 1,
            waitFn: async () => ({ state: 'failed', hardwareOutcome: producer }),
            consumerIdentity: { key: 'ploinky_consumer', ref: 'demo/consumer' },
        }),
        (error) => error.hardwareOutcome?.state === 'blocked'
            && error.hardwareOutcome.blockedBy.key === 'ploinky_producer'
            && error.hardwareOutcome.rootCause.key === 'ploinky_producer',
    );
});

test('O.no-synthetic-optional-wait', () => {
    const runId = '12345678-1234-4234-8234-1234567890ab';
    const runningDir = path.join(workspace, '.ploinky', 'schedule-running');
    const node = (id, dependencies, edges) => ({
        id, dependencies: new Set(dependencies), dependencyEdges: new Map(Object.entries(edges)),
    });
    const schedule = buildNoWaitLaunchSchedule([
        [{ node: node('demo/p', [], {}), registryName: 'producer' }],
        [
            { node: node('demo/opt', ['demo/p'], { 'demo/p': { noWait: true } }), registryName: 'optional-consumer' },
            { node: node('demo/blk', ['demo/p'], { 'demo/p': { noWait: false } }), registryName: 'blocking-consumer' },
        ],
    ], { runId, runStartedAtMs: 1_700_000_000_000, runningDir });
    const [optional, blocking] = schedule[1];
    assert.deepEqual(optional.waitForStatuses, [], 'an optional no-wait edge synthesizes no wait');
    assert.equal(blocking.waitForStatuses.length, 1);
    assert.equal(blocking.waitForStatuses[0].relation, 'blocking');
    assert.equal(blocking.waitForStatuses[0].producerKey, 'producer');
    const parsed = noWaitWorker.exactNoWaitBarrierEntry(blocking.waitForStatuses[0], { runningDir, expectedRunId: runId });
    assert.equal(parsed.relation, 'blocking');
    assert.equal(parsed.producerKey, 'producer');
});

test('O.cycle-wait-kind', () => {
    const warnings = [];
    const blockingCycle = graphModule.resolveWorkspaceDependencyGraph({
        staticAgentRef: 'demo/cyca', onCycle: (warning) => warnings.push(warning),
    });
    assert.equal(warnings.length, 1, 'the scheduler warning is preserved');
    assert.deepEqual(blockingCycle.nodes.get('demo/cycb').cycleBackedges.get('demo/cyca'), { noWait: false });
    const keyOf = (id) => id;
    const blockingEdges = outcomes.blockingEdgesFromGraph(blockingCycle, keyOf);
    assert.ok(blockingEdges.some((edge) => edge.fromKey === 'demo/cycb' && edge.toKey === 'demo/cyca' && edge.cycleBackedge));

    const optionalCycle = graphModule.resolveWorkspaceDependencyGraph({ staticAgentRef: 'demo/cycc', onCycle: () => {} });
    assert.deepEqual(optionalCycle.nodes.get('demo/cycd').cycleBackedges.get('demo/cycc'), { noWait: true });
    assert.equal(outcomes.blockingEdgesFromGraph(optionalCycle, keyOf).some((edge) => edge.cycleBackedge), false,
        'an optional no-wait backedge is not reinterpreted as blocking');
});

test('O.store-unknown-no-create', () => {
    const unreadable = { gate: 'on', prepared: true, backendReady: true, controllers: ['cpu', 'memory', 'pids'], storeState: 'unreadable', storeDetail: 'limits.json is a symbolic link' };
    const preflight = preflightWorkspaceStartRuntimeCapabilities('demo/root', { boxMarkerOptions, hardwareContext: unreadable });
    for (const record of preflight.admissions) {
        assert.equal(record.hardwareRefusal?.reasonCode, 'store_unreadable', record.nodeId);
    }
    // Strict admission, which precedes every physical create, refuses too.
    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, '.ploinky', 'repos', 'demo', 'plain', 'manifest.json'), 'utf8'));
    assert.throws(() => runtimeCapabilities.admitManifestRuntimeCapabilities(manifest, {
        agentId: 'demo/plain', runtime: 'podman', boxMarkerOptions, hardwareContext: unreadable,
    }), (error) => error.hardwareOutcome?.reasonCode === 'store_unreadable');
    // Internal helpers stay exempt.
    assert.doesNotThrow(() => runtimeCapabilities.admitManifestRuntimeCapabilities(manifest, {
        agentId: 'demo/plain', runtime: 'podman', boxMarkerOptions, hardwareContext: unreadable, helper: true,
    }));
});

// ---------------------------------------------------------------------------
// F1: a typed hardware outcome raised at launch (readback refusal or strict
// admission recheck) is contained exactly like a metadata refusal.

const availabilityModule = await import(new URL('../../cli/server/hardwareAvailability.mjs', import.meta.url).href);

function launchGraph() {
    // a --blocking--> b, d --blocking--> a (transitively blocked by b); c is
    // unrelated. The tracker is built exactly as startWorkspace builds it:
    // from the graph and its admissions, with no explicitWaits argument.
    const node = (id, dependencies = []) => ({
        id,
        dependencies: new Set(dependencies),
        dependencyEdges: new Map(dependencies.map((child) => [child, { noWait: false }])),
    });
    const nodes = new Map([['demo/a', node('demo/a', ['demo/b'])], ['demo/b', node('demo/b')], ['demo/c', node('demo/c')], ['demo/d', node('demo/d', ['demo/a'])]]);
    const keys = { 'demo/a': 'ploinky_demo_a', 'demo/b': 'ploinky_demo_b', 'demo/c': 'ploinky_demo_c', 'demo/d': 'ploinky_demo_d', 'extra:ploinky_demo_x': 'ploinky_demo_x', 'extra:ploinky_demo_y': 'ploinky_demo_y' };
    const admissions = Object.entries(keys).map(([nodeId, key]) => ({
        nodeId, key, alias: '', admission: { agentId: `demo/${key.split('_').pop()}` }, hardwareRefusal: null,
    }));
    const registry = Object.fromEntries(Object.values(keys).map((key) => [key, {
        agentName: key.split('_').pop(), repoName: 'demo', instanceId: `${key}-instance`, enableGeneration: `${key}-generation`,
    }]));
    return {
        graph: { nodes },
        waves: [['demo/b', 'demo/c'], ['demo/a'], ['demo/d']],
        admissions,
        registry,
        registryNameByNodeId: new Map(Object.entries(keys).filter(([nodeId]) => !nodeId.startsWith('extra:'))),
    };
}

function launchRefusal(key) {
    return new errors.HardwareLimitsError(requestedLimits.buildDirectRefusal({
        key,
        ref: `demo/${key.split('_').pop()}`,
        refusalParts: {
            reasonCode: 'unprepared',
            reason: 'This Box is not prepared for hardware limits: the applied limits disagree with the admitted ones (memory.max is max).',
            fix: 'On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart.',
            requested: [{ field: 'memory', value: '512m', source: 'manifest' }],
        },
        inputFingerprint: 'c'.repeat(64),
    }));
}

// The startWorkspace launch composition: the shared hardware containment
// (createStartLaunchContainment, which startWorkspace itself uses) over a
// stubbed per-agent launch.
async function startLaunch({ failures = {}, additionalNames = [], fixture = launchGraph(), launchOne = null, logs = [] } = {}) {
    const { graph, waves, admissions, registry, registryNameByNodeId } = fixture;
    const availability = workspaceUtil.createGraphAvailabilityTracker(graph, admissions);
    const routes = Object.fromEntries(Object.entries(registry).map(([key, record]) => [record.alias || record.agentName, { container: key, hostPort: 40000 }]));
    const log = { error: (line) => logs.push(line), warn: (line) => logs.push(line) };
    const containment = workspaceUtil.createStartLaunchContainment({
        availability,
        registry: () => registry,
        registryNameByNodeId,
        applyUnavailableRoutes: async (unavailableRoutes) => {
            for (const { routeKey, projection } of unavailableRoutes) {
                routes[routeKey] = availabilityModule.markRouteHardwareUnavailable(routes[routeKey], projection);
            }
        },
        log,
    });
    await containment.markUnavailable(availability.unavailableEntries());
    const ensureCalls = [];
    const readiness = [];
    const ensureAgentService = (name) => {
        ensureCalls.push(name);
        if (failures[name]) {
            // A launch error may arrive wrapped, keeping its typed cause.
            const error = failures[name]();
            throw errors.wrapPreservingHardwareCause(`managed launch failed: ${error.message}`, error);
        }
        return { containerName: name, hostPort: 41000 };
    };
    const launch = (names, { allowFailures = false } = {}) => containment.launchTargets(names, {
        allowFailures,
        launchOne: launchOne ? (name) => { ensureCalls.push(name); return launchOne(name, registry[name]); } : async (name) => {
            const result = ensureAgentService(name);
            const routeKey = registry[name].alias || registry[name].agentName;
            return { ok: true, containerName: result.containerName, routeKey, shortAgentName: registry[name].agentName, route: { container: name, hostPort: result.hostPort } };
        },
        commitResults: async (results) => { for (const result of results) if (result?.ok) routes[result.routeKey] = result.route; },
    });
    const waveResult = await workspaceUtil.launchWorkspaceGraphWaves({
        graphWaves: waves, nodes: graph.nodes, registryNameByNodeId, availability, launch,
        readinessEntryFor: (node) => registryNameByNodeId.get(node.id),
        waitForReadiness: async (entries) => { readiness.push(...entries); },
        reportOutcome: containment.reportOutcome, log() {},
    });
    const extra = await workspaceUtil.launchAdditionalRuntimes({
        additionalNames, availability, launch,
        readinessEntryFor: (result) => result.containerName,
        waitForReadiness: async (entries) => { readiness.push(...entries); },
        reportOutcome: containment.reportOutcome,
    });
    const summary = outcomes.summarizeStartResult({
        readyAgents: [...waveResult.readyAgentKeys, ...extra.readyAgentKeys].map((key) => ({ key })),
        refusedAgents: containment.hardwareOutcomes.refused,
        blockedAgents: containment.hardwareOutcomes.blocked,
    });
    return { routes, ensureCalls, readiness, summary, availability, logs };
}

test('O.launch-refusal-blocks-dependants', async () => {
    const result = await startLaunch({ failures: { ploinky_demo_b: () => launchRefusal('ploinky_demo_b') } });
    // No throw. b was attempted; its blocking consumer a and a's blocking
    // consumer d were never launched; unrelated c started and was waited for.
    assert.deepEqual(result.ensureCalls.sort(), ['ploinky_demo_b', 'ploinky_demo_c']);
    assert.deepEqual(result.readiness, ['ploinky_demo_c']);
    assert.equal(result.summary.state, 'degraded');
    assert.deepEqual(result.summary.readyAgents.entries.map((entry) => entry.key), ['ploinky_demo_c']);
    assert.deepEqual(result.summary.refusedAgents.entries.map((entry) => entry.key), ['ploinky_demo_b']);
    assert.deepEqual(result.summary.blockedAgents.entries.map((entry) => entry.key).sort(), ['ploinky_demo_a', 'ploinky_demo_d']);
    const blocked = result.availability.outcomeForKey('ploinky_demo_a');
    assert.equal(blocked.code, errors.HARDWARE_DEPENDENCY_BLOCKED);
    assert.equal(blocked.rootCause.key, 'ploinky_demo_b');
    // The availability projection is written: refused/blocked routes lose
    // their targets; the unrelated route keeps its target.
    const compiled = availabilityModule.compileHardwareAvailability({ routes: result.routes });
    assert.deepEqual(Object.keys(compiled).sort(), ['a', 'b', 'd']);
    assert.equal(compiled.b.state, 'refused');
    assert.equal(compiled.a.state, 'blocked');
    assert.equal(result.routes.b.hostPort, undefined);
    assert.equal(result.routes.c.hostPort, 41000);
});

test('O.launch-refusal-extra-contained', async () => {
    const result = await startLaunch({
        additionalNames: ['ploinky_demo_x', 'ploinky_demo_y'],
        failures: { ploinky_demo_x: () => launchRefusal('ploinky_demo_x') },
    });
    // No 'additional runtime failure' throw; the other extra is active and ready.
    assert.ok(result.ensureCalls.includes('ploinky_demo_y'));
    assert.ok(result.readiness.includes('ploinky_demo_y'));
    assert.equal(result.routes.y.hostPort, 41000);
    assert.equal(result.routes.x.hostPort, undefined);
    assert.equal(result.routes.x.hardwareAvailability.state, 'refused');
    assert.deepEqual(result.summary.refusedAgents.entries.map((entry) => entry.key), ['ploinky_demo_x']);
    assert.equal(result.summary.blockedAgents.count, 0);
    const compiled = availabilityModule.compileHardwareAvailability({ routes: result.routes });
    assert.deepEqual(Object.keys(compiled), ['x']);
});

test('O.launch-nonhardware-still-throws', async () => {
    // An ordinary graph launch failure keeps the baseline fatal error.
    await assert.rejects(
        startLaunch({ failures: { ploinky_demo_b: () => new Error('podman create failed') } }),
        /^Error: 1 agent\(s\) failed to start: b$/,
    );
    // An ordinary extra failure keeps the baseline selector error.
    await assert.rejects(
        startLaunch({ additionalNames: ['ploinky_demo_x'], failures: { ploinky_demo_x: () => new Error('podman create failed') } }),
        /additional runtime failure left edge selectors inactive; repair and run start again/,
    );
});

// ---------------------------------------------------------------------------
// Fix round 2: refusals raised by ensureAgentService's strict preflight carry
// the exact admitted instance key (K2); a refused candidate that could not be
// removed fails the start (K4).

const serviceManager = await import(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url).href);

const PREPARED_CONTEXT = Object.freeze({
    gate: 'on', prepared: true, backendReady: true, controllers: ['cpu', 'memory', 'pids'], storeState: 'valid',
    storeToken: { epoch: 'e'.repeat(32), revision: 1 }, overrides: new Map(), envelope: { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
});
// The memory controller disappeared after graph admission.
const REFUSING_CONTEXT = Object.freeze({ ...PREPARED_CONTEXT, controllers: ['cpu', 'pids'] });

// A real graph admitted (eligible) at preflight, with a registry shaped like
// staging's: one record per exact registry key.
function admittedGraph(staticRef) {
    const preflight = preflightWorkspaceStartRuntimeCapabilities(staticRef, { boxMarkerOptions });
    const admissions = admitWorkspaceGraphRuntimeCapabilities(preflight.graph, { boxMarkerOptions, hardwareContext: PREPARED_CONTEXT });
    assert.ok(admissions.every((record) => record.hardwareRefusal === null), 'every node is eligible at graph admission');
    const registry = {};
    const registryNameByNodeId = new Map();
    for (const record of admissions) {
        const node = preflight.graph.nodes.get(record.nodeId);
        registry[record.key] = {
            type: 'agent', agentName: node.shortAgentName, repoName: node.repoName, ...(node.alias ? { alias: node.alias } : {}),
            instanceId: `${record.key}-instance`, enableGeneration: `${record.key}-generation`,
        };
        registryNameByNodeId.set(record.nodeId, record.key);
    }
    return {
        graph: preflight.graph,
        waves: graphModule.topologicallyGroupDependencyGraph(preflight.graph),
        admissions,
        registry,
        registryNameByNodeId,
    };
}

// The options startWorkspace passes ensureAgentService for one registry record.
function startWorkspaceServiceOptions(name, rec, { containerName = name } = {}) {
    return {
        containerName,
        alias: rec.alias,
        routerEndpoint: null,
        profileName: rec.profile || undefined,
        instanceId: rec.instanceId,
        enableGeneration: rec.enableGeneration,
        forceRecreate: false,
        preservePreparedRegistryRecord: true,
        preparationLease: null,
        preparedHostModeCapability: undefined,
        networkLifecycleCapability: {},
    };
}

test('O.service-preflight-refusal-contained', async () => {
    for (const [label, staticRef, refusedNodeId, consumerNodeId, unrelatedNodeId, staged] of [
        ['canonical', 'demo/root', 'demo/needy', 'demo/root', 'demo/plain', false],
        ['aliased', 'demo/aliasroot', 'demo/needy as n1', 'demo/aliasroot', 'demo/plain as p2', false],
        ['staged replacement', 'demo/aliasroot', 'demo/needy as n1', 'demo/aliasroot', 'demo/plain as p2', true],
    ]) {
        const fixture = admittedGraph(staticRef);
        const refusedKey = fixture.registryNameByNodeId.get(refusedNodeId);
        const seen = [];
        const result = await startLaunch({
            fixture,
            launchOne: async (name, rec) => {
                const manifestPath = path.join(workspace, '.ploinky', 'repos', rec.repoName, rec.agentName, 'manifest.json');
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const containerName = staged && name === refusedKey
                    ? serviceManager.replacementCandidateContainerName(name, 'replacement-instance')
                    : name;
                try {
                    // ensureAgentService's own strict preflight, with its real options.
                    serviceManager.admitAgentServicePreflight(rec.agentName, manifest, path.dirname(manifestPath),
                        startWorkspaceServiceOptions(name, rec, { containerName }),
                        { boxMarkerOptions, hardwareContext: name === refusedKey ? REFUSING_CONTEXT : PREPARED_CONTEXT });
                } catch (error) {
                    const outcome = errors.findHardwareOutcome(error);
                    if (outcome) seen.push(outcome);
                    throw error;
                }
                return { ok: true, containerName: name, routeKey: rec.alias || rec.agentName, shortAgentName: rec.agentName, route: { container: name, hostPort: 41000 } };
            },
        });
        // The refusal names the admitted instance: its registry key and alias.
        assert.equal(seen.length, 1, label);
        assert.equal(seen[0].key, refusedKey, `${label}: keyed by the admitted registry key, never REPO/AGENT`);
        assert.equal(seen[0].ref, 'demo/needy', label);
        assert.equal(seen[0].alias, refusedNodeId.includes(' as ') ? 'n1' : null, label);
        assert.equal(seen[0].reasonCode, 'controller_unavailable', label);
        // Contained: the blocking consumer is BLOCKED and never launched, the
        // refused node is not waited on, and the unrelated agent starts.
        const consumerKey = fixture.registryNameByNodeId.get(consumerNodeId);
        const unrelatedKey = fixture.registryNameByNodeId.get(unrelatedNodeId);
        assert.equal(result.availability.outcomeForKey(refusedKey)?.state, 'refused', label);
        assert.equal(result.availability.outcomeForKey(consumerKey)?.state, 'blocked', label);
        assert.equal(result.availability.outcomeForKey(consumerKey).rootCause.key, refusedKey, label);
        assert.equal(result.ensureCalls.includes(consumerKey), false, `${label}: the blocked consumer was never launched`);
        assert.equal(result.readiness.includes(refusedKey), false, `${label}: the refused node is not waited on`);
        assert.ok(result.readiness.includes(unrelatedKey), `${label}: the unrelated agent started`);
        assert.equal(result.summary.state, 'degraded', label);
    }
});

test('O.launch-refusal-ref-mapping', () => {
    // A refusal keyed outside the admitted keys whose ref matches an admitted
    // instance is mapped by ref and alias, or fails loudly; never an extra.
    const fixture = launchGraph();
    const tracker = workspaceUtil.createGraphAvailabilityTracker(fixture.graph, fixture.admissions);
    const keyedByRef = requestedLimits.buildDirectRefusal({
        key: 'demo/b', ref: 'demo/b',
        refusalParts: { reasonCode: 'unprepared', reason: 'r', fix: 'f', requested: [{ field: 'memory', value: '512m', source: 'manifest' }] },
        inputFingerprint: 'c'.repeat(64),
    });
    const affected = tracker.recordLaunchRefusal(keyedByRef);
    assert.equal(affected[0].key, 'ploinky_demo_b', 'mapped to the admitted instance');
    assert.equal(tracker.outcomeForKey('ploinky_demo_a').state, 'blocked');
    const ambiguous = launchGraph();
    ambiguous.admissions.push({ nodeId: 'demo/b as two', key: 'ploinky_demo_b_two', alias: 'two', admission: { agentId: 'demo/b' }, hardwareRefusal: null });
    const second = workspaceUtil.createGraphAvailabilityTracker(ambiguous.graph, ambiguous.admissions);
    const unmatched = requestedLimits.buildDirectRefusal({
        key: 'ploinky_demo_b_three', ref: 'demo/b', alias: 'three',
        refusalParts: { reasonCode: 'unprepared', reason: 'r', fix: 'f', requested: [{ field: 'memory', value: '512m', source: 'manifest' }] },
        inputFingerprint: 'c'.repeat(64),
    });
    assert.throws(() => second.recordLaunchRefusal(unmatched), /matches the admitted instances ploinky_demo_b, ploinky_demo_b_two but not exactly one by alias/);
});

test('O.launch-refusal-cleanup-failure-fails', async () => {
    // K4: a refusal whose candidate could not be removed is not contained:
    // the start fails loudly and names the leftover container.
    const failedCleanup = () => {
        const error = launchRefusal('ploinky_demo_b');
        Object.defineProperty(error, 'ploinkyRestartCandidate', {
            value: { containerName: 'ploinky_demo_b', containerId: 'a'.repeat(64), exactCleanupPerformed: false },
        });
        serviceManager.cleanupFailedServiceCandidate(error, {
            containerName: 'ploinky_demo_b',
            network: { mode: 'default' },
            fallbackRecord: { type: 'agent', agentName: 'b', repoName: 'demo' },
            removeCandidate: () => { throw new Error('ownership mismatch'); },
        });
        return error;
    };
    const logs = [];
    await assert.rejects(startLaunch({ failures: { ploinky_demo_b: failedCleanup }, logs }), /^Error: 1 agent\(s\) failed to start: b$/);
    assert.ok(logs.some((line) => /exact candidate cleanup failed: ownership mismatch; the refused candidate container ploinky_demo_b \(aaaaaaaaaaaa\) was not removed; remove it, then run start again$/.test(line)), logs.join('\n'));
    // An extra with the same failure keeps the baseline selector error.
    await assert.rejects(startLaunch({ additionalNames: ['ploinky_demo_x'], failures: { ploinky_demo_x: failedCleanup } }),
        /additional runtime failure left edge selectors inactive; repair and run start again/);
});

test('O.managed-refusal-candidate-removed', () => {
    // K4: startAgentContainer leaves a refused managed-network candidate to
    // its caller; ensureAgentService's cleanup removes that exact candidate
    // and retires its durable record.
    const error = launchRefusal('ploinky_demo_b');
    Object.defineProperty(error, 'ploinkyRestartCandidate', {
        value: { containerName: 'ploinky_demo_b', containerId: 'b'.repeat(64), exactCleanupPerformed: false, durableCandidate: { operationId: 'op-1' } },
    });
    const removed = [];
    const retired = [];
    const result = serviceManager.cleanupFailedServiceCandidate(error, {
        containerName: 'ploinky_demo_b',
        network: { mode: 'bridge' },
        fallbackRecord: { type: 'agent', agentName: 'b', repoName: 'demo' },
        removeCandidate: (candidate) => { removed.push(candidate); return { removed: true, state: 'removed' }; },
        retireCandidate: (candidate) => { retired.push(candidate); },
    });
    assert.deepEqual(removed.map((candidate) => [candidate.containerName, candidate.containerId, candidate.network.mode]), [['ploinky_demo_b', 'b'.repeat(64), 'bridge']]);
    assert.equal(result.exactCleanupPerformed, true);
    assert.deepEqual(retired, [{ operationId: 'op-1' }]);
    assert.equal(serviceManager.exactCleanupFailureOf(error), null, 'nothing was left behind');
    // An already removed candidate is not removed twice.
    const done = launchRefusal('ploinky_demo_b');
    Object.defineProperty(done, 'ploinkyRestartCandidate', { value: { containerId: 'b'.repeat(64), exactCleanupPerformed: true } });
    serviceManager.cleanupFailedServiceCandidate(done, { containerName: 'ploinky_demo_b', network: {}, removeCandidate: () => assert.fail('removed twice') });
});

// ---------------------------------------------------------------------------
// The start composition with an MPS graph-preparation refusal: the real
// prepareMpsGraph contains a pre-mutation failure as refusals of the GPU-share
// agents, recordMpsGraphPreparation (what startWorkspace calls) folds them into
// the start's availability, and the shared containment and wave launcher
// start Explorer and the CPU-only agent while only the GPU agent is refused.
const mpsGraphModule = await import(new URL('../../cli/sandbox/hardwareLimits/mpsGraph.mjs', import.meta.url).href);
const mpsEligibility = await import(new URL('../../cli/sandbox/hardwareLimits/mpsEligibility.mjs', import.meta.url).href);

test('O.mps-graph-refusal-starts-cpu-agents-and-explorer', async () => {
    const node = (id, dependencies = []) => ({ id, dependencies: new Set(dependencies), dependencyEdges: new Map(dependencies.map((child) => [child, { noWait: false }])) });
    // explorer --blocking--> cpu; gpu is an independent GPU-share agent.
    const nodes = new Map([['demo/explorer', node('demo/explorer', ['demo/cpu'])], ['demo/cpu', node('demo/cpu')], ['demo/gpu', node('demo/gpu')]]);
    const keys = { 'demo/explorer': 'ploinky_demo_explorer', 'demo/cpu': 'ploinky_demo_cpu', 'demo/gpu': 'ploinky_demo_gpu' };
    const admissions = Object.entries(keys).map(([nodeId, key]) => ({ nodeId, key, alias: '', admission: { agentId: nodeId }, hardwareRefusal: null }));
    const registry = Object.fromEntries(Object.entries(keys).map(([nodeId, key]) => [key, { type: 'agent', repoName: 'demo', agentName: nodeId.split('/')[1], instanceId: `${key}-i`, enableGeneration: `${key}-g`, containerId: null }]));
    const registryNameByNodeId = new Map(Object.entries(keys));
    const graph = { nodes };
    const availability = workspaceUtil.createGraphAvailabilityTracker(graph, admissions);
    const unavailableNodeIds = new Set(availability.unavailableEntries().map((entry) => entry.nodeId));
    const warnings = [];
    const share = { smPercent: 25, vramPercent: 25, memoryMiB: 1024, deviceUuid: 'GPU-12345678-1234-1234-1234-123456789012', driverVersion: '550.1', wiringFingerprint: 'f'.repeat(64) };
    const prepared = await mpsGraphModule.prepareMpsGraph({
        nodes: Object.entries(keys).map(([nodeId, key]) => ({ key, node: { agentRef: nodeId, manifest: {} } })), networkLifecycleCapability: {},
    }, {
        readContext: () => ({ gate: 'on', overrides: new Map([['demo/gpu', { gpu: { smPercent: 25, vramPercent: 25 } }]]), storeToken: { epoch: '0'.repeat(32), revision: 1 }, gpu: {} }),
        loadRegistry: () => registry, readApplied: () => null, store: { read: () => null, write: () => assert.fail('no journal write') },
        backend: { observe: () => ({ state: 'gone' }), verify: () => false, stop: () => assert.fail('no daemon change'), start: () => assert.fail('no daemon change') },
        assertCapability: () => {}, readSelection: () => ({ selector: { state: 'inactive' } }), resolveShare: () => share, runtime: () => 'podman',
        observeClients: () => { throw new mpsEligibility.MpsError('The complete MPS client inventory is unavailable'); },
    });
    workspaceUtil.recordMpsGraphPreparation(prepared, { availability, unavailableNodeIds, warn: (line) => warnings.push(line) });
    assert.deepEqual([...unavailableNodeIds], ['demo/gpu']);
    assert.match(warnings[0], /inventory is unavailable/);
    const routes = Object.fromEntries(Object.entries(registry).map(([key, record]) => [record.agentName, { container: key, hostPort: 40000 }]));
    const containment = workspaceUtil.createStartLaunchContainment({
        availability, registry: () => registry, registryNameByNodeId,
        applyUnavailableRoutes: async (unavailableRoutes) => { for (const { routeKey, projection } of unavailableRoutes) routes[routeKey] = availabilityModule.markRouteHardwareUnavailable(routes[routeKey], projection); },
        log: { error() {}, warn() {} },
    });
    await containment.markUnavailable(availability.unavailableEntries());
    const ensureCalls = []; const readiness = [];
    const launch = (names) => containment.launchTargets(names, {
        launchOne: async (name) => { ensureCalls.push(name); const routeKey = registry[name].agentName; return { ok: true, containerName: name, routeKey, shortAgentName: routeKey, route: { container: name, hostPort: 41000 } }; },
        commitResults: async (results) => { for (const result of results) if (result?.ok) routes[result.routeKey] = result.route; },
    });
    const waves = await workspaceUtil.launchWorkspaceGraphWaves({
        graphWaves: [['demo/cpu', 'demo/gpu'], ['demo/explorer']], nodes, registryNameByNodeId, availability, launch,
        readinessEntryFor: (entry) => registryNameByNodeId.get(entry.id), waitForReadiness: async (entries) => { readiness.push(...entries); },
        reportOutcome: containment.reportOutcome, log() {},
    });
    const summary = outcomes.summarizeStartResult({
        readyAgents: waves.readyAgentKeys.map((key) => ({ key })),
        refusedAgents: containment.hardwareOutcomes.refused, blockedAgents: containment.hardwareOutcomes.blocked,
    });
    assert.deepEqual(ensureCalls.sort(), ['ploinky_demo_cpu', 'ploinky_demo_explorer']);
    assert.deepEqual(readiness.sort(), ['ploinky_demo_cpu', 'ploinky_demo_explorer']);
    assert.equal(summary.state, 'degraded');
    assert.deepEqual(summary.refusedAgents.entries.map((entry) => entry.key), ['ploinky_demo_gpu']);
    assert.equal(summary.blockedAgents.count, 0);
    const refusal = availability.outcomeForKey('ploinky_demo_gpu');
    assert.equal(refusal.reasonCode, 'gpu_sharing_unavailable');
    assert.match(refusal.reason, /inventory is unavailable/);
    assert.ok(refusal.fix.length > 0);
    assert.equal(routes.gpu.hostPort, undefined);
    assert.equal(routes.gpu.hardwareAvailability.state, 'refused');
    assert.equal(routes.explorer.hostPort, 41000);
    assert.equal(routes.cpu.hostPort, 41000);
});
