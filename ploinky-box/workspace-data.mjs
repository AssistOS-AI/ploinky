import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BOX_DATA_KEYS, BOX_DATA_MOUNTS } from './constants.mjs';
import { PloinkyBoxError } from './errors.mjs';

function workspaceDataError(message, code = 'PLOINKY_BOX_WORKSPACE_DATA_FAILED', cause) {
    return new PloinkyBoxError(message, { code, cause });
}

function assertLock(lock, identity) {
    if (!lock || typeof lock.assertHeld !== 'function') {
        throw workspaceDataError(
            'Workspace Box data mutation requires the Box mutation lock',
            'PLOINKY_BOX_LOCK_REQUIRED',
        );
    }
    lock.assertHeld(identity.instance);
}

function inspectPath(target, fsApi) {
    try {
        const stat = fsApi.lstatSync(target);
        return {
            exists: true,
            directory: stat.isDirectory(),
            symlink: stat.isSymbolicLink(),
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: false, directory: false, symlink: false };
        }
        throw workspaceDataError(`Unable to inspect Box data path: ${target}`, undefined, error);
    }
}

function fingerprint(stat) {
    return crypto.createHash('sha256')
        .update(String(stat.dev))
        .update('\0')
        .update(String(stat.ino))
        .digest('hex');
}

function directoryIdentityFingerprint(stat) {
    return Object.freeze({
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: stat.mode,
        uid: stat.uid,
        directory: stat.isDirectory(),
        symlinkTarget: null,
    });
}

function sameIdentityFingerprint(expected, observed) {
    return expected
        && observed
        && expected.device === observed.device
        && expected.inode === observed.inode
        && expected.mode === observed.mode
        && expected.uid === observed.uid
        && expected.directory === observed.directory
        && expected.symlinkTarget === observed.symlinkTarget;
}

function inspectDirectory(target, fsApi, {
    missing = 'Box data directory is missing',
    invalid = 'Box data path is not a real directory',
    code = 'PLOINKY_BOX_WORKSPACE_DATA_FAILED',
} = {}) {
    let stat;
    try {
        stat = fsApi.lstatSync(target);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw workspaceDataError(`${missing}: ${target}`, code, error);
        }
        throw workspaceDataError(`Unable to inspect Box data path: ${target}`, code, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw workspaceDataError(`${invalid}: ${target}`, code);
    }
    return Object.freeze({
        path: target,
        fingerprint: fingerprint(stat),
        identityFingerprint: directoryIdentityFingerprint(stat),
    });
}

function assertWorkspaceRoot(identity, fsApi, code = 'PLOINKY_BOX_WORKSPACE_DATA_FAILED') {
    let stat;
    try {
        stat = fsApi.lstatSync(identity.workspaceRoot);
    } catch (error) {
        throw workspaceDataError(
            `Unable to revalidate workspace root: ${identity.workspaceRoot}`,
            code,
            error,
        );
    }
    const observed = {
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: stat.mode,
        uid: stat.uid,
        directory: stat.isDirectory(),
        symlinkTarget: stat.isSymbolicLink() ? fsApi.readlinkSync(identity.workspaceRoot) : null,
    };
    const expected = identity.rootFingerprint;
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (stat.isSymbolicLink()
        || !stat.isDirectory()
        || (uid !== null && stat.uid !== uid)
        || (stat.mode & 0o022) !== 0
        || !sameIdentityFingerprint(expected, observed)) {
        throw workspaceDataError(
            `Workspace root changed before Box data mutation: ${identity.workspaceRoot}`,
            code,
        );
    }
}

function assertWritableDirectory(target, fsApi) {
    const constants = fsApi.constants || fs.constants;
    try {
        fsApi.accessSync(target, constants.W_OK);
    } catch (error) {
        throw workspaceDataError(
            `Box data directory is not writable by this process: ${target}`,
            undefined,
            error,
        );
    }
}

