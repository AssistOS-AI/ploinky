// Effective hardware availability of one captured edge generation (M-NW-01 D2-S).
//
// The durable store (cli/sandbox/hardwareAvailabilityStore.mjs) holds committed
// entries and staged slots. A slot names the run-scoped status file of one
// background launch; the worker's durable terminal rename of that file is the
// activation. This resolver turns store + evidence into the denials a captured
// generation carries, with no lock, no wait, no write, no directory listing and
// no marker, canonical-status or unslotted-status read:
//
//   - the store snapshot is cached by the lstat identities of the witness, the
//     store directory and policy.json, and re-read only when one changed;
//   - each applicable slot costs one bigint lstat of its own status file (at
//     most 256 per capture); the file is read only when its
//     (dev, ino, size, mtime, ctime) changed, and the new cache key is taken
//     from the fstat of the descriptor that was read;
//   - only validated `active` evidence and gated committed entries yield a
//     typed denial. Every other class (missing, pending, succeeded, unowned,
//     failed-generic, invalid) yields none: the route keeps the existing generic
//     fail-closed disposition.
//
// It takes already-resolved edge generation `paths` and imports nothing from
// edgeGeneration.js, so the lease families in that module can call it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readHardwareAvailabilityPolicy } from '../sandbox/hardwareAvailabilityStore.mjs';
import { buildAvailabilityProjection, compileAvailabilityProjection } from './hardwareAvailability.mjs';
import { validateHardwareOutcome } from '../sandbox/hardwareLimits/errors.mjs';
import {
    NO_WAIT_STATUS_STATES,
    noWaitTerminalHardwareOutcome,
    validateNoWaitTerminalTimestamps,
} from '../commands/noWaitProtocol.js';
import { exactNoWaitImmutableIdentity } from '../commands/noWaitWorkerArgs.js';

export const HARDWARE_EVIDENCE_BYTE_LIMIT = 256 * 1024;
export const MAX_EVIDENCE_CACHE_ENTRIES = 256;
const NO_WAIT_DIR_NAME = 'no-wait';
const TIMESTAMP_FIELDS = Object.freeze([
    'runStartedAtMs', 'startedAtMs', 'sequencePhaseStartedAtMs', 'finishedAtMs',
    'startedAt', 'sequencePhaseStartedAt', 'finishedAt',
]);

export const EVIDENCE_CLASSES = Object.freeze([
    'missing', 'pending', 'succeeded', 'succeeded-unowned', 'unowned', 'failed-generic', 'invalid', 'active',
]);

/** A fresh cache. Tests pass their own so a leaf never sees another leaf's reads. */
export function createHardwareAvailabilityResolverCache() {
    return { stores: new Map(), evidence: new Map() };
}
const DEFAULT_CACHE = createHardwareAvailabilityResolverCache();

// ---------------------------------------------------------------- canonical hashing

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * The effective revision covers store-derived denial outputs only: sorted
 * [routeKey, sha256(compiled denial)]. Non-denial transitions (pending to
 * succeeded) and identical-content latches never move it.
 */
export function computeEffectiveRevision(denials) {
    const rows = [...denials.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([routeKey, compiled]) => [routeKey, sha256(JSON.stringify(stableValue(compiled)))]);
    return `sha256:${sha256(JSON.stringify(rows))}`;
}

// ---------------------------------------------------------------- change keys

function statKey(stat) {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
}

function lstatKey(fsApi, file) {
    try {
        return statKey(fsApi.lstatSync(file, { bigint: true }));
    } catch (error) {
        return error?.code === 'ENOENT' ? 'absent' : `error:${error?.code || 'unknown'}`;
    }
}

// ---------------------------------------------------------------- the D1 snapshot

