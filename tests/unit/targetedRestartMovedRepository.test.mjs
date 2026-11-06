import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A repository enabled from its managed copy (`.ploinky/repos/<repo>`) and then
// moved to a workspace-root checkout must still restart by name. The route's
// stored `hostPath` is the edge generation's manifest source, so a targeted
// restart has to refresh it with the drain instead of reading a vanished
// manifest. In prod mode the workspace checkout is never a source.

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-moved-repo-restart-')));
const previous = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    PLOINKY_MEDIA_HOST_PORT: process.env.PLOINKY_MEDIA_HOST_PORT,
    PLOINKY_REPOS_SOURCE: process.env.PLOINKY_REPOS_SOURCE,
};
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18081';
process.env.PLOINKY_MEDIA_HOST_PORT = '17892';
delete process.env.PLOINKY_REPOS_SOURCE;

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const { withNetworkLifecycleLock } = await import('../../cli/sandbox/networkLifecycle.js');
const { prepareTargetedAgentRestart, commitTargetedAgentRestart, refreshRouteAgentPath } = await import('../../cli/commands/targetedAgentRestart.js');
const { coordinateReplacementRuntimeIdentity } = await import('../../cli/sandbox/docker/agentServiceManager.js');
const { reconcileExactHardwareInstance } = await import('../../cli/sandbox/hardwareLimits/reconcile.mjs');
const { findAgent } = await import('../../cli/utils/utils.js');

test.after(() => {
    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

const ploinkyDir = path.join(workspace, '.ploinky');
const managedRepo = path.join(ploinkyDir, 'repos', 'media');
const checkoutRepo = path.join(workspace, 'media');
const CONTAINER = 'agentB-container';
const OLD_MANIFEST = { container: 'node:20-alpine' };
const NEW_MANIFEST = { container: 'node:20-alpine', env: [] };

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function record() {
    return {
        type: 'agent',
        repoName: 'media',
        agentName: 'agentB',
        instanceId: 'agentB-instance',
        enableGeneration: 'agentB-generation',
        profile: 'default',
        auth: { mode: 'sso' },
        containerId: 'a'.repeat(64),
        runtime: 'podman',
    };
}

// The agent is enabled from the managed copy, as before the repository moved.
function seedEnabledFromManagedCopy() {
    fs.rmSync(ploinkyDir, { recursive: true, force: true });
    fs.rmSync(checkoutRepo, { recursive: true, force: true });
    writeJson(path.join(managedRepo, 'agentB', 'manifest.json'), OLD_MANIFEST);
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        routes: {
            agentB: { repo: 'media', agent: 'agentB', container: CONTAINER, hostPath: path.join(managedRepo, 'agentB'), hostPort: 41002 },
        },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), { [CONTAINER]: record() });
    writeJson(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), {
        hosts: { 'app.example.com': { agent: 'media/agentB', routerSurfaces: ['browser-auth'] } },
        cloudflare: { tunnelTokenSecret: 'cloudflare/tunnel-token' },
    });
    writeJson(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });
    edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'moved-repo-fixture', publicationState: 'ready' });
}

// The operator moved the repository to a workspace-root checkout (a newer
// commit, so the manifest bytes differ) and removed the managed copy.
function moveRepositoryToWorkspaceCheckout() {
    fs.rmSync(managedRepo, { recursive: true, force: true });
    writeJson(path.join(checkoutRepo, 'agentB', 'manifest.json'), NEW_MANIFEST);
    fs.mkdirSync(path.join(checkoutRepo, '.git'), { recursive: true });
}

// The directory exactly as every start, enable and restart resolve it.
function resolvedAgentPath() {
    return path.dirname(findAgent('media/agentB').manifestPath);
}

function prepare(extra = {}) {
    // The CLI restart reads the registered record from agents.json, which
    // stays readable while the edge generation is inactive.
    const registered = JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8'))[CONTAINER];
    return withNetworkLifecycleLock((networkLifecycleCapability) => prepareTargetedAgentRestart({
        containerName: CONTAINER,
        routeKey: 'agentB',
        repoName: 'media',
        shortAgentName: 'agentB',
        record: registered,
        networkLifecycleCapability,
        ...extra,
    }));
}

function commit(transition, agentPath) {
    return withNetworkLifecycleLock((networkLifecycleCapability) => commitTargetedAgentRestart({
        transition,
        result: {
            containerName: CONTAINER,
            hostPort: 41012,
            registryRecord: { ...record(), containerId: 'd'.repeat(64) },
        },
        agentPath,
        networkLifecycleCapability,
    }, { retireEntriesAfterApply: async () => {} }));
}

