import fs from 'node:fs';
import path from 'node:path';

import { readStoreLockOwner, recoverStaleStoreLock, storeLockHolderToken, STORE_LOCK_NAME } from '../cli/sandbox/hardwareLimits/storeLock.mjs';
import { hardwareStorePaths } from '../cli/sandbox/hardwareLimits/store.mjs';
import { sanitizeControlDiagnosticText } from '../cli/utils/diagnosticText.js';
import { PloinkyBoxError } from './errors.mjs';
import { hostStatePaths } from './hostState/root.mjs';
import { describeHolder, FORCE_HOLDER_PATTERN, lockHolderToken, OWNER_FILE, readOwnerRecord, retireLock } from './lockFiles.mjs';
import { LIVENESS } from './lockLiveness.mjs';
import { RECLAIM_SUFFIX } from './locks.mjs';

// `ploinky unlock` (plan D4, Step 7): host-only recovery of the locks a crashed
// command can leave behind in `<workspace>/.ploinky-box`:
//   1. the reclaim guard `locks/workspace.lock.reclaim`,
//   2. the workspace lock `locks/workspace.lock` (D4),
//   3. the hardware store lock `hardware-limits/<instance>/store/write.lock`.
// Each is removed only when its holder is classified stale by the same
// liveness rules acquisition uses, or when it cannot be classified and
// `--force-holder PID@MACHINE` names exactly that holder. A workspace lock or
// guard holder classified live (same machine, PID namespace, PID and start
// time) is never removed. A store lock record has no start time, so an alive
// same-host PID is unclassified there: naming it exactly removes it, but only
// with the workspace lock held and the Box observed stopped or absent.
// Leftover contents, an ownerless or malformed lock and
// anything that is not a private directory are never removed: they are listed
// with the manual steps, and the command exits 1. It never waits for the
// workspace lock it is recovering and never creates the host state skeleton;
// only the store lock step takes the workspace lock, through the normal
// bounded acquisition (up to the lock manager's timeout), once that lock is
// free and only when a store lock exists.

function quote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function item(kind, itemPath, state, details = {}) {
    return Object.freeze({ kind, path: itemPath, state, ...details });
}

// Whether `--force-holder` (or staleness) permits removing a lock whose owner
// is `owner`, classified as `verdict`. Re-run under the reclaim guard.
function decide(owner, verdict, forceHolder) {
    if (verdict.state === LIVENESS.stale) return { remove: true, how: `its holder is gone: ${verdict.reason}` };
    if (verdict.state === LIVENESS.live) {
        return { remove: false, reason: `it is held by a running command (${describeHolder(owner)}); wait for it to finish` };
    }
    const token = lockHolderToken(owner);
    if (forceHolder === null) {
        return {
            remove: false,
            reason: `its holder cannot be classified (${verdict.reason}): ${describeHolder(owner)}`,
            steps: [`If pid ${owner.pid} on ${owner.hostname} is no longer running, run: ploinky unlock --force-holder ${token}`],
        };
    }
    if (forceHolder !== token) {
        return {
            remove: false,
            reason: `--force-holder ${forceHolder} does not name its holder ${token} (${verdict.reason})`,
        };
    }
    return { remove: true, how: `forced: --force-holder ${token} named its holder (${verdict.reason})` };
}

const STOP_FIRST = 'make sure no Ploinky command runs for this workspace';

/**
 * The reclaim guard is a directory holding exactly the reclaimer's owner
 * record. It is removed only when that owner is stale or exactly forced, and
 * only while it is still the same directory with the same record.
 */
