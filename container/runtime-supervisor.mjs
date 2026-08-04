#!/usr/bin/env node
// Public host supervisor for the managed Ploinky outer runtime.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { showHelp } from '../cli/commands/help.js';
import { loadEnvFile } from '../cli/utils/security/masterKey.js';
import { probeImageBinaries } from '../ploinky-box/contract/image.mjs';
import { createEngineClient } from './runtime-engine.mjs';
import {
    BOX_MEDIA_PORT,
    BOX_ROUTER_PORT,
    PATH_HASH_LABEL,
    REQUESTED_IMAGE_LABEL,
    REQUIRED_RUNTIME_IMAGE,
    VOLUME_ROLES,
    assertFixedRuntimePublications,
    buildRuntimeRunArgs,
    buildVolumeCreateArgs,
    createDefaultRuntimeConfig,
    mergeDesiredRuntimeConfig,
    normalizeContainerInspect,
    normalizeImageInspect,
    normalizeVolumeInspect,
    parseSelectedHostPort,
    planReconciliation,
    runtimeVolumeNames,
    validateImageContract,
    validateVolumeOwnership,
} from './runtime-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IMAGE = REQUIRED_RUNTIME_IMAGE;
const BOX_PREFIX = 'ploinky-box';
const ENGINE_NAMES = Object.freeze(['podman', 'docker']);
const CREATION_FLAGS = new Set([
    '--port',
    '--image',
    '--mount',
]);
const SOURCE_MARKERS = ['bin/ploinky', 'cli/index.js', 'globalDeps/package.json'];
const DEFAULT_SOURCE_BRANCHES = new Set(['main', 'master', 'HEAD']);
const BRANCH_POLICY_FLAGS = new Set([
    '--branch',
    '--repo-branch',
    '--branch-fallback',
    '--reset-repos',
]);
const HOST_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const HOST_LOCK_RETRY_MS = 100;
const HOST_LOCK_STALE_GRACE_MS = 2000;

export class SupervisorError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.name = 'SupervisorError';
        this.exitCode = exitCode;
    }
}

function die(message, exitCode = 1) {
    throw new SupervisorError(message, exitCode);
}

export function publicUsageText() {
    return `ploinky - run Ploinky through its managed outer runtime

Usage: ploinky [outer-options] [--] [command] [args]

Commands:
  ploinky                         Start/reconcile the runtime and open the Ploinky REPL
  p-cli                          Alias for ploinky
  ploinky cli                    Open Bash as podman in /workspace
  ploinky cli <agent> [args...]  Attach to an agent manifest CLI
  ploinky start ...              Start the graph and probe readiness
  ploinky status                 Combined read-only runtime and core status
  ploinky stop                   Stop core services, then the outer runtime
  ploinky destroy                Confirm and remove the outer runtime; retain named volumes
  ploinky help [command]         Show help without engine discovery

Outer options (must precede the command):
  --port N          Host port for the router (default 8080)
  --image I         Managed Box runtime image (default ${DEFAULT_IMAGE})
  --mount DIR       Bind DIR read-write at /workspace/mounted
  --dry-run         Print mutations instead of executing them
  -h, --help        Show host help

The runtime identity and host engine are selected automatically from the
canonical current directory. --name, --engine, and PLOINKY_BOX_ENGINE are not
supported. Use -- before a core command that begins with an option.

For start, put --port before the command or use: ploinky start AGENT PORT.
`;
}

function optionAssignment(token, name) {
    const prefix = `${name}=`;
    return token.startsWith(prefix) ? token.slice(prefix.length) : null;
}

export function parseHostInvocation(argv, _env = process.env) {
    const invocation = {
        engine: '',
        port: String(BOX_ROUTER_PORT),
        image: DEFAULT_IMAGE,
        mountDir: '',
        mountDirResolved: '',
        sourceDirResolved: '',
        dryRun: false,
        explicit: new Set(),
        help: false,
        command: '',
        args: [],
        canonicalPath: '',
        pathHash: '',
        slug: '',
        instance: '',
    };
    let i = 0;
    const need = (flag) => {
        const value = argv[i + 1];
        if (value === undefined || value === '') die(`${flag} needs a value`);
        invocation.explicit.add(flag);
        i += 2;
        return String(value);
    };
    const assigned = (token, flag) => {
        const value = optionAssignment(token, flag);
        if (value === null) return null;
        if (value === '') die(`${flag} needs a value`);
        invocation.explicit.add(flag);
        i += 1;
        return value;
    };

    while (i < argv.length && !invocation.command) {
        const token = String(argv[i]);
        if (token === '--') {
            i += 1;
            if (i < argv.length) invocation.command = String(argv[i++]);
            break;
        }
        if (token === '--name' || token.startsWith('--name=')) {
            die('--name is no longer supported; the runtime identity comes from the current directory');
        }
        if (token === '--engine' || token.startsWith('--engine=')) {
            die('--engine is no longer supported; Ploinky discovers the owning engine automatically');
        }
        if (token === '--port') {
            invocation.port = need('--port');
            continue;
        }
        const assignedPort = assigned(token, '--port');
        if (assignedPort !== null) {
            invocation.port = assignedPort;
            continue;
        }
        if (token === '--publish' || token.startsWith('--publish=')) {
            die('--publish is not supported by managed Box configuration; the outer box has exactly two fixed publications');
        }
        if (token === '--expose' || token.startsWith('--expose=')) {
            die('--expose is not supported by managed Box configuration; the outer box has exactly two fixed publications');
        }
        if (token === '--image') {
            invocation.image = need('--image');
            continue;
        }
        const assignedImage = assigned(token, '--image');
        if (assignedImage !== null) {
            invocation.image = assignedImage;
            continue;
        }
        if (token === '--mount') {
            invocation.mountDir = need('--mount');
            continue;
        }
        const assignedMount = assigned(token, '--mount');
        if (assignedMount !== null) {
            invocation.mountDir = assignedMount;
            continue;
        }
        if (token === '--listen-lan' || token.startsWith('--listen-lan=')) {
            die('--listen-lan is not supported by managed Box configuration; router TCP is physical-host loopback only');
        }
        if (token === '--dry-run') {
            invocation.dryRun = true;
            invocation.explicit.add(token);
            i += 1;
            continue;
        }
        if (token === '-h' || token === '--help') {
            invocation.help = true;
            invocation.explicit.add(token);
            i += 1;
            continue;
        }
        invocation.command = token;
        i += 1;
    }
    invocation.args = argv.slice(i).map(String);
    return invocation;
}

export function routeHostInvocation(invocation) {
    if (invocation.help || invocation.command === 'help') {
        return { kind: 'help', topic: invocation.args };
    }
    if (!invocation.command) return { kind: 'repl' };
    if (invocation.command === 'status') return { kind: 'status' };
    if (invocation.command === 'stop') return { kind: 'stop' };
    if (invocation.command === 'destroy') return { kind: 'destroy' };
    if (invocation.command === 'start') {
        return {
            kind: 'start',
            forwardedArgs: ['start', ...invocation.args],
        };
    }
    return {
        kind: 'ordinary',
        forwardedArgs: [invocation.command, ...invocation.args],
        interactive: ['cli', 'shell', 'sh', '--shell', '-shell']
            .includes(invocation.command),
    };
}

export function assertStateCommandFlags(invocation) {
    if (!['status', 'stop', 'destroy'].includes(invocation.command)) return;
    const rejected = [...invocation.explicit]
        .find(flag => CREATION_FLAGS.has(flag));
    if (rejected) {
        die(`${invocation.command}: ${rejected} is only valid before an ordinary runtime command`);
    }
    if (invocation.args.length > 0) {
        die(`${invocation.command}: unexpected trailing argument '${invocation.args[0]}'`);
    }
}

export function instanceName(cfg) {
    return cfg.instance || `${BOX_PREFIX}-${cfg.name || ''}`;
}

export function volumeNames(cfg) {
    return runtimeVolumeNames(instanceName(cfg));
}

export function sanitizeBoxSuffix(raw, maxLength = 48) {
    const sanitized = String(raw || '')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .slice(0, maxLength);
    return /[a-zA-Z0-9]/.test(sanitized) ? sanitized : 'workspace';
}

