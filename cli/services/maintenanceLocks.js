import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { RUNNING_DIR } from './config.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAINTENANCE_DIR = path.join(RUNNING_DIR, 'maintenance');
const WORKSPACE_START_LOCK_PATH = path.join(RUNNING_DIR, 'workspace-start.json');
const WORKSPACE_START_TTL_MS = 24 * 60 * 60 * 1000;

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

function readWorkspaceStartLock() {
    try {
        const lock = JSON.parse(fs.readFileSync(WORKSPACE_START_LOCK_PATH, 'utf8'));
        return lock && typeof lock === 'object' ? { ...lock, filePath: WORKSPACE_START_LOCK_PATH } : null;
    } catch (_) {
        return null;
    }
}

function inspectWorkspaceStartLock() {
    const exists = fs.existsSync(WORKSPACE_START_LOCK_PATH);
    const lock = readWorkspaceStartLock();
    if (!lock) {
        if (exists) {
            try { fs.unlinkSync(WORKSPACE_START_LOCK_PATH); } catch (_) {}
            return { active: false, stale: true, lock: null };
        }
        return { active: false, stale: false, lock: null };
    }
    const expiresAtMs = Date.parse(lock.expiresAt || '');
    const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= Date.now() : true;
    const ownerAlive = isProcessAlive(lock.ownerPid);
    if (expired || !ownerAlive) {
        try { fs.unlinkSync(WORKSPACE_START_LOCK_PATH); } catch (_) {}
        return { active: false, stale: true, lock };
    }
    return { active: true, stale: false, lock };
}

function createWorkspaceStartLock({ ttlMs = WORKSPACE_START_TTL_MS } = {}) {
    const existing = inspectWorkspaceStartLock();
    if (existing.active) {
        throw new Error(`workspace start is already active under pid ${existing.lock?.ownerPid || '<unknown>'}`);
    }
    const now = Date.now();
    const lock = {
        operation: 'workspace-start',
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
            throw new Error(`workspace start is already active under pid ${raced.lock?.ownerPid || '<unknown>'}`);
        }
        throw error;
    }
    return lock;
}

function releaseWorkspaceStartLock(lock) {
    const current = readWorkspaceStartLock();
    if (!current || !lock || current.token !== lock.token) return false;
    try {
        fs.unlinkSync(WORKSPACE_START_LOCK_PATH);
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
    WORKSPACE_START_LOCK_PATH,
    createMaintenanceLock,
    createWorkspaceStartLock,
    inspectMaintenanceLock,
    inspectWorkspaceStartLock,
    releaseWorkspaceStartLock,
    removeMaintenanceLock,
    withMaintenanceLock,
};
