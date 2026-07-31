import net from 'node:net';
import { performance } from 'node:perf_hooks';

export const AUTHORITY_ATTESTATION_HEADER = 'x-ploinky-authority-probe';
export const AUTHORITY_ATTESTATION_PATH = '/authority-attestations';
export const AUTHORITY_ATTESTATION_BODY_MAX_BYTES = 1024;
export const AUTHORITY_ATTESTATION_BODY_TIMEOUT_MS = 1_000;
export const AUTHORITY_ATTESTATION_MAX_PENDING = 16;
export const AUTHORITY_ATTESTATION_TTL_MS = 10_000;

const NONCE_PATTERN = /^[0-9a-f]{64}$/;

function isValidNonce(value) {
    return typeof value === 'string' && NONCE_PATTERN.test(value);
}

function normalizeSocketAddress(value) {
    const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) return address.slice(7);
    return address || null;
}

function boundedString(value, maximumLength = 512) {
    if (typeof value !== 'string' || value.length > maximumLength) return null;
    return value;
}

function exactObservation(value = {}) {
    const routePlanStatus = Number.isSafeInteger(value.routePlanStatus)
        && value.routePlanStatus >= 100
        && value.routePlanStatus <= 599
        ? value.routePlanStatus
        : null;
    return Object.freeze({
        rawHost: boundedString(value.rawHost),
        normalizedHost: boundedString(value.normalizedHost),
        effectiveListener: boundedString(value.effectiveListener, 32),
        rawInterfaceClass: boundedString(value.rawInterfaceClass, 32),
        socketLocalAddress: normalizeSocketAddress(value.socketLocalAddress),
        socketRemoteAddress: normalizeSocketAddress(value.socketRemoteAddress),
        routePlanOk: value.routePlanOk === true,
        routePlanStatus,
        routePlanCode: boundedString(value.routePlanCode, 128),
        hostSelectionKind: boundedString(value.hostSelectionKind, 64),
        controlMiss: value.controlMiss === true,
        generationLeaseId: boundedString(value.generationLeaseId, 256),
    });
}

export function createRouterAuthorityAttestationRegistry({
    now = () => performance.now(),
    maximumPending = AUTHORITY_ATTESTATION_MAX_PENDING,
    ttlMs = AUTHORITY_ATTESTATION_TTL_MS,
} = {}) {
    if (typeof now !== 'function') throw new TypeError('authority attestation clock must be callable');
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 1 || maximumPending > AUTHORITY_ATTESTATION_MAX_PENDING) {
        throw new TypeError(`authority attestation capacity must be an integer from 1 through ${AUTHORITY_ATTESTATION_MAX_PENDING}`);
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > AUTHORITY_ATTESTATION_TTL_MS) {
        throw new TypeError(`authority attestation TTL must be positive and at most ${AUTHORITY_ATTESTATION_TTL_MS}ms`);
    }

    const pending = new Map();

    function monotonicNow() {
        const value = Number(now());
        if (!Number.isFinite(value)) throw new Error('authority attestation monotonic clock is invalid');
        return value;
    }

    function expire(observedAt) {
        for (const [nonce, entry] of pending) {
            if (observedAt >= entry.expiresAt) pending.delete(nonce);
        }
    }

    function register(nonce) {
        const observedAt = monotonicNow();
        expire(observedAt);
        if (!isValidNonce(nonce)) return Object.freeze({ ok: false, status: 'invalid' });
        if (pending.has(nonce)) return Object.freeze({ ok: false, status: 'exists' });
        if (pending.size >= maximumPending) return Object.freeze({ ok: false, status: 'capacity' });
        pending.set(nonce, {
            expiresAt: observedAt + ttlMs,
            records: [],
        });
        return Object.freeze({ ok: true, status: 'registered' });
    }

    function record(nonce, observation) {
        const observedAt = monotonicNow();
        expire(observedAt);
        if (!isValidNonce(nonce)) return false;
        const entry = pending.get(nonce);
        if (!entry || entry.records.length >= 2) return false;
        entry.records.push(exactObservation(observation));
        return true;
    }

    function consume(nonce) {
        const observedAt = monotonicNow();
        expire(observedAt);
        if (!isValidNonce(nonce)) return Object.freeze({ ok: false, status: 'not-found' });
        const entry = pending.get(nonce);
        if (!entry) return Object.freeze({ ok: false, status: 'not-found' });
        if (entry.records.length !== 2) {
            return Object.freeze({ ok: false, status: 'incomplete' });
        }
        pending.delete(nonce);
        return Object.freeze({
            ok: true,
            status: 'complete',
            nonce,
            records: Object.freeze([...entry.records]),
        });
    }

    function pendingCount() {
        expire(monotonicNow());
        return pending.size;
    }

    return Object.freeze({
        register,
        record,
        consume,
        pendingCount,
    });
}

export function recordRouterAuthorityObservation(registry, {
    req,
    normalizedHost,
    effectiveListener,
    rawInterfaceClass,
    routePlan,
    controlMiss,
} = {}) {
    try {
        const nonce = req?.headers?.[AUTHORITY_ATTESTATION_HEADER];
        return registry?.record?.(nonce, {
            rawHost: req?.headers?.host,
            normalizedHost,
            effectiveListener,
            rawInterfaceClass,
            socketLocalAddress: req?.socket?.localAddress,
            socketRemoteAddress: req?.socket?.remoteAddress,
            routePlanOk: routePlan?.ok === true,
            routePlanStatus: routePlan?.status,
            routePlanCode: routePlan?.code,
            hostSelectionKind: routePlan?.hostSelection?.kind,
            controlMiss,
            generationLeaseId: routePlan?.lease?.id,
        }) === true;
    } catch (_) {
        return false;
    }
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        ...extraHeaders,
    });
    res.end(bytes);
}

