import { spawn as defaultSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureHostStateSkeleton } from '../../ploinky-box/hostState/root.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { heldHostLaunchExclusion, setHeldHostLaunchExclusion } from './hostLaunchExclusionState.js';

// Host-runtime launches (bwrap, seatbelt, host Podman) and Box transactions
// exclude each other through the workspace lock (D4). A Box transaction holds
// it from its scan for host agents through data-path creation and container
// creation, so no host agent can start in between. A host launch takes it
// after the workspace start lease that its caller already holds, and only
// around the spawn or engine create/start, until the launch is observable.
// In-Box launches never take it: the Box masks `.ploinky-host` from them.

let defaultManager = null;

function lockManagerFor(manager) {
    if (manager) return manager;
    defaultManager ??= createMutationLockManager();
    return defaultManager;
}

function absoluteRoot(workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
        const error = new Error('A host-runtime launch requires the absolute workspace root');
        error.code = 'PLOINKY_BOX_LOCK_WORKSPACE_REQUIRED';
        throw error;
    }
    return workspaceRoot;
}

/**
 * Creates the host state skeleton of the workspace before a host-runtime
 * launch, without any lock. A launch that cannot create it must fail. Inside a
 * Box it does nothing: the inherited read-only mask already covers it.
 */
export function ensureHostLaunchSkeleton(workspaceRoot, {
    insideBox = isInsideBox,
    ensureSkeleton = ensureHostStateSkeleton,
} = {}) {
    if (insideBox()) return null;
    const root = absoluteRoot(workspaceRoot);
    try {
        return ensureSkeleton(root);
    } catch (error) {
        error.message = `Host-runtime launch refused: the host state directory of ${root} cannot be prepared. ${error.message}`;
        throw error;
    }
}

/**
 * Takes D4 for one host-runtime launch and returns a handle whose `release()`
 * is idempotent. Nested launches in the same process reuse the held lock.
 * The wait is synchronous because the launch paths are synchronous; it is
 * bounded by the lock manager's timeout and fails with its busy error.
 */
export function acquireHostLaunchExclusion({
    workspaceRoot,
    label = 'host-runtime launch',
    insideBox = isInsideBox,
    ensureSkeleton = ensureHostStateSkeleton,
    lockManager,
    realpath = fs.realpathSync.native,
} = {}) {
    if (insideBox()) return Object.freeze({ held: false, release() {} });
    const root = absoluteRoot(workspaceRoot);
    ensureHostLaunchSkeleton(root, { insideBox: () => false, ensureSkeleton });
    const key = realpath(root);
    const current = heldHostLaunchExclusion();
    if (current) {
        if (current.key !== key) {
            const error = new Error(`A host-runtime launch for ${root} cannot start while this process holds `
                + `the workspace lock of ${current.workspaceRoot}.`);
            error.code = 'PLOINKY_BOX_LOCK_ORDER';
            throw error;
        }
        current.depth += 1;
        let done = false;
        return Object.freeze({
            held: true,
            release() {
                if (done) return;
                done = true;
                current.depth -= 1;
            },
        });
    }
    const manager = lockManagerFor(lockManager);
    const lock = manager.acquireSync(buildWorkspaceIdentity(root).instance, { workspaceRoot: root });
    const record = { key, workspaceRoot: root, label, depth: 1 };
    setHeldHostLaunchExclusion(record);
    let done = false;
    return Object.freeze({
        held: true,
        lock,
        release() {
            if (done) return;
            done = true;
            record.depth = 0;
            setHeldHostLaunchExclusion(null);
            lock.release();
        },
    });
}

/** Runs one synchronous host-runtime launch under D4. */
export function withHostLaunchExclusion(launch, options = {}) {
    if (typeof launch !== 'function') throw new TypeError('withHostLaunchExclusion requires a launch function');
    const exclusion = acquireHostLaunchExclusion(options);
    let result;
    let failure = null;
    try {
        result = launch();
        if (typeof result?.then === 'function') {
            throw new TypeError('A host-runtime launch under the workspace lock must be synchronous');
        }
    } catch (error) {
        failure = error;
    }
    try {
        exclusion.release();
    } catch (releaseError) {
        if (!failure) throw releaseError;
        failure.lockReleaseError = releaseError;
    }
    if (failure) throw failure;
    return result;
}

// The settle that startBwrapProcess and startSeatbeltProcess give a new
// sandbox before they record it.
export const INTERACTIVE_SETTLE_MS = 500;
const FOREGROUND_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

// Keeps the foreground behaviour of a synchronous spawn while an interactive
// session runs: this process's own signal listeners (the REPL's, for example)
// do not run during the session and receive its signals once it has ended.
// A signal with no listener keeps its default effect, as with spawnSync.
function deferSignalListeners(processApi = process) {
    const pending = [];
    const swapped = [];
    for (const signal of FOREGROUND_SIGNALS) {
        const listeners = processApi.listeners(signal);
        if (!listeners.length) continue;
        const capture = () => { pending.push(signal); };
        processApi.removeAllListeners(signal);
        processApi.on(signal, capture);
        swapped.push({ signal, listeners, capture });
    }
    return () => {
        for (const { signal, listeners, capture } of swapped) {
            processApi.removeListener(signal, capture);
            for (const listener of listeners) processApi.on(signal, listener);
        }
        if (pending.length) setImmediate(() => { for (const signal of pending) processApi.emit(signal, signal); });
    };
}

/**
 * Runs one foreground interactive sandbox (`ploinky shell`, `ploinky cli`) on
 * the host. D4 is held from before the spawn until the sandbox has settled,
 * so it cannot start between a Box transaction's scan and its writes; it is
 * released before the session itself, which may last hours. Resolves to the
 * `{ status, signal, error }` that spawnSync would have returned.
 */
export async function runHostInteractiveSession(command, args, spawnOptions = {}, {
    workspaceRoot,
    label = 'interactive session',
    settleMs = INTERACTIVE_SETTLE_MS,
    spawnImpl = defaultSpawn,
    ...exclusionOptions
} = {}) {
    const restoreSignals = deferSignalListeners();
    try {
        const exclusion = acquireHostLaunchExclusion({ workspaceRoot, label, ...exclusionOptions });
        let exited;
        try {
            const child = spawnImpl(command, args, { stdio: 'inherit', ...spawnOptions });
            exited = new Promise((resolve) => {
                child.once('error', (error) => resolve({ status: null, signal: null, error }));
                child.once('close', (status, signal) => resolve({ status, signal }));
            });
            await Promise.race([exited, delay(settleMs)]);
        } finally {
            exclusion.release();
        }
        return await exited;
    } finally {
        restoreSignals();
    }
}
