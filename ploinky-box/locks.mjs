import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { PloinkyBoxError } from './errors.mjs';
import { materializeIdentityAnchor } from './identity.mjs';

function lockError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_LOCK_FAILED',
        cause,
    });
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwnedDirectory(directory, fsApi) {
    const stat = fsApi.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw lockError(`Lock path component is not a real directory: ${directory}`);
    }
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) {
        throw lockError(`Lock path component is not owned by the current user: ${directory}`);
    }
    return stat;
}

function ensurePrivateDirectory(directory, fsApi) {
    try {
        assertOwnedDirectory(directory, fsApi);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        try {
            fsApi.mkdirSync(directory, { recursive: false, mode: 0o700 });
        } catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST') {
                throw mkdirError;
            }
        }
        assertOwnedDirectory(directory, fsApi);
    }
    fsApi.chmodSync(directory, 0o700);
}

function parseOwner(ownerPath, fsApi) {
    let stat;
    let bytes;
    try {
        stat = fsApi.lstatSync(ownerPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw lockError(`Mutation lock owner is not a regular file: ${ownerPath}`);
        }
        bytes = fsApi.readFileSync(ownerPath);
    } catch (error) {
        if (error instanceof PloinkyBoxError) {
            throw error;
        }
        throw lockError(`Unable to read mutation lock owner: ${ownerPath}`, error);
    }

    let owner;
    try {
        owner = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw lockError(`Mutation lock owner is malformed: ${ownerPath}`, error);
    }
    const expectedKeys = ['hostname', 'instance', 'pid', 'startedAt'];
    if (!owner
        || JSON.stringify(Object.keys(owner).sort()) !== JSON.stringify(expectedKeys)
        || typeof owner.hostname !== 'string'
        || !Number.isSafeInteger(owner.pid)
        || owner.pid <= 0
        || typeof owner.instance !== 'string'
        || typeof owner.startedAt !== 'string') {
        throw lockError(`Mutation lock owner is incomplete: ${ownerPath}`);
    }
    return {
        owner,
        fingerprint: {
            device: String(stat.dev),
            inode: String(stat.ino),
            size: stat.size,
            bytes,
        },
    };
}

// Names the holder when its owner record can be read.
function lockBusyError(lockPath, ownerPath, fsApi) {
    let holder = '';
    try {
        const { owner } = parseOwner(ownerPath, fsApi);
        holder = ` (pid ${owner.pid} on ${owner.hostname}, since ${owner.startedAt})`;
    } catch {}
    const error = lockError(`Timed out waiting for mutation lock: ${lockPath}. Another Ploinky command${holder} `
        + 'holds it. Run the command again after that command finishes.');
    error.lockBusy = true;
    return error;
}

function ownerUnchanged(ownerPath, fingerprint, fsApi) {
    const stat = fsApi.lstatSync(ownerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        return false;
    }
    if (String(stat.dev) !== fingerprint.device
        || String(stat.ino) !== fingerprint.inode
        || stat.size !== fingerprint.size) {
        return false;
    }
    return fsApi.readFileSync(ownerPath).equals(fingerprint.bytes);
}

function processIsProvenDead(pid, kill) {
    try {
        kill(pid, 0);
        return false;
    } catch (error) {
        if (error.code === 'ESRCH') {
            return true;
        }
        return false;
    }
}

