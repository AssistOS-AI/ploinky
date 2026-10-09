// Per-route guest cookies: every mint, read and clear site uses the one name
// helper, identities of different guest routes never overwrite each other, a
// cookie under one route's name never authorizes another route, and logout
// retires every Router-known guest identity the browser presents.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { ANY_GUEST_SET_COOKIE, GuestCookieJar, guestSetCookies, setCookies } from '../helpers/guestCookies.mjs';
import { signBrowserSessionFixture } from '../helpers/routerSessionFixture.mjs';
import {
    LEGACY_GUEST_AUTH_COOKIE_NAME as LEGACY,
    guestCookieNameForRouteKey as nameFor,
} from '../../cli/server/auth/guestCookieNames.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-guest-isolation-')));
const previous = {
    cwd: process.cwd(),
    root: process.env.PLOINKY_WORKSPACE_ROOT,
    key: process.env.PLOINKY_MASTER_KEY,
};

const ROOM_X = 'room_11111111-1111-4111-8111-111111111111';
const ROOM_Y = 'room_22222222-2222-4222-8222-222222222222';
const DOTTED = 'guest.route-x';
const PUBLIC_HOST = 'explorer.localhost';
const WEBCHAT_HOST = 'wa.example.test';

function writeWorkspace() {
    const ploinkyDir = path.join(root, '.ploinky');
    fs.mkdirSync(path.join(ploinkyDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ploinkyDir, 'data', '.secrets'), '# test secrets\n');
    const agent = (agentName, repoName, mode) => ({ type: 'agent', agentName, repoName, auth: { mode } });
    const agents = {
        explorer: agent('explorer', 'AchillesIDE', 'sso'),
        webAssist: agent('webAssist', 'webassist', 'guest'),
        webmeetAgent: agent('webmeetAgent', 'AchillesIDE', 'guest'),
        guestAgent: agent('guestAgent', 'services', 'none'),
        [DOTTED]: agent(DOTTED, 'services', 'guest'),
    };
    const routing = {
        routes: {
            explorer: { agent: 'explorer', repo: 'AchillesIDE', hostPort: 55289 },
            webAssist: { agent: 'webAssist', repo: 'webassist', hostPort: 53659 },
            webmeetAgent: { agent: 'webmeetAgent', repo: 'AchillesIDE', hostPort: 53661 },
            guestAgent: { agent: 'guestAgent', repo: 'services', hostPort: 43111 },
            [DOTTED]: { agent: DOTTED, repo: 'services', hostPort: 43112 },
        },
        static: { agent: 'explorer', hostPath: '/tmp/explorer' },
    };
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify(agents, null, 2));
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify(routing, null, 2));
    const roomWinner = {
        access: 'guest',
        routeKey: 'webmeetAgent',
        source: 'manifest',
        guestScope: 'webmeet:room',
        guestScopeParam: 'roomId',
    };
    const guestDefault = (routeKey) => ({ access: 'guest', routeKey, source: 'routeDefault' });
    const snapshot = {
        generation: 'guest-isolation-generation',
        routing,
        agents,
        manifests: { webAssist: { webchat: { auth: 'self' } } },
        compiled: {
            agentMcpRoutes: { [PUBLIC_HOST]: ['explorer', 'webAssist', 'webmeetAgent'] },
            dependencyHttpRoutes: {
                [PUBLIC_HOST]: [{ path: '/webmeetAgent/roomLoader.html', routeKey: 'webmeetAgent' }],
            },
            policy: {
                entries: [{ path: '/webmeetAgent/roomLoader.html', ...roomWinner }],
                routeDefaults: {
                    explorer: { access: 'authenticated', routeKey: 'explorer', source: 'routeDefault' },
                    webAssist: guestDefault('webAssist'),
                    webmeetAgent: guestDefault('webmeetAgent'),
                    [DOTTED]: guestDefault(DOTTED),
                },
                namespaces: [{
                    id: 'route:webmeetAgent',
                    kind: 'route',
                    routeKey: 'webmeetAgent',
                    prefix: '/webmeetAgent',
                    partitions: [{ representative: '/webmeetAgent/roomLoader.html', winner: roomWinner }],
                }],
            },
        },
    };
    return snapshot;
}

