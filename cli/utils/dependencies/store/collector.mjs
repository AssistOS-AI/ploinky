// Conservative collection of immutable dependency objects under
// `.ploinky/deps/store/objects`. Runs only after a successful admission, under
// the held workspace mutation lease, and never on TTL, age or disk pressure.
// Nothing outside the store's objects directory is ever removed: other files
// under `.ploinky/deps` are unknown to Ploinky and preserved.
//
// Root set (anything here is retained):
//   - admitted selections: every registry record's `dependencies` and every
//     registry bind into an object (running or stopped runtimes);
//   - desired selections: objects built for a pending/failed rebuild request;
//   - needed seeds: every seed object that is the current index target;
//   - durable runtime candidates (`.ploinky/run/runtime-candidates`);
//   - build receipts whose writer tree is not proven quiescent;
//   - reader receipts (service, attachment, seed-copy, candidate) whose
//     consumer is not proven quiescent;
//   - ACTUAL mounts of every workspace container, including stopped ones,
//     from engine inspection.
// Unknown or unavailable evidence (engine inspection failed, unreadable
// candidate or registry, an outstanding edge preparation or a non-active
// selector) skips collection entirely: uncertain liveness means retain.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { AGENTS_FILE, DEPS_DIR, PLOINKY_WORKSPACE_ROOT } from '../../config.js';
import { assertWorkspaceMutationLease } from '../../runtime/maintenanceLocks.js';
import { probeContainerRuntime } from '../../../sandbox/docker/common.js';
import { readEdgeRoutingSelection } from '../../../sandbox/edgeGeneration.js';
import { dependencyStoreError } from './canonical.mjs';
import { OBJECT_OWNER, buildReceiptOwnershipProblem, createCacheStore } from './objectStore.mjs';

const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readJson(file) {
    try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
    catch (error) {
        if (error?.code === 'ENOENT') return { missing: true };
        return { corrupt: error.message };
    }
}

function directorySize(target) {
    let bytes = 0;
    const walk = (current) => {
        let stat;
        try { stat = fs.lstatSync(current); } catch { return; }
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
            for (const name of fs.readdirSync(current)) walk(path.join(current, name));
        } else if (stat.isFile()) {
            bytes += stat.size;
        }
    };
    walk(target);
    return bytes;
}

function objectIdOfPath(source, objectsDir) {
    const resolved = path.resolve(String(source || ''));
    if (!resolved.startsWith(`${objectsDir}${path.sep}`)) return null;
    const id = resolved.slice(objectsDir.length + 1).split(path.sep)[0];
    return OBJECT_ID.test(id) ? id : null;
}

/**
 * Engine inspector over EVERY container the engine knows (running or stopped,
 * labeled or not — older releases or lost labels must not hide a reader).
 * Returns `{ available: true, mounts: string[] }` with mount sources under the
 * dependency root, or `{ available: false, reason }`.
 */
export function engineMountInspector({ getRuntime, depsDir = DEPS_DIR, spawn = spawnSync }) {
    return () => {
        let runtime;
        try { runtime = getRuntime(); } catch (error) { return { available: false, reason: `no container engine: ${error?.message || error}` }; }
        if (!runtime) return { available: false, reason: 'no container engine' };
        const listed = spawn(runtime, ['ps', '-a', '--format', '{{.ID}}'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
        });
        if (listed.error || listed.status !== 0) return { available: false, reason: `engine listing failed (${listed.error?.code || listed.status})` };
        const ids = String(listed.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
        if (!ids.length) return { available: true, mounts: [], containers: 0 };
        const inspected = spawn(runtime, ['container', 'inspect', ...ids], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
        });
        if (inspected.error || inspected.status !== 0) return { available: false, reason: 'engine inspection failed' };
        let records;
        try { records = JSON.parse(inspected.stdout); } catch { return { available: false, reason: 'engine inspection was unreadable' }; }
        if (!Array.isArray(records) || records.length !== ids.length) return { available: false, reason: 'engine inspection was incomplete' };
        const root = path.resolve(depsDir);
        const mounts = [];
        for (const record of records) {
            for (const mount of record?.Mounts || []) {
                const source = path.resolve(String(mount?.Source || '/'));
                if (source === root || source.startsWith(`${root}${path.sep}`)) mounts.push(source);
            }
        }
        return { available: true, mounts, containers: ids.length };
    };
}

