import { randomUUID } from 'node:crypto';
import { sendJson, ensureAuthenticated } from '../authHandlers.js';
import { createAgentClient } from '../AgentClient.js';
import { waitForAgentReady } from '../utils/agentReadiness.js';
import {
    buildRouterRequest,
    resolveProviderPrincipal,
    verifyAgentAssertion
} from './invocationMinter.js';
import { computeRchTool } from '../../../Agent/lib/requestHash.mjs';
import { createMemoryReplayCache } from '../../../Agent/lib/jwtVerify.mjs';
import { sanitizeArgumentsForTool } from './toolArguments.js';
import { getAgentDescriptorByPrincipal } from '../../services/agentRegistry.js';
import { policy } from '../policy/index.js';

const AGENT_PROXY_PROTOCOL_VERSION = '2025-06-18';
const AGENT_PROXY_SERVER_INFO = { name: 'ploinky-router-proxy', version: '1.0.0' };
const TOOL_SCHEMA_CACHE_TTL_MS = 30_000;
// Replay cache for verified Agent Assertions (agent-to-agent jti single-use).
const assertionReplayCache = createMemoryReplayCache({ maxSize: 4096 });

// Session store for agent MCP connections
const agentSessionStore = new Map();
const agentToolSchemaCache = new Map();

/**
 * Read MCP session ID from request headers
 */
function readAgentSessionId(req) {
    const value = req.headers['mcp-session-id'];
    if (Array.isArray(value)) return value[0];
    return typeof value === 'string' ? value : null;
}

/**
 * Check if payload is a JSON-RPC request
 */
function isJsonRpcPayload(payload) {
    if (Array.isArray(payload)) {
        return payload.some(item => item && typeof item === 'object' && item.jsonrpc === '2.0');
    }
    return !!(payload && typeof payload === 'object' && payload.jsonrpc === '2.0');
}

function isSecureWireEnabled() {
    const flag = String(process.env.PLOINKY_SECURE_WIRE || '').trim().toLowerCase();
    if (flag === '0' || flag === 'false' || flag === 'off') return false;
    return true;
}

function resolveProviderAgentRef(agentName) {
    // agentName is typically the short route name. Find the full repo/agent
    // reference so the agent registry can resolve the provider principal.
    try {
        const descriptor = getAgentDescriptorByPrincipal(`agent:${agentName}`);
        if (descriptor) return descriptor.agentRef;
    } catch (_) {}
    return agentName;
}

// Agent-to-agent calls arrive at /<agent>/mcp carrying an Agent Assertion as
// `Authorization: Bearer <assertion>` (browser callers use session cookies, and
// the router→agent hop is a separate internal request). Reading the bearer here
// only detects an a2a attempt; the assertion is verified before anything runs.
function readAuthorizationBearer(req) {
    const raw = req.headers?.authorization ?? req.headers?.Authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.toLowerCase().startsWith('bearer ')) {
        return value.slice(7).trim();
    }
    return '';
}

function extractDelegatedUser(req) {
    if (!req.user || typeof req.user !== 'object') return null;
    return {
        id: req.user.id || '',
        username: req.user.username || req.user.name || req.user.email || '',
        email: req.user.email || '',
        roles: Array.isArray(req.user.roles) ? [...req.user.roles] : []
    };
}

async function getToolSchemasForAgent(agentName, agentClient) {
    const now = Date.now();
    const cached = agentToolSchemaCache.get(agentName);
    if (cached && now - cached.loadedAt < TOOL_SCHEMA_CACHE_TTL_MS) {
        return cached.tools;
    }
    const tools = await agentClient.listTools();
    agentToolSchemaCache.set(agentName, { loadedAt: now, tools });
    return tools;
}

async function canonicalizeToolArguments(agentName, agentClient, toolName, args) {
    try {
        const tools = await getToolSchemasForAgent(agentName, agentClient);
        return sanitizeArgumentsForTool(args, tools, toolName);
    } catch (_) {
        return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    }
}

