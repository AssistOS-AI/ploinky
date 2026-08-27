import { RUNNING_DIR } from './config.js';
import {
    createNoWaitRunBinding,
    observeBoundNoWaitRun,
    readNoWaitRunMarker,
} from '../commands/noWaitLogObserver.js';

/**
 * Overlay a current detached launch's semantic readiness on live runtime
 * state. OCI "running" proves only that the process exists; a no-wait worker
 * publishes "running" only after the exact manifest readiness probe and route
 * activation have succeeded.
 *
 * Marker/status reads are identity-bound and fenced against the same registry
 * snapshot used for runtime collection. Any malformed, stale, or otherwise
 * unprovable current run fails closed instead of exposing false readiness.
 */
export function applyCurrentNoWaitReadiness(entry, registry, {
    runningDir = RUNNING_DIR,
    readMarker = readNoWaitRunMarker,
    createBinding = createNoWaitRunBinding,
    observeRun = observeBoundNoWaitRun,
} = {}) {
    const containerName = String(entry?.containerName || '');
    const record = registry?.[containerName];
    if (!containerName || !record || record.type !== 'agent') return entry;

    let marker;
    try {
        marker = readMarker(containerName, { runningDir });
    } catch (_) {
        return {
            ...entry,
            state: {
                ...(entry?.state || {}),
                status: 'unknown',
                ready: false,
                noWaitState: 'unreadable',
            },
        };
    }
    if (!marker) return entry;

    try {
        const binding = createBinding(containerName, record, marker);
        const observation = observeRun(binding, {
            runningDir,
            readRegistrySnapshot: () => registry,
        });
        if (observation.state === 'running') {
            return {
                ...entry,
                state: {
                    ...(entry?.state || {}),
                    ready: Boolean(entry?.state?.running),
                    noWaitState: 'running',
                },
            };
        }
        return {
            ...entry,
            state: {
                ...(entry?.state || {}),
                status: observation.state === 'failed' ? 'failed' : 'starting',
                ready: false,
                noWaitState: observation.state,
            },
        };
    } catch (_) {
        return {
            ...entry,
            state: {
                ...(entry?.state || {}),
                status: 'unknown',
                ready: false,
                noWaitState: 'unreadable',
            },
        };
    }
}

export function applyRuntimeReadinessProjection(entries, registry, {
    applyReadiness = applyCurrentNoWaitReadiness,
} = {}) {
    return (Array.isArray(entries) ? entries : [])
        .map((entry) => applyReadiness(entry, registry));
}
