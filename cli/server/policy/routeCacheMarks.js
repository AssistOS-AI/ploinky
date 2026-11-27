import { HttpRouteAccessPath } from './HttpRouteAccessPath.js';
import { normalizeManifestHttpRouteAccess } from './HttpRouteProviders.js';
import { isRouteCacheClass, isRouteCacheMark } from './routeCacheMarkValues.js';

// Kept here for existing importers; the import-free definitions live in routeCacheMarkValues.js.
export { isRouteCacheClass, isRouteCacheMark };

// JSON object form uses the key as the path and also accepts an access string.
export function manifestHttpRouteSpecs(routes) {
    if (Array.isArray(routes)) return routes;
    return Object.entries(routes || {}).map(([path, value]) => (
        value && typeof value === 'object' && !Array.isArray(value)
            ? { path, ...value }
            : { path, access: String(value || '') }
    ));
}

// Enabled public entries of one manifest, one per normalized path. The result
// depends only on the manifest, so it is computed once per manifest object.
const baseByManifest = new WeakMap();

function manifestEntries(manifest, routeKey) {
    const byKey = manifest !== null && typeof manifest === 'object' ? baseByManifest.get(manifest) : undefined;
    if (byKey?.has(routeKey)) return byKey.get(routeKey);
    const entries = [];
    const seen = new Set();
    for (const spec of manifestHttpRouteSpecs(manifest?.routerAccess?.httpRoutes)) {
        if (spec?.enabled === false) continue;
        const entry = normalizeManifestHttpRouteAccess(spec, { routeKey });
        if (!entry.ok || entry.access !== 'public' || seen.has(entry.path)) continue;
        seen.add(entry.path);
        entries.push(Object.freeze({
            routeKey,
            path: entry.path,
            wildcard: entry.path.endsWith('/*'),
            mark: isRouteCacheMark(spec?.cache) ? spec.cache : null,
            publicProtocol: Boolean(entry.publicProtocol),
        }));
    }
    Object.freeze(entries);
    if (manifest !== null && typeof manifest === 'object') {
        if (!byKey) baseByManifest.set(manifest, new Map([[routeKey, entries]]));
        else byKey.set(routeKey, entries);
    }
    return entries;
}

// The manifests of one application (repo/agent): every enabled route that belongs to it.
export function applicationManifests(generation, agent) {
    const parts = [];
    for (const [routeKey, route] of Object.entries(generation?.routing?.routes || {})) {
        if (!route || route.disabled || `${route.repo}/${route.agent}` !== agent) continue;
        parts.push({ routeKey, manifest: generation.manifests?.[routeKey] });
    }
    return parts;
}

export function hasCacheMark(parts) {
    return parts.some(({ manifest, routeKey }) => manifestEntries(manifest, routeKey).some(entry => entry.mark !== null));
}

function underNever(entry, neverWildcards) {
    const core = entry.wildcard ? entry.path.slice(0, -2) : entry.path;
    let covering = null;
    for (const wildcard of neverWildcards) {
        if (wildcard.path !== entry.path && HttpRouteAccessPath.matches(core, wildcard.path)
            && (!covering || wildcard.path.length > covering.path.length)) covering = wildcard;
    }
    return covering?.path ?? null;
}

// The one place that decides which class a public entry has. `parts` lists the
// application's manifests, `records` holds its administrator route settings
// (normalized path -> record). Per entry, in order:
//   1. `never`, or under a `never` wildcard of the application: no caching;
//   2. a bound administrator `off`: none;
//   3. a manifest `page` or `immutable` mark: that mark;
//   4. a bound administrator `page`, the application has a `never` mark and
//      the entry is not publicProtocol: `page`;
//   5. otherwise none.
// A setting is bound only when the application lists, the entry exists, its
// recorded access and mark equal the current ones, it is not `never`, and for
// `page` the rule 4 conditions hold. Any other setting is stale and never applies.
export function cacheOverlay({ parts, records }) {
    const base = parts.flatMap(({ manifest, routeKey }) => manifestEntries(manifest, routeKey));
    const seen = new Set();
    const unique = base.filter(entry => !seen.has(entry.path) && seen.add(entry.path));
    const hasCache = unique.some(entry => entry.mark !== null);
    const hasNever = unique.some(entry => entry.mark === 'never');
    const neverWildcards = unique.filter(entry => entry.mark === 'never' && entry.wildcard);
    const settings = records !== null && typeof records === 'object' ? records : {};
    const boundPaths = new Set();
    const entries = unique.map(entry => {
        const neverBy = entry.mark === 'never' ? null : underNever(entry, neverWildcards);
        const record = Object.hasOwn(settings, entry.path) ? settings[entry.path] : null;
        const bound = record !== null && hasCache && neverBy === null && entry.mark !== 'never'
            && record.entry?.access === 'public' && record.entry.manifest === entry.mark
            && (record.setting === 'off' || (record.setting === 'page' && hasNever && !entry.publicProtocol));
        if (bound) boundPaths.add(entry.path);
        let effective = null;
        let source = null;
        if (entry.mark === 'never' || neverBy !== null) source = 'never';
        else if (bound && record.setting === 'off') source = 'off';
        else if (entry.mark !== null) [effective, source] = [entry.mark, 'manifest'];
        else if (bound && record.setting === 'page') [effective, source] = ['page', 'administrator'];
        return { ...entry, neverBy, record, bound, effective, source };
    });
    const stale = Object.keys(settings).filter(path => !boundPaths.has(path)).sort()
        .map(path => ({ path, record: settings[path] }));
    return { entries, stale, hasCache, hasNever };
}

// Exact entry first, otherwise the longest wildcard; an exact unmarked entry
// shadows a wildcard mark. Returns the overlay entry or null.
export function matchOverlayEntry(overlay, requestPath) {
    let found = null;
    let longestWildcard = -1;
    for (const entry of overlay.entries) {
        if (!HttpRouteAccessPath.matches(requestPath, entry.path)) continue;
        if (!entry.wildcard) return entry;
        if (entry.path.length > longestWildcard) {
            longestWildcard = entry.path.length;
            found = entry;
        }
    }
    return found;
}

// Manifest-only class, as the Router plan records it (no administrator settings).
export function resolveRouteCacheClass({ manifest, routeKey, requestPath, access }) {
    if (access !== 'public') return null;
    const overlay = cacheOverlay({ parts: [{ manifest, routeKey }], records: null });
    return matchOverlayEntry(overlay, requestPath)?.effective ?? null;
}