function candidateRecords(workspaceRoot) {
    const directory = path.join(workspaceRoot, '.ploinky', 'run', 'runtime-candidates');
    let names;
    try { names = fs.readdirSync(directory); }
    catch (error) {
        if (error?.code === 'ENOENT') return { records: [] };
        return { unreadable: `runtime candidates unreadable: ${error.message}` };
    }
    const records = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const parsed = readJson(path.join(directory, name));
        if (!parsed.value) return { unreadable: `runtime candidate ${name} unreadable` };
        records.push(parsed.value.registryRecord || parsed.value);
    }
    return { records };
}

export function defaultReadEdgeState() {
    const { selector, paths } = readEdgeRoutingSelection();
    return { selector: selector.state, preparationOutstanding: fs.existsSync(paths.preparationLeaseFile) };
}

function edgeSettled({ readEdgeState }) {
    try {
        const state = readEdgeState();
        if (!state) return 'edge routing state unavailable';
        if (state.selector !== 'active') return `edge routing selector is ${state.selector}`;
        if (state.preparationOutstanding) return 'an edge lifecycle preparation is outstanding';
        return '';
    } catch (error) {
        return `edge routing state unreadable: ${error?.message || error}`;
    }
}

/**
 * Collect proven-unreferenced store objects.
 *
 * @param {{ lease: object, store?: object, workspaceRoot?: string, depsDir?: string,
 *   loadAgents?: Function, inspectMounts?: Function, readEdgeState?: Function,
 *   assertLease?: Function }} options
 * @returns {{ skipped: string|null, removed: string[], retained: Array<{objectId, reasons, bytes}>,
 *   retainedBytesByReason: object }}
 */