test('dev mode resolves the moved repository to the workspace checkout, not the managed copy', () => {
    seedEnabledFromManagedCopy();
    assert.equal(resolvedAgentPath(), path.join(managedRepo, 'agentB'));
    moveRepositoryToWorkspaceCheckout();
    assert.equal(resolvedAgentPath(), path.join(checkoutRepo, 'agentB'));
});

test('a targeted restart after the repository moved drains and reopens the route on the workspace checkout', async () => {
    seedEnabledFromManagedCopy();
    moveRepositoryToWorkspaceCheckout();
    const agentPath = resolvedAgentPath();
    assert.equal(agentPath, path.join(checkoutRepo, 'agentB'));
    const before = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(before.generation.routing.routes.agentB.hostPath, path.join(managedRepo, 'agentB'));

    const transition = await prepare({ agentPath });

    const drained = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(drained.selector.state, 'active', 'the drain leaves an active generation');
    assert.equal(drained.generation.routing.routes.agentB.draining, true);
    assert.equal(drained.generation.routing.routes.agentB.hostPath, agentPath,
        'the drain refreshes the stored locator to the resolved checkout');
    assert.equal(transition.predecessorRoute.draining, undefined);

    await commit(transition, agentPath);
    const reopened = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(reopened.selector.state, 'active');
    assert.equal(reopened.generation.routing.routes.agentB.draining, undefined);
    assert.equal(reopened.generation.routing.routes.agentB.hostPath, agentPath);
    assert.equal(reopened.generation.routing.routes.agentB.hostPort, 41012);
    assert.equal(reopened.generation.agents[CONTAINER].instanceId, 'agentB-instance');
    assert.equal(JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8')).routes.agentB.hostPath, agentPath);
});

test('a restart without a resolved directory still fails closed on the vanished stored locator, and a retry with it recovers', async () => {
    seedEnabledFromManagedCopy();
    moveRepositoryToWorkspaceCheckout();
    // Control: the incident. The stored locator names the removed managed copy.
    await assert.rejects(prepare(), /manifest\(agentB\) is unavailable: ENOENT/);
    const stuck = edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector;
    assert.equal(stuck.state, 'inactive', 'the failed drain fails the edge closed');
    const stuckRoute = JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8')).routes.agentB;
    assert.equal(stuckRoute.draining, true, 'the failed drain leaves an operator drain behind');
    assert.equal(stuckRoute.hostPath, path.join(managedRepo, 'agentB'));

    // The retry from that exact stuck state resolves the checkout and recovers.
    const agentPath = resolvedAgentPath();
    const transition = await prepare({ agentPath });
    const drained = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(drained.selector.state, 'active');
    assert.equal(drained.generation.routing.routes.agentB.hostPath, agentPath);
    await commit(transition, agentPath);
    const reopened = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(reopened.generation.routing.routes.agentB.draining, undefined);
    assert.equal(reopened.generation.routing.routes.agentB.hostPath, agentPath);
});

test('an unmoved repository keeps the active to active drain and its stored locator', async () => {
    seedEnabledFromManagedCopy();
    const agentPath = resolvedAgentPath();
    assert.equal(agentPath, path.join(managedRepo, 'agentB'));
    const transition = await prepare({ agentPath });
    const drained = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(drained.generation.routing.routes.agentB.hostPath, agentPath);
    assert.equal(drained.generation.routing.routes.agentB.draining, true);
    await commit(transition, agentPath);
    assert.equal(edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }).generation.routing.routes.agentB.draining, undefined);
});

test('prod mode keeps using the managed copy and never reads the workspace checkout', async (t) => {
    seedEnabledFromManagedCopy();
    // A checkout whose manifest cannot be parsed: any read of it fails the test.
    fs.mkdirSync(path.join(checkoutRepo, 'agentB'), { recursive: true });
    fs.writeFileSync(path.join(checkoutRepo, 'agentB', 'manifest.json'), '{ not json');
    fs.mkdirSync(path.join(checkoutRepo, '.git'), { recursive: true });
    process.env.PLOINKY_REPOS_SOURCE = 'prod';
    t.after(() => { delete process.env.PLOINKY_REPOS_SOURCE; });

    const agentPath = resolvedAgentPath();
    assert.equal(agentPath, path.join(managedRepo, 'agentB'), 'prod mode resolves the managed copy');
    const transition = await prepare({ agentPath });
    const drained = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(drained.selector.state, 'active');
    assert.equal(drained.generation.routing.routes.agentB.hostPath, path.join(managedRepo, 'agentB'));
    await commit(transition, agentPath);
    const reopened = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(reopened.generation.routing.routes.agentB.hostPath, path.join(managedRepo, 'agentB'));
    assert.equal(reopened.generation.routing.routes.agentB.draining, undefined);
});

