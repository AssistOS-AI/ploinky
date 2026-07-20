let routingRuntime = null;

export function setRoutingRuntime(runtime) {
    if (!runtime?.store || typeof runtime.acquire !== 'function' || typeof runtime.resolvePrimary !== 'function') {
        throw new Error('runtimeContext: RoutingRuntime instance required');
    }
    routingRuntime = runtime;
    return runtime;
}

export function getRoutingRuntime() {
    if (!routingRuntime) throw new Error('runtimeContext: routing runtime is not configured');
    return routingRuntime;
}

export function getActiveGenerationRoutes() {
    return routingRuntime?.store?.active?.routes || {};
}

export function getActiveRoutingSnapshot() {
    const generation = routingRuntime?.store?.active;
    return generation ? { routes: generation.routes, static: generation.static || {} } : { routes: {}, static: {} };
}

export function clearRoutingRuntime(runtime) {
    if (!runtime || routingRuntime === runtime) routingRuntime = null;
}

export default getRoutingRuntime;
