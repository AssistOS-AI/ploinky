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
    legacyDeadline,
    nowMs,
    maxDepth = 128,
} = {}) {
    let currentPath = statusPath;
    let current = status;
    const visited = new Set();

    for (let depth = 0; depth < maxDepth; depth += 1) {
        if (visited.has(currentPath)) {
            throw new Error('no-wait predecessor status chain contains a cycle');
        }
        visited.add(currentPath);

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
        try {
            current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
        } catch (error) {
            if (error?.code === 'ENOENT') return { deadline: legacyDeadline };
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
    const legacyDeadline = nowFn() + boundedTimeoutMs + boundedTerminalPublicationGraceMs;
    const statusRoot = path.resolve(runningDir, 'no-wait');
    while (true) {
        const nowMs = nowFn();
        let observation = { deadline: legacyDeadline };
        try {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            observation = resolveSequenceObservation(statusPath, status, {
                statusRoot,
                timeoutMs: boundedTimeoutMs,
                terminalPublicationGraceMs: boundedTerminalPublicationGraceMs,
                legacyDeadline,
                nowMs,
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

    if (!containerName || !shortAgent || !repoName || !manifestPath || !agentPath) {
        console.error('[no-wait] missing required arguments; refusing to run.');
        console.error('[no-wait] args:', JSON.stringify(args));
        process.exit(2);
    }

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
        sequencePhase: waitForStatus ? 'waiting-predecessor' : 'active',
        sequencePhaseStartedAt: startedAt,
        sequencePhaseStartedAtMs: startedAtMs,
        ...(waitForStatus ? { waitForStatusFile: path.basename(waitForStatus) } : {}),
    };
    writeStatus(containerName, { ...baseStatus, state: 'starting' });

    console.log(`[no-wait] ${shortAgent}: starting background launch (pid ${process.pid})`);

    let taskOwnedCandidate = null;
    try {
        await waitForPriorWorker(waitForStatus);
        if (waitForStatus) {
            const sequencePhaseStartedAtMs = Date.now();
            baseStatus = {
                ...baseStatus,
                sequencePhase: 'active',
                sequencePhaseStartedAt: new Date(sequencePhaseStartedAtMs).toISOString(),
                sequencePhaseStartedAtMs,
            };
            delete baseStatus.waitForStatusFile;
            writeStatus(containerName, { ...baseStatus, state: 'starting' });
        }
        const expectedIdentity = Object.freeze({
            containerName,
            repoName,
            shortAgent,
            alias,
            routeKey,
            agentPath,
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
        const routerEndpoint = resolveRouterEndpoint(profileResolution.network.mode, {
            explicitPort: lifecycle.routerPort || undefined,
        });
        if (lifecycle.targetState === 'ready'
            && !['default', 'bridge'].includes(profileResolution.network.mode)) {
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
            });
            const currentLifecycle = loadNoWaitWorkerLifecycle(expectedIdentity);
            assertNoWaitAdoptionStillCurrent(lifecycle, currentLifecycle, expectedIdentity);
            const finishedAtMs = Date.now();
            const finishedAt = new Date(finishedAtMs).toISOString();
            writeStatus(containerName, {
                ...baseStatus,
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
            state: 'running',
            finishedAt,
            finishedAtMs,
            container: resolvedContainerName,
            hostPort: routedHostPort
        });
        console.log(`[no-wait] ${shortAgent}: launch succeeded (container=${resolvedContainerName}${hostPort ? `, hostPort=${hostPort}` : ''})`);
        } catch (error) {
            await cleanupNoWaitTaskOwnedCandidate(taskOwnedCandidate);
            taskOwnedCandidate = null;
            throw error;
        }
        });
        });
    } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        try {
            await cleanupNoWaitTaskOwnedCandidate(taskOwnedCandidate);
        } catch (_) {
            failure.message = `${failure.message}; exact task-owned runtime cleanup failed`;
        }
        const finishedAtMs = Date.now();
        const finishedAt = new Date(finishedAtMs).toISOString();
        const error = {
            message: failure.message,
            stack: failure.stack || null
        };
        writeStatus(containerName, {
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
