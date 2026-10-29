import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { computeRch } from '../../Agent/lib/requestHash.mjs';
import { verifyRouterRequestToken } from '../../Agent/lib/requestSignedTokens.mjs';
import {
    EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE,
    EXECUTION_PROVIDER_TERMINAL_PURPOSE,
    ROUTER_SERVICE_AUTH_INFO_KEY,
    computeRouterServiceRch,
    createRouterServiceReplayCache,
    readRouterServiceTokenFromHeaders,
    verifyRouterServiceToken,
    verifyRouterServiceTokenFromFrame,
    verifyRouterServiceTokenFromHeaders,
} from '../../Agent/lib/routerServiceToken.mjs';
import { RouterRequestTokenService, RouterServiceTokenService } from '../../cli/server/security/tokens/index.js';

const PROVIDER = 'agent:robots/robo-worker';
const OTHER = 'agent:robots/other-worker';
const TERMINAL_PATH = '/terminals';
const PURPOSE = EXECUTION_PROVIDER_TERMINAL_PURPOSE;
const HELLO = EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE;
// Distinct 32-byte connection nonces, base64url (43 characters).
const N1 = Buffer.alloc(32, 1).toString('base64url');
const N2 = Buffer.alloc(32, 2).toString('base64url');
// Whole-second instant so iat * 1000 equals the clock reading at mint time.
const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
const IAT = T0 / 1000;

const secret = crypto.randomBytes(32);
const otherSecret = crypto.randomBytes(32);

function minter({ resolve = () => secret, randomId } = {}) {
    let counter = 0;
    return new RouterServiceTokenService({
        resolveAgentSecret: resolve,
        randomId: randomId || (() => `jti-${(counter += 1)}-${crypto.randomBytes(6).toString('base64url')}`),
    });
}

function validPayload(overrides = {}) {
    return {
        typ: 'router-service',
        iss: 'ploinky-router',
        aud: PROVIDER,
        purpose: PURPOSE,
        method: 'GET',
        path: TERMINAL_PATH,
        rch: computeRouterServiceRch({ method: 'GET', path: TERMINAL_PATH }),
        jti: `forged-${crypto.randomBytes(6).toString('base64url')}`,
        iat: IAT,
        exp: IAT + 30,
        ...overrides,
    };
}

// Signs a payload with the provider's real secret, so a refusal can only come
// from the claim under test, never from the signature.
function forge(overrides = {}, { remove = [] } = {}) {
    const payload = validPayload(overrides);
    for (const key of remove) delete payload[key];
    return signHmacJwt({ payload, secret });
}

function verifyOptions(overrides = {}) {
    return {
        secret,
        expectedAudience: PROVIDER,
        purpose: PURPOSE,
        path: TERMINAL_PATH,
        generationStartMs: T0 - 5000,
        replayCache: createRouterServiceReplayCache(),
        ...overrides,
    };
}

function helloOptions(overrides = {}) {
    return verifyOptions({ purpose: HELLO, expectedNonce: N1, ...overrides });
}

function forgeHello(overrides = {}, options) {
    return forge({ purpose: HELLO, nonce: N1, ...overrides }, options);
}

function atTime(t, ms = T0) {
    t.mock.timers.enable({ apis: ['Date'], now: ms });
}

function assertRefused(fn, pattern) {
    assert.throws(fn, (error) => {
        assert.match(error.message, pattern);
        return true;
    });
}

test('RouterServiceTokenService mints exactly the router-service claim set', (t) => {
    atTime(t);
    const signed = [];
    const service = new RouterServiceTokenService({
        jwsCodec: { signHmacJwt: (input) => { signed.push(input); return 'rs.jwt'; } },
        resolveAgentSecret: (target) => { assert.equal(target, PROVIDER); return secret; },
        randomId: () => 'nonce-1',
    });
    const { token, payload } = service.mintWithPayloadSync({ targetAgentId: ` ${PROVIDER} `, path: TERMINAL_PATH });
    assert.equal(token, 'rs.jwt');
    assert.equal(signed[0].secret, secret);
    assert.deepEqual(signed[0].payload, payload);
    assert.deepEqual(payload, {
        typ: 'router-service',
        iss: 'ploinky-router',
        aud: PROVIDER,
        purpose: 'execution-provider-terminal',
        method: 'GET',
        path: TERMINAL_PATH,
        rch: computeRch({ method: 'GET', path: TERMINAL_PATH }),
        jti: 'nonce-1',
        iat: IAT,
        exp: IAT + 30,
    });
    assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'method', 'path', 'purpose', 'rch', 'typ']);
});

