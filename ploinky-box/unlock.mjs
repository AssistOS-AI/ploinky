import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readStoreLockOwner, recoverStaleStoreLock, storeLockHolderToken, STORE_LOCK_NAME } from '../cli/sandbox/hardwareLimits/storeLock.mjs';
import { hardwareStorePaths } from '../cli/sandbox/hardwareLimits/store.mjs';
import { sanitizeControlDiagnosticText } from '../cli/utils/diagnosticText.js';
import { PloinkyBoxError } from './errors.mjs';
import { inspectHostStateSkeleton } from './hostState/root.mjs';
import {
    describeHolder,
    discardDirectory,
    FORCE_HOLDER_PATTERN,
    lockHolderToken,
    OWNER_FILE,
    readOwnerRecord,
    RELEASED_MARK,
} from './lockFiles.mjs';
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
// with the manual steps, and the command exits 1.
//
// Unlock commands for one workspace run one at a time, under their own lock
// `locks/unlock.lock`, taken through the lock manager like any other lock
// (owner record, liveness, atomic publish, stale reclaim under its own
// `.reclaim` guard). Without it, two unlocks could both judge the same stale
// guard, and the second could remove the guard a running reclaimer had just
// created in its place. A second unlock waits at most UNLOCK_WAIT_MS, then
// refuses; the lock of an unlock that is no longer running is reclaimed
// automatically. Unlock never removes its own lock's reclaim guard: a stuck
// `unlock.lock.reclaim` is listed with the manual step.
//
// Unlock never waits for the workspace lock it is recovering and never creates
// the host state skeleton: without a `locks/` directory there is no guard or
// workspace lock to recover and nothing to serialize. Only the store lock step
// takes the workspace lock, through the normal bounded acquisition (up to the
// lock manager's timeout), once that lock is free and only when a store lock
// exists.

export const UNLOCK_LOCK_NAME = 'unlock.lock';
const UNLOCK_LOCK_LABEL = 'unlock';
// How long a second unlock waits for the running one before it refuses.
export const UNLOCK_WAIT_MS = 2000;

const VANISHED = 'removed by another command while it was inspected';

function quote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function item(kind, itemPath, state, details = {}) {
    return Object.freeze({ kind, path: itemPath, state, ...details });
}

// Whether a path is still there; anything but a clean ENOENT counts as there.
function present(fsApi, target) {
    try {
        fsApi.lstatSync(target);
        return true;
    } catch (error) {
        return error?.code !== 'ENOENT';
    }
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
const GUARD_CHANGED = 'it changed while it was inspected; run ploinky unlock again';

/**
 * Removes the directory that was judged and nothing else. Judging and moving
 * cannot be one step, so what was moved is checked afterwards: the judged
 * directory (same device and inode, same owner record, nothing else in it) is
 * deleted; anything else took its place in between and is moved back, or,
 * when its name is taken again, left where it is for the operator.
 * Returns 'removed', 'restored' or `{ aside }`.
 */
function retireJudgedDirectory(fsApi, directory, judged, bytes) {
    const aside = `${directory}${RELEASED_MARK}${crypto.randomBytes(8).toString('hex')}`;
    // A directory that is gone before the move throws ENOENT here, which the
    // caller reports as removed by another command.
    fsApi.renameSync(directory, aside);
    let same;
    try {
        const moved = fsApi.lstatSync(aside, { bigint: true });
        same = moved.dev === judged.dev && moved.ino === judged.ino
            && readOwnerRecord(fsApi, aside)?.bytes?.equals(bytes) === true
            && fsApi.readdirSync(aside).every((entry) => entry === OWNER_FILE);
    } catch {
        same = false;
    }
    if (same) {
        discardDirectory(fsApi, aside);
        return 'removed';
    }
    if (present(fsApi, directory)) return { aside };
    try {
        fsApi.renameSync(aside, directory);
        return 'restored';
    } catch {
        return { aside };
    }
}

/**
 * The reclaim guard is a directory holding exactly the reclaimer's owner
 * record. It is removed only when that owner is stale or exactly forced, and
 * only while it is still the same directory with the same record.
 */
function judgeReclaimGuard(guardPath, { lockManager, forceHolder, fsApi, uid }) {
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
        if (!present(fsApi, guardPath)) return item('reclaim-guard', guardPath, 'absent', { reason: VANISHED });
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
        if (!present(fsApi, guardPath)) return item('reclaim-guard', guardPath, 'absent', { reason: VANISHED });
        return item('reclaim-guard', guardPath, 'kept', { reason: GUARD_CHANGED });
    }
    const outcome = retireJudgedDirectory(fsApi, guardPath, stat, record.bytes);
    if (outcome === 'removed') return item('reclaim-guard', guardPath, 'removed', { reason: decision.how, holder: record.owner });
    if (outcome === 'restored') {
        return item('reclaim-guard', guardPath, 'kept', {
            reason: 'another guard took its place while it was being removed and was put back; run ploinky unlock again',
        });
    }
    return item('reclaim-guard', guardPath, 'kept', {
        reason: `another guard took its place while it was being removed and was moved aside to ${outcome.aside}`,
        steps: [`Inspect ${outcome.aside}; once you ${STOP_FIRST}, remove it by hand: rm -r -- ${quote(outcome.aside)}`],
    });
}

