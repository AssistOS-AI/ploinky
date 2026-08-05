import crypto from 'node:crypto';
import http from 'node:http';

import { signPrivateRouterAssertion } from './agentAssertion.mjs';
import { assertAgentCredentialContext } from './agentCredentialContext.mjs';
import { inspectProcessIdentity, normalizeProcessIdentity } from './processIdentity.mjs';

const SCHEMA_VERSION = 1;
const BWRAP_PRIVATE_ORIGIN = 'http://127.0.0.1:8081';
const CONTAINER_PRIVATE_ORIGIN = 'http://host.containers.internal:8081';
const PRIVATE_PATH_PREFIX = '/api/edge/provider-tasks';
const MAX_LOG_CHUNK_BYTES = 16 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TEXT_MAX_BYTES = 4 * 1024;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

export class ProviderTaskLifecycleError extends Error {
    constructor(code, message, { cause, ownershipRetained = false } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'ProviderTaskLifecycleError';
        this.code = code;
        this.ownershipRetained = ownershipRetained;
    }
}

function fail(code, message, options) {
    throw new ProviderTaskLifecycleError(code, message, options);
}

function assertPlainObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', `${field} must be a plain object`);
    }
    return value;
}

function assertExactKeys(value, allowed, required, field) {
    assertPlainObject(value, field);
    const keys = Object.keys(value);
    if (keys.some((key) => !allowed.has(key))
        || [...required].some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', `${field} has an invalid shape`);
    }
    return value;
}

function exactText(value, field, maxBytes = TEXT_MAX_BYTES) {
    if (typeof value !== 'string' || !value || value !== value.trim()
        || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', `${field} is invalid`);
    }
    return value;
}

function exactInteger(value, field, { minimum = 0 } = {}) {
    if (!Number.isSafeInteger(value) || value < minimum) {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', `${field} is invalid`);
    }
    return value;
}

function canonicalWorkdir(value) {
    const workdir = exactText(value, 'workdir');
    if (!workdir.startsWith('/workspace/') || workdir.endsWith('/')
        || workdir.includes('//') || workdir.split('/').some((part) => part === '.' || part === '..')) {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'workdir is not a canonical workspace path');
    }
    return workdir;
}

function canonicalAbsolutePath(value, field) {
    const candidate = exactText(value, field, 16 * 1024);
    if (!candidate.startsWith('/') || candidate.endsWith('/') || candidate.includes('//')
        || candidate.split('/').some((part) => part === '.' || part === '..')
        || /[\u0000-\u001f\u007f]/u.test(candidate)) {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', `${field} is not a canonical absolute path`);
    }
    return candidate;
}

function canonicalBrokerOwnerInput({
    principalId,
    instanceId,
    enableGeneration,
    taskId,
    provider,
    audience,
}) {
    return JSON.stringify([
        exactText(principalId, 'principalId'),
        exactText(instanceId, 'instanceId'),
        exactText(enableGeneration, 'enableGeneration'),
        exactText(taskId, 'taskId'),
        exactText(provider, 'provider'),
        exactText(audience, 'audience'),
    ]);
}

function computeBrokerOwner(input) {
    return `sha256:${crypto.createHash('sha256')
        .update(canonicalBrokerOwnerInput(input), 'utf8')
        .digest('hex')}`;
}

function splitUtf8Chunks(value) {
    if (typeof value !== 'string') {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'provider log chunk must be text');
    }
    if (!value) return [];
    const chunks = [];
    let parts = [];
    let bytes = 0;
    for (const codePoint of value) {
        const size = Buffer.byteLength(codePoint, 'utf8');
        if (bytes + size > MAX_LOG_CHUNK_BYTES) {
            chunks.push(parts.join(''));
            parts = [];
            bytes = 0;
        }
        parts.push(codePoint);
        bytes += size;
    }
    if (parts.length > 0) chunks.push(parts.join(''));
    return chunks;
}

