import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    assertNoWaitAdoptableLifecycleSnapshot,
    assertNoWaitAdoptionStillCurrent,
    assertNoWaitLifecycleRebase,
    assertNoWaitLifecycleSnapshot,
    assertNoWaitRegistryRecord,
    assertNoWaitRuntimeStillExact,
    captureNoWaitRuntimeLogTail,
    cleanupNoWaitTaskOwnedCandidate,
    launchNoWaitHostRuntime,
    isNoWaitWorkerAlive,
    noWaitQueuedStatusDeadline,
    parseNoWaitStatusBarrier,
    redactNoWaitDiagnostics,
    prefetchNoWaitRuntimeImage,
    resolveNoWaitBarrierTimeouts,
    resolveNoWaitLifecycleLeaseTimeoutMs,
    resolveNoWaitRunScopedArguments,
    resolveNoWaitWorkerLifecycleSnapshot,
    resolveRunScopedObservation,
    runNoWaitLifecycleTransaction,
    runNoWaitScriptReadinessWithControlPlaneRetry,
    waitForNoWaitLifecycle,
    waitForNoWaitWorkerLifecycle,
    waitForNoWaitStatusBarrier,
    waitForNoWaitRouteActivation,
    waitForRunScopedStatus,
    withActiveNoWaitWorkerLifecycleLease,
    writeNoWaitWorkerStatus,
    writeStatus,
} from '../../cli/commands/noWaitWorker.js';
import { parseNoWaitWorkerArgs } from '../../cli/commands/noWaitWorkerArgs.js';
import {
    imageBuildTimeoutMs,
    imagePullTimeoutMs,
    MAX_IMAGE_OPERATION_TIMEOUT_MS,
} from '../../cli/sandbox/docker/common.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-no-wait-worker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runningDir = path.join(root, 'running');
    fs.mkdirSync(runningDir, { mode: 0o700 });
    return { root, runningDir };
}

test('no-wait status replacement is atomic and leaves no temporary file', (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_worker';
    const statusDir = path.join(runningDir, 'no-wait');
    const target = path.join(statusDir, `${containerName}.json`);

    for (let sequence = 0; sequence < 50; sequence += 1) {
        writeStatus(containerName, { state: 'starting', sequence }, { runningDir });
        assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
            state: 'starting',
            sequence,
        });
        assert.deepEqual(fs.readdirSync(statusDir), [`${containerName}.json`]);
    }
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('no-wait status publication rejects unsafe or foreign producer directories', (t) => {
    const { root, runningDir } = fixture(t);
    fs.chmodSync(runningDir, 0o777);
    assert.throws(
        () => writeStatus('ploinky_demo_worker', { state: 'starting' }, { runningDir }),
        /group- or other-writable/,
    );
    fs.chmodSync(runningDir, 0o700);

    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(runningDir, 'no-wait'));
    assert.throws(
        () => writeStatus('ploinky_demo_worker', { state: 'starting' }, { runningDir }),
        /not one regular directory/,
    );
});

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_RUN_ID = '99999999-9999-4999-8999-999999999999';
const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENABLE_GENERATION = 'ffffffff-1111-4222-8333-444444444444';

function workerIdentity(containerName, {
    repoName = 'demo',
    shortAgent = 'worker',
    alias = '',
    runId = RUN_ID,
    runStartedAtMs = 1_700_000_000_000,
    waveIndex = 0,
    instanceId = INSTANCE_ID,
    enableGeneration = ENABLE_GENERATION,
} = {}) {
    return {
        containerName,
        instanceId,
        enableGeneration,
        repoName,
        shortAgent,
        alias,
        routeKey: alias || shortAgent,
        runId,
        runStartedAtMs,
        waveIndex,
        statusFile: `${containerName}.${runId}.json`,
    };
}

const FAST_TIMEOUTS = resolveNoWaitBarrierTimeouts({
    activeTimeoutMs: 1000,
    terminalPublicationGraceMs: 0,
    readRetryTimeoutMs: 100,
    startupGraceMs: 0,
});

function statusDirOf(runningDir) {
    const statusDir = path.join(runningDir, 'no-wait');
    fs.mkdirSync(statusDir, { recursive: true, mode: 0o700 });
    return statusDir;
}

function coordinationPath(runningDir, containerName, runId = RUN_ID) {
    return path.join(statusDirOf(runningDir), `${containerName}.${runId}.json`);
}

function barrierEntry(runningDir, containerName, {
    waveIndex,
    directDependency = false,
    runId = RUN_ID,
} = {}) {
    return {
        path: coordinationPath(runningDir, containerName, runId),
        runId,
        waveIndex,
        directDependency,
    };
}

function publishRunScoped(runningDir, containerName, {
    runId = RUN_ID,
    runStartedAtMs,
    waveIndex,
    state = 'starting',
    sequencePhase = 'active',
    sequencePhaseStartedAtMs = runStartedAtMs,
    pid = process.pid,
    ...rest
}) {
    const target = coordinationPath(runningDir, containerName, runId);
    fs.writeFileSync(target, JSON.stringify({
        containerName,
        runId,
        runStartedAtMs,
        waveIndex,
        state,
        pid,
        sequencePhase,
        sequencePhaseStartedAtMs,
        ...rest,
    }, null, 2));
    return target;
}

// A deterministic clock: every simulated sleep advances it, so bounded
// deadlines are exercised without real elapsed time.
function virtualClock(startMs) {
    let now = startMs;
    return {
        nowFn: () => now,
        sleepFn: async (ms) => { now += Math.max(1, Math.ceil(ms)); },
    };
}

async function settlesWithin(promise, ms) {
    const pendingMarker = Symbol('pending');
    const outcome = await Promise.race([
        promise.then(() => 'settled', () => 'settled'),
        new Promise((resolve) => { setTimeout(() => resolve(pendingMarker), ms); }),
    ]);
    return outcome !== pendingMarker;
}

test('three real waves settle through prior-wave statuses that are still waiting', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    for (const containerName of ['wave0-a', 'wave0-b']) {
        publishRunScoped(runningDir, containerName, {
            runStartedAtMs, waveIndex: 0, state: 'running',
        });
    }
    // The exact shape that broke the deployed run: a prior-wave member sitting
    // in its waiting phase while publishing an array of barrier references.
    for (const containerName of ['wave1-a', 'wave1-b']) {
        publishRunScoped(runningDir, containerName, {
            runStartedAtMs,
            waveIndex: 1,
            state: 'starting',
            sequencePhase: 'waiting-barrier',
            barrierStatuses: [
                { file: `wave0-a.${RUN_ID}.json`, waveIndex: 0, directDependency: true },
                { file: `wave0-b.${RUN_ID}.json`, waveIndex: 0, directDependency: false },
            ],
        });
    }

    const barrier = [
        barrierEntry(runningDir, 'wave1-a', { waveIndex: 1, directDependency: true }),
        barrierEntry(runningDir, 'wave1-b', { waveIndex: 1 }),
        barrierEntry(runningDir, 'wave0-a', { waveIndex: 0, directDependency: true }),
    ];
    const waiting = waitForNoWaitStatusBarrier(barrier, {
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 2,
        runningDir,
        waitOptions: { timeouts: FAST_TIMEOUTS, pollIntervalMs: 10 },
    });

    assert.equal(
        await settlesWithin(waiting, 80),
        false,
        'a wave-two member still in its waiting phase must not release wave three',
    );

    for (const containerName of ['wave1-a', 'wave1-b']) {
        publishRunScoped(runningDir, containerName, {
            runStartedAtMs, waveIndex: 1, state: 'running',
        });
    }

    const observed = await waiting;
    assert.equal(observed.length, 3);
    assert.deepEqual(observed.map(({ status }) => status.state), ['running', 'running', 'running']);
});

test('same-wave workers enter active concurrently without observing each other', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    const observed = await Promise.all([0, 1].map(() => waitForNoWaitStatusBarrier([], {
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 0,
        runningDir,
        waitFn: () => { throw new Error('an empty barrier must never poll a status file'); },
    })));
    assert.deepEqual(observed, [[], []]);
    assert.deepEqual(fs.readdirSync(statusDirOf(runningDir)), []);
});

test('a wave barrier holds until every prior-wave member is terminal', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    publishRunScoped(runningDir, 'prior-a', {
        runStartedAtMs, waveIndex: 0, state: 'running',
    });
    publishRunScoped(runningDir, 'prior-b', {
        runStartedAtMs, waveIndex: 0, state: 'starting', sequencePhase: 'active',
    });

    const waiting = waitForNoWaitStatusBarrier([
        barrierEntry(runningDir, 'prior-a', { waveIndex: 0 }),
        barrierEntry(runningDir, 'prior-b', { waveIndex: 0 }),
    ], {
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 1,
        runningDir,
        waitOptions: { timeouts: FAST_TIMEOUTS, pollIntervalMs: 10 },
    });
    assert.equal(await settlesWithin(waiting, 60), false);

    publishRunScoped(runningDir, 'prior-b', {
        runStartedAtMs, waveIndex: 0, state: 'running',
    });
    assert.equal((await waiting).length, 2);
});

test('a direct dependency failure is raised only after the whole barrier settles', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    publishRunScoped(runningDir, 'dependency', {
        runStartedAtMs, waveIndex: 0, state: 'failed',
    });
    publishRunScoped(runningDir, 'peer', {
        runStartedAtMs, waveIndex: 0, state: 'starting', sequencePhase: 'active',
    });

    const waiting = waitForNoWaitStatusBarrier([
        barrierEntry(runningDir, 'dependency', { waveIndex: 0, directDependency: true }),
        barrierEntry(runningDir, 'peer', { waveIndex: 0 }),
    ], {
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 1,
        runningDir,
        waitOptions: { timeouts: FAST_TIMEOUTS, pollIntervalMs: 10 },
    });
    assert.equal(
        await settlesWithin(waiting, 60),
        false,
        'a failed dependency must not release the worker while a peer is still active',
    );

    publishRunScoped(runningDir, 'peer', {
        runStartedAtMs, waveIndex: 0, state: 'running',
    });
    await assert.rejects(
        () => waiting,
        (error) => error?.code === 'PLOINKY_NO_WAIT_DIRECT_DEPENDENCY_FAILED',
    );
});

test('an unrelated failed prior-wave worker satisfies the barrier without failing this worker', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    publishRunScoped(runningDir, 'unrelated', {
        runStartedAtMs, waveIndex: 0, state: 'failed',
    });
    publishRunScoped(runningDir, 'dependency', {
        runStartedAtMs, waveIndex: 0, state: 'running',
    });

    const observed = await waitForNoWaitStatusBarrier([
        barrierEntry(runningDir, 'unrelated', { waveIndex: 0 }),
        barrierEntry(runningDir, 'dependency', { waveIndex: 0, directDependency: true }),
    ], {
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 1,
        runningDir,
        waitOptions: { timeouts: FAST_TIMEOUTS, pollIntervalMs: 10 },
    });
    assert.deepEqual(observed.map(({ status }) => status.state), ['failed', 'running']);
});

test('a failed prior-wave worker is terminal while it is still in its waiting phase', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    publishRunScoped(runningDir, 'failed-while-waiting', {
        runStartedAtMs,
        waveIndex: 0,
        state: 'failed',
        sequencePhase: 'waiting-barrier',
        barrierStatuses: [{ file: 'ignored.json', waveIndex: 0, directDependency: true }],
    });
    const status = await waitForRunScopedStatus(
        barrierEntry(runningDir, 'failed-while-waiting', { waveIndex: 0 }),
        { runningDir, expectedRunId: RUN_ID, runStartedAtMs, timeouts: FAST_TIMEOUTS },
    );
    assert.deepEqual(status, { state: 'failed' });
});

test('run-scoped status binding rejects a foreign run, wave, or run start', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    const waitFor = (containerName, entryOverrides = {}) => waitForRunScopedStatus(
        barrierEntry(runningDir, containerName, { waveIndex: 0, ...entryOverrides }),
        { runningDir, expectedRunId: RUN_ID, runStartedAtMs, timeouts: FAST_TIMEOUTS },
    );

    publishRunScoped(runningDir, 'stale-run', {
        runStartedAtMs, waveIndex: 0, state: 'running', runId: FOREIGN_RUN_ID,
    });
    // The file name still carries this run, so only the payload identity can
    // reject a status left behind by another detached invocation.
    fs.renameSync(
        coordinationPath(runningDir, 'stale-run', FOREIGN_RUN_ID),
        coordinationPath(runningDir, 'stale-run'),
    );
    await assert.rejects(() => waitFor('stale-run'), /different run/);

    publishRunScoped(runningDir, 'wrong-wave', {
        runStartedAtMs, waveIndex: 7, state: 'running',
    });
    await assert.rejects(() => waitFor('wrong-wave'), /different dependency wave/);

    publishRunScoped(runningDir, 'wrong-start', {
        runStartedAtMs: runStartedAtMs - 1, waveIndex: 0, state: 'running',
    });
    await assert.rejects(() => waitFor('wrong-start'), /different run start/);

    publishRunScoped(runningDir, 'bad-phase', {
        runStartedAtMs, waveIndex: 0, state: 'starting', sequencePhase: 'waiting-predecessor',
    });
    await assert.rejects(() => waitFor('bad-phase'), /invalid sequence phase/);

    publishRunScoped(runningDir, 'running-while-waiting', {
        runStartedAtMs, waveIndex: 0, state: 'running', sequencePhase: 'waiting-barrier',
    });
    await assert.rejects(() => waitFor('running-while-waiting'), /outside its active phase/);
});

