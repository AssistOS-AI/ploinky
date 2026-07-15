import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { implicitAgentServerBoxPort, planBoxPublishes } from '../../container/box-publish-planner.mjs';
import { prepareManifestRepositories } from './bootstrapManifest.js';
import { PLOINKY_DIR } from './config.js';
import { prepareDefaultBootRepositories } from './ploinkyboot.js';
import * as repos from './repos.js';
import { findAgent } from './utils.js';
import { readManifestAgentCommand, readManifestStartCommand } from './docker/agentCommands.js';
import { mergeProfiles } from './profileService.js';
import { parseRouterPort } from './routerPort.js';
import {
    assertNetworkStartupCompatibility,
    effectiveManifestNetwork,
    preflightNetworkAliases,
    validateManifestNetworks,
} from './networkContract.js';
import {
    effectiveInstanceKey,
    resolveEnabledAgentRegistryRecord,
    resolveWorkspaceDependencyGraph,
} from './workspaceDependencyGraph.js';

export const BOX_START_PUBLISH_PLAN_SCHEMA_VERSION = 2;
export const BOX_START_PUBLISH_PLAN_LOCK_PATH = path.join(PLOINKY_DIR, '.box-start-publish-plan.lock');
export const BOX_START_PUBLISH_PLAN_OPERATIONS = Object.freeze([
    'start',
    'enable',
    'cli',
    'shell',
    'restart',
    'reinstall',
    'monitor',
    'marketplace-enable',
]);

const OPERATION_SET = new Set(BOX_START_PUBLISH_PLAN_OPERATIONS);
const REQUEST_KEYS = new Set([
    'schemaVersion',
    'operation',
    'root',
    'profile',
    'alias',
    'branchPolicy',
    'includeEnabled',
    'routerPort',
    'explicitPublishes',
]);

const LOCK_OWNER_FILE = 'owner.json';
const LOCK_REAPER_SUFFIX = '.reaper';
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LOCK_RETRY_MS = 100;
const DEFAULT_LOCK_STALE_GRACE_MS = 2000;
const DEFAULT_LOCK_STALE_CHECK_MS = 1000;
const DEFAULT_LOCK_PROBE_TIMEOUT_MS = 250;
const activePlanningLocks = new Set();
let processLockHandlers = null;
let handlingTerminationSignal = false;

export async function createBoxStartPublishPlan(request, options = {}) {
    const normalized = validateBoxStartPublishPlanRequest(request);
    return withBoxStartPublishPlanLock(
        () => createBoxStartPublishPlanUnlocked(normalized, options),
        options.lockOptions,
    );
}

