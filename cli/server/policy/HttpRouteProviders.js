import { hasInternalAgentSegment } from '../internalAgentPath.js';
import { normalizeHttpRouteAccess } from './HttpRouteAccessDecision.js';
import { HttpRouteAccessPath } from './HttpRouteAccessPath.js';

function asRouteSpecs(route) {
    const routes = route?.routerAccess?.httpRoutes || route?.manifest?.routerAccess?.httpRoutes;
    if (!routes) return [];
    if (Array.isArray(routes)) return routes;
    if (typeof routes === 'object') {
        return Object.entries(routes).map(([key, value]) => (
            value && typeof value === 'object'
                ? { path: key, ...value }
                : { path: key, access: String(value || '') }
        ));
    }
    return [];
}

export function normalizeManifestHttpRouteAccess(spec, { routeKey } = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    if (!normalizedRouteKey) return { ok: false, code: 'INVALID_ROUTE_KEY', error: 'routeKey is required' };
    if (Object.prototype.hasOwnProperty.call(spec || {}, 'mode')) {
        return { ok: false, code: 'INVALID_FIELD', error: 'routerAccess.httpRoutes entries must use access, not mode' };
    }
    const hasAccess = Object.prototype.hasOwnProperty.call(spec || {}, 'access');
    const access = hasAccess ? normalizeHttpRouteAccess(spec?.access) : 'authenticated';
    if (!access) return { ok: false, code: 'INVALID_ACCESS', error: 'access must be public, guest, or authenticated' };

    const rawPath = String(spec?.path || '').trim();
    const agentRelativePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    if (agentRelativePath === '/' || agentRelativePath === '/*') {
        return { ok: false, code: 'INVALID_PATH', error: 'root path cannot be declared public, guest, or authenticated' };
    }
    if (hasInternalAgentSegment(agentRelativePath)) {
        return { ok: false, code: 'INTERNAL_ROUTE_NOT_ALLOWED', error: 'internal route cannot be declared public, guest, or authenticated' };
    }
    const expandedPath = `/${encodeURIComponent(normalizedRouteKey)}${agentRelativePath}`;
    const normalized = HttpRouteAccessPath.normalize(expandedPath);
    if (!normalized.ok) return normalized;
    return { ok: true, path: normalized.path, access, routeKey: normalizedRouteKey, source: 'manifest' };
}

export function collectManifestHttpRouteAccess(routes = {}) {
    const entries = [];
    for (const [routeKey, route] of Object.entries(routes || {})) {
        if (!route || route.disabled) continue;
        for (const spec of asRouteSpecs(route)) {
            const normalized = normalizeManifestHttpRouteAccess(spec, { routeKey });
            if (!normalized.ok) continue;
            entries.push({
                path: normalized.path,
                access: normalized.access,
                routeKey: normalized.routeKey,
                source: 'manifest',
            });
        }
    }
    return entries;
}

const manifestRouteCache = { routes: null, entries: [] };

export function createManifestRouteProvider(loadRoutes) {
    return () => {
        const routes = loadRoutes() || {};
        if (manifestRouteCache.routes !== routes) {
            manifestRouteCache.routes = routes;
            manifestRouteCache.entries = collectManifestHttpRouteAccess(routes);
        }
        return manifestRouteCache.entries;
    };
}

export function createHttpServiceProvider(collectServices) {
    return () => (collectServices() || []).map((definition) => ({
        externalPrefix: definition.externalPrefix,
        access: definition.access,
        routeKey: definition.routeKey,
        guestScope: definition.guestScope,
        source: 'httpService',
    }));
}
