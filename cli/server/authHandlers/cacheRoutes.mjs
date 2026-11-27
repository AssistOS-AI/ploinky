import { hasHardwareBearer } from './hardwareLimitsRoutes.mjs';
import { isSessionRevoked } from '../auth/sessionRevocations.js';
import { readEdgeRoutingSelection } from '../../sandbox/edgeGeneration.js';
import { cachePublishedHosts, configuredCacheHosts } from '../cdn/cachePurgeConfig.js';
import { isApplicationHeld, markedApplications, routeOrigin } from '../cdn/cacheHold.js';
import { readCacheSettings, setCacheApplication, setCacheRoute, validCacheApplication, validCachePath } from '../cdn/cacheSettingsStore.js';
import { purgeCacheHost, readLastPurge } from '../cdn/cachePurge.js';
import { applicationOverlay, publicRouteRows } from '../cdn/cacheRouteModel.js';
import { applicationCacheState } from '../cdn/cacheSettings.js';
import { checkCacheRoute, takeCheckSlot } from '../cdn/cacheCheck.js';
import { resolveEdgeRoutePlan } from '../edgeRoutePlan.js';

const routeSettingValues = ['off', 'page', 'default'];

function validRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (body.op === 'purge') return Object.keys(body).length === 2 && typeof body.host === 'string' && body.host.length > 0;
    if (body.op === 'route' || body.op === 'check') {
        return Object.keys(body).length === (body.op === 'route' ? 4 : 3)
            && typeof body.agent === 'string' && body.agent.length > 0 && validCachePath(body.path)
            && (body.op === 'check' || routeSettingValues.includes(body.setting));
    }
    return body.op === 'set' && Object.keys(body).length === 4
        && typeof body.agent === 'string' && body.agent.length > 0
        && validCacheApplication(body);
}

// The off switch must not depend on the purge side: for reads and settings an
// unreadable purge configuration counts as no configured host, logged once by code.
let purgeConfigWarned = false;
function configuredHosts(listConfigured, generation, published, strict) {
    try {
        const hosts = listConfigured(generation).filter(host => published.includes(host));
        purgeConfigWarned = false;
        return hosts;
    } catch (error) {
        if (strict) throw error;
        if (!purgeConfigWarned) console.warn('cache_purge_config_unreadable');
        purgeConfigWarned = true;
        return [];
    }
}

function applicationEntry({ agent, routes }, settings, hosts, generation, getCanaryHold, checkable) {
    const { enabled, pageSeconds } = settings.applications[agent] || { enabled: false, pageSeconds: 300 };
    const hold = settings.held[agent] || (isApplicationHeld(agent, { generation, settings }) ? getCanaryHold() : null);
    const overlay = applicationOverlay(generation, agent, settings);
    return { agent, enabled, pageSeconds, held: hold ? { since: hold.since, by: hold.by } : null,
        routes: routes.map(({ path, cache }) => ({ path, cache })), hosts,
        adminChoices: overlay.hasNever,
        publicRoutes: publicRouteRows(overlay, settings, agent, generation, checkable) };
}

// True when the application could have been cached before a write: its switch was
// on and some route's class was immutable, or page while the application was not held.
function couldHaveCached(agent, settings, generation, only) {
    const state = applicationCacheState(agent, settings, generation);
    if (!state.enabled) return false;
    return applicationOverlay(generation, agent, settings).entries.some(entry =>
        (only === undefined || entry.path === only)
        && (entry.effective === 'immutable' || (entry.effective === 'page' && !state.held)));
}