test('prod mode with a removed managed copy fails closed instead of adopting the workspace checkout', async (t) => {
    seedEnabledFromManagedCopy();
    moveRepositoryToWorkspaceCheckout();
    process.env.PLOINKY_REPOS_SOURCE = 'prod';
    t.after(() => { delete process.env.PLOINKY_REPOS_SOURCE; });
    assert.throws(() => findAgent('media/agentB'), /Agent 'media\/agentB' not found\./);
});

test('the exact-instance reconcile hands the resolved checkout to the drain, the launch and the reopen', async () => {
    seedEnabledFromManagedCopy();
    moveRepositoryToWorkspaceCheckout();
    const agentPath = resolvedAgentPath();
    const captured = { key: CONTAINER, record: record() };
    const seen = {};
    const result = await reconcileExactHardwareInstance(captured, {
        origin: 'cli', expectedToken: { epoch: 'e'.repeat(32), revision: 1 },
    }, {
        maintenance: (_key, _options, callback) => callback(),
        loadRegistry: () => ({ [CONTAINER]: record() }),
        loadPlan: () => ({
            runtime: 'podman',
            manifest: NEW_MANIFEST,
            runtimeAdmission: { descriptor: {} },
            profileResolution: { resolvedProfileName: 'default', network: { mode: 'default' } },
            agentPath,
            routerEndpoint: null,
        }),
        readPolicy: () => ({ token: { epoch: 'e'.repeat(32), revision: 1 } }),
        policyCheck: () => true,
        prepare: async (request) => { seen.prepare = request.agentPath; return prepareTargetedAgentRestart(request); },
        ensure: async (_name, _manifest, launchPath) => {
            seen.ensure = launchPath;
            return { containerName: CONTAINER, hostPort: 41012, containerId: 'd'.repeat(64), registryRecord: { ...record(), containerId: 'd'.repeat(64) } };
        },
        readiness: async () => {},
        commit: (request) => commitTargetedAgentRestart(request, { retireEntriesAfterApply: async () => {} }),
    });
    assert.equal(result.state, 'applied');
    assert.equal(seen.prepare, agentPath);
    assert.equal(seen.ensure, agentPath);
    const reopened = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(reopened.selector.state, 'active');
    assert.equal(reopened.generation.routing.routes.agentB.hostPath, agentPath);
    assert.equal(reopened.generation.routing.routes.agentB.draining, undefined);
});

// The native sandbox runtimes restart through a coordinated replacement
// without a targeted drain; it prepares its edge generation from every route's
// stored locator, so the restart refreshes the moved locator first.
function rotateIdentity() {
    const existingRecord = JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8'))[CONTAINER];
    return withNetworkLifecycleLock((networkLifecycleCapability) => coordinateReplacementRuntimeIdentity({
        containerName: CONTAINER,
        existingRecord,
        reason: 'moved-repository-restart',
        networkLifecycleCapability,
        runtimeNetwork: { mode: 'default' },
        portMappings: [],
    }));
}

test('a no-drain coordinated replacement fails closed on the vanished locator until the restart refreshes it', async () => {
    seedEnabledFromManagedCopy();
    moveRepositoryToWorkspaceCheckout();
    await assert.rejects(async () => rotateIdentity(), /manifest\(agentB\) is unavailable: ENOENT/);

    const agentPath = resolvedAgentPath();
    const refreshed = await withNetworkLifecycleLock((networkLifecycleCapability) => refreshRouteAgentPath({
        routeKey: 'agentB', containerName: CONTAINER, agentPath, networkLifecycleCapability,
    }));
    assert.equal(refreshed, true);
    const active = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(active.selector.state, 'active');
    assert.equal(active.generation.routing.routes.agentB.hostPath, agentPath);
    assert.equal(active.generation.routing.routes.agentB.hostPort, 41002, 'the refresh keeps the route target');
    const rotated = await rotateIdentity();
    assert.ok(rotated.instanceId, 'the replacement identity is prepared from the checkout manifest');
});

test('refreshing the locator is a no-op when the stored directory is already the resolved one', async () => {
    seedEnabledFromManagedCopy();
    const before = edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector;
    const refreshed = await withNetworkLifecycleLock((networkLifecycleCapability) => refreshRouteAgentPath({
        routeKey: 'agentB', containerName: CONTAINER, agentPath: resolvedAgentPath(), networkLifecycleCapability,
    }));
    assert.equal(refreshed, false);
    assert.deepEqual(edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector, before);
    const other = await withNetworkLifecycleLock((networkLifecycleCapability) => refreshRouteAgentPath({
        routeKey: 'agentB', containerName: 'another-container', agentPath: checkoutRepo, networkLifecycleCapability,
    }));
    assert.equal(other, false, 'a route owned by another container is never rewritten');
});