test('RouterServiceTokenService ignores identity inputs and refuses bad targets, paths and purposes', async (t) => {
    atTime(t);
    const service = minter();
    const { payload } = await service.mintWithPayload({
        targetAgentId: PROVIDER,
        path: TERMINAL_PATH,
        actor: { kind: 'user', id: 'user:x', roles: ['admin'] },
        sub: 'user:x',
        tool: '__http_route__',
        delegation: { sourceAgentId: 'agent:a/b', tool: 't' },
        method: 'POST',
        ttlSeconds: 600,
    });
    for (const claim of ['actor', 'sub', 'tool', 'delegation', 'delegations', 'usr', 'caller', 'scope']) {
        assert.equal(Object.hasOwn(payload, claim), false, claim);
    }
    assert.equal(payload.method, 'GET');
    assert.equal(payload.exp - payload.iat, 30);
    assert.equal(typeof await service.mint({ targetAgentId: PROVIDER, path: TERMINAL_PATH }), 'string');

    assert.throws(() => service.mintWithPayloadSync({ targetAgentId: ' ', path: TERMINAL_PATH }), /targetAgentId required/);
    assert.throws(() => service.mintWithPayloadSync({ targetAgentId: PROVIDER, path: 'terminals' }), /absolute path/);
    assert.throws(() => service.mintWithPayloadSync({ targetAgentId: PROVIDER }), /absolute path/);
    assert.throws(
        () => service.mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH, purpose: 'other' }),
        /unknown purpose/,
    );
    const asyncSecret = minter({ resolve: async () => secret });
    assert.throws(
        () => asyncSecret.mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH }),
        /async secret resolver/,
    );
});

test('verifier accepts a minted token and the header carrier', (t) => {
    atTime(t);
    const { token } = minter().mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH });
    const { payload } = verifyRouterServiceToken(token, verifyOptions());
    assert.equal(payload.typ, 'router-service');
    assert.equal(payload.purpose, PURPOSE);
    assert.equal(payload.aud, PROVIDER);

    const second = minter().mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH }).token;
    const headers = { 'x-ploinky-auth-info': JSON.stringify({ [ROUTER_SERVICE_AUTH_INFO_KEY]: second }) };
    const env = { PLOINKY_AGENT_ID: PROVIDER, PLOINKY_AGENT_SECRET: secret.toString('hex') };
    const result = verifyRouterServiceTokenFromHeaders(headers, {
        env,
        purpose: PURPOSE,
        path: TERMINAL_PATH,
        generationStartMs: T0 - 5000,
        replayCache: createRouterServiceReplayCache(),
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.payload.jti.startsWith('jti-'), true);
});

test('header carrier must be exactly { routerServiceToken }', () => {
    assert.equal(readRouterServiceTokenFromHeaders({}).ok, false);
    assert.equal(readRouterServiceTokenFromHeaders({ 'x-ploinky-auth-info': 'not json' }).ok, false);
    assert.equal(readRouterServiceTokenFromHeaders({ 'x-ploinky-auth-info': '{"routerServiceToken":""}' }).ok, false);
    const mixed = readRouterServiceTokenFromHeaders({
        'x-ploinky-auth-info': JSON.stringify({ routerServiceToken: 'a.b.c', invocationToken: 'x.y.z' }),
    });
    assert.equal(mixed.ok, false);
    assert.match(mixed.reason, /only routerServiceToken/);
    assert.deepEqual(
        readRouterServiceTokenFromHeaders({ 'x-ploinky-auth-info': JSON.stringify({ routerServiceToken: ' a.b.c ' }) }),
        { ok: true, token: 'a.b.c' },
    );
});

