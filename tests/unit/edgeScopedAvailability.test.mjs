import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Scoped edge availability: lifecycle generations carry a ready Cloudflare
// publication forward (A4) and withdrawals flip the selector active to active
// to a strict subset of its predecessor (A5).

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-scoped-'));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const previousRouterHostPort = process.env.PLOINKY_ROUTER_HOST_PORT;
const previousMediaHostPort = process.env.PLOINKY_MEDIA_HOST_PORT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const routingFile = await import('../../cli/server/routingFile.js');

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    if (previousRouterHostPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
    else process.env.PLOINKY_ROUTER_HOST_PORT = previousRouterHostPort;
    if (previousMediaHostPort === undefined) delete process.env.PLOINKY_MEDIA_HOST_PORT;
    else process.env.PLOINKY_MEDIA_HOST_PORT = previousMediaHostPort;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const ploinkyDir = path.join(workspace, '.ploinky');
const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
const policyDir = path.join(ploinkyDir, 'data', 'router-security');
const repoDir = path.join(ploinkyDir, 'repos', 'fixtures');
const PUBLIC_HOST = 'app.example.com';

function cloudflareDesired(overrides = {}) {
    return {
        hosts: { [PUBLIC_HOST]: { agent: 'fixtures/alpha' } },
        cloudflare: { tunnelTokenSecret: 'cloudflare/tunnel-token' },
        ...overrides,
    };
}

function agentRecord(agentName, extra = {}) {
    return {
        type: 'agent',
        repoName: 'fixtures',
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-enable-generation`,
        auth: { mode: 'sso' },
        ...extra,
    };
}

function route(agentName, hostPort, extra = {}) {
    return {
        repo: 'fixtures',
        agent: agentName,
        container: `${agentName}-container`,
        hostPath: path.join(repoDir, agentName),
        hostPort,
        ...extra,
    };
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// Rebuild the workspace sources from scratch and select one active generation.
function resetWorkspace({
    desired = cloudflareDesired(),
    publicationState = 'ready',
    manifests = {},
    routing,
    agents,
} = {}) {
    fs.rmSync(ploinkyDir, { recursive: true, force: true });
    for (const agentName of ['alpha', 'beta', 'gamma']) {
        writeJson(path.join(repoDir, agentName, 'manifest.json'), manifests[agentName] || {});
    }
    writeJson(path.join(ploinkyDir, 'routing.json'), routing || {
        routes: {
            alpha: route('alpha', 43101),
            beta: route('beta', 43102),
            gamma: route('gamma', 43103),
        },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), agents || {
        'alpha-container': agentRecord('alpha'),
        'beta-container': agentRecord('beta'),
        'gamma-container': agentRecord('gamma'),
    });
    writeJson(path.join(edgeDir, 'desired.json'), desired);
    writeJson(path.join(policyDir, 'policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    const applied = edge.applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'edge-scoped-fixture',
        publicationState,
    });
    assert.equal(applied.selector.state, 'active');
    assert.equal(applied.selector.publicationState, publicationState);
    return applied;
}

function readRouting() {
    return JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8'));
}

function readAgents() {
    return JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8'));
}

function activeSelector() {
    return edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector;
}

test('A4 a routing merge over a ready predecessor with unchanged publication semantics stays ready', async () => {
    resetWorkspace({ publicationState: 'ready' });
    const before = activeSelector();
    await routingFile.mergeRoutingConfig((current) => {
        current.routes.beta = { ...current.routes.beta, hostPort: 43202 };
        return current;
    }, { reason: 'a4-route-only-merge' });
    const after = activeSelector();
    assert.equal(after.state, 'active');
    assert.notEqual(after.generation, before.generation);
    assert.equal(after.publicationState, 'ready');
});

test('A4 a routing write over a ready predecessor stays ready', () => {
    resetWorkspace({ publicationState: 'ready' });
    const current = readRouting();
    current.routes.gamma = { ...current.routes.gamma, hostPort: 43303 };
    routingFile.writeRoutingConfig(current, { reason: 'a4-route-only-write' });
    assert.equal(activeSelector().publicationState, 'ready');
});

test('A4 a routing merge over a reconciling predecessor stays reconciling', async () => {
    resetWorkspace({ publicationState: 'reconciling' });
    await routingFile.mergeRoutingConfig((current) => {
        current.routes.beta = { ...current.routes.beta, hostPort: 43202 };
        return current;
    }, { reason: 'a4-route-only-merge-reconciling' });
    const after = activeSelector();
    assert.equal(after.state, 'active');
    assert.equal(after.publicationState, 'reconciling');
});

test('A4 an additive commit over a ready predecessor stays ready, and over reconciling stays reconciling', () => {
    for (const predecessorState of ['ready', 'reconciling']) {
        resetWorkspace({ publicationState: predecessorState });
        const routing = readRouting();
        delete routing.routes.gamma.hostPort;
        const agents = readAgents();
        agents['gamma-container'] = agentRecord('gamma', { instanceId: 'gamma-next', enableGeneration: 'gamma-next-generation' });
        edge.withEdgeGenerationApplyLock((applyLockCapability) => {
            const prepared = edge.prepareAdditiveEdgeRoutingGeneration({
                workspaceRoot: workspace,
                routing,
                agents,
                applyLockCapability,
            });
            routing.routes.gamma.hostPort = 43403;
            const committed = edge.commitAdditiveEdgeRoutingGeneration(prepared.preparationLease, {
                workspaceRoot: workspace,
                routing,
                agents,
                applyLockCapability,
            });
            assert.equal(committed.selector.publicationState, predecessorState);
        }, { workspaceRoot: workspace });
        assert.equal(activeSelector().publicationState, predecessorState);
    }
});

test('A4 a lifecycle apply naming its active predecessor carries ready; an unnamed apply reconciles again', () => {
    resetWorkspace({ publicationState: 'ready' });
    const predecessor = activeSelector();
    const routing = readRouting();
    routing.routes.beta.hostPort = 43502;
    writeJson(path.join(ploinkyDir, 'routing.json'), routing);
    const carried = edge.applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'a4-lifecycle-apply',
        publicationPredecessor: predecessor,
    });
    assert.equal(carried.selector.publicationState, 'ready');

    routing.routes.beta.hostPort = 43602;
    writeJson(path.join(ploinkyDir, 'routing.json'), routing);
    const unnamed = edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'a4-unnamed-apply' });
    assert.equal(unnamed.selector.publicationState, 'reconciling');
});

test('A4 control: a publication semantic change is never carried forward', async () => {
    resetWorkspace({ publicationState: 'ready' });
    const predecessor = activeSelector();
    writeJson(path.join(edgeDir, 'desired.json'), cloudflareDesired({
        hosts: { [PUBLIC_HOST]: { agent: 'fixtures/alpha' }, 'other.example.com': { agent: 'fixtures/beta' } },
    }));
    const changedHosts = edge.applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'a4-host-change',
        publicationPredecessor: predecessor,
    });
    assert.equal(changedHosts.selector.publicationState, 'reconciling');

    resetWorkspace({ publicationState: 'ready' });
    const secretPredecessor = activeSelector();
    writeJson(path.join(edgeDir, 'desired.json'), cloudflareDesired({
        cloudflare: { tunnelTokenSecret: 'cloudflare/other-tunnel-token' },
    }));
    const changedSecret = edge.applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'a4-secret-handle-change',
        publicationPredecessor: secretPredecessor,
    });
    assert.equal(changedSecret.selector.publicationState, 'reconciling');

    // A host whose compiled route key changes is a semantic change as well.
    resetWorkspace({ publicationState: 'ready' });
    await routingFile.mergeRoutingConfig((current) => {
        const alpha = current.routes.alpha;
        delete current.routes.alpha;
        current.routes['alpha-renamed'] = { ...alpha, alias: 'alpha-renamed' };
        return current;
    }, { reason: 'a4-host-route-key-change' });
    assert.equal(activeSelector().publicationState, 'reconciling');
});

test('A4 control: a forged predecessor selector cannot lend readiness', () => {
    resetWorkspace({ publicationState: 'reconciling' });
    const predecessor = activeSelector();
    const routing = readRouting();
    routing.routes.beta.hostPort = 43702;
    writeJson(path.join(ploinkyDir, 'routing.json'), routing);
    const forged = edge.applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'a4-forged-predecessor',
        publicationPredecessor: { ...predecessor, publicationState: 'ready' },
    });
    assert.equal(forged.selector.publicationState, 'reconciling');
});

const { resolveEdgeRoutePlan } = await import('../../cli/server/edgeRoutePlan.js');

function routePlanFor(host, url = '/beta/') {
    return resolveEdgeRoutePlan({ req: { method: 'GET', url, headers: { host } }, listener: 'public' });
}

test('A9 inactive edge denials carry Retry-After: 2 and other denials do not', () => {
    resetWorkspace({ publicationState: 'reconciling' });
    const hostInactive = routePlanFor(PUBLIC_HOST, '/');
    assert.equal(hostInactive.status, 503);
    assert.equal(hostInactive.code, 'HOST_SELECTOR_INACTIVE');
    assert.equal(hostInactive.retryAfterSeconds, 2);

    const unknownHost = routePlanFor('unknown.example.com', '/');
    assert.equal(unknownHost.status, 421);
    assert.equal(unknownHost.retryAfterSeconds, undefined);

    edge.inactivateEdgeRoutingGeneration('a9-inactive', { workspaceRoot: workspace });
    const inactive = routePlanFor('127.0.0.1:18080');
    assert.equal(inactive.status, 503);
    assert.equal(inactive.code, 'EDGE_GENERATION_INACTIVE');
    assert.equal(inactive.retryAfterSeconds, 2);

    // RoutingServer's deny branch is the only writer of these plan denials; it
    // turns the plan's retry hint into the response header.
    const routerSource = fs.readFileSync(new URL('../../cli/server/RoutingServer.js', import.meta.url), 'utf8');
    const denyBranch = routerSource.slice(
        routerSource.indexOf('if (!routePlan.ok && !controlMiss) {'),
        routerSource.indexOf('const parsedUrl = routePlan.ok && routePlan.parsedUrl'),
    );
    assert.match(denyBranch, /'Retry-After': String\(routePlan\.retryAfterSeconds\)/);
});

const { dispatchAgentStartupAfterRouterSurfaces } = await import('../../cli/server/agentStartupDispatch.js');

class RecordingResponse {
    constructor() {
        this.statusCode = 0;
        this.headers = {};
        this.body = '';
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = { ...headers };
    }

    end(body = '') {
        this.body += body === undefined ? '' : String(body);
    }
}

function drainBetaInSources({ keepPort = false } = {}) {
    const routing = readRouting();
    routing.routes.beta = { ...routing.routes.beta, draining: true };
    if (!keepPort) delete routing.routes.beta.hostPort;
    writeJson(path.join(ploinkyDir, 'routing.json'), routing);
    edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'd5-drain-fixture', publicationState: 'ready' });
}

test('D5 a draining route answers 503 AGENT_ROUTE_DRAINING with Retry-After only after authorization', async () => {
    for (const keepPort of [false, true]) {
        resetWorkspace({ publicationState: 'ready' });
        drainBetaInSources({ keepPort });
        const req = { method: 'GET', url: '/beta/api/items', headers: { host: '127.0.0.1:18080', accept: 'application/json' } };
        const routePlan = resolveEdgeRoutePlan({ req, listener: 'public' });
        assert.equal(routePlan.ok, true);
        assert.equal(routePlan.kind, 'agent-root-pending');
        assert.equal(routePlan.target, null, 'a drained route never targets its predecessor, even with a kept port');
        assert.equal(routePlan.diagnosticCategory, 'AGENT_ROUTE_DRAINING');

        const denied = new RecordingResponse();
        let accessChecks = 0;
        assert.equal(await dispatchAgentStartupAfterRouterSurfaces({
            req,
            res: denied,
            parsedUrl: routePlan.parsedUrl,
            routePlan,
            ensureRouteAccess: async (_req, res) => {
                accessChecks += 1;
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end('{"error":"authentication_required"}');
                return { ok: false };
            },
        }), true);
        assert.equal(accessChecks, 1);
        assert.equal(denied.statusCode, 401, 'an unauthorized caller learns nothing about the drain');

        const allowed = new RecordingResponse();
        assert.equal(await dispatchAgentStartupAfterRouterSurfaces({
            req,
            res: allowed,
            parsedUrl: routePlan.parsedUrl,
            routePlan,
            ensureRouteAccess: async () => ({ ok: true }),
        }), true);
        assert.equal(allowed.statusCode, 503);
        assert.equal(allowed.headers['Retry-After'], '2');
        assert.deepEqual(JSON.parse(allowed.body), { error: 'AGENT_ROUTE_DRAINING' });
    }
});

test('D5 other transports, relays and dependency selection keep excluding a draining route', () => {
    resetWorkspace({ publicationState: 'ready' });
    drainBetaInSources();
    const ws = resolveEdgeRoutePlan({
        req: { method: 'GET', url: '/beta/socket', headers: { host: '127.0.0.1:18080' } },
        listener: 'public',
        transport: 'websocket',
    });
    assert.equal(ws.ok, false);
    assert.equal(ws.status, 503);
    assert.equal(ws.code, 'AGENT_ROUTE_DRAINING');
    assert.equal(ws.retryAfterSeconds, 2);

    const relay = routePlanFor('127.0.0.1:18080', '/base-agent-additional-server/beta/7000/');
    assert.equal(relay.ok, false);
    assert.equal(relay.code, 'AGENT_OWNER_INACTIVE');

    const other = routePlanFor('127.0.0.1:18080', '/gamma/');
    assert.equal(other.kind, 'agent-root');
    assert.equal(other.target.hostPort, 43103);
});
