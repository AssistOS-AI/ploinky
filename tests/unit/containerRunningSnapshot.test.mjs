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

test('running-container inventory preserves typed control-plane timeouts', () => {
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

test('single-container status checks are argv-safe and bounded', () => {
    const calls = [];
    const running = isContainerRunning('exact-container', {
        runtime: 'podman',
        timeoutMs: 321,
        spawnSyncImpl(runtime, args, options) {
            calls.push({ runtime, args, options });
            return {
                status: 0,
                stdout: 'other-container\nexact-container\n',
                stderr: '',
            };
        },
    });

    assert.equal(running, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['ps', '--format', '{{.Names}}']);
    assert.equal(calls[0].options.timeout, 321);
    assert.equal(calls[0].options.killSignal, 'SIGKILL');
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

test('container startup inspection can preserve an all-timeout control-plane failure', () => {
    const timeout = new Error('inspect timed out');
    timeout.code = 'ETIMEDOUT';
    assert.throws(() => waitForContainerRunning('slow-container', 2, 1, {
        runtime: 'podman',
        timeoutMs: 17,
        totalTimeoutMs: 50,
        throwOnControlPlaneError: true,
        spawnSyncImpl() {
            return { status: null, error: timeout, stdout: '', stderr: '' };
        },
        sleepMsImpl() {},
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /inspect timed out/);
        return true;
    });
});

test('container startup inspection preserves final control-plane uncertainty after a valid response', () => {
    const timeout = new Error('inspect timed out after initial response');
    timeout.code = 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT';
    let attempt = 0;
    assert.throws(() => waitForContainerRunning('slow-container', 2, 1, {
        runtime: 'podman',
        timeoutMs: 17,
        totalTimeoutMs: 50,
        throwOnControlPlaneError: true,
        spawnSyncImpl() {
            attempt += 1;
            return attempt === 1
                ? { status: 0, stdout: 'created\n', stderr: '' }
                : { status: null, error: timeout, stdout: '', stderr: '' };
        },
        sleepMsImpl() {},
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT');
        assert.match(error.message, /inspect timed out after initial response/);
        return true;
    });
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