test('verifier refuses a real router-request token for the same audience, method, path and rch', async (t) => {
    atTime(t);
    const routerRequest = new RouterRequestTokenService({ resolveAgentSecret: () => secret });
    const { token } = await routerRequest.mintWithPayload({
        targetAgentId: PROVIDER,
        sub: 'user:alice',
        actor: { kind: 'user', id: 'user:alice', roles: ['admin'] },
        method: 'GET',
        path: TERMINAL_PATH,
        tool: '__http_route__',
        rch: computeRouterServiceRch({ method: 'GET', path: TERMINAL_PATH }),
    });
    assertRefused(() => verifyRouterServiceToken(token, verifyOptions()), /token type is not router-service/);
    // A router-request typ without any identity claim is still refused by type.
    assertRefused(() => verifyRouterServiceToken(forge({ typ: 'router-request' }), verifyOptions()), /token type is not router-service/);
});

test('the existing Router Request verifier refuses a router-service token', (t) => {
    atTime(t);
    const { token } = minter().mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH });
    assert.throws(
        () => verifyRouterRequestToken(token, { secret, expectedAudience: PROVIDER }),
        /token type is not router-request/,
    );
});

test('verifier refuses tokens carrying identity or route-invocation claims, by presence', (t) => {
    atTime(t);
    const cases = {
        actor: { kind: 'user', id: 'user:alice', roles: [] },
        sub: '',
        tool: '__http_route__',
        delegation: { sourceAgentId: 'agent:a/b', tool: 't' },
        delegations: {},
        usr: { id: 'u' },
        caller: { kind: 'agent', id: 'agent:a/b' },
        scope: [],
    };
    for (const [claim, value] of Object.entries(cases)) {
        assertRefused(
            () => verifyRouterServiceToken(forge({ [claim]: value }), verifyOptions()),
            new RegExp(`forbidden claim '${claim}'`),
        );
    }
    assertRefused(() => verifyRouterServiceToken(forge({ extra: 1 }), verifyOptions()), /unexpected claim 'extra'/);
});

test('verifier refuses a wrong purpose, aud, method, path, rch or issuer', (t) => {
    atTime(t);
    const cases = [
        [{ purpose: 'other-purpose' }, /purpose mismatch/],
        [{ purpose: undefined }, /purpose mismatch/],
        [{ aud: OTHER }, /audience mismatch/],
        [{ aud: [PROVIDER] }, /audience mismatch/],
        [{ method: 'POST' }, /method mismatch/],
        [{ method: 'get' }, /method mismatch/],
        [{ path: '/terminals/other' }, /path mismatch/],
        [{ rch: computeRouterServiceRch({ method: 'GET', path: '/terminals/other' }) }, /request hash mismatch/],
        [{ rch: computeRouterServiceRch({ method: 'POST', path: TERMINAL_PATH }) }, /request hash mismatch/],
        [{ iss: 'agent:robots/robo-worker' }, /issuer mismatch/],
    ];
    for (const [overrides, pattern] of cases) {
        assertRefused(() => verifyRouterServiceToken(forge(overrides), verifyOptions()), pattern);
    }
    // A verifier configured for another path refuses a token minted for /terminals.
    assertRefused(
        () => verifyRouterServiceToken(forge(), verifyOptions({ path: '/terminals/other' })),
        /path mismatch/,
    );
    // Wrong signing secret.
    const foreign = signHmacJwt({ payload: validPayload(), secret: otherSecret });
    assertRefused(() => verifyRouterServiceToken(foreign, verifyOptions()), /signature invalid/);
});

