#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PloinkyBoxError } from '../errors.mjs';

const MASTER_KEY_PATTERN = /^[a-f0-9]{64}$/;
const MASTER_KEY_FILE = 'master-key';
const PLOINKY_DIRECTORY = '.ploinky';

function initializerError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_WORKSPACE_INITIALIZATION_FAILED',
        cause,
    });
}

function fingerprint(stat) {
    return {
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: stat.mode,
        links: stat.nlink,
    };
}

function sameFingerprint(left, right) {
    return left.device === right.device
        && left.inode === right.inode
        && left.mode === right.mode
        && left.links === right.links;
}

function sameDirectoryFingerprint(left, right) {
    return left.device === right.device
        && left.inode === right.inode
        && left.mode === right.mode;
}

function assertOwnedDirectory(target, fsApi) {
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw initializerError(`Workspace master-key directory is not a real directory: ${target}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw initializerError(`Workspace master-key directory is not owned by the current user: ${target}`);
    }
    return fingerprint(stat);
}

function assertSecureRegular(stat, target) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw initializerError(`Workspace master-key target is not a private regular file: ${target}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw initializerError(`Workspace master-key target is not owned by the current user: ${target}`);
    }
}

function decodeMasterKey(bytes, target) {
    const text = bytes.toString('utf8');
    if (!/^([a-f0-9]{64})\n$/.test(text)) {
        throw initializerError(
            `Existing ${target} must contain exactly one 64-character lowercase hexadecimal key; its content was not changed`,
        );
    }
    return text.slice(0, -1);
}

