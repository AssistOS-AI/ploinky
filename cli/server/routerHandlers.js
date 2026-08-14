import http from 'http';
import net from 'node:net';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

import { sendJson } from './authHandlers/index.js';
import { createAgentClient } from './AgentClient.js';
import { buildInvocationContextForProviderCall } from './mcp-proxy/index.js';
import { buildRouterRequest } from './mcp-proxy/invocationMinter.js';
import { deriveDelegationKey } from './mcp-proxy/mcpDelegations.js';
import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { policy } from './policy/index.js';
import { loadRoutingConfig } from './routingState.js';
import { deriveAgentPrincipalId } from '../utils/security/agentIdentity.js';
import { ROUTING_FILE } from '../utils/config.js';
import { deriveSubkey } from '../utils/security/masterKey.js';
import { mintUserDelegationGrant } from './mcp-proxy/userDelegationGrant.js';

const ROUTER_PROTOCOL_VERSION = '2025-06-18';
const ROUTER_SERVER_INFO = { name: 'ploinky-router', version: '1.0.0' };
const ROUTER_INSTRUCTIONS = 'Ploinky Router aggregates tools and resources from registered agents.';
const DEFAULT_HTTP_ROUTE_INVOCATION_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const PLOINKY_RATE_SOURCE_HEADER = 'x-ploinky-rate-source';

const routerSessions = new Map();

export function loadApiRoutes() {
    return loadRoutingConfig().routes || {};
}

export function buildAgentPath(parsedUrl, includeSearch = true) {
    if (!parsedUrl || typeof parsedUrl !== 'object') return '/mcp';
    const pathname = parsedUrl.pathname && parsedUrl.pathname !== '/' ? parsedUrl.pathname : '';
    const search = includeSearch && parsedUrl.search ? parsedUrl.search : '';
    return `/mcp${pathname}${search}`;
}

export function postJsonToAgent(targetPort, payload, res, agentPath, extraHeaders = {}) {
    try {
        const data = Buffer.from(JSON.stringify(payload || {}));
        const opts = {
            hostname: '127.0.0.1',
            port: targetPort,
            path: agentPath && agentPath.length ? agentPath : '/mcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length,
                ...extraHeaders
            }
        };
        const upstream = http.request(opts, upstreamRes => {
            res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
            upstreamRes.pipe(res, { end: true });
        });
        upstream.on('error', err => {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: 'upstream error', detail: String(err) }));
        });
        upstream.end(data);
    } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'proxy failure', detail: String(err) }));
    }
}

export function proxyMcpPassthrough(req, res, targetPort, agentPath) {
    const pathWithLeadingSlash = agentPath.startsWith('/') ? agentPath : `/${agentPath}`;
    const opts = {
        hostname: '127.0.0.1',
        port: targetPort,
        path: pathWithLeadingSlash,
        method: req.method,
        headers: {
            ...req.headers,
            host: `127.0.0.1:${targetPort}`
        }
    };

    const upstream = http.request(opts, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        upstreamRes.pipe(res, { end: true });
    });

    upstream.on('error', err => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'upstream error', detail: String(err) }));
    });

    req.on('aborted', () => {
        upstream.destroy();
    });

    req.pipe(upstream, { end: true });
}

function rejectStaleLease(res) {
    if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    }
    res.end(JSON.stringify({ error: 'edge_generation_changed' }));
}

function staleLeaseError(cause = null) {
    const error = new Error('edge routing generation changed before upstream connection creation', cause ? { cause } : undefined);
    error.code = 'EDGE_GENERATION_CHANGED';
    error.statusCode = 503;
    return error;
}

export function createLeaseCommittedAgent(beforeDial, { createConnection = net.createConnection } = {}) {
    if (typeof beforeDial !== 'function') return undefined;
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = (options, callback) => {
        let committed = false;
        let failure = null;
        try {
            committed = beforeDial() === true;
        } catch (error) {
            failure = error;
        }
        if (!committed) {
            const error = staleLeaseError(failure);
            queueMicrotask(() => callback(error));
            return undefined;
        }
        return createConnection(options, callback);
    };
    return agent;
}

function handleProxyError(res, error) {
    if (error?.code === 'EDGE_GENERATION_CHANGED') {
        rejectStaleLease(res);
        return;
    }
    if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'upstream error', detail: String(error) }));
}

export function proxyHttpPassthrough(req, res, targetPort, agentPath, extraHeaders = {}, { beforeDial = null } = {}) {
    const pathWithLeadingSlash = agentPath.startsWith('/') ? agentPath : `/${agentPath}`;
    const headers = {
        ...stripRouterIdentityHeaders(req.headers, {
            preserveAuthorization: false,
            preserveCookie: false,
        }),
        host: `127.0.0.1:${targetPort}`,
        ...extraHeaders,
    };

    const upstream = http.request({
        hostname: '127.0.0.1',
        port: targetPort,
        path: pathWithLeadingSlash,
        method: req.method,
        headers,
        agent: createLeaseCommittedAgent(beforeDial),
    }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        upstreamRes.pipe(res, { end: true });
    });

    upstream.on('error', err => {
        handleProxyError(res, err);
    });

    req.on('aborted', () => {
        upstream.destroy();
    });

    req.pipe(upstream, { end: true });
    return upstream;
}

