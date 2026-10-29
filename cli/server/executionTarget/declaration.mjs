// Generic `executionTarget` manifest declaration (frozen T0 §3 + A1.4 +
// A2.4). The key is independent of `executionProvider` and of
// `routerAccess.agentExec`: neither is a target opt-in. A declaration names
// helper/profile/inventory digests, bounded state/service exports and lower
// limits. It never grants a capability, command, URL, host path or privilege
// and it qualifies or launches nothing. Nothing in production imports it in T1.

import {
    CONTRACT_ERROR_CODES,
    MAX_OBJECT_BYTES,
    canonicalOrThrow,
    deepFreeze,
    errorResult,
    isContractFailure,
    contractFailureCode,
    isDigest,
    isRelativePath,
    okResult,
} from './contract.mjs';

export const EXECUTION_TARGET_KEY = 'executionTarget';
export const EXECUTION_TARGET_VERSION = 1;
export const EXECUTION_TARGET_HELPER_CONTRACT_ID = 'ploinky.execution-target-helper.v1';

export const DECLARATION_ERROR_CODES = Object.freeze({
    ...CONTRACT_ERROR_CODES,
    targetContractMissing: 'target_contract_missing',
    servicePolicyUnavailable: 'service_policy_unavailable',
});

// Frozen v1 protocol ceilings that a declaration may only lower (A1.4).
export const TARGET_LIMITS_V1 = Object.freeze({
    executionsPerTarget: 8,
    listenersPerExecution: 21,
    connectionsPerExecution: 64,
    connectionsPerTarget: 512,
    pendingOpensPerExecution: 8,
    pendingOpensPerTarget: 64,
    frameBytes: 589824,
    headerBytes: 16384,
    dataBytesPerFrame: 65536,
    descriptorsPerFrame: 8,
    descriptorsPerExecution: 256,
    descriptorsPerTarget: 2048,
    resourcesPerOperation: 512,
    bufferedBytesPerConnection: 262144,
    bufferedBytesPerExecution: 4194304,
    bufferedBytesPerTarget: 33554432,
    outputBytesPerExecution: 67108864,
    channelBytesPerExecution: 268435456,
    controlFramesPerSecond: 2000,
    connectTimeoutMs: 5000,
    partialFrameTimeoutMs: 5000,
    idleTimeoutMs: 300000,
    connectionLifetimeMs: 86400000,
    executionLifetimeMs: 86400000,
    leaseTtlMs: 15000,
    renewIntervalMs: 5000,
    challengeTimeoutMs: 5000,
    releaseTimeoutMs: 10000,
    journalEntries: 65536,
    journalBytes: 268435456,
    ticketReplayEntries: 32768,
});

// Fixed worker/helper policy; never declarable (A1.4).
export const TARGET_POLICY_V1 = Object.freeze({ settledReceiptRetentionMs: 604800000 });
export const TARGET_FRAME_BYTES_FLOOR = 589824;

export const EXECUTION_TARGET_BOUNDS = Object.freeze({ stateExports: 32, serviceExports: 16, operations: 32 });

// Operation and endpoint names that would amount to an unrestricted
// management, shell or engine surface. The grammar admits them, policy does not.
export const UNRESTRICTED_SERVICE_NAMES = Object.freeze([
    'admin', 'all', 'any', 'command', 'docker', 'engine', 'exec', 'execute', 'helper', 'management',
    'podman', 'proxy', 'root', 'run', 'shell', 'spawn', 'sudo', 'terminal', 'tunnel',
]);

const C = DECLARATION_ERROR_CODES;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const DECLARATION_KEYS = Object.freeze([
    'version', 'helper', 'inventoryDigest', 'profile', 'stateExports', 'serviceExports', 'limits',
]);

class DeclarationFailure {
    constructor(code) { this.code = code; }
}

