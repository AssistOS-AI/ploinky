import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import { assertAgentCredentialContext } from './agentCredentialContext.mjs';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_CAPABILITY_TTL_SECONDS = 60 * 60;
const ALLOWED_MODELS = new Set(['fast', 'plan', 'deep']);
const PROVIDERS = new Set(['opencode', 'pi', 'codex']);
const TEXT_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/;
const REGISTRIES = new WeakMap();

export class ScopedSoulBrokerError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'ScopedSoulBrokerError';
        this.code = code;
    }
}
function fail(code, message, cause) {
    throw new ScopedSoulBrokerError(code, message, cause ? { cause } : undefined);
}

function exactText(value, label, { maxBytes = 256, pattern = TEXT_RE } = {}) {
    if (typeof value !== 'string' || !value || value !== value.trim()
        || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes
        || (pattern && !pattern.test(value))) {
        fail('PLOINKY_SCOPED_BROKER_INPUT_INVALID', `${label} is invalid`);
    }
    return value;
}

function normalizeNow(now) {
    const seconds = now === undefined ? Math.floor(Date.now() / 1000) : now;
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
        fail('PLOINKY_SCOPED_BROKER_INPUT_INVALID', 'broker time is invalid');
    }
    return seconds;
}

function normalizeRouter(context) {
    const physicalOrigin = String(context.router.physicalOrigin || '');
    const requestAuthority = String(context.router.requestAuthority || '');
    let origin;
    try { origin = new URL(physicalOrigin); } catch (cause) {
        fail('PLOINKY_SCOPED_BROKER_CONTEXT_INVALID', 'credential context Router origin is invalid', cause);
    }
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
        || origin.port !== '8080' || origin.pathname !== '/'
        || origin.username || origin.password || origin.search || origin.hash
        || context.router.host !== '127.0.0.1' || context.router.port !== 8080) {
        fail('PLOINKY_SCOPED_BROKER_CONTEXT_INVALID', 'credential context Router origin is not the strict Box loopback endpoint');
    }
    if (!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(requestAuthority)) {
        fail('PLOINKY_SCOPED_BROKER_CONTEXT_INVALID', 'credential context Router authority is invalid');
    }
    const authorityPort = Number(requestAuthority.slice(requestAuthority.lastIndexOf(':') + 1));
    if (!Number.isSafeInteger(authorityPort) || authorityPort > 65535) {
        fail('PLOINKY_SCOPED_BROKER_CONTEXT_INVALID', 'credential context Router authority port is invalid');
    }
    origin.pathname = '/base-agent-additional-server/soul-gateway/7000/v1/chat/completions';
    return Object.freeze({ upstream: origin, requestAuthority });
}

function jsonError(response, status, message) {
    if (response.headersSent) {
        response.destroy();
        return;
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message } }));
}

function readBoundedBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        request.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_REQUEST_BYTES) {
                reject(new ScopedSoulBrokerError('PLOINKY_SCOPED_BROKER_REQUEST_TOO_LARGE', 'request body is too large'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.once('end', () => resolve(Buffer.concat(chunks)));
        request.once('error', reject);
    });
}

function closeEntry(entry) {
    entry.state = 'closed';
    for (const request of entry.requests) request.destroy();
    entry.requests.clear();
}

function forwardRequest({ body, context, entry, router, response }) {
    context.assertActive();
    const transport = router.upstream.protocol === 'https:' ? https : http;
    const upstreamRequest = transport.request(router.upstream, {
        method: 'POST',
        headers: {
            host: router.requestAuthority,
            authorization: `Bearer ${context.getAgentApiKey()}`,
            'content-type': 'application/json',
            accept: 'text/event-stream, application/json',
            'content-length': body.length,
        },
    }, (upstreamResponse) => {
        const headers = {};
        for (const name of ['content-type', 'cache-control']) {
            const value = upstreamResponse.headers[name];
            if (value !== undefined) headers[name] = value;
        }
        response.writeHead(upstreamResponse.statusCode || 502, headers);
        upstreamResponse.pipe(response);
        upstreamResponse.once('end', () => entry.requests.delete(upstreamRequest));
        upstreamResponse.once('close', () => entry.requests.delete(upstreamRequest));
    });
    entry.requests.add(upstreamRequest);
    response.once('close', () => upstreamRequest.destroy());
    upstreamRequest.once('error', () => {
        entry.requests.delete(upstreamRequest);
        jsonError(response, 502, 'Soul Gateway request failed');
    });
    upstreamRequest.end(body);
}

