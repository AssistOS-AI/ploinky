import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../helpers/agentlibTestContract.mjs';

const cwd = process.cwd();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-selection-'));
const env = { PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT, PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY };
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
test.after(() => {
    process.chdir(cwd);
    for (const [name, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

const { selectRouteRuntime, assertSelectionCurrent } = await import('../../cli/server/canary/selection.mjs');
const { CanarySignals } = await import('../../cli/server/canary/signals.js');
const { readPublicCanaryUserId } = await import('../../cli/server/routerHandlers.js');
const { SSO_AUTH_COOKIE_NAME } = await import('../../cli/server/authHandlers/shared.js');
const { createSessionStore } = await import('../../cli/server/auth/sessionStore.js');

const actor = id => ({ user: { id, roles: ['user'] }, authMode: 'sso' });
const routeKey = 'service';
const rolloutId = 'rollout-1';
const agent = {
    type: 'agent', repoName: 'fixture', agentName: routeKey, runtime: 'podman', hostPort: 4101,
    containerId: 'a'.repeat(64), instanceId: 'old-instance', enableGeneration: 'old-enable', launchId: 'old-launch',
};
const agents = {
    primary: agent,
    primary__canary: { ...agent, containerId: 'b'.repeat(64), instanceId: 'new-instance', enableGeneration: 'new-enable',
        launchId: 'new-launch', canaryOf: routeKey, hostPort: 4102 },
};
function fixture(share = 10) {
    const canary = {
        rolloutId, share, container: 'primary__canary', commit: 'a'.repeat(40), salt: 'fixture-salt',
        mode: 'split', testAccounts: ['tester'], codePath: '.ploinky/canary/service/export',
    };
    const route = { repo: 'fixture', agent: routeKey, hostPath: path.join(workspace, 'fixture/service'),
        container: 'primary', hostPort: agent.hostPort, canary };
    const snapshot = { agents, routing: { routes: { [routeKey]: route } } };
    const signals = new CanarySignals();
    signals.startRollout({ routeKey, ...canary });
    const select = (req, taskId) => selectRouteRuntime({ routeKey, route, snapshot, req, taskId, signals });
    return { route, snapshot, signals, select };
}

test('salted split matches known buckets and remains sticky across independent requests', t => {
    const { select } = fixture();
    for (let i = 0; i < 1000; i++) {
        assert.equal(select(actor('user-0')).copy, 'old');
        assert.equal(select(actor('user-12')).copy, 'canary');
    }
    let newCount = 0;
    for (let i = 0; i < 10_000; i++) {
        if (select(actor('user-' + i)).copy === 'canary') newCount++;
    }
    assert.equal(newCount, 999);
    t.diagnostic(newCount + ' of 10000 accounts selected the canary at share 10');
});

test('share zero routes only trusted test-account identities to the candidate', () => {
    const { select } = fixture(0);
    for (const req of [actor('tester'), { canaryPublicUserId: 'tester' },
        { delegatedAgentVerified: { callerPrincipal: 'agent:fixture/caller', userDelegation: { user: actor('tester').user } } }]) {
        const choice = select(req);
        assert.equal(choice.copy, 'canary');
        assert.equal(choice.targetRecord, agents.primary__canary);
        assert.equal(choice.route.hostPort, agents.primary__canary.hostPort);
    }
    for (const req of [{}, actor('user-12'), { agent: { name: 'tester' } },
        { user: { id: 'tester', roles: ['guest'] }, authMode: 'guest' },
        { headers: { 'x-ploinky-user-id': 'tester' } },
        { delegatedAgentVerified: { callerPrincipal: 'agent:fixture/caller' } }]) {
        assert.equal(select(req).copy, 'old');
    }
});

test('trip and restart withdraw normal traffic while current tasks stay on their original copy', () => {
    const { route, signals, select } = fixture(0);
    const taskId = 'canary.rollout-1.0123456789abcdef';
    const choice = select(actor('tester'));
    for (let i = 0; i < 3; i++) signals.recordProbe(routeKey, rolloutId, { ok: false });
    assert.throws(() => assertSelectionCurrent(choice));
    const check = () => {
        assert.equal(select(actor('tester')).copy, 'old');
        assert.equal(select(actor('tester'), 'old-task').copy, 'old');
        assert.equal(select(actor('user-0'), taskId).copy, 'canary');
        assert.throws(() => select(actor('tester'), 'canary.earlier.0123456789abcdef'), { status: 404 });
    };
    check();
    signals.routerStarted({ [routeKey]: route });
    check();
});

test('task routing follows queue ownership through all, retirement, withdrawal and receipt-only lookup', async () => {
    const { route, select, snapshot, signals } = fixture(0);
    const taskId = 'canary.rollout-1.abcdef0123456789';
    const reader = actor('reader');
    route.canary.mode = 'all';
    assert.equal(select(reader).copy, 'canary');
    assert.equal(select(reader, taskId).copy, 'canary');
    assert.equal(select(reader, 'old-task').copy, 'old');
    const { openReceipt, updateReceipt, closeReceipt } = await import('../../cli/sandbox/canary/receipt.mjs');
    openReceipt({ routeKey, rolloutId, fields: { oldContainerId: agent.containerId, oldLaunchId: agent.launchId } },
        { workspaceRoot: workspace });
    delete route.hostPort;
    const draining = select(reader, 'old-task');
    assert.equal(draining.route.hostPort, agent.hostPort);
    const { readAuthenticatedAgentTask } = await import('../../cli/server/mcp-proxy/index.js');
    const deniedLease = { snapshot, effective: { denials: new Map([[routeKey, { state: 'refused' }]]) } };
    await assert.rejects(readAuthenticatedAgentTask({ req: reader, route, agentName: routeKey, taskId: 'old-task',
        routePlan: { lease: deniedLease }, signals }), { status: 503, code: 'AGENT_HARDWARE_UNAVAILABLE' });
    updateReceipt({ routeKey, rolloutId, fields: { lastCompletedStep: 2 } }, { workspaceRoot: workspace });
    assert.throws(() => assertSelectionCurrent(draining), { status: 410, message: 'old copy stopped' });
    assert.throws(() => select(reader, 'old-task'), { status: 410, message: 'old copy stopped' });
    route.canary.mode = 'retiring';
    route.hostPort = 4144;
    assert.equal(select(reader).route.hostPort, 4144);
    assert.equal(select(reader, 'old-task').route.hostPort, 4144);
    assert.equal(select(reader, taskId).copy, 'canary');
    route.canary.mode = 'withdrawn';
    assert.throws(() => select(reader, taskId), { status: 410, message: 'new copy removed' });
    closeReceipt({ routeKey, rolloutId, outcome: 'aborted' }, { workspaceRoot: workspace });
    delete route.canary;
    assert.throws(() => select(reader, taskId), { status: 410, message: 'new copy removed' });
    assert.throws(() => select(reader, 'canary.earlier.abcdef0123456789'), { status: 404 });
});

test('draining all keeps aggregate MCP, WebTTY, discovery and no-wait on the candidate', async () => {
    const { route, snapshot, signals } = fixture();
    route.canary.mode = 'all';
    route.draining = true;
    delete route.hostPort;
    snapshot.manifests = { service: { webtty: { homeProfiles: {
        version: 1, resolve: '/base-agent-additional-server/service/8787/profile',
    } } } };
    const { createAgentRouteEntries } = await import('../../cli/server/routerHandlers.js');
    const { findHomeProfileProvider } = await import('../../cli/server/webtty/homeProfileProvider.mjs');
    const { buildOpenAiAgentDiscovery } = await import('../../cli/server/openAiAgentDiscovery.js');
    const { inspectNoWaitAgentPublication } = await import('../../cli/server/noWaitAgentStartupState.js');
    const { webchatRouteProvenance } = await import('../../cli/server/webchat/commandResolver.js');
    const [entry] = createAgentRouteEntries({ lease: { snapshot, commit: () => true } }, { signals });
    assert.equal(entry.port, agents.primary__canary.hostPort);
    assert.equal(findHomeProfileProvider(snapshot, routeKey).containerName, 'primary__canary');
    const webchat = webchatRouteProvenance(snapshot.routing, routeKey);
    assert.equal(webchat.container, 'primary__canary');
    assert.equal(webchat.cliTarget, webchat.container);
    assert.equal(webchat.hostPath, path.join(workspace, route.canary.codePath));
    assert.deepEqual(buildOpenAiAgentDiscovery({
        routes: snapshot.routing.routes, snapshot, readManifest: () => snapshot.manifests.service,
    }).agents.map(row => row.routeKey), [routeKey]);
    const pending = structuredClone(snapshot);
    delete pending.agents.primary__canary.hostPort;
    pending.agents.primary__canary.profile = 'default';
    const publication = inspectNoWaitAgentPublication({
        ok: true, kind: 'agent-root-pending', routeKey, route: pending.routing.routes.service, snapshot: pending,
    });
    assert.equal(publication.containerName, 'primary__canary');
});

test('the scheduled probe receives the canary container identity, bounded timeout and cancellation signal', async () => {
    const { exactContainerProbe } = await import('../../cli/server/canary/routerSignals.js');
    const target = {
        routeKey, rolloutId, runtime: 'podman', container: 'primary__canary', containerId: agents.primary__canary.containerId,
        probe: { port: 8787, path: '/health', status: 204 },
    };
    const { signal } = new AbortController();
    const run = exactContainerProbe(async options => {
        assert.deepEqual(options, { runtime: target.runtime, containerName: target.container, containerId: target.containerId,
            ...target.probe, timeoutMs: 5000, signal });
        return { ok: true, status: 204 };
    });
    assert.deepEqual(await run(target, { signal }), { ok: true, status: 204 });
});

test('U5 local public lookup handles expiry and revocation without contacting the provider or altering HTTP identity', t => {
    let now = Date.now();
    const store = createSessionStore({ now: () => now });
    const live = store.createSession({ user: actor('tester').user, expiresAt: now + 60_000 }).id;
    const expiring = store.createSession({ user: actor('expired').user, expiresAt: now + 1 }).id;
    const revoked = store.createSession({ user: actor('revoked').user }).id;
    const provider = t.mock.fn(() => { throw new Error('public request attempted provider access'); });
    const service = { getSession: store.getSession, validateSession: provider, refreshSession: provider, beginLogin: provider };
    const read = req => readPublicCanaryUserId(req, service);
    const req = id => Object.freeze({ headers: Object.freeze({ cookie: SSO_AUTH_COOKIE_NAME + '=' + id }) });
    assert.equal(read(req(expiring)), 'expired');
    assert.equal(read(req(revoked)), 'revoked');
    now += 2;
    store.deleteSession(revoked);
    for (const id of [expiring, revoked, 'unknown']) assert.equal(read(req(id)), null);
    // Measure the complete optional read for a cookie-bearing public request.
    const request = req(live);
    const samples = [];
    for (let i = 0; i < 2000; i++) {
        const start = performance.now();
        const result = read(request);
        samples.push(performance.now() - start);
        assert.equal(result, 'tester');
    }
    const p95 = samples.sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
    t.diagnostic('public SSO cookie read p95 ' + p95.toFixed(4) + ' ms');
    assert.ok(p95 < 2, 'p95 was ' + p95 + ' ms');
    assert.equal(provider.mock.callCount(), 0);
    assert.equal(request.user, undefined);
});

test('a targetless or hardware-refused primary does not hide the split canary', async () => {
    const { initializeFreshEdgeRoutingSources, applyEdgeRoutingGeneration } = await import('../../cli/sandbox/edgeGeneration.js');
    const { resolveEdgeRoutePlan } = await import('../../cli/server/edgeRoutePlan.js');
    const { withSelectedRoot } = await import('../../cli/server/proxy/executeHttpPlan.js');
    const { entryFor } = await import('./hardwareAvailabilityFixtures.mjs');
    const { route } = fixture(0);
    delete route.hostPort;
    Object.assign(route.canary, { codeDigest: 'sha256:' + 'c'.repeat(64), splitStartedAt: '2026-11-23T00:00:00Z',
        probe: { port: 8080, path: '/health', status: 200 }, thresholds: { minFailures: 5, slowMs: 5_000 } });
    initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    fs.mkdirSync(route.hostPath, { recursive: true });
    fs.writeFileSync(path.join(route.hostPath, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(workspace, '.ploinky/agents.json'), JSON.stringify(agents));
    const checkDispatch = (selection, check) => {
        assert.equal(check(), true);
        return selection.route.hostPort;
    };
    for (const refusal of [false, true]) {
        if (refusal) route.hardwareAvailability = entryFor(routeKey, { ...agent, key: route.container }).projection;
        fs.writeFileSync(path.join(workspace, '.ploinky/routing.json'), JSON.stringify({ routes: { [routeKey]: route } }));
        applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'targetless-primary' });
        const plan = resolveEdgeRoutePlan({ req: { headers: { host: 'localhost' }, url: '/service/page', method: 'GET' } });
        assert.equal(plan.kind, 'agent-root');
        assert.equal(plan.target, null);
        assert.equal(await withSelectedRoot({ req: actor('tester'), plan }, checkDispatch), agents.primary__canary.hostPort);
        assert.equal(await withSelectedRoot({ req: actor('reader'), plan,
            taskId: 'canary.rollout-1.0123456789abcdef' }, checkDispatch), agents.primary__canary.hostPort);
        await assert.rejects(withSelectedRoot({ req: actor('reader'), plan }, checkDispatch), { status: 503 });
    }
});

test('a stalled relay response records its first byte and one failed backend request', async t => {
    const { executeHttpPlan } = await import('../../cli/server/proxy/executeHttpPlan.js');
    const { agentPortPlan } = await import('../../cli/server/edgeRoutePlan.js');
    const { compileProxyLimits } = await import('../../cli/server/proxy/limits.js');
    const { registerProxyOutcomeSink } = await import('../../cli/server/canary/proxyOutcomes.js');
    const { routingSignals, setRoutingSignals } = await import('../../cli/server/canary/routeAdmission.mjs');
    const { route, snapshot, signals } = fixture(0);
    const previousSignals = routingSignals();
    setRoutingSignals(signals);
    t.after(() => setRoutingSignals(previousSignals));
    snapshot.compiled = { policy: { entries: [], routeDefaults: { service: { access: 'authenticated', routeKey } } } };
    const stop = registerProxyOutcomeSink(event => signals.recordOutcome(event));
    t.after(stop);
    const req = Object.assign(Readable.from([]), actor('tester'), { method: 'GET',
        headers: { host: 'localhost' }, url: '/base-agent-additional-server/service/8080/events' });
    const lease = { id: 'stalled-response-generation', snapshot, commit: () => true };
    const plan = agentPortPlan({ req, host: 'localhost', listener: 'public', parsedUrl: new URL(req.url, 'http://localhost'),
        hostSelection: { kind: 'control' }, routes: { [routeKey]: route }, snapshot, lease });
    assert.equal(plan.ok, true, plan.code);
    const relay = new EventEmitter();
    relay.end = relay.abandon = () => {};
    let sentHeaders = false;
    relay.write = () => {
        if (!sentHeaders) {
            sentHeaders = true;
            setImmediate(() => relay.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100\r\n\r\nx')));
        }
        return true;
    };
    const res = new Writable({ write(_data, _encoding, callback) { callback(); } });
    res.on('error', () => {});
    const counts = () => signals.status().rollouts[0].counts.canary.sinceStart;
    res.writeHead = () => {
        res.headersSent = true;
        assert.equal(counts().timedResponses, 1);
        assert.equal(counts().requests, 0);
    };
    // The production deadline is unref'ed; this in-memory relay owns no OS socket.
    const deadline = setTimeout(() => res.destroy(new Error('stalled relay did not reach its idle deadline')), 2000);
    t.after(() => clearTimeout(deadline));
    let terminal;
    const ok = await executeHttpPlan({ req, res, lease, authorized: true, prebufferedBody: Buffer.alloc(0),
        auditSink: event => { terminal = event; },
        plan: Object.freeze({ ...plan, limits: compileProxyLimits({ idleTimeoutMs: 20 }) }),
        relayManager: { checkout: async () => ({ openRequest: async () => relay, close() {} }) } });
    assert.equal(ok, false);
    assert.equal(terminal.status, 504);
    assert.equal(counts().requests, 1);
    assert.equal(counts().timedResponses, 1);
    assert.equal(counts().backendFailures, 1);
});

test('concurrent SDK and aggregate MCP requests measure response headers for each copy', async t => {
    const { createServer } = await import('node:http');
    const { setTimeout: delay } = await import('node:timers/promises');
    const { handleRouterMcp } = await import('../../cli/server/routerHandlers.js');
    const { handleAgentJsonRpc, agentSessionStore } = await import('../../cli/server/mcp-proxy/index.js');
    const { registerProxyOutcomeSink } = await import('../../cli/server/canary/proxyOutcomes.js');
    const { route, snapshot, signals } = fixture(0);
    snapshot.agents = structuredClone(snapshot.agents);
    const events = [];
    t.after(registerProxyOutcomeSink(event => events.push(event)));
    for (const copy of ['old', 'canary']) {
        const server = createServer(async (req, res) => {
            if (req.method !== 'POST') return res.writeHead(405).end();
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const rpc = JSON.parse(Buffer.concat(chunks));
            if (rpc.method === 'notifications/initialized') return res.writeHead(204).end();
            const initialize = rpc.method === 'initialize';
            // A slow session open must never become the timing of the subsequent RPC.
            await delay(initialize ? 320 : copy === 'old' ? 5 : 160);
            res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': copy });
            res.flushHeaders();
            if (!initialize && copy === 'old') await delay(350);
            if (!initialize && copy === 'canary') {
                res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'backend ping failed' } }));
                return;
            }
            const result = initialize ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: copy, version: '1' } } : {};
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => {
            server.closeAllConnections();
            return new Promise(resolve => server.close(resolve));
        });
        if (copy === 'old') route.hostPort = server.address().port;
        else snapshot.agents.primary__canary.hostPort = server.address().port;
    }
    const routePlan = { lease: { snapshot, commit: () => true } };
    function invoke(handle) {
        return new Promise((resolve, reject) => {
            const res = { writeHead(status, headers) { this.status = status; this.headers = headers; },
                end(body) { resolve({ ...this, body: JSON.parse(body) }); } };
            Promise.resolve(handle(res)).catch(reject);
        });
    }
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ command: 'ping', agent: routeKey }))]),
        actor('reader'), { method: 'POST', headers: {} });
    const sdkReq = { ...actor('tester'), sessionId: 'test-login', headers: {} };
    const selected = selectRouteRuntime({ routeKey, route, snapshot, req: sdkReq, signals });
    const sdk = (method, res) => handleAgentJsonRpc(sdkReq, res, selected.route, routeKey,
        { jsonrpc: '2.0', method, id: 1 }, { selection: selected, snapshot });
    const opened = await invoke(res => sdk('initialize', res));
    const sessionId = opened.headers['mcp-session-id'];
    t.after(() => agentSessionStore.delete(sessionId));
    sdkReq.headers['mcp-session-id'] = sessionId;
    const [aggregate, direct] = await Promise.all([invoke(res => handleRouterMcp(req, res, routePlan)),
        invoke(res => sdk('ping', res))]);
    assert.deepEqual(aggregate.body.result, {});
    assert.equal(direct.status, 200);
    assert.match(direct.body.error.message, /backend ping failed/);
    assert.equal(events.length, 2);
    const old = events.find(event => event.copy === 'old');
    const canary = events.find(event => event.copy === 'canary');
    assert.equal(old.serverError, false);
    assert.equal(canary.serverError, true);
    assert.ok(Number.isFinite(old.ttfbMs) && old.ttfbMs < 120, 'old headers precede its delayed body: ' + old.ttfbMs);
    assert.ok(canary.ttfbMs >= 145 && canary.ttfbMs < 305, 'canary headers follow its own RPC delay: ' + canary.ttfbMs);
    t.diagnostic('SDK/aggregate header timings in ms: old ' + old.ttfbMs.toFixed(1) + ', canary ' + canary.ttfbMs.toFixed(1));
});
