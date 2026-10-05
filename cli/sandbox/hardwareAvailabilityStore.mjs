// Durable hardware-availability store (M-NW-01 D1): the deny-only availability
// policy of a workspace, kept beside the edge routing sources.
//
//   .ploinky/data/edge-routing/hardware-availability.witness.json   initialization witness (outside the store directory)
//   .ploinky/data/edge-routing/hardware-availability/policy.json    the policy; its rename is the only commit
//
// This module is mechanism only: it reads and validates, installs, restores
// the witness, commits one rename and sweeps dead-owner temporaries. It
// authorizes nothing. Every mutation requires the caller to prove the edge
// apply lock (`assertApplyLock(paths)`), and only `initializeFreshEdgeRoutingSources`
// may install or restore. It takes already-resolved edge generation `paths`
// and imports nothing from edgeGeneration.js, so there is no import cycle.
//
// "Never initialized" means the witness AND the directory are both absent.
// Once either exists, a missing or invalid member fails closed: no code path
// turns a committed denial into an empty policy.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { validateAvailabilityProjection } from '../server/hardwareAvailability.mjs';
import {
    MAX_NO_WAIT_WAVE_INDEX,
    exactRunId,
} from '../commands/noWaitIdentity.js';

export const HARDWARE_AVAILABILITY_SCHEMA = 'ploinky.hardware-availability/v1';
export const HARDWARE_AVAILABILITY_WITNESS_SCHEMA = 1;
export const HARDWARE_AVAILABILITY_ABSENT_REVISION = 'absent';
export const MAX_HARDWARE_AVAILABILITY_POLICY_BYTES = 1024 * 1024;
export const MAX_HARDWARE_AVAILABILITY_WITNESS_BYTES = 4096;
export const MAX_HARDWARE_AVAILABILITY_ENTRIES = 256;
export const MAX_HARDWARE_AVAILABILITY_SLOTS = 256;
export const MAX_HARDWARE_AVAILABILITY_STARTUP_GRACE_MS = 300000;

export const HARDWARE_AVAILABILITY_UNREADABLE = 'HARDWARE_AVAILABILITY_POLICY_UNREADABLE';
export const HARDWARE_AVAILABILITY_INVALID = 'HARDWARE_AVAILABILITY_POLICY_INVALID';
export const HARDWARE_AVAILABILITY_REVISION_CONFLICT = 'HARDWARE_AVAILABILITY_REVISION_CONFLICT';
export const HARDWARE_AVAILABILITY_POLICY_FULL = 'HARDWARE_AVAILABILITY_POLICY_FULL';
export const HARDWARE_AVAILABILITY_DURABILITY_UNCONFIRMED = 'HARDWARE_AVAILABILITY_DURABILITY_UNCONFIRMED';
export const HARDWARE_AVAILABILITY_INSTALL_CONFLICT = 'HARDWARE_AVAILABILITY_INSTALL_CONFLICT';

const WITNESS_INITIALIZERS = Object.freeze(['fresh', 'upgrade', 'restored']);
const WITNESS_KEYS = Object.freeze(['schema', 'storeId', 'initializedAt', 'initializedBy']);
const POLICY_KEYS = Object.freeze(['schema', 'storeId', 'revision', 'entries', 'slots']);
const ENTRY_KEYS = Object.freeze(['projection', 'source']);
const SOURCE_KEYS = Object.freeze(['kind', 'runId', 'runStartedAtMs', 'waveIndex', 'statusFile', 'finishedAtMs']);
const SLOT_KEYS = Object.freeze([
    'key', 'instanceId', 'enableGeneration', 'runId', 'runStartedAtMs', 'waveIndex', 'statusFile', 'startupGraceMs',
]);
const STORE_ID = /^[0-9a-f]{32}$/;
const REVISION = /^sha256:[0-9a-f]{64}$/;
const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_AGENT_IDENTITY = /^[^/:\s\u0000-\u001f\u007f-\u009f]+$/u;
const SAFE_OPAQUE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_IDENTITY_LENGTH = 1024;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const IGNORED_DIRECTORY_FSYNC_CODES = Object.freeze(['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF']);
const POLICY_TEMP = /^\.policy\.json\.(\d+)\.[0-9a-f-]{36}\.tmp$/;
const STAGING_DIRECTORY = /^\.hardware-availability\.(\d+)\.[0-9a-f-]{36}\.tmp$/;
const WITNESS_TEMP = /^\.hardware-availability\.witness\.json\.(\d+)\.[0-9a-f-]{36}\.tmp$/;

