import { timingSafeEqual } from 'node:crypto';

import { verifyJws } from './jwtVerify.mjs';
import { createBoundedReplayCache, legacyMinRetentionMs, MAX_JTI_LENGTH } from './replayCache.mjs';
import { computeRch } from './requestHash.mjs';
import { expectedAudienceForSelf, parseHttpRouteAuthInfo, readAgentSecret } from './invocationAuth.mjs';

/**
 * routerServiceToken.mjs — the Router-service token (`typ: 'router-service'`)
 * and its provider-side verifier.
 *
 * The Router mints this token, with the target agent's own per-agent secret,
 * only for a Router-internal service channel such as the execution-provider
 * terminal endpoint. It names a purpose and carries no identity: no actor,
 * subject, tool, user, caller, scope or delegation. Router Request tokens
 * (`typ: 'router-request'`), which the Router mints for every user- or
 * agent-routed invocation, are therefore never accepted here.
 *
 * The minter (`cli/server/security/tokens/RouterServiceTokenService.js`) and
 * this verifier share the constants and `computeRouterServiceRch` below. This
 * module lives under `Agent/` (mounted standalone into agent runtimes) and must
 * never import from `cli/`.
 */

export const ROUTER_SERVICE_TOKEN_TYPE = 'router-service';
export const ROUTER_SERVICE_ISSUER = 'ploinky-router';
export const ROUTER_SERVICE_METHOD = 'GET';
export const ROUTER_SERVICE_TTL_SECONDS = 30;
export const ROUTER_SERVICE_CLOCK_SKEW_SECONDS = 30;
export const EXECUTION_PROVIDER_TERMINAL_PURPOSE = 'execution-provider-terminal';
// Second token of a terminal control connection: bound to that connection's
// challenge nonce and carried inside the `hello` or `reattach` frame.
export const EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE = 'execution-provider-terminal-hello';
export const ROUTER_SERVICE_PURPOSES = Object.freeze([
    EXECUTION_PROVIDER_TERMINAL_PURPOSE,
    EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE,
]);
// Key of the token inside the Router-only `x-ploinky-auth-info` header.
export const ROUTER_SERVICE_AUTH_INFO_KEY = 'routerServiceToken';

// Identity and route-invocation claims a Router-service token never carries.
// Presence alone refuses the token, whatever the value (Router Request tokens
// carry `sub: ''`).
export const ROUTER_SERVICE_FORBIDDEN_CLAIMS = Object.freeze([
    'actor',
    'sub',
    'tool',
    'delegation',
    'delegations',
    'usr',
    'caller',
    'scope',
]);

// The complete claim set the minter emits for the upgrade purpose; any other
// claim is refused. The hello purpose adds exactly `nonce` (see below).
export const ROUTER_SERVICE_CLAIMS = Object.freeze([
    'typ',
    'iss',
    'aud',
    'purpose',
    'method',
    'path',
    'rch',
    'jti',
    'iat',
    'exp',
]);

export const ROUTER_SERVICE_HELLO_CLAIMS = Object.freeze([...ROUTER_SERVICE_CLAIMS, 'nonce']);

const ALLOWED_CLAIMS = new Set(ROUTER_SERVICE_CLAIMS);
const ALLOWED_HELLO_CLAIMS = new Set(ROUTER_SERVICE_HELLO_CLAIMS);
const REPLAY_MARGIN_MS = 2000;

// Retention that covers the whole acceptance window of any accepted token: a
// token may be issued up to the skew in the future and stays acceptable until
// exp + skew.
const REPLAY_FLOOR_MS = legacyMinRetentionMs({
    maxTtlSeconds: ROUTER_SERVICE_TTL_SECONDS,
    clockSkewSeconds: ROUTER_SERVICE_CLOCK_SKEW_SECONDS,
    marginMs: REPLAY_MARGIN_MS,
});

export function isRouterServicePurpose(purpose) {
    return typeof purpose === 'string' && ROUTER_SERVICE_PURPOSES.includes(purpose);
}

/**
 * A connection nonce: 43 base64url characters that decode to exactly 32 bytes
 * and re-encode to the same text.
 */
export function isRouterServiceNonce(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === value;
}

/** Request-content hash of a Router-service token: method and path only. */
export function computeRouterServiceRch({ method, path }) {
    return computeRch({
        method: String(method ?? ''),
        path: String(path ?? ''),
    });
}

/**
 * Bounded, fail-closed jti cache for Router-service tokens. Only the Router
 * holds the agent secret, so only Router-minted tokens can fill it; a full
 * cache refuses new tokens instead of forgetting a live jti.
 */
export function createRouterServiceReplayCache({ maxSize = 4096, now } = {}) {
    return createBoundedReplayCache({
        maxSize,
        legacyMinRetentionMs: REPLAY_FLOOR_MS,
        ...(now ? { now } : {}),
    });
}

