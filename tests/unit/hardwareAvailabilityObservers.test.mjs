// M-NW-01 D2-S, LS7: every observer and transport agrees with the one resolver,
// in the typed and in the generic cases, and a slotted run's navigation/probe
// observer never derives a hardware result from its own status (D2S.15).
// Real workspace, real edge generations, real durable store, real route plans
// and dispatcher; statuses are written by the real worker writer.
import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchAgentStartupAfterRouterSurfaces } from '../../cli/server/agentStartupDispatch.js';
import { AGENT_STARTUP_PROBE_HEADER } from '../../cli/server/agentStartupPage.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { authorizePrivateRoutePlan } from '../../cli/server/privateRouter.js';
import { createAgentRouteEntries } from '../../cli/server/routerHandlers.js';
import { resolveNoWaitAgentStartupState } from '../../cli/server/noWaitAgentStartupState.js';
import { handleHardwareLimitsRoutes } from '../../cli/server/authHandlers/hardwareLimitsRoutes.mjs';
import { availabilityForcesNotReady, metricHardwareAvailability } from '../../cli/server/workspaceMetricsAvailability.mjs';
import { readStoreAvailabilityProjections } from '../../cli/server/hardwareAvailabilityProjections.mjs';
import { containerOf, entryFor, makeWorld, refusalOutcome } from './hardwareAvailabilityResolverFixtures.mjs';

const HOST = '127.0.0.1:18080';
const CAUSE = /Hardware limits are off for this workspace/;
const NAVIGATION = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };

function quiet(t) {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
}

class MockResponse {
    constructor() { this.statusCode = 0; this.headers = {}; this.body = ''; }
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = { ...headers }; }
    end(body = '') { this.body += body === undefined ? '' : String(body); }
}

// The server-rendered state of a startup document: the attribute on its root element and its message text
// (the page's own script text mentions every state and is not evidence of any).
function pageOf(html) {
    const root = /<main id="agent-startup-root"[^>]*data-ploinky-agent-startup-page="([^"]*)"/.exec(html);
    const message = /<p id="agent-startup-message">([^<]*)<\/p>/.exec(html);
    return { state: root ? root[1] : null, message: message ? message[1] : null };
}

function request(routeKey, { pathname = '/api/data', method = 'GET', accept = 'application/json', extra = {} } = {}) {
    return { method, url: `/${routeKey}${pathname}`, headers: { host: HOST, accept, ...extra } };
}

// One request through the real plan and the real dispatcher.
async function dispatch(req, { resolveStartupState, plan = resolveEdgeRoutePlan({ req, listener: 'public' }) } = {}) {
    const res = new MockResponse();
    const reads = [];
    const handled = await dispatchAgentStartupAfterRouterSurfaces({
        req, res, parsedUrl: plan.parsedUrl, routePlan: plan,
        ensureRouteAccess: async () => ({ ok: true }),
        inspectPublication: () => ({ ok: true, canPublishHttp: true }),
        resolveStartupState: resolveStartupState || (async () => { reads.push(1); return { state: 'starting' }; }),
    });
    const body = res.body.startsWith('{') ? JSON.parse(res.body) : null;
    return { handled, res, plan, body, status: res.statusCode, reads: reads.length };
}

const privateRequest = (routeKey) => ({ method: 'GET', url: `/base-agent-additional-server/${routeKey}/7001/status`, headers: { host: HOST }, ploinkyListenerClass: 'private' });

