import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Application lock for one Git checkout family.
//
// The lock is a directory inside the common Git directory, so every writer
// that can mutate the checkout (host CLI, in-Box core, direct core, linked
// worktrees sharing the same repository) observes the same physical file. It
// complements, and never replaces, Git's own index/ref locks: an editor or a
// manual Git command does not take it.
//
// Acquisition publishes a complete owner record atomically by renaming a
// private staging directory onto the lock name. A lock is never stolen because
// of its age. It is reclaimed only when the owner is affirmatively dead, and
// only by one reclaimer at a time: in the same boot and PID namespace (ESRCH,
// or a different process start identity for the recorded PID), or, across
// scopes, when the host's attestation of this workspace's Box proves that the
// Box run the owner recorded has ended. Anything else is a bounded wait
// followed by a named busy/recovery-required result.

export const CHECKOUT_LOCK_NAME = 'ploinky-update.lock';
const OWNER_FILE = 'owner.json';
const OWNER_SCHEMA = 'ploinky-update-checkout-lock';
const OWNER_VERSION = 1;
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_RETRY_MS = 100;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;

function sleepSync(ms) {
    if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readProcessStart(pid, { platform = process.platform, fsApi = fs, execFile = execFileSync } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return '';
    try {
        if (platform === 'linux') {
            const stat = String(fsApi.readFileSync(`/proc/${pid}/stat`, 'utf8'));
            const end = stat.lastIndexOf(')');
            const ticks = end < 0 ? '' : String(stat.slice(end + 1).trim().split(/\s+/)[19] || '');
            return ticks ? `linux-proc:${ticks}` : '';
        }
        if (platform === 'darwin') {
            const started = String(execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_000,
            })).trim().replace(/\s+/g, ' ');
            return started ? `darwin-ps:${started}` : '';
        }
    } catch (_) {}
    return '';
}

// A PID is meaningful only inside one boot and one PID namespace.
export function readProcessScope({ platform = process.platform, fsApi = fs, execFile = execFileSync } = {}) {
    try {
        if (platform === 'linux') {
            const bootId = String(fsApi.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
            const pidNamespace = fsApi.readlinkSync('/proc/self/ns/pid');
            return bootId && pidNamespace ? { bootId, pidNamespace, scope: JSON.stringify(['linux', bootId, pidNamespace]) } : null;
        }
        if (platform === 'darwin') {
            const bootTime = String(execFile('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_000,
            })).trim();
            return bootTime ? { bootId: bootTime, pidNamespace: `darwin:${os.hostname()}`, scope: JSON.stringify(['darwin', os.hostname(), bootTime]) } : null;
        }
    } catch (_) {}
    return null;
}

function defaultProcessApi() {
    return {
        pid: process.pid,
        hostname: os.hostname(),
        scope: () => readProcessScope(),
        processStart: (pid) => readProcessStart(pid),
        kill: (pid, signal) => process.kill(pid, signal),
    };
}

function readOwner(lockPath, fsApi) {
    const ownerPath = path.join(lockPath, OWNER_FILE);
    try {
        const dir = fsApi.lstatSync(lockPath);
        if (!dir.isDirectory() || dir.isSymbolicLink()) return { owner: null, reason: 'lock path is not a directory' };
        const stat = fsApi.lstatSync(ownerPath);
        if (!stat.isFile() || stat.isSymbolicLink()) return { owner: null, reason: 'lock owner is not a regular file' };
        const owner = JSON.parse(fsApi.readFileSync(ownerPath, 'utf8'));
        if (!owner || owner.schema !== OWNER_SCHEMA || typeof owner.token !== 'string'
            || !Number.isSafeInteger(owner.pid)) {
            return { owner: null, reason: 'lock owner record is incomplete' };
        }
        return { owner, dirIdentity: `${dir.dev}:${dir.ino}` };
    } catch (error) {
        if (error?.code === 'ENOENT') return { owner: null, missing: true, reason: 'lock owner is missing' };
        return { owner: null, reason: `lock owner is unreadable: ${error?.code || error?.message}` };
    }
}

/**
 * The Box run of a host-driven in-Box update, as the host attests it: this
 * workspace's Box instance, the exact container the update was exec'd into,
 * the engine that runs it, and whether that container was the only container
 * of this workspace, in any state, in that engine when the host started the
 * update under its workspace lock. Anything incomplete is no attestation.
 */
