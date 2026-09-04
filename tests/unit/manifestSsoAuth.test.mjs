import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const previousCwd = process.cwd();
const previousKey = process.env.PLOINKY_MASTER_KEY;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-manifest-sso-'));
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
const { signBrowserSessionFixture } = await import('../helpers/routerSessionFixture.mjs');
const { ensureHttpRouteAccess, resolveAuthContextForRouteKey, localSessionAllowedForRoutePlan } = await import('../../cli/server/authHandlers/authContext.js');
const { handleAuthRoutes } = await import('../../cli/server/authHandlers/authRoutes.js');
const { handleMarketplaceRoutes } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { handleUserAdminRoutes } = await import('../../cli/server/authHandlers/userAdminRoutes.js');
const { authService } = await import('../../cli/server/authHandlers/shared.js');
const { resolveAgentAuthPolicy, resolveManifestAuthMode } = await import('../../cli/utils/manifestAuth.js');

test.after(() => {
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousKey;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const policy = { mode: 'local', usersVar: 'FIXTURE_LOCAL_USERS' };
const localToken = signBrowserSessionFixture({ id: 'local:old-admin', username: 'old-admin', roles: ['admin', 'user'] });

function snapshot(mode = 'local') {
    return {
        generation: 'test-generation',
        agents: { app: { type: 'agent', agentName: 'app', repoName: 'fixture', auth: { ...policy, mode } } },
        routing: { static: { agent: 'app' }, routes: { app: { container: 'app', repo: 'fixture', agent: 'app' } } },
        manifests: { app: { ploinky: 'sso enable', sso: { providerAgent: 'identity' }, routerAccess: { requiredCapability: 'app.access' } } },
    };
}

function response() {
    return {
        headers: {}, statusCode: 200,
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        getHeader(name) { return this.headers[name.toLowerCase()]; },
        writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); },
        end(body) { this.body = body; },
    };
}

test('manifest SSO rejects conflicting declarations and overrides saved local, guest, or disabled policy', () => {
    for (const ploinky of ['sso enable', ['sso enable'], 'other; SSO ENABLE\n']) {
        for (const mode of ['local', 'pwd', 'guest', 'none', '']) {
            assert.deepEqual(resolveAgentAuthPolicy({ ploinky }, { mode, usersVar: 'old-users' }), { mode: 'sso' });
            assert.equal(resolveAuthContextForRouteKey('app', { snapshot: snapshot(mode) }).mode, 'sso');
        }
    }
    assert.throws(() => resolveManifestAuthMode({ ploinky: ['sso enable', 'pwd enable'] }), /no longer supported/);
    assert.throws(() => resolveManifestAuthMode({ ploinky: 'sso enable', guest: true }), /cannot be combined/);
    assert.throws(() => resolveAgentAuthPolicy({ ploinky: 'pwd enable' }, policy), /no longer supported/);
    assert.throws(() => resolveAgentAuthPolicy({}, policy), /no longer supported/);
});

test('protected SSO routes reject valid local browser sessions and require provider capabilities', async (t) => {
    t.mock.method(authService, 'isConfigured', () => true);
    t.mock.method(authService, 'validateSession', async (id) => ({ user: {
        id: 'provider-user', roles: ['admin'], capabilities: id === 'allowed' ? ['app.access'] : [],
    } }));
    const url = new URL('http://localhost/base-agent-additional-server/app/7000/private');
    for (const [cookie, expectedStatus] of [[`ploinky_jwt=${localToken}`, 401], ['ploinky_sso=restricted', 403], ['ploinky_sso=allowed', 200]]) {
        const req = { method: 'GET', url: url.pathname, headers: { host: 'localhost', accept: 'application/json', cookie }, socket: {} };
        const res = response();
        const result = await ensureHttpRouteAccess(req, res, url, { access: 'authenticated', routeKey: 'app' }, { snapshot: snapshot() });
        assert.equal(res.statusCode, expectedStatus, res.body);
        assert.equal(result.ok, expectedStatus === 200);
        if (result.ok) assert.equal(req.authMode, 'sso');
        else assert.equal(JSON.parse(res.body).ok, false);
    }
});