function token(payload) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'HS256' })}.${encode(payload)}.c2ln`;
}

function callerCode(world, routeKey) {
    const plan = resolveEdgeRoutePlan({ req: privateRequest('beta'), listener: 'private' });
    assert.equal(plan.ok, true, plan.code);
    const req = {
        method: 'GET',
        headers: { 'ploinky-agent-assertion': token({ iss: `agent:fixtures/${routeKey}`, instanceId: `${routeKey}-instance`, enableGeneration: `${routeKey}-generation` }) },
    };
    try {
        authorizePrivateRoutePlan({ req, plan: { ...plan, access: { access: 'authenticated' } } });
        return null;
    } catch (error) {
        return error.code || null;
    }
}

// Admin and readiness projections through the real default reader of the store's denials.
function observerState(world, routeKey) {
    const key = containerOf(routeKey);
    const record = world.readAgents()[key];
    const projections = readStoreAvailabilityProjections(world.options);
    const readiness = metricHardwareAvailability({ containerName: key, state: { status: 'unknown', ready: true, running: true } }, record, world.readRouting(), projections);
    return { projections, readiness, readyForced: availabilityForcesNotReady(readiness.availability) };
}

async function adminAgent(world, routeKey) {
    const key = containerOf(routeKey);
    let body = null;
    const req = { method: 'GET', headers: { host: '127.0.0.1:8080' }, socket: {}, user: { id: 'admin', roles: ['admin'] } };
    const res = { writeHead() {}, end(value) { body = JSON.parse(value); } };
    // getStoreProjections is deliberately NOT injected: the production default reads the store's denials for the active generation.
    await handleHardwareLimitsRoutes(req, res, new URL('http://127.0.0.1:8080/api/marketplace/hardware-limits'), {
        ensureAdmin: async () => true,
        verifyMutation: () => ({ ok: false }),
        getContext: () => ({ overrides: new Map(), gate: 'on', prepared: true, storeState: 'valid', storeToken: 'x'.repeat(8) }),
        getInstalled: () => [{ ref: `fixtures/${routeKey}`, manifestPath: '/none' }],
        getRegistry: () => world.readAgents(),
        getRouting: () => world.readRouting(),
        getMetrics: () => null,
        admit: () => ({ descriptor: {} }),
        readApplied: () => null,
    });
    return body.agents[0].containers.find((container) => container.key === key);
}

function assertTypedEverywhere(world, label) {
    return (async () => {
        const alphaApi = await dispatch(request('alpha'));
        assert.equal(alphaApi.plan.kind, 'agent-root-pending', label);
        assert.equal(alphaApi.plan.target, null, `${label}: nothing to forward`);
        assert.equal(alphaApi.reads, 0, `${label}: no startup observation (the dispatcher short-circuits on the plan's entry, E113)`);
        assert.equal(alphaApi.status, 503);
        assert.equal(alphaApi.body.error, 'AGENT_HARDWARE_UNAVAILABLE');
        assert.equal(alphaApi.body.code, 'hardware_refused');
        assert.match(alphaApi.body.reason, CAUSE);
        const post = await dispatch(request('alpha', { method: 'POST' }));
        assert.equal(post.body.error, 'AGENT_HARDWARE_UNAVAILABLE', `${label}: HTTP POST`);
        const sse = await dispatch(request('alpha', { pathname: '/events', accept: 'text/event-stream' }));
        assert.equal(sse.body.error, 'AGENT_HARDWARE_UNAVAILABLE', `${label}: SSE`);
        const mcp = await dispatch(request('alpha', { pathname: '/mcp', method: 'POST' }));
        assert.equal(mcp.status, 503, `${label}: /<agent>/mcp`);
        assert.equal(mcp.body.error, 'AGENT_HARDWARE_UNAVAILABLE');
        assert.match(mcp.body.reason, CAUSE, `${label}: causal text on /<agent>/mcp`);
        const navigation = await dispatch(request('alpha', { pathname: '/', accept: 'text/html', extra: NAVIGATION }));
        assert.equal(navigation.status, 503, `${label}: navigation`);
        assert.equal(pageOf(navigation.res.body).state, 'unavailable');
        assert.match(pageOf(navigation.res.body).message, CAUSE);
        assert.equal(navigation.reads, 0);
        const probe = await dispatch(request('alpha', { extra: { [AGENT_STARTUP_PROBE_HEADER]: '1' } }));
        assert.equal(probe.status, 503, `${label}: probe`);
        assert.equal(probe.body.state, 'unavailable');
        assert.equal(probe.body.code, 'hardware_refused');
        assert.match(probe.body.message, CAUSE);
        assert.equal(probe.reads, 0);
        const ws = resolveEdgeRoutePlan({ req: request('alpha', { pathname: '/ws' }), listener: 'public', transport: 'websocket' });
        assert.equal(ws.ok, false, `${label}: public WebSocket`);
        assert.equal(ws.code, 'AGENT_HARDWARE_UNAVAILABLE');
        assert.equal(ws.status, 503);
        const privateHttp = resolveEdgeRoutePlan({ req: privateRequest('alpha'), listener: 'private' });
        assert.equal(privateHttp.code, 'AGENT_HARDWARE_UNAVAILABLE', `${label}: private HTTP`);
        const privateWs = resolveEdgeRoutePlan({ req: privateRequest('alpha'), listener: 'private', transport: 'websocket' });
        assert.equal(privateWs.code, 'AGENT_HARDWARE_UNAVAILABLE', `${label}: private WebSocket`);
        assert.equal(callerCode(world, 'alpha'), 'PRIVATE_CALLER_HARDWARE_UNAVAILABLE', `${label}: private caller`);
        const admin = await adminAgent(world, 'alpha');
        assert.equal(admin.availability, 'refused', `${label}: admin`);
        assert.equal(admin.problem.reasonCode, 'gate_off');
        assert.match(admin.problem.reason, CAUSE);
        const state = observerState(world, 'alpha');
        assert.equal(state.readiness.availability, 'refused', `${label}: readiness`);
        assert.equal(state.readyForced, true, `${label}: ready:false`);
        // Unrelated agents: the targeted beta is routable and ready, the target-less gamma stays generic.
        const beta = resolveEdgeRoutePlan({ req: request('beta'), listener: 'public' });
        assert.equal(beta.kind, 'agent-root');
        assert.deepEqual(beta.target, { hostname: '127.0.0.1', hostPort: 43102 });
        assert.equal(observerState(world, 'beta').readyForced, false);
        assert.equal(callerCode(world, 'beta'), callerCode(world, 'beta'));
        assert.notEqual(callerCode(world, 'beta'), 'PRIVATE_CALLER_HARDWARE_UNAVAILABLE');
        const gamma = await dispatch(request('gamma'));
        assert.equal(gamma.body.error, 'TARGET_INACTIVE', `${label}: unrelated target-less agent stays generic`);
    })();
}

