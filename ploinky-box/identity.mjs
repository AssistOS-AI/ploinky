import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    BOX_DATA_KEYS,
    BOX_DATA_RELATIVE_NAMES,
    BOX_DATA_ROOT_NAME,
} from './constants.mjs';
import { PloinkyBoxError } from './errors.mjs';

const MISSING_CWD_MESSAGE = [
    'Ploinky could not determine the current directory because it no longer exists.',
    'Change into an existing directory and run the command again, for example:',
    '  cd ..',
    '  cd -P <workspace>',
].join('\n');

export class WorkspaceResolutionError extends PloinkyBoxError {
    constructor(message, options = {}) {
        super(message, {
            ...options,
            code: options.code ?? 'PLOINKY_BOX_WORKSPACE_RESOLUTION_FAILED',
        });
    }
}

function isDirectory(statPath, statSync) {
    try {
        return statSync(statPath).isDirectory();
    } catch {
        return false;
    }
}

function captureRootFingerprint(root, lstatSync, readlinkSync) {
    const stat = lstatSync(root);
    return {
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: stat.mode,
        uid: stat.uid,
        directory: stat.isDirectory(),
        symlinkTarget: stat.isSymbolicLink() ? readlinkSync(root) : null,
    };
}

function rootFingerprintsEqual(left, right) {
    return left.device === right.device
        && left.inode === right.inode
        && left.mode === right.mode
        && left.uid === right.uid
        && left.directory === right.directory
        && left.symlinkTarget === right.symlinkTarget;
}

function captureAnchorFingerprint(anchorPath, lstatSync, readlinkSync) {
    try {
        return captureRootFingerprint(anchorPath, lstatSync, readlinkSync);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

export function workspaceSlug(workspaceRoot) {
    const basename = path.basename(workspaceRoot).toLowerCase();
    return basename
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 20)
        .replace(/-+$/g, '') || 'box';
}

export function workspacePathHash(workspaceRoot) {
    return crypto.createHash('sha256')
        .update(workspaceRoot)
        .digest('hex')
        .slice(0, 12);
}

export function buildWorkspaceIdentity(workspaceRoot, {
    markerFound = false,
    lstatSync = fs.lstatSync,
    readlinkSync = fs.readlinkSync,
} = {}) {
    const selectedRoot = path.resolve(workspaceRoot);
    const anchorPath = path.join(selectedRoot, '.ploinky');
    const pathHash = workspacePathHash(selectedRoot);
    const slug = workspaceSlug(selectedRoot);
    const instance = `ploinky-box-${slug}-${pathHash}`;
    return Object.freeze({
        workspaceRoot: selectedRoot,
        markerFound,
        pathHash,
        slug,
        instance,
        anchorPath,
        anchorFingerprint: Object.freeze(captureAnchorFingerprint(
            anchorPath,
            lstatSync,
            readlinkSync,
        )),
        boxDataRoot: path.join(selectedRoot, '.ploinky', BOX_DATA_ROOT_NAME),
        dataPaths: Object.freeze(Object.fromEntries(BOX_DATA_KEYS.map((key) => [
            key,
            path.join(selectedRoot, '.ploinky', BOX_DATA_ROOT_NAME, BOX_DATA_RELATIVE_NAMES[key]),
        ]))),
        rootFingerprint: Object.freeze(captureRootFingerprint(
            selectedRoot,
            lstatSync,
            readlinkSync,
        )),
    });
}

export function resolveWorkspaceIdentity({
    env = process.env,
    cwd = () => process.cwd(),
    statSync = fs.statSync,
    lstatSync = fs.lstatSync,
    readlinkSync = fs.readlinkSync,
} = {}) {
    const explicitRoot = String(env.PLOINKY_WORKSPACE_ROOT || '').trim();
    if (explicitRoot) {
        const normalizedExplicit = path.resolve(explicitRoot);
        if (isDirectory(normalizedExplicit, statSync)) {
            return buildWorkspaceIdentity(normalizedExplicit, {
                markerFound: isDirectory(path.join(normalizedExplicit, '.ploinky'), statSync),
                lstatSync,
                readlinkSync,
            });
        }
    }

    let launchDirectory;
    try {
        launchDirectory = path.resolve(cwd());
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new WorkspaceResolutionError(MISSING_CWD_MESSAGE, { cause: error });
        }
        throw error;
    }

    let current = launchDirectory;
    while (true) {
        if (isDirectory(path.join(current, '.ploinky'), statSync)) {
            return buildWorkspaceIdentity(current, {
                markerFound: true,
                lstatSync,
                readlinkSync,
            });
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return buildWorkspaceIdentity(launchDirectory, {
        markerFound: false,
        lstatSync,
        readlinkSync,
    });
}

function inspectAnchor(anchorPath, lstatSync) {
    try {
        const stat = lstatSync(anchorPath);
        return {
            exists: true,
            directory: stat.isDirectory(),
            symlink: stat.isSymbolicLink(),
            stat,
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: false, directory: false, symlink: false };
        }
        throw error;
    }
}


function assertCurrentUserOwnedDirectory(target, stat, uid, label) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new WorkspaceResolutionError(`${label} is not a real directory: ${target}`);
    }
    if (Number.isInteger(uid) && stat.uid !== uid) {
        throw new WorkspaceResolutionError(`${label} is not owned by the current user: ${target}`);
    }
}

function descriptorFingerprint(stat) {
    return Object.freeze({
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: stat.mode,
        uid: stat.uid,
        directory: stat.isDirectory(),
        symlinkTarget: null,
    });
}

