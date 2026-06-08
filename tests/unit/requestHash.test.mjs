import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
    canonicalJson,
    sha256b64url,
    sha256RawBodyHash,
    computeRch,
    computeRchHttp,
    computeRchTool,
} from '../../Agent/lib/requestHash.mjs';

test('canonicalJson is independent of object key order', () => {
    assert.equal(
        canonicalJson({ b: 1, a: 2, c: { y: 3, x: 4 } }),
        canonicalJson({ a: 2, c: { x: 4, y: 3 }, b: 1 }),
    );
});

test('canonicalJson preserves (is sensitive to) array order', () => {
    assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
    assert.equal(canonicalJson([1, 2, 3]), '[1,2,3]');
});

test('canonicalJson throws on undefined, function, and symbol (never silently dropped)', () => {
    assert.throws(() => canonicalJson(undefined), /undefined, function, and symbol/);
    assert.throws(() => canonicalJson(() => {}), /undefined, function, and symbol/);
    assert.throws(() => canonicalJson(Symbol('x')), /undefined, function, and symbol/);
    // Nested: an undefined property value must throw rather than disappear.
    assert.throws(() => canonicalJson({ a: 1, b: undefined }), /undefined, function, and symbol/);
    // Nested: an undefined array element must throw rather than become null.
    assert.throws(() => canonicalJson([1, undefined, 2]), /undefined, function, and symbol/);
});

test('canonicalJson throws on non-finite numbers and bigint', () => {
    assert.throws(() => canonicalJson(NaN), /non-finite/);
    assert.throws(() => canonicalJson(Infinity), /non-finite/);
    assert.throws(() => canonicalJson(-Infinity), /non-finite/);
    assert.throws(() => canonicalJson(10n), /bigint/);
});

test('canonicalJson handles primitives and null', () => {
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(true), 'true');
    assert.equal(canonicalJson('a"b'), '"a\\"b"');
    assert.equal(canonicalJson(42), '42');
    assert.equal(canonicalJson({}), '{}');
    assert.equal(canonicalJson([]), '[]');
});

test('computeRch matches an independently computed sha256 over the canonical string', () => {
    // Independent vector: the canonical form of {b:[2,3],a:1} is the literal
    // string below (keys sorted, array order preserved), and rch is its
    // base64url sha256. Computed here without going through computeRch.
    const canonical = '{"a":1,"b":[2,3]}';
    const expected = crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
    assert.equal(sha256b64url(canonical), expected);
    assert.equal(computeRch({ b: [2, 3], a: 1 }), expected);
});

test('sha256RawBodyHash hashes raw HTTP body bytes', () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const expected = crypto.createHash('sha256').update(bytes).digest('base64url');
    assert.equal(sha256RawBodyHash(bytes), expected);
    assert.equal(
        sha256RawBodyHash('abc'),
        crypto.createHash('sha256').update(Buffer.from('abc')).digest('base64url'),
    );
    assert.equal(sha256RawBodyHash(null), sha256RawBodyHash(Buffer.alloc(0)));
});

test('computeRchHttp is key-order stable and binds method/path/query/bodyHash', () => {
    const a = computeRchHttp({ method: 'GET', path: '/x', query: 'a=1', bodyHash: 'h' });
    const b = computeRchHttp({ bodyHash: 'h', query: 'a=1', path: '/x', method: 'GET' });
    assert.equal(a, b);
    // Any field change moves the hash.
    assert.notEqual(a, computeRchHttp({ method: 'GET', path: '/x', query: 'a=2', bodyHash: 'h' }));
    assert.notEqual(a, computeRchHttp({ method: 'HEAD', path: '/x', query: 'a=1', bodyHash: 'h' }));
    assert.notEqual(a, computeRchHttp({ method: 'GET', path: '/y', query: 'a=1', bodyHash: 'h' }));
    assert.notEqual(a, computeRchHttp({ method: 'GET', path: '/x', query: 'a=1', bodyHash: 'h2' }));
    // Missing query and empty query hash the same (both normalize to '').
    assert.equal(
        computeRchHttp({ method: 'GET', path: '/x', bodyHash: 'h' }),
        computeRchHttp({ method: 'GET', path: '/x', query: '', bodyHash: 'h' }),
    );
});

test('computeRchTool binds tool + arguments and is sensitive to argument array order', () => {
    const base = computeRchTool({ method: 'POST', path: '/mcp', tool: 'docs_search', arguments: { q: 'x', tags: ['a', 'b'] } });
    // Argument object key order does not matter.
    assert.equal(base, computeRchTool({ method: 'POST', path: '/mcp', tool: 'docs_search', arguments: { tags: ['a', 'b'], q: 'x' } }));
    // Argument array order does matter.
    assert.notEqual(base, computeRchTool({ method: 'POST', path: '/mcp', tool: 'docs_search', arguments: { q: 'x', tags: ['b', 'a'] } }));
    // Tool name is part of the surface.
    assert.notEqual(base, computeRchTool({ method: 'POST', path: '/mcp', tool: 'docs_delete', arguments: { q: 'x', tags: ['a', 'b'] } }));
    // Missing/empty arguments normalize to {}.
    assert.equal(
        computeRchTool({ method: 'POST', path: '/mcp', tool: 't' }),
        computeRchTool({ method: 'POST', path: '/mcp', tool: 't', arguments: {} }),
    );
});
