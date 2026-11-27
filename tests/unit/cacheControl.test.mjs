import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createCloudflarePublicationApi } from '../../ploinky-box/cloudflared/cloudflareApi.mjs';
import { cachePublishedHosts, configureCachePurge, configuredCacheHosts } from '../../cli/server/cdn/cachePurgeConfig.js';
import { purgeCacheHost, readLastPurge } from '../../cli/server/cdn/cachePurge.js';
import { applicationCacheState } from '../../cli/server/cdn/cacheSettings.js';
import { isApplicationHeld, markedApplications, changeCacheHold, probeCacheOrigin } from '../../cli/server/cdn/cacheHold.js';
import { readCacheSettings, setCacheApplication, setCacheHold, setCacheRoute } from '../../cli/server/cdn/cacheSettingsStore.js';

const dir = new URL('../../', import.meta.url);
const agent = 'sample/publisher';
const host = 'assets.example.test';
const second = 'pages.example.test';
const zoneId = 'a'.repeat(32);
const handle = 'publication/cache/site';
const policyPath = '/base-agent-additional-server/web/9123/info/';
function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(dir.pathname, '.cache-control-unit-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const generation = {
        generation: 'sha256:' + '1'.repeat(64), publicationState: 'ready',
        compiled: { hosts: Object.fromEntries([host, second].map(name => [name, {
            routeKey: 'main', rootApplication: { routeKey: 'web', port: 9123, agent },
        }])) },
        routing: { routes: { web: { repo: 'sample', agent: 'publisher' } } },
        manifests: { web: { routerAccess: { httpRoutes: {
            [policyPath]: { access: 'public', cache: 'page' },
            '/version/*': { access: 'public', cache: 'immutable' },
            '/guest': { access: 'guest', cache: 'page' },
            '/off': { enabled: false, access: 'public', cache: 'page' },
        } } } },
    };
    const options = {
        dataDir, loadActive: () => ({ generation }), withLock: callback => callback(),
        hasHandle: key => key === handle,
    };
    const config = (amend = {}) => configureCachePurge({ host, zoneId, secretHandle: handle, ...amend }, options);
    return { dataDir, generation, config, params: { agent, host, by: 'operator', generation, assertCurrent() {} } };
}

test('settings preserve simultaneous updates and held records; a replacement inode invalidates the reader', async t => {
    const { dataDir } = fixture(t);
    const opts = { dataDir };
    assert.deepEqual(readCacheSettings(opts), { version: 1, applications: {}, held: {} });
    const since = new Date().toISOString();
    await Promise.all([
        setCacheApplication(agent, { enabled: true, pageSeconds: 60 }, opts),
        setCacheApplication('other/app', { enabled: true, pageSeconds: 120 }, opts),
        setCacheHold(agent, { by: 'operator', since }, opts),
    ]);
    const first = readCacheSettings(opts);
    assert.equal(Object.keys(first.applications).length, 2);
    assert.equal(first.held[agent].since, since);
    assert.equal(first, readCacheSettings(opts));
    const file = path.join(dataDir, 'cache-settings.json');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file + '.swap', text.replace('120', '300'));
    fs.renameSync(file + '.swap', file);
    assert.equal(readCacheSettings(opts).applications['other/app'].pageSeconds, 300);
    for (const pageSeconds of [0, 61, 301, '60', null]) {
        await assert.rejects(setCacheApplication(agent, { enabled: true, pageSeconds }, opts), /invalid_request/);
    }
    await assert.rejects(setCacheApplication(agent, { enabled: false, pageSeconds: 60 }, {
        ...opts, assertCurrent() { throw new Error('stale'); },
    }), /stale/);
    assert.equal(readCacheSettings(opts).applications[agent].enabled, true);
    fs.writeFileSync(file, 'malformed-private-content');
    const warnings = t.mock.method(console, 'warn', () => {});
    assert.deepEqual(readCacheSettings(opts).applications, {});
    await assert.rejects(setCacheApplication(agent, { enabled: true, pageSeconds: 60 }, opts), /cache_settings_unreadable/);
    assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [['cache_settings_unreadable']]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'malformed-private-content');
});