function availabilityError(message, code, extra = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, extra);
    return error;
}

// `transient` marks a failure of the read itself (an I/O error, a file replaced mid-read), as opposed to
// content that was read and judged invalid: only the latter is deterministic, so only it may be cached.
function unreadable(target, detail, { transient = false } = {}) {
    return availabilityError(
        `hardware availability store '${target}' is unreadable: ${detail}`,
        HARDWARE_AVAILABILITY_UNREADABLE,
        transient ? { transient: true } : {},
    );
}

// ---------------------------------------------------------------- canonical JSON and revision

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function stableStringify(value) {
    return JSON.stringify(stableValue(value));
}

export function computeHardwareAvailabilityRevision({
    schema = HARDWARE_AVAILABILITY_SCHEMA,
    storeId,
    entries,
    slots,
}) {
    return `sha256:${crypto.createHash('sha256').update(stableStringify({ schema, storeId, entries, slots })).digest('hex')}`;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

// ---------------------------------------------------------------- validation (never echoes content)

class ShapeError extends Error {}

function shape(condition, message) {
    if (!condition) throw new ShapeError(message);
}

function exactOwnKeys(value, keys, label) {
    shape(isPlainObject(value), `${label} must be an object`);
    const allowed = new Set(keys);
    for (const key of Object.keys(value)) shape(!RESERVED_KEYS.has(key) && allowed.has(key), `${label} has an unsupported field`);
    for (const key of keys) shape(Object.prototype.hasOwnProperty.call(value, key), `${label} is missing a required field`);
}

function identityText(value, label, pattern) {
    shape(typeof value === 'string'
        && value === value.trim()
        && value.length > 0
        && value.length <= MAX_IDENTITY_LENGTH
        && pattern.test(value), `${label} is not one exact canonical identity value`);
    return value;
}

function canonicalRunId(value, label) {
    shape(typeof value === 'string', `${label} must be one exact canonical UUID`);
    let normalized;
    try { normalized = exactRunId(value); } catch (_) { shape(false, `${label} must be one exact canonical UUID`); }
    shape(normalized === value, `${label} must be one exact canonical UUID`);
    return value;
}

function publishedInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
    shape(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum,
        `${label} must be one exact published integer`);
    return value;
}

function routeKeyText(value, label) {
    shape(typeof value === 'string' && !RESERVED_KEYS.has(value), `${label} is not a valid route key`);
    identityText(value, label, SAFE_AGENT_IDENTITY);
    return value;
}

function validateEntry(routeKey, entry) {
    exactOwnKeys(entry, ENTRY_KEYS, `entry '${routeKey}'`);
    let projection;
    try {
        projection = validateAvailabilityProjection(entry.projection);
    } catch (_) {
        shape(false, `entry '${routeKey}' projection is invalid`);
    }
    identityText(projection.key, `entry '${routeKey}' key`, SAFE_CONTAINER);
    const { source } = entry;
    exactOwnKeys(source, SOURCE_KEYS, `entry '${routeKey}' source`);
    shape(source.kind === 'no-wait-terminal', `entry '${routeKey}' source kind is unsupported`);
    canonicalRunId(source.runId, `entry '${routeKey}' run id`);
    publishedInteger(source.runStartedAtMs, `entry '${routeKey}' run start`);
    publishedInteger(source.waveIndex, `entry '${routeKey}' wave index`, { maximum: MAX_NO_WAIT_WAVE_INDEX });
    publishedInteger(source.finishedAtMs, `entry '${routeKey}' finish time`, { minimum: 1 });
    shape(source.statusFile === `${projection.key}.${source.runId}.json`, `entry '${routeKey}' status file is not the exact run-scoped file`);
    shape(projection.observedAt === new Date(source.finishedAtMs).toISOString(), `entry '${routeKey}' observedAt is not its finish time`);
}

