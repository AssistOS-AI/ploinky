// Detached helper that boots a single `no-wait` dependency in the background
// after `startWorkspace` has finished gating on its blocking dependencies.
//
// The script is invoked via `node noWaitWorker.js --container <name> ...` from
// `startWorkspace` and inherits the workspace cwd and environment. In a managed
// Box, cryptographic operations resolve the key from `.ploinky/master-key`; the
// key is not inherited as an environment variable. The worker writes:
//   - a single log stream at .ploinky/logs/no-wait/<container>.log (stdout+stderr)
//   - a structured status JSON at .ploinky/running/no-wait/<container>.json
// Failures here must never bubble up to the main start command; they are
// recorded durably so an operator can see what went wrong without losing the
// already-running blocking stack.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as dockerSvc from '../sandbox/docker/index.js';
import { RUNNING_DIR } from '../utils/config.js';
import { resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import { getRuntimeForAgent, isSandboxRuntime } from '../sandbox/docker/common.js';
import { resolveLlmRuntimeAdmissionContext } from '../sandbox/docker/llmRuntimeIntegration.js';
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

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
        out[key] = value;
        if (value) i += 1;
    }
    return out;
}

function camelKey(key) {
    return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function statusPathFor(containerName, { runningDir = RUNNING_DIR } = {}) {
    return path.join(runningDir, 'no-wait', `${containerName}.json`);
}

function writeStatusFile(target, payload) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), {
            flag: 'wx',
            mode: 0o600,
        });
        fs.renameSync(temporary, target);
    } finally {
        try { fs.unlinkSync(temporary); } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

export function writeStatus(containerName, payload, { runningDir = RUNNING_DIR } = {}) {
    writeStatusFile(statusPathFor(containerName, { runningDir }), payload);
}

export function writeNoWaitWorkerStatus(containerName, payload, {
    runId = '',
    statusFile = '',
    runningDir = RUNNING_DIR,
} = {}) {
    if (Boolean(runId) !== Boolean(statusFile)) {
        throw new Error('run-scoped no-wait status requires both a run id and coordination file');
    }
    const normalizedRunId = runId ? exactRunId(runId) : '';
    const coordinationStatusFile = statusFile
        ? exactNoWaitCoordinationStatusPath(statusFile, {
            containerName,
            runId: normalizedRunId,
            runningDir,
        })
        : '';
    const document = normalizedRunId
        ? { ...payload, runId: normalizedRunId }
        : payload;
    const canonicalStatusFile = statusPathFor(containerName, { runningDir });

    // The unique coordination file is the final handoff. Publish the public
    // canonical view first so a completed wave barrier never exposes an older
    // canonical phase to monitors or operators.
    writeStatusFile(canonicalStatusFile, document);
    if (coordinationStatusFile && coordinationStatusFile !== canonicalStatusFile) {
        writeStatusFile(coordinationStatusFile, document);
    }
    return document;
}

function exactNoWaitStatusPath(rawStatusPath, {
    runningDir = RUNNING_DIR,
    label = 'no-wait status',
} = {}) {
    const statusPath = path.resolve(String(rawStatusPath || ''));
    const statusRoot = path.resolve(runningDir, 'no-wait');
    if (!path.isAbsolute(String(rawStatusPath || ''))
        || path.dirname(statusPath) !== statusRoot
        || path.extname(statusPath) !== '.json') {
        throw new Error(`${label} must be an absolute JSON file in the workspace no-wait status directory`);
    }
    return statusPath;
}

function exactRunId(value, label = 'no-wait run id') {
    const runId = String(value || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
        throw new Error(`${label} must be one exact UUID`);
    }
    return runId.toLowerCase();
}

function exactNoWaitCoordinationStatusPath(rawStatusPath, {
    containerName,
    runId,
    runningDir = RUNNING_DIR,
} = {}) {
    const statusPath = exactNoWaitStatusPath(rawStatusPath, {
        runningDir,
        label: 'no-wait coordination status',
    });
    const expectedName = `${String(containerName || '')}.${exactRunId(runId)}.json`;
    if (path.basename(statusPath) !== expectedName) {
        throw new Error(
            `no-wait coordination status must be the exact run-scoped file '${expectedName}'`,
        );
    }
    return statusPath;
}

export function parseNoWaitStatusBarrier(rawBarrier, {
    runId,
    runningDir = RUNNING_DIR,
} = {}) {
    if (!rawBarrier) return Object.freeze([]);
    const expectedRunId = exactRunId(runId);
    let parsed;
    try {
        parsed = JSON.parse(String(rawBarrier));
    } catch (error) {
        throw new Error(`no-wait status barrier is invalid JSON: ${error?.message || error}`);
    }
    if (!Array.isArray(parsed) || parsed.length > 1024) {
        throw new Error('no-wait status barrier must be an array with at most 1024 entries');
    }
    const seen = new Set();
    return Object.freeze(parsed.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || typeof entry.directDependency !== 'boolean') {
            throw new Error(`no-wait status barrier entry ${index} is invalid`);
        }
        const entryRunId = exactRunId(entry.runId, `no-wait status barrier entry ${index} run id`);
        if (entryRunId !== expectedRunId) {
            throw new Error(`no-wait status barrier entry ${index} belongs to a different run`);
        }
        const statusPath = exactNoWaitStatusPath(entry.path, {
            runningDir,
            label: `no-wait status barrier entry ${index}`,
        });
        if (seen.has(statusPath)) {
            throw new Error(`no-wait status barrier repeats '${path.basename(statusPath)}'`);
        }
        seen.add(statusPath);
        return Object.freeze({
            path: statusPath,
            runId: entryRunId,
            directDependency: entry.directDependency,
        });
    }));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSequenceTimestamp(status, numericField, isoField) {
    const numeric = Number(status?.[numericField]);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const parsed = Date.parse(String(status?.[isoField] || ''));
    return Number.isFinite(parsed) ? parsed : NaN;
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

function resolveSequenceObservation(statusPath, status, {
    statusRoot,
    timeoutMs,
    terminalPublicationGraceMs,
    legacyDeadline,
    nowMs,
    maxDepth = 128,
    retainFailedWaitingChain = true,
} = {}) {
    let currentPath = statusPath;
    let current = status;
    const visited = new Set();

    for (let depth = 0; depth < maxDepth; depth += 1) {
        if (visited.has(currentPath)) {
            throw new Error('no-wait predecessor status chain contains a cycle');
        }
        visited.add(currentPath);

        // A worker that failed before it became active did not complete the
        // serialized launch slot. Keep following its retained predecessor
        // reference so its successor cannot overlap the still-active worker.
        // Once that predecessor settles, this chain remains fail-closed and
        // expires at the predecessor's bounded publication deadline.
        const failedWhileWaiting = retainFailedWaitingChain
            && current?.state === 'failed'
            && current?.sequencePhase === 'waiting-predecessor';
        if ((current?.state === 'running' || current?.state === 'failed')
            && !failedWhileWaiting) {
            if (currentPath === statusPath) return { terminal: current.state };
            const finishedAtMs = parseSequenceTimestamp(current, 'finishedAtMs', 'finishedAt');
            if (!Number.isFinite(finishedAtMs) || finishedAtMs > nowMs + terminalPublicationGraceMs) {
                throw new Error('no-wait predecessor terminal status has an invalid completion timestamp');
            }
            return { deadline: finishedAtMs + terminalPublicationGraceMs };
        }
        if (current?.state && current.state !== 'starting' && !failedWhileWaiting) {
            throw new Error(`no-wait predecessor has invalid state '${current.state}'`);
        }
        if (!current?.state) {
            throw new Error('no-wait predecessor status is missing its state');
        }

        // Legacy workers did not publish a sequence phase. Keep their original
        // single bounded window so mixed-version state fails closed.
        if (!current.sequencePhase) return { deadline: legacyDeadline };

        if (current.sequencePhase === 'active') {
            const phaseStartedAtMs = parseSequenceTimestamp(
                current,
                'sequencePhaseStartedAtMs',
                'sequencePhaseStartedAt',
            );
            if (!Number.isFinite(phaseStartedAtMs)
                || phaseStartedAtMs > nowMs + terminalPublicationGraceMs) {
                throw new Error('no-wait predecessor active phase has an invalid start timestamp');
            }
            return { deadline: phaseStartedAtMs + timeoutMs + terminalPublicationGraceMs };
        }

        if (current.sequencePhase !== 'waiting-predecessor') {
            throw new Error(`no-wait predecessor has invalid sequence phase '${current.sequencePhase}'`);
        }
        const predecessorFile = String(current.waitForStatusFile || '');
        if (!predecessorFile
            || path.basename(predecessorFile) !== predecessorFile
            || path.extname(predecessorFile) !== '.json') {
            throw new Error('no-wait predecessor waiting phase has an invalid status reference');
        }
        currentPath = path.join(statusRoot, predecessorFile);
        const readResult = readSequenceStatus(currentPath);
        if (readResult.missing) return { deadline: legacyDeadline };
        if (readResult.readFault) {
            return {
                deadline: legacyDeadline,
                readFault: readResult.readFault,
            };
        }
        current = readResult.status;
    }
    throw new Error('no-wait predecessor status chain exceeds the maximum depth');
}

export async function waitForPriorWorker(rawStatusPath, {
    runningDir = RUNNING_DIR,
    timeoutMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_SEQUENCE_TIMEOUT_MS || '900000',
        10,
    ),
    terminalPublicationGraceMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_SEQUENCE_TERMINAL_GRACE_MS || '60000',
        10,
    ),
    readRetryTimeoutMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_STATUS_READ_RETRY_MS || '5000',
        10,
    ),
    pollIntervalMs = 100,
    sleepFn = sleep,
    nowFn = Date.now,
    expectedRunId = '',
    retainFailedWaitingChain = true,
} = {}) {
    if (!rawStatusPath) return;
    const statusPath = path.resolve(rawStatusPath);
    const allowedRoot = `${path.resolve(runningDir, 'no-wait')}${path.sep}`;
    if (!statusPath.startsWith(allowedRoot) || path.extname(statusPath) !== '.json') {
        throw new Error('no-wait predecessor status must be an exact file in the workspace no-wait status directory');
    }
    const boundedTimeoutMs = Number.isFinite(timeoutMs)
        ? Math.min(Math.max(1000, timeoutMs), 3600000)
        : 900000;
    const boundedTerminalPublicationGraceMs = Number.isFinite(terminalPublicationGraceMs)
        ? Math.min(Math.max(0, terminalPublicationGraceMs), 300000)
        : 60000;
    const boundedReadRetryTimeoutMs = Number.isFinite(readRetryTimeoutMs)
        ? Math.min(Math.max(100, readRetryTimeoutMs), 30000)
        : 5000;
    const legacyDeadline = nowFn() + boundedTimeoutMs + boundedTerminalPublicationGraceMs;
    const statusRoot = path.resolve(runningDir, 'no-wait');
    let readFaultStartedAtMs = null;
    let lastReadFault = null;
    while (true) {
        const nowMs = nowFn();
        let observation = { deadline: legacyDeadline };
        const readResult = readSequenceStatus(statusPath);
        if (readResult.readFault) {
            observation = {
                deadline: legacyDeadline,
                readFault: readResult.readFault,
            };
        } else if (!readResult.missing) {
            try {
                if (expectedRunId
                    && String(readResult.status?.runId || '').trim().toLowerCase()
                        !== String(expectedRunId).trim().toLowerCase()) {
                    throw new Error('no-wait predecessor status belongs to a different run');
                }
                observation = resolveSequenceObservation(statusPath, readResult.status, {
                    statusRoot,
                    timeoutMs: boundedTimeoutMs,
                    terminalPublicationGraceMs: boundedTerminalPublicationGraceMs,
                    legacyDeadline,
                    nowMs,
                    retainFailedWaitingChain,
                });
            } catch (error) {
                throw new Error(`no-wait predecessor status is invalid: ${error?.message || error}`);
            }
        }
        if (observation.terminal) {
            return Object.freeze({ state: observation.terminal });
        }
        let deadline = observation.deadline;
        if (observation.readFault) {
            if (readFaultStartedAtMs === null) readFaultStartedAtMs = nowMs;
            lastReadFault = observation.readFault;
            deadline = Math.min(
                deadline,
                readFaultStartedAtMs + boundedReadRetryTimeoutMs,
            );
        } else {
            readFaultStartedAtMs = null;
            lastReadFault = null;
        }
        if (nowMs >= deadline) {
            if (lastReadFault) {
                throw new Error(
                    `no-wait predecessor status remained unreadable after bounded retries: ${lastReadFault?.message || lastReadFault}`,
                );
            }
            break;
        }
        await sleepFn(Math.min(pollIntervalMs, deadline - nowMs));
    }
    throw new Error(`timed out waiting for no-wait predecessor status '${statusPath}'`);
}

