import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-admission-'));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const ploinkyDir = path.join(workspace, '.ploinky');
const agentDir = path.join(ploinkyDir, 'repos', 'demo', 'unsafe');
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
    unsafe_runtime: {
        type: 'agent',
        repoName: 'demo',
        agentName: 'unsafe',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        runtime: 'container',
    },
}, null, 2));
fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
    routes: {
        unsafe: {
            repo: 'demo',
            agent: 'unsafe',
            container: 'unsafe_runtime',
            hostPath: agentDir,
        },
    },
}, null, 2));
const manifestFile = path.join(agentDir, 'manifest.json');
fs.writeFileSync(manifestFile, JSON.stringify({
    container: 'node:20-alpine',
    containerSecurity: { rawArgs: ['--privileged'] },
}));

const {
    createContainerMonitor,
    performContainerRestart,
    syncManagedContainers,
} = await import(`../../cli/server/containerMonitor.js?admission=${Date.now()}`);

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('watchdog policy rejection is terminal before target or timer creation and survives respawn', () => {
    const ledger = path.join(ploinkyDir, 'running', 'test-terminal-ledger.json');
    const events = [];
    const monitor = createContainerMonitor({
        terminalLedgerFile: ledger,
        log: (level, event, data) => events.push({ level, event, data }),
    });
    syncManagedContainers(monitor);
    assert.equal(monitor.targets.size, 0);
    assert.equal(monitor.terminalLedger.get('unsafe_runtime')?.code, 'PLOINKY_MANIFEST_SECURITY_INVALID');
    assert.equal(events.filter(({ event }) => event === 'container_runtime_policy_terminal').length, 1);
    assert.equal(fs.existsSync(ledger), true);

    const respawned = createContainerMonitor({ terminalLedgerFile: ledger });
    syncManagedContainers(respawned);
    assert.equal(respawned.targets.size, 0);
    assert.equal(respawned.terminalLedger.get('unsafe_runtime')?.code, 'PLOINKY_MANIFEST_SECURITY_INVALID');

    fs.writeFileSync(manifestFile, JSON.stringify({ container: 'node:20-alpine' }));
    syncManagedContainers(respawned);
    assert.equal(respawned.terminalLedger.has('unsafe_runtime'), false);
    assert.equal(respawned.targets.has('unsafe_runtime'), true);
    assert.equal(respawned.targets.get('unsafe_runtime').pendingRestartTimer, null);
});

test('watchdog expires an absent terminal tombstone using its documented bounded retention', () => {
    fs.writeFileSync(manifestFile, JSON.stringify({
        container: 'node:20-alpine',
        containerSecurity: { rawArgs: ['--privileged'] },
    }));
    const ledger = path.join(ploinkyDir, 'running', 'expired-terminal-ledger.json');
    const monitor = createContainerMonitor({ terminalLedgerFile: ledger });
    syncManagedContainers(monitor);
    assert.equal(monitor.terminalLedger.has('unsafe_runtime'), true);

    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), '{}');

    const respawned = createContainerMonitor({
        terminalLedgerFile: ledger,
        config: { TERMINAL_TOMBSTONE_RETENTION_MS: 0 },
    });
    syncManagedContainers(respawned);
    assert.equal(respawned.terminalLedger.has('unsafe_runtime'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(ledger, 'utf8')).entries, {});
});

test('watchdog restart attempt rejects concurrent registry drift before runtime mutation', async () => {
    fs.writeFileSync(manifestFile, JSON.stringify({ container: 'node:20-alpine' }));
    const originalRecord = {
        type: 'agent',
        repoName: 'demo',
        agentName: 'unsafe',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        runtime: 'container',
    };
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        unsafe_runtime: originalRecord,
    }, null, 2));
    const monitor = createContainerMonitor({
        terminalLedgerFile: path.join(ploinkyDir, 'running', 'attempt-ledger.json'),
    });
    syncManagedContainers(monitor);
    const target = monitor.targets.get('unsafe_runtime');
    assert.ok(target?.restartSnapshot);
    target.attemptEpoch = 1;
    target.isRestarting = true;
    const attempt = Object.freeze({
        target,
        epoch: 1,
        digest: target.restartInputDigest,
        snapshot: target.restartSnapshot,
    });
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        unsafe_runtime: { ...originalRecord, imageDigest: 'sha256:concurrent' },
    }, null, 2));
    let ensureCalls = 0;
    monitor.ensureAgentService = () => { ensureCalls += 1; };

    await assert.rejects(
        performContainerRestart(monitor, target, 'not_running', attempt),
        { code: 'PLOINKY_RESTART_ATTEMPT_STALE' },
    );
    assert.equal(ensureCalls, 0);
});