function validateSlot(routeKey, slot) {
    exactOwnKeys(slot, SLOT_KEYS, `slot '${routeKey}'`);
    identityText(slot.key, `slot '${routeKey}' key`, SAFE_CONTAINER);
    identityText(slot.instanceId, `slot '${routeKey}' instance id`, SAFE_OPAQUE_IDENTITY);
    identityText(slot.enableGeneration, `slot '${routeKey}' enable generation`, SAFE_OPAQUE_IDENTITY);
    shape(slot.instanceId !== slot.enableGeneration, `slot '${routeKey}' instance id and enable generation must be distinct`);
    canonicalRunId(slot.runId, `slot '${routeKey}' run id`);
    publishedInteger(slot.runStartedAtMs, `slot '${routeKey}' run start`);
    publishedInteger(slot.waveIndex, `slot '${routeKey}' wave index`, { maximum: MAX_NO_WAIT_WAVE_INDEX });
    shape(slot.statusFile === `${slot.key}.${slot.runId}.json`, `slot '${routeKey}' status file is not the exact run-scoped file`);
    // startupGraceMs is a validated INFORMATIONAL field of the frozen v1 schema: it is checked here, and no store code derives a denial from it.
    publishedInteger(slot.startupGraceMs, `slot '${routeKey}' startup grace`, { maximum: MAX_HARDWARE_AVAILABILITY_STARTUP_GRACE_MS });
}

export function serializeHardwareAvailabilityPolicy(document) {
    return `${JSON.stringify({
        ...document,
        entries: stableValue(document.entries),
        slots: stableValue(document.slots),
    }, null, 2)}\n`;
}

// Throws on any shape, identity, revision or cross-field violation. The
// document is verified as written: every reader recomputes the revision.
function validatePolicyDocument(document) {
    exactOwnKeys(document, POLICY_KEYS, 'policy');
    shape(document.schema === HARDWARE_AVAILABILITY_SCHEMA, 'policy schema is unsupported');
    shape(typeof document.storeId === 'string' && STORE_ID.test(document.storeId), 'policy storeId is invalid');
    shape(typeof document.revision === 'string' && REVISION.test(document.revision), 'policy revision is invalid');
    shape(isPlainObject(document.entries), 'policy entries must be an object');
    shape(isPlainObject(document.slots), 'policy slots must be an object');
    shape(Object.keys(document.entries).length <= MAX_HARDWARE_AVAILABILITY_ENTRIES, 'policy has too many entries');
    shape(Object.keys(document.slots).length <= MAX_HARDWARE_AVAILABILITY_SLOTS, 'policy has too many slots');
    for (const [routeKey, entry] of Object.entries(document.entries)) {
        routeKeyText(routeKey, 'entry route key');
        validateEntry(routeKey, entry);
    }
    const slotKeys = new Set();
    for (const [routeKey, slot] of Object.entries(document.slots)) {
        routeKeyText(routeKey, 'slot route key');
        validateSlot(routeKey, slot);
        shape(!slotKeys.has(slot.key), 'policy has two slots for one key');
        slotKeys.add(slot.key);
        const entry = Object.prototype.hasOwnProperty.call(document.entries, routeKey) ? document.entries[routeKey] : null;
        shape(!entry || entry.source.runId !== slot.runId, 'an entry and a slot of one route share a run id');
    }
    shape(Buffer.byteLength(serializeHardwareAvailabilityPolicy(document), 'utf8') <= MAX_HARDWARE_AVAILABILITY_POLICY_BYTES,
        'policy exceeds its byte bound');
    shape(computeHardwareAvailabilityRevision(document) === document.revision, 'policy revision does not match its content');
    return document;
}

function validateWitnessDocument(document) {
    exactOwnKeys(document, WITNESS_KEYS, 'witness');
    shape(document.schema === HARDWARE_AVAILABILITY_WITNESS_SCHEMA, 'witness schema is unsupported');
    shape(typeof document.storeId === 'string' && STORE_ID.test(document.storeId), 'witness storeId is invalid');
    shape(typeof document.initializedAt === 'string'
        && Number.isFinite(Date.parse(document.initializedAt))
        && new Date(Date.parse(document.initializedAt)).toISOString() === document.initializedAt, 'witness initializedAt is invalid');
    shape(WITNESS_INITIALIZERS.includes(document.initializedBy), 'witness initializedBy is invalid');
    return document;
}

