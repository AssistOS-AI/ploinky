import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNNING_DIR } from '../utils/config.js';
import { readAgentRegistrySnapshot } from '../utils/agentRegistrySnapshot.js';
import {
    NO_WAIT_STATUS_STATES,
    NO_WAIT_SEQUENCE_PHASES,
    resolveNoWaitBarrierTimeouts,
    resolveRunScopedObservation,
} from './noWaitProtocol.js';
import { exactEpochMs, exactRunId, exactWaveIndex } from './noWaitIdentity.js';
import {
    NO_WAIT_RUN_ID_PATTERN,
    noWaitRunScopedStatusName,
} from './noWaitPaths.js';
import {
    isProcessAlive,
    proveWorkerProcessIdentity,
} from '../sandbox/processIdentity.js';

const STATUS_LIMIT = 256 * 1024;
const WORKER_SCRIPT = fileURLToPath(new URL('./noWaitWorker.js', import.meta.url));

function quiescenceError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = 'NO_WAIT_QUIESCENCE_FAILED';
    return error;
}

function isProcessGroupAlive(pid, {
    killImpl = (target, signal) => process.kill(target, signal),
} = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        killImpl(-pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

function readStatusFile(statusPath, { fsApi = fsDefault } = {}) {
    let stat;
    let bytes;
    try {
        stat = fsApi.lstatSync(statusPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > STATUS_LIMIT) {
            throw quiescenceError(`no-wait status is not a bounded regular file: ${statusPath}`);
        }
        bytes = fsApi.readFileSync(statusPath, 'utf8');
        return JSON.parse(bytes);
    } catch (error) {
        if (error instanceof Error && error.code === 'NO_WAIT_QUIESCENCE_FAILED') throw error;
        throw quiescenceError(`no-wait status is unreadable: ${statusPath}`, error);
    }
}

function parseRunScopedName(fileName) {
    if (!fileName.endsWith('.json') || fileName.endsWith('.current.json')) return null;
    const runId = fileName.slice(-41, -5);
    const containerName = fileName.slice(0, -42);
    if (!containerName || !NO_WAIT_RUN_ID_PATTERN.test(runId)) return null;
    const normalizedRunId = exactRunId(runId);
    if (noWaitRunScopedStatusName(containerName, normalizedRunId) !== fileName) return null;
    return Object.freeze({ containerName, runId: normalizedRunId });
}

function validateRunStatus(status, identity, nowMs) {
    if (!status || typeof status !== 'object' || Array.isArray(status)
        || status.containerName !== identity.containerName
        || exactRunId(status.runId) !== identity.runId
        || !NO_WAIT_STATUS_STATES.includes(status.state)
        || !NO_WAIT_SEQUENCE_PHASES.includes(status.sequencePhase)) {
        throw quiescenceError(`no-wait run status identity is invalid for ${identity.containerName}/${identity.runId}`);
    }
    const runStartedAtMs = exactEpochMs(status.runStartedAtMs, 'no-wait run start');
    const waveIndex = exactWaveIndex(status.waveIndex, 'no-wait worker wave index');
    try {
        resolveRunScopedObservation(status, {
            expectedRunId: identity.runId,
            runStartedAtMs,
            targetWaveIndex: waveIndex,
            timeouts: resolveNoWaitBarrierTimeouts(),
            nowMs,
        });
    } catch (error) {
        throw quiescenceError(
            `no-wait run status is malformed for ${identity.containerName}/${identity.runId}: ${error.message}`,
            error,
        );
    }
    if (status.state === 'starting'
        && (!Number.isSafeInteger(status.pid) || status.pid <= 0)) {
        throw quiescenceError(`live no-wait status has no exact worker pid for ${identity.containerName}`);
    }
    return Object.freeze({ runStartedAtMs, waveIndex });
}

export function enumerateLiveNoWaitWorkers({
    runningDir = RUNNING_DIR,
    fsApi = fsDefault,
    pathApi = pathDefault,
    nowMs = Date.now(),
    readRegistry = () => readAgentRegistrySnapshot(),
    isAlive = isProcessAlive,
    isGroupAlive = isProcessGroupAlive,
    proveWorker = proveWorkerProcessIdentity,
} = {}) {
    const noWaitDirectory = pathApi.join(runningDir, 'no-wait');
    let directoryStat;
    try { directoryStat = fsApi.lstatSync(noWaitDirectory); } catch (error) {
        if (error?.code === 'ENOENT') return Object.freeze([]);
        throw quiescenceError('Unable to inspect no-wait worker state', error);
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw quiescenceError('No-wait worker state root is not a real directory');
    }
    let registry;
    try { registry = readRegistry(); } catch (error) {
        throw quiescenceError('Unable to read the enabled-agent registry during no-wait quiescence', error);
    }
    const statusByIdentity = new Map();
    const currentIdentities = new Set();
    const names = fsApi.readdirSync(noWaitDirectory).sort();
    for (const fileName of names) {
        const runIdentity = parseRunScopedName(fileName);
        if (!runIdentity) continue;
        const statusPath = pathApi.join(noWaitDirectory, fileName);
        const status = readStatusFile(statusPath, { fsApi });
        const validated = validateRunStatus(status, runIdentity, nowMs);
        statusByIdentity.set(`${runIdentity.containerName}\0${runIdentity.runId}`, {
            ...runIdentity,
            ...validated,
            status,
            statusPath,
        });
    }
    for (const fileName of names.filter((name) => name.endsWith('.current.json'))) {
        const markerPath = pathApi.join(noWaitDirectory, fileName);
        const marker = readStatusFile(markerPath, { fsApi });
        const containerName = fileName.slice(0, -'.current.json'.length);
        let runId;
        let waveIndex;
        let runStartedAtMs;
        try {
            runId = exactRunId(marker.runId);
            waveIndex = exactWaveIndex(marker.waveIndex);
            runStartedAtMs = exactEpochMs(marker.runStartedAtMs);
        } catch (error) {
            throw quiescenceError(`Current no-wait marker is malformed for ${containerName}`, error);
        }
        if (marker.statusFile !== noWaitRunScopedStatusName(containerName, runId)
            || !statusByIdentity.has(`${containerName}\0${runId}`)) {
            throw quiescenceError(`Current no-wait marker has no matching run status for ${containerName}`);
        }
        const bound = statusByIdentity.get(`${containerName}\0${runId}`);
        if (bound.waveIndex !== waveIndex || bound.runStartedAtMs !== runStartedAtMs) {
            throw quiescenceError(`Current no-wait marker disagrees with its run status for ${containerName}`);
        }
        currentIdentities.add(`${containerName}\0${runId}`);
    }

    const workers = [];
    const seenPids = new Set();
    for (const [key, run] of statusByIdentity) {
        // `running` is published only after the candidate and route commit;
        // `failed` is published only after any task-owned cleanup completes.
        // Neither terminal receipt is followed by another runtime mutation.
        // A source transition beginning after publication may therefore use
        // the terminal receipt. A worker observed here while `starting` is
        // retained by waitForNoWaitWorkersToSettle until its exact process and
        // group exit, including if it publishes a terminal receipt meanwhile.
        if (run.status.state !== 'starting') continue;
        if (!isAlive(run.status.pid)) {
            if (isGroupAlive(run.status.pid)) {
                throw quiescenceError(
                    `No-wait worker process group remains after its leader exited: ${run.containerName}`,
                );
            }
            continue;
        }
        const record = registry?.[run.containerName];
        if (!record || record.type !== 'agent'
            || typeof record.instanceId !== 'string' || !record.instanceId
            || typeof record.enableGeneration !== 'string' || !record.enableGeneration) {
            throw quiescenceError(`Live no-wait worker has no exact enabled-agent identity: ${run.containerName}`);
        }
        if (seenPids.has(run.status.pid)) {
            throw quiescenceError(`One live no-wait worker pid is claimed by multiple run records: ${run.status.pid}`);
        }
        seenPids.add(run.status.pid);
        try {
            proveWorker({
                pid: run.status.pid,
                executablePath: process.execPath,
                workerScriptPath: WORKER_SCRIPT,
                runningDir,
                identity: {
                    container: run.containerName,
                    runId: run.runId,
                    runStartedAtMs: run.runStartedAtMs,
                    waveIndex: run.waveIndex,
                    statusFile: run.statusPath,
                },
            });
        } catch (error) {
            // The worker can publish its terminal receipt and exit between the
            // liveness sample above and the process-identity proof. Resample
            // both authorities before treating that natural completion as an
            // identity failure. A surviving group without its proven leader
            // remains an explicit fail-closed orphan.
            if (!isAlive(run.status.pid)) {
                if (isGroupAlive(run.status.pid)) {
                    throw quiescenceError(
                        `No-wait worker process group remains after its leader exited: ${run.containerName}`,
                    );
                }
                continue;
            }
            throw quiescenceError(`Live no-wait worker identity cannot be proven for ${run.containerName}`, error);
        }
        workers.push(Object.freeze({
            containerName: run.containerName,
            runId: run.runId,
            runStartedAtMs: run.runStartedAtMs,
            waveIndex: run.waveIndex,
            statusPath: run.statusPath,
            pid: run.status.pid,
            instanceId: record.instanceId,
            enableGeneration: record.enableGeneration,
            current: currentIdentities.has(key),
        }));
    }
    return Object.freeze(workers);
}

function exactSettleDuration(value, label, { allowZero = true } = {}) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
        throw quiescenceError(
            `${label} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`,
        );
    }
    return value;
}

