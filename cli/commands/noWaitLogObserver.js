// Binds one observation to one exact no-wait run.
//
// Three files describe a run: the `<container>.current.json` marker naming the
// live run, the `<container>.<runId>.json` run-scoped status, and the
// `<container>.<runId>.log` startup stream. A follower that binds only to the
// container name can be handed a superseding start's runtime, or can keep
// following a predecessor's output. Every check here exists to make that
// impossible: the marker fixes the run id, the status must belong to that run,
// the registry tuple captured at bind time must not move, and the published
// worker pid must belong to a live process that is really this worker.
//
// Nothing here writes, repairs, or deletes state.

import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    noWaitQueuedStatusDeadline,
    resolveNoWaitBarrierTimeouts,
    resolveRunScopedObservation,
} from './noWaitProtocol.js';
import {
    NO_WAIT_IMMUTABLE_IDENTITY_FIELDS,
    exactNoWaitImmutableIdentity,
    sameNoWaitImmutableIdentity,
} from './noWaitWorkerArgs.js';
import {
    noWaitCurrentMarkerPath,
    noWaitRunScopedStatusPath,
} from './noWaitPaths.js';
import { proveWorkerProcessIdentity } from '../sandbox/processIdentity.js';
import { readVerifiedJsonObject } from '../utils/verifiedReadOnlyFile.js';
import { sanitizeControlDiagnosticText } from '../utils/diagnosticText.js';

export const NO_WAIT_STATE_BYTE_LIMIT = 256 * 1024;
const NO_WAIT_FAILURE_PHASES = Object.freeze(['admission', 'spawn', 'launch', 'readiness']);

export function noWaitObservationError(message, { superseded = false, stale = false } = {}) {
    const error = new Error(message);
    error.code = superseded
        ? 'NO_WAIT_RUN_SUPERSEDED'
        : (stale ? 'NO_WAIT_OBSERVATION_STALE' : 'NO_WAIT_OBSERVATION_INVALID');
    return error;
}

function readNoWaitJson(relativeName, { runningDir, fsApi, pathApi }) {
    try {
        return readVerifiedJsonObject({
            trustedRoot: runningDir,
            relativeSegments: ['no-wait', relativeName],
            byteLimit: NO_WAIT_STATE_BYTE_LIMIT,
            absent: null,
            fsApi,
            pathApi,
        });
    } catch (error) {
        throw noWaitObservationError(`no-wait state '${relativeName}' is invalid: ${error.message}`);
    }
}

// Published integers are compared by type. `Number(null)`, `Number('')`, and
// `Number(false)` are all 0 and would let a malformed marker match wave zero.
function publishedInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : NaN;
}

export function readNoWaitRunMarker(containerName, {
    runningDir,
    fsApi = fsDefault,
    pathApi = pathDefault,
} = {}) {
    const markerPath = noWaitCurrentMarkerPath(containerName, runningDir ? { runningDir } : {});
    const stateRoot = runningDir || pathApi.dirname(pathApi.dirname(markerPath));
    const marker = readNoWaitJson(pathApi.basename(markerPath), {
        runningDir: stateRoot,
        fsApi,
        pathApi,
    });
    if (!marker) return null;
    let identity;
    try {
        identity = exactNoWaitImmutableIdentity(marker, { pathApi });
    } catch (error) {
        throw noWaitObservationError(`the no-wait run marker has no complete immutable identity: ${error.message}`);
    }
    if (identity.containerName !== containerName) {
        throw noWaitObservationError('the no-wait run marker names a different container');
    }
    return Object.freeze({ ...identity, markerPath });
}

export function sameNoWaitRun(left, right) {
    return sameNoWaitImmutableIdentity(left, right);
}

