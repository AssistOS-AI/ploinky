import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A8: a failing probe withdraws only its runtime (D6); the drain owner admits
// the restart, whose commit reopens the route for staged (bridge) and
// same-name (host) replacements; a hardware readback failure (W10) drains the
// same way. Every case runs on the real edge generation store.

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-scoped-drain-'));
const previous = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    PLOINKY_MEDIA_HOST_PORT: process.env.PLOINKY_MEDIA_HOST_PORT,
};
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const { withEdgeSelectionObserver } = await import('../../cli/sandbox/edgeSelectionMutations.mjs');
const monitorModule = await import('../../cli/server/containerMonitor.js');
const manager = await import('../../cli/sandbox/docker/agentServiceManager.js');

test.after(() => {
    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

const ploinkyDir = path.join(workspace, '.ploinky');
const repoDir = path.join(ploinkyDir, 'repos', 'fixtures');
const MANIFESTS = {
    hostAgent: { container: 'node:20-alpine', start: 'sleep infinity', network: { mode: 'host' }, health: { readiness: { type: 'script', script: 'true' } } },
    bridgeAgent: { container: 'node:20-alpine', start: 'sleep infinity', health: { readiness: { type: 'script', script: 'true' } } },
    otherAgent: { container: 'node:20-alpine' },
};
const PORTS = { hostAgent: 7880, bridgeAgent: 41002, otherAgent: 41003 };

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function record(agentName) {
    return {
        type: 'agent',
        runtime: 'container',
        repoName: 'fixtures',
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-generation`,
        containerId: `${agentName}-container-id`,
        profile: 'default',
        auth: { mode: 'sso' },
    };
}

function containerOf(agentName) {
    return `${agentName}-container`;
}

function route(agentName, extra = {}) {
    return {
        repo: 'fixtures',
        agent: agentName,
        container: containerOf(agentName),
        hostPath: path.join(repoDir, agentName),
        hostPort: PORTS[agentName],
        ...extra,
    };
}

function readRouting() {
    return JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8'));
}

// Seed sources and one active generation. A drained agent is written the
// way a withdrawal leaves it: draining, no target, its automatic owner.
function seedWorkspace({ drained = null, reason = 'probe-failure' } = {}) {
    fs.rmSync(ploinkyDir, { recursive: true, force: true });
    for (const [agentName, manifest] of Object.entries(MANIFESTS)) {
        writeJson(path.join(repoDir, agentName, 'manifest.json'), manifest);
    }
    const routes = Object.fromEntries(Object.keys(MANIFESTS).map((agentName) => [agentName, route(agentName)]));
    if (drained) {
        const owner = record(drained);
        delete routes[drained].hostPort;
        routes[drained].draining = true;
        routes[drained].drainOwner = {
            containerName: containerOf(drained),
            instanceId: owner.instanceId,
            enableGeneration: owner.enableGeneration,
            reason,
        };
    }
    writeJson(path.join(ploinkyDir, 'routing.json'), { routes });
    writeJson(path.join(ploinkyDir, 'agents.json'), Object.fromEntries(
        Object.keys(MANIFESTS).map((agentName) => [containerOf(agentName), record(agentName)]),
    ));
    writeJson(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), { hosts: {} });
    writeJson(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });
    edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'a8-fixture' });
    return edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
}

class FakeWorker extends EventEmitter {
    postMessage() {}
    terminate() { return Promise.resolve(0); }
}

function monitorFor(agentName, overrides = {}) {
    const events = [];
    const inactivations = [];
    const target = {
        containerName: containerOf(agentName),
        agentName,
        repoName: 'fixtures',
        alias: null,
        runtime: 'container',
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-generation`,
        manifestPath: path.join(repoDir, agentName, 'manifest.json'),
        type: 'agent',
        probeWorker: null,
        probeState: 'pending',
        restartHistory: [],
        currentBackoff: 60_000,
        isRestarting: false,
        pendingRestartTimer: null,
        circuitBreakerTripped: false,
    };
    const monitor = {
        config: { INITIAL_BACKOFF_MS: 60_000 },
        isShuttingDown: () => false,
        targets: new Map([[target.containerName, target]]),
        log(level, event, data) { events.push({ level, event, data }); },
        Worker: FakeWorker,
        inactivateEdgeRoutingGeneration: (reason) => inactivations.push(reason),
        ...overrides,
    };
    return { monitor, target, events, inactivations };
}

function failProbe(monitor, target) {
    monitorModule.startProbeWorker(monitor, target);
    target.probeWorker.emit('message', {
        status: 'error',
        error: `[probe] ${target.agentName}: readiness probe failed (exit 1); managed restart required`,
        code: 'PLOINKY_READINESS_FAILED',
    });
}

function clearRestart(target) {
    if (target.pendingRestartTimer) clearTimeout(target.pendingRestartTimer);
    target.pendingRestartTimer = null;
    target.isRestarting = false;
}

test('A8 a probe failure withdraws only the failing runtime and keeps the generation active', () => {
    const before = seedWorkspace();
    const { monitor, target, inactivations, events } = monitorFor('bridgeAgent');
    const writes = [];
    withEdgeSelectionObserver((entry) => writes.push(entry), () => failProbe(monitor, target));
    clearRestart(target);
    assert.deepEqual(inactivations, [], 'nothing inactivates the whole edge');
    assert.deepEqual(writes.map((entry) => [entry.before.state, entry.after.state]), [['active', 'active']]);
    const active = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.notEqual(active.selector.generation, before.selector.generation);
    assert.equal(active.generation.routing.routes.bridgeAgent.draining, true);
    assert.equal(active.generation.routing.routes.bridgeAgent.hostPort, undefined);
    assert.deepEqual(active.generation.routing.routes.bridgeAgent.drainOwner, {
        containerName: 'bridgeAgent-container',
        instanceId: 'bridgeAgent-instance',
        enableGeneration: 'bridgeAgent-generation',
        reason: 'probe-failure',
    });
    assert.deepEqual(active.generation.routing.routes.otherAgent, before.generation.routing.routes.otherAgent);
    assert.deepEqual(active.generation.routing.routes.hostAgent, before.generation.routing.routes.hostAgent);
    assert.ok(events.some(({ event, data }) => event === 'container_scheduling_restart' && data.reason === 'semantic_probe_failed'));
});

test('A8 a withdrawal that cannot be proven falls back to global inactivation', () => {
    seedWorkspace();
    const { monitor, target, inactivations } = monitorFor('bridgeAgent', {
        commitWithdrawalEdgeRoutingGeneration() {
            throw Object.assign(new Error('not a subset'), { code: 'EDGE_WITHDRAWAL_NOT_SUBSET' });
        },
    });
    failProbe(monitor, target);
    clearRestart(target);
    assert.deepEqual(inactivations, ['continuous-runtime-probe-failed:bridgeAgent-container']);
});

test('A8 a contended withdrawal is deferred, never global, and a later tick drains the same runtime', () => {
    seedWorkspace();
    let refusals = 1;
    const { monitor, target, inactivations, events } = monitorFor('bridgeAgent', {
        commitWithdrawalEdgeRoutingGeneration(options) {
            if (refusals-- > 0) throw Object.assign(new Error('lease outstanding'), { code: 'EDGE_PREPARATION_BUSY' });
            return edge.commitWithdrawalEdgeRoutingGeneration(options);
        },
        inspectWorkspaceStartLock: () => ({ active: false }),
        syncManagedContainers() {},
        listRunningContainerNames: () => ['bridgeAgent-container'],
        startProbeWorker() {},
    });
    failProbe(monitor, target);
    clearRestart(target);
    assert.deepEqual(inactivations, []);
    assert.equal(edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }).generation.routing.routes.bridgeAgent.draining, undefined);
    assert.ok(events.some(({ event }) => event === 'container_probe_withdrawal_deferred'));

    target.probeState = 'pending';
    monitorModule.monitorTick(monitor);
    clearRestart(target);
    assert.deepEqual(inactivations, []);
    assert.equal(edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }).generation.routing.routes.bridgeAgent.draining, true);
});

