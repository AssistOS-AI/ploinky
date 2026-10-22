import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const originalRouterHostPort = process.env.PLOINKY_ROUTER_HOST_PORT;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-enable-batch-'));
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '8080';
process.env.PLOINKY_MASTER_KEY = '8'.repeat(64);

function writeManifest(repo, agent, manifest) {
    const directory = path.join(workspace, '.ploinky', 'repos', repo, agent);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

writeManifest('demo', 'nonHostDependency', {
    container: 'node:20-alpine',
    network: { mode: 'default' },
});
writeManifest('demo', 'staticRoot', {
    container: 'node:20-alpine',
    network: { mode: 'default' },
});
writeManifest('media', 'livekit', {
    container: 'node:20-alpine',
    network: { mode: 'host' },
});

// Import one shared module graph. The prepared host capability is deliberately
// opaque and module-local, so query-string copies would create unrelated
// capability registries that production never uses.
const edge = await import(new URL('../../cli/sandbox/edgeGeneration.js', import.meta.url).href);
const routing = await import(new URL('../../cli/server/routingFile.js', import.meta.url).href);
const agents = await import(new URL('../../cli/utils/agents.js', import.meta.url).href);
const manager = await import(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url).href);
const coordinated = await import(new URL('../../cli/sandbox/coordinatedEdgeApply.js', import.meta.url).href);