function unlockReclaimGuard(guardPath, { lockManager, forceHolder, fsApi, uid }) {
    let stat;
    try {
        stat = fsApi.lstatSync(guardPath, { bigint: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return item('reclaim-guard', guardPath, 'absent');
        throw error;
    }
    const manual = [`Inspect ${guardPath}; once you ${STOP_FIRST}, remove it by hand: rm -r -- ${quote(guardPath)}`];
    if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && Number(stat.uid) !== uid)) {
        return item('reclaim-guard', guardPath, 'kept', { reason: 'it is not a private directory owned by you', steps: manual });
    }
    const contents = fsApi.readdirSync(guardPath).sort();
    if (contents.some((entry) => entry !== OWNER_FILE)) {
        return item('reclaim-guard', guardPath, 'kept', { reason: 'it holds more than its owner record', contents, steps: manual });
    }
    const record = readOwnerRecord(fsApi, guardPath);
    if (!record) {
        return item('reclaim-guard', guardPath, 'kept', {
            reason: 'it has no owner record (a reclaim stopped before writing it, or is writing it now)', contents, steps: manual,
        });
    }
    if (record.invalid) return item('reclaim-guard', guardPath, 'kept', { reason: record.invalid, contents, steps: manual });
    const verdict = lockManager.classifyHolder(record.owner);
    const decision = decide(record.owner, verdict, forceHolder);
    if (!decision.remove) {
        return item('reclaim-guard', guardPath, 'kept', {
            reason: decision.reason, holder: record.owner, token: lockHolderToken(record.owner), steps: decision.steps,
        });
    }
    // Only the guard that was judged: the same directory with the same record.
    const again = fsApi.lstatSync(guardPath, { bigint: true });
    const recheck = readOwnerRecord(fsApi, guardPath);
    if (again.dev !== stat.dev || again.ino !== stat.ino || !recheck?.bytes?.equals(record.bytes)
        || fsApi.readdirSync(guardPath).some((entry) => entry !== OWNER_FILE)) {
        return item('reclaim-guard', guardPath, 'kept', { reason: 'it changed while it was inspected; run ploinky unlock again' });
    }
    retireLock(fsApi, guardPath);
    return item('reclaim-guard', guardPath, 'removed', { reason: decision.how, holder: record.owner });
}

/** The workspace lock, through the lock manager's guarded reclaim. */
function unlockWorkspaceLock(lockPath, { lockManager, forceHolder, fsApi }) {
    let observed;
    try {
        observed = lockManager.inspectLock(lockPath);
    } catch (error) {
        return item('workspace-lock', lockPath, 'kept', {
            reason: error.message,
            steps: [`Inspect ${lockPath}; it must be a private directory owned by you.`],
        });
    }
    if (observed.kind === 'vanished') return item('workspace-lock', lockPath, 'absent');
    const contents = () => fsApi.readdirSync(lockPath).sort();
    const manual = [`Inspect ${lockPath}; once nothing in it is needed and you ${STOP_FIRST}, remove it by hand: `
        + `rm -r -- ${quote(lockPath)}`];
    if (observed.kind === 'ownerless') {
        return item('workspace-lock', lockPath, 'kept', { reason: 'it has no owner record but is not empty', contents: contents(), steps: manual });
    }
    if (observed.kind === 'malformed') {
        return item('workspace-lock', lockPath, 'kept', { reason: `it cannot be attributed: ${observed.reason}`, contents: contents(), steps: manual });
    }
    const owner = observed.owner;
    const verdict = lockManager.classifyHolder(owner);
    const decision = decide(owner, verdict, forceHolder);
    if (!decision.remove) {
        return item('workspace-lock', lockPath, 'kept', {
            reason: decision.reason, holder: owner, token: lockHolderToken(owner), steps: decision.steps,
        });
    }
    const outcome = lockManager.reclaimLock(lockPath, observed,
        (current, currentVerdict) => decide(current, currentVerdict, forceHolder).remove);
    if (outcome.outcome === 'reclaimed') return item('workspace-lock', lockPath, 'removed', { reason: decision.how, holder: owner });
    if (outcome.outcome === 'residue') {
        return item('workspace-lock', lockPath, 'kept', {
            reason: 'its holder is gone, but it still holds files that may be needed for recovery', holder: owner,
            contents: contents(), steps: manual,
        });
    }
    if (outcome.outcome === 'contended') {
        return item('workspace-lock', lockPath, 'kept', {
            reason: `another command is reclaiming it now (${outcome.guard}); run ploinky unlock again`, holder: owner,
        });
    }
    return item('workspace-lock', lockPath, 'kept', {
        reason: 'it changed while it was being removed (its holder or contents moved); run ploinky unlock again', holder: owner,
    });
}

/**
 * The hardware store lock, under a freshly taken workspace lock, through the
 * store's own recovery (the Box must be observed stopped or absent).
 */
