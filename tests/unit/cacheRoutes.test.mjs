import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { handleCacheRoutes } from '../../cli/server/authHandlers/cacheRoutes.mjs';
import { handleMarketplaceRoutes } from '../../cli/server/authHandlers/marketplaceRoutes.js';
import { authService, SSO_AUTH_COOKIE_NAME } from '../../cli/server/authHandlers/shared.js';
import { mintAdminCsrfToken, verifyAdminMutationRequest } from '../../cli/server/adminControlSecurity.js';
import { mintBrowserCsrfToken } from '../../cli/server/browserMutationSecurity.js';
import { isAdminUser } from '../../cli/server/auth/localService.js';
import { runCacheCommand } from '../../cli/commands/cacheCommands.js';
import { CACHE_OPERATOR_PATH } from '../../cli/commands/cacheOperatorAssertion.js';
import { handlePrivateCacheRequest } from '../../cli/server/privateRouter.js';
import { purgeCacheHost, readLastPurge } from '../../cli/server/cdn/cachePurge.js';
import { configureCachePurge, configuredCacheHosts } from '../../cli/server/cdn/cachePurgeConfig.js';
import { readCacheSettings, setCacheApplication } from '../../cli/server/cdn/cacheSettingsStore.js';

const oldKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
test.after(() => { if (oldKey === undefined) delete process.env.PLOINKY_MASTER_KEY; else process.env.PLOINKY_MASTER_KEY = oldKey; });

const path = '/api/marketplace/cache';
const url = new URL(path, 'http://localhost');
const agent = 'repo/pages';
const host = 'content.example.test';
const otherHost = 'other.example.test';
const since = '2026-11-23T12:00:00.000Z';
const mark = { agent, routes: [{ path: '/public', cache: 'page' }, { path: '/assets/*', cache: 'immutable' }] };
const set = { op: 'set', agent, enabled: true, pageSeconds: 120 };
const clear = { op: 'purge', host };
const admin = { id: 'admin-id', roles: ['admin'] };
const generation = { generation: 'generation-a', routing: { routes: { shell: { agent: 'shell', repo: 'repo' } } },
    agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: { mode: 'sso' } } }, manifests: {} };
const plan = { snapshot: generation, lease: { snapshot: generation, id: generation.generation, commit: () => true } };

function response() {
    return {
        writeHead(status, headers) { Object.assign(this, { status, headers }); },
        end(text) { this.body = JSON.parse(text); },
    };
}

function ensureAdmin(req, res) {
    if (isAdminUser(req.user)) return true;
    res.writeHead(req.user ? 403 : 401);
    res.end(JSON.stringify({ ok: false, error: req.user ? 'admin_required' : 'not_authenticated' }));
    return false;
}

function fixture() {
    const settings = { applications: {}, held: {} };
    const cleared = [];
    const options = {
        routePlan: plan, ensureAdmin, verifyMutation: req => ({ ok: req.proof === true }), readBody: req => req.body,
        listPublished: () => [host, otherHost], listConfigured: () => [host, 'retired.example.test'],
        listMarked: current => { assert.equal(current, generation); return [mark]; },
        readSettings: () => settings,
        setApplication: async (ref, value, { assertCurrent }) => {
            assertCurrent();
            const previous = settings.applications[ref] || { enabled: false, pageSeconds: 300 };
            settings.applications[ref] = value;
            return { settings, previous };
        },
        lastPurge: hostname => hostname === host ? { at: since, by: 'operator', outcome: 'accepted' } : null,
        purge: async ({ host, by, generation: current, assertCurrent }) => {
            assert.equal(current, generation);
            assertCurrent();
            cleared.push({ host, by, enabled: settings.applications[agent]?.enabled });
            return { host, outcome: 'cooldown', retryAfterSeconds: 14 };
        },
    };
    async function request(body, req = {}, overrides = {}) {
        const res = response();
        await handleCacheRoutes({ user: admin, proof: true, method: body === undefined ? 'GET' : 'POST', body, ...req },
            res, url, { ...options, ...overrides });
        return res;
    }
    return { settings, cleared, request };
}

