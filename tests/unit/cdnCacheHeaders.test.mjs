import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';

import { decideAgentAnswer, requestHasCredential } from '../../cli/server/cdn/cdnCachePolicy.js';
import { installCdnResponseHook, markCdnDecision } from '../../cli/server/cdn/cdnResponseHook.js';

const application = { enabled: true, pageSeconds: 120, held: false };
const validators = { ETag: '"release"', 'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT' };
const upstream = { ...validators, 'Cache-Control': 'public, max-age=10' };
const pageCdn = 'max-age=120, stale-if-error=900';

function decide(changes) {
    return decideAgentAnswer({
        access: 'public', cacheClass: 'page', application, method: 'GET',
        requestHasCredential: false, status: 200, headers: upstream,
        routerQueuedSetCookie: false, isStream: false, ...changes,
    });
}

for (const [label, changes] of [
    ['unmarked', { cacheClass: null }],
    ['switch off', { application: { ...application, enabled: false } }],
    ['held page', { application: { ...application, held: true } }],
    ['upstream Set-Cookie', { headers: { ...upstream, 'Set-Cookie': ['one=1', 'two=2'] } }],
    ['Router-queued Set-Cookie', { routerQueuedSetCookie: true }],
    ['Vary: Origin', { headers: { ...upstream, vary: ['Accept-Encoding', 'Origin'] } }],
    ['Vary: *', { headers: { ...upstream, Vary: '*' } }],
    ['text/event-stream', { headers: { ...upstream, 'Content-Type': 'TEXT/EVENT-STREAM; charset=utf-8' } }],
    ['stream', { isStream: true }],
    ['POST', { method: 'POST' }],
    ['304', { status: 304 }],
    ['missing immutable release', { cacheClass: 'immutable', status: 404 }],
    ['server error', { status: 500 }],
]) {
    test(`public bypass for ${label} preserves browser policy and validators`, () => {
        assert.deepEqual(decide(changes), {
            cacheControl: upstream['Cache-Control'], cdnCacheControl: 'no-store', removeValidators: false,
        });
    });
}

for (const cacheControl of ['max-age=10, Private="Set-Cookie"', ['PUBLIC', 'NO-STORE']]) {
    test(`upstream ${cacheControl} forbids sharing`, () => {
        const headers = { ...validators, 'Cache-Control': cacheControl };
        assert.deepEqual(decide({ headers }), {
            cacheControl: [cacheControl].flat().join(', '), cdnCacheControl: 'no-store', removeValidators: false,
        });
    });
}

for (const name of ['Cookie', 'AUTHORIZATION']) {
    test(`the presence of ${name} bypasses both marks, even when empty`, () => {
        for (const value of ['', 'present']) {
            const credential = requestHasCredential({ headers: { [name]: value } });
            assert.equal(credential, true);
            for (const cacheClass of ['immutable', 'page']) {
                assert.equal(decide({ cacheClass, requestHasCredential: credential }).cdnCacheControl, 'no-store');
            }
        }
        assert.equal(requestHasCredential({ headers: { 'x-cookie': '', accept: '*/*' } }), false);
    });
}

test('non-public access leaves browser policy to S0', () => {
    for (const access of ['guest', 'authenticated', undefined]) {
        assert.deepEqual(decide({ access }), { cdnCacheControl: 'no-store' });
    }
});

test('missing and non-plain upstream header maps bypass caching', () => {
    for (const headers of [undefined, null, ['Set-Cookie', 'a=1'], new Map()]) {
        assert.equal(decide({ headers }).cdnCacheControl, 'no-store');
    }
    assert.equal(decide({ headers: Object.create(null) }).cdnCacheControl, pageCdn);
});

test('page uses configured freshness, supplies missing browser policy and strips validators', () => {
    for (const pageSeconds of [60, 120, 300]) {
        assert.deepEqual(decide({ headers: validators, application: { ...application, pageSeconds } }), {
            cacheControl: 'no-cache', cdnCacheControl: `max-age=${pageSeconds}, stale-if-error=900`, removeValidators: true,
        });
    }
});

test('HEAD and Vary: Accept-Encoding permit page caching and preserve the upstream browser policy', () => {
    const cacheControl = 'no-cache, custom="local,private,data"';
    assert.deepEqual(decide({ method: 'HEAD', headers: { ...validators, 'cache-control': cacheControl, Vary: 'accept-ENCODING' } }), {
        cacheControl, cdnCacheControl: pageCdn, removeValidators: true,
    });
});

