// The store-derived (M-NW-01) availability projections of the active edge
// generation, by route key, for the observers that report state rather than
// forward traffic: the administrator view and the workspace metrics readiness.
// The same resolver the leases fence on computes them. An inactive selector or
// an unreadable store yields none here; the Router itself denies every route in
// those states.

import { loadActiveEdgeRoutingGeneration } from '../sandbox/edgeGeneration.js';
import { resolveEffectiveHardwareAvailability } from './hardwareAvailabilityResolver.mjs';

export function readStoreAvailabilityProjections(options = {}) {
    try {
        const active = loadActiveEdgeRoutingGeneration(options);
        return resolveEffectiveHardwareAvailability({ generation: active.generation, paths: active.paths }).projections;
    } catch (_) {
        return null;
    }
}
