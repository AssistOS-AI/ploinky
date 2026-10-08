import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { sendJson, ensureAuthenticated } from '../authHandlers/index.js';
import { createAgentClient } from '../AgentClient.js';
import { waitForAgentReady } from '../utils/agentReadiness.js';
import { readExplicitReadinessProtocol } from '../../utils/runtime/startupReadiness.js';
import {
    createUpstreamSessionPool,
    isUpstreamPoolEnabled,
    poolKeyForRoutePlan,
    upstreamTimeoutForMethod,
} from './upstreamSessionPool.js';
import {
    buildRouterRequest,
    resolveProviderPrincipal,
    verifyAgentAssertion
} from './invocationMinter.js';
import { buildMcpDelegationsForUserCall } from './mcpDelegations.js';
import { computeRchTool } from '../../../Agent/lib/requestHash.mjs';
import { createTokenReplayCache } from '../security/tokens/JwsCodec.js';
import { sanitizeArgumentsForTool } from './toolArguments.js';
import { policy } from '../policy/index.js';
import { deriveSubkey } from '../../utils/security/masterKey.js';
import { verifyUserDelegationGrant } from './userDelegationGrant.js';

const AGENT_PROXY_PROTOCOL_VERSION = '2025-06-18';
const AGENT_PROXY_SERVER_INFO = { name: 'ploinky-router-proxy', version: '1.0.0' };
const TOOL_SCHEMA_CACHE_TTL_MS = 30_000;
const TASK_STATUS_TOOL = '__task_status__';
const TASK_CANCEL_TOOL = '__task_cancel__';
const TASK_CANCEL_PATH = '/task/cancel';
// Replay cache for verified Agent Assertions (agent-to-agent jti single-use).
const assertionReplayCache = createTokenReplayCache({ maxSize: 4096 });

// Session store for agent MCP connections
const agentSessionStore = new Map();
const agentToolSchemaCache = new Map();

// Router -> agent MCP sessions, one per exact agent instance (see
// upstreamSessionPool.js). Closed on Router shutdown.
const agentUpstreamSessionPool = createUpstreamSessionPool();
// Methods that may be sent again through the SDK path after a pool mismatch
// was detected on an already dispatched request.
const IDEMPOTENT_UPSTREAM_METHODS = new Set(['tools/list', 'resources/list', 'ping']);

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

