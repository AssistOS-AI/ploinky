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

function decisionForEntry(entry, source) {
    const access = normalizeHttpRouteAccess(entry?.access);
    if (!access || entry?.enabled === false) return null;
    const path = accessPathForEntry(entry);
    const normalized = HttpRouteAccessPath.normalize(path);
    if (!normalized.ok) return null;
    return {
        path: normalized.path,
        access,
        routeKey: String(entry.routeKey || HttpRouteAccessPath.routeKeyForPath(normalized.path)),
        source: String(entry.source || source),
        // The guest executor needs the service-declared scope when it creates
        // a guest identity for this service route.
        ...(entry.guestScope ? { guestScope: String(entry.guestScope) } : {}),
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

    evaluate({ pathname, method = 'GET', routeKey = '', surfaceKind = '' } = {}) {
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
            decision = surfaceKind === 'agent-port-convention'
                ? {
                    access: 'authenticated',
                    routeKey: derivedRouteKey,
                    source: 'agentPortConventionDefault',
                }
                : this._routeDefaultProvider({ pathname: requestPath, method, routeKey: derivedRouteKey }) || noHttpRouteAccess();
        }

        return applyPublicWriteGuard(decision, method);
    }

    *_iterPolicyEntries() {
        const loaded = this._repo?.listHttpRoutes?.() || { corrupt: false, entries: [] };
        if (!loaded.corrupt) {
            for (const entry of loaded.entries || []) {
                const normalized = decisionForEntry(entry, 'policy');
                if (normalized) yield normalized;
            }
        }
        for (const entry of this._manifestRouteProvider() || []) {
            const normalized = decisionForEntry(entry, 'manifest');
            if (normalized) yield normalized;
        }
        for (const entry of this._httpServiceProvider() || []) {
            const normalized = decisionForEntry(entry, 'httpService');
            if (normalized) yield normalized;
        }
    }
}

export default HttpRouteAccessPolicy;
