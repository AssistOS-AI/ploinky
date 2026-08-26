import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'worker_threads';
import {
    isContainerRunning,
    waitForContainerRunning,
    sleepMs
} from './common.js';
import { PLOINKY_DIR } from '../../utils/config.js';

const DEFAULT_INTERVAL_SECONDS = 1;
const DEFAULT_TIMEOUT_SECONDS = 5;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_SUCCESS_THRESHOLD = 1;
const DEFAULT_PROBE_KILL_GRACE_SECONDS = 1;
const PROBE_CONTROL_PLANE_TIMEOUT_MS = 30_000;
const PROBE_CONTAINER_WAIT_TIMEOUT_MS = 10_000;
const PROBE_CLAIM_GRACE_MS = 30_000;
const PROBE_RESULT_GRACE_MS = 60_000;
const PROBE_CANCELLATION_GRACE_MS = 30_000;
const PROBE_RESULT_POLL_MS = 50;
const PROBE_OUTPUT_MAX_BYTES = 1024 * 1024;
const DEFAULT_PROBE_CONTROL_PLANE_FAILURE_THRESHOLD = 3;
const DEFAULT_PROBE_CONTROL_PLANE_RETRY_MS = 10_000;
const PROBE_CONTROL_HOST_ROOT = path.join(PLOINKY_DIR, 'run', 'health-probes');
export const PROBE_CONTROL_CONTAINER_ROOT = '/run/ploinky-health-probes';
const PROBE_BROKER_READY_DIR = '.broker-ready';
const RUNTIME_RELAY_SOCKET_FILE = 'runtime-relay.sock';
const RUNTIME_RELAY_READY_PATTERN = /^\.runtime-relay-ready-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROBE_REQUEST_FILE = 'request';
const PROBE_REQUEST_TEMP_FILE = 'request-tmp';
const PROBE_CLAIM_DIR = 'claimed';
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

function requireContainerSegment(containerName) {
    const segment = String(containerName || '').trim();
    if (!segment || !/^[A-Za-z0-9._-]+$/.test(segment)) {
        throw new Error(`[probe] invalid container name '${segment || '<missing>'}'`);
    }
    return segment;
}

export function healthProbeHostDir(containerName, options = {}) {
    const root = path.resolve(options.probeControlHostRoot || PROBE_CONTROL_HOST_ROOT);
    return path.join(root, requireContainerSegment(containerName));
}

export function ensureHealthProbeHostDir(containerName, options = {}) {
    const hostDir = healthProbeHostDir(containerName, options);
    fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    const identity = fs.lstatSync(hostDir);
    if (!identity.isDirectory() || identity.isSymbolicLink()
        || identity.uid !== process.geteuid()) {
        throw new Error('[probe] health-probe control directory identity is invalid');
    }
    fs.chmodSync(hostDir, 0o700);
    return hostDir;
}