test('a missing status expires at its bounded cumulative queued deadline', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = 1_700_000_000_000;
    const clock = virtualClock(runStartedAtMs);
    await assert.rejects(
        () => waitForRunScopedStatus(
            barrierEntry(runningDir, 'never-published', { waveIndex: 0 }),
            {
                runningDir,
                expectedRunId: RUN_ID,
                runStartedAtMs,
                timeouts: FAST_TIMEOUTS,
                ...clock,
            },
        ),
        /timed out waiting for no-wait barrier status/,
    );
});

test('a transient malformed status recovers on the next valid read', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    const target = coordinationPath(runningDir, 'transient');
    fs.writeFileSync(target, '{"state":');
    setTimeout(() => {
        publishRunScoped(runningDir, 'transient', {
            runStartedAtMs, waveIndex: 0, state: 'running',
        });
    }, 20);

    const status = await waitForRunScopedStatus(
        barrierEntry(runningDir, 'transient', { waveIndex: 0 }),
        {
            runningDir,
            expectedRunId: RUN_ID,
            runStartedAtMs,
            timeouts: FAST_TIMEOUTS,
            pollIntervalMs: 5,
        },
    );
    assert.deepEqual(status, { state: 'running' });
});

test('a persistently malformed status fails closed after its bounded retry window', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    fs.writeFileSync(coordinationPath(runningDir, 'corrupt'), '{"state":');
    await assert.rejects(
        () => waitForRunScopedStatus(
            barrierEntry(runningDir, 'corrupt', { waveIndex: 0 }),
            {
                runningDir,
                expectedRunId: RUN_ID,
                runStartedAtMs,
                timeouts: FAST_TIMEOUTS,
                pollIntervalMs: 5,
            },
        ),
        /remained unreadable after bounded retries/,
    );
});

test('a malformed barrier member never releases the worker while a peer is still active', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    fs.writeFileSync(coordinationPath(runningDir, 'corrupt-member'), '{"state":');
    publishRunScoped(runningDir, 'active-member', {
        runStartedAtMs, waveIndex: 0, state: 'starting', sequencePhase: 'active',
    });

    const waiting = waitForNoWaitStatusBarrier([
        barrierEntry(runningDir, 'corrupt-member', { waveIndex: 0 }),
        barrierEntry(runningDir, 'active-member', { waveIndex: 0 }),
    ], {
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 1,
        runningDir,
        waitOptions: { timeouts: FAST_TIMEOUTS, pollIntervalMs: 5 },
    });
    assert.equal(
        await settlesWithin(waiting, 250),
        false,
        'the corrupt member expires early but must not propagate before the active peer settles',
    );

    publishRunScoped(runningDir, 'active-member', {
        runStartedAtMs, waveIndex: 0, state: 'running',
    });
    await assert.rejects(
        () => waiting,
        (error) => error?.code === 'PLOINKY_NO_WAIT_BARRIER_STATUS_INVALID'
            && /corrupt-member/.test(error.message),
    );
});

test('an active member receives a fresh full budget after a long queued wait', () => {
    const runStartedAtMs = 1_700_000_000_000;
    const timeouts = resolveNoWaitBarrierTimeouts();
    const queuedDeadline = noWaitQueuedStatusDeadline(runStartedAtMs, 0, timeouts);
    // The member entered its active phase long after the queued budget for its
    // own wave would have expired; the active window must restart from there.
    const sequencePhaseStartedAtMs = queuedDeadline + 5 * 60_000;
    const observation = resolveRunScopedObservation({
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 0,
        state: 'starting',
        sequencePhase: 'active',
        sequencePhaseStartedAtMs,
    }, {
        expectedRunId: RUN_ID,
        runStartedAtMs,
        targetWaveIndex: 0,
        timeouts,
        nowMs: sequencePhaseStartedAtMs,
    });
    assert.equal(
        observation.deadline,
        sequencePhaseStartedAtMs + timeouts.activeTimeoutMs + timeouts.terminalPublicationGraceMs,
    );
    assert.ok(observation.deadline > queuedDeadline);
});

test('a deep wave keeps its cumulative queued budget while each input stays clamped', () => {
    const timeouts = resolveNoWaitBarrierTimeouts();
    const runStartedAtMs = 1_700_000_000_000;
    const budgetMs = noWaitQueuedStatusDeadline(runStartedAtMs, 3, timeouts) - runStartedAtMs;
    assert.equal(budgetMs, 4 * (timeouts.activeTimeoutMs + timeouts.terminalPublicationGraceMs)
        + timeouts.startupGraceMs);
    assert.ok(budgetMs > 3_600_000, 'a wave-three target must exceed the single active-timeout maximum');

    // The active window has to cover a sanctioned image pull, otherwise an
    // observer expires while its prerequisite is still pulling legitimately.
    // One launch may perform more than one permitted pull, so the window must
    // cover all of them rather than a single budget.
    const defaults = resolveNoWaitBarrierTimeouts();
    assert.equal(defaults.sanctionedPullBudgetMs, defaults.imagePullBudgetMs * 3);
    assert.equal(defaults.sanctionedBuildBudgetMs, defaults.imageBuildBudgetMs);
    assert.equal(
        defaults.activeTimeoutMs,
        defaults.phaseTimeoutMs + defaults.sanctionedPullBudgetMs + defaults.sanctionedBuildBudgetMs,
    );
    assert.ok(
        defaults.activeTimeoutMs > defaults.imagePullBudgetMs * 3,
        'the active window must exceed prefetch, authoritative retry, and helper pull combined',
    );

    const clamped = resolveNoWaitBarrierTimeouts({
        activeTimeoutMs: 99_999_999,
        terminalPublicationGraceMs: 99_999_999,
        readRetryTimeoutMs: 99_999_999,
        startupGraceMs: 99_999_999,
        imagePullBudgetMs: 99_999_999,
        imageBuildBudgetMs: 99_999_999,
    });
    assert.deepEqual({ ...clamped }, {
        phaseTimeoutMs: 3_600_000,
        imagePullBudgetMs: 86_400_000,
        imageBuildBudgetMs: 86_400_000,
        sanctionedPullBudgetMs: 259_200_000,
        sanctionedBuildBudgetMs: 86_400_000,
        activeTimeoutMs: 349_200_000,
        terminalPublicationGraceMs: 300_000,
        readRetryTimeoutMs: 30_000,
        startupGraceMs: 300_000,
    });
    const floored = resolveNoWaitBarrierTimeouts({
        activeTimeoutMs: -5,
        terminalPublicationGraceMs: -5,
        readRetryTimeoutMs: -5,
        startupGraceMs: -5,
        imagePullBudgetMs: -5,
        imageBuildBudgetMs: -5,
    });
    assert.deepEqual({ ...floored }, {
        phaseTimeoutMs: 1000,
        imagePullBudgetMs: 0,
        imageBuildBudgetMs: 0,
        sanctionedPullBudgetMs: 0,
        sanctionedBuildBudgetMs: 0,
        activeTimeoutMs: 1000,
        terminalPublicationGraceMs: 0,
        readRetryTimeoutMs: 100,
        startupGraceMs: 0,
    });
    assert.throws(
        () => noWaitQueuedStatusDeadline(runStartedAtMs, 1024, timeouts),
        /wave index must be an integer between 0 and 1023/,
    );
});

test('invalid run and phase timestamps fail closed', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = Date.now();
    const timeouts = FAST_TIMEOUTS;
    const observe = (status, overrides = {}) => resolveRunScopedObservation(status, {
        expectedRunId: RUN_ID,
        runStartedAtMs,
        targetWaveIndex: 0,
        timeouts,
        nowMs: runStartedAtMs,
        ...overrides,
    });

    assert.throws(() => observe({
        runId: RUN_ID, runStartedAtMs, waveIndex: 0, state: 'starting', sequencePhase: 'active',
        sequencePhaseStartedAtMs: runStartedAtMs + 60_000,
    }), /invalid start timestamp/);
    assert.throws(() => observe({
        runId: RUN_ID, runStartedAtMs, waveIndex: 0, state: 'starting', sequencePhase: 'active',
    }), /invalid start timestamp/);
    assert.throws(() => observe({
        runId: RUN_ID, runStartedAtMs, waveIndex: 0, state: 'starting', sequencePhase: 'active',
        sequencePhaseStartedAtMs: -1,
    }), /invalid start timestamp/);
    for (const coercible of [null, '', false, [], String(runStartedAtMs), runStartedAtMs + 0.5]) {
        assert.throws(() => observe({
            runId: RUN_ID,
            runStartedAtMs,
            waveIndex: 0,
            state: 'starting',
            sequencePhase: 'active',
            sequencePhaseStartedAtMs: coercible,
            sequencePhaseStartedAt: new Date(runStartedAtMs).toISOString(),
        }), /invalid start timestamp/, `a numeric timestamp of ${JSON.stringify(coercible)} must fail closed`);
    }
    assert.deepEqual(observe({
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 0,
        state: 'starting',
        sequencePhase: 'active',
        sequencePhaseStartedAt: new Date(runStartedAtMs).toISOString(),
    }), {
        deadline: runStartedAtMs + timeouts.activeTimeoutMs + timeouts.terminalPublicationGraceMs,
        workerPid: null,
    });
    assert.throws(
        () => observe({ runId: RUN_ID, waveIndex: 0, state: 'running', sequencePhase: 'active' }),
        /different run start/,
    );
    await assert.rejects(
        () => waitForRunScopedStatus(
            barrierEntry(runningDir, 'bad-run-start', { waveIndex: 0 }),
            { runningDir, expectedRunId: RUN_ID, runStartedAtMs: -1, timeouts },
        ),
        /non-negative epoch millisecond integer/,
    );
    assert.throws(
        () => noWaitQueuedStatusDeadline(Number.MAX_SAFE_INTEGER, 3, timeouts),
        /overflowed its cumulative wave budget/,
    );
    assert.throws(() => observe({
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 0,
        state: 'starting',
        sequencePhase: 'active',
        sequencePhaseStartedAtMs: Number.MAX_SAFE_INTEGER,
    }, { nowMs: Number.MAX_SAFE_INTEGER }), /deadline overflowed/);
});

test('the run-scoped argument contract rejects every missing mandatory flag', (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'contract-container';
    const complete = {
        container: containerName,
        runId: RUN_ID,
        runStartedAtMs: '1700000000000',
        waveIndex: '1',
        statusFile: coordinationPath(runningDir, containerName),
        waitForStatuses: JSON.stringify([
            barrierEntry(runningDir, 'prior', { waveIndex: 0, directDependency: true }),
        ]),
    };
    const resolved = resolveNoWaitRunScopedArguments(complete, { containerName, runningDir });
    assert.equal(resolved.runId, RUN_ID);
    assert.equal(resolved.runStartedAtMs, 1700000000000);
    assert.equal(resolved.waveIndex, 1);
    assert.equal(resolved.waitForStatuses.length, 1);
    assert.equal(resolved.waitForStatuses[0].directDependency, true);

    for (const [key, flag] of [
        ['runId', 'run-id'],
        ['runStartedAtMs', 'run-started-at-ms'],
        ['waveIndex', 'wave-index'],
        ['statusFile', 'status-file'],
        ['waitForStatuses', 'wait-for-statuses'],
    ]) {
        const missing = { ...complete };
        delete missing[key];
        assert.throws(
            () => resolveNoWaitRunScopedArguments(missing, { containerName, runningDir }),
            new RegExp(`requires --${flag}$`),
            `a launch without --${flag} must be rejected`,
        );
    }

    // Wave zero is uniform: the flag is still mandatory and carries '[]'.
    const waveZero = resolveNoWaitRunScopedArguments({
        ...complete, waveIndex: '0', waitForStatuses: '[]',
    }, { containerName, runningDir });
    assert.deepEqual(waveZero.waitForStatuses, []);
    assert.throws(
        () => resolveNoWaitRunScopedArguments({
            ...complete, waveIndex: '0',
        }, { containerName, runningDir }),
        /references wave 0 from wave 0/,
        'wave zero must never carry a barrier reference',
    );
});

