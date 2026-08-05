import { randomBytes, randomUUID } from 'node:crypto';

const OPERATIONS = new Set(['login_start', 'login_status', 'login_respond', 'login_cancel']);
const STATUSES = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled', 'expired']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);
const ERROR_CODES = new Set([
    'provider_login_failed',
    'provider_login_output_invalid',
    'provider_login_completion_failed',
    'provider_login_response_failed',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FLOW_RE = /^login:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;
const OWNER_RE = /^[a-f0-9]{64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const USER_CODE_RE = /^[A-Za-z0-9-]{4,64}$/;
const MAX_RESPONSE_BYTES = 8 * 1024;
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_ACTIVE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TERMINAL_TTL_MS = 5 * 60 * 1000;
const COMPLETION_CALLBACK_TIMEOUT_MS = 5_000;

export class ProviderOperationSessionError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'ProviderOperationSessionError';
        this.code = code;
    }
}

function fail(code, message, cause) {
    throw new ProviderOperationSessionError(code, message, cause ? { cause } : undefined);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, required, label, code = 'PLOINKY_PROVIDER_LOGIN_STATE_INVALID') {
    if (!isPlainObject(value)) fail(code, `${label} must be a plain object`);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(code, `${label} contains an unknown field`);
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code, `${label} is incomplete`);
    }
}

function boundedName(value, label) {
    if (typeof value !== 'string' || !NAME_RE.test(value)) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', `${label} is invalid`);
    }
    return value;
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

function normalizeHttpsUrl(value) {
    if (typeof value !== 'string' || value !== value.trim()
        || Buffer.byteLength(value, 'utf8') > 4096) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login verification URL is invalid');
    }
    let parsed;
    try { parsed = new URL(value); } catch (_) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login verification URL is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login verification URL is invalid');
    }
    return value;
}

function normalizeChallenge(value) {
    assertExactKeys(
        value,
        new Set(['type', 'verificationUri', 'userCode']),
        new Set(['type', 'verificationUri']),
        'provider login challenge',
    );
    if (value.type !== 'device_code' && value.type !== 'authorization_url') {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login challenge type is invalid');
    }
    if (value.type === 'device_code') {
        if (typeof value.userCode !== 'string' || !USER_CODE_RE.test(value.userCode)) {
            fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login device code is invalid');
        }
    } else if (value.userCode !== undefined) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'authorization URL challenge cannot include a device code');
    }
    return deepFreeze({
        type: value.type,
        verificationUri: normalizeHttpsUrl(value.verificationUri),
        ...(value.type === 'device_code' ? { userCode: value.userCode } : {}),
    });
}

function normalizePrompt(value) {
    assertExactKeys(
        value,
        new Set(['type', 'seq', 'nonce']),
        new Set(['type', 'seq', 'nonce']),
        'provider login prompt',
    );
    if (value.type !== 'manual_code' && value.type !== 'manual_callback') {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login prompt type is invalid');
    }
    if (!Number.isSafeInteger(value.seq) || value.seq < 1
        || typeof value.nonce !== 'string' || !NONCE_RE.test(value.nonce)) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login prompt binding is invalid');
    }
    return deepFreeze({ type: value.type, seq: value.seq, nonce: value.nonce });
}

function normalizeState(flowId, continuationHandle, authProvider, method, state) {
    assertExactKeys(
        state,
        new Set(['status', 'challenge', 'prompt', 'error']),
        new Set(['status']),
        'provider login state',
    );
    if (!STATUSES.has(state.status)) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login status is invalid');
    }
    const terminal = TERMINAL_STATUSES.has(state.status);
    if (terminal && (state.challenge !== undefined || state.prompt !== undefined)) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'terminal provider login state cannot expose a challenge');
    }
    if (state.error !== undefined
        && (state.status !== 'failed' || !ERROR_CODES.has(state.error))) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login error code is invalid');
    }
    if (state.status === 'failed' && state.error === undefined) {
        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'failed provider login state requires an error code');
    }
    const result = {
        type: 'login-flow',
        version: 1,
        flowId,
        continuationHandle,
        provider: authProvider,
        method,
        status: state.status,
    };
    if (state.challenge !== undefined) result.challenge = normalizeChallenge(state.challenge);
    if (state.prompt !== undefined) result.prompt = normalizePrompt(state.prompt);
    if (state.error !== undefined) result.error = state.error;
    return deepFreeze(result);
}

