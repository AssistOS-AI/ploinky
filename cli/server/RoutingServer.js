import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { handleWebChat } from './handlers/webchat/index.js';
import { handleDashboard } from './handlers/dashboard.js';
import { handleStatus, streamWorkspaceMetrics } from './handlers/status.js';
import { handleBlobs, handleWorkspaceUpload } from './handlers/blobs.js';
import * as staticSrv from './static/index.js';

// Authentication and routing
import {
    ensureAuthenticated,
    ensureHttpRouteAccess,
    buildIdentityHeaders,
    handleAuthRoutes,
    handleMarketplaceRoutes,
    handleUserAdminRoutes,
    resolveRouteDefaultHttpAccess,
} from './authHandlers/index.js';
import {
    buildHttpRouteAuthInfoHeader,
    buildHttpRouteRateSourceHeader,
    buildTrustedForwardingHeaders,
    loadApiRoutes,
    handleRouterMcp,
    proxyHttpPassthrough
} from './routerHandlers.js';
import { createCapturingRes, handleAgentRootUpgrade } from './wsAgentRootProxy.js';
import {
    commitRouteGeneration,
    commitRoutePlan,
    httpAccessForEdgeRoutePlan,
    normalizeExactHost,
    resolveEdgeRoutePlan,
} from './edgeRoutePlan.js';
import {
    authorizePrivateRoutePlan,
    mintTurnCredentials,
    readPrivateRequestBody,
    sendPrivateError,
} from './privateRouter.js';
import { createListenerInterfaceClassifier } from './listenerInterfaceClassifier.js';
import {
    classifyPrivateListenerRequest,
    createPrivateListenerSet,
} from './privateListenerSet.js';
import {
    AUTHORITY_ATTESTATION_HEADER,
    createRouterAuthorityAttestationRegistry,
    handleRouterAuthorityAttestationRequest,
    recordRouterAuthorityObservation,
} from './routerAuthorityAttestationRegistry.js';
import { verifyBrowserMutationRequest } from './browserMutationSecurity.js';
import { executeHttpPlan } from './proxy/executeHttpPlan.js';
import { executeWebSocketPlan } from './proxy/executeWebSocketPlan.js';
import { RuntimeRelayManager } from './runtimeRelay/RuntimeRelayManager.js';
import { RelayRequestMinter } from './runtimeRelay/relayRequestMinter.js';
import {
    requireAdminControlRequest,
} from './adminControlSecurity.js';

// Logging
import { appendLog, logBootEvent, logMemoryUsage } from './utils/logger.js';
import { isRouteMount } from './utils/routeMounts.js';

// New modular components
import {
    agentSessionStore,
    buildInvocationContextForProviderCall,
    handleDelegatedAgentTaskCancel,
    handleAgentMcpRequest,
    readAuthenticatedAgentTask,
    verifyDelegatedAgentTaskStatusCall,
} from './mcp-proxy/index.js';
import { initializeTTYFactories, createServiceConfig } from './utils/ttyFactories.js';
import { setupProcessLifecycle } from './utils/processLifecycle.js';
import { policy } from './policy/index.js';
import { createManifestRouteProvider } from './policy/HttpRouteProviders.js';
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
import { PLOINKY_DIR } from '../utils/config.js';
import { deriveAgentRequestSecret } from '../utils/security/masterKey.js';
import { createCloudflaredRouterIntegration } from '../../ploinky-box/cloudflared/index.mjs';
import { requestAgentCard } from './agentCardFanout.js';
import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_BROWSER_CLIENT_PATH = path.resolve(__dirname, '../../Agent/client/MCPBrowserClient.js');
const port = 8080;
const privatePort = 8081;
const runtimeRelayManager = new RuntimeRelayManager({
    minter: new RelayRequestMinter({ resolveAgentSecret: deriveAgentRequestSecret }),
});
const detailedHealthSocket = process.env.PLOINKY_ROUTER_HEALTH_SOCKET
    || path.join(PLOINKY_DIR, 'run', 'router-health.sock');
const interfaceClassifier = createListenerInterfaceClassifier();
const routerAuthorityAttestationRegistry = createRouterAuthorityAttestationRegistry();

