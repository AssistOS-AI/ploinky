// Visible hardware envelope, exact limit resolution and the limits hash
// (plan §3 defaults, §8.1, §8.3). Pure functions over bounded observations.

import crypto from 'node:crypto';
import { resolveMpsShare, MpsError, unsupportedGpuMemoryModelReason, UNSUPPORTED_GPU_MEMORY_MODEL_FIX } from './mpsEligibility.mjs';

export const MIB = 1024 * 1024;
export const MIN_MEMORY_BYTES = 64 * MIB;
export const MIN_GPU_SHARE_BYTES = 512 * MIB;
export const MIN_CPUS = 0.05;
export const AGENTS_CGROUP_PARENT = '/ploinky/agents';
export const SYSTEM_CGROUP_PARENT = '/ploinky/system';
export const LIMITS_HASH_LABEL = 'ploinky.limitshash';

const SIZE_UNITS = { '': 1, b: 1, k: 1024, m: MIB, g: 1024 * MIB, t: 1024 * 1024 * MIB };

export class LimitResolutionError extends Error {
    constructor(message, { code = 'invalid_limits', field = null, status = 422 } = {}) {
        super(message);
        this.name = 'LimitResolutionError';
        this.code = code;
        this.field = field;
        this.status = status;
    }
}

function parseMeminfoTotal(text) {
    const match = /^MemTotal:\s+(\d+)\s+kB\s*$/m.exec(String(text || ''));
    if (!match) return null;
    const bytes = Number(match[1]) * 1024;
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

// A cgroup value is `max` (unlimited), a non-negative safe integer, or
// unreadable. Unreadable never falls back to the host size.
export function parseCgroupValue(raw) {
    if (raw === undefined) return { state: 'absent' };
    if (raw === null) return { state: 'unreadable' };
    const text = String(raw).trim();
    if (text === 'max') return { state: 'max' };
    if (/^\d+$/.test(text)) {
        const value = Number(text);
        if (Number.isSafeInteger(value)) return { state: 'finite', value };
    }
    return { state: 'unreadable' };
}

export function parseCpuMax(raw) {
    if (raw === undefined) return { state: 'absent' };
    if (raw === null) return { state: 'unreadable' };
    const parts = String(raw).trim().split(/\s+/);
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return { state: 'unreadable' };
    const period = Number(parts[1]);
    if (!Number.isSafeInteger(period) || period <= 0) return { state: 'unreadable' };
    if (parts[0] === 'max') return { state: 'max', period };
    if (!/^\d+$/.test(parts[0])) return { state: 'unreadable' };
    const quota = Number(parts[0]);
    if (!Number.isSafeInteger(quota) || quota <= 0) return { state: 'unreadable' };
    return { state: 'finite', quota, period, cpus: quota / period };
}

/**
 * The Box's visible maximum: min(MemTotal, finite namespace-root memory.max)
 * and min(available parallelism, finite namespace-root quota/period). This is
 * not a reservation or a promise of free memory.
 */
export function readEnvelope({ procMeminfo, memoryMax, cpuMax, cpuParallelism } = {}) {
    const memTotal = parseMeminfoTotal(procMeminfo);
    if (memTotal === null) return { unreadable: true, reason: 'MemTotal is unreadable' };
    const memoryLimit = parseCgroupValue(memoryMax);
    if (memoryLimit.state === 'unreadable') return { unreadable: true, reason: 'namespace-root memory.max is unreadable' };
    const cpus = Number(cpuParallelism);
    if (!Number.isSafeInteger(cpus) || cpus < 1) return { unreadable: true, reason: 'available parallelism is unreadable' };
    const cpuLimit = parseCpuMax(cpuMax);
    if (cpuLimit.state === 'unreadable') return { unreadable: true, reason: 'namespace-root cpu.max is unreadable' };
    const memoryBytes = memoryLimit.state === 'finite' ? Math.min(memTotal, memoryLimit.value) : memTotal;
    const envelopeCpus = cpuLimit.state === 'finite' ? Math.min(cpus, cpuLimit.cpus) : cpus;
    return Object.freeze({
        memoryBytes,
        cpus: envelopeCpus,
        provenance: Object.freeze({
            memory: memoryLimit.state === 'finite' && memoryLimit.value < memTotal ? 'cgroup' : 'meminfo',
            cpus: cpuLimit.state === 'finite' && cpuLimit.cpus < cpus ? 'cgroup' : 'parallelism',
        }),
    });
}

export function isTwoDecimalCpus(value) {
    return typeof value === 'number' && Number.isFinite(value) && /^\d+(\.\d{1,2})?$/.test(String(value));
}

// floor(percent * envelope / 100 / MiB) * MiB, never clamped up.
export function resolveMemoryPercent(percent, envelopeBytes) {
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
        throw new LimitResolutionError('memoryPercent must be an integer from 1 to 100', { field: 'memoryPercent' });
    }
    if (!Number.isSafeInteger(envelopeBytes) || envelopeBytes <= 0) {
        throw new LimitResolutionError('the Box memory envelope is unknown', { code: 'controller_unavailable', field: 'memoryPercent', status: 409 });
    }
    const bytes = Math.floor((percent * envelopeBytes) / 100 / MIB) * MIB;
    if (bytes < MIN_MEMORY_BYTES) {
        throw new LimitResolutionError(
            `memoryPercent ${percent} resolves to ${bytes} bytes, below the 64 MiB minimum`,
            { field: 'memoryPercent' },
        );
    }
    return bytes;
}

