import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousCwd = process.cwd();
const previousKey = process.env.PLOINKY_MASTER_KEY;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-capability-routes-'));
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });

const { ensureAuthenticated, ensureHttpRouteAccess } = await import('../../cli/server/authHandlers/authContext.js');
const { authService } = await import('../../cli/server/authHandlers/shared.js');
const { verifyBrowserMutationRequest } = await import('../../cli/server/browserMutationSecurity.js');

test.after(() => {
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousKey;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const DASHBOARD = '/base-agent-additional-server/accountService/7000/service/dashboard/';
const EXPLORER_DECISION = { access: 'authenticated', routeKey: 'explorer', source: 'routeDefault' };
const SERVICE_DECISION = { access: 'authenticated', routeKey: 'accountService', source: 'manifest' };

function fixture(t) {
    const user = {
        id: 'account:restricted',
        roles: ['selfRegistered'],
        capabilities: ['account.dashboard'],
    };
    const session = { user, expiresAt: Date.now() + 60_000 };
    t.mock.method(authService, 'isConfigured', () => true);
    t.mock.method(authService, 'validateSession', async (token) => token === 'verified-session' ? session : null);
    t.mock.method(authService, 'getSession', (token) => token === 'verified-session' ? session : null);
    t.mock.method(authService, 'refreshSession', async () => {});
    const snapshot = {
        agents: {
            explorer: { type: 'agent', agentName: 'explorer', repoName: 'fixture', auth: { mode: 'sso' } },
            accountService: { type: 'agent', agentName: 'accountService', repoName: 'fixture', auth: { mode: 'none' } },
        },
        routing: {
            static: { agent: 'explorer' },
            routes: {
                explorer: { container: 'explorer', agent: 'explorer', repo: 'fixture' },
                accountService: { container: 'accountService', agent: 'accountService', repo: 'fixture' },
            },
        },
        manifests: {
            explorer: { routerAccess: { requiredCapability: 'explorer.access', capabilityDeniedRedirect: DASHBOARD } },
            accountService: { routerAccess: {
                requiredCapability: 'account.dashboard',
                httpRoutes: [{ path: `${DASHBOARD}*`, access: 'authenticated' }],
            } },
        },
    };
    return { snapshot, user };
}

function response() {
    return {
        headers: {}, statusCode: 200, body: '',
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        getHeader(name) { return this.headers[name.toLowerCase()]; },
        writeHead(status, headers) {
            this.statusCode = status;
            for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
        },
        end(body = '') { this.body += body; },
    };
}

function request({ url = '/explorer/', method = 'GET', headers = {} } = {}) {
    return {
        method, url,
        headers: {
            host: 'localhost', accept: 'text/html,application/xhtml+xml',
            cookie: 'ploinky_sso=verified-session', ...headers,
        },
        socket: {},
    };
}

async function access(snapshot, input = {}, decision = EXPLORER_DECISION, options = {}) {
    const req = request(input);
    const res = response();
    const result = await ensureHttpRouteAccess(req, res, new URL(req.url, 'http://localhost'), decision, { snapshot, ...options });
    return { req, res, result };
}

test('a restricted HTML navigation redirects to the manifest dashboard without caching the denial', async (t) => {
    const { snapshot } = fixture(t);
    const { req, res, result } = await access(snapshot, {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    assert.deepEqual(result, { ok: false, error: 'required_capability_missing', redirect: DASHBOARD });
    assert.equal(res.statusCode, 302);
    assert.equal(res.getHeader('location'), DASHBOARD);
    assert.equal(res.getHeader('cache-control'), 'no-store');
    assert.equal(req.user.id, 'account:restricted');
});

test('capable identities proceed normally and malformed capability declarations never redirect', async (t) => {
    const { snapshot, user } = fixture(t);
    user.capabilities.push('explorer.access');
    assert.equal((await access(snapshot)).result.ok, true);
    snapshot.manifests.explorer.routerAccess.requiredCapability = ['explorer.access'];
    const denied = await access(snapshot);
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.result.error, 'required_capability_invalid');
    assert.equal(denied.res.getHeader('location'), undefined);
});

test('API, MCP, SSE, upgrades, fetches, non-GET requests and redirect loops retain the JSON 403', async (t) => {
    const { snapshot } = fixture(t);
    const cases = [
        { headers: { accept: 'application/json' } },
        { headers: { accept: 'text/html,application/problem+json' } },
        { headers: { accept: 'text/html,text/event-stream' } },
        { headers: { accept: '*/*' } },
        { headers: { accept: 'text/html;q=0' } },
        { headers: { upgrade: 'websocket' } },
        { headers: { 'mcp-session-id': 'mcp-session' } },
        { headers: { 'mcp-protocol-version': '2025-03-26' } },
        { headers: { 'last-event-id': 'event-1' } },
        { headers: { 'x-requested-with': 'XMLHttpRequest' } },
        { headers: { 'sec-fetch-mode': 'cors' } },
        { headers: { 'sec-fetch-dest': 'empty' } },
        { headers: { 'sec-fetch-dest': 'iframe' } },
        { method: 'POST' },
        { method: 'HEAD' },
        { method: 'OPTIONS' },
        { url: '/api/explorer/tree' },
        { url: '/explorer/api/tree' },
        { url: '/explorer/%61pi/tree' },
        { url: '/mcp' },
        { url: '/explorer/mcp/' },
        { url: '/base-agent-additional-server/explorer/7000/mcp' },
        { url: DASHBOARD },
        { url: `${DASHBOARD}index.html` },
        { url: DASHBOARD.slice(0, -1) },
        { url: `${DASHBOARD}?retry=1` },
    ];
    for (const input of cases) {
        const { res, result } = await access(snapshot, input);
        assert.equal(result.ok, false, JSON.stringify(input));
        assert.equal(res.statusCode, 403, JSON.stringify(input));
        assert.equal(res.getHeader('location'), undefined, JSON.stringify(input));
        assert.deepEqual(JSON.parse(res.body), {
            ok: false, error: 'required_capability_missing', requiredCapability: 'explorer.access',
        }, JSON.stringify(input));
    }
});

test('unsafe and external manifest redirect targets are rejected', async (t) => {
    const { snapshot } = fixture(t);
    for (const target of [
        '', 42, '//evil.test/', 'https://evil.test/', 'javascript:alert(1)',
        '/\\evil.test/', '/dashboard/\r\nLocation: https://evil.test/',
        '/%2f%2fevil.test/', '/%252f%252fevil.test/', '/dashboard/?x=%0d%0a',
        '/dashboard/#//evil.test', '/dashboard/#https://evil.test', '/bad%encoding', '/',
    ]) {
        snapshot.manifests.explorer.routerAccess.capabilityDeniedRedirect = target;
        const { res } = await access(snapshot);
        assert.equal(res.statusCode, 403, String(target));
        assert.equal(res.getHeader('location'), undefined, String(target));
    }
    snapshot.manifests.explorer.routerAccess.capabilityDeniedRedirect = '/account/../dashboard/?tab=profile#security';
    assert.equal((await access(snapshot)).res.getHeader('location'), '/dashboard/?tab=profile#security');
});

test('an explicitly authenticated service dashboard uses its own capability and retains browser proof binding', async (t) => {
    const { snapshot, user } = fixture(t);
    const routePlan = {
        snapshot, decision: SERVICE_DECISION,
        lease: { id: `sha256:${'c'.repeat(64)}`, commit: () => true },
        forwarding: { protocol: 'http', authority: 'localhost' },
    };
    const { req, res, result } = await access(snapshot, { url: DASHBOARD }, SERVICE_DECISION, { routePlan });
    assert.equal(result.ok, true);
    assert.equal(req.authMode, 'sso');
    assert.equal(req.edgeAuthContext.routeKey, 'explorer');
    assert.equal(req.edgeAuthContext.serviceRouteKey, 'accountService');
    assert.equal(req.edgeAuthContext.capabilityOwnerRouteKey, 'accountService');
    assert.equal(user.capabilities.includes('explorer.access'), false);
    assert.match(req.browserCsrfToken, /^v2\./);
    assert.match(String(res.getHeader('set-cookie')), /ploinky_browser_csrf=/);
    req.headers.origin = 'http://localhost';
    const proof = verifyBrowserMutationRequest(req, {
        routePlan, authContext: req.edgeAuthContext, token: req.browserCsrfToken,
    });
    assert.equal(proof.ok, true);
    assert.equal(proof.routeKey, 'accountService');
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan: { ...routePlan, lease: { id: 'different-generation' } },
        authContext: req.edgeAuthContext, token: req.browserCsrfToken,
    }).ok, false);

    const plannedReq = request({ url: DASHBOARD });
    assert.equal((await ensureAuthenticated(plannedReq, response(), new URL(plannedReq.url, 'http://localhost'), { routePlan })).ok, true);
    user.capabilities = [];
    const denied = await access(snapshot, { url: DASHBOARD }, SERVICE_DECISION);
    assert.equal(denied.res.statusCode, 403);
    assert.equal(JSON.parse(denied.res.body).requiredCapability, 'account.dashboard');
});

