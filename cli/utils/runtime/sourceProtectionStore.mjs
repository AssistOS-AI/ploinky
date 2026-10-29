// Controller-private durable source-protection store (frozen T0 §6 + A1.3 +
// A2.2 + A3.3). In-Box controller code only; host-side `ploinky-box` code must
// never open it.
//
//   <workspace>/.ploinky/data/source-protection.witness.json          witness (outside the store)
//   <workspace>/.ploinky/data/source-protection/state.json            canonical snapshot; its rename is the commit
//   <workspace>/.ploinky/data/source-protection/lock                  exclusive lock (owner pid, start identity, scope, token)
//   <workspace>/.ploinky/data/source-protection/closures/<sha>.json   immutable content-addressed closures
//   <workspace>/.ploinky/data/source-protection/selections/<sha>.json immutable content-addressed selections
//   <workspace>/.ploinky/data/source-protection.creating-<storeId>/   creation staging directory (A2.2)
//
// "Never initialized" means witness and store directory are both absent. Any
// other inconsistent combination is `state_corrupt` and is never reset. Only
// lifecycle code holding the workspace mutation lease (proved through the
// injected `assertWorkspaceLease`) creates a store or completes an
// interrupted creation; every other opener reports `source_unavailable`
// without writing.
//
// This module is mechanism only. Authorization, sequencing and evidence live
// in sourceProtectionInterlock.mjs. Nothing in production imports it in T1.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { threadId as currentThreadId } from 'node:worker_threads';

import {
    INTERLOCK_LIMITS_V1,
    canonicalOrThrow,
    errorResult,
    isId,
    isOpaqueIdentity,
    isOperationId,
    isPrincipal,
    okResult,
    deepFreeze,
    parseCanonicalOrThrowInternal,
    validateReservationTombstone,
    validateSourceClosure,
    validateSourceOperation,
    validateSourceProtectionRecord,
    validateSourceSelection,
    validateWritableReservation,
    isContractFailure,
    STORE_HOLDER_STATES,
    SOURCE_OPERATION_KINDS,
    MAX_CLOSURE_BYTES,
} from '../../server/executionTarget/contract.mjs';

export const STORE_ERROR_CODES = Object.freeze({
    sourceUnavailable: 'source_unavailable',
    stateCorrupt: 'state_corrupt',
    capacityExceeded: 'capacity_exceeded',
    outcomeUnknown: 'outcome_unknown',
    forbidden: 'forbidden',
    invalidRequest: 'invalid_request',
});

export const SOURCE_PROTECTION_STORE_SCHEMA = 1;
export const SOURCE_PROTECTION_WITNESS_SCHEMA = 1;
export const SOURCE_PROTECTION_DIRECTORY_NAME = 'source-protection';
export const SOURCE_PROTECTION_WITNESS_NAME = 'source-protection.witness.json';
export const SOURCE_PROTECTION_CREATING_PREFIX = 'source-protection.creating-';
// A5.1: superseded generations remembered per worker principal, newest first.
export const SUPERSEDED_GENERATION_HISTORY_BOUND = 1024;
const MAX_WITNESS_BYTES = 4096;
const MAX_LOCK_BYTES = 4096;
const LOCK_POLL_MS = 10;
const WITNESS_KEYS = Object.freeze(['schema', 'storeId', 'initializedAt', 'initializedBy']);
const SNAPSHOT_KEYS = Object.freeze([
    'schema', 'storeId', 'revision', 'holders', 'record', 'generations', 'reservations', 'tombstones', 'receipts',
]);
const RECEIPT_KEYS = Object.freeze([
    'operationId', 'kind', 'requestDigest', 'actor', 'ownerPrincipal', 'ownerGeneration', 'result',
]);
const LOCK_KEYS = Object.freeze(['pid', 'startIdentity', 'scope', 'token']);
const CLAIM_KEYS = Object.freeze(['pid', 'startIdentity', 'scope', 'thread', 'target']);
export const RECLAIM_CLAIM_PREFIX = 'lock.reclaim-';
const IGNORED_DIRECTORY_FSYNC_CODES = Object.freeze(['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF']);
const CREATING_NAME = /^source-protection\.creating-(.*)$/;
const STORE_TEMP = /^\.[A-Za-z0-9._-]+\.[0-9a-f-]{36}\.tmp$/;
const WITNESS_TEMP = /^\.source-protection\.witness\.json\.[0-9a-f-]{36}\.tmp$/;
const CONTENT_FILE = /^([0-9a-f]{64})\.json$/;

const S = STORE_ERROR_CODES;

class StoreError extends Error {
    constructor(code, { committed = false } = {}) {
        super(code);
        this.code = code;
        this.committed = committed;
    }
}

// A fault hook models process death: nothing it leaves behind is cleaned up
// and the handle that crashed never releases its lock.
class SimulatedCrash extends Error {
    constructor(point) {
        super(`simulated crash at ${point}`);
        this.crashPoint = point;
    }
}

export function isStoreError(error) {
    return error instanceof StoreError;
}

export function isSimulatedCrash(error) {
    return error instanceof SimulatedCrash;
}

function storeFail(code, options) {
    throw new StoreError(code, options);
}

// ---------------------------------------------------------------- paths

