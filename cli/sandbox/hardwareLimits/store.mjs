// Hardware-limit policy store (plan §5). One host-created private directory,
// bound read-write into a gate-on Box at /run/ploinky/hardware-limits:
//   identity.json   store identity (instance, pathHash, root, storeId)
//   limits.json     policy document with {epoch, revision} CAS token
//   audit.log       append-only bounded audit (rotated, four generations)
//   transition.json downgrade write barrier (coordination data only)
//   write.lock/     the one portable store lock
// Every read is bounded and no-follow; every commit is an atomic private
// rename with directory fsync; a policy change and its audit event commit
// together through a one-event outbox.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isHardwareRef } from './errors.mjs';
import {
    LimitResolutionError,
    MIB,
    MIN_CPUS,
    MIN_GPU_SHARE_BYTES,
    isTwoDecimalCpus,
    resolveMemoryPercent,
} from './resolve.mjs';
import { acquireStoreLock } from './storeLock.mjs';

export {
    limitsHash,
    readEnvelope,
    resolveEffectiveLimits,
} from './resolve.mjs';

export const STORE_SCHEMA = 'ploinky.hardware-limits/v1';
export const BARRIER_SCHEMA = 'ploinky.hardware-write-barrier/v1';
export const BOX_STORE_ROOT = '/run/ploinky/hardware-limits';
export const HARDWARE_STATE_DIRECTORY = 'hardware-limits';
export const MAX_STORE_BYTES = 64 * 1024;
export const MAX_IDENTITY_BYTES = 4 * 1024;
export const MAX_BARRIER_BYTES = 4 * 1024;
export const MAX_AUDIT_EVENT_BYTES = 8 * 1024;
export const MAX_AGENT_ENTRIES = 256;
export const MAX_REQUEST_BYTES = 16 * 1024;
export const AUDIT_ROTATE_BYTES = 1024 * 1024;
export const AUDIT_GENERATIONS = 4;
export const U9_MESSAGE = (count) => `${count} agents have stored hardware limits. Turn the gate on with `
    + 'PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart, or run ploinky limits clear --agent REPO/AGENT or '
    + 'ploinky limits clear --all on the host. No Box mutation was performed.';

const HEX32 = /^[0-9a-f]{32}$/;
const IDENTITY_KEYS = ['schema', 'instance', 'pathHash', 'workspaceRoot', 'storeId', 'initializedAt'];
const DOCUMENT_KEYS = ['schema', 'instance', 'storeId', 'epoch', 'revision', 'updatedAt', 'agents', 'auditOutbox', 'auditReceipt'];
const ENTRY_KEYS = new Set(['cpus', 'memoryPercent', 'gpu']);
const GPU_KEYS = ['smPercent', 'vramPercent'];
const EVENT_KEYS = ['transactionId', 'time', 'actor', 'action', 'ref', 'before', 'after', 'token', 'result', 'reason'];
const BARRIER_KEYS = ['schema', 'operationId', 'instance', 'pathHash', 'storeId', 'fromEnabled', 'toEnabled', 'policyToken'];
const RESERVED_REF_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

export class HardwareStoreError extends Error {
    constructor(message, { code = 'invalid_limits', status, field = null, committed = false, token = null } = {}) {
        super(message);
        this.name = 'HardwareStoreError';
        this.code = code;
        this.status = status ?? STATUS_BY_CODE[code] ?? 400;
        this.field = field;
        if (committed) {
            this.committed = true;
            this.token = token;
        }
    }
}

const STATUS_BY_CODE = Object.freeze({
    invalid_json: 400,
    invalid_limits: 400,
    unknown_action: 400,
    unknown_agent: 404,
    revision_conflict: 409,
    identity_changed: 409,
    store_busy: 409,
    hardware_limits_transition: 409,
    hardware_limits_off: 409,
    controller_unavailable: 409,
    gpu_sharing_unavailable: 409,
    image_preparation_required: 409,
    exceeds_envelope: 422,
    store_unreadable: 503,
    audit_pending: 503,
    stored_limits_present: 409,
});

function fail(message, options) {
    throw new HardwareStoreError(message, options);
}

function randomHex(bytes = 16) {
    return crypto.randomBytes(bytes).toString('hex');
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function plainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label, { code = 'store_unreadable' } = {}) {
    if (!plainObject(value)) fail(`${label} must be an object`, { code });
    const allowed = new Set(keys);
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has unknown key '${key}'`, { code });
    for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} is missing '${key}'`, { code });
}

// ---------------------------------------------------------------------------
// Paths

export function hardwareStateRoot(homeDirectory = os.homedir()) {
    return path.join(path.resolve(homeDirectory), '.ploinky-box', HARDWARE_STATE_DIRECTORY);
}

/**
 * Fixed store paths for a validated identity. Host and Box roots are derived,
 * never supplied by a request.
 */
export function hardwareStorePaths({ identity, context = 'host', homeDirectory = os.homedir(), boxRoot = BOX_STORE_ROOT } = {}) {
    const instance = String(identity?.instance || '');
    if (!/^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/.test(instance)) {
        fail('hardware store paths require the exact workspace identity', { code: 'identity_changed' });
    }
    const storeRoot = context === 'box'
        ? path.resolve(boxRoot)
        : path.join(hardwareStateRoot(homeDirectory), instance, 'store');
    return Object.freeze({
        context,
        storeRoot,
        identityPath: path.join(storeRoot, 'identity.json'),
        policyPath: path.join(storeRoot, 'limits.json'),
        auditPath: path.join(storeRoot, 'audit.log'),
        barrierPath: path.join(storeRoot, 'transition.json'),
    });
}

// ---------------------------------------------------------------------------
// Bounded private reads and atomic commits

