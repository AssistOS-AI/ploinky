import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectedCanonicalPathAsync } from '../../utils/runtime/agentDataPathPolicy.js';
const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;
export const UPLOAD_ROUTE_POLICIES = Object.freeze({
    blobs: Object.freeze({
        route: '/blobs',
        maxBytes: 64 * MEBIBYTE,
        maxFiles: 1024,
        maxStorageBytes: 2 * GIBIBYTE,
        timeoutMs: 120_000,
    }),
    workspace: Object.freeze({
        route: '/upload',
        maxBytes: 256 * MEBIBYTE,
        timeoutMs: 300_000,
    }),
    webchat: Object.freeze({
        route: '/webchat/uploads',
        maxBytes: 64 * MEBIBYTE,
        maxFiles: 256,
        maxStorageBytes: GIBIBYTE,
        timeoutMs: 120_000,
    }),
});
const activeByStorageRoot = new Map();
export class UploadAdmissionError extends Error {
    constructor(status, code, message = code) {
        super(message);
        this.name = 'UploadAdmissionError';
        this.status = status;
        this.code = code;
    }
}
function uploadError(status, code, message = code) {
    return new UploadAdmissionError(status, code, message);
}

function validatePolicy(policy) {
    const hasMaxFiles = policy?.maxFiles !== undefined && policy?.maxFiles !== null;
    const hasMaxStorageBytes = policy?.maxStorageBytes !== undefined
        && policy?.maxStorageBytes !== null;
    if (hasMaxFiles !== hasMaxStorageBytes) {
        throw new TypeError(
            'Upload policy maxFiles and maxStorageBytes must be configured together.',
        );
    }
    const normalized = {
        route: String(policy?.route || '').trim(),
        maxBytes: Number(policy?.maxBytes),
        maxFiles: hasMaxFiles ? Number(policy.maxFiles) : null,
        maxStorageBytes: hasMaxStorageBytes ? Number(policy.maxStorageBytes) : null,
        timeoutMs: Number(policy?.timeoutMs),
    };
    const numericKeys = hasMaxFiles
        ? ['maxBytes', 'maxFiles', 'maxStorageBytes', 'timeoutMs']
        : ['maxBytes', 'timeoutMs'];
    for (const key of numericKeys) {
        if (!Number.isSafeInteger(normalized[key]) || normalized[key] <= 0) {
            throw new TypeError(`Upload policy ${key} must be a positive safe integer.`);
        }
    }
    if (!normalized.route) {
        throw new TypeError('Upload policy route is required.');
    }
    return normalized;
}

