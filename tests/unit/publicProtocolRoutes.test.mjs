import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { resolveEdgeRoutePlan, httpAccessForEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { ensureHttpRouteAccess } from '../../cli/server/authHandlers/authContext.js';
import { normalizeManifestHttpRouteAccess } from '../../cli/server/policy/HttpRouteProviders.js';
import { executeHttpPlan } from '../../cli/server/proxy/executeHttpPlan.js';
import { sanitizeResponseHeaders } from '../../cli/server/proxy/sanitizeResponseHeaders.js';

const PREFIX = '/base-agent-additional-server/alpha/7000';
const PROTOCOL = { methods: ['GET', 'HEAD', 'POST', 'OPTIONS'], allowCors: true, allowLoopbackRedirects: true };
const protocolRoute = overrides => ({ path: `${PREFIX}/service/protocol/*`, access: 'public', publicProtocol: PROTOCOL, ...overrides });

function fixture(t, { routes = [protocolRoute(), { path: `${PREFIX}/public/*`, access: 'public' }], policyRoutes = [] } = {}) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-public-protocol-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const agentDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    for (const directory of [agentDir, edgeDir, policyDir]) fs.mkdirSync(directory, { recursive: true });
    const manifestPath = path.join(agentDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ routerAccess: { httpRoutes: routes } }));
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'alpha', port: 7777 },
        routes: { alpha: { repo: 'fixtures', agent: 'alpha', container: 'alpha-container', hostPath: agentDir, hostPort: 43101 } },
    }));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        'alpha-container': {
            type: 'agent', repoName: 'fixtures', agentName: 'alpha',
            instanceId: 'alpha-instance', enableGeneration: 'alpha-enabled',
            runtime: 'podman', containerId: 'a'.repeat(64), auth: { mode: 'sso' },
        },
    }));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({ hosts: {} }));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({ schema: 'router-policy', httpRoutes: policyRoutes, mcpTools: [] }));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(() => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    return {
        workspace, manifestPath,
        activate: () => applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'public-protocol-unit' }),
    };
}

function request(method = 'POST', suffix = '/service/protocol/token', headers = {}, body = '') {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = `${PREFIX}${suffix}`;
    req.headers = { host: '127.0.0.1:8080', ...headers };
    return req;
}

function resolve(req, transport = 'http') {
    return resolveEdgeRoutePlan({ req, listener: 'public', transport });
}

class Response extends Writable {
    constructor() { super(); this.statusCode = 0; this.headers = {}; this.body = ''; this.headersSent = false; }
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
    _write(chunk, _, done) { this.body += chunk.toString(); done(); }
}

class RelayResponse extends EventEmitter {
    constructor(response) {
        super();
        this.response = response;
        this.channel = { child: { stdin: new EventEmitter() } };
        this.received = Buffer.alloc(0);
    }
    write(chunk) {
        this.received = Buffer.concat([this.received, Buffer.from(chunk)]);
        const end = this.received.indexOf('\r\n\r\n');
        if (end < 0 || this.replied) return true;
        const length = Number(this.received.subarray(0, end).toString().match(/content-length:\s*(\d+)/i)?.[1] || 0);
        if (this.received.length < end + 4 + length) return true;
        this.replied = true;
        setImmediate(() => { this.emit('data', Buffer.from(this.response)); this.emit('end'); });
        return true;
    }
    end() {}
    abandon() {}
}

test('public protocol opt-in validates ownership, narrow scope, methods and trust source', t => {
    assert.equal(normalizeManifestHttpRouteAccess(protocolRoute(), { routeKey: 'alpha' }).ok, true);
    for (const spec of [
        protocolRoute({ access: 'guest' }),
        protocolRoute({ access: 'authenticated' }),
        protocolRoute({ path: '/service/protocol/*' }),
        protocolRoute({ path: `${PREFIX}/*` }),
        protocolRoute({ path: '/base-agent-additional-server/beta/7000/protocol/*' }),
        protocolRoute({ publicProtocol: true }),
        protocolRoute({ publicProtocol: { methods: [] } }),
        protocolRoute({ publicProtocol: { methods: ['GET', 'GET'] } }),
        protocolRoute({ publicProtocol: { methods: ['PUT'] } }),
        protocolRoute({ publicProtocol: { methods: ['POST'], allowCors: 'yes' } }),
        protocolRoute({ publicProtocol: { methods: ['POST'], allowLoopbackRedirects: 1 } }),
        protocolRoute({ publicProtocol: { methods: ['POST'], unrestricted: true } }),
    ]) assert.equal(normalizeManifestHttpRouteAccess(spec, { routeKey: 'alpha' }).ok, false, JSON.stringify(spec));
    const fakeManifestSource = fixture(t, { routes: [], policyRoutes: [{ ...protocolRoute(), routeKey: 'alpha', source: 'manifest' }] });
    assert.throws(fakeManifestSource.activate, /publicProtocol requires a public manifest route/);
});

