// Bounded, typed hardware-limit outcomes and their error transport.
//
// One validator/serializer is shared by CLI cause wrappers, worker transport,
// no-wait status, monitor state and HTTP mapping, so refusal and blocking
// causality survive every hop without parsing freeform messages.

import crypto from 'node:crypto';

export const HARDWARE_UNENFORCEABLE = 'PLOINKY_HARDWARE_LIMITS_UNENFORCEABLE';
export const HARDWARE_DEPENDENCY_BLOCKED = 'PLOINKY_HARDWARE_LIMITS_DEPENDENCY_BLOCKED';
export const HARDWARE_OUTCOME_CODES = Object.freeze([HARDWARE_UNENFORCEABLE, HARDWARE_DEPENDENCY_BLOCKED]);
export const HARDWARE_FIELDS = Object.freeze(['memory', 'cpus', 'pidsLimit', 'gpu']);
export const HARDWARE_SOURCES = Object.freeze(['manifest', 'catalog', 'profile', 'settings']);
export const HARDWARE_REASON_CODES = Object.freeze([
    'gate_off',
    'unprepared',
    'controller_unavailable',
    'cgroup_unsupported',
    'runtime_unverified',
    'backend_unavailable',
    'store_unreadable',
    'gpu_grant_missing',
    'gpu_sharing_unavailable',
    'mps_unavailable',
    'mps_failed',
    'gpu_user_network',
    'gpu_memory_model',
    'image_preparation_required',
    'lite_sandbox',
    'interactive_runtime',
    'host_network_nested_podman',
    'exceeds_envelope',
    'envelope_unknown',
    'declaration_conflict',
    'dependency_blocked',
]);

export const OUTCOME_BOUNDS = Object.freeze({
    key: 1024,
    ref: 257,
    alias: 1024,
    reason: 2048,
    fix: 2048,
    value: 128,
    requested: 4,
    causalPathEntries: 32,
    causalPathBytes: 8 * 1024,
    outcomeBytes: 16 * 1024,
});

const OUTCOME_KEYS = Object.freeze([
    'state', 'code', 'reasonCode', 'key', 'ref', 'alias', 'inputFingerprint', 'reason', 'fix', 'requested',
    'blockedBy', 'rootCause', 'causalPath', 'omittedPathCount', 'additionalCauseCount',
]);
const ROOT_KEYS = Object.freeze(['key', 'ref', 'field', 'reason', 'fix']);
const REQUESTED_KEYS = Object.freeze(['field', 'value', 'source']);
const HEX64 = /^[0-9a-f]{64}$/;
const REF_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CAUSE_DEPTH = 8;

export class HardwareOutcomeSchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HardwareOutcomeSchemaError';
        this.code = 'PLOINKY_HARDWARE_OUTCOME_INVALID';
    }
}

function schemaFail(message) {
    throw new HardwareOutcomeSchemaError(`hardware outcome ${message}`);
}

function byteLength(value) {
    return Buffer.byteLength(String(value), 'utf8');
}

function plainObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) schemaFail(`${label} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) schemaFail(`${label} must be a plain object`);
    return value;
}

function exactKeys(value, keys, label) {
    plainObject(value, label);
    const allowed = new Set(keys);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) schemaFail(`${label} has unknown property '${key}'`);
    }
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) schemaFail(`${label} is missing '${key}'`);
    }
}

function boundedText(value, max, label, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') schemaFail(`${label} must be a string`);
    if (!allowEmpty && !value) schemaFail(`${label} must not be empty`);
    if (value.includes('\0')) schemaFail(`${label} must not contain NUL`);
    if (byteLength(value) > max) schemaFail(`${label} exceeds ${max} bytes`);
    return value;
}

export function isHardwareRef(value) {
    if (typeof value !== 'string' || byteLength(value) > OUTCOME_BOUNDS.ref) return false;
    const parts = value.split('/');
    return parts.length === 2 && parts.every((part) => REF_COMPONENT.test(part));
}

function validateRef(value, label) {
    if (!isHardwareRef(value)) schemaFail(`${label} must be an exact REPO/AGENT reference`);
    return value;
}

function validateKey(value, label) {
    return boundedText(value, OUTCOME_BOUNDS.key, label);
}

function validateRequested(list, label) {
    if (!Array.isArray(list)) schemaFail(`${label} must be an array`);
    if (list.length > OUTCOME_BOUNDS.requested) schemaFail(`${label} exceeds ${OUTCOME_BOUNDS.requested} entries`);
    const seen = new Set();
    return list.map((entry, index) => {
        exactKeys(entry, REQUESTED_KEYS, `${label}[${index}]`);
        if (!HARDWARE_FIELDS.includes(entry.field)) schemaFail(`${label}[${index}].field is unknown`);
        if (seen.has(entry.field)) schemaFail(`${label} repeats field '${entry.field}'`);
        seen.add(entry.field);
        boundedText(entry.value, OUTCOME_BOUNDS.value, `${label}[${index}].value`);
        if (!HARDWARE_SOURCES.includes(entry.source)) schemaFail(`${label}[${index}].source is unknown`);
        return Object.freeze({ field: entry.field, value: entry.value, source: entry.source });
    });
}

function validateRoot(value, label) {
    exactKeys(value, ROOT_KEYS, label);
    validateKey(value.key, `${label}.key`);
    validateRef(value.ref, `${label}.ref`);
    if (value.field !== null && !HARDWARE_FIELDS.includes(value.field)) schemaFail(`${label}.field is unknown`);
    boundedText(value.reason, OUTCOME_BOUNDS.reason, `${label}.reason`);
    boundedText(value.fix, OUTCOME_BOUNDS.fix, `${label}.fix`, { allowEmpty: true });
    return Object.freeze({ ...value });
}

// Strictly validate one outcome. Unknown properties, unbounded strings and
// inconsistent causality are rejected; a valid outcome is returned frozen.
export function validateHardwareOutcome(value) {
    exactKeys(value, OUTCOME_KEYS, 'outcome');
    if (value.state !== 'refused' && value.state !== 'blocked') schemaFail('state must be refused or blocked');
    if (!HARDWARE_OUTCOME_CODES.includes(value.code)) schemaFail('code is unknown');
    if ((value.state === 'refused') !== (value.code === HARDWARE_UNENFORCEABLE)) {
        schemaFail('state and code disagree');
    }
    if (!HARDWARE_REASON_CODES.includes(value.reasonCode)) schemaFail('reasonCode is unknown');
    validateKey(value.key, 'key');
    validateRef(value.ref, 'ref');
    if (value.alias !== null) boundedText(value.alias, OUTCOME_BOUNDS.alias, 'alias');
    if (!HEX64.test(value.inputFingerprint)) schemaFail('inputFingerprint must be 64 lower-case hex digits');
    boundedText(value.reason, OUTCOME_BOUNDS.reason, 'reason');
    boundedText(value.fix, OUTCOME_BOUNDS.fix, 'fix', { allowEmpty: true });
    const requested = validateRequested(value.requested, 'requested');
    const rootCause = validateRoot(value.rootCause, 'rootCause');
    let blockedBy = null;
    if (value.state === 'refused') {
        if (value.blockedBy !== null) schemaFail('a refusal has no blockedBy');
        if (rootCause.key !== value.key) schemaFail('a refusal is its own root cause');
        if (value.reasonCode === 'dependency_blocked') schemaFail('a refusal cannot be dependency_blocked');
    } else {
        exactKeys(value.blockedBy, ['key', 'ref'], 'blockedBy');
        blockedBy = Object.freeze({
            key: validateKey(value.blockedBy.key, 'blockedBy.key'),
            ref: validateRef(value.blockedBy.ref, 'blockedBy.ref'),
        });
        if (requested.length) schemaFail('a blocked outcome requests nothing itself');
        if (value.reasonCode !== 'dependency_blocked') schemaFail('a blocked outcome is dependency_blocked');
    }
    if (!Array.isArray(value.causalPath) || value.causalPath.length < 1) schemaFail('causalPath must be a non-empty array');
    if (value.causalPath.length > OUTCOME_BOUNDS.causalPathEntries) {
        schemaFail(`causalPath exceeds ${OUTCOME_BOUNDS.causalPathEntries} entries`);
    }
    const causalPath = value.causalPath.map((entry, index) => validateKey(entry, `causalPath[${index}]`));
    if (byteLength(JSON.stringify(causalPath)) > OUTCOME_BOUNDS.causalPathBytes) schemaFail('causalPath exceeds 8 KiB');
    if (causalPath[0] !== value.key) schemaFail('causalPath must start at the outcome key');
    if (causalPath[causalPath.length - 1] !== rootCause.key) schemaFail('causalPath must end at the root cause');
    for (const field of ['omittedPathCount', 'additionalCauseCount']) {
        if (!Number.isSafeInteger(value[field]) || value[field] < 0) schemaFail(`${field} must be a non-negative safe integer`);
    }
    const outcome = Object.freeze({
        state: value.state,
        code: value.code,
        reasonCode: value.reasonCode,
        key: value.key,
        ref: value.ref,
        alias: value.alias,
        inputFingerprint: value.inputFingerprint,
        reason: value.reason,
        fix: value.fix,
        requested: Object.freeze(requested),
        blockedBy,
        rootCause,
        causalPath: Object.freeze(causalPath),
        omittedPathCount: value.omittedPathCount,
        additionalCauseCount: value.additionalCauseCount,
    });
    if (byteLength(JSON.stringify(outcome)) > OUTCOME_BOUNDS.outcomeBytes) schemaFail('exceeds 16 KiB');
    return outcome;
}

export function isHardwareOutcome(value) {
    try {
        validateHardwareOutcome(value);
        return true;
    } catch (_) {
        return false;
    }
}

// An identity that cannot travel without truncation is never shortened into
// a different command target.
export function assertRepresentableIdentity({ key, ref, alias = null }) {
    const problems = [];
    if (typeof key !== 'string' || !key || byteLength(key) > OUTCOME_BOUNDS.key) problems.push('key');
    if (!isHardwareRef(ref)) problems.push('ref');
    if (alias !== null && alias !== undefined && (typeof alias !== 'string' || byteLength(alias) > OUTCOME_BOUNDS.alias)) {
        problems.push('alias');
    }
    if (!problems.length) return;
    const digest = crypto.createHash('sha256').update(JSON.stringify([String(key), String(ref), String(alias ?? '')]))
        .digest('hex');
    const error = new Error(
        `The agent identity cannot be represented without truncation (${problems.join(', ')}); identity digest sha256:${digest}. `
        + 'Inspect it with ploinky limits status; no command was sent to a shortened identity.',
    );
    error.code = 'identity_unrepresentable';
    error.status = 422;
    error.identityDigest = `sha256:${digest}`;
    throw error;
}

export class HardwareLimitsError extends Error {
    constructor(outcome, { message, status } = {}) {
        const validated = validateHardwareOutcome(outcome);
        super(message || formatHardwareOutcome(validated));
        this.name = 'HardwareLimitsError';
        this.code = validated.code;
        this.status = status ?? (validated.state === 'blocked' ? 424 : 422);
        this.hardwareOutcome = validated;
    }
}

// Find the first valid outcome on an error or its bounded cause chain.
export function findHardwareOutcome(error) {
    let current = error;
    for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth += 1) {
        if (current.hardwareOutcome && isHardwareOutcome(current.hardwareOutcome)) {
            return validateHardwareOutcome(current.hardwareOutcome);
        }
        current = current.cause;
    }
    return null;
}

// Wrap an error with context while preserving its code, status and typed
// hardware outcome; the original remains the cause.
export function wrapPreservingHardwareCause(message, cause) {
    const error = new Error(message, { cause });
    const outcome = findHardwareOutcome(cause);
    if (outcome) {
        error.code = outcome.code;
        error.status = cause?.status ?? (outcome.state === 'blocked' ? 424 : 422);
        error.hardwareOutcome = outcome;
    } else {
        if (cause?.code !== undefined) error.code = cause.code;
        if (cause?.status !== undefined) error.status = cause.status;
    }
    return error;
}

function boundedMessage(value, max = 4000) {
    const text = String(value ?? '');
    return byteLength(text) > max ? `${Buffer.from(text, 'utf8').subarray(0, max).toString('utf8')}...` : text;
}

// Serialize the bounded transport fields of an error. Never includes stacks,
// environments, request bodies or credentials; only validated typed fields.
export function serializeHardwareAwareError(error, { depth = 0 } = {}) {
    if (!error || typeof error !== 'object') return { message: boundedMessage(error) };
    const serialized = { message: boundedMessage(error.message || error) };
    if (typeof error.code === 'string' || typeof error.code === 'number') serialized.code = error.code;
    if (Number.isSafeInteger(error.status)) serialized.status = error.status;
    const outcome = findHardwareOutcome(error);
    if (outcome) serialized.hardwareOutcome = outcome;
    if (error.cause && depth < 3) serialized.cause = serializeHardwareAwareError(error.cause, { depth: depth + 1 });
    return serialized;
}

export function deserializeHardwareAwareError(value, { depth = 0 } = {}) {
    const source = value && typeof value === 'object' ? value : { message: String(value ?? '') };
    const cause = source.cause && depth < 3 ? deserializeHardwareAwareError(source.cause, { depth: depth + 1 }) : undefined;
    const error = new Error(boundedMessage(source.message || 'operation failed'), cause ? { cause } : undefined);
    if (source.code !== undefined) error.code = source.code;
    if (source.status !== undefined) error.status = source.status;
    if (source.hardwareOutcome !== undefined) {
        error.hardwareOutcome = validateHardwareOutcome(source.hardwareOutcome);
        error.code = error.hardwareOutcome.code;
    }
    return error;
}

const SOURCE_LABELS = Object.freeze({
    manifest: 'manifest',
    catalog: 'catalog',
    profile: 'selected profile',
    settings: 'Explorer hardware settings',
});

export function formatRequestedEntry(entry) {
    return `${entry.field} ${entry.value} (${SOURCE_LABELS[entry.source] || entry.source})`;
}

// Human-readable, deterministic rendering of a validated outcome (§9.3).
export function formatHardwareOutcome(outcome) {
    const value = validateHardwareOutcome(outcome);
    if (value.state === 'refused') {
        const requested = value.requested.length
            ? `requests ${value.requested.map(formatRequestedEntry).join(', ')}`
            : 'cannot prove the absence of stored limits';
        return `Refused (hardware limits): ${value.ref} [${value.key}] ${requested}. ${value.reason}${value.fix ? ` ${value.fix}` : ''}`;
    }
    const root = value.rootCause;
    const field = root.field ? `${root.field}: ` : '';
    const more = value.additionalCauseCount ? ` (${value.additionalCauseCount} additional cause(s))` : '';
    return `Blocked (dependency): ${value.ref} [${value.key}] requires ${value.blockedBy.ref} [${value.blockedBy.key}]. `
        + `Root refusal: ${root.ref} [${root.key}], ${field}${root.reason}${more}${root.fix ? ` ${root.fix}` : ''}`;
}
