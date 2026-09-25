// Child-process driver for the dependency store runtime-wiring tests (not a
// test file). Usage: node dependencyStoreWiringDriver.mjs <config.json>
// Runs lifecycle steps through production entry points against a temporary
// workspace and the fake engine on PATH, then writes a JSON transcript.
// `config.refresh` wraps every step in one lifecycle command's dependency
// refresh scope (as `start`/`reinstall` do in production).

import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = process.env.PLOINKY_WORKSPACE_ROOT;
const results = [];
let preparedLease = null;
const agentsFile = () => path.join(root, '.ploinky', 'agents.json');
const readAgents = () => JSON.parse(fs.readFileSync(agentsFile(), 'utf8') || '{}');
const summary = (value) => value && ({
    containerName: value.containerName,
    containerId: value.containerId || null,
    createdByThisLaunch: value.createdByThisLaunch,
    requiresEdgeActivation: value.requiresEdgeActivation === true,
    dependencies: value.registryRecord?.dependencies || null,
    runtime: value.registryRecord?.runtime || null,
    pid: value.registryRecord?.pid || null,
    instanceId: value.registryRecord?.instanceId || null,
    enableGeneration: value.registryRecord?.enableGeneration || null,
    stored: (() => {
        try { return readAgents()[value.containerName]?.dependencies || null; } catch { return null; }
    })(),
});

