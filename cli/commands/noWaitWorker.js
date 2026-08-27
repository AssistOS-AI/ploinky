// Detached helper that boots a single `no-wait` dependency in the background
// after `startWorkspace` has finished gating on its blocking dependencies.
//
// The script is invoked via `node noWaitWorker.js --container <name> ...` from
// `startWorkspace` and inherits the workspace cwd and environment. In a managed
// Box, cryptographic operations resolve the key from `.ploinky/master-key`; the
// key is not inherited as an environment variable. The worker writes:
//   - one run-scoped log stream at
//     .ploinky/logs/no-wait/<container>.<runId>.log (stdout+stderr), created
//     exclusively at mode 0600 by the spawning process
//   - a run-scoped status JSON at
//     .ploinky/running/no-wait/<container>.<runId>.json, plus the canonical
//     .ploinky/running/no-wait/<container>.json summary
// The log, the status, and the `<container>.current.json` marker all carry the
// same run id, so an observer that binds to one run can prove the other two
// belong to it and can tell a superseding start apart from its own. Two runs of
// one agent therefore never share a log file.
// Failures here must never bubble up to the main start command; they are
// recorded durably so an operator can see what went wrong without losing the
// already-running blocking stack.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as dockerSvc from '../sandbox/docker/index.js';
import { RUNNING_DIR } from '../utils/config.js';
import { resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import {
    ensureImagePresent,
    getRuntimeForAgent,
    isSandboxRuntime,
} from '../sandbox/docker/common.js';
import {
    getExposedNames,
    getManifestEnvNames,
    resolveManifestImage,
} from '../utils/security/secretVars.js';
import {
    isLlmRuntimeManifest,
    resolveLlmRuntimeAdmissionContext,
} from '../sandbox/docker/llmRuntimeIntegration.js';
import {
    admitManifestRuntimeCapabilities,
    assertRuntimeAdmissionCurrent,
} from '../sandbox/runtimeCapabilities.js';
import { resolveRouterEndpoint } from '../sandbox/routerPort.js';
import { mergeRoutingConfig, mergeRuntimeRoute } from '../server/routingFile.js';
import { resolveAgentReadinessProtocol } from '../utils/runtime/startupReadiness.js';
import { normalizeProbeConfig, runContainerScriptReadiness } from '../sandbox/docker/healthProbes.js';
import { loadAgents, saveAgents } from '../utils/workspace.js';
import {
    buildRelayReadinessRoute,
    waitForAgentReady,
} from '../server/utils/agentReadiness.js';
import {
    abortEdgeRoutingPreparation,
    assertActiveEdgeRoutingSourcesCurrent,
    captureEdgeRoutingLifecycleMutationGeneration,
    withEdgeGenerationApplyLock,
} from '../sandbox/edgeGeneration.js';
import {
    createNetworkLifecycleAdapter,
    withNetworkLifecycleLock,
} from '../sandbox/networkLifecycle.js';
import { networkContractHash } from '../sandbox/networkContract.js';
import { isBwrapProcessRunning } from '../sandbox/bwrap/bwrapFleet.js';
import { effectiveInstanceKey } from '../utils/workspaceDependencyGraph.js';
import { withWorkspaceMutationLease } from '../utils/runtime/maintenanceLocks.js';
import { sanitizeDiagnosticText } from '../utils/diagnosticText.js';
import {
    assertSafeRelativeSegment,
    ensureVerifiedProducerDirectory,
} from '../utils/verifiedReadOnlyFile.js';
import {
    MAX_NO_WAIT_BARRIER_ENTRIES,
    MAX_NO_WAIT_WAVE_INDEX,
    exactEpochMs,
    exactNoWaitBarrierEntry,
    exactNoWaitCoordinationStatusPath,
    exactNoWaitStatusPath,
    exactRunId,
    exactWaveIndex,
    parseNoWaitStatusBarrier,
    parseNoWaitWorkerArgs,
    resolveNoWaitRunScopedArguments,
} from './noWaitWorkerArgs.js';
import {
    boundedNoWaitTimeoutInput,
    noWaitQueuedStatusDeadline,
    resolveNoWaitBarrierTimeouts,
    resolveRunScopedObservation,
} from './noWaitProtocol.js';

export {
    MAX_NO_WAIT_BARRIER_ENTRIES,
    MAX_NO_WAIT_WAVE_INDEX,
    exactNoWaitBarrierEntry,
    parseNoWaitStatusBarrier,
    resolveNoWaitRunScopedArguments,
} from './noWaitWorkerArgs.js';
export {
    noWaitQueuedStatusDeadline,
    resolveNoWaitBarrierTimeouts,
    resolveRunScopedObservation,
} from './noWaitProtocol.js';

function statusPathFor(containerName, { runningDir = RUNNING_DIR } = {}) {
    return path.join(runningDir, 'no-wait', `${containerName}.json`);
}

function writeStatusFile(target, payload, { runningDir = RUNNING_DIR } = {}) {
    const statusDirectory = ensureVerifiedProducerDirectory({
        trustedRoot: runningDir,
        relativeSegments: ['no-wait'],
        mode: 0o700,
    });
    const resolvedTarget = path.resolve(String(target || ''));
    let targetDirectory;
    try { targetDirectory = fs.realpathSync(path.dirname(resolvedTarget)); } catch (_) {
        throw new Error('no-wait status publication requires the verified status directory');
    }
    if (targetDirectory !== fs.realpathSync(statusDirectory)) {
        throw new Error('no-wait status publication requires a file in the verified status directory');
    }
    assertSafeRelativeSegment(path.basename(resolvedTarget), 'no-wait status filename');
    const temporary = `${resolvedTarget}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), {
            flag: 'wx',
            mode: 0o600,
        });
        fs.renameSync(temporary, resolvedTarget);
    } finally {
        try { fs.unlinkSync(temporary); } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

export function writeStatus(containerName, payload, { runningDir = RUNNING_DIR } = {}) {
    writeStatusFile(statusPathFor(containerName, { runningDir }), payload, { runningDir });
}

export function writeNoWaitWorkerStatus(containerName, payload, {
    runId,
    runStartedAtMs,
    waveIndex,
    statusFile,
    runningDir = RUNNING_DIR,
} = {}) {
    const normalizedRunId = exactRunId(runId);
    const coordinationStatusFile = exactNoWaitCoordinationStatusPath(statusFile, {
        containerName,
        runId: normalizedRunId,
        runningDir,
    });
    const document = {
        ...payload,
        runId: normalizedRunId,
        runStartedAtMs: exactEpochMs(runStartedAtMs, 'no-wait run start'),
        waveIndex: exactWaveIndex(waveIndex, 'no-wait worker wave index'),
    };
    const canonicalStatusFile = statusPathFor(containerName, { runningDir });
    if (coordinationStatusFile === canonicalStatusFile) {
        throw new Error('no-wait coordination status must differ from the canonical status file');
    }

    // There is no cross-file atomic transaction. Publish the public canonical
    // view first so a completed wave barrier never exposes an older canonical
    // phase to monitors, then release the run-scoped coordination file last as
    // the final barrier handoff.
    writeStatusFile(canonicalStatusFile, document, { runningDir });
    writeStatusFile(coordinationStatusFile, document, { runningDir });
    return document;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROBE_CONTROL_PLANE_TIMEOUT_CODE = 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT';

function boundedNoWaitProbeRetryInput(value, fallback, maximum) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed >= 0
        ? Math.min(parsed, maximum)
        : fallback;
}

export async function runNoWaitScriptReadinessWithControlPlaneRetry(
    agentName,
    containerName,
    probe,
    {
        runReadiness = runContainerScriptReadiness,
        sleepImpl = sleep,
        maxRetries = boundedNoWaitProbeRetryInput(
            process.env.PLOINKY_NO_WAIT_PROBE_CONTROL_PLANE_RETRIES,
            3,
            10,
        ),
        retryDelayMs = boundedNoWaitProbeRetryInput(
            process.env.PLOINKY_NO_WAIT_PROBE_CONTROL_PLANE_RETRY_MS,
            1_000,
            30_000,
        ),
        maxRetryDelayMs = boundedNoWaitProbeRetryInput(
            process.env.PLOINKY_NO_WAIT_PROBE_CONTROL_PLANE_MAX_RETRY_MS,
            5_000,
            30_000,
        ),
    } = {},
) {
    let retries = 0;
    while (true) {
        try {
            return await Promise.resolve(runReadiness(agentName, containerName, probe));
        } catch (error) {
            if (error?.code !== PROBE_CONTROL_PLANE_TIMEOUT_CODE || retries >= maxRetries) {
                throw error;
            }
            retries += 1;
            const delayMs = Math.min(
                retryDelayMs * (2 ** (retries - 1)),
                Math.max(retryDelayMs, maxRetryDelayMs),
            );
            console.warn(
                `[no-wait] ${agentName}: probe control plane timed out; `
                + `retrying readiness (${retries}/${maxRetries}) in ${delayMs}ms`,
            );
            await sleepImpl(delayMs);
        }
    }
}

function readSequenceStatus(statusPath) {
    try {
        return {
            status: JSON.parse(fs.readFileSync(statusPath, 'utf8')),
        };
    } catch (error) {
        if (error?.code === 'ENOENT') return { missing: true };
        return { readFault: error };
    }
}

// A cold no-wait launch can legitimately retain the workspace mutation lease
// while it installs native dependencies or prepares a replacement runtime.
// The former 180-second edge timeout was only suitable for short selector
// transitions and caused healthy peers to fail while one cold launch was
// still inside its sanctioned active window. Keep the lease wait bounded by
// that same active window so observation and mutation use one timeout model.
export function resolveNoWaitLifecycleLeaseTimeoutMs({
    timeoutMs = process.env.PLOINKY_NO_WAIT_LIFECYCLE_LEASE_TIMEOUT_MS,
    timeouts = resolveNoWaitBarrierTimeouts(),
} = {}) {
    return boundedNoWaitTimeoutInput(timeoutMs, {
        fallback: timeouts.activeTimeoutMs,
        minimum: 1000,
        maximum: timeouts.activeTimeoutMs,
    });
}

export function isNoWaitWorkerAlive(pid, { killImpl = process.kill } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        killImpl(pid, 0);
        return true;
    } catch (error) {
        // EPERM proves that a process owns the PID even when this caller cannot
        // signal it. ESRCH is the only portable proof that the PID is absent.
        return error?.code !== 'ESRCH';
    }
}

// Polls exactly one barrier status file. It never inspects the observed
// worker's own barrier list and never opens another status path, so no worker
// can traverse a peer's coordination state.
export async function waitForRunScopedStatus(entry, {
    runningDir = RUNNING_DIR,
    expectedRunId = '',
    runStartedAtMs,
    timeouts = resolveNoWaitBarrierTimeouts(),
    pollIntervalMs = 100,
    sleepFn = sleep,
    nowFn = Date.now,
    isWorkerAlive = isNoWaitWorkerAlive,
} = {}) {
    const target = exactNoWaitBarrierEntry(entry, {
        runningDir,
        expectedRunId,
        label: 'no-wait barrier entry',
    });
    const exactRunStartedAtMs = exactEpochMs(runStartedAtMs, 'no-wait run start');
    const queuedDeadline = noWaitQueuedStatusDeadline(
        exactRunStartedAtMs,
        target.waveIndex,
        timeouts,
    );
    const statusLabel = path.basename(target.path);
    const publicationDeadline = exactRunStartedAtMs + timeouts.startupGraceMs;
    let readFaultStartedAtMs = null;
    let lastReadFault = null;
    let workerExitObservedAtMs = null;

    while (true) {
        const nowMs = nowFn();
        let deadline = publicationDeadline;
        const readResult = readSequenceStatus(target.path);
        if (readResult.readFault) {
            // Malformed JSON and transient filesystem faults share one bounded
            // retry window. Persisting past it is a rejected barrier outcome.
            if (readFaultStartedAtMs === null) readFaultStartedAtMs = nowMs;
            lastReadFault = readResult.readFault;
            deadline = readFaultStartedAtMs + timeouts.readRetryTimeoutMs;
        } else {
            readFaultStartedAtMs = null;
            lastReadFault = null;
            if (!readResult.missing) {
                let observation;
                try {
                    observation = resolveRunScopedObservation(readResult.status, {
                        expectedRunId: target.runId,
                        runStartedAtMs: exactRunStartedAtMs,
                        targetWaveIndex: target.waveIndex,
                        timeouts,
                        nowMs,
                    });
                } catch (error) {
                    throw new Error(
                        `no-wait barrier status '${statusLabel}' is invalid: ${error?.message || error}`,
                    );
                }
                if (observation.terminal) {
                    return Object.freeze({ state: observation.terminal });
                }
                deadline = observation.queued ? queuedDeadline : observation.deadline;
                if (!Number.isSafeInteger(observation.workerPid) || observation.workerPid <= 0) {
                    throw new Error(
                        `no-wait barrier status '${statusLabel}' is invalid: non-terminal status has no exact worker pid`,
                    );
                }
                if (isWorkerAlive(observation.workerPid)) {
                    workerExitObservedAtMs = null;
                } else {
                    if (workerExitObservedAtMs === null) workerExitObservedAtMs = nowMs;
                    deadline = Math.min(
                        deadline,
                        workerExitObservedAtMs + timeouts.terminalPublicationGraceMs,
                    );
                }
            }
        }
        if (nowMs >= deadline) {
            if (lastReadFault) {
                throw new Error(
                    `no-wait barrier status '${statusLabel}' remained unreadable after bounded retries: ${lastReadFault?.message || lastReadFault}`,
                );
            }
            if (workerExitObservedAtMs !== null) {
                throw new Error(
                    `no-wait worker for barrier status '${statusLabel}' exited before publishing a terminal status`,
                );
            }
            throw new Error(`timed out waiting for no-wait barrier status '${statusLabel}'`);
        }
        await sleepFn(Math.min(pollIntervalMs, deadline - nowMs));
    }
}

export async function waitForNoWaitStatusBarrier(entries, {
    runId = '',
    runStartedAtMs,
    waveIndex,
    runningDir = RUNNING_DIR,
    waitFn = waitForRunScopedStatus,
    waitOptions = {},
} = {}) {
    const barrier = Array.isArray(entries) ? entries : [];
    if (!barrier.length) return Object.freeze([]);
    // The run identity is never inferred from the entries being validated; an
    // entry must be checked against the owner's run, not against itself.
    const expectedRunId = exactRunId(runId, 'no-wait barrier owner run id');
    const expectedRunStartedAtMs = exactEpochMs(runStartedAtMs, 'no-wait run start');
    exactWaveIndex(waveIndex, 'no-wait barrier owner wave index');
    // Settle-all, never fail-fast: an early invalid status, timeout, or
    // dependency failure must not release this worker while another explicitly
    // listed dependency is still active.
    const settled = await Promise.all(barrier.map(async (entry) => {
        try {
            return {
                entry,
                status: await waitFn(entry, {
                    // Caller overrides may tune polling and timeouts, never the
                    // identity this barrier is bound to.
                    ...waitOptions,
                    runningDir,
                    expectedRunId,
                    runStartedAtMs: expectedRunStartedAtMs,
                }),
            };
        } catch (error) {
            return { entry, error };
        }
    }));

    const statusIdentity = (entry) => path.basename(String(entry?.path || 'unknown'), '.json');
    const firstInvalid = settled.find(({ error }) => error);
    if (firstInvalid) {
        const error = new Error(
            `no-wait wave barrier member '${statusIdentity(firstInvalid.entry)}' did not settle: ${firstInvalid.error?.message || firstInvalid.error}`,
        );
        error.code = 'PLOINKY_NO_WAIT_BARRIER_STATUS_INVALID';
        error.cause = firstInvalid.error;
        throw error;
    }
    const failedDependency = settled.find(({ entry, status }) => (
        entry.directDependency && status?.state === 'failed'
    ));
    if (failedDependency) {
        const error = new Error(
            `no-wait direct dependency '${statusIdentity(failedDependency.entry)}' failed in this run`,
        );
        error.code = 'PLOINKY_NO_WAIT_DIRECT_DEPENDENCY_FAILED';
        throw error;
    }
    return Object.freeze(settled.map(({ entry, status }) => Object.freeze({ entry, status })));
}

async function upsertRoute(routeKey, route, {
    containerName,
    registryRecord,
    expectedIdentity,
    expectedLifecycle,
    expectedSelector,
    preparationLease,
    networkLifecycleCapability,
} = {}) {
    if (!containerName || !registryRecord || !expectedIdentity || !expectedLifecycle
        || !expectedSelector?.generation || !expectedSelector?.activationId) {
        throw new Error('no-wait route activation requires one exact runtime registry record and active selector');
    }
    let validatedActivationSelector = null;
    if (!preparationLease) {
        const activationLifecycle = await waitForNoWaitRouteActivation(
            expectedIdentity,
            expectedSelector,
            { expectedLifecycle },
        );
        validatedActivationSelector = Object.freeze({
            generation: activationLifecycle.generationDigest,
            activationId: activationLifecycle.selectorActivationId,
        });
    }
    await mergeRoutingConfig((cfg) => {
        const agents = loadAgents();
        const snapshot = {
            generation: {
                agents,
                routing: cfg,
            },
        };
        if (expectedLifecycle.targetState === 'ready') {
            assertNoWaitAdoptableLifecycleSnapshot(snapshot, expectedIdentity);
        } else {
            assertNoWaitLifecycleSnapshot(snapshot, expectedIdentity);
        }
        agents[containerName] = registryRecord;
        saveAgents(agents, { coordinate: false });
        cfg.routes = cfg.routes || {};
        cfg.routes[routeKey] = mergeRuntimeRoute(
            cfg.routes[routeKey],
            route,
            { hostPort: route.hostPort },
        );
        return cfg;
    }, {
        reason: `no-wait-runtime-ready:${routeKey}`,
        networkLifecycleCapability,
        ...(preparationLease ? { preparationLease } : {}),
        ...(preparationLease ? {} : { validateActiveGeneration() {
            const active = assertActiveEdgeRoutingSourcesCurrent();
            if (active.selector.generation !== validatedActivationSelector.generation
                || active.selector.activationId !== validatedActivationSelector.activationId) {
                throw new Error(`no-wait lifecycle generation changed before route activation for '${routeKey}'`);
            }
            assertNoWaitLifecycleSnapshot(active, expectedIdentity);
            return active;
        }, captureExpectedGeneration(active) {
            return captureEdgeRoutingLifecycleMutationGeneration(active);
        } }),
    });
}

export function assertNoWaitRegistryRecord(record, stagedRecord, {
    containerName,
    repoName,
    shortAgent,
    alias,
}) {
    const invariantFields = [
        ['type', 'agent'],
        ['repoName', repoName],
        ['agentName', shortAgent],
        ['alias', alias],
        ['instanceId', stagedRecord?.instanceId],
        ['enableGeneration', stagedRecord?.enableGeneration],
        ['profile', stagedRecord?.profile],
        ['runMode', stagedRecord?.runMode],
        ['projectPath', stagedRecord?.projectPath],
        ['develRepo', stagedRecord?.develRepo],
    ];
    const mismatch = !record || invariantFields.some(([field, expected]) => (
        String(record?.[field] || '') !== String(expected || '')
    )) || String(record?.auth?.mode || '') !== String(stagedRecord?.auth?.mode || '');
    if (mismatch) {
        throw new Error(`no-wait runtime returned a registry identity inconsistent with '${containerName}'`);
    }
    return record;
}

export async function cleanupNoWaitTaskOwnedCandidate(candidate, {
    cleanup = dockerSvc.cleanupExactAgentRuntimeCandidate,
    abortPreparation = abortEdgeRoutingPreparation,
} = {}) {
    if (candidate?.createdByThisLaunch !== true
        && !(candidate?.requiresEdgeActivation === true && candidate?.preparationLease)) return false;
    let cleanupFailure = null;
    try {
        await Promise.resolve(cleanup(candidate));
    } catch (error) {
        cleanupFailure = error;
    }
    try {
        if (candidate?.preparationLease) {
            await Promise.resolve(abortPreparation(candidate.preparationLease));
        }
    } catch (abortFailure) {
        if (cleanupFailure) {
            throw new AggregateError(
                [cleanupFailure, abortFailure],
                'exact no-wait runtime cleanup and preparation abort both failed',
            );
        }
        throw abortFailure;
    }
    if (cleanupFailure) throw cleanupFailure;
    return true;
}

function boundedPositiveInteger(value, fallback, maximum) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isSafeInteger(parsed) && parsed > 0
        ? Math.min(parsed, maximum)
        : fallback;
}

export function assertNoWaitRuntimeStillExact(result, {
    profileResolution,
    expectedIdentity,
} = {}, {
    createAdapter = createNetworkLifecycleAdapter,
    getRuntime = dockerSvc.getRuntime,
    isSandboxRunning = isBwrapProcessRunning,
    requireRunning = true,
} = {}) {
    const containerName = String(result?.containerName || '').trim();
    const record = result?.registryRecord;
    if (!containerName || containerName !== String(expectedIdentity?.containerName || '')
        || !record || record.type !== 'agent') {
        throw new Error('no-wait runtime reinspection requires its exact returned identity');
    }
    assertNoWaitRegistryRecord(record, record, expectedIdentity);
    const runtime = String(record.runtime || '').trim();
    const runtimeIdentity = {
        instanceId: String(record.instanceId || '').trim(),
        enableGeneration: String(record.enableGeneration || '').trim(),
    };
    if (!runtimeIdentity.instanceId || !runtimeIdentity.enableGeneration) {
        throw new Error(`no-wait runtime '${containerName}' lost its immutable identity before publication`);
    }
    if (isSandboxRuntime(runtime)) {
        if (!isSandboxRunning(containerName, runtimeIdentity)) {
            throw new Error(`no-wait sandbox '${containerName}' changed identity before publication`);
        }
        return result;
    }
    const returnedContainerId = String(result?.containerId || '').trim().toLowerCase();
    const recordedContainerId = String(record.containerId || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(returnedContainerId)
        || !/^[a-f0-9]{64}$/.test(recordedContainerId)
        || returnedContainerId !== recordedContainerId) {
        throw new Error(`no-wait runtime '${containerName}' lacks one consistent immutable container ID`);
    }
    const network = profileResolution?.network;
    if (!network || typeof network !== 'object' || Array.isArray(network)) {
        throw new Error(`no-wait runtime '${containerName}' lacks its admitted network contract`);
    }
    const adapter = createAdapter({ runtime: getRuntime() });
    const inspection = adapter.inspectContainerContract(
        containerName,
        network,
        expectedIdentity.shortAgent,
        {
            instanceKey: effectiveInstanceKey(
                expectedIdentity.repoName,
                expectedIdentity.shortAgent,
                expectedIdentity.alias || '',
            ),
            contractHash: networkContractHash(network),
            ...runtimeIdentity,
            requireRuntimeIdentity: true,
        },
    );
    // The contract inspection already binds state to the exact immutable
    // container ID. Reusing that snapshot avoids a second, global runtime
    // inventory between inspection and publication.
    if (inspection?.state !== 'exact'
        || String(inspection.id || '').trim().toLowerCase() !== returnedContainerId
        || (requireRunning && inspection.running !== true)) {
        throw new Error(`no-wait runtime '${containerName}' changed immutable identity before publication`);
    }
    return result;
}

function appendNoWaitCleanupFailure(error, cleanupError) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.message = `${failure.message}; exact task-owned runtime cleanup failed: ${cleanupError?.message || cleanupError}`;
    return failure;
}

function noWaitLifecyclePublishesCandidate(lifecycle, candidate) {
    if (lifecycle?.targetState !== 'ready') return false;
    const activeRecord = lifecycle.record;
    const candidateRecord = candidate?.registryRecord;
    if (!activeRecord || !candidateRecord
        || String(lifecycle.route?.container || '') !== String(candidate?.containerName || '')
        || String(activeRecord.instanceId || '') !== String(candidateRecord.instanceId || '')
        || String(activeRecord.enableGeneration || '') !== String(candidateRecord.enableGeneration || '')
        || String(activeRecord.runtime || '') !== String(candidateRecord.runtime || '')) {
        return false;
    }
    if (isSandboxRuntime(activeRecord.runtime)) return true;
    const activeContainerId = String(activeRecord.containerId || '').trim().toLowerCase();
    const candidateContainerId = String(
        candidate?.containerId || candidateRecord.containerId || '',
    ).trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(activeContainerId)
        && /^[a-f0-9]{64}$/.test(candidateContainerId)
        && activeContainerId === candidateContainerId;
}

export async function runNoWaitLifecycleTransaction(identity, {
    capture,
    ensure,
    readiness,
    revalidate,
    inspectRuntime,
    activate,
    cleanupCandidate = cleanupNoWaitTaskOwnedCandidate,
    withLifecycleLease = withActiveNoWaitWorkerLifecycleLease,
    withNetworkLock = withNetworkLifecycleLock,
    loadCurrentLifecycle = loadNoWaitWorkerLifecycle,
    lifecycleLeaseTimeoutMs = resolveNoWaitLifecycleLeaseTimeoutMs(),
    networkWaitMs = boundedPositiveInteger(
        process.env.PLOINKY_NO_WAIT_NETWORK_LOCK_TIMEOUT_MS,
        180000,
        300000,
    ),
    networkPollMs = boundedPositiveInteger(
        process.env.PLOINKY_NO_WAIT_NETWORK_LOCK_POLL_MS,
        50,
        1000,
    ),
} = {}) {
    for (const [name, callback] of Object.entries({
        capture,
        ensure,
        readiness,
        revalidate,
        inspectRuntime,
        activate,
    })) {
        if (typeof callback !== 'function') {
            throw new TypeError(`no-wait lifecycle transaction requires a ${name} callback`);
        }
    }

    let initialLifecycle = null;
    let context = null;
    let result = null;
    let cleanupRequired = false;
    let cleanupAttempted = false;
    const boundedLifecycleLeaseTimeoutMs = resolveNoWaitLifecycleLeaseTimeoutMs({
        timeoutMs: lifecycleLeaseTimeoutMs,
    });

    const runWithLifecycleLease = (callback, operation) => withLifecycleLease(
        identity,
        callback,
        {
            operation,
            timeoutMs: boundedLifecycleLeaseTimeoutMs,
        },
    );

    const runWithNetworkLock = (callback) => withNetworkLock(callback, {
        waitMs: boundedPositiveInteger(networkWaitMs, 180000, 300000),
        pollMs: boundedPositiveInteger(networkPollMs, 50, 1000),
    });
    const isTaskOwned = (candidate) => candidate?.createdByThisLaunch === true
        || (candidate?.requiresEdgeActivation === true && candidate?.preparationLease);

    const cleanupWhileWorkspaceLocked = async (
        activeLifecycle,
        existingNetworkLifecycleCapability = null,
    ) => {
        if (!cleanupRequired || cleanupAttempted || !result) return;
        cleanupAttempted = true;

        let currentLifecycle = activeLifecycle;
        try {
            // Activation can commit a new ready selector before a later step
            // throws. Re-read while the workspace lease is still held instead
            // of trusting the pre-activation callback snapshot.
            currentLifecycle = loadCurrentLifecycle(identity);
            if (currentLifecycle && typeof currentLifecycle.then === 'function') {
                throw new Error('no-wait cleanup lifecycle reinspection must be synchronous');
            }
        } catch (error) {
            if (error?.code !== 'EDGE_GENERATION_INACTIVE') throw error;
        }

        // A peer may have adopted and published this exact immutable runtime
        // while readiness ran without the workspace lease. That publication
        // transfers ownership to the active lifecycle; deleting it here would
        // tear down a valid route. Preserve it and let the original failure
        // remain fail-closed.
        if (noWaitLifecyclePublishesCandidate(currentLifecycle, result)) {
            cleanupRequired = false;
            return;
        }

        const cleanupWithCapability = async (networkLifecycleCapability) => {
            // Reinspection binds a cleanup receipt to the same live immutable
            // runtime that readiness observed. Never remove by name alone.
            await inspectRuntime(result, context, initialLifecycle, networkLifecycleCapability, {
                cleanup: true,
            });
            await cleanupCandidate(result, { networkLifecycleCapability });
        };
        if (existingNetworkLifecycleCapability) {
            await cleanupWithCapability(existingNetworkLifecycleCapability);
        } else {
            await runWithNetworkLock(cleanupWithCapability);
        }
        cleanupRequired = false;
    };

    const cleanupAfterWorkspaceRelease = async () => {
        if (!cleanupRequired || cleanupAttempted || !result) return;
        await runWithLifecycleLease(
            cleanupWhileWorkspaceLocked,
            `no-wait-cleanup:${String(identity?.containerName || identity?.routeKey || 'unknown')}`,
        );
    };

    try {
        const initialPhase = await runWithLifecycleLease(async (lifecycle) => {
            initialLifecycle = lifecycle;
            context = await capture(lifecycle);
            if (context?.requiresEnsure === false) {
                result = context.runtimeResult;
                cleanupRequired = isTaskOwned(result);
                return { completed: false };
            }

            return runWithNetworkLock(async (networkLifecycleCapability) => {
                result = await ensure(lifecycle, context, networkLifecycleCapability);
                cleanupRequired = isTaskOwned(result);
                try {
                    if (result?.requiresEdgeActivation === true && !result?.preparationLease) {
                        throw new Error('no-wait runtime replacement requires its exact preparation lease');
                    }
                    if (!result?.preparationLease) return { completed: false };

                    // A preparation lease selected an inactive generation.
                    // Retain both workspace and network locks through readiness
                    // and activation; releasing either can deadlock or expose a
                    // replacement whose selector is not active yet.
                    await readiness(lifecycle, context, result);
                    await inspectRuntime(result, context, lifecycle, networkLifecycleCapability, {
                        cleanup: false,
                    });
                    const value = await activate(lifecycle, context, result, {
                        networkLifecycleCapability,
                        onCommitted() { cleanupRequired = false; },
                    });
                    return { completed: true, value };
                } catch (error) {
                    try {
                        await cleanupWhileWorkspaceLocked(
                            lifecycle,
                            networkLifecycleCapability,
                        );
                    } catch (cleanupError) {
                        throw appendNoWaitCleanupFailure(error, cleanupError);
                    }
                    throw error;
                }
            });
        }, `no-wait-runtime:${String(identity?.containerName || identity?.routeKey || 'unknown')}`);
        if (initialPhase.completed) return initialPhase.value;

        // The expensive semantic readiness wait is intentionally outside both
        // mutation locks for ordinary fresh/adoptable runtimes.
        await readiness(initialLifecycle, context, result);

        return await runWithLifecycleLease(async (currentLifecycle) => {
            try {
                const rebasedLifecycle = await revalidate(
                    initialLifecycle,
                    currentLifecycle,
                    context,
                    result,
                );
                return await runWithNetworkLock(async (networkLifecycleCapability) => {
                    await inspectRuntime(result, context, rebasedLifecycle, networkLifecycleCapability, {
                        cleanup: false,
                    });
                    return activate(rebasedLifecycle, context, result, {
                        networkLifecycleCapability,
                        onCommitted() { cleanupRequired = false; },
                    });
                });
            } catch (error) {
                try {
                    await cleanupWhileWorkspaceLocked(currentLifecycle);
                } catch (cleanupError) {
                    throw appendNoWaitCleanupFailure(error, cleanupError);
                }
                throw error;
            }
        }, `no-wait-activate:${String(identity?.containerName || identity?.routeKey || 'unknown')}`);
    } catch (error) {
        try {
            await cleanupAfterWorkspaceRelease();
        } catch (cleanupError) {
            throw appendNoWaitCleanupFailure(error, cleanupError);
        }
        throw error;
    }
}

function assertNoWaitLifecycleIdentity(active, {
    containerName,
    repoName,
    shortAgent,
    alias,
    routeKey,
    agentPath,
}) {
    const record = active?.generation?.agents?.[containerName];
    if (!record || record.type !== 'agent'
        || String(record.repoName || '') !== repoName
        || String(record.agentName || '') !== shortAgent
        || String(record.alias || '') !== alias
        || !String(record.instanceId || '')
        || !String(record.enableGeneration || '')) {
        throw new Error(`no-wait lifecycle requires the exact staged registry identity for '${containerName}'`);
    }
    const route = active?.generation?.routing?.routes?.[routeKey];
    if (!route
        || String(route.container || '') !== containerName
        || String(route.repo || '') !== repoName
        || String(route.agent || '') !== shortAgent
        || String(route.alias || '') !== alias
        || !String(route.hostPath || '')
        || !String(agentPath || '')
        || path.resolve(String(route.hostPath)) !== path.resolve(String(agentPath))) {
        throw new Error(`no-wait lifecycle requires one exact staged route identity for '${routeKey}'`);
    }
    const manifest = active?.generation?.manifests?.[routeKey];
    if (active?.selector && (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))) {
        throw new Error(`no-wait lifecycle requires the active captured manifest for '${routeKey}'`);
    }
    return Object.freeze({
        record,
        route,
        manifest,
        generationDigest: String(active?.selector?.generation || ''),
        selectorActivationId: String(active?.selector?.activationId || ''),
        routerPort: Number(active?.generation?.routing?.port || 0),
        routerHostPort: Number(active?.generation?.routerHostPort || 0),
    });
}

export function assertNoWaitLifecycleSnapshot(active, identity) {
    const lifecycle = assertNoWaitLifecycleIdentity(active, identity);
    if (Object.prototype.hasOwnProperty.call(lifecycle.route, 'hostPort')
        || Object.prototype.hasOwnProperty.call(lifecycle.route, 'serviceTargets')) {
        throw new Error(`no-wait lifecycle requires one exact target-less staged route for '${identity.routeKey}'`);
    }
    return Object.freeze({
        ...lifecycle,
        targetState: 'staged',
    });
}

export function assertNoWaitAdoptableLifecycleSnapshot(active, identity) {
    const lifecycle = assertNoWaitLifecycleIdentity(active, identity);
    const hostPort = Number(lifecycle.route.hostPort);
    const runtime = String(lifecycle.record.runtime || '').trim();
    const containerId = String(lifecycle.record.containerId || '').trim().toLowerCase();
    if (!Number.isInteger(hostPort) || hostPort <= 0 || hostPort > 65535
        || Object.prototype.hasOwnProperty.call(lifecycle.route, 'serviceTargets')
        || !['docker', 'podman'].includes(runtime)
        || !/^[a-f0-9]{64}$/.test(containerId)) {
        throw new Error(
            `no-wait lifecycle cannot adopt an existing target for '${identity.routeKey}' without one exact container runtime and private host port`,
        );
    }
    return Object.freeze({
        ...lifecycle,
        route: Object.freeze({ ...lifecycle.route }),
        targetState: 'ready',
    });
}

export function resolveNoWaitWorkerLifecycleSnapshot(active, identity) {
    const route = active?.generation?.routing?.routes?.[identity.routeKey];
    const hasPublishedTarget = Object.prototype.hasOwnProperty.call(route || {}, 'hostPort')
        || Object.prototype.hasOwnProperty.call(route || {}, 'serviceTargets');
    return hasPublishedTarget
        ? assertNoWaitAdoptableLifecycleSnapshot(active, identity)
        : assertNoWaitLifecycleSnapshot(active, identity);
}

export function assertNoWaitAdoptionStillCurrent(initialLifecycle, currentLifecycle, identity) {
    if (initialLifecycle?.targetState !== 'ready' || currentLifecycle?.targetState !== 'ready'
        || !isDeepStrictEqual(currentLifecycle.record, initialLifecycle.record)
        || !isDeepStrictEqual(currentLifecycle.route, initialLifecycle.route)
        || !isDeepStrictEqual(currentLifecycle.manifest, initialLifecycle.manifest)
        || Number(currentLifecycle.routerPort) !== Number(initialLifecycle.routerPort)
        || Number(currentLifecycle.routerHostPort) !== Number(initialLifecycle.routerHostPort)) {
        throw new Error(`no-wait adopted runtime changed before readiness completed for '${identity.routeKey}'`);
    }
    return currentLifecycle;
}

export function assertNoWaitLifecycleRebase(initialLifecycle, currentLifecycle, identity) {
    if (initialLifecycle?.targetState !== 'staged' || currentLifecycle?.targetState !== 'staged'
        || !isDeepStrictEqual(currentLifecycle.record, initialLifecycle.record)
        || !isDeepStrictEqual(currentLifecycle.route, initialLifecycle.route)
        || !isDeepStrictEqual(currentLifecycle.manifest, initialLifecycle.manifest)
        || Number(currentLifecycle.routerPort) !== Number(initialLifecycle.routerPort)
        || Number(currentLifecycle.routerHostPort) !== Number(initialLifecycle.routerHostPort)) {
        throw new Error(
            `no-wait lifecycle changed before route activation for '${identity.routeKey}'`,
        );
    }
    return currentLifecycle;
}

function loadNoWaitLifecycle(identity) {
    return assertNoWaitLifecycleSnapshot(assertActiveEdgeRoutingSourcesCurrent(), identity);
}

function loadNoWaitWorkerLifecycle(identity) {
    return resolveNoWaitWorkerLifecycleSnapshot(
        assertActiveEdgeRoutingSourcesCurrent(),
        identity,
    );
}

function isRetryableNoWaitWorkerLifecycleObservation(error) {
    return error?.code === 'EDGE_GENERATION_INACTIVE'
        || error?.code === 'EDGE_GENERATION_SOURCE_CHANGED';
}

export async function waitForNoWaitLifecycle(identity, {
    timeoutMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_EDGE_TIMEOUT_MS || '180000',
        10,
    ),
    pollIntervalMs = 250,
    loadFn = loadNoWaitLifecycle,
    sleepFn = sleep,
} = {}) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        try {
            return loadFn(identity);
        } catch (error) {
            if (error?.code !== 'EDGE_GENERATION_INACTIVE') throw error;
        }
        await sleepFn(pollIntervalMs);
    }
    throw new Error(`timed out waiting for the active edge generation for '${identity.routeKey}'`);
}

export async function waitForNoWaitWorkerLifecycle(identity, {
    timeoutMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_EDGE_TIMEOUT_MS || '180000',
        10,
    ),
    pollIntervalMs = 250,
    loadFn = loadNoWaitWorkerLifecycle,
    sleepFn = sleep,
} = {}) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        try {
            return loadFn(identity);
        } catch (error) {
            if (!isRetryableNoWaitWorkerLifecycleObservation(error)) throw error;
        }
        await sleepFn(pollIntervalMs);
    }
    throw new Error(`timed out waiting for the active edge generation for '${identity.routeKey}'`);
}

export async function withActiveNoWaitWorkerLifecycleLease(identity, callback, {
    timeoutMs = resolveNoWaitLifecycleLeaseTimeoutMs(),
    pollIntervalMs = 250,
    loadFn = loadNoWaitWorkerLifecycle,
    withLeaseFn = withWorkspaceMutationLease,
    sleepFn = sleep,
    nowFn = Date.now,
    operation = `no-wait-runtime:${String(identity?.containerName || identity?.routeKey || 'unknown')}`,
} = {}) {
    if (typeof callback !== 'function') {
        throw new TypeError('no-wait lifecycle lease requires a callback');
    }
    const boundedTimeoutMs = resolveNoWaitLifecycleLeaseTimeoutMs({ timeoutMs });
    const parsedPollIntervalMs = Number(pollIntervalMs);
    const boundedPollIntervalMs = Number.isFinite(parsedPollIntervalMs)
        ? Math.max(1, parsedPollIntervalMs)
        : 250;
    const deadline = nowFn() + boundedTimeoutMs;

    while (nowFn() < deadline) {
        let observedLifecycle;
        try {
            // Publication must be able to reacquire the shared lease while the
            // selector is inactive or while a peer's source mutation has not
            // yet been captured into a new active generation. Never wait for
            // an exact selector from inside the workspace mutation lease.
            observedLifecycle = loadFn(identity);
        } catch (error) {
            if (!isRetryableNoWaitWorkerLifecycleObservation(error)) throw error;
            const remainingMs = deadline - nowFn();
            if (remainingMs <= 0) break;
            await sleepFn(Math.min(boundedPollIntervalMs, remainingMs));
            continue;
        }

        const remainingMs = deadline - nowFn();
        if (remainingMs <= 0) break;
        const result = await withLeaseFn({
            operation,
            waitTimeoutMs: remainingMs,
            retryIntervalMs: Math.min(1000, boundedPollIntervalMs),
        }, async () => {
            let lockedLifecycle;
            try {
                lockedLifecycle = loadFn(identity);
            } catch (error) {
                if (isRetryableNoWaitWorkerLifecycleObservation(error)) {
                    return { retry: true };
                }
                throw error;
            }
            // Publication or another exact workspace mutation may have
            // changed the selector while this worker waited for the lease.
            // Release and sample again instead of adopting a mixed snapshot.
            if (!isDeepStrictEqual(lockedLifecycle, observedLifecycle)) {
                return { retry: true };
            }
            return { retry: false, value: await callback(lockedLifecycle) };
        });
        if (!result.retry) return result.value;

        const retryRemainingMs = deadline - nowFn();
        if (retryRemainingMs <= 0) break;
        // withLeaseFn has released the exact lease before this delay, leaving
        // a fair recovery window for publication to reactivate the selector.
        await sleepFn(Math.min(boundedPollIntervalMs, retryRemainingMs));
    }

    const error = new Error(
        `timed out waiting for an exact active edge generation lease for '${identity.routeKey}'`,
    );
    error.code = 'NO_WAIT_EDGE_LEASE_TIMEOUT';
    throw error;
}

export async function waitForNoWaitRouteActivation(identity, launchSelector, options = {}) {
    const lifecycle = await waitForNoWaitLifecycle(identity, options);
    if (lifecycle.generationDigest !== launchSelector?.generation) {
        if (!options.expectedLifecycle) {
            throw new Error(`no-wait lifecycle generation changed before route activation for '${identity.routeKey}'`);
        }
        assertNoWaitLifecycleRebase(options.expectedLifecycle, lifecycle, identity);
    }
    return lifecycle;
}

export async function launchNoWaitHostRuntime(identity, initialLifecycle, launch, {
    timeoutMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_EDGE_TIMEOUT_MS || '180000',
        10,
    ),
    pollIntervalMs = 250,
    loadFn = loadNoWaitLifecycle,
    withApplyLockFn = withEdgeGenerationApplyLock,
    sleepFn = sleep,
    nowFn = Date.now,
} = {}) {
    if (typeof launch !== 'function') {
        throw new Error('no-wait host launch requires one runtime launch callback');
    }
    const launchGeneration = String(initialLifecycle?.generationDigest || '');
    const initialActivationId = String(initialLifecycle?.selectorActivationId || '');
    if (!launchGeneration || !initialActivationId) {
        throw new Error('no-wait host launch requires one exact active selector');
    }
    const parsedTimeoutMs = Number(timeoutMs);
    const boundedTimeoutMs = Number.isFinite(parsedTimeoutMs)
        ? Math.max(1000, parsedTimeoutMs)
        : 180000;
    const parsedPollIntervalMs = Number(pollIntervalMs);
    const boundedPollIntervalMs = Number.isFinite(parsedPollIntervalMs)
        ? Math.max(1, parsedPollIntervalMs)
        : 250;
    const deadline = nowFn() + boundedTimeoutMs;
    let attemptLifecycle = initialLifecycle;
    let lastInactiveError;

    while (nowFn() < deadline) {
        if (!attemptLifecycle) {
            try {
                attemptLifecycle = await Promise.resolve(loadFn(identity));
            } catch (error) {
                if (error?.code !== 'EDGE_GENERATION_INACTIVE') throw error;
                lastInactiveError = error;
            }
        }

        if (attemptLifecycle) {
            if (attemptLifecycle.generationDigest !== launchGeneration) {
                throw new Error(
                    `no-wait lifecycle generation changed before host launch for '${identity.routeKey}'`,
                );
            }
            let launchStarted = false;
            try {
                await withApplyLockFn(() => {
                    const lockedLifecycle = loadFn(identity);
                    if (lockedLifecycle && typeof lockedLifecycle.then === 'function') {
                        throw new Error('no-wait edge lifecycle inspection must be synchronous under the apply lock');
                    }
                    if (lockedLifecycle.generationDigest !== attemptLifecycle.generationDigest
                        || lockedLifecycle.selectorActivationId !== attemptLifecycle.selectorActivationId) {
                        throw new Error(
                            `no-wait lifecycle activation changed before host launch for '${identity.routeKey}'`,
                        );
                    }
                });
                // Runtime creation is serialized by the already-held network
                // lifecycle capability. The edge lock protects only the exact
                // selector revalidation above and is never held across runtime
                // mutation or readiness.
                launchStarted = true;
                return await launch();
            } catch (error) {
                // Only the lock-protected lifecycle read is retryable. Once
                // runtime creation starts, never replay it, even if the runtime
                // implementation happens to report the same error code.
                if (launchStarted || error?.code !== 'EDGE_GENERATION_INACTIVE') throw error;
                lastInactiveError = error;
                attemptLifecycle = null;
            }
        }

        const remainingMs = deadline - nowFn();
        if (remainingMs <= 0) break;
        // withApplyLockFn has unwound before this wait, so an edge apply can
        // finish and publish a selector while the worker is sleeping.
        await sleepFn(Math.min(boundedPollIntervalMs, remainingMs));
    }

    const error = new Error(
        `timed out waiting for the active edge generation before host launch for '${identity.routeKey}'`,
    );
    error.code = 'NO_WAIT_HOST_LAUNCH_TIMEOUT';
    if (lastInactiveError) error.cause = lastInactiveError;
    throw error;
}

// Warms the local image cache outside every lifecycle lock.
//
// `ensureAgentService` calls ensureImagePresent() while the worker holds the
// workspace mutation lease, so a cold multi-gigabyte pull there starves every
// peer worker until its own lease timeout expires. Doing the same idempotent
// resolution here first makes the in-lease call a cache hit.
//
// This is an optimisation, never an authority: the transaction still resolves
// the definitive image (the hardware catalog picks it for LLM runtimes) and
// still owns the local-build fallback, so every failure here is swallowed.
export function prefetchNoWaitRuntimeImage({
    manifest,
    profileConfig,
    runtime,
    runtimeKind,
    agentName,
    repoName,
    ensureImage = ensureImagePresent,
    resolveImage = resolveManifestImage,
    isLlmRuntime = isLlmRuntimeManifest,
    log = console.log,
} = {}) {
    if (runtimeKind !== 'container') {
        return Object.freeze({ prefetched: false, reason: 'sandbox-runtime' });
    }
    // An LLM runtime takes its image from the hardware-aware catalog, which
    // can differ from the manifest's. Prefetching the manifest image there
    // would download gigabytes that are never used and still leave the real
    // catalog pull inside the lease.
    if (isLlmRuntime(manifest, profileConfig)) {
        return Object.freeze({ prefetched: false, reason: 'llm-runtime-catalog-image' });
    }
    let image = '';
    try {
        image = String(resolveImage(manifest, profileConfig, { agentName, repoName }) || '').trim();
    } catch (error) {
        // A manifest placeholder that cannot resolve here is left to the
        // transaction rather than guessed at.
        return Object.freeze({ prefetched: false, reason: 'unresolved-image' });
    }
    if (!image) return Object.freeze({ prefetched: false, reason: 'unresolved-image' });
    try {
        // Pull only. Same-wave workers run this concurrently and unlocked, so
        // the local-build fallback stays with the serialized in-lease path
        // rather than racing several builds of one tag.
        const pulled = ensureImage(image, {
            ...(runtime ? { runtime } : {}),
            allowLocalBuild: false,
        });
        return Object.freeze({ prefetched: Boolean(pulled), image });
    } catch (error) {
        log(`[no-wait] ${agentName}: image prefetch for '${image}' failed (${error?.message || error}); the lifecycle transaction will resolve it.`);
        return Object.freeze({ prefetched: false, image, reason: 'prefetch-failed' });
    }
}

// Readiness runs immediately before exact task-owned cleanup removes the
// runtime, so this is the last moment its own output can be preserved. The
// tail is bounded and attached to the error, which the worker publishes into
// its terminal status.
export const NO_WAIT_FAILURE_LOG_LINES = 40;
const NO_WAIT_FAILURE_DETAIL_CHARS = 4000;

function boundedFailureText(value) {
    return sanitizeDiagnosticText(String(value || '').trim(), {
        limit: NO_WAIT_FAILURE_DETAIL_CHARS,
        fallback: '',
    });
}

// Runtime output is arbitrary and may echo an injected credential. Diagnostics
// are never allowed to move a secret into a persisted status file or a log, so
// every value this agent could have been given is masked before the text is
// kept. Bounding the length alone would not prevent disclosure.
export function redactNoWaitDiagnostics(value, {
    manifest,
    profileConfig,
    env = process.env,
    manifestEnvNames = getManifestEnvNames,
    exposedNames = getExposedNames,
} = {}) {
    let text = String(value || '');
    if (!text) return '';
    const names = new Set();
    for (const resolve of [manifestEnvNames, exposedNames]) {
        try {
            for (const name of resolve(manifest, profileConfig, { forRuntime: true }) || []) {
                names.add(String(name));
            }
        } catch (_) {
            // A manifest that cannot enumerate its names must not defeat
            // redaction; the generic sweep below still applies.
        }
    }
    for (const name of names) {
        const secret = String(env?.[name] ?? '');
        // Even a short configured value is still an injected value. Losing a
        // little diagnostic context is safer than making credential handling
        // depend on an arbitrary minimum length.
        if (!secret) continue;
        text = text.split(secret).join(`[redacted:${name}]`);
    }
    // Catch shapes that are secret regardless of which variable carried them.
    return sanitizeDiagnosticText(text
        .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted:jwt]')
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '[redacted:authorization]'), {
        secretNames: Array.from(names),
        limit: NO_WAIT_FAILURE_DETAIL_CHARS,
        fallback: '',
    });
}

export function captureNoWaitRuntimeLogTail(containerName, {
    runtime = null,
    runtimeKind = 'container',
    lines = NO_WAIT_FAILURE_LOG_LINES,
    getRuntime: resolveRuntime = dockerSvc.getRuntime,
    spawnSyncImpl = spawnSync,
    redact = (value) => String(value || ''),
} = {}) {
    // Only a container runtime has logs to read, and resolving an engine on a
    // host without one calls process.exit. That would kill the worker before it
    // could clean up or publish a terminal status, turning a readiness failure
    // into a silent stall for every dependent.
    if (runtimeKind !== 'container') return '';
    const container = String(containerName || '').trim();
    if (!container || path.basename(container) !== container) return '';
    try {
        const engine = runtime || resolveRuntime();
        if (!engine) return '';
        const result = spawnSyncImpl(
            engine,
            ['logs', '--tail', String(lines), container],
            { encoding: 'utf8', timeout: 15000 },
        );
        // Redact the complete captured value before retaining a suffix. If a
        // truncation boundary cuts through a secret first, exact-value masking
        // can no longer recognize it and would persist the remaining suffix.
        return boundedFailureText(redact(`${result?.stdout || ''}${result?.stderr || ''}`));
    } catch (_) {
        // Diagnostics must never replace the failure they are describing.
        return '';
    }
}

function readinessFailure(message, {
    detail,
    containerName,
    runtime,
    runtimeKind,
    manifest,
    profileConfig,
} = {}) {
    const redact = (text) => redactNoWaitDiagnostics(text, { manifest, profileConfig });
    const failure = new Error(redact(message));
    const probeDetail = boundedFailureText(redact(detail));
    if (probeDetail) failure.readinessDetail = probeDetail;
    const logTail = captureNoWaitRuntimeLogTail(containerName, {
        runtime,
        runtimeKind,
        redact,
    });
    if (logTail) failure.runtimeLogTail = logTail;
    return failure;
}

async function waitForNoWaitReadiness({
    manifest,
    profileConfig,
    shortAgent,
    containerName,
    hostPort,
    runtimeResult,
    networkMode,
    generationDigest,
    runtime,
    runtimeKind,
}) {
    const protocol = resolveAgentReadinessProtocol(manifest);
    if (protocol === 'none') return;
    if (protocol === 'script') {
        const probe = normalizeProbeConfig('readiness', manifest?.health?.readiness);
        const result = await runNoWaitScriptReadinessWithControlPlaneRetry(
            shortAgent,
            containerName,
            probe,
        );
        if (result?.status !== 'success') {
            // The probe already carries the script's own output, and exact
            // cleanup removes the container moments from now. Attach both here
            // so the published failure explains itself instead of leaving only
            // an exit code and no way left to ask.
            throw readinessFailure(
                `readiness script failed (${result?.reason || 'unknown failure'})`,
                {
                    detail: result?.detail,
                    containerName,
                    runtime,
                    runtimeKind,
                    manifest,
                    profileConfig,
                },
            );
        }
        return;
    }
    const readinessRoute = buildRelayReadinessRoute({
        route: { container: containerName, hostPort: Number(hostPort || 0) },
        manifest,
        runtimeResult,
        networkMode,
        generationDigest,
    });
    if (!readinessRoute.hostPort && !readinessRoute.relay) {
        throw new Error(`readiness protocol '${protocol}' requires one resolved private target or readiness.port`);
    }
    const ready = await waitForAgentReady(readinessRoute, {
        timeoutMs: Number.parseInt(process.env.PLOINKY_NO_WAIT_READY_TIMEOUT_MS || '120000', 10),
        intervalMs: Number.parseInt(process.env.PLOINKY_NO_WAIT_READY_INTERVAL_MS || '250', 10),
        probeTimeoutMs: Number.parseInt(process.env.PLOINKY_NO_WAIT_READY_PROBE_TIMEOUT_MS || '1000', 10),
        protocol,
    });
    if (!ready) {
        throw readinessFailure(
            `readiness protocol '${protocol}' did not succeed`,
            { containerName, runtime, runtimeKind, manifest, profileConfig },
        );
    }
}

async function main() {
    let args;
    try {
        args = parseNoWaitWorkerArgs(process.argv.slice(2));
    } catch (error) {
        console.error(sanitizeDiagnosticText(
            `[no-wait] ${sanitizeDiagnosticText(error)}; refusing to run.`,
            { singleLine: true },
        ));
        process.exit(2);
        return;
    }
    const containerName = args.container;
    const shortAgent = args.shortAgent;
    const repoName = args.repo;
    const alias = args.alias || '';
    const routeKey = args.routeKey || alias || shortAgent;
    const manifestPath = args.manifestPath;
    const agentPath = args.agentPath || (manifestPath ? path.dirname(manifestPath) : '');
    const routerPort = args.routerPort || '';
    const profileName = args.profile || '';

    if (!containerName || !shortAgent || !repoName || !manifestPath || !agentPath) {
        console.error('[no-wait] missing required arguments; refusing to run.');
        console.error('[no-wait] args:', JSON.stringify(args));
        process.exit(2);
    }

    const runScoped = args.runScoped;
    const {
        runId,
        runStartedAtMs,
        waveIndex,
        statusFile: coordinationStatusFile,
        waitForStatuses,
    } = runScoped;

    const publishStatus = (payload) => writeNoWaitWorkerStatus(containerName, payload, {
        runId,
        runStartedAtMs,
        waveIndex,
        statusFile: coordinationStatusFile,
    });

    // A failure before the first live status write must still leave a valid
    // terminal member of this wave barrier. Otherwise a dependent waits out
    // its entire cumulative queued budget for a status that never arrives,
    // exactly the stall the spawn-failure path already avoids.
    const publishPreStartFailure = (failure) => {
        const finishedAtMs = Date.now();
        const finishedAt = new Date(finishedAtMs).toISOString();
        try {
            publishStatus({
                containerName,
                shortAgent,
                repoName,
                alias: alias || null,
                routeKey,
                manifestPath,
                agentPath,
                pid: process.pid,
                state: 'failed',
                sequencePhase: 'active',
                phase: 'admission',
                startedAt: finishedAt,
                startedAtMs: finishedAtMs,
                sequencePhaseStartedAt: finishedAt,
                sequencePhaseStartedAtMs: finishedAtMs,
                finishedAt,
                finishedAtMs,
                error: { message: sanitizeDiagnosticText(failure) },
            });
        } catch (publishFailure) {
            console.error(sanitizeDiagnosticText(
                `[no-wait] ${shortAgent}: could not publish the pre-start failure status: ${sanitizeDiagnosticText(publishFailure)}`,
                { singleLine: true },
            ));
        }
    };

    // Detached workers write status immediately so predecessor workers can
    // sequence behind them. Admission therefore has to precede even that
    // first live status write, not merely the eventual physical start
    // boundary; only a terminal failure may be published before it succeeds.
    const admitRuntime = () => {
        const admittedManifestBytes = fs.readFileSync(manifestPath);
        const admittedManifest = JSON.parse(admittedManifestBytes.toString('utf8'));
        const admittedProfileResolution = resolveManifestRuntimeProfile(admittedManifest, {
            agentName: `${repoName}/${shortAgent}`,
            profileName: profileName || undefined,
            path: `manifest(${repoName}/${shortAgent})`,
        });
        const admittedRuntime = getRuntimeForAgent(admittedManifest);
        const admittedRuntimeKind = isSandboxRuntime(admittedRuntime) ? admittedRuntime : 'container';
        const llmAdmissionContext = admittedRuntimeKind === 'container'
            ? resolveLlmRuntimeAdmissionContext({
                runtime: admittedRuntime,
                manifest: admittedManifest,
                profileConfig: admittedProfileResolution.profileConfig,
                agentName: shortAgent,
                alias,
                env: process.env,
            })
            : { catalogPolicy: null, catalogIdentity: null };
        const runtimeAdmission = admitManifestRuntimeCapabilities(admittedManifest, {
            manifestBytes: admittedManifestBytes,
            manifestPath,
            agentId: `${repoName}/${shortAgent}`,
            profileName: admittedProfileResolution.resolvedProfileName,
            profileConfig: admittedProfileResolution.profileConfig,
            network: admittedProfileResolution.network,
            runtime: admittedRuntime,
            runtimeKind: admittedRuntimeKind,
            catalogPolicy: llmAdmissionContext.catalogPolicy,
            catalogIdentity: llmAdmissionContext.catalogIdentity,
        });
        assertRuntimeAdmissionCurrent(runtimeAdmission, {
            manifestBytes: fs.readFileSync(manifestPath),
            profileName: admittedProfileResolution.resolvedProfileName,
            runtimeKind: admittedRuntimeKind,
        });
        return Object.freeze({
            admittedManifest,
            admittedProfileResolution,
            admittedRuntime,
            admittedRuntimeKind,
            runtimeAdmission,
        });
    };

    let admission;
    try {
        admission = admitRuntime();
    } catch (error) {
        publishPreStartFailure(error);
        console.error(sanitizeDiagnosticText(
            `[no-wait] ${shortAgent}: runtime admission failed: ${sanitizeDiagnosticText(error)}`,
            { singleLine: true },
        ));
        if (error?.stack) console.error(sanitizeDiagnosticText(error.stack));
        process.exit(1);
    }
    const {
        admittedManifest,
        admittedProfileResolution,
        admittedRuntime,
        admittedRuntimeKind,
        runtimeAdmission,
    } = admission;
    const hasWaveBarrier = waitForStatuses.length > 0;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let baseStatus = {
        containerName,
        shortAgent,
        repoName,
        alias: alias || null,
        routeKey,
        manifestPath,
        agentPath,
        pid: process.pid,
        startedAt,
        startedAtMs,
        runId,
        runStartedAtMs,
        waveIndex,
        sequencePhase: hasWaveBarrier ? 'waiting-barrier' : 'active',
        sequencePhaseStartedAt: startedAt,
        sequencePhaseStartedAtMs: startedAtMs,
        // Diagnostic only. A status reader must never follow these references.
        barrierStatuses: waitForStatuses.map((entry) => ({
            file: path.basename(entry.path),
            waveIndex: entry.waveIndex,
            directDependency: entry.directDependency,
        })),
    };
    publishStatus({ ...baseStatus, state: 'starting' });

    console.log(`[no-wait] ${shortAgent}: starting background launch (pid ${process.pid})`);

    try {
        await waitForNoWaitStatusBarrier(waitForStatuses, {
            runId,
            runStartedAtMs,
            waveIndex,
        });
        if (hasWaveBarrier) {
            const sequencePhaseStartedAtMs = Date.now();
            baseStatus = {
                ...baseStatus,
                sequencePhase: 'active',
                sequencePhaseStartedAt: new Date(sequencePhaseStartedAtMs).toISOString(),
                sequencePhaseStartedAtMs,
            };
            publishStatus({ ...baseStatus, state: 'starting' });
        }
        // Warm the image cache before any lifecycle lock is taken.
        // `ensureAgentService` resolves the same image under the workspace
        // mutation lease, so a cold pull there blocks every peer worker until
        // its lease timeout. Pulling here is idempotent and lock-free; the
        // authoritative resolution (including the catalog image for LLM
        // runtimes and the local-build fallback) still happens inside the
        // transaction, so a failure here is never fatal on its own.
        //
        // A pull is still a cache mutation, and the manifest can change while
        // this worker sits behind its wave barrier. Re-assert the admission
        // immediately before pulling so a superseded or denied launch cannot
        // fetch an image on the strength of a stale admission.
        assertRuntimeAdmissionCurrent(runtimeAdmission, {
            manifestBytes: fs.readFileSync(manifestPath),
            profileName: admittedProfileResolution.resolvedProfileName,
            runtimeKind: admittedRuntimeKind,
        });
        prefetchNoWaitRuntimeImage({
            manifest: admittedManifest,
            profileConfig: admittedProfileResolution.profileConfig,
            runtime: admittedRuntime,
            runtimeKind: admittedRuntimeKind,
            agentName: shortAgent,
            repoName,
        });

        const expectedIdentity = Object.freeze({
            containerName,
            repoName,
            shortAgent,
            alias,
            routeKey,
            agentPath,
        });
        await runNoWaitLifecycleTransaction(expectedIdentity, {
            capture(lifecycle) {
                const manifest = lifecycle.manifest;
                const activeProfile = String(lifecycle.record.profile || '');
                if (profileName && activeProfile && profileName !== activeProfile) {
                    throw new Error(`no-wait lifecycle profile changed before launch for '${routeKey}'`);
                }
                if (routerPort && Number(routerPort) !== lifecycle.routerPort) {
                    throw new Error(`no-wait lifecycle Router port changed before launch for '${routeKey}'`);
                }
                const profileResolution = resolveManifestRuntimeProfile(manifest, {
                    agentName: `${repoName}/${shortAgent}`,
                    profileName: activeProfile || profileName || undefined,
                    path: `manifest(${repoName}/${shortAgent})`,
                });
                if (!isDeepStrictEqual(manifest, admittedManifest)
                    || profileResolution.resolvedProfileName
                        !== admittedProfileResolution.resolvedProfileName) {
                    const changed = new Error(
                        `no-wait runtime input changed before launch for '${routeKey}'`,
                    );
                    changed.code = 'PLOINKY_RUNTIME_INPUT_CHANGED';
                    changed.status = 409;
                    throw changed;
                }
                assertRuntimeAdmissionCurrent(runtimeAdmission, {
                    manifestBytes: fs.readFileSync(manifestPath),
                    profileName: profileResolution.resolvedProfileName,
                    runtimeKind: admittedRuntimeKind,
                });
                const routerEndpoint = resolveRouterEndpoint(profileResolution.network.mode, {
                    explicitPort: lifecycle.routerPort || undefined,
                });
                const adopted = lifecycle.targetState === 'ready'
                    && !['default', 'bridge'].includes(profileResolution.network.mode);
                return {
                    manifest,
                    profileResolution,
                    routerEndpoint,
                    adopted,
                    requiresEnsure: !adopted,
                    ...(adopted ? {
                        runtimeResult: {
                            containerName,
                            containerId: lifecycle.record.containerId,
                            hostPort: Number(lifecycle.route.hostPort),
                            registryRecord: lifecycle.record,
                        },
                    } : {}),
                };
            },
            async ensure(lifecycle, context, networkLifecycleCapability) {
                const ensureOptions = {
                    containerName,
                    alias: alias || undefined,
                    profileName: context.profileResolution.resolvedProfileName,
                    profileResolution: context.profileResolution,
                    routerEndpoint: context.routerEndpoint,
                    forceRecreate: args.forceRecreate === '1',
                    preservePreparedRegistryRecord: true,
                    instanceId: lifecycle.record.instanceId,
                    enableGeneration: lifecycle.record.enableGeneration,
                    networkLifecycleCapability,
                };
                const launch = () => dockerSvc.ensureAgentService(
                    shortAgent,
                    context.manifest,
                    agentPath,
                    ensureOptions,
                );
                return context.profileResolution.network.mode === 'host'
                    ? launchNoWaitHostRuntime(expectedIdentity, lifecycle, launch)
                    : launch();
            },
            readiness(lifecycle, context, result) {
                return waitForNoWaitReadiness({
                    manifest: context.manifest,
                    profileConfig: context.profileResolution.profileConfig,
                    shortAgent,
                    containerName: result?.containerName || containerName,
                    hostPort: result?.hostPort,
                    runtimeResult: result,
                    networkMode: context.profileResolution.network.mode,
                    generationDigest: lifecycle.generationDigest,
                    // A sandbox runtime has no container logs, and resolving a
                    // container engine on a host without one would exit the
                    // process before cleanup or a terminal status could run.
                    runtime: admittedRuntime,
                    runtimeKind: admittedRuntimeKind,
                });
            },
            revalidate(initialLifecycle, currentLifecycle) {
                return initialLifecycle.targetState === 'ready'
                    ? assertNoWaitAdoptionStillCurrent(
                        initialLifecycle,
                        currentLifecycle,
                        expectedIdentity,
                    )
                    : assertNoWaitLifecycleRebase(
                        initialLifecycle,
                        currentLifecycle,
                        expectedIdentity,
                    );
            },
            inspectRuntime(result, context, lifecycle, _networkLifecycleCapability, {
                cleanup = false,
            } = {}) {
                const resolvedContainerName = result?.containerName || containerName;
                if (resolvedContainerName !== containerName) {
                    throw new Error(
                        `no-wait runtime resolved an unexpected container identity for '${routeKey}'`,
                    );
                }
                assertNoWaitRegistryRecord(
                    result?.registryRecord,
                    lifecycle.record,
                    expectedIdentity,
                );
                return assertNoWaitRuntimeStillExact(result, {
                    profileResolution: context.profileResolution,
                    expectedIdentity,
                }, {
                    // A failed runtime may have exited before readiness can
                    // initiate cleanup. Its immutable container contract and
                    // ID still authorize exact task-owned removal; liveness is
                    // required only on the publication path.
                    requireRunning: !cleanup,
                });
            },
            async activate(lifecycle, context, result, {
                networkLifecycleCapability,
                onCommitted,
            }) {
                const resolvedContainerName = result?.containerName || containerName;
                const hostPort = result?.hostPort;
                const routedHostPort = context.profileResolution.network.mode === 'none'
                    ? null
                    : hostPort || null;
                if (!context.adopted) {
                    await upsertRoute(routeKey, {
                        container: resolvedContainerName,
                        hostPath: agentPath,
                        repo: repoName,
                        agent: shortAgent,
                        ...(alias ? { alias } : {}),
                        hostPort: routedHostPort,
                    }, {
                        containerName: resolvedContainerName,
                        registryRecord: result.registryRecord,
                        expectedIdentity,
                        expectedLifecycle: lifecycle,
                        expectedSelector: {
                            generation: lifecycle.generationDigest,
                            activationId: lifecycle.selectorActivationId,
                        },
                        preparationLease: result?.preparationLease,
                        networkLifecycleCapability,
                    });
                }
                onCommitted();
                const finishedAtMs = Date.now();
                publishStatus({
                    ...baseStatus,
                    state: 'running',
                    finishedAt: new Date(finishedAtMs).toISOString(),
                    finishedAtMs,
                    container: resolvedContainerName,
                    hostPort: routedHostPort,
                    ...(context.adopted ? { adopted: true } : {}),
                });
                console.log(context.adopted
                    ? `[no-wait] ${shortAgent}: adopted existing ready runtime (container=${containerName}, hostPort=${routedHostPort})`
                    : `[no-wait] ${shortAgent}: launch succeeded (container=${resolvedContainerName}${hostPort ? `, hostPort=${hostPort}` : ''})`);
            },
        });
    } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        const finishedAtMs = Date.now();
        const finishedAt = new Date(finishedAtMs).toISOString();
        const redactFailure = (value) => boundedFailureText(redactNoWaitDiagnostics(value, {
            manifest: admittedManifest,
            profileConfig: admittedProfileResolution.profileConfig,
        }));
        // Carry the readiness probe's own output and the runtime log tail into
        // the terminal status. Cleanup has already removed the container by
        // now, so this is the only surviving explanation of the failure.
        const error = {
            message: redactFailure(failure.message),
            stack: failure.stack ? redactFailure(failure.stack) : null,
            ...(failure.readinessDetail ? { readinessDetail: failure.readinessDetail } : {}),
            ...(failure.runtimeLogTail ? { runtimeLogTail: failure.runtimeLogTail } : {}),
        };
        publishStatus({
            ...baseStatus,
            state: 'failed',
            finishedAt,
            finishedAtMs,
            error
        });
        if (failure.readinessDetail) {
            console.error(`[no-wait] ${shortAgent}: readiness output:\n${failure.readinessDetail}`);
        }
        if (failure.runtimeLogTail) {
            console.error(`[no-wait] ${shortAgent}: runtime log tail:\n${failure.runtimeLogTail}`);
        }
        console.error(`[no-wait] ${shortAgent}: launch failed: ${error.message}`);
        if (error.stack) console.error(error.stack);
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(sanitizeDiagnosticText(
            `[no-wait] worker crashed: ${sanitizeDiagnosticText(err)}`,
            { singleLine: true },
        ));
        if (err?.stack) console.error(sanitizeDiagnosticText(err.stack));
        process.exit(1);
    });
}
