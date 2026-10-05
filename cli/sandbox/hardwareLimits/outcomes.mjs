// Availability outcomes over the dependency graph (plan §9.1, U14/U15).
//
// Only blocking edges (noWait false) and independently explicit no-wait
// status waits propagate BLOCKED. An optional no-wait edge stays in the
// topology but is absent from this blocking projection, so a refused
// optional child never blocks its parent.

import {
    HARDWARE_DEPENDENCY_BLOCKED,
    OUTCOME_BOUNDS,
    validateHardwareOutcome,
} from './errors.mjs';
import { hex64 } from './requestedLimits.mjs';

const EDGE_KINDS = Object.freeze(['blocking', 'explicit-status-wait']);
const EDGE_SOURCES = Object.freeze(['manifest', 'scheduler']);

export function availabilityEdge({ fromKey, toKey, kind, source, cycleBackedge = false }) {
    if (!fromKey || !toKey) throw new Error('availability edge needs exact keys');
    if (!EDGE_KINDS.includes(kind)) throw new Error(`availability edge kind '${kind}' is unsupported`);
    if (!EDGE_SOURCES.includes(source)) throw new Error(`availability edge source '${source}' is unsupported`);
    return Object.freeze({ fromKey: String(fromKey), toKey: String(toKey), kind, source, cycleBackedge: Boolean(cycleBackedge) });
}

// Project the graph's blocking relation onto exact registry keys. `keyOf`
// maps a graph node id to its exact registry containerName. Optional no-wait
// edges are deliberately omitted. Declared blocking cycle backedges, which
// topology truncates, are retained with their original wait kind.
export function blockingEdgesFromGraph(graph, keyOf, { explicitWaits = [] } = {}) {
    const edges = [];
    const nodes = graph?.nodes instanceof Map ? graph.nodes : new Map();
    for (const [nodeId, node] of [...nodes].sort(([left], [right]) => left.localeCompare(right))) {
        const fromKey = keyOf(nodeId);
        if (!fromKey) continue;
        for (const childId of [...(node.dependencies || [])].sort()) {
            const edge = node.dependencyEdges?.get?.(childId);
            if (edge?.noWait) continue;
            const toKey = keyOf(childId);
            if (toKey) edges.push(availabilityEdge({ fromKey, toKey, kind: 'blocking', source: 'manifest' }));
        }
        for (const [childId, backedge] of [...(node.cycleBackedges || new Map())].sort(([a], [b]) => a.localeCompare(b))) {
            if (backedge?.noWait) continue;
            const toKey = keyOf(childId);
            if (toKey) {
                edges.push(availabilityEdge({
                    fromKey, toKey, kind: 'blocking', source: 'manifest', cycleBackedge: true,
                }));
            }
        }
    }
    for (const wait of explicitWaits) {
        edges.push(availabilityEdge({ ...wait, kind: 'explicit-status-wait', source: 'scheduler' }));
    }
    return Object.freeze(edges);
}

function shortestPathToRoot(start, roots, adjacency) {
    // BFS in deterministic (sorted) order; returns [start, ..., root].
    const previous = new Map([[start, null]]);
    const queue = [start];
    while (queue.length) {
        const current = queue.shift();
        if (current !== start && roots.has(current)) {
            const path = [];
            for (let cursor = current; cursor !== null; cursor = previous.get(cursor)) path.unshift(cursor);
            return path;
        }
        // A refused prerequisite is terminal; do not traverse through it.
        if (current !== start && roots.has(current)) continue;
        for (const next of adjacency.get(current) || []) {
            if (previous.has(next)) continue;
            previous.set(next, current);
            queue.push(next);
        }
    }
    return null;
}

function reachableRoots(start, roots, adjacency) {
    const seen = new Set([start]);
    const stack = [start];
    const found = new Set();
    while (stack.length) {
        const current = stack.pop();
        for (const next of adjacency.get(current) || []) {
            if (seen.has(next)) continue;
            seen.add(next);
            if (roots.has(next)) {
                found.add(next);
                continue;
            }
            stack.push(next);
        }
    }
    return found;
}

function boundPath(path) {
    // Keep the head of the path and the root cause; record how many middle
    // entries were omitted instead of inventing a direct edge.
    let entries = path.slice();
    let omitted = 0;
    const fits = (list) => list.length <= OUTCOME_BOUNDS.causalPathEntries
        && Buffer.byteLength(JSON.stringify(list), 'utf8') <= OUTCOME_BOUNDS.causalPathBytes;
    while (!fits(entries) && entries.length > 2) {
        entries = [...entries.slice(0, entries.length - 2), entries[entries.length - 1]];
        omitted += 1;
    }
    return { causalPath: entries, omittedPathCount: omitted };
}

