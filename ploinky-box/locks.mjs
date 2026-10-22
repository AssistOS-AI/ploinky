import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { PloinkyBoxError } from './errors.mjs';
import { ensureHostStateSkeleton, hostStatePaths } from './hostState/root.mjs';
import { materializeIdentityAnchor } from './identity.mjs';
import {
    INSTANCE_PATTERN,
    LABEL_PATTERN,
    LOCK_OWNER_SCHEMA,
    LOCK_OWNER_VERSION,
    OWNER_FILE,
    describeHolder,
    discardDirectory,
    lockHolderToken,
    publishLock,
    readOwnerRecord,
    retireLock,
    serializeOwner,
    stageLock,
    sweepLockDebris,
} from './lockFiles.mjs';
import { createLockLiveness, LIVENESS } from './lockLiveness.mjs';

export { LOCK_OWNER_SCHEMA, LOCK_OWNER_VERSION, lockHolderToken, parseLockOwner } from './lockFiles.mjs';

// The workspace mutation lock lives in `<workspace>/.ploinky-box/locks/` and
// so follows the workspace directory: every spelling of one directory shares
// it, and a renamed workspace carries it along. The on-disk protocol (atomic
// publish and retire, crash debris) is in lockFiles.mjs.
export const WORKSPACE_LOCK_LABEL = 'workspace';

export const RECLAIM_SUFFIX = '.reclaim';
const MAX_IMMEDIATE_RETRIES = 8;
const PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;