test('the worker parser accepts only recognized unique name-value pairs', (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'contract-container';
    const argv = [
        '--container', containerName,
        '--instance-id', INSTANCE_ID,
        '--enable-generation', ENABLE_GENERATION,
        '--short-agent', 'worker',
        '--repo', 'demo',
        '--alias', 'blue',
        '--manifest-path', '/workspace/demo/worker/manifest.json',
        '--agent-path', '/workspace/demo/worker',
        '--route-key', 'blue',
        '--run-id', RUN_ID,
        '--run-started-at-ms', '1700000000000',
        '--wave-index', '0',
        '--status-file', coordinationPath(runningDir, containerName),
        '--wait-for-statuses', '[]',
        '--profile', 'default',
        '--router-port', '8080',
        '--force-recreate', '1',
    ];
    const parsed = parseNoWaitWorkerArgs(argv, { runningDir });
    assert.equal(parsed.container, containerName);
    assert.equal(parsed.runScoped.runId, RUN_ID);
    assert.equal(parsed.routerPort, '8080');
    assert.equal(parsed.identity.instanceId, INSTANCE_ID);
    assert.equal(parsed.identity.routeKey, 'blue');

    const emptyAlias = [...argv];
    emptyAlias[emptyAlias.indexOf('--alias') + 1] = '';
    emptyAlias[emptyAlias.indexOf('--route-key') + 1] = 'worker';
    assert.equal(parseNoWaitWorkerArgs(emptyAlias, { runningDir }).identity.alias, '');

    const supportedAgentName = [...emptyAlias];
    supportedAgentName[supportedAgentName.indexOf('--short-agent') + 1] = 'agent+sidecar';
    supportedAgentName[supportedAgentName.indexOf('--route-key') + 1] = 'agent+sidecar';
    const supportedAgent = parseNoWaitWorkerArgs(supportedAgentName, { runningDir });
    assert.equal(supportedAgent.identity.shortAgent, 'agent+sidecar');
    assert.equal(supportedAgent.identity.routeKey, 'agent+sidecar');
    assert.equal(Object.isFrozen(supportedAgent.identity), true);

    for (const invalidAgentName of [
        'agent/sidecar',
        'agent:sidecar',
        'agent sidecar',
        'agent\tsidecar',
        'agent\u0000sidecar',
        'agent\u0085sidecar',
    ]) {
        const invalidAgent = [...emptyAlias];
        invalidAgent[invalidAgent.indexOf('--short-agent') + 1] = invalidAgentName;
        invalidAgent[invalidAgent.indexOf('--route-key') + 1] = invalidAgentName;
        assert.throws(
            () => parseNoWaitWorkerArgs(invalidAgent, { runningDir }),
            /short agent name is not one exact canonical identity value/,
        );
    }

    for (const flag of ['--instance-id', '--enable-generation', '--alias']) {
        const index = argv.indexOf(flag);
        const missing = argv.filter((_, tokenIndex) => tokenIndex !== index && tokenIndex !== index + 1);
        assert.throws(
            () => parseNoWaitWorkerArgs(missing, { runningDir }),
            new RegExp(`requires ${flag}$`),
        );
    }

    for (const broken of [
        [...argv, '--container', containerName],
        ['--container', containerName, ...argv],
        [...argv, '--unknown', 'value'],
        [...argv, 'positional'],
        [...argv, '--alias'],
    ]) {
        assert.throws(() => parseNoWaitWorkerArgs(broken, { runningDir }));
    }
});

test('a barrier reference must name an earlier wave inside this run', (t) => {
    const { runningDir } = fixture(t);
    const parse = (entries, waveIndex = 2) => parseNoWaitStatusBarrier(
        JSON.stringify(entries),
        { runId: RUN_ID, waveIndex, runningDir },
    );
    assert.equal(parse([]).length, 0);
    assert.throws(
        () => parse([barrierEntry(runningDir, 'peer', { waveIndex: 2 })]),
        /references wave 2 from wave 2/,
    );
    assert.throws(
        () => parse([barrierEntry(runningDir, 'foreign', { waveIndex: 0, runId: FOREIGN_RUN_ID })]),
        /different run/,
    );
    assert.throws(
        () => parse([
            barrierEntry(runningDir, 'twice', { waveIndex: 0 }),
            barrierEntry(runningDir, 'twice', { waveIndex: 1 }),
        ]),
        /repeats/,
    );
    assert.throws(
        () => parse([{ path: path.join(runningDir, 'foreign.json'), runId: RUN_ID, waveIndex: 0, directDependency: false }]),
        /must be an absolute JSON file/,
    );
    assert.throws(() => parse(''), /must be an array/);
    assert.throws(
        () => parseNoWaitStatusBarrier('', { runId: RUN_ID, waveIndex: 1, runningDir }),
        /must be one JSON array argument/,
    );
});

test('run-scoped worker status publishes the canonical view before the coordination handoff', (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'publish-order';
    const runStartedAtMs = 1_700_000_000_000;
    const canonical = path.join(statusDirOf(runningDir), `${containerName}.json`);
    const coordination = coordinationPath(runningDir, containerName);

    const document = writeNoWaitWorkerStatus(containerName, {
        state: 'starting',
        sequencePhase: 'waiting-barrier',
    }, {
        identity: workerIdentity(containerName, { runStartedAtMs, waveIndex: 2 }),
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 2,
        statusFile: coordination,
        runningDir,
    });
    assert.deepEqual(document, {
        state: 'starting',
        sequencePhase: 'waiting-barrier',
        ...workerIdentity(containerName, { runStartedAtMs, waveIndex: 2 }),
    });
    for (const target of [canonical, coordination]) {
        assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), document);
    }
    assert.throws(
        () => writeNoWaitWorkerStatus(containerName, {}, {
            identity: workerIdentity(containerName, { runStartedAtMs }),
            runId: RUN_ID, runStartedAtMs, waveIndex: 0, statusFile: canonical, runningDir,
        }),
        /must be the exact run-scoped file/,
    );
    assert.throws(
        () => writeNoWaitWorkerStatus(containerName, {}, {
            identity: workerIdentity(containerName, { runStartedAtMs }),
            runId: RUN_ID, runStartedAtMs, statusFile: coordination, runningDir,
        }),
        /wave index must be an integer/,
    );
    assert.throws(
        () => writeNoWaitWorkerStatus(containerName, {}, {
            identity: workerIdentity(containerName, {
                runStartedAtMs: runStartedAtMs + 1,
                waveIndex: 2,
            }),
            runId: RUN_ID,
            runStartedAtMs,
            waveIndex: 2,
            statusFile: coordination,
            runningDir,
        }),
        /does not match/,
        'a publisher may not replace the captured run start while retaining the run path',
    );

    // Content equality alone cannot detect a swapped write order, so fault the
    // coordination write and prove the canonical file was already replaced.
    // Coordination-first would release a dependent while monitors still saw an
    // older canonical phase.
    fs.rmSync(coordination);
    fs.mkdirSync(coordination);
    fs.writeFileSync(path.join(coordination, 'occupied'), 'x');
    assert.throws(() => writeNoWaitWorkerStatus(containerName, {
        state: 'running',
        sequencePhase: 'active',
    }, {
        identity: workerIdentity(containerName, { runStartedAtMs, waveIndex: 2 }),
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 2,
        statusFile: coordination,
        runningDir,
    }));
    assert.equal(
        JSON.parse(fs.readFileSync(canonical, 'utf8')).state,
        'running',
        'the canonical view must already be durable when the coordination handoff fails',
    );
});

test('no-wait main delegates route activation to the serialized lifecycle transaction', () => {
    const source = fs.readFileSync(
        path.resolve('cli/commands/noWaitWorker.js'),
        'utf8',
    );
    const transaction = source.indexOf('await runNoWaitLifecycleTransaction(expectedIdentity, {');
    const activation = source.indexOf('async activate(lifecycle, context, result, {', transaction);
    const routeMutation = source.indexOf('await upsertRoute(', activation);
    const transactionEnd = source.indexOf('\n        });\n    } catch (err)', routeMutation);
    assert.ok(transaction > 0, 'no-wait worker must enter the serialized lifecycle transaction');
    assert.match(
        source.slice(transaction, activation),
        /retainLifecycleLocksThroughReadiness:\s*hasWaveBarrier/,
        'a dependency-ordered worker must keep its proven Router generation stable through readiness',
    );
    assert.ok(activation > transaction, 'route activation must be owned by the transaction callback');
    assert.ok(routeMutation > activation, 'route mutation must occur only within activation');
    assert.ok(transactionEnd > routeMutation, 'activation must finish before the transaction releases');
    assert.match(
        source.slice(activation, transactionEnd),
        /networkLifecycleCapability[\s\S]*await upsertRoute\([\s\S]*networkLifecycleCapability/,
        'activation must pass its exact live network capability into the route transaction',
    );
});

test('no-wait worker never owns the workspace lease while waiting for an active generation', async () => {
    const identity = { containerName: 'ploinky_demo_worker', routeKey: 'background' };
    const lifecycle = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-ready',
    };
    let now = 0;
    let loads = 0;
    let leaseHeld = false;
    let leaseCalls = 0;
    const result = await withActiveNoWaitWorkerLifecycleLease(identity, async (locked) => {
        assert.equal(leaseHeld, true);
        assert.deepEqual(locked, lifecycle);
        return 'launched';
    }, {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        nowFn: () => now,
        loadFn() {
            loads += 1;
            if (loads <= 2) {
                assert.equal(leaseHeld, false, 'inactive selector polling must occur without the lease');
                throw Object.assign(new Error('publication inactive'), {
                    code: 'EDGE_GENERATION_INACTIVE',
                });
            }
            return lifecycle;
        },
        async withLeaseFn(options, callback) {
            assert.match(options.operation, /^no-wait-runtime:/);
            leaseCalls += 1;
            leaseHeld = true;
            try {
                return await callback();
            } finally {
                leaseHeld = false;
            }
        },
        async sleepFn(delayMs) {
            assert.equal(leaseHeld, false, 'publication recovery delay must not retain the lease');
            now += delayMs;
        },
    });

    assert.equal(result, 'launched');
    assert.equal(leaseCalls, 1);
    assert.equal(leaseHeld, false);
});

test('cold no-wait peers may wait for the full sanctioned active lifecycle budget', async () => {
    const identity = { containerName: 'ploinky_demo_worker', routeKey: 'background' };
    const lifecycle = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-ready',
    };
    const expectedTimeoutMs = resolveNoWaitBarrierTimeouts().activeTimeoutMs;
    assert.equal(resolveNoWaitLifecycleLeaseTimeoutMs(), expectedTimeoutMs);
    assert.ok(expectedTimeoutMs > 180_000);

    let now = 0;
    const value = await withActiveNoWaitWorkerLifecycleLease(identity, () => 'launched', {
        nowFn: () => now,
        loadFn: () => lifecycle,
        async withLeaseFn(options, callback) {
            assert.equal(options.waitTimeoutMs, expectedTimeoutMs);
            // Reproduce the previously fatal condition without making the
            // unit suite sleep: a cold peer owns the lease for over 180s.
            now = 181_000;
            return callback();
        },
    });

    assert.equal(value, 'launched');
});

test('retryable publication recovery reacquires between exact worker lease attempts', async () => {
    const identity = { containerName: 'ploinky_demo_worker', routeKey: 'background' };
    const beforeFailure = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-reconciling',
    };
    const afterRecovery = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-ready',
    };
    let now = 0;
    let state = 'before-failure';
    let leaseHeld = false;
    let acquisitions = 0;
    let releases = 0;
    let launches = 0;
    const result = await withActiveNoWaitWorkerLifecycleLease(identity, async (lifecycle) => {
        launches += 1;
        assert.equal(leaseHeld, true);
        assert.deepEqual(lifecycle, afterRecovery);
        return lifecycle.selectorActivationId;
    }, {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        nowFn: () => now,
        loadFn() {
            if (state === 'inactive') {
                throw Object.assign(new Error('publication retry pending'), {
                    code: 'EDGE_GENERATION_INACTIVE',
                });
            }
            return state === 'before-failure' ? beforeFailure : afterRecovery;
        },
        async withLeaseFn(_options, callback) {
            acquisitions += 1;
            leaseHeld = true;
            if (acquisitions === 1) state = 'inactive';
            try {
                return await callback();
            } finally {
                leaseHeld = false;
                releases += 1;
            }
        },
        async sleepFn(delayMs) {
            assert.equal(leaseHeld, false, 'publication must be able to reacquire between worker attempts');
            now += delayMs;
            if (state === 'inactive') state = 'recovered';
        },
    });

    assert.equal(result, 'activation-ready');
    assert.equal(acquisitions, 2);
    assert.equal(releases, 2);
    assert.equal(launches, 1);
    assert.equal(leaseHeld, false);
});

