import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { createMemoryReplayCache, verifyJws } from '../../Agent/lib/jwtVerify.mjs';
import { REPLAY_CACHE_EXHAUSTED_CODE, createBoundedReplayCache } from '../../Agent/lib/replayCache.mjs';

// Pins the contract between Ploinky's replay caches and the selected shared JWT
// library. It passes only with a library that offers consume(jti, ttlMs) and
// fails closed at capacity with the same error code Ploinky maps to 503.

test('the shared library replay cache refuses a full cache with the Ploinky capacity code', () => {
    const cache = createMemoryReplayCache({ maxSize: 1 });
    assert.equal(cache.consume('first', 60_000), true);
    assert.throws(() => cache.consume('second', 60_000), (error) => {
        assert.equal(error.code, REPLAY_CACHE_EXHAUSTED_CODE);
        return true;
    });
});

test('verifyJws records through consume on a Ploinky bounded cache and never calls remember', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Math.floor(Date.now() / 1000) * 1000 });
    const secret = crypto.randomBytes(32);
    const bounded = createBoundedReplayCache({ maxSize: 4, legacyMinRetentionMs: 600_000 });
    const calls = [];
    const spy = {
        consume(jti, ttlMs) {
            calls.push(['consume', ttlMs]);
            return bounded.consume(jti, ttlMs);
        },
        seen(jti) {
            calls.push(['seen']);
            return bounded.seen(jti);
        },
        remember(jti, ttlMs) {
            calls.push(['remember']);
            return bounded.remember(jti, ttlMs);
        },
    };
    const iat = Math.floor(Date.now() / 1000);
    const token = signHmacJwt({
        secret,
        payload: { aud: 'contract-test', iat, exp: iat + 30, jti: crypto.randomBytes(12).toString('base64url') },
    });
    verifyJws(token, { secret, expectedAudience: 'contract-test', replayCache: spy });
    assert.throws(
        () => verifyJws(token, { secret, expectedAudience: 'contract-test', replayCache: spy }),
        /already been consumed/,
    );
    assert.deepEqual(calls.map(([name]) => name), ['consume', 'consume']);
    // The exact retention covers exp plus the 30 s skew plus the 2 s margin.
    assert.equal(calls[0][1], 62_000);
});
