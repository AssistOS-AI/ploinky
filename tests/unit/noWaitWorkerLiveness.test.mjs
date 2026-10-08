// The Router's read-only view of no-wait graph-start activity. A startup probe
// may skip its forward check only while no latest no-wait run can still change
// a route, so every doubt here must read as busy, and reading must never
// change anything. Synthetic markers and statuses use the exact on-disk shape;
// one test drives the real noWaitWorker.js process parked in its barrier.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-no-wait-liveness-')));
const originalCwd = process.cwd();
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const liveness = await import('../../cli/commands/noWaitWorkerLiveness.js');
const {
    noWaitQueuedStatusDeadline,
    resolveNoWaitBarrierTimeouts,
} = await import('../../cli/commands/noWaitProtocol.js');

const { inspectNoWaitRoutingActivity, observeMarkedWorker } = liveness;
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const WORKER = path.join(REPO_ROOT, 'cli/commands/noWaitWorker.js');
const CONTAINER = 'ploinky_fixtures_probe';
const PRODUCER = 'ploinky_fixtures_producer';
const NOW = 1_800_000_000_000;
// activeTimeoutMs 60 s (no image budgets), terminal grace 5 s, startup grace 10 s.
const TIMEOUTS = resolveNoWaitBarrierTimeouts({
    activeTimeoutMs: 60_000,
    terminalPublicationGraceMs: 5_000,
    startupGraceMs: 10_000,
    readRetryTimeoutMs: 1_000,
    imagePullBudgetMs: 0,
    imageBuildBudgetMs: 0,
});
const children = new Set();

test.afterEach(async () => {
    for (const child of children) await killChild(child);
});

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
});

