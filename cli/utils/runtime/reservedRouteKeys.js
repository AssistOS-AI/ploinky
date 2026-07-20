export const AGENT_PORT_CONVENTION_ROUTE_KEY = 'base-agent-additional-server';

export const RESERVED_ROUTE_KEYS = Object.freeze([
    '_config',
    AGENT_PORT_CONVENTION_ROUTE_KEY,
]);

const RESERVED = new Set(RESERVED_ROUTE_KEYS);

export function isReservedRouteKey(value) {
    return RESERVED.has(String(value || '').trim());
}

export function assertRouteKeyAvailable(value, { label = 'Route key' } = {}) {
    const routeKey = String(value || '').trim();
    if (!routeKey) {
        throw new Error(`${label} is required.`);
    }
    if (isReservedRouteKey(routeKey)) {
        throw new Error(`${label} '${routeKey}' is reserved. Choose a different value.`);
    }
    return routeKey;
}

export default {
    AGENT_PORT_CONVENTION_ROUTE_KEY,
    RESERVED_ROUTE_KEYS,
    isReservedRouteKey,
    assertRouteKeyAvailable,
};
