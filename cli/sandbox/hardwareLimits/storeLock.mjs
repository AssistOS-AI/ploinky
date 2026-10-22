// One portable store lock (plan §5.2): an exclusive regular file STORE/write.lock
// holding the owner record, created with O_CREAT|O_EXCL|O_NOFOLLOW and owned by
// a random token. It assumes no native flock or shared kernel lock namespace, so
// the host and the Box core coordinate through the same bind-mounted directory.
// A lock is never stolen because it is old; only verified quiescence permits
// stale recovery.
//
// The Box can write STORE, so anything the host does there must not be steerable
// out of it. The guarantee is structural: every host path below STORE has exactly
// one component, and every operation on it acts on that final component without
// following a link (O_NOFOLLOW opens, O_EXCL creates, unlink and rename of the
// entry itself). A swap of write.lock between a check and the next call can only
// remove or move an entry inside STORE, which the Box could do anyway; it can
// never reach a file outside STORE. There is deliberately no lock directory and
// no `write.lock/owner.json`: an intermediate component is what a swap would
// redirect.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STORE_LOCK_NAME = 'write.lock';
export const STORE_LOCK_DEADLINE_MS = 10_000;
export const STORE_BUSY_MESSAGE = 'Hardware policy store is locked. Stop this workspace on the host, then run '
    + 'ploinky limits clear --all or retry the lifecycle command. No policy was changed.';
const RETRY_INTERVAL_MS = 25;
const MAX_OWNER_BYTES = 4096;

export class StoreLockError extends Error {
    constructor(message, code, status = 409) {
        super(message);
        this.name = 'StoreLockError';
        this.code = code;
        this.status = status;
    }
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(milliseconds) {
    Atomics.wait(SLEEP_CELL, 0, 0, milliseconds);
}

function lockPathOf(storeRoot) {
    return path.join(storeRoot, STORE_LOCK_NAME);
}

// Opens the lock entry itself: O_NOFOLLOW makes a link at the final component
// fail (ELOOP) and O_NONBLOCK keeps a planted FIFO from blocking the host.
// Returns the descriptor with its fstat; the caller owns the descriptor.
function openLockEntry(fsApi, lockPath) {
    const descriptor = fsApi.openSync(lockPath, fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK);
    try {
        return { descriptor, stat: fsApi.fstatSync(descriptor) };
    } catch (error) {
        fsApi.closeSync(descriptor);
        throw error;
    }
}

// The Box writes this store, so the owner record is read like the other store
// files: without following a link, as a single-link regular file, and bounded.
// Null means the record is larger than the bound; a lock entry that is not a
// single regular file throws NOT_A_RECORD.
function readOwnerRecord(fsApi, lockPath) {
    const { descriptor, stat } = openLockEntry(fsApi, lockPath);
    try {
        if (!stat.isFile() || stat.nlink !== 1) throw Object.assign(new Error('lock entry is not a single regular file'), { code: 'NOT_A_RECORD' });
        if (stat.size > MAX_OWNER_BYTES) return { bytes: null, stat };
        const buffer = Buffer.alloc(MAX_OWNER_BYTES + 1);
        let offset = 0;
        for (;;) {
            const read = fsApi.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
            if (read === 0) break;
            offset += read;
            if (offset > MAX_OWNER_BYTES) return { bytes: null, stat };
        }
        return { bytes: buffer.subarray(0, offset), stat };
    } finally {
        fsApi.closeSync(descriptor);
    }
}

export function readStoreLockOwner(storeRoot, { fsApi = fs } = {}) {
    const lockPath = lockPathOf(storeRoot);
    try {
        const { bytes, stat } = readOwnerRecord(fsApi, lockPath);
        if (bytes === null) return { malformed: true, reason: 'lock owner record is oversized' };
        // A writer that created the lock and has not (or never) written its record.
        if (bytes.length === 0) return { malformed: true, reason: 'lock has no owner record' };
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!/^[0-9a-f]{32}$/.test(String(parsed?.token || ''))) return { malformed: true, reason: 'lock owner stamp is invalid' };
        return { malformed: false, owner: parsed, dev: stat.dev, ino: stat.ino };
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error?.code === 'ELOOP' || error?.code === 'NOT_A_RECORD') return { malformed: true, reason: 'lock path is not a single regular file' };
        return { malformed: true, reason: 'lock owner record is unreadable' };
    }
}

/**
 * Acquire the store lock with bounded retries. Returns a releaser bound to the
 * exact file identity (device and inode) and owner token.
 */
