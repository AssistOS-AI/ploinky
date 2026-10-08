// How long the Router has seen the current edge activation, and whether a
// routing mutation may be in progress. Startup probes report both so a client
// can skip its forward settle check only when the activation is old enough AND
// nothing is about to replace it.
//
// The generation id is a content digest that an identical re-apply reproduces,
// so the observer keys on the activation as well: the activation id, which is
// never disclosed, and the hardware-availability revision. One slot remembers
// the last activation and the Router-monotonic time it was first seen; a
// different key, including an older one, or a clock rewind starts a new token.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { resolveEdgeGenerationPaths } from '../sandbox/edgeGeneration.js';
import { RUNNING_DIR } from '../utils/config.js';
import { WORKSPACE_MUTATION_LEASE_PATH } from '../utils/runtime/maintenanceLocks.js';
import { inspectNoWaitRoutingActivity } from '../commands/noWaitWorkerLiveness.js';

const EDGE_GENERATION_PATTERN = /^sha256:[a-f0-9]{64}$/;
// Nine random bytes: a 12-character base64url prefix, new per Router process.
const NONCE = crypto.randomBytes(9).toString('base64url');

let seq = 0;
let slot = null;

const defaultNow = () => performance.now();

/**
 * Observe the activation a lease captured. Returns
 * `{ activation, activeForMs }`, or `null` (with no state change) for a lease
 * that does not carry one exact generation id and activation id. Never throws.
 */
export function observeEdgeActivation(lease, { now = defaultNow } = {}) {
    try {
        const id = lease?.id;
        const activationId = lease?.activationId;
        if (typeof id !== 'string' || !EDGE_GENERATION_PATTERN.test(id)) return null;
        if (typeof activationId !== 'string' || activationId.length === 0) return null;
        const nowMs = now();
        if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
        const key = `${id}\0${activationId}\0${lease.effective?.revision ?? ''}`;
        if (!slot || slot.key !== key || nowMs < slot.sinceMs) {
            seq += 1;
            slot = { key, token: `${NONCE}.${seq}`, sinceMs: nowMs };
        }
        return { activation: slot.token, activeForMs: Math.floor(nowMs - slot.sinceMs) };
    } catch (_) {
        return null;
    }
}

function requiredPath(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
        throw new Error('routing mutation state requires absolute paths');
    }
    return value;
}

// Absent only on ENOENT. Any entry (file, directory, symlink) or any other
// error means present.
function entryAbsent(file, lstat) {
    try {
        lstat(file);
        return false;
    } catch (error) {
        return error?.code === 'ENOENT';
    }
}

/**
 * `'idle'` only when the running directory is a directory, neither the
 * workspace mutation lease nor the edge preparation lease exists, and no
 * latest no-wait run may still change routing; otherwise `'busy'`. Reads
 * only: it never inspects lease owners, removes a stale lease or cleans up.
 */
export function readRoutingMutationState({
    runningDir,
    leaseFile,
    preparationLeaseFile,
    inspectNoWait = inspectNoWaitRoutingActivity,
    lstat = fs.lstatSync,
} = {}) {
    try {
        const running = requiredPath(runningDir ?? RUNNING_DIR);
        const lease = requiredPath(leaseFile ?? WORKSPACE_MUTATION_LEASE_PATH);
        const preparation = requiredPath(preparationLeaseFile ?? resolveEdgeGenerationPaths().preparationLeaseFile);
        if (!lstat(running).isDirectory()) return 'busy';
        if (!entryAbsent(lease, lstat)) return 'busy';
        if (!entryAbsent(preparation, lstat)) return 'busy';
        return inspectNoWait({ runningDir: running })?.busy === false ? 'idle' : 'busy';
    } catch (_) {
        return 'busy';
    }
}

export const __testables = Object.freeze({
    reset() {
        seq = 0;
        slot = null;
    },
    nonce: () => NONCE,
});
