import { HttpRouteAccessPath } from './HttpRouteAccessPath.js';
import {
    noHttpRouteAccess,
    normalizeHttpRouteAccess,
    moreRestrictiveHttpRouteDecision,
} from './HttpRouteAccessDecision.js';

function unroutableDecision() {
    return { access: 'deny', status: 404, code: 'UNROUTABLE_PATH', routeKey: '', source: 'policy' };
}

function providersUnboundDecision() {
    return { access: 'deny', status: 503, code: 'POLICY_PROVIDERS_UNBOUND', routeKey: '', source: 'policy' };
}

function normalizedRequest(pathname) {
    const normalized = HttpRouteAccessPath.normalize(pathname, { allowWildcard: false });
    return normalized.ok ? normalized.path : '';
}

function accessPathForEntry(entry) {
    if (entry?.externalPrefix) {
        const prefix = String(entry.externalPrefix || '').trim().replace(/\/+$/g, '');
        return prefix ? `${prefix}/*` : '';
    }
    return String(entry?.path || '').trim();
}

function invalidEntry(strict, label, message) {
    if (!strict) return null;
    const error = new Error(`${label}: ${message}`);
    error.code = 'HTTP_ROUTE_POLICY_INVALID';
    throw error;
}

export function normalizeHttpRoutePolicyEntry(entry, source, {
    strict = false,
    label = `${source || 'policy'} entry`,
} = {}) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return invalidEntry(strict, label, 'entry must be an object');
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        return invalidEntry(strict, label, 'enabled must be a boolean when present');
    }
    const access = normalizeHttpRouteAccess(entry?.access);
    if (!access) return invalidEntry(strict, label, 'access must be public, guest, or authenticated');
    const path = accessPathForEntry(entry);
    const normalized = HttpRouteAccessPath.normalize(path);
    if (!normalized.ok) return invalidEntry(strict, label, normalized.error || 'path is invalid');
    const explicitRouteKey = entry.routeKey;
    if (explicitRouteKey !== undefined && (typeof explicitRouteKey !== 'string' || !explicitRouteKey.trim())) {
        return invalidEntry(strict, label, 'routeKey must be a non-empty string when present');
    }
    const routeKey = String(explicitRouteKey || HttpRouteAccessPath.routeKeyForPath(normalized.path)).trim();
    if (!routeKey) return invalidEntry(strict, label, 'routeKey could not be derived');
    const guestScope = entry.guestScope === undefined ? '' : String(entry.guestScope || '').trim();
    if (entry.guestScope !== undefined && (typeof entry.guestScope !== 'string' || !guestScope)) {
        return invalidEntry(strict, label, 'guestScope must be a non-empty string when present');
    }
    if (entry?.enabled === false) return null;
    return {
        path: normalized.path,
        access,
        routeKey,
        source: String(entry.source || source),
        // The guest executor needs the service-declared scope when it creates
        // a guest identity for this service route.
        ...(guestScope ? { guestScope } : {}),
    };
}

function applyPublicWriteGuard(decision, method) {
    if (decision.access === 'public' && !HttpRouteAccessPath.isReadOnlyMethod(method)) {
        return {
            access: 'deny',
            status: 403,
            code: 'PUBLIC_ROUTE_WRITE_DENIED',
            routeKey: decision.routeKey,
            source: decision.source,
        };
    }
    return decision;
}

export class HttpRouteAccessPolicy {
    // Providers may be passed at construction (unit tests) or bound exactly
    // once at server init via bindProviders() (RoutingServer owns runtime
    // wiring; policy/index.js must not import routerHandlers.js because that
    // would be a circular import). evaluate() fails closed with a deny decision
    // while any provider is unbound, so a wiring mistake can never silently
    // drop manifest or service declarations and fall through to a weaker
    // default.
    constructor({
        repository,
        manifestRouteProvider = null,
        httpServiceProvider = null,
        routeDefaultProvider = null,
    }) {
        this._repo = repository;
        this._manifestRouteProvider = manifestRouteProvider;
        this._httpServiceProvider = httpServiceProvider;
        this._routeDefaultProvider = routeDefaultProvider;
    }

    bindProviders({ manifestRouteProvider, httpServiceProvider, routeDefaultProvider }) {
        if (this._manifestRouteProvider || this._httpServiceProvider || this._routeDefaultProvider) {
            throw new Error('HttpRouteAccessPolicy: providers are already bound');
        }
        if (typeof manifestRouteProvider !== 'function'
            || typeof httpServiceProvider !== 'function'
            || typeof routeDefaultProvider !== 'function') {
            throw new Error('HttpRouteAccessPolicy: all three providers are required');
        }
        this._manifestRouteProvider = manifestRouteProvider;
        this._httpServiceProvider = httpServiceProvider;
        this._routeDefaultProvider = routeDefaultProvider;
    }

    hasProviders() {
        return Boolean(this._manifestRouteProvider && this._httpServiceProvider && this._routeDefaultProvider);
    }

    evaluate({ pathname, method = 'GET', routeKey = '' } = {}) {
        if (!this.hasProviders()) return providersUnboundDecision();

        const requestPath = normalizedRequest(pathname);
        if (!requestPath) return unroutableDecision();

        let decision = noHttpRouteAccess();
        for (const entry of this._iterPolicyEntries()) {
            if (!HttpRouteAccessPath.matches(requestPath, entry.path)) continue;
            decision = moreRestrictiveHttpRouteDecision(decision, entry);
        }

        if (decision.access === 'none') {
            const derivedRouteKey = routeKey || HttpRouteAccessPath.routeKeyForPath(requestPath);
            decision = this._routeDefaultProvider({ pathname: requestPath, method, routeKey: derivedRouteKey }) || noHttpRouteAccess();
        }

        return applyPublicWriteGuard(decision, method);
    }

    *_iterPolicyEntries() {
        const loaded = this._repo?.listHttpRoutes?.() || { corrupt: false, entries: [] };
        if (!loaded.corrupt) {
            for (const entry of loaded.entries || []) {
                const normalized = normalizeHttpRoutePolicyEntry(entry, 'policy');
                if (normalized) yield normalized;
            }
        }
        for (const entry of this._manifestRouteProvider() || []) {
            const normalized = normalizeHttpRoutePolicyEntry(entry, 'manifest');
            if (normalized) yield normalized;
        }
        for (const entry of this._httpServiceProvider() || []) {
            const normalized = normalizeHttpRoutePolicyEntry(entry, 'httpService');
            if (normalized) yield normalized;
        }
    }
}

export default HttpRouteAccessPolicy;
