import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';
import { sanitizeGitDiagnostic } from '../utils/gitCommand.js';
import { createRepositoryProcessObserver, proveRepositoryQuiescence, REPOSITORY_OPERATION_MARKER, PROC_LIMITS, sameProcess } from './marketplaceRepositoryProcessGroup.mjs';
import { appendLog } from './utils/logger.js';
import { createRepositoryDiagnostics, diagnosticIdentity, diagnosticPayload, processDiagnostic } from './marketplaceRepositoryDiagnostics.mjs';

const SUPERVISOR_PATH = fileURLToPath(new URL('./marketplaceRepositorySupervisor.mjs', import.meta.url));
export const REPOSITORY_QUEUE_LIMITS = Object.freeze({ pending: 16, bytes: 8 * 1024 * 1024, admissionMs: 600_000 });
const RECOVERY_CODE = 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED';
const clock = { now: () => Date.now(), monotonic: () => performance.now(), setTimeout, clearTimeout };
const COHORT_FIELDS = ['pid', 'birth', 'namespace', 'uids', 'parent', 'group', 'session', 'state'];
const identityKey = (record) => JSON.stringify([record.pid, record.birth, record.namespace, record.uids]);

function validCohortRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.keys(record).length !== COHORT_FIELDS.length
        || COHORT_FIELDS.some((field) => !Object.hasOwn(record, field))) return false;
    const pid = (value, minimum = 1) => Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647;
    return pid(record.pid) && pid(record.parent, 0) && pid(record.group) && pid(record.session)
        && typeof record.birth === 'string' && /^[1-9][0-9]{0,19}$/.test(record.birth)
        && typeof record.namespace === 'string' && /^pid:\[[1-9][0-9]{0,19}\]$/.test(record.namespace)
        && typeof record.uids === 'string' && /^(?:0|[1-9][0-9]{0,9})(?::(?:0|[1-9][0-9]{0,9})){3}$/.test(record.uids)
        && record.uids.split(':').every((value) => Number(value) <= 4_294_967_295)
        && typeof record.state === 'string' && /^[RSDZTWXKPI]$/.test(record.state);
}

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function timeout() { return failure('workspace_mutation_lock_timeout', 'Timed out waiting for repository operation admission.'); }
function closed() { return failure('PLOINKY_MARKETPLACE_REPOSITORY_REQUEST_CLOSED', 'Repository request closed before admission.'); }
function recovery() {
    return Object.assign(failure(RECOVERY_CODE,
        'Repository operation requires workspace recovery. Stop the exact Box from its host workspace, then start it again.'), { recoveryRequired: true });
}

export function repositoryWorkerEligible({ platform = process.platform, insideBox = isInsideBox } = {}) {
    return platform === 'linux' && insideBox();
}