test('immutable overrides browser freshness and strips both validators', () => {
    assert.deepEqual(decide({ cacheClass: 'immutable' }), {
        cacheControl: 'public, max-age=31536000, immutable', cdnCacheControl: 'max-age=31536000', removeValidators: true,
    });
});

test('a hold keeps eligible immutable files cached', () => {
    assert.deepEqual(decide({ cacheClass: 'immutable', application: { ...application, held: true } }), {
        cacheControl: 'public, max-age=31536000, immutable', cdnCacheControl: 'max-age=31536000', removeValidators: true,
    });
});

test('settings read the workspace file on change and fail closed on invalid data', async t => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.cdn-settings-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataDir = path.join(root, '.ploinky', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'cache-settings.json');
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(() => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    });
    const { getApplicationCacheState } = await import('../../cli/server/cdn/cacheSettings.js');
    const log = t.mock.method(console, 'warn', () => {});
    const name = 'repo/site';
    const state = () => getApplicationCacheState(name);
    const off = { enabled: false, pageSeconds: 300, held: false };
    const settings = { version: 1, applications: { [name]: { enabled: true, pageSeconds: 120 } }, held: {} };

    await t.test('missing settings disable caching', () => {
        assert.deepEqual(state(), off);
        assert.equal(decide({ application: state() }).cdnCacheControl, 'no-store');
    });

    await t.test('next call observes edits, atomic replacement, and holds', () => {
        const fixedTime = new Date('2026-01-01T00:00:00Z');
        const write = (target, timestamp) => {
            fs.writeFileSync(target, JSON.stringify(settings));
            fs.utimesSync(target, timestamp, timestamp);
        };
        write(file, fixedTime);
        assert.deepEqual(state(), application);
        assert.deepEqual(getApplicationCacheState('repo/other'), off);
        const generation = { routing: { routes: { alias: { repo: 'repo', agent: 'site', canary: {} } } } };
        assert.deepEqual(getApplicationCacheState(name, generation), { ...application, held: true });

        // Same inode and size, different mtime.
        const later = new Date(fixedTime.getTime() + 1000);
        settings.applications[name].pageSeconds = 300;
        write(file, later);
        assert.equal(state().pageSeconds, 300);

        // Same size and mtime, different inode.
        settings.applications[name].pageSeconds = 120;
        write(file + '.new', later);
        fs.renameSync(file + '.new', file);
        assert.equal(state().pageSeconds, 120);

        // Same inode and mtime, different size.
        settings.held[name] = { since: '2026-01-01T00:00:00Z', by: 'operator' };
        write(file, later);
        assert.deepEqual(state(), { ...application, held: true });
        assert.equal(decide({ application: state() }).cdnCacheControl, 'no-store');
    });

    await t.test('corrupt settings are cached as disabled until the file changes', () => {
        fs.writeFileSync(file, 'invalid private file contents');
        assert.deepEqual(state(), off);
        assert.equal(decide({ application: state() }).cdnCacheControl, 'no-store');
        assert.deepEqual(log.mock.calls.map(call => call.arguments), [['cache_settings_unreadable']]);
        fs.writeFileSync(file, JSON.stringify({ ...settings, held: null }));
        assert.deepEqual(state(), off);
        for (const invalid of [{ since: '1', by: 'operator' }, { since: '2026-01-01T00:00:00Z', by: ' ' }]) {
            fs.writeFileSync(file, JSON.stringify({ ...settings, held: { 'other/app': invalid } }));
            assert.deepEqual(state(), off);
        }
        fs.writeFileSync(file, JSON.stringify({ ...settings, held: {} }));
        assert.deepEqual(state(), application);
        fs.renameSync(file, file + '.target');
        fs.symlinkSync(file + '.target', file);
        assert.deepEqual(state(), off);
        fs.unlinkSync(file);
        assert.deepEqual(state(), off);
    });
});