test('watchdog restart attempt preserves its staged successor across monitor sync and commits the enriched record', async () => {
    fs.writeFileSync(manifestFile, JSON.stringify({
        container: 'node:20-alpine',
        readiness: { protocol: 'mcp' },
    }));
    const originalRecord = {
        type: 'agent',
        repoName: 'demo',
        agentName: 'unsafe',
        instanceId: 'instance-old',
        enableGeneration: 'enable-old',
        runtime: 'container',
    };
    const stagedRecord = {
        ...originalRecord,
        instanceId: 'instance-new',
        enableGeneration: 'enable-new',
    };
    const finalRecord = {
        ...stagedRecord,
        containerId: 'container-new',
        config: { ports: [{ containerPort: 7000, hostPort: 43123 }] },
    };
    const agentsFile = path.join(ploinkyDir, 'agents.json');
    fs.writeFileSync(agentsFile, JSON.stringify({ unsafe_runtime: originalRecord }, null, 2));
    const monitor = createContainerMonitor({
        terminalLedgerFile: path.join(ploinkyDir, 'running', 'staged-attempt-ledger.json'),
    });
    syncManagedContainers(monitor);
    const target = monitor.targets.get('unsafe_runtime');
    assert.ok(target?.restartSnapshot);
    target.attemptEpoch = 1;
    target.isRestarting = true;
    const attempt = Object.freeze({
        target,
        epoch: 1,
        digest: target.restartInputDigest,
        snapshot: target.restartSnapshot,
    });
    const events = [];
    monitor.createWorkspaceMutationLease = () => Object.freeze({ operation: 'watchdog' });
    monitor.releaseWorkspaceMutationLease = () => {};
    monitor.withNetworkLifecycleLock = (callback) => callback(Object.freeze({ network: true }));
    monitor.resolveRouterEndpoint = () => Object.freeze({
        mode: 'default',
        host: 'host.containers.internal',
        port: 8080,
        url: 'http://host.containers.internal:8080',
    });
    monitor.ensureAgentService = () => {
        events.push('ensure');
        fs.writeFileSync(agentsFile, JSON.stringify({ unsafe_runtime: stagedRecord }, null, 2));
        return {
            containerName: 'unsafe_runtime',
            hostPort: 43123,
            registryRecord: structuredClone(finalRecord),
            stagedRegistryRecord: structuredClone(stagedRecord),
            requiresEdgeActivation: true,
            preparationLease: Object.freeze({ transactionId: 'staged-attempt' }),
        };
    };
    monitor.resolveAgentReadinessProtocol = () => 'mcp';
    monitor.waitForAgentReady = () => {
        events.push('readiness');
        syncManagedContainers(monitor);
        assert.equal(target.attemptEpoch, attempt.epoch);
        assert.equal(target.isRestarting, true);
        assert.equal(target.restartInputDigest, attempt.digest);
        return true;
    };
    monitor.loadAgents = () => JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    monitor.saveAgents = (agents, options) => {
        assert.deepEqual(options, { coordinate: false });
        fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
        events.push('registry-save');
    };
    monitor.mergeRoutingConfig = async (mutator, options) => {
        assert.deepEqual(options, { coordinate: false });
        const routingFile = path.join(ploinkyDir, 'routing.json');
        const next = await mutator(JSON.parse(fs.readFileSync(routingFile, 'utf8')));
        fs.writeFileSync(routingFile, JSON.stringify(next, null, 2));
        events.push('route-save');
    };
    monitor.withEdgeGenerationApplyLock = (callback) => callback(Object.freeze({ apply: true }));
    monitor.applyEdgeRoutingGeneration = (options) => {
        events.push('apply');
        options.testHooks.beforeSelectorCommit();
        return { selector: { state: 'active' } };
    };
    monitor.abortEdgeRoutingPreparation = () => assert.fail('successful restart must not abort');
    monitor.cleanupFailedRuntime = () => assert.fail('successful restart must not clean its candidate');

    await performContainerRestart(monitor, target, 'not_running', attempt);

    assert.deepEqual(JSON.parse(fs.readFileSync(agentsFile, 'utf8')).unsafe_runtime, finalRecord);
    assert.deepEqual(events, ['ensure', 'readiness', 'registry-save', 'route-save', 'apply']);
    assert.equal(target.instanceId, 'instance-new');
    assert.equal(target.enableGeneration, 'enable-new');
    assert.equal(target.isRestarting, false);
});
