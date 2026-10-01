import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { dispatchAgentStartupAfterRouterSurfaces } from '../../cli/server/agentStartupDispatch.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { authorizePrivateRoutePlan } from '../../cli/server/privateRouter.js';
import {
    buildAvailabilityProjection,
    identityHardwareUnavailable,
    markRouteHardwareUnavailable,
    repairClosurePlan,
} from '../../cli/server/hardwareAvailability.mjs';
import { mergeRuntimeRoute } from '../../cli/server/routingFile.js';
import {
    mapNoWaitObservationForMarketplace,
    resolveNoWaitAgentStartupState,
} from '../../cli/server/noWaitAgentStartupState.js';
import { buildDirectRefusal } from '../../cli/sandbox/hardwareLimits/requestedLimits.mjs';
import { availabilityEdge, classifyAvailability, summarizeStartResult } from '../../cli/sandbox/hardwareLimits/outcomes.mjs';
import {
    HARDWARE_UNENFORCEABLE,
    findHardwareOutcome,
    wrapPreservingHardwareCause,
    HardwareLimitsError,
} from '../../cli/sandbox/hardwareLimits/errors.mjs';
import { printStartResultSummary } from '../../cli/commands/workspaceUtil.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

class MockResponse {
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

function writeJson(target, value) {
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function refusal(key, ref = 'fixtures/alpha') {
    return buildDirectRefusal({
        key,
        ref,
        refusalParts: {
            reasonCode: 'gate_off',
            reason: 'Hardware limits are off for this workspace.',
            fix: 'On the host run PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart, or remove the declared limit.',
            requested: [{ field: 'memory', value: '512m', source: 'manifest' }],
        },
        inputFingerprint: 'a'.repeat(64),
    });
}

// One real edge generation: alpha is refused (target-less, unavailable),
// beta is an unrelated ready runtime, and a desired host still names alpha.
function createFixture(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-availability-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const alphaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    const betaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'beta');
    for (const directory of [edgeDir, policyDir, alphaDir, betaDir]) fs.mkdirSync(directory, { recursive: true });
    const manifest = {
        routerAccess: {
            httpRoutes: [{ path: '/public.html', access: 'public' }],
            agentPorts: true,
        },
    };
    writeJson(path.join(alphaDir, 'manifest.json'), manifest);
    writeJson(path.join(betaDir, 'manifest.json'), manifest);
    const projection = buildAvailabilityProjection({
        outcome: refusal('alpha-container'),
        instanceId: 'alpha-instance',
        enableGeneration: 'alpha-enable-generation',
        observedAt: '2026-10-01T12:00:00.000Z',
    });
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        static: { agent: 'alpha', port: 7777 },
        routes: {
            alpha: markRouteHardwareUnavailable({
                repo: 'fixtures', agent: 'alpha', container: 'alpha-container', hostPath: alphaDir, hostPort: 43101,
            }, projection),
            beta: {
                repo: 'fixtures', agent: 'beta', container: 'beta-container', hostPath: betaDir, hostPort: 43102,
            },
        },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        'alpha-container': {
            type: 'agent', repoName: 'fixtures', agentName: 'alpha', instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation', profile: 'default', auth: { mode: 'sso' },
        },
        'beta-container': {
            type: 'agent', repoName: 'fixtures', agentName: 'beta', instanceId: 'beta-instance',
            enableGeneration: 'beta-enable-generation', profile: 'default', auth: { mode: 'sso' },
            runtime: 'podman', containerId: 'b'.repeat(64),
        },
    });
    writeJson(path.join(edgeDir, 'desired.json'), {
        hosts: {
            'alpha.example.test': { agent: 'fixtures/alpha', routerSurfaces: ['agent-mcp', 'browser-auth'] },
        },
        cloudflare: { tunnelTokenSecret: 'publication/test-connector' },
    });
    writeJson(path.join(policyDir, 'policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    const previous = {
        root: process.env.PLOINKY_WORKSPACE_ROOT,
        router: process.env.PLOINKY_ROUTER_HOST_PORT,
        media: process.env.PLOINKY_MEDIA_HOST_PORT,
    };
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
    t.after(() => {
        for (const [key, value] of [['PLOINKY_WORKSPACE_ROOT', previous.root], ['PLOINKY_ROUTER_HOST_PORT', previous.router], ['PLOINKY_MEDIA_HOST_PORT', previous.media]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'hardware-availability', publicationState: 'ready' });
    return { workspace, generation: applied.selector.generation };
}

function request({ routeKey = 'alpha', pathname = '/public.html', accept = 'application/json', extra = {}, host } = {}) {
    return {
        method: 'GET',
        url: host ? pathname : `/${routeKey}${pathname}`,
        headers: { host: host || '127.0.0.1:18080', accept, ...extra },
    };
}

async function dispatch(req, plan) {
    const res = new MockResponse();
    let lifecycleReads = 0;
    const handled = await dispatchAgentStartupAfterRouterSurfaces({
        req,
        res,
        parsedUrl: plan.parsedUrl,
        routePlan: plan,
        ensureRouteAccess: async () => ({ ok: true }),
        inspectPublication: () => ({ ok: true, canPublishHttp: true }),
        resolveStartupState: async () => {
            lifecycleReads += 1;
            return { state: 'starting' };
        },
    });
    return { handled, res, lifecycleReads };
}

test('AV.http', async (t) => {
    createFixture(t);
    const req = request({ pathname: '/api/data' });
    const plan = resolveEdgeRoutePlan({ req, listener: 'public' });
    assert.equal(plan.kind, 'agent-root-pending');
    assert.equal(plan.target, null);
    assert.equal(plan.hardwareAvailability.state, 'refused');
    const { handled, res, lifecycleReads } = await dispatch(req, plan);
    assert.equal(handled, true);
    assert.equal(lifecycleReads, 0, 'no startup observation, no reload loop');
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'AGENT_HARDWARE_UNAVAILABLE');
    assert.equal(body.code, 'hardware_refused');
    assert.match(body.fix, /PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart/);
    // A browser navigation renders a terminal page with the reason and fix.
    const nav = request({ accept: 'text/html', extra: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } });
    const navigation = await dispatch(nav, resolveEdgeRoutePlan({ req: nav, listener: 'public' }));
    assert.equal(navigation.res.statusCode, 503);
    assert.match(navigation.res.body, /data-ploinky-agent-startup-page="unavailable"/);
    assert.match(navigation.res.body, /Hardware limits are off for this workspace/);
    assert.match(navigation.res.body, /id="agent-startup-retry" type="button" hidden/);
});