export function collectDependencyObjects({
    lease,
    store = null,
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    depsDir = DEPS_DIR,
    loadAgents = () => {
        const parsed = readJson(AGENTS_FILE);
        if (parsed.missing) return {}; // A fresh workspace has no registry yet.
        if (parsed.corrupt) throw dependencyStoreError('PLOINKY_DEPS_REGISTRY_UNREADABLE', parsed.corrupt);
        return parsed.value;
    },
    // probeContainerRuntime returns null without an engine; getRuntime would
    // exit the process from this best-effort post-admission step.
    inspectMounts = engineMountInspector({ getRuntime: () => probeContainerRuntime(), depsDir }),
    hooks = {},
    readEdgeState = defaultReadEdgeState,
    assertLease = assertWorkspaceMutationLease,
} = {}) {
    assertLease(lease);
    const activeStore = store || createCacheStore({ depsDir, workspaceRoot, assertLease });
    const report = { skipped: null, removed: [], retained: [], retainedBytesByReason: {} };
    const objectsDir = activeStore.paths.objects;
    const skip = (reason) => ({ ...report, skipped: reason });

    const unsettled = edgeSettled({ readEdgeState });
    if (unsettled) return skip(unsettled);
    let agents;
    try { agents = loadAgents(); } catch (error) { return skip(`registry unreadable: ${error?.message || error}`); }
    // A present registry that is not an object (for example `null`) is corrupt,
    // not an empty workspace: its admitted roots are unknown.
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
        return skip(`registry unreadable: agents registry is ${Array.isArray(agents) ? 'an array' : JSON.stringify(agents ?? null)}, not an object`);
    }
    const candidates = candidateRecords(workspaceRoot);
    if (candidates.unreadable) return skip(candidates.unreadable);
    const records = [...Object.values(agents), ...candidates.records].filter((record) => record && typeof record === 'object');
    const mounts = inspectMounts();
    // Missing registry records cannot prove there are no older/unrecorded
    // containers. An unavailable engine leaves the actual mount set unknown.
    if (!mounts?.available) return skip(`container engine unavailable: ${mounts?.reason || 'unknown'}`);
    // Desired rebuild tokens root objects; an unusable rebuild state leaves
    // them unknown, so collection is skipped before anything is mutated.
    const desiredTokens = new Set();
    try {
        for (const state of activeStore.listRebuildStates()) {
            if (state.desired?.token) desiredTokens.add(state.desired.token);
            if (state.admittedToken) desiredTokens.add(state.admittedToken);
        }
    } catch (error) {
        return skip(`rebuild state unreadable: ${error?.message || error}`);
    }
    recoverTombstones(activeStore);
    const actualMounts = mounts?.available ? mounts.mounts : [];

    const roots = new Map();
    const root = (objectId, reason) => {
        if (!objectId) return;
        if (!roots.has(objectId)) roots.set(objectId, new Set());
        roots.get(objectId).add(reason);
    };
    for (const record of records) {
        if (record.dependencies?.mode === 'store') root(record.dependencies.objectId, 'admitted-record');
        for (const bind of record.config?.binds || []) root(objectIdOfPath(bind?.source, objectsDir), 'registry-bind');
    }
    for (const source of actualMounts) root(objectIdOfPath(source, objectsDir), 'container-mount');

    // Reader receipts: remove only receipts with positive quiescence proof;
    // every surviving receipt roots its object.
    for (const receipt of activeStore.listReaderReceipts()) {
        const file = path.join(activeStore.paths.readerReceipts, `${receipt.receiptId}.json`);
        const outcome = activeStore.removeStaleReceipt(lease, file);
        if (!outcome.removed) root(receipt.objectId, `reader:${receipt.consumer?.kind || 'unknown'}`);
    }

    const inventory = activeStore.describeObjects();
    const manifests = new Map();
    for (const item of inventory) {
        if (!item.path || !item.complete) continue;
        const manifest = readJson(path.join(item.path, 'manifest.json')).value;
        if (manifest) manifests.set(item.objectId, manifest);
    }
    for (const [objectId, manifest] of manifests) {
        const token = manifest.contract?.agent?.rebuildToken;
        if (token && desiredTokens.has(token)) {
            // Keep objects of a pending/failed desired request (and of the
            // admitted token) only while they are also index targets.
            const indexed = inventory.find((item) => item.objectId === objectId)?.indexedBy?.length;
            if (indexed) root(objectId, 'rebuild-request');
        }
        if (manifest.kind === 'seed' && activeStore.readIndex(manifest.inputKey)?.objectId === objectId) root(objectId, 'seed-index');
    }

    for (const item of inventory) {
        const reasons = new Set(roots.get(item.objectId) || []);
        if (item.buildReceipt && !item.buildReceipt.quiescence?.quiescent) reasons.add('build-writer-unproven');
        if (item.buildReceipt && item.buildReceipt.owned !== true) reasons.add('build-receipt-unowned');
        if (item.classification === 'unknown-entry') reasons.add('unknown-entry');
        if (item.classification === 'unpublished-retained') reasons.add('unpublished-unproven');
        if (item.classification === 'receipt-only-retained') reasons.add('receipt-writer-unproven');
        if (!item.path && item.classification === 'receipt-only-reclaimable') {
            const receiptFile = path.join(activeStore.paths.buildReceipts, `${item.objectId}.json`);
            activeStore.removeStaleReceipt(lease, receiptFile);
            continue;
        }
        if (reasons.size) {
            const bytes = item.path ? directorySize(item.path) : 0;
            report.retained.push({ objectId: item.objectId, reasons: [...reasons].sort(), bytes });
            for (const reason of reasons) report.retainedBytesByReason[reason] = (report.retainedBytesByReason[reason] || 0) + bytes;
            continue;
        }
        if (removeObject(activeStore, lease, item, { objectsDir, manifests, assertLease, hooks })) report.removed.push(item.objectId);
    }

    return report;
}

const TOMBSTONE_PREFIX = '.tombstone-';

function tombstoneObjectId(name) {
    const match = /^\.tombstone-([0-9a-f-]{36})-[0-9a-f]{8}$/.exec(name);
    return match && OBJECT_ID.test(match[1]) ? match[1] : null;
}

/**
 * A crash between tombstoning and deletion leaves `.tombstone-<id>-<nonce>`.
 * Restore it before the ordinary root/ownership checks decide its fate.
 * Recovery itself never destroys data using a receipt-only snapshot.
 */
