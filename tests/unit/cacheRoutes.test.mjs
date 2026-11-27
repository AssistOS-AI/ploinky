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
import { readCacheSettings, setCacheApplication, setCacheHold, setCacheRoute } from '../../cli/server/cdn/cacheSettingsStore.js';
import { checkCacheRoute, takeCheckSlot } from '../../cli/server/cdn/cacheCheck.js';

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
const routeBody = { op: 'route', agent, path: '/pages/public', setting: 'off' };
const checkBody = { op: 'check', agent, path: '/pages/public' };
const admin = { id: 'admin-id', roles: ['admin'] };
const generation = { generation: 'generation-a',
    routing: { routes: { shell: { agent: 'shell', repo: 'repo' }, pages: { agent: 'pages', repo: 'repo' } } },
    agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: { mode: 'sso' } } },
    manifests: { pages: { routerAccess: { httpRoutes: [
        { path: '/public', access: 'public', cache: 'page' }, { path: '/assets/*', access: 'public', cache: 'immutable' },
    ] } } } };
// What every listed route reports when the application is off and holds no administrator setting.
const baseRows = [
    { path: '/pages/public', manifest: 'page', effective: 'page', source: 'manifest', choices: ['off'] },
    { path: '/pages/assets/*', manifest: 'immutable', effective: 'immutable', source: 'manifest', choices: ['off'] },
].map(row => ({ neverBy: null, publicProtocol: false, setting: null, stale: false, cdnHeader: 'no-store', checkable: false, ...row }));
const publicRoutes = { adminChoices: false, publicRoutes: baseRows };
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
        applications: [{ ...mark, ...publicRoutes, enabled: false, pageSeconds: 300, held: null, hosts: [host] }],
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
    for (const body of [undefined, clear, set, routeBody, checkBody]) {
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
    for (const body of [clear, set, routeBody, checkBody]) {
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
    const cdn = ['max-age=120, stale-if-error=900', 'max-age=31536000'];
    const enabledRows = baseRows.map((row, index) => ({ ...row, cdnHeader: cdn[index] }));
    assert.deepEqual(enabled.body, { application: { ...mark, adminChoices: false, publicRoutes: enabledRows, enabled: true,
        pageSeconds: 120, held: null, hosts: [host] }, purges: [] });
    const off = { ...set, enabled: false, pageSeconds: 60 };
    assert.deepEqual((await request(off)).body, { application: { ...mark, ...publicRoutes, enabled: false, pageSeconds: 60, held: null,
        hosts: [host] }, purges: [{ host, outcome: 'cooldown' }] });
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
            planRequest: () => ({ ok: false }), listConfigured: generation => configuredCacheHosts(generation, { dataDir }),
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
            listConfigured: generation => configuredCacheHosts(generation, { dataDir }), planRequest: () => ({ ok: false }),
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
    assert.deepEqual(off.body, { application: { ...mark, adminChoices: false, publicRoutes: [baseRows[0]], routes: [mark.routes[0]],
        enabled: false, pageSeconds: 120,
        held: null, hosts: [] }, purges: [] });
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

// Administrator route choices and live checks, on real manifests and the real settings store.
const site = 'repo/site';
const setSite = { ...set, agent: site };
const portBase = '/base-agent-additional-server/site/8787';
const adminGeneration = {
    generation: 'generation-admin',
    routing: { routes: { site: { repo: 'repo', agent: 'site' }, plain: { repo: 'repo', agent: 'plain' },
        quiet: { repo: 'repo', agent: 'quiet' } } },
    compiled: { hosts: { [host]: { rootApplication: { routeKey: 'site', port: 8787, agent: site } }, [otherHost]: {} } },
    manifests: {
        site: { routerAccess: { httpRoutes: [
            { path: '/page', access: 'public', cache: 'page' },
            { path: '/asset/*', access: 'public', cache: 'immutable' },
            { path: '/login/', access: 'public', cache: 'never' },
            { path: '/docs/*', access: 'public', cache: 'never' },
            { path: '/docs/a', access: 'public', cache: 'page' },
            { path: '/static/*', access: 'public' },
            { path: '/plain', access: 'public' },
            { path: '/private', access: 'authenticated' },
            { path: portBase + '/svc/*', access: 'public', publicProtocol: { methods: ['POST'] } },
            { path: portBase + '/info', access: 'public' },
        ] } },
        plain: { routerAccess: { httpRoutes: [{ path: '/p', access: 'public', cache: 'page' }, { path: '/free', access: 'public' }] } },
        quiet: { routerAccess: { httpRoutes: [{ path: '/n/*', access: 'public', cache: 'never' }] } },
    },
};
const adminLease = { snapshot: adminGeneration, id: adminGeneration.generation, commit: () => true };

function adminFixture(t) {
    const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'cache-routes-admin-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const purged = [];
    const checked = [];
    const clock = { now: 0 };
    const planned = [];
    let checkError;
    const options = {
        routePlan: { snapshot: adminGeneration, lease: adminLease }, ensureAdmin, verifyMutation: req => ({ ok: req.proof === true }),
        readBody: req => req.body, listPublished: () => [host, otherHost], listConfigured: () => [host, otherHost],
        readSettings: () => readCacheSettings({ dataDir }), lastPurge: () => null,
        setApplication: (ref, value, opts) => setCacheApplication(ref, value, { ...opts, dataDir }),
        setRoute: (ref, route, record, opts) => setCacheRoute(ref, route, record, { ...opts, dataDir }),
        purge: async ({ host: name }) => { purged.push(name); return { host: name, outcome: 'accepted' }; },
        // The plans the Router resolves: the root host maps a port-mounted path to its suffix.
        planRequest: ({ req }) => {
            planned.push([req.headers.host, req.url]);
            if (req.headers.host !== host) return { ok: false };
            const mounted = req.url.startsWith('/site/') ? req.url : portBase + req.url;
            return { ok: true, kind: req.url.startsWith('/site/') ? 'agent-root' : 'agent-port', routeKey: 'site',
                canonicalPath: mounted, decision: { access: 'public' } };
        },
        checkOrigin: async target => {
            checked.push(target);
            if (checkError) throw checkError;
            return { status: 200, cdnHeader: 'no-store', cacheControl: 'no-cache' };
        },
        checkSlot: session => takeCheckSlot(session, () => clock.now),
    };
    let sessions = 0;
    async function request(body, req = {}, overrides = {}) {
        const res = response();
        await handleCacheRoutes({ user: admin, proof: true, sessionId: 'session-' + ++sessions, method: body === undefined ? 'GET' : 'POST',
            body, ...req }, res, url, { ...options, ...overrides });
        return res;
    }
    const read = () => readCacheSettings({ dataDir });
    const app = ref => async () => (await request()).body.applications.find(entry => entry.agent === ref);
    return { dataDir, purged, checked, clock, planned, request, read, site: app(site),
        failCheck: error => { checkError = error; }, file: join(dataDir, 'cache-settings.json') };
}

const row = (application, routePath) => application.publicRoutes.find(entry => entry.path === routePath && !entry.stale);
const route = (setting, path, ref = site) => ({ op: 'route', agent: ref, path, setting });

test('GET lists every public entry with its mark, class, source, CDN header and choices; routes never lists never', async t => {
    const f = adminFixture(t);
    let application = await f.site();
    assert.deepEqual(application.routes, [{ path: '/page', cache: 'page' }, { path: '/asset/*', cache: 'immutable' },
        { path: '/docs/a', cache: 'page' }]);
    assert.equal(application.adminChoices, true);
    assert.deepEqual(application.publicRoutes.map(entry => entry.path), ['/site/page', '/site/asset/*', '/site/login/', '/site/docs/*',
        '/site/docs/a', '/site/static/*', '/site/plain', portBase + '/svc/*', portBase + '/info']);
    const expected = {
        '/site/page': { manifest: 'page', effective: 'page', source: 'manifest', choices: ['off'], checkable: true },
        '/site/asset/*': { manifest: 'immutable', effective: 'immutable', source: 'manifest', choices: ['off'], checkable: false },
        '/site/login/': { manifest: 'never', effective: null, source: 'never', choices: [], checkable: true },
        '/site/docs/*': { manifest: 'never', effective: null, source: 'never', choices: [], checkable: false },
        '/site/docs/a': { manifest: 'page', neverBy: '/site/docs/*', effective: null, source: 'never', choices: [], checkable: true },
        '/site/static/*': { manifest: null, effective: null, source: null, choices: ['page'], checkable: false },
        '/site/plain': { manifest: null, effective: null, source: null, choices: ['page'], checkable: true },
        [portBase + '/svc/*']: { manifest: null, publicProtocol: true, effective: null, source: null, choices: [], checkable: false },
        [portBase + '/info']: { manifest: null, effective: null, source: null, choices: ['page'], checkable: true },
    };
    for (const [path, fields] of Object.entries(expected)) {
        assert.deepEqual(row(application, path), { path, neverBy: null, publicProtocol: false, setting: null, stale: false,
            cdnHeader: 'no-store', ...fields }, path);
    }
    const plain = (await f.request()).body.applications.find(entry => entry.agent === 'repo/plain');
    assert.equal(plain.adminChoices, false);
    assert.deepEqual(plain.publicRoutes.map(entry => [entry.path, entry.choices]), [['/plain/p', ['off']], ['/plain/free', []]]);
    assert.deepEqual((await f.request()).body.applications.find(entry => entry.agent === 'repo/quiet').routes, []);

    // With the switch on the headers follow the application settings; a never row stays no-store.
    await f.request(setSite);
    application = await f.site();
    assert.deepEqual(['/site/page', '/site/asset/*', '/site/docs/a'].map(path => row(application, path).cdnHeader),
        ['max-age=120, stale-if-error=900', 'max-age=31536000', 'no-store']);
    await f.request(route('page', '/site/static/*'));
    application = await f.site();
    const chosen = row(application, '/site/static/*');
    assert.equal(chosen.effective, 'page');
    assert.equal(chosen.source, 'administrator');
    assert.equal(chosen.cdnHeader, 'max-age=120, stale-if-error=900');
    assert.deepEqual(chosen.choices, ['default']);
    assert.deepEqual(Object.keys(chosen.setting).sort(), ['at', 'by', 'setting']);
    assert.equal(chosen.setting.by, admin.id);
    await setCacheHold(site, { since, by: 'operator' }, { dataDir: f.dataDir });
    application = await f.site();
    assert.equal(row(application, '/site/static/*').cdnHeader, 'no-store', 'a held page is not cached');
    assert.equal(row(application, '/site/asset/*').cdnHeader, 'max-age=31536000', 'a hold keeps immutable files');
    await setCacheHold(site, null, { dataDir: f.dataDir });

    // Stale choices: a mark that changed, an entry that is gone. Each gets its own row; the entry keeps its normal row.
    const record = (setting, manifest) => ({ setting, at: since, by: 'older', entry: { access: 'public', manifest } });
    await setCacheRoute(site, '/site/plain', record('page', 'page'), { dataDir: f.dataDir });
    await setCacheRoute(site, '/site/gone', record('off', 'immutable'), { dataDir: f.dataDir });
    application = await f.site();
    assert.deepEqual(row(application, '/site/plain').choices, ['default']);
    assert.equal(row(application, '/site/plain').setting, null);
    const staleRows = application.publicRoutes.filter(entry => entry.stale);
    assert.deepEqual(staleRows.map(entry => entry.path), ['/site/gone', '/site/plain']);
    assert.deepEqual(staleRows[0], { path: '/site/gone', manifest: null, neverBy: null, publicProtocol: false,
        setting: { setting: 'off', at: since, by: 'older' }, stale: true, effective: null, source: null, cdnHeader: 'no-store',
        choices: ['default'], checkable: false });
    assert.equal(staleRows[1].manifest, null);
    assert.equal(application.publicRoutes.length, 9 + 2);
});

test('route accepts only what the manifest marks allow and answers each refusal with its own code', async t => {
    const f = adminFixture(t);
    const refuse = async (body, status, error) => {
        const res = await f.request(body);
        assert.deepEqual([res.status, res.body], [status, { error }], JSON.stringify(body));
    };
    for (const setting of ['off', 'page', 'default']) await refuse(route(setting, '/site/page', 'repo/none'), 404, 'unknown_application');
    for (const setting of ['off', 'page']) await refuse(route(setting, '/site/nope'), 404, 'unknown_route');
    await refuse(route('off', '/site/private'), 404, 'unknown_route');
    for (const [setting, path] of [['off', '/site/login/'], ['page', '/site/login/'], ['off', '/site/docs/a'], ['page', '/site/docs/*'],
        ['off', '/site/docs/*']]) await refuse(route(setting, path), 400, 'route_never');
    await refuse(route('page', '/site/page'), 400, 'route_marked');
    await refuse(route('page', '/site/asset/*'), 400, 'route_marked');
    await refuse(route('off', '/site/plain'), 400, 'route_uncached');
    await refuse(route('off', '/site/static/*'), 400, 'route_uncached');
    await refuse(route('page', portBase + '/svc/*'), 400, 'route_not_choosable');
    await refuse(route('page', '/plain/free', 'repo/plain'), 400, 'route_not_choosable');
    await refuse(route('page', '/n/x', 'repo/quiet'), 404, 'unknown_route');
    for (const body of [{ op: 'route', agent: site, path: '/site/page' }, { ...route('off', '/site/page'), extra: 1 },
        route('immutable', '/site/page'), route('off', 'site/page'), route('off', ''), route('off', '/site/\n'),
        route('off', '/' + 'x'.repeat(512)), route('off', 7), { ...route('off', '/site/page'), agent: '' },
        { op: 'check', agent: site }, { ...checkBody, extra: 1 }, { ...checkBody, path: 'site/page' }]) {
        await refuse(body, 400, 'invalid_request');
    }
    assert.equal(fs.existsSync(f.file), false, 'a refusal writes nothing');
    assert.deepEqual(f.purged, []);
    // The accepted forms store the entry the choice was made on.
    const off = await f.request(route('off', '/site/page'));
    assert.equal(off.status, 200);
    assert.deepEqual(row(off.body.application, '/site/page').setting.setting, 'off');
    assert.deepEqual(f.read().routes[site]['/site/page'].entry, { access: 'public', manifest: 'page' });
    assert.equal((await f.request(route('page', '/site/static/*'))).status, 200);
    assert.deepEqual(f.read().routes[site]['/site/static/*'].entry, { access: 'public', manifest: null });
    // Off needs a class to switch off: a route that is already off is refused.
    await refuse(route('off', '/site/page'), 400, 'route_uncached');
    assert.equal((await f.request(route('page', portBase + '/info'))).status, 200);
    // An administrator page is a class too: off replaces that choice.
    const replaced = await f.request(route('off', '/site/static/*'));
    assert.equal(replaced.status, 200);
    assert.deepEqual([row(replaced.body.application, '/site/static/*').setting.setting, row(replaced.body.application, '/site/static/*').effective],
        ['off', null]);
    await refuse(route('off', '/site/static/*'), 400, 'route_uncached');
});

test('default always succeeds for a listed application, bound, stale or missing, and answers 404 only for an unknown one', async t => {
    const f = adminFixture(t);
    const record = (setting, manifest) => ({ setting, at: since, by: 'older', entry: { access: 'public', manifest } });
    await f.request(setSite);
    assert.equal((await f.request(route('default', '/site/page'))).status, 200);
    assert.equal(fs.existsSync(f.file), true);
    const before = fs.readFileSync(f.file, 'utf8');
    const missing = await f.request(route('default', '/site/page'));
    assert.deepEqual([missing.status, missing.body.purges], [200, []]);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before, 'removing a missing choice writes nothing');
    await setCacheRoute(site, '/site/gone', record('page', null), { dataDir: f.dataDir });
    await setCacheRoute(site, '/site/page', record('page', 'immutable'), { dataDir: f.dataDir });
    for (const path of ['/site/gone', '/site/page', '/site/login/', '/site/docs/a', '/site/never-existed']) {
        const res = await f.request(route('default', path));
        assert.equal(res.status, 200, path);
        assert.deepEqual(res.body.purges, [], path);
    }
    assert.equal(f.read().routes, undefined);
    assert.equal((await f.request(route('default', '/site/page', 'repo/none'))).status, 404);
    assert.deepEqual(f.purged, []);
});

test('purges follow one rule: only a write that removes caching, only when something could have been cached', async t => {
    const choice = (setting, manifest) => ({ setting, at: since, by: 'older', entry: { access: 'public', manifest } });
    const hold = f => setCacheHold(site, { since, by: 'operator' }, { dataDir: f.dataDir });
    const cases = [
        // [label, prepare, request, hosts purged]
        ['off on a manifest page, switch on', async f => f.request(setSite), route('off', '/site/page'), [host, otherHost]],
        ['off on a manifest page, switch off', async () => {}, route('off', '/site/page'), []],
        ['off on a manifest page, application held', async f => { await f.request(setSite); await hold(f); }, route('off', '/site/page'), []],
        ['off on an immutable file, application held', async f => { await f.request(setSite); await hold(f); }, route('off', '/site/asset/*'), [host, otherHost]],
        ['an administrator page adds caching', async f => f.request(setSite), route('page', '/site/static/*'), []],
        ['default removes a bound administrator page', async f => {
            await f.request(setSite); await f.request(route('page', '/site/static/*'));
        }, route('default', '/site/static/*'), [host, otherHost]],
        ['default removes an administrator page, application held', async f => {
            await f.request(setSite); await f.request(route('page', '/site/static/*')); await hold(f);
        }, route('default', '/site/static/*'), []],
        ['default removes an administrator page, switch off', async f => {
            await f.request(route('page', '/site/static/*'));
        }, route('default', '/site/static/*'), []],
        ['default removes an off choice', async f => { await f.request(setSite); await f.request(route('off', '/site/page')); },
            route('default', '/site/page'), []],
        ['default removes a stale choice', async f => {
            await f.request(setSite); await setCacheRoute(site, '/site/static/*', choice('page', 'page'), { dataDir: f.dataDir });
        }, route('default', '/site/static/*'), []],
        ['default with nothing to remove', async f => f.request(setSite), route('default', '/site/static/*'), []],
        ['switching off with cacheable routes', async f => f.request(setSite), { ...setSite, enabled: false }, [host, otherHost]],
        ['switching off while held keeps the immutable files', async f => { await f.request(setSite); await hold(f); },
            { ...setSite, enabled: false }, [host, otherHost]],
        ['changing only the minutes', async f => f.request(setSite), { ...setSite, pageSeconds: 60 }, []],
        ['switching off when already off', async () => {}, { ...setSite, enabled: false }, []],
        ['switching off when every page is switched off', async f => {
            await f.request(setSite); await f.request(route('off', '/site/page')); await f.request(route('off', '/site/asset/*'));
        }, { ...setSite, enabled: false }, []],
        ['switching off an application with only pages while held', async f => {
            await f.request({ ...set, agent: 'repo/plain' }); await setCacheHold('repo/plain', { since, by: 'operator' }, { dataDir: f.dataDir });
        }, { ...set, agent: 'repo/plain', enabled: false }, []],
        ['switching off an application with only pages', async f => f.request({ ...set, agent: 'repo/plain' }),
            { ...set, agent: 'repo/plain', enabled: false }, [host, otherHost]],
        ['switching off an application with only never marks', async f => f.request({ ...set, agent: 'repo/quiet' }),
            { ...set, agent: 'repo/quiet', enabled: false }, []],
    ];
    for (const [label, prepare, body, hosts] of cases) {
        const f = adminFixture(t);
        await prepare(f);
        f.purged.length = 0;
        const res = await f.request(body);
        assert.equal(res.status, 200, label + ' ' + JSON.stringify(res.body));
        assert.deepEqual(f.purged, hosts, label);
        assert.deepEqual(res.body.purges.map(entry => entry.host), hosts, label);
    }
});

test('check maps a route to its published host and path, refuses wildcards and unknown routes, and is limited per session', async t => {
    const f = adminFixture(t);
    const ask = (path, req, ref = site) => f.request({ op: 'check', agent: ref, path }, req);
    const ok = await ask('/site/page', { sessionId: 'a' });
    assert.deepEqual([ok.status, ok.body], [200, { check: { host, path: '/site/page', status: 200, cdnHeader: 'no-store', cacheControl: 'no-cache' } }]);
    assert.deepEqual(f.checked, [{ host, path: '/site/page', publicPort: 8080 }]);
    // A root-application route is requested at its suffix on the root host.
    f.clock.now = 5000;
    const root = await ask(portBase + '/info', { sessionId: 'a' });
    assert.deepEqual(root.body.check, { host, path: '/info', status: 200, cdnHeader: 'no-store', cacheControl: 'no-cache' });
    assert.deepEqual(f.checked.at(-1), { host, path: '/info', publicPort: 8080 });
    // Never rows can be checked too.
    assert.equal((await ask('/site/login/', { sessionId: 'b' })).status, 200);
    // Refusals do not reach the origin and do not use up the session's slot.
    const calls = f.checked.length;
    f.clock.now = 10000;
    for (const [path, status, error, ref] of [['/site/static/*', 400, 'wildcard_path'], ['/site/nope', 404, 'unknown_route'],
        ['/site/private', 404, 'unknown_route'], ['/site/page', 404, 'unknown_route', 'repo/none'],
        [portBase + '/svc/*', 400, 'wildcard_path']]) {
        const res = await ask(path, { sessionId: 'c' }, ref);
        assert.deepEqual([res.status, res.body], [status, { error }], path);
    }
    assert.equal(f.checked.length, calls);
    // No published host reaches the route.
    const none = await f.request({ op: 'check', agent: site, path: '/site/page' }, { sessionId: 'c' },
        { listPublished: () => [otherHost] });
    assert.deepEqual([none.status, none.body], [409, { error: 'no_published_host' }]);
    const empty = await f.request({ op: 'check', agent: site, path: '/site/page' }, { sessionId: 'c' }, { listPublished: () => [] });
    assert.equal(empty.status, 409);
    assert.equal(f.checked.length, calls);
    // One check per second per session.
    assert.equal((await ask('/site/page', { sessionId: 'c' })).status, 200);
    f.clock.now = 10999;
    const limited = await ask('/site/page', { sessionId: 'c' });
    assert.deepEqual([limited.status, limited.body], [429, { error: 'rate_limited', retryAfterSeconds: 1 }]);
    assert.equal((await ask('/site/page', { sessionId: 'other' })).status, 200);
    f.clock.now = 11000;
    assert.equal((await ask('/site/page', { sessionId: 'c' })).status, 200);
    // An origin failure is an unavailable cache, and nothing is ever written by a check.
    f.clock.now = 20000;
    f.failCheck(new Error('socket closed'));
    const failed = await ask('/site/page', { sessionId: 'd' });
    assert.deepEqual([failed.status, failed.body], [503, { error: 'cache_unavailable' }]);
    assert.equal(fs.existsSync(f.file), false);
    assert.deepEqual(f.purged, []);
});

test('the live check asks HEAD without a cookie, falls back to GET, and the session limit has one slot per second', async () => {
    const seen = [];
    const answers = { HEAD: { statusCode: 200, headers: { 'cloudflare-cdn-cache-control': 'max-age=1', 'cache-control': 'no-cache' } },
        GET: { statusCode: 200, headers: { 'cloudflare-cdn-cache-control': 'no-store' } } };
    const request = (options, callback) => {
        seen.push(options);
        const req = new EventEmitter();
        req.end = () => callback({ ...answers[options.method], destroy() {} });
        return req;
    };
    const target = { host, path: '/info/' };
    assert.deepEqual(await checkCacheRoute(target, request),
        { status: 200, cdnHeader: 'max-age=1', cacheControl: 'no-cache' });
    assert.deepEqual(seen.map(options => options.method), ['HEAD']);
    for (const status of [404, 405, 501]) {
        seen.length = 0;
        answers.HEAD = { statusCode: status, headers: {} };
        assert.deepEqual(await checkCacheRoute(target, request), { status: 200, cdnHeader: 'no-store', cacheControl: null }, String(status));
        assert.deepEqual(seen.map(options => options.method), ['HEAD', 'GET']);
    }
    for (const options of seen) {
        assert.equal(options.hostname, '127.0.0.1');
        assert.equal(options.port, 8080);
        assert.equal(options.path, '/info/');
        assert.deepEqual(options.headers, { host });
    }
    answers.HEAD = { statusCode: 301, headers: { location: '/x' } };
    seen.length = 0;
    assert.equal((await checkCacheRoute(target, request)).status, 301);
    assert.equal(seen.length, 1);
    let time = 0;
    const slot = name => takeCheckSlot(name, () => time);
    assert.deepEqual([slot('x'), slot('x'), slot('y')], [true, false, true]);
    time = 999;
    assert.equal(slot('x'), false);
    time = 1000;
    assert.equal(slot('x'), true);
});
