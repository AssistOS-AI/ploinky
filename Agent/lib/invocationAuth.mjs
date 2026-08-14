import { createMemoryReplayCache } from './jwtVerify.mjs';
import { verifyRouterRequestToken } from './requestSignedTokens.mjs';
import { computeRchHttp, sha256RawBodyHash } from './requestHash.mjs';

const httpRouteReplayCache = createMemoryReplayCache({ maxSize: 4096 });
const openAiServiceReplayCache = createMemoryReplayCache({ maxSize: 4096 });
const openAiModelsReplayCache = createMemoryReplayCache({ maxSize: 4096 });

// Tool name the router binds into the Router Request token it mints for a
// verified agent-to-agent OpenAI call. Kept here so router (minter) and agent
// (verifier) share the single source of truth. The HTTP path of an OpenAI chat
// completion is always the agent-internal `/v1/chat/completions`.
export const OPENAI_CHAT_COMPLETIONS_TOOL = '__openai_chat_completions__';
export const OPENAI_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
export const OPENAI_MODELS_TOOL = '__openai_models__';
export const OPENAI_MODELS_PATH = '/v1/models';

export function readHeaderValue(headers = {}, headerName) {
    const unwrap = (value) => {
        const raw = Array.isArray(value) ? value[0] : value;
        return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
    };
    const direct = unwrap(headers?.[headerName]);
    if (direct) {
        return direct;
    }
    return unwrap(headers?.[String(headerName).toLowerCase()]);
}

export function hasInvocationTokenHeader(headers = {}) {
    const auth = readHeaderValue(headers, 'authorization');
    return auth.toLowerCase().startsWith('bearer ');
}

export function expectedAudienceForSelf(env = process.env) {
    // The agent's own canonical id is the audience the router must target.
    const id = String(env?.PLOINKY_AGENT_ID || '').trim();
    if (id) return id;
    const principal = String(env?.PLOINKY_AGENT_PRINCIPAL || '').trim();
    if (principal) return principal;
    const agentName = String(env?.AGENT_NAME || '').trim();
    return agentName ? `agent:${agentName}` : '';
}

export function readAgentSecret(env = process.env) {
    // Agents only ever hold their OWN per-agent secret (PLOINKY_AGENT_SECRET,
    // hex). There is intentionally no fallback to the master or a shared key:
    // that would let one agent forge Router Request tokens for another agent and
    // defeat per-agent isolation (DS014).
    const hex = String(env?.PLOINKY_AGENT_SECRET || '').trim();
    return hex ? Buffer.from(hex, 'hex') : null;
}

export const hashHttpRouteBody = sha256RawBodyHash;

export function parseHttpRouteAuthInfo(headers = {}) {
    const raw = readHeaderValue(headers, 'x-ploinky-auth-info');
    if (!raw) {
        return { ok: false, reason: 'missing x-ploinky-auth-info header' };
    }
    try {
        const authInfo = JSON.parse(raw);
        if (!authInfo || typeof authInfo !== 'object' || Array.isArray(authInfo)) {
            return { ok: false, reason: 'invalid x-ploinky-auth-info header' };
        }
        return { ok: true, authInfo };
    } catch (_) {
        return { ok: false, reason: 'invalid x-ploinky-auth-info header' };
    }
}

