import { validateAvailabilityProjection } from './hardwareAvailability.mjs';

// Availability states that force a runtime's readiness to false.
export function availabilityForcesNotReady(availability) {
    return ['refused', 'blocked', 'failed', 'stopped'].includes(availability);
}

// `storeProjections` (optional Map<routeKey, projection>) are the durable store's
// denials for the active generation (M-NW-01); the route source's own
// projection wins, as in every other observer.
export function metricHardwareAvailability(entry, record, routing, storeProjections = null) {
    const route = Object.values(routing?.routes || {}).find((value) => value?.container === entry.containerName && value.hardwareAvailability);
    const stored = route || !storeProjections
        ? null
        : [...storeProjections.values()].find((projection) => projection?.key === entry.containerName);
    if (route || stored) {
        try {
            const value = validateAvailabilityProjection(route ? route.hardwareAvailability : stored);
            if (value.key !== entry.containerName || value.instanceId !== record?.instanceId || value.enableGeneration !== record?.enableGeneration) throw new Error('stale instance');
            return { availability: value.state, problem: value.problem, limitsState: 'unavailable' };
        } catch (_) { return { availability: 'failed', problem: null, limitsState: 'unavailable' }; }
    }
    return {
        availability: entry.state?.status === 'failed' ? 'failed' : entry.state?.ready === true ? 'ready' : entry.state?.running ? 'starting' : 'stopped',
        problem: null,
    };
}
