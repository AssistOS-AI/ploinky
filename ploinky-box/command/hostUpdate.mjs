import crypto from 'node:crypto';
import fs from 'node:fs';

import { updatePloinkySelf } from '../../cli/commands/updateService.js';
import { PloinkyBoxError } from '../errors.mjs';
import { createMutationLockManager } from '../locks.mjs';

function hostUpdateError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_HOST_UPDATE_FAILED',
        cause,
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