// Verify a Router Request JWT (router -> this agent) carried as
// `Authorization: Bearer <token>`. The caller supplies the request surface
// (method, path, tool) and the recomputed `rch`; verification rejects a token
// whose type, audience, method, path, tool, or `rch` does not match — even when
// the HMAC itself is valid.
export function verifyRouterRequestFromHeaders(headers = {}, {
    env = process.env,
    replayCache,
    method,
    path,
    tool,
    rch,
} = {}) {
    const auth = readHeaderValue(headers, 'authorization');
    if (!auth.toLowerCase().startsWith('bearer ')) {
        return { ok: false, reason: 'missing router-request token' };
    }
    const rawToken = auth.slice(7).trim();
    if (!rawToken) {
        return { ok: false, reason: 'empty router-request token' };
    }
    const secret = readAgentSecret(env);
    if (!secret) {
        return { ok: false, reason: 'PLOINKY_AGENT_SECRET not configured' };
    }
    const audience = expectedAudienceForSelf(env);
    if (!audience) {
        return { ok: false, reason: 'PLOINKY_AGENT_ID not configured' };
    }
    try {
        const { payload } = verifyRouterRequestToken(rawToken, {
            secret,
            expectedAudience: audience,
            method,
            path,
            tool,
            rch,
            replayCache,
        });
        return { ok: true, payload, rawToken };
    } catch (err) {
        return { ok: false, reason: err?.message || String(err) };
    }
}

// Verify the protected/guest HTTP-route auth-info carrier. The router places a
// Router Request token inside `x-ploinky-auth-info`; the receiver must compare
// the signed invocation body to the actual HTTP surface and body bytes before
// trusting the forwarded identity.
export function verifyHttpRouteAuthInfoFromHeaders(headers = {}, {
    env = process.env,
    replayCache,
    method,
    path,
    query = '',
    body = Buffer.alloc(0),
    bodyHash,
} = {}) {
    const parsed = parseHttpRouteAuthInfo(headers);
    if (!parsed.ok) {
        return parsed;
    }

    const authInfo = parsed.authInfo;
    const rawToken = typeof authInfo.invocationToken === 'string' ? authInfo.invocationToken.trim() : '';
    if (!rawToken) {
        return { ok: false, reason: 'missing HTTP route invocation token' };
    }
    const invocationBody = authInfo.invocationBody;
    if (!invocationBody || typeof invocationBody !== 'object' || Array.isArray(invocationBody)) {
        return { ok: false, reason: 'missing HTTP route invocation body' };
    }

    const expectedMethod = String(method || '').toUpperCase();
    if (!expectedMethod) {
        return { ok: false, reason: 'missing HTTP route method' };
    }
    const expectedPath = String(path || '');
    if (!expectedPath) {
        return { ok: false, reason: 'missing HTTP route path' };
    }
    const expectedQuery = query === undefined || query === null ? '' : String(query);
    const expectedBodyHash = bodyHash === undefined || bodyHash === null
        ? sha256RawBodyHash(body)
        : String(bodyHash);

    if (String(invocationBody.method || '').toUpperCase() !== expectedMethod) {
        return { ok: false, reason: 'HTTP route method mismatch' };
    }
    if (!String(invocationBody.path || '')) {
        return { ok: false, reason: 'missing HTTP route signed path' };
    }
    if (String(invocationBody.path || '') !== expectedPath) {
        return { ok: false, reason: 'HTTP route path mismatch' };
    }
    if (String(invocationBody.search ?? '') !== expectedQuery) {
        return { ok: false, reason: 'HTTP route query mismatch' };
    }
    if (String(invocationBody.bodyHash || '') !== expectedBodyHash) {
        return { ok: false, reason: 'HTTP route body hash mismatch' };
    }

    const verified = verifyRouterRequestFromHeaders(
        { authorization: `Bearer ${rawToken}` },
        {
            env,
            replayCache: replayCache || httpRouteReplayCache,
            method: expectedMethod,
            path: expectedPath,
            tool: '__http_route__',
            rch: computeRchHttp({
                method: expectedMethod,
                path: expectedPath,
                query: expectedQuery,
                bodyHash: expectedBodyHash,
            }),
        },
    );
    if (!verified.ok) {
        return verified;
    }
    return {
        ...verified,
        authInfo,
        invocationBody,
        bodyHash: expectedBodyHash,
    };
}