function normalizeBoxRun(boxRun) {
    if (!boxRun || typeof boxRun.workspace !== 'string' || !boxRun.workspace
        || !CONTAINER_ID_PATTERN.test(String(boxRun.containerId || ''))) {
        return null;
    }
    return {
        workspace: boxRun.workspace,
        containerId: boxRun.containerId,
        engine: typeof boxRun.engine === 'string' ? boxRun.engine : '',
        soleContainer: boxRun.soleContainer === true,
    };
}

// Only a host-driven in-Box update records a Box binding, and it runs directly
// in its container's PID namespace, as does an acquirer holding an attestation.
// A bound owner in another scope therefore ran in an earlier run of the
// acquirer's container, or in another Box container of this workspace that no
// longer existed in the same engine while the host held the workspace lock.
function boxRunEnded(recorded, run) {
    if (!run || !recorded || recorded.workspace !== run.workspace
        || !CONTAINER_ID_PATTERN.test(String(recorded.containerId || ''))) {
        return false;
    }
    if (recorded.containerId === run.containerId) return true;
    return run.soleContainer && Boolean(run.engine) && recorded.engine === run.engine;
}

/**
 * The same Box-run proof for a lock protocol that records its owner's Box run
 * as `box` (skill exports): the binding a lock taken in this run records, and
 * whether the run a recorded binding names has ended. Null without a complete
 * attestation.
 */
export function boxRunLockEvidence(boxRun) {
    const run = normalizeBoxRun(boxRun);
    if (!run) return null;
    return Object.freeze({
        binding: Object.freeze({ workspace: run.workspace, containerId: run.containerId, engine: run.engine }),
        ended: recorded => boxRunEnded(recorded, run),
    });
}

/**
 * Affirmative proof that the recorded owner no longer runs. Uncertainty
 * (another boot/namespace, an unreadable identity, EPERM) is never proof,
 * unless `boxRun`, the host's attestation, proves the owner's Box run ended.
 */
export function ownerIsProvenDead(owner, processApi = defaultProcessApi(), boxRun = null) {
    const current = processApi.scope();
    if (!owner?.scope || !current?.scope) return false;
    if (owner.scope !== current.scope) return boxRunEnded(owner.box, normalizeBoxRun(boxRun));
    try {
        processApi.kill(owner.pid, 0);
    } catch (error) {
        return error?.code === 'ESRCH';
    }
    const start = processApi.processStart(owner.pid);
    return Boolean(owner.processStart && start && start !== owner.processStart);
}

function tryReclaim(commonDir, lockPath, captured, fsApi) {
    const reclaimPath = path.join(commonDir, `${CHECKOUT_LOCK_NAME}.reclaim`);
    try {
        fsApi.mkdirSync(reclaimPath, { mode: 0o700 });
    } catch (error) {
        return { reclaimed: false, reclaimBusy: error?.code === 'EEXIST' };
    }
    try {
        const current = readOwner(lockPath, fsApi);
        if (current.owner?.token !== captured.owner.token || current.dirIdentity !== captured.dirIdentity) {
            return { reclaimed: false };
        }
        const tomb = path.join(commonDir, `${CHECKOUT_LOCK_NAME}.stale-${captured.owner.token}`);
        fsApi.renameSync(lockPath, tomb);
        try {
            fsApi.unlinkSync(path.join(tomb, OWNER_FILE));
            fsApi.rmdirSync(tomb);
        } catch (_) {
            // The lock name is already free; an unexpected leftover stays for inspection.
        }
        return { reclaimed: true };
    } catch (_) {
        return { reclaimed: false };
    } finally {
        try { fsApi.rmdirSync(reclaimPath); } catch (_) {}
    }
}

/**
 * Acquire the checkout-family lock synchronously with a bounded wait.
 *
 * `boxRun` is the host's attestation of the Box run of a host-driven in-Box
 * update (see normalizeBoxRun). The owner record binds to it, and it proves
 * owners of ended runs of this workspace's Box dead.
 *
 * @returns {{ ok: true, lock: object } | { ok: false, code: string, reason: string, owner?: object }}
 *   `code` is `lock-busy` (live or unprovable owner), `lock-recovery-required`
 *   (malformed state or a stale reclaim marker) or `lock-unavailable`
 *   (the common Git directory cannot hold the lock, e.g. read-only).
 */
