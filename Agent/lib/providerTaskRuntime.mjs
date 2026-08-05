import { assertAgentCredentialContext } from './agentCredentialContext.mjs';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
    PROVIDER_SANDBOX_MODES,
    PROVIDER_SANDBOX_PROVIDERS,
    spawnProviderSandbox,
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
    const view = {
        stdin: child.stdin,
        stdout: redactedStream(child.stdout, secrets),
        stderr: redactedStream(child.stderr, secrets),
        kill(signal) { return processControl.signal(signal); },
        on(event, listener) { child.on(event, listener); return view; },
        once(event, listener) { child.once(event, listener); return view; },
        removeListener(event, listener) { child.removeListener(event, listener); return view; },
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
    provider,
    taskId,
    audience,
    signal,
    onSpawn,
    inspectProcessIdentity: inspectIdentity = inspectProcessIdentity,
    getUid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
} = {}) {
    const context = assertAgentCredentialContext(credentialContext);
    context.assertActive();
    assertScopedSoulBrokerRegistry(brokerRegistry, context);
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
    if (typeof inspectIdentity !== 'function' || typeof getUid !== 'function') {
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
    let abortListener = null;

    const spawnWith = async (spawnTaskSandbox, input, lifecycle = {}) => {
        if (closed || failedClosed || activeHandle || launchPending) {
            fail('PLOINKY_PROVIDER_RUNTIME_STATE_INVALID', 'provider runtime cannot launch in its current state');
        }
        if (typeof spawnTaskSandbox !== 'function') {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider sandbox spawn adapter must be a function');
        }
        assertPlainObject(input, 'provider launch input');
        if (input.provider !== undefined || input.mode !== undefined
            || input.credentialContext !== undefined || input.environment !== undefined) {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider launch cannot override trusted runtime fields');
        }
        assertExactKeys(
            lifecycle,
            new Set(['afterExit', 'environment', 'leaseMetadata', 'stdio']),
            'provider launch lifecycle',
        );
        if (lifecycle.afterExit !== undefined && typeof lifecycle.afterExit !== 'function') {
            fail('PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID', 'provider afterExit must be a function');
        }
        const extraEnvironment = lifecycle.environment ?? {};
        assertPlainObject(extraEnvironment, 'provider launch environment');
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
                activateCapability(metadata) {
                    if (!metadata || metadata.provider !== provider
                        || metadata.mode !== PROVIDER_SANDBOX_MODES.TASK) {
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
                    ], processControl);
                    if (onSpawn) onSpawn(pendingPublicChild);
                    if (closed || signal?.aborted) {
                        processControl.terminate('runtime-aborted-during-spawn').catch((error) => {
                            failedClosed = true;
                            retainedError = error;
                        });
                    }
                },
                leaseMetadata: {
                    taskId,
                    audience,
                    ...(lifecycle.leaseMetadata ?? {}),
                },
                ...(lifecycle.afterExit ? {
                    afterExit: ({ code, signal: exitSignal, launch }) => lifecycle.afterExit(Object.freeze({
                        code,
                        signal: exitSignal,
                        launch: publicLaunch(launch),
                    })),
                } : {}),
                ...(lifecycle.stdio ? { stdio: lifecycle.stdio } : {}),
            });
        } catch (error) {
            if (error?.ownershipRetained) {
                failedClosed = true;
                retainedError = error;
                pendingChild ||= error.retainedProcess?.child ?? null;
            } else {
                capability.close();
                currentCapability = null;
                pendingChild = null;
                pendingPublicChild = null;
                pendingProcessControl = null;
                launchPending = false;
            }
            throw error;
        }
        launchPending = false;
        pendingChild = null;
        const processControl = pendingProcessControl || handle?.processControl;
        if (closed || !capabilityWasActivated
            || !handle || typeof handle !== 'object'
            || !handle.child || !(handle.completion instanceof Promise)
            || !processControl
            || handle.launch?.helper !== '/usr/local/libexec/ploinky-bwrap-launch'
            || handle.launch?.provider !== provider
            || handle.launch?.mode !== PROVIDER_SANDBOX_MODES.TASK) {
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
        ], processControl);
        pendingPublicChild = null;
        pendingProcessControl = null;
        activeHandle = handle;
        activeProcessControl = processControl;
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

    const close = async () => {
        if (closed) return;
        closed = true;
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
        if (pendingProcessControl) {
            try { await pendingProcessControl.terminate('runtime-close-pending'); } catch (error) {
                failedClosed = true;
                retainedError = error;
                throw error;
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
                await handle.completion;
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
        if (failedClosed) {
            const error = new ProviderTaskRuntimeError(
                'PLOINKY_PROVIDER_RUNTIME_TERMINATION_UNPROVEN',
                'provider runtime remains fail-closed with retained lifecycle ownership',
                { cause: retainedError },
            );
            error.ownershipRetained = true;
            error.evidence = retainedError?.evidence ?? null;
            throw error;
        }
        currentCapability?.close();
        currentCapability = null;
    };

    return Object.freeze({
        provider,
        taskId,
        audience,
        spawnWith,
        launch(input, lifecycle = {}) {
            return spawnWith(
                (trustedInput, trustedLifecycle) => spawnProviderSandbox({
                    ...trustedInput,
                    mode: PROVIDER_SANDBOX_MODES.TASK,
                    provider,
                }, trustedLifecycle),
                input,
                lifecycle,
            );
        },
        close,
    });
}
