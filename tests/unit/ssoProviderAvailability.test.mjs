import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { ANY_GUEST_SET_COOKIE } from '../helpers/guestCookies.mjs';

// Real SSO bridge, real admission and route code, fixture provider agent.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-availability-'));
const ploinkyDir = path.join(workspace, '.ploinky');
const providerDir = path.join(ploinkyDir, 'repos', 'fixture', 'identity');
fs.mkdirSync(path.join(providerDir, 'runtime'), { recursive: true });
fs.mkdirSync(path.join(ploinkyDir, 'data'), { recursive: true });
fs.writeFileSync(path.join(ploinkyDir, 'data', '.secrets'), '# test secrets\n');
fs.writeFileSync(path.join(providerDir, 'manifest.json'), JSON.stringify({ ssoProvider: true }));
fs.writeFileSync(path.join(providerDir, 'runtime', 'index.mjs'), `
export function resolveProviderConfig() { return { fixture: true }; }
export function createProvider() {
    return {
        async sso_begin_login() {
            return { authorizationUrl: 'https://identity.test/login?state=fixture', providerState: 'fixture' };
        },
        async sso_handle_callback() {
            return {
                user: { id: 'sso:admin', username: 'admin', roles: ['user', 'admin'] },
                providerSession: { userId: 'sso:admin', expiresAt: Date.now() + 60_000 },
            };
        },
        async sso_refresh_session({ providerSession, signal }) {
            return globalThis.__ssoAvailabilityFixture(providerSession, { signal });
        },
        async sso_logout() { return { redirectUrl: '/' }; },
    };
}
`);
const agents = {
    explorer: { type: 'agent', agentName: 'explorer', repoName: 'AchillesIDE', auth: { mode: 'sso' } },
    webAssist: { type: 'agent', agentName: 'webAssist', repoName: 'webassist', auth: { mode: 'guest' } },
    _config: { sso: { enabled: true, providerAgent: 'fixture/identity', providerConfig: {} } },
};
const routing = {
    routes: {
        explorer: { agent: 'explorer', repo: 'AchillesIDE', hostPort: 55289 },
        webAssist: { agent: 'webAssist', repo: 'webassist', hostPort: 53659 },
    },
    static: { agent: 'explorer', hostPath: '/tmp/explorer' },
};
fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify(agents, null, 2));
fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify(routing, null, 2));

const previous = {
    cwd: process.cwd(),
    root: process.env.PLOINKY_WORKSPACE_ROOT,
    key: process.env.PLOINKY_MASTER_KEY,
};
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);

const authHandlers = await import('../../cli/server/authHandlers/index.js');
const { authService } = await import('../../cli/server/authHandlers/shared.js');
const { resolveAuthContextForRoutePlan } = await import('../../cli/server/authHandlers/authContext.js');
const { mintBrowserCsrfToken } = await import('../../cli/server/browserMutationSecurity.js');
const { handleWebtty } = await import('../../cli/server/handlers/webtty.js');
const { WebttySessionManager, WEBTTY_SESSION_LIMITS } = await import('../../cli/server/webtty/sessionManager.mjs');
const { createBrowserSessionLease } = await import('../../cli/server/webtty/authLease.mjs');
const { handleUserAdminRoutes } = await import('../../cli/server/authHandlers/userAdminRoutes.js');
const { handleMarketplaceRoutes } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { policy } = await import('../../cli/server/policy/index.js');

test.after(() => {
    process.chdir(previous.cwd);
    for (const [name, value] of [['PLOINKY_WORKSPACE_ROOT', previous.root], ['PLOINKY_MASTER_KEY', previous.key]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    delete globalThis.__ssoAvailabilityFixture;
    fs.rmSync(workspace, { recursive: true, force: true });
});

class MockResponse {
    constructor() {
        this.statusCode = 0;
        this.headers = new Map();
        this.body = '';
        this.writableEnded = false;
        this.destroyed = false;
    }

    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); }

    getHeader(name) { return this.headers.get(String(name).toLowerCase()); }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value);
    }

    write(chunk) { this.body += String(chunk); return true; }

    end(chunk = '') {
        if (chunk) this.body += String(chunk);
        this.writableEnded = true;
    }
}

