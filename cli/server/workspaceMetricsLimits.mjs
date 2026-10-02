const MPS_VARIABLES = new Set(['CUDA_MPS_PIPE_DIRECTORY', 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT']);

export function parseMetricBytes(value) {
    const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)?$/i);
    if (!match) return null;
    const factors = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4 };
    const bytes = Number(match[1]) * factors[(match[2] || 'b').toLowerCase()];
    return Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : null;
}

export function parseMemoryUsage(value) {
    const parts = String(value ?? '').split('/');
    return { memoryBytes: parseMetricBytes(parts[0]), memoryLimitBytes: parts.length === 2 ? parseMetricBytes(parts[1]) : null };
}

export function projectAppliedLimits(inspected, verified = null, identity = null) {
    // Inspection is supplemental; kernel assurance requires the independent
    // exact-runtime leaf/namespace readback recorded by lifecycle admission.
    const env = {};
    for (const entry of inspected?.Config?.Env || []) {
        const split = typeof entry === 'string' ? entry.indexOf('=') : -1;
        if (split > 0 && MPS_VARIABLES.has(entry.slice(0, split))) env[entry.slice(0, split)] = entry.slice(split + 1);
    }
    const labels = inspected?.Config?.Labels || inspected?.Labels || {};
    const id = String(inspected?.Id || inspected?.ID || '');
    const valid = Boolean(verified && verified.containerId === id && verified.limitsHash === labels['ploinky.limitshash']
        && (!identity || (verified.instanceId === identity.instanceId && verified.enableGeneration === identity.generation)));
    if (!labels['ploinky.limitshash'] && !labels['ploinky.mpsgeneration']) return null;
    const cores = valid ? verified.cpus ?? null : null;
    const bytes = valid ? verified.memoryBytes ?? null : null;
    const sm = /^\d{1,3}$/.test(env.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE || '') ? Number(env.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE) : null;
    const vram = /^0=(\d+)M$/.exec(env.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT || '');
    const gpuValid = sm >= 1 && sm <= 100 && vram && Number.isSafeInteger(Number(vram[1]) * 1024 ** 2);
    return {
        cpu: { cores, assurance: cores !== null ? 'kernel' : 'none' },
        memory: { bytes, assurance: bytes !== null ? 'kernel' : 'none' },
        gpu: { smPercent: gpuValid ? sm : null, vramBytes: gpuValid ? Number(vram[1]) * 1024 ** 2 : null, assurance: gpuValid ? 'best-effort' : 'none' },
    };
}

export function limitsUsage(metrics, limits) {
    return {
        ...metrics,
        ...(limits?.cpu?.cores > 0 ? { cpuLimitPercent: limits.cpu.cores * 100, cpuLimitUsagePercent: metrics.cpuPercent / limits.cpu.cores } : {}),
        ...(limits?.memory?.bytes > 0 ? { memoryLimitBytes: limits.memory.bytes, memoryLimitUsagePercent: 100 * metrics.memoryBytes / limits.memory.bytes } : {}),
    };
}

export class AppliedLimitsCache {
    constructor({ inspect, readVerified = () => null } = {}) {
        this.inspect = inspect;
        this.readVerified = readVerified;
        this.key = '';
        this.values = new Map();
        this.inspections = new Map();
    }

    async reconcile(entries) {
        const identities = entries.filter((entry) => entry.state?.running && !['bwrap', 'seatbelt'].includes(entry.runtime))
            .map((entry) => ({ key: entry.containerName, id: String(entry.state?.containerId || entry.containerId || ''), registryId: entry.registryContainerId, instanceId: String(entry.instanceId || ''), generation: String(entry.enableGeneration || '') }))
            .sort((a, b) => a.key.localeCompare(b.key));
        const key = JSON.stringify(identities);
        if (key !== this.key) {
            const inspections = new Map();
            for (const identity of identities) {
                try {
                    const inspected = await this.inspect(identity.id || identity.key);
                    const id = String(inspected?.Id || inspected?.ID || '');
                    if (!id || (identity.id && id !== identity.id)) continue;
                    const labels = inspected?.Config?.Labels || inspected?.Labels || {};
                    inspections.set(identity.key, {
                        Id: id,
                        Config: {
                            Labels: { 'ploinky.limitshash': labels['ploinky.limitshash'], 'ploinky.mpsgeneration': labels['ploinky.mpsgeneration'] },
                            Env: (inspected?.Config?.Env || []).filter((entry) => typeof entry === 'string' && MPS_VARIABLES.has(entry.split('=', 1)[0])).slice(0, 3),
                        },
                    });
                } catch (_) {}
            }
            this.inspections = inspections;
            this.key = key;
        }
        const next = new Map();
        for (const identity of identities) {
            const inspected = this.inspections.get(identity.key);
            if (!inspected) continue;
            const proof = identity.registryId !== undefined && identity.registryId !== inspected.Id ? null : this.readVerified(identity.key, inspected.Id);
            const limits = projectAppliedLimits(inspected, proof, identity);
            if (limits) next.set(identity.key, limits);
        }
        this.values = next;
    }
}