function normalizeReservation(input, context, now) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('PLOINKY_SCOPED_BROKER_INPUT_INVALID', 'broker reservation must be an object');
    }
    const keys = new Set(Object.keys(input));
    for (const key of keys) {
        if (!['taskId', 'provider', 'audience', 'ttlSeconds'].includes(key)) {
            fail('PLOINKY_SCOPED_BROKER_INPUT_INVALID', `broker reservation contains unknown field ${key}`);
        }
    }
    for (const key of ['taskId', 'provider', 'audience']) {
        if (!keys.has(key)) fail('PLOINKY_SCOPED_BROKER_INPUT_INVALID', `broker reservation is missing ${key}`);
    }
    const provider = exactText(input.provider, 'broker provider', { maxBytes: 32, pattern: /^[a-z][a-z0-9-]*$/ });
    if (!PROVIDERS.has(provider)) fail('PLOINKY_SCOPED_BROKER_INPUT_INVALID', 'broker provider is unsupported');
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > DEFAULT_CAPABILITY_TTL_SECONDS) {
        fail('PLOINKY_SCOPED_BROKER_INPUT_INVALID', 'broker capability TTL is invalid');
    }
    const contextExpiry = context.attestation.expiresAt;
    const expiresAt = contextExpiry === null ? now + ttlSeconds : Math.min(contextExpiry, now + ttlSeconds);
    if (expiresAt <= now) fail('PLOINKY_SCOPED_BROKER_CONTEXT_EXPIRED', 'credential context expires before broker capability activation');
    return Object.freeze({
        taskId: exactText(input.taskId, 'broker taskId'),
        provider,
        audience: exactText(input.audience, 'broker audience'),
        generation: exactText(context.identity.enableGeneration, 'broker generation'),
        principalId: exactText(context.identity.principalId, 'broker principal'),
        issuedAt: now,
        expiresAt,
    });
}

export function assertScopedSoulBrokerRegistry(value, credentialContext) {
    const context = assertAgentCredentialContext(credentialContext);
    if (!value || typeof value !== 'object' || REGISTRIES.get(value) !== context) {
        fail(
            'PLOINKY_SCOPED_BROKER_REGISTRY_REQUIRED',
            'a context-bound scoped broker registry is required',
        );
    }
    return value;
}

export async function startScopedSoulBrokerRegistry({
    credentialContext,
    now = () => Math.floor(Date.now() / 1000),
    random = randomBytes,
} = {}) {
    const context = assertAgentCredentialContext(credentialContext);
    context.assertActive();
    if (context.runtime.runtimeKind !== 'bwrap') {
        fail('PLOINKY_SCOPED_BROKER_CONTEXT_INVALID', 'provider broker requires a bwrap AgentCredentialContext');
    }
    if (typeof now !== 'function' || typeof random !== 'function') {
        fail('PLOINKY_SCOPED_BROKER_INPUT_INVALID', 'broker dependencies are invalid');
    }
    const router = normalizeRouter(context);
    const capabilities = new Map();
    let closed = false;

    const server = http.createServer(async (request, response) => {
        try {
            if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
                jsonError(response, 404, 'not found');
                return;
            }
            const authorization = String(request.headers.authorization || '');
            const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
            const entry = capabilities.get(token);
            const currentTime = normalizeNow(now());
            if (!entry || entry.state !== 'active' || currentTime >= entry.metadata.expiresAt) {
                jsonError(response, 401, 'invalid broker credential');
                return;
            }
            if (entry.metadata.generation !== context.identity.enableGeneration) {
                jsonError(response, 401, 'invalid broker credential');
                return;
            }
            const body = await readBoundedBody(request);
            let payload;
            try { payload = JSON.parse(body.toString('utf8')); } catch (_) {
                jsonError(response, 400, 'request body must be JSON');
                return;
            }
            if (!payload || typeof payload !== 'object' || !ALLOWED_MODELS.has(payload.model)) {
                jsonError(response, 400, 'model must be fast, plan, or deep');
                return;
            }
            forwardRequest({ body, context, entry, router, response });
        } catch (_) {
            jsonError(response, 500, 'broker request failed');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
        server.close();
        fail('PLOINKY_SCOPED_BROKER_LISTEN_FAILED', 'broker registry did not bind exact loopback');
    }
    const brokerUrl = `http://127.0.0.1:${address.port}/v1`;

    const prepare = (input) => {
        if (closed) fail('PLOINKY_SCOPED_BROKER_CLOSED', 'broker registry is closed');
        context.assertActive();
        // Validate the immutable audience before any helper work, but do not
        // create broker state yet. The opaque token must be present in the
        // already-bounded helper descriptor; it is not a capability until the
        // retained-fd barrier has proved every path and activate() registers it.
        normalizeReservation(input, context, normalizeNow(now()));
        const bytes = random(32);
        if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
            fail('PLOINKY_SCOPED_BROKER_RANDOM_INVALID', 'broker random source returned invalid bytes');
        }
        const token = bytes.toString('base64url');
        let entry = null;
        let handleClosed = false;
        return Object.freeze({
            environment: Object.freeze({
                PLOINKY_TASK_BROKER_URL: brokerUrl,
                PLOINKY_TASK_BROKER_KEY: token,
            }),
            activate() {
                if (closed || handleClosed || entry || capabilities.has(token)) {
                    fail('PLOINKY_SCOPED_BROKER_ACTIVATION_INVALID', 'broker capability cannot be activated');
                }
                context.assertActive();
                const metadata = normalizeReservation(input, context, normalizeNow(now()));
                entry = { state: 'active', metadata, requests: new Set() };
                capabilities.set(token, entry);
                return metadata;
            },
            close() {
                if (handleClosed) return false;
                handleClosed = true;
                if (entry) {
                    if (capabilities.get(token) === entry) capabilities.delete(token);
                    closeEntry(entry);
                }
                return true;
            },
        });
    };

    const registry = Object.freeze({
        url: brokerUrl,
        prepare,
        async close() {
            if (closed) return;
            closed = true;
            for (const entry of capabilities.values()) closeEntry(entry);
            capabilities.clear();
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
                server.closeAllConnections?.();
            });
        },
    });
    REGISTRIES.set(registry, context);
    return registry;
}
