import fs from 'node:fs';
import path from 'node:path';

import {
    GPU_GRANT_STATE_DIRECTORY,
    HARDWARE_LIMITS_STATE_DIRECTORY,
    HOST_STATE_DIRECTORY_NAME,
    ROUTER_BINDING_STATE_DIRECTORY,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';

// Layout of `<workspace>/.ploinky-box`, the host-owned Box state directory.
// The skeleton is created non-recursively, tolerates concurrent creators, and
// is never removed by code: a masked Box keeps `.ploinky-box` and `empty/` as
// mount points, so the host must never rename or remove them.
export const HOST_STATE_ROOT_MODE = 0o700;
export const HOST_STATE_SKELETON = Object.freeze([
    Object.freeze({ name: 'locks', mode: 0o700 }),
    Object.freeze({ name: 'quarantine', mode: 0o700 }),
    // The read-only mask source bound over `.ploinky-box` in every Box.
    Object.freeze({ name: 'empty', mode: 0o555 }),
]);
export const WORKSPACE_LOCK_NAME = 'workspace.lock';
// Store directories created lazily, non-recursively, under the skeleton by the
// stores that own them.
export const HOST_STATE_STORE_DIRECTORIES = Object.freeze({
    routerBindings: ROUTER_BINDING_STATE_DIRECTORY,
    gpuGrants: GPU_GRANT_STATE_DIRECTORY,
    hardwareLimits: HARDWARE_LIMITS_STATE_DIRECTORY,
});
// One directory per update record kind (`update-journals/<name>.json`, ...).
export const HOST_STATE_UPDATE_KINDS = Object.freeze([
    'update-journals', 'update-pending', 'update-handoffs', 'update-recovery', 'update-exclusions',
]);
// Every name the host itself writes directly under `.ploinky-box`: the
// skeleton, the store directories, the host staging directory (`tmp/`) and the
// adoption record. This is an inventory, not a trust list: first-use
// quarantine (adoption.mjs) keeps only the skeleton and `tmp/`.
export const HOST_STATE_KNOWN_NAMES = Object.freeze([
    ...HOST_STATE_SKELETON.map((entry) => entry.name),
    ...Object.values(HOST_STATE_STORE_DIRECTORIES),
    ...HOST_STATE_UPDATE_KINDS,
    'tmp',
    'workspace.json',
]);

/**
 * The read-only mask every Box carries over its workspace's `.ploinky-box`:
 * the empty skeleton directory bound on top of it, after the workspace bind.
 */
export function hostStateMaskMount(workspaceRoot) {
    const paths = hostStatePaths(workspaceRoot);
    return Object.freeze({ source: paths.empty, destination: paths.root, rw: false });
}

export function hostStateMaskArgs(workspaceRoot) {
    const mask = hostStateMaskMount(workspaceRoot);
    return ['--volume', `${mask.source}:${mask.destination}:ro`];
}

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
        workspaceRecord: path.join(root, 'workspace.json'),
        workspaceLock: path.join(locks, WORKSPACE_LOCK_NAME),
        routerBindings: path.join(root, HOST_STATE_STORE_DIRECTORIES.routerBindings),
        gpuGrants: path.join(root, HOST_STATE_STORE_DIRECTORIES.gpuGrants),
        hardwareLimits: path.join(root, HOST_STATE_STORE_DIRECTORIES.hardwareLimits),
    });
}

/**
 * The host-state root that belongs to one exact workspace identity. Stores are
 * built from the identity, never from a home directory or a caller-supplied
 * root, so a hand-built or tampered identity cannot redirect them.
 */
