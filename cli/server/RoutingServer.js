import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { handleWebChat } from './handlers/webchat/index.js';
import { handleDashboard } from './handlers/dashboard.js';
import { handleStatus } from './handlers/status.js';
import { handleBlobs, handleWorkspaceUpload } from './handlers/blobs.js';
import * as staticSrv from './static/index.js';

// Authentication and routing
import {
    ensureAuthenticated,
    ensureHttpRouteAccess,
    handleAuthRoutes,
    handleMarketplaceRoutes,
    handleUserAdminRoutes,
    resolveRouteDefaultHttpAccess,
} from './authHandlers/index.js';
import {
    buildHttpServiceAuthInfoHeader,
    handleRouterMcp,
} from './routerHandlers.js';
import { buildServiceAgentPath, collectHttpServiceRoutes, resolveHttpServiceRoute } from './httpServiceRoutes.js';
import { RoutingRuntime } from './generation/RoutingRuntime.js';
import {
    classifyRequestAuthority,
    normalizeAuthority,
    resolveLoopbackAuthorityRedirect,
} from './generation/authority.js';
import { clearRoutingRuntime, setRoutingRuntime } from './generation/runtimeContext.js';
import { createRelayHttpAgent, executeHttpPlan, RelayDuplex } from './proxy/executeHttpPlan.js';
import { executeWebSocketPlan } from './proxy/executeWebSocketPlan.js';
import { sanitizeRequestHeaders } from './proxy/sanitizeRequestHeaders.js';
import { recordProxyOutcome } from './proxy/recordProxyOutcome.js';
import { getAgentPortLocatorAccess, locateAgentPort } from './agentPortConvention/locator.js';
import { AGENT_PORT_CONVENTION_ROUTE_KEY } from '../utils/runtime/reservedRouteKeys.js';
import { ROUTING_FILE } from '../utils/config.js';
import { buildStatusLine, createCapturingRes } from './wsServiceProxy.js';
import { finalizePlanAfterAdmission } from './proxy/RoutePlan.js';
import { sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { createPrivateListener, createPrivateRouteHandler } from './privateListener.js';
import { proveContainerLoopbackBinding } from './privateListenerBindings/containerLoopbackBinding.js';
import { MachineCallAssertionService } from './security/tokens/MachineCallAssertionService.js';
import { deriveAgentRequestSecret } from '../utils/security/masterKey.js';

// Logging
import { appendLog, logBootEvent, logMemoryUsage } from './utils/logger.js';
import { isRouteMount } from './utils/routeMounts.js';

// New modular components
import {
    agentSessionStore,
    buildInvocationContextForProviderCall,
    handleAgentMcpRequest,
    verifyDelegatedAgentTaskStatusCall,
} from './mcp-proxy/index.js';
import { initializeTTYFactories, createServiceConfig } from './utils/ttyFactories.js';
import { setupProcessLifecycle } from './utils/processLifecycle.js';
import { policy } from './policy/index.js';
import { createHttpServiceProvider, createManifestRouteProvider } from './policy/HttpRouteProviders.js';
import { hasInternalAgentSegment } from './internalAgentPath.js';
import {
    USER_IDENTITY_KEY_PATH,
    handleUserIdentityKeyRoute,
} from './userIdentityKeyRoute.js';
import {
    OPENAI_AGENT_DISCOVERY_PATH,
    handleOpenAiAgentDiscoveryRoute,
} from './openAiAgentDiscovery.js';
import {
    isDelegatedAgentOpenAiCall,
    handleDelegatedAgentOpenAiCall,
} from './agentOpenAiDelegation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_BROWSER_CLIENT_PATH = path.resolve(__dirname, '../../Agent/client/MCPBrowserClient.js');
const routerPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const publicBind = String(process.env.PLOINKY_PUBLIC_BIND || '127.0.0.1').trim();
const publicAuthority = normalizeAuthority(process.env.PLOINKY_PUBLIC_AUTHORITY || `${publicBind}:${routerPort}`, 'public');

if ((publicBind === '0.0.0.0' || publicBind === '::') && !process.env.PLOINKY_PUBLIC_AUTHORITY) {
    throw new Error('PLOINKY_PUBLIC_AUTHORITY is required for a wildcard public bind');
}

// Initialize TTY factories
const { getWebchatFactory } = await initializeTTYFactories();

// Create service configuration
const config = createServiceConfig(getWebchatFactory);

// Safe console write that catches EPIPE/EIO errors
function safeLog(...args) {
    try {
        console.log(...args);
    } catch (_) {
        // Ignore write errors - stdout may be broken
    }
}

if (!global.processKill) {
    global.processKill = function (pid, signal) {
        if (pid === 0 || pid === process.pid || pid === (-process.pid)) {
            try { console.error("Cannot kill process 0 or self"); } catch (_) {}
            return;
        }
        safeLog(`Killing process ${pid} with signal ${signal}`);
        process.kill(pid, signal);
    }
}
// Global state for all services
const globalState = {
    webchat: { sessions: new Map(), runtimes: new Map() },
    dashboard: { sessions: new Map() },
    status: { sessions: new Map() }
};

policy.httpRouteAccessPolicy.bindProviders({
    manifestRouteProvider: createManifestRouteProvider(() => routingRuntime?.store.active?.routes || {}),
    httpServiceProvider: createHttpServiceProvider(() => collectHttpServiceRoutes()),
    routeDefaultProvider: ({ routeKey }) => resolveRouteDefaultHttpAccess(routeKey),
});

const routingRuntime = new RoutingRuntime({
    routingFile: ROUTING_FILE,
    policy,
    publicAuthority,
});
setRoutingRuntime(routingRuntime);
const machineCallAssertions = new MachineCallAssertionService({
    resolveAgentSecret: deriveAgentRequestSecret,
    generationStore: routingRuntime.store,
});
policy.repository.onMutation(() => {
    try { routingRuntime.refresh(); } catch (error) {
        appendLog('routing_generation_rejected', { error: error?.message || String(error) });
    }
});
let privateServer = null;

try {
    routingRuntime.refresh();
    routingRuntime.watch(error => appendLog('routing_generation_rejected', { error: error?.message || String(error) }));
} catch (error) {
    appendLog('routing_generation_inactive', { error: error?.message || String(error) });
}

function activeRoutes() {
    return routingRuntime.store.active?.routes || {};
}

/**
 * Serve MCP Browser Client
 */
function serveMcpBrowserClient(req, res) {
    let stats;
    try {
        stats = fs.statSync(MCP_BROWSER_CLIENT_PATH);
        if (!stats.isFile()) throw new Error('not a file');
    } catch (err) {
        appendLog('mcp_client_missing', { error: err?.message || String(err) });
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
    }

    appendLog('mcp_client_request', { method: req.method });
    res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Content-Length': stats.size,
        'Cache-Control': 'public, max-age=300'
    });

    if (req.method === 'HEAD') {
        res.end();
        return;
    }

    const stream = fs.createReadStream(MCP_BROWSER_CLIENT_PATH);
    stream.on('error', err => {
        appendLog('mcp_client_stream_error', { error: err?.message || String(err) });
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end('Internal Server Error');
    });
    stream.pipe(res);
}

