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
function runGraphOverDrainingRoute({ node = graphNode(), noWait = false, hardwareUnavailable = false, supersededRun = false, running = false, runtimeReason = '' } = {}) {
    const record = {
        type: 'agent', repoName: 'demo', agentName: 'worker', runMode: 'global', projectPath: tempDir,
        profile: 'default', instanceId: 'retained-instance', enableGeneration: 'retained-generation',
        containerId: 'a'.repeat(64),
    };
    const registry = { worker_container: record };
    const events = [];
    const lines = [];
    const saved = [];
    const run = () => ensureGraphNodesEnabled({ nodes: new Map([[node.id, node]]) }, registry, {
        logLine(line) { lines.push(line); events.push('line'); },
        runtimeReplacementReason() { return runtimeReason; },
        runtimeReplacementOptions: {
            containerExistsImpl: () => true,
            isContainerRunningImpl: () => running,
            getRuntimeForAgentImpl: () => 'podman',
            getRuntimeImpl: () => 'podman',
        },
        deferredNodeIds: new Set(noWait ? [node.id] : []),
        unavailableNodeIds: new Set(hardwareUnavailable ? [node.id] : []),
        supersededNoWaitRuns: supersededRun ? [{ identity: {
            containerName: 'worker_container', instanceId: record.instanceId, enableGeneration: record.enableGeneration,
            repoName: 'demo', shortAgent: 'worker', alias: '',
        } }] : [],
        inactivateGeneration() { events.push('inactivate'); },
        loadRouting() {
            return { routes: { worker: { container: 'worker_container', repo: 'demo', agent: 'worker', draining: true, hostPort: 41001 } } };
        },
        saveRouting(routing) { events.push('save-routing'); saved.push(structuredClone(routing)); },
        saveAgents() { events.push('save-agents'); },
        retireNoWaitMarkers() { events.push('retire-markers'); },
        prepareAgentEnableBatch() { return { plans: [], preparedGeneration: { selector: { state: 'inactive' } } }; },
        removeAgentContainerForRecreate() { events.push('remove'); },
        readRuntimePredecessorImpl: () => null,
        writeRuntimePredecessorImpl() { events.push('write-predecessor'); return null; },
        uuid: randomUUID,
        executionRecordOptions: { workspaceRoot: tempDir },
    });
    return { run, events, lines, saved, registry, record: structuredClone(record) };
}

test('workspace start refuses to replace the stopped predecessor of a refused targeted drain on a blocking node before changing anything', () => {
    const graph = runGraphOverDrainingRoute({ node: graphNode({ profile: 'embedded' }) });
    assert.throws(graph.run, { code: 'PLOINKY_AGENT_DRAINING' });
    assert.deepEqual(graph.events, [], 'no line, revocation, rotation, receipt or removal');
    assert.deepEqual(graph.registry.worker_container, graph.record, 'the predecessor keeps its exact runtime identity');
});

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
