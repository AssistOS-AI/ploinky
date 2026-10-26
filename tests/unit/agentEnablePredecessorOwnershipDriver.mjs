// Child-process driver for agentEnablePredecessorOwnership.test.mjs (not a
// test file). Usage: node agentEnablePredecessorOwnershipDriver.mjs <phase>
// [json-argument]. Runs one lifecycle phase through production entry points
// against the workspace in PLOINKY_WORKSPACE_ROOT with the fake engine on
// PATH, and prints one JSON result line.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.PLOINKY_WORKSPACE_ROOT;
const [phase, rawArgument] = process.argv.slice(2);
const argument = rawArgument ? JSON.parse(rawArgument) : {};
const agentsFile = path.join(root, '.ploinky', 'agents.json');
const predecessorDir = path.join(root, '.ploinky', 'run', 'runtime-predecessors');
const cli = (relative) => import(new URL(`../../cli/${relative}`, import.meta.url).href);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
const receiptNames = () => (fs.existsSync(predecessorDir)
    ? fs.readdirSync(predecessorDir).filter((name) => name.endsWith('.json')).sort()
    : []);

function waitForFile(file) {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(file)) Atomics.wait(cell, 0, 0, 25);
}

// Observation and interruption points inside one production enable. The
// receipt store links its fsynced temporary file into place; the registry is
// written by rename. Each registry write records the receipts present and the
// edge selector state at that moment.
const trace = [];
const selectorStateOf = (selectorFile) => {
    try { return JSON.parse(fs.readFileSync(selectorFile, 'utf8')).state || null; } catch (_) { return null; }
};
function armInterruptions(selectorFile) {
    let receiptLinked = false;
    const originalLink = fs.linkSync;
    const originalRename = fs.renameSync;
    const selector = () => selectorStateOf(selectorFile);
    fs.linkSync = function linkSync(source, destination, ...rest) {
        if (path.dirname(String(destination)) === predecessorDir) {
            if (argument.failReceiptWrite) {
                throw Object.assign(new Error('injected receipt write failure'), { code: 'EIO' });
            }
            trace.push({ event: 'receipt', selector: selector(), name: path.basename(String(destination)) });
        }
        const result = originalLink.call(fs, source, destination, ...rest);
        if (path.dirname(String(destination)) === predecessorDir) {
            receiptLinked = true;
            if (argument.killAfterReceipt) process.kill(process.pid, 'SIGKILL');
        }
        return result;
    };
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = function unlinkSync(target, ...rest) {
        if (argument.failReceiptRetire && path.dirname(String(target)) === predecessorDir
            && String(target).endsWith('.json')) {
            argument.failReceiptRetire = false;
            throw Object.assign(new Error('injected receipt retirement failure'), { code: 'EIO' });
        }
        return originalUnlink.call(fs, target, ...rest);
    };
    fs.renameSync = function renameSync(source, destination, ...rest) {
        if (String(destination) === agentsFile && argument.failRegistryRename) {
            throw Object.assign(new Error('injected registry write failure'), { code: 'EIO' });
        }
        const result = originalRename.call(fs, source, destination, ...rest);
        if (String(destination) === agentsFile) {
            trace.push({ event: 'registry', selector: selector(), receipts: receiptNames() });
            if (receiptLinked && argument.killAfterRegistry) process.kill(process.pid, 'SIGKILL');
            if (receiptLinked && argument.pauseAfterRegistry) {
                fs.writeFileSync(argument.pauseAfterRegistry.ready, String(process.pid));
                waitForFile(argument.pauseAfterRegistry.release);
                argument.pauseAfterRegistry = null;
            }
        }
        return result;
    };
}

function failure(error) {
    return {
        ok: false,
        code: error?.code || null,
        message: String(error?.message || error),
        cause: error?.cause ? String(error.cause.message || error.cause) : null,
    };
}

