// A workspace start that stopped after persisting a record's rotated tuple, but
// before removing the predecessor that tuple replaces, leaves a receipt with
// the predecessor's own tuple, keyed by the rotated one, that only the next
// start can consume (graphPredecessorOwnership.test.mjs). A Watchdog that
// outlives that start must leave the record alone whatever the runtime's
// network: restarting it rotates the record again, the receipt no longer
// binds, and no later start can prove, or remove, the predecessor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-start-predecessor-')));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const ploinkyDir = path.join(workspace, '.ploinky');
const agentsFile = path.join(ploinkyDir, 'agents.json');
const receiptsDir = path.join(ploinkyDir, 'run', 'runtime-predecessors');
fs.mkdirSync(ploinkyDir, { recursive: true });

const {
    createContainerMonitor,
    monitorTick,
    performContainerRestart,
    stopContainerMonitor,
    syncManagedContainers,
} = await import('../../cli/server/containerMonitor.js');
const {
    retireRuntimePredecessor,
    writeRuntimePredecessor,
} = await import('../../cli/sandbox/runtimePredecessorStore.js');

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

let fixtures = 0;

// What a stopped start leaves: the record under its rotated tuple and the
// predecessor's container ID, and the receipt with the predecessor's tuple.
function stoppedStart(t, manifestFields) {
    fixtures += 1;
    const agentName = `agent${fixtures}`;
    const containerName = `ploinky_demo_${agentName}`;
    const agentDir = path.join(ploinkyDir, 'repos', 'demo', agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({
        container: 'node:20-alpine', start: 'node index.js', ...manifestFields,
    }));
    const record = {
        type: 'agent', repoName: 'demo', agentName, runtime: 'podman',
        containerId: fixtures.toString(16).padStart(64, 'c'),
        instanceId: `${agentName}-rotated-instance`,
        enableGeneration: `${agentName}-rotated-generation`,
    };
    fs.writeFileSync(agentsFile, JSON.stringify({ [containerName]: record }, null, 2));
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: { [agentName]: { container: containerName, repo: 'demo', agent: agentName, hostPath: agentDir } },
    }, null, 2));
    fs.rmSync(receiptsDir, { recursive: true, force: true });
    const receipt = writeRuntimePredecessor({
        containerName,
        successor: record,
        predecessor: { ...record, instanceId: `${agentName}-instance`, enableGeneration: `${agentName}-generation` },
    });
    const [receiptName] = fs.readdirSync(receiptsDir);

    const calls = { leases: 0, releases: 0, network: 0, ensure: [] };
    const events = [];
    const ledgerFile = path.join(ploinkyDir, 'running', `${agentName}-terminal.json`);
    const monitor = createContainerMonitor({
        config: { INITIAL_BACKOFF_MS: 1, MAX_BACKOFF_MS: 1, CONTAINER_SNAPSHOT_INTERVAL_MS: 0 },
        terminalLedgerFile: ledgerFile,
        log: (level, event, data = {}) => events.push({ event, container: data.container || null, code: data.code || null }),
    });
    t.after(() => stopContainerMonitor(monitor));
    monitor.inspectWorkspaceStartLock = () => ({ active: false, stale: false });
    monitor.listRunningContainerNames = () => [];
    monitor.createWorkspaceMutationLease = () => {
        calls.leases += 1;
        return Object.freeze({ fixture: agentName });
    };
    monitor.releaseWorkspaceMutationLease = () => { calls.releases += 1; };
    monitor.withNetworkLifecycleLock = async (callback) => {
        calls.network += 1;
        return callback(Object.freeze({ fixture: 'network' }));
    };
    monitor.readEdgeRoutingSelection = () => ({ selector: { state: 'inactive' } });
    monitor.resolveRouterEndpoint = () => null;
    // Every replacement path starts here; a reused runtime is the least it can do.
    monitor.ensureAgentService = (_agent, _manifest, _dir, options) => {
        calls.ensure.push(options.containerName);
        const current = JSON.parse(fs.readFileSync(agentsFile, 'utf8'))[options.containerName];
        return { containerName: options.containerName, requiresEdgeActivation: false, registryRecord: current };
    };
    return {
        containerName, receipt, receiptFile: path.join(receiptsDir, receiptName), ledgerFile, monitor, calls,
        eventsFor: () => events.filter((entry) => entry.container === containerName),
    };
}

