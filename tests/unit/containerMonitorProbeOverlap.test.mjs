import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import {
    monitorTick,
    shouldDeferNoWaitRestart,
    startProbeWorker,
} from '../../cli/server/containerMonitor.js';

const CONTAINER_ID = 'e'.repeat(64);

function exactPodmanTarget(overrides = {}) {
    return {
        runtime: 'podman',
        containerId: CONTAINER_ID,
        instanceId: 'instance-exact',
        enableGeneration: 'generation-exact',
        ...overrides,
    };
}

function exactLiveEntry(target) {
    return {
        containerName: target.containerName,
        runtime: 'podman',
        containerId: target.containerId,
        instanceId: target.instanceId,
        enableGeneration: target.enableGeneration,
        ownershipVerified: true,
        state: { running: true },
    };
}

function exactNoWaitStatus(target, state = 'starting', overrides = {}) {
    return {
        state,
        runtime: target.runtime,
        containerName: target.containerName,
        instanceId: target.instanceId,
        enableGeneration: target.enableGeneration,
        ...(target.runtime === 'podman' ? { containerId: target.containerId } : {}),
        ...overrides,
    };
}

function monitorRecorder() {
    const events = [];
    return {
        events,
        monitor: {
            config: {},
            isShuttingDown: () => false,
            targets: new Map(),
            log(level, event, data) {
                events.push({ level, event, data });
            },
        },
    };
}

test('a running probe worker blocks overlapping probe executions for the same target', () => {
    const { monitor, events } = monitorRecorder();
    const activeWorker = { sentinel: 'active-probe-worker' };
    const target = exactPodmanTarget({
        containerName: 'busy-container',
        agentName: 'busy-agent',
        repoName: 'demo-repo',
        manifestPath: path.join(os.tmpdir(), 'ploinky-missing-manifest.json'),
        probeWorker: activeWorker,
        probeState: 'running',
    });

    startProbeWorker(monitor, target);

    assert.equal(target.probeWorker, activeWorker, 'the in-flight worker must stay untouched');
    assert.equal(target.probeState, 'running');
    assert.deepEqual(events, [], 'no probe start or failure may fire while a probe is in flight');
});

test('successive monitor ticks preserve one in-flight probe worker', () => {
    const { monitor, events } = monitorRecorder();
    const activeWorker = { sentinel: 'active-probe-worker' };
    const target = exactPodmanTarget({
        containerName: 'busy-container',
        agentName: 'busy-agent',
        repoName: 'demo-repo',
        probeWorker: activeWorker,
        probeState: 'running',
        isRestarting: false,
        pendingRestartTimer: null,
    });
    monitor.targets.set(target.containerName, target);
    monitor.inspectWorkspaceStartLock = () => ({ active: false, stale: false });
    monitor.syncManagedContainers = () => {};
    let snapshots = 0;
    monitor.collectLiveAgentContainers = () => {
        snapshots += 1;
        return [exactLiveEntry(target)];
    };

    monitorTick(monitor);
    monitorTick(monitor);

    assert.equal(snapshots, 2, 'each tick takes one shared runtime snapshot');
    assert.equal(target.probeWorker, activeWorker, 'ticks must not replace the in-flight worker');
    assert.equal(target.probeState, 'running');
    assert.deepEqual(events, []);
});

test('a running no-wait container is not probed until activation readiness publishes running', () => {
    const { monitor, events } = monitorRecorder();
    const target = exactPodmanTarget({
        containerName: 'activating-container',
        agentName: 'activating-agent',
        repoName: 'demo-repo',
        probeWorker: null,
        probeState: 'pending',
        isRestarting: false,
        pendingRestartTimer: null,
    });
    monitor.targets.set(target.containerName, target);
    monitor.inspectWorkspaceStartLock = () => ({ active: false, stale: false });
    monitor.syncManagedContainers = () => {};
    monitor.collectLiveAgentContainers = () => [exactLiveEntry(target)];
    let lifecycleState = 'starting';
    monitor.readNoWaitStatus = () => exactNoWaitStatus(target, lifecycleState);
    const probeStarts = [];
    monitor.startProbeWorker = (_monitor, current) => {
        probeStarts.push(current.containerName);
    };

    monitorTick(monitor);

    assert.deepEqual(probeStarts, []);
    assert.equal(target.probeState, 'pending');
    assert.deepEqual(events.map(({ event }) => event), [
        'container_no_wait_restart_deferred',
    ]);

    lifecycleState = 'running';
    monitorTick(monitor);

    assert.deepEqual(probeStarts, [target.containerName]);
    assert.equal(target.noWaitDeferredState, null);
});