test('source-changing peer publication is recaptured outside the exact worker lease', async () => {
    const identity = { containerName: 'ploinky_demo_worker', routeKey: 'background' };
    const beforePublication = {
        generationDigest: 'sha256:before-publication',
        selectorActivationId: 'activation-before-publication',
    };
    const afterPublication = {
        generationDigest: 'sha256:after-publication',
        selectorActivationId: 'activation-after-publication',
    };
    let now = 0;
    let state = 'outside-source-change';
    let leaseHeld = false;
    let acquisitions = 0;
    let releases = 0;
    let launches = 0;

    const sourceChanged = () => Object.assign(
        new Error('edge routing sources changed since the active generation was selected'),
        { code: 'EDGE_GENERATION_SOURCE_CHANGED' },
    );
    const result = await withActiveNoWaitWorkerLifecycleLease(identity, async (lifecycle) => {
        launches += 1;
        assert.equal(leaseHeld, true);
        assert.deepEqual(lifecycle, afterPublication);
        return lifecycle.selectorActivationId;
    }, {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        nowFn: () => now,
        loadFn() {
            if (state === 'outside-source-change' || state === 'inside-source-change') {
                throw sourceChanged();
            }
            return state === 'before-publication' ? beforePublication : afterPublication;
        },
        async withLeaseFn(_options, callback) {
            acquisitions += 1;
            leaseHeld = true;
            if (acquisitions === 1) state = 'inside-source-change';
            try {
                return await callback();
            } finally {
                leaseHeld = false;
                releases += 1;
            }
        },
        async sleepFn(delayMs) {
            assert.equal(leaseHeld, false, 'publication recovery must occur outside the worker lease');
            now += delayMs;
            if (state === 'outside-source-change') state = 'before-publication';
            else if (state === 'inside-source-change') state = 'after-publication';
        },
    });

    assert.equal(result, 'activation-after-publication');
    assert.equal(acquisitions, 2);
    assert.equal(releases, 2);
    assert.equal(launches, 1);
    assert.equal(leaseHeld, false);
});

test('selector change inside the lease releases and retries the exact lifecycle capture', async () => {
    const identity = { containerName: 'ploinky_demo_worker', routeKey: 'background' };
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-reconciling',
    };
    const ready = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-ready',
    };
    let current = initial;
    let acquisitions = 0;
    let releases = 0;
    let launches = 0;
    let now = 0;
    await withActiveNoWaitWorkerLifecycleLease(identity, async (lifecycle) => {
        launches += 1;
        assert.deepEqual(lifecycle, ready);
    }, {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        nowFn: () => now,
        loadFn: () => current,
        async withLeaseFn(_options, callback) {
            acquisitions += 1;
            if (acquisitions === 1) current = ready;
            try {
                return await callback();
            } finally {
                releases += 1;
            }
        },
        async sleepFn(delayMs) { now += delayMs; },
    });

    assert.equal(acquisitions, 2);
    assert.equal(releases, 2);
    assert.equal(launches, 1);
});

test('inactive selector polling fails closed within one bound without acquiring a lease', async () => {
    let now = 0;
    let leaseCalls = 0;
    await assert.rejects(
        () => withActiveNoWaitWorkerLifecycleLease(
            { containerName: 'ploinky_demo_worker', routeKey: 'background' },
            async () => assert.fail('inactive selector must not launch'),
            {
                timeoutMs: 1_000,
                pollIntervalMs: 250,
                nowFn: () => now,
                loadFn() {
                    throw Object.assign(new Error('publication inactive'), {
                        code: 'EDGE_GENERATION_INACTIVE',
                    });
                },
                async withLeaseFn() { leaseCalls += 1; },
                async sleepFn(delayMs) { now += delayMs; },
            },
        ),
        (error) => error?.code === 'NO_WAIT_EDGE_LEASE_TIMEOUT',
    );
    assert.equal(now, 1_000);
    assert.equal(leaseCalls, 0);
});

test('source-changing selector polling fails closed within one bound without acquiring a lease', async () => {
    let now = 0;
    let leaseCalls = 0;
    await assert.rejects(
        () => withActiveNoWaitWorkerLifecycleLease(
            { containerName: 'ploinky_demo_worker', routeKey: 'background' },
            async () => assert.fail('source-changing selector must not launch'),
            {
                timeoutMs: 1_000,
                pollIntervalMs: 250,
                nowFn: () => now,
                loadFn() {
                    throw Object.assign(new Error('publication source mutation is incomplete'), {
                        code: 'EDGE_GENERATION_SOURCE_CHANGED',
                    });
                },
                async withLeaseFn() { leaseCalls += 1; },
                async sleepFn(delayMs) { now += delayMs; },
            },
        ),
        (error) => error?.code === 'NO_WAIT_EDGE_LEASE_TIMEOUT',
    );
    assert.equal(now, 1_000);
    assert.equal(leaseCalls, 0);
});

test('worker lifecycle lease does not retry a corrupt active generation', async () => {
    let loads = 0;
    let leaseCalls = 0;
    await assert.rejects(
        () => withActiveNoWaitWorkerLifecycleLease(
            { containerName: 'ploinky_demo_worker', routeKey: 'background' },
            async () => assert.fail('corrupt generation must not launch'),
            {
                loadFn() {
                    loads += 1;
                    throw Object.assign(new Error('active generation is corrupt'), {
                        code: 'EDGE_GENERATION_CORRUPT',
                    });
                },
                async withLeaseFn() { leaseCalls += 1; },
            },
        ),
        /active generation is corrupt/,
    );
    assert.equal(loads, 1);
    assert.equal(leaseCalls, 0);
});

test('worker lifecycle polling recaptures a source-changing generation exactly', async () => {
    const expected = {
        generationDigest: 'sha256:current',
        selectorActivationId: 'activation-current',
    };
    let attempts = 0;
    const lifecycle = await waitForNoWaitWorkerLifecycle({ routeKey: 'background' }, {
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        loadFn() {
            attempts += 1;
            if (attempts === 1) {
                throw Object.assign(new Error('publication source mutation is incomplete'), {
                    code: 'EDGE_GENERATION_SOURCE_CHANGED',
                });
            }
            return expected;
        },
        async sleepFn() {},
    });

    assert.equal(attempts, 2);
    assert.equal(lifecycle, expected);
});

test('no-wait launch waits for the staged edge generation to become active', async () => {
    const expected = { generationDigest: 'sha256:active' };
    const identity = { routeKey: 'background' };
    let attempts = 0;

    const lifecycle = await waitForNoWaitLifecycle(identity, {
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        loadFn(receivedIdentity) {
            attempts += 1;
            assert.equal(receivedIdentity, identity);
            if (attempts < 3) {
                const error = new Error('edge routing generation is inactive');
                error.code = 'EDGE_GENERATION_INACTIVE';
                throw error;
            }
            return expected;
        },
        async sleepFn() {},
    });

    assert.equal(attempts, 3);
    assert.equal(lifecycle, expected);
});

test('no-wait launch does not retry a corrupt active edge generation', async () => {
    let attempts = 0;
    await assert.rejects(
        () => waitForNoWaitLifecycle({ routeKey: 'background' }, {
            timeoutMs: 1_000,
            pollIntervalMs: 1,
            loadFn() {
                attempts += 1;
                const error = new Error('active generation is corrupt');
                error.code = 'EDGE_GENERATION_CORRUPT';
                throw error;
            },
            async sleepFn() {},
        }),
        /active generation is corrupt/,
    );
    assert.equal(attempts, 1);
});

test('route lifecycle does not retry a source-changing active generation', async () => {
    let attempts = 0;
    await assert.rejects(
        () => waitForNoWaitLifecycle({ routeKey: 'background' }, {
            loadFn() {
                attempts += 1;
                throw Object.assign(new Error('active routing sources changed'), {
                    code: 'EDGE_GENERATION_SOURCE_CHANGED',
                });
            },
        }),
        /active routing sources changed/,
    );
    assert.equal(attempts, 1);
});

test('no-wait route activation rebinds to the same generation after a Router restart', async () => {
    const identity = { routeKey: 'background' };
    const lifecycle = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-after-restart',
    };
    let attempts = 0;

    const rebound = await waitForNoWaitRouteActivation(
        identity,
        { generation: 'sha256:active', activationId: 'activation-before-restart' },
        {
            timeoutMs: 1_000,
            pollIntervalMs: 1,
            loadFn() {
                attempts += 1;
                if (attempts < 2) {
                    const error = new Error('edge routing generation is inactive');
                    error.code = 'EDGE_GENERATION_INACTIVE';
                    throw error;
                }
                return lifecycle;
            },
            async sleepFn() {},
        },
    );

    assert.equal(attempts, 2);
    assert.equal(rebound, lifecycle);
});

test('no-wait route activation rejects a different generation after restart', async () => {
    await assert.rejects(
        () => waitForNoWaitRouteActivation(
            { routeKey: 'background' },
            { generation: 'sha256:launch' },
            {
                loadFn() {
                    return {
                        generationDigest: 'sha256:replacement',
                        selectorActivationId: 'activation-two',
                    };
                },
            },
        ),
        /generation changed before route activation/,
    );
});

test('no-wait route activation rebases only across an unchanged staged lifecycle', async () => {
    const identity = { routeKey: 'background' };
    const initial = {
        targetState: 'staged',
        generationDigest: 'sha256:launch',
        selectorActivationId: 'activation-one',
        record: {
            type: 'agent',
            instanceId: 'instance-one',
            enableGeneration: 'enable-one',
        },
        route: {
            container: 'ploinky_demo_worker',
            hostPath: '/workspace/demo/worker',
        },
        manifest: {
            container: 'node:24',
        },
        routerPort: 8080,
        routerHostPort: 19090,
    };
    const rebound = {
        ...initial,
        generationDigest: 'sha256:unrelated-route-update',
        selectorActivationId: 'activation-two',
    };

    assert.equal(
        await waitForNoWaitRouteActivation(
            identity,
            { generation: initial.generationDigest },
            {
                expectedLifecycle: initial,
                loadFn: () => rebound,
            },
        ),
        rebound,
    );
    assert.equal(assertNoWaitLifecycleRebase(initial, rebound, identity), rebound);

    await assert.rejects(
        () => waitForNoWaitRouteActivation(
            identity,
            { generation: initial.generationDigest },
            {
                expectedLifecycle: initial,
                loadFn: () => ({
                    ...rebound,
                    manifest: {
                        ...rebound.manifest,
                        container: 'node:25',
                    },
                }),
            },
        ),
        /lifecycle changed before route activation/,
    );
});

test('no-wait host launch retries an inactive locked read after releasing the apply lock', async () => {
    const identity = { routeKey: 'liveKitServerAgent' };
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-before-apply',
    };
    const rebound = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-after-apply',
    };
    let loadCalls = 0;
    let lockHeld = false;
    let lockCalls = 0;
    let sleeps = 0;
    let launches = 0;

    const result = await launchNoWaitHostRuntime(identity, initial, async () => {
        launches += 1;
        assert.equal(lockHeld, false);
        return { containerName: 'livekit-runtime' };
    }, {
        loadFn(receivedIdentity) {
            loadCalls += 1;
            assert.equal(receivedIdentity, identity);
            if (loadCalls === 1) {
                const error = new Error('edge routing generation is inactive');
                error.code = 'EDGE_GENERATION_INACTIVE';
                throw error;
            }
            return rebound;
        },
        async withApplyLockFn(callback) {
            lockCalls += 1;
            lockHeld = true;
            try {
                return await callback();
            } finally {
                lockHeld = false;
            }
        },
        async sleepFn() {
            sleeps += 1;
            assert.equal(lockHeld, false);
        },
    });

    assert.deepEqual(result, { containerName: 'livekit-runtime' });
    assert.equal(loadCalls, 3);
    assert.equal(lockCalls, 2);
    assert.equal(sleeps, 1);
    assert.equal(launches, 1);
});

test('no-wait host launch rejects a replacement generation without launching a runtime', async () => {
    const initial = {
        generationDigest: 'sha256:launch',
        selectorActivationId: 'activation-before-apply',
    };
    let loadCalls = 0;
    let lockCalls = 0;
    let launches = 0;

    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => {
                launches += 1;
            },
            {
                loadFn() {
                    loadCalls += 1;
                    if (loadCalls === 1) {
                        const error = new Error('edge routing generation is inactive');
                        error.code = 'EDGE_GENERATION_INACTIVE';
                        throw error;
                    }
                    return {
                        generationDigest: 'sha256:replacement',
                        selectorActivationId: 'activation-after-apply',
                    };
                },
                async withApplyLockFn(callback) {
                    lockCalls += 1;
                    return callback();
                },
                async sleepFn() {},
            },
        ),
        /generation changed before host launch/,
    );
    assert.equal(loadCalls, 2);
    assert.equal(lockCalls, 1);
    assert.equal(launches, 0);
});