function readUserDelegationHeader(req) {
    const raw = req.headers?.['x-ploinky-user-delegation'] ?? req.headers?.['X-PLOINKY-USER-DELEGATION'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' ? value.trim() : '';
}

function resolveUserDelegationSigningSecret() {
    return deriveSubkey('router-user-delegation', 32);
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

function actorKindForRequestUser(user) {
    const roles = Array.isArray(user?.roles)
        ? user.roles.map((role) => String(role || '').toLowerCase())
        : [];
    return roles.includes('guest') ? 'guest' : 'user';
}

function resolveGuestInvocationScope(req) {
    if (actorKindForRequestUser(req?.user) !== 'guest') return undefined;
    const guestScope = String(req?.session?._jwtPayload?.gscope || '').trim();
    return guestScope ? [guestScope] : undefined;
}

// `upstream` is an agent client or the pooled caller from
// createUpstreamMcpCaller; both expose listTools().
async function getToolSchemasForAgent(agentName, upstream) {
    const now = Date.now();
    const cached = agentToolSchemaCache.get(agentName);
    if (cached && now - cached.loadedAt < TOOL_SCHEMA_CACHE_TTL_MS) {
        return cached.tools;
    }
    const tools = await upstream.listTools();
    agentToolSchemaCache.set(agentName, { loadedAt: now, tools });
    return tools;
}

function resolveUpstreamPoolKey({ pool, routePlan, route, beforeDial }) {
    if (!pool || typeof beforeDial !== 'function' || !isUpstreamPoolEnabled()) return null;
    const key = poolKeyForRoutePlan(routePlan);
    if (!key) return null;
    // The proxy dials route.hostPort; only pool when the plan names that port.
    if (Number(route?.hostPort) !== Number(routePlan?.target?.hostPort)) return null;
    return key;
}

function upstreamRpcError(error) {
    // Same message shape as the SDK client's McpError.
    const failure = new Error(`MCP error ${error?.code}: ${error?.message || 'upstream error'}`);
    failure.rpcCode = error?.code;
    return failure;
}

/**
 * Upstream MCP calls for one proxied request: the pooled session when a pool
 * key exists, otherwise (or after a pool mismatch) today's per-call SDK client.
 * `mintHeaders` is called once per attempt so every attempt carries a new token.
 */
function createUpstreamMcpCaller({ baseUrl, hostPort, beforeDial, pool, poolKey, ensureReady }) {
    let sharedClient = null;
    const sdkClientOptions = (headers) => ({
        ...(headers ? { requestHeaders: headers } : {}),
        ...(beforeDial ? { beforeConnect: beforeDial } : {}),
    });
    const shared = () => {
        if (!sharedClient) sharedClient = createAgentClient(baseUrl, sdkClientOptions(null));
        return sharedClient;
    };
    const usePool = () => Boolean(pool && poolKey && !pool.usesFallback(poolKey));

    async function withPool(method, params, headers, sdkPath) {
        if (usePool()) {
            try {
                const message = await pool.request({
                    key: poolKey,
                    hostPort: Number(hostPort),
                    method,
                    params,
                    headers,
                    beforeDial,
                    timeoutMs: upstreamTimeoutForMethod(method),
                    ensureReady,
                });
                if (message.error) throw upstreamRpcError(message.error);
                return { pooled: true, result: message.result };
            } catch (error) {
                // A mismatch falls back only when nothing non-idempotent ran.
                const replayable = error?.dispatched === false || IDEMPOTENT_UPSTREAM_METHODS.has(method);
                if (!(error?.poolMismatch && replayable)) throw error;
            }
        }
        return { pooled: false, result: await sdkPath() };
    }

    async function withToolClient(mintHeaders, run) {
        const client = createAgentClient(baseUrl, sdkClientOptions(mintHeaders()));
        try {
            return await run(client);
        } finally {
            await client.close().catch(() => {});
        }
    }

    return {
        async listTools() {
            const { pooled, result } = await withPool('tools/list', {}, null, () => shared().listTools());
            return pooled ? (Array.isArray(result?.tools) ? result.tools : []) : result;
        },
        async listResources() {
            const { pooled, result } = await withPool('resources/list', {}, null, () => shared().listResources());
            return pooled ? (Array.isArray(result?.resources) ? result.resources : []) : result;
        },
        async ping() {
            return (await withPool('ping', {}, null, () => shared().ping())).result;
        },
        async callTool(name, args, mintHeaders) {
            return (await withPool('tools/call', { name, arguments: args || {} }, mintHeaders,
                () => withToolClient(mintHeaders, (client) => client.callTool(name, args)))).result;
        },
        async readResource(uri, mintHeaders) {
            const { pooled, result } = await withPool('resources/read', { uri }, mintHeaders,
                () => withToolClient(mintHeaders, (client) => client.readResource(uri)));
            return pooled ? (result?.resource ?? result) : result;
        },
        async close() {
            if (sharedClient) await sharedClient.close().catch(() => {});
            sharedClient = null;
        },
    };
}

async function canonicalizeToolArguments(agentName, agentClient, toolName, args) {
    try {
        const tools = await getToolSchemasForAgent(agentName, agentClient);
        return sanitizeArgumentsForTool(args, tools, toolName);
    } catch (_) {
        return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    }
}

export async function invokeAuthenticatedAgentTool({
    req,
    route,
    agentName,
    toolName,
    arguments: rawArguments = {},
}) {
    const caller = policy.resolveCaller(req);
    if (caller?.kind !== 'user') {
        const error = new Error('authenticated_user_required');
        error.status = 401;
        throw error;
    }
    const decision = policy.mcpToolPolicy.evaluate({
        agent: agentName,
        tool: toolName,
        caller,
    });
    if (!decision.allow) {
        const error = new Error(decision.code || 'AGENT_POLICY_DENIED');
        error.status = decision.status || 403;
        throw error;
    }
    if (!route?.hostPort) {
        const error = new Error('continuation_agent_unavailable');
        error.status = 409;
        throw error;
    }
    const baseUrl = `http://127.0.0.1:${route.hostPort}/mcp`;
    const agentClient = createAgentClient(baseUrl);
    try {
        const args = await canonicalizeToolArguments(agentName, agentClient, toolName, rawArguments);
        const context = buildInvocationContextForProviderCall({
            req,
            agentName,
            toolName,
            toolArgs: args,
        });
        const toolClient = createAgentClient(baseUrl, context?.token
            ? { requestHeaders: { authorization: `Bearer ${context.token}` } }
            : undefined);
        try {
            return await toolClient.callTool(toolName, args);
        } finally {
            await toolClient.close().catch(() => {});
        }
    } finally {
        await agentClient.close().catch(() => {});
    }
}

export async function readAuthenticatedAgentTask({ req, route, agentName, taskId }) {
    const caller = policy.resolveCaller(req);
    if (caller?.kind !== 'user') {
        const error = new Error('authenticated_user_required');
        error.status = 401;
        throw error;
    }
    if (!route?.hostPort) {
        const error = new Error('continuation_agent_unavailable');
        error.status = 409;
        throw error;
    }
    const normalizedTaskId = String(taskId || '').trim();
    const context = buildInvocationContextForProviderCall({
        req,
        agentName,
        toolName: TASK_STATUS_TOOL,
        toolArgs: { taskId: normalizedTaskId },
        method: 'GET',
        path: '/task',
    });
    const url = new URL(`http://127.0.0.1:${route.hostPort}/task`);
    url.searchParams.set('taskId', normalizedTaskId);
    return await new Promise((resolve, reject) => {
        const request = http.request(url, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                ...(context?.token ? { authorization: `Bearer ${context.token}` } : {}),
            },
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let payload = null;
                try { payload = JSON.parse(text); } catch (_) { }
                if ((response.statusCode || 500) >= 400 || !payload?.task) {
                    const error = new Error(payload?.reason || payload?.error || `task_status_${response.statusCode}`);
                    error.status = response.statusCode || 502;
                    reject(error);
                    return;
                }
                resolve(payload.task);
            });
        });
        request.on('error', reject);
        request.end();
    });
}