function sendJsonResponse(res, statusCode, body, extraHeaders = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...extraHeaders
    });
    res.end(data);
}

function redirectLoopbackAlias(req, res) {
    const location = resolveLoopbackAuthorityRedirect(req, {
        expectedAuthority: publicAuthority,
        scheme: req.socket?.encrypted ? 'https' : 'http',
    });
    if (!location) return false;

    appendLog('loopback_authority_redirect', {
        authority: req.headers.host,
        location,
    });
    res.writeHead(307, {
        Location: location,
        'Cache-Control': 'no-store',
        'Content-Length': '0',
    });
    res.end();
    return true;
}

function rejectUpgrade(socket, captured, fallbackStatus = 401) {
    const candidateStatus = Number(captured?.statusCode);
    const status = candidateStatus >= 300 && candidateStatus <= 599 ? candidateStatus : fallbackStatus;
    const headers = { ...(captured?.getHeaders?.() || {}), connection: 'close' };
    try { socket.end(buildStatusLine(status, http.STATUS_CODES[status] || 'Request Rejected', headers)); } catch (_) {
        try { socket.destroy(); } catch (_) {}
    }
}

function decodePathSegment(value) {
    try {
        return decodeURIComponent(value || '');
    } catch (_) {
        return '';
    }
}

function extractAgentName(pathname, routes = {}) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (!parts.length) return null;
    const agentName = decodePathSegment(parts[0]).trim();
    if (!agentName || !routes?.[agentName]) return null;
    return agentName;
}

function isRouterOwnedPath(pathname) {
    return pathname === '/agent-card'
        || pathname === '/agent-card/'
        || pathname === '/mcp'
        || pathname === '/mcp/'
        || pathname.startsWith('/auth/')
        || pathname.startsWith('/api/agents/')
        || pathname === '/api/marketplace'
        || pathname.startsWith('/api/marketplace/')
        || pathname.startsWith('/api/router/')
        || pathname === '/api/agent-port-locator'
        // Internal, non-policy-routable router-owned routes (DS014).
        || pathname === '/policy/command'
        || pathname === '/metrics'
        || pathname === '/health/internal'
        || pathname === '/admin'
        || pathname.startsWith('/admin/')
        || pathname === '/__agent'
        || pathname.startsWith('/__agent/')
        || isRouteMount(pathname, '/webchat')
        || isRouteMount(pathname, '/dashboard')
        || isRouteMount(pathname, '/status')
        || pathname === '/upload'
        || isRouteMount(pathname, '/blobs')
        || isRouteMount(pathname, '/web-libs')
        || pathname === '/workspace-files'
        || pathname.startsWith('/workspace-files/');
}

function buildAgentProxyPath(agentName, parsedUrl) {
    const pathname = parsedUrl?.pathname || '/';
    const prefix = `/${encodeURIComponent(agentName)}`;
    let upstreamPath = pathname;
    if (pathname === `/${agentName}` || pathname === prefix) {
        upstreamPath = '/';
    } else if (pathname.startsWith(`/${agentName}/`)) {
        upstreamPath = pathname.slice(agentName.length + 1) || '/';
    } else if (pathname.startsWith(`${prefix}/`)) {
        upstreamPath = pathname.slice(prefix.length) || '/';
    }
    return `${upstreamPath || '/'}${parsedUrl?.search || ''}`;
}

function hasDelegatedAgentAssertion(req) {
    // Agent-to-agent calls carry an Agent Assertion as `Authorization: Bearer`.
    // Browser callers use session cookies, so a bearer at /<agent>/mcp signals an
    // a2a attempt; the MCP proxy verifies the assertion before anything runs.
    const raw = req?.headers?.authorization ?? req?.headers?.Authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.toLowerCase().startsWith('bearer ');
}

function pathOnly(pathWithQuery = '') {
    const value = String(pathWithQuery || '');
    const index = value.indexOf('?');
    return index >= 0 ? value.slice(0, index) : value;
}

function isAgentTaskStatusProxyPath(agentProxyPath) {
    const value = pathOnly(agentProxyPath);
    return value === '/task' || value === '/getTaskStatus';
}

