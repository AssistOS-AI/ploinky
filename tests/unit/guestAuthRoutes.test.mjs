import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { signBrowserSessionFixture } from '../helpers/routerSessionFixture.mjs';

import { dispatchAgentStartupRequest } from '../../cli/server/agentStartupDispatch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '4'.repeat(64);

class MockResponse {
    constructor() {
        this.statusCode = 200;
        this.headers = new Map();
        this.body = '';
    }

    setHeader(name, value) {
        this.headers.set(String(name).toLowerCase(), value);
    }

    getHeader(name) {
        return this.headers.get(String(name).toLowerCase());
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        for (const [name, value] of Object.entries(headers || {})) {
            this.setHeader(name, value);
        }
    }

    end(chunk = '') {
        this.body += chunk ? String(chunk) : '';
    }
}

function makeRequest({
    method = 'GET',
    url,
    body,
    cookie = '',
    accept = 'application/json',
    host = 'localhost',
    headers = {},
}) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = Readable.from(chunks);
    req.method = method;
    req.url = url;
    req.headers = {
        accept,
        host,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
    };
    req.socket = { encrypted: false };
    return req;
}

function writeWorkspaceConfig(ploinkyDir, { staticAuthMode = 'sso' } = {}) {
    writeFileSync(path.join(ploinkyDir, '.secrets'), '# test secrets\n');
    const webAdminManifestDir = path.join(ploinkyDir, 'repos', 'webassist', 'webAdmin');
    const serviceManifestDir = path.join(ploinkyDir, 'repos', 'services', 'guestAgent');
    mkdirSync(webAdminManifestDir, { recursive: true });
    mkdirSync(serviceManifestDir, { recursive: true });
    writeFileSync(path.join(webAdminManifestDir, 'manifest.json'), JSON.stringify({
        webchat: { auth: 'static' },
    }, null, 2));
    const webAssistManifestDir = path.join(ploinkyDir, 'repos', 'webassist', 'webAssist');
    const staleManifestGuestDir = path.join(ploinkyDir, 'repos', 'webassist', 'manifestGuest');
    mkdirSync(webAssistManifestDir, { recursive: true });
    mkdirSync(staleManifestGuestDir, { recursive: true });
    writeFileSync(path.join(webAssistManifestDir, 'manifest.json'), JSON.stringify({
        routerAccess: {
            httpRoutes: [{
                path: '/base-agent-additional-server/webAssist/7000/*',
                access: 'authenticated',
            }],
        },
    }, null, 2));
    writeFileSync(path.join(staleManifestGuestDir, 'manifest.json'), JSON.stringify({
        guest: true,
    }, null, 2));
    writeFileSync(path.join(serviceManifestDir, 'manifest.json'), JSON.stringify({
        routerAccess: {
            httpRoutes: [
            {
                path: '/base-agent-additional-server/guestAgent/7000/meeting-room/*',
                access: 'guest',
                guestScope: 'meeting-room-public-service',
            },
            {
                path: '/base-agent-additional-server/guestAgent/7000/visitor-support/*',
                access: 'guest',
                guestScope: 'visitor-support-public-service',
            },
            {
                path: '/base-agent-additional-server/guestAgent/7000/locked/*',
                access: 'authenticated',
            },
            ],
        },
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'AchillesIDE',
            auth: { mode: staticAuthMode },
        },
        webAssist: {
            type: 'agent',
            agentName: 'webAssist',
            repoName: 'webassist',
            auth: { mode: 'guest' },
        },
        manifestGuest: {
            type: 'agent',
            agentName: 'manifestGuest',
            repoName: 'webassist',
            auth: { mode: 'none' },
        },
        webAdmin: {
            type: 'agent',
            agentName: 'webAdmin',
            repoName: 'webassist',
            auth: { mode: 'none' },
        },
        guestAgent: {
            type: 'agent',
            agentName: 'guestAgent',
            repoName: 'services',
            auth: { mode: 'none' },
        },
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: {
            explorer: { agent: 'explorer', repo: 'AchillesIDE', hostPort: 55289 },
            webAssist: { agent: 'webAssist', repo: 'webassist', hostPort: 53659, hostPath: webAssistManifestDir },
            manifestGuest: { agent: 'manifestGuest', repo: 'webassist', hostPort: 53660, hostPath: staleManifestGuestDir },
            webAdmin: { agent: 'webAdmin', repo: 'webassist', hostPort: 41155 },
            guestAgent: {
                agent: 'guestAgent',
                repo: 'services',
                hostPort: 43111,
                hostPath: serviceManifestDir,
            },
        },
        static: {
            agent: 'explorer',
            hostPath: '/tmp/explorer',
        },
    }, null, 2));
}

