// Installer resolution evidence and direct Git provenance verification.
//
// npm records what it installed in `node_modules/.package-lock.json` (written
// even with --no-package-lock). That hidden lock is resolution evidence only:
// it is hashed into `resolutionManifestHash`, never used as the tree digest.
// Required direct Git packages must be present in both the evidence and the
// tree and resolve to the expected canonical source and (when pinned) the
// exact full commit. Missing metadata or a mismatch prevents publication.

import fs from 'node:fs';
import path from 'node:path';

import { cacheV4Error, canonicalDigest, canonicalValue, isFullGitSha } from './canonical.mjs';
import { parseResolvedGitSource } from './gitSpec.mjs';

export const RESOLUTION_SCHEMA = 1;
export const HIDDEN_LOCK_RELATIVE = path.join('node_modules', '.package-lock.json');

function provenanceError(message, details) {
    return cacheV4Error('PLOINKY_DEPS_PROVENANCE_MISMATCH', message, details);
}

export function readHiddenLock(payloadDir, { fsApi = fs } = {}) {
    const file = path.join(payloadDir, HIDDEN_LOCK_RELATIVE);
    let raw;
    try { raw = fsApi.readFileSync(file, 'utf8'); }
    catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.packages === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/** Canonical, credential-free resolution manifest of the complete artifact. */
export function buildResolutionManifest(hiddenLock, { installer }) {
    const packages = {};
    for (const [location, entry] of Object.entries(hiddenLock?.packages || {})) {
        if (!location) continue;
        packages[location] = {
            version: entry?.version ?? null,
            resolved: redactResolved(entry?.resolved ?? null),
            integrity: entry?.integrity ?? null,
            link: Boolean(entry?.link),
        };
    }
    const manifest = canonicalValue({
        schema: RESOLUTION_SCHEMA,
        installer: installer || null,
        evidence: hiddenLock ? 'npm-hidden-lock' : 'none',
        packages,
    });
    return { manifest, hash: canonicalDigest(manifest) };
}

function redactResolved(value) {
    if (typeof value !== 'string') return value;
    try {
        const url = new URL(value.replace(/^git\+/, ''));
        if (url.password || url.username && url.protocol.startsWith('http')) {
            url.password = '';
            url.username = '';
            return value.startsWith('git+') ? `git+${url.href}` : url.href;
        }
    } catch { /* not a URL */ }
    return value;
}

/**
 * Verify every expected direct Git package against installer evidence and
 * the actual tree. Returns provenance records for the object manifest.
 *
 * @param {string} payloadDir
 * @param {Array<{section, name, source, commit, supported, presence}>} expectedGit
 * @param {{ hiddenLock: object|null, pinVerification?: Map<string,string>, fsApi?: object }} options
 */
export function verifyDirectGitProvenance(payloadDir, expectedGit, { hiddenLock, pinVerification = new Map(), fsApi = fs } = {}) {
    const provenance = [];
    for (const expected of expectedGit || []) {
        const location = `node_modules/${expected.name}`;
        const installedPath = path.join(payloadDir, 'node_modules', ...expected.name.split('/'));
        let installed = false;
        try { installed = fsApi.lstatSync(installedPath).isDirectory() || fsApi.lstatSync(installedPath).isSymbolicLink(); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        const entry = hiddenLock?.packages?.[location] || null;
        if (!installed && !entry) {
            if (expected.presence === 'required') {
                throw provenanceError(`required Git dependency ${expected.name} is not installed`, { name: expected.name });
            }
            provenance.push({ section: expected.section, name: expected.name, state: 'omitted', presence: expected.presence });
            continue;
        }
        if (installed !== Boolean(entry)) {
            throw provenanceError(`Git dependency ${expected.name} has no matching installer resolution metadata`, { name: expected.name });
        }
        if (!expected.supported) {
            provenance.push({
                section: expected.section, name: expected.name, state: 'unsupported-spec',
                resolved: redactResolved(entry.resolved ?? null), verification: 'observed-at-install',
            });
            continue;
        }
        const resolved = parseResolvedGitSource(entry.resolved);
        if (!resolved || !isFullGitSha(resolved.commit)) {
            throw provenanceError(`Git dependency ${expected.name} lacks an exact resolved commit in installer metadata`, { name: expected.name });
        }
        if (resolved.source !== expected.source) {
            throw provenanceError(`Git dependency ${expected.name} resolved from ${resolved.source}, expected ${expected.source}`,
                { name: expected.name, expected: expected.source, actual: resolved.source });
        }
        if (expected.commit && resolved.commit !== expected.commit) {
            throw provenanceError(`Git dependency ${expected.name} resolved to ${resolved.commit}, expected ${expected.commit}`,
                { name: expected.name, expected: expected.commit, actual: resolved.commit });
        }
        provenance.push({
            section: expected.section,
            name: expected.name,
            state: 'installed',
            source: resolved.source,
            commit: resolved.commit,
            verification: expected.commit ? (pinVerification.get(expected.name) || 'exact-spec') : 'observed-at-install',
        });
    }
    return provenance;
}