export function validateHardwareAvailabilityPolicyDocument(document) {
    try {
        return validatePolicyDocument(document);
    } catch (error) {
        if (error instanceof ShapeError) {
            throw availabilityError(`hardware availability policy is invalid: ${error.message}`, HARDWARE_AVAILABILITY_INVALID);
        }
        throw error;
    }
}

// ---------------------------------------------------------------- bounded private reads

function readBoundedFile(fsApi, file, maxBytes) {
    let stat;
    try {
        stat = fsApi.lstatSync(file);
    } catch (error) {
        if (error?.code === 'ENOENT') return { missing: true };
        return { problem: `cannot be inspected (${error?.code || 'error'})`, io: true };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return { problem: 'is not a regular non-symlink file' };
    if (stat.size > maxBytes) return { problem: `exceeds ${maxBytes} bytes` };
    let descriptor;
    try {
        descriptor = fsApi.openSync(file, fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW);
        const opened = fsApi.fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
            return { problem: 'was replaced while it was read', io: true };
        }
        if (opened.size > maxBytes) return { problem: `exceeds ${maxBytes} bytes` };
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fsApi.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) break;
            offset += count;
        }
        if (offset !== bytes.length) return { problem: 'changed size while it was read', io: true };
        return { bytes, stat: opened };
    } catch (error) {
        return { problem: `cannot be read (${error?.code || 'error'})`, io: true };
    } finally {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) {}
        }
    }
}

function parseJson(bytes) {
    try {
        return { value: JSON.parse(bytes.toString('utf8')) };
    } catch (_) {
        // Parser diagnostics can echo the malformed text; never surface it.
        return { problem: 'is not valid JSON' };
    }
}