export function resolveInstanceIdentity(
    cfg,
    cwd = process.cwd(),
    realpathImpl = fs.realpathSync.native,
) {
    let canonicalPath;
    try {
        canonicalPath = realpathImpl(String(cwd));
    } catch (error) {
        die(`cannot resolve current directory '${cwd}': ${error.message || error}`);
    }
    const pathHash = crypto
        .createHash('sha256')
        .update(canonicalPath)
        .digest('hex')
        .slice(0, 12);
    const slug = sanitizeBoxSuffix(path.basename(canonicalPath));
    cfg.canonicalPath = canonicalPath;
    cfg.pathHash = pathHash;
    cfg.slug = slug;
    cfg.instance = `${BOX_PREFIX}-${slug}-${pathHash}`;
    return cfg;
}

function hostRuntimeLockRoot(env = process.env, rootDir = '') {
    if (rootDir) return path.resolve(rootDir);
    const configured = String(env?.XDG_RUNTIME_DIR || '').trim();
    if (configured && path.isAbsolute(configured)) {
        return path.join(configured, 'ploinky-box-locks');
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    return path.join(os.tmpdir(), `ploinky-box-locks-${uid}`);
}

function ensurePrivateLockRoot(root) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        die(`host runtime lock root '${root}' is not a real directory`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        die(`host runtime lock root '${root}' is not owned by the current user`);
    }
    try { fs.chmodSync(root, 0o700); } catch (_) {}
}

export function hostRuntimeLockPath(invocation, options = {}) {
    const canonicalPath = String(invocation?.canonicalPath || '').trim();
    if (!canonicalPath) die('host runtime lock requires a canonical workspace path');
    const key = crypto.createHash('sha256').update(canonicalPath).digest('hex');
    return path.join(
        hostRuntimeLockRoot(options.env, options.rootDir),
        `${key}.lock`,
    );
}

function readHostLockOwner(lockPath) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

function hostLockOwnerAlive(owner) {
    const pid = Number(owner?.pid);
    if (!Number.isInteger(pid) || pid < 1) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code !== 'ESRCH';
    }
}

function removeOwnedHostLock(lockPath, token) {
    if (readHostLockOwner(lockPath)?.token !== token) return false;
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
}