test.after(() => {
    process.chdir(originalCwd);
    if (originalWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalWorkspaceRoot;
    if (originalRouterHostPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
    else process.env.PLOINKY_ROUTER_HOST_PORT = originalRouterHostPort;
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('explicit auth options cannot disable a manifest-required identity provider', () => {
    edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    routing.writeRoutingConfig({ port: 8080, routes: {} }, { coordinate: false });
    writeManifest('demo', 'ssoApp', {
        container: 'node:20-alpine', network: { mode: 'default' }, ploinky: 'sso enable',
        sso: { providerAgent: 'identity' },
    });
    for (const authModeParam of ['none', 'guest']) {
        assert.throws(() => agents.prepareAgentEnableBatch([
            { agentName: 'demo/ssoApp', mode: 'global', authModeParam },
        ]), /Manifest requires SSO authentication/);
    }
});

test('enable rejects retired local authentication declarations and options before staging', () => {
    const initialized = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    const selectorBefore = fs.readFileSync(initialized.paths.activeSelectorFile, 'utf8');
    const registryBefore = fs.readFileSync(initialized.paths.agentsFile, 'utf8');
    for (const authModeParam of ['local', 'pwd']) {
        assert.throws(() => agents.prepareAgentEnableBatch([
            { agentName: 'demo/nonHostDependency', authModeParam },
        ]), /Local password authentication is no longer supported/);
    }
    for (const authOptions of [{ username: 'example' }, { password: 'example' }]) {
        assert.throws(() => agents.prepareAgentEnableBatch([
            { agentName: 'demo/nonHostDependency', authOptions },
        ]), /Local password authentication options are no longer supported/);
    }
    for (const retiredDeclaration of [{ ploinky: 'pwd enable' }, { pwd: { users: [] } }]) {
        writeManifest('demo', 'retiredAuthApp', {
            container: 'node:20-alpine', network: { mode: 'default' }, ...retiredDeclaration,
        });
        assert.throws(() => agents.prepareAgentEnableBatch([
            { agentName: 'demo/retiredAuthApp' },
        ]), /Local password authentication is no longer supported/);
    }
    assert.equal(fs.readFileSync(initialized.paths.activeSelectorFile, 'utf8'), selectorBefore);
    assert.equal(fs.readFileSync(initialized.paths.agentsFile, 'utf8'), registryBefore);
});

test('one batch stages a non-host dependency and exact host owner before either can launch', () => {
    const initialized = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    routing.writeRoutingConfig({ port: 8080, routes: {} }, { coordinate: false });
    fs.writeFileSync(initialized.paths.desiredFile, JSON.stringify({
        hosts: {},
    }));

    let retirementEntries = null;
    const prepared = agents.prepareAgentEnableBatch([
        { agentName: 'demo/nonHostDependency', mode: 'global' },
        { agentName: 'media/livekit', mode: 'global' },
    ], {
        reason: 'test-complete-graph-prelaunch',
        retireNoWaitMarkers(entries) {
            retirementEntries = structuredClone(entries);
            return [];
        },
    });

    assert.equal(prepared.plans.length, 2);
    const predecessorRegistry = JSON.parse(fs.readFileSync(initialized.paths.agentsFile, 'utf8'));
    const predecessorRouting = JSON.parse(fs.readFileSync(initialized.paths.routingFile, 'utf8'));
    const registry = prepared.preparedGeneration.generation.agents;
    const routingState = prepared.preparedGeneration.generation.routing;
    const nonHostPlan = prepared.plans.find((plan) => plan.shortAgentName === 'nonHostDependency');
    const hostPlan = prepared.plans.find((plan) => plan.shortAgentName === 'livekit');
    assert.ok(nonHostPlan);
    assert.ok(hostPlan);
    assert.deepEqual(
        retirementEntries.slice().sort(),
        prepared.plans.map((plan) => plan.containerName).sort(),
        'fresh enables retire secure orphan markers before publishing new registry tuples',
    );
    for (const plan of prepared.plans) {
        assert.equal(Object.hasOwn(routingState.routes[plan.routeKey], 'hostPort'), false);
        assert.equal(Object.hasOwn(routingState.routes[plan.routeKey], 'serviceTargets'), false);
        assert.equal(registry[plan.containerName].instanceId, plan.instanceId);
        assert.equal(registry[plan.containerName].enableGeneration, plan.enableGeneration);
        assert.equal(Object.hasOwn(predecessorRegistry, plan.containerName), false);
        assert.equal(Object.hasOwn(predecessorRouting.routes, plan.routeKey), false);
    }

    // Prelaunch compilation is immutable while the predecessor remains active.
    // The exact host owner receives only a lease-bound capability for process
    // creation; normal route authorization cannot activate until readiness.
    assert.equal(manager.assertPreparedRegistryRecordPreservation(
        registry[nonHostPlan.containerName],
        {
            preservePreparedRegistryRecord: true,
            instanceId: nonHostPlan.instanceId,
            enableGeneration: nonHostPlan.enableGeneration,
        },
        { ownerRef: 'demo/nonHostDependency' },
    ), true);
    assert.doesNotThrow(() => edge.assertHostModeGenerationCapability({
        agentId: 'agent:media/livekit',
        instanceId: hostPlan.instanceId,
        enableGeneration: hostPlan.enableGeneration,
        routeKey: hostPlan.routeKey,
        containerName: hostPlan.containerName,
    }, { preparedCapability: hostPlan.preparedHostModeCapability }));
    assert.throws(() => edge.assertHostModeGenerationCapability({
        agentId: 'agent:media/livekit',
        instanceId: hostPlan.instanceId,
        enableGeneration: hostPlan.enableGeneration,
        routeKey: `${hostPlan.routeKey}-other`,
        containerName: hostPlan.containerName,
    }, { preparedCapability: hostPlan.preparedHostModeCapability }), { code: 'HOST_MODE_CAPABILITY_DENIED' });

    const selector = JSON.parse(fs.readFileSync(initialized.paths.activeSelectorFile, 'utf8'));
    assert.equal(selector.state, 'active');
    assert.equal(selector.generation, prepared.preparedGeneration.preparationLease.predecessorGeneration);
    assert.doesNotThrow(() => edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }));
    assert.deepEqual(prepared.preparedGeneration.generation.compiled.security.hostNetworkCapabilities, [{
        agentId: 'agent:media/livekit',
        instanceId: hostPlan.instanceId,
        enableGeneration: hostPlan.enableGeneration,
        routeKey: hostPlan.routeKey,
        containerName: hostPlan.containerName,
    }]);

    edge.withEdgeGenerationApplyLock((applyLockCapability) => edge.commitAdditiveEdgeRoutingGeneration(
        prepared.preparedGeneration.preparationLease,
        {
            routing: routingState,
            agents: registry,
            applyLockCapability,
        },
    ), {
        preparationLease: prepared.preparedGeneration.preparationLease,
    });
    assert.doesNotThrow(() => edge.assertHostModeGenerationCapability({
        agentId: 'agent:media/livekit',
        instanceId: hostPlan.instanceId,
        enableGeneration: hostPlan.enableGeneration,
        routeKey: hostPlan.routeKey,
        containerName: hostPlan.containerName,
    }), 'the committed target-less graph must authorize its exact no-wait host runtime');
});

test('a configured static agent stages the workspace root as its immutable project path', () => {
    const initialized = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    fs.writeFileSync(
        path.join(workspace, '.ploinky', 'repos', 'demo', 'staticRoot', 'mcp-config.json'),
        JSON.stringify({
            tools: [{
                name: 'inspect_workspace',
                tags: ['admin'],
            }],
        }, null, 2),
    );
    const registry = JSON.parse(fs.readFileSync(initialized.paths.agentsFile, 'utf8'));
    registry._config = {
        static: {
            agent: 'staticRoot',
            port: 8080,
        },
    };
    fs.writeFileSync(initialized.paths.agentsFile, JSON.stringify(registry, null, 2));
    coordinated.applyEdgeRoutingGeneration({ reason: 'test-static-config-baseline' });

    const prepared = agents.prepareAgentEnableBatch([
        { agentName: 'demo/staticRoot' },
    ], { reason: 'test-static-workspace-root-prelaunch' });

    const [plan] = prepared.plans;
    assert.equal(plan.record.projectPath, workspace);
    assert.equal(
        prepared.preparedGeneration.generation.agents[plan.containerName].projectPath,
        workspace,
    );
    assert.deepEqual(
        prepared.preparedGeneration.generation.policy.mcpTools
            .filter((entry) => entry.agent === 'staticRoot')
            .map(({ agent, tool, access, source, enabled }) => ({ agent, tool, access, source, enabled })),
        [{
            agent: 'staticRoot',
            tool: 'inspect_workspace',
            access: 'admin',
            source: 'mcp-config',
            enabled: true,
        }],
    );
    edge.withEdgeGenerationApplyLock((applyLockCapability) => edge.commitAdditiveEdgeRoutingGeneration(
        prepared.preparedGeneration.preparationLease,
        { applyLockCapability },
    ), {
        preparationLease: prepared.preparedGeneration.preparationLease,
    });
});

test('a later batch validation failure cannot mutate the active generation', () => {
    const selectorBefore = fs.readFileSync(edge.resolveEdgeGenerationPaths({ workspaceRoot: workspace }).activeSelectorFile, 'utf8');
    assert.equal(JSON.parse(selectorBefore).state, 'active');

    assert.throws(() => agents.prepareAgentEnableBatch([
        {
            agentName: 'demo/nonHostDependency',
            mode: 'global',
            aliasParam: 'same-alias',
            authModeParam: 'sso',
        },
        {
            agentName: 'media/livekit',
            mode: 'global',
            aliasParam: 'same-alias',
        },
    ], { reason: 'test-invalid-auth-batch' }), /alias already exists/);

    assert.equal(
        fs.readFileSync(edge.resolveEdgeGenerationPaths({ workspaceRoot: workspace }).activeSelectorFile, 'utf8'),
        selectorBefore,
    );
});

test('same-name retirement failure occurs before any routing change or candidate source persistence', () => {
    const initialized = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    const registryBefore = fs.readFileSync(initialized.paths.agentsFile, 'utf8');
    const routingBefore = fs.readFileSync(initialized.paths.routingFile, 'utf8');
    let retirementEntries = null;

    assert.throws(() => agents.prepareAgentEnableBatch([
        { agentName: 'demo/nonHostDependency', mode: 'global' },
    ], {
        reason: 'test-same-name-retirement-failure',
        retireNoWaitMarkers(entries) {
            retirementEntries = structuredClone(entries);
            throw new Error('test marker retirement failed');
        },
    }), /test marker retirement failed/);

    assert.equal(retirementEntries.length, 1);
    const predecessorRegistry = JSON.parse(registryBefore);
    assert.deepEqual(
        predecessorRegistry[retirementEntries[0].containerName],
        retirementEntries[0].record,
    );
    assert.equal(retirementEntries[0].record.type, 'agent');
    assert.equal(fs.readFileSync(initialized.paths.agentsFile, 'utf8'), registryBefore);
    assert.equal(fs.readFileSync(initialized.paths.routingFile, 'utf8'), routingBefore);
    const selector = JSON.parse(fs.readFileSync(initialized.paths.activeSelectorFile, 'utf8'));
    assert.equal(selector.state, 'active', 'a refused retirement neither withdraws nor inactivates anything');

    // Restore the unchanged predecessor sources as the active baseline so the
    // following successful replacement test begins from a valid generation.
    coordinated.applyEdgeRoutingGeneration({ reason: 'test-retirement-failure-baseline-restore' });
});

test('same-name re-enable replaces only the runtime identity beside its drained active predecessor', () => {
    let retirementEntries = null;
    const before = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    const prepared = agents.prepareAgentEnableBatch([
        { agentName: 'demo/nonHostDependency', mode: 'global' },
    ], {
        reason: 'test-same-name-replacement',
        retireNoWaitMarkers(entries) {
            retirementEntries = structuredClone(entries);
            return [];
        },
    });

    const [plan] = prepared.plans;
    assert.equal(prepared.availabilityMode, 'withdrawn');
    assert.equal(prepared.preparedGeneration.preparationLease.mode, 'withdrawn');
    assert.equal(prepared.preparedGeneration.selector.state, 'active');
    const active = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    const predecessor = before.generation.agents[plan.containerName];
    const drained = active.generation.routing.routes[plan.routeKey];
    assert.equal(drained.draining, true, 'only the replaced runtime is withdrawn');
    assert.equal(drained.hostPort, undefined);
    assert.deepEqual(drained.drainOwner, {
        containerName: plan.containerName,
        instanceId: predecessor.instanceId,
        enableGeneration: predecessor.enableGeneration,
        reason: 'replacement',
    });
    for (const [routeKey, route] of Object.entries(before.generation.routing.routes)) {
        if (routeKey !== plan.routeKey) assert.deepEqual(active.generation.routing.routes[routeKey], route);
    }
    assert.equal(active.generation.agents[plan.containerName].instanceId, predecessor.instanceId,
        'the predecessor identity stays registered until the replacement commits');
    assert.equal(prepared.preparedGeneration.generation.agents[plan.containerName].instanceId, plan.instanceId);
    assert.equal(retirementEntries.length, 1);
    assert.equal(retirementEntries[0].containerName, plan.containerName);
    assert.notEqual(
        retirementEntries[0].record.enableGeneration,
        plan.enableGeneration,
        'the retired marker constraint must name the predecessor generation',
    );
    edge.abortEdgeRoutingPreparation(prepared.preparedGeneration.preparationLease, {
        reason: 'test-same-name-replacement-complete',
    });
    assert.equal(edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }).selector.state, 'active');
});

