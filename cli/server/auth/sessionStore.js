import { randomId } from './utils.js';
import {
    ABSENT_FILE_DIGEST,
    createSessionFile,
    decodeSessionsFile,
    defaultDeriveSessionsKey,
    digestBytes,
    encodeSessionsFile,
    hashSessionId,
    SSO_SESSIONS_DEFAULT_MAX_FILE_BYTES,
    SSO_SESSIONS_FILE_VERSION,
} from './sessionPersistence.js';

const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FLUSH_DELAY_MS = 30 * 1000;
const REPAIR_INTERVAL_MS = 1000;
const REPAIR_TIMED_ATTEMPTS = 30;
// The file content is not known (a rejected file that could not be read or
// removed); the write guard then cannot compare and lets the next write
// replace whatever is there.
const UNKNOWN_FILE_DIGEST = 'unknown';
const SESSION_KEY = /^[a-f0-9]{64}$/;

export const SSO_SESSION_STORE_UNAVAILABLE = 'SSO_SESSION_STORE_UNAVAILABLE';

function storeUnavailableError() {
    const error = new Error('SSO session store is not available');
    error.code = SSO_SESSION_STORE_UNAVAILABLE;
    return error;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function errorCode(error) {
    return String(error?.reason || error?.code || 'unknown');
}

// A record restored from the file, built once so later identity comparisons
// by the bridge hold for the whole process lifetime.
function restoreRecord(key, entry, now) {
    if (!SESSION_KEY.test(key) || !isPlainObject(entry)) return null;
    const user = entry.user;
    if (!isPlainObject(user) || typeof user.id !== 'string' || !user.id) return null;
    if (typeof entry.providerAgent !== 'string' || !entry.providerAgent.trim()) return null;
    if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) return null;
    const record = {
        providerAgent: entry.providerAgent,
        user,
        tokens: isPlainObject(entry.tokens) ? entry.tokens : {},
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : now,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : now,
        expiresAt: entry.expiresAt,
        refreshExpiresAt: entry.refreshExpiresAt ?? null,
    };
    if (isPlainObject(entry.providerSession)) record.providerSession = entry.providerSession;
    return record;
}

/**
 * States: `memory` (default; never touches the disk), `unopened` (persistence
 * configured, file not read yet), `open` and `closed`. Transitions are one-way.
 * Only `memory` and `open` serve sessions; in the other two, lookups find
 * nothing and mutations throw SSO_SESSION_STORE_UNAVAILABLE, so the bridge can
 * answer "undecided" instead of a refusal that would clear the browser cookie.
 *
 * Sessions are keyed by hashSessionId(cookie value) in memory and on disk.
 */