function readBoundedPrivate(fsApi, target, maxBytes, label) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(target, fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK);
    } catch (error) {
        if (error?.code === 'ENOENT') return { missing: true };
        return { problem: `${label} is not a readable regular file (${error?.code || 'error'})` };
    }
    try {
        const stat = fsApi.fstatSync(descriptor);
        if (!stat.isFile()) return { problem: `${label} is not a regular file` };
        if (stat.nlink !== 1) return { problem: `${label} has ${stat.nlink} links` };
        const uid = currentUid();
        if (uid !== null && stat.uid !== uid) return { problem: `${label} has an unexpected owner` };
        if ((stat.mode & 0o077) !== 0) return { problem: `${label} is not private (mode 0600)` };
        if (stat.size > maxBytes) return { problem: `${label} exceeds ${maxBytes} bytes` };
        const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
        let offset = 0;
        for (;;) {
            const read = fsApi.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
            if (read === 0) break;
            offset += read;
            if (offset > maxBytes) return { problem: `${label} grew beyond ${maxBytes} bytes while being read` };
            if (offset === buffer.length) break;
        }
        return { bytes: buffer.subarray(0, offset) };
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function fsyncDirectory(fsApi, directory) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(directory, fsApi.constants.O_RDONLY);
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        if (!['EISDIR', 'EINVAL', 'EPERM', 'EBADF'].includes(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) fsApi.closeSync(descriptor);
    }
}

