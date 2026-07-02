import { validatePolicyShape } from './containerRuntimePolicy.js';
import { detectHardware } from './hardwareDetection.js';
import { loadCatalog } from './llmArchitectureCatalog.js';

const ARCH_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ACCELERATOR_FAMILIES = new Set(['cpu', 'nvidia-cuda', 'amd-rocm', 'vulkan', 'intel-openvino']);
const ALLOWED_PLATFORMS = new Set(['linux/amd64', 'linux/arm64']);

class ArchitectureSelectionError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'ArchitectureSelectionError';
        this.code = 'PLOINKY_LLM_ARCHITECTURE_SELECTION_FAILED';
        Object.assign(this, details);
    }
}

function envOverride(env, name) {
    if (!env || typeof env !== 'object') return null;
    const value = env[name];
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
}

function perAgentImageOverrideName(agentName) {
    const normalized = String(agentName || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return normalized ? `PLOINKY_${normalized}_IMAGE` : null;
}

function findUnsupportedImageOverride(env, agentName) {
    const globalValue = envOverride(env, 'PLOINKY_LLM_AGENT_IMAGE');
    if (globalValue) return { name: 'PLOINKY_LLM_AGENT_IMAGE', value: globalValue };
    const perAgentName = perAgentImageOverrideName(agentName);
    if (!perAgentName) return null;
    const perAgentValue = envOverride(env, perAgentName);
    return perAgentValue ? { name: perAgentName, value: perAgentValue } : null;
}

function rejectUnsupportedImageOverride(env, agentName) {
    const override = findUnsupportedImageOverride(env, agentName);
    if (!override) return;
    throw new ArchitectureSelectionError(
        `${override.name}: raw image override is unsupported for LLM runtime selection; use catalog architecture policy`
    );
}

function probesSatisfied(requiredProbes, probes) {
    if (!Array.isArray(requiredProbes) || requiredProbes.length === 0) return true;
    if (!probes || typeof probes !== 'object') return false;
    return requiredProbes.every((probeName) => Boolean(probes[probeName]?.ok));
}

function runtimeMatches(arch, hardware) {
    const allowed = arch.match?.containerRuntimes;
    if (!Array.isArray(allowed) || allowed.length === 0) return true;
    return Boolean(hardware?.runtime && allowed.includes(hardware.runtime));
}

function platformMatches(architecturePlatform, hardware, forcePlatform) {
    if (forcePlatform) return architecturePlatform === forcePlatform;
    const targets = new Set();
    if (hardware?.ociPlatform) targets.add(hardware.ociPlatform);
    if (hardware?.nodePlatform) targets.add(hardware.nodePlatform);
    if (targets.size === 0) return true;
    return targets.has(architecturePlatform);
}

function parseComputeCapability(value) {
    const match = String(value || '').trim().match(/^([0-9]+)(?:\.([0-9]+))?$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2] || 0)];
}

function compareComputeCapability(actual, minimum) {
    const actualParts = parseComputeCapability(actual);
    const minimumParts = parseComputeCapability(minimum);
    if (!actualParts || !minimumParts) return null;
    if (actualParts[0] !== minimumParts[0]) return actualParts[0] - minimumParts[0];
    return actualParts[1] - minimumParts[1];
}

function hardwareComputeCapability(hardware, family) {
    const details = hardware?.acceleratorDetails?.[family];
    if (typeof details?.computeCapability === 'string') return details.computeCapability;
    if (typeof hardware?.computeCapabilities?.[family] === 'string') return hardware.computeCapabilities[family];
    return null;
}