function storeSnapshot(paths, fsApi, cache) {
    const key = [paths.availabilityWitnessFile, paths.availabilityStoreDir, paths.availabilityPolicyFile]
        .map((file) => lstatKey(fsApi, file)).join('|');
    const cached = cache.stores.get(paths.availabilityPolicyFile);
    if (cached && cached.key === key) {
        if (cached.error) throw Object.assign(new Error(cached.error.message), { code: cached.error.code });
        return cached.snapshot;
    }
    try {
        const snapshot = readHardwareAvailabilityPolicy({ paths, fsApi });
        cache.stores.set(paths.availabilityPolicyFile, { key, snapshot });
        return snapshot;
    } catch (error) {
        // Only deterministic content failures are cached under the unchanged key. A failed read (EMFILE, EIO, a
        // file replaced mid-read) must be read again by the next capture, as the evidence path does.
        if (error?.transient === true) cache.stores.delete(paths.availabilityPolicyFile);
        else cache.stores.set(paths.availabilityPolicyFile, { key, error: { message: String(error?.message || error), code: error?.code } });
        throw error;
    }
}

// ---------------------------------------------------------------- applicability

export function routeIsTargetLess(route) {
    if (!route || typeof route !== 'object') return false;
    const hostPort = Number(route.hostPort);
    if (Number.isSafeInteger(hostPort) && hostPort >= 1 && hostPort <= 65535) return false;
    const targets = route.serviceTargets;
    if (targets && typeof targets === 'object' && Object.keys(targets).length > 0) return false;
    return true;
}

// The captured generation names the identity's exact tuple on the route's own
// container, and that route carries no runtime target.
export function identityApplies({ key, instanceId, enableGeneration }, routeKey, generation) {
    const agent = generation?.agents?.[key];
    const route = generation?.routing?.routes?.[routeKey];
    return Boolean(agent && route)
        && agent.instanceId === instanceId
        && agent.enableGeneration === enableGeneration
        && route.container === key
        && routeIsTargetLess(route);
}

// ---------------------------------------------------------------- evidence

function slotSignature(routeKey, slot) {
    return [routeKey, slot.key, slot.instanceId, slot.enableGeneration, slot.runId, slot.runStartedAtMs, slot.waveIndex].join('|');
}

function sameIdentity(status, routeKey, slot) {
    let identity;
    try {
        identity = exactNoWaitImmutableIdentity(status);
    } catch (_) {
        return false;
    }
    return identity.containerName === slot.key
        && identity.instanceId === slot.instanceId
        && identity.enableGeneration === slot.enableGeneration
        && identity.routeKey === routeKey
        && identity.runId === slot.runId
        && identity.runStartedAtMs === slot.runStartedAtMs
        && identity.waveIndex === slot.waveIndex
        && identity.statusFile === slot.statusFile;
}

// Content-only classification (cacheable). The one time-dependent rule, T4
// (finishedAtMs <= now + 1000), is applied per capture to an `active` candidate.
function classifyDocument(status, routeKey, slot) {
    const invalid = { evidenceClass: 'invalid' };
    if (!status || typeof status !== 'object' || Array.isArray(status)) return invalid;
    if (!sameIdentity(status, routeKey, slot)) return invalid;
    if (typeof status.state !== 'string' || !NO_WAIT_STATUS_STATES.includes(status.state)) return invalid;
    const hasPid = Object.prototype.hasOwnProperty.call(status, 'pid');
    if (hasPid && !(Number.isSafeInteger(status.pid) && status.pid > 0)) return invalid;
    if (status.state === 'running') return { evidenceClass: hasPid ? 'succeeded' : 'succeeded-unowned' };
    if (status.state === 'starting') return { evidenceClass: hasPid ? 'pending' : 'unowned' };
    if (!hasPid) return { evidenceClass: 'unowned' };
    let outcome;
    try {
        outcome = noWaitTerminalHardwareOutcome(status, validateHardwareOutcome);
    } catch (_) {
        return invalid;
    }
    if (!outcome) return { evidenceClass: 'failed-generic' };
    if (outcome.key !== slot.key) return invalid;
    let finishedAtMs;
    try {
        ({ finishedAtMs } = validateNoWaitTerminalTimestamps(status, { nowMs: Number.MAX_SAFE_INTEGER }));
    } catch (_) {
        return invalid;
    }
    let projection;
    try {
        projection = buildAvailabilityProjection({
            outcome,
            instanceId: slot.instanceId,
            enableGeneration: slot.enableGeneration,
            observedAt: new Date(finishedAtMs).toISOString(),
        });
    } catch (_) {
        return invalid;
    }
    return {
        evidenceClass: 'active',
        projection,
        compiled: Object.freeze(compileAvailabilityProjection(projection)),
        timestamps: Object.freeze(Object.fromEntries(TIMESTAMP_FIELDS.map((field) => [field, status[field]]))),
    };
}

