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
const PIN_PATTERN = /^[a-f0-9]{40}$/;

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
        throw dependencyError(`Dependency volume target is not a real directory: ${directory}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw dependencyError(`Dependency volume target is not owned by the current user: ${directory}`);
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
    return {
        fingerprint: crypto.createHash('sha256').update(canonicalLockJson(lock)).digest('hex'),
        repositories: Object.fromEntries(Object.entries(lock.repositories).map(([name, value]) => (
            [name, value.commit]
        ))),
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

function defaultInstallRepository({ name, repository, destination, runner, fsApi = fs }) {
    const privateHome = path.join(destination, '.installer-home');
    const privateTmp = path.join(destination, '.installer-tmp');
    const npmCache = path.join(destination, '.npm-cache');
    fsApi.mkdirSync(privateHome, { recursive: true, mode: 0o700 });
    fsApi.mkdirSync(privateTmp, { recursive: true, mode: 0o700 });
    const toolEnvironment = {
        PATH: String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin'),
        HOME: privateHome,
        TMPDIR: privateTmp,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        npm_config_cache: npmCache,
        npm_config_update_notifier: 'false',
    };
    runner.run('git', ['init', destination], { env: toolEnvironment });
    runner.run('git', ['-C', destination, 'remote', 'add', 'origin', repository.url], { env: toolEnvironment });
    runner.run('git', ['-C', destination, 'fetch', '--depth', '1', 'origin', repository.commit], { env: toolEnvironment });
    runner.run('git', ['-C', destination, 'checkout', '--detach', repository.commit], { env: toolEnvironment });
    runner.run('npm', [
        'install',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
    ], { cwd: destination, env: toolEnvironment });
    const head = defaultReadInstalledHead(destination, runner, { env: toolEnvironment });
    if (head !== repository.commit) {
        throw dependencyError(`Installed ${name} HEAD does not match its immutable pin`);
    }
    for (const transient of [privateHome, privateTmp, npmCache]) {
        fsApi.rmSync(transient, { recursive: true, force: true });
    }
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

function installationMatches({ targetRoot, expected, lock, fsApi, runner, readInstalledHead }) {
    if (!markerMatches(readMarker(path.join(targetRoot, DEPENDENCY_MARKER_NAME), fsApi), expected)) {
        return false;
    }
    for (const [name, repository] of Object.entries(lock.repositories)) {
        const directory = path.join(targetRoot, name);
        try {
            const stat = fsApi.lstatSync(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        } catch {
            return false;
        }
        if (readInstalledHead(directory, runner) !== repository.commit) {
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
    token = crypto.randomBytes(12).toString('hex'),
} = {}) {
    validateDependencyLock(lock);
    assertBoxMarker(markerPath, fsApi);
    const root = path.resolve(targetRoot);
    assertRealDirectory(root, fsApi);
    const expected = markerFor(lock);
    if (installationMatches({
        targetRoot: root, expected, lock, fsApi, runner, readInstalledHead,
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
        for (const [name, repository] of Object.entries(lock.repositories)) {
            const destination = path.join(transactionRoot, name);
            installRepository({ name, repository, destination, runner, fsApi });
            if (readInstalledHead(destination, runner) !== repository.commit) {
                throw dependencyError(`Staged ${name} HEAD does not match its immutable pin`);
            }
            staged.set(name, destination);
        }

        for (const name of Object.keys(lock.repositories)) {
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
            for (const name of [...Object.keys(lock.repositories)].reverse()) {
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
