import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    applyEdgeRoutingGeneration,
    assertActiveEdgeRoutingSourcesCurrent,
    captureEdgeRoutingLifecycleMutationGeneration,
    initializeFreshEdgeRoutingSources,
    loadActiveEdgeRoutingGeneration,
    prepareEdgeRoutingGeneration,
    readCurrentEdgeTopology,
} from '../../cli/sandbox/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';

function localDesired(overrides = {}) {
    return {
        hosts: {},
        ...overrides,
    };
}

function createFixture(t, {
    desired = localDesired(),
    alphaManifest = {
        routerAccess: {
            httpRoutes: [{
                path: '/base-agent-additional-server/alpha/7000/*',
                access: 'authenticated',
            }],
        },
    },
    policy = { schema: 'router-policy', httpRoutes: [], mcpTools: [] },
} = {}) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-generation-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const alphaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    const betaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'beta');
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.mkdirSync(policyDir, { recursive: true });
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });
    fs.writeFileSync(path.join(alphaDir, 'manifest.json'), JSON.stringify(alphaManifest, null, 2));
    fs.writeFileSync(path.join(betaDir, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'alpha', port: 7777 },
        routes: {
            alpha: {
                repo: 'fixtures',
                agent: 'alpha',
                container: 'alpha-container',
                hostPath: alphaDir,
                hostPort: 43101,
            },
            beta: {
                repo: 'fixtures',
                agent: 'beta',
                container: 'beta-container',
                hostPath: betaDir,
                hostPort: 43102,
            },
        },
    }, null, 2));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        'alpha-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'alpha',
            instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
            auth: { mode: 'local' },
        },
        'beta-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'beta',
            instanceId: 'beta-instance',
            enableGeneration: 'beta-enable-generation',
            auth: { mode: 'local' },
        },
    }, null, 2));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify(desired, null, 2));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify(policy, null, 2));

    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const previousRouterHostPort = process.env.PLOINKY_ROUTER_HOST_PORT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    t.after(() => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        if (previousRouterHostPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
        else process.env.PLOINKY_ROUTER_HOST_PORT = previousRouterHostPort;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    return { workspace, ploinkyDir, edgeDir, alphaDir };
}

test('fresh edge initialization creates unversioned empty desired state exactly once', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-fresh-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const initialized = initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    assert.equal(initialized.initialized, true);
    const desired = JSON.parse(fs.readFileSync(initialized.paths.desiredFile, 'utf8'));
    assert.deepEqual(desired, localDesired());
    assert.equal(Object.hasOwn(desired, 'schemaVersion'), false);
    assert.equal(initializeFreshEdgeRoutingSources({ workspaceRoot: workspace }).initialized, false);
});

test('active topology publishes routes and readiness without service locators or protocol versions', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'unversioned-convention-generation',
    });
    assert.equal(applied.selector.state, 'active');
    assert.equal(applied.selector.publicationState, 'ready');
    assert.equal(applied.topology.state, 'ready');
    assert.equal(Object.hasOwn(applied.topology, 'schemaVersion'), false);
    assert.equal(Object.hasOwn(applied.topology, 'services'), false);
    assert.equal(Object.hasOwn(applied.generation.compiled, 'services'), false);
    assert.equal(Object.hasOwn(applied.generation.compiled, 'localAliases'), false);
    assert.equal(Object.hasOwn(applied.generation.compiled, 'mounts'), false);
    assert.deepEqual(readCurrentEdgeTopology({
        workspaceRoot: fixture.workspace,
    }), applied.topology);
});

test('generation compiles convention access solely from HTTP route policy', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'private-convention-generation',
    });
    const policyEntry = applied.generation.compiled.policy.entries.find((entry) => (
        entry.path === '/base-agent-additional-server/alpha/7000/*'
    ));
    assert.equal(policyEntry.access, 'authenticated');
    assert.equal(Object.hasOwn(applied.generation.compiled.security, 'privateRouteConsumers'), false);
});