export function resolveHttpRouteInvocationMaxBodyBytes(env = process.env) {
    const raw = String(env?.PLOINKY_HTTP_ROUTE_INVOCATION_MAX_BODY_BYTES || '').trim();
    if (!raw) return DEFAULT_HTTP_ROUTE_INVOCATION_MAX_BODY_BYTES;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_ROUTE_INVOCATION_MAX_BODY_BYTES;
}

function pathOnly(pathWithQuery = '') {
    const value = String(pathWithQuery || '');
    const index = value.indexOf('?');
    return index >= 0 ? value.slice(0, index) : value;
}

function buildBufferedProxyHeaders(req, targetPort, body, extraHeaders = {}) {
    const headers = {
        ...stripRouterIdentityHeaders(req.headers),
        host: `127.0.0.1:${targetPort}`,
        ...extraHeaders,
    };
    for (const name of Object.keys(headers)) {
        const normalized = String(name).toLowerCase();
        if (normalized === 'transfer-encoding' || normalized === 'content-length') {
            delete headers[name];
        }
    }
    headers['content-length'] = String(body.length);
    return headers;
}

export function proxyHttpBuffered(req, res, targetPort, agentPath, body, extraHeaders = {}, { beforeDial = null } = {}) {
    const pathWithLeadingSlash = agentPath.startsWith('/') ? agentPath : `/${agentPath}`;
    const upstream = http.request({
        hostname: '127.0.0.1',
        port: targetPort,
        path: pathWithLeadingSlash,
        method: req.method,
        headers: buildBufferedProxyHeaders(req, targetPort, body, extraHeaders),
        agent: createLeaseCommittedAgent(beforeDial),
    }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        upstreamRes.pipe(res, { end: true });
    });

    upstream.on('error', err => {
        handleProxyError(res, err);
    });

    upstream.end(body);
    return upstream;
}

export function readRequestBody(req, {
    maxBytes = DEFAULT_HTTP_ROUTE_INVOCATION_MAX_BODY_BYTES,
    onSuccess,
    onError,
    onTooLarge,
}) {
    const chunks = [];
    const limit = Number(maxBytes) || DEFAULT_HTTP_ROUTE_INVOCATION_MAX_BODY_BYTES;
    let total = 0;
    let settled = false;
    const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
    };
    req.on('data', chunk => {
        const buffered = Buffer.from(chunk);
        total += buffered.length;
        if (total > limit) {
            finish(onTooLarge || onError, { limitBytes: limit, actualBytes: total });
            if (typeof req.destroy === 'function') {
                req.destroy();
            }
            return;
        }
        chunks.push(buffered);
    });
    req.on('end', () => finish(onSuccess, Buffer.concat(chunks)));
    req.on('error', err => finish(onError, err));
    req.on('aborted', () => finish(onError, new Error('request aborted')));
}

const ROUTER_IDENTITY_HEADERS = new Set([
    'x-ploinky-auth-info',
    'x-ploinky-user-delegation',
    'x-ploinky-user-id',
    'x-ploinky-user',
    'x-ploinky-user-email',
    'x-ploinky-user-roles',
    'x-ploinky-session-id',
    'cf-connecting-ip',
    'true-client-ip',
    'x-real-ip',
    'ploinky-agent-assertion',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
]);

export function stripRouterIdentityHeaders(headers = {}, { preserveAuthorization = true, preserveCookie = true } = {}) {
    const sanitized = {};
    for (const [name, value] of Object.entries(headers || {})) {
        const normalized = String(name || '').toLowerCase();
        if (ROUTER_IDENTITY_HEADERS.has(normalized)
            || normalized.startsWith('x-ploinky-')
            || normalized.startsWith('x-forwarded-')) continue;
        if (!preserveAuthorization && normalized === 'authorization') continue;
        if (!preserveCookie && normalized === 'cookie') continue;
        sanitized[name] = value;
    }
    return sanitized;
}

export function buildTrustedForwardingHeaders(routePlan) {
    const authority = String(routePlan?.forwarding?.authority || '').trim();
    const protocol = String(routePlan?.forwarding?.protocol || '').trim();
    if (!authority || !['http', 'https'].includes(protocol)) return {};
    return {
        host: authority,
        'x-forwarded-host': authority,
        'x-forwarded-proto': protocol,
    };
}

function normalizeRateSourceAddress(value) {
    if (Array.isArray(value) || typeof value !== 'string') return '';
    const raw = value.trim();
    if (!raw || raw !== value || raw.includes(',')) return '';
    if (raw.startsWith('::ffff:') && net.isIP(raw.slice(7)) === 4) return raw.slice(7);
    const family = net.isIP(raw);
    if (family === 4) return raw;
    if (family !== 6) return '';
    try {
        return new URL(`http://[${raw}]/`).hostname.slice(1, -1).toLowerCase();
    } catch (_) {
        return '';
    }
}

/**
 * Produce a route-scoped, non-reversible transport-source partition for guest
 * ingestion services. This is abuse-control metadata only: it is synthesized
 * after the immutable host/policy plan succeeds and is never authorization or
 * browser identity. Public-host requests use Cloudflare's connector-provided
 * source address; local aliases use the TCP peer observed by the Router.
 */
