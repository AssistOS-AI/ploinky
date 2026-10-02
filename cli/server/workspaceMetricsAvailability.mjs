import { validateAvailabilityProjection } from './hardwareAvailability.mjs';

export function metricHardwareAvailability(entry, record, routing) {
    const route = Object.values(routing?.routes || {}).find((value) => value?.container === entry.containerName && value.hardwareAvailability);
    if (route) {
        try {
            const value = validateAvailabilityProjection(route.hardwareAvailability);
            if (value.key !== entry.containerName || value.instanceId !== record?.instanceId || value.enableGeneration !== record?.enableGeneration) throw new Error('stale instance');
            return { availability: value.state, problem: value.problem, limitsState: 'unavailable' };
        } catch (_) { return { availability: 'failed', problem: null, limitsState: 'unavailable' }; }
    }
    return {
        availability: entry.state?.status === 'failed' ? 'failed' : entry.state?.ready === true ? 'ready' : entry.state?.running ? 'starting' : 'stopped',
        problem: null,
    };
}