async function withAuthModules(t, options = {}) {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-guest-auth-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    mkdirSync(ploinkyDir, { recursive: true });
    writeWorkspaceConfig(ploinkyDir, options);

    const previousCwd = process.cwd();
    const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.chdir(workspace);
    process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(() => {
        process.chdir(previousCwd);
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_MASTER_KEY;
        } else {
            process.env.PLOINKY_MASTER_KEY = previousMasterKey;
        }
        if (previousWorkspaceRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        }
        rmSync(workspace, { recursive: true, force: true });
    });

    const nonce = `${Date.now()}-${Math.random()}`;
    const authHandlers = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/authHandlers/index.js')).href}?test=${nonce}`);
    const localService = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/auth/localService.js')).href}?test=${nonce}`);
    t.mock.method(authHandlers.authService, 'isConfigured', () => true);
    const createRoutePlan = (overrides = {}) => {
        const snapshot = {
            generation: 'guest-auth-test-generation',
            routing: JSON.parse(readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8')),
            agents: JSON.parse(readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8')),
            manifests: {},
        };
        return {
            ok: false,
            kind: null,
            hostSelection: { kind: 'control', host: 'localhost' },
            snapshot,
            lease: {
                id: snapshot.generation,
                snapshot,
                commit: () => true,
            },
            ...overrides,
        };
    };
    return { authHandlers, localService, authService: authHandlers.authService, createRoutePlan };
}

test('guest routes use the guest agent policy instead of the static Explorer policy', async (t) => {
    const { authHandlers, createRoutePlan } = await withAuthModules(t);
    const mcpReq = makeRequest({
        method: 'POST',
        url: '/webAssist/mcp',
    });
    const mcpRes = new MockResponse();
    const mcpParsedUrl = new URL(mcpReq.url, 'http://localhost');

    const mcpResult = await authHandlers.ensureAuthenticated(mcpReq, mcpRes, mcpParsedUrl);

    assert.equal(mcpResult.ok, true);
    assert.equal(mcpReq.authMode, 'guest');
    assert.equal(mcpReq.user?.username, 'visitor');
    assert.deepEqual(mcpReq.user?.roles, ['guest']);
    assert.match(String(mcpRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);
    assert.doesNotMatch(String(mcpRes.getHeader('set-cookie') || ''), /^ploinky_jwt=/);

    const guestJwt = String(mcpReq.sessionId || '');
    const tokenReq = makeRequest({
        method: 'GET',
        url: '/auth/token?agent=webAssist',
        cookie: `ploinky_jwt=invalid-local-session; ploinky_guest=${guestJwt}`,
    });
    const tokenRes = new MockResponse();
    const tokenParsedUrl = new URL(tokenReq.url, 'http://localhost');

    const handled = await authHandlers.handleAuthRoutes(tokenReq, tokenRes, tokenParsedUrl, {
        routePlan: createRoutePlan(),
    });
    const body = JSON.parse(tokenRes.body || '{}');

    assert.equal(handled, true);
    assert.equal(tokenRes.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.token.accessToken, null);
    assert.equal(body.user.username, 'visitor');
    assert.deepEqual(body.user.roles, ['guest']);
    assert.match(String(tokenRes.getHeader('set-cookie') || ''), /^ploinky_browser_csrf=/);
    assert.match(String(tokenRes.getHeader('set-cookie') || ''), /Max-Age=3600/);
    assert.equal(body.browserMutation.generation, 'guest-auth-test-generation');

    const manifestGuestReq = makeRequest({
        method: 'POST',
        url: '/manifestGuest/mcp',
    });
    const manifestGuestRes = new MockResponse();
    const manifestGuestParsedUrl = new URL(manifestGuestReq.url, 'http://localhost');
    const manifestGuestResult = await authHandlers.ensureAuthenticated(manifestGuestReq, manifestGuestRes, manifestGuestParsedUrl);

    assert.equal(manifestGuestResult.ok, false);
    assert.equal(manifestGuestRes.statusCode, 401);
    assert.equal(manifestGuestReq.authMode, undefined);
    assert.equal(manifestGuestReq.user, undefined);
    assert.doesNotMatch(String(manifestGuestRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);
    const staleManifestBody = JSON.parse(manifestGuestRes.body || '{}');
    assert.equal(staleManifestBody.error, 'not_authenticated');
    assert.match(staleManifestBody.login, /agent=explorer/);

    const noAuthMcpReq = makeRequest({
        method: 'POST',
        url: '/webAdmin/mcp',
    });
    const noAuthMcpRes = new MockResponse();
    const noAuthMcpParsedUrl = new URL(noAuthMcpReq.url, 'http://localhost');

    const noAuthMcpResult = await authHandlers.ensureAuthenticated(noAuthMcpReq, noAuthMcpRes, noAuthMcpParsedUrl);
    const noAuthMcpBody = JSON.parse(noAuthMcpRes.body || '{}');

    assert.equal(noAuthMcpResult.ok, false);
    assert.equal(noAuthMcpRes.statusCode, 401);
    assert.equal(noAuthMcpBody.error, 'not_authenticated');
    assert.match(noAuthMcpBody.login, /agent=explorer/);

    const webAdminChatReq = makeRequest({
        url: '/webchat?agent=webAdmin',
        accept: 'text/html',
    });
    const webAdminChatRes = new MockResponse();
    const webAdminChatParsedUrl = new URL(webAdminChatReq.url, 'http://localhost');

    const webAdminChatResult = await authHandlers.ensureAuthenticated(webAdminChatReq, webAdminChatRes, webAdminChatParsedUrl);

    assert.equal(webAdminChatResult.ok, false);
    assert.equal(webAdminChatRes.statusCode, 302);

    const location = new URL(String(webAdminChatRes.getHeader('location') || ''), 'http://localhost');
    assert.equal(location.pathname, '/auth/login');
    assert.equal(location.searchParams.get('agent'), 'explorer');
    assert.equal(location.searchParams.get('returnTo'), '/webchat?agent=webAdmin');
    assert.doesNotMatch(String(webAdminChatRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);

    const webAssistChatReq = makeRequest({
        url: '/webchat?agent=webAssist',
        accept: 'text/html',
    });
    const webAssistChatRes = new MockResponse();
    const webAssistChatParsedUrl = new URL(webAssistChatReq.url, 'http://localhost');

    const webAssistChatResult = await authHandlers.ensureAuthenticated(webAssistChatReq, webAssistChatRes, webAssistChatParsedUrl);

    assert.equal(webAssistChatResult.ok, true);
    assert.equal(webAssistChatReq.authMode, 'guest');
    assert.equal(webAssistChatReq.user?.username, 'visitor');
    assert.match(String(webAssistChatRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);
});

test('browser auth host binding rejects selector switches and ignores raw candidate edits', async (t) => {
    const { authHandlers, createRoutePlan } = await withAuthModules(t);
    t.mock.method(authHandlers.authService, 'beginLogin', async () => ({ redirectUrl: '/identity/login', state: 's'.repeat(22), browserBinding: 'test-proof', expiresAt: Date.now() + 60000 }));
    const routePlan = createRoutePlan({
        ok: true,
        kind: 'router-surface',
        surface: 'browser-auth',
        hostSelection: {
            kind: 'agent-root',
            host: 'explorer.localhost',
            record: { routeKey: 'explorer' },
        },
        forwarding: { protocol: 'http', authority: 'explorer.localhost:8080' },
    });

    const switchedReq = makeRequest({
        method: 'GET',
        url: '/auth/login?agent=webAssist',
        host: 'explorer.localhost:8080',
    });
    const switchedRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        switchedReq,
        switchedRes,
        new URL(switchedReq.url, 'http://explorer.localhost:8080'),
        { routePlan },
    );
    assert.equal(switchedRes.statusCode, 400);
    assert.equal(JSON.parse(switchedRes.body).error, 'auth_route_context_mismatch');

    const candidatePath = path.join(process.env.PLOINKY_WORKSPACE_ROOT, '.ploinky', 'agents.json');
    const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
    candidate.explorer.auth = { mode: 'none' };
    writeFileSync(candidatePath, JSON.stringify(candidate, null, 2));

    const fixedReq = makeRequest({
        method: 'GET',
        url: '/auth/login',
        host: 'explorer.localhost:8080',
        accept: 'text/html',
    });
    const fixedRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        fixedReq,
        fixedRes,
        new URL(fixedReq.url, 'http://explorer.localhost:8080'),
        { routePlan },
    );
    assert.equal(fixedRes.statusCode, 200);
    assert.match(fixedRes.body, /Single Sign-On/);
    assert.doesNotMatch(fixedRes.body, /name="agent"/);

    routePlan.lease.commit = () => false;
    const staleRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        fixedReq,
        staleRes,
        new URL(fixedReq.url, 'http://explorer.localhost:8080'),
        { routePlan },
    );
    assert.equal(staleRes.statusCode, 503);
    assert.equal(JSON.parse(staleRes.body).error, 'edge_generation_changed');
});

test('host-bound browser token mints only an admitted service mutation proof', async (t) => {
    const { authHandlers, authService, createRoutePlan } = await withAuthModules(t, {
        staticAuthMode: 'sso',
    });
    const originalGetSession = authService.getSession;
    authService.getSession = (sessionId) => sessionId === 'sso-session'
        ? {
            user: {
                id: 'sso:admin',
                username: 'admin',
                name: 'Admin',
                email: 'admin@example.test',
                roles: ['user', 'admin'],
            },
            tokens: null,
            expiresAt: Date.now() + 60_000,
        }
        : null;
    t.after(() => {
        authService.getSession = originalGetSession;
    });

    const base = createRoutePlan();
    const snapshot = {
        ...base.snapshot,
        compiled: {
            agentMcpRoutes: {
                'explorer.localhost': ['explorer', 'webAdmin'],
            },
        },
    };
    const routePlan = createRoutePlan({
        ok: true,
        kind: 'router-surface',
        surface: 'browser-auth',
        host: 'explorer.localhost',
        hostSelection: {
            kind: 'agent-root',
            source: 'public-host',
            host: 'explorer.localhost',
            record: { routeKey: 'explorer' },
        },
        forwarding: { protocol: 'https', authority: 'explorer.localhost' },
        snapshot,
        lease: {
            id: snapshot.generation,
            snapshot,
            commit: () => true,
        },
    });

    const allowedReq = makeRequest({
        method: 'GET',
        url: '/auth/token?mutationRoute=webAdmin',
        host: 'explorer.localhost',
        cookie: 'ploinky_sso=sso-session',
    });
    const allowedRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        allowedReq,
        allowedRes,
        new URL(allowedReq.url, 'https://explorer.localhost'),
        { routePlan },
    );
    const allowedBody = JSON.parse(allowedRes.body || '{}');
    assert.equal(allowedRes.statusCode, 200, allowedRes.body);
    assert.equal(allowedBody.browserMutation.hostRouteKey, 'explorer');
    assert.equal(allowedBody.browserMutation.routeKey, 'webAdmin');
    assert.equal(allowedBody.browserMutation.generation, snapshot.generation);

    const unrelatedReq = makeRequest({
        method: 'GET',
        url: '/auth/token?mutationRoute=guestAgent',
        host: 'explorer.localhost',
        cookie: 'ploinky_sso=sso-session',
    });
    const unrelatedRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        unrelatedReq,
        unrelatedRes,
        new URL(unrelatedReq.url, 'https://explorer.localhost'),
        { routePlan },
    );
    assert.equal(unrelatedRes.statusCode, 503);
    assert.equal(JSON.parse(unrelatedRes.body).error, 'browser_mutation_route_denied');

    const switchedReq = makeRequest({
        method: 'GET',
        url: '/auth/token?agent=webAdmin',
        host: 'explorer.localhost',
        cookie: 'ploinky_sso=sso-session',
    });
    const switchedRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        switchedReq,
        switchedRes,
        new URL(switchedReq.url, 'https://explorer.localhost'),
        { routePlan },
    );
    assert.equal(switchedRes.statusCode, 400);
    assert.equal(JSON.parse(switchedRes.body).error, 'auth_route_context_mismatch');
});

