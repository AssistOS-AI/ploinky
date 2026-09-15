// Trusted outer-host names for the public Router listener.
//
// `ploinky bind` may publish the public Router on a physical-host interface.
// A browser on another computer then sends that interface address (or the
// machine's name) as its Host. The host-side supervisor derives those names
// from the physical host and records them in the Box environment; the Router
// admits them only as exact matches. Request headers, the Box's own network
// identity, and agent configuration can never extend this list.

import { isUsableHostIpv4 } from '../../ploinky-box/hostNetwork.mjs';

export const PUBLIC_ROUTER_HOSTS_ENV = 'PLOINKY_PUBLIC_ROUTER_HOSTS';
export const PUBLIC_ROUTER_HOSTS_MAX_ENTRIES = 64;
export const PUBLIC_ROUTER_HOSTS_MAX_BYTES = 8192;

// Local control names are admitted without an alias, and the managed names
// identify the nested-agent listener. Neither may be claimed as an outer host.
const RESERVED_HOSTS = new Set([
    'localhost',
    'host.containers.internal',
    'host.docker.internal',
]);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// WHATWG URL parsing turns a host whose last label is numeric into an IPv4
// address, so such a host is valid only as one canonical literal.
const NUMERIC_LAST_LABEL = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const EMPTY_HOSTS = Object.freeze(new Set());

function hostsError(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_PUBLIC_ROUTER_HOSTS_INVALID';
    return error;
}

function describe(value) {
    const text = typeof value === 'string' ? value : String(value);
    return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);
}

/**
 * Normalize one outer-host name.
 *
 * Accepts a usable canonical IPv4 literal or a lowercase-able DNS name. Rejects
 * ports, credentials, wildcards, IPv6, loopback and unspecified addresses,
 * trailing dots, and reserved Router identities.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizePublicRouterHost(value) {
    if (typeof value !== 'string') return null;
    const host = value.toLowerCase();
    if (!host || host.length > 253 || host.endsWith('.')) return null;
    const labels = host.split('.');
    if (NUMERIC_LAST_LABEL.test(labels.at(-1))) {
        return isUsableHostIpv4(host) ? host : null;
    }
    if (labels.some((label) => !DNS_LABEL.test(label))) return null;
    if (RESERVED_HOSTS.has(host) || host.endsWith('.localhost')) return null;
    return host;
}

function ipv4Number(host) {
    return host.split('.').reduce((result, octet) => (result * 256) + Number(octet), 0);
}

function compareHosts(left, right) {
    const leftIp = isUsableHostIpv4(left);
    const rightIp = isUsableHostIpv4(right);
    if (leftIp !== rightIp) return leftIp ? -1 : 1;
    if (leftIp) return ipv4Number(left) - ipv4Number(right);
    return left < right ? -1 : (left > right ? 1 : 0);
}

/**
 * Canonical environment value: a sorted, unique JSON array of normalized hosts.
 * An empty array is valid and admits no outer names.
 *
 * @param {readonly string[]} hosts
 * @returns {string}
 */
export function serializePublicRouterHosts(hosts) {
    if (!Array.isArray(hosts)) {
        throw hostsError(`${PUBLIC_ROUTER_HOSTS_ENV} must be an array of host names`);
    }
    const normalized = hosts.map((host) => {
        const value = normalizePublicRouterHost(host);
        if (!value) {
            throw hostsError(`${PUBLIC_ROUTER_HOSTS_ENV} contains an invalid or reserved host ${describe(host)}`);
        }
        return value;
    });
    const unique = [...new Set(normalized)].sort(compareHosts);
    if (unique.length > PUBLIC_ROUTER_HOSTS_MAX_ENTRIES) {
        throw hostsError(
            `${PUBLIC_ROUTER_HOSTS_ENV} allows at most ${PUBLIC_ROUTER_HOSTS_MAX_ENTRIES} hosts; `
            + `received ${unique.length}`,
        );
    }
    const text = JSON.stringify(unique);
    if (Buffer.byteLength(text) > PUBLIC_ROUTER_HOSTS_MAX_BYTES) {
        throw hostsError(`${PUBLIC_ROUTER_HOSTS_ENV} exceeds ${PUBLIC_ROUTER_HOSTS_MAX_BYTES} bytes`);
    }
    return text;
}

/**
 * Parse an exact canonical environment value.
 *
 * @param {string} text
 * @returns {readonly string[]}
 */
export function parsePublicRouterHosts(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > PUBLIC_ROUTER_HOSTS_MAX_BYTES) {
        throw hostsError(`${PUBLIC_ROUTER_HOSTS_ENV} must be a JSON array of at most ${PUBLIC_ROUTER_HOSTS_MAX_BYTES} bytes`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        throw hostsError(`${PUBLIC_ROUTER_HOSTS_ENV} must be valid JSON`);
    }
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
        throw hostsError(`${PUBLIC_ROUTER_HOSTS_ENV} must be a JSON array of host-name strings`);
    }
    const canonical = serializePublicRouterHosts(parsed);
    if (canonical !== text) {
        throw hostsError(`${PUBLIC_ROUTER_HOSTS_ENV} must be a sorted, unique, lowercase JSON array without spacing`);
    }
    return Object.freeze(JSON.parse(canonical));
}

let cachedText = null;
let cachedState = Object.freeze({ hosts: EMPTY_HOSTS, error: '' });

/**
 * The Router's current trusted outer hosts. Missing state admits none, and
 * malformed state fails closed to none rather than to a permissive policy.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ hosts: ReadonlySet<string>, error: string }}
 */
export function readPublicRouterHosts(env = process.env) {
    const raw = env?.[PUBLIC_ROUTER_HOSTS_ENV];
    if (raw === undefined || raw === '') {
        return Object.freeze({ hosts: EMPTY_HOSTS, error: '' });
    }
    const text = String(raw);
    if (text === cachedText) return cachedState;
    let state;
    try {
        state = Object.freeze({ hosts: Object.freeze(new Set(parsePublicRouterHosts(text))), error: '' });
    } catch (error) {
        state = Object.freeze({ hosts: EMPTY_HOSTS, error: error.message });
    }
    cachedText = text;
    cachedState = state;
    return state;
}

/**
 * Whether an already normalized request host is one exact trusted outer host.
 *
 * @param {string} host
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isTrustedPublicRouterHost(host, env = process.env) {
    return typeof host === 'string' && host !== '' && readPublicRouterHosts(env).hosts.has(host);
}

export default {
    PUBLIC_ROUTER_HOSTS_ENV,
    isTrustedPublicRouterHost,
    normalizePublicRouterHost,
    parsePublicRouterHosts,
    readPublicRouterHosts,
    serializePublicRouterHosts,
};