function lockError(message, { code = 'PLOINKY_BOX_LOCK_FAILED', cause, ...details } = {}) {
    return Object.assign(new PloinkyBoxError(message, { code, cause }), details);
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

// Shared by every manager that does not inject its own probe; successful
// probes of this process's own tokens are kept, failed ones are retried.
let processLiveness = null;
function defaultLiveness() {
    processLiveness ??= createLockLiveness();
    return processLiveness;
}

function defaultSleepSync(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function createMutationLockManager({
    fsApi = fs,
    liveness = defaultLiveness(),
    now = () => new Date(),
    clock = () => Date.now(),
    retryMs = 50,
    timeoutMs = 30_000,
    sleepSync = defaultSleepSync,
    uid = currentUid(),
} = {}) {
    function ownerRecord({ label, instance, workspaceRoot }) {
        const self = liveness.selfFields();
        return {
            schema: LOCK_OWNER_SCHEMA,
            version: LOCK_OWNER_VERSION,
            label,
            instance,
            workspaceRoot,
            hostname: self.hostname,
            machineId: self.machineId,
            bootId: self.bootId,
            pidNamespace: self.pidNamespace,
            pid: self.pid,
            processStart: self.processStart,
            startedAt: now().toISOString(),
        };
    }

    // A lock directory must be a real directory owned by the invoking user.
    // Anything else is tampering, never a busy lock to wait for.
    function inspectLockDirectory(lockPath) {
        let dirStat;
        try {
            dirStat = fsApi.lstatSync(lockPath, { bigint: true });
        } catch (error) {
            if (error?.code === 'ENOENT') return { kind: 'vanished' };
            throw lockError(`Unable to inspect lock ${lockPath}`, { cause: error });
        }
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()
            || (uid !== null && Number(dirStat.uid) !== uid)) {
            throw lockError(`Lock path is not a private directory owned by the current user: ${lockPath}`);
        }
        let record;
        try {
            record = readOwnerRecord(fsApi, lockPath);
        } catch (error) {
            if (error?.code === 'ENOENT') return { kind: 'vanished' };
            throw lockError(`Unable to read the owner of lock ${lockPath}`, { cause: error });
        }
        // Locks are published with their record, so an ownerless lock that a
        // publish could not replace is not empty: abandoned, never reclaimed.
        if (!record) return { kind: 'ownerless', dirStat };
        if (record.invalid) return { kind: 'malformed', dirStat, reason: record.invalid };
        return { kind: 'owner', dirStat, owner: record.owner, bytes: record.bytes };
    }

    function sameDirectory(left, right) {
        return left.dev === right.dev && left.ino === right.ino;
    }

    function residueOf(lockPath) {
        return fsApi.readdirSync(lockPath).filter((entry) => entry !== OWNER_FILE).sort();
    }

    function residueError(lockPath, label, residue, reason) {
        // `ploinky unlock` never removes a lock with leftovers; it lists them
        // with the manual steps.
        const hint = label === WORKSPACE_LOCK_LABEL
            ? 'Inspect it (`ploinky unlock` in the workspace lists it with the manual steps) and remove it by hand '
                + 'once nothing in it is needed.'
            : 'Inspect and remove it once you are sure no command is using it.';
        return lockError(
            `The ${label} lock ${lockPath} belongs to a command that is no longer running (${reason}), but it `
            + `still holds ${residue.slice(0, 8).join(', ')}, which may be needed for recovery. `
            + `It was left in place. ${hint}`,
            { lockResidue: true, residue },
        );
    }

    // Serializes reclaimers. Without it, two waiters that both saw the same dead
    // owner could interleave so that the second removes the lock a third
    // command acquired after the first reclaim. Under the guard the lock
    // directory can change only through its holder, which is proven gone.
    // `accept(owner, verdict)` is re-decided under the guard: by default only a
    // stale holder; `ploinky unlock --force-holder` also accepts the exact named
    // holder that cannot be classified, never a live one.
    function reclaimStale(lockPath, observed, accept = (_owner, verdict) => verdict.state === LIVENESS.stale) {
        const guard = `${lockPath}${RECLAIM_SUFFIX}`;
        try {
            fsApi.mkdirSync(guard, { recursive: false, mode: 0o700 });
        } catch (error) {
            if (error?.code === 'EEXIST') return { outcome: 'contended', guard };
            if (error?.code === 'ENOENT') return { outcome: 'retry' };
            throw lockError(`Unable to reclaim lock ${lockPath}`, { cause: error });
        }
        const guardOwner = path.join(guard, OWNER_FILE);
        try {
            const { label, instance, workspaceRoot } = observed.owner;
            fsApi.writeFileSync(guardOwner, serializeOwner(ownerRecord({ label, instance, workspaceRoot })),
                { flag: 'wx', mode: 0o600 });
            const current = inspectLockDirectory(lockPath);
            if (current.kind !== 'owner' || !sameDirectory(current.dirStat, observed.dirStat)
                || !current.bytes.equals(observed.bytes)) {
                return { outcome: 'retry' };
            }
            const verdict = liveness.classify(current.owner);
            if (!accept(current.owner, verdict)) return { outcome: 'retry' };
            const residue = residueOf(lockPath);
            if (residue.length) return { outcome: 'residue', residue, reason: verdict.reason };
            retireLock(fsApi, lockPath);
            return { outcome: 'reclaimed' };
        } finally {
            try { fsApi.unlinkSync(guardOwner); } catch {}
            try { fsApi.rmdirSync(guard); } catch {}
        }
    }

    function busyError(state) {
        const { lockPath, label, observed, verdict, contendedGuard } = state;
        let holder;
        if (observed?.kind === 'owner') {
            holder = `It is held by ${describeHolder(observed.owner)}; ${verdict?.reason ?? 'its state is unknown'}.`;
        } else if (observed?.kind === 'ownerless') {
            holder = 'It has no owner record but is not empty, so it was abandoned with content inside.';
        } else if (observed?.kind === 'malformed') {
            holder = `It cannot be attributed: ${observed.reason}.`;
        } else {
            holder = 'Another command holds it.';
        }
        if (contendedGuard) holder += ` Another command is reclaiming it (${contendedGuard}).`;
        const owner = observed?.kind === 'owner' ? observed.owner : null;
        const hint = label === WORKSPACE_LOCK_LABEL ? workspaceLockHint(owner, verdict)
            : 'Run the command again after that command finishes. If it is no longer running, '
                + 'inspect and remove the lock.';
        return lockError(`Timed out waiting for the ${label} lock ${lockPath}. ${holder} ${hint}`, {
            lockBusy: true,
            holder: owner ? Object.freeze({ ...owner }) : null,
            // What the last attempt saw, for callers that explain the wait.
            observedKind: observed?.kind ?? null,
            verdict: verdict ? Object.freeze({ ...verdict }) : null,
            contendedGuard: contendedGuard ?? null,
        });
    }

    // The busy hint names exactly what `ploinky unlock` will do for this holder.
    function workspaceLockHint(owner, verdict) {
        if (owner && verdict?.state === LIVENESS.live) {
            return 'Run the command again after that command finishes; `ploinky unlock` never removes a lock whose '
                + 'holder is running.';
        }
        if (owner && verdict?.state === LIVENESS.undetermined) {
            return 'Run the command again after that command finishes. If it is no longer running, run '
                + `\`ploinky unlock --force-holder ${lockHolderToken(owner)}\` in the workspace.`;
        }
        if (owner && verdict?.state === LIVENESS.stale) {
            return 'Its holder is gone; if the command stays busy, run `ploinky unlock` in the workspace.';
        }
        return 'Run the command again after that command finishes. If the lock stays, `ploinky unlock` in the '
            + 'workspace shows what it holds and how to remove it by hand.';
    }

    // One acquisition attempt, shared by the asynchronous and synchronous
    // drivers. Returns a handle, or tells the driver to retry now or after a wait.
    function attempt(state) {
        if (!state.ready) {
            try {
                state.prepare(state.first);
            } catch (error) {
                // The skeleton was removed while it was being created: rebuild it.
                if (error?.code === 'ENOENT') return { wait: true };
                throw error;
            }
            state.first = false;
            state.ready = true;
            if (!state.swept) {
                state.swept = true;
                sweepLockDebris({
                    fsApi, lockPath: state.lockPath, uid,
                    classify: (owner) => liveness.classify(owner), processStartedAtMs: PROCESS_STARTED_AT_MS,
                });
            }
        }
        if (!state.staged) {
            const ownerBytes = serializeOwner(ownerRecord(state));
            try {
                state.staged = { ...stageLock(fsApi, state.lockPath, ownerBytes), ownerBytes };
            } catch (error) {
                if (error?.code === 'ENOENT') {
                    state.ready = false;
                    return { wait: true };
                }
                throw lockError(`Unable to stage the ${state.label} lock ${state.lockPath}`, { cause: error });
            }
        }
        let outcome;
        try {
            outcome = publishLock(fsApi, state.staged.staging, state.lockPath);
        } catch (error) {
            throw lockError(`Unable to acquire the ${state.label} lock ${state.lockPath}`, { cause: error });
        }
        if (outcome === 'published') {
            const { ownerBytes, dirStat } = state.staged;
            state.staged = null;
            return { handle: createHandle({ ...state, ownerBytes, dirStat }) };
        }
        if (outcome === 'vanished') {
            discardDirectory(fsApi, state.staged.staging);
            state.staged = null;
            state.ready = false;
            return { wait: true };
        }
        const observed = inspectLockDirectory(state.lockPath);
        if (observed.kind === 'vanished') return { retry: true };
        state.observed = observed;
        state.verdict = null;
        state.contendedGuard = null;
        if (observed.kind === 'owner') {
            state.verdict = liveness.classify(observed.owner);
            if (state.verdict.state === LIVENESS.stale) {
                const reclaim = reclaimStale(state.lockPath, observed);
                if (reclaim.outcome === 'reclaimed') return { retry: true };
                if (reclaim.outcome === 'residue') {
                    throw residueError(state.lockPath, state.label, reclaim.residue, reclaim.reason);
                }
                if (reclaim.outcome === 'contended') state.contendedGuard = reclaim.guard;
            }
        }
        return { wait: true };
    }

    function createHandle({ lockPath, label, instance, workspaceRoot, ownerBytes, dirStat }) {
        let released = false;
        const heldName = instance ?? label;

        function assertNotReleased() {
            if (released) {
                throw lockError(`The ${label} lock was already released: ${lockPath}`, { code: 'PLOINKY_BOX_LOCK_NOT_HELD' });
            }
        }

        function assertWorkspaceLock() {
            if (!workspaceRoot) {
                throw lockError(`The ${label} lock is not a workspace lock: ${lockPath}`, {
                    code: 'PLOINKY_BOX_LOCK_WORKSPACE_REQUIRED',
                });
            }
        }

        // The held lock is this exact directory with these exact owner bytes.
        function verifyAt(candidate, code) {
            const fail = (cause) => lockError(
                `The ${label} lock held by this command is not at ${candidate}`,
                { code, cause },
            );
            let stat;
            let bytes;
            try {
                stat = fsApi.lstatSync(candidate, { bigint: true });
                if (stat.isSymbolicLink() || !stat.isDirectory() || !sameDirectory(stat, dirStat)) throw fail();
                const ownerPath = path.join(candidate, OWNER_FILE);
                const ownerStat = fsApi.lstatSync(ownerPath);
                if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.nlink !== 1) throw fail();
                bytes = fsApi.readFileSync(ownerPath);
            } catch (error) {
                if (error instanceof PloinkyBoxError) throw error;
                throw fail(error);
            }
            if (!bytes.equals(ownerBytes)) throw fail();
        }

        function removeAt(candidate) {
            const residue = residueOf(candidate);
            if (residue.length) {
                throw lockError(
                    `The ${label} lock ${candidate} still holds ${residue.slice(0, 8).join(', ')}; it was not released `
                    + 'and is kept for recovery.',
                    { lockResidue: true, residue },
                );
            }
            retireLock(fsApi, candidate);
            released = true;
        }

        const relocatedPath = (root) => {
            assertWorkspaceLock();
            return hostStatePaths(root).workspaceLock;
        };

        return Object.freeze({
            instance: heldName,
            label,
            path: lockPath,
            workspaceRoot,
            assertHeld(expected) {
                assertNotReleased();
                if (expected !== heldName) {
                    throw lockError(`The ${label} lock is held for ${heldName}, not ${expected}`, {
                        code: 'PLOINKY_BOX_LOCK_INSTANCE_MISMATCH',
                    });
                }
                verifyAt(lockPath, 'PLOINKY_BOX_LOCK_RELOCATED');
            },
            // The relocation custody operations take the workspace root the
            // held lock moved to, not a lock path.
            assertHeldAt(relocatedWorkspaceRoot) {
                assertNotReleased();
                verifyAt(relocatedPath(relocatedWorkspaceRoot), 'PLOINKY_BOX_LOCK_NOT_AT_PATH');
            },
            release() {
                assertNotReleased();
                verifyAt(lockPath, 'PLOINKY_BOX_LOCK_RELOCATED');
                removeAt(lockPath);
            },
            releaseRelocated(relocatedWorkspaceRoot) {
                assertNotReleased();
                const candidate = relocatedPath(relocatedWorkspaceRoot);
                verifyAt(candidate, 'PLOINKY_BOX_LOCK_NOT_AT_PATH');
                removeAt(candidate);
            },
            // The workspace, and the lock with it, has been deleted: give up the
            // handle without touching anything.
            relinquishDeleted() {
                assertNotReleased();
                assertWorkspaceLock();
                try {
                    fsApi.lstatSync(workspaceRoot);
                } catch (error) {
                    if (error?.code === 'ENOENT') {
                        released = true;
                        return;
                    }
                    throw lockError(`Unable to inspect ${workspaceRoot}`, { cause: error });
                }
                throw lockError(`The workspace still exists: ${workspaceRoot}`, { code: 'PLOINKY_BOX_WORKSPACE_PRESENT' });
            },
        });
    }

    function workspaceState(instance, options) {
        if (typeof instance !== 'string' || !INSTANCE_PATTERN.test(instance)) {
            throw lockError(`Invalid mutation lock identity: ${instance}`);
        }
        const { workspaceRoot, requireNewSkeleton = false } = options ?? {};
        if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
            throw lockError('The workspace mutation lock requires the absolute workspace root', {
                code: 'PLOINKY_BOX_LOCK_WORKSPACE_REQUIRED',
            });
        }
        return {
            lockPath: hostStatePaths(workspaceRoot).workspaceLock,
            label: WORKSPACE_LOCK_LABEL,
            instance,
            workspaceRoot,
            first: true,
            ready: false,
            prepare(first) {
                ensureHostStateSkeleton(workspaceRoot, { fsApi, uid, requireNew: first && requireNewSkeleton });
            },
        };
    }

    function pathState(lockPath, label) {
        if (typeof lockPath !== 'string' || !path.isAbsolute(lockPath)) {
            throw lockError(`Lock path must be absolute: ${lockPath}`);
        }
        if (typeof label !== 'string' || !LABEL_PATTERN.test(label)) {
            throw lockError(`Invalid lock label: ${label}`);
        }
        const parent = path.dirname(lockPath);
        return {
            lockPath,
            label,
            instance: null,
            workspaceRoot: null,
            first: true,
            ready: false,
            prepare() {
                // The parent is never created here: it must already be a real directory.
                let stat;
                try {
                    stat = fsApi.lstatSync(parent);
                } catch (error) {
                    throw lockError(`Lock parent directory is missing: ${parent}`, { cause: error });
                }
                if (stat.isSymbolicLink() || !stat.isDirectory()) {
                    throw lockError(`Lock parent is not a real directory: ${parent}`);
                }
            },
        };
    }

    // A retry right after a reclaim or a vanished lock is attempted at once,
    // even past the deadline, so that a slow attempt never turns a lock that
    // was just freed into a busy error; consecutive immediate retries are bounded.
    // An unpublished staging directory is always removed on the way out.
    function nextStep(state, progress) {
        const step = attempt(state);
        if (step.handle) return step;
        if (step.retry && progress.immediate < MAX_IMMEDIATE_RETRIES) {
            progress.immediate += 1;
            return { again: true };
        }
        if (clock() >= progress.deadline) throw busyError(state);
        progress.immediate = 0;
        return { sleep: true };
    }

    async function drive(state, limitMs = timeoutMs) {
        const progress = { deadline: clock() + limitMs, immediate: 0 };
        try {
            while (true) {
                const step = nextStep(state, progress);
                if (step.handle) return step.handle;
                if (step.sleep) await delay(retryMs);
            }
        } finally {
            if (state.staged) discardDirectory(fsApi, state.staged.staging);
        }
    }

    function driveSync(state) {
        const progress = { deadline: clock() + timeoutMs, immediate: 0 };
        try {
            while (true) {
                const step = nextStep(state, progress);
                if (step.handle) return step.handle;
                if (step.sleep) sleepSync(retryMs);
            }
        } finally {
            if (state.staged) discardDirectory(fsApi, state.staged.staging);
        }
    }

    return Object.freeze({
        // Recovery primitives for `ploinky unlock` (unlock.mjs): the same
        // inspection, classification and guarded reclaim that acquisition uses.
        inspectLock: (lockPath) => inspectLockDirectory(lockPath),
        classifyHolder: (owner) => liveness.classify(owner),
        reclaimLock: (lockPath, observed, accept) => reclaimStale(lockPath, observed, accept),
        acquire: async (instance, options) => drive(workspaceState(instance, options)),
        // For synchronous host-runtime launch paths. It blocks the calling
        // thread while it waits, for at most `timeoutMs`.
        acquireSync: (instance, options) => driveSync(workspaceState(instance, options)),
        // `timeoutMs` shortens the wait for this one acquisition (`ploinky
        // unlock` refuses quickly instead of queueing behind another unlock).
        acquireAt: async (lockPath, label, { timeoutMs: limitMs } = {}) => drive(pathState(lockPath, label),
            Number.isFinite(limitMs) && limitMs >= 0 ? limitMs : timeoutMs),
        lockPathFor: (workspaceRoot) => hostStatePaths(workspaceRoot).workspaceLock,
    });
}

