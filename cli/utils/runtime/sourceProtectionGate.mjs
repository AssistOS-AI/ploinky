// Lifecycle gate for the workspace source-protection store (proof slice P5; frozen T0 section 5-6 + A1.2 + A3).
//
// Repository source transitions (update, install, enable, disable, link-install clone or writable adoption and the
// source-derived agent links) call `assertSourceSetFixed` before they change anything. The decision is synchronous and
// purely local:
//
//   - No source-protection store, witness or interrupted creation under `<workspace>/.ploinky/data` means the
//     workspace has no execution target. The call returns without writing anything, so ordinary workspaces are
//     unchanged. Only `lstat` and one `readdir` of `.ploinky/data` run.
//   - A store that exists fixes the protected source set (T0: "the protected source set stays fixed while any admitted
//     writable resource remains" and changes only through the interlock). The call refuses with
//     `source_transition_blocked` unless it runs inside `withApprovedSourceTransition`, which needs the single-use
//     approval of a `beginSourceTransition` whose durable `transitioning` marker is still on disk.
//   - A store whose presence cannot be determined refuses (fail closed).
//
// A change to a protected source set is two-phase and holds the workspace mutation lease across both phases:
//   PREPARE (`beginSourceTransition`): under the store lock require zero reservations and no marker, durably commit the
//     marker {operationId, allowed edit kinds, optional expected digests}. `reserve` refuses while the marker exists.
//   EDIT: lifecycle code runs inside `withApprovedSourceTransition(approval, syncFn)`. The approval is single use, bound
//     to the canonical root, store and operation, and applies to the synchronous scope only (never detached work).
//   COMMIT (`commitSourceTransition`): under the store lock re-resolve the source from disk, require provenance,
//     enforcement and alias coverage of the post-edit digests, write epoch + 1 and remove the marker in the same
//     critical section, then consume the approval.
// A failure or crash leaves the marker, so the workspace keeps refusing until an explicit commit or `abortSourceTransition`.
//
// Creating the store is never a side effect of a lifecycle command: only `initializeSourceProtection`, called by
// lease-holding operator code, creates it.
//
// The evidence builder below never claims host enforcement: enforcement and alias coverage come from injected trusted
// providers, and a missing provider refuses (the interlock defaults).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { digestOrThrow, errorResult, isOperationId, okResult } from '../../server/executionTarget/contract.mjs';
import { createManagementContextAuthority, createSourceProtectionInterlock } from './sourceProtectionInterlock.mjs';
import {
    SOURCE_PROTECTION_CREATING_PREFIX,
    openSourceProtectionStore,
    sourceProtectionPaths,
} from './sourceProtectionStore.mjs';

export const SOURCE_TRANSITION_BLOCKED = 'source_transition_blocked';

/** Lifecycle edit kinds that call the gate. */
export const SOURCE_TRANSITION_KINDS = Object.freeze([
    'repository-install', 'repository-update', 'repository-enable', 'repository-disable', 'repository-branch',
    'agent-link', 'link-install-clone', 'link-install-writable',
]);

export class SourceTransitionRefused extends Error {
    constructor(kind, reason) {
        super(`source protection refuses ${kind}: ${reason}`);
        this.name = 'SourceTransitionRefused';
        this.code = SOURCE_TRANSITION_BLOCKED;
        this.reason = reason;
        this.kind = kind;
    }
}