function statOrNull(target) {
    try {
        return fs.statSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function recoverAbandonedHostReaper(reaperPath, staleGraceMs) {
    const stat = statOrNull(reaperPath);
    if (!stat) return true;
    if (Date.now() - stat.mtimeMs < Math.max(staleGraceMs, 2000)) return false;
    const owner = readHostLockOwner(reaperPath);
    if (hostLockOwnerAlive(owner)) return false;
    fs.rmSync(reaperPath, { recursive: true, force: true });
    return true;
}

function tryRecoverStaleHostLock(lockPath, invocation, staleGraceMs) {
    const stat = statOrNull(lockPath);
    if (!stat || Date.now() - stat.mtimeMs < staleGraceMs) return !stat;
    const owner = readHostLockOwner(lockPath);
    if (
        owner?.canonicalPath
        && owner.canonicalPath !== invocation.canonicalPath
    ) {
        die(`host runtime lock hash collision between '${owner.canonicalPath}' and '${invocation.canonicalPath}'`);
    }
    if (hostLockOwnerAlive(owner)) return false;

    const reaperPath = `${lockPath}.reaper`;
    try {
        fs.mkdirSync(reaperPath, { mode: 0o700 });
        fs.writeFileSync(path.join(reaperPath, 'owner.json'), JSON.stringify({
            token: crypto.randomUUID(),
            pid: process.pid,
            canonicalPath: invocation.canonicalPath,
            acquiredAt: new Date().toISOString(),
        }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        recoverAbandonedHostReaper(reaperPath, staleGraceMs);
        return false;
    }
    try {
        const current = statOrNull(lockPath);
        if (!current || Date.now() - current.mtimeMs < staleGraceMs) return !current;
        const currentOwner = readHostLockOwner(lockPath);
        if (
            currentOwner?.canonicalPath
            && currentOwner.canonicalPath !== invocation.canonicalPath
        ) {
            die(`host runtime lock hash collision between '${currentOwner.canonicalPath}' and '${invocation.canonicalPath}'`);
        }
        if (hostLockOwnerAlive(currentOwner)) return false;
        fs.rmSync(lockPath, { recursive: true, force: true });
        return true;
    } finally {
        fs.rmSync(reaperPath, { recursive: true, force: true });
    }
}

async function acquireHostRuntimeLock(invocation, options = {}) {
    const timeoutMs = options.timeoutMs ?? HOST_LOCK_TIMEOUT_MS;
    const retryMs = options.retryMs ?? HOST_LOCK_RETRY_MS;
    const staleGraceMs = options.staleGraceMs ?? HOST_LOCK_STALE_GRACE_MS;
    for (const [name, value, minimum] of [
        ['timeoutMs', timeoutMs, 0],
        ['retryMs', retryMs, 1],
        ['staleGraceMs', staleGraceMs, 0],
    ]) {
        if (!Number.isInteger(value) || value < minimum) {
            throw new TypeError(`host runtime lock ${name} must be an integer >= ${minimum}`);
        }
    }
    const lockPath = hostRuntimeLockPath(invocation, options);
    ensurePrivateLockRoot(path.dirname(lockPath));
    const startedAt = Date.now();
    while (true) {
        const reaperPath = `${lockPath}.reaper`;
        let acquired = false;
        if (!statOrNull(reaperPath)) {
            try {
                fs.mkdirSync(lockPath, { mode: 0o700 });
                acquired = true;
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
            }
        }
        if (acquired) {
            const token = crypto.randomUUID();
            try {
                fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                    token,
                    pid: process.pid,
                    canonicalPath: invocation.canonicalPath,
                    acquiredAt: new Date().toISOString(),
                }), { flag: 'wx', mode: 0o600 });
                if (statOrNull(reaperPath)) {
                    removeOwnedHostLock(lockPath, token);
                } else {
                    const handle = { lockPath, token, released: false, onExit: null };
                    handle.release = () => {
                        if (handle.released) return;
                        handle.released = true;
                        if (handle.onExit) process.removeListener('exit', handle.onExit);
                        removeOwnedHostLock(lockPath, token);
                    };
                    handle.onExit = () => removeOwnedHostLock(lockPath, token);
                    process.once('exit', handle.onExit);
                    return handle;
                }
            } catch (error) {
                fs.rmSync(lockPath, { recursive: true, force: true });
                throw error;
            }
        }

        tryRecoverStaleHostLock(lockPath, invocation, staleGraceMs);
        const elapsed = Date.now() - startedAt;
        if (elapsed >= timeoutMs) {
            const owner = readHostLockOwner(lockPath);
            const detail = owner
                ? `; owner pid ${owner.pid || 'unknown'}, acquired ${owner.acquiredAt || 'at an unknown time'}`
                : '';
            die(`timed out after ${timeoutMs}ms waiting for host runtime lock '${lockPath}'${detail}`);
        }
        await sleep(Math.min(retryMs, timeoutMs - elapsed));
    }
}

export async function withHostRuntimeLock(invocation, callback, options = {}) {
    if (typeof callback !== 'function') {
        throw new TypeError('host runtime lock requires a callback');
    }
    const handle = await acquireHostRuntimeLock(invocation, options);
    try {
        return await callback();
    } finally {
        handle.release();
    }
}

function isExecutableFile(candidate) {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

export function whichBinary(name, env = process.env) {
    if (/[\\/]/.test(name)) return isExecutableFile(name) ? name : null;
    for (const dir of String(env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        if (isExecutableFile(candidate)) return candidate;
    }
    return null;
}

function runtimeDependencies(cfg) {
    return cfg._runtimeDependencies || defaultDependencies();
}

function output(cfg, text) {
    runtimeDependencies(cfg).stdout.write(text);
}

function errorOutput(cfg, text) {
    runtimeDependencies(cfg).stderr.write(text);
}

function engineClientFor(cfg) {
    if (!cfg._engineClient) die('internal error: runtime engine was not selected');
    return cfg._engineClient;
}

function query(cfg, args, options) {
    return engineClientFor(cfg).query(args, options);
}

function runEngine(cfg, args, options = {}) {
    try {
        return engineClientFor(cfg).run(args, options);
    } catch (error) {
        if (error instanceof SupervisorError) throw error;
        throw new SupervisorError(
            error?.message || String(error),
            Number.isInteger(error?.exitCode) ? error.exitCode : 1,
        );
    }
}

function streamContains(cfg, args, needle) {
    return engineClientFor(cfg).streamContains(args, needle);
}

function streamEngineToStderr(cfg, args) {
    return engineClientFor(cfg).streamToStderr(args);
}

function recognizedMissing(result, kind, expectedName = '') {
    const text = `${result?.stderr || ''}\n${result?.stdout || ''}`.toLowerCase();
    const noun = kind === 'volume' ? 'volume' : 'container';
    if (!result || result.ok) return false;
    if (
        text.includes(`no such ${noun}`)
        || text.includes(`no ${noun} with name`)
        || text.includes(`${noun} not found`)
    ) return true;
    const name = String(expectedName || '').trim().toLowerCase();
    if (!name) return false;
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
        `\\b${noun}(?:\\s+(?:with\\s+)?(?:name|id))?[\\s"'=:]+${escapedName}[\\s"']+(?:does not exist|is missing|not found)\\b`,
    ).test(text);
}

function resultFailure(result) {
    return String(
        result?.error?.message
        || result?.stderr
        || result?.stdout
        || `exit ${result?.status ?? 1}`,
    ).trim();
}

export function assertRootlessPodmanEngine(engine) {
    if (!engine || engine.name !== 'podman') {
        throw new SupervisorError('Ploinky managed Box configuration requires rootless Podman; Docker and rootful Podman are unsupported');
    }
    const result = engine.query(['info', '--format', '{{json .Host.Security.Rootless}}']);
    if (!result.ok || String(result.stdout || '').trim() !== 'true') {
        throw new SupervisorError('Ploinky managed Box configuration could not prove that the selected Podman engine is rootless');
    }
}

function parseIdMap(raw, kind) {
    const records = String(raw || '').trim().split(/\n+/).filter(Boolean).map((line) => {
        const fields = line.trim().split(/\s+/).map(Number);
        if (fields.length !== 3 || fields.some((value) => !Number.isSafeInteger(value) || value < 0) || fields[2] < 1) {
            throw new SupervisorError(`nested Podman returned a malformed ${kind}_map line: '${line}'`);
        }
        return { inside: fields[0], outside: fields[1], length: fields[2] };
    }).sort((a, b) => a.inside - b.inside);
    if (records.length === 0) throw new SupervisorError(`nested Podman returned an empty ${kind}_map`);
    return records;
}

function validateNestedIdMap(raw, kind) {
    const records = parseIdMap(raw, kind);
    const root = records[0];
    if (root.inside !== 0 || root.length !== 1) {
        throw new SupervisorError(`nested Podman ${kind}_map must map container ${kind.toUpperCase()} 0 as one distinct identity`);
    }
    let cursor = 1;
    for (const record of records.slice(1)) {
        if (record.inside !== cursor) {
            throw new SupervisorError(`nested Podman ${kind}_map is not contiguous at container ${kind.toUpperCase()} ${cursor}`);
        }
        cursor += record.length;
    }
    const byOutside = [...records].sort((left, right) => left.outside - right.outside);
    for (let index = 1; index < byOutside.length; index += 1) {
        const previous = byOutside[index - 1];
        if (previous.outside + previous.length > byOutside[index].outside) {
            throw new SupervisorError(`nested Podman ${kind}_map maps distinct container identities onto overlapping host identities`);
        }
    }
    if (cursor !== 65535) {
        throw new SupervisorError(`nested Podman ${kind}_map must expose exactly 65534 subordinate IDs; observed ${Math.max(0, cursor - 1)}`);
    }
    return records;
}

export function validateNestedUidMap(raw) {
    return validateNestedIdMap(raw, 'uid');
}

export function validateNestedGidMap(raw) {
    return validateNestedIdMap(raw, 'gid');
}

export function verifyNestedRootlessRuntime(cfg) {
    if (cfg.dryRun) return true;
    const instance = instanceName(cfg);
    const rootless = query(cfg, [
        'exec', instance, 'podman', 'info', '--format', '{{json .Host.Security.Rootless}}',
    ]);
    if (!rootless.ok || String(rootless.stdout || '').trim() !== 'true') {
        die(`runtime '${instance}' failed nested rootless Podman verification`);
    }
    const uidMap = query(cfg, [
        'exec', instance, 'podman', 'unshare', 'cat', '/proc/self/uid_map',
    ]);
    if (!uidMap.ok) {
        die(`runtime '${instance}' could not read the nested Podman uid_map: ${resultFailure(uidMap)}`);
    }
    validateNestedUidMap(uidMap.stdout);
    const gidMap = query(cfg, [
        'exec', instance, 'podman', 'unshare', 'cat', '/proc/self/gid_map',
    ]);
    if (!gidMap.ok) {
        die(`runtime '${instance}' could not read the nested Podman gid_map: ${resultFailure(gidMap)}`);
    }
    validateNestedGidMap(gidMap.stdout);
    return true;
}

function probeEngine(client, instance) {
    const health = client.query(['info']);
    if (!health.ok) {
        return {
            engine: client.name,
            state: 'unknown',
            error: `engine health failed: ${resultFailure(health)}`,
            client,
        };
    }
    const inspect = client.query(['container', 'inspect', instance]);
    if (inspect.ok) {
        try {
            normalizeContainerInspect(client.name, inspect.stdout);
        } catch (error) {
            return {
                engine: client.name,
                state: 'unknown',
                error: `container inspection was malformed: ${error.message || error}`,
                client,
            };
        }
        return { engine: client.name, state: 'owns', client };
    }
    if (recognizedMissing(inspect, 'container', instance)) {
        return { engine: client.name, state: 'absent', client };
    }
    return {
        engine: client.name,
        state: 'unknown',
        error: `container ownership probe failed: ${resultFailure(inspect)}`,
        client,
    };
}

function inventoryVolumes(client, invocation) {
    const names = volumeNames(invocation);
    const roles = {};
    for (const roleKey of Object.keys(VOLUME_ROLES)) {
        const name = names[roleKey];
        const result = client.query(['volume', 'inspect', name]);
        if (!result.ok) {
            if (recognizedMissing(result, 'volume', name)) {
                roles[roleKey] = { state: 'absent', name };
                continue;
            }
            return {
                state: 'unknown',
                error: `volume '${name}' probe failed: ${resultFailure(result)}`,
                roles,
            };
        }
        try {
            const volume = normalizeVolumeInspect(result.stdout);
            validateVolumeOwnership(volume, invocation, roleKey, name);
            roles[roleKey] = { state: 'valid', name, volume };
        } catch (error) {
            roles[roleKey] = {
                state: 'foreign',
                name,
                error: error.message || String(error),
            };
        }
    }
    return { state: 'ok', roles };
}

function resourceCount(inventory) {
    return Number(inventory.container === true)
        + Object.values(inventory.volumes?.roles || {})
            .filter(entry => entry.state === 'valid').length;
}

function discoveryIssue(kind, message, probes, inventories = {}) {
    return { kind, message, probes, inventories };
}

export function resolveEngineOwnership(invocation, dependencies = {}) {
    if (typeof dependencies.resolveEngineOwnership === 'function') {
        return dependencies.resolveEngineOwnership(invocation);
    }

    // Unit tests may inject one already-selected client. This is an internal
    // seam, never a public flag or environment override.
    if (dependencies.engineClient) {
        const client = dependencies.engineClient;
        return {
            engine: client.name,
            client,
            clients: { [client.name]: client },
            probes: [{ engine: client.name, state: 'injected', client }],
            inventories: {},
            injected: true,
        };
    }

    const env = dependencies.env || process.env;
    const installed = dependencies.installedEngines
        || ENGINE_NAMES.filter(name => whichBinary(name, env));
    if (installed.length === 0) {
        return {
            issue: discoveryIssue(
                'unavailable',
                'Ploinky requires an answering Podman or Docker engine on the host',
                [],
            ),
            probes: [],
            inventories: {},
        };
    }
    const clients = Object.fromEntries(installed.map(name => [
        name,
        dependencies.engineClients?.[name]
            || dependencies.createEngineClient({
                name,
                dryRun: invocation.dryRun && invocation._routeKind !== 'status',
                spawnSyncImpl: dependencies.spawnSyncImpl,
                spawnImpl: dependencies.spawnImpl,
                stdout: dependencies.stdout,
                stderr: dependencies.stderr,
            }),
    ]));
    const probes = installed.map(name => probeEngine(clients[name], instanceName(invocation)));
    const unknown = probes.filter(probe => probe.state === 'unknown');
    if (unknown.length > 0) {
        return {
            clients,
            probes,
            inventories: {},
            issue: discoveryIssue(
                'unknown',
                unknown.map(probe => `${probe.engine}: ${probe.error}`).join('; '),
                probes,
            ),
        };
    }
    const owners = probes.filter(probe => probe.state === 'owns');
    if (owners.length > 1) {
        return {
            clients,
            probes,
            inventories: {},
            issue: discoveryIssue(
                'split',
                `both Podman and Docker own exact runtime '${instanceName(invocation)}'`,
                probes,
            ),
        };
    }

    const inventories = {};
    for (const probe of probes) {
        const volumes = inventoryVolumes(probe.client, invocation);
        if (volumes.state === 'unknown') {
            return {
                clients,
                probes,
                inventories,
                issue: discoveryIssue(
                    'unknown',
                    `${probe.engine}: ${volumes.error}`,
                    probes,
                    inventories,
                ),
            };
        }
        inventories[probe.engine] = {
            engine: probe.engine,
            container: probe.state === 'owns',
            volumes,
        };
    }
    const foreign = Object.values(inventories).flatMap(inventory =>
        Object.values(inventory.volumes.roles)
            .filter(entry => entry.state === 'foreign')
            .map(entry => `${inventory.engine}: ${entry.error}`)
    );
    if (foreign.length > 0) {
        return {
            clients,
            probes,
            inventories,
            issue: discoveryIssue(
                'foreign',
                foreign.join('; '),
                probes,
                inventories,
            ),
        };
    }
    const resourceOwners = Object.values(inventories)
        .filter(inventory => resourceCount(inventory) > 0);
    if (resourceOwners.length > 1) {
        return {
            clients,
            probes,
            inventories,
            issue: discoveryIssue(
                'split',
                `runtime identity '${instanceName(invocation)}' has resources on multiple engines`,
                probes,
                inventories,
            ),
        };
    }
    const engine = resourceOwners[0]?.engine
        || (installed.includes('podman') ? 'podman' : 'docker');
    return {
        engine,
        client: clients[engine],
        clients,
        probes,
        inventories,
        inventory: inventories[engine],
    };
}

function formatInventory(inventory) {
    if (!inventory) return 'no inventory';
    const volumeText = Object.entries(inventory.volumes?.roles || {})
        .map(([role, value]) => `${role}=${value.state}`)
        .join(', ');
    return `container=${inventory.container ? 'present' : 'absent'}; ${volumeText}`;
}

function reportDiscoveryStatus(invocation, context, stdout) {
    stdout.write(`runtime: ${instanceName(invocation)} (ownership unresolved)\n`);
    for (const probe of context.probes || []) {
        const suffix = probe.error ? `: ${probe.error}` : '';
        stdout.write(`engine ${probe.engine}: ${probe.state}${suffix}\n`);
    }
    for (const [engine, inventory] of Object.entries(context.inventories || {})) {
        stdout.write(`resources ${engine}: ${formatInventory(inventory)}\n`);
    }
    stdout.write(`discovery: ${context.issue?.kind || 'failed'}: ${context.issue?.message || 'unresolved'}\n`);
    return 1;
}

function applyEngineContext(invocation, context) {
    invocation.engine = context.engine;
    invocation._engineContext = context;
    Object.defineProperty(invocation, '_engineClient', {
        value: context.client,
        configurable: true,
        writable: true,
    });
}

function engineSelinuxEnabled(cfg) {
    if (cfg.dryRun) return false;
    if (cfg.engine === 'podman') {
        const result = query(cfg, ['info', '--format', '{{.Host.Security.SELinuxEnabled}}']);
        return result.ok && result.stdout.trim() === 'true';
    }
    const result = query(cfg, ['info', '--format', '{{json .SecurityOptions}}']);
    return result.ok && result.stdout.includes('selinux');
}

function prepareMount(cfg) {
    if (!cfg.mountDir) return;
    let isDir = false;
    try { isDir = fs.statSync(cfg.mountDir).isDirectory(); } catch { /* missing */ }
    if (!isDir) die(`--mount directory not found: ${cfg.mountDir}`);
    cfg.mountDirResolved = path.resolve(cfg.mountDir);
    errorOutput(cfg, `ploinky: WARNING: --mount pierces the isolation boundary for ${cfg.mountDir}\n`);
}

export function resolveHostPloinkySource(env = process.env, scriptDir = HERE) {
    const override = String(env.PLOINKY_BOX_SOURCE || '').trim();
    const candidate = path.resolve(override || path.resolve(scriptDir, '..'));
    const missing = SOURCE_MARKERS.filter(marker => !fs.existsSync(path.join(candidate, marker)));
    if (missing.length > 0) {
        die(`ploinky source not found at ${candidate} (missing: ${missing.join(', ')}).\n`
            + '  The box mounts a local ploinky checkout read-only at /opt/ploinky.\n'
            + '  Set PLOINKY_BOX_SOURCE=/path/to/ploinky only when using a detached supervisor.');
    }
    return candidate;
}

function resolveSource(cfg) {
    cfg.sourceDirResolved = resolveHostPloinkySource(runtimeDependencies(cfg).env);
}

function prepareSourceDependencies(cfg) {
    if (!cfg.dryRun) {
        fs.mkdirSync(path.join(cfg.sourceDirResolved, 'node_modules'), { recursive: true });
    }
}

function hasBranchPolicyArg(args) {
    return (args || []).some(arg => {
        const value = String(arg || '');
        return BRANCH_POLICY_FLAGS.has(value)
            || value.startsWith('--branch=')
            || value.startsWith('--repo-branch=')
            || value.startsWith('--branch-fallback=');
    });
}

function currentGitBranch(sourceDir) {
    const dir = String(sourceDir || '').trim();
    if (!dir) return '';
    const result = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || result.error) return '';
    return String(result.stdout || '').trim();
}

export function inferPublicStartBranchArgs(args, env = process.env, sourceDir = '') {
    const autoBranch = String(env?.PLOINKY_BOX_AUTO_BRANCH || '').trim().toLowerCase();
    if (['0', 'false', 'no'].includes(autoBranch)) return [];
    if (hasBranchPolicyArg(args)) return [];
    const branch = String(
        env?.PLOINKY_BOX_BRANCH
        || currentGitBranch(sourceDir || resolveHostPloinkySource(env))
        || '',
    ).trim();
    if (!branch || DEFAULT_SOURCE_BRANCHES.has(branch)) return [];
    return ['--branch', branch];
}

function validateHostPort(value, label) {
    try {
        return String(parseSelectedHostPort(value, { source: label }));
    } catch (error) {
        die(error?.message || String(error));
    }
}

function inspectedImage(cfg, imageRef) {
    const result = query(cfg, ['image', 'inspect', imageRef]);
    if (!result.ok) return null;
    try {
        return normalizeImageInspect(result.stdout);
    } catch {
        return null;
    }
}

function inspectExistingRuntimeConfig(cfg) {
    if (Object.hasOwn(cfg, '_preflightExisting')) return cfg._preflightExisting;
    const result = query(cfg, ['container', 'inspect', instanceName(cfg)]);
    if (!result.ok) {
        if (recognizedMissing(result, 'container', instanceName(cfg))) return null;
        die(`cannot inspect runtime '${instanceName(cfg)}': ${resultFailure(result)}`);
    }
    try {
        return normalizeContainerInspect(cfg.engine, result.stdout);
    } catch (error) {
        die(`cannot parse runtime inspect for '${instanceName(cfg)}': ${error.message || error}`);
    }
}

function preflightExistingRuntimeBeforePlanning(cfg) {
    const existing = inspectExistingRuntimeConfig(cfg);
    if (existing) validateExistingRuntime(cfg, existing);
    Object.defineProperty(cfg, '_preflightExisting', {
        configurable: true,
        value: existing,
    });
    return existing;
}

function validateExistingRuntime(cfg, existing) {
    const imageRef = existing.imageId || existing.configuredImage;
    const image = imageRef ? inspectedImage(cfg, imageRef) : null;
    if (!image) {
        die(`runtime '${existing.instance}' is unsupported: its deployed image '${imageRef || '<missing>'}' cannot be inspected; run ploinky destroy explicitly`);
    }
    try {
        validateImageContract(image, imageRef);
    } catch (error) {
        die(`runtime '${existing.instance}' is unsupported: ${error.message}; run ploinky destroy explicitly`);
    }
    const expectedIdentity = {
        [REQUESTED_IMAGE_LABEL]: existing.requestedImage,
        [PATH_HASH_LABEL]: cfg.pathHash,
    };
    const observedIdentity = Object.fromEntries(
        Object.entries(existing.labels || {}).sort(),
    );
    const desiredIdentity = Object.fromEntries(
        Object.entries(expectedIdentity).sort(),
    );
    if (JSON.stringify(observedIdentity) !== JSON.stringify(desiredIdentity)) {
        die(`runtime '${existing.instance}' is unsupported: its ownership labels are missing, mismatched, or unexpected; run ploinky destroy explicitly`);
    }
    if (!existing.requestedImage) {
        die(`runtime '${existing.instance}' is unsupported: ${REQUESTED_IMAGE_LABEL} is missing; run ploinky destroy explicitly`);
    }
    if (!existing.routerPublish) {
        die(`runtime '${existing.instance}' is unsupported: required ${BOX_ROUTER_PORT}/tcp router publication is missing; run ploinky destroy explicitly`);
    }
    validateHostPort(
        existing.routerPublish.hostPort,
        `runtime '${existing.instance}' ${BOX_ROUTER_PORT}/tcp host port`,
    );
    try {
        assertFixedRuntimePublications(existing);
    } catch (error) {
        die(`runtime '${existing.instance}' is unsupported: ${error.message}; run ploinky destroy explicitly`);
    }
    return image;
}

function obtainAndValidateImage(cfg, imageRef, { forcePull = true } = {}) {
    if (cfg.dryRun) {
        if (forcePull) runEngine(cfg, ['pull', imageRef]);
        return null;
    }
    if (forcePull) runEngine(cfg, ['pull', imageRef]);
    const image = inspectedImage(cfg, imageRef);
    if (!image) die(`Runtime image '${imageRef}' was unavailable after pull`);
    try {
        const validatedImage = validateImageContract(image, imageRef);
        probeImageBinaries(cfg.engine, image.id, {
            query(engine, args, options) {
                if (engine !== cfg.engine) {
                    return {
                        ok: false,
                        status: 1,
                        stdout: '',
                        stderr: `unexpected runtime engine ${engine}`,
                    };
                }
                return query(cfg, args, options);
            },
        }, {
            expectedSourceSha: validatedImage.sourceSha,
        });
    } catch (error) {
        throw new SupervisorError(error.message || String(error));
    }
    return image;
}

function selectedInventory(cfg) {
    return cfg._engineContext?.inventory
        || cfg._engineContext?.inventories?.[cfg.engine]
        || null;
}

export function ensureRuntimeVolumes(cfg, roles = Object.keys(VOLUME_ROLES)) {
    const names = volumeNames(cfg);
    const inventory = selectedInventory(cfg);
    for (const roleKey of roles) {
        const name = names[roleKey];
        const known = inventory?.volumes?.roles?.[roleKey];
        if (known?.state === 'valid') continue;
        if (known?.state === 'foreign') die(known.error);
        if (cfg.dryRun) {
            runEngine(cfg, buildVolumeCreateArgs(cfg, roleKey, name));
            continue;
        }
        const before = query(cfg, ['volume', 'inspect', name]);
        if (before.ok) {
            try {
                validateVolumeOwnership(
                    normalizeVolumeInspect(before.stdout),
                    cfg,
                    roleKey,
                    name,
                );
                continue;
            } catch (error) {
                die(error.message || String(error));
            }
        }
        if (!recognizedMissing(before, 'volume', name)) {
            die(`cannot inspect volume '${name}': ${resultFailure(before)}`);
        }
        runEngine(cfg, buildVolumeCreateArgs(cfg, roleKey, name));
        const after = query(cfg, ['volume', 'inspect', name]);
        if (!after.ok) die(`volume '${name}' was unavailable after explicit creation`);
        try {
            validateVolumeOwnership(
                normalizeVolumeInspect(after.stdout),
                cfg,
                roleKey,
                name,
            );
        } catch (error) {
            die(error.message || String(error));
        }
    }
}

function portInUse(port, host = '127.0.0.1', timeoutMs = 500) {
    return new Promise(resolve => {
        const portNumber = Number(port);
        if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
            resolve(false);
            return;
        }
        const sock = net.connect({ port: portNumber, host });
        const done = value => { sock.destroy(); resolve(value); };
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
        sock.setTimeout(timeoutMs, () => done(false));
    });
}

