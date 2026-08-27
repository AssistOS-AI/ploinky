import crypto from 'node:crypto';

import { buildShellEnvironment } from '../../../core-services/webtty/environment.mjs';
import { WEBTTY_PROTOCOL_LIMITS } from '../../../core-services/webtty/worker-protocol.mjs';
import {
    createBrowserSessionLease,
    requestMatchesBrowserSessionLease,
    subscribeToBrowserSessionInvalidation,
    validateBrowserSessionLease,
} from './authLease.mjs';
import { RuntimeRecordStore } from './runtimeRecords.mjs';
import { WebttyWorkerClient } from './workerClient.mjs';

const DEFAULT_AUTH_ADAPTER = Object.freeze({
    createLease: createBrowserSessionLease,
    requestMatchesLease: requestMatchesBrowserSessionLease,
    subscribeInvalidation: subscribeToBrowserSessionInvalidation,
    validateLease: validateBrowserSessionLease,
});

export const WEBTTY_SESSION_LIMITS = Object.freeze({
    global: 12,
    perUser: 6,
    perAuthSession: 3,
    createWindowMs: 60_000,
    createsPerWindow: 5,
    inputWindowMs: 10_000,
    inputBytesPerWindow: 512 * 1024,
    outputReplayBytes: 1024 * 1024,
    outputReplayEvents: 512,
    sseWritableBytes: 256 * 1024,
    idleLifetimeMs: 10 * 60_000,
    absoluteLifetimeMs: 60 * 60_000,
    authenticationIntervalMs: 5_000,
    streamDetachGraceMs: 15_000,
    tombstoneLifetimeMs: 5 * 60_000,
    maxTombstones: 256,
});

function randomId(bytes = 24) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function routeBinding(routePlan) {
    const host = String(routePlan?.host || routePlan?.hostSelection?.host || '').trim();
    const hostRouteKey = String(routePlan?.hostSelection?.record?.routeKey || 'control').trim() || 'control';
    const generation = String(routePlan?.lease?.id || '').trim();
    const activationId = String(routePlan?.lease?.activationId || '').trim();
    if (!host || !generation || !activationId) {
        const error = new Error('current route-generation binding is required');
        error.code = 'WEBTTY_ROUTE_BINDING_REQUIRED';
        throw error;
    }
    return Object.freeze({ host, hostRouteKey, generation, activationId });
}

function bindingMatches(left, right) {
    return left.host === right.host
        && left.hostRouteKey === right.hostRouteKey
        && left.generation === right.generation
        && left.activationId === right.activationId;
}

