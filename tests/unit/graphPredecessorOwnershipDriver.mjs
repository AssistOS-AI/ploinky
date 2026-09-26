// Child-process driver for graphPredecessorOwnership.test.mjs (not a test file).
// Usage: node graphPredecessorOwnershipDriver.mjs <phase> [json-argument]
// Runs one lifecycle phase through production entry points against the
// workspace in PLOINKY_WORKSPACE_ROOT with the fake engine on PATH, and prints
// one JSON result line.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.PLOINKY_WORKSPACE_ROOT;
const [phase, rawArgument] = process.argv.slice(2);
const argument = rawArgument ? JSON.parse(rawArgument) : {};
const AGENTS = ['alpha', 'beta', 'gamma'];
const containerOf = (name) => `ploinky_repo_${name}`;
const agentsFile = path.join(root, '.ploinky', 'agents.json');
const routingFile = path.join(root, '.ploinky', 'routing.json');
const agentPath = (name) => path.join(root, '.ploinky', 'repos', 'repo', name);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
const cli = (relative) => import(new URL(`../../cli/${relative}`, import.meta.url).href);

async function launch(name, record, networkLifecycleCapability) {
    const { ensureAgentService } = await cli('sandbox/docker/agentServiceManager.js');
    const manifest = readJson(path.join(agentPath(name), 'manifest.json'));
    return ensureAgentService(name, manifest, agentPath(name), {
        containerName: containerOf(name),
        routerEndpoint: null,
        preservePreparedRegistryRecord: true,
        instanceId: record.instanceId,
        enableGeneration: record.enableGeneration,
        networkLifecycleCapability,
    });
}