const SNAPSHOT = writeWorkspace();
process.chdir(root);
process.env.PLOINKY_WORKSPACE_ROOT = root;
process.env.PLOINKY_MASTER_KEY = '4'.repeat(64);

const authHandlers = await import('../../cli/server/authHandlers/index.js');
const { createMcpSessionOwner } = await import('../../cli/server/mcp-proxy/sessionOwnership.mjs');
const { mintGuestSessionJwt, verifySessionJwt } = await import('../../cli/server/auth/localService.js');
const { sanitizeRequestHeaders } = await import('../../cli/server/proxy/sanitizeRequestHeaders.js');

const REVOCATIONS_FILE = path.join(root, '.ploinky', 'data', 'router-security', 'sessions-revocations.json');

test.after(() => {
    process.chdir(previous.cwd);
    for (const [name, value] of [['PLOINKY_WORKSPACE_ROOT', previous.root], ['PLOINKY_MASTER_KEY', previous.key]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
});

class MockResponse {
    constructor() { this.statusCode = 200; this.headers = new Map(); this.body = ''; }
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); }
    getHeader(name) { return this.headers.get(String(name).toLowerCase()); }
    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value);
    }
    end(chunk = '') { this.body += chunk ? String(chunk) : ''; }
}

function makeRequest({ method = 'GET', url, cookie = '', body, host = 'localhost', headers = {}, accept = 'application/json' }) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
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

const lease = { id: SNAPSHOT.generation, snapshot: SNAPSHOT, commit: () => true };

function controlPlan(extra = {}) {
    return { ok: false, kind: null, hostSelection: { kind: 'control', host: 'localhost' }, snapshot: SNAPSHOT, lease, ...extra };
}

// The production MCP plan: an agent-root plan for /<route>/mcp whose policy
// decision is the route default.
function agentRootPlan(routeKey, { withDecision = true } = {}) {
    return controlPlan({
        ok: true,
        kind: 'agent-root',
        routeKey,
        upstreamPath: '/mcp',
        target: { hostname: '127.0.0.1', hostPort: 1 },
        ...(withDecision ? { decision: { access: 'guest', routeKey, source: 'routeDefault' } } : {}),
    });
}

function publicHostPlan(extra = {}) {
    return {
        ok: true,
        kind: 'router-surface',
        surface: 'browser-auth',
        host: PUBLIC_HOST,
        hostSelection: { kind: 'agent-root', source: 'public-host', host: PUBLIC_HOST, record: { routeKey: 'explorer' } },
        forwarding: { protocol: 'https', authority: PUBLIC_HOST },
        snapshot: SNAPSHOT,
        lease,
        ...extra,
    };
}

function webchatHostPlan() {
    return {
        ok: true,
        kind: 'router-surface',
        surface: 'webchat',
        listener: 'public',
        host: WEBCHAT_HOST,
        hostSelection: { kind: 'agent-root', host: WEBCHAT_HOST, record: { routeKey: 'webAssist' } },
        forwarding: { protocol: 'http', authority: WEBCHAT_HOST },
        snapshot: SNAPSHOT,
        lease,
    };
}

const MEETING_ROOM = { access: 'guest', routeKey: 'guestAgent', source: 'manifest', guestScope: 'meeting-room-public-service' };
const ROOM_LOADER = {
    access: 'guest',
    routeKey: 'webmeetAgent',
    source: 'manifest',
    guestScope: 'webmeet:room',
    guestScopeParam: 'roomId',
};

async function apply(jar, req, res, run) {
    const result = await run(req, res);
    jar?.apply(res);
    return { req, res, result };
}

// Agent MCP through the production agent-root plan.
function mcp(routeKey, jar, { plan = agentRootPlan(routeKey), cookie = jar?.header() || '' } = {}) {
    const req = makeRequest({ method: 'POST', url: `/${routeKey}/mcp`, cookie });
    return apply(jar, req, new MockResponse(), (q, s) => authHandlers.ensureAuthenticated(q, s, new URL(q.url, 'http://localhost'), { routePlan: plan }));
}

