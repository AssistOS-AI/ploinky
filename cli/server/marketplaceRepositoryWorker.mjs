import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';
import { sanitizeGitDiagnostic } from '../utils/gitCommand.js';
import { createRepositoryProcessObserver, proveRepositoryQuiescence, REPOSITORY_OPERATION_MARKER, sameProcess } from './marketplaceRepositoryProcessGroup.mjs';

const SUPERVISOR_PATH = fileURLToPath(new URL('./marketplaceRepositorySupervisor.mjs', import.meta.url));
export const REPOSITORY_QUEUE_LIMITS = Object.freeze({ pending: 16, bytes: 8 * 1024 * 1024, admissionMs: 600_000 });
const RECOVERY_CODE = 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED';
const clock = { now: () => Date.now(), monotonic: () => performance.now(), setTimeout, clearTimeout };
const COHORT_FIELDS = ['pid', 'birth', 'namespace', 'uids', 'parent', 'group', 'session', 'state'];

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
} = {}) {
    const pending = [];
    let active = null;
    let chargedBytes = 0;
    let accepting = true;
    let recoveryDebt = false;
    let shutdownPromise;
    const delay = (ms) => new Promise((resolve) => time.setTimeout(resolve, Math.max(0, ms)));
    const expired = (ticket) => time.now() >= ticket.deadline;
    function discardPending(error) {
        for (const ticket of [...pending]) finish(ticket, error);
    }
    function finish(ticket, error, result) {
        if (ticket.finished) return;
        ticket.finished = true;
        time.clearTimeout(ticket.timer);
        time.clearTimeout(ticket.expiryGrace);
        ticket.response?.removeListener?.('close', ticket.onClose);
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
    function send(ticket, message) {
        if (!ticket.child?.connected) return false;
        try {
            ticket.child.send({ ...message, operationId: ticket.operationId }, (error) => {
                if (error && !ticket.finished && !ticket.cancelling) void cancel(ticket);
            });
            return true;
        } catch (_) { return false; }
    }
    const options = (ticket) => ({ baseline: ticket.baseline, coordinator: ticket.coordinator,
        router: ticket.router, operationId: ticket.operationId, remembered: ticket.remembered });
    function remember(ticket, records) {
        if (!Array.isArray(records) || records.length > 8_192) throw recovery();
        const normalized = records.map((entry) => Object.fromEntries(COHORT_FIELDS.map((field) => [field, entry?.[field]])));
        if (normalized.some((entry) => !validCohortRecord(entry))) throw recovery();
        const union = new Map(ticket.remembered.map((entry) => [`${entry.pid}:${entry.birth}`, entry]));
        for (const entry of normalized) union.set(`${entry.pid}:${entry.birth}`, entry);
        if (union.size > 8_192) throw recovery();
        ticket.remembered = [...union.values()];
    }
    async function acceptCohort(ticket, records) {
        if (!ticket.ownershipAcknowledged || !['acquiring', 'awaiting-admission', 'running',
            'settlement-barrier', 'release-granted', 'cancelling'].includes(ticket.state)
            || !Array.isArray(records) || records.length > 8_192 || records.some((entry) => !validCohortRecord(entry))) throw recovery();
        const unproven = records.filter((entry) => !ticket.remembered.some((known) => sameProcess(known, entry)));
        if (!unproven.length) return;
        // A peer's stable PID identity is not signal authority. Corroborate
        // new claims using only the Router's already-proven cohort as history.
        // Supervisor-only history that has lost all local ownership evidence
        // remains unknown; it cannot seed its own proof through IPC.
        const observation = await observer.scan(options(ticket));
        if (ticket.finished) return;
        if (unproven.some((entry) => !observation.members.some((owned) => sameProcess(owned, entry)))) throw recovery();
        remember(ticket, observation.members);
    }
    async function captureCoordinator(ticket) {
        const record = await observer.read(ticket.child.pid, { executable: true });
        if (record.pid !== ticket.child.pid || record.group !== record.pid || record.session !== record.pid
            || record.namespace !== ticket.router.namespace || record.uids !== ticket.router.uids
            || record.exe !== ticket.executable || JSON.stringify(record.argv) !== JSON.stringify([executablePath, SUPERVISOR_PATH])) throw recovery();
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
        ticket.cancelling = true;
        ticket.state = 'cancelling';
        accepting = false;
        // Once a supervisor exists, partial publication cannot be rolled back
        // by process death. Keep debt even after every process is gone.
        recoveryDebt ||= Boolean(ticket.child) || error.code === RECOVERY_CODE;
        discardPending(recovery());
        time.clearTimeout(ticket.timer);
        time.clearTimeout(ticket.expiryGrace);
        if (!ticket.child) { finish(ticket, error); return ticket.settled; }
        const started = time.monotonic();
        const deadline = started + 8_000;
        send(ticket, { type: 'cancel' }); // same-PID retention precedes supervisor signals
        const hardStop = time.setTimeout(() => finish(ticket, error), 8_000);
        void (async () => {
            try {
                if (!ticket.coordinator) {
                    try { await captureCoordinator(ticket); } catch (_) { /* no unvalidated group signal */ }
                }
                if (!ticket.finished) {
                    try {
                        const observation = await observer.scan(options(ticket));
                        remember(ticket, observation.members);
                    } catch (_) { /* retain known identities for best-effort escalation */ }
                }
                // Begin the final validated group KILL at two seconds: its
                // identity read has a one-second ceiling, inside the 3s grace.
                await delay(started + 2_000 - time.monotonic());
                if (!ticket.finished) await signalMembers(ticket, 'SIGKILL', deadline);
                while (!ticket.finished && time.monotonic() < started + 6_000) {
                    try {
                        const observation = await observer.scan(options(ticket));
                        remember(ticket, observation.members);
                        if (ticket.childClosed) {
                            const proof = await proveQuiescence(observer, options(ticket), { barrier: true });
                            if (proof.ok && time.monotonic() < deadline) {
                                ticket.quiescent = true;
                                break;
                            }
                        }
                    } catch (_) { /* observation failure does not skip known-member KILL */ }
                    await signalMembers(ticket, 'SIGKILL', deadline);
                    await delay(25);
                }
                if (!ticket.finished && ticket.childClosed && !ticket.quiescent && time.monotonic() < deadline) {
                    const proof = await proveQuiescence(observer, options(ticket), { barrier: true });
                    ticket.quiescent = proof.ok && time.monotonic() < deadline;
                }
            } catch (_) {
                // Failed observations never become successful cleanup. The
                // owner-death-required fence remains for exact Box recovery.
            } finally {
                time.clearTimeout(hardStop);
                finish(ticket, error);
            }
        })();
        return ticket.settled;
    }
    async function handleMessage(ticket, message) {
        if (ticket.finished) return;
        if (message?.operationId !== ticket.operationId) { void cancel(ticket); return; }
        if (message.type === 'cohort') { await acceptCohort(ticket, message.members); return; }
        if (message.type === 'recovery') { void cancel(ticket); return; }
        if (ticket.cancelling) return;
        if (message.type === 'hello' && ticket.state === 'launched' && message.pid === ticket.child.pid) {
            ticket.state = 'ownership';
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
        } else void cancel(ticket);
    }
    async function launch(ticket) {
        try {
            if (expired(ticket)) throw timeout();
            if (ticket.isClosed()) throw closed();
            const baseline = await observer.scan();
            if (ticket.finished) return;
            if (!baseline.complete) throw recovery();
            ticket.baseline = baseline.records;
            ticket.router = baseline.records.find((entry) => entry.pid === process.pid);
            if (!ticket.router) throw recovery();
            ticket.executable = await resolveExecutable(executablePath);
            if (ticket.finished) return;
            if (expired(ticket)) throw timeout();
            if (ticket.isClosed()) throw closed();
            ticket.state = 'launched';
            ticket.child = spawnProcess(executablePath, [SUPERVISOR_PATH], {
                cwd: ticket.cwd, shell: false, detached: true,
                env: { ...process.env, PLOINKY_WORKSPACE_ROOT: ticket.workspaceRoot,
                    [REPOSITORY_OPERATION_MARKER]: ticket.operationId },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            ticket.child.stdout?.resume();
            ticket.child.stderr?.resume();
            ticket.child.on('message', (message) => { void handleMessage(ticket, message).catch(() => cancel(ticket)); });
            ticket.child.once('error', () => { void cancel(ticket); });
            ticket.child.once('close', (code, signal) => {
                ticket.childClosed = true;
                if (ticket.finished || ticket.cancelling) return;
                if (code !== 0 || signal || !ticket.terminal || ticket.state !== 'released') { void cancel(ticket); return; }
                const terminal = ticket.terminal;
                if (terminal.ok) finish(ticket, null, terminal.result);
                else {
                    const error = failure(terminal.error.code, sanitizeGitDiagnostic(terminal.error.message).slice(0, 8_192));
                    if (Number.isInteger(terminal.error.status)) error.status = terminal.error.status;
                    finish(ticket, error);
                }
            });
        } catch (error) {
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
    function run({ operation, rawBodyBytes, cwd, workspaceRoot, authorize = () => true, response } = {}) {
        const bytes = rawBodyBytes + Buffer.byteLength(JSON.stringify(operation), 'utf8');
        return new Promise((resolve, reject) => {
            if (!accepting) { reject(recovery()); return; }
            if (!Number.isSafeInteger(bytes) || bytes < 0) { reject(failure('PLOINKY_MARKETPLACE_REPOSITORY_INPUT_INVALID', 'Invalid repository input size.')); return; }
            if (pending.length >= REPOSITORY_QUEUE_LIMITS.pending || bytes > REPOSITORY_QUEUE_LIMITS.bytes - chargedBytes) {
                reject(failure('marketplace_repository_busy', 'Repository operation queue is full. Retry later.')); return;
            }
            let done;
            const ticket = { operation, bytes, cwd, workspaceRoot, authorize, response, resolve, reject,
                deadline: time.now() + REPOSITORY_QUEUE_LIMITS.admissionMs, operationId: randomUUID(),
                state: 'pending', remembered: [], done: () => done(), settled: new Promise((settle) => { done = settle; }) };
            let responseClosed = false;
            ticket.isClosed = () => responseClosed || (!response?.writableEnded && (response?.closed === true || response?.destroyed === true));
            ticket.onClose = () => {
                if (!response?.writableEnded) responseClosed = true;
                if (ticket.state === 'pending' && ticket.isClosed()) finish(ticket, closed());
            };
            response?.once?.('close', ticket.onClose);
            chargedBytes += bytes;
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
                    ticket.expiryGrace = time.setTimeout(() => { if (!ticket.admitted) void cancel(ticket, timeout()); }, 4_000);
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
            if (ticket) await cancel(ticket, ticket.child ? recovery() : closed());
            return recoveryDebt ? { ok: false, code: RECOVERY_CODE } : { ok: true };
        })();
        return shutdownPromise;
    }
    return { run, shutdown, snapshot: () => ({ active: Boolean(active), pending: pending.length, chargedBytes, accepting, recoveryDebt }) };
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