function hasStorageQuota(policy) {
    return policy.maxFiles !== null && policy.maxStorageBytes !== null;
}
function readContentLength(req) {
    let value = req?.headers?.['content-length'];
    if (value === undefined && req?.headers) {
        for (const [key, candidate] of Object.entries(req.headers)) {
            if (String(key).toLowerCase() === 'content-length') {
                value = candidate;
                break;
            }
        }
    }
    if (value === undefined || value === null || value === '') return null;
    if (Array.isArray(value) && value.length !== 1) {
        throw uploadError(400, 'invalid_content_length');
    }
    const raw = String(Array.isArray(value) ? value[0] : value).trim();
    if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
        throw uploadError(400, 'invalid_content_length');
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
        throw uploadError(400, 'invalid_content_length');
    }
    return parsed;
}
function activeState(storageRoot) {
    let state = activeByStorageRoot.get(storageRoot);
    if (!state) {
        state = new Set();
        activeByStorageRoot.set(storageRoot, state);
    }
    return state;
}
function releaseReservation(reservation) {
    const state = activeByStorageRoot.get(reservation.storageRoot);
    if (!state) return;
    state.delete(reservation);
    if (state.size === 0) activeByStorageRoot.delete(reservation.storageRoot);
}
function activeTotals(storageRoot, excludedReservation = null) {
    let files = 0;
    let bytes = 0;
    const ignoredPaths = new Set();
    for (const reservation of activeByStorageRoot.get(storageRoot) || []) {
        if (reservation.temporaryPath) {
            ignoredPaths.add(path.resolve(reservation.temporaryPath));
        }
        if (reservation === excludedReservation) continue;
        files += reservation.fileDelta;
        bytes += reservation.reservedBytes;
    }
    return { files, bytes, ignoredPaths };
}
function inspectStorage(storageRoot, {
    ignoredPaths,
    includeEntry,
    includeDirectory,
    policy,
} = {}) {
    let rootStat;
    try {
        rootStat = fs.lstatSync(storageRoot);
    } catch (error) {
        if (error?.code === 'ENOENT') return { files: 0, bytes: 0 };
        throw uploadError(507, 'storage_inventory_unavailable');
    }
    if (!rootStat.isDirectory()) {
        throw uploadError(507, 'storage_inventory_unavailable');
    }

    let files = 0;
    let bytes = 0;
    const stack = [storageRoot];
    while (stack.length > 0) {
        const directory = stack.pop();
        let names;
        try {
            names = fs.readdirSync(directory);
        } catch (_) {
            throw uploadError(507, 'storage_inventory_unavailable');
        }
        for (const name of names) {
            const absolutePath = path.join(directory, name);
            if (ignoredPaths?.has(path.resolve(absolutePath))) continue;
            let stat;
            try {
                stat = fs.lstatSync(absolutePath);
            } catch (_) {
                throw uploadError(507, 'storage_inventory_unavailable');
            }
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
                const relativePath = path.relative(storageRoot, absolutePath);
                if (includeDirectory && !includeDirectory({
                    absolutePath,
                    relativePath,
                    stat,
                })) continue;
                stack.push(absolutePath);
                continue;
            }
            const relativePath = path.relative(storageRoot, absolutePath);
            if (includeEntry && !includeEntry({ absolutePath, relativePath, stat })) continue;
            files += 1;
            bytes += stat.size;
            if (!Number.isSafeInteger(bytes)) {
                throw uploadError(507, 'storage_inventory_unavailable');
            }
            if (policy && files > policy.maxFiles) {
                throw uploadError(507, 'upload_count_quota_exceeded');
            }
            if (policy && bytes > policy.maxStorageBytes) {
                throw uploadError(507, 'upload_storage_quota_exceeded');
            }
        }
    }
    return { files, bytes };
}
async function readTargetState(targetPath, replaceExisting) {
    try {
        const stat = await fs.promises.lstat(targetPath);
        if (!replaceExisting || !stat.isFile()) {
            throw uploadError(409, 'upload_target_exists');
        }
        return {
            exists: true,
            bytes: stat.size,
            identity: {
                dev: stat.dev,
                ino: stat.ino,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                mode: stat.mode,
            },
        };
    } catch (error) {
        if (error instanceof UploadAdmissionError) throw error;
        if (error?.code !== 'ENOENT') {
            throw uploadError(507, 'storage_inventory_unavailable');
        }
        return { exists: false, bytes: 0, identity: null };
    }
}
async function targetStillMatches(reservation) {
    try {
        const stat = await fs.promises.lstat(reservation.targetPath);
        if (!reservation.targetState.exists || !stat.isFile()) return false;
        const expected = reservation.targetState.identity;
        return stat.dev === expected.dev
            && stat.ino === expected.ino
            && stat.size === expected.size
            && stat.mtimeMs === expected.mtimeMs;
    } catch (error) {
        return error?.code === 'ENOENT' && !reservation.targetState.exists;
    }
}

function assertQuota(policy, inventory, active, fileDelta, byteDelta) {
    if (inventory.files + active.files + fileDelta > policy.maxFiles) {
        throw uploadError(507, 'upload_count_quota_exceeded');
    }
    if (inventory.bytes + active.bytes + byteDelta > policy.maxStorageBytes) {
        throw uploadError(507, 'upload_storage_quota_exceeded');
    }
}

const tailsByStorageRoot = new Map();

