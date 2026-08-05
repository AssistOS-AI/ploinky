import { spawnSync } from 'node:child_process';

import {
    containerExists,
    isContainerRunning,
} from './common.js';
import {
    inspectExactPodmanRuntimeIdentity,
    requireExactPodmanRuntimeIdentity,
} from './exactPodmanRuntime.js';

export const TARGETED_DRAIN_TIMEOUT_MS = 35_000;
export const TARGETED_DRAIN_POLL_MS = 100;
export const TARGETED_DRAIN_ACKNOWLEDGEMENT = 'exit-zero-after-drain';

const SELECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

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

function assertCleanTermination(name, inspection) {
    const state = inspection?.State || inspection?.state || {};
    const exitCode = Number(state.ExitCode ?? state.exitCode);
    const oomKilled = state.OOMKilled === true || state.oomKilled === true;
    const stateError = String(state.Error || state.error || '').trim();
    // A targeted restart is not an ordinary process stop. Exit zero is the
    // application acknowledgement that its own drain/persistence contract
    // completed. Signal termination (including 143) is never an acknowledgement.
    if (oomKilled || stateError || exitCode !== 0) {
        throw lifecycleError(
            `targeted drain for '${name}' did not exit cleanly (exit=${Number.isFinite(exitCode) ? exitCode : 'unknown'}${oomKilled ? ', oom-killed' : ''}${stateError ? `, error=${stateError}` : ''}); refusing removal or recreate`,
            'TARGETED_DRAIN_FAILED',
            { exitCode: Number.isFinite(exitCode) ? exitCode : null, oomKilled },
        );
    }
    return exitCode;
}

export function drainTargetedContainer(name, {
    reason = 'targeted-container-recreate',
    acknowledgement,
    affectedSelectors,
    assertSelectorsInactive,
    timeoutMs = TARGETED_DRAIN_TIMEOUT_MS,
    pollMs = TARGETED_DRAIN_POLL_MS,
    runtime,
    containerId,
    runtimeIdentity,
    exists = containerExists,
    isRunning = isContainerRunning,
    signal = defaultSignal,
    inspect = defaultInspect,
    inspectRuntimeIdentity = inspectExactPodmanRuntimeIdentity,
    now = () => Date.now(),
    sleep = sleepSync,
} = {}) {
    const containerName = validateName(name);
    const identity = requireExactPodmanRuntimeIdentity({
        runtime,
        containerName,
        containerId,
        instanceId: runtimeIdentity?.instanceId,
        enableGeneration: runtimeIdentity?.enableGeneration,
    });
    const boundedTimeout = validateTimeout(timeoutMs);
    const boundedPoll = Math.max(1, Math.min(Number(pollMs) || TARGETED_DRAIN_POLL_MS, boundedTimeout));
    if (acknowledgement !== TARGETED_DRAIN_ACKNOWLEDGEMENT) {
        throw lifecycleError(
            `targeted drain requires acknowledgement '${TARGETED_DRAIN_ACKNOWLEDGEMENT}'`,
            'TARGETED_DRAIN_INVALID',
        );
    }
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
    if (!exists(identity.containerId, { runtime: 'podman' })) {
        return Object.freeze({ state: 'absent', containerName, affectedSelectors: selectors });
    }
    inspectRuntimeIdentity(identity);
    if (!isRunning(identity.containerId, { runtime: 'podman' })) {
        const exitCode = assertCleanTermination(containerName, inspect('podman', identity.containerId));
        return Object.freeze({ state: 'already-stopped', containerName, exitCode, affectedSelectors: selectors });
    }

    const signaled = signal('podman', identity.containerId);
    if (signaled?.error || signaled?.status !== 0) {
        throw lifecycleError(
            `cannot send SIGTERM to targeted container '${containerName}': ${runtimeFailure(signaled)}; selector remains inactive`,
            'TARGETED_DRAIN_SIGNAL_FAILED',
        );
    }

    const deadline = now() + boundedTimeout;
    while (isRunning(identity.containerId, { runtime: 'podman' }) && now() < deadline) sleep(Math.min(boundedPoll, Math.max(1, deadline - now())));
    if (isRunning(identity.containerId, { runtime: 'podman' })) {
        throw lifecycleError(
            `targeted drain for '${containerName}' exceeded ${boundedTimeout}ms and the container remains running; refusing SIGKILL, removal, recreate, or selector activation`,
            'TARGETED_DRAIN_TIMEOUT',
            { timeoutMs: boundedTimeout },
        );
    }

    const exitCode = assertCleanTermination(containerName, inspect('podman', identity.containerId));
    return Object.freeze({ state: 'drained', containerName, exitCode, affectedSelectors: selectors });
}

export function drainAndRemoveTargetedContainer(name, options = {}) {
    const containerName = validateName(name);
    const identity = requireExactPodmanRuntimeIdentity({
        runtime: options.runtime,
        containerName,
        containerId: options.containerId,
        instanceId: options.runtimeIdentity?.instanceId,
        enableGeneration: options.runtimeIdentity?.enableGeneration,
    });
    const exists = options.exists || containerExists;
    const result = drainTargetedContainer(containerName, { ...options, ...identity, exists });
    if (result.state === 'absent') return Object.freeze({ ...result, removed: false });

    const remove = options.remove || defaultRemove;
    const removed = remove('podman', identity.containerId);
    if (removed?.error || removed?.status !== 0) {
        throw lifecycleError(
            `targeted container '${containerName}' drained but could not be removed without force: ${runtimeFailure(removed)}; selector remains inactive`,
            'TARGETED_REMOVE_FAILED',
        );
    }
    if (exists(identity.containerId, { runtime: 'podman' })) {
        throw lifecycleError(
            `targeted container '${containerName}' still exists after non-forced removal; refusing recreate`,
            'TARGETED_REMOVE_FAILED',
        );
    }
    return Object.freeze({ ...result, removed: true });
}

export default drainAndRemoveTargetedContainer;
