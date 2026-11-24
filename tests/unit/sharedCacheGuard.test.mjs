import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import '../helpers/agentlibTestContract.mjs';
import { agentPortPlan } from '../../cli/server/edgeRoutePlan.js';
import { sanitizeResponseHeaders } from '../../cli/server/proxy/sanitizeResponseHeaders.js';
import { guardSharedCache } from '../../cli/server/proxy/sharedCacheGuard.js';
import { proxyHttpBuffered, proxyHttpPassthrough } from '../../cli/server/routerHandlers.js';

const sharedHints = {
    'cDn-CaChE-CoNtRoL': 'public, max-age=60',
    'Cloudflare-CDN-Cache-Control': 'max-age=60',
    'SURROGATE-Control': 'max-age=60',
};

function sanitize(headers, access, allowCaching = true) {
    return sanitizeResponseHeaders(headers, { responsePolicy: { access, allowCaching } });
}

function directives(headers) {
    return String(headers['cache-control'] || '').toLowerCase().split(',').map(value => value.trim());
}

function assertCdnPolicy(headers, access) {
    const hintNames = Object.keys(sharedHints).map(name => name.toLowerCase());
    const hints = Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value])
        .filter(([name]) => hintNames.includes(name));
    assert.deepEqual(hints, access === 'public' ? [] : [['cloudflare-cdn-cache-control', 'no-store']]);
}

for (const access of ['authenticated', 'guest']) {
    test(`${access} overrides shared directives and retains browser freshness`, () => {
        const cached = sanitize({ 'Cache-Control': 'public, max-age=86400' }, access);
        assert.equal(cached['cache-control'], 'private, max-age=86400');
        assertCdnPolicy(cached, access);
        const headers = sanitize({
            'Cache-Control': 'PUBLIC, max-age=86400, S-MaxAge=3600, Proxy-Revalidate',
            ...sharedHints,
        }, access);
        assert.deepEqual(directives(headers).sort(), ['max-age=86400', 'private']);
        assertCdnPolicy(headers, access);
        const headerless = sanitize({}, access);
        assert.deepEqual(directives(headerless), ['private']);
        assertCdnPolicy(headerless, access);
    });
}

test('a shared directive followed by a semicolon or whitespace is still removed from a non-public answer', () => {
    for (const access of ['authenticated', 'guest']) {
        for (const value of ['public; max-age=60', 'Public max-age=60', 'max-age=10, s-maxage;x', 'proxy-revalidate ;']) {
            const headers = sanitize({ 'Cache-Control': value }, access);
            assert.doesNotMatch(headers['cache-control'], /public|s-maxage|proxy-revalidate/i, value);
            assert.equal(directives(headers)[0], 'private');
            assertCdnPolicy(headers, access);
        }
    }
});

test('public responses preserve upstream cache policy and allow headerless responses', () => {
    const headers = { 'cache-control': 'public, s-maxage=300, max-age=60', ...sharedHints };
    assert.deepEqual(sanitize(headers, 'public'), { 'cache-control': headers['cache-control'] });
    assert.deepEqual(sanitize({}, 'public'), {});
});

test('public relay keeps its cache headers and validators end-to-end', () => {
    const headers = guardSharedCache({
        Connection: 'keep-alive, Cache-Control, Cloudflare-CDN-Cache-Control, ETag, Last-Modified, Vary',
        'Cache-Control': 'no-cache',
        ETag: '"site"',
        'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
    }, 'public');
    assert.equal(headers.Connection, 'keep-alive');
    assert.equal(headers['Cache-Control'], 'no-cache');
    assert.equal(headers.ETag, '"site"');
    assert.equal(headers['Last-Modified'], 'Wed, 01 Jan 2025 00:00:00 GMT');
});

test('upstream no-store survives and caching disabled by the router forces exact no-store', () => {
    const repeated = { 'cache-control': ['no-store', 's-maxage=60'], 'Cache-Control': 'public' };
    assert.deepEqual(directives(sanitize(repeated, 'authenticated')), ['private', 'no-store']);
    const headers = sanitize({ 'cache-control': 'public, max-age=600', ...sharedHints }, 'authenticated', false);
    assert.equal(headers['cache-control'], 'no-store');
    assertCdnPolicy(headers, 'authenticated');
});

