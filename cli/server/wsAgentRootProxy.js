import http from 'node:http';

import { buildIdentityHeaders, ensureHttpRouteAccess } from './authHandlers/authContext.js';
import {
    commitRoutePlan,
    httpAccessForEdgeRoutePlan,
    resolveEdgeRoutePlan,
} from './edgeRoutePlan.js';
import {
    buildTrustedForwardingHeaders,
    createLeaseCommittedAgent,
    stripRouterIdentityHeaders,
} from './routerHandlers.js';

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
    const targetPort = Number(plan.target?.hostPort || 0);
    if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        closeSocket(socket, 503);
        return true;
    }
    headers.host = `127.0.0.1:${targetPort}`;

    const upstream = http.request({
        hostname: '127.0.0.1',
        port: targetPort,
        method: 'GET',
        path: plan.upstreamPath,
        headers,
        agent: createLeaseCommittedAgent(() => commitRoutePlan(plan)),
    });
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
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
        closeSocket(socket, response.statusCode || 502, response.statusMessage);
    });
    upstream.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        closeSocket(socket, error?.code === 'EDGE_GENERATION_CHANGED' ? 503 : 502);
    });
    upstream.end();
    return true;
}
