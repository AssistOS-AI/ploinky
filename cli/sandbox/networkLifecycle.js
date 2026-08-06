import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import {
    NETWORK_SCHEMA_VERSION,
    canonicalizeNetwork,
    deriveNetworkAlias,
    logicalNetworkAttachments,
    networkContractHash,
} from './networkContract.js';

export const NETWORK_STATUS_SCHEMA_VERSION = '3';
export const NETWORK_LABELS = Object.freeze({
    managed: 'io.assistos.ploinky.managed',
    resource: 'io.assistos.ploinky.resource',
    schema: 'io.assistos.ploinky.network-schema',
    workspace: 'io.assistos.ploinky.workspace',
    logical: 'io.assistos.ploinky.logical',
    contract: 'io.assistos.ploinky.network-contract',
    instanceId: 'io.assistos.ploinky.instance-id',
    enableGeneration: 'io.assistos.ploinky.enable-generation',
    releaseGeneration: 'io.assistos.ploinky.release-generation',
});

const MANAGED_HOST_NAME = 'host.containers.internal';
const MANAGED_HOST_MAPPING = `${MANAGED_HOST_NAME}:host-gateway`;
const LOCK_PATH = path.join(PLOINKY_DIR, 'run', 'network.lock');
const LOCK_REAPER_SUFFIX = '.reaper';
const GENERATED_ROUTER_DESCRIPTOR_TARGET = '/run/ploinky/router-descriptor.json';
const GENERATED_ROUTER_DESCRIPTOR_ROOT = path.join(PLOINKY_DIR, 'run', 'router-descriptors');
export const NETWORK_LOCK_STALE_GRACE_MS = 5_000;
export const NETWORK_LOCK_WAIT_MS = 60_000;
const NETWORK_LIFECYCLE_CAPABILITIES = new WeakMap();
const NETWORK_LIFECYCLE_CONTEXT = new AsyncLocalStorage();

function captureGeneratedRouterDescriptorArtifact(record) {
    const mounts = (record?.Mounts || []).filter((mount) => (
        String(mount?.Destination || '') === GENERATED_ROUTER_DESCRIPTOR_TARGET
    ));
    if (!mounts.length) return null;
    if (mounts.length !== 1 || mounts[0]?.RW !== false) {
        throw new Error('generated Router descriptor mount ownership is ambiguous');
    }
    const source = path.resolve(String(mounts[0]?.Source || ''));
    const root = path.resolve(GENERATED_ROUTER_DESCRIPTOR_ROOT);
    const relative = path.relative(root, source);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(relative)
        || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
        throw new Error('generated Router descriptor source is outside its runtime-owned root');
    }
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('generated Router descriptor source is not an exact 0600 regular file');
    }
    const realRoot = fs.realpathSync.native(root);
    const realSource = fs.realpathSync.native(source);
    if (realSource !== path.join(realRoot, relative)) {
        throw new Error('generated Router descriptor source failed real-path confinement');
    }
    return Object.freeze({ source, dev: stat.dev, ino: stat.ino });
}

function cleanupCapturedGeneratedRouterDescriptor(artifact) {
    if (!artifact) return;
    const stat = fs.lstatSync(artifact.source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== artifact.dev || stat.ino !== artifact.ino) {
        throw new Error('generated Router descriptor identity changed before cleanup');
    }
    fs.unlinkSync(artifact.source);
}

