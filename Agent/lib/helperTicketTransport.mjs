// Agent-side transport for the Router's private helper-ticket operation (mint route spec 2026-10-30).
//
// Same channel as `runtimeRouterOrigins.mjs` and the source-protection transport: the agent reaches the private Router
// listener only through the signed generated Router descriptor and proves its current identity with a fresh private
// agent assertion bound to the method, path and body hash. The Router admits only the exact current instance of the
// single execution-provider agent. This helper only moves one request of at most 64 KiB: it never retries and never
// caches, and it never logs or keeps the answer (which carries a one-use helper ticket and its session key), so the
// caller decides what an unknown outcome means.
//
// Resolves `{status, body}` for any HTTP answer; rejects with a RuntimeHelperTicketTransportError for a transport
// failure (descriptor, identity, timeout, oversize or aborted response).

import http from 'node:http';

import { loadVerifiedGeneratedRouterDescriptor } from '../client/generatedRouterDescriptor.mjs';
import { signPrivateRouterAssertion } from './agentAssertion.mjs';

export const HELPER_TICKET_ROUTER_PATH = '/api/edge/target-helper-ticket';
export const HELPER_TICKET_TRANSPORT_UNAVAILABLE = 'HELPER_TICKET_TRANSPORT_UNAVAILABLE';

const PRIVATE_ASSERTION_HEADER = 'Ploinky-Agent-Assertion';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class RuntimeHelperTicketTransportError extends Error {
    constructor(message, { cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'RuntimeHelperTicketTransportError';
        this.code = HELPER_TICKET_TRANSPORT_UNAVAILABLE;
    }
}

function unavailable(message, cause) {
    return new RuntimeHelperTicketTransportError(message, { cause });
}

function boundedTimeout(value) {
    const timeout = Number(value);
    return Number.isSafeInteger(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function operationUrl(descriptor) {
    let url;
    try {
        url = new URL(HELPER_TICKET_ROUTER_PATH, descriptor.payload.internalRouterUrl);
    } catch (error) {
        throw unavailable('generated private Router location is invalid', error);
    }
    if (url.protocol !== 'http:' || url.pathname !== HELPER_TICKET_ROUTER_PATH
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
            finish(reject, unavailable('helper-ticket request timed out'));
            request?.destroy();
        }, timeoutMs);
        timer.unref?.();
        try {
            request = requestImpl(url, { method: 'POST', headers, agent: false }, (response) => {
                const declared = Number(response.headers['content-length']);
                if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
                    finish(reject, unavailable('helper-ticket response exceeds its size limit'));
                    response.destroy();
                    return;
                }
                const chunks = [];
                let total = 0;
                response.on('data', (chunk) => {
                    total += chunk.length;
                    if (total > MAX_RESPONSE_BYTES) {
                        finish(reject, unavailable('helper-ticket response exceeds its size limit'));
                        response.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => finish(resolve, { status: response.statusCode, body: Buffer.concat(chunks) }));
                response.on('aborted', () => finish(reject, unavailable('helper-ticket response was aborted')));
                response.on('error', (error) => finish(reject, unavailable('helper-ticket response failed', error)));
            });
            request.on('error', (error) => finish(reject, unavailable('helper-ticket request failed', error)));
            request.end(body);
        } catch (error) {
            finish(reject, unavailable('helper-ticket request failed', error));
        }
    });
}

/**
 * POST one helper-ticket request (Buffer or string) to the Router's private helper-ticket operation.
 * `loadDescriptor`, `sign` and `requestImpl` are test seams; the defaults are the production channel.
 */
export async function postHelperTicketRequest(envelope, {
    env = process.env,
    fsApi,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    requestImpl = http.request,
    loadDescriptor = loadVerifiedGeneratedRouterDescriptor,
    sign = signPrivateRouterAssertion,
} = {}) {
    const body = Buffer.isBuffer(envelope) ? envelope : Buffer.from(String(envelope), 'utf8');
    if (body.length < 1 || body.length > MAX_REQUEST_BYTES) throw unavailable('helper-ticket request size is invalid');
    let descriptor;
    try {
        descriptor = loadDescriptor({ env, ...(fsApi ? { fsApi } : {}) });
    } catch (error) {
        throw unavailable('generated Router descriptor is unavailable or invalid', error);
    }
    const url = operationUrl(descriptor);
    let assertion;
    try {
        assertion = sign({ method: 'POST', path: HELPER_TICKET_ROUTER_PATH, query: '', body, env });
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
    HELPER_TICKET_ROUTER_PATH,
    HELPER_TICKET_TRANSPORT_UNAVAILABLE,
    RuntimeHelperTicketTransportError,
    postHelperTicketRequest,
};
