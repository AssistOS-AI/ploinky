// Router-authored pre-forward refusal marker: `X-Ploinky-Refusal`.
// A response carries it only when the Router itself wrote it before any byte of
// the request was dispatched upstream, and never when an upstream supplied it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';

import { applyEdgeRoutingGeneration, initializeFreshEdgeRoutingSources } from '../../cli/sandbox/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { executeHttpPlan } from '../../cli/server/proxy/executeHttpPlan.js';
import { executeWebSocketPlan } from '../../cli/server/proxy/executeWebSocketPlan.js';
import { compileProxyLimits } from '../../cli/server/proxy/limits.js';
import { createRoutePlan } from '../../cli/server/proxy/RoutePlan.js';
import {
    RELAY_PHASE,
    REFUSAL_HEADER,
    refusalHeaderValue,
    relayRefusalFor,
    routeRefusalCause,
    stripUpstreamRefusalMarker,
} from '../../cli/server/proxy/refusalMarker.js';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';
import { RuntimeRelayManager } from '../../cli/server/runtimeRelay/RuntimeRelayManager.js';
import {
    handleRouterMcp,
    postJsonToAgent,
    proxyApi,
    proxyHttpPassthrough,
    proxyMcpPassthrough,
} from '../../cli/server/routerHandlers.js';
import { ensureHttpRouteAccess } from '../../cli/server/authHandlers/authContext.js';
import { handleAgentRootUpgrade } from '../../cli/server/wsAgentRootProxy.js';

const MARKER_RELAY_CHANGED = 'v=1; stage=relay; cause=edge-generation-changed';
const FORGED = 'v=1; stage=route; cause=edge-generation-inactive';

function headerOf(headers, name) {
    const wanted = name.toLowerCase();
    const key = Object.keys(headers || {}).find(candidate => candidate.toLowerCase() === wanted);
    return key === undefined ? undefined : headers[key];
}

class Response extends Writable {
    constructor() {
        super();
        this.statusCode = 0;
        this.headers = {};
        this.body = Buffer.alloc(0);
        this.headersSent = false;
    }

    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
    }

    _write(chunk, _encoding, callback) {
        this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
        callback();
    }

    json() { return JSON.parse(this.body.toString('utf8')); }
}

class UpgradeSocket extends Writable {
    constructor() {
        super();
        this.body = Buffer.alloc(0);
    }

    _write(chunk, _encoding, callback) {
        this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
        callback();
    }
}

// A relay stream that answers the proxied HTTP request with fixed raw bytes.
class CannedRelayStream extends EventEmitter {
    constructor(raw) {
        super();
        this.channel = { child: { stdin: new EventEmitter() } };
        this.raw = raw;
        this.responded = false;
    }

    write() {
        if (!this.responded) {
            this.responded = true;
            setImmediate(() => {
                this.emit('data', Buffer.from(this.raw));
                this.emit('end');
            });
        }
        return true;
    }

    end() {}
    cancel() { this.emit('end'); }
}

function routePlan({ method = 'GET', transport = 'http', limitOverrides = {} } = {}) {
    return createRoutePlan({
        matched: true,
        ok: true,
        listenerClass: 'public',
        authority: '127.0.0.1:8080',
        surfaceKind: 'agent-port-convention',
        owner: { effectiveInstanceId: 'alpha-instance', enableGeneration: 'alpha-enable-generation' },
        routeKey: 'alpha',
        port: 7001,
        policyPath: '/base-agent-additional-server/alpha/7001/api/items',
        convention: 'base-agent-additional-server',
        unmatchedSuffix: '/api/items',
        query: '',
        relay: {
            kind: 'container-control-socket',
            runtime: 'podman',
            containerId: 'a'.repeat(64),
            containerName: 'alpha-container',
            targetAgentId: 'agent:fixtures/alpha',
            effectiveInstanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
        },
        access: { access: 'authenticated' },
        scheme: 'http',
        origin: 'http://127.0.0.1:8080',
        forwardedPrefix: '/base-agent-additional-server/alpha/7001',
        limits: compileProxyLimits(limitOverrides),
        generationDigest: 'sha256:generation',
        auditId: 'audit-marker',
        method,
        transport,
        allowRequestStreaming: false,
        credentialPolicy: { allowApplicationAuthorization: true, allowApplicationCookies: true },
        responsePolicy: { allowApplicationCookies: true, allowRedirects: true, allowCaching: true },
    });
}