export function buildHttpRouteRateSourceHeader(req, routePlan) {
    if (routePlan?.decision?.access !== 'guest') return {};
    const publicConnectorRequest = routePlan?.hostSelection?.source === 'public-host';
    const sourceClass = publicConnectorRequest ? 'cloudflare' : 'socket';
    const rawAddress = publicConnectorRequest
        ? req?.headers?.['cf-connecting-ip']
        : req?.socket?.remoteAddress;
    const address = normalizeRateSourceAddress(rawAddress);
    if (!address) {
        const error = new Error('guest HTTP route has no valid canonical transport source');
        error.code = 'INVALID_RATE_SOURCE';
        error.statusCode = 400;
        throw error;
    }
    const routeKey = String(routePlan?.routeKey || routePlan?.authDefinition?.routeKey || '');
    const pathPrefix = String(routePlan?.authDefinition?.pathPrefix || '');
    if (!routeKey || !pathPrefix) {
        const error = new Error('guest HTTP route has no canonical rate-source scope');
        error.code = 'INVALID_RATE_SOURCE';
        error.statusCode = 503;
        throw error;
    }
    const partition = createHmac('sha256', deriveSubkey('router-rate-source', 32))
        .update(`http-route-rate-source\0${routeKey}\0${pathPrefix}\0${sourceClass}\0${address}`, 'utf8')
        .digest('hex');
    return { [PLOINKY_RATE_SOURCE_HEADER]: partition };
}

export function buildPlainAuthInfoHeader(req) {
    if (!req.user || typeof req.user !== 'object') {
        return {};
    }
    return {
        'x-ploinky-auth-info': JSON.stringify(buildPlainAuthInfo(req))
    };
}

function buildPlainAuthInfo(req) {
    return {
        user: {
            id: req.user.id || '',
            username: req.user.username || req.user.name || req.user.email || '',
            email: req.user.email || '',
            roles: Array.isArray(req.user.roles) ? [...req.user.roles] : []
        },
        sessionId: req.sessionId || ''
    };
}

function resolveHttpRouteActorKind(authInfo = {}) {
    const roles = Array.isArray(authInfo.user?.roles)
        ? authInfo.user.roles.map(role => String(role || '').trim().toLowerCase())
        : [];
    return roles.includes('guest') ? 'guest' : 'user';
}

function buildHttpRouteInvocationBody(req, parsedUrl, definition, { bodyHash = '', routePath = '' } = {}) {
    return {
        method: String(req.method || 'GET').toUpperCase(),
        externalPath: parsedUrl?.pathname || '',
        path: pathOnly(routePath || parsedUrl?.pathname || ''),
        search: parsedUrl?.search || '',
        routeKey: definition.routeKey || '',
        bodyHash: String(bodyHash || sha256RawBodyHash())
    };
}

function resolveHttpRoutePrincipal(definition) {
    const repoName = String(definition?.route?.repo || '').trim();
    const agentName = String(definition?.route?.agent || '').trim();
    if (!repoName || !agentName) return null;
    try {
        return deriveAgentPrincipalId(repoName, agentName);
    } catch (_) {
        return null;
    }
}

function resolveUserDelegationSigningSecret() {
    return deriveSubkey('router-user-delegation', 32);
}

function normalizeConditionPath(value) {
    const raw = String(value || '').trim().replace(/\\/g, '/');
    if (!raw) return '';
    const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
    const normalized = path.posix.normalize(prefixed);
    if (!normalized || normalized === '.') return '';
    return normalized === '/' ? '/' : normalized.replace(/\/+$/g, '');
}

function isWithinPathRoot(value, root) {
    const normalizedValue = normalizeConditionPath(value);
    const normalizedRoot = normalizeConditionPath(root);
    if (!normalizedValue || !normalizedRoot) return false;
    if (normalizedRoot === '/') return true;
    return normalizedValue === normalizedRoot || normalizedValue.startsWith(`${normalizedRoot}/`);
}

function routeDelegationMatchesRequest(entry = {}, { parsedUrl } = {}) {
    const when = entry.when;
    if (!when) {
        return true;
    }
    const queryParam = String(when.queryParam || 'path').trim();
    const pathValue = parsedUrl?.searchParams?.get(queryParam) || '';
    if (!pathValue) {
        return false;
    }
    const roots = Array.isArray(when.pathRoots) ? when.pathRoots : [];
    return roots.some((root) => isWithinPathRoot(pathValue, root));
}

