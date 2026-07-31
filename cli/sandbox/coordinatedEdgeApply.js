import {
    applyEdgeDesiredStateFile as applyEdgeDesiredStateFileRaw,
    applyEdgeRoutingGeneration as applyEdgeRoutingGenerationRaw,
} from './edgeGeneration.js';
import {
    isGenerationCapabilityRuntimeEffective,
    restartGenerationCapabilityRuntime,
} from './docker/agentServiceManager.js';
import { withNetworkLifecycleLock } from './networkLifecycle.js';

function coordinatedOptions(options, networkLifecycleCapability) {
    return {
        ...options,
        networkLifecycleCapability,
        isCapabilityRuntimeEffective: options.isCapabilityRuntimeEffective
            || isGenerationCapabilityRuntimeEffective,
        restartCapabilityRuntime: options.restartCapabilityRuntime || restartGenerationCapabilityRuntime,
    };
}

export function applyEdgeRoutingGeneration(options = {}) {
    return withNetworkLifecycleLock(
        (networkLifecycleCapability) => applyEdgeRoutingGenerationRaw(
            coordinatedOptions(options, networkLifecycleCapability),
        ),
        options.networkLifecycleCapability === undefined
            ? {}
            : { capability: options.networkLifecycleCapability },
    );
}

export function applyEdgeDesiredStateFile(candidateFile, options = {}) {
    return withNetworkLifecycleLock(
        (networkLifecycleCapability) => applyEdgeDesiredStateFileRaw(
            candidateFile,
            coordinatedOptions(options, networkLifecycleCapability),
        ),
        options.networkLifecycleCapability === undefined
            ? {}
            : { capability: options.networkLifecycleCapability },
    );
}

export default applyEdgeRoutingGeneration;
