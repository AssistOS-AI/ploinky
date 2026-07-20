import { assertRouteKeyAvailable } from './reservedRouteKeys.js';
import fs from 'node:fs';
import path from 'node:path';

function readManifestRouting(agentPath) {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(agentPath, 'manifest.json'), 'utf8'));
        let mcpConfig = null;
        try {
            mcpConfig = JSON.parse(fs.readFileSync(path.join(agentPath, 'mcp-config.json'), 'utf8'));
        } catch (_) {}
        return {
            manifest,
            ...(mcpConfig ? { mcpConfig } : {}),
            ...(manifest.httpServices ? { httpServices: manifest.httpServices } : {}),
            ...(manifest.routerAccess ? { routerAccess: manifest.routerAccess } : {}),
        };
    } catch (_) {
        return {};
    }
}

export function buildRuntimeRoute(routeKey, runtimeService, {
    agentPath,
    repoName,
    agentName,
    alias,
    auth,
} = {}) {
    assertRouteKeyAvailable(routeKey, { label: 'Agent route key' });
    if (!runtimeService?.containerName || !runtimeService?.effectiveInstanceId || !runtimeService?.enableGeneration) {
        throw new Error(`runtimeRoute: incomplete runtime service for '${routeKey}'`);
    }
    return {
        container: runtimeService.containerName,
        hostPath: agentPath,
        repo: repoName,
        agent: agentName,
        ...(alias ? { alias } : {}),
        auth: auth && typeof auth === 'object' ? { ...auth } : { mode: 'none' },
        runtime: runtimeService.runtime,
        ...(runtimeService.containerId ? { containerId: runtimeService.containerId } : {}),
        networkMode: runtimeService.networkMode,
        targetAgentId: runtimeService.targetAgentId,
        effectiveInstanceId: runtimeService.effectiveInstanceId,
        enableGeneration: runtimeService.enableGeneration,
        relay: runtimeService.relay,
        primaryService: runtimeService.primaryService,
        deniedPorts: [],
        ...readManifestRouting(agentPath),
    };
}

export default buildRuntimeRoute;
