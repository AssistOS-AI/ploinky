import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { resolveNoWaitBarrierTimeouts } from '../commands/noWaitProtocol.js';
import { retainWorkspaceMutationLeaseForRecovery } from '../utils/runtime/maintenanceLocks.js';

const MARKETPLACE_ENABLE_WORKER_URL = new URL('./marketplaceEnableWorkerThread.js', import.meta.url);
// Marketplace performs the same cold image installation as background startup.
// Its outer watchdog must include the sanctioned image-operation budgets.
export const MARKETPLACE_ENABLE_TIMEOUT_MS = resolveNoWaitBarrierTimeouts().activeTimeoutMs;

function boundedMessage(value, fallback) {
    const message = String(value || '').trim();
    return (message || fallback).slice(0, 512);
}

function deserializeWorkerError(payload, depth = 0) {
    const error = new Error(boundedMessage(payload?.message, 'Marketplace agent activation failed.'));
    if (typeof payload?.code === 'string' && payload.code) error.code = payload.code;
    if (Number.isInteger(payload?.status)) error.status = payload.status;
    if (depth < 4 && payload?.cause && typeof payload.cause === 'object') {
        error.cause = deserializeWorkerError(payload.cause, depth + 1);
    }
    return error;
}

export function runMarketplaceEnableWorker({ agentRef, mode }, {
    WorkerClass = Worker,
    workerUrl = MARKETPLACE_ENABLE_WORKER_URL,
    timeoutMs = MARKETPLACE_ENABLE_TIMEOUT_MS,
    retainLease = retainWorkspaceMutationLeaseForRecovery,
} = {}) {
    const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs))
        ? Math.max(1, Math.floor(Number(timeoutMs)))
        : MARKETPLACE_ENABLE_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        let settled = false;
        let leaseToken = null;
        let abnormalEnd = false;
        const operationId = randomUUID();
        const operation = `marketplace-enable:${operationId}`;
        const retainWorkerLease = () => {
            try { retainLease({ token: leaseToken, operation }, 'Marketplace worker ended without descendant quiescence'); } catch (_) {}
        };
        const recoveryError = (error) => {
            abnormalEnd = true;
            retainWorkerLease();
            error.recoveryRequired = true;
            error.message += ' Workspace recovery is required: child processes or installer runtimes may still run. '
                + 'Stop the exact Box from its host workspace, then start it again; its mutation lease is retained.';
            return error;
        };
        const worker = new WorkerClass(workerUrl, {
            workerData: {
                agentRef: String(agentRef || ''),
                mode: String(mode || ''),
                operationId,
            },
            stdout: true,
            stderr: true,
        });
        worker.stdout?.resume?.();
        worker.stderr?.resume?.();

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };

        worker.on('message', (message) => {
            if (message?.type === 'workspace-lease') {
                leaseToken = typeof message.token === 'string' ? message.token : null;
                if (abnormalEnd) retainWorkerLease();
                return;
            }
            if (settled) return;
            // Health probes publish progress on the same parent port. Only the
            // activation result may complete the Marketplace mutation.
            if (message?.type === 'log') return;
            if (message?.ok === true) {
                // The worker released its own lease before reporting.
                leaseToken = null;
                finish(resolve, message.result);
                return;
            }
            if (message?.ok === false) {
                leaseToken = null;
                finish(reject, deserializeWorkerError(message.error));
                return;
            }
            const error = new Error('Marketplace enable worker returned an invalid response.');
            error.code = 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED';
            finish(reject, recoveryError(error));
            Promise.resolve(worker.terminate?.()).catch(() => {});
        });
        worker.once('error', (cause) => {
            const error = new Error('Marketplace enable worker failed.', { cause });
            error.code = 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED';
            finish(reject, recoveryError(error));
        });
        worker.once('exit', (code) => {
            if (abnormalEnd) retainWorkerLease();
            if (settled) return;
            const error = new Error(`Marketplace enable worker exited before completion (${code}).`);
            error.code = 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED';
            finish(reject, recoveryError(error));
        });

        const timer = setTimeout(() => {
            const error = new Error(`Marketplace agent activation exceeded ${effectiveTimeoutMs}ms.`);
            error.code = 'PLOINKY_MARKETPLACE_ENABLE_TIMEOUT';
            error.status = 504;
            recoveryError(error);
            Promise.resolve(worker.terminate?.()).then(retainWorkerLease, retainWorkerLease);
            finish(reject, error);
        }, effectiveTimeoutMs);
        timer.unref?.();
    });
}

export default runMarketplaceEnableWorker;