function removeEmptyLaunchDirectory(hostDir, entryName) {
    const entryPath = path.join(hostDir, entryName);
    let identity;
    try {
        identity = fs.lstatSync(entryPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()
        || identity.uid !== process.geteuid()) {
        throw new Error(`[probe] stale launch artifact '${entryName}' is not an exact directory`);
    }
    try {
        fs.rmdirSync(entryPath);
    } catch (cause) {
        throw new Error(`[probe] stale launch artifact '${entryName}' is not empty`, { cause });
    }
}

export function prepareHealthProbeHostDirForLaunch(containerName, options = {}) {
    const hostDir = ensureHealthProbeHostDir(containerName, options);
    removeEmptyLaunchDirectory(hostDir, PROBE_BROKER_READY_DIR);
    for (const entryName of fs.readdirSync(hostDir)) {
        if (RUNTIME_RELAY_READY_PATTERN.test(entryName)) {
            removeEmptyLaunchDirectory(hostDir, entryName);
        }
    }

    const socketPath = path.join(hostDir, RUNTIME_RELAY_SOCKET_FILE);
    let socketIdentity;
    try {
        socketIdentity = fs.lstatSync(socketPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return hostDir;
        throw error;
    }
    if (!socketIdentity.isSocket() || socketIdentity.isSymbolicLink()
        || socketIdentity.uid !== process.geteuid()) {
        throw new Error('[probe] stale runtime relay socket identity is invalid');
    }
    fs.unlinkSync(socketPath);
    return hostDir;
}

function createProbeControl(containerName, token, options = {}) {
    const hostDir = path.resolve(
        options.probeControlHostDir || ensureHealthProbeHostDir(containerName, options),
    );
    fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    const hostPath = path.join(hostDir, token);
    fs.mkdirSync(hostPath, { mode: 0o700 });
    return {
        hostPath,
        containerPath: `${PROBE_CONTROL_CONTAINER_ROOT}/${token}`,
        token,
    };
}

function submitProbeRequest(control, probe, killGraceSeconds) {
    const requestPath = path.join(control.hostPath, PROBE_REQUEST_FILE);
    const requestTempPath = path.join(control.hostPath, PROBE_REQUEST_TEMP_FILE);
    const payload = [
        'ploinky-health-probe/1',
        control.token,
        probe.script,
        String(probe.timeout),
        String(killGraceSeconds),
        '',
    ].join('\n');
    fs.writeFileSync(requestTempPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(requestTempPath, requestPath);
}

function probeWasClaimed(control) {
    try {
        return fs.statSync(path.join(control.hostPath, PROBE_CLAIM_DIR)).isDirectory();
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function readBoundedFile(filePath) {
    try {
        const handle = fs.openSync(filePath, 'r');
        try {
            const stat = fs.fstatSync(handle);
            const length = Math.min(stat.size, PROBE_OUTPUT_MAX_BYTES);
            const buffer = Buffer.alloc(length);
            const bytesRead = fs.readSync(handle, buffer, 0, length, 0);
            return buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
            fs.closeSync(handle);
        }
    } catch (error) {
        if (error?.code === 'ENOENT') return '';
        throw error;
    }
}

function readProbeResult(control) {
    const resultPath = path.join(control.hostPath, 'result');
    let result;
    try {
        result = fs.readFileSync(resultPath, 'utf8').trim();
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(result)) {
        const error = new Error(`[probe] invalid mounted-broker probe result '${result}'`);
        error.code = 'PLOINKY_PROBE_EXECUTION_UNSAFE';
        throw error;
    }
    const status = Number(result);
    const probeStdout = readBoundedFile(path.join(control.hostPath, 'probe-stdout'));
    const probeStderr = readBoundedFile(path.join(control.hostPath, 'probe-stderr'));
    const runnerStdout = readBoundedFile(path.join(control.hostPath, 'runner-stdout'));
    const runnerStderr = readBoundedFile(path.join(control.hostPath, 'runner-stderr'));
    return {
        status,
        stdout: `${probeStdout}${runnerStdout}`,
        stderr: `${probeStderr}${runnerStderr}`,
    };
}

function waitForProbeResult(control, timeoutMs, options = {}) {
    const sleepMsImpl = options.sleepMsImpl || sleepMs;
    const nowImpl = options.nowImpl || Date.now;
    const deadline = nowImpl() + Math.max(0, timeoutMs);
    while (true) {
        const result = readProbeResult(control);
        if (result) return result;
        const remaining = deadline - nowImpl();
        if (remaining <= 0) return null;
        sleepMsImpl(Math.min(PROBE_RESULT_POLL_MS, remaining));
    }
}

function waitForProbeClaimOrResult(control, timeoutMs, options = {}) {
    const sleepMsImpl = options.sleepMsImpl || sleepMs;
    const nowImpl = options.nowImpl || Date.now;
    const deadline = nowImpl() + Math.max(0, timeoutMs);
    while (true) {
        const result = readProbeResult(control);
        if (result) return { claimed: probeWasClaimed(control), result };
        if (probeWasClaimed(control)) return { claimed: true, result: null };
        const remaining = deadline - nowImpl();
        if (remaining <= 0) {
            return { claimed: probeWasClaimed(control), result: null };
        }
        sleepMsImpl(Math.min(PROBE_RESULT_POLL_MS, remaining));
    }
}

function requestProbeCancellation(control) {
    fs.mkdirSync(path.join(control.hostPath, 'cancelled'), { recursive: false, mode: 0o700 });
}

function removeCompletedProbeControl(control) {
    fs.rmSync(control.hostPath, { recursive: true, force: true });
}

function cancelAndAwaitProbe(control, options = {}) {
    try {
        requestProbeCancellation(control);
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
    }
    return waitForProbeResult(
        control,
        options.probeCancellationGraceMs || PROBE_CANCELLATION_GRACE_MS,
        options,
    );
}

function runProbeWithControlPlaneRetry(agentName, operation, callback, options = {}) {
    const threshold = coercePositiveInteger(
        options.controlPlaneFailureThreshold,
        DEFAULT_PROBE_CONTROL_PLANE_FAILURE_THRESHOLD,
    );
    const retryMs = Number.isFinite(Number(options.controlPlaneRetryMs))
        && Number(options.controlPlaneRetryMs) >= 0
        ? Number(options.controlPlaneRetryMs)
        : DEFAULT_PROBE_CONTROL_PLANE_RETRY_MS;
    const sleepMsImpl = options.sleepMsImpl || sleepMs;

    for (let attempt = 1; attempt <= threshold; attempt += 1) {
        try {
            return callback();
        } catch (error) {
            if (error?.code !== 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT'
                || attempt === threshold) {
                throw error;
            }
            postProbeLog(
                'warn',
                `[probe] ${agentName}: ${operation} hit transient runtime control-plane `
                    + `uncertainty; retrying ${attempt + 1}/${threshold}.`,
            );
            if (retryMs > 0) sleepMsImpl(retryMs);
        }
    }
    throw new Error(`[probe] ${agentName}: unreachable control-plane retry state`);
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
    const token = probeToken(options);
    const control = createProbeControl(containerName, token, options);
    const killGraceSeconds = coercePositiveNumber(
        options.killGraceSeconds,
        DEFAULT_PROBE_KILL_GRACE_SECONDS,
    );
    const submitProbeRequestImpl = options.submitProbeRequestImpl || submitProbeRequest;
    try {
        submitProbeRequestImpl(control, probe, killGraceSeconds);
    } catch (cause) {
        removeCompletedProbeControl(control);
        const error = new Error(
            `[probe] ${agentName}: failed to submit '${probe.script}' to its mounted broker`,
            { cause },
        );
        error.code = 'PLOINKY_PROBE_CONTROL_PLANE_FAILED';
        throw error;
    }

    const claimOutcome = waitForProbeClaimOrResult(
        control,
        options.probeClaimGraceMs || PROBE_CLAIM_GRACE_MS,
        options,
    );
    const completionTimeoutMs = Math.ceil(probe.timeout * 1000)
        + Math.ceil(killGraceSeconds * 1000)
        + (options.probeResultGraceMs || PROBE_RESULT_GRACE_MS);
    let execRes = claimOutcome.result;
    if (!execRes && claimOutcome.claimed) {
        execRes = waitForProbeResult(control, completionTimeoutMs, options);
    }
    if (!execRes) {
        execRes = cancelAndAwaitProbe(control, options);
        if (!execRes) {
            const claimed = probeWasClaimed(control);
            // Never erase an unterminated request. A broker can atomically
            // claim it immediately after our observation; preserving the
            // already-cancelled directory guarantees such a late claimant
            // sees cancellation before it can execute the script.
            const error = new Error(
                claimed
                    ? `[probe] ${agentName}: in-container broker claimed '${probe.script}' but did not acknowledge exact cancellation`
                    : `[probe] ${agentName}: in-container broker did not claim '${probe.script}' within its bounded window; the cancelled request was preserved`,
            );
            error.code = claimed
                ? 'PLOINKY_PROBE_EXECUTION_UNSAFE'
                : 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT';
            throw error;
        }
        removeCompletedProbeControl(control);
        const error = new Error(
            `[probe] ${agentName}: in-container broker exceeded its bounded completion window `
                + `for '${probe.script}'`,
        );
        error.code = 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT';
        throw error;
    }
    removeCompletedProbeControl(control);

    const stdout = (execRes.stdout || '').trim();
    const stderr = (execRes.stderr || '').trim();
    if (execRes.status === 125) {
        const detail = String(stderr || stdout || 'runner exited 125').trim();
        const error = new Error(
            `[probe] ${agentName}: exact cleanup was not proved for '${probe.script}': ${detail}`,
        );
        error.code = 'PLOINKY_PROBE_EXECUTION_UNSAFE';
        throw error;
    }
    if (execRes.status === 127) {
        throw new Error(`[probe] ${agentName}: ${probe.script} not found inside container.`);
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

function runProbeLoop(agentName, containerName, type, probe, options = {}) {
    postProbeLog('info', `[probe] ${agentName}: ${type} probe -> script='${probe.script}', interval=${probe.interval}s, timeout=${probe.timeout}s, successThreshold=${probe.successThreshold}, failureThreshold=${probe.failureThreshold}, continuous=${probe.continuous}`);
    let consecutiveSuccesses = 0;
    let consecutiveFailures = 0;
    // Prove the immutable runtime once before entering the semantic loop. A
    // mounted broker result is itself evidence that the same main process tree
    // executed each subsequent probe, so repeating runtime inventory here adds
    // no identity proof and can overload nested Podman during cold fan-out.
    const isContainerRunningImpl = options.isContainerRunningImpl || isContainerRunning;
    const containerRunning = runProbeWithControlPlaneRetry(
        agentName,
        'container running-state inspection',
        () => {
            try {
                return isContainerRunningImpl(containerName, {
                    timeoutMs: options.controlPlaneTimeoutMs || PROBE_CONTROL_PLANE_TIMEOUT_MS,
                    runtime: options.runtime,
                    spawnSyncImpl: options.spawnSyncImpl,
                    throwOnError: true,
                });
            } catch (error) {
                throw probeControlPlaneFailure(agentName, 'inspect container running state', error);
            }
        },
        options,
    );
    if (!containerRunning) {
        return {
            status: 'failed',
            reason: 'container exited',
            detail: '',
        };
    }

    while (true) {
        const result = runProbeWithControlPlaneRetry(
            agentName,
            `${type} probe`,
            () => runProbeOnce(agentName, containerName, probe, options),
            options,
        );

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
    healthProbeHostDir,
    ensureHealthProbeHostDir,
    prepareHealthProbeHostDirForLaunch,
    createProbeControl,
    submitProbeRequest,
    probeWasClaimed,
    readProbeResult,
    waitForProbeResult,
    waitForProbeClaimOrResult,
    cancelAndAwaitProbe,
    runProbeWithControlPlaneRetry,
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
    DEFAULT_PROBE_CONTROL_PLANE_FAILURE_THRESHOLD,
    DEFAULT_PROBE_CONTROL_PLANE_RETRY_MS,
    DEFAULT_PROBE_KILL_GRACE_SECONDS,
    PROBE_CLAIM_GRACE_MS,
    PROBE_RESULT_GRACE_MS,
    PROBE_CANCELLATION_GRACE_MS,
    PROBE_RESULT_POLL_MS,
    PROBE_OUTPUT_MAX_BYTES,
    PROBE_CONTROL_HOST_ROOT,
    PROBE_CONTROL_CONTAINER_ROOT,
    PROBE_BROKER_READY_DIR,
    RUNTIME_RELAY_SOCKET_FILE,
    RUNTIME_RELAY_READY_PATTERN,
    PROBE_REQUEST_FILE,
    PROBE_REQUEST_TEMP_FILE,
    PROBE_CLAIM_DIR,
    BACKOFF_BASE_DELAY_MS,
    BACKOFF_MAX_DELAY_MS,
    BACKOFF_RESET_MS
};