test('AV.sse', async (t) => {
    createFixture(t);
    const req = request({ pathname: '/events', accept: 'text/event-stream' });
    const plan = resolveEdgeRoutePlan({ req, listener: 'public' });
    const { res } = await dispatch(req, plan);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, 'AGENT_HARDWARE_UNAVAILABLE');
});

test('AV.websocket', (t) => {
    createFixture(t);
    const plan = resolveEdgeRoutePlan({ req: request({ pathname: '/ws' }), listener: 'public', transport: 'websocket' });
    assert.equal(plan.ok, false);
    assert.equal(plan.status, 503);
    assert.equal(plan.code, 'AGENT_HARDWARE_UNAVAILABLE');
});

test('AV.mcp', async (t) => {
    createFixture(t);
    const req = request({ pathname: '/mcp' });
    const plan = resolveEdgeRoutePlan({ req, listener: 'public' });
    const { res, lifecycleReads } = await dispatch(req, plan);
    assert.equal(lifecycleReads, 0);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, 'AGENT_HARDWARE_UNAVAILABLE');
    const dedicated = resolveEdgeRoutePlan({ req: request({ host: 'alpha.example.test', pathname: '/mcp' }), listener: 'public', transport: 'websocket' });
    assert.equal(dedicated.code, 'AGENT_HARDWARE_UNAVAILABLE');
});