// The generic disposition (D2S.14): target-less, nothing forwarded, no hardware code anywhere.
async function assertGenericEverywhere(world, label) {
    const api = await dispatch(request('alpha'));
    assert.equal(api.plan.kind, 'agent-root-pending', label);
    assert.equal(api.plan.hardwareAvailability, undefined, `${label}: no store-derived denial`);
    assert.equal(api.plan.target, null);
    assert.equal(api.status, 503);
    assert.deepEqual(api.body, { error: 'TARGET_INACTIVE' }, `${label}: HTTP API`);
    assert.deepEqual((await dispatch(request('alpha', { pathname: '/events', accept: 'text/event-stream' }))).body, { error: 'TARGET_INACTIVE' }, `${label}: SSE`);
    assert.deepEqual((await dispatch(request('alpha', { pathname: '/mcp', method: 'POST' }))).body, { error: 'TARGET_INACTIVE' }, `${label}: /<agent>/mcp`);
    const navigation = await dispatch(request('alpha', { pathname: '/', accept: 'text/html', extra: NAVIGATION }));
    assert.equal(pageOf(navigation.res.body).state, 'starting', `${label}: navigation`);
    assert.doesNotMatch(pageOf(navigation.res.body).message, /Hardware limits/, `${label}: navigation shows no hardware text`);
    const probe = await dispatch(request('alpha', { extra: { [AGENT_STARTUP_PROBE_HEADER]: '1' } }));
    assert.equal(probe.body.state, 'starting', `${label}: probe`);
    const ws = resolveEdgeRoutePlan({ req: request('alpha', { pathname: '/ws' }), listener: 'public', transport: 'websocket' });
    assert.deepEqual([ws.ok, ws.status, ws.code], [false, 503, 'TARGET_INACTIVE'], `${label}: public WebSocket`);
    const privateHttp = resolveEdgeRoutePlan({ req: privateRequest('alpha'), listener: 'private' });
    assert.deepEqual([privateHttp.ok, privateHttp.status, privateHttp.code], [false, 503, 'AGENT_RUNTIME_INACTIVE'], `${label}: private HTTP`);
    const privateWs = resolveEdgeRoutePlan({ req: privateRequest('alpha'), listener: 'private', transport: 'websocket' });
    assert.deepEqual([privateWs.ok, privateWs.code], [false, 'AGENT_RUNTIME_INACTIVE'], `${label}: private WebSocket`);
    assert.notEqual(callerCode(world, 'alpha'), 'PRIVATE_CALLER_HARDWARE_UNAVAILABLE', `${label}: private caller`);
    const admin = await adminAgent(world, 'alpha');
    assert.notEqual(admin.availability, 'refused', `${label}: admin`);
    assert.equal(admin.problem, null);
    const state = observerState(world, 'alpha');
    assert.equal(state.readiness.problem, null, `${label}: readiness`);
    assert.equal(state.projections.size, 0);
    assert.equal(state.readiness.availability, 'ready', 'no hardware availability change: the state is the runtime\'s own');
}

