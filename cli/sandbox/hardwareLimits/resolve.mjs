// Visible hardware envelope, exact limit resolution and the limits hash
// (plan §3 defaults, §8.1, §8.3). Pure functions over bounded observations.

import crypto from 'node:crypto';

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
export function overridePolicyFromStored(entry, envelope) {
    if (!entry) return null;
    const resources = {};
    if (entry.cpus !== undefined) resources.cpus = String(entry.cpus);
    if (entry.memoryPercent !== undefined) resources.memory = String(resolveMemoryPercent(entry.memoryPercent, envelope?.memoryBytes));
    return Object.keys(resources).length ? { resources } : null;
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