function request({ method = 'GET', url, cookie, host = 'localhost', body, headers = {} }) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.headers = {
        accept: 'application/json',
        host,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
    };
    req.socket = { encrypted: false };
    return req;
}

function controlPlan() {
    const snapshot = { generation: 'availability-generation', routing, agents, manifests: {} };
    return {
        ok: false,
        kind: null,
        hostSelection: { kind: 'control', host: 'localhost' },
        snapshot,
        lease: { id: snapshot.generation, snapshot, commit: () => true },
    };
}

function webttyPlan() {
    const snapshot = { generation: 'generation-a', routing, agents, manifests: {} };
    return {
        kind: 'router-surface',
        surface: 'webtty',
        host: 'app.example.test',
        forwarding: { protocol: 'https', authority: 'app.example.test' },
        hostSelection: { host: 'app.example.test', record: { routeKey: 'explorer' } },
        lease: { id: 'generation-a', activationId: 'activation-a', snapshot, commit: () => true, isCurrent: () => true },
        snapshot,
    };
}

function described(providerSession, roles = ['user', 'admin']) {
    return {
        user: { id: 'sso:admin', username: 'admin', roles },
        providerSession: { ...providerSession, expiresAt: Date.now() + 60_000 },
    };
}

function unavailable() {
    return Object.assign(new Error('fixture transport failure'), { providerUnavailable: true });
}

let providerCalls = 0;
function provider(behavior) {
    globalThis.__ssoAvailabilityFixture = async (providerSession, options) => {
        providerCalls += 1;
        return behavior(providerSession, options);
    };
}

async function login() {
    const started = await authService.beginLogin({ baseUrl: 'http://localhost:8080' });
    const { sessionId } = await authService.handleCallback({
        code: 'fixture', state: started.state, browserBinding: started.browserBinding,
        baseUrl: 'http://localhost:8080',
    });
    return sessionId;
}

async function protectedRoute(sessionId) {
    const req = request({ url: '/explorer/index.html', cookie: `ploinky_sso=${sessionId}` });
    const res = new MockResponse();
    const result = await authHandlers.ensureHttpRouteAccess(req, res, new URL(req.url, 'http://localhost'),
        { access: 'authenticated', routeKey: 'explorer', source: 'policy' }, { routePlan: controlPlan() });
    return { req, res, result };
}

function clearsSsoCookie(res) {
    return /(^|,\s*)ploinky_sso=;/.test(String([].concat(res.getHeader('set-cookie') || []).join(', ')));
}

test('a provider outage answers protected requests with a retryable 503 and keeps the login', async () => {
    const sessionId = await login();
    provider(() => { throw unavailable(); });
    const before = providerCalls;
    const denied = await protectedRoute(sessionId);
    assert.equal(denied.result.ok, false);
    assert.equal(denied.res.statusCode, 503);
    assert.equal(denied.res.getHeader('retry-after'), '5');
    assert.equal(JSON.parse(denied.res.body).error, 'authentication_unavailable');
    assert.equal(clearsSsoCookie(denied.res), false, 'the browser keeps its session cookie');
    assert.equal(denied.req.user, undefined, 'no identity is attached to a denied request');
    assert.ok(authService.getSession(sessionId), 'the Router keeps the session');
    assert.equal(providerCalls - before, 1);

    provider((providerSession) => described(providerSession));
    const recoveredBefore = providerCalls;
    const recovered = await protectedRoute(sessionId);
    assert.equal(recovered.result.ok, true);
    assert.equal(recovered.req.user.id, 'sso:admin');
    assert.equal(providerCalls - recoveredBefore, 1, 'recovery needs exactly one provider call');
});

test('a definitive provider refusal ends the login and clears the browser cookie', async () => {
    const sessionId = await login();
    provider(() => { throw Object.assign(new Error('session_revoked'), { code: 'session_revoked', statusCode: 401 }); });
    const denied = await protectedRoute(sessionId);
    assert.equal(denied.res.statusCode, 401);
    assert.equal(clearsSsoCookie(denied.res), true);
    assert.equal(authService.getSession(sessionId), null);
});

test('an admission whose provider session has already expired is denied on the main path', async () => {
    const sessionId = await login();
    provider((providerSession) => ({
        ...described(providerSession),
        providerSession: { ...providerSession, expiresAt: Date.now() - 1000 },
    }));
    const denied = await protectedRoute(sessionId);
    assert.equal(denied.result.ok, false);
    assert.equal(denied.res.statusCode, 401);
    assert.equal(denied.req.user, undefined);
});

