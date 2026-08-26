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
import { serializeProbeError } from '../../cli/server/probeWorker.js';

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

test('successive monitor ticks preserve one in-flight probe worker without overlapping snapshots', () => {
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

    assert.equal(snapshots, 0, 'shared runtime snapshots wait for the worker to finish');
    assert.equal(target.probeWorker, activeWorker, 'ticks must not replace the in-flight worker');
    assert.equal(target.probeState, 'running');
    assert.deepEqual(events.map(({ event }) => event), [
        'container_status_snapshot_deferred_active_probe',
    ]);
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
    const runStartedAtMs = 1_700_000_000_000;
    const waveIndex = 2;
    const currentMarker = {
        runId: currentRunId,
        runStartedAtMs,
        statusFile: `run-scoped-container.${currentRunId}.json`,
        waveIndex,
    };
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(currentMarker));

    assert.deepEqual(
        readNoWaitStatus('run-scoped-container', { runningDir: workspace }),
        { state: 'unreadable' },
        'a marker without this run status must remain fail-closed',
    );
    fs.writeFileSync(statusPath, JSON.stringify({
        state: 'running',
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        runStartedAtMs,
        waveIndex,
    }));
    assert.deepEqual(
        readNoWaitStatus('run-scoped-container', { runningDir: workspace }),
        { state: 'unreadable' },
        'a late status from an older run must not reopen monitor probing',
    );
    const currentStatus = {
        state: 'running', runId: currentRunId, runStartedAtMs, waveIndex,
    };
    fs.writeFileSync(statusPath, JSON.stringify(currentStatus));
    assert.deepEqual(
        readNoWaitStatus('run-scoped-container', { runningDir: workspace }),
        currentStatus,
    );
});