test('same-name re-enable that changes more than the identity uses fail-closed replacement', () => {
    const manifestPath = path.join(workspace, '.ploinky', 'repos', 'demo', 'nonHostDependency', 'manifest.json');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    writeManifest('demo', 'nonHostDependency', {
        container: 'node:20-alpine',
        network: { mode: 'default' },
        about: 'changed manifest bytes',
    });
    let prepared;
    try {
        prepared = agents.prepareAgentEnableBatch([
            { agentName: 'demo/nonHostDependency', mode: 'global' },
        ], { reason: 'test-same-name-fallback-replacement', retireNoWaitMarkers: () => [] });
        assert.equal(prepared.availabilityMode, 'replacement');
        assert.equal(prepared.preparedGeneration.preparationLease.mode, 'replacement');
        assert.equal(prepared.preparedGeneration.selector.state, 'inactive');
        assert.throws(
            () => edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }),
            { code: 'EDGE_GENERATION_INACTIVE' },
        );
    } finally {
        if (prepared) {
            edge.abortEdgeRoutingPreparation(prepared.preparedGeneration.preparationLease, {
                reason: 'test-same-name-fallback-replacement-complete',
            });
        }
        fs.writeFileSync(manifestPath, manifestBefore);
    }
});

for (const requests of [[], [{ agentName: 'demo/staticRoot' }]]) {
    test(`replacement batch persists a private complete policy without direct overwrite (${requests.length} requests)`, (t) => {
        const { paths } = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
        const previousPolicy = fs.readFileSync(paths.policyFile, 'utf8');
        const originalWrite = fs.writeFileSync;
        const originalRename = fs.renameSync;
        let replacements = 0;
        t.mock.method(fs, 'writeFileSync', (file, ...args) => {
            if (file === paths.policyFile) {
                throw Object.assign(new Error('shared filesystem rejects direct policy overwrite'), { code: 'EBADF' });
            }
            return originalWrite(file, ...args);
        });
        t.mock.method(fs, 'renameSync', (source, destination) => {
            if (destination === paths.policyFile) {
                replacements += 1;
                assert.equal(fs.readFileSync(paths.policyFile, 'utf8'), previousPolicy);
                assert.equal(fs.statSync(source).mode & 0o777, 0o600);
                assert.equal(JSON.parse(fs.readFileSync(source, 'utf8')).schema, 'router-policy');
                assert.equal(JSON.parse(fs.readFileSync(paths.activeSelectorFile, 'utf8')).state, 'inactive');
            }
            return originalRename(source, destination);
        });

        let prepared;
        try {
            prepared = agents.prepareAgentEnableBatch(requests, { availabilityMode: 'replacement' });
            const { generation, preparationLease } = prepared.preparedGeneration;
            const policy = JSON.parse(fs.readFileSync(paths.policyFile, 'utf8'));
            assert.equal(replacements, 1);
            assert.equal(fs.statSync(paths.policyFile).mode & 0o777, 0o600);
            assert.deepEqual(policy, generation.policy);
            assert.deepEqual(policy, JSON.parse(previousPolicy));
            assert.ok(policy.mcpTools.some((entry) => entry.agent === 'staticRoot' && entry.tool === 'inspect_workspace'));
            const selector = JSON.parse(fs.readFileSync(paths.activeSelectorFile, 'utf8'));
            assert.equal(selector.state, 'inactive');
            assert.equal(preparationLease.mode, 'replacement');
            assert.equal(preparationLease.preparedGeneration, selector.generation);
            assert.equal(preparationLease.selectorActivationId, selector.activationId);
            assert.equal(preparationLease.selectorDigest, selector.selectorDigest);
            const persistedLease = JSON.parse(fs.readFileSync(paths.preparationLeaseFile, 'utf8'));
            for (const [key, value] of Object.entries(preparationLease)) assert.equal(persistedLease[key], value);
            assert.throws(() => edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }), {
                code: 'EDGE_GENERATION_INACTIVE',
            });
        } finally {
            if (prepared) edge.abortEdgeRoutingPreparation(prepared.preparedGeneration.preparationLease);
        }
        assert.equal(fs.existsSync(paths.preparationLeaseFile), false);
        assert.equal(JSON.parse(fs.readFileSync(paths.activeSelectorFile, 'utf8')).state, 'inactive');
        assert.deepEqual(fs.readdirSync(path.dirname(paths.policyFile)).filter((name) => name.endsWith('.tmp')), []);
    });
}

