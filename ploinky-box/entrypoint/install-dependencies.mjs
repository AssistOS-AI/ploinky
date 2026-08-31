#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    AGENTLIB_ENV,
    AGENTLIB_PACKAGE_NAME,
    AGENTLIB_STABLE_MOUNT_PATH,
    FORBIDDEN_BOX_AGENTLIB_PATH,
} from '../../agentlib/contract.mjs';
import { BOX_MARKER_CONTENT } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createProcessRunner } from '../process.mjs';
import {
    MCP_SDK_BUNDLE_PATH,
    validateMcpSdkBundle,
} from '../mcp-sdk-bundle.mjs';

const LOCK_PATH = path.resolve(import.meta.dirname, '../dependencies.lock.json');
export const DEPENDENCY_MARKER_NAME = '.ploinky-box-dependencies.json';
const PIN_PATTERN = /^[a-f0-9]{40}$/;

// achillesAgentLib is direct-mounted from the selected workspace source. The
// only dependency materialized into the workspace-backed Box cache is mcp-sdk,
// copied from the immutable image bundle rather than fetched during startup.
export const BOX_INSTALLED_DEPENDENCIES = Object.freeze(['mcp-sdk']);

function dependencyError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_DEPENDENCY_INSTALL_FAILED',
        cause,
    });
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => (
            [key, canonicalize(value[key])]
        )));
    }
    return value;
}

export function canonicalLockJson(lock) {
    return JSON.stringify(canonicalize(lock));
}

export function validateDependencyLock(lock) {
    if (!lock
        || JSON.stringify(Object.keys(lock).sort()) !== JSON.stringify(['repositories'])
        || !lock.repositories
        || typeof lock.repositories !== 'object'
        || Array.isArray(lock.repositories)) {
        throw dependencyError('Dependency lock must declare pinned repositories');
    }
    const expectedNames = ['achillesAgentLib', 'mcp-sdk'];
    const names = Object.keys(lock.repositories).sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
        throw dependencyError('Dependency lock must contain exactly mcp-sdk and achillesAgentLib');
    }
    for (const name of expectedNames) {
        const repository = lock.repositories[name];
        if (!repository
            || JSON.stringify(Object.keys(repository).sort()) !== JSON.stringify(['commit', 'url'])
            || typeof repository.url !== 'string'
            || !repository.url.startsWith('https://github.com/')
            || !PIN_PATTERN.test(repository.commit)) {
            throw dependencyError(`Dependency lock has an invalid immutable pin for ${name}`);
        }
    }
    return lock;
}

/**
 * The subset of the lock the Box actually installs.
 *
 * Keeping achillesAgentLib in the lock file but out of the install set is
 * deliberate: the lock remains the one canonical remote/commit policy that the
 * host-side source selector reads.
 */
export function boxInstallableRepositories(lock) {
    return Object.fromEntries(BOX_INSTALLED_DEPENDENCIES.map((name) => [name, lock.repositories[name]]));
}

export function readDependencyLock({ fsApi = fs, lockPath = LOCK_PATH } = {}) {
    let lock;
    try {
        lock = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
    } catch (error) {
        throw dependencyError(`Unable to read dependency lock ${lockPath}`, error);
    }
    return validateDependencyLock(lock);
}