test('no-wait host launch requires one unchanged selector inside each apply lock', async () => {
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-before-lock',
    };
    let launches = 0;

    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => {
                launches += 1;
            },
            {
                loadFn() {
                    return {
                        generationDigest: 'sha256:active',
                        selectorActivationId: 'activation-inside-lock',
                    };
                },
                async withApplyLockFn(callback) {
                    return callback();
                },
            },
        ),
        /activation changed before host launch/,
    );
    assert.equal(launches, 0);
});

test('no-wait host launch never retries an inactive error after runtime creation starts', async () => {
    const inactive = new Error('runtime launch reported inactive');
    inactive.code = 'EDGE_GENERATION_INACTIVE';
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-one',
    };
    let launches = 0;
    let sleeps = 0;

    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => {
                launches += 1;
                throw inactive;
            },
            {
                loadFn() {
                    return initial;
                },
                async withApplyLockFn(callback) {
                    return callback();
                },
                async sleepFn() {
                    sleeps += 1;
                },
            },
        ),
        (error) => error === inactive,
    );
    assert.equal(launches, 1);
    assert.equal(sleeps, 0);
});

test('no-wait host launch retries only inactivity and times out within one bounded window', async () => {
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-one',
    };
    let now = 0;
    let loadCalls = 0;
    let lockCalls = 0;

    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => assert.fail('runtime must not launch while the edge is inactive'),
            {
                timeoutMs: 1_000,
                pollIntervalMs: 250,
                loadFn() {
                    loadCalls += 1;
                    const error = new Error('edge routing generation is inactive');
                    error.code = 'EDGE_GENERATION_INACTIVE';
                    throw error;
                },
                async withApplyLockFn(callback) {
                    lockCalls += 1;
                    return callback();
                },
                async sleepFn(ms) {
                    now += ms;
                },
                nowFn() {
                    return now;
                },
            },
        ),
        (error) => (
            error?.code === 'NO_WAIT_HOST_LAUNCH_TIMEOUT'
            && error?.cause?.code === 'EDGE_GENERATION_INACTIVE'
        ),
    );
    assert.equal(now, 1_000);
    assert.equal(loadCalls, 4);
    assert.equal(lockCalls, 1);

    const busy = new Error('edge generation apply is already in progress');
    busy.code = 'EDGE_GENERATION_BUSY';
    let busySleeps = 0;
    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => assert.fail('runtime must not launch without the apply lock'),
            {
                loadFn() {
                    return initial;
                },
                withApplyLockFn() {
                    throw busy;
                },
                async sleepFn() {
                    busySleeps += 1;
                },
            },
        ),
        (error) => error === busy,
    );
    assert.equal(busySleeps, 0);
});

test('no-wait launch accepts only its exact active target-less identity', () => {
    const active = {
        selector: {
            generation: 'sha256:active-generation',
            activationId: 'activation-one',
        },
        generation: {
            agents: {
                ploinky_demo_worker: {
                    type: 'agent',
                    repoName: 'demo',
                    agentName: 'worker',
                    alias: 'background',
                    instanceId: 'instance-one',
                    enableGeneration: 'enable-one',
                },
            },
            routing: {
                port: 8080,
                routes: {
                    background: {
                        container: 'ploinky_demo_worker',
                        repo: 'demo',
                        agent: 'worker',
                        alias: 'background',
                        hostPath: '/workspace/demo/worker',
                    },
                },
            },
            manifests: {
                background: {
                    container: 'node:24',
                },
            },
            routerHostPort: 19090,
        },
    };
    const identity = {
        containerName: 'ploinky_demo_worker',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: 'background',
        routeKey: 'background',
        agentPath: '/workspace/demo/worker',
    };

    const lifecycle = assertNoWaitLifecycleSnapshot(active, identity);
    assert.equal(lifecycle.record.instanceId, 'instance-one');
    assert.equal(lifecycle.generationDigest, 'sha256:active-generation');
    assert.equal(lifecycle.selectorActivationId, 'activation-one');
    assert.equal(lifecycle.routerPort, 8080);
    assert.equal(lifecycle.routerHostPort, 19090);
    assert.throws(
        () => assertNoWaitLifecycleSnapshot({
            generation: {
                ...active.generation,
                routing: {
                    routes: {
                        background: {
                            ...active.generation.routing.routes.background,
                            hostPort: 43123,
                        },
                    },
                },
            },
        }, identity),
        /target-less staged route/,
    );
    assert.doesNotThrow(() => assertNoWaitRegistryRecord({
        ...active.generation.agents.ploinky_demo_worker,
        runtime: 'podman',
        containerId: 'runtime-one',
    }, active.generation.agents.ploinky_demo_worker, identity));
    assert.throws(
        () => assertNoWaitRegistryRecord({
            ...active.generation.agents.ploinky_demo_worker,
            enableGeneration: 'different-enable-generation',
        }, active.generation.agents.ploinky_demo_worker, identity),
        /registry identity inconsistent/,
    );
    assert.throws(
        () => assertNoWaitRegistryRecord({
            ...active.generation.agents.ploinky_demo_worker,
            instanceId: { toString: () => 'instance-one' },
        }, active.generation.agents.ploinky_demo_worker, identity),
        /registry identity inconsistent/,
        'registry admission must not coerce an identity-shaped value into the expected bytes',
    );
});

test('queued no-wait launch adopts the exact ready runtime published by a foreground start', () => {
    const identity = {
        containerName: 'ploinky_demo_worker',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: 'background',
        routeKey: 'background',
        agentPath: '/workspace/demo/worker',
    };
    const ready = {
        selector: {
            generation: 'sha256:foreground-start',
            activationId: 'activation-one',
        },
        generation: {
            agents: {
                ploinky_demo_worker: {
                    type: 'agent',
                    repoName: 'demo',
                    agentName: 'worker',
                    alias: 'background',
                    instanceId: 'instance-one',
                    enableGeneration: 'enable-one',
                    runtime: 'podman',
                    containerId: 'a'.repeat(64),
                },
            },
            routing: {
                port: 8080,
                routes: {
                    background: {
                        container: 'ploinky_demo_worker',
                        repo: 'demo',
                        agent: 'worker',
                        alias: 'background',
                        hostPath: '/workspace/demo/worker',
                        hostPort: 43123,
                    },
                },
            },
            manifests: {
                background: {
                    container: 'node:24',
                },
            },
            routerHostPort: 19090,
        },
    };

    const lifecycle = resolveNoWaitWorkerLifecycleSnapshot(ready, identity);
    assert.equal(lifecycle.targetState, 'ready');
    assert.equal(lifecycle.route.hostPort, 43123);
    assert.equal(lifecycle.record.containerId, 'a'.repeat(64));
    assert.equal(
        assertNoWaitAdoptionStillCurrent(lifecycle, {
            ...lifecycle,
            generationDigest: 'sha256:unrelated-route-update',
            selectorActivationId: 'activation-two',
        }, identity).selectorActivationId,
        'activation-two',
    );

    const changedTarget = assertNoWaitAdoptableLifecycleSnapshot({
        ...ready,
        selector: {
            generation: 'sha256:replacement',
            activationId: 'activation-three',
        },
        generation: {
            ...ready.generation,
            routing: {
                ...ready.generation.routing,
                routes: {
                    background: {
                        ...ready.generation.routing.routes.background,
                        hostPort: 43124,
                    },
                },
            },
        },
    }, identity);
    assert.throws(
        () => assertNoWaitAdoptionStillCurrent(lifecycle, changedTarget, identity),
        /adopted runtime changed/,
    );
    assert.throws(
        () => assertNoWaitAdoptionStillCurrent(lifecycle, {
            ...lifecycle,
            record: {
                ...lifecycle.record,
                enableGeneration: 'replacement-enable-generation',
            },
        }, identity),
        /adopted runtime changed/,
    );
    assert.throws(
        () => assertNoWaitAdoptionStillCurrent(lifecycle, {
            ...lifecycle,
            manifest: {
                ...lifecycle.manifest,
                container: 'node:25',
            },
        }, identity),
        /adopted runtime changed/,
    );
});

test('queued no-wait launch rejects incomplete or foreign published targets', () => {
    const identity = {
        containerName: 'ploinky_demo_worker',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: '',
        routeKey: 'worker',
        agentPath: '/workspace/demo/worker',
    };
    const active = {
        selector: {
            generation: 'sha256:active',
            activationId: 'activation-one',
        },
        generation: {
            agents: {
                ploinky_demo_worker: {
                    type: 'agent',
                    repoName: 'demo',
                    agentName: 'worker',
                    alias: '',
                    instanceId: 'instance-one',
                    enableGeneration: 'enable-one',
                    runtime: 'podman',
                    containerId: 'b'.repeat(64),
                },
            },
            routing: {
                routes: {
                    worker: {
                        container: 'ploinky_demo_worker',
                        repo: 'demo',
                        agent: 'worker',
                        hostPath: '/workspace/demo/worker',
                        hostPort: 0,
                    },
                },
            },
            manifests: {
                worker: {
                    container: 'node:24',
                },
            },
        },
    };

    assert.throws(
        () => resolveNoWaitWorkerLifecycleSnapshot(active, identity),
        /cannot adopt an existing target/,
    );
    assert.throws(
        () => resolveNoWaitWorkerLifecycleSnapshot({
            ...active,
            generation: {
                ...active.generation,
                routing: {
                    routes: {
                        worker: {
                            ...active.generation.routing.routes.worker,
                            hostPort: 43123,
                            container: 'ploinky_foreign_worker',
                        },
                    },
                },
            },
        }, identity),
        /exact staged route identity/,
    );
});

test('no-wait immutable reinspection rejects disagreement with its registry receipt', () => {
    const expectedIdentity = {
        containerName: 'ploinky_demo_worker',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: '',
    };
    const registryRecord = {
        type: 'agent',
        runtime: 'podman',
        repoName: 'demo',
        agentName: 'worker',
        alias: '',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        containerId: 'b'.repeat(64),
    };
    let inspected = false;

    assert.throws(
        () => assertNoWaitRuntimeStillExact({
            containerName: expectedIdentity.containerName,
            containerId: 'a'.repeat(64),
            registryRecord,
        }, {
            profileResolution: { network: { mode: 'default' } },
            expectedIdentity,
        }, {
            createAdapter: () => ({
                inspectContainerContract() {
                    inspected = true;
                    return { state: 'exact', id: 'a'.repeat(64) };
                },
            }),
            getRuntime: () => 'podman',
            isContainerRunning: () => true,
        }),
        /consistent immutable container ID/,
    );
    assert.equal(inspected, false, 'a contradictory receipt must fail before runtime inspection');
});

test('no-wait cleanup accepts an exited container only when its immutable contract stays exact', () => {
    const expectedIdentity = {
        containerName: 'ploinky_demo_worker',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: '',
    };
    const containerId = 'a'.repeat(64);
    const result = {
        containerName: expectedIdentity.containerName,
        containerId,
        registryRecord: {
            type: 'agent',
            runtime: 'podman',
            repoName: 'demo',
            agentName: 'worker',
            alias: '',
            instanceId: 'instance-one',
            enableGeneration: 'enable-one',
            containerId,
        },
    };
    const dependencies = {
        createAdapter: () => ({
            inspectContainerContract: () => ({ state: 'exact', id: containerId, running: false }),
        }),
        getRuntime: () => 'podman',
    };
    const context = {
        profileResolution: { network: { mode: 'default' } },
        expectedIdentity,
    };

    assert.throws(
        () => assertNoWaitRuntimeStillExact(result, context, dependencies),
        /changed immutable identity/,
        'publication must still reject an exited runtime',
    );
    assert.equal(
        assertNoWaitRuntimeStillExact(result, context, {
            ...dependencies,
            requireRunning: false,
        }),
        result,
        'cleanup may remove the exact stopped task-owned container',
    );
});