function udpPortInUse(port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            try { socket.close(); } catch (_) {}
            if (error) reject(error);
            else resolve(value);
        };
        socket.once('error', error => {
            if (error?.code === 'EADDRINUSE') finish(null, true);
            else finish(error);
        });
        socket.once('listening', () => finish(null, false));
        socket.bind(Number(port), host);
    });
}

function parseEngineContainerRecords(raw, engine) {
    let parsed;
    try {
        parsed = JSON.parse(String(raw || ''));
    } catch (error) {
        throw new SupervisorError(
            `cannot parse ${engine} container inventory while checking ${BOX_MEDIA_PORT}/udp: ${error.message}`,
        );
    }
    return Array.isArray(parsed) ? parsed : [parsed];
}

export function fixedUdpOwnersFromContainerInspects(engine, inspected, ignoredNames = []) {
    const ignored = new Set(ignoredNames.map(value => String(value).replace(/^\//, '')));
    const owners = [];
    for (const record of inspected || []) {
        const name = String(record?.Name || record?.Names?.[0] || '').replace(/^\//, '');
        if (!name || ignored.has(name)) continue;
        const running = record?.State?.Running === true
            || String(record?.State?.Status || '').trim().toLowerCase() === 'running';
        if (!running) continue;
        for (const [target, bindings] of Object.entries(
            record?.HostConfig?.PortBindings || {},
        )) {
            if (!String(target).toLowerCase().endsWith('/udp')) continue;
            for (const binding of bindings || []) {
                if (String(binding?.HostPort || '') !== String(BOX_MEDIA_PORT)) continue;
                owners.push({
                    engine,
                    container: name,
                    hostIp: String(binding?.HostIp || '0.0.0.0'),
                    hostPort: String(binding.HostPort),
                });
            }
        }
    }
    return owners;
}

function inspectFixedUdpOwners(cfg, ignoredNames = []) {
    const clients = cfg._engineContext?.clients
        || { [cfg.engine]: engineClientFor(cfg) };
    const owners = [];
    for (const [engine, client] of Object.entries(clients)) {
        const listed = client.query(['ps', '--all', '--format', '{{.Names}}']);
        if (!listed.ok) {
            die(`cannot inventory ${engine} containers while checking fixed ${BOX_MEDIA_PORT}/udp: ${resultFailure(listed)}`);
        }
        const names = String(listed.stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        for (const name of names) {
            const result = client.query(['container', 'inspect', name]);
            if (!result.ok) {
                die(`cannot inspect ${engine} container '${name}' while checking fixed ${BOX_MEDIA_PORT}/udp: ${resultFailure(result)}`);
            }
            owners.push(...fixedUdpOwnersFromContainerInspects(
                engine,
                parseEngineContainerRecords(result.stdout, engine),
                ignoredNames,
            ));
        }
    }
    return owners;
}

async function assertFixedUdpAvailable(cfg, ignoredNames = []) {
    if (cfg.dryRun) return;
    const dependencies = runtimeDependencies(cfg);
    const owners = typeof dependencies.fixedUdpOwners === 'function'
        ? await dependencies.fixedUdpOwners(cfg, ignoredNames)
        : inspectFixedUdpOwners(cfg, ignoredNames);
    if (owners.length > 0) {
        const detail = owners.map(owner => (
            `${owner.engine} container '${owner.container}' (${owner.hostIp}:${owner.hostPort}/udp)`
        )).join(', ');
        die(
            `physical-host UDP ${BOX_MEDIA_PORT} is already reserved by ${detail}; stop/remove that owner before creating this Ploinky box`,
        );
    }
    const probe = dependencies.udpPortInUse || udpPortInUse;
    let occupied;
    try {
        occupied = await probe(BOX_MEDIA_PORT, '0.0.0.0');
    } catch (error) {
        die(`cannot prove physical-host UDP ${BOX_MEDIA_PORT} availability: ${error.message || error}`);
    }
    if (occupied) {
        die(
            `physical-host UDP ${BOX_MEDIA_PORT} is already in use, but no container-engine owner was found; inspect owner-aware ss/lsof output and release the socket before retrying`,
        );
    }
}

async function waitHealthy(cfg, phase) {
    if (cfg.dryRun) return;
    const injected = runtimeDependencies(cfg).waitHealthy;
    if (injected) return injected(cfg, phase);
    const instance = instanceName(cfg);
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const inspect = query(cfg, ['container', 'inspect', '--format', '{{.State.Status}}', instance]);
        const state = inspect.ok ? inspect.stdout.trim() : 'missing';
        if (state === 'running') {
            if (await streamContains(cfg, ['logs', instance], 'self-check OK')) {
                output(cfg, `ploinky: '${instance}' is running (router publishes after core start).\n`);
                return;
            }
        }
        if (state === 'exited') {
            errorOutput(cfg, `ploinky: '${instance}' failed its self-check:\n`);
            await streamEngineToStderr(cfg, ['logs', instance]);
            die('fix the reported Ploinky box self-check failure before retrying');
        }
        await runtimeDependencies(cfg).sleep(1000);
    }
    die(`'${instance}' did not become healthy; inspect with: ${cfg.engine} logs ${instance}`);
}

function fixDepsOwnership(cfg) {
    if (cfg.engine !== 'docker' || cfg.dryRun) return;
    runEngine(cfg, [
        'exec', '--user', 'root', instanceName(cfg),
        'chown', 'podman:podman', '/opt/ploinky/node_modules',
    ]);
}

function depsInstalled(cfg) {
    if (cfg.dryRun) return true;
    return query(cfg, [
        'exec', instanceName(cfg), 'sh', '-lc',
        'test -d /opt/ploinky/node_modules/achillesAgentLib && test -d /opt/ploinky/node_modules/mcp-sdk',
    ]).ok;
}

export function shouldInstallDeps(env, isTTY, reply) {
    if (String(env?.PLOINKY_BOX_INSTALL_DEPS || '') === '1') return true;
    if (!isTTY) return false;
    return /^[yY]$/.test(reply ?? '');
}

async function ensureDepsInstalled(cfg, { fatalOnDecline = false } = {}) {
    if (cfg.dryRun || depsInstalled(cfg)) return true;
    const deps = runtimeDependencies(cfg);
    let reply = null;
    const envOptIn = String(deps.env.PLOINKY_BOX_INSTALL_DEPS || '') === '1';
    if (!envOptIn && deps.stdin.isTTY) {
        reply = await deps.askLine('Ploinky dependencies are not installed. Install them now? [y/N] ');
    }
    if (!shouldInstallDeps(deps.env, deps.stdin.isTTY, reply)) {
        errorOutput(cfg, 'ploinky: WARNING: Ploinky cannot run until dependencies are installed.\n'
            + `ploinky: install them with: ${cfg.engine} exec -it ${instanceName(cfg)} /opt/ploinky/bin/ploinky-install-deps\n`);
        if (fatalOnDecline) {
            throw new SupervisorError('Ploinky dependencies are required before running this command');
        }
        return false;
    }
    runEngine(cfg, ['exec', '-i', instanceName(cfg), '/opt/ploinky/bin/ploinky-install-deps']);
    return true;
}

function askLine(promptText) {
    return new Promise(resolve => {
        process.stdout.write(promptText);
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        rl.once('line', line => { finish(line); rl.close(); });
        rl.once('close', () => finish(null));
    });
}

export async function reconcileRuntime(cfg, { fatalOnDepsDecline = false } = {}) {
    cfg.port = validateHostPort(cfg.port, `${cfg.command || 'runtime'}: host port`);
    // Persist the engine's SELinux requirement in desired state so a container
    // created with label=disable converges instead of reporting perpetual drift.
    cfg._selinuxEnabled = engineSelinuxEnabled(cfg);
    const existing = inspectExistingRuntimeConfig(cfg);
    if (existing) validateExistingRuntime(cfg, existing);
    if (!existing || cfg.explicit.has('--mount')) prepareMount(cfg);
    if (!existing) resolveSource(cfg);
    const desired = mergeDesiredRuntimeConfig(cfg, existing);
    const plan = planReconciliation({ existing, desired });
    cfg._runtimeConfig = desired;
    cfg._reconciliationPlan = plan;

    const requireDependencies = async () => {
        if (!await ensureDepsInstalled(cfg, { fatalOnDecline: fatalOnDepsDecline })) {
            throw new SupervisorError('Ploinky dependencies are required before running this command');
        }
    };
    const running = () => ({ ...desired, state: 'running', running: true });

    switch (plan.action) {
    case 'reuse':
        await waitHealthy(cfg, 'reuse');
        verifyNestedRootlessRuntime(cfg);
        fixDepsOwnership(cfg);
        await requireDependencies();
        return existing;
    case 'start':
        runEngine(cfg, ['start', desired.instance], { silence: 'stdout' });
        await waitHealthy(cfg, 'start');
        verifyNestedRootlessRuntime(cfg);
        fixDepsOwnership(cfg);
        await requireDependencies();
        return running();
    case 'create': {
        const portCheck = runtimeDependencies(cfg).portInUse || portInUse;
        if (!cfg.dryRun && desired.routerPublish && await portCheck(desired.routerPublish.hostPort)) {
            die(`host port ${cfg.port} is already in use; choose another with --port`);
        }
        await assertFixedUdpAvailable(cfg);
        const prepared = cfg._preparedCreateImage;
        const image = prepared?.reference === desired.image
            ? prepared.image
            : obtainAndValidateImage(cfg, desired.image, { forcePull: true });
        if (image) {
            desired.imageId = image.id;
        }
        prepareSourceDependencies(cfg);
        ensureRuntimeVolumes(cfg);
        try {
            runEngine(cfg, buildRuntimeRunArgs(desired, {
                engine: cfg.engine,
                selinux: cfg._selinuxEnabled,
            }));
            await waitHealthy(cfg, 'create');
            verifyNestedRootlessRuntime(cfg);
            fixDepsOwnership(cfg);
            await requireDependencies();
            return running();
        } catch (error) {
            try {
                removeNamedRuntimeForCleanup(cfg, desired.instance);
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    `runtime creation failed and cleanup failed: ${error.message || error}; ${cleanupError.message || cleanupError}`,
                );
            }
            throw error;
        }
    }
    case 'recreate-required':
        throw new SupervisorError(
            `runtime '${existing.instance}' configuration differs from managed Box desired state `
            + `(${plan.reasons.join(', ')}); run 'ploinky destroy' explicitly, then rerun `
            + 'the original command to recreate the box',
        );
    default:
        throw new SupervisorError(`unsupported runtime reconciliation action '${plan.action}'`);
    }
}

function namedRuntimePresence(cfg, instance) {
    const result = query(cfg, ['container', 'inspect', '--format', '{{.Id}}', instance]);
    if (result.ok) return true;
    if (recognizedMissing(result, 'container', instance)) return false;
    throw new SupervisorError(
        `cannot verify runtime '${instance}' during cleanup: ${resultFailure(result)}`,
    );
}

function removeNamedRuntimeForCleanup(cfg, instance) {
    if (!namedRuntimePresence(cfg, instance)) return;
    runEngine(cfg, ['rm', '-f', '--volumes', instance], {
        allowFail: true,
        silence: 'all',
    });
    if (namedRuntimePresence(cfg, instance)) {
        throw new SupervisorError(
            `${cfg.engine} failed to remove the failed runtime '${instance}'`,
        );
    }
}

async function probeRouter(cfg, port, attempts = 30) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = query(cfg, [
            'exec', instanceName(cfg), 'node', '-e',
            'const http=require("node:http");const req=http.get({socketPath:process.argv[1],path:"/health"},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.setTimeout(2000,()=>{req.destroy();process.exit(1)});req.on("error",()=>process.exit(1));',
            '/workspace/.ploinky/run/router-health.sock',
        ]);
        if (result.ok) return 'health-socket';
        await runtimeDependencies(cfg).sleep(1000);
    }
    return null;
}

function rejectStartTailPort(args) {
    const token = args.find(arg => arg === '--port' || arg.startsWith('--port='));
    if (!token) return;
    die("start: --port must precede 'start'.\n"
        + 'Use: ploinky --port 9192 start explorer\n'
        + '  or: ploinky start explorer 9192');
}

function splitPublicStartArgs(args, options = {}) {
    const raw = args.map(String);
    rejectStartTailPort(raw);
    let agent = '';
    let hostPort;
    let profile = 'default';
    let profileWasExplicit = false;
    const passthrough = [];
    const selectProfile = value => {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) die('start: --profile needs a value');
        if (profileWasExplicit && profile !== normalized) {
            die(`start: conflicting profiles '${profile}' and '${normalized}'; give --profile once`);
        }
        profile = normalized;
        profileWasExplicit = true;
    };
    for (let index = 0; index < raw.length; index += 1) {
        const arg = raw[index];
        if (arg === '--profile') {
            const value = raw[index + 1];
            if (value === undefined || value === '' || value.startsWith('--')) {
                die('start: --profile needs a value');
            }
            selectProfile(value);
            index += 1;
            continue;
        }
        if (arg.startsWith('--profile=')) {
            selectProfile(arg.slice('--profile='.length));
            continue;
        }
        if (['--branch', '--repo-branch', '--branch-fallback'].includes(arg)) {
            passthrough.push(arg);
            if (index + 1 < raw.length) passthrough.push(raw[++index]);
            continue;
        }
        if (
            arg.startsWith('--branch=')
            || arg.startsWith('--repo-branch=')
            || arg.startsWith('--branch-fallback=')
        ) {
            passthrough.push(arg);
            continue;
        }
        if (arg === '--reset-repos') {
            passthrough.push(arg);
            continue;
        }
        if (arg.startsWith('--')) {
            passthrough.push(arg);
            continue;
        }
        if (!agent) {
            agent = arg;
            continue;
        }
        if (hostPort === undefined) {
            hostPort = arg;
            continue;
        }
        passthrough.push(arg);
    }
    const implicitBranchArgs = inferPublicStartBranchArgs(
        raw,
        options.env || process.env,
        options.sourceDir || '',
    );
    if (!agent) {
        return {
            hasAgent: false,
            agent: '',
            hostPort: undefined,
            profile,
            inBoxArgs: ['start', '--profile', profile, ...passthrough, ...implicitBranchArgs],
        };
    }
    return {
        hasAgent: true,
        agent,
        hostPort,
        profile,
        inBoxArgs: [
            'start', agent, String(BOX_ROUTER_PORT),
            '--profile', profile, ...passthrough, ...implicitBranchArgs,
        ],
    };
}

