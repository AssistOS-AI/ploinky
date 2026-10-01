// Private host-state file and directory helpers shared by the GPU grant store
// and the hardware-limits gate. The checks are unchanged from the GPU grant
// implementation: real directories only, owner-only modes, one-link regular
// files read without following symlinks, and atomic private replacement.
// Each caller supplies its own subject and error factory, so existing
// messages are preserved byte for byte.

import crypto from 'node:crypto';
import path from 'node:path';

export function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

export function ensurePrivateDirectory(fsApi, target, { subject, stateError }) {
    try {
        fsApi.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
        if (error?.code !== 'EEXIST') throw stateError(`Unable to create ${subject} directory: ${target}`, error);
    }
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw stateError(`${subject} path is not a real directory: ${target}`);
    }
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) {
        throw stateError(`${subject} directory is not owned by the current user: ${target}`);
    }
    fsApi.chmodSync(target, 0o700);
}

export function assertPrivateDirectoryIfPresent(fsApi, target, { subject, stateError }) {
    let stat;
    try {
        stat = fsApi.lstatSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw stateError(`Unable to inspect ${subject} directory: ${target}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw stateError(`${subject} path is not a real directory: ${target}`);
    }
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) {
        throw stateError(`${subject} directory is not owned by the current user: ${target}`);
    }
    if ((stat.mode & 0o022) !== 0) {
        throw stateError(`${subject} directory must not be group- or world-writable: ${target}`);
    }
    return true;
}

export function readPrivateFile(fsApi, target, maxBytes, label, { stateError }) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            target,
            fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK,
        );
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw stateError(`${label} must be a readable non-symlink file: ${target}`, error);
    }
    try {
        const before = fsApi.fstatSync(descriptor);
        if (!before.isFile() || before.nlink !== 1) {
            throw stateError(`${label} must be one non-linked regular file: ${target}`);
        }
        const uid = currentUid();
        if (uid !== null && before.uid !== uid) throw stateError(`${label} must be owned by the current user: ${target}`);
        if ((before.mode & 0o077) !== 0) throw stateError(`${label} must be private to the current user (mode 0600): ${target}`);
        if (before.size > maxBytes) throw stateError(`${label} exceeds ${maxBytes} bytes: ${target}`);
        const bytes = fsApi.readFileSync(descriptor);
        const after = fsApi.fstatSync(descriptor);
        if (bytes.length !== before.size || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw stateError(`${label} changed while being read: ${target}`);
        }
        return bytes;
    } finally {
        fsApi.closeSync(descriptor);
    }
}

export function writePrivateFileAtomically(fsApi, directory, target, content, beforeRename, { subject, stateError }) {
    try {
        const existing = fsApi.lstatSync(target);
        if (!existing.isFile() || existing.isSymbolicLink()) {
            throw stateError(`Refusing to replace a non-regular ${subject} path: ${target}`);
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            temporary,
            fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_EXCL | fsApi.constants.O_NOFOLLOW,
            0o600,
        );
        fsApi.writeFileSync(descriptor, content);
        fsApi.fsyncSync(descriptor);
        fsApi.closeSync(descriptor);
        descriptor = undefined;
        beforeRename();
        fsApi.renameSync(temporary, target);
    } finally {
        if (descriptor !== undefined) fsApi.closeSync(descriptor);
        try { fsApi.unlinkSync(temporary); } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

export function fsyncDirectory(fsApi, directory) {
    let descriptor;
    try {
        descriptor = fsApi.openSync(directory, fsApi.constants.O_RDONLY);
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        // Some platforms refuse fsync on a directory descriptor; the rename
        // itself remains atomic there.
        if (!['EISDIR', 'EINVAL', 'EPERM', 'EBADF'].includes(error?.code)) throw error;
    } finally {
        if (descriptor !== undefined) fsApi.closeSync(descriptor);
    }
}