// Agent MCP through the record path (no route plan): the route's own auth record.
function recordMcp(routeKey, jar, { cookie = jar?.header() || '' } = {}) {
    const req = makeRequest({ method: 'POST', url: `/${routeKey}/mcp`, cookie });
    return apply(jar, req, new MockResponse(), (q, s) => authHandlers.ensureAuthenticated(q, s, new URL(q.url, 'http://localhost')));
}

function httpRoute(decision, url, jar, { plan = controlPlan(), cookie = jar?.header() || '', host = 'localhost' } = {}) {
    const req = makeRequest({ url, cookie, host });
    return apply(jar, req, new MockResponse(), (q, s) => authHandlers.ensureHttpRouteAccess(q, s, new URL(q.url, `http://${host}`), decision, { routePlan: plan }));
}

function meetingRoom(jar, options) {
    return httpRoute(MEETING_ROOM, '/guestAgent/meeting-room/example', jar, options);
}

function roomPage(roomId, jar, options) {
    return httpRoute(ROOM_LOADER, `/webmeetAgent/roomLoader.html?roomId=${roomId}`, jar, options);
}

function authRoute(url, jar, { method = 'GET', body, plan = controlPlan(), host = 'localhost', origin, cookie = jar?.header() || '' } = {}) {
    const req = makeRequest({ method, url, cookie, body, host, headers: origin ? { origin } : {} });
    const base = plan.forwarding ? `${plan.forwarding.protocol}://${host}` : `http://${host}`;
    return apply(jar, req, new MockResponse(), (q, s) => authHandlers.handleAuthRoutes(q, s, new URL(q.url, base), { routePlan: plan }));
}

function json(res) {
    return JSON.parse(res.body || '{}');
}

function guestNames(res) {
    return guestSetCookies(res).map((cookie) => cookie.name);
}

function assertNoGuestSetCookie(res, label) {
    assert.deepEqual(guestSetCookies(res), [], label);
    assert.doesNotMatch(String([res.getHeader('set-cookie')].flat().filter(Boolean)), ANY_GUEST_SET_COOKIE, label);
}

function assertMinted(res, name, label) {
    const minted = guestSetCookies(res).filter((cookie) => cookie.value);
    assert.deepEqual(minted.map((cookie) => cookie.name), [name], label);
    assert.equal(minted[0].maxAge, 3600, label);
    assert.ok(minted[0].attributes.includes('Path=/') && minted[0].attributes.includes('HttpOnly')
        && minted[0].attributes.includes('SameSite=Lax'), label);
    return minted[0].value;
}

function revocationEntries() {
    try { return JSON.parse(fs.readFileSync(REVOCATIONS_FILE, 'utf8')).revoked; } catch { return []; }
}

// ---- A3: one helper at every mint, read and clear site -------------------------------

