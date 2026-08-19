import { verifyJws } from './jwtVerify.mjs';

/**
 * requestSignedTokens.mjs — verifiers for the request-bound JWT families
 * (DS015): Router Request (router → target agent) and Agent Assertion (source
 * agent → router).
 *
 * These live under `Agent/lib/` (mounted into every agent container) rather than
 * in achillesAgentLib, because the container's achillesAgentLib is an
 * independently npm-installed upstream copy that does not carry these additions.
 * They build only on `verifyJws`, which IS part of the upstream achillesAgentLib
 * the container provides, so router and agent run the identical verification.
 *
 * Each reuses `verifyJws` for signature, time, audience, and replay, then binds
 * the token to one concrete request (type, issuer, method, path, optional tool,
 * and the request-content-hash). A valid HMAC with the wrong type, audience,
 * method, path, tool, or `rch` is rejected. `bodyObject` is NOT passed, so the
 * legacy `bh` check is skipped in favor of `rch`.
 */

export function verifyRouterRequestToken(token, {
    secret,
    expectedAudience,
    method,
    path,
    tool,
    rch,
    replayCache,
    clockSkewSeconds,
    maxTtlSeconds = 60,
} = {}) {
    const result = verifyJws(token, {
        secret,
        expectedAudience,
        replayCache,
        clockSkewSeconds,
        maxTtlSeconds,
    });
    const payload = result.payload || {};
    if (payload.typ !== 'router-request') {
        throw new Error('jwtVerify: token type is not router-request');
    }
    if (payload.iss !== 'ploinky-router') {
        throw new Error(`jwtVerify: issuer mismatch (want ploinky-router, got ${payload.iss})`);
    }
    if (method !== undefined && String(payload.method || '') !== String(method)) {
        throw new Error('jwtVerify: method mismatch');
    }
    if (path !== undefined && String(payload.path || '') !== String(path)) {
        throw new Error('jwtVerify: path mismatch');
    }
    if (tool !== undefined && String(payload.tool || '') !== String(tool)) {
        throw new Error('jwtVerify: tool mismatch');
    }
    if (rch !== undefined && String(payload.rch || '') !== String(rch)) {
        throw new Error('jwtVerify: request hash mismatch');
    }
    return result;
}

export function verifyAgentAssertionToken(token, {
    secret,
    expectedAudience = 'ploinky-router',
    method,
    path,
    tool,
    rch,
    replayCache,
    clockSkewSeconds,
    maxTtlSeconds = 60,
} = {}) {
    const result = verifyJws(token, {
        secret,
        expectedAudience,
        replayCache,
        clockSkewSeconds,
        maxTtlSeconds,
    });
    const payload = result.payload || {};
    if (payload.typ !== 'agent-assertion') {
        throw new Error('jwtVerify: token type is not agent-assertion');
    }
    const iss = String(payload.iss || '');
    if (!iss) {
        throw new Error('jwtVerify: agent assertion missing issuer');
    }
    if (String(payload.sub || '') !== iss) {
        throw new Error('jwtVerify: agent assertion sub must equal iss');
    }
    if (method !== undefined && String(payload.method || '') !== String(method)) {
        throw new Error('jwtVerify: method mismatch');
    }
    if (path !== undefined && String(payload.path || '') !== String(path)) {
        throw new Error('jwtVerify: path mismatch');
    }
    if (tool !== undefined && String(payload.tool || '') !== String(tool)) {
        throw new Error('jwtVerify: tool mismatch');
    }
    if (rch !== undefined && String(payload.rch || '') !== String(rch)) {
        throw new Error('jwtVerify: request hash mismatch');
    }
    return result;
}

export default {
    verifyRouterRequestToken,
    verifyAgentAssertionToken,
};
