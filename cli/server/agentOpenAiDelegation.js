import { resolveEnabledAgentRecord } from '../services/agents.js';
import { deriveAgentPrincipalId } from '../services/agentIdentity.js';
import { verifyAgentAssertion, buildRouterRequest } from './mcp-proxy/invocationMinter.js';
import { createTokenReplayCache } from './security/tokens/JwsCodec.js';
import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import {
    OPENAI_CHAT_COMPLETIONS_TOOL,
    OPENAI_CHAT_COMPLETIONS_PATH,
} from '../../Agent/lib/invocationAuth.mjs';
import {
    proxyHttpBuffered,
    readRequestBody,
    resolveHttpServiceInvocationMaxBodyBytes,
} from './routerHandlers.js';

/**
 * agentOpenAiDelegation.js — router-mediated agent-to-agent OpenAI calls.
 *
 * A Soul Gateway agent (or any agent) POSTs `/<routeKey>/v1/chat/completions`
 * carrying an HTTP Agent Assertion (`Authorization: Bearer <jwt>`) whose `rch`
 * binds the EXACT request body bytes via computeRchHttp(). The router:
 *   1. buffers the raw body ONCE,
 *   2. verifies the assertion against those exact bytes + the fixed OpenAI surface,
 *   3. mints a Router Request token (signed with the TARGET agent's secret) bound
 *      to the SAME bytes, and places it in `x-ploinky-auth-info`,
 *   4. forwards the identical bytes upstream.
 *
 * The delegated bypass is path-exact: ONLY `/<routeKey>/v1/chat/completions`. No
 * other agent-prefixed HTTP path may use this delegated assertion path. Any client
 * `x-ploinky-auth-info` is stripped by the buffered-proxy header builder before the
 * router sets its own (router-owned) value (see stripRouterIdentityHeaders in
 * routerHandlers.js, applied inside proxyHttpBuffered).
 */

// Process-wide replay cache so a captured assertion `jti` cannot be reused across
// requests. Created once at module scope (NOT per request) — a per-request cache
// would make replay protection a no-op.
const assertionReplayCache = createTokenReplayCache({ maxSize: 4096 });

function readAuthorizationBearer(req) {
    const raw = req?.headers?.authorization ?? req?.headers?.Authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return /^bearer\s+/i.test(trimmed) ? trimmed.replace(/^bearer\s+/i, '').trim() : '';
}

function hasDelegatedAgentAssertion(req) {
    return Boolean(readAuthorizationBearer(req));
}

/**
 * Path-exact, method-exact predicate for the delegated agent OpenAI bypass. The
 * `agentProxyPath` is the request path AFTER the `/<routeKey>` mount prefix has
 * been stripped (RoutingServer.buildAgentProxyPath). It must equal exactly
 * `/v1/chat/completions` with no trailing segment and no query string — so neither
 * `/v1/chat/completions/x` nor `/v1/other` nor a query-bearing variant qualifies.
 */
export function isDelegatedAgentOpenAiCall({ agentName, method, agentProxyPath, req } = {}) {
    if (!agentName) return false;
    if (String(method || '').toUpperCase() !== 'POST') return false;
    if (String(agentProxyPath || '') !== OPENAI_CHAT_COMPLETIONS_PATH) return false;
    return hasDelegatedAgentAssertion(req);
}

function resolveRepoAgent(routeKey, route) {
    const repoFromRoute = String(route?.repo || '').trim();
    const agentFromRoute = String(route?.agent || '').trim();
    if (repoFromRoute && agentFromRoute) {
        return { repo: repoFromRoute, agent: agentFromRoute };
    }
    try {
        const resolved = resolveEnabledAgentRecord(routeKey);
        const record = resolved?.record || null;
        const repo = String(record?.repoName || repoFromRoute || '').trim();
        const agent = String(record?.agentName || agentFromRoute || '').trim();
        if (repo && agent) return { repo, agent };
    } catch (_) {
        // fall through
    }
    return null;
}

function resolveTargetAgentPrincipal(routeKey, route) {
    const repoAgent = resolveRepoAgent(routeKey, route);
    if (!repoAgent) return null;
    try {
        return deriveAgentPrincipalId(repoAgent.repo, repoAgent.agent);
    } catch (_) {
        return null;
    }
}

/**
 * Pure, unit-testable verify + mint. Verifies the source agent's HTTP assertion
 * against the EXACT buffered body bytes and the fixed OpenAI surface, then mints a
 * Router Request token bound to the same bytes (rch via computeRchHttp) and signed
 * with the TARGET agent's own secret.
 *
 * `routeKey` is the route name the caller addressed; `route` is its routing entry;
 * `body` is the raw buffered request bytes. Returns
 * `{ ok:true, callerPrincipal, targetAgentId, token, authInfoHeader, bodyHash }`
 * on success, or `{ ok:false, status, error }` on any failure. Never throws.
 */
