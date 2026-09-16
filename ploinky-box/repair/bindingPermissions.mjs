import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    assertRouterBindingStateConfined,
    createRouterBindingStore,
    ROUTER_BINDING_STATE_MAX_BYTES,
} from '../routerBinding.mjs';

const CHECK_ID = 'repair.binding.permissions';
const LABEL = 'Saved Router binding permissions';

function failure(code, detail) {
    return Object.assign(new Error(detail), { code });
}

function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(left, right) {
    return sameFile(left, right) && left.uid === right.uid && left.nlink === right.nlink
        && left.size === right.size && left.mode === right.mode
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertRecordFile(stat, uid) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw failure('BINDING_UNSAFE_PATH', 'The saved binding must be a regular file with exactly one link.');
    }
    if (stat.uid !== uid) {
        throw failure('BINDING_FOREIGN_OWNER', 'The saved binding belongs to another user; an administrator must review its ownership and origin.');
    }
    if ((stat.mode & 0o022) !== 0) {
        throw failure('BINDING_SHARED_WRITE', 'Other users can write the saved binding. Review and recreate the intended binding manually; its current contents cannot be trusted for automatic repair.');
    }
    if (stat.size > ROUTER_BINDING_STATE_MAX_BYTES) {
        throw failure('BINDING_INVALID_RECORD', `The saved binding exceeds ${ROUTER_BINDING_STATE_MAX_BYTES} bytes.`);
    }
}

function inspectDirectories({ homeDirectory, directory, fsApi, uid }) {
    const snapshots = [];
    for (const target of [path.resolve(homeDirectory), path.dirname(directory), directory]) {
        let stat;
        try { stat = fsApi.lstatSync(target); } catch (error) {
            if (error?.code === 'ENOENT') return { snapshots, missing: true };
            throw error;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
            throw failure('BINDING_UNSAFE_PATH', `Binding state requires real, user-owned directories that others cannot write: ${target}`);
        }
        snapshots.push({ target, stat });
    }
    return { snapshots, missing: false };
}

function assertDirectoriesUnchanged(snapshots, fsApi) {
    for (const { target, stat } of snapshots) {
        const current = fsApi.lstatSync(target);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(stat, current)
            || current.uid !== stat.uid || current.mode !== stat.mode) {
            throw failure('BINDING_UNSAFE_PATH', 'A binding state directory changed during inspection; no automatic repair is permitted.');
        }
    }
}

function readBounded(descriptor, fsApi) {
    const bytes = Buffer.alloc(ROUTER_BINDING_STATE_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
        const count = fsApi.readSync(descriptor, bytes, size, bytes.length - size, size);
        if (count === 0) break;
        size += count;
    }
    if (size > ROUTER_BINDING_STATE_MAX_BYTES) {
        throw failure('BINDING_INVALID_RECORD', `The saved binding exceeds ${ROUTER_BINDING_STATE_MAX_BYTES} bytes.`);
    }
    return bytes.subarray(0, size);
}

function validateBytes({ identity, store, descriptor, stat, fsApi }) {
    const bytes = readBounded(descriptor, fsApi);
    if (bytes.length !== stat.size || !unchangedFile(stat, fsApi.fstatSync(descriptor))) {
        throw failure('BINDING_UNSAFE_PATH', 'The saved binding changed while being read.');
    }
    try { store.validateRecord(identity, JSON.parse(bytes.toString('utf8'))); } catch {
        throw failure('BINDING_INVALID_RECORD', 'The saved binding is invalid JSON, has an unsupported schema, or belongs to another workspace.');
    }
    return bytes;
}

// This snapshot is intentionally stricter than permission repair: files that
// other users could modify must never become trusted merely by removing bits.
function inspect(options) {
    const { identity, homeDirectory, fsApi, uid } = options;
    if (!Number.isSafeInteger(uid) || uid < 0) {
        throw failure('BINDING_UNREADABLE', 'Cannot establish the current user identity for a safe permission repair.');
    }
    const store = createRouterBindingStore({ homeDirectory, fsApi });
    let target;
    try {
        target = store.pathFor(identity);
        assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
    } catch {
        throw failure('BINDING_UNSAFE_PATH', 'Binding state identity is invalid or overlaps a writable workspace/cache path.');
    }
    const directories = inspectDirectories({ homeDirectory, directory: store.directory, fsApi, uid });
    if (directories.missing) return { target, missing: true };
    let before;
    try { before = fsApi.lstatSync(target); } catch (error) {
        if (error?.code === 'ENOENT') return { target, missing: true };
        throw error;
    }
    assertRecordFile(before, uid);
    const descriptor = fsApi.openSync(target,
        fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK);
    try {
        const opened = fsApi.fstatSync(descriptor);
        assertRecordFile(opened, uid);
        if (!unchangedFile(before, opened)) throw failure('BINDING_UNSAFE_PATH', 'The saved binding changed while being opened.');
        const bytes = validateBytes({ identity, store, descriptor, stat: opened, fsApi });
        assertDirectoriesUnchanged(directories.snapshots, fsApi);
        if (!unchangedFile(opened, fsApi.lstatSync(target))) {
            throw failure('BINDING_UNSAFE_PATH', 'The binding path changed during inspection.');
        }
        return { target, store, stat: opened, bytes, directories: directories.snapshots, missing: false };
    } finally { fsApi.closeSync(descriptor); }
}

