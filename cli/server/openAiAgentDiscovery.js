import { readEnabledAgentManifest, loadRoutingConfig } from './routingState.js';
import { resolveEnabledAgentRecord } from '../utils/agents.js';
import { deriveAgentPrincipalId } from '../utils/security/agentIdentity.js';
import { verifyAgentAssertion } from './mcp-proxy/invocationMinter.js';
import { createTokenReplayCache } from './security/tokens/JwsCodec.js';
import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';

/**
 * openAiAgentDiscovery.js — router-owned, agent-authenticated discovery of the
 * enabled agents an OpenAI-compatible gateway consumer may address as chat backends.
 *
 * GET /api/router/openai-agent-discovery returns one row per enabled route that
 * resolves to a manifest AND has an active host port. The response is built from
 * `route.hostPath` (via the exported readEnabledAgentManifest) plus the
 * enabled-agent fallback — never a `route.manifestPath`. It deliberately emits NO
 * `http://127.0.0.1:<routerPort>` base URLs: the consumer composes the actual
 * call URL from its own PLOINKY_ROUTER_URL, the returned `routerPath`, and
 * `chatCompletionsPath`. The container-internal port stays inside the router.
 *
 * The endpoint is for agents, not browsers: it requires an HTTP Agent Assertion
 * (`Authorization: Bearer <jwt>`) bound to this exact request surface, with `rch`
 * computed via computeRchHttp() (not computeRchTool()). It is dispatched BEFORE the
 * generic session-auth gate in RoutingServer, like /policy/command, so a browser
 * session is neither sufficient nor required.
 */

export const OPENAI_AGENT_DISCOVERY_PATH = '/api/router/openai-agent-discovery';
export const OPENAI_AGENT_DISCOVERY_TOOL = '__openai_agent_discovery__';
export const OPENAI_AGENT_DISCOVERY_TARGET = 'ploinky-router';
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

// Process-wide replay cache so a captured assertion `jti` cannot be reused across
// requests. Created once at module scope (NOT per request) — a per-request cache
// would make replay protection a no-op.
const discoveryReplayCache = createTokenReplayCache({ maxSize: 4096 });

