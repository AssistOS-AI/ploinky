import { spawnSync } from 'node:child_process';

import {
    containerExists,
    getRuntime,
    isContainerRunning,
} from './common.js';

export const TARGETED_DRAIN_TIMEOUT_MS = 35_000;
export const TARGETED_DRAIN_POLL_MS = 100;
export const TARGETED_DRAIN_ACKNOWLEDGEMENT = 'exit-zero-after-drain';

const SELECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;

function lifecycleError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function sleepSync(ms) {
    const wait = Math.max(0, Number(ms) || 0);
    if (!wait) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
}

function runtimeFailure(result) {
    if (result?.error) return result.error.message;
    return String(result?.stderr || '').trim() || `exit code ${result?.status}`;
}

function defaultSignal(runtime, name) {
    return spawnSync(runtime, ['kill', '--signal', 'SIGTERM', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function defaultInspect(runtime, name) {
    const result = spawnSync(runtime, ['inspect', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
        throw lifecycleError(
            `cannot inspect targeted container '${name}': ${runtimeFailure(result)}`,
            'TARGETED_DRAIN_INSPECT_FAILED',
        );
    }
    let parsed;
    try { parsed = JSON.parse(String(result.stdout || '')); } catch (error) {
        throw lifecycleError(
            `targeted container '${name}' inspection returned malformed JSON: ${error.message}`,
            'TARGETED_DRAIN_INSPECT_FAILED',
        );
    }
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!record || typeof record !== 'object') {
        throw lifecycleError(`targeted container '${name}' inspection returned no record`, 'TARGETED_DRAIN_INSPECT_FAILED');
    }
    return record;
}

function defaultRemove(runtime, name) {
    return spawnSync(runtime, ['rm', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function validateName(name) {
    const value = String(name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
        throw lifecycleError('targeted container name is invalid', 'TARGETED_DRAIN_INVALID');
    }
    return value;
}

function validateTimeout(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > TARGETED_DRAIN_TIMEOUT_MS) {
        throw lifecycleError(
            `targeted drain timeout must be an integer from 1 through ${TARGETED_DRAIN_TIMEOUT_MS}ms`,
            'TARGETED_DRAIN_INVALID',
        );
    }
    return value;
}

function validateAffectedSelectors(value) {
    if (!Array.isArray(value) || value.length < 1) {
        throw lifecycleError(
            'targeted drain requires at least one exact affected selector',
            'TARGETED_DRAIN_INVALID',
        );
    }
    const selectors = [...new Set(value.map((entry) => String(entry || '').trim()))];
    if (selectors.length !== value.length || selectors.some((entry) => !SELECTOR_ID.test(entry))) {
        throw lifecycleError(
            'targeted drain affected selectors must be unique exact canonical identifiers',
            'TARGETED_DRAIN_INVALID',
        );
    }
    return Object.freeze(selectors);
}

/**
 * The operator's acceptance of one refused drain names the exact immutable
 * container ID it accepts. Anything else is not an acceptance.
 */
export function normalizeAcceptedFailedDrain(value) {
    if (value === undefined || value === null) return null;
    const containerId = String(value?.containerId || '').trim();
    if (!value || typeof value !== 'object' || Array.isArray(value) || !CONTAINER_ID.test(containerId)) {
        throw lifecycleError(
            'an accepted failed drain must name the full 64-hex predecessor container ID',
            'TARGETED_DRAIN_INVALID',
        );
    }
    return Object.freeze({ containerId });
}

function terminationOf(inspection) {
    const state = inspection?.State || inspection?.state || {};
    const exitCode = Number(state.ExitCode ?? state.exitCode);
    const oomKilled = state.OOMKilled === true || state.oomKilled === true;
    const stateError = String(state.Error || state.error || '').trim();
    return {
        running: state.Running === true || state.running === true,
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
        oomKilled,
        stateError,
        // A targeted restart is not an ordinary process stop. Exit zero is the
        // application acknowledgement that its own drain/persistence contract
        // completed. Signal termination (including 143) is never an acknowledgement.
        clean: !oomKilled && !stateError && exitCode === 0,
    };
}

function describeTermination(termination) {
    return `exit=${termination.exitCode ?? 'unknown'}${termination.oomKilled ? ', oom-killed' : ''}${termination.stateError ? `, error=${termination.stateError}` : ''}`;
}

function assertCleanTermination(name, inspection) {
    const termination = terminationOf(inspection);
    if (!termination.clean) {
        throw lifecycleError(
            `targeted drain for '${name}' did not exit cleanly (${describeTermination(termination)}); refusing removal or recreate`,
            'TARGETED_DRAIN_FAILED',
            { exitCode: termination.exitCode, oomKilled: termination.oomKilled },
        );
    }
    return termination.exitCode;
}

function acceptanceRefused(message) {
    return lifecycleError(message, 'TARGETED_DRAIN_ACCEPTANCE_REFUSED');
}

// The operator accepts the recorded outcome of an earlier refused drain. It
// never applies to a running container and never signals anything: the exact
// predecessor must already be stopped and must be the container the operator
// named, so a different or newer runtime can never be accepted by mistake.
function acceptStoppedPredecessor(name, inspection, accepted, selectors) {
    const inspectedId = String(inspection?.Id || inspection?.id || '').trim();
    if (inspectedId !== accepted.containerId) {
        throw acceptanceRefused(
            `targeted container '${name}' is ${inspectedId || 'an unidentified container'}, not the accepted predecessor ${accepted.containerId}; refusing removal or recreate`,
        );
    }
    const termination = terminationOf(inspection);
    if (termination.running) {
        throw acceptanceRefused(
            `targeted container '${name}' is running; an accepted failed drain applies only to an already-stopped predecessor`,
        );
    }
    if (termination.clean) {
        return Object.freeze({ state: 'already-stopped', containerName: name, exitCode: termination.exitCode, affectedSelectors: selectors });
    }
    return Object.freeze({
        state: 'accepted-failed-drain',
        containerName: name,
        containerId: inspectedId,
        exitCode: termination.exitCode,
        oomKilled: termination.oomKilled,
        ...(termination.stateError ? { stateError: termination.stateError } : {}),
        affectedSelectors: selectors,
    });
}

export function drainTargetedContainer(name, {
    reason = 'targeted-container-recreate',
    acknowledgement,
    acceptedFailedDrain = null,
    affectedSelectors,
    assertSelectorsInactive,
    timeoutMs = TARGETED_DRAIN_TIMEOUT_MS,
    pollMs = TARGETED_DRAIN_POLL_MS,
    runtime = getRuntime(),
    exists = containerExists,
    isRunning = isContainerRunning,
    signal = defaultSignal,
    retireControlSocket = () => {},
    inspect = defaultInspect,
    now = () => Date.now(),
    sleep = sleepSync,
} = {}) {
    const containerName = validateName(name);
    const boundedTimeout = validateTimeout(timeoutMs);
    const boundedPoll = Math.max(1, Math.min(Number(pollMs) || TARGETED_DRAIN_POLL_MS, boundedTimeout));
    if (acknowledgement !== TARGETED_DRAIN_ACKNOWLEDGEMENT) {
        throw lifecycleError(
            `targeted drain requires acknowledgement '${TARGETED_DRAIN_ACKNOWLEDGEMENT}'`,
            'TARGETED_DRAIN_INVALID',
        );
    }
    const accepted = normalizeAcceptedFailedDrain(acceptedFailedDrain);
    const selectors = validateAffectedSelectors(affectedSelectors);
    if (typeof assertSelectorsInactive !== 'function') {
        throw lifecycleError(
            'targeted drain requires an affected-selector inactivity assertion',
            'TARGETED_DRAIN_INVALID',
        );
    }

    // The coordinated apply owns selector mutation. This primitive only accepts
    // an exact affected-selector proof and never globally changes routing as a
    // side effect of an ordinary container lifecycle operation.
    let inactive = false;
    try {
        inactive = assertSelectorsInactive(Object.freeze({
            affectedSelectors: selectors,
            containerName,
            reason: String(reason || 'targeted-container-recreate'),
        })) === true;
    } catch (error) {
        throw lifecycleError(
            `cannot prove affected selectors inactive for targeted drain of '${containerName}': ${error?.message || error}`,
            'TARGETED_SELECTOR_ACTIVE',
        );
    }
    if (!inactive) {
        throw lifecycleError(
            `affected selectors remain active for targeted drain of '${containerName}'`,
            'TARGETED_SELECTOR_ACTIVE',
        );
    }
    // An absent predecessor has nothing left to drain or acknowledge. Callers
    // that remove runtimes must therefore refuse a draining route first.
    if (!exists(containerName)) {
        return Object.freeze({ state: 'absent', containerName, affectedSelectors: selectors });
    }
    if (!isRunning(containerName)) {
        const inspection = inspect(runtime, containerName);
        if (accepted) return acceptStoppedPredecessor(containerName, inspection, accepted, selectors);
        const exitCode = assertCleanTermination(containerName, inspection);
        return Object.freeze({ state: 'already-stopped', containerName, exitCode, affectedSelectors: selectors });
    }
    if (accepted) {
        throw acceptanceRefused(
            `targeted container '${containerName}' is running; an accepted failed drain applies only to an already-stopped predecessor; refusing SIGTERM, SIGKILL, removal, or recreate`,
        );
    }

    retireControlSocket(containerName);
    const signaled = signal(runtime, containerName);
    if (signaled?.error || signaled?.status !== 0) {
        throw lifecycleError(
            `cannot send SIGTERM to targeted container '${containerName}': ${runtimeFailure(signaled)}; selector remains inactive`,
            'TARGETED_DRAIN_SIGNAL_FAILED',
        );
    }

    const deadline = now() + boundedTimeout;
    while (isRunning(containerName) && now() < deadline) sleep(Math.min(boundedPoll, Math.max(1, deadline - now())));
    if (isRunning(containerName)) {
        throw lifecycleError(
            `targeted drain for '${containerName}' exceeded ${boundedTimeout}ms and the container remains running; refusing SIGKILL, removal, recreate, or selector activation`,
            'TARGETED_DRAIN_TIMEOUT',
            { timeoutMs: boundedTimeout },
        );
    }

    const exitCode = assertCleanTermination(containerName, inspect(runtime, containerName));
    return Object.freeze({ state: 'drained', containerName, exitCode, affectedSelectors: selectors });
}

export function drainAndRemoveTargetedContainer(name, options = {}) {
    const containerName = validateName(name);
    const runtime = options.runtime || getRuntime();
    const exists = options.exists || containerExists;
    const result = drainTargetedContainer(containerName, { ...options, runtime, exists });
    if (result.state === 'absent') return Object.freeze({ ...result, removed: false });

    const remove = options.remove || defaultRemove;
    const removed = remove(runtime, containerName);
    if (removed?.error || removed?.status !== 0) {
        throw lifecycleError(
            `targeted container '${containerName}' drained but could not be removed without force: ${runtimeFailure(removed)}; selector remains inactive`,
            'TARGETED_REMOVE_FAILED',
        );
    }
    if (exists(containerName)) {
        throw lifecycleError(
            `targeted container '${containerName}' still exists after non-forced removal; refusing recreate`,
            'TARGETED_REMOVE_FAILED',
        );
    }
    return Object.freeze({ ...result, removed: true });
}

export default drainAndRemoveTargetedContainer;
