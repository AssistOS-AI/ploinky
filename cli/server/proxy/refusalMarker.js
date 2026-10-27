// Router-authored pre-forward refusal marker.
//
// A response carries `X-Ploinky-Refusal` only when the Router itself wrote it
// before any byte of this request was dispatched upstream. A caller that sees
// the marker may therefore tell a Router refusal from an upstream answer; a
// response without it must be treated as having reached the upstream. The
// header is never copied from an upstream response (see
// stripUpstreamRefusalMarker and sanitizeResponseHeaders).

export const REFUSAL_HEADER = 'X-Ploinky-Refusal';
export const REFUSAL_VERSION = 1;

export const REFUSAL_STAGES = Object.freeze(['route', 'auth', 'relay']);
export const REFUSAL_CAUSES = Object.freeze([
    'edge-generation-inactive',
    'edge-generation-changed',
    'relay-busy',
    'route-denied',
    'unauthorized',
    'forbidden',
    'upstream-unavailable',
]);

const STAGE_SET = new Set(REFUSAL_STAGES);
const CAUSE_SET = new Set(REFUSAL_CAUSES);

export function refusalHeaderValue(stage, cause) {
    if (!STAGE_SET.has(stage)) throw new TypeError(`refusal marker: unknown stage ${String(stage)}`);
    if (!CAUSE_SET.has(cause)) throw new TypeError(`refusal marker: unknown cause ${String(cause)}`);
    return `v=${REFUSAL_VERSION}; stage=${stage}; cause=${cause}`;
}

export function refusalHeaders(stage, cause) {
    return { [REFUSAL_HEADER]: refusalHeaderValue(stage, cause) };
}

// Route-plan denial code to cause. Only the two inactive-selector codes are
// the transient transition refusals; every other denial is a plain route
// denial and must not be mistaken for one that a caller may retry.
export function routeRefusalCause(code) {
    return code === 'EDGE_GENERATION_INACTIVE' || code === 'HOST_SELECTOR_INACTIVE'
        ? 'edge-generation-inactive'
        : 'route-denied';
}

// Dispatch positions inside a relay executor, in order. Only positions before
// OPEN may produce a marker.
export const RELAY_PHASE = Object.freeze({
    PREPARE: 'prepare', // before the relay is touched
    CHECKOUT: 'checkout', // relayManager.checkout in flight; nothing can be on the wire
    OPEN: 'open', // openRequest in flight; the OPEN frame may have been written
    OPENED: 'opened', // OPEN written: the upstream may have received the request
});

// Marker headers for a refusal raised by a relay executor, or null when the
// failure must stay unmarked. The decision is positional: an error code never
// makes a post-OPEN failure a refusal, and a failure inside openRequest is
// pre-OPEN only when it is the lease check that runs before the OPEN write.
export function relayRefusalFor(error, phase) {
    const code = error?.code;
    if (phase === RELAY_PHASE.PREPARE) {
        if (code === 'AUTH_REQUIRED') return refusalHeaders('auth', 'unauthorized');
        if (code === 'ORIGIN_REJECTED' || code === 'CSRF_REJECTED') return refusalHeaders('auth', 'forbidden');
        return null;
    }
    if (phase === RELAY_PHASE.CHECKOUT) {
        if (code === 'EDGE_GENERATION_CHANGED') return refusalHeaders('relay', 'edge-generation-changed');
        if (code === 'RELAY_BUSY') return refusalHeaders('relay', 'relay-busy');
        return refusalHeaders('relay', 'upstream-unavailable');
    }
    if (phase === RELAY_PHASE.OPEN && code === 'EDGE_GENERATION_CHANGED') {
        return refusalHeaders('relay', 'edge-generation-changed');
    }
    return null;
}

// Drops an upstream-supplied marker from a header bag that is about to be
// forwarded. Works on a plain object (case-insensitive) and returns a copy
// only when something was removed.
export function stripUpstreamRefusalMarker(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const wanted = REFUSAL_HEADER.toLowerCase();
    if (!Object.keys(headers).some(name => name.toLowerCase() === wanted)) return headers;
    const result = {};
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== wanted) result[name] = value;
    }
    return result;
}
