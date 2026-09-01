import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { RUNNING_DIR } from '../config.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 100;
const MAX_WORKSPACE_MUTATION_WAIT_MS = 15 * 60 * 1000;
const MAX_WORKSPACE_MUTATION_RETRY_INTERVAL_MS = 1_000;
const MAINTENANCE_DIR = path.join(RUNNING_DIR, 'maintenance');
const WORKSPACE_START_LOCK_PATH = path.join(RUNNING_DIR, 'workspace-start.json');
const WORKSPACE_START_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_GRACE_MS = 5_000;

function lockPathFor(containerName) {
    // Direct replacement candidates use an immutable physical name so the
    // predecessor can remain live through readiness. All generations of that
    // one logical runtime must still serialize on the predecessor's stable
    // maintenance identity.
    const logicalName = String(containerName || '').replace(/__candidate_[a-f0-9]{12}$/i, '');
    const safeName = logicalName.replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(MAINTENANCE_DIR, `${safeName}.json`);
}

function isProcessAlive(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) {
        return false;
    }
    try {
        process.kill(numericPid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function lockSnapshot(filePath) {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            return {
                filePath,
                lock: null,
                mtimeMs: stat.mtimeMs,
                fingerprint: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}`,
            };
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        let lock = null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') lock = parsed;
        } catch (_) {}
        return {
            filePath,
            lock,
            mtimeMs: stat.mtimeMs,
            fingerprint: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${raw}`,
        };
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function removeSnapshot(snapshot, token = null) {
    if (!snapshot) return false;
    const current = lockSnapshot(snapshot.filePath);
    if (!current || current.fingerprint !== snapshot.fingerprint) return false;
    if (token !== null && current.lock?.token !== token) return false;
    try {
        fs.unlinkSync(snapshot.filePath);
        return true;
    } catch (_) {
        return false;
    }
}

function removeMaintenanceLock(containerName, token = null) {
    const snapshot = lockSnapshot(lockPathFor(containerName));
    return removeSnapshot(snapshot, token);
}

function inspectWorkspaceStartLock(attempt = 0) {
    const snapshot = lockSnapshot(WORKSPACE_START_LOCK_PATH);
    if (!snapshot) {
        return { active: false, stale: false, lock: null };
    }
    const lock = snapshot.lock ? { ...snapshot.lock, filePath: WORKSPACE_START_LOCK_PATH } : null;
    if (!lock && Date.now() - snapshot.mtimeMs < LOCK_STALE_GRACE_MS) {
        return { active: true, stale: false, recoveryPending: true, lock: null };
    }
    const expiresAtMs = Date.parse(lock?.expiresAt || '');
    const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= Date.now() : true;
    const ownerAlive = isProcessAlive(lock?.ownerPid);
    if (ownerAlive) {
        return { active: true, stale: false, renewalOverdue: expired, lock };
    }
    if (removeSnapshot(snapshot)) return { active: false, stale: true, lock };
    if (attempt >= 2) return { active: true, stale: false, recoveryPending: true, lock };
    return inspectWorkspaceStartLock(attempt + 1);
}

function workspaceMutationBusy(lock) {
    const description = lock?.operation === 'workspace-start'
        ? 'workspace start'
        : `workspace mutation '${lock?.operation || 'unknown'}'`;
    const error = new Error(`${description} is already active under pid ${lock?.ownerPid || '<unknown>'}`);
    error.code = 'PLOINKY_WORKSPACE_MUTATION_BUSY';
    return error;
}

function createWorkspaceMutationLease({
    ttlMs = WORKSPACE_START_TTL_MS,
    operation = 'workspace-mutation',
} = {}) {
    const existing = inspectWorkspaceStartLock();
    if (existing.active) throw workspaceMutationBusy(existing.lock);
    const now = Date.now();
    const lock = {
        operation,
        ownerPid: process.pid,
        token: randomUUID(),
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
    };
    fs.mkdirSync(RUNNING_DIR, { recursive: true });
    try {
        fs.writeFileSync(WORKSPACE_START_LOCK_PATH, JSON.stringify(lock, null, 2), { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error?.code === 'EEXIST') {
            const raced = inspectWorkspaceStartLock();
            throw workspaceMutationBusy(raced.lock);
        }
        throw error;
    }
    return lock;
}

async function acquireWorkspaceMutationLease({
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    ...lockOptions
} = {}) {
    // Detached startup workers intentionally contend with their still-running
    // parent and with publication. Bound the wait rather than treating either
    // expected owner as an immediate failure or waiting forever.
    const requestedWaitMs = Number(waitTimeoutMs);
    const boundedWaitMs = Number.isFinite(requestedWaitMs)
        ? Math.max(0, Math.min(MAX_WORKSPACE_MUTATION_WAIT_MS, requestedWaitMs))
        : DEFAULT_WAIT_TIMEOUT_MS;
    const requestedRetryMs = Number(retryIntervalMs);
    const boundedRetryMs = Number.isFinite(requestedRetryMs)
        ? Math.max(1, Math.min(MAX_WORKSPACE_MUTATION_RETRY_INTERVAL_MS, requestedRetryMs))
        : DEFAULT_RETRY_INTERVAL_MS;
    const deadline = Date.now() + boundedWaitMs;
    while (true) {
        try {
            return createWorkspaceMutationLease(lockOptions);
        } catch (error) {
            if (error?.code !== 'PLOINKY_WORKSPACE_MUTATION_BUSY') throw error;
        }

        const state = inspectWorkspaceStartLock();
        if (!state.active && !fs.existsSync(WORKSPACE_START_LOCK_PATH)) continue;
        if (Date.now() >= deadline) {
            const error = new Error(
                `Timed out waiting for ${state.lock?.operation || 'workspace mutation'} to release the workspace mutation lease.`
            );
            error.code = 'workspace_mutation_lock_timeout';
            throw error;
        }
        await wait(boundedRetryMs);
    }
}

async function withWorkspaceMutationLease(options, fn) {
    if (typeof fn !== 'function') throw new TypeError('workspace mutation lease requires a callback');
    const lease = await acquireWorkspaceMutationLease(options);
    let callbackError = null;
    try {
        return await fn();
    } catch (error) {
        callbackError = error;
        throw error;
    } finally {
        if (!releaseWorkspaceMutationLease(lease)) {
            const releaseError = new Error(
                `workspace mutation '${lease.operation}' could not release its exact lease`
            );
            releaseError.code = 'workspace_mutation_lock_release_failed';
            if (callbackError) {
                callbackError.message += `; ${releaseError.message}`;
            } else {
                throw releaseError;
            }
        }
    }
}

function createWorkspaceStartLock(options = {}) {
    return createWorkspaceMutationLease({ ...options, operation: 'workspace-start' });
}

function renewWorkspaceMutationLease(lock, { ttlMs = WORKSPACE_START_TTL_MS } = {}) {
    if (!lock?.token) return false;
    const snapshot = lockSnapshot(WORKSPACE_START_LOCK_PATH);
    if (!snapshot?.lock || snapshot.lock.token !== lock.token || snapshot.lock.ownerPid !== process.pid) return false;
    let descriptor;
    try {
        descriptor = fs.openSync(WORKSPACE_START_LOCK_PATH, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(descriptor);
        const [snapshotDev, snapshotIno] = snapshot.fingerprint.split(':');
        if (String(opened.dev) !== snapshotDev || String(opened.ino) !== snapshotIno) return false;
        const renewed = {
            ...snapshot.lock,
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        };
        fs.ftruncateSync(descriptor, 0);
        fs.writeFileSync(descriptor, JSON.stringify(renewed, null, 2), 'utf8');
        fs.fsyncSync(descriptor);
        Object.assign(lock, renewed);
        return lockSnapshot(WORKSPACE_START_LOCK_PATH)?.lock?.token === lock.token;
    } catch (_) {
        return false;
    } finally {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch (_) {}
        }
    }
}

function releaseWorkspaceStartLock(lock) {
    if (!lock?.token) return false;
    return removeSnapshot(lockSnapshot(WORKSPACE_START_LOCK_PATH), lock.token);
}

const releaseWorkspaceMutationLease = releaseWorkspaceStartLock;

function createMaintenanceLock(containerName, {
    operation = 'maintenance',
    ttlMs = DEFAULT_TTL_MS,
    metadata = {},
} = {}) {
    if (!containerName) {
        throw new Error('maintenance lock requires a container name');
    }
    const now = Date.now();
    const lock = {
        ...metadata,
        containerName,
        operation,
        ownerPid: process.pid,
        token: randomUUID(),
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
    };
    fs.mkdirSync(MAINTENANCE_DIR, { recursive: true });
    const existing = inspectMaintenanceLock(containerName);
    if (existing.active) {
        const error = new Error(`maintenance is already active for '${containerName}' under pid ${existing.lock?.ownerPid || '<unknown>'}`);
        error.code = 'PLOINKY_MAINTENANCE_BUSY';
        throw error;
    }
    try {
        fs.writeFileSync(lockPathFor(containerName), JSON.stringify(lock, null, 2), { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error?.code === 'EEXIST') {
            const busy = new Error(`maintenance is already active for '${containerName}'`);
            busy.code = 'PLOINKY_MAINTENANCE_BUSY';
            throw busy;
        }
        throw error;
    }
    return lock;
}

function wait(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function acquireMaintenanceLock(containerName, {
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    ...lockOptions
} = {}) {
    const deadline = Date.now() + Math.max(0, Number(waitTimeoutMs) || 0);
    while (true) {
        try {
            return createMaintenanceLock(containerName, lockOptions);
        } catch (error) {
            if (error?.code !== 'EEXIST' && error?.code !== 'PLOINKY_MAINTENANCE_BUSY') throw error;
        }

        const state = inspectMaintenanceLock(containerName);
        if (!state.active && !fs.existsSync(lockPathFor(containerName))) continue;
        if (Date.now() >= deadline) {
            const error = new Error(
                `Timed out waiting for maintenance lock on '${containerName}' held by ${state.lock?.operation || 'maintenance'}.`
            );
            error.code = 'maintenance_lock_timeout';
            throw error;
        }
        await wait(Math.max(1, Number(retryIntervalMs) || DEFAULT_RETRY_INTERVAL_MS));
    }
}

async function withMaintenanceLock(containerName, options, fn) {
    const lock = await acquireMaintenanceLock(containerName, options);
    try {
        return await fn();
    } finally {
        removeMaintenanceLock(containerName, lock.token);
    }
}

function inspectMaintenanceLock(containerName, attempt = 0) {
    const snapshot = lockSnapshot(lockPathFor(containerName));
    if (!snapshot) {
        return { active: false, stale: false, lock: null };
    }
    const lock = snapshot.lock ? { ...snapshot.lock, filePath: snapshot.filePath } : null;
    if (!lock && Date.now() - snapshot.mtimeMs < LOCK_STALE_GRACE_MS) {
        return { active: true, stale: false, recoveryPending: true, lock: null };
    }

    const expiresAtMs = Date.parse(lock?.expiresAt || '');
    const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= Date.now() : true;
    const ownerAlive = isProcessAlive(lock?.ownerPid);
    if (ownerAlive) {
        return { active: true, stale: false, renewalOverdue: expired, lock };
    }
    if (removeSnapshot(snapshot)) return { active: false, stale: true, lock };
    if (attempt >= 2) return { active: true, stale: false, recoveryPending: true, lock };
    return inspectMaintenanceLock(containerName, attempt + 1);
}

export {
    WORKSPACE_START_LOCK_PATH,
    acquireMaintenanceLock,
    acquireWorkspaceMutationLease,
    createMaintenanceLock,
    createWorkspaceMutationLease,
    createWorkspaceStartLock,
    inspectMaintenanceLock,
    inspectWorkspaceStartLock,
    releaseWorkspaceStartLock,
    releaseWorkspaceMutationLease,
    renewWorkspaceMutationLease,
    removeMaintenanceLock,
    withMaintenanceLock,
    withWorkspaceMutationLease,
};