// One bounded read of a regular file by one descriptor. The new cache key is
// the fstat of that descriptor after the read.
function readEvidence(fsApi, file) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(file, fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW);
        const before = fsApi.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.size > BigInt(HARDWARE_EVIDENCE_BYTE_LIMIT)) return { problem: true };
        const size = Number(before.size);
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
            const count = fsApi.readSync(descriptor, bytes, offset, size - offset, offset);
            if (count <= 0) break;
            offset += count;
        }
        const after = fsApi.fstatSync(descriptor, { bigint: true });
        if (offset !== size || statKey(after) !== statKey(before)) return { problem: true, unstable: true };
        let value;
        try {
            value = JSON.parse(bytes.toString('utf8'));
        } catch (_) {
            return { problem: true, key: statKey(after) };
        }
        return { value, key: statKey(after) };
    } catch (error) {
        return error?.code === 'ENOENT' ? { missing: true } : { problem: true, unstable: true };
    } finally {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) {}
        }
    }
}

function evidenceFor({ fsApi, file, routeKey, slot, evidenceCache }) {
    const signature = slotSignature(routeKey, slot);
    let key;
    try {
        const stat = fsApi.lstatSync(file, { bigint: true });
        key = statKey(stat);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BigInt(HARDWARE_EVIDENCE_BYTE_LIMIT)) {
            const result = { evidenceClass: 'invalid' };
            evidenceCache.set(file, { key, signature, result });
            return result;
        }
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            const result = { evidenceClass: 'missing' };
            evidenceCache.set(file, { key: 'absent', signature, result });
            return result;
        }
        return { evidenceClass: 'invalid' };
    }
    const cached = evidenceCache.get(file);
    if (cached && cached.key === key && cached.signature === signature) return cached.result;
    const read = readEvidence(fsApi, file);
    if (read.missing) {
        const result = { evidenceClass: 'missing' };
        evidenceCache.set(file, { key: 'absent', signature, result });
        return result;
    }
    if (read.problem) {
        // An unstable read is judged invalid for this capture only; the next capture reads again.
        const result = { evidenceClass: 'invalid' };
        if (read.unstable) evidenceCache.delete(file);
        else evidenceCache.set(file, { key: read.key || key, signature, result });
        return result;
    }
    const result = classifyDocument(read.value, routeKey, slot);
    evidenceCache.set(file, { key: read.key, signature, result });
    return result;
}

// ---------------------------------------------------------------- the resolver

/**
 * resolveEffectiveHardwareAvailability({ generation, paths, runningDir, nowMs })
 *   -> { revision, denials, projections, slots, diagnostics, store }
 *
 *   denials      Map<routeKey, compiled denial>      (the consumer-facing form)
 *   projections  Map<routeKey, validated projection> (the administrator view)
 *   slots        Map<routeKey, { runId, evidenceClass }> for every applicable slot
 *   diagnostics  [{ routeKey, evidenceClass, label? }] informational only
 *
 * Throws HARDWARE_AVAILABILITY_POLICY_UNREADABLE when the store is unreadable.
 */