// A path that vanishes under any read is the work of another command: the
// item is absent if it is gone, or kept as changing if it is still there.
function unlockReclaimGuard(guardPath, options) {
    try {
        return judgeReclaimGuard(guardPath, options);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return present(options.fsApi, guardPath)
            ? item('reclaim-guard', guardPath, 'kept', { reason: GUARD_CHANGED })
            : item('reclaim-guard', guardPath, 'absent', { reason: VANISHED });
    }
}

const LOCK_CHANGED = 'it changed while it was being removed (its holder or contents moved); run ploinky unlock again';

/** The workspace lock, through the lock manager's guarded reclaim. */
function judgeWorkspaceLock(lockPath, { lockManager, forceHolder, fsApi }) {
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
    return item('workspace-lock', lockPath, 'kept', { reason: LOCK_CHANGED, holder: owner });
}

function unlockWorkspaceLock(lockPath, options) {
    try {
        return judgeWorkspaceLock(lockPath, options);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return present(options.fsApi, lockPath)
            ? item('workspace-lock', lockPath, 'kept', { reason: LOCK_CHANGED })
            : item('workspace-lock', lockPath, 'absent', { reason: VANISHED });
    }
}

// The store lock record is written by the Box. Its holder becomes a pasteable
// `--force-holder` value only when it is a value the command accepts and
// nothing in it would be redacted, and it is single-quoted even then.
// Otherwise the step names no field of the record at all.
function storeForceStep(token, lockPath) {
    if (FORCE_HOLDER_PATTERN.test(token) && clean(token) === token) {
        const [pid, host] = token.split('@');
        return `If pid ${pid} on ${host} no longer runs and this workspace's Box is stopped, `
            + `run: ploinky unlock --force-holder ${quote(token)}`;
    }
    return `Its owner record names no holder that --force-holder can match. Inspect ${lockPath}; once this `
        + `workspace's Box is stopped and no Ploinky command uses this store, remove it by hand: rm -- ${quote(lockPath)}`;
}

/**
 * The hardware store lock, under a freshly taken workspace lock, through the
 * store's own recovery (the Box must be observed stopped or absent).
 */
async function unlockStoreLock(identity, { lockManager, forceHolder, observeBoxState, fsApi, workspaceClear, validatePath }) {
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
        lock = await lockManager.acquire(identity.instance, { workspaceRoot: identity.workspaceRoot, validatePath });
    } catch (error) {
        return item('store-lock', lockPath, 'kept', { reason: `the workspace lock could not be taken: ${error.message}`, holder: current.owner, token });
    }
    let recoveryFailed = false;
    try {
        validatePath();
        const result = recoverStaleStoreLock({
            storeRoot, hostLock: lock, instance: identity.instance, fsApi, forceHolder,
            inspectBox: () => observeBoxState(identity),
        });
        if (!result.recovered) return item('store-lock', lockPath, 'absent');
        const how = forceHolder === token ? `forced: --force-holder ${token} named its holder` : 'its holder is gone';
        return item('store-lock', lockPath, 'removed', { reason: `${how}; moved aside to ${result.quarantine}`, holder: result.owner });
    } catch (error) {
        if (error?.code === 'ENOENT') return item('store-lock', lockPath, 'absent', { reason: VANISHED });
        if (error?.code !== 'store_busy') {
            recoveryFailed = true;
            throw error;
        }
        return item('store-lock', lockPath, 'kept', {
            reason: error.message, holder: current.owner, token,
            steps: current.owner?.domain === 'box' ? undefined : [storeForceStep(token, lockPath)],
        });
    } finally {
        try { lock.release(); } catch (error) {
            if (!recoveryFailed) throw error;
        }
    }
}

// The owner of a reclaim guard, when it is a running command.
function liveGuardOwner(guardPath, { lockManager, fsApi }) {
    try {
        const record = readOwnerRecord(fsApi, guardPath);
        if (record?.owner && lockManager.classifyHolder(record.owner).state === LIVENESS.live) return record.owner;
    } catch {
        // An unreadable guard is not proof of a running reclaimer.
    }
    return null;
}

function removeByHand(target) {
    return [`Inspect ${target}; once no ploinky unlock runs for this workspace, remove it by hand: rm -r -- ${quote(target)}`];
}

