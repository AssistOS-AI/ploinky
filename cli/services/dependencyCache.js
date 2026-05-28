import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import {
    GLOBAL_DEPS_CACHE_DIR,
    AGENTS_DEPS_CACHE_DIR,
    GLOBAL_DEPS_PATH,
    WORKSPACE_ROOT,
} from './config.js';
import { parseRuntimeKey, detectHostRuntimeKey } from './dependencyRuntimeKey.js';
import { debugLog } from './utils.js';
import { readGlobalDepsPackage, mergePackageJson } from './dependencyInstaller.js';
import { getRuntime } from './docker/common.js';
import { detectShellForImage, SHELL_FALLBACK_DIRECT } from './docker/shellDetection.js';

export const STAMP_VERSION = 1;
export const STAMP_FILENAME = 'stamp.json';
export const LOCK_FILENAME = '.lock';
export const CORE_MARKER_MODULE = 'mcp-sdk';
export const NPM_INSTALL_ARGS = ['install', '--no-package-lock', '--no-audit', '--no-fund'];
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function assertRuntimeKey(runtimeKey) {
    const parsed = parseRuntimeKey(runtimeKey);
    if (!parsed) {
        throw new Error(`Invalid runtime key: ${runtimeKey}`);
    }
    return parsed;
}

export function getGlobalCachePath(runtimeKey) {
    assertRuntimeKey(runtimeKey);
    return path.join(GLOBAL_DEPS_CACHE_DIR, runtimeKey);
}

export function getAgentCachePath(repoName, agentName, runtimeKey) {
    assertRuntimeKey(runtimeKey);
    if (!repoName || !agentName) {
        throw new Error(`Agent cache path requires repoName and agentName (got ${repoName}/${agentName}).`);
    }
    return path.join(AGENTS_DEPS_CACHE_DIR, repoName, agentName, runtimeKey);
}

export function getGlobalPackagePath() {
    return path.join(GLOBAL_DEPS_PATH, 'package.json');
}

export function sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

export function hashFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return sha256(fs.readFileSync(filePath));
}

export function hashObject(obj) {
    const normalized = JSON.stringify(obj, Object.keys(obj || {}).sort());
    return sha256(normalized);
}

export function hashMergedPackage(mergedPackage) {
    const ordered = {
        name: mergedPackage?.name || '',
        dependencies: sortObject(mergedPackage?.dependencies || {}),
        devDependencies: sortObject(mergedPackage?.devDependencies || {}),
    };
    return sha256(JSON.stringify(ordered));
}

function sortObject(obj) {
    return Object.keys(obj || {}).sort().reduce((acc, key) => {
        acc[key] = obj[key];
        return acc;
    }, {});
}

export function stampPath(cachePath) {
    return path.join(cachePath, STAMP_FILENAME);
}

export function readStamp(cachePath) {
    const file = stampPath(cachePath);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return null;
    }
}

export function writeStamp(cachePath, stamp) {
    fs.mkdirSync(cachePath, { recursive: true });
    const payload = {
        version: STAMP_VERSION,
        preparedAt: new Date().toISOString(),
        ...stamp,
    };
    fs.writeFileSync(stampPath(cachePath), JSON.stringify(payload, null, 2));
    return payload;
}

function installerMismatchReason(stamp, expectedInstaller = null) {
    if (!expectedInstaller) return '';
    const stampInstaller = stamp?.installer || null;
    if (!stampInstaller || typeof stampInstaller !== 'object') {
        return 'installer metadata missing';
    }
    for (const key of ['runtimeFamily', 'nodeMajor', 'platform', 'arch', 'variant', 'installerRuntime', 'image']) {
        const actual = stampInstaller[key] == null ? null : String(stampInstaller[key]);
        const expected = expectedInstaller[key] == null ? null : String(expectedInstaller[key]);
        if (actual !== expected) {
            return `installer ${key} changed (${actual ?? 'null'} != ${expected ?? 'null'})`;
        }
    }
    return '';
}