test('the no-wait run marker binds run id, run start, and wave together', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-marker-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const statusDir = path.join(workspace, 'no-wait');
    const statusPath = path.join(statusDir, 'bound-container.json');
    const markerPath = path.join(statusDir, 'bound-container.current.json');
    const runId = '12345678-1234-4234-8234-123456789abc';
    const runStartedAtMs = 1_700_000_000_000;
    const waveIndex = 2;
    fs.mkdirSync(statusDir, { recursive: true });
    const writeMarker = (marker) => fs.writeFileSync(markerPath, JSON.stringify({
        runId, runStartedAtMs, statusFile: `bound-container.${runId}.json`, waveIndex, ...marker,
    }));
    const writeStatus = (status) => fs.writeFileSync(statusPath, JSON.stringify({
        state: 'running', runId, runStartedAtMs, waveIndex, ...status,
    }));

    writeMarker({});
    writeStatus({});
    assert.equal(
        readNoWaitStatus('bound-container', { runningDir: workspace }).state,
        'running',
        'a status matching every marker field is current',
    );

    // A matching run id is not sufficient on its own.
    writeStatus({ runStartedAtMs: runStartedAtMs - 1 });
    assert.deepEqual(
        readNoWaitStatus('bound-container', { runningDir: workspace }),
        { state: 'unreadable' },
        'a status from another run start of the same run id must be rejected',
    );
    writeStatus({ waveIndex: waveIndex + 1 });
    assert.deepEqual(
        readNoWaitStatus('bound-container', { runningDir: workspace }),
        { state: 'unreadable' },
        'a status from another wave must be rejected',
    );
    writeStatus({ runStartedAtMs: undefined });
    assert.deepEqual(
        readNoWaitStatus('bound-container', { runningDir: workspace }),
        { state: 'unreadable' },
        'a status without a run start must be rejected',
    );

    // A marker missing or corrupting either new field is itself fail-closed.
    writeStatus({});
    for (const invalidMarker of [
        { runStartedAtMs: undefined },
        { runStartedAtMs: -1 },
        { runStartedAtMs: 'yesterday' },
        { waveIndex: undefined },
        { waveIndex: -1 },
        { waveIndex: 1.5 },
    ]) {
        writeMarker(invalidMarker);
        assert.deepEqual(
            readNoWaitStatus('bound-container', { runningDir: workspace }),
            { state: 'unreadable' },
            `a marker with ${JSON.stringify(invalidMarker)} must be fail-closed`,
        );
    }

    // With no marker at all, an absent status stays "no status" as before.
    fs.unlinkSync(markerPath);
    fs.unlinkSync(statusPath);
    assert.equal(readNoWaitStatus('bound-container', { runningDir: workspace }), null);
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
    t.after(() => {
        if (target.pendingRestartTimer) clearTimeout(target.pendingRestartTimer);
    });

    startProbeWorker(monitor, target);
    const worker = target.probeWorker;
    assert.ok(worker instanceof FakeWorker);
    worker.emit('message', {
        status: 'error',
        error: '[probe] readiness-failure-agent: readiness probe failed (exit 1); managed restart required',
        code: 'PLOINKY_READINESS_FAILED',
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

test('a typed probe control-plane timeout is retried without invalidating a healthy route', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-probe-infrastructure-'));
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
    monitor.config.PROBE_INFRASTRUCTURE_BACKOFF_MS = 60_000;
    monitor.config.PROBE_INFRASTRUCTURE_MAX_BACKOFF_MS = 60_000;
    monitor.inactivateEdgeRoutingGeneration = (reason) => inactivations.push(reason);
    const target = {
        containerName: 'control-plane-timeout-container',
        agentName: 'control-plane-timeout-agent',
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
    t.after(() => {
        if (target.pendingRestartTimer) clearTimeout(target.pendingRestartTimer);
    });

    startProbeWorker(monitor, target);
    const worker = target.probeWorker;
    assert.ok(worker instanceof FakeWorker);
    const observedAt = Date.now();
    worker.emit('message', {
        status: 'error',
        code: 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT',
        error: '[probe] control-plane-timeout-agent: unable to inspect healthcheck.sh: spawnSync podman ETIMEDOUT',
    });

    assert.equal(target.probeState, 'pending');
    assert.equal(target.probeWorker, null);
    assert.equal(target.probeInfrastructureFailures, 1);
    assert.ok(target.probeRetryNotBefore >= observedAt + 60_000);
    assert.equal(target.isRestarting, false);
    assert.equal(target.pendingRestartTimer, null);
    assert.deepEqual(inactivations, []);
    assert.ok(events.some(({ level, event, data }) => (
        level === 'warn'
        && event === 'container_probe_infrastructure_error'
        && data.code === 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT'
        && data.failures === 1
        && data.retryInMs === 60_000
    )));
    assert.equal(
        events.some(({ event }) => event === 'container_probe_failed'),
        false,
    );
    assert.equal(
        events.some(({ event }) => event === 'container_scheduling_restart'),
        false,
    );

    const startsBeforeRetry = events.filter(({ event }) => event === 'container_probe_started').length;
    startProbeWorker(monitor, target);
    assert.equal(target.probeWorker, null, 'the retry backoff must block an immediate retry storm');
    assert.equal(
        events.filter(({ event }) => event === 'container_probe_started').length,
        startsBeforeRetry,
    );

    target.probeRetryNotBefore = Date.now() - 1;
    startProbeWorker(monitor, target);
    const retryWorker = target.probeWorker;
    assert.ok(retryWorker instanceof FakeWorker);
    retryWorker.emit('message', { status: 'success' });
    assert.equal(target.probeState, 'success');
    assert.equal(target.probeInfrastructureFailures, 0);
    assert.equal(target.probeRetryNotBefore, null);
    assert.equal(target.lastError, null);
});

test('probe worker concurrency is capped to avoid a Podman control-plane stampede', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-probe-concurrency-'));
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
    monitor.Worker = FakeWorker;
    monitor.config.PROBE_MAX_CONCURRENCY = 2;
    const targets = Array.from({ length: 4 }, (_, index) => ({
        containerName: `concurrency-container-${index}`,
        agentName: `concurrency-agent-${index}`,
        repoName: 'demo-repo',
        manifestPath,
        probeWorker: null,
        probeState: 'pending',
        circuitBreakerTripped: false,
    }));
    for (const target of targets) monitor.targets.set(target.containerName, target);

    for (const target of targets) startProbeWorker(monitor, target);

    assert.equal(targets.filter(({ probeWorker }) => Boolean(probeWorker)).length, 2);
    assert.equal(targets[2].probeState, 'pending');
    assert.equal(targets[3].probeState, 'pending');
    assert.equal(events.filter(({ event }) => event === 'container_probe_started').length, 2);

    targets[0].probeWorker.emit('message', { status: 'success' });
    startProbeWorker(monitor, targets[2]);
    assert.ok(targets[2].probeWorker instanceof FakeWorker);
    assert.equal(targets.filter(({ probeWorker }) => Boolean(probeWorker)).length, 2);
});

test('probe workers are serialized by default', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-probe-default-serialization-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const manifestPath = path.join(workspace, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
        health: { liveness: { script: 'healthcheck.sh' } },
    }));

    class FakeWorker extends EventEmitter {
        postMessage() {}
        terminate() { return Promise.resolve(0); }
    }

    const { monitor, events } = monitorRecorder();
    monitor.Worker = FakeWorker;
    monitor.targets.set('active-container', { probeWorker: { active: true } });
    const target = {
        containerName: 'default-deferred-container',
        agentName: 'default-deferred-agent',
        repoName: 'demo-repo',
        manifestPath,
        probeWorker: null,
        probeState: 'pending',
    };
    monitor.targets.set(target.containerName, target);

    startProbeWorker(monitor, target);

    assert.equal(target.probeWorker, null);
    assert.equal(target.probeState, 'pending');
    assert.ok(events.some(({ event, data }) => (
        event === 'container_probe_concurrency_deferred'
        && data.maxConcurrentWorkers === 1
    )));

    monitor.targets.get('active-container').probeWorker = null;
    startProbeWorker(monitor, target);

    assert.ok(target.probeWorker instanceof FakeWorker);
    target.probeWorker.emit('message', { status: 'success' });
});