function buildRouteDelegations(req, definition, { routePath = '', parsedUrl = null } = {}) {
    const authInfo = buildPlainAuthInfo(req);
    const actorKind = resolveHttpRouteActorKind(authInfo);
    if (actorKind !== 'user') {
        return undefined;
    }
    const user = authInfo.user;
    if (!user?.id || !Array.isArray(definition?.delegations) || !definition.delegations.length) {
        return undefined;
    }

    const signingSecret = resolveUserDelegationSigningSecret();
    const out = {};
    for (let index = 0; index < definition.delegations.length; index += 1) {
        const entry = definition.delegations[index];
        if (!routeDelegationMatchesRequest(entry, { parsedUrl })) {
            continue;
        }
        const { token, payload } = mintUserDelegationGrant({
            signingSecret,
            ttlSeconds: entry.ttlSeconds,
            sourceAgentId: resolveHttpRoutePrincipal(definition),
            route: {
                routeKey: definition.routeKey,
                pathPrefix: definition.pathPrefix,
                requestPath: pathOnly(routePath),
            },
            user,
            targetAgentId: entry.targetAgentId,
            tools: entry.tools,
            scopes: entry.scope,
        });
        out[deriveDelegationKey(entry, index)] = {
            token,
            expiresAt: new Date(Number(payload.exp || 0) * 1000).toISOString(),
            targetAgentId: entry.targetAgentId,
            tools: [...entry.tools],
            scope: [...entry.scope],
        };
    }
    return Object.keys(out).length ? out : undefined;
}

export function buildHttpRouteAuthInfoHeader(req, parsedUrl, definition, { bodyHash = '', routePath = '' } = {}) {
    if (!definition?.includeAuthInfo || !req.user || typeof req.user !== 'object') {
        return {};
    }

    const authInfo = buildPlainAuthInfo(req);
    if (definition.issueInvocation) {
        const invocationBody = buildHttpRouteInvocationBody(req, parsedUrl, definition, { bodyHash, routePath });
        // Fail closed if the route cannot be resolved to an installed
        // agent principal — never forward unsigned identity metadata.
        const routePrincipal = resolveHttpRoutePrincipal(definition);
        if (!routePrincipal) {
            throw new Error(`invocationMinter: could not resolve provider '${definition.routeKey}'`);
        }
        // Router Request signed with the target agent's own secret; rch binds
        // the token to the HTTP request surface, including the raw body hash.
        const sub = authInfo.user?.id ? `user:${authInfo.user.id}` : '';
        const { token } = buildRouterRequest({
            targetAgentId: routePrincipal,
            sub,
            actor: {
                kind: resolveHttpRouteActorKind(authInfo),
                id: sub,
                roles: Array.isArray(authInfo.user?.roles) ? authInfo.user.roles : [],
            },
            method: invocationBody.method,
            path: invocationBody.path,
            tool: '__http_route__',
            rch: computeRchHttp({
                method: invocationBody.method,
                path: invocationBody.path,
                query: invocationBody.search,
                bodyHash: invocationBody.bodyHash,
            }),
        });
        authInfo.invocationToken = token;
        authInfo.invocationBody = invocationBody;
    }
    const delegations = buildRouteDelegations(req, definition, {
        routePath: routePath || parsedUrl?.pathname || '',
        parsedUrl,
    });
    if (delegations) {
        authInfo.delegations = delegations;
    }

    return {
        'x-ploinky-auth-info': JSON.stringify(authInfo)
    };
}

export function readHeaderValue(headers = {}, headerName) {
    const direct = headers?.[headerName];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const lower = headers?.[String(headerName || '').toLowerCase()];
    return typeof lower === 'string' && lower.trim() ? lower.trim() : '';
}

export function proxyApi(req, res, targetPort, identityHeaders = {}) {
    const method = (req.method || 'GET').toUpperCase();
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const includeSearch = method !== 'GET';
    const agentPath = buildAgentPath(parsed, includeSearch);
    if (method === 'GET') {
        // Convert URLSearchParams to plain object
        const params = {};
        parsed.searchParams.forEach((value, key) => {
            params[key] = value;
        });
        return postJsonToAgent(targetPort, params, res, agentPath, identityHeaders);
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const body = Buffer.concat(chunks);
        const data = body.length ? body : Buffer.from('{}');
        const opts = {
            hostname: '127.0.0.1',
            port: targetPort,
            path: agentPath,
            method: method,
            headers: {
                'Content-Type': req.headers['content-type'] || 'application/json',
                'Content-Length': data.length,
                ...identityHeaders
            }
        };
        const upstream = http.request(opts, upstreamRes => {
            res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
            upstreamRes.pipe(res, { end: true });
        });
        upstream.on('error', err => {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: 'upstream error', detail: String(err) }));
        });
        upstream.end(data);
    });
    req.on('error', err => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'request error', detail: String(err) }));
    });
}

function commitAggregateLease(routePlan) {
    return routePlan?.lease?.commit?.() === true;
}

export function createAgentRouteEntries(routePlan) {
    const routes = routePlan?.lease?.snapshot?.routing?.routes;
    if (!routes || typeof routes !== 'object') {
        const error = new Error('active edge routing generation lease is required for aggregate MCP');
        error.code = 'EDGE_GENERATION_REQUIRED';
        error.statusCode = 503;
        throw error;
    }
    const entries = [];
    for (const [agentName, route] of Object.entries(routes || {})) {
        if (!route || route.disabled) continue;
        const port = Number(route.hostPort);
        if (!Number.isFinite(port)) continue;
        const baseUrl = `http://127.0.0.1:${port}/mcp`;
        const beforeConnect = () => commitAggregateLease(routePlan);
        entries.push({
            agentName,
            port,
            baseUrl,
            beforeConnect,
            client: createAgentClient(baseUrl, { beforeConnect }),
        });
    }
    return entries;
}

