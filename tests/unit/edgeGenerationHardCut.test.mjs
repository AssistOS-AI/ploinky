import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    applyEdgeRoutingGeneration,
    initializeFreshEdgeRoutingSources,
    loadActiveEdgeRoutingGeneration,
    prepareEdgeRoutingGeneration,
    readCurrentEdgeTopology,
} from '../../cli/sandbox/edgeGeneration.js';

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