function runtimeHostPort(cfg) {
    const result = query(cfg, ['port', instanceName(cfg), `${BOX_ROUTER_PORT}/tcp`]);
    const first = result.stdout.split('\n')[0] || '';
    const index = first.lastIndexOf(':');
    return index === -1 ? '' : first.slice(index + 1).trim();
}

async function startGraph(cfg) {
    if (!cfg.sourceDirResolved) {
        cfg.sourceDirResolved = resolveHostPloinkySource(runtimeDependencies(cfg).env);
    }
    const startPlan = splitPublicStartArgs(cfg.args, {
        env: runtimeDependencies(cfg).env,
        sourceDir: cfg.sourceDirResolved,
    });
    if (startPlan.hostPort !== undefined) {
        const positionalPort = validateHostPort(startPlan.hostPort, 'start: positional host port');
        if (cfg.explicit.has('--port')) {
            const optionPort = validateHostPort(cfg.port, 'start: --port host port');
            if (optionPort !== positionalPort) {
                die(`start: conflicting host ports (--port ${optionPort} vs argument ${positionalPort}); give the port once`);
            }
        }
        cfg.port = positionalPort;
        // A positional start port is the public equivalent of the outer
        // --port option and must participate in existing-box reconciliation.
        cfg.explicit.add('--port');
    }
    const runtime = await reconcileRuntime(cfg, { fatalOnDepsDecline: true });
    const published = cfg.dryRun ? cfg.port : (runtimeHostPort(cfg) || cfg.port);
    const coreCode = forwardCoreCommand(
        forwardingContext(cfg, runtime),
        startPlan.inBoxArgs,
        false,
    );
    if (coreCode !== 0 || !startPlan.hasAgent) return coreCode;
    if (cfg.dryRun) return 0;
    const probePath = await probeRouter(cfg, published);
    if (probePath) {
        output(cfg, `ploinky: router responding on http://127.0.0.1:${published}/${probePath}\n`);
        return 0;
    }
    errorOutput(cfg, `ploinky: router did not respond on http://127.0.0.1:${published}; check: ploinky status\n`);
    return 1;
}

