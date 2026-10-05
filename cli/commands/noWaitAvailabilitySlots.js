// Staged late-outcome slots of the hardware-availability store (M-NW-01 D2-S).
//
//   planNoWaitAvailabilitySlots   the pure shared planner, in two modes:
//       'resolve'  terminal slots only (the rule the Router-process latcher shares)
//       'staging'  resolve, then retire superseded slots and stale entries, then add
//                  one slot per run that start is about to spawn
//   stageNoWaitAvailabilitySlots  start's one D1 commit, under the apply lock
//
// Nothing here reads a marker, lists a directory or waits on a lock beyond one bounded
// busy-acquire of the apply lock. Slot evidence is classified by the resolver's own code
// (the planner evaluates the store it read and the store it plans to commit through
// `evaluateHardwareAvailabilityOfStore`), so applicability is never forked.

import {
    assertEdgeGenerationApplyLockCapability,
    loadActiveEdgeRoutingGeneration,
    resolveEdgeGenerationPaths,
    withEdgeGenerationApplyLock,
} from '../sandbox/edgeGeneration.js';
import {
    commitHardwareAvailabilityPolicy,
    readHardwareAvailabilityPolicy,
} from '../sandbox/hardwareAvailabilityStore.mjs';
import {
    TERMINAL_SLOT_EVIDENCE_CLASSES,
    createHardwareAvailabilityResolverCache,
    evaluateHardwareAvailabilityOfStore,
    routeIsTargetLess,
} from '../server/hardwareAvailabilityResolver.mjs';
import { appendLog } from '../server/utils/logger.js';

export const HARDWARE_AVAILABILITY_RESOLVE_REVISION_CHANGED = 'HARDWARE_AVAILABILITY_RESOLVE_REVISION_CHANGED';
export const SLOT_TERMINAL_CLASSES = TERMINAL_SLOT_EVIDENCE_CLASSES;
export const APPLY_LOCK_BUSY_RETRY_MS = 2000;
const APPLY_LOCK_BUSY_POLL_MS = 25;

const sameTuple = (left, right) => Boolean(left && right)
    && left.key === right.key && left.instanceId === right.instanceId && left.enableGeneration === right.enableGeneration;

const entryTuple = (entry) => ({
    key: entry.projection.key,
    instanceId: entry.projection.instanceId,
    enableGeneration: entry.projection.enableGeneration,
});