test('A3 every guest surface mints under its route name and replays the same identity', async (t) => {
    const rows = [
        {
            label: '(a) route-default agent MCP /webAssist/mcp (agent-root plan with decision)',
            name: nameFor('webAssist'),
            mint: (jar) => mcp('webAssist', jar),
            replay: (jar) => mcp('webAssist', jar),
            groute: 'webAssist',
        },
        {
            label: '(a2) agent-root plan resolved from routeDefaults without a decision',
            name: nameFor('webmeetAgent'),
            mint: (jar) => mcp('webmeetAgent', jar, { plan: agentRootPlan('webmeetAgent', { withDecision: false }) }),
            replay: (jar) => mcp('webmeetAgent', jar, { plan: agentRootPlan('webmeetAgent', { withDecision: false }) }),
            groute: 'webmeetAgent',
        },
        {
            label: '(a3) record-path guest MCP (no route plan)',
            name: nameFor('webAssist'),
            mint: (jar) => recordMcp('webAssist', jar),
            replay: (jar) => recordMcp('webAssist', jar),
            groute: undefined,
        },
        {
            label: '(b) scoped guest HTTP route (guestAgent meeting-room)',
            name: nameFor('guestAgent'),
            mint: (jar) => meetingRoom(jar),
            replay: (jar) => meetingRoom(jar),
            groute: 'guestAgent',
        },
        {
            label: '(c) guestScopeParam room page, then /webmeetAgent/mcp reuses the room token',
            name: nameFor('webmeetAgent'),
            mint: (jar) => roomPage(ROOM_X, jar),
            replay: (jar) => mcp('webmeetAgent', jar),
            groute: 'webmeetAgent',
            gscope: `webmeet:room:${ROOM_X}`,
        },
        {
            label: '(e) host-bound WebChat surface owned by a guest-self agent',
            name: nameFor('webAssist'),
            mint: (jar) => httpWebchat(jar),
            replay: (jar) => httpWebchat(jar),
            groute: undefined,
        },
        {
            label: 'boundary: a guest route key with dot and dash',
            name: nameFor(DOTTED),
            mint: (jar) => mcp(DOTTED, jar),
            replay: (jar) => mcp(DOTTED, jar),
            groute: DOTTED,
        },
    ];
    for (const row of rows) {
        await t.test(row.label, async () => {
            const jar = new GuestCookieJar();
            const first = await row.mint(jar);
            assert.equal(first.result.ok, true, row.label);
            assert.equal(first.req.authMode, 'guest', row.label);
            const value = assertMinted(first.res, row.name, row.label);
            assert.equal(value, first.req.sessionId, row.label);
            assert.equal(first.req.session?._jwtPayload?.groute, row.groute, row.label);
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const again = await row.replay(jar);
                assert.equal(again.result.ok, true, row.label);
                assert.equal(again.req.user?.id, first.req.user?.id, `${row.label} replay ${attempt}`);
                assert.equal(again.req.sessionId, value, `${row.label} replay ${attempt}`);
                if (row.gscope) assert.equal(again.req.session?._jwtPayload?.gscope, row.gscope, row.label);
                assertNoGuestSetCookie(again.res, `${row.label} replay ${attempt}`);
            }
            assert.deepEqual(jar.guestNames(), [row.name], row.label);
        });
    }
});

function httpWebchat(jar) {
    const req = makeRequest({ url: '/webchat/', cookie: jar.header(), host: WEBCHAT_HOST, accept: 'text/html' });
    return apply(jar, req, new MockResponse(), (q, s) => authHandlers.ensureAuthenticated(q, s, new URL(q.url, `http://${WEBCHAT_HOST}`), { routePlan: webchatHostPlan() }));
}

test('A3(d) browser-proof /auth/token reads and re-sets the room route cookie on host-bound and control plans', async () => {
    for (const [label, plan, host, origin] of [
        ['host-bound', publicHostPlan(), PUBLIC_HOST, `https://${PUBLIC_HOST}`],
        ['control', controlPlan(), 'localhost', 'http://localhost'],
    ]) {
        const jar = new GuestCookieJar();
        const page = await roomPage(ROOM_X, jar);
        const roomToken = assertMinted(page.res, nameFor('webmeetAgent'), label);
        const url = `/auth/token?mutationRoute=webmeetAgent&mutationPath=%2FwebmeetAgent%2FroomLoader.html&roomId=${ROOM_X}`;
        const read = await authRoute(url, jar, { plan, host });
        assert.equal(read.res.statusCode, 200, `${label}: ${read.res.body}`);
        assert.equal(read.req.user?.id, page.req.user?.id, label);
        assertNoGuestSetCookie(read.res, label);
        const csrfToken = json(read.res).browserMutation.csrfToken;
        const post = await authRoute(url, jar, { plan, host, method: 'POST', body: { csrfToken }, origin });
        assert.equal(post.res.statusCode, 200, `${label}: ${post.res.body}`);
        assert.equal(post.req.user?.id, page.req.user?.id, label);
        // The re-set uses the same name and value: no second identity is created.
        assert.deepEqual(guestSetCookies(post.res).map(({ name, value }) => ({ name, value })),
            [{ name: nameFor('webmeetAgent'), value: roomToken }], label);
        assert.equal(jar.get(nameFor('webmeetAgent')), roomToken, label);
    }
});

// ---- A4: a cookie for policy A never authorizes policy B ----------------------------