function atomicPrivateWrite(fsApi, target, document, faults = {}, faultPrefix = '') {
    const directory = path.dirname(target);
    try {
        const existing = fsApi.lstatSync(target);
        if (existing.isSymbolicLink() || !existing.isFile()) fail(`refusing to replace non-regular ${path.basename(target)}`, { code: 'store_unreadable' });
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(directory, `.${path.basename(target)}.${randomHex(8)}.tmp`);
    let descriptor;
    try {
        descriptor = fsApi.openSync(temporary, fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT
            | fsApi.constants.O_EXCL | fsApi.constants.O_NOFOLLOW, 0o600);
        fsApi.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`);
        fsApi.fsyncSync(descriptor);
        fsApi.closeSync(descriptor);
        descriptor = undefined;
        faults[`${faultPrefix}beforeRename`]?.();
        fsApi.renameSync(temporary, target);
        fsyncDirectory(fsApi, directory);
        faults[`${faultPrefix}afterRename`]?.();
    } finally {
        if (descriptor !== undefined) fsApi.closeSync(descriptor);
        try { fsApi.unlinkSync(temporary); } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

function assertPrivateStoreDirectory(fsApi, storeRoot) {
    let stat;
    try {
        stat = fsApi.lstatSync(storeRoot);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('the hardware store path is not a real directory', { code: 'store_unreadable' });
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) fail('the hardware store directory has an unexpected owner', { code: 'store_unreadable' });
    if ((stat.mode & 0o077) !== 0) fail('the hardware store directory is not private (mode 0700)', { code: 'store_unreadable' });
    return true;
}

// ---------------------------------------------------------------------------
// Schema validation

export function validateStoreToken(token, { code = 'invalid_limits' } = {}) {
    if (!plainObject(token) || Object.keys(token).sort().join(',') !== 'epoch,revision'
        || !HEX32.test(String(token.epoch)) || !Number.isSafeInteger(token.revision) || token.revision < 1) {
        fail('the policy token must be {epoch:128-bit hex, revision:positive integer}', { code });
    }
    return Object.freeze({ epoch: token.epoch, revision: token.revision });
}

export function validateIdentityDocument(value, identity) {
    exactKeys(value, IDENTITY_KEYS, 'identity.json');
    if (value.schema !== 1) fail('identity.json has an unsupported schema', { code: 'store_unreadable' });
    if (!HEX32.test(String(value.storeId))) fail('identity.json storeId is not a random 128-bit identity', { code: 'store_unreadable' });
    if (Number.isNaN(Date.parse(value.initializedAt))) fail('identity.json initializedAt is invalid', { code: 'store_unreadable' });
    if (identity && (value.instance !== identity.instance || value.pathHash !== identity.pathHash
        || value.workspaceRoot !== identity.workspaceRoot)) {
        fail('the hardware store belongs to a different workspace identity', { code: 'identity_changed' });
    }
    return Object.freeze({ ...value });
}

function validateGpuEntry(value, label, code) {
    exactKeys(value, GPU_KEYS, label, { code });
    for (const key of GPU_KEYS) {
        if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 100) {
            fail(`${label}.${key} must be an integer from 1 to 100`, { code, field: 'gpu' });
        }
    }
    return Object.freeze({ smPercent: value.smPercent, vramPercent: value.vramPercent });
}

// Structural validation shared by store reads and writes.
export function validateAgentEntry(value, label = 'limits', { code = 'store_unreadable' } = {}) {
    if (!plainObject(value)) fail(`${label} must be an object`, { code });
    const keys = Object.keys(value);
    if (!keys.length) fail(`${label} must contain at least one limit`, { code });
    for (const key of keys) {
        if (!ENTRY_KEYS.has(key)) fail(`${label} has unsupported field '${key}'`, { code, field: key });
    }
    const entry = {};
    if (value.cpus !== undefined) {
        if (!isTwoDecimalCpus(value.cpus) || value.cpus < MIN_CPUS) {
            fail(`${label}.cpus must be a number of at least ${MIN_CPUS} with at most two decimals`, { code, field: 'cpus' });
        }
        entry.cpus = value.cpus;
    }
    if (value.memoryPercent !== undefined) {
        if (!Number.isInteger(value.memoryPercent) || value.memoryPercent < 1 || value.memoryPercent > 100) {
            fail(`${label}.memoryPercent must be an integer from 1 to 100`, { code, field: 'memoryPercent' });
        }
        entry.memoryPercent = value.memoryPercent;
    }
    if (value.gpu !== undefined) entry.gpu = validateGpuEntry(value.gpu, `${label}.gpu`, code);
    return Object.freeze(entry);
}

export function validateAgentRef(ref, { code = 'invalid_limits' } = {}) {
    if (!isHardwareRef(ref)) fail('agentRef must be exactly REPO/AGENT', { code, field: 'agentRef' });
    for (const part of ref.split('/')) {
        if (RESERVED_REF_PARTS.has(part)) fail('agentRef uses a reserved name', { code, field: 'agentRef' });
    }
    return ref;
}

function validateAuditEvent(value) {
    exactKeys(value, EVENT_KEYS, 'audit event');
    if (!HEX32.test(value.transactionId)) fail('audit event transactionId is invalid');
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_AUDIT_EVENT_BYTES) fail('audit event exceeds 8 KiB');
    if (value.action === 'clear-all') {
        if (plainObject(value.before) && Object.hasOwn(value.before, 'count')) {
            exactKeys(value.before, ['count', 'sha256'], 'clear-all audit summary');
            if (!Number.isInteger(value.before.count) || value.before.count < 0 || value.before.count > MAX_AGENT_ENTRIES
                || !/^[0-9a-f]{64}$/.test(value.before.sha256)) fail('clear-all audit summary is invalid');
        } else {
            // Previously committed bounded v1 outboxes remain recoverable.
            if (!plainObject(value.before) || Object.keys(value.before).length > MAX_AGENT_ENTRIES) {
                fail('clear-all audit prior entries are invalid');
            }
            for (const [ref, entry] of Object.entries(value.before)) {
                validateAgentRef(ref);
                validateAgentEntry(entry);
            }
        }
        exactKeys(value.after, [], 'clear-all audit after');
        if (value.ref !== null) fail('clear-all audit ref must be null');
    }
    return value;
}

export function validateStoreDocument(value, { identityDocument = null } = {}) {
    exactKeys(value, DOCUMENT_KEYS, 'limits.json');
    if (value.schema !== STORE_SCHEMA) fail('limits.json has an unsupported schema', { code: 'store_unreadable' });
    validateStoreToken({ epoch: value.epoch, revision: value.revision }, { code: 'store_unreadable' });
    if (identityDocument && (value.instance !== identityDocument.instance || value.storeId !== identityDocument.storeId)) {
        fail('limits.json does not belong to this store identity', { code: 'store_unreadable' });
    }
    if (Number.isNaN(Date.parse(value.updatedAt))) fail('limits.json updatedAt is invalid', { code: 'store_unreadable' });
    if (!plainObject(value.agents)) fail('limits.json agents must be an object', { code: 'store_unreadable' });
    const refs = Object.keys(value.agents);
    if (refs.length > MAX_AGENT_ENTRIES) fail(`limits.json has more than ${MAX_AGENT_ENTRIES} agent entries`, { code: 'store_unreadable' });
    const agents = new Map();
    for (const ref of refs) {
        validateAgentRef(ref, { code: 'store_unreadable' });
        agents.set(ref, validateAgentEntry(value.agents[ref], `limits.json agents.${ref}`));
    }
    if (value.auditOutbox !== null) validateAuditEvent(value.auditOutbox);
    if (value.auditReceipt !== null) {
        exactKeys(value.auditReceipt, ['transactionId', 'lastFlushedAt'], 'auditReceipt');
        if (!HEX32.test(value.auditReceipt.transactionId)) fail('auditReceipt transactionId is invalid', { code: 'store_unreadable' });
    }
    return { document: value, agents };
}

// ---------------------------------------------------------------------------
// Snapshot

function parseJson(bytes, label) {
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch (_) {
        fail(`${label} is not valid JSON`, { code: 'store_unreadable' });
        return null;
    }
}

/**
 * Bounded read-only snapshot. A never-initialized host store with no
 * directory is the only absent-but-empty case; in a Box, or once identity.json
 * exists, a missing limits.json is unreadable state, never an empty policy.
 */
export function readStoreSnapshot({ paths, identity = null, fsApi = fs } = {}) {
    try {
        const present = assertPrivateStoreDirectory(fsApi, paths.storeRoot);
        if (!present) {
            if (paths.context === 'box') fail('the bound hardware store is missing', { code: 'store_unreadable' });
            return Object.freeze({ status: 'absent-never-initialized', token: null, agents: new Map(), storeId: null, diagnostic: null });
        }
        const identityRead = readBoundedPrivate(fsApi, paths.identityPath, MAX_IDENTITY_BYTES, 'identity.json');
        if (identityRead.missing) fail('identity.json is missing from an existing store directory', { code: 'store_unreadable' });
        if (identityRead.problem) fail(identityRead.problem, { code: 'store_unreadable' });
        const identityDocument = validateIdentityDocument(parseJson(identityRead.bytes, 'identity.json'), identity);
        const policyRead = readBoundedPrivate(fsApi, paths.policyPath, MAX_STORE_BYTES, 'limits.json');
        if (policyRead.missing) fail('limits.json is missing from an initialized store', { code: 'store_unreadable' });
        if (policyRead.problem) fail(policyRead.problem, { code: 'store_unreadable' });
        const { document, agents } = validateStoreDocument(parseJson(policyRead.bytes, 'limits.json'), { identityDocument });
        return Object.freeze({
            status: 'valid',
            token: Object.freeze({ epoch: document.epoch, revision: document.revision }),
            agents,
            storeId: identityDocument.storeId,
            identityDocument,
            document,
            diagnostic: null,
        });
    } catch (error) {
        if (error instanceof HardwareStoreError && error.code === 'identity_changed') throw error;
        return Object.freeze({
            status: 'unreadable',
            token: null,
            agents: new Map(),
            storeId: null,
            diagnostic: String(error?.message || error).slice(0, 512),
        });
    }
}

// ---------------------------------------------------------------------------
// Initialization (host only, before the first gate-on Box)

export function initializeStore({ paths, identity, fsApi = fs, now = () => new Date() } = {}) {
    if (paths.context !== 'host') fail('only the host initializes the hardware store', { code: 'store_unreadable' });
    fsApi.mkdirSync(path.dirname(paths.storeRoot), { recursive: true, mode: 0o700 });
    try {
        fsApi.mkdirSync(paths.storeRoot, { mode: 0o700 });
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const snapshot = readStoreSnapshot({ paths, identity, fsApi });
        if (snapshot.status === 'valid') return snapshot;
        fail(`the existing hardware store cannot be read safely: ${snapshot.diagnostic}`, { code: 'store_unreadable' });
    }
    assertPrivateStoreDirectory(fsApi, paths.storeRoot);
    const storeId = randomHex();
    const initializedAt = now().toISOString();
    atomicPrivateWrite(fsApi, paths.identityPath, {
        schema: 1,
        instance: identity.instance,
        pathHash: identity.pathHash,
        workspaceRoot: identity.workspaceRoot,
        storeId,
        initializedAt,
    });
    atomicPrivateWrite(fsApi, paths.policyPath, {
        schema: STORE_SCHEMA,
        instance: identity.instance,
        storeId,
        epoch: randomHex(),
        revision: 1,
        updatedAt: initializedAt,
        agents: {},
        auditOutbox: null,
        auditReceipt: null,
    });
    return readStoreSnapshot({ paths, identity, fsApi });
}

// ---------------------------------------------------------------------------
// Audit

function boundedActor(actor) {
    return {
        id: String(actor?.id ?? 'unknown').slice(0, 128),
        name: String(actor?.name ?? '').slice(0, 128),
    };
}

function auditEvent({ action, ref, before, after, token, result, reason = null, actor, now, transactionId = randomHex() }) {
    return validateAuditEvent({
        transactionId,
        time: now().toISOString(),
        actor: boundedActor(actor),
        action,
        ref: ref ?? null,
        before: before ?? null,
        after: after ?? null,
        token: token ?? null,
        result,
        reason: reason === null ? null : String(reason).slice(0, 512),
    });
}

function assertAuditTarget(fsApi, auditPath) {
    try {
        const stat = fsApi.lstatSync(auditPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
            fail('audit.log is not a single regular file', { code: 'audit_pending' });
        }
        const uid = currentUid();
        if (uid !== null && stat.uid !== uid) fail('audit.log has an unexpected owner', { code: 'audit_pending' });
        return stat;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function rotateAudit(fsApi, auditPath) {
    for (let generation = AUDIT_GENERATIONS; generation >= 1; generation -= 1) {
        const from = generation === 1 ? auditPath : `${auditPath}.${generation - 1}`;
        const to = `${auditPath}.${generation}`;
        try {
            if (generation === AUDIT_GENERATIONS) {
                try { fsApi.unlinkSync(to); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
            }
            fsApi.renameSync(from, to);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

// Bounded duplicate check: only the tail of the current log is read.
function auditTailContains(fsApi, auditPath, transactionId) {
    const stat = assertAuditTarget(fsApi, auditPath);
    if (!stat) return false;
    const length = Math.min(stat.size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    const descriptor = fsApi.openSync(auditPath, fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW);
    try {
        fsApi.readSync(descriptor, buffer, 0, length, stat.size - length);
    } finally {
        fsApi.closeSync(descriptor);
    }
    return buffer.toString('utf8').includes(`"transactionId":"${transactionId}"`);
}

function appendAudit(fsApi, auditPath, event) {
    const stat = assertAuditTarget(fsApi, auditPath);
    if (stat && stat.size >= AUDIT_ROTATE_BYTES) rotateAudit(fsApi, auditPath);
    const descriptor = fsApi.openSync(auditPath, fsApi.constants.O_WRONLY | fsApi.constants.O_APPEND
        | fsApi.constants.O_CREAT | fsApi.constants.O_NOFOLLOW, 0o600);
    try {
        const opened = fsApi.fstatSync(descriptor);
        if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0) {
            fail('audit.log is not a private single regular file', { code: 'audit_pending' });
        }
        fsApi.writeSync(descriptor, `${JSON.stringify(event)}\n`);
        fsApi.fsyncSync(descriptor);
    } finally {
        fsApi.closeSync(descriptor);
    }
}

/**
 * Flush a pending outbox event to audit.log (deduplicated by transaction ID),
 * then clear the outbox atomically without changing the policy revision.
 */
export function recoverAuditOutbox({ paths, snapshot, fsApi = fs, faults = {}, now = () => new Date() }) {
    const document = snapshot.document;
    if (!document?.auditOutbox) return { auditPending: false, document };
    const event = document.auditOutbox;
    try {
        if (!auditTailContains(fsApi, paths.auditPath, event.transactionId)) {
            faults.duringAuditFlush?.();
            appendAudit(fsApi, paths.auditPath, event);
        }
        faults.beforeOutboxClear?.();
        const next = {
            ...document,
            auditOutbox: null,
            auditReceipt: { transactionId: event.transactionId, lastFlushedAt: now().toISOString() },
        };
        atomicPrivateWrite(fsApi, paths.policyPath, next);
        return { auditPending: false, document: next };
    } catch (error) {
        return { auditPending: true, document, error };
    }
}

// ---------------------------------------------------------------------------
// Barrier

export function validateBarrier(value) {
    exactKeys(value, BARRIER_KEYS, 'transition.json');
    if (value.schema !== BARRIER_SCHEMA) fail('transition.json has an unsupported schema', { code: 'store_unreadable' });
    if (!HEX32.test(value.operationId) || !HEX32.test(value.storeId)) fail('transition.json identities are invalid', { code: 'store_unreadable' });
    if (value.fromEnabled !== true || value.toEnabled !== false) fail('transition.json must describe a gate-on to gate-off downgrade', { code: 'store_unreadable' });
    validateStoreToken(value.policyToken, { code: 'store_unreadable' });
    return Object.freeze({ ...value });
}

// null when absent; {malformed:true} when present but invalid (blocks
// mutations, never reads or admission).
export function readBarrier({ paths, fsApi = fs }) {
    const read = readBoundedPrivate(fsApi, paths.barrierPath, MAX_BARRIER_BYTES, 'transition.json');
    if (read.missing) return null;
    if (read.problem) return { malformed: true, reason: read.problem };
    try {
        return { malformed: false, barrier: validateBarrier(JSON.parse(read.bytes.toString('utf8'))) };
    } catch (error) {
        return { malformed: true, reason: String(error?.message || error).slice(0, 256) };
    }
}

function assertNoBarrier(paths, fsApi) {
    const barrier = readBarrier({ paths, fsApi });
    if (barrier) {
        fail('A gate-on to gate-off transition is pending; run ploinky restart on the host to complete recovery.', {
            code: 'hardware_limits_transition',
        });
    }
}

// Policy setters, clear and Apply refuse while a downgrade barrier (valid or
// malformed) is pending; reads, admission and watchdog restarts never call it.
export function assertPolicyWritesAllowed({ paths, fsApi = fs }) {
    assertNoBarrier(paths, fsApi);
    return true;
}

// ---------------------------------------------------------------------------
// Validation against the current context (write time)

/**
 * Write-time validation of one override. `capabilities` carries the current
 * gate/controller facts and GPU eligibility; nothing here pulls images,
 * starts daemons or mutates the host.
 */
export function validateAgentLimits({
    agentRef,
    limits,
    installedRefs = new Set(),
    capabilities = {},
    envelope = null,
}) {
    validateAgentRef(agentRef);
    if (!installedRefs.has(agentRef)) fail(`agent ${agentRef} is not installed`, { code: 'unknown_agent', field: 'agentRef' });
    const entry = validateAgentEntry(limits, 'limits', { code: 'invalid_limits' });
    if (capabilities.gate && capabilities.gate !== 'on') {
        fail('Hardware limits are off for this workspace. On the host run PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart.', { code: 'hardware_limits_off' });
    }
    const controllers = new Set(capabilities.controllers || ['cpu', 'memory', 'pids']);
    if (entry.cpus !== undefined) {
        if (!controllers.has('cpu')) fail('The host does not delegate cpu to rootless Podman.', { code: 'controller_unavailable', field: 'cpus' });
        if (envelope && entry.cpus > envelope.cpus) {
            fail(`cpus ${entry.cpus} exceeds the Box envelope of ${envelope.cpus}`, { code: 'exceeds_envelope', field: 'cpus' });
        }
    }
    let memoryBytes = null;
    if (entry.memoryPercent !== undefined) {
        if (!controllers.has('memory')) fail('The host does not delegate memory to rootless Podman.', { code: 'controller_unavailable', field: 'memoryPercent' });
        try {
            memoryBytes = resolveMemoryPercent(entry.memoryPercent, envelope?.memoryBytes);
        } catch (error) {
            if (error instanceof LimitResolutionError) fail(error.message, { code: error.code === 'invalid_limits' ? 'exceeds_envelope' : error.code, field: 'memoryPercent' });
            throw error;
        }
    }
    let gpuBytes = null;
    if (entry.gpu !== undefined) {
        const gpu = capabilities.gpu || { eligible: false, code: 'gpu_sharing_unavailable', reason: 'GPU sharing is not available in this Box.' };
        if (gpu.memoryModel === 'unified' || gpu.memoryModel === 'unknown') {
            fail(`GPU sharing is unsupported on this unified or unverified GPU memory model: ${gpu.name || 'unknown'}. Clear the GPU share.`, { code: 'gpu_sharing_unavailable', field: 'gpu' });
        }
        if (gpu.eligible !== true) fail(gpu.reason || 'GPU sharing is not available in this Box.', { code: gpu.code || 'gpu_sharing_unavailable', field: 'gpu' });
        if (gpu.imageUserKnown === false) {
            fail("The GPU image's immutable user is not available for validation. Prepare the image through the normal agent startup path, then save the share. No image was pulled by this settings request.", { code: 'image_preparation_required', field: 'gpu' });
        }
        if (!Number.isSafeInteger(gpu.deviceMemoryBytes) || gpu.deviceMemoryBytes <= 0) {
            fail('The GPU device memory is unknown.', { code: 'gpu_sharing_unavailable', field: 'gpu' });
        }
        gpuBytes = Math.floor((entry.gpu.vramPercent * gpu.deviceMemoryBytes) / 100 / MIB) * MIB;
        if (gpuBytes < MIN_GPU_SHARE_BYTES) {
            fail(`vramPercent ${entry.gpu.vramPercent} resolves to ${gpuBytes / MIB} MiB, below the 512 MiB minimum`, { code: 'exceeds_envelope', field: 'gpu' });
        }
    }
    return Object.freeze({ entry, memoryBytes, gpuBytes });
}

// Bounded request-body parser shared with the router API.
export function parseLimitsRequestBody(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8');
    if (bytes.length > MAX_REQUEST_BYTES) fail(`request body exceeds ${MAX_REQUEST_BYTES} bytes`, { code: 'invalid_limits', status: 413 });
    try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!plainObject(parsed)) fail('request body must be a JSON object', { code: 'invalid_json' });
        return parsed;
    } catch (error) {
        if (error instanceof HardwareStoreError) throw error;
        fail('request body is not valid JSON', { code: 'invalid_json' });
        return null;
    }
}

// ---------------------------------------------------------------------------
// Mutations

function lockOptions(paths, operation, options) {
    return {
        storeRoot: paths.storeRoot,
        operation,
        ...(options.lockOptions || {}),
    };
}

function requireValid(snapshot) {
    if (snapshot.status === 'unreadable') {
        fail(`The hardware policy store cannot be read safely: ${snapshot.diagnostic}.`, { code: 'store_unreadable' });
    }
    if (snapshot.status !== 'valid') fail('The hardware policy store has not been initialized.', { code: 'store_unreadable' });
    return snapshot;
}

function compareToken(snapshot, expectedToken) {
    const expected = validateStoreToken(expectedToken);
    if (expected.epoch !== snapshot.token.epoch || expected.revision !== snapshot.token.revision) {
        fail('The hardware policy changed since it was read; reload and retry.', { code: 'revision_conflict' });
    }
}

function commitPolicy({ paths, snapshot, agents, event, fsApi, faults, now }) {
    const document = snapshot.document;
    const next = {
        ...document,
        revision: document.revision + 1,
        updatedAt: now().toISOString(),
        agents: Object.fromEntries([...agents].sort(([a], [b]) => a.localeCompare(b))),
        auditOutbox: { ...event, token: { epoch: document.epoch, revision: document.revision + 1 } },
    };
    // Validate the exact persisted representation, including the pending audit
    // event, before replacing the readable policy and advancing its CAS token.
    try {
        validateStoreDocument(next, { identityDocument: snapshot.identityDocument });
    } catch (error) {
        if (!(error instanceof HardwareStoreError)) throw error;
        fail(error.message, { code: 'invalid_limits' });
    }
    if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`) > MAX_STORE_BYTES) {
        fail(`limits.json would exceed ${MAX_STORE_BYTES} bytes`, { code: 'invalid_limits' });
    }
    atomicPrivateWrite(fsApi, paths.policyPath, next, faults);
    const token = Object.freeze({ epoch: next.epoch, revision: next.revision });
    const flushed = recoverAuditOutbox({ paths, snapshot: { document: next }, fsApi, faults, now });
    return { token, auditPending: flushed.auditPending };
}