function captureStorageRootIdentity(storageRoot) {
    const requestedRoot = path.resolve(storageRoot);
    let ancestorRequested = requestedRoot;
    try {
        while (true) {
            try {
                fs.lstatSync(ancestorRequested);
                break;
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
                const parent = path.dirname(ancestorRequested);
                if (parent === ancestorRequested) throw error;
                ancestorRequested = parent;
            }
        }
        const ancestorCanonical = fs.realpathSync.native(ancestorRequested);
        const stat = fs.lstatSync(ancestorCanonical);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid storage ancestor');
        const suffix = path.relative(ancestorRequested, requestedRoot);
        return Object.freeze({
            requestedRoot,
            canonicalRoot: suffix ? path.resolve(ancestorCanonical, suffix) : ancestorCanonical,
            ancestorRequested,
            ancestorCanonical,
            ancestorDev: stat.dev,
            ancestorIno: stat.ino,
        });
    } catch (_) {
        throw uploadError(507, 'storage_inventory_unavailable');
    }
}

async function verifyStorageRootIdentity(identity, { requireRoot, check }) {
    try {
        const ancestor = await fs.promises.realpath(identity.ancestorRequested);
        check();
        if (ancestor !== identity.ancestorCanonical) throw new Error('Storage ancestor changed');
        const stat = await fs.promises.lstat(identity.ancestorCanonical);
        check();
        if (!stat.isDirectory() || stat.isSymbolicLink()
            || stat.dev !== identity.ancestorDev || stat.ino !== identity.ancestorIno) {
            throw new Error('Storage ancestor replaced');
        }
        const root = requireRoot
            ? await fs.promises.realpath(identity.requestedRoot)
            : await projectedCanonicalPathAsync(identity.requestedRoot, { check });
        check();
        if (root !== identity.canonicalRoot) throw new Error('Storage root changed');
    } catch (_) {
        check();
        throw uploadError(507, 'storage_inventory_unavailable');
    }
}

// Install the nonrejecting tail synchronously: arrival order survives every await.
function withStorageRootLock(storageRoot, fn) {
    const previous = tailsByStorageRoot.get(storageRoot) || Promise.resolve();
    const result = previous.then(fn);
    const tail = result.catch(() => {}).then(() => {
        if (tailsByStorageRoot.get(storageRoot) === tail) tailsByStorageRoot.delete(storageRoot);
    });
    tailsByStorageRoot.set(storageRoot, tail);
    return result;
}

async function inspectStorageAsync(storageRoot, {
    ignoredPaths, includeEntry, includeDirectory, policy, check = () => {},
} = {}) {
    let rootStat;
    try {
        rootStat = await fs.promises.lstat(storageRoot);
    } catch (error) {
        check();
        if (error?.code === 'ENOENT') return { files: 0, bytes: 0 };
        throw uploadError(507, 'storage_inventory_unavailable');
    }
    check();
    if (!rootStat.isDirectory()) throw uploadError(507, 'storage_inventory_unavailable');
    let files = 0;
    let bytes = 0;
    const stack = [storageRoot];
    while (stack.length) {
        const directory = stack.pop();
        let names;
        try { names = await fs.promises.readdir(directory); } catch (_) {
            check();
            throw uploadError(507, 'storage_inventory_unavailable');
        }
        check();
        for (let offset = 0; offset < names.length; offset += 16) {
            const entries = names.slice(offset, offset + 16)
                .map(name => path.join(directory, name))
                .filter(absolutePath => !ignoredPaths?.has(path.resolve(absolutePath)));
            const results = await Promise.allSettled(entries.map(entry => fs.promises.lstat(entry)));
            check();
            // Fold in the original order, including errors, before visiting LIFO children.
            for (let index = 0; index < entries.length; index += 1) {
                const result = results[index];
                if (result.status === 'rejected') throw uploadError(507, 'storage_inventory_unavailable');
                const absolutePath = entries[index];
                const stat = result.value;
                const relativePath = path.relative(storageRoot, absolutePath);
                if (stat.isDirectory() && !stat.isSymbolicLink()) {
                    if (!includeDirectory || includeDirectory({ absolutePath, relativePath, stat })) {
                        stack.push(absolutePath);
                    }
                    continue;
                }
                if (includeEntry && !includeEntry({ absolutePath, relativePath, stat })) continue;
                files += 1;
                bytes += stat.size;
                if (!Number.isSafeInteger(bytes)) throw uploadError(507, 'storage_inventory_unavailable');
                if (policy && files > policy.maxFiles) throw uploadError(507, 'upload_count_quota_exceeded');
                if (policy && bytes > policy.maxStorageBytes) {
                    throw uploadError(507, 'upload_storage_quota_exceeded');
                }
            }
        }
    }
    return { files, bytes };
}

