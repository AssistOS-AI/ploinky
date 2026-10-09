// KNOWN LIMITATION (product-owner question Q1), recorded as a regression test.
//
// Guest cookies are per guest route, not per guest scope. Two WebMeet rooms on
// the same guest route in one browser jar therefore share one cookie: opening
// room Y replaces the room-X guest identity, and the MCP session that room X
// opened is then refused by browser MCP session ownership (C1), because its
// owner was the room-X identity. This test pins that behaviour so a change to it
// is a visible decision, not a silent pass. Fixing it needs a design change
// (for example MCP choosing among several presented cookies by the stored
// session owner); per-room cookies and loosening C1 or the scope checks are
// explicitly not the fix.
//
// This file imports only modules that exist both before and after C1 (commit
// d1c568ae) and before and after per-route guest cookies, and it inlines its
// cookie jar and never names a guest cookie, so the same scenario runs at
// older revisions. The observations are emitted as test diagnostics before any
// assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const ROOM_X = 'room_11111111-1111-4111-8111-111111111111';
const ROOM_Y = 'room_22222222-2222-4222-8222-222222222222';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ploinky-guest-rooms-')));
const previous = {
    cwd: process.cwd(),
    root: process.env.PLOINKY_WORKSPACE_ROOT,
    key: process.env.PLOINKY_MASTER_KEY,
};