test('no-wait restart deferral requires the exact current Podman identity and state', () => {
    const target = exactPodmanTarget({
        containerName: 'identity-bound-container',
        agentName: 'identity-bound-agent',
        repoName: 'demo-repo',
    });
    const exactStarting = exactNoWaitStatus(target);
    const exactFailed = exactNoWaitStatus(target, 'failed');
    for (const status of [exactStarting, exactFailed]) {
        const monitor = { readNoWaitStatus: () => status, log() {} };
        assert.equal(shouldDeferNoWaitRestart(monitor, target), true);
    }

    const mismatches = [
        { ...exactStarting, state: 'Starting' },
        { ...exactStarting, state: ' starting' },
        { ...exactStarting, state: 'failed ' },
        { ...exactStarting, state: new String('starting') },
        { ...exactStarting, runtime: 'bwrap' },
        { ...exactStarting, runtime: ' podman' },
        { ...exactStarting, containerName: `${target.containerName}-stale` },
        { ...exactStarting, instanceId: `${target.instanceId}-stale` },
        { ...exactStarting, enableGeneration: `${target.enableGeneration}-stale` },
        { ...exactStarting, containerId: 'f'.repeat(64) },
        Object.fromEntries(Object.entries(exactStarting).filter(([key]) => key !== 'containerId')),
    ];
    for (const status of mismatches) {
        const monitor = { readNoWaitStatus: () => status, log() {} };
        assert.equal(
            shouldDeferNoWaitRestart(monitor, target),
            false,
            `mixed identity must not defer: ${JSON.stringify(status)}`,
        );
    }
    for (const changedTarget of [
        { ...target, runtime: new String('podman') },
        { ...target, containerName: new String(target.containerName) },
        { ...target, instanceId: new String(target.instanceId) },
        { ...target, enableGeneration: new String(target.enableGeneration) },
        { ...target, containerId: { toString: () => CONTAINER_ID } },
    ]) {
        const matchingCoercedStatus = {
            ...exactStarting,
            runtime: changedTarget.runtime,
            containerName: changedTarget.containerName,
            instanceId: changedTarget.instanceId,
            enableGeneration: changedTarget.enableGeneration,
            containerId: changedTarget.containerId,
        };
        assert.equal(shouldDeferNoWaitRestart({
            readNoWaitStatus: () => matchingCoercedStatus,
            log() {},
        }, changedTarget), false);
    }
    const { containerId: _unavailableTargetContainerId, ...freshPodmanTarget } = target;
    const { containerId: _unavailableStatusContainerId, ...freshPodmanStatus } = exactStarting;
    assert.equal(shouldDeferNoWaitRestart({
        readNoWaitStatus: () => freshPodmanStatus,
        log() {},
    }, freshPodmanTarget), false, 'watchdog must not defer an unlaunched Podman target without an immutable ID');
});

test('no-wait restart deferral matches sandbox identity without a container id', () => {
    const target = {
        runtime: 'bwrap',
        containerName: 'sandbox-identity-bound',
        instanceId: 'sandbox-instance',
        enableGeneration: 'sandbox-generation',
        agentName: 'sandbox-agent',
        repoName: 'demo-repo',
    };
    const exact = exactNoWaitStatus(target, 'starting');
    assert.equal(shouldDeferNoWaitRestart({ readNoWaitStatus: () => exact, log() {} }, target), true);
    assert.equal(shouldDeferNoWaitRestart({
        readNoWaitStatus: () => ({ ...exact, containerId: CONTAINER_ID }),
        log() {},
    }, target), false);
});