function isActiveHostPort(value) {
    const port = Number(value);
    return Number.isFinite(port) && port > 0;
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

function resolveSubjectId(repo, agent) {
    try {
        return deriveAgentPrincipalId(repo, agent);
    } catch (_) {
        return null;
    }
}

const OPT_OUT_MODELS = new Set(['none', 'off']);

function resolveResponderKind(manifest) {
    const endpoints = manifest && typeof manifest === 'object' ? manifest.endpoints : null;
    const chat = endpoints && typeof endpoints === 'object' ? endpoints.chatCompletions : null;
    if (chat && typeof chat === 'object') {
        if (typeof chat.command === 'string' && chat.command.trim()) {
            return { kind: 'command', supportsStreaming: chat.supportsStream === true || chat.stream === true };
        }
        if (typeof chat.model === 'string' && OPT_OUT_MODELS.has(chat.model.trim().toLowerCase())) {
            return { kind: 'inert', supportsStreaming: false };
        }
    }
    return { kind: 'llm', supportsStreaming: true };
}

function buildAgentRow(routeKey, route, manifest) {
    const repoAgent = resolveRepoAgent(routeKey, route);
    if (!repoAgent) return null;
    const subjectId = resolveSubjectId(repoAgent.repo, repoAgent.agent);
    if (!subjectId) return null;

    const responder = resolveResponderKind(manifest);
    const name = String(manifest?.name || routeKey);
    return {
        subjectId,
        routeKey,
        repo: repoAgent.repo,
        agent: repoAgent.agent,
        name,
        routerPath: `/${routeKey}`,
        chatCompletionsPath: CHAT_COMPLETIONS_PATH,
        supportsStreaming: responder.supportsStreaming,
        usesDefaultOpenAiResponder: responder.kind !== 'command',
        responderKind: responder.kind,
        manifest: {
            name,
            version: String(manifest?.version || ''),
        },
    };
}

/**
 * Pure, unit-testable builder. For each ENABLED route with an active host port and
 * a resolvable manifest, emit one discovery row. Disabled routes, routes without a
 * host port, and routes whose manifest cannot be resolved are excluded. `complete`
 * is true only when every enabled route was inspected without an unrecoverable
 * error. `readManifest` is injectable so tests can drive it without on-disk agents;
 * it defaults to the exported readEnabledAgentManifest (hostPath + enabled-agent
 * fallback, never route.manifestPath).
 */
export function buildOpenAiAgentDiscovery({ routes = {}, readManifest = readEnabledAgentManifest } = {}) {
    const agents = [];
    let complete = true;

    for (const [routeKey, route] of Object.entries(routes || {})) {
        if (!route || route.disabled || route.draining) continue;
        if (!isActiveHostPort(route.hostPort)) continue;
        let manifest = null;
        try {
            manifest = readManifest(routeKey, routes);
        } catch (_) {
            // A single route that throws during manifest resolution is an
            // unrecoverable discovery error: report it but keep going so the rest
            // of the inventory is still returned.
            complete = false;
            continue;
        }
        if (!manifest || typeof manifest !== 'object') continue;
        const row = buildAgentRow(routeKey, route, manifest);
        if (row) agents.push(row);
    }

    return { complete, agents };
}

function readAuthorizationBearer(req) {
    const raw = req?.headers?.authorization ?? req?.headers?.Authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return /^bearer\s+/i.test(trimmed) ? trimmed.replace(/^bearer\s+/i, '').trim() : '';
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
 * Router dispatcher for GET /api/router/openai-agent-discovery.
 *
 * Returns true when it owns and answers the request (so RoutingServer returns
 * before the session-auth gate); returns false when the path is not ours.
 * Authentication is an HTTP Agent Assertion bound to the GET surface with `rch`
 * computed via computeRchHttp(); any missing/invalid/replayed/mismatched assertion
 * is a 401. On a verified caller it serves the discovery inventory (200). A non-2xx
 * response (here, 401) carries `complete:false` so the consumer treats discovery
 * as failed and preserves its existing rows.
 */
export function handleOpenAiAgentDiscoveryRoute(req, res, parsedUrl, {
    routing = loadRoutingConfig(),
    replayCache = discoveryReplayCache,
} = {}) {
    const pathname = parsedUrl?.pathname || '';
    if (pathname !== OPENAI_AGENT_DISCOVERY_PATH) {
        return false;
    }

    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
        res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
        return true;
    }

    const token = readAuthorizationBearer(req);
    const rch = computeRchHttp({
        method: 'GET',
        path: OPENAI_AGENT_DISCOVERY_PATH,
        query: '',
        bodyHash: sha256RawBodyHash(''),
    });
    try {
        verifyAgentAssertion({
            token,
            method: 'GET',
            path: OPENAI_AGENT_DISCOVERY_PATH,
            tool: OPENAI_AGENT_DISCOVERY_TOOL,
            rch,
            targetAgentId: OPENAI_AGENT_DISCOVERY_TARGET,
            replayCache,
        });
    } catch (_) {
        // Never echo the verifier's reason — an agent-only endpoint must not help a
        // caller probe why its assertion was rejected.
        sendJson(res, 401, { complete: false, error: 'agent_assertion_required' });
        return true;
    }

    const routes = routing?.routes && typeof routing.routes === 'object' ? routing.routes : {};
    const result = buildOpenAiAgentDiscovery({ routes });
    sendJson(res, 200, result);
    return true;
}

export default {
    OPENAI_AGENT_DISCOVERY_PATH,
    OPENAI_AGENT_DISCOVERY_TOOL,
    OPENAI_AGENT_DISCOVERY_TARGET,
    buildOpenAiAgentDiscovery,
    handleOpenAiAgentDiscoveryRoute,
};
