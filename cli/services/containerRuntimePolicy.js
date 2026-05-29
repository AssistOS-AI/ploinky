import crypto from 'crypto';

const ALLOWED_PLATFORMS = new Set(['linux/amd64', 'linux/arm64']);
const ALLOWED_DEVICE_TYPES = new Set(['cdi', 'hostDevice']);
const ALLOWED_HOST_DEVICE_PREFIXES = ['/dev/kfd', '/dev/dri', '/dev/accel'];
const ALLOWED_SECURITY_OPT = new Set(['label=disable']);
const ALLOWED_IPC = new Set(['default', 'host']);
const ALLOWED_GPUS_RE = /^all$|^device=[A-Za-z0-9._,-]+$/;
const ALLOWED_CDI_RE = /^[A-Za-z0-9._/-]+=([A-Za-z0-9._,-]+|all)$/;
const SIZE_RE = /^[0-9]+[bkmgtBKMGT]?$/;
const CPU_RE = /^[0-9]+(\.[0-9]+)?$/;
const MAX_PIDS_LIMIT = 1048576;

class RuntimePolicyError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'RuntimePolicyError';
        this.code = 'PLOINKY_LLM_RUNTIME_POLICY_INVALID';
        Object.assign(this, details);
    }
}

function ensurePlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RuntimePolicyError(`${label}: expected object`);
    }
}

function rejectUnknownKeys(value, allowed, label) {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new RuntimePolicyError(`${label}: unknown field '${key}'`);
        }
    }
}

function rejectRawArgs(value, label) {
    if (!value || typeof value !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(value, 'rawArgs')) {
        throw new RuntimePolicyError(`${label}: rawArgs is not permitted`);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'privileged')) {
        throw new RuntimePolicyError(`${label}: implicit privileged is not permitted`);
    }
}

function rejectHostMountFields(value, label) {
    if (!value || typeof value !== 'object') return;
    for (const banned of ['volumes', 'mounts', 'binds', 'hostMounts']) {
        if (Object.prototype.hasOwnProperty.call(value, banned)) {
            throw new RuntimePolicyError(`${label}: '${banned}' is not permitted inside runtime policy; use manifest volumes under .ploinky/`);
        }
    }
}

function validateResources(resources, label) {
    if (resources === undefined) return null;
    ensurePlainObject(resources, label);
    rejectUnknownKeys(resources, new Set([
        'memory', 'cpus', 'pidsLimit', 'shmSize', 'ulimits',
    ]), label);
    if (resources.memory !== undefined && !SIZE_RE.test(String(resources.memory))) {
        throw new RuntimePolicyError(`${label}.memory: invalid size value`);
    }
    if (resources.cpus !== undefined && !CPU_RE.test(String(resources.cpus))) {
        throw new RuntimePolicyError(`${label}.cpus: invalid CPU value`);
    }
    if (resources.shmSize !== undefined && !SIZE_RE.test(String(resources.shmSize))) {
        throw new RuntimePolicyError(`${label}.shmSize: invalid size value`);
    }
    if (resources.pidsLimit !== undefined) {
        if (!Number.isInteger(resources.pidsLimit) || resources.pidsLimit < 1 || resources.pidsLimit > MAX_PIDS_LIMIT) {
            throw new RuntimePolicyError(`${label}.pidsLimit: invalid value`);
        }
    }
    if (resources.ulimits !== undefined) {
        ensurePlainObject(resources.ulimits, `${label}.ulimits`);
        rejectUnknownKeys(resources.ulimits, new Set(['memlock']), `${label}.ulimits`);
        if (resources.ulimits.memlock !== undefined) {
            ensurePlainObject(resources.ulimits.memlock, `${label}.ulimits.memlock`);
            rejectUnknownKeys(resources.ulimits.memlock, new Set(['soft', 'hard']), `${label}.ulimits.memlock`);
            const { soft, hard } = resources.ulimits.memlock;
            if (!Number.isInteger(soft) || soft < -1) {
                throw new RuntimePolicyError(`${label}.ulimits.memlock.soft: invalid`);
            }
            if (!Number.isInteger(hard) || hard < -1) {
                throw new RuntimePolicyError(`${label}.ulimits.memlock.hard: invalid`);
            }
        }
    }
    return resources;
}

