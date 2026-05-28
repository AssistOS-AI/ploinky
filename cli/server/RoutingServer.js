import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Handler imports
import { handleWebTTY } from './handlers/webtty.js';
import { handleWebChat } from './handlers/webchat.js';
import { handleDashboard } from './handlers/dashboard.js';
import { handleWebMeet } from './handlers/webmeet.js';
import { handleStatus } from './handlers/status.js';
import { handleBlobs, handleWorkspaceUpload } from './handlers/blobs.js';
import * as staticSrv from './static/index.js';

// Authentication and routing
import { ensureAuthenticated, handleAuthRoutes, handleUserAdminRoutes } from './authHandlers.js';
import {
    loadApiRoutes,
    handleRouterMcp,
    handleHttpServiceRoute,
    isPublicHttpServiceRoute,
    proxyHttpPassthrough
} from './routerHandlers.js';

// Logging
import { appendLog, logBootEvent, logMemoryUsage } from './utils/logger.js';
import { isRouteMount } from './utils/routeMounts.js';

// New modular components
import { agentSessionStore, handleAgentMcpRequest } from './mcp-proxy/index.js';
import { initializeTTYFactories, createServiceConfig } from './utils/ttyFactories.js';
import { setupProcessLifecycle } from './utils/processLifecycle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_BROWSER_CLIENT_PATH = path.resolve(__dirname, '../../Agent/client/MCPBrowserClient.js');

// Initialize TTY factories
const { getWebttyFactory, getWebchatFactory } = await initializeTTYFactories();

// Create service configuration
const config = createServiceConfig(getWebttyFactory, getWebchatFactory);

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
    webtty: { sessions: new Map() },
    webchat: { sessions: new Map() },
    dashboard: { sessions: new Map() },
    webmeet: {
        sessions: new Map(),
        participants: new Map(),
        chatHistory: [],
        privateHistory: new Map(),
        nextMsgId: 1,
        queue: [],
        currentSpeaker: null
    },
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

const GLOBAL_ROUTE_PREFIXES = [
    '/health',
    '/MCPBrowserClient.js',
    '/auth/',
    '/api/agents/',
    '/agent-card',
    '/mcp',
    '/webtty',
    '/webchat',
    '/dashboard',
    '/webmeet',
    '/status',
    '/upload',
    '/blobs',
];

function isGlobalRoute(pathname) {
    for (const prefix of GLOBAL_ROUTE_PREFIXES) {
        if (prefix.endsWith('/')) {
            if (pathname.startsWith(prefix)) return true;
        } else {
            if (pathname === prefix || pathname.startsWith(prefix + '/')) return true;
        }
    }
    return false;
}

const AGENT_API_SUBPATHS = ['mcp', 'task', 'agent-card', 'v1/chat/completions'];

function parseAgentApiRoute(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const agentName = decodePathSegment(parts[0]).trim();
    if (!agentName) return null;
    if (isGlobalRoute(pathname)) return null;

    const subPath = parts.slice(1).join('/');
    for (const apiSubpath of AGENT_API_SUBPATHS) {
        if (subPath === apiSubpath || subPath.startsWith(apiSubpath + '/')) {
            return { agentName, subPath };
        }
    }
    return null;
}