function normalizeOutcome(value) {
    if (!isPlainObject(value)
        || Object.keys(value).some((key) => key !== 'code' && key !== 'signal')
        || !Object.prototype.hasOwnProperty.call(value, 'code')
        || !Object.prototype.hasOwnProperty.call(value, 'signal')
        || (value.code !== null && (!Number.isSafeInteger(value.code) || value.code < 0 || value.code > 255))
        || (value.signal !== null
            && (typeof value.signal !== 'string' || !/^SIG[A-Z0-9]{1,16}$/.test(value.signal)))) {
        return deepFreeze({ code: null, signal: null });
    }
    return deepFreeze({ code: value.code, signal: value.signal });
}

function normalizeControl(value) {
    assertExactKeys(
        value,
        new Set(['flowId', 'continuationHandle']),
        new Set(['flowId', 'continuationHandle']),
        'provider login control',
        'PLOINKY_PROVIDER_LOGIN_FLOW_NOT_FOUND',
    );
    if (typeof value.flowId !== 'string' || !FLOW_RE.test(value.flowId)
        || typeof value.continuationHandle !== 'string'
        || !HANDLE_RE.test(value.continuationHandle)) {
        fail('PLOINKY_PROVIDER_LOGIN_FLOW_NOT_FOUND', 'provider login flow was not found');
    }
    return value;
}

function normalizeResponse(value, state) {
    assertExactKeys(
        value,
        new Set(['seq', 'nonce', 'response']),
        new Set(['seq', 'nonce', 'response']),
        'provider login response',
        'PLOINKY_PROVIDER_LOGIN_RESPONSE_INVALID',
    );
    if (!Number.isSafeInteger(value.seq) || value.seq < 1
        || typeof value.nonce !== 'string'
        || typeof value.response !== 'string' || value.response.includes('\0')
        || Buffer.byteLength(value.response, 'utf8') < 1
        || Buffer.byteLength(value.response, 'utf8') > MAX_RESPONSE_BYTES
        || value.seq !== state.prompt?.seq || value.nonce !== state.prompt?.nonce) {
        fail('PLOINKY_PROVIDER_LOGIN_RESPONSE_INVALID', 'provider login response does not match the active prompt');
    }
    return Object.freeze({ seq: value.seq, nonce: value.nonce, response: value.response });
}

function validateRegistryOptions(options) {
    if (!isPlainObject(options)) throw new TypeError('provider operation session options must be a plain object');
    for (const key of Object.keys(options)) {
        if (![
            'createId', 'createHandle', 'now', 'setTimeout', 'clearTimeout',
            'maxSessions', 'activeTtlMs', 'terminalTtlMs',
        ].includes(key)) {
            throw new TypeError(`provider operation session options contain unknown field ${key}`);
        }
    }
}