test('unreadable settings warn once per file identity and recover after replacement', async t => {
    const { dataDir } = fixture(t);
    const file = path.join(dataDir, 'cache-settings.json');
    const target = path.join(dataDir, 'settings-target.json');
    const application = { enabled: true, pageSeconds: 60 };
    fs.writeFileSync(target, JSON.stringify({ version: 1, applications: { [agent]: application }, held: {} }));
    fs.symlinkSync(target, file);
    const warnings = t.mock.method(console, 'warn', () => {});
    for (let i = 0; i < 3; i++) assert.deepEqual(readCacheSettings({ dataDir }).applications, {});
    await assert.rejects(setCacheApplication(agent, application, { dataDir }), /cache_settings_unreadable/);
    assert.equal(warnings.mock.callCount(), 1);

    fs.symlinkSync(target, file + '.new');
    fs.renameSync(file + '.new', file);
    assert.deepEqual(readCacheSettings({ dataDir }).applications, {});
    assert.equal(warnings.mock.callCount(), 2);
    fs.renameSync(target, file);
    assert.deepEqual(readCacheSettings({ dataDir }).applications[agent], application);
    assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [
        ['cache_settings_unreadable'], ['cache_settings_unreadable'],
    ]);
});

test('configuration binds an exact published host, zone and existing publication handle', t => {
    const { dataDir, generation, config } = fixture(t);
    for (const amend of [{ host: 'absent.example.test' }, { host: 'bad/name' }, { host: host + ' ' },
        { zoneId: 'a'.repeat(31) }, { zoneId: 'g'.repeat(32) },
        { secretHandle: 'agent/secret' }, { secretHandle: 'publication/missing' }]) {
        assert.throws(() => config(amend));
    }
    config();
    config({ host: second });
    assert.deepEqual(configuredCacheHosts(generation, { dataDir }), [host, second]);
    assert.deepEqual(cachePublishedHosts({ ...generation, publicationState: 'error' }), []);
    assert.throws(() => readLastPurge('../file', { dataDir }), /unknown_host/);
    assert.deepEqual(fs.readdirSync(dataDir), ['cache-purge.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'cache-purge.json'))).hosts[host],
        { zoneId, secretHandle: handle });
});

test('Router records acknowledged purges, local overlaps, upstream limits and unconfigured outcomes', async t => {
    const { dataDir, params, config } = fixture(t);
    const warnings = [];
    let status = 200;
    let now = 0;
    let thrown;
    const sent = [];
    const token = 'obviously-fake-' + 'cache-token';
    const api = createCloudflarePublicationApi({ fetchImpl: async (url, options) => {
        assert.ok(options.headers.Authorization === 'Bearer ' + token);
        sent.push([url, options.method, JSON.parse(options.body)]);
        if (status === 0) throw new Error(token);
        return new Response(JSON.stringify(status === 200 ? { success: true, result: { id: zoneId } }
            : { success: false, errors: [{ message: token }] }), { status });
    } });
    const opts = { dataDir, reservations: new Map(), now: () => now, api, warn: code => warnings.push(code),
        readToken: key => { assert.equal(key, handle); return token; } };
    config();
    await assert.rejects(purgeCacheHost({ ...params, expectedEntry: { zoneId: 'b'.repeat(32), secretHandle: handle } },
        opts), /configuration_changed/);
    assert.equal(sent.length, 0);
    assert.deepEqual(await Promise.all([purgeCacheHost(params, opts), purgeCacheHost(params, opts)]), [
        { host, outcome: 'accepted' }, { host, outcome: 'cooldown', retryAfterSeconds: 15 },
    ]);
    assert.deepEqual(sent, [['https://api.cloudflare.com/client/v4/zones/' + zoneId + '/purge_cache', 'POST', { hosts: [host] }]]);
    now = 14999;
    assert.equal((await purgeCacheHost(params, opts)).retryAfterSeconds, 1);
    now = 15000;
    status = 429;
    assert.deepEqual(await purgeCacheHost(params, opts), { host, outcome: 'failed' });
    status = 0;
    now += 15000;
    assert.equal((await purgeCacheHost(params, opts)).outcome, 'failed');
    try { await api.purgeHosts({ hosts: [host], zoneId, apiToken: token }); } catch (error) { thrown = error; }
    assert.equal(thrown?.code, 'CLOUDFLARE_PURGE_FAILED');
    assert.ok(!String(thrown.stack).includes(token));
    assert.deepEqual(warnings, ['CLOUDFLARE_PURGE_RATE_LIMITED', 'CLOUDFLARE_PURGE_FAILED']);
    assert.equal((await purgeCacheHost({ ...params, host: second }, opts)).outcome, 'unconfigured');
    await assert.rejects(purgeCacheHost({ ...params, host: 'other.example.test' }, opts), /unknown_host/);
    const last = readLastPurge(host, { dataDir });
    assert.deepEqual(Object.keys(last).sort(), ['at', 'by', 'outcome']);
    assert.equal(last.outcome, 'failed');
    assert.equal(last.by, params.by);
    assert.ok(!JSON.stringify(last).includes(token));
});

test('hold persists before purging all hosts, requires a marked public origin 200, and release purges before clearing', async t => {
    const { dataDir, params, config, generation } = fixture(t);
    const events = [];
    const since = new Date().toISOString();
    const opts = { dataDir, withConfigLock: callback => callback(), async purge({ host: name, assertCurrent }) {
        assertCurrent();
        assert.ok(readCacheSettings({ dataDir }).held[agent]);
        events.push(name);
        return { host: name, outcome: 'accepted' };
    }, planRequest({ req }) {
        assert.equal(req.url, '/info/');
        return { ok: true, kind: 'agent-port', routeKey: 'web', canonicalPath: policyPath,
            access: { access: 'public' }, responsePolicy: { cacheClass: 'page' } };
    }, probe: async target => {
        events.push('probe');
        assert.deepEqual(target, { host, path: '/info/', publicPort: 8080 });
        return true;
    } };
    const hold = override => changeCacheHold({ ...params, op: 'hold' }, { ...opts, ...override });
    const release = override => changeCacheHold({ ...params, op: 'release' }, { ...opts, ...override });
    assert.deepEqual(markedApplications(generation), [{ agent, routes: [
        { path: policyPath, cache: 'page' }, { path: '/version/*', cache: 'immutable' },
    ] }]);
    assert.equal((await hold()).success, false);
    assert.ok(readCacheSettings({ dataDir }).held[agent]);
    await assert.rejects(release({ withConfigLock: callback => {
        config();
        return callback();
    } }), /configuration_changed/);
    assert.ok(readCacheSettings({ dataDir }).held[agent]);
    config();
    config({ host: second });
    assert.equal((await hold()).success, true);
    assert.deepEqual(events, [host, second, 'probe']);
    const restarted = await import('../../cli/server/cdn/cacheSettingsStore.js?new-reader');
    const snapshot = { settings: restarted.readCacheSettings({ dataDir }), generation };
    assert.ok(isApplicationHeld(agent, snapshot));
    assert.equal((await hold({ probe: () => false })).success, false);
    assert.equal((await hold({ planRequest: () => ({ ok: false }) })).success, false);
    // The probe follows the effective class: a page the administrator switched off is not probed.
    const off = { setting: 'off', at: since, by: 'operator', entry: { access: 'public', manifest: 'page' } };
    await setCacheRoute(agent, policyPath, off, { dataDir });
    const skipped = await hold({ probe: () => assert.fail('switched-off page') });
    assert.equal(skipped.probeSkipped, 'no_page_marks');
    await setCacheRoute(agent, policyPath, null, { dataDir });
    for (const op of [hold, release]) {
        assert.equal((await op({ purge: async ({ host }) => ({ host, outcome: 'cooldown' }),
            probe: () => assert.fail('unexpected probe') })).success, false);
        assert.ok(readCacheSettings({ dataDir }).held[agent]);
    }
    await assert.rejects(release({ purge: async ({ host: name }) => {
        if (name === host) config({ zoneId: 'b'.repeat(32) });
        return { host: name, outcome: 'accepted' };
    } }), /configuration_changed/);
    assert.ok(readCacheSettings({ dataDir }).held[agent]);
    let committed = false;
    assert.equal((await release({ withConfigLock: async callback => {
        assert.ok(readCacheSettings({ dataDir }).held[agent]);
        await callback();
        committed = !readCacheSettings({ dataDir }).held[agent];
        // Once the commit unlocks, a subsequent reconfiguration is independent.
        config({ zoneId: 'c'.repeat(32) });
    } })).success, true);
    assert.ok(committed);
    const settings = readCacheSettings({ dataDir });
    assert.equal(isApplicationHeld(agent, { settings, generation }), false);
    generation.routing.routes.web.canary = null;
    assert.equal(isApplicationHeld(agent, { settings, generation }), true);
    assert.equal(isApplicationHeld('other/publisher', { settings, generation }), false);
});

test('release clears an unconfigured hold and immutable-only holds skip the page probe', async t => {
    const { dataDir, params, generation, config } = fixture(t);
    delete generation.manifests.web.routerAccess.httpRoutes[policyPath];
    const opts = { dataDir, withConfigLock: fn => fn(), purge: assert.fail,
        planRequest: assert.fail, probe: assert.fail };
    await setCacheHold(agent, { since: new Date().toISOString(), by: 'operator' }, { dataDir });
    assert.deepEqual(await changeCacheHold({ ...params, op: 'release' }, opts), { success: true, purges: [] });
    assert.equal(readCacheSettings({ dataDir }).held[agent], undefined);
    config();
    const purge = ({ host }) => ({ host, outcome: 'accepted' });
    assert.deepEqual(await changeCacheHold({ ...params, op: 'hold' }, { ...opts, purge }), {
        success: true, purges: [{ host, outcome: 'accepted' }], probeSkipped: 'no_page_marks',
    });
    assert.ok(readCacheSettings({ dataDir }).held[agent]);
});

test('release retains the hold while a configured host is awaiting publication', async t => {
    const { dataDir, params, generation, config } = fixture(t);
    const opts = { dataDir, withConfigLock: fn => fn(), purge: assert.fail };
    const release = overrides => changeCacheHold({ ...params, op: 'release' }, { ...opts, ...overrides });
    const hold = () => setCacheHold(agent, { since: new Date().toISOString(), by: 'operator' }, { dataDir });
    await hold();
    generation.publicationState = 'reconciling';
    assert.deepEqual(await release(), { success: true, purges: [] });
    await hold();
    await assert.rejects(release({ withConfigLock(fn) {
        generation.publicationState = 'ready';
        config();
        generation.publicationState = 'reconciling';
        return fn();
    } }), /cache_publication_unavailable/);
    for (const state of ['reconciling', 'error']) {
        generation.publicationState = state;
        assert.deepEqual(configuredCacheHosts(generation, { dataDir }), []);
        await assert.rejects(release(), /cache_publication_unavailable/);
        assert.ok(readCacheSettings({ dataDir }).held[agent]);
    }
});

test('probe uses only the local public listener and requires a successful no-store response', async () => {
    for (const [statusCode, header, expected] of [
        [200, 'no-store', true], [200, 'max-age=60', false], [200, undefined, false],
        [302, 'no-store', false], [503, 'no-store', false],
    ]) {
        assert.equal(await probeCacheOrigin({ host, path: '/info/' }, (options, callback) => {
            assert.equal(options.hostname, '127.0.0.1');
            assert.equal(options.port, 8080);
            assert.deepEqual(options.headers, { host });
            assert.equal(options.path, '/info/');
            const req = new EventEmitter();
            req.end = () => callback({ statusCode, headers: { 'cloudflare-cdn-cache-control': header }, destroy() {} });
            return req;
        }), expected);
    }
});

const choice = (setting, manifest) => ({ setting, at: '2026-11-27T10:00:00.000Z', by: 'admin', entry: { access: 'public', manifest } });

test('route choices are written one at a time, kept by other writes, and removing a missing one writes nothing', async t => {
    const { dataDir } = fixture(t);
    const opts = { dataDir };
    const file = path.join(dataDir, 'cache-settings.json');
    const first = await setCacheRoute(agent, '/sample/a', null, opts);
    assert.equal(first.changed, false);
    assert.equal(fs.existsSync(file), false, 'removing a missing choice must not create the file');
    await Promise.all([
        setCacheRoute(agent, '/sample/a', choice('off', 'page'), opts),
        setCacheRoute(agent, '/sample/b/*', choice('page', null), opts),
        setCacheRoute('other/app', '/sample/a', choice('off', 'immutable'), opts),
        setCacheApplication(agent, { enabled: true, pageSeconds: 60 }, opts),
    ]);
    const stored = readCacheSettings(opts);
    assert.equal(stored.version, 1);
    assert.deepEqual(Object.keys(stored.routes[agent]).sort(), ['/sample/a', '/sample/b/*']);
    assert.deepEqual(stored.routes['other/app']['/sample/a'].entry, { access: 'public', manifest: 'immutable' });
    assert.equal(stored.applications[agent].enabled, true);
    assert.ok(Object.isFrozen(stored.routes[agent]['/sample/a'].entry));
    // The write reports the exact content it started from and the record it replaced.
    const replaced = await setCacheRoute(agent, '/sample/a', choice('page', null), opts);
    assert.equal(replaced.previous.setting, 'off');
    assert.equal(replaced.before.routes[agent]['/sample/a'].setting, 'off');
    assert.equal(replaced.settings.routes[agent]['/sample/a'].setting, 'page');
    await setCacheRoute(agent, '/sample/a', null, opts);
    await setCacheRoute(agent, '/sample/b/*', null, opts);
    assert.equal(readCacheSettings(opts).routes[agent], undefined);
    await setCacheRoute('other/app', '/sample/a', null, opts);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'routes'), false, 'an empty routes key is dropped');
    assert.equal(readCacheSettings(opts).applications[agent].pageSeconds, 60);
    for (const [route, record] of [['sample/a', choice('off', 'page')], ['/' + 'x'.repeat(512), choice('off', 'page')],
        ['/a\n', choice('off', 'page')], ['/a', choice('immutable', 'page')], ['/a', choice('off', 'never')],
        ['/a', choice('off', undefined)], ['/a', { ...choice('off', 'page'), extra: 1 }],
        ['/a', { ...choice('off', 'page'), at: 'yesterday' }], ['/a', { ...choice('off', 'page'), by: ' ' }],
        ['/a', { ...choice('off', 'page'), entry: { access: 'guest', manifest: 'page' } }],
        ['/a', { ...choice('off', 'page'), entry: { access: 'public', manifest: 'page', extra: 1 } }]]) {
        await assert.rejects(setCacheRoute(agent, route, record, opts), /invalid_request/, route);
    }
    await assert.rejects(setCacheRoute('bad agent', '/a', choice('off', 'page'), opts), /invalid_request/);
    await assert.rejects(setCacheRoute(agent, '/a', choice('off', 'page'), { ...opts, assertCurrent() { throw new Error('stale'); } }), /stale/);
    assert.equal(readCacheSettings(opts).routes, undefined);
});

