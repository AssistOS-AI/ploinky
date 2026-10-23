import crypto from 'node:crypto';
import path from 'node:path';

import { LIVENESS } from './lockLiveness.mjs';

// On-disk form of a lock: its owner record and the directory protocol that
// keeps a lock from ever being visible without that record.
//
// A lock is published by renaming a private staging directory that already
// holds the fsynced owner record onto the lock name, and released or
// reclaimed by renaming it to a unique `.released-` name before deleting it.
// So a crash leaves either no lock or a complete one, plus at most a
// `.staging-` or `.released-` sibling, which is never the lock.
//
// No-replace: rename(2) replaces an existing destination directory only when
// it is empty (otherwise EEXIST/ENOTEMPTY). A held lock always contains its
// owner record, so a publish can replace only an empty directory, which
// holds nothing and protects nothing.

export const LOCK_OWNER_SCHEMA = 'ploinky-lock';
export const LOCK_OWNER_VERSION = 2;
export const OWNER_FILE = 'owner.json';
export const OWNER_MAX_BYTES = 8 * 1024;
export const INSTANCE_PATTERN = /^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/;
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const STAGING_MARK = '.staging-';
export const RELEASED_MARK = '.released-';

const OWNER_KEYS = Object.freeze([
    'schema', 'version', 'label', 'instance', 'workspaceRoot', 'hostname', 'machineId',
    'bootId', 'pidNamespace', 'pid', 'processStart', 'startedAt',
]);
const SORTED_OWNER_KEYS = JSON.stringify([...OWNER_KEYS].sort());
const NULLABLE_STRING_KEYS = ['machineId', 'bootId', 'pidNamespace', 'processStart'];
const PUBLISH_BUSY = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR']);

function isNullableString(value) {
    return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256);
}

// Only the v2 record is accepted. No earlier record can appear at this path:
// earlier Ploinky versions kept their locks under the home directory.
export function parseLockOwner(bytes) {
    let owner;
    try {
        owner = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
        return null;
    }
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
        || JSON.stringify(Object.keys(owner).sort()) !== SORTED_OWNER_KEYS
        || owner.schema !== LOCK_OWNER_SCHEMA
        || owner.version !== LOCK_OWNER_VERSION
        || typeof owner.label !== 'string' || !LABEL_PATTERN.test(owner.label)
        || (owner.instance !== null && (typeof owner.instance !== 'string' || !INSTANCE_PATTERN.test(owner.instance)))
        || (owner.workspaceRoot !== null
            && (typeof owner.workspaceRoot !== 'string' || !path.isAbsolute(owner.workspaceRoot)))
        || typeof owner.hostname !== 'string' || owner.hostname.length > 256
        || NULLABLE_STRING_KEYS.some((key) => !isNullableString(owner[key]))
        || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.startedAt !== 'string' || owner.startedAt.length > 64) {
        return null;
    }
    return owner;
}

export function serializeOwner(owner) {
    return Buffer.from(`${JSON.stringify(Object.fromEntries(OWNER_KEYS.map((key) => [key, owner[key]])))}\n`);
}

// The form of a `--force-holder` value: a PID, `@`, and one machine identity
// or hostname. It admits no whitespace or control characters.
export const FORCE_HOLDER_PATTERN = /^[1-9][0-9]{0,9}@[^\s@/\\\p{Cc}]{1,256}$/u;

/**
 * The exact `PID@MACHINE` value that `ploinky unlock --force-holder` must
 * repeat to remove a lock whose holder cannot be classified: the holder's PID
 * and its machine identity (its hostname when no machine identity was read).
 */
export function lockHolderToken(owner) {
    return `${owner.pid}@${owner.machineId ?? owner.hostname}`;
}

export function describeHolder(owner) {
    return `pid ${owner.pid} on ${owner.hostname} (machine ${owner.machineId ?? 'unknown'}, `
        + `boot ${owner.bootId ?? 'unknown'}, process started ${owner.processStart ?? 'unknown'}, `
        + `holding since ${owner.startedAt})`;
}

function uniqueSibling(lockPath, mark) {
    return `${lockPath}${mark}${crypto.randomBytes(8).toString('hex')}`;
}

