import {
    applyEdgeDesiredStateFile as applyEdgeDesiredStateFileRaw,
    applyEdgeRoutingGeneration as applyEdgeRoutingGenerationRaw,
} from './edgeGeneration.js';
import {
    isGenerationCapabilityRuntimeEffective,
    restartGenerationCapabilityRuntime,
} from './docker/agentServiceManager.js';

export function applyEdgeRoutingGeneration(options = {}) {
    return applyEdgeRoutingGenerationRaw({
        ...options,
        isCapabilityRuntimeEffective: options.isCapabilityRuntimeEffective
            || isGenerationCapabilityRuntimeEffective,
        restartCapabilityRuntime: options.restartCapabilityRuntime || restartGenerationCapabilityRuntime,
    });
}

export function applyEdgeDesiredStateFile(candidateFile, options = {}) {
    return applyEdgeDesiredStateFileRaw(candidateFile, {
        ...options,
        isCapabilityRuntimeEffective: options.isCapabilityRuntimeEffective
            || isGenerationCapabilityRuntimeEffective,
        restartCapabilityRuntime: options.restartCapabilityRuntime || restartGenerationCapabilityRuntime,
    });
}

export default applyEdgeRoutingGeneration;