test('a guest route with an SSO cookie answers 503 during an outage instead of downgrading to guest', async () => {
    const sessionId = await login();
    provider(() => { throw unavailable(); });
    const req = request({ url: '/webAssist/page', cookie: `ploinky_sso=${sessionId}` });
    const res = new MockResponse();
    const result = await authHandlers.ensureHttpRouteAccess(req, res, new URL(req.url, 'http://localhost'),
        { access: 'guest', routeKey: 'webAssist', source: 'policy' });
    assert.equal(result.ok, false);
    assert.equal(res.statusCode, 503);
    assert.equal(req.authMode, undefined);
    assert.doesNotMatch(String(res.getHeader('set-cookie') || ''), ANY_GUEST_SET_COOKIE);
    assert.ok(authService.getSession(sessionId));
});

test('/auth/token answers 503 during an outage without clearing the session cookie', async () => {
    const sessionId = await login();
    provider(() => { throw unavailable(); });
    const req = request({ url: '/auth/token', cookie: `ploinky_sso=${sessionId}` });
    const res = new MockResponse();
    await authHandlers.handleAuthRoutes(req, res, new URL(req.url, 'http://localhost'), { routePlan: controlPlan() });
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, 'authentication_unavailable');
    assert.equal(clearsSsoCookie(res), false);
    assert.ok(authService.getSession(sessionId));
    provider((providerSession) => described(providerSession));
    const okReq = request({ url: '/auth/token', cookie: `ploinky_sso=${sessionId}` });
    const okRes = new MockResponse();
    await authHandlers.handleAuthRoutes(okReq, okRes, new URL(okReq.url, 'http://localhost'), { routePlan: controlPlan() });
    assert.equal(okRes.statusCode, 200);
});

function webttyManager() {
    const manager = new WebttySessionManager({
        workspaceRoot: workspace,
        recordStore: { recover: async () => ({ ok: true }) },
        launchStore: {},
        targetResolver: {},
    });
    manager.ready = true;
    return manager;
}

async function admitWebtty({ method, url, body, sessionId, routePlan }) {
    const req = request({
        method, url, body, cookie: `ploinky_sso=${sessionId}`, host: 'app.example.test',
        headers: { origin: 'https://app.example.test' },
    });
    const res = new MockResponse();
    const admitted = await authHandlers.ensureAuthenticated(req, res, new URL(req.url, 'https://app.example.test'), { routePlan });
    return { req, res, admitted };
}

function registerTerminal(manager, req, routePlan) {
    const id = 'terminal-abcdefghijklmnop';
    const session = {
        id,
        closed: false,
        closing: false,
        routerEpoch: manager.routerEpoch,
        lease: createBrowserSessionLease(req),
        binding: Object.freeze({
            host: routePlan.host,
            hostRouteKey: routePlan.hostSelection.record.routeKey,
            generation: routePlan.lease.id,
            activationId: routePlan.lease.activationId,
        }),
        routeLease: { isCurrent: () => true },
        target: { kind: 'box' },
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
    };
    manager.sessions.set(id, session);
    return session;
}

test('a WebTTY input request validates the SSO session with exactly one provider call', async () => {
    const sessionId = await login();
    provider((providerSession) => described(providerSession));
    const routePlan = webttyPlan();
    assert.equal(resolveAuthContextForRoutePlan(new URL('/webtty', 'https://app.example.test'), routePlan).mode, 'sso');
    const manager = webttyManager();
    const inputs = [];
    manager.input = async (session, data) => { inputs.push([session.id, data]); };

    const owner = await admitWebtty({ method: 'GET', url: '/webtty', sessionId, routePlan });
    assert.equal(owner.admitted.ok, true);
    const terminal = registerTerminal(manager, owner.req, routePlan);

    const before = providerCalls;
    const url = `/webtty/sessions/${terminal.id}/input`;
    const { req, res, admitted } = await admitWebtty({ method: 'POST', url, body: { data: 'ls\n' }, sessionId, routePlan });
    assert.equal(admitted.ok, true);
    req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({
        req, routePlan, authContext: req.edgeAuthContext, sessionId: req.sessionId,
    });
    await handleWebtty(req, res, new URL(url, 'https://app.example.test'), { manager, routePlan });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(inputs, [[terminal.id, 'ls\n']]);
    assert.equal(providerCalls - before, 1);
});