test('malformed route choices turn every application off', async t => {
    const { dataDir } = fixture(t);
    const file = path.join(dataDir, 'cache-settings.json');
    const good = choice('page', null);
    const application = { enabled: true, pageSeconds: 60 };
    const warnings = t.mock.method(console, 'warn', () => {});
    const settingsWith = routes => ({ version: 1, applications: { [agent]: application }, held: {}, routes });
    fs.writeFileSync(file, JSON.stringify(settingsWith({ [agent]: { '/sample/a': good } })));
    assert.equal(readCacheSettings({ dataDir }).routes[agent]['/sample/a'].setting, 'page');
    assert.deepEqual(applicationCacheState(agent, readCacheSettings({ dataDir }), {}), { enabled: true, pageSeconds: 60, held: false });
    for (const routes of [[], 'x', null, { 'bad agent': {} }, { [agent]: [] }, { [agent]: { 'no-slash': good } },
        { [agent]: { ['/' + 'x'.repeat(512)]: good } }, { [agent]: { '/sample/a': { ...good, setting: 'immutable' } } },
        { [agent]: { '/sample/a': { ...good, entry: { access: 'public', manifest: 'never' } } } },
        { [agent]: { '/sample/a': { ...good, entry: { access: 'public' } } } },
        { [agent]: { '/sample/a': { ...good, at: 'now' } } }, { [agent]: { '/sample/a': { ...good, by: '' } } },
        { [agent]: { '/sample/a': { ...good, extra: true } } }, { [agent]: { '/sample/a': 'page' } }]) {
        fs.writeFileSync(file, JSON.stringify(settingsWith(routes)));
        const read = readCacheSettings({ dataDir });
        assert.deepEqual(read.applications, {}, JSON.stringify(routes));
        assert.equal(applicationCacheState(agent, read, {}).enabled, false);
        await assert.rejects(setCacheRoute(agent, '/sample/b', good, { dataDir }), /cache_settings_unreadable/);
    }
    assert.ok(warnings.mock.callCount() >= 1);
});

