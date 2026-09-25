// Serializes a workspace start or restart with the detached no-wait workers of
// an earlier start.
//
// A start returns once its blocking graph is ready, while its no-wait workers
// keep creating, probing and publishing their runtimes, taking the workspace
// mutation lease only for short steps. A later start or restart that runs
// between those steps stops or re-stages runtimes a worker is still creating:
// the worker's container is then neither registered nor removable, and both
// the new start and the worker fail. So a start or restart first waits until
// no earlier worker can still make progress, without holding the workspace
// lease the workers need, then re-inspects under the lease it acquires.
//
// Nothing here signals a worker or changes lifecycle state.

import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNNING_DIR } from '../utils/config.js';
import { readVerifiedJsonObject } from '../utils/verifiedReadOnlyFile.js';
import { proveWorkerProcessIdentity } from '../sandbox/processIdentity.js';
import {
    assertActiveEdgeRoutingSourcesCurrent,
    readEdgeRoutingPreparationOwner,
} from '../sandbox/edgeGeneration.js';
import {
    acquireWorkspaceMutationLease,
    releaseWorkspaceMutationLease,
} from '../utils/runtime/maintenanceLocks.js';
import { NO_WAIT_DIR_NAME } from './noWaitPaths.js';
import { NO_WAIT_STATE_BYTE_LIMIT, readNoWaitRunMarker } from './noWaitLogObserver.js';
import {
    boundedNoWaitTimeoutInput,
    noWaitQueuedStatusDeadline,
    resolveNoWaitBarrierTimeouts,
    resolveRunScopedObservation,
} from './noWaitProtocol.js';
import {
    exactNoWaitImmutableIdentity,
    parseNoWaitWorkerArgs,
    sameNoWaitImmutableIdentity,
} from './noWaitWorkerArgs.js';
import { resolveNoWaitWorkerLifecycleSnapshot } from './noWaitWorker.js';

const MARKER_SUFFIX = '.current.json';
const DEFAULT_SETTLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SETTLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const WORKER_SCRIPT_PATH = fileURLToPath(new URL('./noWaitWorker.js', import.meta.url));

export function resolveNoWaitSettleTimeoutMs(value = process.env.PLOINKY_NO_WAIT_SETTLE_TIMEOUT_MS) {
    return boundedNoWaitTimeoutInput(value, {
        fallback: DEFAULT_SETTLE_TIMEOUT_MS,
        minimum: 0,
        maximum: MAX_SETTLE_TIMEOUT_MS,
    });
}

function listMarkedContainers(runningDir, fsApi) {
    let names;
    try {
        names = fsApi.readdirSync(pathDefault.join(runningDir, NO_WAIT_DIR_NAME));
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
        throw error;
    }
    return names
        .filter((name) => name.endsWith(MARKER_SUFFIX))
        .map((name) => name.slice(0, -MARKER_SUFFIX.length))
        .filter(Boolean)
        .sort();
}