function tempRunningDir(t, { noWait = true } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-routing-activity-')));
    t.after(() => {
        try { fs.chmodSync(path.join(root, 'running', 'no-wait'), 0o700); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    });
    const runningDir = path.join(root, 'running');
    fs.mkdirSync(noWait ? path.join(runningDir, 'no-wait') : runningDir, { recursive: true, mode: 0o700 });
    return runningDir;
}

function writeJson(file, value) {
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runIdentity({
    containerName = CONTAINER,
    runId = randomUUID(),
    runStartedAtMs = NOW - 20_000,
    waveIndex = 0,
} = {}) {
    return {
        containerName,
        instanceId: `${containerName}-instance`,
        enableGeneration: `${containerName}-generation`,
        repoName: 'fixtures',
        shortAgent: 'probe',
        alias: '',
        routeKey: 'probe',
        runId,
        runStartedAtMs,
        waveIndex,
        statusFile: `${containerName}.${runId}.json`,
    };
}

function markerPath(runningDir, identity) {
    return path.join(runningDir, 'no-wait', `${identity.containerName}.current.json`);
}

function statusPath(runningDir, identity) {
    return path.join(runningDir, 'no-wait', identity.statusFile);
}

function writeMarker(runningDir, identity) {
    writeJson(markerPath(runningDir, identity), { createdAt: new Date(identity.runStartedAtMs).toISOString(), ...identity });
}

// Exactly the documents the worker writes: its payload plus its immutable identity.
const PAYLOADS = {
    starting: (pid = 4242, phaseStartedAtMs = NOW - 15_000) => ({
        state: 'starting', sequencePhase: 'active', sequencePhaseStartedAtMs: phaseStartedAtMs, pid,
    }),
    queued: (pid = 4242) => ({ state: 'starting', sequencePhase: 'waiting-barrier', pid }),
    running: () => ({ state: 'running', sequencePhase: 'active', sequencePhaseStartedAtMs: NOW - 15_000, pid: 4242 }),
    failed: () => ({ state: 'failed', sequencePhase: 'active', sequencePhaseStartedAtMs: NOW - 15_000, pid: 4242 }),
};

function writeStatus(runningDir, identity, payload) {
    writeJson(statusPath(runningDir, identity), typeof payload === 'string' ? payload : { ...payload, ...identity });
}

function writeRun(runningDir, payload, identityOptions = {}) {
    const identity = runIdentity(identityOptions);
    writeMarker(runningDir, identity);
    if (payload !== undefined) writeStatus(runningDir, identity, payload);
    return identity;
}

function proofError(code, extra = {}) {
    return () => {
        const error = new Error(`fixture proof: ${code}`);
        error.code = code;
        Object.assign(error, extra);
        throw error;
    };
}

const staleProof = proofError('PROCESS_IDENTITY_STALE');
const unprovenProof = proofError('PROCESS_IDENTITY_UNPROVEN');
const foreignProof = proofError('PROCESS_IDENTITY_UNPROVEN', { foreign: true });
const forbiddenProof = () => { throw new Error('no process proof is expected for this marker'); };

function inspect(runningDir, options = {}) {
    return inspectNoWaitRoutingActivity({
        runningDir, nowMs: NOW, timeouts: TIMEOUTS, proveWorkerProcess: forbiddenProof, ...options,
    });
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

test('R-A13: no no-wait directory means no workers', (t) => {
    const runningDir = tempRunningDir(t, { noWait: false });
    assert.deepEqual(inspect(runningDir), { busy: false, reason: 'no-workers' });
    assert.deepEqual(inspect(path.join(runningDir, 'absent')), { busy: false, reason: 'no-workers' });
    // An empty directory, or one without markers, is settled.
    fs.mkdirSync(path.join(runningDir, 'no-wait'));
    assert.deepEqual(inspect(runningDir), { busy: false, reason: 'settled' });
    writeJson(path.join(runningDir, 'no-wait', `${CONTAINER}.json`), { state: 'starting' });
    assert.deepEqual(inspect(runningDir), { busy: false, reason: 'settled' }, 'only .current.json names are markers');
});

test('R-A14: a latest run that published running (active phase) or failed is settled without a process proof', (t) => {
    for (const state of ['running', 'failed']) {
        const runningDir = tempRunningDir(t);
        writeRun(runningDir, PAYLOADS[state]());
        assert.deepEqual(inspect(runningDir), { busy: false, reason: 'settled' }, state);
    }
    // 'running' outside the active phase is not a valid terminal status.
    const runningDir = tempRunningDir(t);
    writeRun(runningDir, { ...PAYLOADS.running(), sequencePhase: 'waiting-barrier' });
    assert.deepEqual(inspect(runningDir), { busy: true, reason: 'unverifiable' });
});

test('R-A15: the real parked worker process is a live worker; once killed its exit stays unconfirmed until the run deadline', async (t) => {
    const edge = await import('../../cli/sandbox/edgeGeneration.js');
    const paths = edge.resolveEdgeGenerationPaths();
    const runningDir = path.join(paths.ploinkyDir, 'running');
    const noWaitDir = path.join(runningDir, 'no-wait');
    const agentPath = path.join(paths.ploinkyDir, 'repos', 'fixtures', 'probe');
    fs.mkdirSync(agentPath, { recursive: true });
    fs.writeFileSync(path.join(agentPath, 'manifest.json'), JSON.stringify({ container: 'node:20', start: 'node index.js' }));
    fs.mkdirSync(path.dirname(paths.policyFile), { recursive: true });
    fs.mkdirSync(paths.edgeDir, { recursive: true });
    writeJson(paths.agentsFile, { [CONTAINER]: {
        type: 'agent', repoName: 'fixtures', agentName: 'probe',
        instanceId: 'probe-instance', enableGeneration: 'probe-generation',
        auth: { mode: 'sso' }, config: { binds: [] },
    } });
    writeJson(paths.routingFile, { routes: { probe: {
        repo: 'fixtures', agent: 'probe', container: CONTAINER, hostPath: agentPath,
    } } });
    writeJson(paths.policyFile, { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    writeJson(paths.desiredFile, { hosts: {} });
    assert.equal(edge.applyEdgeRoutingGeneration({ reason: 'no-wait-liveness-fixture' }).selector.state, 'active');
    fs.mkdirSync(noWaitDir, { recursive: true, mode: 0o700 });

    const identity = {
        ...runIdentity({ runStartedAtMs: Date.now(), waveIndex: 1 }),
        instanceId: 'probe-instance',
        enableGeneration: 'probe-generation',
    };
    const barrierPath = path.join(noWaitDir, `${PRODUCER}.${identity.runId}.json`);
    writeJson(barrierPath, {
        runId: identity.runId, runStartedAtMs: identity.runStartedAtMs, waveIndex: 0,
        state: 'starting', sequencePhase: 'active', sequencePhaseStartedAtMs: Date.now(), pid: process.pid,
    });
    writeMarker(runningDir, identity);
    const workerStatus = statusPath(runningDir, identity);
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
        '--status-file', workerStatus,
        '--wait-for-statuses', JSON.stringify([{ path: barrierPath, runId: identity.runId, waveIndex: 0, directDependency: true }]),
    ], { cwd: workspace, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const deadline = Date.now() + 30_000;
    while (!(fs.existsSync(workerStatus) && readJson(workerStatus).sequencePhase === 'waiting-barrier')) {
        assert.equal(child.exitCode, null, `the parked worker exited early: ${output}`);
        assert.ok(Date.now() < deadline, `the worker never parked in its barrier: ${output}`);
        await sleep(50);
    }

    // The default process proof, exactly as the Router runs it.
    const observed = observeMarkedWorker(CONTAINER, {
        runningDir, fsApi: fs, nowMs: Date.now(), timeouts: resolveNoWaitBarrierTimeouts(),
        proveWorkerProcess: (await import('../../cli/sandbox/processIdentity.js')).proveWorkerProcessIdentity,
    });
    assert.equal(observed.live, true);
    assert.equal(observed.reason, 'running', 'proven by structured argv, not merely unproven');
    assert.equal(observed.pid, child.pid);
    assert.deepEqual(inspectNoWaitRoutingActivity({ runningDir }), { busy: true, reason: 'live-worker' });

    // SIGKILL leaves a non-terminal status behind (M-4).
    await killChild(child);
    assert.equal(readJson(workerStatus).state, 'starting');
    assert.deepEqual(inspectNoWaitRoutingActivity({ runningDir }), { busy: true, reason: 'exit-unconfirmed' });
    const timeouts = resolveNoWaitBarrierTimeouts();
    const queuedDeadline = noWaitQueuedStatusDeadline(identity.runStartedAtMs, 1, timeouts);
    assert.deepEqual(inspectNoWaitRoutingActivity({ runningDir, timeouts, nowMs: queuedDeadline }),
        { busy: true, reason: 'exit-unconfirmed' }, 'the deadline itself is still inside the run');
    assert.deepEqual(inspectNoWaitRoutingActivity({ runningDir, timeouts, nowMs: queuedDeadline + 1 }),
        { busy: false, reason: 'settled' });
    fs.rmSync(paths.ploinkyDir, { recursive: true, force: true });
});

test('R-A16 + M-4: a stale worker pid is busy until its run-scoped deadline and settled after it', (t) => {
    // Active phase: deadline = phase start + activeTimeoutMs + terminal grace.
    const active = tempRunningDir(t);
    const phaseStartedAtMs = NOW - 15_000;
    writeRun(active, PAYLOADS.starting(4242, phaseStartedAtMs));
    const activeDeadline = phaseStartedAtMs + TIMEOUTS.activeTimeoutMs + TIMEOUTS.terminalPublicationGraceMs;
    assert.deepEqual(inspect(active, { proveWorkerProcess: staleProof }), { busy: true, reason: 'exit-unconfirmed' });
    assert.deepEqual(inspect(active, { proveWorkerProcess: staleProof, nowMs: activeDeadline }),
        { busy: true, reason: 'exit-unconfirmed' });
    assert.deepEqual(inspect(active, { proveWorkerProcess: staleProof, nowMs: activeDeadline + 1 }),
        { busy: false, reason: 'settled' });

    // Queued phase: deadline = run start + (wave + 1) x (active + grace) + startup grace.
    const queued = tempRunningDir(t);
    const identity = writeRun(queued, PAYLOADS.queued(), { waveIndex: 2 });
    const queuedDeadline = identity.runStartedAtMs
        + (3 * (TIMEOUTS.activeTimeoutMs + TIMEOUTS.terminalPublicationGraceMs)) + TIMEOUTS.startupGraceMs;
    assert.equal(noWaitQueuedStatusDeadline(identity.runStartedAtMs, 2, TIMEOUTS), queuedDeadline);
    assert.deepEqual(inspect(queued, { proveWorkerProcess: staleProof, nowMs: queuedDeadline }),
        { busy: true, reason: 'exit-unconfirmed' });
    assert.deepEqual(inspect(queued, { proveWorkerProcess: staleProof, nowMs: queuedDeadline + 1 }),
        { busy: false, reason: 'settled' });

    // A deadline that cannot be computed counts as not yet passed, and the
    // settlement observer still returns a non-live entry instead of throwing.
    const overflowing = { ...TIMEOUTS, activeTimeoutMs: Number.MAX_SAFE_INTEGER };
    assert.deepEqual(inspect(queued, { proveWorkerProcess: staleProof, timeouts: overflowing, nowMs: Number.MAX_SAFE_INTEGER }),
        { busy: true, reason: 'exit-unconfirmed' });
    const entry = observeMarkedWorker(CONTAINER, {
        runningDir: queued, fsApi: fs, nowMs: NOW, timeouts: overflowing, proveWorkerProcess: staleProof,
    });
    assert.equal(entry.live, false);
    assert.equal(entry.reason, 'stopped without a terminal status');
    assert.equal(entry.pastDeadline, false);
});

test('R-A16 with the real proof: a pid that already exited is stale', async (t) => {
    const exitedPid = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        child.once('exit', () => resolve(child.pid));
    });
    const runningDir = tempRunningDir(t);
    const phaseStartedAtMs = Date.now() - 1_000;
    writeRun(runningDir, PAYLOADS.starting(exitedPid, phaseStartedAtMs), { runStartedAtMs: phaseStartedAtMs - 1_000 });
    const nowMs = Date.now();
    const observed = observeMarkedWorker(CONTAINER, {
        runningDir, fsApi: fs, nowMs, timeouts: TIMEOUTS,
        proveWorkerProcess: (await import('../../cli/sandbox/processIdentity.js')).proveWorkerProcessIdentity,
    });
    assert.equal(observed.reason, 'stopped without a terminal status');
    assert.deepEqual(inspectNoWaitRoutingActivity({ runningDir, timeouts: TIMEOUTS, nowMs }),
        { busy: true, reason: 'exit-unconfirmed' });
    assert.deepEqual(inspectNoWaitRoutingActivity({
        runningDir, timeouts: TIMEOUTS, nowMs: phaseStartedAtMs + TIMEOUTS.activeTimeoutMs + TIMEOUTS.terminalPublicationGraceMs + 1,
    }), { busy: false, reason: 'settled' });
});

test('R-A17: a starting worker that is alive but unprovable is busy, even past its deadline', (t) => {
    const runningDir = tempRunningDir(t);
    const phaseStartedAtMs = NOW - 15_000;
    writeRun(runningDir, PAYLOADS.starting(4242, phaseStartedAtMs));
    assert.deepEqual(inspect(runningDir, { proveWorkerProcess: unprovenProof }), { busy: true, reason: 'live-worker' });
    const pastDeadline = phaseStartedAtMs + TIMEOUTS.activeTimeoutMs + TIMEOUTS.terminalPublicationGraceMs + 1;
    assert.deepEqual(inspect(runningDir, { proveWorkerProcess: unprovenProof, nowMs: pastDeadline }),
        { busy: true, reason: 'live-worker' });
    // A published pid that is not a positive integer cannot be proven either.
    const noPid = tempRunningDir(t);
    writeRun(noPid, { ...PAYLOADS.starting(), pid: null });
    assert.deepEqual(inspectNoWaitRoutingActivity({ runningDir: noPid, nowMs: NOW, timeouts: TIMEOUTS }),
        { busy: true, reason: 'live-worker' });
    // A pid that now names another process is settled for that marker.
    assert.deepEqual(inspect(runningDir, { proveWorkerProcess: foreignProof }), { busy: false, reason: 'settled' });
});

test('R-A18: bad JSON, an unknown state, a mismatched run or a symlinked status is unverifiable', (t) => {
    const cases = [
        ['bad JSON', (dir, identity) => writeStatus(dir, identity, '{"state": "starting",')],
        ['pending state', (dir, identity) => writeStatus(dir, identity, { ...PAYLOADS.starting(), state: 'pending' })],
        ['invalid phase', (dir, identity) => writeStatus(dir, identity, { ...PAYLOADS.starting(), sequencePhase: 'later' })],
        ['mismatched runId', (dir, identity) => writeJson(statusPath(dir, identity), {
            ...PAYLOADS.starting(), ...identity, runId: randomUUID(),
        })],
        ['other immutable identity', (dir, identity) => writeJson(statusPath(dir, identity), {
            ...PAYLOADS.starting(), ...identity, instanceId: 'another-instance',
        })],
        ['symlinked status', (dir, identity) => {
            const real = path.join(dir, 'elsewhere.json');
            writeJson(real, { ...PAYLOADS.failed(), ...identity });
            fs.symlinkSync(real, statusPath(dir, identity));
        }],
        ['symlinked marker', (dir, identity) => {
            const real = path.join(dir, 'marker-elsewhere.json');
            fs.renameSync(markerPath(dir, identity), real);
            fs.symlinkSync(real, markerPath(dir, identity));
            writeStatus(dir, identity, PAYLOADS.failed());
        }],
        ['incomplete marker', (dir, identity) => {
            writeJson(markerPath(dir, identity), { runId: identity.runId });
        }],
    ];
    for (const [label, arrange] of cases) {
        const runningDir = tempRunningDir(t);
        const identity = writeRun(runningDir);
        arrange(runningDir, identity);
        assert.deepEqual(inspect(runningDir), { busy: true, reason: 'unverifiable' }, label);
    }
});

test('R-A19: a marker without a status is busy inside the startup grace and settled past it', (t) => {
    const runningDir = tempRunningDir(t);
    const identity = writeRun(runningDir, undefined, { runStartedAtMs: NOW - 1_000 });
    assert.deepEqual(inspect(runningDir), { busy: true, reason: 'live-worker' });
    const graceEnd = identity.runStartedAtMs + TIMEOUTS.startupGraceMs;
    assert.deepEqual(inspect(runningDir, { nowMs: graceEnd }), { busy: true, reason: 'live-worker' });
    assert.deepEqual(inspect(runningDir, { nowMs: graceEnd + 1 }), { busy: false, reason: 'settled' });
    // Orphan: the status a worker published was removed afterwards.
    const orphan = tempRunningDir(t);
    const orphaned = writeRun(orphan, PAYLOADS.starting(), { runStartedAtMs: NOW - 60_000 });
    fs.rmSync(statusPath(orphan, orphaned));
    assert.deepEqual(inspect(orphan), { busy: false, reason: 'settled' });
});

test('R-A20: more than the marker bound is busy; exactly the bound is scanned; an unlistable directory is busy', (t) => {
    const atBound = tempRunningDir(t);
    for (let index = 0; index < 256; index += 1) {
        writeRun(atBound, PAYLOADS.running(), { containerName: `ploinky_fixtures_c${index}` });
    }
    assert.deepEqual(inspect(atBound), { busy: false, reason: 'settled' }, '256 terminal markers are scanned');
    writeRun(atBound, PAYLOADS.running(), { containerName: 'ploinky_fixtures_c256' });
    assert.deepEqual(inspect(atBound), { busy: true, reason: 'too-many-markers' });
    assert.deepEqual(inspect(atBound, { maxMarkers: 257 }), { busy: false, reason: 'settled' });

    const notDirectory = tempRunningDir(t, { noWait: false });
    writeJson(path.join(notDirectory, 'no-wait'), 'not a directory');
    assert.deepEqual(inspect(notDirectory), { busy: true, reason: 'unlistable' }, 'ENOTDIR');
    const runningIsFile = tempRunningDir(t, { noWait: false });
    const fileRunningDir = path.join(runningIsFile, 'file');
    writeJson(fileRunningDir, 'x');
    assert.deepEqual(inspect(fileRunningDir), { busy: true, reason: 'unlistable' }, 'ENOTDIR on the running dir');

    const denied = tempRunningDir(t);
    writeRun(denied, PAYLOADS.running());
    const deniedFs = { ...fs, readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    assert.deepEqual(inspect(denied, { fsApi: deniedFs }), { busy: true, reason: 'unlistable' }, 'EACCES (injected)');
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        fs.chmodSync(path.join(denied, 'no-wait'), 0o000);
        assert.deepEqual(inspect(denied), { busy: true, reason: 'unlistable' }, 'EACCES (real)');
        fs.chmodSync(path.join(denied, 'no-wait'), 0o700);
    }
    const eio = { ...fs, readdirSync: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
    assert.deepEqual(inspect(denied, { fsApi: eio }), { busy: true, reason: 'unlistable' });
});

test('R-A21: inspection never writes, renames, removes or signals, and leaves the tree byte-identical', (t) => {
    const runningDir = tempRunningDir(t);
    writeRun(runningDir, PAYLOADS.starting(), { containerName: 'ploinky_fixtures_a' });
    writeRun(runningDir, PAYLOADS.queued(), { containerName: 'ploinky_fixtures_b' });
    writeRun(runningDir, PAYLOADS.failed(), { containerName: 'ploinky_fixtures_c' });
    writeRun(runningDir, undefined, { containerName: 'ploinky_fixtures_d', runStartedAtMs: NOW - 60_000 });
    const tree = () => fs.readdirSync(path.join(runningDir, 'no-wait')).sort().map((name) => {
        const file = path.join(runningDir, 'no-wait', name);
        const stat = fs.lstatSync(file);
        return [name, stat.ino, stat.mode, stat.mtimeMs, fs.readFileSync(file, 'utf8')];
    });
    const before = tree();
    const READ_OPS = new Set(['readdirSync', 'lstatSync', 'openSync', 'fstatSync', 'readSync', 'closeSync']);
    const ops = [];
    const recordingFs = new Proxy(fs, {
        get(target, property) {
            const value = target[property];
            if (typeof value !== 'function') return value;
            return (...args) => {
                ops.push(property);
                if (property === 'openSync') {
                    const flags = Number(args[1] || 0);
                    assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
                }
                return value.apply(target, args);
            };
        },
    });
    const proofs = [];
    for (let index = 0; index < 50; index += 1) {
        for (const [proveWorkerProcess, expected] of [
            [staleProof, { busy: true, reason: 'exit-unconfirmed' }],
            [unprovenProof, { busy: true, reason: 'live-worker' }],
            [foreignProof, { busy: false, reason: 'settled' }],
        ]) {
            const result = inspect(runningDir, {
                fsApi: recordingFs,
                proveWorkerProcess: (args) => { proofs.push(args.pid); return proveWorkerProcess(args); },
            });
            assert.deepEqual(result, expected);
        }
    }
    assert.ok(proofs.length >= 150, 'the non-terminal markers reached the process proof');
    assert.deepEqual([...new Set(ops)].filter((op) => !READ_OPS.has(op)), []);
    assert.deepEqual(tree(), before);
});

test('R-A22: a superseded starting run beside the current terminal run is settled', (t) => {
    const runningDir = tempRunningDir(t);
    const superseded = runIdentity({ runStartedAtMs: NOW - 120_000 });
    writeStatus(runningDir, superseded, PAYLOADS.starting(4242, NOW - 110_000));
    const current = runIdentity({ runStartedAtMs: NOW - 30_000 });
    writeMarker(runningDir, current);
    writeStatus(runningDir, current, PAYLOADS.running());
    assert.deepEqual(inspect(runningDir, { proveWorkerProcess: () => ({ argv: [] }) }), { busy: false, reason: 'settled' });
});

test('every marker is considered: one busy marker among settled ones is busy, and the strongest reason wins', (t) => {
    const runningDir = tempRunningDir(t);
    writeRun(runningDir, PAYLOADS.running(), { containerName: 'ploinky_fixtures_a' });
    writeRun(runningDir, PAYLOADS.failed(), { containerName: 'ploinky_fixtures_b' });
    const late = writeRun(runningDir, PAYLOADS.starting(), { containerName: 'ploinky_fixtures_z' });
    assert.deepEqual(inspect(runningDir, { proveWorkerProcess: staleProof }), { busy: true, reason: 'exit-unconfirmed' });
    writeRun(runningDir, '{', { containerName: 'ploinky_fixtures_y' });
    assert.deepEqual(inspect(runningDir, { proveWorkerProcess: staleProof }), { busy: true, reason: 'unverifiable' });
    assert.deepEqual(inspect(runningDir, { proveWorkerProcess: unprovenProof }), { busy: true, reason: 'live-worker' });
    fs.rmSync(markerPath(runningDir, late));
    assert.deepEqual(inspect(runningDir, { proveWorkerProcess: unprovenProof }), { busy: true, reason: 'unverifiable' });
});

test('a status replaced by an atomic rename during the read is busy or settled, never a throw', (t) => {
    const runningDir = tempRunningDir(t);
    const identity = writeRun(runningDir, PAYLOADS.starting());
    const target = statusPath(runningDir, identity);
    for (const replacement of [PAYLOADS.running(), PAYLOADS.starting()]) {
        let armed = false;
        let swapped = false;
        const racingFs = {
            ...fs,
            openSync(file, ...rest) {
                if (file === target) armed = true;
                return fs.openSync(file, ...rest);
            },
            fstatSync(...args) {
                const stat = fs.fstatSync(...args);
                if (armed && !swapped) {
                    swapped = true;
                    writeJson(`${target}.next`, { ...replacement, ...identity });
                    fs.renameSync(`${target}.next`, target);
                }
                return stat;
            },
        };
        const result = inspect(runningDir, { fsApi: racingFs, proveWorkerProcess: unprovenProof });
        assert.ok(swapped);
        assert.ok(result.busy === true || result.reason === 'settled', JSON.stringify(result));
        assert.equal(result.busy, true, 'a replaced status cannot be verified');
    }
});

test('an unexpected failure is busy', (t) => {
    const runningDir = tempRunningDir(t);
    assert.deepEqual(inspect(runningDir, { fsApi: { ...fs, readdirSync: () => null } }), { busy: true, reason: 'error' });
    writeRun(runningDir, PAYLOADS.starting());
    assert.deepEqual(inspect(runningDir, { timeouts: null }), { busy: true, reason: 'unverifiable' });
});

// AC-A15: the Router-loaded liveness module must not reach the mutating worker
// (or the edge generation module, which does) through any relative import.
test('AC-A15: the liveness module never imports noWaitWorker.js, directly or transitively', () => {
    const seen = new Set();
    const pattern = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g;
    const walk = (file) => {
        if (seen.has(file)) return;
        seen.add(file);
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(pattern)) walk(path.resolve(path.dirname(file), match[1] || match[2] || match[3]));
    };
    walk(path.join(REPO_ROOT, 'cli/commands/noWaitWorkerLiveness.js'));
    const reached = [...seen].map((file) => path.relative(REPO_ROOT, file));
    assert.ok(reached.length > 5, reached.join(', '));
    assert.equal(reached.includes('cli/commands/noWaitWorker.js'), false);
    assert.equal(reached.includes('cli/sandbox/edgeGeneration.js'), false);
});
