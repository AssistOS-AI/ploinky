// Child-process driver for noWaitRunSupersession.test.mjs (not a test file).
// Usage: node noWaitRunSupersessionDriver.mjs <phase> [json-argument]
// Runs one lifecycle phase through production entry points against the
// workspace in PLOINKY_WORKSPACE_ROOT with the fake engine on PATH, and prints
// one JSON result line.

import fs from 'node:fs';
import path from 'node:path';

const root = process.env.PLOINKY_WORKSPACE_ROOT;
const [phase, rawArgument] = process.argv.slice(2);
const argument = rawArgument ? JSON.parse(rawArgument) : {};
const CONTAINER = 'ploinky_repo_demo';
const agentsFile = path.join(root, '.ploinky', 'agents.json');
const routingFile = path.join(root, '.ploinky', 'routing.json');
const agentPath = (name) => path.join(root, '.ploinky', 'repos', 'repo', name);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
const cli = (relative) => import(new URL(`../../cli/${relative}`, import.meta.url).href);

// A lifecycle step under the exact locks a workspace start or worker holds.
async function underStartLocks(operation, callback) {
    const locks = await cli('utils/runtime/maintenanceLocks.js');
    const network = await cli('sandbox/networkLifecycle.js');
    return locks.withWorkspaceMutationLease({ operation }, () => network.withNetworkLifecycleLock(callback));
}

async function ensureDemo(record, extra = {}) {
    const { ensureAgentService } = await cli('sandbox/docker/agentServiceManager.js');
    const manifest = readJson(path.join(agentPath('demo'), 'manifest.json'));
    return ensureAgentService('demo', manifest, agentPath('demo'), {
        containerName: CONTAINER,
        routerEndpoint: null,
        preservePreparedRegistryRecord: true,
        instanceId: record.instanceId,
        enableGeneration: record.enableGeneration,
        ...extra,
    });
}

async function run() {
    if (phase === 'setup') {
        // The generation an earlier start committed: both agents staged
        // target-less, no runtime published yet.
        const edge = await cli('sandbox/edgeGeneration.js');
        const { DEFAULT_ENABLE_AGENT_MODE } = await cli('utils/agents.js');
        const { getAgentDataDir } = await cli('utils/workspaceStructure.js');
        edge.initializeFreshEdgeRoutingSources({ workspaceRoot: root });
        const agents = {};
        const routes = {};
        for (const name of ['demo', 'other']) {
            const container = `ploinky_repo_${name}`;
            // The exact execution record a start stages, so nothing but a
            // superseded worker can make the next start rotate this identity.
            agents[container] = {
                type: 'agent', repoName: 'repo', agentName: name,
                runMode: DEFAULT_ENABLE_AGENT_MODE, projectPath: getAgentDataDir(name), profile: 'default',
                instanceId: `${name}-instance`, enableGeneration: `${name}-generation`, auth: { mode: 'sso' },
            };
            routes[name] = { container, hostPath: agentPath(name), repo: 'repo', agent: name };
        }
        // The static demo node runs in the workspace root; take the exact
        // retained execution record from the production resolver.
        const { resolveRetainedGraphNodeExecutionRecord } = await cli('commands/workspaceUtil.js');
        const { resolveWorkspaceDependencyGraph } = await cli('utils/workspaceDependencyGraph.js');
        const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'repo/demo', registry: agents });
        const demoNode = [...graph.nodes.values()].find((node) => node.shortAgentName === 'demo');
        agents[CONTAINER].projectPath = resolveRetainedGraphNodeExecutionRecord(demoNode, agents[CONTAINER]).projectPath;
        fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
        fs.writeFileSync(routingFile, JSON.stringify({ port: 8080, routes }, null, 2));
        return { selector: edge.applyEdgeRoutingGeneration({ reason: 'earlier-start-committed' }).selector.state };
    }
    if (phase === 'worker-ensure') {
        // Exactly what the earlier start's no-wait worker does before its
        // readiness: the runtime exists, the registry has no container ID.
        const record = readJson(agentsFile)[CONTAINER];
        const result = await underStartLocks('no-wait-runtime:ploinky_repo_demo', (networkLifecycleCapability) => (
            ensureDemo(record, { networkLifecycleCapability })
        ));
        return {
            containerId: result.containerId,
            registeredContainerId: readJson(agentsFile)[CONTAINER].containerId || null,
            receipt: Boolean(result.durableCandidate),
        };
    }
    if (phase === 'inspect') {
        const settlement = await cli('commands/noWaitRunSettlement.js');
        return {
            inFlight: settlement.inspectInFlightNoWaitWorkers(),
            live: settlement.inspectLiveNoWaitWorkers(),
        };
    }
    if (phase === 'next-start') {
        // The next start's staging, exactly as startWorkspace runs it: under
        // its leases, with the stalled workers it found there. It then commits
        // the generation and launches the rotated identity like its own worker.
        const settlement = await cli('commands/noWaitRunSettlement.js');
        const { ensureGraphNodesEnabled } = await cli('commands/workspaceUtil.js');
        const { resolveWorkspaceDependencyGraph } = await cli('utils/workspaceDependencyGraph.js');
        const { mergeRoutingConfig } = await cli('server/routingFile.js');
        return underStartLocks('workspace-start', async (networkLifecycleCapability) => {
            const superseded = argument.supersede === false ? [] : settlement.inspectLiveNoWaitWorkers();
            const registry = readJson(agentsFile);
            const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: 'repo/demo', registry });
            let staged;
            try {
                staged = ensureGraphNodesEnabled(graph, registry, {
                    supersededNoWaitRuns: superseded,
                    // Stands in for the production runtime check finding the
                    // runtime current (running, same env hash), which the fake
                    // engine does not model: then only supersession rotates.
                    ...(argument.runtimeCurrent ? { runtimeReplacementReason: () => '' } : {}),
                });
            } catch (error) {
                return { staged: false, message: error.message, cause: error.cause?.message || null };
            }
            const lease = staged.preparedGeneration.preparationLease;
            await mergeRoutingConfig((current) => current, {
                reason: 'workspace-runtime-graph-ready',
                preparationLease: lease,
                networkLifecycleCapability,
            });
            const record = readJson(agentsFile)[CONTAINER];
            const launched = await ensureDemo(record, { networkLifecycleCapability });
            return {
                staged: true,
                superseded: superseded.map(({ containerName, pid }) => ({ containerName, pid })),
                changedContainers: staged.changedContainers,
                record,
                launchedContainerId: launched.containerId,
            };
        });
    }
    if (phase === 'remove-predecessor') {
        const { removeGraphContainerForRecreate } = await cli('commands/workspaceUtil.js');
        return underStartLocks('workspace-start', () => {
            try {
                return { removed: removeGraphContainerForRecreate(CONTAINER, 'workspaceGraph:repo/demo:test', argument.record) };
            } catch (error) {
                return { refused: error.message, cause: error.cause?.message || null };
            }
        });
    }
    throw new Error(`unknown phase ${phase}`);
}

process.stdout.write(`${JSON.stringify(await run())}\n`);
