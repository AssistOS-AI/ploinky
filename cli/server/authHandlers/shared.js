import { appendLog } from '../utils/logger.js';
import { parseCookies, buildCookie, readJsonBody, appendSetCookie } from '../handlers/common.js';
import { createAuthService } from '../auth/service.js';
import { GUEST_SESSION_TTL_SECONDS, getSessionCookieMaxAge as getLocalSessionCookieMaxAge, mintGuestSessionJwt, mintSessionJwt, resolveUserRev, revokeSession as revokeLocalSession, verifySessionJwt } from '../auth/localService.js';
import { isSessionRevoked } from '../auth/sessionRevocations.js';
import { SessionTokenService } from '../security/tokens/SessionTokenService.js';

export { appendLog, parseCookies, buildCookie, readJsonBody, appendSetCookie, GUEST_SESSION_TTL_SECONDS, getLocalSessionCookieMaxAge, verifySessionJwt };

export const SSO_AUTH_COOKIE_NAME = 'ploinky_sso';
export const LOCAL_AUTH_COOKIE_NAME = 'ploinky_jwt';
export const GUEST_AUTH_COOKIE_NAME = 'ploinky_guest';
export const AUTH_COOKIE_NAME = SSO_AUTH_COOKIE_NAME;
export const authService = createAuthService();
export const sessionTokenService = new SessionTokenService({
    mintUserSession: mintSessionJwt,
    mintGuestSession: mintGuestSessionJwt,
    verifySessionJwt,
    resolveUserRev,
    revokeSession: revokeLocalSession,
    isSessionRevoked,
});

export function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body || {});
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(payload);
}

function getRequestBaseUrl(req) {
    const headers = req.headers || {};
    const forwardedProto = headers['x-forwarded-proto'];
    const forwardedHost = headers['x-forwarded-host'] || headers['host'];
    const proto = forwardedProto
        ? String(forwardedProto).split(',')[0].trim()
        : (req.socket && req.socket.encrypted ? 'https' : 'http');
    if (!forwardedHost) return null;
    return `${proto}://${forwardedHost}`;
}

function wantsJsonResponse(req, pathname) {
    const accept = String(req.headers?.accept || '').toLowerCase();
    if (accept.includes('application/json')) return true;
    if (accept.includes('text/event-stream')) return true;
    if (!pathname) return false;
    return pathname.startsWith('/apis/') || pathname.startsWith('/api/') || pathname.startsWith('/blobs');
}

function normalizeRelativePath(value, fallback = '/') {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return fallback;
    try {
        const parsed = new URL(raw, 'http://localhost');
        if (parsed.origin !== 'http://localhost') {
            return fallback;
        }
        const normalized = `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
        return normalized.startsWith('/') ? normalized : fallback;
    } catch (_) {
        return fallback;
    }
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function readTextBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function readLoginBody(req) {
    const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('application/json')) {
        return readJsonBody(req);
    }
    const raw = await readTextBody(req);
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
}

function getCookieNameForMode(mode) {
    if (mode === 'local') return LOCAL_AUTH_COOKIE_NAME;
    if (mode === 'guest') return GUEST_AUTH_COOKIE_NAME;
    return SSO_AUTH_COOKIE_NAME;
}

export {
    escapeHtml,
    getCookieNameForMode,
    getRequestBaseUrl,
    normalizeRelativePath,
    readLoginBody,
    readTextBody,
    wantsJsonResponse,
};
