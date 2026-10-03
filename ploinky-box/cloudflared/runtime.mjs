import path from 'node:path';

import { appendLog } from '../../cli/server/utils/logger.js';
import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../../cli/utils/config.js';
import { createCloudflarePublicationController } from './publicationController.mjs';
import { stablePublicationJson } from './publicationPlan.mjs';
import {
    inactivateEdgeRoutingGeneration,
    loadActiveEdgeRoutingGeneration,
    readEdgeRoutingSelection,
    withEdgeGenerationApplyLock,
} from '../../cli/sandbox/edgeGeneration.js';
import { applyEdgeRoutingGeneration } from '../../cli/sandbox/coordinatedEdgeApply.js';
import { withNetworkLifecycleLock } from '../../cli/sandbox/networkLifecycle.js';
import { readRouterSupervisorId } from '../../cli/server/routerSupervisorIdentity.js';
import {
    createWorkspaceMutationLease,
    inspectWorkspaceStartLock,
    releaseWorkspaceMutationLease,
} from '../../cli/utils/runtime/maintenanceLocks.js';
import {
    readRouterRestartHandoff,
    removeRouterRestartHandoff,
    routerRestartHandoffFile,
    writeRouterRestartHandoff,
} from './routerRestartHandoff.mjs';
import { writeCloudflarePublicationStatus } from './status.mjs';

const DEFAULT_STATUS_FILE = path.join(PLOINKY_DIR, 'run', 'cloudflare-publication-status.json');
const ALLOWED_PUBLICATION_STATES = new Set([
    'ready',
    'reconciling',
    'error',
]);
const RETRYABLE_SELECTED_PUBLICATION_STATES = new Set([
    'reconciling',
    'error',
]);
const DEFAULT_EDGE_APPLY_BUSY_RETRY_ATTEMPTS = 50;
const DEFAULT_EDGE_APPLY_BUSY_RETRY_DELAY_MS = 100;
const EXACT_GENERATION = /^sha256:[a-f0-9]{64}$/;
export const ROUTER_STOP_INACTIVATION_REASON = 'cloudflare-controller-stop';
export const ROUTER_RESTART_RESTORE_REASON = 'router-restart-restore';
// Pre-mutation contention on a lock or an outstanding lifecycle preparation.
// A pending restore retries on the next poll instead of being abandoned.
const ROUTER_RESTART_RESTORE_BUSY_CODES = new Set([
    'EDGE_GENERATION_BUSY',
    'EDGE_PREPARATION_BUSY',
    'PLOINKY_NETWORK_LIFECYCLE_BUSY',
]);

function publicationRuntimeError(message, code = 'CLOUDFLARE_RUNTIME_COORDINATION_FAILED') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function sleepFor(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function releaseExactPublicationLease(lease, {
    releaseWorkspaceLease = releaseWorkspaceMutationLease,
    inspectWorkspaceLease = inspectWorkspaceStartLock,
    audit = () => {},
    retryDelayMs = 100,
    sleep = sleepFor,
    continueRetry = () => true,
} = {}) {
    if (!lease) return true;
    const operation = String(lease.operation || 'cloudflare-publication');
    const delayMs = Math.max(1, Number(retryDelayMs) || 100);
    let failures = 0;
    let deferred = false;
    while (true) {
        let released = false;
        try {
            released = releaseWorkspaceLease(lease);
        } catch (_) {}
        if (released) {
            if (deferred) {
                audit('cloudflare-workspace-lease-release-recovered', {
                    operation,
                    failures,
                });
            }
            return true;
        }

        let current = null;
        try {
            current = inspectWorkspaceLease();
        } catch (_) {}
        // The exact lease is already gone if the lock is absent or a newer
        // token owns the path. Never unlink a replacement on behalf of this
        // completed publication.
        if (current && !current.active) return true;
        if (current?.lock?.token && current.lock.token !== lease.token) return true;

        failures += 1;
        if (!deferred) {
            deferred = true;
            audit('cloudflare-workspace-lease-release-deferred', {
                operation,
                failures,
            });
        }
        if (!continueRetry()) {
            audit('cloudflare-workspace-lease-release-failed', {
                operation,
                failures,
            });
            return false;
        }
        await sleep(delayMs);
    }
}

// The publication state a Watchdog replacement may restore for the exact
// generation its predecessor stopped serving. A replacement has no connector,
// so a Cloudflare generation returns only as reconciling: public hosts stay
// closed until the new Router proves publication again. A generation whose
// publication had failed (error) is never restored and stays withdrawn.
function restorePublicationStateFor(active) {
    const mode = active?.generation?.compiled?.publication?.mode;
    const state = active?.selector?.publicationState;
    if (mode === 'local-only' && state === 'ready') return 'ready';
    if (mode === 'cloudflare' && (state === 'ready' || state === 'reconciling')) return 'reconciling';
    return null;
}

export function matchesRouterStopSelector(selector, handoff) {
    return selector?.state === 'inactive'
        && selector.generation === undefined
        && selector.reason === ROUTER_STOP_INACTIVATION_REASON
        && selector.previousGeneration === handoff?.generation
        && selector.activationId === handoff?.inactiveActivationId
        && selector.selectorDigest === handoff?.inactiveSelectorDigest;
}

function sleepForWithSignal(delayMs, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason || new Error('external Cloudflare hostname proof aborted'));
            return;
        }
        let timer;
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason || new Error('external Cloudflare hostname proof aborted'));
        };
        timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