async function createBoxStartPublishPlanUnlocked(normalized, options) {
    const registry = options.registry || readWorkspaceRegistry();
    const configuredRoot = String(registry?._config?.static?.agent || '').trim();
    const requestedRoot = normalized.root || configuredRoot;
    if (!requestedRoot) {
        throw new Error(`planner operation '${normalized.operation}' requires an agent root or configured static agent`);
    }

    const branchPolicy = normalized.branchPolicy;
    const preparation = prepareDefaultBootRepositories({
        branchPolicy,
        staticAgent: requestedRoot,
        ...(options.bootRepos ? { bootRepos: options.bootRepos } : {}),
        log: options.log || (() => {}),
        error: options.error || (() => {}),
        stdio: options.stdio || 'ignore',
    });
    ensureQualifiedRootRepository(requestedRoot, branchPolicy, options);

    const target = resolveRequestedTarget(requestedRoot, registry, normalized);
    const canonicalRoot = `${target.repo}/${target.shortAgentName}`;
    const workspaceProfile = normalized.operation === 'start' && normalized.profile
        ? normalized.profile
        : readWorkspaceProfile();
    const savedTargetProfile = normalizeRegistryProfile(target.registryRecord?.profile);
    await prepareManifestRepositories(canonicalRoot, {
        branchPolicy,
        profile: savedTargetProfile || workspaceProfile,
        stdio: options.stdio || 'ignore',
        logError: options.error || (() => {}),
    });

    // Repository directives may have installed new manifests, so resolve again
    // before building the authoritative graph.
    const resolvedRoot = findAgent(canonicalRoot);
    const warnings = [];
    const graphOperation = normalized.operation === 'start'
        || (normalized.operation === 'restart' && !normalized.root);
    const graph = resolveWorkspaceDependencyGraph({
        staticAgentRef: `${resolvedRoot.repo}/${resolvedRoot.shortAgentName}`,
        registry,
        workspaceProfile,
        rootProfile: savedTargetProfile,
        rootAlias: normalized.alias || target.alias || '',
        onCycle: (warning) => warnings.push(warning),
    });

    let serializedNodes = graphOperation
        ? serializeGraphNodes(graph)
        : [serializeGraphNode(graph.nodes.get(graph.staticNodeId))];
    attachTargetContainerIdentity(serializedNodes, target.containerName);
    const includeEnabled = normalized.includeEnabled ?? graphOperation;
    if (includeEnabled) {
        serializedNodes = mergeEnabledNodes(serializedNodes, registry, workspaceProfile);
    }
    serializedNodes.sort(compareSerializedNodes);
    preflightNetworkAliases(serializedNodes.map((node) => ({
        id: node.id,
        agentRef: node.agentRef,
        canonicalAgentId: node.shortAgentName,
        instanceKey: node.instanceKey,
        network: node.network,
        path: `manifest(${node.agentRef})`,
    })));

    const publishPlan = planBoxPublishes({
        nodes: serializedNodes,
        explicitPublishes: normalized.explicitPublishes,
        routerPort: normalized.routerPort,
    });
    const edges = graphOperation ? serializeGraphEdges(graph) : [];

    return {
        schemaVersion: BOX_START_PUBLISH_PLAN_SCHEMA_VERSION,
        operation: normalized.operation,
        root: `${resolvedRoot.repo}/${resolvedRoot.shortAgentName}`,
        profile: graph.nodes.get(graph.staticNodeId)?.profile || workspaceProfile,
        nodes: serializedNodes,
        edges,
        claims: publishPlan.claims,
        explicitPublishes: publishPlan.explicitPublishes,
        generatedPublishes: publishPlan.generatedPublishes,
        publishes: publishPlan.publishes,
        preparation: preparation.sort((left, right) => String(left.name).localeCompare(String(right.name))),
        warnings: warnings.sort(),
    };
}

export async function withBoxStartPublishPlanLock(callback, options = {}) {
    if (typeof callback !== 'function') {
        throw new TypeError('workspace publication planner lock requires a callback');
    }
    const lock = await acquireBoxStartPublishPlanLock(options);
    try {
        return await callback();
    } finally {
        lock.release();
    }
}

export async function acquireBoxStartPublishPlanLock(options = {}) {
    const settings = normalizeLockOptions(options);
    const startedAt = Date.now();
    let nextStaleCheckAt = startedAt;
    fs.mkdirSync(path.dirname(BOX_START_PUBLISH_PLAN_LOCK_PATH), { recursive: true });

    while (true) {
        throwIfAborted(settings.signal);
        const acquired = await tryAcquirePlanningLock();
        if (acquired) return acquired;

        const now = Date.now();
        if (now >= nextStaleCheckAt) {
            const recovered = await recoverStalePlanningLock(settings);
            if (recovered) continue;
            nextStaleCheckAt = Date.now() + settings.staleCheckMs;
        }

        const elapsed = Date.now() - startedAt;
        if (elapsed >= settings.timeoutMs) {
            const owner = readLockOwner(BOX_START_PUBLISH_PLAN_LOCK_PATH);
            const detail = owner
                ? ` (owner pid ${owner.pid ?? 'unknown'} on ${owner.hostname || 'unknown host'}, acquired ${owner.acquiredAt || 'at an unknown time'})`
                : '';
            throw new Error(
                `Timed out after ${settings.timeoutMs}ms waiting for workspace publication planner lock at ${BOX_START_PUBLISH_PLAN_LOCK_PATH}${detail}`,
            );
        }
        await delay(Math.min(settings.retryMs, settings.timeoutMs - elapsed), settings.signal);
    }
}

