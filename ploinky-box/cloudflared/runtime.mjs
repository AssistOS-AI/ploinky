import path from 'node:path';

import { appendLog } from '../../cli/server/utils/logger.js';
import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../../cli/utils/config.js';
import { createCloudflarePublicationController } from './publicationController.mjs';
import { stablePublicationJson } from './publicationPlan.mjs';
import {
    inactivateEdgeRoutingGeneration,
    loadActiveEdgeRoutingGeneration,
    readEdgeRoutingSelection,
} from '../../cli/sandbox/edgeGeneration.js';
import { applyEdgeRoutingGeneration } from '../../cli/sandbox/coordinatedEdgeApply.js';
import {
    createWorkspaceMutationLease,
    releaseWorkspaceMutationLease,
} from '../../cli/utils/runtime/maintenanceLocks.js';
import { writeCloudflarePublicationStatus } from './status.mjs';

const DEFAULT_STATUS_FILE = path.join(PLOINKY_DIR, 'run', 'cloudflare-publication-status.json');
const ALLOWED_PUBLICATION_STATES = new Set([
    'ready',
    'reconciling',
    'error',
]);
const DEFAULT_EDGE_APPLY_BUSY_RETRY_ATTEMPTS = 50;
const DEFAULT_EDGE_APPLY_BUSY_RETRY_DELAY_MS = 100;

function publicationRuntimeError(message, code = 'CLOUDFLARE_RUNTIME_COORDINATION_FAILED') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function sleepFor(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createEdgePublicationRouteCoordinator({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    onCommit = () => {},
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
    timeoutMs = 15_000,
} = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('external hostname proof requires fetch');
    return async function probeHostname({ hostname, configurationGeneration, signal } = {}) {
        const generation = String(configurationGeneration || '');
        const timed = combineAbortSignal(signal, timeoutMs);
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
            const body = (await response.text()).slice(0, 4096);
            let parsed = null;
            try { parsed = JSON.parse(body); } catch (_) {}
            return {
                ok: response.status === 503
                    && response.headers.get('x-ploinky-edge-generation') === generation
                    && parsed?.error === 'HOST_SELECTOR_INACTIVE',
                status: response.status,
            };
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
    inactivateInvalidGeneration = inactivateEdgeRoutingGeneration,
} = {}) {
    const handledActivations = new Set();
    let stopped = false;
    let inFlight = null;
    let scheduledRetry = null;
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
    const routeCoordinator = routeCoordinatorFactory({ workspaceRoot, onCommit: rememberActivation });
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
        if (!lease) return;
        if (!releaseWorkspaceLease(lease)) {
            audit('cloudflare-workspace-lease-release-failed', {
                operation: String(lease.operation || 'cloudflare-publication'),
            });
        }
    }

    function retryActivationFor(input, fallbackActivationId) {
        try {
            const selected = loadActive({ workspaceRoot });
            if (selected.selector.generation === input.configurationGeneration
                && selected.selector.publicationState === 'error') {
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
                releasePublicationLease(workspaceLease);
                if (superseded && !stopped) void scan();
            }
        }, delayMs);
        retry.timer.unref?.();
    }

    async function scan() {
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
                    releasePublicationLease(workspaceLease);
                }
            }
            if (!active) return;
        }
        const observedActivationId = active.selector.activationId;
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
            releasePublicationLease(workspaceLease);
        }
    }

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