function readExisting(target, fsApi, { normalizeMode = false } = {}) {
    const before = fsApi.lstatSync(target);
    assertSecureRegular(before, target);
    const flags = fsApi.constants.O_RDONLY | (fsApi.constants.O_NOFOLLOW || 0);
    const descriptor = fsApi.openSync(target, flags);
    try {
        const opened = fsApi.fstatSync(descriptor);
        assertSecureRegular(opened, target);
        if (!sameFingerprint(fingerprint(before), fingerprint(opened))) {
            throw initializerError(`Workspace master-key target changed while opening: ${target}`);
        }
        const bytes = fsApi.readFileSync(descriptor);
        const key = decodeMasterKey(bytes, target);
        if (normalizeMode) fsApi.fchmodSync(descriptor, 0o600);
        else if ((opened.mode & 0o777) !== 0o600) {
            throw initializerError(`Workspace master-key target must have mode 0600: ${target}`);
        }
        return { bytes, key, created: false };
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function ensurePloinkyDirectory(root, fsApi) {
    const target = path.join(root, PLOINKY_DIRECTORY);
    try {
        assertOwnedDirectory(target, fsApi);
        // The Box mounts this directory into multiple confined producers. A
        // pre-existing host directory may have inherited 0775 from umask;
        // normalize it before any producer validates or writes beneath it.
        fsApi.chmodSync(target, 0o700);
        return { path: target, fingerprint: assertOwnedDirectory(target, fsApi) };
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    try {
        fsApi.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw initializerError(`Unable to create workspace state directory: ${target}`, error);
        }
    }
    fsApi.chmodSync(target, 0o700);
    return { path: target, fingerprint: assertOwnedDirectory(target, fsApi) };
}

function assertStableDirectories(root, rootBefore, ploinkyDirectory, ploinkyBefore, fsApi) {
    const rootAfter = assertOwnedDirectory(root, fsApi);
    const ploinkyAfter = assertOwnedDirectory(ploinkyDirectory, fsApi);
    if (!sameDirectoryFingerprint(rootBefore, rootAfter)) {
        throw initializerError('Workspace root changed while initializing its master key');
    }
    if (!sameDirectoryFingerprint(ploinkyBefore, ploinkyAfter)) {
        throw initializerError('Workspace state directory changed while initializing its master key');
    }
}

function removeCreatedTargetIfUnchanged(target, descriptor, openedFingerprint, fsApi) {
    if (!openedFingerprint) return;
    try {
        const opened = fingerprint(fsApi.fstatSync(descriptor));
        const current = fingerprint(fsApi.lstatSync(target));
        if (sameFingerprint(openedFingerprint, opened) && sameFingerprint(opened, current)) {
            fsApi.unlinkSync(target);
        }
    } catch {
        // Never remove a path that cannot be proven to still be the file we created.
    }
}

export function workspaceMasterKeyPath(workspaceRoot = '/workspace') {
    return path.join(path.resolve(workspaceRoot), PLOINKY_DIRECTORY, MASTER_KEY_FILE);
}

export function readWorkspaceMasterKey({
    workspaceRoot = '/workspace',
    fsApi = fs,
} = {}) {
    const root = path.resolve(workspaceRoot);
    const ploinkyDirectory = path.join(root, PLOINKY_DIRECTORY);
    const target = path.join(ploinkyDirectory, MASTER_KEY_FILE);
    try {
        const rootBefore = assertOwnedDirectory(root, fsApi);
        const ploinkyBefore = assertOwnedDirectory(ploinkyDirectory, fsApi);
        const existing = readExisting(target, fsApi);
        assertStableDirectories(root, rootBefore, ploinkyDirectory, ploinkyBefore, fsApi);
        return Object.freeze({ path: target, key: existing.key });
    } catch (error) {
        if (error instanceof PloinkyBoxError) throw error;
        throw initializerError(`Unable to read managed workspace master key: ${target}`, error);
    }
}

export function initializeWorkspaceMasterKey({
    workspaceRoot = '/workspace',
    fsApi = fs,
    randomBytes = crypto.randomBytes,
} = {}) {
    const root = path.resolve(workspaceRoot);
    const rootBefore = assertOwnedDirectory(root, fsApi);
    const stateDirectory = ensurePloinkyDirectory(root, fsApi);
    const target = path.join(stateDirectory.path, MASTER_KEY_FILE);
    try {
        const existing = readExisting(target, fsApi, { normalizeMode: true });
        assertStableDirectories(
            root,
            rootBefore,
            stateDirectory.path,
            stateDirectory.fingerprint,
            fsApi,
        );
        return Object.freeze({ created: false, path: target, keyPresent: Boolean(existing.key) });
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const key = randomBytes(32).toString('hex');
    if (!MASTER_KEY_PATTERN.test(key)) {
        throw initializerError('Secure random source did not return a 32-byte master key');
    }
    const flags = fsApi.constants.O_WRONLY
        | fsApi.constants.O_CREAT
        | fsApi.constants.O_EXCL
        | (fsApi.constants.O_NOFOLLOW || 0);
    let descriptor;
    try {
        descriptor = fsApi.openSync(target, flags, 0o600);
    } catch (error) {
        if (error.code === 'EEXIST') {
            readExisting(target, fsApi, { normalizeMode: true });
            assertStableDirectories(
                root,
                rootBefore,
                stateDirectory.path,
                stateDirectory.fingerprint,
                fsApi,
            );
            return Object.freeze({ created: false, path: target, keyPresent: true });
        }
        throw initializerError(`Unable to create workspace master-key file: ${target}`, error);
    }
    let openedFingerprint;
    try {
        const opened = fsApi.fstatSync(descriptor);
        assertSecureRegular(opened, target);
        openedFingerprint = fingerprint(opened);
        fsApi.writeFileSync(descriptor, `${key}\n`, { encoding: 'utf8' });
        fsApi.fsyncSync(descriptor);
        fsApi.fchmodSync(descriptor, 0o600);
    } catch (error) {
        removeCreatedTargetIfUnchanged(target, descriptor, openedFingerprint, fsApi);
        try { fsApi.closeSync(descriptor); } catch {}
        descriptor = undefined;
        throw initializerError(`Unable to initialize workspace master-key file: ${target}`, error);
    } finally {
        if (descriptor !== undefined) fsApi.closeSync(descriptor);
    }
    assertStableDirectories(
        root,
        rootBefore,
        stateDirectory.path,
        stateDirectory.fingerprint,
        fsApi,
    );
    return Object.freeze({ created: true, path: target, keyPresent: true });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        initializeWorkspaceMasterKey();
    } catch (error) {
        process.stderr.write(`ploinky-box workspace initialization failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