function normalizeLockOptions(options) {
    const source = options && typeof options === 'object' ? options : {};
    return {
        timeoutMs: nonNegativeInteger(source.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 'timeoutMs'),
        retryMs: positiveInteger(source.retryMs, DEFAULT_LOCK_RETRY_MS, 'retryMs'),
        staleGraceMs: nonNegativeInteger(source.staleGraceMs, DEFAULT_LOCK_STALE_GRACE_MS, 'staleGraceMs'),
        staleCheckMs: positiveInteger(source.staleCheckMs, DEFAULT_LOCK_STALE_CHECK_MS, 'staleCheckMs'),
        probeTimeoutMs: positiveInteger(source.probeTimeoutMs, DEFAULT_LOCK_PROBE_TIMEOUT_MS, 'probeTimeoutMs'),
        signal: source.signal,
    };
}

function positiveInteger(value, fallback, field) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`workspace publication planner lock ${field} must be a positive integer`);
    }
    return value;
}

function nonNegativeInteger(value, fallback, field) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`workspace publication planner lock ${field} must be a non-negative integer`);
    }
    return value;
}

async function tryAcquirePlanningLock() {
    const reaperPath = `${BOX_START_PUBLISH_PLAN_LOCK_PATH}${LOCK_REAPER_SUFFIX}`;
    if (fs.existsSync(reaperPath)) return null;
    try {
        fs.mkdirSync(BOX_START_PUBLISH_PLAN_LOCK_PATH);
    } catch (error) {
        if (error?.code === 'EEXIST') return null;
        throw error;
    }

    const token = randomUUID();
    const owner = {
        schemaVersion: 1,
        token,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
    };
    let server;
    const socketPath = planningLockSocketPath();
    try {
        fs.writeFileSync(
            path.join(BOX_START_PUBLISH_PLAN_LOCK_PATH, LOCK_OWNER_FILE),
            JSON.stringify(owner),
            { flag: 'wx', mode: 0o600 },
        );
        server = await listenForOwnerProbes(socketPath);
        const handle = {
            path: BOX_START_PUBLISH_PLAN_LOCK_PATH,
            token,
            server,
            socketPath,
            released: false,
            release() {
                releasePlanningLock(handle);
            },
        };
        activePlanningLocks.add(handle);
        installProcessLockHandlers();
        return handle;
    } catch (error) {
        try { server?.close(); } catch (_) {}
        try { fs.unlinkSync(socketPath); } catch (_) {}
        removeOwnedLockDirectory(BOX_START_PUBLISH_PLAN_LOCK_PATH, token);
        throw error;
    }
}

function planningLockSocketPath() {
    const suffix = createHash('sha256')
        .update(BOX_START_PUBLISH_PLAN_LOCK_PATH)
        .digest('hex')
        .slice(0, 20);
    return path.join(os.tmpdir(), `ploinky-plan-${suffix}.sock`);
}

function listenForOwnerProbes(socketPath) {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => socket.end());
        const onError = (error) => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            try { fs.chmodSync(socketPath, 0o600); } catch (_) {}
            resolve(server);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(socketPath, 512);
    });
}

async function recoverStalePlanningLock(settings) {
    const reaperPath = `${BOX_START_PUBLISH_PLAN_LOCK_PATH}${LOCK_REAPER_SUFFIX}`;
    const stat = statOrNull(BOX_START_PUBLISH_PLAN_LOCK_PATH);
    if (!stat) return recoverAbandonedReaper(reaperPath, settings.staleGraceMs);
    if (Date.now() - stat.mtimeMs < settings.staleGraceMs) return false;
    const socketPath = planningLockSocketPath();
    if (await ownerSocketIsLive(socketPath, settings.probeTimeoutMs)) return false;

    if (!acquireReaper(reaperPath, settings.staleGraceMs)) return false;
    try {
        const current = statOrNull(BOX_START_PUBLISH_PLAN_LOCK_PATH);
        if (!current || Date.now() - current.mtimeMs < settings.staleGraceMs) return !current;
        if (await ownerSocketIsLive(socketPath, settings.probeTimeoutMs)) return false;
        fs.rmSync(BOX_START_PUBLISH_PLAN_LOCK_PATH, { recursive: true, force: true });
        try { fs.unlinkSync(socketPath); } catch (_) {}
        return true;
    } finally {
        fs.rmSync(reaperPath, { recursive: true, force: true });
    }
}