test('control surfaces select the bound application and only exempt the verified CLI operator', () => {
    const currentSnapshot = snapshot();
    currentSnapshot.agents.localApp = { type: 'agent', agentName: 'localApp', auth: policy };
    currentSnapshot.routing.routes.localApp = { container: 'localApp' };
    currentSnapshot.manifests.localApp = {};
    const browser = { user: { id: 'local:admin', roles: ['admin'] } };
    assert.equal(localSessionAllowedForRoutePlan(browser, { snapshot: currentSnapshot }), false);
    assert.equal(localSessionAllowedForRoutePlan({ ...browser, _jwtPayload: { chn: 'cli' } }, { snapshot: currentSnapshot }), true);
    assert.equal(localSessionAllowedForRoutePlan({ user: { id: 'local:other' }, _jwtPayload: { chn: 'cli' } }, { snapshot: currentSnapshot }), false);
    const localHost = { snapshot: currentSnapshot, hostSelection: { kind: 'agent-root', record: { routeKey: 'localApp' } } };
    assert.equal(localSessionAllowedForRoutePlan(browser, localHost), false);
    assert.equal(localSessionAllowedForRoutePlan(browser, null), false);
});

test('login delegates to SSO and old local login/account requests fail over HTTP', async (t) => {
    let configured = true;
    t.mock.method(authService, 'isConfigured', () => configured);
    const beginLogin = t.mock.method(authService, 'beginLogin', async ({ baseUrl, returnTo }) => {
        assert.ok(baseUrl.startsWith('http://127.0.0.1:'));
        assert.equal(returnTo, '/files');
        return { redirectUrl: `${baseUrl}/identity/login`, state: 's'.repeat(22), browserBinding: 'proof', expiresAt: Date.now() + 60_000 };
    });
    const server = http.createServer(async (req, res) => {
        try {
            const currentSnapshot = snapshot();
            currentSnapshot.agents.localApp = { type: 'agent', agentName: 'localApp', auth: policy };
            currentSnapshot.routing.routes.localApp = { container: 'localApp' };
            currentSnapshot.manifests.localApp = {};
            const routePlan = { lease: { id: 'test-generation', snapshot: currentSnapshot, commit: () => true } };
            const url = new URL(req.url, `http://${req.headers.host}`);
            if (!await handleAuthRoutes(req, res, url, { routePlan })
                && !await handleMarketplaceRoutes(req, res, url, { routePlan })
                && !await handleUserAdminRoutes(req, res, url, { routePlan })) {
                res.writeHead(404); res.end();
            }
        } catch (error) { res.writeHead(500); res.end(error.message); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { cookie: `ploinky_jwt=${localToken}` };
    const login = await fetch(`${base}/auth/login?returnTo=/files`, { headers });
    const loginHtml = await login.text();
    assert.equal(login.status, 200, loginHtml);
    assert.match(loginHtml, /\/identity\/login/);
    assert.equal(beginLogin.mock.callCount(), 1);
    assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
    const passwordPost = await fetch(`${base}/auth/login`, { method: 'POST', headers, body: 'username=old-admin&password=fixture+password' });
    assert.equal(passwordPost.status, 405);
    for (const method of ['GET', 'POST']) {
        const account = await fetch(`${base}/auth/account`, { method, headers });
        assert.equal(account.status, 404);
        assert.deepEqual(await account.json(), { ok: false, error: 'local_auth_disabled' });
        const marketplace = await fetch(`${base}/api/marketplace?agent=localApp`, { method, headers });
        assert.equal(marketplace.status, 401, await marketplace.text());
    }
    const users = await fetch(`${base}/api/agents/app/users`, { headers });
    assert.equal(users.status, 401, await users.text());
    configured = false;
    const unavailable = await fetch(`${base}/auth/login`, { headers });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { ok: false, error: 'sso_disabled' });
    assert.equal(beginLogin.mock.callCount(), 1, 'unavailable provider never falls back to local credentials');
});