function annotateTool(tool, agentName) {
    const baseAnnotations = tool && typeof tool === 'object' && tool.annotations && typeof tool.annotations === 'object'
        ? tool.annotations
        : {};
    const routerAnnotations = baseAnnotations.router && typeof baseAnnotations.router === 'object'
        ? baseAnnotations.router
        : {};
    const annotations = {
        ...baseAnnotations,
        router: {
            ...routerAnnotations,
            agent: agentName
        }
    };
    return { ...tool, annotations };
}

function annotateResource(resource, agentName) {
    const baseAnnotations = resource && typeof resource === 'object' && resource.annotations && typeof resource.annotations === 'object'
        ? resource.annotations
        : {};
    const routerAnnotations = baseAnnotations.router && typeof baseAnnotations.router === 'object'
        ? baseAnnotations.router
        : {};
    const annotations = {
        ...baseAnnotations,
        router: {
            ...routerAnnotations,
            agent: agentName
        }
    };
    return { ...resource, annotations };
}

function isJsonRpcMessage(payload) {
    if (Array.isArray(payload)) {
        return payload.some(item => item && typeof item === 'object' && item.jsonrpc === '2.0');
    }
    return !!(payload && typeof payload === 'object' && payload.jsonrpc === '2.0');
}

function summarizeMcpError(err, action) {
    const raw = (err && err.message ? err.message : String(err || '')) || '';
    if (/invalid_literal/.test(raw) && /jsonrpc/.test(raw)) {
        return `${action} failed: agent response is not MCP JSON-RPC (AgentServer may be disabled).`;
    }
    if (/ECONNREFUSED/.test(raw)) {
        return `${action} failed: connection refused (AgentServer offline?).`;
    }
    if (/ENOTFOUND|EHOSTUNREACH/.test(raw)) {
        return `${action} failed: agent host is unreachable.`;
    }
    const normalized = raw.replace(/\s+/g, ' ').trim();
    if (!normalized.length) {
        return `${action} failed: unknown error.`;
    }
    const truncated = normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
    return `${action} failed: ${truncated}`;
}

async function collectTools(entries) {
    const toolsByAgent = new Map();
    const toolIndex = new Map();
    const errors = [];
    const failures = new Map();

    await Promise.all(entries.map(async (entry) => {
        try {
            const tools = await entry.client.listTools();
            toolsByAgent.set(entry.agentName, tools || []);
            for (const tool of tools || []) {
                const name = tool && tool.name ? String(tool.name) : null;
                if (!name) continue;
                if (!toolIndex.has(name)) {
                    toolIndex.set(name, []);
                }
                toolIndex.get(name).push({ entry, tool });
            }
        } catch (err) {
            if (err?.code === 'EDGE_GENERATION_CHANGED') throw err;
            const message = summarizeMcpError(err, 'listTools');
            errors.push({ agent: entry.agentName, error: message });
            failures.set(entry.agentName, message);
        }
    }));

    return { toolsByAgent, toolIndex, errors, failures };
}

async function collectResources(entries) {
    const resourcesByAgent = new Map();
    const errors = [];
    const failures = new Map();

    await Promise.all(entries.map(async (entry) => {
        try {
            const resources = await entry.client.listResources();
            resourcesByAgent.set(entry.agentName, resources || []);
        } catch (err) {
            if (err?.code === 'EDGE_GENERATION_CHANGED') throw err;
            const message = summarizeMcpError(err, 'listResources');
            errors.push({ agent: entry.agentName, error: message });
            failures.set(entry.agentName, message);
        }
    }));

    return { resourcesByAgent, errors, failures };
}

function readSessionHeader(req) {
    const value = req.headers['mcp-session-id'];
    if (Array.isArray(value)) return value[0];
    return typeof value === 'string' ? value : null;
}

function getSession(sessionId) {
    if (!sessionId) return null;
    const entry = routerSessions.get(sessionId);
    if (!entry) return null;
    entry.lastSeen = Date.now();
    return entry;
}

function startSession() {
    const sessionId = randomUUID();
    routerSessions.set(sessionId, { createdAt: Date.now(), lastSeen: Date.now() });
    return sessionId;
}

function endSession(sessionId) {
    if (!sessionId) return;
    routerSessions.delete(sessionId);
}

function canonicalCommand(command) {
    if (typeof command !== 'string') return '';
    const trimmed = command.trim();
    if (!trimmed) return '';
    if (trimmed === 'tools/list') return 'list_tools';
    if (trimmed === 'tools/call') return 'tool';
    if (trimmed === 'resources/list') return 'list_resources';
    if (trimmed === 'resources/read') return 'resources/read';
    if (trimmed === 'ping') return 'ping';
    const lower = trimmed.toLowerCase();
    switch (lower) {
        case 'methods':
        case 'list_tools':
        case 'tools':
            return 'list_tools';
        case 'list_resources':
        case 'resources':
            return 'list_resources';
        case 'tool':
            return 'tool';
        case 'status':
            return 'status';
        case 'ping':
            return 'ping';
        default:
            return trimmed;
    }
}

