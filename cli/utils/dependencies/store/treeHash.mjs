// Installed-tree integrity for immutable dependency objects.
//
// The digest covers the actual payload: every relative path, entry type,
// regular-file bytes, the approved mode policy (executable bit only) and the
// literal text of every symlink. Symlinks are never followed. Links that
// resolve lexically outside the payload are accepted only when they point at
// an approved external provider target (the AgentLib link target) or inside
// it. Special files, setuid/setgid files and unapproved escapes are rejected.
// Object bookkeeping (manifest, completion marker) lives beside the payload
// and is therefore outside the hashed tree by construction. npm's hidden lock
// is ordinary tree content here; resolution evidence is recorded separately.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { dependencyStoreError } from './canonical.mjs';

export const TREE_HASH_SCHEMA = 1;

function unsafe(message) {
    return dependencyStoreError('PLOINKY_DEPS_TREE_UNSAFE', message);
}

function withinOrEqual(candidate, root) {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * @param {string} root - payload directory
 * @param {{ approvedExternalTargets?: string[], fsApi?: object }} [options]
 * @returns {{ schema: number, hash: string, files: number, directories: number, symlinks: number, bytes: number }}
 */
export function hashInstalledTree(root, { approvedExternalTargets = [], fsApi = fs } = {}) {
    const base = path.resolve(root);
    const rootStat = fsApi.lstatSync(base);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unsafe(`payload root ${base} must be a real directory`);
    const approved = approvedExternalTargets.filter(Boolean).map((target) => path.resolve(target));
    const digest = crypto.createHash('sha256');
    const counts = { files: 0, directories: 0, symlinks: 0, bytes: 0 };
    digest.update(`ploinky-tree-v${TREE_HASH_SCHEMA}\0`);

    const walk = (directory, relative) => {
        const names = fsApi.readdirSync(directory).sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
        for (const name of names) {
            const absolute = path.join(directory, name);
            const rel = relative ? `${relative}/${name}` : name;
            const stat = fsApi.lstatSync(absolute);
            if (stat.isSymbolicLink()) {
                const text = fsApi.readlinkSync(absolute);
                const resolved = path.resolve(path.dirname(absolute), text);
                if (!withinOrEqual(resolved, base) && !approved.some((target) => withinOrEqual(resolved, target))) {
                    throw unsafe(`symlink ${rel} escapes the payload to ${text}`);
                }
                counts.symlinks += 1;
                digest.update(`l\0${rel}\0${text}\0`);
            } else if (stat.isDirectory()) {
                counts.directories += 1;
                digest.update(`d\0${rel}\0`);
                walk(absolute, rel);
            } else if (stat.isFile()) {
                if (stat.mode & 0o6000) throw unsafe(`setuid/setgid file ${rel} is not permitted`);
                const bytes = fsApi.readFileSync(absolute);
                counts.files += 1;
                counts.bytes += bytes.length;
                const exec = (stat.mode & 0o111) ? 'x' : '-';
                digest.update(`f\0${rel}\0${exec}\0${bytes.length}\0`);
                digest.update(crypto.createHash('sha256').update(bytes).digest('hex'));
                digest.update('\0');
            } else {
                throw unsafe(`special file ${rel} is not permitted in a dependency payload`);
            }
        }
    };
    walk(base, '');
    return { schema: TREE_HASH_SCHEMA, hash: digest.digest('hex'), ...counts };
}