function getStaticRouteName(routes = {}) {
    const staticAgent = staticSrv.getStaticAgentName();
    if (!staticAgent) return null;
    const shortName = staticAgent.includes('/') ? staticAgent.split('/').pop() : staticAgent;
    if (routes[staticAgent]) return staticAgent;
    if (routes[shortName]) return shortName;
    for (const [routeName, route] of Object.entries(routes || {})) {
        const routeRef = route?.repo && route?.agent ? `${route.repo}/${route.agent}` : '';
        if (routeRef === staticAgent) return routeName;
    }
    return null;
}

async function requestAgentCard(_route, agentName, identityHeaders = {}) {
    let lease;
    let channel;
    let relayAgent;
    try {
        lease = routingRuntime.acquire({ listenerClass: 'public', authority: publicAuthority });
        const plan = finalizePlanAfterAdmission(routingRuntime.resolvePrimary({
            lease,
            routeKey: agentName,
            method: 'GET',
            externalPath: `/${encodeURIComponent(agentName)}/agent-card`,
            targetPath: '/agent-card',
            authority: publicAuthority,
        }));
        if (!plan) throw new Error('primary service unavailable');
        const applicationHeaders = sanitizeRequestHeaders(identityHeaders, plan, {});
        applicationHeaders.accept = 'application/json';
        channel = await routingRuntime.relayManager.checkout({ plan, lease, authorized: true });
        const relayStream = await channel.openRequest({
            plan,
            bodyMode: 'none-v1',
            bodyHash: sha256RawBodyHash(Buffer.alloc(0)),
            headers: applicationHeaders,
        });
        const connection = new RelayDuplex(relayStream);
        relayAgent = createRelayHttpAgent(connection);
        return await new Promise((resolve) => {
        const upstream = http.request({
            path: '/agent-card',
            method: 'GET',
            headers: applicationHeaders,
            timeout: 5000,
            agent: relayAgent,
        }, upstreamRes => {
            const chunks = [];
            upstreamRes.on('data', chunk => chunks.push(chunk));
            upstreamRes.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const statusCode = upstreamRes.statusCode || 0;
                if (statusCode < 200 || statusCode >= 300) {
                    resolve({
                        ok: false,
                        error: {
                            name: agentName,
                            statusCode,
                            error: body || `HTTP ${statusCode}`
                        }
                    });
                    return;
                }
                try {
                    resolve({
                        ok: true,
                        agent: {
                            name: agentName,
                            statusCode,
                            payload: body ? JSON.parse(body) : null
                        }
                    });
                } catch (_) {
                    resolve({
                        ok: true,
                        agent: {
                            name: agentName,
                            statusCode,
                            body
                        }
                    });
                }
            });
        });
        upstream.on('timeout', () => {
            upstream.destroy(new Error('agent-card request timed out'));
        });
        upstream.on('error', err => {
            resolve({
                ok: false,
                error: {
                    name: agentName,
                    error: err?.message || String(err)
                }
            });
        });
        upstream.end();
    });
    } catch (error) {
        lease?.release();
        return { ok: false, error: { name: agentName, error: error?.message || String(error) } };
    } finally {
        relayAgent?.destroy();
        channel?.close();
        lease?.release();
    }
}

async function handleRoutedAggregateAgentCard(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET') {
        sendJsonResponse(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
    }
    const apiRoutes = activeRoutes();
    const candidates = Object.entries(apiRoutes || {})
        .filter(([, route]) => route && route.enabled && route.relay && route.primaryService);
    const results = await Promise.all(candidates.map(([agentName, route]) =>
        requestAgentCard(route, agentName, req.headers)
            .catch(error => ({
                ok: false,
                error: {
                    name: agentName,
                    error: error?.message || String(error)
                }
            }))
    ));
    const agents = [];
    const errors = [];
    for (const result of results) {
        if (result.ok) {
            agents.push(result.agent);
        } else {
            errors.push(result.error);
        }
    }
    sendJsonResponse(res, 200, { agents, errors });
}

/**
 * Main request processor
 */
