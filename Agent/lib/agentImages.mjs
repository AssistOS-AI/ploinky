// Agent image discovery uses the verified generated Router descriptor and a
// fresh private assertion for every request. Responses are bounded and strict.
import http from 'node:http';

import { loadVerifiedGeneratedRouterDescriptor } from '../client/generatedRouterDescriptor.mjs';
import { signPrivateRouterAssertion } from './agentAssertion.mjs';

export const AGENT_IMAGES_PATH = '/api/edge/agent-images';
export const AGENT_IMAGES_SCHEMA_VERSION = 1;
export const AGENT_IMAGES_UNAVAILABLE = 'AGENT_IMAGES_UNAVAILABLE';
export const AGENT_IMAGES_INVALID = 'AGENT_IMAGES_INVALID';

const PRIVATE_ASSERTION_HEADER = 'Ploinky-Agent-Assertion';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_AGENTS = 256;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ENVELOPE_KEYS = JSON.stringify(['agents', 'schemaVersion']);
const AGENT_KEYS = JSON.stringify(['about', 'enableMode', 'image', 'reason', 'ref', 'runtime']);
const IMAGE_KEYS = JSON.stringify(['digest', 'imageId', 'reference']);
// Lease and contract failures the Router reports explicitly. Any other 503 is
// a temporary routing state; anything else, including 404, is a contract
// failure rather than a sign of an older runtime.
const INVALID_ROUTER_CODES = new Set([
    'EDGE_GENERATION_CORRUPT',
    'AGENT_IMAGES_LEASE_INVALID',
]);
const RACE_CODE = 'edge_generation_changed';