function restartMonitor(agentName, { staged, launchEvents }) {
    const oldRecord = record(agentName);
    const { monitor, target, inactivations } = monitorFor(agentName, {
        createWorkspaceMutationLease: () => Object.freeze({ fixture: 'workspace-lease' }),
        releaseWorkspaceMutationLease() {},
        resolveRouterEndpoint: (mode) => (mode === 'none' ? null : { mode, host: '127.0.0.1', port: 8080, url: 'http://127.0.0.1:8080' }),
        ensureAgentService(_agent, _manifest, _dir, options) {
            // The drain owner admits exactly this runtime's replacement.
            manager.assertAgentServiceNotDraining(target.containerName, { expectedPredecessor: options.expectedPredecessor });
            const plan = manager.buildRuntimeNetworkPlan('podman', options.profileResolution.network);
            const values = [`${agentName}-next-instance`, `${agentName}-next-generation`];
            const identity = manager.resolveReplacementRuntimeIdentity({
                containerName: target.containerName,
                existingRecord: oldRecord,
                existingRuntime: false,
                stageAlongsidePredecessor: plan.requiresManagedNetwork,
                preserveActiveAuthorization: options.preserveActiveAuthorization,
                networkLifecycleCapability: options.networkLifecycleCapability,
                portMappings: staged ? [] : [{ containerPort: PORTS[agentName], hostPort: PORTS[agentName] }],
            }, { uuid: () => values.shift(), retireNoWaitMarker() {} });
            launchEvents.push(`launch:${edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector.state}`);
            const prepared = structuredClone(identity.preparedRegistryRecord);
            return {
                containerName: identity.candidateContainerName,
                hostPort: PORTS[agentName] + 100,
                registryRecord: { ...prepared, containerId: 'f'.repeat(64) },
                stagedRegistryRecord: prepared,
                preparationLease: identity.preparationLease,
                requiresEdgeActivation: true,
                ...(identity.candidateContainerName !== target.containerName ? {
                    replacementPredecessor: {
                        containerName: target.containerName,
                        containerId: oldRecord.containerId,
                        registryRecord: structuredClone(oldRecord),
                        runtimeNetwork: options.profileResolution.network,
                    },
                } : {}),
            };
        },
        resolveAgentReadinessProtocol: () => 'script',
        runContainerScriptReadiness() {
            launchEvents.push(`ready:${edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector.state}`);
            return { status: 'success' };
        },
        retireExactAgentRuntimePredecessor(predecessor) {
            launchEvents.push(`retire:${predecessor.containerName}`);
        },
    });
    return { monitor, target, inactivations };
}

