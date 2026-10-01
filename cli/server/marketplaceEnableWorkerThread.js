import { parentPort, workerData } from 'node:worker_threads';

import { enableAgent } from '../utils/agents.js';
import { findHardwareOutcome } from '../sandbox/hardwareLimits/errors.mjs';

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

if (parentPort) try {
    const agentRef = boundedString(workerData?.agentRef);
    const mode = boundedString(workerData?.mode);
    const repoName = agentRef.split('/')[0] || '';
    const result = await enableAgent(
        agentRef,
        mode || undefined,
        mode === 'devel' ? repoName : undefined,
    );
    parentPort?.postMessage({ ok: true, result });
} catch (error) {
    parentPort?.postMessage({ ok: false, error: serializeError(error) });
}