export function createMutationLockManager({
    homeDirectory = os.homedir(),
    hostname = os.hostname(),
    pid = process.pid,
    now = () => new Date(),
    kill = (targetPid, signal) => process.kill(targetPid, signal),
    fsApi = fs,
    retryMs = 50,
    timeoutMs = 30_000,
} = {}) {
    const stateRoot = path.join(homeDirectory, '.ploinky-box');
    const locksRoot = path.join(stateRoot, 'locks');

    function ensureRoots() {
        ensurePrivateDirectory(stateRoot, fsApi);
        ensurePrivateDirectory(locksRoot, fsApi);
    }

    function recoverStaleLock(lockPath, ownerPath, instance) {
        let captured;
        try {
            assertOwnedDirectory(lockPath, fsApi);
            captured = parseOwner(ownerPath, fsApi);
        } catch (error) {
            // An acquirer publishes the lock directory before its owner file and
            // a releaser removes the owner file first. An ownerless or vanished
            // lock is a transient observation: keep waiting, never reclaim it.
            if (error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
        if (captured.owner.instance !== instance) {
            throw lockError(`Mutation lock identity does not match ${instance}`);
        }
        if (captured.owner.hostname !== hostname) {
            return false;
        }
        if (!processIsProvenDead(captured.owner.pid, kill)) {
            return false;
        }
        if (!ownerUnchanged(ownerPath, captured.fingerprint, fsApi)) {
            throw lockError(`Mutation lock owner changed during stale-lock recovery: ${lockPath}`);
        }
        fsApi.unlinkSync(ownerPath);
        try {
            fsApi.rmdirSync(lockPath);
        } catch (error) {
            throw lockError(`Stale mutation lock contains unexpected entries: ${lockPath}`, error);
        }
        return true;
    }

    async function acquire(instance) {
        if (!/^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/.test(instance)) {
            throw lockError(`Invalid mutation lock identity: ${instance}`);
        }
        ensureRoots();
        const lockPath = path.join(locksRoot, `${instance}.lock`);
        const ownerPath = path.join(lockPath, 'owner.json');
        const deadline = Date.now() + timeoutMs;

        while (true) {
            try {
                fsApi.mkdirSync(lockPath, { recursive: false, mode: 0o700 });
                fsApi.chmodSync(lockPath, 0o700);
                const owner = {
                    hostname,
                    pid,
                    instance,
                    startedAt: now().toISOString(),
                };
                try {
                    fsApi.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, {
                        flag: 'wx',
                        mode: 0o600,
                    });
                    fsApi.chmodSync(ownerPath, 0o600);
                } catch (error) {
                    try {
                        fsApi.rmdirSync(lockPath);
                    } catch {}
                    throw lockError(`Unable to write mutation lock owner: ${lockPath}`, error);
                }

                let released = false;
                return {
                    instance,
                    path: lockPath,
                    assertHeld(expectedInstance) {
                        if (released || expectedInstance !== instance) {
                            throw lockError(`Mutation lock is not held for ${expectedInstance}`);
                        }
                    },
                    release() {
                        if (released) {
                            throw lockError(`Mutation lock was already released: ${lockPath}`);
                        }
                        const captured = parseOwner(ownerPath, fsApi);
                        if (captured.owner.hostname !== hostname
                            || captured.owner.pid !== pid
                            || captured.owner.instance !== instance) {
                            throw lockError(`Mutation lock ownership changed before release: ${lockPath}`);
                        }
                        fsApi.unlinkSync(ownerPath);
                        fsApi.rmdirSync(lockPath);
                        released = true;
                    },
                };
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    if (error instanceof PloinkyBoxError) {
                        throw error;
                    }
                    throw lockError(`Unable to acquire mutation lock: ${lockPath}`, error);
                }

                if (recoverStaleLock(lockPath, ownerPath, instance)) {
                    continue;
                }
                if (Date.now() >= deadline) {
                    throw lockBusyError(lockPath, ownerPath, fsApi);
                }
                await delay(retryMs);
            }
        }
    }

    return {
        acquire,
        locksRoot,
        stateRoot,
    };
}

export async function withWorkspaceMutationLock({
    resolveIdentity,
    lockManager,
    execute,
    beforeAnchor = async () => undefined,
    materializeAnchor = materializeIdentityAnchor,
    maxHandoffs = 4,
}) {
    if (typeof resolveIdentity !== 'function' || typeof execute !== 'function') {
        throw new TypeError('Locked workspace transactions require resolveIdentity and execute');
    }
    let identity = resolveIdentity();
    const visited = new Set();

    for (let handoff = 0; handoff <= maxHandoffs; handoff += 1) {
        if (visited.has(identity.instance)) {
            throw lockError(`Workspace identity lock handoff cycle detected at ${identity.instance}`);
        }
        visited.add(identity.instance);
        let lock;
        try {
            lock = await lockManager.acquire(identity.instance);
        } catch (error) {
            // Nothing runs before this lock is held: the transaction never started.
            error.workspaceTransactionStarted = false;
            throw error;
        }
        let released = false;
        try {
            const resolvedUnderLock = resolveIdentity();
            if (resolvedUnderLock.instance !== identity.instance) {
                lock.release();
                released = true;
                identity = resolvedUnderLock;
                continue;
            }
            const prepared = await beforeAnchor(resolvedUnderLock, lock);
            if (!resolvedUnderLock.markerFound) {
                materializeAnchor(resolvedUnderLock, lock);
            }
            return await execute(resolvedUnderLock, lock, prepared);
        } finally {
            if (!released) {
                lock.release();
            }
        }
    }
    throw lockError(`Workspace identity lock handoff exceeded ${maxHandoffs}`);
}
