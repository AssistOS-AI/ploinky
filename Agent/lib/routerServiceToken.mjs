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
export const ROUTER_SERVICE_PURPOSES = Object.freeze([EXECUTION_PROVIDER_TERMINAL_PURPOSE]);
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

// The complete claim set the minter emits; any other claim is refused.
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

const ALLOWED_CLAIMS = new Set(ROUTER_SERVICE_CLAIMS);
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
 * Verify a Router-service token for one purpose, audience and path, against the
 * start of the current worker generation, and consume its jti.
 *
 * Every claim check runs before the jti is consumed, so a refused token leaves
 * the replay cache unchanged. Throws on refusal; returns `{ header, payload }`.
 */
export function verifyRouterServiceToken(token, {
    secret,
    expectedAudience,
    purpose,
    path,
    generationStartMs,
    replayCache,
} = {}) {
    if (!secret || !Buffer.isBuffer(secret)) {
        throw refuse('secret (Buffer) is required', 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
    }
    requireText(expectedAudience, 'expectedAudience');
    requireText(path, 'path');
    if (!isRouterServicePurpose(purpose)) {
        throw refuse('purpose is not a Router-service purpose', 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
    }
    if (typeof generationStartMs !== 'number' || !Number.isFinite(generationStartMs)) {
        throw refuse('generationStartMs must be a finite number', 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED');
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
    for (const claim of Object.keys(payload)) {
        if (!ALLOWED_CLAIMS.has(claim)) {
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
    // Whole seconds: refuse a token issued before the current worker generation.
    if (payload.iat < Math.floor(generationStartMs / 1000)) {
        throw refuse('token was issued before the current worker generation started');
    }
    if (typeof payload.jti !== 'string' || !payload.jti || payload.jti.length > MAX_JTI_LENGTH) {
        throw refuse('jti is missing or invalid');
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
 * Header-level verification for a provider worker: the agent's own secret and
 * id come from its environment. Returns `{ ok: true, payload }` or
 * `{ ok: false, reason[, code] }`; never throws for a refused token.
 */
export function verifyRouterServiceTokenFromHeaders(headers = {}, {
    env = process.env,
    purpose,
    path,
    generationStartMs,
    replayCache,
} = {}) {
    const read = readRouterServiceTokenFromHeaders(headers);
    if (!read.ok) return read;
    const secret = readAgentSecret(env);
    if (!secret) return { ok: false, reason: 'PLOINKY_AGENT_SECRET not configured' };
    const expectedAudience = expectedAudienceForSelf(env);
    if (!expectedAudience) return { ok: false, reason: 'PLOINKY_AGENT_ID not configured' };
    try {
        const { payload } = verifyRouterServiceToken(read.token, {
            secret,
            expectedAudience,
            purpose,
            path,
            generationStartMs,
            replayCache,
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

export default {
    ROUTER_SERVICE_TOKEN_TYPE,
    ROUTER_SERVICE_ISSUER,
    ROUTER_SERVICE_METHOD,
    ROUTER_SERVICE_TTL_SECONDS,
    ROUTER_SERVICE_CLOCK_SKEW_SECONDS,
    EXECUTION_PROVIDER_TERMINAL_PURPOSE,
    ROUTER_SERVICE_PURPOSES,
    ROUTER_SERVICE_AUTH_INFO_KEY,
    ROUTER_SERVICE_FORBIDDEN_CLAIMS,
    ROUTER_SERVICE_CLAIMS,
    isRouterServicePurpose,
    computeRouterServiceRch,
    createRouterServiceReplayCache,
    verifyRouterServiceToken,
    readRouterServiceTokenFromHeaders,
    verifyRouterServiceTokenFromHeaders,
};