test('NW1.S-observers-and-transports-agree-in-typed-and-generic-cases', async (t) => {
    quiet(t);
    // ---- typed: validated active evidence
    {
        const world = makeWorld(t);
        const slot = world.stageSlot('alpha');
        world.writeWorker('alpha', slot, { kind: 'hardware' });
        await assertTypedEverywhere(world, 'active');
        // Router aggregate /mcp: target-less agents (typed or generic) are omitted and nothing is forwarded; targeted agents are listed.
        const plan = resolveEdgeRoutePlan({ req: { method: 'POST', url: '/mcp', headers: { host: HOST } }, listener: 'public' });
        const entries = createAgentRouteEntries(plan);
        assert.deepEqual(entries.map((entry) => entry.agentName), ['beta'], 'aggregate /mcp lists only the targeted agent');
        assert.ok(entries.every((entry) => /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(entry.baseUrl)));
    }
    // ---- typed: a latched committed entry (the same cause, no slot)
    {
        const world = makeWorld(t);
        const slot = world.stageSlot('alpha');
        const finishedAtMs = Date.now() - 100;
        world.writeWorker('alpha', slot, { kind: 'hardware', finishedAtMs });
        world.commitStore({
            entries: { ...world.store().entries, alpha: entryFor('alpha', { runId: slot.runId, runStartedAtMs: slot.runStartedAtMs, finishedAtMs }) },
            slots: {},
        });
        await assertTypedEverywhere(world, 'latched entry');
    }
    // ---- generic classes: no store-derived denial on any surface
    const generic = {
        'missing (within the grace)': () => {},
        'missing (past the grace)': () => {},
        pending: (world, slot) => { world.writeWorker('alpha', slot, { kind: 'starting' }); },
        succeeded: (world, slot) => { world.writeWorker('alpha', slot, { kind: 'running' }); },
        unowned: (world, slot) => {
            world.writeWorker('alpha', slot, { kind: 'starting' });
            world.rewriteStatus(slot, (document) => { delete document.pid; });
        },
        'failed-generic': (world, slot) => { world.writeWorker('alpha', slot, { kind: 'generic' }); },
        invalid: (world, slot) => {
            world.writeWorker('alpha', slot, { kind: 'hardware' });
            world.rewriteStatus(slot, () => '{ this is not json');
        },
        'unlatched activation deleted': (world, slot) => {
            world.writeWorker('alpha', slot, { kind: 'hardware' });
            world.removeStatus(slot);
        },
    };
    for (const [label, arrange] of Object.entries(generic)) {
        const world = makeWorld(t);
        const past = label === 'missing (past the grace)';
        const slot = world.stageSlot('alpha', past ? { runStartedAtMs: Date.now() - 10 * 60_000 } : {});
        arrange(world, slot);
        await assertGenericEverywhere(world, label);
    }
    // ---- slotted runs: navigation/probe forgeries are generic and never typed (D2S.15)
    await slottedForgeries(t);
});

// Slotted runs: the navigation/probe observer reads a FAILED status that the resolver refused.
function slottedObserver(world, plan, status, { slotted = true } = {}) {
    const key = containerOf('alpha');
    const record = world.readAgents()[key];
    const subject = slotted ? plan : {
        ...plan,
        lease: { ...plan.lease, effective: { ...plan.lease.effective, slots: new Map() } },
    };
    return (req, res) => dispatchAgentStartupAfterRouterSurfaces({
        req, res, parsedUrl: subject.parsedUrl, routePlan: subject,
        ensureRouteAccess: async () => ({ ok: true }),
        inspectPublication: () => ({ ok: true, canPublishHttp: true }),
        resolveStartupState: async (capturedPlan) => resolveNoWaitAgentStartupState(capturedPlan, {
            inspectPublication: () => ({ ok: true, canPublishHttp: true, containerName: key, record }),
            readRunMarker: () => ({ runId: world.slotOf('alpha').runId }),
            createRunBinding: () => ({ bound: true }),
            observeRun: () => ({ state: 'failed', record, status }),
        }),
    });
}

