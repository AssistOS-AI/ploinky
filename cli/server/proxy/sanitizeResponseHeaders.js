import { HOP_BY_HOP, ROUTER_COOKIES, ROUTER_HEADERS } from './sanitizeRequestHeaders.js';

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
    return ROUTER_COOKIES.has(String(setCookie || '').split('=', 1)[0].trim());
}

export function sanitizeResponseHeaders(headers, plan) {
    const policy = plan?.responsePolicy || {};
    const result = {};
    for (const [rawName, value] of Object.entries(headers || {})) {
        const name = String(rawName).toLowerCase();
        if (!name || HOP_BY_HOP.has(name) || name === 'proxy-connection') continue;
        if (ROUTER_HEADERS.has(name) || name.startsWith('x-ploinky-')) continue;
        if (name === 'location') {
            if (isPrivateLocation(value)) continue;
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
    if (policy.corsOrigin) {
        result['access-control-allow-origin'] = String(policy.corsOrigin);
        result.vary = result.vary ? `${result.vary}, Origin` : 'Origin';
    }
    if (policy.allowCaching !== true) result['cache-control'] = 'no-store';
    return result;
}

export default sanitizeResponseHeaders;