function exactSettleClock(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw quiescenceError('No-wait settle clock must return a non-negative safe integer');
    }
    return value;
}

function workerIdentityKey(worker) {
    return `${worker.containerName}\0${worker.runId}\0${worker.pid}`;
}

function remainingWorkerNames(workers) {
    return [...new Set([...workers].map((worker) => worker.containerName))].sort();
}

export async function waitForNoWaitWorkersToSettle({
    runningDir = RUNNING_DIR,
    fsApi = fsDefault,
    pathApi = pathDefault,
    readRegistry = () => readAgentRegistrySnapshot(),
    isAlive = isProcessAlive,
    isGroupAlive = isProcessGroupAlive,
    proveWorker = proveWorkerProcessIdentity,
    // Source transitions use the no-wait protocol's bounded phase budget:
    // 15 minutes by default and at most its existing one-hour phase maximum.
    // A timed-out worker is left untouched so it can still finish naturally.
    timeoutMs = resolveNoWaitBarrierTimeouts().phaseTimeoutMs,
    pollMs = 50,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
} = {}) {
    const boundedTimeoutMs = exactSettleDuration(timeoutMs, 'No-wait settle timeout');
    const boundedPollMs = exactSettleDuration(pollMs, 'No-wait settle poll interval', {
        allowZero: false,
    });
    const startedAtMs = exactSettleClock(now());
    const deadlineMs = startedAtMs + boundedTimeoutMs;
    if (!Number.isSafeInteger(deadlineMs)) {
        throw quiescenceError('No-wait settle deadline overflowed its bounded timeout');
    }

    const tracked = new Map();
    let consecutiveEmptyObservations = 0;
    // This secondary budget keeps injected/non-advancing clocks bounded too.
    // The real clock can only shorten the wait when polling or I/O is slow.
    let remainingDelayBudgetMs = boundedTimeoutMs;

    while (true) {
        const observationNowMs = exactSettleClock(now());
        const liveWorkers = enumerateLiveNoWaitWorkers({
            runningDir,
            fsApi,
            pathApi,
            nowMs: observationNowMs,
            readRegistry,
            isAlive,
            isGroupAlive,
            proveWorker,
        });
        const liveKeys = new Set();
        for (const worker of liveWorkers) {
            const key = workerIdentityKey(worker);
            liveKeys.add(key);
            tracked.set(key, worker);
        }

        let registrySnapshot;
        for (const [key, worker] of tracked) {
            if (liveKeys.has(key)) continue;
            if (!isAlive(worker.pid)) {
                if (isGroupAlive(worker.pid)) {
                    throw quiescenceError(
                        `No-wait worker process group remains after its leader exited: ${worker.containerName}`,
                    );
                }
                tracked.delete(key);
                continue;
            }

            if (registrySnapshot === undefined) {
                try {
                    registrySnapshot = readRegistry();
                } catch (error) {
                    throw quiescenceError(
                        'Unable to read the enabled-agent registry while waiting for no-wait workers',
                        error,
                    );
                }
            }
            const record = registrySnapshot?.[worker.containerName];
            if (record?.type !== 'agent'
                || record?.instanceId !== worker.instanceId
                || record?.enableGeneration !== worker.enableGeneration) {
                throw quiescenceError(
                    `No-wait worker registry identity changed before natural exit: ${worker.containerName}`,
                );
            }
            try {
                proveWorker({
                    pid: worker.pid,
                    executablePath: process.execPath,
                    workerScriptPath: WORKER_SCRIPT,
                    runningDir,
                    identity: {
                        container: worker.containerName,
                        runId: worker.runId,
                        runStartedAtMs: worker.runStartedAtMs,
                        waveIndex: worker.waveIndex,
                        statusFile: worker.statusPath,
                    },
                });
            } catch (error) {
                // Natural exit can race the identity proof. It is safe only
                // when both the exact leader and its process group are gone.
                if (!isAlive(worker.pid) && !isGroupAlive(worker.pid)) {
                    tracked.delete(key);
                    continue;
                }
                throw quiescenceError(
                    `Live no-wait worker identity cannot be proven for ${worker.containerName}`,
                    error,
                );
            }
        }

        if (tracked.size === 0) {
            consecutiveEmptyObservations += 1;
            if (consecutiveEmptyObservations >= 2) return true;
        } else {
            consecutiveEmptyObservations = 0;
        }

        const checkedAtMs = exactSettleClock(now());
        const clockBudgetMs = Math.max(0, deadlineMs - checkedAtMs);
        if (tracked.size > 0
            && (clockBudgetMs === 0 || remainingDelayBudgetMs === 0)) {
            throw quiescenceError(
                `No-wait workers did not settle naturally within ${boundedTimeoutMs}ms: ${remainingWorkerNames(tracked.values()).join(', ')}`,
            );
        }

        // At the deadline, allow an already-empty observation one immediate
        // confirmation. A worker appearing in that confirmation fails with
        // its exact name instead of letting a source transition race it.
        if (tracked.size === 0 && (clockBudgetMs === 0 || remainingDelayBudgetMs === 0)) {
            continue;
        }
        const waitMs = Math.min(boundedPollMs, clockBudgetMs, remainingDelayBudgetMs);
        await delay(waitMs);
        remainingDelayBudgetMs -= waitMs;
    }
}

