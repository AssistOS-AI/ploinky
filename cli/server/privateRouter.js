import crypto from 'node:crypto';

import { verifyJws, createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import {
    PRIVATE_ROUTER_AUDIENCE,
    currentEnabledAgentIdentity,
} from '../sandbox/edgeGeneration.js';
import { readSecretsFile } from '../utils/security/encryptedSecretsFile.js';
import { derivePrivateAgentRequestSecret } from '../utils/security/masterKey.js';

const PRIVATE_ASSERTION_HEADER = 'ploinky-agent-assertion';
const PRIVATE_BODY_MAX_BYTES = 10 * 1024 * 1024;
const replayCache = createMemoryReplayCache({ maxSize: 8192 });

export function createTurnCredentialRateLimiter({
    maximumRequests = 20,
    windowMs = 60_000,
    maximumCallers = 2_048,
} = {}) {
    const calls = new Map();
    return Object.freeze({
        consume(callerKey, nowMs = Date.now()) {
            const key = String(callerKey || '');
            if (!key) throw forbidden('TURN credential caller identity is unavailable');
            const cutoff = nowMs - windowMs;
            const recent = (calls.get(key) || []).filter((timestamp) => timestamp > cutoff);
            if (recent.length >= maximumRequests) {
                const error = new Error('TURN credential request rate exceeded');
                error.code = 'TURN_CREDENTIAL_RATE_LIMITED';
                error.status = 429;
                throw error;
            }
            recent.push(nowMs);
            calls.set(key, recent);
            if (calls.size > maximumCallers) {
                for (const [candidate, timestamps] of calls) {
                    if (!timestamps.some((timestamp) => timestamp > cutoff)) calls.delete(candidate);
                    if (calls.size <= maximumCallers) break;
                }
            }
            if (calls.size > maximumCallers) calls.delete(calls.keys().next().value);
        },
        size: () => calls.size,
    });
}

const turnCredentialRateLimiter = createTurnCredentialRateLimiter();

function unauthorized(message, code = 'PRIVATE_ASSERTION_REJECTED') {
    const error = new Error(message);
    error.code = code;
    error.status = 401;
    return error;
}

function forbidden(message, code = 'PRIVATE_CALLER_DENIED') {
    const error = new Error(message);
    error.code = code;
    error.status = 403;
    return error;
}

function parseUntrustedPayload(token) {
    const raw = String(token || '');
    if (!raw || raw.length > 16384) throw unauthorized('private agent assertion is missing or oversized');
    const parts = raw.split('.');
    if (parts.length !== 3) throw unauthorized('private agent assertion is malformed');
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return payload && typeof payload === 'object' ? payload : null;
    } catch (_) {
        throw unauthorized('private agent assertion payload is malformed');
    }
}

function exactCaller(entry, identity) {
    return String(entry?.agentId || '') === identity.agentId
        && String(entry?.instanceId || '') === identity.instanceId
        && String(entry?.enableGeneration || '') === identity.enableGeneration;
}

function pathAllowed(pathname, allowed) {
    if (!Array.isArray(allowed) || !allowed.length) return false;
    return allowed.some((entry) => {
        const value = String(entry || '');
        if (value.endsWith('/*')) {
            const prefix = value.slice(0, -2);
            return pathname === prefix || pathname.startsWith(`${prefix}/`);
        }
        return value === pathname;
    });
}

function callerAclForPlan(plan) {
    const security = plan.snapshot?.compiled?.security || {};
    if (plan.kind === 'private-operation') {
        if (plan.operation === 'turn-credentials') {
            return {
                operation: plan.operation,
                callers: security.turnCredentialConsumers || [],
                methods: ['POST'],
                paths: ['/api/edge/turn-credentials'],
            };
        }
        return null;
    }
    const service = (security.internalServiceConsumers || []).find((entry) => (
        entry?.routeKey === plan.definition?.routeKey && entry?.slug === plan.definition?.slug
    ));
    if (!service) return null;
    return {
        ...service,
        callers: service.callers || [],
        methods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
        paths: [`${String(service.canonicalPrefix || '').replace(/\/$/, '')}/*`],
    };
}

export function authorizePrivateRoutePlan({ req, plan, body = Buffer.alloc(0), assertionCache = replayCache } = {}) {
    if (!plan?.ok || plan.listener !== 'private' && plan.kind !== 'private-operation') {
        throw forbidden('request did not resolve on the private listener', 'PRIVATE_LISTENER_REQUIRED');
    }
    if (plan.kind === 'service' && plan.decision?.access !== 'authenticated') {
        throw forbidden('private service policy is not effectively authenticated', 'PRIVATE_POLICY_DENIED');
    }
    const acl = callerAclForPlan(plan);
    if (!acl) throw forbidden('private route has no active caller ACL');
    const method = String(req?.method || 'GET').toUpperCase();
    const pathname = String(plan.pathname || plan.parsedUrl?.pathname || '');
    const allowedMethods = Array.isArray(acl.methods) ? acl.methods.map((value) => String(value).toUpperCase()) : [];
    if (!allowedMethods.includes(method) || !pathAllowed(pathname, acl.paths)) {
        throw forbidden('private request method/path is outside the exact ACL');
    }
    const header = req?.headers?.[PRIVATE_ASSERTION_HEADER];
    const token = Array.isArray(header) ? header[0] : String(header || '').trim();
    const untrusted = parseUntrustedPayload(token);
    const agentId = String(untrusted?.iss || '');
    const current = currentEnabledAgentIdentity(plan.snapshot, agentId);
    if (!current || !current.enableGeneration) throw unauthorized('private assertion caller is not currently enabled');
    if (String(untrusted?.instanceId || '') !== current.instanceId
        || String(untrusted?.enableGeneration || '') !== current.enableGeneration) {
        throw unauthorized('private assertion instance or generation is stale');
    }
    if (!(acl.callers || []).some((entry) => exactCaller(entry, current))) {
        throw forbidden('private assertion caller is not in the exact ACL');
    }
    const rch = computeRchHttp({
        method,
        path: pathname,
        query: plan.parsedUrl?.search || '',
        bodyHash: sha256RawBodyHash(body),
    });
    const secret = derivePrivateAgentRequestSecret(
        agentId,
        current.instanceId,
        current.enableGeneration,
        { encoding: 'buffer' },
    );
    const { payload } = verifyJws(token, {
        secret,
        expectedAudience: PRIVATE_ROUTER_AUDIENCE,
        replayCache: assertionCache,
        maxTtlSeconds: 30,
    });
    if (payload?.typ !== 'private-agent-assertion'
        || payload?.iss !== agentId
        || payload?.sub !== agentId
        || payload?.instanceId !== current.instanceId
        || payload?.enableGeneration !== current.enableGeneration
        || payload?.method !== method
        || payload?.path !== pathname
        || payload?.rch !== rch) {
        throw unauthorized('private assertion request binding mismatch');
    }
    delete req.headers[PRIVATE_ASSERTION_HEADER];
    req.privateAgentIdentity = Object.freeze({ ...current });
    return req.privateAgentIdentity;
}