test('a WebTTY request does not reuse an admission after logout and keeps fresh checks', async () => {
    const sessionId = await login();
    provider((providerSession) => described(providerSession));
    const routePlan = webttyPlan();
    const manager = webttyManager();
    const owner = await admitWebtty({ method: 'GET', url: '/webtty', sessionId, routePlan });
    const terminal = registerTerminal(manager, owner.req, routePlan);
    const closed = [];
    manager.closeSession = async (_session, reason) => { closed.push(reason); return true; };
    const { req, admitted } = await admitWebtty({ method: 'GET', url: `/webtty/sessions/${terminal.id}/stream`, sessionId, routePlan });
    assert.equal(admitted.ok, true);
    await authService.logout(sessionId, {});
    const before = providerCalls;
    assert.equal(await manager.validateOwnership(req, routePlan, terminal.id), null);
    assert.deepEqual(closed, ['auth_missing_or_expired']);
    assert.equal(providerCalls - before, 0, 'a logged-out session needs no provider call to be refused');
    // Periodic checks never reuse a request admission.
    const live = await login();
    const liveOwner = await admitWebtty({ method: 'GET', url: '/webtty', sessionId: live, routePlan });
    const liveLease = createBrowserSessionLease(liveOwner.req);
    const periodicBefore = providerCalls;
    assert.equal((await manager.auth.validateLease(liveLease)).ok, true);
    assert.equal(providerCalls - periodicBefore, 1);
});

test('a WebTTY request does not reuse its admission after a configuration reload', async () => {
    const sessionId = await login();
    provider((providerSession) => described(providerSession));
    const routePlan = webttyPlan();
    const manager = webttyManager();
    const owner = await admitWebtty({ method: 'GET', url: '/webtty', sessionId, routePlan });
    const terminal = registerTerminal(manager, owner.req, routePlan);
    const { req, admitted } = await admitWebtty({ method: 'GET', url: `/webtty/sessions/${terminal.id}/stream`, sessionId, routePlan });
    assert.equal(admitted.ok, true);
    const reused = providerCalls;
    assert.equal(await manager.validateOwnership(req, routePlan, terminal.id), terminal);
    assert.equal(providerCalls - reused, 0, 'the same request reuses its own admission');
    authService.reloadConfig();
    const before = providerCalls;
    assert.equal(await manager.validateOwnership(req, routePlan, terminal.id), terminal);
    assert.equal(providerCalls - before, 1, 'a reload makes the request admission stale');
});

test('a WebTTY request during a provider outage is a retryable 503 and keeps the terminal', async () => {
    const sessionId = await login();
    provider((providerSession) => described(providerSession));
    const routePlan = webttyPlan();
    const manager = webttyManager();
    const owner = await admitWebtty({ method: 'GET', url: '/webtty', sessionId, routePlan });
    const terminal = registerTerminal(manager, owner.req, routePlan);
    let closes = 0;
    manager.closeSession = async () => { closes += 1; return true; };
    provider(() => { throw unavailable(); });
    // Direct ownership check without a request admission asks the provider.
    await assert.rejects(manager.validateOwnership({ ...owner.req }, routePlan, terminal.id),
        { code: 'WEBTTY_UNAVAILABLE' });
    await manager.validateLiveSessions();
    assert.equal(closes, 0, 'an outage neither closes the terminal on request nor in the periodic check');
    const { res, admitted } = await admitWebtty({ method: 'GET', url: `/webtty/sessions/${terminal.id}/stream`, sessionId, routePlan });
    assert.equal(admitted.ok, false);
    assert.equal(res.statusCode, 503);
    assert.ok(authService.getSession(sessionId));
});

function clockedWebttyManager(clock) {
    const manager = new WebttySessionManager({
        workspaceRoot: workspace,
        recordStore: { recover: async () => ({ ok: true }) },
        launchStore: {},
        targetResolver: {},
        now: () => clock.now,
    });
    manager.ready = true;
    return manager;
}

