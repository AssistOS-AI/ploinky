// LIVE-C5 (spec 15.4 :1326): the live executor, built over the adapter's own journaled commands. In one owned workspace and Box (gate on, one
// fixture agent s), a host writer (`ploinky limits clear`) and an in-Box writer (the Router's administrator route, with the product's own local
// operator session) coordinate through the real store directory the Box mounts, its portable lock and its downgrade barrier:
//
//   1  visibility        the host and the Box read ONE store (identity, stamp, entries); an in-Box write is seen by the host.
//   2  CAS race          two in-Box setters that read the same stamp: exactly one commits, the other is refused revision_conflict.
//   3  stale setter      a host clear commits first; an in-Box setter that read the stamp earlier is refused revision_conflict, and the clear is not lost.
//   4  host/Box race     the host clear and an in-Box setter started together: the clear always lands (no lost clear), and the stamp shows which order won.
//   5  live lock         a live host holder: the in-Box setter is refused store_busy; a live Box holder: the host clear is refused; neither lock is taken.
//   6  barrier           a pending downgrade barrier refuses the in-Box setter and clear and the host clear; a gate-off start still sees an EMPTY store; once
//                        the barrier is gone and a policy is committed, a gate-off start is refused (stored_limits_present): no gate-off Box with new policy.
//   7  stale recovery    a Box holder whose Box is STOPPED while it holds, a live host holder with the Box stopped, and a dead host holder with the Box
//                        stopped: the host clear recovers only the first and the last (the stale lock is quarantined, never deleted) and never the live one.
// Pass conditions are the spec's, unchanged: one conflicting mutation wins and the other conflicts; no lost clear; no gate-off Box with newly
// committed policy; no live lock theft. A check that cannot be made is BLOCKED (a prerequisite), never passed.

import crypto from 'node:crypto';
import { assertWorkspace, blocked } from './liveCommon.mjs';
import { ADMIN_REQUEST } from './liveGpuCommands.mjs';
import { FIXTURE_REPOSITORY } from './liveFixture.mjs';
import { parseAdminReply } from './liveAvailabilityCommands.mjs';
import {
    BARRIER_MESSAGE, OVERRIDES, RECOVERY_REFUSALS, STORE_BOUNDS, STORE_BUSY_TEXT, assertCommitted, assertExitZero, assertHolderReleased, assertHostClearRefused, assertLockNotStolen, assertNoLockNoBarrier,
    assertRefusedWrite, assertSameStore, assertValidStore, boxProgramWords, hostProgramWords, parseProgramLines, revisionOf, sameLock, sameOwner, storePolling, storeProgramParams, tokenKey,
} from './liveStoreCommands.mjs';

const sleepMs = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const processIsDead = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; } };