function token(payload) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'HS256' })}.${encode(payload)}.c2ln`;
}

test('AV.private-caller', (t) => {
    createFixture(t);
    const plan = resolveEdgeRoutePlan({
        req: { method: 'GET', url: '/base-agent-additional-server/beta/7001/status', headers: { host: '127.0.0.1:18080' }, ploinkyListenerClass: 'private' },
        listener: 'private',
    });
    assert.equal(plan.ok, true, plan.code);
    const req = {
        method: 'GET',
        headers: {
            'ploinky-agent-assertion': token({
                iss: 'agent:fixtures/alpha', instanceId: 'alpha-instance', enableGeneration: 'alpha-enable-generation',
            }),
        },
    };
    assert.throws(
        () => authorizePrivateRoutePlan({ req, plan: { ...plan, access: { access: 'authenticated' } } }),
        { code: 'PRIVATE_CALLER_HARDWARE_UNAVAILABLE' },
    );
});

test('AV.private-target', (t) => {
    createFixture(t);
    const plan = resolveEdgeRoutePlan({
        req: { method: 'GET', url: '/base-agent-additional-server/alpha/7001/status', headers: { host: '127.0.0.1:18080' }, ploinkyListenerClass: 'private' },
        listener: 'private',
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, 'AGENT_HARDWARE_UNAVAILABLE');
    assert.equal(plan.hardwareAvailability.key, 'alpha-container');
});

test('AV.stale-generation', (t) => {
    const { workspace } = createFixture(t);
    // A predecessor's credential cannot stay authorized: the unavailable
    // entry matches its exact instance or generation even under another key.
    const plan = resolveEdgeRoutePlan({ req: request({ routeKey: 'beta' }), listener: 'public' });
    assert.ok(identityHardwareUnavailable(plan.snapshot, { instanceId: 'alpha-instance', routeKey: 'renamed' }));
    assert.ok(identityHardwareUnavailable(plan.snapshot, { enableGeneration: 'alpha-enable-generation' }));
    assert.equal(identityHardwareUnavailable(plan.snapshot, { instanceId: 'beta-instance', routeKey: 'beta' }), null);
    // An availability record bound to a different container cannot compile.
    const routingFile = path.join(workspace, '.ploinky', 'routing.json');
    const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
    routing.routes.alpha.hardwareAvailability = buildAvailabilityProjection({
        outcome: refusal('predecessor-container'),
        instanceId: 'old-instance',
        enableGeneration: 'old-generation',
        observedAt: '2026-10-01T12:00:00.000Z',
    });
    writeJson(routingFile, routing);
    assert.throws(() => applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'stale', publicationState: 'ready' }),
        /availability does not belong to its exact container/);
    // Publishing a runtime target needs a fresh admitted launch, which
    // supersedes the unavailable state; staging never does.
    const staged = mergeRuntimeRoute(routing.routes.alpha, { container: 'alpha-container' }, { hostPort: null });
    assert.ok(staged.hardwareAvailability);
    assert.equal(staged.hostPort, undefined);
});

test('AV.logical-route-preserved', (t) => {
    const { generation } = createFixture(t);
    assert.match(generation, /^sha256:[a-f0-9]{64}$/, 'a desired host naming the refused agent still compiles');
    const plan = resolveEdgeRoutePlan({ req: request({ host: 'alpha.example.test', pathname: '/public.html' }), listener: 'public' });
    assert.equal(plan.routeKey, 'alpha');
    assert.notEqual(plan.code, 'ROUTE_NOT_FOUND');
    assert.equal(plan.snapshot.compiled.hosts['alpha.example.test'].routeKey, 'alpha');
});

test('AV.unrelated-ready', (t) => {
    createFixture(t);
    const plan = resolveEdgeRoutePlan({ req: request({ routeKey: 'beta' }), listener: 'public' });
    assert.equal(plan.kind, 'agent-root');
    assert.deepEqual(plan.target, { hostname: '127.0.0.1', hostPort: 43102 });
    assert.equal(plan.hardwareAvailability, undefined);
});

test('AV.router-controls', (t) => {
    createFixture(t);
    const webtty = resolveEdgeRoutePlan({ req: { method: 'GET', url: '/webtty', headers: { host: '127.0.0.1:18080' } }, listener: 'public' });
    assert.equal(webtty.ok, true);
    assert.notEqual(webtty.code, 'AGENT_HARDWARE_UNAVAILABLE');
    const routing = fs.readFileSync(path.join(REPO_ROOT, 'cli/server/RoutingServer.js'), 'utf8');
    const marketplace = routing.indexOf("if (pathname === '/api/marketplace'");
    const startup = routing.indexOf('dispatchAgentStartupAfterRouterSurfaces({');
    assert.ok(marketplace > 0 && marketplace < startup, 'Router-owned controls precede the agent availability answer');
});

test('AV.explorer-optional-child-ready', () => {
    const result = classifyAvailability({
        nodes: [
            { key: 'explorer', ref: 'demo/explorer', alias: null, refusal: null },
            { key: 'llm', ref: 'demo/llm', alias: null, refusal: refusal('llm', 'demo/llm') },
        ],
        // explorer --optional no-wait--> llm: no blocking edge
        edges: [],
    });
    assert.equal(result.get('explorer').state, 'eligible');
    assert.equal(result.get('llm').state, 'refused');
});

test('AV.degraded-summary', () => {
    const lines = [];
    const degraded = summarizeStartResult({
        readyAgents: [{ key: 'explorer' }],
        refusedAgents: [refusal('llm', 'demo/llm')],
        asynchronousAgents: [{ key: 'other' }],
    });
    assert.equal(degraded.state, 'degraded');
    printStartResultSummary(degraded, { log: (line) => lines.push(line) });
    assert.match(lines[0], /started degraded: 1 agent\(s\) refused and 0 blocked/);
    assert.doesNotMatch(lines.join('\n'), /All selected agents are ready/);
    const starting = summarizeStartResult({ readyAgents: [{ key: 'a' }], asynchronousAgents: [{ key: 'b' }] });
    assert.equal(starting.state, 'starting');
    const ready = summarizeStartResult({ readyAgents: [{ key: 'a' }] });
    assert.equal(ready.state, 'ready');
});

test('AV.background-result-projection', () => {
    const outcome = refusal('alpha-container');
    const status = { state: 'failed', phase: 'admission', error: { message: 'refused', code: HARDWARE_UNENFORCEABLE, hardwareOutcome: outcome } };
    const plan = { lease: { commit: () => true } };
    const result = resolveNoWaitAgentStartupState(plan, {
        inspectPublication: () => ({ ok: true, containerName: 'alpha-container', record: { instanceId: 'i' } }),
        readRunMarker: () => ({}),
        createRunBinding: () => ({}),
        observeRun: () => ({ state: 'failed', status, record: { instanceId: 'i' } }),
    });
    assert.deepEqual({ state: result.state, code: result.code }, { state: 'unavailable', code: 'hardware_refused' });
    assert.match(result.fix, /ploinky restart/);
    const marketplace = mapNoWaitObservationForMarketplace({ state: 'failed', status });
    assert.equal(marketplace.status, 'failed');
    assert.equal(marketplace.hardwareOutcome.key, 'alpha-container');
});

test('AV.individual-nonzero', () => {
    const individual = wrapPreservingHardwareCause('Failed to restart container alpha-container: refused',
        new HardwareLimitsError(refusal('alpha-container')));
    assert.ok(individual instanceof Error);
    assert.equal(individual.code, HARDWARE_UNENFORCEABLE);
    assert.equal(findHardwareOutcome(individual).key, 'alpha-container');
    // The CLI restart wrappers keep the typed cause (the process exits 1 on a
    // thrown error); a degraded whole-start never converts it to success.
    const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli/commands/cli.js'), 'utf8');
    assert.ok(cli.includes('throw wrapPreservingHardwareCause(\n                                    `managed restart failed'));
    assert.equal(cli.includes("throw new Error(`managed restart failed:"), false);
});

test('AV.repair-closure', () => {
    const edges = [
        availabilityEdge({ fromKey: 'a', toKey: 'b', kind: 'blocking', source: 'manifest' }),
        availabilityEdge({ fromKey: 'b', toKey: 'c', kind: 'blocking', source: 'manifest' }),
    ];
    const before = classifyAvailability({
        nodes: [
            { key: 'a', ref: 'demo/a', alias: null, refusal: null },
            { key: 'b', ref: 'demo/b', alias: null, refusal: null },
            { key: 'c', ref: 'demo/c', alias: null, refusal: refusal('c', 'demo/c') },
            { key: 'u', ref: 'demo/u', alias: null, refusal: null },
        ],
        edges,
    });
    const after = classifyAvailability({
        nodes: ['a', 'b', 'c', 'u'].map((key) => ({ key, ref: `demo/${key}`, alias: null, refusal: null })),
        edges,
    });
    assert.deepEqual(repairClosurePlan({ before, after, edges }), ['c', 'b', 'a'],
        'the repaired root first, then its newly eligible closure; unrelated u untouched');
});