function getRequest() {
    const request = Readable.from([]);
    request.method = 'GET';
    request.headers = { host: '127.0.0.1:8080' };
    return request;
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function fetchRaw(port, target = '/') {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: target }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        }).on('error', reject);
    });
}

// ---- builder and mapping ----

test('the marker value is the exact v=1 grammar and rejects unknown stages and causes', () => {
    assert.equal(refusalHeaderValue('relay', 'relay-busy'), 'v=1; stage=relay; cause=relay-busy');
    assert.equal(refusalHeaderValue('route', 'edge-generation-inactive'), 'v=1; stage=route; cause=edge-generation-inactive');
    assert.equal(refusalHeaderValue('auth', 'unauthorized'), 'v=1; stage=auth; cause=unauthorized');
    assert.throws(() => refusalHeaderValue('upstream', 'relay-busy'), /unknown stage/);
    assert.throws(() => refusalHeaderValue('relay', 'EDGE_GENERATION_CHANGED'), /unknown cause/);
});

test('only the two inactive-selector route codes map to edge-generation-inactive', () => {
    assert.equal(routeRefusalCause('EDGE_GENERATION_INACTIVE'), 'edge-generation-inactive');
    assert.equal(routeRefusalCause('HOST_SELECTOR_INACTIVE'), 'edge-generation-inactive');
    // These are not transient transition refusals and must never be resendable.
    for (const code of ['EDGE_GENERATION_CORRUPT', 'EDGE_GENERATION_RUNTIME_MISMATCH', 'ROUTE_NOT_FOUND', 'UNKNOWN_HOST', undefined]) {
        assert.equal(routeRefusalCause(code), 'route-denied', String(code));
    }
});

test('the relay marker is decided by dispatch position, never by the error code alone', () => {
    const stale = Object.assign(new Error('stale'), { code: 'EDGE_GENERATION_CHANGED' });
    const busy = Object.assign(new Error('busy'), { code: 'RELAY_BUSY' });
    assert.equal(relayRefusalFor(stale, RELAY_PHASE.CHECKOUT)[REFUSAL_HEADER], MARKER_RELAY_CHANGED);
    assert.equal(relayRefusalFor(busy, RELAY_PHASE.CHECKOUT)[REFUSAL_HEADER], 'v=1; stage=relay; cause=relay-busy');
    assert.equal(relayRefusalFor(new Error('spawn failed'), RELAY_PHASE.CHECKOUT)[REFUSAL_HEADER],
        'v=1; stage=relay; cause=upstream-unavailable');
    // openRequest: only the lease check that runs before the OPEN write is pre-forward.
    assert.equal(relayRefusalFor(stale, RELAY_PHASE.OPEN)[REFUSAL_HEADER], MARKER_RELAY_CHANGED);
    assert.equal(relayRefusalFor(new Error('write failed'), RELAY_PHASE.OPEN), null);
    assert.equal(relayRefusalFor(busy, RELAY_PHASE.OPEN), null);
    // After OPEN nothing is a refusal, whatever code the failure carries.
    for (const error of [stale, busy, new Error('idle timeout')]) {
        assert.equal(relayRefusalFor(error, RELAY_PHASE.OPENED), null);
    }
    assert.equal(relayRefusalFor(Object.assign(new Error('x'), { code: 'AUTH_REQUIRED' }), RELAY_PHASE.PREPARE)[REFUSAL_HEADER],
        'v=1; stage=auth; cause=unauthorized');
    assert.equal(relayRefusalFor(Object.assign(new Error('x'), { code: 'ORIGIN_REJECTED' }), RELAY_PHASE.PREPARE)[REFUSAL_HEADER],
        'v=1; stage=auth; cause=forbidden');
    assert.equal(relayRefusalFor(Object.assign(new Error('x'), { code: 'REQUEST_TOO_LARGE' }), RELAY_PHASE.PREPARE), null);
});

test('stripUpstreamRefusalMarker removes the header case-insensitively and keeps the rest', () => {
    const headers = { 'Content-Type': 'text/plain', 'x-PLOINKY-refusal': FORGED, 'retry-after': '3' };
    assert.deepEqual(stripUpstreamRefusalMarker(headers), { 'Content-Type': 'text/plain', 'retry-after': '3' });
    const clean = { a: 'b' };
    assert.equal(stripUpstreamRefusalMarker(clean), clean);
});

// ---- (1) generation committed between route resolution and relay checkout ----