export class AgentImagesError extends Error {
    constructor(code, message, { status = 0, routerCode = '', cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AgentImagesError';
        this.code = code;
        this.status = status;
        this.routerCode = routerCode;
    }
}

function unavailable(message, details) {
    return new AgentImagesError(AGENT_IMAGES_UNAVAILABLE, message, details);
}

function invalid(message, details) {
    return new AgentImagesError(AGENT_IMAGES_INVALID, message, details);
}

function boundedTimeout(value) {
    const timeout = Number(value);
    return Number.isSafeInteger(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function operationUrl(descriptor) {
    let url;
    try {
        url = new URL(AGENT_IMAGES_PATH, descriptor.payload.internalRouterUrl);
    } catch (error) {
        throw invalid('generated private Router location is invalid', { cause: error });
    }
    if (url.protocol !== 'http:' || url.pathname !== AGENT_IMAGES_PATH
        || url.search || url.hash || url.username || url.password) {
        throw invalid('generated private Router location is invalid');
    }
    return url;
}

function requestOnce(url, headers, { timeoutMs, requestImpl, signal }) {
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
            finish(reject, unavailable('private Router image request timed out'));
            request?.destroy();
        }, timeoutMs);
        timer.unref?.();
        try {
            request = requestImpl(url, { method: 'GET', headers, agent: false, signal }, (response) => {
                const declared = Number(response.headers['content-length']);
                if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
                    finish(reject, invalid('private Router image response exceeds its size limit'));
                    response.destroy();
                    return;
                }
                const chunks = [];
                let total = 0;
                response.on('data', (chunk) => {
                    total += chunk.length;
                    if (total > MAX_RESPONSE_BYTES) {
                        finish(reject, invalid('private Router image response exceeds its size limit'));
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
                response.on('aborted', () => finish(reject, unavailable('private Router image response was aborted')));
                response.on('error', (error) => finish(reject, unavailable('private Router image response failed', { cause: error })));
            });
            request.on('error', (error) => finish(reject, unavailable('private Router image request failed', { cause: error })));
            request.end();
        } catch (error) {
            finish(reject, unavailable('private Router image request failed', { cause: error }));
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

function boundedText(value, maximum, empty = false) {
    return typeof value === 'string' && (empty || value.length > 0)
        && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseEnvelope(response) {
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw invalid('private Router image response is not JSON');
    let parsed;
    try { parsed = JSON.parse(response.body.toString('utf8')); }
    catch (error) { throw invalid('private Router image response is malformed', { cause: error }); }
    if (!plainRecord(parsed) || JSON.stringify(Object.keys(parsed).sort()) !== ENVELOPE_KEYS
        || parsed.schemaVersion !== 1 || !Array.isArray(parsed.agents) || parsed.agents.length > MAX_AGENTS) {
        throw invalid('private Router image envelope is unsupported or invalid');
    }
    const seen = new Set();
    const agents = parsed.agents.map((entry) => {
        if (!plainRecord(entry) || JSON.stringify(Object.keys(entry).sort()) !== AGENT_KEYS
            || !boundedText(entry.ref, 257) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.ref)
            || entry.ref.split('/').some((part) => part === '.' || part === '..' || part.length > 128)
            || seen.has(entry.ref) || !boundedText(entry.about, 4096, true)
            || !['isolated', 'global', 'devel'].includes(entry.enableMode)
            || !['podman', 'docker', 'bwrap', 'seatbelt', 'host', 'none'].includes(entry.runtime)) {
            throw invalid('private Router image entry is invalid');
        }
        seen.add(entry.ref);
        const container = ['podman', 'docker'].includes(entry.runtime);
        if (entry.image === null) {
            if (entry.reason !== (container ? 'digest_unknown' : 'not_container')) {
                throw invalid('private Router image reason is invalid');
            }
        } else {
            const image = entry.image;
            if (!container || entry.reason !== null || !plainRecord(image)
                || JSON.stringify(Object.keys(image).sort()) !== IMAGE_KEYS
                || !boundedText(image.reference, 4096) || /\s|\\|@/.test(image.reference)
                || !/^(?:[a-z0-9.-]+\.[a-z0-9.-]+(?::[0-9]+)?|localhost(?::[0-9]+)?|[a-z0-9-]+:[0-9]+)\//.test(image.reference)
                || image.reference.startsWith('-') || image.reference.startsWith('/')
                || image.reference.slice(image.reference.lastIndexOf('/') + 1).includes(':')
                || image.reference.split('/').some((part) => !part || part === '.' || part === '..')
                || !DIGEST.test(image.digest) || !(image.imageId === null || DIGEST.test(image.imageId))) {
                throw invalid('private Router image identity is invalid');
            }
        }
        return Object.freeze({ ...entry, image: entry.image === null ? null : Object.freeze({ ...entry.image }) });
    });
    return Object.freeze({ schemaVersion: 1, agents: Object.freeze(agents) });
}

function classifyFailure(response) {
    const code = routerErrorCode(response.body);
    const details = { status: response.status, routerCode: code };
    if (response.status >= 300 && response.status < 400) {
        return invalid('private Router image request was redirected', details);
    }
    if (response.status === 503 && !INVALID_ROUTER_CODES.has(code)) {
        return unavailable('the workspace agent images are not available now', details);
    }
    if (response.status >= 500 && response.status !== 503) {
        return unavailable('private Router image request failed', details);
    }
    return invalid('private Router image request was rejected', details);
}

/** Read fresh image identities over the signed private Router hop. */
export async function fetchAgentImages({
    env = process.env,
    fsApi,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    requestImpl = http.request,
    signal,
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
                path: AGENT_IMAGES_PATH,
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
        }, { timeoutMs: timeout, requestImpl, signal });
        if (response.status === 200) return parseEnvelope(response);
        const failure = classifyFailure(response);
        if (attempt === 0 && failure.status === 503 && failure.routerCode === RACE_CODE) continue;
        throw failure;
    }
    throw unavailable('workspace routing changed during agent image reads');
}

export default {
    AGENT_IMAGES_INVALID,
    AGENT_IMAGES_PATH,
    AGENT_IMAGES_SCHEMA_VERSION,
    AGENT_IMAGES_UNAVAILABLE,
    AgentImagesError,
    fetchAgentImages,
};