function missing(error) {
    return Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
 * `absent` only when no store, no witness and no interrupted creation exists; `unreadable` when that cannot be
 * proved. Performs no write.
 */
export function sourceProtectionPresence(workspaceRoot, fsApi = fs) {
    const paths = sourceProtectionPaths(workspaceRoot);
    for (const target of [paths.witnessFile, paths.storeDir]) {
        try {
            fsApi.lstatSync(target);
            return 'present';
        } catch (error) {
            if (!missing(error)) return 'unreadable';
        }
    }
    let names;
    try {
        names = fsApi.readdirSync(paths.dataDir);
    } catch (error) {
        return missing(error) ? 'absent' : 'unreadable';
    }
    return names.some((name) => name.startsWith(SOURCE_PROTECTION_CREATING_PREFIX)) ? 'present' : 'absent';
}

const MARKER_NAME = 'source-transition.json';
const MARKER_KEYS = ['version', 'operationId', 'storeId', 'root', 'approvalId', 'kinds', 'expected', 'createdAtMs'];
const APPROVAL_STATE = new WeakMap();
// The approval of the synchronous scope currently running; never carried across an await.
let CURRENT_APPROVAL = null;

/** The canonical (real) spelling of a workspace root, so `/tmp` and `/private/tmp` compare equal. */
export function canonicalWorkspaceRoot(workspaceRoot, fsApi = fs) {
    const resolved = path.resolve(String(workspaceRoot));
    try {
        return fsApi.realpathSync(resolved);
    } catch (_) {
        return resolved;
    }
}

function markerPath(workspaceRoot) {
    return path.join(sourceProtectionPaths(workspaceRoot).storeDir, MARKER_NAME);
}

function exactKeys(value, keys) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

/** `{state:'absent'}`, `{state:'present', marker}` or `{state:'corrupt'}`; no write. */
export function readTransitionMarker(workspaceRoot, fsApi = fs) {
    let bytes;
    try {
        bytes = fsApi.readFileSync(markerPath(workspaceRoot));
    } catch (error) {
        return missing(error) ? { state: 'absent' } : { state: 'corrupt' };
    }
    try {
        const marker = JSON.parse(bytes.toString('utf8'));
        if (!exactKeys(marker, MARKER_KEYS) || marker.version !== 1 || !isOperationId(marker.operationId)
            || typeof marker.storeId !== 'string' || typeof marker.root !== 'string' || typeof marker.approvalId !== 'string'
            || !Array.isArray(marker.kinds) || marker.kinds.length < 1 || !marker.kinds.every((kind) => SOURCE_TRANSITION_KINDS.includes(kind))) {
            return { state: 'corrupt' };
        }
        return { state: 'present', marker };
    } catch (_) {
        return { state: 'corrupt' };
    }
}

function writeMarker(fsApi, workspaceRoot, marker) {
    const file = markerPath(workspaceRoot);
    const directory = path.dirname(file);
    const temporary = path.join(directory, `.${MARKER_NAME}.${crypto.randomUUID()}.tmp`);
    const { constants } = fsApi;
    const descriptor = fsApi.openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try {
        fsApi.writeFileSync(descriptor, Buffer.from(JSON.stringify(marker), 'utf8'));
        fsApi.fsyncSync(descriptor);
    } finally {
        fsApi.closeSync(descriptor);
    }
    try {
        // Publication never replaces an existing marker.
        fsApi.linkSync(temporary, file);
    } finally {
        fsApi.unlinkSync(temporary);
    }
    syncDirectory(fsApi, directory);
}

function removeMarker(fsApi, workspaceRoot) {
    try {
        fsApi.unlinkSync(markerPath(workspaceRoot));
    } catch (error) {
        if (!missing(error)) throw error;
    }
    syncDirectory(fsApi, path.dirname(markerPath(workspaceRoot)));
}

function syncDirectory(fsApi, directory) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(directory, fsApi.constants.O_RDONLY);
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) { /* nothing to release */ }
        }
    }
}

function approvalUsable(approval, workspaceRoot, fsApi) {
    const state = approval && APPROVAL_STATE.get(approval);
    return Boolean(state) && state.used === false && approval.root === canonicalWorkspaceRoot(workspaceRoot, fsApi);
}

/**
 * Runs the lifecycle edits of one prepared transition. `fn` must be synchronous: the approval exists only for the
 * duration of the call and is never carried into detached or later work.
 */
export function withApprovedSourceTransition(approval, fn, { fsApi = fs } = {}) {
    if (typeof fn !== 'function' || !approval || !APPROVAL_STATE.has(approval) || APPROVAL_STATE.get(approval).used
        || CURRENT_APPROVAL !== null) {
        throw new SourceTransitionRefused('approval', 'no usable prepared source transition');
    }
    CURRENT_APPROVAL = approval;
    let result;
    try {
        result = fn();
    } finally {
        CURRENT_APPROVAL = null;
    }
    if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new SourceTransitionRefused('approval', 'an approved source transition scope must be synchronous');
    }
    void fsApi;
    return result;
}

