import fs from 'node:fs';
import path from 'node:path';

import { resolveEnabledAgentRecord } from '../../services/agents.js';
import { findAgent } from '../../services/utils.js';
import { hasInternalAgentSegment } from '../internalAgentPath.js';
import { normalizeHttpRouteAccess } from './HttpRouteAccessDecision.js';
import { HttpRouteAccessPath } from './HttpRouteAccessPath.js';

function readJsonFileIfExists(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

export function getManifestHttpRouteManifestPath(routeKey, route = {}) {
    const hostPath = String(route?.hostPath || '').trim();
    if (hostPath) return path.join(hostPath, 'manifest.json');

    let resolved = null;
    try {
        resolved = resolveEnabledAgentRecord(String(routeKey || '').trim());
    } catch (_) {
        resolved = null;
    }
    const record = resolved?.record || null;
    if (!record?.repoName || !record?.agentName) return '';

    try {
        const found = findAgent(`${record.repoName}/${record.agentName}`);
        return String(found?.manifestPath || '');
    } catch (_) {
        return '';
    }
}

function asRouteSpecs(manifest) {
    const routes = manifest?.routerAccess?.httpRoutes;
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
        const manifest = readJsonFileIfExists(getManifestHttpRouteManifestPath(routeKey, route));
        if (!manifest) continue;
        for (const spec of asRouteSpecs(manifest)) {
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

const manifestRouteCache = { key: '', entries: [] };

function manifestFileCacheStamp(routeKey, route = {}) {
    const manifestPath = getManifestHttpRouteManifestPath(routeKey, route);
    if (!manifestPath) return '';
    try {
        const stats = fs.statSync(manifestPath);
        return `${stats.mtimeMs}:${stats.size}`;
    } catch (_) {
        return '';
    }
}

function manifestRouteCacheKey(routes = {}) {
    return JSON.stringify(Object.entries(routes || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([routeKey, route]) => [
            routeKey,
            route?.disabled === true,
            String(route?.hostPath || ''),
            String(route?.hostPort || ''),
            manifestFileCacheStamp(routeKey, route),
        ]));
}

export function createManifestRouteProvider(loadRoutes) {
    return () => {
        const routes = loadRoutes() || {};
        const key = manifestRouteCacheKey(routes);
        if (manifestRouteCache.key !== key) {
            manifestRouteCache.key = key;
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