function acquireReaper(reaperPath, staleGraceMs) {
    try {
        createReaper(reaperPath);
        return true;
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
    }
    const stat = statOrNull(reaperPath);
    if (!stat || Date.now() - stat.mtimeMs < Math.max(staleGraceMs, 1000)) return false;
    fs.rmSync(reaperPath, { recursive: true, force: true });
    try {
        createReaper(reaperPath);
        return true;
    } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
}

function createReaper(reaperPath) {
    fs.mkdirSync(reaperPath);
    try {
        writeReaperOwner(reaperPath);
    } catch (error) {
        fs.rmSync(reaperPath, { recursive: true, force: true });
        throw error;
    }
}

function writeReaperOwner(reaperPath) {
    fs.writeFileSync(path.join(reaperPath, LOCK_OWNER_FILE), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
    }), { flag: 'wx', mode: 0o600 });
}

function recoverAbandonedReaper(reaperPath, staleGraceMs) {
    const stat = statOrNull(reaperPath);
    if (!stat || Date.now() - stat.mtimeMs < Math.max(staleGraceMs, 1000)) return !stat;
    fs.rmSync(reaperPath, { recursive: true, force: true });
    return true;
}

function ownerSocketIsLive(socketPath, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const socket = net.createConnection(socketPath);
        const finish = (live) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(live);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', (error) => {
            if (['ECONNREFUSED', 'ENOENT', 'ENOTSOCK'].includes(error?.code)) {
                finish(false);
                return;
            }
            // Permission failures and unexpected network errors are not proof
            // that the owner is dead, so fail closed instead of stealing.
            finish(true);
        });
        socket.setTimeout(timeoutMs, () => finish(true));
    });
}

function releasePlanningLock(handle) {
    if (!handle || handle.released) return;
    handle.released = true;
    try { handle.server?.close(); } catch (_) {}
    try { fs.unlinkSync(handle.socketPath); } catch (_) {}
    removeOwnedLockDirectory(handle.path, handle.token);
    activePlanningLocks.delete(handle);
    uninstallProcessLockHandlersIfIdle();
}

function removeOwnedLockDirectory(lockPath, token) {
    const owner = readLockOwner(lockPath);
    if (owner?.token !== token) return false;
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
}

function readLockOwner(lockPath) {
    try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, LOCK_OWNER_FILE), 'utf8'));
        return owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : null;
    } catch (_) {
        return null;
    }
}