// Contract change (Revision 9): the previous test accepted a generation start
// up to T0 + 999 ms after iat (whole-second comparison), which let a
// pre-restart token issued in the same second as the new generation pass. The
// upgrade floor is now exact: iat * 1000 >= generationStartMs.
test('upgrade token generation floor is exact: T0 accepted, T0 + 1 refused', (t) => {
    atTime(t);
    assert.equal(
        verifyRouterServiceToken(forge(), verifyOptions({ generationStartMs: T0 })).payload.iat,
        IAT,
    );
    assertRefused(
        () => verifyRouterServiceToken(forge(), verifyOptions({ generationStartMs: T0 + 1 })),
        /issued before the current worker generation/,
    );
    assertRefused(
        () => verifyRouterServiceToken(forge(), verifyOptions({ generationStartMs: T0 + 999 })),
        /issued before the current worker generation/,
    );
    assertRefused(
        () => verifyRouterServiceToken(forge(), verifyOptions({ generationStartMs: T0 + 1000 })),
        /issued before the current worker generation/,
    );
    assertRefused(
        () => verifyRouterServiceToken(forge({ iat: IAT - 1, exp: IAT + 29 }), verifyOptions({ generationStartMs: T0 })),
        /issued before the current worker generation/,
    );
});

test('hello token is not subject to the generation floor', (t) => {
    atTime(t);
    for (const generationStartMs of [T0 + 1, T0 + 1000, T0 + 3_600_000, undefined]) {
        const { payload } = verifyRouterServiceToken(forgeHello(), helloOptions({ generationStartMs }));
        assert.equal(payload.nonce, N1);
    }
});

test('hello mint emits the exact claim set plus nonce', (t) => {
    atTime(t);
    const { token, payload } = minter().mintWithPayloadSync({
        targetAgentId: PROVIDER, path: TERMINAL_PATH, purpose: HELLO, nonce: N1,
    });
    assert.equal(payload.purpose, 'execution-provider-terminal-hello');
    assert.equal(payload.nonce, N1);
    assert.deepEqual(
        Object.keys(payload).sort(),
        ['aud', 'exp', 'iat', 'iss', 'jti', 'method', 'nonce', 'path', 'purpose', 'rch', 'typ'],
    );
    assert.equal(payload.rch, computeRch({ method: 'GET', path: TERMINAL_PATH }));
    assert.equal(verifyRouterServiceToken(token, helloOptions()).payload.nonce, N1);

    const service = minter();
    for (const nonce of [undefined, '', N1.slice(0, 42), `${N1}A`, 'A'.repeat(43) + '=', 123]) {
        assert.throws(
            () => service.mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH, purpose: HELLO, nonce }),
            /hello purpose requires/,
        );
    }
    // 43 characters that do not re-encode to the same 32 bytes (non-canonical last char).
    const nonCanonical = `${N1.slice(0, 42)}B`;
    assert.equal(nonCanonical.length, 43);
    assert.notEqual(Buffer.from(nonCanonical, 'base64url').toString('base64url'), nonCanonical);
    assert.throws(
        () => service.mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH, purpose: HELLO, nonce: nonCanonical }),
        /hello purpose requires/,
    );
    // nonce is refused for the upgrade purpose.
    assert.throws(
        () => service.mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH, nonce: N1 }),
        /nonce is only valid for the hello purpose/,
    );
});

test('hello verification refuses a missing, short, long or non-canonical nonce, and an upgrade token carrying nonce', (t) => {
    atTime(t);
    const cache = createRouterServiceReplayCache();
    assertRefused(
        () => verifyRouterServiceToken(forgeHello({}, { remove: ['nonce'] }), helloOptions({ replayCache: cache })),
        /nonce is missing or malformed/,
    );
    for (const nonce of [N1.slice(0, 42), `${N1}A`, `${N1.slice(0, 42)}B`, 7, '']) {
        assertRefused(
            () => verifyRouterServiceToken(forgeHello({ nonce }), helloOptions({ replayCache: cache })),
            /nonce is missing or malformed/,
        );
    }
    assertRefused(
        () => verifyRouterServiceToken(forge({ nonce: N1 }), verifyOptions({ replayCache: cache })),
        /unexpected claim 'nonce'/,
    );
    assert.equal(cache.size(), 0, 'refused tokens consume no jti');
});

