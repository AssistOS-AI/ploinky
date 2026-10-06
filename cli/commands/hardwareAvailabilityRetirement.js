// D2S.13 (M-NW-01): a fresh ready publication of the same tuple retires that tuple's
// committed hardware-availability entries, through one D1 commit, at the commit points
// of start (site S), the additive and replacement activations (sites A and R) and a
// targeted restart (site T). Retirement failure is non-fatal and never retried.
//
// D2S.13a: the same commit also retires the published route's slot of exactly the published tuple when that slot
// applies to the generation being published and its evidence, classified under the same locks by the resolver's
// own code, is terminal. Non-terminal slots are kept. Nothing is latched, created or attributed as recovery.

import {
    assertEdgeGenerationApplyLockCapability,
    loadActiveEdgeRoutingGeneration,
    resolveEdgeGenerationPaths,
} from '../sandbox/edgeGeneration.js';
import { assertNetworkLifecycleCapability } from '../sandbox/networkLifecycle.js';
import {
    HARDWARE_AVAILABILITY_DURABILITY_UNCONFIRMED,
    commitHardwareAvailabilityPolicy,
    readHardwareAvailabilityPolicy,
} from '../sandbox/hardwareAvailabilityStore.mjs';
import {
    TERMINAL_SLOT_EVIDENCE_CLASSES,
    createHardwareAvailabilityResolverCache,
    evaluateHardwareAvailabilityOfStore,
} from '../server/hardwareAvailabilityResolver.mjs';
import { appendLog } from '../server/utils/logger.js';
import { withBoundedApplyLock } from './noWaitAvailabilitySlots.js';
import { assertWorkspaceMutationLease, heldWorkspaceMutationLease } from '../utils/runtime/maintenanceLocks.js';

const sameTuple = (left, right) => Boolean(left && right)
    && left.key === right.key && left.instanceId === right.instanceId && left.enableGeneration === right.enableGeneration;

const entryTuple = (entry) => ({
    key: entry.projection.key,
    instanceId: entry.projection.instanceId,
    enableGeneration: entry.projection.enableGeneration,
});

// D2S.13a. Classify the candidate slots (each names exactly a published tuple) against the generation being
// published, with the resolver's own evaluation, and return those whose evidence is terminal for the slot's own run.
function terminalCandidateSlots({ store, candidates, generation, paths }) {
    const candidateSlots = Object.fromEntries(candidates.map(({ routeKey }) => [routeKey, store.slots[routeKey]]));
    const evaluation = evaluateHardwareAvailabilityOfStore({
        store: { ...store, entries: {}, slots: candidateSlots },
        generation,
        paths,
        cache: createHardwareAvailabilityResolverCache(),
    });
    const terminal = [];
    for (const [routeKey, slot] of Object.entries(candidateSlots)) {
        const evidence = evaluation.slots.get(routeKey);
        if (!evidence || evidence.runId !== slot.runId || !TERMINAL_SLOT_EVIDENCE_CLASSES.includes(evidence.evidenceClass)) continue;
        terminal.push({ routeKey, key: slot.key, runId: slot.runId, evidenceClass: evidence.evidenceClass });
    }
    return terminal;
}

// After the rename: one line per superseded slot (never recovery) and, when the directory fsync failed, one line for
// the retired entries. A failing log line never turns a committed retirement into a failure.
function reportRetirement({ site, retired, superseded, durabilityUnconfirmed, log }) {
    const unconfirmed = durabilityUnconfirmed ? { durabilityUnconfirmed: true } : {};
    try {
        for (const slot of superseded) {
            log('hardware_availability_slot_superseded', { site, ...slot, ...unconfirmed, recovery: false });
        }
        if (durabilityUnconfirmed && retired.length > 0) {
            log('hardware_availability_entry_retirement_durability_unconfirmed', { site, routeKeys: retired, revision: durabilityUnconfirmed.revision });
        }
    } catch (_) { /* the commit stands */ }
    return { retired, retiredSlots: superseded.map(({ routeKey }) => routeKey), ...unconfirmed };
}

/**
 * D2S.13 and D2S.13a. Retire the committed entries whose routeKey and tuple equal a tuple a ready publication just
 * published and, in the same D1 commit, each published route's slot of exactly that tuple whose evidence is terminal
 * against the generation being published. `published` is [{ routeKey, key, instanceId, enableGeneration }].
 *
 * The generation being published is `generation` when the caller has it (site S, before its apply), and otherwise
 * the active one, loaded under the apply lock the caller holds (sites A, R and T). It is loaded and evaluated only
 * when a published route holds a slot of the published tuple; otherwise the commit is the entries-only one.
 *
 * It asserts the workspace lease (held and live), the live network-lifecycle capability and the live apply-lock
 * capability bound to the store it writes. A failure is NON-FATAL by design: it is logged as
 * `hardware_availability_entry_retirement_failed`, the publication stands and the entries and slots are kept
 * (fail-closed); there is no retry. Only the store's own post-rename directory fsync failure is not a failure: the
 * deletion stands and is reported with `durabilityUnconfirmed`. It never throws.
 */