// The marker names the latest run of one container; its run-scoped status and
// the worker's own process identity decide whether that worker is still live.
function observeMarkedWorker(containerName, {
    runningDir,
    fsApi,
    nowMs,
    timeouts,
    proveWorkerProcess,
}) {
    let marker;
    let status;
    try {
        marker = readNoWaitRunMarker(containerName, { runningDir, fsApi });
        if (!marker) return null;
        status = readVerifiedJsonObject({
            trustedRoot: runningDir,
            relativeSegments: [NO_WAIT_DIR_NAME, marker.statusFile],
            byteLimit: NO_WAIT_STATE_BYTE_LIMIT,
            absent: null,
            fsApi,
        });
    } catch (error) {
        return { containerName, live: false, reason: `unverifiable: ${error?.message || error}` };
    }
    const base = { containerName, runId: marker.runId, marker };
    if (!status) {
        // A marker is published just before its worker is spawned. Only the
        // startup grace can make a missing status plausible.
        return nowMs > marker.runStartedAtMs + timeouts.startupGraceMs
            ? { ...base, live: false, reason: 'never published a status' }
            : { ...base, live: true, pid: null, agentPath: '', reason: 'publishing its first status' };
    }
    let observation;
    try {
        if (!sameNoWaitImmutableIdentity(exactNoWaitImmutableIdentity(status), marker)) {
            throw new Error('the run-scoped status belongs to a different immutable identity');
        }
        observation = resolveRunScopedObservation(status, {
            expectedRunId: marker.runId,
            runStartedAtMs: marker.runStartedAtMs,
            targetWaveIndex: marker.waveIndex,
            timeouts,
            nowMs,
        });
    } catch (error) {
        return { ...base, live: false, reason: `unverifiable: ${error?.message || error}` };
    }
    // 'running' is published after the route commit and 'failed' after
    // cleanup; the worker only releases its locks afterwards.
    if (observation.terminal) return { ...base, live: false, reason: observation.terminal };
    const pid = observation.workerPid;
    try {
        const proof = proveWorkerProcess({
            pid,
            executablePath: process.execPath,
            workerScriptPath: WORKER_SCRIPT_PATH,
            runningDir,
            identity: marker,
        });
        const { agentPath } = parseNoWaitWorkerArgs(proof.argv.slice(2), { runningDir });
        return { ...base, live: true, pid, agentPath, reason: 'running' };
    } catch (error) {
        if (error?.code === 'PROCESS_IDENTITY_STALE') {
            return { ...base, live: false, pid, reason: 'stopped without a terminal status' };
        }
        if (error?.foreign) return { ...base, live: false, pid, reason: 'its pid now belongs to another process' };
        // Alive, but not provably this worker (its arguments are unreadable, or
        // it runs under another executable path): it cannot be proven stopped.
        // Past its run-scoped deadline the worker protocol already treats the
        // run as stale, so it is no longer waited for. That does not prove the
        // worker exited: it stays in the live set, so the start supersedes it
        // and it can neither resume nor keep its unpublished runtime.
        const deadlineMs = observation.queued
            ? noWaitQueuedStatusDeadline(marker.runStartedAtMs, marker.waveIndex, timeouts)
            : observation.deadline;
        const pastDeadline = Number.isSafeInteger(deadlineMs) && nowMs > deadlineMs;
        return {
            ...base,
            live: true,
            pid,
            agentPath: String(status.agentPath || ''),
            pastDeadline,
            reason: pastDeadline ? 'running (unproven) past its run-scoped deadline' : 'running (unproven)',
        };
    }
}

// A live worker can make progress only while the active generation still
// carries its exact staged identity, which is the worker's own lifecycle check.
// A stop, a source change or a newer start leaves it retrying or failing
// without touching a runtime, so waiting for it would only stall this command.
function workerCanProgress(worker, active) {
    if (!active) return false;
    const identity = worker.marker;
    const agentPath = worker.agentPath
        || String(active.generation?.routing?.routes?.[identity.routeKey]?.hostPath || '');
    try {
        resolveNoWaitWorkerLifecycleSnapshot(active, { ...identity, agentPath });
        return true;
    } catch (_) {
        return false;
    }
}

function classifyLiveNoWaitWorkers({
    runningDir = RUNNING_DIR,
    workspaceRoot,
    fsApi = fsDefault,
    nowMs = Date.now(),
    timeouts = resolveNoWaitBarrierTimeouts(),
    proveWorkerProcess = proveWorkerProcessIdentity,
    loadActiveGeneration = () => assertActiveEdgeRoutingSourcesCurrent(workspaceRoot ? { workspaceRoot } : {}),
    readPreparationOwner = () => readEdgeRoutingPreparationOwner(workspaceRoot ? { workspaceRoot } : {}),
} = {}) {
    const live = listMarkedContainers(runningDir, fsApi)
        .map((containerName) => observeMarkedWorker(containerName, {
            runningDir, fsApi, nowMs, timeouts, proveWorkerProcess,
        }))
        .filter((worker) => worker?.live);
    if (!live.length) return [];
    let active = null;
    try { active = loadActiveGeneration(); } catch (_) {}
    let preparationOwnerPid = 0;
    try { preparationOwnerPid = Number(readPreparationOwner()?.pid || 0); } catch (_) {}
    return live.map((worker) => Object.freeze({
        containerName: worker.containerName,
        runId: worker.runId,
        pid: worker.pid,
        reason: worker.reason,
        identity: worker.marker,
        // A worker that owns the outstanding preparation keeps the selector
        // inactive only until its own readiness and commit finish.
        canProgress: !worker.pastDeadline
            && (Boolean(worker.pid && worker.pid === preparationOwnerPid) || workerCanProgress(worker, active)),
    }));
}