// Reuses an existing real directory and never follows a symlink into one.
// Returns true only when this call created the directory.
function ensureDirectory(target, fsApi) {
    const before = inspectPath(target, fsApi);
    if (before.exists) {
        if (before.symlink || !before.directory) {
            throw workspaceDataError(`Box data path is not a real directory: ${target}`);
        }
        assertWritableDirectory(target, fsApi);
        return false;
    }
    try {
        fsApi.mkdirSync(target, { recursive: false });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw workspaceDataError(`Unable to create Box data directory: ${target}`, undefined, error);
        }
    }
    const after = inspectPath(target, fsApi);
    if (!after.exists || after.symlink || !after.directory) {
        throw workspaceDataError(`Box data path was replaced during creation: ${target}`);
    }
    assertWritableDirectory(target, fsApi);
    return true;
}

function inspectParentChain(identity, fsApi, {
    requireBoxRoot = true,
    code = 'PLOINKY_BOX_WORKSPACE_DATA_FAILED',
} = {}) {
    assertWorkspaceRoot(identity, fsApi, code);
    const anchor = inspectDirectory(identity.anchorPath, fsApi, {
        missing: 'Workspace identity anchor is missing',
        invalid: 'Workspace identity anchor is not a real directory',
        code,
    });
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!sameIdentityFingerprint(identity.anchorFingerprint, anchor.identityFingerprint)
        || (uid !== null && anchor.identityFingerprint.uid !== uid)
        || (anchor.identityFingerprint.mode & 0o022) !== 0) {
        throw workspaceDataError(
            `Workspace identity anchor changed before Box data mutation: ${identity.anchorPath}`,
            code,
        );
    }
    const rootObserved = inspectPath(identity.boxDataRoot, fsApi);
    if (!rootObserved.exists) {
        if (!requireBoxRoot) return Object.freeze({ anchor, boxRoot: null });
        throw workspaceDataError(
            `Box data root is missing: ${identity.boxDataRoot}`,
            code,
        );
    }
    const boxRoot = inspectDirectory(identity.boxDataRoot, fsApi, {
        invalid: 'Box data root is not a real directory',
        code,
    });
    return Object.freeze({ anchor, boxRoot });
}

function assertSameDirectory(expected, fsApi, message, code) {
    const current = inspectDirectory(expected.path, fsApi, { invalid: message, code });
    if (current.fingerprint !== expected.fingerprint) {
        throw workspaceDataError(`${message}: ${expected.path}`, code);
    }
    return current;
}

function dataState(identity, fsApi, {
    writable = true,
    code = 'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
} = {}) {
    const parents = inspectParentChain(identity, fsApi, { code });
    const paths = {};
    const fingerprints = {};
    for (const key of BOX_DATA_KEYS) {
        const target = identity.dataPaths[key];
        const record = inspectDirectory(target, fsApi, {
            missing: 'Box data directory changed before mutation',
            invalid: 'Box data directory changed before mutation',
            code,
        });
        if (path.dirname(target) !== identity.boxDataRoot) {
            throw workspaceDataError(
                `Box data path is outside ${identity.boxDataRoot}: ${target}`,
                code,
            );
        }
        if (writable) assertWritableDirectory(target, fsApi);
        paths[key] = target;
        fingerprints[key] = record.fingerprint;
    }
    return Object.freeze({
        paths: Object.freeze(paths),
        fingerprints: Object.freeze(fingerprints),
        parents,
    });
}

export function workspaceDataMountArgs(identity) {
    return BOX_DATA_KEYS.flatMap((key) => {
        const source = identity.dataPaths?.[key];
        const destination = BOX_DATA_MOUNTS[key];
        if (!source || !destination) {
            throw workspaceDataError(`Unknown Box data key ${key}`);
        }
        return ['--volume', `${source}:${destination}`];
    });
}

// Creates `.ploinky/box` and its two data directories. The result is durable
// workspace state: a later container failure must not remove it.
export function ensureWorkspaceDataPaths({ identity, lock, fsApi = fs }) {
    assertLock(lock, identity);
    const initialParents = inspectParentChain(identity, fsApi, { requireBoxRoot: false });
    const created = [];
    if (ensureDirectory(identity.boxDataRoot, fsApi)) {
        created.push(identity.boxDataRoot);
    }
    const boxRoot = inspectDirectory(identity.boxDataRoot, fsApi, {
        invalid: 'Box data root is not a real directory',
    });
    assertSameDirectory(
        initialParents.anchor,
        fsApi,
        'Workspace identity anchor changed during Box data preparation',
        'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
    );
    for (const key of BOX_DATA_KEYS) {
        assertSameDirectory(
            boxRoot,
            fsApi,
            'Box data root changed during Box data preparation',
            'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
        );
        const target = identity.dataPaths[key];
        if (ensureDirectory(target, fsApi)) {
            created.push(target);
        }
    }
    const observed = dataState(identity, fsApi);
    return Object.freeze({
        paths: observed.paths,
        fingerprints: observed.fingerprints,
        created: Object.freeze([...created]),
    });
}