test('agent-mcp exposes only the selected root manifest dependency closure', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'explorer.example.test': {
                    agent: 'fixtures/alpha',
                    routerSurfaces: ['agent-mcp'],
                },
            },
            cloudflare: {
                tunnelTokenSecret: 'publication/test-connector',
            },
        },
        alphaManifest: {
            enable: ['beta global no-wait'],
        },
    });
    const routingFile = path.join(fixture.ploinkyDir, 'routing.json');
    const agentsFile = path.join(fixture.ploinkyDir, 'agents.json');
    const betaDir = path.join(fixture.ploinkyDir, 'repos', 'fixtures', 'beta');
    const gammaDir = path.join(fixture.ploinkyDir, 'repos', 'fixtures', 'gamma');
    const unrelatedDir = path.join(fixture.ploinkyDir, 'repos', 'fixtures', 'unrelated');
    fs.mkdirSync(gammaDir, { recursive: true });
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(path.join(betaDir, 'manifest.json'), JSON.stringify({
        enable: ['gamma global'],
    }, null, 2));
    fs.writeFileSync(path.join(gammaDir, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(unrelatedDir, 'manifest.json'), '{}');

    const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
    routing.routes.gamma = {
        repo: 'fixtures',
        agent: 'gamma',
        container: 'gamma-container',
        hostPath: gammaDir,
        hostPort: 43103,
    };
    routing.routes.unrelated = {
        repo: 'fixtures',
        agent: 'unrelated',
        container: 'unrelated-container',
        hostPath: unrelatedDir,
        hostPort: 43104,
    };
    fs.writeFileSync(routingFile, JSON.stringify(routing, null, 2));

    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    agents['gamma-container'] = {
        type: 'agent',
        repoName: 'fixtures',
        agentName: 'gamma',
        instanceId: 'gamma-instance',
        enableGeneration: 'gamma-enable-generation',
        auth: { mode: 'local' },
    };
    agents['unrelated-container'] = {
        type: 'agent',
        repoName: 'fixtures',
        agentName: 'unrelated',
        instanceId: 'unrelated-instance',
        enableGeneration: 'unrelated-enable-generation',
        auth: { mode: 'local' },
    };
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));

    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'agent-mcp-dependency-closure',
        publicationState: 'ready',
    });
    assert.deepEqual(
        applied.generation.compiled.agentMcpRoutes['explorer.example.test'],
        ['alpha', 'beta', 'gamma'],
    );

    const rootMcp = resolveEdgeRoutePlan({
        req: {
            method: 'POST',
            url: '/mcp',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(rootMcp.ok, true);
    assert.equal(rootMcp.routeKey, 'alpha');
    assert.equal(rootMcp.upstreamPath, '/mcp');

    const dependencyMcp = resolveEdgeRoutePlan({
        req: {
            method: 'POST',
            url: '/beta/mcp',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(dependencyMcp.ok, true);
    assert.equal(dependencyMcp.kind, 'agent-root');
    assert.equal(dependencyMcp.routeKey, 'beta');
    assert.equal(dependencyMcp.upstreamPath, '/mcp');

    const dependencyContent = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/beta/index.html',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(dependencyContent.ok, true);
    assert.equal(dependencyContent.routeKey, 'alpha');
    assert.equal(dependencyContent.upstreamPath, '/beta/index.html');

    const transitiveDependencyMcp = resolveEdgeRoutePlan({
        req: {
            method: 'POST',
            url: '/gamma/mcp',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(transitiveDependencyMcp.ok, true);
    assert.equal(transitiveDependencyMcp.routeKey, 'gamma');
    assert.equal(transitiveDependencyMcp.upstreamPath, '/mcp');

    const unrelatedMcp = resolveEdgeRoutePlan({
        req: {
            method: 'POST',
            url: '/unrelated/mcp',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(unrelatedMcp.ok, true);
    assert.equal(unrelatedMcp.routeKey, 'alpha');
    assert.equal(unrelatedMcp.upstreamPath, '/unrelated/mcp');
});

test('legacy duplicate route and host-network authority is rejected', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {},
            security: {
                hostNetworkAllowedInstances: ['fixtures/alpha'],
                privateRouteConsumers: {},
            },
        },
    });
    assert.throws(() => prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'reject-duplicate-authority',
    }), /unsupported field 'security'/);
});

test('legacy manifest service inventory is rejected instead of silently retained', (t) => {
    const fixture = createFixture(t, {
        alphaManifest: {
            httpServices: [{
                slug: 'legacy',
                port: 7000,
            }],
        },
    });
    assert.throws(
        () => applyEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            reason: 'legacy-service-rejection',
        }),
        /httpServices is unsupported.*agent-port convention/i,
    );
});

test('durable preparation remains inactive until its exact lease commits', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'runtime-preparation',
    });
    assert.equal(prepared.selector.state, 'inactive');
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
    const committed = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'runtime-commit',
        preparationLease: prepared.preparationLease,
    });
    assert.equal(committed.selector.state, 'active');
    assert.equal(committed.selector.generation, prepared.selector.generation);
});

test('live source drift is rejected without inactivating the selected generation', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'source-drift-baseline',
    });
    fs.writeFileSync(path.join(fixture.alphaDir, 'manifest.json'), JSON.stringify({
        routerAccess: { httpRoutes: [] },
    }, null, 2));

    assert.throws(
        () => assertActiveEdgeRoutingSourcesCurrent({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_SOURCE_CHANGED' },
    );
    const stillActive = loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace });
    assert.equal(stillActive.selector.generation, applied.selector.generation);
    assert.equal(stillActive.selector.activationId, applied.selector.activationId);
});

