// Detached helper that boots a single `no-wait` dependency in the background
// after `startWorkspace` has finished gating on its blocking dependencies.
//
// The script is invoked via `node noWaitWorker.js --container <name> ...` from
// `startWorkspace`, inherits the workspace cwd, env, and `PLOINKY_MASTER_KEY`,
// and writes:
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
import { withNetworkLifecycleLock } from '../sandbox/networkLifecycle.js';
import { withWorkspaceMutationLease } from '../utils/runtime/maintenanceLocks.js';

const EXACT_NO_WAIT_RUNTIMES = new Set(['podman', 'bwrap', 'seatbelt']);
const IMMUTABLE_CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const EXACT_NO_WAIT_STATES = new Set(['starting', 'running', 'failed']);

function isExactIdentityText(value) {
    return typeof value === 'string' && value !== '' && value === value.trim();
}

function assertExactNoWaitRuntime(runtime, description = 'no-wait lifecycle') {
    if (typeof runtime !== 'string' || !EXACT_NO_WAIT_RUNTIMES.has(runtime)) {
        const error = new Error(
            `${description} requires one exact selected runtime (podman, bwrap, or seatbelt)`,
        );
        error.code = 'PLOINKY_NO_WAIT_RUNTIME_MISMATCH';
        throw error;
    }
    return runtime;
}

function assertExactNoWaitIdentity(identity, description = 'no-wait identity') {
    const runtime = assertExactNoWaitRuntime(identity?.runtime, description);
    if (!isExactIdentityText(identity?.containerName)
        || !isExactIdentityText(identity?.instanceId)
        || !isExactIdentityText(identity?.enableGeneration)) {
        throw new Error(`${description} requires exact container, instance, and enable-generation identity`);
    }
    const ownsContainerId = Object.prototype.hasOwnProperty.call(identity, 'containerId');
    if (runtime === 'podman') {
        if (ownsContainerId && (typeof identity.containerId !== 'string'
            || !IMMUTABLE_CONTAINER_ID_PATTERN.test(identity.containerId))) {
            throw new Error(`${description} has an invalid immutable Podman container identity`);
        }
    } else if (ownsContainerId) {
        throw new Error(`${description} must not attach a Podman container identity to '${runtime}'`);
    }
    return identity;
}

export function assertNoWaitStatusIdentity(status, expectedIdentity = null, {
    description = 'exact no-wait status identity',
} = {}) {
    if (!status || typeof status !== 'object' || Array.isArray(status)
        || !EXACT_NO_WAIT_STATES.has(status.state)) {
        throw new Error(`${description} requires one exact status state`);
    }
    assertExactNoWaitIdentity(status, description);
    if (status.runtime === 'podman'
        && !IMMUTABLE_CONTAINER_ID_PATTERN.test(String(status.containerId || ''))) {
        throw new Error(`${description} requires an immutable lowercase 64-hex Podman container ID`);
    }
    if (!expectedIdentity) return status;
    assertExactNoWaitIdentity(expectedIdentity, `${description} expectation`);
    const fields = ['runtime', 'containerName', 'instanceId', 'enableGeneration'];
    const mismatch = fields.some((field) => status[field] !== expectedIdentity[field]);
    const statusOwnsContainerId = Object.prototype.hasOwnProperty.call(status, 'containerId');
    const expectedOwnsContainerId = Object.prototype.hasOwnProperty.call(expectedIdentity, 'containerId');
    const attachesFreshPodmanContainerId = expectedIdentity.runtime === 'podman'
        && expectedOwnsContainerId === false
        && statusOwnsContainerId === true
        && status.state === 'running';
    if (mismatch
        || (statusOwnsContainerId !== expectedOwnsContainerId && !attachesFreshPodmanContainerId)
        || (expectedOwnsContainerId && status.containerId !== expectedIdentity.containerId)) {
        throw new Error(`${description} mismatch`);
    }
    return status;
}

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

