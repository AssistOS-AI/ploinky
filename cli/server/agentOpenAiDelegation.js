import { resolveEnabledAgentRecord } from '../utils/agents.js';
import { deriveAgentPrincipalId } from '../utils/security/agentIdentity.js';
import { verifyAgentAssertion, buildRouterRequest } from './mcp-proxy/invocationMinter.js';
import { createTokenReplayCache } from './security/tokens/JwsCodec.js';
import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import {
    OPENAI_CHAT_COMPLETIONS_TOOL,
    OPENAI_CHAT_COMPLETIONS_PATH,
    OPENAI_MODELS_TOOL,
    OPENAI_MODELS_PATH,
} from '../../Agent/lib/invocationAuth.mjs';
import {
    proxyHttpBuffered,
    readRequestBody,
    resolveHttpRouteInvocationMaxBodyBytes,
} from './routerHandlers.js';

/**
 * agentOpenAiDelegation.js — router-mediated agent-to-agent OpenAI calls.
 *
 * A gateway consumer agent (or any agent) POSTs `/<routeKey>/v1/chat/completions`
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

export const MAX_AGENTIC_DEPTH = 3;
const AGENTIC_DEPTH_HEADER = 'x-ploinky-agentic-depth';
const OPENAI_SURFACES = Object.freeze({
    chat: {
        method: 'POST',
        path: OPENAI_CHAT_COMPLETIONS_PATH,
        tool: OPENAI_CHAT_COMPLETIONS_TOOL,
        bodyTooLargeError: 'openai_body_too_large',
    },
    models: {
        method: 'GET',
        path: OPENAI_MODELS_PATH,
        tool: OPENAI_MODELS_TOOL,
        bodyTooLargeError: 'openai_models_body_too_large',
    },
});

export function readAgenticDepth(headers = {}) {
    const raw = headers[AGENTIC_DEPTH_HEADER];
    const n = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export function nextAgenticDepthHeaders(headers = {}) {
    return { ...headers, [AGENTIC_DEPTH_HEADER]: String(readAgenticDepth(headers) + 1) };
}

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
    const surface = resolveOpenAiSurface(method, agentProxyPath);
    if (!surface) return false;
    return hasDelegatedAgentAssertion(req);
}

function resolveOpenAiSurface(method, agentProxyPath) {
    const normalizedMethod = String(method || '').toUpperCase();
    const normalizedPath = String(agentProxyPath || '');
    for (const surface of Object.values(OPENAI_SURFACES)) {
        if (normalizedMethod === surface.method && normalizedPath === surface.path) {
            return surface;
        }
    }
    return null;
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
    method = 'POST',
    path = OPENAI_CHAT_COMPLETIONS_PATH,
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
    const surface = resolveOpenAiSurface(method, path) || OPENAI_SURFACES.chat;
    const rch = computeRchHttp({
        method: surface.method,
        path: surface.path,
        query: '',
        bodyHash,
    });

    let callerPrincipal;
    try {
        const verified = verifyAgentAssertion({
            token,
            method: surface.method,
            path: surface.path,
            tool: surface.tool,
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
            method: surface.method,
            path: surface.path,
            tool: surface.tool,
            rch,
        });
        token2 = minted.token;
    } catch (_) {
        return { ok: false, status: 500, error: 'router_request_unavailable' };
    }

    const invocationBody = {
        method: surface.method,
        path: surface.path,
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
    dialContext = null,
} = {}) {
    if (!route || !route.hostPort) {
        sendJson(res, 404, { error: 'agent_not_found', agent: routeKey });
        return;
    }
    if (readAgenticDepth(req.headers) >= MAX_AGENTIC_DEPTH) {
        sendJson(res, 400, { error: { message: `agentic recursion depth exceeded (${MAX_AGENTIC_DEPTH})`, type: 'invalid_request_error' } });
        return;
    }
    const token = readAuthorizationBearer(req);
    readRequestBody(req, {
        maxBytes: resolveHttpRouteInvocationMaxBodyBytes(),
        onSuccess: (body) => {
            const surface = resolveOpenAiSurface(req.method, agentProxyPath);
            if (!surface) {
                sendJson(res, 404, { error: 'not_found' });
                return;
            }
            const result = verifyAndMintAgentOpenAiCall({
                token,
                routeKey,
                route,
                body,
                method: surface.method,
                path: surface.path,
                replayCache,
            });
            if (!result.ok) {
                sendJson(res, result.status, { error: result.error });
                return;
            }
            // proxyHttpBuffered strips any client x-ploinky-auth-info (via
            // stripRouterIdentityHeaders) and then applies the router-owned header,
            // forwarding the EXACT buffered bytes (content-length set, no re-encode).
            proxyHttpBuffered(req, res, route.hostPort, agentProxyPath, body, {
                ...result.authInfoHeader,
                [AGENTIC_DEPTH_HEADER]: String(readAgenticDepth(req.headers) + 1),
            }, { dialContext });
        },
        onTooLarge: ({ limitBytes }) => {
            const surface = resolveOpenAiSurface(req.method, agentProxyPath) || OPENAI_SURFACES.chat;
            sendJson(res, 413, { error: surface.bodyTooLargeError, limitBytes });
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
    MAX_AGENTIC_DEPTH,
    readAgenticDepth,
    nextAgenticDepthHeaders,
    isDelegatedAgentOpenAiCall,
    verifyAndMintAgentOpenAiCall,
    handleDelegatedAgentOpenAiCall,
    OPENAI_CHAT_COMPLETIONS_TOOL,
    OPENAI_CHAT_COMPLETIONS_PATH,
    OPENAI_MODELS_TOOL,
    OPENAI_MODELS_PATH,
};
