// Workspace start runtime-option wiring. The first test executes the real
// startWorkspace body (its exact source text) in a VM sandbox whose global
// scope supplies the module's collaborators, as reinstallRecovery.test.mjs
// does for reinstallAgent: lease, graph, Router and readiness boundaries are
// stubs; any collaborator the test does not supply is a ReferenceError. It proves
// the exact options the production start passes to ensureAgentService. The
// second test proves, through the real ensureAgentService and the fake
// engine, what those options mean for the prepared registry record.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

import { startWorkspace } from '../../cli/commands/workspaceUtil.js';
import { tempRoot } from './dependencyStoreFixtures.mjs';
import {
    CONTAINER,
    driveWiring,
    registration,
    stepValue,
    wiringWorkspace,
} from './dependencyStoreWiringHarness.mjs';

// An identifier the test does not supply is undefined in the sandbox and
// fails the run with a ReferenceError, so no collaborator is silently skipped.
function sandbox(collaborators) {
    return vm.runInNewContext(`(${startWorkspace.toString()})`, { ...collaborators });
}

function startFixture(t) {
    const root = tempRoot(t, 'depstore-wsstart-');
    const agentPath = path.join(root, 'repos', 'repo', 'demo');
    fs.mkdirSync(agentPath, { recursive: true });
    const manifestPath = path.join(agentPath, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ container: 'node:20', start: 'node index.js', network: { mode: 'none' } }));
    const calls = [];
    const earlyLease = Object.freeze({ mode: 'replace', tag: 'early-prelaunch-lease' });
    const postProviderLease = Object.freeze({ mode: 'replace', preparedGeneration: 'g2', tag: 'post-provider-lease' });
    const workspaceLease = Object.freeze({ tag: 'workspace-mutation-lease' });
    // The lease start binds as its operation's own, for nested reuse.
    let boundLease = null;
    const networkCapability = Object.freeze({ tag: 'network-capability' });
    const preparedRecord = Object.freeze({ ...registration(), instanceId: 'prepared-instance', enableGeneration: 'prepared-generation' });
    const staticNode = { id: 'repo/demo', repoName: 'repo', shortAgentName: 'demo', manifestPath, agentPath, isStatic: true };
    const graph = { nodes: new Map([[staticNode.id, staticNode]]), staticNodeId: staticNode.id };
    let registry = { [CONTAINER]: preparedRecord };
    let config = { static: { agent: 'repo/demo', port: 8080 } };
    let routing = { port: 8080, routes: {} };
    const ensureResult = {
        containerName: CONTAINER,
        hostPort: 0,
        registryRecord: { ...preparedRecord, runtime: 'podman', containerId: 'c'.repeat(64) },
    };
    const collaborators = {
        console: { log() {}, warn() {}, error(message) { calls.push(['console.error', message]); } },
        path,
        fs,
        __dirname: '/ploinky/cli/commands',
        PLOINKY_WORKSPACE_ROOT: root,
        PLOINKY_DIR: path.join(root, '.ploinky'),
        RUNNING_DIR: path.join(root, '.ploinky', 'running'),
        LOGS_DIR: path.join(root, '.ploinky', 'logs'),
        workspaceSvc: {
            getConfig: () => config,
            setConfig: (next) => { config = next; },
            saveAgents: (next) => { registry = { ...next }; calls.push(['saveAgents', structuredClone(next)]); },
            loadAgents: () => registry,
        },
        agentsSvc: { resolveEnabledAgentRecord: () => ({ containerName: CONTAINER, record: preparedRecord }) },
        utils: {
            colorize: (value) => value,
            findAgent: () => ({ repo: 'repo', shortAgentName: 'demo', manifestPath }),
        },
        dockerSvc: {
            getAgentContainerName: () => CONTAINER,
            ensureAgentService(agentName, manifest, suppliedAgentPath, options) {
                calls.push(['ensureAgentService', agentName, suppliedAgentPath, options]);
                calls.push(['ensureBoundLease', boundLease === workspaceLease]);
                return ensureResult;
            },
            cleanupExactAgentRuntimeCandidate: (candidate) => calls.push(['cleanupCandidate', candidate]),
        },
        prepareDefaultBootRepositories: () => {},
        prepareManifestRepositories: async () => {},
        getActiveProfile: () => 'default',
        getProfileConfig: () => ({}),
        preflightWorkspaceStartRuntimeCapabilities: () => ({ admissions: ['admitted'], graph, registry, additionalNodes: [] }),
        resetPreinstallRunInProcess: () => {},
        acquireWorkspaceMutationLease: async (options) => { calls.push(['acquireLease', options.operation]); return workspaceLease; },
        releaseWorkspaceStartLock: (lease) => calls.push(['releaseLease', lease === workspaceLease]),
        runWithWorkspaceMutationLease: async (lease, fn) => {
            boundLease = lease;
            try { return await fn(); } finally { boundLease = null; }
        },
        withNetworkLifecycleLock: async (callback) => callback(networkCapability),
        assertWorkspaceGraphAdmissionsCurrent: () => {},
        resolveWorkspaceGraphSsoConfig: () => null,
        initializeFreshEdgeRoutingSources: () => {},
        retireAbandonedWorkspaceStartPreparation: (options) => { calls.push(['retirePreparation', options]); return { retired: false }; },
        inactivateEdgeRoutingGeneration: (reason) => calls.push(['inactivate', reason]),
        resolveAndPersistStartRouterPort: async () => 8080,
        parseRouterPort: (value) => Number(value),
        readRoutingConfig: () => structuredClone(routing),
        writeRoutingConfig: (next) => { routing = structuredClone(next); },
        buildRouterEnv: () => ({}),
        ensureRouterGenerationReady: async () => ({ reused: true }),
        resolveStaticRouterContainerName: () => CONTAINER,
        deduplicateAgentRegistry: (value) => ({ ...value }),
        classifyDependencyGraphWaitMode: () => ({ noWait: new Set() }),
        ensureGraphNodesEnabled: () => {
            calls.push(['ensureGraphNodesEnabled']);
            return { preparedGeneration: { preparationLease: earlyLease, selector: { state: 'inactive' } } };
        },
        applyStartupConfigProvidersForGraph: async () => ({ providers: [], applied: [], warnings: [] }),
        reprepareGraphAfterStartupProviders: (dependencyGraph, reg, prepared) => {
            calls.push(['reprepare', prepared.preparedGeneration.preparationLease === earlyLease]);
            return { preparedGraph: { preparedGeneration: { preparationLease: postProviderLease, selector: { state: 'inactive' } } }, preparedContainerNames: [] };
        },
        topologicallyGroupDependencyGraph: () => [[staticNode.id]],
        findRegistryEntryForGraphNode: () => ({ key: CONTAINER }),
        formatGraphNodeLabel: (node) => node.id,
        findAgentManifest: () => manifestPath,
        resolveAgentRepositoryName: () => 'repo',
        resolveManifestRouterEndpoint: () => null,
        resolveManifestRuntimeProfile: () => ({ resolvedProfileName: 'default', profileConfig: {}, network: { mode: 'none' } }),
        prepareHostModeCapabilityForInactiveGeneration: () => { throw new Error('network mode none needs no host capability'); },
        resolveAgentExecutionMode: () => ({ type: 'start_only' }),
        buildRelayReadinessRoute: ({ route }) => route,
        buildBlockingReadinessEntryFromNode: (node, route) => ({ node: node.id, route }),
        waitForReadinessEntries: async (entries) => calls.push(['readiness', entries.length]),
        mergeRoutingConfig: async (mutate, options = {}) => {
            calls.push(['mergeRoutingConfig', options]);
            routing = mutate(structuredClone(routing));
            return routing;
        },
        partitionAdditionalStartupAgents: () => ({ inactiveManual: [], activeManual: [], automatic: [] }),
        loadRegistryManifest: () => { throw new Error('no additional agents in this graph'); },
        isRegistryRuntimeRunning: () => { throw new Error('no additional agents in this graph'); },
        retireRuntimeCandidate: () => {},
        randomUUID: () => '00000000-0000-4000-8000-000000000000',
        buildNoWaitLaunchSchedule: () => [],
        bindNoWaitLaunchScheduleIdentity: (schedule) => schedule,
        buildRouterUrl: (port) => `http://127.0.0.1:${port}`,
        collectDependencyObjectsAfterAdmission: (options) => { calls.push(['collect', options.lease === workspaceLease, options.reason]); return {}; },
        reportDependencyCollection: (value) => value,
        abortEdgeRoutingPreparation: (lease, options) => calls.push(['abortPreparation', lease, options]),
    };
    return { collaborators, calls, earlyLease, postProviderLease, workspaceLease, networkCapability, preparedRecord, ensureResult, registry: () => registry };
}