function readRegistrationBody(req, bodyTimeoutMs = AUTHORITY_ATTESTATION_BODY_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        let timer;
        const cleanup = () => {
            clearTimeout(timer);
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', fail);
            req.off('aborted', onAborted);
        };
        const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            req.resume?.();
            reject(error);
        };
        const onData = (chunk) => {
            if (settled) return;
            const bytes = Buffer.from(chunk);
            total += bytes.length;
            if (total > AUTHORITY_ATTESTATION_BODY_MAX_BYTES) {
                chunks.length = 0;
                const error = new Error('authority attestation registration body exceeds limit');
                error.code = 'AUTHORITY_ATTESTATION_BODY_TOO_LARGE';
                error.status = 413;
                fail(error);
                return;
            }
            chunks.push(bytes);
        };
        const onEnd = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(Buffer.concat(chunks));
        };
        const onAborted = () => {
            const error = new Error('authority attestation registration was aborted');
            error.code = 'INVALID_AUTHORITY_ATTESTATION_REGISTRATION';
            error.status = 400;
            fail(error);
        };
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', fail);
        req.on('aborted', onAborted);
        timer = setTimeout(() => {
            const error = new Error('authority attestation registration body timed out');
            error.code = 'AUTHORITY_ATTESTATION_BODY_TIMEOUT';
            error.status = 408;
            fail(error);
        }, bodyTimeoutMs);
        timer.unref?.();
    });
}

function parseRegistration(bytes) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (_) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (Object.getPrototypeOf(parsed) !== Object.prototype) return null;
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== 'nonce' || !isValidNonce(parsed.nonce)) return null;
    return parsed.nonce;
}

export async function handleRouterAuthorityAttestationRequest(req, res, {
    registry,
    bodyTimeoutMs = AUTHORITY_ATTESTATION_BODY_TIMEOUT_MS,
} = {}) {
    const method = String(req?.method || 'GET').toUpperCase();
    const requestTarget = String(req?.url || '');
    const isCollection = requestTarget === AUTHORITY_ATTESTATION_PATH;
    const isItem = requestTarget.startsWith(`${AUTHORITY_ATTESTATION_PATH}/`);
    if (!isCollection && !isItem) return false;

    if (isCollection) {
        if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
            return true;
        }
        let body;
        try {
            body = await readRegistrationBody(req, bodyTimeoutMs);
        } catch (error) {
            sendJson(res, error?.status || 400, {
                ok: false,
                error: error?.code || 'INVALID_AUTHORITY_ATTESTATION_REGISTRATION',
            });
            return true;
        }
        const nonce = parseRegistration(body);
        if (!nonce) {
            sendJson(res, 400, { ok: false, error: 'INVALID_AUTHORITY_ATTESTATION_REGISTRATION' });
            return true;
        }
        let result;
        try {
            result = registry?.register?.(nonce);
        } catch (_) {
            sendJson(res, 503, { ok: false, error: 'AUTHORITY_ATTESTATION_REGISTRY_UNAVAILABLE' });
            return true;
        }
        if (result?.ok) {
            sendJson(res, 201, { ok: true, nonce });
            return true;
        }
        const code = result?.status === 'capacity'
            ? 'AUTHORITY_ATTESTATION_CAPACITY'
            : (result?.status === 'exists'
                ? 'AUTHORITY_ATTESTATION_EXISTS'
                : 'INVALID_AUTHORITY_ATTESTATION_REGISTRATION');
        sendJson(res, result?.status === 'invalid' ? 400 : 409, { ok: false, error: code });
        return true;
    }

    if (method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
        return true;
    }
    const nonce = requestTarget.slice(AUTHORITY_ATTESTATION_PATH.length + 1);
    if (!isValidNonce(nonce)) {
        sendJson(res, 404, { ok: false, error: 'AUTHORITY_ATTESTATION_NOT_FOUND' });
        return true;
    }
    let result;
    try {
        result = registry?.consume?.(nonce);
    } catch (_) {
        sendJson(res, 503, { ok: false, error: 'AUTHORITY_ATTESTATION_REGISTRY_UNAVAILABLE' });
        return true;
    }
    if (result?.ok) {
        sendJson(res, 200, { ok: true, nonce, records: result.records });
        return true;
    }
    if (result?.status === 'incomplete') {
        sendJson(res, 409, { ok: false, error: 'AUTHORITY_ATTESTATION_INCOMPLETE' });
        return true;
    }
    sendJson(res, 404, { ok: false, error: 'AUTHORITY_ATTESTATION_NOT_FOUND' });
    return true;
}

export default {
    AUTHORITY_ATTESTATION_BODY_MAX_BYTES,
    AUTHORITY_ATTESTATION_BODY_TIMEOUT_MS,
    AUTHORITY_ATTESTATION_HEADER,
    AUTHORITY_ATTESTATION_MAX_PENDING,
    AUTHORITY_ATTESTATION_PATH,
    AUTHORITY_ATTESTATION_TTL_MS,
    createRouterAuthorityAttestationRegistry,
    handleRouterAuthorityAttestationRequest,
    recordRouterAuthorityObservation,
};