function committedResult(result, extra = {}) {
    if (result.auditPending) {
        // The policy committed; only the audit flush is pending.
        throw new HardwareStoreError('The policy change was committed, but its audit record is pending; reload before retrying.', {
            code: 'audit_pending',
            committed: true,
            token: result.token,
        });
    }
    return Object.freeze({ committed: true, token: result.token, auditPending: false, ...extra });
}

function recordRefusedAttempt({ paths, fsApi, now, actor, action, ref, reason }) {
    try {
        appendAudit(fsApi, paths.auditPath, auditEvent({ action: `refused-${action}`, ref, actor, now, result: 'refused', reason }));
    } catch (_) {
        // The refusal itself is returned to the caller; an unavailable audit
        // destination is reported by status, never silently treated as clean.
    }
}

function prepareMutation({ paths, identity, expectedToken, fsApi, now }) {
    const snapshot = requireValid(readStoreSnapshot({ paths, identity, fsApi }));
    if (snapshot.document.auditOutbox) {
        const recovered = recoverAuditOutbox({ paths, snapshot, fsApi, now });
        if (recovered.auditPending) {
            fail('A previous policy change has an undelivered audit record; the store refused a new change.', { code: 'audit_pending' });
        }
    }
    const current = requireValid(readStoreSnapshot({ paths, identity, fsApi }));
    assertNoBarrier(paths, fsApi);
    if (expectedToken !== undefined) compareToken(current, expectedToken);
    return current;
}

