import { parentPort, workerData } from 'node:worker_threads';

import { enableAgent } from '../utils/agents.js';
import { findEnabledDirectiveRecord } from '../utils/runtime/bootstrapManifest.js';
import { findHardwareOutcome } from '../sandbox/hardwareLimits/errors.mjs';
import { withHeldOrAcquiredWorkspaceMutationLease } from '../utils/runtime/maintenanceLocks.js';

function boundedString(value, fallback = '') {
    const text = String(value || '').trim();
    return (text || fallback).slice(0, 512);
}

export function serializeError(error, depth = 0) {
    const serialized = {
        message: boundedString(error?.message, 'Marketplace agent activation failed.'),
    };
    if (typeof error?.code === 'string' && error.code) serialized.code = error.code;
    if (Number.isInteger(error?.status)) serialized.status = error.status;
    // The typed hardware outcome travels as validated bounded fields, never
    // as text to be parsed back (plan §9.2).
    const hardwareOutcome = depth === 0 ? findHardwareOutcome(error) : null;
    if (hardwareOutcome) serialized.hardwareOutcome = hardwareOutcome;
    if (depth < 4 && error?.cause) serialized.cause = serializeError(error.cause, depth + 1);
    return serialized;
}

// One enable request, run under the workspace lease its caller holds. A
// dependency request (`ifMissing`) looks for its record here, under the lease,
// so two concurrent enables can never create the same instance twice.
export async function runMarketplaceEnableRequest(data, {
    enableAgent: enable = enableAgent,
    findEnabledRecord = findEnabledDirectiveRecord,
} = {}) {
    const agentRef = boundedString(data?.agentRef);
    const mode = boundedString(data?.mode);
    const alias = boundedString(data?.alias);
    const profile = boundedString(data?.profile);
    const repoName = agentRef.split('/')[0] || '';
    if (data?.ifMissing === true && findEnabledRecord({ spec: agentRef, alias })) {
        return { status: 'already-enabled' };
    }
    const args = [
        agentRef,
        mode || undefined,
        mode === 'devel' ? repoName : undefined,
    ];
    if (alias || profile) args.push(alias || undefined, undefined, { profile: profile || undefined });
    return enable(...args);
}

if (parentPort) try {
    const operationId = boundedString(workerData?.operationId);
    if (!/^[0-9a-f-]{36}$/.test(operationId)) throw new Error('Marketplace worker operation identity is missing.');
    // An abnormal thread end cannot prove its subprocesses or installer
    // containers stopped. Such a lease survives owner death until Box recovery.
    const result = await withHeldOrAcquiredWorkspaceMutationLease({
        operation: `marketplace-enable:${operationId}`, requireQuiescenceOnOwnerDeath: true,
    }, (lease) => {
        parentPort?.postMessage({ type: 'workspace-lease', token: lease.token });
        return runMarketplaceEnableRequest(workerData);
    });
    parentPort?.postMessage({ ok: true, result });
} catch (error) {
    parentPort?.postMessage({ ok: false, error: serializeError(error) });
}
