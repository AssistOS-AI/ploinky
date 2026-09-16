// Agent-side reader for the active workspace Router origins.
//
// The managed Router answers `GET /api/edge/runtime-origins` on its private
// listener from the exact active routing lease. This helper reaches that
// listener only through the signed generated Router descriptor, proves the
// caller's current identity with a fresh private assertion, and validates the
// response strictly. It never caches a result: every caller that relies on
// managed origins must obtain a fresh answer for each decision.

import http from 'node:http';

import { loadVerifiedGeneratedRouterDescriptor } from '../client/generatedRouterDescriptor.mjs';
import { signPrivateRouterAssertion } from './agentAssertion.mjs';
import { parseRouterOriginList } from './routerOrigins.mjs';

export const RUNTIME_ROUTER_ORIGINS_PATH = '/api/edge/runtime-origins';
export const RUNTIME_ROUTER_ORIGINS_SCHEMA_VERSION = 1;
export const RUNTIME_ROUTER_ORIGINS_UNAVAILABLE = 'RUNTIME_ROUTER_ORIGINS_UNAVAILABLE';
export const RUNTIME_ROUTER_ORIGINS_INVALID = 'RUNTIME_ROUTER_ORIGINS_INVALID';

const PRIVATE_ASSERTION_HEADER = 'Ploinky-Agent-Assertion';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const GENERATION_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ACTIVATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ENVELOPE_KEYS = JSON.stringify(['activationId', 'authorizationGeneration', 'routerOrigins', 'schemaVersion']);
// Routing-generation transitions the Router reports explicitly. Anything else
// from the operation, including 404, is a contract failure rather than a sign
// of an older runtime.
const INVALID_ROUTER_CODES = new Set([
    'EDGE_GENERATION_CORRUPT',
    'RUNTIME_ORIGINS_INVALID',
    'RUNTIME_ORIGINS_LEASE_INVALID',
]);
const RACE_CODE = 'edge_generation_changed';

export class RuntimeRouterOriginsError extends Error {
    constructor(code, message, { status = 0, routerCode = '', cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'RuntimeRouterOriginsError';
        this.code = code;
        this.status = status;
        this.routerCode = routerCode;
    }
}

function unavailable(message, details) {
    return new RuntimeRouterOriginsError(RUNTIME_ROUTER_ORIGINS_UNAVAILABLE, message, details);
}

function invalid(message, details) {
    return new RuntimeRouterOriginsError(RUNTIME_ROUTER_ORIGINS_INVALID, message, details);
}

function boundedTimeout(value) {
    const timeout = Number(value);
    return Number.isSafeInteger(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function operationUrl(descriptor) {
    let url;
    try {
        url = new URL(RUNTIME_ROUTER_ORIGINS_PATH, descriptor.payload.internalRouterUrl);
    } catch (error) {
        throw invalid('generated private Router location is invalid', { cause: error });
    }
    if (url.protocol !== 'http:' || url.pathname !== RUNTIME_ROUTER_ORIGINS_PATH
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
            finish(reject, unavailable('private Router metadata request timed out'));
            request?.destroy();
        }, timeoutMs);
        timer.unref?.();
        try {
            request = requestImpl(url, { method: 'GET', headers, agent: false }, (response) => {
                const declared = Number(response.headers['content-length']);
                if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
                    finish(reject, invalid('private Router metadata response exceeds its size limit'));
                    response.destroy();
                    return;
                }
                const chunks = [];
                let total = 0;
                response.on('data', (chunk) => {
                    total += chunk.length;
                    if (total > MAX_RESPONSE_BYTES) {
                        finish(reject, invalid('private Router metadata response exceeds its size limit'));
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
                response.on('aborted', () => finish(reject, unavailable('private Router metadata response was aborted')));
                response.on('error', (error) => finish(reject, unavailable('private Router metadata response failed', { cause: error })));
            });
            request.on('error', (error) => finish(reject, unavailable('private Router metadata request failed', { cause: error })));
            request.end();
        } catch (error) {
            finish(reject, unavailable('private Router metadata request failed', { cause: error }));
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

function parseEnvelope(response) {
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
        throw invalid('private Router metadata response is not JSON', { status: response.status });
    }
    let parsed;
    try {
        parsed = JSON.parse(response.body.toString('utf8'));
    } catch (error) {
        throw invalid('private Router metadata response is malformed', { status: response.status, cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.getPrototypeOf(parsed) !== Object.prototype
        || JSON.stringify(Object.keys(parsed).sort()) !== ENVELOPE_KEYS
        || parsed.schemaVersion !== RUNTIME_ROUTER_ORIGINS_SCHEMA_VERSION
        || typeof parsed.authorizationGeneration !== 'string'
        || !GENERATION_PATTERN.test(parsed.authorizationGeneration)
        || typeof parsed.activationId !== 'string'
        || !ACTIVATION_ID_PATTERN.test(parsed.activationId)) {
        throw invalid('private Router metadata envelope is unsupported or invalid', { status: response.status });
    }
    let routerOrigins;
    try {
        routerOrigins = parseRouterOriginList(parsed.routerOrigins);
    } catch (error) {
        throw invalid('private Router metadata origins are invalid', { status: response.status, cause: error });
    }
    return Object.freeze({
        schemaVersion: parsed.schemaVersion,
        authorizationGeneration: parsed.authorizationGeneration,
        activationId: parsed.activationId,
        routerOrigins,
    });
}

function classifyFailure(response) {
    const code = routerErrorCode(response.body);
    const details = { status: response.status, routerCode: code };
    if (response.status >= 300 && response.status < 400) {
        return invalid('private Router metadata request was redirected', details);
    }
    if (response.status === 503 && !INVALID_ROUTER_CODES.has(code)) {
        return unavailable('workspace routing is not active for Router metadata', details);
    }
    if (response.status >= 500 && response.status !== 503) {
        return unavailable('private Router metadata request failed', details);
    }
    return invalid('private Router metadata request was rejected', details);
}

/**
 * Read the active generation's direct Router origins.
 *
 * Resolves `{ schemaVersion, authorizationGeneration, activationId,
 * routerOrigins }`. Rejects with RuntimeRouterOriginsError: code
 * RUNTIME_ROUTER_ORIGINS_UNAVAILABLE for a temporary routing transition or
 * transport failure, or RUNTIME_ROUTER_ORIGINS_INVALID for a descriptor,
 * identity, or response-contract failure. One retry follows only an explicit
 * generation race reported by the Router.
 */
export async function fetchRuntimeRouterOrigins({
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
                path: RUNTIME_ROUTER_ORIGINS_PATH,
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
    throw unavailable('workspace routing changed during Router metadata reads');
}

export default {
    RUNTIME_ROUTER_ORIGINS_INVALID,
    RUNTIME_ROUTER_ORIGINS_PATH,
    RUNTIME_ROUTER_ORIGINS_SCHEMA_VERSION,
    RUNTIME_ROUTER_ORIGINS_UNAVAILABLE,
    RuntimeRouterOriginsError,
    fetchRuntimeRouterOrigins,
};
