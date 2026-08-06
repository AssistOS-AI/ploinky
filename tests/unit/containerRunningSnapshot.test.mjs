import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isContainerRunning,
    waitForContainerRunning,
} from '../../cli/sandbox/docker/common.js';
import {
    monitorTick,
    snapshotRunningContainerNames,
} from '../../cli/server/containerMonitor.js';

test('single-container status checks are argv-safe and bounded', () => {
    const calls = [];
    const running = isContainerRunning('exact-container', {
        runtime: 'podman',
        timeoutMs: 321,
        spawnSyncImpl(runtime, args, options) {
            calls.push({ runtime, args, options });
            return {
                status: 0,
                stdout: JSON.stringify([{
                    Id: 'a'.repeat(64),
                    Name: '/exact-container',
                    State: { Running: true, Status: 'running' },
                }]),
                stderr: '',
            };
        },
    });

    assert.equal(running, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['container', 'inspect', 'exact-container']);
    assert.equal(calls[0].options.timeout, 321);
    assert.equal(calls[0].options.killSignal, 'SIGKILL');
});

test('single-container status never enumerates or synchronizes an unrelated shared-engine container', () => {
    const calls = [];
    assert.equal(isContainerRunning('owned-container', {
        runtime: 'podman',
        spawnSyncImpl(runtime, args) {
            calls.push([runtime, ...args]);
            assert.deepEqual(args, ['container', 'inspect', 'owned-container']);
            return {
                status: 0,
                stdout: JSON.stringify([{
                    Id: 'b'.repeat(64),
                    Name: '/owned-container',
                    State: { Running: true, Status: 'running' },
                }]),
                stderr: '',
            };
        },
    }), true);
    assert.deepEqual(calls, [['podman', 'container', 'inspect', 'owned-container']]);
    assert.equal(calls.flat().includes('observe-only-unrelated'), false);
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

function exactTarget(index) {
    return {
        runtime: 'podman',
        containerName: `container-${index}`,
        containerId: index.toString(16).padStart(64, '0'),
        instanceId: `instance-${index}`,
        enableGeneration: `generation-${index}`,
        releaseGeneration: index.toString(16).padStart(64, 'f'),
        agentName: `agent-${index}`,
        repoName: 'demo-repo',
        probeState: 'pending',
        isRestarting: false,
        pendingRestartTimer: null,
    };
}

function exactLiveEntry(target) {
    return {
        containerName: target.containerName,
        runtime: 'podman',
        containerId: target.containerId,
        instanceId: target.instanceId,
        enableGeneration: target.enableGeneration,
        releaseGeneration: target.releaseGeneration,
        ownershipVerified: true,
        state: { running: true },
    };
}

test('sixteen exact Podman targets share one ownership-verified status snapshot in an actual monitor tick', () => {
    let calls = 0;
    const logs = [];
    const probeStarts = [];
    const monitor = {
        targets: new Map(Array.from({ length: 16 }, (_, index) => [
            `container-${index}`,
            exactTarget(index),
        ])),
        config: {},
        isShuttingDown: () => false,
        inspectWorkspaceStartLock: () => ({ active: false, stale: false }),
        syncManagedContainers() {},
        collectLiveAgentContainers() {
            calls += 1;
            return Array.from({ length: 16 }, (_, index) => exactLiveEntry(exactTarget(index)));
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

test('the shared Podman snapshot key carries exact release ownership', () => {
    const target = exactTarget(7);
    const snapshot = snapshotRunningContainerNames({
        targets: new Map([[target.containerName, target]]),
        collectLiveAgentContainers: () => [exactLiveEntry(target)],
    });

    assert.deepEqual([...snapshot], [[
        target.containerName,
        target.containerId,
        target.instanceId,
        target.enableGeneration,
        target.releaseGeneration,
    ].join('\0')]);
});

test('snapshot failure defers every exact Podman target without per-target amplification or false restart', () => {
    const logs = [];
    let calls = 0;
    const monitor = {
        targets: new Map(Array.from({ length: 16 }, (_, index) => [
            `container-${index}`,
            exactTarget(index),
        ])),
        config: {},
        isShuttingDown: () => false,
        inspectWorkspaceStartLock: () => ({ active: false, stale: false }),
        syncManagedContainers() {},
        collectLiveAgentContainers() {
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