// Why the unlock lock could not be taken, from what the last attempt saw.
function unlockLockRefusal(lockPath, error, { lockManager, fsApi }) {
    const refused = (reason, steps) => item('unlock-lock', lockPath, 'refused', { reason, steps });
    if (error?.lockBusy !== true) {
        return refused(`the unlock lock could not be taken: ${error?.message ?? error}`, removeByHand(lockPath));
    }
    if (error.contendedGuard) {
        const reclaimer = liveGuardOwner(error.contendedGuard, { lockManager, fsApi });
        if (reclaimer) {
            return refused(`another \`ploinky unlock\` is taking over the unlock lock now (${describeHolder(reclaimer)}); `
                + 'run it again after it finishes');
        }
        return refused(`the unlock lock of a \`ploinky unlock\` that is no longer running cannot be taken over: its reclaim `
            + `guard ${error.contendedGuard} is still in place, and unlock never removes its own reclaim guard`,
        removeByHand(error.contendedGuard));
    }
    const holder = error.observedKind === 'owner' ? error.holder : null;
    if (holder && error.verdict?.state === LIVENESS.live) {
        return refused(`another \`ploinky unlock\` is running for this workspace (${describeHolder(holder)}); unlock `
            + 'commands for one workspace run one at a time: run it again after it finishes');
    }
    if (holder && error.verdict?.state === LIVENESS.undetermined) {
        return refused(`it is held by ${describeHolder(holder)}, which cannot be classified (${error.verdict.reason})`,
            removeByHand(lockPath));
    }
    if (holder) return refused(`its holder is gone, but it was not taken over in time (${error.verdict?.reason}); run it again`);
    if (error.observedKind === 'ownerless' || error.observedKind === 'malformed') {
        return refused(error.observedKind === 'ownerless' ? 'it has no owner record but is not empty' : 'it cannot be attributed',
            removeByHand(lockPath));
    }
    return refused('another `ploinky unlock` holds it; run it again after it finishes');
}

/**
 * Serializes unlock per workspace. Returns `{ lock, lockPath }` (`lock` is
 * null when the workspace has no `locks/` directory: unlock does not create
 * it) or `{ refused }`, the item that explains why unlock stops.
 */