export function declaredMemoryBytes(value) {
    const match = /^([0-9]+)([bkmgt]?)$/i.exec(String(value ?? ''));
    if (!match) return null;
    const bytes = Number(match[1]) * SIZE_UNITS[match[2].toLowerCase()];
    return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Stored fields override the corresponding declared fields; unspecified
 * stored fields keep declared values. No clamping.
 */
export function resolveEffectiveLimits({ declared = {}, override = null, envelope = null } = {}) {
    const resolved = {
        cpus: null,
        memory: null,
        memoryBytes: null,
        pidsLimit: null,
        provenance: { cpus: null, memory: null, pidsLimit: null },
    };
    if (declared.cpus !== undefined && declared.cpus !== null) {
        resolved.cpus = String(declared.cpus);
        resolved.provenance.cpus = 'declared';
    }
    if (declared.memory !== undefined && declared.memory !== null) {
        resolved.memory = String(declared.memory);
        resolved.memoryBytes = declaredMemoryBytes(declared.memory);
        resolved.provenance.memory = 'declared';
    }
    if (declared.pidsLimit !== undefined && declared.pidsLimit !== null) {
        resolved.pidsLimit = Number(declared.pidsLimit);
        resolved.provenance.pidsLimit = 'declared';
    }
    if (override?.cpus !== undefined) {
        resolved.cpus = String(override.cpus);
        resolved.provenance.cpus = 'settings';
    }
    if (override?.memoryPercent !== undefined) {
        const bytes = resolveMemoryPercent(override.memoryPercent, envelope?.memoryBytes);
        resolved.memory = String(bytes);
        resolved.memoryBytes = bytes;
        resolved.provenance.memory = 'settings';
    }
    return Object.freeze({ ...resolved, provenance: Object.freeze(resolved.provenance) });
}

// The operator override as a runtime-policy layer (the final policy layer).
// CPU must lie within the CURRENT envelope (plan §3 Bounds): a stored value
// above it is refused at admission, never rendered. GPU shares are not part
// of this release (P1), so a stored GPU entry is refused, never ignored (U4).
export function resolveStoredGpuShare(policy, gpu, ref) {
    try {
        if (!gpu?.eligible || !gpu.grant?.agents?.includes(ref) || gpu.grant?.denied?.includes(ref)) throw new MpsError(gpu?.reason || 'This agent has no active, qualified Box GPU grant.');
        return resolveMpsShare(policy, gpu.facts, { grant: gpu.grant, ...(gpu.fsApi ? { fsApi: gpu.fsApi } : {}) });
    } catch (error) {
        throw new LimitResolutionError(error.message, { code: 'gpu_sharing_unavailable', field: 'gpu', status: 409 });
    }
}

export function overridePolicyFromStored(entry, envelope, { gpu = null, ref = 'REPO/AGENT' } = {}) {
    if (!entry) return null;
    if (entry.gpu !== undefined) resolveStoredGpuShare(entry.gpu, gpu, ref);
    const resources = {};
    if (entry.cpus !== undefined) {
        const cpus = Number(entry.cpus);
        if (!Number.isFinite(cpus) || cpus < MIN_CPUS) {
            throw new LimitResolutionError(`cpus ${entry.cpus} is below the ${MIN_CPUS} minimum`, { field: 'cpus' });
        }
        if (!Number.isFinite(Number(envelope?.cpus)) || Number(envelope.cpus) <= 0) {
            throw new LimitResolutionError('the Box CPU envelope is unknown', { code: 'controller_unavailable', field: 'cpus', status: 409 });
        }
        if (cpus > Number(envelope.cpus)) {
            throw new LimitResolutionError(`cpus ${entry.cpus} exceeds the Box CPU envelope of ${envelope.cpus}`, {
                code: 'exceeds_envelope', field: 'cpus',
            });
        }
        resources.cpus = String(entry.cpus);
    }
    if (entry.memoryPercent !== undefined) resources.memory = String(resolveMemoryPercent(entry.memoryPercent, envelope?.memoryBytes));
    return Object.keys(resources).length ? { resources } : null;
}

/** The stored entry's fields as refusal request entries (source: settings). */
export function storedRequestedLimits(entry) {
    const requested = [];
    if (entry?.memoryPercent !== undefined) requested.push({ field: 'memory', value: `${entry.memoryPercent}%`, source: 'settings' });
    if (entry?.cpus !== undefined) requested.push({ field: 'cpus', value: String(entry.cpus), source: 'settings' });
    if (entry?.gpu !== undefined) {
        requested.push({ field: 'gpu', value: `${entry.gpu?.smPercent ?? '?'}/${entry.gpu?.vramPercent ?? '?'} percent`, source: 'settings' });
    }
    return requested;
}

/**
 * Resolve one stored entry for admission: either the override policy or the
 * exact typed problem (reason code, reason, fix and the stored request) that
 * refuses the agent. Deterministic for identical inputs, so a refused record
 * stays current while nothing changed.
 */
export function resolveStoredOverride(entry, envelope, { ref = 'REPO/AGENT', gpu = null } = {}) {
    if (!entry) return Object.freeze({ policy: null, problem: null });
    try {
        return Object.freeze({ policy: overridePolicyFromStored(entry, envelope, { gpu, ref }), gpu: entry.gpu ? resolveStoredGpuShare(entry.gpu, gpu, ref) : null, problem: null });
    } catch (error) {
        if (!(error instanceof LimitResolutionError)) throw error;
        // Every stored field replaces its declared value, so the refusal lists
        // the stored values (never a manifest value the entry overrides).
        const requested = storedRequestedLimits(entry);
        if (error.code === 'gpu_sharing_unavailable' && entry.gpu !== undefined && (gpu?.memoryModel === 'unified' || gpu?.memoryModel === 'unknown')) {
            // Plan §9.3: the exact unified/unknown memory-model refusal.
            return Object.freeze({
                policy: null,
                problem: Object.freeze({
                    reasonCode: 'gpu_sharing_unavailable',
                    reason: unsupportedGpuMemoryModelReason(gpu.name),
                    fix: UNSUPPORTED_GPU_MEMORY_MODEL_FIX,
                    requested,
                }),
            });
        }
        if (error.code === 'gpu_sharing_unavailable') {
            return Object.freeze({
                policy: null,
                problem: Object.freeze({
                    reasonCode: 'gpu_sharing_unavailable',
                    reason: String(error.message).slice(0, 1024),
                    fix: `Clear the GPU share in Settings, or run ploinky limits clear --agent ${ref} on the host `
                        + '(this also clears its CPU/RAM override). CPU/RAM controls remain separately available.',
                    requested,
                }),
            });
        }
        if (error.code === 'controller_unavailable') {
            // An unknown envelope is not an exceeded one.
            return Object.freeze({
                policy: null,
                problem: Object.freeze({
                    reasonCode: 'envelope_unknown',
                    reason: `The Box resource envelope is unknown, so the stored hardware limit cannot be resolved: ${String(error.message).slice(0, 512)}.`,
                    fix: 'On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart; '
                        + `or clear the stored limit in Settings or with ploinky limits clear --agent ${ref} on the host.`,
                    requested,
                }),
            });
        }
        return Object.freeze({
            policy: null,
            problem: Object.freeze({
                reasonCode: 'exceeds_envelope',
                reason: `The stored hardware limit cannot be resolved against this Box: ${String(error.message).slice(0, 512)}.`,
                fix: `Change or clear the stored limit in Settings, or run ploinky limits clear --agent ${ref} on the host.`,
                requested,
            }),
        });
    }
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => {
            out[key] = canonical(value[key]);
            return out;
        }, {});
    }
    return value === undefined ? null : value;
}

/**
 * Canonical hash of the effective rendered resource values, hard-swap pairing
 * and cgroup placement, with explicit nulls. Empty when hardware placement is
 * not applied (gate off, unprepared, unlimited D4 legacy).
 */
export function limitsHash({ resolved, placement, hardSwap = true, gpu = null }) {
    if (!placement) return '';
    const payload = canonical({
        schema: 1,
        cpus: resolved?.cpus ?? null,
        memoryBytes: resolved?.memoryBytes ?? null,
        pidsLimit: resolved?.pidsLimit ?? null,
        hardSwap: resolved?.memoryBytes ? Boolean(hardSwap) : null,
        placement: {
            cgroups: placement.cgroups ?? null,
            cgroupns: placement.cgroupns ?? null,
            cgroupParent: placement.cgroupParent ?? null,
        },
        gpu: gpu ?? null,
    });
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export const AGENT_PLACEMENT = Object.freeze({
    cgroups: 'enabled',
    cgroupns: 'private',
    cgroupParent: AGENTS_CGROUP_PARENT,
});