function refuse(message, code = 'ROUTER_SERVICE_TOKEN_REFUSED') {
    const error = new Error(`routerServiceToken: ${message}`);
    error.code = code;
    return error;
}

function requireText(value, name) {
    if (typeof value !== 'string' || !value) {
        throw refuse(`${name} is required`, 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
    }
    return value;
}

/**
 * Verify a Router-service token for one purpose, audience and path, and
 * consume its jti.
 *
 * The claim set depends on the purpose. The upgrade purpose refuses `nonce`
 * and requires `iat * 1000 >= generationStartMs` (defence in depth; the Router
 * and worker share no clock). The hello purpose requires `nonce` and
 * `expectedNonce` (the nonce this connection's `challenge` issued), applies no
 * generation floor, and refuses a token whose nonce is malformed or differs.
 *
 * Every claim and nonce check runs before the jti is consumed, so a refused
 * token leaves the replay cache unchanged. Throws on refusal; returns
 * `{ header, payload }`.
 */
export function verifyRouterServiceToken(token, {
    secret,
    expectedAudience,
    purpose,
    path,
    generationStartMs,
    replayCache,
    expectedNonce,
} = {}) {
    if (!secret || !Buffer.isBuffer(secret)) {
        throw refuse('secret (Buffer) is required', 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
    }
    requireText(expectedAudience, 'expectedAudience');
    requireText(path, 'path');
    if (!isRouterServicePurpose(purpose)) {
        throw refuse('purpose is not a Router-service purpose', 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
    }
    const isHello = purpose === EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE;
    if (isHello) {
        if (!isRouterServiceNonce(expectedNonce)) {
            throw refuse('expectedNonce (32-byte base64url) is required for the hello purpose',
                'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
        }
    } else {
        if (expectedNonce !== undefined) {
            throw refuse('expectedNonce is only valid for the hello purpose', 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
        }
        if (typeof generationStartMs !== 'number' || !Number.isFinite(generationStartMs)) {
            throw refuse('generationStartMs must be a finite number', 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
        }
    }
    if (!replayCache || typeof replayCache.consume !== 'function') {
        throw refuse('replayCache with consume() is required', 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
    }

    const nowMs = Date.now();
    // Signature, iat/exp window (lifetime at most 30 s, 30 s skew) and audience.
    // No cache is passed: the jti is consumed below, after every claim check.
    const result = verifyJws(token, {
        secret,
        expectedAudience,
        clockSkewSeconds: ROUTER_SERVICE_CLOCK_SKEW_SECONDS,
        maxTtlSeconds: ROUTER_SERVICE_TTL_SECONDS,
        now: nowMs,
    });
    const payload = result.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw refuse('payload is not an object');
    }

    if (payload.typ !== ROUTER_SERVICE_TOKEN_TYPE) {
        throw refuse(`token type is not ${ROUTER_SERVICE_TOKEN_TYPE}`);
    }
    for (const claim of ROUTER_SERVICE_FORBIDDEN_CLAIMS) {
        if (Object.hasOwn(payload, claim)) {
            throw refuse(`token carries forbidden claim '${claim}'`);
        }
    }
    const allowedClaims = isHello ? ALLOWED_HELLO_CLAIMS : ALLOWED_CLAIMS;
    for (const claim of Object.keys(payload)) {
        if (!allowedClaims.has(claim)) {
            throw refuse(`token carries unexpected claim '${claim}'`);
        }
    }
    if (payload.iss !== ROUTER_SERVICE_ISSUER) {
        throw refuse('issuer mismatch');
    }
    if (typeof payload.aud !== 'string' || payload.aud !== expectedAudience) {
        throw refuse('audience mismatch');
    }
    if (payload.purpose !== purpose) {
        throw refuse('purpose mismatch');
    }
    if (payload.method !== ROUTER_SERVICE_METHOD) {
        throw refuse('method mismatch');
    }
    if (payload.path !== path) {
        throw refuse('path mismatch');
    }
    if (payload.rch !== computeRouterServiceRch({ method: ROUTER_SERVICE_METHOD, path })) {
        throw refuse('request hash mismatch');
    }
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat) {
        throw refuse('iat/exp must be integers with exp after iat');
    }
    // Upgrade purpose only: refuse a token issued before the current worker
    // generation started (exact boundary, millisecond comparison of whole-second
    // iat). The hello purpose is clock-independent; its nonce and jti suffice.
    if (!isHello && payload.iat * 1000 < generationStartMs) {
        throw refuse('token was issued before the current worker generation started');
    }
    if (typeof payload.jti !== 'string' || !payload.jti || payload.jti.length > MAX_JTI_LENGTH) {
        throw refuse('jti is missing or invalid');
    }
    // Hello purpose: the nonce is checked here, before the jti is consumed, so
    // a token bound to another connection is refused and stays unconsumed.
    if (isHello) {
        if (!isRouterServiceNonce(payload.nonce)) {
            throw refuse('nonce is missing or malformed');
        }
        if (!timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(expectedNonce))) {
            throw refuse('nonce does not match this connection');
        }
    }

    // Retain the jti until at least exp + skew (plus margin), never less than
    // the floor that covers any acceptable token.
    const untilAcceptanceEndsMs = ((payload.exp + ROUTER_SERVICE_CLOCK_SKEW_SECONDS) * 1000) - nowMs + REPLAY_MARGIN_MS;
    if (!replayCache.consume(payload.jti, Math.max(REPLAY_FLOOR_MS, untilAcceptanceEndsMs))) {
        throw refuse('jti has already been consumed', 'ROUTER_SERVICE_TOKEN_REPLAYED');
    }
    return result;
}

/**
 * Read the Router-service token from the trusted `x-ploinky-auth-info` header,
 * whose value must be exactly `{ "routerServiceToken": "<jws>" }`. The Router
 * strips caller-supplied `x-ploinky-*` headers, so only it can set this one.
 */
export function readRouterServiceTokenFromHeaders(headers = {}) {
    const parsed = parseHttpRouteAuthInfo(headers);
    if (!parsed.ok) return parsed;
    const keys = Object.keys(parsed.authInfo);
    if (keys.length !== 1 || keys[0] !== ROUTER_SERVICE_AUTH_INFO_KEY) {
        return { ok: false, reason: 'x-ploinky-auth-info must carry only routerServiceToken' };
    }
    const token = parsed.authInfo[ROUTER_SERVICE_AUTH_INFO_KEY];
    if (typeof token !== 'string' || !token.trim()) {
        return { ok: false, reason: 'missing router-service token' };
    }
    return { ok: true, token: token.trim() };
}

/**
 * Frame-level verification for a provider worker: the token arrives inside a
 * control frame (`helloToken`), not a header. The agent's own secret and id
 * come from its environment. Returns `{ ok: true, payload }` or
 * `{ ok: false, reason[, code] }`; never throws for a refused token.
 */
export function verifyRouterServiceTokenFromFrame(token, {
    env = process.env,
    purpose,
    path,
    generationStartMs,
    replayCache,
    expectedNonce,
} = {}) {
    if (typeof token !== 'string' || !token.trim()) {
        return { ok: false, reason: 'missing router-service token' };
    }
    const secret = readAgentSecret(env);
    if (!secret) return { ok: false, reason: 'PLOINKY_AGENT_SECRET not configured' };
    const expectedAudience = expectedAudienceForSelf(env);
    if (!expectedAudience) return { ok: false, reason: 'PLOINKY_AGENT_ID not configured' };
    try {
        const { payload } = verifyRouterServiceToken(token.trim(), {
            secret,
            expectedAudience,
            purpose,
            path,
            generationStartMs,
            replayCache,
            expectedNonce,
        });
        return { ok: true, payload };
    } catch (error) {
        return {
            ok: false,
            reason: error?.message || String(error),
            ...(error?.code ? { code: String(error.code) } : {}),
        };
    }
}

/**
 * Header-level verification (upgrade purpose): reads the token from the
 * trusted `x-ploinky-auth-info` header, then verifies it as a frame token.
 */
export function verifyRouterServiceTokenFromHeaders(headers = {}, {
    env = process.env,
    purpose,
    path,
    generationStartMs,
    replayCache,
    expectedNonce,
} = {}) {
    const read = readRouterServiceTokenFromHeaders(headers);
    if (!read.ok) return read;
    return verifyRouterServiceTokenFromFrame(read.token, {
        env, purpose, path, generationStartMs, replayCache, expectedNonce,
    });
}

export default {
    ROUTER_SERVICE_TOKEN_TYPE,
    ROUTER_SERVICE_ISSUER,
    ROUTER_SERVICE_METHOD,
    ROUTER_SERVICE_TTL_SECONDS,
    ROUTER_SERVICE_CLOCK_SKEW_SECONDS,
    EXECUTION_PROVIDER_TERMINAL_PURPOSE,
    EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE,
    ROUTER_SERVICE_PURPOSES,
    ROUTER_SERVICE_AUTH_INFO_KEY,
    ROUTER_SERVICE_FORBIDDEN_CLAIMS,
    ROUTER_SERVICE_CLAIMS,
    ROUTER_SERVICE_HELLO_CLAIMS,
    isRouterServicePurpose,
    isRouterServiceNonce,
    computeRouterServiceRch,
    createRouterServiceReplayCache,
    verifyRouterServiceToken,
    readRouterServiceTokenFromHeaders,
    verifyRouterServiceTokenFromFrame,
    verifyRouterServiceTokenFromHeaders,
};
