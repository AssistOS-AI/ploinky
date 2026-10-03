// LIVE-C5 (spec 15.4 :1326): a host writer and an in-Box writer of the hardware policy store over the ACTUAL shared bind mount and its portable lock,
// the downgrade write barrier interleaved with both, and stale-lock recovery with a stopped Box. The reviewed fixed program, its parameters and the
// evaluators of what the product answers. Test-only.
//
// The two writers are the product's own: the Router's administrator route inside the Box (set_agent_limits and clear_agent_limits, the in-Box writer)
// and the host's `ploinky limits clear` (the host writer). The runner adds nothing to them. It reads the store, holds or abandons its lock and
// installs or removes the downgrade barrier with the product's own functions (cli/sandbox/hardwareLimits/store.mjs and storeLock.mjs), from the host
// and from inside the Box, so both sides see the SAME directory through the same mount.

import { BOX_STORE_ROOT, hardwareStorePaths } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { STORE_BUSY_MESSAGE, STORE_LOCK_DEADLINE_MS, STORE_LOCK_DIRECTORY } from '../../cli/sandbox/hardwareLimits/storeLock.mjs';

export const C5_AGENTS = Object.freeze(['s']);                       // one managed-network agent: the stored override is the writers' target
export const BOX_PRODUCT_ROOT = '/opt/ploinky';                      // the product modules the Box mounts read-only
export { BOX_STORE_ROOT, STORE_BUSY_MESSAGE, STORE_LOCK_DEADLINE_MS, STORE_LOCK_DIRECTORY };
export const OVERRIDES = Object.freeze({ low: Object.freeze({ memoryPercent: 10 }), high: Object.freeze({ memoryPercent: 20 }) });
// Every bound is a manifest value shown in the approval summary. A held lock outlasts the product's own 10 s wait for it, so the contender is refused.
export const STORE_BOUNDS = Object.freeze({
    holdMs: STORE_LOCK_DEADLINE_MS + 8000,    // how long a live holder keeps the lock (the contender waits STORE_LOCK_DEADLINE_MS and is refused)
    staleHoldMs: 120000,                      // a Box holder whose Box is stopped while it holds: the stop ends it long before this
    acquireMs: 5000,                          // the runner's own wait for the store lock (barrier, gate-off check)
    visibleMs: 30000, visibleIntervalMs: 250, // how long a started holder may take to show its lock through the mount
    raceRounds: 3,                            // host clear against an in-Box setter that read the token earlier, repeated
    programMs: 60000, hostClearMs: 120000, stopMs: 120000, adminMs: 60000,
});
export const storePolling = Object.freeze({ deadlineMs: STORE_BOUNDS.visibleMs, intervalMs: STORE_BOUNDS.visibleIntervalMs });

// Product text the evaluators recognise (imported, so a wording change shows up in the tests).
export const BARRIER_MESSAGE = 'A gate-on to gate-off transition is pending';
export const STORE_BUSY_TEXT = STORE_BUSY_MESSAGE.slice(0, 40);      // "Hardware policy store is locked. Stop th"
export const RECOVERY_REFUSALS = Object.freeze({
    running: /not proven stopped or absent|is paused/,
    liveHost: /still running on this host, so the lock is never taken over/,
});

const problem = message => Object.assign(new Error(message), { store: true });
const text = (value, max = 240) => String(value ?? '').slice(0, max);

export const hostStoreRoot = (home, instance) => hardwareStorePaths({ identity: { instance }, homeDirectory: home }).storeRoot;