async function runStep(step) {
    const agentPath = path.join(root, '.ploinky', 'repos', 'repo', step.agent || 'demo');
    const manifest = JSON.parse(fs.readFileSync(path.join(agentPath, 'manifest.json'), 'utf8'));
    if (step.action === 'init-edge') {
        const { initializeFreshEdgeRoutingSources } = await import('../../cli/sandbox/edgeGeneration.js');
        initializeFreshEdgeRoutingSources({ workspaceRoot: root });
        return { ok: true };
    }
    if (step.action === 'register') {
        const agents = readAgents();
        agents[step.containerName] = step.record;
        fs.writeFileSync(agentsFile(), JSON.stringify(agents, null, 2));
        const routingFile = path.join(root, '.ploinky', 'routing.json');
        const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8') || '{}');
        routing.routes = routing.routes || {};
        routing.routes[step.record.alias || step.record.agentName] = {
            container: step.containerName, hostPath: agentPath, repo: step.record.repoName, agent: step.record.agentName,
            ...(step.record.alias ? { alias: step.record.alias } : {}),
        };
        fs.writeFileSync(routingFile, JSON.stringify(routing, null, 2));
        return { ok: true };
    }
    if (step.action === 'set-router-port') {
        // The persisted Router port an initial workspace start records.
        const routingFile = path.join(root, '.ploinky', 'routing.json');
        const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8') || '{}');
        fs.writeFileSync(routingFile, JSON.stringify({ ...routing, port: step.port }, null, 2));
        return { ok: true };
    }
    if (step.action === 'prepare-lease') {
        const edge = await import('../../cli/sandbox/edgeGeneration.js');
        const prepared = edge.withEdgeGenerationApplyLock((applyLockCapability) => {
            edge.inactivateEdgeRoutingGeneration('dependency-store-wiring:source-stage', { applyLockCapability });
            return edge.prepareEdgeRoutingGeneration({ reason: 'dependency-store-wiring', applyLockCapability });
        });
        preparedLease = prepared.preparationLease;
        return { ok: Boolean(preparedLease), mode: preparedLease?.mode || null };
    }
    if (step.action === 'enable-sandbox') {
        const { setHostSandboxDisabled } = await import('../../cli/utils/runtime/sandboxRuntime.js');
        setHostSandboxDisabled(false);
        return { ok: true };
    }
    if (step.action === 'issue-rebuild') {
        // Exactly what reinstall does first: a desired rebuild request under
        // the held workspace lease, bound to this command's refresh scope.
        const { withWorkspaceMutationLease } = await import('../../cli/utils/runtime/maintenanceLocks.js');
        const { issueDependencyRebuildRequest } = await import('../../cli/utils/dependencies/store/runtimeDependencies.mjs');
        return withWorkspaceMutationLease({ operation: 'reinstall' }, (lease) => issueDependencyRebuildRequest(step.containerName, { lease }));
    }
    if (step.action === 'read-rebuild-state') {
        const { runtimeDependencyStore, registrationIdFor } = await import('../../cli/utils/dependencies/store/runtimeDependencies.mjs');
        return runtimeDependencyStore().readRebuildState(registrationIdFor(step.containerName));
    }
    if (step.action === 'validate-object') {
        const { runtimeDependencyStore } = await import('../../cli/utils/dependencies/store/runtimeDependencies.mjs');
        const validation = runtimeDependencyStore().validateObject(step.objectId, { inputKey: step.inputKey });
        return { valid: validation.valid, reason: validation.reason || null, generationId: validation.generationId || null };
    }
    if (step.action === 'ensure' || step.action === 'ensure-with-lease') {
        const { ensureAgentService } = await import('../../cli/sandbox/docker/agentServiceManager.js');
        const run = async () => {
            const record = readAgents()[step.containerName] || {};
            let routerEndpoint = null;
            if (step.hostRouter) {
                const { buildRouterEndpoint } = await import('../../cli/sandbox/routerPort.js');
                routerEndpoint = buildRouterEndpoint('host', 8080);
            }
            const result = await ensureAgentService(step.agent || 'demo', manifest, agentPath, {
                containerName: step.containerName,
                routerEndpoint,
                ...(step.startPath ? {
                    instanceId: record.instanceId,
                    enableGeneration: record.enableGeneration,
                    preservePreparedRegistryRecord: step.preserve !== false,
                    preparationLease: preparedLease,
                } : {}),
                ...(step.options || {}),
            });
            if (step.startPath && !result?.requiresEdgeActivation && preparedLease) {
                const { mergeRoutingConfig } = await import('../../cli/server/routingFile.js');
                await mergeRoutingConfig((current) => current, {
                    reason: 'dependency-store-wiring-graph-ready',
                    preparationLease: preparedLease,
                });
                preparedLease = null;
            }
            if (step.activate && result?.requiresEdgeActivation) {
                const { activatePreparedRuntimeAfterReadiness } = await import('../../cli/commands/workspaceUtil.js');
                await activatePreparedRuntimeAfterReadiness({
                    result,
                    routeKey: step.routeKey || step.agent || 'demo',
                    repoName: 'repo',
                    shortAgentName: step.agent || 'demo',
                    agentPath,
                });
            }
            return result;
        };
        if (step.action === 'ensure-with-lease') {
            const { withWorkspaceMutationLease } = await import('../../cli/utils/runtime/maintenanceLocks.js');
            return summary(await withWorkspaceMutationLease({ operation: 'workspace-start' }, run));
        }
        return summary(await run());
    }
    if (step.action === 'bwrap-ensure') {
        // The production bwrap entry point, called the way workspace start
        // calls a host-network sandbox: inside a prepared inactive generation
        // with its exact host-mode capability, then the graph commit. (The
        // driver process runs under dependencyStoreBwrapHostShim.mjs.)
        const { ensureBwrapService } = await import('../../cli/sandbox/bwrap/bwrapServiceManager.js');
        const { withWorkspaceMutationLease } = await import('../../cli/utils/runtime/maintenanceLocks.js');
        const edge = await import('../../cli/sandbox/edgeGeneration.js');
        const { deriveAgentPrincipalId } = await import('../../cli/utils/security/agentIdentity.js');
        const { buildRouterEndpoint } = await import('../../cli/sandbox/routerPort.js');
        const { mergeRoutingConfig } = await import('../../cli/server/routingFile.js');
        const record = readAgents()[step.containerName] || {};
        return summary(await withWorkspaceMutationLease({ operation: 'workspace-start' }, async () => {
            const prepared = edge.withEdgeGenerationApplyLock((applyLockCapability) => {
                edge.inactivateEdgeRoutingGeneration('dependency-store-wiring:bwrap', { applyLockCapability });
                return edge.prepareEdgeRoutingGeneration({ reason: 'dependency-store-wiring', applyLockCapability });
            });
            const preparedHostModeCapability = edge.prepareHostModeCapabilityForInactiveGeneration({
                agentId: deriveAgentPrincipalId('repo', step.agent || 'demo'),
                instanceId: record.instanceId,
                enableGeneration: record.enableGeneration,
                routeKey: record.alias || step.agent || 'demo',
                containerName: step.containerName,
            }, { preparationLease: prepared.preparationLease });
            const result = ensureBwrapService(step.agent || 'demo', manifest, agentPath, {
                containerName: step.containerName,
                routerEndpoint: buildRouterEndpoint('host', 8080),
                instanceId: record.instanceId,
                enableGeneration: record.enableGeneration,
                preservePreparedRegistryRecord: true,
                preparedHostModeCapability,
                ...(step.options || {}),
            });
            // As workspace start does: the runtime's exact registry record is
            // committed with the prepared graph generation.
            await mergeRoutingConfig((current) => {
                const agents = readAgents();
                agents[step.containerName] = result.registryRecord;
                fs.writeFileSync(agentsFile(), JSON.stringify(agents, null, 2));
                return current;
            }, {
                reason: 'dependency-store-wiring-graph-ready',
                preparationLease: prepared.preparationLease,
            });
            return result;
        }));
    }
    if (step.action === 'seatbelt-link') {
        // The production shared-link guard with only the caller's exclusion:
        // liveness, registry and receipts all use their production defaults.
        const { ensureSeatbeltCodeNodeModules } = await import('../../cli/sandbox/seatbelt/seatbeltServiceManager.js');
        return { link: ensureSeatbeltCodeNodeModules(step.agent || 'demo', path.join(agentPath, 'code'), step.nodeModulesPath, { excludeContainer: step.containerName }) };
    }
    throw new Error(`unknown step ${step.action}`);
}

async function main() {
    for (const step of config.steps) {
        try {
            results.push({ step: step.label || step.action, ok: true, value: await runStep(step) });
        } catch (error) {
            results.push({ step: step.label || step.action, ok: false, code: error?.code || null, causeCode: error?.cause?.code || null, message: String(error?.message || error) });
            if (!step.allowFailure) break;
        }
    }
}

if (config.refresh) {
    const { withDependencyRefresh } = await import('../../cli/utils/dependencies/dependencyRefresh.mjs');
    await withDependencyRefresh(config.refresh, main);
} else {
    await main();
}
fs.writeFileSync(config.out, JSON.stringify(results, null, 2));
