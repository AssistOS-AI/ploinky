import crypto from 'node:crypto';

import { deriveSubkey } from '../services/masterKey.js';
import { isLocalAdminUser } from './auth/localService.js';

export const ADMIN_CSRF_HEADER = 'x-ploinky-csrf-token';

const ADMIN_CSRF_VERSION = 'v1';
const LOCAL_CONTROL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'router.localhost']);
const FORWARDING_HEADERS = [
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-port',
    'x-forwarded-proto',
];

function headerValue(req, name) {
    const value = req?.headers?.[name];
    return Array.isArray(value) ? null : (typeof value === 'string' ? value : '');
}

function hasForwardingHeaders(req) {
    return FORWARDING_HEADERS.some((name) => Object.prototype.hasOwnProperty.call(req?.headers || {}, name));
}

export function canonicalControlOrigin(req) {
    if (hasForwardingHeaders(req)) return null;
    const rawHost = headerValue(req, 'host');
    if (!rawHost || rawHost !== rawHost.trim() || /[\u0000-\u0020\u007f,@/\\%]/.test(rawHost)) return null;
    const scheme = req?.socket?.encrypted ? 'https' : 'http';
    let parsed;
    try {
        parsed = new URL(`${scheme}://${rawHost}`);
    } catch (_) {
        return null;
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!LOCAL_CONTROL_HOSTS.has(hostname)) return null;
    return parsed.origin;
}

function csrfMac(sessionId, origin) {
    return crypto
        .createHmac('sha256', deriveSubkey('router-admin-csrf'))
        .update(ADMIN_CSRF_VERSION)
        .update('\0')
        .update(String(sessionId || ''))
        .update('\0')
        .update(String(origin || ''))
        .digest('base64url');
}

export function mintAdminCsrfToken({ sessionId, req } = {}) {
    const sid = String(sessionId || '');
    const origin = canonicalControlOrigin(req);
    if (!sid || !origin) {
        const error = new Error('an exact local control origin and authenticated session are required');
        error.code = 'CONTROL_ORIGIN_REQUIRED';
        throw error;
    }
    return `${ADMIN_CSRF_VERSION}.${csrfMac(sid, origin)}`;
}

export function verifyAdminMutationRequest(req, sessionId = req?.sessionId) {
    const origin = canonicalControlOrigin(req);
    const suppliedOrigin = headerValue(req, 'origin');
    const sid = String(sessionId || '');
    if (!origin || !suppliedOrigin || suppliedOrigin !== origin || !sid) {
        return { ok: false, code: 'CONTROL_ORIGIN_REQUIRED' };
    }
    const supplied = headerValue(req, ADMIN_CSRF_HEADER);
    const expected = `${ADMIN_CSRF_VERSION}.${csrfMac(sid, origin)}`;
    const suppliedBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expected);
    if (!supplied || suppliedBytes.length !== expectedBytes.length
        || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
        return { ok: false, code: 'CSRF_INVALID' };
    }
    return { ok: true, origin };
}

function sendDenied(res, status, code) {
    const body = JSON.stringify({ ok: false, error: { code } });
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

export function requireAdminControlRequest(req, res, { mutation = false, sessionId = req?.sessionId } = {}) {
    if (!isLocalAdminUser(req?.user)) {
        sendDenied(res, req?.user ? 403 : 401, req?.user ? 'ADMIN_REQUIRED' : 'AUTH_REQUIRED');
        return false;
    }
    if (mutation) {
        const decision = verifyAdminMutationRequest(req, sessionId);
        if (!decision.ok) {
            sendDenied(res, 403, decision.code);
            return false;
        }
    }
    return true;
}