/**
 * Call before a lifecycle edit that changes repository source or a source-derived link.
 * Returns `{inert:true}` for a workspace without a store, `{inert:false, approved:true}` inside the approved scope
 * of a prepared transition (marker on disk, approval unused, kind allowed), and throws SourceTransitionRefused otherwise.
 */
export function assertSourceSetFixed({ workspaceRoot, kind, fsApi = fs } = {}) {
    const presence = sourceProtectionPresence(workspaceRoot, fsApi);
    if (presence === 'absent') return Object.freeze({ inert: true });
    if (presence !== 'present') throw new SourceTransitionRefused(kind, 'source-protection state cannot be read');
    const approval = CURRENT_APPROVAL;
    if (approval && approvalUsable(approval, workspaceRoot, fsApi) && approval.kinds.includes(kind)) {
        const read = readTransitionMarker(workspaceRoot, fsApi);
        if (read.state === 'present' && read.marker.operationId === approval.operationId
            && read.marker.approvalId === approval.approvalId && read.marker.storeId === approval.storeId) {
            return Object.freeze({ inert: false, approved: true });
        }
    }
    throw new SourceTransitionRefused(kind, 'the protected source set is fixed; prepare an operator source transition');
}

async function assertLease(assertWorkspaceLease, workspaceRoot) {
    if (typeof assertWorkspaceLease !== 'function') return false;
    try {
        await assertWorkspaceLease(sourceProtectionPaths(workspaceRoot));
        return true;
    } catch (_) {
        return false;
    }
}

function lockedStore(real, around) {
    return Object.freeze({
        storeId: real.storeId,
        limits: real.limits,
        paths: real.paths,
        exclusive: (fn) => real.exclusive((transaction) => around(transaction, fn)),
    });
}

/**
 * A view of the store whose every transaction refuses while a `transitioning` marker exists or cannot be read.
 * The Router service uses it for `reserve`, so a reservation cannot slip in between PREPARE and COMMIT.
 */
export function guardReservationsAgainstTransition(store, workspaceRoot, fsApi = fs) {
    return lockedStore(store, async (transaction, fn) => {
        if (readTransitionMarker(workspaceRoot, fsApi).state !== 'absent') return errorResult(SOURCE_TRANSITION_BLOCKED);
        return fn(transaction);
    });
}

/**
 * PREPARE. The caller holds the workspace mutation lease (`assertWorkspaceLease` throws otherwise) and keeps it until
 * `commitSourceTransition` or `abortSourceTransition` returns. Refuses while a reservation or another marker exists.
 *   kinds      the lifecycle edit kinds the approval allows
 *   expected   optional {selectionDigest, closureDigest} the commit must carry
 */
export async function beginSourceTransition({
    workspaceRoot, assertWorkspaceLease, operationId, kinds, expected = null, fsApi = fs, clock,
} = {}) {
    if (!isOperationId(operationId) || !Array.isArray(kinds) || kinds.length < 1 || new Set(kinds).size !== kinds.length
        || !kinds.every((kind) => SOURCE_TRANSITION_KINDS.includes(kind))
        || !(expected === null || (expected && typeof expected.selectionDigest === 'string' && typeof expected.closureDigest === 'string'))) {
        return errorResult('invalid_request');
    }
    if (!(await assertLease(assertWorkspaceLease, workspaceRoot))) return errorResult('forbidden');
    const opened = await openSourceProtectionStore({ workspaceRoot, create: false, fsApi });
    if (!opened.ok) return opened;
    const store = opened.value;
    const root = canonicalWorkspaceRoot(workspaceRoot, fsApi);
    const approvalId = crypto.randomUUID();
    try {
        const outcome = await store.exclusive(async (transaction) => {
            if (readTransitionMarker(workspaceRoot, fsApi).state !== 'absent') return SOURCE_TRANSITION_BLOCKED;
            if (transaction.snapshot().reservations.length !== 0) return SOURCE_TRANSITION_BLOCKED;
            writeMarker(fsApi, workspaceRoot, {
                version: 1, operationId, storeId: store.storeId, root, approvalId, kinds: [...kinds].sort(),
                expected: expected ? { selectionDigest: expected.selectionDigest, closureDigest: expected.closureDigest } : null,
                createdAtMs: (clock || { nowMs: () => Date.now() }).nowMs(),
            });
            return null;
        });
        if (outcome) return errorResult(outcome);
    } catch (_) {
        return errorResult('outcome_unknown');
    }
    const approval = Object.freeze({
        root, storeId: store.storeId, operationId, approvalId, kinds: Object.freeze([...kinds]),
    });
    APPROVAL_STATE.set(approval, { used: false });
    return okResult({ approval });
}