function validateDevices(devices, label, options = {}) {
    if (devices === undefined) return [];
    if (!Array.isArray(devices)) {
        throw new RuntimePolicyError(`${label}: expected array`);
    }
    const validated = [];
    for (const [idx, device] of devices.entries()) {
        const itemLabel = `${label}[${idx}]`;
        ensurePlainObject(device, itemLabel);
        rejectUnknownKeys(device, new Set(['type', 'value', 'hostPath']), itemLabel);
        if (!ALLOWED_DEVICE_TYPES.has(device.type)) {
            throw new RuntimePolicyError(`${itemLabel}.type: must be cdi|hostDevice`);
        }
        if (device.type === 'cdi') {
            if (typeof device.value !== 'string' || !ALLOWED_CDI_RE.test(device.value)) {
                throw new RuntimePolicyError(`${itemLabel}.value: invalid CDI device id`);
            }
            if (options.runtime === 'docker' && !options.allowDockerCdi) {
                throw new RuntimePolicyError(`${itemLabel}: CDI devices are only supported on podman`);
            }
        }
        if (device.type === 'hostDevice') {
            const hostPath = String(device.hostPath || '');
            if (!hostPath.startsWith('/dev/')) {
                throw new RuntimePolicyError(`${itemLabel}.hostPath: must start with /dev/`);
            }
            const ok = ALLOWED_HOST_DEVICE_PREFIXES.some((prefix) => hostPath === prefix || hostPath.startsWith(`${prefix}/`));
            if (!ok) {
                throw new RuntimePolicyError(`${itemLabel}.hostPath: host device '${hostPath}' is not in the allowlist (${ALLOWED_HOST_DEVICE_PREFIXES.join(', ')})`);
            }
        }
        validated.push(device);
    }
    return validated;
}

function validateSecurityOpt(securityOpt, label) {
    if (securityOpt === undefined) return [];
    if (!Array.isArray(securityOpt)) {
        throw new RuntimePolicyError(`${label}: expected array`);
    }
    for (const entry of securityOpt) {
        if (!ALLOWED_SECURITY_OPT.has(entry)) {
            throw new RuntimePolicyError(`${label}: '${entry}' is not in the allowlist`);
        }
    }
    return Array.from(new Set(securityOpt));
}

function validateGpus(gpus, label, options = {}) {
    if (gpus === undefined) return null;
    if (typeof gpus !== 'string' || !ALLOWED_GPUS_RE.test(gpus)) {
        throw new RuntimePolicyError(`${label}: invalid value (expected 'all' or 'device=<list>')`);
    }
    if (options.runtime === 'podman' && !options.allowPodmanGpusFlag) {
        throw new RuntimePolicyError(`${label}: podman does not support --gpus; use a CDI device entry instead`);
    }
    return gpus;
}

function validatePolicyShape(policy, label, options = {}) {
    if (policy === undefined || policy === null) return null;
    ensurePlainObject(policy, label);
    rejectRawArgs(policy, label);
    rejectHostMountFields(policy, label);
    rejectUnknownKeys(policy, new Set([
        'platform', 'resources', 'devices', 'securityOpt', 'ipc', 'gpus',
    ]), label);

    const normalized = {};
    if (policy.platform !== undefined) {
        if (!ALLOWED_PLATFORMS.has(policy.platform)) {
            throw new RuntimePolicyError(`${label}.platform: unsupported`);
        }
        normalized.platform = policy.platform;
    }
    const resources = validateResources(policy.resources, `${label}.resources`);
    if (resources) normalized.resources = resources;
    const devices = validateDevices(policy.devices, `${label}.devices`, options);
    if (devices.length) normalized.devices = devices;
    const secOpt = validateSecurityOpt(policy.securityOpt, `${label}.securityOpt`);
    if (secOpt.length) normalized.securityOpt = secOpt;
    if (policy.ipc !== undefined) {
        if (!ALLOWED_IPC.has(policy.ipc)) {
            throw new RuntimePolicyError(`${label}.ipc: unsupported`);
        }
        normalized.ipc = policy.ipc;
    }
    const gpus = validateGpus(policy.gpus, `${label}.gpus`, options);
    if (gpus) normalized.gpus = gpus;
    return normalized;
}