test('A4 a guest JWT under another route name mints a new identity, and a room-X token is refused for room Y', async () => {
    const webAssistJwt = mintGuestSessionJwt({ routeKey: 'webAssist', guestScope: 'http-route:webAssist' });
    assert.equal(verifySessionJwt(webAssistJwt).groute, 'webAssist');
    // Positive control: under its own name the JWT is accepted at its own route.
    const own = await mcp('webAssist', null, { cookie: `${nameFor('webAssist')}=${webAssistJwt}` });
    assert.equal(own.req.sessionId, webAssistJwt);
    assertNoGuestSetCookie(own.res, 'own route');

    const foreign = await meetingRoom(null, { cookie: `${nameFor('guestAgent')}=${webAssistJwt}` });
    assert.equal(foreign.result.ok, true);
    assert.notEqual(foreign.req.sessionId, webAssistJwt);
    assert.notEqual(foreign.req.user?.id, own.req.user?.id);
    assert.equal(foreign.req.session?._jwtPayload?.groute, 'guestAgent');
    assertMinted(foreign.res, nameFor('guestAgent'), 'fresh guestAgent cookie');

    const jar = new GuestCookieJar();
    await roomPage(ROOM_X, jar);
    const base = '/auth/token?mutationRoute=webmeetAgent&mutationPath=%2FwebmeetAgent%2FroomLoader.html&roomId=';
    const allowed = await authRoute(`${base}${ROOM_X}`, jar);
    assert.equal(allowed.res.statusCode, 200, allowed.res.body);
    const denied = await authRoute(`${base}${ROOM_Y}`, jar);
    assert.equal(denied.res.statusCode, 401, denied.res.body);
    assert.equal(json(denied.res).error, 'session_expired');
    // The refused read clears only that route's cookie.
    assert.deepEqual(guestNames(denied.res), [nameFor('webmeetAgent')]);
});

// ---- A7 and M3: logout ---------------------------------------------------------------

async function csrfFor(jar, routeKey = 'webAssist') {
    const token = await authRoute(`/auth/token?agent=${routeKey}`, jar);
    assert.equal(token.res.statusCode, 200, token.res.body);
    return json(token.res).browserMutation.csrfToken;
}

test('A7 guest logout clears and revokes every Router-known guest identity', async (t) => {
    const jar = new GuestCookieJar();
    const webAssist = await recordMcp('webAssist', jar);
    const guestAgent = await meetingRoom(jar);
    const legacyJwt = mintGuestSessionJwt({ routeKey: 'webAssist', guestScope: 'http-route:webAssist' });
    jar.set(LEGACY, legacyJwt);
    const csrfToken = await csrfFor(jar);
    const before = revocationEntries().length;
    const writes = [];
    const realRename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if (String(to) === REVOCATIONS_FILE) writes.push(to);
        return realRename(from, to);
    });
    const presented = jar.clone();
    const out = await authRoute('/auth/logout?agent=webAssist', jar, {
        method: 'POST', body: { csrfToken }, origin: 'http://localhost',
    });
    assert.equal(out.res.statusCode, 302, out.res.body);
    const cleared = setCookies(out.res).filter((cookie) => cookie.maxAge === 0).map((cookie) => cookie.name).sort();
    assert.deepEqual(cleared, [LEGACY, 'ploinky_browser_csrf', nameFor('guestAgent'), nameFor('webAssist')].sort());
    assert.deepEqual(jar.guestNames(), []);
    assert.equal(writes.length, 1, 'one revocation write per logout');
    const added = revocationEntries().slice(before);
    assert.deepEqual(added.map((entry) => entry.sid).sort(), [
        webAssist.req.session._jwtPayload.sid,
        guestAgent.req.session._jwtPayload.sid,
        verifySessionJwt(legacyJwt).sid,
    ].sort());

    // Both identities are revoked: replaying either under its own name mints anew.
    const replayWebAssist = await recordMcp('webAssist', null, { cookie: `${nameFor('webAssist')}=${presented.get(nameFor('webAssist'))}` });
    assert.notEqual(replayWebAssist.req.user?.id, webAssist.req.user?.id);
    assertMinted(replayWebAssist.res, nameFor('webAssist'), 'revoked webAssist');
    const replayGuestAgent = await meetingRoom(null, { cookie: `${nameFor('guestAgent')}=${presented.get(nameFor('guestAgent'))}` });
    assert.notEqual(replayGuestAgent.req.user?.id, guestAgent.req.user?.id);
    assertMinted(replayGuestAgent.res, nameFor('guestAgent'), 'revoked guestAgent');

    // Idempotency: replaying the logout POST with the revoked cookies shows the
    // logged-out page, writes nothing and leaves a parseable list.
    const again = await authRoute('/auth/logout?agent=webAssist', null, {
        method: 'POST', body: { csrfToken }, origin: 'http://localhost', cookie: presented.header(),
    });
    assert.equal(again.res.statusCode, 200);
    assert.match(again.res.body, /logged out|signed out/i);
    assert.equal(writes.length, 1);
    assert.equal(revocationEntries().length, before + 3);
});

