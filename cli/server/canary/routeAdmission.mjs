// Only the Router attaches an observer. Importing a discovery or CLI helper
// must neither open the workspace nor start a probe scheduler.
let observer;
export function setRoutingSignals(signals) {
    observer = signals;
}

export function routingSignals() {
    return observer;
}

export function effectiveCanaryMode(config, state) {
    if (config.mode === 'split') return state?.state || 'split';
    if (config.mode === 'all' && ['paused', 'prepare-rejected'].includes(state?.state)) return 'paused';
    return config.mode;
}

export function routeAdmitted(route, routeKey, snapshot, signals = observer) {
    if (!route || route.disabled) return false;
    const config = route.canary;
    if (config?.mode !== 'all') return !route.draining;
    const state = signals?.routingState(routeKey, config.rolloutId);
    if (effectiveCanaryMode(config, state) !== 'all') return !route.draining;
    if (state?.running === false) return false;
    if (!snapshot?.agents) return true;
    const record = snapshot.agents[config.container];
    return record?.canaryOf === routeKey && Boolean(record.containerId);
}