export function writeStatus(containerName, payload, { runningDir = RUNNING_DIR } = {}) {
    assertNoWaitStatusIdentity(payload, {
        runtime: payload?.runtime,
        containerName,
        instanceId: payload?.instanceId,
        enableGeneration: payload?.enableGeneration,
        ...(Object.prototype.hasOwnProperty.call(payload || {}, 'containerId')
            ? { containerId: payload.containerId }
            : {}),
    });
    const target = statusPathFor(containerName, { runningDir });
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSequenceTimestamp(status, numericField, isoField) {
    const numeric = Number(status?.[numericField]);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const parsed = Date.parse(String(status?.[isoField] || ''));
    return Number.isFinite(parsed) ? parsed : NaN;
}

function resolveSequenceObservation(statusPath, status, {
    statusRoot,
    timeoutMs,
    terminalPublicationGraceMs,
    publicationDeadline,
    nowMs,
    expectedIdentity,
    maxDepth = 128,
} = {}) {
    let currentPath = statusPath;
    let current = status;
    let currentExpectedIdentity = expectedIdentity;
    const visited = new Set();

    for (let depth = 0; depth < maxDepth; depth += 1) {
        if (visited.has(currentPath)) {
            throw new Error('no-wait predecessor status chain contains a cycle');
        }
        visited.add(currentPath);

        assertNoWaitStatusIdentity(current, currentExpectedIdentity, {
            description: 'no-wait predecessor status identity',
        });

        if (current?.state === 'running' || current?.state === 'failed') {
            if (currentPath === statusPath) return { terminal: current.state };
            const finishedAtMs = parseSequenceTimestamp(current, 'finishedAtMs', 'finishedAt');
            if (!Number.isFinite(finishedAtMs) || finishedAtMs > nowMs + terminalPublicationGraceMs) {
                throw new Error('no-wait predecessor terminal status has an invalid completion timestamp');
            }
            return { deadline: finishedAtMs + terminalPublicationGraceMs };
        }
        if (current?.state && current.state !== 'starting') {
            throw new Error(`no-wait predecessor has invalid state '${current.state}'`);
        }
        if (!current?.state) {
            throw new Error('no-wait predecessor status is missing its state');
        }

        if (!current.sequencePhase) {
            throw new Error('no-wait predecessor starting status is missing its exact sequence phase');
        }

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
        assertExactNoWaitIdentity(
            current.waitForIdentity,
            'no-wait predecessor waiting identity',
        );
        const predecessorFile = String(current.waitForStatusFile || '');
        if (!predecessorFile
            || path.basename(predecessorFile) !== predecessorFile
            || path.extname(predecessorFile) !== '.json') {
            throw new Error('no-wait predecessor waiting phase has an invalid status reference');
        }
        currentPath = path.join(statusRoot, predecessorFile);
        if (current.waitForIdentity.containerName !== path.basename(predecessorFile, '.json')) {
            throw new Error('no-wait predecessor waiting identity does not match its status reference');
        }
        currentExpectedIdentity = current.waitForIdentity;
        try {
            current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
        } catch (error) {
            if (error?.code === 'ENOENT') return { deadline: publicationDeadline };
            throw new Error(`no-wait predecessor status chain is invalid: ${error?.message || error}`);
        }
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
    pollIntervalMs = 100,
    sleepFn = sleep,
    nowFn = Date.now,
    expectedIdentity = null,
} = {}) {
    if (!rawStatusPath) return;
    assertExactNoWaitIdentity(expectedIdentity, 'no-wait predecessor expected identity');
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
    const initialPublicationDeadline = nowFn()
        + boundedTimeoutMs
        + boundedTerminalPublicationGraceMs;
    const statusRoot = path.resolve(runningDir, 'no-wait');
    while (true) {
        const nowMs = nowFn();
        let observation = { deadline: initialPublicationDeadline };
        try {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            observation = resolveSequenceObservation(statusPath, status, {
                statusRoot,
                timeoutMs: boundedTimeoutMs,
                terminalPublicationGraceMs: boundedTerminalPublicationGraceMs,
                publicationDeadline: initialPublicationDeadline,
                nowMs,
                expectedIdentity,
            });
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw new Error(`no-wait predecessor status is invalid: ${error?.message || error}`);
            }
        }
        if (observation.terminal) {
            return Object.freeze({ state: observation.terminal });
        }
        if (nowMs >= observation.deadline) break;
        await sleepFn(Math.min(pollIntervalMs, observation.deadline - nowMs));
    }
    throw new Error(`timed out waiting for no-wait predecessor status '${statusPath}'`);
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
    const stagedRuntime = assertExactNoWaitRuntime(
        stagedRecord?.runtime,
        `no-wait staged identity for '${containerName}'`,
    );
    const expectedAlias = alias === undefined ? '' : alias;
    const recordAlias = record?.alias === undefined ? '' : record.alias;
    const stagedAlias = stagedRecord?.alias === undefined ? '' : stagedRecord.alias;
    const invariantFields = [
        ['type', 'agent'],
        ['repoName', repoName],
        ['agentName', shortAgent],
        ['instanceId', stagedRecord?.instanceId],
        ['enableGeneration', stagedRecord?.enableGeneration],
        ['profile', stagedRecord?.profile],
        ['runMode', stagedRecord?.runMode],
        ['projectPath', stagedRecord?.projectPath],
        ['develRepo', stagedRecord?.develRepo],
        ['runtime', stagedRuntime],
    ];
    const mismatch = !record
        || recordAlias !== expectedAlias
        || stagedAlias !== expectedAlias
        || invariantFields.some(([field, expected]) => (
        record?.[field] !== expected
    )) || record?.auth?.mode !== stagedRecord?.auth?.mode
        || record?.instanceId !== stagedRecord?.instanceId
        || record?.enableGeneration !== stagedRecord?.enableGeneration
        || record?.runtime !== stagedRuntime;
    const exactPodmanContainer = stagedRuntime !== 'podman'
        || (typeof record?.containerId === 'string'
            && IMMUTABLE_CONTAINER_ID_PATTERN.test(record.containerId));
    if (mismatch || !exactPodmanContainer) {
        throw new Error(`no-wait runtime returned a registry identity inconsistent with '${containerName}'`);
    }
    return record;
}

