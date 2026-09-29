#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    AGENTLIB_ENV,
    AGENTLIB_PACKAGE_NAME,
    AGENTLIB_REQUIRED_ENTRYPOINTS,
    AGENTLIB_STABLE_MOUNT_PATH,
    BOX_IMAGE_ID_ENV,
    FORBIDDEN_BOX_AGENTLIB_PATH,
    assertSupplyingImageId,
    imageSourceIdHash,
    imageSourceIdentity,
} from '../../agentlib/contract.mjs';
import { BOX_MARKER_CONTENT } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createProcessRunner } from '../process.mjs';
import {
    MCP_SDK_BUNDLE_PATH,
    MCP_SDK_LIBRARY_NAME,
    assertMcpSdkTree,
    mcpSdkIdentity,
    readMcpSdkPackage,
} from '../mcp-sdk-bundle.mjs';

export const DEPENDENCY_MARKER_NAME = '.ploinky-box-dependencies.json';
export const DEPENDENCY_MARKER_SCHEMA = 'ploinky.box.dependencies/v2';

// AchillesAgentLib comes from a selected local mount or the Box image. The only
// library materialized into the workspace-backed Box cache is mcp-sdk, copied
// from the package the Box image supplies rather than fetched during startup.
export const BOX_INSTALLED_DEPENDENCIES = Object.freeze([MCP_SDK_LIBRARY_NAME]);

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

/**
 * The outer Box image ID every process in this Box inherits from the host's
 * container creation. It must be the canonical immutable spelling.
 */
function boxSupplyingImageId(env) {
    try {
        return assertSupplyingImageId(env?.[BOX_IMAGE_ID_ENV], `${BOX_IMAGE_ID_ENV} value`);
    } catch (error) {
        throw dependencyError(
            `${BOX_IMAGE_ID_ENV} must carry the immutable Box image ID set when the host created this Box`,
            error,
        );
    }
}

/** The completion marker of the Box dependency cache: which supplied libraries it holds. */
function markerFor(supplyingImageId) {
    return {
        schema: DEPENDENCY_MARKER_SCHEMA,
        providedLibraries: { [MCP_SDK_LIBRARY_NAME]: mcpSdkIdentity(supplyingImageId) },
    };
}

function markerMatches(actual, expected) {
    return JSON.stringify(canonicalize(actual)) === JSON.stringify(canonicalize(expected));
}

/**
 * Whether an installed or staged copy is a usable SDK package with a plain
 * file tree. A matching marker never bypasses the structural checks; no file
 * body is hashed.
 */
function defaultInstalledPackageUsable(directory, { fsApi = fs } = {}) {
    try {
        readMcpSdkPackage({ sourceRoot: directory, fsApi });
        assertMcpSdkTree(directory, fsApi);
        return true;
    } catch {
        return false;
    }
}

function defaultInstallLibrary({
    name,
    destination,
    sourcePath,
    runner = createProcessRunner(),
    fsApi = fs,
}) {
    if (name !== MCP_SDK_LIBRARY_NAME) {
        throw dependencyError(`The Box image has no supplied source for ${name}`);
    }
    const source = readMcpSdkPackage({ sourceRoot: sourcePath, fsApi });
    assertMcpSdkTree(source.sourceRoot, fsApi);
    // GNU cp is intentional. Node's recursive copy is unreliable when the
    // destination is a macOS Podman Machine bind mount.
    try {
        runner.run('cp', ['-a', source.sourceRoot, destination]);
        // The image package is root-owned and read-only. Its cache copy belongs
        // to the Box user and must be movable/reparable across VirtioFS.
        runner.run('chmod', ['-R', 'u+w', destination]);
    } catch (error) {
        try { runner.run('chmod', ['-R', 'u+w', destination]); } catch {}
        throw error;
    }
}

