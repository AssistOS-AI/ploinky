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
const passwordStore = await import(new URL('../../cli/utils/security/encryptedPasswordStore.js', import.meta.url).href);

test.after(() => {
    process.chdir(originalCwd);
    if (originalWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalWorkspaceRoot;
    if (originalRouterHostPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
    else process.env.PLOINKY_ROUTER_HOST_PORT = originalRouterHostPort;
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('one batch stages a non-host dependency and exact host owner before either can launch', () => {
    const initialized = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    routing.writeRoutingConfig({ port: 8080, routes: {} }, { coordinate: false });
    fs.writeFileSync(initialized.paths.desiredFile, JSON.stringify({
        schemaVersion: edge.EDGE_DESIRED_SCHEMA_VERSION,
        hosts: {},
        security: {
            hostNetworkAllowedInstances: ['media/livekit'],
            internalServiceConsumers: {},
        },
    }));

    const prepared = agents.prepareAgentEnableBatch([
        { agentName: 'demo/nonHostDependency', mode: 'global' },
        { agentName: 'media/livekit', mode: 'global' },
    ], { reason: 'test-complete-graph-prelaunch' });

    assert.equal(prepared.plans.length, 2);
    const registry = JSON.parse(fs.readFileSync(initialized.paths.agentsFile, 'utf8'));
    const routingState = JSON.parse(fs.readFileSync(initialized.paths.routingFile, 'utf8'));
    const nonHostPlan = prepared.plans.find((plan) => plan.shortAgentName === 'nonHostDependency');
    const hostPlan = prepared.plans.find((plan) => plan.shortAgentName === 'livekit');
    assert.ok(nonHostPlan);
    assert.ok(hostPlan);
    for (const plan of prepared.plans) {
        assert.equal(Object.hasOwn(routingState.routes[plan.routeKey], 'hostPort'), false);
        assert.equal(Object.hasOwn(routingState.routes[plan.routeKey], 'serviceTargets'), false);
        assert.equal(registry[plan.containerName].instanceId, plan.instanceId);
        assert.equal(registry[plan.containerName].enableGeneration, plan.enableGeneration);
    }

    // Prelaunch compilation is immutable but inactive. The exact host owner
    // receives only a selector-bound capability for process creation; normal
    // route authorization cannot activate until readiness succeeds.
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
    assert.equal(selector.state, 'inactive');
    assert.throws(
        () => edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
    assert.deepEqual(prepared.preparedGeneration.generation.compiled.security.hostNetworkCapabilities, [{
        agentId: 'agent:media/livekit',
        instanceId: hostPlan.instanceId,
        enableGeneration: hostPlan.enableGeneration,
        routeKey: hostPlan.routeKey,
        containerName: hostPlan.containerName,
    }]);

    coordinated.applyEdgeRoutingGeneration({
        reason: 'test-complete-graph-ready',
        preparationLease: prepared.preparedGeneration.preparationLease,
    });
});

test('a later batch validation failure cannot mutate credentials consumed by the active generation', () => {
    const usersVar = 'PLOINKY_AUTH_LOCAL_ONE_USERS';
    passwordStore.setUsersPayload(usersVar, {
        version: 1,
        users: [{
            id: 'local:existing',
            username: 'existing',
            name: 'Existing',
            email: null,
            passwordHash: 'scrypt$unchanged',
            roles: ['local', 'admin'],
            rev: 7,
        }],
    });
    const storeBefore = fs.readFileSync(passwordStore.PASSWORD_STORE_FILE, 'utf8');
    const selectorBefore = fs.readFileSync(edge.resolveEdgeGenerationPaths({ workspaceRoot: workspace }).activeSelectorFile, 'utf8');
    assert.equal(JSON.parse(selectorBefore).state, 'active');

    assert.throws(() => agents.prepareAgentEnableBatch([
        {
            agentName: 'demo/nonHostDependency',
            mode: 'global',
            aliasParam: 'local-one',
            authModeParam: 'local',
            authOptions: { username: 'replacement', password: 'replacement-password' },
        },
        {
            agentName: 'media/livekit',
            mode: 'global',
            aliasParam: 'local-one',
        },
    ], { reason: 'test-invalid-auth-batch' }), /alias already exists/);

    assert.equal(fs.readFileSync(passwordStore.PASSWORD_STORE_FILE, 'utf8'), storeBefore);
    assert.equal(
        fs.readFileSync(edge.resolveEdgeGenerationPaths({ workspaceRoot: workspace }).activeSelectorFile, 'utf8'),
        selectorBefore,
    );
});