async function unlockStoreLock(identity, { lockManager, forceHolder, observeBoxState, fsApi, workspaceClear }) {
    const { storeRoot } = hardwareStorePaths({ identity });
    const lockPath = path.join(storeRoot, STORE_LOCK_NAME);
    const current = readStoreLockOwner(storeRoot, { fsApi });
    if (!current) return item('store-lock', lockPath, 'absent');
    const manual = [`Stop this workspace on the host (ploinky stop), ${STOP_FIRST} or uses this store, then remove it `
        + `by hand: rm -- ${quote(lockPath)}`];
    if (current.malformed) return item('store-lock', lockPath, 'kept', { reason: current.reason, steps: manual });
    const token = storeLockHolderToken(current.owner);
    if (!workspaceClear) {
        return item('store-lock', lockPath, 'kept', {
            reason: 'the workspace lock is still in place, and the store lock is recovered only under it', holder: current.owner, token,
        });
    }
    let lock;
    try {
        lock = await lockManager.acquire(identity.instance, { workspaceRoot: identity.workspaceRoot });
    } catch (error) {
        return item('store-lock', lockPath, 'kept', { reason: `the workspace lock could not be taken: ${error.message}`, holder: current.owner, token });
    }
    try {
        const result = recoverStaleStoreLock({
            storeRoot, hostLock: lock, instance: identity.instance, fsApi, forceHolder,
            inspectBox: () => observeBoxState(identity),
        });
        if (!result.recovered) return item('store-lock', lockPath, 'absent');
        const how = forceHolder === token ? `forced: --force-holder ${token} named its holder` : 'its holder is gone';
        return item('store-lock', lockPath, 'removed', { reason: `${how}; moved aside to ${result.quarantine}`, holder: result.owner });
    } catch (error) {
        if (error?.code !== 'store_busy') throw error;
        return item('store-lock', lockPath, 'kept', {
            reason: error.message, holder: current.owner, token,
            steps: current.owner?.domain === 'box' ? undefined
                : [`If pid ${current.owner?.pid} on ${current.owner?.hostname} no longer runs and this workspace's Box is stopped, `
                    + `run: ploinky unlock --force-holder ${token}`],
        });
    } finally {
        lock.release();
    }
}

/**
 * Runs `ploinky unlock` for one workspace identity. Returns
 * `{ identity, items, exitCode }`; exitCode is 1 when anything was kept.
 */
export async function unlockWorkspace({
    identity,
    lockManager,
    observeBoxState,
    forceHolder = null,
    fsApi = fs,
    uid = currentUid(),
}) {
    if (forceHolder !== null && !FORCE_HOLDER_PATTERN.test(String(forceHolder))) {
        throw new PloinkyBoxError('--force-holder requires PID@MACHINE, as printed by the busy lock error', {
            code: 'PLOINKY_BOX_ARGUMENT_INVALID',
        });
    }
    const lockPath = hostStatePaths(identity.workspaceRoot).workspaceLock;
    const guard = unlockReclaimGuard(`${lockPath}${RECLAIM_SUFFIX}`, { lockManager, forceHolder, fsApi, uid });
    const guardClear = guard.state !== 'kept';
    const workspaceLock = guardClear
        ? unlockWorkspaceLock(lockPath, { lockManager, forceHolder, fsApi })
        : item('workspace-lock', lockPath, 'kept', { reason: 'its reclaim guard is still in place (see above)' });
    const store = await unlockStoreLock(identity, {
        lockManager, forceHolder, observeBoxState, fsApi, workspaceClear: workspaceLock.state !== 'kept',
    });
    const items = Object.freeze([guard, workspaceLock, store]);
    return Object.freeze({ identity, items, exitCode: items.some((entry) => entry.state === 'kept') ? 1 : 0 });
}

const TITLES = Object.freeze({
    'reclaim-guard': 'Workspace lock reclaim guard',
    'workspace-lock': 'Workspace lock',
    'store-lock': 'Hardware store lock',
});

// Reasons, steps and contents carry fields that a Box process can write (the
// store lock record, entry names): every printed value is one line without
// control characters, so nothing in them can drive the terminal.
function clean(value) {
    return sanitizeControlDiagnosticText(String(value ?? ''), { limit: 2000 });
}

export function formatUnlockReport(report) {
    const lines = [];
    for (const entry of report.items) {
        const title = `${TITLES[entry.kind]} ${clean(entry.path)}`;
        if (entry.state === 'absent') lines.push(`${title}: not present.`);
        else if (entry.state === 'removed') lines.push(`${title}: removed (${clean(entry.reason)}).`);
        else {
            lines.push(`${title}: kept: ${clean(entry.reason)}.`);
            if (entry.contents?.length) {
                lines.push(`  It holds: ${entry.contents.slice(0, 20).map(clean).join(', ')}${entry.contents.length > 20 ? ', ...' : ''}`);
            }
            for (const step of entry.steps || []) lines.push(`  Next: ${clean(step)}`);
        }
    }
    lines.push(report.exitCode === 0
        ? 'No stuck lock remains for this workspace.'
        : 'Some locks were kept. Nothing with leftover contents, a running holder or an unclassified holder is removed automatically.');
    return `${lines.join('\n')}\n`;
}
