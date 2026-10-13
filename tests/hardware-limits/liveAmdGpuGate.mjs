import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { blocked } from './liveCommon.mjs';

export const AMD_IDLE_LIMITS = Object.freeze({ baselineMs: 60000, windowMs: 5000, busyMedian: 10,
    growthBytes: 536870912, intervalMs: 2000, samples: 1800 });
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
export function assertAmdSample(sample) {
    if (!Number.isFinite(sample?.busyPercent) || sample.busyPercent < 0 || sample.busyPercent > 100
        || !['vramUsedBytes', 'gttUsedBytes'].every(key => Number.isSafeInteger(sample[key]) && sample[key] >= 0)
        || !Number.isSafeInteger(sample.vramUsedBytes + sample.gttUsedBytes)) throw blocked('AMD idle telemetry unreadable');
}
export function validateAmdBaseline(baseline) {
    const rows = baseline?.samples;
    if (!Array.isArray(rows) || rows.length < 31 || rows.length > AMD_IDLE_LIMITS.samples
        || rows.at(-1).monotonicMs - rows[0].monotonicMs < AMD_IDLE_LIMITS.baselineMs) throw blocked('AMD idle baseline incomplete');
    for (let index = 0; index < rows.length; index += 1) {
        assertAmdSample(rows[index]);
        if (!Number.isFinite(rows[index].monotonicMs) || rows[index].monotonicMs < 0
            || index && (rows[index].monotonicMs <= rows[index - 1].monotonicMs || rows[index].monotonicMs - rows[index - 1].monotonicMs > 4000)) throw blocked('AMD baseline clock gap');
    }
    const used = rows.map(row => row.vramUsedBytes + row.gttUsedBytes);
    if (Math.max(...used) - Math.min(...used) > AMD_IDLE_LIMITS.growthBytes || median(rows.map(row => row.busyPercent)) > AMD_IDLE_LIMITS.busyMedian) throw blocked('AMD idle baseline unstable');
    return { usedBytes: median(used) };
}
export function validateAmdCheck(receipt, baseline, { requireComplete = true } = {}) {
    const reject = message => { throw blocked(message); };
    if (!receipt || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1
        || !['idle', 'active'].includes(receipt.idleMode) || !['operation', 'final'].includes(receipt.purpose)
        || !['complete', 'blocked'].includes(receipt.state) || requireComplete && receipt.state !== 'complete'
        || !Number.isSafeInteger(receipt.allocationAllowanceBytes) || receipt.allocationAllowanceBytes < 0
        || !Number.isFinite(receipt.startedMonotonicMs) || receipt.startedMonotonicMs < 0
        || !Number.isFinite(receipt.endedMonotonicMs) || receipt.endedMonotonicMs < receipt.startedMonotonicMs
        || !Array.isArray(receipt.samples) || !receipt.samples.length || receipt.samples.length > AMD_IDLE_LIMITS.samples) reject('AMD check receipt unavailable');
    const base = validateAmdBaseline(baseline);
    let last = null;
    for (const row of receipt.samples) {
        assertAmdSample(row);
        if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isFinite(row.monotonicMs)
            || row.monotonicMs < receipt.startedMonotonicMs || row.monotonicMs > receipt.endedMonotonicMs
            || last && (row.sequence <= last.sequence || row.monotonicMs <= last.monotonicMs
                || row.monotonicMs - last.monotonicMs > 4000)) reject('AMD check sample order or window differs');
        if ((requireComplete || receipt.state === 'complete') && row.vramUsedBytes + row.gttUsedBytes > base.usedBytes + receipt.allocationAllowanceBytes + AMD_IDLE_LIMITS.growthBytes) reject('AMD unexplained memory growth');
        last = row;
    }
    if (receipt.idleMode === 'idle' && (requireComplete || receipt.state === 'complete')) {
        if (receipt.samples.at(-1).monotonicMs - receipt.samples[0].monotonicMs < AMD_IDLE_LIMITS.windowMs
            || median(receipt.samples.map(row => row.busyPercent)) > AMD_IDLE_LIMITS.busyMedian) reject('AMD idle observation window or busy threshold differs');
    }
    if (receipt.purpose === 'final' && (receipt.idleMode !== 'idle' || receipt.allocationAllowanceBytes !== 0
        || receipt.allocationEvidence !== null || receipt.context !== null)) reject('AMD final idle check must have zero allowance');
    return receipt;
}
export function createAmdGpuGate({ sample, baseline = null, write = () => {}, clock = () => performance.now(), wait = ms => delay(ms), signal }) {
    const history = []; let tripped = false; let allowance = 0; let allocationEvidence = null; let context = null;
    let sampleSequence = 0; let lastSampleAt = -1; let observationsCount = 0;
    const snapshot = () => structuredClone({ schema: 1, thresholds: AMD_IDLE_LIMITS, baseline, history, tripped });
    const now = () => { const at = clock(); if (!Number.isFinite(at) || at < 0) throw blocked('AMD observation clock invalid'); return at; };
    const observe = async () => {
        const value = await sample(); assertAmdSample(value);
        const at = now();
        if (at <= lastSampleAt || ++observationsCount > AMD_IDLE_LIMITS.samples) throw blocked('AMD observation clock or bound invalid');
        lastSampleAt = at;
        const row = { monotonicMs: at, busyPercent: value.busyPercent, vramUsedBytes: value.vramUsedBytes, gttUsedBytes: value.gttUsedBytes };
        return row;
    };
    async function initial() {
        try {
            if (baseline) validateAmdBaseline(baseline);
            else {
                const rows = [await observe()];
                while (rows.at(-1).monotonicMs - rows[0].monotonicMs < AMD_IDLE_LIMITS.baselineMs) {
                    signal?.throwIfAborted(); await wait(AMD_IDLE_LIMITS.intervalMs); rows.push(await observe());
                }
                baseline = { samples: rows }; validateAmdBaseline(baseline);
            }
            write(snapshot()); return baseline;
        } catch (error) { tripped = true; write(snapshot()); throw error; }
    }
    async function check({ idle = true, final = false } = {}) {
        const receipt = { sequence: history.length + 1, purpose: final ? 'final' : 'operation',
            idleMode: idle ? 'idle' : 'active', context: structuredClone(context), allocationAllowanceBytes: allowance,
            allocationEvidence: structuredClone(allocationEvidence), startedMonotonicMs: now(), endedMonotonicMs: null,
            state: 'pending', samples: [] };
        try {
            if (history.length >= AMD_IDLE_LIMITS.samples || final && (!idle || allowance !== 0 || context !== null)) throw blocked('AMD check mode or bound invalid');
            history.push(receipt);
            const base = validateAmdBaseline(baseline); const rows = receipt.samples;
            const read = async () => { const row = await observe(); rows.push({ sequence: ++sampleSequence, ...row }); };
            await read();
            if (idle) while (rows.at(-1).monotonicMs - rows[0].monotonicMs < AMD_IDLE_LIMITS.windowMs) {
                signal?.throwIfAborted(); await wait(AMD_IDLE_LIMITS.intervalMs); await read();
            }
            for (const row of rows) if (row.vramUsedBytes + row.gttUsedBytes > base.usedBytes + receipt.allocationAllowanceBytes + AMD_IDLE_LIMITS.growthBytes) throw blocked('AMD unexplained memory growth');
            if (idle && median(rows.map(row => row.busyPercent)) > AMD_IDLE_LIMITS.busyMedian) throw blocked('AMD GPU is not idle');
            receipt.endedMonotonicMs = now(); receipt.state = 'complete';
            validateAmdCheck(receipt, baseline);
            write(snapshot()); return rows.at(-1);
        } catch (error) { tripped = true; receipt.state = 'blocked'; receipt.endedMonotonicMs = now(); write(snapshot()); throw error; }
    }
    return { initial, check, snapshot, setCase(value) { context = structuredClone(value); allowance = 0; allocationEvidence = null; }, setAllowance(bytes, evidence = null) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 0 && (!evidence || evidence.case !== context?.case || evidence.requestId !== context?.requestId)) throw blocked('AMD allocation allowance unavailable');
        allowance = bytes; allocationEvidence = bytes === 0 ? null : structuredClone(evidence);
    } };
}