function fail(code) {
    throw new DeclarationFailure(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exact(value, keys) {
    if (!isPlainObject(value)) fail(C.invalidRequest);
    const own = Object.keys(value);
    if (own.length !== keys.length || !own.every((key) => keys.includes(key))) fail(C.invalidRequest);
}

function check(condition, code = C.invalidRequest) {
    if (!condition) fail(code);
}

function name(value) {
    check(typeof value === 'string' && NAME.test(value));
}

function sortedUnique(values) {
    for (let index = 1; index < values.length; index += 1) check(values[index - 1] < values[index]);
}

function bounded(value, max) {
    check(Array.isArray(value));
    if (value.length > max) fail(C.capacityExceeded);
}

function limits(value, { label = 'declaration' } = {}) {
    exact(value, Object.keys(TARGET_LIMITS_V1));
    for (const [key, ceiling] of Object.entries(TARGET_LIMITS_V1)) {
        const item = value[key];
        check(typeof item === 'number' && Number.isSafeInteger(item) && item >= 1 && item <= ceiling, C.invalidRequest);
    }
    return label;
}

function declaration(value) {
    check(isPlainObject(value));
    if (!Object.hasOwn(value, 'version') || value.version !== EXECUTION_TARGET_VERSION) fail(C.unsupportedVersion);
    exact(value, DECLARATION_KEYS);
    exact(value.helper, ['contractId', 'contractDigest', 'executableDigest']);
    check(value.helper.contractId === EXECUTION_TARGET_HELPER_CONTRACT_ID);
    check(isDigest(value.helper.contractDigest) && isDigest(value.helper.executableDigest));
    check(isDigest(value.inventoryDigest));
    exact(value.profile, ['id', 'digest']);
    name(value.profile.id);
    check(isDigest(value.profile.digest));
    bounded(value.stateExports, EXECUTION_TARGET_BOUNDS.stateExports);
    for (const entry of value.stateExports) {
        exact(entry, ['id', 'relativePath', 'access', 'sharing', 'filterPolicyDigest']);
        name(entry.id);
        check(isRelativePath(entry.relativePath));
        check(entry.access === 'read' || entry.access === 'write');
        check(entry.sharing === 'target-shared');
        check(isDigest(entry.filterPolicyDigest));
    }
    sortedUnique(value.stateExports.map((entry) => entry.id));
    bounded(value.serviceExports, EXECUTION_TARGET_BOUNDS.serviceExports);
    for (const entry of value.serviceExports) {
        exact(entry, ['id', 'endpointId', 'operations', 'policyDigest']);
        name(entry.id);
        name(entry.endpointId);
        check(Array.isArray(entry.operations) && entry.operations.length >= 1);
        bounded(entry.operations, EXECUTION_TARGET_BOUNDS.operations);
        entry.operations.forEach(name);
        sortedUnique(entry.operations);
        check(isDigest(entry.policyDigest));
    }
    sortedUnique(value.serviceExports.map((entry) => entry.id));
    const endpoints = value.serviceExports.map((entry) => entry.endpointId);
    check(new Set(endpoints).size === endpoints.length);
    limits(value.limits);
    for (const entry of value.serviceExports) {
        if ([entry.id, entry.endpointId, ...entry.operations].some((item) => UNRESTRICTED_SERVICE_NAMES.includes(item))) {
            fail(C.servicePolicyUnavailable);
        }
    }
}

function guarded(fn) {
    try {
        return okResult(fn());
    } catch (error) {
        if (error instanceof DeclarationFailure) return errorResult(error.code);
        if (isContractFailure(error)) return errorResult(contractFailureCode(error));
        throw error;
    }
}

/** Validate one declaration value: `{ok:true,value}` (deep-frozen copy) or `{ok:false,error:{code}}`. */
export function validateExecutionTargetDeclaration(value) {
    return guarded(() => {
        const text = canonicalOrThrow(value);
        if (Buffer.byteLength(text, 'utf8') > MAX_OBJECT_BYTES) fail(C.capacityExceeded);
        declaration(value);
        return JSON.parse(text);
    });
}

/**
 * Presence is the own `executionTarget` property, whatever its value: a
 * present null or invalid declaration is invalid, never absent. Returns
 * `{present:false}` or `{present:true,result}`.
 */
export function readExecutionTargetDeclaration(manifest) {
    if (!isPlainObject(manifest) || !Object.hasOwn(manifest, EXECUTION_TARGET_KEY)) return deepFreeze({ present: false });
    return deepFreeze({ present: true, result: validateExecutionTargetDeclaration(manifest[EXECUTION_TARGET_KEY]) });
}

/**
 * Admission view: an absent declaration is `target_contract_missing`.
 * `executionProvider` and `routerAccess.agentExec` never stand in for it.
 */
export function requireExecutionTargetDeclaration(manifest) {
    const read = readExecutionTargetDeclaration(manifest);
    return read.present ? read.result : errorResult(C.targetContractMissing);
}

function relationshipsHold(value) {
    return value.headerBytes + value.dataBytesPerFrame + 1024 <= value.frameBytes
        && value.frameBytes >= TARGET_FRAME_BYTES_FLOOR
        && value.pendingOpensPerExecution <= value.pendingOpensPerTarget
        && value.connectionsPerExecution <= value.connectionsPerTarget
        && value.connectionsPerExecution >= value.listenersPerExecution
        && value.bufferedBytesPerConnection <= value.bufferedBytesPerExecution
        && value.bufferedBytesPerExecution <= value.bufferedBytesPerTarget
        && value.descriptorsPerFrame <= value.descriptorsPerExecution
        && value.descriptorsPerExecution <= value.descriptorsPerTarget
        && value.dataBytesPerFrame <= value.bufferedBytesPerConnection
        && 3 * value.renewIntervalMs <= value.leaseTtlMs
        && value.challengeTimeoutMs <= value.leaseTtlMs
        && value.connectionLifetimeMs <= value.executionLifetimeMs
        && value.idleTimeoutMs <= value.connectionLifetimeMs;
}

/**
 * Component-wise minimum of TARGET_LIMITS_V1 (worker policy) and any number
 * of lower limit objects (declaration, qualification), then the A1.4/A2.4
 * relationship checks. Each input must carry exactly the TARGET_LIMITS_V1 keys.
 */
export function combineTargetLimits(...inputs) {
    return guarded(() => {
        const combined = { ...TARGET_LIMITS_V1 };
        for (const input of inputs) {
            canonicalOrThrow(input);
            limits(input);
            for (const key of Object.keys(combined)) combined[key] = Math.min(combined[key], input[key]);
        }
        check(relationshipsHold(combined));
        return combined;
    });
}