test('a qualified private directive becomes unconditional while a quoted comma stays intact', () => {
    const headers = sanitize({
        'cache-control': 'private="X-One, X-Two", no-cache="X-Three, X-Four", max-age=60, public',
    }, 'guest');
    const value = headers['cache-control'];
    assert.match(value, /(?:^|,)\s*private\s*(?:,|$)/i);
    assert.match(value, /(?:^|,)\s*no-cache="X-Three, X-Four"\s*(?:,|$)/i);
    assert.match(value, /(?:^|,)\s*max-age=60\s*(?:,|$)/i);
    assert.doesNotMatch(value, /\bpublic\b/i);
});

for (const access of ['public', 'guest', 'authenticated']) {
    test(`agent-port response policy uses the evaluated ${access} route access`, () => {
        const url = '/base-agent-additional-server/alpha/7000/report.csv';
        const plan = agentPortPlan({
            req: { url, method: 'GET' },
            parsedUrl: new URL(url, 'https://app.example'),
            host: 'app.example',
            listener: 'public',
            hostSelection: { source: 'public-host' },
            routes: { alpha: { repo: 'fixture', agent: 'alpha', container: 'test-alpha' } },
            snapshot: {
                agents: {
                    'test-alpha': {
                        type: 'agent', repoName: 'fixture', agentName: 'alpha', runtime: 'podman',
                        containerId: 'a'.repeat(64), instanceId: 'fixture-instance', enableGeneration: 'fixture-gen',
                    },
                },
                compiled: { policy: { entries: [], routeDefaults: { alpha: { access } } } },
            },
            lease: { id: 'fixture-lease' },
        });
        assert.equal(plan.ok, true, plan.code);
        assert.equal(plan.responsePolicy.access, access);
    });
}

for (const [name, proxy] of [
    ['buffered', (req, res, options) => proxyHttpBuffered(req, res, 7000, '/report.csv', Buffer.alloc(0), {}, options)],
    ['passthrough', (req, res, options) => proxyHttpPassthrough(req, res, 7000, '/report.csv', {}, options)],
]) {
    for (const access of ['authenticated', 'guest', 'public']) {
        test(`${name} streams CSV with ${access} route access`, async t => {
            const upstream = new PassThrough();
            t.mock.method(http, 'request', () => upstream);
            const request = Object.assign(Readable.from([]), { method: 'GET', headers: {} });
            const downstream = new PassThrough();
            downstream.writeHead = t.mock.fn();
            const body = [];
            downstream.on('data', chunk => body.push(chunk.toString()));
            proxy(request, downstream, { access });

            const upstreamHeaders = access === 'authenticated' ? {} : {
                'content-type': 'text/csv', etag: '"fixture"', 'cache-control': 'public, max-age=60', ...sharedHints,
            };
            if (access === 'guest') upstreamHeaders.Connection = 'keep-alive, Cache-Control, Cloudflare-CDN-Cache-Control';
            const response = Object.assign(new PassThrough(), { statusCode: 206, headers: upstreamHeaders });
            upstream.emit('response', response);
            response.write('name,total\n');
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(body, ['name,total\n']);
            const finished = once(downstream, 'finish');
            response.end('sample,1\n');
            await finished;
            assert.equal(body.join(''), 'name,total\nsample,1\n');

            assert.equal(downstream.writeHead.mock.callCount(), 1);
            const [status, headers] = downstream.writeHead.mock.calls[0].arguments;
            assert.equal(status, 206);
            assertCdnPolicy(headers, access);
            if (access === 'public') {
                assert.deepEqual(headers, { 'content-type': 'text/csv', etag: '"fixture"', 'cache-control': 'public, max-age=60' });
            } else {
                assert.deepEqual(directives(headers).sort(), access === 'guest' ? ['max-age=60', 'private'] : ['private']);
                if (access === 'guest') {
                    const connection = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'connection');
                    assert.deepEqual(connection.map(([, value]) => value.toLowerCase()), ['keep-alive']);
                    assert.equal(headers['content-type'], 'text/csv');
                    assert.equal(headers.etag, '"fixture"');
                }
            }
        });
    }
}
