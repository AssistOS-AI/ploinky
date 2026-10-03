import path from 'node:path';

import { RUNNING_DIR } from './config.js';
import { readVerifiedJsonObject } from './verifiedReadOnlyFile.js';
import {
    NO_WAIT_STATE_BYTE_LIMIT,
    createNoWaitRunBinding,
    observeBoundNoWaitRun,
    readNoWaitRunMarker,
} from '../commands/noWaitLogObserver.js';
import { NO_WAIT_DIR_NAME } from '../commands/noWaitPaths.js';

// The public per-container no-wait status. Only a no-wait launch or a
// Watchdog rebind of one ever writes it.
function readCanonicalNoWaitStatus(containerName, { runningDir = RUNNING_DIR } = {}) {
    if (!containerName || path.basename(containerName) !== containerName) {
        throw new Error('a no-wait status read requires one exact container name');
    }
    return readVerifiedJsonObject({
        trustedRoot: runningDir,
        relativeSegments: [NO_WAIT_DIR_NAME, `${containerName}.json`],
        byteLimit: NO_WAIT_STATE_BYTE_LIMIT,
        absent: null,
    });
}

// Only a status of the exact runtime tuple the registry names now says
// anything about that runtime. Start rotates a tuple, enable mints a new
// generation, and disable and staged replacement remove the record, so each
// leaves a status of a tuple that no longer runs.
function namesCurrentRuntime(status, containerName, record) {
    const instanceId = String(record?.instanceId || '');
    const enableGeneration = String(record?.enableGeneration || '');
    return Boolean(instanceId && enableGeneration)
        && status?.containerName === containerName
        && status.instanceId === instanceId
        && status.enableGeneration === enableGeneration;
}

function unreadableNoWaitState(entry) {
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

/**
 * Overlay a current detached launch's semantic readiness on live runtime
 * state. OCI "running" proves only that the process exists; a no-wait worker
 * publishes "running" only after the exact manifest readiness probe and route
 * activation have succeeded.
 *
 * Marker/status reads are identity-bound and fenced against the same registry
 * snapshot used for runtime collection. Any malformed, stale, or otherwise
 * unprovable current run fails closed instead of exposing false readiness.
 * That includes a runtime whose own exact tuple has a no-wait status but no
 * current marker: it belongs to the no-wait lifecycle, and no run binds it. A
 * status of another tuple is stale and leaves the runtime state unchanged.
 */
export function applyCurrentNoWaitReadiness(entry, registry, {
    runningDir = RUNNING_DIR,
    readMarker = readNoWaitRunMarker,
    readStatus = readCanonicalNoWaitStatus,
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
        return unreadableNoWaitState(entry);
    }
    if (!marker) {
        try {
            return namesCurrentRuntime(readStatus(containerName, { runningDir }), containerName, record)
                ? unreadableNoWaitState(entry)
                : entry;
        } catch (_) {
            return unreadableNoWaitState(entry);
        }
    }

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
        return unreadableNoWaitState(entry);
    }
}

export function applyRuntimeReadinessProjection(entries, registry, {
    applyReadiness = applyCurrentNoWaitReadiness,
} = {}) {
    return (Array.isArray(entries) ? entries : [])
        .map((entry) => applyReadiness(entry, registry));
}