function hash12(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function workspaceNetworkIdentity(workspaceRoot = PLOINKY_WORKSPACE_ROOT) {
    let canonical = path.resolve(workspaceRoot);
    try { canonical = fs.realpathSync.native(canonical); } catch (_) {}
    return { canonical, hash: hash12(canonical) };
}

export function physicalNetworkName(workspaceHash, logicalName) {
    return `ploinky-nw-${workspaceHash}-${hash12(logicalName)}`;
}

function expectedNetworkLabels(workspaceHash, logicalName) {
    return {
        [NETWORK_LABELS.managed]: '1',
        [NETWORK_LABELS.resource]: 'network',
        [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
        [NETWORK_LABELS.workspace]: workspaceHash,
        [NETWORK_LABELS.logical]: logicalName,
    };
}

function expectedAgentOwnershipLabels(workspaceHash, contractHash) {
    return {
        [NETWORK_LABELS.managed]: '1',
        [NETWORK_LABELS.resource]: 'agent',
        [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
        [NETWORK_LABELS.workspace]: workspaceHash,
        [NETWORK_LABELS.contract]: contractHash,
    };
}

function exactRuntimeIdentity(runtimeIdentity, description = 'managed agent runtime') {
    const instanceId = String(runtimeIdentity?.instanceId || '').trim();
    const enableGeneration = String(runtimeIdentity?.enableGeneration || '').trim();
    if (!instanceId || !enableGeneration) {
        throw new Error(`${description} requires an exact instanceId and enableGeneration`);
    }
    const releaseGeneration = String(runtimeIdentity?.releaseGeneration || '').trim();
    if (releaseGeneration && !/^[a-f0-9]{64}$/.test(releaseGeneration)) {
        throw new Error(`${description} releaseGeneration must be an exact 64-character lowercase digest`);
    }
    return Object.freeze({ instanceId, enableGeneration, releaseGeneration });
}

function expectedAgentLabels(workspaceHash, contractHash, runtimeIdentity) {
    const exactIdentity = exactRuntimeIdentity(runtimeIdentity);
    return {
        ...expectedAgentOwnershipLabels(workspaceHash, contractHash),
        [NETWORK_LABELS.instanceId]: exactIdentity.instanceId,
        [NETWORK_LABELS.enableGeneration]: exactIdentity.enableGeneration,
        ...(exactIdentity.releaseGeneration
            ? { [NETWORK_LABELS.releaseGeneration]: exactIdentity.releaseGeneration }
            : {}),
    };
}

function firstRecord(raw, description) {
    let parsed;
    try { parsed = JSON.parse(String(raw || '')); } catch (error) {
        throw new Error(`${description} inspection returned malformed JSON: ${error.message}`);
    }
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!record || typeof record !== 'object') throw new Error(`${description} inspection returned no record`);
    return record;
}

function labelsOf(record) {
    return record?.Labels || record?.labels || record?.Config?.Labels || {};
}

function exactRuntimeAliases(record, explicitAlias) {
    const implicitIdAlias = String(record?.Id || record?.ID || '').slice(0, 12);
    return [explicitAlias, ...(implicitIdAlias ? [implicitIdAlias] : [])].sort();
}

function semanticRuntimeAliases(record, aliases) {
    const implicitIdAlias = String(record?.Id || record?.ID || '').slice(0, 12);
    return [...(aliases || [])]
        .map(String)
        .filter((alias) => alias && alias !== implicitIdAlias)
        .sort();
}

function hasExactLabels(observed, expected) {
    const observedKeys = Object.keys(observed || {}).sort();
    const expectedKeys = Object.keys(expected).sort();
    return observedKeys.length === expectedKeys.length
        && observedKeys.every((key, index) => key === expectedKeys[index])
        && Object.entries(expected).every(([key, value]) => String(observed?.[key] ?? '') === value);
}

function assertExactLabels(name, observed, expected) {
    const observedKeys = Object.keys(observed || {}).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (observedKeys.length !== expectedKeys.length
        || observedKeys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error(`resource '${name}' is foreign/unsupported: exact label keys expected '${expectedKeys.join(',')}', observed '${observedKeys.join(',')}'`);
    }
    for (const [key, value] of Object.entries(expected)) {
        if (String(observed?.[key] ?? '') !== value) {
            throw new Error(`resource '${name}' is foreign/unsupported: label ${key} expected '${value}', observed '${observed?.[key] ?? '<missing>'}'`);
        }
    }
}

function hasRequiredLabels(observed, expected) {
    return Object.entries(expected).every(([key, value]) => String(observed?.[key] ?? '') === value);
}

function assertRequiredLabels(name, observed, expected) {
    for (const [key, value] of Object.entries(expected)) {
        if (String(observed?.[key] ?? '') !== value) {
            throw new Error(`resource '${name}' is foreign/unsupported: label ${key} expected '${value}', observed '${observed?.[key] ?? '<missing>'}'`);
        }
    }
}

function containerRecordId(record, name) {
    const id = String(record?.Id || record?.ID || '');
    if (!id) throw new Error(`resource '${name}' is foreign/unsupported: immutable container ID is missing`);
    return id;
}

function networkAttachmentSetIsExact(record, mode, expectedNames = []) {
    const attached = record?.NetworkSettings?.Networks || {};
    const observedNames = Object.keys(attached).sort();
    const exactExpectedNames = [...expectedNames].sort();
    if (JSON.stringify(observedNames) === JSON.stringify(exactExpectedNames)) return true;
    // Podman 6 reports its built-in host/none network as one synthetic
    // attachment, while Podman 5 reports no attachment for the same exact
    // HostConfig.NetworkMode. Accept both representations, but no other key.
    if (!['host', 'none'].includes(mode)
        || observedNames.length !== 1
        || observedNames[0] !== mode
        || exactExpectedNames.length !== 0) {
        return false;
    }
    const attachment = attached[mode];
    return attachment
        && typeof attachment === 'object'
        && String(attachment.NetworkID || mode) === mode;
}

function processAlive(pid) {
    if (!Number.isInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function readLockOwner(lockPath) {
    try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) { return null; }
}

function ownerAgeMs(owner, now = Date.now(), fallbackMtimeMs = now) {
    const created = Date.parse(String(owner?.createdAt || ''));
    return Math.max(0, now - (Number.isFinite(created) ? created : fallbackMtimeMs));
}

function lockSnapshot(filePath, now = Date.now()) {
    try {
        const stat = fs.statSync(filePath);
        const raw = fs.readFileSync(filePath, 'utf8');
        let owner = null;
        try { owner = JSON.parse(raw); } catch (_) {}
        return {
            owner,
            ageMs: ownerAgeMs(owner, now, stat.mtimeMs),
            fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${raw}`,
        };
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function reapAbandonedFile(filePath, description, staleGraceMs, now) {
    const observed = lockSnapshot(filePath, now());
    if (!observed) return;
    if (observed.owner && processAlive(Number(observed.owner.pid))) {
        throw new Error(`${description} is already owned by pid ${observed.owner.pid}`);
    }
    if (observed.ageMs < staleGraceMs) {
        throw new Error(`${description} is unreadable or inside the stale-owner grace period`);
    }
    const confirmed = lockSnapshot(filePath, now());
    if (!confirmed || confirmed.fingerprint !== observed.fingerprint) {
        throw new Error(`${description} changed during stale-owner recovery`);
    }
    if (confirmed.owner && processAlive(Number(confirmed.owner.pid))) {
        throw new Error(`${description} became live during stale-owner recovery`);
    }
    fs.unlinkSync(filePath);
}

function releaseOwnedFile(filePath, token) {
    try {
        const current = readLockOwner(filePath);
        if (current?.token === token) fs.unlinkSync(filePath);
    } catch (_) {}
}

export function acquireNetworkLifecycleLock({
    lockPath = LOCK_PATH,
    staleGraceMs = NETWORK_LOCK_STALE_GRACE_MS,
    now = () => Date.now(),
} = {}) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const owner = { token, pid: process.pid, createdAt: new Date().toISOString() };
    const tryCreate = () => {
        try {
            fs.writeFileSync(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
            return true;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            return false;
        }
    };
    if (!tryCreate()) {
        const reaperPath = `${lockPath}${LOCK_REAPER_SUFFIX}`;
        reapAbandonedFile(reaperPath, 'network lifecycle stale-owner recovery', staleGraceMs, now);
        const reaperToken = randomUUID();
        const reaperOwner = { token: reaperToken, pid: process.pid, createdAt: new Date().toISOString() };
        try {
            fs.writeFileSync(reaperPath, JSON.stringify(reaperOwner), { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (error?.code === 'EEXIST') throw new Error('network lifecycle stale-owner recovery is already in progress');
            throw error;
        }
        try {
            reapAbandonedFile(lockPath, 'network lifecycle lock', staleGraceMs, now);
            if (!tryCreate()) throw new Error('network lifecycle was acquired during stale-owner recovery');
        } finally {
            releaseOwnedFile(reaperPath, reaperToken);
        }
    }
    let released = false;
    const capability = Object.freeze({});
    NETWORK_LIFECYCLE_CAPABILITIES.set(capability, lockPath);
    return {
        token,
        owner,
        lockPath,
        capability,
        release() {
            if (released) return;
            released = true;
            NETWORK_LIFECYCLE_CAPABILITIES.delete(capability);
            releaseOwnedFile(lockPath, token);
        },
    };
}

export function assertNetworkLifecycleCapability(capability, {
    lockPath = LOCK_PATH,
} = {}) {
    if (!capability || NETWORK_LIFECYCLE_CAPABILITIES.get(capability) !== lockPath) {
        const error = new Error('network lifecycle mutation requires the exact live path-bound capability');
        error.code = 'PLOINKY_NETWORK_LIFECYCLE_CAPABILITY_REQUIRED';
        throw error;
    }
    return capability;
}

export function withNetworkLifecycleLock(callback, options = {}) {
    if (typeof callback !== 'function') {
        throw new Error('network lifecycle mutation requires a callback');
    }
    const inheritedCapability = options.capability === undefined
        ? NETWORK_LIFECYCLE_CONTEXT.getStore()
        : undefined;
    if (options.capability !== undefined || inheritedCapability !== undefined) {
        const capability = assertNetworkLifecycleCapability(
            options.capability === undefined ? inheritedCapability : options.capability,
            options,
        );
        return callback(capability);
    }
    const waitMs = Math.max(0, Number(options.waitMs || 0));
    const pollMs = Math.max(10, Number(options.pollMs || 50));
    const deadline = Date.now() + waitMs;
    let lock;
    while (!lock) {
        try {
            lock = acquireNetworkLifecycleLock(options);
        } catch (error) {
            const contention = /already owned|already in progress|grace period|changed during stale-owner recovery|acquired during stale-owner recovery/i
                .test(String(error?.message || error));
            if (!contention || Date.now() >= deadline) {
                if (contention) {
                    const lockError = new Error(waitMs > 0
                        ? `timed out waiting ${waitMs}ms for network lifecycle serialization: ${error.message}`
                        : `network lifecycle is busy: ${error.message}`);
                    lockError.code = 'PLOINKY_NETWORK_LIFECYCLE_BUSY';
                    throw lockError;
                }
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(pollMs, deadline - Date.now()));
        }
    }
    let result;
    try {
        result = NETWORK_LIFECYCLE_CONTEXT.run(
            lock.capability,
            () => callback(lock.capability),
        );
    } catch (error) {
        lock.release();
        throw error;
    }
    if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => lock.release());
    }
    lock.release();
    return result;
}

function defaultRun(runtime, args, options = {}) {
    const result = spawnSync(runtime, args, {
        encoding: 'utf8',
        stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    return {
        ok: result.status === 0 && !result.error,
        status: Number.isInteger(result.status) ? result.status : 1,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
        error: result.error || null,
    };
}

function failure(result) {
    return String(result?.error?.message || result?.stderr || result?.stdout || `exit ${result?.status ?? 1}`).trim();
}

function missing(result) {
    return !result?.ok && /not found|no such|does not exist|no .* with name/i.test(`${result?.stderr || ''}\n${result?.stdout || ''}`);
}

function jsonScalar(value) {
    const source = String(value || '').trim();
    try { return String(JSON.parse(source)); } catch (_) { return source.replace(/^"|"$/g, ''); }
}

function versionAtLeast(value, minimumMajor, minimumMinor) {
    const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
}

function configFilesFromDirectory(directory) {
    try {
        return fs.readdirSync(directory)
            .filter((name) => name.endsWith('.conf'))
            .sort()
            .map((name) => path.join(directory, name));
    } catch (_) {
        return [];
    }
}

function effectiveContainersConfigFiles(env, explicitPaths) {
    if (Array.isArray(explicitPaths)) return explicitPaths.map(String);
    const override = String(env?.CONTAINERS_CONF_OVERRIDE || '').trim();
    const selected = String(env?.CONTAINERS_CONF || '').trim();
    const files = selected ? [selected] : [
        '/usr/share/containers/containers.conf',
        '/etc/containers/containers.conf',
        ...configFilesFromDirectory('/etc/containers/containers.conf.d'),
    ];
    const configHome = String(env?.XDG_CONFIG_HOME || '').trim()
        || (String(env?.HOME || '').trim() ? path.join(String(env.HOME), '.config') : '');
    if (!selected && configHome) {
        files.push(path.join(configHome, 'containers', 'containers.conf'));
        files.push(...configFilesFromDirectory(path.join(configHome, 'containers', 'containers.conf.d')));
    }
    if (override) files.push(override);
    return files;
}

function stripTomlComment(rawLine) {
    let quote = '';
    let escaped = false;
    for (let index = 0; index < rawLine.length; index += 1) {
        const character = rawLine[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote === '"' && character === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === '#') return rawLine.slice(0, index);
    }
    return rawLine;
}

function effectiveHostsConfiguration(env, explicitPaths) {
    let noHosts = false;
    let hostGatewayDisabled = false;
    for (const filePath of effectiveContainersConfigFiles(env, explicitPaths)) {
        let source;
        try { source = fs.readFileSync(filePath, 'utf8'); } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw new Error(`cannot read Podman containers configuration '${filePath}': ${error.message}`);
        }
        let section = '';
        for (const rawLine of source.split(/\r?\n/)) {
            const line = stripTomlComment(rawLine).trim();
            const sectionMatch = line.match(/^\[([^\]]+)\]$/);
            if (sectionMatch) {
                section = sectionMatch[1].trim();
                continue;
            }
            if (section === 'containers') {
                const noHostsMatch = line.match(/^no_hosts\s*=\s*(true|false)\s*$/i);
                if (noHostsMatch) noHosts = noHostsMatch[1].toLowerCase() === 'true';
                const gatewayMatch = line.match(/^host_containers_internal_ip\s*=\s*["']([^"']*)["']\s*$/i);
                if (gatewayMatch) hostGatewayDisabled = gatewayMatch[1].trim().toLowerCase() === 'none';
            }
        }
    }
    return { noHosts, hostGatewayDisabled };
}

function managedHostsPolicyIsExact(record) {
    const hostConfig = record?.HostConfig || {};
    return hostConfig.HostsFile === 'none'
        && Array.isArray(hostConfig.ExtraHosts)
        && hostConfig.ExtraHosts.length === 1
        && hostConfig.ExtraHosts[0] === MANAGED_HOST_MAPPING;
}

function hasExactlyOneManagedHostEntry(contents) {
    let count = 0;
    for (const rawLine of String(contents || '').split(/\r?\n/)) {
        const line = rawLine.replace(/#.*/, '').trim();
        if (!line) continue;
        const fields = line.split(/\s+/);
        count += fields.slice(1).filter((name) => name === MANAGED_HOST_NAME).length;
    }
    return count === 1;
}

export function createNetworkLifecycleAdapter({
    runtime,
    run = defaultRun,
    env = process.env,
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    lockPath = LOCK_PATH,
    containersConfigPaths,
    inspectRunningHosts,
} = {}) {
    if (!runtime) throw new Error('network lifecycle requires a container runtime');
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const execute = (args, options) => run(runtime, args, options);
    let rootlessPodmanVerified = false;
    let managedPodmanVerified = false;
    let managedPodmanProof = null;

    function stableDigest(value) {
        const visit = (entry) => {
            if (entry === null || typeof entry !== 'object') return JSON.stringify(entry);
            if (Array.isArray(entry)) return `[${entry.map(visit).join(',')}]`;
            return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${visit(entry[key])}`).join(',')}}`;
        };
        return `sha256:${crypto.createHash('sha256').update(visit(value)).digest('hex')}`;
    }

    const inspectNetwork = (name) => {
        const result = execute(['network', 'inspect', name]);
        if (!result.ok) {
            if (missing(result)) return null;
            throw new Error(`cannot inspect network '${name}': ${failure(result)}`);
        }
        return firstRecord(result.stdout, `network '${name}'`);
    };
    const inspectContainer = (name) => {
        const result = execute(['container', 'inspect', name]);
        if (!result.ok) {
            if (missing(result)) return null;
            throw new Error(`cannot inspect container '${name}': ${failure(result)}`);
        }
        return firstRecord(result.stdout, `container '${name}'`);
    };

    function ensureRootlessPodman() {
        if (rootlessPodmanVerified) return;
        if (runtime !== 'podman') {
            throw new Error(`runtime '${runtime}' cannot prove the managed rootless bridge contract; rootless Podman is required`);
        }
        const result = execute(['info', '--format', '{{json .Host.Security.Rootless}}']);
        if (!result.ok || jsonScalar(result.stdout) !== 'true') {
            throw new Error(`runtime '${runtime}' cannot prove rootless Podman ownership; refusing managed network mutation`);
        }
        rootlessPodmanVerified = true;
    }

    function ensureManagedPodman() {
        if (managedPodmanVerified) return managedPodmanProof;
        ensureRootlessPodman();
        const version = execute(['version', '--format', '{{.Server.Version}}']);
        if (!version.ok || !versionAtLeast(jsonScalar(version.stdout), 5, 4)) {
            throw new Error(`managed networking requires Podman server 5.4 or newer; observed '${jsonScalar(version.stdout) || failure(version)}'`);
        }
        const backend = execute(['info', '--format', '{{json .Host.NetworkBackend}}']);
        if (!backend.ok || jsonScalar(backend.stdout).toLowerCase() !== 'netavark') {
            throw new Error(`managed networking requires Netavark; observed '${jsonScalar(backend.stdout) || failure(backend)}'`);
        }
        const pasta = execute(['info', '--format', '{{json .Host.Pasta}}']);
        let pastaRecord = null;
        try { pastaRecord = JSON.parse(String(pasta.stdout || 'null')); } catch (_) {}
        const pastaExecutable = String(pastaRecord?.executable || pastaRecord?.Executable || '').trim();
        const pastaVersion = String(pastaRecord?.version || pastaRecord?.Version || '').trim();
        if (!pasta.ok
            || !pastaRecord
            || typeof pastaRecord !== 'object'
            || Array.isArray(pastaRecord)
            || !pastaExecutable
            || !pastaVersion) {
            throw new Error(`managed networking requires operational pasta backend metadata: ${failure(pasta)}`);
        }
        const remoteService = execute(['info', '--format', '{{json .Host.ServiceIsRemote}}']);
        const remoteServiceValue = jsonScalar(remoteService.stdout).toLowerCase();
        if (!remoteService.ok || !['true', 'false'].includes(remoteServiceValue)) {
            throw new Error(`managed networking cannot determine whether Podman is local or remote: ${failure(remoteService)}`);
        }
        if (remoteServiceValue === 'false') {
            const pastaProbe = execute(['unshare', pastaExecutable, '--version']);
            if (!pastaProbe.ok || !String(pastaProbe.stdout || '').trim()) {
                throw new Error(`managed networking requires an operational pasta backend: ${failure(pastaProbe)}`);
            }
            const hostsConfiguration = effectiveHostsConfiguration(env, containersConfigPaths);
            if (hostsConfiguration.noHosts) {
                throw new Error("managed networking is incompatible with effective Podman containers.conf setting no_hosts=true");
            }
            if (hostsConfiguration.hostGatewayDisabled) {
                throw new Error("managed networking is incompatible with host_containers_internal_ip='none'");
            }
        }
        // A remote Podman service reads containers.conf on the server, not from
        // this client. The managed transaction therefore verifies the exact
        // HostConfig and running /etc/hosts entry after remote container creation
        // and removes the candidate on any mismatch.
        managedPodmanProof = Object.freeze({
            engine: 'podman',
            rootless: true,
            version: jsonScalar(version.stdout),
            backend: 'netavark',
            remote: remoteServiceValue === 'true',
            pastaExecutable,
            pastaVersion,
            platform: process.platform,
        });
        managedPodmanVerified = true;
        return managedPodmanProof;
    }

    function assertSupportedNetwork(record, name, labels) {
        assertExactLabels(name, labelsOf(record), labels);
        if (String(record.Driver || record.driver || '') !== 'bridge') {
            throw new Error(`managed network '${name}' has unexpected driver '${record.Driver || record.driver || '<missing>'}'`);
        }
        const internal = record.Internal ?? record.internal ?? false;
        const ipv6 = record.IPv6Enabled ?? record.ipv6_enabled ?? record.EnableIPv6 ?? false;
        const dns = record.DNSEnabled ?? record.dns_enabled ?? true;
        if (internal !== false || ipv6 !== false || dns !== true) {
            throw new Error(`managed network '${name}' has unsupported bridge isolation, IPv6, or DNS options`);
        }
        const options = record.Options || record.options || {};
        if (Object.keys(options).length !== 1 || options.isolate !== 'true') {
            throw new Error(`managed network '${name}' must use the exact bridge option isolate=true`);
        }
        const ipam = record.IPAM?.Driver || record.ipam_options?.driver || '';
        if (String(ipam) !== 'host-local') {
            throw new Error(`managed network '${name}' has unsupported IPAM driver '${ipam}'`);
        }
        const ipamOptions = record.IPAM?.Options || record.ipam_options || {};
        const optionKeys = Object.keys(ipamOptions).filter((key) => key !== 'driver');
        if (optionKeys.length > 0) throw new Error(`managed network '${name}' has unsupported IPAM options`);
        const subnets = record.Subnets || record.subnets || record.IPAM?.Config;
        if (!Array.isArray(subnets) || subnets.length !== 1) {
            throw new Error(`managed network '${name}' must have exactly one runtime-assigned IPv4 subnet`);
        }
        const subnet = subnets[0] || {};
        const cidr = String(subnet.Subnet || subnet.subnet || '');
        const gateway = String(subnet.Gateway || subnet.gateway || '');
        const keys = Object.keys(subnet).map((key) => key.toLowerCase());
        if (!/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(cidr)
            || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)
            || keys.some((key) => !['subnet', 'gateway'].includes(key))) {
            throw new Error(`managed network '${name}' has unsupported subnet or address-pool configuration`);
        }
    }

    function expectedAttachments(network, canonicalAgentId, instanceKey) {
        return logicalNetworkAttachments(network, canonicalAgentId, { instanceKey }).map((entry) => ({
            name: physicalNetworkName(identity.hash, entry.name),
            logicalName: entry.name,
            primary: entry.primary === true,
        }));
    }

    function validateExpectedBridges(network, canonicalAgentId, instanceKey, { requireExisting = false } = {}) {
        return expectedAttachments(network, canonicalAgentId, instanceKey).map((entry) => {
            const existing = inspectNetwork(entry.name);
            if (!existing) {
                if (requireExisting) throw new Error(`managed network '${entry.name}' is missing`);
                return { ...entry, existed: false };
            }
            assertSupportedNetwork(existing, entry.name, expectedNetworkLabels(identity.hash, entry.logicalName));
            return { ...entry, existed: true };
        });
    }

    function ensureNetwork(logicalName, { deferFailureCleanup = false } = {}) {
        ensureManagedPodman();
        const name = physicalNetworkName(identity.hash, logicalName);
        const labels = expectedNetworkLabels(identity.hash, logicalName);
        const cleanupReceipt = Object.freeze({
            scope: 'managed-network-candidate',
            name,
            logicalName,
            ownershipLabels: Object.freeze({ ...labels }),
        });
        const existing = inspectNetwork(name);
        if (existing) {
            assertSupportedNetwork(existing, name, labels);
            return { name, logicalName, created: false };
        }
        const args = ['network', 'create', '--driver', 'bridge', '--opt', 'isolate=true'];
        for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
        args.push(name);
        const created = execute(args);
        if (!created.ok) {
            const raced = inspectNetwork(name);
            if (!raced) throw new Error(`cannot create managed network '${name}': ${failure(created)}`);
            assertSupportedNetwork(raced, name, labels);
            return { name, logicalName, created: false };
        }
        let verified;
        let inspectionCompleted = false;
        try {
            verified = inspectNetwork(name);
            inspectionCompleted = true;
            if (!verified) throw new Error(`managed network '${name}' disappeared after creation`);
            assertSupportedNetwork(verified, name, labels);
        } catch (error) {
            const createdResource = Object.freeze({
                name,
                logicalName,
                created: true,
                cleanupReceipt,
            });
            if (deferFailureCleanup) {
                Object.defineProperty(error, 'ploinkyCreatedManagedNetwork', {
                    configurable: false,
                    enumerable: false,
                    writable: false,
                    value: createdResource,
                });
                throw error;
            }
            const exactOwned = !verified || hasExactLabels(labelsOf(verified), labels);
            if (inspectionCompleted && exactOwned) {
                const removed = execute(['network', 'rm', name]);
                if (!removed.ok && !missing(removed)) {
                    error.message += `; cleanup preserved '${name}': ${failure(removed)}`;
                }
            } else if (inspectionCompleted) {
                error.message += `; cleanup preserved '${name}': exact ownership labels could not be verified`;
            } else {
                error.message += `; cleanup preserved '${name}': post-create inspection did not complete`;
            }
            throw error;
        }
        return { name, logicalName, created: true, cleanupReceipt };
    }

    function preflight(network, canonicalAgentId, { instanceKey = canonicalAgentId } = {}) {
        const contract = canonicalizeNetwork(network, { path: 'network' });
        const alias = deriveNetworkAlias(canonicalAgentId);
        if (contract.mode === 'none') {
            return { mode: 'none', alias, args: ['--network', 'none'], attachments: [] };
        }
        if (contract.mode === 'host') {
            return { mode: 'host', alias, args: ['--network', 'host'], attachments: [] };
        }
        const runtimeProof = ensureManagedPodman();
        return {
            mode: contract.mode,
            alias,
            attachments: validateExpectedBridges(contract, canonicalAgentId, instanceKey),
            runtimeProof,
        };
    }

    function rollbackResources(plan, error) {
        for (const entry of [...(plan?.created || [])].reverse()) {
            let inspected;
            try {
                inspected = inspectNetwork(entry.name);
            } catch (inspectionError) {
                error.message += `; rollback could not inspect '${entry.name}': ${inspectionError.message}`;
                continue;
            }
            if (!inspected) continue;
            try {
                const receipt = entry.cleanupReceipt;
                if (!receipt
                    || receipt.scope !== 'managed-network-candidate'
                    || receipt.name !== entry.name
                    || receipt.logicalName !== entry.logicalName
                    || !receipt.ownershipLabels) {
                    throw new Error('exact managed-network cleanup receipt is missing or inconsistent');
                }
                assertExactLabels(entry.name, labelsOf(inspected), receipt.ownershipLabels);
            } catch (inspectionError) {
                error.message += `; rollback preserved '${entry.name}': ${inspectionError.message}`;
                continue;
            }
            const containers = inspected.Containers || inspected.containers || {};
            if (Object.keys(containers).length > 0) {
                error.message += `; rollback preserved in-use network '${entry.name}'`;
                continue;
            }
            const removed = execute(['network', 'rm', entry.name]);
            if (!removed.ok && !missing(removed)) error.message += `; rollback preserved '${entry.name}': ${failure(removed)}`;
        }
    }

    function prepareFromPreflight(checked, { deferFailureCleanup = false } = {}) {
        if (!['default', 'bridge'].includes(checked.mode)) return { ...checked, created: [] };
        const plan = { ...checked, attachments: [], created: [] };
        try {
            for (const entry of checked.attachments) {
                const ensured = ensureNetwork(entry.logicalName, { deferFailureCleanup });
                if (ensured.created) plan.created.push(ensured);
                plan.attachments.push({ ...ensured, primary: entry.primary });
            }
            const primary = plan.attachments.find((entry) => entry.primary) || plan.attachments[0];
            plan.args = [
                '--network', primary.name,
                '--network-alias', checked.alias,
                '--hosts-file=none',
                '--add-host', MANAGED_HOST_MAPPING,
            ];
            plan.networkFingerprint = stableDigest({
                mode: plan.mode,
                alias: plan.alias,
                attachments: plan.attachments.map(({ name, logicalName, primary }) => ({ name, logicalName, primary })),
                runtimeProof: plan.runtimeProof,
                workspace: identity.hash,
            });
            return plan;
        } catch (error) {
            const partialResource = error?.ploinkyCreatedManagedNetwork;
            if (partialResource
                && !plan.created.some((entry) => entry.name === partialResource.name)) {
                plan.created.push(partialResource);
            }
            if (deferFailureCleanup) {
                const failurePlan = Object.freeze({
                    ...plan,
                    attachments: Object.freeze(plan.attachments.map((entry) => Object.freeze({ ...entry }))),
                    created: Object.freeze(plan.created.map((entry) => Object.freeze({ ...entry }))),
                });
                Object.defineProperty(error, 'ploinkyManagedNetworkFailurePlan', {
                    configurable: false,
                    enumerable: false,
                    writable: false,
                    value: failurePlan,
                });
            } else {
                rollbackResources(plan, error);
            }
            throw error;
        }
    }

    function prepare(network, canonicalAgentId, options = {}) {
        return prepareFromPreflight(preflight(network, canonicalAgentId, options));
    }

    function readRunningHosts(containerId) {
        if (typeof inspectRunningHosts === 'function') {
            const observed = inspectRunningHosts(containerId);
            if (typeof observed === 'string') return { supported: true, contents: observed };
            if (observed?.ok) return { supported: true, contents: String(observed.stdout || '') };
            if (observed === null || observed?.supported === false) {
                return { supported: false, contents: '' };
            }
            throw new Error(`cannot inspect running container hosts for '${containerId}'`);
        }
        const observed = execute(['exec', containerId, 'cat', '/etc/hosts']);
        if (!observed.ok) {
            throw new Error(`cannot inspect running container hosts for '${containerId}': ${failure(observed)}`);
        }
        return { supported: true, contents: String(observed.stdout || '') };
    }

    function assertManagedContainerRecord(record, containerName, plan, expectedLabels, expectedContainerId = '') {
        const id = containerRecordId(record, containerName);
        if (expectedContainerId && id !== expectedContainerId) {
            throw new Error(`container '${containerName}' changed identity during managed verification`);
        }
        assertRequiredLabels(containerName, labelsOf(record), expectedLabels);
        if (record?.HostConfig?.Init !== true) {
            throw new Error(`container '${containerName}' must use the managed init reaper`);
        }
        const managedMode = plan?.mode === 'default' || plan?.mode === 'bridge';
        if (!managedMode && String(record.HostConfig?.NetworkMode || '') !== plan.mode) {
            throw new Error(`container '${containerName}' network mode is unsupported`);
        }
        if (managedMode && !managedHostsPolicyIsExact(record)) {
            throw new Error(`container '${containerName}' has unsupported managed hosts policy`);
        }
        const attached = record.NetworkSettings?.Networks || {};
        const expectedNames = (plan.attachments || []).map((entry) => entry.name).sort();
        if (!networkAttachmentSetIsExact(record, plan.mode, expectedNames)) {
            throw new Error(`container '${containerName}' network attachment set is unsupported`);
        }
        for (const attachment of plan.attachments || []) {
            const observedAliases = [...(attached[attachment.name]?.Aliases || [])].map(String).sort();
            if (JSON.stringify(observedAliases) !== JSON.stringify(exactRuntimeAliases(record, plan.alias))) {
                throw new Error(`container '${containerName}' alias verification failed for '${attachment.name}'`);
            }
        }
        return id;
    }

    function finalizeContainer(containerName, plan, {
        expectedContainerId = '',
        expectedLabels = null,
        network = null,
        runtimeIdentity = null,
        beforeStart = null,
        deferFailureCleanup = false,
    } = {}) {
        const exactLabels = expectedLabels || (network && runtimeIdentity
            ? expectedAgentLabels(identity.hash, networkContractHash(network), runtimeIdentity)
            : null);
        if (!exactLabels) {
            throw new Error(`finalizing managed container '${containerName}' requires exact ownership and runtime-identity labels`);
        }

        let ownedContainerId = expectedContainerId;
        try {
            const initial = inspectContainer(containerName);
            if (!initial) throw new Error(`container '${containerName}' disappeared after creation`);
            ownedContainerId = containerRecordId(initial, containerName);
            if (expectedContainerId && ownedContainerId !== expectedContainerId) {
                throw new Error(`container '${containerName}' changed identity after creation`);
            }
            assertRequiredLabels(containerName, labelsOf(initial), exactLabels);
            const managedMode = plan?.mode === 'default' || plan?.mode === 'bridge';
            if (managedMode && !managedHostsPolicyIsExact(initial)) {
                throw new Error(`container '${containerName}' has unsupported managed hosts policy`);
            }
            for (const attachment of plan.attachments?.filter((entry) => !entry.primary) || []) {
                const result = execute(['network', 'connect', '--alias', plan.alias, attachment.name, ownedContainerId]);
                if (!result.ok) throw new Error(`cannot attach '${containerName}' to '${attachment.name}': ${failure(result)}`);
            }
            const configured = inspectContainer(ownedContainerId);
            if (!configured) throw new Error(`container '${containerName}' disappeared during network verification`);
            assertManagedContainerRecord(configured, containerName, plan, exactLabels, ownedContainerId);
            if (beforeStart !== null && typeof beforeStart !== 'function') {
                throw new Error(`finalizing managed container '${containerName}' received an invalid pre-start checkpoint`);
            }
            if (beforeStart) beforeStart({ plan, containerId: ownedContainerId, record: configured });
            const started = execute(['start', ownedContainerId], { inherit: true });
            if (!started.ok) throw new Error(`cannot start '${containerName}': ${failure(started)}`);
            const running = inspectContainer(ownedContainerId);
            if (!running || !(running.State?.Running === true || running.State?.Status === 'running')) {
                throw new Error(`container '${containerName}' did not reach running state`);
            }
            assertManagedContainerRecord(running, containerName, plan, exactLabels, ownedContainerId);
            if (managedMode) {
                const hosts = readRunningHosts(ownedContainerId);
                if (hosts.supported && !hasExactlyOneManagedHostEntry(hosts.contents)) {
                    throw new Error(`container '${containerName}' must have exactly one ${MANAGED_HOST_NAME} entry`);
                }
            }
            return ownedContainerId;
        } catch (error) {
            if (!deferFailureCleanup && ownedContainerId) {
                let current = null;
                try { current = inspectContainer(ownedContainerId); } catch (_) {}
                if (current
                    && String(current?.Id || current?.ID || '') === ownedContainerId
                    && hasRequiredLabels(labelsOf(current), exactLabels)) {
                    execute(['rm', '-f', ownedContainerId]);
                }
            }
            throw error;
        }
    }

    function runManagedContainerTransaction({
        network,
        canonicalAgentId,
        instanceKey = canonicalAgentId,
        containerName,
        runtimeIdentity,
        createContainer,
        inspectAdoption = null,
        prepareLaunch = null,
        preStartLaunch = null,
        finalizeLaunch = null,
        afterPredecessorContained = null,
        requirePredecessorContainment = false,
        beforeFailureCleanup = null,
        networkLockWaitMs = NETWORK_LOCK_WAIT_MS,
        networkLifecycleCapability,
    }) {
        if (typeof createContainer !== 'function') throw new Error('managed container transaction requires createContainer');
        if (inspectAdoption !== null && typeof inspectAdoption !== 'function') {
            throw new Error('managed container transaction inspectAdoption must be a function');
        }
        if (prepareLaunch !== null && typeof prepareLaunch !== 'function') {
            throw new Error('managed container transaction prepareLaunch must be a function');
        }
        if (preStartLaunch !== null && typeof preStartLaunch !== 'function') {
            throw new Error('managed container transaction preStartLaunch must be a function');
        }
        if (finalizeLaunch !== null && typeof finalizeLaunch !== 'function') {
            throw new Error('managed container transaction finalizeLaunch must be a function');
        }
        if (afterPredecessorContained !== null && typeof afterPredecessorContained !== 'function') {
            throw new Error('managed container transaction afterPredecessorContained must be a function');
        }
        if (typeof requirePredecessorContainment !== 'boolean') {
            throw new Error('managed container transaction requirePredecessorContainment must be boolean');
        }
        if (requirePredecessorContainment && !afterPredecessorContained) {
            throw new Error('managed container transaction required containment needs a cleanup callback');
        }
        if (beforeFailureCleanup !== null && typeof beforeFailureCleanup !== 'function') {
            throw new Error('managed container transaction beforeFailureCleanup must be a function');
        }
        return withNetworkLifecycleLock(() => {
            const checked = preflight(network, canonicalAgentId, { instanceKey });
            if (!['default', 'bridge'].includes(checked.mode)) {
                throw new Error(`managed container transaction cannot run network mode '${checked.mode}'`);
            }
            const ownershipLabels = expectedAgentOwnershipLabels(identity.hash, networkContractHash(network));
            const agentLabels = expectedAgentLabels(identity.hash, networkContractHash(network), runtimeIdentity);
            const previous = inspectContainer(containerName);
            let previousId = '';
            if (previous) {
                assertRequiredLabels(containerName, labelsOf(previous), ownershipLabels);
                previousId = containerRecordId(previous, containerName);
            }
            if (requirePredecessorContainment && !previous) {
                throw new Error(`managed replacement required predecessor is absent for '${containerName}'`);
            }
            let candidateCreationAttempted = false;
            let plan = null;
            let launch = null;
            try {
                plan = prepareFromPreflight(checked, {
                    deferFailureCleanup: Boolean(beforeFailureCleanup),
                });
                if (!requirePredecessorContainment && previous && inspectAdoption
                    && hasRequiredLabels(labelsOf(previous), agentLabels)
                    && (previous?.State?.Running === true || previous?.State?.Status === 'running')) {
                    const adoption = inspectAdoption({
                        plan,
                        record: previous,
                        containerId: previousId,
                    });
                    if (!adoption || adoption.adopted !== true) {
                        const mismatch = new Error(
                            `managed candidate '${containerName}' failed fresh semantic descriptor adoption: ${String(adoption?.reason || 'mismatch')}`,
                        );
                        mismatch.code = 'PLOINKY_SEMANTIC_ADOPTION_MISMATCH';
                        throw mismatch;
                    }
                    const finalRecord = inspectContainer(previousId);
                    if (!finalRecord) throw new Error(`managed adoption candidate '${containerName}' disappeared`);
                    assertManagedContainerRecord(finalRecord, containerName, plan, agentLabels, previousId);
                    if (!(finalRecord?.State?.Running === true || finalRecord?.State?.Status === 'running')) {
                        throw new Error(`managed adoption candidate '${containerName}' stopped during final inspection`);
                    }
                    if (typeof adoption.finalize === 'function') adoption.finalize(finalRecord);
                    return {
                        ...plan,
                        adopted: true,
                        containerId: previousId,
                        launch: adoption.launch || null,
                    };
                }
                if (previous) {
                    const current = inspectContainer(containerName);
                    if (!current || containerRecordId(current, containerName) !== previousId) {
                        throw new Error(`resource '${containerName}' changed identity before managed replacement`);
                    }
                    assertRequiredLabels(containerName, labelsOf(current), ownershipLabels);
                    const previousDescriptor = captureGeneratedRouterDescriptorArtifact(current);
                    if (previous?.State?.Running === true || previous?.State?.Status === 'running') {
                        const stopped = execute(['stop', previousId]);
                        if (!stopped.ok) {
                            const reconciled = inspectContainer(previousId);
                            const reconciledId = reconciled
                                ? containerRecordId(reconciled, containerName)
                                : '';
                            const reconciledRunning = reconciled?.State?.Running === true
                                || reconciled?.State?.Status === 'running';
                            if (!reconciled
                                || reconciledId !== previousId
                                || reconciledRunning) {
                                throw new Error(`cannot stop '${containerName}' for managed replacement: ${failure(stopped)}`);
                            }
                            assertRequiredLabels(
                                containerName,
                                labelsOf(reconciled),
                                ownershipLabels,
                            );
                        }
                    }
                    const contained = inspectContainer(previousId);
                    if (contained) {
                        if (containerRecordId(contained, containerName) !== previousId) {
                            throw new Error(`resource '${containerName}' changed identity after managed containment`);
                        }
                        assertRequiredLabels(containerName, labelsOf(contained), ownershipLabels);
                        if (contained?.State?.Running === true || contained?.State?.Status === 'running') {
                            throw new Error(`managed predecessor '${containerName}' remained running after stop`);
                        }
                    }
                    if (afterPredecessorContained) {
                        afterPredecessorContained(Object.freeze({
                            containerId: previousId,
                            record: contained || current,
                            state: contained ? 'stopped' : 'absent',
                        }));
                    }
                    const removed = execute(['rm', '-f', previousId]);
                    if (!removed.ok && !missing(removed)) {
                        throw new Error(`cannot remove predecessor '${containerName}' for managed replacement: ${failure(removed)}`);
                    }
                    if (previousDescriptor) {
                        if (!removed.ok || inspectContainer(previousId)) {
                            throw new Error(`cannot prove exact predecessor '${containerName}' removal for descriptor cleanup`);
                        }
                        cleanupCapturedGeneratedRouterDescriptor(previousDescriptor);
                    }
                }
                // This hook remains under the canonical network mutation lock.
                // It may perform the credentialless final-namespace authority
                // attestation and only then construct key-capable launch state.
                launch = prepareLaunch ? prepareLaunch(plan) : null;
                candidateCreationAttempted = true;
                createContainer(plan, launch);
                const candidate = inspectContainer(containerName);
                if (!candidate) throw new Error(`managed candidate '${containerName}' disappeared after creation`);
                assertRequiredLabels(containerName, labelsOf(candidate), agentLabels);
                const candidateId = containerRecordId(candidate, containerName);
                const containerId = finalizeContainer(containerName, plan, {
                    expectedContainerId: candidateId,
                    expectedLabels: agentLabels,
                    deferFailureCleanup: Boolean(beforeFailureCleanup),
                    beforeStart: preStartLaunch
                        ? (context) => preStartLaunch({ ...context, launch })
                        : null,
                });
                const finalRecord = inspectContainer(containerId);
                if (!finalRecord || containerRecordId(finalRecord, containerName) !== containerId) {
                    throw new Error(`managed candidate '${containerName}' changed identity after final inspection`);
                }
                if (finalizeLaunch) finalizeLaunch({ plan, launch, containerId, record: finalRecord });
                return { ...plan, containerId, launch };
            } catch (error) {
                plan ||= error?.ploinkyManagedNetworkFailurePlan || null;
                let candidate = null;
                let candidateInspectionComplete = false;
                let candidatePresent = false;
                let candidateId = '';
                let candidateOwned = false;
                let launchArtifactCleanupSafe = false;
                const createdNetworks = Object.freeze((plan?.created || []).map((entry) => Object.freeze({
                    name: entry.name,
                    logicalName: entry.logicalName,
                    cleanupReceipt: entry.cleanupReceipt,
                })));
                try {
                    candidate = inspectContainer(containerName);
                    candidateInspectionComplete = true;
                    candidatePresent = Boolean(candidate);
                    candidateId = String(candidate?.Id || candidate?.ID || '');
                    candidateOwned = Boolean(candidate && hasRequiredLabels(labelsOf(candidate), agentLabels));
                } catch (inspectError) {
                    error.message += `; failure cleanup could not inspect candidate '${containerName}': ${inspectError.message}`;
                }
                if (beforeFailureCleanup) {
                    try {
                        beforeFailureCleanup(Object.freeze({
                            candidateCreationAttempted,
                            candidatePresent,
                            candidateId,
                            candidateInspectionComplete,
                            candidateOwned,
                            createdNetworks,
                            error,
                        }));
                    } catch (recoveryError) {
                        Object.defineProperty(recoveryError, 'ploinkyManagedFailureRecovery', {
                            configurable: true,
                            enumerable: false,
                            writable: false,
                            value: Object.freeze({
                                candidateCreationAttempted,
                                candidatePresent,
                                candidateId,
                                candidateInspectionComplete,
                                candidateOwned,
                                exactCleanupPerformed: false,
                                preparationAbortFailed: true,
                                preparationAbortedBeforeCleanup: false,
                                resourcesRolledBack: false,
                                createdNetworks,
                            }),
                        });
                        throw recoveryError;
                    }
                }
                if (candidateCreationAttempted && candidateInspectionComplete && !candidate) {
                    launchArtifactCleanupSafe = true;
                } else if (candidateCreationAttempted
                    && candidate
                    && candidateOwned) {
                    if (!candidateId) {
                        error.message += `; failure cleanup preserved candidate '${containerName}' because its immutable ID was unavailable`;
                    } else {
                        const removed = execute(['rm', '-f', candidateId]);
                        if (!removed.ok && !missing(removed)) {
                            error.message += `; failure cleanup could not remove candidate '${containerName}': ${failure(removed)}`;
                        } else {
                            try {
                                const remaining = inspectContainer(candidateId);
                                if (!remaining) launchArtifactCleanupSafe = true;
                                else error.message += `; failure cleanup preserved candidate '${containerName}' because immutable-ID absence was not proven`;
                            } catch (inspectError) {
                                error.message += `; failure cleanup could not prove immutable-ID absence for '${containerName}': ${inspectError.message}`;
                            }
                        }
                    }
                } else if (candidateCreationAttempted && candidate) {
                    error.message += `; failure cleanup preserved candidate '${containerName}' because exact ownership labels were not proven`;
                }
                if (launch && typeof launch.cleanup === 'function') {
                    if (!launchArtifactCleanupSafe) {
                        error.message += '; launch artifact preserved because exact candidate absence was not proven';
                    } else {
                        try { launch.cleanup(); } catch (cleanupError) {
                            error.message += `; launch artifact cleanup failed: ${cleanupError.message}`;
                        }
                    }
                }
                if (plan) rollbackResources(plan, error);
                Object.defineProperty(error, 'ploinkyManagedFailureRecovery', {
                    configurable: true,
                    enumerable: false,
                    writable: false,
                    value: Object.freeze({
                        candidateCreationAttempted,
                        candidatePresent,
                        candidateId,
                        candidateInspectionComplete,
                        candidateOwned,
                        exactCleanupPerformed: launchArtifactCleanupSafe,
                        preparationAbortFailed: false,
                        preparationAbortedBeforeCleanup: Boolean(beforeFailureCleanup),
                        resourcesRolledBack: true,
                        createdNetworks,
                    }),
                });
                throw error;
            }
        }, {
            lockPath,
            waitMs: networkLockWaitMs,
            ...(networkLifecycleCapability ? { capability: networkLifecycleCapability } : {}),
        });
    }

    function adoptManagedContainerTransaction({
        network,
        canonicalAgentId,
        instanceKey = canonicalAgentId,
        containerName,
        runtimeIdentity,
        inspectAdoption,
        networkLockWaitMs = NETWORK_LOCK_WAIT_MS,
        networkLifecycleCapability,
    }) {
        if (typeof inspectAdoption !== 'function') {
            throw new Error('managed container adoption requires inspectAdoption');
        }
        return withNetworkLifecycleLock(() => {
            const checked = preflight(network, canonicalAgentId, { instanceKey });
            if (!['default', 'bridge'].includes(checked.mode)) {
                throw new Error(`managed container adoption cannot run network mode '${checked.mode}'`);
            }
            const plan = prepareFromPreflight(checked);
            try {
                const expectedLabels = expectedAgentLabels(
                    identity.hash,
                    networkContractHash(network),
                    runtimeIdentity,
                );
                const initial = inspectContainer(containerName);
                if (!initial) return Object.freeze({ adopted: false, reason: 'absent' });
                const containerId = assertManagedContainerRecord(
                    initial,
                    containerName,
                    plan,
                    expectedLabels,
                );
                if (!(initial?.State?.Running === true || initial?.State?.Status === 'running')) {
                    return Object.freeze({ adopted: false, reason: 'not-running', containerId });
                }
                const adoption = inspectAdoption({ plan, record: initial, containerId });
                if (!adoption || adoption.adopted !== true) {
                    return Object.freeze({
                        adopted: false,
                        reason: String(adoption?.reason || 'semantic-mismatch'),
                        containerId,
                    });
                }
                const finalRecord = inspectContainer(containerId);
                if (!finalRecord) throw new Error(`managed adoption candidate '${containerName}' disappeared`);
                assertManagedContainerRecord(finalRecord, containerName, plan, expectedLabels, containerId);
                if (!(finalRecord?.State?.Running === true || finalRecord?.State?.Status === 'running')) {
                    throw new Error(`managed adoption candidate '${containerName}' stopped during final inspection`);
                }
                if (typeof adoption.finalize === 'function') adoption.finalize(finalRecord);
                return Object.freeze({ ...plan, adopted: true, containerId, adoption });
            } catch (error) {
                rollbackResources(plan, error);
                throw error;
            }
        }, {
            lockPath,
            waitMs: networkLockWaitMs,
            ...(networkLifecycleCapability ? { capability: networkLifecycleCapability } : {}),
        });
    }

    function attachmentIsOwnedAgent(labels) {
        return labels?.[NETWORK_LABELS.managed] === '1'
            && labels?.[NETWORK_LABELS.resource] === 'agent'
            && labels?.[NETWORK_LABELS.schema] === NETWORK_SCHEMA_VERSION
            && labels?.[NETWORK_LABELS.workspace] === identity.hash
            && /^[a-f0-9]{64}$/.test(String(labels?.[NETWORK_LABELS.contract] || ''))
            && Boolean(String(labels?.[NETWORK_LABELS.instanceId] || '').trim())
            && Boolean(String(labels?.[NETWORK_LABELS.enableGeneration] || '').trim());
    }

    function status() {
        const result = execute(['network', 'ls', '--format', 'json']);
        if (!result.ok) throw new Error(`cannot list networks: ${failure(result)}`);
        let records;
        try { records = JSON.parse(result.stdout || '[]'); } catch (error) {
            throw new Error(`network list returned malformed JSON: ${error.message}`);
        }
        if (!Array.isArray(records)) records = [records];
        const prefix = `ploinky-nw-${identity.hash}-`;
        const networks = records.filter((record) => (
            String(labelsOf(record)?.[NETWORK_LABELS.workspace] || '') === identity.hash
            || String(record.Name || record.name || '').startsWith(prefix)
        )).map((summary) => {
            const physicalName = String(summary.Name || summary.name || '');
            const inspected = inspectNetwork(physicalName) || summary;
            const labels = labelsOf(inspected);
            const logicalName = String(labels?.[NETWORK_LABELS.logical] || '');
            const expected = logicalName ? expectedNetworkLabels(identity.hash, logicalName) : null;
            const containers = inspected.Containers || inspected.containers || {};
            const attachments = Object.entries(containers).map(([id, entry]) => {
                const containerName = String(entry?.Name || entry?.name || id);
                let container = null;
                try { container = inspectContainer(containerName); } catch (_) {}
                const networkRecord = container?.NetworkSettings?.Networks?.[physicalName] || {};
                return {
                    containerName,
                    ownership: attachmentIsOwnedAgent(labelsOf(container || {})) ? 'agent' : 'unknown',
                    aliases: semanticRuntimeAliases(container, networkRecord.Aliases || entry?.Aliases || []),
                };
            }).sort((a, b) => a.containerName.localeCompare(b.containerName));
            return {
                logicalName,
                physicalName,
                ownership: expected && hasExactLabels(labels, expected) ? 'owned' : 'foreign',
                driver: String(inspected.Driver || inspected.driver || ''),
                attachments,
            };
        }).sort((a, b) => a.physicalName.localeCompare(b.physicalName));
        return {
            schemaVersion: NETWORK_STATUS_SCHEMA_VERSION,
            workspaceHash: identity.hash,
            networks,
        };
    }

    function inspectContainerContract(containerName, network, canonicalAgentId, {
        instanceKey = canonicalAgentId,
        contractHash,
        instanceId = '',
        enableGeneration = '',
        releaseGeneration = '',
        requireRuntimeIdentity = false,
    } = {}) {
        const record = inspectContainer(containerName);
        if (!record) return { state: 'absent', id: null };
        const expectedHash = String(contractHash || '');
        const labels = labelsOf(record);
        const ownershipLabels = expectedAgentOwnershipLabels(identity.hash, expectedHash);
        if (!expectedHash || !hasRequiredLabels(labels, ownershipLabels)) {
            return { state: 'foreign', id: String(record?.Id || record?.ID || '') || null };
        }
        let id;
        try { id = containerRecordId(record, containerName); } catch (_) {
            return { state: 'foreign', id: null };
        }
        if (requireRuntimeIdentity) {
            const expectedInstanceId = String(instanceId || '').trim();
            const expectedEnableGeneration = String(enableGeneration || '').trim();
            const expectedReleaseGeneration = String(releaseGeneration || '').trim();
            if (!expectedInstanceId || !expectedEnableGeneration
                || String(labels?.[NETWORK_LABELS.instanceId] || '') !== expectedInstanceId
                || String(labels?.[NETWORK_LABELS.enableGeneration] || '') !== expectedEnableGeneration
                || String(labels?.[NETWORK_LABELS.releaseGeneration] || '') !== expectedReleaseGeneration) {
                return { state: 'owned-drift', id, reason: 'runtime-identity' };
            }
        }
        if (record?.HostConfig?.Init !== true) {
            return { state: 'owned-drift', id, reason: 'init-reaper' };
        }
        const contract = canonicalizeNetwork(network, { path: 'network' });
        const managedMode = contract.mode === 'default' || contract.mode === 'bridge';
        if (managedMode) ensureManagedPodman();
        if (!managedMode && String(record.HostConfig?.NetworkMode || '') !== contract.mode) {
            return { state: 'owned-drift', id };
        }
        const expected = expectedAttachments(contract, canonicalAgentId, instanceKey);
        let bridgesExact = true;
        for (const attachment of expected) {
            const bridge = inspectNetwork(attachment.name);
            if (!bridge) {
                bridgesExact = false;
                continue;
            }
            assertSupportedNetwork(
                bridge,
                attachment.name,
                expectedNetworkLabels(identity.hash, attachment.logicalName),
            );
        }
        if (!bridgesExact || (managedMode && !managedHostsPolicyIsExact(record))) {
            return { state: 'owned-drift', id };
        }
        const attached = record.NetworkSettings?.Networks || {};
        if (!networkAttachmentSetIsExact(
            record,
            contract.mode,
            expected.map((entry) => entry.name),
        )) {
            return { state: 'owned-drift', id };
        }
        const alias = deriveNetworkAlias(canonicalAgentId);
        const aliasesExact = expected.every((entry) => {
            const aliases = [...(attached[entry.name]?.Aliases || [])].map(String).sort();
            return JSON.stringify(aliases) === JSON.stringify(exactRuntimeAliases(record, alias));
        });
        if (!aliasesExact) return { state: 'owned-drift', id };
        if (managedMode && (record.State?.Running === true || record.State?.Status === 'running')) {
            const hosts = readRunningHosts(id);
            if (hosts.supported && !hasExactlyOneManagedHostEntry(hosts.contents)) {
                return { state: 'owned-drift', id };
            }
        }
        return { state: 'exact', id };
    }

    function verifyContainerContract(containerName, network, canonicalAgentId, options = {}) {
        return inspectContainerContract(containerName, network, canonicalAgentId, options).state === 'exact';
    }

    function agentIdentityLabelArgs(network, runtimeIdentity) {
        return Object.entries(expectedAgentLabels(identity.hash, networkContractHash(network), runtimeIdentity))
            .flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    }

    function removeExactContainer(containerName, network, canonicalAgentId, {
        expectedContainerId,
        instanceKey = canonicalAgentId,
        contractHash,
        instanceId,
        enableGeneration,
        releaseGeneration,
    } = {}) {
        const exactContainerId = String(expectedContainerId || '').trim();
        if (!exactContainerId) {
            throw new Error(`exact cleanup for '${containerName}' requires an immutable container ID`);
        }
        const inspection = inspectContainerContract(exactContainerId, network, canonicalAgentId, {
            instanceKey,
            contractHash,
            instanceId,
            enableGeneration,
            releaseGeneration,
            requireRuntimeIdentity: true,
        });
        if (inspection.state === 'absent') {
            return { removed: false, state: 'absent', id: exactContainerId };
        }
        if (inspection.state !== 'exact' || inspection.id !== exactContainerId) {
            return {
                removed: false,
                state: inspection.state,
                id: inspection.id || exactContainerId,
                reason: inspection.reason || 'ownership-mismatch',
            };
        }
        const exactRecord = inspectContainer(exactContainerId);
        if (!exactRecord || containerRecordId(exactRecord, containerName) !== exactContainerId) {
            return { removed: false, state: 'identity-drift', id: exactContainerId, reason: 'immutable-id-mismatch' };
        }
        const descriptorArtifact = captureGeneratedRouterDescriptorArtifact(exactRecord);
        const removed = execute(['rm', '-f', exactContainerId]);
        if (!removed.ok && !missing(removed)) {
            throw new Error(`cannot remove exact failed candidate '${containerName}' (${exactContainerId}): ${failure(removed)}`);
        }
        if (descriptorArtifact) {
            if (!removed.ok || inspectContainer(exactContainerId)) {
                throw new Error(`cannot prove exact failed candidate '${containerName}' removal for descriptor cleanup`);
            }
            cleanupCapturedGeneratedRouterDescriptor(descriptorArtifact);
        }
        return { removed: true, state: 'removed', id: exactContainerId };
    }

    function pruneUnlocked() {
        ensureRootlessPodman();
        const report = { removed: [], preserved: [] };
        for (const record of status().networks) {
            if (record.ownership !== 'owned') {
                report.preserved.push({ ...record, name: record.physicalName, reason: 'foreign' });
                continue;
            }
            const inspected = inspectNetwork(record.physicalName);
            if (!inspected) continue;
            try {
                assertSupportedNetwork(
                    inspected,
                    record.physicalName,
                    expectedNetworkLabels(identity.hash, record.logicalName),
                );
            } catch (error) {
                report.preserved.push({ ...record, name: record.physicalName, reason: `unsupported: ${error.message}` });
                continue;
            }
            const containers = inspected.Containers || inspected.containers || {};
            if (Object.keys(containers).length > 0) {
                report.preserved.push({ ...record, name: record.physicalName, reason: 'in-use' });
                continue;
            }
            const removed = execute(['network', 'rm', record.physicalName]);
            if (removed.ok || missing(removed)) report.removed.push(record.physicalName);
            else report.preserved.push({ ...record, name: record.physicalName, reason: failure(removed) });
        }
        return report;
    }

    function prune() {
        return withNetworkLifecycleLock(pruneUnlocked, { lockPath });
    }

    return {
        identity,
        preflight,
        prepare,
        finalizeContainer,
        runManagedContainerTransaction,
        adoptManagedContainerTransaction,
        inspectContainerContract,
        verifyContainerContract,
        agentIdentityLabelArgs,
        removeExactContainer,
        status,
        prune,
        ensureNetwork,
    };
}