test('hold derives its probe from effective page routes, administrator choices included, and skips when there is none', async t => {
    const { dataDir, params, config, generation } = fixture(t);
    const base = '/base-agent-additional-server/web/9123';
    // A generation's manifests never change in place: every edit below is a new manifest object.
    let routes = {};
    const edit = change => {
        routes = change({ ...routes });
        generation.manifests.web = { routerAccess: { httpRoutes: routes } };
    };
    edit(() => ({ [base + '/static/*']: { access: 'public' }, [base + '/exact']: { access: 'public' },
        [base + '/version/*']: { access: 'public', cache: 'immutable' } }));
    config();
    const probed = [];
    const opts = { dataDir, withConfigLock: fn => fn(), purge: ({ host: name }) => ({ host: name, outcome: 'accepted' }),
        planRequest: ({ req }) => ({ ok: true, kind: 'agent-port', routeKey: 'web', access: { access: 'public' },
            canonicalPath: base + req.url, responsePolicy: { cacheClass: null } }),
        probe: async target => { probed.push(target); return true; } };
    const hold = () => changeCacheHold({ ...params, op: 'hold' }, opts);
    const choose = record => setCacheRoute(agent, base + '/static/*', record, { dataDir });
    const page = { setting: 'page', at: new Date().toISOString(), by: 'admin', entry: { access: 'public', manifest: null } };
    // A route the manifest left unmarked and no administrator chose is not a page: nothing to probe.
    assert.equal((await hold()).probeSkipped, 'no_page_marks');
    // The choice is stale without a never mark in the manifest.
    await choose(page);
    assert.equal((await hold()).probeSkipped, 'no_page_marks');
    edit(current => ({ ...current, [base + '/never/*']: { access: 'public', cache: 'never' } }));
    assert.deepEqual((await hold()), { success: true, purges: [{ host, outcome: 'accepted' }] });
    assert.deepEqual(probed, [{ host, path: '/static/', publicPort: 8080 }]);
    // An exact unmarked entry shadows the wildcard at the probed path: that choice is not served as a page.
    edit(current => ({ ...current, [base + '/static/']: { access: 'public' } }));
    assert.equal((await hold()).success, false);
    assert.equal(probed.length, 1);
    edit(({ [base + '/static/']: _, ...current }) => current);
    // The administrator switching a manifest page off removes it from the probes.
    await choose(null);
    edit(current => ({ ...current, [base + '/exact']: { access: 'public', cache: 'page' } }));
    assert.equal((await hold()).success, true);
    assert.equal(probed.length, 2);
    await setCacheRoute(agent, base + '/exact', { ...page, setting: 'off', entry: { access: 'public', manifest: 'page' } }, { dataDir });
    assert.equal((await hold()).probeSkipped, 'no_page_marks');
    assert.equal(probed.length, 2);
    // Applications listed only by a never mark can be held.
    edit(() => ({ [base + '/never/*']: { access: 'public', cache: 'never' } }));
    assert.deepEqual(markedApplications(generation), [{ agent, routes: [] }]);
    assert.equal((await hold()).probeSkipped, 'no_page_marks');
});