function edgeFixture(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-refusal-marker-'));
    const previous = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_MASTER_KEY'].map(key => [key, process.env[key]]));
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    const agentPath = path.join(workspace, '.ploinky/repos/fixtures/alpha');
    fs.mkdirSync(agentPath, { recursive: true });
    fs.writeFileSync(path.join(agentPath, 'manifest.json'), JSON.stringify({
        routerAccess: { httpRoutes: [{ path: '/base-agent-additional-server/alpha/7001/public/*', access: 'public' }] },
    }));
    fs.writeFileSync(path.join(workspace, '.ploinky/routing.json'), JSON.stringify({ routes: {
        alpha: { repo: 'fixtures', agent: 'alpha', container: 'alpha-container', hostPath: agentPath },
    } }));
    fs.writeFileSync(path.join(workspace, '.ploinky/agents.json'), JSON.stringify({ 'alpha-container': {
        type: 'agent', repoName: 'fixtures', agentName: 'alpha', runtime: 'podman',
        containerId: 'a'.repeat(64), instanceId: 'alpha-instance', enableGeneration: 'alpha-enable-generation',
        auth: { mode: 'sso' },
    } }));
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'marker-first' });
    return { workspace };
}

function realManager() {
    const calls = { inspect: 0, mint: 0 };
    const minter = new RelayRequestMinter({
        resolveAgentSecret: async () => { calls.mint += 1; return Buffer.alloc(32, 1); },
        createNonce: () => 'nonce',
    });
    const manager = new RuntimeRelayManager({
        minter,
        inspectContainer: async () => { calls.inspect += 1; throw new Error('the relay must not be reached'); },
    });
    return { manager, calls };
}

test('a generation committed between route resolution and relay checkout is a marked 503 edge_generation_changed', async (t) => {
    const { workspace } = edgeFixture(t);
    const request = getRequest();
    Object.assign(request, { url: '/base-agent-additional-server/alpha/7001/public/status' });
    const plan = resolveEdgeRoutePlan({ req: request });
    assert.equal(plan.ok, true, plan.code);
    assert.equal(plan.lease.commit(), true, 'the lease is current when the route is resolved');
    // A later generation is committed before the relay is checked out.
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'marker-second' });
    const { manager, calls } = realManager();
    t.after(() => manager.close());
    const response = new Response();
    const handled = await executeHttpPlan({
        req: request, res: response, plan, lease: plan.lease, relayManager: manager, authorized: true,
        prebufferedBody: Buffer.alloc(0),
    });
    assert.equal(handled, false);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'edge_generation_changed' });
    assert.equal(headerOf(response.headers, REFUSAL_HEADER), MARKER_RELAY_CHANGED);
    assert.deepEqual(calls, { inspect: 0, mint: 0 }, 'nothing was sent toward the target');
});

test('the same race on a WebSocket upgrade is a marked 503 with no upstream contact', async (t) => {
    const { workspace } = edgeFixture(t);
    const plan = resolveEdgeRoutePlan({
        req: { method: 'GET', url: '/base-agent-additional-server/alpha/7001/public/ws', headers: { host: '127.0.0.1:8080' } },
        transport: 'websocket',
    });
    assert.equal(plan.ok, true, plan.code);
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'marker-ws-second' });
    const { manager, calls } = realManager();
    t.after(() => manager.close());
    const socket = new UpgradeSocket();
    const handled = await executeWebSocketPlan({
        req: {
            method: 'GET',
            headers: {
                host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080', connection: 'Upgrade', upgrade: 'websocket',
                'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
            },
        },
        socket, plan, lease: plan.lease, relayManager: manager, authorized: true,
    });
    assert.equal(handled, false);
    const text = socket.body.toString('utf8');
    assert.match(text, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
    assert.ok(text.includes(`\r\nX-Ploinky-Refusal: ${MARKER_RELAY_CHANGED}\r\n`), text);
    assert.deepEqual(calls, { inspect: 0, mint: 0 });
});

// ---- (3) relay concurrency refusal ----

