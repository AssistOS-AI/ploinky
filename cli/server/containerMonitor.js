import fs from 'fs';
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
    isContainerRunning,
} from '../sandbox/docker/index.js';
import { shouldMonitorManifestRuntime } from '../utils/runtime/manifestStartup.js';
import { isSandboxRuntime } from '../sandbox/docker/common.js';
import { isBwrapProcessRunning } from '../sandbox/bwrap/bwrapFleet.js';
import { resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import { resolveRouterEndpoint } from '../sandbox/routerPort.js';
import { resolveAgentReadinessProtocol } from '../utils/runtime/startupReadiness.js';
import { runContainerScriptReadiness } from '../sandbox/docker/healthProbes.js';
import {
    buildRelayReadinessRoute,
    waitForAgentReady,
} from './utils/agentReadiness.js';
import { applyEdgeRoutingGeneration } from '../sandbox/coordinatedEdgeApply.js';
import {
    abortEdgeRoutingPreparation,
    inactivateEdgeRoutingGeneration,
} from '../sandbox/edgeGeneration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROBE_WORKER_URL = new URL('./probeWorker.js', import.meta.url);
const LOGGED_RESTART_FAILURES = new WeakSet();

function noopLog() {}

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
    };
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

function startProbeWorker(monitor, target) {
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
        target.probeWorker = new Worker(PROBE_WORKER_URL, {
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

function readNoWaitStatus(containerName) {
    if (!containerName) return null;
    const statusPath = path.join(RUNNING_DIR, 'no-wait', `${containerName}.json`);
    try {
        const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

function shouldDeferNoWaitRestart(monitor, target) {
    const status = readNoWaitStatus(target?.containerName || '');
    const state = String(status?.state || '').trim().toLowerCase();
    if (state !== 'starting' && state !== 'failed') {
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

function syncManagedContainers(monitor) {
    const monitorRef = monitor;
    if (!monitorRef) return;

    let agentsMap = {};
    try {
        agentsMap = workspaceSvc.loadAgents() || {};
    } catch (error) {
        logEvent(monitorRef, 'error', 'container_sync_failed', { error: error?.message || error });
        return;
    }

    const desired = new Map();
    const routing = readRoutingConfig();

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

        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const routeKey = alias || agentName;
            if (!shouldMonitorManifestRuntime(manifest, {
                hasRoute: Boolean(routing.routes?.[routeKey]),
            })) {
                continue;
            }
        } catch (error) {
            logEvent(monitorRef, 'error', 'container_manifest_invalid', {
                container: containerName,
                agent: agentName,
                repo: repoName,
                manifest: manifestPath,
                error: error?.message || String(error),
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
        };
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
            target.agentName = agentName;
            target.repoName = repoName;
            target.alias = alias;
            target.profile = profile;
            target.instanceId = instanceId;
            target.enableGeneration = enableGeneration;
            target.type = type;
            target.manifestPath = manifestPath;
            target.runtime = runtime;
        }
    }

    for (const [containerName, target] of Array.from(monitorRef.targets.entries())) {
        if (!desired.has(containerName)) {
            if (target?.pendingRestartTimer) {
                clearTimeout(target.pendingRestartTimer);
            }
            stopProbeWorker(target);
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
    target.pendingRestartTimer = setTimeout(() => {
        target.pendingRestartTimer = null;
        performContainerRestart(monitor, target, reason).catch((error) => {
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
            scheduleContainerRestart(monitor, target, 'restart_failed');
        });
    }, backoff);
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
    if (!result.preparationLease) {
        throw new Error('watchdog runtime replacement requires its exact preparation lease');
    }
    return { containerName, record };
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

async function activateRestartedContainerRoute(monitor, target, agentDir, result, networkMode) {
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
    await mergeRoute((cfg) => {
        const agents = loadAgents();
        const staged = agents?.[prepared.containerName];
        if (!staged || staged.type !== 'agent'
            || String(staged.instanceId || '') !== String(prepared.record.instanceId)
            || String(staged.enableGeneration || '') !== String(prepared.record.enableGeneration)) {
            throw new Error(`watchdog runtime replacement lost its staged registry identity for '${prepared.containerName}'`);
        }
        agents[prepared.containerName] = structuredClone(prepared.record);
        saveAgents(agents, { coordinate: false });
        cfg.routes = cfg.routes || {};
        cfg.routes[routeKey] = mergeRuntimeRoute(
            cfg.routes[routeKey],
            route,
            { hostPort: route.hostPort },
        );
        return cfg;
    }, { coordinate: false });

    const applyGeneration = monitor.applyEdgeRoutingGeneration || applyEdgeRoutingGeneration;
    await Promise.resolve(applyGeneration({
        reason: `watchdog-runtime-ready:${routeKey}`,
        preparationLease: result.preparationLease,
    }));
    return true;
}

async function abortFailedRestartPreparation(monitor, target, result, reason) {
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
        }
    }
    if (result?.requiresEdgeActivation !== true || result?.exactCleanupPerformed === true) return;
    try {
        if (typeof monitor.cleanupFailedRuntime === 'function') {
            await Promise.resolve(monitor.cleanupFailedRuntime(result.containerName || target.containerName, target));
        } else {
            await Promise.resolve(cleanupExactAgentRuntimeCandidate(result));
        }
    } catch (error) {
        logEvent(monitor, 'error', 'container_restart_candidate_cleanup_failed', {
            container: result.containerName || target.containerName,
            agent: target.agentName,
            repo: target.repoName,
            error: error?.message || error,
        });
    }
}

export async function performContainerRestart(monitor, target, reason) {
    if (!monitor || !target) return;
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

    let result = null;
    try {
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
        result = await Promise.resolve(ensureAgentServiceImpl(target.agentName, manifest, agentDir, {
            containerName: target.containerName,
            commandHint: `ploinky restart ${target.alias || target.agentName}`,
            networkLockWaitMs: 0,
            profileName: profileResolution.resolvedProfileName,
            profileResolution,
            routerEndpoint,
            forceRecreate: reason === 'semantic_probe_failed',
        }));
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
        assertManifestUnchanged();
        await activateRestartedContainerRoute(
            monitor,
            target,
            agentDir,
            result,
            profileResolution.network.mode,
        );
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

        logEvent(monitor, 'info', 'container_restart_success', {
            container: target.containerName,
            agent: target.agentName,
            repo: target.repoName,
            reason
        });
    } catch (error) {
        const failedResult = result || error?.ploinkyRestartCandidate || null;
        await abortFailedRestartPreparation(monitor, target, failedResult, reason);
        target.lastError = error?.message || error;
        logEvent(monitor, 'error', 'container_restart_failed', {
            container: target.containerName,
            agent: target.agentName,
            repo: target.repoName,
            reason,
            error: target.lastError
        });
        if (error && typeof error === 'object') LOGGED_RESTART_FAILURES.add(error);
        target.isRestarting = false;
        throw error;
    } finally {
        releaseWorkspaceLease(workspaceLease);
    }

    target.isRestarting = false;
}

function monitorTick(monitor) {
    if (!monitor || monitor.isShuttingDown()) return;

    const workspaceStart = inspectWorkspaceStartLock();
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

    syncManagedContainers(monitor);

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
            } else {
                running = isContainerRunning(target.containerName);
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
            target.noWaitDeferredState = null;
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
            startProbeWorker(monitor, target);
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

export function createContainerMonitor({ config, log, isShuttingDown } = {}) {
    return {
        config: config || {},
        log,
        isShuttingDown: typeof isShuttingDown === 'function' ? isShuttingDown : () => false,
        targets: new Map(),
        timer: null
    };
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
