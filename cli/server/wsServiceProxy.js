import http from 'http';
import {
    buildHttpServiceAuthInfoHeader,
    buildHttpServiceRateSourceHeader,
    buildTrustedForwardingHeaders,
    createLeaseCommittedAgent,
    stripRouterIdentityHeaders,
} from './routerHandlers.js';
import { hasInternalAgentSegment } from './internalAgentPath.js';
import { sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { buildIdentityHeaders, ensureHttpRouteAccess } from './authHandlers/authContext.js';
import { commitRoutePlan, resolveEdgeRoutePlan } from './edgeRoutePlan.js';

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

export async function resolveUpgradeTarget({ req, parsedUrl, listener = 'public', routePlan = null }) {
    const plan = routePlan && ['service', 'agent-root'].includes(routePlan.kind)
        ? routePlan
        : resolveEdgeRoutePlan({ req, parsedUrl, listener });
    if (!plan?.matched) return { matched: false, status: plan?.status || 404 };
    if (!plan.ok || !['service', 'agent-root'].includes(plan.kind)) {
        return { matched: true, ok: false, status: plan?.status || 404 };
    }
    const pathname = plan.canonicalPath;
    const definition = plan.definition;
    const decision = plan.decision;
    const capRes = createCapturingRes();
    if (listener === 'private') {
        if (!req.privateAgentIdentity || decision?.access !== 'authenticated') {
            return { matched: true, ok: false, status: 403 };
        }
    } else {
        const access = await ensureHttpRouteAccess(
            req,
            capRes,
            plan.parsedUrl || parsedUrl,
            decision,
            { routePlan: plan },
        );
        if (!access || access.ok !== true) {
            return { matched: true, ok: false, status: capRes.statusCode || 401 };
        }
    }
    if (listener !== 'private' && decision?.access !== 'public' && (!req.user || typeof req.user !== 'object')) {
        return { matched: true, ok: false, status: 401 };
    }

    let rateSourceHeaders = {};
    if (plan.kind === 'service') {
        try {
            rateSourceHeaders = buildHttpServiceRateSourceHeader(req, plan);
        } catch (error) {
            return { matched: true, ok: false, status: error?.statusCode || 400 };
        }
    }
    req.headers = stripRouterIdentityHeaders(req.headers, {
        preserveAuthorization: listener === 'private',
        preserveCookie: false,
    });
    const upstreamPath = plan.upstreamPath;
    if (hasInternalAgentSegment(upstreamPath)) return { matched: true, ok: false, status: 404 };

    // Mirror the HTTP path: always call the builder (it returns {} unless
    // includeAuthInfo && req.user, and adds the signed invocation token only
    // when issueInvocation). Empty body hash — upgrades carry no body, same as
    // the GET requests that already work.
    let identityHeaders = plan.kind === 'agent-root' ? buildIdentityHeaders(req) : {};
    if (plan.kind === 'service') {
        try {
            identityHeaders = buildHttpServiceAuthInfoHeader(req, plan.parsedUrl || parsedUrl, definition, {
                bodyHash: sha256RawBodyHash(Buffer.alloc(0)),
                servicePath: upstreamPath,
            });
        } catch (_) {
            return { matched: true, ok: false, status: 500 };
        }
    }
    // A box-private caller assertion is a generation capability, not a user
    // session and must never be converted into browser identity metadata.
    // Private admission above is therefore sufficient; only public-listener
    // authenticated upgrades require the user auth-info header.
    if (plan.kind === 'service'
        && listener !== 'private'
        && definition.access !== 'public'
        && definition.includeAuthInfo
        && !identityHeaders['x-ploinky-auth-info']) {
        return { matched: true, ok: false, status: 401 }; // fail closed
    }

    const setCookie = capRes.getHeader('set-cookie');
    return {
        matched: true, ok: true,
        hostPort: plan.target.hostPort,
        upstreamPath,
        identityHeaders: { ...rateSourceHeaders, ...identityHeaders },
        forwardingHeaders: buildTrustedForwardingHeaders(plan),
        responseHeaders: setCookie ? { 'set-cookie': setCookie } : {},
        routePlan: plan,
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

export function proxyWsUpgrade({ socket, head, hostPort, upstreamPath, forwardHeaders, extraResponseHeaders, upstreamHostname = '127.0.0.1', beforeDial = null }) {
    const headers = {
        ...forwardHeaders,
        host: forwardHeaders?.host || `${upstreamHostname}:${hostPort}`,
    };
    const proxyReq = http.request({
        hostname: upstreamHostname, port: hostPort, method: 'GET', path: upstreamPath,
        headers,
        agent: createLeaseCommittedAgent(beforeDial),
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

    proxyReq.on('error', (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error?.code === 'EDGE_GENERATION_CHANGED') {
            closeSocket(socket, 503, 'Service Unavailable', { 'cache-control': 'no-store' });
            return;
        }
        closeSocket(socket, 502, 'Bad Gateway');
    });

    proxyReq.end();
    return proxyReq;
}

export async function handleHttpServiceUpgrade({ req, socket, head, parsedUrl, listener = 'public', routePlan = null }) {
    let target;
    try {
        target = await resolveUpgradeTarget({ req, parsedUrl, listener, routePlan });
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
        forwardHeaders: { ...req.headers, ...target.identityHeaders, ...target.forwardingHeaders },
        extraResponseHeaders: target.responseHeaders || {},
        beforeDial: () => commitRoutePlan(target.routePlan),
    });
    return true;
}