export function createStoreCases({ profile, run, command, inspectBox, safeArtifact, sleep = sleepMs, polling = storePolling, isDead = processIsDead, now = () => Date.now() }) {
    const agentRef = `${FIXTURE_REPOSITORY}/s`;
    const fail = (message, evidence = null) => Object.assign(new Error(message), evidence ? { evidence } : {});
    let captureCounter = 0;
    const holders = [];

    // ---- the in-Box writer: the Router's administrator route, as the product's local operator ----
    async function adminCall(kind, method, bodyValue = null) {
        const mutating = method === 'POST';
        const result = await command(kind, profile.engine.path, ['container', 'exec', '--user', 'podman', profile.box.id, 'node', '-e', ADMIN_REQUEST, method, bodyValue === null ? '' : JSON.stringify(bodyValue)],
            { deadlineMs: STORE_BOUNDS.adminMs, journal: mutating, tolerate: true, ...(mutating ? { capture: `${kind}-${++captureCounter}` } : {}) });
        if (result.cancelled) throw new Error('The administrator request was cancelled');
        const reply = result.status === 0 && !result.timedOut ? parseAdminReply(result.stdout) : null;
        if (!reply) throw blocked(`The administrator channel did not answer (exit ${result.status}${result.timedOut ? ', timed out' : ''})`);
        return reply;
    }
    async function adminState() {
        const reply = await adminCall('store-admin-state', 'GET');
        if (reply.status !== 200 || reply.body?.ok !== true || !reply.body?.token) throw blocked(`The hardware-limits administrator route answered ${reply.status}: ${reply.text.slice(0, 200)}`);
        return reply.body;
    }
    const setLimits = (kind, override, token) => adminCall(kind, 'POST', { action: 'set_agent_limits', expectedToken: token, agentRef, limits: { ...override } });
    const clearLimits = (kind, token) => adminCall(kind, 'POST', { action: 'clear_agent_limits', expectedToken: token, agentRef });

    // ---- the reviewed store program, on the host or inside the Box ----
    function programCommand(identity, domain, mode, kind, extra = {}, { journal = true, deadlineMs = STORE_BOUNDS.programMs } = {}) {
        const params = storeProgramParams({ profile, identity, domain, mode, ...extra });
        const options = { deadlineMs, journal, tolerate: true, ...(journal ? { capture: `${kind}-${++captureCounter}` } : {}) };
        return domain === 'box'
            ? command(kind, profile.engine.path, boxProgramWords(profile.box.id, params), options)
            : command(kind, profile.node.path, hostProgramWords(params), options);
    }
    async function runProgram(identity, domain, mode, kind, extra, options) {
        const result = await programCommand(identity, domain, mode, kind, extra, options);
        return finish(result, `${domain} ${mode}`);
    }
    function finish(result, label) {
        if (result.cancelled) throw new Error(`The store program was cancelled (${label})`);
        const lines = result.status === 0 && !result.timedOut ? parseProgramLines(result.stdout) : null;
        if (!lines) throw blocked(`The ${label} store program did not answer (exit ${result.status}${result.timedOut ? ', timed out' : ''}): ${String(result.stderr ?? '').trim().slice(0, 200)}`);
        return lines;
    }
    // A holder runs in the background; it is settled before the case returns, whatever happens.
    function startHolder(identity, domain, mode, kind, extra) {
        const settled = programCommand(identity, domain, mode, kind, extra, { deadlineMs: Math.max(extra.holdMs, 1000) + STORE_BOUNDS.programMs }).then(result => ({ result }), error => ({ error }));
        holders.push(settled);
        return settled;
    }
    async function settleHolder(settled, label, { killed = false } = {}) {
        const outcome = await settled;
        if (outcome.error) throw outcome.error;
        if (killed) return outcome.result;
        return finish(outcome.result, label);
    }
    const view = async (identity, domain, label) => {
        const [line] = await runProgram(identity, domain, 'inspect', `store-inspect-${domain}`, {}, { journal: false });
        try { return assertValidStore(line, label); } catch (error) { throw fail(error.message, { view: line }); }
    };
    // Poll until a started holder's lock shows through the mount (from the OTHER side when `domain` says so), or the bound passes.
    async function waitForLock(identity, domain, wanted, label) {
        const started = now(); let last = null;
        for (;;) {
            last = await view(identity, domain, `${label} (waiting)`);
            if (last.lock && !last.lock.malformed && last.lock.domain === wanted) return last;
            if (now() - started >= polling.deadlineMs) throw fail(`${label}: the ${wanted}-domain lock never became visible in the ${domain} view`, { last: last.lock });
            await sleep(polling.intervalMs);
        }
    }
    const hostClear = (kind, ref = agentRef) => command(kind, profile.node.path, [profile.candidate.path, 'limits', 'clear', '--agent', ref], { deadlineMs: STORE_BOUNDS.hostClearMs, tolerate: true, capture: `${kind}-${++captureCounter}` });

    // =========================================================================
    async function liveC5() {
        if (!profile.agents.some(agent => agent.role === 's')) throw blocked('LIVE-C5 requires the owned fixture agent s');
        const identity = assertWorkspace(profile);
        const box = await inspectBox();
        if (box.running !== true) throw blocked('The owned Box is not running');
        const evidence = { agent: agentRef, box: profile.box.id };
        const record = (name, value) => { evidence[name] = value; safeArtifact(`store-${name}`, value); };
        try {
            await steps();
        } finally {
            // Leave nothing running: every background holder ends by itself (bounded) or by its Box; settle them all before cleanup.
            await Promise.allSettled(holders);
        }
        return evidence;

        async function steps() {
            // ---- 1 visibility: one store, seen from both sides -------------------------------------------------------------------------------
            const baseline = await adminState();
            const host0 = await view(identity, 'host', 'baseline'); const box0 = await view(identity, 'box', 'baseline');
            try { assertSameStore(host0, box0, 'baseline'); assertNoLockNoBarrier(host0, 'baseline'); } catch (error) { throw fail(error.message, { host: host0, box: box0 }); }
            if (host0.count !== 0) throw blocked(`LIVE-C5 needs an empty store to start (it holds ${host0.count} entries)`);
            if (tokenKey(baseline.token) !== tokenKey(host0.token)) throw fail('The administrator route and the host read different stamps', { route: baseline.token, host: host0.token });
            if (box0.uid !== host0.uid) throw fail(`The Box program runs as uid ${box0.uid} and the host as ${host0.uid}: the keep-id mapping that makes both the store's owner does not hold`, { host: host0.uid, box: box0.uid });
            record('baseline', { storeId: host0.storeId, token: host0.token, uid: host0.uid, boxUid: box0.uid });

            const first = await setLimits('store-set-first', OVERRIDES.low, baseline.token);
            const t1 = assertCommitted(first, 'The first in-Box write');
            const host1 = await view(identity, 'host', 'after the in-Box write'); const box1 = await view(identity, 'box', 'after the in-Box write');
            try {
                assertSameStore(host1, box1, 'after the in-Box write');
                if (tokenKey(host1.token) !== tokenKey(t1) || host1.count !== 1 || JSON.stringify(host1.agents[agentRef]) !== JSON.stringify(OVERRIDES.low)) throw new Error('the host does not see exactly the in-Box write');
            } catch (error) { throw fail(`The in-Box write is not what the host reads: ${error.message}`, { host: host1, box: box1, committed: t1 }); }
            record('visibility', { token: t1, entry: host1.agents[agentRef] });

            // ---- 2 CAS race: two in-Box setters, one stamp --------------------------------------------------------------------------------
            const [a, b] = await Promise.all([setLimits('store-race-low', OVERRIDES.low, t1), setLimits('store-race-high', OVERRIDES.high, t1)]);
            const winners = [a, b].filter(reply => reply.status === 200 && reply.body?.committed === true);
            const losers = [a, b].filter(reply => reply !== winners[0]);
            if (winners.length !== 1) throw fail(`The two in-Box setters of one stamp did not produce exactly one winner (${winners.length})`, { a: { status: a.status, body: a.text }, b: { status: b.status, body: b.text } });
            try { assertRefusedWrite(losers[0], 'revision_conflict', 'The losing setter'); } catch (error) { throw fail(error.message, { loser: { status: losers[0].status, body: losers[0].text } }); }
            const raced = await view(identity, 'host', 'after the CAS race');
            const winnerValue = winners[0] === a ? OVERRIDES.low : OVERRIDES.high;
            if (revisionOf(raced.token) !== revisionOf(t1) + 1 || JSON.stringify(raced.agents[agentRef]) !== JSON.stringify(winnerValue)) throw fail('The store does not hold exactly the winner of the race', { token: raced.token, entry: raced.agents[agentRef], winner: winnerValue });
            record('cas-race', { winner: winnerValue, token: raced.token, loser: 'revision_conflict' });

            // ---- 3 a stale in-Box setter against a host clear: the clear is not lost ----------------------------------------------------------
            const stale = (await adminState()).token;
            const cleared = await hostClear('store-host-clear-first');
            assertExitZero(cleared, 'The host clear');
            const afterClear = await view(identity, 'host', 'after the host clear');
            if (revisionOf(afterClear.token) !== revisionOf(stale) + 1 || afterClear.count !== 0) throw fail('The host clear did not commit exactly one new stamp that empties the store', { token: afterClear.token, count: afterClear.count });
            const lateSetter = await setLimits('store-set-stale', OVERRIDES.high, stale);
            try { assertRefusedWrite(lateSetter, 'revision_conflict', 'The in-Box setter that read the stamp before the host clear'); } catch (error) { throw fail(error.message, { setter: { status: lateSetter.status, body: lateSetter.text } }); }
            const afterStale = await view(identity, 'host', 'after the stale setter');
            if (afterStale.count !== 0 || tokenKey(afterStale.token) !== tokenKey(afterClear.token)) throw fail('The refused stale setter changed the store: the clear was lost', { token: afterStale.token, entries: afterStale.agents });
            record('stale-setter', { clearedAt: afterClear.token, refused: 'revision_conflict', entries: afterStale.count });

            // ---- 4 host clear and an in-Box setter started together ---------------------------------------------------------------------
            const rounds = [];
            for (let round = 1; round <= STORE_BOUNDS.raceRounds; round += 1) {
                const seeded = assertCommitted(await setLimits(`store-round-seed-${round}`, OVERRIDES.low, (await adminState()).token), `Round ${round}: the seeding write`);
                const [clear, setter] = await Promise.all([hostClear(`store-round-clear-${round}`), setLimits(`store-round-set-${round}`, OVERRIDES.high, seeded)]);
                assertExitZero(clear, `Round ${round}: the host clear`);
                const settled = await view(identity, 'host', `round ${round}`);
                const setterWon = setter.status === 200 && setter.body?.committed === true;
                if (!setterWon) { try { assertRefusedWrite(setter, 'revision_conflict', `Round ${round}: the setter`); } catch (error) { throw fail(error.message, { round, setter: { status: setter.status, body: setter.text } }); } }
                // The clear always lands. If the setter committed first the stamp advanced twice, otherwise once (the setter's stamp was stale).
                const expectedRevision = revisionOf(seeded) + (setterWon ? 2 : 1);
                if (settled.count !== 0 || revisionOf(settled.token) !== expectedRevision) throw fail(`Round ${round}: the clear was lost or the stamp does not fit either order`, { round, setterWon, seeded, token: settled.token, entries: settled.agents });
                rounds.push({ round, order: setterWon ? 'setter-then-clear' : 'clear-then-refused-setter', token: settled.token });
            }
            record('host-box-race', { rounds });

            // ---- 5 live locks are never taken ----------------------------------------------------------------------------------------------
            const seeded5 = assertCommitted(await setLimits('store-lock-seed', OVERRIDES.low, (await adminState()).token), 'The seeding write of the lock case');
            // 5a a live HOST holder; the in-Box setter must be refused
            const hostHolder = startHolder(identity, 'host', 'hold', 'store-hold-host', { holdMs: STORE_BOUNDS.holdMs });
            const seenInBox = await waitForLock(identity, 'box', 'host', 'The host-held lock');
            const hostSide = await view(identity, 'host', 'host holder');
            if (!sameOwner(seenInBox.lock, hostSide.lock)) throw fail('The Box and the host do not see the same lock', { box: seenInBox.lock, host: hostSide.lock });
            const startedWait = now();
            const refusedInBox = await setLimits('store-set-locked', OVERRIDES.high, seeded5);
            const waitedMs = now() - startedWait;
            try { assertRefusedWrite(refusedInBox, 'store_busy', 'The in-Box setter against a live host lock'); } catch (error) { throw fail(error.message, { setter: { status: refusedInBox.status, body: refusedInBox.text } }); }
            const duringHost = await view(identity, 'host', 'after the refused in-Box setter');
            if (duringHost.lock) { try { assertLockNotStolen(hostSide.lock, duringHost.lock, 'The host lock'); } catch (error) { throw fail(error.message, { before: hostSide.lock, after: duringHost.lock }); } }
            if (tokenKey(duringHost.token) !== tokenKey(seeded5) || duringHost.count !== 1) throw fail('The refused in-Box setter changed the store', { token: duringHost.token });
            const hostHeld = assertHolderReleasedSafely(await settleHolder(hostHolder, 'host lock holder'), 'The host holder');
            const afterHost = assertCommitted(await setLimits('store-set-unlocked', OVERRIDES.high, seeded5), 'The in-Box write after the host holder released');
            record('lock-host-held', { lock: hostSide.lock, refused: 'store_busy', waitedMs, holder: hostHeld, afterRelease: afterHost });

            // 5b a live BOX holder; the host clear must be refused
            const boxHolder = startHolder(identity, 'box', 'hold', 'store-hold-box', { holdMs: STORE_BOUNDS.holdMs });
            const seenOnHost = await waitForLock(identity, 'host', 'box', 'The Box-held lock');
            const boxSide = await view(identity, 'box', 'box holder');
            if (!sameOwner(seenOnHost.lock, boxSide.lock)) throw fail('The host and the Box do not see the same lock', { host: seenOnHost.lock, box: boxSide.lock });
            const refusedHost = await hostClear('store-host-clear-locked');
            try { assertHostClearRefused(refusedHost, RECOVERY_REFUSALS.running, 'The host clear against a live Box lock'); } catch (error) { throw fail(error.message, { tail: String(refusedHost.stderr ?? '').slice(-400) }); }
            const duringBox = await view(identity, 'host', 'after the refused host clear');
            if (duringBox.lock) { try { assertLockNotStolen(seenOnHost.lock, duringBox.lock, 'The Box lock'); } catch (error) { throw fail(error.message, { before: seenOnHost.lock, after: duringBox.lock }); } }
            if (tokenKey(duringBox.token) !== tokenKey(afterHost) || duringBox.count !== 1) throw fail('The refused host clear changed the store', { token: duringBox.token });
            if (duringBox.quarantined.length) throw fail('A live Box lock was quarantined', { quarantined: duringBox.quarantined });
            const boxHeld = assertHolderReleasedSafely(await settleHolder(boxHolder, 'Box lock holder'), 'The Box holder');
            assertExitZero(await hostClear('store-host-clear-unlocked'), 'The host clear after the Box holder released');
            const afterBox = await view(identity, 'host', 'after the Box holder released');
            if (afterBox.count !== 0) throw fail('The host clear after the release left the entry', { entries: afterBox.agents });
            record('lock-box-held', { lock: boxSide.lock, refused: 'store lock held by a live Box writer', holder: boxHeld, token: afterBox.token });

            // ---- 6 the downgrade barrier ---------------------------------------------------------------------------------------------------
            assertNoLockNoBarrier(afterBox, 'before the barrier');
            const operationId = crypto.randomBytes(16).toString('hex');
            const [begun] = await runProgram(identity, 'host', 'barrier-begin', 'store-barrier-begin', { operationId });
            if (begun.ok !== true) throw fail(`The downgrade barrier could not be installed (${begun.code}: ${begun.message})`, { begun });
            let barrier; let failure = null;
            try {
                const hostB = await view(identity, 'host', 'barrier'); const boxB = await view(identity, 'box', 'barrier');
                if (hostB.barrier?.operationId !== operationId || boxB.barrier?.operationId !== operationId) throw fail('The barrier is not the same one on both sides of the mount', { host: hostB.barrier, box: boxB.barrier });
                const setRefused = await setLimits('store-set-barrier', OVERRIDES.low, afterBox.token);
                const clearRefused = await clearLimits('store-clear-barrier', afterBox.token);
                for (const [name, reply] of [['setter', setRefused], ['clear', clearRefused]]) {
                    try { assertRefusedWrite(reply, 'hardware_limits_transition', `The in-Box ${name} under the barrier`); } catch (error) { throw fail(error.message, { [name]: { status: reply.status, body: reply.text } }); }
                }
                const hostRefused = await hostClear('store-host-clear-barrier');
                try { assertHostClearRefused(hostRefused, new RegExp(BARRIER_MESSAGE), 'The host clear under the barrier'); } catch (error) { throw fail(error.message, { tail: String(hostRefused.stderr ?? '').slice(-400) }); }
                const under = await view(identity, 'host', 'under the barrier');
                if (tokenKey(under.token) !== tokenKey(afterBox.token) || under.count !== 0) throw fail('A write was committed while the barrier was pending', { token: under.token, entries: under.agents });
                // A gate-off start now sees an empty store: nothing can be committed behind it.
                const [offEmpty] = await runProgram(identity, 'host', 'gate-off-check', 'store-gate-off-check', {}, { journal: false });
                if (offEmpty.ok !== true || offEmpty.count !== 0) throw fail('A gate-off start does not see the empty store under the barrier', { offEmpty });
                barrier = { operationId, setter: 'hardware_limits_transition', clear: 'hardware_limits_transition', hostClear: 'refused', gateOffSeesEmpty: true };
            } catch (error) {
                failure = error;
                throw error;
            } finally {
                // The barrier is always removed. When the case already failed, the failure stays the answer and records that the barrier stayed.
                const [removed] = await runProgram(identity, 'host', 'barrier-remove', 'store-barrier-remove', { operationId });
                if (removed.ok !== true) {
                    const note = `The downgrade barrier could not be removed (${removed.code}: ${removed.message})`;
                    if (failure) failure.message = `${failure.message} (${note})`;
                    else throw fail(note, { removed });
                }
            }
            const free = await view(identity, 'host', 'after the barrier');
            assertNoLockNoBarrier(free, 'after the barrier');
            const afterBarrier = assertCommitted(await setLimits('store-set-after-barrier', OVERRIDES.low, free.token), 'The in-Box write after the barrier was removed');
            const [offRefused] = await runProgram(identity, 'host', 'gate-off-check', 'store-gate-off-refused', {}, { journal: false });
            if (offRefused.ok !== false || offRefused.code !== 'stored_limits_present') throw fail('A gate-off start is not refused although a policy was committed after the barrier', { offRefused });
            assertExitZero(await hostClear('store-host-clear-after-barrier'), 'The host clear after the barrier');
            const [offAgain] = await runProgram(identity, 'host', 'gate-off-check', 'store-gate-off-again', {}, { journal: false });
            if (offAgain.ok !== true) throw fail('A gate-off start is still refused after the clear', { offAgain });
            record('barrier', { ...barrier, committedAfter: afterBarrier, gateOffAfterCommit: 'stored_limits_present', gateOffAfterClear: 'empty' });

            // ---- 7 stale recovery with a stopped Box ---------------------------------------------------------------------------------------
            const seeded7 = assertCommitted(await setLimits('store-stale-seed', OVERRIDES.low, (await adminState()).token), 'The seeding write of the stale case');
            // 7a a Box holder whose Box is stopped while it holds: the lock stays, the holder is gone
            const staleHolder = startHolder(identity, 'box', 'hold', 'store-hold-box-stale', { holdMs: STORE_BOUNDS.staleHoldMs });
            const staleSeen = await waitForLock(identity, 'host', 'box', 'The Box lock that will go stale');
            const stopped = await command('store-stop', profile.node.path, [profile.candidate.path, 'stop'], { deadlineMs: STORE_BOUNDS.stopMs, tolerate: true, capture: 'store-stop' });
            assertExitZero(stopped, 'The host stop');
            await settleHolder(staleHolder, 'the stopped Box holder', { killed: true });
            const boxAfterStop = await inspectBox();
            if (boxAfterStop.running !== false) throw fail('The Box is still running after the host stop', { running: boxAfterStop.running });
            const staleView = await view(identity, 'host', 'stale Box lock');
            if (!staleView.lock || !sameLock(staleSeen.lock, staleView.lock)) throw fail('The Box lock did not survive the stop as the same stale lock', { before: staleSeen.lock, after: staleView.lock });
            const recoveredBox = await hostClear('store-recover-box-lock');
            assertExitZero(recoveredBox, 'The host clear with the stopped Box');
            const afterRecoveredBox = await view(identity, 'host', 'after the recovery of the Box lock');
            if (afterRecoveredBox.lock || afterRecoveredBox.count !== 0 || revisionOf(afterRecoveredBox.token) !== revisionOf(seeded7) + 1) throw fail('The stale Box lock was not recovered into exactly one committed clear', { lock: afterRecoveredBox.lock, token: afterRecoveredBox.token, entries: afterRecoveredBox.agents });
            if (afterRecoveredBox.quarantined.length !== 1 || afterRecoveredBox.quarantined[0].ownerToken !== staleView.lock.token) throw fail('The stale Box lock was not preserved as the one quarantined lock (it must be renamed, never deleted)', { quarantined: afterRecoveredBox.quarantined, stale: staleView.lock.token });
            record('stale-box-lock', { lock: staleView.lock, boxRunning: boxAfterStop.running, quarantined: afterRecoveredBox.quarantined, token: afterRecoveredBox.token });

            // 7b a LIVE host holder with the Box stopped: never taken over
            const liveHolder = startHolder(identity, 'host', 'hold', 'store-hold-host-live', { holdMs: STORE_BOUNDS.holdMs });
            const liveSeen = await waitForLock(identity, 'host', 'host', 'The live host lock');
            const refusedLive = await hostClear('store-clear-live-host-lock');
            try { assertHostClearRefused(refusedLive, RECOVERY_REFUSALS.liveHost, 'The host clear against a live host lock'); } catch (error) { throw fail(error.message, { tail: String(refusedLive.stderr ?? '').slice(-400) }); }
            const duringLive = await view(identity, 'host', 'after the refused clear of a live host lock');
            if (duringLive.lock) { try { assertLockNotStolen(liveSeen.lock, duringLive.lock, 'The live host lock'); } catch (error) { throw fail(error.message, { before: liveSeen.lock, after: duringLive.lock }); } }
            if (duringLive.quarantined.length !== 1) throw fail('A live host lock was quarantined', { quarantined: duringLive.quarantined });
            const liveHeld = assertHolderReleasedSafely(await settleHolder(liveHolder, 'the live host holder'), 'The live host holder');
            record('stale-host-live', { lock: liveSeen.lock, refused: 'holder still running', holder: liveHeld });

            // 7c a DEAD host holder with the Box stopped: recovered
            const [abandoned] = await runProgram(identity, 'host', 'stale', 'store-abandon-host-lock', { holdMs: 0 });
            if (abandoned.ok !== true || abandoned.phase !== 'held') throw fail('The abandoned host lock could not be created', { abandoned });
            if (!isDead(abandoned.pid)) throw fail(`The process that abandoned the lock (pid ${abandoned.pid}) is still running`, { pid: abandoned.pid });
            const deadSeen = await view(identity, 'host', 'abandoned host lock');
            if (!deadSeen.lock || deadSeen.lock.token !== abandoned.token) throw fail('The abandoned lock is not the one the program took', { lock: deadSeen.lock, token: abandoned.token });
            const recoveredHost = await hostClear('store-recover-host-lock');
            assertExitZero(recoveredHost, 'The host clear of a dead host lock with the Box stopped');
            const afterRecoveredHost = await view(identity, 'host', 'after the recovery of the host lock');
            if (afterRecoveredHost.lock || revisionOf(afterRecoveredHost.token) !== revisionOf(afterRecoveredBox.token) + 1) throw fail('The abandoned host lock was not recovered into exactly one committed clear', { lock: afterRecoveredHost.lock, token: afterRecoveredHost.token });
            if (afterRecoveredHost.quarantined.length !== 2 || !afterRecoveredHost.quarantined.some(entry => entry.ownerToken === abandoned.token)) throw fail('The abandoned host lock was not preserved as a quarantined lock', { quarantined: afterRecoveredHost.quarantined });
            record('stale-host-dead', { lock: deadSeen.lock, pid: abandoned.pid, quarantined: afterRecoveredHost.quarantined, token: afterRecoveredHost.token });
            record('final', { boxStopped: true, quarantined: afterRecoveredHost.quarantined.length, holders: holders.length });
        }
    }

    // A holder that was never taken from must end with its own verified release (release() compares the owner token and directory identity).
    function assertHolderReleasedSafely(lines, label) {
        try { return assertHolderReleased(lines, label); } catch (error) { throw fail(error.message, { last: lines?.at(-1) }); }
    }

    return { liveC5, internals: { adminCall, adminState, view, hostClear, setLimits, clearLimits, runProgram } };
}