export async function cancelAuthenticatedAgentTask({ req, route, agentName, taskId }) {
    const caller = policy.resolveCaller(req);
    if (caller?.kind !== 'user') {
        const error = new Error('authenticated_user_required');
        error.status = 401;
        throw error;
    }
    if (!route?.hostPort) {
        const error = new Error('task_agent_unavailable');
        error.status = 409;
        throw error;
    }
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
        const error = new Error('invalid_remote_task_id');
        error.status = 400;
        throw error;
    }
    const args = { taskId: normalizedTaskId };
    const context = buildInvocationContextForProviderCall({
        req,
        agentName,
        toolName: TASK_CANCEL_TOOL,
        toolArgs: args,
        method: 'POST',
        path: TASK_CANCEL_PATH,
    });
    const payload = Buffer.from(JSON.stringify(args), 'utf8');
    const url = new URL(`http://127.0.0.1:${route.hostPort}${TASK_CANCEL_PATH}`);
    return await new Promise((resolve, reject) => {
        const request = http.request(url, {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'content-length': payload.length,
                ...(context?.token ? { authorization: `Bearer ${context.token}` } : {}),
            },
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let body = null;
                try { body = JSON.parse(text); } catch (_) { }
                if ((response.statusCode || 500) >= 400 || !body?.task) {
                    const error = new Error(body?.reason || body?.error || `task_cancel_${response.statusCode}`);
                    error.status = response.statusCode || 502;
                    reject(error);
                    return;
                }
                resolve(body.task);
            });
        });
        request.on('error', reject);
        request.end(payload);
    });
}