export async function handleCacheRoutes(req, res, parsedUrl, {
    routePlan, ensureAdmin, verifyMutation, readBody, readSelection = readEdgeRoutingSelection,
    listPublished = cachePublishedHosts, listConfigured = configuredCacheHosts, listMarked = markedApplications,
    readSettings = readCacheSettings, setApplication = setCacheApplication, lastPurge = readLastPurge, purge = purgeCacheHost,
    setRoute = setCacheRoute, planRequest = resolveEdgeRoutePlan, checkOrigin = checkCacheRoute,
    checkSlot = takeCheckSlot, publicPort = 8080,
}) {
    const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
        return true;
    };
    if (hasHardwareBearer(req)) return send(403, { ok: false, error: 'agent_forbidden' });
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') return send(405, { ok: false, error: 'method_not_allowed' });
    if (!await ensureAdmin(req, res, parsedUrl)) return true;

    const lease = routePlan?.lease;
    const generation = lease?.snapshot;
    const stale = new Error('edge_generation_changed');
    const denied = new Error('csrf_invalid');
    const assertCurrent = () => {
        if (!generation || (routePlan.snapshot && routePlan.snapshot !== generation) || lease.commit?.() !== true) throw stale;
        if (method === 'POST') {
            const signed = req.session?._jwtPayload;
            if ((req.session?.expiresAt && Date.now() >= req.session.expiresAt) || (signed?.exp && Date.now() / 1000 >= signed.exp)
                || isSessionRevoked({ sid: signed?.sid || req.sessionId, jti: signed?.jti })) throw denied;
            const decision = verifyMutation(req);
            if (decision?.ok !== true) {
                denied.message = String(decision?.code || 'csrf_invalid').toLowerCase();
                throw denied;
            }
        }
    };
    const success = body => {
        assertCurrent();
        return send(200, body);
    };
    let canaryHold;
    const getCanaryHold = () => {
        if (canaryHold) return canaryHold;
        const selector = readSelection()?.selector;
        if (selector?.state !== 'active' || !lease.id || lease.id !== generation.generation || selector.generation !== lease.id
            || !lease.activationId || selector.activationId !== lease.activationId) throw stale;
        const since = selector.activatedAt;
        if (typeof since !== 'string' || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString() !== since) throw stale;
        canaryHold = { since, by: 'canary' };
        return canaryHold;
    };
    try {
        assertCurrent();
        let body;
        if (method === 'POST') {
            try { body = await readBody(req); } catch { return send(400, { error: 'invalid_request' }); }
            if (!validRequest(body)) return send(400, { error: 'invalid_request' });
            assertCurrent();
        }
        const published = listPublished(generation);
        const configuredFor = strict => configuredHosts(listConfigured, generation, published, strict);
        // Whether the check operation can reach this exact route through a published host.
        const checkable = entry => {
            try {
                return routeOrigin({ policyPath: entry.path, routeKey: entry.routeKey }, published, generation, planRequest) !== null;
            } catch {
                return false;
            }
        };
        if (method === 'GET') {
            const settings = readSettings();
            const configured = configuredFor(false);
            const applications = listMarked(generation)
                .map(mark => applicationEntry(mark, settings, configured, generation, getCanaryHold, checkable));
            const hosts = published.map(host => {
                const record = lastPurge(host);
                return { host, purgeConfigured: configured.includes(host),
                    lastPurge: record ? { at: record.at, by: record.by, outcome: record.outcome } : null };
            });
            return success({ applications, hosts });
        }
        const by = String(req.user?.id || req.user?.username || 'admin').slice(0, 256);
        const clear = host => purge({ host, by, generation, assertCurrent });
        if (body.op === 'purge') {
            if (!configuredFor(true).includes(body.host)) return send(404, { error: 'unknown_host' });
            const { host, outcome, retryAfterSeconds } = await clear(body.host);
            return success({ purge: { host, outcome, ...(outcome === 'cooldown' ? { retryAfterSeconds } : {}) } });
        }
        const app = listMarked(generation).find(({ agent }) => agent === body.agent);
        const purgeConfigured = async () => {
            const purges = [];
            for (const host of configuredFor(false)) {
                const { outcome } = await clear(host);
                purges.push({ host, outcome });
            }
            return purges;
        };
        if (body.op === 'check') {
            if (body.path.endsWith('/*')) return send(400, { error: 'wildcard_path' });
            const row = app && applicationOverlay(generation, body.agent, readSettings()).entries
                .find(entry => entry.path === body.path);
            if (!row) return send(404, { error: 'unknown_route' });
            const target = routeOrigin({ policyPath: row.path, routeKey: row.routeKey }, published, generation, planRequest);
            if (!target) return send(409, { error: 'no_published_host' });
            if (!checkSlot(String(req.sessionId || by))) return send(429, { error: 'rate_limited', retryAfterSeconds: 1 });
            const { status, cdnHeader, cacheControl } = await checkOrigin({ ...target, publicPort });
            return success({ check: { host: target.host, path: target.path, status, cdnHeader, cacheControl } });
        }
        if (!app) return send(404, { error: 'unknown_application' });
        if (body.op === 'route') {
            const before = structuredClone(readSettings());
            const overlay = applicationOverlay(generation, body.agent, before);
            let record = null;
            if (body.setting !== 'default') {
                const row = overlay.entries.find(entry => entry.path === body.path);
                if (!row) return send(404, { error: 'unknown_route' });
                if (row.mark === 'never' || row.neverBy !== null) return send(400, { error: 'route_never' });
                if (body.setting === 'off' && row.effective === null) return send(400, { error: 'route_uncached' });
                if (body.setting === 'page') {
                    if (row.mark !== null) return send(400, { error: 'route_marked' });
                    if (!overlay.hasNever || row.publicProtocol) return send(400, { error: 'route_not_choosable' });
                }
                record = { setting: body.setting, at: new Date().toISOString(), by,
                    entry: { access: 'public', manifest: row.mark } };
            }
            const result = await setRoute(body.agent, body.path, record, { assertCurrent });
            // The state the write was computed from: the old record decides what the write removed.
            const prior = result.before ?? before;
            const removedCaching = result.changed !== false && couldHaveCached(body.agent, prior, generation, body.path)
                && (body.setting === 'off'
                    || (body.setting === 'default' && applicationOverlay(generation, body.agent, prior).entries
                        .some(entry => entry.path === body.path && entry.source === 'administrator')));
            const purges = removedCaching ? await purgeConfigured() : [];
            return success({ application: applicationEntry(app, result.settings, configuredFor(false), generation, getCanaryHold, checkable),
                purges });
        }
        const prior = structuredClone(readSettings());
        const result = await setApplication(body.agent, { enabled: body.enabled, pageSeconds: body.pageSeconds }, { assertCurrent });
        const configured = configuredFor(false);
        const purges = result.previous.enabled && !body.enabled && couldHaveCached(body.agent, result.before ?? prior, generation)
            ? await purgeConfigured() : [];
        return success({ application: applicationEntry(app, result.settings, configured, generation, getCanaryHold, checkable), purges });
    } catch (error) {
        if (error === stale) return send(503, { ok: false, error: 'edge_generation_changed' });
        if (error === denied) return send(403, { ok: false, error: denied.message });
        return send(503, { error: 'cache_unavailable' });
    }
}