async function settled(target) {
    const deadline = Date.now() + 10_000;
    while (target.isRestarting || target.pendingRestartTimer) {
        assert.ok(Date.now() < deadline, 'the scheduled restart did not settle');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

for (const [label, manifestFields] of [
    ['a managed network', { network: { mode: 'default' } }],
    ['a fixed host port', { network: { mode: 'default' }, profiles: { default: { openPorts: ['7880:7880'] } } }],
    ['no network', { network: { mode: 'none' } }],
]) {
    test(`a Watchdog leaves a runtime with ${label} that a stopped start staged to the next start`, async (t) => {
        const f = stoppedStart(t, manifestFields);
        const registryBytes = fs.readFileSync(agentsFile);
        const receiptBytes = fs.readFileSync(f.receiptFile);
        syncManagedContainers(f.monitor);
        const target = f.monitor.targets.get(f.containerName);
        assert.ok(target, 'the runtime is watched');

        // A restart scheduled before the start stopped takes the lease and defers.
        await performContainerRestart(f.monitor, target, 'semantic_probe_failed');
        assert.equal(target.isRestarting, false);
        assert.deepEqual(f.calls, { leases: 1, releases: 1, network: 0, ensure: [] });

        // Later ticks neither probe nor schedule it, so no restart history builds up.
        for (let tick = 0; tick < 3; tick += 1) monitorTick(f.monitor);
        assert.equal(target.pendingRestartTimer, null);
        assert.deepEqual(target.restartHistory, []);
        assert.equal(target.circuitBreakerTripped, false);
        assert.deepEqual(f.calls, { leases: 1, releases: 1, network: 0, ensure: [] });
        assert.deepEqual(f.eventsFor().map((entry) => entry.event), [
            'container_watch_added',
            'container_restart_deferred_start_predecessor',
        ]);
        assert.deepEqual(fs.readFileSync(agentsFile), registryBytes);
        assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBytes);
        assert.equal(fs.existsSync(f.ledgerFile), false, 'a deferral is never terminal');

        // Once the next start has consumed the receipt, the runtime is restarted as before.
        retireRuntimePredecessor(f.receipt);
        monitorTick(f.monitor);
        await settled(target);
        assert.deepEqual(f.calls.ensure, [f.containerName]);
        assert.deepEqual(f.eventsFor().map((entry) => entry.event).slice(2), [
            'container_scheduling_restart',
            'container_restart_reused_running',
        ]);
    });
}

test('a Watchdog neither probes nor restarts a running predecessor that a stopped start left to the next start', (t) => {
    // A reused Watchdog over a live workspace whose start failed: the
    // predecessor still runs, and a probe of it may already be in flight.
    const f = stoppedStart(t, { network: { mode: 'default' } });
    f.monitor.listRunningContainerNames = () => [f.containerName];
    f.monitor.startProbeWorker = () => assert.fail('a record left to the next start must not be probed');
    syncManagedContainers(f.monitor);
    const target = f.monitor.targets.get(f.containerName);
    let terminated = 0;
    target.probeWorker = {
        postMessage() {},
        terminate() {
            terminated += 1;
            return Promise.resolve(0);
        },
    };
    target.probeState = 'running';
    target.probeLastSuccessAt = Date.now();

    for (let tick = 0; tick < 3; tick += 1) monitorTick(f.monitor);
    assert.equal(terminated, 1);
    assert.equal(target.probeWorker, null);
    assert.equal(target.probeState, 'pending');
    assert.equal(target.probeLastSuccessAt, null);
    assert.equal(target.pendingRestartTimer, null);
    assert.deepEqual(target.restartHistory, []);
    assert.deepEqual(f.calls, { leases: 0, releases: 0, network: 0, ensure: [] });
    assert.deepEqual(f.eventsFor().map((entry) => entry.event), [
        'container_watch_added',
        'container_restart_deferred_start_predecessor',
    ]);
});

test('a receipt for that record that does not bind defers the Watchdog and is never erased', async (t) => {
    const f = stoppedStart(t, { network: { mode: 'default' } });
    const document = JSON.parse(fs.readFileSync(f.receiptFile, 'utf8'));
    fs.writeFileSync(f.receiptFile, JSON.stringify({
        ...document, predecessor: { ...document.predecessor, containerId: 'f'.repeat(64) },
    }));
    const receiptBytes = fs.readFileSync(f.receiptFile);
    syncManagedContainers(f.monitor);
    const target = f.monitor.targets.get(f.containerName);

    await performContainerRestart(f.monitor, target, 'not_running');
    for (let tick = 0; tick < 3; tick += 1) monitorTick(f.monitor);
    assert.deepEqual(f.calls, { leases: 1, releases: 1, network: 0, ensure: [] });
    assert.deepEqual(f.eventsFor().filter((entry) => entry.event !== 'container_watch_added'), [{
        event: 'container_restart_deferred_start_predecessor',
        container: f.containerName,
        code: 'PLOINKY_RUNTIME_PREDECESSOR_INVALID',
    }]);
    assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBytes);
    assert.equal(fs.existsSync(f.ledgerFile), false);
});