async function run() {
    const edge = await cli('sandbox/edgeGeneration.js');
    const { applyEdgeRoutingGeneration } = await cli('sandbox/coordinatedEdgeApply.js');
    const selectorFile = edge.resolveEdgeGenerationPaths({ workspaceRoot: root }).activeSelectorFile;

    if (phase === 'init') {
        // A workspace whose first start persisted its Router port and an
        // active (empty) edge generation.
        edge.initializeFreshEdgeRoutingSources({ workspaceRoot: root });
        fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080, routes: {} }, null, 2));
        applyEdgeRoutingGeneration({ reason: 'test-initial-start' });
        return { ok: true };
    }

    if (phase === 'seed') {
        // Registry records as an earlier completed enable left them (no
        // runtime is created), then committed as the active generation.
        const { getAgentContainerName } = await cli('sandbox/docker/index.js');
        const { getAgentDataDir } = await cli('utils/workspaceStructure.js');
        const records = readJson(agentsFile);
        const routing = readJson(path.join(root, '.ploinky', 'routing.json'));
        routing.routes = routing.routes || {};
        const names = {};
        for (const { agent, ...fields } of argument.records) {
            const containerName = getAgentContainerName(agent, 'repo');
            names[agent] = containerName;
            const record = {
                agentName: agent, repoName: 'repo', containerImage: 'node:20',
                createdAt: new Date().toISOString(), projectPath: getAgentDataDir(agent),
                runMode: 'isolated', type: 'agent', profile: 'default', auth: { mode: 'none' },
                config: { binds: [], env: [], ports: [] },
                ...fields,
            };
            records[containerName] = record;
            routing.routes[record.agentName] = {
                container: containerName,
                hostPath: path.join(root, '.ploinky', 'repos', record.repoName, record.agentName),
                repo: record.repoName,
                agent: record.agentName,
            };
        }
        fs.writeFileSync(agentsFile, JSON.stringify(records, null, 2));
        fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify(routing, null, 2));
        applyEdgeRoutingGeneration({ reason: 'test-seeded-earlier-enable' });
        return { ok: true, names };
    }

    if (phase === 'static-root') {
        // The workspace's configured static agent, set before that agent is
        // enabled so its staged project path is already the workspace root.
        const records = readJson(agentsFile);
        records._config = { ...(records._config || {}), static: { agent: argument.agent, port: 8080 } };
        fs.writeFileSync(agentsFile, JSON.stringify(records, null, 2));
        applyEdgeRoutingGeneration({ reason: 'test-static-root-config' });
        return { ok: true };
    }

    if (phase === 'managed-predecessor') {
        // A published managed (default/bridge) runtime as its launch leaves it:
        // a container carrying this workspace's managed ownership labels for
        // its network contract, its exact tuple and an init reaper, attached to
        // its physical managed network, with a signed generated Router
        // descriptor mounted read-only and recorded in the registry. The full
        // managed launch cannot run offline (its Router authority attestation
        // needs a live Router and helper container), so the same production
        // helpers build the labels, the network name, the signed descriptor and
        // the semantic environment-hash label the managed create renders.
        const { getAgentContainerName } = await cli('sandbox/docker/index.js');
        const { getAgentDataDir } = await cli('utils/workspaceStructure.js');
        const { NETWORK_LABELS, physicalNetworkName, workspaceNetworkIdentity } = await cli('sandbox/networkIdentity.js');
        const { NETWORK_SCHEMA_VERSION, logicalNetworkAttachments, networkContractHash } = await cli('sandbox/networkContract.js');
        const { effectiveInstanceKey } = await cli('utils/workspaceDependencyGraph.js');
        const { deriveAgentPrincipalId } = await cli('utils/security/agentIdentity.js');
        const descriptors = await cli('utils/security/generatedRouterDescriptor.js');
        const { buildRuntimeNetworkPlan, computeAgentEnvHash } = await cli('sandbox/docker/agentServiceManager.js');
        const { computeRetainedManagedEnvHash } = await cli('commands/workspaceUtil.js');
        const { resolveManifestRuntimeProfile } = await cli('utils/runtime/profileService.js');
        const { agent, network } = argument;
        const containerName = getAgentContainerName(agent, 'repo');
        const instanceId = `${agent}-managed-instance`;
        const enableGeneration = `${agent}-managed-generation`;
        const envelope = JSON.parse(fs.readFileSync(
            new URL('../fixtures/router-descriptor/managed-envelope.json', import.meta.url), 'utf8',
        ));
        const payload = {
            ...envelope.payload,
            agentPrincipal: deriveAgentPrincipalId('repo', agent),
            instanceId,
            generationId: enableGeneration,
            launchId: randomUUID(),
        };
        const descriptorFile = path.join(root, '.ploinky', 'run', 'router-descriptors', `${payload.launchId}.json`);
        descriptors.writeGeneratedRouterDescriptorFile(
            descriptorFile, descriptors.signGeneratedRouterDescriptorEnvelope(payload).bytes,
        );
        const manifest = readJson(path.join(root, '.ploinky', 'repos', 'repo', agent, 'manifest.json'));
        const profile = resolveManifestRuntimeProfile(manifest, { agentName: `repo/${agent}`, path: `manifest(repo/${agent})` });
        if (JSON.stringify(profile.network) !== JSON.stringify(network)) {
            throw new Error(`fixture network ${JSON.stringify(network)} differs from the manifest's ${JSON.stringify(profile.network)}`);
        }
        const runtimeNetworkPlan = buildRuntimeNetworkPlan('podman', profile.network);
        const principalId = deriveAgentPrincipalId('repo', agent);
        // The label computeSemanticEnvHash(payload) gives the managed create.
        const envHash = computeAgentEnvHash(manifest, profile.profileConfig, {
            agentName: agent,
            repoName: 'repo',
            runtimeNetworkPlan,
            generatedRouter: { payload, principalId, instanceId, enableGeneration },
        });
        const workspaceHash = workspaceNetworkIdentity(root).hash;
        const [attachment] = logicalNetworkAttachments(network, agent, {
            instanceKey: effectiveInstanceKey('repo', agent, ''),
        });
        const labels = {
            [NETWORK_LABELS.managed]: '1',
            [NETWORK_LABELS.resource]: 'agent',
            [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
            [NETWORK_LABELS.workspace]: workspaceHash,
            [NETWORK_LABELS.contract]: networkContractHash(network),
            [NETWORK_LABELS.instanceId]: instanceId,
            [NETWORK_LABELS.enableGeneration]: enableGeneration,
            'ploinky.envhash': envHash,
        };
        const descriptorTarget = '/run/ploinky/router-descriptor.json';
        const containerId = execFileSync('podman', [
            'create', '--init', '--name', containerName,
            ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
            ...Object.entries(descriptors.buildGeneratedRouterDescriptorEnv(payload)).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
            '-v', `${descriptorFile}:${descriptorTarget}:ro`,
            '--network', physicalNetworkName(workspaceHash, attachment.name),
            'node:20',
        ], { encoding: 'utf8' }).trim();
        execFileSync('podman', ['start', containerId], { stdio: 'ignore' });
        const records = readJson(agentsFile);
        records[containerName] = {
            agentName: agent, repoName: 'repo', containerImage: 'node:20', createdAt: new Date().toISOString(),
            projectPath: getAgentDataDir(agent), runMode: 'isolated', type: 'agent', profile: 'default',
            auth: { mode: 'none' }, instanceId, enableGeneration, containerId, runtime: 'podman',
            config: {
                binds: [{ source: descriptorFile, target: descriptorTarget, ro: true, generatedRouterDescriptor: true }],
                env: [], ports: [],
            },
        };
        fs.writeFileSync(agentsFile, JSON.stringify(records, null, 2));
        const routing = readJson(path.join(root, '.ploinky', 'routing.json'));
        routing.routes = { ...(routing.routes || {}), [agent]: {
            container: containerName,
            hostPath: path.join(root, '.ploinky', 'repos', 'repo', agent),
            repo: 'repo',
            agent,
        } };
        fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify(routing, null, 2));
        applyEdgeRoutingGeneration({ reason: 'test-published-managed-runtime' });
        // What the graph recomputes for this retained runtime from its record
        // and signed descriptor; it must agree with the rendered label.
        const retainedEnvHash = computeRetainedManagedEnvHash(
            { repoName: 'repo', shortAgentName: agent, manifest, profile: '' },
            records[containerName], profile.profileConfig, runtimeNetworkPlan,
        );
        return { ok: true, containerName, containerId, descriptorFile, envHash, retainedEnvHash };
    }

    if (phase === 'allow-host-sandbox') {
        // The operator opt-in that lets a lite-sandbox manifest run natively.
        const { setHostSandboxDisabled } = await cli('utils/runtime/sandboxRuntime.js');
        return { ok: true, status: setHostSandboxDisabled(false) };
    }

    if (phase === 'edit-registry') {
        // An operator-visible registry change, committed as the active generation.
        const records = readJson(agentsFile);
        const record = records[argument.containerName];
        for (const [key, value] of Object.entries(argument.set || {})) record[key] = value;
        for (const key of argument.delete || []) delete record[key];
        fs.writeFileSync(agentsFile, JSON.stringify(records, null, 2));
        try {
            applyEdgeRoutingGeneration({ reason: 'test-registry-edit' });
        } catch (error) {
            return failure(error);
        }
        return { ok: true };
    }

    if (phase === 'enable') {
        armInterruptions(selectorFile);
        const agents = await cli('utils/agents.js');
        try {
            const result = await agents.enableAgent(
                argument.agent,
                argument.mode,
                undefined,
                argument.alias,
                undefined,
                argument.profile ? { profile: argument.profile } : {},
            );
            return { ok: true, result, trace };
        } catch (error) {
            return { ...failure(error), trace };
        }
    }

    if (phase === 'prepare') {
        // Only the preparation half of an enable, then its exact abort, so a
        // test can observe what staging alone publishes.
        armInterruptions(selectorFile);
        const agents = await cli('utils/agents.js');
        try {
            const prepared = agents.prepareAgentEnableBatch([{
                agentName: argument.agent,
                ...(argument.profile ? { authOptions: { profile: argument.profile } } : {}),
            }], { reason: 'test-predecessor-prepare' });
            const [plan] = prepared.plans;
            const staged = readJson(agentsFile)[plan.containerName];
            const lease = prepared.preparedGeneration.preparationLease;
            edge.abortEdgeRoutingPreparation(lease, { reason: 'test-predecessor-prepare-complete' });
            return { ok: true, mode: lease.mode, staged, trace };
        } catch (error) {
            return { ...failure(error), trace };
        }
    }

    if (phase === 'lookup') {
        // The receipt the current registry record selects, if any.
        const { readRuntimePredecessor } = await cli('sandbox/runtimePredecessorStore.js');
        const record = readJson(agentsFile)[argument.containerName];
        try {
            return { ok: true, receipt: readRuntimePredecessor(argument.containerName, record) };
        } catch (error) {
            return failure(error);
        }
    }

    if (phase === 'generation') {
        // The committed generation the Router would serve, or why none is.
        try {
            const active = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: root });
            return { ok: true, selector: active.selector.state, agents: active.generation.agents };
        } catch (error) {
            return { ...failure(error), selector: selectorStateOf(selectorFile) };
        }
    }

    if (phase === 'stage') {
        // The supported recovery: a workspace start, exactly as startWorkspace
        // stages it under its leases (reclaiming a killed owner's), then the
        // launch and publication of every changed runtime.
        const locks = await cli('utils/runtime/maintenanceLocks.js');
        const network = await cli('sandbox/networkLifecycle.js');
        const {
            ensureGraphNodesEnabled,
            resolveExtraEnabledRuntimeNodes,
        } = await cli('commands/workspaceUtil.js');
        const { resolveWorkspaceDependencyGraph } = await cli('utils/workspaceDependencyGraph.js');
        const { mergeRoutingConfig } = await cli('server/routingFile.js');
        const { ensureAgentService } = await cli('sandbox/docker/agentServiceManager.js');
        const { resolveRouterEndpoint } = await cli('sandbox/routerPort.js');
        const { retireRuntimeCandidate } = await cli('sandbox/runtimeCandidateStore.js');
        const workspaceSvc = await cli('utils/workspace.js');
        return locks.withWorkspaceMutationLease({ operation: 'workspace-start' }, (lease) => (
            network.withNetworkLifecycleLockReclaimingStoppedOwner(async (networkLifecycleCapability) => {
                const lines = [];
                try {
                    edge.retireAbandonedWorkspaceStartPreparation({
                        workspaceRoot: root,
                        workspaceMutationLease: lease,
                        networkLifecycleCapability,
                    });
                    edge.inactivateEdgeRoutingGeneration('workspace-start-prepare', { workspaceRoot: root });
                    const registry = readJson(agentsFile);
                    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: argument.staticAgent, registry });
                    const staged = ensureGraphNodesEnabled(graph, registry, {
                        additionalNodes: resolveExtraEnabledRuntimeNodes(graph, registry),
                        logLine: (line) => lines.push(line),
                    });
                    const published = {};
                    for (const containerName of staged.changedContainers) {
                        const record = readJson(agentsFile)[containerName];
                        const agentPath = path.join(root, '.ploinky', 'repos', record.repoName, record.agentName);
                        const manifest = readJson(path.join(agentPath, 'manifest.json'));
                        const started = await ensureAgentService(record.agentName, manifest, agentPath, {
                            containerName,
                            routerEndpoint: resolveRouterEndpoint(manifest.network?.mode),
                            preservePreparedRegistryRecord: true,
                            instanceId: record.instanceId,
                            enableGeneration: record.enableGeneration,
                            preparationLease: staged.preparedGeneration.preparationLease,
                            networkLifecycleCapability,
                        });
                        const current = readJson(agentsFile);
                        current[containerName] = started.registryRecord;
                        workspaceSvc.saveAgents(current, { coordinate: false });
                        if (started.durableCandidate) retireRuntimeCandidate(started.durableCandidate);
                        published[containerName] = current[containerName].containerId;
                    }
                    await mergeRoutingConfig((current) => current, {
                        reason: 'workspace-runtime-graph-ready',
                        preparationLease: staged.preparedGeneration.preparationLease,
                        networkLifecycleCapability,
                    });
                    return { ok: true, changedContainers: staged.changedContainers, published, lines };
                } catch (error) {
                    return { ...failure(error), lines };
                }
            })
        ));
    }

    if (phase === 'stop') {
        // `ploinky stop` without its Router kill: retire a stopped operation's
        // preparation, inactivate the selector and stop every configured agent
        // by exact ownership. No Router runs here, and the kill's port scan
        // would signal whatever listens on the persisted port of this host.
        const { retireAbandonedStartPreparationBeforeStop } = await cli('commands/workspaceUtil.js');
        const { stopConfiguredAgents } = await cli('sandbox/docker/index.js');
        retireAbandonedStartPreparationBeforeStop({ log() {} });
        edge.inactivateEdgeRoutingGenerationForStop('cli-workspace-stop');
        return { ok: true, stopped: stopConfiguredAgents() };
    }

    if (phase === 'monitor') {
        // The container monitor of a Watchdog, built as Watchdog.js builds it,
        // ticking once. Short restart backoffs let a scheduled restart run.
        const { createContainerMonitor, monitorTick, stopContainerMonitor } = await cli('server/containerMonitor.js');
        const events = [];
        const monitor = createContainerMonitor({
            config: { INITIAL_BACKOFF_MS: 10, MAX_BACKOFF_MS: 50, CONTAINER_SNAPSHOT_INTERVAL_MS: 0 },
            log: (level, event, data = {}) => events.push({
                event, container: data.container || null, code: data.code || null, error: data.error ? String(data.error) : null,
            }),
        });
        const deadline = Date.now() + 30_000;
        for (let tick = 0; tick < 2; tick += 1) {
            monitorTick(monitor);
            while ([...monitor.targets.values()].some((target) => target.isRestarting || target.pendingRestartTimer)) {
                if (Date.now() > deadline) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
        stopContainerMonitor(monitor);
        return { ok: true, events };
    }
    throw new Error(`unknown phase ${phase}`);
}

process.stdout.write(`${JSON.stringify(await run())}\n`);
