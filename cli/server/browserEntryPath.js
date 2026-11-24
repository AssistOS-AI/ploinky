import { HttpRouteAccessPath } from './policy/HttpRouteAccessPath.js';
import { normalizeManifestHttpRouteAccess } from './policy/HttpRouteProviders.js';

// Static agents keep their existing index route. Server applications explicitly
// declare an owned, admitted browser entry in the generation's manifest.
export function resolveBrowserEntryPath(routeKey, manifest = {}) {
    const value = manifest?.routerAccess?.entryPath;
    if (value === undefined) return `/${encodeURIComponent(routeKey)}/index.html`;
    const normalized = HttpRouteAccessPath.normalize(value, { allowWildcard: false });
    if (!normalized.ok || normalized.path !== value || /[?#%]/.test(value)) {
        throw new Error('routerAccess.entryPath must be an exact router-relative route path');
    }
    const raw = manifest.routerAccess.httpRoutes;
    const specs = Array.isArray(raw) ? raw : Object.entries(raw || {}).map(([routePath, spec]) => (
        spec && typeof spec === 'object' ? { path: routePath, ...spec } : { path: routePath, access: spec }
    ));
    const owned = normalizeManifestHttpRouteAccess({ path: value }, { routeKey });
    if (!owned.ok || owned.path !== value || !specs.some(spec => {
        if (spec?.enabled === false) return false;
        const route = normalizeManifestHttpRouteAccess(spec, { routeKey });
        return route.ok && HttpRouteAccessPath.matches(value, route.path);
    })) {
        throw new Error('routerAccess.entryPath must name an enabled HTTP route owned by the agent');
    }
    return value;
}