function attachNoWaitRecoveryCandidate(error, candidate) {
    if (!error || typeof error !== 'object' || !candidate) return error;
    const frozenCandidate = Object.isFrozen(candidate)
        ? candidate
        : Object.freeze({ ...candidate });
    const descriptor = Object.getOwnPropertyDescriptor(error, 'ploinkyRestartCandidate');
    if (!descriptor || descriptor.configurable === true) {
        Object.defineProperty(error, 'ploinkyRestartCandidate', {
            configurable: true,
            enumerable: false,
            writable: false,
            value: frozenCandidate,
        });
    }
    return error;
}

export async function cleanupNoWaitTaskOwnedCandidate(candidate, {
    cleanup = dockerSvc.cleanupExactAgentRuntimeCandidate,
    abortPreparation = abortEdgeRoutingPreparation,
    originalFailure = null,
} = {}) {
    if (candidate?.createdByThisLaunch !== true
        && !(candidate?.requiresEdgeActivation === true && candidate?.preparationLease)) return false;
    if (candidate?.preparationAbortFailed === true
        && originalFailure?.code === 'PLOINKY_RECOVERY_ABORT_FAILED') {
        throw originalFailure;
    }
    let cleanupCandidate = candidate;
    if (candidate?.preparationLease
        && candidate?.preparationAbortedBeforeCleanup !== true) {
        try {
            await Promise.resolve(abortPreparation(candidate.preparationLease, {
                reason: 'no-wait-task-runtime-failed',
            }));
            cleanupCandidate = Object.freeze({
                ...candidate,
                preparationAbortedBeforeCleanup: true,
                preparationAbortFailed: false,
            });
            attachNoWaitRecoveryCandidate(originalFailure, cleanupCandidate);
        } catch (abortFailure) {
            const recoveryError = new Error(
                `no-wait recovery could not abort the exact edge preparation; preserving its failed runtime candidate: ${abortFailure?.message || abortFailure}`,
                { cause: abortFailure },
            );
            recoveryError.code = 'PLOINKY_RECOVERY_ABORT_FAILED';
            Object.defineProperty(recoveryError, 'originalFailure', {
                configurable: false,
                enumerable: false,
                writable: false,
                value: originalFailure,
            });
            Object.defineProperty(recoveryError, 'ploinkyRestartCandidate', {
                configurable: false,
                enumerable: false,
                writable: false,
                value: Object.freeze({
                    ...candidate,
                    exactCleanupPerformed: false,
                    preparationAbortFailed: true,
                    preparationAbortedBeforeCleanup: false,
                }),
            });
            throw recoveryError;
        }
    }
    if (candidate.exactCleanupPerformed !== true) {
        try {
            await Promise.resolve(cleanup(cleanupCandidate));
            cleanupCandidate = Object.freeze({
                ...cleanupCandidate,
                exactCleanupPerformed: true,
            });
            attachNoWaitRecoveryCandidate(originalFailure, cleanupCandidate);
        } catch (cleanupFailure) {
            if (cleanupFailure instanceof Error
                && !cleanupFailure.ploinkyRestartCandidate) {
                Object.defineProperty(cleanupFailure, 'ploinkyRestartCandidate', {
                    configurable: false,
                    enumerable: false,
                    writable: false,
                    value: cleanupCandidate,
                });
            }
            throw cleanupFailure;
        }
    }
    return true;
}

