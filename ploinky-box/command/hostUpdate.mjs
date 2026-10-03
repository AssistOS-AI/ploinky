import fs from 'node:fs';
import path from 'node:path';

import {
    pathContains,
    resolvePloinkyUpdateEligibility,
    resolvePloinkyUpdateScope,
} from '../../cli/commands/ploinkyUpdateScope.js';
import { isGitRepo, updatePloinkySelf } from '../../cli/commands/updateService.js';
import { GIT_UPDATE_STRATEGY } from '../../cli/utils/git/verifiedUpdate.js';
import { acquireSourceLock, ploinkySourceLockIdentity } from '../../cli/utils/git/sourceLock.js';
import { boxWorkspacePath } from '../contract/workspace-root.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createMutationLockManager } from '../locks.mjs';

// Both writers keep the operation record of a non-verified Git update on the
// thrown error so the caller can report the exact named outcome.
function withRecord(error, record) {
    if (record) error.record = record;
    return error;
}

function hostUpdateError(message, cause, record = cause?.record) {
    return withRecord(new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_HOST_UPDATE_FAILED',
        cause,
    }), record);
}

function workspaceUpdateError(message, cause, record = cause?.record) {
    return withRecord(new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_WORKSPACE_PLOINKY_UPDATE_FAILED',
        cause,
    }), record);
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

// Containment is proven on canonical paths; the Box path keeps the selected
// workspace spelling, which is where the Box mounts the workspace.
function workspaceCheckoutBoxPath(workspaceRoot, canonicalWorkspace, canonicalRepo) {
    if (!pathContains(canonicalWorkspace, canonicalRepo)) {
        throw workspaceUpdateError('Selected Ploinky checkout escaped the locked workspace');
    }
    const relative = path.relative(canonicalWorkspace, canonicalRepo);
    return boxWorkspacePath(workspaceRoot, relative.split(path.sep).join('/'));
}

export function hostSourceLockIdentity(repositoryRoot, {
    realpath = fs.realpathSync.native,
} = {}) {
    try {
        return ploinkySourceLockIdentity(repositoryRoot, { realpath });
    } catch (error) {
        throw hostUpdateError(`Unable to resolve the host Ploinky checkout: ${repositoryRoot}`, error);
    }
}

export async function updateHostPloinkySource({
    repositoryRoot,
    updateScopeRoot,
    lockManager = createMutationLockManager(),
    updateSelf = updatePloinkySelf,
    boxMarkerPath,
    realpath,
} = {}) {
    const source = hostSourceLockIdentity(repositoryRoot, { realpath });
    let scope;
    try {
        scope = resolvePloinkyUpdateEligibility({
            repoPath: source.canonicalRoot,
            updateScopePath: updateScopeRoot,
            ...(realpath ? { realpath } : {}),
        });
    } catch (error) {
        throw hostUpdateError('Unable to resolve the Ploinky update folder', error);
    }
    if (!scope.eligible) {
        return Object.freeze({
            found: true,
            updated: false,
            skipped: true,
            scopeExcluded: true,
            reason: scope.reason,
            repoPath: source.canonicalRoot,
            updateScopeRoot: scope.scopeRoot,
            ...source,
        });
    }
    const lock = await acquireSourceLock(lockManager, source.lockIdentity);
    try {
        lock.assertHeld(source.lockIdentity);
        let result;
        try {
            // The source lock is already held here; the self-update reuses it
            // instead of re-acquiring it, and it is released below before any
            // relaunch or workspace lock acquisition by the caller.
            result = await updateSelf({
                repoPath: source.canonicalRoot,
                updateScopePath: scope.scopeRoot,
                interactiveSession: false,
                phase: 'host-ploinky',
                heldSourceLock: { lockIdentity: source.lockIdentity, lock },
                ...(boxMarkerPath ? { boxMarkerPath } : {}),
            });
        } catch (error) {
            throw hostUpdateError(`Unable to update the host Ploinky checkout: ${error?.message || error}`, error);
        }
        if (result?.skipped) {
            throw hostUpdateError(
                `Unable to update the host Ploinky checkout: ${result.reason || 'update was skipped'}`,
                undefined,
                result.record,
            );
        }
        return Object.freeze({
            ...result,
            ...source,
            updateScopeRoot: scope.scopeRoot,
        });
    } finally {
        lock.release();
    }
}