for (const [label, agentName, staged] of [['staged bridge', 'bridgeAgent', true], ['same-name host-network', 'hostAgent', false]]) {
    test(`A8 after a probe-failure drain a ${label} restart commits and reopens the route`, async () => {
        seedWorkspace({ drained: agentName });
        const launchEvents = [];
        const { monitor, target, inactivations } = restartMonitor(agentName, { staged, launchEvents });
        const writes = [];
        await withEdgeSelectionObserver((entry) => writes.push(entry), () => monitorModule.performContainerRestart(monitor, target, 'semantic_probe_failed'));
        assert.deepEqual(inactivations, []);
        assert.ok(writes.length > 0 && writes.every((entry) => entry.after.state === 'active'),
            `the selector is never written inactive: ${JSON.stringify(writes.map((entry) => entry.after.state))}`);
        assert.deepEqual(launchEvents.filter((event) => !event.startsWith('retire:')), ['launch:active', 'ready:active']);
        const active = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
        const reopened = active.generation.routing.routes[agentName];
        assert.equal(reopened.draining, undefined);
        assert.equal(reopened.drainOwner, undefined);
        assert.equal(reopened.hostPort, PORTS[agentName] + 100);
        assert.equal(active.generation.agents[reopened.container].instanceId, `${agentName}-next-instance`);
        assert.equal(target.instanceId, `${agentName}-next-instance`);
        assert.equal(target.containerName, reopened.container);
        assert.equal(staged, reopened.container !== containerOf(agentName));
        assert.deepEqual(active.generation.routing.routes.otherAgent.hostPort, PORTS.otherAgent);
    });
}