function optionsWithDefaults({ identity, homeDirectory = os.homedir(), fsApi = fs, uid = process.getuid?.() } = {}) {
    return { identity, homeDirectory, fsApi, uid };
}

/** Inspect only this workspace's host-only binding record without mutation. */
export function inspectBindingPermissions(options = {}) {
    try {
        const snapshot = inspect(optionsWithDefaults(options));
        if (snapshot.missing) return [{ id: CHECK_ID, label: LABEL, status: 'skip',
            detail: 'No saved binding exists for this workspace; no permission repair is needed.', repairEligible: false }];
        const shared = (snapshot.stat.mode & 0o077) !== 0;
        return [{ id: CHECK_ID, label: LABEL, status: shared ? 'fail' : 'pass',
            detail: shared ? 'The valid, user-owned binding exposes group/other permission bits. They can be removed without changing its contents.'
                : 'The valid saved binding is private to the current user.',
            ...(shared ? { code: 'BINDING_SHARED_READ', target: snapshot.target,
                next: 'Run ploinky repair to remove group/other permission bits from this binding only.' } : {}),
            repairEligible: shared }];
    } catch (error) {
        return [{ id: CHECK_ID, label: LABEL, status: 'fail',
            code: String(error?.code || '').startsWith('BINDING_') ? error.code : 'BINDING_UNREADABLE',
            detail: String(error?.code || '').startsWith('BINDING_') ? error.message : 'The binding state could not be safely read.',
            next: 'Inspect the selected host-only binding and its parent directories manually; automatic repair will not change unsafe or unverified state.',
            repairEligible: false }];
    }
}

/** Tighten one validated file descriptor, without rewriting or widening access. */
export function repairBindingPermissions(options = {}) {
    const { lock } = options;
    const resolved = optionsWithDefaults(options);
    const { identity, homeDirectory, fsApi, uid } = resolved;
    if (typeof lock?.assertHeld !== 'function') {
        throw failure('BINDING_LOCK_REQUIRED', 'Binding permission repair requires the workspace mutation lock.');
    }
    lock.assertHeld(identity?.instance);
    const snapshot = inspect(resolved);
    if (snapshot.missing || (snapshot.stat.mode & 0o077) === 0) {
        return { status: 'skipped', detail: 'This workspace has no binding permission change to apply.' };
    }
    const descriptor = fsApi.openSync(snapshot.target,
        fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK);
    try {
        const before = fsApi.fstatSync(descriptor);
        assertRecordFile(before, uid);
        if (!unchangedFile(snapshot.stat, before)) throw failure('BINDING_UNSAFE_PATH', 'The binding changed before permission repair.');
        const bytes = validateBytes({ identity, store: snapshot.store, descriptor, stat: before, fsApi });
        if (!bytes.equals(snapshot.bytes)) throw failure('BINDING_UNSAFE_PATH', 'The binding contents changed before permission repair.');
        lock.assertHeld(identity.instance);
        assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
        assertDirectoriesUnchanged(snapshot.directories, fsApi);
        if (!unchangedFile(before, fsApi.lstatSync(snapshot.target))) {
            throw failure('BINDING_UNSAFE_PATH', 'The binding path changed before permission repair.');
        }
        const mode = before.mode & 0o700;
        fsApi.fchmodSync(descriptor, mode);
        const after = fsApi.fstatSync(descriptor);
        const verifiedBytes = readBounded(descriptor, fsApi);
        const verified = fsApi.fstatSync(descriptor);
        const current = fsApi.lstatSync(snapshot.target);
        assertRecordFile(after, uid);
        assertDirectoriesUnchanged(snapshot.directories, fsApi);
        assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
        if (!sameFile(before, after) || !sameFile(after, current) || current.isSymbolicLink()
            || !unchangedFile(after, verified) || !unchangedFile(verified, current)
            || after.mode !== current.mode || (after.mode & 0o7777) !== mode
            || after.size !== before.size || after.mtimeMs !== before.mtimeMs
            || !verifiedBytes.equals(bytes)) {
            throw failure('BINDING_UNSAFE_PATH', 'Binding identity or contents changed during permission repair; inspect this state manually.');
        }
        return { status: 'applied', detail: 'Removed group/other access from the selected binding; its contents and owner permissions are unchanged.',
            operation: { file: 'chmod', args: ['go-rwx', '--', snapshot.target] } };
    } finally { fsApi.closeSync(descriptor); }
}
