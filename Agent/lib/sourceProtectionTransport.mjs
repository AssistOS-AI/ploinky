// Agent-side transport for the Router's source-protection operation (proof slice P5).
//
// Same channel as `runtimeRouterOrigins.mjs`: the agent reaches the private Router listener only through the signed
// generated Router descriptor and proves its current identity with a fresh private agent assertion bound to the method,
// path and body hash. The Router admits only current agents that declare an execution provider. This helper only
// moves one request: it never retries and never caches, so the caller (the worker's reservation controller) decides
// what an unknown outcome means.
//
// Resolves `{status, body}` for any HTTP answer; rejects with a RuntimeSourceProtectionTransportError for a
// transport failure (descriptor, identity, timeout, oversize or aborted response).

import http from 'node:http';

import { loadVerifiedGeneratedRouterDescriptor } from '../client/generatedRouterDescriptor.mjs';
import { signPrivateRouterAssertion } from './agentAssertion.mjs';

export const SOURCE_PROTECTION_ROUTER_PATH = '/api/edge/source-protection';
export const SOURCE_PROTECTION_TRANSPORT_UNAVAILABLE = 'SOURCE_PROTECTION_TRANSPORT_UNAVAILABLE';

const PRIVATE_ASSERTION_HEADER = 'Ploinky-Agent-Assertion';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class RuntimeSourceProtectionTransportError extends Error {
    constructor(message, { cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'RuntimeSourceProtectionTransportError';
        this.code = SOURCE_PROTECTION_TRANSPORT_UNAVAILABLE;
    }
}

function unavailable(message, cause) {
    return new RuntimeSourceProtectionTransportError(message, { cause });
}

function boundedTimeout(value) {
    const timeout = Number(value);
    return Number.isSafeInteger(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function operationUrl(descriptor) {
    let url;
    try {
        url = new URL(SOURCE_PROTECTION_ROUTER_PATH, descriptor.payload.internalRouterUrl);
    } catch (error) {
        throw unavailable('generated private Router location is invalid', error);
    }
    if (url.protocol !== 'http:' || url.pathname !== SOURCE_PROTECTION_ROUTER_PATH
        || url.search || url.hash || url.username || url.password) {
        throw unavailable('generated private Router location is invalid');
    }
    return url;
}

function requestOnce(url, headers, body, { timeoutMs, requestImpl }) {
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
            finish(reject, unavailable('source-protection request timed out'));
            request?.destroy();
        }, timeoutMs);
        timer.unref?.();
        try {
            request = requestImpl(url, { method: 'POST', headers, agent: false }, (response) => {
                const declared = Number(response.headers['content-length']);
                if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
                    finish(reject, unavailable('source-protection response exceeds its size limit'));
                    response.destroy();
                    return;
                }
                const chunks = [];
                let total = 0;
                response.on('data', (chunk) => {
                    total += chunk.length;
                    if (total > MAX_RESPONSE_BYTES) {
                        finish(reject, unavailable('source-protection response exceeds its size limit'));
                        response.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => finish(resolve, { status: response.statusCode, body: Buffer.concat(chunks) }));
                response.on('aborted', () => finish(reject, unavailable('source-protection response was aborted')));
                response.on('error', (error) => finish(reject, unavailable('source-protection response failed', error)));
            });
            request.on('error', (error) => finish(reject, unavailable('source-protection request failed', error)));
            request.end(body);
        } catch (error) {
            finish(reject, unavailable('source-protection request failed', error));
        }
    });
}

/**
 * POST one envelope (Buffer or string) to the Router's source-protection operation.
 * `loadDescriptor`, `sign` and `requestImpl` are test seams; the defaults are the production channel.
 */
export async function postSourceProtection(envelope, {
    env = process.env,
    fsApi,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    requestImpl = http.request,
    loadDescriptor = loadVerifiedGeneratedRouterDescriptor,
    sign = signPrivateRouterAssertion,
} = {}) {
    const body = Buffer.isBuffer(envelope) ? envelope : Buffer.from(String(envelope), 'utf8');
    if (body.length < 1 || body.length > MAX_REQUEST_BYTES) throw unavailable('source-protection request size is invalid');
    let descriptor;
    try {
        descriptor = loadDescriptor({ env, ...(fsApi ? { fsApi } : {}) });
    } catch (error) {
        throw unavailable('generated Router descriptor is unavailable or invalid', error);
    }
    const url = operationUrl(descriptor);
    let assertion;
    try {
        assertion = sign({ method: 'POST', path: SOURCE_PROTECTION_ROUTER_PATH, query: '', body, env });
    } catch (error) {
        throw unavailable('agent private Router identity is unavailable', error);
    }
    return requestOnce(url, {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
        Accept: 'application/json',
        [PRIVATE_ASSERTION_HEADER]: assertion,
    }, body, { timeoutMs: boundedTimeout(timeoutMs), requestImpl });
}

export default {
    SOURCE_PROTECTION_ROUTER_PATH,
    SOURCE_PROTECTION_TRANSPORT_UNAVAILABLE,
    RuntimeSourceProtectionTransportError,
    postSourceProtection,
};
