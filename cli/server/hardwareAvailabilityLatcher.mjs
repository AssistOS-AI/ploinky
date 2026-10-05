// Router-process latcher of hardware-availability slots (M-NW-01 D2-S, D2S.11). RECOVERY ONLY.
//
// A refused background launch activates its slot by the worker's own durable terminal rename; that is
// what denies, and it is what the 5 s claim rests on. This component never creates or advances an
// activation. It only resolves slots whose run already reached a terminal status, into committed
// entries (or retires them), so the denial survives later loss of the evidence file. Every commit is
// logged as recovery and earns no credit toward the A7/A8 timing rows.
//
// It is fail-fast on every lock and never waits:
//   - a resolver signal only sets a flag and schedules `setTimeout(attempt, 0).unref()` from the
//     Router's own start-up context, so a locked attempt never runs inside a capture's call stack and
//     never inherits a capture's lock context;
//   - an unlocked pre-filter takes no lock unless the store is valid, no preparation is outstanding,
//     the selector is active and at least one applicable slot is terminal;
//   - the locked attempt takes a fresh workspace lease (BUSY and RECOVERY_REQUIRED defer), the network
//     lock with `waitMs: 0`, and the apply lock (EDGE_GENERATION_BUSY and EDGE_PREPARATION_BUSY
//     defer), and then writes one policy rename through the shared resolve planner, which proves the
//     effective revision is unchanged.

import { AsyncResource } from 'node:async_hooks';

import { SLOT_TERMINAL_CLASSES, commitNoWaitAvailabilitySlotPlan } from '../commands/noWaitAvailabilitySlots.js';
import {
    loadActiveEdgeRoutingGeneration,
    readEdgeRoutingPreparationOwner,
    readEdgeRoutingSelection,
    resolveEdgeGenerationPaths,
    withEdgeGenerationApplyLock,
} from '../sandbox/edgeGeneration.js';
import {
    HARDWARE_AVAILABILITY_DURABILITY_UNCONFIRMED,
    commitHardwareAvailabilityPolicy,
    readHardwareAvailabilityPolicy,
} from '../sandbox/hardwareAvailabilityStore.mjs';
import { withNetworkLifecycleLock } from '../sandbox/networkLifecycle.js';
import {
    createWorkspaceMutationLease,
    releaseWorkspaceMutationLease,
    runWithWorkspaceMutationLease,
} from '../utils/runtime/maintenanceLocks.js';
import {
    createHardwareAvailabilityResolverCache,
    evaluateHardwareAvailabilityOfStore,
    subscribeHardwareAvailabilityTerminalSlots,
} from './hardwareAvailabilityResolver.mjs';
import { appendLog } from './utils/logger.js';

export const LATCH_OPERATION = 'hardware-availability-latch';
export const LATCH_RETRY_MS = 1000;
export const LATCH_POLL_MS = 10_000;

// A lock held by someone else (or a lease that needs recovery) is never an error: the attempt defers.
const DEFERRAL_CODES = Object.freeze([
    'PLOINKY_WORKSPACE_MUTATION_BUSY',
    'PLOINKY_WORKSPACE_MUTATION_RECOVERY_REQUIRED',
    'PLOINKY_NETWORK_LIFECYCLE_BUSY',
    'EDGE_GENERATION_BUSY',
    'EDGE_PREPARATION_BUSY',
]);

const messageOf = (error) => String(error?.message || error).slice(0, 300);

/**
 * createHardwareAvailabilityLatcher(options) -> { start, stop, signal, attempt, isRunning }
 *
 * Every collaborator is a seam with the real one as its default, so a test can record the exact lock
 * calls (and prove `waitMs: 0`) without touching the lock files.
 */