export function identityHostStateRoot(identity, makeError = hostStateError) {
    const workspaceRoot = String(identity?.workspaceRoot || '');
    if (!path.isAbsolute(workspaceRoot) || identity?.hostStateRoot !== hostStateRootPath(workspaceRoot)) {
        throw makeError('Host state requires the exact workspace identity');
    }
    return identity.hostStateRoot;
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

// The workspace root itself may be reached through an alias symlink: every
// spelling of one directory must find the same `.ploinky-box`.
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
// validated here, never re-moded; the one exception is the root's group and
// other bits, removed by `tightenHostStateRoot` during first-use adoption,
// behind the quiescence gate and before every pre-existing entry is
// quarantined, so no earlier untrusted state is hidden by it.
function validateComponent(directory, { uid, mode, readOnly = false, mustBeEmpty = false }, fsApi) {
    const stat = fsApi.lstatSync(directory);
    const fix = `Inspect ${directory}; it must be a private directory owned by you`;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw hostStateError(`Host state path is not a real directory: ${directory}. ${fix}.`);
    }
    if (uid !== null && stat.uid !== uid) {
        throw hostStateError(`Host state directory is not owned by the current user: ${directory}. ${fix}.`);
    }
    if ((stat.mode & (readOnly ? 0o222 : 0o022)) !== 0) {
        throw hostStateError(`Host state directory has unsafe write permissions: ${directory}. After checking that `
            + `its contents belong to you, run \`chmod ${mode.toString(8)} ${directory}\`.`);
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
 * `.ploinky-box` (a recreated workspace must start from a fresh skeleton).
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
    validateComponent(paths.root, { uid, mode: HOST_STATE_ROOT_MODE }, fsApi);
    for (const entry of HOST_STATE_SKELETON) {
        const directory = path.join(paths.root, entry.name);
        makeComponent(directory, entry.mode, fsApi);
        validateComponent(directory, {
            uid,
            mode: entry.mode,
            readOnly: entry.mode === 0o555,
            mustBeEmpty: entry.name === 'empty',
        }, fsApi);
    }
    return Object.freeze({ ...paths, created });
}

/**
 * Read-only validation of an existing skeleton. Returns `{ present: false }`
 * when `.ploinky-box` is absent and throws when anything present is invalid.
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
    validateComponent(paths.root, { uid, mode: HOST_STATE_ROOT_MODE }, fsApi);
    let complete = true;
    for (const entry of HOST_STATE_SKELETON) {
        const directory = path.join(paths.root, entry.name);
        try {
            validateComponent(directory, {
                uid,
                mode: entry.mode,
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

/**
 * Removes the group and other bits of an existing `.ploinky-box` that this
 * user owns, so that the private update records below it can be kept there.
 * The skeleton accepts a root that only lacks group and other write bits (an
 * earlier Ploinky could leave it 0755); the stores require it private. Only
 * first-use adoption calls this, under the held workspace lock and after the
 * quiescence gate passed, so nothing else can swap the directory meanwhile.
 * The mode is changed through a descriptor opened without following links,
 * and only when that descriptor is the directory `lstat` saw: a symlink, a
 * non-directory or a directory owned by anyone else is refused unchanged.
 *
 * @returns {boolean} whether the mode was changed
 */
export function tightenHostStateRoot(workspaceRoot, { fsApi = fs, uid = currentUid() } = {}) {
    const { root } = hostStatePaths(workspaceRoot);
    const fix = `Inspect ${root}; it must be a private directory owned by you`;
    const expect = (stat, label) => {
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw hostStateError(`Host state path is not a real directory${label}: ${root}. ${fix}.`);
        }
        if (uid !== null && stat.uid !== uid) {
            throw hostStateError(`Host state directory is not owned by the current user${label}: ${root}. ${fix}.`);
        }
    };
    const seen = fsApi.lstatSync(root);
    expect(seen, '');
    if ((seen.mode & 0o077) === 0) return false;
    const same = (stat) => stat.dev === seen.dev && stat.ino === seen.ino;
    const descriptor = fsApi.openSync(root,
        fsApi.constants.O_RDONLY | fsApi.constants.O_DIRECTORY | fsApi.constants.O_NOFOLLOW);
    try {
        const opened = fsApi.fstatSync(descriptor);
        expect(opened, ' when opened');
        if (!same(opened)) throw hostStateError(`Host state directory changed while it was opened: ${root}. ${fix}.`);
        fsApi.fchmodSync(descriptor, opened.mode & 0o7777 & ~0o077);
        if ((fsApi.fstatSync(descriptor).mode & 0o077) !== 0) {
            throw hostStateError(`Host state directory could not be made private: ${root}. ${fix}.`);
        }
    } finally {
        fsApi.closeSync(descriptor);
    }
    const after = fsApi.lstatSync(root);
    expect(after, ' after its mode was changed');
    if (!same(after) || (after.mode & 0o077) !== 0) {
        throw hostStateError(`Host state directory changed while its mode was changed: ${root}. ${fix}.`);
    }
    return true;
}