function buildToolRequestHeaders(req, agentName, toolName, toolArgs) {
    const invocation = buildInvocationContextForProviderCall({
        req: req || { headers: {} },
        agentName,
        toolName,
        toolArgs: toolArgs || {}
    });
    if (!invocation?.token) return null;
    return { authorization: `Bearer ${invocation.token}` };
}

async function callEntryTool(entry, toolName, args, req) {
    const requestHeaders = buildToolRequestHeaders(req, entry.agentName, toolName, args);
    if (!requestHeaders) {
        return await entry.client.callTool(toolName, args);
    }
    const client = createAgentClient(entry.baseUrl, {
        requestHeaders,
        beforeConnect: entry.beforeConnect,
    });
    try {
        return await client.callTool(toolName, args);
    } finally {
        await client.close().catch(() => {});
    }
}

async function readEntryResource(entry, uri, req) {
    const requestHeaders = buildToolRequestHeaders(req, entry.agentName, 'resources/read', { uri });
    if (!requestHeaders) {
        return await entry.client.readResource(uri);
    }
    const client = createAgentClient(entry.baseUrl, {
        requestHeaders,
        beforeConnect: entry.beforeConnect,
    });
    try {
        return await client.readResource(uri);
    } finally {
        await client.close().catch(() => {});
    }
}

