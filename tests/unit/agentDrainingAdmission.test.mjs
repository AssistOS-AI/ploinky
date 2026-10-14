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
function runGraphOverDrainingRoute({ node = graphNode() } = {}) {
    const record = {
        type: 'agent', repoName: 'demo', agentName: 'worker', runMode: 'global', projectPath: tempDir,
        profile: 'default', instanceId: 'retained-instance', enableGeneration: 'retained-generation',
        containerId: 'a'.repeat(64),
    };
    const registry = { worker_container: record };
    const events = [];
    const run = () => ensureGraphNodesEnabled({ nodes: new Map([[node.id, node]]) }, registry, {
        logLine() { events.push('line'); },
        runtimeReplacementReason() { return ''; },
        runtimeReplacementOptions: {
            containerExistsImpl: () => true,
            isContainerRunningImpl: () => false,
            getRuntimeForAgentImpl: () => 'podman',
            getRuntimeImpl: () => 'podman',
        },
        inactivateGeneration() { events.push('inactivate'); },
        loadRouting() {
            return { routes: { worker: { container: 'worker_container', repo: 'demo', agent: 'worker', draining: true } } };
        },
        saveRouting() { events.push('save-routing'); },
        saveAgents() { events.push('save-agents'); },
        retireNoWaitMarkers() { events.push('retire-markers'); },
        prepareAgentEnableBatch() { return { plans: [], preparedGeneration: { selector: { state: 'inactive' } } }; },
        removeAgentContainerForRecreate() { events.push('remove'); },
        readRuntimePredecessorImpl: () => null,
        writeRuntimePredecessorImpl() { events.push('write-predecessor'); return null; },
        uuid: randomUUID,
        executionRecordOptions: { workspaceRoot: tempDir },
    });
    return { run, events, registry, record: structuredClone(record) };
}

test('workspace start refuses to replace the stopped predecessor of a refused targeted drain before changing anything', () => {
    const graph = runGraphOverDrainingRoute({ node: graphNode({ profile: 'embedded' }) });
    assert.throws(graph.run, { code: 'PLOINKY_AGENT_DRAINING' });
    assert.deepEqual(graph.events, [], 'no line, revocation, rotation, receipt or removal');
    assert.deepEqual(graph.registry.worker_container, graph.record, 'the predecessor keeps its exact runtime identity');
});

test('workspace start leaves an unchanged draining runtime in place for the admission gate', () => {
    const graph = runGraphOverDrainingRoute();
    assert.doesNotThrow(graph.run);
    assert.equal(graph.events.includes('remove'), false);
    assert.deepEqual(graph.registry.worker_container, graph.record);
});