// Runs on the host or inside the Box. argv[1] is one JSON object; the product source root and the store root are parameters, never source text.
export const STORE_PROGRAM = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const params = JSON.parse(process.argv[1]);
const MODES = ['inspect', 'hold', 'stale', 'barrier-begin', 'barrier-remove', 'gate-off-check'];
const HEX32 = /^[a-f0-9]{32}$/;
if (params.schema !== 1 || !MODES.includes(params.mode) || !['host', 'box'].includes(params.domain) || !path.isAbsolute(params.root) || !path.isAbsolute(params.storeRoot)
  || !/^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/.test(params.instance) || !/^[a-f0-9]{12}$/.test(params.pathHash) || !path.isAbsolute(params.workspaceRoot)
  || (params.domain === 'host' && !path.isAbsolute(params.home))
  || !Number.isInteger(params.acquireMs) || params.acquireMs < 0 || params.acquireMs > 60000
  || !Number.isInteger(params.holdMs) || params.holdMs < 0 || params.holdMs > 300000
  || (params.operationId !== undefined && !HEX32.test(params.operationId))) throw new Error('Invalid store program parameters');
const load = (relative) => import(new URL('file://' + params.root + '/' + relative).href);
const [store, lockModule] = await Promise.all([load('cli/sandbox/hardwareLimits/store.mjs'), load('cli/sandbox/hardwareLimits/storeLock.mjs')]);
const identity = { instance: params.instance, pathHash: params.pathHash, workspaceRoot: params.workspaceRoot };
const paths = store.hardwareStorePaths({ identity, context: params.domain, homeDirectory: params.home, boxRoot: params.storeRoot });
if (paths.storeRoot !== params.storeRoot) throw new Error('The store root is not the one this workspace derives');
const out = (value) => fs.writeSync(1, JSON.stringify({ schema: 1, mode: params.mode, domain: params.domain, ...value }) + '\n');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const refusal = (error) => ({ ok: false, code: String(error && (error.code || error.name) || 'error').slice(0, 64), status: Number.isInteger(error && error.status) ? error.status : null, message: String(error && error.message || error).slice(0, 400) });
const lockFacts = (lock) => (!lock ? null : lock.malformed ? { malformed: true, reason: String(lock.reason).slice(0, 120) }
  : { malformed: false, token: lock.owner.token, pid: lock.owner.pid, hostname: String(lock.owner.hostname).slice(0, 80), domain: lock.owner.domain, operation: String(lock.owner.operation).slice(0, 80), dev: lock.dev, ino: lock.ino });