async function processRequest(req, res) {
    if (redirectLoopbackAlias(req, res)) return;

    let classification;
    try {
        classification = classifyRequestAuthority(req, {
            expectedAuthority: publicAuthority,
            scheme: req.socket?.encrypted ? 'https' : 'http',
        });
    } catch (error) {
        sendJsonResponse(res, error?.status || 400, { error: error?.status === 404 ? 'route_not_found' : 'invalid_authority' });
        return;
    }
    req.url = classification.requestTarget;
    req.headers.host = classification.authority;
    const parsedUrl = new URL(req.url, `http://${classification.authority}`);
    const pathname = parsedUrl.pathname || '/';
    const routedAggregateAgentCard = pathname === '/agent-card' || pathname === '/agent-card/';
    const apiRoutes = activeRoutes();
    let generationLease = null;
    let conventionPlan = null;
    const conventionPrefix = `/${AGENT_PORT_CONVENTION_ROUTE_KEY}`;
    if (String(req.url || '').split('?', 1)[0] === conventionPrefix
        || String(req.url || '').startsWith(`${conventionPrefix}/`)) {
        try {
            generationLease = routingRuntime.acquire({ listenerClass: 'public', authority: req.headers.host });
            conventionPlan = routingRuntime.resolveConvention({
                lease: generationLease,
                requestTarget: req.url || '/',
                method: req.method || 'GET',
                authority: req.headers.host,
                listenerClass: 'public',
                scheme: req.socket?.encrypted ? 'https' : 'http',
                transport: 'http',
            });
        } catch (error) {
            generationLease?.release();
            const status = error?.name === 'AgentPortSelectorError' ? error.status || 400
                : error?.message?.includes('owner is not active') ? 404 : 503;
            sendJsonResponse(res, status, { error: status === 400 ? 'invalid_agent_port_selector' : status === 404 ? 'agent_not_found' : 'routing_unavailable' });
            return;
        }
    }
    const agentName = isRouterOwnedPath(pathname) || conventionPlan ? null : extractAgentName(pathname, apiRoutes);
    const route = agentName ? apiRoutes[agentName] : null;
    const agentProxyPath = agentName ? buildAgentProxyPath(agentName, parsedUrl) : '';
    let primaryLease = null;
    let primaryPlan = null;
    if (agentName) {
        try {
            primaryLease = routingRuntime.acquire({ listenerClass: 'public', authority: req.headers.host });
            primaryPlan = routingRuntime.resolvePrimary({
                lease: primaryLease,
                routeKey: agentName,
                method: req.method || 'GET',
                externalPath: pathname,
                targetPath: pathOnly(agentProxyPath),
                query: parsedUrl.search ? parsedUrl.search.slice(1) : '',
                authority: req.headers.host,
                scheme: req.socket?.encrypted ? 'https' : 'http',
            });
        } catch (_) {
            primaryLease?.release();
            primaryLease = null;
        }
    }
    const isAgentMcpRoute = Boolean(agentName && (agentProxyPath === '/mcp' || agentProxyPath.startsWith('/mcp?') || agentProxyPath.startsWith('/mcp/')));
    // Path-exact delegated agent OpenAI bypass: ONLY POST /<routeKey>/v1/chat/completions
    // with an Agent Assertion. No other agent-prefixed HTTP path uses this bypass.
    const isDelegatedAgentOpenAi = isDelegatedAgentOpenAiCall({
        agentName,
        method: req.method,
        agentProxyPath,
        req,
    });
    let serviceDefinition = null;
    let serviceLease = null;
    let servicePlan = null;
    if (!agentName && !conventionPlan && !isRouterOwnedPath(pathname)) {
        try {
            serviceLease = routingRuntime.acquire({ listenerClass: 'public', authority: req.headers.host });
            serviceDefinition = resolveHttpServiceRoute(pathname, {
                routes: serviceLease.generation.routes,
            });
            if (!serviceDefinition) {
                serviceLease.release();
                serviceLease = null;
            }
        } catch (_) {
            serviceLease?.release();
            serviceLease = null;
        }
    }
    if (serviceDefinition && serviceLease) {
        try {
            const target = buildServiceAgentPath(pathname, parsedUrl.search, serviceDefinition.externalPrefix, serviceDefinition.internalPrefix);
            servicePlan = routingRuntime.resolveHttpService({
                lease: serviceLease,
                routeKey: serviceDefinition.routeKey,
                method: req.method || 'GET',
                externalPath: pathname,
                targetPath: pathOnly(target),
                query: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
                forwardedPrefix: serviceDefinition.externalPrefix,
                declaredAccess: serviceDefinition.access,
                declaredGuestScope: serviceDefinition.guestScope,
                authority: req.headers.host,
                scheme: req.socket?.encrypted ? 'https' : 'http',
            });
            if (!servicePlan) {
                serviceLease.release();
                serviceLease = null;
            }
        } catch (_) {
            serviceLease?.release();
            serviceLease = null;
        }
    }
    const releaseSelectionLeases = () => {
        generationLease?.release();
        primaryLease?.release();
        serviceLease?.release();
    };
    const policyGatedRouteKey = agentName && !isAgentMcpRoute
        ? agentName
        : serviceDefinition?.routeKey || '';
    const unavailableServiceAccess = serviceDefinition && !servicePlan ? {
        access: serviceDefinition.access,
        routeKey: serviceDefinition.routeKey,
        guestScope: serviceDefinition.guestScope,
        source: 'generation-http-service',
    } : null;
    const httpRouteAccess = conventionPlan?.access || primaryPlan?.access || servicePlan?.access || unavailableServiceAccess || ((agentName && !isAgentMcpRoute)
        ? policy.httpRouteAccessPolicy.evaluate({
            pathname,
            method: req.method || 'GET',
            routeKey: policyGatedRouteKey,
        })
        : null);
    const isDelegatedAgentTaskStatusRoute = Boolean(
        agentName
        && !isAgentMcpRoute
        && isAgentTaskStatusProxyPath(agentProxyPath)
        && hasDelegatedAgentAssertion(req)
    );
    let agentProxyExtraHeaders = {};
    appendLog('http_request', { method: req.method, path: pathname });

    // Health check endpoint (no auth required)
    if (pathname === '/health') {
        const memUsage = process.memoryUsage();
        const healthData = {
            status: 'healthy',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            pid: process.pid,
            memory: {
                rss: memUsage.rss,
                heapUsed: memUsage.heapUsed,
                heapTotal: memUsage.heapTotal,
                rssMB: Math.round(memUsage.rss / 1024 / 1024),
                heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024)
            },
            activeSessions: {
                webchat: globalState.webchat.sessions.size,
                dashboard: globalState.dashboard.sessions.size,
                status: globalState.status.sessions.size,
                agent: agentSessionStore.size
            }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(healthData, null, 2));
        return;
    }

    // MCP Browser Client
    if (pathname === '/MCPBrowserClient.js') {
        serveMcpBrowserClient(req, res);
        return;
    }

    if (isRouteMount(pathname, '/web-libs')) {
        return staticSrv.serveWebLibRequest(req, res);
    }

    // DS014: any `__agent` segment is a router-owned agent control-plane path
    // (e.g. the share authorizer). The router reaches those itself over a direct
    // loopback call carrying a minted Router Request — the PUBLIC listener never
    // serves them. Refuse here, before any auth, http-service route, or
    // passthrough handling can forward one to an agent. Generic 404 so the reply
    // does not confirm the internal route exists.
    if (hasInternalAgentSegment(pathname)) {
        releaseSelectionLeases();
        sendJsonResponse(res, 404, { error: 'not_found' });
        return;
    }

    // Authentication routes
    if (pathname.startsWith('/auth/')) {
        const handled = await handleAuthRoutes(req, res, parsedUrl);
        if (handled) return;
    }

    if (pathname.startsWith('/api/agents/')) {
        const handled = await handleUserAdminRoutes(req, res, parsedUrl);
        if (handled) return;
    }

    if (pathname === '/api/marketplace' || pathname.startsWith('/api/marketplace/')) {
        const handled = await handleMarketplaceRoutes(req, res, parsedUrl);
        if (handled) return;
    }

    if (pathname === '/api/agent-port-locator') {
        const routeKey = String(parsedUrl.searchParams.get('agent') || '').trim();
        const selectedPort = Number(parsedUrl.searchParams.get('port'));
        const policyPath = `/${AGENT_PORT_CONVENTION_ROUTE_KEY}/${encodeURIComponent(routeKey)}/${selectedPort}/`;
        let locatorLease;
        try {
            const authResult = await ensureHttpRouteAccess(
                req,
                res,
                parsedUrl,
                getAgentPortLocatorAccess(routeKey),
            );
            if (!authResult.ok) return;
            if (!req.user) throw new Error('locator authentication did not produce a user');
            locatorLease = routingRuntime.acquire({ listenerClass: 'public', authority: req.headers.host });
            const plan = routingRuntime.resolveConvention({
                lease: locatorLease,
                requestTarget: policyPath,
                method: 'GET',
                authority: req.headers.host,
                listenerClass: 'public',
                scheme: req.socket?.encrypted ? 'https' : 'http',
            });
            if (!plan || plan.access.access === 'deny') throw new Error('locator policy denied');
            const locator = locateAgentPort({ generation: locatorLease.generation, routeKey, port: selectedPort, authenticated: true });
            sendJsonResponse(res, 200, { url: locator.url, generationDigest: locator.generationDigest }, { 'Cache-Control': 'no-store' });
        } catch (_) {
            sendJsonResponse(res, 503, { error: 'locator_unavailable' }, { 'Cache-Control': 'no-store' });
        } finally {
            locatorLease?.release();
        }
        return;
    }

    // Single administrative endpoint for router access-control policy (DS014).
    // Authenticated + never policy-routable; handles its own authorization.
    if (pathname === '/policy/command') {
        const handled = await policy.commandInvoker.handle(req, res);
        if (handled) return;
    }

    // Router-owned, agent-authenticated discovery of enabled OpenAI-style chat
    // backends for an OpenAI-compatible gateway consumer. Dispatched here
    // (before the session-auth gate) because it authenticates an HTTP Agent
    // Assertion itself, not a browser session: a session is neither sufficient
    // nor required.
    if (pathname === OPENAI_AGENT_DISCOVERY_PATH) {
        const handled = handleOpenAiAgentDiscoveryRoute(req, res, parsedUrl);
        if (handled) return;
    }

    if (routedAggregateAgentCard) {
        // Public aggregate route
    } else if (pathname === '/mcp' || pathname === '/mcp/') {
        const authResult = await ensureAuthenticated(req, res, parsedUrl);
        if (!authResult.ok) return;
    } else if (agentName && isAgentMcpRoute && hasDelegatedAgentAssertion(req)) {
        // Agent-to-agent MCP: the MCP proxy verifies the Agent Assertion.
    } else if (isDelegatedAgentTaskStatusRoute) {
        // Agent-to-agent async task polling: verify the source assertion, then
        // replace it with a target-scoped Router Request for AgentServer.
        const statusPath = pathOnly(agentProxyPath);
        const taskId = parsedUrl.searchParams.get('taskId');
        try {
            req.delegatedAgentVerified = verifyDelegatedAgentTaskStatusCall({
                req,
                agentName,
                taskId,
                path: statusPath,
            });
            const ctx = buildInvocationContextForProviderCall({
                req,
                agentName,
                toolName: '__task_status__',
                toolArgs: { taskId },
                method: 'GET',
                path: statusPath,
            });
            if (ctx?.token) {
                agentProxyExtraHeaders = { authorization: `Bearer ${ctx.token}` };
            }
        } catch (error) {
            releaseSelectionLeases();
            sendJsonResponse(res, 401, {
                error: 'delegated_task_status_rejected',
                reason: error?.message || 'delegated task status verification failed',
            });
            return;
        }
    } else if (agentName && isAgentMcpRoute) {
        // Browser MCP keeps the existing surface auth (static fallback included).
        const authResult = await ensureAuthenticated(req, res, parsedUrl);
        if (!authResult.ok) {
            releaseSelectionLeases();
            return;
        }
    } else if (isDelegatedAgentOpenAi) {
        // Agent-to-agent OpenAI call: the delegation handler verifies the HTTP
        // Agent Assertion against the buffered body and mints a router-request
        // token. Skip browser/session auth for this path-exact bypass only.
    } else if (httpRouteAccess) {
        // One executor for transparent agent routes and declared HTTP services.
        const accessResult = await ensureHttpRouteAccess(req, res, parsedUrl, httpRouteAccess);
        if (!accessResult.ok) {
            if (conventionPlan) {
                recordProxyOutcome({
                    plan: conventionPlan,
                    outcome: 'denied',
                    status: res.statusCode || 403,
                    leaseOutcome: 'released',
                    relayOutcome: 'not_started',
                    upstreamOutcome: 'not_started',
                    sink: event => appendLog(event.event, event),
                });
            }
            releaseSelectionLeases();
            return;
        }
    } else {
        const authResult = await ensureAuthenticated(req, res, parsedUrl);
        if (!authResult.ok) {
            releaseSelectionLeases();
            return;
        }
    }

    if (conventionPlan) {
        return executeHttpPlan({
            req,
            res,
            plan: conventionPlan,
            lease: generationLease,
            relayManager: routingRuntime.relayManager,
            authorized: true,
            trustedHeaders: req.user?.id ? { userId: req.user.id } : {},
            auditSink: event => appendLog(event.event, event),
        });
    }


    if (primaryPlan && !isAgentMcpRoute && !isDelegatedAgentOpenAi) {
        return executeHttpPlan({
            req,
            res,
            plan: primaryPlan,
            lease: primaryLease,
            relayManager: routingRuntime.relayManager,
            authorized: true,
            trustedHeaders: {
                ...(req.user?.id ? { userId: req.user.id } : {}),
                applicationHeaders: agentProxyExtraHeaders,
            },
            auditSink: event => appendLog(event.event, event),
        });
    }

    if (servicePlan) {
        return executeHttpPlan({
            req,
            res,
            plan: servicePlan,
            lease: serviceLease,
            relayManager: routingRuntime.relayManager,
            authorized: true,
            trustedHeadersFactory: ({ bodyHash }) => {
                const identityHeaders = buildHttpServiceAuthInfoHeader(req, parsedUrl, serviceDefinition, {
                    bodyHash,
                    servicePath: servicePlan.unmatchedSuffix,
                });
                return {
                    ...(req.user?.id ? { userId: req.user.id } : {}),
                    ...(identityHeaders['x-ploinky-auth-info']
                        ? { authInfo: identityHeaders['x-ploinky-auth-info'] }
                        : {}),
                };
            },
            auditSink: event => appendLog(event.event, event),
        });
    }

    if (serviceDefinition) {
        sendJsonResponse(res, 503, { error: 'service_runtime_unavailable' });
        return;
    }

    // Router-owned: mint a router-signed user identity key. Reached only after
    // the auth gate above populated req.user (the handler enforces its own 401
    // for any unauthenticated caller and derives admin status internally).
    if (pathname === USER_IDENTITY_KEY_PATH) {
        const handled = await handleUserIdentityKeyRoute(req, res, parsedUrl);
        if (handled) return;
    }

    // Route to appropriate handler
    if (isRouteMount(pathname, '/webchat')) {
        return handleWebChat(req, res, config.webchat, globalState.webchat);
    } else if (isRouteMount(pathname, '/dashboard')) {
        return handleDashboard(req, res, config.dashboard, globalState.dashboard);
    } else if (isRouteMount(pathname, '/status')) {
        return handleStatus(req, res, config.status, globalState.status);
    } else if (pathname === '/upload') {
        return handleWorkspaceUpload(req, res);
    } else if (isRouteMount(pathname, '/blobs')) {
        return handleBlobs(req, res);
    } else if (staticSrv.serveWorkspaceFileRequest(req, res)) {
        return;
    } else if (routedAggregateAgentCard) {
        return handleRoutedAggregateAgentCard(req, res);
    } else if (agentName) {
        if (!route) {
            sendJsonResponse(res, 404, { error: 'agent_not_found', agent: agentName });
            return;
        }
        if (!primaryPlan) {
            primaryLease?.release();
            sendJsonResponse(res, 503, { error: 'agent_runtime_unavailable', agent: agentName });
            return;
        }
        if (isAgentMcpRoute) {
            primaryLease.release();
            return handleAgentMcpRequest(req, res, route, agentName);
        }
        if (isDelegatedAgentOpenAi) {
            return handleDelegatedAgentOpenAiCall(req, res, route, agentName, agentProxyPath, {
                plan: primaryPlan,
                lease: primaryLease,
                relayManager: routingRuntime.relayManager,
                auditSink: event => appendLog(event.event, event),
            });
        }
        // `__agent` control-plane paths are already refused at the top of the
        // dispatch (before http-service/passthrough handling), so anything that
        // reaches here is a normal agent request.
        if (await staticSrv.serveAgentStaticRequest(req, res)) {
            return;
        }
        primaryLease?.release();
        sendJsonResponse(res, 503, { error: 'agent_runtime_unavailable', agent: agentName });
        return;
    } else if (pathname === '/mcp' || pathname === '/mcp/') {
        return handleRouterMcp(req, res);
    } else {
        if (pathname === '/' || pathname === '/index.html') {
            const staticRouteName = getStaticRouteName(apiRoutes);
            if (staticRouteName) {
                res.writeHead(302, {
                    Location: `/${encodeURIComponent(staticRouteName)}/index.html`,
                    'Cache-Control': 'no-store'
                });
                return res.end();
            }
        }

        res.writeHead(404);
        return res.end('Not Found');
    }
}