export function readPrivateRequestBody(req, { maxBytes = PRIVATE_BODY_MAX_BYTES } = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        req.on('data', (chunk) => {
            if (settled) return;
            const bytes = Buffer.from(chunk);
            total += bytes.length;
            if (total > maxBytes) {
                const error = new Error('private request body exceeds limit');
                error.code = 'PRIVATE_BODY_TOO_LARGE';
                error.status = 413;
                fail(error);
                return;
            }
            chunks.push(bytes);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
        });
        req.on('error', fail);
        req.on('aborted', () => fail(new Error('private request aborted')));
    });
}

function validateTurnRequest(body) {
    let parsed;
    try { parsed = JSON.parse(Buffer.from(body).toString('utf8')); } catch (_) {
        const error = new Error('TURN credential request must be JSON');
        error.status = 400;
        error.code = 'INVALID_TURN_REQUEST';
        throw error;
    }
    const roomName = String(parsed?.roomName || '').trim();
    const participantIdentity = String(parsed?.participantIdentity || '').trim();
    if (!roomName || roomName.length > 256 || !participantIdentity || participantIdentity.length > 256) {
        const error = new Error('TURN credential request requires bounded roomName and participantIdentity');
        error.status = 400;
        error.code = 'INVALID_TURN_REQUEST';
        throw error;
    }
    return { roomName, participantIdentity };
}

export function mintTurnCredentials({
    plan,
    body,
    callerIdentity,
    env = process.env,
    secretStore = { readAll: readSecretsFile },
    nowMs = Date.now(),
    rateLimiter = turnCredentialRateLimiter,
} = {}) {
    const { participantIdentity } = validateTurnRequest(body);
    const callerKey = [
        callerIdentity?.agentId,
        callerIdentity?.instanceId,
        callerIdentity?.enableGeneration,
    ].map((value) => String(value || '')).join('\u0000');
    if (callerKey.split('\u0000').some((value) => !value)) {
        throw forbidden('TURN credential minting requires the admitted exact caller identity');
    }
    rateLimiter.consume(callerKey, nowMs);
    const secretHandle = String(plan.snapshot?.desired?.turn?.sharedSecret || '').trim();
    let secrets;
    try {
        secrets = secretStore?.readAll?.();
    } catch (error) {
        const unavailable = new Error(`TURN broker secret store is unavailable: ${error?.message || error}`);
        unavailable.status = 503;
        unavailable.code = 'TURN_SECRET_STORE_UNAVAILABLE';
        throw unavailable;
    }
    const secret = secretHandle && secrets && typeof secrets === 'object' && !Array.isArray(secrets)
        && Object.prototype.hasOwnProperty.call(secrets, secretHandle)
        ? String(secrets[secretHandle] || '').trim()
        : '';
    if (!secretHandle || !secret) {
        const error = new Error('TURN broker is not configured');
        error.status = 503;
        error.code = 'TURN_BROKER_UNAVAILABLE';
        throw error;
    }
    const urls = plan.snapshot?.desired?.turn?.urls;
    if (!Array.isArray(urls) || !urls.length) {
        const error = new Error('TURN topology is unavailable');
        error.status = 503;
        error.code = 'TURN_TOPOLOGY_UNAVAILABLE';
        throw error;
    }
    const requestedTtl = Number(env.PLOINKY_TURN_CREDENTIAL_TTL_SECONDS || 600);
    const ttlSeconds = Number.isSafeInteger(requestedTtl) ? Math.max(60, Math.min(requestedTtl, 3600)) : 600;
    const expiresEpoch = Math.floor(nowMs / 1000) + ttlSeconds;
    const username = `${expiresEpoch}:${participantIdentity}`;
    const password = crypto.createHmac('sha1', secret).update(username).digest('base64');
    return {
        urls: urls.map(String),
        username,
        password,
        expiresAt: new Date(expiresEpoch * 1000).toISOString(),
    };
}

export function sendPrivateError(res, error) {
    const status = Number(error?.status || 401);
    const body = Buffer.from(JSON.stringify({ ok: false, error: error?.code || 'PRIVATE_REQUEST_REJECTED' }));
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

export { PRIVATE_ASSERTION_HEADER, replayCache as privateAssertionReplayCache };

export default {
    authorizePrivateRoutePlan,
    mintTurnCredentials,
    readPrivateRequestBody,
    sendPrivateError,
};