export function verifyAndMintAgentOpenAiCall({
    token,
    routeKey,
    route,
    body = Buffer.alloc(0),
    replayCache = assertionReplayCache,
} = {}) {
    // The source agent addresses the router by ROUTE KEY (it does not know the
    // internal `agent:<repo>/<agent>` principal), so the assertion binds the route
    // name — mirror verifyDelegatedAgentToolCall, which verifies with the route
    // name. The MINTED Router Request, by contrast, is audienced to the resolved
    // principal and signed with that agent's own secret.
    const targetPrincipal = resolveTargetAgentPrincipal(routeKey, route);
    if (!targetPrincipal) {
        // Fail closed: a route we cannot resolve to an installed agent principal
        // must never receive a forwarded (or minted) identity.
        return { ok: false, status: 404, error: 'agent_not_found' };
    }

    const bodyHash = sha256RawBodyHash(body);
    const rch = computeRchHttp({
        method: 'POST',
        path: OPENAI_CHAT_COMPLETIONS_PATH,
        query: '',
        bodyHash,
    });

    let callerPrincipal;
    try {
        const verified = verifyAgentAssertion({
            token,
            method: 'POST',
            path: OPENAI_CHAT_COMPLETIONS_PATH,
            tool: OPENAI_CHAT_COMPLETIONS_TOOL,
            rch,
            targetAgentId: String(routeKey || ''),
            replayCache,
        });
        callerPrincipal = String(verified.callerPrincipal || '');
    } catch (_) {
        // Never echo the verifier's reason — an agent-only path must not help a
        // caller probe why its assertion was rejected.
        return { ok: false, status: 401, error: 'agent_assertion_required' };
    }

    // Mint the Router Request bound to the SAME rch/body, signed with the target
    // agent's own secret. The source agent is the acting principal (a2a call); the
    // raw assertion is never forwarded onward.
    const sub = callerPrincipal;
    const actor = { kind: 'agent', id: callerPrincipal, roles: [] };
    const caller = { kind: 'agent', id: callerPrincipal, roles: ['agent'] };
    let token2;
    try {
        const minted = buildRouterRequest({
            targetAgentId: targetPrincipal,
            sub,
            actor,
            caller,
            method: 'POST',
            path: OPENAI_CHAT_COMPLETIONS_PATH,
            tool: OPENAI_CHAT_COMPLETIONS_TOOL,
            rch,
        });
        token2 = minted.token;
    } catch (_) {
        return { ok: false, status: 500, error: 'router_request_unavailable' };
    }

    const invocationBody = {
        method: 'POST',
        path: OPENAI_CHAT_COMPLETIONS_PATH,
        search: '',
        routeKey: String(routeKey || ''),
        bodyHash,
    };
    const authInfoHeader = {
        'x-ploinky-auth-info': JSON.stringify({
            invocationToken: token2,
            invocationBody,
        }),
    };

    return {
        ok: true,
        callerPrincipal,
        targetAgentId: targetPrincipal,
        token: token2,
        authInfoHeader,
        bodyHash,
    };
}

function sendJson(res, statusCode, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
    });
    res.end(data);
}

/**
 * HTTP orchestrator for a verified delegated agent OpenAI call. Buffers the raw
 * body ONCE, verifies + mints against those exact bytes, then forwards the
 * IDENTICAL bytes upstream with the router-owned `x-ploinky-auth-info` token.
 * Caller has already confirmed isDelegatedAgentOpenAiCall(...) is true.
 *
 * `agentProxyPath` is the post-prefix upstream path; for this bypass it is always
 * `/v1/chat/completions`.
 */
export function handleDelegatedAgentOpenAiCall(req, res, route, routeKey, agentProxyPath, {
    replayCache = assertionReplayCache,
} = {}) {
    if (!route || !route.hostPort) {
        sendJson(res, 404, { error: 'agent_not_found', agent: routeKey });
        return;
    }
    const token = readAuthorizationBearer(req);
    readRequestBody(req, {
        maxBytes: resolveHttpServiceInvocationMaxBodyBytes(),
        onSuccess: (body) => {
            const result = verifyAndMintAgentOpenAiCall({
                token,
                routeKey,
                route,
                body,
                replayCache,
            });
            if (!result.ok) {
                sendJson(res, result.status, { error: result.error });
                return;
            }
            // proxyHttpBuffered strips any client x-ploinky-auth-info (via
            // stripRouterIdentityHeaders) and then applies the router-owned header,
            // forwarding the EXACT buffered bytes (content-length set, no re-encode).
            proxyHttpBuffered(req, res, route.hostPort, agentProxyPath, body, result.authInfoHeader);
        },
        onTooLarge: ({ limitBytes }) => {
            sendJson(res, 413, { error: 'openai_body_too_large', limitBytes });
        },
        onError: (err) => {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: 'request error', detail: String(err) }));
        },
    });
}

export default {
    isDelegatedAgentOpenAiCall,
    verifyAndMintAgentOpenAiCall,
    handleDelegatedAgentOpenAiCall,
    OPENAI_CHAT_COMPLETIONS_TOOL,
    OPENAI_CHAT_COMPLETIONS_PATH,
};