export async function waitForNoWaitStatusBarrier(entries, {
    waitFn = waitForPriorWorker,
    waitOptions = {},
} = {}) {
    const barrier = Array.isArray(entries) ? entries : [];
    const observed = await Promise.all(barrier.map(async (entry) => Object.freeze({
        entry,
        status: await waitFn(entry.path, {
            ...waitOptions,
            expectedRunId: entry.runId,
            // Run-scoped waves wait every immediately prior-wave member
            // directly. A failed queued member is therefore terminal for this
            // barrier and must not inherit the legacy single-chain stall rule.
            retainFailedWaitingChain: false,
        }),
    })));
    const failedDependency = observed.find(({ entry, status }) => (
        entry.directDependency && status?.state === 'failed'
    ));
    if (failedDependency) {
        const error = new Error(
            `no-wait direct dependency '${path.basename(failedDependency.entry.path, '.json')}' failed in this run`,
        );
        error.code = 'PLOINKY_NO_WAIT_DIRECT_DEPENDENCY_FAILED';
        throw error;
    }
    return Object.freeze(observed);
}

async function upsertRoute(routeKey, route, {
    containerName,
    registryRecord,
    expectedIdentity,
    expectedLifecycle,
    expectedSelector,
    preparationLease,
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
    isContainerRunning = dockerSvc.isContainerRunning,
    isSandboxRunning = isBwrapProcessRunning,
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
    if (inspection?.state !== 'exact'
        || String(inspection.id || '').trim().toLowerCase() !== returnedContainerId
        || !isContainerRunning(containerName)) {
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
        await withLifecycleLease(identity, cleanupWhileWorkspaceLocked, {
            operation: `no-wait-cleanup:${String(identity?.containerName || identity?.routeKey || 'unknown')}`,
        });
    };

    try {
        const initialPhase = await withLifecycleLease(identity, async (lifecycle) => {
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
        });
        if (initialPhase.completed) return initialPhase.value;

        // The expensive semantic readiness wait is intentionally outside both
        // mutation locks for ordinary fresh/adoptable runtimes.
        await readiness(initialLifecycle, context, result);

        return await withLifecycleLease(identity, async (currentLifecycle) => {
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
        });
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
            if (error?.code !== 'EDGE_GENERATION_INACTIVE') throw error;
        }
        await sleepFn(pollIntervalMs);
    }
    throw new Error(`timed out waiting for the active edge generation for '${identity.routeKey}'`);
}

