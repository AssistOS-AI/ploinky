// Exact public Router origins published by the managed runtime.
//
// The edge topology advertises `routerOrigins`, and the private runtime-origins
// operation returns the active generation's list. Consumers compare origins
// byte-for-byte, so every producer emits one canonical form and every reader
// rejects anything else instead of normalizing it. This module is deliberately
// dependency-free: topology readers load it without any signing runtime.

export const ROUTER_ORIGINS_MAX_ENTRIES = 64;
export const ROUTER_ORIGIN_MAX_LENGTH = 300;
export const ROUTER_ORIGINS_MAX_BYTES = 16 * 1024;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_LITERAL = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/;

function routerOriginsError(message) {
    const error = new Error(message);
    error.code = 'ROUTER_ORIGINS_INVALID';
    return error;
}

function isExactHost(hostname) {
    if (!hostname || hostname.length > 253 || hostname.endsWith('.')) return false;
    const labels = hostname.split('.');
    // WHATWG URL parsing turns a numeric last label into an IPv4 address, so a
    // numeric host is valid only as one canonical literal outside 0.0.0.0/8.
    if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(labels.at(-1))) {
        return IPV4_LITERAL.test(hostname)
            && labels.every((octet) => Number(octet) <= 255)
            && labels[0] !== '0';
    }
    return labels.every((label) => DNS_LABEL.test(label));
}

/**
 * Whether a value is one exact bare HTTP(S) origin: lowercase DNS name or
 * canonical IPv4 host, default port omitted, and no credentials, path, query,
 * fragment, wildcard, unspecified address, or IPv6 literal.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCanonicalRouterOrigin(value) {
    if (typeof value !== 'string' || !value || value.length > ROUTER_ORIGIN_MAX_LENGTH) return false;
    let url;
    try {
        url = new URL(value);
    } catch (_) {
        return false;
    }
    return (url.protocol === 'http:' || url.protocol === 'https:')
        && !url.username && !url.password
        && url.pathname === '/' && !url.search && !url.hash
        && url.origin === value
        && isExactHost(url.hostname);
}

/**
 * Canonicalize producer output: every entry must already be an exact origin;
 * duplicates are removed and entries sorted by code unit.
 *
 * @param {readonly string[]} origins
 * @returns {readonly string[]}
 */
export function canonicalRouterOriginList(origins) {
    if (!Array.isArray(origins)) throw routerOriginsError('Router origins must be an array');
    return parseRouterOriginList([...new Set(origins)].sort());
}

/**
 * Validate a received list exactly: a bounded, sorted, duplicate-free array of
 * canonical origins. A malformed entry invalidates the whole list; entries are
 * never dropped or repaired.
 *
 * @param {unknown} value
 * @returns {readonly string[]}
 */
export function parseRouterOriginList(value) {
    if (!Array.isArray(value)) throw routerOriginsError('Router origins must be an array');
    if (value.length > ROUTER_ORIGINS_MAX_ENTRIES) {
        throw routerOriginsError(`Router origins allow at most ${ROUTER_ORIGINS_MAX_ENTRIES} entries`);
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isCanonicalRouterOrigin(value[index])) {
            throw routerOriginsError(`Router origin at index ${index} is not an exact bare HTTP(S) origin`);
        }
        if (index > 0 && !(value[index - 1] < value[index])) {
            throw routerOriginsError('Router origins must be sorted and duplicate-free');
        }
    }
    if (Buffer.byteLength(JSON.stringify(value)) > ROUTER_ORIGINS_MAX_BYTES) {
        throw routerOriginsError(`Router origins exceed ${ROUTER_ORIGINS_MAX_BYTES} bytes`);
    }
    return Object.freeze([...value]);
}

export default {
    ROUTER_ORIGINS_MAX_BYTES,
    ROUTER_ORIGINS_MAX_ENTRIES,
    canonicalRouterOriginList,
    isCanonicalRouterOrigin,
    parseRouterOriginList,
};
