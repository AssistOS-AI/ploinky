import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isContainerRunning,
    listRunningContainerNames,
    waitForContainerRunning,
} from '../../cli/sandbox/docker/common.js';
import {
    monitorTick,
    snapshotRunningContainerNames,
} from '../../cli/server/containerMonitor.js';

test('running-container inventory uses one argv-safe runtime list and normalizes names', () => {
    const calls = [];
    const names = listRunningContainerNames({
        runtime: 'podman',
        spawnSyncImpl(runtime, args, options) {
            calls.push({ runtime, args, options });
            return {
                status: 0,
                stdout: 'ploinky_alpha\n/ploinky_beta\n\n',
                stderr: '',
            };
        },
    });

    assert.deepEqual([...names], ['ploinky_alpha', 'ploinky_beta']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['ps', '--format', '{{.Names}}']);
    assert.equal(calls[0].options.encoding, 'utf8');
    assert.equal(calls[0].options.timeout, 5_000);
    assert.equal(calls[0].options.killSignal, 'SIGKILL');
});

test('running-container inventory fails closed on runtime errors', () => {
    assert.throws(
        () => listRunningContainerNames({
            runtime: 'podman',
            spawnSyncImpl() {
                return { status: 125, stdout: '', stderr: 'runtime unavailable' };
            },
        }),
        (error) => {
            assert.equal(error.code, 'PLOINKY_CONTAINER_CONTROL_PLANE_FAILED');
            assert.match(error.message, /cannot list running containers: runtime unavailable/);
            return true;
        },
    );
});

test('single-container inspection preserves typed control-plane timeouts', () => {
    const timeout = new Error('runtime timed out');
    timeout.code = 'ETIMEDOUT';
    assert.throws(() => isContainerRunning('exact-container', {
        runtime: 'podman',
        throwOnControlPlaneError: true,
        spawnSyncImpl() {
            return { status: null, error: timeout, stdout: '', stderr: '' };
        },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /runtime timed out/);
        return true;
    });
});

test('single-container status checks use one exact argv-safe inspect and are bounded', () => {
    const calls = [];
    const running = isContainerRunning('exact-container', {
        runtime: 'podman',
        timeoutMs: 321,
        spawnSyncImpl(runtime, args, options) {
            calls.push({ runtime, args, options });
            return {
                status: 0,
                stdout: 'running\n',
                stderr: '',
            };
        },
    });

    assert.equal(running, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
        'container',
        'inspect',
        '--format',
        '{{.State.Status}}',
        'exact-container',
    ]);
    assert.equal(calls[0].options.timeout, 321);
    assert.equal(calls[0].options.killSignal, 'SIGKILL');
});

test('single-container status checks distinguish stopped and absent runtimes', () => {
    assert.equal(isContainerRunning('stopped-container', {
        runtime: 'podman',
        spawnSyncImpl() {
            return { status: 0, stdout: 'exited\n', stderr: '' };
        },
    }), false);
    assert.equal(isContainerRunning('missing-container', {
        runtime: 'podman',
        throwOnControlPlaneError: true,
        spawnSyncImpl() {
            return {
                status: 125,
                stdout: '',
                stderr: 'Error: no such container missing-container',
            };
        },
    }), false);
});