async function clockedTerminal(sessionId, clock) {
    provider((providerSession) => described(providerSession));
    const routePlan = webttyPlan();
    const manager = clockedWebttyManager(clock);
    const owner = await admitWebtty({ method: 'GET', url: '/webtty', sessionId, routePlan });
    const terminal = registerTerminal(manager, owner.req, routePlan);
    terminal.createdAt = clock.now;
    terminal.lastActivityAt = clock.now;
    const closed = [];
    manager.closeSession = async (session, reason) => { closed.push(reason); session.closed = true; manager.sessions.delete(session.id); return true; };
    return { manager, closed };
}

async function periodicChecksUntil(manager, clock, untilMs, stepMs = WEBTTY_SESSION_LIMITS.authenticationIntervalMs) {
    while (clock.now < untilMs) {
        clock.now += stepMs;
        await manager.validateLiveSessions();
    }
}

test('the WebTTY outage bound is a named 60 s limit above the restart window', () => {
    assert.equal(WEBTTY_SESSION_LIMITS.authenticationOutageLimitMs, 60_000);
    assert.ok(WEBTTY_SESSION_LIMITS.authenticationOutageLimitMs < WEBTTY_SESSION_LIMITS.idleLifetimeMs);
});

test('a provider outage shorter than the bound keeps the terminal, and a decided check restarts the bound', async () => {
    const clock = { now: 1_000_000 };
    const sessionId = await login();
    const { manager, closed } = await clockedTerminal(sessionId, clock);
    const start = clock.now;
    provider(() => { throw unavailable(); });
    // Undecided checks from start + 5 s through start + 60 s: 55 s of outage.
    await periodicChecksUntil(manager, clock, start + 60_000);
    assert.deepEqual(closed, [], 'an outage shorter than the bound keeps the terminal');
    provider((providerSession) => described(providerSession));
    await periodicChecksUntil(manager, clock, start + 65_000);
    provider(() => { throw unavailable(); });
    // A new outage is measured from its own first undecided check (start + 70 s).
    await periodicChecksUntil(manager, clock, start + 125_000);
    assert.deepEqual(closed, [], 'the bound restarted at the decided check');
    await periodicChecksUntil(manager, clock, start + 130_000);
    assert.deepEqual(closed, ['auth_provider_unavailable']);
    assert.ok(authService.getSession(sessionId), 'closing the terminal does not end the login');
});

test('a provider outage longer than the bound closes the terminal; a refusal still closes at once', async () => {
    const clock = { now: 2_000_000 };
    const sessionId = await login();
    const { manager, closed } = await clockedTerminal(sessionId, clock);
    const start = clock.now;
    provider(() => { throw unavailable(); });
    await periodicChecksUntil(manager, clock, start + 60_000);
    assert.deepEqual(closed, [], 'first undecided check at +5 s; +60 s is 55 s of outage');
    await periodicChecksUntil(manager, clock, start + 65_000);
    assert.deepEqual(closed, ['auth_provider_unavailable'], '60 s of continuous outage closes the terminal');

    const refused = await login();
    const second = await clockedTerminal(refused, clock);
    provider(() => { throw Object.assign(new Error('session_revoked'), { code: 'session_revoked', statusCode: 401 }); });
    await periodicChecksUntil(second.manager, clock, clock.now + 5_000);
    assert.deepEqual(second.closed, ['auth_missing_or_expired'], 'a refusal closes on the first check');

    const loggedOut = await login();
    const third = await clockedTerminal(loggedOut, clock);
    provider(() => { throw unavailable(); });
    await periodicChecksUntil(third.manager, clock, clock.now + 5_000);
    await authService.logout(loggedOut, {});
    await periodicChecksUntil(third.manager, clock, clock.now + 5_000);
    assert.deepEqual(third.closed, ['auth_missing_or_expired'], 'logout closes during an outage without waiting for the bound');
});