test('exact generation admits declared anonymous methods and preserves default public guards', async t => {
    fixture(t).activate();
    for (const method of PROTOCOL.methods) {
        const req = request(method, '/service/protocol/token', {
            authorization: 'Bearer application-token',
            cookie: 'ploinky_jwt=untrusted; application_session=valid',
        });
        const plan = resolve(req);
        assert.equal(plan.ok, true, method);
        assert.equal(plan.access.access, 'public');
        assert.equal(plan.authDefinition.includeAuthInfo, false);
        const response = new Response();
        assert.deepEqual(await ensureHttpRouteAccess(req, response, plan.parsedUrl, httpAccessForEdgeRoutePlan(plan), { routePlan: plan }), { ok: true });
        assert.equal(req.user, undefined);
        assert.equal(req.authMode, undefined);
        assert.deepEqual(response.headers, {});
    }
    for (const method of ['PUT', 'PATCH', 'DELETE', 'TRACE']) {
        const plan = resolve(request(method));
        assert.equal(plan.ok, false, method);
        assert.equal(plan.code, 'PUBLIC_ROUTE_WRITE_DENIED');
    }
    for (const method of ['POST', 'OPTIONS']) {
        const plan = resolve(request(method, '/public/file'));
        assert.equal(plan.code, 'PUBLIC_ROUTE_WRITE_DENIED');
    }
    const authenticated = resolve(request('POST', '/other'));
    assert.equal(authenticated.access.access, 'authenticated');
    const websocket = resolve(request('GET'), 'websocket');
    assert.equal(websocket.code, 'PUBLIC_PROTOCOL_TRANSPORT_DENIED');
});

test('generation rejects ambiguous protocol permissions while stronger administrator policy stays authoritative', t => {
    const state = fixture(t, { routes: [
        protocolRoute(), protocolRoute({ path: `${PREFIX}/service/protocol/token`, publicProtocol: { methods: ['GET'] } }),
    ] });
    assert.throws(state.activate, /conflicting execution metadata/);
    fs.writeFileSync(state.manifestPath, JSON.stringify({ routerAccess: { httpRoutes: [protocolRoute()] } }));
    const policyPath = path.join(state.workspace, '.ploinky/data/router-security/policy-state.json');
    fs.writeFileSync(policyPath, JSON.stringify({ schema: 'router-policy', mcpTools: [], httpRoutes: [
        { path: `${PREFIX}/service/protocol/token`, access: 'authenticated', routeKey: 'alpha' },
    ] }));
    state.activate();
    const plan = resolve(request());
    assert.equal(plan.access.access, 'authenticated');
    assert.equal(plan.access.publicProtocol, undefined);
    assert.equal(plan.responsePolicy.publicProtocol, undefined);
});