export function createProviderOperationSessionRegistry(options = {}) {
    validateRegistryOptions(options);
    const createId = options.createId ?? randomUUID;
    const createHandle = options.createHandle ?? (() => randomBytes(32).toString('base64url'));
    const now = options.now ?? Date.now;
    const setTimer = options.setTimeout ?? setTimeout;
    const clearTimer = options.clearTimeout ?? clearTimeout;
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const activeTtlMs = options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS;
    const terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
    if (typeof createId !== 'function' || typeof createHandle !== 'function'
        || typeof now !== 'function' || typeof setTimer !== 'function'
        || typeof clearTimer !== 'function'
        || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 64
        || !Number.isSafeInteger(activeTtlMs) || activeTtlMs < 1_000 || activeTtlMs > 60 * 60 * 1000
        || !Number.isSafeInteger(terminalTtlMs) || terminalTtlMs < 1_000
        || terminalTtlMs > 60 * 60 * 1000) {
        throw new TypeError('provider operation session options are invalid');
    }

    const records = new Map();
    let admissionClosed = false;
    let cleanupComplete = false;
    let closingPromise = null;

    const clearRecordTimer = (record) => {
        if (record.timer) clearTimer(record.timer);
        record.timer = null;
    };

    const activeRecordCount = () => {
        let count = 0;
        for (const record of records.values()) {
            if (!TERMINAL_STATUSES.has(record.state.status)) count += 1;
        }
        return count;
    };

    const lookup = (control, provider, ownerBinding) => {
        const normalized = normalizeControl(control);
        const record = records.get(normalized.flowId);
        if (!record || !record.committed || record.provider !== provider
            || record.ownerBinding !== ownerBinding
            || record.continuationHandle !== normalized.continuationHandle) {
            fail('PLOINKY_PROVIDER_LOGIN_FLOW_NOT_FOUND', 'provider login flow was not found');
        }
        return record;
    };

    const publishNonterminal = (record, next) => {
        if (record.terminalIntent || TERMINAL_STATUSES.has(record.state.status)) {
            fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login flow is finalizing');
        }
        const normalized = normalizeState(
            record.flowId,
            record.continuationHandle,
            record.authProvider,
            record.method,
            next,
        );
        if (TERMINAL_STATUSES.has(normalized.status)) {
            fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'terminal state is owned by the registry finalizer');
        }
        if (normalized.prompt && normalized.prompt.seq <= record.lastPromptSequence) {
            fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'provider login prompt sequence must increase');
        }
        if (normalized.prompt) record.lastPromptSequence = normalized.prompt.seq;
        record.state = normalized;
        return normalized;
    };

    const enqueue = (record, operation) => {
        const result = record.queue.then(operation, operation);
        record.queue = result.catch(() => {});
        return result;
    };

    const scheduleTerminalDeletion = (record) => {
        clearRecordTimer(record);
        record.timer = setTimer(() => {
            if (records.get(record.flowId) === record) records.delete(record.flowId);
        }, terminalTtlMs);
        record.timer?.unref?.();
    };

    const scheduleCleanupRetry = (record) => {
        clearRecordTimer(record);
        record.timer = setTimer(() => beginFinalization(record), Math.min(activeTtlMs, 30_000));
        record.timer?.unref?.();
    };

    const invokeCompletionCallback = async (record, outcome) => {
        const timedOut = Symbol('completion-callback-timeout');
        let timer = null;
        const callback = Promise.resolve().then(() => record.onCompletion(Object.freeze({ outcome })));
        const timeout = new Promise((resolve) => {
            timer = setTimer(() => resolve(timedOut), COMPLETION_CALLBACK_TIMEOUT_MS);
            timer?.unref?.();
        });
        try {
            const candidate = await Promise.race([callback, timeout]);
            if (candidate === timedOut) {
                fail(
                    'PLOINKY_PROVIDER_LOGIN_STATE_INVALID',
                    'provider login completion callback exceeded its fixed deadline',
                );
            }
            return candidate;
        } finally {
            if (timer) clearTimer(timer);
        }
    };

    const finalizeCandidate = async (record) => {
        const spec = record.finalizationSpec;
        if (spec.kind !== 'natural') {
            return spec.status === 'failed'
                ? { status: 'failed', error: spec.error }
                : { status: spec.status };
        }
        const outcome = normalizeOutcome(spec.outcome);
        try {
            if (record.onCompletion) {
                const candidate = await invokeCompletionCallback(record, outcome);
                if (candidate !== undefined) {
                    const normalized = normalizeState(
                        record.flowId,
                        record.continuationHandle,
                        record.authProvider,
                        record.method,
                        candidate,
                    );
                    if (!TERMINAL_STATUSES.has(normalized.status)) {
                        fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'completion result must be terminal');
                    }
                    return candidate;
                }
            }
            return outcome.code === 0 && outcome.signal === null
                ? { status: 'completed' }
                : { status: 'failed', error: 'provider_login_failed' };
        } catch (_) {
            return { status: 'failed', error: 'provider_login_completion_failed' };
        }
    };

    const beginFinalization = (record) => {
        if (TERMINAL_STATUSES.has(record.state.status)) return Promise.resolve(record.state);
        if (record.finalizationPromise) return record.finalizationPromise;
        clearRecordTimer(record);
        record.abortController.abort(record.terminalIntent);
        record.finalizationPromise = (async () => {
            try {
                await record.providerRuntime.close();
            } catch (error) {
                record.finalizationPromise = null;
                scheduleCleanupRetry(record);
                throw error;
            }
            record.providerRuntime = null;
            record.controller = null;
            const candidate = await finalizeCandidate(record);
            const terminalState = normalizeState(
                record.flowId,
                record.continuationHandle,
                record.authProvider,
                record.method,
                candidate,
            );
            if (!TERMINAL_STATUSES.has(terminalState.status)) {
                fail('PLOINKY_PROVIDER_LOGIN_STATE_INVALID', 'registry finalizer requires terminal state');
            }
            if (!record.committed) {
                records.delete(record.flowId);
                return null;
            }
            record.state = terminalState;
            scheduleTerminalDeletion(record);
            return record.state;
        })();
        record.finalizationPromise.catch(() => {});
        return record.finalizationPromise;
    };

    const requestForcedFinalization = (record, status, error = 'provider_login_failed') => {
        if (!record.terminalIntent) {
            record.terminalIntent = status;
            record.finalizationSpec = Object.freeze({ kind: 'forced', status, error });
        }
        return beginFinalization(record);
    };

    const requestNaturalFinalization = (record, outcome) => {
        if (!record.terminalIntent) {
            record.terminalIntent = 'natural';
            record.finalizationSpec = Object.freeze({ kind: 'natural', outcome });
        }
        return beginFinalization(record);
    };

    const scheduleActiveExpiry = (record) => {
        clearRecordTimer(record);
        record.timer = setTimer(() => requestForcedFinalization(record, 'expired'), activeTtlMs);
        record.timer?.unref?.();
    };

    const createInvocation = ({ provider, operation, ownerBinding, providerRuntime } = {}) => {
        if (admissionClosed) fail('PLOINKY_PROVIDER_LOGIN_REGISTRY_CLOSED', 'provider login registry is closed');
        const normalizedProvider = boundedName(provider, 'provider login runtime provider');
        if (!OPERATIONS.has(operation) || typeof ownerBinding !== 'string' || !OWNER_RE.test(ownerBinding)
            || !providerRuntime || typeof providerRuntime !== 'object'
            || providerRuntime.provider !== normalizedProvider || providerRuntime.mode !== 'operation'
            || typeof providerRuntime.assertBoundaryUsed !== 'function'
            || typeof providerRuntime.assertBoundaryUnused !== 'function'
            || typeof providerRuntime.claimRetainedOperation !== 'function'
            || typeof providerRuntime.close !== 'function') {
            fail('PLOINKY_PROVIDER_LOGIN_INVOCATION_INVALID', 'provider login invocation is invalid');
        }
        let action = 'unused';
        let record = null;
        let revoked = false;
        let controlPromise = null;

        const assertInvocationOpen = () => {
            if (admissionClosed || revoked) {
                fail('PLOINKY_PROVIDER_LOGIN_REGISTRY_CLOSED', 'provider login registry is closed');
            }
        };

        const beginControl = () => {
            assertInvocationOpen();
            if (action !== 'unused') {
                fail('PLOINKY_PROVIDER_LOGIN_INVOCATION_INVALID', 'provider login invocation already performed an action');
            }
            providerRuntime.assertBoundaryUnused();
            action = 'control';
        };

        const invocation = {
            async retainLoginOperation({
                controller,
                authProvider,
                method,
                initialState,
                onStatus,
                onRespond,
                onCompletion,
            } = {}) {
                assertInvocationOpen();
                if (operation !== 'login_start' || action !== 'unused'
                    || activeRecordCount() >= maxSessions
                    || !controller || typeof controller !== 'object'
                    || !(controller.completion instanceof Promise)
                    || (onStatus !== undefined && typeof onStatus !== 'function')
                    || (onRespond !== undefined && typeof onRespond !== 'function')
                    || (onCompletion !== undefined && typeof onCompletion !== 'function')) {
                    fail('PLOINKY_PROVIDER_LOGIN_RETAIN_INVALID', 'provider login operation cannot be retained');
                }
                let flowId = null;
                for (let attempt = 0; attempt < 8; attempt += 1) {
                    const id = createId();
                    if (typeof id !== 'string' || !UUID_RE.test(id)) {
                        fail('PLOINKY_PROVIDER_LOGIN_RETAIN_INVALID', 'provider login flow identity is invalid');
                    }
                    const candidate = `login:${id}`;
                    if (!records.has(candidate)) {
                        flowId = candidate;
                        break;
                    }
                }
                if (!flowId) fail('PLOINKY_PROVIDER_LOGIN_RETAIN_INVALID', 'provider login flow identity collided');
                const continuationHandle = createHandle();
                if (typeof continuationHandle !== 'string' || !HANDLE_RE.test(continuationHandle)) {
                    fail('PLOINKY_PROVIDER_LOGIN_RETAIN_INVALID', 'provider login continuation handle is invalid');
                }
                const normalizedAuthProvider = boundedName(authProvider, 'provider login auth provider');
                const normalizedMethod = boundedName(method, 'provider login method');
                const state = normalizeState(
                    flowId,
                    continuationHandle,
                    normalizedAuthProvider,
                    normalizedMethod,
                    initialState,
                );
                if (TERMINAL_STATUSES.has(state.status)) {
                    fail('PLOINKY_PROVIDER_LOGIN_RETAIN_INVALID', 'retained provider login must start nonterminal');
                }
                providerRuntime.assertBoundaryUsed();
                providerRuntime.claimRetainedOperation(controller);
                record = {
                    flowId,
                    continuationHandle,
                    provider: normalizedProvider,
                    ownerBinding,
                    authProvider: normalizedAuthProvider,
                    method: normalizedMethod,
                    state,
                    controller,
                    providerRuntime,
                    onStatus,
                    onRespond,
                    onCompletion,
                    committed: false,
                    consumedPrompts: new Set(),
                    abortController: new AbortController(),
                    terminalIntent: null,
                    finalizationSpec: null,
                    finalizationPromise: null,
                    queue: Promise.resolve(),
                    timer: null,
                    createdAt: now(),
                    lastPromptSequence: state.prompt?.seq ?? 0,
                };
                records.set(flowId, record);
                action = 'staged';
                return state;
            },
            commitRetainedOperation(publishedState) {
                assertInvocationOpen();
                if (action !== 'staged' || !record || record.committed
                    || JSON.stringify(publishedState) !== JSON.stringify(record.state)) {
                    fail('PLOINKY_PROVIDER_LOGIN_RETAIN_INVALID', 'provider login publication does not match the staged flow');
                }
                record.committed = true;
                action = 'retained';
                scheduleActiveExpiry(record);
                record.controller.completion.then(
                    (outcome) => requestNaturalFinalization(record, outcome),
                    () => requestNaturalFinalization(record, { code: null, signal: null }),
                ).catch(() => {});
                return record.state;
            },
            async getLoginStatus(control) {
                if (operation !== 'login_status') {
                    fail('PLOINKY_PROVIDER_LOGIN_INVOCATION_INVALID', 'provider login status used by the wrong operation');
                }
                beginControl();
                const target = lookup(control, normalizedProvider, ownerBinding);
                if (target.terminalIntent || TERMINAL_STATUSES.has(target.state.status)) {
                    return target.state;
                }
                let callbackFailed = false;
                try {
                    return await enqueue(target, async () => {
                        if (target.onStatus && !target.terminalIntent
                            && !TERMINAL_STATUSES.has(target.state.status)) {
                            try {
                                let publishOpen = true;
                                try {
                                    await target.onStatus(Object.freeze({
                                        signal: target.abortController.signal,
                                        publish: (state) => {
                                            if (!publishOpen) {
                                                fail(
                                                    'PLOINKY_PROVIDER_LOGIN_STATE_INVALID',
                                                    'provider login publication escaped its status transaction',
                                                );
                                            }
                                            return publishNonterminal(target, state);
                                        },
                                    }));
                                } finally {
                                    publishOpen = false;
                                }
                            } catch (_) {
                                callbackFailed = true;
                                throw new Error('provider login status callback failed');
                            }
                        }
                        return target.state;
                    });
                } catch (error) {
                    if (!callbackFailed) throw error;
                    await requestForcedFinalization(
                        target,
                        'failed',
                        'provider_login_output_invalid',
                    ).catch(() => {});
                    fail('PLOINKY_PROVIDER_LOGIN_STATUS_FAILED', 'provider login status failed safely');
                }
            },
            async respondToLogin(control, response) {
                if (operation !== 'login_respond') {
                    fail('PLOINKY_PROVIDER_LOGIN_INVOCATION_INVALID', 'provider login response used by the wrong operation');
                }
                beginControl();
                const target = lookup(control, normalizedProvider, ownerBinding);
                let callbackFailed = false;
                try {
                    return await enqueue(target, async () => {
                        if (target.terminalIntent || target.state.status !== 'waiting' || !target.onRespond) {
                            fail('PLOINKY_PROVIDER_LOGIN_RESPONSE_INVALID', 'provider login flow does not accept a response');
                        }
                        const normalized = normalizeResponse(response, target.state);
                        const promptKey = `${normalized.seq}:${normalized.nonce}`;
                        if (target.consumedPrompts.has(promptKey)) {
                            fail('PLOINKY_PROVIDER_LOGIN_RESPONSE_INVALID', 'provider login prompt was already answered');
                        }
                        target.consumedPrompts.add(promptKey);
                        try {
                            let publishOpen = true;
                            try {
                                await target.onRespond(Object.freeze({
                                    ...normalized,
                                    signal: target.abortController?.signal,
                                    publish: (state) => {
                                        if (!publishOpen) {
                                            fail(
                                                'PLOINKY_PROVIDER_LOGIN_STATE_INVALID',
                                                'provider login publication escaped its response transaction',
                                            );
                                        }
                                        return publishNonterminal(target, state);
                                    },
                                }));
                            } finally {
                                publishOpen = false;
                            }
                        } catch (_) {
                            callbackFailed = true;
                            throw new Error('provider login response callback failed');
                        }
                        return target.state;
                    });
                } catch (error) {
                    if (!callbackFailed) throw error;
                    await requestForcedFinalization(
                        target,
                        'failed',
                        'provider_login_response_failed',
                    ).catch(() => {});
                    fail('PLOINKY_PROVIDER_LOGIN_RESPONSE_FAILED', 'provider login response failed safely');
                }
            },
            cancelLogin(control) {
                if (operation !== 'login_cancel') {
                    fail('PLOINKY_PROVIDER_LOGIN_INVOCATION_INVALID', 'provider login cancel used by the wrong operation');
                }
                beginControl();
                return requestForcedFinalization(
                    lookup(control, normalizedProvider, ownerBinding),
                    'cancelled',
                );
            },
            disposition() { return action; },
            requireControlResult() {
                if (action !== 'control' || !(controlPromise instanceof Promise)) {
                    fail(
                        'PLOINKY_PROVIDER_LOGIN_CONTROL_REQUIRED',
                        'provider login control did not publish an exact registry result',
                    );
                }
                return controlPromise;
            },
            revoke() {
                revoked = true;
            },
            async rollback() {
                if (!record || (action !== 'staged' && action !== 'retained')) return false;
                await requestForcedFinalization(record, 'cancelled');
                return true;
            },
        };
        const recordControl = (method, ...args) => {
            if (controlPromise) {
                const rejected = Promise.resolve().then(() => fail(
                    'PLOINKY_PROVIDER_LOGIN_INVOCATION_INVALID',
                    'provider login invocation already published a control result',
                ));
                rejected.catch(() => {});
                return rejected;
            }
            controlPromise = Promise.resolve().then(() => method(...args));
            controlPromise.catch(() => {});
            return controlPromise;
        };
        invocation.providerApi = Object.freeze({
            retainLoginOperation: invocation.retainLoginOperation,
            getLoginStatus: (...args) => recordControl(invocation.getLoginStatus, ...args),
            respondToLogin: (...args) => recordControl(invocation.respondToLogin, ...args),
            cancelLogin: (...args) => recordControl(invocation.cancelLogin, ...args),
        });
        return Object.freeze(invocation);
    };

    return Object.freeze({
        createInvocation,
        get size() { return records.size; },
        async close() {
            admissionClosed = true;
            if (cleanupComplete) return;
            if (!closingPromise) {
                closingPromise = (async () => {
                    for (const record of records.values()) clearRecordTimer(record);
                    await Promise.all([...records.values()].map((record) => (
                        TERMINAL_STATUSES.has(record.state.status)
                            ? Promise.resolve()
                            : requestForcedFinalization(record, 'cancelled')
                    )));
                    for (const record of records.values()) clearRecordTimer(record);
                    records.clear();
                    cleanupComplete = true;
                })();
            }
            try {
                await closingPromise;
            } finally {
                if (!cleanupComplete) closingPromise = null;
            }
        },
    });
}