// Exercise Node's actual HTTP client, server, parser and implicit writeHead
// over a pair of local streams so these unit tests need no listening port.
function httpAnswer(url, handle) {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const server = http.createServer((req, res) => {
        installCdnResponseHook(req, res);
        handle(res);
    });
    server.emit('connection', Duplex.from({ readable: incoming, writable: outgoing }));
    return new Promise((resolve, reject) => {
        const client = http.get({
            path: url,
            headers: { Connection: 'close' },
            createConnection: () => Duplex.from({ readable: outgoing, writable: incoming }),
        }, res => {
            res.resume();
            res.once('end', () => resolve(res));
            res.once('error', reject);
        });
        client.once('error', reject);
    });
}

const cdnHeader = 'cloudflare-cdn-cache-control';
for (const [url, status, headers] of [
    ['/api/example', 200, { 'Content-Type': 'application/json', [cdnHeader]: 'max-age=600' }],
    ['/auth/redirect', 302, { Location: '/auth/sign-in' }],
    ['/private', 401, {}],
    ['/startup', 200, { 'Content-Type': 'text/html' }],
    ['/workspace-files/x.js', 200, { 'Cache-Control': 'private' }],
    ['/webchat/events', 200, { 'Content-Type': 'text/event-stream' }],
    ['/web-libs/../api/example', 200, {}],
    ['/web-libs/x.js', 403, {}],
    ['/web-libs/x.js', 404, { [cdnHeader]: 'public' }],
    ['/MCPBrowserClient.js', 500, {}],
]) {
    test(`hook sends no-store for ${url} ${status}`, async () => {
        const response = await httpAnswer(url, res => {
            res.writeHead(status, headers);
            res.end();
        });
        assert.equal(response.statusCode, status);
        assert.equal(response.headers[cdnHeader], 'no-store');
        if (headers.Location) assert.equal(response.headers.location, headers.Location);
        if (headers['Cache-Control']) assert.equal(response.headers['cache-control'], headers['Cache-Control']);
    });
}

test('hook overrides a queued CDN header on implicit writeHead', async () => {
    const response = await httpAnswer('/implicit', res => {
        res.setHeader(cdnHeader, 'public');
        res.end('implicit');
    });
    assert.equal(response.headers[cdnHeader], 'no-store');
});

test('raw writeHead cookies force no-store, with the reason phrase and repeated cookies preserved', async () => {
    const response = await httpAnswer('/marked', res => {
        markCdnDecision(res, pageCdn);
        res.setHeader(cdnHeader, 'old');
        res.writeHead(200, 'Custom', [
            cdnHeader, 'public', 'Set-Cookie', 'a=1',
            cdnHeader.toUpperCase(), 'stale', 'Set-Cookie', 'b=2',
        ]);
        res.end();
    });
    assert.deepEqual(response.headersDistinct[cdnHeader], ['no-store']);
    assert.deepEqual(response.headers['set-cookie'], ['a=1', 'b=2']);
    assert.equal(response.statusMessage, 'Custom');
});

test('queued cookies, explicit cookies and a final 502 override a stored cache decision', async () => {
    for (const [status, queued, headers] of [
        [200, true, {}], [200, false, { 'sEt-CoOkIe': 'a=1' }], [502, false, {}],
    ]) {
        const response = await httpAnswer('/marked', res => {
            markCdnDecision(res, pageCdn);
            if (queued) res.setHeader('Set-Cookie', 'a=1');
            res.writeHead(status, headers);
            res.end();
        });
        assert.equal(response.statusCode, status);
        assert.equal(response.headers[cdnHeader], 'no-store');
        if (status === 200) assert.deepEqual(response.headers['set-cookie'], ['a=1']);
    }
});

test('a failed marked header write leaves the Router error response uncacheable', async () => {
    const response = await httpAnswer('/marked', res => {
        markCdnDecision(res, pageCdn);
        assert.throws(() => res.writeHead(200, { 'Invalid Header': 'value' }), { code: 'ERR_INVALID_HTTP_TOKEN' });
        res.writeHead(500);
        res.end();
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.headers[cdnHeader], 'no-store');
});

for (const url of ['/web-libs/x.js?v=1', '/MCPBrowserClient.js']) {
    test(`an application answer receives no static exemption on ${url}`, async () => {
        const response = await httpAnswer(url, res => {
            res.writeHead(200, { 'Cache-Control': 'public, max-age=300' });
            res.end();
        });
        assert.equal(response.headers[cdnHeader], 'no-store');
        assert.equal(response.headers['cache-control'], 'public, max-age=300');
    });
}