test('a relay concurrency refusal is a marked 503 relay_busy chosen by error code', async (t) => {
    const manager = new RuntimeRelayManager({
        minter: new RelayRequestMinter({ resolveAgentSecret: async () => Buffer.alloc(32, 1) }),
    });
    // One pooled channel stands in for the container helper; the limit is
    // enforced by checkout() itself, before any channel use.
    manager._getOrCreateChannel = async () => ({ closed: false, retain() {}, releaseCheckout() {} });
    t.after(() => manager.close());
    // The plan's compiled limits take precedence over the manager defaults.
    const plan = routePlan({ limitOverrides: { concurrentStreamsPerAgent: 1, concurrentStreamsTotal: 4 } });
    const held = await manager.checkout({ plan, lease: { commit: () => true }, authorized: true });
    t.after(() => held.close());

    const response = new Response();
    const released = [];
    const handled = await executeHttpPlan({
        req: getRequest(), res: response, plan, lease: { commit: () => true, release: () => released.push(true) },
        relayManager: manager, authorized: true, prebufferedBody: Buffer.alloc(0),
    });
    assert.equal(handled, false);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'relay_busy' });
    assert.equal(headerOf(response.headers, REFUSAL_HEADER), 'v=1; stage=relay; cause=relay-busy');
    assert.deepEqual(released, [true]);
});

test('a checkout failure with a lease-like message but no code is upstream-unavailable, not a stale lease', async () => {
    // The message regex in proxyErrorStatus still yields a 503 status, but it never selects a body or a cause.
    const response = new Response();
    await executeHttpPlan({
        req: getRequest(), res: response, plan: routePlan(), lease: { release() {} }, authorized: true,
        prebufferedBody: Buffer.alloc(0),
        relayManager: { checkout: async () => { throw new Error('some lease and concurrency wording'); } },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'upstream_unavailable' });
    assert.equal(headerOf(response.headers, REFUSAL_HEADER), 'v=1; stage=relay; cause=upstream-unavailable');
});

// ---- (7) failures after OPEN carry no marker ----

test('a failure after OPEN has no marker even when it carries a stale-lease code', async () => {
    const response = new Response();
    const stream = new EventEmitter();
    stream.channel = { child: { stdin: new EventEmitter() } };
    stream.cancel = () => {};
    stream.end = () => {};
    stream.write = () => {
        // The upstream was reached; the stream then fails with a stale-lease-coded error.
        setImmediate(() => stream.emit('error', Object.assign(new Error('late'), { code: 'EDGE_GENERATION_CHANGED' })));
        return true;
    };
    const handled = await executeHttpPlan({
        req: getRequest(), res: response, plan: routePlan(), lease: { release() {} }, authorized: true,
        prebufferedBody: Buffer.alloc(0),
        relayManager: { checkout: async () => ({ openRequest: async () => stream, close() {} }) },
    });
    assert.equal(handled, false);
    assert.equal(headerOf(response.headers, REFUSAL_HEADER), undefined);
});

test('a non-lease openRequest failure is ambiguous and stays unmarked', async () => {
    const response = new Response();
    await executeHttpPlan({
        req: getRequest(), res: response, plan: routePlan(), lease: { release() {} }, authorized: true,
        prebufferedBody: Buffer.alloc(0),
        relayManager: { checkout: async () => ({ openRequest: async () => { throw new Error('frame write failed'); }, close() {} }) },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(headerOf(response.headers, REFUSAL_HEADER), undefined);
});

test('a post-OPEN WebSocket failure writes no marker', async () => {
    const socket = new UpgradeSocket();
    const stream = new EventEmitter();
    stream.channel = { child: { stdin: new EventEmitter() } };
    stream.cancel = () => {};
    stream.end = () => {};
    stream.write = () => {
        setImmediate(() => stream.emit('error', Object.assign(new Error('late'), { code: 'EDGE_GENERATION_CHANGED' })));
        return true;
    };
    await executeWebSocketPlan({
        req: {
            method: 'GET',
            headers: {
                host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080', connection: 'Upgrade', upgrade: 'websocket',
                'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
            },
        },
        socket, plan: routePlan({ transport: 'websocket' }), lease: { release() {} }, authorized: true,
        relayManager: { checkout: async () => ({ openRequest: async () => stream, close() {} }) },
    });
    assert.doesNotMatch(socket.body.toString('utf8'), /X-Ploinky-Refusal/i);
});

// ---- (2) an upstream can never forge the marker ----

test('an upstream 503 EDGE_GENERATION_INACTIVE with Retry-After and a forged marker reaches the client unmarked', async () => {
    const raw = [
        'HTTP/1.1 503 Service Unavailable',
        'Content-Type: application/json',
        'Retry-After: 3',
        `X-Ploinky-Refusal: ${FORGED}`,
        'x-ploinky-other: also-stripped',
        'Content-Length: 36',
        'Connection: close',
        '',
        '{"error":"EDGE_GENERATION_INACTIVE"}',
    ].join('\r\n');
    const response = new Response();
    const handled = await executeHttpPlan({
        req: getRequest(), res: response, plan: routePlan(), lease: { release() {} }, authorized: true,
        prebufferedBody: Buffer.alloc(0),
        relayManager: { checkout: async () => ({ openRequest: async () => new CannedRelayStream(raw), close() {} }) },
    });
    assert.equal(handled, true);
    assert.equal(response.statusCode, 503);
    assert.equal(headerOf(response.headers, REFUSAL_HEADER), undefined);
    assert.equal(headerOf(response.headers, 'x-ploinky-other'), undefined);
    assert.equal(headerOf(response.headers, 'retry-after'), '3');
    assert.deepEqual(response.json(), { error: 'EDGE_GENERATION_INACTIVE' });
});

test('the raw passthrough proxies never forward an upstream marker', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(503, {
            'Content-Type': 'application/json',
            'Retry-After': '3',
            'X-Ploinky-Refusal': FORGED,
        });
        res.end('{"error":"EDGE_GENERATION_INACTIVE"}');
    });
    const upstreamPort = await listen(upstream);
    t.after(() => upstream.close());
    const router = http.createServer((req, res) => {
        if (req.url.startsWith('/http')) proxyHttpPassthrough(req, res, upstreamPort, '/x');
        else if (req.url.startsWith('/mcp')) proxyMcpPassthrough(req, res, upstreamPort, '/mcp');
        else if (req.url.startsWith('/api')) proxyApi(req, res, upstreamPort);
        else postJsonToAgent(upstreamPort, {}, res, '/x');
    });
    const routerPort = await listen(router);
    t.after(() => router.close());
    for (const target of ['/http', '/mcp', '/json', '/api']) {
        const answer = await fetchRaw(routerPort, target);
        assert.equal(answer.status, 503, target);
        assert.equal(answer.headers['x-ploinky-refusal'], undefined, target);
        assert.equal(answer.headers['retry-after'], '3', target);
        assert.equal(answer.body, '{"error":"EDGE_GENERATION_INACTIVE"}', target);
    }
});

