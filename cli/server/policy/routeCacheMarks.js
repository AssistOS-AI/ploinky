import { HttpRouteAccessPath } from './HttpRouteAccessPath.js';
import { normalizeManifestHttpRouteAccess } from './HttpRouteProviders.js';

export function isRouteCacheClass(value) {
    return value === 'page' || value === 'immutable';
}

// JSON object form uses the key as the path and also accepts an access string.
export function manifestHttpRouteSpecs(routes) {
    if (Array.isArray(routes)) return routes;
    return Object.entries(routes || {}).map(([path, value]) => (
        value && typeof value === 'object' && !Array.isArray(value)
            ? { path, ...value }
            : { path, access: String(value || '') }
    ));
}

export function resolveRouteCacheClass({ manifest, routeKey, requestPath, access }) {
    if (access !== 'public') return null;

    let longestWildcard = -1;
    let cacheClass = null;
    for (const spec of manifestHttpRouteSpecs(manifest?.routerAccess?.httpRoutes)) {
        if (spec?.enabled === false) continue;
        const entry = normalizeManifestHttpRouteAccess(spec, { routeKey });
        if (!entry.ok || entry.access !== 'public' || !HttpRouteAccessPath.matches(requestPath, entry.path)) continue;

        const mark = isRouteCacheClass(spec.cache) ? spec.cache : null;
        if (!entry.path.endsWith('/*')) return mark;
        if (entry.path.length > longestWildcard) {
            longestWildcard = entry.path.length;
            cacheClass = mark;
        }
    }
    return cacheClass;
}