export function createEdgePublicationRouteCoordinator({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    onCommit = () => {},
    onStopInactivation = () => {},
    edgeApplyBusyRetryAttempts = DEFAULT_EDGE_APPLY_BUSY_RETRY_ATTEMPTS,
    edgeApplyBusyRetryDelayMs = DEFAULT_EDGE_APPLY_BUSY_RETRY_DELAY_MS,
    sleep = sleepFor,
    edgeOps = {
        apply: applyEdgeRoutingGeneration,
        inactivate: inactivateEdgeRoutingGeneration,
        load: loadActiveEdgeRoutingGeneration,
        selection: readEdgeRoutingSelection,
    },
} = {}) {
    let captured = null;
    const withApplyLock = edgeOps.withApplyLock || withEdgeGenerationApplyLock;
    const withNetworkLock = edgeOps.withNetworkLifecycleLock || withNetworkLifecycleLock;
    const maximumApplyAttempts = Math.max(
        1,
        Math.min(100, Math.trunc(Number(edgeApplyBusyRetryAttempts) || 1)),
    );
    const applyRetryDelayMs = Math.max(
        0,
        Math.min(1_000, Math.trunc(Number(edgeApplyBusyRetryDelayMs) || 0)),
    );

    async function applyCapturedGeneration(options) {
        // EDGE_GENERATION_BUSY is raised before the caller acquires the apply
        // lock or mutates selector state. Retry only that pre-mutation outcome;
        // expectedGeneration and the captured desired comparison below remain
        // authoritative on every fresh lock attempt.
        for (let attempt = 1; attempt <= maximumApplyAttempts; attempt += 1) {
            try {
                return await edgeOps.apply(options);
            } catch (error) {
                if (error?.code !== 'EDGE_GENERATION_BUSY' || attempt === maximumApplyAttempts) {
                    throw error;
                }
                await sleep(applyRetryDelayMs);
            }
        }
        throw publicationRuntimeError('edge generation apply retry exhausted');
    }

    return Object.freeze({
        async inactivate({ configurationGeneration, reason } = {}) {
            const expected = String(configurationGeneration || '');
            if (!/^sha256:[a-f0-9]{64}$/.test(expected)) {
                throw publicationRuntimeError('publication coordination requires an exact edge generation');
            }
            try {
                const active = edgeOps.load({ workspaceRoot });
                if (active.selector.generation !== expected) {
                    throw publicationRuntimeError('publication request is not the selected active generation');
                }
                captured = {
                    generation: expected,
                    desired: active.generation.desired,
                };
            } catch (error) {
                if (error?.code !== 'EDGE_GENERATION_INACTIVE'
                    || captured?.generation !== expected) throw error;
                const selection = edgeOps.selection({ workspaceRoot }).selector;
                const selectedGeneration = selection.generation || selection.previousGeneration;
                if (selection.state !== 'inactive' || selectedGeneration !== expected) {
                    throw publicationRuntimeError('publication retry is not the exact selected inactive generation');
                }
            }
            edgeOps.inactivate(String(reason || 'publication-reconcile'), { workspaceRoot });
        },

        async inactivateForStop({
            configurationGeneration,
            reason = ROUTER_STOP_INACTIVATION_REASON,
        } = {}) {
            const expected = String(configurationGeneration || '');
            if (!EXACT_GENERATION.test(expected)) return null;
            let active;
            try {
                active = edgeOps.load({ workspaceRoot });
            } catch (error) {
                // Inactive authorization already fails closed. Rewriting it
                // would replace the failure or lifecycle reason recorded there
                // and drop a selected inactive candidate.
                if (error?.code === 'EDGE_GENERATION_INACTIVE') return null;
                throw error;
            }
            if (active.selector.generation !== expected) return null;
            const inactiveSelector = edgeOps.inactivate(String(reason), {
                workspaceRoot,
                expectedActiveSelector: {
                    generation: active.selector.generation,
                    activationId: active.selector.activationId,
                },
            });
            if (!inactiveSelector) return null;
            const stopped = Object.freeze({
                generation: expected,
                restorePublicationState: restorePublicationStateFor(active),
                inactiveSelector,
            });
            onStopInactivation(stopped);
            return stopped;
        },

        async restoreRouterStop(handoff) {
            return withNetworkLock((networkLifecycleCapability) => withApplyLock((applyLockCapability) => {
                const { selector } = edgeOps.selection({ workspaceRoot });
                if (!matchesRouterStopSelector(selector, handoff)) {
                    throw publicationRuntimeError(
                        'edge selector changed after the predecessor Router stop',
                        'CLOUDFLARE_ROUTER_RESTART_SUPERSEDED',
                    );
                }
                // expectedGeneration is checked before the apply transaction
                // starts, so changed sources abort without any mutation.
                const result = edgeOps.apply({
                    workspaceRoot,
                    reason: ROUTER_RESTART_RESTORE_REASON,
                    publicationState: handoff.restorePublicationState,
                    expectedGeneration: handoff.generation,
                    applyLockCapability,
                    networkLifecycleCapability,
                });
                if (result?.selector?.state !== 'active'
                    || result.selector.generation !== handoff.generation) {
                    throw publicationRuntimeError('Router restart restore did not select the exact stopped generation');
                }
                return result;
            }, { workspaceRoot }));
        },

        async commit({
            mode,
            configurationGeneration,
            hosts,
            publicationState,
        } = {}) {
            const expected = String(configurationGeneration || '');
            const state = String(publicationState || '');
            if (captured?.generation !== expected || !ALLOWED_PUBLICATION_STATES.has(state)) {
                throw publicationRuntimeError('publication commit is outside its captured immutable generation');
            }
            const expectedMode = captured.desired?.cloudflare
                && Object.keys(captured.desired?.hosts || {}).length > 0
                ? 'cloudflare'
                : 'local-only';
            if (mode !== expectedMode
                || (mode === 'local-only' && state !== 'ready')
                || stablePublicationJson(hosts || {}) !== stablePublicationJson(captured.desired?.hosts || {})) {
                throw publicationRuntimeError('publication commit does not match captured desired semantics');
            }
            let result;
            try {
                result = await applyCapturedGeneration({
                    workspaceRoot,
                    reason: `publication-${state}`,
                    publicationState: state,
                    expectedGeneration: expected,
                });
                if (result.selector.generation !== expected
                    || stablePublicationJson(result.generation.desired) !== stablePublicationJson(captured.desired)) {
                    throw publicationRuntimeError('edge sources changed before publication commit');
                }
            } catch (error) {
                try { edgeOps.inactivate('publication-commit-failed', { workspaceRoot }); } catch (_) {}
                throw error;
            }
            onCommit(result.selector.activationId);
            return result;
        },
    });
}

