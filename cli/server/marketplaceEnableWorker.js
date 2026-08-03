import { Worker } from 'node:worker_threads';

const MARKETPLACE_ENABLE_WORKER_URL = new URL('./marketplaceEnableWorkerThread.js', import.meta.url);
export const MARKETPLACE_ENABLE_TIMEOUT_MS = 180_000;

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
} = {}) {
    const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs))
        ? Math.max(1, Math.floor(Number(timeoutMs)))
        : MARKETPLACE_ENABLE_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        let settled = false;
        const worker = new WorkerClass(workerUrl, {
            workerData: {
                agentRef: String(agentRef || ''),
                mode: String(mode || ''),
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

        worker.once('message', (message) => {
            if (message?.ok === true) {
                finish(resolve, message.result);
                return;
            }
            if (message?.ok === false) {
                finish(reject, deserializeWorkerError(message.error));
                return;
            }
            const error = new Error('Marketplace enable worker returned an invalid response.');
            error.code = 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED';
            finish(reject, error);
        });
        worker.once('error', (cause) => {
            const error = new Error('Marketplace enable worker failed.', { cause });
            error.code = 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED';
            finish(reject, error);
        });
        worker.once('exit', (code) => {
            if (settled) return;
            const error = new Error(`Marketplace enable worker exited before completion (${code}).`);
            error.code = 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED';
            finish(reject, error);
        });

        const timer = setTimeout(() => {
            const error = new Error(`Marketplace agent activation exceeded ${effectiveTimeoutMs}ms.`);
            error.code = 'PLOINKY_MARKETPLACE_ENABLE_TIMEOUT';
            error.status = 504;
            void worker.terminate?.();
            finish(reject, error);
        }, effectiveTimeoutMs);
        timer.unref?.();
    });
}

export default runMarketplaceEnableWorker;