test('cache GET returns the pinned application, marks, configured hosts and last purge projection', async () => {
    const f = fixture();
    const res = await f.request();
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body, {
        applications: [{ ...mark, enabled: false, pageSeconds: 300, held: null, hosts: [host] }],
        hosts: [{ host, purgeConfigured: true, lastPurge: { at: since, by: 'operator', outcome: 'accepted' } },
            { host: otherHost, purgeConfigured: false, lastPurge: null }],
    });
    f.settings.held[agent] = { since, by: 'operator' };
    assert.deepEqual((await f.request()).body.applications[0].held, { since, by: 'operator' });
});

test('cache GET and set report canary-only holds from the exact active selection', async () => {
    const snapshot = { ...generation, routing: { routes: { pages: { repo: 'repo', agent: 'pages', canary: null } } } };
    const lease = { id: snapshot.generation, activationId: 'active', snapshot, commit: () => true };
    const active = { state: 'active', generation: lease.id, activationId: lease.activationId, activatedAt: since };
    const options = { routePlan: { snapshot, lease }, listMarked: () => [mark], readSelection: () => ({ selector: active }) };
    const f = fixture();
    for (const body of [undefined, set]) {
        const res = await f.request(body, {}, options);
        assert.equal(res.status, 200);
        assert.deepEqual((body ? res.body.application : res.body.applications[0]).held, { since, by: 'canary' });
        for (const selector of [null, { ...active, state: 'inactive' }, { ...active, generation: 'other' },
            { ...active, activationId: 'earlier' }, { ...active, activatedAt: 'invalid' }]) {
            const bad = await f.request(body, {}, { ...options, readSelection: () => ({ selector }) });
            assert.equal(bad.status, 503);
        }
    }
    const manual = { since: '2026-11-22T10:00:00.000Z', by: 'operator' };
    f.settings.held[agent] = manual;
    const held = await f.request(undefined, {}, { ...options, readSelection: () => assert.fail('manual hold triggered a selector read') });
    assert.deepEqual(held.body.applications[0].held, manual);
});

test('a successful read, purge or setting response requires a final current lease', async () => {
    for (const body of [undefined, clear, set]) {
        let current = true;
        const routePlan = { ...plan, lease: { ...plan.lease, commit: () => current } };
        const res = await fixture().request(body, {}, {
            routePlan, lastPurge: () => { current = false; return null; },
            purge: () => { current = false; return { host, outcome: 'accepted' }; },
            setApplication: () => {
                current = false;
                return { previous: { enabled: false }, settings: { applications: {}, held: {} } };
            },
        });
        assert.equal(res.status, 503);
        assert.equal(res.body.error, 'edge_generation_changed');
    }
});

test('cache reads and writes require an administrator and a current lease; mutations also require proof', async () => {
    const { request, cleared } = fixture();
    for (const body of [undefined, clear, set]) {
        for (const [user, status] of [[null, 401], [{ roles: ['user'] }, 403], [{ roles: ['admin', 'guest'] }, 403]]) {
            assert.equal((await request(body, { user })).status, status);
        }
        const bearer = await request(body, { rawHeaders: ['Authorization', 'Basic first', 'Authorization', 'Bearer agent'] });
        assert.equal(bearer.body.error, 'agent_forbidden');
        for (const routePlan of [null, {}, { lease: { snapshot: generation } }, { ...plan, snapshot: {} },
            { lease: { snapshot: generation, commit: () => false } }]) {
            assert.equal((await request(body, {}, { routePlan })).status, 503);
        }
    }
    for (const body of [clear, set]) {
        assert.equal((await request(body, { proof: false })).status, 403);
        assert.equal((await request(body, { session: { expiresAt: Date.now() - 1 } })).status, 403);
    }
    assert.deepEqual(cleared, []);
});

test('only valid set and purge requests on marked applications and configured, published hosts are admitted', async () => {
    const { request, cleared, settings } = fixture();
    for (const body of [null, [], 'set', { ...set, enabled: 1 }, { ...set, pageSeconds: 61 },
        { ...set, agent: '' }, { ...set, extra: 1 }, { op: 'set', agent, enabled: true },
        { ...clear, host: '' }, { ...clear, admin: true }, { op: 'hold', agent }]) {
        const res = await request(body);
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { error: 'invalid_request' });
    }
    for (const unknown of [otherHost, 'retired.example.test', 'arbitrary.example.test']) {
        const res = await request({ ...clear, host: unknown });
        assert.equal(res.status, 404);
        assert.deepEqual(res.body, { error: 'unknown_host' });
    }
    const unknown = await request({ ...set, agent: 'repo/unmarked' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'unknown_application' });
    assert.deepEqual(cleared, []);
    assert.deepEqual(settings.applications, {});
});

