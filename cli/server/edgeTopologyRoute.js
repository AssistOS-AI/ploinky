import { readCurrentEdgeTopology } from '../services/edgeGeneration.js';
import { resolveEdgeRoutePlan } from './edgeRoutePlan.js';

function send(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

export function handleEdgeTopologyProjection(req, res, parsedUrl, { routePlan } = {}) {
    if (parsedUrl?.pathname !== '/api/edge/topology') return false;
    if (String(req.method || 'GET').toUpperCase() !== 'GET') {
        send(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }
    const roles = Array.isArray(req.user?.roles) ? req.user.roles.map((role) => String(role).toLowerCase()) : [];
    if (!req.user || typeof req.user !== 'object' || roles.includes('guest')) {
        send(res, 401, { ok: false, error: 'not_authenticated' });
        return true;
    }
    const routeKey = String(parsedUrl.searchParams.get('routeKey') || '').trim();
    const slug = String(parsedUrl.searchParams.get('slug') || '').trim();
    if (!routeKey || !slug) {
        send(res, 400, { ok: false, error: 'routeKey_and_slug_required' });
        return true;
    }
    const snapshot = routePlan?.snapshot || routePlan?.lease?.snapshot;
    if (!snapshot) {
        send(res, 503, { ok: false, error: 'edge_generation_inactive' });
        return true;
    }
    const matches = (snapshot.compiled?.services || []).filter((entry) => (
        entry.routeKey === routeKey && entry.slug === slug
    ));
    const internal = (snapshot.compiled?.security?.internalServiceConsumers || []).some((entry) => (
        entry.routeKey === routeKey && entry.slug === slug
    ));
    if (matches.length !== 1 || internal) {
        send(res, 404, { ok: false, error: 'locator_not_found' });
        return true;
    }
    const hostKind = routePlan?.hostSelection?.kind;
    if (hostKind !== 'control') {
        const record = routePlan?.hostSelection?.record;
        const isSelectedRoot = record?.kind === 'agent-root' && record.routeKey === routeKey;
        const isNamedMount = (snapshot.compiled?.mounts?.[routePlan?.host] || []).some((entry) => (
            entry.routeKey === routeKey && entry.slug === slug
        ));
        if (routePlan?.kind !== 'router-surface' || routePlan?.surface !== 'topology-projection'
            || (!isSelectedRoot && !isNamedMount)) {
            send(res, 404, { ok: false, error: 'locator_not_found' });
            return true;
        }
    }
    const alias = Object.entries(snapshot.compiled?.localAliases || {}).find(([, entry]) => (
        entry.routeKey === routeKey && entry.slug === slug
    ))?.[0];
    if (!alias) {
        send(res, 404, { ok: false, error: 'locator_not_found' });
        return true;
    }
    const syntheticReq = {
        method: 'GET',
        url: '/',
        headers: { ...req.headers, host: alias },
        socket: req.socket,
    };
    const selectedPlan = resolveEdgeRoutePlan({ req: syntheticReq, listener: 'public' });
    if (!selectedPlan.ok || selectedPlan.kind !== 'service'
        || selectedPlan.definition.routeKey !== routeKey || selectedPlan.definition.slug !== slug
        || selectedPlan.decision?.access === 'deny' || selectedPlan.decision?.access === 'none') {
        send(res, 403, { ok: false, error: 'locator_access_denied' });
        return true;
    }
    if (selectedPlan.lease.id !== routePlan.lease.id
        || selectedPlan.lease.activationId !== routePlan.lease.activationId
        || !selectedPlan.lease.isCurrent() || !routePlan.lease.isCurrent()) {
        send(res, 503, { ok: false, error: 'edge_generation_changed' });
        return true;
    }
    let topology;
    try { topology = readCurrentEdgeTopology(); } catch (_) {
        send(res, 503, { ok: false, error: 'topology_unavailable' });
        return true;
    }
    const records = topology.services.filter((entry) => entry.routeKey === routeKey && entry.slug === slug);
    if (records.length !== 1 || !records[0].activeBrowserUrl
        || !['local-ready', 'cloudflare-ready'].includes(topology.state)
        || topology.authorizationGeneration !== routePlan.lease.id) {
        send(res, 503, { ok: false, error: 'locator_inactive' });
        return true;
    }
    send(res, 200, {
        routeKey,
        slug,
        browserUrl: records[0].activeBrowserUrl,
        state: topology.state,
        configurationGeneration: topology.configurationGeneration,
        publicationGeneration: topology.publicationGeneration,
    });
    return true;
}

export default { handleEdgeTopologyProjection };