/**
 * The detached no-wait workers of earlier starts that are still live and can
 * still change a runtime, route or registry record. Workers that already
 * published a terminal status, stopped, or can no longer progress are omitted.
 */
export function inspectInFlightNoWaitWorkers(options = {}) {
    return classifyLiveNoWaitWorkers(options)
        .filter((worker) => worker.canProgress)
        .map(({ containerName, runId, pid, reason }) => Object.freeze({ containerName, runId, pid, reason }));
}

/**
 * Every live worker of an earlier start, with its exact identity. After the
 * settle, a start holding the workspace lease and network lock finds only
 * workers that cannot change anything while it holds them: ones a stop or a
 * source change stalled, or one that became able to progress just after the
 * settle's check. None has published, and any of them would resume beside the
 * start's own launch under a generation that carried its staged identity
 * again, so the start supersedes them all by rotating that identity.
 */
export function inspectLiveNoWaitWorkers(options = {}) {
    return classifyLiveNoWaitWorkers(options)
        .map(({ containerName, runId, pid, identity, canProgress }) => Object.freeze({
            containerName, runId, pid, identity, canProgress,
        }));
}

function describeWorkers(workers) {
    return workers
        .map(({ containerName, pid, runId }) => `${containerName} (${pid ? `pid ${pid}` : 'pid not yet published'}, run ${runId})`)
        .join(', ');
}

function operationLabel(operation) {
    return String(operation || 'workspace mutation').replace(/-/g, ' ');
}

function inFlightError(operation, workers, timeoutMs) {
    const error = new Error(
        `${operationLabel(operation)} refused: ${workers.length} no-wait worker(s) of an earlier start were `
        + `still starting after ${Math.round(timeoutMs / 1000)}s: ${describeWorkers(workers)}. Nothing was stopped `
        + 'or changed. Run the command again once they finish, or run `ploinky stop`, then `ploinky start`.',
    );
    error.code = 'PLOINKY_NO_WAIT_RUN_IN_FLIGHT';
    return error;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait, without holding the workspace lease, until no earlier no-wait worker
 * can still make progress. Throws PLOINKY_NO_WAIT_RUN_IN_FLIGHT at the deadline.
 */
export async function waitForNoWaitRunsToSettle({
    operation,
    timeoutMs = resolveNoWaitSettleTimeoutMs(),
    deadlineMs = Date.now() + timeoutMs,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    inspect = inspectInFlightNoWaitWorkers,
    log = (message) => console.log(message),
    sleepFn = sleep,
    nowFn = Date.now,
} = {}) {
    let announced = '';
    while (true) {
        const workers = inspect();
        if (!workers.length) return;
        const summary = describeWorkers(workers);
        if (summary !== announced) {
            log(`[${operationLabel(operation)}] Waiting for ${workers.length} no-wait worker(s) of an earlier start to finish: ${summary}`);
            announced = summary;
        }
        const remainingMs = deadlineMs - nowFn();
        if (remainingMs <= 0) throw inFlightError(operation, workers, timeoutMs);
        await sleepFn(Math.min(pollIntervalMs, remainingMs));
    }
}

/**
 * Acquire the workspace mutation lease once no earlier no-wait worker can
 * still make progress. A worker that resumed while the lease was being
 * acquired is re-detected under the lease, which is then released and the
 * wait resumed, all within one deadline.
 */
export async function acquireSettledWorkspaceMutationLease({
    operation,
    timeoutMs = resolveNoWaitSettleTimeoutMs(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    inspect = inspectInFlightNoWaitWorkers,
    acquireLease = acquireWorkspaceMutationLease,
    releaseLease = releaseWorkspaceMutationLease,
    log = (message) => console.log(message),
    sleepFn = sleep,
    nowFn = Date.now,
} = {}) {
    const deadlineMs = nowFn() + timeoutMs;
    while (true) {
        await waitForNoWaitRunsToSettle({
            operation, timeoutMs, deadlineMs, pollIntervalMs, inspect, log, sleepFn, nowFn,
        });
        const lease = await acquireLease({ operation });
        let workers;
        try {
            workers = inspect();
        } catch (error) {
            releaseLease(lease);
            throw error;
        }
        if (!workers.length) return lease;
        if (!releaseLease(lease)) {
            const error = new Error(`${operationLabel(operation)} could not release its exact workspace lease`);
            error.code = 'workspace_mutation_lock_release_failed';
            throw error;
        }
    }
}
