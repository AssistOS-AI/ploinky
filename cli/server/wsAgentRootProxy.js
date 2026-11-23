import http from 'node:http';

import { buildIdentityHeaders, ensureHttpRouteAccess } from './authHandlers/authContext.js';
import {
    httpAccessForEdgeRoutePlan,
    resolveEdgeRoutePlan,
} from './edgeRoutePlan.js';
import {
    buildTrustedForwardingHeaders, readPublicCanaryUserId,
    stripRouterIdentityHeaders,
} from './routerHandlers.js';
import { openRootConnection, withSelectedRoot } from './proxy/executeHttpPlan.js';
import { observeProxyFirstByte, observeProxyOutcome } from './canary/proxyOutcomes.js';
import { trackCanaryConnection } from './canary/selection.mjs';

const HANDSHAKE_TIMEOUT_MS = 10_000;

function lowerKeys(value = {}) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [String(key).toLowerCase(), entry]));
}

export function createCapturingRes() {
    const headers = {};
    return {
        statusCode: 200,
        headersSent: false,
        finished: false,
        setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
        getHeader(name) { return headers[String(name).toLowerCase()]; },
        removeHeader(name) { delete headers[String(name).toLowerCase()]; },
        writeHead(status, maybeHeaders) {
            this.statusCode = status;
            Object.assign(headers, lowerKeys(maybeHeaders));
            this.headersSent = true;
            return this;
        },
        write() { return true; },
        end() { this.finished = true; this.headersSent = true; },
    };
}

function statusLine(statusCode, statusMessage, headers = {}) {
    const lines = [`HTTP/1.1 ${statusCode} ${statusMessage || ''}`.trim()];
    for (const [key, value] of Object.entries(headers)) {
        for (const entry of Array.isArray(value) ? value : [value]) {
            if (entry !== undefined && entry !== null) lines.push(`${key}: ${entry}`);
        }
    }
    return `${lines.join('\r\n')}\r\n\r\n`;
}

function closeSocket(socket, status, message = http.STATUS_CODES[status] || 'Request Failed', headers = {}) {
    try { socket.write(statusLine(status, message, headers)); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
}

export async function handleAgentRootUpgrade({
    req,
    socket,
    head,
    parsedUrl,
    listener = 'public',
    routePlan = null,
}) {
    // Node leaves an upgraded socket flowing with no 'error' listener, so a
    // client reset during the access check or upstream handshake would be
    // uncaught. This listener only absorbs the event; teardown is owned below.
    socket.on('error', () => {});
    const plan = routePlan?.kind === 'agent-root'
        ? routePlan
        : resolveEdgeRoutePlan({ req, parsedUrl, listener, transport: 'websocket' });
    if (!plan?.matched) return false;
    if (!plan.ok || plan.kind !== 'agent-root') {
        closeSocket(socket, plan?.status || 404);
        return true;
    }

    const captured = createCapturingRes();
    const access = await ensureHttpRouteAccess(
        req,
        captured,
        plan.parsedUrl || parsedUrl,
        httpAccessForEdgeRoutePlan(plan),
        { routePlan: plan },
    );
    if (!access?.ok) {
        closeSocket(socket, captured.statusCode || 403);
        return true;
    }

    const headers = {
        ...stripRouterIdentityHeaders(req.headers, {
            preserveAuthorization: false,
            preserveCookie: false,
        }),
        ...buildIdentityHeaders(req),
        ...buildTrustedForwardingHeaders(plan),
    };
    if (plan.route?.canary && plan.decision?.access === 'public') req.canaryPublicUserId = readPublicCanaryUserId(req);
    let selection;
    let upstream;
    let dialStarted;
    try {
        await withSelectedRoot({ req, plan }, (selected, check) => {
            selection = selected;
            const targetPort = selected.route.hostPort;
            headers.host = `127.0.0.1:${targetPort}`;
            dialStarted = performance.now();
            const connection = openRootConnection(selected, check);
            try {
                upstream = http.request({ hostname: '127.0.0.1', port: targetPort, method: 'GET',
                    path: plan.upstreamPath, headers, agent: connection.agent });
            } catch (error) {
                connection.socket.destroy();
                throw error;
            }
        });
    } catch (error) {
        closeSocket(socket, error.status || 502, undefined, error.status === 503 ? { 'Retry-After': '1' } : {});
        return true;
    }
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        observeProxyOutcome({ plan: selection, outcome: 'failure', unreachable: true });
        try { upstream.destroy(); } catch (_) {}
        closeSocket(socket, 504);
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();

    upstream.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
        if (settled) {
            try { upstreamSocket.destroy(); } catch (_) {}
            return;
        }
        settled = true;
        clearTimeout(timer);
        observeProxyFirstByte({ plan: selection, ttfbMs: performance.now() - dialStarted });
        let targetFailed = false;
        upstreamSocket.once('error', () => { targetFailed = !socket.destroyed; });
        upstreamSocket.once('close', () => observeProxyOutcome({ plan: selection,
            outcome: targetFailed ? 'failure' : 'success', upstreamStatus: upstreamResponse.statusCode, serverError: targetFailed }));
        const untrack = trackCanaryConnection(selection, () => { upstreamSocket.destroy(); socket.destroy(); });
        upstreamSocket.once('close', untrack);
        if (socket.destroyed || !socket.writable) {
            try { upstreamSocket.destroy(); } catch (_) {}
            try { upstream.destroy(); } catch (_) {}
            return;
        }
        socket.write(statusLine(
            upstreamResponse.statusCode || 101,
            upstreamResponse.statusMessage || 'Switching Protocols',
            {
                ...upstreamResponse.headers,
                ...(captured.getHeader('set-cookie')
                    ? { 'set-cookie': captured.getHeader('set-cookie') }
                    : {}),
            },
        ));
        if (upstreamHead?.length) socket.write(upstreamHead);
        if (head?.length) upstreamSocket.write(head);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
        const teardown = () => {
            try { upstreamSocket.destroy(); } catch (_) {}
            try { socket.destroy(); } catch (_) {}
        };
        upstreamSocket.on('error', teardown);
        socket.on('error', teardown);
        upstreamSocket.on('close', () => {
            try { socket.destroy(); } catch (_) {}
        });
        socket.on('close', () => {
            try { upstreamSocket.destroy(); } catch (_) {}
        });
    });
    upstream.once('response', (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observeProxyOutcome({ plan: selection, outcome: 'success', upstreamStatus: response.statusCode,
            ttfbMs: performance.now() - dialStarted });
        response.resume();
        closeSocket(socket, response.statusCode || 502, response.statusMessage);
    });
    upstream.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!socket.destroyed) observeProxyOutcome({ plan: selection, outcome: 'failure', error,
            serverError: true, unreachable: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code) });
        closeSocket(socket, error?.code === 'EDGE_GENERATION_CHANGED' ? 503 : 502);
    });
    upstream.end();
    return true;
}