function writeWorkspace() {
    const ploinkyDir = path.join(root, '.ploinky');
    mkdirSync(path.join(ploinkyDir, 'data'), { recursive: true });
    writeFileSync(path.join(ploinkyDir, 'data', '.secrets'), '# test secrets\n');
    const agents = {
        explorer: { type: 'agent', agentName: 'explorer', repoName: 'AchillesIDE', auth: { mode: 'sso' } },
        webmeetAgent: { type: 'agent', agentName: 'webmeetAgent', repoName: 'AchillesIDE', auth: { mode: 'guest' } },
    };
    const routing = {
        routes: {
            explorer: { agent: 'explorer', repo: 'AchillesIDE', hostPort: 55289 },
            webmeetAgent: { agent: 'webmeetAgent', repo: 'AchillesIDE', hostPort: 53661 },
        },
        static: { agent: 'explorer', hostPath: '/tmp/explorer' },
    };
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify(agents, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify(routing, null, 2));
    const roomWinner = {
        access: 'guest',
        routeKey: 'webmeetAgent',
        source: 'manifest',
        guestScope: 'webmeet:room',
        guestScopeParam: 'roomId',
    };
    return {
        generation: 'guest-rooms-generation',
        routing,
        agents,
        manifests: {},
        compiled: {
            policy: {
                entries: [{ path: '/webmeetAgent/roomLoader.html', ...roomWinner }],
                routeDefaults: {
                    explorer: { access: 'authenticated', routeKey: 'explorer', source: 'routeDefault' },
                    webmeetAgent: { access: 'guest', routeKey: 'webmeetAgent', source: 'routeDefault' },
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
}

const SNAPSHOT = writeWorkspace();
process.chdir(root);
process.env.PLOINKY_WORKSPACE_ROOT = root;
process.env.PLOINKY_MASTER_KEY = '4'.repeat(64);

const authHandlers = await import('../../cli/server/authHandlers/index.js');
const { handleAgentMcpRequest, agentSessionStore } = await import('../../cli/server/mcp-proxy/index.js');

test.after(() => {
    process.chdir(previous.cwd);
    for (const [name, value] of [['PLOINKY_WORKSPACE_ROOT', previous.root], ['PLOINKY_MASTER_KEY', previous.key]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
});

// Inline browser cookie jar: Set-Cookie replaces by name, Max-Age=0 removes.
class Jar {
    constructor() { this.cookies = new Map(); }
    apply(res) {
        for (const line of [res.getHeader('set-cookie')].flat().filter(Boolean).map(String)) {
            const [pair, ...attributes] = line.split(';').map((part) => part.trim());
            const index = pair.indexOf('=');
            const name = pair.slice(0, index);
            const value = pair.slice(index + 1);
            if (!value || attributes.some((attribute) => /^max-age=0$/i.test(attribute))) this.cookies.delete(name);
            else this.cookies.set(name, value);
        }
    }
    header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
    guestCookieCount() { return [...this.cookies.keys()].filter((name) => name.startsWith('ploinky_guest')).length; } // legacy-guest-cookie-case (guest-name family prefix)
}

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

function makeRequest({ method = 'GET', url, cookie = '', body }) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
    req.method = method;
    req.url = url;
    req.headers = { accept: 'application/json', host: 'localhost', ...(cookie ? { cookie } : {}) };
    req.socket = { encrypted: false };
    return req;
}

const lease = { id: SNAPSHOT.generation, snapshot: SNAPSHOT, commit: () => true };
const controlPlan = { ok: false, kind: null, hostSelection: { kind: 'control', host: 'localhost' }, snapshot: SNAPSHOT, lease };
const mcpPlan = {
    ...controlPlan,
    ok: true,
    kind: 'agent-root',
    routeKey: 'webmeetAgent',
    upstreamPath: '/mcp',
    decision: { access: 'guest', routeKey: 'webmeetAgent', source: 'routeDefault' },
};
const ROOM_LOADER = {
    access: 'guest',
    routeKey: 'webmeetAgent',
    source: 'manifest',
    guestScope: 'webmeet:room',
    guestScopeParam: 'roomId',
};

async function roomPage(roomId, jar) {
    const req = makeRequest({ url: `/webmeetAgent/roomLoader.html?roomId=${roomId}`, cookie: jar.header() });
    const res = new MockResponse();
    const result = await authHandlers.ensureHttpRouteAccess(req, res, new URL(req.url, 'http://localhost'), ROOM_LOADER, { routePlan: controlPlan });
    jar.apply(res);
    return { req, res, result };
}

// Router admission for /webmeetAgent/mcp, then the real agent MCP handler with
// the admitted identity. `unknown` is answered by the Router itself (-32601)
// when the session is usable, without contacting an upstream agent.
async function mcp(jar, { session, rpc }) {
    const authReq = makeRequest({ method: 'POST', url: '/webmeetAgent/mcp', cookie: jar.header() });
    const authRes = new MockResponse();
    const admitted = await authHandlers.ensureAuthenticated(authReq, authRes, new URL(authReq.url, 'http://localhost'), { routePlan: mcpPlan });
    jar.apply(authRes);
    const req = makeRequest({ method: 'POST', url: '/webmeetAgent/mcp', cookie: jar.header(), body: { jsonrpc: '2.0', id: 1, method: rpc } });
    for (const field of ['user', 'session', 'sessionId', 'authMode', 'authChannel', 'edgeAuthContext']) {
        if (authReq[field] !== undefined) req[field] = authReq[field];
    }
    if (session) req.headers['mcp-session-id'] = session;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const res = {
        status: 0, headers: {}, body: '',
        writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
        end(body = '') { this.body = String(body); finish(); },
    };
    await handleAgentMcpRequest(req, res, { hostPort: 1 }, 'webmeetAgent', { routePlan: mcpPlan, waitForAgentReady: async () => true });
    await done;
    const json = res.body ? JSON.parse(res.body) : null;
    return {
        admitted: admitted.ok,
        userId: authReq.user?.id,
        gscope: authReq.session?._jwtPayload?.gscope,
        identityUser: authHandlers.buildIdentityHeaders(req)?.['X-Ploinky-User-Id'],
        sessionHeader: res.headers['mcp-session-id'],
        rpcCode: json?.error?.code ?? null,
        rpcMessage: json?.error?.message ?? null,
    };
}

test('KNOWN LIMITATION Q1: two WebMeet rooms on one guest route share one guest cookie, so room Y ends the room-X MCP session', async (t) => {
    const jar = new Jar();
    const observed = {};

    const pageX = await roomPage(ROOM_X, jar);
    observed.roomX = { ok: pageX.result.ok, userId: pageX.req.user?.id, gscope: pageX.req.session?._jwtPayload?.gscope };
    const init = await mcp(jar, { rpc: 'initialize' });
    const sessionX = init.sessionHeader;
    observed.initialize = { ...init, sameIdentityAsRoomX: init.userId === observed.roomX.userId };
    const before = await mcp(jar, { session: sessionX, rpc: 'unknown' });
    observed.roomXSessionBeforeRoomY = before;

    const pageY = await roomPage(ROOM_Y, jar);
    observed.roomY = {
        ok: pageY.result.ok,
        userId: pageY.req.user?.id,
        gscope: pageY.req.session?._jwtPayload?.gscope,
        replacedRoomXIdentity: pageY.req.user?.id !== observed.roomX.userId,
        guestCookiesInJar: jar.guestCookieCount(),
    };
    const after = await mcp(jar, { session: sessionX, rpc: 'unknown' });
    observed.roomXSessionAfterRoomY = { ...after, forwardedIdentityIsRoomY: after.identityUser === observed.roomY.userId };

    const pageXAgain = await roomPage(ROOM_X, jar);
    observed.roomXPageAgain = {
        ok: pageXAgain.result.ok,
        status: pageXAgain.res.statusCode,
        userId: pageXAgain.req.user?.id,
        sameAsOriginalRoomX: pageXAgain.req.user?.id === observed.roomX.userId,
        gscope: pageXAgain.req.session?._jwtPayload?.gscope,
    };
    const afterReturn = await mcp(jar, { session: sessionX, rpc: 'unknown' });
    observed.roomXSessionAfterReturningToRoomX = afterReturn;
    observed.sessionStillStored = agentSessionStore.has(sessionX);

    t.diagnostic(`Q1 observations: ${JSON.stringify(observed)}`);

    // Preconditions: both rooms admit a guest and room X opened a usable MCP session.
    assert.equal(observed.roomX.ok, true);
    assert.equal(observed.roomX.gscope, `webmeet:room:${ROOM_X}`);
    assert.ok(sessionX);
    assert.equal(observed.initialize.sameIdentityAsRoomX, true);
    assert.equal(before.rpcCode, -32601);
    assert.equal(observed.roomY.ok, true);
    assert.equal(observed.roomY.gscope, `webmeet:room:${ROOM_Y}`);

    // The limitation: one cookie per route, so room Y replaced the room-X identity...
    assert.equal(observed.roomY.guestCookiesInJar, 1);
    assert.equal(observed.roomY.replacedRoomXIdentity, true);
    // ...the Router admits the room-Y identity at /webmeetAgent/mcp and C1 refuses the room-X session...
    assert.equal(after.admitted, true);
    assert.equal(after.userId, observed.roomY.userId);
    assert.equal(observed.roomXSessionAfterRoomY.forwardedIdentityIsRoomY, true);
    assert.equal(after.rpcCode, -32000);
    assert.equal(after.rpcMessage, 'Missing or invalid MCP session');
    // ...and returning to room X mints a third identity; the old session stays refused.
    assert.equal(observed.roomXPageAgain.ok, true);
    assert.equal(observed.roomXPageAgain.sameAsOriginalRoomX, false);
    assert.equal(afterReturn.rpcCode, -32000);
});