test('browser token GET denies a generation change during session resolution before issuing proofs or cookies', async (t) => {
    const { authHandlers, authService, createRoutePlan } = await withAuthModules(t, { staticAuthMode: 'sso' });
    let resolveSession;
    let sessionLookupStarted;
    const started = new Promise((resolve) => { sessionLookupStarted = resolve; });
    t.mock.method(authService, 'getSession', async () => {
        sessionLookupStarted();
        return new Promise((resolve) => { resolveSession = resolve; });
    });
    let current = true;
    const routePlan = createRoutePlan();
    routePlan.lease.commit = () => current;
    const req = makeRequest({ method: 'GET', url: '/auth/token', cookie: 'ploinky_sso=slow-session' });
    const res = new MockResponse();
    const handled = authHandlers.handleAuthRoutes(req, res, new URL(req.url, 'http://localhost'), { routePlan });
    await started;
    current = false;
    resolveSession({
        user: { id: 'member-1', username: '', email: 'member@example.test', roles: ['user'] },
        tokens: null, expiresAt: Date.now() + 60_000,
    });
    assert.equal(await handled, true);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, 'edge_generation_changed');
    assert.equal(res.getHeader('set-cookie'), undefined);
    assert.equal(Object.hasOwn(JSON.parse(res.body), 'browserMutation'), false);
    assert.equal(Object.hasOwn(JSON.parse(res.body), 'adminControl'), false);
});

test('SSO login and callback keep every return target inside the normalized same-origin boundary', async (t) => {
    const { authHandlers, authService, createRoutePlan } = await withAuthModules(t, {
        staticAuthMode: 'sso',
    });
    const originals = {
        isConfigured: authService.isConfigured,
        beginLogin: authService.beginLogin,
        handleCallback: authService.handleCallback,
        getSessionCookieMaxAge: authService.getSessionCookieMaxAge,
    };
    t.after(() => {
        Object.assign(authService, originals);
    });

    const observedReturnTargets = [];
    authService.isConfigured = () => true;
    authService.beginLogin = async ({ returnTo }) => {
        observedReturnTargets.push(returnTo);
        return {
            redirectUrl: 'https://identity.example.test/authorize',
            state: 'test-state-12345678901',
            browserBinding: 'test-browser-proof',
            expiresAt: Date.now() + 60_000,
        };
    };

    for (const requested of [
        'https://evil.example/explorer',
        '//evil.example/explorer',
        '/%252f%252fevil.example/explorer',
        '/safe%0dLocation:%20https://evil.example',
        '/safe#https://evil.example',
    ]) {
        const req = makeRequest({
            method: 'GET',
            url: `/auth/login?returnTo=${encodeURIComponent(requested)}`,
            accept: 'text/html',
        });
        const res = new MockResponse();
        await authHandlers.handleAuthRoutes(
            req,
            res,
            new URL(req.url, 'http://localhost'),
            { routePlan: createRoutePlan() },
        );
        assert.equal(res.statusCode, 200);
        assert.doesNotMatch(res.body, /evil\.example/);
    }
    assert.deepEqual(observedReturnTargets, Array(5).fill('/'));

    const validTarget = '/explorer/index.html?view=list#file-exp/Confidential/My%20Space';
    const validReq = makeRequest({
        method: 'GET',
        url: `/auth/login?returnTo=${encodeURIComponent(validTarget)}`,
        accept: 'text/html',
    });
    const validRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        validReq,
        validRes,
        new URL(validReq.url, 'http://localhost'),
        { routePlan: createRoutePlan() },
    );
    assert.equal(validRes.statusCode, 200);
    assert.equal(observedReturnTargets.at(-1), validTarget);

    authService.handleCallback = async () => ({
        sessionId: 'sso-test-session',
        user: {
            id: 'sso:test-user',
            username: 'test-user',
            roles: ['user'],
        },
        redirectTo: 'https://evil.example/callback-escape',
    });
    authService.getSessionCookieMaxAge = () => 60;

    const callbackPlan = createRoutePlan();
    callbackPlan.snapshot.routing.routes.explorer.hostPort = 0;
    const callbackReq = makeRequest({
        method: 'GET',
        url: '/auth/callback?code=test-code&state=test-state-12345678901',
        cookie: 'ploinky_sso_login_test-state-12345678901=test-browser-proof',
        accept: 'text/html',
    });
    const callbackRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        callbackReq,
        callbackRes,
        new URL(callbackReq.url, 'http://localhost'),
        { routePlan: callbackPlan },
    );
    assert.equal(callbackRes.statusCode, 302);
    assert.equal(callbackRes.getHeader('location'), '/');
});

test('route default keeps static-agent auth for routes with auth mode none', async (t) => {
    const { authHandlers } = await withAuthModules(t);
    const decision = authHandlers.resolveRouteDefaultHttpAccess('webAdmin');
    assert.deepEqual(decision, { access: 'authenticated', routeKey: 'webAdmin', source: 'routeDefault' });

    const req = makeRequest({
        method: 'GET',
        url: '/webAdmin/index.html',
    });
    const res = new MockResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const result = await authHandlers.ensureHttpRouteAccess(req, res, parsedUrl, decision);

    assert.equal(result.ok, false);
    assert.equal(res.statusCode, 401);
});