function candidateCompatibilityReasons(arch, catalog, hardware, options = {}) {
    const reasons = [];
    if (options.forcePlatform && arch.platform !== options.forcePlatform) {
        reasons.push('platform-forced-mismatch');
    }
    if (!platformMatches(arch.platform, hardware, options.forcePlatform)) {
        reasons.push('platform-mismatch');
    }
    if (arch.status !== 'stable' && !options.allowExperimental) {
        reasons.push('experimental-disallowed');
    }
    if (options.forceAcceleratorFamily && arch.accelerator.family !== options.forceAcceleratorFamily) {
        reasons.push('accelerator-family-forced-mismatch');
    }
    if (arch.accelerator.family !== 'cpu' && !hardware?.acceleratorFamilies?.includes(arch.accelerator.family)) {
        reasons.push('accelerator-family-unavailable');
    }
    if (arch.accelerator.minimumComputeCapability !== undefined) {
        const actualCapability = hardwareComputeCapability(hardware, arch.accelerator.family);
        const comparison = compareComputeCapability(actualCapability, arch.accelerator.minimumComputeCapability);
        if (!actualCapability || comparison === null) {
            reasons.push('compute-capability-unknown');
        } else if (comparison < 0) {
            reasons.push('minimum-compute-capability-unmet');
        }
    }
    if (!runtimeMatches(arch, hardware)) {
        reasons.push('container-runtime-mismatch');
    }
    if (!probesSatisfied(arch.match?.requiredProbes, hardware?.probes)) {
        reasons.push('required-probes-unmet');
    }

    const image = catalog.images?.get?.(arch.image);
    if (!image) {
        reasons.push('image-missing');
    } else if (image.platform && image.platform !== arch.platform) {
        reasons.push('image-platform-mismatch');
    }

    if (arch.runtimePolicy?.platform && arch.runtimePolicy.platform !== arch.platform) {
        reasons.push('runtime-policy-platform-mismatch');
    }
    if (arch.runtimePolicy && hardware?.runtime) {
        try {
            validatePolicyShape(arch.runtimePolicy, `architecture '${arch.id}' runtimePolicy`, {
                runtime: hardware.runtime,
            });
        } catch (err) {
            reasons.push(`runtime-policy-invalid:${err.message}`);
        }
    }
    return reasons;
}

function filterCandidates(catalog, hardware, options = {}) {
    const candidates = [];
    const reasons = [];
    for (const [archId, arch] of catalog.architectures) {
        const why = { archId, reasons: candidateCompatibilityReasons(arch, catalog, hardware, options) };
        if (why.reasons.length > 0) {
            reasons.push(why);
            continue;
        }
        candidates.push(arch);
    }
    return { candidates, reasons };
}

function pickPreferredCandidate(candidates) {
    if (candidates.length === 0) return null;
    const ordered = candidates.slice().sort((a, b) => {
        const fallbackA = Number.isInteger(a.fallbackPriority) ? a.fallbackPriority : 500;
        const fallbackB = Number.isInteger(b.fallbackPriority) ? b.fallbackPriority : 500;
        if (fallbackA !== fallbackB) return fallbackA - fallbackB;
        const acceleratorOrder = ['nvidia-cuda', 'amd-rocm', 'intel-openvino', 'vulkan', 'cpu'];
        const idxA = acceleratorOrder.indexOf(a.accelerator.family);
        const idxB = acceleratorOrder.indexOf(b.accelerator.family);
        if (idxA !== idxB) return idxA - idxB;
        return String(a.id).localeCompare(String(b.id));
    });
    return ordered[0];
}

function findCpuFallback(catalog, hardware, options = {}) {
    const preferredPlatform = options.forcePlatform || hardware?.ociPlatform || hardware?.nodePlatform;
    if (catalog.defaultFallback) {
        const explicit = catalog.architectures.get(catalog.defaultFallback);
        if (
            explicit
            && explicit.accelerator.family === 'cpu'
            && (!preferredPlatform || explicit.platform === preferredPlatform)
            && candidateCompatibilityReasons(explicit, catalog, hardware, {
                ...options,
                forceAcceleratorFamily: null,
            }).length === 0
        ) {
            return explicit;
        }
    }
    for (const arch of catalog.architectures.values()) {
        if (
            arch.accelerator.family === 'cpu'
            && (!preferredPlatform || arch.platform === preferredPlatform)
            && candidateCompatibilityReasons(arch, catalog, hardware, {
                ...options,
                forceAcceleratorFamily: null,
            }).length === 0
        ) {
            return arch;
        }
    }
    for (const arch of catalog.architectures.values()) {
        if (
            arch.accelerator.family === 'cpu'
            && candidateCompatibilityReasons(arch, catalog, hardware, {
                ...options,
                forcePlatform: null,
                forceAcceleratorFamily: null,
            }).length === 0
        ) {
            return arch;
        }
    }
    return null;
}