export function retireSameTupleHardwareEntries({
    site,
    workspaceRoot,
    applyLockCapability,
    networkLifecycleCapability,
    published,
    generation,
    loadGeneration = (options) => loadActiveEdgeRoutingGeneration(options).generation,
    commit = commitHardwareAvailabilityPolicy,
    log = appendLog,
    assertLease = () => {
        const held = heldWorkspaceMutationLease();
        if (!held) {
            const error = new Error('entry retirement requires the held workspace mutation lease');
            error.code = 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED';
            throw error;
        }
        return assertWorkspaceMutationLease(held);
    },
} = {}) {
    try {
        const paths = resolveEdgeGenerationPaths({ workspaceRoot });
        const store = readHardwareAvailabilityPolicy({ paths });
        // A store that was never initialized has no entries to retire.
        if (store.state === 'absent') return { retired: [], reason: 'store-absent' };
        assertLease();
        assertNetworkLifecycleCapability(networkLifecycleCapability);
        const entries = { ...store.entries };
        const retired = [];
        for (const tuple of published || []) {
            const entry = entries[tuple.routeKey];
            if (entry && sameTuple(entryTuple(entry), tuple)) {
                delete entries[tuple.routeKey];
                retired.push(tuple.routeKey);
            }
        }
        // D2S.13a. Only a published route whose slot names exactly the published tuple is a candidate. Without one,
        // no generation is loaded or evaluated, and the commit below is the entries-only one.
        const candidates = (published || []).filter((tuple) => sameTuple(store.slots[tuple.routeKey], tuple));
        const superseded = candidates.length > 0
            ? terminalCandidateSlots({ store, candidates, generation: generation || loadGeneration({ workspaceRoot }), paths })
            : [];
        const slots = { ...store.slots };
        for (const { routeKey } of superseded) delete slots[routeKey];
        const assertApplyLock = (storePaths) => assertEdgeGenerationApplyLockCapability({ workspaceRoot, applyLockCapability, storePaths });
        if (retired.length === 0 && superseded.length === 0) {
            // Nothing to write, but the capability is still proved: a wrong one must never pass silently.
            assertApplyLock(paths);
            return { retired, retiredSlots: [] };
        }
        let durabilityUnconfirmed = null;
        try {
            // ONE commit: the entries and the superseded slots go in one rename, or not at all.
            commit({ paths, assertApplyLock, expectedRevision: store.revision, entries, ...(superseded.length > 0 ? { slots } : {}) });
        } catch (error) {
            // The rename happened and only the directory fsync failed: the deletion stands and is never retried.
            if (error?.code !== HARDWARE_AVAILABILITY_DURABILITY_UNCONFIRMED || error.committed !== true) throw error;
            durabilityUnconfirmed = error;
        }
        return reportRetirement({ site, retired, superseded, durabilityUnconfirmed, log });
    } catch (error) {
        log('hardware_availability_entry_retirement_failed', {
            site,
            routeKeys: (published || []).map((tuple) => tuple.routeKey),
            code: error?.code || null,
            message: String(error?.message || error).slice(0, 300),
        });
        return { retired: [], retiredSlots: [], failed: error?.code || 'error' };
    }
}

/**
 * Sites R and T: retire after the publication was applied and verified, under a FRESH apply lock (the merge that
 * published it has released its own). The lock acquisition is the one bounded busy-acquire used by staging
 * (EDGE_GENERATION_BUSY for at most 2000 ms). Any failure, including the acquisition, is logged exactly as a
 * retirement failure and swallowed: the publication stands and the entry is kept. There is no retry.
 */
export async function retireSameTupleAfterApply({
    site,
    workspaceRoot,
    networkLifecycleCapability,
    published,
    retire = retireSameTupleHardwareEntries,
    log = appendLog,
    lockOptions = {},
} = {}) {
    try {
        // A workspace whose store was never initialized has nothing to retire, and taking the apply lock would
        // create its directories: skip the lock then. A store that is present, even unreadable, goes on to the
        // locked retirement, which reads it again and logs any failure.
        try {
            if (readHardwareAvailabilityPolicy({ paths: resolveEdgeGenerationPaths({ workspaceRoot }) }).state === 'absent') {
                return { retired: [], reason: 'store-absent' };
            }
        } catch (_) { /* the locked retirement reports it */ }
        return await withBoundedApplyLock(
            (applyLockCapability) => retire({ site, workspaceRoot, applyLockCapability, networkLifecycleCapability, published, log }),
            { workspaceRoot, ...lockOptions },
        );
    } catch (error) {
        log('hardware_availability_entry_retirement_failed', {
            site,
            routeKeys: (published || []).map((tuple) => tuple.routeKey),
            code: error?.code || null,
            message: String(error?.message || error).slice(0, 300),
        });
        return { retired: [], failed: error?.code || 'error' };
    }
}

/**
 * Site S (start's post-readiness merge mutator). From the routing the mutator was handed and the registry start
 * persists, publish the registry tuple of exactly the blocking runtimes this start verified ready, and retire the
 * entries of those tuples under the capabilities the coordinated merge handed the mutator. Agents that publish
 * later (asynchronous, no-wait) are not in `readyAgentKeys` and are never touched.
 */
export function retireStartReadyPublications({
    current,
    registry,
    readyAgentKeys,
    capabilities,
    workspaceRoot,
    retire = retireSameTupleHardwareEntries,
    log = appendLog,
} = {}) {
    const published = [];
    for (const [routeKey, route] of Object.entries(current?.routes || {})) {
        const record = (readyAgentKeys || []).includes(route?.container) ? registry?.[route.container] : null;
        if (record) published.push({ routeKey, key: route.container, instanceId: record.instanceId, enableGeneration: record.enableGeneration });
    }
    return retire({
        site: 'start',
        workspaceRoot,
        applyLockCapability: capabilities?.applyLockCapability,
        networkLifecycleCapability: capabilities?.networkLifecycleCapability,
        published,
        // D2S.13a: the generation start is about to apply (the selector is still inactive here).
        generation: { agents: registry, routing: current },
        log,
    });
}
