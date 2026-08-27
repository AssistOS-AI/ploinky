#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOX_MARKER_CONTENT } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createProcessRunner } from '../process.mjs';

const LOCK_PATH = path.resolve(import.meta.dirname, '../dependencies.lock.json');
export const DEPENDENCY_MARKER_NAME = '.ploinky-box-dependencies.json';
export const LOCAL_AGENTLIB_DIRECTORY = '.ploinky-local-agentlib';
export const LOCAL_AGENTLIB_SHA_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_IDENTITY_PATTERN = /^local:([a-f0-9]{64})$/;
const PIN_PATTERN = /^[a-f0-9]{40}$/;

function dependencyError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_DEPENDENCY_INSTALL_FAILED',
        cause,
    });
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
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

function desiredIdentities(lock, agentlibIdentity = lock.repositories.achillesAgentLib.commit) {
    return {
        'mcp-sdk': lock.repositories['mcp-sdk'].commit,
        achillesAgentLib: agentlibIdentity,
    };
}

function markerFor(lock, agentlibIdentity = lock.repositories.achillesAgentLib.commit) {
    const repositories = desiredIdentities(lock, agentlibIdentity);
    const fingerprintInput = LOCAL_IDENTITY_PATTERN.test(agentlibIdentity)
        ? canonicalLockJson({ lock, repositories })
        : canonicalLockJson(lock);
    return {
        fingerprint: crypto.createHash('sha256').update(fingerprintInput).digest('hex'),
        repositories,
    };
}

function markerMatches(actual, expected) {
    return JSON.stringify(canonicalize(actual)) === JSON.stringify(canonicalize(expected));
}

function defaultReadInstalledHead(directory, runner, options = {}) {
    const result = runner.query('git', ['-C', directory, 'rev-parse', 'HEAD'], options);
    if (!result.ok) return '';
    return String(result.stdout || '').trim();
}

function installerEnvironment(destination) {
    const privateHome = path.join(destination, '.installer-home');
    const privateTmp = path.join(destination, '.installer-tmp');
    const npmCache = path.join(destination, '.npm-cache');
    return {
        transient: [privateHome, privateTmp, npmCache],
        env: {
            PATH: String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin'),
            HOME: privateHome,
            TMPDIR: privateTmp,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            npm_config_cache: npmCache,
            npm_config_update_notifier: 'false',
        },
    };
}

function defaultInstallRepository({ name, repository, destination, runner, fsApi = fs }) {
    const tools = installerEnvironment(destination);
    fsApi.mkdirSync(tools.env.HOME, { recursive: true, mode: 0o700 });
    fsApi.mkdirSync(tools.env.TMPDIR, { recursive: true, mode: 0o700 });
    try {
        runner.run('git', ['init', destination], { env: tools.env });
        runner.run('git', ['-C', destination, 'remote', 'add', 'origin', repository.url], { env: tools.env });
        runner.run('git', ['-C', destination, 'fetch', '--depth', '1', 'origin', repository.commit], { env: tools.env });
        runner.run('git', ['-C', destination, 'checkout', '--detach', repository.commit], { env: tools.env });
        runner.run('npm', [
            'install', '--no-package-lock', '--no-audit', '--no-fund',
        ], { cwd: destination, env: tools.env });
        const head = defaultReadInstalledHead(destination, runner, { env: tools.env });
        if (head !== repository.commit) {
            throw dependencyError(`Installed ${name} HEAD does not match its immutable pin`);
        }
    } finally {
        for (const transient of tools.transient) {
            try { fsApi.rmSync(transient, { recursive: true, force: true }); } catch {}
        }
    }
}

