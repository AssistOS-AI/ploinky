#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const LOCKED_ROOT_POSTINSTALL = 'node ./ploinky-box/entrypoint/install-dependencies.mjs';
const ROOT_DEPENDENCY_LOCK_PATH = path.join('ploinky-box', 'dependencies.lock.json');

const REPOSITORY_COMPONENTS = Object.freeze([
    ['achillesAgentLib', 'agentlibSha'],
    ['ploinky', 'ploinkySha'],
    ['achillesCLI', 'achillescliSha'],
    ['explorer', 'explorerSha'],
]);

const REQUIRED_GATE_OPTIONS = Object.freeze([
    'agentlibSha',
    'ploinkySha',
    'achillescliSha',
    'explorerSha',
    'boxDigest',
]);

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function bundleError(message, cause) {
    const error = new Error(`Copilot 421 release bundle rejected: ${message}`, { cause });
    error.code = 'PLOINKY_COPILOT_421_BUNDLE_REJECTED';
    return error;
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw bundleError(`${label} must be an object`);
    }
}

function assertExactKeys(value, expectedKeys, label) {
    assertPlainObject(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw bundleError(`${label} must contain exactly ${expected.join(', ')}`);
    }
}

function assertExactSha(value, label) {
    if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
        throw bundleError(`${label} must be an exact lowercase 40-hex commit`);
    }
    return value;
}

function assertImmutableImageDigest(value, label) {
    if (typeof value !== 'string' || !IMAGE_DIGEST_PATTERN.test(value)) {
        throw bundleError(`${label} must be an immutable sha256:<64 lowercase hex> digest`);
    }
    return value;
}

function validateReleaseManifest(manifest) {
    assertExactKeys(manifest, ['images', 'repositories'], 'release manifest');
    assertExactKeys(
        manifest.repositories,
        REPOSITORY_COMPONENTS.map(([name]) => name),
        'release manifest repositories',
    );
    assertExactKeys(manifest.images, ['ploinkyBox'], 'release manifest images');

    const commits = {};
    for (const [name] of REPOSITORY_COMPONENTS) {
        const component = manifest.repositories[name];
        assertExactKeys(component, ['commit'], `release manifest repository ${name}`);
        commits[name] = assertExactSha(component.commit, `${name} commit`);
    }

    const image = manifest.images.ploinkyBox;
    assertExactKeys(image, ['digest'], 'release manifest image ploinkyBox');
    const digest = assertImmutableImageDigest(image.digest, 'ploinkyBox image digest');

    return Object.freeze({
        commits: Object.freeze(commits),
        digest,
    });
}