export function sourceProtectionPaths(workspaceRoot) {
    const dataDir = path.join(path.resolve(String(workspaceRoot)), '.ploinky', 'data');
    const storeDir = path.join(dataDir, SOURCE_PROTECTION_DIRECTORY_NAME);
    return Object.freeze({
        dataDir,
        storeDir,
        witnessFile: path.join(dataDir, SOURCE_PROTECTION_WITNESS_NAME),
        stateFile: path.join(storeDir, 'state.json'),
        lockFile: path.join(storeDir, 'lock'),
        closuresDir: path.join(storeDir, 'closures'),
        selectionsDir: path.join(storeDir, 'selections'),
        creatingDir: (storeId) => path.join(dataDir, `${SOURCE_PROTECTION_CREATING_PREFIX}${storeId}`),
    });
}

// ---------------------------------------------------------------- process identity

function linuxStartIdentity(fsApi, pid) {
    try {
        const stat = fsApi.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[19] ? `linux-start:${fields[19]}` : null;
    } catch (_) {
        return null;
    }
}

/**
 * The default process identity. A PID is only meaningful inside one boot and
 * PID namespace; where that scope cannot be read the lock is never reclaimed.
 */
export function defaultProcessIdentity({ fsApi = fs, platform = process.platform, pid = process.pid } = {}) {
    let scope = null;
    if (platform === 'linux') {
        try {
            const bootId = fsApi.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
            const namespace = fsApi.readlinkSync('/proc/self/ns/pid');
            if (bootId && namespace) scope = `linux:${bootId}:${namespace}`;
        } catch (_) {
            scope = null;
        }
    }
    return Object.freeze({
        pid,
        threadId: currentThreadId,
        scope,
        startIdentity: platform === 'linux' ? linuxStartIdentity(fsApi, pid) : null,
        isAlive(target) {
            try {
                process.kill(target, 0);
                return true;
            } catch (error) {
                return error?.code !== 'ESRCH';
            }
        },
        startIdentityOf(target) {
            return platform === 'linux' ? linuxStartIdentity(fsApi, target) : null;
        },
    });
}

function defaultClock() {
    return Object.freeze({
        nowMs: () => Date.now(),
        monotonicMs: () => performance.now(),
        sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    });
}

// ---------------------------------------------------------------- low-level file helpers

function fsyncDirectory(fsApi, directory) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(directory, fsApi.constants.O_RDONLY);
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        if (!IGNORED_DIRECTORY_FSYNC_CODES.includes(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) {}
        }
    }
}

