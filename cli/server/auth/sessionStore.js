import { randomId } from './utils.js';

const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;

function createSessionStore({ sessionTtlMs = DEFAULT_SESSION_TTL_MS, pendingTtlMs = DEFAULT_PENDING_TTL_MS } = {}) {
    const sessions = new Map();
    const pending = new Map();

    function cleanupPending() {
        const now = Date.now();
        for (const [state, entry] of pending.entries()) {
            if (now - entry.createdAt > pendingTtlMs) {
                pending.delete(state);
            }
        }
    }

    function cleanupSessions() {
        const now = Date.now();
        for (const [sid, session] of sessions.entries()) {
            if (session.expiresAt && now > session.expiresAt) {
                sessions.delete(sid);
            }
        }
    }

    function createPendingAuth(data) {
        cleanupPending();
        const state = randomId(16);
        pending.set(state, { ...data, createdAt: Date.now() });
        return state;
    }

    function consumePendingAuth(state) {
        cleanupPending();
        const entry = pending.get(state);
        if (!entry) return null;
        pending.delete(state);
        if (Date.now() - entry.createdAt > pendingTtlMs) return null;
        return entry;
    }

    function createSession(record) {
        cleanupSessions();
        const sid = randomId(24);
        const now = Date.now();
        const expiresAt = record.expiresAt || (now + sessionTtlMs);
        const session = {
            ...record,
            id: sid,
            user: record.user,
            tokens: record.tokens,
            createdAt: now,
            updatedAt: now,
            expiresAt,
            refreshExpiresAt: record.refreshExpiresAt || null
        };
        sessions.set(sid, session);
        return { id: sid, session };
    }

    function getSession(sessionId) {
        if (!sessionId) return null;
        cleanupSessions();
        const session = sessions.get(sessionId);
        if (!session) return null;
        if (session.expiresAt && Date.now() > session.expiresAt) {
            sessions.delete(sessionId);
            return null;
        }
        session.updatedAt = Date.now();
        return session;
    }

    function updateSession(sessionId, updates) {
        const session = getSession(sessionId);
        if (!session) return null;
        if (updates.tokens) {
            session.tokens = { ...session.tokens, ...updates.tokens };
        }
        if (updates.expiresAt) {
            session.expiresAt = updates.expiresAt;
        }
        if (updates.refreshExpiresAt !== undefined) {
            session.refreshExpiresAt = updates.refreshExpiresAt;
        }
        if (updates.user && typeof updates.user === 'object') {
            session.user = updates.user;
        }
        if (updates.providerSession && typeof updates.providerSession === 'object') {
            session.providerSession = updates.providerSession;
        }
        session.updatedAt = Date.now();
        sessions.set(sessionId, session);
        return session;
    }

    function deleteSession(sessionId) {
        if (!sessionId) return;
        sessions.delete(sessionId);
    }

    function deleteSessionsWhere(predicate) {
        if (typeof predicate !== 'function') return;
        cleanupSessions();
        for (const [sessionId, session] of sessions.entries()) {
            if (predicate(session, sessionId)) {
                sessions.delete(sessionId);
            }
        }
    }

    function getAllSessions() {
        cleanupSessions();
        return Array.from(sessions.values());
    }

    return {
        sessionTtlMs,
        pendingTtlMs,
        createPendingAuth,
        consumePendingAuth,
        createSession,
        getSession,
        updateSession,
        deleteSession,
        deleteSessionsWhere,
        getAllSessions
    };
}

export { createSessionStore };
