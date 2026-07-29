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

const RELATIVE_PATH_BASE_URL = 'http://localhost';
const RAW_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const RAW_WHITESPACE = /\s/;
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i;
const ENCODED_CONTROL_CHARACTER = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;
const AUTHORITY_LIKE_FRAGMENT = /^(?:[/\\]{2}|[a-z][a-z0-9+.-]*:)/i;

function containsUnsafeEncoding(value, { rejectSeparators = false } = {}) {
    let current = String(value || '');
    for (let depth = 0; depth < 8; depth += 1) {
        if (ENCODED_CONTROL_CHARACTER.test(current)) return true;
        if (rejectSeparators && ENCODED_PATH_SEPARATOR.test(current)) return true;
        if (!current.includes('%')) return false;
        try {
            const decoded = decodeURIComponent(current);
            if (decoded === current) return false;
            current = decoded;
        } catch (_) {
            return depth === 0;
        }
    }
    return true;
}

function fragmentLooksLikeAuthority(fragment) {
    let current = String(fragment || '');
    for (let depth = 0; depth < 8; depth += 1) {
        if (current !== current.trim()) return true;
        if (RAW_CONTROL_CHARACTER.test(current) || AUTHORITY_LIKE_FRAGMENT.test(current)) return true;
        if (!current.includes('%')) return false;
        try {
            const decoded = decodeURIComponent(current);
            if (decoded === current) return false;
            current = decoded;
        } catch (_) {
            return depth === 0;
        }
    }
    return true;
}

function normalizeRelativePath(value, fallback = '/') {
    const raw = typeof value === 'string' ? value : '';
    if (!raw || raw !== raw.trim()) return fallback;
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
    if (RAW_CONTROL_CHARACTER.test(raw) || RAW_WHITESPACE.test(raw) || INVALID_PERCENT_ESCAPE.test(raw)) {
        return fallback;
    }
    try {
        decodeURIComponent(raw);
    } catch (_) {
        return fallback;
    }

    const queryIndex = raw.indexOf('?');
    const fragmentIndex = raw.indexOf('#');
    const pathEnd = [queryIndex, fragmentIndex]
        .filter(index => index >= 0)
        .reduce((lowest, index) => Math.min(lowest, index), raw.length);
    const rawPath = raw.slice(0, pathEnd);
    const rawFragment = fragmentIndex >= 0 ? raw.slice(fragmentIndex + 1) : '';

    if (containsUnsafeEncoding(raw)) return fallback;
    if (containsUnsafeEncoding(rawPath, { rejectSeparators: true })) return fallback;
    if (containsUnsafeEncoding(rawFragment, { rejectSeparators: true })) return fallback;
    if (fragmentLooksLikeAuthority(rawFragment)) return fallback;

    try {
        const parsed = new URL(raw, RELATIVE_PATH_BASE_URL);
        if (parsed.origin !== RELATIVE_PATH_BASE_URL || parsed.username || parsed.password) {
            return fallback;
        }
        const normalized = `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
        return normalized.startsWith('/') && !normalized.startsWith('//') ? normalized : fallback;
    } catch (_) {
        return fallback;
    }
}

function appendLocationHashToRelativeTarget(returnTo, locationHash) {
    const target = typeof returnTo === 'string' ? returnTo : '';
    const hash = typeof locationHash === 'string' ? locationHash : '';
    if (!target || !hash.startsWith('#') || hash === '#' || target.includes('#')) return target;
    if (/\s/.test(hash) || /[\u0000-\u001f\u007f]/.test(hash) || /%(?![0-9a-f]{2})/i.test(hash)) {
        return target;
    }

    let routeState = hash.slice(1);
    for (let depth = 0; depth < 8; depth += 1) {
        if (/%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i.test(routeState)) return target;
        if (routeState !== routeState.trim()) return target;
        if (/[\u0000-\u001f\u007f]/.test(routeState)) return target;
        if (/^(?:[/\\]{2}|[a-z][a-z0-9+.-]*:)/i.test(routeState)) return target;
        if (!routeState.includes('%')) break;
        try {
            const decoded = decodeURIComponent(routeState);
            if (decoded === routeState) break;
            routeState = decoded;
        } catch (_) {
            if (depth === 0) return target;
            break;
        }
        if (depth === 7) return target;
    }

    try {
        const parsed = new URL(target, 'http://localhost');
        if (
            !target.startsWith('/')
            || target.startsWith('//')
            || target.includes('\\')
            || parsed.origin !== 'http://localhost'
            || parsed.hash
        ) {
            return target;
        }
    } catch (_) {
        return target;
    }
    return `${target}${hash}`;
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
    appendLocationHashToRelativeTarget,
    getCookieNameForMode,
    getRequestBaseUrl,
    normalizeRelativePath,
    readLoginBody,
    readTextBody,
    wantsJsonResponse,
};