test('protocol HTTP relay forwards exact client credentials and provider CORS/cookies without Router identity', async t => {
    fixture(t).activate();
    const req = request('POST', '/service/protocol/token', {
        authorization: 'Basic Y2xpZW50OnNlY3JldA==', origin: 'https://client.example',
        cookie: 'application_session=valid; ploinky_sso=router; __Host-ploinky_sso_login_proof=private',
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https',
        'x-ploinky-auth-info': 'forged', 'x-ploinky-user-id': 'admin',
    }, 'grant_type=authorization_code&code=opaque');
    const plan = resolve(req);
    const res = new Response();
    let opened;
    let stream;
    const relayManager = { checkout: async ({ lease }) => {
        assert.equal(lease.commit(), true);
        return {
            openRequest: async args => {
                opened = args;
                stream = new RelayResponse([
                    'HTTP/1.1 200 OK', 'Content-Length: 2', 'Connection: close',
                    'Access-Control-Allow-Origin: https://client.example',
                    'Access-Control-Allow-Headers: Authorization, Content-Type, X-Ploinky-Auth-Info',
                    'Access-Control-Allow-Methods: POST, OPTIONS, PUT',
                    'Set-Cookie: application_session=new; Path=/; HttpOnly',
                    'Set-Cookie: __Host-ploinky_sso_login_proof=forged; Path=/',
                    'X-Ploinky-Auth-Info: forbidden', '', '{}',
                ].join('\r\n'));
                return stream;
            }, close() {},
        };
    } };
    await executeHttpPlan({ req, res, plan, lease: plan.lease, relayManager, authorized: true,
        // A public protocol request never inherits identity, even if a future
        // Router caller supplies trusted session context to this shared proxy.
        trustedHeaders: { authInfo: 'must-not-forward', userId: 'admin' },
        prebufferedBody: Buffer.from('grant_type=authorization_code&code=opaque'),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(opened.plan.targetPath, '/service/protocol/token');
    assert.equal(opened.headers.authorization, 'Basic Y2xpZW50OnNlY3JldA==');
    assert.equal(opened.headers.cookie, 'application_session=valid');
    assert.equal(opened.headers['x-ploinky-auth-info'], undefined);
    assert.equal(opened.headers['x-ploinky-user-id'], undefined);
    assert.equal(opened.headers['x-forwarded-host'], plan.authority);
    assert.equal(opened.headers['x-forwarded-proto'], 'http');
    assert.equal(opened.headers['x-forwarded-prefix'], PREFIX);
    assert.match(stream.received.toString(), /grant_type=authorization_code&code=opaque$/);
    assert.equal(res.headers['access-control-allow-origin'], 'https://client.example');
    assert.equal(res.headers['access-control-allow-headers'], 'authorization, content-type');
    assert.equal(res.headers['access-control-allow-methods'], 'POST, OPTIONS');
    assert.deepEqual(res.headers['set-cookie'], ['application_session=new; Path=/; HttpOnly']);
    assert.equal(res.headers['x-ploinky-auth-info'], undefined);
});

test('CORS preflight reaches protocol provider and rejects wildcard, mismatched and opaque origins', async t => {
    fixture(t).activate();
    const req = request('OPTIONS', '/service/protocol/token', {
        origin: 'https://client.example', 'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
    });
    const plan = resolve(req);
    const res = new Response();
    await executeHttpPlan({ req, res, plan, lease: plan.lease, authorized: true, prebufferedBody: Buffer.alloc(0),
        relayManager: { checkout: async ({ lease }) => {
            assert.equal(lease.commit(), true);
            return { openRequest: async args => {
                assert.equal(args.headers['access-control-request-method'], 'POST');
                assert.equal(args.headers.origin, 'https://client.example');
                return new RelayResponse('HTTP/1.1 204 No Content\r\nConnection: close\r\nAccess-Control-Allow-Origin: https://client.example\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\n\r\n');
            }, close() {} };
        } },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'https://client.example');
    for (const origin of ['*', 'null', 'https://other.example']) {
        assert.equal(sanitizeResponseHeaders({ 'access-control-allow-origin': origin }, plan)['access-control-allow-origin'], undefined);
    }
    for (const origin of ['null', 'https://client.example/path', 'https://client.example/']) {
        const opaquePlan = { ...plan, responsePolicy: { ...plan.responsePolicy, requestOrigin: origin } };
        assert.equal(sanitizeResponseHeaders({ 'access-control-allow-origin': origin }, opaquePlan)['access-control-allow-origin'], undefined);
    }
    const defaultPlan = resolve(request('GET', '/public/file'));
    assert.equal(sanitizeResponseHeaders({ 'access-control-allow-origin': 'https://client.example' }, defaultPlan)['access-control-allow-origin'], undefined);
});

test('only opted-in protocol responses allow exact loopback callbacks, never internal targets', t => {
    fixture(t).activate();
    const protocol = resolve(request('GET'));
    const ordinary = resolve(request('GET', '/public/file'));
    for (const location of ['http://127.0.0.1:54321/callback?code=opaque', 'http://[::1]:54321/callback', 'http://localhost:54321/callback']) {
        assert.equal(sanitizeResponseHeaders({ location }, protocol).location, location);
        assert.equal(sanitizeResponseHeaders({ location }, ordinary).location, undefined);
    }
    for (const location of ['http://10.0.0.2/private', 'http://agent.localhost:7000/private', 'http://agent.internal/private',
        'http://[fd00::1]/private', 'http://127.2.3.4/private', 'javascript:alert(1)', '//127.0.0.1/private',
        'http://user:password@127.0.0.1/callback']) {
        assert.equal(sanitizeResponseHeaders({ location }, protocol).location, undefined, location);
    }
    assert.equal(sanitizeResponseHeaders({ location: 'https://client.example/callback' }, protocol).location, 'https://client.example/callback');
});

test('a public protocol lease loses authority on generation replacement before any relay request opens', async t => {
    const state = fixture(t);
    state.activate();
    const req = request();
    const plan = resolve(req);
    fs.writeFileSync(state.manifestPath, JSON.stringify({ routerAccess: { httpRoutes: [{ path: `${PREFIX}/service/protocol/*`, access: 'public' }] } }));
    state.activate();
    const res = new Response();
    let opened = false;
    await executeHttpPlan({ req, res, plan, lease: plan.lease, authorized: true, prebufferedBody: Buffer.alloc(0),
        relayManager: { checkout: async ({ lease }) => {
            if (!lease.commit()) throw Object.assign(new Error('stale protocol lease'), { code: 'EDGE_GENERATION_CHANGED' });
            opened = true;
            throw new Error('must not reach an upstream connection');
        } },
    });
    assert.equal(opened, false);
    assert.equal(res.statusCode, 503);
    const denied = resolve(request());
    assert.equal(denied.code, 'PUBLIC_ROUTE_WRITE_DENIED');
});