test('workspace start settles an abandoned graph preparation under its leases before replacing the selector', async (t) => {
    const fixture = startFixture(t);
    await sandbox(fixture.collaborators)('repo/demo', '8080', {});
    const retireIndex = fixture.calls.findIndex(([name]) => name === 'retirePreparation');
    const inactivateIndex = fixture.calls.findIndex(([name, reason]) => name === 'inactivate' && reason === 'workspace-start-prepare');
    assert.ok(retireIndex >= 0, 'start inspects an outstanding preparation');
    assert.ok(inactivateIndex > retireIndex, 'the selector that binds a stopped start preparation is replaced only afterwards');
    const [, options] = fixture.calls[retireIndex];
    assert.equal(options.workspaceMutationLease, fixture.workspaceLease, 'the exact held workspace start lease authorizes retirement');
    assert.equal(options.networkLifecycleCapability, fixture.networkCapability);
});

test('a refused abandoned preparation stops workspace start before any selector, routing or graph mutation', async (t) => {
    const fixture = startFixture(t);
    const refusal = new Error('edge lifecycle preparation "workspace-graph-enable-prelaunch" (pid 686420) cannot be retired automatically: '
        + 'its exact inactive selector was replaced; stop the exact Box from its host workspace with `ploinky stop`, then run `ploinky start`, '
        + 'which retires the preparation while the Box is stopped');
    refusal.code = 'EDGE_PREPARATION_BUSY';
    fixture.collaborators.retireAbandonedWorkspaceStartPreparation = (options) => {
        fixture.calls.push(['retirePreparation', options]);
        throw refusal;
    };
    await assert.rejects(sandbox(fixture.collaborators)('repo/demo', '8080', {}), {
        message: /^start \(workspace\) failed: edge lifecycle preparation .*`ploinky stop`, then run `ploinky start`/,
    });
    const names = fixture.calls.map(([name]) => name);
    assert.ok(names.includes('retirePreparation'));
    for (const forbidden of ['inactivate', 'ensureGraphNodesEnabled', 'ensureAgentService', 'mergeRoutingConfig', 'abortPreparation']) {
        assert.equal(names.includes(forbidden), false, `${forbidden} must not run after the refusal`);
    }
    assert.deepEqual(fixture.calls.filter(([name]) => name === 'releaseLease'), [['releaseLease', true]]);
});