function sortedRouteKeys(object) {
    return Object.keys(object).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

// The tuple an entry names is current only while the generation's registry still carries exactly it.
function tupleIsCurrent(tuple, generation) {
    const agent = generation?.agents?.[tuple.key];
    return Boolean(agent) && agent.instanceId === tuple.instanceId && agent.enableGeneration === tuple.enableGeneration;
}

// A published runtime target on the route of exactly this tuple: the successor of the slot's run is ready.
function routeNowTargeted(slot, routeKey, generation) {
    const route = generation?.routing?.routes?.[routeKey];
    return Boolean(route) && route.container === slot.key && tupleIsCurrent(slot, generation) && !routeIsTargetLess(route);
}

/**
 * planNoWaitAvailabilitySlots({ mode, store, generation, evaluation, spawned, startupGraceMs })
 *   -> { entries, slots, resolutions, resolved: { entries, slots }, changed }
 *
 *   store       the valid D1 snapshot that was read
 *   evaluation  evaluateHardwareAvailabilityOfStore() of that snapshot against the active generation
 *   spawned     [{ routeKey, slot }] the runs start is about to spawn (staging only); parent-known nodes are not listed
 *   resolved    the store after the terminal resolutions alone: its effective revision must equal the evaluated one
 *
 * Pass 1 (both modes). For each slot S that is applicable to the generation and terminal:
 *   active           latch into a committed entry, retire S, and replace the same-routeKey entry
 *   succeeded / failed-generic   retire S and the same-routeKey entry of S's tuple
 * Pass 2 (staging only). Retire slots that are not applicable; retire a non-terminal slot whose route is
 * respawned; retire entries whose tuple is no longer current; add one slot per spawned run.
 */
export function planNoWaitAvailabilitySlots({
    mode,
    store,
    generation,
    evaluation,
    spawned = [],
    startupGraceMs = 0,
} = {}) {
    if (mode !== 'staging' && mode !== 'resolve') throw new Error(`unknown availability planning mode '${String(mode)}'`);
    const entries = { ...store.entries };
    const slots = { ...store.slots };
    const resolutions = [];
    const applicable = evaluation.slots;
    const supersedeEntry = (routeKey, tuple) => {
        if (entries[routeKey] && sameTuple(entryTuple(entries[routeKey]), tuple)) delete entries[routeKey];
    };

    for (const routeKey of sortedRouteKeys(store.slots)) {
        const slot = store.slots[routeKey];
        const evidence = applicable.get(routeKey);
        if (!evidence || evidence.runId !== slot.runId || !SLOT_TERMINAL_CLASSES.includes(evidence.evidenceClass)) continue;
        delete slots[routeKey];
        if (evidence.evidenceClass === 'active') {
            const projection = evaluation.projections.get(routeKey);
            entries[routeKey] = {
                projection: structuredClone(projection),
                source: {
                    kind: 'no-wait-terminal',
                    runId: slot.runId,
                    runStartedAtMs: slot.runStartedAtMs,
                    waveIndex: slot.waveIndex,
                    statusFile: slot.statusFile,
                    finishedAtMs: Date.parse(projection.observedAt),
                },
            };
            resolutions.push({ routeKey, runId: slot.runId, resolution: 'latched' });
        } else {
            supersedeEntry(routeKey, slot);
            resolutions.push({ routeKey, runId: slot.runId, resolution: 'retired', evidenceClass: evidence.evidenceClass });
        }
    }
    const resolved = { entries: { ...entries }, slots: { ...slots } };

    if (mode === 'staging') {
        const respawned = new Set(spawned.map(({ routeKey }) => routeKey));
        for (const routeKey of sortedRouteKeys(slots)) {
            const slot = slots[routeKey];
            const evidence = applicable.get(routeKey);
            if (!evidence || evidence.runId !== slot.runId) {
                // Not applicable to the generation any more. When the successor of the run published a target,
                // the same-tuple entry it superseded goes with the slot; otherwise only the slot goes.
                delete slots[routeKey];
                if (routeNowTargeted(slot, routeKey, generation)) supersedeEntry(routeKey, slot);
                resolutions.push({ routeKey, runId: slot.runId, resolution: 'retired-not-applicable' });
            } else if (respawned.has(routeKey)) {
                delete slots[routeKey];
                resolutions.push({ routeKey, runId: slot.runId, resolution: 'retired-respawned', evidenceClass: evidence.evidenceClass });
            }
        }
        for (const routeKey of sortedRouteKeys(entries)) {
            if (!tupleIsCurrent(entryTuple(entries[routeKey]), generation)) {
                delete entries[routeKey];
                resolutions.push({ routeKey, resolution: 'retired-stale-entry' });
            }
        }
        for (const { routeKey, slot } of spawned) {
            slots[routeKey] = { ...slot, startupGraceMs: slot.startupGraceMs ?? startupGraceMs };
        }
    }
    const changed = JSON.stringify([entries, slots]) !== JSON.stringify([store.entries, store.slots]);
    return { entries, slots, resolutions, resolved, changed };
}

// The effective revision of a hypothetical store content against the same generation.
function evaluateHypothetical({ store, content, generation, paths, runningDir, nowMs, fsApi, cache }) {
    return evaluateHardwareAvailabilityOfStore({
        store: { ...store, entries: content.entries, slots: content.slots },
        generation, paths, runningDir, nowMs, fsApi, cache,
    });
}

/**
 * Plan and commit one D1 policy change under the apply lock the caller holds (`applyLockCapability`).
 * Reads the store, evaluates it against the active generation, plans, proves the resolve invariant (the
 * effective revision is equal before and after the terminal resolutions) and writes ONE commit. Any failure
 * throws with the store unchanged.
 * `cache` is an evidence cache the caller may share (the latcher hands over the one its own read just warmed);
 * evidence is re-read whenever its file's stat identity changed, so a shared cache never serves stale evidence.
 */
export function commitNoWaitAvailabilitySlotPlan({
    mode,
    workspaceRoot,
    applyLockCapability,
    spawned = [],
    startupGraceMs = 0,
    nowMs = Date.now(),
    runningDir,
    fsApi,
    cache = createHardwareAvailabilityResolverCache(),
    plan: planner = planNoWaitAvailabilitySlots,
    commit = commitHardwareAvailabilityPolicy,
    log = appendLog,
} = {}) {
    const edgeOptions = { workspaceRoot };
    const paths = resolveEdgeGenerationPaths(edgeOptions);
    const store = readHardwareAvailabilityPolicy({ paths, ...(fsApi ? { fsApi } : {}) });
    if (store.state !== 'valid') {
        const error = new Error('the hardware availability store is not initialized; staging needs a valid store');
        error.code = 'HARDWARE_AVAILABILITY_POLICY_UNREADABLE';
        throw error;
    }
    const { generation } = loadActiveEdgeRoutingGeneration(edgeOptions);
    const evaluationOptions = { generation, paths, runningDir, nowMs, ...(fsApi ? { fsApi } : {}), cache };
    const evaluation = evaluateHardwareAvailabilityOfStore({ store, ...evaluationOptions });
    const plan = planner({ mode, store, generation, evaluation, spawned, startupGraceMs });
    // The resolve invariant: resolving terminal slots never changes what any capture is denied.
    const after = evaluateHypothetical({ store, content: plan.resolved, ...evaluationOptions });
    if (after.revision !== evaluation.revision) {
        log('hardware_availability_resolve_aborted', { mode, before: evaluation.revision, after: after.revision });
        const error = new Error('the planned availability resolution would change the effective revision; nothing was committed');
        error.code = HARDWARE_AVAILABILITY_RESOLVE_REVISION_CHANGED;
        throw error;
    }
    const result = plan.changed
        ? commit({
            paths,
            assertApplyLock: (storePaths) => assertEdgeGenerationApplyLockCapability({ ...edgeOptions, applyLockCapability, storePaths }),
            expectedRevision: store.revision,
            entries: plan.entries,
            slots: plan.slots,
            ...(fsApi ? { fsApi } : {}),
        })
        : { committed: false, revision: store.revision };
    return { plan, result, store, effectiveRevision: { before: evaluation.revision, after: after.revision } };
}

/**
 * One bounded acquisition of the apply lock: EDGE_GENERATION_BUSY is retried for at most
 * `maxWaitMs`, any other failure and the last BUSY propagate. It is the only waiting that
 * staging and sites R and T do.
 */
export async function withBoundedApplyLock(callback, {
    workspaceRoot,
    maxWaitMs = APPLY_LOCK_BUSY_RETRY_MS,
    pollMs = APPLY_LOCK_BUSY_POLL_MS,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    withLock = withEdgeGenerationApplyLock,
} = {}) {
    const deadline = now() + maxWaitMs;
    for (;;) {
        try {
            return await withLock(callback, { workspaceRoot });
        } catch (error) {
            if (error?.code !== 'EDGE_GENERATION_BUSY' || now() >= deadline) throw error;
            await sleep(pollMs);
        }
    }
}

/**
 * Start's staging commit (D2S.4): between status clearing and the spawn loop, while start holds the
 * workspace lease and the network lock, inside the apply lock. `schedule` is start's bound no-wait
 * schedule; `isParentKnown(entry)` names the nodes the parent already settled (they get no slot).
 * Any failure throws, and start aborts before any marker or spawn.
 */
export async function stageNoWaitAvailabilitySlots({
    schedule,
    isParentKnown = () => false,
    workspaceRoot,
    startupGraceMs,
    ...options
} = {}) {
    const spawned = [];
    for (const entry of (schedule || []).flat()) {
        if (!entry?.registryName || !entry.statusFile || !entry.identity || isParentKnown(entry)) continue;
        const { identity } = entry;
        spawned.push({
            routeKey: identity.routeKey,
            slot: {
                key: identity.containerName,
                instanceId: identity.instanceId,
                enableGeneration: identity.enableGeneration,
                runId: identity.runId,
                runStartedAtMs: identity.runStartedAtMs,
                waveIndex: identity.waveIndex,
                statusFile: identity.statusFile,
                startupGraceMs,
            },
        });
    }
    try {
        return await withBoundedApplyLock(
            (applyLockCapability) => commitNoWaitAvailabilitySlotPlan({
                mode: 'staging', workspaceRoot, applyLockCapability, spawned, startupGraceMs, ...options,
            }),
            { workspaceRoot, ...(options.lockOptions || {}) },
        );
    } catch (error) {
        const wrapped = new Error(`no-wait availability slot commit failed: ${error?.message || error}`, { cause: error });
        wrapped.code = error?.code;
        throw wrapped;
    }
}
