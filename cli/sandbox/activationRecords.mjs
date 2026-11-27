import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureVerifiedProducerDirectory } from '../utils/verifiedReadOnlyFile.js';
import { selectorIdentity } from './edgeSelectorRecord.mjs';

// Activation records (Q30). A host start, whole restart or full update that
// fails after the in-Box command published its new edge selector keeps that
// version running instead of rolling it back. To decide, the host needs
// durable evidence written before the selector rename: a write-once intent
// naming the exact selector, Box and workspace. A receipt records the
// outcome when it can; it is never required. While the host holds an
// activation barrier, a controller-only marker makes the in-Box lease point
// refuse configuration and graph changes.
//
// This module imports only Node built-ins and pure helpers: the host reads
// these records too, and the in-Box lease point imports it, so it must not
// load the CLI configuration or the lease module.

export const ACTIVATION_CONTEXT_ENV = 'PLOINKY_ACTIVATION_CONTEXT';
export const ACTIVATION_CONTEXT_SCHEMA = 'ploinky-activation-context';
export const ACTIVATION_INTENT_SCHEMA = 'ploinky-activation-intent';
export const ACTIVATION_RECEIPT_SCHEMA = 'ploinky-activation-receipt';
export const ACTIVATION_MARKER_SCHEMA = 'ploinky-activation-barrier-marker';
export const ACTIVATION_RECORD_VERSION = 1;

export const ACTIVATION_CONTEXT_MAX_BYTES = 2048;
export const ACTIVATION_INTENT_MAX_BYTES = 8 * 1024;
export const ACTIVATION_RECEIPT_MAX_BYTES = 4 * 1024;
export const ACTIVATION_MARKER_MAX_BYTES = 2048;
export const ACTIVATION_RECORDS_KEEP = 16;

export const EDGE_ROUTING_SEGMENTS = Object.freeze(['.ploinky', 'data', 'edge-routing']);
export const ACTIVATIONS_SEGMENTS = Object.freeze([...EDGE_ROUTING_SEGMENTS, 'activations']);
export const ACTIVATION_MARKER_NAME = 'activation-barrier.json';

export const ACTIVATION_OPERATIONS = Object.freeze(['start', 'restart', 'update']);
export const ACTIVATION_PURPOSES = Object.freeze(['activate', 'settle', 'restore']);
export const ACTIVATION_MARKER_STATES = Object.freeze(['activated', 'indeterminate', 'writer']);

export const ACTIVATION_CONTEXT_INVALID = 'PLOINKY_ACTIVATION_CONTEXT_INVALID';
export const ACTIVATION_RECOVERY_REQUIRED = 'PLOINKY_ACTIVATION_RECOVERY_REQUIRED';

const OPERATION_ID = /^[0-9a-f]{32}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONTEXT_KEYS = Object.freeze([
    'schema', 'version', 'operation', 'purpose', 'settlesOperationId',
    'operationId', 'instance', 'containerId', 'workspaceRoot',
]);
const INTENT_KEYS = Object.freeze([
    'schema', 'version', 'operationId', 'context', 'intended', 'predecessor', 'policyStaged', 'recordedAt',
]);
const RECEIPT_KEYS = Object.freeze(['schema', 'version', 'operationId', 'intentDigest', 'outcome', 'recordedAt']);
const MARKER_KEYS = Object.freeze(['schema', 'version', 'operation', 'operationId', 'state', 'containerId', 'createdAt']);
const RECORD_NAME = /^([0-9a-f]{32})\.(intent|receipt)\.json$/;

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
    const present = Object.keys(value);
    return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function contextError(message) {
    const error = new Error(`Invalid ${ACTIVATION_CONTEXT_ENV}: ${message}`);
    error.code = ACTIVATION_CONTEXT_INVALID;
    return error;
}

