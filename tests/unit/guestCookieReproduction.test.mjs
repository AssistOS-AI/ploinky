// Reproduction of the cross-route guest identity overwrite.
//
// An anonymous visitor uses two guest routes in one cookie jar: webAssist, then
// a guestAgent meeting-room page. Replaying the whole jar at webAssist must keep
// the first webAssist identity, so the MCP session owner bound to it still
// matches. With a single shared guest cookie the second mint overwrote the
// first identity and the owner check refused the webAssist MCP session.
//
// This file deliberately imports only modules that also exist before the
// per-route guest cookie change, and it inlines its cookie jar and the expected
// webAssist cookie name, so at an older revision it fails on behaviour rather
// than on a missing import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const WEBASSIST_GUEST_COOKIE = 'ploinky_guest_ncGyyzpdIxmPjORN_wQfqv';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ploinky-guest-repro-')));
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
        webAssist: { type: 'agent', agentName: 'webAssist', repoName: 'webassist', auth: { mode: 'guest' } },
        guestAgent: { type: 'agent', agentName: 'guestAgent', repoName: 'services', auth: { mode: 'none' } },
    };
    const routing = {
        routes: {
            explorer: { agent: 'explorer', repo: 'AchillesIDE', hostPort: 55289 },
            webAssist: { agent: 'webAssist', repo: 'webassist', hostPort: 53659 },
            guestAgent: { agent: 'guestAgent', repo: 'services', hostPort: 43111 },
        },
        static: { agent: 'explorer', hostPath: '/tmp/explorer' },
    };
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify(agents, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify(routing, null, 2));
    return { agents, routing };
}

const fixture = writeWorkspace();
process.chdir(root);
process.env.PLOINKY_WORKSPACE_ROOT = root;
process.env.PLOINKY_MASTER_KEY = '4'.repeat(64);

const authHandlers = await import('../../cli/server/authHandlers/index.js');
const { createMcpSessionOwner } = await import('../../cli/server/mcp-proxy/sessionOwnership.mjs');

test.after(() => {
    process.chdir(previous.cwd);
    for (const [name, value] of [['PLOINKY_WORKSPACE_ROOT', previous.root], ['PLOINKY_MASTER_KEY', previous.key]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
});

// Inline browser cookie jar: applies Set-Cookie by name and removes on Max-Age=0.
class Jar {
    constructor() { this.cookies = new Map(); }
    apply(res) {
        for (const line of [res.getHeader('set-cookie')].flat().filter(Boolean).map(String)) {
            const [pair, ...attributes] = line.split(';').map((part) => part.trim());
            const index = pair.indexOf('=');
            const name = pair.slice(0, index);
            const value = pair.slice(index + 1);
            const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute));
            if (expired || !value) this.cookies.delete(name);
            else this.cookies.set(name, value);
        }
    }
    header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
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

function makeRequest({ method = 'GET', url, cookie = '' }) {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.headers = { accept: 'application/json', host: 'localhost', ...(cookie ? { cookie } : {}) };
    req.socket = { encrypted: false };
    return req;
}

function routePlan(decision = null) {
    const snapshot = {
        generation: 'guest-repro-generation',
        routing: fixture.routing,
        agents: fixture.agents,
        manifests: {},
    };
    return {
        ok: false,
        kind: null,
        hostSelection: { kind: 'control', host: 'localhost' },
        snapshot,
        lease: { id: snapshot.generation, snapshot, commit: () => true },
        ...(decision ? { decision } : {}),
    };
}

const WEBASSIST_DECISION = { access: 'guest', routeKey: 'webAssist', source: 'routeDefault' };
const MEETING_ROOM_DECISION = {
    access: 'guest',
    routeKey: 'guestAgent',
    source: 'manifest',
    guestScope: 'meeting-room-public-service',
};

test('a second guest route in the same jar does not replace the webAssist guest identity', async () => {
    const jar = new Jar();

    const req1 = makeRequest({ method: 'POST', url: '/webAssist/mcp' });
    const res1 = new MockResponse();
    const first = await authHandlers.ensureAuthenticated(req1, res1, new URL(req1.url, 'http://localhost'), {
        routePlan: routePlan(WEBASSIST_DECISION),
    });
    assert.equal(first.ok, true);
    assert.equal(req1.authMode, 'guest');
    assert.equal(req1.session?._jwtPayload?.groute, 'webAssist');
    const owner1 = createMcpSessionOwner(req1, 'agent', 'webAssist');
    assert.ok(owner1);
    jar.apply(res1);

    const req2 = makeRequest({ url: '/guestAgent/meeting-room/example', cookie: jar.header() });
    const res2 = new MockResponse();
    const second = await authHandlers.ensureHttpRouteAccess(
        req2,
        res2,
        new URL(req2.url, 'http://localhost'),
        MEETING_ROOM_DECISION,
        { routePlan: routePlan() },
    );
    assert.equal(second.ok, true);
    assert.equal(req2.authMode, 'guest');
    assert.equal(req2.session?._jwtPayload?.groute, 'guestAgent');
    assert.notEqual(req2.user?.id, req1.user?.id);
    jar.apply(res2);

    const req3 = makeRequest({ method: 'POST', url: '/webAssist/mcp', cookie: jar.header() });
    const res3 = new MockResponse();
    const third = await authHandlers.ensureAuthenticated(req3, res3, new URL(req3.url, 'http://localhost'), {
        routePlan: routePlan(WEBASSIST_DECISION),
    });
    assert.equal(third.ok, true);
    assert.equal(req3.user?.id, req1.user?.id, 'the webAssist replay keeps the first req.user.id');
    assert.deepEqual(createMcpSessionOwner(req3, 'agent', 'webAssist'), owner1);
    const setCookies = [res3.getHeader('set-cookie')].flat().filter(Boolean).map(String);
    assert.equal(setCookies.some((line) => line.startsWith(`${WEBASSIST_GUEST_COOKIE}=`)), false);
});