function parseExactResponse(response, kind) {
    if (!response || !Number.isSafeInteger(response.statusCode) || !Buffer.isBuffer(response.body)) {
        fail(`PLOINKY_PROVIDER_LIFECYCLE_${kind.toUpperCase()}_FAILED`, 'private lifecycle response was invalid');
    }
    if (response.statusCode !== 200) {
        fail(
            `PLOINKY_PROVIDER_LIFECYCLE_${kind.toUpperCase()}_FAILED`,
            `private lifecycle ${kind} returned HTTP ${response.statusCode}`,
            { ownershipRetained: kind === 'terminal' },
        );
    }
    let value;
    try {
        value = JSON.parse(response.body.toString('utf8'));
    } catch {
        fail(
            `PLOINKY_PROVIDER_LIFECYCLE_${kind.toUpperCase()}_FAILED`,
            `private lifecycle ${kind} returned invalid JSON`,
            { ownershipRetained: kind === 'terminal' },
        );
    }
    const expectedKeys = kind === 'publish' || kind === 'heartbeat'
        ? new Set(['ok', 'owner'])
        : new Set(['ok']);
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).length !== expectedKeys.size
        || Object.keys(value).some((key) => !expectedKeys.has(key))
        || value.ok !== true) {
        fail(
            `PLOINKY_PROVIDER_LIFECYCLE_${kind.toUpperCase()}_FAILED`,
            `private lifecycle ${kind} response was not exact`,
            { ownershipRetained: kind === 'terminal' },
        );
    }
    if (kind !== 'publish' && kind !== 'heartbeat') return Object.freeze({ ok: true });
    const owner = value.owner;
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
        || Object.getPrototypeOf(owner) !== Object.prototype
        || Object.keys(owner).length !== 2
        || !Object.prototype.hasOwnProperty.call(owner, 'ownerKey')
        || !Object.prototype.hasOwnProperty.call(owner, 'logPath')) {
        fail(
            `PLOINKY_PROVIDER_LIFECYCLE_${kind.toUpperCase()}_FAILED`,
            `private lifecycle ${kind} owner response was not exact`,
        );
    }
    return Object.freeze({
        ownerKey: exactText(owner.ownerKey, 'owner.ownerKey'),
        logPath: canonicalAbsolutePath(owner.logPath, 'owner.logPath'),
    });
}

