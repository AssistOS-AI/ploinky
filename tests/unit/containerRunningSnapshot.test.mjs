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
        /cannot list running containers: runtime unavailable/,
    );
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
        config: {},
        isShuttingDown: () => false,
        inspectWorkspaceStartLock: () => ({ active: false, stale: false }),
        syncManagedContainers() {},
        listRunningContainerNames() {
            calls += 1;
            throw new Error('snapshot unavailable');
        },
        startProbeWorker() {
            assert.fail('unknown runtime state must not be treated as ready');
        },
        log(level, event, data) {
            logs.push({ level, event, data });
        },
    };

    monitorTick(monitor);

    assert.equal(calls, 1, 'one failed shared call is the entire tick control-plane cost');
    assert.ok([...monitor.targets.values()].every((target) => (
        target.pendingRestartTimer === null
        && target.isRestarting === false
        && target.probeState === 'pending'
    )));
    assert.deepEqual(logs, [{
        level: 'error',
        event: 'container_status_snapshot_failed',
        data: { error: 'snapshot unavailable' },
    }]);
});
