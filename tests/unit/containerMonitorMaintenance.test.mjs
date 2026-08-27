import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-container-monitor-maintenance-'));
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const locks = await import(`../../cli/utils/runtime/maintenanceLocks.js?test=${Date.now()}`);
const {
    monitorTick,
    performContainerRestart,
    startProbeWorker,
} = await import(`../../cli/server/containerMonitor.js?test=${Date.now()}`);

test('scheduled watchdog restart defers when maintenance starts before execution', async (t) => {
    const containerName = 'maintenance-race-container';
    const lock = locks.createMaintenanceLock(containerName, { operation: 'reinstall' });
    t.after(() => locks.removeMaintenanceLock(containerName, lock.token));

    const events = [];
    const monitor = {
        config: {},
        isShuttingDown: () => false,
        log(level, event, data) {
            events.push({ level, event, data });
        },
        targets: new Map(),
    };
    const target = {
        containerName,
        agentName: 'demo-agent',
        repoName: 'demo-repo',
        manifestPath: path.join(workspace, 'missing-manifest.json'),
        isRestarting: true,
        maintenanceDeferred: false,
    };

    await performContainerRestart(monitor, target, 'not_running');

    assert.equal(target.isRestarting, false);
    assert.equal(target.circuitBreakerTripped, undefined);
    assert.equal(locks.inspectMaintenanceLock(containerName).active, true);
    assert.deepEqual(
        events.map(({ event }) => event),
        ['container_restart_deferred_maintenance'],
    );
});

test('a running target is not continuously probed while maintenance owns it', (t) => {
    const containerName = 'maintenance-running-container';
    const lock = locks.createMaintenanceLock(containerName, { operation: 'restart' });
    t.after(() => locks.removeMaintenanceLock(containerName, lock.token));

    let terminated = 0;
    const activeWorker = {
        postMessage() {},
        terminate() {
            terminated += 1;
            return Promise.resolve(0);
        },
    };
    const events = [];
    const target = {
        containerName,
        agentName: 'demo-agent',
        repoName: 'demo-repo',
        runtime: 'container',
        probeWorker: activeWorker,
        probeState: 'running',
        probeLastSuccessAt: Date.now(),
        isRestarting: false,
        pendingRestartTimer: null,
        circuitBreakerTripped: false,
    };
    const monitor = {
        config: {},
        isShuttingDown: () => false,
        inspectWorkspaceStartLock: () => ({ active: false, stale: false }),
        syncManagedContainers() {},
        listRunningContainerNames: () => [containerName],
        targets: new Map([[containerName, target]]),
        log(level, event, data) {
            events.push({ level, event, data });
        },
        startProbeWorker() {
            assert.fail('maintenance must prevent continuous probe startup');
        },
    };

    monitorTick(monitor);

    assert.equal(terminated, 1);
    assert.equal(target.probeWorker, null);
    assert.equal(target.probeState, 'pending');
    assert.equal(target.probeLastSuccessAt, null);
    assert.deepEqual(events.map(({ event }) => event), [
        'container_restart_deferred_maintenance',
    ]);
});

test('an in-flight probe failure is discarded when maintenance begins', (t) => {
    const containerName = 'maintenance-inflight-probe-container';
    const manifestPath = path.join(workspace, `${containerName}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
        health: { readiness: { script: 'healthcheck.sh' } },
    }));

    class FakeWorker extends EventEmitter {
        postMessage() {}
        terminate() {
            return Promise.resolve(0);
        }
    }

    const events = [];
    const inactivations = [];
    const monitor = {
        Worker: FakeWorker,
        config: { INITIAL_BACKOFF_MS: 60_000 },
        isShuttingDown: () => false,
        targets: new Map(),
        inactivateEdgeRoutingGeneration(reason) {
            inactivations.push(reason);
        },
        log(level, event, data) {
            events.push({ level, event, data });
        },
    };
    const target = {
        containerName,
        agentName: 'demo-agent',
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

    const lock = locks.createMaintenanceLock(containerName, { operation: 'restart' });
    t.after(() => locks.removeMaintenanceLock(containerName, lock.token));
    worker.emit('message', { status: 'error', error: 'replacement is not ready yet' });

    assert.equal(target.probeWorker, null);
    assert.equal(target.probeState, 'pending');
    assert.equal(target.probeLastSuccessAt, null);
    assert.equal(target.isRestarting, false);
    assert.equal(target.pendingRestartTimer, null);
    assert.deepEqual(inactivations, []);
    assert.equal(events.some(({ event }) => event === 'container_probe_failed'), false);
    assert.equal(events.some(({ event }) => event === 'container_scheduling_restart'), false);
    assert.equal(events.some(({ event }) => event === 'container_restart_deferred_maintenance'), true);
});