export function setAgentLimits({
    paths, identity, expectedToken, agentRef, limits, actor = null,
    installedRefs, capabilities, envelope, fsApi = fs, faults = {}, now = () => new Date(), lockOptions: lockOverrides,
    beforeCommit = () => true,
} = {}) {
    const lock = acquireStoreLock(lockOptions(paths, 'set_agent_limits', { lockOptions: lockOverrides }));
    try {
        const snapshot = prepareMutation({ paths, identity, expectedToken, fsApi, now });
        if (beforeCommit() !== true) fail('The authenticated authority changed while waiting for the policy lock.', { code: 'identity_changed' });
        let validated;
        try {
            validated = validateAgentLimits({ agentRef, limits, installedRefs, capabilities, envelope });
        } catch (error) {
            recordRefusedAttempt({ paths, fsApi, now, actor, action: 'set', ref: typeof agentRef === 'string' ? agentRef.slice(0, 257) : null, reason: error.message });
            throw error;
        }
        const agents = new Map(snapshot.agents);
        const before = agents.get(agentRef) || null;
        agents.set(agentRef, validated.entry);
        const event = auditEvent({ action: 'set', ref: agentRef, before, after: validated.entry, actor, now, result: 'committed' });
        const result = commitPolicy({ paths, snapshot, agents, event, fsApi, faults, now });
        return committedResult(result, { effective: validated });
    } finally {
        lock.release();
    }
}

