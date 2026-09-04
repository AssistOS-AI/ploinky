#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    defaultPaths, readBoundedJsonFile, readRepositoryState,
    validateReleaseManifest, validateRootPackageInstaller, validateAgentlibDeliveryMetadata,
} from './verifyCopilot421Bundle.mjs';

const COMPONENTS = ['achillesAgentLib', 'ploinky', 'achillesCLI', 'explorer'];
const HASH = /^[0-9a-f]{64}$/;
function reject(message) {
    throw new Error(`Local snapshot bundle rejected: ${message}`);
}
function exactKeys(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        reject(`${label} must contain exactly ${keys.join(', ')}`);
    }
}

// Include the working bytes and modes of all tracked and nonignored untracked
// source files. Git metadata and ignored dependency/runtime output are excluded.
export function readSourceTreeDigest(repositoryPath) {
    readRepositoryState(repositoryPath);
    const root = fs.realpathSync(repositoryPath);
    const rootIdentity = fs.statSync(root, { bigint: true });
    const enumerate = () => {
        const listing = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
        });
        if (listing.error || listing.status !== 0) reject('unable to enumerate source files');
        return [...new Set(listing.stdout.split('\0').filter(Boolean))].sort();
    };
    const names = enumerate();
    if (!names.length || names.length > 200_000) reject('invalid source file count');
    const tree = crypto.createHash('sha256');
    const identities = new Map();
    const signature = stat => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].map(key => String(stat[key])).join(':');
    for (const name of names) {
        if (path.isAbsolute(name) || name.split('/').some(part => part === '..' || part === '.git')) {
            reject('invalid source path');
        }
        const file = path.join(root, name);
        let before;
        try { before = fs.lstatSync(file, { bigint: true }); }
        catch (error) {
            if (error.code === 'ENOENT') {
                identities.set(file, null);
                continue; // A recorded deletion.
            }
            throw error;
        }
        const parent = fs.realpathSync(path.dirname(file));
        if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) reject('source path escapes repository');
        let digest;
        let mode;
        if (before.isSymbolicLink()) {
            mode = '120000';
            const target = fs.readlinkSync(file);
            const resolved = path.resolve(path.dirname(file), target);
            if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) reject('source symlink escapes repository');
            digest = crypto.createHash('sha256').update(target).digest('hex');
        } else if (before.isFile() && before.nlink === 1n && before.size <= 128n * 1024n * 1024n) {
            mode = before.mode & 0o111n ? '100755' : '100644';
            const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
                const opened = fs.fstatSync(descriptor, { bigint: true });
                if (opened.dev !== before.dev || opened.ino !== before.ino) reject('source identity changed');
                const hash = crypto.createHash('sha256');
                const chunk = Buffer.alloc(64 * 1024);
                let count;
                let total = 0n;
                while ((count = fs.readSync(descriptor, chunk)) > 0) {
                    total += BigInt(count);
                    if (total > before.size) reject('source changed while hashing');
                    hash.update(chunk.subarray(0, count));
                }
                if (total !== before.size) reject('source changed while hashing');
                digest = hash.digest('hex');
            } finally { fs.closeSync(descriptor); }
        } else {
            reject(`unsupported source entry: ${name}`);
        }
        const after = fs.lstatSync(file, { bigint: true });
        if (signature(before) !== signature(after)) reject('source changed while hashing');
        identities.set(file, signature(after));
        tree.update(JSON.stringify([name, mode, digest]) + '\n');
    }
    if (JSON.stringify(names) !== JSON.stringify(enumerate())) reject('source inventory changed while hashing');
    for (const [file, identity] of identities) {
        let current = null;
        try { current = signature(fs.lstatSync(file, { bigint: true })); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current !== identity) reject('source changed while hashing');
    }
    const finalRoot = fs.statSync(root, { bigint: true });
    if (finalRoot.dev !== rootIdentity.dev || finalRoot.ino !== rootIdentity.ino
        || fs.realpathSync(repositoryPath) !== root) reject('repository identity changed while hashing');
    return tree.digest('hex');
}

export function verifyLocalSnapshotBundle(manifest, {
    paths = defaultPaths(), readJson = readBoundedJsonFile,
    inspectRepository = readRepositoryState, hashRepository = readSourceTreeDigest,
} = {}) {
    exactKeys(manifest, ['kind', 'release', 'trees'], 'snapshot manifest');
    if (manifest.kind !== 'local-snapshot-v1') reject('unsupported snapshot kind');
    exactKeys(manifest.trees, COMPONENTS, 'snapshot trees');
    const validated = validateReleaseManifest(manifest.release);
    validateRootPackageInstaller({
        rootPackage: readJson(paths.rootPackage, { label: 'root package' }),
        rootPackagePath: paths.rootPackage, dependencyLockPath: paths.dependencyLock,
    });
    validateAgentlibDeliveryMetadata({
        globalPackage: readJson(paths.globalPackage, { label: 'globalDeps package' }),
        dependencyLock: readJson(paths.dependencyLock, { label: 'Box dependency lock' }),
        expectedCommit: validated.commits.achillesAgentLib,
    });
    const repositories = {};
    for (const name of COMPONENTS) {
        if (!HASH.test(manifest.trees[name])) reject(`${name} needs an exact SHA-256 tree digest`);
        const before = inspectRepository(paths[name]);
        if (before.head !== validated.commits[name]) reject(`${name} base commit changed`);
        const treeSha256 = hashRepository(paths[name]);
        if (treeSha256 !== manifest.trees[name]) reject(`${name} source tree changed`);
        if (inspectRepository(paths[name]).head !== before.head) reject(`${name} HEAD changed during verification`);
        repositories[name] = Object.freeze({ name, repositoryPath: paths[name], commit: before.head, treeSha256 });
    }
    return Object.freeze({ verificationMode: 'local-snapshot', repositories: Object.freeze(repositories), imageDigest: validated.digest });
}

export function verifyManifestFile(manifestPath, options = {}) {
    return verifyLocalSnapshotBundle((options.readJson || readBoundedJsonFile)(manifestPath, {
        label: 'local snapshot manifest',
    }), options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 4 || process.argv[2] !== '--manifest' || !path.isAbsolute(process.argv[3])) {
            reject('usage: verifyLocalSnapshotBundle.mjs --manifest /absolute/snapshot.json');
        }
        const result = verifyManifestFile(process.argv[3]);
        process.stdout.write(`Local development snapshot verified (${result.imageDigest}); this is not release acceptance.\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