test('hello positive control: the current connection nonce is accepted', (t) => {
    atTime(t);
    const cache = createRouterServiceReplayCache();
    const { token } = minter().mintWithPayloadSync({
        targetAgentId: PROVIDER, path: TERMINAL_PATH, purpose: HELLO, nonce: N2,
    });
    const { payload } = verifyRouterServiceToken(token, helloOptions({ expectedNonce: N2, replayCache: cache }));
    assert.equal(payload.purpose, HELLO);
    assert.equal(payload.nonce, N2);
    assert.equal(cache.size(), 1);

    // The same positive control through the frame-level entry point (no header).
    const env = { PLOINKY_AGENT_ID: PROVIDER, PLOINKY_AGENT_SECRET: secret.toString('hex') };
    const second = minter().mintWithPayloadSync({
        targetAgentId: PROVIDER, path: TERMINAL_PATH, purpose: HELLO, nonce: N1,
    }).token;
    const frameCache = createRouterServiceReplayCache();
    const result = verifyRouterServiceTokenFromFrame(second, {
        env, purpose: HELLO, path: TERMINAL_PATH, expectedNonce: N1, replayCache: frameCache,
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.payload.nonce, N1);
    assert.equal(frameCache.size(), 1);
    const replay = verifyRouterServiceTokenFromFrame(second, {
        env, purpose: HELLO, path: TERMINAL_PATH, expectedNonce: N1, replayCache: frameCache,
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.code, 'ROUTER_SERVICE_TOKEN_REPLAYED');
    assert.equal(verifyRouterServiceTokenFromFrame('', { env, purpose: HELLO, path: TERMINAL_PATH, expectedNonce: N1, replayCache: frameCache }).ok, false);
});

test('hello with the wrong nonce is refused before its jti is consumed', (t) => {
    atTime(t);
    const cache = createRouterServiceReplayCache();
    const token = forgeHello({ nonce: N1 });
    assertRefused(
        () => verifyRouterServiceToken(token, helloOptions({ expectedNonce: N2, replayCache: cache })),
        /nonce does not match this connection/,
    );
    assert.equal(cache.size(), 0, 'a nonce mismatch consumes no jti');
    // The same token is still usable on the connection it was minted for.
    verifyRouterServiceToken(token, helloOptions({ expectedNonce: N1, replayCache: cache }));
    assert.equal(cache.size(), 1);
});

test('a hello token consumed in one cache is refused for another connection nonce after a same-second restart', (t) => {
    atTime(t);
    const service = minter();
    const { token } = service.mintWithPayloadSync({
        targetAgentId: PROVIDER, path: TERMINAL_PATH, purpose: HELLO, nonce: N1,
    });
    const cacheA = createRouterServiceReplayCache();
    verifyRouterServiceToken(token, helloOptions({ expectedNonce: N1, replayCache: cacheA }));
    assert.equal(cacheA.size(), 1);

    // Worker restart within the same second: fresh cache, generation start
    // equal to iat, and a new connection with a new nonce.
    const cacheB = createRouterServiceReplayCache();
    assertRefused(
        () => verifyRouterServiceToken(token, helloOptions({ expectedNonce: N2, replayCache: cacheB, generationStartMs: T0 })),
        /nonce does not match this connection/,
    );
    assert.equal(cacheB.size(), 0);
});

test('hello replay after exp, within skew, with the same nonce is refused by the jti', (t) => {
    atTime(t, T0);
    const cache = createRouterServiceReplayCache();
    const { token } = minter().mintWithPayloadSync({
        targetAgentId: PROVIDER, path: TERMINAL_PATH, purpose: HELLO, nonce: N1,
    });
    verifyRouterServiceToken(token, helloOptions({ replayCache: cache }));
    for (const offset of [1_000, 31_000, 59_000, 60_000]) {
        t.mock.timers.setTime(T0 + offset);
        assertRefused(() => verifyRouterServiceToken(token, helloOptions({ replayCache: cache })), /already been consumed/);
    }
    t.mock.timers.setTime(T0 + 61_000);
    assertRefused(() => verifyRouterServiceToken(token, helloOptions({ replayCache: cache })), /token expired/);
});

test('cross-purpose tokens are refused both ways and the header carrier follows the verifier purpose', (t) => {
    atTime(t);
    const service = minter();
    const upgrade = service.mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH }).token;
    const hello = service.mintWithPayloadSync({
        targetAgentId: PROVIDER, path: TERMINAL_PATH, purpose: HELLO, nonce: N1,
    }).token;
    const cache = createRouterServiceReplayCache();
    // Upgrade token presented as a hello token.
    assertRefused(() => verifyRouterServiceToken(upgrade, helloOptions({ replayCache: cache })), /purpose mismatch/);
    // Hello token presented as an upgrade token (its nonce claim is refused first).
    assertRefused(() => verifyRouterServiceToken(hello, verifyOptions({ replayCache: cache })), /unexpected claim 'nonce'/);
    // Hello token in the header, verified for the upgrade purpose.
    const env = { PLOINKY_AGENT_ID: PROVIDER, PLOINKY_AGENT_SECRET: secret.toString('hex') };
    const viaHeader = verifyRouterServiceTokenFromHeaders(
        { 'x-ploinky-auth-info': JSON.stringify({ routerServiceToken: hello }) },
        { env, purpose: PURPOSE, path: TERMINAL_PATH, generationStartMs: T0 - 5000, replayCache: cache },
    );
    assert.equal(viaHeader.ok, false);
    assert.match(viaHeader.reason, /unexpected claim 'nonce'/);
    assert.equal(cache.size(), 0);

    // expectedNonce is required exactly for the hello purpose.
    for (const [overrides, pattern] of [
        [{ purpose: HELLO, expectedNonce: undefined }, /expectedNonce/],
        [{ purpose: HELLO, expectedNonce: 'short' }, /expectedNonce/],
        [{ purpose: HELLO, expectedNonce: `${N1.slice(0, 42)}B` }, /expectedNonce/],
        [{ purpose: PURPOSE, expectedNonce: N1 }, /only valid for the hello purpose/],
    ]) {
        assert.throws(() => verifyRouterServiceToken(hello, verifyOptions(overrides)), (error) => {
            assert.match(error.message, pattern);
            assert.equal(error.code, 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
            return true;
        });
    }
});

test('a router-request token presented as a hello token is refused by type', async (t) => {
    atTime(t);
    const routerRequest = new RouterRequestTokenService({ resolveAgentSecret: () => secret });
    const { token } = await routerRequest.mintWithPayload({
        targetAgentId: PROVIDER,
        sub: 'user:alice',
        actor: { kind: 'user', id: 'user:alice', roles: ['admin'] },
        method: 'GET',
        path: TERMINAL_PATH,
        tool: '__http_route__',
        rch: computeRouterServiceRch({ method: 'GET', path: TERMINAL_PATH }),
    });
    const cache = createRouterServiceReplayCache();
    assertRefused(() => verifyRouterServiceToken(token, helloOptions({ replayCache: cache })), /token type is not router-service/);
    assertRefused(
        () => verifyRouterServiceToken(forgeHello({ typ: 'router-request' }), helloOptions({ replayCache: cache })),
        /token type is not router-service/,
    );
    assert.equal(cache.size(), 0);
});

test('verifier refuses an expired token, a lifetime over 30 s and non-integer times', (t) => {
    atTime(t, T0);
    const cache = createRouterServiceReplayCache();
    const token = minter().mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH }).token;
    // exp + skew = IAT + 60. One second later the token is expired.
    t.mock.timers.setTime(T0 + 61_000);
    assertRefused(() => verifyRouterServiceToken(token, verifyOptions({ replayCache: cache })), /token expired/);
    assert.equal(cache.size(), 0, 'a refused token consumes no jti');

    t.mock.timers.setTime(T0);
    assertRefused(() => verifyRouterServiceToken(forge({ exp: IAT + 31 }), verifyOptions()), /lifetime exceeds max/);
    assertRefused(() => verifyRouterServiceToken(forge({ iat: IAT + 0.5, exp: IAT + 30 }), verifyOptions()), /must be integers/);
    assertRefused(() => verifyRouterServiceToken(forge({ exp: IAT }), verifyOptions()), /exp after iat/);
    assertRefused(() => verifyRouterServiceToken(forge({}, { remove: ['jti'] }), verifyOptions()), /jti (is )?missing/);
});