function inspectDirectoryKind(fsApi, directory) {
    let stat;
    try {
        stat = fsApi.lstatSync(directory);
    } catch (error) {
        if (error?.code === 'ENOENT') return { state: 'absent' };
        return { state: 'invalid', problem: `cannot be inspected (${error?.code || 'error'})`, io: true };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { state: 'invalid', problem: 'is not a real directory' };
    return { state: 'present' };
}

/**
 * Classify the witness and the store directory without throwing on content.
 * `{ witness, directory }`, each `{ state: 'absent' | 'valid' | 'invalid' }`.
 */
export function inspectHardwareAvailabilityStore({ paths, fsApi = fs } = {}) {
    let witness;
    const witnessRead = readBoundedFile(fsApi, paths.availabilityWitnessFile, MAX_HARDWARE_AVAILABILITY_WITNESS_BYTES);
    if (witnessRead.missing) {
        witness = { state: 'absent' };
    } else if (witnessRead.problem) {
        witness = { state: 'invalid', problem: witnessRead.problem, ...(witnessRead.io ? { io: true } : {}) };
    } else {
        const parsed = parseJson(witnessRead.bytes);
        try {
            if (parsed.problem) throw new ShapeError(parsed.problem);
            witness = { state: 'valid', document: validateWitnessDocument(parsed.value), bytes: witnessRead.bytes };
        } catch (error) {
            if (!(error instanceof ShapeError)) throw error;
            witness = { state: 'invalid', problem: error.message };
        }
    }

    let directory;
    const kind = inspectDirectoryKind(fsApi, paths.availabilityStoreDir);
    if (kind.state !== 'present') {
        directory = kind;
    } else {
        const policyRead = readBoundedFile(fsApi, paths.availabilityPolicyFile, MAX_HARDWARE_AVAILABILITY_POLICY_BYTES);
        if (policyRead.missing) {
            directory = { state: 'invalid', problem: 'policy.json is missing from an existing store directory' };
        } else if (policyRead.problem) {
            directory = { state: 'invalid', problem: `policy.json ${policyRead.problem}`, ...(policyRead.io ? { io: true } : {}) };
        } else {
            const parsed = parseJson(policyRead.bytes);
            try {
                if (parsed.problem) throw new ShapeError(`policy.json ${parsed.problem}`);
                directory = { state: 'valid', document: validatePolicyDocument(parsed.value), bytes: policyRead.bytes };
            } catch (error) {
                if (!(error instanceof ShapeError)) throw error;
                directory = { state: 'invalid', problem: error.message };
            }
        }
    }
    return { witness, directory };
}

/**
 * The reader. `{ state:'absent', revision:'absent', entries:{}, slots:{} }`
 * only when the witness and the store directory are both absent; otherwise a
 * `valid` snapshot, or a throw of HARDWARE_AVAILABILITY_POLICY_UNREADABLE.
 * Has no side effects.
 */
export function readHardwareAvailabilityPolicy({ paths, fsApi = fs } = {}) {
    const inspected = inspectHardwareAvailabilityStore({ paths, fsApi });
    const { witness, directory } = inspected;
    if (witness.state === 'invalid') throw unreadable(paths.availabilityWitnessFile, `witness ${witness.problem}`, { transient: witness.io === true });
    if (directory.state === 'invalid') throw unreadable(paths.availabilityStoreDir, directory.problem, { transient: directory.io === true });
    if (directory.state === 'absent') {
        if (witness.state === 'absent') {
            return deepFreeze({ state: 'absent', revision: HARDWARE_AVAILABILITY_ABSENT_REVISION, entries: {}, slots: {} });
        }
        throw unreadable(
            paths.availabilityStoreDir,
            `the store directory is missing after initialization (witness ${paths.availabilityWitnessFile})`,
        );
    }
    const { document } = directory;
    if (witness.state === 'valid' && witness.document.storeId !== document.storeId) {
        throw unreadable(paths.availabilityStoreDir, 'the policy storeId does not match the witness');
    }
    return deepFreeze({
        state: 'valid',
        storeId: document.storeId,
        revision: document.revision,
        entries: document.entries,
        slots: document.slots,
        diagnostic: witness.state === 'absent' ? 'witness-missing' : null,
    });
}

// ---------------------------------------------------------------- durable writes

function fsyncDirectory(fsApi, directory) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(directory, fsApi.constants.O_RDONLY);
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        // Directory fsync is not supported by every host filesystem. File fsync
        // and atomic rename remain authoritative on those platforms.
        if (!IGNORED_DIRECTORY_FSYNC_CODES.includes(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) {}
        }
    }
}