async function slottedForgeries(t) {
    const forgeries = {
        'T1 finishedAtMs is not a safe integer': (document) => { document.finishedAtMs = -5; },
        'T2 an ISO field is not the ISO of its ms': (document) => { document.startedAt = new Date(document.startedAtMs).toISOString().replace('.', ','); },
        'T3 the timestamps are not ordered': (document) => {
            document.finishedAtMs = document.startedAtMs - 1;
            document.finishedAt = new Date(document.finishedAtMs).toISOString();
        },
        'T4 finishedAtMs is in the future': (document) => {
            document.finishedAtMs = Date.now() + 3_600_000;
            document.finishedAt = new Date(document.finishedAtMs).toISOString();
        },
        'the outcome key is not the slot key': (document) => {
            document.error.hardwareOutcome = refusalOutcome(containerOf('other'), { ref: 'fixtures/alpha' });
            document.error.code = document.error.hardwareOutcome.code;
        },
        'no own pid': (document) => { delete document.pid; },
    };
    for (const [label, forge] of Object.entries(forgeries)) {
        const world = makeWorld(t);
        world.slotOf = (routeKey) => world.store().slots[routeKey];
        const slot = world.stageSlot('alpha');
        world.writeWorker('alpha', slot, { kind: 'hardware' });
        world.rewriteStatus(slot, (document) => { forge(document); });
        const status = world.readStatus(slot);
        const planFor = (req) => resolveEdgeRoutePlan({ req, listener: 'public' });
        // The resolver refuses the forged evidence: no denial, but the run is slotted.
        const api = planFor(request('alpha'));
        assert.equal(api.hardwareAvailability, undefined, label);
        assert.equal(api.lease.effective.slots.get('alpha').runId, slot.runId, label);
        assert.notEqual(api.lease.effective.slots.get('alpha').evidenceClass, 'active', label);
        for (const [surface, make] of [
            ['navigation', () => request('alpha', { pathname: '/', accept: 'text/html', extra: NAVIGATION })],
            ['probe', () => request('alpha', { extra: { [AGENT_STARTUP_PROBE_HEADER]: '1' } })],
        ]) {
            const req = make();
            const plan = planFor(req);
            const res = new MockResponse();
            await slottedObserver(world, plan, status)(req, res);
            const text = res.body;
            assert.equal(res.statusCode, 503, `${label} ${surface}`);
            if (surface === 'navigation') {
                assert.equal(pageOf(text).state, 'failed', `${label} navigation: startup_failed`);
                assert.doesNotMatch(pageOf(text).message, /Hardware limits|hardware/i);
            } else {
                assert.deepEqual([JSON.parse(text).state, JSON.parse(text).code], ['failed', 'startup_failed'], `${label} probe: startup_failed`);
                assert.doesNotMatch(text, /Hardware limits|hardware_refused|hardware_blocked|gate_off/);
            }
            // The API surface of the same plan: 503 TARGET_INACTIVE.
            const apiResult = await dispatch(request('alpha'));
            assert.deepEqual(apiResult.body, { error: 'TARGET_INACTIVE' }, `${label} API`);
        }
        // Control: the SAME status with the run NOT slotted (a legacy or parent-known run) still reaches the status-derived
        // observer, which types it. That is exactly the path the slot rule closes, so every forgery above is detectable.
        const req = request('alpha', { extra: { [AGENT_STARTUP_PROBE_HEADER]: '1' } });
        const plan = planFor(req);
        const res = new MockResponse();
        await slottedObserver(world, plan, status, { slotted: false })(req, res);
        const control = JSON.parse(res.body);
        assert.deepEqual([control.state, control.code], ['unavailable', 'hardware_refused'], `${label}: non-slotted control`);
    }
}