test('jti replay is refused until exp + skew, with a fresh token accepted at the same instant', (t) => {
    atTime(t, T0);
    const cache = createRouterServiceReplayCache();
    const service = minter();
    const token = service.mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH }).token;
    verifyRouterServiceToken(token, verifyOptions({ replayCache: cache }));
    assertRefused(() => verifyRouterServiceToken(token, verifyOptions({ replayCache: cache })), /already been consumed/);

    // Past exp (IAT + 30) but within exp + skew (IAT + 60): still time-valid,
    // so only the replay cache refuses it.
    t.mock.timers.setTime(T0 + 59_000);
    assertRefused(() => verifyRouterServiceToken(token, verifyOptions({ replayCache: cache })), /already been consumed/);
    t.mock.timers.setTime(T0 + 60_000);
    assertRefused(() => verifyRouterServiceToken(token, verifyOptions({ replayCache: cache })), /already been consumed/);
    const fresh = service.mintWithPayloadSync({ targetAgentId: PROVIDER, path: TERMINAL_PATH }).token;
    assert.equal(verifyRouterServiceToken(fresh, verifyOptions({ replayCache: cache })).payload.typ, 'router-service');
    assertRefused(() => verifyRouterServiceToken(fresh, verifyOptions({ replayCache: cache })), /already been consumed/);
});

