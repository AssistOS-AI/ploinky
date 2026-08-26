import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
function readTargetState(targetPath, replaceExisting) {
    try {
        const stat = fs.lstatSync(targetPath);
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
function targetStillMatches(reservation) {
    try {
        const stat = fs.lstatSync(reservation.targetPath);
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

function reserveUpload({
    req,
    storageRoot,
    targetPath,
    policy,
    replaceExisting,
    includeEntry,
    includeDirectory,
}) {
    const normalizedPolicy = validatePolicy(policy);
    let normalizedRoot;
    try {
        normalizedRoot = fs.realpathSync(path.resolve(storageRoot));
    } catch (_) {
        throw uploadError(507, 'storage_inventory_unavailable');
    }
    let normalizedTarget;
    try {
        const resolvedTarget = path.resolve(targetPath);
        normalizedTarget = path.join(
            fs.realpathSync(path.dirname(resolvedTarget)),
            path.basename(resolvedTarget),
        );
    } catch (_) {
        throw uploadError(507, 'storage_inventory_unavailable');
    }
    const relativeTarget = path.relative(normalizedRoot, normalizedTarget);
    if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
        throw uploadError(400, 'upload_target_outside_storage');
    }

    const contentLength = readContentLength(req);
    if (contentLength !== null && contentLength > normalizedPolicy.maxBytes) {
        throw uploadError(413, 'upload_too_large');
    }

    for (const active of activeByStorageRoot.get(normalizedRoot) || []) {
        if (active.targetPath === normalizedTarget) {
            throw uploadError(409, 'upload_target_busy');
        }
    }

    const targetState = readTargetState(normalizedTarget, replaceExisting);
    let fileDelta = 0;
    let reservedBytes = 0;
    if (hasStorageQuota(normalizedPolicy)) {
        fileDelta = targetState.exists ? 0 : 1;
        reservedBytes = contentLength === null ? normalizedPolicy.maxBytes : contentLength;
        const active = activeTotals(normalizedRoot);
        const inventory = inspectStorage(normalizedRoot, {
            ignoredPaths: active.ignoredPaths,
            includeEntry,
            includeDirectory,
            policy: normalizedPolicy,
        });
        assertQuota(normalizedPolicy, inventory, active, fileDelta, reservedBytes);
    }

    const reservation = {
        storageRoot: normalizedRoot,
        targetPath: normalizedTarget,
        targetState,
        fileDelta,
        reservedBytes,
        contentLength,
        policy: normalizedPolicy,
        includeEntry,
        includeDirectory,
        temporaryPath: null,
    };
    activeState(normalizedRoot).add(reservation);
    return reservation;
}

function makeTemporaryPath(targetPath) {
    return path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.ploinky-upload-${process.pid}-${crypto.randomBytes(8).toString('hex')}.part`,
    );
}

function verifyFinalQuota(reservation, size) {
    if (!targetStillMatches(reservation)) {
        throw uploadError(409, 'upload_target_changed');
    }
    if (!hasStorageQuota(reservation.policy)) return;
    const active = activeTotals(reservation.storageRoot, reservation);
    const inventory = inspectStorage(reservation.storageRoot, {
        ignoredPaths: active.ignoredPaths,
        includeEntry: reservation.includeEntry,
        includeDirectory: reservation.includeDirectory,
        policy: reservation.policy,
    });
    assertQuota(reservation.policy, inventory, active, reservation.fileDelta, size);
}

function commitTemporary(reservation) {
    if (reservation.targetState.exists) {
        fs.renameSync(reservation.temporaryPath, reservation.targetPath);
        return;
    }
    fs.linkSync(reservation.temporaryPath, reservation.targetPath);
    try {
        fs.unlinkSync(reservation.temporaryPath);
    } catch (error) {
        if (!removePartial(reservation.targetPath)) {
            throw uploadError(500, 'upload_cleanup_failed');
        }
        throw error;
    }
}

function normalizeFailure(error) {
    if (error instanceof UploadAdmissionError) return error;
    if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') {
        return uploadError(507, 'upload_storage_full');
    }
    return uploadError(500, 'upload_write_failed');
}

function removePartial(filePath) {
    if (!filePath) return true;
    try { fs.unlinkSync(filePath); } catch (error) {
        return error?.code === 'ENOENT';
    }
    return true;
}

export function streamAdmittedUpload(req, {
    storageRoot,
    targetPath,
    policy,
    replaceExisting = false,
    includeEntry,
    includeDirectory,
    timers = {},
    finalize,
    onSuccess,
    onFailure,
} = {}) {
    const now = timers.now || Date.now;
    const startedAt = now();
    let reservation;
    try {
        reservation = reserveUpload({
            req,
            storageRoot,
            targetPath,
            policy,
            replaceExisting,
            includeEntry,
            includeDirectory,
        });
    } catch (error) {
        try { req.resume?.(); } catch (_) { /* ignore */ }
        onFailure?.(normalizeFailure(error));
        return { accepted: false };
    }

    const setTimer = timers.setTimeout || globalThis.setTimeout;
    const clearTimer = timers.clearTimeout || globalThis.clearTimeout;
    reservation.temporaryPath = makeTemporaryPath(reservation.targetPath);

    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= reservation.policy.timeoutMs) {
        releaseReservation(reservation);
        try { req.resume?.(); } catch (_) { /* ignore */ }
        onFailure?.(uploadError(408, 'upload_timeout'));
        return { accepted: false };
    }

    let fileDescriptor;
    try {
        fileDescriptor = fs.openSync(reservation.temporaryPath, 'wx');
        if (reservation.targetState.exists) {
            fs.fchmodSync(fileDescriptor, reservation.targetState.identity.mode & 0o777);
        }
    } catch (error) {
        if (fileDescriptor !== undefined) {
            try { fs.closeSync(fileDescriptor); } catch (_) { /* ignore */ }
        }
        const cleanupSucceeded = removePartial(reservation.temporaryPath);
        releaseReservation(reservation);
        try { req.resume?.(); } catch (_) { /* ignore */ }
        onFailure?.(cleanupSucceeded
            ? normalizeFailure(error)
            : uploadError(500, 'upload_cleanup_failed'));
        return { accepted: false };
    }

    let completed = false;
    let terminalError = null;
    let streamFinished = false;
    let size = 0;
    let timeoutHandle = null;
    const output = fs.createWriteStream(reservation.temporaryPath, {
        fd: fileDescriptor,
        autoClose: true,
    });

    const detachRequestListeners = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('aborted', onAborted);
        req.off('error', onRequestError);
        output.off('drain', onDrain);
    };
    const clearUploadTimer = () => {
        if (timeoutHandle !== null) clearTimer(timeoutHandle);
        timeoutHandle = null;
    };
    const fail = (error) => {
        if (completed || terminalError) return;
        terminalError = normalizeFailure(error);
        clearUploadTimer();
        detachRequestListeners();
        try { req.resume?.(); } catch (_) { /* ignore */ }
        try { output.destroy(); } catch (_) { /* ignore */ }
    };
    const onDrain = () => {
        if (!completed && !terminalError) req.resume?.();
    };
    const onData = (chunk) => {
        if (completed || terminalError) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const nextSize = size + buffer.length;
        if (!Number.isSafeInteger(nextSize) || nextSize > reservation.policy.maxBytes) {
            fail(uploadError(413, 'upload_too_large'));
            return;
        }
        if (reservation.contentLength !== null && nextSize > reservation.contentLength) {
            fail(uploadError(400, 'content_length_mismatch'));
            return;
        }
        size = nextSize;
        if (!output.write(buffer)) {
            req.pause?.();
            output.once('drain', onDrain);
        }
    };
    const onEnd = () => {
        if (completed || terminalError) return;
        if (reservation.contentLength !== null && size !== reservation.contentLength) {
            fail(uploadError(400, 'content_length_mismatch'));
            return;
        }
        output.end();
    };
    const onAborted = () => fail(uploadError(400, 'upload_aborted'));
    const onRequestError = () => fail(uploadError(400, 'upload_aborted'));

    output.once('error', (error) => fail(error));
    output.once('finish', () => {
        streamFinished = true;
    });
    output.once('close', () => {
        if (completed) return;
        if (terminalError || !streamFinished) {
            completed = true;
            clearUploadTimer();
            detachRequestListeners();
            const cleanupSucceeded = removePartial(reservation.temporaryPath);
            releaseReservation(reservation);
            onFailure?.(cleanupSucceeded
                ? terminalError || uploadError(500, 'upload_write_failed')
                : uploadError(500, 'upload_cleanup_failed'));
            return;
        }
        try {
            verifyFinalQuota(reservation, size);
            commitTemporary(reservation);
            finalize?.({ size, targetPath: reservation.targetPath });
        } catch (error) {
            let targetCleanupSucceeded = true;
            if (!reservation.targetState.exists) {
                targetCleanupSucceeded = removePartial(reservation.targetPath);
            }
            completed = true;
            clearUploadTimer();
            detachRequestListeners();
            const cleanupSucceeded = removePartial(reservation.temporaryPath);
            releaseReservation(reservation);
            onFailure?.(cleanupSucceeded && targetCleanupSucceeded
                ? normalizeFailure(error)
                : uploadError(500, 'upload_cleanup_failed'));
            return;
        }
        completed = true;
        clearUploadTimer();
        detachRequestListeners();
        releaseReservation(reservation);
        onSuccess?.({ size, targetPath: reservation.targetPath });
    });

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onRequestError);
    timeoutHandle = setTimer(
        () => fail(uploadError(408, 'upload_timeout')),
        reservation.policy.timeoutMs - elapsedMs,
    );

    return {
        accepted: true,
        abort: () => fail(uploadError(400, 'upload_aborted')),
    };
}
