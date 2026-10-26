import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A6: a host-network agent with a fixed host mapping rotates under its own
// name. While its replacement is launching (paused here before readiness),
// sign-in, token and every other agent stay served from an active generation;
// only the rotating agent answers a retryable 503. After the commit its route
// targets the replacement's port and identity.

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-scoped-restart-'));
const previous = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    PLOINKY_MEDIA_HOST_PORT: process.env.PLOINKY_MEDIA_HOST_PORT,
};
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const routingFile = await import('../../cli/server/routingFile.js');
const { withNetworkLifecycleLock } = await import('../../cli/sandbox/networkLifecycle.js');
const { coordinateReplacementRuntimeIdentity } = await import('../../cli/sandbox/docker/agentServiceManager.js');
const { resolveEdgeRoutePlan } = await import('../../cli/server/edgeRoutePlan.js');
const { dispatchAgentStartupAfterRouterSurfaces } = await import('../../cli/server/agentStartupDispatch.js');
const { saveAgents } = await import('../../cli/utils/workspace.js');
const { prepareTargetedAgentRestart, commitTargetedAgentRestart } = await import('../../cli/commands/targetedAgentRestart.js');
const { withEdgeSelectionObserver } = await import('../../cli/sandbox/edgeSelectionMutations.mjs');
const { reconcileExactHardwareInstance } = await import('../../cli/sandbox/hardwareLimits/reconcile.mjs');
const { HardwareLimitsError } = await import('../../cli/sandbox/hardwareLimits/errors.mjs');
const { refusalOutcome } = await import('./hardwareAvailabilityFixtures.mjs');