try {
  if (params.mode === 'inspect') {
    const snapshot = store.readStoreSnapshot({ paths, identity });
    const barrier = store.readBarrier({ paths });
    let quarantined = [];
    try {
      quarantined = fs.readdirSync(paths.storeRoot).filter((name) => name.startsWith('${STORE_LOCK_DIRECTORY}.stale-')).sort().map((name) => {
        let ownerToken = null;
        try { ownerToken = JSON.parse(fs.readFileSync(path.join(paths.storeRoot, name, 'owner.json'), 'utf8')).token; } catch (error) { ownerToken = null; }
        return { name, ownerToken };
      });
    } catch (error) { quarantined = []; }
    out({ ok: true, uid: process.getuid(), status: snapshot.status, diagnostic: snapshot.diagnostic, storeId: snapshot.storeId, token: snapshot.token, count: snapshot.agents.size,
      agents: Object.fromEntries(snapshot.agents), lock: lockFacts(lockModule.readStoreLockOwner(paths.storeRoot)),
      barrier: !barrier ? null : barrier.malformed ? { malformed: true, reason: String(barrier.reason).slice(0, 120) } : { malformed: false, operationId: barrier.barrier.operationId, policyToken: barrier.barrier.policyToken },
      quarantined });
  } else if (params.mode === 'hold' || params.mode === 'stale') {
    const lock = lockModule.acquireStoreLock({ storeRoot: paths.storeRoot, operation: 'c5-' + params.mode, deadlineMs: params.acquireMs, domain: params.domain });
    const acquiredAt = Date.now();
    out({ ok: true, phase: 'held', token: lock.token, pid: process.pid, acquiredAt });
    if (params.mode === 'stale') process.exit(0);
    await sleep(params.holdMs);
    try { lock.release(); out({ ok: true, phase: 'released', token: lock.token, heldMs: Date.now() - acquiredAt }); } catch (error) { out({ ...refusal(error), phase: 'release-refused', token: lock.token }); }
  } else if (params.mode === 'barrier-begin') {
    const result = store.beginDowngradeBarrier({ paths, identity, operationId: params.operationId, lockOptions: { deadlineMs: params.acquireMs } });
    out({ ok: true, operationId: params.operationId, token: result.token });
  } else if (params.mode === 'barrier-remove') {
    const result = store.removeDowngradeBarrier({ paths, identity, operationId: params.operationId, requireEmpty: true, lockOptions: { deadlineMs: params.acquireMs } });
    out({ ok: true, operationId: params.operationId, removed: result.removed });
  } else {
    const result = store.assertGateOffStoreEmpty({ paths, identity, lockOptions: { deadlineMs: params.acquireMs } });
    out({ ok: true, initialized: result.initialized, count: result.count, token: result.token });
  }
} catch (error) { out(refusal(error)); }
`;

// The parameters of one program run. `domain` decides the product root and the store root: the Box mounts /opt/ploinky and the store at
// BOX_STORE_ROOT; the host reads the same directory under its own home.
export function storeProgramParams({ profile, identity, domain, mode, holdMs = 0, acquireMs = STORE_BOUNDS.acquireMs, operationId }) {
    if (!['host', 'box'].includes(domain)) throw new Error('Unknown store domain');
    const home = profile.host.home;
    return {
        schema: 1, mode, domain, root: domain === 'box' ? BOX_PRODUCT_ROOT : profile.source.root,
        storeRoot: domain === 'box' ? BOX_STORE_ROOT : hostStoreRoot(home, identity.instance),
        instance: identity.instance, pathHash: identity.pathHash, workspaceRoot: identity.workspaceRoot, ...(domain === 'host' ? { home } : {}),
        acquireMs, holdMs, ...(operationId === undefined ? {} : { operationId }),
    };
}
export const hostProgramWords = params => ['--input-type=module', '-e', STORE_PROGRAM, JSON.stringify(params)];
// The exec argv inside the owned Box as the Box user (the store's owner through the keep-id mapping).
export const boxProgramWords = (boxId, params) => ['container', 'exec', '--user', 'podman', boxId, 'node', ...hostProgramWords(params)];

// The lines a program printed, parsed; null when any line is not one JSON object.
export function parseProgramLines(stdout) {
    const rows = [];
    for (const line of String(stdout ?? '').split('\n')) {
        if (!line.trim()) continue;
        let value = null;
        try { value = JSON.parse(line); } catch { return null; }
        if (!value || typeof value !== 'object' || value.schema !== 1) return null;
        rows.push(value);
    }
    return rows.length ? rows : null;
}

// ---- evaluators -----------------------------------------------------------------------------------------------------------------------------

export const tokenKey = token => (token && typeof token === 'object' ? `${token.epoch}:${token.revision}` : null);
export const revisionOf = token => (Number.isSafeInteger(token?.revision) ? token.revision : null);

export function assertValidStore(view, label) {
    if (!view || view.ok !== true || view.mode !== 'inspect') throw problem(`${label}: the store could not be inspected (${text(view?.code, 60)}: ${text(view?.message, 160)})`);
    if (view.status !== 'valid' || !/^[a-f0-9]{32}$/.test(view.storeId || '') || !Number.isSafeInteger(view.token?.revision)) throw problem(`${label}: the store is not valid (${text(view.status, 40)}: ${text(view.diagnostic, 160)})`);
    return view;
}
// The host and the Box read the SAME directory: one store identity and one policy stamp and the same entries.
export function assertSameStore(host, box, label) {
    assertValidStore(host, `${label} (host)`); assertValidStore(box, `${label} (Box)`);
    if (host.domain !== 'host' || box.domain !== 'box') throw problem(`${label}: the two views are not one host view and one Box view`);
    if (host.storeId !== box.storeId) throw problem(`${label}: the host and the Box see different stores (${host.storeId} and ${box.storeId})`);
    if (tokenKey(host.token) !== tokenKey(box.token) || host.count !== box.count || JSON.stringify(host.agents) !== JSON.stringify(box.agents)) throw problem(`${label}: the host and the Box disagree about the policy`);
    if (JSON.stringify(host.lock) !== JSON.stringify(box.lock) && !(host.lock && box.lock && host.lock.token === box.lock.token)) throw problem(`${label}: the host and the Box see different locks`);
    return Object.freeze({ storeId: host.storeId, token: host.token, count: host.count });
}
export function assertNoLockNoBarrier(view, label) {
    if (view.lock) throw problem(`${label}: a store lock is present (${text(view.lock.domain, 8)} ${text(view.lock.token, 8)})`);
    if (view.barrier) throw problem(`${label}: a downgrade barrier is pending`);
    return true;
}

export const body = reply => reply?.body ?? null;
export function assertCommitted(reply, label) {
    const value = body(reply);
    if (!reply || reply.status !== 200 || value?.ok !== true || value.committed !== true || !Number.isSafeInteger(value.token?.revision)) {
        throw problem(`${label}: the write was not committed (HTTP ${reply?.status}, ${text(value?.error, 60)} ${text(value?.message, 120)})`);
    }
    return value.token;
}
// A refused write: the typed outcome, nothing committed.
export function assertRefusedWrite(reply, code, label) {
    const value = body(reply);
    if (!reply || reply.status !== 409 || value?.ok !== false || value.error !== code || value.committed === true) {
        throw problem(`${label}: expected a 409 ${code} refusal with nothing committed (HTTP ${reply?.status}, ${text(value?.error, 60)}${value?.committed === true ? ', committed' : ''})`);
    }
    return Object.freeze({ status: 409, error: code });
}
export const sameLock = (a, b) => Boolean(a && b && !a.malformed && !b.malformed && a.token === b.token && a.pid === b.pid && a.domain === b.domain && a.dev === b.dev && a.ino === b.ino);
// The same lock seen from the two sides of the mount: the owner record is one file (token, pid, host, domain); device and inode numbers are compared only on one side.
export const sameOwner = (a, b) => Boolean(a && b && !a.malformed && !b.malformed && a.token === b.token && a.pid === b.pid && a.hostname === b.hostname && a.domain === b.domain);
export function assertLockNotStolen(before, after, label) {
    if (!sameLock(before, after)) throw problem(`${label}: the lock changed hands or was removed while its holder was alive (${text(before?.token, 8)} -> ${text(after?.token, 8)})`);
    return true;
}
// A program's last line must be the holder's own verified release: release() compares the owner token and the directory identity, so a stolen lock fails it.
export function assertHolderReleased(lines, label) {
    const last = lines?.at(-1);
    if (!last || last.ok !== true || last.phase !== 'released') throw problem(`${label}: the holder did not release its own lock (${text(last?.phase, 24)} ${text(last?.code, 40)}: ${text(last?.message, 160)})`);
    return Object.freeze({ token: last.token, heldMs: last.heldMs });
}
export function assertHostClearRefused(result, pattern, label) {
    const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
    if (!result || result.status === 0 || result.timedOut || result.signal) throw problem(`${label}: the host clear was not refused (exit ${result?.status})`);
    if (!pattern.test(output)) throw problem(`${label}: the host clear was refused for another reason (${text(output.trim(), 240)})`);
    return Object.freeze({ status: result.status });
}
export function assertExitZero(result, label) {
    if (!result || result.status !== 0 || result.timedOut || result.signal) throw problem(`${label}: did not exit 0 (status ${result?.status}, signal ${result?.signal ?? null})`);
    return Object.freeze({ status: 0 });
}