export function clearAgentLimits({
    paths, identity, expectedToken, agentRef, actor = null, fsApi = fs, faults = {}, now = () => new Date(), lockOptions: lockOverrides,
    beforeCommit = () => true,
} = {}) {
    validateAgentRef(agentRef);
    const lock = acquireStoreLock(lockOptions(paths, 'clear_agent_limits', { lockOptions: lockOverrides }));
    try {
        const snapshot = prepareMutation({ paths, identity, expectedToken, fsApi, now });
        if (beforeCommit() !== true) fail('The authenticated authority changed while waiting for the policy lock.', { code: 'identity_changed' });
        const agents = new Map(snapshot.agents);
        const before = agents.get(agentRef) || null;
        agents.delete(agentRef);
        const event = auditEvent({ action: 'clear', ref: agentRef, before, after: null, actor, now, result: 'committed' });
        return committedResult(commitPolicy({ paths, snapshot, agents, event, fsApi, faults, now }), { cleared: Boolean(before) });
    } finally {
        lock.release();
    }
}

/**
 * Host clear of every entry. A readable store increments its revision; an
 * unreadable limits.json is quarantined (exact owned regular file only) and
 * replaced by a fresh random epoch at revision 1, so no earlier token can
 * match. identity.json and storeId are preserved.
 */
