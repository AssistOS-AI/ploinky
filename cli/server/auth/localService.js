import crypto from 'node:crypto';

import { getUsersPayload, setUsersPayload } from '../../services/encryptedPasswordStore.js';
import { deriveSubkey } from '../../services/masterKey.js';
import { hashPassword, verifyPasswordHash } from '../../services/localAuthPasswords.js';
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

let revCache = null;
let revCacheTime = 0;
const REV_CACHE_TTL_MS = 30_000;

function resolveUserRev(usersVar, username) {
    const now = Date.now();
    if (!revCache || now - revCacheTime > REV_CACHE_TTL_MS) {
        revCache = new Map();
        revCacheTime = now;
    }
    const cacheKey = `${usersVar}:${username}`;
    if (revCache.has(cacheKey)) return revCache.get(cacheKey);
    const parsed = getUsersPayload(usersVar);
    const users = Array.isArray(parsed?.users) ? parsed.users : [];
    const matched = users.find((u) => String(u.username || '').trim() === username);
    if (!matched) {
        revCache.set(cacheKey, 0);
        return 0;
    }
    const rev = Number(matched?.rev) || 1;
    revCache.set(cacheKey, rev);
    return rev;
}

function safeEqual(left, right) {
    const leftBuf = Buffer.from(String(left || ''), 'utf8');
    const rightBuf = Buffer.from(String(right || ''), 'utf8');
    if (leftBuf.length !== rightBuf.length) return false;
    return crypto.timingSafeEqual(leftBuf, rightBuf);
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

function isLocalAdminUser(user = null) {
    if (!user || typeof user !== 'object') return false;
    const roles = Array.isArray(user.roles) ? user.roles : [];
    if (roles.some((role) => String(role || '').trim().toLowerCase() === 'admin')) {
        return true;
    }
    const username = String(user.username || '').trim().toLowerCase();
    const id = String(user.id || '').trim().toLowerCase();
    return username === 'admin' || id === 'local:admin';
}

function normalizeLocalUserRecord(entry = {}) {
    const username = String(entry.username || entry.login || '').trim();
    const passwordHash = String(entry.passwordHash || '').trim();
    if (!username || !passwordHash) {
        return null;
    }
    const name = String(entry.name || username).trim() || username;
    const email = String(entry.email || '').trim() || null;
    return {
        id: String(entry.id || `local:${username}`).trim() || `local:${username}`,
        username,
        name,
        email,
        passwordHash,
        roles: normalizeRoles(entry.roles),
        rev: Number(entry.rev) || 1
    };
}

function parseUsersPayload(payload) {
    const users = Array.isArray(payload?.users) ? payload.users : [];
    return users
        .map((entry) => normalizeLocalUserRecord(entry))
        .filter(Boolean);
}

function serializeUsersPayload(users = []) {
    return {
        version: 1,
        users: users.map((entry) => ({
            id: entry.id,
            username: entry.username,
            name: entry.name,
            email: entry.email,
            passwordHash: entry.passwordHash,
            roles: normalizeRoles(entry.roles),
            rev: Number(entry.rev) || 1
        }))
    };
}

function resolveLocalAuthConfig(policy = {}) {
    const usersVar = String(policy.usersVar || '').trim();
    return {
        usersVar,
        users: parseUsersPayload(getUsersPayload(usersVar))
    };
}

function writeLocalAuthUsers(usersVar, users = []) {
    setUsersPayload(usersVar, serializeUsersPayload(users));
    revCache = null;
    revCacheTime = 0;
}

function serializeUserSummary(entry = {}) {
    return {
        id: String(entry.id || '').trim(),
        username: String(entry.username || '').trim(),
        name: String(entry.name || '').trim(),
        email: String(entry.email || '').trim() || null,
        roles: normalizeRoles(entry.roles)
    };
}

function authenticateLocalUser({ username, password, policy, routeKey = '' }) {
    const config = resolveLocalAuthConfig(policy);
    if (!config.usersVar || !config.users.length) {
        throw new Error('local_auth_not_configured');
    }
    const normalizedUsername = String(username || '').trim();
    const matchedUser = config.users.find((entry) => (
        safeEqual(entry.username, normalizedUsername)
        && verifyPasswordHash(password, entry.passwordHash)
    ));
    if (!matchedUser) {
        throw new Error('invalid_credentials');
    }

    const user = {
        id: matchedUser.id,
        username: matchedUser.username,
        name: matchedUser.name,
        email: matchedUser.email,
        roles: normalizeRoles(matchedUser.roles)
    };
    const sessionJwt = mintSessionJwt(user, matchedUser.rev || 1, { usersVar: config.usersVar });
    return { sessionId: sessionJwt, user };
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

function revokeSessionsForLocalPolicy(policy = {}) {
    const usersVar = String(policy.usersVar || '').trim();
    sessionStore.deleteSessionsWhere((session) => {
        const localAuth = session?.localAuth || {};
        return localAuth.usersVar === usersVar;
    });
}

function updateLocalCredentials({
    currentPassword,
    nextUsername,
    nextPassword = '',
    policy,
    sessionUser = null
}) {
    const config = resolveLocalAuthConfig(policy);
    if (!config.usersVar || !config.users.length) {
        throw new Error('local_auth_not_configured');
    }

    const normalizedCurrentPassword = String(currentPassword || '');
    if (!normalizedCurrentPassword) {
        throw new Error('current_password_required');
    }

    const sessionUsername = String(sessionUser?.username || '').trim();
    const currentUser = config.users.find((entry) => safeEqual(entry.username, sessionUsername));
    if (!currentUser) {
        throw new Error('session_stale');
    }

    const requestedUsername = String(
        nextUsername === undefined || nextUsername === null ? currentUser.username : nextUsername
    ).trim();
    if (!requestedUsername) {
        throw new Error('username_required');
    }

    if (!verifyPasswordHash(normalizedCurrentPassword, currentUser.passwordHash)) {
        throw new Error('invalid_credentials');
    }

    const normalizedNextPassword = String(nextPassword || '');
    const usernameChanged = !safeEqual(requestedUsername, currentUser.username);
    const passwordChanged = normalizedNextPassword.length > 0;

    if (!usernameChanged && !passwordChanged) {
        throw new Error('no_changes_requested');
    }

    if (usernameChanged && config.users.some((entry) => !safeEqual(entry.username, currentUser.username) && safeEqual(entry.username, requestedUsername))) {
        throw new Error('username_taken');
    }

    const nextUsers = config.users.map((entry) => {
        if (!safeEqual(entry.username, currentUser.username)) {
            return entry;
        }
        const nextRecord = {
            ...entry,
            username: requestedUsername,
            id: String(entry.id || `local:${requestedUsername}`).trim() || `local:${requestedUsername}`,
            name: safeEqual(String(entry.name || '').trim(), currentUser.username) ? requestedUsername : entry.name
        };
        if (safeEqual(String(nextRecord.id || '').trim(), `local:${currentUser.username}`)) {
            nextRecord.id = `local:${requestedUsername}`;
        }
        if (passwordChanged) {
            nextRecord.passwordHash = hashPassword(normalizedNextPassword);
            nextRecord.rev = (Number(entry.rev) || 1) + 1;
        }
        return nextRecord;
    });

    writeLocalAuthUsers(config.usersVar, nextUsers);

    revokeSessionsForLocalPolicy(policy);

    return {
        username: requestedUsername,
        usernameChanged,
        passwordChanged
    };
}

function getSessionCookieMaxAge() {
    return SESSION_TTL_SECONDS;
}

function listLocalAuthUsers(policy = {}) {
    const config = resolveLocalAuthConfig(policy);
    if (!config.usersVar || !config.users.length) {
        return [];
    }
    return config.users.map((entry) => serializeUserSummary(entry));
}

function countAdmins(users = []) {
    return users.filter((entry) => isLocalAdminUser(entry)).length;
}

function assertAdminWillRemain(users = []) {
    if (countAdmins(users) < 1) {
        throw new Error('last_admin_required');
    }
}

function createLocalAuthUser({
    policy,
    username,
    password,
    name = '',
    email = '',
    roles
} = {}) {
    const config = resolveLocalAuthConfig(policy);
    if (!config.usersVar) {
        throw new Error('local_auth_not_configured');
    }
    const normalizedUsername = String(username || '').trim();
    const normalizedPassword = String(password || '');
    if (!normalizedUsername) {
        throw new Error('username_required');
    }
    if (!normalizedPassword) {
        throw new Error('password_required');
    }
    if (roles !== undefined && !Array.isArray(roles)) {
        throw new Error('roles_must_be_array');
    }
    if (config.users.some((entry) => safeEqual(entry.username, normalizedUsername))) {
        throw new Error('username_taken');
    }
    const nextUser = normalizeLocalUserRecord({
        id: `local:${normalizedUsername}`,
        username: normalizedUsername,
        name: String(name || normalizedUsername).trim() || normalizedUsername,
        email: String(email || '').trim() || null,
        passwordHash: hashPassword(normalizedPassword),
        roles: normalizeRoles(Array.isArray(roles) ? roles : []),
        rev: 1
    });
    const nextUsers = [...config.users, nextUser];
    writeLocalAuthUsers(config.usersVar, nextUsers);
    return serializeUserSummary(nextUser);
}

function updateLocalAuthUser({
    policy,
    id,
    username,
    password,
    name,
    email,
    roles
} = {}) {
    const config = resolveLocalAuthConfig(policy);
    if (!config.usersVar || !config.users.length) {
        throw new Error('local_auth_not_configured');
    }
    const targetId = String(id || '').trim();
    if (!targetId) {
        throw new Error('user_id_required');
    }
    const index = config.users.findIndex((entry) => safeEqual(entry.id, targetId));
    if (index < 0) {
        throw new Error('user_not_found');
    }
    const currentUser = config.users[index];
    const nextRecord = { ...currentUser };
    let changed = false;

    if (username !== undefined) {
        const nextUsername = String(username || '').trim();
        if (!nextUsername) {
            throw new Error('username_required');
        }
        if (!safeEqual(nextUsername, currentUser.username)
            && config.users.some((entry) => !safeEqual(entry.id, targetId) && safeEqual(entry.username, nextUsername))) {
            throw new Error('username_taken');
        }
        if (!safeEqual(nextUsername, nextRecord.username)) {
            if (safeEqual(nextRecord.id, `local:${nextRecord.username}`)) {
                nextRecord.id = `local:${nextUsername}`;
            }
            nextRecord.username = nextUsername;
            if (safeEqual(String(nextRecord.name || '').trim(), currentUser.username)) {
                nextRecord.name = nextUsername;
            }
            changed = true;
        }
    }

    if (name !== undefined) {
        const nextName = String(name || '').trim() || nextRecord.username;
        if (!safeEqual(nextName, nextRecord.name)) {
            nextRecord.name = nextName;
            changed = true;
        }
    }

    if (email !== undefined) {
        const nextEmail = String(email || '').trim() || null;
        if (!safeEqual(nextEmail || '', nextRecord.email || '')) {
            nextRecord.email = nextEmail;
            changed = true;
        }
    }

    if (roles !== undefined) {
        if (!Array.isArray(roles)) {
            throw new Error('roles_must_be_array');
        }
        const nextRoles = normalizeRoles(roles);
        const currentRoles = normalizeRoles(nextRecord.roles);
        if (JSON.stringify(nextRoles) !== JSON.stringify(currentRoles)) {
            nextRecord.roles = nextRoles;
            changed = true;
        }
    }

    if (password !== undefined) {
        const nextPassword = String(password || '');
        if (!nextPassword) {
            throw new Error('password_required');
        }
        nextRecord.passwordHash = hashPassword(nextPassword);
        changed = true;
    }

    if (!changed) {
        throw new Error('no_changes_requested');
    }

    nextRecord.rev = (Number(currentUser.rev) || 1) + 1;
    const nextUsers = config.users.map((entry, entryIndex) => entryIndex === index ? nextRecord : entry);
    assertAdminWillRemain(nextUsers);
    writeLocalAuthUsers(config.usersVar, nextUsers);
    return serializeUserSummary(nextRecord);
}

function deleteLocalAuthUser({ policy, id } = {}) {
    const config = resolveLocalAuthConfig(policy);
    if (!config.usersVar || !config.users.length) {
        throw new Error('local_auth_not_configured');
    }
    const targetId = String(id || '').trim();
    if (!targetId) {
        throw new Error('user_id_required');
    }
    const target = config.users.find((entry) => safeEqual(entry.id, targetId));
    if (!target) {
        throw new Error('user_not_found');
    }
    const nextUsers = config.users.filter((entry) => !safeEqual(entry.id, targetId));
    assertAdminWillRemain(nextUsers);
    writeLocalAuthUsers(config.usersVar, nextUsers);
    return serializeUserSummary(target);
}

export {
    authenticateLocalUser,
    createLocalAuthUser,
    createExternalSession,
    deleteLocalAuthUser,
    GUEST_SESSION_TTL_SECONDS,
    getSession,
    getSessionCookieMaxAge,
    isLocalAdminUser,
    listLocalAuthUsers,
    mintGuestSessionJwt,
    mintSessionJwt,
    resolveLocalAuthConfig,
    resolveUserRev,
    revokeSession,
    revokeSessionsForLocalPolicy,
    updateLocalAuthUser,
    updateLocalCredentials,
    verifySessionJwt
};
