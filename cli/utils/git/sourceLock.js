import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_LOCK_NAME = 'ploinky-source.lock';
const GITDIR_FILE_MAX_BYTES = 4096;

// Identity of the host Ploinky source lock. The host `ploinky update` writer
// (ploinky-box/command/hostUpdate.mjs) and the direct-core self-update
// (cli/commands/updateService.js) must name the same lock so their source
// mutations never overlap. `lockIdentity` is the lock's label and names the
// checkout; the lock itself lives in the checkout's git directory.
export function ploinkySourceLockIdentity(repositoryRoot, { realpath = fs.realpathSync.native } = {}) {
    const canonicalRoot = realpath(repositoryRoot);
    const digest = crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
    return Object.freeze({
        canonicalRoot,
        lockIdentity: `ploinky-box-source-${digest}`,
    });
}

function sourceLockError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = 'PLOINKY_SOURCE_LOCK_PATH_INVALID';
    return error;
}

/**
 * The git directory of a checkout, read from `.git` without running git: a
 * `.git` directory, or a `.git` file whose `gitdir:` line names the
 * per-worktree git directory of a linked worktree.
 */
export function resolveCheckoutGitDirectory(canonicalRoot, { fsApi = fs } = {}) {
    const dotGit = path.join(canonicalRoot, '.git');
    let stat;
    try {
        stat = fsApi.lstatSync(dotGit);
    } catch (error) {
        throw sourceLockError(`The Ploinky checkout has no .git: ${canonicalRoot}`, error);
    }
    let gitDirectory;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
        gitDirectory = dotGit;
    } else if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= GITDIR_FILE_MAX_BYTES) {
        const firstLine = String(fsApi.readFileSync(dotGit, 'utf8')).split('\n')[0].replace(/\r$/, '');
        const match = /^gitdir: (.+)$/.exec(firstLine);
        if (!match || !match[1].trim()) {
            throw sourceLockError(`The .git file of the Ploinky checkout does not name a git directory: ${dotGit}`);
        }
        gitDirectory = path.resolve(canonicalRoot, match[1].trim());
    } else {
        throw sourceLockError(`The .git of the Ploinky checkout is neither a directory nor a gitdir file: ${dotGit}`);
    }
    let canonical;
    try {
        canonical = fsApi.realpathSync.native(gitDirectory);
    } catch (error) {
        throw sourceLockError(`The git directory of the Ploinky checkout is missing: ${gitDirectory}`, error);
    }
    const resolved = fsApi.lstatSync(canonical);
    if (!resolved.isDirectory() || resolved.isSymbolicLink()) {
        throw sourceLockError(`The git directory of the Ploinky checkout is not a directory: ${canonical}`);
    }
    return canonical;
}

export function ploinkySourceLockPath(canonicalRoot, options = {}) {
    return path.join(resolveCheckoutGitDirectory(canonicalRoot, options), SOURCE_LOCK_NAME);
}

// The default source lock manager is the host Box mutation lock manager.
// It is imported lazily so importing this module has no host-state effects.
export async function createDefaultSourceLockManager(options = {}) {
    const { createMutationLockManager } = await import('../../../ploinky-box/locks.mjs');
    return createMutationLockManager(options);
}

// The lock manager treats an ownerless lock as busy. This bounded retry of a
// transient ENOENT observation remains for managers that surface it (both a
// wrapped PLOINKY_BOX_LOCK_FAILED whose cause is ENOENT and a raw ENOENT).
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

/**
 * Acquires `<git-dir>/ploinky-source.lock` of `source.canonicalRoot` (the
 * per-worktree git directory for a linked worktree), labelled with
 * `source.lockIdentity`.
 */
export async function acquireSourceLock(manager, source, {
    transientRetryMs = 25,
    transientTimeoutMs = 5_000,
    now = () => Date.now(),
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    resolveLockPath = ploinkySourceLockPath,
} = {}) {
    if (!source?.canonicalRoot || !source?.lockIdentity) {
        throw new TypeError('acquireSourceLock requires the source lock identity of one checkout');
    }
    const lockPath = resolveLockPath(source.canonicalRoot);
    const deadline = now() + transientTimeoutMs;
    while (true) {
        try {
            return await manager.acquireAt(lockPath, source.lockIdentity);
        } catch (error) {
            if (!isTransientOwnerlessLock(error) || now() >= deadline) throw error;
            await delay(transientRetryMs);
        }
    }
}