function forwardingContext(cfg, runtime) {
    const dependencies = runtimeDependencies(cfg);
    return {
        invocation: cfg,
        runtime,
        engine: engineClientFor(cfg),
        stdin: dependencies.stdin,
        stdout: dependencies.stdout,
    };
}

function appendCoreExecEnvironment(args, cfg, instance) {
    args.push('-e', `PLOINKY_RUNTIME_NAME=${instance}`);
    let routerHostPort;
    if (cfg.dryRun) {
        routerHostPort = validateHostPort(cfg.port, 'dry-run selected Router host port');
    } else {
        const inspected = inspectRuntimeIfPresent(engineClientFor(cfg), instance);
        if (!inspected) {
            throw new SupervisorError(`cannot derive Router host port: runtime '${instance}' is absent`);
        }
        try {
            assertFixedRuntimePublications(inspected);
            routerHostPort = String(parseSelectedHostPort(inspected.routerPublish?.hostPort, {
                source: `inspected ${BOX_ROUTER_PORT}/tcp HostPort for runtime '${instance}'`,
            }));
        } catch (error) {
            throw new SupervisorError(
                `cannot derive Router host port from the fixed inspected ${BOX_ROUTER_PORT}/tcp publication: ${error?.message || error}`,
            );
        }
    }
    args.push('-e', `PLOINKY_ROUTER_HOST_PORT=${routerHostPort}`);
    const inherited = runtimeDependencies(cfg).env || process.env;
    const processValue = String(inherited.PLOINKY_MASTER_KEY || '').trim();
    const fileValue = processValue
        ? ''
        : String(loadEnvFile(cfg.canonicalPath || process.cwd()).PLOINKY_MASTER_KEY || '').trim();
    const env = fileValue
        ? { ...inherited, PLOINKY_MASTER_KEY: fileValue }
        : inherited;
    if (String(env.PLOINKY_MASTER_KEY || '')) {
        // Passing only the variable name keeps the secret out of argv, labels,
        // inspect output, diagnostics, and the persistent outer configuration.
        args.push('-e', 'PLOINKY_MASTER_KEY');
    }
    return env;
}

