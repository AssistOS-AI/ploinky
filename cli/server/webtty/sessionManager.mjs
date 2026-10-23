import crypto from 'node:crypto';
import { isAdminUser } from '../auth/localService.js';

import { assertWebttyWorkspaceRoot } from '../../../core-services/webtty/cwd.mjs';
import { buildShellEnvironment } from '../../../core-services/webtty/environment.mjs';
import { WEBTTY_PROTOCOL_LIMITS } from '../../../core-services/webtty/worker-protocol.mjs';
import {
    browserPrincipal,
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

const AUTH_LEASE_AUDIT_PHASES = new Set(['before_agent_prepare', 'after_agent_ready']);
const AUTH_LEASE_AUDIT_REASONS = new Set([
    'invalid_lease',
    'validation_failed',
    'missing_or_expired',
    'expired',
    'user_changed',
    'session_changed',
    'administrator_revoked',
    'provider_unavailable',
]);
const RECLAMATION_PROC_REASONS = new Set(['proc-scan-timeout', 'proc-scan-limit', 'proc-file-limit']);
const RECLAMATION_IO_REASONS = new Set(['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE']);
const RECLAMATION_INTERNAL_REASONS = new Map([
    ['invalid proc stat', 'invalid-proc-stat'],
    ['incomplete proc stat', 'incomplete-proc-stat'],
    ['incomplete proc identity', 'incomplete-proc-identity'],
    ['proc identity changed while reading', 'process-changed'],
    ['proc identity changed while enumerating session', 'session-member-changed'],
    ['session membership evidence is invalid', 'invalid-session-membership'],
]);

function reclamationAuditReason(error) {
    if (error?.code === 'WEBTTY_PROCESS_IDENTITY_UNPROVEN'
        && RECLAMATION_PROC_REASONS.has(error.category)) return error.category;
    if (RECLAMATION_IO_REASONS.has(error?.code)) return error.code;
    // Match only fixed internal errors. Never serialize or coerce exception data.
    return RECLAMATION_INTERNAL_REASONS.get(error?.message) || 'unknown';
}

export const WEBTTY_SESSION_LIMITS = Object.freeze({
    global: 24,
    perUser: 8,
    createWindowMs: 60_000,
    createsPerWindow: 5,
    inputWindowMs: 10_000,
    inputBytesPerWindow: 512 * 1024,
    outputReplayBytes: 1024 * 1024,
    outputReplayEvents: 8192,
    viewersPerSession: 8,
    viewersGlobal: 64,
    viewerQueueBytes: 1280 * 1024,
    viewerDrainTimeoutMs: 30_000,
    idleLifetimeMs: 24 * 60 * 60_000,
    absoluteLifetimeMs: 7 * 24 * 60 * 60_000,
    authenticationIntervalMs: 5_000,
    targetUndecidedLimitMs: 120_000,
    targetValidationDeadlineMs: 10_000,
    // Longest continuous stretch of undecided periodic checks (provider
    // unavailable) an open terminal survives. A provider restart is normally
    // decided again within a few 5 s checks (the Router answers fast 503s
    // for a few seconds while an agent restarts, and each check is bounded by
    // the 5 s validation deadline); a longer outage closes the terminal rather
    // than streaming output for up to the absolute lifetime without a decided
    // admission.
    authenticationOutageLimitMs: 60_000,
    streamDetachGraceMs: 15_000,
    tombstoneLifetimeMs: 5 * 60_000,
    maxTombstones: 256,
    // Server views: one per create or attach. A view without a stream for
    // this long no longer holds back a pending stop (it can still reconnect).
    viewsPerSession: 32,
    viewReconnectWindowMs: 30_000,
    closeIntentGraceMs: 30_000,
});

const CLOSE_POLICIES = new Set(['keep', 'stop']);
// A wider cleanup-failure scope always wins over a narrower one.
const CLEANUP_FAILURE_SCOPE_RANK = Object.freeze({ target: 1, provider: 2, global: 3 });

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
        && left.hostRouteKey === right.hostRouteKey;
}