function packageEntryPoint(pkg) {
    const rootExport = pkg?.exports?.['.'];
    const exported = typeof pkg?.exports === 'string'
        ? pkg.exports
        : typeof rootExport === 'string'
            ? rootExport
            : rootExport?.import || rootExport?.default || rootExport?.require;
    return String(pkg?.main || exported || '').replace(/^\.\//, '');
}

function validateAgentlibPackage(directory, fsApi) {
    const packagePath = path.join(directory, 'package.json');
    let stat;
    let pkg;
    try {
        stat = fsApi.lstatSync(packagePath);
        pkg = JSON.parse(fsApi.readFileSync(packagePath, 'utf8'));
    } catch (error) {
        throw dependencyError(`Installed AchillesAgentLib package is invalid at ${packagePath}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || pkg.name !== 'ploinky-agent-lib') {
        throw dependencyError('Installed AchillesAgentLib package has an invalid package.json');
    }
    const entryPoint = packageEntryPoint(pkg);
    const entryPath = path.resolve(directory, entryPoint);
    if (!entryPoint || !entryPath.startsWith(`${path.resolve(directory)}${path.sep}`)) {
        throw dependencyError('Installed AchillesAgentLib package has an invalid entry point');
    }
    let entryStat;
    try { entryStat = fsApi.lstatSync(entryPath); } catch (error) {
        throw dependencyError('Installed AchillesAgentLib package entry point is missing', error);
    }
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
        throw dependencyError('Installed AchillesAgentLib package entry point is not a regular file');
    }
    return true;
}

function sha256File(filePath, fsApi) {
    return crypto.createHash('sha256').update(fsApi.readFileSync(filePath)).digest('hex');
}

function localArchivePath(targetRoot, sha256) {
    return path.join(targetRoot, LOCAL_AGENTLIB_DIRECTORY, `${sha256}.tgz`);
}

function validateLocalArchive(targetRoot, sha256, fsApi) {
    if (!LOCAL_AGENTLIB_SHA_PATTERN.test(String(sha256 || ''))) {
        throw dependencyError('Local AchillesAgentLib SHA must be 64 lowercase hexadecimal characters');
    }
    const archiveDirectory = path.join(targetRoot, LOCAL_AGENTLIB_DIRECTORY);
    let directoryStat;
    try { directoryStat = fsApi.lstatSync(archiveDirectory); } catch (error) {
        throw dependencyError(`Local AchillesAgentLib archive directory is missing: ${archiveDirectory}`, error);
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw dependencyError('Local AchillesAgentLib archive directory is not a real directory');
    }
    const archivePath = localArchivePath(targetRoot, sha256);
    let stat;
    try { stat = fsApi.lstatSync(archivePath); } catch (error) {
        throw dependencyError(`Local AchillesAgentLib archive is missing: ${archivePath}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw dependencyError('Local AchillesAgentLib archive is not a regular file');
    }
    if (sha256File(archivePath, fsApi) !== sha256) {
        throw dependencyError('Local AchillesAgentLib archive SHA-256 does not match its selected identity');
    }
    return archivePath;
}

function defaultInstallLocalAgentlib({ archivePath, destination, runner, fsApi = fs }) {
    fsApi.mkdirSync(destination, { recursive: false, mode: 0o700 });
    runner.run('tar', [
        '-xzf', archivePath, '--strip-components=1', '-C', destination,
    ]);
    validateAgentlibPackage(destination, fsApi);
    const tools = installerEnvironment(destination);
    fsApi.mkdirSync(tools.env.HOME, { recursive: true, mode: 0o700 });
    fsApi.mkdirSync(tools.env.TMPDIR, { recursive: true, mode: 0o700 });
    try {
        runner.run('npm', [
            'install', '--no-package-lock', '--no-audit', '--no-fund',
        ], { cwd: destination, env: tools.env });
        validateAgentlibPackage(destination, fsApi);
    } finally {
        for (const transient of tools.transient) {
            try { fsApi.rmSync(transient, { recursive: true, force: true }); } catch {}
        }
    }
}

function readMarker(markerPath, fsApi) {
    try {
        const stat = fsApi.lstatSync(markerPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return null;
        return JSON.parse(fsApi.readFileSync(markerPath, 'utf8'));
    } catch {
        return null;
    }
}

function entryExists(target, fsApi) {
    try {
        fsApi.lstatSync(target);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw dependencyError(`Unable to inspect existing dependency state: ${target}`, error);
    }
}

function dependencyMatches({
    name,
    desiredIdentity,
    targetRoot,
    marker,
    lock,
    fsApi,
    runner,
    readInstalledHead,
}) {
    if (marker?.repositories?.[name] !== desiredIdentity) return false;
    const directory = path.join(targetRoot, name);
    try {
        const stat = fsApi.lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        if (name === 'achillesAgentLib' && LOCAL_IDENTITY_PATTERN.test(desiredIdentity)) {
            return validateAgentlibPackage(directory, fsApi);
        }
    } catch {
        return false;
    }
    return readInstalledHead(directory, runner) === lock.repositories[name].commit;
}

function preservedAgentlibIdentity({
    targetRoot,
    marker,
    lock,
    fsApi,
    runner,
    readInstalledHead,
}) {
    const identity = String(marker?.repositories?.achillesAgentLib || '');
    if (identity !== lock.repositories.achillesAgentLib.commit
        && !LOCAL_IDENTITY_PATTERN.test(identity)) {
        return '';
    }
    return dependencyMatches({
        name: 'achillesAgentLib',
        desiredIdentity: identity,
        targetRoot,
        marker,
        lock,
        fsApi,
        runner,
        readInstalledHead,
    }) ? identity : '';
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

export function inspectInstalledAgentlibIdentity({
    targetRoot = '/opt/ploinky/node_modules',
    markerPath = '/etc/ploinky-box',
    fsApi = fs,
    runner = createProcessRunner(),
    lock = readDependencyLock({ fsApi }),
    readInstalledHead = defaultReadInstalledHead,
} = {}) {
    validateDependencyLock(lock);
    assertBoxMarker(markerPath, fsApi);
    const root = path.resolve(targetRoot);
    assertRealDirectory(root, fsApi);
    const marker = readMarker(path.join(root, DEPENDENCY_MARKER_NAME), fsApi);
    const identity = String(marker?.repositories?.achillesAgentLib || '');
    if (identity === lock.repositories.achillesAgentLib.commit
        && dependencyMatches({
            name: 'achillesAgentLib', desiredIdentity: identity, targetRoot: root,
            marker, lock, fsApi, runner, readInstalledHead,
        })) {
        return identity;
    }
    if (LOCAL_IDENTITY_PATTERN.test(identity)
        && dependencyMatches({
            name: 'achillesAgentLib', desiredIdentity: identity, targetRoot: root,
            marker, lock, fsApi, runner, readInstalledHead,
        })) {
        return identity;
    }
    return 'unknown';
}

export function installPinnedDependencies({
    targetRoot = '/opt/ploinky/node_modules',
    markerPath = '/etc/ploinky-box',
    localAgentlibSha = '',
    preserveAgentlib = false,
    fsApi = fs,
    runner = createProcessRunner(),
    lock = readDependencyLock({ fsApi }),
    installRepository = defaultInstallRepository,
    installLocalAgentlib = defaultInstallLocalAgentlib,
    readInstalledHead = defaultReadInstalledHead,
    token = crypto.randomBytes(12).toString('hex'),
} = {}) {
    validateDependencyLock(lock);
    if (localAgentlibSha && !LOCAL_AGENTLIB_SHA_PATTERN.test(localAgentlibSha)) {
        throw dependencyError('Local AchillesAgentLib SHA must be 64 lowercase hexadecimal characters');
    }
    if (localAgentlibSha && preserveAgentlib) {
        throw dependencyError('Local AchillesAgentLib selection cannot preserve another installed identity');
    }
    assertBoxMarker(markerPath, fsApi);
    const root = path.resolve(targetRoot);
    assertRealDirectory(root, fsApi);
    const markerFile = path.join(root, DEPENDENCY_MARKER_NAME);
    const currentMarker = readMarker(markerFile, fsApi);
    // Ordinary command preparation may repair the rest of the Box, but start
    // owns every Achilles source transition. Retain only an installation that
    // passes the same identity validation used by the read-only inspector.
    const retainedAgentlibIdentity = preserveAgentlib
        ? preservedAgentlibIdentity({
            targetRoot: root,
            marker: currentMarker,
            lock,
            fsApi,
            runner,
            readInstalledHead,
        })
        : '';
    if (preserveAgentlib
        && !retainedAgentlibIdentity
        && (entryExists(markerFile, fsApi)
            || entryExists(path.join(root, 'achillesAgentLib'), fsApi))) {
        throw dependencyError(
            'Refusing ordinary Box preparation because the existing AchillesAgentLib identity '
            + 'cannot be validated; run `ploinky start AGENT` to select and install its source',
        );
    }
    const archivePath = localAgentlibSha
        ? validateLocalArchive(root, localAgentlibSha, fsApi)
        : '';
    const expected = markerFor(
        lock,
        localAgentlibSha
            ? `local:${localAgentlibSha}`
            : retainedAgentlibIdentity || lock.repositories.achillesAgentLib.commit,
    );
    const invalidNames = Object.entries(expected.repositories)
        .filter(([name, desiredIdentity]) => !dependencyMatches({
            name, desiredIdentity, targetRoot: root, marker: currentMarker,
            lock, fsApi, runner, readInstalledHead,
        }))
        .map(([name]) => name);
    if (invalidNames.length === 0 && markerMatches(currentMarker, expected)) {
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
        for (const name of invalidNames) {
            const destination = path.join(transactionRoot, name);
            if (name === 'achillesAgentLib' && localAgentlibSha) {
                installLocalAgentlib({
                    archivePath, sha256: localAgentlibSha, destination, runner, fsApi,
                });
                validateAgentlibPackage(destination, fsApi);
            } else {
                const repository = lock.repositories[name];
                installRepository({ name, repository, destination, runner, fsApi });
                if (readInstalledHead(destination, runner) !== repository.commit) {
                    throw dependencyError(`Staged ${name} HEAD does not match its immutable pin`);
                }
            }
            staged.set(name, destination);
        }

        for (const name of invalidNames) {
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
            flag: 'wx', mode: 0o600,
        });
        fsApi.renameSync(markerTemp, markerFile);
        committed = true;
        for (const backup of backups.values()) {
            try { safeRemoveWithin(root, backup.path, fsApi); } catch {}
        }
        return Object.freeze({ changed: true, marker: expected });
    } catch (error) {
        if (!committed) {
            for (const name of [...invalidNames].reverse()) {
                const destination = path.join(root, name);
                const backup = backups.get(name);
                if (movedNames.has(name)) {
                    try { safeRemoveWithin(root, destination, fsApi); } catch {}
                }
                if (backup) {
                    try {
                        fsApi.renameSync(backup.path, destination);
                        if (backup.originalMode !== null) fsApi.chmodSync(destination, backup.originalMode);
                    } catch {}
                }
            }
        }
        if (error instanceof PloinkyBoxError) throw error;
        throw dependencyError('Pinned dependency installation failed', error);
    } finally {
        try { safeRemoveWithin(root, transactionRoot, fsApi); } catch {}
    }
}

export function runInstallerCli(argv = [], {
    stdout = process.stdout,
    ...options
} = {}) {
    if (argv.length === 0) return installPinnedDependencies(options);
    if (argv.length === 1 && argv[0] === '--print-agentlib-identity') {
        const identity = inspectInstalledAgentlibIdentity(options);
        stdout.write(`${identity}\n`);
        return identity;
    }
    if (argv.length === 1 && argv[0] === '--preserve-agentlib') {
        return installPinnedDependencies({ ...options, preserveAgentlib: true });
    }
    if (argv.length === 2 && argv[0] === '--local-agentlib-sha') {
        if (!LOCAL_AGENTLIB_SHA_PATTERN.test(String(argv[1] || ''))) {
            throw dependencyError('Local AchillesAgentLib SHA must be 64 lowercase hexadecimal characters');
        }
        return installPinnedDependencies({ ...options, localAgentlibSha: argv[1] });
    }
    throw dependencyError(
        'Usage: ploinky-install-deps [--local-agentlib-sha <sha256>|--preserve-agentlib|--print-agentlib-identity]',
    );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        runInstallerCli(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`ploinky-box dependency installation failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