// Create a new private file (O_EXCL, no symlink follow), write, fsync, close.
function createPrivateFile(fsApi, file, bytes) {
    const { constants } = fsApi;
    const descriptor = fsApi.openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
    );
    try {
        fsApi.writeFileSync(descriptor, bytes);
        fsApi.fsyncSync(descriptor);
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function removeIfPresent(fsApi, file) {
    try {
        fsApi.unlinkSync(file);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

// The assertion receives the store's resolved paths so it can prove that the
// lock it holds belongs to the workspace those paths are under.
function requireApplyLock(assertApplyLock, paths) {
    if (typeof assertApplyLock !== 'function') {
        throw availabilityError('hardware availability mutation requires an apply-lock assertion', HARDWARE_AVAILABILITY_INVALID);
    }
    assertApplyLock(paths);
}

function ownerDead(pid, killImpl) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
        killImpl(pid, 0);
        return false;
    } catch (error) {
        // ESRCH is the only proof of absence; EPERM means a live owner.
        return error?.code === 'ESRCH';
    }
}

function removeStagingDirectory(fsApi, directory) {
    let names;
    try {
        names = fsApi.readdirSync(directory);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
    for (const name of names) {
        const member = path.join(directory, name);
        if (!fsApi.lstatSync(member).isFile()) return false;
        removeIfPresent(fsApi, member);
    }
    try {
        fsApi.rmdirSync(directory);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return true;
}

/**
 * Remove dead-owner temporaries: `.hardware-availability.<pid>.<uuid>.tmp/`
 * and the witness temp in the edge directory, `.policy.json.<pid>.<uuid>.tmp`
 * in the store directory. A name is removed only when it matches exactly one
 * pattern and its pid gives ESRCH; live (or EPERM) owners and other names stay.
 * Runs under the apply lock.
 */
export function sweepHardwareAvailabilityTemps({ paths, assertApplyLock, fsApi = fs, killImpl = process.kill } = {}) {
    requireApplyLock(assertApplyLock, paths);
    const removed = [];
    const scan = (directory, matchers) => {
        let names;
        try {
            names = fsApi.readdirSync(directory);
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
            throw error;
        }
        for (const name of names) {
            for (const [pattern, isDirectory] of matchers) {
                const match = pattern.exec(name);
                if (!match || !ownerDead(Number(match[1]), killImpl)) continue;
                const target = path.join(directory, name);
                const done = isDirectory ? removeStagingDirectory(fsApi, target) : (removeIfPresent(fsApi, target), true);
                if (done) removed.push(target);
            }
        }
        if (removed.length) fsyncDirectory(fsApi, directory);
    };
    scan(paths.edgeDir, [[STAGING_DIRECTORY, true], [WITNESS_TEMP, false]]);
    if (inspectDirectoryKind(fsApi, paths.availabilityStoreDir).state === 'present') {
        scan(paths.availabilityStoreDir, [[POLICY_TEMP, false]]);
    }
    return Object.freeze(removed);
}

// A named hook models process death: an artifact left by a throwing hook is
// preserved exactly as a real crash would leave it.
function hookRunner(faults, state) {
    return (name, detail) => {
        const hook = faults?.[name];
        if (typeof hook !== 'function') return;
        state.crashed = true;
        hook(detail);
        state.crashed = false;
    };
}

function witnessBytes({ storeId, initializedBy, now }) {
    return Buffer.from(`${JSON.stringify({
        schema: HARDWARE_AVAILABILITY_WITNESS_SCHEMA,
        storeId,
        initializedAt: now().toISOString(),
        initializedBy,
    }, null, 2)}\n`);
}

// Temp + fsync + link-no-replace + edge directory fsync. An existing witness
// with different bytes is a conflict, never replaced.
function writeWitness({ paths, fsApi, run, state, storeId, initializedBy, now }) {
    const bytes = witnessBytes({ storeId, initializedBy, now });
    const temporary = path.join(paths.edgeDir, `.hardware-availability.witness.json.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
        createPrivateFile(fsApi, temporary, bytes);
        run('afterWitnessTemp', { temporary });
        try {
            fsApi.linkSync(temporary, paths.availabilityWitnessFile);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const existing = readBoundedFile(fsApi, paths.availabilityWitnessFile, MAX_HARDWARE_AVAILABILITY_WITNESS_BYTES);
            let sameStore = false;
            if (existing.bytes) {
                const parsed = parseJson(existing.bytes);
                sameStore = !parsed.problem && parsed.value?.storeId === storeId && Object.keys(parsed.value).length === WITNESS_KEYS.length;
            }
            if (!sameStore) {
                throw availabilityError(
                    `hardware availability witness '${paths.availabilityWitnessFile}' already exists for a different store`,
                    HARDWARE_AVAILABILITY_INSTALL_CONFLICT,
                );
            }
        }
        fsyncDirectory(fsApi, paths.edgeDir);
        run('afterWitnessLink', { witness: paths.availabilityWitnessFile });
    } finally {
        if (!state.crashed) removeIfPresent(fsApi, temporary);
    }
}

function assertStoreAbsent(fsApi, paths) {
    for (const target of [paths.availabilityWitnessFile, paths.availabilityStoreDir]) {
        let exists = true;
        try {
            fsApi.lstatSync(target);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            exists = false;
        }
        if (exists) {
            throw availabilityError(
                `hardware availability store install refused: '${target}' already exists`,
                HARDWARE_AVAILABILITY_INSTALL_CONFLICT,
            );
        }
    }
}

/**
 * Install a new empty store. Only `initializeFreshEdgeRoutingSources` calls
 * this, inside its apply lock, and only when the witness and the directory are
 * both absent. The witness is written after the directory rename is durable,
 * so no crash can leave "witness present, directory absent".
 */
export function installHardwareAvailabilityStore({
    paths,
    assertApplyLock,
    initializedBy,
    fsApi = fs,
    faults = {},
    now = () => new Date(),
    killImpl = process.kill,
} = {}) {
    requireApplyLock(assertApplyLock, paths);
    if (initializedBy !== 'fresh' && initializedBy !== 'upgrade') {
        throw availabilityError('hardware availability install requires a fresh or upgrade origin', HARDWARE_AVAILABILITY_INVALID);
    }
    const state = { crashed: false };
    const run = hookRunner(faults, state);
    sweepHardwareAvailabilityTemps({ paths, assertApplyLock, fsApi, killImpl });
    run('afterSweep');
    assertStoreAbsent(fsApi, paths);
    const staging = path.join(paths.edgeDir, `.hardware-availability.${process.pid}.${crypto.randomUUID()}.tmp`);
    const storeId = crypto.randomBytes(16).toString('hex');
    const empty = { schema: HARDWARE_AVAILABILITY_SCHEMA, storeId, entries: {}, slots: {} };
    const document = { ...empty, revision: computeHardwareAvailabilityRevision(empty) };
    let renamed = false;
    try {
        fsApi.mkdirSync(paths.edgeDir, { recursive: true });
        fsApi.mkdirSync(staging, { mode: 0o700 });
        run('afterStagingMkdir', { staging });
        createPrivateFile(fsApi, path.join(staging, 'policy.json'), serializeHardwareAvailabilityPolicy(document));
        run('afterPolicyFsync', { staging });
        fsyncDirectory(fsApi, staging);
        run('afterStagingFsync', { staging });
        assertStoreAbsent(fsApi, paths);
        run('beforeDirectoryRename', { staging });
        try {
            fsApi.renameSync(staging, paths.availabilityStoreDir);
        } catch (error) {
            if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
                throw availabilityError(
                    `hardware availability store install refused: '${paths.availabilityStoreDir}' appeared during install`,
                    HARDWARE_AVAILABILITY_INSTALL_CONFLICT,
                );
            }
            throw error;
        }
        renamed = true;
        run('afterDirectoryRename', { storeDirectory: paths.availabilityStoreDir });
        fsyncDirectory(fsApi, paths.edgeDir);
        run('afterEdgeDirectoryFsync', { storeDirectory: paths.availabilityStoreDir });
        writeWitness({ paths, fsApi, run, state, storeId, initializedBy, now });
    } finally {
        if (!renamed && !state.crashed) {
            try { removeStagingDirectory(fsApi, staging); } catch (_) {}
        }
    }
    return Object.freeze({ storeId, initializedBy, revision: document.revision });
}

/**
 * Restore only the witness of a valid store that lost it (an interrupted
 * install, or a deleted witness). Never touches the store directory.
 */
export function restoreHardwareAvailabilityWitness({
    paths,
    assertApplyLock,
    fsApi = fs,
    faults = {},
    now = () => new Date(),
} = {}) {
    requireApplyLock(assertApplyLock, paths);
    const { witness, directory } = inspectHardwareAvailabilityStore({ paths, fsApi });
    if (witness.state !== 'absent' || directory.state !== 'valid') {
        throw availabilityError(
            'hardware availability witness restore requires a valid store with no witness',
            HARDWARE_AVAILABILITY_INSTALL_CONFLICT,
        );
    }
    const state = { crashed: false };
    writeWitness({
        paths,
        fsApi,
        run: hookRunner(faults, state),
        state,
        storeId: directory.document.storeId,
        initializedBy: 'restored',
        now,
    });
    return Object.freeze({ storeId: directory.document.storeId, initializedBy: 'restored' });
}

/**
 * Commit a new policy: one rename of policy.json is the only commit.
 *
 * `entries` and `slots` default to the committed snapshot's. The caller must
 * hold the apply lock (`assertApplyLock`). An identical revision returns
 * `{ committed:false }` before any write. A throw before the rename leaves the
 * old policy and removes only the own temp. After the rename a directory fsync
 * failure throws HARDWARE_AVAILABILITY_DURABILITY_UNCONFIRMED with
 * `committed: true`; it never rolls back and never renames again.
 */
export function commitHardwareAvailabilityPolicy({
    paths,
    assertApplyLock,
    expectedRevision,
    entries,
    slots,
    beforeTemp,
    beforeRename,
    fsApi = fs,
    faults = {},
    killImpl = process.kill,
} = {}) {
    requireApplyLock(assertApplyLock, paths);
    const snapshot = readHardwareAvailabilityPolicy({ paths, fsApi });
    if (snapshot.state !== 'valid') {
        throw unreadable(paths.availabilityStoreDir, 'the store is not initialized; commits require a valid store');
    }
    if (expectedRevision !== snapshot.revision) {
        throw availabilityError(
            `hardware availability policy revision changed (expected ${String(expectedRevision)}, found ${snapshot.revision})`,
            HARDWARE_AVAILABILITY_REVISION_CONFLICT,
            { committed: false },
        );
    }
    const nextEntries = entries === undefined ? snapshot.entries : entries;
    const nextSlots = slots === undefined ? snapshot.slots : slots;
    if (isPlainObject(nextEntries) && Object.keys(nextEntries).length > MAX_HARDWARE_AVAILABILITY_ENTRIES) {
        throw availabilityError(
            `hardware availability policy is full: more than ${MAX_HARDWARE_AVAILABILITY_ENTRIES} entries`,
            HARDWARE_AVAILABILITY_POLICY_FULL,
        );
    }
    if (isPlainObject(nextSlots) && Object.keys(nextSlots).length > MAX_HARDWARE_AVAILABILITY_SLOTS) {
        throw availabilityError(
            `hardware availability policy is full: more than ${MAX_HARDWARE_AVAILABILITY_SLOTS} slots`,
            HARDWARE_AVAILABILITY_POLICY_FULL,
        );
    }
    const next = {
        schema: HARDWARE_AVAILABILITY_SCHEMA,
        storeId: snapshot.storeId,
        entries: nextEntries,
        slots: nextSlots,
    };
    next.revision = computeHardwareAvailabilityRevision(next);
    let bytes;
    try {
        validatePolicyDocument(next);
        bytes = serializeHardwareAvailabilityPolicy(next);
    } catch (error) {
        if (!(error instanceof ShapeError)) throw error;
        if (error.message === 'policy exceeds its byte bound') {
            throw availabilityError(
                `hardware availability policy is full: more than ${MAX_HARDWARE_AVAILABILITY_POLICY_BYTES} bytes`,
                HARDWARE_AVAILABILITY_POLICY_FULL,
            );
        }
        throw availabilityError(`hardware availability policy is invalid: ${error.message}`, HARDWARE_AVAILABILITY_INVALID);
    }
    if (next.revision === snapshot.revision) return Object.freeze({ committed: false, revision: snapshot.revision });

    sweepHardwareAvailabilityTemps({ paths, assertApplyLock, fsApi, killImpl });
    if (typeof beforeTemp === 'function') beforeTemp();
    const temporary = path.join(paths.availabilityStoreDir, `.policy.json.${process.pid}.${crypto.randomUUID()}.tmp`);
    let renamed = false;
    try {
        createPrivateFile(fsApi, temporary, bytes);
        faults.afterTempFsync?.({ temporary });
        if (typeof beforeRename === 'function') beforeRename();
        // No await between the last check and the rename: this rename is the commit.
        fsApi.renameSync(temporary, paths.availabilityPolicyFile);
        renamed = true;
        faults.afterRename?.({ revision: next.revision });
        try {
            fsyncDirectory(fsApi, paths.availabilityStoreDir);
        } catch (error) {
            throw availabilityError(
                `hardware availability policy '${paths.availabilityPolicyFile}' was committed but its directory fsync failed (${error?.code || 'error'})`,
                HARDWARE_AVAILABILITY_DURABILITY_UNCONFIRMED,
                { committed: true, revision: next.revision },
            );
        }
        faults.afterDirectoryFsync?.({ revision: next.revision });
    } finally {
        if (!renamed) {
            try { removeIfPresent(fsApi, temporary); } catch (_) {}
        }
    }
    return Object.freeze({ committed: true, revision: next.revision, previousRevision: snapshot.revision });
}