export function forwardCoreCommand(context, args, interactive = false) {
    const { invocation: cfg, runtime, engine, stdin, stdout } = context;
    const execArgs = ['exec'];
    const hasTTY = Boolean(stdin.isTTY && stdout.isTTY);
    if (interactive) execArgs.push(hasTTY ? '-it' : '-i');
    if (['cli', 'shell'].includes(args[0]) && args.length > 1 && !hasTTY) {
        execArgs.push('-e', 'PLOINKY_NO_TTY=1');
    }
    const engineEnv = appendCoreExecEnvironment(execArgs, cfg, runtime.instance);
    execArgs.push('-w', '/workspace', runtime.instance);
    if (args.length === 0) execArgs.push('p-cli');
    else execArgs.push('ploinky', ...args);
    try {
        return engine.run(execArgs, { allowFail: true, env: engineEnv });
    } catch (error) {
        if (error instanceof SupervisorError) throw error;
        throw new SupervisorError(
            error?.message || String(error),
            Number.isInteger(error?.exitCode) ? error.exitCode : 1,
        );
    }
}

function inspectRuntimeIfPresent(engine, instance) {
    const result = engine.query(['container', 'inspect', instance]);
    if (!result.ok) {
        if (recognizedMissing(result, 'container', instance)) return null;
        throw new SupervisorError(`cannot inspect runtime '${instance}': ${resultFailure(result)}`);
    }
    return normalizeContainerInspect(engine.name, result.stdout);
}

function inspectLocalImage(engine, imageRef) {
    const result = engine.query(['image', 'inspect', imageRef]);
    if (!result.ok) return null;
    try { return normalizeImageInspect(result.stdout); } catch { return null; }
}

function printRuntimeSummary(stdout, runtime) {
    stdout.write(`runtime: ${runtime.instance} (${runtime.state})\n`);
    stdout.write(`image: ${runtime.requestedImage || runtime.configuredImage || '<unknown>'}\n`);
    stdout.write(`image-id: ${runtime.imageId || '<missing>'}\n`);
    const publishes = [runtime.routerPublish, runtime.udpReservation].filter(Boolean);
    for (const publish of publishes) {
        stdout.write(
            `publish: ${publish.hostIp || '*'}:${publish.hostPort}`
            + ` -> ${publish.containerPort}/${publish.protocol}\n`,
        );
    }
}

