import fs from 'fs';
import path from 'path';

import { RUNNING_DIR } from './config.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
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

function removeMaintenanceLock(containerName) {
    try {
        fs.unlinkSync(lockPathFor(containerName));
    } catch (_) {}
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
        containerName,
        operation,
        ownerPid: process.pid,
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        ...metadata,
    };
    fs.mkdirSync(MAINTENANCE_DIR, { recursive: true });
    fs.writeFileSync(lockPathFor(containerName), JSON.stringify(lock, null, 2));
    return lock;
}

function withMaintenanceLock(containerName, options, fn) {
    createMaintenanceLock(containerName, options);
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            removeMaintenanceLock(containerName);
        });
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
        removeMaintenanceLock(containerName);
        return { active: false, stale: true, lock };
    }

    return { active: true, stale: false, lock };
}

export {
    createMaintenanceLock,
    inspectMaintenanceLock,
    removeMaintenanceLock,
    withMaintenanceLock,
};