function readBoundedJsonFile(filePath, {
    fsApi = fs,
    label = 'JSON file',
} = {}) {
    let pathStat;
    try {
        pathStat = fsApi.lstatSync(filePath, { bigint: true });
    } catch (error) {
        throw bundleError(`unable to inspect ${label}`, error);
    }
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1n) {
        throw bundleError(`${label} must be a single-link regular file`);
    }
    if (pathStat.size > BigInt(MAX_MANIFEST_BYTES)) {
        throw bundleError(`${label} exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    const constants = fsApi.constants || fs.constants;
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            filePath,
            constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
        );
        const opened = fsApi.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n
            || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
            throw bundleError(`${label} identity changed while opening`);
        }
        if (opened.size > BigInt(MAX_MANIFEST_BYTES)) {
            throw bundleError(`${label} exceeds ${MAX_MANIFEST_BYTES} bytes`);
        }
        const expectedBytes = Number(opened.size);
        const body = Buffer.alloc(expectedBytes);
        let offset = 0;
        while (offset < body.length) {
            const read = fsApi.readSync(descriptor, body, offset, body.length - offset, offset);
            if (read <= 0) throw bundleError(`${label} changed size while reading`);
            offset += read;
        }
        const overflow = Buffer.alloc(1);
        if (fsApi.readSync(descriptor, overflow, 0, 1, offset) !== 0) {
            throw bundleError(`${label} changed size while reading`);
        }
        const afterRead = fsApi.fstatSync(descriptor, { bigint: true });
        if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino
            || afterRead.size !== opened.size
            || afterRead.mtimeNs !== opened.mtimeNs
            || afterRead.ctimeNs !== opened.ctimeNs) {
            throw bundleError(`${label} changed while reading`);
        }
        const afterPath = fsApi.lstatSync(filePath, { bigint: true });
        if (afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.nlink !== 1n
            || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
            || afterPath.size !== opened.size
            || afterPath.mtimeNs !== opened.mtimeNs
            || afterPath.ctimeNs !== opened.ctimeNs) {
            throw bundleError(`${label} path identity changed while reading`);
        }
        return JSON.parse(body.toString('utf8'));
    } catch (error) {
        if (error?.code === 'PLOINKY_COPILOT_421_BUNDLE_REJECTED') throw error;
        throw bundleError(`unable to parse ${label}`, error);
    } finally {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) {}
        }
    }
}

function canonicalGitUrl(value, label) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw bundleError(`${label} has an invalid repository URL`, error);
    }
    if (parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash) {
        throw bundleError(`${label} repository URL must be credentialless HTTPS`);
    }
    const pathname = parsed.pathname.replace(/\/$/, '').toLowerCase();
    return `https://${parsed.hostname.toLowerCase()}${pathname}`;
}

function parseExactGitCommitSpec(value, label = 'dependency spec') {
    if (typeof value !== 'string' || value !== value.trim()) {
        throw bundleError(`${label} must be an exact git+https dependency spec`);
    }
    const match = /^git\+(https:\/\/[^#\s]+)#([0-9a-f]{40})$/.exec(value);
    if (!match) {
        throw bundleError(`${label} must end in an exact lowercase 40-hex commit; branch/spec fallback is forbidden`);
    }
    return Object.freeze({
        repositoryUrl: canonicalGitUrl(match[1], label),
        commit: match[2],
    });
}


/**
 * achillesAgentLib delivery policy for a release bundle.
 *
 * The Box dependency lock is now the one canonical source policy: the library is
 * direct-mounted from the selected workspace source, so `globalDeps` must NOT
 * declare it as an npm dependency any more. A bundle that still does would ship
 * a second, independently installed copy.
 */
function validateAgentlibDeliveryMetadata({
    globalPackage,
    dependencyLock,
    expectedCommit,
}) {
    assertExactSha(expectedCommit, 'expected AgentLib commit');
    assertPlainObject(globalPackage, 'globalDeps package');
    assertPlainObject(globalPackage.dependencies, 'globalDeps dependencies');
    if (Object.hasOwn(globalPackage.dependencies, 'achillesAgentLib')) {
        throw bundleError(
            'globalDeps must not declare achillesAgentLib: it is direct-mounted from the '
            + 'selected workspace source, not installed by npm',
        );
    }

    assertPlainObject(dependencyLock, 'Box dependency lock');
    assertPlainObject(dependencyLock.repositories, 'Box dependency lock repositories');
    const locked = dependencyLock.repositories.achillesAgentLib;
    assertPlainObject(locked, 'Box dependency lock achillesAgentLib');
    const lockedCommit = assertExactSha(
        locked.commit,
        'Box dependency lock achillesAgentLib commit',
    );
    const lockedUrl = canonicalGitUrl(
        locked.url,
        'Box dependency lock achillesAgentLib',
    );

    if (lockedCommit !== expectedCommit) {
        throw bundleError('manifest and Box lock must name the same AgentLib commit');
    }
    return Object.freeze({ commit: expectedCommit, repositoryUrl: lockedUrl });
}

function validateRootPackageInstaller({
    rootPackage,
    rootPackagePath,
    dependencyLockPath,
}) {
    assertPlainObject(rootPackage, 'root package');
    assertPlainObject(rootPackage.scripts, 'root package scripts');
    const postinstall = rootPackage.scripts.postinstall;
    if (postinstall !== LOCKED_ROOT_POSTINSTALL) {
        throw bundleError(
            'root package postinstall must use the immutable Box dependency-lock installer; '
            + 'clone, move, branch, and arbitrary dependency specs are forbidden',
        );
    }
    const expectedLockPath = path.resolve(
        path.dirname(rootPackagePath),
        ROOT_DEPENDENCY_LOCK_PATH,
    );
    if (path.resolve(dependencyLockPath) !== expectedLockPath) {
        throw bundleError(
            `root package installer must be tied to ${ROOT_DEPENDENCY_LOCK_PATH}`,
        );
    }
    return Object.freeze({
        postinstall,
        dependencyLockPath: expectedLockPath,
    });
}

function runGit(repositoryPath, args) {
    const result = spawnSync('git', ['-C', repositoryPath, ...args], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        throw bundleError(`unable to inspect repository ${repositoryPath}`, result.error);
    }
    return String(result.stdout || '').trim();
}

function readRepositoryState(repositoryPath, { fsApi = fs } = {}) {
    let stat;
    try {
        stat = fsApi.lstatSync(repositoryPath);
    } catch (error) {
        throw bundleError(`unable to inspect repository path ${repositoryPath}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw bundleError(`repository path must be a real directory: ${repositoryPath}`);
    }
    const expectedRoot = fsApi.realpathSync(repositoryPath);
    const actualRoot = fsApi.realpathSync(runGit(repositoryPath, ['rev-parse', '--show-toplevel']));
    if (actualRoot !== expectedRoot) {
        throw bundleError(`repository path is not its Git top level: ${repositoryPath}`);
    }
    const head = runGit(repositoryPath, ['rev-parse', 'HEAD']);
    assertExactSha(head, `installed repository HEAD for ${repositoryPath}`);
    const status = runGit(repositoryPath, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignore-submodules=none',
    ]);
    return Object.freeze({
        head,
        clean: status.length === 0,
    });
}

function verifyRepositoryState({ name, expectedCommit, repositoryPath, state }) {
    assertPlainObject(state, `${name} repository state`);
    const actualCommit = assertExactSha(state.head, `${name} repository HEAD`);
    if (actualCommit !== expectedCommit) {
        throw bundleError(`${name} installed HEAD does not match the release manifest`);
    }
    if (state.clean !== true) {
        throw bundleError(`${name} repository has uncommitted or untracked content`);
    }
    return Object.freeze({ name, repositoryPath, commit: actualCommit });
}

function defaultPaths(root = repositoryRoot) {
    return Object.freeze({
        ploinky: root,
        // The workspace-local checkout convention: a release deployment selects
        // <workspace>/achillesAgentLib, never an install tree under node_modules.
        achillesAgentLib: path.join(root, 'achillesAgentLib'),
        achillesCLI: path.resolve(root, '..', 'AchillesCLI'),
        explorer: path.resolve(root, '..', 'AssistOSExplorer'),
        rootPackage: path.join(root, 'package.json'),
        globalPackage: path.join(root, 'globalDeps', 'package.json'),
        dependencyLock: path.join(root, 'ploinky-box', 'dependencies.lock.json'),
    });
}

function verifyReleaseBundle(manifest, {
    paths = defaultPaths(),
    readJson = readBoundedJsonFile,
    inspectRepository = readRepositoryState,
} = {}) {
    const validated = validateReleaseManifest(manifest);
    const rootPackage = readJson(paths.rootPackage, { label: 'root package' });
    const globalPackage = readJson(paths.globalPackage, { label: 'globalDeps package' });
    const dependencyLock = readJson(paths.dependencyLock, { label: 'Box dependency lock' });
    validateRootPackageInstaller({
        rootPackage,
        rootPackagePath: paths.rootPackage,
        dependencyLockPath: paths.dependencyLock,
    });
    validateAgentlibDeliveryMetadata({
        globalPackage,
        dependencyLock,
        expectedCommit: validated.commits.achillesAgentLib,
    });

    const repositories = {};
    for (const [name] of REPOSITORY_COMPONENTS) {
        repositories[name] = verifyRepositoryState({
            name,
            expectedCommit: validated.commits[name],
            repositoryPath: paths[name],
            state: inspectRepository(paths[name], { name }),
        });
    }
    return Object.freeze({
        repositories: Object.freeze(repositories),
        imageDigest: validated.digest,
    });
}

function parseCommandLine(argv) {
    const options = {
        manifest: '',
        branchFallback: '',
        requirements: Object.fromEntries(REQUIRED_GATE_OPTIONS.map((name) => [name, false])),
    };
    const requirementFlags = new Map([
        ['--require-agentlib-sha', 'agentlibSha'],
        ['--require-ploinky-sha', 'ploinkySha'],
        ['--require-achillescli-sha', 'achillescliSha'],
        ['--require-explorer-sha', 'explorerSha'],
        ['--require-box-digest', 'boxDigest'],
    ]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (requirementFlags.has(argument)) {
            options.requirements[requirementFlags.get(argument)] = true;
            continue;
        }
        if (argument === '--manifest' || argument === '--branch-fallback') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) {
                throw bundleError(`${argument} requires a value`);
            }
            index += 1;
            if (argument === '--manifest') options.manifest = value;
            else options.branchFallback = value;
            continue;
        }
        throw bundleError(`unknown argument ${argument}`);
    }
    if (!options.manifest || !path.isAbsolute(options.manifest)) {
        throw bundleError('--manifest must be an absolute path');
    }
    if (options.branchFallback !== 'fail') {
        throw bundleError('--branch-fallback fail is mandatory');
    }
    const missingGates = REQUIRED_GATE_OPTIONS.filter((name) => !options.requirements[name]);
    if (missingGates.length > 0) {
        throw bundleError(`missing required immutable-evidence gates: ${missingGates.join(', ')}`);
    }
    return Object.freeze(options);
}

function verifyManifestFile(manifestPath, options = {}) {
    const manifest = (options.readJson || readBoundedJsonFile)(manifestPath, {
        label: 'release manifest',
    });
    return verifyReleaseBundle(manifest, options);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const options = parseCommandLine(process.argv.slice(2));
        const result = verifyManifestFile(options.manifest);
        process.stdout.write(
            `Copilot 421 release bundle verified (${result.imageDigest})\n`,
        );
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

export {
    LOCKED_ROOT_POSTINSTALL,
    defaultPaths,
    parseCommandLine,
    parseExactGitCommitSpec,
    readBoundedJsonFile,
    readRepositoryState,
    validateAgentlibDeliveryMetadata,
    validateReleaseManifest,
    validateRootPackageInstaller,
    verifyManifestFile,
    verifyReleaseBundle,
};