test('switching off commits first, purges once per configured host and returns the pinned result', async () => {
    const { request, cleared } = fixture();
    const enabled = await request(set);
    assert.deepEqual(enabled.body, { application: { ...mark, enabled: true, pageSeconds: 120, held: null, hosts: [host] }, purges: [] });
    const off = { ...set, enabled: false, pageSeconds: 60 };
    assert.deepEqual((await request(off)).body, { application: { ...mark, enabled: false, pageSeconds: 60, held: null, hosts: [host] },
        purges: [{ host, outcome: 'cooldown' }] });
    assert.deepEqual((await request(off)).body.purges, []);
    assert.deepEqual(cleared, [{ host, by: admin.id, enabled: false }]);
    assert.deepEqual((await request(clear)).body, { purge: { host, outcome: 'cooldown', retryAfterSeconds: 14 } });
});

test('a queued settings or purge mutation rechecks the lease immediately before proceeding', async () => {
    for (const body of [set, clear]) {
        let current = true;
        let changed = false;
        const run = ({ assertCurrent }) => { current = false; assertCurrent(); changed = true; };
        const res = await fixture().request(body, {}, {
            routePlan: { lease: { snapshot: generation, commit: () => current } },
            setApplication: (_agent, _settings, options) => run(options), purge: run,
        });
        assert.equal(res.status, 503);
        assert.equal(changed, false);
    }
});

test('marketplace cache dispatch checks the session and the appropriate proof before reading the bounded body', async t => {
    t.mock.method(authService, 'isConfigured', () => true);
    t.mock.method(authService, 'validateSession', async id => ({ user: id === 'fixture' ? admin : { id: 'reader', roles: ['user'] } }));
    for (const routed of [true, false]) {
        const origin = routed ? 'https://shell.example.test' : 'http://localhost';
        const routePlan = routed ? { ...plan, ok: true, kind: 'router-surface', surface: 'marketplace-ui', listener: 'public',
            forwarding: { protocol: 'https', authority: 'shell.example.test' }, hostSelection: { kind: 'agent-root', record: { routeKey: 'shell' } } } : plan;
        for (const [sessionId, proof, body, status] of [['reader', true, '{', 403], ['fixture', false, '{', 403],
            ['fixture', true, '{', 400], ['fixture', true, ' '.repeat(16 * 1024) + JSON.stringify(clear), 400]]) {
            const req = Readable.from([Buffer.from(body)]);
            Object.assign(req, { method: 'POST', headers: { host: new URL(origin).host, origin, cookie: SSO_AUTH_COOKIE_NAME + '=' + sessionId } });
            if (proof && routed) req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({ req, routePlan, sessionId });
            if (proof && !routed) req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ req, sessionId });
            const res = response();
            assert.equal(await handleMarketplaceRoutes(req, res, url, { routePlan }), true);
            assert.equal(res.status, status, JSON.stringify(res.body));
            if (sessionId === 'reader') assert.equal(res.body.error, 'admin_required');
            if (status === 400) assert.deepEqual(res.body, { error: 'invalid_request' });
        }
    }
});