test('A8 an operator drain still blocks an automatic restart', () => {
    seedWorkspace();
    const routing = readRouting();
    routing.routes.bridgeAgent.draining = true;
    writeJson(path.join(ploinkyDir, 'routing.json'), routing);
    assert.throws(
        () => manager.assertAgentServiceNotDraining('bridgeAgent-container', {
            expectedPredecessor: { instanceId: 'bridgeAgent-instance', enableGeneration: 'bridgeAgent-generation' },
        }),
        { code: 'PLOINKY_AGENT_DRAINING' },
    );
    const stale = readRouting();
    stale.routes.bridgeAgent.drainOwner = {
        containerName: 'bridgeAgent-container',
        instanceId: 'bridgeAgent-instance',
        enableGeneration: 'bridgeAgent-generation',
        reason: 'probe-failure',
    };
    writeJson(path.join(ploinkyDir, 'routing.json'), stale);
    assert.throws(
        () => manager.assertAgentServiceNotDraining('bridgeAgent-container', {
            expectedPredecessor: { instanceId: 'another-instance', enableGeneration: 'bridgeAgent-generation' },
        }),
        { code: 'PLOINKY_AGENT_DRAINING' },
        'an owner admits only the exact runtime it withdrew',
    );
});

test('A8 a hardware readback failure drains the reused runtime and its restart reopens the route', async () => {
    seedWorkspace();
    const reused = record('hostAgent');
    const removed = [];
    assert.throws(() => manager.verifyReusableHardwareRuntime({}, {
        containerName: 'hostAgent-container',
        containerId: reused.containerId,
        runtime: 'podman',
        network: { mode: 'host' },
        record: reused,
        key: 'hostAgent-container',
        ref: 'fixtures/hostAgent',
    }, {
        createGuard: () => ({ afterLaunch() { throw new Error('readback differs from the admitted limits'); } }),
        inactivate: () => assert.fail('the readback failure withdraws only its runtime'),
        removeExact: (target) => { removed.push(target.containerName); return { removed: true }; },
    }), /readback differs/);
    assert.deepEqual(removed, ['hostAgent-container']);
    const drained = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }).generation.routing.routes.hostAgent;
    assert.equal(drained.draining, true);
    assert.equal(drained.drainOwner.reason, 'hardware-readback');

    const launchEvents = [];
    const { monitor, target, inactivations } = restartMonitor('hostAgent', { staged: false, launchEvents });
    await monitorModule.performContainerRestart(monitor, target, 'not_running');
    assert.deepEqual(inactivations, []);
    const reopened = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }).generation.routing.routes.hostAgent;
    assert.equal(reopened.draining, undefined);
    assert.equal(reopened.hostPort, PORTS.hostAgent + 100);
});

test('A8 a drained running runtime is restarted from its durable owner at most three times', () => {
    seedWorkspace({ drained: 'bridgeAgent', reason: 'replacement' });
    const { monitor, target, events } = monitorFor('bridgeAgent', {
        inspectWorkspaceStartLock: () => ({ active: false }),
        syncManagedContainers() {},
        listRunningContainerNames: () => ['bridgeAgent-container'],
        startProbeWorker() {},
        config: { INITIAL_BACKOFF_MS: 60_000, MAX_RESTARTS_IN_WINDOW: 100 },
    });
    for (let tick = 0; tick < 5; tick += 1) {
        monitorModule.monitorTick(monitor);
        clearRestart(target);
    }
    const retries = events.filter(({ event, data }) => event === 'container_scheduling_restart' && data.reason === 'drain_owner_retry');
    assert.equal(retries.length, 3);
    assert.equal(events.filter(({ event }) => event === 'container_drain_retry_exhausted').length, 1);
    assert.equal(readRouting().routes.bridgeAgent.draining, true, 'an exhausted owner leaves the route drained');
});
