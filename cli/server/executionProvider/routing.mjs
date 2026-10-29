import {
    hostNetworkProviderPorts,
    networkModeOf,
    routedRootPort,
    coordinatorRouteMatches,
    readExecutionProviderDeclaration,
} from './declaration.mjs';
import { privateCoordinatorAdmissible } from './coordinatorRoutes.mjs';

// Denials that the request-derived planners (agent-port, agent-root, the
// root-application synthesized selector and the WebSocket root proxy, which
// reuses the agent-root plan) apply to a route that declares a provider.
export const PROVIDER_PORT_DENIED = 'EXECUTION_PROVIDER_PORT_DENIED';
export const PROVIDER_DECLARATION_INVALID = 'EXECUTION_PROVIDER_DECLARATION_INVALID';
export const PROVIDER_ROOT_UNRESOLVED = 'EXECUTION_PROVIDER_ROOT_UNRESOLVED';
export const COORDINATOR_ROUTE_UNAVAILABLE = 'coordinator_route_unavailable';
export const TASK_REFERENCE_UNAVAILABLE = 'task_reference_unavailable';

function denial(status, code) {
    return Object.freeze({ status, code });
}

export function resolveRoutedRootPort(snapshot, routeKey, route) {
    return routedRootPort({
        manifest: snapshot?.manifests?.[routeKey],
        record: snapshot?.agents?.[String(route?.container || '')],
        route,
    });
}

// Request-derived `agent-port` plans, on every listener and transport: the
// whole provider port is denied before any caller policy, a malformed active
// declaration denies the route, and a declared coordinator path is
// unavailable. The one exception is the signed coordinator hop: an exact
// declared scope over HTTP on the private listener plans normally, and the
// private authorization step then admits only a declared coordinator caller
// and signs the forward (coordinatorHop.mjs).
export function providerAgentPortDenial({
    snapshot, routeKey, route = null, selector, listener = '', transport = 'http', req = null,
}) {
    const hostDenial = route ? hostProviderPortDenial({ snapshot, routeKey, route, port: selector.port }) : null;
    if (hostDenial) return hostDenial;
    const read = readExecutionProviderDeclaration(snapshot?.manifests?.[routeKey], { routeKey });
    if (!read.present) return null;
    if (!read.valid) return denial(503, PROVIDER_DECLARATION_INVALID);
    const { declaration } = read;
    if (selector.port === declaration.port) return denial(403, PROVIDER_PORT_DENIED);
    if (coordinatorRouteMatches(declaration, { port: selector.port, suffixPath: selector.suffix })) {
        if (privateCoordinatorAdmissible({ declaration, selector, listener, transport, req })) return null;
        return denial(503, COORDINATOR_ROUTE_UNAVAILABLE);
    }
    return null;
}

// In host-network mode a port number is host-global: any host-network route's
// selector, or a root application on one, reaches another host-network
// provider's private port. Applies to every route, declaring or not.
export function hostProviderPortDenial({ snapshot, routeKey, route, port }) {
    const record = snapshot?.agents?.[String(route?.container || '')];
    if (networkModeOf(snapshot?.manifests?.[routeKey], record) !== 'host') return null;
    const ports = hostNetworkProviderPorts({
        routes: snapshot?.routing?.routes, manifests: snapshot?.manifests, agents: snapshot?.agents,
    });
    return ports.has(Number(port)) ? denial(403, PROVIDER_PORT_DENIED) : null;
}

// Request-derived `agent-root` plans (public hosts, managed listener, the
// root-application owner and the WebSocket root proxy). `upstreamPath` is the
// path the agent would receive after rewriting.
export function providerAgentRootDenial({ snapshot, routeKey, route, upstreamPath }) {
    const hostDenial = hostProviderPortDenial({ snapshot, routeKey, route, port: route?.hostPort });
    if (hostDenial) return hostDenial;
    const read = readExecutionProviderDeclaration(snapshot?.manifests?.[routeKey], { routeKey });
    if (!read.present) return null;
    if (!read.valid) return denial(503, PROVIDER_DECLARATION_INVALID);
    const { declaration } = read;
    const rootPort = resolveRoutedRootPort(snapshot, routeKey, route);
    const hasTarget = Number.isSafeInteger(Number(route?.hostPort)) && Number(route?.hostPort) > 0;
    if (rootPort === declaration.port) return denial(403, PROVIDER_PORT_DENIED);
    // A route with a target whose primary identity cannot be resolved is
    // invalid; a route without a target (draining, pending) has nothing to
    // reach, and its coordinator paths are still never answered.
    if (hasTarget && rootPort === null) return denial(503, PROVIDER_ROOT_UNRESOLVED);
    if (coordinatorRouteMatches(declaration, { port: rootPort, suffixPath: upstreamPath })) {
        return denial(503, COORDINATOR_ROUTE_UNAVAILABLE);
    }
    return null;
}