function statOrNull(target) {
    try {
        return fs.statSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function installProcessLockHandlers() {
    if (processLockHandlers) return;
    const releaseAll = () => {
        for (const handle of [...activePlanningLocks]) releasePlanningLock(handle);
    };
    const terminate = (signal, code) => {
        if (handlingTerminationSignal) return;
        handlingTerminationSignal = true;
        releaseAll();
        process.exit(128 + code);
    };
    processLockHandlers = {
        exit: releaseAll,
        sigint: () => terminate('SIGINT', 2),
        sigterm: () => terminate('SIGTERM', 15),
    };
    process.on('exit', processLockHandlers.exit);
    process.on('SIGINT', processLockHandlers.sigint);
    process.on('SIGTERM', processLockHandlers.sigterm);
}

function uninstallProcessLockHandlersIfIdle() {
    if (activePlanningLocks.size || !processLockHandlers || handlingTerminationSignal) return;
    process.removeListener('exit', processLockHandlers.exit);
    process.removeListener('SIGINT', processLockHandlers.sigint);
    process.removeListener('SIGTERM', processLockHandlers.sigterm);
    processLockHandlers = null;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = signal.reason instanceof Error ? signal.reason : new Error('workspace publication planning was aborted');
    if (!error.name || error.name === 'Error') error.name = 'AbortError';
    throw error;
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        let timer;
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            try {
                throwIfAborted(signal);
            } catch (error) {
                reject(error);
            }
        };
        timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export function validateBoxStartPublishPlanRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new Error('planner request must be a JSON object');
    }
    for (const key of Object.keys(request)) {
        if (!REQUEST_KEYS.has(key)) {
            throw new Error(`unsupported planner request field '${key}'`);
        }
    }
    if (request.schemaVersion !== BOX_START_PUBLISH_PLAN_SCHEMA_VERSION) {
        throw new Error(`unsupported planner request schemaVersion '${request.schemaVersion}'`);
    }
    const operation = String(request.operation || '').trim().toLowerCase();
    if (!OPERATION_SET.has(operation)) {
        throw new Error(`unsupported planner operation '${request.operation || ''}'`);
    }
    const root = normalizeOptionalString(request.root, 'root');
    const profile = normalizeOptionalString(request.profile, 'profile').toLowerCase();
    const alias = normalizeOptionalString(request.alias, 'alias');
    if (request.includeEnabled !== undefined && typeof request.includeEnabled !== 'boolean') {
        throw new Error('planner request includeEnabled must be a boolean');
    }
    const routerPort = parseRouterPort(request.routerPort, {
        source: 'planner request routerPort',
    });
    const explicitPublishes = request.explicitPublishes === undefined ? [] : request.explicitPublishes;
    if (!Array.isArray(explicitPublishes) || explicitPublishes.some((entry) => typeof entry !== 'string')) {
        throw new Error('planner request explicitPublishes must be an array of strings');
    }
    return {
        schemaVersion: BOX_START_PUBLISH_PLAN_SCHEMA_VERSION,
        operation,
        root,
        profile,
        alias,
        branchPolicy: normalizeBranchPolicy(request.branchPolicy),
        includeEnabled: request.includeEnabled,
        routerPort,
        explicitPublishes: explicitPublishes.map((entry) => String(entry)),
    };
}

function normalizeOptionalString(value, field) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw new Error(`planner request ${field} must be a string`);
    }
    return value.trim();
}

function normalizeBranchPolicy(value) {
    const raw = value === undefined || value === null ? {} : value;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('planner request branchPolicy must be an object');
    }
    const allowed = new Set(['branch', 'repoBranches', 'fallback', 'resetRepos']);
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) throw new Error(`unsupported branchPolicy field '${key}'`);
    }
    const repoBranches = raw.repoBranches === undefined ? {} : raw.repoBranches;
    if (!repoBranches || typeof repoBranches !== 'object' || Array.isArray(repoBranches)) {
        throw new Error('planner request branchPolicy.repoBranches must be an object');
    }
    const normalizedRepos = {};
    for (const key of Object.keys(repoBranches).sort()) {
        const branch = String(repoBranches[key] || '').trim();
        if (!key.trim() || !branch) throw new Error('branchPolicy repoBranches entries require non-empty repo and branch');
        normalizedRepos[key] = branch;
    }
    const fallback = String(raw.fallback || 'default').trim().toLowerCase();
    if (!['default', 'fail'].includes(fallback)) {
        throw new Error(`invalid branchPolicy fallback '${fallback}'`);
    }
    return {
        branch: String(raw.branch || '').trim() || null,
        repoBranches: normalizedRepos,
        fallback,
        resetRepos: raw.resetRepos === true,
    };
}

function readWorkspaceRegistry() {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(PLOINKY_DIR, 'agents.json'), 'utf8') || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
        return {};
    }
}

function readWorkspaceProfile() {
    try {
        return String(fs.readFileSync(path.join(PLOINKY_DIR, 'profile'), 'utf8')).trim().toLowerCase() || 'default';
    } catch (_) {
        return 'default';
    }
}

