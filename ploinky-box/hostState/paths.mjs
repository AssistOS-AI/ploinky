import fs from 'node:fs';
import path from 'node:path';

import { HOST_STATE_DIRECTORY_NAME } from '../constants.mjs';

// Path relations shared by the host-state guards: the Router-binding state
// confinement, the Box data-path confinement (D1), the nested-workspace
// refusal and the quiescence gate. Every comparison is made between resolved
// real paths; directory identities (dev:ino) additionally catch aliases that a
// realpath cannot distinguish, such as a second bind mount of one directory.

/**
 * The real path of `target`, resolving the nearest existing ancestor and
 * appending the missing tail. A dangling symlink is resolved through its
 * target, so a host-only directory that is created later is still judged by
 * where it will be.
 */
export function realpathOfNearestExisting(target, fsApi = fs) {
    const missing = [];
    let current = target;
    while (true) {
        try {
            return path.join(fsApi.realpathSync(current), ...missing);
        } catch (error) {
            const parent = path.dirname(current);
            if (error?.code !== 'ENOENT' || parent === current) throw error;
            // Resolve a dangling directory alias too: its host-only target may
            // be created later, after the Box has already mounted its parent.
            try {
                if (fsApi.lstatSync(current).isSymbolicLink()) {
                    const destination = path.resolve(parent, fsApi.readlinkSync(current));
                    return path.join(realpathOfNearestExisting(destination, fsApi), ...missing);
                }
            } catch (linkError) {
                if (linkError?.code !== 'ENOENT') throw linkError;
            }
            missing.unshift(path.basename(current));
            current = parent;
        }
    }
}

/** True when `child` is `parent` or lies below it. */
export function containsPath(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative));
}

/** True when `child` lies strictly below `parent`. */
export function strictlyInside(parent, child) {
    return parent !== child && containsPath(parent, child);
}

export function directoryIdentity(target, fsApi = fs) {
    try {
        const stat = fsApi.statSync(target);
        return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

export function ancestorDirectoryIdentities(target, fsApi = fs) {
    const identities = new Set();
    for (let current = target; ; current = path.dirname(current)) {
        const identity = directoryIdentity(current, fsApi);
        if (identity) identities.add(identity);
        if (path.dirname(current) === current) return identities;
    }
}

// The workspace may sit on a filesystem that matches names regardless of case
// or Unicode form (APFS, also through the Box's virtiofs mount), where
// `.PLOINKY-BOX` or `.ploinKy-box` (Kelvin sign) open the host-state
// directory. This is the one implementation of that fold: the Router's
// `foldWorkspaceName` (`cli/server/utils/protectedWorkspacePaths.js`) is this
// function, so this module must keep loading nothing from the Router.
export function foldPathName(name) {
    return String(name).normalize('NFKC').toLowerCase().replace(/[. ]+$/, '');
}

export const HOST_STATE_FOLDED_NAME = foldPathName(HOST_STATE_DIRECTORY_NAME);

/** True when any component of `target` folds to `.ploinky-box`. */
export function hasHostStateComponent(target) {
    return String(target).split(/[\\/]+/).some((segment) => segment && foldPathName(segment) === HOST_STATE_FOLDED_NAME);
}