export function createHardwareAvailabilityLatcher({
    workspaceRoot,
    runningDir,
    log = appendLog,
    now = Date.now,
    retryMs = LATCH_RETRY_MS,
    pollMs = LATCH_POLL_MS,
    timers = { setTimeout, clearTimeout, setInterval, clearInterval },
    subscribe = subscribeHardwareAvailabilityTerminalSlots,
    locks = {
        createLease: createWorkspaceMutationLease,
        releaseLease: releaseWorkspaceMutationLease,
        runWithLease: runWithWorkspaceMutationLease,
        networkLock: withNetworkLifecycleLock,
        applyLock: withEdgeGenerationApplyLock,
    },
    hooks = {},
} = {}) {
    const edgeOptions = { workspaceRoot };
    const cache = createHardwareAvailabilityResolverCache();
    let started = false;
    let origin = null;
    let unsubscribe = null;
    let timer = null;
    let timerDueAt = 0;
    let lockedTimer = null;
    let poll = null;
    let blockedUntil = 0;
    let lastState = null;

    // Log a deferral or failure once per state change; a commit or an idle pass resets the state.
    const report = (event, state, data) => {
        if (lastState === state) return;
        lastState = state;
        log(event, { ...data, recovery: true });
    };

    function schedule(delayMs) {
        if (!started) return;
        const dueAt = now() + delayMs;
        if (timer && timerDueAt <= dueAt) return;
        if (timer) timers.clearTimeout(timer);
        timerDueAt = dueAt;
        // From the start-up context, never from the signalling capture's.
        timer = origin.runInAsyncScope(() => timers.setTimeout(() => {
            timer = null;
            runScheduled();
        }, delayMs));
        timer.unref?.();
    }

    function defer(reason, detail = {}) {
        blockedUntil = now() + retryMs;
        report('hardware_availability_latch_deferred', `deferred:${reason}`, { reason, ...detail });
        schedule(retryMs);
        return { outcome: 'deferred', reason };
    }

    function fail(error) {
        blockedUntil = now() + retryMs;
        const code = error?.code || 'error';
        report('hardware_availability_latch_failed', `failed:${code}`, { code, message: messageOf(error) });
        schedule(retryMs);
        return { outcome: 'failed', code };
    }

    // The unlocked pre-filter: no lock call is made unless every condition holds.
    function prefilter() {
        const paths = resolveEdgeGenerationPaths(edgeOptions);
        let store;
        try {
            store = readHardwareAvailabilityPolicy({ paths });
        } catch (error) {
            return { result: defer('store-unreadable', { code: error?.code || null }) };
        }
        if (store.state !== 'valid' || Object.keys(store.slots).length === 0) {
            lastState = null;
            return { result: { outcome: 'idle' } };
        }
        let selector;
        try {
            ({ selector } = readEdgeRoutingSelection(edgeOptions));
        } catch (error) {
            return { result: defer('selector-unavailable', { code: error?.code || null }) };
        }
        if (selector.state !== 'active') return { result: defer('selector-inactive') };
        let preparation;
        try {
            preparation = readEdgeRoutingPreparationOwner(edgeOptions);
        } catch (error) {
            return { result: defer('preparation-unreadable', { code: error?.code || null }) };
        }
        if (preparation) return { result: defer('preparation-outstanding') };
        let generation;
        try {
            ({ generation } = loadActiveEdgeRoutingGeneration(edgeOptions));
        } catch (error) {
            return { result: defer('generation-unavailable', { code: error?.code || null }) };
        }
        const evaluation = evaluateHardwareAvailabilityOfStore({
            store, generation, paths, ...(runningDir ? { runningDir } : {}), nowMs: now(), cache,
        });
        const terminal = [...evaluation.slots.values()].some(({ evidenceClass }) => SLOT_TERMINAL_CLASSES.includes(evidenceClass));
        if (!terminal) {
            lastState = null;
            return { result: { outcome: 'idle' } };
        }
        return { store };
    }

    function logResolutions({ plan, store, durability }) {
        for (const resolution of plan.resolutions) {
            const entry = plan.entries[resolution.routeKey];
            const slot = store.slots[resolution.routeKey];
            const latched = resolution.resolution === 'latched' && entry;
            log('hardware_availability_latched', {
                routeKey: resolution.routeKey,
                key: latched ? entry.projection.key : slot?.key,
                runId: resolution.runId,
                runStartedAtMs: latched ? entry.source.runStartedAtMs : slot?.runStartedAtMs,
                finishedAtMs: latched ? entry.source.finishedAtMs : undefined,
                code: latched ? entry.projection.problem.code : undefined,
                reasonCode: latched ? entry.projection.problem.reasonCode : undefined,
                resolution: resolution.resolution,
                ...(resolution.evidenceClass ? { evidenceClass: resolution.evidenceClass } : {}),
                ...(durability ? { durabilityUnconfirmed: true } : {}),
                recovery: true,
            });
        }
    }

    // The locked attempt, synchronously. Never throws.
    function lockedAttempt(store) {
        try {
            let lease;
            try {
                lease = locks.createLease({ operation: LATCH_OPERATION });
            } catch (error) {
                if (DEFERRAL_CODES.includes(error?.code)) return defer(error.code);
                return fail(error);
            }
            let committed;
            let durability = null;
            try {
                committed = locks.runWithLease(lease, () => locks.networkLock(() => locks.applyLock(
                    (applyLockCapability) => commitNoWaitAvailabilitySlotPlan({
                        mode: 'resolve',
                        workspaceRoot,
                        applyLockCapability,
                        ...(runningDir ? { runningDir } : {}),
                        log,
                        cache,
                        commit: (args) => {
                            try {
                                return commitHardwareAvailabilityPolicy({
                                    ...args,
                                    ...(hooks.beforeRename ? { beforeRename: hooks.beforeRename } : {}),
                                    ...(hooks.faults ? { faults: hooks.faults } : {}),
                                });
                            } catch (error) {
                                // The rename happened: the commit stands, and is never rolled back.
                                if (error?.code !== HARDWARE_AVAILABILITY_DURABILITY_UNCONFIRMED || error.committed !== true) throw error;
                                durability = error;
                                return Object.freeze({ committed: true, revision: error.revision });
                            }
                        },
                    }),
                    edgeOptions,
                ), { waitMs: 0 }));
            } catch (error) {
                if (DEFERRAL_CODES.includes(error?.code)) return defer(error.code);
                return fail(error);
            } finally {
                try {
                    if (!locks.releaseLease(lease)) report('hardware_availability_latch_failed', 'failed:lease-release', { code: 'lease-release', message: 'the latch lease could not be released' });
                } catch (error) {
                    report('hardware_availability_latch_failed', 'failed:lease-release', { code: error?.code || 'lease-release', message: messageOf(error) });
                }
            }
            lastState = null;
            if (!committed.result.committed) {
                // The pre-filter saw a terminal slot and the planner found nothing to change: never a storm of attempts.
                blockedUntil = now() + retryMs;
                return { outcome: 'unchanged' };
            }
            blockedUntil = 0;
            logResolutions({ plan: committed.plan, store, durability });
            return { outcome: 'committed', resolutions: committed.plan.resolutions, revision: committed.result.revision };
        } catch (error) {
            return fail(error);
        }
    }

    /** One whole attempt, synchronously: the unlocked pre-filter, then the locked commit. Never throws. */
    function attempt() {
        try {
            const filtered = prefilter();
            if (filtered.result) return filtered.result;
            return lockedAttempt(filtered.store);
        } catch (error) {
            return fail(error);
        }
    }

    // A scheduled attempt is two event-loop turns, so the Router's loop is blocked by at most one bounded
    // synchronous section (the generation read and evaluation, or the locked commit), never by both.
    function runScheduled() {
        if (!started) return;
        try {
            const filtered = prefilter();
            if (filtered.result) return;
            const { store } = filtered;
            lockedTimer = origin.runInAsyncScope(() => timers.setTimeout(() => {
                lockedTimer = null;
                if (started) lockedAttempt(store);
            }, 0));
            lockedTimer.unref?.();
        } catch (error) {
            fail(error);
        }
    }

    // A resolver signal: set the flag, schedule, return. No lock, no read, no log here.
    function signal() {
        if (!started || now() < blockedUntil) return;
        schedule(0);
    }

    function start() {
        if (started) return;
        started = true;
        origin = new AsyncResource('hardware-availability-latcher');
        unsubscribe = subscribe(signal);
        poll = origin.runInAsyncScope(() => timers.setInterval(() => {
            if (now() >= blockedUntil) schedule(0);
        }, pollMs));
        poll.unref?.();
        // A Router that starts with a terminal slot already on disk latches it at its first unblocked attempt.
        schedule(0);
    }

    function stop() {
        started = false;
        if (unsubscribe) unsubscribe();
        unsubscribe = null;
        if (timer) timers.clearTimeout(timer);
        timer = null;
        if (lockedTimer) timers.clearTimeout(lockedTimer);
        lockedTimer = null;
        if (poll) timers.clearInterval(poll);
        poll = null;
        origin = null;
        blockedUntil = 0;
        lastState = null;
    }

    return Object.freeze({ start, stop, signal, attempt, isRunning: () => started });
}

// The Router's one latcher: `start()` after the metrics monitor, `stop()` first in `beforeClose`.
export const hardwareAvailabilityLatcher = createHardwareAvailabilityLatcher();