// `snapshot` is the request's edge-routing lease snapshot, when the caller has
// one; the route key (`agentName`) is resolved to its provider principal.
export function buildInvocationContextForProviderCall({
    req,
    agentName,
    toolName,
    toolArgs,
    method = 'POST',
    path = '/mcp',
    snapshot = undefined,
}) {
    if (!isSecureWireEnabled()) return null;
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
        const targetAgentId = String(delegated.userDelegation?.delegation?.targetAgentId || '').trim()
            || resolveProviderPrincipal({ providerAgentRef: agentName, snapshot });
        sub = caller;
        actor = { kind: 'agent', id: caller, roles: [] };
        const callerInfo = { kind: 'agent', id: caller, roles: ['agent'] };
        const verifiedDelegation = delegated.userDelegation;
        const { token, payload } = buildRouterRequest({
            targetAgentId,
            sub,
            actor,
            caller: callerInfo,
            usr: verifiedDelegation?.user || undefined,
            delegation: verifiedDelegation?.delegation || undefined,
            method,
            path,
            tool: toolName,
            rch,
        });
        return { token, payload, rch };
    } else {
        const targetAgentId = resolveProviderPrincipal({ providerAgentRef: agentName, snapshot });
        const user = extractDelegatedUser(req);
        sub = user?.id ? `user:${user.id}` : '';
        actor = { kind: actorKindForRequestUser(req.user), id: sub, roles: user?.roles || [] };
        const delegations = buildMcpDelegationsForUserCall({ req, routeKey: agentName, toolName });
        const { token, payload } = buildRouterRequest({
            targetAgentId,
            sub,
            actor,
            scope: resolveGuestInvocationScope(req),
            delegations,
            method,
            path,
            tool: toolName,
            rch,
        });
        return { token, payload, rch };
    }
}

export function verifyDelegatedAgentToolCall({
    req,
    agentName,
    toolName,
    rawArgs = {},
    assertionCache = assertionReplayCache,
    snapshot = undefined,
}) {
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: toolName, arguments: rawArgs });
    const verifiedAgent = verifyAgentAssertion({
        token: readAuthorizationBearer(req),
        method: 'POST',
        path: '/mcp',
        tool: toolName,
        rch,
        targetAgentId: agentName,
        replayCache: assertionCache,
    });
    const delegationToken = readUserDelegationHeader(req);
    if (!delegationToken) {
        return { ...verifiedAgent, userDelegation: null };
    }
    const targetAgentId = resolveProviderPrincipal({ providerAgentRef: agentName, snapshot });
    const userDelegation = verifyUserDelegationGrant({
        signingSecret: resolveUserDelegationSigningSecret(),
        token: delegationToken,
        expectedSourceAgentId: verifiedAgent.callerPrincipal,
        expectedTargetAgentId: targetAgentId,
        expectedTool: toolName,
    });
    return { ...verifiedAgent, userDelegation };
}

export function verifyDelegatedAgentTaskStatusCall({
    req,
    agentName,
    taskId,
    path = '/task',
    assertionCache = assertionReplayCache,
}) {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
        throw new Error('missing taskId');
    }
    return {
        ...verifyAgentAssertion({
            token: readAuthorizationBearer(req),
            method: 'GET',
            path,
            tool: TASK_STATUS_TOOL,
            rch: computeRchTool({
                method: 'GET',
                path,
                tool: TASK_STATUS_TOOL,
                arguments: { taskId: normalizedTaskId },
            }),
            targetAgentId: agentName,
            replayCache: assertionCache,
        }),
        userDelegation: null,
    };
}

export function verifyDelegatedAgentTaskCancelCall({
    req,
    agentName,
    taskId,
    assertionCache = assertionReplayCache,
}) {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) throw new Error('missing taskId');
    return {
        ...verifyAgentAssertion({
            token: readAuthorizationBearer(req),
            method: 'POST',
            path: TASK_CANCEL_PATH,
            tool: TASK_CANCEL_TOOL,
            rch: computeRchTool({
                method: 'POST',
                path: TASK_CANCEL_PATH,
                tool: TASK_CANCEL_TOOL,
                arguments: { taskId: normalizedTaskId },
            }),
            targetAgentId: agentName,
            replayCache: assertionCache,
        }),
        userDelegation: null,
    };
}

