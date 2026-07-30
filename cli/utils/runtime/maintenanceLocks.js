import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { RUNNING_DIR } from '../config.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 100;
const MAINTENANCE_DIR = path.join(RUNNING_DIR, 'maintenance');

function lockPathFor(containerName) {
    const safeName = String(containerName || '').replace(/[^A-Za-z0-9_.-]/g, '_');
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

function readMaintenanceLock(containerName) {
    const filePath = lockPathFor(containerName);
    try {
        const lock = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return lock && typeof lock === 'object' ? { ...lock, filePath } : null;
    } catch (_) {
        return null;
    }
}

function removeMaintenanceLock(containerName, { lockId: expectedLockId } = {}) {
    if (expectedLockId) {
        const current = readMaintenanceLock(containerName);
        if (current?.lockId !== expectedLockId) return false;
    }
    try {
        fs.unlinkSync(lockPathFor(containerName));
        return true;
    } catch (_) {
        return false;
    }
}

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
        lockId: randomUUID(),
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
    };
    fs.mkdirSync(MAINTENANCE_DIR, { recursive: true });
    const filePath = lockPathFor(containerName);
    let fd;
    try {
        fd = fs.openSync(filePath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(lock, null, 2), 'utf8');
        fs.fsyncSync(fd);
    } catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (_) {}
            try { fs.unlinkSync(filePath); } catch (_) {}
        }
        throw error;
    }
    fs.closeSync(fd);
    return { ...lock, filePath };
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
            if (error?.code !== 'EEXIST') throw error;
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
        removeMaintenanceLock(containerName, { lockId: lock.lockId });
    }
}

function inspectMaintenanceLock(containerName) {
    const lock = readMaintenanceLock(containerName);
    if (!lock) {
        return { active: false, stale: false, lock: null };
    }

    const expiresAtMs = Date.parse(lock.expiresAt || '');
    const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= Date.now() : true;
    const ownerAlive = isProcessAlive(lock.ownerPid);
    const stale = expired || !ownerAlive;

    if (stale) {
        removeMaintenanceLock(containerName, { lockId: lock.lockId });
        return { active: false, stale: true, lock };
    }

    return { active: true, stale: false, lock };
}

export {
    acquireMaintenanceLock,
    createMaintenanceLock,
    inspectMaintenanceLock,
    removeMaintenanceLock,
    withMaintenanceLock,
};