function assertRealDirectory(directory, fsApi) {
    const stat = fsApi.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw dependencyError(`Dependency directory target is not a real directory: ${directory}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw dependencyError(`Dependency directory target is not owned by the current user: ${directory}`);
    }
}

function assertBoxMarker(markerPath, fsApi) {
    let bytes;
    try {
        const stat = fsApi.lstatSync(markerPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
            throw dependencyError(`Box marker is not a regular file: ${markerPath}`);
        }
        bytes = fsApi.readFileSync(markerPath);
    } catch (error) {
        if (error instanceof PloinkyBoxError) throw error;
        throw dependencyError(`Unable to validate Box marker ${markerPath}`, error);
    }
    if (!bytes.equals(Buffer.from(BOX_MARKER_CONTENT))) {
        throw dependencyError('Box marker has invalid content');
    }
}

function markerFor(lock) {
    const installable = boxInstallableRepositories(lock);
    return {
        fingerprint: crypto.createHash('sha256')
            .update(canonicalLockJson({ repositories: installable }))
            .digest('hex'),
        repositories: Object.fromEntries(Object.entries(installable).map(([name, value]) => (
            [name, value.commit]
        ))),
    };
}

function markerMatches(actual, expected) {
    return JSON.stringify(canonicalize(actual)) === JSON.stringify(canonicalize(expected));
}

function defaultReadInstalledHead(directory, _runner, {
    expectedRepository,
    expectedBundle,
    fsApi = fs,
} = {}) {
    try {
        const installed = validateMcpSdkBundle({
            sourceRoot: directory,
            expectedRepository,
            fsApi,
        });
        return installed.contentSha256 === expectedBundle?.contentSha256
            ? installed.repository.commit
            : '';
    } catch {
        return '';
    }
}

function defaultInstallRepository({
    name,
    repository,
    destination,
    sourcePath,
    expectedBundle,
    runner = createProcessRunner(),
    fsApi = fs,
}) {
    if (name !== 'mcp-sdk') {
        throw dependencyError(`The Box image has no bundled source for ${name}`);
    }
    const source = validateMcpSdkBundle({
        sourceRoot: sourcePath,
        expectedRepository: repository,
        fsApi,
    });
    if (source.contentSha256 !== expectedBundle?.contentSha256) {
        throw dependencyError('The MCP SDK image bundle changed during dependency preparation');
    }
    // GNU cp is intentional. Node's recursive copy is unreliable when the
    // destination is a macOS Podman Machine bind mount.
    try {
        runner.run('cp', ['-a', source.sourceRoot, destination]);
        // The image bundle is root-owned and read-only. Its cache copy belongs
        // to the Box user and must be movable/reparable across VirtioFS.
        runner.run('chmod', ['-R', 'u+w', destination]);
    } catch (error) {
        try { runner.run('chmod', ['-R', 'u+w', destination]); } catch {}
        throw error;
    }
}

/**
 * Prove the direct AgentLib mount before installing anything.
 *
 * The Box is a consumer, never an owner: it validates the source the supervisor
 * mounted and fails if that contract is missing, rather than obtaining a copy
 * of its own.
 */
export function validateMountedAgentLib({
    fsApi = fs,
    env = process.env,
    sourcePath = AGENTLIB_STABLE_MOUNT_PATH,
} = {}) {
    const declared = String(env?.[AGENTLIB_ENV.dir] || '').trim();
    if (declared !== sourcePath) {
        throw dependencyError(
            `${AGENTLIB_ENV.dir} must be ${sourcePath} inside the Box (got ${declared || 'unset'}). `
            + 'The host supervisor owns achillesAgentLib selection.',
        );
    }
    let stat;
    try {
        stat = fsApi.lstatSync(sourcePath);
    } catch (error) {
        throw dependencyError(`The achillesAgentLib direct mount is missing at ${sourcePath}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw dependencyError(`The achillesAgentLib direct mount at ${sourcePath} is not a real directory`);
    }
    let pkg;
    try {
        pkg = JSON.parse(fsApi.readFileSync(path.join(sourcePath, 'package.json'), 'utf8'));
    } catch (error) {
        throw dependencyError(`The achillesAgentLib direct mount at ${sourcePath} has no readable package.json`, error);
    }
    if (pkg?.name !== AGENTLIB_PACKAGE_NAME) {
        throw dependencyError(
            `The achillesAgentLib direct mount at ${sourcePath} declares package name '${String(pkg?.name)}'`,
        );
    }
    const fingerprint = String(env?.[AGENTLIB_ENV.fingerprint] || '');
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw dependencyError(`${AGENTLIB_ENV.fingerprint} must carry the selected content fingerprint`);
    }
    return Object.freeze({ sourcePath, fingerprint, mode: String(env?.[AGENTLIB_ENV.mode] || '') });
}

