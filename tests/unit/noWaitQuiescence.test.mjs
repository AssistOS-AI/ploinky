import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assertNoLiveNoWaitWorkers,
    enumerateLiveNoWaitWorkers,
    quiesceNoWaitWorkers,
    waitForNoWaitWorkersToSettle,
} from '../../cli/commands/noWaitQuiescence.js';
import { noWaitRunScopedStatusName } from '../../cli/commands/noWaitPaths.js';

const CONTAINER = 'agent-explorer';
const RUN_CURRENT = '123e4567-e89b-42d3-a456-426614174000';
const RUN_SUPERSEDED = '123e4567-e89b-42d3-a456-426614174001';
const NOW = 1_700_000_001_000;

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-no-wait-quiescence-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runningDir = path.join(root, 'running');
    const noWaitDir = path.join(runningDir, 'no-wait');
    fs.mkdirSync(noWaitDir, { recursive: true });
    return { runningDir, noWaitDir };
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function writeRun(state, { runId, pid, current = false }) {
    const statusFile = noWaitRunScopedStatusName(CONTAINER, runId);
    const status = {
        state: 'starting',
        sequencePhase: 'active',
        containerName: CONTAINER,
        runId,
        runStartedAtMs: NOW - 1_000,
        waveIndex: 0,
        sequencePhaseStartedAtMs: NOW - 500,
        pid,
    };
    writeJson(path.join(state.noWaitDir, statusFile), status);
    if (current) {
        writeJson(path.join(state.noWaitDir, `${CONTAINER}.current.json`), {
            statusFile,
            runId,
            runStartedAtMs: status.runStartedAtMs,
            waveIndex: status.waveIndex,
        });
    }
    return { status, statusPath: path.join(state.noWaitDir, statusFile) };
}

function registry() {
    return {
        [CONTAINER]: {
            type: 'agent',
            instanceId: 'instance-exact',
            enableGeneration: 'generation-exact',
        },
    };
}

test('quiescence proves and terminates current and superseded live run records', async (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 31001, current: true });
    writeRun(state, { runId: RUN_SUPERSEDED, pid: 31002 });
    const live = new Set([31001, 31002]);
    const proved = [];
    const signalled = [];

    const workers = await quiesceNoWaitWorkers({
        runningDir: state.runningDir,
        now: () => NOW,
        readRegistry: registry,
        isAlive: (pid) => live.has(pid),
        proveWorker: ({ pid, identity }) => proved.push([pid, identity.runId]),
        signal(pid, selectedSignal) {
            signalled.push([pid, selectedSignal]);
            live.delete(Math.abs(pid));
        },
    });

    assert.deepEqual(workers.map(({ pid, current }) => [pid, current]), [
        [31001, true],
        [31002, false],
    ]);
    assert.deepEqual(signalled, [[-31001, 'SIGTERM'], [-31002, 'SIGTERM']]);
    assert.deepEqual(new Set(proved.map(([pid]) => pid)), new Set([31001, 31002]));
    assert.equal(assertNoLiveNoWaitWorkers({
        runningDir: state.runningDir,
        nowMs: NOW,
        readRegistry: registry,
        isAlive: (pid) => live.has(pid),
        proveWorker() { throw new Error('dead workers must not require proof'); },
    }), true);
});

test('quiescence fails closed before signalling an unproven worker', async (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 32001, current: true });
    let signalled = false;

    await assert.rejects(() => quiesceNoWaitWorkers({
        runningDir: state.runningDir,
        now: () => NOW,
        readRegistry: registry,
        isAlive: () => true,
        proveWorker() { throw new Error('argv mismatch'); },
        signal() { signalled = true; },
    }), (error) => error.code === 'NO_WAIT_QUIESCENCE_FAILED'
        && /cannot be proven/.test(error.message));
    assert.equal(signalled, false);
});

test('enumeration accepts a natural exit racing the initial worker proof', (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 32501, current: true });
    let leaderAlive = true;
    let proofCount = 0;
    let groupProbeCount = 0;

    const workers = enumerateLiveNoWaitWorkers({
        runningDir: state.runningDir,
        nowMs: NOW,
        readRegistry: registry,
        isAlive: () => leaderAlive,
        isGroupAlive: () => {
            groupProbeCount += 1;
            return false;
        },
        proveWorker() {
            proofCount += 1;
            leaderAlive = false;
            throw new Error('worker exited while reading process identity');
        },
    });

    assert.deepEqual(workers, []);
    assert.equal(proofCount, 1);
    assert.equal(groupProbeCount, 1);
});

