// Pure no-wait publication and observation protocol.
//
// Both the mutating worker and the observational log reader depend on these
// rules. Keep this module free of filesystem, runtime, registry, routing, and
// lifecycle imports so reading logs cannot load mutation-capable code merely
// to classify one status document.

import {
    MAX_NO_WAIT_WAVE_INDEX,
    exactEpochMs,
    exactRunId,
    exactWaveIndex,
} from './noWaitIdentity.js';

export { MAX_NO_WAIT_WAVE_INDEX } from './noWaitIdentity.js';

const DEFAULT_IMAGE_OPERATION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_IMAGE_OPERATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SANCTIONED_IMAGE_PULLS_PER_LAUNCH = 3;
const SANCTIONED_IMAGE_BUILDS_PER_LAUNCH = 1;

export const NO_WAIT_STATUS_STATES = Object.freeze(['starting', 'running', 'failed']);
export const NO_WAIT_SEQUENCE_PHASES = Object.freeze(['waiting-barrier', 'active']);

export function boundedNoWaitTimeoutInput(value, { fallback, minimum, maximum }) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isSafeInteger(parsed)
        ? Math.min(Math.max(minimum, parsed), maximum)
        : fallback;
}

function defaultImageOperationTimeout(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0
        ? Math.min(parsed, MAX_IMAGE_OPERATION_TIMEOUT_MS)
        : DEFAULT_IMAGE_OPERATION_TIMEOUT_MS;
}

// The active phase includes every sanctioned image operation. The environment
// defaults intentionally match docker/common.js without importing its runtime
// and workspace lifecycle graph.
export function resolveNoWaitBarrierTimeouts({
    activeTimeoutMs = process.env.PLOINKY_NO_WAIT_SEQUENCE_TIMEOUT_MS,
    terminalPublicationGraceMs = process.env.PLOINKY_NO_WAIT_SEQUENCE_TERMINAL_GRACE_MS,
    readRetryTimeoutMs = process.env.PLOINKY_NO_WAIT_STATUS_READ_RETRY_MS,
    startupGraceMs = process.env.PLOINKY_NO_WAIT_STARTUP_GRACE_MS,
    imagePullBudgetMs = defaultImageOperationTimeout(process.env.PLOINKY_IMAGE_PULL_TIMEOUT_MS),
    imageBuildBudgetMs = defaultImageOperationTimeout(process.env.PLOINKY_IMAGE_BUILD_TIMEOUT_MS),
} = {}) {
    const boundedPhaseTimeoutMs = boundedNoWaitTimeoutInput(activeTimeoutMs, {
        fallback: 900000, minimum: 1000, maximum: 3600000,
    });
    const boundedPullBudgetMs = boundedNoWaitTimeoutInput(imagePullBudgetMs, {
        fallback: DEFAULT_IMAGE_OPERATION_TIMEOUT_MS,
        minimum: 0,
        maximum: MAX_IMAGE_OPERATION_TIMEOUT_MS,
    });
    const boundedBuildBudgetMs = boundedNoWaitTimeoutInput(imageBuildBudgetMs, {
        fallback: DEFAULT_IMAGE_OPERATION_TIMEOUT_MS,
        minimum: 0,
        maximum: MAX_IMAGE_OPERATION_TIMEOUT_MS,
    });
    const sanctionedPullBudgetMs = boundedPullBudgetMs * SANCTIONED_IMAGE_PULLS_PER_LAUNCH;
    const sanctionedBuildBudgetMs = boundedBuildBudgetMs * SANCTIONED_IMAGE_BUILDS_PER_LAUNCH;
    return Object.freeze({
        phaseTimeoutMs: boundedPhaseTimeoutMs,
        imagePullBudgetMs: boundedPullBudgetMs,
        imageBuildBudgetMs: boundedBuildBudgetMs,
        sanctionedPullBudgetMs,
        sanctionedBuildBudgetMs,
        activeTimeoutMs: boundedPhaseTimeoutMs + sanctionedPullBudgetMs + sanctionedBuildBudgetMs,
        terminalPublicationGraceMs: boundedNoWaitTimeoutInput(terminalPublicationGraceMs, {
            fallback: 60000, minimum: 0, maximum: 300000,
        }),
        readRetryTimeoutMs: boundedNoWaitTimeoutInput(readRetryTimeoutMs, {
            fallback: 5000, minimum: 100, maximum: 30000,
        }),
        startupGraceMs: boundedNoWaitTimeoutInput(startupGraceMs, {
            fallback: 60000, minimum: 0, maximum: 300000,
        }),
    });
}