export async function handleDelegatedAgentTaskCancel({
    req,
    res,
    route,
    agentName,
    beforeDial = null,
}) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) {
            sendJson(res, 413, { error: 'task_cancel_payload_too_large' });
            return;
        }
        chunks.push(chunk);
    }
    let body;
    try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (_) {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
    }
    const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : '';
    try {
        req.delegatedAgentVerified = verifyDelegatedAgentTaskCancelCall({ req, agentName, taskId });
        if (!route?.hostPort) {
            sendJson(res, 409, { error: 'task_agent_unavailable' });
            return;
        }
        const context = buildInvocationContextForProviderCall({
            req,
            agentName,
            toolName: TASK_CANCEL_TOOL,
            toolArgs: { taskId },
            method: 'POST',
            path: TASK_CANCEL_PATH,
        });
        if (beforeDial && await Promise.resolve(beforeDial()) !== true) {
            sendJson(res, 503, { error: 'edge_generation_changed' });
            return;
        }
        const payload = Buffer.from(JSON.stringify({ taskId }), 'utf8');
        const upstream = http.request({
            hostname: '127.0.0.1',
            port: route.hostPort,
            path: TASK_CANCEL_PATH,
            method: 'POST',
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                'content-length': payload.length,
                authorization: `Bearer ${context.token}`,
            },
        }, (response) => {
            res.writeHead(response.statusCode || 502, response.headers);
            response.pipe(res);
        });
        upstream.on('error', () => sendJson(res, 502, { error: 'task_cancel_upstream_failed' }));
        upstream.end(payload);
    } catch (error) {
        sendJson(res, 401, {
            error: 'delegated_task_cancel_rejected',
            reason: error?.message || 'delegated task cancel verification failed',
        });
    }
}

/**
 * Handle JSON-RPC requests to agent MCP endpoints
 */
async function handleAgentJsonRpc(req, res, route, agentName, payload, {
    beforeDial = null,
    pool = null,
    poolKey = null,
    ensureReady = null,
    snapshot = undefined,
} = {}) {
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
            toolArgs: toolArgs || {},
            snapshot,
        });
        if (ctx?.token) {
            return { authorization: `Bearer ${ctx.token}` };
        }
        return null;
    }

    const upstream = createUpstreamMcpCaller({
        baseUrl,
        hostPort: route.hostPort,
        beforeDial,
        pool,
        poolKey,
        ensureReady,
    });
    try {
        switch (message.method) {
            case 'tools/list': {
                const tools = await upstream.listTools();
                // Cache the full schema set for argument canonicalization, but only
                // advertise the tools this caller is permitted to invoke.
                agentToolSchemaCache.set(agentName, { loadedAt: Date.now(), tools });
                const visibleTools = policy.mcpToolPolicy.filterTools(agentName, tools, policy.resolveCaller(req));
                sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, result: { tools: visibleTools } }, sessionIdHeader);
                break;
            }
            case 'resources/list': {
                // Resources are an authenticated-class capability (DS016): a
                // session caller sees them, an internal/agent or anonymous
                // caller sees an empty list (mirrors tools/list filtering).
                const listDecision = policy.mcpToolPolicy.evaluateResource({ caller: policy.resolveCaller(req) });
                const resources = listDecision.allow ? await upstream.listResources() : [];
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
                const canonicalArgs = await canonicalizeToolArguments(agentName, upstream, name, args);

                // Mint a router-signed invocation token scoped to this tool call,
                // once per upstream attempt, and send it only in that request.
                const result = await upstream.callTool(name, canonicalArgs,
                    () => buildRequestHeadersForToolCall(name, canonicalArgs));
                sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, result }, sessionIdHeader);
                break;
            }
            case 'resources/read': {
                const params = message.params && typeof message.params === 'object' ? message.params : {};
                const uri = typeof params.uri === 'string' ? params.uri : null;
                if (!uri) {
                    sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32602, message: 'Missing resource uri' } }, sessionIdHeader);
                    break;
                }
                // Fail-closed resource gate (DS016) before any token is minted.
                const readDecision = policy.mcpToolPolicy.evaluateResource({ caller: policy.resolveCaller(req) });
                if (!readDecision.allow) {
                    sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32003, message: 'Access denied', data: { code: readDecision.code } } }, sessionIdHeader);
                    break;
                }
                const result = await upstream.readResource(uri,
                    () => buildRequestHeadersForToolCall('resources/read', { uri }));
                sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, result }, sessionIdHeader);
                break;
            }
            case 'ping': {
                await upstream.ping();
                sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, result: {} }, sessionIdHeader);
                break;
            }
            default:
                sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: `Method not found: ${message.method}` } }, sessionIdHeader);
        }
    } catch (err) {
        const messageText = err?.notReady
            ? `Agent '${agentName}' is still starting. Try again in a moment.`
            : (err && err.message ? err.message : String(err || 'unknown error'));
        sendResponse(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: messageText } }, sessionIdHeader);
    } finally {
        await upstream.close();
    }
}