function requestAgentCard(route, agentName, identityHeaders = {}) {
    return new Promise((resolve) => {
        const upstream = http.request({
            hostname: '127.0.0.1',
            port: route.hostPort,
            path: '/agent-card',
            method: 'GET',
            headers: {
                accept: 'application/json',
                ...identityHeaders
            },
            timeout: 5000
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
}

async function handleRoutedAggregateAgentCard(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET') {
        sendJsonResponse(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return;
    }
    const apiRoutes = loadApiRoutes();
    const candidates = Object.entries(apiRoutes || {})
        .filter(([, route]) => route && !route.disabled && route.hostPort);
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

function handleRoutedOpenAiChatCompletions(req, res, route) {
    const pathWithQuery = `/v1/chat/completions${new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).search || ''}`;
    proxyHttpPassthrough(req, res, route.hostPort, pathWithQuery, req.headers);
}

function handleRoutedAgentCard(req, res, route) {
    const pathWithQuery = `/agent-card${new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).search || ''}`;
    proxyHttpPassthrough(req, res, route.hostPort, pathWithQuery, req.headers);
}

function proxyAgentTaskStatus(req, res, route) {
    const pathWithQuery = `/getTaskStatus${new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).search || ''}`;
    proxyHttpPassthrough(req, res, route.hostPort, pathWithQuery, req.headers);
}

/**
 * Main request processor
 */
async function processRequest(req, res) {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname || '/';
    const routedAggregateAgentCard = pathname === '/agent-card' || pathname === '/agent-card/';
    const agentApiRoute = parseAgentApiRoute(pathname);
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
                webtty: globalState.webtty.sessions.size,
                webchat: globalState.webchat.sessions.size,
                dashboard: globalState.dashboard.sessions.size,
                webmeet: globalState.webmeet.sessions.size,
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

    // Authentication routes
    if (pathname.startsWith('/auth/')) {
        const handled = await handleAuthRoutes(req, res, parsedUrl);
        if (handled) return;
    }

    if (pathname.startsWith('/api/agents/')) {
        const handled = await handleUserAdminRoutes(req, res, parsedUrl);
        if (handled) return;
    }

    // Agent-prefixed routes are public at the router level;
    // the target agent decides whether to accept or reject the request.
    const isAgentRoute = agentApiRoute !== null;

    if (routedAggregateAgentCard) {
        // Public aggregate route
    } else if (isAgentRoute) {
        // no-op; transparent proxy handled downstream
    } else if (pathname === '/mcp' || pathname === '/mcp/') {
        const authResult = await ensureAuthenticated(req, res, parsedUrl);
        if (!authResult.ok) return;
    } else if (isPublicHttpServiceRoute(pathname)) {
        // Tokenized public service routes are intentionally public.
    } else {
        // Ensure authenticated for other protected routes
        const authResult = await ensureAuthenticated(req, res, parsedUrl);
        if (!authResult.ok) return;
    }

    // Route to appropriate handler
    if (isRouteMount(pathname, '/webtty')) {
        return handleWebTTY(req, res, config.webtty, globalState.webtty);
    } else if (isRouteMount(pathname, '/webchat')) {
        return handleWebChat(req, res, config.webchat, globalState.webchat);
    } else if (isRouteMount(pathname, '/dashboard')) {
        return handleDashboard(req, res, config.dashboard, globalState.dashboard);
    } else if (isRouteMount(pathname, '/webmeet')) {
        return handleWebMeet(req, res, config.webmeet, globalState.webmeet);
    } else if (isRouteMount(pathname, '/status')) {
        return handleStatus(req, res, config.status, globalState.status);
    } else if (pathname === '/upload') {
        return handleWorkspaceUpload(req, res);
    } else if (isRouteMount(pathname, '/blobs')) {
        return handleBlobs(req, res);
    } else if (handleHttpServiceRoute(req, res, parsedUrl)) {
        return;
    } else if (routedAggregateAgentCard) {
        return handleRoutedAggregateAgentCard(req, res);
    } else if (agentApiRoute) {
        const apiRoutes = loadApiRoutes();
        const route = apiRoutes[agentApiRoute.agentName];
        if (!route || !route.hostPort) {
            sendJsonResponse(res, 404, { error: 'agent_not_found', agent: agentApiRoute.agentName });
            return;
        }

        const { subPath } = agentApiRoute;
        if (subPath === 'mcp' || subPath.startsWith('mcp/')) {
            return handleAgentMcpRequest(req, res, route, agentApiRoute.agentName);
        } else if (subPath === 'task' || subPath.startsWith('task/')) {
            return proxyAgentTaskStatus(req, res, route);
        } else if (subPath === 'agent-card' || subPath.startsWith('agent-card/')) {
            return handleRoutedAgentCard(req, res, route);
        } else if (subPath === 'v1/chat/completions' || subPath.startsWith('v1/chat/completions/')) {
            return handleRoutedOpenAiChatCompletions(req, res, route);
        } else {
            sendJsonResponse(res, 404, { error: 'unknown_agent_route', path: subPath });
            return;
        }
    } else if (pathname === '/mcp' || pathname === '/mcp/') {
        return handleRouterMcp(req, res);
    } else {
        // Static file serving
        if (staticSrv.serveWorkspaceFileRequest(req, res)) return;
        if (staticSrv.serveAgentStaticRequest(req, res)) return;
        if (await staticSrv.serveStaticRequest(req, res)) return;

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

// Setup process lifecycle management
const lifecycle = setupProcessLifecycle(server, globalState, agentSessionStore);

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
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
server.listen(port, () => {
    console.log(`[RoutingServer] Ploinky server running on http://127.0.0.1:${port}`);
    console.log('  Dashboard:       /dashboard');
    console.log('  WebTTY:          /webtty');
    console.log('  WebChat:         /webchat');
    console.log('  WebMeet:         /webmeet');
    console.log('  Status:          /status');
    console.log('  Health:          /health');
    console.log('  Agent routes:    /<agent>/{mcp,task,agent-card,v1/chat/completions}');
    console.log('  Aggregate cards: /agent-card');
    appendLog('server_start', { port });
    logBootEvent('server_listening', { port });

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
                let totalTabs = 0;
                for (const state of Object.values(globalState)) {
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