test('enumeration rejects an orphan group when the leader exits during proof', (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 32502, current: true });
    let leaderAlive = true;

    assert.throws(() => enumerateLiveNoWaitWorkers({
        runningDir: state.runningDir,
        nowMs: NOW,
        readRegistry: registry,
        isAlive: () => leaderAlive,
        isGroupAlive: () => true,
        proveWorker() {
            leaderAlive = false;
            throw new Error('worker leader exited but a child survived');
        },
    }), (error) => error.code === 'NO_WAIT_QUIESCENCE_FAILED'
        && /process group remains after its leader exited/.test(error.message));
});

test('quiescence is bounded when a proven worker ignores SIGTERM', async (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 33001, current: true });
    let clock = NOW;
    let signalCount = 0;

    await assert.rejects(() => quiesceNoWaitWorkers({
        runningDir: state.runningDir,
        now: () => clock,
        readRegistry: registry,
        isAlive: () => true,
        proveWorker() {},
        signal() { signalCount += 1; },
        timeoutMs: 3,
        pollMs: 1,
        delay: async (milliseconds) => { clock += milliseconds; },
    }), /process groups did not exit within 3ms/);
    assert.equal(signalCount, 1);
});

test('quiescence waits for detached worker children after the leader exits', async (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 33501, current: true });
    let leaderAlive = true;
    let groupAlive = true;
    let delayCount = 0;
    const signalled = [];

    await quiesceNoWaitWorkers({
        runningDir: state.runningDir,
        now: () => NOW + delayCount,
        readRegistry: registry,
        isAlive: () => leaderAlive,
        isGroupAlive: () => groupAlive,
        proveWorker() {},
        signal(target, selectedSignal) {
            signalled.push([target, selectedSignal]);
            leaderAlive = false;
        },
        pollMs: 1,
        delay: async () => {
            delayCount += 1;
            if (delayCount === 2) groupAlive = false;
        },
    });

    assert.deepEqual(signalled, [[-33501, 'SIGTERM']]);
    assert.equal(delayCount, 2);
});

test('quiescence tolerates an already-exited process-group race', async (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 33502, current: true });
    let alive = true;

    const workers = await quiesceNoWaitWorkers({
        runningDir: state.runningDir,
        now: () => NOW,
        readRegistry: registry,
        isAlive: () => alive,
        isGroupAlive: () => alive,
        proveWorker() {},
        signal() {
            alive = false;
            const error = new Error('process group already exited');
            error.code = 'ESRCH';
            throw error;
        },
    });

    assert.equal(workers.length, 1);
});

test('an orphaned live process group blocks the transition before mutation', async (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 33503, current: true });
    let signalCount = 0;

    await assert.rejects(() => quiesceNoWaitWorkers({
        runningDir: state.runningDir,
        now: () => NOW,
        readRegistry: registry,
        isAlive: () => false,
        isGroupAlive: () => true,
        proveWorker() { throw new Error('a dead leader cannot be proven'); },
        signal() { signalCount += 1; },
    }), /process group remains after its leader exited/);
    assert.equal(signalCount, 0);
});

test('a current marker without an exact run-scoped status blocks quiescence', (t) => {
    const state = fixture(t);
    writeJson(path.join(state.noWaitDir, `${CONTAINER}.current.json`), {
        statusFile: noWaitRunScopedStatusName(CONTAINER, RUN_CURRENT),
        runId: RUN_CURRENT,
        runStartedAtMs: NOW - 1_000,
        waveIndex: 0,
    });

    assert.throws(() => enumerateLiveNoWaitWorkers({
        runningDir: state.runningDir,
        nowMs: NOW,
        readRegistry: registry,
    }), /has no matching run status/);
});

test('a fresh workspace with no no-wait state quiesces as a no-op', async (t) => {
    const state = fixture(t);
    fs.rmSync(state.noWaitDir, { recursive: true });
    const workers = await quiesceNoWaitWorkers({
        runningDir: state.runningDir,
        readRegistry() { throw new Error('absent state must not require a registry'); },
    });
    assert.deepEqual(workers, []);
});