function sendAgentNotReady(res, { isJsonRpc, message, agentName }) {
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
}

/**
 * Handle HTTP requests to agent MCP endpoints
 */
async function handleAgentMcpRequest(req, res, route, agentName, {
    beforeDial = null,
    routePlan = null,
    pool = agentUpstreamSessionPool,
    waitForAgentReady: waitForReady = waitForAgentReady,
} = {}) {
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
                req.delegatedAgentVerified = verifyDelegatedAgentToolCall({
                    req,
                    agentName,
                    toolName,
                    rawArgs,
                    assertionCache: assertionReplayCache,
                    snapshot: routePlan?.lease?.snapshot,
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
                const authResult = await ensureAuthenticated(req, res, parsedUrl, { routePlan });
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

        // Readiness cache (fails closed): a pooled key that answered within the
        // last 10 s skips the probe; every pooled POST still runs beforeDial,
        // and any pooled transport or session error clears the cache.
        // Only the committed lease manifest's explicit readiness.protocol counts;
        // derived protocols (start-only agents) and a missing manifest keep the
        // MCP probe. 'none' means the agent serves no MCP endpoint, so answer
        // now (authN/authZ are done) once the lease commit succeeds, without a
        // session, pool entry or dial. A beforeDial that is not a function
        // cannot commit, so it fails closed onto the existing path.
        const leaseManifest = routePlan?.lease?.snapshot?.manifests?.[routePlan?.routeKey];
        const declaredProtocol = leaseManifest ? readExplicitReadinessProtocol(leaseManifest) : '';
        if (declaredProtocol === 'none' && typeof beforeDial === 'function') {
            if (beforeDial() !== true) {
                sendAgentNotReady(res, { isJsonRpc, message, agentName });
                return;
            }
            const detail = `Agent '${agentName}' does not provide an MCP endpoint.`;
            if (isJsonRpc) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: message?.id ?? null,
                    error: { code: -32601, message: detail }
                }));
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'agent_mcp_unavailable', detail }));
            return;
        }
        const poolKey = resolveUpstreamPoolKey({ pool, routePlan, route, beforeDial });
        // 'tcp' is an explicit statement that the port is the readiness signal;
        // the request is still forwarded upstream afterwards.
        const probeReadiness = () => waitForReady(route, {
            timeoutMs: 5000,
            intervalMs: 125,
            probeTimeoutMs: 250,
            beforeProbe: beforeDial,
            ...(declaredProtocol === 'tcp' ? { protocol: 'tcp' } : {}),
        });
        const isReady = Boolean(poolKey && pool.isReady(poolKey)) || await probeReadiness();
        if (!isReady) {
            sendAgentNotReady(res, { isJsonRpc, message, agentName });
            return;
        }

        try {
            if (isJsonRpc) {
                await handleAgentJsonRpc(req, res, route, agentName, payload, {
                    beforeDial,
                    pool: poolKey ? pool : null,
                    poolKey,
                    ensureReady: probeReadiness,
                    snapshot: routePlan?.lease?.snapshot,
                });
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
    agentUpstreamSessionPool,
    handleAgentMcpRequest,
    readAgentSessionId,
    isJsonRpcPayload,
    handleAgentJsonRpc
};