test('runtime snapshots wait for the active semantic probe to release the control plane', () => {
    const { monitor, events } = monitorRecorder();
    const target = {
        containerName: 'serialized-container',
        agentName: 'serialized-agent',
        repoName: 'demo-repo',
        runtime: 'container',
        probeWorker: { active: true },
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

    assert.equal(snapshots, 0, 'podman ps must not overlap an in-flight probe');
    assert.equal(
        events.filter(({ event }) => event === 'container_status_snapshot_deferred_active_probe').length,
        1,
        'a prolonged worker emits one deferral event instead of one per tick',
    );

    target.probeWorker = null;
    target.probeState = 'success';
    target.probeLastSuccessAt = Date.now();
    monitor.startProbeWorker = () => {};
    monitorTick(monitor);

    assert.equal(snapshots, 1, 'the first post-probe tick resumes the shared snapshot');
    assert.equal(monitor.runtimeSnapshotProbeDeferred, false);
});

test('successful semantic probes recur every five minutes by default', () => {
    const { monitor } = monitorRecorder();
    const target = {
        containerName: 'interval-container',
        agentName: 'interval-agent',
        repoName: 'demo-repo',
        runtime: 'container',
        probeWorker: null,
        probeState: 'success',
        probeLastSuccessAt: Date.now() - 60_000,
        isRestarting: false,
        pendingRestartTimer: null,
    };
    monitor.targets.set(target.containerName, target);
    monitor.inspectWorkspaceStartLock = () => ({ active: false, stale: false });
    monitor.syncManagedContainers = () => {};
    monitor.listRunningContainerNames = () => [target.containerName];
    monitor.startProbeWorker = () => {};

    monitorTick(monitor);
    assert.equal(target.probeState, 'success', 'one minute is below the safe recurring interval');

    target.probeLastSuccessAt = Date.now() - (6 * 60_000);
    monitorTick(monitor);
    assert.equal(target.probeState, 'pending', 'an overdue probe becomes eligible again');
});

test('no-wait marker identities must be real JSON numbers, not coercible values', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-coerce-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const statusDir = path.join(workspace, 'no-wait');
    const runId = '12345678-1234-4234-8234-123456789abc';
    fs.mkdirSync(statusDir, { recursive: true });
    const write = (marker, status) => {
        fs.writeFileSync(path.join(statusDir, 'coerce-container.current.json'), JSON.stringify({
            runId, runStartedAtMs: 1_700_000_000_000,
            statusFile: `coerce-container.${runId}.json`, waveIndex: 0, ...marker,
        }));
        fs.writeFileSync(path.join(statusDir, 'coerce-container.json'), JSON.stringify({
            state: 'running', runId, runStartedAtMs: 1_700_000_000_000, waveIndex: 0, ...status,
        }));
    };

    write({}, {});
    assert.equal(readNoWaitStatus('coerce-container', { runningDir: workspace }).state, 'running');

    // Number(null) and Number('') are both 0, so a coercing check would match a
    // wave-zero status and reopen probing instead of failing closed.
    for (const coercible of [null, '', false, '0', []]) {
        write({ waveIndex: coercible }, {});
        assert.deepEqual(
            readNoWaitStatus('coerce-container', { runningDir: workspace }),
            { state: 'unreadable' },
            `a marker waveIndex of ${JSON.stringify(coercible)} must fail closed`,
        );
        write({}, { waveIndex: coercible });
        assert.deepEqual(
            readNoWaitStatus('coerce-container', { runningDir: workspace }),
            { state: 'unreadable' },
            `a status waveIndex of ${JSON.stringify(coercible)} must fail closed`,
        );
    }
    write({ waveIndex: 1024 }, { waveIndex: 1024 });
    assert.deepEqual(
        readNoWaitStatus('coerce-container', { runningDir: workspace }),
        { state: 'unreadable' },
        'a wave index beyond the worker contract must fail closed',
    );
});
