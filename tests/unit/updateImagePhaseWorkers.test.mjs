// The agent image phase counts only live no-wait workers: stale status files and markers whose
// process is gone never block it. The edge generation, marker and status files are real.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-image-phase-workers-')));
const originalCwd = process.cwd();
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const settlement = await import('../../cli/commands/noWaitRunSettlement.js');
const { refreshUpdateImages } = await import('../../cli/commands/updateImagePhase.js');

const CONTAINER = 'ploinky_fixtures_probe';
const paths = edge.resolveEdgeGenerationPaths();
const noWaitDir = path.join(paths.ploinkyDir, 'running', 'no-wait');
const agentPath = path.join(paths.ploinkyDir, 'repos', 'fixtures', 'probe');

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
});

function fixture() {
    fs.rmSync(paths.ploinkyDir, { recursive: true, force: true });
    fs.mkdirSync(agentPath, { recursive: true });
    fs.writeFileSync(path.join(agentPath, 'manifest.json'), JSON.stringify({ container: 'node:20', start: 'node index.js' }));
    fs.mkdirSync(path.dirname(paths.policyFile), { recursive: true });
    fs.mkdirSync(paths.edgeDir, { recursive: true });
    fs.writeFileSync(paths.agentsFile, JSON.stringify({ [CONTAINER]: {
        type: 'agent', repoName: 'fixtures', agentName: 'probe',
        instanceId: 'probe-instance', enableGeneration: 'probe-generation',
        auth: { mode: 'sso' }, config: { binds: [] },
    } }, null, 2));
    fs.writeFileSync(paths.routingFile, JSON.stringify({ routes: { probe: {
        repo: 'fixtures', agent: 'probe', container: CONTAINER, hostPath: agentPath,
    } } }, null, 2));
    fs.writeFileSync(paths.policyFile, JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }));
    fs.writeFileSync(paths.desiredFile, JSON.stringify({ hosts: {} }));
    assert.equal(edge.applyEdgeRoutingGeneration({ reason: 'no-wait-settlement-fixture' }).selector.state, 'active');
    fs.mkdirSync(noWaitDir, { recursive: true, mode: 0o700 });
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runIdentity({ runId = randomUUID(), runStartedAtMs = Date.now() } = {}) {
    return {
        containerName: CONTAINER,
        instanceId: 'probe-instance',
        enableGeneration: 'probe-generation',
        repoName: 'fixtures',
        shortAgent: 'probe',
        alias: '',
        routeKey: 'probe',
        runId,
        runStartedAtMs,
        waveIndex: 1,
        statusFile: `${CONTAINER}.${runId}.json`,
    };
}

// The start publishes the marker immediately before spawning the worker.
function writeMarker(identity) {
    writeJson(path.join(noWaitDir, `${CONTAINER}.current.json`), { createdAt: new Date().toISOString(), ...identity });
}

function deadPid() {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    return Number(child.stdout);
}

async function phaseWith(extra = {}) {
    const calls = [];
    const logs = [];
    const result = await refreshUpdateImages({ request: { kind: 'all', folderPath: '' }, session: { enabled: true }, log: (l) => logs.push(l) }, {
        getConfig: () => ({ static: { agent: 'probe' } }),
        refreshWorkspaceGraphImages: async () => { calls.push('refresh'); return []; },
        ...extra,
    });
    return { result, calls, logs };
}

test('a queued run-scoped status without a pid does not skip the agent image phase', async () => {
    fixture();
    const identity = runIdentity();
    writeMarker(identity);
    writeJson(path.join(noWaitDir, identity.statusFile), {
        runId: identity.runId, runStartedAtMs: identity.runStartedAtMs, waveIndex: 1, state: 'queued',
        sequencePhase: 'queued', sequencePhaseStartedAtMs: Date.now(), pid: null, workerPid: null,
    });
    const live = settlement.inspectLiveNoWaitWorkers();
    assert.ok(live.every((worker) => !worker.pid), JSON.stringify(live));
    const { result, calls } = await phaseWith();
    assert.deepEqual(result, []);
    assert.deepEqual(calls, ['refresh']);
});

test('a run whose published pid is a dead process does not skip the agent image phase', async () => {
    fixture();
    const identity = runIdentity();
    writeMarker(identity);
    writeJson(path.join(noWaitDir, identity.statusFile), {
        runId: identity.runId, runStartedAtMs: identity.runStartedAtMs, waveIndex: 1, state: 'starting',
        sequencePhase: 'active', sequencePhaseStartedAtMs: Date.now(), pid: deadPid(),
    });
    const { calls } = await phaseWith();
    assert.deepEqual(calls, ['refresh']);
});

test('a marker without any status does not skip the phase either', async () => {
    fixture();
    writeMarker(runIdentity());
    const { calls } = await phaseWith();
    assert.deepEqual(calls, ['refresh']);
});
