import crypto from 'node:crypto';

import { deriveSubkey } from '../../utils/security/masterKey.js';
import { JwsCodec } from '../security/tokens/JwsCodec.js';
import { isSessionRevoked } from './sessionRevocations.js';
import { emitAuthenticationSessionInvalidated } from './sessionEvents.js';

const jwsCodec = new JwsCodec();

const SESSION_AUDIENCE = 'ploinky-router';

function newSessionId() {
    return `sess_${crypto.randomBytes(16).toString('base64url')}`;
}

const SESSION_TTL_SECONDS = 4 * 60 * 60;

function getSessionSigningKey() {
    return deriveSubkey('session');
}

function mintSessionJwt(user, rev = 1, options = {}) {
    if (options.channel !== 'cli' || user?.id !== 'local:admin') {
        throw new Error('Router user sessions are restricted to the signed CLI operator channel.');
    }
    // `sid` is stable for the life of a login: callers pass the existing sid
    // when refreshing the sliding-window cookie so revocation by sid persists.
    const sid = String(options?.sid || '').trim() || newSessionId();
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'user-session',
        iss: 'ploinky-router',
        aud: SESSION_AUDIENCE,
        sub: String(user.id || ''),
        sid,
        usr: {
            id: String(user.id || ''),
            username: String(user.username || ''),
            name: String(user.name || user.username || ''),
            email: String(user.email || ''),
            roles: Array.isArray(user.roles) ? [...user.roles] : ['user']
        },
        rev: Number(rev) || 1,
        chn: 'cli',
        iat,
        exp: iat + SESSION_TTL_SECONDS,
        jti: crypto.randomBytes(16).toString('base64url')
    };
    return jwsCodec.sign({ payload, secret: getSessionSigningKey() });
}

const SESSION_TOKEN_TYPES = new Set(['user-session', 'guest-session']);

function verifySessionJwt(token) {
    const { payload } = jwsCodec.verify(token, {
        secret: getSessionSigningKey(),
        expectedAudience: SESSION_AUDIENCE,
        maxTtlSeconds: SESSION_TTL_SECONDS + 1
    });
    if (!SESSION_TOKEN_TYPES.has(payload.typ)) {
        throw new Error('Not a session JWT');
    }
    if (payload.iss !== 'ploinky-router') {
        throw new Error('Session JWT not issued by router');
    }
    if (payload.typ === 'user-session'
        && (payload.chn !== 'cli' || payload.usr?.id !== 'local:admin' || payload.sub !== 'local:admin')) {
        throw new Error('Local browser sessions are not supported.');
    }
    return payload;
}

const GUEST_SESSION_TTL_SECONDS = 60 * 60;

function mintGuestSessionJwt(options = {}) {
    const guestId = crypto.randomUUID();
    const guestScope = String(options?.guestScope || options?.policy?.guestScope || '').trim();
    const guestRouteKey = String(options?.routeKey || options?.policy?.routeKey || '').trim();
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'guest-session',
        iss: 'ploinky-router',
        aud: SESSION_AUDIENCE,
        sub: `user:guest:${guestId}`,
        sid: `gsess_${guestId}`,
        gscope: guestScope || undefined,
        groute: guestRouteKey || undefined,
        usr: {
            id: `guest:${guestId}`,
            username: 'visitor',
            name: 'Guest',
            email: '',
            roles: ['guest']
        },
        rev: 0,
        iat,
        exp: iat + GUEST_SESSION_TTL_SECONDS,
        jti: crypto.randomBytes(16).toString('base64url')
    };
    return jwsCodec.sign({ payload, secret: getSessionSigningKey() });
}

function isAdminUser(user = null) {
    if (!user || typeof user !== 'object') return false;
    const roles = Array.isArray(user.roles)
        ? user.roles.map((role) => String(role || '').trim().toLowerCase())
        : [];
    return roles.includes('admin') && !roles.includes('guest');
}

function getSession(sessionId, options = {}) {
    if (!sessionId) return null;
    let payload;
    try {
        payload = verifySessionJwt(sessionId);
    } catch {
        return null;
    }
    // Stateless session JWTs are revoked out-of-band via the persistent
    // revocation list (logout / forced revocation).
    if (isSessionRevoked({ sid: payload.sid, jti: payload.jti })) {
        return null;
    }
    const roles = Array.isArray(payload.usr?.roles) ? payload.usr.roles : [];
    const isGuestSession = roles.some((role) => String(role || '').trim().toLowerCase() === 'guest');
    if (isGuestSession) {
        const expectedRouteKey = String(options?.routeKey || options?.policy?.routeKey || '').trim();
        const payloadRouteKey = String(payload.groute || payload.guestRouteKey || '').trim();
        if (expectedRouteKey && payloadRouteKey !== expectedRouteKey) {
            return null;
        }
        const expectedGuestScope = String(options?.guestScope || options?.policy?.guestScope || '').trim();
        const payloadGuestScope = String(payload.gscope || payload.guestScope || '').trim();
        if (options?.allowAnyGuestScope === true) {
            if (!payloadGuestScope) return null;
        } else if (expectedGuestScope) {
            if (payloadGuestScope !== expectedGuestScope) {
                return null;
            }
        } else if (payloadGuestScope) {
            return null;
        }
    }
    return {
        id: sessionId,
        user: payload.usr ? {
            id: payload.usr.id || payload.sub,
            username: payload.usr.username,
            name: payload.usr.name || payload.usr.username,
            email: payload.usr.email || null,
            roles: Array.isArray(payload.usr.roles) ? payload.usr.roles : ['user']
        } : null,
        createdAt: payload.iat * 1000,
        expiresAt: payload.exp * 1000,
        _jwtPayload: payload
    };
}

function revokeSession(sessionId) {
    let sessionBindingId = '';
    try { sessionBindingId = String(verifySessionJwt(sessionId)?.sid || ''); } catch (_) { }
    emitAuthenticationSessionInvalidated({
        mode: 'local',
        sessionId,
        sessionBindingId,
        reason: 'revoked',
    });
}

function getSessionCookieMaxAge() {
    return SESSION_TTL_SECONDS;
}

export {
    GUEST_SESSION_TTL_SECONDS,
    getSession,
    getSessionCookieMaxAge,
    isAdminUser,
    mintGuestSessionJwt,
    mintSessionJwt,
    revokeSession,
    verifySessionJwt
};
