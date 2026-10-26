import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const originalCwd = process.cwd();
const priorRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-draining-admission-')));
fs.mkdirSync(path.join(tempDir, '.ploinky'), { recursive: true });
fs.writeFileSync(path.join(tempDir, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080, routes: {} }));
process.env.PLOINKY_WORKSPACE_ROOT = tempDir;
process.chdir(tempDir);
test.after(() => {
    process.chdir(originalCwd);
    if (priorRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = priorRoot;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const { assertAgentServiceNotDraining } = await import('../../cli/sandbox/docker/agentServiceManager.js');
const { ensureGraphNodesEnabled } = await import('../../cli/commands/workspaceUtil.js');

test('a failed targeted drain blocks later automatic admission of the same runtime owner', () => {
    const loadRouting = () => ({ routes: {
        office: { container: 'exact-owner', draining: true },
    } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(() => assertAgentServiceNotDraining('exact-owner', { loadRouting }), {
            code: 'PLOINKY_AGENT_DRAINING',
        });
    }
    assert.doesNotThrow(() => assertAgentServiceNotDraining('another-owner', { loadRouting }));
});

test('only the coordinated targeted restart may proceed while its predecessor remains draining', () => {
    assert.doesNotThrow(() => assertAgentServiceNotDraining('exact-owner', {
        targetedRestart: true,
        loadRouting() { throw new Error('Targeted restart validates its own selected drain generation.'); },
    }));
});

test('cleared or absent drain state permits ordinary admission', () => {
    for (const routing of [null, {}, { routes: { office: { container: 'exact-owner', draining: false } } }]) {
        assert.doesNotThrow(() => assertAgentServiceNotDraining('exact-owner', { loadRouting: () => routing }));
    }
});

function graphNode(overrides = {}) {
    return {
        id: 'demo/worker', repoName: 'demo', shortAgentName: 'worker', alias: '',
        agentRef: 'demo/worker', enableSpec: 'demo/worker global', profile: 'default', isStatic: false,
        manifest: { container: 'node:20-alpine', network: { mode: 'none' } },
        ...overrides,
    };
}

// Runs the start graph with a fake engine over a route whose targeted drain
// was refused, and records every revocation, rotation and removal.
function runGraphOverDrainingRoute({
    node = graphNode(), additionalNodes = [], noWait = false, hardwareUnavailable = false,
    supersededRun = false, running = false, runtimeReason = '', observeReason, draining = true, drainOwner,
} = {}) {
    const nodes = [node, ...additionalNodes];
    const registry = Object.fromEntries(nodes.map((entry) => [`${entry.shortAgentName}_container`, {
        type: 'agent', repoName: entry.repoName, agentName: entry.shortAgentName, runMode: 'global', projectPath: tempDir,
        profile: 'default', instanceId: `retained-${entry.shortAgentName}-instance`,
        enableGeneration: `retained-${entry.shortAgentName}-generation`, containerId: 'a'.repeat(64),
        ...(entry.alias ? { alias: entry.alias } : {}),
    }]));
    const originalRegistry = structuredClone(registry);
    const record = registry.worker_container;
    const events = [];
    const lines = [];
    const saved = [];
    const observations = [];
    const supersededRuns = [];
    const supersede = (key = 'worker_container', overrides = {}) => {
        const predecessor = originalRegistry[key];
        supersededRuns.push({ identity: {
            containerName: key, instanceId: predecessor.instanceId, enableGeneration: predecessor.enableGeneration,
            repoName: predecessor.repoName, shortAgent: predecessor.agentName, alias: predecessor.alias || '',
            ...overrides,
        } });
    };
    if (supersededRun) supersede();
    const replacementOptions = {
        containerExistsImpl: () => true,
        isContainerRunningImpl: () => running,
        getRuntimeForAgentImpl: () => 'podman',
        getRuntimeImpl: () => 'podman',
    };
    const run = () => ensureGraphNodesEnabled({ nodes: new Map(nodes.map((entry) => [entry.id, entry])) }, registry, {
        logLine(line) { lines.push(line); events.push('line'); },
        runtimeReplacementReason(plan, options) {
            observations.push({ plan, options, effects: [...events] });
            return observeReason ? observeReason(plan, options) : runtimeReason;
        },
        runtimeReplacementOptions: replacementOptions,
        deferredNodeIds: new Set(noWait ? nodes.map((entry) => entry.id) : []),
        unavailableNodeIds: new Set(hardwareUnavailable ? nodes.map((entry) => entry.id) : []),
        supersededNoWaitRuns: supersededRuns,
        inactivateGeneration() { events.push('inactivate'); },
        loadRouting() {
            return { routes: Object.fromEntries(nodes.map((entry) => [entry.alias || entry.shortAgentName, {
                container: `${entry.shortAgentName}_container`, repo: entry.repoName, agent: entry.shortAgentName,
                draining, hostPort: 41001, ...(drainOwner ? { drainOwner } : {}),
            }])) };
        },
        saveRouting(routing) { events.push('save-routing'); saved.push(structuredClone(routing)); },
        saveAgents() { events.push('save-agents'); },
        retireNoWaitMarkers() { events.push('retire-markers'); },
        prepareAgentEnableBatch() { events.push('prepare'); return { plans: [], preparedGeneration: { selector: { state: 'inactive' } } }; },
        removeAgentContainerForRecreate() { events.push('remove'); },
        readRuntimePredecessorImpl: () => null,
        writeRuntimePredecessorImpl() { events.push('write-predecessor'); return null; },
        retireRuntimePredecessorImpl() { events.push('retire-predecessor'); },
        uuid: randomUUID,
        executionRecordOptions: { workspaceRoot: tempDir },
    });
    return { run, events, lines, saved, registry, originalRegistry, record: structuredClone(record), nodes,
        observations, replacementOptions, supersede };
}

test('workspace start refuses to replace the stopped predecessor of a refused targeted drain on a blocking node before changing anything', () => {
    const graph = runGraphOverDrainingRoute({ node: graphNode({ profile: 'embedded' }) });
    assert.throws(graph.run, { code: 'PLOINKY_AGENT_DRAINING' });
    assert.deepEqual(graph.events, [], 'no line, revocation, rotation, receipt or removal');
    assert.deepEqual(graph.registry.worker_container, graph.record, 'the predecessor keeps its exact runtime identity');
});

test('workspace graph recovers an automatic drain owned by its exact registered predecessor', () => {
    const graph = runGraphOverDrainingRoute({ runtimeReason: 'runtimeStopped', drainOwner: {
        containerName: 'worker_container', instanceId: 'retained-worker-instance', enableGeneration: 'retained-worker-generation',
    } });
    assert.deepEqual(graph.run().changedContainers, ['worker_container']);
    assert.ok(graph.events.includes('remove'));
    assert.ok(graph.events.includes('write-predecessor'));
    assert.notEqual(graph.registry.worker_container.instanceId, graph.record.instanceId);
});

for (const field of ['containerName', 'instanceId', 'enableGeneration', 'manual']) {
    test(`workspace graph rejects ${field === 'manual' ? 'ownerless manual' : `mismatched ${field} automatic`} drain before mutation`, () => {
        const drainOwner = field === 'manual' ? undefined : {
            containerName: 'worker_container', instanceId: 'retained-worker-instance', enableGeneration: 'retained-worker-generation',
            [field]: 'another-owner',
        };
        const graph = runGraphOverDrainingRoute({ runtimeReason: 'runtimeStopped', drainOwner });
        assertRefusedWithoutEffects(graph);
    });
}

test('workspace start keeps the refused-drain predecessor of a no-wait or hardware-refused node and lets the graph continue', () => {
    for (const scenario of [
        { noWait: true, node: graphNode({ profile: 'embedded' }), reason: 'profile changed: default -> embedded' },
        { noWait: true, runtimeReason: 'runtimeStopped', reason: 'runtimeStopped' },
        { hardwareUnavailable: true, reason: 'hardwareUnavailable' },
    ]) {
        const graph = runGraphOverDrainingRoute(scenario);
        const result = graph.run();
        assert.deepEqual(result.changedContainers, [], scenario.reason);
        assert.equal(graph.events.includes('remove'), false, scenario.reason);
        assert.equal(graph.events.includes('write-predecessor'), false, scenario.reason);
        assert.deepEqual(graph.registry.worker_container, graph.record, `${scenario.reason}: no identity rotation or record change`);
        assert.equal(graph.lines.length, 1, scenario.reason);
        assert.match(graph.lines[0], /^\[start\] demo\/worker: keeping its stopped runtime after a refused targeted drain/);
        assert.ok(graph.lines[0].includes(scenario.reason), graph.lines[0]);
        assert.ok(graph.lines[0].includes("'ploinky restart worker --accept-failed-drain <container-id>'"), graph.lines[0]);
        const route = graph.saved.at(-1).routes.worker;
        assert.equal(route.draining, true, `${scenario.reason}: the route stays draining`);
        assert.equal(route.hostPort, undefined, `${scenario.reason}: and target-less in the prelaunch generation`);
    }
});

test('a superseded no-wait run of a draining node still refuses the whole graph', () => {
    const graph = runGraphOverDrainingRoute({ noWait: true, supersededRun: true });
    assert.throws(graph.run, { code: 'PLOINKY_AGENT_DRAINING' });
    assert.deepEqual(graph.events, []);
    assert.deepEqual(graph.registry.worker_container, graph.record);
});

test('workspace start leaves an unchanged draining runtime in place for the admission gate', () => {
    const graph = runGraphOverDrainingRoute({ running: true });
    assert.equal(graph.run().changedContainers.length, 0);
    assert.equal(graph.events.includes('remove'), false);
    assert.deepEqual(graph.lines, []);
    assert.deepEqual(graph.registry.worker_container, graph.record);
});

const changedNodeScenarios = [
    ['profile', { node: graphNode({ profile: 'embedded' }), noWait: true }],
    ['execution', { node: graphNode({ enableSpec: 'demo/worker isolated' }), noWait: true }],
    ['hardware', { hardwareUnavailable: true }],
];

function assertRefusedWithoutEffects(graph, attempts = 2) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        assert.throws(graph.run, { code: 'PLOINKY_AGENT_DRAINING' });
        assert.deepEqual(graph.events, [], 'the whole call refuses before logging, preparation or mutation');
        assert.deepEqual(graph.lines, []);
        assert.deepEqual(graph.saved, []);
        assert.deepEqual(graph.registry, graph.originalRegistry, 'every exact predecessor tuple stays unchanged');
    }
}

for (const [change, options] of changedNodeScenarios) {
    test(`an exact superseded worker still refuses containment when ${change} selects the displayed reason`, () => {
        const graph = runGraphOverDrainingRoute({ ...options, supersededRun: true });
        assertRefusedWithoutEffects(graph);
        assert.equal(graph.observations.length, 0, 'exact supersession needs no extra runtime observation');
    });

    test(`an MPS transition still refuses containment when ${change} selects the displayed reason`, () => {
        const graph = runGraphOverDrainingRoute({ ...options, runtimeReason: 'mpsCohortTransition' });
        assertRefusedWithoutEffects(graph);
        assert.equal(graph.observations.length, 2, 'each refused invocation observes the hidden MPS fact once');
        for (const observation of graph.observations) {
            assert.deepEqual(observation.effects, []);
            assert.equal(observation.options, graph.replacementOptions);
            assert.equal(observation.plan.node, graph.nodes[0]);
        }
    });
}

function laterNode() {
    return graphNode({ id: 'demo/zworker', shortAgentName: 'zworker', agentRef: 'demo/zworker',
        enableSpec: 'demo/zworker global', profile: 'embedded' });
}

for (const forbidden of ['superseded', 'mps']) {
    test(`a later ${forbidden} plan prevents an earlier containable plan from logging or changing state`, () => {
        const graph = runGraphOverDrainingRoute({
            node: graphNode({ profile: 'embedded' }), additionalNodes: [laterNode()], noWait: true,
            observeReason: (plan) => forbidden === 'mps' && plan.existing.key === 'zworker_container'
                ? 'mpsCohortTransition' : '',
        });
        if (forbidden === 'superseded') graph.supersede('zworker_container');
        assertRefusedWithoutEffects(graph);
        assert.deepEqual(graph.observations.map(({ plan }) => plan.existing.key), forbidden === 'superseded'
            ? ['worker_container', 'worker_container']
            : ['worker_container', 'zworker_container', 'worker_container', 'zworker_container']);
    });
}

for (const [field, value] of [
    ['containerName', 'another_container'], ['instanceId', 'another-instance'],
    ['enableGeneration', 'another-generation'], ['repoName', 'another-repo'],
    ['shortAgent', 'another-agent'], ['alias', 'another-alias'],
]) {
    test(`a superseded tuple with a different ${field} does not exclude ordinary containment`, () => {
        const graph = runGraphOverDrainingRoute({ node: graphNode({ profile: 'embedded' }), noWait: true });
        graph.supersede('worker_container', { [field]: value });
        assert.deepEqual(graph.run().changedContainers, []);
        assert.deepEqual(graph.registry, graph.originalRegistry);
        assert.equal(graph.observations.length, 1);
        assert.equal(graph.events.includes('remove'), false);
        assert.equal(graph.events.includes('write-predecessor'), false);
        assert.equal(graph.saved.at(-1).routes.worker.draining, true);
        assert.equal(graph.saved.at(-1).routes.worker.hostPort, undefined);
    });
}

test('a previously observed runtime reason and its preliminary detail are reused at the drain gate', () => {
    const graph = runGraphOverDrainingRoute({ noWait: true, observeReason(plan, options) {
        assert.equal(options, graph.replacementOptions);
        plan.runtimeReasonDetail = 'fixture runtime detail';
        return 'runtimeStopped';
    } });
    assert.deepEqual(graph.run().changedContainers, []);
    assert.equal(graph.observations.length, 1);
    assert.ok(graph.lines[0].includes('(runtimeStopped: fixture runtime detail)'), graph.lines[0]);
    assert.deepEqual(graph.observations[0].effects, []);
});

for (const scenario of [
    { node: graphNode({ profile: 'embedded' }), noWait: true, reason: 'profile changed: default -> embedded' },
    { node: graphNode({ enableSpec: 'demo/worker isolated' }), noWait: true, reason: 'execution changed: runMode global -> isolated' },
    { hardwareUnavailable: true, reason: 'hardwareUnavailable' },
]) {
    test(`lazy non-MPS observation keeps containment and diagnostic precedence for ${scenario.reason}`, () => {
        const graph = runGraphOverDrainingRoute({ ...scenario, observeReason(plan) {
            plan.runtimeReasonDetail = 'unselected runtime detail';
            return 'runtimeStopped';
        } });
        assert.deepEqual(graph.run().changedContainers, []);
        assert.equal(graph.observations.length, 1);
        assert.ok(graph.lines[0].includes(scenario.reason), graph.lines[0]);
        assert.equal(graph.lines[0].includes('runtimeStopped'), false);
        assert.equal(graph.lines[0].includes('unselected runtime detail'), false);
        assert.deepEqual(graph.registry, graph.originalRegistry);
    });
}

test('a hidden runtime observation error propagates before effects, including earlier containable plans', () => {
    const failure = new Error('fixture runtime observation failed');
    const graph = runGraphOverDrainingRoute({
        node: graphNode({ profile: 'embedded' }), additionalNodes: [laterNode()], noWait: true,
        observeReason(plan) { if (plan.existing.key === 'zworker_container') throw failure; return ''; },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(graph.run, (error) => error === failure);
        assert.deepEqual(graph.events, []);
        assert.deepEqual(graph.registry, graph.originalRegistry);
    }
    assert.deepEqual(graph.observations.map(({ plan }) => plan.existing.key),
        ['worker_container', 'zworker_container', 'worker_container', 'zworker_container']);
});

test('blocking or non-draining profile changes do not gain a skipped runtime observation', () => {
    for (const draining of [true, false]) {
        const graph = runGraphOverDrainingRoute({ node: graphNode({ profile: 'embedded' }), draining,
            observeReason() { throw new Error('must not observe this changed plan'); } });
        if (draining) assertRefusedWithoutEffects(graph);
        else assert.deepEqual(graph.run().changedContainers, ['worker_container']);
        assert.equal(graph.observations.length, 0);
    }
});

for (const [change, options] of changedNodeScenarios) {
    test(`a non-draining ${change} plan does not gain a skipped runtime observation`, () => {
        const graph = runGraphOverDrainingRoute({ ...options, draining: false,
            observeReason() { throw new Error('must not eagerly observe a non-draining plan'); } });
        assert.deepEqual(graph.run().changedContainers, ['worker_container']);
        assert.equal(graph.observations.length, 0);
    });
}
