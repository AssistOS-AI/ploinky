#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PloinkyBoxError } from '../errors.mjs';

const MASTER_KEY_PATTERN = /^[a-f0-9]{64}$/;

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

function sameRootFingerprint(left, right) {
    return left.device === right.device
        && left.inode === right.inode
        && left.mode === right.mode;
}

function assertSecureRegular(stat, target) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw initializerError(`Workspace master-key target is not a private regular file: ${target}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw initializerError(`Workspace master-key target is not owned by the current user: ${target}`);
    }
}

function readExisting(target, fsApi) {
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
        const matches = [...bytes.toString('utf8').matchAll(/^PLOINKY_MASTER_KEY=([^\r\n]*)$/gm)];
        if (matches.length !== 1 || !MASTER_KEY_PATTERN.test(matches[0][1])) {
            throw initializerError(
                `Existing ${target} must contain exactly one valid nonempty PLOINKY_MASTER_KEY; its content was not changed`,
            );
        }
        fsApi.fchmodSync(descriptor, 0o600);
        return { bytes, created: false };
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function assertWorkspaceRoot(workspaceRoot, fsApi) {
    const stat = fsApi.lstatSync(workspaceRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw initializerError(`Workspace root is not a real directory: ${workspaceRoot}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw initializerError(`Workspace root is not owned by the current user: ${workspaceRoot}`);
    }
    return fingerprint(stat);
}

export function initializeWorkspaceMasterKey({
    workspaceRoot = '/workspace',
    fsApi = fs,
    randomBytes = crypto.randomBytes,
} = {}) {
    const root = path.resolve(workspaceRoot);
    const rootBefore = assertWorkspaceRoot(root, fsApi);
    const target = path.join(root, '.env');
    try {
        const existing = readExisting(target, fsApi);
        const rootAfter = assertWorkspaceRoot(root, fsApi);
        if (!sameRootFingerprint(rootBefore, rootAfter)) {
            throw initializerError('Workspace root changed while validating its master key');
        }
        return Object.freeze({ created: false, path: target, keyPresent: true });
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
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
            readExisting(target, fsApi);
            return Object.freeze({ created: false, path: target, keyPresent: true });
        }
        throw initializerError(`Unable to create workspace master-key file: ${target}`, error);
    }
    try {
        const opened = fsApi.fstatSync(descriptor);
        assertSecureRegular(opened, target);
        fsApi.writeFileSync(descriptor, `PLOINKY_MASTER_KEY=${key}\n`, { encoding: 'utf8' });
        fsApi.fsyncSync(descriptor);
        fsApi.fchmodSync(descriptor, 0o600);
    } catch (error) {
        try { fsApi.closeSync(descriptor); } catch {}
        descriptor = undefined;
        try { fsApi.unlinkSync(target); } catch {}
        throw initializerError(`Unable to initialize workspace master-key file: ${target}`, error);
    } finally {
        if (descriptor !== undefined) {
            fsApi.closeSync(descriptor);
        }
    }
    const rootAfter = assertWorkspaceRoot(root, fsApi);
    if (!sameRootFingerprint(rootBefore, rootAfter)) {
        throw initializerError('Workspace root changed while creating its master key');
    }
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