/**
 * Create and configure HTTP server
 */
const server = http.createServer((req, res) => {
    processRequest(req, res).catch(err => {
        appendLog('request_error', { error: err?.message || String(err) });
        if (!res.headersSent) {
            try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
            } catch (_) {
                try { res.end(); } catch (_) { }
            }
        } else {
            try { res.end(); } catch (_) { }
        }
    });
});

server.on('upgrade', async (req, socket, head) => {
    try {
        let classification;
        try {
            classification = classifyRequestAuthority(req, {
                expectedAuthority: publicAuthority,
                scheme: req.socket?.encrypted ? 'https' : 'http',
            });
        } catch (error) {
            socket.end(buildStatusLine(error?.status || 400, http.STATUS_CODES[error?.status || 400], {
                connection: 'close',
                'cache-control': 'no-store',
            }));
            return;
        }
        req.url = classification.requestTarget;
        req.headers.host = classification.authority;
        const parsedUrl = new URL(req.url, `http://${classification.authority}`);
        const conventionPrefix = `/${AGENT_PORT_CONVENTION_ROUTE_KEY}`;
        if (String(req.url || '').split('?', 1)[0] === conventionPrefix
            || String(req.url || '').startsWith(`${conventionPrefix}/`)) {
            let lease;
            try {
                lease = routingRuntime.acquire({ listenerClass: 'public', authority: req.headers.host });
                const plan = routingRuntime.resolveConvention({
                    lease,
                    requestTarget: req.url || '/',
                    method: 'GET',
                    authority: req.headers.host,
                    listenerClass: 'public',
                    scheme: req.socket?.encrypted ? 'https' : 'http',
                    transport: 'websocket',
                });
                const captured = createCapturingRes();
                const access = await ensureHttpRouteAccess(req, captured, parsedUrl, plan.access);
                if (!access.ok) {
                    recordProxyOutcome({
                        plan,
                        outcome: 'denied',
                        status: captured.statusCode || 403,
                        leaseOutcome: 'released',
                        relayOutcome: 'not_started',
                        upstreamOutcome: 'not_started',
                        sink: event => appendLog(event.event, event),
                    });
                    lease.release();
                    rejectUpgrade(socket, captured);
                    return;
                }
                await executeWebSocketPlan({
                    req,
                    socket,
                    head,
                    plan,
                    lease,
                    relayManager: routingRuntime.relayManager,
                    authorized: true,
                    trustedHeaders: req.user?.id ? { userId: req.user.id } : {},
                    auditSink: event => appendLog(event.event, event),
                });
                return;
            } catch (_) {
                lease?.release();
                socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
                return;
            }
        }
        let serviceLease;
        let definition;
        try {
            serviceLease = routingRuntime.acquire({ listenerClass: 'public', authority: req.headers.host });
            definition = resolveHttpServiceRoute(parsedUrl.pathname, {
                routes: serviceLease.generation.routes,
            });
            if (!definition) {
                serviceLease.release();
                serviceLease = null;
            }
        } catch (_) {
            serviceLease?.release();
            serviceLease = null;
        }
        if (definition && serviceLease) {
            try {
                const target = buildServiceAgentPath(parsedUrl.pathname, parsedUrl.search, definition.externalPrefix, definition.internalPrefix);
                const plan = routingRuntime.resolveHttpService({
                    lease: serviceLease,
                    routeKey: definition.routeKey,
                    method: 'GET',
                    externalPath: parsedUrl.pathname,
                    targetPath: pathOnly(target),
                    query: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
                    forwardedPrefix: definition.externalPrefix,
                    declaredAccess: definition.access,
                    declaredGuestScope: definition.guestScope,
                    authority: req.headers.host,
                    scheme: req.socket?.encrypted ? 'https' : 'http',
                    transport: 'websocket',
                });
                if (!plan) throw new Error('service runtime unavailable');
                const captured = createCapturingRes();
                const access = await ensureHttpRouteAccess(req, captured, parsedUrl, plan.access);
                if (!access.ok) {
                    serviceLease.release();
                    rejectUpgrade(socket, captured);
                    return;
                }
                await executeWebSocketPlan({
                    req, socket, head, plan, lease: serviceLease,
                    relayManager: routingRuntime.relayManager,
                    authorized: true,
                    trustedHeaders: (() => {
                        const identityHeaders = buildHttpServiceAuthInfoHeader(req, parsedUrl, definition, {
                            bodyHash: sha256RawBodyHash(Buffer.alloc(0)),
                            servicePath: target,
                        });
                        return {
                            ...(req.user?.id ? { userId: req.user.id } : {}),
                            ...(identityHeaders['x-ploinky-auth-info']
                                ? { authInfo: identityHeaders['x-ploinky-auth-info'] }
                                : {}),
                        };
                    })(),
                    auditSink: event => appendLog(event.event, event),
                });
                return;
            } catch (_) {
                serviceLease?.release();
                socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
                return;
            }
        }
        const routes = activeRoutes();
        const agentName = isRouterOwnedPath(parsedUrl.pathname) ? null : extractAgentName(parsedUrl.pathname, routes);
        if (agentName) {
            let lease;
            try {
                lease = routingRuntime.acquire({ listenerClass: 'public', authority: req.headers.host });
                const target = buildAgentProxyPath(agentName, parsedUrl);
                const plan = routingRuntime.resolvePrimary({
                    lease,
                    routeKey: agentName,
                    method: 'GET',
                    externalPath: parsedUrl.pathname,
                    targetPath: pathOnly(target),
                    query: parsedUrl.search.slice(1),
                    authority: req.headers.host,
                    scheme: req.socket?.encrypted ? 'https' : 'http',
                    transport: 'websocket',
                });
                if (!plan) throw new Error('agent runtime unavailable');
                const captured = createCapturingRes();
                const access = await ensureHttpRouteAccess(req, captured, parsedUrl, plan.access);
                if (!access.ok) {
                    lease.release();
                    rejectUpgrade(socket, captured);
                    return;
                }
                await executeWebSocketPlan({
                    req,
                    socket,
                    head,
                    plan,
                    lease,
                    relayManager: routingRuntime.relayManager,
                    authorized: true,
                    trustedHeaders: req.user?.id ? { userId: req.user.id } : {},
                    auditSink: event => appendLog(event.event, event),
                });
                return;
            } catch (_) {
                lease?.release();
                socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
                return;
            }
        }
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy();
    } catch (_) {
        try { socket.destroy(); } catch (_) {}
    }
});

