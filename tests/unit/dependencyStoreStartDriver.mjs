// Child-process driver for behavioral start-path tests (not a test file).
// Usage: node dependencyStoreStartDriver.mjs <config.json>
// Runs lifecycle steps against a temporary workspace and a fake engine, then
// writes a JSON transcript of every step result.

import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = process.env.PLOINKY_WORKSPACE_ROOT;
const results = [];
let preparedLease = null;
const summary = (value) => value && ({
    containerName: value.containerName,
    containerId: value.containerId || null,
    createdByThisLaunch: value.createdByThisLaunch,
    requiresEdgeActivation: value.requiresEdgeActivation === true,
    dependencies: value.registryRecord?.dependencies || null,
    runtime: value.registryRecord?.runtime || null,
    pid: value.registryRecord?.pid || null,
    binds: value.registryRecord?.config?.binds || null,
    candidate: value.durableCandidate ? (value.durableCandidate.registryRecord?.dependencies || 'missing') : null,
    stored: (() => {
        try {
            return JSON.parse(fs.readFileSync(path.join(root, '.ploinky', 'agents.json'), 'utf8'))[value.containerName]?.dependencies || null;
        } catch { return null; }
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
        // An enabled registration and its route, as `enable` leaves them.
        const file = path.join(root, '.ploinky', 'agents.json');
        const agents = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
        agents[step.containerName] = step.record;
        fs.writeFileSync(file, JSON.stringify(agents, null, 2));
        const routingFile = path.join(root, '.ploinky', 'routing.json');
        const routing = JSON.parse(fs.readFileSync(routingFile, 'utf8') || '{}');
        routing.routes = routing.routes || {};
        routing.routes[step.record.alias || step.record.agentName] = {
            container: step.containerName, hostPath: agentPath, repo: step.record.repoName, agent: step.record.agentName,
        };
        fs.writeFileSync(routingFile, JSON.stringify(routing, null, 2));
        return { ok: true };
    }
    if (step.action === 'prepare-lease') {
        // The inactive-generation preparation a lifecycle command (enable /
        // workspace start) performs before launching with a preparation lease.
        const edge = await import('../../cli/sandbox/edgeGeneration.js');
        const prepared = edge.withEdgeGenerationApplyLock((applyLockCapability) => {
            edge.inactivateEdgeRoutingGeneration('dependency-store-test:source-stage', { applyLockCapability });
            return edge.prepareEdgeRoutingGeneration({ reason: 'dependency-store-test', applyLockCapability });
        });
        preparedLease = prepared.preparationLease;
        return { ok: Boolean(preparedLease), mode: preparedLease?.mode || null };
    }
    if (step.action === 'enable-sandbox') {
        const { setHostSandboxDisabled } = await import('../../cli/utils/runtime/sandboxRuntime.js');
        setHostSandboxDisabled(false);
        return { ok: true };
    }
    if (step.action === 'write') {
        fs.writeFileSync(path.join(root, step.file), step.content);
        return { ok: true };
    }
    if (step.action === 'ensure' || step.action === 'ensure-with-lease') {
        const { ensureAgentService } = await import('../../cli/sandbox/docker/agentServiceManager.js');
        const run = async () => {
            const agents = JSON.parse(fs.readFileSync(path.join(root, '.ploinky', 'agents.json'), 'utf8'));
            const record = agents[step.containerName] || {};
            let routerEndpoint = null;
            if (step.hostRouter) {
                const { buildRouterEndpoint } = await import('../../cli/sandbox/routerPort.js');
                routerEndpoint = buildRouterEndpoint('host', 8080);
            }
            const result = await ensureAgentService(step.agent || 'demo', manifest, agentPath, {
                containerName: step.containerName,
                routerEndpoint,
                ...(step.startPath ? {
                    // Exactly the option shape the workspace start path passes.
                    instanceId: record.instanceId,
                    enableGeneration: record.enableGeneration,
                    preservePreparedRegistryRecord: true,
                    preparationLease: preparedLease,
                } : {}),
                ...(step.options || {}),
            });
            if (step.startPath && !result?.requiresEdgeActivation && preparedLease) {
                // Workspace start commits its prepared graph generation once
                // all runtimes are ready, including reused ones.
                const { mergeRoutingConfig } = await import('../../cli/server/routingFile.js');
                await mergeRoutingConfig((current) => current, {
                    reason: 'dependency-store-test-graph-ready',
                    preparationLease: preparedLease,
                });
                preparedLease = null;
            }
            if (step.activate && result?.requiresEdgeActivation) {
                // The same readiness-then-activation commit the lifecycle
                // commands use (readiness itself is out of scope here).
                const { activatePreparedRuntimeAfterReadiness } = await import('../../cli/commands/workspaceUtil.js');
                await activatePreparedRuntimeAfterReadiness({
                    result,
                    routeKey: step.agent || 'demo',
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
    if (step.action === 'no-wait-adoption') {
        const { admittedRuntimeDependencyProblem } = await import('../../cli/sandbox/docker/agentServiceManager.js');
        const agents = JSON.parse(fs.readFileSync(path.join(root, '.ploinky', 'agents.json'), 'utf8'));
        return {
            problem: admittedRuntimeDependencyProblem({
                agentName: step.agent || 'demo',
                manifest,
                profileConfig: null,
                record: agents[step.containerName],
                containerName: step.containerName,
            }),
        };
    }
    throw new Error(`unknown step ${step.action}`);
}

for (const step of config.steps) {
    try {
        results.push({ step: step.label || step.action, ok: true, value: await runStep(step) });
    } catch (error) {
        results.push({ step: step.label || step.action, ok: false, code: error?.code || null, message: String(error?.message || error) });
        if (!step.allowFailure) break;
    }
}
fs.writeFileSync(config.out, JSON.stringify(results, null, 2));