test('A7 probe: 40 copies of one JWT under arbitrary guest-like names cause one write and are never echoed', async (t) => {
    const jar = new GuestCookieJar();
    const primary = await recordMcp('webAssist', jar);
    const other = await meetingRoom(jar);
    const otherJwt = other.req.sessionId;
    const csrfToken = await csrfFor(jar);
    const arbitrary = Array.from({ length: 40 }, (_, index) => `ploinky_guest${index % 2 ? '_' : ''}x${index}`); // legacy-guest-cookie-case (guest-name family prefix)
    for (const name of arbitrary) jar.set(name, otherJwt);
    jar.set('ploinky_guest_ghost', primary.req.sessionId);
    // The primary JWT also under the legacy name: one sid, revoked once.
    jar.set(LEGACY, primary.req.sessionId);
    const before = revocationEntries().length;
    const writes = [];
    const realRename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if (String(to) === REVOCATIONS_FILE) writes.push(to);
        return realRename(from, to);
    });
    const out = await authRoute('/auth/logout?agent=webAssist', null, {
        method: 'POST', body: { csrfToken }, origin: 'http://localhost', cookie: jar.header(),
    });
    assert.equal(out.res.statusCode, 302, out.res.body);
    assert.equal(writes.length, 1);
    const echoed = setCookies(out.res).map((cookie) => cookie.name).sort();
    assert.deepEqual(echoed, [LEGACY, 'ploinky_browser_csrf', nameFor('guestAgent'), nameFor('webAssist')].sort());
    const added = revocationEntries().slice(before);
    assert.equal(added.length, 2, 'de-duplicated by sid');
    assert.deepEqual(added.map((entry) => entry.sid).sort(),
        [primary.req.session._jwtPayload.sid, other.req.session._jwtPayload.sid].sort(), 'de-duplicated by sid');
});

test('A7 a valid guest JWT under a name that is not its own route name is neither revoked nor cleared', async () => {
    const jar = new GuestCookieJar();
    await recordMcp('webAssist', jar);
    const guestAgentJwt = mintGuestSessionJwt({ routeKey: 'guestAgent', guestScope: 'meeting-room-public-service' });
    jar.set(nameFor('webmeetAgent'), guestAgentJwt);
    jar.set(nameFor('ghost'), 'not-a-jwt');
    const csrfToken = await csrfFor(jar);
    const out = await authRoute('/auth/logout?agent=webAssist', null, {
        method: 'POST', body: { csrfToken }, origin: 'http://localhost', cookie: jar.header(),
    });
    assert.equal(out.res.statusCode, 302);
    assert.deepEqual(guestNames(out.res), [nameFor('webAssist')]);
    assert.ok(!revocationEntries().some((entry) => entry.sid === verifySessionJwt(guestAgentJwt).sid));
});

// ---- A10: legacy cookie ignored and cleared -----------------------------------------