test('no-wait failure cleanup removes only a runtime created by this launch', async () => {
    const cleaned = [];
    const aborted = [];
    const cleanup = async (candidate) => cleaned.push(candidate.containerName);
    const abortPreparation = async (lease) => aborted.push(lease.leaseId);

    assert.equal(await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'new-runtime',
        createdByThisLaunch: true,
    }, { cleanup, abortPreparation }), true);
    assert.equal(await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'reused-runtime',
        createdByThisLaunch: false,
    }, { cleanup, abortPreparation }), false);
    assert.equal(await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'prepared-adoption',
        requiresEdgeActivation: true,
        preparationLease: { leaseId: 'exact-lease' },
    }, { cleanup, abortPreparation }), true);
    assert.equal(await cleanupNoWaitTaskOwnedCandidate(null, { cleanup, abortPreparation }), false);
    assert.deepEqual(cleaned, ['new-runtime', 'prepared-adoption']);
    assert.deepEqual(aborted, ['exact-lease']);
});

test('no-wait cleanup aborts the exact preparation after candidate cleanup', async () => {
    const events = [];
    const preparationLease = { leaseId: 'prepared-exact' };
    await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'prepared-runtime',
        requiresEdgeActivation: true,
        preparationLease,
    }, {
        cleanup(candidate) {
            events.push(`cleanup:${candidate.containerName}`);
        },
        abortPreparation(received) {
            assert.equal(received, preparationLease);
            events.push(`abort:${received.leaseId}`);
        },
    });
    assert.deepEqual(events, ['cleanup:prepared-runtime', 'abort:prepared-exact']);
});

test('no-wait cleanup still aborts preparation when exact candidate removal fails', async () => {
    const events = [];
    const preparationLease = { leaseId: 'prepared-cleanup-failure' };
    await assert.rejects(cleanupNoWaitTaskOwnedCandidate({
        containerName: 'prepared-runtime',
        requiresEdgeActivation: true,
        preparationLease,
    }, {
        cleanup() {
            events.push('cleanup');
            throw new Error('cleanup failed');
        },
        abortPreparation(received) {
            assert.equal(received, preparationLease);
            events.push('abort');
        },
    }), /cleanup failed/);
    assert.deepEqual(events, ['cleanup', 'abort']);
});

test('run-scoped no-wait status publishes canonical and unique files with one run identity', (t) => {
    const { runningDir } = fixture(t);
    const runId = '11111111-1111-4111-8111-111111111111';
    const runStartedAtMs = 1_700_000_000_000;
    const statusDir = path.join(runningDir, 'no-wait');
    const statusFile = path.join(statusDir, `ploinky_demo_worker.${runId}.json`);

    writeNoWaitWorkerStatus('ploinky_demo_worker', { state: 'running' }, {
        identity: workerIdentity('ploinky_demo_worker', {
            runId,
            runStartedAtMs,
            waveIndex: 3,
        }),
        runId,
        runStartedAtMs,
        waveIndex: 3,
        statusFile,
        runningDir,
    });

    const canonical = JSON.parse(fs.readFileSync(
        path.join(statusDir, 'ploinky_demo_worker.json'),
        'utf8',
    ));
    const coordination = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.deepEqual(canonical, {
        state: 'running',
        ...workerIdentity('ploinky_demo_worker', {
            runId,
            runStartedAtMs,
            waveIndex: 3,
        }),
    });
    assert.deepEqual(coordination, canonical);
    assert.deepEqual(
        fs.readdirSync(statusDir).sort(),
        [`ploinky_demo_worker.${runId}.json`, 'ploinky_demo_worker.json'].sort(),
    );
    assert.throws(
        () => writeNoWaitWorkerStatus('ploinky_demo_worker', { state: 'failed' }, {
            identity: workerIdentity('ploinky_demo_worker', {
                runId,
                runStartedAtMs,
                waveIndex: 3,
            }),
            runId,
            runStartedAtMs,
            waveIndex: 3,
            statusFile: path.join(statusDir, `another-worker.${runId}.json`),
            runningDir,
        }),
        /exact run-scoped file/,
    );
});

test('the run-scoped barrier dispatches every member concurrently and settles all of them', async (t) => {
    const { runningDir } = fixture(t);
    const runId = '22222222-2222-4222-8222-222222222222';
    const runStartedAtMs = 1_700_000_000_000;
    const statusDir = path.join(runningDir, 'no-wait');
    const firstPath = path.join(statusDir, `first.${runId}.json`);
    const secondPath = path.join(statusDir, `second.${runId}.json`);
    const barrier = parseNoWaitStatusBarrier(JSON.stringify([
        { path: firstPath, runId, waveIndex: 0, directDependency: false },
        { path: secondPath, runId, waveIndex: 0, directDependency: true },
    ]), { runId, waveIndex: 1, runningDir });
    const started = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

    const waiting = waitForNoWaitStatusBarrier(barrier, {
        runId,
        runStartedAtMs,
        waveIndex: 1,
        runningDir,
        async waitFn(entry, options) {
            started.push(path.basename(entry.path));
            assert.equal(options.expectedRunId, runId);
            assert.equal(options.runStartedAtMs, runStartedAtMs);
            assert.equal(options.runningDir, runningDir);
            if (entry.path === firstPath) await firstGate;
            return { state: entry.path === firstPath ? 'failed' : 'running' };
        },
    });
    await Promise.resolve();
    assert.deepEqual(
        started.sort(),
        [path.basename(firstPath), path.basename(secondPath)].sort(),
        'every barrier member must be polled concurrently',
    );
    releaseFirst();
    const observed = await waiting;
    assert.equal(observed.length, 2);
    assert.equal(observed[0].status.state, 'failed');

    await assert.rejects(
        () => waitForNoWaitStatusBarrier(barrier, {
            runId,
            runStartedAtMs,
            waveIndex: 1,
            runningDir,
            waitFn: async (entry) => ({
                state: entry.path === secondPath ? 'failed' : 'running',
            }),
        }),
        (error) => error?.code === 'PLOINKY_NO_WAIT_DIRECT_DEPENDENCY_FAILED',
    );
});

function noWaitTransactionFixture() {
    const lifecycle = {
        targetState: 'staged',
        generationDigest: 'generation-one',
        selectorActivationId: 'activation-one',
        record: {
            type: 'agent',
            runtime: 'podman',
            instanceId: 'instance-one',
            enableGeneration: 'enable-one',
        },
        route: { container: 'ploinky_demo_worker' },
    };
    const candidate = {
        containerName: 'ploinky_demo_worker',
        containerId: 'a'.repeat(64),
        createdByThisLaunch: true,
        registryRecord: {
            ...lifecycle.record,
            containerId: 'a'.repeat(64),
        },
    };
    return { lifecycle, candidate };
}

test('ordinary no-wait readiness runs outside locks and activation is exactly reserialized', async () => {
    const { lifecycle, candidate } = noWaitTransactionFixture();
    let workspaceHeld = false;
    let networkHeld = false;
    let lifecycleLeases = 0;
    const lifecycleOptions = [];
    const networkOptions = [];

    const value = await runNoWaitLifecycleTransaction({ containerName: candidate.containerName }, {
        capture() {
            assert.equal(workspaceHeld, true);
            assert.equal(networkHeld, false);
            return {};
        },
        ensure() {
            assert.equal(workspaceHeld, true);
            assert.equal(networkHeld, true);
            return candidate;
        },
        readiness() {
            assert.equal(workspaceHeld, false);
            assert.equal(networkHeld, false);
        },
        revalidate(initial, current) {
            assert.equal(workspaceHeld, true);
            assert.equal(networkHeld, false);
            assert.equal(initial, lifecycle);
            assert.equal(current, lifecycle);
            return current;
        },
        inspectRuntime() {
            assert.equal(workspaceHeld, true);
            assert.equal(networkHeld, true);
        },
        activate(_current, _context, _result, { onCommitted }) {
            assert.equal(workspaceHeld, true);
            assert.equal(networkHeld, true);
            onCommitted();
            return 'activated';
        },
        async withLifecycleLease(_identity, callback, options) {
            lifecycleLeases += 1;
            lifecycleOptions.push(options);
            assert.equal(workspaceHeld, false);
            workspaceHeld = true;
            try { return await callback(lifecycle); } finally { workspaceHeld = false; }
        },
        async withNetworkLock(callback, options) {
            networkOptions.push(options);
            assert.equal(networkHeld, false);
            networkHeld = true;
            try { return await callback({ lock: 'network' }); } finally { networkHeld = false; }
        },
        networkWaitMs: 999999,
        networkPollMs: 999999,
        lifecycleLeaseTimeoutMs: 4321,
    });

    assert.equal(value, 'activated');
    assert.equal(lifecycleLeases, 2);
    assert.deepEqual(lifecycleOptions, [
        { operation: `no-wait-runtime:${candidate.containerName}`, timeoutMs: 4321 },
        { operation: `no-wait-activate:${candidate.containerName}`, timeoutMs: 4321 },
    ]);
    assert.deepEqual(networkOptions, [
        { waitMs: 300000, pollMs: 1000 },
        { waitMs: 300000, pollMs: 1000 },
    ]);
});

test('dependency-ordered no-wait readiness retains lifecycle locks through activation', async () => {
    const { lifecycle, candidate } = noWaitTransactionFixture();
    let workspaceHeld = false;
    let networkHeld = false;
    let lifecycleLeases = 0;
    let networkLeases = 0;

    const value = await runNoWaitLifecycleTransaction({ containerName: candidate.containerName }, {
        retainLifecycleLocksThroughReadiness: true,
        capture: () => ({}),
        ensure() {
            assert.equal(workspaceHeld && networkHeld, true);
            return candidate;
        },
        readiness() {
            assert.equal(workspaceHeld && networkHeld, true);
        },
        revalidate() { assert.fail('a retained dependency launch must not reacquire/rebase'); },
        inspectRuntime() {
            assert.equal(workspaceHeld && networkHeld, true);
        },
        activate(_current, _context, _result, { onCommitted }) {
            assert.equal(workspaceHeld && networkHeld, true);
            onCommitted();
            return 'dependency-activation';
        },
        async withLifecycleLease(_identity, callback) {
            lifecycleLeases += 1;
            workspaceHeld = true;
            try { return await callback(lifecycle); } finally { workspaceHeld = false; }
        },
        async withNetworkLock(callback) {
            networkLeases += 1;
            networkHeld = true;
            try { return await callback({ lock: 'network' }); } finally { networkHeld = false; }
        },
    });

    assert.equal(value, 'dependency-activation');
    assert.equal(lifecycleLeases, 1);
    assert.equal(networkLeases, 1);
});

test('stale no-wait lifecycle cleans only after locked immutable reinspection', async () => {
    const { lifecycle, candidate } = noWaitTransactionFixture();
    const changedLifecycle = {
        ...lifecycle,
        generationDigest: 'generation-two',
    };
    let workspaceHeld = false;
    let networkHeld = false;
    let leaseCall = 0;
    let cleanupCalls = 0;
    const inspections = [];

    await assert.rejects(
        () => runNoWaitLifecycleTransaction({ containerName: candidate.containerName }, {
            capture: () => ({}),
            ensure: () => candidate,
            readiness() {
                assert.equal(workspaceHeld, false);
                assert.equal(networkHeld, false);
            },
            revalidate() { throw new Error('stale lifecycle'); },
            inspectRuntime(_result, _context, inspectedLifecycle, _capability, options) {
                assert.equal(workspaceHeld, true);
                assert.equal(networkHeld, true);
                inspections.push({ inspectedLifecycle, options });
            },
            activate() { assert.fail('stale lifecycle must not publish'); },
            cleanupCandidate(received) {
                assert.equal(workspaceHeld, true);
                assert.equal(networkHeld, true);
                assert.equal(received, candidate);
                cleanupCalls += 1;
            },
            async withLifecycleLease(_identity, callback) {
                const current = leaseCall++ === 0 ? lifecycle : changedLifecycle;
                workspaceHeld = true;
                try { return await callback(current); } finally { workspaceHeld = false; }
            },
            async withNetworkLock(callback) {
                networkHeld = true;
                try { return await callback({ lock: 'network' }); } finally { networkHeld = false; }
            },
            loadCurrentLifecycle: () => changedLifecycle,
        }),
        /stale lifecycle/,
    );
    assert.equal(cleanupCalls, 1);
    assert.equal(inspections.length, 1);
    assert.equal(inspections[0].inspectedLifecycle, lifecycle);
    assert.deepEqual(inspections[0].options, { cleanup: true });
});