export async function recoverNoWaitTaskOwnedCandidate(candidate, originalFailure, options = {}) {
    const failure = originalFailure instanceof Error
        ? originalFailure
        : new Error(String(originalFailure));
    if (failure.code === 'PLOINKY_RECOVERY_ABORT_FAILED') return failure;
    const attachedDescriptor = Object.getOwnPropertyDescriptor(
        failure,
        'ploinkyRestartCandidate',
    );
    const attachedCandidate = attachedDescriptor
        && attachedDescriptor.writable === false
        && attachedDescriptor.value
        && typeof attachedDescriptor.value === 'object'
        && Object.isFrozen(attachedDescriptor.value)
        ? attachedDescriptor.value
        : null;
    const recoveryCandidate = attachedCandidate || candidate;
    try {
        await cleanupNoWaitTaskOwnedCandidate(recoveryCandidate, {
            ...options,
            originalFailure: failure,
        });
        return failure;
    } catch (recoveryFailure) {
        if (recoveryFailure?.code === 'PLOINKY_RECOVERY_ABORT_FAILED') {
            return recoveryFailure;
        }
        failure.message = `${failure.message}; exact task-owned runtime cleanup failed: ${recoveryFailure?.message || recoveryFailure}`;
        const preservedCandidate = recoveryFailure?.ploinkyRestartCandidate || recoveryCandidate;
        if (preservedCandidate) attachNoWaitRecoveryCandidate(failure, preservedCandidate);
        return failure;
    }
}