function immutableIdentityFromRecord(containerName, record, marker) {
    const alias = record?.alias === undefined || record?.alias === null ? '' : record.alias;
    try {
        return exactNoWaitImmutableIdentity({
            containerName,
            instanceId: record?.instanceId,
            enableGeneration: record?.enableGeneration,
            repoName: record?.repoName,
            shortAgent: record?.agentName,
            alias,
            routeKey: alias || record?.agentName,
            runId: marker?.runId,
            runStartedAtMs: marker?.runStartedAtMs,
            waveIndex: marker?.waveIndex,
            statusFile: marker?.statusFile,
        });
    } catch (error) {
        throw noWaitObservationError(
            `the current registry cannot prove the marker identity: ${error.message}`,
            { superseded: true },
        );
    }
}

export function createNoWaitRunBinding(containerName, record, marker) {
    if (!containerName || record?.type !== 'agent' || !marker) {
        throw noWaitObservationError('a no-wait observation requires one exact registry and marker binding');
    }
    let markerIdentity;
    try {
        markerIdentity = exactNoWaitImmutableIdentity(marker);
    } catch (error) {
        throw noWaitObservationError(`the no-wait marker identity is invalid: ${error.message}`);
    }
    const recordIdentity = immutableIdentityFromRecord(containerName, record, markerIdentity);
    if (!sameNoWaitRun(recordIdentity, markerIdentity)) {
        throw noWaitObservationError(
            'the no-wait marker belongs to a different registry generation',
            { superseded: true },
        );
    }
    return Object.freeze({
        ...markerIdentity,
        marker: markerIdentity,
    });
}

// Only fields the worker already bounded and redacted may reach an operator
// diagnostic. Raw status JSON, environments, and spawn options never do.
export function summarizeNoWaitFailure(status) {
    const rawPhase = String(status?.phase || '').trim();
    const phase = NO_WAIT_FAILURE_PHASES.includes(rawPhase) ? rawPhase : '';
    const message = String(status?.error?.message || '').trim();
    const parts = [];
    if (phase) parts.push(`phase: ${phase}`);
    parts.push(message || 'the worker published no failure detail');
    return sanitizeControlDiagnosticText(parts.join(' — '));
}

