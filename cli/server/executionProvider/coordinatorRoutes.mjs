import { coordinatorRouteMatches, readExecutionProviderDeclaration } from './declaration.mjs';

// Pure matching for the signed coordinator hop, shared by the request planner
// (routing.mjs) and the private authorization and forward steps
// (coordinatorHop.mjs). It imports no token or routing-state module.

function segmentsCover(ancestor, descendant) {
    return ancestor.length <= descendant.length && ancestor.every((segment, index) => segment === descendant[index]);
}

// The declared entry that the raw request path below the agent port selects
// exactly: same canonical segments (or below a `/*` scope), with no percent
// encoding, `;` parameters, empty or dot segments, trailing slash or other
// spelling the agent might normalize. Any other spelling of a coordinator
// scope stays unavailable, even on the private listener.
export function exactCoordinatorRoute(declaration, { port, suffixPath }) {
    const routes = declaration?.coordinatorRoutes || [];
    if (!routes.length) return null;
    const path = String(suffixPath || '').split('?')[0];
    if (!path.startsWith('/') || path === '/' || path.endsWith('/')) return null;
    // Declared scopes are ASCII without `%` or `;` (declaration.mjs), so an
    // allowlist of the remaining path characters loses no valid match.
    if (!/^[A-Za-z0-9._~!$&'()*+,=:@/-]+$/.test(path)) return null;
    const segments = path.slice(1).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
    return routes.find((entry) => entry.port === port && (entry.wildcard
        ? segmentsCover(entry.suffix, segments)
        : (segments.length === entry.suffix.length && segmentsCover(entry.suffix, segments)))) || null;
}

export function headerValue(req, name) {
    const value = req?.headers?.[name];
    return Array.isArray(value) ? value : (value === undefined ? undefined : String(value));
}

export function isUpgradeRequest(req) {
    const upgrade = headerValue(req, 'upgrade');
    return Array.isArray(upgrade) || Boolean(String(upgrade || '').trim());
}

// The planner's private-listener exception: only an exact declared scope, over
// plain HTTP (an upgrade cannot carry the signed Router Request).
export function privateCoordinatorAdmissible({ declaration, selector, listener, transport, req }) {
    if (listener !== 'private' || transport !== 'http' || isUpgradeRequest(req)) return false;
    return exactCoordinatorRoute(declaration, { port: selector?.port, suffixPath: selector?.suffix }) !== null;
}

// Recomputes, from the immutable plan alone, whether a private agent-port plan
// targets a coordinator scope. `matched` uses the planner's broad matcher, so
// no coordinator spelling is ever treated as an ordinary route; `entry` is the
// exact declared scope, or null when the spelling is not admissible.
export function coordinatorRouteForPlan(plan) {
    if (plan?.kind !== 'agent-port') return { matched: false, entry: null };
    const read = readExecutionProviderDeclaration(plan.snapshot?.manifests?.[plan.routeKey], { routeKey: plan.routeKey });
    if (!read.present) return { matched: false, entry: null };
    if (!read.valid) return { matched: true, entry: null };
    const suffixPath = String(plan.unmatchedSuffix || '');
    const matched = coordinatorRouteMatches(read.declaration, { port: plan.port, suffixPath });
    if (!matched) return { matched: false, entry: null };
    return { matched: true, entry: exactCoordinatorRoute(read.declaration, { port: plan.port, suffixPath }) };
}
