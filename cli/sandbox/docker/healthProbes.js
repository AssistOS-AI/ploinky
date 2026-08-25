import { spawnSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import { parentPort } from 'worker_threads';
import {
    getRuntime,
    isContainerRunning,
    waitForContainerRunning,
    sleepMs
} from './common.js';

const DEFAULT_INTERVAL_SECONDS = 1;
const DEFAULT_TIMEOUT_SECONDS = 5;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_SUCCESS_THRESHOLD = 1;
const DEFAULT_PROBE_KILL_GRACE_SECONDS = 1;
const PROBE_CONTROL_PLANE_GRACE_MS = 15_000;
const PROBE_CONTROL_PLANE_TIMEOUT_MS = 5_000;
const PROBE_CONTAINER_WAIT_TIMEOUT_MS = 10_000;
const PROBE_CLEANUP_TIMEOUT_MS = 5_000;
const PROBE_RUNNER_PATH = '/Agent/server/HealthProbeRunner.sh';
const PROBE_MARKER_PREFIX = '/tmp/.ploinky-health-probe-';
const BACKOFF_BASE_DELAY_MS = 10_000;
const BACKOFF_MAX_DELAY_MS = 300_000;
const BACKOFF_RESET_MS = 600_000;
const LIVENESS_BACKOFF_STATE = new Map();

function postProbeLog(level, message) {
    const payload = {
        type: 'log',
        level: level || 'info',
        message
    };
    if(parentPort){
        parentPort.postMessage(payload);
    }
}

function probeControlPlaneFailure(agentName, action, error) {
    const detail = String(error?.message || error || 'unknown runtime failure').trim();
    const failure = new Error(`[probe] ${agentName}: unable to ${action}: ${detail}`);
    failure.code = error?.code === 'ETIMEDOUT'
        || error?.code === 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT'
        ? 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT'
        : 'PLOINKY_PROBE_CONTROL_PLANE_FAILED';
    return failure;
}

function coercePositiveNumber(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return num;
}

function coercePositiveInteger(value, fallback) {
    const num = Math.floor(Number(value));
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return num;
}

function validateScriptName(type, script) {
    const trimmed = (script || '').trim();
    if (!trimmed) return null;
    if (trimmed.includes('/') || trimmed.includes('\\')) {
        throw new Error(`[probe] ${type}: script '${trimmed}' must live in the agent root (./).`);
    }
    if (trimmed.includes('..')) {
        throw new Error(`[probe] ${type}: script '${trimmed}' cannot navigate directories.`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
        throw new Error(`[probe] ${type}: script '${trimmed}' contains unsafe characters.`);
    }
    return trimmed;
}

function normalizeProbeConfig(type, manifestProbeConfig = null) {
    if (!manifestProbeConfig || typeof manifestProbeConfig !== 'object') return null;
    const script = validateScriptName(type, manifestProbeConfig.script);
    if (!script) return null;
    return {
        script,
        interval: coercePositiveNumber(manifestProbeConfig.interval, DEFAULT_INTERVAL_SECONDS),
        timeout: coercePositiveNumber(manifestProbeConfig.timeout, DEFAULT_TIMEOUT_SECONDS),
        failureThreshold: coercePositiveInteger(manifestProbeConfig.failureThreshold, DEFAULT_FAILURE_THRESHOLD),
        successThreshold: coercePositiveInteger(manifestProbeConfig.successThreshold, DEFAULT_SUCCESS_THRESHOLD),
        continuous: manifestProbeConfig.continuous !== false,
    };
}

function probeToken(options = {}) {
    const createToken = options.tokenFactory || randomUUID;
    const token = String(createToken()).trim();
    if (!/^[A-Za-z0-9._-]+$/.test(token)) {
        throw new Error('[probe] generated probe token is invalid');
    }
    return token;
}

function cleanupExactProbe(agentName, containerName, markerPath, token, options = {}) {
    const runtime = options.runtime || getRuntime();
    const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    const cleanupRes = spawnSyncImpl(
        runtime,
        [
            'exec',
            containerName,
            'sh',
            PROBE_RUNNER_PATH,
            'cleanup',
            markerPath,
            token,
        ],
        {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: options.cleanupTimeoutMs || PROBE_CLEANUP_TIMEOUT_MS,
            killSignal: 'SIGKILL',
        },
    );
    if (cleanupRes.error || cleanupRes.status !== 0) {
        const detail = String(
            cleanupRes.error?.message
            || cleanupRes.stderr
            || cleanupRes.stdout
            || `exit ${cleanupRes.status ?? 'unknown'}`,
        ).trim();
        const error = new Error(
            `[probe] ${agentName}: exact probe cleanup failed for '${containerName}': ${detail}`,
        );
        error.code = cleanupRes.error?.code === 'ETIMEDOUT'
            ? 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT'
            : 'PLOINKY_PROBE_CLEANUP_FAILED';
        throw error;
    }
}

function asProbeControlPlaneError(agentName, operation, sourceError) {
    if (String(sourceError?.code || '').startsWith('PLOINKY_PROBE_CONTROL_PLANE_')) {
        return sourceError;
    }
    const error = new Error(
        `[probe] ${agentName}: ${operation}: ${sourceError?.message || sourceError}`,
    );
    error.code = sourceError?.code === 'ETIMEDOUT'
        || sourceError?.code === 'PLOINKY_CONTAINER_CONTROL_PLANE_TIMEOUT'
        ? 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT'
        : 'PLOINKY_PROBE_CONTROL_PLANE_FAILED';
    return error;
}

function runProbeOnce(agentName, containerName, probe, options = {}) {
    const runtime = options.runtime || getRuntime();
    const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    const token = probeToken(options);
    const markerPath = `${PROBE_MARKER_PREFIX}${token}`;
    const killGraceSeconds = coercePositiveNumber(
        options.killGraceSeconds,
        DEFAULT_PROBE_KILL_GRACE_SECONDS,
    );
    const execCommand = [
        'exec',
        containerName,
        'sh',
        PROBE_RUNNER_PATH,
        'run',
        markerPath,
        token,
        probe.script,
        String(probe.timeout),
        String(killGraceSeconds),
    ];
    const execRes = spawnSyncImpl(
        runtime,
        execCommand,
        {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: Math.ceil(probe.timeout * 1000) + PROBE_CONTROL_PLANE_GRACE_MS,
            killSignal: 'SIGKILL',
        },
    );
    const stdout = (execRes.stdout || '').trim();
    const stderr = (execRes.stderr || '').trim();
    const outerTimedOut = Boolean(execRes.error && execRes.error.code === 'ETIMEDOUT');
    const outerCompletionUncertain = Boolean(execRes.error)
        || typeof execRes.status !== 'number';
    if (outerCompletionUncertain) {
        cleanupExactProbe(agentName, containerName, markerPath, token, options);
    }
    if (outerTimedOut) {
        const error = new Error(
            `[probe] ${agentName}: runtime control plane timed out while running '${probe.script}'`,
        );
        error.code = 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT';
        throw error;
    }
    if (execRes.error && !outerTimedOut) {
        throw new Error(`[probe] ${agentName}: failed to run '${probe.script}': ${execRes.error.message || execRes.error}`);
    }
    if (execRes.status === 125) {
        cleanupExactProbe(agentName, containerName, markerPath, token, options);
        const detail = String(stderr || stdout || 'runner exited 125').trim();
        const error = new Error(
            `[probe] ${agentName}: exact cleanup was not proved for '${probe.script}': ${detail}`,
        );
        error.code = 'PLOINKY_PROBE_EXECUTION_UNSAFE';
        throw error;
    }
    const timedOut = execRes.status === 124;
    const exitCode = typeof execRes.status === 'number'
        ? execRes.status
        : (timedOut ? 124 : 125);

    return {
        success: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        stdout,
        stderr
    };
}

function ensureScriptExists(agentName, containerName, probe, options = {}) {
    const runtime = options.runtime || getRuntime();
    const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    const scriptPath = `/code/${probe.script}`;
    const exists = spawnSyncImpl(
        runtime,
        ['exec', containerName, 'sh', '-lc', `[ -f "${scriptPath}" ]`],
        {
            stdio: 'ignore',
            timeout: options.controlPlaneTimeoutMs || PROBE_CONTROL_PLANE_TIMEOUT_MS,
            killSignal: 'SIGKILL',
        },
    );

    if (exists.error) {
        const error = new Error(
            `[probe] ${agentName}: unable to inspect ${probe.script}: ${exists.error.message || exists.error}`,
        );
        error.code = exists.error.code === 'ETIMEDOUT'
            ? 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT'
            : 'PLOINKY_PROBE_CONTROL_PLANE_FAILED';
        throw error;
    }

    if (exists.status !== 0) {
        throw new Error(`[probe] ${agentName}: ${probe.script} not found inside container.`);
    }
}

function runProbeLoop(agentName, containerName, type, probe, options = {}) {
    ensureScriptExists(agentName, containerName, probe, options);
    postProbeLog('info', `[probe] ${agentName}: ${type} probe -> script='${probe.script}', interval=${probe.interval}s, timeout=${probe.timeout}s, successThreshold=${probe.successThreshold}, failureThreshold=${probe.failureThreshold}, continuous=${probe.continuous}`);
    let consecutiveSuccesses = 0;
    let consecutiveFailures = 0;
    while (true) {
        const isContainerRunningImpl = options.isContainerRunningImpl || isContainerRunning;
        let running;
        try {
            running = isContainerRunningImpl(containerName, {
                timeoutMs: options.controlPlaneTimeoutMs || PROBE_CONTROL_PLANE_TIMEOUT_MS,
                runtime: options.runtime,
                spawnSyncImpl: options.spawnSyncImpl,
                throwOnError: true,
            });
        } catch (error) {
            throw probeControlPlaneFailure(agentName, 'inspect container running state', error);
        }
        if (!running) {
            return {
                status: 'failed',
                reason: 'container exited',
                detail: '',
            };
        }
        const result = runProbeOnce(agentName, containerName, probe, options);

        const detail = (result.stdout || result.stderr || '').trim();
        if (result.success) {
            consecutiveSuccesses += 1;
            consecutiveFailures = 0;
            if (consecutiveSuccesses >= probe.successThreshold) {
                return { status: 'success', detail };
            }
        } else {
            consecutiveFailures += 1;
            consecutiveSuccesses = 0;
            if (consecutiveFailures >= probe.failureThreshold) {
                const reason = result.timedOut ? 'timeout' : `exit ${result.exitCode}`;
                return { status: 'failed', reason, detail };
            }
        }

        const intervalMs = Math.max(0, Math.round(probe.interval * 1000));
        if (intervalMs > 0) {
            const sleepMsImpl = options.sleepMsImpl || sleepMs;
            sleepMsImpl(intervalMs);
        }
    }
}

function runContainerScriptReadiness(agentName, containerName, manifestProbeConfig, options = {}) {
    const probe = normalizeProbeConfig('readiness', manifestProbeConfig);
    if (!probe) {
        throw new Error(`[probe] ${agentName}: blocking script readiness requires health.readiness.script.`);
    }
    if (!String(containerName || '').trim()) {
        throw new Error(`[probe] ${agentName}: blocking script readiness requires the service container name.`);
    }
    return runProbeLoop(agentName, containerName, 'readiness', probe, options);
}

function getLivenessState(containerName) {
    let state = LIVENESS_BACKOFF_STATE.get(containerName);
    if (!state) {
        state = { retryCount: 0, startedAt: null };
        LIVENESS_BACKOFF_STATE.set(containerName, state);
    }
    return state;
}

function noteContainerStarted(containerName) {
    if (!containerName) return;
    const state = getLivenessState(containerName);
    state.startedAt = Date.now();
}

function maybeResetBackoff(agentName, state) {
    if (!state || !state.startedAt || state.retryCount === 0) return;
    const uptimeMs = Date.now() - state.startedAt;
    if (uptimeMs >= BACKOFF_RESET_MS) {
        state.retryCount = 0;
        postProbeLog('info', `[probe] ${agentName}: liveness backoff reset after ${Math.round(uptimeMs / 1000)}s of stable runtime.`);
    }
}

function computeBackoffDelay(state) {
    if (!state) return BACKOFF_BASE_DELAY_MS;
    const exponent = Math.max(0, state.retryCount);
    const delay = BACKOFF_BASE_DELAY_MS * (2 ** exponent);
    return Math.min(delay, BACKOFF_MAX_DELAY_MS);
}

export function clearLivenessState(containerName) {
    LIVENESS_BACKOFF_STATE.delete(containerName);
}

function ensureLiveness(agentName, containerName, probe, options = {}) {
    if (!probe) {
        postProbeLog('info', `[probe] ${agentName}: no liveness probe declared. Assuming live.`);
        clearLivenessState(containerName);
        return;
    }

    const state = getLivenessState(containerName);
    if (!state.startedAt) {
        state.startedAt = Date.now();
    }

    const result = runProbeLoop(agentName, containerName, 'liveness', probe, options);
    if (result.status === 'success') {
        postProbeLog('info', `[probe] ${agentName}: liveness confirmed.`);
        clearLivenessState(containerName);
        return;
    }

    maybeResetBackoff(agentName, state);
    state.retryCount += 1;
    const detail = `${result.reason}${result.detail ? `, output='${result.detail}'` : ''}`;
    const error = new Error(`[probe] ${agentName}: liveness probe failed (${detail}); managed restart required`);
    error.code = 'PLOINKY_LIVENESS_FAILED';
    throw error;
}

function ensureReadiness(agentName, containerName, probe, options = {}) {
    if (!probe) {
        postProbeLog('info', `[probe] ${agentName}: no readiness probe declared. Assuming ready.`);
        return;
    }

    const result = runProbeLoop(agentName, containerName, 'readiness', probe, options);
    if (result.status === 'success') {
        postProbeLog('info', `[probe] ${agentName}: readiness confirmed.`);
        return;
    }

    const detail = `${result.reason}${result.detail ? `, output='${result.detail}'` : ''}`;
    const error = new Error(
        `[probe] ${agentName}: readiness probe failed (${detail}); managed restart required`,
    );
    error.code = 'PLOINKY_READINESS_FAILED';
    throw error;
}

export function runHealthProbes(agentName, containerName, manifest = {}, options = {}) {
    const waitForRunning = options.waitForContainerRunningImpl || waitForContainerRunning;
    let running;
    try {
        running = waitForRunning(containerName, 40, 250, {
            timeoutMs: options.controlPlaneTimeoutMs || PROBE_CONTROL_PLANE_TIMEOUT_MS,
            totalTimeoutMs: options.containerWaitTimeoutMs || PROBE_CONTAINER_WAIT_TIMEOUT_MS,
            runtime: options.runtime,
            spawnSyncImpl: options.spawnSyncImpl,
            sleepMsImpl: options.sleepMsImpl,
            throwOnControlPlaneTimeout: true,
        });
    } catch (error) {
        throw probeControlPlaneFailure(agentName, 'inspect container startup state', error);
    }
    if (!running) {
        throw new Error(`[probe] ${agentName}: failed to start; container is not running.`);
    }

    const healthConfig = manifest?.health || {};
    const livenessProbe = normalizeProbeConfig('liveness', healthConfig.liveness);
    const configuredReadinessProbe = normalizeProbeConfig('readiness', healthConfig.readiness);
    const readinessProbe = configuredReadinessProbe?.continuous === false
        ? null
        : configuredReadinessProbe;
    if (configuredReadinessProbe?.continuous === false && !livenessProbe) {
        const error = new Error(
            `[probe] ${agentName}: activation-only readiness requires a recurring health.liveness.script.`,
        );
        error.code = 'PLOINKY_CONTINUOUS_PROBE_REQUIRED';
        throw error;
    }

    if (livenessProbe) {
        noteContainerStarted(containerName);
    } else {
        clearLivenessState(containerName);
    }

    if (!livenessProbe && !readinessProbe) {
        postProbeLog('info', `[probe] ${agentName}: no health probes defined. Assuming live & ready.`);
        return;
    }

    ensureLiveness(agentName, containerName, livenessProbe, options);
    if (!readinessProbe && configuredReadinessProbe) {
        postProbeLog('info', `[probe] ${agentName}: readiness is activation-only (continuous=false); recurring cycle relies on liveness.`);
        return;
    }
    ensureReadiness(agentName, containerName, readinessProbe, options);
}

export { normalizeProbeConfig, runContainerScriptReadiness };

export const __testHooks = {
    coercePositiveNumber,
    coercePositiveInteger,
    validateScriptName,
    normalizeProbeConfig,
    runProbeOnce,
    runContainerScriptReadiness,
    probeControlPlaneFailure,
    cleanupExactProbe,
    asProbeControlPlaneError,
    probeToken,
    computeBackoffDelay,
    maybeResetBackoff,
    getLivenessState,
    noteContainerStarted,
    LIVENESS_BACKOFF_STATE
};

export const __testConstants = {
    DEFAULT_INTERVAL_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_FAILURE_THRESHOLD,
    DEFAULT_SUCCESS_THRESHOLD,
    DEFAULT_PROBE_KILL_GRACE_SECONDS,
    PROBE_CONTROL_PLANE_GRACE_MS,
    PROBE_CLEANUP_TIMEOUT_MS,
    PROBE_RUNNER_PATH,
    PROBE_MARKER_PREFIX,
    BACKOFF_BASE_DELAY_MS,
    BACKOFF_MAX_DELAY_MS,
    BACKOFF_RESET_MS
};