test('A10 a legacy shared guest cookie is never read and is cleared by the next mint', async () => {
    for (const [label, run] of [
        ['record path', (cookie) => recordMcp('webAssist', null, { cookie })],
        ['agent-root plan', (cookie) => mcp('webAssist', null, { cookie })],
    ]) {
        const legacyJwt = mintGuestSessionJwt({ routeKey: 'webAssist', guestScope: 'http-route:webAssist' });
        // Positive control: the same JWT is a valid webAssist session under the route name.
        const control = await mcp('webAssist', null, { cookie: `${nameFor('webAssist')}=${legacyJwt}` });
        assert.equal(control.req.sessionId, legacyJwt, label);
        const { req, res } = await run(`${LEGACY}=${legacyJwt}`);
        assert.equal(req.authMode, 'guest', label);
        assert.notEqual(req.sessionId, legacyJwt, label);
        const cookies = guestSetCookies(res);
        assert.ok(cookies.some((cookie) => cookie.name === nameFor('webAssist') && cookie.value), label);
        assert.ok(cookies.some((cookie) => cookie.name === LEGACY && cookie.value === '' && cookie.maxAge === 0), label);
    }
});

// ---- Adversarial probes ----------------------------------------------------------------

test('error injection: malformed or foreign values under the route name or the legacy name cause a fresh mint', async () => {
    const valid = mintGuestSessionJwt({ routeKey: 'webAssist', guestScope: 'http-route:webAssist' });
    const [header, payload, signature] = valid.split('.');
    // Flip a middle character: the last base64url character of a 32-byte MAC
    // also carries padding bits, so changing it may not change the signature.
    const flipped = `${header}.${payload}.${signature.slice(0, 10)}${signature[10] === 'A' ? 'Q' : 'A'}${signature.slice(11)}`;
    assert.notDeepEqual(Buffer.from(flipped.split('.')[2], 'base64url'), Buffer.from(signature, 'base64url'));
    const injected = {
        abc: 'abc',
        truncated: valid.slice(0, valid.length - 12),
        'flipped signature': flipped,
        'user session': signBrowserSessionFixture({ id: 'local:admin', username: 'admin', roles: ['admin'] }),
        'other route': mintGuestSessionJwt({ routeKey: 'other', guestScope: 'http-route:other' }),
    };
    // Positive control for the same name.
    assert.equal((await mcp('webAssist', null, { cookie: `${nameFor('webAssist')}=${valid}` })).req.sessionId, valid);
    for (const [label, value] of Object.entries(injected)) {
        const routeNamed = await mcp('webAssist', null, { cookie: `${nameFor('webAssist')}=${value}` });
        assert.equal(routeNamed.result.ok, true, label);
        assert.notEqual(routeNamed.req.sessionId, value, label);
        assertMinted(routeNamed.res, nameFor('webAssist'), label);
        const legacyNamed = await mcp('webAssist', null, { cookie: `${LEGACY}=${value}` });
        assert.equal(legacyNamed.result.ok, true, label);
        assert.notEqual(legacyNamed.req.sessionId, value, label);
        assert.ok(guestSetCookies(legacyNamed.res).some((cookie) => cookie.name === LEGACY && cookie.maxAge === 0), label);
    }
});

test('orphan: a cookie for a route that is not a guest route is ignored, stripped and never rewritten', async () => {
    const ghostName = nameFor('ghost');
    const ghostJwt = mintGuestSessionJwt({ routeKey: 'ghost', guestScope: 'http-route:ghost' });
    const jar = new GuestCookieJar([[ghostName, ghostJwt]]);
    const webAssist = await mcp('webAssist', jar);
    assert.notEqual(webAssist.req.sessionId, ghostJwt);
    assert.ok(!guestNames(webAssist.res).includes(ghostName));
    const room = await meetingRoom(jar);
    assert.ok(!guestNames(room.res).includes(ghostName));
    assert.equal(jar.get(ghostName), ghostJwt);
    const token = await authRoute('/auth/token?agent=ghost', jar);
    assert.equal(token.res.statusCode, 404);
    assert.equal(json(token.res).error, 'auth_disabled');
    const forwarded = sanitizeRequestHeaders({ cookie: `${ghostName}=${ghostJwt}; app=ok` }, {
        port: 7000, scheme: 'http', authority: 'router.example', forwardedPrefix: '/x',
        credentialPolicy: { allowApplicationCookies: true },
    }, {});
    assert.equal(forwarded.cookie, 'app=ok');
});