export function buildInvocationContextForProviderCall({ req, agentName, toolName, toolArgs, method = 'POST', path = '/mcp' }) {
    if (!isSecureWireEnabled()) return null;
    const targetAgentId = resolveProviderPrincipal({ providerAgentRef: resolveProviderAgentRef(agentName) });
    const canonicalArgs = toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs) ? toolArgs : {};
    // rch binds the token to exactly the {method, path, tool, arguments} the
    // agent will execute. For MCP the transport is always POST /mcp.
    const rch = computeRchTool({ method, path, tool: toolName, arguments: canonicalArgs });

    // Resolve the acting principal. A verified source agent (agent-to-agent)
    // takes precedence over the browser user. The raw User Session JWT is never
    // forwarded — only this freshly minted, target-scoped Router Request is.
    let sub = '';
    let actor;
    const delegated = req?.delegatedAgentVerified && typeof req.delegatedAgentVerified === 'object'
        ? req.delegatedAgentVerified
        : null;
    if (delegated) {
        const caller = String(delegated.callerPrincipal || '');
        sub = caller;
        actor = { kind: 'agent', id: caller, roles: [] };
    } else {
        const user = extractDelegatedUser(req);
        sub = user?.id ? `user:${user.id}` : '';
        actor = { kind: 'user', id: sub, roles: user?.roles || [] };
    }

    const { token, payload } = buildRouterRequest({
        targetAgentId,
        sub,
        actor,
        method,
        path,
        tool: toolName,
        rch,
    });
    return { token, payload, rch };
}

/**
 * Handle JSON-RPC requests to agent MCP endpoints
 */