// Read-only host inspection used by status and lifecycle planning. It proves
// that both intermediate parents and both final directories are unchanged real
// directories, then returns stable device/inode fingerprints for bind identity.
export function inspectWorkspaceDataPaths({ identity, fsApi = fs, writable = true }) {
    return dataState(identity, fsApi, { writable });
}

// Proves the exact data directories still exist, are real, and stay writable
// immediately before a container is created.
export function revalidateWorkspaceDataPaths({ identity, lock, fsApi = fs }) {
    assertLock(lock, identity);
    const observed = dataState(identity, fsApi);
    return Object.freeze({
        paths: observed.paths,
        fingerprints: observed.fingerprints,
    });
}

// Explicit cache reset. It deletes exactly the two Box cache directories and
// then `.ploinky/box` itself only when nothing else was left inside it. No
// other `.ploinky` state is ever touched.
export function removeWorkspaceDataPaths({ identity, lock, fsApi = fs }) {
    assertLock(lock, identity);
    // Preflight the complete deletion set before the first destructive call.
    // A malformed second path must never cause the first path to be removed.
    const parents = inspectParentChain(identity, fsApi, { requireBoxRoot: false });
    if (!parents.boxRoot) return Object.freeze([]);
    const candidates = [];
    for (const key of BOX_DATA_KEYS) {
        const target = identity.dataPaths[key];
        if (path.dirname(target) !== identity.boxDataRoot) {
            throw workspaceDataError(`Refusing to delete a Box data path outside ${identity.boxDataRoot}`);
        }
        const observed = inspectPath(target, fsApi);
        if (!observed.exists) continue;
        const record = inspectDirectory(target, fsApi, {
            invalid: 'Refusing to delete a Box data path that is not a real directory',
        });
        candidates.push(Object.freeze({ key, ...record }));
    }

    // Revalidate every preflighted directory as one set immediately before the
    // deletion phase. Subsequent per-target checks keep parent substitution
    // from redirecting a later recursive removal.
    assertSameDirectory(
        parents.anchor,
        fsApi,
        'Workspace identity anchor changed before cache deletion',
        'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
    );
    assertSameDirectory(
        parents.boxRoot,
        fsApi,
        'Box data root changed before cache deletion',
        'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
    );
    for (const candidate of candidates) {
        assertSameDirectory(
            candidate,
            fsApi,
            'Box data directory changed before cache deletion',
            'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
        );
    }

    const removed = [];
    for (const candidate of candidates) {
        assertSameDirectory(
            parents.anchor,
            fsApi,
            'Workspace identity anchor changed during cache deletion',
            'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
        );
        assertSameDirectory(
            parents.boxRoot,
            fsApi,
            'Box data root changed during cache deletion',
            'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
        );
        assertSameDirectory(
            candidate,
            fsApi,
            'Box data directory changed during cache deletion',
            'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
        );
        fsApi.rmSync(candidate.path, { recursive: true, force: true });
        assertSameDirectory(
            parents.boxRoot,
            fsApi,
            'Box data root changed after cache deletion',
            'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
        );
        if (inspectPath(candidate.path, fsApi).exists) {
            throw workspaceDataError(`Box data directory still exists after deletion: ${candidate.path}`);
        }
        removed.push(candidate.path);
    }
    assertSameDirectory(
        parents.anchor,
        fsApi,
        'Workspace identity anchor changed before cache-root cleanup',
        'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
    );
    assertSameDirectory(
        parents.boxRoot,
        fsApi,
        'Box data root changed before cache-root cleanup',
        'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
    );
    if (fsApi.readdirSync(identity.boxDataRoot).length === 0) {
        fsApi.rmdirSync(identity.boxDataRoot);
    }
    return Object.freeze(removed);
}