export async function quiesceNoWaitWorkers({
    runningDir = RUNNING_DIR,
    fsApi = fsDefault,
    readRegistry = () => readAgentRegistrySnapshot(),
    isAlive = isProcessAlive,
    isGroupAlive = isProcessGroupAlive,
    proveWorker = proveWorkerProcessIdentity,
    signal = (processGroupId, selectedSignal) => process.kill(processGroupId, selectedSignal),
    timeoutMs = 30_000,
    pollMs = 50,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
} = {}) {
    const enumerate = () => enumerateLiveNoWaitWorkers({
        runningDir, fsApi, readRegistry, isAlive, isGroupAlive, proveWorker, nowMs: now(),
    });
    const workers = enumerate();
    for (const worker of workers) {
        if (!isAlive(worker.pid)) continue;
        const currentRegistry = readRegistry();
        const record = currentRegistry?.[worker.containerName];
        if (record?.instanceId !== worker.instanceId
            || record?.enableGeneration !== worker.enableGeneration) {
            throw quiescenceError(`No-wait worker registry identity changed before termination: ${worker.containerName}`);
        }
        const status = readStatusFile(worker.statusPath, { fsApi });
        if (status.state !== 'starting' || status.pid !== worker.pid) continue;
        try {
            proveWorker({
                pid: worker.pid,
                executablePath: process.execPath,
                workerScriptPath: WORKER_SCRIPT,
                runningDir,
                identity: {
                    container: worker.containerName,
                    runId: worker.runId,
                    runStartedAtMs: worker.runStartedAtMs,
                    waveIndex: worker.waveIndex,
                    statusFile: worker.statusPath,
                },
            });
            // No-wait workers are launched detached, so the worker PID is also
            // the process-group ID. Signal the negative ID to terminate npm,
            // Podman/Docker, and other mutating children together with the
            // proven Node worker instead of orphaning them.
            signal(-worker.pid, 'SIGTERM');
        } catch (error) {
            if (error?.code === 'ESRCH'
                && !isAlive(worker.pid)
                && !isGroupAlive(worker.pid)) {
                continue;
            }
            throw quiescenceError(`Failed to terminate proven no-wait worker ${worker.containerName}`, error);
        }
    }
    const deadline = now() + timeoutMs;
    while (workers.some((worker) => isAlive(worker.pid) || isGroupAlive(worker.pid))) {
        if (now() >= deadline) {
            const remaining = workers
                .filter((worker) => isAlive(worker.pid) || isGroupAlive(worker.pid))
                .map((worker) => worker.containerName);
            throw quiescenceError(
                `No-wait worker process groups did not exit within ${timeoutMs}ms: ${remaining.join(', ')}`,
            );
        }
        await delay(pollMs);
    }
    const remaining = enumerate();
    if (remaining.length > 0) {
        throw quiescenceError(`No-wait workers appeared during quiescence: ${remaining.map((worker) => worker.containerName).join(', ')}`);
    }
    return workers;
}

export function assertNoLiveNoWaitWorkers(options = {}) {
    const remaining = enumerateLiveNoWaitWorkers(options);
    if (remaining.length > 0) {
        throw quiescenceError(
            `No-wait workers remain after configured runtimes stopped: ${remaining.map((worker) => worker.containerName).join(', ')}`,
        );
    }
    return true;
}