test('browser token for an auth-none target uses static auth and binds proof to the target', async (t) => {
    const { authHandlers, authService, createRoutePlan } = await withAuthModules(t, {
        staticAuthMode: 'sso',
    });
    const originalGetSession = authService.getSession;
    authService.getSession = (sessionId) => sessionId === 'sso-session'
        ? {
            user: {
                id: 'sso:admin',
                username: 'admin',
                name: 'Admin',
                email: 'admin@example.test',
                roles: ['user', 'admin'],
            },
            tokens: null,
            expiresAt: Date.now() + 60_000,
        }
        : null;
    t.after(() => {
        authService.getSession = originalGetSession;
    });

    const req = makeRequest({
        method: 'GET',
        url: '/auth/token?mutationRoute=webAdmin',
        cookie: 'ploinky_sso=sso-session',
    });
    const res = new MockResponse();

    const handled = await authHandlers.handleAuthRoutes(
        req,
        res,
        new URL(req.url, 'http://localhost'),
        { routePlan: createRoutePlan() },
    );
    const body = JSON.parse(res.body || '{}');

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.user.username, 'admin');
    assert.equal(body.browserMutation.routeKey, 'webAdmin');
    assert.equal(body.browserMutation.generation, 'guest-auth-test-generation');
    assert.match(String(res.getHeader('set-cookie') || ''), /^ploinky_browser_csrf=/);
});

test('static-auth webchat input preserves the target mutation route binding', async (t) => {
    const { authHandlers, authService, createRoutePlan } = await withAuthModules(t, {
        staticAuthMode: 'sso',
    });
    const originalGetSession = authService.getSession;
    const originalIsConfigured = authService.isConfigured;
    authService.isConfigured = () => true;
    authService.getSession = (sessionId) => sessionId === 'sso-session'
        ? {
            user: {
                id: 'sso:admin',
                username: 'admin',
                name: 'Admin',
                email: 'admin@example.test',
                roles: ['user', 'admin'],
            },
            tokens: null,
            expiresAt: Date.now() + 60_000,
        }
        : null;
    t.after(() => {
        authService.getSession = originalGetSession;
        authService.isConfigured = originalIsConfigured;
    });
    const req = makeRequest({
        method: 'POST',
        url: '/webchat/input?agent=webAdmin',
        cookie: 'ploinky_sso=sso-session',
    });
    const res = new MockResponse();
    const routePlan = createRoutePlan({
        decision: {
            access: 'authenticated',
            routeKey: 'explorer',
        },
    });
    routePlan.snapshot.manifests.webAdmin = {
        webchat: { auth: 'static' },
    };

    const result = await authHandlers.ensureAuthenticated(
        req,
        res,
        new URL(req.url, 'http://localhost'),
        { routePlan },
    );

    assert.equal(result.ok, true);
    assert.equal(req.edgeAuthContext.routeKey, 'explorer');
    assert.equal(req.edgeAuthContext.serviceRouteKey, 'webAdmin');
    assert.match(String(req.browserCsrfToken || ''), /^v2\./);
});

test('browser token for a guest target rejects retired local browser credentials', async (t) => {
    const { authHandlers, localService, createRoutePlan } = await withAuthModules(t);
    const token = signBrowserSessionFixture({
        id: 'local:admin',
        username: 'admin',
        name: 'Local Admin',
        email: 'admin@example.test',
        roles: ['user', 'admin'],
    });
    const req = makeRequest({
        method: 'GET',
        url: '/auth/token?mutationRoute=webAssist',
        cookie: `ploinky_jwt=${token}`,
    });
    const res = new MockResponse();

    const handled = await authHandlers.handleAuthRoutes(
        req,
        res,
        new URL(req.url, 'http://localhost'),
        { routePlan: createRoutePlan() },
    );
    const body = JSON.parse(res.body || '{}');

    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.equal(req.user, undefined);
    assert.equal(body.ok, false);
});

