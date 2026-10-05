// The store-derived (M-NW-01) availability projections of the active edge
// generation, by agent container key, for the observers that report state rather
// than forward traffic: the administrator view and the workspace metrics
// readiness. The same resolver the leases fence on computes them. A store that
// was never initialized (witness and directory both absent) is empty, as in the
// store's own reader. An unreadable or invalid store is not "no denials": the
// Router denies every route then, so each agent of the active generation gets a
// typed `store_unreadable` refusal here and is never reported ready. An inactive
// or unloadable selector yields none; the Router denies on that basis itself.

import crypto from 'node:crypto';

import { loadActiveEdgeRoutingGeneration } from '../sandbox/edgeGeneration.js';
import { HARDWARE_AVAILABILITY_UNREADABLE } from '../sandbox/hardwareAvailabilityStore.mjs';
import { buildDirectRefusal } from '../sandbox/hardwareLimits/requestedLimits.mjs';
import { buildAvailabilityProjection } from './hardwareAvailability.mjs';
import { resolveEffectiveHardwareAvailability } from './hardwareAvailabilityResolver.mjs';

const STORE_UNREADABLE_PARTS = Object.freeze({
    reasonCode: 'store_unreadable',
    reason: 'The hardware availability store cannot be read safely, so no agent of this workspace can be proven available.',
    fix: 'On the host run ploinky stop, restore or remove the hardware availability store as its error message directs, then ploinky start.',
});

function storeUnreadableProjections(generation) {
    const projections = new Map();
    for (const [key, record] of Object.entries(generation?.agents || {})) {
        const instanceId = String(record?.instanceId || '');
        const enableGeneration = String(record?.enableGeneration || '');
        const ref = record?.repoName && record?.agentName ? `${record.repoName}/${record.agentName}` : null;
        const inputFingerprint = crypto.createHash('sha256').update(`store_unreadable|${key}|${instanceId}|${enableGeneration}`).digest('hex');
        let projection;
        try {
            projection = buildAvailabilityProjection({
                outcome: buildDirectRefusal({ key, ref: ref || `unknown/${key}`, refusalParts: STORE_UNREADABLE_PARTS, inputFingerprint }),
                instanceId,
                enableGeneration,
            });
        } catch (_) {
            // An identity the outcome grammar cannot carry still gets the denial, under a fixed ref.
            projection = buildAvailabilityProjection({
                outcome: buildDirectRefusal({ key, ref: 'unknown/agent', refusalParts: STORE_UNREADABLE_PARTS, inputFingerprint }),
                instanceId,
                enableGeneration,
            });
        }
        projections.set(key, projection);
    }
    return projections;
}

export function readStoreAvailabilityProjections(options = {}) {
    let active;
    try {
        active = loadActiveEdgeRoutingGeneration(options);
    } catch (error) {
        // Only the selector/generation-unavailable codes mean "the Router denies on that basis itself".
        if (typeof error?.code === 'string' && error.code.startsWith('EDGE_')) return null;
        throw error;
    }
    try {
        return resolveEffectiveHardwareAvailability({ generation: active.generation, paths: active.paths }).projections;
    } catch (error) {
        if (error?.code === HARDWARE_AVAILABILITY_UNREADABLE) return storeUnreadableProjections(active.generation);
        throw error;
    }
}
