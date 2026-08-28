import crypto from 'node:crypto';

import { isLocalAdminUser } from '../auth/localService.js';
import { onAuthenticationSessionInvalidated } from '../auth/sessionEvents.js';
import { authService, sessionTokenService } from '../authHandlers/shared.js';
import { resolveSessionBindingId } from '../sessionBinding.js';

function fingerprint(mode, value) {
    return crypto.createHash('sha256')
        .update('webtty-auth-session\0')
        .update(String(mode || ''))
        .update('\0')
        .update(String(value || ''))
        .digest('base64url');
}

function localPolicyForLease(req) {
    const policy = req?.edgeAuthContext?.policy || {};
    return Object.freeze({
        usersVar: String(policy.usersVar || req?.session?.localAuth?.usersVar || '').trim(),
        routeKey: String(policy.routeKey || '').trim(),
    });
}

export function createBrowserSessionLease(req) {
    const mode = String(req?.authMode || '').trim();
    const sessionId = String(req?.sessionId || '').trim();
    const sessionBindingId = resolveSessionBindingId(req, sessionId);
    const userId = String(req?.user?.id || '').trim();
    if (!['local', 'sso'].includes(mode) || !sessionId || !sessionBindingId || !userId) {
        const error = new Error('an authenticated browser session is required');
        error.code = 'WEBTTY_AUTH_SESSION_REQUIRED';
        throw error;
    }
    if (!isLocalAdminUser(req.user)) {
        const error = new Error('administrator authority is required');
        error.code = 'WEBTTY_ADMIN_REQUIRED';
        throw error;
    }
    return Object.freeze({
        mode,
        authChannel: String(req?.authChannel || 'browser').trim() || 'browser',
        sessionId,
        sessionBindingId,
        sessionFingerprint: fingerprint(mode, sessionBindingId),
        userId,
        localPolicy: mode === 'local' ? localPolicyForLease(req) : null,
        createdAt: Date.now(),
    });
}

export function requestMatchesBrowserSessionLease(req, lease) {
    if (!lease || String(req?.authMode || '') !== lease.mode) return false;
    if (String(req?.user?.id || '') !== lease.userId) return false;
    const requestBindingId = resolveSessionBindingId(req, req?.sessionId);
    return Boolean(requestBindingId)
        && fingerprint(lease.mode, requestBindingId) === lease.sessionFingerprint;
}

export async function validateBrowserSessionLease(lease) {
    if (!lease || !['local', 'sso'].includes(lease.mode)) {
        return { ok: false, reason: 'invalid_lease' };
    }
    let session = null;
    try {
        if (lease.mode === 'local') {
            session = await sessionTokenService.getUserSession(lease.sessionId, {
                policy: lease.localPolicy || {},
            });
        } else if (typeof authService.validateSession === 'function') {
            session = await authService.validateSession(lease.sessionId);
        } else {
            session = authService.getSession(lease.sessionId);
        }
    } catch (_) {
        return { ok: false, reason: 'validation_failed' };
    }
    if (!session) return { ok: false, reason: 'missing_or_expired' };
    if (session.expiresAt && Date.now() > Number(session.expiresAt)) {
        return { ok: false, reason: 'expired' };
    }
    if (String(session.user?.id || '') !== lease.userId) {
        return { ok: false, reason: 'user_changed' };
    }
    const bindingId = resolveSessionBindingId({ session }, lease.sessionId);
    if (!bindingId || fingerprint(lease.mode, bindingId) !== lease.sessionFingerprint) {
        return { ok: false, reason: 'session_changed' };
    }
    if (!isLocalAdminUser(session.user)) {
        return { ok: false, reason: 'administrator_revoked' };
    }
    return { ok: true, session };
}

export function subscribeToBrowserSessionInvalidation(lease, listener) {
    return onAuthenticationSessionInvalidated((event) => {
        if (!event || (event.mode && event.mode !== lease.mode)) return;
        const matches = event.all
            || (event.sessionBindingId && event.sessionBindingId === lease.sessionBindingId)
            || (event.sessionId && event.sessionId === lease.sessionId);
        if (matches) listener(event.reason || 'revoked');
    });
}

export default {
    createBrowserSessionLease,
    requestMatchesBrowserSessionLease,
    subscribeToBrowserSessionInvalidation,
    validateBrowserSessionLease,
};
