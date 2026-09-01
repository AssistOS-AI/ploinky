import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { PLOINKY_WORKSPACE_ROOT, RUNNING_DIR } from '../config.js';
import {
    ensureVerifiedProducerDirectory,
    verifiedFileError,
} from '../verifiedReadOnlyFile.js';

const LOCK_VERSION = 1;
const LOCK_FILENAME = 'exclusive.lock';
const LOCK_RELATIVE_SEGMENTS = Object.freeze(['.ploinky', 'running', 'image-operations']);

export const IMAGE_OPERATION_LOCK_PATH = path.join(RUNNING_DIR, 'image-operations', LOCK_FILENAME);
export const IMAGE_OPERATION_LOCK_WAIT_MS = 30 * 60 * 1000;
export const IMAGE_OPERATION_LOCK_POLL_MS = 100;
export const IMAGE_OPERATION_LOCK_MALFORMED_GRACE_MS = 30 * 1000;

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function blockingSleep(delayMs) {
    const bounded = Math.max(0, Number(delayMs) || 0);
    if (bounded > 0) Atomics.wait(SLEEP_ARRAY, 0, 0, bounded);
}

function processAlive(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid < 1) return false;
    try {
        process.kill(numericPid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function readLinuxProcessStartTime(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const commandEnd = stat.lastIndexOf(') ');
        if (commandEnd < 0) return null;
        return stat.slice(commandEnd + 2).trim().split(/\s+/)[19] || null;
    } catch (_) {
        return null;
    }
}

function readLinuxBootId() {
    try {
        return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } catch (_) {
        return null;
    }
}

export function imageOperationLockOwnerIsAlive(record, {
    processAliveImpl = processAlive,
    readProcessStartTime = readLinuxProcessStartTime,
    readBootId = readLinuxBootId,
} = {}) {
    const pid = Number(record?.pid);
    if (!Number.isInteger(pid) || pid < 1 || !processAliveImpl(pid)) return false;

    // Older/incomplete owner records can only be checked by PID. New records
    // also pin Linux boot and process-start identity so PID reuse cannot keep a
    // dead worker's lock alive after a Box restart.
    if (!record?.processStartTime) return true;
    const currentBootId = readBootId();
    if (record.bootId && currentBootId && record.bootId !== currentBootId) return false;
    const currentStartTime = readProcessStartTime(pid);
    return currentStartTime == null || currentStartTime === String(record.processStartTime);
}

function verifiedLockPath({ trustedRoot, lockPath }) {
    const directoryOptions = {
        trustedRoot,
        relativeSegments: LOCK_RELATIVE_SEGMENTS,
        mode: 0o700,
    };
    let directory;
    try {
        directory = ensureVerifiedProducerDirectory(directoryOptions);
    } catch (_) {
        // Two cold workers may race to create the final image-operations
        // directory. A second full validation adopts only the exact secure
        // directory; every unsafe state still fails closed.
        directory = ensureVerifiedProducerDirectory(directoryOptions);
    }
    const expected = path.join(directory, LOCK_FILENAME);
    if (lockPath != null && path.resolve(String(lockPath)) !== path.resolve(expected)) {
        throw verifiedFileError(`image operation lock must use the workspace-owned path '${expected}'`);
    }
    return expected;
}

function lockSnapshot(lockPath, nowMs) {
    try {
        const stat = fs.lstatSync(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            const error = new Error(`image operation lock path is not a regular file: ${lockPath}`);
            error.code = 'PLOINKY_IMAGE_OPERATION_LOCK_INVALID';
            throw error;
        }
        const raw = fs.readFileSync(lockPath, 'utf8');
        let owner = null;
        try {
            const parsed = JSON.parse(raw);
            const parsedOwnerId = typeof parsed?.ownerId === 'string'
                ? parsed.ownerId
                : parsed?.token;
            const parsedPid = Number(parsed?.pid);
            if (parsed && typeof parsed === 'object'
                && typeof parsedOwnerId === 'string'
                && parsedOwnerId.length > 0
                && Number.isInteger(parsedPid)
                && parsedPid > 0) {
                owner = { ...parsed, ownerId: parsedOwnerId, pid: parsedPid };
            }
        } catch (_) {}
        const createdAtMs = Date.parse(String(owner?.createdAt || ''));
        return {
            owner,
            malformed: !owner,
            ageMs: Math.max(0, nowMs - (Number.isFinite(createdAtMs) ? createdAtMs : stat.mtimeMs)),
            fingerprint: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${raw}`,
        };
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function sameSnapshot(lockPath, snapshot, nowMs) {
    const current = lockSnapshot(lockPath, nowMs);
    return Boolean(current && current.fingerprint === snapshot.fingerprint);
}

function releaseOwnedLock(lockPath, ownerId, nowMs) {
    try {
        const snapshot = lockSnapshot(lockPath, nowMs);
        if (snapshot?.owner?.ownerId === ownerId && sameSnapshot(lockPath, snapshot, nowMs)) {
            fs.unlinkSync(lockPath);
        }
    } catch (_) {}
}

function busyError(waitMs, snapshot) {
    const ownerDescription = snapshot?.owner?.pid
        ? `pid ${snapshot.owner.pid}`
        : 'an incomplete owner record';
    const error = new Error(
        `timed out waiting ${waitMs}ms for image operation serialization; lock is owned by ${ownerDescription}`,
    );
    error.code = 'PLOINKY_IMAGE_OPERATION_BUSY';
    return error;
}

export function acquireImageOperationLock({
    trustedRoot = PLOINKY_WORKSPACE_ROOT,
    lockPath = null,
    waitMs = IMAGE_OPERATION_LOCK_WAIT_MS,
    pollMs = IMAGE_OPERATION_LOCK_POLL_MS,
    malformedGraceMs = IMAGE_OPERATION_LOCK_MALFORMED_GRACE_MS,
    now = () => Date.now(),
    sleep = blockingSleep,
    isOwnerAlive = imageOperationLockOwnerIsAlive,
    ownerPid = process.pid,
    ownerId = randomUUID(),
    processStartTime = readLinuxProcessStartTime(ownerPid),
    bootId = readLinuxBootId(),
    onWait = null,
} = {}) {
    const boundedWaitMs = Math.max(0, Number(waitMs) || 0);
    const boundedPollMs = Math.max(10, Number(pollMs) || IMAGE_OPERATION_LOCK_POLL_MS);
    const boundedMalformedGraceMs = Math.max(0, Number(malformedGraceMs) || 0);
    const resolvedLockPath = verifiedLockPath({ trustedRoot, lockPath });
    const startedAtMs = now();
    const owner = {
        version: LOCK_VERSION,
        ownerId,
        pid: ownerPid,
        processStartTime,
        bootId,
        createdAt: new Date(startedAtMs).toISOString(),
    };
    const serializedOwner = JSON.stringify(owner);
    let waitReported = false;

    while (true) {
        let descriptor = null;
        let created = false;
        try {
            const flags = fs.constants.O_WRONLY
                | fs.constants.O_CREAT
                | fs.constants.O_EXCL
                | (fs.constants.O_NOFOLLOW || 0);
            descriptor = fs.openSync(resolvedLockPath, flags, 0o600);
            created = true;
            fs.writeSync(descriptor, serializedOwner);
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = null;
            let released = false;
            return Object.freeze({
                lockPath: resolvedLockPath,
                owner: Object.freeze({ ...owner }),
                release() {
                    if (released) return;
                    released = true;
                    releaseOwnedLock(resolvedLockPath, ownerId, now());
                },
            });
        } catch (error) {
            if (descriptor != null) {
                try { fs.closeSync(descriptor); } catch (_) {}
            }
            if (created) {
                try { fs.unlinkSync(resolvedLockPath); } catch (_) {}
            }
            if (error?.code !== 'EEXIST') throw error;
        }

        const currentTime = now();
        const snapshot = lockSnapshot(resolvedLockPath, currentTime);
        if (!snapshot) continue;
        const reclaimable = snapshot.malformed
            ? snapshot.ageMs >= boundedMalformedGraceMs
            : !isOwnerAlive(snapshot.owner);
        if (reclaimable && sameSnapshot(resolvedLockPath, snapshot, currentTime)) {
            try {
                fs.unlinkSync(resolvedLockPath);
                continue;
            } catch (error) {
                if (error?.code === 'ENOENT') continue;
                throw error;
            }
        }
        if (!waitReported && typeof onWait === 'function') {
            waitReported = true;
            onWait(snapshot.owner || null);
        }
        const elapsedMs = currentTime - startedAtMs;
        if (elapsedMs >= boundedWaitMs) throw busyError(boundedWaitMs, snapshot);
        sleep(Math.min(boundedPollMs, Math.max(1, boundedWaitMs - elapsedMs)));
    }
}

export function withImageOperationLock(callback, options = {}) {
    if (typeof callback !== 'function') {
        throw new Error('image operation serialization requires a callback');
    }
    const lock = acquireImageOperationLock(options);
    let result;
    try {
        result = callback();
    } catch (error) {
        lock.release();
        throw error;
    }
    if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => lock.release());
    }
    lock.release();
    return result;
}