function makeTemporaryPath(targetPath) {
    return path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.ploinky-upload-${process.pid}-${crypto.randomBytes(8).toString('hex')}.part`,
    );
}

async function reserveUpload({
    req, storageRoot, targetPath, policy, replaceExisting, includeEntry, includeDirectory, check, rootIdentity,
}) {
    let normalizedRoot;
    try { normalizedRoot = await fs.promises.realpath(storageRoot); } catch (_) {
        check();
        throw uploadError(507, 'storage_inventory_unavailable');
    }
    check();
    if (normalizedRoot !== storageRoot) throw uploadError(507, 'storage_inventory_unavailable');
    const resolvedTarget = path.resolve(targetPath);
    let parent;
    try { parent = await fs.promises.realpath(path.dirname(resolvedTarget)); } catch (_) {
        check();
        throw uploadError(507, 'storage_inventory_unavailable');
    }
    check();
    const normalizedTarget = path.join(parent, path.basename(resolvedTarget));
    const relativeTarget = path.relative(normalizedRoot, normalizedTarget);
    if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
        throw uploadError(400, 'upload_target_outside_storage');
    }
    const contentLength = readContentLength(req);
    if (contentLength !== null && contentLength > policy.maxBytes) throw uploadError(413, 'upload_too_large');
    for (const active of activeByStorageRoot.get(normalizedRoot) || []) {
        if (active.targetPath === normalizedTarget) throw uploadError(409, 'upload_target_busy');
    }
    const targetState = await readTargetState(normalizedTarget, replaceExisting);
    check();
    let fileDelta = 0;
    let reservedBytes = 0;
    if (hasStorageQuota(policy)) {
        fileDelta = targetState.exists ? 0 : 1;
        reservedBytes = contentLength === null ? policy.maxBytes : contentLength;
        const active = activeTotals(normalizedRoot);
        const inventory = await inspectStorageAsync(normalizedRoot, {
            ignoredPaths: active.ignoredPaths, includeEntry, includeDirectory, policy, check,
        });
        check();
        assertQuota(policy, inventory, active, fileDelta, reservedBytes);
    }
    await verifyStorageRootIdentity(rootIdentity, { requireRoot: true, check });
    check();
    const reservation = {
        storageRoot: normalizedRoot, targetPath: normalizedTarget, targetState,
        fileDelta, reservedBytes, contentLength, policy, includeEntry, includeDirectory,
        temporaryPath: makeTemporaryPath(normalizedTarget), linkedByThisUpload: false,
    };
    activeState(normalizedRoot).add(reservation);
    return reservation;
}

async function verifyFinalQuota(reservation, size, check) {
    const matches = await targetStillMatches(reservation);
    check();
    if (!matches) throw uploadError(409, 'upload_target_changed');
    if (!hasStorageQuota(reservation.policy)) return;
    const active = activeTotals(reservation.storageRoot, reservation);
    const inventory = await inspectStorageAsync(reservation.storageRoot, {
        ignoredPaths: active.ignoredPaths,
        includeEntry: reservation.includeEntry,
        includeDirectory: reservation.includeDirectory,
        policy: reservation.policy,
        check,
    });
    check();
    assertQuota(reservation.policy, inventory, active, reservation.fileDelta, size);
    // Inventory awaits let non-upload writers run; do not replace a changed target.
    const stillMatches = await targetStillMatches(reservation);
    check();
    if (!stillMatches) throw uploadError(409, 'upload_target_changed');
}

async function commitTemporary(reservation) {
    if (reservation.targetState.exists) {
        await fs.promises.rename(reservation.temporaryPath, reservation.targetPath);
        return;
    }
    try {
        await fs.promises.link(reservation.temporaryPath, reservation.targetPath);
    } catch (error) {
        if (error?.code === 'EEXIST') throw uploadError(409, 'upload_target_changed');
        throw error;
    }
    reservation.linkedByThisUpload = true;
    await fs.promises.unlink(reservation.temporaryPath);
}

function normalizeFailure(error) {
    if (error instanceof UploadAdmissionError) return error;
    if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') {
        return uploadError(507, 'upload_storage_full');
    }
    return uploadError(500, 'upload_write_failed');
}

async function removePartial(filePath) {
    if (!filePath) return true;
    try { await fs.promises.unlink(filePath); } catch (error) {
        return error?.code === 'ENOENT';
    }
    return true;
}

export async function streamAdmittedUpload(req, {
    storageRoot, targetPath, policy, replaceExisting = false, includeEntry, includeDirectory,
    timers = {}, prepare, finalize, onSuccess, onFailure, res,
} = {}) {
    let reservation;
    let handle;
    let output;
    let completed = false;
    let committing = false;
    let terminalError = null;
    let streamFinished = false;
    let bodyAttached = false;
    let bodyEnded = false;
    let size = 0;
    let timeoutHandle = null;
    const clearTimer = timers.clearTimeout || globalThis.clearTimeout;
    const startedAt = (timers.now || Date.now)();
    const clearUploadTimer = () => {
        if (timeoutHandle !== null) clearTimer(timeoutHandle);
        timeoutHandle = null;
    };
    const fail = error => {
        if (completed || committing || terminalError) return;
        terminalError = normalizeFailure(error);
        clearUploadTimer();
        if (output) output.destroy();
    };
    const check = () => {
        if (committing) return;
        // IncomingMessage is destroyed after normal end on current Node versions.
        if ((!bodyEnded && req.destroyed) || req.readableAborted || req.aborted || res?.destroyed) {
            fail(uploadError(400, 'upload_aborted'));
        }
        if ((timers.now || Date.now)() - startedAt >= policy.timeoutMs) {
            fail(uploadError(408, 'upload_timeout'));
        }
        if (terminalError) throw terminalError;
    };
    const onAborted = () => fail(uploadError(400, 'upload_aborted'));
    const onEarlyClose = () => { if (!bodyAttached) onAborted(); };
    const onDrain = () => { if (!terminalError && !completed) req.resume?.(); };
    const detach = () => {
        req.off('aborted', onAborted);
        req.off('error', onAborted);
        req.off('close', onEarlyClose);
        req.off('data', onData);
        req.off('end', onEnd);
        res?.off?.('close', onAborted);
        output?.off('drain', onDrain);
        clearUploadTimer();
    };
    const notify = async (callback, value) => {
        try { await callback?.(value); } catch (_) { /* A response callback cannot change the committed result. */ }
    };
    const cleanupFailure = async error => {
        completed = true;
        detach();
        if (handle && !output) await handle.close().catch(() => {});
        const targetClean = !reservation?.linkedByThisUpload || await removePartial(reservation.targetPath);
        const tempClean = await removePartial(reservation?.temporaryPath);
        if (reservation) releaseReservation(reservation);
        try { req.resume?.(); } catch (_) { /* ignore */ }
        return targetClean && tempClean
            ? normalizeFailure(error) : uploadError(500, 'upload_cleanup_failed');
    };
    const finish = async () => {
        if (completed) return;
        let failure;
        try {
            await withStorageRootLock(storageRoot, async () => {
                try {
                    check();
                    if (!streamFinished) throw uploadError(500, 'upload_write_failed');
                    await verifyFinalQuota(reservation, size, check);
                    check();
                    // From this point, a timeout/reset cannot race the atomic commit.
                    committing = true;
                    clearUploadTimer();
                    await commitTemporary(reservation);
                    await finalize?.({ size, targetPath: reservation.targetPath });
                    releaseReservation(reservation);
                } catch (error) {
                    // Cleanup is also serialized: another inventory must not race unlink.
                    failure = await cleanupFailure(error);
                }
            });
            if (failure) {
                await notify(onFailure, failure);
                return;
            }
            completed = true;
            detach();
            await notify(onSuccess, { size, targetPath: reservation.targetPath });
        } catch (error) {
            failure = await withStorageRootLock(storageRoot, () => cleanupFailure(error));
            await notify(onFailure, failure);
        }
    };
    const onData = chunk => {
        if (completed || terminalError) return;
        try {
            check();
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const nextSize = size + buffer.length;
            if (!Number.isSafeInteger(nextSize) || nextSize > policy.maxBytes) {
                throw uploadError(413, 'upload_too_large');
            }
            if (reservation.contentLength !== null && nextSize > reservation.contentLength) {
                throw uploadError(400, 'content_length_mismatch');
            }
            size = nextSize;
            if (!output.write(buffer)) {
                req.pause?.();
                output.once('drain', onDrain);
            }
        } catch (error) { fail(error); }
    };
    const onEnd = () => {
        if (completed || terminalError) return;
        bodyEnded = true;
        if (reservation.contentLength !== null && size !== reservation.contentLength) {
            fail(uploadError(400, 'content_length_mismatch'));
            return;
        }
        output.end();
    };

    req.once('aborted', onAborted);
    req.once('error', onAborted);
    req.once('close', onEarlyClose);
    res?.once?.('close', onAborted);
    try {
        policy = validatePolicy(policy);
        timeoutHandle = (timers.setTimeout || globalThis.setTimeout)(
            () => fail(uploadError(408, 'upload_timeout')), policy.timeoutMs,
        );
        check();
        const rootIdentity = captureStorageRootIdentity(storageRoot);
        storageRoot = rootIdentity.canonicalRoot;
        // Taking this ticket must precede preparation and every asynchronous operation.
        await withStorageRootLock(storageRoot, async () => {
            check();
            await verifyStorageRootIdentity(rootIdentity, { requireRoot: false, check });
            check();
            if (prepare) {
                const prepared = await prepare(check);
                check();
                if (prepared?.targetPath) targetPath = prepared.targetPath;
            }
            await verifyStorageRootIdentity(rootIdentity, { requireRoot: true, check });
            check();
            reservation = await reserveUpload({
                req, storageRoot, targetPath, policy, replaceExisting, includeEntry, includeDirectory, check, rootIdentity,
            });
            check();
        });
        check();
        handle = await fs.promises.open(reservation.temporaryPath, 'wx');
        check();
        if (reservation.targetState.exists) {
            await handle.chmod(reservation.targetState.identity.mode & 0o777);
            check();
        }
        output = handle.createWriteStream({ autoClose: true });
        output.once('error', fail);
        output.once('finish', () => { streamFinished = true; });
        output.once('close', () => {
            finish().catch(error => { void notify(onFailure, normalizeFailure(error)); });
        });
        check();
        bodyAttached = true;
        req.on('data', onData);
        req.once('end', onEnd);
        return { accepted: true, abort: onAborted };
    } catch (error) {
        const failure = reservation
            ? await withStorageRootLock(storageRoot, () => cleanupFailure(error))
            : await cleanupFailure(error);
        await notify(onFailure, failure);
        return { accepted: false };
    }
}

export const __testables = {
    inspectStorage, inspectStorageAsync, withStorageRootLock, activeByStorageRoot, tailsByStorageRoot,
    captureStorageRootIdentity, verifyStorageRootIdentity,
};
