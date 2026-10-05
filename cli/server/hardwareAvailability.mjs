// Current exact-instance hardware availability (plan §9.2, §9.4).
//
// A refused or blocked instance keeps its logical route (so desired hosts
// and dependency closures still resolve) but loses every concrete runtime
// target. The unavailable state travels in the routing source, is compiled
// into the edge generation, and every forwarding path consults it.

import { validateHardwareOutcome } from '../sandbox/hardwareLimits/errors.mjs';

const PROJECTION_KEYS = Object.freeze([
    'schema', 'inputFingerprint', 'key', 'instanceId', 'enableGeneration', 'state', 'problem', 'observedAt',
]);
const COMPILED_KEYS = Object.freeze([
    'state', 'code', 'reasonCode', 'key', 'instanceId', 'enableGeneration', 'reason', 'fix', 'rootKey',
]);
const MAX_IDENTITY = 512;

function fail(message) {
    const error = new Error(`hardware availability ${message}`);
    error.code = 'PLOINKY_HARDWARE_AVAILABILITY_INVALID';
    throw error;
}

function plain(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function exactKeys(value, keys, label) {
    plain(value, label);
    const allowed = new Set(keys);
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has unknown property '${key}'`);
    for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} is missing '${key}'`);
}

function identityText(value, label) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_IDENTITY) {
        fail(`${label} must be a bounded non-empty string`);
    }
    return value;
}

export function validateAvailabilityProjection(value) {
    exactKeys(value, PROJECTION_KEYS, 'projection');
    if (value.schema !== 1) fail('projection schema is unsupported');
    if (!/^[0-9a-f]{64}$/.test(value.inputFingerprint)) fail('projection inputFingerprint is invalid');
    const problem = validateHardwareOutcome(value.problem);
    if (value.state !== problem.state) fail('projection state disagrees with its problem');
    if (value.key !== problem.key) fail('projection key disagrees with its problem');
    identityText(value.instanceId, 'projection instanceId');
    identityText(value.enableGeneration, 'projection enableGeneration');
    if (Number.isNaN(Date.parse(value.observedAt))) fail('projection observedAt must be an ISO time');
    return Object.freeze({ ...value, problem });
}

export function buildAvailabilityProjection({ outcome, instanceId, enableGeneration, observedAt = new Date().toISOString() }) {
    const problem = validateHardwareOutcome(outcome);
    return validateAvailabilityProjection({
        schema: 1,
        inputFingerprint: problem.inputFingerprint,
        key: problem.key,
        instanceId: String(instanceId || ''),
        enableGeneration: String(enableGeneration || ''),
        state: problem.state,
        problem,
        observedAt,
    });
}

// A refused/blocked route: logical topology retained, runtime targets removed.
export function markRouteHardwareUnavailable(route, projection) {
    const validated = validateAvailabilityProjection(projection);
    const next = { ...(route || {}) };
    delete next.hostPort;
    delete next.serviceTargets;
    next.hardwareAvailability = validated;
    return next;
}

export function clearRouteHardwareAvailability(route) {
    if (!route || !Object.prototype.hasOwnProperty.call(route, 'hardwareAvailability')) return route;
    const next = { ...route };
    delete next.hardwareAvailability;
    return next;
}

// The compiled (consumer-facing) form of one validated projection. The parent
// route source and the durable store (M-NW-01) compile through this one function.
export function compileAvailabilityProjection(value) {
    const projection = validateAvailabilityProjection(value);
    return {
        state: projection.state,
        code: projection.problem.code,
        reasonCode: projection.problem.reasonCode,
        key: projection.key,
        instanceId: projection.instanceId,
        enableGeneration: projection.enableGeneration,
        reason: projection.problem.state === 'refused' ? projection.problem.reason : projection.problem.rootCause.reason,
        fix: projection.problem.state === 'refused' ? projection.problem.fix : projection.problem.rootCause.fix,
        rootKey: projection.problem.rootCause.key,
    };
}

// Compile the unavailable identities of a routing source into the generation.
// Returns null when no route is unavailable, so ordinary generations keep
// their exact compiled bytes.
export function compileHardwareAvailability(routing) {
    const entries = {};
    for (const [routeKey, route] of Object.entries(routing?.routes || {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (!route || !Object.prototype.hasOwnProperty.call(route, 'hardwareAvailability')) continue;
        const projection = validateAvailabilityProjection(route.hardwareAvailability);
        if (route.hostPort !== undefined || route.serviceTargets !== undefined) {
            fail(`route '${routeKey}' is unavailable but still names a runtime target`);
        }
        if (String(route.container || '') !== projection.key) {
            fail(`route '${routeKey}' availability does not belong to its exact container`);
        }
        entries[routeKey] = compileAvailabilityProjection(projection);
    }
    return Object.keys(entries).length ? entries : null;
}

function validCompiledEntry(entry) {
    try {
        exactKeys(entry, COMPILED_KEYS, 'compiled entry');
        return entry.state === 'refused' || entry.state === 'blocked';
    } catch (_) {
        return false;
    }
}

// The compiled unavailable entry for a route of an immutable snapshot. Any
// malformed entry fails closed as unavailable.
export function routeHardwareAvailability(snapshot, routeKey) {
    const compiled = snapshot?.compiled?.hardwareAvailability;
    if (!compiled || typeof compiled !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(compiled, String(routeKey || ''))) return null;
    const entry = compiled[routeKey];
    return validCompiledEntry(entry)
        ? entry
        : Object.freeze({ state: 'refused', code: 'PLOINKY_HARDWARE_LIMITS_UNENFORCEABLE', reasonCode: 'unprepared', key: '', instanceId: '', enableGeneration: '', reason: 'The hardware availability record is invalid.', fix: 'On the host run ploinky limits status.', rootKey: '' });
}

// A caller identity (private relay, agent-to-agent) is unavailable when any
// compiled entry names its exact instance or generation, or its route key.
export function identityHardwareUnavailable(snapshot, identity) {
    const compiled = snapshot?.compiled?.hardwareAvailability;
    if (!compiled || typeof compiled !== 'object' || !identity) return null;
    if (identity.routeKey && Object.prototype.hasOwnProperty.call(compiled, identity.routeKey)) {
        return routeHardwareAvailability(snapshot, identity.routeKey);
    }
    for (const entry of Object.values(compiled)) {
        if (!validCompiledEntry(entry)) return routeHardwareAvailability(snapshot, '\u0000invalid');
        if ((identity.instanceId && entry.instanceId === identity.instanceId)
            || (identity.enableGeneration && entry.enableGeneration === identity.enableGeneration)) {
            return entry;
        }
    }
    return null;
}

function safeText(value, max) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

// Terminal browser/probe result for an unavailable instance: no reload loop,
// only the validated non-secret reason and fix.
export function hardwareStartupResult(outcome) {
    const value = validateHardwareOutcome(outcome);
    const root = value.rootCause;
    return Object.freeze({
        state: 'unavailable',
        code: value.state === 'refused' ? 'hardware_refused' : 'hardware_blocked',
        reason: safeText(value.state === 'refused' ? value.reason : `Blocked by ${value.blockedBy.ref}: ${root.reason}`, 2048),
        fix: safeText(root.fix, 2048),
    });
}

export function hardwareStartupResultFromCompiled(entry) {
    return Object.freeze({
        state: 'unavailable',
        code: entry.state === 'refused' ? 'hardware_refused' : 'hardware_blocked',
        reason: safeText(entry.reason, 2048),
        fix: safeText(entry.fix, 2048),
    });
}