function errorWithCode(code, message = code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

export class WebttySessionManager {
    constructor({
        limits = WEBTTY_SESSION_LIMITS,
        workerFactory = (options) => new WebttyWorkerClient(options),
        recordStore = new RuntimeRecordStore({
            directory: process.env.PLOINKY_WEBTTY_RUNTIME_DIR || undefined,
        }),
        auth = DEFAULT_AUTH_ADAPTER,
        now = () => Date.now(),
        audit = () => {},
    } = {}) {
        this.limits = Object.freeze({ ...WEBTTY_SESSION_LIMITS, ...limits });
        this.workerFactory = workerFactory;
        this.recordStore = recordStore;
        this.auth = Object.freeze({ ...DEFAULT_AUTH_ADAPTER, ...auth });
        this.now = now;
        this.audit = audit;
        this.routerEpoch = randomId(18);
        this.sessions = new Map();
        this.tombstones = new Map();
        this.userCounts = new Map();
        this.authCounts = new Map();
        this.creationRates = new Map();
        this.ready = false;
        this.disabledCategory = 'initializing';
        this.closed = false;
        this.leaseTimer = null;
    }

    async initialize() {
        const recovery = await this.recordStore.recover();
        this.ready = recovery.ok === true;
        this.disabledCategory = recovery.ok ? '' : String(recovery.category || 'recovery_unproven');
        if (!this.ready) this.audit('webtty_recovery_unproven', { category: this.disabledCategory });
        this.leaseTimer = setInterval(
            () => { void this.validateLiveSessions(); },
            this.limits.authenticationIntervalMs,
        );
        this.leaseTimer.unref?.();
        return recovery;
    }

    availability() {
        return this.ready && !this.closed
            ? { ok: true }
            : { ok: false, category: this.disabledCategory || (this.closed ? 'shutting_down' : 'unavailable') };
    }

    activeCount() {
        return this.sessions.size;
    }

    cleanupRates(now = this.now()) {
        for (const [key, values] of this.creationRates) {
            const retained = values.filter((time) => now - time < this.limits.createWindowMs);
            if (retained.length) this.creationRates.set(key, retained);
            else this.creationRates.delete(key);
        }
    }

    reserveQuota(lease) {
        if (!this.availability().ok) throw errorWithCode('WEBTTY_UNAVAILABLE');
        const now = this.now();
        this.cleanupRates(now);
        const userCount = this.userCounts.get(lease.userId) || 0;
        const authCount = this.authCounts.get(lease.sessionFingerprint) || 0;
        if (this.sessions.size >= this.limits.global) throw errorWithCode('WEBTTY_GLOBAL_QUOTA');
        if (userCount >= this.limits.perUser) throw errorWithCode('WEBTTY_USER_QUOTA');
        if (authCount >= this.limits.perAuthSession) throw errorWithCode('WEBTTY_SESSION_QUOTA');
        const creations = this.creationRates.get(lease.sessionFingerprint) || [];
        if (creations.length >= this.limits.createsPerWindow) throw errorWithCode('WEBTTY_CREATION_RATE');
        creations.push(now);
        this.creationRates.set(lease.sessionFingerprint, creations);
        this.userCounts.set(lease.userId, userCount + 1);
        this.authCounts.set(lease.sessionFingerprint, authCount + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const nextUser = Math.max(0, (this.userCounts.get(lease.userId) || 1) - 1);
            const nextAuth = Math.max(0, (this.authCounts.get(lease.sessionFingerprint) || 1) - 1);
            if (nextUser) this.userCounts.set(lease.userId, nextUser); else this.userCounts.delete(lease.userId);
            if (nextAuth) this.authCounts.set(lease.sessionFingerprint, nextAuth); else this.authCounts.delete(lease.sessionFingerprint);
        };
    }

    async create({ req, routePlan, cwdRelative, cols = 80, rows = 24 }) {
        const lease = this.auth.createLease(req);
        const currentAuth = await this.auth.validateLease(lease);
        if (!currentAuth.ok) {
            throw errorWithCode(
                currentAuth.reason === 'administrator_revoked'
                    ? 'WEBTTY_ADMIN_REQUIRED'
                    : 'WEBTTY_AUTH_INVALID',
            );
        }
        const binding = routeBinding(routePlan);
        if (routePlan?.lease?.commit?.() !== true) throw errorWithCode('WEBTTY_GENERATION_CHANGED');
        const releaseQuota = this.reserveQuota(lease);
        const id = randomId();
        const marker = randomId(32);
        const createdAt = this.now();
        let worker;
        try {
            worker = this.workerFactory({ terminalId: id, marker });
        } catch (error) {
            releaseQuota();
            throw error;
        }
        const session = {
            id,
            marker,
            routerEpoch: this.routerEpoch,
            lease,
            binding,
            routeLease: routePlan.lease,
            cwdRelative,
            createdAt,
            lastActivityAt: createdAt,
            worker,
            recordHandle: null,
            releaseQuota,
            released: false,
            closed: false,
            closing: false,
            closeReason: '',
            stream: null,
            replay: [],
            replayBytes: 0,
            lastSequence: 0,
            inputWindowStartedAt: createdAt,
            inputWindowBytes: 0,
            unsubscribeAuth: null,
            detachTimer: null,
            preserveRecord: false,
            terminalCleanupProven: false,
            initRequested: false,
        };
        this.sessions.set(id, session);
        session.unsubscribeAuth = this.auth.subscribeInvalidation(lease, (reason) => {
            void this.closeSession(session, `auth_${reason}`);
        });
        worker.on('output', (message) => this.onOutput(session, message));
        worker.on('terminal-exit', (message) => {
            session.terminalCleanupProven = true;
            void this.closeSession(session, `terminal_${message.category || 'exit'}`);
        });
        worker.on('process-exit', (message) => { void this.closeSession(session, `worker_${message.category || 'exit'}`, { workerExited: true }); });
        worker.on('terminal-error', (message) => {
            const unproven = message.category === 'cleanup-unproven';
            if (unproven) {
                session.preserveRecord = true;
                this.disableForUnprovenCleanup(message.category, session);
                void this.persistUnprovenCleanup(session).finally(() => (
                    this.closeSession(session, `worker_${message.category}`, { preserveRecord: true })
                ));
                return;
            }
            void this.closeSession(session, `worker_${message.category || 'error'}`);
        });
        worker.on('error-category', (message) => { void this.closeSession(session, `worker_${message.category || 'error'}`); });
        try {
            const workerIdentity = await worker.spawn();
            session.recordHandle = await this.recordStore.create({
                routerEpoch: this.routerEpoch,
                marker,
                worker: {
                    pid: workerIdentity.pid,
                    startToken: workerIdentity.startToken,
                    uid: workerIdentity.uid,
                },
            });
            const markedStarting = await this.recordStore.markPtyStarting(session.recordHandle);
            if (markedStarting !== true) throw errorWithCode('WEBTTY_RECOVERY_STATE_INVALID');
            session.initRequested = true;
            const ready = await worker.start({
                cwdRelative,
                cols,
                rows,
                shellEnv: buildShellEnvironment(),
            });
            const identity = ready.processIdentity;
            await this.recordStore.update(session.recordHandle, {
                ...session.recordHandle.record,
                pty: {
                    pid: identity.pid,
                    startToken: identity.startToken,
                    uid: workerIdentity.uid,
                    pgrp: identity.processGroupId,
                    session: identity.sessionId,
                },
                ptyState: 'pty-ready',
            });
            this.scheduleDetachedClose(session, 'stream_never_attached');
            this.audit('webtty_session_created', {
                id: this.auditId(id),
            });
            return { id, cwd: cwdRelative || '.', cols, rows };
        } catch (error) {
            await this.closeSession(session, 'create_failed');
            throw error;
        }
    }

    auditId(id) {
        return crypto.createHash('sha256').update(this.routerEpoch).update(String(id)).digest('hex').slice(0, 16);
    }

    async validateOwnership(req, routePlan, id, { validateAuth = true } = {}) {
        const session = this.sessions.get(String(id || ''));
        if (!session || session.closed || session.routerEpoch !== this.routerEpoch) return null;
        if (!this.auth.requestMatchesLease(req, session.lease)) return null;
        let binding;
        try { binding = routeBinding(routePlan); } catch (_) { return null; }
        if (!bindingMatches(binding, session.binding)) return null;
        if (session.routeLease?.isCurrent?.() !== true || routePlan?.lease?.commit?.() !== true) {
            await this.closeSession(session, 'route_generation_changed');
            return null;
        }
        if (validateAuth) {
            const result = await this.auth.validateLease(session.lease);
            if (!result.ok) {
                await this.closeSession(session, `auth_${result.reason}`);
                return null;
            }
        }
        return session;
    }

    touch(session) {
        session.lastActivityAt = this.now();
    }

    async input(session, data) {
        if (!session || session.closed || session.closing) throw errorWithCode('WEBTTY_SESSION_NOT_FOUND');
        const bytes = Buffer.byteLength(data, 'utf8');
        if (!bytes || bytes > WEBTTY_PROTOCOL_LIMITS.maxInputBytes) throw errorWithCode('WEBTTY_INPUT_INVALID');
        const now = this.now();
        if (now - session.inputWindowStartedAt >= this.limits.inputWindowMs) {
            session.inputWindowStartedAt = now;
            session.inputWindowBytes = 0;
        }
        if (session.inputWindowBytes + bytes > this.limits.inputBytesPerWindow) {
            await this.closeSession(session, 'input_rate_limit');
            throw errorWithCode('WEBTTY_INPUT_RATE');
        }
        session.inputWindowBytes += bytes;
        await session.worker.input(data);
        this.touch(session);
    }

    async resize(session, cols, rows) {
        if (!session || session.closed || session.closing) throw errorWithCode('WEBTTY_SESSION_NOT_FOUND');
        await session.worker.resize(cols, rows);
        this.touch(session);
    }

    encodeSse(event, data, id = null) {
        return `${id == null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    writeStream(session, bytes) {
        const stream = session.stream;
        if (!stream || stream.writableEnded || stream.destroyed) return true;
        if (Number(stream.writableLength || 0) + Buffer.byteLength(bytes) > this.limits.sseWritableBytes) {
            void this.closeSession(session, 'sse_backpressure');
            return false;
        }
        if (stream.write(bytes) === false && Number(stream.writableLength || 0) > this.limits.sseWritableBytes) {
            void this.closeSession(session, 'sse_backpressure');
            return false;
        }
        return true;
    }

    onOutput(session, message) {
        if (!session || session.closed || session.closing) return;
        if (message.sequence !== session.lastSequence + 1) {
            void this.closeSession(session, 'output_sequence');
            return;
        }
        const encoded = this.encodeSse('output', { data: message.data }, message.sequence);
        const bytes = Buffer.byteLength(encoded);
        if (bytes > this.limits.outputReplayBytes) {
            void this.closeSession(session, 'output_limit');
            return;
        }
        session.lastSequence = message.sequence;
        session.replay.push({ sequence: message.sequence, encoded, bytes });
        session.replayBytes += bytes;
        while (session.replay.length > this.limits.outputReplayEvents
            || session.replayBytes > this.limits.outputReplayBytes) {
            const removed = session.replay.shift();
            session.replayBytes -= removed.bytes;
        }
        this.writeStream(session, encoded);
    }

    attachStream(session, req, res, lastEventId = '') {
        if (!session || session.closed || session.closing) return false;
        const raw = String(lastEventId || '').trim();
        const requested = raw === '' ? 0 : Number(raw);
        const oldest = session.replay[0]?.sequence || (session.lastSequence + 1);
        if (!Number.isSafeInteger(requested) || requested < 0
            || requested > session.lastSequence
            || requested < oldest - 1) {
            res.write(this.encodeSse('reset', { reason: 'replay_gap' }));
            res.end();
            return false;
        }
        if (session.stream && session.stream !== res && !session.stream.writableEnded) {
            try { session.stream.write(this.encodeSse('replaced', {})); } catch (_) { }
            try { session.stream.end(); } catch (_) { }
        }
        clearTimeout(session.detachTimer);
        session.detachTimer = null;
        session.stream = res;
        res.write(': connected\n\n');
        for (const event of session.replay) {
            if (event.sequence > requested && !this.writeStream(session, event.encoded)) break;
        }
        this.touch(session);
        req.once('close', () => {
            if (session.stream === res) {
                session.stream = null;
                this.scheduleDetachedClose(session, 'browser_stream_closed');
            }
        });
        return true;
    }

    scheduleDetachedClose(session, reason) {
        clearTimeout(session.detachTimer);
        session.detachTimer = setTimeout(() => {
            session.detachTimer = null;
            if (!session.stream) void this.closeSession(session, reason);
        }, this.limits.streamDetachGraceMs);
        session.detachTimer.unref?.();
    }

    addTombstone(session) {
        const now = this.now();
        this.tombstones.set(session.id, {
            expiresAt: now + this.limits.tombstoneLifetimeMs,
            sessionFingerprint: session.lease.sessionFingerprint,
            userId: session.lease.userId,
            binding: session.binding,
        });
        while (this.tombstones.size > this.limits.maxTombstones) {
            this.tombstones.delete(this.tombstones.keys().next().value);
        }
    }

    matchesTombstone(req, routePlan, id) {
        const tombstone = this.tombstones.get(String(id || ''));
        if (!tombstone) return false;
        if (this.now() > tombstone.expiresAt) {
            this.tombstones.delete(String(id || ''));
            return false;
        }
        const requestBinding = routeBinding(routePlan);
        const requestSession = this.auth.createLease(req);
        return tombstone.userId === requestSession.userId
            && tombstone.sessionFingerprint === requestSession.sessionFingerprint
            && bindingMatches(tombstone.binding, requestBinding);
    }

    disableForUnprovenCleanup(category = 'cleanup_unproven', primarySession = null) {
        this.ready = false;
        this.disabledCategory = String(category || 'cleanup_unproven');
        this.audit('webtty_cleanup_unproven', { category: this.disabledCategory });
        queueMicrotask(() => {
            void Promise.allSettled([...this.sessions.values()].map((session) => (
                session === primarySession || session.closed || session.closing
                    ? Promise.resolve()
                    : this.closeSession(session, 'webtty_quiesced_after_unproven_cleanup')
            )));
        });
    }

    async persistUnprovenCleanup(session) {
        if (!session?.recordHandle) return false;
        try {
            return await this.recordStore.markCleanupUnproven(session.recordHandle);
        } catch (_) {
            this.audit('webtty_cleanup_record_failed', { category: 'cleanup_unproven' });
            return false;
        }
    }

    async closeSession(sessionOrId, reason = 'requested', {
        workerExited = false,
        preserveRecord = false,
    } = {}) {
        const session = typeof sessionOrId === 'string' ? this.sessions.get(sessionOrId) : sessionOrId;
        if (!session || session.closed || session.closing) return Boolean(session);
        session.closing = true;
        session.closeReason = reason;
        this.sessions.delete(session.id);
        this.addTombstone(session);
        session.unsubscribeAuth?.();
        session.unsubscribeAuth = null;
        clearTimeout(session.detachTimer);
        session.detachTimer = null;
        if (session.stream && !session.stream.writableEnded) {
            try { session.stream.write(this.encodeSse('exit', { reason })); } catch (_) { }
            try { session.stream.end(); } catch (_) { }
        }
        session.stream = null;
        if (!workerExited) {
            try { await session.worker.close(); } catch (_) { }
        }
        const exited = workerExited || await session.worker.waitForExit();
        const cleanupProven = session.terminalCleanupProven === true;
        const mustPreserve = preserveRecord || session.preserveRecord || !cleanupProven;
        if (!exited) {
            session.preserveRecord = true;
            this.disableForUnprovenCleanup('worker_exit_unconfirmed', session);
        } else if ((session.recordHandle || session.initRequested) && mustPreserve) {
            const category = session.preserveRecord && this.disabledCategory
                ? this.disabledCategory
                : 'terminal_cleanup_unproven';
            session.preserveRecord = true;
            this.disableForUnprovenCleanup(category, session);
        } else if (session.recordHandle) {
            try {
                const removed = await this.recordStore.remove(session.recordHandle);
                if (removed !== true) {
                    session.preserveRecord = true;
                    this.disableForUnprovenCleanup('recovery_record_remove_unconfirmed', session);
                }
            } catch (_) {
                session.preserveRecord = true;
                this.disableForUnprovenCleanup('recovery_record_remove_failed', session);
            }
        }
        session.closed = true;
        session.closing = false;
        if (!session.released) {
            session.released = true;
            session.releaseQuota();
        }
        this.audit('webtty_session_closed', {
            id: this.auditId(session.id),
            reason,
            durationMs: Math.max(0, this.now() - session.createdAt),
        });
        return true;
    }

    async closeOwned(req, routePlan, id) {
        const session = await this.validateOwnership(req, routePlan, id);
        if (session) return this.closeSession(session, 'requested');
        try { return this.matchesTombstone(req, routePlan, id); } catch (_) { return false; }
    }

    async validateLiveSessions() {
        if (this.closed) return;
        const now = this.now();
        await Promise.allSettled([...this.sessions.values()].map(async (session) => {
            if (session.routeLease?.isCurrent?.() !== true) {
                await this.closeSession(session, 'route_generation_changed');
                return;
            }
            if (now - session.createdAt >= this.limits.absoluteLifetimeMs) {
                await this.closeSession(session, 'absolute_timeout');
                return;
            }
            if (now - session.lastActivityAt >= this.limits.idleLifetimeMs) {
                await this.closeSession(session, 'idle_timeout');
                return;
            }
            const auth = await this.auth.validateLease(session.lease);
            if (!auth.ok) await this.closeSession(session, `auth_${auth.reason}`);
        }));
    }

    async closeAll(reason = 'router_shutdown') {
        if (this.closed) return;
        this.closed = true;
        this.ready = false;
        this.disabledCategory = 'shutting_down';
        clearInterval(this.leaseTimer);
        await Promise.allSettled([...this.sessions.values()].map((session) => (
            this.closeSession(session, reason)
        )));
    }
}

export default WebttySessionManager;
