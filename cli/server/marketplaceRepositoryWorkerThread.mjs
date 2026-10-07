import { parentPort, workerData } from 'node:worker_threads';
import { installRepo } from '../utils/repos.js';
import { uninstallRepositoryUnderLease } from '../utils/repositoryUninstall.mjs';
import { assertWorkspaceMutationLease, withWorkspaceMutationLease } from '../utils/runtime/maintenanceLocks.js';
import { sanitizeGitDiagnostic } from '../utils/gitCommand.js';

export function repositoryAdmissionTimeout() {
    return Object.assign(new Error('Timed out waiting for repository operation admission.'), {
        code: 'workspace_mutation_lock_timeout',
    });
}

export function checkRepositoryDeadline(deadline) {
    if (!Number.isSafeInteger(deadline) || Date.now() >= deadline) throw repositoryAdmissionTimeout();
}

export function serializeRepositoryError(error) {
    const payload = { message: sanitizeGitDiagnostic(error?.message || 'Repository operation failed.').slice(0, 8_192) };
    if (typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,96}$/.test(error.code)) payload.code = error.code;
    if (Number.isInteger(error?.status)) payload.status = error.status;
    return payload;
}

function safeResult(value) {
    if (typeof value === 'string') return sanitizeGitDiagnostic(value);
    if (Array.isArray(value)) return value.map(safeResult);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeResult(entry)]));
    return value;
}

export async function executeRepositoryTransaction(data, {
    send,
    authorize,
    settle,
    withLease = withWorkspaceMutationLease,
    assertLease = assertWorkspaceMutationLease,
    install = installRepo,
    uninstall = uninstallRepositoryUnderLease,
} = {}) {
    let outcome;
    let reachedBarrier = false;
    const barrier = async () => {
        reachedBarrier = true;
        send({ type: 'barrier' });
        await settle();
    };
    try {
        checkRepositoryDeadline(data.deadline);
        const remaining = data.deadline - Date.now();
        if (remaining <= 0) throw repositoryAdmissionTimeout();
        await withLease({ operation: `marketplace-repository:${data.operationId}`,
            requireQuiescenceOnOwnerDeath: true, waitTimeoutMs: remaining }, async (lease) => {
            send({ type: 'lease', token: lease.token });
            try {
                // acquireWorkspaceMutationLease tries acquisition before its
                // elapsed-time check; an expired acquired lease stays unused.
                checkRepositoryDeadline(data.deadline);
                await authorize();
                checkRepositoryDeadline(data.deadline);
                assertLease(lease);
                checkRepositoryDeadline(data.deadline);
                const operation = data.operation;
                let result;
                if (operation.action === 'install_repo') {
                    result = install(operation.url, operation.name, operation.branch, { stdio: 'pipe' });
                } else if (operation.action === 'uninstall_repo') {
                    result = await uninstall(operation.target, {
                        withLease: (_options, callback) => callback(assertLease(lease)), stdio: 'pipe',
                    });
                } else throw new Error('Invalid repository operation.');
                outcome = { ok: true, result: safeResult(result) };
            } catch (error) { outcome = { ok: false, error: serializeRepositoryError(error) }; }
            // No service or mutation path exists beyond this point. The lease
            // callback does not return until the supervisor proves quiescence.
            await barrier();
        });
    } catch (error) {
        outcome = { ok: false, error: serializeRepositoryError(error) };
        if (!reachedBarrier) await barrier();
    }
    return outcome;
}

if (parentPort) {
    const operationId = workerData?.operationId;
    let admission;
    let release;
    let state = 'acquiring';
    const send = (message) => parentPort.postMessage({ ...message, operationId });
    parentPort.on('message', (message) => {
        if (message?.operationId !== operationId) { send({ type: 'protocol-error' }); return; }
        if (message.type === 'authorization' && state === 'awaiting-admission') {
            state = 'running';
            if (message.ok === true) admission.resolve();
            else admission.reject(Object.assign(new Error(message.error?.message || 'Repository admission refused.'), {
                code: message.error?.code,
            }));
        } else if (message.type === 'release' && state === 'barrier') {
            state = 'released';
            release();
        } else send({ type: 'protocol-error' });
    });
    try {
        if (!/^[0-9a-f-]{36}$/.test(operationId || '')) throw new Error('Invalid repository operation identity.');
        const outcome = await executeRepositoryTransaction(workerData, {
            send,
            authorize: () => new Promise((resolve, reject) => {
                admission = { resolve, reject };
                state = 'awaiting-admission';
                send({ type: 'authorize' });
            }),
            settle: () => new Promise((resolve) => { state = 'barrier'; release = resolve; }),
        });
        send({ type: 'terminal', ...outcome });
        parentPort.close();
    } catch (_) {
        send({ type: 'protocol-error' });
        parentPort.close();
        process.exitCode = 1;
    }
}