test('the operator clear command and the cache button share the same in-flight host cooldown', async t => {
    const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'cache-routes-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const snapshot = { generation: 'sha256:' + '1'.repeat(64), publicationState: 'ready', compiled: { hosts: { [host]: {} } },
        routing: { routes: { pages: { repo: 'repo', agent: 'pages' } } },
        manifests: { pages: { routerAccess: { httpRoutes: [{ path: '/public', access: 'public', cache: 'page' }] } } } };
    const lease = { id: snapshot.generation, snapshot, activationId: randomUUID(), commit: () => true };
    configureCachePurge({ host, zoneId: '1'.repeat(32), secretHandle: 'publication/cache' },
        { dataDir, loadActive: () => ({ generation: snapshot }), hasHandle: () => true, withLock: callback => callback() });
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    let calls = 0;
    const purge = input => purgeCacheHost(input, {
        dataDir, now: () => 1000, readToken: () => 'test', api: {
            purgeHosts: async ({ hosts }) => {
                assert.deepEqual(hosts, [host]);
                calls++;
                started.resolve();
                await finish.promise;
            },
        },
    });
    const browser = async body => {
        const req = { method: 'POST', user: admin, sessionId: 'fixture', headers: { host: 'localhost', origin: 'http://localhost' } };
        req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ req, sessionId: req.sessionId });
        const res = response();
        await handleCacheRoutes(req, res, url, {
            routePlan: { snapshot, lease }, ensureAdmin, verifyMutation: verifyAdminMutationRequest, readBody: () => body,
            listConfigured: generation => configuredCacheHosts(generation, { dataDir }),
            setApplication: (agent, value, options) => setCacheApplication(agent, value, { ...options, dataDir }), purge,
        });
        return res;
    };
    assert.equal((await browser(set)).status, 200);
    assert.deepEqual(readCacheSettings({ dataDir }).applications[agent], { enabled: true, pageSeconds: 120 });
    const pending = browser(clear);
    await Promise.race([started.promise, pending.then(res => assert.fail('purge did not reach the API: ' + res.status))]);
    const request = (options, respond) => Object.assign(new EventEmitter(), {
        async end(body) {
            const req = Object.assign(Readable.from([body]), { method: options.method, headers: options.headers, url: options.path,
                socket: { remoteAddress: '127.0.0.1' }, ploinkyListenerClass: 'private' });
            const plan = { snapshot, lease, ok: true, kind: 'private-operation', operation: 'cache', listener: 'private', pathname: CACHE_OPERATOR_PATH };
            const res = { writeHead(status) { this.status = status; }, end(chunk) { respond(Object.assign(Readable.from([chunk]), { statusCode: this.status })); } };
            await handlePrivateCacheRequest({ req, res, plan, purge });
        },
    });
    try {
        await assert.rejects(runCacheCommand(['clear', '--host', host], { captureLease: () => lease, request, report: assert.fail }), /cooldown/);
        assert.equal(readLastPurge(host, { dataDir }).outcome, 'cooldown');
    } finally {
        finish.resolve();
    }
    assert.deepEqual((await pending).body, { purge: { host, outcome: 'accepted' } });
    assert.equal(readLastPurge(host, { dataDir }).by, admin.id);
    assert.equal(calls, 1);
});

test('an unreadable purge configuration never blocks the switch: set writes first and GET reports no configured host', async t => {
    const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'cache-routes-unreadable-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const content = 'not-json-' + randomUUID();
    fs.writeFileSync(join(dataDir, 'cache-purge.json'), content);
    const snapshot = { generation: 'sha256:' + '2'.repeat(64), publicationState: 'ready', compiled: { hosts: { [host]: {} } },
        routing: { routes: { pages: { repo: 'repo', agent: 'pages' } } },
        manifests: { pages: { routerAccess: { httpRoutes: [{ path: '/public', access: 'public', cache: 'page' }] } } } };
    const lease = { id: snapshot.generation, snapshot, activationId: randomUUID(), commit: () => true };
    const warnings = [];
    const warn = console.warn;
    console.warn = (...parts) => warnings.push(parts.join(' '));
    t.after(() => { console.warn = warn; });
    const call = async body => {
        const res = response();
        await handleCacheRoutes({ user: admin, proof: true, method: body === undefined ? 'GET' : 'POST', body }, res, url, {
            routePlan: { snapshot, lease }, ensureAdmin, verifyMutation: req => ({ ok: req.proof === true }), readBody: req => req.body,
            listConfigured: generation => configuredCacheHosts(generation, { dataDir }),
            readSettings: () => readCacheSettings({ dataDir }), lastPurge: () => null,
            setApplication: (ref, value, options) => setCacheApplication(ref, value, { ...options, dataDir }),
            purge: () => assert.fail('an unreadable purge configuration has no host to purge'),
        });
        return res;
    };
    const on = await call(set);
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.purges, []);
    const off = await call({ ...set, enabled: false });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { application: { ...mark, routes: [mark.routes[0]], enabled: false, pageSeconds: 120, held: null, hosts: [] },
        purges: [] });
    assert.deepEqual(readCacheSettings({ dataDir }).applications[agent], { enabled: false, pageSeconds: 120 });
    const read = await call();
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.applications.map(entry => entry.hosts), [[]]);
    assert.deepEqual(read.body.hosts, [{ host, purgeConfigured: false, lastPurge: null }]);
    // A purge request still needs a readable configuration.
    assert.deepEqual((await call(clear)).body, { error: 'cache_unavailable' });
    assert.deepEqual(warnings, ['cache_purge_config_unreadable']);
    assert.ok(!warnings.join('').includes(content));
});
