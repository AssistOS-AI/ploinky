import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function makeRequest({ method = 'GET', url, body, cookie = '', accept = 'application/json', host = 'localhost' }) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = Readable.from(chunks);
    req.method = method;
    req.url = url;
    req.headers = {
        accept,
        host,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    req.socket = { encrypted: false };
    return req;
}

function writeWorkspaceConfig(ploinkyDir, { staticAuthMode = 'local' } = {}) {
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
            auth: staticAuthMode === 'local'
                ? { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' }
                : { mode: staticAuthMode },
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
    assert.match(fixedRes.body, /data-auth-login-form/);
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
        url: '/auth/callback?code=test-code&state=test-state',
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
        url: '/auth/token?agent=webAdmin',
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

test('browser token for a guest target preserves an authenticated local session', async (t) => {
    const { authHandlers, localService, createRoutePlan } = await withAuthModules(t);
    const token = localService.mintSessionJwt({
        id: 'local:admin',
        username: 'admin',
        name: 'Local Admin',
        email: 'admin@example.test',
        roles: ['user', 'admin'],
    }, 1);
    const req = makeRequest({
        method: 'GET',
        url: '/auth/token?agent=webAssist',
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
    assert.equal(res.statusCode, 200);
    assert.equal(req.authMode, 'local');
    assert.equal(body.ok, true);
    assert.equal(body.user.username, 'admin');
    assert.deepEqual(body.user.roles, ['user', 'admin']);
    assert.equal(body.browserMutation.routeKey, 'webAssist');
    assert.equal(body.browserMutation.generation, 'guest-auth-test-generation');
    assert.match(String(res.getHeader('set-cookie') || ''), /^ploinky_browser_csrf=/);
});

test('route default falls back to guest when no user-authenticated static agent exists', async (t) => {
    const { authHandlers } = await withAuthModules(t, { staticAuthMode: 'none' });
    const decision = authHandlers.resolveRouteDefaultHttpAccess('webAdmin');
    assert.deepEqual(decision, { access: 'guest', routeKey: 'webAdmin', source: 'routeDefault' });
});

test('auth mode none preserves valid local sessions for router policy', async (t) => {
    const { authHandlers, localService } = await withAuthModules(t, { staticAuthMode: 'none' });
    const token = localService.mintSessionJwt({
        id: 'local:admin',
        username: 'admin',
        name: 'Local CLI',
        email: '',
        roles: ['user', 'admin'],
    }, 1);
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
    const { authHandlers, localService } = await withAuthModules(t);
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
    const cliResult = await authHandlers.ensureAuthenticated(
        cliReq,
        cliRes,
        new URL(cliReq.url, 'http://localhost'),
    );

    assert.equal(cliResult.ok, true);
    assert.equal(cliReq.authMode, 'local');
    assert.equal(cliReq.authChannel, 'cli');
    assert.equal(cliReq.user?.id, 'local:admin');

    const browserToken = localService.mintSessionJwt(user, 1);
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
    authService.isConfigured = () => true;
    authService.getSession = (id) => id === 'sso-cookie-1'
        ? { user: { id: 'sso:alice', username: 'alice', roles: ['user'] }, expiresAt: Date.now() + 60_000 }
        : null;
    t.after(() => {
        authService.isConfigured = originalIsConfigured;
        authService.getSession = originalGetSession;
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