test('peer publication during readiness preserves the now-active exact candidate', async () => {
    const { lifecycle, candidate } = noWaitTransactionFixture();
    const publishedLifecycle = {
        ...lifecycle,
        targetState: 'ready',
        record: candidate.registryRecord,
        route: {
            container: candidate.containerName,
            hostPort: 43123,
        },
    };
    let leaseCall = 0;
    let networkCalls = 0;
    let cleanupCalls = 0;
    let cleanupInspections = 0;

    await assert.rejects(
        () => runNoWaitLifecycleTransaction({ containerName: candidate.containerName }, {
            capture: () => ({}),
            ensure: () => candidate,
            readiness: () => undefined,
            revalidate() { throw new Error('peer published candidate'); },
            inspectRuntime(_result, _context, _lifecycle, _capability, options) {
                if (options.cleanup) cleanupInspections += 1;
            },
            activate() { assert.fail('stale worker must not republish'); },
            cleanupCandidate() { cleanupCalls += 1; },
            async withLifecycleLease(_identity, callback) {
                const current = leaseCall++ === 0 ? lifecycle : publishedLifecycle;
                return callback(current);
            },
            async withNetworkLock(callback) {
                networkCalls += 1;
                return callback({ lock: 'network' });
            },
            loadCurrentLifecycle: () => publishedLifecycle,
        }),
        /peer published candidate/,
    );
    assert.equal(leaseCall, 2);
    assert.equal(networkCalls, 1);
    assert.equal(cleanupInspections, 0);
    assert.equal(cleanupCalls, 0);
});

test('preparation lease retains workspace and network locks through readiness and activation', async () => {
    const { lifecycle, candidate } = noWaitTransactionFixture();
    candidate.requiresEdgeActivation = true;
    candidate.preparationLease = { leaseId: 'preparation-one' };
    let workspaceHeld = false;
    let networkHeld = false;
    let lifecycleLeases = 0;
    let networkLeases = 0;

    const value = await runNoWaitLifecycleTransaction({ containerName: candidate.containerName }, {
        capture: () => ({}),
        ensure() {
            assert.equal(workspaceHeld && networkHeld, true);
            return candidate;
        },
        readiness() {
            assert.equal(workspaceHeld && networkHeld, true);
        },
        revalidate() { assert.fail('preparation must not reacquire/rebase'); },
        inspectRuntime() {
            assert.equal(workspaceHeld && networkHeld, true);
        },
        activate(_current, _context, _result, { onCommitted }) {
            assert.equal(workspaceHeld && networkHeld, true);
            onCommitted();
            return 'prepared-activation';
        },
        async withLifecycleLease(_identity, callback) {
            lifecycleLeases += 1;
            workspaceHeld = true;
            try { return await callback(lifecycle); } finally { workspaceHeld = false; }
        },
        async withNetworkLock(callback) {
            networkLeases += 1;
            networkHeld = true;
            try { return await callback({ lock: 'network' }); } finally { networkHeld = false; }
        },
    });

    assert.equal(value, 'prepared-activation');
    assert.equal(lifecycleLeases, 1);
    assert.equal(networkLeases, 1);
});

test('concurrent no-wait lifecycle apply callbacks remain workspace-serialized', async () => {
    const { lifecycle } = noWaitTransactionFixture();
    let leaseTail = Promise.resolve();
    let releaseReadiness;
    const readinessGate = new Promise((resolve) => { releaseReadiness = resolve; });
    let readinessArrivals = 0;
    let maxWorkspaceHolders = 0;
    let workspaceHolders = 0;
    let activeApplies = 0;
    let maxActiveApplies = 0;

    const withLifecycleLease = async (_identity, callback) => {
        const predecessor = leaseTail;
        let releaseLease;
        leaseTail = new Promise((resolve) => { releaseLease = resolve; });
        await predecessor;
        workspaceHolders += 1;
        maxWorkspaceHolders = Math.max(maxWorkspaceHolders, workspaceHolders);
        try { return await callback(lifecycle); } finally {
            workspaceHolders -= 1;
            releaseLease();
        }
    };
    const run = (suffix) => runNoWaitLifecycleTransaction({ containerName: `worker-${suffix}` }, {
        capture: () => ({}),
        ensure: () => ({ containerName: `worker-${suffix}`, createdByThisLaunch: false }),
        async readiness() {
            readinessArrivals += 1;
            await readinessGate;
        },
        revalidate: (_initial, current) => current,
        inspectRuntime: () => undefined,
        async activate(_current, _context, _result, { onCommitted }) {
            activeApplies += 1;
            maxActiveApplies = Math.max(maxActiveApplies, activeApplies);
            await new Promise((resolve) => setImmediate(resolve));
            activeApplies -= 1;
            onCommitted();
        },
        withLifecycleLease,
        withNetworkLock: (callback) => callback({ lock: 'network' }),
    });

    const first = run('first');
    const second = run('second');
    while (readinessArrivals < 2) await new Promise((resolve) => setImmediate(resolve));
    releaseReadiness();
    await Promise.all([first, second]);
    assert.equal(maxWorkspaceHolders, 1);
    assert.equal(maxActiveApplies, 1);
});

test('a pre-start failure still publishes a terminal member of the wave barrier', async (t) => {
    // Spawns the real detached worker so the pre-publish failure path is
    // exercised end to end, not simulated.
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-pre-start-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const runningDir = path.join(workspaceRoot, '.ploinky', 'running');
    fs.mkdirSync(path.join(workspaceRoot, '.ploinky'), { recursive: true });
    const containerName = 'pre-start-container';
    const runStartedAtMs = Date.now();
    // An unparseable manifest fails admission, which runs before the first
    // live status write.
    const manifestPath = path.join(workspaceRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, '{ not json');
    const statusFile = coordinationPath(runningDir, containerName);
    const workerScript = fileURLToPath(new URL('../../cli/commands/noWaitWorker.js', import.meta.url));
    const baseArgs = [
        workerScript,
        '--container', containerName,
        '--instance-id', INSTANCE_ID,
        '--enable-generation', ENABLE_GENERATION,
        '--short-agent', 'preStart',
        '--repo', 'demo',
        '--alias', '',
        '--manifest-path', manifestPath,
        '--agent-path', workspaceRoot,
        '--route-key', 'preStart',
        '--run-id', RUN_ID,
        '--run-started-at-ms', String(runStartedAtMs),
        '--wave-index', '1',
        '--status-file', statusFile,
        '--wait-for-statuses', '[]',
    ];
    const env = { ...process.env, PLOINKY_WORKSPACE_ROOT: workspaceRoot };

    const failed = spawnSync(process.execPath, baseArgs, { env, encoding: 'utf8' });
    assert.equal(failed.status, 1, failed.stderr);

    const published = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.equal(published.state, 'failed');
    assert.equal(published.sequencePhase, 'active');
    assert.equal(published.runId, RUN_ID);
    assert.equal(published.runStartedAtMs, runStartedAtMs);
    assert.equal(published.waveIndex, 1);
    assert.deepEqual(
        Object.fromEntries(Object.keys(workerIdentity(containerName, {
            shortAgent: 'preStart',
            runStartedAtMs,
            waveIndex: 1,
        })).map((field) => [field, published[field]])),
        workerIdentity(containerName, {
            shortAgent: 'preStart',
            runStartedAtMs,
            waveIndex: 1,
        }),
    );
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(runningDir, 'no-wait', `${containerName}.json`), 'utf8')),
        published,
        'the canonical monitor view must carry the same terminal document',
    );

    // A dependent must reach a terminal decision immediately instead of
    // waiting out its cumulative queued budget.
    assert.deepEqual(
        await waitForRunScopedStatus(
            barrierEntry(runningDir, containerName, { waveIndex: 1, directDependency: true }),
            { runningDir, expectedRunId: RUN_ID, runStartedAtMs },
        ),
        { state: 'failed' },
    );

    // A launch missing a mandatory run-scoped flag is still rejected outright.
    const missingFlag = baseArgs.filter((token, index) => (
        token !== '--wave-index' && baseArgs[index - 1] !== '--wave-index'
    ));
    const rejected = spawnSync(process.execPath, missingFlag, { env, encoding: 'utf8' });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /requires --wave-index/);
});

test('the runtime image is prefetched outside every lifecycle lock', () => {
    const calls = [];
    const base = {
        manifest: { container: 'demo/image:1' },
        profileConfig: null,
        runtime: 'podman',
        runtimeKind: 'container',
        agentName: 'demoAgent',
        repoName: 'demo',
        resolveImage: (manifest) => manifest.container,
        ensureImage: (image, options) => { calls.push([image, options]); return true; },
    };

    assert.deepEqual(
        prefetchNoWaitRuntimeImage(base),
        { prefetched: true, image: 'demo/image:1' },
    );
    assert.deepEqual(
        calls,
        [['demo/image:1', { runtime: 'podman', allowLocalBuild: false }]],
        'the prefetch must target the agent-resolved runtime and stay pull-only,'
        + ' leaving the local-build fallback to the serialized in-lease path',
    );

    // A sandbox runtime never resolves a container image.
    assert.deepEqual(
        prefetchNoWaitRuntimeImage({ ...base, runtimeKind: 'bwrap' }),
        { prefetched: false, reason: 'sandbox-runtime' },
    );
    // An LLM-runtime placeholder is resolved by the catalog inside the
    // transaction, so an unresolvable manifest image is not an error.
    assert.deepEqual(
        prefetchNoWaitRuntimeImage({
            ...base,
            resolveImage: () => { throw new Error('unresolved placeholder'); },
        }),
        { prefetched: false, reason: 'unresolved-image' },
    );
    assert.deepEqual(
        prefetchNoWaitRuntimeImage({ ...base, resolveImage: () => '  ' }),
        { prefetched: false, reason: 'unresolved-image' },
    );
    // A prefetch failure must never be fatal on its own; the transaction still
    // owns the authoritative resolution and the local-build fallback.
    const logged = [];
    assert.deepEqual(
        prefetchNoWaitRuntimeImage({
            ...base,
            ensureImage: () => { throw new Error('registry unreachable'); },
            log: (message) => logged.push(message),
        }),
        { prefetched: false, image: 'demo/image:1', reason: 'prefetch-failed' },
    );
    assert.match(logged[0], /image prefetch for 'demo\/image:1' failed/);
});

test('the no-wait worker prefetches the image before taking any lifecycle lock', () => {
    const source = fs.readFileSync(
        path.resolve('cli/commands/noWaitWorker.js'),
        'utf8',
    );
    // lastIndexOf targets the call site in main(); indexOf would match the
    // exported definition earlier in the file.
    const prefetchCall = source.lastIndexOf('prefetchNoWaitRuntimeImage({');
    assert.ok(prefetchCall > 0);
    assert.ok(
        prefetchCall < source.indexOf('await runNoWaitLifecycleTransaction(expectedIdentity'),
        'the image cache must be warmed before the workspace mutation lease is taken',
    );
    assert.ok(
        source.indexOf('await waitForNoWaitStatusBarrier(waitForStatuses') < prefetchCall,
        'the wave barrier still orders the launch; prefetch must not bypass it',
    );
});

test('an LLM runtime never prefetches the manifest image the catalog will replace', () => {
    const pulls = [];
    const base = {
        manifest: { container: 'demo/manifest-image:1' },
        profileConfig: null,
        runtime: 'podman',
        runtimeKind: 'container',
        agentName: 'llmAgent',
        repoName: 'demo',
        resolveImage: (manifest) => manifest.container,
        ensureImage: (image) => { pulls.push(image); return true; },
    };

    assert.deepEqual(
        prefetchNoWaitRuntimeImage({ ...base, isLlmRuntime: () => true }),
        { prefetched: false, reason: 'llm-runtime-catalog-image' },
    );
    assert.deepEqual(pulls, [], 'a catalog-selected runtime must not pull the manifest image');

    assert.deepEqual(
        prefetchNoWaitRuntimeImage({ ...base, isLlmRuntime: () => false }),
        { prefetched: true, image: 'demo/manifest-image:1' },
    );
    assert.deepEqual(pulls, ['demo/manifest-image:1']);
});

test('the worker re-asserts its admission immediately before prefetching an image', () => {
    const source = fs.readFileSync(
        path.resolve('cli/commands/noWaitWorker.js'),
        'utf8',
    );
    const prefetch = source.lastIndexOf('prefetchNoWaitRuntimeImage({');
    const barrier = source.indexOf('await waitForNoWaitStatusBarrier(waitForStatuses');
    assert.ok(prefetch > 0 && barrier > 0);
    // Search backwards from the prefetch so this binds to the revalidation
    // that guards it, not the later one inside capture().
    const revalidate = source.lastIndexOf('assertRuntimeAdmissionCurrent(runtimeAdmission, {', prefetch);
    assert.ok(
        revalidate > barrier,
        'the admission must be revalidated after the wave barrier releases the worker',
    );
    assert.ok(
        revalidate < prefetch,
        'a pull is a cache mutation, so the admission must be revalidated first',
    );
    assert.ok(
        prefetch < source.indexOf('await runNoWaitLifecycleTransaction(expectedIdentity'),
        'the prefetch must still precede the workspace mutation lease',
    );
});