function normalizePinnedDirectory(target, {
    expectedFingerprint,
    desiredMode,
    label,
    fsApi,
    lstatSync,
    uid,
}) {
    const constants = fsApi.constants || fs.constants;
    const flags = (constants.O_RDONLY || 0)
        | (constants.O_DIRECTORY || 0)
        | (constants.O_NOFOLLOW || 0);
    let descriptor;
    try {
        descriptor = fsApi.openSync(target, flags);
    } catch (error) {
        throw new WorkspaceResolutionError(`${label} could not be opened safely: ${target}`, {
            cause: error,
        });
    }
    try {
        const opened = fsApi.fstatSync(descriptor);
        assertCurrentUserOwnedDirectory(target, opened, uid, label);
        const openedFingerprint = descriptorFingerprint(opened);
        if (!expectedFingerprint
            || !rootFingerprintsEqual(expectedFingerprint, openedFingerprint)) {
            throw new WorkspaceResolutionError(`${label} changed before permission normalization: ${target}`);
        }

        const namedBefore = lstatSync(target);
        assertCurrentUserOwnedDirectory(target, namedBefore, uid, label);
        if (String(namedBefore.dev) !== openedFingerprint.device
            || String(namedBefore.ino) !== openedFingerprint.inode) {
            throw new WorkspaceResolutionError(`${label} was replaced during validation: ${target}`);
        }

        fsApi.fchmodSync(descriptor, desiredMode);
        const normalized = fsApi.fstatSync(descriptor);
        assertCurrentUserOwnedDirectory(target, normalized, uid, label);
        if ((normalized.mode & 0o7777) !== desiredMode
            || normalized.dev !== opened.dev
            || normalized.ino !== opened.ino) {
            throw new WorkspaceResolutionError(`${label} permissions changed unexpectedly: ${target}`);
        }
        const namedAfter = lstatSync(target);
        assertCurrentUserOwnedDirectory(target, namedAfter, uid, label);
        if (namedAfter.dev !== normalized.dev
            || namedAfter.ino !== normalized.ino
            || namedAfter.mode !== normalized.mode
            || namedAfter.uid !== normalized.uid) {
            throw new WorkspaceResolutionError(`${label} was replaced during permission normalization: ${target}`);
        }
        return descriptorFingerprint(normalized);
    } finally {
        try { fsApi.closeSync(descriptor); } catch {}
    }
}

export function materializeIdentityAnchor(identity, lock, {
    fsApi = fs,
    lstatSync = fsApi.lstatSync,
    readlinkSync = fsApi.readlinkSync,
    mkdirSync = fsApi.mkdirSync,
    uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
} = {}) {
    lock?.assertHeld?.(identity.instance);
    if (!lock || typeof lock.assertHeld !== 'function') {
        throw new PloinkyBoxError('Workspace identity anchor creation requires its mutation lock', {
            code: 'PLOINKY_BOX_LOCK_REQUIRED',
        });
    }

    const currentRoot = captureRootFingerprint(
        identity.workspaceRoot,
        lstatSync,
        readlinkSync,
    );
    if (!rootFingerprintsEqual(identity.rootFingerprint, currentRoot)) {
        throw new WorkspaceResolutionError('Workspace root changed before identity anchor creation');
    }

    const before = inspectAnchor(identity.anchorPath, lstatSync);
    if (before.exists) {
        if (!before.directory || before.symlink) {
            throw new WorkspaceResolutionError(
                `Workspace identity anchor is not a directory: ${identity.anchorPath}`,
            );
        }
        if (!identity.anchorFingerprint
            || !rootFingerprintsEqual(identity.anchorFingerprint, descriptorFingerprint(before.stat))) {
            throw new WorkspaceResolutionError(
                `Workspace identity anchor changed before permission normalization: ${identity.anchorPath}`,
            );
        }
    } else if (identity.anchorFingerprint) {
        throw new WorkspaceResolutionError(
            `Workspace identity anchor disappeared before creation: ${identity.anchorPath}`,
        );
    }

    assertCurrentUserOwnedDirectory(
        identity.workspaceRoot,
        lstatSync(identity.workspaceRoot),
        uid,
        'Workspace root',
    );
    const rootMode = (currentRoot.mode & 0o7777) & ~0o022;
    const rootFingerprint = normalizePinnedDirectory(identity.workspaceRoot, {
        expectedFingerprint: currentRoot,
        desiredMode: rootMode,
        label: 'Workspace root',
        fsApi,
        lstatSync,
        uid,
    });

    let created = false;
    if (!before.exists) {
        try {
            mkdirSync(identity.anchorPath, { recursive: false, mode: 0o700 });
            created = true;
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw new WorkspaceResolutionError(
                    `Workspace identity anchor changed concurrently: ${identity.anchorPath}`,
                    { cause: error },
                );
            }
            throw error;
        }

        const after = inspectAnchor(identity.anchorPath, lstatSync);
        if (!after.exists || !after.directory || after.symlink) {
            throw new WorkspaceResolutionError(
                `Workspace identity anchor was replaced during creation: ${identity.anchorPath}`,
            );
        }
    }

    const anchorObserved = captureAnchorFingerprint(identity.anchorPath, lstatSync, readlinkSync);
    const anchorFingerprint = normalizePinnedDirectory(identity.anchorPath, {
        expectedFingerprint: anchorObserved,
        desiredMode: 0o700,
        label: 'Workspace identity anchor',
        fsApi,
        lstatSync,
        uid,
    });
    const finalRoot = captureRootFingerprint(
        identity.workspaceRoot,
        lstatSync,
        readlinkSync,
    );
    if (!rootFingerprintsEqual(rootFingerprint, finalRoot)) {
        throw new WorkspaceResolutionError('Workspace root changed during identity anchor creation');
    }
    return Object.freeze({
        created,
        path: identity.anchorPath,
        rootFingerprint,
        anchorFingerprint,
    });
}

export const __MISSING_CWD_MESSAGE = MISSING_CWD_MESSAGE;