test('source-transition settling repeatedly proves a worker and waits beyond terminal publication', async (t) => {
    const state = fixture(t);
    const run = writeRun(state, { runId: RUN_CURRENT, pid: 34001, current: true });
    let live = true;
    let clock = NOW;
    let delayCount = 0;
    let signalCount = 0;
    const proved = [];

    const settled = await waitForNoWaitWorkersToSettle({
        runningDir: state.runningDir,
        now: () => clock,
        readRegistry: registry,
        isAlive: () => live,
        isGroupAlive: () => live,
        proveWorker: ({ pid, identity }) => proved.push([pid, identity.runId]),
        signal() { signalCount += 1; },
        timeoutMs: 10,
        pollMs: 1,
        delay: async (milliseconds) => {
            clock += milliseconds;
            delayCount += 1;
            if (delayCount === 1) {
                writeJson(run.statusPath, {
                    ...run.status,
                    state: 'running',
                    finishedAtMs: clock,
                });
            }
            if (delayCount === 2) live = false;
        },
    });

    assert.equal(settled, true);
    assert.equal(delayCount, 3, 'terminal publication must not count as process exit');
    assert.equal(signalCount, 0);
    assert.deepEqual(proved, [
        [34001, RUN_CURRENT],
        [34001, RUN_CURRENT],
    ]);
});

test('source-transition settling requires two empty observations', async (t) => {
    const state = fixture(t);
    fs.rmSync(state.noWaitDir, { recursive: true });
    let clock = NOW;
    let delayCount = 0;

    assert.equal(await waitForNoWaitWorkersToSettle({
        runningDir: state.runningDir,
        now: () => clock,
        readRegistry() { throw new Error('absent state must not require a registry'); },
        timeoutMs: 2,
        pollMs: 1,
        delay: async (milliseconds) => {
            clock += milliseconds;
            delayCount += 1;
        },
    }), true);
    assert.equal(delayCount, 1);
});

test('settling begun after terminal publication trusts the mutation-complete receipt', async (t) => {
    const state = fixture(t);
    const run = writeRun(state, { runId: RUN_CURRENT, pid: 34501, current: true });
    writeJson(run.statusPath, {
        ...run.status,
        state: 'running',
        finishedAtMs: NOW - 1,
    });
    let clock = NOW;
    let delayCount = 0;
    let livenessProbeCount = 0;
    let proofCount = 0;

    assert.equal(await waitForNoWaitWorkersToSettle({
        runningDir: state.runningDir,
        now: () => clock,
        readRegistry: registry,
        isAlive: () => {
            livenessProbeCount += 1;
            return true;
        },
        isGroupAlive: () => true,
        proveWorker: () => { proofCount += 1; },
        timeoutMs: 2,
        pollMs: 1,
        delay: async (milliseconds) => {
            clock += milliseconds;
            delayCount += 1;
        },
    }), true);
    assert.equal(delayCount, 1);
    assert.equal(livenessProbeCount, 0);
    assert.equal(proofCount, 0);
});

test('source-transition settling fails closed on an unproven live worker without signalling', async (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 35001, current: true });
    let delayCount = 0;
    let signalCount = 0;

    await assert.rejects(() => waitForNoWaitWorkersToSettle({
        runningDir: state.runningDir,
        now: () => NOW,
        readRegistry: registry,
        isAlive: () => true,
        isGroupAlive: () => true,
        proveWorker() { throw new Error('argv mismatch'); },
        signal() { signalCount += 1; },
        timeoutMs: 3,
        pollMs: 1,
        delay: async () => { delayCount += 1; },
    }), (error) => error.code === 'NO_WAIT_QUIESCENCE_FAILED'
        && /cannot be proven/.test(error.message));
    assert.equal(delayCount, 0);
    assert.equal(signalCount, 0);
});

test('source-transition settling times out with the remaining exact worker names', async (t) => {
    const state = fixture(t);
    writeRun(state, { runId: RUN_CURRENT, pid: 36001, current: true });
    let clock = NOW;
    let signalCount = 0;

    await assert.rejects(() => waitForNoWaitWorkersToSettle({
        runningDir: state.runningDir,
        now: () => clock,
        readRegistry: registry,
        isAlive: () => true,
        isGroupAlive: () => true,
        proveWorker() {},
        signal() { signalCount += 1; },
        timeoutMs: 3,
        pollMs: 1,
        delay: async (milliseconds) => { clock += milliseconds; },
    }), (error) => error.code === 'NO_WAIT_QUIESCENCE_FAILED'
        && error.message === 'No-wait workers did not settle naturally within 3ms: agent-explorer');
    assert.equal(signalCount, 0);
});
