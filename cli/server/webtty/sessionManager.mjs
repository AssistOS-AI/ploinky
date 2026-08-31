import crypto from 'node:crypto';

import { buildShellEnvironment } from '../../../core-services/webtty/environment.mjs';
import { WEBTTY_PROTOCOL_LIMITS } from '../../../core-services/webtty/worker-protocol.mjs';
import {
    createBrowserSessionLease,
    requestMatchesBrowserSessionLease,
    subscribeToBrowserSessionInvalidation,
    validateBrowserSessionLease,
} from './authLease.mjs';
import {
    RuntimeRecordStore,
    classifyAgentEvidenceFailure,
} from './runtimeRecords.mjs';
import { AgentWebttyWorkerClient } from './agentWorkerClient.mjs';
import { WebttyLaunchRecordStore } from './launchRecords.mjs';
import {
    TerminalTargetResolver,
    terminalTargetRouteBinding,
} from './terminalTargetResolver.mjs';
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
        agentWorkerFactory = (options) => new AgentWebttyWorkerClient(options),
        recordStore = new RuntimeRecordStore({
            directory: process.env.PLOINKY_WEBTTY_RUNTIME_DIR || undefined,
        }),
        launchStore = new WebttyLaunchRecordStore(),
        targetResolver = null,
        agentProviderAvailable = false,
        auth = DEFAULT_AUTH_ADAPTER,
        now = () => Date.now(),
        audit = () => {},
    } = {}) {
        this.limits = Object.freeze({ ...WEBTTY_SESSION_LIMITS, ...limits });
        this.workerFactory = workerFactory;
        this.agentWorkerFactory = agentWorkerFactory;
        this.recordStore = recordStore;
        this.launchStore = launchStore;
        this.auth = Object.freeze({ ...DEFAULT_AUTH_ADAPTER, ...auth });
        this.now = now;
        this.audit = audit;
        this.routerEpoch = randomId(18);
        this.sessions = new Map();
        this.tombstones = new Map();
        this.userCounts = new Map();
        this.authCounts = new Map();
        this.creationRates = new Map();
        this.launchAuthSubscriptions = new Map();
        this.agentStartLocks = new Map();
        this.inFlightCloses = new Set();
        this.quarantinedAgentTargets = new Map();
        this.quarantinedAgentContainers = new Set();
        this.agentProviderReady = agentProviderAvailable === true;
        this.agentProviderDisabledCategory = this.agentProviderReady ? '' : 'provider_not_local';
        this.targetResolver = targetResolver || new TerminalTargetResolver({
            isTargetQuarantined: (candidate) => this.isAgentTargetQuarantined(candidate),
        });
        this.ready = false;
        this.disabledCategory = 'initializing';
        this.closed = false;
        this.leaseTimer = null;
    }

    async initialize() {
        const recovery = await this.recordStore.recover();
        this.ready = recovery.ok === true;
        this.disabledCategory = recovery.ok ? '' : String(recovery.category || 'recovery_unproven');
        if (recovery.ok && recovery.agentAvailable === false) {
            this.agentProviderReady = false;
            this.agentProviderDisabledCategory = 'recovery_unproven';
        }
        for (const entry of recovery.quarantinedTargets || []) {
            this.quarantineAgentTarget(entry.target, entry.category);
        }
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

    providerAvailability() {
        const surface = this.availability();
        return Object.freeze({
            ...surface,
            boxAvailable: surface.ok,
            agentAvailable: surface.ok && this.agentProviderReady,
        });
    }

    agentTargetKey(target) {
        const containerKey = this.agentStartKey(target);
        const enableGeneration = String(target?.enableGeneration || '');
        return containerKey && enableGeneration
            ? `${containerKey}:${enableGeneration}`
            : '';
    }

    agentStartKey(target) {
        const runtime = String(target?.runtime || '');
        const containerId = String(target?.containerId || '');
        return runtime && containerId ? `${runtime}:${containerId}` : '';
    }

    isAgentTargetQuarantined(target) {
        const key = this.agentTargetKey(target);
        const containerKey = this.agentStartKey(target);
        return Boolean(key && containerKey && (
            this.quarantinedAgentTargets.has(key)
            || this.quarantinedAgentContainers.has(containerKey)
        ));
    }

    quarantineAgentTarget(target, category = 'cleanup_unproven') {
        const key = this.agentTargetKey(target);
        if (!key) {
            this.disableAgentProvider('target_identity_unclassifiable');
            return false;
        }
        this.quarantinedAgentTargets.set(key, String(category || 'cleanup_unproven'));
        // The durable quarantine key carries the complete immutable launch
        // tuple required by the plan. A separate container-identity safety
        // index prevents a suspicious relabel of the same live runtime object
        // from escaping unresolved process/exec cleanup.
        this.quarantinedAgentContainers.add(this.agentStartKey(target));
        this.audit('webtty_agent_target_quarantined', {
            target: this.auditId(key),
            category: String(category || 'cleanup_unproven'),
        });
        return true;
    }

    hasScopedAgentRecoveryRecord(session) {
        const target = session?.target;
        const record = session?.recordHandle?.record;
        const recordedTarget = record?.target;
        if (target?.kind !== 'agent'
            || record?.targetKind !== 'agent'
            || !this.agentTargetKey(recordedTarget)) return false;
        return ['runtime', 'containerId', 'containerName', 'instanceId', 'enableGeneration']
            .every((field) => {
                const recorded = String(recordedTarget[field] || '');
                return Boolean(recorded) && recorded === String(target[field] || '');
            });
    }

    disableForRecordRemovalFailure(session, globalCategory, agentCategory) {
        session.preserveRecord = true;
        if (this.hasScopedAgentRecoveryRecord(session)) {
            this.disableAgentProvider(agentCategory);
        } else {
            // Box records and malformed/unscoped agent evidence cannot be
            // isolated safely, so preserve the existing global fail-closed path.
            this.disableForUnprovenCleanup(globalCategory, session);
        }
    }

    disableAgentProvider(category = 'provider_unavailable') {
        this.agentProviderReady = false;
        this.agentProviderDisabledCategory = String(category || 'provider_unavailable');
        this.audit('webtty_agent_provider_disabled', { category: this.agentProviderDisabledCategory });
        queueMicrotask(() => {
            void Promise.allSettled([...this.sessions.values()]
                .filter((session) => session.target?.kind === 'agent')
                .map((session) => this.closeSession(session, 'agent_provider_disabled')));
        });
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

    async validatedLease(req) {
        const lease = this.auth.createLease(req);
        await this.revalidateLease(lease);
        return lease;
    }

    async revalidateLease(lease) {
        const currentAuth = await this.auth.validateLease(lease);
        if (!currentAuth.ok) {
            throw errorWithCode(
                currentAuth.reason === 'administrator_revoked'
                    ? 'WEBTTY_ADMIN_REQUIRED'
                : 'WEBTTY_AUTH_INVALID',
            );
        }
        return currentAuth;
    }

    launchOwner(lease) {
        return Object.freeze({
            userId: lease.userId,
            sessionFingerprint: lease.sessionFingerprint,
        });
    }

    ensureLaunchInvalidationSubscription(lease) {
        if (this.launchAuthSubscriptions.has(lease.sessionFingerprint)) return;
        let active = true;
        let unsubscribe = null;
        let invalidatedSynchronously = false;
        const subscribed = this.auth.subscribeInvalidation(lease, () => {
            if (!active) return;
            this.launchStore.invalidateAuthSession(lease.sessionFingerprint);
            active = false;
            this.launchAuthSubscriptions.delete(lease.sessionFingerprint);
            if (unsubscribe) {
                try { unsubscribe(); } catch (_) { }
            } else {
                invalidatedSynchronously = true;
            }
        });
        if (typeof subscribed !== 'function') throw errorWithCode('WEBTTY_AUTH_SUBSCRIPTION_INVALID');
        unsubscribe = subscribed;
        if (invalidatedSynchronously) {
            try { unsubscribe(); } catch (_) { }
            throw errorWithCode('WEBTTY_AUTH_INVALID');
        }
        this.launchAuthSubscriptions.set(lease.sessionFingerprint, () => {
            if (!active) return;
            active = false;
            try { unsubscribe(); } catch (_) { }
        });
    }

    cleanupLaunchSubscription(sessionFingerprint) {
        if (this.launchStore.hasAuthSession(sessionFingerprint)) return;
        const unsubscribe = this.launchAuthSubscriptions.get(sessionFingerprint);
        this.launchAuthSubscriptions.delete(sessionFingerprint);
        try { unsubscribe?.(); } catch (_) { }
    }

    async withAgentStartLock(target, operation) {
        // Engine exec records are scoped by immutable container identity, not
        // by Ploinky enable generation. A generation replacement that retains
        // the same container must therefore share this lock.
        const key = this.agentStartKey(target);
        if (!key) throw errorWithCode('WEBTTY_TARGET_STALE');
        const predecessor = this.agentStartLocks.get(key) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        const tail = predecessor.catch(() => {}).then(() => current);
        this.agentStartLocks.set(key, tail);
        await predecessor.catch(() => {});
        try {
            return await operation();
        } finally {
            release();
            if (this.agentStartLocks.get(key) === tail) this.agentStartLocks.delete(key);
        }
    }

    async discoverTargets({ req, routePlan, directory }) {
        if (!this.availability().ok) throw errorWithCode('WEBTTY_UNAVAILABLE');
        const lease = await this.validatedLease(req);
        const binding = terminalTargetRouteBinding(routePlan);
        const discovered = await this.targetResolver.discover({
            routePlan,
            requestedDirectory: directory,
            agentProviderAvailable: this.agentProviderReady,
        });
        if (this.agentProviderReady && discovered.agentTargetsAvailable === false) {
            this.disableAgentProvider('discovery_provider_unavailable');
        }
        await this.revalidateLease(lease);
        if (routePlan?.lease?.commit?.() !== true) throw errorWithCode('WEBTTY_GENERATION_CHANGED');
        this.launchStore.invalidateReplacedGenerations(binding);
        this.ensureLaunchInvalidationSubscription(lease);
        let created;
        try {
            created = this.launchStore.createDiscovery({
                owner: this.launchOwner(lease),
                routeBinding: binding,
                targets: discovered.targets,
                agentTargetsAvailable: discovered.agentTargetsAvailable,
            });
        } catch (error) {
            this.cleanupLaunchSubscription(lease.sessionFingerprint);
            throw error;
        }
        this.audit('webtty_target_discovery_created', {
            id: this.auditId(created.id),
            directory: created.directory || '.',
            targetCount: created.targets.length,
            agentTargetsAvailable: created.agentTargetsAvailable,
        });
        return created;
    }

    async revalidateTarget(options) {
        try {
            return await this.targetResolver.revalidate(options);
        } catch (error) {
            if (error?.code === 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE') {
                this.disableAgentProvider('target_provider_unavailable');
            }
            throw error;
        }
    }

    async cancelTargetDiscovery({ req, routePlan, id }) {
        const lease = await this.validatedLease(req);
        const cancelled = this.launchStore.cancelDiscovery({
            id,
            owner: this.launchOwner(lease),
            routeBinding: terminalTargetRouteBinding(routePlan),
        });
        this.cleanupLaunchSubscription(lease.sessionFingerprint);
        return cancelled;
    }

    async create({ req, routePlan, launch, cols = 80, rows = 24 }) {
        const lease = await this.validatedLease(req);
        const binding = routeBinding(routePlan);
        this.launchStore.invalidateReplacedGenerations(terminalTargetRouteBinding(routePlan));
        let consumed;
        try {
            consumed = await this.launchStore.consumeAndRevalidate({
                launch,
                owner: this.launchOwner(lease),
                routeBinding: terminalTargetRouteBinding(routePlan),
                revalidate: (storedTarget) => this.revalidateTarget({
                    routePlan,
                    target: storedTarget,
                    agentProviderAvailable: this.agentProviderReady,
                }),
            });
        } catch (error) {
            if (['WEBTTY_TARGET_STALE', 'WEBTTY_TARGET_DIRECTORY_STALE', 'WEBTTY_TARGET_GENERATION_STALE']
                .includes(error?.code)) throw errorWithCode('WEBTTY_TARGET_STALE');
            if (error?.code === 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE') {
                throw errorWithCode('WEBTTY_TARGET_PROVIDER_UNAVAILABLE');
            }
            throw error;
        } finally {
            this.cleanupLaunchSubscription(lease.sessionFingerprint);
        }
        const target = consumed.target;
        await this.revalidateLease(lease);
        if (routePlan?.lease?.commit?.() !== true) throw errorWithCode('WEBTTY_GENERATION_CHANGED');
        const releaseQuota = this.reserveQuota(lease);
        const id = randomId();
        const marker = randomId(32);
        const createdAt = this.now();
        let worker;
        try {
            worker = target.kind === 'agent'
                ? this.agentWorkerFactory({ terminalId: id })
                : this.workerFactory({ terminalId: id, marker });
        } catch (error) {
            releaseQuota();
            throw error;
        }
        let finishStartup;
        const startupFinished = new Promise((resolve) => { finishStartup = resolve; });
        const session = {
            id,
            marker,
            routerEpoch: this.routerEpoch,
            lease,
            binding,
            routePlan,
            routeLease: routePlan.lease,
            cwdRelative: target.directory.relativePath,
            target,
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
            startupInProgress: true,
            startupCancellation: '',
            startupFinished,
            finishStartup,
            recordWritePromise: Promise.resolve(),
        };
        let subscriptionActive = false;
        let synchronousInvalidation = '';
        let deferredStartupError = null;
        let deferredClosePromise = null;
        try {
            const unsubscribe = this.auth.subscribeInvalidation(lease, (reason) => {
                if (subscriptionActive) {
                    void this.closeSession(session, `auth_${reason}`);
                } else {
                    synchronousInvalidation = String(reason || 'revoked');
                }
            });
            if (typeof unsubscribe !== 'function') {
                throw errorWithCode('WEBTTY_AUTH_SUBSCRIPTION_INVALID');
            }
            if (synchronousInvalidation) {
                try { unsubscribe(); } catch (_) { }
                throw errorWithCode('WEBTTY_AUTH_INVALID');
            }
            session.unsubscribeAuth = () => {
                subscriptionActive = false;
                unsubscribe();
            };
        } catch (error) {
            releaseQuota();
            throw error;
        }
        this.sessions.set(id, session);
        subscriptionActive = true;
        worker.on('output', (message) => this.onOutput(session, message));
        worker.on('terminal-exit', (message) => {
            // An exit frame is a lifecycle notification, not cleanup proof. The
            // Box v1 frame has no cleanup-proof field, and its worker can emit
            // it after reporting ambiguous cleanup. Ready records are verified
            // against durable process evidence below; starting records remain
            // fail-closed because they do not yet contain a PTY identity.
            if (message.cleanupProven === true) {
                session.terminalCleanupProven = true;
            }
            void this.closeSession(session, `terminal_${message.category || 'exit'}`);
        });
        worker.on('process-exit', (message) => { void this.closeSession(session, `worker_${message.category || 'exit'}`, { workerExited: true }); });
        worker.on('terminal-error', (message) => {
            const providerUnproven = message.category === 'cleanup-provider-unproven';
            const unproven = providerUnproven || message.category === 'cleanup-unproven';
            if (unproven) {
                session.preserveRecord = true;
                if (session.target.kind === 'agent') {
                    if (providerUnproven) this.disableAgentProvider(message.category);
                    else this.quarantineAgentTarget(session.target, message.category);
                } else {
                    this.disableForUnprovenCleanup(message.category, session);
                }
                const evidenceWrite = this.queueRecordWrite(
                    session,
                    () => this.persistUnprovenCleanup(session),
                );
                void evidenceWrite.catch(() => false).finally(() => (
                    this.closeSession(session, `worker_${message.category}`, { preserveRecord: true })
                ));
                return;
            }
            if (session.target.kind === 'agent') {
                if (message.category === 'provider-evidence') {
                    this.disableAgentProvider(message.category);
                } else if (message.category === 'target-evidence') {
                    this.quarantineAgentTarget(session.target, message.category);
                }
            }
            void this.closeSession(session, `worker_${message.category || 'error'}`);
        });
        worker.on('error-category', (message) => {
            if (session.target.kind === 'agent'
                && ['protocol_error', 'worker_cleanup_unproven', 'worker_identity_unproven'].includes(message.category)) {
                this.disableAgentProvider(message.category);
            }
            void this.closeSession(session, `worker_${message.category || 'error'}`);
        });
        try {
            const workerIdentity = await worker.spawn();
            this.assertStartupActive(session);
            session.recordHandle = await this.recordStore.create({
                routerEpoch: this.routerEpoch,
                marker,
                targetKind: target.kind,
                target: target.kind === 'agent' ? {
                    runtime: target.runtime,
                    containerId: target.containerId,
                    containerName: target.containerName,
                    instanceId: target.instanceId,
                    enableGeneration: target.enableGeneration,
                } : null,
                worker: {
                    pid: workerIdentity.pid,
                    startToken: workerIdentity.startToken,
                    uid: workerIdentity.uid,
                },
            });
            this.assertStartupActive(session);
            if (target.kind === 'agent') {
                await this.withAgentStartLock(target, async () => {
                    try {
                        this.assertStartupActive(session);
                        await this.revalidateLease(lease);
                        await this.revalidateTarget({
                            routePlan,
                            target,
                            agentProviderAvailable: this.agentProviderReady,
                        });
                        this.assertStartupActive(session);
                        const prepared = await worker.prepare({
                            runtime: target.runtime,
                            containerId: target.containerId,
                            targetUser: target.targetUser,
                            translatedCwd: target.translatedCwd,
                            marker,
                            cols,
                            rows,
                        });
                        this.assertStartupActive(session);
                        const markedStarting = await this.queueRecordWrite(session, () => {
                            this.assertStartupActive(session);
                            return this.recordStore.markAgentPtyStarting(
                                session.recordHandle,
                                prepared.startupEvidence,
                            );
                        });
                        if (markedStarting !== true) {
                            throw errorWithCode('WEBTTY_RECOVERY_STATE_INVALID');
                        }
                        session.initRequested = true;
                        this.assertStartupActive(session);
                        const ready = await worker.start();
                        this.assertStartupActive(session);
                        await this.queueRecordWrite(session, () => {
                            this.assertStartupActive(session);
                            return this.recordStore.update(session.recordHandle, {
                                ...session.recordHandle.record,
                                agent: ready.recoveryEvidence,
                                ptyState: 'pty-ready',
                            });
                        });
                        this.assertStartupActive(session);
                        await this.revalidateLease(lease);
                        await this.revalidateTarget({
                            routePlan,
                            target,
                            agentProviderAvailable: this.agentProviderReady,
                        });
                        this.assertStartupActive(session);
                    } catch (error) {
                        // Keep the immutable-container lock until the durable
                        // pty-starting/pty-ready record has been recovered. A
                        // later same-container start must not create an ExecID
                        // that this attempt's baseline-diff recovery could
                        // mistake for its own residue.
                        session.startupInProgress = false;
                        session.finishStartup?.();
                        session.finishStartup = null;
                        await (session.closePromise || this.closeSession(session, 'create_failed'));
                        throw error;
                    }
                });
            } else {
                const markedStarting = await this.queueRecordWrite(session, () => {
                    this.assertStartupActive(session);
                    return this.recordStore.markPtyStarting(session.recordHandle);
                });
                if (markedStarting !== true) throw errorWithCode('WEBTTY_RECOVERY_STATE_INVALID');
                session.initRequested = true;
                this.assertStartupActive(session);
                const ready = await worker.start({
                    cwdRelative: target.directory.relativePath,
                    cols,
                    rows,
                    shellEnv: buildShellEnvironment(),
                });
                this.assertStartupActive(session);
                const identity = ready.processIdentity;
                await this.queueRecordWrite(session, () => {
                    this.assertStartupActive(session);
                    return this.recordStore.update(session.recordHandle, {
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
                });
            }
            if (target.kind !== 'agent') {
                this.assertStartupActive(session);
                await this.revalidateLease(lease);
                await this.revalidateTarget({
                    routePlan,
                    target,
                    agentProviderAvailable: this.agentProviderReady,
                });
                this.assertStartupActive(session);
            }
            this.scheduleDetachedClose(session, 'stream_never_attached');
            this.audit('webtty_session_created', {
                id: this.auditId(id),
                targetKind: target.kind,
                target: target.kind === 'agent' ? this.auditId(this.agentTargetKey(target)) : 'box',
                directory: target.directory.relativePath || '.',
                access: target.access,
            });
            return {
                id,
                cwd: target.directory.relativePath || '.',
                cols,
                rows,
                target: {
                    kind: target.kind,
                    label: target.label,
                    detail: target.detail,
                    access: target.access,
                    cwdDisplay: target.cwdDisplay,
                },
            };
        } catch (error) {
            session.startupInProgress = false;
            if (target.kind === 'agent'
                && ['WEBTTY_AGENT_WORKER_IDENTITY_UNPROVEN', 'WEBTTY_AGENT_WORKER_CLEANUP_UNPROVEN']
                    .includes(error?.code)) {
                this.disableAgentProvider('worker_identity_unproven');
            }
            if (session.closePromise) {
                // Release startupFinished in finally before joining the close
                // which is itself waiting on that barrier.
                deferredStartupError = error;
                deferredClosePromise = session.closePromise;
            } else {
                await this.closeSession(session, 'create_failed');
                throw error;
            }
        } finally {
            session.startupInProgress = false;
            session.finishStartup?.();
            session.finishStartup = null;
        }
        await deferredClosePromise;
        throw deferredStartupError;
    }

    assertStartupActive(session) {
        if (session.startupCancellation || session.closed || this.closed) {
            throw errorWithCode('WEBTTY_AUTH_INVALID', session.startupCancellation || 'startup cancelled');
        }
        if (session.routeLease?.isCurrent?.() !== true) {
            throw errorWithCode('WEBTTY_GENERATION_CHANGED');
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
        // Authentication validation is asynchronous. The workspace route may
        // be replaced while it is in flight, so the pre-await generation
        // check cannot authorize a later SSE attachment or mutation.
        if (session.routeLease?.isCurrent?.() !== true
            || routePlan?.lease?.commit?.() !== true) {
            await this.closeSession(session, 'route_generation_changed');
            return null;
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
        if (!stream) return true;
        if (stream.writableEnded || stream.destroyed) {
            session.stream = null;
            this.scheduleDetachedClose(session, 'browser_stream_closed');
            return false;
        }
        if (Number(stream.writableLength || 0) + Buffer.byteLength(bytes) > this.limits.sseWritableBytes) {
            void this.closeSession(session, 'sse_backpressure');
            return false;
        }
        try {
            if (stream.write(bytes) === false
                && Number(stream.writableLength || 0) > this.limits.sseWritableBytes) {
                void this.closeSession(session, 'sse_backpressure');
                return false;
            }
        } catch (_) {
            if (session.stream === stream) {
                session.stream = null;
                this.scheduleDetachedClose(session, 'browser_stream_write_failed');
            }
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
        this.touch(session);
        this.writeStream(session, encoded);
    }

    attachStream(session, req, res, lastEventId = '') {
        if (!session || session.closed || session.closing) return false;
        if (req.destroyed || req.aborted || res.writableEnded || res.destroyed) return false;
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
        const detach = () => {
            if (session.stream === res) {
                session.stream = null;
                this.scheduleDetachedClose(session, 'browser_stream_closed');
            }
        };
        req.once('close', detach);
        if (req.destroyed || req.aborted || res.writableEnded || res.destroyed) {
            detach();
            return false;
        }
        if (!this.writeStream(session, ': connected\n\n')) return false;
        for (const event of session.replay) {
            if (event.sequence > requested && !this.writeStream(session, event.encoded)) return false;
        }
        this.touch(session);
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

    queueRecordWrite(session, operation) {
        const pending = session.recordWritePromise.then(operation);
        session.recordWritePromise = pending;
        return pending;
    }

    closeSession(sessionOrId, reason = 'requested', options = {}) {
        const session = typeof sessionOrId === 'string' ? this.sessions.get(sessionOrId) : sessionOrId;
        if (!session) return Promise.resolve(false);
        if (session.closePromise) return session.closePromise;
        if (session.closed) return Promise.resolve(true);
        const closePromise = this.finishCloseSession(session, reason, options);
        session.closePromise = closePromise;
        this.inFlightCloses.add(closePromise);
        void closePromise.then(
            () => this.inFlightCloses.delete(closePromise),
            () => this.inFlightCloses.delete(closePromise),
        );
        return closePromise;
    }

    async finishCloseSession(session, reason = 'requested', {
        workerExited = false,
        preserveRecord = false,
    } = {}) {
        try {
        if (session.startupInProgress) {
            session.startupCancellation = String(reason || 'requested');
            session.closeReason = session.startupCancellation;
            try { await session.worker.close(); } catch (_) { }
            await session.startupFinished;
            if (session.closed) return true;
        }
        session.closing = true;
        session.closeReason = reason;
        this.sessions.delete(session.id);
        this.addTombstone(session);
        try { session.unsubscribeAuth?.(); } catch (_) {
            try {
                this.audit('webtty_auth_unsubscribe_failed', {
                    id: this.auditId(session.id),
                });
            } catch (_) { }
        }
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
        // A cleanup-error message and the process-exit notification can be
        // adjacent. Never recover or remove the same durable handle until the
        // ordered cleanup-evidence write has reached stable storage.
        let recordWrite;
        do {
            recordWrite = session.recordWritePromise;
            try {
                await recordWrite;
            } catch (_) {
                session.preserveRecord = true;
                this.disableForUnprovenCleanup('recovery_record_write_failed', session);
            }
        } while (recordWrite !== session.recordWritePromise);
        let cleanupProven = session.terminalCleanupProven === true;
        let cleanupFailureCategory = '';
        let cleanupFailureScope = '';
        let recordAlreadyRemoved = false;
        if (exited && session.target.kind === 'agent'
            && !preserveRecord
            && !session.preserveRecord
            && ['pty-starting', 'pty-ready'].includes(
                session.recordHandle?.record?.ptyState,
            )) {
            try {
                const recovered = await this.recordStore.recoverHandle(session.recordHandle);
                cleanupProven = recovered?.recovered === true;
                cleanupFailureCategory = cleanupProven ? '' : String(
                    recovered?.category || 'agent_crash_recovery_unproven',
                );
                cleanupFailureScope = cleanupProven ? '' : String(recovered?.scope || 'target');
                if (!cleanupProven && !this.hasScopedAgentRecoveryRecord(session)) {
                    cleanupFailureScope = 'global';
                    if (cleanupFailureCategory === 'agent_record_remove_unconfirmed') {
                        cleanupFailureCategory = 'recovery_record_remove_unconfirmed';
                    }
                }
                recordAlreadyRemoved = cleanupProven;
                if (!cleanupProven && cleanupFailureScope === 'provider') {
                    this.disableAgentProvider(cleanupFailureCategory);
                }
            } catch (error) {
                cleanupProven = false;
                cleanupFailureCategory = 'agent_crash_recovery_failed';
                cleanupFailureScope = classifyAgentEvidenceFailure(error);
                if (!this.hasScopedAgentRecoveryRecord(session)) cleanupFailureScope = 'global';
                if (cleanupFailureScope === 'provider') {
                    this.disableAgentProvider(cleanupFailureCategory);
                }
            }
        } else if (exited && session.recordHandle
            && session.recordHandle.record?.ptyState !== 'pty-starting') {
            try {
                cleanupProven = await this.recordStore.confirmReclaimed(
                    session.recordHandle.record,
                    { waitForExit: true },
                );
            } catch (error) {
                cleanupProven = false;
                cleanupFailureCategory = 'terminal_reclamation_check_failed';
                if (session.target.kind === 'agent') {
                    cleanupFailureScope = classifyAgentEvidenceFailure(error);
                    if (cleanupFailureScope === 'provider') {
                        this.disableAgentProvider(cleanupFailureCategory);
                    }
                }
            }
        }
        const mustPreserve = preserveRecord || session.preserveRecord || !cleanupProven;
        if (!exited) {
            session.preserveRecord = true;
            if (session.target.kind === 'agent') {
                this.disableAgentProvider('worker_exit_unconfirmed');
            } else {
                this.disableForUnprovenCleanup('worker_exit_unconfirmed', session);
            }
        } else if ((session.recordHandle || session.initRequested) && mustPreserve) {
            const category = cleanupFailureCategory || (session.preserveRecord && this.disabledCategory
                ? this.disabledCategory
                : 'terminal_cleanup_unproven');
            session.preserveRecord = true;
            if (session.target.kind === 'agent') {
                if (cleanupFailureScope === 'global') {
                    this.disableForUnprovenCleanup(category, session);
                } else if (cleanupFailureScope === 'provider') this.disableAgentProvider(category);
                else this.quarantineAgentTarget(session.target, category);
            } else {
                this.disableForUnprovenCleanup(category, session);
            }
        } else if (session.recordHandle && !recordAlreadyRemoved) {
            try {
                const removed = await this.recordStore.remove(session.recordHandle);
                if (removed !== true) {
                    this.disableForRecordRemovalFailure(
                        session,
                        'recovery_record_remove_unconfirmed',
                        'agent_record_remove_unconfirmed',
                    );
                }
            } catch (_) {
                this.disableForRecordRemovalFailure(
                    session,
                    'recovery_record_remove_failed',
                    'agent_record_remove_failed',
                );
            }
        }
        return true;
        } finally {
            session.closed = true;
            session.closing = false;
            if (!session.released) {
                session.released = true;
                try { session.releaseQuota(); } catch (_) { }
            }
            try {
                this.audit('webtty_session_closed', {
                    id: this.auditId(session.id),
                    reason,
                    durationMs: Math.max(0, this.now() - session.createdAt),
                });
            } catch (_) { }
        }
    }

    async closeOwned(req, routePlan, id) {
        const session = await this.validateOwnership(req, routePlan, id);
        if (session) return this.closeSession(session, 'requested');
        try { return this.matchesTombstone(req, routePlan, id); } catch (_) { return false; }
    }

    async validateLiveSessions() {
        if (this.closed) return;
        const now = this.now();
        for (const sessionFingerprint of this.launchAuthSubscriptions.keys()) {
            this.cleanupLaunchSubscription(sessionFingerprint);
        }
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
            if (session.target.kind === 'agent') {
                try {
                    await this.revalidateTarget({
                        routePlan: session.routePlan,
                        target: session.target,
                        agentProviderAvailable: this.agentProviderReady,
                    });
                } catch (_) {
                    await this.closeSession(session, 'target_identity_changed');
                    return;
                }
            }
            const auth = await this.auth.validateLease(session.lease);
            if (!auth.ok) await this.closeSession(session, `auth_${auth.reason}`);
        }));
    }

    async closeAll(reason = 'router_shutdown') {
        if (!this.closed) {
            this.closed = true;
            this.ready = false;
            this.disabledCategory = 'shutting_down';
            clearInterval(this.leaseTimer);
            for (const unsubscribe of this.launchAuthSubscriptions.values()) {
                try { unsubscribe(); } catch (_) { }
            }
            this.launchAuthSubscriptions.clear();
        }
        const requested = [...this.sessions.values()].map((session) => (
            this.closeSession(session, reason)
        ));
        await Promise.allSettled([...requested, ...this.inFlightCloses]);
    }
}

export default WebttySessionManager;
