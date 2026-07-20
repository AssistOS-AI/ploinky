import { AGENT_PORT_CONVENTION_ROUTE_KEY } from '../../utils/runtime/reservedRouteKeys.js';

export function locateAgentPort({ generation, routeKey, port, authenticated = false } = {}) {
    if (authenticated !== true) throw new Error('agentPortLocator: authenticated user required');
    if (!generation?.active) throw new Error('agentPortLocator: no active generation');
    const route = generation.routes?.[routeKey];
    if (!route) throw new Error('agentPortLocator: route is inactive');
    if (!Number.isInteger(port) || port < 1 || port > 65535 || route.deniedPorts.includes(port)) {
        throw new Error('agentPortLocator: invalid port');
    }
    const authority = generation.surfaces?.public?.authority;
    if (!authority) throw new Error('agentPortLocator: public surface unavailable');
    return Object.freeze({
        url: `http://${authority}/${AGENT_PORT_CONVENTION_ROUTE_KEY}/${encodeURIComponent(routeKey)}/${port}/`,
        generationDigest: generation.digest,
        cacheControl: 'no-store',
    });
}

export default locateAgentPort;
