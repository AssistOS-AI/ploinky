// A start returns while its detached no-wait workers are still creating their
// runtimes. A back-to-back restart that stopped and re-staged the graph under
// them left a worker's half-created container that neither side could remove.
// The workers here are the real noWaitWorker.js process, spawned with the exact
// argv a workspace start uses and parked in its dependency-wave barrier; the
// edge generation, marker, status, workspace lease and lock files are real.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-no-wait-settlement-')));
const originalCwd = process.cwd();
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');
const settlement = await import('../../cli/commands/noWaitRunSettlement.js');
const { resolveNoWaitBarrierTimeouts } = await import('../../cli/commands/noWaitProtocol.js');
const { settleWorkspaceBeforeRestart } = await import('../../cli/commands/workspaceUtil.js');

const WORKER = path.resolve(import.meta.dirname, '../../cli/commands/noWaitWorker.js');
const CONTAINER = 'ploinky_fixtures_probe';
const PRODUCER = 'ploinky_fixtures_producer';
const paths = edge.resolveEdgeGenerationPaths();
const noWaitDir = path.join(paths.ploinkyDir, 'running', 'no-wait');
const agentPath = path.join(paths.ploinkyDir, 'repos', 'fixtures', 'probe');
const children = new Set();

test.afterEach(async () => {
    delete process.env.PLOINKY_NO_WAIT_SETTLE_TIMEOUT_MS;
    for (const child of children) await killChild(child);
});

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
});

// One active generation that stages the no-wait agent target-less, exactly as
// a workspace start leaves it before its worker publishes the runtime.
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