// ---- stale-lease sites outside the relay executor ----

test('the root passthrough stale lease is a marked 503 before any socket exists', async () => {
    const req = new PassThrough();
    req.method = 'GET';
    req.headers = {};
    const res = Object.assign(new EventEmitter(), {
        headersSent: false, statusCode: 0, headers: {}, body: '',
        writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...headers }; this.headersSent = true; return this; },
        end(value = '') { this.body += String(value); this.emit('done'); },
    });
    const done = new Promise(resolve => res.once('done', resolve));
    proxyHttpPassthrough(req, res, 9, '/events', {}, { beforeDial: () => false });
    req.end();
    await done;
    assert.equal(res.statusCode, 503);
    assert.equal(headerOf(res.headers, REFUSAL_HEADER), MARKER_RELAY_CHANGED);
    assert.deepEqual(JSON.parse(res.body), { error: 'edge_generation_changed' });
});

// ---- (6) MCP aggregated path ----

test('the aggregated MCP command path marks a stale captured lease and not an unrelated failure', async () => {
    const stalePlan = { lease: { snapshot: { routing: { routes: { captured: { hostPort: 9 } } } }, commit: () => false } };
    const capture = () => {
        let resolve;
        const completed = new Promise(done => { resolve = done; });
        return Object.assign(new EventEmitter(), {
            headersSent: false, statusCode: 0, headers: {}, body: '', completed,
            writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...headers }; this.headersSent = true; return this; },
            end(value = '') { this.body += String(value); resolve(); },
        });
    };
    const send = async (routePlanArg, payload) => {
        const req = new PassThrough();
        req.method = 'POST';
        req.headers = { 'content-type': 'application/json' };
        const res = capture();
        await handleRouterMcp(req, res, routePlanArg);
        req.end(JSON.stringify(payload));
        await res.completed;
        return res;
    };
    const stale = await send(stalePlan, { command: 'list_tools' });
    assert.equal(stale.statusCode, 503);
    assert.deepEqual(JSON.parse(stale.body), { error: 'edge_generation_changed' });
    assert.equal(headerOf(stale.headers, REFUSAL_HEADER), MARKER_RELAY_CHANGED);

    const missing = await send({}, { command: 'list_tools' });
    assert.equal(missing.statusCode, 503);
    assert.equal(headerOf(missing.headers, REFUSAL_HEADER), undefined, 'a missing lease is not a stale lease');
});

// ---- (5) auth-stage stale lease ----

