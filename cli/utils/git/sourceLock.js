import crypto from 'node:crypto';
import fs from 'node:fs';

// Identity of the host Ploinky source lock. The host `ploinky update` writer
// (ploinky-box/command/hostUpdate.mjs) and the direct-core self-update
// (cli/commands/updateService.js) must name the same lock in the same lock
// manager so their source mutations never overlap.
export function ploinkySourceLockIdentity(repositoryRoot, { realpath = fs.realpathSync.native } = {}) {
    const canonicalRoot = realpath(repositoryRoot);
    const digest = crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
    return Object.freeze({
        canonicalRoot,
        lockIdentity: `ploinky-box-source-${digest}`,
    });
}

// The default source lock manager is the host Box mutation lock manager.
// It is imported lazily so importing this module has no host-state effects.
export async function createDefaultSourceLockManager(options = {}) {
    const { createMutationLockManager } = await import('../../../ploinky-box/locks.mjs');
    return createMutationLockManager(options);
}

// The mutation lock manager publishes a lock directory before its owner file
// and removes the owner file before the directory, so a concurrent acquirer
// can observe an ownerless lock for a moment and fail with ENOENT instead of
// waiting. Retry that transient observation for a bounded time; a lock that
// stays ownerless (for example after a crash between the two steps) still
// fails once the bound is reached. This retry is a stopgap for the manager's
// publication order; the manager itself should treat an ownerless lock as busy.
// Both shapes occur: a wrapped PLOINKY_BOX_LOCK_FAILED whose cause is ENOENT
// (owner file missing) and a raw ENOENT (the lock directory vanished during
// the waiter's inspection).
export function isTransientOwnerlessLock(error) {
    if (error?.code === 'ENOENT') return true;
    if (error?.code !== 'PLOINKY_BOX_LOCK_FAILED') return false;
    let current = error.cause;
    for (let depth = 0; current && depth < 4; depth += 1) {
        if (current.code === 'ENOENT') return true;
        current = current.cause;
    }
    return false;
}

export async function acquireSourceLock(manager, lockIdentity, {
    transientRetryMs = 25,
    transientTimeoutMs = 5_000,
    now = () => Date.now(),
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    const deadline = now() + transientTimeoutMs;
    while (true) {
        try {
            return await manager.acquire(lockIdentity);
        } catch (error) {
            if (!isTransientOwnerlessLock(error) || now() >= deadline) throw error;
            await delay(transientRetryMs);
        }
    }
}
