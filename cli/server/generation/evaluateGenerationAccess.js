import { HttpRouteAccessPath } from '../policy/HttpRouteAccessPath.js';
import { moreRestrictiveHttpRouteDecision, noHttpRouteAccess, normalizeHttpRouteAccess } from '../policy/HttpRouteAccessDecision.js';

function normalizeEntry(entry, source = 'generation-policy') {
    if (entry?.enabled === false) return null;
    const access = normalizeHttpRouteAccess(entry?.access);
    const normalized = HttpRouteAccessPath.normalize(String(entry?.path || ''));
    if (!access || !normalized.ok) return null;
    return {
        access,
        path: normalized.path,
        routeKey: String(entry.routeKey || HttpRouteAccessPath.routeKeyForPath(normalized.path)),
        source: String(entry.source || source),
        ...(entry.guestScope ? { guestScope: String(entry.guestScope) } : {}),
    };
}

export function evaluateGenerationAccess({
    generation,
    pathname,
    method = 'GET',
    routeKey = '',
    surfaceKind = '',
    declaredAccess,
    declaredGuestScope,
} = {}) {
    if (!generation?.active) return { access: 'deny', status: 503, code: 'GENERATION_INACTIVE', routeKey, source: 'generation' };
    const request = HttpRouteAccessPath.normalize(String(pathname || ''), { allowWildcard: false });
    if (!request.ok) return { access: 'deny', status: 404, code: 'UNROUTABLE_PATH', routeKey, source: 'generation' };
    let decision = noHttpRouteAccess();
    for (const rawEntry of generation.policyEntries || []) {
        const entry = normalizeEntry(rawEntry);
        if (entry && HttpRouteAccessPath.matches(request.path, entry.path)) {
            decision = moreRestrictiveHttpRouteDecision(decision, entry);
        }
    }
    const normalizedDeclared = normalizeHttpRouteAccess(declaredAccess);
    if (normalizedDeclared) {
        decision = moreRestrictiveHttpRouteDecision(decision, {
            access: normalizedDeclared,
            routeKey,
            source: 'generation-declaration',
            ...(declaredGuestScope ? { guestScope: String(declaredGuestScope) } : {}),
        });
    }
    if (decision.access === 'none') {
        const fallback = surfaceKind === 'agent-port-convention'
            ? 'authenticated'
            : normalizeHttpRouteAccess(generation.routes?.[routeKey]?.defaultAccess) || 'guest';
        decision = { access: fallback, routeKey, source: `${surfaceKind || 'agent-primary'}-default` };
    }
    if (decision.access === 'public' && !HttpRouteAccessPath.isReadOnlyMethod(method)) {
        return { access: 'deny', status: 403, code: 'PUBLIC_ROUTE_WRITE_DENIED', routeKey, source: decision.source };
    }
    return decision;
}

export default evaluateGenerationAccess;