export function isGlobalCacheValid(cachePath, { runtimeKey, globalPackageHash, installer = null }) {
    const stamp = readStamp(cachePath);
    if (!stamp) return { valid: false, reason: 'stamp missing' };
    if (stamp.version !== STAMP_VERSION) return { valid: false, reason: `stamp version ${stamp.version} != ${STAMP_VERSION}` };
    if (stamp.runtimeKey !== runtimeKey) return { valid: false, reason: `runtime key mismatch (${stamp.runtimeKey} != ${runtimeKey})` };
    if (stamp.globalPackageHash !== globalPackageHash) return { valid: false, reason: 'globalPackageHash changed' };
    const installerReason = installerMismatchReason(stamp, installer);
    if (installerReason) return { valid: false, reason: installerReason };
    const marker = path.join(cachePath, 'node_modules', CORE_MARKER_MODULE);
    if (!fs.existsSync(marker)) return { valid: false, reason: `core marker ${CORE_MARKER_MODULE} missing` };
    return { valid: true, reason: 'ok' };
}

export function isAgentCacheValid(cachePath, { runtimeKey, mergedPackageHash, installer = null }) {
    const stamp = readStamp(cachePath);
    if (!stamp) return { valid: false, reason: 'stamp missing' };
    if (stamp.version !== STAMP_VERSION) return { valid: false, reason: `stamp version ${stamp.version} != ${STAMP_VERSION}` };
    if (stamp.runtimeKey !== runtimeKey) return { valid: false, reason: `runtime key mismatch (${stamp.runtimeKey} != ${runtimeKey})` };
    if (stamp.mergedPackageHash !== mergedPackageHash) return { valid: false, reason: 'mergedPackageHash changed' };
    const installerReason = installerMismatchReason(stamp, installer);
    if (installerReason) return { valid: false, reason: installerReason };
    const marker = path.join(cachePath, 'node_modules', CORE_MARKER_MODULE);
    if (!fs.existsSync(marker)) return { valid: false, reason: `core marker ${CORE_MARKER_MODULE} missing` };
    return { valid: true, reason: 'ok' };
}

