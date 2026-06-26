import http from 'http';
import { resolveHttpServiceRoute, buildServiceAgentPath } from './httpServiceRoutes.js';
import { buildHttpServiceAuthInfoHeader, stripRouterIdentityHeaders, loadApiRoutes } from './routerHandlers.js';
import { hasInternalAgentSegment } from './internalAgentPath.js';
import { sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { ensureHttpRouteAccess } from './authHandlers/authContext.js';

const HANDSHAKE_TIMEOUT_MS = 10_000;

function lowerKeys(obj = {}) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[String(k).toLowerCase()] = v;
    return out;
}

// res-shaped sink so the existing cookie→user auth gate (which writes status,
// Set-Cookie refresh, and redirects to `res`) runs unchanged during an upgrade
// where only a raw socket exists. We capture statusCode + headers (esp.
// set-cookie) and read the {ok} result + req.user side effect.
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
            if (maybeHeaders && typeof maybeHeaders === 'object') Object.assign(headers, lowerKeys(maybeHeaders));
            this.headersSent = true;
            return this;
        },
        write() { return true; },
        end() { this.finished = true; this.headersSent = true; },
    };
}

export async function resolveUpgradeTarget({ req, parsedUrl, policy }) {
    const pathname = parsedUrl?.pathname || '';
    const definition = resolveHttpServiceRoute(pathname);
    if (!definition) return { matched: false };

    const route = loadApiRoutes()[definition.routeKey];
    if (!route || !route.hostPort) return { matched: true, ok: false, status: 404 };

    const decision = policy.httpRouteAccessPolicy.evaluate({ pathname, method: 'GET', routeKey: definition.routeKey });
    const capRes = createCapturingRes();
    const access = await ensureHttpRouteAccess(req, capRes, parsedUrl, decision);
    if (!access || access.ok !== true) {
        return { matched: true, ok: false, status: capRes.statusCode || 401 };
    }
    if (definition.access !== 'public' && (!req.user || typeof req.user !== 'object')) {
        return { matched: true, ok: false, status: 401 };
    }

    req.headers = stripRouterIdentityHeaders(req.headers);
    const upstreamPath = buildServiceAgentPath(pathname, parsedUrl?.search, definition.externalPrefix, definition.internalPrefix);
    if (hasInternalAgentSegment(upstreamPath)) return { matched: true, ok: false, status: 404 };

    // Mirror the HTTP path: always call the builder (it returns {} unless
    // includeAuthInfo && req.user, and adds the signed invocation token only
    // when issueInvocation). Empty body hash — upgrades carry no body, same as
    // the GET requests that already work.
    let identityHeaders = {};
    try {
        identityHeaders = buildHttpServiceAuthInfoHeader(req, parsedUrl, definition, {
            bodyHash: sha256RawBodyHash(Buffer.alloc(0)),
            servicePath: upstreamPath,
        });
    } catch (_) {
        return { matched: true, ok: false, status: 500 };
    }
    if (definition.access !== 'public' && definition.includeAuthInfo && !identityHeaders['x-ploinky-auth-info']) {
        return { matched: true, ok: false, status: 401 }; // fail closed
    }

    const setCookie = capRes.getHeader('set-cookie');
    return {
        matched: true, ok: true,
        hostPort: route.hostPort,
        upstreamPath,
        identityHeaders,
        responseHeaders: setCookie ? { 'set-cookie': setCookie } : {},
    };
}

function buildStatusLine(statusCode, statusMessage, headers = {}) {
    const lines = [`HTTP/1.1 ${statusCode} ${statusMessage || ''}`.trim()];
    for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) v.forEach((val) => lines.push(`${k}: ${val}`));
        else if (v != null) lines.push(`${k}: ${v}`);
    }
    return lines.join('\r\n') + '\r\n\r\n';
}

function closeSocket(socket, status, message) {
    try { socket.write(buildStatusLine(status, message)); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
}

function proxyWsUpgrade({ socket, head, hostPort, upstreamPath, forwardHeaders, extraResponseHeaders }) {
    const proxyReq = http.request({
        hostname: '127.0.0.1', port: hostPort, method: 'GET', path: upstreamPath,
        headers: { ...forwardHeaders, host: `127.0.0.1:${hostPort}` },
    });
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proxyReq.destroy(); } catch (_) {}
        closeSocket(socket, 504, 'Gateway Timeout');
    }, HANDSHAKE_TIMEOUT_MS);

    proxyReq.on('upgrade', (proxyRes, agentSocket, agentHead) => {
        if (settled) { try { agentSocket.destroy(); } catch (_) {} return; }
        settled = true; clearTimeout(timer);
        socket.write(buildStatusLine(proxyRes.statusCode, proxyRes.statusMessage, { ...proxyRes.headers, ...extraResponseHeaders }));
        if (agentHead && agentHead.length) socket.write(agentHead);   // upstream → browser
        if (head && head.length) agentSocket.write(head);             // client → agent
        agentSocket.pipe(socket);
        socket.pipe(agentSocket);
        const teardown = () => { try { agentSocket.destroy(); } catch (_) {} try { socket.destroy(); } catch (_) {} };
        agentSocket.on('error', teardown); socket.on('error', teardown);
        agentSocket.on('close', () => { try { socket.destroy(); } catch (_) {} });
        socket.on('close', () => { try { agentSocket.destroy(); } catch (_) {} });
    });

    proxyReq.on('response', (proxyRes) => {            // agent refused upgrade (e.g. 401)
        if (settled) return;
        settled = true; clearTimeout(timer);
        socket.write(buildStatusLine(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.headers));
        proxyRes.pipe(socket);
        proxyRes.on('end', () => { try { socket.destroy(); } catch (_) {} });
    });

    proxyReq.on('error', () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        closeSocket(socket, 502, 'Bad Gateway');
    });

    proxyReq.end();
}

export async function handleHttpServiceUpgrade({ req, socket, head, parsedUrl, policy }) {
    let target;
    try {
        target = await resolveUpgradeTarget({ req, parsedUrl, policy });
    } catch (_) {
        closeSocket(socket, 500, 'Internal Server Error');
        return true;
    }
    if (!target.matched) return false;
    if (!target.ok) { closeSocket(socket, target.status || 401); return true; }
    proxyWsUpgrade({
        socket, head,
        hostPort: target.hostPort,
        upstreamPath: target.upstreamPath,
        forwardHeaders: { ...req.headers, ...target.identityHeaders },
        extraResponseHeaders: target.responseHeaders || {},
    });
    return true;
}