// Classify every node. `nodes` is a list of {key, ref, alias, refusal} where
// refusal is a validated direct outcome or null. Own unenforceable policy is
// refused; otherwise a refused prerequisite reachable through the blocking
// relation makes the node blocked, with a deterministic causal path.
export function classifyAvailability({ nodes = [], edges = [] } = {}) {
    const byKey = new Map();
    for (const node of nodes) {
        if (!node?.key) throw new Error('availability node needs an exact key');
        if (byKey.has(node.key)) throw new Error(`availability node '${node.key}' is duplicated`);
        byKey.set(node.key, node);
    }
    const adjacency = new Map();
    for (const edge of edges) {
        if (!byKey.has(edge.fromKey) || !byKey.has(edge.toKey)) continue;
        if (!adjacency.has(edge.fromKey)) adjacency.set(edge.fromKey, new Set());
        adjacency.get(edge.fromKey).add(edge.toKey);
    }
    for (const [key, targets] of adjacency) adjacency.set(key, [...targets].sort());
    const roots = new Set([...byKey.values()].filter((node) => node.refusal).map((node) => node.key));
    const result = new Map();
    for (const key of [...byKey.keys()].sort()) {
        const node = byKey.get(key);
        if (node.refusal) {
            result.set(key, { state: 'refused', outcome: validateHardwareOutcome(node.refusal) });
            continue;
        }
        const path = shortestPathToRoot(key, roots, adjacency);
        if (!path) {
            result.set(key, { state: 'eligible', outcome: null });
            continue;
        }
        const allRoots = reachableRoots(key, roots, adjacency);
        const rootKey = path[path.length - 1];
        const root = validateHardwareOutcome(byKey.get(rootKey).refusal);
        const direct = byKey.get(path[1]);
        const { causalPath, omittedPathCount } = boundPath(path);
        const outcome = validateHardwareOutcome({
            state: 'blocked',
            code: HARDWARE_DEPENDENCY_BLOCKED,
            reasonCode: 'dependency_blocked',
            key,
            ref: node.ref,
            alias: node.alias || null,
            inputFingerprint: hex64({ schema: 1, key, path, root: root.inputFingerprint }),
            reason: `Required dependency ${direct.ref} cannot start: ${root.reason}`.slice(0, 2000),
            fix: root.fix,
            requested: [],
            blockedBy: { key: direct.key, ref: direct.ref },
            rootCause: root.rootCause,
            causalPath,
            omittedPathCount,
            additionalCauseCount: Math.max(0, allRoots.size - 1),
        });
        result.set(key, { state: 'blocked', outcome });
    }
    return result;
}

// One blocked outcome for a consumer whose waited-on producer published a
// refused or blocked terminal outcome (no-wait barrier, explicit waits).
export function blockedByProducerOutcome({ key, ref, alias = null, producer }) {
    const root = validateHardwareOutcome(producer);
    const path = [key, ...root.causalPath];
    const { causalPath, omittedPathCount } = boundPath(path);
    return validateHardwareOutcome({
        state: 'blocked',
        code: HARDWARE_DEPENDENCY_BLOCKED,
        reasonCode: 'dependency_blocked',
        key,
        ref,
        alias: alias || null,
        inputFingerprint: hex64({ schema: 1, key, producer: root.inputFingerprint }),
        reason: `Required dependency ${root.ref} cannot start: ${root.rootCause.reason}`.slice(0, 2000),
        fix: root.rootCause.fix,
        requested: [],
        blockedBy: { key: root.key, ref: root.ref },
        rootCause: root.rootCause,
        causalPath,
        omittedPathCount: omittedPathCount + root.omittedPathCount,
        additionalCauseCount: root.additionalCauseCount,
    });
}

const START_RESULT_LIMIT = 64;

function boundedList(entries) {
    return { entries: entries.slice(0, START_RESULT_LIMIT), count: entries.length };
}

// Whole start/restart summary (§9.2). ready only when every selected outcome
// is settled and ready; starting while optional work is pending; degraded
// (exit 0) when baseline-required eligible work succeeded despite refusals.
export function summarizeStartResult({
    readyAgents = [],
    asynchronousAgents = [],
    refusedAgents = [],
    blockedAgents = [],
    failedAgents = [],
} = {}) {
    let state = 'ready';
    if (refusedAgents.length || blockedAgents.length || failedAgents.length) state = 'degraded';
    else if (asynchronousAgents.length) state = 'starting';
    return Object.freeze({
        state,
        readyAgents: boundedList(readyAgents),
        asynchronousAgents: boundedList(asynchronousAgents),
        refusedAgents: boundedList(refusedAgents),
        blockedAgents: boundedList(blockedAgents),
        failedAgents: boundedList(failedAgents),
    });
}