function errorWithCode(code, message = code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function displayText(value, maxBytes, fallback = '') {
    const source = String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, ' ');
    let text = '';
    for (const character of source) {
        if (Buffer.byteLength(text + character) > maxBytes) break;
        text += character;
    }
    return text;
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
        homeProfiles = null,
        capturePlan = null,
        agentProviderAvailable = false,
        workspaceRoot,
        auth = DEFAULT_AUTH_ADAPTER,
        now = () => Date.now(),
        audit = () => {},
    } = {}) {
        // The Router's trusted workspace root selects every Box terminal
        // directory and is the only dynamic worker and shell environment value.
        this.workspaceRoot = assertWebttyWorkspaceRoot(workspaceRoot);
        this.limits = Object.freeze({ ...WEBTTY_SESSION_LIMITS, ...limits });
        this.workerFactory = workerFactory;
        this.agentWorkerFactory = agentWorkerFactory;
        this.recordStore = recordStore;
        this.launchStore = launchStore;
        this.auth = Object.freeze({ ...DEFAULT_AUTH_ADAPTER, ...auth });
        this.now = now;
        this.audit = audit;
        this.capturePlan = capturePlan;
        this.homeProfiles = homeProfiles;
        this.validationStartIndex = 0;
        this.routerEpoch = randomId(18);
        this.sessions = new Map();
        this.pendingCreations = new Map();
        this.tombstones = new Map();
        this.userCounts = new Map();
        this.ownerIndex = new Map();
        this.viewerCount = 0;
        this.creationRates = new Map();
        this.launchAuthSubscriptions = new Map();
        this.agentStartLocks = new Map();
        this.inFlightCloses = new Set();
        this.quarantinedAgentTargets = new Map();
        this.quarantinedAgentContainers = new Set();
        this.agentProviderReady = agentProviderAvailable === true;
        this.agentProviderDisabledCategory = this.agentProviderReady ? '' : 'provider_not_local';
        this.targetResolver = targetResolver || new TerminalTargetResolver({
            workspaceRoot,
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
        const principal = browserPrincipal(lease.mode, lease.userId);
        const userCount = this.userCounts.get(principal) || 0;
        if (this.sessions.size >= this.limits.global) throw errorWithCode('WEBTTY_GLOBAL_QUOTA');
        if (userCount >= this.limits.perUser) throw errorWithCode('WEBTTY_USER_QUOTA');
        const creations = this.creationRates.get(lease.sessionFingerprint) || [];
        if (creations.length >= this.limits.createsPerWindow) throw errorWithCode('WEBTTY_CREATION_RATE');
        creations.push(now);
        this.creationRates.set(lease.sessionFingerprint, creations);
        this.userCounts.set(principal, userCount + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const nextUser = Math.max(0, (this.userCounts.get(principal) || 1) - 1);
            if (nextUser) this.userCounts.set(principal, nextUser); else this.userCounts.delete(principal);
        };
    }

    // The lease comes from this request, so its own completed admission is
    // reused; later revalidations after asynchronous work ask again.
    async validatedLease(req) {
        const lease = this.auth.createLease(req);
        await this.revalidateLease(lease, undefined, { req });
        return lease;
    }

    async revalidateLease(lease, auditPhase, { req = null } = {}) {
        const currentAuth = await this.auth.validateLease(lease, { req });
        if (!currentAuth.ok) {
            const reason = currentAuth.reason;
            if (reason === 'administrator_revoked') {
                // Do not join cleanup here: a starting shell's cleanup waits
                // for this validation path to release startupFinished.
                void this.closePrincipal(browserPrincipal(lease.mode, lease.userId));
            }
            if (AUTH_LEASE_AUDIT_PHASES.has(auditPhase)) {
                try {
                    // Diagnostics must not replace the rejection or delay startup cleanup.
                    Promise.resolve(this.audit('webtty_auth_lease_rejected', {
                        phase: auditPhase,
                        reason: AUTH_LEASE_AUDIT_REASONS.has(reason) ? reason : 'unknown',
                    })).catch(() => {});
                } catch (_) { }
            }
            throw errorWithCode(
                reason === 'administrator_revoked'
                    ? 'WEBTTY_ADMIN_REQUIRED'
                // An undecided provider maps to the handler's retryable 503.
                : reason === 'provider_unavailable'
                    ? 'WEBTTY_UNAVAILABLE'
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

    // The provider is asked only after this request's own administrator
    // admission was revalidated, and it signs with that identity.
    async resolveHomeProfile({ req, routePlan, profile }) {
        if (typeof this.homeProfiles?.resolve !== 'function') throw errorWithCode('WEBTTY_PROFILE_UNAVAILABLE');
        const resolved = await this.homeProfiles.resolve({ req, routePlan, profile });
        if (!resolved?.profile || !resolved?.home) throw errorWithCode('WEBTTY_PROFILE_UNAVAILABLE');
        return resolved;
    }

    async discoverTargets({ req, routePlan, directory, profile = null }) {
        if (!this.availability().ok) throw errorWithCode('WEBTTY_UNAVAILABLE');
        const lease = await this.validatedLease(req);
        const binding = terminalTargetRouteBinding(routePlan);
        const resolvedProfile = profile ? await this.resolveHomeProfile({ req, routePlan, profile }) : null;
        const discovered = await this.targetResolver.discover({
            routePlan,
            requestedDirectory: directory,
            agentProviderAvailable: this.agentProviderReady,
            ...(resolvedProfile ? { home: resolvedProfile.home } : {}),
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
                ...(resolvedProfile ? { profile: resolvedProfile.profile } : {}),
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

    // Creation asks the provider again and requires the same answer and the
    // same directory identity; any difference or refusal is a stale target.
    async revalidateHomeProfile({ req, routePlan, target }) {
        let current;
        try {
            current = await this.resolveHomeProfile({
                req,
                routePlan,
                profile: { provider: target.profile.provider, id: target.profile.id },
            });
        } catch (_) {
            throw errorWithCode('WEBTTY_TARGET_STALE');
        }
        const home = target.home;
        if (!home || current.profile.provider !== target.profile.provider
            || current.profile.id !== target.profile.id
            || current.profile.label !== target.profile.label
            || current.home.relativePath !== home.relativePath
            || current.home.absolutePath !== home.absolutePath
            || current.home.identity.dev !== home.identity.dev
            || current.home.identity.ino !== home.identity.ino) {
            throw errorWithCode('WEBTTY_TARGET_STALE');
        }
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

    profileLabel(session) {
        return session.profile?.label ? displayText(session.profile.label, 128) || null : null;
    }

    closePolicyOf(session) {
        return session.closePolicy === 'stop' ? 'stop' : 'keep';
    }

    sessionDescription(session, principal) {
        return {
            id: session.id,
            role: principal === session.owner.principal ? 'owner' : 'watcher',
            state: session.viewers.size ? 'attached' : 'detached',
            cwd: session.cwdRelative || '.',
            cols: session.cols,
            rows: session.rows,
            target: Object.fromEntries(['kind', 'label', 'detail', 'access', 'cwdDisplay']
                .map(key => [key, session.target[key]])),
            closePolicy: this.closePolicyOf(session),
            pendingStopUntil: session.pendingStop?.deadline ?? null,
            profileLabel: this.profileLabel(session),
        };
    }

    displayRow(session, principal, endedAt = null) {
        const isOwner = principal === session.owner.principal;
        const live = endedAt === null;
        return {
            id: session.id, source: 'webtty', kind: 'shell',
            title: displayText(session.target.label, 256, 'Terminal'),
            detail: displayText(session.target.detail, 256),
            cwdDisplay: displayText(session.target.cwdDisplay, 4096),
            access: session.target.access,
            status: live ? (session.viewers.size ? 'attached' : 'detached') : 'exited',
            isOwner, ownerLabel: displayText(session.owner.label, 128),
            viewerCount: live ? session.viewers.size : 0,
            startedAt: session.createdAt, lastActivityAt: session.lastActivityAt,
            ...(live ? {} : { endedAt, exitReason: displayText(session.closeReason, 128) }),
            closePolicy: this.closePolicyOf(session),
            pendingStopUntil: live ? session.pendingStop?.deadline ?? null : null,
            ownerViewOpen: live && this.ownerViewOpen(session),
            profileLabel: this.profileLabel(session),
            capabilities: { watch: true, input: isOwner, stop: true, message: false },
            attach: { mode: 'webtty' },
        };
    }

    // Tombstone rows carry the close outcome. Optional keys are omitted, never
    // null: a scope only for an unconfirmed stop, the record flag only if set.
    tombstoneRow(tombstone, principal) {
        const isOwner = principal === tombstone.principal;
        return {
            ...tombstone.row,
            isOwner,
            capabilities: { ...tombstone.row.capabilities, input: isOwner },
            closure: tombstone.closure,
            ...(tombstone.closure === 'unconfirmed' && tombstone.closureScope
                ? { closureScope: tombstone.closureScope } : {}),
            ...(tombstone.recordCleanup === 'failed' ? { recordCleanup: 'failed' } : {}),
        };
    }

    // The list stays readable while WebTTY is disabled: it then carries only
    // the retained close outcomes, and `available` reports the disabled state.
    async listLiveSessions({ req, routePlan }) {
        const lease = await this.validatedLease(req);
        const binding = routeBinding(routePlan);
        if (routePlan?.lease?.commit?.() !== true) throw errorWithCode('WEBTTY_GENERATION_CHANGED');
        const available = this.availability().ok === true;
        const principal = browserPrincipal(lease.mode, lease.userId);
        const sessions = available
            ? [...this.sessions.values()]
                .filter(session => !session.startupInProgress && !session.closed && !session.closing
                    && bindingMatches(session.binding, binding))
                .map(session => this.displayRow(session, principal))
            : [];
        for (const [id, tombstone] of this.tombstones) {
            if (this.now() >= tombstone.expiresAt) { this.tombstones.delete(id); continue; }
            if (!bindingMatches(tombstone.binding, binding)) continue;
            sessions.push(this.tombstoneRow(tombstone, principal));
        }
        return { sessions, available };
    }

    async listSessions(options) {
        return (await this.listLiveSessions(options)).sessions;
    }

    safeAudit(event, details) {
        try {
            // Diagnostics never replace, reject or delay the lifecycle decision.
            Promise.resolve(this.audit(event, details)).catch(() => {});
        } catch (_) { }
    }

    sessionViews(session) {
        if (!(session.views instanceof Map)) {
            session.views = new Map();
            session.viewSeq = 0;
        }
        return session.views;
    }

    ownerViews(session) {
        return [...this.sessionViews(session).values()]
            .filter(view => view.principal === session.owner.principal);
    }

    ownerViewOpen(session) {
        return this.ownerViews(session).some(view => view.state === 'open');
    }

    // Intent-ended and superseded views are terminal: they never stream,
    // never count at a deadline and are evicted first.
    viewTerminal(view) {
        return view.state === 'ended' || view.state === 'superseded';
    }

    viewWithinReconnectWindow(view, now = this.now()) {
        return view.state === 'detached' && now - view.detachedAt < this.limits.viewReconnectWindowMs;
    }

    // A view is server-issued per create or attach and starts detached. Only
    // an accepted close intent or a valid recovery claim ends it; a detached
    // view can reopen any time. Creating a view never cancels a pending stop.
    // `retain` names a view that must survive eviction: the view a recovery
    // claim is about to supersede.
    createView(session, principal, { retain = null } = {}) {
        const views = this.sessionViews(session);
        const now = this.now();
        if (views.size >= this.limits.viewsPerSession) {
            const ordered = [...views.values()].filter(view => view.id !== retain);
            const evicted = ordered.find(view => this.viewTerminal(view))
                || ordered.find(view => view.state === 'detached' && !this.viewWithinReconnectWindow(view, now));
            if (!evicted) throw errorWithCode('WEBTTY_VIEW_LIMIT');
            views.delete(evicted.id);
        }
        session.viewSeq = (session.viewSeq || 0) + 1;
        const view = {
            id: randomId(24),
            seq: session.viewSeq,
            principal,
            role: principal === session.owner.principal ? 'owner' : 'watcher',
            state: 'detached',
            detachedAt: now,
            endedBy: null,
            endedPolicy: null,
            supersededBy: null,
            claimedBy: null,
            streams: 0,
        };
        views.set(view.id, view);
        return view;
    }

    // An explicit reload, back/forward or embedded restore names the view it
    // replaces. The claim is a hint, never a credential: it applies only to a
    // retained owner view of this session, attached by the owner, and not
    // already superseded. Called synchronously right after the new view
    // exists; an invalid claim changes nothing.
    applyRecoveryClaim(session, principal, view, claimedId) {
        if (!claimedId) return;
        const auditId = this.auditId(session.id);
        const claimed = this.sessionViews(session).get(String(claimedId));
        let ignored = '';
        if (principal !== session.owner.principal) ignored = 'not_owner';
        else if (!claimed || claimed === view) ignored = 'unknown_view';
        else if (claimed.principal !== session.owner.principal) ignored = 'foreign_view';
        else if (claimed.state === 'superseded') ignored = 'already_superseded';
        if (ignored) {
            this.safeAudit('webtty_view_supersede_ignored', { id: auditId, reason: ignored });
            return;
        }
        if (claimed.state === 'open') {
            // A live document keeps its view; its own later signal is
            // suppressed only while this claimant has not ended (latest wins).
            claimed.claimedBy = view.id;
            this.safeAudit('webtty_view_superseded', { id: auditId, outcome: 'claimed' });
            return;
        }
        claimed.state = 'superseded';
        claimed.endedBy = 'superseded';
        claimed.supersededBy = view.id;
        claimed.detachedAt = null;
        this.safeAudit('webtty_view_superseded', { id: auditId, outcome: 'superseded' });
        if (session.pendingStop && session.pendingStop.viewSeq === claimed.seq) {
            this.cancelPendingStop(session, 'reopened');
        }
    }

    // A claim recorded on an open view stays alive while the claimant, or the
    // latest view that superseded it in turn, has not ended. The walk is
    // bounded; a cycle, an overflow or a missing successor counts as ended.
    recoveryClaimLive(session, claimant) {
        const views = this.sessionViews(session);
        let current = claimant;
        for (let hops = 0; current && hops < this.limits.viewsPerSession; hops += 1) {
            if (current.principal !== session.owner.principal) return false;
            if (current.state !== 'superseded') return !this.viewTerminal(current);
            current = views.get(current.supersededBy);
        }
        return false;
    }

    // A stream binds to a non-terminal view of the requesting principal.
    streamView(session, req, viewId) {
        const lease = this.auth.createLease(req);
        const principal = browserPrincipal(lease.mode, lease.userId);
        const view = this.sessionViews(session).get(String(viewId || ''));
        if (!view || view.principal !== principal || this.viewTerminal(view)) {
            throw errorWithCode('WEBTTY_VIEW_STALE');
        }
        return view;
    }

    endViewByIntent(session, view, policy) {
        this.endView(session, view, { state: 'ended', endedBy: 'intent', endedPolicy: policy });
    }

    endView(session, view, fields) {
        Object.assign(view, fields);
        view.detachedAt = null;
        for (const viewer of [...session.viewers.values()]) {
            if (viewer.view === view) this.removeViewer(session, viewer, { event: 'detached', reason: 'view_ended' });
        }
    }

    clearPendingStop(session) {
        const pending = session.pendingStop;
        session.pendingStop = null;
        if (pending) clearTimeout(pending.timer);
        return pending;
    }

    cancelPendingStop(session, reason) {
        if (!this.clearPendingStop(session)) return false;
        this.safeAudit('webtty_close_intent_cancelled', { id: this.auditId(session.id), reason });
        return true;
    }

    schedulePendingStop(session, pending) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(
            () => this.onPendingStopDeadline(session, pending),
            Math.max(0, pending.deadline - this.now()),
        );
        pending.timer.unref?.();
    }

    armPendingStop(session, viewSeq) {
        this.clearPendingStop(session);
        const pending = { deadline: this.now() + this.limits.closeIntentGraceMs, viewSeq, timer: null };
        session.pendingStop = pending;
        this.schedulePendingStop(session, pending);
        return pending;
    }

    onPendingStopDeadline(session, pending) {
        if (session.pendingStop !== pending) return;
        if (session.closed || session.closing || this.sessions.get(session.id) !== session) {
            // An explicit Kill or another close already owns cleanup.
            this.clearPendingStop(session);
            return;
        }
        const now = this.now();
        const ownerViews = this.ownerViews(session).filter(view => !this.viewTerminal(view));
        if (ownerViews.some(view => view.state === 'open')) {
            this.cancelPendingStop(session, 'open-elsewhere');
            return;
        }
        const reconnecting = ownerViews.filter(view => this.viewWithinReconnectWindow(view, now));
        if (reconnecting.length) {
            // A recently dropped owner stream is a reconnect gap, not a close.
            pending.deadline = Math.max(...reconnecting.map(
                view => view.detachedAt + this.limits.viewReconnectWindowMs,
            ));
            this.schedulePendingStop(session, pending);
            return;
        }
        this.clearPendingStop(session);
        const auditId = this.auditId(session.id);
        const settled = () => this.safeAudit('webtty_closed_on_tab_close', {
            id: auditId,
            closure: session.tombstone?.closure || 'unconfirmed',
        });
        void this.closeSession(session, 'tab_closed').then(settled, settled);
    }

    async setClosePolicy({ req, routePlan, id, policy }) {
        if (!CLOSE_POLICIES.has(policy)) throw errorWithCode('WEBTTY_CLOSE_POLICY_INVALID');
        const session = await this.authorize(req, routePlan, id, 'control');
        if (!session) throw errorWithCode('WEBTTY_SESSION_NOT_FOUND');
        session.closePolicy = policy;
        if (policy === 'keep') {
            this.cancelPendingStop(session, 'policy_keep');
        } else if (!session.pendingStop) {
            // A toggle that reaches the server after its tab's close intent:
            // the most recent non-superseded owner intent decides, and no
            // owner view may be open or still within its reconnect window.
            const owners = this.ownerViews(session);
            const latest = owners.filter(view => view.state === 'ended' && view.endedBy === 'intent')
                .reduce((best, view) => (!best || view.seq > best.seq ? view : best), null);
            const now = this.now();
            const present = owners.some(view => view.state === 'open' || this.viewWithinReconnectWindow(view, now));
            if (latest?.endedPolicy === 'stop' && !present) {
                this.armPendingStop(session, latest.seq);
                this.safeAudit('webtty_close_intent_armed', { id: this.auditId(session.id), source: 'policy' });
            }
        }
        this.safeAudit('webtty_close_policy_changed', {
            id: this.auditId(session.id),
            policy,
            pending: Boolean(session.pendingStop),
        });
        return {
            closePolicy: this.closePolicyOf(session),
            pendingStopUntil: session.pendingStop?.deadline ?? null,
        };
    }

    async closeIntent({ req, routePlan, id, view: viewId, policy }) {
        if (!CLOSE_POLICIES.has(policy)) throw errorWithCode('WEBTTY_CLOSE_POLICY_INVALID');
        const session = await this.authorize(req, routePlan, id, 'control');
        if (!session) throw errorWithCode('WEBTTY_SESSION_NOT_FOUND');
        const auditId = this.auditId(session.id);
        const view = this.sessionViews(session).get(String(viewId || ''));
        // (1) Unknown, foreign and already ended or superseded views have no
        // effect, which also deduplicates a repeated or delayed signal.
        if (!view || view.principal !== session.owner.principal || this.viewTerminal(view)) {
            this.safeAudit('webtty_close_intent_ignored', { id: auditId, reason: 'view_stale' });
            throw errorWithCode('WEBTTY_VIEW_STALE');
        }
        // A recovery claim recorded while this view was still open suppresses
        // its signal for as long as the claiming view has not ended.
        const claimant = view.claimedBy ? this.sessionViews(session).get(view.claimedBy) : null;
        if (claimant && this.recoveryClaimLive(session, claimant)) {
            this.endView(session, view, { state: 'superseded', endedBy: 'superseded', supersededBy: claimant.id });
            this.safeAudit('webtty_close_intent_ignored', { id: auditId, reason: 'superseded' });
            return { pending: false, reason: 'superseded' };
        }
        // (2) The signalling document is gone.
        this.endViewByIntent(session, view, policy);
        // (3) Both the document's belief and the session policy must be stop.
        // Sequence numbers alone never supersede an explicit signal.
        if (policy !== 'stop' || this.closePolicyOf(session) !== 'stop') {
            this.safeAudit('webtty_close_intent_ignored', { id: auditId, reason: 'keep' });
            return { pending: false };
        }
        // (4) Arm or re-arm the grace period.
        const pending = this.armPendingStop(session, view.seq);
        this.safeAudit('webtty_close_intent_armed', { id: auditId, source: 'intent' });
        return { pending: true, until: pending.deadline };
    }

    async createAttachToken({ req, routePlan, id, supersedes = null }) {
        const session = await this.authorize(req, routePlan, id);
        if (!session) throw errorWithCode('WEBTTY_SESSION_NOT_FOUND');
        const lease = this.auth.createLease(req);
        this.ensureLaunchInvalidationSubscription(lease);
        try {
            return this.launchStore.createAttachment({
                owner: this.launchOwner(lease), routeBinding: terminalTargetRouteBinding(routePlan), sessionId: id,
                ...(supersedes === null ? {} : { supersedes }),
            });
        } catch (error) {
            this.cleanupLaunchSubscription(lease.sessionFingerprint);
            throw error;
        }
    }

    async attach({ req, routePlan, attach, cols, rows }) {
        const lease = await this.validatedLease(req);
        let record;
        try {
            record = this.launchStore.consumeAttachment({
                attach, owner: this.launchOwner(lease), routeBinding: terminalTargetRouteBinding(routePlan),
            });
        } finally { this.cleanupLaunchSubscription(lease.sessionFingerprint); }
        const session = await this.authorize(req, routePlan, record.sessionId, 'attach');
        if (!session) throw errorWithCode('WEBTTY_SESSION_NOT_FOUND');
        const principal = browserPrincipal(lease.mode, lease.userId);
        if (principal === session.owner.principal) await this.resize(session, cols, rows);
        if (session.closed || session.closing) throw errorWithCode('WEBTTY_SESSION_NOT_FOUND');
        // A refused view (WEBTTY_VIEW_LIMIT) leaves any recovery claim unused.
        // An owner's claimed view is kept out of eviction so the claim can apply.
        const claimed = principal === session.owner.principal ? record.supersedes || null : null;
        const view = this.createView(session, principal, { retain: claimed });
        this.applyRecoveryClaim(session, principal, view, record.supersedes || null);
        this.touch(session);
        // The handler lifts `view` to the top level of its response.
        return { ...this.sessionDescription(session, principal), view: { id: view.id } };
    }

    async create({ req, routePlan, launch, cols = 80, rows = 24, closePolicy = 'keep' }) {
        if (!CLOSE_POLICIES.has(closePolicy)) throw errorWithCode('WEBTTY_CLOSE_POLICY_INVALID');
        const lease = this.auth.createLease(req);
        const attempt = {
            id: randomId(),
            owner: {
                principal: browserPrincipal(lease.mode, lease.userId),
                userId: lease.userId,
                label: displayText(req?.user?.displayName || req?.user?.username || lease.userId, 128),
                adminAdmittedAt: Number(lease.createdAt) || 0,
            },
            cancellation: '',
        };
        // Observe demotion before the first provider/target await without
        // reserving a worker or quota for an unauthenticated attempt.
        this.pendingCreations.set(attempt.id, attempt);
        const owned = this.ownerIndex.get(attempt.owner.principal) || new Set();
        owned.add(attempt.id);
        this.ownerIndex.set(attempt.owner.principal, owned);
        try {
            return await this.createAttempt({ req, routePlan, launch, cols, rows, closePolicy }, lease, attempt);
        } finally {
            this.pendingCreations.delete(attempt.id);
            if (!this.sessions.has(attempt.id)) {
                const remaining = this.ownerIndex.get(attempt.owner.principal);
                remaining?.delete(attempt.id);
                if (!remaining?.size) this.ownerIndex.delete(attempt.owner.principal);
            }
        }
    }

    assertCreationActive(attempt) {
        if (attempt.cancellation || this.closed) throw errorWithCode('WEBTTY_AUTH_INVALID');
    }

    async createAttempt({ req, routePlan, launch, cols, rows, closePolicy }, lease, attempt) {
        this.assertCreationActive(attempt);
        await this.revalidateLease(lease, undefined, { req });
        this.assertCreationActive(attempt);
        const binding = routeBinding(routePlan);
        this.launchStore.invalidateReplacedGenerations(terminalTargetRouteBinding(routePlan));
        let consumed;
        try {
            consumed = await this.launchStore.consumeAndRevalidate({
                launch,
                owner: this.launchOwner(lease),
                routeBinding: terminalTargetRouteBinding(routePlan),
                revalidate: async (storedTarget) => {
                    if (storedTarget.profile) {
                        await this.revalidateHomeProfile({ req, routePlan, target: storedTarget });
                    }
                    return this.revalidateTarget({
                        routePlan,
                        target: storedTarget,
                        agentProviderAvailable: this.agentProviderReady,
                    });
                },
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
        this.assertCreationActive(attempt);
        const target = consumed.target;
        await this.revalidateLease(lease);
        this.assertCreationActive(attempt);
        if (routePlan?.lease?.commit?.() !== true) throw errorWithCode('WEBTTY_GENERATION_CHANGED');
        const releaseQuota = this.reserveQuota(lease);
        const id = attempt.id;
        const marker = randomId(32);
        const createdAt = this.now();
        let worker;
        try {
            this.assertCreationActive(attempt);
            worker = target.kind === 'agent'
                ? this.agentWorkerFactory({ terminalId: id })
                : this.workerFactory({ terminalId: id, marker, workspaceRoot: this.workspaceRoot });
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
            owner: attempt.owner,
            binding,
            routePlan,
            routeLease: routePlan.lease,
            cwdRelative: target.directory.relativePath,
            target,
            // This session field is in memory only. Agent startup evidence
            // does persist translatedHome and the profile for exact recovery.
            profile: target.profile || null,
            // Close policy, views and a pending stop are in memory only.
            closePolicy,
            views: new Map(),
            viewSeq: 0,
            pendingStop: null,
            tombstone: null,
            cleanupFailureScope: '',
            createdAt,
            lastActivityAt: createdAt,
            worker,
            recordHandle: null,
            releaseQuota,
            released: false,
            closed: false,
            closing: false,
            closeReason: '',
            viewers: new Map(),
            everAttached: false,
            cols,
            rows,
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
            validationEpoch: 0,
            targetValidation: null,
            targetUndecidedSince: null,
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
            this.assertCreationActive(attempt);
        } catch (error) {
            try { session.unsubscribeAuth?.(); } catch (_) { }
            releaseQuota();
            throw error;
        }
        this.sessions.set(id, session);
        this.pendingCreations.delete(id);
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
                this.noteCleanupFailure(session, session.target.kind !== 'agent' ? 'global'
                    : providerUnproven ? 'provider' : 'target');
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
                        await this.revalidateLease(lease, 'before_agent_prepare');
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
                            ...(target.profile ? {
                                translatedHome: target.home.translatedHome,
                                profile: target.profile,
                            } : {}),
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
                        await this.revalidateLease(lease, 'after_agent_ready');
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
                    shellEnv: buildShellEnvironment(process.env, {
                        workspaceRoot: this.workspaceRoot,
                        ...(target.profile ? {
                            profile: { ...target.profile, home: target.home.translatedHome },
                        } : {}),
                    }),
                    ...(target.profile ? {
                        homeRelative: target.home.relativePath,
                        homeIdentity: { dev: target.home.identity.dev, ino: target.home.identity.ino },
                    } : {}),
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
            // Startup admission remains cancellable until readiness is durable.
            // Thereafter browser authority belongs to individual viewers.
            try { session.unsubscribeAuth?.(); } catch (_) { }
            session.unsubscribeAuth = null;
            this.audit('webtty_session_created', {
                id: this.auditId(id),
                targetKind: target.kind,
                target: target.kind === 'agent' ? this.auditId(this.agentTargetKey(target)) : 'box',
                directory: target.directory.relativePath || '.',
                access: target.access,
            });
            const view = this.createView(session, attempt.owner.principal);
            return {
                id,
                role: 'owner',
                state: 'detached',
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
                closePolicy: this.closePolicyOf(session),
                pendingStopUntil: null,
                profileLabel: this.profileLabel(session),
                // The handler lifts `view` to the top level of its response.
                view: { id: view.id },
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

    async authorize(req, routePlan, id, need = 'watch') {
        const session = this.sessions.get(String(id || ''));
        if (!session || session.closed || session.closing || session.startupInProgress
            || session.routerEpoch !== this.routerEpoch) return null;
        let binding;
        try { binding = routeBinding(routePlan); } catch (_) { return null; }
        if (!bindingMatches(binding, session.binding)) return null;
        if (routePlan?.lease?.commit?.() !== true) throw errorWithCode('WEBTTY_GENERATION_CHANGED');
        const lease = this.auth.createLease(req);
        const principal = browserPrincipal(lease.mode, lease.userId);
        const result = await this.auth.validateLease(lease, { req });
        if (!result.ok) {
            if (result.reason === 'administrator_revoked') this.closePrincipal(principal);
            throw errorWithCode(result.reason === 'provider_unavailable' ? 'WEBTTY_UNAVAILABLE'
                : result.reason === 'administrator_revoked' ? 'WEBTTY_ADMIN_REQUIRED' : 'WEBTTY_AUTH_INVALID');
        }
        if (routePlan?.lease?.commit?.() !== true) throw errorWithCode('WEBTTY_GENERATION_CHANGED');
        if (session.closed || session.closing || this.sessions.get(session.id) !== session) return null;
        if (['input', 'resize', 'control'].includes(need) && principal !== session.owner.principal) {
            throw errorWithCode('WEBTTY_OWNER_REQUIRED');
        }
        if (principal === session.owner.principal && ['input', 'attach'].includes(need)) {
            session.owner.adminAdmittedAt = Math.max(session.owner.adminAdmittedAt, Number(lease.createdAt) || 0);
        }
        return session;
    }

    async validateOwnership(req, routePlan, id) {
        return this.authorize(req, routePlan, id, 'input');
    }

    closePrincipal(principal) {
        return Promise.allSettled([...this.ownerIndex.get(principal) || []]
            .map(id => this.closeOwnerEntry(id, 'owner_admin_revoked')));
    }

    closeOwnerEntry(id, reason) {
        const pending = this.pendingCreations.get(id);
        if (pending) pending.cancellation ||= reason;
        return this.closeSession(id, reason);
    }

    observeAuthenticatedRequest(decision) {
        if (!this.ownerIndex.size) return;
        if (!decision || !['local', 'sso'].includes(decision.authMode)
            || typeof decision.userId !== 'string' || !decision.userId
            || !Array.isArray(decision.roles) || decision.roles.some(role => typeof role !== 'string')
            || decision.roles.some(role => role.trim().toLowerCase() === 'guest')
            || isAdminUser({ roles: decision.roles })
            || !Number.isSafeInteger(decision.decidedAt) || decision.decidedAt <= 0) return;
        const principal = browserPrincipal(decision.authMode, decision.userId);
        for (const id of [...this.ownerIndex.get(principal) || []]) {
            const owned = this.sessions.get(id) || this.pendingCreations.get(id);
            if (owned && decision.decidedAt > owned.owner.adminAdmittedAt) {
                void this.closeOwnerEntry(id, 'owner_admin_revoked').catch(() => {});
            }
        }
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
        session.cols = cols;
        session.rows = rows;
        this.touch(session);
    }

    encodeSse(event, data, id = null) {
        return `${id == null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    removeViewer(session, viewer, { event = '', reason = '', reconnect = false } = {}) {
        if (session.viewers.get(viewer.id) !== viewer) return;
        session.viewers.delete(viewer.id);
        this.viewerCount -= 1;
        const view = viewer.view;
        if (view) {
            view.streams = Math.max(0, view.streams - 1);
            // The last stream of a non-ended view starts its reconnect gap.
            if (!view.streams && !this.viewTerminal(view)) {
                view.state = 'detached';
                view.detachedAt = this.now();
            }
        }
        clearTimeout(viewer.drainTimer);
        viewer.req.removeListener?.('close', viewer.onClose);
        viewer.res.removeListener?.('close', viewer.onClose);
        viewer.res.removeListener?.('drain', viewer.onDrain);
        try { viewer.unsubscribeAuth?.(); } catch (_) { }
        viewer.queue.length = 0;
        viewer.queuedBytes = 0;
        try {
            if (reconnect) viewer.res.write('retry: 1000\n\n');
            else if (event) viewer.res.write(this.encodeSse(event, { reason }));
        } catch (_) { }
        try { viewer.res.end(); } catch (_) { }
    }

    enqueueViewer(session, viewer, encoded) {
        if (!session.viewers.has(viewer.id)) return false;
        viewer.queue.push(encoded);
        viewer.queuedBytes += Buffer.byteLength(encoded);
        if (viewer.queuedBytes > this.limits.viewerQueueBytes) {
            this.removeViewer(session, viewer, { event: 'detached', reason: 'slow_viewer' });
            return false;
        }
        return this.flushViewer(session, viewer);
    }

    flushViewer(session, viewer) {
        if (viewer.waitingDrain) return true;
        while (viewer.queue.length && session.viewers.has(viewer.id)) {
            if (viewer.res.writableEnded || viewer.res.destroyed) {
                this.removeViewer(session, viewer);
                return false;
            }
            const encoded = viewer.queue.shift();
            viewer.queuedBytes -= Buffer.byteLength(encoded);
            try {
                if (viewer.res.write(encoded) === false) {
                    viewer.waitingDrain = true;
                    viewer.drainDeadline = this.now() + this.limits.viewerDrainTimeoutMs;
                    viewer.drainTimer = setTimeout(() => {
                        this.removeViewer(session, viewer, { event: 'detached', reason: 'slow_viewer' });
                    }, this.limits.viewerDrainTimeoutMs);
                    viewer.drainTimer.unref?.();
                    return true;
                }
            } catch (_) {
                this.removeViewer(session, viewer);
                return false;
            }
        }
        return session.viewers.has(viewer.id);
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
        for (const viewer of session.viewers.values()) this.enqueueViewer(session, viewer, encoded);
    }

    assertViewerQuota(session) {
        if (session.viewers.size >= this.limits.viewersPerSession
            || this.viewerCount >= this.limits.viewersGlobal) throw errorWithCode('WEBTTY_VIEWER_QUOTA');
    }

    attachStream(session, req, res, lastEventId = '', routePlan = session?.routePlan, viewId = '') {
        if (!session || session.closed || session.closing) return false;
        if (req.destroyed || req.aborted || res.writableEnded || res.destroyed) return false;
        this.assertViewerQuota(session);
        if (routePlan?.lease?.commit?.() !== true) throw errorWithCode('WEBTTY_GENERATION_CHANGED');
        // Every stream binds to a server view of the same principal.
        const view = this.streamView(session, req, viewId);
        const raw = String(lastEventId || '').trim();
        const requested = raw === '' ? 0 : Number(raw);
        const oldest = session.replay[0]?.sequence || (session.lastSequence + 1);
        if ((raw && !/^\d+$/.test(raw)) || !Number.isSafeInteger(requested) || requested < 0
            || requested > session.lastSequence) {
            res.write(this.encodeSse('reset', { reason: 'replay_gap' }));
            res.end();
            return false;
        }
        const lease = this.auth.createLease(req);
        const principal = browserPrincipal(lease.mode, lease.userId);
        const viewer = {
            id: randomId(), req, res, lease, principal, view,
            role: principal === session.owner.principal ? 'owner' : 'watcher',
            routeLease: routePlan.lease, queue: [], queuedBytes: 0,
            drainDeadline: null, drainTimer: null, waitingDrain: false,
        };
        let admitted = false;
        let invalidated = false;
        const unsubscribe = this.auth.subscribeInvalidation(lease, (reason) => {
            invalidated = true;
            if (!admitted || session.viewers.get(viewer.id) !== viewer) return;
            if (reason === 'administrator_revoked') this.closePrincipal(principal);
            this.removeViewer(session, viewer, { event: 'detached', reason: `auth_${reason}` });
        });
        if (typeof unsubscribe !== 'function') throw errorWithCode('WEBTTY_AUTH_SUBSCRIPTION_INVALID');
        if (invalidated) {
            try { unsubscribe(); } catch (_) { }
            return false;
        }
        viewer.unsubscribeAuth = unsubscribe;
        viewer.onClose = () => this.removeViewer(session, viewer);
        viewer.onDrain = () => {
            clearTimeout(viewer.drainTimer);
            viewer.waitingDrain = false;
            viewer.drainDeadline = null;
            this.flushViewer(session, viewer);
        };
        session.viewers.set(viewer.id, viewer);
        this.viewerCount += 1;
        view.streams += 1;
        view.state = 'open';
        view.detachedAt = null;
        admitted = true;
        req.once('close', viewer.onClose);
        res.once?.('close', viewer.onClose);
        res.on?.('drain', viewer.onDrain);
        if (req.destroyed || req.aborted || res.writableEnded || res.destroyed) {
            viewer.onClose();
            return false;
        }
        if (!this.enqueueViewer(session, viewer, ': connected\n\n')) return false;
        if (requested < oldest - 1) {
            if (!this.enqueueViewer(session, viewer, this.encodeSse(raw ? 'resync' : 'replay-truncated', {}))) return false;
        }
        for (const event of session.replay) {
            if (event.sequence > requested && !this.enqueueViewer(session, viewer, event.encoded)) return false;
        }
        session.everAttached = true;
        clearTimeout(session.detachTimer);
        session.detachTimer = null;
        if (viewer.role === 'owner') {
            session.owner.adminAdmittedAt = Math.max(session.owner.adminAdmittedAt, Number(lease.createdAt) || 0);
        }
        this.touch(session);
        return true;
    }

    scheduleDetachedClose(session, reason) {
        clearTimeout(session.detachTimer);
        session.detachTimer = setTimeout(() => {
            session.detachTimer = null;
            if (!session.everAttached) void this.closeSession(session, reason);
        }, this.limits.streamDetachGraceMs);
        session.detachTimer.unref?.();
    }

    // A close outcome starts `pending` and is retained until router restart
    // unless it settles as `proven`, which keeps the usual short lifetime.
    addTombstone(session) {
        const now = this.now();
        const tombstone = {
            expiresAt: Infinity,
            principal: session.owner.principal,
            binding: session.binding,
            row: this.displayRow(session, session.owner.principal, now),
            closure: 'pending',
            closureScope: '',
            recordCleanup: '',
        };
        session.tombstone = tombstone;
        this.tombstones.delete(session.id);
        this.tombstones.set(session.id, tombstone);
        this.trimTombstones(now);
    }

    trimTombstones(now = this.now()) {
        if (this.tombstones.size <= this.limits.maxTombstones) return;
        for (const [id, tombstone] of this.tombstones) {
            if (now >= tombstone.expiresAt) this.tombstones.delete(id);
        }
        while (this.tombstones.size > this.limits.maxTombstones) {
            let victim = null;
            for (const entry of this.tombstones) {
                if (entry[1].closure === 'proven') { victim = entry; break; }
            }
            if (!victim) {
                victim = this.tombstones.entries().next().value;
                this.safeAudit('webtty_tombstone_evicted', { id: this.auditId(victim[0]), closure: victim[1].closure });
            }
            this.tombstones.delete(victim[0]);
        }
    }

    settleClosure(session, closure, { scope = '', recordCleanupFailed = false } = {}) {
        const tombstone = session.tombstone;
        if (!tombstone || tombstone.closure !== 'pending') return;
        tombstone.closure = closure;
        if (closure === 'unconfirmed' && CLEANUP_FAILURE_SCOPE_RANK[scope]) tombstone.closureScope = scope;
        if (recordCleanupFailed) tombstone.recordCleanup = 'failed';
        if (closure === 'proven') tombstone.expiresAt = this.now() + this.limits.tombstoneLifetimeMs;
    }

    // Records the widest safety scope this session's cleanup failure disabled.
    noteCleanupFailure(session, scope) {
        if ((CLEANUP_FAILURE_SCOPE_RANK[scope] || 0) > (CLEANUP_FAILURE_SCOPE_RANK[session.cleanupFailureScope] || 0)) {
            session.cleanupFailureScope = scope;
        }
    }

    matchesTombstone(req, routePlan, id) {
        const tombstone = this.tombstones.get(String(id || ''));
        if (!tombstone) return false;
        if (this.now() >= tombstone.expiresAt) {
            this.tombstones.delete(String(id || ''));
            return false;
        }
        const requestBinding = routeBinding(routePlan);
        this.auth.createLease(req);
        return bindingMatches(tombstone.binding, requestBinding);
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
        // A close of any kind owns cleanup; a pending tab-close stop never runs.
        this.clearPendingStop(session);
        session.validationEpoch += 1;
        session.targetValidation?.controller.abort();
        session.closeReason = reason;
        this.sessions.delete(session.id);
        const owned = this.ownerIndex.get(session.owner.principal);
        owned?.delete(session.id);
        if (!owned?.size) this.ownerIndex.delete(session.owner.principal);
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
        for (const viewer of session.viewers.values()) {
            this.removeViewer(session, viewer, { event: 'exit', reason });
        }
        if (!workerExited) {
            try { await session.worker.close(); } catch (_) { }
        }
        let exited = workerExited;
        if (!exited) {
            // A wait that throws is an unconfirmed exit and fails closed below.
            try { exited = await session.worker.waitForExit(); } catch (_) { exited = false; }
        }
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
                this.noteCleanupFailure(session, 'global');
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
                try {
                    Promise.resolve(this.audit('webtty_reclamation_check_failed', {
                        targetKind: session.target.kind === 'agent' ? 'agent' : 'box',
                        reason: reclamationAuditReason(error),
                    })).catch(() => {});
                } catch (_) { }
                if (session.target.kind === 'agent') {
                    cleanupFailureScope = classifyAgentEvidenceFailure(error);
                    if (cleanupFailureScope === 'provider') {
                        this.disableAgentProvider(cleanupFailureCategory);
                    }
                }
            }
        }
        const mustPreserve = preserveRecord || session.preserveRecord || !cleanupProven;
        // The reported outcome follows the branch that actually ran: proven
        // only after confirmed exit and proven reclamation, otherwise the
        // scope that the existing fail-closed handling disabled.
        let closure = 'unconfirmed';
        let recordCleanupFailed = false;
        if (!exited) {
            session.preserveRecord = true;
            if (session.target.kind === 'agent') {
                this.noteCleanupFailure(session, 'provider');
                this.disableAgentProvider('worker_exit_unconfirmed');
            } else {
                this.noteCleanupFailure(session, 'global');
                this.disableForUnprovenCleanup('worker_exit_unconfirmed', session);
            }
        } else if ((session.recordHandle || session.initRequested) && mustPreserve) {
            const category = cleanupFailureCategory || (session.preserveRecord && this.disabledCategory
                ? this.disabledCategory
                : 'terminal_cleanup_unproven');
            session.preserveRecord = true;
            if (session.target.kind === 'agent') {
                if (cleanupFailureScope === 'global') {
                    this.noteCleanupFailure(session, 'global');
                    this.disableForUnprovenCleanup(category, session);
                } else if (cleanupFailureScope === 'provider') {
                    this.noteCleanupFailure(session, 'provider');
                    this.disableAgentProvider(category);
                } else {
                    this.noteCleanupFailure(session, 'target');
                    this.quarantineAgentTarget(session.target, category);
                }
            } else {
                this.noteCleanupFailure(session, 'global');
                this.disableForUnprovenCleanup(category, session);
            }
        } else {
            if (session.recordHandle && !recordAlreadyRemoved) {
                try {
                    const removed = await this.recordStore.remove(session.recordHandle);
                    if (removed !== true) {
                        recordCleanupFailed = true;
                        this.disableForRecordRemovalFailure(
                            session,
                            'recovery_record_remove_unconfirmed',
                            'agent_record_remove_unconfirmed',
                        );
                    }
                } catch (_) {
                    recordCleanupFailed = true;
                    this.disableForRecordRemovalFailure(
                        session,
                        'recovery_record_remove_failed',
                        'agent_record_remove_failed',
                    );
                }
            }
            // An earlier cleanup failure of this session (for example a
            // worker cleanup-unproven report) still makes the stop unproven.
            if (!session.cleanupFailureScope) closure = 'proven';
        }
        this.settleClosure(session, closure, { scope: session.cleanupFailureScope, recordCleanupFailed });
        return true;
        } finally {
            // Nothing leaves this path still `pending`: an unexpected failure
            // is an unconfirmed stop.
            this.settleClosure(session, 'unconfirmed', { scope: session.cleanupFailureScope });
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

    async closeAuthorized(req, routePlan, id) {
        const session = await this.authorize(req, routePlan, id, 'stop');
        if (session) return this.closeSession(session, 'requested');
        await this.validatedLease(req);
        if (routePlan?.lease?.commit?.() !== true) throw errorWithCode('WEBTTY_GENERATION_CHANGED');
        try { return this.matchesTombstone(req, routePlan, id); } catch (_) { return false; }
    }

    async closeOwned(req, routePlan, id) {
        return this.closeAuthorized(req, routePlan, id);
    }

    async validateViewer(session, viewer, now) {
        if (viewer.authPending) return;
        viewer.authPending = true;
        try {
            const auth = await this.auth.validateLease(viewer.lease);
            if (!session.viewers.has(viewer.id)) return;
            if (auth.ok) {
                viewer.authUndecidedSince = null;
            } else if (auth.reason === 'provider_unavailable') {
                if (!Number.isFinite(viewer.authUndecidedSince)) viewer.authUndecidedSince = now;
                if (now - viewer.authUndecidedSince >= this.limits.authenticationOutageLimitMs) {
                    this.removeViewer(session, viewer, { event: 'detached', reason: 'auth_provider_unavailable' });
                }
            } else {
                if (auth.reason === 'administrator_revoked') await this.closePrincipal(viewer.principal);
                this.removeViewer(session, viewer, { event: 'detached', reason: `auth_${auth.reason}` });
            }
        } catch (_) {
            this.removeViewer(session, viewer, { event: 'detached', reason: 'auth_validation_failed' });
        } finally {
            viewer.authPending = false;
        }
    }

    markTargetUndecided(session) {
        if (!Number.isFinite(session.targetUndecidedSince)) session.targetUndecidedSince = this.now();
    }

    startTargetValidation(session) {
        if (session.targetValidation || session.closed || session.closing || session.startupInProgress) return;
        const epoch = ++session.validationEpoch;
        const controller = new AbortController();
        const validation = { controller, epoch, promise: null };
        session.targetValidation = validation;
        const current = () => this.sessions.get(session.id) === session
            && !session.closed && !session.closing && session.validationEpoch === epoch;
        const timer = setTimeout(() => {
            if (!current()) return;
            this.markTargetUndecided(session);
            session.validationEpoch += 1;
            controller.abort();
        }, this.limits.targetValidationDeadlineMs);
        timer.unref?.();
        validation.promise = (async () => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                if (!current()) return;
                try {
                    const plan = this.capturePlan ? this.capturePlan() : session.routePlan;
                    await this.targetResolver.revalidateRunningAgent({
                        routePlan: plan, target: session.target, signal: controller.signal,
                        agentProviderAvailable: this.agentProviderReady,
                    });
                    if (current()) session.targetUndecidedSince = null;
                    return;
                } catch (error) {
                    if (!current()) return;
                    if (error?.code === 'WEBTTY_TARGET_GENERATION_STALE') continue;
                    if (error?.code === 'WEBTTY_TARGET_IDENTITY_STALE') {
                        void this.closeSession(session, 'target_identity_changed').catch(() => {});
                    } else if (error?.code === 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE') {
                        this.disableAgentProvider('target_provider_unavailable');
                    } else this.markTargetUndecided(session);
                    return;
                }
            }
            if (current()) this.markTargetUndecided(session);
        })().finally(() => {
            clearTimeout(timer);
            controller.abort();
            if (session.targetValidation === validation) session.targetValidation = null;
        });
        void validation.promise.catch(() => {});
    }

    async validateLiveSessions() {
        if (this.closed) return;
        const now = this.now();
        for (const sessionFingerprint of this.launchAuthSubscriptions.keys()) {
            this.cleanupLaunchSubscription(sessionFingerprint);
        }
        const sessions = [...this.sessions.values()];
        const shortChecks = [];
        for (const session of sessions) {
            if (session.closed || session.closing || session.startupInProgress) continue;
            let reason = '';
            if (now - session.createdAt >= this.limits.absoluteLifetimeMs) reason = 'absolute_timeout';
            else if (now - session.lastActivityAt >= this.limits.idleLifetimeMs) reason = 'idle_timeout';
            else if (Number.isFinite(session.targetUndecidedSince)
                && now - session.targetUndecidedSince >= this.limits.targetUndecidedLimitMs) reason = 'target_unverifiable';
            if (reason) { shortChecks.push(this.closeSession(session, reason)); continue; }
            for (const viewer of session.viewers.values()) {
                if (viewer.routeLease?.isCurrent?.() !== true) {
                    this.removeViewer(session, viewer, { reconnect: true });
                } else if (viewer.waitingDrain && now >= viewer.drainDeadline) {
                    this.removeViewer(session, viewer, { event: 'detached', reason: 'slow_viewer' });
                } else if (Number.isFinite(viewer.authUndecidedSince)
                    && now - viewer.authUndecidedSince >= this.limits.authenticationOutageLimitMs) {
                    this.removeViewer(session, viewer, { event: 'detached', reason: 'auth_provider_unavailable' });
                } else shortChecks.push(this.validateViewer(session, viewer, now));
            }
        }
        const agents = sessions.filter(session => session.target.kind === 'agent');
        for (let offset = 0; offset < agents.length; offset += 1) {
            this.startTargetValidation(agents[(this.validationStartIndex + offset) % agents.length]);
        }
        if (agents.length) this.validationStartIndex = (this.validationStartIndex + 1) % agents.length;
        // Target inspections never delay viewer generation/auth/lifetime checks.
        await Promise.allSettled(shortChecks);
    }

    async closeAll(reason = 'router_shutdown') {
        if (!this.closed) {
            this.closed = true;
            this.ready = false;
            this.disabledCategory = 'shutting_down';
            clearInterval(this.leaseTimer);
            for (const session of this.sessions.values()) this.clearPendingStop(session);
            for (const unsubscribe of this.launchAuthSubscriptions.values()) {
                try { unsubscribe(); } catch (_) { }
            }
            this.launchAuthSubscriptions.clear();
            for (const pending of this.pendingCreations.values()) pending.cancellation ||= reason;
        }
        const requested = [...this.sessions.values()].map((session) => (
            this.closeSession(session, reason)
        ));
        await Promise.allSettled([...requested, ...this.inFlightCloses]);
    }
}

export default WebttySessionManager;