test('browser token accepts an exact manifest guest path without widening dependency access', async (t) => {
    const { authHandlers, localService, createRoutePlan } = await withAuthModules(t);
    const roomId = 'room_11111111-1111-4111-8111-111111111111';
    const guestToken = localService.mintGuestSessionJwt({
        guestScope: `webmeet:room:${roomId}`,
        routeKey: 'webAssist',
    });
    const base = createRoutePlan();
    const snapshot = {
        ...base.snapshot,
        compiled: {
            agentMcpRoutes: {
                'explorer.localhost': ['explorer', 'webAssist'],
            },
            dependencyHttpRoutes: {
                'explorer.localhost': [
                    { path: '/webAssist/roomLoader.html', routeKey: 'webAssist' },
                ],
            },
            policy: {
                entries: [
                    {
                        path: '/webAssist/roomLoader.html',
                        access: 'guest',
                        routeKey: 'webAssist',
                        source: 'manifest',
                        guestScope: 'webmeet:room',
                        guestScopeParam: 'roomId',
                    },
                    {
                        path: '/webAssist/private.html',
                        access: 'authenticated',
                        routeKey: 'webAssist',
                        source: 'manifest',
                    },
                ],
                routeDefaults: {
                    explorer: {
                        access: 'authenticated',
                        routeKey: 'explorer',
                        source: 'routeDefault',
                    },
                    webAssist: {
                        access: 'guest',
                        routeKey: 'webAssist',
                        source: 'routeDefault',
                    },
                },
                namespaces: [
                    {
                        id: 'route:webAssist',
                        kind: 'route',
                        routeKey: 'webAssist',
                        prefix: '/webAssist',
                        partitions: [
                            {
                                representative: '/webAssist/roomLoader.html',
                                winner: {
                                    access: 'guest',
                                    routeKey: 'webAssist',
                                    source: 'manifest',
                                    guestScope: 'webmeet:room',
                                    guestScopeParam: 'roomId',
                                },
                            },
                        ],
                    },
                ],
            },
        },
    };
    const routePlan = createRoutePlan({
        ok: true,
        kind: 'router-surface',
        surface: 'browser-auth',
        host: 'explorer.localhost',
        hostSelection: {
            kind: 'agent-root',
            source: 'public-host',
            host: 'explorer.localhost',
            record: { routeKey: 'explorer' },
        },
        forwarding: { protocol: 'https', authority: 'explorer.localhost' },
        snapshot,
        lease: {
            id: snapshot.generation,
            snapshot,
            commit: () => true,
        },
    });

    const allowedReq = makeRequest({
        method: 'GET',
        url: `/auth/token?mutationRoute=webAssist&mutationPath=%2FwebAssist%2FroomLoader.html&roomId=${roomId}`,
        host: 'explorer.localhost',
        cookie: `ploinky_guest=${guestToken}`,
    });
    const allowedRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        allowedReq,
        allowedRes,
        new URL(allowedReq.url, 'https://explorer.localhost'),
        { routePlan },
    );
    const allowedBody = JSON.parse(allowedRes.body || '{}');
    assert.equal(allowedRes.statusCode, 200, allowedRes.body);
    assert.equal(allowedReq.authMode, 'guest');
    assert.equal(allowedBody.user.username, 'visitor');
    assert.equal(allowedBody.browserMutation.hostRouteKey, 'explorer');
    assert.equal(allowedBody.browserMutation.routeKey, 'webAssist');
    assert.equal(allowedBody.browserMutation.generation, snapshot.generation);

    for (const suffix of [
        '',
        '&roomId=room_22222222-2222-4222-8222-222222222222',
    ]) {
        const deniedScopeReq = makeRequest({
            method: 'GET',
            url: `/auth/token?mutationRoute=webAssist&mutationPath=%2FwebAssist%2FroomLoader.html${suffix}`,
            host: 'explorer.localhost',
            cookie: `ploinky_guest=${guestToken}`,
        });
        const deniedScopeRes = new MockResponse();
        await authHandlers.handleAuthRoutes(
            deniedScopeReq,
            deniedScopeRes,
            new URL(deniedScopeReq.url, 'https://explorer.localhost'),
            { routePlan },
        );
        assert.equal(deniedScopeRes.statusCode, 401, deniedScopeRes.body);
    }

    const mcpRoutePlan = {
        ...routePlan,
        decision: {
            access: 'guest',
            routeKey: 'webAssist',
            source: 'routeDefault',
        },
    };
    const mcpReq = makeRequest({
        method: 'POST',
        url: '/webAssist/mcp',
        host: 'explorer.localhost',
        cookie: `ploinky_guest=${guestToken}`,
    });
    const mcpRes = new MockResponse();
    const mcpResult = await authHandlers.ensureAuthenticated(
        mcpReq,
        mcpRes,
        new URL(mcpReq.url, 'https://explorer.localhost'),
        { routePlan: mcpRoutePlan },
    );
    assert.equal(mcpResult.ok, true);
    assert.equal(mcpReq.sessionId, guestToken);
    assert.equal(mcpReq.session?._jwtPayload?.gscope, `webmeet:room:${roomId}`);
    assert.equal(mcpReq.session?._jwtPayload?.groute, 'webAssist');

    for (const mutationPath of [
        '/webAssist/private.html',
        '/webAssist/undeclared.html',
        '/guestAgent/meeting-room/example',
    ]) {
        const deniedReq = makeRequest({
            method: 'GET',
            url: `/auth/token?mutationRoute=webAssist&mutationPath=${encodeURIComponent(mutationPath)}`,
            host: 'explorer.localhost',
            cookie: `ploinky_guest=${guestToken}`,
        });
        const deniedRes = new MockResponse();
        await authHandlers.handleAuthRoutes(
            deniedReq,
            deniedRes,
            new URL(deniedReq.url, 'https://explorer.localhost'),
            { routePlan },
        );
        assert.equal(deniedRes.statusCode, 503, `${mutationPath}: ${deniedRes.body}`);
        assert.equal(
            JSON.parse(deniedRes.body).error,
            'browser_mutation_guest_route_denied',
            mutationPath,
        );
    }

    const outsideClosure = {
        ...routePlan,
        snapshot: {
            ...snapshot,
            compiled: {
                ...snapshot.compiled,
                dependencyHttpRoutes: {
                    'explorer.localhost': [],
                },
            },
        },
    };
    outsideClosure.lease = {
        id: outsideClosure.snapshot.generation,
        snapshot: outsideClosure.snapshot,
        commit: () => true,
    };
    const outsideReq = makeRequest({
        method: 'GET',
        url: '/auth/token?mutationRoute=webAssist&mutationPath=%2FwebAssist%2FroomLoader.html',
        host: 'explorer.localhost',
        cookie: `ploinky_guest=${guestToken}`,
    });
    const outsideRes = new MockResponse();
    await authHandlers.handleAuthRoutes(
        outsideReq,
        outsideRes,
        new URL(outsideReq.url, 'https://explorer.localhost'),
        { routePlan: outsideClosure },
    );
    assert.equal(outsideRes.statusCode, 503, outsideRes.body);
    assert.equal(JSON.parse(outsideRes.body).error, 'browser_mutation_guest_route_denied');
});

test('route default falls back to guest when no user-authenticated static agent exists', async (t) => {
    const { authHandlers } = await withAuthModules(t, { staticAuthMode: 'none' });
    const decision = authHandlers.resolveRouteDefaultHttpAccess('webAdmin');
    assert.deepEqual(decision, { access: 'guest', routeKey: 'webAdmin', source: 'routeDefault' });
});

test('auth mode none admits the signed CLI operator for router policy', async (t) => {
    const { authHandlers, localService } = await withAuthModules(t, { staticAuthMode: 'none' });
    const token = localService.mintSessionJwt({
        id: 'local:admin',
        username: 'admin',
        name: 'Local CLI',
        email: '',
        roles: ['user', 'admin'],
    }, 1, { channel: 'cli' });
    const req = makeRequest({
        method: 'POST',
        url: '/mcp',
        cookie: `ploinky_jwt=${token}`,
    });
    const res = new MockResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const result = await authHandlers.ensureAuthenticated(req, res, parsedUrl);

    assert.equal(result.ok, true);
    assert.equal(req.authMode, 'local');
    assert.equal(req.user?.username, 'admin');
    assert.deepEqual(req.user?.roles, ['user', 'admin']);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '');
});

test('local CLI channel crosses configured surface auth without weakening browser sessions', async (t) => {
    const { authHandlers, localService, createRoutePlan } = await withAuthModules(t);
    const user = {
        id: 'local:admin',
        username: 'admin',
        name: 'Local CLI',
        email: '',
        roles: ['user', 'admin'],
    };
    const cliToken = localService.mintSessionJwt(user, 1, { channel: 'cli' });
    const cliReq = makeRequest({
        method: 'POST',
        url: '/mcp',
        cookie: `ploinky_jwt=${cliToken}`,
    });
    const cliRes = new MockResponse();
    const snapshot = createRoutePlan().snapshot;
    snapshot.manifests.explorer = {
        routerAccess: { requiredCapability: 'explorer.access' },
    };
    const cliResult = await authHandlers.ensureAuthenticated(
        cliReq,
        cliRes,
        new URL(cliReq.url, 'http://localhost'),
        { snapshot },
    );

    assert.equal(cliResult.ok, true);
    assert.equal(cliReq.authMode, 'local');
    assert.equal(cliReq.authChannel, 'cli');
    assert.equal(cliReq.user?.id, 'local:admin');

    const browserToken = signBrowserSessionFixture(user);
    const browserReq = makeRequest({
        method: 'POST',
        url: '/mcp',
        cookie: `ploinky_jwt=${browserToken}`,
    });
    const browserRes = new MockResponse();
    const browserResult = await authHandlers.ensureAuthenticated(
        browserReq,
        browserRes,
        new URL(browserReq.url, 'http://localhost'),
    );

    assert.equal(browserResult.ok, false);
    assert.equal(browserReq.authChannel, undefined);
    assert.equal(browserRes.statusCode, 401);
});

test('ensureHttpRouteAccess denies none, deny, missing, and unknown decisions', async (t) => {
    const { authHandlers } = await withAuthModules(t);
    for (const decision of [
        null,
        { access: 'none', routeKey: 'webAdmin', source: 'routeDefault' },
        { access: 'deny', status: 404, code: 'UNROUTABLE_PATH', routeKey: '', source: 'policy' },
        { access: 'banana', routeKey: 'webAdmin', source: 'policy' },
    ]) {
        const req = makeRequest({ method: 'GET', url: '/webAdmin/x' });
        const res = new MockResponse();
        const result = await authHandlers.ensureHttpRouteAccess(req, res, new URL(req.url, 'http://localhost'), decision);
        assert.equal(result.ok, false, JSON.stringify(decision));
        assert.equal(res.statusCode >= 400, true, JSON.stringify(decision));
        assert.doesNotMatch(String(res.getHeader('set-cookie') || ''), /^ploinky_guest=/);
    }
});

