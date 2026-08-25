// Deterministic content hashing and drift detection for a selected
// achillesAgentLib source directory.
//
// A Git commit is revision evidence, not a content proof: a local checkout can
// be dirty and a managed generation can be verified offline. The fingerprint is
// therefore a hash over the actual runtime bytes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    AGENTLIB_ERROR_CODES,
    AGENTLIB_FINGERPRINT_EXCLUDED_DIRS,
    agentLibError,
} from './contract.mjs';

export function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

export function hashFileBytes(filePath, fsApi = fs) {
    return sha256Hex(fsApi.readFileSync(filePath));
}

/**
 * Stable identity of a real directory. Compared before and after any operation
 * that trusts a path, so a swapped directory cannot be silently adopted.
 *
 * @param {string} dir
 * @param {typeof fs} [fsApi]
 * @returns {{ device: string, inode: string }}
 */
export function sourceIdOf(dir, fsApi = fs) {
    const stat = fsApi.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceInvalid,
            `achillesAgentLib source must be a real directory, not a symlink: ${dir}`,
        );
    }
    return { device: String(stat.dev), inode: String(stat.ino) };
}

export function sourceIdEquals(a, b) {
    return Boolean(a) && Boolean(b)
        && String(a.device) === String(b.device)
        && String(a.inode) === String(b.inode);
}

/** Short, human-comparable form used in container labels and status output. */
export function sourceIdHash(sourceId) {
    return sha256Hex(`${sourceId.device}:${sourceId.inode}`);
}

function entryKind(stat) {
    if (stat.isSymbolicLink()) return 'link';
    if (stat.isDirectory()) return 'dir';
    if (stat.isFile()) return 'file';
    return 'other';
}

/**
 * Collect every fingerprintable entry below `root`, sorted by relative path.
 *
 * Symlinks are recorded by target string rather than followed, so a link that
 * points outside the tree is visible to the caller instead of silently
 * contributing foreign bytes.
 *
 * @param {string} root
 * @param {typeof fs} [fsApi]
 * @returns {Array<{ relativePath: string, kind: string, mode: number, linkTarget: string|null }>}
 */
export function collectSourceEntries(root, fsApi = fs) {
    const entries = [];
    const walk = (absolute, relative) => {
        const names = fsApi.readdirSync(absolute).sort();
        for (const name of names) {
            const childRelative = relative ? `${relative}/${name}` : name;
            if (!relative && AGENTLIB_FINGERPRINT_EXCLUDED_DIRS.includes(name)) continue;
            const childAbsolute = path.join(absolute, name);
            const stat = fsApi.lstatSync(childAbsolute);
            const kind = entryKind(stat);
            if (kind === 'other') {
                throw agentLibError(
                    AGENTLIB_ERROR_CODES.sourceInvalid,
                    `achillesAgentLib source contains an unsupported entry type at ${childRelative}.`,
                );
            }
            entries.push({
                relativePath: childRelative,
                kind,
                // Only the executable bit is runtime-relevant; ignore umask noise.
                mode: kind === 'file' ? (stat.mode & 0o111 ? 0o755 : 0o644) : 0o755,
                linkTarget: kind === 'link' ? fsApi.readlinkSync(childAbsolute) : null,
            });
            if (kind === 'dir') walk(childAbsolute, childRelative);
        }
    };
    walk(root, '');
    return entries;
}

/**
 * Deterministic content fingerprint of a source tree.
 *
 * Validates the source identity before and after traversal: a directory that is
 * replaced mid-hash yields a retryable `PLOINKY_AGENTLIB_SOURCE_CHANGED`.
 *
 * @param {string} sourceDir - absolute, already canonicalized path
 * @param {object} [opts]
 * @param {typeof fs} [opts.fsApi]
 * @param {{device:string,inode:string}} [opts.expectedSourceId]
 * @returns {{ fingerprint: string, sourceId: {device:string,inode:string}, entryCount: number }}
 */
export function fingerprintSource(sourceDir, { fsApi = fs, expectedSourceId = null } = {}) {
    const before = sourceIdOf(sourceDir, fsApi);
    if (expectedSourceId && !sourceIdEquals(before, expectedSourceId)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceChanged,
            `achillesAgentLib source identity changed at ${sourceDir}; re-run the command.`,
        );
    }
    const entries = collectSourceEntries(sourceDir, fsApi);
    const hash = crypto.createHash('sha256');
    hash.update('ploinky-agentlib-fingerprint/1\n');
    for (const entry of entries) {
        hash.update(`${entry.relativePath}\0${entry.kind}\0${entry.mode.toString(8)}\0`);
        if (entry.kind === 'link') {
            hash.update(`${entry.linkTarget}\0`);
        } else if (entry.kind === 'file') {
            hash.update(sha256Hex(fsApi.readFileSync(path.join(sourceDir, entry.relativePath))));
            hash.update('\0');
        }
    }
    const after = sourceIdOf(sourceDir, fsApi);
    if (!sourceIdEquals(before, after)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceChanged,
            `achillesAgentLib source was replaced while it was being hashed: ${sourceDir}`,
        );
    }
    return { fingerprint: hash.digest('hex'), sourceId: after, entryCount: entries.length };
}

/**
 * Recompute a fingerprint and report whether it still matches the active one.
 *
 * @returns {{ drifted: boolean, expected: string, actual: string }}
 */
export function detectSourceDrift(sourceDir, expectedFingerprint, { fsApi = fs, expectedSourceId = null } = {}) {
    const { fingerprint } = fingerprintSource(sourceDir, { fsApi, expectedSourceId });
    return { drifted: fingerprint !== expectedFingerprint, expected: expectedFingerprint, actual: fingerprint };
}
