// Agent-side reader for the folders the active workspace executes code from.
//
// The managed Router answers `GET /api/edge/runtime-sources` on its private
// listener from the exact active routing lease, to the current instances of
// agents that declare an execution provider. This helper reaches that listener
// only through the signed generated Router descriptor, proves the caller's
// current identity with a fresh private assertion, and validates the response
// strictly. It never caches: a caller must obtain a fresh answer for every
// decision that depends on it.

import http from 'node:http';

import { loadVerifiedGeneratedRouterDescriptor } from '../client/generatedRouterDescriptor.mjs';
import { signPrivateRouterAssertion } from './agentAssertion.mjs';

export const RUNTIME_SOURCES_PATH = '/api/edge/runtime-sources';
export const RUNTIME_SOURCES_SCHEMA_VERSION = 1;
export const RUNTIME_SOURCES_UNAVAILABLE = 'RUNTIME_SOURCES_UNAVAILABLE';
export const RUNTIME_SOURCES_INVALID = 'RUNTIME_SOURCES_INVALID';
export const RUNTIME_SOURCE_KINDS = Object.freeze([
    'agent-repository',
    'agent-library',
    'agent-runtime-library',
    'linked-repository',
]);

const PRIVATE_ASSERTION_HEADER = 'Ploinky-Agent-Assertion';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SOURCES = 512;
const MAX_PATH_BYTES = 4096;
const GENERATION_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ACTIVATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ENVELOPE_KEYS = JSON.stringify(['activationId', 'authorizationGeneration', 'outsideWorkspace', 'schemaVersion', 'sources']);
const SOURCE_KEYS = JSON.stringify(['kind', 'relativePath']);
// Lease and contract failures the Router reports explicitly. Any other 503 is
// a temporary routing state; anything else, including 404, is a contract
// failure rather than a sign of an older runtime.
const INVALID_ROUTER_CODES = new Set([
    'EDGE_GENERATION_CORRUPT',
    'RUNTIME_SOURCES_LEASE_INVALID',
]);
const RACE_CODE = 'edge_generation_changed';

