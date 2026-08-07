import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import {
    monitorTick,
    readNoWaitStatus,
    startProbeWorker,
} from '../../cli/server/containerMonitor.js';

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
    const target = {
        containerName: 'busy-container',
        agentName: 'busy-agent',
        repoName: 'demo-repo',
        manifestPath: path.join(os.tmpdir(), 'ploinky-missing-manifest.json'),
        probeWorker: activeWorker,
        probeState: 'running',
    };

    startProbeWorker(monitor, target);

    assert.equal(target.probeWorker, activeWorker, 'the in-flight worker must stay untouched');
    assert.equal(target.probeState, 'running');
    assert.deepEqual(events, [], 'no probe start or failure may fire while a probe is in flight');
});

test('successive monitor ticks preserve one in-flight probe worker', () => {
    const { monitor, events } = monitorRecorder();
    const activeWorker = { sentinel: 'active-probe-worker' };
    const target = {
        containerName: 'busy-container',
        agentName: 'busy-agent',
        repoName: 'demo-repo',
        runtime: 'container',
        probeWorker: activeWorker,
        probeState: 'running',
        isRestarting: false,
        pendingRestartTimer: null,
    };
    monitor.targets.set(target.containerName, target);
    monitor.inspectWorkspaceStartLock = () => ({ active: false, stale: false });
    monitor.syncManagedContainers = () => {};
    let snapshots = 0;
    monitor.listRunningContainerNames = () => {
        snapshots += 1;
        return [target.containerName];
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
    const target = {
        containerName: 'activating-container',
        agentName: 'activating-agent',
        repoName: 'demo-repo',
        runtime: 'container',
        probeWorker: null,
        probeState: 'pending',
        isRestarting: false,
        pendingRestartTimer: null,
    };
    monitor.targets.set(target.containerName, target);
    monitor.inspectWorkspaceStartLock = () => ({ active: false, stale: false });
    monitor.syncManagedContainers = () => {};
    monitor.listRunningContainerNames = () => [target.containerName];
    let lifecycleState = 'starting';
    monitor.readNoWaitStatus = () => ({ state: lifecycleState });
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

test('malformed no-wait status remains fail-closed while ENOENT remains absent', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-status-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const statusDir = path.join(workspace, 'no-wait');
    const statusPath = path.join(statusDir, 'malformed-container.json');
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(statusPath, '{"state":');

    assert.deepEqual(
        readNoWaitStatus('malformed-container', { runningDir: workspace }),
        { state: 'unreadable' },
    );
    fs.unlinkSync(statusPath);
    assert.equal(
        readNoWaitStatus('malformed-container', { runningDir: workspace }),
        null,
    );
});

test('a current no-wait run marker rejects stale canonical status and missing publication', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-run-id-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const statusDir = path.join(workspace, 'no-wait');
    const statusPath = path.join(statusDir, 'run-scoped-container.json');
    const markerPath = path.join(statusDir, 'run-scoped-container.current.json');
    const currentRunId = '12345678-1234-4234-8234-123456789abc';
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
        runId: currentRunId,
        statusFile: `run-scoped-container.${currentRunId}.json`,
    }));

    assert.deepEqual(
        readNoWaitStatus('run-scoped-container', { runningDir: workspace }),
        { state: 'unreadable' },
        'a marker without this run status must remain fail-closed',
    );
    fs.writeFileSync(statusPath, JSON.stringify({
        state: 'running',
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }));
    assert.deepEqual(
        readNoWaitStatus('run-scoped-container', { runningDir: workspace }),
        { state: 'unreadable' },
        'a late status from an older run must not reopen monitor probing',
    );
    fs.writeFileSync(statusPath, JSON.stringify({ state: 'running', runId: currentRunId }));
    assert.deepEqual(
        readNoWaitStatus('run-scoped-container', { runningDir: workspace }),
        { state: 'running', runId: currentRunId },
    );
});

test('a malformed no-wait status defers probing instead of becoming no status', () => {
    const { monitor, events } = monitorRecorder();
    const target = {
        containerName: 'malformed-container',
        agentName: 'malformed-agent',
        repoName: 'demo-repo',
        runtime: 'container',
        probeWorker: null,
        probeState: 'pending',
        isRestarting: false,
        pendingRestartTimer: null,
    };
    monitor.targets.set(target.containerName, target);
    monitor.inspectWorkspaceStartLock = () => ({ active: false, stale: false });
    monitor.syncManagedContainers = () => {};
    monitor.listRunningContainerNames = () => [target.containerName];
    monitor.readNoWaitStatus = () => ({ state: 'unreadable' });
    const probeStarts = [];
    monitor.startProbeWorker = (_monitor, current) => {
        probeStarts.push(current.containerName);
    };

    monitorTick(monitor);

    assert.deepEqual(probeStarts, []);
    assert.equal(target.probeState, 'pending');
    assert.equal(target.noWaitDeferredState, 'unreadable');
    assert.ok(events.some(({ event, data }) => (
        event === 'container_no_wait_restart_deferred'
        && data.state === 'unreadable'
    )));
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
    const target = {
        containerName: 'plain-container',
        agentName: 'plain-agent',
        repoName: 'demo-repo',
        manifestPath,
        probeWorker: null,
        probeState: 'pending',
    };

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
    const target = {
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
    };

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
