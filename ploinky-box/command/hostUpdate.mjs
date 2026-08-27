import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isGitRepo, updatePloinkySelf } from '../../cli/commands/updateService.js';
import { PloinkyBoxError } from '../errors.mjs';
import { createMutationLockManager } from '../locks.mjs';

function hostUpdateError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_HOST_UPDATE_FAILED',
        cause,
    });
}

function workspaceUpdateError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_WORKSPACE_PLOINKY_UPDATE_FAILED',
        cause,
    });
}

function skippedWorkspaceUpdate(repoPath, reason, extra = {}) {
    return Object.freeze({
        found: false,
        updated: false,
        skipped: true,
        repoPath,
        reason,
        ...extra,
    });
}

export function hostSourceLockIdentity(repositoryRoot, {
    realpath = fs.realpathSync.native,
} = {}) {
    let canonicalRoot;
    try {
        canonicalRoot = realpath(repositoryRoot);
    } catch (error) {
        throw hostUpdateError(`Unable to resolve the host Ploinky checkout: ${repositoryRoot}`, error);
    }
    const digest = crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
    return Object.freeze({
        canonicalRoot,
        lockIdentity: `ploinky-box-source-${digest}`,
    });
}

export async function updateHostPloinkySource({
    repositoryRoot,
    lockManager = createMutationLockManager(),
    updateSelf = updatePloinkySelf,
    boxMarkerPath,
    realpath,
} = {}) {
    const source = hostSourceLockIdentity(repositoryRoot, { realpath });
    const lock = await lockManager.acquire(source.lockIdentity);
    try {
        lock.assertHeld(source.lockIdentity);
        const result = updateSelf({
            repoPath: source.canonicalRoot,
            interactiveSession: false,
            ...(boxMarkerPath ? { boxMarkerPath } : {}),
        });
        if (result?.skipped) {
            throw hostUpdateError(
                `Unable to update the host Ploinky checkout: ${result.reason || 'update was skipped'}`,
            );
        }
        return Object.freeze({ ...result, ...source });
    } finally {
        lock.release();
    }
}

/**
 * Pull a direct `<workspace>/ploinky` checkout while the exact workspace
 * mutation lock is held. The executable's own checkout is updated separately
 * before this transaction, so an identical path is deliberately not pulled a
 * second time.
 */
export function updateWorkspacePloinkySource({
    identity,
    lock,
    repositoryRoot,
    updateSelf = updatePloinkySelf,
    realpath = fs.realpathSync.native,
} = {}) {
    if (!identity?.workspaceRoot || !identity?.instance) {
        throw workspaceUpdateError('Workspace Ploinky update requires one exact workspace identity');
    }
    if (!lock || typeof lock.assertHeld !== 'function') {
        throw workspaceUpdateError('Workspace Ploinky update requires the workspace mutation lock');
    }
    lock.assertHeld(identity.instance);

    const repoPath = path.join(identity.workspaceRoot, 'ploinky');
    let stat;
    try {
        stat = fs.lstatSync(repoPath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return skippedWorkspaceUpdate(repoPath, 'workspace ploinky folder not found');
        }
        throw workspaceUpdateError(`Unable to inspect the workspace Ploinky path: ${repoPath}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return skippedWorkspaceUpdate(
            repoPath,
            'workspace ploinky path is not a real directory',
            { found: true },
        );
    }
    if (!isGitRepo(repoPath)) {
        return skippedWorkspaceUpdate(
            repoPath,
            'workspace ploinky folder is not a git repository',
            { found: true },
        );
    }

    let canonicalRepo;
    let canonicalHostSource;
    try {
        canonicalRepo = realpath(repoPath);
        canonicalHostSource = realpath(repositoryRoot);
    } catch (error) {
        throw workspaceUpdateError('Unable to resolve the workspace or host Ploinky checkout', error);
    }
    lock.assertHeld(identity.instance);
    if (canonicalRepo === canonicalHostSource) {
        return skippedWorkspaceUpdate(
            canonicalRepo,
            'workspace ploinky checkout is the host Ploinky checkout',
            { found: true, duplicateOfHost: true },
        );
    }

    let result;
    try {
        result = updateSelf({
            repoPath: canonicalRepo,
            interactiveSession: false,
        });
    } catch (error) {
        throw workspaceUpdateError(`Unable to update the workspace Ploinky checkout: ${canonicalRepo}`, error);
    }
    if (result?.skipped) {
        throw workspaceUpdateError(
            `Unable to update the workspace Ploinky checkout: ${result.reason || 'update was skipped'}`,
        );
    }
    return Object.freeze({
        ...result,
        found: true,
        repoPath: canonicalRepo,
        pullStrategy: 'rebase-autostash',
    });
}