function combineAbortSignal(externalSignal, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener?.('abort', abort, { once: true });
    const timer = setTimeout(
        () => controller.abort(new Error('external Cloudflare hostname proof timed out')),
        timeoutMs,
    );
    timer.unref?.();
    return {
        signal: controller.signal,
        release() {
            clearTimeout(timer);
            externalSignal?.removeEventListener?.('abort', abort);
        },
    };
}

export function createExternalHostnameProbe({
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    pollIntervalMs = 500,
    now = Date.now,
    sleep = sleepForWithSignal,
} = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('external hostname proof requires fetch');
    if (typeof now !== 'function') throw new TypeError('external hostname proof requires now()');
    if (typeof sleep !== 'function') throw new TypeError('external hostname proof requires sleep()');
    const maximumWaitMs = Math.max(1, Math.trunc(Number(timeoutMs) || 1));
    const retryDelayMs = Math.max(1, Math.min(
        maximumWaitMs,
        Math.trunc(Number(pollIntervalMs) || 1),
    ));
    return async function probeHostname({
        hostname,
        configurationGeneration,
        connector,
        signal,
    } = {}) {
        const generation = String(configurationGeneration || '');
        const timed = combineAbortSignal(signal, maximumWaitMs);
        const deadline = now() + maximumWaitMs;
        let lastStatus = 0;
        try {
            for (;;) {
                if (connector && !connector.isRunning()) return { ok: false, status: lastStatus };
                try {
                    const response = await fetchImpl(
                        `https://${hostname}/.well-known/ploinky-edge-proof/${generation.replace(/^sha256:/, '')}`,
                        {
                            method: 'GET',
                            headers: { Accept: 'application/json' },
                            redirect: 'manual',
                            signal: timed.signal,
                        },
                    );
                    lastStatus = response.status;
                    const body = (await response.text()).slice(0, 4096);
                    let parsed = null;
                    try { parsed = JSON.parse(body); } catch (_) {}
                    if (connector && !connector.isRunning()) {
                        return { ok: false, status: lastStatus };
                    }
                    if (response.status === 503
                        && response.headers.get('x-ploinky-edge-generation') === generation
                        && parsed?.error === 'HOST_SELECTOR_INACTIVE') {
                        return { ok: true, status: response.status };
                    }
                } catch (error) {
                    if (timed.signal.aborted) throw timed.signal.reason || error;
                    lastStatus = 0;
                }
                const remainingMs = deadline - now();
                if (remainingMs <= 0) return { ok: false, status: lastStatus };
                await sleep(Math.min(retryDelayMs, remainingMs), timed.signal);
            }
        } finally {
            timed.release();
        }
    };
}

