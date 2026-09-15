const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

const ROUTER_HEADERS = new Set([
    'x-ploinky-auth-info',
    'x-ploinky-user-delegation',
    'x-ploinky-agent-assertion',
    'x-ploinky-machine-assertion',
    'x-ploinky-user-id',
    'x-ploinky-user',
    'x-ploinky-user-email',
    'x-ploinky-user-roles',
    'x-ploinky-session-id',
    'x-ploinky-target-agent',
    'x-ploinky-target-port',
    'x-ploinky-relay',
]);

const ROUTER_COOKIES = new Set([
    'ploinky_sso',
    'ploinky_jwt',
    'ploinky_guest',
    'ploinky_csrf',
    'ploinky_browser_csrf',
]);

function headerEntries(headers) {
    return Object.entries(headers || {}).map(([name, value]) => [String(name).toLowerCase(), value]);
}

export function measureHeaderBytes(headers = {}) {
    return Object.entries(headers).reduce((total, [name, value]) => {
        const values = Array.isArray(value) ? value : [value];
        return total + values.reduce((sum, item) => sum + Buffer.byteLength(`${name}: ${item}\r\n`), 0);
    }, 2);
}

function connectionNamedHeaders(headers) {
    const value = headerEntries(headers).find(([name]) => name === 'connection')?.[1];
    return new Set(String(Array.isArray(value) ? value.join(',') : value || '')
        .split(',')
        .map(name => name.trim().toLowerCase())
        .filter(Boolean));
}

function sanitizeCookie(value) {
    const retained = String(Array.isArray(value) ? value.join('; ') : value || '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => !isRouterCookie(part.split('=', 1)[0].trim()));
    return retained.join('; ');
}

export function isRouterCookie(name) {
    const unprefixed = String(name || '').replace(/^__Host-/, '');
    return ROUTER_COOKIES.has(unprefixed) || unprefixed.startsWith('ploinky_sso_login_');
}

export function sanitizeRequestHeaders(headers, plan, trusted = {}) {
    const namedByConnection = connectionNamedHeaders(headers);
    const result = {};
    for (const [name, value] of headerEntries(headers)) {
        if (!name || name === 'host' || name === 'content-length') continue;
        if (name === 'forwarded' || name.startsWith('x-forwarded-')) continue;
        if (name.startsWith('proxy-') || HOP_BY_HOP.has(name) || namedByConnection.has(name)) continue;
        if (ROUTER_HEADERS.has(name) || name.startsWith('x-ploinky-')) continue;
        if (name === 'authorization' && plan?.credentialPolicy?.allowApplicationAuthorization !== true) continue;
        if (name === 'cookie') {
            if (plan?.credentialPolicy?.allowApplicationCookies !== true) continue;
            const cookie = sanitizeCookie(value);
            if (cookie) result.cookie = cookie;
            continue;
        }
        result[name] = value;
    }
    result.host = `127.0.0.1:${plan.port}`;
    result['x-forwarded-proto'] = plan.scheme;
    result['x-forwarded-host'] = plan.authority;
    result['x-forwarded-prefix'] = plan.forwardedPrefix
        || `/${plan.convention}/${encodeURIComponent(plan.routeKey)}/${plan.port}`;
    const publicProtocol = plan?.access?.access === 'public' && plan?.access?.publicProtocol;
    if (!publicProtocol && trusted.authInfo) result['x-ploinky-auth-info'] = String(trusted.authInfo);
    if (!publicProtocol && trusted.userId) result['x-ploinky-user-id'] = String(trusted.userId);
    for (const [rawName, value] of Object.entries(trusted.applicationHeaders || {})) {
        const name = String(rawName).toLowerCase();
        if (!name || HOP_BY_HOP.has(name) || ROUTER_HEADERS.has(name) || name.startsWith('x-forwarded-')) continue;
        result[name] = value;
    }
    return result;
}

export { HOP_BY_HOP, ROUTER_HEADERS, ROUTER_COOKIES };

export default sanitizeRequestHeaders;