async function handleAgentJsonRpc(req, res, route, agentName, payload) {
    const isBatch = Array.isArray(payload);
    const messages = isBatch ? payload : [payload];
    if (messages.length !== 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Batch requests are not supported' }, id: null }));
        return;
    }

    const message = messages[0];
    const baseUrl = `http://127.0.0.1:${route.hostPort}/mcp`;

    const sessionIdHeader = readAgentSessionId(req);
    const sessionEntry = sessionIdHeader ? agentSessionStore.get(sessionIdHeader) : null;

    const headersForSession = (sessionId) => {
        const headers = { 'mcp-protocol-version': AGENT_PROXY_PROTOCOL_VERSION };
        if (sessionId) headers['mcp-session-id'] = sessionId;
        return headers;
    };

    const sendResponse = (statusCode, body, sessionId) => {
        res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headersForSession(sessionId) });
        res.end(JSON.stringify(body));
    };

    if (message.method === 'initialize') {
        const newSessionId = randomUUID();
        agentSessionStore.set(newSessionId, { agentName, baseUrl });
        sendResponse(200, {
            jsonrpc: '2.0',
            id: message.id ?? null,
            result: {
                protocolVersion: AGENT_PROXY_PROTOCOL_VERSION,
                capabilities: {
                    tools: { listChanged: false },
                    resources: { listChanged: false }
                },
                serverInfo: { ...AGENT_PROXY_SERVER_INFO, name: `${AGENT_PROXY_SERVER_INFO.name}:${agentName}` }
            }
        }, newSessionId);
        return;
    }

    if (message.method === 'notifications/initialized') {
        const responseHeaders = headersForSession(sessionEntry ? sessionIdHeader : null);
        res.writeHead(204, responseHeaders);
        res.end();
        return;
    }

    const isVerifiedDelegatedToolCall = Boolean(req.delegatedAgentVerified && message.method === 'tools/call');
    if ((!sessionEntry || sessionEntry.agentName !== agentName) && !isVerifiedDelegatedToolCall) {
        sendResponse(200, {
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32000, message: 'Missing or invalid MCP session' }
        }, null);
        return;
    }

    function buildRequestHeadersForToolCall(toolName, toolArgs) {
        const ctx = buildInvocationContextForProviderCall({
            req,
            agentName,
            toolName,
            toolArgs: toolArgs || {}
        });
        if (ctx?.token) {
            return { authorization: `Bearer ${ctx.token}` };
        }
        return null;
    }

    const agentClient = createAgentClient(baseUrl);
    try {
        switch (message.method) {
            case 'tools/list': {
                const tools = await agentClient.listTools();
                // Cache the full schema set for argument canonicalization, but only
                // advertise the tools this caller is permitted to invoke.
                agentToolSchemaCache.set(agentName, { loadedAt: Date.now(), tools });
                const visibleTools = policy.mcpToolPolicy.filterTools(agentName, tools, policy.resolveCaller(req));
                sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, result: { tools: visibleTools } }, sessionIdHeader);
                break;
            }
            case 'resources/list': {
                // Resources are an authenticated-class capability (DS014): a
                // session caller sees them, an internal/agent or anonymous
                // caller sees an empty list (mirrors tools/list filtering).
                const listDecision = policy.mcpToolPolicy.evaluateResource({ caller: policy.resolveCaller(req) });
                const resources = listDecision.allow ? await agentClient.listResources() : [];
                sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, result: { resources } }, sessionIdHeader);
                break;
            }
            case 'tools/call': {
                const params = message.params && typeof message.params === 'object' ? message.params : {};
                const name = typeof params.name === 'string' ? params.name : typeof params.tool === 'string' ? params.tool : null;
                if (!name) {
                    sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32602, message: 'Missing tool name' } }, sessionIdHeader);
                    break;
                }
                // MCP tool policy (fail-closed) gates the call before any token is minted.
                const callDecision = policy.mcpToolPolicy.evaluate({ agent: agentName, tool: name, caller: policy.resolveCaller(req) });
                if (!callDecision.allow) {
                    sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32003, message: 'Access denied', data: { code: callDecision.code } } }, sessionIdHeader);
                    break;
                }
                const argPayload = params && typeof params === 'object' ? params['arguments'] : null;
                const args = argPayload && typeof argPayload === 'object' && !Array.isArray(argPayload)
                    ? { ...argPayload }
                    : {};
                const canonicalArgs = await canonicalizeToolArguments(agentName, agentClient, name, args);

                // Mint a router-signed invocation token scoped to this tool call
                // and open a short-lived client with that token in the header.
                const toolHeaders = buildRequestHeadersForToolCall(name, canonicalArgs);
                const toolClient = createAgentClient(baseUrl, toolHeaders ? { requestHeaders: toolHeaders } : undefined);

                try {
                    const result = await toolClient.callTool(name, canonicalArgs);
                    sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, result }, sessionIdHeader);
                } finally {
                    await toolClient.close().catch(() => {});
                }
                break;
            }
            case 'resources/read': {
                const params = message.params && typeof message.params === 'object' ? message.params : {};
                const uri = typeof params.uri === 'string' ? params.uri : null;
                if (!uri) {
                    sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32602, message: 'Missing resource uri' } }, sessionIdHeader);
                    break;
                }
                // Fail-closed resource gate (DS014) before any token is minted.
                const readDecision = policy.mcpToolPolicy.evaluateResource({ caller: policy.resolveCaller(req) });
                if (!readDecision.allow) {
                    sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32003, message: 'Access denied', data: { code: readDecision.code } } }, sessionIdHeader);
                    break;
                }
                const resourceHeaders = buildRequestHeadersForToolCall('resources/read', { uri });
                const resourceClient = createAgentClient(baseUrl, resourceHeaders ? { requestHeaders: resourceHeaders } : undefined);
                try {
                    const result = await resourceClient.readResource(uri);
                    sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, result }, sessionIdHeader);
                } finally {
                    await resourceClient.close().catch(() => {});
                }
                break;
            }
            case 'ping': {
                await agentClient.ping();
                sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, result: {} }, sessionIdHeader);
                break;
            }
            default:
                sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: `Method not found: ${message.method}` } }, sessionIdHeader);
        }
    } catch (err) {
        const messageText = err && err.message ? err.message : String(err || 'unknown error');
        sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: messageText } }, sessionIdHeader);
    } finally {
        await agentClient.close().catch(() => { });
    }
}

/**
 * Handle HTTP requests to agent MCP endpoints
 */
