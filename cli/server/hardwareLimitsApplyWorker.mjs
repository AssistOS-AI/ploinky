import { Worker } from 'node:worker_threads';
import { deserializeHardwareAwareError } from '../sandbox/hardwareLimits/errors.mjs';
import { validateHardwareRequest } from './authHandlers/hardwareLimitsRequest.mjs';

const WORKER_URL = new URL('./hardwareLimitsApplyWorkerThread.mjs', import.meta.url);
let current = null;

export function hardwareApplyFlight() { return current ? structuredClone(current) : null; }

export async function runHardwareLimitsApplyWorker(input, {
    WorkerClass = Worker, timeoutMs = 15 * 60 * 1000, onPlan = () => {}, authorize = () => true,
    onOwnedSelection = () => false,
} = {}) {
    validateHardwareRequest({ action: 'apply', ...input });
    if (Buffer.byteLength(JSON.stringify(input)) > 16 * 1024) throw Object.assign(new Error('Apply transport exceeds 16 KiB.'), { code: 'invalid_limits', status: 400 });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60 * 1000) throw new Error('Invalid Apply deadline.');
    if (current) throw Object.assign(new Error('Hardware Apply is already in progress or awaiting host recovery.'), { code: 'apply_in_progress', status: 409 });
    const control = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
    let releaseFlight = true;
    current = { containers: [...input.containers], expandedContainers: [], completed: [], state: 'running' };
    try {
        return await new Promise((resolve, reject) => {
            let settled = false;
            let protocolError = null;
            const worker = new WorkerClass(WORKER_URL, { workerData: { ...input, operationControl: { buffer: control.buffer, deadline: Date.now() + timeoutMs } }, stdout: true, stderr: true });
            worker.stdout?.resume();
            worker.stderr?.resume();
            const partial = (error, status = 503) => ({ ok: false, status, error, results: current.completed, pendingContainers: current.containers.filter((key) => !current.completed.some((result) => result.key === key)), expandedContainers: current.expandedContainers });
            const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
            const cancel = (error = null) => {
                protocolError ||= error;
                Atomics.store(control, 0, 1);
                current.state = 'cancelling';
            };
            // Cooperative cancellation lets exact cleanup and live lease
            // release finish before acknowledgement. Forced termination would
            // strand a worker's leases under the still-running Router PID.
            const timer = setTimeout(() => cancel(), timeoutMs);
            timer.unref?.();
            worker.on('message', async (message) => {
                if (settled || message?.type === 'log') return;
                if (message?.type === 'owned-selection') {
                    try {
                        if (onOwnedSelection(message.receipt) !== true) cancel(new Error('Apply routing transition does not belong to this operation.'));
                    } catch (error) { cancel(error); }
                } else if (message?.type === 'authorize') {
                    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0) { cancel(new Error('Invalid authorization request.')); return; }
                    let allowed = false;
                    try { allowed = Atomics.load(control, 0) === 0 && await authorize() === true; } catch (_) {}
                    Atomics.store(control, 3, allowed ? 1 : -1);
                    Atomics.store(control, 2, message.requestId);
                    Atomics.notify(control, 2);
                } else if (message?.type === 'plan') {
                    if (!Array.isArray(message.plan?.containers) || !Array.isArray(message.plan?.expandedContainers)) { cancel(new Error('Invalid Apply plan.')); return; }
                    current = { ...current, ...message.plan };
                    try { onPlan(message.plan); } catch (error) { cancel(error); }
                } else if (message?.type === 'result') {
                    current.completed.push(message.result);
                } else if ((message?.ok === true || message?.ok === false) && message.cleanupComplete === true) {
                    if (protocolError) finish(resolve, partial('apply_failed'));
                    else if (message.ok === true) finish(resolve, message.result);
                    else {
                        let error;
                        try { error = deserializeHardwareAwareError(message.error); } catch (_) { finish(resolve, partial('apply_failed')); return; }
                        if (current.completed.length || Atomics.load(control, 0)) finish(resolve, partial(error.code || 'apply_timeout', error.status || 504));
                        else finish(reject, error);
                    }
                } else cancel(new Error('Invalid Apply worker response.'));
            });
            worker.once('error', (error) => { protocolError = error; cancel(error); });
            worker.once('exit', () => {
                if (settled) return;
                // An unexpected exit does not prove finally blocks ran. Keep
                // new Apply busy and retain the observed partial identities.
                releaseFlight = false;
                current.state = 'recovery-required';
                finish(resolve, { ...partial('apply_recovery_required'), message: 'Apply exited without verified cleanup. Run ploinky restart on the host to recover this Box.' });
            });
        });
    } finally { if (releaseFlight) current = null; }
}