export function startCloudflarePublicationRuntime({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    statusFile = DEFAULT_STATUS_FILE,
    pollIntervalMs = 500,
    controllerFactory = createCloudflarePublicationController,
    routeCoordinatorFactory = createEdgePublicationRouteCoordinator,
    loadActive = loadActiveEdgeRoutingGeneration,
    probeHostname = createExternalHostnameProbe(),
    audit = (event, value) => appendLog(event, value),
    retryInitialDelayMs = 1_000,
    retryMaximumDelayMs = 30_000,
    createWorkspaceLease = createWorkspaceMutationLease,
    releaseWorkspaceLease = releaseWorkspaceMutationLease,
    inspectWorkspaceLease = inspectWorkspaceStartLock,
    leaseReleaseRetryDelayMs = 100,
    leaseReleaseSleep = sleepFor,
    inactivateInvalidGeneration = inactivateEdgeRoutingGeneration,
    readSelection = readEdgeRoutingSelection,
    routerSupervisorId = readRouterSupervisorId(),
    restartHandoffFile = routerRestartHandoffFile(workspaceRoot),
} = {}) {
    const handledActivations = new Set();
    let stopped = false;
    let inFlight = null;
    let scheduledRetry = null;
    let pendingRestart = null;
    let restartRestoreInFlight = false;
    let controller;
    const initialRetryDelay = Math.max(1, Number(retryInitialDelayMs) || 1_000);
    const maximumRetryDelay = Math.max(initialRetryDelay, Number(retryMaximumDelayMs) || 30_000);
    const rememberActivation = (activationId) => {
        const id = String(activationId || '');
        if (!id) return;
        handledActivations.add(id);
        while (handledActivations.size > 256) {
            handledActivations.delete(handledActivations.values().next().value);
        }
    };
    const discardRestartHandoff = (reason, detail = {}) => {
        pendingRestart = null;
        try { removeRouterRestartHandoff(restartHandoffFile); } catch (_) {}
        audit('cloudflare-router-restart-restore-skipped', { reason, ...detail });
    };
    const recordRouterStop = ({ generation, restorePublicationState, inactiveSelector }) => {
        const restorable = Boolean(routerSupervisorId && restorePublicationState);
        audit('cloudflare-router-stop-inactivated', { generation, restorable });
        if (!restorable) {
            removeRouterRestartHandoff(restartHandoffFile);
            return;
        }
        writeRouterRestartHandoff(restartHandoffFile, {
            routerSupervisorId,
            generation,
            restorePublicationState,
            inactiveActivationId: inactiveSelector.activationId,
            inactiveSelectorDigest: inactiveSelector.selectorDigest,
            stoppedAt: new Date().toISOString(),
        }, { trustedRoot: workspaceRoot });
    };
    const routeCoordinator = routeCoordinatorFactory({
        workspaceRoot,
        onCommit: rememberActivation,
        onStopInactivation: recordRouterStop,
    });
    controller = controllerFactory({
        workspaceRoot,
        routeCoordinator,
        probeHostname,
        publishState: (state) => writeCloudflarePublicationStatus(statusFile, state, {
            trustedRoot: workspaceRoot,
        }),
        audit,
    });
    writeCloudflarePublicationStatus(statusFile, {
        mode: 'local-only',
        management: null,
        state: 'unstarted',
        connectorState: 'absent',
    }, {
        trustedRoot: workspaceRoot,
    });

    function claimRestartHandoff() {
        let handoff;
        try {
            handoff = readRouterRestartHandoff(restartHandoffFile);
        } catch (error) {
            discardRestartHandoff('handoff-invalid', {
                code: error?.code || 'CLOUDFLARE_ROUTER_RESTART_HANDOFF_INVALID',
            });
            return;
        }
        if (!handoff) return;
        // Only a later Router of the same Watchdog supervision lifetime may
        // restore the generation; the record stays bound to that lifetime, so
        // replacements that exit before restoring leave it to the next one. A
        // new lifetime (for example after a Box shutdown) discards it.
        if (!routerSupervisorId || handoff.routerSupervisorId !== routerSupervisorId) {
            discardRestartHandoff('other-supervision-lifetime', { generation: handoff.generation });
            return;
        }
        pendingRestart = handoff;
        audit('cloudflare-router-restart-restore-pending', { generation: handoff.generation });
    }

    // Returns true while the exact predecessor stop selector must still wait
    // for workspace or edge serialization; normal scanning has nothing to do
    // for that inactive selector in the meantime.
    async function restorePredecessorGeneration() {
        if (restartRestoreInFlight) return true;
        const handoff = pendingRestart;
        let selector;
        try {
            selector = readSelection({ workspaceRoot }).selector;
        } catch (error) {
            discardRestartHandoff('selector-unreadable', {
                code: error?.code || 'EDGE_GENERATION_CORRUPT',
                generation: handoff.generation,
            });
            return false;
        }
        if (!matchesRouterStopSelector(selector, handoff)) {
            discardRestartHandoff('superseded', { generation: handoff.generation });
            return false;
        }
        restartRestoreInFlight = true;
        let workspaceLease = null;
        try {
            workspaceLease = acquirePublicationLease('router-restart-restore');
            if (!workspaceLease) return true;
            if (stopped || pendingRestart !== handoff) return true;
            const restored = await routeCoordinator.restoreRouterStop(handoff);
            pendingRestart = null;
            try { removeRouterRestartHandoff(restartHandoffFile); } catch (_) {}
            audit('cloudflare-router-restart-restored', {
                generation: handoff.generation,
                publicationState: handoff.restorePublicationState,
                activationId: restored.selector.activationId,
            });
            return false;
        } catch (error) {
            if (ROUTER_RESTART_RESTORE_BUSY_CODES.has(error?.code)) return true;
            discardRestartHandoff('restore-failed', {
                code: error?.code || 'CLOUDFLARE_ROUTER_RESTART_RESTORE_FAILED',
                generation: handoff.generation,
            });
            return false;
        } finally {
            restartRestoreInFlight = false;
            if (workspaceLease) await releasePublicationLease(workspaceLease);
        }
    }

    function clearScheduledRetry() {
        if (!scheduledRetry) return;
        clearTimeout(scheduledRetry.timer);
        scheduledRetry = null;
    }

    function acquirePublicationLease(activationId) {
        try {
            return createWorkspaceLease({
                operation: `cloudflare-publication:${String(activationId || 'unknown')}`,
            });
        } catch (error) {
            if (error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY') return null;
            throw error;
        }
    }

    function releasePublicationLease(lease) {
        return releaseExactPublicationLease(lease, {
            releaseWorkspaceLease,
            inspectWorkspaceLease,
            audit,
            retryDelayMs: leaseReleaseRetryDelayMs,
            sleep: leaseReleaseSleep,
            continueRetry: () => !stopped,
        });
    }

    function retryActivationFor(input, fallbackActivationId) {
        try {
            const selected = loadActive({ workspaceRoot });
            // A failed reconcile can leave its own committed reconciling
            // activation selected when the fail-closed inactivation races an
            // edge apply. onCommit already marked that activation handled, so
            // the retry must follow it instead of delegating back to scan().
            if (selected.selector.generation === input.configurationGeneration
                && RETRYABLE_SELECTED_PUBLICATION_STATES.has(
                    selected.selector.publicationState,
                )) {
                return selected.selector.activationId;
            }
        } catch (_) {}
        return fallbackActivationId;
    }

    function scheduleRetry({ activationId, input, attempt = 1 }) {
        if (stopped) return;
        if (scheduledRetry?.activationId === activationId) return;
        clearScheduledRetry();
        const delayMs = Math.min(initialRetryDelay * (2 ** Math.max(0, attempt - 1)), maximumRetryDelay);
        const retry = {
            activationId,
            input: structuredClone(input),
            attempt,
            delayMs,
            timer: null,
        };
        scheduledRetry = retry;
        retry.timer = setTimeout(async () => {
            if (scheduledRetry !== retry || stopped) return;
            scheduledRetry = null;
            try {
                const selected = loadActive({ workspaceRoot });
                if (selected.selector.activationId !== activationId) {
                    void scan();
                    return;
                }
            } catch (error) {
                if (error?.code !== 'EDGE_GENERATION_INACTIVE') {
                    audit('cloudflare-generation-load-error', {
                        code: error?.code || 'EDGE_GENERATION_LOAD_FAILED',
                        message: String(error?.message || error).slice(0, 1024),
                    });
                    return;
                }
            }
            const workspaceLease = acquirePublicationLease(activationId);
            if (!workspaceLease) {
                scheduleRetry({ activationId, input: retry.input, attempt });
                return;
            }
            let superseded = false;
            try {
                try {
                    const selected = loadActive({ workspaceRoot });
                    if (selected.selector.activationId !== activationId
                        || selected.selector.generation !== retry.input.configurationGeneration) {
                        superseded = true;
                        return;
                    }
                } catch (error) {
                    if (error?.code !== 'EDGE_GENERATION_INACTIVE') {
                        audit('cloudflare-generation-load-error', {
                            code: error?.code || 'EDGE_GENERATION_LOAD_FAILED',
                            message: String(error?.message || error).slice(0, 1024),
                        });
                        try {
                            inactivateInvalidGeneration('publication-generation-invalid', { workspaceRoot });
                        } catch (_) {}
                        return;
                    }
                }
                inFlight = controller.reconcile(retry.input, { reason: 'selected-edge-generation-retry' });
                await inFlight;
            } catch (error) {
                audit('cloudflare-publication-runtime-error', {
                    code: error?.code || 'CLOUDFLARE_PUBLICATION_ERROR',
                    message: String(error?.message || error).slice(0, 1024),
                    retryAttempt: attempt,
                });
                scheduleRetry({
                    activationId: retryActivationFor(retry.input, activationId),
                    input: retry.input,
                    attempt: attempt + 1,
                });
            } finally {
                inFlight = null;
                await releasePublicationLease(workspaceLease);
                if (superseded && !stopped) void scan();
            }
        }, delayMs);
        retry.timer.unref?.();
    }

    async function scan() {
        if (stopped) return;
        if (pendingRestart && await restorePredecessorGeneration()) return;
        if (stopped) return;
        let active;
        try {
            active = loadActive({ workspaceRoot });
        } catch (error) {
            if (!['EDGE_GENERATION_INACTIVE'].includes(error?.code)) {
                const workspaceLease = acquirePublicationLease('invalid-generation');
                if (!workspaceLease) return;
                try {
                    try {
                        active = loadActive({ workspaceRoot });
                    } catch (currentError) {
                        if (currentError?.code === 'EDGE_GENERATION_INACTIVE') return;
                        audit('cloudflare-generation-load-error', {
                            code: currentError?.code || 'EDGE_GENERATION_LOAD_FAILED',
                            message: String(currentError?.message || currentError).slice(0, 1024),
                        });
                        try {
                            inactivateInvalidGeneration('publication-generation-invalid', { workspaceRoot });
                        } catch (_) {}
                        return;
                    }
                } finally {
                    await releasePublicationLease(workspaceLease);
                }
            }
            if (!active) return;
        }
        const observedActivationId = active.selector.activationId;
        // The polling loop is deliberately frequent, but a generation that
        // already reconciled must not keep taking the global workspace
        // mutation lease. Besides needless filesystem churn, a poll interval
        // that phase-aligns with another lifecycle monitor can otherwise
        // starve that monitor indefinitely. The selected generation is loaded
        // again after acquisition below, so a new activation that races this
        // fast path is picked up by the next bounded poll.
        if (handledActivations.has(observedActivationId)) return;
        const workspaceLease = acquirePublicationLease(observedActivationId);
        if (!workspaceLease) return;
        try {
            try {
                active = loadActive({ workspaceRoot });
            } catch (error) {
                if (error?.code !== 'EDGE_GENERATION_INACTIVE') {
                    audit('cloudflare-generation-load-error', {
                        code: error?.code || 'EDGE_GENERATION_LOAD_FAILED',
                        message: String(error?.message || error).slice(0, 1024),
                    });
                    try {
                        inactivateInvalidGeneration('publication-generation-invalid', { workspaceRoot });
                    } catch (_) {}
                }
                return;
            }
            const activationId = active.selector.activationId;
            if (scheduledRetry && scheduledRetry.activationId !== activationId) clearScheduledRetry();
            if (handledActivations.has(activationId)) return;
            rememberActivation(activationId);
            const input = {
                configurationGeneration: active.selector.generation,
                selectedPublicationState: active.selector.publicationState,
                cloudflare: active.generation.desired.cloudflare,
                hosts: active.generation.desired.hosts,
            };
            inFlight = controller.reconcile(input, { reason: 'selected-edge-generation' });
            await inFlight;
        } catch (error) {
            audit('cloudflare-publication-runtime-error', {
                code: error?.code || 'CLOUDFLARE_PUBLICATION_ERROR',
                message: String(error?.message || error).slice(0, 1024),
            });
            if (active?.selector?.activationId && active?.selector?.generation) {
                scheduleRetry({
                    activationId: retryActivationFor({
                        configurationGeneration: active.selector.generation,
                    }, active.selector.activationId),
                    input: {
                        configurationGeneration: active.selector.generation,
                        selectedPublicationState: active.selector.publicationState,
                        cloudflare: active.generation.desired.cloudflare,
                        hosts: active.generation.desired.hosts,
                    },
                });
            }
        } finally {
            inFlight = null;
            await releasePublicationLease(workspaceLease);
        }
    }

    claimRestartHandoff();
    const timer = setInterval(() => { void scan(); }, Math.max(100, Number(pollIntervalMs) || 500));
    timer.unref?.();
    void scan();
    return Object.freeze({
        getStatus: () => controller.getStatus(),
        scan,
        async stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            clearScheduledRetry();
            await controller.stop();
            try { await inFlight; } catch (_) {}
        },
    });
}

export default startCloudflarePublicationRuntime;