export function isPloinkySourceCheckout(repoPath, {
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
} = {}) {
    if (!isGitRepo(repoPath)) return false;
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    } catch (_) {
        return false;
    }
    return manifest?.name === 'ploinky-cloud'
        && manifest?.bin?.ploinky === './bin/ploinky'
        && existsSync(path.join(repoPath, 'bin', 'ploinky'))
        && existsSync(path.join(repoPath, 'ploinky-box', 'bin', 'ploinky-box.mjs'));
}

/**
 * Select a workspace Ploinky checkout without executing its Git config on the
 * host. The Box can write this checkout's hooks, filters and transport helpers;
 * its Git operation therefore belongs to the in-Box update. The executable's
 * explicitly selected source is handled separately by the trusted host writer.
 */
export async function updateWorkspacePloinkySource({
    identity,
    lock,
    repositoryRoot,
    updateScopeRoot,
    realpath = fs.realpathSync.native,
} = {}) {
    if (!identity?.workspaceRoot || !identity?.instance) {
        throw workspaceUpdateError('Workspace Ploinky update requires one exact workspace identity');
    }
    if (!lock || typeof lock.assertHeld !== 'function') {
        throw workspaceUpdateError('Workspace Ploinky update requires the workspace mutation lock');
    }
    lock.assertHeld(identity.instance);

    let canonicalWorkspace;
    let canonicalScope;
    try {
        canonicalWorkspace = realpath(identity.workspaceRoot);
        canonicalScope = resolvePloinkyUpdateScope(
            updateScopeRoot || identity.workspaceRoot,
            { realpath },
        );
    } catch (error) {
        throw workspaceUpdateError('Unable to resolve the workspace or Ploinky update folder', error);
    }

    let selectionRoot;
    if (pathContains(canonicalWorkspace, canonicalScope)) {
        selectionRoot = canonicalScope;
    } else if (pathContains(canonicalScope, canonicalWorkspace)) {
        selectionRoot = canonicalWorkspace;
    } else {
        return skippedWorkspaceUpdate(
            path.join(canonicalWorkspace, 'ploinky'),
            `selected update folder ${canonicalScope} does not include this workspace`,
            { scopeExcluded: true, updateScopeRoot: canonicalScope },
        );
    }

    let repoPath = null;
    let current = selectionRoot;
    while (pathContains(canonicalWorkspace, current)) {
        if (isPloinkySourceCheckout(current)) {
            repoPath = current;
            break;
        }
        if (current === canonicalWorkspace) break;
        current = path.dirname(current);
    }

    if (!repoPath) repoPath = path.join(selectionRoot, 'ploinky');
    let stat;
    try {
        stat = fs.lstatSync(repoPath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return skippedWorkspaceUpdate(
                repoPath,
                'selected update folder does not contain a Ploinky checkout',
                { updateScopeRoot: canonicalScope },
            );
        }
        throw workspaceUpdateError(`Unable to inspect the workspace Ploinky path: ${repoPath}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return skippedWorkspaceUpdate(
            repoPath,
            'selected Ploinky path is not a real directory',
            { found: true, updateScopeRoot: canonicalScope },
        );
    }
    if (!isPloinkySourceCheckout(repoPath)) {
        return skippedWorkspaceUpdate(
            repoPath,
            'selected path is not a Ploinky source checkout',
            { found: true, updateScopeRoot: canonicalScope },
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
            {
                found: true,
                duplicateOfHost: true,
                updateScopeRoot: canonicalScope,
                boxRepoPath: workspaceCheckoutBoxPath(identity.workspaceRoot, canonicalWorkspace, canonicalRepo),
            },
        );
    }

    return Object.freeze({
        found: true,
        updated: false,
        deferredToCore: true,
        repoPath: canonicalRepo,
        updateScopeRoot: canonicalScope,
        // This is an inclusion, never the exclusion used for a checkout the
        // host already updated. Core deduplicates it with ordinary discovery.
        delegatedBoxRepoPath: workspaceCheckoutBoxPath(identity.workspaceRoot, canonicalWorkspace, canonicalRepo),
        pullStrategy: GIT_UPDATE_STRATEGY,
    });
}