export function acquireStoreLock({
    storeRoot,
    operation = 'store',
    deadlineMs = STORE_LOCK_DEADLINE_MS,
    fsApi = fs,
    now = () => Date.now(),
    sleep = sleepSync,
    randomToken = () => crypto.randomBytes(16).toString('hex'),
    domain = 'host',
} = {}) {
    if (!storeRoot || !path.isAbsolute(storeRoot)) throw new StoreLockError('store lock requires an absolute store root', 'store_unreadable', 503);
    const lockPath = lockPathOf(storeRoot);
    const started = now();
    const token = randomToken();
    let descriptor;
    for (;;) {
        try {
            // Exclusive creation of the entry itself: any existing entry, a link included, is EEXIST (busy).
            descriptor = fsApi.openSync(
                lockPath,
                fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_EXCL | fsApi.constants.O_NOFOLLOW,
                0o600,
            );
            break;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            if (now() - started >= deadlineMs) {
                throw new StoreLockError(STORE_BUSY_MESSAGE, 'store_busy', 409);
            }
            sleep(RETRY_INTERVAL_MS);
        }
    }
    let created = null;
    try {
        created = fsApi.fstatSync(descriptor);
        fsApi.writeFileSync(descriptor, `${JSON.stringify({
            token,
            pid: process.pid,
            hostname: os.hostname().slice(0, 255),
            domain: String(domain).slice(0, 64),
            operation: String(operation).slice(0, 128),
            acquiredAt: new Date(now()).toISOString(),
        })}\n`);
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        try { fsApi.closeSync(descriptor); } catch (_) {}
        // Remove only the entry this call created; the original failure is the one reported.
        try { removeIfSame(fsApi, lockPath, created); } catch (_) {}
        throw error;
    }
    fsApi.closeSync(descriptor);
    let released = false;
    return Object.freeze({
        token,
        release() {
            if (released) return;
            released = true;
            const current = readStoreLockOwner(storeRoot, { fsApi });
            // Never unlink an unrecognized replacement lock.
            if (!current || current.malformed || current.owner.token !== token
                || current.dev !== created.dev || current.ino !== created.ino) {
                throw new StoreLockError('hardware policy store lock was replaced while held; it was left in place', 'store_busy', 409);
            }
            // unlink acts on the final component and never follows a link.
            removeIfSame(fsApi, lockPath, created);
        },
    });
}