test('refused tokens do not consume their jti', (t) => {
    atTime(t);
    const cache = createRouterServiceReplayCache();
    const token = forge();
    assertRefused(
        () => verifyRouterServiceToken(token, verifyOptions({ replayCache: cache, path: '/terminals/other' })),
        /path mismatch/,
    );
    assertRefused(
        () => verifyRouterServiceToken(token, verifyOptions({ replayCache: cache, generationStartMs: T0 + 1000 })),
        /issued before/,
    );
    assert.equal(cache.size(), 0);
    verifyRouterServiceToken(token, verifyOptions({ replayCache: cache }));
    assert.equal(cache.size(), 1);
});

test('verifier fails closed when misconfigured', (t) => {
    atTime(t);
    const token = forge();
    const cases = [
        [{ secret: secret.toString('hex') }, /secret \(Buffer\)/],
        [{ secret: undefined }, /secret \(Buffer\)/],
        [{ expectedAudience: '' }, /expectedAudience is required/],
        [{ path: '' }, /path is required/],
        [{ path: undefined }, /path is required/],
        [{ purpose: 'other' }, /not a Router-service purpose/],
        [{ generationStartMs: undefined }, /generationStartMs/],
        [{ generationStartMs: Number.NaN }, /generationStartMs/],
        [{ generationStartMs: String(T0) }, /generationStartMs/],
        [{ replayCache: undefined }, /replayCache/],
        [{ replayCache: { seen() { return false; }, remember() {} } }, /replayCache/],
    ];
    for (const [overrides, pattern] of cases) {
        assert.throws(() => verifyRouterServiceToken(token, verifyOptions(overrides)), (error) => {
            assert.match(error.message, pattern);
            assert.equal(error.code, 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
            return true;
        });
    }
    const missingEnv = verifyRouterServiceTokenFromHeaders(
        { 'x-ploinky-auth-info': JSON.stringify({ routerServiceToken: token }) },
        { env: {}, purpose: PURPOSE, path: TERMINAL_PATH, generationStartMs: T0, replayCache: createRouterServiceReplayCache() },
    );
    assert.equal(missingEnv.ok, false);
    assert.match(missingEnv.reason, /PLOINKY_AGENT_SECRET/);
});
