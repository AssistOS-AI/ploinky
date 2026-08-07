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
        symlinkTarget: stat.isSymbolicLink() ? readlinkSync(root) : null,
    };
}

function rootFingerprintsEqual(left, right) {
    return left.device === right.device
        && left.inode === right.inode
        && left.mode === right.mode
        && left.symlinkTarget === right.symlinkTarget;
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
    const pathHash = workspacePathHash(selectedRoot);
    const slug = workspaceSlug(selectedRoot);
    const instance = `ploinky-box-${slug}-${pathHash}`;
    return Object.freeze({
        workspaceRoot: selectedRoot,
        markerFound,
        pathHash,
        slug,
        instance,
        anchorPath: path.join(selectedRoot, '.ploinky'),
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
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: false, directory: false, symlink: false };
        }
        throw error;
    }
}

export function materializeIdentityAnchor(identity, lock, {
    lstatSync = fs.lstatSync,
    readlinkSync = fs.readlinkSync,
    mkdirSync = fs.mkdirSync,
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
        return { created: false, path: identity.anchorPath };
    }

    try {
        mkdirSync(identity.anchorPath, { recursive: false });
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
    const finalRoot = captureRootFingerprint(
        identity.workspaceRoot,
        lstatSync,
        readlinkSync,
    );
    if (!rootFingerprintsEqual(identity.rootFingerprint, finalRoot)) {
        throw new WorkspaceResolutionError('Workspace root changed during identity anchor creation');
    }
    return { created: true, path: identity.anchorPath };
}

export const __MISSING_CWD_MESSAGE = MISSING_CWD_MESSAGE;