function recoverTombstones(store) {
    let names = [];
    try { names = fs.readdirSync(store.paths.objects); } catch { return; }
    for (const name of names) {
        const objectId = tombstoneObjectId(name);
        if (!objectId) continue;
        const tomb = path.join(store.paths.objects, name);
        const live = path.join(store.paths.objects, objectId);
        const stat = fs.lstatSync(tomb);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const manifest = readJson(path.join(tomb, 'manifest.json')).value;
        const receipt = readJson(path.join(store.paths.buildReceipts, `${objectId}.json`)).value;
        const owned = manifest?.owner === OBJECT_OWNER && manifest.workspaceId === store.workspaceId && manifest.objectId === objectId
            || receipt?.kind === 'build' && receipt.workspaceId === store.workspaceId && receipt.receiptId === objectId
                && receipt.objectPath === live;
        if (!owned) continue;
        if (!fs.existsSync(live)) {
            fs.renameSync(tomb, live);
        }
    }
}

function removeObject(store, lease, item, { objectsDir, manifests, assertLease, hooks = {} }) {
    assertLease(lease);
    const hasReceipt = () => store.listReaderReceipts().some((receipt) => receipt.objectId === item.objectId);
    if (hasReceipt()) return false;
    const dir = path.join(objectsDir, item.objectId);
    let stat;
    try { stat = fs.lstatSync(dir); } catch { return false; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const manifest = manifests.get(item.objectId);
    if (manifest && (manifest.workspaceId !== store.workspaceId || manifest.objectId !== item.objectId)) return false;
    // A build receipt that is present but not provably ours is never deleted
    // with the object. Re-read it: it may have changed since the inventory.
    const buildReceipt = readJson(path.join(store.paths.buildReceipts, `${item.objectId}.json`));
    const receiptOwnership = buildReceipt.missing ? 'no build receipt'
        : buildReceiptOwnershipProblem(buildReceipt.value, { objectId: item.objectId, workspaceId: store.workspaceId, objectsDir });
    if (!buildReceipt.missing && receiptOwnership) return false;
    // Incomplete object: only an own unpublished build whose writer tree is
    // proven quiescent (its owned receipt says so) is reclaimable.
    if (!manifest && (item.classification !== 'unpublished-reclaimable' || receiptOwnership)) return false;
    if (typeof hooks.beforeTombstone === 'function') hooks.beforeTombstone(item.objectId);
    // Attachment acquisition uses this same lease. Recheck after callbacks as
    // well: a newly pinned path must never temporarily disappear.
    if (hasReceipt()) return false;
    const tomb = path.join(objectsDir, `${TOMBSTONE_PREFIX}${item.objectId}-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`);
    fs.renameSync(dir, tomb);
    const moved = manifest ? readJson(path.join(tomb, 'manifest.json')).value : null;
    const ownershipChanged = manifest && (moved?.workspaceId !== store.workspaceId || moved?.objectId !== item.objectId);
    if (hasReceipt() || ownershipChanged) {
        fs.renameSync(tomb, dir);
        return false;
    }
    for (const inputKey of item.indexedBy || []) {
        const entry = store.readIndex(inputKey);
        if (entry?.objectId === item.objectId) fs.rmSync(path.join(store.paths.index, `${inputKey}.json`), { force: true });
    }
    fs.rmSync(path.join(store.paths.unusable, `${item.objectId}.json`), { force: true });
    fs.rmSync(path.join(store.paths.buildReceipts, `${item.objectId}.json`), { force: true });
    fs.rmSync(tomb, { recursive: true, force: true });
    return true;
}

/**
 * Best-effort post-admission hook for lifecycle commands: never throws and
 * never blocks the successful command on collection problems.
 */
export function collectDependencyObjectsAfterAdmission({ lease, reason = 'admission', ...options } = {}) {
    try {
        return collectDependencyObjects({ lease, ...options });
    } catch (error) {
        return { skipped: `collection failed (${reason}): ${error?.message || error}`, removed: [], retained: [], retainedBytesByReason: {} };
    }
}

/** One debug line summarizing a collection (removed, skipped, retained bytes by reason). */
export function reportDependencyCollection(result, log = (message) => {
    if (process.env.PLOINKY_DEBUG === '1') console.log(`[DEBUG] ${message}`);
}) {
    if (!result) return result;
    const summary = result.skipped
        ? `skipped (${result.skipped})`
        : `removed ${result.removed.length} object(s); retained bytes by reason ${JSON.stringify(result.retainedBytesByReason)}`;
    log(`[deps-gc] ${summary}`);
    return result;
}
