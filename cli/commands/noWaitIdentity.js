// Pure no-wait identity validation. This module intentionally has no
// filesystem, workspace, runtime, registry, routing, or lifecycle imports so
// both the worker argv parser and observational protocol can share it.

export const MAX_NO_WAIT_WAVE_INDEX = 1023;
export const NO_WAIT_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function exactRunId(value, label = 'no-wait run id') {
    const runId = String(value || '').trim();
    if (!NO_WAIT_RUN_ID_PATTERN.test(runId)) {
        throw new Error(`${label} must be one exact UUID`);
    }
    return runId.toLowerCase();
}

export function exactEpochMs(value, label = 'no-wait timestamp') {
    const epochMs = Number(value);
    if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
        throw new Error(`${label} must be one exact non-negative epoch millisecond integer`);
    }
    return epochMs;
}

export function exactWaveIndex(value, label = 'no-wait wave index') {
    const waveIndex = Number(value);
    if (!Number.isSafeInteger(waveIndex) || waveIndex < 0 || waveIndex > MAX_NO_WAIT_WAVE_INDEX) {
        throw new Error(`${label} must be an integer between 0 and ${MAX_NO_WAIT_WAVE_INDEX}`);
    }
    return waveIndex;
}
