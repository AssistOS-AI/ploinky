import http from 'http';
import { execFileSync } from 'child_process';
import { ensureAuthenticated } from './authHandlers/authContext.js';
import { closeSocket, createCapturingRes, proxyWsUpgrade } from './wsServiceProxy.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ROUTER_IDENTITY_HEADERS = new Set([
    'x-ploinky-auth-info',
    'x-ploinky-user-delegation',
    'x-ploinky-user-id',
    'x-ploinky-user',
    'x-ploinky-user-email',
    'x-ploinky-user-roles',
    'x-ploinky-session-id'
]);

function buildProfileServerPath(agentProxyPath, serverUrl) {
    const target = new URL(serverUrl);
    const [rawPath = '/', query = ''] = String(agentProxyPath || '/').split('?');
    const suffix = String(rawPath || '/').replace(/^\/+/, '');
    const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/+$/, '') : '';
    const upstreamPath = `${basePath}/${suffix}`.replace(/\/{2,}/g, '/');
    return `${upstreamPath || '/'}${query ? `?${query}` : ''}`;
}

function containerInspect(containerName) {
    const name = String(containerName || '').trim();
    if (!name) return null;
    for (const runtime of ['podman', 'docker']) {
        try {
            const raw = execFileSync(runtime, ['inspect', name], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed[0]) {
                return parsed[0];
            }
        } catch (_) {}
    }
    return null;
}

function resolveContainerIp(containerName) {
    const data = containerInspect(containerName);
    const directIp = String(data?.NetworkSettings?.IPAddress || '').trim();
    if (directIp) return directIp;
    const networks = data?.NetworkSettings?.Networks || {};
    for (const network of Object.values(networks)) {
        const ip = String(network?.IPAddress || '').trim();
        if (ip) return ip;
    }
    return '';
}

function resolveProfileServerTarget(route) {
    const server = route?.additionalServerPort || route?.config?.additionalServerPort || null;
    const rawUrl = String(server?.url || server || '').trim();
    if (!rawUrl) return null;
    const target = new URL(rawUrl);
    const mode = String(server?.mode || 'container').trim().toLowerCase();
    if (mode === 'container' && LOOPBACK_HOSTS.has(target.hostname)) {
        const containerIp = resolveContainerIp(route?.container);
        if (!containerIp) {
            return {
                error: 'container_ip_unavailable',
                message: `Could not resolve container IP for '${route?.container || ''}'.`
            };
        }
        target.hostname = containerIp;
    }
    return { target };
}

function proxyProfileServer(req, res, route, agentProxyPath, extraHeaders = {}) {
    const resolved = resolveProfileServerTarget(route);
    if (!resolved) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'profile_server_not_configured' }));
        return true;
    }
    if (resolved.error) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: resolved.error, message: resolved.message }));
        return true;
    }

    const target = resolved.target;
    const upstreamPath = buildProfileServerPath(agentProxyPath, target.toString());
    const headers = {
        ...stripRouterIdentityHeaders(req.headers),
        ...extraHeaders,
        host: target.host,
        'x-forwarded-host': req.headers.host || '',
        'x-forwarded-prefix': ''
    };

    const upstream = http.request({
        hostname: target.hostname,
        port: target.port,
        path: upstreamPath,
        method: req.method,
        headers
    }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        upstreamRes.pipe(res, { end: true });
    });
    upstream.on('error', err => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'profile_server_upstream_error', detail: String(err?.message || err) }));
    });
    req.on('aborted', () => {
        upstream.destroy();
    });
    req.pipe(upstream, { end: true });
    return true;
}

async function handleProfileServerUpgrade({ req, socket, head, route, agentProxyPath, parsedUrl }) {
    if (!route?.additionalServerPort) {
        closeSocket(socket, 404, 'Not Found');
        return true;
    }

    const capRes = createCapturingRes();
    const authResult = await ensureAuthenticated(req, capRes, parsedUrl);
    if (!authResult?.ok) {
        const setCookie = capRes.getHeader('set-cookie');
        closeSocket(
            socket,
            capRes.statusCode || 401,
            'Unauthorized',
            setCookie ? { 'set-cookie': setCookie } : {}
        );
        return true;
    }

    const resolved = resolveProfileServerTarget(route);
    if (!resolved) {
        closeSocket(socket, 404, 'Not Found');
        return true;
    }
    if (resolved.error) {
        closeSocket(socket, 502, 'Bad Gateway');
        return true;
    }

    const target = resolved.target;
    const upstreamPath = buildProfileServerPath(agentProxyPath, target.toString());
    const setCookie = capRes.getHeader('set-cookie');
    proxyWsUpgrade({
        socket,
        head,
        hostPort: target.port,
        upstreamPath,
        upstreamHostname: target.hostname,
        forwardHeaders: {
            ...stripRouterIdentityHeaders(req.headers),
            host: target.host,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-prefix': ''
        },
        extraResponseHeaders: setCookie ? { 'set-cookie': setCookie } : {}
    });
    return true;
}

function stripRouterIdentityHeaders(headers = {}) {
    const sanitized = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (ROUTER_IDENTITY_HEADERS.has(String(name || '').toLowerCase())) continue;
        sanitized[name] = value;
    }
    return sanitized;
}

export {
    buildProfileServerPath,
    handleProfileServerUpgrade,
    proxyProfileServer,
    resolveProfileServerTarget
};
