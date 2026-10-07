import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { retainWorkspaceMutationLeaseForRecovery } from '../utils/runtime/maintenanceLocks.js';
import { createRepositoryProcessObserver, proveRepositoryQuiescence, REPOSITORY_OPERATION_MARKER, sameProcess } from './marketplaceRepositoryProcessGroup.mjs';

const THREAD_URL = new URL('./marketplaceRepositoryWorkerThread.mjs', import.meta.url);

export function startRepositorySupervisor({
    channel = process, observer = createRepositoryProcessObserver(), WorkerClass = Worker,
    retain = retainWorkspaceMutationLeaseForRecovery,
} = {}) {
    const operationId = process.env[REPOSITORY_OPERATION_MARKER];
    const operation = `marketplace-repository:${operationId}`;
    let state = 'inert';
    let worker;
    let token;
    let options;
    let data;
    let terminal;
    let workerExited = false;
    let observing = false;
    let poll;
    let cancelTimer;
    let remembered = [];
    const send = (message) => {
        if (!channel.connected) return;
        try { channel.send({ ...message, operationId }, (error) => { if (error) void cancel(); }); }
        catch (_) { void cancel(); }
    };
    const retainExact = () => {
        try { return retain({ token, operation }, 'Repository operation requires exact Box recovery'); }
        catch (_) { return false; }
    };
    const snapshotOptions = () => ({ ...options, remembered });
    const remember = (observation) => {
        const union = new Map(remembered.map((entry) => [`${entry.pid}:${entry.birth}`, entry]));
        for (const entry of observation.members) union.set(`${entry.pid}:${entry.birth}`, entry);
        // No unbounded history during a long clone. Overflow is a recovery
        // condition, never loss of identities that might still be writers.
        if (union.size > 8_192) { void cancel(); return; }
        remembered = [...union.values()];
        send({ type: 'cohort', members: remembered });
    };
    async function observe() {
        if (!options || observing || state === 'closed') return null;
        observing = true;
        try {
            const observation = await observer.scan(snapshotOptions());
            remember(observation);
            if (state === 'settlement-barrier' && observation.writers.length) void cancel();
            return observation;
        } finally { observing = false; }
    }
    async function cancel() {
        if (state === 'closed') return;
        if (state === 'cancelling') { retainExact(); return; }
        state = 'cancelling';
        clearInterval(poll);
        retainExact();
        send({ type: 'recovery', code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
        const started = performance.now();
        // The Router owns final group KILL while connected. Without it, the
        // supervisor must kill its own group, leaving the retained fence for
        // external Box recovery; it cannot claim post-death proof.
        cancelTimer = setTimeout(async () => {
            retainExact();
            if (!channel.connected && options?.coordinator) {
                await Promise.allSettled(remembered.filter((entry) => !sameProcess(entry, options.coordinator))
                    .map((entry) => observer.signal(entry, 'SIGKILL')));
                await observer.signal(options.coordinator, 'SIGKILL', { coordinator: options.coordinator, group: true });
                process.exitCode = 1;
            }
        }, 3_000);
        const observation = await observe();
        if (performance.now() - started < 3_000 && observation) {
            await Promise.allSettled(observation.members.filter((entry) => !sameProcess(entry, options.router))
                .map((entry) => observer.signal(entry, 'SIGTERM')));
        }
        // Lease acquisition can finish between cancellation and termination.
        // The same-PID operation lookup is repeated before and after exit.
        retainExact();
        if (worker) void worker.terminate().then(() => retainExact(), () => retainExact());
    }
    async function settle() {
        state = 'settlement-barrier';
        send({ type: 'barrier' });
        clearInterval(poll);
        // Wait for the bounded current pass before taking the two independent
        // barrier observations; overlap would make both observations unknown.
        while (observing && state === 'settlement-barrier') await new Promise((resolve) => setTimeout(resolve, 5));
        if (state !== 'settlement-barrier') return;
        const proof = await proveRepositoryQuiescence(observer, snapshotOptions(), { barrier: true });
        if (proof.observation) remember(proof.observation);
        if (state !== 'settlement-barrier') return;
        if (!proof.ok) { await cancel(); return; }
        state = 'release-granted';
        send({ type: 'release-granted' });
        worker.postMessage({ type: 'release', operationId });
    }
    function finish() {
        if (!terminal || !workerExited || state !== 'release-granted') return;
        state = 'closed';
        clearInterval(poll);
        clearTimeout(cancelTimer);
        send({ type: 'terminal', ...terminal });
        channel.disconnect();
    }
    channel.on('message', (message) => {
        void handleMessage(message).catch(() => cancel());
    });
    async function handleMessage(message) {
        if (message?.operationId !== operationId) { await cancel(); return; }
        if (message.type === 'cancel') { await cancel(); return; }
        if (state === 'cancelling') return;
        if (message.type === 'ownership' && state === 'inert') {
            state = 'ownership';
            data = message;
            if (!Number.isSafeInteger(data.deadline)) { await cancel(); return; }
            const own = await observer.read(process.pid, { executable: true });
            if (!sameProcess(own, data.coordinator) || own.group !== process.pid || own.session !== process.pid
                || own.exe !== data.coordinator.exe || JSON.stringify(own.argv) !== JSON.stringify(data.coordinator.argv)) {
                await cancel(); return;
            }
            if (state !== 'ownership') return;
            options = { coordinator: own, router: data.router, baseline: data.baseline, operationId };
            if (Date.now() >= data.deadline) {
                // Ownership was acknowledged but no thread or lease exists.
                // This is an unused admission failure, not a failed mutation.
                send({ type: 'barrier' });
                send({ type: 'release-granted' });
                state = 'release-granted';
                terminal = { ok: false, error: { code: 'workspace_mutation_lock_timeout',
                    message: 'Timed out waiting for repository operation admission.' } };
                workerExited = true;
                finish();
                return;
            }
            state = 'acquiring';
            worker = new WorkerClass(THREAD_URL, {
                workerData: { operationId, operation: data.operation, deadline: data.deadline }, stdout: true, stderr: true,
            });
            data.operation = null;
            worker.stdout?.resume();
            worker.stderr?.resume();
            worker.on('message', (entry) => { void workerMessage(entry).catch(() => cancel()); });
            worker.once('error', () => { void cancel(); });
            worker.once('exit', (code) => {
                workerExited = true;
                if (state === 'cancelling') retainExact();
                else if (code !== 0 || !terminal) void cancel();
                else finish();
            });
            poll = setInterval(() => { void observe().catch(() => cancel()); }, 100);
        } else if (message.type === 'authorization' && state === 'awaiting-admission') {
            // Expiry is still checked again in the worker immediately before
            // service entry. An admitted Git call has no normal time limit.
            state = 'running';
            worker.postMessage({ ...message, ok: message.ok === true && Date.now() < data.deadline });
        } else await cancel();
    }
    async function workerMessage(message) {
        if (message?.operationId !== operationId) { await cancel(); return; }
        if (message.type === 'lease') {
            if (token || typeof message.token !== 'string' || !message.token) { await cancel(); return; }
            token = message.token;
            if (state === 'cancelling') retainExact();
            else if (state !== 'acquiring') await cancel();
            return;
        }
        if (state === 'cancelling') return;
        if (message.type === 'authorize' && state === 'acquiring' && token) {
            state = 'awaiting-admission';
            send({ type: 'authorize' });
        } else if (message.type === 'barrier' && ['acquiring', 'running'].includes(state)) {
            await settle();
        } else if (message.type === 'terminal' && state === 'release-granted' && !terminal
            && typeof message.ok === 'boolean') {
            terminal = message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error };
            finish();
        } else await cancel();
    }
    channel.on('disconnect', () => { if (state !== 'closed') void cancel(); });
    process.on('SIGTERM', () => { void cancel(); });
    process.on('SIGINT', () => { void cancel(); });
    send({ type: 'hello', pid: process.pid });
    return { cancel, state: () => state };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.send) startRepositorySupervisor();