/**
 * Explicit operator abort (also for a marker left by a crash). Inside the same store lock it re-resolves the source from
 * disk: when the bytes still match the current record's selection and closure digests the marker is simply removed;
 * otherwise (a partial edit, an unreadable tree, no resolver) the record is first written as `unavailable`, so
 * reservations stay refused until a fresh begin/commit records the tree as it now is. The epoch is not changed.
 *   resolveSource   async () => ({selection, closure}), the trusted resolver of the post-edit tree
 */
export async function abortSourceTransition({
    workspaceRoot, assertWorkspaceLease, approval = null, resolveSource, fsApi = fs,
} = {}) {
    if (!(await assertLease(assertWorkspaceLease, workspaceRoot))) return errorResult('forbidden');
    const opened = await openSourceProtectionStore({ workspaceRoot, create: false, fsApi });
    if (!opened.ok) return opened;
    try {
        const outcome = await opened.value.exclusive(async (transaction) => {
            const present = readTransitionMarker(workspaceRoot, fsApi).state !== 'absent';
            let unprotected = false;
            if (present) {
                const snapshot = transaction.snapshot();
                const { record } = snapshot;
                if (record && record.protectionStatus === 'protected') {
                    let unchanged = false;
                    try {
                        const resolved = await resolveSource();
                        unchanged = digestOrThrow(resolved.selection) === record.sourceSelectionDigest
                            && digestOrThrow(resolved.closure) === record.sourceClosureDigest;
                    } catch (_) {
                        unchanged = false;
                    }
                    if (!unchanged) {
                        transaction.commit({
                            holders: snapshot.holders,
                            record: { ...record, protectionStatus: 'unavailable', enforcementDigest: null, aliasCoverageDigest: null },
                            generations: [...snapshot.generations],
                            reservations: [...snapshot.reservations],
                            tombstones: [...snapshot.tombstones],
                            receipts: [...snapshot.receipts],
                        });
                        unprotected = true;
                    }
                }
            }
            removeMarker(fsApi, workspaceRoot);
            return { aborted: present, unprotected };
        });
        if (approval && APPROVAL_STATE.has(approval)) APPROVAL_STATE.get(approval).used = true;
        return okResult(outcome);
    } catch (_) {
        return errorResult('outcome_unknown');
    }
}

/**
 * COMMIT of a prepared transition, still under the caller's lease. The evidence providers re-resolve the source from
 * disk now, so the recorded digests are those of the post-edit tree. On success the epoch is advanced, the marker is
 * removed in the same critical section and the approval is consumed; on any refusal the marker stays.
 *   request    the `transition` operation body; `operationId` must equal the prepared operation
 */