export async function withActiveNoWaitWorkerLifecycleLease(identity, callback, {
    timeoutMs = Number.parseInt(
        process.env.PLOINKY_NO_WAIT_EDGE_TIMEOUT_MS || '180000',
        10,
    ),
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
    const parsedTimeoutMs = Number(timeoutMs);
    const boundedTimeoutMs = Number.isFinite(parsedTimeoutMs)
        ? Math.max(1000, parsedTimeoutMs)
        : 180000;
    const parsedPollIntervalMs = Number(pollIntervalMs);
    const boundedPollIntervalMs = Number.isFinite(parsedPollIntervalMs)
        ? Math.max(1, parsedPollIntervalMs)
        : 250;
    const deadline = nowFn() + boundedTimeoutMs;

    while (nowFn() < deadline) {
        let observedLifecycle;
        try {
            // Publication must be able to reacquire the shared lease while a
            // retryable failure has left the selector inactive. Never wait for
            // an active selector from inside the workspace mutation lease.
            observedLifecycle = loadFn(identity);
        } catch (error) {
            if (error?.code !== 'EDGE_GENERATION_INACTIVE') throw error;
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
                if (error?.code === 'EDGE_GENERATION_INACTIVE') return { retry: true };
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

async function waitForNoWaitReadiness({
    manifest,
    shortAgent,
    containerName,
    hostPort,
    runtimeResult,
    networkMode,
    generationDigest,
}) {
    const protocol = resolveAgentReadinessProtocol(manifest);
    if (protocol === 'none') return;
    if (protocol === 'script') {
        const probe = normalizeProbeConfig('readiness', manifest?.health?.readiness);
        const result = await Promise.resolve(runContainerScriptReadiness(shortAgent, containerName, probe));
        if (result?.status !== 'success') {
            throw new Error(`readiness script failed (${result?.reason || 'unknown failure'})`);
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
    if (!ready) throw new Error(`readiness protocol '${protocol}' did not succeed`);
}

async function main() {
    const rawArgs = parseArgs(process.argv.slice(2));
    const args = Object.fromEntries(Object.entries(rawArgs).map(([k, v]) => [camelKey(k), v]));
    const containerName = args.container;
    const shortAgent = args.shortAgent;
    const repoName = args.repo;
    const alias = args.alias || '';
    const routeKey = args.routeKey || alias || shortAgent;
    const manifestPath = args.manifestPath;
    const agentPath = args.agentPath || (manifestPath ? path.dirname(manifestPath) : '');
    const routerPort = args.routerPort || '';
    const profileName = args.profile || '';
    const waitForStatus = args.waitForStatus || '';
    const runId = args.runId ? exactRunId(args.runId) : '';
    if (Boolean(runId) !== Boolean(args.statusFile)) {
        throw new Error('run-scoped no-wait launch requires both --run-id and --status-file');
    }
    const coordinationStatusFile = args.statusFile
        ? exactNoWaitCoordinationStatusPath(args.statusFile, {
            containerName,
            runId,
        })
        : '';
    const waitForStatuses = parseNoWaitStatusBarrier(args.waitForStatuses || '', { runId });
    if (waitForStatuses.length && !runId) {
        throw new Error('run-scoped no-wait status barriers require --run-id');
    }

    if (!containerName || !shortAgent || !repoName || !manifestPath || !agentPath) {
        console.error('[no-wait] missing required arguments; refusing to run.');
        console.error('[no-wait] args:', JSON.stringify(args));
        process.exit(2);
    }

    // Detached workers write status immediately so predecessor workers can
    // sequence behind them. Admission therefore has to precede even that
    // first status write, not merely the eventual physical start boundary.
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

    const publishStatus = (payload) => writeNoWaitWorkerStatus(containerName, payload, {
        runId,
        statusFile: coordinationStatusFile,
    });
    const hasPredecessorBarrier = Boolean(waitForStatus || waitForStatuses.length);
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
        ...(runId ? { runId } : {}),
        sequencePhase: hasPredecessorBarrier ? 'waiting-predecessor' : 'active',
        sequencePhaseStartedAt: startedAt,
        sequencePhaseStartedAtMs: startedAtMs,
        ...(waitForStatus ? { waitForStatusFile: path.basename(waitForStatus) } : {}),
        ...(waitForStatuses.length ? {
            waitForStatusFiles: waitForStatuses.map((entry) => path.basename(entry.path)),
        } : {}),
    };
    publishStatus({ ...baseStatus, state: 'starting' });

    console.log(`[no-wait] ${shortAgent}: starting background launch (pid ${process.pid})`);

    try {
        await Promise.all([
            waitForPriorWorker(waitForStatus),
            waitForNoWaitStatusBarrier(waitForStatuses),
        ]);
        if (hasPredecessorBarrier) {
            const sequencePhaseStartedAtMs = Date.now();
            baseStatus = {
                ...baseStatus,
                sequencePhase: 'active',
                sequencePhaseStartedAt: new Date(sequencePhaseStartedAtMs).toISOString(),
                sequencePhaseStartedAtMs,
            };
            delete baseStatus.waitForStatusFile;
            delete baseStatus.waitForStatusFiles;
            publishStatus({ ...baseStatus, state: 'starting' });
        }
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
                    shortAgent,
                    containerName: result?.containerName || containerName,
                    hostPort: result?.hostPort,
                    runtimeResult: result,
                    networkMode: context.profileResolution.network.mode,
                    generationDigest: lifecycle.generationDigest,
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
            inspectRuntime(result, context, lifecycle) {
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
                });
            },
            async activate(lifecycle, context, result, { onCommitted }) {
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
        const error = {
            message: failure.message,
            stack: failure.stack || null
        };
        publishStatus({
            ...baseStatus,
            state: 'failed',
            finishedAt,
            finishedAtMs,
            error
        });
        console.error(`[no-wait] ${shortAgent}: launch failed: ${error.message}`);
        if (err?.stack) console.error(err.stack);
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error('[no-wait] worker crashed:', err?.message || err);
        if (err?.stack) console.error(err.stack);
        process.exit(1);
    });
}
