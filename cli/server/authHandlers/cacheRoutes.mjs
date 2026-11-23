import { hasHardwareBearer } from './hardwareLimitsRoutes.mjs';
import { isSessionRevoked } from '../auth/sessionRevocations.js';
import { readEdgeRoutingSelection } from '../../sandbox/edgeGeneration.js';
import { cachePublishedHosts, configuredCacheHosts } from '../cdn/cachePurgeConfig.js';
import { isApplicationHeld, markedApplications } from '../cdn/cacheHold.js';
import { readCacheSettings, setCacheApplication, validCacheApplication } from '../cdn/cacheSettingsStore.js';
import { purgeCacheHost, readLastPurge } from '../cdn/cachePurge.js';

function validRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (body.op === 'purge') return Object.keys(body).length === 2 && typeof body.host === 'string' && body.host.length > 0;
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

function applicationEntry({ agent, routes }, settings, hosts, generation, getCanaryHold) {
    const { enabled, pageSeconds } = settings.applications[agent] || { enabled: false, pageSeconds: 300 };
    const hold = settings.held[agent] || (isApplicationHeld(agent, { generation, settings }) ? getCanaryHold() : null);
    return { agent, enabled, pageSeconds, held: hold ? { since: hold.since, by: hold.by } : null,
        routes: routes.map(({ path, cache }) => ({ path, cache })), hosts };
}

export async function handleCacheRoutes(req, res, parsedUrl, {
    routePlan, ensureAdmin, verifyMutation, readBody, readSelection = readEdgeRoutingSelection,
    listPublished = cachePublishedHosts, listConfigured = configuredCacheHosts, listMarked = markedApplications,
    readSettings = readCacheSettings, setApplication = setCacheApplication, lastPurge = readLastPurge, purge = purgeCacheHost,
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
        if (method === 'GET') {
            const settings = readSettings();
            const configured = configuredFor(false);
            const applications = listMarked(generation).map(mark => applicationEntry(mark, settings, configured, generation, getCanaryHold));
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
        if (!app) return send(404, { error: 'unknown_application' });
        const { settings, previous } = await setApplication(body.agent, { enabled: body.enabled, pageSeconds: body.pageSeconds }, { assertCurrent });
        const configured = configuredFor(false);
        const purges = [];
        if (previous.enabled && !body.enabled) {
            for (const host of configured) {
                const { outcome } = await clear(host);
                purges.push({ host, outcome });
            }
        }
        return success({ application: applicationEntry(app, settings, configured, generation, getCanaryHold), purges });
    } catch (error) {
        if (error === stale) return send(503, { ok: false, error: 'edge_generation_changed' });
        if (error === denied) return send(403, { ok: false, error: denied.message });
        return send(503, { error: 'cache_unavailable' });
    }
}