test('runtime locator mutation remains bound to the launch generation lifecycle', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'runtime-locator-baseline',
    });
    const routingFile = path.join(fixture.ploinkyDir, 'routing.json');
    const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
    routing.routes.alpha.hostPort = 43199;
    fs.writeFileSync(routingFile, JSON.stringify(routing, null, 2));
    const agentsFile = path.join(fixture.ploinkyDir, 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    agents['alpha-container'].containerId = 'runtime-alpha';
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));

    const candidate = captureEdgeRoutingLifecycleMutationGeneration(applied, {
        workspaceRoot: fixture.workspace,
    });
    assert.match(candidate, /^sha256:[a-f0-9]{64}$/);

    fs.writeFileSync(path.join(fixture.alphaDir, 'manifest.json'), JSON.stringify({
        routerAccess: { httpRoutes: [] },
    }, null, 2));
    assert.throws(
        () => captureEdgeRoutingLifecycleMutationGeneration(applied, {
            workspaceRoot: fixture.workspace,
        }),
        { code: 'EDGE_GENERATION_SOURCE_CHANGED' },
    );
});

test('connector-only desired state compiles as Cloudflare reconciling and preserves exact hosts', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'office.example.test': {
                    agent: 'fixtures/alpha',
                },
            },
            cloudflare: {
                tunnelTokenSecret: 'publication/cloudflare-connector',
            },
        },
    });
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'connector-only-generation',
    });
    assert.deepEqual(applied.generation.compiled.publication, {
        mode: 'cloudflare',
        management: 'connector-only',
        defaultState: 'reconciling',
        complete: true,
    });
    assert.equal(applied.selector.publicationState, 'reconciling');
    assert.equal(applied.topology.state, 'reconciling');
    assert.deepEqual(Object.keys(applied.generation.compiled.hosts), ['office.example.test']);
});

test('complete API-managed desired state with no hosts compiles as an explicit teardown', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {},
            cloudflare: {
                accountId: 'account_123',
                zoneId: 'zone_123',
                tunnelId: 'tunnel_123',
                tunnelTokenSecret: 'publication/cloudflare-connector',
                apiTokenSecret: 'publication/cloudflare-api',
            },
        },
    });
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'api-managed-teardown-generation',
    });
    assert.deepEqual(applied.generation.compiled.publication, {
        mode: 'cloudflare',
        management: 'api-managed',
        defaultState: 'reconciling',
        complete: true,
    });
    assert.equal(applied.selector.publicationState, 'reconciling');
    assert.equal(applied.topology.state, 'reconciling');
    assert.deepEqual(applied.generation.compiled.hosts, {});
});

test('Ploinky-managed tunnel desired state compiles without a connector-token handle', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'office.example.test': {
                    agent: 'fixtures/alpha',
                },
            },
            cloudflare: {
                accountId: 'account_123',
                zoneId: 'zone_123',
                tunnelName: 'explorer-qa',
                apiTokenSecret: 'publication/cloudflare-api',
                deleteTunnelOnTeardown: true,
            },
        },
    });
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'managed-tunnel-generation',
    });
    assert.deepEqual(applied.generation.compiled.publication, {
        mode: 'cloudflare',
        management: 'api-managed',
        defaultState: 'reconciling',
        complete: true,
    });
    assert.equal(applied.selector.publicationState, 'reconciling');
    assert.deepEqual(applied.generation.desired.cloudflare, {
        accountId: 'account_123',
        zoneId: 'zone_123',
        tunnelName: 'explorer-qa',
        apiTokenSecret: 'publication/cloudflare-api',
        deleteTunnelOnTeardown: true,
    });
});

test('Ploinky-managed tunnel with no hosts compiles as an explicit teardown', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {},
            cloudflare: {
                accountId: 'account_123',
                zoneId: 'zone_123',
                tunnelName: 'explorer-qa',
                apiTokenSecret: 'publication/cloudflare-api',
                deleteTunnelOnTeardown: true,
            },
        },
    });
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'managed-tunnel-teardown-generation',
    });
    assert.deepEqual(applied.generation.compiled.publication, {
        mode: 'cloudflare',
        management: 'api-managed',
        defaultState: 'reconciling',
        complete: true,
    });
    assert.deepEqual(applied.generation.compiled.hosts, {});
});

test('partial connector/API desired state remains in fail-closed error publication', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'office.example.test': {
                    agent: 'fixtures/alpha',
                },
            },
            cloudflare: {
                tunnelTokenSecret: 'publication/cloudflare-connector',
                accountId: 'account_123',
            },
        },
    });
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'partial-cloudflare-generation',
    });
    assert.deepEqual(applied.generation.compiled.publication, {
        mode: 'error',
        management: null,
        defaultState: 'error',
        complete: false,
    });
    assert.equal(applied.selector.publicationState, 'error');
    assert.equal(applied.topology.state, 'error');
});