function policyDefaults() {
    return {
        ipc: 'default',
    };
}

function mergePolicy(base, overlay) {
    if (!overlay) return base ? { ...base } : {};
    const out = { ...(base || {}) };
    for (const key of Object.keys(overlay)) {
        if (overlay[key] === undefined) continue;
        if (key === 'resources') {
            out.resources = { ...(out.resources || {}), ...overlay.resources };
            if (overlay.resources?.ulimits) {
                out.resources.ulimits = { ...(out.resources?.ulimits || {}), ...overlay.resources.ulimits };
            }
        } else if (key === 'devices') {
            out.devices = Array.isArray(overlay.devices) ? overlay.devices.slice() : (out.devices || []);
        } else if (key === 'securityOpt') {
            out.securityOpt = Array.isArray(overlay.securityOpt) ? overlay.securityOpt.slice() : (out.securityOpt || []);
        } else {
            out[key] = overlay[key];
        }
    }
    return out;
}

function buildEffectivePolicy(sources, options = {}) {
    const layers = [
        policyDefaults(),
        validatePolicyShape(sources.manifestPolicy || null, 'manifest.llmRuntime.runtimePolicy', options),
        validatePolicyShape(sources.catalogPolicy || null, 'catalog.runtimePolicy', options),
        validatePolicyShape(sources.profilePolicy || null, 'profile.llmRuntime.runtimePolicy', options),
        validatePolicyShape(sources.overridePolicy || null, 'overrides.runtimePolicy', options),
    ];
    let merged = {};
    for (const layer of layers) {
        if (!layer) continue;
        merged = mergePolicy(merged, layer);
    }
    return validatePolicyShape(merged, 'effective.runtimePolicy', options) || {};
}

function ulimitArgValue(memlock) {
    if (!memlock) return null;
    return `memlock=${memlock.soft}:${memlock.hard}`;
}

function emitRunArgs(policy, options = {}) {
    if (!policy) return [];
    const runtime = options.runtime;
    if (runtime !== 'docker' && runtime !== 'podman') {
        throw new RuntimePolicyError('emitRunArgs: runtime must be docker or podman');
    }
    const args = [];
    if (policy.platform) {
        args.push('--platform', policy.platform);
    }
    const res = policy.resources || {};
    if (res.memory) {
        args.push('--memory', String(res.memory));
    }
    if (res.cpus) {
        args.push('--cpus', String(res.cpus));
    }
    if (res.pidsLimit) {
        args.push('--pids-limit', String(res.pidsLimit));
    }
    if (res.shmSize) {
        args.push('--shm-size', String(res.shmSize));
    }
    if (res.ulimits?.memlock) {
        const memlock = ulimitArgValue(res.ulimits.memlock);
        if (memlock) args.push('--ulimit', memlock);
    }
    if (Array.isArray(policy.devices)) {
        for (const dev of policy.devices) {
            if (dev.type === 'cdi') {
                args.push('--device', dev.value);
            } else if (dev.type === 'hostDevice') {
                args.push('--device', dev.hostPath);
            }
        }
    }
    if (Array.isArray(policy.securityOpt)) {
        for (const opt of policy.securityOpt) {
            args.push('--security-opt', opt);
        }
    }
    if (policy.ipc && policy.ipc !== 'default') {
        args.push('--ipc', policy.ipc);
    }
    if (policy.gpus) {
        if (runtime === 'docker') {
            args.push('--gpus', policy.gpus);
        }
    }
    return args;
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((acc, key) => {
            acc[key] = canonicalize(value[key]);
            return acc;
        }, {});
    }
    return value;
}

function computeRuntimePolicyHash(policy) {
    if (!policy || typeof policy !== 'object') return '';
    try {
        const canonical = canonicalize(policy);
        const json = JSON.stringify(canonical);
        return crypto.createHash('sha256').update(json).digest('hex');
    } catch (_) {
        return '';
    }
}

export {
    ALLOWED_HOST_DEVICE_PREFIXES,
    RuntimePolicyError,
    buildEffectivePolicy,
    canonicalize,
    computeRuntimePolicyHash,
    emitRunArgs,
    mergePolicy,
    policyDefaults,
    validatePolicyShape,
};