export class RuntimeSourcesError extends Error {
    constructor(code, message, { status = 0, routerCode = '', cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'RuntimeSourcesError';
        this.code = code;
        this.status = status;
        this.routerCode = routerCode;
    }
}

function unavailable(message, details) {
    return new RuntimeSourcesError(RUNTIME_SOURCES_UNAVAILABLE, message, details);
}

function invalid(message, details) {
    return new RuntimeSourcesError(RUNTIME_SOURCES_INVALID, message, details);
}

function boundedTimeout(value) {
    const timeout = Number(value);
    return Number.isSafeInteger(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function operationUrl(descriptor) {
    let url;
    try {
        url = new URL(RUNTIME_SOURCES_PATH, descriptor.payload.internalRouterUrl);
    } catch (error) {
        throw invalid('generated private Router location is invalid', { cause: error });
    }
    if (url.protocol !== 'http:' || url.pathname !== RUNTIME_SOURCES_PATH
        || url.search || url.hash || url.username || url.password) {
        throw invalid('generated private Router location is invalid');
    }
    return url;
}

function requestOnce(url, headers, { timeoutMs, requestImpl }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let request;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };
        const timer = setTimeout(() => {
            finish(reject, unavailable('private Router source request timed out'));
            request?.destroy();
        }, timeoutMs);
        timer.unref?.();
        try {
            request = requestImpl(url, { method: 'GET', headers, agent: false }, (response) => {
                const declared = Number(response.headers['content-length']);
                if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
                    finish(reject, invalid('private Router source response exceeds its size limit'));
                    response.destroy();
                    return;
                }
                const chunks = [];
                let total = 0;
                response.on('data', (chunk) => {
                    total += chunk.length;
                    if (total > MAX_RESPONSE_BYTES) {
                        finish(reject, invalid('private Router source response exceeds its size limit'));
                        response.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => finish(resolve, {
                    status: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                }));
                response.on('aborted', () => finish(reject, unavailable('private Router source response was aborted')));
                response.on('error', (error) => finish(reject, unavailable('private Router source response failed', { cause: error })));
            });
            request.on('error', (error) => finish(reject, unavailable('private Router source request failed', { cause: error })));
            request.end();
        } catch (error) {
            finish(reject, unavailable('private Router source request failed', { cause: error }));
        }
    });
}

function routerErrorCode(body) {
    try {
        const parsed = JSON.parse(body.toString('utf8'));
        const code = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.error : '';
        return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : '';
    } catch (_) {
        return '';
    }
}

function plainRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

// A workspace-relative POSIX path: non-empty, no leading '/', no empty, '.' or
// '..' segment, no NUL, at most 4096 bytes.
function validRelativePath(value) {
    return typeof value === 'string' && value.length > 0
        && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES
        && !value.startsWith('/') && !value.includes('\0') && !value.includes('\\')
        && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function parseEnvelope(response) {
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
        throw invalid('private Router source response is not JSON', { status: response.status });
    }
    let parsed;
    try {
        parsed = JSON.parse(response.body.toString('utf8'));
    } catch (error) {
        throw invalid('private Router source response is malformed', { status: response.status, cause: error });
    }
    if (!plainRecord(parsed)
        || JSON.stringify(Object.keys(parsed).sort()) !== ENVELOPE_KEYS
        || parsed.schemaVersion !== RUNTIME_SOURCES_SCHEMA_VERSION
        || typeof parsed.authorizationGeneration !== 'string'
        || !GENERATION_PATTERN.test(parsed.authorizationGeneration)
        || typeof parsed.activationId !== 'string'
        || !ACTIVATION_ID_PATTERN.test(parsed.activationId)
        || !Number.isSafeInteger(parsed.outsideWorkspace) || parsed.outsideWorkspace < 0
        || !Array.isArray(parsed.sources) || parsed.sources.length > MAX_SOURCES) {
        throw invalid('private Router source envelope is unsupported or invalid', { status: response.status });
    }
    const seen = new Set();
    const sources = parsed.sources.map((entry) => {
        if (!plainRecord(entry) || JSON.stringify(Object.keys(entry).sort()) !== SOURCE_KEYS
            || !RUNTIME_SOURCE_KINDS.includes(entry.kind) || !validRelativePath(entry.relativePath)
            || seen.has(entry.relativePath)) {
            throw invalid('private Router source entry is invalid', { status: response.status });
        }
        seen.add(entry.relativePath);
        return Object.freeze({ kind: entry.kind, relativePath: entry.relativePath });
    });
    return Object.freeze({
        schemaVersion: parsed.schemaVersion,
        authorizationGeneration: parsed.authorizationGeneration,
        activationId: parsed.activationId,
        sources: Object.freeze(sources),
        outsideWorkspace: parsed.outsideWorkspace,
    });
}

function classifyFailure(response) {
    const code = routerErrorCode(response.body);
    const details = { status: response.status, routerCode: code };
    if (response.status >= 300 && response.status < 400) {
        return invalid('private Router source request was redirected', details);
    }
    if (response.status === 503 && !INVALID_ROUTER_CODES.has(code)) {
        return unavailable('the workspace runtime sources are not available now', details);
    }
    if (response.status >= 500 && response.status !== 503) {
        return unavailable('private Router source request failed', details);
    }
    return invalid('private Router source request was rejected', details);
}

/**
 * Read the folders the active generation executes code from.
 *
 * Resolves `{ schemaVersion, authorizationGeneration, activationId, sources,
 * outsideWorkspace }`, where each source is `{ kind, relativePath }` relative to
 * the workspace root. Rejects with RuntimeSourcesError: code
 * RUNTIME_SOURCES_UNAVAILABLE for a transport failure or a temporary routing
 * state, or RUNTIME_SOURCES_INVALID for a descriptor, identity or contract
 * failure. One retry follows only an explicit generation race.
 */
export async function fetchRuntimeSources({
    env = process.env,
    fsApi,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    requestImpl = http.request,
} = {}) {
    let descriptor;
    try {
        descriptor = loadVerifiedGeneratedRouterDescriptor({ env, ...(fsApi ? { fsApi } : {}) });
    } catch (error) {
        throw invalid('generated Router descriptor is unavailable or invalid', { cause: error });
    }
    const url = operationUrl(descriptor);
    const timeout = boundedTimeout(timeoutMs);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let assertion;
        try {
            assertion = signPrivateRouterAssertion({
                method: 'GET',
                path: RUNTIME_SOURCES_PATH,
                query: '',
                body: Buffer.alloc(0),
                env,
            });
        } catch (error) {
            throw invalid('agent private Router identity is unavailable', { cause: error });
        }
        const response = await requestOnce(url, {
            Accept: 'application/json',
            [PRIVATE_ASSERTION_HEADER]: assertion,
        }, { timeoutMs: timeout, requestImpl });
        if (response.status === 200) return parseEnvelope(response);
        const failure = classifyFailure(response);
        if (attempt === 0 && failure.status === 503 && failure.routerCode === RACE_CODE) continue;
        throw failure;
    }
    throw unavailable('workspace routing changed during runtime source reads');
}

export default {
    RUNTIME_SOURCES_INVALID,
    RUNTIME_SOURCES_PATH,
    RUNTIME_SOURCES_SCHEMA_VERSION,
    RUNTIME_SOURCES_UNAVAILABLE,
    RUNTIME_SOURCE_KINDS,
    RuntimeSourcesError,
    fetchRuntimeSources,
};