export function clearAllLimits({
    paths, identity, actor = null, fsApi = fs, faults = {}, now = () => new Date(), lockOptions: lockOverrides,
} = {}) {
    if (paths.context !== 'host') fail('clear --all is a host recovery command', { code: 'unknown_action' });
    const present = assertPrivateStoreDirectory(fsApi, paths.storeRoot);
    if (!present) return Object.freeze({ committed: false, token: null, reset: false, absent: true });
    assertNoBarrier(paths, fsApi);
    const lock = acquireStoreLock(lockOptions(paths, 'clear_all', { lockOptions: lockOverrides }));
    try {
        const snapshot = readStoreSnapshot({ paths, identity, fsApi });
        if (snapshot.status === 'valid') {
            // The outbox holds one event (§5.4): recover it before this write,
            // and never overwrite an undelivered one (§5.3 line 235).
            if (snapshot.document.auditOutbox) {
                const recovered = recoverAuditOutbox({ paths, snapshot, fsApi, now });
                if (recovered.auditPending) {
                    fail(`A previous policy change (transaction ${snapshot.document.auditOutbox.transactionId}) has an undelivered `
                        + `audit record, so clear --all was refused to keep it. Repair ${paths.auditPath} (it must be a regular, `
                        + `non-symlinked file owned by you with mode 0600, or absent so it is recreated; reason: `
                        + `${String(recovered.error?.message || 'unknown').slice(0, 256)}), then run ploinky limits clear --all again. `
                        + 'No policy was changed.', { code: 'audit_pending' });
                }
            }
            const current = requireValid(readStoreSnapshot({ paths, identity, fsApi }));
            const event = auditEvent({
                action: 'clear-all', ref: null,
                before: {
                    count: current.agents.size,
                    sha256: crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(
                        [...current.agents].sort(([a], [b]) => a.localeCompare(b)),
                    ))).digest('hex'),
                },
                after: {}, actor, now, result: 'committed',
            });
            return committedResult(commitPolicy({ paths, snapshot: current, agents: new Map(), event, fsApi, faults, now }), { reset: false });
        }
        const identityRead = readBoundedPrivate(fsApi, paths.identityPath, MAX_IDENTITY_BYTES, 'identity.json');
        if (identityRead.missing || identityRead.problem) {
            fail(`identity.json cannot be read safely (${identityRead.problem || 'missing'}); restore it or destroy this workspace's Box state`, { code: 'store_unreadable' });
        }
        const identityDocument = validateIdentityDocument(parseJson(identityRead.bytes, 'identity.json'), identity);
        let quarantined = null;
        try {
            const stat = fsApi.lstatSync(paths.policyPath);
            const uid = currentUid();
            if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (uid === null || stat.uid === uid)) {
                quarantined = `${paths.policyPath}.corrupt-${now().getTime()}-${randomHex(4)}`;
                fsApi.renameSync(paths.policyPath, quarantined);
            } else {
                fail('limits.json is not an owned regular file; it was left in place for inspection', { code: 'store_unreadable' });
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        const epoch = randomHex();
        const event = auditEvent({ action: 'reset', ref: null, before: null, after: {}, actor, now, result: 'committed',
            reason: quarantined ? `quarantined ${path.basename(quarantined)}` : 'limits.json was missing',
            token: { epoch, revision: 1 } });
        atomicPrivateWrite(fsApi, paths.policyPath, {
            schema: STORE_SCHEMA,
            instance: identityDocument.instance,
            storeId: identityDocument.storeId,
            epoch,
            revision: 1,
            updatedAt: now().toISOString(),
            agents: {},
            auditOutbox: event,
            auditReceipt: null,
        }, faults);
        const flushed = recoverAuditOutbox({ paths, snapshot: readStoreSnapshot({ paths, identity, fsApi }), fsApi, faults, now });
        return committedResult({ token: { epoch, revision: 1 }, auditPending: flushed.auditPending }, { reset: true, quarantined });
    } finally {
        lock.release();
    }
}

/**
 * U9: a gate-off create, replacement or start requires a provably empty
 * store. Unknown or unreadable contents are a failure, never zero.
 */
export function assertGateOffStoreEmpty({ paths, identity, fsApi = fs, lockOptions: lockOverrides } = {}) {
    const present = assertPrivateStoreDirectory(fsApi, paths.storeRoot);
    if (!present) return Object.freeze({ storeId: null, token: null, count: 0, initialized: false });
    const lock = acquireStoreLock(lockOptions(paths, 'gate_off_guard', { lockOptions: lockOverrides }));
    try {
        const snapshot = readStoreSnapshot({ paths, identity, fsApi });
        if (snapshot.status !== 'valid') {
            fail(`The hardware policy store cannot be read safely: ${snapshot.diagnostic}. On the host run ploinky limits clear --all to reset it, or restore a valid private store, then ploinky restart. No Box mutation was performed.`, { code: 'store_unreadable' });
        }
        if (snapshot.agents.size > 0) fail(U9_MESSAGE(snapshot.agents.size), { code: 'stored_limits_present' });
        return Object.freeze({ storeId: snapshot.storeId, token: snapshot.token, count: 0, initialized: true });
    } finally {
        lock.release();
    }
}