function resolveRequestedTarget(root, registry, request) {
    const input = String(root || '').trim();
    if (usesSavedEnabledTarget(request)) {
        const enabled = resolveEnabledAgentRegistryRecord(input, registry);
        if (enabled) {
            return {
                ...findAgent(`${enabled.record.repoName}/${enabled.record.agentName}`),
                alias: String(enabled.record.alias || '').trim(),
                containerName: enabled.containerName,
                registryRecord: enabled.record,
            };
        }
    }

    const byAlias = Object.values(registry || {}).find((record) => (
        record?.type === 'agent' && record.alias === input
    ));
    if (byAlias) {
        return {
            ...findAgent(`${byAlias.repoName}/${byAlias.agentName}`),
            alias: byAlias.alias,
        };
    }
    return findAgent(input);
}

function usesSavedEnabledTarget(request) {
    if (!request || typeof request !== 'object') return false;
    if (['cli', 'shell', 'reinstall'].includes(request.operation)) return true;
    return request.operation === 'restart' && Boolean(request.root);
}

function normalizeRegistryProfile(value) {
    return String(value || '').trim().toLowerCase();
}

function ensureQualifiedRootRepository(root, branchPolicy, options) {
    const token = String(root || '').trim().split(/\s+/)[0];
    const separator = Math.max(token.indexOf('/'), token.indexOf(':'));
    if (separator < 1) return;
    const repoName = token.slice(0, separator);
    const repoPath = path.join(PLOINKY_DIR, 'repos', repoName);
    if (fs.existsSync(repoPath)) return;
    const predefined = repos.getPredefinedRepos()[repoName];
    const stored = repos.getRepoSources()[repoName];
    const source = stored || predefined;
    if (!source?.url) {
        throw new Error(`No repository source is configured for '${repoName}'.`);
    }
    repos.ensureRepoInstalled(repoName, source.url, {
        branchPolicy,
        branch: source.branch || null,
        stdio: options.stdio || 'ignore',
    });
}

function serializeGraphNodes(graph) {
    return Array.from(graph.nodes.values()).map(serializeGraphNode);
}

function serializeGraphNode(node) {
    if (!node) throw new Error('dependency graph is missing its selected root node');
    const profileConfig = effectiveProfileConfig(node.manifest, node.profile);
    const network = node.network || effectiveManifestNetwork(node.manifest, node.profile, {
        path: `manifest(${node.agentRef})`,
    });
    const instanceKey = node.instanceKey || effectiveInstanceKey(node.repoName, node.shortAgentName, node.alias);
    const implicitAgentServer = !readManifestStartCommand(node.manifest)
        || Boolean(readManifestAgentCommand(node.manifest).raw);
    return {
        id: node.id,
        instanceKey,
        agentRef: node.agentRef,
        repoName: node.repoName,
        shortAgentName: node.shortAgentName,
        alias: node.alias || '',
        profile: node.profile || 'default',
        isStatic: Boolean(node.isStatic),
        selectionPath: Array.isArray(node.selectionPath) ? [...node.selectionPath] : [node.id],
        manifestPath: node.manifestPath,
        repoCommit: readRepoCommit(node.agentPath),
        openPorts: normalizeOpenPorts(profileConfig?.openPorts),
        network,
        networkMode: network.mode,
        implicitAgentServer,
        ...(implicitAgentServer && ['default', 'bridge'].includes(network.mode)
            ? { implicitAgentServerPort: implicitAgentServerBoxPort(instanceKey) }
            : {}),
    };
}

function attachTargetContainerIdentity(nodes, containerName) {
    const normalized = String(containerName || '').trim();
    if (!normalized) return;
    const staticNode = nodes.find((node) => node.isStatic);
    if (staticNode) staticNode.containerName = normalized;
}