// Verify the router-minted Router Request token for an agent-to-agent OpenAI
// chat-completions call. The router places the token inside `x-ploinky-auth-info`
// (an `{ invocationToken, invocationBody }` envelope, like the HTTP-route flow)
// and the receiving agent rebinds it to the EXACT raw request body bytes it
// received. The signed surface is the fixed OpenAI tool/path, so a token minted
// for any other surface (a different path, the `__http_route__` tool, an MCP
// call) is rejected even when its HMAC is valid.
export function verifyOpenAiServiceAuthInfoFromHeaders(headers = {}, {
    env = process.env,
    replayCache,
    body = Buffer.alloc(0),
    bodyHash,
} = {}) {
    const parsed = parseHttpRouteAuthInfo(headers);
    if (!parsed.ok) {
        return parsed;
    }

    const authInfo = parsed.authInfo;
    const rawToken = typeof authInfo.invocationToken === 'string' ? authInfo.invocationToken.trim() : '';
    if (!rawToken) {
        return { ok: false, reason: 'missing OpenAI service invocation token' };
    }

    const expectedMethod = 'POST';
    const expectedPath = OPENAI_CHAT_COMPLETIONS_PATH;
    const expectedQuery = '';
    const expectedBodyHash = bodyHash === undefined || bodyHash === null
        ? sha256RawBodyHash(body)
        : String(bodyHash);

    const verified = verifyRouterRequestFromHeaders(
        { authorization: `Bearer ${rawToken}` },
        {
            env,
            replayCache: replayCache || openAiServiceReplayCache,
            method: expectedMethod,
            path: expectedPath,
            tool: OPENAI_CHAT_COMPLETIONS_TOOL,
            rch: computeRchHttp({
                method: expectedMethod,
                path: expectedPath,
                query: expectedQuery,
                bodyHash: expectedBodyHash,
            }),
        },
    );
    if (!verified.ok) {
        return verified;
    }
    return {
        ...verified,
        authInfo,
        bodyHash: expectedBodyHash,
    };
}

// Verify the router-minted Router Request token for an agent-to-agent OpenAI
// models-list call. This mirrors the chat-completions verifier but binds the
// token to the GET /v1/models surface with an empty body and query.
export function verifyOpenAiModelsAuthInfoFromHeaders(headers = {}, {
    env = process.env,
    replayCache,
} = {}) {
    const parsed = parseHttpRouteAuthInfo(headers);
    if (!parsed.ok) {
        return parsed;
    }

    const authInfo = parsed.authInfo;
    const rawToken = typeof authInfo.invocationToken === 'string' ? authInfo.invocationToken.trim() : '';
    if (!rawToken) {
        return { ok: false, reason: 'missing OpenAI models invocation token' };
    }

    const expectedMethod = 'GET';
    const expectedPath = OPENAI_MODELS_PATH;
    const expectedQuery = '';
    const expectedBodyHash = sha256RawBodyHash('');

    const verified = verifyRouterRequestFromHeaders(
        { authorization: `Bearer ${rawToken}` },
        {
            env,
            replayCache: replayCache || openAiModelsReplayCache,
            method: expectedMethod,
            path: expectedPath,
            tool: OPENAI_MODELS_TOOL,
            rch: computeRchHttp({
                method: expectedMethod,
                path: expectedPath,
                query: expectedQuery,
                bodyHash: expectedBodyHash,
            }),
        },
    );
    if (!verified.ok) {
        return verified;
    }
    return {
        ...verified,
        authInfo,
        bodyHash: expectedBodyHash,
    };
}

export default {
    readHeaderValue,
    hasInvocationTokenHeader,
    expectedAudienceForSelf,
    readAgentSecret,
    sha256RawBodyHash,
    hashHttpRouteBody,
    parseHttpRouteAuthInfo,
    verifyHttpRouteAuthInfoFromHeaders,
    verifyOpenAiServiceAuthInfoFromHeaders,
    verifyOpenAiModelsAuthInfoFromHeaders,
    verifyRouterRequestFromHeaders,
    OPENAI_CHAT_COMPLETIONS_TOOL,
    OPENAI_CHAT_COMPLETIONS_PATH,
    OPENAI_MODELS_TOOL,
    OPENAI_MODELS_PATH,
};