test('WebTTY target discovery reuses its admission and revalidates once after discovery', async () => {
    const sessionId = await login();
    provider((providerSession) => described(providerSession));
    const routePlan = webttyPlan();
    const manager = new WebttySessionManager({
        workspaceRoot: workspace,
        recordStore: { recover: async () => ({ ok: true }) },
        launchStore: {
            invalidateReplacedGenerations() {},
            invalidateAuthSession() {},
            createDiscovery: () => ({ id: 'discovery-abcdefghijklmnop', directory: '', targets: [], agentTargetsAvailable: false }),
        },
        targetResolver: { discover: async () => ({ targets: [], agentTargetsAvailable: false }) },
    });
    manager.ready = true;
    const { req, admitted } = await admitWebtty({ method: 'POST', url: '/webtty/target-discoveries', sessionId, routePlan });
    assert.equal(admitted.ok, true);
    const before = providerCalls;
    const discovery = await manager.discoverTargets({ req, routePlan, directory: '' });
    assert.equal(discovery.id, 'discovery-abcdefghijklmnop');
    assert.equal(providerCalls - before, 1, 'only the post-discovery revalidation asks the provider');
});

function marketplacePublicPlan() {
    const snapshot = { generation: 'availability-generation', routing, agents, manifests: {} };
    return {
        ok: true,
        kind: 'router-surface',
        surface: 'marketplace-ui',
        listener: 'public',
        host: 'explorer.example.test',
        forwarding: { protocol: 'https', authority: 'explorer.example.test' },
        hostSelection: { kind: 'agent-root', host: 'explorer.example.test', record: { routeKey: 'explorer' } },
        snapshot,
        lease: { id: snapshot.generation, snapshot, commit: () => true },
    };
}

// Every Router surface that admits an SSO session answers an undecided
// admission with a retryable 503 and keeps the session; a refusal keeps its
// existing status.
const adminSurfaces = [
    ['user administration', 401, async (sessionId) => {
        const req = request({ url: '/api/agents/explorer/users', cookie: `ploinky_sso=${sessionId}` });
        const res = new MockResponse();
        await handleUserAdminRoutes(req, res, new URL(req.url, 'http://localhost'), { routePlan: controlPlan() });
        return { res, code: JSON.parse(res.body).error };
    }],
    ['public marketplace', 401, async (sessionId) => {
        const req = request({ url: '/api/marketplace/agents', cookie: `ploinky_sso=${sessionId}`, host: 'explorer.example.test' });
        const res = new MockResponse();
        await handleMarketplaceRoutes(req, res, new URL(req.url, 'https://explorer.example.test'),
            { routePlan: marketplacePublicPlan(), agentListOptions: { liveContainers: [] } });
        return { res, code: JSON.parse(res.body).error };
    }],
    ['control marketplace', 401, async (sessionId) => {
        const req = request({ url: '/api/marketplace/agents', cookie: `ploinky_sso=${sessionId}` });
        const res = new MockResponse();
        await handleMarketplaceRoutes(req, res, new URL(req.url, 'http://localhost'),
            { routePlan: null, agentListOptions: { liveContainers: [] } });
        return { res, code: JSON.parse(res.body).error };
    }],
    ['policy command', 401, async (sessionId) => {
        const req = request({ method: 'POST', url: '/policy/command', cookie: `ploinky_sso=${sessionId}`, body: { command: 'http.route.list' } });
        const res = new MockResponse();
        await policy.commandInvoker.handle(req, res, { routePlan: controlPlan() });
        return { res, code: JSON.parse(res.body).error?.code };
    }],
];

for (const [surface, refusalStatus, call] of adminSurfaces) {
    test(`${surface} answers a provider outage with a retryable 503 and keeps the session`, async () => {
        const sessionId = await login();
        provider(() => { throw unavailable(); });
        const before = providerCalls;
        const { res, code } = await call(sessionId);
        assert.equal(res.statusCode, 503, res.body);
        assert.match(String(code), /^authentication_unavailable$/i);
        assert.equal(res.getHeader('retry-after'), '5');
        assert.equal(res.getHeader('cache-control'), 'no-store');
        assert.equal(clearsSsoCookie(res), false, 'the browser keeps its session cookie');
        assert.ok(authService.getSession(sessionId), 'the Router keeps the session');
        assert.equal(providerCalls - before, 1);
    });

    test(`${surface} still answers a definitive refusal with ${refusalStatus} and ends the session`, async () => {
        const sessionId = await login();
        provider(() => { throw Object.assign(new Error('session_revoked'), { code: 'session_revoked', statusCode: 401 }); });
        const { res } = await call(sessionId);
        assert.equal(res.statusCode, refusalStatus, res.body);
        assert.equal(res.getHeader('retry-after'), undefined);
        assert.equal(authService.getSession(sessionId), null);
    });
}