export function acquireCheckoutLock({
    commonDir,
    checkout = '',
    transactionId = crypto.randomUUID(),
    waitMs = DEFAULT_WAIT_MS,
    retryMs = DEFAULT_RETRY_MS,
    fsApi = fs,
    processApi = defaultProcessApi(),
    boxRun = null,
    now = () => Date.now(),
    sleep = sleepSync,
} = {}) {
    const lockPath = path.join(commonDir, CHECKOUT_LOCK_NAME);
    const token = crypto.randomUUID();
    const scope = processApi.scope();
    const run = normalizeBoxRun(boxRun);
    const owner = {
        schema: OWNER_SCHEMA,
        version: OWNER_VERSION,
        token,
        transactionId,
        pid: processApi.pid,
        processStart: processApi.processStart(processApi.pid),
        bootId: scope?.bootId || '',
        pidNamespace: scope?.pidNamespace || '',
        scope: scope?.scope || '',
        hostname: processApi.hostname,
        box: run ? { workspace: run.workspace, containerId: run.containerId, engine: run.engine } : null,
        checkout,
        createdAt: new Date(now()).toISOString(),
    };
    const staging = path.join(commonDir, `${CHECKOUT_LOCK_NAME}.tmp-${token}`);
    try {
        fsApi.mkdirSync(staging, { mode: 0o700 });
        fsApi.writeFileSync(path.join(staging, OWNER_FILE), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
        try { fsApi.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
        return { ok: false, code: 'lock-unavailable', reason: `cannot create the checkout lock in ${commonDir}: ${error?.code || error?.message}` };
    }

    const deadline = now() + Math.max(0, waitMs);
    let lastObservation = null;
    try {
        while (true) {
            try {
                fsApi.renameSync(staging, lockPath);
                const stat = fsApi.lstatSync(lockPath);
                return { ok: true, lock: createHandle({ lockPath, token, identity: `${stat.dev}:${stat.ino}`, owner, fsApi }) };
            } catch (error) {
                if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM'].includes(error?.code)) {
                    return { ok: false, code: 'lock-unavailable', reason: `cannot publish the checkout lock ${lockPath}: ${error?.code || error?.message}` };
                }
            }
            const captured = readOwner(lockPath, fsApi);
            lastObservation = captured;
            if (captured.owner && ownerIsProvenDead(captured.owner, processApi, run)) {
                const outcome = tryReclaim(commonDir, lockPath, captured, fsApi);
                if (outcome.reclaimed) continue;
                if (outcome.reclaimBusy) lastObservation = { ...captured, reclaimBusy: true };
            }
            if (now() >= deadline) break;
            sleep(Math.max(1, retryMs));
        }
    } finally {
        try { fsApi.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    }
    const holder = lastObservation?.owner || null;
    const publicOwner = holder ? {
        pid: holder.pid, hostname: holder.hostname, transactionId: holder.transactionId, createdAt: holder.createdAt,
    } : null;
    if (!holder || lastObservation?.reclaimBusy) {
        return {
            ok: false,
            code: 'lock-recovery-required',
            reason: lastObservation?.reclaimBusy
                ? `checkout lock ${lockPath} belongs to a dead owner but a reclaim marker is present; inspect it manually`
                : `checkout lock ${lockPath} has no valid owner (${lastObservation?.reason || 'unknown'}); inspect it manually`,
            owner: publicOwner,
        };
    }
    return {
        ok: false,
        code: 'lock-busy',
        reason: `checkout is locked by another update (pid ${holder.pid} on ${holder.hostname || 'unknown host'})`,
        owner: publicOwner,
    };
}

function createHandle({ lockPath, token, identity, owner, fsApi }) {
    let released = false;
    function stillHeld() {
        if (released) return false;
        const current = readOwner(lockPath, fsApi);
        return current.owner?.token === token && current.dirIdentity === identity;
    }
    return {
        path: lockPath,
        token,
        transactionId: owner.transactionId,
        isHeld: stillHeld,
        assertHeld() {
            if (!stillHeld()) {
                const error = new Error(`checkout lock ${lockPath} is no longer held by this update`);
                error.code = 'PLOINKY_CHECKOUT_LOCK_LOST';
                throw error;
            }
        },
        // Release only while the token and the lock inode still match.
        release() {
            if (released) return false;
            if (!stillHeld()) {
                released = true;
                return false;
            }
            const retired = `${lockPath}.released-${token}`;
            try {
                fsApi.renameSync(lockPath, retired);
            } catch (_) {
                return false;
            }
            released = true;
            try {
                fsApi.unlinkSync(path.join(retired, OWNER_FILE));
                fsApi.rmdirSync(retired);
            } catch (_) {}
            return true;
        },
    };
}