test('a fresh success blocks re-probing until the monitor tick resets probe state', () => {
    const { monitor, events } = monitorRecorder();
    const target = {
        containerName: 'settled-container',
        agentName: 'settled-agent',
        repoName: 'demo-repo',
        manifestPath: path.join(os.tmpdir(), 'ploinky-missing-manifest.json'),
        probeWorker: null,
        probeState: 'success',
    };

    startProbeWorker(monitor, target);

    assert.equal(target.probeWorker, null);
    assert.equal(target.probeState, 'success');
    assert.deepEqual(events, []);
});

test('a tripped circuit breaker blocks probe scheduling entirely', () => {
    const { monitor, events } = monitorRecorder();
    const target = {
        containerName: 'tripped-container',
        agentName: 'tripped-agent',
        repoName: 'demo-repo',
        manifestPath: path.join(os.tmpdir(), 'ploinky-missing-manifest.json'),
        probeWorker: null,
        probeState: 'pending',
        circuitBreakerTripped: true,
    };

    startProbeWorker(monitor, target);

    assert.equal(target.probeWorker, null);
    assert.equal(target.probeState, 'pending');
    assert.deepEqual(events, []);
});

test('manifests without health config settle to success without spawning a worker', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-probe-overlap-'));
    const manifestPath = path.join(workspace, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ start: 'noop' }));
    const { monitor, events } = monitorRecorder();
    const target = exactPodmanTarget({
        containerName: 'plain-container',
        agentName: 'plain-agent',
        repoName: 'demo-repo',
        manifestPath,
        probeWorker: null,
        probeState: 'pending',
    });

    startProbeWorker(monitor, target);

    assert.equal(target.probeWorker, null, 'no worker thread may spawn without declared health probes');
    assert.equal(target.probeState, 'success');
    assert.deepEqual(events, []);
});

test('a probe worker error inactivates routing and schedules managed recovery', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-probe-failure-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const manifestPath = path.join(workspace, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
        health: {
            readiness: {
                script: 'healthcheck.sh',
            },
        },
    }));

    class FakeWorker extends EventEmitter {
        postMessage() {}
        terminate() {
            return Promise.resolve(0);
        }
    }

    const { monitor, events } = monitorRecorder();
    const inactivations = [];
    monitor.Worker = FakeWorker;
    monitor.config.INITIAL_BACKOFF_MS = 60_000;
    monitor.inactivateEdgeRoutingGeneration = (reason) => inactivations.push(reason);
    const target = exactPodmanTarget({
        containerName: 'readiness-failure-container',
        agentName: 'readiness-failure-agent',
        repoName: 'demo-repo',
        manifestPath,
        probeWorker: null,
        probeState: 'pending',
        restartHistory: [],
        currentBackoff: 60_000,
        isRestarting: false,
        pendingRestartTimer: null,
        circuitBreakerTripped: false,
    });

    startProbeWorker(monitor, target);
    const worker = target.probeWorker;
    assert.ok(worker instanceof FakeWorker);
    worker.emit('message', {
        status: 'error',
        error: '[probe] readiness-failure-agent: readiness probe failed (exit 1); managed restart required',
    });

    assert.equal(target.probeState, 'failed');
    assert.equal(target.probeWorker, null);
    assert.equal(target.isRestarting, true);
    assert.ok(target.pendingRestartTimer);
    assert.deepEqual(inactivations, [
        'continuous-runtime-probe-failed:readiness-failure-container',
    ]);
    assert.ok(events.some(({ event }) => event === 'container_probe_failed'));
    assert.ok(events.some(({ event, data }) => (
        event === 'container_scheduling_restart'
        && data.reason === 'semantic_probe_failed'
    )));

    clearTimeout(target.pendingRestartTimer);
    target.pendingRestartTimer = null;
    target.isRestarting = false;
});