test('single-container status checks fail closed on malformed runtime output', () => {
    assert.throws(() => isContainerRunning('malformed-container', {
        runtime: 'podman',
        throwOnControlPlaneError: true,
        spawnSyncImpl() {
            return { status: 0, stdout: '[{"State":{"Status":"running"}}]\n', stderr: '' };
        },
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_CONTAINER_CONTROL_PLANE_FAILED');
        assert.match(error.message, /invalid status/);
        return true;
    });
});

test('container startup inspection has per-call and aggregate deadlines', () => {
    const calls = [];
    const sleeps = [];
    const running = waitForContainerRunning('slow-container', 2, 1, {
        runtime: 'podman',
        timeoutMs: 17,
        totalTimeoutMs: 50,
        spawnSyncImpl(runtime, args, options) {
            calls.push({ runtime, args, options });
            const error = new Error('inspect timed out');
            error.code = 'ETIMEDOUT';
            return { status: null, error, stdout: '', stderr: '' };
        },
        sleepMsImpl(delayMs) {
            sleeps.push(delayMs);
        },
    });

    assert.equal(running, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [
        'inspect',
        'slow-container',
        '--format',
        '{{ .State.Status }}',
    ]);
    assert.ok(calls.every(({ options }) => options.timeout > 0 && options.timeout <= 17));
    assert.ok(calls.every(({ options }) => options.killSignal === 'SIGKILL'));
    assert.deepEqual(sleeps, [1]);
});

test('container startup inspection can surface an all-timeout control-plane failure', () => {
    const timeout = new Error('inspect timed out');
    timeout.code = 'ETIMEDOUT';
    assert.throws(
        () => waitForContainerRunning('slow-container', 2, 1, {
            runtime: 'podman',
            timeoutMs: 17,
            totalTimeoutMs: 50,
            throwOnControlPlaneTimeout: true,
            spawnSyncImpl: () => ({
                status: null,
                error: timeout,
                stdout: '',
                stderr: '',
            }),
            sleepMsImpl() {},
        }),
        (error) => error === timeout,
    );
});

test('sixteen container targets share one status snapshot in an actual monitor tick', () => {
    let calls = 0;
    const logs = [];
    const probeStarts = [];
    const monitor = {
        targets: new Map(Array.from({ length: 16 }, (_, index) => [
            `container-${index}`,
            {
                runtime: 'container',
                containerName: `container-${index}`,
                agentName: `agent-${index}`,
                repoName: 'demo-repo',
                probeState: 'pending',
            },
        ])),
        config: {},
        isShuttingDown: () => false,
        inspectWorkspaceStartLock: () => ({ active: false, stale: false }),
        syncManagedContainers() {},
        listRunningContainerNames() {
            calls += 1;
            return Array.from({ length: 16 }, (_, index) => `container-${index}`);
        },
        startProbeWorker(_monitor, target) {
            probeStarts.push(target.containerName);
        },
        log(level, event, data) {
            logs.push({ level, event, data });
        },
    };

    monitorTick(monitor);

    assert.equal(calls, 1);
    assert.equal(probeStarts.length, 16);
    assert.deepEqual(logs, []);
});

test('snapshot failure defers every OCI target without per-target amplification or false restart', () => {
    const logs = [];
    let calls = 0;
    let now = 1_000;
    let snapshotAvailable = false;
    const probeStarts = [];
    const monitor = {
        targets: new Map(Array.from({ length: 16 }, (_, index) => [
            `container-${index}`,
            {
                runtime: 'container',
                containerName: `container-${index}`,
                agentName: `agent-${index}`,
                repoName: 'demo-repo',
                probeState: 'pending',
                isRestarting: false,
                pendingRestartTimer: null,
            },
        ])),
        config: {
            CONTAINER_SNAPSHOT_RETRY_INITIAL_MS: 15_000,
            CONTAINER_SNAPSHOT_RETRY_MAX_MS: 60_000,
        },
        now: () => now,
        isShuttingDown: () => false,
        inspectWorkspaceStartLock: () => ({ active: false, stale: false }),
        syncManagedContainers() {},
        listRunningContainerNames() {
            calls += 1;
            if (!snapshotAvailable) throw new Error('snapshot unavailable');
            return [...monitor.targets.keys()];
        },
        startProbeWorker(_monitor, target) {
            probeStarts.push(target.containerName);
        },
        log(level, event, data) {
            logs.push({ level, event, data });
        },
    };

    monitorTick(monitor);
    monitorTick(monitor);
    now += 14_999;
    monitorTick(monitor);

    assert.equal(calls, 1, 'snapshot backoff must suppress repeated control-plane calls');
    assert.ok([...monitor.targets.values()].every((target) => (
        target.pendingRestartTimer === null
        && target.isRestarting === false
        && target.probeState === 'pending'
    )));
    assert.deepEqual(logs, [{
        level: 'error',
        event: 'container_status_snapshot_failed',
        data: {
            error: 'snapshot unavailable',
            consecutiveFailures: 1,
            retryAfterMs: 15_000,
        },
    }]);

    snapshotAvailable = true;
    now += 1;
    monitorTick(monitor);

    assert.equal(calls, 2, 'snapshot is retried when the bounded backoff expires');
    assert.equal(probeStarts.length, 16);
    assert.equal(monitor.runtimeSnapshotFailures, 0);
    assert.equal(monitor.runtimeSnapshotRetryNotBefore, 0);
    assert.deepEqual(logs.at(-1), {
        level: 'info',
        event: 'container_status_snapshot_recovered',
        data: { previousFailures: 1 },
    });
});

test('Box inventory caching preserves five-second probe scheduling without repeated runtime lists', () => {
    let calls = 0;
    let now = 1_000;
    const probeStarts = [];
    const target = {
        runtime: 'container',
        containerName: 'cached-container',
        agentName: 'cached-agent',
        repoName: 'demo-repo',
        probeState: 'pending',
        isRestarting: false,
        pendingRestartTimer: null,
    };
    const monitor = {
        targets: new Map([[target.containerName, target]]),
        config: { CONTAINER_SNAPSHOT_INTERVAL_MS: 5 * 60 * 1000 },
        now: () => now,
        isShuttingDown: () => false,
        inspectWorkspaceStartLock: () => ({ active: false, stale: false }),
        syncManagedContainers() {},
        listRunningContainerNames() {
            calls += 1;
            return [target.containerName];
        },
        startProbeWorker(_monitor, current) {
            probeStarts.push(current.containerName);
            current.probeState = 'success';
            current.probeLastSuccessAt = now;
        },
        log() {},
    };

    monitorTick(monitor);
    assert.equal(monitor.runtimeSnapshotFreshForTick, true);
    target.probeState = 'pending';
    now += 5_000;
    monitorTick(monitor);

    assert.equal(calls, 1, 'the second monitor tick must reuse the Box inventory');
    assert.equal(monitor.runtimeSnapshotFreshForTick, false);
    assert.deepEqual(probeStarts, [target.containerName, target.containerName]);

    now += (5 * 60 * 1000) - 5_000;
    monitorTick(monitor);
    assert.equal(calls, 2, 'the inventory refreshes at the bounded cache deadline');
    assert.equal(monitor.runtimeSnapshotFreshForTick, true);
});

test('cached inventory absence is unknown until a fresh runtime list confirms it', () => {
    let calls = 0;
    let now = 1_000;
    let noWaitState = 'starting';
    const logs = [];
    const runningTarget = {
        runtime: 'container',
        containerName: 'already-running-container',
        agentName: 'already-running-agent',
        repoName: 'demo-repo',
        probeState: 'pending',
        isRestarting: false,
        pendingRestartTimer: null,
    };
    const lateTarget = {
        runtime: 'container',
        containerName: 'late-container',
        agentName: 'late-agent',
        repoName: 'demo-repo',
        probeState: 'pending',
        isRestarting: false,
        pendingRestartTimer: null,
        restartHistory: [],
        currentBackoff: 1_000,
        circuitBreakerTripped: false,
    };
    const monitor = {
        targets: new Map([
            [runningTarget.containerName, runningTarget],
            [lateTarget.containerName, lateTarget],
        ]),
        config: {
            CONTAINER_SNAPSHOT_INTERVAL_MS: 5 * 60 * 1000,
            MAX_RESTARTS_IN_WINDOW: 0,
        },
        now: () => now,
        isShuttingDown: () => false,
        inspectWorkspaceStartLock: () => ({ active: false, stale: false }),
        syncManagedContainers() {},
        listRunningContainerNames() {
            calls += 1;
            return [runningTarget.containerName];
        },
        readNoWaitStatus() {
            return { state: noWaitState };
        },
        startProbeWorker() {},
        log(level, event, data) {
            logs.push({ level, event, data });
        },
    };

    monitorTick(monitor);
    assert.equal(calls, 1);
    assert.equal(monitor.runtimeSnapshotFreshForTick, true);
    assert.equal(lateTarget.circuitBreakerTripped, false);

    noWaitState = 'running';
    now += 5_000;
    monitorTick(monitor);

    assert.equal(calls, 1, 'the second tick must reuse the cached inventory');
    assert.equal(monitor.runtimeSnapshotFreshForTick, false);
    assert.equal(lateTarget.circuitBreakerTripped, false);
    assert.equal(lateTarget.pendingRestartTimer, null);
    assert.equal(
        logs.some(({ event }) => event === 'container_scheduling_restart'),
        false,
        'cached absence must not schedule a restart after no-wait becomes running',
    );

    now += (5 * 60 * 1000) - 5_000;
    monitorTick(monitor);

    assert.equal(calls, 2, 'the cache deadline must collect a fresh inventory');
    assert.equal(monitor.runtimeSnapshotFreshForTick, true);
    assert.equal(
        lateTarget.circuitBreakerTripped,
        true,
        'a fresh confirmed absence may authorize the restart path',
    );
});