/**
 * Prove the selected AgentLib before installing anything.
 *
 * The Box is a consumer, never an owner: it validates the source the supervisor
 * selected and fails if that contract is missing, rather than obtaining a copy
 * of its own. A local source is the mounted checkout; an image source is the
 * copy the Box image supplies, identified by the Box image ID and checked as a
 * package (no content is hashed and no revision is compared).
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
    const mode = String(env?.[AGENTLIB_ENV.mode] || '');
    if (mode === 'image') {
        const supplyingImageId = boxSupplyingImageId(env);
        if (String(env?.[AGENTLIB_ENV.sourceId] || '') !== imageSourceIdHash(imageSourceIdentity(supplyingImageId))) {
            throw dependencyError('The image AgentLib source identity does not match the Box image that supplies it');
        }
        for (const entry of AGENTLIB_REQUIRED_ENTRYPOINTS) {
            let entryStat;
            try {
                entryStat = fsApi.statSync(path.join(sourcePath, entry));
            } catch (error) {
                throw dependencyError(`The Box image achillesAgentLib is missing required entry point ${entry}`, error);
            }
            if (!entryStat.isFile()) {
                throw dependencyError(`The Box image achillesAgentLib entry point ${entry} is not a regular file`);
            }
        }
        return Object.freeze({ sourcePath, mode, supplyingImageId });
    }
    const fingerprint = String(env?.[AGENTLIB_ENV.fingerprint] || '');
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw dependencyError(`${AGENTLIB_ENV.fingerprint} must carry the selected content fingerprint`);
    }
    return Object.freeze({ sourcePath, fingerprint, mode });
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
    fsApi,
    installedPackageUsable,
}) {
    // Any other marker content, including absence or an earlier shape, is a
    // miss: the copy is replaced through the normal transaction below.
    if (!markerMatches(readMarker(path.join(targetRoot, DEPENDENCY_MARKER_NAME), fsApi), expected)) {
        return false;
    }
    for (const name of BOX_INSTALLED_DEPENDENCIES) {
        const directory = path.join(targetRoot, name);
        try {
            const stat = fsApi.lstatSync(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        } catch {
            return false;
        }
        if (!installedPackageUsable(directory, { fsApi })) return false;
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

/**
 * Prepare the Box dependency cache from what the Box image supplies.
 *
 * The cache is fresh when its marker names the outer Box image that supplies
 * the libraries and the copy is a usable package. Otherwise the copy is
 * replaced transactionally and the marker is written last, so a partial copy is
 * never reusable.
 */
export function prepareImageDependencies({
    targetRoot = '/opt/ploinky/node_modules',
    markerPath = '/etc/ploinky-box',
    fsApi = fs,
    runner = createProcessRunner(),
    installLibrary = defaultInstallLibrary,
    installedPackageUsable = defaultInstalledPackageUsable,
    readBundle = readMcpSdkPackage,
    bundledMcpSdkPath = MCP_SDK_BUNDLE_PATH,
    token = crypto.randomBytes(12).toString('hex'),
    env = process.env,
    agentLibPath = AGENTLIB_STABLE_MOUNT_PATH,
} = {}) {
    assertBoxMarker(markerPath, fsApi);
    const root = path.resolve(targetRoot);
    assertRealDirectory(root, fsApi);
    validateMountedAgentLib({ fsApi, env, sourcePath: agentLibPath });
    // Validate the supplier identity and the supplied package before anything
    // is cleaned up or replaced: a Box without a valid identity mutates nothing.
    const supplyingImageId = boxSupplyingImageId(env);
    let bundle;
    try {
        bundle = readBundle({ sourceRoot: bundledMcpSdkPath, fsApi });
    } catch (error) {
        throw dependencyError('The ploinky-box image has no usable bundled MCP SDK', error);
    }
    removeForbiddenBoxAgentLib({ root, fsApi });
    const expected = markerFor(supplyingImageId);
    if (installationMatches({ targetRoot: root, expected, fsApi, installedPackageUsable })) {
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
    const markerFile = path.join(root, DEPENDENCY_MARKER_NAME);
    const markerBackup = path.join(transactionRoot, `.backup-${DEPENDENCY_MARKER_NAME}`);
    let markerMoved = false;
    let committed = false;
    try {
        for (const name of BOX_INSTALLED_DEPENDENCIES) {
            const destination = path.join(transactionRoot, name);
            installLibrary({
                name,
                destination,
                runner,
                fsApi,
                sourcePath: bundle.sourceRoot,
            });
            if (!installedPackageUsable(destination, { fsApi })) {
                throw dependencyError(`Staged ${name} is not a usable package copied from the Box image`);
            }
            staged.set(name, destination);
        }

        // The previous marker leaves before any copy is swapped in. No bytes are
        // compared any more, so from here until the new marker is written an
        // interrupted preparation must read as a miss, never as a finished copy
        // for the image the old marker names.
        try {
            fsApi.renameSync(markerFile, markerBackup);
            markerMoved = true;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        for (const name of BOX_INSTALLED_DEPENDENCIES) {
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
        fsApi.renameSync(markerTemp, markerFile);
        committed = true;
        for (const backup of backups.values()) {
            try { safeRemoveWithin(root, backup.path, fsApi); } catch {}
        }
        return Object.freeze({ changed: true, marker: expected });
    } catch (error) {
        if (!committed) {
            for (const name of [...BOX_INSTALLED_DEPENDENCIES].reverse()) {
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
            // The previous copy is back, so its marker may name it again.
            if (markerMoved) {
                try { fsApi.renameSync(markerBackup, markerFile); } catch {}
            }
        }
        if (error instanceof PloinkyBoxError) throw error;
        throw dependencyError('Box dependency preparation failed', error);
    } finally {
        if (!committed || fsApi.existsSync(transactionRoot)) {
            try { safeRemoveWithin(root, transactionRoot, fsApi); } catch {}
        }
    }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        prepareImageDependencies();
    } catch (error) {
        process.stderr.write(`ploinky-box dependency installation failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
