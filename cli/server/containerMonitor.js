import fs from 'fs';
import crypto from 'node:crypto';
import path from 'path';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';

import * as workspaceSvc from '../utils/workspace.js';
import { REPOS_DIR, RUNNING_DIR } from '../utils/config.js';
import { mergeRoutingConfig, mergeRuntimeRoute, readRoutingConfig } from './routingFile.js';
import {
    createWorkspaceMutationLease,
    inspectMaintenanceLock,
    inspectWorkspaceStartLock,
    releaseWorkspaceMutationLease,
} from '../utils/runtime/maintenanceLocks.js';
import {
    cleanupExactAgentRuntimeCandidate,
    ensureAgentService,
    listRunningContainerNames,
} from '../sandbox/docker/index.js';
import { shouldMonitorManifestRuntime } from '../utils/runtime/manifestStartup.js';
import { getRuntimeForAgent, isSandboxRuntime } from '../sandbox/docker/common.js';
import { resolveLlmRuntimeAdmissionContext } from '../sandbox/docker/llmRuntimeIntegration.js';
import { isBwrapProcessRunning } from '../sandbox/bwrap/bwrapFleet.js';
import { resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import {
    admitManifestRuntimeCapabilities,
    assertRuntimeAdmissionCurrent,
    RUNTIME_CAPABILITY_POLICY_VERSION,
} from '../sandbox/runtimeCapabilities.js';
import { resolveRouterEndpoint } from '../sandbox/routerPort.js';
import { resolveAgentReadinessProtocol } from '../utils/runtime/startupReadiness.js';
import { runContainerScriptReadiness } from '../sandbox/docker/healthProbes.js';
import {
    buildRelayReadinessRoute,
    waitForAgentReady,
} from './utils/agentReadiness.js';
import { applyEdgeRoutingGeneration } from '../sandbox/coordinatedEdgeApply.js';
import { withNetworkLifecycleLock } from '../sandbox/networkLifecycle.js';
import {
    abortEdgeRoutingPreparation,
    inactivateEdgeRoutingGeneration,
    withEdgeGenerationApplyLock,
} from '../sandbox/edgeGeneration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROBE_WORKER_URL = new URL('./probeWorker.js', import.meta.url);
const LOGGED_RESTART_FAILURES = new WeakSet();
const TERMINAL_POLICY_CODES = new Set([
    'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED',
    'PLOINKY_MANIFEST_SECURITY_INVALID',
    'PLOINKY_MANIFEST_SECURITY_PROFILE_UNSUPPORTED',
    'PLOINKY_BOX_MARKER_INVALID',
    'PLOINKY_BWRAP_CAPABILITY_UNAVAILABLE',
    'PLOINKY_OPEN_INTERPRETER_BOX_UNAVAILABLE',
]);
const TERMINAL_LEDGER_SCHEMA_VERSION = 1;
// Terminal blockers survive monitor restarts while their registry entry is
// present. Once the entry disappears, retain the tombstone only long enough
// to suppress a short remove/re-add race; it must not grow without bound.
const DEFAULT_TERMINAL_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function noopLog() {}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function digestValue(value) {
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function terminalLedgerFile(monitor) {
    return monitor?.terminalLedgerFile || path.join(RUNNING_DIR, 'container-monitor-terminal.json');
}

function loadTerminalLedger(monitor) {
    try {
        const parsed = JSON.parse(fs.readFileSync(terminalLedgerFile(monitor), 'utf8'));
        if (parsed?.schemaVersion !== TERMINAL_LEDGER_SCHEMA_VERSION || !parsed.entries
            || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return new Map();
        return new Map(Object.entries(parsed.entries));
    } catch (_) {
        return new Map();
    }
}

function persistTerminalLedger(monitor) {
    const file = terminalLedgerFile(monitor);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const document = {
        schemaVersion: TERMINAL_LEDGER_SCHEMA_VERSION,
        entries: Object.fromEntries(Array.from(monitor.terminalLedger || new Map()).sort(([a], [b]) => a.localeCompare(b))),
    };
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(document, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

function terminalTombstoneRetentionMs(monitor) {
    const configured = Number(monitor?.config?.TERMINAL_TOMBSTONE_RETENTION_MS);
    return Number.isSafeInteger(configured) && configured >= 0
        ? configured
        : DEFAULT_TERMINAL_TOMBSTONE_RETENTION_MS;
}

function pruneTerminalLedger(monitor, presentRegistryNames, now = Date.now()) {
    monitor.terminalLedger ||= loadTerminalLedger(monitor);
    const retentionMs = terminalTombstoneRetentionMs(monitor);
    let changed = false;
    for (const [containerName, entry] of monitor.terminalLedger.entries()) {
        if (presentRegistryNames.has(containerName)) {
            if (entry?.absentSince || entry?.expiresAt) {
                monitor.terminalLedger.set(containerName, Object.freeze({
                    ...entry,
                    absentSince: null,
                    expiresAt: null,
                }));
                changed = true;
            }
            continue;
        }
        const absentSinceMs = Date.parse(String(entry?.absentSince || ''));
        const effectiveAbsentSince = Number.isFinite(absentSinceMs)
            ? absentSinceMs
            : now;
        const expiresAtMs = Number.isFinite(Date.parse(String(entry?.expiresAt || '')))
            ? Date.parse(String(entry.expiresAt))
            : effectiveAbsentSince + retentionMs;
        if (expiresAtMs <= now) {
            monitor.terminalLedger.delete(containerName);
            changed = true;
            continue;
        }
        if (!entry?.absentSince || !entry?.expiresAt) {
            monitor.terminalLedger.set(containerName, Object.freeze({
                ...entry,
                absentSince: new Date(effectiveAbsentSince).toISOString(),
                expiresAt: new Date(expiresAtMs).toISOString(),
            }));
            changed = true;
        }
    }
    if (changed) persistTerminalLedger(monitor);
}

function classifyTerminalFailure(error) {
    const code = String(error?.code || '');
    if (TERMINAL_POLICY_CODES.has(code)) return 'policy';
    if (code === 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS') return 'identity';
    return '';
}

function recordTerminalFailure(monitor, info, error, restartInputDigest) {
    monitor.terminalLedger ||= loadTerminalLedger(monitor);
    const code = String(error?.code || 'PLOINKY_WATCHDOG_TERMINAL');
    const blockerFingerprint = digestValue({
        code,
        cause: String(error?.cause?.code || ''),
        identity: {
            containerName: info.containerName,
            repoName: info.repoName,
            agentName: info.agentName,
            instanceId: info.instanceId,
            enableGeneration: info.enableGeneration,
        },
    });
    const entry = Object.freeze({
        containerName: info.containerName,
        repoName: info.repoName,
        agentName: info.agentName,
        restartInputDigest,
        blockerFingerprint,
        code,
        classification: classifyTerminalFailure(error) || 'policy',
        recordedAt: new Date().toISOString(),
        absentSince: null,
        expiresAt: null,
    });
    monitor.terminalLedger.set(info.containerName, entry);
    persistTerminalLedger(monitor);
    return entry;
}

function logEvent(monitor, level, event, data = {}) {
    const logger = typeof monitor?.log === 'function' ? monitor.log : noopLog;
    logger(level, event, data);
}

function cleanRestartHistory(monitor, target) {
    if (!target) return;
    const windowMs = monitor?.config?.RESTART_WINDOW_MS ?? 60000;
    const now = Date.now();
    target.restartHistory = (target.restartHistory || []).filter((ts) => (now - ts) < windowMs);
}

function calculateBackoff(monitor, target) {
    if (!target) return monitor?.config?.INITIAL_BACKOFF_MS ?? 1000;
    const initial = monitor?.config?.INITIAL_BACKOFF_MS ?? 1000;
    const maxBackoff = monitor?.config?.MAX_BACKOFF_MS ?? 30000;
    const multiplier = monitor?.config?.BACKOFF_MULTIPLIER ?? 2;
    if (typeof target.currentBackoff !== 'number' || Number.isNaN(target.currentBackoff) || target.currentBackoff <= 0) {
        target.currentBackoff = initial;
    }
    const backoff = Math.min(target.currentBackoff, maxBackoff);
    target.currentBackoff = Math.min(target.currentBackoff * multiplier, maxBackoff);
    return backoff;
}

function createContainerTarget(info, monitor) {
    const initial = monitor?.config?.INITIAL_BACKOFF_MS ?? 1000;
    return {
        containerName: info.containerName,
        agentName: info.agentName,
        repoName: info.repoName,
        alias: info.alias || null,
        profile: info.profile || null,
        instanceId: info.instanceId || null,
        enableGeneration: info.enableGeneration || null,
        type: info.type,
        manifestPath: info.manifestPath,
        restartHistory: [],
        totalRestarts: 0,
        currentBackoff: initial,
        isRestarting: false,
        pendingRestartTimer: null,
        lastStartTime: null,
        lastSeenRunningAt: null,
        circuitBreakerTripped: false,
        lastError: null,
        probeState: 'pending',
        probeWorker: null,
        probeLastSuccessAt: null,
        attemptEpoch: 0,
        restartInputDigest: info.restartInputDigest,
        runtimeAdmission: info.runtimeAdmission,
        restartSnapshot: info.restartSnapshot,
        terminalState: null,
    };
}

function resolveWatchdogRestartInput(record, info, monitor) {
    const manifestBytes = fs.readFileSync(info.manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8') || '{}');
    const routeKey = info.alias || info.agentName;
    if (!shouldMonitorManifestRuntime(manifest, {
        hasRoute: Boolean(info.routing?.routes?.[routeKey]),
    })) return null;
    const resolveRuntimeProfile = monitor.resolveManifestRuntimeProfile || resolveManifestRuntimeProfile;
    const profileResolution = resolveRuntimeProfile(manifest, {
        agentName: `${info.repoName}/${info.agentName}`,
        profileName: info.profile || undefined,
        path: `manifest(${info.repoName}/${info.agentName})`,
    });
    const runtimeKind = info.runtime === 'bwrap' || info.runtime === 'seatbelt'
        ? info.runtime
        : 'container';
    const selectedRuntime = runtimeKind === 'container'
        ? getRuntimeForAgent(manifest)
        : info.runtime;
    const llmAdmissionContext = runtimeKind === 'container'
        ? resolveLlmRuntimeAdmissionContext({
            runtime: selectedRuntime,
            manifest,
            profileConfig: profileResolution.profileConfig,
            agentName: info.agentName,
            alias: info.alias,
            env: process.env,
        })
        : { catalogPolicy: null, catalogIdentity: null };
    const runtimeAdmission = admitManifestRuntimeCapabilities(manifest, {
        manifestBytes,
        manifestPath: info.manifestPath,
        agentId: `${info.repoName}/${info.agentName}`,
        profileName: profileResolution.resolvedProfileName,
        profileConfig: profileResolution.profileConfig,
        network: profileResolution.network,
        runtime: selectedRuntime,
        runtimeKind,
        catalogPolicy: llmAdmissionContext.catalogPolicy,
        catalogIdentity: llmAdmissionContext.catalogIdentity,
    });
    const stat = fs.statSync(info.manifestPath, { bigint: true });
    const restartInputDigest = digestValue({
        registryRecordDigest: digestValue(record),
        manifestDigest: runtimeAdmission.manifestDigest,
        manifestPath: path.resolve(info.manifestPath),
        manifestIdentity: `${stat.dev}:${stat.ino}`,
        profileName: profileResolution.resolvedProfileName,
        profileConfig: profileResolution.profileConfig,
        capabilityDescriptor: runtimeAdmission.descriptor,
        capabilityPolicyVersion: RUNTIME_CAPABILITY_POLICY_VERSION,
        runtimeKind,
        runtime: info.runtime,
        imageDigest: String(record.imageDigest || record.containerImageDigest || record.containerImage || ''),
        runnerAbi: String(record.runnerAbi || ''),
        network: profileResolution.network,
        instanceId: info.instanceId,
        enableGeneration: info.enableGeneration,
        alias: info.alias,
        containerName: info.containerName,
        retainedNodeIdentity: String(record.retainedNodeIdentity || ''),
    });
    const restartSnapshot = deepFreezeSnapshot({
        digest: restartInputDigest,
        manifestBytesBase64: manifestBytes.toString('base64'),
        manifestPath: info.manifestPath,
        profileResolution,
        runtimeAdmission,
        registryRecord: structuredClone(record),
        registryRecordDigest: digestValue(record),
        info: {
            containerName: info.containerName,
            agentName: info.agentName,
            repoName: info.repoName,
            alias: info.alias || null,
            profile: info.profile || null,
            runtime: info.runtime,
            instanceId: info.instanceId || null,
            enableGeneration: info.enableGeneration || null,
            manifestPath: info.manifestPath,
        },
    });
    return { manifest, profileResolution, runtimeAdmission, restartInputDigest, restartSnapshot };
}

function deepFreezeSnapshot(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreezeSnapshot(child);
    return Object.freeze(value);
}

function stopProbeWorker(target) {
    if (!target) return;
    if (target.probeWorker) {
        const worker = target.probeWorker;
        try {
            worker.postMessage({ type: 'terminate' });
        } catch (_) {}
        try {
            const termination = worker.terminate();
            if (termination && typeof termination.catch === 'function') {
                termination.catch(() => {});
            }
        } catch (_) {}
    }
    target.probeWorker = null;
    if (target.probeState !== 'success') {
        target.probeState = 'pending';
    }
}

function handleProbeFailure(monitor, target, message, { runtimeHealth = false } = {}) {
    if (!monitor || !target) return;
    target.probeState = 'failed';
    target.lastError = message;
    target.probeFailures = (target.probeFailures || 0) + 1;
    logEvent(monitor, 'error', 'container_probe_failed', {
        container: target.containerName,
        agent: target.agentName,
        repo: target.repoName,
        error: message,
        failures: target.probeFailures
    });
    if (runtimeHealth) {
        const inactivate = monitor.inactivateEdgeRoutingGeneration || inactivateEdgeRoutingGeneration;
        try {
            inactivate(`continuous-runtime-probe-failed:${target.containerName}`);
        } catch (error) {
            logEvent(monitor, 'error', 'container_probe_inactivation_failed', {
                container: target.containerName,
                agent: target.agentName,
                repo: target.repoName,
                error: error?.message || error,
            });
        }
        scheduleContainerRestart(monitor, target, 'semantic_probe_failed');
    }
}

export function startProbeWorker(monitor, target) {
    if (!monitor || !target) return;
    if (target.circuitBreakerTripped) return;
    if (target.probeWorker || target.probeState === 'success') return;

    let manifest;
    try {
        const manifestContent = fs.readFileSync(target.manifestPath, 'utf8');
        manifest = JSON.parse(manifestContent || '{}');
    } catch (error) {
        handleProbeFailure(monitor, target, error?.message || error);
        return;
    }

    if (!manifest || typeof manifest !== 'object' || !manifest.health) {
        target.probeState = 'success';
        return;
    }

    try {
        const WorkerClass = monitor.Worker || Worker;
        target.probeWorker = new WorkerClass(PROBE_WORKER_URL, {
            workerData: {
                agentName: target.agentName,
                containerName: target.containerName,
                manifest: { health: manifest.health }
            },
            stdout: true,
            stderr: true
        });
    } catch (error) {
        handleProbeFailure(monitor, target, error?.message || error);
        return;
    }

    target.probeState = 'running';
    logEvent(monitor, 'info', 'container_probe_started', {
        container: target.containerName,
        agent: target.agentName,
        repo: target.repoName
    });

    const worker = target.probeWorker;

    worker.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'log' && msg.message) {
            const level = msg.level || 'info';
            if (level === 'warn') {
                console.warn(msg.message);
            } else if (level === 'error') {
                console.error(msg.message);
            } else {
                console.log(msg.message);
            }
            return;
        }
        if (msg.status === 'success') {
            target.probeState = 'success';
            target.probeLastSuccessAt = Date.now();
            logEvent(monitor, 'info', 'container_probe_succeeded', {
                container: target.containerName,
                agent: target.agentName,
                repo: target.repoName
            });
            stopProbeWorker(target);
        } else if (msg.status === 'error') {
            stopProbeWorker(target);
            const message = msg.error || 'Probe worker reported failure.';
            handleProbeFailure(monitor, target, message, { runtimeHealth: true });
        }
    });

    worker.on('error', (error) => {
        stopProbeWorker(target);
        handleProbeFailure(monitor, target, error?.message || error, { runtimeHealth: true });
    });

    worker.on('exit', (code) => {
        if (target.probeWorker === worker) {
            target.probeWorker = null;
        }
        if (code !== 0 && target.probeState === 'running') {
            handleProbeFailure(monitor, target, `Probe worker exited with code ${code}`, { runtimeHealth: true });
        }
    });
}

const UNREADABLE_NO_WAIT_STATUS = Object.freeze({ state: 'unreadable' });

// Must be an actual JSON number. Number() would coerce null, '' and false to
// zero, so a malformed wave-zero marker would compare equal to a wave-zero
// status and reopen probing instead of failing closed.
const MAX_NO_WAIT_MARKER_WAVE_INDEX = 1023;

function exactNoWaitMarkerInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
    return typeof value === 'number' && Number.isSafeInteger(value)
        && value >= minimum && value <= maximum
        ? value
        : null;
}

export function readNoWaitStatus(containerName, { runningDir = RUNNING_DIR } = {}) {
    if (!containerName) return null;
    if (path.basename(containerName) !== containerName) return UNREADABLE_NO_WAIT_STATUS;
    const markerPath = path.join(runningDir, 'no-wait', `${containerName}.current.json`);
    const statusPath = path.join(runningDir, 'no-wait', `${containerName}.json`);
    let currentRun = null;
    try {
        const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        const runStartedAtMs = exactNoWaitMarkerInteger(parsed?.runStartedAtMs);
        const waveIndex = exactNoWaitMarkerInteger(parsed?.waveIndex, {
            maximum: MAX_NO_WAIT_MARKER_WAVE_INDEX,
        });
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                .test(String(parsed.runId || ''))
            || String(parsed.statusFile || '') !== `${containerName}.${parsed.runId}.json`
            || runStartedAtMs === null || waveIndex === null) {
            return UNREADABLE_NO_WAIT_STATUS;
        }
        currentRun = { runId: String(parsed.runId), runStartedAtMs, waveIndex };
    } catch (error) {
        if (error?.code !== 'ENOENT') return UNREADABLE_NO_WAIT_STATUS;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return UNREADABLE_NO_WAIT_STATUS;
        }
        // The marker binds the canonical status to one exact run identity,
        // run start, and wave. Carrying the fields without cross-checking all
        // three would let a late writer from an earlier run or wave reopen
        // monitor probing.
        if (currentRun && (String(parsed.runId || '') !== currentRun.runId
            || exactNoWaitMarkerInteger(parsed.runStartedAtMs) !== currentRun.runStartedAtMs
            || exactNoWaitMarkerInteger(parsed.waveIndex, {
                maximum: MAX_NO_WAIT_MARKER_WAVE_INDEX,
            }) !== currentRun.waveIndex)) {
            return UNREADABLE_NO_WAIT_STATUS;
        }
        const state = String(parsed.state || '').trim().toLowerCase();
        return ['starting', 'running', 'failed'].includes(state)
            ? parsed
            : UNREADABLE_NO_WAIT_STATUS;
    } catch (error) {
        return error?.code === 'ENOENT' && !currentRun
            ? null
            : UNREADABLE_NO_WAIT_STATUS;
    }
}

function shouldDeferNoWaitRestart(monitor, target) {
    const readStatus = monitor?.readNoWaitStatus || readNoWaitStatus;
    let status;
    try {
        status = readStatus(target?.containerName || '');
    } catch (_) {
        status = UNREADABLE_NO_WAIT_STATUS;
    }
    const observedState = String(status?.state || '').trim().toLowerCase();
    const state = ['starting', 'failed'].includes(observedState)
        ? observedState
        : (status && observedState !== 'running' ? 'unreadable' : observedState);
    if (!['starting', 'failed', 'unreadable'].includes(state)) {
        target.noWaitDeferredState = null;
        return false;
    }
    if (target.noWaitDeferredState !== state) {
        target.noWaitDeferredState = state;
        logEvent(monitor, 'info', 'container_no_wait_restart_deferred', {
            container: target.containerName,
            agent: target.agentName,
            repo: target.repoName,
            state,
            statusFile: path.join(RUNNING_DIR, 'no-wait', `${target.containerName}.json`)
        });
    }
    return true;
}

function shouldDeferMaintenanceRestart(monitor, target) {
    const result = inspectMaintenanceLock(target?.containerName || '');
    if (result.stale) {
        logEvent(monitor, 'info', 'container_maintenance_lock_removed', {
            container: target.containerName,
            agent: target.agentName,
            repo: target.repoName,
            operation: result.lock?.operation || null,
            ownerPid: result.lock?.ownerPid || null,
            expiresAt: result.lock?.expiresAt || null
        });
    }
    if (!result.active) {
        target.maintenanceDeferred = false;
        return false;
    }
    if (!target.maintenanceDeferred) {
        target.maintenanceDeferred = true;
        logEvent(monitor, 'info', 'container_restart_deferred_maintenance', {
            container: target.containerName,
            agent: target.agentName,
            repo: target.repoName,
            operation: result.lock?.operation || null,
            ownerPid: result.lock?.ownerPid || null,
            expiresAt: result.lock?.expiresAt || null
        });
    }
    return true;
}

export function syncManagedContainers(monitor) {
    const monitorRef = monitor;
    if (!monitorRef) return;

    let agentsMap = {};
    try {
        const loadAgents = monitorRef.loadAgents || workspaceSvc.loadAgents;
        agentsMap = loadAgents() || {};
    } catch (error) {
        logEvent(monitorRef, 'error', 'container_sync_failed', { error: error?.message || error });
        return;
    }

    const presentRegistryNames = new Set(Object.keys(agentsMap).filter((name) => (
        name !== '_config' && !name.startsWith('_')
    )));
    pruneTerminalLedger(monitorRef, presentRegistryNames);

    const desired = new Map();
    const readRouting = monitorRef.readRoutingConfig || readRoutingConfig;
    const routing = readRouting();

    for (const [containerName, record] of Object.entries(agentsMap)) {
        if (!record || typeof record !== 'object') continue;
        if (containerName === '_config' || containerName.startsWith('_')) continue;

        const type = record.type || 'agent';
        if (type !== 'agent') continue;

        const agentName = record.agentName || record.shortAgentName || null;
        const repoName = record.repoName || record.repo || null;
        const alias = record.alias || null;
        if (!agentName || !repoName) continue;

        const manifestPath = path.join(REPOS_DIR, repoName, agentName, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            logEvent(monitorRef, 'warn', 'container_manifest_missing', {
                container: containerName,
                agent: agentName,
                repo: repoName,
                manifest: manifestPath
            });
            continue;
        }

        let restartInput;
        try {
            restartInput = resolveWatchdogRestartInput(record, {
                containerName,
                agentName,
                repoName,
                alias,
                profile: record.profile || null,
                runtime: record.runtime || 'container',
                instanceId: String(record.instanceId || '').trim() || null,
                enableGeneration: String(record.enableGeneration || '').trim() || null,
                manifestPath,
                routing,
            }, monitorRef);
            if (!restartInput) continue;
        } catch (error) {
            const terminal = classifyTerminalFailure(error);
            const fallbackDigest = digestValue({
                containerName,
                repoName,
                agentName,
                manifestPath,
                code: String(error?.code || 'manifest-invalid'),
                manifestDigest: (() => {
                    try { return digestValue(fs.readFileSync(manifestPath).toString('base64')); } catch (_) { return ''; }
                })(),
                profile: record.profile || null,
                runtime: record.runtime || 'container',
                instanceId: String(record.instanceId || ''),
                enableGeneration: String(record.enableGeneration || ''),
            });
            if (terminal) {
                const info = {
                    containerName,
                    agentName,
                    repoName,
                    instanceId: String(record.instanceId || '').trim() || null,
                    enableGeneration: String(record.enableGeneration || '').trim() || null,
                };
                const existing = monitorRef.terminalLedger?.get(containerName);
                if (existing?.restartInputDigest !== fallbackDigest) {
                    recordTerminalFailure(monitorRef, info, error, fallbackDigest);
                }
                const target = monitorRef.targets.get(containerName);
                if (target?.pendingRestartTimer) clearTimeout(target.pendingRestartTimer);
                if (target) stopProbeWorker(target);
                monitorRef.targets.delete(containerName);
            }
            logEvent(monitorRef, terminal ? 'warn' : 'error', terminal
                ? 'container_runtime_policy_terminal'
                : 'container_manifest_invalid', {
                container: containerName,
                agent: agentName,
                repo: repoName,
                manifest: manifestPath,
                error: error?.message || String(error),
                code: error?.code || null,
                restartInputDigest: fallbackDigest,
            });
            continue;
        }

        const runtime = record.runtime || 'container';
        const profile = record.profile || null;
        const instanceId = String(record.instanceId || '').trim() || null;
        const enableGeneration = String(record.enableGeneration || '').trim() || null;
        const info = {
            containerName,
            type,
            agentName,
            repoName,
            alias,
            profile,
            manifestPath,
            runtime,
            instanceId,
            enableGeneration,
            restartInputDigest: restartInput.restartInputDigest,
            runtimeAdmission: restartInput.runtimeAdmission,
            restartSnapshot: restartInput.restartSnapshot,
        };
        monitorRef.terminalLedger ||= loadTerminalLedger(monitorRef);
        const terminal = monitorRef.terminalLedger.get(containerName);
        if (terminal?.restartInputDigest === restartInput.restartInputDigest) {
            continue;
        }
        if (terminal) {
            monitorRef.terminalLedger.delete(containerName);
            persistTerminalLedger(monitorRef);
        }
        desired.set(containerName, info);

        let target = monitorRef.targets.get(containerName);
        if (!target) {
            target = createContainerTarget(info, monitorRef);
            target.runtime = runtime;
            monitorRef.targets.set(containerName, target);
            logEvent(monitorRef, 'info', 'container_watch_added', {
                container: containerName,
                agent: agentName,
                repo: repoName,
                runtime
            });
        } else {
            // The active attempt owns its immutable snapshot and verifies the
            // live manifest/registry at every lifecycle checkpoint. A normal
            // monitor sync may observe the attempt's intentionally staged
            // successor tuple, but must not adopt it, clear isRestarting, or
            // start a second probe/restart underneath readiness. External
            // drift remains visible in the live files and the active attempt
            // rejects it before publication; the next tick adopts state only
            // after that attempt has finished or failed stale.
            if (target.isRestarting) continue;
            if (target.restartInputDigest !== restartInput.restartInputDigest) {
                target.attemptEpoch += 1;
                if (target.pendingRestartTimer) clearTimeout(target.pendingRestartTimer);
                target.pendingRestartTimer = null;
                target.isRestarting = false;
                target.restartHistory = [];
                target.circuitBreakerTripped = false;
                target.currentBackoff = monitorRef?.config?.INITIAL_BACKOFF_MS ?? 1000;
            }
            target.agentName = agentName;
            target.repoName = repoName;
            target.alias = alias;
            target.profile = profile;
            target.instanceId = instanceId;
            target.enableGeneration = enableGeneration;
            target.type = type;
            target.manifestPath = manifestPath;
            target.runtime = runtime;
            target.restartInputDigest = restartInput.restartInputDigest;
            target.runtimeAdmission = restartInput.runtimeAdmission;
            target.restartSnapshot = restartInput.restartSnapshot;
        }
    }

    for (const [containerName, target] of Array.from(monitorRef.targets.entries())) {
        if (!desired.has(containerName)) {
            if (target?.pendingRestartTimer) {
                clearTimeout(target.pendingRestartTimer);
            }
            stopProbeWorker(target);
            target.attemptEpoch += 1;
            monitorRef.targets.delete(containerName);
            logEvent(monitorRef, 'info', 'container_watch_removed', { container: containerName });
        }
    }
}

function scheduleContainerRestart(monitor, target, reason) {
    if (!monitor || !target) return;
    if (monitor.isShuttingDown()) return;
    if (target.circuitBreakerTripped || target.isRestarting || target.pendingRestartTimer) return;

    cleanRestartHistory(monitor, target);
    const maxRestarts = monitor?.config?.MAX_RESTARTS_IN_WINDOW ?? 5;
    if (target.restartHistory.length >= maxRestarts) {
        target.circuitBreakerTripped = true;
        logEvent(monitor, 'fatal', 'container_circuit_breaker_tripped', {
            container: target.containerName,
            agent: target.agentName,
            repo: target.repoName,
            restarts: target.restartHistory.length,
            windowMs: monitor?.config?.RESTART_WINDOW_MS ?? 60000
        });
        return;
    }

    const now = Date.now();
    target.restartHistory.push(now);
    target.totalRestarts = (target.totalRestarts || 0) + 1;

    const backoff = calculateBackoff(monitor, target);

    logEvent(monitor, 'warn', 'container_scheduling_restart', {
        container: target.containerName,
        agent: target.agentName,
        repo: target.repoName,
        reason,
        backoffMs: backoff,
        attemptsInWindow: target.restartHistory.length
    });

    target.isRestarting = true;
    const attempt = target.restartInputDigest && target.restartSnapshot
        ? Object.freeze({
            target,
            epoch: (target.attemptEpoch || 0) + 1,
            digest: target.restartInputDigest,
            snapshot: target.restartSnapshot,
        })
        : null;
    if (attempt) target.attemptEpoch = attempt.epoch;
    target.pendingRestartTimer = setTimeout(() => {
        target.pendingRestartTimer = null;
        performContainerRestart(monitor, target, reason, attempt).catch((error) => {
            target.lastError = error?.message || error;
            if (!error || typeof error !== 'object' || !LOGGED_RESTART_FAILURES.has(error)) {
                logEvent(monitor, 'error', 'container_restart_failed', {
                    container: target.containerName,
                    agent: target.agentName,
                    repo: target.repoName,
                    reason,
                    error: target.lastError
                });
            }
            target.isRestarting = false;
            if (error?.code === 'PLOINKY_RESTART_ATTEMPT_STALE') return;
            if (classifyTerminalFailure(error)) {
                target.terminalState = recordTerminalFailure(
                    monitor,
                    target,
                    error,
                    attempt?.digest || target.restartInputDigest || '',
                );
                target.circuitBreakerTripped = true;
                return;
            }
            scheduleContainerRestart(monitor, target, 'restart_failed');
        });
    }, backoff);
}

function assertRestartAttemptCurrent(monitor, target, attempt, checkpoint, {
    expectedRegistryRecord = null,
} = {}) {
    if (!attempt) return;
    let currentBytes;
    try {
        currentBytes = fs.readFileSync(attempt.snapshot.manifestPath);
    } catch (_) {}
    let recomputedDigest = '';
    try {
        const readRouting = monitor.readRoutingConfig || readRoutingConfig;
        const recomputed = resolveWatchdogRestartInput(
            attempt.snapshot.registryRecord,
            { ...attempt.snapshot.info, routing: readRouting() },
            monitor,
        );
        recomputedDigest = recomputed?.restartInputDigest || '';
    } catch (_) {}
    let registryRecordMatches = true;
    try {
        const loadAgents = monitor.loadAgents || workspaceSvc.loadAgents;
        const currentRecord = loadAgents()?.[attempt.snapshot.info.containerName];
        const expectedDigest = digestValue(expectedRegistryRecord || attempt.snapshot.registryRecord);
        registryRecordMatches = Boolean(currentRecord) && digestValue(currentRecord) === expectedDigest;
    } catch (_) {
        registryRecordMatches = false;
    }
    if (attempt.target !== target
        || monitor.targets.get(target.containerName) !== target
        || target.attemptEpoch !== attempt.epoch
        || target.restartInputDigest !== attempt.digest
        || attempt.snapshot?.digest !== attempt.digest
        || currentBytes?.toString('base64') !== attempt.snapshot.manifestBytesBase64
        || recomputedDigest !== attempt.digest
        || !registryRecordMatches) {
        const error = new Error(`watchdog restart attempt became stale at ${checkpoint}`);
        error.code = 'PLOINKY_RESTART_ATTEMPT_STALE';
        throw error;
    }
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertRestartPreparationResult(target, result) {
    const containerName = String(result?.containerName || '').trim();
    const record = result?.registryRecord;
    if (!containerName || containerName !== String(target.containerName || '')
        || !record || typeof record !== 'object' || Array.isArray(record)
        || record.type !== 'agent'
        || String(record.repoName || '') !== String(target.repoName || '')
        || String(record.agentName || '') !== String(target.agentName || '')
        || String(record.alias || '') !== String(target.alias || '')
        || !String(record.instanceId || '')
        || !String(record.enableGeneration || '')) {
        throw new Error(`watchdog runtime ensure returned a mismatched exact registry identity for '${containerName || target.containerName}'`);
    }
    if (result?.requiresEdgeActivation !== true) return null;
    const stagedRecord = result?.stagedRegistryRecord;
    if (!stagedRecord || typeof stagedRecord !== 'object' || Array.isArray(stagedRecord)
        || stagedRecord.type !== 'agent'
        || String(stagedRecord.repoName || '') !== String(record.repoName || '')
        || String(stagedRecord.agentName || '') !== String(record.agentName || '')
        || String(stagedRecord.alias || '') !== String(record.alias || '')
        || String(stagedRecord.instanceId || '') !== String(record.instanceId || '')
        || String(stagedRecord.enableGeneration || '') !== String(record.enableGeneration || '')) {
        throw new Error(`watchdog runtime replacement requires its exact staged registry record for '${containerName}'`);
    }
    if (!result.preparationLease) {
        throw new Error('watchdog runtime replacement requires its exact preparation lease');
    }
    return { containerName, record, stagedRecord };
}

function preActivationRegistryRecord(result) {
    return result?.requiresEdgeActivation === true
        ? result?.stagedRegistryRecord || null
        : result?.registryRecord || null;
}

async function waitForRestartedContainerReadiness(
    monitor,
    target,
    manifest,
    result,
    networkMode = '',
) {
    const resolveProtocol = monitor.resolveAgentReadinessProtocol || resolveAgentReadinessProtocol;
    const protocol = resolveProtocol(manifest);
    if (protocol === 'none') return;
    if (protocol === 'script') {
        const runScript = monitor.runContainerScriptReadiness || runContainerScriptReadiness;
        const probe = await Promise.resolve(runScript(
            target.agentName,
            result.containerName,
            manifest?.health?.readiness,
        ));
        if (probe?.status !== 'success') {
            const detail = probe?.detail ? `, output='${probe.detail}'` : '';
            throw new Error(`watchdog readiness script failed (${probe?.reason || 'unknown failure'}${detail})`);
        }
        return;
    }
    if (protocol !== 'tcp' && protocol !== 'mcp') {
        throw new Error(`watchdog resolved unsupported readiness protocol '${protocol}'`);
    }
    const readinessRoute = buildRelayReadinessRoute({
        route: {
            hostPort: Number(result.hostPort || 0),
        },
        manifest,
        runtimeResult: result,
        networkMode,
        generationDigest: result?.preparationLease?.preparedGeneration || '',
    });
    if (!readinessRoute.hostPort && !readinessRoute.relay) {
        throw new Error(`watchdog readiness protocol '${protocol}' requires one resolved private target or readiness.port`);
    }
    const waitUntilReady = monitor.waitForAgentReady || waitForAgentReady;
    const ready = await waitUntilReady(readinessRoute, {
        timeoutMs: positiveInteger(
            monitor?.config?.CONTAINER_RESTART_READY_TIMEOUT_MS
                ?? process.env.PLOINKY_CONTAINER_MONITOR_READY_TIMEOUT_MS,
            120000,
        ),
        intervalMs: positiveInteger(
            monitor?.config?.CONTAINER_RESTART_READY_INTERVAL_MS
                ?? process.env.PLOINKY_CONTAINER_MONITOR_READY_INTERVAL_MS,
            250,
        ),
        probeTimeoutMs: positiveInteger(
            monitor?.config?.CONTAINER_RESTART_READY_PROBE_TIMEOUT_MS
                ?? process.env.PLOINKY_CONTAINER_MONITOR_READY_PROBE_TIMEOUT_MS,
            1000,
        ),
        protocol,
    });
    if (!ready) {
        throw new Error(`watchdog readiness protocol '${protocol}' did not succeed`);
    }
}

async function activateRestartedContainerRoute(monitor, target, agentDir, result, networkMode, {
    assertCurrent = () => {},
    onRegistryCommitted = () => {},
    onCommitted = () => {},
} = {}) {
    const prepared = assertRestartPreparationResult(target, result);
    if (!prepared) return false;
    const routeKey = target.alias || target.agentName;
    const route = {
        container: prepared.containerName,
        hostPath: agentDir,
        repo: target.repoName,
        agent: target.agentName,
        ...(target.alias ? { alias: target.alias } : {}),
        hostPort: networkMode === 'none' ? null : result.hostPort || null,
    };

    const mergeRoute = monitor.mergeRoutingConfig || mergeRoutingConfig;
    const loadAgents = monitor.loadAgents || workspaceSvc.loadAgents;
    const saveAgents = monitor.saveAgents || workspaceSvc.saveAgents;
    const applyGeneration = monitor.applyEdgeRoutingGeneration || applyEdgeRoutingGeneration;
    const runWithApplyLock = monitor.withEdgeGenerationApplyLock
        || (monitor.applyEdgeRoutingGeneration
            ? (callback) => callback(Object.freeze({ testOnly: true }))
            : withEdgeGenerationApplyLock);
    await runWithApplyLock(async (applyLockCapability) => {
        await mergeRoute((cfg) => {
            assertCurrent('route-registry-commit', prepared.stagedRecord);
            const agents = loadAgents();
            const staged = agents?.[prepared.containerName];
            if (!staged || staged.type !== 'agent'
                || digestValue(staged) !== digestValue(prepared.stagedRecord)) {
                throw new Error(`watchdog runtime replacement lost its staged registry identity for '${prepared.containerName}'`);
            }
            agents[prepared.containerName] = structuredClone(prepared.record);
            saveAgents(agents, { coordinate: false });
            onRegistryCommitted();
            cfg.routes = cfg.routes || {};
            cfg.routes[routeKey] = mergeRuntimeRoute(
                cfg.routes[routeKey],
                route,
                { hostPort: route.hostPort },
            );
            return cfg;
        }, { coordinate: false });

        await Promise.resolve(applyGeneration({
            reason: `watchdog-runtime-ready:${routeKey}`,
            preparationLease: result.preparationLease,
            applyLockCapability,
            testHooks: {
                beforeSelectorCommit() {
                    assertCurrent('selector-commit', prepared.record);
                },
            },
        }));
        onCommitted();
    }, { preparationLease: result.preparationLease });
    return true;
}

async function abortFailedRestartPreparation(monitor, target, result, reason, originalFailure) {
    if (result?.preparationLease) {
        const abortPreparation = monitor.abortEdgeRoutingPreparation || abortEdgeRoutingPreparation;
        try {
            await Promise.resolve(abortPreparation(result.preparationLease, {
                reason: `watchdog-runtime-failed:${reason}`,
            }));
        } catch (error) {
            logEvent(monitor, 'error', 'container_restart_preparation_abort_failed', {
                container: result.containerName || target.containerName,
                agent: target.agentName,
                repo: target.repoName,
                error: error?.message || error,
            });
            const recoveryError = new Error(
                `watchdog recovery could not abort the exact edge preparation for '${result.containerName || target.containerName}'; preserving its failed runtime candidate: ${error?.message || error}`,
                { cause: error },
            );
            recoveryError.code = 'PLOINKY_RECOVERY_ABORT_FAILED';
            Object.defineProperty(recoveryError, 'originalFailure', {
                configurable: false,
                enumerable: false,
                writable: false,
                value: originalFailure,
            });
            Object.defineProperty(recoveryError, 'ploinkyRestartCandidate', {
                configurable: false,
                enumerable: false,
                writable: false,
                value: Object.freeze({
                    ...result,
                    exactCleanupPerformed: false,
                    preparationAbortFailed: true,
                    preparationAbortedBeforeCleanup: false,
                }),
            });
            throw recoveryError;
        }
    }
    if (result?.requiresEdgeActivation === true && result?.exactCleanupPerformed !== true) {
        const cleanupCandidate = monitor.cleanupExactAgentRuntimeCandidate
            || cleanupExactAgentRuntimeCandidate;
        try {
            await Promise.resolve(cleanupCandidate(result));
        } catch (error) {
            logEvent(monitor, 'error', 'container_restart_candidate_cleanup_failed', {
                container: result.containerName || target.containerName,
                agent: target.agentName,
                repo: target.repoName,
                error: error?.message || error,
            });
        }
    }
}

export async function performContainerRestart(monitor, target, reason, attempt = null) {
    if (!monitor || !target) return;
    assertRestartAttemptCurrent(monitor, target, attempt, 'pre-mutation-lock');
    if (monitor.isShuttingDown()) {
        target.isRestarting = false;
        return;
    }
    if (inspectWorkspaceStartLock().active) {
        target.isRestarting = false;
        logEvent(monitor, 'info', 'container_restart_deferred_workspace_start', {
            container: target.containerName,
            agent: target.agentName,
            repo: target.repoName,
        });
        return;
    }

    // A restart timer may have been scheduled immediately before a CLI
    // maintenance operation acquired its lock. Recheck at execution time so
    // the stale timer cannot race reinstall/restart staging.
    if (shouldDeferMaintenanceRestart(monitor, target)) {
        target.isRestarting = false;
        return;
    }

    if (target.type !== 'agent') {
        logEvent(monitor, 'warn', 'container_restart_skipped_type', {
            container: target.containerName,
            type: target.type
        });
        target.isRestarting = false;
        return;
    }

    const acquireWorkspaceLease = monitor.createWorkspaceMutationLease || createWorkspaceMutationLease;
    const releaseWorkspaceLease = monitor.releaseWorkspaceMutationLease || releaseWorkspaceMutationLease;
    let workspaceLease;
    try {
        workspaceLease = acquireWorkspaceLease({ operation: `watchdog-restart:${target.containerName}` });
    } catch (error) {
        if (error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY') {
            target.isRestarting = false;
            logEvent(monitor, 'info', 'container_restart_deferred_workspace_start', {
                container: target.containerName,
                agent: target.agentName,
                repo: target.repoName,
            });
            return;
        }
        target.isRestarting = false;
        throw error;
    }

    const runNetworkLifecycle = monitor.withNetworkLifecycleLock || withNetworkLifecycleLock;
    try {
        await runNetworkLifecycle(async (networkLifecycleCapability) => {
        let result = null;
        let activationCommitted = false;
        let registryCandidateCommitted = false;
        try {
        assertRestartAttemptCurrent(monitor, target, attempt, 'pre-physical-ensure');
        let manifestBytes;
        let manifest;
        try {
            manifestBytes = fs.readFileSync(target.manifestPath);
            manifest = JSON.parse(manifestBytes.toString('utf8') || '{}');
        } catch (error) {
            target.circuitBreakerTripped = true;
            target.lastError = error?.message || error;
            logEvent(monitor, 'error', fs.existsSync(target.manifestPath)
                ? 'container_manifest_parse_error'
                : 'container_manifest_missing', {
                container: target.containerName,
                agent: target.agentName,
                repo: target.repoName,
                manifest: target.manifestPath,
                error: target.lastError,
            });
            target.isRestarting = false;
            return;
        }
        const assertManifestUnchanged = () => {
            let current;
            try {
                current = fs.readFileSync(target.manifestPath);
            } catch (error) {
                const changed = new Error(`watchdog manifest changed or disappeared during restart: ${error?.message || error}`);
                changed.code = 'PLOINKY_RESTART_MANIFEST_CHANGED';
                throw changed;
            }
            if (!current.equals(manifestBytes)) {
                const changed = new Error('watchdog manifest bytes changed during restart; a fresh replacement is required');
                changed.code = 'PLOINKY_RESTART_MANIFEST_CHANGED';
                throw changed;
            }
        };
        const resolveRuntimeProfile = monitor.resolveManifestRuntimeProfile || resolveManifestRuntimeProfile;
        const profileResolution = resolveRuntimeProfile(manifest, {
            agentName: `${target.repoName}/${target.agentName}`,
            profileName: target.profile || undefined,
            path: `manifest(${target.repoName}/${target.agentName})`,
        });
        const resolveEndpoint = monitor.resolveRouterEndpoint || resolveRouterEndpoint;
        const routerEndpoint = resolveEndpoint(profileResolution.network.mode);
        const agentDir = path.dirname(target.manifestPath);
        const ensureAgentServiceImpl = monitor.ensureAgentService || ensureAgentService;
        if (target.runtimeAdmission) {
            assertRuntimeAdmissionCurrent(target.runtimeAdmission, {
                manifestBytes,
                profileName: profileResolution.resolvedProfileName,
                runtimeKind: target.runtime === 'bwrap' || target.runtime === 'seatbelt'
                    ? target.runtime
                    : 'container',
            });
        }
        result = await Promise.resolve(ensureAgentServiceImpl(target.agentName, manifest, agentDir, {
            containerName: target.containerName,
            commandHint: `ploinky restart ${target.alias || target.agentName}`,
            networkLockWaitMs: 0,
            profileName: profileResolution.resolvedProfileName,
            profileResolution,
            routerEndpoint,
            forceRecreate: reason === 'semantic_probe_failed',
            networkLifecycleCapability,
            runtimeAdmission: target.runtimeAdmission,
        }));
        assertRestartAttemptCurrent(monitor, target, attempt, 'post-physical-ensure', {
            expectedRegistryRecord: preActivationRegistryRecord(result),
        });
        // Preparation rereads the manifest for generation capture, while the
        // physical launch consumes the object above. Exact-byte comparisons on
        // both sides of semantic readiness prevent those inputs from diverging.
        assertManifestUnchanged();

        const prepared = assertRestartPreparationResult(target, result);
        if (!prepared) {
            target.lastSeenRunningAt = Date.now();
            target.currentBackoff = monitor?.config?.INITIAL_BACKOFF_MS ?? 1000;
            target.lastError = null;
            logEvent(monitor, 'info', 'container_restart_reused_running', {
                container: result?.containerName || target.containerName,
                agent: target.agentName,
                repo: target.repoName,
                reason,
            });
            target.isRestarting = false;
            return;
        }

        await waitForRestartedContainerReadiness(
            monitor,
            target,
            manifest,
            result,
            profileResolution.network.mode,
        );
        assertRestartAttemptCurrent(monitor, target, attempt, 'post-readiness', {
            expectedRegistryRecord: prepared.stagedRecord,
        });
        assertManifestUnchanged();
        assertRestartAttemptCurrent(monitor, target, attempt, 'pre-route-activation', {
            expectedRegistryRecord: prepared.stagedRecord,
        });
        await activateRestartedContainerRoute(
            monitor,
            target,
            agentDir,
            result,
            profileResolution.network.mode,
            {
                assertCurrent(checkpoint, expectedRegistryRecord) {
                    assertRestartAttemptCurrent(monitor, target, attempt, checkpoint, {
                        expectedRegistryRecord,
                    });
                    assertManifestUnchanged();
                },
                onRegistryCommitted() {
                    registryCandidateCommitted = true;
                },
                onCommitted() {
                    activationCommitted = true;
                    target.instanceId = String(result?.registryRecord?.instanceId || '') || null;
                    target.enableGeneration = String(result?.registryRecord?.enableGeneration || '') || null;

                    if (prepared.containerName !== target.containerName) {
                        const oldName = target.containerName;
                        monitor.targets.delete(oldName);
                        target.containerName = prepared.containerName;
                        monitor.targets.set(target.containerName, target);
                    }

                    stopProbeWorker(target);
                    target.probeState = 'pending';

                    const now = Date.now();
                    target.lastStartTime = now;
                    target.lastSeenRunningAt = now;
                    target.currentBackoff = monitor?.config?.INITIAL_BACKOFF_MS ?? 1000;
                    target.circuitBreakerTripped = false;
                    target.lastError = null;
                },
            },
        );

        logEvent(monitor, 'info', 'container_restart_success', {
            container: target.containerName,
            agent: target.agentName,
            repo: target.repoName,
            reason
        });
        } catch (error) {
        const failedResult = result || error?.ploinkyRestartCandidate || null;
        let surfacedError = error;
        if (!activationCommitted) {
            try {
                await abortFailedRestartPreparation(monitor, target, failedResult, reason, error);
            } catch (recoveryError) {
                surfacedError = recoveryError;
            }
        }
        target.lastError = surfacedError?.message || surfacedError;
        logEvent(monitor, 'error', 'container_restart_failed', {
            container: target.containerName,
            agent: target.agentName,
            repo: target.repoName,
            reason,
            error: target.lastError,
            code: surfacedError?.code || null,
        });
        if (surfacedError && typeof surfacedError === 'object') LOGGED_RESTART_FAILURES.add(surfacedError);
        assertRestartAttemptCurrent(monitor, target, attempt, 'pre-failure-record', {
            expectedRegistryRecord: registryCandidateCommitted
                ? failedResult?.registryRecord || null
                : preActivationRegistryRecord(failedResult),
        });
        target.isRestarting = false;
        throw surfacedError;
        }
        });
    } finally {
        releaseWorkspaceLease(workspaceLease);
    }

    target.isRestarting = false;
}

export function snapshotRunningContainerNames(monitor) {
    if (![...monitor.targets.values()].some((target) => (
        target && !isSandboxRuntime(target.runtime)
    ))) {
        return null;
    }
    try {
        const listRunning = monitor.listRunningContainerNames || listRunningContainerNames;
        return new Set(listRunning());
    } catch (error) {
        logEvent(monitor, 'error', 'container_status_snapshot_failed', {
            error: error?.message || error,
        });
        return null;
    }
}

export function monitorTick(monitor) {
    if (!monitor || monitor.isShuttingDown()) return;

    const inspectStartLock = monitor.inspectWorkspaceStartLock || inspectWorkspaceStartLock;
    const workspaceStart = inspectStartLock();
    if (workspaceStart.stale) {
        logEvent(monitor, 'info', 'workspace_start_lock_removed', {
            ownerPid: workspaceStart.lock?.ownerPid || null,
            expiresAt: workspaceStart.lock?.expiresAt || null,
        });
    }
    if (workspaceStart.active) {
        if (!monitor.workspaceStartDeferred) {
            monitor.workspaceStartDeferred = true;
            logEvent(monitor, 'info', 'container_monitor_deferred_workspace_start', {
                ownerPid: workspaceStart.lock?.ownerPid || null,
                expiresAt: workspaceStart.lock?.expiresAt || null,
            });
        }
        return;
    }
    monitor.workspaceStartDeferred = false;

    const syncContainers = monitor.syncManagedContainers || syncManagedContainers;
    syncContainers(monitor);

    const runningContainerNames = snapshotRunningContainerNames(monitor);

    for (const target of monitor.targets.values()) {
        if (!target || target.circuitBreakerTripped) continue;
        if (target.isRestarting || target.pendingRestartTimer) continue;

        let running = false;
        try {
            if (isSandboxRuntime(target.runtime)) {
                running = Boolean(target.instanceId && target.enableGeneration)
                    && isBwrapProcessRunning(target.containerName, {
                        instanceId: target.instanceId,
                        enableGeneration: target.enableGeneration,
                    });
            } else if (runningContainerNames) {
                running = runningContainerNames.has(target.containerName);
            } else {
                // A failed shared runtime snapshot means container state is
                // unknown. Defer this tick instead of multiplying the outage
                // into one blocking runtime call (or false restart) per target.
                continue;
            }
        } catch (error) {
            logEvent(monitor, 'error', 'container_status_check_failed', {
                container: target.containerName,
                agent: target.agentName,
                repo: target.repoName,
                error: error?.message || error
            });
        }

        if (running) {
            const now = Date.now();
            target.lastSeenRunningAt = now;
            if (!target.lastStartTime) target.lastStartTime = now;
            const resetAfter = 60000;
            if ((now - target.lastStartTime) > resetAfter && target.currentBackoff !== (monitor?.config?.INITIAL_BACKOFF_MS ?? 1000)) {
                target.currentBackoff = monitor?.config?.INITIAL_BACKOFF_MS ?? 1000;
                cleanRestartHistory(monitor, target);
                target.circuitBreakerTripped = false;
                logEvent(monitor, 'debug', 'container_backoff_reset', {
                    container: target.containerName,
                    agent: target.agentName,
                    repo: target.repoName
                });
            }
            // Detached no-wait launches own activation readiness until their
            // status becomes terminal. A running OCI container can still be
            // only partially initialized during that window, so recurring
            // liveness must not race activation and restart it underneath the
            // no-wait worker.
            if (shouldDeferNoWaitRestart(monitor, target)) {
                stopProbeWorker(target);
                continue;
            }
            const continuousProbeIntervalMs = positiveInteger(
                monitor?.config?.CONTINUOUS_PROBE_INTERVAL_MS
                    ?? process.env.PLOINKY_CONTAINER_MONITOR_CONTINUOUS_PROBE_INTERVAL_MS,
                30_000,
            );
            if (target.probeState === 'success'
                && (!target.probeLastSuccessAt
                    || now - target.probeLastSuccessAt >= continuousProbeIntervalMs)) {
                target.probeState = 'pending';
            }
            const startWorker = monitor.startProbeWorker || startProbeWorker;
            startWorker(monitor, target);
            continue;
        }

        if (target.probeState === 'running') {
            continue;
        }

        if (shouldDeferMaintenanceRestart(monitor, target)) {
            continue;
        }

        if (shouldDeferNoWaitRestart(monitor, target)) {
            continue;
        }

        stopProbeWorker(target);
        scheduleContainerRestart(monitor, target, 'not_running');
    }
}

export function createContainerMonitor({ config, log, isShuttingDown, terminalLedgerFile: ledgerFile } = {}) {
    const monitor = {
        config: config || {},
        log,
        isShuttingDown: typeof isShuttingDown === 'function' ? isShuttingDown : () => false,
        targets: new Map(),
        timer: null,
        ...(ledgerFile ? { terminalLedgerFile: ledgerFile } : {}),
        terminalLedger: null,
    };
    monitor.terminalLedger = loadTerminalLedger(monitor);
    return monitor;
}

export function startContainerMonitor(monitor) {
    if (!monitor || monitor.timer) return;
    if (monitor.isShuttingDown()) return;

    syncManagedContainers(monitor);
    monitorTick(monitor);

    const interval = monitor?.config?.CONTAINER_CHECK_INTERVAL_MS ?? 5000;
    monitor.timer = setInterval(() => {
        try {
            monitorTick(monitor);
        } catch (error) {
            logEvent(monitor, 'error', 'container_monitor_tick_error', { error: error?.message || error });
        }
    }, interval);

    logEvent(monitor, 'info', 'container_monitor_started', { intervalMs: interval });
}

export function stopContainerMonitor(monitor) {
    if (!monitor) return;
    if (monitor.timer) {
        clearInterval(monitor.timer);
        monitor.timer = null;
    }
    for (const target of monitor.targets.values()) {
        if (target?.pendingRestartTimer) {
            clearTimeout(target.pendingRestartTimer);
            target.pendingRestartTimer = null;
        }
        target.isRestarting = false;
        stopProbeWorker(target);
    }
    logEvent(monitor, 'info', 'container_monitor_stopped', {
        tracked: monitor.targets.size
    });
}

export function clearContainerTargets(monitor) {
    if (!monitor) return;
    stopContainerMonitor(monitor);
    monitor.targets.clear();
}
