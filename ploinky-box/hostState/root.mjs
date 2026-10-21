import fs from 'node:fs';
import path from 'node:path';

import { HOST_STATE_DIRECTORY_NAME } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';

// Layout of `<workspace>/.ploinky-host`, the host-owned Box state directory.
// The skeleton is created non-recursively, tolerates concurrent creators, and
// is never removed by code: a masked Box keeps `.ploinky-host` and `empty/` as
// mount points, so the host must never rename or remove them.
export const HOST_STATE_ROOT_MODE = 0o700;
export const HOST_STATE_SKELETON = Object.freeze([
    Object.freeze({ name: 'locks', mode: 0o700 }),
    Object.freeze({ name: 'quarantine', mode: 0o700 }),
    // The read-only mask source bound over `.ploinky-host` in every Box.
    Object.freeze({ name: 'empty', mode: 0o555 }),
]);
// Names a hygiene scan must never quarantine by name: the skeleton, the host
// staging directory (`tmp/`) and the trust latch marker (`latch.json`).
export const HOST_STATE_KNOWN_NAMES = Object.freeze([
    ...HOST_STATE_SKELETON.map((entry) => entry.name),
    'tmp',
    'latch.json',
]);
export const WORKSPACE_LOCK_NAME = 'workspace.lock';

export function hostStateError(message, code = 'PLOINKY_BOX_HOST_STATE_INVALID', cause) {
    return new PloinkyBoxError(message, { code, cause });
}

export function hostStateRootPath(workspaceRoot) {
    return path.join(workspaceRoot, HOST_STATE_DIRECTORY_NAME);
}

export function hostStatePaths(workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
        throw hostStateError('The host state directory requires an absolute workspace root',
            'PLOINKY_BOX_LOCK_WORKSPACE_REQUIRED');
    }
    const root = hostStateRootPath(workspaceRoot);
    const locks = path.join(root, 'locks');
    return Object.freeze({
        workspaceRoot,
        root,
        locks,
        quarantine: path.join(root, 'quarantine'),
        empty: path.join(root, 'empty'),
        tmp: path.join(root, 'tmp'),
        latch: path.join(root, 'latch.json'),
        workspaceLock: path.join(locks, WORKSPACE_LOCK_NAME),
    });
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

// The workspace root itself may be reached through an alias symlink: every
// spelling of one directory must find the same `.ploinky-host`.
function assertWorkspaceRootDirectory(workspaceRoot, fsApi) {
    let stat;
    try {
        stat = fsApi.statSync(workspaceRoot);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw hostStateError(`The workspace directory does not exist: ${workspaceRoot}`,
                'PLOINKY_BOX_WORKSPACE_ABSENT', error);
        }
        throw error;
    }
    if (!stat.isDirectory()) {
        throw hostStateError(`The workspace path is not a directory: ${workspaceRoot}`,
            'PLOINKY_BOX_WORKSPACE_INVALID');
    }
}

// Every component below the workspace root must be a real directory owned by
// the invoking user that nobody else can write. Existing directories are only
// validated, never re-moded, so earlier untrusted state is not hidden.
function validateComponent(directory, { uid, readOnly = false, mustBeEmpty = false }, fsApi) {
    const stat = fsApi.lstatSync(directory);
    const fix = `Inspect ${directory}; it must be a private directory owned by you`;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw hostStateError(`Host state path is not a real directory: ${directory}. ${fix}.`);
    }
    if (uid !== null && stat.uid !== uid) {
        throw hostStateError(`Host state directory is not owned by the current user: ${directory}. ${fix}.`);
    }
    if ((stat.mode & (readOnly ? 0o222 : 0o022)) !== 0) {
        throw hostStateError(`Host state directory has unsafe write permissions: ${directory}. ${fix}.`);
    }
    if (mustBeEmpty && fsApi.readdirSync(directory).length !== 0) {
        throw hostStateError(`Host state mask source must be empty: ${directory}. ${fix}, then empty it.`);
    }
    return stat;
}

function makeComponent(directory, mode, fsApi) {
    try {
        fsApi.mkdirSync(directory, { recursive: false, mode });
    } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
    // A directory this call created is still private to it: apply the exact
    // mode that the umask may have narrowed.
    fsApi.chmodSync(directory, mode);
    return true;
}

/**
 * Creates any missing skeleton directory and validates every one. The parent
 * workspace root must already exist. `requireNew` refuses a pre-existing
 * `.ploinky-host` (a recreated workspace must start from a fresh skeleton).
 * An ENOENT raised while creating a child means a concurrent removal; it is
 * passed through so that callers can retry.
 */
export function ensureHostStateSkeleton(workspaceRoot, {
    fsApi = fs,
    uid = currentUid(),
    requireNew = false,
} = {}) {
    const paths = hostStatePaths(workspaceRoot);
    assertWorkspaceRootDirectory(workspaceRoot, fsApi);
    const created = makeComponent(paths.root, HOST_STATE_ROOT_MODE, fsApi);
    if (!created && requireNew) {
        throw hostStateError(
            `The recreated workspace already contains ${HOST_STATE_DIRECTORY_NAME}: ${paths.root}`,
            'PLOINKY_BOX_HOST_STATE_NOT_NEW',
        );
    }
    validateComponent(paths.root, { uid }, fsApi);
    for (const entry of HOST_STATE_SKELETON) {
        const directory = path.join(paths.root, entry.name);
        makeComponent(directory, entry.mode, fsApi);
        validateComponent(directory, {
            uid,
            readOnly: entry.mode === 0o555,
            mustBeEmpty: entry.name === 'empty',
        }, fsApi);
    }
    return Object.freeze({ ...paths, created });
}

/**
 * Read-only validation of an existing skeleton. Returns `{ present: false }`
 * when `.ploinky-host` is absent and throws when anything present is invalid.
 */
export function inspectHostStateSkeleton(workspaceRoot, { fsApi = fs, uid = currentUid() } = {}) {
    const paths = hostStatePaths(workspaceRoot);
    assertWorkspaceRootDirectory(workspaceRoot, fsApi);
    try {
        fsApi.lstatSync(paths.root);
    } catch (error) {
        if (error?.code === 'ENOENT') return Object.freeze({ ...paths, present: false, complete: false });
        throw error;
    }
    validateComponent(paths.root, { uid }, fsApi);
    let complete = true;
    for (const entry of HOST_STATE_SKELETON) {
        const directory = path.join(paths.root, entry.name);
        try {
            validateComponent(directory, {
                uid,
                readOnly: entry.mode === 0o555,
                mustBeEmpty: entry.name === 'empty',
            }, fsApi);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            complete = false;
        }
    }
    return Object.freeze({ ...paths, present: true, complete });
}
