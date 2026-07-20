import { resolveHttpServiceRoute, buildServiceAgentPath } from './httpServiceRoutes.js';
import { buildHttpServiceAuthInfoHeader, stripRouterIdentityHeaders } from './routerHandlers.js';
import { hasInternalAgentSegment } from './internalAgentPath.js';
import { sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { ensureHttpRouteAccess } from './authHandlers/authContext.js';
import { getRoutingRuntime } from './generation/runtimeContext.js';
import { executeWebSocketPlan } from './proxy/executeWebSocketPlan.js';

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
        getHeaders() { return { ...headers }; },
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
    const runtime = getRoutingRuntime();
    let lease;
    let plan;
    let definition;
    try {
        lease = runtime.acquire({ listenerClass: 'public', authority: req.headers.host });
        definition = resolveHttpServiceRoute(pathname, { routes: lease.generation.routes });
        if (!definition) {
            lease.release();
            return { matched: false };
        }
        const target = buildServiceAgentPath(pathname, parsedUrl?.search, definition.externalPrefix, definition.internalPrefix);
        plan = runtime.resolvePrimary({
            lease,
            routeKey: definition.routeKey,
            method: 'GET',
            externalPath: pathname,
            targetPath: target.split('?', 1)[0],
            query: target.includes('?') ? target.slice(target.indexOf('?') + 1) : '',
            authority: req.headers.host,
            scheme: req.socket?.encrypted ? 'https' : 'http',
            transport: 'websocket',
        });
    } catch (_) {
        lease?.release();
        return { matched: true, ok: false, status: 503 };
    }
    if (!plan) {
        lease.release();
        return { matched: true, ok: false, status: 404 };
    }

    const capRes = createCapturingRes();
    const access = await ensureHttpRouteAccess(req, capRes, parsedUrl, plan.access);
    if (!access || access.ok !== true) {
        lease.release();
        return { matched: true, ok: false, status: capRes.statusCode || 401 };
    }
    if (definition.access !== 'public' && (!req.user || typeof req.user !== 'object')) {
        lease.release();
        return { matched: true, ok: false, status: 401 };
    }

    req.headers = stripRouterIdentityHeaders(req.headers);
    const upstreamPath = buildServiceAgentPath(pathname, parsedUrl?.search, definition.externalPrefix, definition.internalPrefix);
    if (hasInternalAgentSegment(upstreamPath)) {
        lease.release();
        return { matched: true, ok: false, status: 404 };
    }

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
        lease.release();
        return { matched: true, ok: false, status: 500 };
    }
    if (definition.access !== 'public' && definition.includeAuthInfo && !identityHeaders['x-ploinky-auth-info']) {
        lease.release();
        return { matched: true, ok: false, status: 401 }; // fail closed
    }

    const setCookie = capRes.getHeader('set-cookie');
    return {
        matched: true, ok: true,
        plan,
        lease,
        relayManager: runtime.relayManager,
        trustedHeaders: {
            ...(identityHeaders['x-ploinky-auth-info'] ? { authInfo: identityHeaders['x-ploinky-auth-info'] } : {}),
            ...(req.user?.id ? { userId: req.user.id } : {}),
        },
        responseHeaders: setCookie ? { 'set-cookie': setCookie } : {},
    };
}

export function buildStatusLine(statusCode, statusMessage, headers = {}) {
    const lines = [`HTTP/1.1 ${statusCode} ${statusMessage || ''}`.trim()];
    for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) v.forEach((val) => lines.push(`${k}: ${val}`));
        else if (v != null) lines.push(`${k}: ${v}`);
    }
    return lines.join('\r\n') + '\r\n\r\n';
}

export function closeSocket(socket, status, message, headers = {}) {
    try { socket.write(buildStatusLine(status, message, headers)); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
}

export function proxyWsUpgrade({ req, socket, head, plan, lease, relayManager, trustedHeaders }) {
    return executeWebSocketPlan({
        req,
        socket,
        head,
        plan,
        lease,
        relayManager,
        authorized: true,
        trustedHeaders,
    });
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
    await proxyWsUpgrade({ req, socket, head, ...target });
    return true;
}
