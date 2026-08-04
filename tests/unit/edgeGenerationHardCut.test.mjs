import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    abortEdgeRoutingPreparation,
    applyEdgeRoutingGeneration,
    assertActiveEdgeRoutingSourcesCurrent,
    assertPreparedRuntimeIdentity,
    captureEdgeRoutingLifecycleMutationGeneration,
    captureEdgeRoutingObservationLease,
    commitAdditiveEdgeRoutingGeneration,
    createRouterAttestationGenerationLease,
    initializeFreshEdgeRoutingSources,
    loadActiveEdgeRoutingGeneration,
    prepareAdditiveEdgeRoutingGeneration,
    prepareEdgeRoutingGeneration,
    readCurrentEdgeTopology,
    withEdgeGenerationApplyLock,
} from '../../cli/sandbox/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { serviceOwnerKey } from '../../cli/sandbox/bwrap/bwrapFleet.js';

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function compiledDigest(compiled) {
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(compiled))).digest('hex')}`;
}

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

test('additive preparation and failed commit preserve the exact active predecessor', (t) => {
    const fixture = createFixture(t);
    const predecessor = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'additive-predecessor',
    });
    const selectorBefore = fs.readFileSync(predecessor.paths.activeSelectorFile);
    const routingBefore = fs.readFileSync(predecessor.paths.routingFile);
    const topologyBefore = fs.readFileSync(predecessor.paths.topologyCurrentFile);
    const candidateRouting = structuredClone(predecessor.generation.routing);
    candidateRouting.routes.alpha.hostPort = 45101;
    let prepared;
    withEdgeGenerationApplyLock((applyLockCapability) => {
        prepared = prepareAdditiveEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            routing: candidateRouting,
            applyLockCapability,
            reason: 'additive-runtime-candidate',
        });
    }, { workspaceRoot: fixture.workspace });

    assert.deepEqual(fs.readFileSync(predecessor.paths.activeSelectorFile), selectorBefore);
    assert.deepEqual(fs.readFileSync(predecessor.paths.routingFile), routingBefore);
    assert.equal(prepared.preparationLease.predecessorGeneration, predecessor.selector.generation);

    let callbackState = 'predecessor';
    assert.throws(() => withEdgeGenerationApplyLock((applyLockCapability) => (
        commitAdditiveEdgeRoutingGeneration(prepared.preparationLease, {
            workspaceRoot: fixture.workspace,
            routing: candidateRouting,
            applyLockCapability,
            beforeSelectorCommit() {
                callbackState = 'candidate';
                return () => { callbackState = 'predecessor'; };
            },
            testHooks: {
                afterBeforeSelectorCommit() { throw new Error('readiness revoked'); },
            },
        })
    ), {
        workspaceRoot: fixture.workspace,
        preparationLease: prepared.preparationLease,
    }), /readiness revoked/);
    assert.deepEqual(fs.readFileSync(predecessor.paths.activeSelectorFile), selectorBefore);
    assert.deepEqual(fs.readFileSync(predecessor.paths.routingFile), routingBefore);
    assert.deepEqual(fs.readFileSync(predecessor.paths.topologyCurrentFile), topologyBefore);
    assert.equal(callbackState, 'predecessor');
    assert.equal(loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).selector.generation,
        predecessor.selector.generation);
    abortEdgeRoutingPreparation(prepared.preparationLease, { workspaceRoot: fixture.workspace });
});

test('additive commit rejects manifest byte drift without changing active routing', (t) => {
    const fixture = createFixture(t);
    const predecessor = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'manifest-drift-predecessor',
    });
    const selectorBefore = fs.readFileSync(predecessor.paths.activeSelectorFile);
    const routingBefore = fs.readFileSync(predecessor.paths.routingFile);
    let prepared;
    withEdgeGenerationApplyLock((applyLockCapability) => {
        prepared = prepareAdditiveEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            routing: predecessor.generation.routing,
            agents: predecessor.generation.agents,
            applyLockCapability,
        });
    }, { workspaceRoot: fixture.workspace });
    fs.appendFileSync(path.join(fixture.alphaDir, 'manifest.json'), '\n');

    assert.throws(() => withEdgeGenerationApplyLock((applyLockCapability) => (
        commitAdditiveEdgeRoutingGeneration(prepared.preparationLease, {
            workspaceRoot: fixture.workspace,
            applyLockCapability,
        })
    ), {
        workspaceRoot: fixture.workspace,
        preparationLease: prepared.preparationLease,
    }), { code: 'EDGE_PREPARATION_SOURCE_CHANGED' });
    assert.deepEqual(fs.readFileSync(predecessor.paths.activeSelectorFile), selectorBefore);
    assert.deepEqual(fs.readFileSync(predecessor.paths.routingFile), routingBefore);
    abortEdgeRoutingPreparation(prepared.preparationLease, { workspaceRoot: fixture.workspace });
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

test('bwrap publishes only an owner-attested root route and rejects additional ports', (t) => {
    const fixture = createFixture(t);
    const agentsFile = path.join(fixture.ploinkyDir, 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    const ownerAttestation = {
        schemaVersion: 5,
        role: 'service',
        runtimeKey: 'alpha-container',
        ownerKey: serviceOwnerKey('alpha-container'),
        instanceId: 'alpha-instance',
        enableGeneration: 'alpha-enable-generation',
        homeKey: 'alpha',
        workdir: '/code',
        logPath: '/workspace/.ploinky/logs/alpha-bwrap.log',
        taskId: '',
        provider: '',
        routeKey: 'alpha',
        rootPort: 43101,
        credentialNonceDigest: `sha256:${'1'.repeat(64)}`,
        credentialExpiresAt: 4102444800,
        manifestDigest: `sha256:${'2'.repeat(64)}`,
        admissionDigest: `sha256:${'3'.repeat(64)}`,
        networkHash: `sha256:${'4'.repeat(64)}`,
        pid: 1234,
        processUid: typeof process.getuid === 'function' ? process.getuid() : 0,
        processIdentity: 'linux-proc:123e4567-e89b-12d3-a456-426614174000:1234',
    };
    agents['alpha-container'] = {
        ...agents['alpha-container'],
        pid: 1234,
        runtime: 'bwrap',
        bwrapOwner: ownerAttestation,
    };
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'bwrap-root-owner',
    });

    const rootPlan = resolveEdgeRoutePlan({
        req: {
            method: 'POST',
            url: '/alpha/mcp',
            headers: { host: '127.0.0.1:18080' },
        },
        listener: 'public',
    });
    assert.equal(rootPlan.ok, true);
    assert.equal(rootPlan.kind, 'agent-root');
    assert.deepEqual(rootPlan.ownerAttestation, ownerAttestation);

    const additionalPortPlan = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/base-agent-additional-server/alpha/7000/status',
            headers: { host: '127.0.0.1:18080' },
        },
        listener: 'public',
    });
    assert.equal(additionalPortPlan.ok, false);
    assert.equal(additionalPortPlan.status, 403);
    assert.equal(additionalPortPlan.code, 'BWRAP_AGENT_PORT_UNSUPPORTED');
});

test('bwrap root route refuses a mismatched immutable owner before generation publication', (t) => {
    const fixture = createFixture(t);
    const agentsFile = path.join(fixture.ploinkyDir, 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    agents['alpha-container'] = {
        ...agents['alpha-container'],
        runtime: 'bwrap',
        bwrapOwner: {
            role: 'service',
            runtimeKey: 'alpha-container',
            routeKey: 'alpha',
            rootPort: 43102,
            instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
        },
    };
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
    assert.throws(() => applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'bwrap-root-owner-mismatch',
    }), { code: 'BWRAP_AGENT_OWNER_INVALID' });
});

test('agent-mcp exposes only the selected root manifest dependency closure', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'explorer.example.test': {
                    agent: 'fixtures/alpha',
                    routerSurfaces: ['agent-mcp'],
                },
                'standalone.example.test': {
                    agent: 'fixtures/alpha',
                    routerSurfaces: [],
                },
            },
            cloudflare: {
                tunnelTokenSecret: 'publication/test-connector',
            },
        },
        alphaManifest: {
            enable: ['beta global no-wait'],
            routerAccess: {
                httpRoutes: [{
                    path: '/shared/*',
                    access: 'public',
                }],
            },
        },
        policy: {
            schema: 'router-policy',
            httpRoutes: [{
                path: '/beta/restricted.html',
                access: 'authenticated',
            }],
            mcpTools: [],
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
        routerAccess: {
            httpRoutes: [
                {
                    path: '/roomLoader.html',
                    access: 'guest',
                    guestScope: 'webmeet:room',
                    guestScopeParam: 'roomId',
                },
                { path: '/restricted.html', access: 'guest' },
                { path: '/static-files/*', access: 'public' },
                { path: '/disabled.html', access: 'authenticated', enabled: false },
            ],
        },
    }, null, 2));
    fs.writeFileSync(path.join(gammaDir, 'manifest.json'), JSON.stringify({
        routerAccess: {
            httpRoutes: [{ path: '/guest.html', access: 'guest' }],
        },
    }, null, 2));
    fs.writeFileSync(path.join(unrelatedDir, 'manifest.json'), JSON.stringify({
        routerAccess: {
            httpRoutes: [{ path: '/roomLoader.html', access: 'public' }],
        },
    }, null, 2));

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
    assert.deepEqual(
        applied.generation.compiled.dependencyHttpRoutes['explorer.example.test'],
        [
            { path: '/beta/restricted.html', routeKey: 'beta' },
            { path: '/beta/roomLoader.html', routeKey: 'beta' },
            { path: '/beta/static-files/*', routeKey: 'beta' },
            { path: '/gamma/guest.html', routeKey: 'gamma' },
        ],
    );
    assert.equal(
        applied.generation.compiled.policy.entries.find((entry) => (
            entry.path === '/beta/roomLoader.html'
        ))?.guestScope,
        'webmeet:room',
    );
    assert.equal(
        applied.generation.compiled.policy.entries.find((entry) => (
            entry.path === '/beta/roomLoader.html'
        ))?.guestScopeParam,
        'roomId',
    );
    assert.deepEqual(
        applied.generation.compiled.agentMcpRoutes['standalone.example.test'],
        [],
    );
    assert.deepEqual(
        applied.generation.compiled.dependencyHttpRoutes['standalone.example.test'],
        applied.generation.compiled.dependencyHttpRoutes['explorer.example.test'],
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

    const explicitlyPrefixedRootContent = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/alpha/shared/app.js',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(explicitlyPrefixedRootContent.ok, true);
    assert.equal(explicitlyPrefixedRootContent.routeKey, 'alpha');
    assert.equal(explicitlyPrefixedRootContent.canonicalPath, '/alpha/shared/app.js');
    assert.equal(explicitlyPrefixedRootContent.upstreamPath, '/shared/app.js');
    assert.equal(explicitlyPrefixedRootContent.decision.access, 'public');
    assert.equal(explicitlyPrefixedRootContent.decision.source, 'manifest');

    const dependencyManifestGuestRoute = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/beta/roomLoader.html',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(dependencyManifestGuestRoute.ok, true);
    assert.equal(dependencyManifestGuestRoute.routeKey, 'beta');
    assert.equal(dependencyManifestGuestRoute.upstreamPath, '/roomLoader.html');
    assert.equal(dependencyManifestGuestRoute.decision.access, 'guest');
    assert.equal(dependencyManifestGuestRoute.decision.source, 'manifest');

    const dependencyManifestRouteWithoutMcpSurface = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/beta/roomLoader.html',
            headers: { host: 'standalone.example.test' },
        },
        listener: 'public',
    });
    assert.equal(dependencyManifestRouteWithoutMcpSurface.ok, true);
    assert.equal(dependencyManifestRouteWithoutMcpSurface.routeKey, 'beta');
    assert.equal(dependencyManifestRouteWithoutMcpSurface.upstreamPath, '/roomLoader.html');
    assert.equal(dependencyManifestRouteWithoutMcpSurface.decision.access, 'guest');

    const dependencyMcpWithoutMcpSurface = resolveEdgeRoutePlan({
        req: {
            method: 'POST',
            url: '/beta/mcp',
            headers: { host: 'standalone.example.test' },
        },
        listener: 'public',
    });
    assert.equal(dependencyMcpWithoutMcpSurface.ok, true);
    assert.equal(dependencyMcpWithoutMcpSurface.routeKey, 'alpha');
    assert.equal(dependencyMcpWithoutMcpSurface.upstreamPath, '/beta/mcp');

    const dependencyManifestAssetRoute = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/beta/static-files/roomLoader.js',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(dependencyManifestAssetRoute.ok, true);
    assert.equal(dependencyManifestAssetRoute.routeKey, 'beta');
    assert.equal(dependencyManifestAssetRoute.upstreamPath, '/static-files/roomLoader.js');
    assert.equal(dependencyManifestAssetRoute.decision.access, 'public');

    const dependencyManifestAssetWrite = resolveEdgeRoutePlan({
        req: {
            method: 'POST',
            url: '/beta/static-files/roomLoader.js',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(dependencyManifestAssetWrite.ok, true);
    assert.equal(dependencyManifestAssetWrite.routeKey, 'beta');
    assert.equal(dependencyManifestAssetWrite.decision.access, 'deny');
    assert.equal(dependencyManifestAssetWrite.decision.status, 403);
    assert.equal(dependencyManifestAssetWrite.decision.code, 'PUBLIC_ROUTE_WRITE_DENIED');

    const restrictedDependencyManifestRoute = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/beta/restricted.html',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(restrictedDependencyManifestRoute.ok, true);
    assert.equal(restrictedDependencyManifestRoute.routeKey, 'beta');
    assert.equal(restrictedDependencyManifestRoute.upstreamPath, '/restricted.html');
    assert.equal(restrictedDependencyManifestRoute.decision.access, 'authenticated');
    assert.equal(restrictedDependencyManifestRoute.decision.source, 'policy');

    const disabledDependencyManifestRoute = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/beta/disabled.html',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(disabledDependencyManifestRoute.ok, true);
    assert.equal(disabledDependencyManifestRoute.routeKey, 'alpha');
    assert.equal(disabledDependencyManifestRoute.upstreamPath, '/beta/disabled.html');

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

    const transitiveDependencyManifestRoute = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/gamma/guest.html',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(transitiveDependencyManifestRoute.ok, true);
    assert.equal(transitiveDependencyManifestRoute.routeKey, 'gamma');
    assert.equal(transitiveDependencyManifestRoute.upstreamPath, '/guest.html');
    assert.equal(transitiveDependencyManifestRoute.decision.access, 'guest');

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

    const unrelatedManifestRoute = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/unrelated/roomLoader.html',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(unrelatedManifestRoute.ok, true);
    assert.equal(unrelatedManifestRoute.routeKey, 'alpha');
    assert.equal(unrelatedManifestRoute.upstreamPath, '/unrelated/roomLoader.html');
});

test('user-admin exposes only the selected root administration routes', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'explorer.example.test': {
                    agent: 'fixtures/alpha',
                    routerSurfaces: ['user-admin'],
                },
            },
            cloudflare: {
                tunnelTokenSecret: 'publication/test-connector',
            },
        },
    });
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'selected-root-user-administration',
        publicationState: 'ready',
    });

    for (const pathname of [
        '/api/agents/alpha/users',
        '/api/agents/alpha/users/local%3Auser',
        '/api/agents/alpha/settings',
    ]) {
        const plan = resolveEdgeRoutePlan({
            req: {
                method: 'GET',
                url: pathname,
                headers: { host: 'explorer.example.test' },
            },
            listener: 'public',
        });
        assert.equal(plan.ok, true, pathname);
        assert.equal(plan.kind, 'router-surface', pathname);
        assert.equal(plan.surface, 'user-admin', pathname);
    }

    for (const pathname of [
        '/api/agents/beta/users',
        '/api/agents/alpha/users/',
        '/api/agents//users',
        '/api/agents/alpha/settings/unexpected',
        '/api/agents/alpha/users/id/unexpected',
        '/api/agents/alpha/%75sers',
        '/api/agents/alpha/users/local%2Fuser',
        '/api/agents/alpha/users/%E0%A4%A',
        '/api/router/settings',
        '/policy/command',
        '/admin',
        '/__agent',
    ]) {
        const plan = resolveEdgeRoutePlan({
            req: {
                method: 'GET',
                url: pathname,
                headers: { host: 'explorer.example.test' },
            },
            listener: 'public',
        });
        assert.equal(plan.ok, false, pathname);
        assert.equal(plan.code, 'ROUTE_SURFACE_DENIED', pathname);
    }
});

test('selected root administration routes remain closed without user-admin', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'explorer.example.test': {
                    agent: 'fixtures/alpha',
                    routerSurfaces: [],
                },
            },
            cloudflare: {
                tunnelTokenSecret: 'publication/test-connector',
            },
        },
    });
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'closed-user-administration',
        publicationState: 'ready',
    });
    const plan = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/api/agents/alpha/users',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, 'ROUTE_SURFACE_DENIED');
});

test('webchat exposes only the WebChat router mount for the selected root', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'explorer.example.test': {
                    agent: 'fixtures/alpha',
                    routerSurfaces: ['webchat'],
                },
            },
            cloudflare: {
                tunnelTokenSecret: 'publication/test-connector',
            },
        },
    });
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'selected-root-webchat',
        publicationState: 'ready',
    });
    assert.deepEqual(applied.generation.compiled.surfaces['explorer.example.test'], ['webchat']);

    for (const pathname of ['/webchat', '/webchat/', '/webchat/input']) {
        const plan = resolveEdgeRoutePlan({
            req: {
                method: 'GET',
                url: pathname,
                headers: { host: 'explorer.example.test' },
            },
            listener: 'public',
        });
        assert.equal(plan.ok, true, pathname);
        assert.equal(plan.kind, 'router-surface', pathname);
        assert.equal(plan.surface, 'webchat', pathname);
    }

    for (const pathname of ['/dashboard', '/status', '/workspace-files']) {
        const plan = resolveEdgeRoutePlan({
            req: {
                method: 'GET',
                url: pathname,
                headers: { host: 'explorer.example.test' },
            },
            listener: 'public',
        });
        assert.equal(plan.ok, false, pathname);
        assert.equal(plan.code, 'ROUTE_SURFACE_DENIED', pathname);
    }
});

test('WebChat router mount remains closed without the webchat surface', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'explorer.example.test': {
                    agent: 'fixtures/alpha',
                    routerSurfaces: [],
                },
            },
            cloudflare: {
                tunnelTokenSecret: 'publication/test-connector',
            },
        },
    });
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'closed-webchat',
        publicationState: 'ready',
    });
    const plan = resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url: '/webchat?agent=alpha',
            headers: { host: 'explorer.example.test' },
        },
        listener: 'public',
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, 'ROUTE_SURFACE_DENIED');
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

test('prepared runtime identity returns the immutable staged registry record', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'runtime-record-preparation',
    });
    const staged = assertPreparedRuntimeIdentity(prepared.preparationLease, {
        workspaceRoot: fixture.workspace,
        containerName: 'alpha-container',
        instanceId: 'alpha-instance',
        enableGeneration: 'alpha-enable-generation',
    });
    assert.deepEqual(staged, prepared.generation.agents['alpha-container']);

    const agentsFile = path.join(fixture.ploinkyDir, 'agents.json');
    const live = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    live['alpha-container'].containerId = 'same-tuple-runtime-only-drift';
    fs.writeFileSync(agentsFile, JSON.stringify(live, null, 2));

    assert.deepEqual(assertPreparedRuntimeIdentity(prepared.preparationLease, {
        workspaceRoot: fixture.workspace,
        containerName: 'alpha-container',
        instanceId: 'alpha-instance',
        enableGeneration: 'alpha-enable-generation',
    }), staged);
    abortEdgeRoutingPreparation(prepared.preparationLease, { workspaceRoot: fixture.workspace });
});

test('prepared Router attestation remains inactive and binds exact lease, owner, sources, and checkpoint order', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'prepared-attestation',
    });
    const owner = {
        containerName: 'alpha-container',
        principal: 'agent:fixtures/alpha',
        instanceId: 'alpha-instance',
        enableGeneration: 'alpha-enable-generation',
    };
    const lease = createRouterAttestationGenerationLease({
        workspaceRoot: fixture.workspace,
        preparationLease: prepared.preparationLease,
        expectedOwner: owner,
    });
    assert.equal(lease.id, prepared.selector.generation);
    assert.deepEqual(lease.owner, owner);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
    assert.throws(() => lease.checkpoint('pre-credentials'), { code: 'EDGE_GENERATION_CHECKPOINT_INVALID' });
    assert.equal(lease.commit(), true);
    assert.equal(lease.checkpoint('pre-credentials'), true);
    assert.equal(lease.checkpoint('pre-runtime'), true);
    assert.equal(lease.checkpoint('post-inspection'), true);
    assert.equal(lease.complete, true);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});

test('additive Router attestation checkpoints use the immutable candidate bytes', (t) => {
    const fixture = createFixture(t);
    const predecessor = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'additive-attestation-predecessor',
    });
    const candidateRouting = structuredClone(predecessor.generation.routing);
    candidateRouting.routes.alpha.hostPort = 45103;
    let prepared;
    withEdgeGenerationApplyLock((applyLockCapability) => {
        prepared = prepareAdditiveEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            routing: candidateRouting,
            agents: predecessor.generation.agents,
            applyLockCapability,
            reason: 'additive-attestation-candidate',
        });
    }, { workspaceRoot: fixture.workspace });

    const lease = createRouterAttestationGenerationLease({
        workspaceRoot: fixture.workspace,
        preparationLease: prepared.preparationLease,
        expectedOwner: {
            containerName: 'alpha-container',
            principal: 'agent:fixtures/alpha',
            instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
        },
    });
    assert.equal(lease.id, prepared.generation.generation);
    assert.equal(lease.commit(), true);
    assert.equal(lease.checkpoint('pre-credentials'), true);
    assert.equal(lease.checkpoint('pre-runtime'), true);
    assert.equal(lease.checkpoint('post-inspection'), true);
    assert.equal(lease.complete, true);
    assert.equal(loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).selector.generation,
        predecessor.selector.generation);
    abortEdgeRoutingPreparation(prepared.preparationLease, { workspaceRoot: fixture.workspace });
});

test('registered authority observation accepts only the exact additive preparation candidate', (t) => {
    const fixture = createFixture(t);
    const predecessor = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'additive-observation-predecessor',
    });
    const candidateRouting = structuredClone(predecessor.generation.routing);
    candidateRouting.routes.alpha.hostPort = 45104;
    let prepared;
    withEdgeGenerationApplyLock((applyLockCapability) => {
        prepared = prepareAdditiveEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            routing: candidateRouting,
            agents: predecessor.generation.agents,
            applyLockCapability,
            reason: 'additive-observation-candidate',
        });
    }, { workspaceRoot: fixture.workspace });

    const generation = prepared.generation.generation;
    const ordinary = resolveEdgeRoutePlan({
        req: { headers: { host: '127.0.0.1:18080' }, url: '/health' },
        listener: 'public',
    });
    assert.equal(ordinary.lease?.id, predecessor.selector.generation);

    const observed = resolveEdgeRoutePlan({
        req: { headers: { host: '127.0.0.1:18080' }, url: '/health' },
        listener: 'public',
        authorityObservationGeneration: generation,
    });
    assert.equal(observed.status, 404);
    assert.equal(observed.code, 'ROUTE_NOT_FOUND');
    assert.equal(observed.hostSelection?.kind, 'control');
    assert.equal(observed.lease?.id, generation);
    assert.equal(observed.lease?.commit(), true);
    assert.equal(
        loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).selector.generation,
        predecessor.selector.generation,
    );

    abortEdgeRoutingPreparation(prepared.preparationLease, { workspaceRoot: fixture.workspace });
    assert.equal(observed.lease?.commit(), false);
    assert.throws(() => captureEdgeRoutingObservationLease({
        workspaceRoot: fixture.workspace,
        expectedGeneration: generation,
    }), { code: 'EDGE_GENERATION_RACE' });
});

test('later startup waves retain the prepared attestation across runtime-only locator updates', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'prepared-attestation-runtime-locators',
    });
    const routingFile = path.join(fixture.ploinkyDir, 'routing.json');
    const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
    routing.routes.beta.hostPort = 43999;
    fs.writeFileSync(routingFile, JSON.stringify(routing, null, 2));
    const agentsFile = path.join(fixture.ploinkyDir, 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    agents['beta-container'].runtime = 'podman';
    agents['beta-container'].containerId = 'beta-runtime-id';
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));

    const lease = createRouterAttestationGenerationLease({
        workspaceRoot: fixture.workspace,
        preparationLease: prepared.preparationLease,
        expectedOwner: {
            containerName: 'alpha-container',
            principal: 'agent:fixtures/alpha',
            instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
        },
    });
    assert.equal(lease.id, prepared.selector.generation);
    assert.equal(lease.commit(), true);
    assert.equal(lease.checkpoint('pre-credentials'), true);
    assert.equal(lease.checkpoint('pre-runtime'), true);
    assert.equal(lease.checkpoint('post-inspection'), true);
    assert.equal(lease.complete, true);
});

test('a registered authority observation classifies only its exact selected inactive generation', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'prepared-observation',
    });
    const generation = prepared.selector.generation;
    const lease = captureEdgeRoutingObservationLease({
        workspaceRoot: fixture.workspace,
        expectedGeneration: generation,
    });
    assert.equal(lease.id, generation);
    assert.equal(lease.commit(), true);

    const ordinary = resolveEdgeRoutePlan({
        req: { headers: { host: '127.0.0.1:18080' }, url: '/health' },
        listener: 'public',
    });
    assert.equal(ordinary.status, 503);
    assert.equal(ordinary.code, 'EDGE_GENERATION_INACTIVE');

    const observed = resolveEdgeRoutePlan({
        req: { headers: { host: '127.0.0.1:18080' }, url: '/health' },
        listener: 'public',
        authorityObservationGeneration: generation,
    });
    assert.equal(observed.status, 404);
    assert.equal(observed.code, 'ROUTE_NOT_FOUND');
    assert.equal(observed.hostSelection?.kind, 'control');
    assert.equal(observed.lease?.id, generation);
    assert.equal(observed.lease?.commit(), true);

    assert.throws(() => captureEdgeRoutingObservationLease({
        workspaceRoot: fixture.workspace,
        expectedGeneration: `sha256:${'f'.repeat(64)}`,
    }), { code: 'EDGE_GENERATION_RACE' });
});

test('prepared Router attestation fails closed when lifecycle sources change between checkpoints', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'prepared-attestation-race',
    });
    const lease = createRouterAttestationGenerationLease({
        workspaceRoot: fixture.workspace,
        preparationLease: prepared.preparationLease,
        expectedOwner: {
            containerName: 'alpha-container',
            principal: 'agent:fixtures/alpha',
            instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
        },
    });
    assert.equal(lease.commit(), true);
    const agentsFile = path.join(fixture.ploinkyDir, 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    agents['alpha-container'].enableGeneration = 'competing-generation';
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
    assert.throws(() => lease.checkpoint('pre-credentials'), { code: 'EDGE_GENERATION_RACE' });
    assert.equal(lease.complete, false);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});

test('legacy generation without dependency HTTP routes remains loadable until replacement', (t) => {
    const fixture = createFixture(t, {
        desired: {
            hosts: {
                'explorer.example.test': {
                    agent: 'fixtures/alpha',
                    routerSurfaces: [],
                },
            },
        },
    });
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'legacy-generation-baseline',
    });
    const generationFile = path.join(
        fixture.edgeDir,
        'generations',
        `${applied.selector.generation.replace(/^sha256:/, '')}.json`,
    );
    const legacyDocument = JSON.parse(fs.readFileSync(generationFile, 'utf8'));
    delete legacyDocument.compiled.dependencyHttpRoutes;
    legacyDocument.compiledDigest = compiledDigest(legacyDocument.compiled);
    fs.writeFileSync(generationFile, JSON.stringify(legacyDocument, null, 2));

    const legacyActive = loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace });
    assert.equal(Object.hasOwn(legacyActive.generation.compiled, 'dependencyHttpRoutes'), false);

    fs.writeFileSync(path.join(fixture.edgeDir, 'desired.json'), JSON.stringify({
        hosts: {
            'replacement.example.test': {
                agent: 'fixtures/alpha',
                routerSurfaces: [],
            },
        },
    }, null, 2));
    const replacement = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'legacy-generation-replacement',
    });
    assert.notEqual(replacement.selector.generation, applied.selector.generation);
    assert.equal(Object.hasOwn(replacement.generation.compiled, 'dependencyHttpRoutes'), true);
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