function selectArchitecture(catalog, hardware, options = {}) {
    if (!catalog || !catalog.architectures) {
        throw new ArchitectureSelectionError('catalog: missing architectures');
    }
    const env = options.env || {};
    rejectUnsupportedImageOverride(env, options.agentName);

    const archOverride = envOverride(env, 'PLOINKY_LLM_ARCHITECTURE_ID');
    if (archOverride && !ARCH_ID_RE.test(archOverride)) {
        throw new ArchitectureSelectionError(`PLOINKY_LLM_ARCHITECTURE_ID: invalid value`);
    }

    const forcePlatformRaw = envOverride(env, 'PLOINKY_LLM_FORCE_PLATFORM');
    if (forcePlatformRaw && !ALLOWED_PLATFORMS.has(forcePlatformRaw)) {
        throw new ArchitectureSelectionError(`PLOINKY_LLM_FORCE_PLATFORM: unsupported platform`);
    }

    const forceAcceleratorRaw = envOverride(env, 'PLOINKY_LLM_ACCELERATOR');
    if (forceAcceleratorRaw && !ACCELERATOR_FAMILIES.has(forceAcceleratorRaw)) {
        throw new ArchitectureSelectionError(`PLOINKY_LLM_ACCELERATOR: unsupported family`);
    }

    let chosen = null;
    const explanation = { mode: 'auto', overrides: {} };
    if (archOverride) {
        explanation.mode = 'override-architecture';
        explanation.overrides.architectureId = archOverride;
        const requested = catalog.architectures.get(archOverride);
        if (!requested) {
            throw new ArchitectureSelectionError(`architecture id '${archOverride}' not found in catalog '${catalog.catalogId}'`);
        }
        const overrideReasons = candidateCompatibilityReasons(requested, catalog, hardware, {
            allowExperimental: Boolean(options.allowExperimental),
            forcePlatform: forcePlatformRaw,
            forceAcceleratorFamily: forceAcceleratorRaw,
        });
        if (overrideReasons.length > 0) {
            throw new ArchitectureSelectionError(
                `architecture id '${archOverride}' is not compatible with this runtime: ${overrideReasons.join(', ')}`,
                { archId: archOverride, reasons: overrideReasons }
            );
        }
        chosen = requested;
    } else {
        const filterResult = filterCandidates(catalog, hardware, {
            allowExperimental: Boolean(options.allowExperimental),
            forcePlatform: forcePlatformRaw,
            forceAcceleratorFamily: forceAcceleratorRaw,
        });
        explanation.filterRejections = filterResult.reasons;
        chosen = pickPreferredCandidate(filterResult.candidates);
        if (!chosen) {
            const fallback = findCpuFallback(catalog, hardware, {
                allowExperimental: Boolean(options.allowExperimental),
                forcePlatform: forcePlatformRaw,
            });
            if (!fallback) {
                throw new ArchitectureSelectionError(
                    `no compatible architecture and no CPU fallback in catalog '${catalog.catalogId}'`
                );
            }
            explanation.mode = 'cpu-fallback';
            chosen = fallback;
        }
    }

    const image = catalog.images.get(chosen.image);
    if (!image) {
        throw new ArchitectureSelectionError(`architecture '${chosen.id}' references unknown image '${chosen.image}'`);
    }
    const imageRef = String(image.ref || '').trim();
    const imageDigest = image.digest || null;
    const imageSource = 'catalog';
    if (!imageRef || imageRef.includes('${')) {
        throw new ArchitectureSelectionError(
            `image '${image.id}' ref must be a literal image reference`
        );
    }

    return {
        architectureId: chosen.id,
        catalogId: catalog.catalogId,
        catalogRef: catalog.catalogRef,
        catalogSource: catalog.source || null,
        catalogRepoUrl: catalog.repoUrl || null,
        catalogRequestedRef: catalog.requestedRef || null,
        platform: chosen.platform,
        acceleratorFamily: chosen.accelerator.family,
        imageRef,
        imageDigest,
        imageSource,
        imageId: image.id,
        runtimePolicy: chosen.runtimePolicy || null,
        engineDefaults: chosen.engineDefaults || null,
        explanation,
    };
}

async function selectLlmArchitecture(options = {}) {
    const env = options.env || process.env;
    rejectUnsupportedImageOverride(env, options.agentName);
    const catalog = options.catalog || loadCatalog({ env });
    const hardware = options.hardware || detectHardware({ runtime: options.runtime, env });
    const selectorEnv = options.requestedArchitectureId
        ? { ...env, PLOINKY_LLM_ARCHITECTURE_ID: options.requestedArchitectureId }
        : env;
    return selectArchitecture(catalog, hardware, {
        ...options,
        env: selectorEnv,
    });
}

export {
    ArchitectureSelectionError,
    candidateCompatibilityReasons,
    filterCandidates,
    findCpuFallback,
    pickPreferredCandidate,
    selectArchitecture,
    selectLlmArchitecture,
};