async function executeRouterCommand(command, payload = {}, req = null, routePlan = null) {
    const normalized = canonicalCommand(command);
    let entries;
    try {
        entries = createAgentRouteEntries(routePlan);
    } catch (error) {
        return {
            statusCode: error?.statusCode || 503,
            body: { error: error?.code || 'EDGE_GENERATION_REQUIRED' },
        };
    }
    if (!entries.length) {
        return {
            statusCode: 503,
            body: { error: 'no MCP agents are registered with the router' }
        };
    }

    try {
        switch (normalized) {
            case 'list_tools': {
                const { toolsByAgent, errors, failures } = await collectTools(entries);
                const caller = policy.resolveCaller(req);
                const aggregated = [];
                const emptyAgents = [];
                for (const entry of entries) {
                    if (failures.has(entry.agentName)) {
                        continue;
                    }
                    // Only advertise tools this caller is permitted to invoke.
                    const tools = policy.mcpToolPolicy.filterTools(entry.agentName, toolsByAgent.get(entry.agentName) || [], caller);
                    if (!tools.length) {
                        emptyAgents.push(entry.agentName);
                        continue;
                    }
                    for (const tool of tools) {
                        aggregated.push(annotateTool(tool, entry.agentName));
                    }
                }
                return { statusCode: 200, body: { tools: aggregated, emptyAgents, errors } };
            }
            case 'list_resources': {
                // Resources are an authenticated-class capability (DS015): an
                // internal/agent or anonymous caller gets an empty list.
                if (!policy.mcpToolPolicy.evaluateResource({ caller: policy.resolveCaller(req) }).allow) {
                    return { statusCode: 200, body: { resources: [], errors: [] } };
                }
                const { resourcesByAgent, errors, failures } = await collectResources(entries);
                const aggregated = [];
                for (const entry of entries) {
                    if (failures.has(entry.agentName)) {
                        continue;
                    }
                    const resources = resourcesByAgent.get(entry.agentName) || [];
                    for (const resource of resources) {
                        aggregated.push(annotateResource(resource, entry.agentName));
                    }
                }
                return { statusCode: 200, body: { resources: aggregated, errors } };
            }
            case 'tool': {
                const requestedAgent = payload && payload.agent ? String(payload.agent) : null;
                const candidates = requestedAgent
                    ? entries.filter(entry => entry.agentName === requestedAgent)
                    : entries;

                if (requestedAgent && !candidates.length) {
                    return { statusCode: 404, body: { error: `agent '${requestedAgent}' is not registered` } };
                }

                const { toolIndex, errors, failures } = await collectTools(candidates);

                if (requestedAgent && failures.has(requestedAgent)) {
                    return { statusCode: 502, body: { error: failures.get(requestedAgent) } };
                }

                const toolName = payload && (payload.tool || payload.toolName || payload.name)
                    ? String(payload.tool || payload.toolName || payload.name)
                    : null;
                if (!toolName) {
                    return { statusCode: 400, body: { error: 'missing tool name (use tool=<name> or toolName=<name>)' } };
                }

                const matches = toolIndex.get(toolName) || [];
                const resolved = requestedAgent
                    ? matches.find(item => item.entry.agentName === requestedAgent) ?? null
                    : matches[0] ?? null;

                if (!resolved) {
                    if (matches.length > 1) {
                        const agents = matches.map(item => item.entry.agentName);
                        return { statusCode: 409, body: { error: `tool '${toolName}' is provided by multiple agents`, agents } };
                    }
                    return { statusCode: 404, body: { error: `tool '${toolName}' was not found`, errors } };
                }

                if (!requestedAgent && matches.length > 1) {
                    const agents = matches.map(item => item.entry.agentName);
                    return { statusCode: 409, body: { error: `tool '${toolName}' is provided by multiple agents`, agents, errors } };
                }

                const args = {};
                if (payload && typeof payload === 'object') {
                    const argPayload = payload['arguments'];
                    if (argPayload && typeof argPayload === 'object' && !Array.isArray(argPayload)) {
                        Object.assign(args, argPayload);
                    }
                    for (const [key, value] of Object.entries(payload)) {
                        if (['command', 'tool', 'toolName', 'agent', 'arguments', 'name'].includes(key)) continue;
                        args[key] = value;
                    }
                }

                // MCP tool policy (fail-closed) gates the aggregate call too.
                const aggDecision = policy.mcpToolPolicy.evaluate({
                    agent: resolved.entry.agentName,
                    tool: toolName,
                    caller: policy.resolveCaller(req),
                });
                if (!aggDecision.allow) {
                    return { statusCode: aggDecision.status || 403, body: { error: 'access_denied', code: aggDecision.code } };
                }
                const response = await callEntryTool(resolved.entry, toolName, args, req);
                return {
                    statusCode: 200,
                    body: {
                        result: response,
                        agent: resolved.entry.agentName,
                        tool: toolName,
                        errors
                    }
                };
            }
            case 'resources/read': {
                const uri = payload && typeof payload.uri === 'string' ? payload.uri : null;
                if (!uri) {
                    return { statusCode: 400, body: { error: 'missing uri' } };
                }
                // Fail-closed resource gate (DS015) before any lookup or mint.
                const readDecision = policy.mcpToolPolicy.evaluateResource({ caller: policy.resolveCaller(req) });
                if (!readDecision.allow) {
                    return { statusCode: readDecision.status || 403, body: { error: 'access_denied', code: readDecision.code } };
                }
                const requestedAgent = payload && payload.agent ? String(payload.agent) : null;
                const candidateEntries = requestedAgent
                    ? entries.filter(entry => entry.agentName === requestedAgent)
                    : entries;
                if (requestedAgent && !candidateEntries.length) {
                    return { statusCode: 404, body: { error: `agent '${requestedAgent}' is not registered` } };
                }
                const { resourcesByAgent, errors, failures } = await collectResources(candidateEntries);
                let resolvedEntry = null;
                for (const entry of candidateEntries) {
                    if (failures.has(entry.agentName)) {
                        continue;
                    }
                    const resources = resourcesByAgent.get(entry.agentName) || [];
                    if (resources.some(resource => resource && resource.uri === uri)) {
                        resolvedEntry = entry;
                        break;
                    }
                }
                if (!resolvedEntry) {
                    if (failures.size && !resourcesByAgent.size) {
                        return { statusCode: 502, body: { error: 'resource lookup failed due to upstream errors', errors } };
                    }
                    return { statusCode: 404, body: { error: `resource '${uri}' was not found`, errors } };
                }
                try {
                    const resource = await readEntryResource(resolvedEntry, uri, req);
                    return { statusCode: 200, body: { resource, agent: resolvedEntry.agentName, errors } };
                } catch (err) {
                    if (err?.code === 'EDGE_GENERATION_CHANGED') {
                        return { statusCode: 503, body: { error: 'edge_generation_changed' } };
                    }
                    const message = summarizeMcpError(err, 'readResource');
                    return { statusCode: 500, body: { error: message, errors } };
                }
            }
            case 'ping': {
                const requestedAgent = payload && payload.agent ? String(payload.agent) : null;
                if (!requestedAgent) {
                    return { statusCode: 400, body: { error: 'missing agent for ping' } };
                }
                const entry = entries.find(item => item.agentName === requestedAgent) || null;
                if (!entry) {
                    return { statusCode: 404, body: { error: `agent '${requestedAgent}' is not registered` } };
                }
                try {
                    const result = await entry.client.ping();
                    return { statusCode: 200, body: { result: result ?? {}, agent: entry.agentName } };
                } catch (err) {
                    if (err?.code === 'EDGE_GENERATION_CHANGED') {
                        return { statusCode: 503, body: { error: 'edge_generation_changed' } };
                    }
                    const message = summarizeMcpError(err, 'ping');
                    return { statusCode: 502, body: { error: message } };
                }
            }
            case 'status': {
                return { statusCode: 400, body: { error: 'status command is not supported on aggregated endpoint' } };
            }
            default:
                return { statusCode: 400, body: { error: `unknown command '${command}'` } };
        }
    } catch (err) {
        const message = err && err.message ? err.message : String(err || 'unknown error');
        return {
            statusCode: err?.code === 'EDGE_GENERATION_CHANGED' ? 503 : 500,
            body: { error: err?.code === 'EDGE_GENERATION_CHANGED' ? 'edge_generation_changed' : message },
        };
    } finally {
        await Promise.all(entries.map(entry => entry.client.close().catch(() => { })));
    }
}

