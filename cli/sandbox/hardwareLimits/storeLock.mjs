// One portable store lock (plan §5.2): an exclusive directory STORE/write.lock
// created with atomic mkdir, owned by a random token. It assumes no native
// flock or shared kernel lock namespace, so the host and the Box core
// coordinate through the same bind-mounted directory. A lock is never stolen
// because it is old; only verified quiescence permits stale recovery.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STORE_LOCK_DIRECTORY = 'write.lock';
export const STORE_LOCK_OWNER = 'owner.json';
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

function lockPaths(storeRoot) {
    const directory = path.join(storeRoot, STORE_LOCK_DIRECTORY);
    return { directory, owner: path.join(directory, STORE_LOCK_OWNER) };
}

function writeOwner(fsApi, ownerPath, owner) {
    const descriptor = fsApi.openSync(
        ownerPath,
        fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_EXCL | fsApi.constants.O_NOFOLLOW,
        0o600,
    );
    try {
        fsApi.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
        fsApi.fsyncSync(descriptor);
    } finally {
        fsApi.closeSync(descriptor);
    }
}

export function readStoreLockOwner(storeRoot, { fsApi = fs } = {}) {
    const { directory, owner } = lockPaths(storeRoot);
    let stat;
    try {
        stat = fsApi.lstatSync(directory);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { malformed: true, reason: 'lock path is not a real directory' };
    try {
        const bytes = fsApi.readFileSync(owner);
        if (bytes.length > MAX_OWNER_BYTES) return { malformed: true, reason: 'lock owner record is oversized' };
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!/^[0-9a-f]{32}$/.test(String(parsed?.token || ''))) return { malformed: true, reason: 'lock owner token is invalid' };
        return { malformed: false, owner: parsed, dev: stat.dev, ino: stat.ino };
    } catch (error) {
        return { malformed: true, reason: error?.code === 'ENOENT' ? 'lock has no owner record' : 'lock owner record is unreadable' };
    }
}

/**
 * Acquire the store lock with bounded retries. Returns a releaser bound to the
 * exact directory identity and owner token.
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
    const { directory, owner } = lockPaths(storeRoot);
    const started = now();
    for (;;) {
        try {
            fsApi.mkdirSync(directory, { mode: 0o700 });
            break;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            if (now() - started >= deadlineMs) {
                throw new StoreLockError(STORE_BUSY_MESSAGE, 'store_busy', 409);
            }
            sleep(RETRY_INTERVAL_MS);
        }
    }
    const stat = fsApi.lstatSync(directory);
    const token = randomToken();
    try {
        writeOwner(fsApi, owner, {
            token,
            pid: process.pid,
            hostname: os.hostname().slice(0, 255),
            domain: String(domain).slice(0, 64),
            operation: String(operation).slice(0, 128),
            acquiredAt: new Date(now()).toISOString(),
        });
    } catch (error) {
        try { fsApi.rmdirSync(directory); } catch (_) {}
        throw error;
    }
    let released = false;
    return Object.freeze({
        token,
        release() {
            if (released) return;
            released = true;
            const current = readStoreLockOwner(storeRoot, { fsApi });
            // Never unlink an unrecognized replacement lock.
            if (!current || current.malformed || current.owner.token !== token
                || current.dev !== stat.dev || current.ino !== stat.ino) {
                throw new StoreLockError('hardware policy store lock was replaced while held; it was left in place', 'store_busy', 409);
            }
            fsApi.unlinkSync(owner);
            fsApi.rmdirSync(directory);
        },
    });
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

/**
 * Recover a stale lock only with explicit proof that every writer is
 * quiescent: the host workspace lock is held and the exact Box is stopped or
 * absent. The stale lock is quarantined, never deleted blindly.
 */
export function recoverStaleStoreLock({
    storeRoot,
    quiescence,
    fsApi = fs,
    now = () => Date.now(),
} = {}) {
    const current = readStoreLockOwner(storeRoot, { fsApi });
    if (!current) return { recovered: false, reason: 'no lock' };
    if (quiescence?.hostWorkspaceLockHeld !== true || quiescence?.boxQuiescent !== true) {
        throw new StoreLockError(STORE_BUSY_MESSAGE, 'store_busy', 409);
    }
    const { directory } = lockPaths(storeRoot);
    const quarantine = path.join(storeRoot, `${STORE_LOCK_DIRECTORY}.stale-${now()}-${crypto.randomBytes(4).toString('hex')}`);
    fsApi.renameSync(directory, quarantine);
    return { recovered: true, quarantine, owner: current.malformed ? null : current.owner };
}