// Setup process lifecycle management
const lifecycle = setupProcessLifecycle(server, globalState, agentSessionStore);
server.once('close', () => {
    privateServer?.close();
    routingRuntime.close();
    clearRoutingRuntime(routingRuntime);
});

// Server error handlers
server.on('error', (error) => {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
    console.error('[FATAL] Server error:', error);
    appendLog('server_error', { error: error.message, code: error.code, port });

    if (error.code === 'EADDRINUSE') {
        console.error(`[FATAL] Port ${port} is already in use`);
        process.exit(2);
    } else if (error.code === 'EACCES') {
        console.error(`[FATAL] Permission denied for port ${port}`);
        process.exit(2);
    } else {
        lifecycle.gracefulShutdown('server_error', 1);
    }
});

server.on('clientError', (error, socket) => {
    appendLog('client_error', {
        error: error.message,
        code: error.code,
        remoteAddress: socket.remoteAddress
    });

    if (!socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

// Start server
const port = routerPort;
server.listen(port, publicBind, () => {
    console.log(`[RoutingServer] Ploinky server running on http://${publicAuthority}`);
    console.log('  Dashboard:       /dashboard');
    console.log('  WebChat:         /webchat');
    console.log('  Status:          /status');
    console.log('  Health:          /health');
    console.log('  Agent routes:    /<agent>/{mcp,task,agent-card,v1/models,v1/chat/completions}');
    console.log(`  Agent ports:     /${AGENT_PORT_CONVENTION_ROUTE_KEY}/<agent>/<port>/`);
    console.log('  Aggregate cards: /agent-card');
    appendLog('server_start', { port });
    logBootEvent('server_listening', { port });

    const proofRoute = Object.values(activeRoutes()).find(candidate => candidate?.relay);
    if (proofRoute) {
        const relay = proofRoute.relay;
        const privateBind = String(process.env.PLOINKY_PRIVATE_BIND || '127.0.0.1').trim();
        createPrivateListener({
            host: privateBind,
            handler: createPrivateRouteHandler({
                runtime: routingRuntime,
                assertionService: machineCallAssertions,
                auditSink: event => appendLog(event.event, event),
            }),
            proveBinding: proof => proveContainerLoopbackBinding({
                ...proof,
                runtime: relay.runtime,
                containerId: relay.containerId,
                hostAlias: relay.runtime === 'podman' ? 'host.containers.internal' : 'host.docker.internal',
            }),
        }).then(listener => {
            privateServer = listener;
            appendLog('private_listener_enabled', { bind: privateBind, port: 8081 });
        }).catch(error => {
            appendLog('private_listener_disabled', { error: error?.message || String(error) });
        });
    } else {
        appendLog('private_listener_disabled', { error: 'no trusted container runtime proof route' });
    }

    // Bootstrap MCP tool policy from each enabled agent's mcp-config tags
    // (persisted admin policy always wins). Without this, fail-closed
    // enforcement would deny every tool call because no entries exist yet.
    try {
        const { added } = policy.mcpToolPolicy.bootstrap(activeRoutes());
        appendLog('mcp_policy_bootstrap', { added });
    } catch (err) {
        appendLog('mcp_policy_bootstrap_error', { error: err?.message || String(err) });
    }

    appendLog('http_route_access_providers_bound', {});

    // Log initial memory usage
    logMemoryUsage();

    // Periodic memory usage logging (every 5 minutes)
    const MEMORY_LOG_INTERVAL = 5 * 60 * 1000;
    const memoryMonitor = setInterval(() => {
        if (!lifecycle.isShuttingDown()) {
            logMemoryUsage();
        }
    }, MEMORY_LOG_INTERVAL);

    // CRITICAL: Process count monitoring to prevent spawn leaks
    const PROCESS_MONITOR_INTERVAL = 60 * 1000; // 1 minute
    const MAX_SAFE_NODE_PROCESSES = 15;
    const processMonitor = setInterval(() => {
        if (lifecycle.isShuttingDown()) return;

        try {
            const { execSync } = require('child_process');
            const output = execSync('ps aux | grep -E "node|startFlow" | grep -v grep | wc -l', {
                encoding: 'utf8',
                timeout: 5000
            }).trim();
            const nodeProcessCount = parseInt(output, 10);

            if (nodeProcessCount > MAX_SAFE_NODE_PROCESSES) {
                const warning = {
                    level: 'warning',
                    type: 'process_count_alert',
                    nodeProcesses: nodeProcessCount,
                    maxSafe: MAX_SAFE_NODE_PROCESSES,
                    message: 'High number of node processes detected - possible process spawn leak'
                };
                appendLog('process_count_alert', warning);
                console.warn(`[ALERT] ${nodeProcessCount} node processes running (max safe: ${MAX_SAFE_NODE_PROCESSES})`);

                // Log active sessions for debugging
                let totalTabs = globalState.webchat?.runtimes instanceof Map
                    ? globalState.webchat.runtimes.size
                    : 0;
                for (const state of Object.values(globalState)) {
                    if (state === globalState.webchat) continue;
                    if (state.sessions instanceof Map) {
                        for (const session of state.sessions.values()) {
                            if (session.tabs instanceof Map) {
                                totalTabs += session.tabs.size;
                            }
                        }
                    }
                }
                console.warn(`[DEBUG] Active tabs: ${totalTabs}, Sessions: ${globalState.webchat?.sessions.size || 0}`);
            }

            // Log normal process count periodically for trending
            if (nodeProcessCount > 5) {
                appendLog('process_count', { count: nodeProcessCount });
            }
        } catch (err) {
            // Silently fail - don't crash if ps command fails
        }
    }, PROCESS_MONITOR_INTERVAL);

    // Clean up intervals on shutdown
    process.on('beforeExit', () => {
        clearInterval(memoryMonitor);
        clearInterval(processMonitor);
    });
});