function sha256(bytes) {
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function shortId(value, length = 8) {
    return String(value || '').slice(0, length) || 'unknown';
}

/**
 * Validate the host-issued activation context. `settlesOperationId` names
 * the barrier a settle restart supersedes; it is required for `settle` and
 * null otherwise.
 */
export function parseActivationContext(raw) {
    if (typeof raw !== 'string' || raw.length === 0) throw contextError('it is empty');
    if (Buffer.byteLength(raw) > ACTIVATION_CONTEXT_MAX_BYTES) {
        throw contextError(`it exceeds ${ACTIVATION_CONTEXT_MAX_BYTES} bytes`);
    }
    let context;
    try {
        context = JSON.parse(raw);
    } catch (_) {
        throw contextError('it is not JSON');
    }
    if (!isPlainObject(context) || !hasExactKeys(context, CONTEXT_KEYS)) throw contextError('it has unexpected fields');
    if (context.schema !== ACTIVATION_CONTEXT_SCHEMA || context.version !== ACTIVATION_RECORD_VERSION) {
        throw contextError('it has an unsupported schema');
    }
    if (!ACTIVATION_OPERATIONS.includes(context.operation)) throw contextError('the operation is unknown');
    if (!ACTIVATION_PURPOSES.includes(context.purpose)) throw contextError('the purpose is unknown');
    if (!OPERATION_ID.test(String(context.operationId))) throw contextError('the operation id is not 32 hex characters');
    if (context.purpose === 'settle') {
        if (!OPERATION_ID.test(String(context.settlesOperationId))
            || context.settlesOperationId === context.operationId) {
            throw contextError('a settle context must name another operation id to settle');
        }
    } else if (context.settlesOperationId !== null) {
        throw contextError(`a ${context.purpose} context settles no operation`);
    }
    if (typeof context.instance !== 'string' || !context.instance || context.instance.length > 256) {
        throw contextError('the instance is invalid');
    }
    if (!CONTAINER_ID.test(String(context.containerId))) throw contextError('the container id is not 64 hex characters');
    if (typeof context.workspaceRoot !== 'string' || !path.isAbsolute(context.workspaceRoot)
        || context.workspaceRoot.length > 4095) {
        throw contextError('the workspace root is not absolute');
    }
    return context;
}

// The request this process was admitted with, read once at command entry.
let admittedRequest = null;

/**
 * Read and remove the activation context the host passed to this command.
 * The variable is deleted in every case, so detached Watchdog, Router and
 * no-wait children never inherit it. An absent context is today's behaviour
 * (operators, Marketplace, agents). `command` is the in-Box command reading
 * it: `start` accepts start activation and the rollback restore; `restart`
 * accepts restart and update activation and the settle restart.
 */
export function readActivationRequest(env = process.env, { command = null } = {}) {
    const raw = env?.[ACTIVATION_CONTEXT_ENV];
    if (env && Object.hasOwn(env, ACTIVATION_CONTEXT_ENV)) delete env[ACTIVATION_CONTEXT_ENV];
    admittedRequest = null;
    if (raw === undefined) return null;
    const context = parseActivationContext(raw);
    if (command === 'start' && (context.operation !== 'start' || context.purpose === 'settle')) {
        throw contextError('a start accepts only a start activation or a rollback restore');
    }
    if (command === 'restart' && (context.operation === 'start' || context.purpose === 'restore')) {
        throw contextError('a restart accepts only a restart or update activation or a settle');
    }
    admittedRequest = Object.freeze({ ...context, context });
    return admittedRequest;
}

/** The purpose the host admitted this process with, or null. */
export function hostAdmittedActivation() {
    return admittedRequest?.purpose ?? null;
}

export function currentActivationRequest() {
    return admittedRequest;
}

function writesActivationRecords(request) {
    return Boolean(request && ['activate', 'settle'].includes(request.purpose));
}

function fsyncDirectory(directory, fsApi) {
    let fd;
    try {
        fd = fsApi.openSync(directory, fs.constants.O_RDONLY);
        fsApi.fsyncSync(fd);
    } catch (error) {
        // Not every host filesystem syncs directories; the file fsync and the
        // link remain authoritative there.
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
    } finally {
        if (fd !== undefined) {
            try { fsApi.closeSync(fd); } catch (_) {}
        }
    }
}

export function activationsDirectory(workspaceRoot) {
    return path.join(path.resolve(String(workspaceRoot)), ...ACTIVATIONS_SEGMENTS);
}

export function activationRecordPath(workspaceRoot, operationId, kind) {
    if (!OPERATION_ID.test(String(operationId))) throw new Error('Invalid activation operation id');
    if (!['intent', 'receipt'].includes(kind)) throw new Error('Invalid activation record kind');
    return path.join(activationsDirectory(workspaceRoot), `${operationId}.${kind}.json`);
}

export function activationMarkerPath(workspaceRoot) {
    return path.join(path.resolve(String(workspaceRoot)), ...EDGE_ROUTING_SEGMENTS, ACTIVATION_MARKER_NAME);
}

// Publish exactly one record: a `wx` temp file, write, fsync, link(2) to the
// final name (which never replaces), unlink the temp, then fsync the
// directory. A second publication fails with EEXIST.
function publishOnce({ workspaceRoot, finalName, text, fsApi }) {
    const directory = ensureVerifiedProducerDirectory({
        trustedRoot: workspaceRoot,
        relativeSegments: [...ACTIVATIONS_SEGMENTS],
        mode: 0o700,
        fsApi,
    });
    const finalPath = path.join(directory, finalName);
    const temporary = path.join(directory, `.${finalName}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const fd = fsApi.openSync(temporary, 'wx', 0o600);
    try {
        fsApi.writeFileSync(fd, text);
        fsApi.fsyncSync(fd);
    } finally {
        fsApi.closeSync(fd);
    }
    try {
        fsApi.linkSync(temporary, finalPath);
    } finally {
        fsApi.rmSync(temporary, { force: true });
    }
    fsyncDirectory(directory, fsApi);
    return finalPath;
}

/**
 * Write the write-once intent. `intended` is the active selector about to be
 * published, `predecessor` the inactive selector it replaces. Returns the
 * file path and the sha256 of its exact bytes.
 */
export function writeActivationIntent({
    workspaceRoot,
    request,
    intended,
    predecessor,
    policyStaged,
    fsApi = fs,
    now = () => new Date(),
} = {}) {
    if (!writesActivationRecords(request)) throw new Error('An activation intent requires an activate or settle request');
    const intendedIdentity = selectorIdentity(intended);
    if (!intendedIdentity || intendedIdentity.state !== 'active') throw new Error('An activation intent requires the active selector');
    const body = {
        schema: ACTIVATION_INTENT_SCHEMA,
        version: ACTIVATION_RECORD_VERSION,
        operationId: request.operationId,
        context: request.context,
        intended: intendedIdentity,
        predecessor: selectorIdentity(predecessor),
        policyStaged: policyStaged === true,
        recordedAt: now().toISOString(),
    };
    const text = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(text) > ACTIVATION_INTENT_MAX_BYTES) throw new Error('The activation intent exceeds its size limit');
    const file = publishOnce({ workspaceRoot, finalName: `${request.operationId}.intent.json`, text, fsApi });
    return Object.freeze({ path: file, digest: sha256(Buffer.from(text)) });
}

export function writeActivationReceipt({
    workspaceRoot,
    operationId,
    intentDigest,
    outcome,
    fsApi = fs,
    now = () => new Date(),
} = {}) {
    if (!['committed', 'not-committed'].includes(outcome)) throw new Error('Invalid activation receipt outcome');
    const body = {
        schema: ACTIVATION_RECEIPT_SCHEMA,
        version: ACTIVATION_RECORD_VERSION,
        operationId,
        intentDigest,
        outcome,
        recordedAt: now().toISOString(),
    };
    const text = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(text) > ACTIVATION_RECEIPT_MAX_BYTES) throw new Error('The activation receipt exceeds its size limit');
    return publishOnce({ workspaceRoot, finalName: `${operationId}.receipt.json`, text, fsApi });
}

function validIdentity(value, { states = ['active', 'inactive'] } = {}) {
    return isPlainObject(value)
        && hasExactKeys(value, ['state', 'generation', 'activationId', 'selectorDigest'])
        && states.includes(value.state)
        && (value.generation === null || DIGEST.test(String(value.generation)))
        && (value.state !== 'active' || value.generation !== null)
        && typeof value.activationId === 'string' && value.activationId.length > 0 && value.activationId.length <= 64
        && DIGEST.test(String(value.selectorDigest));
}

function invalid(reason) {
    return Object.freeze({ state: 'invalid', reason });
}

/**
 * Judge intent bytes for one operation. `expectedContext` is the context the
 * host issued; the intent must echo it exactly.
 */
export function parseActivationIntent(text, { operationId, expectedContext }) {
    if (Buffer.byteLength(String(text)) > ACTIVATION_INTENT_MAX_BYTES) return invalid('oversized');
    let value;
    try {
        value = JSON.parse(text);
    } catch (_) {
        return invalid('malformed');
    }
    if (!isPlainObject(value) || !hasExactKeys(value, INTENT_KEYS)) return invalid('malformed');
    if (value.schema !== ACTIVATION_INTENT_SCHEMA || value.version !== ACTIVATION_RECORD_VERSION) return invalid('unsupported');
    if (value.operationId !== operationId) return invalid('wrong-operation');
    if (JSON.stringify(value.context) !== JSON.stringify(expectedContext)) return invalid('foreign');
    if (!validIdentity(value.intended, { states: ['active'] })) return invalid('malformed');
    if (value.predecessor !== null && !validIdentity(value.predecessor)) return invalid('malformed');
    if (typeof value.policyStaged !== 'boolean' || typeof value.recordedAt !== 'string') return invalid('malformed');
    return Object.freeze({ state: 'valid', value, digest: sha256(Buffer.from(String(text))) });
}

export function parseActivationReceipt(text, { operationId, intentDigest }) {
    if (Buffer.byteLength(String(text)) > ACTIVATION_RECEIPT_MAX_BYTES) return invalid('oversized');
    let value;
    try {
        value = JSON.parse(text);
    } catch (_) {
        return invalid('malformed');
    }
    if (!isPlainObject(value) || !hasExactKeys(value, RECEIPT_KEYS)) return invalid('malformed');
    if (value.schema !== ACTIVATION_RECEIPT_SCHEMA || value.version !== ACTIVATION_RECORD_VERSION) return invalid('unsupported');
    if (value.operationId !== operationId) return invalid('wrong-operation');
    if (!['committed', 'not-committed'].includes(value.outcome) || typeof value.recordedAt !== 'string') return invalid('malformed');
    if (!intentDigest || value.intentDigest !== intentDigest) return invalid('digest-mismatch');
    return Object.freeze({ state: 'valid', value });
}

/**
 * Keep the newest `keep` operations' records and remove older intent and
 * receipt pairs and abandoned temp files. Runs only under the start or
 * restart lease, so no writer of these records is live meanwhile.
 */
export function pruneActivationRecords({ workspaceRoot, keep = ACTIVATION_RECORDS_KEEP, fsApi = fs } = {}) {
    const directory = activationsDirectory(workspaceRoot);
    let entries;
    try {
        const stat = fsApi.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return Object.freeze({ removed: [] });
        entries = fsApi.readdirSync(directory);
    } catch (error) {
        if (error?.code === 'ENOENT') return Object.freeze({ removed: [] });
        throw error;
    }
    const operations = new Map();
    const removed = [];
    for (const name of entries) {
        if (name.startsWith('.') && name.endsWith('.tmp')) {
            try { fsApi.rmSync(path.join(directory, name), { force: true }); removed.push(name); } catch (_) {}
            continue;
        }
        const match = RECORD_NAME.exec(name);
        if (!match) continue;
        let mtimeMs = 0;
        try { mtimeMs = fsApi.lstatSync(path.join(directory, name)).mtimeMs; } catch (_) {}
        const current = operations.get(match[1]) || { names: [], mtimeMs: 0 };
        current.names.push(name);
        current.mtimeMs = Math.max(current.mtimeMs, mtimeMs);
        operations.set(match[1], current);
    }
    const ordered = [...operations.entries()].sort((left, right) => right[1].mtimeMs - left[1].mtimeMs
        || right[0].localeCompare(left[0]));
    for (const [, { names }] of ordered.slice(Math.max(0, keep))) {
        for (const name of names) {
            try { fsApi.rmSync(path.join(directory, name), { force: true }); removed.push(name); } catch (_) {}
        }
    }
    return Object.freeze({ removed: Object.freeze(removed) });
}

/** Parse marker bytes. Anything unparseable is malformed, which still blocks. */
export function parseActivationBarrierMarker(text) {
    if (Buffer.byteLength(String(text)) > ACTIVATION_MARKER_MAX_BYTES) return invalid('oversized');
    let value;
    try {
        value = JSON.parse(text);
    } catch (_) {
        return invalid('malformed');
    }
    if (!isPlainObject(value) || !hasExactKeys(value, MARKER_KEYS)
        || value.schema !== ACTIVATION_MARKER_SCHEMA || value.version !== ACTIVATION_RECORD_VERSION
        || !ACTIVATION_OPERATIONS.includes(value.operation)
        || !OPERATION_ID.test(String(value.operationId))
        || !ACTIVATION_MARKER_STATES.includes(value.state)
        || !CONTAINER_ID.test(String(value.containerId))
        || typeof value.createdAt !== 'string') {
        return invalid('malformed');
    }
    return Object.freeze({ state: 'valid', value: Object.freeze({ ...value }) });
}

export function buildActivationBarrierMarker({ operation, operationId, state, containerId, now = () => new Date() }) {
    const marker = {
        schema: ACTIVATION_MARKER_SCHEMA,
        version: ACTIVATION_RECORD_VERSION,
        operation,
        operationId,
        state,
        containerId,
        createdAt: now().toISOString(),
    };
    if (parseActivationBarrierMarker(JSON.stringify(marker)).state !== 'valid') {
        throw new Error('The activation barrier marker is invalid');
    }
    return marker;
}

/**
 * Bounded, non-symlink read of the in-Box marker. Returns
 * `{ state: 'absent' }`, `{ state: 'present', marker, bytes }` or
 * `{ state: 'malformed', reason }`. A present but unreadable marker is
 * malformed: it blocks like a valid one.
 */
export function readActivationBarrierMarker({ workspaceRoot, fsApi = fs } = {}) {
    const file = activationMarkerPath(workspaceRoot);
    let stat;
    try {
        stat = fsApi.lstatSync(file);
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return Object.freeze({ state: 'absent' });
        return Object.freeze({ state: 'malformed', reason: 'unreadable' });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return Object.freeze({ state: 'malformed', reason: 'not a regular file' });
    if (stat.size > ACTIVATION_MARKER_MAX_BYTES) return Object.freeze({ state: 'malformed', reason: 'oversized' });
    let bytes;
    let fd;
    try {
        fd = fsApi.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fsApi.fstatSync(fd);
        if (!opened.isFile() || opened.size > ACTIVATION_MARKER_MAX_BYTES
            || opened.dev !== stat.dev || opened.ino !== stat.ino) {
            return Object.freeze({ state: 'malformed', reason: 'changed during read' });
        }
        bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fsApi.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) break;
            offset += count;
        }
        if (offset !== bytes.length) return Object.freeze({ state: 'malformed', reason: 'short read' });
    } catch (error) {
        if (error?.code === 'ENOENT') return Object.freeze({ state: 'absent' });
        return Object.freeze({ state: 'malformed', reason: 'unreadable' });
    } finally {
        if (fd !== undefined) {
            try { fsApi.closeSync(fd); } catch (_) {}
        }
    }
    const parsed = parseActivationBarrierMarker(bytes.toString('utf8'));
    if (parsed.state !== 'valid') return Object.freeze({ state: 'malformed', reason: parsed.reason });
    return Object.freeze({ state: 'present', marker: parsed.value, bytes });
}

/**
 * Remover 1: after its own selector commit, an activate or settle start may
 * remove a marker. A `writer` marker and a marker carrying the committing
 * operation's own id are never removed: a lingering writer must keep the
 * guard meant for it. Activate removes another operation's (stale or forged)
 * marker; settle removes only the marker of the barrier it settles.
 */
export function markerRemovableBy(request, marker) {
    if (!writesActivationRecords(request) || !marker) return false;
    if (marker.state === 'writer' || marker.operationId === request.operationId) return false;
    if (request.purpose === 'settle') return marker.operationId === request.settlesOperationId;
    return true;
}

function removeMarkerAfterCommit({ workspaceRoot, request, fsApi, log }) {
    const read = readActivationBarrierMarker({ workspaceRoot, fsApi });
    if (read.state !== 'present' || !markerRemovableBy(request, read.marker)) return false;
    // Remove only the exact bytes that were judged.
    const again = readActivationBarrierMarker({ workspaceRoot, fsApi });
    if (again.state !== 'present' || !again.bytes.equals(read.bytes)) return false;
    try {
        fsApi.unlinkSync(activationMarkerPath(workspaceRoot));
        fsyncDirectory(path.dirname(activationMarkerPath(workspaceRoot)), fsApi);
        return true;
    } catch (error) {
        log?.(`[start] the activation barrier marker could not be removed: ${error?.message || error}`);
        return false;
    }
}

/**
 * The selector commit hooks of a start. With neither a PROD capture nor an
 * activate/settle request they behave exactly like
 * `{ afterSelectorCommit() { onActivated(); } }`.
 *
 * `beforeSelectorCommit` stages the PROD policy, then writes the intent,
 * and returns the rollback the publication path calls only after proving
 * non-publication: a `not-committed` receipt, then the policy rollback.
 * `afterSelectorCommit` marks the workspace activated, writes the committed
 * receipt, removes a settled marker, then finalizes the policy. A `restore`
 * request (the host's rollback start) writes no records and removes no marker.
 */
export function activationCommitHooks({
    prodCapture = null,
    activationRequest = null,
    workspaceRoot,
    onActivated = () => {},
    stageProdGates = null,
    fsApi = fs,
    log = (message) => console.warn(message),
} = {}) {
    const records = writesActivationRecords(activationRequest);
    if (!prodCapture && !records) {
        return { afterSelectorCommit() { onActivated(); } };
    }
    if (prodCapture && typeof stageProdGates !== 'function') throw new Error('PROD staging requires its stager');
    let staged = null;
    let intent = null;
    const receipt = (outcome) => {
        if (!intent) return;
        try {
            writeActivationReceipt({
                workspaceRoot, operationId: activationRequest.operationId, intentDigest: intent.digest, outcome, fsApi,
            });
        } catch (error) {
            log(`[start] the activation receipt (${outcome}) could not be written: ${error?.message || error}`);
        }
    };
    return {
        beforeSelectorCommit({ selector, predecessorSelector } = {}) {
            staged = prodCapture ? stageProdGates(prodCapture) : null;
            if (records) {
                try {
                    intent = writeActivationIntent({
                        workspaceRoot,
                        request: activationRequest,
                        intended: selector,
                        predecessor: predecessorSelector,
                        policyStaged: Boolean(staged?.staged ?? staged),
                        fsApi,
                    });
                } catch (error) {
                    staged?.rollback();
                    throw error;
                }
            }
            return () => {
                receipt('not-committed');
                staged?.rollback();
            };
        },
        afterSelectorCommit() {
            onActivated();
            receipt('committed');
            if (records) removeMarkerAfterCommit({ workspaceRoot, request: activationRequest, fsApi, log });
            staged?.finalize();
        },
    };
}

// In-Box lease classification while a marker is present. DENY covers
// configuration and graph changes; ADMIT covers recovery, convergence of the
// kept graph, reads and serving. `workspace-start` and `workspace-restart`
// depend on the purpose the host admitted. Anything unknown is refused.
export const ACTIVATION_BARRIER_DENY = Object.freeze([
    'agent-enable',
    'agent-disable',
    'agent-disable-batch',
    'marketplace-enable:*',
    'marketplace-repository:*',
    'repositories-install',
    'repositories-prepare',
    'repositories-remove',
    'repositories-uninstall',
    'repositories-enable',
    'repositories-disable',
    'reinstall',
    'canary-*',
    'exact-agent-restart',
    'start:*',
    'restart:*',
    'update',
    'update-git-pins',
    'hardware-apply',
    'skills-export',
    'exclusions-refresh',
    'set-production-mode',
    'set-workspace-profile',
    'workspace-start',
    'workspace-restart',
]);

export const ACTIVATION_BARRIER_ADMIT = Object.freeze([
    'workspace-stop',
    'workspace-shutdown',
    'workspace-destroy',
    'workspace-clean',
    'canary-status',
    'canary-teardown',
    'no-wait-runtime:*',
    'watchdog-restart:*',
    'router-restart',
    'shell:*',
    'dependency-preparation',
    'policy-write',
    // The Router's recovery-only latcher of terminal no-wait availability
    // slots: it records outcomes of the kept graph and never activates one.
    'hardware-availability-latch',
]);

function matchesPattern(operation, pattern) {
    return pattern.endsWith('*') ? operation.startsWith(pattern.slice(0, -1)) : operation === pattern;
}

function matchesAny(operation, patterns, { exact }) {
    return patterns.some((pattern) => (pattern.endsWith('*') ? !exact : exact) && matchesPattern(operation, pattern));
}

/**
 * Classify one lease operation: `admit`, `deny` or `unknown`. Exact names
 * outrank prefixes (`canary-status` is admitted inside `canary-*`).
 */
export function classifyLeaseOperation(operation) {
    const value = String(operation || '');
    if (matchesAny(value, ACTIVATION_BARRIER_ADMIT, { exact: true })) return 'admit';
    if (matchesAny(value, ACTIVATION_BARRIER_DENY, { exact: true })) return 'deny';
    if (matchesAny(value, ACTIVATION_BARRIER_ADMIT, { exact: false })) return 'admit';
    if (matchesAny(value, ACTIVATION_BARRIER_DENY, { exact: false })) return 'deny';
    return 'unknown';
}

function purposeAdmits(operation, purpose) {
    if (operation === 'workspace-start') return ['activate', 'settle', 'restore'].includes(purpose);
    if (operation === 'workspace-restart') return ['activate', 'settle'].includes(purpose);
    return false;
}

export function activationRecoveryRequiredError(operation, marker) {
    const refused = operation || 'the workspace mutation';
    // A malformed marker names no operation a settle could match, so only the
    // host's stop proof removes it.
    const error = new Error(marker
        ? `This workspace has an unsettled activation (${marker.operation} ${shortId(marker.operationId)}); ${refused} was refused. `
            + 'Run `ploinky restart` on the host to settle it, or `ploinky stop`. '
            + `[${ACTIVATION_RECOVERY_REQUIRED}]`
        : `This workspace has an unreadable activation barrier marker; ${refused} was refused. A restart cannot remove it: `
            + 'run `ploinky stop` on the host, which removes it once the Box is stopped. '
            + `[${ACTIVATION_RECOVERY_REQUIRED}]`);
    error.code = ACTIVATION_RECOVERY_REQUIRED;
    return error;
}

/**
 * The in-Box barrier check of every new workspace lease. An absent marker
 * admits everything; a present or malformed marker refuses every DENY and
 * unknown operation (M9).
 */
export function assertActivationBarrierAdmits(operation, { workspaceRoot, fsApi = fs } = {}) {
    if (!workspaceRoot) return;
    const read = readActivationBarrierMarker({ workspaceRoot, fsApi });
    if (read.state === 'absent') return;
    const value = String(operation || '');
    if (classifyLeaseOperation(value) === 'admit') return;
    if (purposeAdmits(value, hostAdmittedActivation())) return;
    throw activationRecoveryRequiredError(value, read.state === 'present' ? read.marker : null);
}
