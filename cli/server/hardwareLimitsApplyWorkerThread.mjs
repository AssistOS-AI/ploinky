import { parentPort, workerData } from 'node:worker_threads';
import { applyHardwareLimits } from '../sandbox/hardwareLimits/reconcile.mjs';
import { serializeHardwareAwareError } from '../sandbox/hardwareLimits/errors.mjs';
import { validateHardwareRequest } from './authHandlers/hardwareLimitsRequest.mjs';

if (parentPort) {
    try {
        const input = { expectedToken: workerData?.expectedToken, containers: workerData?.containers };
        validateHardwareRequest({ action: 'apply', ...input });
        const buffer = workerData?.operationControl?.buffer;
        if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== 16) throw new Error('Apply control is invalid.');
        const control = new Int32Array(buffer);
        const deadline = workerData.operationControl.deadline;
        if (!Number.isSafeInteger(deadline)) throw new Error('Apply deadline is invalid.');
        const authorize = () => {
            if (Atomics.load(control, 0) || Date.now() >= deadline) return false;
            const requestId = Atomics.add(control, 1, 1) + 1;
            parentPort.postMessage({ type: 'authorize', requestId });
            const waitDeadline = Math.min(deadline, Date.now() + 5_000);
            while (Atomics.load(control, 2) !== requestId && Date.now() < waitDeadline) Atomics.wait(control, 2, Atomics.load(control, 2), Math.max(1, waitDeadline - Date.now()));
            return Atomics.load(control, 2) === requestId && Atomics.load(control, 3) === 1 && Atomics.load(control, 0) === 0;
        };
        const result = await applyHardwareLimits(input, {
            operationDeadline: deadline, authorize, isCancelled: () => Atomics.load(control, 0) === 1,
            onPlan: (plan) => parentPort.postMessage({ type: 'plan', plan }),
            onResult: (value) => parentPort.postMessage({ type: 'result', result: value }),
        });
        parentPort.postMessage({ ok: true, cleanupComplete: true, result });
    } catch (error) {
        parentPort.postMessage({ ok: false, cleanupComplete: error?.code !== 'workspace_mutation_lock_release_failed', error: serializeHardwareAwareError(error) });
    }
}
