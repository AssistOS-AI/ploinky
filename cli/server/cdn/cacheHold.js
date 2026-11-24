import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { CONTROLLER_STATE_DIR } from '../../utils/config.js';
import { withEdgeGenerationApplyLock } from '../../sandbox/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../edgeRoutePlan.js';
import { normalizeManifestHttpRouteAccess } from '../policy/HttpRouteProviders.js';
import { parseAgentPortSelector } from '../agentPortConvention/parseSelector.js';
import { configuredCacheEntries } from './cachePurgeConfig.js';
import { purgeCacheHost } from './cachePurge.js';
import { setCacheHold } from './cacheSettingsStore.js';
export { isApplicationHeld } from './cacheSettings.js';

const changing = new Map();

function markedRoutes(generation) {
    const rows = [];
    for (const [routeKey, route] of Object.entries(generation.routing?.routes || {})) {
        if (route.disabled) continue;
        const agent = `${route.repo}/${route.agent}`;
        const raw = generation.manifests?.[routeKey]?.routerAccess?.httpRoutes;
        const specs = Array.isArray(raw) ? raw : Object.entries(raw || {}).map(([path, value]) => ({ path, ...value }));
        for (const spec of specs) {
            if (spec?.enabled === false || !['immutable', 'page'].includes(spec?.cache)) continue;
            const normalized = normalizeManifestHttpRouteAccess(spec, { routeKey });
            if (normalized.ok && normalized.access === 'public') {
                rows.push({ agent, routeKey, path: spec.path, cache: spec.cache, policyPath: normalized.path });
            }
        }
    }
    return rows;
}

export function markedApplications(generation) {
    const apps = new Map();
    for (const { agent, path, cache } of markedRoutes(generation)) {
        if (!apps.has(agent)) apps.set(agent, { agent, routes: [] });
        const { routes } = apps.get(agent);
        if (!routes.some(route => route.path === path && route.cache === cache)) routes.push({ path, cache });
    }
    return [...apps.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

function selectProbe(pages, hosts, generation, planRequest) {
    for (const { policyPath, routeKey } of pages) {
        // Wildcard marks can also cover their prefix; the origin must actually serve it.
        const canonical = policyPath.endsWith('/*') ? policyPath.slice(0, -1) : policyPath;
        const selector = parseAgentPortSelector(canonical);
        for (const host of hosts) {
            const root = generation.compiled.hosts[host].rootApplication;
            const path = selector && root?.routeKey === routeKey && root.port === selector.port
                ? selector.suffix : canonical;
            const plan = planRequest({ req: { url: path, method: 'GET', headers: { host } }, listener: 'public' });
            if (plan.ok && ['agent-port', 'agent-root'].includes(plan.kind) && plan.routeKey === routeKey
                && plan.canonicalPath === canonical && (plan.decision ?? plan.access)?.access === 'public'
                && plan.responsePolicy?.cacheClass === 'page') {
                return { host, path };
            }
        }
    }
    return null;
}

export function probeCacheOrigin({ host, path, publicPort = 8080 }, request = http.request) {
    return new Promise(resolve => {
        const req = request({
            hostname: '127.0.0.1', port: publicPort, method: 'GET', path, headers: { host },
            agent: false, signal: AbortSignal.timeout(5000),
        }, res => {
            resolve(res.statusCode === 200
                && res.headers['cloudflare-cdn-cache-control']?.trim().toLowerCase() === 'no-store');
            res.destroy();
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

export async function changeCacheHold({ op, agent, by, assertCurrent, publicPort = 8080, generation }, {
    dataDir = CONTROLLER_STATE_DIR, purge = purgeCacheHost, probe = probeCacheOrigin, planRequest = resolveEdgeRoutePlan,
    withConfigLock = withEdgeGenerationApplyLock,
} = {}) {
    if (op !== 'hold' && op !== 'release') throw new Error('invalid_request');
    // An overlapping release must never erase a newer hold while its purge is in flight.
    const operation = (changing.get(agent) ?? Promise.resolve()).then(async () => {
        assertCurrent();
        const routes = markedRoutes(generation).filter(row => row.agent === agent);
        if (!routes.length) throw new Error('unknown_application');
        if (op === 'hold') {
            await setCacheHold(agent, { since: new Date().toISOString(), by }, { dataDir, assertCurrent });
        }
        const scopeOptions = { dataDir, requirePublication: op === 'release' };
        const entries = configuredCacheEntries(generation, scopeOptions);
        const hosts = Object.keys(entries);
        const assertPurgeScope = () => {
            assertCurrent();
            if (!isDeepStrictEqual(configuredCacheEntries(generation, scopeOptions), entries)) {
                throw new Error('cache_purge_configuration_changed');
            }
        };
        const purges = await Promise.all(hosts.map(host => purge({
            host, by, generation, assertCurrent, expectedEntry: entries[host],
        }, { dataDir })));
        assertCurrent();
        let success = (op === 'release' || purges.length > 0) && purges.every(result => result.outcome === 'accepted');
        if (success && op === 'release') {
            // purge-config runs in a separate process. Hold its lock from the
            // last scope comparison through the settings store's atomic rename.
            await withConfigLock(() => setCacheHold(agent, null, { dataDir, assertCurrent: assertPurgeScope }));
        } else if (success) {
            const pages = routes.filter(row => row.cache === 'page');
            if (!pages.length) {
                assertPurgeScope();
                return { success, purges, probeSkipped: 'no_page_marks' };
            }
            const target = selectProbe(pages, hosts, generation, planRequest);
            success = Boolean(target) && await probe({ ...target, publicPort });
            assertPurgeScope();
        }
        assertCurrent();
        return { success, purges };
    });
    const tail = operation.catch(() => {});
    changing.set(agent, tail);
    try {
        return await operation;
    } finally {
        if (changing.get(agent) === tail) changing.delete(agent);
    }
}