/** Reads a directory's owner record: `{ bytes, owner }`, `null` when absent, or `{ invalid }`. */
export function readOwnerRecord(fsApi, directory) {
    const ownerPath = path.join(directory, OWNER_FILE);
    let stat;
    try {
        stat = fsApi.lstatSync(ownerPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > OWNER_MAX_BYTES) {
        return { invalid: 'its owner record is not a private regular file' };
    }
    const bytes = fsApi.readFileSync(ownerPath);
    const owner = parseLockOwner(bytes);
    return owner ? { bytes, owner } : { invalid: 'its owner record is incomplete or unreadable' };
}

/**
 * Creates `<lock>.staging-<rand>/owner.json` (exclusive, fsynced). Returns the
 * staging path and its directory identity, which the lock keeps once published.
 */
export function stageLock(fsApi, lockPath, ownerBytes) {
    const staging = uniqueSibling(lockPath, STAGING_MARK);
    fsApi.mkdirSync(staging, { recursive: false, mode: 0o700 });
    try {
        fsApi.chmodSync(staging, 0o700);
        const fd = fsApi.openSync(path.join(staging, OWNER_FILE), 'wx', 0o600);
        try {
            fsApi.writeSync(fd, ownerBytes);
            fsApi.fsyncSync(fd);
        } finally {
            fsApi.closeSync(fd);
        }
        return { staging, dirStat: fsApi.lstatSync(staging, { bigint: true }) };
    } catch (error) {
        discardDirectory(fsApi, staging);
        throw error;
    }
}

/** `'published'`, `'busy'` (a lock exists) or `'vanished'` (the staging or parent is gone). */
export function publishLock(fsApi, staging, lockPath) {
    try {
        fsApi.renameSync(staging, lockPath);
        return 'published';
    } catch (error) {
        if (PUBLISH_BUSY.has(error?.code)) return 'busy';
        if (error?.code === 'ENOENT') return 'vanished';
        throw error;
    }
}

/** Best-effort removal of a directory that holds at most an owner record. */
export function discardDirectory(fsApi, directory) {
    try { fsApi.unlinkSync(path.join(directory, OWNER_FILE)); } catch {}
    try { fsApi.rmdirSync(directory); } catch {}
}

/** Moves a lock off its name in one step, then deletes it. The caller has checked for residue. */
export function retireLock(fsApi, lockPath) {
    const released = uniqueSibling(lockPath, RELEASED_MARK);
    fsApi.renameSync(lockPath, released);
    discardDirectory(fsApi, released);
}

/**
 * Removes crash debris next to a lock. Debris is never the lock and is never
 * waited on. It is removed only when that cannot affect a live command:
 *   - a staging or released directory whose owner record is provably stale;
 *   - an empty released directory (a released name is never published again);
 *   - an empty staging directory older than this process. rmdir removes only
 *     an empty directory, so a creator that already wrote its record is
 *     untouched, and one that had not finds its staging gone and retries.
 * Anything else (live, undetermined or unreadable owners, extra entries,
 * symlinks, foreign owners) stays in place.
 */
export function sweepLockDebris({ fsApi, lockPath, uid, classify, processStartedAtMs }) {
    const parent = path.dirname(lockPath);
    const base = path.basename(lockPath);
    let names;
    try {
        names = fsApi.readdirSync(parent);
    } catch {
        return [];
    }
    const removed = [];
    for (const name of names) {
        const released = name.startsWith(`${base}${RELEASED_MARK}`);
        if (!released && !name.startsWith(`${base}${STAGING_MARK}`)) continue;
        const directory = path.join(parent, name);
        try {
            const stat = fsApi.lstatSync(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && stat.uid !== uid)) continue;
            const entries = fsApi.readdirSync(directory);
            if (entries.length === 0) {
                if (released || stat.mtimeMs < processStartedAtMs) {
                    fsApi.rmdirSync(directory);
                    removed.push(directory);
                }
                continue;
            }
            if (entries.length !== 1 || entries[0] !== OWNER_FILE) continue;
            const record = readOwnerRecord(fsApi, directory);
            if (!record?.owner || classify(record.owner).state !== LIVENESS.stale) continue;
            discardDirectory(fsApi, directory);
            removed.push(directory);
        } catch {
            // Debris that cannot be inspected stays inert.
        }
    }
    return removed;
}
