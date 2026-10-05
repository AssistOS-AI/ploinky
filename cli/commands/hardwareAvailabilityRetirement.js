// D2S.13 (M-NW-01): a fresh ready publication of the same tuple retires that tuple's
// committed hardware-availability entries, through one D1 commit, at the commit points
// of start (site S), the additive and replacement activations (sites A and R) and a
// targeted restart (site T). Retirement failure is non-fatal and never retried.

import {
    assertEdgeGenerationApplyLockCapability,
    resolveEdgeGenerationPaths,
} from '../sandbox/edgeGeneration.js';
import { assertNetworkLifecycleCapability } from '../sandbox/networkLifecycle.js';
import {
    commitHardwareAvailabilityPolicy,
    readHardwareAvailabilityPolicy,
} from '../sandbox/hardwareAvailabilityStore.mjs';
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

/**
 * D2S.13. Retire the committed entries whose routeKey and tuple equal a tuple a ready publication just
 * published, through one D1 commit. `published` is [{ routeKey, key, instanceId, enableGeneration }].
 *
 * It asserts the workspace lease (held and live), the live network-lifecycle capability and the live apply-lock
 * capability bound to the store it writes. A failure is NON-FATAL by design: it is logged as
 * `hardware_availability_entry_retirement_failed`, the publication stands and the entry is kept (fail-closed);
 * there is no retry. It never throws.
 */
export function retireSameTupleHardwareEntries({
    site,
    workspaceRoot,
    applyLockCapability,
    networkLifecycleCapability,
    published,
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
        const assertApplyLock = (storePaths) => assertEdgeGenerationApplyLockCapability({ workspaceRoot, applyLockCapability, storePaths });
        if (retired.length === 0) {
            // Nothing to write, but the capability is still proved: a wrong one must never pass silently.
            assertApplyLock(paths);
            return { retired };
        }
        commit({ paths, assertApplyLock, expectedRevision: store.revision, entries });
        return { retired };
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
        log,
    });
}