function createPrivateFile(fsApi, file, bytes) {
    const { constants } = fsApi;
    const descriptor = fsApi.openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
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

function lstatOrNull(fsApi, target) {
    try {
        return fsApi.lstatSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function readBounded(fsApi, file, maxBytes) {
    const stat = lstatOrNull(fsApi, file);
    if (!stat) return { missing: true };
    if (stat.isSymbolicLink() || !stat.isFile()) return { invalid: true };
    if (stat.size > maxBytes) return { invalid: true };
    const descriptor = fsApi.openSync(file, fsApi.constants.O_RDONLY | (fsApi.constants.O_NOFOLLOW || 0));
    try {
        const opened = fsApi.fstatSync(descriptor);
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > maxBytes) {
            return { invalid: true };
        }
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fsApi.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) break;
            offset += count;
        }
        if (offset !== bytes.length) return { invalid: true };
        return { bytes, stat: opened };
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function directoryKind(fsApi, directory) {
    const stat = lstatOrNull(fsApi, directory);
    if (!stat) return 'absent';
    return !stat.isSymbolicLink() && stat.isDirectory() ? 'present' : 'invalid';
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function newId() {
    return crypto.randomBytes(16).toString('base64url');
}

// ---------------------------------------------------------------- documents

function parseStrict(bytes, maxBytes) {
    try {
        return parseCanonicalOrThrowInternal(bytes, maxBytes);
    } catch (error) {
        if (isContractFailure(error)) storeFail(S.stateCorrupt);
        throw error;
    }
}

function canonicalBytes(value) {
    return Buffer.from(canonicalOrThrow(value), 'utf8');
}

function validWitness(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
    const keys = Object.keys(document);
    if (keys.length !== WITNESS_KEYS.length || !WITNESS_KEYS.every((key) => keys.includes(key))) return false;
    return document.schema === SOURCE_PROTECTION_WITNESS_SCHEMA
        && isId(document.storeId)
        && typeof document.initializedAt === 'string'
        && Number.isFinite(Date.parse(document.initializedAt))
        && new Date(Date.parse(document.initializedAt)).toISOString() === document.initializedAt
        && document.initializedBy === 'fresh';
}

function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const own = Object.keys(value);
    return own.length === keys.length && own.every((key) => keys.includes(key));
}

function ascending(items, keyOf) {
    for (let index = 1; index < items.length; index += 1) {
        if (!(keyOf(items[index - 1]) < keyOf(items[index]))) return false;
    }
    return true;
}

function corruptUnless(condition) {
    if (!condition) storeFail(S.stateCorrupt);
}

function checkResult(result) {
    corruptUnless(result.ok === true);
}

function validateActor(actor) {
    corruptUnless(actor && typeof actor === 'object' && !Array.isArray(actor));
    if (actor.kind === 'worker') {
        corruptUnless(exactKeys(actor, ['kind', 'workerPrincipal', 'workerGeneration']));
        corruptUnless(isPrincipal(actor.workerPrincipal) && isId(actor.workerGeneration));
    } else {
        corruptUnless(actor.kind === 'operator' && exactKeys(actor, ['kind', 'operatorIdentity']));
        corruptUnless(isOpaqueIdentity(actor.operatorIdentity));
    }
}

/**
 * Validate a whole snapshot: shape, store identity, cross references and the
 * count bounds. Throws `state_corrupt`.
 */
export function validateSnapshotDocument(document, { storeId, limits }) {
    corruptUnless(exactKeys(document, SNAPSHOT_KEYS));
    corruptUnless(document.schema === SOURCE_PROTECTION_STORE_SCHEMA);
    corruptUnless(document.storeId === storeId && isId(storeId));
    corruptUnless(Number.isSafeInteger(document.revision) && document.revision >= 1);
    const { holders } = document;
    corruptUnless(exactKeys(holders, ['state', 'expected', 'acknowledged']));
    corruptUnless(STORE_HOLDER_STATES.includes(holders.state));
    for (const list of [holders.expected, holders.acknowledged]) {
        corruptUnless(Array.isArray(list) && list.every(isPrincipal) && ascending(list, (item) => item));
    }
    const acknowledged = new Set(holders.acknowledged);
    const ready = holders.expected.every((principal) => acknowledged.has(principal));
    corruptUnless(holders.state === (ready ? 'ready' : 'awaiting-holder-ack'));
    if (document.record !== null) {
        checkResult(validateSourceProtectionRecord(document.record));
        corruptUnless(document.record.sourceStoreIdentity === storeId);
    }
    corruptUnless(Array.isArray(document.generations) && ascending(document.generations, (item) => item?.workerPrincipal));
    const pointers = new Map();
    for (const pointer of document.generations) {
        corruptUnless(exactKeys(pointer, ['workerPrincipal', 'currentGeneration', 'priorGeneration', 'history']));
        corruptUnless(isPrincipal(pointer.workerPrincipal) && isId(pointer.currentGeneration));
        corruptUnless(pointer.priorGeneration === null || (isId(pointer.priorGeneration)
            && pointer.priorGeneration !== pointer.currentGeneration));
        corruptUnless(Array.isArray(pointer.history) && pointer.history.length <= SUPERSEDED_GENERATION_HISTORY_BOUND
            && pointer.history.every(isId) && new Set(pointer.history).size === pointer.history.length
            && !pointer.history.includes(pointer.currentGeneration));
        pointers.set(pointer.workerPrincipal, pointer);
    }
    const operationIds = new Set();
    const claim = (operationId) => {
        corruptUnless(isOperationId(operationId) && !operationIds.has(operationId));
        operationIds.add(operationId);
    };
    corruptUnless(Array.isArray(document.reservations) && ascending(document.reservations, (item) => item?.reservationId));
    corruptUnless(document.reservations.length <= limits.writableReservations);
    const reservationIds = new Set();
    for (const reservation of document.reservations) {
        checkResult(validateWritableReservation(reservation));
        corruptUnless(reservation.state === 'reserved' && reservation.sourceStoreIdentity === storeId);
        corruptUnless(pointers.has(reservation.workerPrincipal));
        reservationIds.add(reservation.reservationId);
        claim(reservation.operationId);
    }
    corruptUnless(Array.isArray(document.tombstones) && ascending(document.tombstones, (item) => item?.reservationId));
    for (const tombstone of document.tombstones) {
        checkResult(validateReservationTombstone(tombstone));
        corruptUnless(!reservationIds.has(tombstone.reservationId));
        claim(tombstone.operationId);
    }
    corruptUnless(Array.isArray(document.receipts) && ascending(document.receipts, (item) => item?.operationId));
    for (const receipt of document.receipts) {
        corruptUnless(exactKeys(receipt, RECEIPT_KEYS));
        corruptUnless(SOURCE_OPERATION_KINDS.includes(receipt.kind) && receipt.kind !== 'reserve');
        claim(receipt.operationId);
        validateActor(receipt.actor);
        corruptUnless((receipt.ownerPrincipal === null && receipt.ownerGeneration === null)
            || (isPrincipal(receipt.ownerPrincipal) && isId(receipt.ownerGeneration)));
        checkResult(validateSourceOperation(receipt.kind, receipt.result));
        corruptUnless(receipt.result.operationId === receipt.operationId
            && receipt.result.requestDigest === receipt.requestDigest);
    }
    corruptUnless(document.tombstones.length + document.receipts.length + 2 * document.reservations.length
        <= limits.operationReceipts);
    return document;
}

// ---------------------------------------------------------------- open-time inspection

function inspectWitness(fsApi, paths) {
    const read = readBounded(fsApi, paths.witnessFile, MAX_WITNESS_BYTES);
    if (read.missing) return { state: 'absent' };
    if (read.invalid) return { state: 'invalid' };
    let document;
    try {
        document = parseCanonicalOrThrowInternal(read.bytes, MAX_WITNESS_BYTES);
    } catch (error) {
        if (isContractFailure(error)) return { state: 'invalid' };
        throw error;
    }
    return validWitness(document) ? { state: 'valid', storeId: document.storeId } : { state: 'invalid' };
}

function listCreating(fsApi, paths) {
    let names;
    try {
        names = fsApi.readdirSync(paths.dataDir);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    return names.filter((name) => CREATING_NAME.test(name)).map((name) => ({
        name,
        storeId: CREATING_NAME.exec(name)[1],
        directory: path.join(paths.dataDir, name),
    }));
}

function readSnapshotFile(fsApi, file, storeId, limits) {
    const read = readBounded(fsApi, file, limits.sourceStateBytes);
    if (read.missing || read.invalid) storeFail(S.stateCorrupt);
    const document = parseStrict(read.bytes, limits.sourceStateBytes);
    validateSnapshotDocument(document, { storeId, limits });
    return { document, bytes: read.bytes };
}

// Remove a creation staging directory left by a crashed never-completed
// creation: only regular files and the two content subdirectories.
function removeStagingTree(fsApi, directory) {
    const stat = lstatOrNull(fsApi, directory);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) storeFail(S.stateCorrupt);
    for (const name of fsApi.readdirSync(directory)) {
        const member = path.join(directory, name);
        const memberStat = fsApi.lstatSync(member);
        if (memberStat.isDirectory() && !memberStat.isSymbolicLink() && (name === 'closures' || name === 'selections')) {
            for (const child of fsApi.readdirSync(member)) {
                const childStat = fsApi.lstatSync(path.join(member, child));
                if (!childStat.isFile() || childStat.isSymbolicLink()) storeFail(S.stateCorrupt);
                fsApi.unlinkSync(path.join(member, child));
            }
            fsApi.rmdirSync(member);
        } else if (memberStat.isFile() && !memberStat.isSymbolicLink()) {
            fsApi.unlinkSync(member);
        } else {
            storeFail(S.stateCorrupt);
        }
    }
    fsApi.rmdirSync(directory);
}

function crashRunner(faults, state) {
    return (point, detail) => {
        const hook = faults?.[point];
        if (typeof hook !== 'function') return;
        try {
            hook(detail);
        } catch (_) {
            state.crashed = true;
            throw new SimulatedCrash(point);
        }
    };
}

async function enumerateHolders(enumerateExpectedHolders) {
    let answer;
    try {
        answer = await enumerateExpectedHolders();
    } catch (_) {
        return null;
    }
    if (!answer || answer.status !== 'known' || !Array.isArray(answer.principals)) return null;
    const principals = [...answer.principals];
    if (!principals.every(isPrincipal)) return null;
    principals.sort();
    for (let index = 1; index < principals.length; index += 1) {
        if (principals[index - 1] === principals[index]) return null;
    }
    return principals;
}

function initialSnapshot(storeId, expected) {
    return {
        schema: SOURCE_PROTECTION_STORE_SCHEMA,
        storeId,
        revision: 1,
        holders: { state: expected.length === 0 ? 'ready' : 'awaiting-holder-ack', expected, acknowledged: [] },
        record: null,
        generations: [],
        reservations: [],
        tombstones: [],
        receipts: [],
    };
}

// A2.2 creation: complete store in a staging sibling, witness, then rename.
function createStore({ fsApi, paths, storeId, expected, nowMs, run, state }) {
    const staging = paths.creatingDir(storeId);
    const document = initialSnapshot(storeId, expected);
    fsApi.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    fsApi.mkdirSync(staging, { mode: 0o700 });
    fsApi.mkdirSync(path.join(staging, 'closures'), { mode: 0o700 });
    fsApi.mkdirSync(path.join(staging, 'selections'), { mode: 0o700 });
    run('afterStagingMkdir', { staging });
    createPrivateFile(fsApi, path.join(staging, 'state.json'), canonicalBytes(document));
    fsyncDirectory(fsApi, path.join(staging, 'closures'));
    fsyncDirectory(fsApi, path.join(staging, 'selections'));
    fsyncDirectory(fsApi, staging);
    fsyncDirectory(fsApi, paths.dataDir);
    run('afterStagingFsync', { staging });
    const witness = canonicalBytes({
        schema: SOURCE_PROTECTION_WITNESS_SCHEMA,
        storeId,
        initializedAt: new Date(nowMs()).toISOString(),
        initializedBy: 'fresh',
    });
    const temporary = path.join(paths.dataDir, `.${SOURCE_PROTECTION_WITNESS_NAME}.${crypto.randomUUID()}.tmp`);
    try {
        createPrivateFile(fsApi, temporary, witness);
        run('afterWitnessTemp', { temporary });
        // Publication never replaces an existing witness.
        try {
            fsApi.linkSync(temporary, paths.witnessFile);
        } catch (error) {
            if (error?.code === 'EEXIST') storeFail(S.stateCorrupt);
            throw error;
        }
        fsyncDirectory(fsApi, paths.dataDir);
    } finally {
        if (!state.crashed) removeIfPresent(fsApi, temporary);
    }
    run('afterWitnessPublish', { witness: paths.witnessFile });
    completeCreation({ fsApi, paths, storeId, run });
}

function completeCreation({ fsApi, paths, storeId, run }) {
    if (directoryKind(fsApi, paths.storeDir) !== 'absent') storeFail(S.stateCorrupt);
    fsApi.renameSync(paths.creatingDir(storeId), paths.storeDir);
    run('afterStoreRename', { storeDir: paths.storeDir });
    fsyncDirectory(fsApi, paths.dataDir);
}

function verifyContentFiles(fsApi, paths, document) {
    for (const directory of [paths.closuresDir, paths.selectionsDir]) {
        corruptUnless(directoryKind(fsApi, directory) === 'present');
    }
    if (document.record === null) return;
    const checks = [
        [paths.closuresDir, document.record.sourceClosureDigest, validateSourceClosure],
        [paths.selectionsDir, document.record.sourceSelectionDigest, validateSourceSelection],
    ];
    for (const [directory, digest, validate] of checks) {
        const read = readBounded(fsApi, path.join(directory, `${digest}.json`), MAX_CLOSURE_BYTES);
        corruptUnless(!read.missing && !read.invalid && sha256(read.bytes) === digest);
        checkResult(validate(parseStrict(read.bytes, MAX_CLOSURE_BYTES)));
    }
}

function effectiveLimits(overrides) {
    if (overrides === undefined) return INTERLOCK_LIMITS_V1;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
    const limits = { ...INTERLOCK_LIMITS_V1 };
    for (const [key, value] of Object.entries(overrides)) {
        if (!Object.hasOwn(INTERLOCK_LIMITS_V1, key)) return null;
        // Lower only: a deployment may never widen a v1 interlock bound.
        if (!Number.isSafeInteger(value) || value < 1 || value > INTERLOCK_LIMITS_V1[key]) return null;
        limits[key] = value;
    }
    return Object.freeze(limits);
}

async function proveLease(assertWorkspaceLease, paths) {
    if (typeof assertWorkspaceLease !== 'function') return false;
    try {
        await assertWorkspaceLease(paths);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Open (and, only for lease-holding lifecycle code, create or complete) the
 * workspace source-protection store. Returns a Result whose value is the
 * store handle.
 *
 * Options: `workspaceRoot`; `create` (boolean); `assertWorkspaceLease`
 * (throws unless the caller holds the workspace mutation lease);
 * `enumerateExpectedHolders` (trusted enumeration, A2.2/A3.2; default
 * refuses); `limits` (lower-only overrides of INTERLOCK_LIMITS_V1); `fsApi`;
 * `faults` (named crash hooks); `processIdentity`; `clock`.
 */
export async function openSourceProtectionStore({
    workspaceRoot,
    create = false,
    assertWorkspaceLease,
    enumerateExpectedHolders = async () => ({ status: 'unknown' }),
    limits: limitOverrides,
    fsApi = fs,
    faults = {},
    processIdentity,
    clock,
} = {}) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot || typeof create !== 'boolean') {
        return errorResult(S.invalidRequest);
    }
    const limits = effectiveLimits(limitOverrides);
    if (!limits) return errorResult(S.invalidRequest);
    const paths = sourceProtectionPaths(workspaceRoot);
    const identity = processIdentity || defaultProcessIdentity({ fsApi });
    const time = clock || defaultClock();
    const crashState = { crashed: false };
    const run = crashRunner(faults, crashState);
    try {
        if (create && !(await proveLease(assertWorkspaceLease, paths))) return errorResult(S.forbidden);
        let witness = inspectWitness(fsApi, paths);
        let storeKind = directoryKind(fsApi, paths.storeDir);
        let creating = listCreating(fsApi, paths);
        if (witness.state === 'absent' && storeKind === 'absent') {
            if (!create) return errorResult(S.sourceUnavailable);
            const expected = await enumerateHolders(enumerateExpectedHolders);
            if (!expected) return errorResult(S.sourceUnavailable);
            // Never initialized: stale staging and witness temporaries are garbage.
            for (const entry of creating) removeStagingTree(fsApi, entry.directory);
            for (const name of fsApi.existsSync(paths.dataDir) ? fsApi.readdirSync(paths.dataDir) : []) {
                if (WITNESS_TEMP.test(name)) removeIfPresent(fsApi, path.join(paths.dataDir, name));
            }
            createStore({ fsApi, paths, storeId: newId(), expected, nowMs: time.nowMs, run, state: crashState });
        } else if (witness.state === 'valid' && storeKind === 'absent') {
            const staging = creating.length === 1 && creating[0].storeId === witness.storeId ? creating[0] : null;
            if (!staging) return errorResult(S.stateCorrupt);
            readSnapshotFile(fsApi, path.join(staging.directory, 'state.json'), witness.storeId, limits);
            // A3.3: only the lease holder completes the interrupted creation.
            if (!(await proveLease(assertWorkspaceLease, paths))) return errorResult(S.sourceUnavailable);
            completeCreation({ fsApi, paths, storeId: witness.storeId, run });
        } else if (!(witness.state === 'valid' && storeKind === 'present' && creating.length === 0)) {
            return errorResult(S.stateCorrupt);
        }
        witness = inspectWitness(fsApi, paths);
        storeKind = directoryKind(fsApi, paths.storeDir);
        creating = listCreating(fsApi, paths);
        if (witness.state !== 'valid' || storeKind !== 'present' || creating.length !== 0) return errorResult(S.stateCorrupt);
        const { document } = readSnapshotFile(fsApi, paths.stateFile, witness.storeId, limits);
        verifyContentFiles(fsApi, paths, document);
        return okResult(createHandle({
            fsApi, paths, storeId: witness.storeId, limits, identity, time, faults,
        }));
    } catch (error) {
        if (error instanceof SimulatedCrash) return errorResult(S.outcomeUnknown);
        if (error instanceof StoreError) return errorResult(error.code);
        if (isContractFailure(error)) return errorResult(S.stateCorrupt);
        return errorResult(S.sourceUnavailable);
    }
}

// ---------------------------------------------------------------- handle

function createHandle({ fsApi, paths, storeId, limits, identity, time, faults }) {
    // Threads of one process share a pid; a claim also records the thread.
    const thread = Number.isSafeInteger(identity.threadId) && identity.threadId >= 0 ? identity.threadId : currentThreadId;
    const crashState = { crashed: false };
    const run = crashRunner(faults, crashState);
    let queue = Promise.resolve();
    let dead = false;
    let cache = null;

    function lockDocument(token) {
        return canonicalBytes({
            pid: identity.pid,
            startIdentity: identity.startIdentity ?? null,
            scope: identity.scope ?? null,
            token,
        });
    }

    function readLock() {
        const read = readBounded(fsApi, paths.lockFile, MAX_LOCK_BYTES);
        if (read.missing) return { missing: true };
        if (read.invalid) return { malformed: true };
        try {
            const document = parseCanonicalOrThrowInternal(read.bytes, MAX_LOCK_BYTES);
            if (!exactKeys(document, LOCK_KEYS) || !Number.isSafeInteger(document.pid) || document.pid < 1
                || typeof document.token !== 'string'
                || !(document.scope === null || typeof document.scope === 'string')
                || !(document.startIdentity === null || typeof document.startIdentity === 'string')) {
                return { malformed: true };
            }
            return { document, stat: read.stat, bytes: read.bytes };
        } catch (error) {
            if (isContractFailure(error)) return { malformed: true };
            throw error;
        }
    }

    // Stale-owner reclaim only with proof of death inside the same PID
    // namespace (or PID reuse proved by a different start identity there).
    function reclaimable(lock) {
        const { document } = lock;
        if (!document.scope || !identity.scope || document.scope !== identity.scope) return false;
        if (document.pid === identity.pid && document.startIdentity === (identity.startIdentity ?? null)) return false;
        if (!identity.isAlive(document.pid)) return true;
        const current = identity.startIdentityOf(document.pid);
        return Boolean(document.startIdentity && current && current !== document.startIdentity);
    }

    // Publish `bytes` at `target` atomically and without replacing anything:
    // O_EXCL temporary, fsync, link. 'published' or 'exists'. ENOENT means a
    // holder swept our temporary (retry) unless the store directory vanished,
    // which is corruption, never a fresh start.
    function publishExclusive(target, bytes) {
        const temporary = path.join(paths.storeDir, `.lock.${crypto.randomUUID()}.tmp`);
        try {
            createPrivateFile(fsApi, temporary, bytes);
            fsApi.linkSync(temporary, target);
            return 'published';
        } catch (error) {
            if (error?.code === 'EEXIST') return 'exists';
            if (error?.code === 'ENOENT') {
                if (directoryKind(fsApi, paths.storeDir) !== 'present') storeFail(S.stateCorrupt);
                return 'exists';
            }
            throw error;
        } finally {
            try { removeIfPresent(fsApi, temporary); } catch (_) {}
        }
    }

    function tryPublishLock(token) {
        return publishExclusive(paths.lockFile, lockDocument(token)) === 'published' ? 'acquired' : 'busy';
    }

    // ---- stale-lock reclaim by exclusive claim (A1.3, A9.2) ----
    //
    // A lock is never moved aside or restored. To remove a dead owner's lock a
    // reclaimer must first publish the exclusive claim
    // `lock.reclaim-<sha256(dead token)>-<n>` (link without replace). Exactly one
    // reclaimer wins a given claim, and while the dead lock is still at the lock
    // path nobody else can change that path: publishers get EEXIST, the dead
    // owner is gone and every other reclaimer of that token lost the claim. The
    // winner therefore re-reads the lock and removes it only when it is still
    // the exact observed file. A claim whose own claimant is proved dead in the
    // same scope is superseded by claim n+1. No lock file is ever created except
    // by its own publisher, so no lock can become ownerless.
    function claimTarget(token) {
        return sha256(Buffer.from(String(token), 'utf8'));
    }

    function claimsFor(target) {
        let names;
        try {
            names = fsApi.readdirSync(paths.storeDir);
        } catch (error) {
            if (error?.code === 'ENOENT') storeFail(S.stateCorrupt);
            throw error;
        }
        const prefix = `${RECLAIM_CLAIM_PREFIX}${target}-`;
        return names.filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
            .map((name) => Number(name.slice(prefix.length)))
            .filter(Number.isSafeInteger);
    }

    function readClaim(target, sequence) {
        const read = readBounded(fsApi, path.join(paths.storeDir, `${RECLAIM_CLAIM_PREFIX}${target}-${sequence}`), MAX_LOCK_BYTES);
        if (!read.bytes) return null;
        try {
            const document = parseCanonicalOrThrowInternal(read.bytes, MAX_LOCK_BYTES);
            if (!exactKeys(document, CLAIM_KEYS) || document.target !== target || !Number.isSafeInteger(document.pid)
                || document.pid < 1 || !Number.isSafeInteger(document.thread) || document.thread < 0
                || !(document.scope === null || typeof document.scope === 'string')
                || !(document.startIdentity === null || typeof document.startIdentity === 'string')) {
                return null;
            }
            return document;
        } catch (error) {
            if (isContractFailure(error)) return null;
            throw error;
        }
    }

    // A claim written by this very thread of this process. Reclaim is
    // synchronous, so while this thread is here it has no reclaim in flight:
    // such a claim was abandoned by an earlier failed attempt.
    function ownAbandonedClaim(claim) {
        return claim.pid === identity.pid
            && claim.startIdentity === (identity.startIdentity ?? null)
            && claim.scope === (identity.scope ?? null)
            && claim.thread === thread;
    }

    function reclaimStaleLock(observed) {
        const target = claimTarget(observed.document.token);
        const sequences = claimsFor(target);
        let next = 0;
        if (sequences.length) {
            const latest = Math.max(...sequences);
            const claim = readClaim(target, latest);
            // A live (or unverifiable) claimant is finishing this reclaim: wait.
            if (!claim || !(reclaimable({ document: claim }) || ownAbandonedClaim(claim))) return false;
            next = latest + 1;
        }
        const claimFile = path.join(paths.storeDir, `${RECLAIM_CLAIM_PREFIX}${target}-${next}`);
        const claim = canonicalBytes({
            pid: identity.pid, scope: identity.scope ?? null, startIdentity: identity.startIdentity ?? null, thread, target,
        });
        const published = publishExclusive(claimFile, claim);
        if (published !== 'published') return false;
        try {
            run('afterReclaimClaim', { target });
            const current = readLock();
            if (current.document && current.stat.dev === observed.stat.dev && current.stat.ino === observed.stat.ino
                && current.bytes.equals(observed.bytes)) {
                removeIfPresent(fsApi, paths.lockFile);
                fsyncDirectory(fsApi, paths.storeDir);
            }
        } catch (error) {
            // A simulated crash models process death and leaves the claim to
            // be superseded once its claimant is proved dead. Any other error
            // must not leave a live claimant's claim behind: withdraw it
            // (best effort; this thread supersedes it on its next attempt).
            if (!isSimulatedCrash(error)) {
                try { removeIfPresent(fsApi, claimFile); } catch (_) {}
            }
            throw error;
        }
        return true;
    }

    // Claims are inert once their target is gone; a holder sweeps every claim
    // that does not target its own token. The target can never reappear at
    // the lock path, because locks are only ever created by their publisher.
    function sweepClaims({ keepTarget = null, onlyTarget = null } = {}) {
        let names;
        try {
            names = fsApi.readdirSync(paths.storeDir);
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        let removed = false;
        for (const name of names) {
            if (!name.startsWith(RECLAIM_CLAIM_PREFIX)) continue;
            const claimFor = name.slice(RECLAIM_CLAIM_PREFIX.length).replace(/-\d+$/, '');
            if (keepTarget !== null && claimFor === keepTarget) continue;
            if (onlyTarget !== null && claimFor !== onlyTarget) continue;
            const member = path.join(paths.storeDir, name);
            const stat = lstatOrNull(fsApi, member);
            if (stat && stat.isFile() && !stat.isSymbolicLink()) {
                removeIfPresent(fsApi, member);
                removed = true;
            }
        }
        if (removed) fsyncDirectory(fsApi, paths.storeDir);
    }

    async function acquireLock() {
        if (directoryKind(fsApi, paths.storeDir) !== 'present') storeFail(S.stateCorrupt);
        const token = crypto.randomBytes(16).toString('hex');
        const deadline = time.monotonicMs() + limits.lockWaitMs;
        // Every iteration checks the deadline and yields: no path spins.
        while (true) {
            if (tryPublishLock(token) === 'acquired') return token;
            const lock = readLock();
            if (lock.document && reclaimable(lock) && reclaimStaleLock(lock)) {
                if (tryPublishLock(token) === 'acquired') return token;
            }
            if (time.monotonicMs() >= deadline) storeFail(S.sourceUnavailable);
            await time.sleep(LOCK_POLL_MS);
        }
    }

    function stillHolding(token) {
        const lock = readLock();
        return Boolean(lock.document && lock.document.token === token && lock.document.pid === identity.pid);
    }

    // While our lock is at the lock path only we can change it (nobody can
    // prove a live owner dead), so check-then-unlink is safe. A9.2: also drop
    // any claim that targeted our token.
    function releaseLock(token) {
        if (stillHolding(token)) removeIfPresent(fsApi, paths.lockFile);
        sweepClaims({ onlyTarget: claimTarget(token) });
    }

    // Every temporary in the store is written under the lock, so a holder may
    // sweep all of them: they belong to a dead holder or are in-flight lock
    // temporaries whose owner retries.
    function sweepTemporaries() {
        let removed = false;
        for (const directory of [paths.storeDir, paths.closuresDir, paths.selectionsDir]) {
            let names;
            try {
                names = fsApi.readdirSync(directory);
            } catch (error) {
                if (error?.code === 'ENOENT') continue;
                throw error;
            }
            for (const name of names) {
                if (!STORE_TEMP.test(name)) continue;
                const member = path.join(directory, name);
                const stat = lstatOrNull(fsApi, member);
                if (stat && stat.isFile() && !stat.isSymbolicLink()) {
                    removeIfPresent(fsApi, member);
                    removed = true;
                }
            }
            if (removed) fsyncDirectory(fsApi, directory);
        }
    }

    // The witness must still name this store on every transaction: deleting or
    // replacing it (or the directory) is corruption, never a fresh start.
    function verifyIdentity() {
        const witness = inspectWitness(fsApi, paths);
        if (witness.state !== 'valid' || witness.storeId !== storeId) storeFail(S.stateCorrupt);
        if (listCreating(fsApi, paths).length !== 0) storeFail(S.stateCorrupt);
    }

    function readCurrent() {
        verifyIdentity();
        const read = readBounded(fsApi, paths.stateFile, limits.sourceStateBytes);
        if (read.missing || read.invalid) storeFail(S.stateCorrupt);
        const digest = sha256(read.bytes);
        if (cache && cache.digest === digest) return cache.document;
        const document = parseStrict(read.bytes, limits.sourceStateBytes);
        validateSnapshotDocument(document, { storeId, limits });
        deepFreeze(document);
        cache = { digest, document };
        return document;
    }

    function putContent(directory, document, validate, token) {
        const check = validate(document);
        if (!check.ok) storeFail(check.error.code === 'capacity_exceeded' ? S.capacityExceeded : S.invalidRequest);
        const bytes = canonicalBytes(document);
        const digest = sha256(bytes);
        const file = path.join(directory, `${digest}.json`);
        const existing = readBounded(fsApi, file, MAX_CLOSURE_BYTES);
        if (!existing.missing) {
            if (existing.invalid || !existing.bytes.equals(bytes)) storeFail(S.stateCorrupt);
            return digest;
        }
        if (!stillHolding(token)) storeFail(S.sourceUnavailable);
        const temporary = path.join(directory, `.${digest}.${crypto.randomUUID()}.tmp`);
        try {
            createPrivateFile(fsApi, temporary, bytes);
            run('afterContentTemp', { file });
            try {
                fsApi.linkSync(temporary, file);
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                const raced = readBounded(fsApi, file, MAX_CLOSURE_BYTES);
                if (raced.missing || raced.invalid || !raced.bytes.equals(bytes)) storeFail(S.stateCorrupt);
            }
            fsyncDirectory(fsApi, directory);
        } finally {
            if (!crashState.crashed) removeIfPresent(fsApi, temporary);
        }
        run('afterContentPublish', { file });
        return digest;
    }

    function commit(next, token, base) {
        const current = readCurrent();
        if (base.digest === null || cache?.digest !== base.digest) storeFail(S.sourceUnavailable);
        const document = { ...next, schema: SOURCE_PROTECTION_STORE_SCHEMA, storeId, revision: current.revision + 1 };
        let bytes;
        try {
            bytes = canonicalBytes(document);
        } catch (error) {
            if (isContractFailure(error)) storeFail(S.invalidRequest);
            throw error;
        }
        if (bytes.length > limits.sourceStateBytes) storeFail(S.capacityExceeded);
        try {
            validateSnapshotDocument(JSON.parse(bytes.toString('utf8')), { storeId, limits });
        } catch (error) {
            if (error instanceof StoreError) storeFail(S.invalidRequest);
            throw error;
        }
        const temporary = path.join(paths.storeDir, `.state.json.${crypto.randomUUID()}.tmp`);
        let renamed = false;
        try {
            createPrivateFile(fsApi, temporary, bytes);
            run('beforeCommit', { temporary });
            // No await between these checks and the rename: the rename is the
            // commit. Ownership is rechecked, and the snapshot must still be the
            // exact revision the transaction read (compare-and-set).
            if (!stillHolding(token)) storeFail(S.sourceUnavailable);
            const onDisk = readBounded(fsApi, paths.stateFile, limits.sourceStateBytes);
            if (!onDisk.bytes || sha256(onDisk.bytes) !== base.digest) storeFail(S.sourceUnavailable);
            fsApi.renameSync(temporary, paths.stateFile);
            renamed = true;
            cache = null;
            run('afterCommit', { revision: document.revision });
            try {
                fsyncDirectory(fsApi, paths.storeDir);
            } catch (_) {
                storeFail(S.outcomeUnknown, { committed: true });
            }
            run('afterDirectoryFsync', { revision: document.revision });
        } finally {
            if (!renamed && !crashState.crashed) removeIfPresent(fsApi, temporary);
        }
        return document.revision;
    }

    async function exclusive(fn) {
        const previous = queue;
        let releaseQueue;
        queue = new Promise((resolve) => { releaseQueue = resolve; });
        await previous;
        let token = null;
        try {
            if (dead || crashState.crashed) storeFail(S.sourceUnavailable);
            token = await acquireLock();
            sweepTemporaries();
            sweepClaims({ keepTarget: claimTarget(token) });
            const base = { digest: null };
            const transaction = Object.freeze({
                snapshot: () => {
                    const document = readCurrent();
                    if (base.digest === null) base.digest = cache.digest;
                    return document;
                },
                commit: (next) => {
                    if (base.digest === null) {
                        readCurrent();
                        base.digest = cache.digest;
                    }
                    return commit(next, token, base);
                },
                putClosure: (document) => putContent(paths.closuresDir, document, validateSourceClosure, token),
                putSelection: (document) => putContent(paths.selectionsDir, document, validateSourceSelection, token),
                crashPoint: (point, detail) => run(point, detail),
            });
            return await fn(transaction);
        } catch (error) {
            if (error instanceof StoreError && error.code === S.stateCorrupt) dead = true;
            throw error;
        } finally {
            // A simulated crash leaves its lock behind, exactly like process death.
            if (token && !crashState.crashed) {
                try { releaseLock(token); } catch (_) {}
            }
            releaseQueue();
        }
    }

    return Object.freeze({
        storeId,
        paths,
        limits,
        exclusive,
        isUsable: () => !dead && !crashState.crashed,
        readClosure(digest) {
            if (!/^[0-9a-f]{64}$/.test(String(digest))) return errorResult(S.invalidRequest);
            try {
                const read = readBounded(fsApi, path.join(paths.closuresDir, `${digest}.json`), MAX_CLOSURE_BYTES);
                if (read.missing) return errorResult(S.sourceUnavailable);
                if (read.invalid || sha256(read.bytes) !== digest) return errorResult(S.stateCorrupt);
                return okResult(parseStrict(read.bytes, MAX_CLOSURE_BYTES));
            } catch (error) {
                return errorResult(error instanceof StoreError ? error.code : S.sourceUnavailable);
            }
        },
    });
}

export const SOURCE_PROTECTION_CONTENT_FILE = CONTENT_FILE;
