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
import {
    createGraphAvailabilityTracker,
    launchWorkspaceGraphWaves,
    printStartResultSummary,
} from '../../cli/commands/workspaceUtil.js';
import { spawnSync } from 'node:child_process';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

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

test('AV.router-controls', async (t) => {
    // The static agent (alpha) is refused. Router-owned controls still resolve
    // to router surfaces and the agent-startup dispatcher leaves them alone,
    // while the application route answers terminally with the fix.
    createFixture(t);
    for (const pathname of ['/webtty', '/api/marketplace', '/auth/login']) {
        const req = { method: 'GET', url: pathname, headers: { host: '127.0.0.1:18080', accept: 'application/json' } };
        const plan = resolveEdgeRoutePlan({ req, listener: 'public' });
        // Either a resolved plan or a control-host miss, which the Router
        // serves from its own surfaces; never an unavailable-agent denial.
        const controlMiss = !plan.ok && plan.code === 'ROUTE_NOT_FOUND' && plan.hostSelection?.kind === 'control';
        assert.ok(plan.ok || controlMiss, `${pathname}: ${plan.code}`);
        assert.notEqual(plan.code, 'AGENT_HARDWARE_UNAVAILABLE', pathname);
        assert.equal(plan.hardwareAvailability, undefined, pathname);
        assert.notEqual(plan.kind, 'agent-root-pending', pathname);
        const { handled, res } = await dispatch(req, plan);
        assert.equal(handled, false, `${pathname} is not answered as an unavailable agent`);
        assert.equal(res.statusCode, 0);
    }
    const app = request({ routeKey: 'alpha', pathname: '/index.html', accept: 'text/html', extra: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } });
    const { handled, res, lifecycleReads } = await dispatch(app, resolveEdgeRoutePlan({ req: app, listener: 'public' }));
    assert.equal(handled, true);
    assert.equal(lifecycleReads, 0, 'terminal: no startup observation or reload loop');
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /data-ploinky-agent-startup-page="unavailable"/);
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

test('AV.individual-nonzero', (t) => {
    // An individual restart of a refused target exits nonzero with the typed
    // refusal (here a lite-sandbox agent declaring a memory limit), whatever
    // the whole-workspace state; it never reports success.
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-individual-')));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    writeAgentLibCheckout(path.join(workspace, 'achillesAgentLib'));
    const ploinky = path.join(workspace, '.ploinky');
    for (const repoName of ['AchillesIDE', 'AchillesCLI', 'copilot-agents']) fs.mkdirSync(path.join(ploinky, 'repos', repoName), { recursive: true });
    const agentDir = path.join(ploinky, 'repos', 'demo', 'limited');
    fs.mkdirSync(agentDir, { recursive: true });
    writeJson(path.join(agentDir, 'manifest.json'), {
        'lite-sandbox': true, agent: 'node server.js', network: { mode: 'host' },
        llmRuntime: { runtimePolicy: { resources: { memory: '64m' } } },
    });
    writeJson(path.join(ploinky, 'routing.json'), { routes: {} });
    writeJson(path.join(ploinky, 'agents.json'), {
        _config: { sandbox: { disableHostRuntimes: false } },
        ploinky_demo_limited: {
            type: 'agent', repoName: 'demo', agentName: 'limited', containerName: 'ploinky_demo_limited',
            instanceId: 'limited-instance', enableGeneration: 'limited-generation', profile: 'default', auth: { mode: 'none' },
        },
    });
    fs.mkdirSync(path.join(ploinky, 'data', 'router-security'), { recursive: true });
    writeJson(path.join(ploinky, 'data', 'router-security', 'policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    fs.mkdirSync(path.join(ploinky, 'data', 'edge-routing'), { recursive: true });
    writeJson(path.join(ploinky, 'data', 'edge-routing', 'desired.json'), { hosts: {} });
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cli', 'index.js'), 'restart', 'limited'], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_MASTER_KEY: '5'.repeat(64) },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    const tool = process.platform === 'darwin' ? 'sandbox-exec' : 'bwrap';
    const sandboxAvailable = spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;
    if (sandboxAvailable) {
        assert.match(output, /Refused \(hardware limits\): demo\/limited \[[^\]]+\] requests memory 64m \(manifest\)\. This runtime cannot apply memory\./);
    } else {
        // Without a host sandbox tool the CLI refuses earlier, still nonzero.
        assert.match(output, /sandbox/i);
    }
    assert.doesNotMatch(output, /Agent restarted/);
    // The cause-preserving wrapper keeps the typed outcome for callers that
    // wrap the individual failure (Marketplace worker, HTTP mapping).
    const individual = wrapPreservingHardwareCause('Failed to restart container alpha-container: refused',
        new HardwareLimitsError(refusal('alpha-container')));
    assert.equal(individual.code, HARDWARE_UNENFORCEABLE);
    assert.equal(findHardwareOutcome(individual).key, 'alpha-container');
});

test('AV.repair-closure', async () => {
    // After the refused root is repaired, a new start re-admits it and its
    // previously blocked closure in dependency order (root first), and the
    // unrelated agent is launched as before.
    const node = (id, dependencies = []) => ({
        id, dependencies: new Set(dependencies), dependencyEdges: new Map(dependencies.map((child) => [child, { noWait: false }])),
    });
    const graph = { nodes: new Map([['a', node('a', ['b'])], ['b', node('b', ['c'])], ['c', node('c')], ['u', node('u')]]) };
    const admissions = (refusedC) => ['a', 'b', 'c', 'u'].map((key) => ({
        nodeId: key, key, alias: '', admission: { agentId: `demo/${key}` }, hardwareRefusal: refusedC && key === 'c' ? refusal('c', 'demo/c') : null,
    }));
    const run = async (refusedC) => {
        const launched = [];
        const availability = createGraphAvailabilityTracker(graph, admissions(refusedC));
        const outcomes = [];
        await launchWorkspaceGraphWaves({
            graphWaves: [['c', 'u'], ['b'], ['a']],
            nodes: graph.nodes,
            registryNameByNodeId: new Map(['a', 'b', 'c', 'u'].map((key) => [key, key])),
            availability,
            launch: async (names) => { launched.push(...names); return { routeResults: [], failedAgents: [] }; },
            readinessEntryFor: (entry) => entry.id,
            waitForReadiness: async () => {},
            reportOutcome: (outcome) => outcomes.push(`${outcome.state}:${outcome.key}`),
            log() {},
        });
        return { launched, outcomes };
    };
    const before = await run(true);
    assert.deepEqual(before.launched, ['u'], 'refused c and its blocked closure b, a are not launched');
    assert.deepEqual(before.outcomes.sort(), ['blocked:a', 'blocked:b', 'refused:c']);
    const after = await run(false);
    assert.deepEqual(after.launched, ['c', 'u', 'b', 'a'], 'the repaired root first, then its closure in dependency order');
    assert.deepEqual(after.outcomes, []);
});
