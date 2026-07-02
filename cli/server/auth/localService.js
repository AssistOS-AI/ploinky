import crypto from 'node:crypto';

import { deriveSubkey } from '../../services/masterKey.js';
import { JwsCodec } from '../security/tokens/JwsCodec.js';
import { createSessionStore } from './sessionStore.js';
import { isSessionRevoked } from './sessionRevocations.js';

const sessionStore = createSessionStore();
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
    const usersVar = String(options?.usersVar || options?.policy?.usersVar || '').trim();
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
        uvar: usersVar || undefined,
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
    return payload;
}

const GUEST_SESSION_TTL_SECONDS = 60 * 60;

function mintGuestSessionJwt(options = {}) {
    const guestId = crypto.randomUUID();
    const guestScope = String(options?.guestScope || options?.policy?.guestScope || '').trim();
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'guest-session',
        iss: 'ploinky-router',
        aud: SESSION_AUDIENCE,
        sub: `user:guest:${guestId}`,
        sid: `gsess_${guestId}`,
        gscope: guestScope || undefined,
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

function resolveUserRev(usersVar, username) {
    return 0;
}

function normalizeRoles(input) {
    const raw = Array.isArray(input) ? input : [];
    const values = [];
    for (const entry of raw) {
        let normalized = String(entry || '').trim();
        // Map the legacy base role `local` to the canonical `user` (DS013).
        if (normalized === 'local') {
            normalized = 'user';
        }
        if (normalized && !values.includes(normalized)) {
            values.push(normalized);
        }
    }
    if (!values.includes('user')) {
        values.unshift('user');
    }
    return values;
}

function isAdminUser(user = null) {
    if (!user || typeof user !== 'object') return false;
    const roles = Array.isArray(user.roles) ? user.roles : [];
    return roles.some((role) => String(role || '').trim().toLowerCase() === 'admin');
}

function createExternalSession({ user, routeKey = '', provider = 'external' } = {}) {
    const now = Date.now();
    const safeProvider = String(provider || 'external').trim() || 'external';
    const sourceUser = user && typeof user === 'object' ? user : {};
    const login = String(sourceUser.login || sourceUser.username || sourceUser.name || '').trim();
    const email = String(sourceUser.email || '').trim() || null;
    const safeUser = {
        id: String(sourceUser.id || `${safeProvider}:${login || 'user'}`).trim(),
        username: login || String(sourceUser.name || sourceUser.id || 'user').trim(),
        name: String(sourceUser.name || login || sourceUser.id || 'User').trim(),
        email,
        roles: [safeProvider]
    };
    const { id: sessionId } = sessionStore.createSession({
        user: safeUser,
        externalAuth: {
            provider: safeProvider,
            routeKey: String(routeKey || '').trim()
        },
        tokens: null,
        expiresAt: now + sessionStore.sessionTtlMs
    });
    return { sessionId, user: safeUser };
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
    const usersVar = String(options?.usersVar || options?.policy?.usersVar || payload.uvar || '').trim();
    const payloadUsersVar = String(payload.uvar || '').trim();
    if (payloadUsersVar) {
        return null;
    }
    if (usersVar && payloadUsersVar !== usersVar) {
        return null;
    }
    const roles = Array.isArray(payload.usr?.roles) ? payload.usr.roles : [];
    const isGuestSession = roles.some((role) => String(role || '').trim().toLowerCase() === 'guest');
    if (isGuestSession) {
        const expectedGuestScope = String(options?.guestScope || options?.policy?.guestScope || '').trim();
        const payloadGuestScope = String(payload.gscope || payload.guestScope || '').trim();
        if (expectedGuestScope) {
            if (payloadGuestScope !== expectedGuestScope) {
                return null;
            }
        } else if (payloadGuestScope) {
            return null;
        }
    }
    if (usersVar && payload.usr?.username) {
        const currentRev = resolveUserRev(usersVar, payload.usr.username);
        if (currentRev !== (payload.rev || 1)) {
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
        localAuth: { usersVar, username: payload.usr?.username || '' },
        createdAt: payload.iat * 1000,
        expiresAt: payload.exp * 1000,
        _jwtPayload: payload
    };
}

function revokeSession(sessionId) {
    sessionStore.deleteSession(sessionId);
}

function getSessionCookieMaxAge() {
    return SESSION_TTL_SECONDS;
}

export {
    createExternalSession,
    GUEST_SESSION_TTL_SECONDS,
    getSession,
    getSessionCookieMaxAge,
    isAdminUser,
    mintGuestSessionJwt,
    mintSessionJwt,
    normalizeRoles,
    resolveUserRev,
    revokeSession,
    verifySessionJwt
};