async function takeUnlockLock(locksPath, { lockManager, fsApi, uid, waitMs, validatePath }) {
    const lockPath = path.join(locksPath, UNLOCK_LOCK_NAME);
    let stat;
    try {
        stat = fsApi.lstatSync(locksPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return { lock: null, lockPath };
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
        return {
            refused: item('unlock-lock', lockPath, 'refused', {
                reason: `${locksPath} is not a private directory owned by you`,
                steps: [`Inspect ${locksPath}; it must be a private directory owned by you.`],
            }),
        };
    }
    try {
        return { lock: await lockManager.acquireAt(lockPath, UNLOCK_LOCK_LABEL, { timeoutMs: waitMs, validatePath }), lockPath };
    } catch (error) {
        return { refused: unlockLockRefusal(lockPath, error, { lockManager, fsApi }) };
    }
}

// The unlock lock's own reclaim guard is never removed by unlock. One left by
// an unlock that is no longer running is listed, so that it is removed by hand
// before it blocks the next takeover.
function unlockGuardLeftover(guardPath, { lockManager, fsApi }) {
    if (!present(fsApi, guardPath) || liveGuardOwner(guardPath, { lockManager, fsApi })) return null;
    return item('unlock-guard', guardPath, 'kept', {
        reason: 'a `ploinky unlock` that is no longer running left it, and unlock never removes its own reclaim guard',
        steps: removeByHand(guardPath),
    });
}

async function recoverLocks(identity, paths, { lockManager, forceHolder, observeBoxState, fsApi, uid, locksPresent, validatePath }) {
    const lockPath = paths.workspaceLock;
    const guardPath = `${lockPath}${RECLAIM_SUFFIX}`;
    const guard = locksPresent
        ? unlockReclaimGuard(guardPath, { lockManager, forceHolder, fsApi, uid })
        : item('reclaim-guard', guardPath, 'absent');
    let workspaceLock;
    if (!locksPresent) workspaceLock = item('workspace-lock', lockPath, 'absent');
    else if (guard.state === 'kept') {
        workspaceLock = item('workspace-lock', lockPath, 'kept', { reason: 'its reclaim guard is still in place (see above)' });
    } else workspaceLock = unlockWorkspaceLock(lockPath, { lockManager, forceHolder, fsApi });
    const store = await unlockStoreLock(identity, {
        lockManager, forceHolder, observeBoxState, fsApi, workspaceClear: workspaceLock.state !== 'kept', validatePath,
    });
    return [guard, workspaceLock, store];
}

function unlockReport(identity, items) {
    const exitCode = items.some((entry) => entry.state === 'kept' || entry.state === 'refused') ? 1 : 0;
    return Object.freeze({ identity, items: Object.freeze(items), exitCode });
}

/**
 * Runs `ploinky unlock` for one workspace identity. Returns
 * `{ identity, items, exitCode }`; exitCode is 1 when anything was kept or
 * another unlock of this workspace refused this one.
 */
export async function unlockWorkspace({
    identity,
    lockManager,
    observeBoxState,
    forceHolder = null,
    fsApi = fs,
    uid = currentUid(),
    unlockWaitMs = UNLOCK_WAIT_MS,
}) {
    if (forceHolder !== null && !FORCE_HOLDER_PATTERN.test(String(forceHolder))) {
        throw new PloinkyBoxError('--force-holder requires PID@MACHINE, as printed by the busy lock error', {
            code: 'PLOINKY_BOX_ARGUMENT_INVALID',
        });
    }
    const validatePath = () => inspectHostStateSkeleton(identity.workspaceRoot, { fsApi, uid });
    const paths = validatePath();
    const serial = await takeUnlockLock(paths.locks, { lockManager, fsApi, uid, waitMs: unlockWaitMs, validatePath });
    if (serial.refused) return unlockReport(identity, [serial.refused]);
    let items;
    try {
        validatePath();
        items = await recoverLocks(identity, paths, {
            lockManager, forceHolder, observeBoxState, fsApi, uid, locksPresent: serial.lock !== null, validatePath,
        });
        validatePath();
        const leftover = serial.lock ? unlockGuardLeftover(`${serial.lockPath}${RECLAIM_SUFFIX}`, { lockManager, fsApi }) : null;
        if (leftover) items.push(leftover);
    } catch (error) {
        // The original failure is reported; an unlock lock that cannot be
        // released here is reclaimed by the next unlock once this one exits.
        try { serial.lock?.release(); } catch {}
        throw error;
    }
    if (serial.lock) {
        try {
            serial.lock.release();
        } catch (error) {
            items.push(item('unlock-lock', serial.lockPath, 'kept', {
                reason: `it could not be released: ${error.message}`, steps: removeByHand(serial.lockPath),
            }));
        }
    }
    return unlockReport(identity, items);
}

const TITLES = Object.freeze({
    'unlock-lock': 'Unlock lock',
    'reclaim-guard': 'Workspace lock reclaim guard',
    'workspace-lock': 'Workspace lock',
    'store-lock': 'Hardware store lock',
    'unlock-guard': 'Unlock lock reclaim guard',
});

// Reasons, steps and contents carry fields that a Box process can write (the
// store lock record, entry names): every printed value is one line without
// control characters, so nothing in them can drive the terminal.
function clean(value) {
    return sanitizeControlDiagnosticText(String(value ?? ''), { limit: 2000 });
}

// Paths and manual steps are operator-facing locations, not secrets: only
// control characters are stripped, so a path such as `/srv/ws-token:1/...`
// prints as it is. `clean` keeps secret redaction for the free-form text.
// A step never embeds a Box-written field unless it was validated and
// quoted where it was built (storeForceStep).
function cleanLocation(value) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 2000);
}

// A reason mixes Box-writable text (redacted) with paths the command itself
// composed under the workspace root (kept verbatim, controls stripped).
function cleanReason(value, workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot) return clean(value);
    return String(value ?? '').split(workspaceRoot).map(clean).join(cleanLocation(workspaceRoot));
}

export function formatUnlockReport(report) {
    const lines = [];
    const root = report.identity?.workspaceRoot;
    for (const entry of report.items) {
        const title = `${TITLES[entry.kind]} ${cleanLocation(entry.path)}`;
        if (entry.state === 'absent') {
            lines.push(entry.reason ? `${title}: not present (${cleanReason(entry.reason, root)}).` : `${title}: not present.`);
        } else if (entry.state === 'removed') lines.push(`${title}: removed (${cleanReason(entry.reason, root)}).`);
        else {
            lines.push(`${title}: ${entry.state === 'refused' ? 'refused' : 'kept'}: ${cleanReason(entry.reason, root)}.`);
            if (entry.contents?.length) {
                lines.push(`  It holds: ${entry.contents.slice(0, 20).map(clean).join(', ')}${entry.contents.length > 20 ? ', ...' : ''}`);
            }
            for (const step of entry.steps || []) lines.push(`  Next: ${cleanLocation(step)}`);
        }
    }
    if (report.items.some((entry) => entry.state === 'refused')) lines.push('No lock was inspected or removed.');
    else {
        lines.push(report.exitCode === 0
            ? 'No stuck lock remains for this workspace.'
            : 'Some locks were kept. Nothing with leftover contents, a running holder or an unclassified holder is removed automatically.');
    }
    return `${lines.join('\n')}\n`;
}