function assertNoWaitLifecycleIdentity(active, identity) {
    const {
        containerName,
        repoName,
        shortAgent,
        alias,
        routeKey,
        agentPath,
        runtime,
        instanceId,
        enableGeneration,
        containerId,
    } = identity;
    const ownsContainerId = Object.prototype.hasOwnProperty.call(identity, 'containerId');
    assertExactNoWaitIdentity({
        runtime,
        containerName,
        instanceId,
        enableGeneration,
        ...(ownsContainerId ? { containerId } : {}),
    }, `no-wait lifecycle identity for '${containerName}'`);
    const selectedRuntime = assertExactNoWaitRuntime(
        runtime,
        `no-wait selector for '${routeKey}'`,
    );
    const record = active?.generation?.agents?.[containerName];
    const recordAlias = record?.alias === undefined ? '' : record.alias;
    if (!record || record.type !== 'agent'
        || record.repoName !== repoName
        || record.agentName !== shortAgent
        || recordAlias !== alias
        || record.instanceId !== instanceId
        || record.enableGeneration !== enableGeneration
        || record.runtime !== selectedRuntime) {
        const error = new Error(
            `no-wait lifecycle requires the exact selected runtime and staged registry identity for '${containerName}'`,
        );
        error.code = 'PLOINKY_NO_WAIT_RUNTIME_MISMATCH';
        throw error;
    }
    const recordOwnsContainerId = Object.prototype.hasOwnProperty.call(record, 'containerId');
    if (recordOwnsContainerId !== ownsContainerId
        || (ownsContainerId && record.containerId !== containerId)) {
        const error = new Error(
            `no-wait lifecycle requires the exact immutable runtime identity for '${containerName}'`,
        );
        error.code = 'PLOINKY_NO_WAIT_RUNTIME_MISMATCH';
        throw error;
    }
    const route = active?.generation?.routing?.routes?.[routeKey];
    const routeAlias = route?.alias === undefined ? '' : route.alias;
    if (!route
        || route.container !== containerName
        || route.repo !== repoName
        || route.agent !== shortAgent
        || routeAlias !== alias
        || !isExactIdentityText(route.hostPath)
        || !isExactIdentityText(agentPath)
        || !path.isAbsolute(route.hostPath)
        || !path.isAbsolute(agentPath)
        || path.normalize(route.hostPath) !== route.hostPath
        || path.normalize(agentPath) !== agentPath
        || route.hostPath !== agentPath) {
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
    const runtime = lifecycle.record.runtime;
    const containerId = lifecycle.record.containerId;
    if (!Number.isInteger(hostPort) || hostPort <= 0 || hostPort > 65535
        || Object.prototype.hasOwnProperty.call(lifecycle.route, 'serviceTargets')
        || runtime !== 'podman'
        || typeof containerId !== 'string'
        || !IMMUTABLE_CONTAINER_ID_PATTERN.test(containerId)) {
        throw new Error(
            `no-wait lifecycle cannot adopt an existing target for '${identity.routeKey}' without one exact Podman runtime identity and private host port`,
        );
    }
    return Object.freeze({
        ...lifecycle,
        route: Object.freeze({ ...lifecycle.route }),
        targetState: 'ready',
    });
}

export function assertNoWaitPodmanAdoptionOwnership(lifecycle, liveRuntimeRecords) {
    const record = lifecycle?.record;
    const containerName = lifecycle?.route?.container;
    const containerId = record?.containerId;
    const matching = Array.isArray(liveRuntimeRecords)
        ? liveRuntimeRecords.filter((candidate) => (
            candidate?.containerName === containerName
            && candidate?.containerId === containerId
        ))
        : [];
    const live = matching.length === 1 ? matching[0] : null;
    if (lifecycle?.targetState !== 'ready'
        || record?.runtime !== 'podman'
        || typeof containerName !== 'string'
        || typeof containerId !== 'string'
        || !IMMUTABLE_CONTAINER_ID_PATTERN.test(containerId)
        || !isExactIdentityText(record?.instanceId)
        || !isExactIdentityText(record?.enableGeneration)
        || !live
        || live.runtime !== 'podman'
        || live.ownershipVerified !== true
        || live.instanceId !== record.instanceId
        || live.enableGeneration !== record.enableGeneration
        || live.state?.running !== true) {
        const error = new Error(
            `no-wait adoption requires exact rootless Podman ownership labels and immutable runtime identity for '${containerName}'`,
        );
        error.code = 'PLOINKY_NO_WAIT_ADOPTION_OWNERSHIP_INVALID';
        throw error;
    }
    return lifecycle;
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

export async function waitForNoWaitReadiness({
    manifest,
    shortAgent,
    containerName,
    hostPort,
    runtimeResult,
    networkMode,
    generationDigest,
    selectedRuntime,
}, {
    runContainerScriptReadinessFn = runContainerScriptReadiness,
    isContainerRunningFn = dockerSvc.isContainerRunning,
} = {}) {
    const exactRuntime = assertExactNoWaitRuntime(
        selectedRuntime,
        `no-wait readiness for '${containerName}'`,
    );
    if (runtimeResult?.registryRecord?.runtime !== exactRuntime) {
        const error = new Error(
            `no-wait readiness selected '${exactRuntime}' but the returned runtime identity does not match`,
        );
        error.code = 'PLOINKY_NO_WAIT_RUNTIME_MISMATCH';
        throw error;
    }
    const protocol = resolveAgentReadinessProtocol(manifest);
    if (protocol === 'none') return;
    if (protocol === 'script') {
        if (isSandboxRuntime(exactRuntime)) {
            const error = new Error(
                `sandbox runtime '${exactRuntime}' cannot execute container script readiness`,
            );
            error.code = 'PLOINKY_SANDBOX_SCRIPT_READINESS_UNSUPPORTED';
            throw error;
        }
        const readinessIdentity = assertExactNoWaitIdentity({
            runtime: exactRuntime,
            containerName,
            containerId: runtimeResult?.registryRecord?.containerId,
            instanceId: runtimeResult?.registryRecord?.instanceId,
            enableGeneration: runtimeResult?.registryRecord?.enableGeneration,
        }, `no-wait script readiness for '${containerName}'`);
        if (runtimeResult?.containerId !== readinessIdentity.containerId) {
            const error = new Error(
                `no-wait script readiness returned a mismatched immutable runtime for '${containerName}'`,
            );
            error.code = 'PLOINKY_NO_WAIT_RUNTIME_MISMATCH';
            throw error;
        }
        const probe = normalizeProbeConfig('readiness', manifest?.health?.readiness);
        const result = await Promise.resolve(
            runContainerScriptReadinessFn(shortAgent, containerName, probe, {
                runtime: exactRuntime,
                containerId: readinessIdentity.containerId,
                instanceId: readinessIdentity.instanceId,
                enableGeneration: readinessIdentity.enableGeneration,
                isContainerRunningImpl(runtimeContainerName, probeOptions = {}) {
                    return isContainerRunningFn(runtimeContainerName, {
                        ...probeOptions,
                        runtime: exactRuntime,
                        containerId: readinessIdentity.containerId,
                        instanceId: readinessIdentity.instanceId,
                        enableGeneration: readinessIdentity.enableGeneration,
                    });
                },
            }),
        );
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

    if (!containerName || !shortAgent || !repoName || !manifestPath || !agentPath
        || !args.runtime || !args.instanceId || !args.enableGeneration) {
        console.error('[no-wait] missing required arguments; refusing to run.');
        console.error('[no-wait] args:', JSON.stringify(args));
        process.exit(2);
    }

    const dispatchIdentity = Object.freeze(assertExactNoWaitIdentity({
        runtime: args.runtime,
        containerName,
        instanceId: args.instanceId,
        enableGeneration: args.enableGeneration,
        ...(args.containerId ? { containerId: args.containerId } : {}),
    }, 'no-wait dispatched lifecycle identity'));
    let waitForIdentity = null;
    if (waitForStatus) {
        waitForIdentity = Object.freeze(assertExactNoWaitIdentity({
            runtime: args.waitForRuntime,
            containerName: args.waitForContainer,
            instanceId: args.waitForInstanceId,
            enableGeneration: args.waitForEnableGeneration,
            ...(args.waitForContainerId ? { containerId: args.waitForContainerId } : {}),
        }, 'no-wait dispatched predecessor identity'));
        if (path.basename(waitForStatus, '.json') !== waitForIdentity.containerName) {
            throw new Error('no-wait dispatched predecessor identity does not match its status file');
        }
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
    if (admittedRuntime !== dispatchIdentity.runtime) {
        const error = new Error(
            `no-wait manifest runtime does not match dispatched runtime for '${containerName}'`,
        );
        error.code = 'PLOINKY_NO_WAIT_RUNTIME_MISMATCH';
        throw error;
    }
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

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let baseStatus = {
        ...dispatchIdentity,
        containerName,
        shortAgent,
        repoName,
        alias: alias || null,
        routeKey,
        manifestPath,
        agentPath,
        runtime: admittedRuntime,
        pid: process.pid,
        startedAt,
        startedAtMs,
        sequencePhase: waitForStatus ? 'waiting-predecessor' : 'active',
        sequencePhaseStartedAt: startedAt,
        sequencePhaseStartedAtMs: startedAtMs,
        ...(waitForStatus ? {
            waitForStatusFile: path.basename(waitForStatus),
            waitForIdentity,
        } : {}),
    };
    if (admittedRuntime !== 'podman') {
        writeStatus(containerName, { ...baseStatus, state: 'starting' });
    }

    console.log(`[no-wait] ${shortAgent}: starting background launch (pid ${process.pid})`);

    let taskOwnedCandidate = null;
    try {
        await waitForPriorWorker(waitForStatus, { expectedIdentity: waitForIdentity });
        if (waitForStatus) {
            const sequencePhaseStartedAtMs = Date.now();
            baseStatus = {
                ...baseStatus,
                sequencePhase: 'active',
                sequencePhaseStartedAt: new Date(sequencePhaseStartedAtMs).toISOString(),
                sequencePhaseStartedAtMs,
            };
            delete baseStatus.waitForStatusFile;
            delete baseStatus.waitForIdentity;
            if (admittedRuntime !== 'podman') {
                writeStatus(containerName, { ...baseStatus, state: 'starting' });
            }
        }
        const expectedIdentity = Object.freeze({
            containerName,
            repoName,
            shortAgent,
            alias,
            routeKey,
            agentPath,
            runtime: admittedRuntime,
            instanceId: dispatchIdentity.instanceId,
            enableGeneration: dispatchIdentity.enableGeneration,
            ...(Object.prototype.hasOwnProperty.call(dispatchIdentity, 'containerId')
                ? { containerId: dispatchIdentity.containerId }
                : {}),
        });
        // The parent start may still own this lease while detached workers are
        // spawned, and Cloudflare publication uses the same lease afterward.
        // Observe inactive publication recovery without a lease, then capture
        // one exact active selector under the lease and retain it through
        // Router attestation, runtime readiness, and route activation.
        await withActiveNoWaitWorkerLifecycleLease(expectedIdentity, async (lifecycle) => {
        // The workspace graph has already committed this exact target-less
        // identity. Keep that active generation serving while the detached
        // runtime starts; host-network launches are authorized by the exact
        // active-generation capability already compiled for this owner.
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
            || profileResolution.resolvedProfileName !== admittedProfileResolution.resolvedProfileName) {
            const changed = new Error(`no-wait runtime input changed before launch for '${routeKey}'`);
            changed.code = 'PLOINKY_RUNTIME_INPUT_CHANGED';
            changed.status = 409;
            throw changed;
        }
        assertRuntimeAdmissionCurrent(runtimeAdmission, {
            manifestBytes: fs.readFileSync(manifestPath),
            profileName: profileResolution.resolvedProfileName,
            runtimeKind: admittedRuntimeKind,
        });
        if (lifecycle.record.runtime !== admittedRuntime) {
            const changed = new Error(
                `no-wait selected runtime changed before launch for '${routeKey}'`,
            );
            changed.code = 'PLOINKY_NO_WAIT_RUNTIME_MISMATCH';
            changed.status = 409;
            throw changed;
        }
        const routerEndpoint = resolveRouterEndpoint(profileResolution.network.mode, {
            explicitPort: lifecycle.routerPort || undefined,
        });
        if (lifecycle.targetState === 'ready'
            && !['default', 'bridge'].includes(profileResolution.network.mode)) {
            assertNoWaitPodmanAdoptionOwnership(
                lifecycle,
                dockerSvc.collectLiveAgentContainers(),
            );
            baseStatus = {
                ...baseStatus,
                containerId: lifecycle.record.containerId,
            };
            writeStatus(containerName, {
                ...baseStatus,
                state: 'starting',
            });
            const hostPort = Number(lifecycle.route.hostPort);
            await waitForNoWaitReadiness({
                manifest,
                shortAgent,
                containerName,
                hostPort,
                runtimeResult: {
                    containerName,
                    containerId: lifecycle.record.containerId,
                    registryRecord: lifecycle.record,
                },
                networkMode: profileResolution.network.mode,
                generationDigest: lifecycle.generationDigest,
                selectedRuntime: admittedRuntime,
            });
            const currentLifecycle = loadNoWaitWorkerLifecycle(expectedIdentity);
            assertNoWaitAdoptionStillCurrent(lifecycle, currentLifecycle, expectedIdentity);
            assertNoWaitPodmanAdoptionOwnership(
                currentLifecycle,
                dockerSvc.collectLiveAgentContainers(),
            );
            const finishedAtMs = Date.now();
            const finishedAt = new Date(finishedAtMs).toISOString();
            writeStatus(containerName, {
                ...baseStatus,
                runtime: lifecycle.record.runtime,
                instanceId: lifecycle.record.instanceId,
                enableGeneration: lifecycle.record.enableGeneration,
                containerId: lifecycle.record.containerId,
                state: 'running',
                finishedAt,
                finishedAtMs,
                container: containerName,
                hostPort,
                adopted: true,
            });
            console.log(
                `[no-wait] ${shortAgent}: adopted existing ready runtime (container=${containerName}, hostPort=${hostPort})`,
            );
            return;
        }
        await withNetworkLifecycleLock(async (networkLifecycleCapability) => {
        try {
        const ensureOptions = {
            containerName,
            alias: alias || undefined,
            profileName: profileResolution.resolvedProfileName,
            profileResolution,
            routerEndpoint,
            forceRecreate: args.forceRecreate === '1',
            preservePreparedRegistryRecord: true,
            instanceId: lifecycle.record.instanceId,
            enableGeneration: lifecycle.record.enableGeneration,
            networkLifecycleCapability,
            runtimeAdmission,
        };
        const launch = () => dockerSvc.ensureAgentService(shortAgent, manifest, agentPath, ensureOptions);
        const result = profileResolution.network.mode === 'host'
            ? await launchNoWaitHostRuntime(expectedIdentity, lifecycle, launch)
            : await launch();
        if (result?.createdByThisLaunch === true
            || (result?.requiresEdgeActivation === true && result?.preparationLease)) {
            taskOwnedCandidate = result;
        }
        const resolvedContainerName = (result && result.containerName) || containerName;
        if (resolvedContainerName !== containerName) {
            throw new Error(`no-wait runtime resolved an unexpected container identity for '${routeKey}'`);
        }
        const hostPort = result && result.hostPort;
        const registryRecord = result && result.registryRecord;
        assertNoWaitRegistryRecord(registryRecord, lifecycle.record, expectedIdentity);
        if (registryRecord.runtime === 'podman') {
            baseStatus = {
                ...baseStatus,
                containerId: registryRecord.containerId,
            };
            writeStatus(containerName, {
                ...baseStatus,
                state: 'starting',
            });
        }
        const routedHostPort = profileResolution.network.mode === 'none'
            ? null
            : hostPort || null;

        await waitForNoWaitReadiness({
            manifest,
            shortAgent,
            containerName: resolvedContainerName,
            hostPort,
            runtimeResult: result,
            networkMode: profileResolution.network.mode,
            generationDigest: lifecycle.generationDigest,
            selectedRuntime: admittedRuntime,
        });

        await upsertRoute(routeKey, {
            container: resolvedContainerName,
            hostPath: agentPath,
            repo: repoName,
            agent: shortAgent,
            ...(alias ? { alias } : {}),
            hostPort: routedHostPort,
        }, {
            containerName: resolvedContainerName,
            registryRecord,
            expectedIdentity,
            expectedLifecycle: lifecycle,
            expectedSelector: {
                generation: lifecycle.generationDigest,
                activationId: lifecycle.selectorActivationId,
            },
            preparationLease: result?.preparationLease,
        });
        taskOwnedCandidate = null;

        const finishedAtMs = Date.now();
        const finishedAt = new Date(finishedAtMs).toISOString();
        writeStatus(containerName, {
            ...baseStatus,
            runtime: registryRecord.runtime,
            instanceId: registryRecord.instanceId,
            enableGeneration: registryRecord.enableGeneration,
            ...(registryRecord.runtime === 'podman'
                ? { containerId: registryRecord.containerId }
                : {}),
            state: 'running',
            finishedAt,
            finishedAtMs,
            container: resolvedContainerName,
            hostPort: routedHostPort
        });
        console.log(`[no-wait] ${shortAgent}: launch succeeded (container=${resolvedContainerName}${hostPort ? `, hostPort=${hostPort}` : ''})`);
        } catch (error) {
            const failure = await recoverNoWaitTaskOwnedCandidate(taskOwnedCandidate, error);
            taskOwnedCandidate = null;
            throw failure;
        }
        });
        });
    } catch (err) {
        let failure = err instanceof Error ? err : new Error(String(err));
        failure = await recoverNoWaitTaskOwnedCandidate(taskOwnedCandidate, failure);
        taskOwnedCandidate = null;
        const failedCandidateId = failure?.ploinkyRestartCandidate?.registryRecord?.containerId;
        if (admittedRuntime === 'podman'
            && !IMMUTABLE_CONTAINER_ID_PATTERN.test(String(baseStatus.containerId || ''))
            && IMMUTABLE_CONTAINER_ID_PATTERN.test(String(failedCandidateId || ''))) {
            baseStatus = { ...baseStatus, containerId: failedCandidateId };
        }
        const finishedAtMs = Date.now();
        const finishedAt = new Date(finishedAtMs).toISOString();
        const error = {
            message: failure.message,
            stack: failure.stack || null,
            ...(failure.code ? { code: failure.code } : {}),
        };
        if (admittedRuntime !== 'podman'
            || IMMUTABLE_CONTAINER_ID_PATTERN.test(String(baseStatus.containerId || ''))) {
            writeStatus(containerName, {
                ...baseStatus,
                state: 'failed',
                finishedAt,
                finishedAtMs,
                error
            });
        } else {
            try { fs.unlinkSync(statusPathFor(containerName)); } catch (unlinkError) {
                if (unlinkError?.code !== 'ENOENT') throw unlinkError;
            }
        }
        console.error(`[no-wait] ${shortAgent}: launch failed: ${error.message}`);
        if (failure.stack) console.error(failure.stack);
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