export function noWaitQueuedStatusDeadline(runStartedAtMs, targetWaveIndex, timeouts) {
    const exactRunStartedAtMs = exactEpochMs(runStartedAtMs, 'no-wait run start');
    const waveIndex = exactWaveIndex(targetWaveIndex, 'no-wait barrier target wave index');
    const perWaveMs = timeouts.activeTimeoutMs + timeouts.terminalPublicationGraceMs;
    const deadline = exactRunStartedAtMs
        + ((waveIndex + 1) * perWaveMs)
        + timeouts.startupGraceMs;
    if (!Number.isSafeInteger(deadline)) {
        throw new Error('no-wait queued status deadline overflowed its cumulative wave budget');
    }
    return deadline;
}

function publishedInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseSequenceTimestamp(status, numericField, isoField) {
    if (status?.[numericField] !== undefined) {
        return publishedInteger(status[numericField]) ?? NaN;
    }
    const iso = status?.[isoField];
    if (typeof iso !== 'string' || !iso.trim()) return NaN;
    const parsed = Date.parse(iso);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : NaN;
}

export function resolveRunScopedObservation(status, {
    expectedRunId,
    runStartedAtMs,
    targetWaveIndex,
    timeouts,
    nowMs,
} = {}) {
    if (!status || typeof status !== 'object' || Array.isArray(status)) {
        throw new Error('no-wait barrier status must be one JSON object');
    }
    if (String(status.runId || '').trim().toLowerCase() !== exactRunId(expectedRunId)) {
        throw new Error('no-wait barrier status belongs to a different run');
    }
    if (publishedInteger(status.runStartedAtMs) !== exactEpochMs(runStartedAtMs, 'no-wait run start')) {
        throw new Error('no-wait barrier status belongs to a different run start');
    }
    if (publishedInteger(status.waveIndex)
        !== exactWaveIndex(targetWaveIndex, 'no-wait barrier target wave index')) {
        throw new Error('no-wait barrier status belongs to a different dependency wave');
    }
    const state = String(status.state || '');
    if (!NO_WAIT_STATUS_STATES.includes(state)) {
        throw new Error('no-wait barrier status has invalid state');
    }
    const sequencePhase = String(status.sequencePhase || '');
    if (!NO_WAIT_SEQUENCE_PHASES.includes(sequencePhase)) {
        throw new Error('no-wait barrier status has invalid sequence phase');
    }
    if (state === 'failed') return { terminal: 'failed' };
    if (state === 'running') {
        if (sequencePhase !== 'active') {
            throw new Error("no-wait barrier status reports 'running' outside its active phase");
        }
        return { terminal: 'running' };
    }
    if (sequencePhase === 'active') {
        const phaseStartedAtMs = parseSequenceTimestamp(
            status,
            'sequencePhaseStartedAtMs',
            'sequencePhaseStartedAt',
        );
        if (!Number.isFinite(phaseStartedAtMs)
            || phaseStartedAtMs > nowMs + timeouts.terminalPublicationGraceMs) {
            throw new Error('no-wait barrier active phase has an invalid start timestamp');
        }
        const deadline = phaseStartedAtMs
            + timeouts.activeTimeoutMs
            + timeouts.terminalPublicationGraceMs;
        if (!Number.isSafeInteger(deadline)) {
            throw new Error('no-wait barrier active phase deadline overflowed its budget');
        }
        return { deadline, workerPid: publishedInteger(status.pid) };
    }
    return { queued: true, workerPid: publishedInteger(status.pid) };
}