function defaultRequest({ origin, path, body, headers }) {
    return new Promise((resolve, reject) => {
        const target = new URL(path, origin);
        const request = http.request(target, {
            method: 'POST',
            headers: {
                ...headers,
                'content-length': body.byteLength,
            },
        }, (response) => {
            const chunks = [];
            let bytes = 0;
            response.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                    request.destroy(new Error('private lifecycle response exceeded the size limit'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({
                statusCode: response.statusCode,
                body: Buffer.concat(chunks),
            }));
        });
        request.setTimeout(5_000, () => request.destroy(new Error('private lifecycle request timed out')));
        request.once('error', reject);
        request.end(body);
    });
}

function normalizeRequestError(error, kind) {
    if (error instanceof ProviderTaskLifecycleError) return error;
    return new ProviderTaskLifecycleError(
        `PLOINKY_PROVIDER_LIFECYCLE_${kind.toUpperCase()}_FAILED`,
        `private lifecycle ${kind} request failed`,
        { cause: error, ownershipRetained: kind === 'terminal' },
    );
}

function sameOwner(left, right) {
    return left?.ownerKey === right?.ownerKey && left?.logPath === right?.logPath;
}

export function createProviderTaskLifecycleClient({
    credentialContext,
    provider,
    mode,
    taskId,
    audience,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    inspectProcessIdentity: inspectIdentity = inspectProcessIdentity,
    scheduleHeartbeat = (callback, intervalMs) => {
        const timer = setInterval(callback, intervalMs);
        timer.unref?.();
        return timer;
    },
    clearHeartbeat = clearInterval,
    signAssertion = ({ path, body }) => signPrivateRouterAssertion({
        credentialContext,
        method: 'POST',
        path,
        body,
    }),
    request = defaultRequest,
    onBridgeFailure,
} = {}) {
    const context = assertAgentCredentialContext(credentialContext);
    context.assertActive();
    exactText(provider, 'provider');
    if (mode !== 'task' && mode !== 'operation') {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'mode is invalid');
    }
    const canonicalTaskId = exactText(taskId, 'taskId');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(canonicalTaskId)) {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'taskId is not a safe segment');
    }
    exactText(audience, 'audience');
    exactInteger(heartbeatIntervalMs, 'heartbeatIntervalMs', { minimum: 1 });
    if (typeof inspectIdentity !== 'function' || typeof scheduleHeartbeat !== 'function'
        || typeof clearHeartbeat !== 'function' || typeof signAssertion !== 'function'
        || typeof request !== 'function'
        || (onBridgeFailure !== undefined && typeof onBridgeFailure !== 'function')) {
        fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'lifecycle dependencies are invalid');
    }

    const origin = context.runtime.runtimeKind === 'bwrap'
        ? BWRAP_PRIVATE_ORIGIN
        : context.runtime.runtimeKind === 'container'
            ? CONTAINER_PRIVATE_ORIGIN
            : fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'runtime kind is unsupported');
    let common = null;
    let owner = null;
    let heartbeatTimer = null;
    let sequence = 0;
    let terminalSucceeded = false;
    let publicationAttempted = false;
    let requestTail = Promise.resolve();
    let bridgeFailure = null;

    const stopHeartbeat = () => {
        if (heartbeatTimer !== null) {
            clearHeartbeat(heartbeatTimer);
            heartbeatTimer = null;
        }
    };

    const recordBridgeFailure = (error) => {
        const firstFailure = bridgeFailure === null;
        bridgeFailure ||= error;
        stopHeartbeat();
        if (firstFailure && onBridgeFailure) {
            try { onBridgeFailure(error); } catch { /* cleanup observes the original bridge failure */ }
        }
    };

    const post = async (kind, payload) => {
        const path = `${PRIVATE_PATH_PREFIX}/${kind}`;
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        let assertion;
        try {
            assertion = signAssertion({ path, body });
            exactText(assertion, 'private assertion', 16 * 1024);
        } catch (error) {
            throw normalizeRequestError(error, kind);
        }
        try {
            if (kind === 'publish') publicationAttempted = true;
            const response = await request({
                origin,
                path,
                body,
                headers: {
                    'content-type': 'application/json',
                    'ploinky-agent-assertion': assertion,
                },
            });
            return parseExactResponse(response, kind);
        } catch (error) {
            throw normalizeRequestError(error, kind);
        }
    };

    const enqueue = (kind, payload) => {
        const operation = requestTail.catch(() => undefined).then(() => post(kind, payload));
        requestTail = operation.catch(() => undefined);
        return operation;
    };

    const heartbeat = async () => {
        if (!common || !owner || terminalSucceeded || bridgeFailure) return false;
        let current;
        try {
            current = inspectIdentity(common.pid);
        } catch (cause) {
            const error = new ProviderTaskLifecycleError(
                'PLOINKY_PROVIDER_LIFECYCLE_OWNERSHIP_LOST',
                'provider lifecycle process ownership inspection failed',
                { cause, ownershipRetained: true },
            );
            recordBridgeFailure(error);
            throw error;
        }
        if (!current || current.state !== 'identified'
            || current.processIdentity !== common.processIdentity
            || current.processUid !== common.processUid) {
            let reportFailure = null;
            try {
                await enqueue('report', Object.freeze({
                    ...common,
                    reportState: 'pid-reused',
                }));
            } catch (cause) {
                reportFailure = normalizeRequestError(cause, 'report');
            }
            const error = new ProviderTaskLifecycleError(
                'PLOINKY_PROVIDER_LIFECYCLE_OWNERSHIP_LOST',
                reportFailure
                    ? 'provider lifecycle process ownership changed and its durable report failed'
                    : 'provider lifecycle process ownership no longer matches publication',
                { cause: reportFailure || undefined, ownershipRetained: true },
            );
            recordBridgeFailure(error);
            throw error;
        }
        try {
            const refreshedOwner = await enqueue('heartbeat', common);
            if (!sameOwner(owner, refreshedOwner)) {
                fail('PLOINKY_PROVIDER_LIFECYCLE_HEARTBEAT_FAILED', 'private lifecycle owner changed during heartbeat');
            }
            return true;
        } catch (error) {
            const normalized = normalizeRequestError(error, 'heartbeat');
            recordBridgeFailure(normalized);
            throw normalized;
        }
    };

    const client = {
        async publish(input) {
            if (common || terminalSucceeded) {
                fail('PLOINKY_PROVIDER_LIFECYCLE_STATE_INVALID', 'provider lifecycle is already published');
            }
            assertExactKeys(
                input,
                new Set(['runtimeKind', 'runtimeKey', 'homeKey', 'workdir', 'ownership']),
                new Set(['runtimeKind', 'runtimeKey', 'homeKey', 'workdir', 'ownership']),
                'provider lifecycle publication',
            );
            const runtimeKind = exactText(input.runtimeKind, 'runtimeKind');
            const runtimeKey = exactText(input.runtimeKey, 'runtimeKey');
            const homeKey = exactText(input.homeKey, 'homeKey');
            if (runtimeKind !== context.runtime.runtimeKind
                || runtimeKey !== context.runtime.runtimeKey
                || (runtimeKind === 'container' && homeKey !== context.runtime.homeKey)
                || (runtimeKind === 'bwrap' && homeKey !== `${runtimeKey}.sandbox-v2`)) {
                fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'runtime identity does not match the credential context');
            }
            const ownership = assertExactKeys(
                input.ownership,
                new Set(['pid', 'processGroupId', 'processIdentity', 'processUid']),
                new Set(['pid', 'processGroupId', 'processIdentity', 'processUid']),
                'provider lifecycle process ownership',
            );
            const pid = exactInteger(ownership.pid, 'pid', { minimum: 1 });
            if (exactInteger(ownership.processGroupId, 'processGroupId', { minimum: 1 }) !== pid) {
                fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'processGroupId must equal pid');
            }
            let processIdentity;
            try {
                processIdentity = normalizeProcessIdentity(ownership.processIdentity);
            } catch (error) {
                fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'processIdentity is invalid', { cause: error });
            }
            const processUid = exactInteger(ownership.processUid, 'processUid');
            const brokerOwner = computeBrokerOwner({
                principalId: context.identity.principalId,
                instanceId: context.identity.instanceId,
                enableGeneration: context.identity.enableGeneration,
                taskId,
                provider,
                audience,
            });
            if (!SHA256_RE.test(brokerOwner)) {
                fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'broker owner digest is invalid');
            }
            common = Object.freeze({
                schemaVersion: SCHEMA_VERSION,
                taskId,
                audience,
                provider,
                mode,
                runtimeKind,
                runtimeKey,
                homeKey,
                workdir: canonicalWorkdir(input.workdir),
                pid,
                processGroupId: pid,
                processIdentity,
                processUid,
                brokerOwner,
                readiness: 'ready',
                state: 'running',
            });
            try {
                owner = await enqueue('publish', common);
            } catch (error) {
                throw normalizeRequestError(error, 'publish');
            }
            heartbeatTimer = scheduleHeartbeat(() => {
                void heartbeat().catch(() => undefined);
            }, heartbeatIntervalMs);
            return owner;
        },

        log(stream, value) {
            if (!common || !owner || terminalSucceeded) {
                return Promise.reject(new ProviderTaskLifecycleError(
                    'PLOINKY_PROVIDER_LIFECYCLE_STATE_INVALID',
                    'provider lifecycle is not accepting logs',
                ));
            }
            if (stream !== 'stdout' && stream !== 'stderr') {
                return Promise.reject(new ProviderTaskLifecycleError(
                    'PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID',
                    'provider lifecycle log stream is invalid',
                ));
            }
            let chunks;
            try { chunks = splitUtf8Chunks(value); } catch (error) { return Promise.reject(error); }
            const operations = chunks.map((chunk) => {
                sequence += 1;
                return enqueue('log', Object.freeze({
                    schemaVersion: SCHEMA_VERSION,
                    taskId,
                    provider,
                    runtimeKey: common.runtimeKey,
                    processIdentity: common.processIdentity,
                    stream,
                    sequence,
                    chunk,
                })).catch((error) => {
                    const normalized = normalizeRequestError(error, 'log');
                    recordBridgeFailure(normalized);
                    throw normalized;
                });
            });
            return Promise.all(operations).then(() => undefined);
        },

        heartbeat,

        async terminal({ terminalState } = {}) {
            if (!common || !publicationAttempted) {
                fail('PLOINKY_PROVIDER_LIFECYCLE_STATE_INVALID', 'provider lifecycle was never published');
            }
            if (terminalSucceeded) return;
            if (terminalState !== 'completed' && terminalState !== 'failed'
                && terminalState !== 'cancelled') {
                fail('PLOINKY_PROVIDER_LIFECYCLE_INPUT_INVALID', 'terminal state is invalid');
            }
            stopHeartbeat();
            const payload = Object.freeze({
                ...common,
                terminalState,
                terminalProof: Object.freeze({
                    processTerminal: true,
                    descendantsTerminal: true,
                    brokerClosed: true,
                    leaseReleased: true,
                }),
            });
            try {
                await enqueue('terminal', payload);
                terminalSucceeded = true;
            } catch (error) {
                const normalized = normalizeRequestError(error, 'terminal');
                normalized.ownershipRetained = true;
                throw normalized;
            }
            if (bridgeFailure) {
                throw new ProviderTaskLifecycleError(
                    'PLOINKY_PROVIDER_LIFECYCLE_BRIDGE_FAILED',
                    'provider lifecycle logging or heartbeat failed before terminal cleanup',
                    { cause: bridgeFailure, ownershipRetained: false },
                );
            }
        },
    };
    Object.defineProperty(client, 'publicationAttempted', {
        enumerable: false,
        get: () => publicationAttempted,
    });
    return Object.freeze(client);
}

export const __testables = Object.freeze({
    BWRAP_PRIVATE_ORIGIN,
    CONTAINER_PRIVATE_ORIGIN,
    MAX_LOG_CHUNK_BYTES,
    canonicalBrokerOwnerInput,
    computeBrokerOwner,
    splitUtf8Chunks,
});