function createSessionStore({
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    pendingTtlMs = DEFAULT_PENDING_TTL_MS,
    now: nowOption,
    persistence,
} = {}) {
    // Evaluated per call: tests replace Date.now.
    const clock = typeof nowOption === 'function' ? nowOption : () => Date.now();
    const sessions = new Map();
    const pending = new Map();
    let sweepIterator = null;
    let state = 'memory';
    let persist = null;
    let knownDigest = ABSENT_FILE_DIGEST;
    let dirty = false;
    let flushTimer = null;
    let repair = null;
    let repairTimer = null;
    let repairAttempts = 0;

    function usable() {
        return state === 'memory' || state === 'open';
    }

    function emit(event, fields = {}) {
        try { persist?.log(event, fields); } catch (_) { }
    }

    function sweepStep(limit) {
        const now = clock();
        if (!sweepIterator) sweepIterator = sessions.entries();
        for (let examined = 0; examined < limit; examined += 1) {
            let next = sweepIterator.next();
            if (next.done) {
                sweepIterator = sessions.entries();
                next = sweepIterator.next();
                if (next.done) break;
            }
            const [key, session] = next.value;
            if (session.expiresAt && now > session.expiresAt) {
                sessions.delete(key);
                markDirty();
            }
        }
    }

    function cleanupPending() {
        const now = Date.now();
        for (const [state, entry] of pending.entries()) {
            if (now - entry.createdAt > pendingTtlMs) {
                pending.delete(state);
            }
        }
    }

    function cleanupSessions() {
        const now = clock();
        for (const [key, session] of sessions.entries()) {
            if (session.expiresAt && now > session.expiresAt) {
                sessions.delete(key);
                markDirty();
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

    // ---- persistence -------------------------------------------------------

    function snapshotPayload() {
        const now = clock();
        const out = {};
        // Expired entries are omitted; load drops them again anyway.
        for (const [key, session] of sessions) {
            const expiresAt = session.expiresAt;
            if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
            out[key] = {
                providerAgent: session.providerAgent,
                user: session.user,
                tokens: session.tokens,
                providerSession: session.providerSession,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                expiresAt,
                refreshExpiresAt: session.refreshExpiresAt ?? null,
            };
        }
        return { version: SSO_SESSIONS_FILE_VERSION, savedAt: now, sessions: out };
    }

    function clearFlushTimer() {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
    }

    function armFlushTimer() {
        if (flushTimer || state !== 'open') return;
        // One trailing timer per batch, not reset by later marks, so a busy
        // session is still written at most flushDelayMs late.
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flush();
        }, persist.flushDelayMs);
        flushTimer.unref?.();
    }

    function clearRepair() {
        repair = null;
        repairAttempts = 0;
        if (repairTimer) clearTimeout(repairTimer);
        repairTimer = null;
    }

    function armRepair() {
        if (repairTimer || !repair || state !== 'open' || repairAttempts >= REPAIR_TIMED_ATTEMPTS) return;
        repairTimer = setTimeout(() => {
            repairTimer = null;
            repairAttempts += 1;
            attemptRepair();
            armRepair();
        }, REPAIR_INTERVAL_MS);
        repairTimer.unref?.();
    }

    // A delete that failed outranks a rejected file: its repair also removes it.
    function scheduleRepair(kind) {
        if (repair !== 'delete') repair = kind;
        repairAttempts = 0;
        if (repairTimer) clearTimeout(repairTimer);
        repairTimer = null;
        armRepair();
    }

    function closeInternal() {
        state = 'closed';
        clearFlushTimer();
        clearRepair();
        dirty = false;
    }

    // Another writer replaced the file since this process last loaded or wrote
    // it. Writing now would bring back sessions that writer removed, so the
    // store stops for good; SSO answers 503 until the Router restarts.
    function tripGuard() {
        emit('sso_session_store_foreign_writer', { level: 'error' });
        closeInternal();
    }

    // 'ok', 'tripped', or 'unverified' when the current bytes cannot be read.
    function checkGuard() {
        let current;
        try {
            current = persist.file.currentDigest();
        } catch (error) {
            return { verdict: 'unverified', error };
        }
        if (knownDigest !== UNKNOWN_FILE_DIGEST && current !== knownDigest) {
            tripGuard();
            return { verdict: 'tripped' };
        }
        return { verdict: 'ok' };
    }

    function writeSnapshot(reason) {
        if (state !== 'open') return { ok: false, tripped: false };
        const guard = checkGuard();
        if (guard.verdict === 'tripped') return { ok: false, tripped: true };
        if (guard.verdict === 'unverified') {
            emit('sso_session_store_write_failed', { reason, code: errorCode(guard.error) });
            return { ok: false, tripped: false };
        }
        try {
            const text = encodeSessionsFile(snapshotPayload(), persist.deriveKey);
            knownDigest = persist.file.replace(text);
        } catch (error) {
            // The rename landed and only the directory fsync failed: the file
            // is ours, so the guard must not mistake it for a foreign write.
            if (error?.renamed === true && error.digest) knownDigest = error.digest;
            emit('sso_session_store_write_failed', { reason, code: errorCode(error) });
            return { ok: false, tripped: false };
        }
        dirty = false;
        clearFlushTimer();
        clearRepair();
        return { ok: true, tripped: false };
    }

    // Durable unlink: needs no free space. 'removed', 'tripped' or 'failed'.
    function unlinkFile() {
        // An unreadable file is still removed: losing sessions is fail closed.
        const guard = checkGuard();
        if (guard.verdict === 'tripped') return { outcome: 'tripped' };
        try {
            persist.file.unlink();
        } catch (error) {
            // Gone but not durably: the guard must still see an absent file.
            if (error?.unlinked === true) knownDigest = ABSENT_FILE_DIGEST;
            return { outcome: 'failed', error };
        }
        knownDigest = ABSENT_FILE_DIGEST;
        return { outcome: 'removed' };
    }

    function attemptRepair() {
        if (!repair || state !== 'open') return;
        if (repair === 'delete') {
            const outcome = writeSnapshot('repair');
            if (outcome.ok || outcome.tripped) return;
        }
        const kind = repair;
        if (unlinkFile().outcome !== 'removed') return;
        clearRepair();
        // After a fallback unlink every session is gone from disk until the
        // next snapshot; schedule one.
        if (kind === 'delete') markDirty();
    }

    function markDirty() {
        if (state !== 'open') return;
        dirty = true;
        if (repair && repairAttempts >= REPAIR_TIMED_ATTEMPTS) attemptRepair();
        if (state === 'open' && dirty) armFlushTimer();
    }

    // Part 6 of the design: replace (one retry), else unlink, else report.
    // Used for every change that removes or shortens authority.
    function persistDelete(reason = 'delete') {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const outcome = writeSnapshot(reason);
            if (outcome.ok) return true;
            // Another writer owns the file; nothing this process writes can
            // make the delete durable there.
            if (outcome.tripped) return false;
        }
        const removal = unlinkFile();
        if (removal.outcome === 'removed') {
            markDirty();
            return true;
        }
        if (removal.outcome === 'tripped') return false;
        emit(reason === 'delete' ? 'sso_session_delete_not_durable' : 'sso_session_expiry_not_durable',
            { level: 'error', code: errorCode(removal.error) });
        scheduleRepair('delete');
        return false;
    }

    function rejectLoad(reason, bytes) {
        sessions.clear();
        emit('sso_session_store_load_rejected', { level: 'error', reason });
        knownDigest = Buffer.isBuffer(bytes) ? digestBytes(bytes) : UNKNOWN_FILE_DIGEST;
        // Removed before the store reports open: a rejected file left behind
        // could revive sessions on a later start, after users were told they
        // were signed out.
        try {
            persist.file.unlink();
            knownDigest = ABSENT_FILE_DIGEST;
        } catch (error) {
            if (error?.unlinked === true) knownDigest = ABSENT_FILE_DIGEST;
            emit('sso_session_store_reject_not_removed', { level: 'error', code: errorCode(error) });
            repair = 'reject';
        }
        return { restored: 0, dropped: 0, rejected: reason, mismatched: 0 };
    }

    function load(providerAgent) {
        const read = persist.file.read();
        if (read.absent) {
            knownDigest = ABSENT_FILE_DIGEST;
            return { restored: 0, dropped: 0, rejected: null, mismatched: 0 };
        }
        let payload;
        try {
            payload = decodeSessionsFile(read.bytes.toString('utf8'), persist.deriveKey);
        } catch (error) {
            return rejectLoad(error?.reason || 'open_failed', read.bytes);
        }
        const now = clock();
        const expected = typeof providerAgent === 'string' ? providerAgent.trim() : '';
        let restored = 0;
        let dropped = 0;
        let mismatched = 0;
        for (const [key, entry] of Object.entries(payload.sessions)) {
            const record = restoreRecord(key, entry, now);
            if (!record) {
                dropped += 1;
                continue;
            }
            // Requirement 5: a session of a different provider agent never
            // returns. An empty expected reference drops nothing.
            if (expected && record.providerAgent !== expected) {
                dropped += 1;
                mismatched += 1;
                continue;
            }
            sessions.set(key, record);
            restored += 1;
        }
        knownDigest = digestBytes(read.bytes);
        return { restored, dropped, rejected: null, mismatched };
    }

    function configurePersistence(config = {}) {
        if (state !== 'memory') throw new Error(`SSO session persistence cannot be configured in state ${state}`);
        if (sessions.size) throw new Error('SSO session persistence must be configured before any session exists');
        const maxFileBytes = positiveInteger(config.maxFileBytes, SSO_SESSIONS_DEFAULT_MAX_FILE_BYTES);
        const file = createSessionFile({ directory: config.directory, fsApi: config.fsApi || undefined, maxFileBytes });
        persist = {
            file,
            deriveKey: typeof config.deriveKey === 'function' ? config.deriveKey : defaultDeriveSessionsKey,
            flushDelayMs: Number.isSafeInteger(config.flushDelayMs) && config.flushDelayMs >= 0
                ? config.flushDelayMs
                : DEFAULT_FLUSH_DELAY_MS,
            log: typeof config.log === 'function' ? config.log : () => { },
        };
        state = 'unopened';
    }

    // Reads the file once. Never throws: any unexpected failure is a rejected
    // load. A load that accepts the file never writes synchronously.
    function open({ providerAgent } = {}) {
        if (state !== 'unopened') return { restored: 0, dropped: 0, rejected: null };
        let result;
        try {
            result = load(providerAgent);
        } catch (error) {
            try {
                result = rejectLoad(error?.reason || 'open_failed', error?.bytes);
            } catch (_) {
                sessions.clear();
                knownDigest = UNKNOWN_FILE_DIGEST;
                repair = 'reject';
                result = { restored: 0, dropped: 0, rejected: 'open_failed', mismatched: 0 };
            }
        }
        state = 'open';
        if (repair) scheduleRepair(repair);
        // Mismatched records leave the file with the next flush.
        if (result.mismatched) markDirty();
        return { restored: result.restored, dropped: result.dropped, rejected: result.rejected };
    }

    function flush() {
        if (state !== 'open') return false;
        if (repair) attemptRepair();
        if (state !== 'open') return false;
        if (!dirty) return true;
        const outcome = writeSnapshot('flush');
        if (!outcome.ok && state === 'open') armFlushTimer();
        return outcome.ok;
    }

    // Synchronous and never throws. Only an open store flushes; `unopened`
    // closes without touching the disk, and `memory` has nothing to close.
    function close() {
        if (state === 'unopened') {
            state = 'closed';
            return;
        }
        if (state !== 'open') return;
        try {
            if (repair) attemptRepair();
            if (state === 'open' && dirty) writeSnapshot('close');
        } catch (_) { }
        closeInternal();
    }

    // ---- sessions ----------------------------------------------------------

    function createSession(record) {
        if (!usable()) throw storeUnavailableError();
        sweepStep(8);
        const sid = randomId(24);
        const key = hashSessionId(sid);
        const now = clock();
        const fields = { ...record };
        // The record never carries the raw cookie value.
        delete fields.id;
        const expiresAt = fields.expiresAt || (now + sessionTtlMs);
        const session = {
            ...fields,
            user: fields.user,
            tokens: fields.tokens,
            createdAt: now,
            updatedAt: now,
            expiresAt,
            refreshExpiresAt: fields.refreshExpiresAt || null
        };
        sessions.set(key, session);
        if (state === 'open') {
            // A lost create only ends the session earlier; the next flush retries.
            const outcome = writeSnapshot('create');
            if (outcome.tripped) {
                sessions.delete(key);
                throw storeUnavailableError();
            }
            if (!outcome.ok) markDirty();
        }
        return { id: sid, session };
    }

    function getSession(sessionId) {
        if (!sessionId || !usable()) return null;
        sweepStep(8);
        const key = hashSessionId(sessionId);
        const session = sessions.get(key);
        if (!session) return null;
        if (session.expiresAt && clock() > session.expiresAt) {
            sessions.delete(key);
            markDirty();
            return null;
        }
        session.updatedAt = clock();
        return session;
    }

    function updateSession(sessionId, updates) {
        const session = getSession(sessionId);
        if (!session) return null;
        const previousExpiresAt = session.expiresAt;
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
        session.updatedAt = clock();
        if (state === 'open') {
            // Disk expiry must never exceed memory expiry: anything but an
            // extension is written before returning; the rest is batched.
            const extendedOrSame = session.expiresAt === previousExpiresAt || session.expiresAt > previousExpiresAt;
            if (extendedOrSame) markDirty();
            else persistDelete('expiry_decrease');
        }
        return session;
    }

    // Returns { existed, persisted }. `persisted` is false only when the
    // deletion could not be made durable.
    function deleteSession(sessionId) {
        if (!usable()) throw storeUnavailableError();
        if (!sessionId) return { existed: false, persisted: true };
        const existed = sessions.delete(hashSessionId(sessionId));
        if (state !== 'open' || !existed) return { existed, persisted: true };
        return { existed, persisted: persistDelete() };
    }

    function deleteSessionsWhere(predicate) {
        if (typeof predicate !== 'function') return { removed: 0, persisted: true };
        if (!usable()) throw storeUnavailableError();
        cleanupSessions();
        let removed = 0;
        for (const [key, session] of sessions.entries()) {
            if (predicate(session, key)) {
                sessions.delete(key);
                removed += 1;
            }
        }
        if (state !== 'open' || !removed) return { removed, persisted: true };
        return { removed, persisted: persistDelete() };
    }

    function getAllSessions() {
        if (!usable()) return [];
        cleanupSessions();
        return Array.from(sessions.values());
    }

    if (persistence) configurePersistence(persistence);

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
        getAllSessions,
        configurePersistence,
        open,
        close,
        flush,
        state: () => state,
        isAvailable: usable,
        __testables: {
            size: () => sessions.size,
            dirty: () => dirty,
            flushArmed: () => flushTimer !== null,
            repairPending: () => repair,
            repairArmed: () => repairTimer !== null,
        },
    };
}

export { createSessionStore };