export async function commitSourceTransition({
    workspaceRoot, operatorIdentity, assertWorkspaceLease, scope, evidence, isSourceReservationHolder, request, approval, fsApi = fs, clock,
} = {}) {
    if (!approvalUsable(approval, workspaceRoot, fsApi) || !request || request.operationId !== approval.operationId) {
        return errorResult('forbidden');
    }
    if (!(await assertLease(assertWorkspaceLease, workspaceRoot))) return errorResult('forbidden');
    const opened = await openSourceProtectionStore({ workspaceRoot, create: false, fsApi });
    if (!opened.ok) return opened;
    if (opened.value.storeId !== approval.storeId) return errorResult('forbidden');
    const authority = createManagementContextAuthority();
    let context;
    try {
        context = authority.operator({ operatorIdentity });
    } catch (_) {
        return errorResult('invalid_request');
    }
    const store = lockedStore(opened.value, async (transaction, fn) => {
        const read = readTransitionMarker(workspaceRoot, fsApi);
        if (read.state !== 'present' || read.marker.operationId !== approval.operationId
            || read.marker.approvalId !== approval.approvalId || read.marker.storeId !== approval.storeId) {
            return errorResult(SOURCE_TRANSITION_BLOCKED);
        }
        const { expected } = read.marker;
        if (expected && (request.selectionDigest !== expected.selectionDigest || request.closureDigest !== expected.closureDigest)) {
            return errorResult('source_binding_mismatch');
        }
        const result = await fn(transaction);
        if (result && result.ok) removeMarker(fsApi, workspaceRoot);
        return result;
    });
    const interlock = createSourceProtectionInterlock({
        store, authority, currentScope: scope, isSourceReservationHolder, evidence, ...(clock ? { clock } : {}),
    });
    const result = await interlock.prepareSourceTransition(context, request);
    if (!result.ok) return result;
    APPROVAL_STATE.get(approval).used = true;
    return okResult({ transition: result.value });
}


/**
 * Operator-only creation of the store. `assertWorkspaceLease` must throw unless the caller holds the workspace
 * mutation lease. `enumerateExpectedHolders` is the trusted holder enumeration (T0 A2.2/A3.2).
 */
export async function initializeSourceProtection({ workspaceRoot, assertWorkspaceLease, enumerateExpectedHolders, fsApi = fs } = {}) {
    const opened = await openSourceProtectionStore({
        workspaceRoot, create: true, assertWorkspaceLease, enumerateExpectedHolders, fsApi,
    });
    if (!opened.ok) return opened;
    return okResult({ sourceStoreIdentity: opened.value.storeId });
}

/**
 * Trusted-evidence adapter for the operator transition.
 *
 *   resolveSource()        async () => ({selection, closure}); the trusted resolver's enumeration of the exact
 *                          loadable source now (dirty and untracked entries included, see T0 section 5)
 *   acceptedProvenance     Map or object: sourceAcceptanceIdentity -> {selectionDigest, closureDigest}, the independently
 *                          accepted adoption records. A Git HEAD or a hash alone never appears here.
 *   enforcement()          async () => ({status:'protected', enforcementDigest}) from the host-enforcement mechanism
 *   aliasRoots()           async () => ({status:'complete', roots}) alias coverage (T0 A5.2)
 *
 * Provenance is accepted only when the resolved source digests equal the digests of an accepted record, so a dirty,
 * untracked, re-linked or otherwise changed tree without a fresh acceptance is `source_provenance_unaccepted`.
 */
export function createLifecycleSourceEvidence({ resolveSource, acceptedProvenance, enforcement, aliasRoots } = {}) {
    const accepted = acceptedProvenance instanceof Map
        ? acceptedProvenance : new Map(Object.entries(acceptedProvenance || {}));
    const evidence = {};
    evidence.provenance = async ({ selectionDigest, closureDigest, sourceAcceptanceIdentity }) => {
        const record = accepted.get(sourceAcceptanceIdentity);
        if (!record || record.selectionDigest !== selectionDigest || record.closureDigest !== closureDigest) {
            return { status: 'unaccepted' };
        }
        if (typeof resolveSource !== 'function') return { status: 'unaccepted' };
        const { selection, closure } = await resolveSource();
        if (digestOrThrow(selection) !== record.selectionDigest || digestOrThrow(closure) !== record.closureDigest) {
            return { status: 'unaccepted' };
        }
        return { status: 'accepted', acceptanceIdentity: sourceAcceptanceIdentity, selection, closure };
    };
    if (typeof enforcement === 'function') evidence.enforcement = async () => enforcement();
    if (typeof aliasRoots === 'function') evidence.aliasCoverage = async () => aliasRoots();
    return Object.freeze(evidence);
}