export function acquireLock(cachePath, { timeoutMs = 10 * 60 * 1000, pollMs = 250 } = {}) {
    fs.mkdirSync(cachePath, { recursive: true });
    const lockFile = path.join(cachePath, LOCK_FILENAME);
    const start = Date.now();
    while (true) {
        try {
            const fd = fs.openSync(lockFile, 'wx');
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
            fs.closeSync(fd);
            return {
                release() {
                    try { fs.unlinkSync(lockFile); } catch (_) {}
                },
                path: lockFile,
            };
        } catch (err) {
            if (err && err.code !== 'EEXIST') throw err;
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for cache lock at ${lockFile}`);
        }
        const deadline = Date.now() + pollMs;
        while (Date.now() < deadline) { /* busy wait without a timer */ }
    }
}

export function ensureCacheDir(cachePath) {
    fs.mkdirSync(cachePath, { recursive: true });
    fs.mkdirSync(path.join(cachePath, 'node_modules'), { recursive: true });
    return cachePath;
}

export function nodeModulesDir(cachePath) {
    return path.join(cachePath, 'node_modules');
}

function assertHostMatchesRuntimeKey(runtimeKey) {
    const parsed = assertRuntimeKey(runtimeKey);
    if (parsed.family !== 'bwrap' && parsed.family !== 'seatbelt') {
        throw new Error(`Host install only supports bwrap/seatbelt runtimes (got family ${parsed.family}).`);
    }
    const hostKey = detectHostRuntimeKey(parsed.family);
    if (hostKey !== runtimeKey) {
        throw new Error(`Runtime key ${runtimeKey} does not match host ${hostKey}. Cache preparation for a foreign runtime is not supported in phase 1.`);
    }
    return parsed;
}

function mergePathList(existing, additions) {
    const values = String(existing || '')
        .split(path.delimiter)
        .filter(Boolean);
    for (const value of additions) {
        if (value && !values.includes(value)) values.push(value);
    }
    return values.join(path.delimiter);
}

function withGithubHttpsGitConfig(env = process.env, { cwd = '' } = {}) {
    const rawCount = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10);
    const baseCount = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : 0;
    return {
        ...env,
        GIT_CEILING_DIRECTORIES: mergePathList(env.GIT_CEILING_DIRECTORIES, [
            WORKSPACE_ROOT,
            cwd && path.resolve(cwd),
        ]),
        GIT_CONFIG_COUNT: String(baseCount + 2),
        [`GIT_CONFIG_KEY_${baseCount}`]: 'url.https://github.com/.insteadOf',
        [`GIT_CONFIG_VALUE_${baseCount}`]: 'ssh://git@github.com/',
        [`GIT_CONFIG_KEY_${baseCount + 1}`]: 'url.https://github.com/.insteadOf',
        [`GIT_CONFIG_VALUE_${baseCount + 1}`]: 'git@github.com:',
    };
}

function runNpmInstall(cwd, { log = debugLog } = {}) {
    log(`[deps-cache] npm install in ${cwd}`);
    const result = spawnSync('npm', NPM_INSTALL_ARGS, {
        cwd,
        env: withGithubHttpsGitConfig(process.env, { cwd }),
        stdio: 'inherit',
        timeout: INSTALL_TIMEOUT_MS,
    });
    if (result.error) {
        throw new Error(`npm install failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`npm install exited with code ${result.status}`);
    }
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildContainerInstallScript({ installDir = '/install', heartbeatSeconds = 30 } = {}) {
    const installLabel = shellQuote(installDir);
    const npmArgs = NPM_INSTALL_ARGS.map(shellQuote).join(' ');
    const interval = Number.isFinite(Number(heartbeatSeconds)) && Number(heartbeatSeconds) > 0
        ? String(Number(heartbeatSeconds))
        : '30';
    return [
        'export DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"',
        '&& (',
        '  command -v git >/dev/null 2>&1 ||',
        '  (command -v apk >/dev/null 2>&1 && apk update && apk add --no-cache git python3 make g++) ||',
        '  (command -v apt-get >/dev/null 2>&1 && (apt-get update || true) && apt-get install -y git python3 make g++)',
        ') 2>/dev/null',
        '&& git config --global url.https://github.com/.insteadOf ssh://git@github.com/',
        '&& git config --global --add url.https://github.com/.insteadOf git@github.com:',
        '&& (',
        `  printf '[deps-cache] npm install started in %s; cold native dependency caches can take several minutes.\\n' ${installLabel};`,
        `  (while true; do sleep ${interval}; printf '[deps-cache] npm install still running in %s at %s\\n' ${installLabel} "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; done) &`,
        '  heartbeat_pid=$!;',
        '  trap \'kill "$heartbeat_pid" 2>/dev/null || true\' EXIT INT TERM;',
        `  GIT_CEILING_DIRECTORIES=${installLabel} npm ${npmArgs};`,
        '  install_status=$?;',
        '  kill "$heartbeat_pid" 2>/dev/null || true;',
        '  wait "$heartbeat_pid" 2>/dev/null || true;',
        '  exit "$install_status"',
        ')',
    ].join(' ');
}

function resolveInstallBackend(runtimeKey, { image = '', runtime = null, log = debugLog } = {}) {
    const parsed = assertRuntimeKey(runtimeKey);
    if (parsed.family === 'bwrap' || parsed.family === 'seatbelt') {
        assertHostMatchesRuntimeKey(runtimeKey);
        return {
            install(cwd) {
                return runNpmInstall(cwd, { log });
            },
            installerRuntime: parsed.family,
        };
    }
    if (parsed.family === 'container') {
        const resolvedRuntime = runtime || getRuntime();
        const resolvedImage = String(image || '').trim();
        if (!resolvedImage) {
            throw new Error(`Container cache preparation for ${runtimeKey} requires an image.`);
        }
        return {
            install(cwd) {
                return runNpmInstallInContainer(cwd, { image: resolvedImage, runtime: resolvedRuntime, log });
            },
            installerRuntime: resolvedRuntime,
            image: resolvedImage,
        };
    }
    throw new Error(`Unsupported install backend for runtime family ${parsed.family}`);
}

function runNpmInstallInContainer(cwd, { image, runtime = null, log = debugLog } = {}) {
    if (!image) {
        throw new Error('Container dependency install requires an image.');
    }
    const resolvedRuntime = runtime || getRuntime();
    const shellPath = detectShellForImage('deps-cache', image, resolvedRuntime);
    if (!shellPath || shellPath === SHELL_FALLBACK_DIRECT) {
        throw new Error(`Could not determine a shell for image ${image}.`);
    }
    const volumeSuffix = resolvedRuntime === 'podman' ? ':z' : '';
    const roArgs = resolvedRuntime === 'podman'
        ? ['--network', 'slirp4netns:allow_host_loopback=true']
        : [];
    const installScript = buildContainerInstallScript();
    const args = [
        'run', '--rm',
        ...roArgs,
        '-v', `${cwd}:/install${volumeSuffix}`,
        '-w', '/install',
        '--entrypoint', shellPath,
        image,
        '-lc',
        installScript,
    ];
    log(`[deps-cache] npm install in container ${image} at ${cwd}`);
    const result = spawnSync(resolvedRuntime, args, { stdio: 'inherit', timeout: INSTALL_TIMEOUT_MS });
    if (result.error) {
        throw new Error(`container npm install failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`container npm install exited with code ${result.status}`);
    }
}

export function prepareGlobalCache(runtimeKey, { force = false, log = debugLog, image = '', runtime = null } = {}) {
    const backend = resolveInstallBackend(runtimeKey, { image, runtime, log });
    const expectedInstaller = installerMetadata(runtimeKey, backend);

    const globalPackageFile = getGlobalPackagePath();
    if (!fs.existsSync(globalPackageFile)) {
        throw new Error(`globalDeps/package.json missing at ${globalPackageFile}`);
    }
    const globalPackageHash = hashFile(globalPackageFile);
    const cachePath = getGlobalCachePath(runtimeKey);

    if (!force) {
        const check = isGlobalCacheValid(cachePath, { runtimeKey, globalPackageHash, installer: expectedInstaller });
        if (check.valid) {
            log(`[deps-cache] global cache hit (${runtimeKey})`);
            return { cachePath, reused: true, reason: check.reason };
        }
        log(`[deps-cache] global cache miss (${runtimeKey}): ${check.reason}`);
    }

    const lock = acquireLock(cachePath);
    try {
        ensureCacheDir(cachePath);
        fs.copyFileSync(globalPackageFile, path.join(cachePath, 'package.json'));
        backend.install(cachePath);
        const stamp = writeStamp(cachePath, {
            runtimeKey,
            globalPackageHash,
            installer: expectedInstaller,
        });
        log(`[deps-cache] global cache prepared at ${cachePath}`);
        return { cachePath, reused: false, stamp };
    } finally {
        lock.release();
    }
}

function installerMetadata(runtimeKey, backend = {}) {
    const parsed = parseRuntimeKey(runtimeKey);
    return {
        runtimeFamily: parsed?.family || null,
        nodeMajor: parsed?.nodeMajor || null,
        platform: parsed?.platform || null,
        arch: parsed?.arch || null,
        variant: parsed?.variant || '',
        installerRuntime: backend?.installerRuntime || null,
        image: backend?.image || null,
    };
}

export function prepareAgentCache({
    repoName,
    agentName,
    runtimeKey,
    agentPackagePath = null,
    force = false,
    log = debugLog,
    image = '',
    runtime = null,
} = {}) {
    const backend = resolveInstallBackend(runtimeKey, { image, runtime, log });
    const expectedInstaller = installerMetadata(runtimeKey, backend);
    if (!repoName || !agentName) {
        throw new Error('prepareAgentCache requires repoName and agentName');
    }

    const globalResult = prepareGlobalCache(runtimeKey, { force, log, image, runtime });
    const globalCachePath = globalResult.cachePath;

    const globalPkg = readGlobalDepsPackage();
    const agentPkg = (agentPackagePath && fs.existsSync(agentPackagePath))
        ? JSON.parse(fs.readFileSync(agentPackagePath, 'utf8'))
        : null;
    const mergedPkg = mergePackageJson(globalPkg, agentPkg);
    const mergedPackageHash = hashMergedPackage(mergedPkg);
    const agentPackageHash = agentPackagePath ? hashFile(agentPackagePath) : null;
    const globalPackageHash = hashFile(getGlobalPackagePath());
    const cachePath = getAgentCachePath(repoName, agentName, runtimeKey);

    if (!force) {
        const check = isAgentCacheValid(cachePath, { runtimeKey, mergedPackageHash, installer: expectedInstaller });
        if (check.valid) {
            log(`[deps-cache] agent cache hit ${repoName}/${agentName} (${runtimeKey})`);
            return { cachePath, reused: true, reason: check.reason, mergedPackageHash };
        }
        log(`[deps-cache] agent cache miss ${repoName}/${agentName} (${runtimeKey}): ${check.reason}`);
    }

    const lock = acquireLock(cachePath);
    try {
        ensureCacheDir(cachePath);
        seedFromGlobalCache(globalCachePath, cachePath, { log, allowHardlinks: !agentPkg });
        fs.writeFileSync(
            path.join(cachePath, 'package.json'),
            JSON.stringify(mergedPkg, null, 2),
        );
        if (agentPkg) {
            backend.install(cachePath);
        }
        const stamp = writeStamp(cachePath, {
            runtimeKey,
            globalPackageHash,
            agentPackageHash,
            mergedPackageHash,
            installer: expectedInstaller,
        });
        log(`[deps-cache] agent cache prepared at ${cachePath}`);
        return { cachePath, reused: false, stamp, mergedPackageHash };
    } finally {
        lock.release();
    }
}

function seedFromGlobalCache(globalCachePath, agentCachePath, { log = debugLog, allowHardlinks = true } = {}) {
    const srcNm = nodeModulesDir(globalCachePath);
    const dstNm = nodeModulesDir(agentCachePath);
    if (!fs.existsSync(srcNm)) {
        throw new Error(`Global cache node_modules missing at ${srcNm}`);
    }
    if (fs.existsSync(dstNm)) {
        fs.rmSync(dstNm, { recursive: true, force: true });
    }
    if (allowHardlinks) {
        const hardlinked = spawnSync('cp', ['-al', srcNm, dstNm], { stdio: 'ignore' });
        if (hardlinked.status === 0) {
            log(`[deps-cache] seeded via hardlinks from ${srcNm}`);
            return;
        }
        log(`[deps-cache] hardlink seed failed (${hardlinked.status}); falling back to deep copy`);
    }
    if (typeof fs.cpSync === 'function') {
        fs.cpSync(srcNm, dstNm, { recursive: true });
    } else {
        spawnSync('cp', ['-a', srcNm, dstNm], { stdio: 'inherit' });
    }
}

export function verifyAgentCache({
    runtimeKey,
    repoName,
    agentName,
    agentPackagePath = '',
}) {
    const cachePath = getAgentCachePath(repoName, agentName, runtimeKey);
    const nm = nodeModulesDir(cachePath);
    const hasAgentPkg = Boolean(agentPackagePath) && fs.existsSync(agentPackagePath);
    const agentPkg = hasAgentPkg
        ? JSON.parse(fs.readFileSync(agentPackagePath, 'utf8'))
        : null;
    const mergedPkg = mergePackageJson(readGlobalDepsPackage(), agentPkg);
    const mergedPackageHash = hashMergedPackage(mergedPkg);
    const check = isAgentCacheValid(cachePath, { runtimeKey, mergedPackageHash });
    if (check.valid) return nm;
    throw new Error(
        `prepared dependency cache is ${check.reason} at ${nm}. `
        + `Run \`ploinky deps prepare ${repoName}/${agentName}\` and try again.`
    );
}

/**
 * Strict helper for diagnostics and explicit checks: verify that a prepared
 * agent cache is valid for the given host runtime family and return its
 * node_modules path.
 */
export function verifyAgentCacheForFamily({
    family,
    repoName,
    agentName,
    agentCodePath,
}) {
    const runtimeKey = detectHostRuntimeKey(family);
    const agentPackagePath = path.join(agentCodePath, 'package.json');
    try {
        return verifyAgentCache({
            runtimeKey,
            repoName,
            agentName,
            agentPackagePath,
        });
    } catch (err) {
        throw new Error(`[${family}] ${agentName}: ${err.message}`);
    }
}

/**
 * Startup-time helper: prepare or reuse a valid agent dependency cache for the
 * given host runtime family and return its node_modules path.
 */
export function ensureAgentCacheForFamily({
    family,
    repoName,
    agentName,
    agentCodePath,
    log = debugLog,
    prepare = prepareAgentCache,
}) {
    const runtimeKey = detectHostRuntimeKey(family);
    const agentPackagePath = path.join(agentCodePath, 'package.json');
    try {
        const prepared = prepare({
            repoName,
            agentName,
            runtimeKey,
            agentPackagePath,
            log,
        });
        return nodeModulesDir(prepared.cachePath);
    } catch (err) {
        throw new Error(`[${family}] ${agentName}: ${err.message}`);
    }
}

export { assertHostMatchesRuntimeKey, runNpmInstall, installerMetadata, seedFromGlobalCache };