test('parameterized guest routes mint an exact scope and reject unbound guest entry', async (t) => {
    const { authHandlers, localService } = await withAuthModules(t);
    const roomId = 'room_11111111-1111-4111-8111-111111111111';
    const decision = {
        access: 'guest',
        routeKey: 'webAssist',
        source: 'manifest',
        guestScope: 'webmeet:room',
        guestScopeParam: 'roomId',
    };
    const req = makeRequest({
        method: 'GET',
        url: `/webAssist/roomLoader.html?roomId=${roomId}`,
    });
    const res = new MockResponse();
    const result = await authHandlers.ensureHttpRouteAccess(
        req,
        res,
        new URL(req.url, 'http://localhost'),
        decision,
    );

    assert.equal(result.ok, true);
    assert.equal(req.authMode, 'guest');
    assert.equal(req.session?._jwtPayload?.gscope, `webmeet:room:${roomId}`);
    assert.equal(req.session?._jwtPayload?.groute, 'webAssist');

    for (const url of [
        '/webAssist/roomLoader.html',
        `/webAssist/roomLoader.html?roomId=${roomId}&roomId=other`,
        '/webAssist/roomLoader.html?roomId=%2Fnot-a-capability',
    ]) {
        const deniedReq = makeRequest({ method: 'GET', url });
        const deniedRes = new MockResponse();
        const denied = await authHandlers.ensureHttpRouteAccess(
            deniedReq,
            deniedRes,
            new URL(url, 'http://localhost'),
            decision,
        );
        assert.equal(denied.ok, false, url);
        assert.equal(deniedRes.statusCode, 403, url);
        assert.equal(JSON.parse(deniedRes.body).error, 'guest_scope_parameter_invalid', url);
        assert.doesNotMatch(String(deniedRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);
    }

    const admin = {
        id: 'local:admin',
        username: 'admin',
        roles: ['user', 'admin'],
    };
    const adminToken = localService.mintSessionJwt(admin, 1, { channel: 'cli' });
    const adminReq = makeRequest({
        method: 'GET',
        url: '/webAssist/roomLoader.html',
        cookie: `ploinky_jwt=${adminToken}`,
    });
    const adminRes = new MockResponse();
    const adminResult = await authHandlers.ensureHttpRouteAccess(
        adminReq,
        adminRes,
        new URL(adminReq.url, 'http://localhost'),
        decision,
    );
    assert.equal(adminResult.ok, true);
    assert.equal(adminReq.authMode, 'local');
    assert.doesNotMatch(String(adminRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);
});

test('a guest-session JWT in the ploinky_jwt cookie never satisfies an authenticated route', async (t) => {
    const { authHandlers, localService } = await withAuthModules(t);
    const guestJwt = localService.mintGuestSessionJwt({});
    const req = makeRequest({
        method: 'GET',
        url: '/explorer/settings',
        cookie: `ploinky_jwt=${guestJwt}`,
    });
    const res = new MockResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const result = await authHandlers.ensureHttpRouteAccess(
        req,
        res,
        parsedUrl,
        { access: 'authenticated', routeKey: 'explorer', source: 'policy' },
    );

    assert.equal(result.ok, false);
    assert.equal(res.statusCode, 401);
});

test('an SSO user session takes precedence over guest minting on guest routes', async (t) => {
    const { authHandlers, authService } = await withAuthModules(t);
    const originalIsConfigured = authService.isConfigured;
    const originalGetSession = authService.getSession;
    const originalValidateSession = authService.validateSession;
    authService.isConfigured = () => true;
    const sessionFor = (id) => id === 'sso-cookie-1'
        ? { user: { id: 'sso:alice', username: 'alice', roles: ['user'] }, expiresAt: Date.now() + 60_000 }
        : null;
    authService.getSession = sessionFor;
    authService.validateSession = async (id) => sessionFor(id);
    t.after(() => {
        authService.isConfigured = originalIsConfigured;
        authService.getSession = originalGetSession;
        authService.validateSession = originalValidateSession;
    });

    const req = makeRequest({ method: 'GET', url: '/webAssist/page', cookie: 'ploinky_sso=sso-cookie-1' });
    const res = new MockResponse();
    const result = await authHandlers.ensureHttpRouteAccess(
        req,
        res,
        new URL(req.url, 'http://localhost'),
        { access: 'guest', routeKey: 'webAssist', source: 'policy' },
    );
    assert.equal(result.ok, true);
    assert.equal(req.authMode, 'sso');
    assert.equal(req.user.username, 'alice');
    assert.doesNotMatch(String(res.getHeader('set-cookie') || ''), /^ploinky_guest=/);
});

test('an authenticated route enforces its manifest capability against the live SSO identity', async (t) => {
    const { authHandlers, authService, createRoutePlan } = await withAuthModules(t, { staticAuthMode: 'sso' });
    const originalIsConfigured = authService.isConfigured;
    const originalValidateSession = authService.validateSession;
    authService.isConfigured = () => true;
    let capabilities = [];
    authService.validateSession = async (sessionId) => sessionId === 'sso-capability-session'
        ? {
            user: { id: 'sso:member', username: 'member', roles: ['user'], capabilities },
            expiresAt: Date.now() + 60_000,
        }
        : null;
    t.after(() => {
        authService.isConfigured = originalIsConfigured;
        authService.validateSession = originalValidateSession;
    });

    const routePlan = createRoutePlan();
    routePlan.snapshot.manifests.explorer = {
        routerAccess: { requiredCapability: 'explorer.access' },
    };
    const decision = { access: 'authenticated', routeKey: 'explorer', source: 'policy' };

    const deniedReq = makeRequest({
        method: 'GET',
        url: '/explorer/index.html',
        cookie: 'ploinky_sso=sso-capability-session',
    });
    const deniedRes = new MockResponse();
    const denied = await authHandlers.ensureHttpRouteAccess(
        deniedReq,
        deniedRes,
        new URL(deniedReq.url, 'http://localhost'),
        decision,
        { routePlan },
    );
    assert.equal(denied.ok, false);
    assert.equal(deniedRes.statusCode, 403);
    assert.equal(JSON.parse(deniedRes.body).error, 'required_capability_missing');

    capabilities = ['explorer.access'];
    const allowedReq = makeRequest({
        method: 'GET',
        url: '/explorer/index.html',
        cookie: 'ploinky_sso=sso-capability-session',
    });
    const allowedRes = new MockResponse();
    const allowed = await authHandlers.ensureHttpRouteAccess(
        allowedReq,
        allowedRes,
        new URL(allowedReq.url, 'http://localhost'),
        decision,
        { routePlan },
    );
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowedReq.user.capabilities, ['explorer.access']);
});

test('authenticated route key with guest auth falls back to static route auth instead of minting guest', async (t) => {
    const { authHandlers } = await withAuthModules(t);
    const req = makeRequest({
        url: '/webAssist/private/profile',
    });
    const res = new MockResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const result = await authHandlers.ensureHttpRouteAccess(
        req,
        res,
        parsedUrl,
        { access: 'authenticated', routeKey: 'webAssist', source: 'policy' },
    );
    const body = JSON.parse(res.body || '{}');

    assert.equal(result.ok, false);
    assert.equal(res.statusCode, 401);
    assert.equal(body.error, 'not_authenticated');
    assert.match(String(body.login || ''), /agent=explorer/);
    assert.doesNotMatch(String(res.getHeader('set-cookie') || ''), /^ploinky_guest=/);
});

test('authenticated route key without configured auth uses route-specific detail', async (t) => {
    const { authHandlers } = await withAuthModules(t, { staticAuthMode: 'none' });
    const req = makeRequest({
        url: '/guestAgent/account/profile',
    });
    const res = new MockResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const result = await authHandlers.ensureHttpRouteAccess(
        req,
        res,
        parsedUrl,
        { access: 'authenticated', routeKey: 'guestAgent', source: 'policy' },
    );
    const body = JSON.parse(res.body || '{}');

    assert.equal(result.ok, false);
    assert.equal(res.statusCode, 503);
    assert.equal(body.error, 'authenticated_http_route_auth_not_configured');
    assert.equal(body.detail, 'Authenticated HTTP routes require a user-authenticated route or static-agent auth policy.');
});

test('authenticated guest route key without static user auth fails closed', async (t) => {
    const { authHandlers } = await withAuthModules(t, { staticAuthMode: 'none' });
    const req = makeRequest({
        url: '/webAssist/private/profile',
    });
    const res = new MockResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const result = await authHandlers.ensureHttpRouteAccess(
        req,
        res,
        parsedUrl,
        { access: 'authenticated', routeKey: 'webAssist', source: 'policy' },
    );
    const body = JSON.parse(res.body || '{}');

    assert.equal(result.ok, false);
    assert.equal(res.statusCode, 503);
    assert.equal(body.error, 'authenticated_http_route_auth_not_configured');
    assert.equal(body.detail, 'Authenticated HTTP routes require a user-authenticated route or static-agent auth policy.');
    assert.doesNotMatch(String(res.getHeader('set-cookie') || ''), /^ploinky_guest=/);
});

test('startup dispatch preserves the real access and host matrix before lifecycle observation', async (t) => {
    const { authHandlers, authService, localService, createRoutePlan } = await withAuthModules(t);
    const generation = `sha256:${'b'.repeat(64)}`;
    const roomId = 'room_33333333-3333-4333-8333-333333333333';
    const user = {
        id: 'local:admin',
        username: 'admin',
        name: 'Local Admin',
        email: 'admin@example.test',
        roles: ['user', 'admin'],
    };
    const guestToken = localService.mintGuestSessionJwt({
        guestScope: `webmeet:room:${roomId}`,
        routeKey: 'webAssist',
    });
    const liveSsoSessions = new Set(['sso-valid', 'sso-expiring']);
    const originalIsConfigured = authService.isConfigured;
    const originalGetSession = authService.getSession;
    const originalRefreshSession = authService.refreshSession;
    authService.isConfigured = () => true;
    authService.getSession = (sessionId) => liveSsoSessions.has(sessionId)
        ? { user, expiresAt: Date.now() + 60_000 }
        : null;
    authService.refreshSession = async () => null;
    t.after(() => {
        authService.isConfigured = originalIsConfigured;
        authService.getSession = originalGetSession;
        authService.refreshSession = originalRefreshSession;
    });

    function makeStartupPlan({
        routeKey,
        decision,
        hostKind,
        kind = 'agent-root-pending',
        commit = () => true,
    }) {
        const dedicated = hostKind === 'dedicated';
        const route = createRoutePlan().snapshot.routing.routes[routeKey];
        const routePlan = createRoutePlan({
            ok: true,
            kind,
            routeKey,
            route,
            target: kind === 'agent-root' ? { host: '127.0.0.1', port: route.hostPort } : null,
            pathname: dedicated ? '/index.html' : `/${routeKey}/index.html`,
            canonicalPath: `/${routeKey}/index.html`,
            upstreamPath: '/index.html',
            host: dedicated ? `${routeKey}.localhost` : 'localhost',
            hostSelection: dedicated
                ? {
                    kind: 'agent-root',
                    source: 'public-host',
                    host: `${routeKey}.localhost`,
                    record: { routeKey },
                }
                : { kind: 'control', host: 'localhost' },
            decision,
            transport: 'http',
        });
        routePlan.snapshot.generation = generation;
        routePlan.snapshot.agents.explorer = {
            ...routePlan.snapshot.agents.explorer,
            auth: { mode: 'sso' },
        };
        routePlan.lease = {
            id: generation,
            snapshot: routePlan.snapshot,
            commit,
        };
        return routePlan;
    }

    async function dispatch({
        hostKind,
        routeKey = 'explorer',
        decision = { access: 'public', routeKey, source: 'policy' },
        query = '',
        cookie = '',
        requestKind = 'navigation',
        kind = 'agent-root-pending',
        result = { state: 'starting' },
        commitResults = [],
    }) {
        let commitIndex = 0;
        let lifecycleReads = 0;
        const routePlan = makeStartupPlan({
            routeKey,
            decision,
            hostKind,
            kind,
            commit: () => commitResults[commitIndex++] ?? true,
        });
        const dedicated = hostKind === 'dedicated';
        const pathname = dedicated ? '/index.html' : `/${routeKey}/index.html`;
        const host = dedicated ? `${routeKey}.localhost` : 'localhost';
        const req = makeRequest({
            method: 'GET',
            url: `${pathname}${query}`,
            cookie,
            accept: requestKind === 'probe' ? 'application/json' : 'text/html',
            host,
            headers: requestKind === 'probe'
                ? {
                    'x-ploinky-agent-startup-probe': '1',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                }
                : {
                    'sec-fetch-dest': 'document',
                    'sec-fetch-mode': 'navigate',
                },
        });
        const parsedUrl = new URL(req.url, dedicated ? `https://${host}` : 'http://localhost');
        routePlan.parsedUrl = parsedUrl;
        const res = new MockResponse();
        const handled = await dispatchAgentStartupRequest({
            req,
            res,
            parsedUrl,
            routePlan,
            ensureRouteAccess: authHandlers.ensureHttpRouteAccess,
            inspectPublication: () => ({ ok: true, canPublishHttp: true }),
            resolveStartupState: async () => {
                lifecycleReads += 1;
                return result;
            },
        });
        return { handled, req, res, lifecycleReads, commitCount: commitIndex };
    }

    function publicResponse(res) {
        return {
            statusCode: res.statusCode,
            body: res.body,
            contentType: res.getHeader('content-type'),
            location: res.getHeader('location'),
            cacheControl: res.getHeader('cache-control'),
        };
    }

    const hiddenStates = [
        { state: 'starting' },
        { state: 'failed', code: 'startup_failed' },
        { state: 'failed', code: 'startup_timed_out' },
        { state: 'unavailable', code: 'route_unavailable' },
        { state: 'generation_changed' },
        { state: 'unverified' },
    ];

    for (const hostKind of ['control', 'dedicated']) {
        const publicStarting = await dispatch({ hostKind });
        assert.equal(publicStarting.handled, true);
        assert.equal(publicStarting.lifecycleReads, 1);
        assert.equal(publicStarting.res.statusCode, 503);
        assert.match(publicStarting.res.body, /data-ploinky-agent-startup-page="starting"/);
        assert.match(String(publicStarting.res.getHeader('cache-control') || ''), /(?:^|,\s*)no-store(?:,|$)/);

        const publicFailed = await dispatch({
            hostKind,
            result: { state: 'failed', code: 'startup_failed' },
        });
        assert.equal(publicFailed.lifecycleReads, 1);
        assert.equal(publicFailed.res.statusCode, 503);
        assert.match(publicFailed.res.body, /Agent startup failed/);
        assert.doesNotMatch(publicFailed.res.body, /container|instanceId|enableGeneration|hostPort/i);

        const unavailable = await dispatch({
            hostKind,
            requestKind: 'probe',
            result: { state: 'unavailable', code: 'route_unavailable' },
        });
        assert.equal(unavailable.lifecycleReads, 1);
        assert.equal(unavailable.res.statusCode, 503);
        assert.deepEqual(JSON.parse(unavailable.res.body), {
            state: 'unavailable',
            code: 'route_unavailable',
            message: 'This agent does not provide a web page.',
        });

        const guestDecision = {
            access: 'guest',
            routeKey: 'webAssist',
            source: 'manifest',
            guestScope: 'webmeet:room',
            guestScopeParam: 'roomId',
        };
        const guestAllowed = await dispatch({
            hostKind,
            routeKey: 'webAssist',
            decision: guestDecision,
            query: `?roomId=${roomId}`,
            cookie: `ploinky_guest=${guestToken}`,
        });
        assert.equal(guestAllowed.req.authMode, 'guest');
        assert.equal(guestAllowed.req.session?._jwtPayload?.gscope, `webmeet:room:${roomId}`);
        assert.equal(guestAllowed.lifecycleReads, 1);
        assert.equal(guestAllowed.res.statusCode, 503);

        for (const query of ['', '?roomId=%2Fnot-a-capability']) {
            let baseline = null;
            for (const result of hiddenStates) {
                const denied = await dispatch({
                    hostKind,
                    routeKey: 'webAssist',
                    decision: guestDecision,
                    query,
                    cookie: `ploinky_guest=${guestToken}`,
                    result,
                });
                assert.equal(denied.lifecycleReads, 0);
                assert.equal(denied.res.statusCode, 403);
                assert.equal(JSON.parse(denied.res.body).error, 'guest_scope_parameter_invalid');
                const response = publicResponse(denied.res);
                baseline ??= response;
                assert.deepEqual(response, baseline);
            }
        }

        const authenticatedDecision = {
            access: 'authenticated',
            routeKey: 'explorer',
            source: 'policy',
        };
        const authenticated = await dispatch({
            hostKind,
            decision: authenticatedDecision,
            cookie: 'ploinky_sso=sso-valid',
        });
        assert.equal(authenticated.req.authMode, 'sso');
        assert.equal(authenticated.lifecycleReads, 1);
        assert.equal(authenticated.res.statusCode, 503);

        let unauthenticatedBaseline = null;
        for (const result of hiddenStates) {
            const unauthenticated = await dispatch({
                hostKind,
                decision: authenticatedDecision,
                result,
            });
            assert.equal(unauthenticated.lifecycleReads, 0);
            assert.equal(unauthenticated.res.statusCode, 302);
            assert.match(String(unauthenticated.res.getHeader('location') || ''), /^\/auth\/login\?/);
            const response = publicResponse(unauthenticated.res);
            unauthenticatedBaseline ??= response;
            assert.deepEqual(response, unauthenticatedBaseline);
        }

        let deniedBaseline = null;
        for (const result of hiddenStates) {
            const denied = await dispatch({
                hostKind,
                decision: {
                    access: 'deny',
                    status: 404,
                    code: 'UNROUTABLE_PATH',
                    routeKey: 'explorer',
                    source: 'policy',
                },
                result,
            });
            assert.equal(denied.lifecycleReads, 0);
            assert.equal(denied.res.statusCode, 404);
            assert.deepEqual(JSON.parse(denied.res.body), { ok: false, error: 'UNROUTABLE_PATH' });
            const response = publicResponse(denied.res);
            deniedBaseline ??= response;
            assert.deepEqual(response, deniedBaseline);
        }

        const activeProbe = await dispatch({
            hostKind,
            kind: 'agent-root',
            requestKind: 'probe',
        });
        assert.equal(activeProbe.lifecycleReads, 0);
        assert.equal(activeProbe.res.statusCode, 200);
        assert.deepEqual(JSON.parse(activeProbe.res.body), {
            state: 'ready',
            generation,
        });

        const rotatedDuringLogin = await dispatch({
            hostKind,
            decision: authenticatedDecision,
            cookie: 'ploinky_sso=sso-valid',
            commitResults: [true, false],
        });
        assert.equal(rotatedDuringLogin.lifecycleReads, 0);
        assert.equal(rotatedDuringLogin.res.statusCode, 503);
        assert.deepEqual(JSON.parse(rotatedDuringLogin.res.body), {
            error: 'edge_generation_changed',
        });

        liveSsoSessions.add('sso-expiring');
        const beforeExpiry = await dispatch({
            hostKind,
            decision: authenticatedDecision,
            cookie: 'ploinky_sso=sso-expiring',
        });
        assert.equal(beforeExpiry.lifecycleReads, 1);
        assert.equal(beforeExpiry.res.statusCode, 503);

        liveSsoSessions.delete('sso-expiring');
        const afterExpiry = await dispatch({
            hostKind,
            decision: authenticatedDecision,
            cookie: 'ploinky_sso=sso-expiring',
            requestKind: 'probe',
        });
        assert.equal(afterExpiry.lifecycleReads, 0);
        assert.equal(afterExpiry.res.statusCode, 401);
        assert.equal(JSON.parse(afterExpiry.res.body).error, 'not_authenticated');
    }
});


test('SSO callback maps provider client rejection without exposing provider detail or issuing a session', async (t) => {
    const { authHandlers, authService, createRoutePlan } = await withAuthModules(t, { staticAuthMode: 'sso' });
    const originals = { isConfigured: authService.isConfigured, handleCallback: authService.handleCallback };
    t.after(() => Object.assign(authService, originals));
    authService.isConfigured = () => true;
    for (const [providerStatus, expectedStatus] of [[400, 400], [401, 400], ['400', 500], [403, 400], [500, 500], [503, 500], [undefined, 500]]) {
        await t.test(`provider status ${String(providerStatus)}`, async () => {
            authService.handleCallback = async () => {
                throw Object.assign(new Error('private provider rejection detail'), { statusCode: providerStatus, code: 'provider_specific_rejection' });
            };
            const req = makeRequest({
                url: '/auth/callback?code=test-code&state=test-state-12345678901',
                cookie: 'ploinky_sso_login_test-state-12345678901=test-browser-proof',
                accept: 'text/html',
            });
            const res = new MockResponse();
            await authHandlers.handleAuthRoutes(req, res, new URL(req.url, 'http://localhost'), { routePlan: createRoutePlan() });
            assert.equal(res.statusCode, expectedStatus);
            const body = JSON.parse(res.body);
            assert.equal(body.ok, false);
            assert.equal(body.error, expectedStatus === 400 ? 'invalid_authorization_code' : 'auth_failure');
            if (expectedStatus === 400) assert.deepEqual(body, { ok: false, error: 'invalid_authorization_code' });
            assert.equal(res.getHeader('set-cookie'), undefined, 'a rejected exchange must not issue cookies');
        });
    }
});