test('workspace start launches each graph runtime with its prepared registry record and the post-provider preparation lease', async (t) => {
    const fixture = startFixture(t);
    const run = sandbox(fixture.collaborators);
    await run('repo/demo', '8080', {});
    assert.deepEqual(fixture.calls.filter(([name]) => name === 'console.error'), []);
    const ensures = fixture.calls.filter(([name]) => name === 'ensureAgentService');
    assert.equal(ensures.length, 1, 'the graph runtime is ensured once');
    const [, agentName, , options] = ensures[0];
    assert.equal(agentName, 'demo');
    assert.equal(options.containerName, CONTAINER);
    assert.equal(options.preservePreparedRegistryRecord, true, 'workspace start preserves the prepared registry record');
    assert.equal(options.preparationLease, fixture.postProviderLease, 'the exact post-provider preparation lease authorizes the launch');
    assert.notEqual(options.preparationLease, fixture.earlyLease);
    assert.equal(options.instanceId, fixture.preparedRecord.instanceId, 'the prepared runtime identity is requested');
    assert.equal(options.enableGeneration, fixture.preparedRecord.enableGeneration);
    assert.equal(options.networkLifecycleCapability, fixture.networkCapability);
    assert.equal(options.forceRecreate, false);
    assert.deepEqual(fixture.calls.filter(([name]) => name === 'ensureBoundLease'), [['ensureBoundLease', true]],
        'the runtime is ensured inside the start operation that owns the workspace lease');

    // The same lease commits the graph, with the runtime's exact record.
    const commits = fixture.calls.filter(([name, opts]) => name === 'mergeRoutingConfig' && opts?.reason === 'workspace-runtime-graph-ready');
    assert.equal(commits.length, 1);
    assert.equal(commits[0][1].preparationLease, fixture.postProviderLease);
    assert.deepEqual(fixture.registry()[CONTAINER], fixture.ensureResult.registryRecord);
    assert.deepEqual(fixture.calls.filter(([name]) => name === 'abortPreparation'), [], 'the preparation was committed, not aborted');
    assert.deepEqual(fixture.calls.find(([name]) => name === 'collect'), ['collect', true, 'workspace-start']);
});

test('ensureAgentService keeps a prepared registry record only when asked to preserve it', (t) => {
    const w = wiringWorkspace(t, { prefix: 'depstore-preserve-' });
    const prepared = { ...registration(), instanceId: 'prepared-instance', enableGeneration: 'prepared-generation' };
    const preserved = stepValue(driveWiring(w, [
        { action: 'init-edge' },
        { action: 'register', containerName: CONTAINER, record: { ...prepared, projectPath: path.join(w.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'start', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true },
    ]), 'start');
    assert.equal(preserved.instanceId, prepared.instanceId, 'the prepared instance survives the launch');
    assert.equal(preserved.enableGeneration, prepared.enableGeneration);
    const stored = JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'))[CONTAINER];
    assert.equal(stored.instanceId, prepared.instanceId, 'the committed registry record is the prepared one');
    assert.equal(stored.enableGeneration, prepared.enableGeneration);

    // Negative control at the same boundary: without preservation, the
    // launch of a registered agent whose runtime is missing tries to re-mint
    // its identity with an unrelated generation apply, which the outstanding
    // workspace preparation denies. The prepared runtime is never launched.
    const other = wiringWorkspace(t, { prefix: 'depstore-rotate-' });
    const rotated = driveWiring(other, [
        { action: 'init-edge' },
        { action: 'register', containerName: CONTAINER, record: { ...prepared, projectPath: path.join(other.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'start', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, preserve: false, activate: true, allowFailure: true },
    ]);
    assert.equal(rotated.start.ok, false, JSON.stringify(rotated.start));
    assert.equal(rotated.start.code, 'EDGE_PREPARATION_BUSY', rotated.start.message);
    assert.deepEqual(Object.keys(other.engine.state().containers), [], 'no runtime was launched');
});