function mergeEnabledNodes(nodes, registry, workspaceProfile) {
    const byKey = new Map(nodes.map((node) => [node.instanceKey, node]));
    const records = Object.entries(registry || {})
        .filter(([key, record]) => key !== '_config' && record?.type === 'agent')
        .sort(([left], [right]) => left.localeCompare(right));
    for (const [containerName, record] of records) {
        const alias = String(record.alias || '').trim();
        const key = effectiveInstanceKey(record.repoName, record.agentName, alias);
        const resolved = findAgent(`${record.repoName}/${record.agentName}`);
        const manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
        validateManifestNetworks(manifest, { path: `manifest(${resolved.repo}/${resolved.shortAgentName})` });
        const selected = resolveRecordProfile(
            manifest,
            record.profile || workspaceProfile,
            `${resolved.repo}/${resolved.shortAgentName}`,
            { explicit: Boolean(record.profile) },
        );
        const existing = byKey.get(key);
        if (existing) {
            if (existing.profile !== selected) {
                throw new Error(
                    `conflicting profiles for effective instance ${key}: profile '${existing.profile}' via ${existing.selectionPath.join(' -> ')}; profile '${selected}' via enabled registry`,
                );
            }
            if (!existing.containerName) existing.containerName = containerName;
            continue;
        }
        const profileConfig = effectiveProfileConfig(manifest, selected);
        const network = effectiveManifestNetwork(manifest, selected, {
            path: `manifest(${resolved.repo}/${resolved.shortAgentName})`,
        });
        assertNetworkStartupCompatibility(manifest, profileConfig, network, {
            path: `manifest(${resolved.repo}/${resolved.shortAgentName})`,
        });
        const implicitAgentServer = !readManifestStartCommand(manifest)
            || Boolean(readManifestAgentCommand(manifest).raw);
        byKey.set(key, {
            id: alias ? `${resolved.repo}/${resolved.shortAgentName} as ${alias}` : `${resolved.repo}/${resolved.shortAgentName}`,
            instanceKey: key,
            agentRef: `${resolved.repo}/${resolved.shortAgentName}`,
            repoName: resolved.repo,
            shortAgentName: resolved.shortAgentName,
            alias,
            containerName,
            profile: selected,
            isStatic: false,
            selectionPath: ['enabled registry'],
            manifestPath: resolved.manifestPath,
            repoCommit: readRepoCommit(path.dirname(resolved.manifestPath)),
            openPorts: normalizeOpenPorts(profileConfig?.openPorts),
            network,
            networkMode: network.mode,
            implicitAgentServer,
            ...(implicitAgentServer && ['default', 'bridge'].includes(network.mode)
                ? { implicitAgentServerPort: implicitAgentServerBoxPort(key) }
                : {}),
        });
    }
    return Array.from(byKey.values());
}

function resolveRecordProfile(manifest, requested, ref, { explicit = false } = {}) {
    const profile = String(requested || 'default').trim().toLowerCase() || 'default';
    const profiles = manifest?.profiles && typeof manifest.profiles === 'object' ? manifest.profiles : {};
    if (Object.prototype.hasOwnProperty.call(profiles, profile)) return profile;
    if (!explicit && profile !== 'default' && Object.prototype.hasOwnProperty.call(profiles, 'default')) return 'default';
    if (!Object.keys(profiles).length) return 'default';
    throw new Error(`profile '${profile}' is not defined by ${ref}; available profiles: ${Object.keys(profiles).sort().join(', ')}`);
}

function effectiveProfileConfig(manifest, profile) {
    const profiles = manifest?.profiles && typeof manifest.profiles === 'object' ? manifest.profiles : {};
    const defaultProfile = profiles.default || {};
    if (profile === 'default') return defaultProfile;
    return mergeProfiles(defaultProfile, profiles[profile] || {});
}

function normalizeOpenPorts(value) {
    if (value === undefined || value === null) return [];
    return (Array.isArray(value) ? value : [value]).map((entry) => String(entry).trim());
}

function readRepoCommit(agentPath) {
    try {
        return String(execFileSync('git', ['-C', path.dirname(agentPath), 'rev-parse', 'HEAD'], {
            stdio: ['ignore', 'pipe', 'ignore'],
        })).trim();
    } catch (_) {
        return null;
    }
}

function serializeGraphEdges(graph) {
    const edges = [];
    for (const node of graph.nodes.values()) {
        for (const dependencyId of node.dependencies) {
            edges.push({
                from: node.id,
                to: dependencyId,
                noWait: Boolean(node.dependencyEdges?.get(dependencyId)?.noWait),
            });
        }
    }
    return edges.sort((left, right) => (
        left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
    ));
}

function compareSerializedNodes(left, right) {
    return left.instanceKey.localeCompare(right.instanceKey) || left.profile.localeCompare(right.profile);
}