export function resolveEffectiveHardwareAvailability({
    generation,
    paths,
    runningDir = path.join(paths.ploinkyDir, 'running'),
    nowMs = Date.now(),
    fsApi = fs,
    cache = DEFAULT_CACHE,
} = {}) {
    return evaluateHardwareAvailabilityOfStore({
        store: storeSnapshot(paths, fsApi, cache), generation, paths, runningDir, nowMs, fsApi, cache,
    });
}

/**
 * The pure evaluation of one given store snapshot (`{ state, revision, entries, slots }`) against one
 * generation. The resolver is this evaluation of the snapshot it reads; the staging planner evaluates the
 * snapshot it read and the one it plans to commit with the same code, so applicability is never forked.
 */
export function evaluateHardwareAvailabilityOfStore({
    store,
    generation,
    paths,
    runningDir = path.join(paths.ploinkyDir, 'running'),
    nowMs = Date.now(),
    fsApi = fs,
    cache = DEFAULT_CACHE,
} = {}) {
    const denials = new Map();
    const projections = new Map();
    const slots = new Map();
    const diagnostics = [];
    let evidenceCache = cache.evidence.get(runningDir);
    if (!evidenceCache) {
        evidenceCache = new Map();
        cache.evidence.set(runningDir, evidenceCache);
    }
    const named = new Set();

    for (const [routeKey, slot] of Object.entries(store.slots)) {
        if (!identityApplies(slot, routeKey, generation)) continue;
        const file = path.join(runningDir, NO_WAIT_DIR_NAME, slot.statusFile);
        named.add(file);
        let evidence = evidenceFor({ fsApi, file, routeKey, slot, evidenceCache });
        if (evidence.evidenceClass === 'active') {
            try {
                validateNoWaitTerminalTimestamps(evidence.timestamps, { nowMs });
            } catch (_) {
                evidence = { evidenceClass: 'invalid' };
            }
        }
        slots.set(routeKey, Object.freeze({ runId: slot.runId, evidenceClass: evidence.evidenceClass }));
        const label = evidence.evidenceClass === 'missing' && nowMs > slot.runStartedAtMs + slot.startupGraceMs
            ? 'missing-past-grace'
            : undefined;
        diagnostics.push(Object.freeze({ routeKey, evidenceClass: evidence.evidenceClass, ...(label ? { label } : {}) }));
        if (evidence.evidenceClass === 'active') {
            denials.set(routeKey, evidence.compiled);
            projections.set(routeKey, evidence.projection);
        }
    }

    for (const [routeKey, entry] of Object.entries(store.entries)) {
        const { projection } = entry;
        const tuple = { key: projection.key, instanceId: projection.instanceId, enableGeneration: projection.enableGeneration };
        if (!identityApplies(tuple, routeKey, generation)) continue;
        // A newer applicable slot of the same tuple decides; the entry is suppressed.
        const slot = store.slots[routeKey];
        if (slots.has(routeKey) && slot
            && slot.key === tuple.key && slot.instanceId === tuple.instanceId && slot.enableGeneration === tuple.enableGeneration) continue;
        denials.set(routeKey, Object.freeze(compileAvailabilityProjection(projection)));
        projections.set(routeKey, projection);
    }

    for (const file of evidenceCache.keys()) {
        if (!named.has(file)) evidenceCache.delete(file);
    }
    if (evidenceCache.size > MAX_EVIDENCE_CACHE_ENTRIES) {
        for (const file of [...evidenceCache.keys()].slice(0, evidenceCache.size - MAX_EVIDENCE_CACHE_ENTRIES)) evidenceCache.delete(file);
    }

    return Object.freeze({
        revision: computeEffectiveRevision(denials),
        denials,
        projections,
        slots,
        diagnostics: Object.freeze(diagnostics),
        store: Object.freeze({ state: store.state, revision: store.revision }),
    });
}