async function run() {
    const locks = await cli('utils/runtime/maintenanceLocks.js');
    const network = await cli('sandbox/networkLifecycle.js');
    const edge = await cli('sandbox/edgeGeneration.js');
    // Exactly the locks a workspace start holds, reclaiming a killed owner's.
    const underStartLocks = (callback) => locks.withWorkspaceMutationLease({ operation: 'workspace-start' }, (lease) => (
        network.withNetworkLifecycleLockReclaimingStoppedOwner((capability) => callback(lease, capability))
    ));

    if (phase === 'setup') {
        // A completed earlier start: every agent launched and published, and
        // the committed generation active. `unpublished` names agents whose
        // launcher never published the runtime (its launch receipt remains).
        const { DEFAULT_ENABLE_AGENT_MODE } = await cli('utils/agents.js');
        const { getAgentDataDir } = await cli('utils/workspaceStructure.js');
        const { resolveRetainedGraphNodeExecutionRecord } = await cli('commands/workspaceUtil.js');
        const { resolveWorkspaceDependencyGraph } = await cli('utils/workspaceDependencyGraph.js');
        const { retireRuntimeCandidate } = await cli('sandbox/runtimeCandidateStore.js');
        edge.initializeFreshEdgeRoutingSources({ workspaceRoot: root });
        const agents = {};
        const routes = {};
        for (const name of AGENTS) {
            agents[containerOf(name)] = {
                type: 'agent', repoName: 'repo', agentName: name,
                runMode: DEFAULT_ENABLE_AGENT_MODE, projectPath: getAgentDataDir(name), profile: 'default',
                instanceId: `${name}-instance`, enableGeneration: `${name}-generation`, auth: { mode: 'sso' },
            };
            routes[name] = { container: containerOf(name), hostPath: agentPath(name), repo: 'repo', agent: name };
        }
        const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'repo/alpha', registry: agents });
        const staticNode = [...graph.nodes.values()].find((node) => node.shortAgentName === 'alpha');
        agents[containerOf('alpha')].projectPath = resolveRetainedGraphNodeExecutionRecord(
            staticNode, agents[containerOf('alpha')],
        ).projectPath;
        fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
        fs.writeFileSync(routingFile, JSON.stringify({ port: 8080, routes }, null, 2));
        edge.applyEdgeRoutingGeneration({ reason: 'earlier-start-committed' });
        const unpublished = new Set(argument.unpublished || []);
        const launched = await underStartLocks(async (_lease, capability) => {
            const results = {};
            for (const name of AGENTS) results[name] = await launch(name, agents[containerOf(name)], capability);
            return results;
        });
        const published = readJson(agentsFile);
        for (const name of AGENTS) {
            const candidate = launched[name].durableCandidate;
            if (unpublished.has(name)) continue;
            published[containerOf(name)] = {
                ...published[containerOf(name)],
                containerId: candidate.containerId,
                runtime: candidate.runtime,
                config: { binds: candidate.registryRecord.config.binds },
            };
            retireRuntimeCandidate(candidate);
        }
        fs.writeFileSync(agentsFile, JSON.stringify(published, null, 2));
        edge.applyEdgeRoutingGeneration({ reason: 'earlier-start-published' });
        // The restart's stop phase: every runtime stopped, none removed.
        for (const name of AGENTS) {
            execFileSync('podman', ['stop', launched[name].containerId], { stdio: 'ignore' });
        }
        return { containerIds: Object.fromEntries(AGENTS.map((name) => [name, launched[name].containerId])) };
    }

    if (phase === 'stage') {
        // The staging of a workspace start, exactly as startWorkspace runs it
        // under its leases. `killAt` SIGKILLs this process when the removal of
        // that exact predecessor begins; `killBeforeRegistrySave` does so just
        // before the rotated registry is written.
        const {
            ensureGraphNodesEnabled,
            removeGraphContainerForRecreate,
            resolveExtraEnabledRuntimeNodes,
        } = await cli('commands/workspaceUtil.js');
        const { resolveWorkspaceDependencyGraph } = await cli('utils/workspaceDependencyGraph.js');
        const { mergeRoutingConfig } = await cli('server/routingFile.js');
        const workspaceSvc = await cli('utils/workspace.js');
        return underStartLocks(async (lease, networkLifecycleCapability) => {
            edge.retireAbandonedWorkspaceStartPreparation({
                workspaceRoot: root,
                workspaceMutationLease: lease,
                networkLifecycleCapability,
            });
            edge.inactivateEdgeRoutingGeneration('workspace-start-prepare', { workspaceRoot: root });
            const registry = readJson(agentsFile);
            const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'repo/alpha', registry });
            const removals = [];
            try {
                const staged = ensureGraphNodesEnabled(graph, registry, {
                    additionalNodes: resolveExtraEnabledRuntimeNodes(graph, registry),
                    saveAgents(map, options) {
                        if (argument.killBeforeRegistrySave) process.kill(process.pid, 'SIGKILL');
                        return workspaceSvc.saveAgents(map, options);
                    },
                    removeAgentContainerForRecreate(containerName, ...rest) {
                        if (argument.killAt === containerName) process.kill(process.pid, 'SIGKILL');
                        removals.push(containerName);
                        return removeGraphContainerForRecreate(containerName, ...rest);
                    },
                });
                // `launchAfter` then launches those agents' rotated identity
                // as the start does and stops before publishing any of them.
                const launched = {};
                if (argument.launchAfter?.length) {
                    await mergeRoutingConfig((current) => current, {
                        reason: 'workspace-runtime-graph-ready',
                        preparationLease: staged.preparedGeneration.preparationLease,
                        networkLifecycleCapability,
                    });
                    for (const name of argument.launchAfter) {
                        const record = readJson(agentsFile)[containerOf(name)];
                        launched[name] = (await launch(name, record, networkLifecycleCapability)).containerId;
                    }
                }
                return { staged: true, removals, changedContainers: staged.changedContainers, launched };
            } catch (error) {
                return {
                    staged: false,
                    removals,
                    code: error.code || null,
                    message: error.message,
                    cause: error.cause?.message || null,
                };
            }
        });
    }

    if (phase === 'monitor') {
        // The container monitor of a Watchdog that outlived the stopped start,
        // built as Watchdog.js builds it, ticking now that no start lock is
        // held. Short restart backoffs let each scheduled restart run here.
        const { createContainerMonitor, monitorTick, stopContainerMonitor } = await cli('server/containerMonitor.js');
        const events = [];
        const monitor = createContainerMonitor({
            config: { INITIAL_BACKOFF_MS: 10, MAX_BACKOFF_MS: 50, CONTAINER_SNAPSHOT_INTERVAL_MS: 0 },
            log: (level, event, data = {}) => events.push({
                event, container: data.container || null, code: data.code || null, error: data.error ? String(data.error) : null,
            }),
        });
        const deadline = Date.now() + 60_000;
        for (let tick = 0; tick < 3; tick += 1) {
            monitorTick(monitor);
            while ([...monitor.targets.values()].some((target) => target.isRestarting || target.pendingRestartTimer)) {
                if (Date.now() > deadline) throw new Error('monitor restarts did not settle');
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
        stopContainerMonitor(monitor);
        return { events };
    }

    if (phase === 'orphan-receipts') {
        // What a start killed before its rotated registry write leaves: one
        // receipt per record, keyed by a tuple no record carries.
        const { writeRuntimePredecessor } = await cli('sandbox/runtimePredecessorStore.js');
        const records = readJson(agentsFile);
        for (const name of AGENTS) {
            writeRuntimePredecessor({
                containerName: containerOf(name),
                successor: { instanceId: `${name}-orphan-instance`, enableGeneration: `${name}-orphan-generation` },
                predecessor: records[containerOf(name)],
            });
        }
        return { written: AGENTS.length };
    }

    if (phase === 'stop') {
        // `ploinky stop` without its Router kill: retire a stopped start's
        // preparation, inactivate the selector and stop every configured agent
        // by exact ownership. No Router runs here, and the kill's port scan
        // would signal whatever listens on the persisted port of this host.
        const { retireAbandonedStartPreparationBeforeStop } = await cli('commands/workspaceUtil.js');
        const { stopConfiguredAgents } = await cli('sandbox/docker/index.js');
        retireAbandonedStartPreparationBeforeStop({ log() {} });
        edge.inactivateEdgeRoutingGenerationForStop('cli-workspace-stop');
        return { stopped: stopConfiguredAgents() };
    }
    throw new Error(`unknown phase ${phase}`);
}

process.stdout.write(`${JSON.stringify(await run())}\n`);
