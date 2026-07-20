import { spawnSync } from 'child_process';
import { parentPort } from 'worker_threads';
import {
    getRuntime,
    waitForContainerRunning,
    sleepMs
} from './common.js';

const DEFAULT_INTERVAL_SECONDS = 1;
const DEFAULT_TIMEOUT_SECONDS = 5;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_SUCCESS_THRESHOLD = 1;
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
        successThreshold: coercePositiveInteger(manifestProbeConfig.successThreshold, DEFAULT_SUCCESS_THRESHOLD)
    };
}

function runProbeOnce(agentName, containerName, probe) {
    const runtime = getRuntime();
    const execCommand = ['exec', containerName, 'sh', '-lc', `cd /code && sh "./${probe.script}"`];
    const execRes = spawnSync(
        runtime,
        execCommand,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: probe.timeout * 1000 }
    );
    if (execRes.error && execRes.error.code !== 'ETIMEDOUT') {
        throw new Error(`[probe] ${agentName}: failed to run '${probe.script}': ${execRes.error.message || execRes.error}`);
    }

    const stdout = (execRes.stdout || '').trim();
    const stderr = (execRes.stderr || '').trim();
    const timedOut = Boolean(execRes.error && execRes.error.code === 'ETIMEDOUT');
    const exitCode = typeof execRes.status === 'number' ? execRes.status : (timedOut ? 124 : 0);

    return {
        success: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        stdout,
        stderr
    };
}

function ensureScriptExists(agentName, containerName, probe) {
    const runtime = getRuntime();
    const scriptPath = `/code/${probe.script}`;
    const exists = spawnSync(
        runtime,
        ['exec', containerName, 'sh', '-lc', `[ -f "${scriptPath}" ]`],
        { stdio: 'ignore' }
    );

    if (exists.error) {
        throw new Error(`[probe] ${agentName}: unable to inspect ${probe.script}: ${exists.error.message || exists.error}`);
    }

    if (exists.status !== 0) {
        throw new Error(`[probe] ${agentName}: ${probe.script} not found inside container.`);
    }
}

function runProbeLoop(agentName, containerName, type, probe) {
    ensureScriptExists(agentName, containerName, probe);
    postProbeLog('info', `[probe] ${agentName}: ${type} probe -> script='${probe.script}', interval=${probe.interval}s, timeout=${probe.timeout}s, successThreshold=${probe.successThreshold}, failureThreshold=${probe.failureThreshold}`);
    let consecutiveSuccesses = 0;
    let consecutiveFailures = 0;
    while (true) {
        const result = runProbeOnce(agentName, containerName, probe);

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
            sleepMs(intervalMs);
        }
    }
}

function restartContainer(agentName, containerName) {
    const runtime = getRuntime();
    postProbeLog('warn', `[probe] ${agentName}: restarting container ${containerName} after liveness failure...`);
    const restartRes = spawnSync(
        runtime,
        ['restart', containerName],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (restartRes.error || restartRes.status !== 0) {
        const stderr = (restartRes.stderr || '').trim();
        const message = restartRes.error?.message || stderr || `exit code ${restartRes.status}`;
        throw new Error(`[probe] ${agentName}: failed to restart ${containerName}: ${message}`);
    }
    if (!waitForContainerRunning(containerName, 40, 250)) {
        throw new Error(`[probe] ${agentName}: container ${containerName} failed to reach running state after restart.`);
    }
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

function ensureLiveness(agentName, containerName, probe) {
    if (!probe) {
        postProbeLog('info', `[probe] ${agentName}: no liveness probe declared. Assuming live.`);
        clearLivenessState(containerName);
        return;
    }

    const state = getLivenessState(containerName);
    if (!state.startedAt) {
        state.startedAt = Date.now();
    }

    while (true) {
        const result = runProbeLoop(agentName, containerName, 'liveness', probe);
        if (result.status === 'success') {
            postProbeLog('info', `[probe] ${agentName}: liveness confirmed.`);
            clearLivenessState(containerName);
            return;
        }

        postProbeLog('warn', `[probe] ${agentName}: liveness probe failed (${result.reason}${result.detail ? `, output='${result.detail}'` : ''}).`);
        maybeResetBackoff(agentName, state);

        restartContainer(agentName, containerName);
        state.retryCount += 1;
        noteContainerStarted(containerName);

        const backoffDelayMs = computeBackoffDelay(state);
        postProbeLog('warn', `[probe] ${agentName}: CrashLoopBackOff waiting ${Math.round(backoffDelayMs / 1000)}s before next liveness probe (retry ${state.retryCount}).`);
        sleepMs(backoffDelayMs);
    }
}

function ensureReadiness(agentName, containerName, probe) {
    if (!probe) {
        postProbeLog('info', `[probe] ${agentName}: no readiness probe declared. Assuming ready.`);
        return;
    }

    const result = runProbeLoop(agentName, containerName, 'readiness', probe);
    if (result.status === 'success') {
        postProbeLog('info', `[probe] ${agentName}: readiness confirmed.`);
        return;
    }

    const detail = `${result.reason}${result.detail ? `, output='${result.detail}'` : ''}`;
    const yellow = (msg) => `\x1b[33m${msg}\x1b[0m`;
    console.warn(yellow(`[probe] ${agentName}: Container failed to become ready (${detail}).`));
}

export function runHealthProbes(agentName, containerName, manifest = {}) {
    if (!waitForContainerRunning(containerName, 40, 250)) {
        throw new Error(`[probe] ${agentName}: failed to start; container is not running.`);
    }

    const healthConfig = manifest?.health || {};
    const livenessProbe = normalizeProbeConfig('liveness', healthConfig.liveness);
    const readinessProbe = normalizeProbeConfig('readiness', healthConfig.readiness);

    if (livenessProbe) {
        noteContainerStarted(containerName);
    } else {
        clearLivenessState(containerName);
    }

    if (!livenessProbe && !readinessProbe) {
        postProbeLog('info', `[probe] ${agentName}: no health probes defined. Assuming live & ready.`);
        return;
    }

    ensureLiveness(agentName, containerName, livenessProbe);
    ensureReadiness(agentName, containerName, readinessProbe);
}

export const __testHooks = {
    coercePositiveNumber,
    coercePositiveInteger,
    validateScriptName,
    normalizeProbeConfig,
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
    BACKOFF_BASE_DELAY_MS,
    BACKOFF_MAX_DELAY_MS,
    BACKOFF_RESET_MS
};
