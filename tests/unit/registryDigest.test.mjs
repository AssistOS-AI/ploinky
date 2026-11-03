import test from 'node:test';
import assert from 'node:assert/strict';

import { parseImageReference } from '../../cli/sandbox/docker/imageReference.mjs';
import { fetchRemoteManifestDigest, nativeFetchIgnoresProxy } from '../../cli/sandbox/docker/registryDigest.mjs';

const DIGEST = `sha256:${'bc7c'.repeat(16)}`;
const parsed = parseImageReference('docker.io/assistos/roboteam-agent:runtime');
const TOKEN = 'secret-token-value';

function response(status, headers = {}, body = null) {
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return { status, headers: { get: (name) => lower[String(name).toLowerCase()] ?? null }, json: async () => body };
}

function scripted(...steps) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const step = steps.shift();
        if (step instanceof Error) throw step;
        return step;
    };
    return { fetchImpl, calls };
}

const BEARER = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:assistos/roboteam-agent:pull"';

test('an anonymous 200 yields the Docker-Content-Digest', async () => {
    const { fetchImpl, calls } = scripted(response(200, { 'docker-content-digest': DIGEST }));
    assert.deepEqual(await fetchRemoteManifestDigest(parsed, { fetchImpl }), { status: 'ok', digest: DIGEST });
    assert.equal(calls[0].url, 'https://registry-1.docker.io/v2/assistos/roboteam-agent/manifests/runtime');
    assert.equal(calls[0].init.method, 'HEAD');
});

test('401 Bearer fetches an anonymous token and retries once with the right query and Accept header', async () => {
    const { fetchImpl, calls } = scripted(
        response(401, { 'www-authenticate': BEARER }),
        response(200, {}, { token: TOKEN }),
        response(200, { 'docker-content-digest': DIGEST }),
    );
    const result = await fetchRemoteManifestDigest(parsed, { fetchImpl });
    assert.deepEqual(result, { status: 'ok', digest: DIGEST });
    assert.equal(calls.length, 3);
    assert.match(calls[0].init.headers.Accept, /application\/vnd\.oci\.image\.index\.v1\+json/);
    const token = new URL(calls[1].url);
    assert.equal(token.origin + token.pathname, 'https://auth.docker.io/token');
    assert.equal(token.searchParams.get('service'), 'registry.docker.io');
    assert.equal(token.searchParams.get('scope'), 'repository:assistos/roboteam-agent:pull');
    assert.equal(calls[2].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(JSON.stringify(result).includes(TOKEN), false, 'the token never appears in the result');
});

test('access_token bodies, odd quoting and a missing scope are accepted', async () => {
    const { fetchImpl, calls } = scripted(
        response(401, { 'www-authenticate': 'bearer service=registry.docker.io, realm="https://auth.example/token"' }),
        response(200, {}, { access_token: TOKEN }),
        response(200, { 'docker-content-digest': DIGEST }),
    );
    assert.equal((await fetchRemoteManifestDigest(parsed, { fetchImpl })).status, 'ok');
    const token = new URL(calls[1].url);
    assert.equal(token.searchParams.get('service'), 'registry.docker.io');
    assert.equal(token.searchParams.get('scope'), 'repository:assistos/roboteam-agent:pull');
});

test('undetermined: non-Bearer challenge, refused or empty token, 4xx after the token, 200 without a digest', async () => {
    const cases = [
        [response(401, { 'www-authenticate': 'Basic realm="x"' })],
        [response(401, { 'www-authenticate': BEARER }), response(403)],
        [response(401, { 'www-authenticate': BEARER }), response(200, {}, {})],
        [response(401, { 'www-authenticate': BEARER }), response(200, {}, { token: TOKEN }), response(401, { 'www-authenticate': BEARER })],
        [response(401, { 'www-authenticate': BEARER }), response(200, {}, { token: TOKEN }), response(403)],
        [response(401, { 'www-authenticate': BEARER }), response(200, {}, { token: TOKEN }), response(404)],
        [response(200, { 'docker-content-digest': 'nope' })],
        [response(200)],
    ];
    for (const steps of cases) {
        const { fetchImpl } = scripted(...steps);
        const result = await fetchRemoteManifestDigest(parsed, { fetchImpl });
        assert.equal(result.status, 'undetermined', JSON.stringify(result));
    }
});

test('undetermined: TLS-class errors, including EPROTO and an expired certificate', async () => {
    for (const code of ['EPROTO', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
        const error = new TypeError('fetch failed');
        error.cause = Object.assign(new Error('tls'), { code });
        const { fetchImpl } = scripted(error);
        assert.equal((await fetchRemoteManifestDigest(parsed, { fetchImpl })).status, 'undetermined', code);
    }
});

test('unavailable: 429, 503, DNS and timeout errors; the host is then not requested again', async () => {
    const dns = new TypeError('fetch failed');
    dns.cause = Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    for (const step of [response(429), response(503), dns, timeout]) {
        const { fetchImpl } = scripted(step);
        const unreachableHosts = new Set();
        const first = await fetchRemoteManifestDigest(parsed, { fetchImpl, unreachableHosts });
        assert.equal(first.status, 'unavailable');
        assert.ok(unreachableHosts.has('registry-1.docker.io'));
        const guarded = scripted(response(200, { 'docker-content-digest': DIGEST }));
        const second = await fetchRemoteManifestDigest(parsed, { fetchImpl: guarded.fetchImpl, unreachableHosts });
        assert.equal(second.status, 'unavailable');
        assert.equal(guarded.calls.length, 0, 'the second ref on that host makes no request');
    }
});

test('nativeFetchIgnoresProxy: a proxy without Node proxy support, and each way to enable it', () => {
    assert.equal(nativeFetchIgnoresProxy({ HTTPS_PROXY: 'http://p:3128' }, []), true);
    assert.equal(nativeFetchIgnoresProxy({ all_proxy: 'socks5://p:1080' }, []), true);
    assert.equal(nativeFetchIgnoresProxy({}, []), false);
    assert.equal(nativeFetchIgnoresProxy({ HTTPS_PROXY: 'http://p', NODE_USE_ENV_PROXY: '1' }, []), false);
    assert.equal(nativeFetchIgnoresProxy({ HTTPS_PROXY: 'http://p' }, ['--use-env-proxy']), false);
    assert.equal(nativeFetchIgnoresProxy({ HTTPS_PROXY: 'http://p', NODE_OPTIONS: '--no-warnings --use-env-proxy' }, []), false);
});

test('the token never reaches a logger even when the whole flow is observed', async () => {
    const lines = [];
    const spy = (...values) => lines.push(values.join(' '));
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = spy;
    try {
        const { fetchImpl } = scripted(
            response(401, { 'www-authenticate': BEARER }),
            response(200, {}, { token: TOKEN }),
            response(404),
        );
        const result = await fetchRemoteManifestDigest(parsed, { fetchImpl });
        lines.push(JSON.stringify(result));
    } finally {
        Object.assign(console, original);
    }
    assert.equal(lines.join('\n').includes(TOKEN), false);
});