export function createMarketplaceRepositoryRunner({
    spawnProcess = spawn, observer = createRepositoryProcessObserver(), time = clock,
    executablePath = process.execPath, resolveExecutable = realpath,
    proveQuiescence = proveRepositoryQuiescence,
    diagnosticSink = appendLog,
} = {}) {
    const diagnostics = createRepositoryDiagnostics({ now: time.monotonic, sink: diagnosticSink });
    const pending = [];
    let active = null;
    let chargedBytes = 0;
    let accepting = true;
    let recoveryDebt = false;
    let shutdownPromise;
    const delay = (ms) => new Promise((resolve) => time.setTimeout(resolve, Math.max(0, ms)));
    const expired = (ticket) => time.now() >= ticket.deadline;
    function diagnosticRecord(ticket, payload) {
        return { ...ticket.diagnosticContext, state: ticket.state,
            deadline: ticket.deadline, elapsedMs: Math.max(0, Math.floor(time.monotonic() - ticket.started)),
            source: 'router', ...payload };
    }
    function record(ticket, payload, first = false) {
        diagnostics.retain(ticket.operationId, diagnosticRecord(ticket, payload), first);
    }
    function cause(ticket, phase, reason, details = {}) {
        ticket.cause ||= { phase, reason, ...details };
    }
    function guardFailure(ticket, predicate, reason = 'unknown', counts = {}) {
        const error = recovery();
        try {
            const flight = ticket.cohortFlight;
            const details = { ...processDiagnostic(error), predicate, claims: ticket.cohortClaims.size, ...counts,
                ...(flight ? {
                    observationMs: Math.min(2_147_483_647, Math.max(0, Math.floor(time.monotonic() - flight.started))),
                    observationBudgetMs: Math.min(PROC_LIMITS.timeoutMs, Math.max(0, Math.floor(flight.deadline - flight.started))),
                } : {}) };
            record(ticket, { phase: 'observation', reason, ...details });
            cause(ticket, 'observation', reason, details);
        } catch (_) { /* Diagnostic failure cannot change the existing refusal. */ }
        return error;
    }
    function observationRecord(ticket, observation, phase) {
        const details = { phase, reason: observation.complete ? 'received' : 'incomplete',
            complete: observation.complete === true, records: observation.records?.length || 0,
            members: observation.members?.length || 0, writers: observation.writers?.length || 0,
            ...(diagnosticPayload(observation.diagnostic) || {}),
            ...(!observation.complete ? { predicate: 'scan-incomplete', claims: ticket.cohortClaims.size } : {}) };
        record(ticket, details);
        if (!observation.complete) cause(ticket, phase, 'incomplete', details);
    }
    function discardPending(error) {
        for (const ticket of [...pending]) finish(ticket, error);
    }
    function finish(ticket, error, result) {
        if (ticket.finished) return;
        if (error && !ticket.cancelling) record(ticket, { phase: 'admission',
            reason: error.code === 'workspace_mutation_lock_timeout' ? 'expired' : error.code === closed().code ? 'closed' : 'unknown' });
        ticket.finished = true;
        ticket.cancelWake?.();
        time.clearTimeout(ticket.timer);
        time.clearTimeout(ticket.expiryGrace);
        time.clearTimeout(ticket.cohortTimer);
        ticket.cohortClaims.clear();
        ticket.response?.removeListener?.('close', ticket.onClose);
        if (ticket.response && !ticket.response.closed && !ticket.response.destroyed) {
            // The HTTP response can close after worker settlement. Keep only
            // safe scalar context, never the ticket, input, lease or request.
            const operationId = ticket.operationId;
            const closure = diagnosticRecord(ticket, { phase: 'closure', reason: 'closed', admitted: ticket.admitted === true });
            const started = ticket.started;
            ticket.response.once?.('close', () => diagnostics.retain(operationId, {
                ...closure, closedAt: time.now(), elapsedMs: Math.max(0, Math.floor(time.monotonic() - started)),
            }));
        }
        const index = pending.indexOf(ticket);
        if (index >= 0) pending.splice(index, 1);
        if (active === ticket) active = null;
        chargedBytes -= ticket.bytes;
        ticket.operation = null;
        ticket.authorize = null;
        ticket.done();
        if (error) ticket.reject(error); else ticket.resolve(result);
        drain();
    }
    function completeNormally(ticket) {
        if (ticket.finished || ticket.cancelling || !ticket.childClosed || !ticket.terminal
            || ticket.state !== 'released' || ticket.cohortFailed || ticket.processingCohortFrames
            || ticket.cohortClaims.size || ticket.cohortFlight) return;
        const terminal = ticket.terminal;
        if (terminal.ok) finish(ticket, null, terminal.result);
        else {
            const error = failure(terminal.error.code, sanitizeGitDiagnostic(terminal.error.message).slice(0, 8_192));
            if (Number.isInteger(terminal.error.status)) error.status = terminal.error.status;
            finish(ticket, error);
        }
    }
    function send(ticket, message) {
        if (!ticket.child?.connected) return false;
        try {
            ticket.child.send({ ...message, operationId: ticket.operationId }, (error) => {
                if (error && !ticket.finished && !ticket.cancelling) {
                    cause(ticket, 'ipc', 'ipc-failed', { connected: ticket.child.connected === true });
                    void cancel(ticket);
                }
            });
            return true;
        } catch (_) { cause(ticket, 'ipc', 'ipc-failed'); return false; }
    }
    const options = (ticket) => ({ baseline: ticket.baseline, coordinator: ticket.coordinator,
        router: ticket.router, operationId: ticket.operationId, remembered: ticket.remembered });
    function prepareRemembered(ticket, records) {
        if (!Array.isArray(records)) throw guardFailure(ticket, 'remembered-invalid');
        if (records.length > 8_192) throw guardFailure(ticket, 'cohort-capacity');
        const normalized = records.map((entry) => Object.fromEntries(COHORT_FIELDS.map((field) => [field, entry?.[field]])));
        if (normalized.some((entry) => !validCohortRecord(entry))) throw guardFailure(ticket, 'remembered-invalid');
        const union = new Map(ticket.remembered.map((entry) => [identityKey(entry), entry]));
        for (const entry of normalized) union.set(identityKey(entry), entry);
        if (new Set([...union.keys(), ...ticket.cohortClaims.keys()]).size > PROC_LIMITS.entries) throw guardFailure(ticket, 'cohort-capacity');
        return [...union.values()];
    }
    function failCohort(ticket) {
        if (ticket.finished) return;
        cause(ticket, 'observation', 'cohort');
        ticket.cohortFailed = true;
        void cancel(ticket);
    }
    function earliestClaim(ticket) {
        let deadline = Infinity;
        for (const claim of ticket.cohortClaims.values()) deadline = Math.min(deadline, claim.deadline);
        return deadline;
    }
    function scheduleClaimExpiry(ticket) {
        const deadline = earliestClaim(ticket);
        if (deadline === ticket.cohortTimerDeadline) return;
        time.clearTimeout(ticket.cohortTimer);
        ticket.cohortTimerDeadline = deadline;
        if (!Number.isFinite(deadline) || ticket.finished) return;
        ticket.cohortTimer = time.setTimeout(() => {
            if (!ticket.finished && earliestClaim(ticket) <= time.monotonic()) {
                guardFailure(ticket, 'claim-expired', 'cohort');
                failCohort(ticket);
            }
        }, Math.max(0, deadline - time.monotonic()));
    }
    function registerCohort(ticket, records) {
        const receivedAt = time.monotonic();
        if (!ticket.ownershipAcknowledged || !['acquiring', 'awaiting-admission', 'running',
            'settlement-barrier', 'release-granted', 'cancelling'].includes(ticket.state)
            || !Array.isArray(records)) throw recovery();
        if (records.length > 8_192) throw guardFailure(ticket, 'cohort-capacity', 'cohort');
        if (records.some((entry) => !validCohortRecord(entry))) throw recovery();
        const known = new Set(ticket.remembered.map(identityKey));
        const claims = new Map(ticket.cohortClaims);
        for (const entry of records) {
            const key = identityKey(entry);
            if (known.has(key) || claims.has(key)) continue;
            claims.set(key, { record: { ...entry }, sequence: ++ticket.cohortSequence,
                deadline: receivedAt + PROC_LIMITS.timeoutMs });
        }
        if (new Set([...known, ...claims.keys()]).size > PROC_LIMITS.entries) throw guardFailure(ticket, 'cohort-capacity', 'cohort');
        ticket.cohortClaims = claims;
        scheduleClaimExpiry(ticket);
        if (ticket.cancelling && claims.size) ticket.cancelWake?.();
    }
    function observationPass(ticket, cutoff = Infinity) {
        if (ticket.cohortFlight) return ticket.cohortFlight.promise;
        if (ticket.finished || ticket.observationUncertain) return Promise.reject(guardFailure(ticket, 'flight-stale'));
        const started = time.monotonic();
        const deadline = Math.min(started + PROC_LIMITS.timeoutMs, earliestClaim(ticket), cutoff);
        if (time.monotonic() >= deadline) {
            ticket.cohortFailed = true;
            ticket.observationUncertain = true;
            return Promise.reject(guardFailure(ticket, earliestClaim(ticket) <= time.monotonic() ? 'claim-expired' : 'flight-expired'));
        }
        const flight = { deadline, started, watermark: ticket.cohortSequence };
        ticket.cohortFlight = flight;
        flight.promise = (async () => {
            let timer;
            try {
                const observation = await Promise.race([
                    observer.scan(options(ticket)),
                    new Promise((_, reject) => { timer = time.setTimeout(() => reject(guardFailure(ticket, 'flight-expired')), deadline - time.monotonic()); }),
                ]);
                observationRecord(ticket, observation, 'observation');
                if (ticket.finished || ticket.cohortFlight !== flight || time.monotonic() >= deadline) {
                    throw guardFailure(ticket, ticket.finished || ticket.cohortFlight !== flight ? 'flight-stale' : 'flight-expired');
                }
                // Only a timely local observation can establish history. A
                // partial positive cohort may assist recovery, never success.
                const remembered = prepareRemembered(ticket, observation.members);
                const proven = new Set(observation.members.map(identityKey));
                const remaining = new Map(ticket.cohortClaims);
                let missing = !observation.complete;
                for (const [key, claim] of ticket.cohortClaims) {
                    if (proven.has(key)) remaining.delete(key);
                    else if (claim.sequence <= flight.watermark) missing = true;
                }
                if (ticket.finished || ticket.cohortFlight !== flight || time.monotonic() >= deadline) {
                    throw guardFailure(ticket, ticket.finished || ticket.cohortFlight !== flight ? 'flight-stale' : 'flight-expired');
                }
                ticket.remembered = remembered;
                if (missing) {
                    const counts = {};
                    try {
                        const pids = new Set(observation.records.map(entry => entry.pid));
                        counts.unresolvedPresent = 0;
                        counts.unresolvedUnobserved = 0;
                        for (const claim of remaining.values()) if (claim.sequence <= flight.watermark) {
                            counts[pids.has(claim.record.pid) ? 'unresolvedPresent' : 'unresolvedUnobserved'] += 1;
                        }
                    } catch (_) { /* Counts use only the existing census and carry no authority. */ }
                    throw guardFailure(ticket, observation.complete ? 'claim-unresolved' : 'scan-incomplete', 'unknown', counts);
                }
                ticket.cohortClaims = remaining;
                scheduleClaimExpiry(ticket);
                return observation;
            } catch (error) {
                cause(ticket, 'observation', 'unknown', processDiagnostic(error));
                if (!ticket.finished) {
                    ticket.cohortFailed = true;
                    ticket.observationUncertain = true;
                }
                throw error;
            } finally {
                time.clearTimeout(timer);
                if (ticket.cohortFlight === flight) ticket.cohortFlight = null;
            }
        })();
        return flight.promise;
    }
    function pumpCohort(ticket) {
        if (ticket.finished || ticket.cancelling || ticket.cohortFailed || ticket.cohortFlight || !ticket.cohortClaims.size) return;
        void observationPass(ticket).then(() => {
            if (ticket.cancelling || ticket.finished) return;
            if (ticket.cohortClaims.size) pumpCohort(ticket);
            else completeNormally(ticket);
        }, () => failCohort(ticket));
    }
    function waitForCancellationWork(ticket, until) {
        return new Promise((resolve) => {
            let timer;
            const wake = () => {
                time.clearTimeout(timer);
                if (ticket.cancelWake === wake) ticket.cancelWake = null;
                resolve();
            };
            ticket.cancelWake = wake;
            timer = time.setTimeout(wake, Math.max(0, until - time.monotonic()));
        });
    }
    async function captureCoordinator(ticket) {
        const record = await observer.read(ticket.child.pid, { executable: true });
        const mismatch = [
            ['pid', record.pid !== ticket.child.pid], ['group', record.group !== record.pid], ['session', record.session !== record.pid],
            ['namespace', record.namespace !== ticket.router.namespace], ['uids', record.uids !== ticket.router.uids],
            ['executable', record.exe !== ticket.executable], ['argv', JSON.stringify(record.argv) !== JSON.stringify([executablePath, SUPERVISOR_PATH])],
        ].find(([, differs]) => differs);
        if (mismatch) { cause(ticket, 'ownership', 'mismatch', { mismatch: mismatch[0] }); throw recovery(); }
        ticket.coordinator = record;
    }
    async function signalMembers(ticket, signal, deadline) {
        const members = ticket.remembered.filter((entry) => !sameProcess(entry, ticket.router)
            && !sameProcess(entry, ticket.coordinator));
        let cursor = 0;
        const allowed = () => !ticket.finished && time.monotonic() < deadline;
        const group = ticket.coordinator && allowed()
            ? observer.signal(ticket.coordinator, signal, { coordinator: ticket.coordinator, group: true, isAllowed: allowed })
            : Promise.resolve(false);
        await Promise.allSettled([group, ...Array.from({ length: 7 }, async () => {
            while (cursor < members.length && allowed()) {
                await observer.signal(members[cursor++], signal, { isAllowed: allowed });
            }
        })]);
    }
    function cancel(ticket, error = recovery()) {
        if (ticket.cancelling || ticket.finished) return ticket.settled;
        record(ticket, ticket.cause || { phase: 'cancellation', reason: 'recovery' }, true);
        ticket.cancelling = true;
        ticket.state = 'cancelling';
        accepting = false;
        // Once a supervisor exists, partial publication cannot be rolled back
        // by process death. Keep debt even after every process is gone.
        recoveryDebt ||= Boolean(ticket.child) || error.code === RECOVERY_CODE;
        discardPending(recovery());
        time.clearTimeout(ticket.timer);
        time.clearTimeout(ticket.expiryGrace);
        if (!ticket.child) { finish(ticket, error); diagnostics.emit(); return ticket.settled; }
        const started = time.monotonic();
        const deadline = started + 8_000;
        const hardStop = time.setTimeout(() => finish(ticket, error), 8_000);
        send(ticket, { type: 'cancel' }); // same-PID retention precedes supervisor signals
        void (async () => {
            try {
                // Cancellation is the sole observer scheduler from here. Join
                // the existing bounded flight instead of causing a busy scan.
                let preKillCensusDone = Boolean(ticket.cohortFlight);
                if (ticket.cohortFlight) {
                    try { await ticket.cohortFlight.promise; } catch (_) { /* genuine uncertainty */ }
                }
                if (!ticket.coordinator) {
                    try { await captureCoordinator(ticket); } catch (_) { /* no unvalidated group signal */ }
                }
                // Begin the final validated group KILL at two seconds: its
                // identity read has a one-second ceiling, inside the 3s grace.
                while (!ticket.finished && time.monotonic() < started + 2_000) {
                    if (!ticket.observationUncertain && (!preKillCensusDone || ticket.cohortClaims.size)) {
                        try { await observationPass(ticket, started + 2_000); }
                        catch (_) { /* retain known identities for best-effort escalation */ }
                        preKillCensusDone = true;
                    } else await waitForCancellationWork(ticket, started + 2_000);
                }
                if (!ticket.finished) await signalMembers(ticket, 'SIGKILL', deadline);
                while (!ticket.finished && !ticket.observationUncertain && time.monotonic() < started + 6_000) {
                    try {
                        await observationPass(ticket, started + 6_000);
                        if (ticket.childClosed && ticket.cohortFailed) {
                            await signalMembers(ticket, 'SIGKILL', deadline);
                            break; // failed ownership cannot become successful cleanup
                        }
                        if (ticket.childClosed && !ticket.cohortFailed && !ticket.cohortClaims.size) {
                            const proof = await proveQuiescence({ scan: () => observationPass(ticket, deadline) }, options(ticket), { barrier: true });
                            if (proof.ok && !ticket.cohortFailed && !ticket.cohortClaims.size
                                && !ticket.processingCohortFrames && !ticket.cohortFlight && time.monotonic() < deadline) {
                                ticket.quiescent = true;
                                break;
                            }
                        }
                    } catch (_) { /* observation failure does not skip known-member KILL */ }
                    await signalMembers(ticket, 'SIGKILL', deadline);
                    await delay(25);
                }
                if (!ticket.finished && !ticket.observationUncertain && !ticket.cohortFailed && !ticket.cohortClaims.size
                    && ticket.childClosed && !ticket.quiescent && time.monotonic() < deadline) {
                    const proof = await proveQuiescence({ scan: () => observationPass(ticket, deadline) }, options(ticket), { barrier: true });
                    ticket.quiescent = proof.ok && !ticket.cohortFailed && !ticket.cohortClaims.size
                        && !ticket.processingCohortFrames && !ticket.cohortFlight && time.monotonic() < deadline;
                }
            } catch (_) {
                // Failed observations never become successful cleanup. The
                // owner-death-required fence remains for exact Box recovery.
            } finally {
                time.clearTimeout(hardStop);
                finish(ticket, error);
            }
        })();
        diagnostics.emit();
        return ticket.settled;
    }
    async function handleMessage(ticket, message) {
        if (ticket.finished) return;
        if (message?.operationId !== ticket.operationId) { cause(ticket, 'ipc', 'protocol'); void cancel(ticket); return; }
        if (message.type === 'diagnostic') {
            const payload = Object.keys(message).length === 3 && diagnosticPayload(message.payload);
            if (!payload) diagnostics.loss();
            else {
                record(ticket, { ...payload, source: 'supervisor' });
                if (!ticket.remoteCause) ticket.remoteCause = payload;
            }
            return;
        }
        if (message.type === 'cohort') {
            ticket.processingCohortFrames += 1;
            try { registerCohort(ticket, message.members); }
            catch (_) { failCohort(ticket); }
            finally {
                ticket.processingCohortFrames -= 1;
                pumpCohort(ticket);
                completeNormally(ticket);
            }
            return;
        }
        if (message.type === 'recovery') {
            cause(ticket, 'cancellation', 'recovery', ticket.remoteCause ? { ...ticket.remoteCause, source: 'supervisor' } : {});
            void cancel(ticket); return;
        }
        if (ticket.cancelling) return;
        if (message.type === 'hello' && ticket.state === 'launched' && message.pid === ticket.child.pid) {
            ticket.state = 'ownership';
            ticket.helloReceived = true;
            await captureCoordinator(ticket);
            if (ticket.cancelling || ticket.finished) return;
            ticket.state = 'acquiring';
            // An expired/closed inert supervisor receives no repository input
            // and starts no worker. It still closes through its protocol.
            const unusedError = expired(ticket) ? timeout() : ticket.isClosed() ? closed() : null;
            ticket.ownershipAcknowledged = send(ticket, { type: 'ownership', ...options(ticket), deadline: ticket.deadline,
                operation: unusedError ? null : ticket.operation,
                unusedError: unusedError && { code: unusedError.code, message: unusedError.message } });
            if (!ticket.ownershipAcknowledged) void cancel(ticket);
            ticket.operation = null;
        } else if (message.type === 'authorize' && ticket.state === 'acquiring') {
            ticket.state = 'awaiting-admission';
            let error;
            try {
                if (!accepting || ticket.isClosed()) throw closed();
                if (expired(ticket)) throw timeout();
                if (await ticket.authorize() !== true) throw failure('EDGE_GENERATION_CHANGED', 'The routing generation changed before repository admission.');
                if (!accepting || ticket.isClosed()) throw closed();
                if (expired(ticket)) throw timeout();
            } catch (cause) { error = cause; }
            if (ticket.cancelling || ticket.finished) return;
            ticket.state = 'running';
            ticket.admitted = !error;
            if (ticket.admitted) { time.clearTimeout(ticket.timer); time.clearTimeout(ticket.expiryGrace); }
            if (!send(ticket, { type: 'authorization', ok: !error,
                error: error && { code: error.code, message: sanitizeGitDiagnostic(error.message).slice(0, 8_192) } })) void cancel(ticket);
        } else if (message.type === 'barrier' && ['acquiring', 'running'].includes(ticket.state)) {
            ticket.state = 'settlement-barrier';
        } else if (message.type === 'release-granted' && ticket.state === 'settlement-barrier') {
            ticket.state = 'release-granted';
        } else if (message.type === 'terminal' && ticket.state === 'release-granted' && !ticket.terminal
            && typeof message.ok === 'boolean'
            && (message.ok ? ticket.admitted === true && message.result !== null && typeof message.result === 'object'
                : typeof message.error?.message === 'string')) {
            ticket.terminal = message;
            ticket.state = 'released';
        } else { cause(ticket, 'ipc', 'protocol'); void cancel(ticket); }
    }
    async function launch(ticket) {
        try {
            if (expired(ticket)) throw timeout();
            if (ticket.isClosed()) throw closed();
            const baseline = await observer.scan();
            if (ticket.finished) return;
            observationRecord(ticket, baseline, 'baseline');
            if (!baseline.complete) throw recovery();
            ticket.baseline = baseline.records;
            ticket.router = baseline.records.find((entry) => entry.pid === process.pid);
            if (!ticket.router) { cause(ticket, 'baseline', 'mismatch', { mismatch: 'router-missing' }); throw recovery(); }
            ticket.executable = await resolveExecutable(executablePath);
            if (ticket.finished) return;
            if (expired(ticket)) throw timeout();
            if (ticket.isClosed()) throw closed();
            ticket.state = 'launched';
            ticket.spawnAttempted = true;
            ticket.child = spawnProcess(executablePath, [SUPERVISOR_PATH], {
                cwd: ticket.cwd, shell: false, detached: true,
                env: { ...process.env, PLOINKY_WORKSPACE_ROOT: ticket.workspaceRoot,
                    [REPOSITORY_OPERATION_MARKER]: ticket.operationId },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            ticket.child.stdout?.resume();
            ticket.child.stderr?.resume();
            ticket.child.on('message', (message) => { void handleMessage(ticket, message).catch(error => {
                cause(ticket, ticket.state === 'ownership' ? 'ownership' : 'ipc', 'unknown', processDiagnostic(error));
                return cancel(ticket);
            }); });
            ticket.child.once('error', (error) => { cause(ticket, 'launch', 'spawn-failed', processDiagnostic(error)); void cancel(ticket); });
            ticket.child.once('close', (code, signal) => {
                ticket.childClosed = true;
                if (ticket.finished || ticket.cancelling) return;
                if (code !== 0 || signal || !ticket.terminal || ticket.state !== 'released') {
                    cause(ticket, 'exit', ticket.helloReceived ? 'abnormal-exit' : 'pre-hello-exit', {
                        ...(Number.isSafeInteger(code) && code >= 0 ? { exitCode: code } : {}),
                        ...(signal ? { signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(signal) ? signal : 'OTHER' } : {}),
                        connected: ticket.child.connected === true,
                    });
                    void cancel(ticket); return;
                }
                completeNormally(ticket);
            });
        } catch (error) {
            cause(ticket, ticket.spawnAttempted ? 'launch' : 'baseline', ticket.spawnAttempted ? 'spawn-failed' : 'unknown', processDiagnostic(error));
            if (error.code === 'workspace_mutation_lock_timeout' || error.code === closed().code) finish(ticket, error);
            else void cancel(ticket);
        }
    }
    function drain() {
        if (active || !accepting) return;
        const ticket = pending.shift();
        if (!ticket) return;
        active = ticket;
        ticket.state = 'preparing';
        void launch(ticket);
    }
    function run({ operation, rawBodyBytes, cwd, workspaceRoot, authorize = () => true, response, diagnosticContext = {} } = {}) {
        const bytes = rawBodyBytes + Buffer.byteLength(JSON.stringify(operation), 'utf8');
        return new Promise((resolve, reject) => {
            if (!accepting) { reject(recovery()); diagnostics.emit(); return; }
            if (!Number.isSafeInteger(bytes) || bytes < 0) { reject(failure('PLOINKY_MARKETPLACE_REPOSITORY_INPUT_INVALID', 'Invalid repository input size.')); return; }
            if (pending.length >= REPOSITORY_QUEUE_LIMITS.pending || bytes > REPOSITORY_QUEUE_LIMITS.bytes - chargedBytes) {
                reject(failure('marketplace_repository_busy', 'Repository operation queue is full. Retry later.')); return;
            }
            let done;
            const ticket = { operation, bytes, cwd, workspaceRoot, authorize, response, resolve, reject,
                started: time.monotonic(),
                diagnosticContext: { ...(diagnosticPayload(diagnosticContext) || {}),
                    ...(diagnosticIdentity(workspaceRoot) ? { workspace: diagnosticIdentity(workspaceRoot) } : {}),
                    action: ['install_repo', 'uninstall_repo'].includes(operation?.action) ? operation.action : 'unknown',
                    caller: diagnosticPayload(diagnosticContext)?.caller || 'unknown' },
                deadline: time.now() + REPOSITORY_QUEUE_LIMITS.admissionMs, operationId: randomUUID(),
                state: 'pending', remembered: [], processingCohortFrames: 0, cohortClaims: new Map(),
                cohortSequence: 0, cohortFailed: false,
                done: () => done(), settled: new Promise((settle) => { done = settle; }) };
            let responseClosed = false;
            ticket.isClosed = () => responseClosed || (!response?.writableEnded && (response?.closed === true || response?.destroyed === true));
            ticket.onClose = () => {
                record(ticket, { phase: 'closure', reason: 'closed', closedAt: time.now(), admitted: ticket.admitted === true });
                if (!response?.writableEnded) responseClosed = true;
                if (ticket.state === 'pending' && ticket.isClosed()) finish(ticket, closed());
            };
            response?.once?.('close', ticket.onClose);
            chargedBytes += bytes;
            record(ticket, { phase: 'receipt', reason: 'received' });
            pending.push(ticket);
            if (ticket.isClosed()) { finish(ticket, closed()); return; }
            ticket.timer = time.setTimeout(() => {
                if (ticket.finished || ticket.admitted) return;
                if (ticket.state === 'pending') finish(ticket, timeout());
                else {
                    send(ticket, { type: 'expire' });
                    // Acquisition has its own remaining-time budget. Permit
                    // unused-lease settlement; a broken protocol must not hold
                    // admission forever. This never times an admitted Git call.
                    ticket.expiryGrace = time.setTimeout(() => {
                        if (!ticket.admitted) { cause(ticket, 'admission', 'expired'); void cancel(ticket, timeout()); }
                    }, 4_000);
                }
            }, Math.max(0, ticket.deadline - time.now()));
            drain();
        });
    }
    function shutdown() {
        if (shutdownPromise) return shutdownPromise;
        accepting = false;
        discardPending(closed());
        const ticket = active;
        shutdownPromise = (async () => {
            if (ticket) { cause(ticket, 'shutdown', 'shutdown'); await cancel(ticket, ticket.child ? recovery() : closed()); }
            return recoveryDebt ? { ok: false, code: RECOVERY_CODE } : { ok: true };
        })();
        return shutdownPromise;
    }
    return { run, shutdown, diagnostics: diagnostics.snapshot,
        snapshot: () => ({ active: Boolean(active), pending: pending.length, chargedBytes, accepting, recoveryDebt }) };
}

let runner;
let shutdownRequested = false;
export function runMarketplaceRepositoryWorker(options) {
    if (shutdownRequested) return Promise.reject(recovery());
    runner ||= createMarketplaceRepositoryRunner();
    return runner.run(options);
}
export function shutdownMarketplaceRepositoryWorkers() {
    shutdownRequested = true;
    return runner ? runner.shutdown() : Promise.resolve({ ok: true });
}