if (Object.prototype.hasOwnProperty.call(process.env, 'PORT') && process.env.PORT !== String(port)) {
    throw new Error('the managed Router requires PORT to be exactly 8080 when set; --port selects only the outer loopback host port');
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

function decodePathSegment(value) {
    try {
        return decodeURIComponent(value || '');
    } catch (_) {
        return '';
    }
}

function extractAgentName(pathname, routes = loadApiRoutes()) {
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

function isAgentTaskCancelProxyPath(agentProxyPath) {
    return pathOnly(agentProxyPath) === '/task/cancel';
}

function getStaticRouteName(routes, snapshot) {
    const staticAgent = typeof snapshot?.routing?.static?.agent === 'string'
        ? snapshot.routing.static.agent.trim()
        : '';
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

async function handleRoutedAggregateAgentCard(req, res, routePlan) {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET') {
        sendJsonResponse(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
    }
    if (!routePlan?.lease?.commit?.()) {
        sendJsonResponse(res, 503, { error: 'edge_generation_changed' }, { 'Cache-Control': 'no-store' });
        return;
    }
    const apiRoutes = routePlan.lease.snapshot?.routing?.routes || {};
    const candidates = Object.entries(apiRoutes || {})
        .filter(([, route]) => route && !route.disabled && route.hostPort);
    const results = await Promise.all(candidates.map(([agentName, route]) =>
        requestAgentCard(route, agentName, req.headers, {
            beforeDial: () => routePlan?.lease?.commit?.() === true,
        })
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
    if (results.some((result) => result?.generationChanged)) {
        sendJsonResponse(res, 503, { error: 'edge_generation_changed' }, { 'Cache-Control': 'no-store' });
        return;
    }
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
    const exactHost = normalizeExactHost(req.headers.host);
    if (!exactHost || !String(req.url || '').startsWith('/')) {
        sendJsonResponse(res, 400, { error: 'malformed_request_target_or_host' }, { 'Cache-Control': 'no-store' });
        return;
    }
    let requestedUrl;
    try {
        requestedUrl = new URL(req.url || '/', `http://${exactHost === '::1' ? '[::1]' : exactHost}`);
    } catch (_) {
        sendJsonResponse(res, 400, { error: 'malformed_request_target_or_host' }, { 'Cache-Control': 'no-store' });
        return;
    }
    const rawInterfaceClass = interfaceClassifier.classify(req.socket?.localAddress);
    const listener = rawInterfaceClass === 'managed'
        ? 'managed'
        : 'public';
    req.ploinkyListenerClass = listener;
    const authorityObservationGeneration = (req.method || 'GET').toUpperCase() === 'GET'
        && requestedUrl.pathname === '/health'
        ? routerAuthorityAttestationRegistry.registeredGeneration(
            req.headers[AUTHORITY_ATTESTATION_HEADER],
        ) || ''
        : '';
    const routePlan = resolveEdgeRoutePlan({
        req,
        parsedUrl: requestedUrl,
        listener,
        authorityObservationGeneration,
    });
    const controlMiss = !routePlan.ok
        && routePlan.code === 'ROUTE_NOT_FOUND'
        && routePlan.hostSelection?.kind === 'control';
    recordRouterAuthorityObservation(routerAuthorityAttestationRegistry, {
        req,
        normalizedHost: exactHost,
        effectiveListener: listener,
        rawInterfaceClass,
        routePlan,
        controlMiss,
    });
    if (!routePlan.ok && !controlMiss) {
        const proofHeaders = routePlan.code === 'HOST_SELECTOR_INACTIVE' && routePlan.lease?.id
            ? { 'X-Ploinky-Edge-Generation': routePlan.lease.id }
            : {};
        sendJsonResponse(
            res,
            routePlan.status || 404,
            { error: routePlan.code || 'route_denied' },
            { 'Cache-Control': 'no-store', ...proofHeaders },
        );
        return;
    }
    const parsedUrl = routePlan.ok && routePlan.parsedUrl ? routePlan.parsedUrl : requestedUrl;
    const pathname = routePlan.ok && routePlan.canonicalPath ? routePlan.canonicalPath : requestedUrl.pathname || '/';
    const routedAggregateAgentCard = pathname === '/agent-card' || pathname === '/agent-card/';
    const apiRoutes = routePlan.snapshot?.routing?.routes || routePlan.lease?.snapshot?.routing?.routes || {};
    const agentName = routePlan.ok && routePlan.kind === 'agent-root' ? routePlan.routeKey : null;
    const route = agentName ? apiRoutes[agentName] : null;
    const agentProxyPath = agentName ? routePlan.upstreamPath : '';
    const isAgentMcpRoute = Boolean(agentName && (agentProxyPath === '/mcp' || agentProxyPath.startsWith('/mcp?') || agentProxyPath.startsWith('/mcp/')));
    // Path-exact delegated agent OpenAI bypass: ONLY POST /<routeKey>/v1/chat/completions
    // with an Agent Assertion. No other agent-prefixed HTTP path uses this bypass.
    const isDelegatedAgentOpenAi = isDelegatedAgentOpenAiCall({
        agentName,
        method: req.method,
        agentProxyPath,
        req,
    });
    const httpRouteAccess = routePlan.ok && (agentName && !isAgentMcpRoute
        || routePlan.kind === 'agent-port')
        ? httpAccessForEdgeRoutePlan(routePlan)
        : null;
    const isDelegatedAgentTaskStatusRoute = Boolean(
        agentName
        && !isAgentMcpRoute
        && isAgentTaskStatusProxyPath(agentProxyPath)
        && hasDelegatedAgentAssertion(req)
    );
    const isDelegatedAgentTaskCancelRoute = Boolean(
        agentName
        && req.method === 'POST'
        && !isAgentMcpRoute
        && isAgentTaskCancelProxyPath(agentProxyPath)
        && hasDelegatedAgentAssertion(req)
    );
    let agentProxyExtraHeaders = {};
    appendLog('http_request', { method: req.method, path: pathname });

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
    // serves them. Refuse here before passthrough handling can forward one to an
    // agent. Generic 404 so the reply
    // does not confirm the internal route exists.
    if (hasInternalAgentSegment(pathname)) {
        sendJsonResponse(res, 404, { error: 'not_found' });
        return;
    }

    // Authentication routes
    if (pathname.startsWith('/auth/')) {
        const handled = await handleAuthRoutes(req, res, parsedUrl, { routePlan });
        if (handled) return;
    }

    if (pathname.startsWith('/api/agents/')) {
        const handled = await handleUserAdminRoutes(req, res, parsedUrl, { routePlan });
        if (handled) return;
    }

    if (pathname === '/api/marketplace' || pathname.startsWith('/api/marketplace/')) {
        const handled = await handleMarketplaceRoutes(req, res, parsedUrl, { routePlan });
        if (handled) return;
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
        const authResult = await ensureAuthenticated(req, res, parsedUrl, { routePlan });
        if (!authResult.ok) return;
    } else if (agentName && isAgentMcpRoute && hasDelegatedAgentAssertion(req)) {
        // Agent-to-agent MCP: the MCP proxy verifies the Agent Assertion.
    } else if (isDelegatedAgentTaskCancelRoute) {
        await handleDelegatedAgentTaskCancel({
            req,
            res,
            route,
            agentName,
            beforeDial: () => commitRoutePlan(routePlan),
        });
        return;
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
            sendJsonResponse(res, 401, {
                error: 'delegated_task_status_rejected',
                reason: error?.message || 'delegated task status verification failed',
            });
            return;
        }
    } else if (agentName && isAgentMcpRoute) {
        // Browser MCP keeps the existing surface auth (static fallback included).
        const authResult = await ensureAuthenticated(req, res, parsedUrl, { routePlan });
        if (!authResult.ok) return;
    } else if (isDelegatedAgentOpenAi) {
        // Agent-to-agent OpenAI call: the delegation handler verifies the HTTP
        // Agent Assertion against the buffered body and mints a router-request
        // token. Skip browser/session auth for this path-exact bypass only.
    } else if (httpRouteAccess) {
        // One authorization path for transparent agent routes and agent-port relays.
        const accessResult = await ensureHttpRouteAccess(req, res, parsedUrl, httpRouteAccess, { routePlan });
        if (!accessResult.ok) return;
    } else {
        const authResult = await ensureAuthenticated(req, res, parsedUrl, { routePlan });
        if (!authResult.ok) return;
    }

    if (
        agentName
        && !isDelegatedAgentTaskStatusRoute
        && isAgentTaskStatusProxyPath(agentProxyPath)
    ) {
        if ((req.method || 'GET').toUpperCase() !== 'GET') {
            sendJsonResponse(res, 405, { error: 'method_not_allowed' }, {
                'Allow': 'GET',
                'Cache-Control': 'no-store',
            });
            return;
        }
        const taskId = parsedUrl.searchParams.get('taskId');
        if (!taskId) {
            sendJsonResponse(res, 400, { error: 'missing taskId' }, { 'Cache-Control': 'no-store' });
            return;
        }
        if (!commitRoutePlan(routePlan)) {
            sendJsonResponse(res, 503, { error: 'edge_generation_changed' }, { 'Cache-Control': 'no-store' });
            return;
        }
        try {
            const task = await readAuthenticatedAgentTask({
                req,
                route,
                agentName,
                taskId,
            });
            sendJsonResponse(res, 200, { task }, { 'Cache-Control': 'no-store' });
        } catch (error) {
            sendJsonResponse(
                res,
                Number.isInteger(error?.status) ? error.status : 502,
                { error: error?.message || 'task_status_failed' },
                { 'Cache-Control': 'no-store' },
            );
        }
        return;
    }

    // The TCP health summary is a local control surface: authenticate first and
    // require a real administrator session. Supervisors use the detailed Unix
    // socket below, so readiness never depends on an anonymous TCP exception.
    if (pathname === '/health') {
        if (!requireAdminControlRequest(req, res)) return;
        if ((req.method || 'GET').toUpperCase() !== 'GET') {
            sendJsonResponse(res, 405, { error: 'method_not_allowed' }, {
                'Allow': 'GET',
                'Cache-Control': 'no-store',
            });
            return;
        }
        sendJsonResponse(res, 200, { status: 'healthy' }, { 'Cache-Control': 'no-store' });
        return;
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)
        && (req.authMode === 'local' || req.authMode === 'sso')
        && req.authChannel !== 'cli') {
        const mutationProof = verifyBrowserMutationRequest(req, {
            routePlan,
            authContext: req.edgeAuthContext,
            sessionId: req.sessionId,
        });
        if (!mutationProof.ok) {
            sendJsonResponse(res, 403, {
                error: String(mutationProof.code || 'BROWSER_MUTATION_DENIED').toLowerCase(),
            }, { 'Cache-Control': 'no-store' });
            return;
        }
        if (!commitRouteGeneration(routePlan)) {
            sendJsonResponse(res, 503, { error: 'edge_generation_changed' }, { 'Cache-Control': 'no-store' });
            return;
        }
    }

    if (routePlan.ok && routePlan.kind === 'agent-port') {
        return executeHttpPlan({
            req,
            res,
            plan: routePlan,
            lease: routePlan.lease,
            relayManager: runtimeRelayManager,
            authorized: true,
            trustedHeadersFactory: ({ bodyHash }) => ({
                ...(req.user?.id ? { userId: req.user.id } : {}),
                authInfo: buildHttpRouteAuthInfoHeader(
                    req,
                    routePlan.parsedUrl,
                    routePlan.authDefinition,
                    {
                        bodyHash,
                        routePath: routePlan.unmatchedSuffix,
                    },
                )['x-ploinky-auth-info'],
                applicationHeaders: buildHttpRouteRateSourceHeader(req, routePlan),
            }),
            auditSink: event => appendLog(event.event, event),
        });
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
        return handleRoutedAggregateAgentCard(req, res, routePlan);
    } else if (agentName) {
        if (!route) {
            sendJsonResponse(res, 404, { error: 'agent_not_found', agent: agentName });
            return;
        }
        if (!route.hostPort) {
            sendJsonResponse(res, 404, { error: 'agent_not_found', agent: agentName });
            return;
        }
        if (isAgentMcpRoute) {
            return handleAgentMcpRequest(req, res, route, agentName, {
                beforeDial: () => commitRoutePlan(routePlan),
                routePlan,
            });
        }
        if (isDelegatedAgentOpenAi) {
            return handleDelegatedAgentOpenAiCall(req, res, route, agentName, agentProxyPath, {
                beforeDial: () => commitRoutePlan(routePlan),
            });
        }
        // `__agent` control-plane paths are already refused at the top of the
        // dispatch, so anything that reaches here is a normal agent request.
        if (await staticSrv.serveAgentStaticRequest(req, res, {
            routeKey: agentName,
            hostPath: route.hostPath,
            beforeRead: () => commitRoutePlan(routePlan),
        })) {
            return;
        }
        return proxyHttpPassthrough(req, res, route.hostPort, agentProxyPath, {
            ...buildIdentityHeaders(req),
            ...agentProxyExtraHeaders,
            ...buildTrustedForwardingHeaders(routePlan),
        }, {
            beforeDial: () => commitRoutePlan(routePlan),
        });
    } else if (pathname === '/mcp' || pathname === '/mcp/') {
        return handleRouterMcp(req, res, routePlan);
    } else {
        if (pathname === '/' || pathname === '/index.html') {
            const staticRouteName = getStaticRouteName(apiRoutes, routePlan?.lease?.snapshot);
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
function handleAsyncRequest(processor, eventName) {
    return (req, res) => {
        processor(req, res).catch(err => {
            appendLog(eventName, { error: err?.message || String(err) });
            if (!res.headersSent) {
                try {
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
                } catch (_) {
                    try { res.end(); } catch (_) { }
                }
            } else {
                try { res.end(); } catch (_) { }
            }
        });
    };
}

async function processPrivateRequest(req, res) {
    req.ploinkyListenerClass = classifyPrivateListenerRequest(req);
    const exactHost = normalizeExactHost(req.headers.host);
    if (!exactHost || !String(req.url || '').startsWith('/')) {
        sendJsonResponse(res, 400, { error: 'malformed_request_target_or_host' }, { 'Cache-Control': 'no-store' });
        return;
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(req.url || '/', `http://${exactHost === '::1' ? '[::1]' : exactHost}`);
    } catch (_) {
        sendJsonResponse(res, 400, { error: 'malformed_request_target_or_host' }, { 'Cache-Control': 'no-store' });
        return;
    }
    const routePlan = resolveEdgeRoutePlan({ req, parsedUrl, listener: 'private' });
    if (!routePlan.ok) {
        sendJsonResponse(res, routePlan.status || 404, { error: routePlan.code || 'private_route_denied' }, { 'Cache-Control': 'no-store' });
        return;
    }
    let body;
    try {
        body = await readPrivateRequestBody(req);
        authorizePrivateRoutePlan({ req, plan: routePlan, body });
    } catch (error) {
        sendPrivateError(res, error);
        return;
    }
    if (routePlan.kind === 'private-operation' && routePlan.operation === 'turn-credentials') {
        if (!commitRoutePlan(routePlan)) {
            sendJsonResponse(res, 503, { error: 'edge_generation_changed' }, { 'Cache-Control': 'no-store' });
            return;
        }
        try {
            const credentials = mintTurnCredentials({
                plan: routePlan,
                body,
                callerIdentity: req.privateAgentIdentity,
            });
            appendLog('turn_credentials_minted', {
                callerAgentId: req.privateAgentIdentity?.agentId,
                instanceId: req.privateAgentIdentity?.instanceId,
                enableGeneration: req.privateAgentIdentity?.enableGeneration,
                expiresAt: credentials.expiresAt,
                lanes: credentials.urls.length,
            });
            sendJsonResponse(res, 200, credentials, { 'Cache-Control': 'no-store' });
        } catch (error) {
            appendLog('turn_credentials_rejected', {
                callerAgentId: req.privateAgentIdentity?.agentId,
                code: error?.code || 'TURN_CREDENTIAL_MINT_FAILED',
            });
            sendPrivateError(res, error);
        }
        return;
    }
    if (routePlan.kind === 'private-operation' && routePlan.operation === 'workspace-metrics') {
        if (!commitRoutePlan(routePlan)) {
            sendJsonResponse(res, 503, { error: 'edge_generation_changed' }, { 'Cache-Control': 'no-store' });
            return;
        }
        streamWorkspaceMetrics(res, {
            isAuthorized: () => routePlan.lease?.isCurrent?.() === true,
        });
        return;
    }
    req.edgeBufferedBody = body;
    if (routePlan.kind === 'agent-port') {
        await executeHttpPlan({
            req,
            res,
            plan: routePlan,
            lease: routePlan.lease,
            relayManager: runtimeRelayManager,
            authorized: true,
            prebufferedBody: body,
            auditSink: event => appendLog(event.event, event),
        });
        return;
    }
    sendJsonResponse(res, 404, { error: 'private_route_not_found' }, { 'Cache-Control': 'no-store' });
}

function detailedHealthData() {
    const memUsage = process.memoryUsage();
    let edgePublication = null;
    try { edgePublication = cloudflaredRouterIntegration.getStatus(); } catch (_) {}
    return {
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pid: process.pid,
        memory: {
            rss: memUsage.rss,
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
        },
        activeSessions: {
            webchat: globalState.webchat.sessions.size,
            dashboard: globalState.dashboard.sessions.size,
            status: globalState.status.sessions.size,
            agent: agentSessionStore.size,
        },
        edgePublication,
    };
}

async function processDetailedHealthRequest(req, res) {
    if (await handleRouterAuthorityAttestationRequest(req, res, {
        registry: routerAuthorityAttestationRegistry,
    })) return;
    if ((req.method || 'GET').toUpperCase() !== 'GET' || req.url !== '/health') {
        sendJsonResponse(res, 404, { error: 'not_found' }, { 'Cache-Control': 'no-store' });
        return;
    }
    sendJsonResponse(res, 200, detailedHealthData(), { 'Cache-Control': 'no-store' });
}

const server = http.createServer(handleAsyncRequest(processRequest, 'request_error'));
const privateServer = http.createServer(handleAsyncRequest(processPrivateRequest, 'private_request_error'));
const healthServer = http.createServer(handleAsyncRequest(processDetailedHealthRequest, 'health_request_error'));
healthServer.requestTimeout = 3_000;
healthServer.headersTimeout = 3_000;
healthServer.keepAliveTimeout = 1_000;
healthServer.setTimeout(3_000, (socket) => socket.destroy());
const privateListenerSet = createPrivateListenerSet({
    httpServer: privateServer,
    interfaceClassifier,
    port: privatePort,
    wildcardHost: isInsideBox(),
    audit: (event, value) => appendLog(event, value),
});
const cloudflaredRouterIntegration = createCloudflaredRouterIntegration({
    audit: (event, value) => appendLog(event, value),
});

server.on('upgrade', async (req, socket, head) => {
    try {
        const exactHost = normalizeExactHost(req.headers.host);
        if (!exactHost || !String(req.url || '').startsWith('/')) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }
        const parsedUrl = new URL(req.url, `http://${exactHost === '::1' ? '[::1]' : exactHost}`);
        const listener = interfaceClassifier.classify(socket.localAddress) === 'managed'
            ? 'managed'
            : 'public';
        req.ploinkyListenerClass = listener;
        const routePlan = resolveEdgeRoutePlan({
            req,
            parsedUrl,
            listener,
            transport: 'websocket',
        });
        if (!routePlan.ok || !['agent-root', 'agent-port'].includes(routePlan.kind)) {
            socket.write(`HTTP/1.1 ${routePlan.status || 404} Not Found\r\n\r\n`);
            socket.destroy();
            return;
        }
        if (routePlan.kind === 'agent-port') {
            const captured = createCapturingRes();
            const access = await ensureHttpRouteAccess(
                req,
                captured,
                routePlan.parsedUrl,
                httpAccessForEdgeRoutePlan(routePlan),
                { routePlan },
            );
            if (!access?.ok) {
                socket.write(`HTTP/1.1 ${captured.statusCode || 403} Forbidden\r\n\r\n`);
                socket.destroy();
                return;
            }
            await executeWebSocketPlan({
                req,
                socket,
                head,
                plan: routePlan,
                lease: routePlan.lease,
                relayManager: runtimeRelayManager,
                authorized: true,
                trustedHeaders: {
                    ...(req.user?.id ? { userId: req.user.id } : {}),
                    authInfo: buildHttpRouteAuthInfoHeader(
                        req,
                        routePlan.parsedUrl,
                        routePlan.authDefinition,
                        {
                            routePath: routePlan.unmatchedSuffix,
                        },
                    )['x-ploinky-auth-info'],
                    applicationHeaders: buildHttpRouteRateSourceHeader(req, routePlan),
                },
                auditSink: event => appendLog(event.event, event),
            });
            return;
        }
        const handled = await handleAgentRootUpgrade({ req, socket, head, parsedUrl: routePlan.parsedUrl, routePlan });
        if (!handled) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); }
    } catch (_) {
        try { socket.destroy(); } catch (_) {}
    }
});

privateServer.on('upgrade', async (req, socket, head) => {
    try {
        req.ploinkyListenerClass = classifyPrivateListenerRequest(req);
        const exactHost = normalizeExactHost(req.headers.host);
        if (!exactHost || !String(req.url || '').startsWith('/')) throw new Error('malformed request');
        const parsedUrl = new URL(req.url, `http://${exactHost === '::1' ? '[::1]' : exactHost}`);
        const routePlan = resolveEdgeRoutePlan({ req, parsedUrl, listener: 'private' });
        if (!routePlan.ok || routePlan.kind !== 'agent-port') throw new Error('private route denied');
        authorizePrivateRoutePlan({ req, plan: routePlan, body: Buffer.alloc(0) });
        await executeWebSocketPlan({
            req,
            socket,
            head,
            plan: routePlan,
            lease: routePlan.lease,
            relayManager: runtimeRelayManager,
            authorized: true,
            auditSink: event => appendLog(event.event, event),
        });
    } catch (_) {
        try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (_) {}
        try { socket.destroy(); } catch (_) {}
    }
});

function prepareHealthSocket() {
    fs.mkdirSync(path.dirname(detailedHealthSocket), { recursive: true, mode: 0o700 });
    try {
        const stat = fs.lstatSync(detailedHealthSocket);
        if (!stat.isSocket()) throw new Error(`refusing to replace non-socket detailed health path: ${detailedHealthSocket}`);
        fs.unlinkSync(detailedHealthSocket);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

prepareHealthSocket();

// Setup process lifecycle management for every listener.
const lifecycle = setupProcessLifecycle(
    [server, healthServer],
    globalState,
    agentSessionStore,
    {
        beforeClose: [async () => {
            runtimeRelayManager.close();
            await cloudflaredRouterIntegration.stop();
            await interfaceClassifier.close();
            await privateListenerSet.close();
        }],
    },
);

// Server error handlers
server.on('error', (error) => {
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

privateServer.on('error', (error) => {
    console.error('[FATAL] Private Router server error:', error);
    appendLog('private_server_error', { error: error.message, code: error.code, port: privatePort });
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') process.exit(2);
    lifecycle.gracefulShutdown('private_server_error', 1);
});

healthServer.on('error', (error) => {
    console.error('[FATAL] Detailed health socket error:', error);
    appendLog('health_server_error', { error: error.message, code: error.code });
    lifecycle.gracefulShutdown('health_server_error', 1);
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

privateServer.on('clientError', (_error, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

healthServer.on('clientError', (_error, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

try {
    await interfaceClassifier.start();
    const snapshot = await privateListenerSet.start();
    cloudflaredRouterIntegration.markPrivateListenerReady();
    appendLog('private_server_start', {
        port: privatePort,
        addresses: snapshot.addresses,
        classifierError: snapshot.classifierError || undefined,
    });
    logBootEvent('private_server_listening', { port: privatePort, addresses: snapshot.addresses });
} catch (error) {
    console.error('[FATAL] Private Router exact listener set failed:', error);
    appendLog('private_server_start_error', {
        code: error?.code || 'PRIVATE_LISTENER_SET_START_FAILED',
        error: String(error?.message || error),
    });
    process.exit(2);
}

healthServer.listen(detailedHealthSocket, () => {
    fs.chmodSync(detailedHealthSocket, 0o600);
    appendLog('health_server_start', { socket: detailedHealthSocket });
});

// Start server
server.listen(port, '0.0.0.0', () => {
    cloudflaredRouterIntegration.markPublicListenerReady();
    console.log(`[RoutingServer] Ploinky server running on http://127.0.0.1:${port}`);
    console.log('  Dashboard:       /dashboard');
    console.log('  WebChat:         /webchat');
    console.log('  Status data:     /status/data');
    console.log('  Health:          /health');
    console.log('  Agent routes:    /<agent>/{mcp,task,agent-card,v1/models,v1/chat/completions}');
    console.log('  Agent ports:     /base-agent-additional-server/<agent>/<port>/');
    console.log('  Aggregate cards: /agent-card');
    appendLog('server_start', { port });
    logBootEvent('server_listening', { port });

    // Bootstrap MCP tool policy from each enabled agent's mcp-config tags
    // (persisted admin policy always wins). Without this, fail-closed
    // enforcement would deny every tool call because no entries exist yet.
    try {
        const { added } = policy.mcpToolPolicy.bootstrap(loadApiRoutes());
        appendLog('mcp_policy_bootstrap', { added });
    } catch (err) {
        appendLog('mcp_policy_bootstrap_error', { error: err?.message || String(err) });
    }

    try {
        policy.httpRouteAccessPolicy.bindProviders({
            manifestRouteProvider: createManifestRouteProvider(() => loadApiRoutes()),
            routeDefaultProvider: ({ routeKey }) => resolveRouteDefaultHttpAccess(routeKey),
        });
        appendLog('http_route_access_providers_bound', {});
    } catch (err) {
        appendLog('http_route_access_providers_bind_error', { error: err?.message || String(err) });
    }

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
