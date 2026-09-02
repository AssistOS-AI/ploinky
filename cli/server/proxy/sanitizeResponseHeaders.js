import { HOP_BY_HOP, isRouterCookie, ROUTER_HEADERS } from './sanitizeRequestHeaders.js';

function isPrivateIpv4(host) {
    const octets = host.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
    const [first, second] = octets;
    return first === 0
        || first === 10
        || first === 127
        || (first === 100 && second >= 64 && second <= 127)
        || (first === 169 && second === 254)
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || first >= 224;
}

function isPrivateLocation(value) {
    try {
        const location = new URL(String(value));
        const host = location.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
        return host === 'localhost'
            || host === '::1'
            || host === '::'
            || isPrivateIpv4(host)
            || /^f[cd][0-9a-f]{2}:/i.test(host)
            || /^fe[89ab][0-9a-f]:/i.test(host)
            || host.startsWith('::ffff:')
            || host.endsWith('.internal')
            || host.endsWith('.local')
            || host.endsWith('.localhost')
            || !host.includes('.');
    } catch (_) {
        return false;
    }
}

function routerCookie(setCookie) {
    return isRouterCookie(String(setCookie || '').split('=', 1)[0].trim());
}

function allowedProtocolLocation(value, protocol) {
    const raw = String(value || '');
    if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) return true;
    try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
        if (!isPrivateLocation(raw)) return true;
        return protocol.allowLoopbackRedirects === true
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch (_) { return false; }
}

function protocolCorsHeaders(headers, policy) {
    if (policy.publicProtocol?.allowCors !== true) return {};
    const origin = String(policy.requestOrigin || '');
    try {
        const url = new URL(origin);
        if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) return {};
    } catch (_) { return {}; }
    const normalized = Object.fromEntries(Object.entries(headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    // The application validates the registered client origin. Never turn a
    // wildcard, opaque origin, or unrelated response origin into permission.
    if (normalized['access-control-allow-origin'] !== origin) return {};
    const result = { 'access-control-allow-origin': origin };
    const pickTokens = (name, allowed, normalize) => {
        const tokens = String(normalized[name] || '').split(',').map(value => normalize(value.trim())).filter(Boolean);
        const permitted = [...new Set(tokens.filter(value => allowed.includes(value)))];
        if (permitted.length) result[name] = permitted.join(', ');
    };
    pickTokens('access-control-allow-methods', policy.publicProtocol.methods, value => value.toUpperCase());
    pickTokens('access-control-allow-headers', ['authorization', 'content-type'], value => value.toLowerCase());
    pickTokens('access-control-expose-headers', ['www-authenticate'], value => value.toLowerCase());
    const maxAge = String(normalized['access-control-max-age'] || '');
    if (/^\d+$/.test(maxAge)) result['access-control-max-age'] = String(Math.min(Number(maxAge), 600));
    return result;
}

export function sanitizeResponseHeaders(headers, plan) {
    const policy = plan?.responsePolicy || {};
    const result = {};
    for (const [rawName, value] of Object.entries(headers || {})) {
        const name = String(rawName).toLowerCase();
        if (!name || HOP_BY_HOP.has(name) || name === 'proxy-connection') continue;
        if (ROUTER_HEADERS.has(name) || name.startsWith('x-ploinky-')) continue;
        if (name === 'location') {
            if (policy.publicProtocol) {
                if (!allowedProtocolLocation(value, policy.publicProtocol)) continue;
            } else if (isPrivateLocation(value)) continue;
            if (policy.allowRedirects !== true && /^https?:/i.test(String(value || ''))) continue;
        }
        if (name === 'set-cookie') {
            if (policy.allowApplicationCookies !== true) continue;
            const values = (Array.isArray(value) ? value : [value]).filter(item => !routerCookie(item));
            if (!values.length) continue;
            result[name] = values;
            continue;
        }
        if (name.startsWith('access-control-')) continue;
        result[name] = value;
    }
    const protocolCors = protocolCorsHeaders(headers, policy);
    Object.assign(result, protocolCors);
    if (protocolCors['access-control-allow-origin']) {
        result.vary = result.vary ? `${result.vary}, Origin` : 'Origin';
    }
    if (policy.corsOrigin) {
        result['access-control-allow-origin'] = String(policy.corsOrigin);
        result.vary = result.vary ? `${result.vary}, Origin` : 'Origin';
    }
    if (policy.allowCaching !== true) result['cache-control'] = 'no-store';
    return result;
}

export default sanitizeResponseHeaders;