async function handleAgentMcpRequest(req, res, route, agentName) {
    const method = (req.method || 'GET').toUpperCase();
    const isDelegatedAgentRequest = Boolean(readAuthorizationBearer(req));

    if (method === 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, DELETE' });
        res.end(JSON.stringify({ error: 'event_stream_not_supported' }));
        return;
    }

    if (method === 'DELETE') {
        const sessionId = readAgentSessionId(req);
        if (sessionId) {
            agentSessionStore.delete(sessionId);
        }
        res.writeHead(204);
        res.end();
        return;
    }

    if (method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, DELETE' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
        let payload;
        try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch (_) {
            payload = {};
        }

        const isJsonRpc = isJsonRpcPayload(payload);
        const message = Array.isArray(payload) ? payload[0] : payload;
        const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        if (isDelegatedAgentRequest) {
            if (!isJsonRpc || message?.method !== 'tools/call') {
                const errorMessage = 'Delegated agent calls must use a direct tools/call request.';
                if (isJsonRpc) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        id: message?.id ?? null,
                        error: { code: -32600, message: errorMessage }
                    }));
                    return;
                }
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid_agent_request', detail: errorMessage }));
                return;
            }
            try {
                const params = message.params && typeof message.params === 'object' ? message.params : {};
                const toolName = typeof params.name === 'string'
                    ? params.name
                    : (typeof params.tool === 'string' ? params.tool : '');
                const rawArgs = params['arguments'] && typeof params['arguments'] === 'object' && !Array.isArray(params['arguments'])
                    ? params['arguments']
                    : {};
                // Verify the assertion against the exact request the source agent
                // signed (raw args, as sent). The source binds the target by its
                // route name; MCP policy for the agent caller is enforced later in
                // handleAgentJsonRpc before any token is minted.
                const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: toolName, arguments: rawArgs });
                req.delegatedAgentVerified = verifyAgentAssertion({
                    token: readAuthorizationBearer(req),
                    method: 'POST',
                    path: '/mcp',
                    tool: toolName,
                    rch,
                    targetAgentId: agentName,
                    replayCache: assertionReplayCache,
                });
            } catch (error) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: message?.id ?? null,
                    error: {
                        code: -32600,
                        message: error?.message || 'Delegated agent verification failed.'
                    }
                }));
                return;
            }
        } else {
            // Defensive auth attach for browser MCP calls. The router should already do this,
            // but the proxy must not rely on auth context being pre-populated if cookies exist.
            if (!req.agent && !req.user) {
                const authResult = await ensureAuthenticated(req, res, parsedUrl);
                if (!authResult.ok) {
                    return;
                }
            }

            // Check agent authorization if agent authentication was used
            if (req.agent) {
                const allowedTargets = req.agent.allowedTargets || [];
                const isAllowed = allowedTargets.includes('*') || allowedTargets.includes(agentName);
                if (!isAllowed) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'forbidden',
                        detail: `Agent '${req.agent.name}' is not authorized to access agent '${agentName}'`
                    }));
                    return;
                }
            }
        }

        const isReady = await waitForAgentReady(route, {
            timeoutMs: 5000,
            intervalMs: 125,
            probeTimeoutMs: 250
        });
        if (!isReady) {
            if (isJsonRpc) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: message?.id ?? null,
                    error: {
                        code: -32000,
                        message: `Agent '${agentName}' is still starting. Try again in a moment.`
                    }
                }));
                return;
            }
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'agent_not_ready',
                detail: `Agent '${agentName}' is still starting.`
            }));
            return;
        }

        try {
            if (isJsonRpc) {
                await handleAgentJsonRpc(req, res, route, agentName, payload);
                return;
            }

            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unsupported request for agent MCP proxy' }));
        } catch (err) {
            const message = err && err.message ? err.message : String(err || 'unknown error');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
        }
    });
    req.on('error', err => {
        sendJson(res, 500, { error: String(err && err.message || err) });
    });
}

export {
    agentSessionStore,
    handleAgentMcpRequest,
    readAgentSessionId,
    isJsonRpcPayload,
    handleAgentJsonRpc
};