/**
 * The read-only U9 preflight: the same emptiness rule as
 * assertGateOffStoreEmpty, from one consistent snapshot (each file is
 * replaced atomically) and without the store lock, so a caller that holds no
 * host workspace lock never takes the store lock out of the §5.2 order. It is
 * advisory only: the authoritative check runs under the workspace lock before
 * any Box mutation.
 */
export function peekGateOffStoreEmpty({ paths, identity, fsApi = fs } = {}) {
    const snapshot = readStoreSnapshot({ paths, identity, fsApi });
    if (snapshot.status === 'absent-never-initialized') {
        return Object.freeze({ storeId: null, token: null, count: 0, initialized: false });
    }
    if (snapshot.status !== 'valid') {
        fail(`The hardware policy store cannot be read safely: ${snapshot.diagnostic}. On the host run ploinky limits clear --all to reset it, or restore a valid private store, then ploinky restart. No Box mutation was performed.`, { code: 'store_unreadable' });
    }
    if (snapshot.agents.size > 0) fail(U9_MESSAGE(snapshot.agents.size), { code: 'stored_limits_present' });
    return Object.freeze({ storeId: snapshot.storeId, token: snapshot.token, count: 0, initialized: true });
}

/** Install the downgrade write barrier after an authoritative empty read. */
export function beginDowngradeBarrier({
    paths, identity, operationId, expectedEmptyToken, fsApi = fs, lockOptions: lockOverrides,
} = {}) {
    if (!HEX32.test(String(operationId))) fail('downgrade operation ID must be 128-bit hex', { code: 'invalid_limits' });
    const lock = acquireStoreLock(lockOptions(paths, 'downgrade_barrier', { lockOptions: lockOverrides }));
    try {
        const snapshot = requireValid(readStoreSnapshot({ paths, identity, fsApi }));
        if (snapshot.agents.size > 0) fail(U9_MESSAGE(snapshot.agents.size), { code: 'stored_limits_present' });
        if (expectedEmptyToken) compareToken(snapshot, expectedEmptyToken);
        const existing = readBarrier({ paths, fsApi });
        if (existing && !(existing.malformed === false && existing.barrier.operationId === operationId)) {
            fail('Another hardware transition barrier is pending.', { code: 'hardware_limits_transition' });
        }
        const barrier = validateBarrier({
            schema: BARRIER_SCHEMA,
            operationId,
            instance: identity.instance,
            pathHash: identity.pathHash,
            storeId: snapshot.storeId,
            fromEnabled: true,
            toEnabled: false,
            policyToken: { epoch: snapshot.token.epoch, revision: snapshot.token.revision },
        });
        atomicPrivateWrite(fsApi, paths.barrierPath, barrier);
        return Object.freeze({ barrier, token: snapshot.token });
    } finally {
        lock.release();
    }
}

/** Remove the exact barrier of one operation (verify-before-unlink). */
export function removeDowngradeBarrier({
    paths, identity, operationId, requireEmpty = true, fsApi = fs, lockOptions: lockOverrides,
} = {}) {
    const lock = acquireStoreLock(lockOptions(paths, 'downgrade_barrier_remove', { lockOptions: lockOverrides }));
    try {
        const existing = readBarrier({ paths, fsApi });
        if (!existing) return Object.freeze({ removed: false });
        if (existing.malformed || existing.barrier.operationId !== operationId) {
            fail('The pending transition barrier belongs to another operation.', { code: 'hardware_limits_transition' });
        }
        if (requireEmpty) {
            const snapshot = requireValid(readStoreSnapshot({ paths, identity, fsApi }));
            if (snapshot.agents.size > 0) fail(U9_MESSAGE(snapshot.agents.size), { code: 'stored_limits_present' });
        }
        fsApi.unlinkSync(paths.barrierPath);
        fsyncDirectory(fsApi, paths.storeRoot);
        return Object.freeze({ removed: true });
    } finally {
        lock.release();
    }
}

/**
 * Private-path confinement (plan §4): no writable Box source may overlap the
 * host hardware state, and the MPS pipe path is reserved.
 */
export const MPS_PIPE_TARGET = '/run/ploinky-mps-pipe';

function containsPath(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realpathNearest(target, fsApi) {
    let current = path.resolve(target);
    const suffix = [];
    for (;;) {
        try {
            return path.join(fsApi.realpathSync.native(current), ...suffix.reverse());
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(target);
            suffix.push(path.basename(current));
            current = parent;
        }
    }
}

export function assertHardwareStateConfined({ workspaceRoot, dataPaths = {}, homeDirectory = os.homedir(), fsApi = fs } = {}) {
    const protectedRoot = realpathNearest(hardwareStateRoot(homeDirectory), fsApi);
    const boxRoot = path.dirname(protectedRoot);
    for (const source of [workspaceRoot, ...Object.values(dataPaths)]) {
        if (!source) continue;
        const writable = realpathNearest(source, fsApi);
        if (containsPath(writable, protectedRoot) || containsPath(protectedRoot, writable)
            || containsPath(writable, boxRoot) || containsPath(boxRoot, writable)) {
            fail(`Hardware state ${protectedRoot} overlaps writable Box source ${source}; choose workspace and cache paths outside the host control-state directory`, { code: 'identity_changed', status: 409 });
        }
    }
    if (workspaceRoot && path.resolve(workspaceRoot) === MPS_PIPE_TARGET) {
        fail(`The workspace root may not be the reserved MPS pipe path ${MPS_PIPE_TARGET}`, { code: 'identity_changed', status: 409 });
    }
    return true;
}
