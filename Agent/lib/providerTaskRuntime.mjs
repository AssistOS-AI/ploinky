import { assertAgentCredentialContext } from './agentCredentialContext.mjs';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
    PROVIDER_SANDBOX_MODES,
    PROVIDER_SANDBOX_PROVIDERS,
    spawnProviderSandbox,
    withCredentialProviderHomeLease,
} from './providerSandbox.mjs';
import { assertScopedSoulBrokerRegistry } from './scopedSoulBroker.mjs';
import { inspectProcessIdentity, normalizeProcessIdentity } from './processIdentity.mjs';

const PROVIDERS = new Set(Object.values(PROVIDER_SANDBOX_PROVIDERS));

export class ProviderTaskRuntimeError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'ProviderTaskRuntimeError';
        this.code = code;
    }
}
function fail(code, message, cause) {
    throw new ProviderTaskRuntimeError(code, message, cause ? { cause } : undefined);
}

function retainedRuntimeError(source) {
    const error = new ProviderTaskRuntimeError(
        'PLOINKY_PROVIDER_RUNTIME_TERMINATION_UNPROVEN',
        'provider runtime could not prove exact terminal cleanup',
    );
    error.ownershipRetained = true;
    error.evidence = Object.freeze({
        phase: 'provider-runtime-cleanup',
        terminalObserved: source?.evidence?.terminalObserved === true,
        transportClosed: source?.evidence?.transportClosed === true,
    });
    return error;
}

function exactText(value, label, pattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/) {
    if (typeof value !== 'string' || !value || value !== value.trim()
        || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 256
        || !pattern.test(value)) {
        fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', `${label} is invalid`);
    }
    return value;
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', `${label} must be a plain object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', `${label} must be a plain object`);
    }
}

function assertExactKeys(value, allowed, label) {
    assertPlainObject(value, label);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', `${label} contains unknown field ${key}`);
        }
    }
}

function captureRuntimeOwnership(child, processControl, inspectIdentity, getUid) {
    const ownership = processControl?.ownership;
    const pid = Number(child?.pid);
    const uid = getUid();
    let inspected;
    try {
        inspected = inspectIdentity(pid);
    } catch (cause) {
        fail(
            'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID',
            'provider runtime process identity inspection failed',
            cause,
        );
    }
    let processIdentity = null;
    try { processIdentity = normalizeProcessIdentity(inspected?.processIdentity); } catch (_) { }
    if (!ownership || ownership.pid !== pid || ownership.processUid !== uid
        || inspected?.state !== 'identified' || inspected.processUid !== uid
        || processIdentity !== ownership.processIdentity
        || typeof processControl.signal !== 'function'
        || typeof processControl.terminate !== 'function') {
        fail(
            'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID',
            'provider runtime could not capture the canonical same-UID helper identity',
        );
    }
    return Object.freeze({ pid, processIdentity, processUid: uid });
}

function publicLaunch(launch) {
    return Object.freeze({
        helper: launch.helper,
        provider: launch.provider,
        mode: launch.mode,
        workdir: launch.workdir,
        cwd: launch.cwd,
    });
}

function redactedStream(source, secrets) {
    if (!source) return source;
    if (typeof source.pipe !== 'function') {
        fail('PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID', 'provider output stream is invalid');
    }
    const values = secrets.filter((value) => typeof value === 'string' && value.length > 0);
    const overlap = Math.max(0, ...values.map((value) => value.length - 1));
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const redact = (value) => {
        let result = value;
        for (const secret of values) result = result.split(secret).join('[REDACTED]');
        return result;
    };
    const output = new Transform({
        transform(chunk, _encoding, callback) {
            const combined = pending + decoder.write(Buffer.from(chunk));
            let cut = Math.max(0, combined.length - overlap);
            for (const secret of values) {
                const start = combined.lastIndexOf(secret, Math.max(0, cut - 1));
                if (start >= 0 && start < cut && start + secret.length > cut) cut = start;
            }
            pending = combined.slice(cut);
            callback(null, redact(combined.slice(0, cut)));
        },
        flush(callback) {
            callback(null, redact(pending + decoder.end()));
        },
    });
    source.pipe(output);
    return output;
}

