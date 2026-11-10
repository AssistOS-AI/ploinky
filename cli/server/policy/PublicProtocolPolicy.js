import { parseAgentPortSelector } from '../agentPortConvention/parseSelector.js';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

// Every allowCors protocol route may admit these request headers when the
// provider advertises them. A manifest can add a few application headers with
// allowHeaders, but never credentials or names the Router strips or owns.
const BASE_CORS_ALLOW_HEADERS = Object.freeze(['authorization', 'content-type']);
const MAX_ALLOW_HEADERS = 8;
const ALLOW_HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DENIED_ALLOW_HEADERS = new Set([
    'authorization', 'cookie', 'host', 'content-length', 'forwarded', 'x-csrf-token',
    'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const DENIED_ALLOW_HEADER_PREFIXES = ['x-ploinky-', 'x-forwarded-', 'proxy-', 'sec-'];

function normalizeAllowHeaders(value, fail) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_ALLOW_HEADERS) {
        fail(`allowHeaders must be a non-empty list of at most ${MAX_ALLOW_HEADERS} header names`);
    }
    const names = value.map((name) => {
        const normalized = typeof name === 'string' ? name.toLowerCase() : '';
        if (!ALLOW_HEADER_NAME.test(normalized)) fail('allowHeaders entries must be plain header names');
        if (DENIED_ALLOW_HEADERS.has(normalized)
            || DENIED_ALLOW_HEADER_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
            fail(`allowHeaders cannot admit '${normalized}'`);
        }
        return normalized;
    });
    if (new Set(names).size !== names.length) fail('allowHeaders must not repeat a header name');
    return names.sort();
}

// Public protocol servers authenticate their own clients and browser actions.
// This opt-in belongs only to an admitted, agent-owned manifest namespace.
export function normalizePublicProtocol(value, { access, source, path, routeKey } = {}) {
    if (value === undefined) return undefined;
    const fail = message => { throw new Error(`publicProtocol ${message}`); };
    if (source !== 'manifest' || access !== 'public') fail('requires a public manifest route');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
    if (Object.keys(value).some(key => !['methods', 'allowLoopbackRedirects', 'allowCors', 'allowHeaders'].includes(key))) {
        fail('contains an unsupported field');
    }
    if (!Array.isArray(value.methods) || !value.methods.length
        || value.methods.some(method => !METHODS.has(method))
        || new Set(value.methods).size !== value.methods.length) {
        fail('methods must be a non-empty unique list of GET, HEAD, POST, OPTIONS');
    }
    for (const key of ['allowLoopbackRedirects', 'allowCors']) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${key} must be a boolean`);
    }
    let allowHeaders;
    if (value.allowHeaders !== undefined) {
        if (value.allowCors !== true || !value.methods.includes('OPTIONS')) {
            fail('allowHeaders requires allowCors and the OPTIONS method');
        }
        allowHeaders = normalizeAllowHeaders(value.allowHeaders, fail);
    }
    let selector;
    try { selector = parseAgentPortSelector(String(path || '').replace(/\*$/, '')); } catch (_) { /* rejected below */ }
    if (!selector || selector.agent !== routeKey || !selector.suffix || selector.suffix === '/') {
        fail('requires an owned agent-port path below the service root');
    }
    // allowHeaders appears only when declared, so a route without it compiles
    // exactly as before and saved generations keep verifying.
    return {
        methods: [...value.methods].sort(),
        allowLoopbackRedirects: value.allowLoopbackRedirects === true,
        allowCors: value.allowCors === true,
        ...(allowHeaders ? { allowHeaders } : {}),
    };
}

// The request headers a CORS response on this route may admit. The response
// sanitizer still keeps only the ones the provider itself advertises.
export function publicProtocolCorsAllowHeaders(publicProtocol) {
    return [...BASE_CORS_ALLOW_HEADERS, ...(publicProtocol?.allowHeaders || [])];
}

export function isPublicMethodAllowed(decision, method) {
    const normalized = String(method || 'GET').toUpperCase();
    return decision.publicProtocol
        ? decision.publicProtocol.methods.includes(normalized)
        : normalized === 'GET' || normalized === 'HEAD';
}