async function handleRouterJsonRpc(req, res, payload, routePlan) {
    const isBatch = Array.isArray(payload);
    const messages = isBatch ? payload : [payload];
    if (!messages.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Empty request batch' }, id: null }));
        return;
    }

    const headerSessionId = readSessionHeader(req);
    const hasValidSession = headerSessionId && getSession(headerSessionId);
    let sessionIdForResponse = hasValidSession ? headerSessionId : null;

    const responses = [];

    for (const message of messages) {
        if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
            responses.push({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
            continue;
        }

        if (message.method === 'initialize') {
            const newSessionId = startSession();
            sessionIdForResponse = newSessionId;
            responses.push({
                jsonrpc: '2.0',
                id: message.id ?? null,
                result: {
                    protocolVersion: ROUTER_PROTOCOL_VERSION,
                    capabilities: {
                        tools: { listChanged: false },
                        resources: { listChanged: false }
                    },
                    serverInfo: ROUTER_SERVER_INFO,
                    instructions: ROUTER_INSTRUCTIONS
                }
            });
            continue;
        }

        if (message.method === 'notifications/initialized') {
            if (sessionIdForResponse) {
                getSession(sessionIdForResponse);
            }
            continue;
        }

        const activeSessionId = sessionIdForResponse && getSession(sessionIdForResponse) ? sessionIdForResponse : null;
        if (!activeSessionId) {
            responses.push({
                jsonrpc: '2.0',
                id: message.id ?? null,
                error: { code: -32000, message: 'Missing or invalid MCP session' }
            });
            continue;
        }

        getSession(activeSessionId);

        try {
            let result;
            let rpcResultPayload = null;
            switch (message.method) {
                case 'tools/list':
                    result = await executeRouterCommand('list_tools', {}, req, routePlan);
                    if (result.statusCode < 400) {
                        const tools = Array.isArray(result.body?.tools) ? result.body.tools : [];
                        rpcResultPayload = { tools };
                    }
                    break;
                case 'resources/list':
                    result = await executeRouterCommand('list_resources', {}, req, routePlan);
                    if (result.statusCode < 400) {
                        const resources = Array.isArray(result.body?.resources) ? result.body.resources : [];
                        rpcResultPayload = { resources };
                    }
                    break;
                case 'tools/call': {
                    const params = message.params && typeof message.params === 'object' ? message.params : {};
                    const argPayload = params['arguments'] && typeof params['arguments'] === 'object' && !Array.isArray(params['arguments'])
                        ? params['arguments']
                        : {};
                    const commandPayload = {
                        arguments: argPayload
                    };
                    if (params.tool !== undefined) {
                        commandPayload.tool = params.tool;
                    }
                    if (typeof params.name === 'string' && !commandPayload.tool) {
                        commandPayload.tool = params.name;
                    }
                    if (params.agent !== undefined) {
                        commandPayload.agent = params.agent;
                    }
                    const metaAgent = params && params._meta && params._meta.router && typeof params._meta.router.agent === 'string'
                        ? params._meta.router.agent
                        : null;
                    if (metaAgent && !commandPayload.agent) {
                        commandPayload.agent = metaAgent;
                    }
                    result = await executeRouterCommand('tool', commandPayload, req, routePlan);
                    if (result.statusCode < 400) {
                        rpcResultPayload = result.body?.result;
                    }
                    break;
                }
                case 'resources/read': {
                    const params = message.params && typeof message.params === 'object' ? message.params : {};
                    if (params._meta && params._meta.router && typeof params._meta.router.agent === 'string' && params.agent === undefined) {
                        params.agent = params._meta.router.agent;
                    }
                    result = await executeRouterCommand('resources/read', params, req, routePlan);
                    if (result.statusCode < 400) {
                        rpcResultPayload = result.body?.resource;
                    }
                    break;
                }
                case 'ping': {
                    const params = message.params && typeof message.params === 'object' ? message.params : {};
                    if (params._meta && params._meta.router && typeof params._meta.router.agent === 'string' && params.agent === undefined) {
                        params.agent = params._meta.router.agent;
                    }
                    result = await executeRouterCommand('ping', params, req, routePlan);
                    if (result.statusCode < 400) {
                        rpcResultPayload = result.body?.result ?? {};
                    }
                    break;
                }
                default:
                    responses.push({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: `Method not found: ${message.method}` } });
                    continue;
            }

            if (result.statusCode >= 400) {
                const messageText = result.body?.error || 'Router error';
                responses.push({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: messageText } });
            } else {
                responses.push({ jsonrpc: '2.0', id: message.id ?? null, result: rpcResultPayload });
            }
        } catch (err) {
            const messageText = err && err.message ? err.message : String(err || 'unknown error');
            responses.push({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: messageText } });
        }
    }

    const headers = { 'mcp-protocol-version': ROUTER_PROTOCOL_VERSION };
    if (sessionIdForResponse) {
        headers['mcp-session-id'] = sessionIdForResponse;
    }

    if (!responses.length) {
        res.writeHead(204, headers);
        res.end();
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(isBatch ? responses : responses[0]));
}

export async function handleRouterMcp(req, res, routePlan) {
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, DELETE' });
        res.end(JSON.stringify({ error: 'event_stream_not_supported' }));
        return;
    }

    if (method === 'DELETE') {
        const sessionId = readSessionHeader(req);
        endSession(sessionId);
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

        try {
            const isRpc = isJsonRpcMessage(payload);

            if (isRpc) {
                await handleRouterJsonRpc(req, res, payload, routePlan);
                return;
            }

            const command = payload && typeof payload.command === 'string' ? payload.command : '';
            const { statusCode, body } = await executeRouterCommand(command, payload, req, routePlan);
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
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

export { ROUTING_FILE };