test.after(() => {
    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

const ploinkyDir = path.join(workspace, '.ploinky');
const repoDir = path.join(ploinkyDir, 'repos', 'media');
const PUBLIC_HOST = 'app.example.com';
const CONTROL_HOST = '127.0.0.1:18080';

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function record(agentName) {
    return {
        type: 'agent',
        repoName: 'media',
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-generation`,
        profile: 'default',
        auth: { mode: 'sso' },
    };
}

function seedWorkspace({ predecessorId } = {}) {
    fs.rmSync(ploinkyDir, { recursive: true, force: true });
    writeJson(path.join(repoDir, 'agentA', 'manifest.json'), { container: 'node:20-alpine', network: { mode: 'host' } });
    writeJson(path.join(repoDir, 'agentB', 'manifest.json'), { container: 'node:20-alpine' });
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        routes: {
            agentA: { repo: 'media', agent: 'agentA', container: 'agentA-container', hostPath: path.join(repoDir, 'agentA'), hostPort: 7880 },
            agentB: { repo: 'media', agent: 'agentB', container: 'agentB-container', hostPath: path.join(repoDir, 'agentB'), hostPort: 41002 },
        },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        'agentA-container': record('agentA'),
        'agentB-container': { ...record('agentB'), ...(predecessorId ? { containerId: predecessorId, runtime: 'podman' } : {}) },
    });
    writeJson(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), {
        hosts: { [PUBLIC_HOST]: { agent: 'media/agentB', routerSurfaces: ['browser-auth'] } },
        cloudflare: { tunnelTokenSecret: 'cloudflare/tunnel-token' },
    });
    writeJson(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });
    edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'a6-fixture', publicationState: 'ready' });
}

function plan(host, url) {
    return resolveEdgeRoutePlan({ req: { method: 'GET', url, headers: { host, accept: 'application/json' } }, listener: 'public' });
}

// A control-host path the edge does not plan is served by the Router itself.
function servedByRouter(routePlan) {
    return routePlan.ok === true
        || (routePlan.code === 'ROUTE_NOT_FOUND' && routePlan.hostSelection?.kind === 'control');
}

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

test('A6 a host-network fixed-port restart withdraws only the restarting agent until its replacement commits', async () => {
    seedWorkspace();
    const before = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    const existingRecord = before.generation.agents['agentA-container'];

    const rotated = await withNetworkLifecycleLock((networkLifecycleCapability) => coordinateReplacementRuntimeIdentity({
        containerName: 'agentA-container',
        existingRecord,
        reason: 'a6-host-restart',
        networkLifecycleCapability,
        runtimeNetwork: { mode: 'host' },
        portMappings: [{ containerPort: 7880, hostPort: 7880 }],
    }));

    // The replacement is launching; nothing has committed it yet.
    const login = plan(PUBLIC_HOST, '/auth/login');
    const token = plan(PUBLIC_HOST, '/auth/token');
    const other = plan(CONTROL_HOST, '/agentB/');
    const health = plan(CONTROL_HOST, '/health');
    const restarting = plan(CONTROL_HOST, '/agentA/');
    for (const [label, routePlan] of [['/auth/login', login], ['/auth/token', token], ['/agentB/', other]]) {
        assert.equal(routePlan.ok, true, `${label} stays served: ${routePlan.code || routePlan.kind}`);
    }
    assert.equal(other.kind, 'agent-root');
    assert.equal(other.target.hostPort, 41002);
    assert.equal(servedByRouter(health), true, `/health reaches the Router: ${health.code || health.kind}`);
    assert.equal(restarting.ok, true, `/agentA/ is planned: ${restarting.code || restarting.kind}`);
    assert.equal(restarting.kind, 'agent-root-pending');
    assert.equal(restarting.target, null);
    assert.equal(restarting.diagnosticCategory, 'AGENT_ROUTE_DRAINING');
    const res = new RecordingResponse();
    await dispatchAgentStartupAfterRouterSurfaces({
        req: { method: 'GET', url: '/agentA/', headers: { host: CONTROL_HOST, accept: 'application/json' } },
        res,
        parsedUrl: restarting.parsedUrl,
        routePlan: restarting,
        ensureRouteAccess: async () => ({ ok: true }),
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['Retry-After'], '2');
    assert.equal(JSON.parse(res.body).error, 'AGENT_ROUTE_DRAINING');

    const selector = edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector;
    assert.equal(selector.state, 'active');
    assert.equal(selector.publicationState, 'ready', 'the public host keeps its ready publication');

    // The replacement became ready on a new port: publish it with its lease.
    const replacement = {
        ...rotated.preparedRegistryRecord,
        containerId: 'c'.repeat(64),
        runtime: 'podman',
    };
    await routingFile.mergeRoutingConfig((current) => {
        saveAgents({ ...JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8')), 'agentA-container': replacement }, { coordinate: false });
        current.routes.agentA = routingFile.mergeRuntimeRoute(current.routes.agentA, {
            container: 'agentA-container',
            hostPath: path.join(repoDir, 'agentA'),
            repo: 'media',
            agent: 'agentA',
        }, { hostPort: 7881 });
        return current;
    }, { reason: 'a6-replacement-ready', preparationLease: rotated.preparationLease });

    const committed = plan(CONTROL_HOST, '/agentA/');
    assert.equal(committed.kind, 'agent-root');
    assert.equal(committed.target.hostPort, 7881);
    const after = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(after.generation.agents['agentA-container'].instanceId, rotated.instanceId);
    assert.notEqual(rotated.instanceId, existingRecord.instanceId);
    assert.equal(after.generation.routing.routes.agentA.draining, undefined);
    assert.equal(after.generation.routing.routes.agentA.drainOwner, undefined);
    assert.equal(after.selector.publicationState, 'ready');
    assert.equal(plan(PUBLIC_HOST, '/auth/login').ok, true);
});

for (const scenario of ['no prior drain', 'wrong accepted ID', 'valid prior refusal']) {
    test(`scoped targeted restart acceptance: ${scenario}`, async () => {
        const predecessorId = 'a'.repeat(64);
        seedWorkspace({ predecessorId });
        const agentRecord = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }).generation.agents['agentB-container'];
        const prepare = (acceptedFailedDrain) => withNetworkLifecycleLock((networkLifecycleCapability) => (
            prepareTargetedAgentRestart({
                containerName: 'agentB-container', routeKey: 'agentB', repoName: 'media', shortAgentName: 'agentB',
                record: agentRecord, networkLifecycleCapability, acceptedFailedDrain,
            }, { mergeRouting() { throw new Error('the scoped transaction must not fall back'); } })
        ));
        if (scenario !== 'no prior drain') await prepare(null);
        const before = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
        const routingBefore = fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8');
        const registryBefore = fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8');
        const writes = [];
        const acceptedFailedDrain = { containerId: scenario === 'wrong accepted ID' ? 'b'.repeat(64) : predecessorId };
        await withEdgeSelectionObserver((entry) => writes.push(entry), async () => {
            if (scenario === 'valid prior refusal') {
                const transition = await prepare(acceptedFailedDrain);
                assert.deepEqual(transition.targetedRestart.acceptedFailedDrain, acceptedFailedDrain);
                assert.equal(transition.predecessorRoute.draining, undefined);
            } else {
                await assert.rejects(prepare(acceptedFailedDrain), scenario === 'no prior drain'
                    ? /has no refused targeted drain to accept/ : /is not the registered predecessor/);
            }
        });
        const after = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
        if (scenario === 'valid prior refusal') {
            assert.equal(after.generation.routing.routes.agentB.draining, true);
            assert.deepEqual(after.generation.agents['agentB-container'], agentRecord);
            assert.equal(after.selector.state, 'active');
            assert.deepEqual(after.selector, before.selector, 'accepting an already selected drain is idempotent');
            assert.ok(writes.every((entry) => entry.after.state === 'active'));
        } else {
            assert.deepEqual(after, before, 'rejection preserves the exact selected generation');
            assert.equal(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8'), routingBefore);
            assert.equal(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8'), registryBefore);
            assert.deepEqual(writes, [], 'rejection must precede every routing selector mutation');
        }
        assert.equal(plan(CONTROL_HOST, '/agentA/').target.hostPort, 7880);
    });
}

test('W8 a targeted restart drains and reopens its route active to active, keeping its identity', async () => {
    seedWorkspace();
    const before = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    const agentRecord = before.generation.agents['agentB-container'];
    const writes = [];
    const transition = await withEdgeSelectionObserver((entry) => writes.push(entry), () => withNetworkLifecycleLock(
        (networkLifecycleCapability) => prepareTargetedAgentRestart({
            containerName: 'agentB-container',
            routeKey: 'agentB',
            repoName: 'media',
            shortAgentName: 'agentB',
            record: agentRecord,
            networkLifecycleCapability,
        }),
    ));
    const drained = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(drained.generation.routing.routes.agentB.draining, true);
    assert.equal(drained.generation.routing.routes.agentB.drainOwner, undefined, 'an operator drain records no owner');
    assert.equal(plan(CONTROL_HOST, '/agentB/').diagnosticCategory, 'AGENT_ROUTE_DRAINING');
    assert.equal(plan(CONTROL_HOST, '/agentA/').target.hostPort, 7880, 'every other route stays served');
    // agentB is this public host's root: its own host stays unavailable, but
    // retryably, while it restarts (root availability is out of scope).
    const rootHost = plan(PUBLIC_HOST, '/auth/login');
    assert.equal(rootHost.code, 'HOST_SELECTOR_INACTIVE');
    assert.equal(rootHost.retryAfterSeconds, 2);

    await withEdgeSelectionObserver((entry) => writes.push(entry), () => withNetworkLifecycleLock(
        (networkLifecycleCapability) => commitTargetedAgentRestart({
            transition,
            result: {
                containerName: 'agentB-container',
                hostPort: 41012,
                registryRecord: { ...agentRecord, containerId: 'd'.repeat(64), runtime: 'podman' },
            },
            agentPath: path.join(repoDir, 'agentB'),
            networkLifecycleCapability,
        }, { retireEntriesAfterApply: async () => {} }),
    ));
    assert.ok(writes.length >= 2);
    assert.deepEqual([...new Set(writes.map((entry) => entry.after.state))], ['active'],
        'neither the drain nor the reopen writes the selector inactive');
    const reopened = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(reopened.generation.routing.routes.agentB.draining, undefined);
    assert.equal(reopened.generation.routing.routes.agentB.hostPort, 41012);
    assert.equal(reopened.generation.agents['agentB-container'].instanceId, agentRecord.instanceId);
    assert.equal(reopened.selector.publicationState, 'ready');
});

function refusedReconcile(withdrawUnavailable) {
    const record = { type: 'agent', repoName: 'media', agentName: 'agentB', instanceId: 'agentB-instance', enableGeneration: 'agentB-generation', containerId: 'a'.repeat(64) };
    const events = [];
    const run = reconcileExactHardwareInstance({ key: 'agentB-container', record }, {
        origin: 'apply', expectedToken: { epoch: 'e'.repeat(32), revision: 1 },
    }, {
        maintenance: (_key, _options, callback) => callback(),
        network: (callback) => callback(Object.freeze({ fixture: 'network' })),
        loadRegistry: () => ({ 'agentB-container': record }),
        loadPlan: () => ({ runtime: 'podman', manifest: {}, runtimeAdmission: { descriptor: {} }, profileResolution: { network: { mode: 'default' } }, agentPath: repoDir }),
        readPolicy: () => ({ token: { epoch: 'e'.repeat(32), revision: 1 } }),
        policyCheck: () => true,
        loadRouting: () => ({ routes: {} }),
        ensure: async () => { throw new HardwareLimitsError(refusalOutcome('agentB-container', { ref: 'media/agentB' })); },
        cleanupPrepared: () => {},
        withdrawUnavailable: async (input) => { events.push(['withdraw', input.containerName, input.projection.key]); return withdrawUnavailable(input); },
        publishUnavailable: async () => { events.push(['publish']); },
        retireUnavailable: () => { events.push(['retire']); },
    });
    return { run, events };
}

test('W9 a hardware refusal marks only the refused runtime unavailable through a withdrawal', async () => {
    const { run, events } = refusedReconcile(async () => ({ selector: { state: 'active' } }));
    await assert.rejects(run, (error) => error instanceof HardwareLimitsError);
    assert.deepEqual(events, [['withdraw', 'agentB-container', 'agentB-container'], ['retire']]);

    const fallback = refusedReconcile(async () => { throw Object.assign(new Error('not a subset'), { code: 'EDGE_WITHDRAWAL_NOT_SUBSET' }); });
    await assert.rejects(fallback.run, (error) => error instanceof HardwareLimitsError);
    assert.deepEqual(fallback.events, [['withdraw', 'agentB-container', 'agentB-container'], ['publish'], ['retire']],
        'a withdrawal that cannot be proven falls back to the inactive merge');
});