test('concurrency: interleaved first-time mints for two routes leave one cookie per route that validates', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2
        ? meetingRoom(null, { cookie: '' })
        : mcp('webAssist', null, { cookie: '' }))));
    const jar = new GuestCookieJar();
    // Apply the responses in a scrambled order.
    for (const index of [7, 2, 19, 0, 11, 4, 15, 8, 1, 13, 6, 17, 3, 10, 18, 5, 12, 9, 16, 14]) jar.apply(results[index].res);
    assert.deepEqual(jar.guestNames(), [nameFor('webAssist'), nameFor('guestAgent')].sort());
    const webAssist = await mcp('webAssist', jar);
    assert.equal(webAssist.req.sessionId, jar.get(nameFor('webAssist')));
    assertNoGuestSetCookie(webAssist.res, 'webAssist');
    const room = await meetingRoom(jar);
    assert.equal(room.req.sessionId, jar.get(nameFor('guestAgent')));
    assertNoGuestSetCookie(room.res, 'guestAgent');
});

test('CSRF interplay: the single browser CSRF cookie follows the latest mint, the body token keeps working', async () => {
    const jar = new GuestCookieJar();
    await recordMcp('webAssist', jar);
    const tokenA = await csrfFor(jar);
    const b = await meetingRoom(jar);
    assert.ok(setCookies(b.res).some((cookie) => cookie.name === 'ploinky_browser_csrf' && cookie.value));
    // The CSRF cookie is now bound to B's session, so A's cookie-only fallback fails...
    const cookieOnly = await authRoute('/auth/token?agent=webAssist', jar, {
        method: 'POST', body: {}, origin: 'http://localhost',
    });
    assert.equal(cookieOnly.res.statusCode, 403);
    assert.equal(json(cookieOnly.res).error, 'browser_csrf_invalid');
    // ...while A's body proof token still works.
    const withBody = await authRoute('/auth/token?agent=webAssist', jar, {
        method: 'POST', body: { csrfToken: tokenA }, origin: 'http://localhost',
    });
    assert.equal(withBody.res.statusCode, 200, withBody.res.body);
});

test('fail closed: a guest context without a route key mints nothing and sets no cookie', async () => {
    const page = await httpRoute({ access: 'guest', routeKey: '', source: 'manifest' }, '/x', null);
    assert.equal(page.result.ok, false);
    assert.equal(page.res.statusCode, 503);
    assert.equal(json(page.res).error, 'guest_route_unresolved');
    assert.equal(page.res.getHeader('set-cookie'), undefined);
    assert.equal(page.req.user, undefined);
    for (const [url, method] of [['/auth/token', 'GET'], ['/auth/logout', 'GET'], ['/auth/logout', 'POST']]) {
        const out = await authRoute(url, null, {
            method,
            body: method === 'POST' ? {} : undefined,
            origin: 'http://localhost',
            cookie: `${nameFor('webAssist')}=x`,
            plan: controlPlan({ decision: { access: 'guest', routeKey: '', source: 'routeDefault' } }),
        });
        assert.equal(out.res.statusCode, 503, `${method} ${url}: ${out.res.body}`);
        assert.equal(json(out.res).error, 'guest_route_unresolved', url);
        assert.equal(out.res.getHeader('set-cookie'), undefined, url);
    }
});

test('C1 is unchanged: two guest routes keep two distinct MCP owners that each survive the other mint', async () => {
    const jar = new GuestCookieJar();
    const a = await mcp('webAssist', jar);
    const ownerA = createMcpSessionOwner(a.req, 'agent', 'webAssist');
    const b = await mcp('webmeetAgent', jar);
    const ownerB = createMcpSessionOwner(b.req, 'agent', 'webmeetAgent');
    assert.notEqual(ownerA.binding, ownerB.binding);
    const a2 = await mcp('webAssist', jar);
    assert.deepEqual(createMcpSessionOwner(a2.req, 'agent', 'webAssist'), ownerA);
    const b2 = await mcp('webmeetAgent', jar);
    assert.deepEqual(createMcpSessionOwner(b2.req, 'agent', 'webmeetAgent'), ownerB);
});
