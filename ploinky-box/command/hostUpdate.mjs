import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    pathContains,
    resolvePloinkyUpdateEligibility,
    resolvePloinkyUpdateScope,
} from '../../cli/commands/ploinkyUpdateScope.js';
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

function workspaceCheckoutBoxPath(canonicalWorkspace, canonicalRepo) {
    if (!pathContains(canonicalWorkspace, canonicalRepo)) {
        throw workspaceUpdateError('Selected Ploinky checkout escaped the locked workspace');
    }
    const relative = path.relative(canonicalWorkspace, canonicalRepo);
    return relative
        ? path.posix.join('/workspace', ...relative.split(path.sep))
        : '/workspace';
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
    const lock = await lockManager.acquire(source.lockIdentity);
    try {
        lock.assertHeld(source.lockIdentity);
        const result = updateSelf({
            repoPath: source.canonicalRoot,
            updateScopePath: scope.scopeRoot,
            interactiveSession: false,
            ...(boxMarkerPath ? { boxMarkerPath } : {}),
        });
        if (result?.skipped) {
            throw hostUpdateError(
                `Unable to update the host Ploinky checkout: ${result.reason || 'update was skipped'}`,
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
 * Pull a Ploinky checkout selected by the command's canonical update folder
 * while the exact workspace mutation lock is held. A checkout containing that
 * folder, or a direct `<folder>/ploinky` checkout, is eligible. The executable's
 * own checkout is updated separately, so an identical path is not pulled twice.
 */
export function updateWorkspacePloinkySource({
    identity,
    lock,
    repositoryRoot,
    updateScopeRoot,
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
                boxRepoPath: workspaceCheckoutBoxPath(canonicalWorkspace, canonicalRepo),
            },
        );
    }

    let result;
    try {
        result = updateSelf({
            repoPath: canonicalRepo,
            updateScopePath: canonicalScope,
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
        updateScopeRoot: canonicalScope,
        boxRepoPath: workspaceCheckoutBoxPath(canonicalWorkspace, canonicalRepo),
        pullStrategy: 'rebase-autostash',
    });
}
