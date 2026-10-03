#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBoxWorkspaceRoot } from '../contract/workspace-root.mjs';
import { PloinkyBoxError } from '../errors.mjs';

const MASTER_KEY_PATTERN = /^[a-f0-9]{64}$/;
const MASTER_KEY_FILE = 'master-key';
const PLOINKY_DIRECTORY = '.ploinky';
// Controller secrets live in the controller-state root that every agent
// runtime masks (`protectedControllerStateRoots`), never beside it: a broad
// workspace bind reaches the rest of `.ploinky` read-only, and a file bind
// cannot hide a file the controller later replaces by rename.
const CONTROLLER_STATE_DIRECTORY = 'data';
const RETIRED_CONTROLLER_SECRET_FILES = Object.freeze([
    MASTER_KEY_FILE,
    '.secrets',
    'ploinky_subject_identity_ed25519_v1.enc',
]);

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

function inspectDirectory(target, fsApi) {
    const stat = fsApi.statSync(target);
    if (!stat.isDirectory()) {
        throw initializerError(`Workspace master-key directory is not a real directory: ${target}`);
    }
    return fingerprint(stat);
}

function inspectPhysicalDirectory(target, fsApi) {
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw initializerError(`Workspace controller-state directory is not a real directory: ${target}`);
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

function ensureStateDirectory(target, fsApi, inspect) {
    try {
        return { path: target, fingerprint: inspect(target, fsApi) };
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
    return { path: target, fingerprint: inspect(target, fsApi) };
}

function assertStableDirectories(directories, fsApi) {
    for (const { path: target, fingerprint: before, inspect, label } of directories) {
        if (!sameDirectoryFingerprint(before, inspect(target, fsApi))) {
            throw initializerError(`${label} changed while initializing its master key`);
        }
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

// The workspace root is always explicit: the Box has no fixed workspace path.
function selectedWorkspaceRoot(workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
        throw initializerError('Workspace master-key access requires an absolute workspace root');
    }
    return path.resolve(workspaceRoot);
}

export function workspaceMasterKeyPath(workspaceRoot) {
    return path.join(
        selectedWorkspaceRoot(workspaceRoot), PLOINKY_DIRECTORY, CONTROLLER_STATE_DIRECTORY, MASTER_KEY_FILE,
    );
}

// Secrets at the retired `.ploinky/<name>` spelling stay readable through every
// broad workspace bind. Refuse them rather than silently using, ignoring or
// replacing them; the operator moves them once, with no agent running.
export function assertNoRetiredControllerSecrets(workspaceRoot, fsApi = fs) {
    const directory = path.join(path.resolve(workspaceRoot), PLOINKY_DIRECTORY);
    const destination = path.join(directory, CONTROLLER_STATE_DIRECTORY);
    const retired = RETIRED_CONTROLLER_SECRET_FILES.map(name => path.join(directory, name)).filter((target) => {
        try {
            fsApi.lstatSync(target);
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
            throw error;
        }
    });
    if (!retired.length) return;
    throw new PloinkyBoxError(
        `Controller secrets at the retired agent-readable location are refused: ${retired.join(', ')}. `
        + `Stop the workspace and move each one into ${destination} `
        + `(mkdir -p -m 700 ${destination} && mv <file> ${destination}/).`,
        { code: 'PLOINKY_RETIRED_CONTROLLER_SECRETS' },
    );
}

function stateDirectories(root, fsApi, { create = false } = {}) {
    const rootEntry = {
        path: root, fingerprint: inspectDirectory(root, fsApi), inspect: inspectDirectory, label: 'Workspace root',
    };
    const ploinkyPath = path.join(root, PLOINKY_DIRECTORY);
    const ploinky = create
        ? ensureStateDirectory(ploinkyPath, fsApi, inspectDirectory)
        : { path: ploinkyPath, fingerprint: inspectDirectory(ploinkyPath, fsApi) };
    assertNoRetiredControllerSecrets(root, fsApi);
    const dataPath = path.join(ploinky.path, CONTROLLER_STATE_DIRECTORY);
    const data = create
        ? ensureStateDirectory(dataPath, fsApi, inspectPhysicalDirectory)
        : { path: dataPath, fingerprint: inspectPhysicalDirectory(dataPath, fsApi) };
    return [
        rootEntry,
        { ...ploinky, inspect: inspectDirectory, label: 'Workspace state directory' },
        { ...data, inspect: inspectPhysicalDirectory, label: 'Workspace controller-state directory' },
    ];
}

export function readWorkspaceMasterKey({
    workspaceRoot,
    fsApi = fs,
} = {}) {
    const root = selectedWorkspaceRoot(workspaceRoot);
    const target = workspaceMasterKeyPath(root);
    try {
        const directories = stateDirectories(root, fsApi);
        const existing = readExisting(target, fsApi);
        assertStableDirectories(directories, fsApi);
        return Object.freeze({ path: target, key: existing.key });
    } catch (error) {
        if (error instanceof PloinkyBoxError) throw error;
        throw initializerError(`Unable to read managed workspace master key: ${target}`, error);
    }
}

export function initializeWorkspaceMasterKey({
    workspaceRoot,
    fsApi = fs,
    randomBytes = crypto.randomBytes,
} = {}) {
    const root = selectedWorkspaceRoot(workspaceRoot);
    const directories = stateDirectories(root, fsApi, { create: true });
    const target = workspaceMasterKeyPath(root);
    try {
        const existing = readExisting(target, fsApi, { normalizeMode: true });
        assertStableDirectories(directories, fsApi);
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
            assertStableDirectories(directories, fsApi);
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
    assertStableDirectories(directories, fsApi);
    return Object.freeze({ created: true, path: target, keyPresent: true });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        initializeWorkspaceMasterKey({ workspaceRoot: readBoxWorkspaceRoot(process.env) });
    } catch (error) {
        process.stderr.write(`ploinky-box workspace initialization failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