function publicChild(child, secrets, processControl) {
    const listenerWrappers = new Map();
    const supportedEvents = new Set(['close', 'disconnect', 'error', 'exit']);
    const safeEventArgs = (event, args) => {
        if (event === 'close' || event === 'exit') {
            return [
                Number.isInteger(args[0]) ? args[0] : null,
                typeof args[1] === 'string' ? args[1] : null,
            ];
        }
        if (event === 'error') {
            const source = args[0];
            const error = new Error('provider child process emitted an error');
            if (typeof source?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(source.code)) {
                error.code = source.code;
            }
            return [Object.freeze(error)];
        }
        return [];
    };
    const assertListener = (event, listener) => {
        if (!supportedEvents.has(event) || typeof listener !== 'function') {
            fail(
                'PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID',
                'provider child listener must use a supported lifecycle event and function',
            );
        }
    };
    const forgetWrapper = (event, listener, wrapper) => {
        const eventListeners = listenerWrappers.get(event);
        const registrations = eventListeners?.get(listener);
        if (!registrations) return;
        const index = registrations.lastIndexOf(wrapper);
        if (index >= 0) registrations.splice(index, 1);
        if (registrations.length === 0) eventListeners.delete(listener);
        if (eventListeners.size === 0) listenerWrappers.delete(event);
    };
    const addListener = (event, listener, once) => {
        assertListener(event, listener);
        const eventListeners = listenerWrappers.get(event) ?? new Map();
        const registrations = eventListeners.get(listener) ?? [];
        const wrapper = function providerChildListener(...args) {
            if (once) forgetWrapper(event, listener, wrapper);
            return Reflect.apply(listener, view, safeEventArgs(event, args));
        };
        registrations.push(wrapper);
        eventListeners.set(listener, registrations);
        listenerWrappers.set(event, eventListeners);
        try {
            child[once ? 'once' : 'on'](event, wrapper);
        } catch (error) {
            forgetWrapper(event, listener, wrapper);
            throw error;
        }
        return view;
    };
    const view = {
        stdin: child.stdin,
        stdout: redactedStream(child.stdout, secrets),
        stderr: redactedStream(child.stderr, secrets),
        kill(signal) { return processControl.signal(signal); },
        on(event, listener) { return addListener(event, listener, false); },
        once(event, listener) { return addListener(event, listener, true); },
        removeListener(event, listener) {
            assertListener(event, listener);
            const registrations = listenerWrappers.get(event)?.get(listener);
            const wrapper = registrations?.at(-1);
            if (wrapper) {
                forgetWrapper(event, listener, wrapper);
                child.removeListener(event, wrapper);
            }
            return view;
        },
    };
    for (const name of ['pid', 'killed', 'exitCode', 'signalCode']) {
        Object.defineProperty(view, name, {
            enumerable: true,
            get: () => child[name],
        });
    }
    return Object.freeze(view);
}

/**
 * Bind one in-process provider invocation to the frozen AgentServer context,
 * one post-path-validation scoped broker capability, and one provider/task
 * audience. Before the helper readiness barrier there is only an unregistered
 * opaque token envelope, not broker state.
 * No credential material is serialized into a child process.
 */