test('replacement policy rename failure preserves the previous policy and removes the temporary file', (t) => {
    const { paths } = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    const previousPolicy = fs.readFileSync(paths.policyFile, 'utf8');
    const generationsBefore = fs.readdirSync(paths.generationsDir).sort();
    const originalRename = fs.renameSync;
    let temporaryFile;
    t.mock.method(fs, 'renameSync', (source, destination) => {
        if (destination === paths.policyFile) {
            temporaryFile = source;
            assert.equal(fs.statSync(source).mode & 0o777, 0o600);
            assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), JSON.parse(previousPolicy));
            throw Object.assign(new Error('injected policy replacement failure'), { code: 'EIO' });
        }
        return originalRename(source, destination);
    });

    assert.throws(() => agents.prepareAgentEnableBatch([], { availabilityMode: 'replacement' }), {
        code: 'EIO',
        message: 'prepare agent enable batch: candidate generation rejected: injected policy replacement failure',
    });
    assert.ok(temporaryFile);
    assert.equal(fs.existsSync(temporaryFile), false);
    assert.equal(fs.readFileSync(paths.policyFile, 'utf8'), previousPolicy);
    assert.equal(fs.statSync(paths.policyFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(paths.activeSelectorFile, 'utf8')).state, 'inactive');
    assert.equal(fs.existsSync(paths.preparationLeaseFile), false);
    assert.deepEqual(fs.readdirSync(paths.generationsDir).sort(), generationsBefore);
    assert.deepEqual(fs.readdirSync(path.dirname(paths.policyFile)).filter((name) => name.endsWith('.tmp')), []);
});