// Unlinks `lockPath` only while lstat still shows the identity we created. A
// swap after this check makes the host unlink an entry the Box created inside
// the store (which the Box could delete itself), never anything outside it,
// because unlink does not follow the final component.
function removeIfSame(fsApi, lockPath, created) {
    if (!created) return;
    let current;
    try { current = fsApi.lstatSync(lockPath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== created.dev || current.ino !== created.ino) {
        throw new StoreLockError('hardware policy store lock was replaced while held; it was left in place', 'store_busy', 409);
    }
    fsApi.unlinkSync(lockPath);
}

export function withStoreLock(options, callback) {
    const lock = acquireStoreLock(options);
    let result;
    try {
        result = callback(lock);
    } finally {
        lock.release();
    }
    return result;
}

function processIsProvenDead(pid, kill) {
    try {
        kill(pid, 0);
        return false;
    } catch (error) {
        return error?.code === 'ESRCH';
    }
}

/**
 * Recover a stale store lock (plan §5.2, §6.3 line 441) only under the host
 * workspace lock and only with proof that its holder is dead:
 *   - the exact Box is observed stopped or absent (never a caller boolean),
 *     so no Box writer can be running; and
 *   - a host-domain holder is a complete owner record from this host whose
 *     PID is proven dead (the baseline same-host rule). A Box-domain holder
 *     died with the stopped Box.
 * An ownerless or malformed lock is never proof of death: it is preserved
 * and reported. The stale lock is quarantined (renamed), never deleted.
 */
export function recoverStaleStoreLock({
    storeRoot,
    hostLock,
    instance,
    inspectBox,
    hostname = os.hostname(),
    kill = (pid, signal) => process.kill(pid, signal),
    fsApi = fs,
    now = () => Date.now(),
} = {}) {
    const current = readStoreLockOwner(storeRoot, { fsApi });
    if (!current) return { recovered: false, reason: 'no lock' };
    if (typeof hostLock?.assertHeld !== 'function') {
        throw new StoreLockError(STORE_BUSY_MESSAGE, 'store_busy', 409);
    }
    hostLock.assertHeld(instance);
    const lockPath = lockPathOf(storeRoot);
    if (current.malformed) {
        throw new StoreLockError(
            `Hardware policy store lock ${lockPath} has no valid owner (${current.reason}); an ownerless lock is never `
            + 'removed automatically. Stop this workspace on the host, make sure no Ploinky process uses this store, '
            + 'then remove that file and retry. No policy was changed.',
            'store_busy',
            409,
        );
    }
    const owner = current.owner;
    const holder = `${String(owner.operation || 'an unnamed operation').slice(0, 128)} (pid ${String(owner.pid).slice(0, 32)} `
        + `on host ${String(owner.hostname || 'unknown').slice(0, 255)})`;
    // An explicit repair needs operator-established quiescence of every
    // writer of this store (§6.3 line 441); it is never automatic.
    const repair = `make sure no Ploinky process on that host uses this store, then remove ${lockPath} and retry. `
        + 'No policy was changed.';
    if (owner.domain !== 'box') {
        const pid = Number(owner.pid);
        if (owner.hostname !== hostname) {
            // Another host's PID cannot be checked from here.
            throw new StoreLockError(
                `Hardware policy store lock ${lockPath} is held by ${holder}, which is not this host (${hostname}), so `
                + 'its holder cannot be proven dead and the lock is never taken over. Stop this workspace on every host '
                + `that uses this store, ${repair}`,
                'store_busy',
                409,
            );
        }
        if (!Number.isSafeInteger(pid) || pid <= 0) {
            throw new StoreLockError(
                `Hardware policy store lock ${lockPath} is held by ${holder}, whose owner record names no valid process, `
                + `so it is never taken over. Stop this workspace on the host, ${repair}`,
                'store_busy',
                409,
            );
        }
        if (!processIsProvenDead(pid, kill)) {
            throw new StoreLockError(
                `Hardware policy store lock ${lockPath} is held by ${holder}, and that process is still running on this `
                + 'host, so the lock is never taken over. Wait for that operation to finish and retry. If that PID is not a '
                + `Ploinky process (it was reused), stop this workspace on the host, ${repair}`,
                'store_busy',
                409,
            );
        }
    }
    const box = typeof inspectBox === 'function' ? inspectBox() : null;
    if (box?.state === 'paused') {
        // A paused Box is not stopped: a writer inside it may still hold the
        // lock, and a paused writer never permits a takeover (§5.2).
        throw new StoreLockError(
            `Hardware policy store lock ${lockPath} is held by ${holder}, and this workspace's Box is paused, so a writer `
            + 'inside it may still hold the lock. Resume the Box, or stop this workspace on the host, then retry. '
            + 'No policy was changed.',
            'store_busy',
            409,
        );
    }
    if (box?.state !== 'absent' && box?.state !== 'stopped') {
        throw new StoreLockError(`Hardware policy store lock ${lockPath} is held by ${holder}; this workspace's Box is not proven stopped or absent. ${STORE_BUSY_MESSAGE}`, 'store_busy', 409);
    }
    // The owner must still be the one that was judged dead.
    const again = readStoreLockOwner(storeRoot, { fsApi });
    if (!again || again.malformed || again.owner.token !== owner.token || again.dev !== current.dev || again.ino !== current.ino) {
        throw new StoreLockError(STORE_BUSY_MESSAGE, 'store_busy', 409);
    }
    const quarantine = path.join(storeRoot, `${STORE_LOCK_NAME}.stale-${now()}-${crypto.randomBytes(4).toString('hex')}`);
    // Both names are direct children of the store and rename moves the entry itself, never what a link points to.
    fsApi.renameSync(lockPath, quarantine);
    return { recovered: true, quarantine, owner };
}

/**
 * Run a host store operation; when it is refused only because the store lock
 * is held, try the stale-lock recovery above once and retry. Every other
 * outcome (live holder, ownerless lock, running Box) stays store_busy.
 */
export function withStaleStoreLockRecovery(operation, { storeRoot, hostLock, instance, inspectBox, fsApi = fs, ...rest } = {}) {
    try {
        return operation();
    } catch (error) {
        if (error?.code !== 'store_busy' || !readStoreLockOwner(storeRoot, { fsApi })) throw error;
        const recovered = recoverStaleStoreLock({ storeRoot, hostLock, instance, inspectBox, fsApi, ...rest });
        if (!recovered.recovered) throw error;
        return operation();
    }
}