test('barrier status identities must be real JSON numbers, not coercible values', () => {
    const runStartedAtMs = Date.now();
    const observe = (overrides) => resolveRunScopedObservation({
        runId: RUN_ID,
        runStartedAtMs,
        waveIndex: 0,
        state: 'running',
        sequencePhase: 'active',
        ...overrides,
    }, {
        expectedRunId: RUN_ID,
        runStartedAtMs,
        targetWaveIndex: 0,
        timeouts: FAST_TIMEOUTS,
        nowMs: runStartedAtMs,
    });

    assert.deepEqual(observe({}), { terminal: 'running' });
    // Number(null), Number('') and Number(false) are all 0, so a coercing check
    // would accept these against a wave-zero target.
    for (const coercible of [null, '', false, [], '0']) {
        assert.throws(
            () => observe({ waveIndex: coercible }),
            /different dependency wave/,
            `a waveIndex of ${JSON.stringify(coercible)} must be rejected`,
        );
    }
    for (const coercible of [null, '', false, []]) {
        assert.throws(
            () => observe({ runStartedAtMs: coercible }),
            /different run start/,
            `a runStartedAtMs of ${JSON.stringify(coercible)} must be rejected`,
        );
    }
    assert.throws(() => observe({ runStartedAtMs: String(runStartedAtMs) }), /different run start/);
});

test('a readiness failure preserves the probe output and a bounded runtime log tail', () => {
    const calls = [];
    const tail = captureNoWaitRuntimeLogTail('demo-container', {
        runtime: 'podman',
        lines: 12,
        spawnSyncImpl: (bin, args) => {
            calls.push([bin, args]);
            return { stdout: 'boot line 1\nboot line 2\n', stderr: 'fatal: nope\n' };
        },
    });
    assert.deepEqual(calls, [['podman', ['logs', '--tail', '12', 'demo-container']]]);
    assert.match(tail, /boot line 2/);
    assert.match(tail, /fatal: nope/);

    // Diagnostics must never replace the failure they describe.
    assert.equal(
        captureNoWaitRuntimeLogTail('demo-container', {
            runtime: 'podman',
            spawnSyncImpl: () => { throw new Error('runtime unavailable'); },
        }),
        '',
    );
    // A non-exact container name is never handed to the runtime.
    assert.equal(
        captureNoWaitRuntimeLogTail('../escape', {
            runtime: 'podman',
            spawnSyncImpl: () => { throw new Error('must not be called'); },
        }),
        '',
    );
    // The tail is bounded so a chatty container cannot bloat the status file.
    const huge = captureNoWaitRuntimeLogTail('demo-container', {
        runtime: 'podman',
        spawnSyncImpl: () => ({ stdout: 'x'.repeat(50_000), stderr: '' }),
    });
    assert.ok(huge.length < 5_000, 'the captured tail must stay bounded');
    assert.match(huge, /…$/);
});

test('no-wait script readiness retries only typed probe control-plane timeouts', async () => {
    const delays = [];
    let calls = 0;
    const result = await runNoWaitScriptReadinessWithControlPlaneRetry(
        'liveKitServerAgent',
        'livekit-container',
        { script: 'healthcheck.sh' },
        {
            maxRetries: 3,
            retryDelayMs: 25,
            maxRetryDelayMs: 100,
            sleepImpl: async (delayMs) => { delays.push(delayMs); },
            runReadiness() {
                calls += 1;
                if (calls < 3) {
                    const error = new Error('runtime control plane did not answer');
                    error.code = 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT';
                    throw error;
                }
                return { status: 'success' };
            },
        },
    );

    assert.deepEqual(result, { status: 'success' });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [25, 50]);

    let semanticCalls = 0;
    await assert.rejects(
        () => runNoWaitScriptReadinessWithControlPlaneRetry(
            'liveKitServerAgent',
            'livekit-container',
            { script: 'healthcheck.sh' },
            {
                maxRetries: 3,
                sleepImpl: async () => { throw new Error('must not sleep'); },
                runReadiness() {
                    semanticCalls += 1;
                    throw new Error('healthcheck.sh is missing');
                },
            },
        ),
        /healthcheck\.sh is missing/,
    );
    assert.equal(semanticCalls, 1);
});

test('no-wait script readiness bounds typed control-plane retries', async () => {
    let calls = 0;
    const timeout = new Error('runtime control plane did not answer');
    timeout.code = 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT';
    await assert.rejects(
        () => runNoWaitScriptReadinessWithControlPlaneRetry(
            'liveKitServerAgent',
            'livekit-container',
            { script: 'healthcheck.sh' },
            {
                maxRetries: 2,
                retryDelayMs: 0,
                maxRetryDelayMs: 0,
                sleepImpl: async () => {},
                runReadiness() { calls += 1; throw timeout; },
            },
        ),
        (error) => error === timeout,
    );
    assert.equal(calls, 3);
});

test('the worker publishes readiness detail into its terminal status', () => {
    const source = fs.readFileSync(
        path.resolve('cli/commands/noWaitWorker.js'),
        'utf8',
    );
    assert.match(
        source,
        /readinessDetail: failure\.readinessDetail/,
        'the probe output must reach the published failure',
    );
    assert.match(
        source,
        /runtimeLogTail: failure\.runtimeLogTail/,
        'the runtime log tail must reach the published failure',
    );
    // The tail has to be captured while the container still exists.
    assert.ok(
        source.indexOf('function readinessFailure') < source.indexOf('async function waitForNoWaitReadiness'),
        'readiness failures are enriched before exact cleanup removes the runtime',
    );
});

test('a sandbox readiness failure never resolves a container engine', () => {
    // getRuntime() calls process.exit(1) on a host without podman or docker.
    // Reaching it here would kill the worker before cleanup or a terminal
    // status could run, stalling every dependent until its own timeout.
    let resolved = 0;
    const exploding = () => { resolved += 1; throw new Error('process.exit(1) would happen here'); };
    for (const runtimeKind of ['bwrap', 'seatbelt', 'sandbox']) {
        assert.equal(
            captureNoWaitRuntimeLogTail('demo-container', {
                runtimeKind,
                getRuntime: exploding,
                spawnSyncImpl: () => { throw new Error('must not be called'); },
            }),
            '',
            `${runtimeKind} must not reach a container engine`,
        );
    }
    assert.equal(resolved, 0, 'no sandbox path may resolve a container runtime');

    // A container runtime still captures normally.
    assert.match(
        captureNoWaitRuntimeLogTail('demo-container', {
            runtimeKind: 'container',
            runtime: 'podman',
            spawnSyncImpl: () => ({ stdout: 'container line\n', stderr: '' }),
        }),
        /container line/,
    );
});

test('diagnostics are redacted before they reach a status file or a log', () => {
    const manifest = { env: ['AGENT_TOKEN'] };
    const env = {
        AGENT_TOKEN: 'super-secret-token-value',
        SHORT: 'ab',
    };
    const redacted = redactNoWaitDiagnostics(
        'connecting with super-secret-token-value then failing\nshort ab is also secret',
        {
            manifest,
            profileConfig: null,
            env,
            manifestEnvNames: () => ['AGENT_TOKEN', 'SHORT'],
            exposedNames: () => [],
        },
    );
    assert.ok(!redacted.includes('super-secret-token-value'), 'an injected secret must never survive');
    assert.match(redacted, /\[redacted:AGENT_TOKEN\]/);
    assert.ok(!redacted.includes('short ab is also secret'), 'short injected values must not survive');
    assert.match(redacted, /short \[redacted:SHORT\] is also secret/);

    // Secret shapes are masked regardless of which variable carried them.
    const shaped = redactNoWaitDiagnostics(
        'auth: Bearer abcdefghijklmnopqrstuvwxyz012345\ntoken eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmNkZWZnIn0.c2lnbmF0dXJlLXZhbHVl',
        { manifest: null, profileConfig: null, env: {}, manifestEnvNames: () => [], exposedNames: () => [] },
    );
    assert.match(shaped, /\[redacted:authorization\]/);
    assert.match(shaped, /\[redacted:jwt\]/);
    assert.ok(!shaped.includes('eyJhbGciOiJIUzI1NiJ9'), 'a JWT must never survive');

    // Redaction must not throw when a manifest cannot enumerate its names.
    assert.equal(
        redactNoWaitDiagnostics('plain text', {
            manifest: null,
            profileConfig: null,
            env: {},
            manifestEnvNames: () => { throw new Error('unreadable manifest'); },
            exposedNames: () => { throw new Error('unreadable manifest'); },
        }),
        'plain text',
    );
});

test('runtime diagnostic truncation never cuts a secret before redaction', () => {
    const secret = 'secret-prefix-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const raw = `${'p'.repeat(50)}${secret}${'z'.repeat(3980)}`;
    const tail = captureNoWaitRuntimeLogTail('demo-container', {
        runtime: 'podman',
        spawnSyncImpl: () => ({ stdout: raw, stderr: '' }),
        redact: (value) => redactNoWaitDiagnostics(value, {
            manifest: {},
            profileConfig: null,
            env: { DEMO_SECRET: secret },
            manifestEnvNames: () => ['DEMO_SECRET'],
            exposedNames: () => [],
        }),
    });
    assert.ok(!tail.includes(secret));
    assert.ok(!tail.includes(secret.slice(-20)), 'a suffix crossing the tail boundary must not leak');
    assert.match(tail, /DEMO_SECRET\]/, 'the retained boundary must contain only the redaction marker');
});

test('a dead no-wait worker gets only terminal-publication grace, not the image budget', async (t) => {
    const { runningDir } = fixture(t);
    const runStartedAtMs = 1_700_000_000_000;
    publishRunScoped(runningDir, 'dead-worker', {
        runStartedAtMs,
        waveIndex: 0,
        state: 'starting',
        pid: 424242,
    });
    const timeouts = resolveNoWaitBarrierTimeouts({
        activeTimeoutMs: 3_600_000,
        imagePullBudgetMs: 86_400_000,
        imageBuildBudgetMs: 86_400_000,
        terminalPublicationGraceMs: 100,
        startupGraceMs: 1000,
    });
    const clock = virtualClock(runStartedAtMs);
    await assert.rejects(
        () => waitForRunScopedStatus(
            barrierEntry(runningDir, 'dead-worker', { waveIndex: 0 }),
            {
                runningDir,
                expectedRunId: RUN_ID,
                runStartedAtMs,
                timeouts,
                isWorkerAlive: () => false,
                ...clock,
            },
        ),
        /exited before publishing a terminal status/,
    );
    assert.ok(
        clock.nowFn() < runStartedAtMs + 1000,
        'dead-worker detection must not consume any pull or build allowance',
    );
});

test('worker liveness treats EPERM as alive and only ESRCH as absent', () => {
    assert.equal(isNoWaitWorkerAlive(123, { killImpl: () => {} }), true);
    assert.equal(isNoWaitWorkerAlive(123, {
        killImpl: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; },
    }), true);
    assert.equal(isNoWaitWorkerAlive(123, {
        killImpl: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; },
    }), false);
    assert.equal(isNoWaitWorkerAlive(0), false);
    assert.equal(isNoWaitWorkerAlive(Number.MAX_SAFE_INTEGER + 1), false);
});

test('image-operation environment timeouts are exact and bounded', () => {
    const previousPull = process.env.PLOINKY_IMAGE_PULL_TIMEOUT_MS;
    const previousBuild = process.env.PLOINKY_IMAGE_BUILD_TIMEOUT_MS;
    try {
        process.env.PLOINKY_IMAGE_PULL_TIMEOUT_MS = String(MAX_IMAGE_OPERATION_TIMEOUT_MS + 1);
        process.env.PLOINKY_IMAGE_BUILD_TIMEOUT_MS = String(Number.MAX_SAFE_INTEGER);
        assert.equal(imagePullTimeoutMs(), MAX_IMAGE_OPERATION_TIMEOUT_MS);
        assert.equal(imageBuildTimeoutMs(), MAX_IMAGE_OPERATION_TIMEOUT_MS);

        process.env.PLOINKY_IMAGE_PULL_TIMEOUT_MS = '1234.5';
        process.env.PLOINKY_IMAGE_BUILD_TIMEOUT_MS = 'Infinity';
        assert.equal(imagePullTimeoutMs(), 30 * 60 * 1000);
        assert.equal(imageBuildTimeoutMs(), 30 * 60 * 1000);
    } finally {
        if (previousPull === undefined) delete process.env.PLOINKY_IMAGE_PULL_TIMEOUT_MS;
        else process.env.PLOINKY_IMAGE_PULL_TIMEOUT_MS = previousPull;
        if (previousBuild === undefined) delete process.env.PLOINKY_IMAGE_BUILD_TIMEOUT_MS;
        else process.env.PLOINKY_IMAGE_BUILD_TIMEOUT_MS = previousBuild;
    }
});
