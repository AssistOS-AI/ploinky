import { parseAgentPortSelector } from '../agentPortConvention/parseSelector.js';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

// Public protocol servers authenticate their own clients and browser actions.
// This opt-in belongs only to an admitted, agent-owned manifest namespace.
export function normalizePublicProtocol(value, { access, source, path, routeKey } = {}) {
    if (value === undefined) return undefined;
    const fail = message => { throw new Error(`publicProtocol ${message}`); };
    if (source !== 'manifest' || access !== 'public') fail('requires a public manifest route');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
    if (Object.keys(value).some(key => !['methods', 'allowLoopbackRedirects', 'allowCors'].includes(key))) {
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
    let selector;
    try { selector = parseAgentPortSelector(String(path || '').replace(/\*$/, '')); } catch (_) { /* rejected below */ }
    if (!selector || selector.agent !== routeKey || !selector.suffix || selector.suffix === '/') {
        fail('requires an owned agent-port path below the service root');
    }
    return {
        methods: [...value.methods].sort(),
        allowLoopbackRedirects: value.allowLoopbackRedirects === true,
        allowCors: value.allowCors === true,
    };
}

export function isPublicMethodAllowed(decision, method) {
    const normalized = String(method || 'GET').toUpperCase();
    return decision.publicProtocol
        ? decision.publicProtocol.methods.includes(normalized)
        : normalized === 'GET' || normalized === 'HEAD';
}