test('the dashboard requires a verified user session even though its agent auth mode is none', async (t) => {
    const { snapshot } = fixture(t);
    for (const cookie of ['', 'ploinky_sso=forged', 'ploinky_guest=guest-session']) {
        const { res, result } = await access(snapshot, {
            url: DASHBOARD, headers: { cookie, accept: 'application/json' },
        }, SERVICE_DECISION);
        assert.equal(result.ok, false);
        assert.equal(res.statusCode, 401);
        assert.equal(JSON.parse(res.body).error, 'not_authenticated');
    }
});

test('default inheritance and public or guest declarations cannot bypass the static owner capability', async (t) => {
    const { snapshot } = fixture(t);
    for (const httpRoutes of [
        [],
        [{ path: `${DASHBOARD}*`, access: 'guest' }],
        [{ path: `${DASHBOARD}*`, access: 'public' }],
        [{ path: '/another-page/*', access: 'authenticated' }],
        [{ path: '/base-agent-additional-server/explorer/7000/service/dashboard/*', access: 'authenticated' }],
    ]) {
        snapshot.manifests.accountService.routerAccess.httpRoutes = httpRoutes;
        const { res } = await access(snapshot, {
            url: DASHBOARD, headers: { accept: 'application/json' },
        }, { ...SERVICE_DECISION, source: 'routeDefault' });
        assert.equal(res.statusCode, 403, JSON.stringify(httpRoutes));
        assert.equal(JSON.parse(res.body).requiredCapability, 'explorer.access', JSON.stringify(httpRoutes));
    }
});