/**
 * Reject or remove a leftover Box-installed achillesAgentLib.
 *
 * It is removed only when it is provably Ploinky-owned cache data inside the
 * Box dependency root; ambiguous ownership fails with a cleanup instruction
 * rather than being loaded or silently deleted.
 */
export function removeForbiddenBoxAgentLib({ root, fsApi = fs }) {
    const target = path.join(root, 'achillesAgentLib');
    if (path.resolve(target) !== FORBIDDEN_BOX_AGENTLIB_PATH
        && path.dirname(path.resolve(target)) !== path.resolve(root)) {
        throw dependencyError(`Refusing AgentLib cleanup outside ${root}`);
    }
    let stat;
    try {
        stat = fsApi.lstatSync(target);
    } catch (error) {
        if (error.code === 'ENOENT') return Object.freeze({ removed: false });
        throw dependencyError(`Unable to inspect ${target}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw dependencyError(
            `${target} must not exist. achillesAgentLib is direct-mounted at `
            + `${AGENTLIB_STABLE_MOUNT_PATH}; remove ${target} and retry.`,
        );
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw dependencyError(
            `${target} is not owned by the Box runtime user, so its ownership is ambiguous. `
            + 'Remove it manually and retry.',
        );
    }
    fsApi.rmSync(target, { recursive: true, force: true });
    return Object.freeze({ removed: true, path: target });
}

function readMarker(markerPath, fsApi) {
    try {
        const stat = fsApi.lstatSync(markerPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
            return null;
        }
        return JSON.parse(fsApi.readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
}

function installationMatches({
    targetRoot,
    expected,
    lock,
    fsApi,
    runner,
    readInstalledHead,
    bundle,
}) {
    if (!markerMatches(readMarker(path.join(targetRoot, DEPENDENCY_MARKER_NAME), fsApi), expected)) {
        return false;
    }
    for (const [name, repository] of Object.entries(boxInstallableRepositories(lock))) {
        const directory = path.join(targetRoot, name);
        try {
            const stat = fsApi.lstatSync(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        } catch {
            return false;
        }
        if (readInstalledHead(directory, runner, {
            expectedRepository: repository,
            expectedBundle: bundle,
            fsApi,
        }) !== repository.commit) {
            return false;
        }
    }
    return true;
}

function safeRemoveWithin(targetRoot, target, fsApi) {
    const relative = path.relative(targetRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw dependencyError(`Refusing dependency cleanup outside ${targetRoot}`);
    }
    fsApi.rmSync(target, { recursive: true, force: true });
}

function prepareDirectoryForBackup(directory, stat, fsApi) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw dependencyError(`Refusing to repair permissions on an unowned dependency: ${directory}`);
    }
    const originalMode = stat.mode & 0o7777;
    const backupMode = originalMode | 0o700;
    if (backupMode !== originalMode) fsApi.chmodSync(directory, backupMode);
    return originalMode;
}

export function installPinnedDependencies({
    targetRoot = '/opt/ploinky/node_modules',
    markerPath = '/etc/ploinky-box',
    fsApi = fs,
    runner = createProcessRunner(),
    lock = readDependencyLock({ fsApi }),
    installRepository = defaultInstallRepository,
    readInstalledHead = defaultReadInstalledHead,
    validateBundle = validateMcpSdkBundle,
    bundledMcpSdkPath = MCP_SDK_BUNDLE_PATH,
    token = crypto.randomBytes(12).toString('hex'),
    agentLibEnv = process.env,
    agentLibPath = AGENTLIB_STABLE_MOUNT_PATH,
} = {}) {
    validateDependencyLock(lock);
    assertBoxMarker(markerPath, fsApi);
    const root = path.resolve(targetRoot);
    assertRealDirectory(root, fsApi);
    validateMountedAgentLib({ fsApi, env: agentLibEnv, sourcePath: agentLibPath });
    removeForbiddenBoxAgentLib({ root, fsApi });
    const installable = boxInstallableRepositories(lock);
    let bundle;
    try {
        bundle = validateBundle({
            sourceRoot: bundledMcpSdkPath,
            expectedRepository: lock.repositories['mcp-sdk'],
            fsApi,
        });
    } catch (error) {
        throw dependencyError('The ploinky-box image has no valid bundled MCP SDK', error);
    }
    const expected = markerFor(lock);
    if (installationMatches({
        targetRoot: root, expected, lock, fsApi, runner, readInstalledHead, bundle,
    })) {
        return Object.freeze({ changed: false, marker: expected });
    }

    const transactionRoot = path.join(root, `.ploinky-box-deps-stage-${token}`);
    try {
        fsApi.mkdirSync(transactionRoot, { recursive: false, mode: 0o700 });
    } catch (error) {
        throw dependencyError('Unable to create dependency staging directory', error);
    }
    const staged = new Map();
    const backups = new Map();
    const movedNames = new Set();
    let committed = false;
    try {
        for (const [name, repository] of Object.entries(installable)) {
            const destination = path.join(transactionRoot, name);
            installRepository({
                name,
                repository,
                destination,
                runner,
                fsApi,
                sourcePath: bundle.sourceRoot,
                expectedBundle: bundle,
            });
            if (readInstalledHead(destination, runner, {
                expectedRepository: repository,
                expectedBundle: bundle,
                fsApi,
            }) !== repository.commit) {
                throw dependencyError(`Staged ${name} does not match its immutable image bundle`);
            }
            staged.set(name, destination);
        }

        for (const name of Object.keys(installable)) {
            const destination = path.join(root, name);
            const backup = path.join(transactionRoot, `.backup-${name}`);
            try {
                const stat = fsApi.lstatSync(destination);
                const originalMode = prepareDirectoryForBackup(destination, stat, fsApi);
                try {
                    fsApi.renameSync(destination, backup);
                } catch (error) {
                    if (originalMode !== null) {
                        try { fsApi.chmodSync(destination, originalMode); } catch {}
                    }
                    throw error;
                }
                backups.set(name, { path: backup, originalMode });
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            fsApi.renameSync(staged.get(name), destination);
            movedNames.add(name);
        }
        const markerTemp = path.join(transactionRoot, DEPENDENCY_MARKER_NAME);
        fsApi.writeFileSync(markerTemp, `${JSON.stringify(expected)}\n`, {
            flag: 'wx',
            mode: 0o600,
        });
        fsApi.renameSync(markerTemp, path.join(root, DEPENDENCY_MARKER_NAME));
        committed = true;
        for (const backup of backups.values()) {
            try { safeRemoveWithin(root, backup.path, fsApi); } catch {}
        }
        return Object.freeze({ changed: true, marker: expected });
    } catch (error) {
        if (!committed) {
            for (const name of [...Object.keys(installable)].reverse()) {
                const destination = path.join(root, name);
                const backup = backups.get(name);
                if (movedNames.has(name)) {
                    try { safeRemoveWithin(root, destination, fsApi); } catch {}
                }
                if (backup) {
                    try {
                        fsApi.renameSync(backup.path, destination);
                        if (backup.originalMode !== null) {
                            fsApi.chmodSync(destination, backup.originalMode);
                        }
                    } catch {}
                }
            }
        }
        if (error instanceof PloinkyBoxError) throw error;
        throw dependencyError('Pinned dependency installation failed', error);
    } finally {
        if (!committed || fsApi.existsSync(transactionRoot)) {
            try { safeRemoveWithin(root, transactionRoot, fsApi); } catch {}
        }
    }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        installPinnedDependencies();
    } catch (error) {
        process.stderr.write(`ploinky-box dependency installation failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
