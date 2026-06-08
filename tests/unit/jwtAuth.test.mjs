import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
    signHmacJwt,
    bodyHashForRequest,
    canonicalJson
} from '../../Agent/lib/jwtSign.mjs';
import {
    createMemoryReplayCache,
    verifyJws,
    MAX_TTL_SECONDS
} from '../../Agent/lib/jwtVerify.mjs';

// This suite covers the shared HS256 JWS primitive layer that every DS013 token
// family (User Session, Agent Assertion, Router Request) is built on:
// signing, audience binding, request-body binding (`bh`), replay/jti, and TTL.
// The per-family `typ`/`iss`/`tool`/`rch` checks live in the dedicated
// routerRequestJwt / agentAssertion / userSessionJwt suites; the retired
// `typ:"invocation"` model is intentionally not exercised here.
const SECRET = crypto.randomBytes(32);
const EXAMPLE_BODY = { tool: 'secret_get', arguments: { key: 'X' } };

function mintJws(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        aud: 'agent:AssistOSExplorer/dpuAgent',
        sub: 'user:local:admin',
        bh: bodyHashForRequest(EXAMPLE_BODY),
        usr: { id: 'local:admin', username: 'admin', roles: ['local'] },
        jti: crypto.randomBytes(12).toString('base64url'),
        iat: now,
        exp: now + 60,
        ...overrides
    };
    return { token: signHmacJwt({ payload, secret: SECRET }), payload };
}

test('signHmacJwt / verifyJws round-trip preserves claims and uses HS256', () => {
    const { token } = mintJws();
    const result = verifyJws(token, {
        secret: SECRET,
        expectedAudience: 'agent:AssistOSExplorer/dpuAgent',
        bodyObject: EXAMPLE_BODY,
        replayCache: createMemoryReplayCache()
    });
    assert.equal(result.payload.sub, 'user:local:admin');
    assert.equal(result.payload.usr.username, 'admin');
    assert.equal(result.header.alg, 'HS256');
});

test('verifyJws enforces audience', () => {
    const { token } = mintJws();
    verifyJws(token, {
        secret: SECRET,
        expectedAudience: 'agent:AssistOSExplorer/dpuAgent',
        bodyObject: EXAMPLE_BODY,
        replayCache: createMemoryReplayCache()
    });
    assert.throws(() => verifyJws(token, {
        secret: SECRET,
        expectedAudience: 'agent:otherAgent',
        bodyObject: EXAMPLE_BODY,
        replayCache: createMemoryReplayCache()
    }), /audience mismatch/);
});

test('verifyJws rejects a mutated request body (bh binding)', () => {
    const { token } = mintJws();
    assert.throws(() => verifyJws(token, {
        secret: SECRET,
        expectedAudience: 'agent:AssistOSExplorer/dpuAgent',
        bodyObject: { tool: 'secret_get', arguments: { key: 'Y' } },
        replayCache: createMemoryReplayCache()
    }), /body hash mismatch/);
});

test('verifyJws rejects replay within the ttl window', () => {
    const { token } = mintJws({ jti: 'replay-test-1' });
    const cache = createMemoryReplayCache();
    verifyJws(token, {
        secret: SECRET,
        expectedAudience: 'agent:AssistOSExplorer/dpuAgent',
        bodyObject: EXAMPLE_BODY,
        replayCache: cache
    });
    assert.throws(() => verifyJws(token, {
        secret: SECRET,
        expectedAudience: 'agent:AssistOSExplorer/dpuAgent',
        bodyObject: EXAMPLE_BODY,
        replayCache: cache
    }), /jti has already been consumed/);
});

test('verifyJws rejects a token without jti', () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        aud: 'agent:AssistOSExplorer/dpuAgent',
        bh: bodyHashForRequest(EXAMPLE_BODY),
        iat: now,
        exp: now + 60
    };
    const token = signHmacJwt({ payload, secret: SECRET });
    assert.throws(() => verifyJws(token, {
        secret: SECRET,
        expectedAudience: 'agent:AssistOSExplorer/dpuAgent',
        bodyObject: EXAMPLE_BODY,
        replayCache: createMemoryReplayCache()
    }), /jti missing/);
});

test('verifyJws rejects a token with excessive lifetime', () => {
    const now = Math.floor(Date.now() / 1000);
    const { token } = mintJws({ iat: now, exp: now + MAX_TTL_SECONDS + 30 });
    assert.throws(() => verifyJws(token, {
        secret: SECRET,
        expectedAudience: 'agent:AssistOSExplorer/dpuAgent',
        bodyObject: EXAMPLE_BODY,
        replayCache: createMemoryReplayCache()
    }), /lifetime exceeds max/);
});

test('verifyJws rejects a wrong secret', () => {
    const { token } = mintJws();
    const wrongSecret = crypto.randomBytes(32);
    assert.throws(() => verifyJws(token, {
        secret: wrongSecret,
        expectedAudience: 'agent:AssistOSExplorer/dpuAgent',
        bodyObject: EXAMPLE_BODY
    }), /signature invalid/);
});

test('verifyJws rejects a tampered payload', () => {
    const { token } = mintJws();
    const parts = token.split('.');
    const payloadBuf = Buffer.from(JSON.stringify({ iss: 'attacker' }));
    parts[1] = payloadBuf.toString('base64url');
    const tampered = parts.join('.');
    assert.throws(() => verifyJws(tampered, {
        secret: SECRET,
        bodyObject: EXAMPLE_BODY
    }), /signature invalid/);
});

test('canonicalJson sorts keys deterministically', () => {
    assert.equal(
        canonicalJson({ b: 1, a: 2, c: { y: 3, x: 4 } }),
        canonicalJson({ a: 2, c: { x: 4, y: 3 }, b: 1 })
    );
});