test('the auth stage marks a stale route lease with stage=auth', async () => {
    const res = Object.assign(new EventEmitter(), {
        headersSent: false, statusCode: 0, headers: {}, set: {}, body: '',
        setHeader(name, value) { this.set[name.toLowerCase()] = value; },
        writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...headers }; this.headersSent = true; return this; },
        end(value = '') { this.body += String(value); },
    });
    const req = { method: 'GET', url: '/x', headers: { host: '127.0.0.1:8080' } };
    const result = await ensureHttpRouteAccess(req, res, new URL('http://127.0.0.1:8080/x'),
        { access: 'authenticated', routeKey: 'alpha' },
        { routePlan: { lease: { commit: () => false, snapshot: {} } } });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'edge_generation_changed');
    assert.equal(res.statusCode, 503);
    assert.equal(res.set['x-ploinky-refusal'], 'v=1; stage=auth; cause=edge-generation-changed');
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'edge_generation_changed' });
});

// ---- root WebSocket upgrade refusals ----

test('a refused root WebSocket upgrade is marked at the route stage and only the inactive-selector codes are edge-generation-inactive', async () => {
    const upgradeRefusal = async plan => {
        const socket = new UpgradeSocket();
        socket.destroy = () => {};
        const handled = await handleAgentRootUpgrade({
            req: { method: 'GET', url: '/x', headers: { host: '127.0.0.1:8080' } },
            socket, head: Buffer.alloc(0), parsedUrl: new URL('http://127.0.0.1:8080/x'), routePlan: plan,
        });
        assert.equal(handled, true);
        return socket.body.toString('utf8');
    };
    const inactive = await upgradeRefusal({ kind: 'agent-root', matched: true, ok: false, status: 503, code: 'HOST_SELECTOR_INACTIVE' });
    assert.match(inactive, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
    assert.ok(inactive.includes('\r\nX-Ploinky-Refusal: v=1; stage=route; cause=edge-generation-inactive\r\n'), inactive);
    const corrupt = await upgradeRefusal({ kind: 'agent-root', matched: true, ok: false, status: 503, code: 'EDGE_GENERATION_CORRUPT' });
    assert.ok(corrupt.includes('\r\nX-Ploinky-Refusal: v=1; stage=route; cause=route-denied\r\n'), corrupt);
});

test('proxyApi (POST) never forwards an upstream marker', async (t) => {
    const upstream = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Ploinky-Refusal': FORGED });
        res.end('ok');
    });
    const upstreamPort = await listen(upstream);
    t.after(() => upstream.close());
    const router = http.createServer((req, res) => proxyApi(req, res, upstreamPort));
    const routerPort = await listen(router);
    t.after(() => router.close());
    const answer = await new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: routerPort, method: 'POST', path: '/api/x' }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end('{}');
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['x-ploinky-refusal'], undefined);
    assert.equal(answer.body, 'ok');
});

test('the root WebSocket 101 never forwards an upstream x-ploinky-* header', async (t) => {
    const upstream = http.createServer();
    upstream.on('upgrade', (req, sock) => {
        sock.on('error', () => {});
        sock.write([
            'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
            `X-Ploinky-Refusal: ${MARKER_RELAY_CHANGED}`, 'X-Ploinky-Other: spoof', 'X-App-Header: kept', '', '',
        ].join('\r\n'));
        setTimeout(() => sock.destroy(), 50);
    });
    const port = await listen(upstream);
    t.after(() => upstream.close());
    const socket = new UpgradeSocket();
    socket.destroy = () => {};
    const handled = await handleAgentRootUpgrade({
        req: {
            method: 'GET', url: '/ws',
            headers: {
                host: '127.0.0.1:8080', connection: 'Upgrade', upgrade: 'websocket',
                'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 7).toString('base64'),
            },
        },
        socket, head: Buffer.alloc(0), parsedUrl: new URL('http://127.0.0.1:8080/ws'),
        routePlan: {
            kind: 'agent-root', matched: true, ok: true, routeKey: 'alpha',
            decision: { access: 'public', routeKey: 'alpha' }, target: { hostPort: port },
            upstreamPath: '/ws', lease: { commit: () => true, snapshot: {} },
        },
    });
    assert.equal(handled, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    const head = socket.body.toString('utf8').split('\r\n\r\n')[0];
    assert.match(head, /^HTTP\/1\.1 101 /);
    assert.doesNotMatch(head, /x-ploinky-/i);
    assert.match(head, /x-app-header: kept/i);
});