// A wave-1 worker blocked on its wave-0 producer: live, provably this worker,
// and able to progress, until the producer's status settles its barrier.
async function parkedWorker() {
    const identity = runIdentity();
    const barrierPath = path.join(noWaitDir, `${PRODUCER}.${identity.runId}.json`);
    const writeBarrier = (state) => writeJson(barrierPath, {
        runId: identity.runId, runStartedAtMs: identity.runStartedAtMs, waveIndex: 0,
        state, sequencePhase: 'active', sequencePhaseStartedAtMs: Date.now(), pid: process.pid,
    });
    writeBarrier('starting');
    writeMarker(identity);
    const statusPath = path.join(noWaitDir, identity.statusFile);
    const child = spawn(process.execPath, [
        WORKER,
        '--container', CONTAINER,
        '--instance-id', identity.instanceId,
        '--enable-generation', identity.enableGeneration,
        '--short-agent', 'probe',
        '--repo', 'fixtures',
        '--alias', '',
        '--manifest-path', path.join(agentPath, 'manifest.json'),
        '--agent-path', agentPath,
        '--route-key', 'probe',
        '--run-id', identity.runId,
        '--run-started-at-ms', String(identity.runStartedAtMs),
        '--wave-index', '1',
        '--status-file', statusPath,
        '--wait-for-statuses', JSON.stringify([{ path: barrierPath, runId: identity.runId, waveIndex: 0, directDependency: true }]),
    ], { cwd: workspace, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const deadline = Date.now() + 30_000;
    while (!(fs.existsSync(statusPath) && readJson(statusPath).sequencePhase === 'waiting-barrier')) {
        assert.equal(child.exitCode, null, `the parked worker exited early: ${output}`);
        assert.ok(Date.now() < deadline, `the worker never parked in its barrier: ${output}`);
        await sleep(50);
    }
    return {
        child,
        identity,
        statusPath,
        exited,
        output: () => output,
        // The producer failed: the worker publishes its own terminal status and exits.
        release: () => writeBarrier('failed'),
    };
}

async function killChild(child) {
    if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
    }
    children.delete(child);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Everything a restart would rewrite or a worker would publish.
function snapshot() {
    const files = [paths.activeSelectorFile, paths.agentsFile, paths.routingFile, paths.preparationLeaseFile,
        path.join(noWaitDir, `${CONTAINER}.current.json`), locks.WORKSPACE_START_LOCK_PATH];
    const before = files.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
    return {
        assertUnchanged() {
            files.forEach((file, index) => assert.deepEqual(
                fs.existsSync(file) ? fs.readFileSync(file) : null, before[index], `${path.basename(file)} changed`,
            ));
        },
    };
}

test('restart waits for an earlier start\'s live no-wait worker and proceeds only after it settles', async () => {
    fixture();
    const worker = await parkedWorker();
    assert.deepEqual(settlement.inspectInFlightNoWaitWorkers().map(({ containerName, pid, runId }) => ({ containerName, pid, runId })),
        [{ containerName: CONTAINER, pid: worker.child.pid, runId: worker.identity.runId }]);
    const state = snapshot();

    let settled = false;
    const restart = settleWorkspaceBeforeRestart().finally(() => { settled = true; });
    await sleep(1_500);
    assert.equal(settled, false, 'the restart must not proceed while the worker can still create its runtime');
    assert.equal(worker.child.exitCode, null);
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false, 'the wait holds no workspace lease the worker needs');
    state.assertUnchanged();

    worker.release();
    assert.equal(await worker.exited, 1, worker.output());
    assert.equal(readJson(worker.statusPath).state, 'failed');
    assert.deepEqual(await restart, { retired: false });
    assert.equal(locks.heldWorkspaceMutationLease(), null, 'the restart releases its settled lease before stopping anything');
    assert.deepEqual(settlement.inspectInFlightNoWaitWorkers(), []);
});

test('a worker that outlives the bounded wait refuses restart and start before any mutation', async () => {
    fixture();
    const worker = await parkedWorker();
    const state = snapshot();
    process.env.PLOINKY_NO_WAIT_SETTLE_TIMEOUT_MS = '1200';
    await assert.rejects(settleWorkspaceBeforeRestart(), (error) => {
        assert.equal(error.code, 'PLOINKY_NO_WAIT_RUN_IN_FLIGHT');
        assert.match(error.message, /^workspace restart refused: 1 no-wait worker\(s\) of an earlier start/);
        assert.ok(error.message.includes(`${CONTAINER} (pid ${worker.child.pid}, run ${worker.identity.runId})`), error.message);
        assert.match(error.message, /Nothing was stopped or changed/);
        return true;
    });
    await assert.rejects(
        settlement.acquireSettledWorkspaceMutationLease({ operation: 'workspace-start', timeoutMs: 600, log: () => {} }),
        { code: 'PLOINKY_NO_WAIT_RUN_IN_FLIGHT', message: /^workspace start refused/ },
    );
    state.assertUnchanged();
    assert.equal(locks.heldWorkspaceMutationLease(), null);
    assert.equal(worker.child.exitCode, null, 'the wait never signals the worker');
    worker.release();
    assert.equal(await worker.exited, 1);
});

test('a worker that can no longer progress does not hold up the restart after a stop or a newer staging', async () => {
    fixture();
    const worker = await parkedWorker();
    // An in-Box stop (for example an update rollback) withdraws the generation
    // the worker needs; only the next start can supersede it.
    edge.inactivateEdgeRoutingGeneration('cli-workspace-stop');
    process.env.PLOINKY_NO_WAIT_SETTLE_TIMEOUT_MS = '5000';
    let startedAt = Date.now();
    assert.deepEqual(await settleWorkspaceBeforeRestart(), { retired: false });
    assert.ok(Date.now() - startedAt < 1_000, 'a stalled worker is not waited for');
    assert.equal(worker.child.exitCode, null, 'the stalled worker is still running');

    // A newer start re-staged the agent with a fresh identity: the worker's
    // own lifecycle check can only fail now.
    const agents = readJson(paths.agentsFile);
    agents[CONTAINER].instanceId = 'probe-instance-rotated';
    writeJson(paths.agentsFile, agents);
    edge.applyEdgeRoutingGeneration({ reason: 'no-wait-settlement-restaged' });
    startedAt = Date.now();
    assert.deepEqual(settlement.inspectInFlightNoWaitWorkers(), []);
    assert.deepEqual(await settleWorkspaceBeforeRestart(), { retired: false });
    assert.ok(Date.now() - startedAt < 1_000);
    worker.release();
    assert.equal(await worker.exited, 1);
});

test('stopped workers, reused pids and unpublished markers past the startup grace are not waited for', async () => {
    fixture();
    const worker = await parkedWorker();
    await killChild(worker.child);
    assert.equal(readJson(worker.statusPath).state, 'starting', 'the killed worker published no terminal status');
    assert.deepEqual(settlement.inspectInFlightNoWaitWorkers(), [], 'a stopped worker is settled');

    // The same non-terminal status now names a live process that is not the
    // bound worker, as after PID reuse.
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    children.add(stranger);
    await new Promise((resolve) => stranger.once('spawn', resolve));
    writeJson(worker.statusPath, { ...readJson(worker.statusPath), pid: stranger.pid });
    assert.deepEqual(settlement.inspectInFlightNoWaitWorkers(), [], 'a reused pid is not the worker');
    await killChild(stranger);

    // A marker whose worker has not published yet is plausible only within
    // the startup grace.
    const pending = runIdentity();
    writeMarker(pending);
    const timeouts = { ...resolveNoWaitBarrierTimeouts(), startupGraceMs: 5_000 };
    assert.deepEqual(
        settlement.inspectInFlightNoWaitWorkers({ timeouts, nowMs: pending.runStartedAtMs + 1_000 })
            .map(({ containerName, pid }) => ({ containerName, pid })),
        [{ containerName: CONTAINER, pid: null }],
    );
    assert.deepEqual(settlement.inspectInFlightNoWaitWorkers({ timeouts, nowMs: pending.runStartedAtMs + 6_000 }), []);
});

test('a worker that owns the outstanding preparation is waited for while the selector is inactive', async () => {
    fixture();
    const worker = await parkedWorker();
    // A runtime replacement keeps the selector inactive under the worker's
    // own preparation until its readiness and commit finish.
    edge.prepareEdgeRoutingGeneration({ reason: `runtime-identity-rotation:forceRecreate:${CONTAINER}` });
    writeJson(paths.preparationLeaseFile, { ...readJson(paths.preparationLeaseFile), pid: worker.child.pid });
    assert.equal(readJson(paths.activeSelectorFile).state, 'inactive');
    assert.deepEqual(settlement.inspectInFlightNoWaitWorkers().map(({ pid }) => pid), [worker.child.pid]);
    // Anyone else's preparation leaves the worker stalled, so it is not waited for.
    writeJson(paths.preparationLeaseFile, { ...readJson(paths.preparationLeaseFile), pid: process.pid });
    assert.deepEqual(settlement.inspectInFlightNoWaitWorkers(), []);
    fs.rmSync(paths.preparationLeaseFile);
    worker.release();
    assert.equal(await worker.exited, 1);
});

test('the settled lease re-inspects under the lease and waits again for a worker that resumed', async () => {
    const worker = Object.freeze({ containerName: CONTAINER, runId: randomUUID(), pid: 4242, reason: 'running' });
    const observations = [[], [worker], [worker], [], []];
    const calls = [];
    let clock = 0;
    let acquisitions = 0;
    const lease = await settlement.acquireSettledWorkspaceMutationLease({
        operation: 'workspace-start',
        timeoutMs: 10_000,
        pollIntervalMs: 100,
        inspect: () => { calls.push('inspect'); return observations.shift(); },
        acquireLease: async ({ operation }) => { calls.push(`acquire:${operation}`); acquisitions += 1; return { acquisition: acquisitions }; },
        releaseLease: () => { calls.push('release'); return true; },
        log: (message) => calls.push(message),
        sleepFn: async (ms) => { clock += ms; calls.push('sleep'); },
        nowFn: () => clock,
    });
    assert.deepEqual(calls.filter((call) => !call.startsWith('[')), [
        'inspect', 'acquire:workspace-start', 'inspect', 'release',
        'inspect', 'sleep', 'inspect', 'acquire:workspace-start', 'inspect',
    ]);
    assert.ok(calls.some((call) => /^\[workspace start\] Waiting for 1 no-wait worker\(s\)/.test(call)));
    assert.equal(lease.acquisition, 2, 'the lease returned is the one acquired after the resumed worker settled');
});
