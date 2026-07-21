import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyRequestAuthority,
    normalizeAuthority,
    resolveLoopbackAuthorityRedirect,
} from '../../cli/server/generation/authority.js';

function request(url, host, rawHeaders = ['Host', host]) {
    return { method: 'GET', url, headers: { host }, rawHeaders };
}

test('authority normalization is structural, exact, and IDNA-aware', () => {
    assert.equal(normalizeAuthority('BÜCHER.example:8080'), 'xn--bcher-kva.example:8080');
    assert.equal(normalizeAuthority('[::1]:8080'), '[::1]:8080');
    for (const value of ['', 'example.com:', 'user@example.com', 'example.com/path', 'one.example,two.example']) {
        assert.throws(() => normalizeAuthority(value), /invalid .* authority/);
    }
});

test('request classification rejects duplicate, stale, and conflicting authority before routing', () => {
    assert.throws(() => classifyRequestAuthority(
        request('/path', 'router.example', ['Host', 'router.example', 'Host', 'other.example']),
        { expectedAuthority: 'router.example' },
    ), /exactly one Host/);
    assert.throws(() => classifyRequestAuthority(request('/path', 'stale.example'), {
        expectedAuthority: 'router.example',
    }), error => error.status === 404);
    assert.throws(() => classifyRequestAuthority(request('http://other.example/path', 'router.example'), {
        expectedAuthority: 'router.example',
    }), /conflicts with Host/);
});

test('matching absolute-form targets become canonical origin-form targets', () => {
    assert.deepEqual(classifyRequestAuthority(
        request('http://router.example:8080/a/%2F?q=1', 'ROUTER.EXAMPLE:8080'),
        { expectedAuthority: 'router.example:8080', scheme: 'http' },
    ), {
        authority: 'router.example:8080',
        requestTarget: '/a/%2F?q=1',
    });
});

test('localhost on the public loopback port redirects to the canonical authority', () => {
    assert.equal(resolveLoopbackAuthorityRedirect(
        request('/auth/login?returnTo=%2F', 'LOCALHOST:8080'),
        { expectedAuthority: '127.0.0.1:8080', scheme: 'http' },
    ), 'http://127.0.0.1:8080/auth/login?returnTo=%2F');
    assert.equal(resolveLoopbackAuthorityRedirect(
        request('http://localhost:8080/a/%2F?q=1', 'localhost:8080'),
        { expectedAuthority: '127.0.0.1:8080', scheme: 'http' },
    ), 'http://127.0.0.1:8080/a/%2F?q=1');
});

test('loopback redirect rejects non-equivalent and malformed authorities', () => {
    const options = { expectedAuthority: '127.0.0.1:8080', scheme: 'http' };
    assert.equal(resolveLoopbackAuthorityRedirect(request('/', 'localhost:8081'), options), null);
    assert.equal(resolveLoopbackAuthorityRedirect(request('/', 'localhost.example:8080'), options), null);
    assert.equal(resolveLoopbackAuthorityRedirect(request('/', 'attacker.example:8080'), options), null);
    assert.equal(resolveLoopbackAuthorityRedirect(
        request('/', 'localhost:8080'),
        { expectedAuthority: 'router.example:8080', scheme: 'http' },
    ), null);
    assert.equal(resolveLoopbackAuthorityRedirect(
        request('//attacker.example/path', 'localhost:8080'),
        options,
    ), null);
    assert.equal(resolveLoopbackAuthorityRedirect(
        request('/', 'localhost:8080', ['Host', 'localhost:8080', 'Host', '127.0.0.1:8080']),
        options,
    ), null);
    assert.equal(resolveLoopbackAuthorityRedirect(
        request('/', 'localhost:8080'),
        { expectedAuthority: '127.0.0.1:8080', scheme: 'javascript' },
    ), null);
    assert.equal(resolveLoopbackAuthorityRedirect(
        { ...request('/', 'localhost:8080'), method: 'POST' },
        options,
    ), null);
});