export function createProviderTaskRuntime({
    credentialContext,
    brokerRegistry,
    mode,
    provider,
    taskId,
    audience,
    signal,
    onSpawn,
    withCredentialProviderHomeLease: withHomeLease = withCredentialProviderHomeLease,
    spawnProviderSandbox: spawnSandbox = spawnProviderSandbox,
    inspectProcessIdentity: inspectIdentity = inspectProcessIdentity,
    getUid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
} = {}) {
    const context = assertAgentCredentialContext(credentialContext);
    context.assertActive();
    assertScopedSoulBrokerRegistry(brokerRegistry, context);
    if (mode !== PROVIDER_SANDBOX_MODES.TASK
        && mode !== PROVIDER_SANDBOX_MODES.OPERATION) {
        fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider runtime mode is unsupported');
    }
    const initialMode = mode;
    let activeMode = mode;
    if (!PROVIDERS.has(provider)) {
        fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider is unsupported');
    }
    exactText(taskId, 'taskId');
    exactText(audience, 'audience');
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
        fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'signal must be an AbortSignal');
    }
    if (onSpawn !== undefined && typeof onSpawn !== 'function') {
        fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'onSpawn must be a function');
    }
    if (typeof withHomeLease !== 'function' || typeof spawnSandbox !== 'function'
        || typeof inspectIdentity !== 'function' || typeof getUid !== 'function') {
        fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'process identity dependencies are invalid');
    }

    let activeHandle = null;
    let activeProcessControl = null;
    let currentCapability = null;
    let launchPending = false;
    let pendingChild = null;
    let pendingPublicChild = null;
    let pendingProcessControl = null;
    let closed = false;
    let failedClosed = false;
    let retainedError = null;
    let retainedTerminalAuthority = null;
    let abortListener = null;
    let canonicalLaunches = 0;
    let resolutionMode = null;
    let homeResolutionAttempted = false;
    let homeResolutionPending = false;
    let homeResolutionSucceeded = false;
    const retainedOperations = new WeakMap();
    let claimedRetainedOperation = null;
    let closePromise = null;
    let cleanupComplete = false;
    let pendingLaunchSettlement = null;
    let pendingHomeResolutionSettlement = null;

    const spawnWithPending = async (spawnTaskSandbox, input, lifecycle = {}) => {
        if (closed || failedClosed || activeHandle || launchPending
            || homeResolutionPending || (homeResolutionAttempted && resolutionMode === null)) {
            fail('PLOINKY_PROVIDER_RUNTIME_STATE_INVALID', 'provider runtime cannot launch in its current state');
        }
        if (signal?.aborted) {
            fail(
                'PLOINKY_PROVIDER_RUNTIME_ABORTED',
                'provider runtime was aborted before spawn',
                signal.reason,
            );
        }
        if (typeof spawnTaskSandbox !== 'function') {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider sandbox spawn adapter must be a function');
        }
        assertPlainObject(input, 'provider launch input');
        const launchMode = activeMode;
        if (input.provider !== undefined || input.mode !== undefined
            || input.credentialContext !== undefined || input.environment !== undefined) {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider launch cannot override trusted runtime fields');
        }
        assertExactKeys(
            lifecycle,
            new Set(['afterExit', 'environment', 'leaseMetadata', 'observeProcess', 'stdio', 'validateAfterLease']),
            'provider launch lifecycle',
        );
        if (lifecycle.afterExit !== undefined && typeof lifecycle.afterExit !== 'function') {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider afterExit must be a function');
        }
        if (lifecycle.observeProcess !== undefined && typeof lifecycle.observeProcess !== 'function') {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider process observer must be a function');
        }
        if (lifecycle.validateAfterLease !== undefined && typeof lifecycle.validateAfterLease !== 'function') {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider HOME revalidation must be a function');
        }
        if (resolutionMode !== null && lifecycle.validateAfterLease === undefined) {
            fail(
                'PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID',
                'a continuation task launch requires post-lease HOME revalidation',
            );
        }
        const extraEnvironment = lifecycle.environment ?? {};
        assertPlainObject(extraEnvironment, 'provider launch environment');
        const privateOutputValues = Object.entries(extraEnvironment)
            .filter(([name, value]) => /(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL)/u.test(name)
                && typeof value === 'string' && value.length > 0)
            .map(([, value]) => value);
        launchPending = true;
        const capability = brokerRegistry.prepare({ taskId, provider, audience });
        currentCapability = capability;
        let capabilityWasActivated = false;
        let handle;
        try {
            handle = await spawnTaskSandbox({
                ...input,
                credentialContext: context,
                environment: { ...extraEnvironment, ...capability.environment },
            }, {
                ...(signal ? { signal } : {}),
                activateCapability(metadata) {
                    if (!metadata || metadata.provider !== provider
                        || metadata.mode !== launchMode) {
                        fail(
                            'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID',
                            'provider adapter attempted to activate the wrong sandbox boundary',
                        );
                    }
                    capability.activate();
                    capabilityWasActivated = true;
                },
                deactivateCapability() {
                    capability.close();
                },
                onSpawn: (child, processControl) => {
                    captureRuntimeOwnership(child, processControl, inspectIdentity, getUid);
                    pendingChild = child;
                    pendingProcessControl = processControl;
                    pendingPublicChild = publicChild(child, [
                        capability.environment.PLOINKY_TASK_BROKER_KEY,
                        ...privateOutputValues,
                    ], processControl);
                    if (onSpawn) onSpawn(pendingPublicChild);
                    if (lifecycle.observeProcess) lifecycle.observeProcess(pendingPublicChild);
                    if (closed || signal?.aborted) {
                        processControl.terminate('runtime-aborted-during-spawn').catch((error) => {
                            failedClosed = true;
                            retainedError = error;
                        });
                    }
                },
                leaseMetadata: {
                    ...(lifecycle.leaseMetadata ?? {}),
                    taskId,
                    audience,
                    mode: launchMode,
                },
                ...(lifecycle.afterExit ? {
                    afterExit: ({ code, signal: exitSignal, launch }) => lifecycle.afterExit(Object.freeze({
                        code,
                        signal: exitSignal,
                        launch: publicLaunch(launch),
                    })),
                } : {}),
                ...(lifecycle.validateAfterLease ? {
                    validateAfterLease: async (home) => {
                        assertExactKeys(
                            home,
                            new Set(['provider', 'mode', 'workdir', 'homePath', 'runtimeKind']),
                            'provider HOME revalidation context',
                        );
                        const expectedHomePath = context.runtime.runtimeKind === 'bwrap'
                            ? '/home/agent'
                            : '/root';
                        if (home.provider !== provider || home.mode !== launchMode
                            || home.homePath !== expectedHomePath
                            || home.runtimeKind !== context.runtime.runtimeKind) {
                            fail(
                                'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID',
                                'provider adapter attempted HOME revalidation outside the exact runtime boundary',
                            );
                        }
                        return lifecycle.validateAfterLease(Object.freeze({ ...home }));
                    },
                } : {}),
                ...(lifecycle.stdio ? { stdio: lifecycle.stdio } : {}),
            });
        } catch (error) {
            if (error?.ownershipRetained) {
                failedClosed = true;
                const retainedProcess = error.retainedProcess;
                if (retainedProcess?.child && retainedProcess.terminal instanceof Promise) {
                    pendingChild ||= retainedProcess.child;
                    const authority = {
                        settled: false,
                        terminalProven: false,
                    };
                    authority.promise = retainedProcess.terminal.then(() => {
                        authority.settled = true;
                        authority.terminalProven = true;
                    }, () => {
                        authority.settled = true;
                    });
                    void authority.promise.catch(() => {});
                    retainedTerminalAuthority = authority;
                }
                const sanitized = retainedRuntimeError(error);
                retainedError = sanitized;
                throw sanitized;
            } else {
                capability.close();
                currentCapability = null;
                pendingChild = null;
                pendingPublicChild = null;
                pendingProcessControl = null;
            }
            throw error;
        }
        pendingChild = null;
        const processControl = pendingProcessControl || handle?.processControl;
        if (closed || !capabilityWasActivated
            || !handle || typeof handle !== 'object'
            || !handle.child || !(handle.completion instanceof Promise)
            || !processControl
            || handle.launch?.helper !== '/usr/local/libexec/ploinky-bwrap-launch'
            || handle.launch?.provider !== provider
            || handle.launch?.mode !== launchMode) {
            if (!processControl) {
                failedClosed = true;
                const error = new ProviderTaskRuntimeError(
                    'PLOINKY_PROVIDER_RUNTIME_TERMINATION_UNPROVEN',
                    'provider adapter returned no verified process controller; lifecycle ownership is retained',
                );
                error.ownershipRetained = true;
                retainedError = error;
                throw error;
            }
            try {
                await processControl.terminate('runtime-boundary-rejection');
            } catch (error) {
                failedClosed = true;
                retainedError = error;
                const boundaryError = new ProviderTaskRuntimeError(
                    'PLOINKY_PROVIDER_RUNTIME_TERMINATION_UNPROVEN',
                    'provider runtime rejected a boundary but could not prove terminal cleanup',
                    { cause: error },
                );
                boundaryError.ownershipRetained = true;
                boundaryError.evidence = error?.evidence ?? null;
                throw boundaryError;
            }
            try {
                await handle?.completion;
            } catch (error) {
                if (error?.ownershipRetained) {
                    failedClosed = true;
                    retainedError = error;
                    const boundaryError = new ProviderTaskRuntimeError(
                        'PLOINKY_PROVIDER_RUNTIME_TERMINATION_UNPROVEN',
                        'provider runtime rejected a boundary but terminal cleanup retained ownership',
                        { cause: error },
                    );
                    boundaryError.ownershipRetained = true;
                    boundaryError.evidence = error?.evidence ?? null;
                    throw boundaryError;
                }
            }
            capability.close();
            if (currentCapability === capability) currentCapability = null;
            fail(
                'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID',
                'provider adapter did not return the canonical activated helper boundary',
            );
        }
        const childView = pendingPublicChild || publicChild(handle.child, [
            capability.environment.PLOINKY_TASK_BROKER_KEY,
            ...privateOutputValues,
        ], processControl);
        pendingPublicChild = null;
        pendingProcessControl = null;
        activeHandle = handle;
        activeProcessControl = processControl;
        canonicalLaunches += 1;
        if (signal) {
            abortListener = () => {
                processControl.terminate('runtime-abort').catch((error) => {
                    failedClosed = true;
                    retainedError = error;
                });
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }
        handle.completion.then(() => {
            if (signal && abortListener) signal.removeEventListener('abort', abortListener);
            abortListener = null;
            activeHandle = null;
            activeProcessControl = null;
            capability.close();
            if (currentCapability === capability) currentCapability = null;
            failedClosed = false;
            retainedError = null;
        }, (error) => {
            if (signal && abortListener) signal.removeEventListener('abort', abortListener);
            abortListener = null;
            if (error?.ownershipRetained) {
                failedClosed = true;
                retainedError = error;
            } else {
                activeHandle = null;
                activeProcessControl = null;
                capability.close();
                if (currentCapability === capability) currentCapability = null;
            }
        });
        return Object.freeze({
            child: childView,
            completion: handle.completion,
            launch: publicLaunch(handle.launch),
        });
    };

    const spawnWith = async (...args) => {
        if (pendingLaunchSettlement) return spawnWithPending(...args);
        let settleLaunch;
        const settlement = new Promise((resolve) => { settleLaunch = resolve; });
        pendingLaunchSettlement = settlement;
        try {
            return await spawnWithPending(...args);
        } finally {
            launchPending = false;
            settleLaunch();
            if (pendingLaunchSettlement === settlement) pendingLaunchSettlement = null;
        }
    };

    const resolveHomeState = async (resolver) => {
        if (typeof resolver !== 'function') {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider HOME resolver must be a function');
        }
        if (closed || failedClosed || launchPending || activeHandle
            || signal?.aborted
            || initialMode !== PROVIDER_SANDBOX_MODES.OPERATION
            || activeMode !== PROVIDER_SANDBOX_MODES.OPERATION
            || resolutionMode !== null || canonicalLaunches !== 0
            || homeResolutionAttempted || homeResolutionPending) {
            fail('PLOINKY_PROVIDER_RUNTIME_STATE_INVALID', 'provider runtime cannot resolve HOME state in its current state');
        }
        homeResolutionAttempted = true;
        homeResolutionPending = true;
        let settleResolution;
        const settlement = new Promise((resolve) => { settleResolution = resolve; });
        pendingHomeResolutionSettlement = settlement;
        try {
            const result = await withHomeLease({
                credentialContext: context,
                provider,
                taskId,
                audience,
            }, async (home) => {
                assertExactKeys(
                    home,
                    new Set(['homePath', 'provider', 'runtimeKind']),
                    'provider HOME resolver context',
                );
                const expectedHomePath = context.runtime.runtimeKind === 'bwrap'
                    ? '/home/agent'
                    : '/root';
                if (home.provider !== provider
                    || home.homePath !== expectedHomePath
                    || home.runtimeKind !== context.runtime.runtimeKind) {
                    fail(
                        'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID',
                        'provider HOME resolver received the wrong runtime boundary',
                    );
                }
                return resolver(Object.freeze({ ...home }));
            });
            if (closed || signal?.aborted) {
                fail('PLOINKY_PROVIDER_RUNTIME_STATE_INVALID', 'provider runtime closed during HOME state resolution');
            }
            homeResolutionSucceeded = true;
            return result;
        } finally {
            homeResolutionPending = false;
            settleResolution();
            if (pendingHomeResolutionSettlement === settlement) {
                pendingHomeResolutionSettlement = null;
            }
        }
    };

    const transitionToTask = () => {
        if (closed || failedClosed || launchPending || activeHandle
            || initialMode !== PROVIDER_SANDBOX_MODES.OPERATION
            || activeMode !== PROVIDER_SANDBOX_MODES.OPERATION
            || resolutionMode !== null
            || canonicalLaunches !== 0
            || !homeResolutionAttempted || homeResolutionPending || !homeResolutionSucceeded
            || currentCapability !== null) {
            fail(
                'PLOINKY_PROVIDER_RUNTIME_TRANSITION_INVALID',
                'provider runtime cannot transition from operation resolution to task execution',
            );
        }
        activeMode = PROVIDER_SANDBOX_MODES.TASK;
        resolutionMode = PROVIDER_SANDBOX_MODES.TASK;
        return activeMode;
    };

    const continueOperation = () => {
        if (closed || failedClosed || launchPending || activeHandle
            || initialMode !== PROVIDER_SANDBOX_MODES.OPERATION
            || activeMode !== PROVIDER_SANDBOX_MODES.OPERATION
            || resolutionMode !== null
            || canonicalLaunches !== 0
            || !homeResolutionAttempted || homeResolutionPending || !homeResolutionSucceeded
            || currentCapability !== null) {
            fail(
                'PLOINKY_PROVIDER_RUNTIME_TRANSITION_INVALID',
                'provider runtime cannot continue operation execution after state resolution',
            );
        }
        resolutionMode = PROVIDER_SANDBOX_MODES.OPERATION;
        return activeMode;
    };

    const launchRetainedOperation = async (input, lifecycle = {}) => {
        if (activeMode !== PROVIDER_SANDBOX_MODES.OPERATION
            || resolutionMode === PROVIDER_SANDBOX_MODES.TASK || claimedRetainedOperation) {
            fail(
                'PLOINKY_PROVIDER_RUNTIME_RETAIN_INVALID',
                'only an unused operation runtime can start a retained provider operation',
            );
        }
        const handle = await spawnWith(
            (trustedInput, trustedLifecycle) => spawnSandbox({
                ...trustedInput,
                mode: PROVIDER_SANDBOX_MODES.OPERATION,
                provider,
            }, trustedLifecycle),
            input,
            lifecycle,
        );
        const controller = Object.freeze({
            stdin: handle.child.stdin,
            stdout: handle.child.stdout,
            stderr: handle.child.stderr,
            completion: handle.completion,
            launch: handle.launch,
        });
        retainedOperations.set(controller, handle);
        return controller;
    };

    const claimRetainedOperation = (controller) => {
        const handle = controller && retainedOperations.get(controller);
        if (!handle || claimedRetainedOperation || !activeHandle
            || activeHandle.completion !== handle.completion
            || activeMode !== PROVIDER_SANDBOX_MODES.OPERATION
            || canonicalLaunches !== 1) {
            fail(
                'PLOINKY_PROVIDER_RUNTIME_RETAIN_INVALID',
                'provider operation is not the exact active canonical runtime handle',
            );
        }
        claimedRetainedOperation = controller;
        return true;
    };

    const close = async () => {
        if (cleanupComplete) return;
        if (!closePromise) {
            closed = true;
            closePromise = (async () => {
                if (signal && abortListener) signal.removeEventListener('abort', abortListener);
                if (pendingLaunchSettlement) await pendingLaunchSettlement;
                if (pendingHomeResolutionSettlement) await pendingHomeResolutionSettlement;
                if (pendingProcessControl) {
                    try { await pendingProcessControl.terminate('runtime-close-pending'); } catch (error) {
                        failedClosed = true;
                        const sanitized = retainedRuntimeError(error);
                        retainedError = sanitized;
                        throw sanitized;
                    }
                }
                if (activeHandle) {
                    const handle = activeHandle;
                    try {
                        await activeProcessControl.terminate('runtime-close-active');
                    } catch (error) {
                        failedClosed = true;
                        retainedError = error;
                        throw error;
                    }
                    try {
                        if (failedClosed && typeof handle.cleanup === 'function') {
                            await handle.cleanup();
                            failedClosed = false;
                            retainedError = null;
                        } else {
                            await handle.completion;
                        }
                    } catch (error) {
                        if (error?.ownershipRetained) {
                            failedClosed = true;
                            retainedError = error;
                            throw error;
                        }
                        activeHandle = null;
                        activeProcessControl = null;
                        currentCapability?.close();
                        currentCapability = null;
                        throw error;
                    }
                    activeHandle = null;
                    activeProcessControl = null;
                }
                if (failedClosed && retainedTerminalAuthority?.settled
                    && retainedTerminalAuthority.terminalProven) {
                    pendingChild = null;
                    pendingPublicChild = null;
                    retainedTerminalAuthority = null;
                    failedClosed = false;
                    retainedError = null;
                }
                if (failedClosed) {
                    throw retainedRuntimeError(retainedError);
                }
                currentCapability?.close();
                currentCapability = null;
                cleanupComplete = true;
            })();
        }
        try {
            await closePromise;
        } finally {
            if (!cleanupComplete) closePromise = null;
        }
    };

    return Object.freeze({
        provider,
        get mode() { return activeMode; },
        taskId,
        audience,
        assertBoundaryUnused() {
            if (canonicalLaunches !== 0 || launchPending || pendingLaunchSettlement
                || activeHandle || pendingChild || pendingPublicChild || pendingProcessControl
                || currentCapability || failedClosed || claimedRetainedOperation
                || homeResolutionAttempted || homeResolutionPending || homeResolutionSucceeded
                || pendingHomeResolutionSettlement || resolutionMode !== null) {
                fail(
                    'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_UNEXPECTED',
                    'pure provider control unexpectedly used a provider execution boundary',
                );
            }
            return true;
        },
        assertBoundaryUsed() {
            if (canonicalLaunches < 1) {
                fail(
                    'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_REQUIRED',
                    'provider module returned without using the canonical provider boundary',
                );
            }
            return true;
        },
        claimRetainedOperation,
        continueOperation,
        launchRetainedOperation,
        resolveHomeState,
        spawnWith,
        transitionToTask,
        launch(input, lifecycle = {}) {
            const launchMode = activeMode;
            return spawnWith(
                (trustedInput, trustedLifecycle) => spawnSandbox({
                    ...trustedInput,
                    mode: launchMode,
                    provider,
                }, trustedLifecycle),
                input,
                lifecycle,
            );
        },
        close,
    });
}