export async function withWorkspaceMutationLock({
    resolveIdentity,
    lockManager,
    execute,
    // Read-only checks that must pass before anything is written into the
    // selected workspace, including the lock's own skeleton.
    beforeLock = async () => undefined,
    beforeAnchor = async () => undefined,
    materializeAnchor = materializeIdentityAnchor,
    maxHandoffs = 4,
}) {
    if (typeof resolveIdentity !== 'function' || typeof execute !== 'function') {
        throw new TypeError('Locked workspace transactions require resolveIdentity and execute');
    }
    let identity = resolveIdentity();
    const visited = new Set();

    for (let handoff = 0; handoff <= maxHandoffs; handoff += 1) {
        if (visited.has(identity.instance)) {
            throw lockError(`Workspace identity lock handoff cycle detected at ${identity.instance}`);
        }
        visited.add(identity.instance);
        let lock;
        try {
            await beforeLock(identity);
            lock = await lockManager.acquire(identity.instance, { workspaceRoot: identity.workspaceRoot });
        } catch (error) {
            // Nothing runs before this lock is held: the transaction never started.
            error.workspaceTransactionStarted = false;
            throw error;
        }
        let released = false;
        try {
            const resolvedUnderLock = resolveIdentity();
            if (resolvedUnderLock.instance !== identity.instance) {
                lock.release();
                released = true;
                identity = resolvedUnderLock;
                continue;
            }
            const prepared = await beforeAnchor(resolvedUnderLock, lock);
            if (!resolvedUnderLock.markerFound) {
                materializeAnchor(resolvedUnderLock, lock);
            }
            return await execute(resolvedUnderLock, lock, prepared);
        } finally {
            if (!released) {
                lock.release();
            }
        }
    }
    throw lockError(`Workspace identity lock handoff exceeded ${maxHandoffs}`);
}
