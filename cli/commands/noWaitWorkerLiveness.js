// Side-effect-free liveness of the detached no-wait workers of a start.
//
// A start publishes `<container>.current.json` naming the latest run of each
// no-wait container just before it spawns that run's worker; the worker then
// publishes its run-scoped `<container>.<runId>.json` status, which stays
// `starting` through readiness and becomes `running` or `failed` only after the
// route commit. These readers decide from those two files and the worker's own
// process identity whether a latest run is still live.
//
// Nothing here writes, renames, removes, signals or cleans anything up. It must
// not import noWaitWorker.js (the mutating worker) or the edge generation
// module: the Router loads it to answer startup probes.

import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNNING_DIR } from '../utils/config.js';
import { readVerifiedJsonObject } from '../utils/verifiedReadOnlyFile.js';
import { validateHardwareOutcome } from '../sandbox/hardwareLimits/errors.mjs';
import { proveWorkerProcessIdentity } from '../sandbox/processIdentity.js';
import { NO_WAIT_DIR_NAME } from './noWaitPaths.js';
import { NO_WAIT_STATE_BYTE_LIMIT, readNoWaitRunMarker } from './noWaitLogObserver.js';
import {
    noWaitQueuedStatusDeadline,
    resolveNoWaitBarrierTimeouts,
    resolveRunScopedObservation,
} from './noWaitProtocol.js';
import {
    exactNoWaitImmutableIdentity,
    parseNoWaitWorkerArgs,
    sameNoWaitImmutableIdentity,
} from './noWaitWorkerArgs.js';

const MARKER_SUFFIX = '.current.json';
// The path a genuine worker runs as; compared against its argv, never loaded.
const WORKER_SCRIPT_PATH = fileURLToPath(new URL('./noWaitWorker.js', import.meta.url));
const DEFAULT_MAX_ROUTING_MARKERS = 256;

function markedContainerNames(names) {
    return names
        .filter((name) => name.endsWith(MARKER_SUFFIX))
        .map((name) => name.slice(0, -MARKER_SUFFIX.length))
        .filter(Boolean)
        .sort();
}

export function listMarkedContainers(runningDir, fsApi) {
    let names;
    try {
        names = fsApi.readdirSync(pathDefault.join(runningDir, NO_WAIT_DIR_NAME));
    } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
        throw error;
    }
    return markedContainerNames(names);
}

function runScopedDeadlinePassed(observation, marker, timeouts, nowMs) {
    const deadlineMs = observation.queued
        ? noWaitQueuedStatusDeadline(marker.runStartedAtMs, marker.waveIndex, timeouts)
        : observation.deadline;
    return Number.isSafeInteger(deadlineMs) && nowMs > deadlineMs;
}

// The marker names the latest run of one container; its run-scoped status and
// the worker's own process identity decide whether that worker is still live.
// Without `validateTerminalOutcome`, a terminal `failed` status that carries a
// hardware outcome cannot be validated and reads as unverifiable.
export function observeMarkedWorker(containerName, {
    runningDir,
    fsApi,
    nowMs,
    timeouts,
    proveWorkerProcess,
    validateTerminalOutcome,
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
            ...(validateTerminalOutcome ? { validateTerminalOutcome } : {}),
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
            // Not live. Whether its run-scoped deadline has passed is reported
            // for observers that cannot confirm the exit from their process
            // view; an unknown deadline counts as not yet passed.
            let pastDeadline = false;
            try { pastDeadline = runScopedDeadlinePassed(observation, marker, timeouts, nowMs); } catch (_) {}
            return { ...base, live: false, pid, pastDeadline, reason: 'stopped without a terminal status' };
        }
        if (error?.foreign) return { ...base, live: false, pid, reason: 'its pid now belongs to another process' };
        // Alive, but not provably this worker (its arguments are unreadable, or
        // it runs under another executable path): it cannot be proven stopped.
        // Past its run-scoped deadline the worker protocol already treats the
        // run as stale, so it is no longer waited for. That does not prove the
        // worker exited: it stays in the live set, so the start supersedes it
        // and it can neither resume nor keep its unpublished runtime.
        const pastDeadline = runScopedDeadlinePassed(observation, marker, timeouts, nowMs);
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

// Marker outcomes that cannot change a route: the run published its terminal
// status, never published one within the startup grace, or its pid now names
// another process.
const SETTLED_MARKER_REASONS = new Set([
    'running',
    'failed',
    'never published a status',
    'its pid now belongs to another process',
]);

// Lower rank wins when several markers are busy.
const ROUTING_BUSY_RANK = Object.freeze({
    'live-worker': 0,
    unverifiable: 1,
    'exit-unconfirmed': 2,
});

function routingVerdict(worker) {
    if (worker === null) return null; // The marker was retired.
    if (worker?.live === true) return 'live-worker';
    if (worker?.live !== false) return 'unverifiable'; // Not an observation this scan knows.
    const reason = String(worker?.reason || '');
    if (reason.startsWith('unverifiable')) return 'unverifiable';
    if (reason === 'stopped without a terminal status') {
        // The pid is gone from this process view, but the run is still inside
        // its run-scoped deadline: the exit is not confirmed for routing.
        return worker.pastDeadline === true ? null : 'exit-unconfirmed';
    }
    if (SETTLED_MARKER_REASONS.has(reason)) return null;
    return 'unverifiable';
}

function busy(reason) {
    return Object.freeze({ busy: true, reason });
}

/**
 * Whether the latest no-wait run of any container may still change routing.
 * Returns `{ busy, reason }`; any doubt is busy. Reads only: a directory
 * listing, each marker, its run-scoped status, and a process proof for a
 * non-terminal status.
 */
export function inspectNoWaitRoutingActivity({
    runningDir = RUNNING_DIR,
    fsApi = fsDefault,
    nowMs = Date.now(),
    timeouts = resolveNoWaitBarrierTimeouts(),
    proveWorkerProcess = proveWorkerProcessIdentity,
    maxMarkers = DEFAULT_MAX_ROUTING_MARKERS,
    observeWorker = observeMarkedWorker,
} = {}) {
    try {
        let names;
        try {
            names = fsApi.readdirSync(pathDefault.join(runningDir, NO_WAIT_DIR_NAME));
        } catch (error) {
            if (error?.code === 'ENOENT') return Object.freeze({ busy: false, reason: 'no-workers' });
            return busy('unlistable');
        }
        const containers = markedContainerNames(names);
        if (containers.length > maxMarkers) return busy('too-many-markers');
        let verdict = null;
        for (const containerName of containers) {
            // A hardware refusal or block is a terminal `failed` status.
            const next = routingVerdict(observeWorker(containerName, {
                runningDir, fsApi, nowMs, timeouts, proveWorkerProcess, validateTerminalOutcome: validateHardwareOutcome,
            }));
            if (next && (verdict === null || ROUTING_BUSY_RANK[next] < ROUTING_BUSY_RANK[verdict])) verdict = next;
            if (verdict === 'live-worker') break;
        }
        return verdict ? busy(verdict) : Object.freeze({ busy: false, reason: 'settled' });
    } catch (_) {
        return busy('error');
    }
}