// One complete poll of the immutable binding. Status/process evidence is
// always fenced afterward by the current marker and canonical registry tuple.
export function observeBoundNoWaitRun(binding, {
    runningDir,
    fsApi = fsDefault,
    pathApi = pathDefault,
    nowMs = Date.now(),
    timeouts = resolveNoWaitBarrierTimeouts(),
    proveWorkerProcess = proveWorkerProcessIdentity,
    requireWorkerProcess = true,
    readRegistrySnapshot,
} = {}) {
    const containerName = String(binding?.containerName || '');
    const rawBoundMarker = binding?.marker;
    let boundMarker;
    try {
        boundMarker = exactNoWaitImmutableIdentity(rawBoundMarker, { pathApi });
    } catch (_) {
        throw noWaitObservationError('the no-wait observer received no complete immutable binding');
    }
    if (!containerName || typeof readRegistrySnapshot !== 'function'
        || !NO_WAIT_IMMUTABLE_IDENTITY_FIELDS.every((field) => binding[field] === boundMarker[field])) {
        throw noWaitObservationError('the no-wait observer received no complete immutable binding');
    }
    const observationNowMs = publishedInteger(nowMs);
    const startupGraceMs = publishedInteger(timeouts?.startupGraceMs);
    if (!Number.isSafeInteger(observationNowMs) || observationNowMs < 0
        || !Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0) {
        throw noWaitObservationError('the no-wait observer received an invalid clock or startup budget');
    }
    const latestPlausibleStartMs = observationNowMs + startupGraceMs;
    if (!Number.isSafeInteger(latestPlausibleStartMs)
        || boundMarker.runStartedAtMs > latestPlausibleStartMs) {
        throw noWaitObservationError('the no-wait run marker has an implausible future start');
    }

    const statusPath = noWaitRunScopedStatusPath(
        containerName,
        boundMarker.runId,
        runningDir ? { runningDir } : {},
    );
    const stateRoot = runningDir || pathApi.dirname(pathApi.dirname(statusPath));
    const status = readNoWaitJson(pathApi.basename(statusPath), {
        runningDir: stateRoot,
        fsApi,
        pathApi,
    });
    let classified;
    if (!status) {
        // A marker is published before spawn, so it cannot by itself prove
        // that a worker exists. Only a validated waiting-barrier status earns
        // the cumulative queued deadline.
        const deadline = boundMarker.runStartedAtMs + startupGraceMs;
        if (!Number.isSafeInteger(deadline)) {
            throw noWaitObservationError('the no-wait startup deadline overflowed its budget');
        }
        if (observationNowMs > deadline) {
            throw noWaitObservationError(
                `the no-wait run for '${containerName}' never published its status before the startup deadline`,
                { stale: true },
            );
        }
        classified = { state: 'pending', status: null, statusPath };
    } else {
        let statusIdentity;
        try {
            statusIdentity = exactNoWaitImmutableIdentity(status, { pathApi });
        } catch (error) {
            throw noWaitObservationError(`the run-scoped status has no complete immutable identity: ${error.message}`);
        }
        if (!sameNoWaitRun(statusIdentity, boundMarker)) {
            throw noWaitObservationError('the run-scoped status belongs to a different immutable identity');
        }
        let observation;
        try {
            observation = resolveRunScopedObservation(status, {
                expectedRunId: boundMarker.runId,
                runStartedAtMs: boundMarker.runStartedAtMs,
                targetWaveIndex: boundMarker.waveIndex,
                timeouts,
                nowMs: observationNowMs,
            });
        } catch (error) {
            throw noWaitObservationError(error?.message || String(error));
        }
        if (observation.terminal === 'failed') {
            classified = { state: 'failed', status, statusPath };
        } else if (observation.terminal === 'running') {
            classified = { state: 'running', status, statusPath };
        } else {
            const deadline = observation.queued
                ? noWaitQueuedStatusDeadline(boundMarker.runStartedAtMs, boundMarker.waveIndex, timeouts)
                : observation.deadline;
            if (!Number.isSafeInteger(deadline)) {
                throw noWaitObservationError('the no-wait status deadline overflowed its budget');
            }
            if (observationNowMs > deadline) {
                throw noWaitObservationError(
                    `the no-wait run for '${containerName}' passed its ${observation.queued ? 'queued' : 'active'} deadline`,
                    { stale: true },
                );
            }
            classified = {
                state: 'starting',
                queued: observation.queued === true,
                workerPid: observation.workerPid,
                status,
                statusPath,
            };
        }
    }

    if (classified.state === 'starting' && requireWorkerProcess) {
        // A live pid alone proves nothing: pid reuse can validate an unrelated
        // process, so the worker's own identity has to be proved.
        proveWorkerProcess({
            pid: classified.workerPid,
            executablePath: process.execPath,
            workerScriptPath: fileURLToPath(new URL('./noWaitWorker.js', import.meta.url)),
            runningDir: stateRoot,
            identity: {
                ...boundMarker,
            },
        });
    }

    const current = readNoWaitRunMarker(containerName, { runningDir: stateRoot, fsApi, pathApi });
    if (!current) {
        throw noWaitObservationError(
            `the no-wait run for '${containerName}' is no longer current`,
            { superseded: true },
        );
    }
    if (!sameNoWaitRun(current, boundMarker)) {
        throw noWaitObservationError(
            `a newer start superseded the observed no-wait run for '${containerName}'`,
            { superseded: true },
        );
    }

    const registry = readRegistrySnapshot();
    const record = registry?.[containerName];
    if (!record || record.type !== 'agent') {
        throw noWaitObservationError(`'${containerName}' is no longer an enabled agent`, { superseded: true });
    }
    const finalRecordIdentity = immutableIdentityFromRecord(containerName, record, boundMarker);
    if (!sameNoWaitRun(finalRecordIdentity, boundMarker)) {
        throw noWaitObservationError(
            `the runtime generation for '${containerName}' changed during observation`,
            { superseded: true },
        );
    }
    return Object.freeze({ ...classified, record });
}