export async function reportCombinedStatus({ engine, invocation, stdout }) {
    const instance = instanceName(invocation);
    const inspected = inspectRuntimeIfPresent(engine, instance);
    if (!inspected) {
        stdout.write(`runtime: ${instance} (missing)\n`);
        const inventory = invocation._engineContext?.inventory;
        if (inventory) stdout.write(`resources: ${formatInventory(inventory)}\n`);
        return 1;
    }
    printRuntimeSummary(stdout, inspected);
    const image = inspectLocalImage(engine, inspected.imageId || inspected.configuredImage);
    let compatible = false;
    if (image) {
        try {
            validateImageContract(image, inspected.imageId || inspected.configuredImage);
            assertFixedRuntimePublications(inspected);
            const expectedLabels = {
                [REQUESTED_IMAGE_LABEL]: inspected.requestedImage,
                [PATH_HASH_LABEL]: invocation.pathHash,
            };
            compatible = Boolean(inspected.requestedImage)
                && JSON.stringify(Object.fromEntries(
                    Object.entries(inspected.labels || {}).sort(),
                )) === JSON.stringify(Object.fromEntries(
                    Object.entries(expectedLabels).sort(),
                ));
        } catch {
            compatible = false;
        }
    }
    stdout.write(`configuration: ${compatible ? 'compatible' : 'unsupported'}\n`);
    if (!inspected.running) return 1;
    const healthy = await engine.streamContains(
        ['logs', instance],
        '[ploinky-box] self-check OK',
    );
    stdout.write(`health: ${healthy ? 'healthy' : 'unhealthy'}\n`);
    const statusArgs = ['exec'];
    const statusEnv = appendCoreExecEnvironment(statusArgs, invocation, instance);
    statusArgs.push(
        '-w', '/workspace',
        instance,
        'ploinky', 'status',
    );
    const coreStatus = engine.run(statusArgs, {
        allowFail: true,
        env: statusEnv,
    });
    if (!compatible || !healthy) return 1;
    return coreStatus;
}

export function stopSystem({ engine, invocation, stdout, stderr }) {
    const instance = instanceName(invocation);
    const existing = inspectRuntimeIfPresent(engine, instance);
    if (!existing || !existing.running) {
        stdout.write(`runtime: '${instance}' already stopped\n`);
        return 0;
    }
    const stopArgs = ['exec'];
    const stopEnv = appendCoreExecEnvironment(stopArgs, invocation, instance);
    stopArgs.push(
        '-w', '/workspace',
        instance,
        'timeout', '30',
        'ploinky', 'stop',
    );
    const coreCode = engine.run(stopArgs, {
        allowFail: true,
        silence: 'all',
        env: stopEnv,
    });
    const outerCode = engine.run(['stop', instance], {
        allowFail: true,
        silence: 'all',
    });
    if (coreCode === 0) stdout.write('core shutdown: succeeded\n');
    else stderr.write(`core shutdown: failed (exit ${coreCode})\n`);
    if (outerCode === 0) stdout.write('outer runtime stop: succeeded\n');
    else stderr.write(`outer runtime stop: failed (exit ${outerCode})\n`);
    return coreCode === 0 && outerCode === 0 ? 0 : 1;
}

export async function destroySystem({
    engine,
    invocation,
    stdout,
    stderr,
    askLine: ask,
}) {
    const instance = instanceName(invocation);
    const names = volumeNames(invocation);
    const existing = inspectRuntimeIfPresent(engine, instance);
    if (!existing) {
        const retained = Object.values(names).filter(name =>
            engine.query(['volume', 'inspect', name]).ok
        );
        if (retained.length > 0) {
            stdout.write(`destroy: box '${instance}' is already absent; retained named volumes: ${retained.join(', ')}\n`);
        } else {
            stdout.write(`destroy: nothing to remove for '${instance}'\n`);
        }
        return 0;
    }
    const prompt = `Remove outer box '${instance}'? Its named volumes `
        + `'${names.workspace}', '${names.containers}', and '${names.deps}' will be retained. [y/N] `;
    const reply = await ask(prompt);
    if (!/^[yY]$/.test(reply || '')) {
        stderr.write('destroy: aborted\n');
        return 1;
    }
    const code = engine.run(
        ['rm', '-f', '--volumes', instance],
        { allowFail: true, silence: 'all' },
    );
    if (code !== 0) {
        stderr.write(`destroy: container removal failed (exit ${code})\n`);
        return 1;
    }
    stdout.write(`ploinky: '${instance}' removed; named volumes retained.\n`);
    return 0;
}

function defaultDependencies() {
    return {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
        cwd: () => process.cwd(),
        realpath: fs.realpathSync.native,
        env: process.env,
        showHelp,
        sleep,
        askLine,
        fetch,
        portInUse,
        createEngineClient,
    };
}

export function createRuntimeSupervisor(dependencies = {}) {
    const deps = { ...defaultDependencies(), ...dependencies };
    return {
        async run(argv) {
            const major = Number(process.versions.node.split('.')[0]);
            if (major < 20) {
                throw new SupervisorError(`Node >= 20 is required (found ${process.versions.node})`);
            }
            const invocation = parseHostInvocation(argv, deps.env);
            const route = routeHostInvocation(invocation);
            if (route.kind === 'help') {
                if (route.topic.length > 0) deps.showHelp(route.topic, { surface: 'host' });
                else deps.stdout.write(publicUsageText());
                return 0;
            }
            assertStateCommandFlags(invocation);
            Object.defineProperty(invocation, '_routeKind', {
                configurable: true,
                value: route.kind,
            });
            if (
                route.kind === 'ordinary'
                && route.forwardedArgs.length === 1
                && route.forwardedArgs[0] === 'cli'
                && !(deps.stdin.isTTY && deps.stdout.isTTY)
            ) {
                throw new SupervisorError("cli: parameterless 'cli' requires an interactive terminal.");
            }
            if (route.kind === 'start') rejectStartTailPort(invocation.args);

            const cwd = typeof deps.cwd === 'function' ? deps.cwd() : deps.cwd;
            resolveInstanceIdentity(invocation, cwd, deps.realpath || fs.realpathSync.native);
            Object.defineProperty(invocation, '_runtimeDependencies', {
                value: deps,
                configurable: true,
            });
            const executeResolvedRoute = async () => {
                const context = resolveEngineOwnership(invocation, deps);
                if (context.issue) {
                    if (route.kind === 'status') {
                        return reportDiscoveryStatus(invocation, context, deps.stdout);
                    }
                    throw new SupervisorError(
                        `${context.issue.message}; make every installed engine answer before retrying '${invocation.command || 'ploinky'}'`,
                    );
                }
                applyEngineContext(invocation, context);

                if (route.kind === 'status') {
                    return reportCombinedStatus({
                        engine: context.client,
                        invocation,
                        stdout: deps.stdout,
                    });
                }
                if (route.kind === 'stop') {
                    return stopSystem({
                        engine: context.client,
                        invocation,
                        stdout: deps.stdout,
                        stderr: deps.stderr,
                    });
                }
                if (route.kind === 'destroy') {
                    return destroySystem({
                        engine: context.client,
                        invocation,
                        stdout: deps.stdout,
                        stderr: deps.stderr,
                        askLine: deps.askLine,
                    });
                }
                // Read-only lifecycle commands retain access to incompatible
                // boxes so an operator can inspect, stop, and explicitly destroy
                // them. Every start/reconcile path proves the current contract
                // and rootless Podman before mutation.
                assertRootlessPodmanEngine(context.client);
                if (route.kind === 'start') return startGraph(invocation);

                const runtime = await reconcileRuntime(invocation, {
                    fatalOnDepsDecline: true,
                });
                if (route.kind === 'repl') {
                    return forwardCoreCommand(
                        forwardingContext(invocation, runtime),
                        [],
                        true,
                    );
                }
                return forwardCoreCommand(
                    forwardingContext(invocation, runtime),
                    route.forwardedArgs,
                    route.interactive,
                );
            };

            if (route.kind === 'status') return executeResolvedRoute();
            const runLocked = deps.withHostRuntimeLock
                || ((selected, callback) => withHostRuntimeLock(selected, callback, {
                    env: deps.env,
                }));
            return runLocked(invocation, executeResolvedRoute);
        },
    };
}

export async function runSupervisorWithBoundary(
    supervisor,
    argv,
    stderr = process.stderr,
) {
    try {
        return await supervisor.run(argv);
    } catch (error) {
        stderr.write(`ploinky: ${error.message || error}\n`);
        return Number.isInteger(error.exitCode) ? error.exitCode : 1;
    }
}

async function main() {
    const supervisor = createRuntimeSupervisor(defaultDependencies());
    process.exitCode = await runSupervisorWithBoundary(
        supervisor,
        process.argv.slice(2),
    );
}

function isMainModule() {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    try {
        return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
    } catch {
        return false;
    }
}

if (isMainModule()) await main();
