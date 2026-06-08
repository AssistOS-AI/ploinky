import crypto from 'node:crypto';

import { signHmacJwt } from '../../../Agent/lib/jwtSign.mjs';
import { verifyAgentAssertionToken } from '../../../Agent/lib/requestSignedTokens.mjs';
import { deriveAgentRequestSecret } from '../../services/masterKey.js';
import { resolveAgentDescriptor } from '../../services/agentRegistry.js';

/**
 * invocationMinter.js (router side)
 *
 * The router is the sole issuer of Router Request JWTs (typ:"router-request").
 * Each is signed with the TARGET agent's own per-agent secret and bound to one
 * concrete request via `rch` (request-content-hash), so a token minted for one
 * agent/operation cannot be replayed against another. The legacy shared-key
 * `typ:"invocation"` families are removed; the DS013 per-agent model replaces them.
 *
 * `verifyAgentAssertion` authenticates a source agent for agent-to-agent calls by
 * deriving THAT agent's secret from its (untrusted) issuer claim and verifying
 * the assertion — an agent cannot forge an assertion for another agent because it
 * does not hold that agent's secret.
 */

const ROUTER_REQUEST_TTL_SECONDS = 30;
// `agent:<repo>/<agent>` — repo/agent segments contain no `/`, `:`, or whitespace.
const AGENT_PRINCIPAL_RE = /^agent:[^/\s:]+\/[^/\s:]+$/;

function nowSec() { return Math.floor(Date.now() / 1000); }

function normalizeActor(actor) {
    if (!actor || typeof actor !== 'object') {
        return { kind: 'user', id: '', roles: [] };
    }
    const kind = actor.kind === 'agent' || actor.kind === 'guest' ? actor.kind : 'user';
    return {
        kind,
        id: String(actor.id || ''),
        roles: Array.isArray(actor.roles) ? actor.roles.map((r) => String(r || '')).filter(Boolean) : [],
    };
}

export function resolveProviderPrincipal({ providerAgentRef, providerPrincipal }) {
    if (providerPrincipal) return String(providerPrincipal).trim();
    const descriptor = resolveAgentDescriptor(providerAgentRef);
    if (!descriptor) {
        throw new Error(`invocationMinter: could not resolve provider '${providerAgentRef}'`);
    }
    return descriptor.principalId;
}

/**
 * Mint a Router Request JWT (router -> target agent), signed with the target
 * agent's own secret. The caller computes `rch` over the exact request surface
 * the target will execute; the target recomputes and rejects any mismatch.
 */
export function buildRouterRequest({
    targetAgentId,
    sub,
    actor,
    method,
    path,
    tool,
    rch,
    ttlSeconds,
}) {
    const target = String(targetAgentId || '').trim();
    if (!target) throw new Error('invocationMinter: targetAgentId required');
    if (!method) throw new Error('invocationMinter: method required');
    if (!path) throw new Error('invocationMinter: path required');
    if (!rch) throw new Error('invocationMinter: rch required');
    const iat = nowSec();
    const ttl = Math.max(5, Math.min(Number(ttlSeconds) || ROUTER_REQUEST_TTL_SECONDS, ROUTER_REQUEST_TTL_SECONDS));
    const payload = {
        typ: 'router-request',
        iss: 'ploinky-router',
        aud: target,
        sub: String(sub || ''),
        actor: normalizeActor(actor),
        method: String(method),
        path: String(path),
        rch: String(rch),
        jti: crypto.randomBytes(16).toString('base64url'),
        iat,
        exp: iat + ttl,
    };
    if (tool !== undefined && tool !== null && String(tool) !== '') {
        payload.tool = String(tool);
    }
    const secret = deriveAgentRequestSecret(target, { encoding: 'buffer' });
    const token = signHmacJwt({ payload, secret });
    return { token, payload };
}

/**
 * Verify an Agent Assertion JWT presented by a source agent for an
 * agent-to-agent call. The issuer claim is UNTRUSTED until verified: the router
 * derives the claimed agent's per-agent secret and verifies the signature with
 * it, so an agent that only knows its own secret cannot forge an assertion for
 * another agent. The assertion is bound to this exact request (method/path/tool/
 * `rch`) and, when provided, to the intended target agent.
 *
 * `token` is the raw assertion; `method`/`path`/`tool`/`rch` describe the actual
 * request; `targetAgentId` is the resolved target principal; `replayCache`
 * prevents reuse. Returns `{ callerPrincipal, payload }`.
 */
export function verifyAgentAssertion({ token, method, path, tool, rch, targetAgentId, replayCache }) {
    if (!token) {
        throw new Error('invocationMinter: agent assertion required');
    }
    const parts = String(token).split('.');
    if (parts.length !== 3) {
        throw new Error('invocationMinter: malformed agent assertion');
    }
    let claims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        throw new Error('invocationMinter: malformed agent assertion payload');
    }
    const iss = String(claims?.iss || '');
    if (!AGENT_PRINCIPAL_RE.test(iss)) {
        throw new Error('invocationMinter: agent assertion issuer is not a valid agent id');
    }
    const secret = deriveAgentRequestSecret(iss, { encoding: 'buffer' });
    const { payload } = verifyAgentAssertionToken(token, {
        secret,
        expectedAudience: 'ploinky-router',
        method,
        path,
        tool,
        rch,
        replayCache,
    });
    // The assertion MUST be bound to the addressed target (DS013): require the
    // claim, require a resolved target, and require they match. A target-less
    // assertion (or one for a different agent) is rejected — never accepted as
    // valid for whatever target the router happened to resolve from the URL.
    if (!payload.targetAgent) {
        throw new Error('invocationMinter: agent assertion is missing targetAgent');
    }
    if (!targetAgentId || String(payload.targetAgent) !== String(targetAgentId)) {
        throw new Error('invocationMinter: agent assertion targetAgent mismatch');
    }
    return { callerPrincipal: iss, payload };
}

export default {
    buildRouterRequest,
    resolveProviderPrincipal,
    verifyAgentAssertion
};
