import fs from 'fs';
import path from 'path';
import net from 'net';
import { randomUUID } from 'node:crypto';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as utils from './utils.js';
import * as agentsSvc from './agents.js';
import * as workspaceSvc from './workspace.js';
import * as dockerSvc from './docker/index.js';
import {
  computeEnvHash,
  getContainerLabel,
  getRuntime,
  getRuntimeForAgent,
  isSandboxRuntime,
  loadAgentsMap,
} from './docker/common.js';
import {
  buildRuntimeNetworkPlan,
  buildRuntimeRouterEnv,
  resolvePublishedPortMappings,
} from './docker/agentServiceManager.js';
import { isBwrapProcessRunning } from './bwrap/bwrapFleet.js';
import * as inputState from './inputState.js';
import { prepareManifestRepositories } from './bootstrapManifest.js';
import { executeHostHook, markPreinstallRunInProcess, resetPreinstallRunInProcess, isInlineCommand } from './lifecycleHooks.js';
import { getActiveProfile, getProfileConfig, getProfileEnvVars, resolveManifestRuntimeProfile } from './profileService.js';
import { getSecrets, createEnvWithSecrets, loadEnvFile } from './secretInjector.js';
import { readSecretsFile } from './encryptedSecretsFile.js';
import { buildEnvMap, getExposedNames, getManifestEnvNames } from './secretVars.js';
import { isLlmRuntimeManifest, prepareLlmStartup } from './llmRuntimeIntegration.js';
import { resolveAgentExecutionMode, resolveAgentReadinessProtocol } from './startupReadiness.js';
import { normalizeProbeConfig, runContainerScriptReadiness } from './docker/healthProbes.js';
import { applyStartupConfigProvidersForGraph } from './startupConfigProviders.js';
import { createWorkspaceStartLock, releaseWorkspaceStartLock, withMaintenanceLock } from './maintenanceLocks.js';
import {
  AGENTS_DATA_DIR,
  LOGS_DIR,
  PLOINKY_CWD,
  PLOINKY_WORKSPACE_ROOT,
  REPOS_DIR,
  RUNNING_DIR,
} from './config.js';
import { classifyDependencyGraphWaitMode, resolveWorkspaceDependencyGraph, topologicallyGroupDependencyGraph } from './workspaceDependencyGraph.js';
import {
  mergeRoutingConfig,
  mergeRuntimeRoute,
  readRoutingConfig,
  writeRoutingConfig,
} from './routingFile.js';
import {
  abortEdgeRoutingPreparation,
  edgeRuntimeEnvironment,
  initializeFreshEdgeRoutingSources,
  inactivateEdgeRoutingGeneration,
  prepareHostModeCapabilityForInactiveGeneration,
} from './edgeGeneration.js';
import { applyEdgeRoutingGeneration } from './coordinatedEdgeApply.js';
import {
  partitionAdditionalStartupAgents,
  removeInactiveManualRoutes,
  resolveManifestStartup,
} from './manifestStartup.js';
import { waitForAgentReady } from '../server/utils/agentReadiness.js';
import { createNetworkLifecycleAdapter } from './networkLifecycle.js';
import { networkContractHash } from './networkContract.js';
import { explicitHttpServicePorts } from './httpServicePortConfig.js';
import { getAgentDataDir } from './workspaceStructure.js';
import {
  formatAgentAttachmentBanner,
  resolveAgentAttachmentIdentity,
} from './layerIdentification.js';
import {
  assertRouterEndpoint,
  parseRouterPort,
  resolveInitialRouterPort,
  resolvePersistedRouterPort,
  resolveRouterEndpoint,
} from './routerPort.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createAppendLogStdio(logFile) {
  const opened = [];
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const stdoutFd = fs.openSync(logFile, 'a');
    const stderrFd = fs.openSync(logFile, 'a');
    opened.push(stdoutFd, stderrFd);
    return {
      stdio: ['ignore', stdoutFd, stderrFd],
      closeParentFds() {
        for (const fd of opened) {
          try { fs.closeSync(fd); } catch (_) {}
        }
      }
    };
  } catch (_) {
    for (const fd of opened) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    return {
      stdio: 'ignore',
      closeParentFds() {}
    };
  }
}

// Resolve the env handed to the Watchdog (and, by inheritance, to the
// RoutingServer it spawns and respawns). Merge order mirrors
// secretInjector.getSecret(): walked-up `.env` -> `.ploinky/.secrets` ->
// `process.env`, with operator-exported values winning. This way the router
// stays able to forward LLM/auth secrets to handlers across crash-restart
// cycles without depending on the operator having `export`'d each one.
function buildRouterEnv() {
  let envFile = {};
  try { envFile = loadEnvFile() || {}; } catch (_) { envFile = {}; }
  let secrets = {};
  try { secrets = readSecretsFile() || {}; } catch (_) { secrets = {}; }
  return { ...envFile, ...secrets, ...process.env };
}

function spawnNoWaitWorker({
  node,
  registryName,
  routeKey,
  registryAlias,
  routerPort,
  forceRecreate = false,
  waitForStatusFile = '',
}) {
  const containerName = registryName;
  const noWaitLogDir = path.join(LOGS_DIR, 'no-wait');
  const noWaitStatusDir = path.join(RUNNING_DIR, 'no-wait');
  fs.mkdirSync(noWaitLogDir, { recursive: true });
  fs.mkdirSync(noWaitStatusDir, { recursive: true });
  const logFile = path.join(noWaitLogDir, `${containerName}.log`);
  const statusFile = path.join(noWaitStatusDir, `${containerName}.json`);
  const workerScript = path.resolve(__dirname, 'noWaitWorker.js');
  const args = [
    workerScript,
    '--container', containerName,
    '--short-agent', node.shortAgentName,
    '--repo', node.repoName,
    '--manifest-path', node.manifestPath,
    '--agent-path', node.agentPath,
    '--route-key', String(routeKey || registryAlias || node.shortAgentName),
  ];
  if (registryAlias) {
    args.push('--alias', registryAlias);
  }
  if (node.profile) {
    args.push('--profile', node.profile);
  }
  if (routerPort) {
    args.push('--router-port', String(routerPort));
  }
  if (forceRecreate) {
    args.push('--force-recreate', '1');
  }
  if (waitForStatusFile) {
    args.push('--wait-for-status', waitForStatusFile);
  }
  // A successor must never mistake a terminal status from an earlier start
  // invocation for completion of this worker.
  try { fs.unlinkSync(statusFile); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const logStdio = createAppendLogStdio(logFile);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: logStdio.stdio,
    env: { ...process.env }
  });
  logStdio.closeParentFds();
  child.unref();
  return { pid: child.pid, logFile, statusFile };
}

function spawnWatchdog(routerPath, port, routerPidFile) {
  const logStdio = createAppendLogStdio(path.join(LOGS_DIR, 'watchdog.log'));
  const child = spawn(process.execPath, [routerPath], {
    detached: true,
    stdio: logStdio.stdio,
    env: {
      ...buildRouterEnv(),
      PORT: String(port),
      PLOINKY_WORKSPACE_ROOT,
      PLOINKY_ROUTER_PID_FILE: routerPidFile
    }
  });
  logStdio.closeParentFds();
  return child;
}

async function waitForRouterReady(port, child, timeoutMs = 15000, {
  createConnection = net.createConnection,
} = {}) {
  const validatedPort = parseRouterPort(port, { source: 'router readiness port' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`router exited before TCP listener became ready (exit ${child.exitCode})`);
    }
    const tcpReady = await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: validatedPort });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(250, () => done(false));
    });
    if (tcpReady) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`router TCP listener did not become ready at 127.0.0.1:${validatedPort}`);
}

function runWithSuspendedInput(callback) {
  const restoreInput = inputState.prepareForExternalCommand?.() || (() => {});
  try {
    return callback();
  } finally {
    restoreInput();
  }
}

function getCliCmd(manifest) {
  const explicitCli =
    (manifest.cli && String(manifest.cli)) ||
    (manifest.commands && manifest.commands.cli);

  if (explicitCli) {
    return explicitCli;
  }

  return '/Agent/default_cli.sh';
}

function shellQuote(str) {
  if (str === undefined || str === null) return "''";
  const s = String(str);
  if (s.length === 0) return "''";
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function wrapCliWithWebchat(command, env = process.env) {
  const trimmed = (command || '').trim();
  if (!trimmed) return trimmed;
  if (env.PLOINKY_SKIP_MANIFEST_CLI_WEBCHAT === '1') {
    return trimmed;
  }
  const enableWrap = env.PLOINKY_MANIFEST_CLI_WEBCHAT === '1';
  if (!enableWrap) {
    return trimmed;
  }
  if (/^(?:\/Agent\/bin\/)?webchat\b/.test(trimmed) || /^ploinky\s+webchat\b/.test(trimmed)) {
    return trimmed;
  }
  return `/Agent/bin/webchat -- ${shellQuote(trimmed)}`;
}

function resolveManifestRouterEndpoint(manifest, {
  explicitPort,
  profileName,
  persistedProfileName,
  routerEndpoint,
  path: manifestPath = 'manifest',
} = {}) {
  const resolution = resolveManifestRuntimeProfile(manifest, {
    profileName,
    persistedProfileName,
    path: manifestPath,
  });
  if (routerEndpoint !== undefined) {
    return assertRouterEndpoint(routerEndpoint, resolution.network.mode, { explicitPort });
  }
  return resolveRouterEndpoint(resolution.network.mode, { explicitPort });
}

function findAgentManifest(agentName) {
  const { manifestPath } = utils.findAgent(agentName);
  return manifestPath;
}

function deduplicateAgentRegistry(reg, getAgentContainerName) {
  const dedup = {};
  const aliasEntries = {};
  const canonical = new Map();

  for (const [key, rec] of Object.entries(reg || {})) {
    if (key === '_config') continue;
    if (!rec || typeof rec !== 'object') {
      dedup[key] = rec;
      continue;
    }
    if (rec.type !== 'agent') {
      dedup[key] = rec;
      continue;
    }
    if (rec.alias) {
      aliasEntries[key] = rec;
      continue;
    }
    if (!rec.agentName) continue;
    const repo = rec.repoName || '';
    const expectedKey = getAgentContainerName(rec.agentName, repo);
    const agentKey = `${repo}::${rec.agentName}`;
    const existing = canonical.get(agentKey);
    if (!existing || key === expectedKey) {
      canonical.set(agentKey, { key: expectedKey, rec });
    }
  }

  for (const { key, rec } of canonical.values()) {
    dedup[key] = rec;
  }
  for (const [aliasKey, rec] of Object.entries(aliasEntries)) {
    dedup[aliasKey] = rec;
  }

  const preservedCfg = workspaceSvc.getConfig();
  if (preservedCfg && Object.keys(preservedCfg).length) {
    dedup._config = preservedCfg;
  }
  return dedup;
}

function findRegistryEntryForGraphNode(reg, node, getAgentContainerName) {
  if (!reg || !node) return null;
  const expectedKey = getAgentContainerName(node.alias || node.shortAgentName, node.repoName);
  const expectedRecord = reg[expectedKey];
  if (
    expectedRecord && expectedRecord.type === 'agent' &&
    expectedRecord.repoName === node.repoName &&
    expectedRecord.agentName === node.shortAgentName &&
    (node.alias ? expectedRecord.alias === node.alias : !expectedRecord.alias)
  ) {
    return { key: expectedKey, rec: expectedRecord };
  }

  for (const [key, rec] of Object.entries(reg || {})) {
    if (key === '_config' || !rec || rec.type !== 'agent') continue;
    if (rec.repoName !== node.repoName || rec.agentName !== node.shortAgentName) continue;
    if (node.alias) {
      if (rec.alias === node.alias) {
        return { key, rec };
      }
      continue;
    }
    if (!rec.alias) {
      return { key, rec };
    }
  }
  if (!node.alias) {
    for (const [key, rec] of Object.entries(reg || {})) {
      if (key === '_config' || !rec || rec.type !== 'agent') continue;
      if (rec.repoName === node.repoName && rec.agentName === node.shortAgentName) {
        return { key, rec };
      }
    }
  }
  return null;
}

function resolveGraphNodeExecutionRecord(node, {
  workspaceRoot = PLOINKY_WORKSPACE_ROOT,
  reposDir = REPOS_DIR,
  getAgentDataDirImpl = getAgentDataDir,
} = {}) {
  const normalized = agentsSvc.normalizeEnableArgs(node.enableSpec || node.agentRef);
  const requestedMode = String(normalized.mode || '').trim().toLowerCase();
  const instanceName = node.alias || node.shortAgentName;

  if (!requestedMode || requestedMode === 'default' || requestedMode === agentsSvc.DEFAULT_ENABLE_AGENT_MODE) {
    return {
      runMode: agentsSvc.DEFAULT_ENABLE_AGENT_MODE,
      projectPath: getAgentDataDirImpl(instanceName),
      develRepo: undefined,
    };
  }
  if (requestedMode === 'global') {
    return {
      runMode: 'global',
      projectPath: workspaceRoot,
      develRepo: undefined,
    };
  }
  if (requestedMode === 'devel') {
    const develRepo = String(normalized.repoNameParam || '').trim();
    if (!develRepo) {
      throw new Error(`Graph node '${node.id}' requests devel mode without a repository name.`);
    }
    const projectPath = path.join(reposDir, develRepo);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      throw new Error(`Repository '${develRepo}' required by graph node '${node.id}' was not found in ${reposDir}.`);
    }
    return { runMode: 'devel', projectPath, develRepo };
  }
  throw new Error(
    `Graph node '${node.id}' requests unknown mode '${requestedMode}'. Allowed: ${agentsSvc.ENABLE_AGENT_MODES.join(' | ')}`,
  );
}

function executionRecordDiffers(record, expected) {
  const currentProjectPath = String(record?.projectPath || '').trim();
  const expectedProjectPath = String(expected.projectPath || '').trim();
  const sameProjectPath = currentProjectPath
    && expectedProjectPath
    && path.resolve(currentProjectPath) === path.resolve(expectedProjectPath);
  const sameDevelRepo = expected.runMode === 'devel'
    ? String(record?.develRepo || '').trim() === expected.develRepo
    : !String(record?.develRepo || '').trim();
  return record?.runMode !== expected.runMode || !sameProjectPath || !sameDevelRepo;
}

function mintChangedRuntimeIdentityPair(record, uuid) {
  const instanceId = String(uuid() || '').trim();
  const enableGeneration = String(uuid() || '').trim();
  const prior = new Set([
    String(record?.instanceId || '').trim(),
    String(record?.enableGeneration || '').trim(),
  ].filter(Boolean));
  if (!instanceId || !enableGeneration
      || instanceId === enableGeneration
      || prior.has(instanceId)
      || prior.has(enableGeneration)) {
    throw new Error('workspace graph could not mint a fresh instanceId/enableGeneration pair');
  }
  return Object.freeze({ instanceId, enableGeneration });
}

function effectiveGraphInstanceKey(node) {
  return node.alias
    ? `${node.repoName}/${node.shortAgentName}#alias:${node.alias}`
    : `${node.repoName}/${node.shortAgentName}#canonical`;
}

function graphNodeRuntimeReplacementReason(plan, {
  containerExistsImpl = dockerSvc.containerExists,
  isContainerRunningImpl = dockerSvc.isContainerRunning,
  isSandboxRunningImpl = isBwrapProcessRunning,
  getRuntimeForAgentImpl = getRuntimeForAgent,
  getRuntimeImpl = getRuntime,
  getContainerLabelImpl = getContainerLabel,
  computeEnvHashImpl = computeEnvHash,
  createNetworkLifecycleAdapterImpl = createNetworkLifecycleAdapter,
  resolvePublishedPortMappingsImpl = resolvePublishedPortMappings,
  isLlmRuntimeManifestImpl = isLlmRuntimeManifest,
  prepareLlmStartupImpl = prepareLlmStartup,
  getManifestEnvNamesImpl = getManifestEnvNames,
  getExposedNamesImpl = getExposedNames,
} = {}) {
  const { node, existing } = plan;
  const record = existing.rec;
  if (!String(record.instanceId || '').trim() || !String(record.enableGeneration || '').trim()) {
    return 'missingRuntimeIdentity';
  }

  const profileResolution = resolveManifestRuntimeProfile(node.manifest, {
    agentName: `${node.repoName}/${node.shortAgentName}`,
    profileName: node.profile || undefined,
    path: `manifest(${node.repoName}/${node.shortAgentName})`,
  });
  const runtimeKind = getRuntimeForAgentImpl(node.manifest);
  const routerEndpoint = resolveManifestRouterEndpoint(node.manifest, {
    explicitPort: resolvePersistedRouterPort(),
    profileName: node.profile || undefined,
    path: `manifest(${node.repoName}/${node.shortAgentName})`,
  });
  if (isSandboxRuntime(runtimeKind)) {
    if (!isSandboxRunningImpl(existing.key, {
      instanceId: record.instanceId,
      enableGeneration: record.enableGeneration,
    })) return 'sandboxRuntimeStopped';
    const desired = computeEnvHashImpl(
      node.manifest,
      profileResolution.profileConfig,
      routerEndpoint?.env || {},
      { agentName: node.shortAgentName, repoName: node.repoName },
    );
    if (desired && desired !== String(record.envHash || '')) return 'envHashChanged';
    return '';
  }

  if (!containerExistsImpl(existing.key)) return 'registeredRuntimeMissing';
  if (!isContainerRunningImpl(existing.key)) return 'runtimeStopped';

  const runtime = getRuntimeImpl();
  const runtimeNetworkPlan = buildRuntimeNetworkPlan(runtime, profileResolution.network);
  const runtimeRouterEnv = buildRuntimeRouterEnv(runtime, {
    routerEndpoint,
    networkMode: profileResolution.network.mode,
  });
  const desiredEnvHash = computeEnvHashImpl(
    node.manifest,
    profileResolution.profileConfig,
    { ...runtimeRouterEnv, ...runtimeNetworkPlan.hashEnv },
    { agentName: node.shortAgentName, repoName: node.repoName },
  );
  if (desiredEnvHash && desiredEnvHash !== getContainerLabelImpl(existing.key, 'ploinky.envhash')) {
    return 'envHashChanged';
  }
  if (isLlmRuntimeManifestImpl(node.manifest, profileResolution.profileConfig)) {
    const probe = prepareLlmStartupImpl({
      runtime,
      manifest: node.manifest,
      profileConfig: profileResolution.profileConfig,
      agentName: node.shortAgentName,
      alias: node.alias || '',
      env: process.env,
      agentWorkDirRoot: AGENTS_DATA_DIR,
      manifestEnvNames: [
        ...getManifestEnvNamesImpl(node.manifest, profileResolution.profileConfig, { forRuntime: true }),
        ...getExposedNamesImpl(node.manifest, profileResolution.profileConfig, { forRuntime: true }),
      ],
      envHash: desiredEnvHash,
      effectiveNetwork: profileResolution.profileConfig?.network ?? node.manifest?.network ?? null,
      writeState: false,
    });
    if (probe.enabled
        && probe.reuseHash
        && probe.reuseHash !== getContainerLabelImpl(existing.key, 'ploinky.reusehash')) {
      return 'llmReuseHashChanged';
    }
  }

  if (profileResolution.network.mode !== 'host' && profileResolution.network.mode !== 'none') {
    const explicitPorts = explicitHttpServicePorts(node.manifest, {
      label: `manifest(${node.repoName}/${node.shortAgentName})`,
    });
    if (explicitPorts.length) {
      const mappings = resolvePublishedPortMappingsImpl(existing.key, record.config?.ports || []);
      const missingTarget = explicitPorts.some((port) => !mappings.some((mapping) => (
        Number(mapping?.containerPort) === port
        && String(mapping?.protocol || 'tcp').toLowerCase() === 'tcp'
        && String(mapping?.hostIp || '') === '127.0.0.1'
        && Number(mapping?.hostPort || 0) > 0
      )));
      if (missingTarget) return 'serviceTargetMappingChanged';
    }
  }

  const inspection = createNetworkLifecycleAdapterImpl({ runtime }).inspectContainerContract(
    existing.key,
    profileResolution.network,
    node.shortAgentName,
    {
      instanceKey: effectiveGraphInstanceKey(node),
      contractHash: networkContractHash(profileResolution.network),
      instanceId: record.instanceId,
      enableGeneration: record.enableGeneration,
      requireRuntimeIdentity: true,
    },
  );
  if (inspection?.state === 'foreign') {
    throw new Error(`refusing graph replacement of foreign runtime '${existing.key}'`);
  }
  if (inspection?.state === 'owned-drift') {
    return inspection.reason === 'runtime-identity'
      ? 'runtimeIdentityDrift'
      : 'networkContractDrift';
  }
  return '';
}

function resolveExtraEnabledRuntimeNodes(graph, reg, getAgentContainerName = dockerSvc.getAgentContainerName) {
  const graphRegistryNames = new Set();
  for (const node of graph?.nodes?.values?.() || []) {
    const existing = findRegistryEntryForGraphNode(reg, node, getAgentContainerName);
    if (existing) graphRegistryNames.add(existing.key);
  }
  return Object.entries(reg || {})
    .filter(([containerName, record]) => (
      containerName !== '_config'
      && record?.type === 'agent'
      && !graphRegistryNames.has(containerName)
    ))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([containerName, record]) => {
      const ref = record.repoName
        ? `${record.repoName}/${record.agentName}`
        : record.agentName;
      const resolved = utils.findAgent(ref);
      const manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
      return {
        id: `extra:${containerName}`,
        agentRef: ref,
        agentPath: path.dirname(resolved.manifestPath),
        alias: record.alias || '',
        manifest,
        manifestPath: resolved.manifestPath,
        profile: record.profile || '',
        repoName: resolved.repo,
        shortAgentName: resolved.shortAgentName,
      };
    });
}

function loadRegistryManifest(record) {
  const manifestRef = `${record.repoName}/${record.agentName}`;
  const manifestPath = findAgentManifest(manifestRef);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function isRegistryRuntimeRunning(containerName, record) {
  if (isSandboxRuntime(record?.runtime)) {
    return isBwrapProcessRunning(record.agentName);
  }
  return dockerSvc.isContainerRunning(containerName);
}

function ensureGraphNodesEnabled(graph, reg, {
  prepareAgentEnableBatch = agentsSvc.prepareAgentEnableBatch,
  removeAgentContainerForRecreate = dockerSvc.removeAgentContainerForRecreate,
  saveAgents = workspaceSvc.saveAgents,
  loadRouting = readRoutingConfig,
  saveRouting = (routing) => writeRoutingConfig(routing, { coordinate: false }),
  inactivateGeneration = inactivateEdgeRoutingGeneration,
  abortPreparation = abortEdgeRoutingPreparation,
  uuid = randomUUID,
  deferredNodeIds = new Set(),
  runtimeReplacementReason = graphNodeRuntimeReplacementReason,
  runtimeReplacementOptions,
  executionRecordOptions,
  additionalNodes = [],
} = {}) {
  const nodes = [
    ...Array.from(graph?.nodes?.values?.() || []),
    ...(Array.isArray(additionalNodes) ? additionalNodes : []),
  ]
    .sort((a, b) => a.id.localeCompare(b.id));

  // Resolve and validate every retained record before removing anything. If a
  // later devel target is invalid, the complete existing stack is left alone.
  const existingPlans = [];
  const missingNodes = [];

  for (const node of nodes) {
    const existing = findRegistryEntryForGraphNode(reg, node, dockerSvc.getAgentContainerName);
    if (!existing) {
      missingNodes.push(node);
      continue;
    }

    const normalizedExecution = agentsSvc.normalizeEnableArgs(node.enableSpec || node.agentRef);
    const hasExplicitExecutionMode = agentsSvc.isEnableAgentMode(normalizedExecution.mode);
    const expectedExecution = hasExplicitExecutionMode
      ? resolveGraphNodeExecutionRecord(node, executionRecordOptions)
      : null;
    const executionChanged = Boolean(
      expectedExecution && executionRecordDiffers(existing.rec, expectedExecution),
    );
    const profileChanged = Boolean(node.profile && existing.rec.profile !== node.profile);
    const preliminary = { node, existing, expectedExecution, executionChanged, profileChanged };
    const runtimeReason = executionChanged || profileChanged
      ? ''
      : String(runtimeReplacementReason(preliminary, runtimeReplacementOptions) || '');
    existingPlans.push({ ...preliminary, runtimeReason });
  }

  const changedPlans = existingPlans
    .filter((plan) => plan.executionChanged || plan.profileChanged || plan.runtimeReason)
    .sort((left, right) => left.node.id.localeCompare(right.node.id));
  const changedContainers = changedPlans.map((plan) => plan.existing.key);
  // Every retained route must be target-less in the prelaunch generation,
  // including a healthy blocking runtime that can later be reused. Keeping a
  // predecessor's resolved hostPort/serviceTargets here would make the topology
  // prepared for hooks only nominally reconciling rather than truly target-less.
  // Identity rotation and physical removal remain limited to changedPlans.
  const stagedPlans = existingPlans
    .sort((left, right) => left.node.id.localeCompare(right.node.id));
  let routing = null;
  if (stagedPlans.length) {
    // Authorization is revoked before either desired-state file changes and
    // before the old process is touched. A failed compile or physical removal
    // intentionally leaves the fresh identity generation selected inactive.
    inactivateGeneration('workspace-graph-runtime-change-prelaunch');
    routing = loadRouting();
    routing.routes = routing.routes || {};
  }

  for (const plan of stagedPlans) {
    const identityChanged = plan.executionChanged || plan.profileChanged || plan.runtimeReason;
    const freshIdentity = identityChanged
      ? mintChangedRuntimeIdentityPair(plan.existing.rec, uuid)
      : null;
    const nextRecord = identityChanged
      ? {
          ...plan.existing.rec,
          instanceId: freshIdentity.instanceId,
          enableGeneration: freshIdentity.enableGeneration,
        }
      : plan.existing.rec;
    if (plan.executionChanged) {
      nextRecord.runMode = plan.expectedExecution.runMode;
      nextRecord.projectPath = plan.expectedExecution.projectPath;
      if (plan.expectedExecution.runMode === 'devel') {
        nextRecord.develRepo = plan.expectedExecution.develRepo;
      } else {
        delete nextRecord.develRepo;
      }
    }
    if (plan.profileChanged) {
      nextRecord.profile = plan.node.profile;
    }
    if (identityChanged) reg[plan.existing.key] = nextRecord;
    const routeKey = nextRecord.alias || plan.node.alias || plan.node.shortAgentName;
    routing.routes[routeKey] = mergeRuntimeRoute(routing.routes[routeKey], {
      container: plan.existing.key,
      hostPath: plan.node.agentPath || routing.routes[routeKey]?.hostPath,
      repo: plan.node.repoName,
      agent: plan.node.shortAgentName,
      ...(nextRecord.alias ? { alias: nextRecord.alias } : {}),
    }, { hostPort: null, serviceTargets: null });
  }

  if (stagedPlans.length) {
    if (changedPlans.length) saveAgents(reg, { coordinate: false });
    saveRouting(routing);
  }

  const prepared = prepareAgentEnableBatch(missingNodes.map((node) => ({
    agentName: node.enableSpec || node.agentRef,
    aliasParam: node.alias || undefined,
    authOptions: {
      profile: node.profile || undefined,
    },
  })), { reason: 'workspace-graph-enable-prelaunch' });
  if (prepared?.preparedGeneration?.selector
      && prepared.preparedGeneration.selector.state !== 'inactive') {
    throw new Error('workspace graph prelaunch generation unexpectedly became active');
  }

  try {
    for (const plan of changedPlans) {
      const reasons = [
        ...(plan.executionChanged ? ['executionModeChanged'] : []),
        ...(plan.profileChanged ? ['profileChanged'] : []),
        ...(plan.runtimeReason ? [plan.runtimeReason] : []),
      ];
      removeAgentContainerForRecreate(
        plan.existing.key,
        `workspaceGraph:${plan.node.id}:${reasons.join('+')}`,
      );
    }
  } catch (error) {
    try {
      inactivateGeneration('workspace-graph-runtime-removal-failed', {
        preserveSelectedGeneration: true,
      });
    } catch (_) {}
    try {
      const lease = prepared?.preparedGeneration?.preparationLease;
      if (lease) abortPreparation(lease, { reason: 'workspace-graph-runtime-removal-failed' });
    } catch (_) {}
    throw error;
  }

  return {
    ...prepared,
    changedContainers: Object.freeze([...changedContainers]),
  };
}

function preparedContainerNames(preparedGraph) {
  return new Set([
    ...(preparedGraph?.plans || []).map((plan) => plan.containerName),
    ...(preparedGraph?.changedContainers || []),
  ].filter(Boolean));
}

/**
 * Startup providers may change secrets consumed by a retained runtime. The
 * early generation exists so hooks can safely read target-less topology, but
 * it cannot remain the runtime-identity authority after those providers run.
 * Abort that lease, re-evaluate every predecessor that was not already staged,
 * and capture one fresh target-less generation before any process launch.
 */
function reprepareGraphAfterStartupProviders(graph, reg, initialPreparedGraph, {
  deferredNodeIds = new Set(),
  additionalNodes = [],
  abortPreparation = abortEdgeRoutingPreparation,
  ensureGraphNodesEnabledImpl = ensureGraphNodesEnabled,
  runtimeReplacementReason = graphNodeRuntimeReplacementReason,
  runtimeReplacementOptions,
  graphEnableOptions = {},
} = {}) {
  const initialLease = initialPreparedGraph?.preparedGeneration?.preparationLease;
  if (!initialLease) {
    throw new Error('start: startup-provider identity re-evaluation requires the exact early preparation lease');
  }
  const alreadyPrepared = preparedContainerNames(initialPreparedGraph);

  abortPreparation(initialLease, {
    reason: 'workspace-start-provider-reprepare',
  });

  const preparedGraph = ensureGraphNodesEnabledImpl(graph, reg, {
    ...graphEnableOptions,
    deferredNodeIds,
    additionalNodes,
    runtimeReplacementOptions,
    runtimeReplacementReason(plan, options) {
      // A record minted earlier in this same start has no predecessor running
      // under that tuple. Re-check only retained predecessor identities; those
      // must rotate if preinstall/provider output changed their runtime hash.
      if (alreadyPrepared.has(plan.existing.key)) return '';
      return runtimeReplacementReason(plan, options);
    },
  });
  if (preparedGraph?.preparedGeneration?.selector?.state !== 'inactive') {
    throw new Error('start: post-provider graph generation did not remain inactive');
  }

  const allPrepared = preparedContainerNames(preparedGraph);
  for (const containerName of alreadyPrepared) allPrepared.add(containerName);
  return Object.freeze({
    preparedGraph,
    preparedContainerNames: Object.freeze([...allPrepared]),
  });
}

function formatGraphNodeLabel(node, staticLabel) {
  if (!node) return '';
  if (node.isStatic) {
    return staticLabel || node.shortAgentName;
  }
  if (node.alias) {
    return `${node.shortAgentName} as ${node.alias}`;
  }
  return node.shortAgentName;
}

function buildReadinessEntryFromNode(node, route, staticLabel) {
  const timeoutMs = Number.parseInt(
    process.env[node.isStatic ? 'PLOINKY_STATIC_AGENT_READY_TIMEOUT_MS' : 'PLOINKY_DEPENDENCY_AGENT_READY_TIMEOUT_MS']
      || '120000',
    10
  );
  const intervalMs = Number.parseInt(
    process.env[node.isStatic ? 'PLOINKY_STATIC_AGENT_READY_INTERVAL_MS' : 'PLOINKY_DEPENDENCY_AGENT_READY_INTERVAL_MS']
      || '250',
    10
  );
  const probeTimeoutMs = Number.parseInt(
    process.env[node.isStatic ? 'PLOINKY_STATIC_AGENT_READY_PROBE_TIMEOUT_MS' : 'PLOINKY_DEPENDENCY_AGENT_READY_PROBE_TIMEOUT_MS']
      || '1000',
    10
  );

  const protocol = resolveAgentReadinessProtocol(node.manifest);
  const entry = {
    key: node.id,
    label: formatGraphNodeLabel(node, staticLabel),
    kind: node.isStatic ? 'static' : 'dependency',
    route,
    protocol,
    timeoutMs,
    intervalMs,
    probeTimeoutMs
  };
  if (protocol === 'script') {
    entry.scriptProbe = normalizeProbeConfig('readiness', node.manifest?.health?.readiness);
  }
  return entry;
}

function resolveManifestReadinessWaitOptions(manifest, fallbackTimeoutMs = 120000) {
  const probe = manifest?.health?.readiness && typeof manifest.health.readiness === 'object'
    ? manifest.health.readiness
    : null;
  if (!probe) {
    return {
      timeoutMs: fallbackTimeoutMs,
      intervalMs: 250,
      probeTimeoutMs: 1000
    };
  }
  const intervalSeconds = Number.parseInt(probe.interval ?? '1', 10);
  const timeoutSeconds = Number.parseInt(probe.timeout ?? '1', 10);
  const failureThreshold = Number.parseInt(probe.failureThreshold ?? '120', 10);
  const intervalMs = Math.max(1, Number.isFinite(intervalSeconds) ? intervalSeconds : 1) * 1000;
  const probeTimeoutMs = Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 1) * 1000;
  const attempts = Math.max(1, Number.isFinite(failureThreshold) ? failureThreshold : 120);
  return {
    timeoutMs: Math.max(fallbackTimeoutMs, attempts * (intervalMs + probeTimeoutMs)),
    intervalMs,
    probeTimeoutMs
  };
}

function buildBlockingReadinessEntryFromNode(node, route, staticLabel) {
  const entry = buildReadinessEntryFromNode(node, route, staticLabel);
  if (entry.protocol === 'script' && !route?.container) {
    throw new Error(`${node.isStatic ? 'Static agent' : 'Dependent agent'} '${formatGraphNodeLabel(node, staticLabel)}' did not resolve its service container for script readiness.`);
  }
  if (!route?.hostPort && entry.protocol !== 'none') {
    if (entry.protocol === 'script') {
      return entry;
    }
    if (resolveAgentExecutionMode(node.manifest).type === 'start_only') {
      throw new Error(
        `${node.isStatic ? 'Static agent' : 'Dependent agent'} '${formatGraphNodeLabel(node, staticLabel)}' is start-only but has no reachable readiness contract. `
        + 'Declare health.readiness.script, an httpServices[].port target, or readiness.protocol none.'
      );
    }
    throw new Error(`${node.isStatic ? 'Static agent' : 'Dependent agent'} '${formatGraphNodeLabel(node, staticLabel)}' did not expose a host port.`);
  }
  return entry;
}

function readinessKindLabel(entry) {
  if (entry.kind === 'static') return 'Static agent';
  if (entry.kind === 'reinstall') return 'Reinstalled agent';
  return 'Dependent agent';
}

function formatReadyProgress({ elapsedMs, timeoutMs, portOpen, protocol, stage, lastError }) {
  const elapsedSec = Math.floor(Math.max(0, elapsedMs) / 1000);
  const timeoutSec = Math.floor(Math.max(0, timeoutMs) / 1000);
  if (stage === 'waiting_for_port') {
    return `still waiting (${elapsedSec}s/${timeoutSec}s): port not open yet${lastError ? `, last probe=${lastError}` : ''}`;
  }
  if (protocol === 'tcp') {
    return `still waiting (${elapsedSec}s/${timeoutSec}s): port is open, waiting for TCP readiness`;
  }
  if (portOpen && stage === 'waiting_for_protocol') {
    return `still waiting (${elapsedSec}s/${timeoutSec}s): port is open, waiting for MCP handshake`;
  }
  return `still waiting (${elapsedSec}s/${timeoutSec}s)`;
}

async function waitForReadinessEntries(readinessEntries, options = {}) {
  const waitForAgentReadyImpl = options.waitForAgentReadyImpl || waitForAgentReady;
  const runContainerScriptReadinessImpl = options.runContainerScriptReadinessImpl || runContainerScriptReadiness;
  const readinessProgress = new Map();
  const readinessStartAt = Date.now();
  let lastSummaryBucket = -1;

  const summarizeReadiness = ({ force = false } = {}) => {
    const elapsedMs = Date.now() - readinessStartAt;
    const bucket = Math.floor(elapsedMs / 5000);
    if (!force) {
      if (bucket <= 0 || bucket === lastSummaryBucket) return;
    }
    lastSummaryBucket = bucket;
    const readyCount = readinessEntries.reduce((count, entry) => {
      const state = readinessProgress.get(entry.key);
      return count + (state?.ready ? 1 : 0);
    }, 0);
    const waiting = readinessEntries
      .filter((entry) => !(readinessProgress.get(entry.key)?.ready))
      .map((entry) => {
        const state = readinessProgress.get(entry.key) || {};
        if (state.elapsedMs) {
          return `${entry.label} (${formatReadyProgress({
            elapsedMs: state.elapsedMs,
            timeoutMs: entry.timeoutMs,
            portOpen: Boolean(state.portOpen),
            protocol: entry.protocol,
            stage: state.stage,
            lastError: state.lastError
          })})`;
        }
        return `${entry.label} (starting)`;
      });
    console.log(`[start] Readiness ${readyCount}/${readinessEntries.length} ready.${waiting.length ? ` Waiting on: ${waiting.join(', ')}` : ''}`);
  };

  for (const entry of readinessEntries) {
    const waitLabel = entry.kind === 'static' ? 'static agent' : (entry.kind === 'reinstall' ? 'reinstalled agent' : 'dependent agent');
    if (entry.protocol === 'none') {
      console.log(`[start] Marking ${waitLabel} '${entry.label}' ready (no port-bound readiness probe).`);
    } else if (entry.protocol === 'script') {
      console.log(`[start] Waiting for ${waitLabel} '${entry.label}' to pass container script './${entry.scriptProbe.script}'...`);
    } else {
      console.log(`[start] Waiting for ${waitLabel} '${entry.label}' to become ready on port ${entry.route.hostPort}...`);
    }
    readinessProgress.set(entry.key, {
      ready: false,
      stage: 'starting',
      elapsedMs: 0,
      portOpen: false,
      lastError: null
    });
  }
  if (readinessEntries.length) {
    console.log(`[start] Tracking readiness for ${readinessEntries.length} agent(s): ${readinessEntries.map((entry) => entry.label).join(', ')}`);
  }

  await Promise.all(readinessEntries.map(async (entry) => {
    if (entry.protocol === 'none') {
      readinessProgress.set(entry.key, {
        elapsedMs: 0,
        ready: true,
        stage: 'ready',
        portOpen: false,
        lastError: null
      });
      summarizeReadiness();
      return;
    }
    if (entry.protocol === 'script') {
      const result = await Promise.resolve(runContainerScriptReadinessImpl(
        entry.label,
        entry.route.container,
        entry.scriptProbe
      ));
      if (result?.status !== 'success') {
        const reason = result?.reason || 'unknown failure';
        const detail = result?.detail ? `, output='${result.detail}'` : '';
        throw new Error(`${readinessKindLabel(entry)} '${entry.label}' failed readiness script './${entry.scriptProbe.script}' (${reason}${detail}).`);
      }
      readinessProgress.set(entry.key, {
        elapsedMs: Date.now() - readinessStartAt,
        ready: true,
        stage: 'ready',
        portOpen: false,
        lastError: null
      });
      console.log(`[start] ${entry.label}: container script readiness passed.`);
      summarizeReadiness({ force: true });
      return;
    }
    const ready = await waitForAgentReadyImpl(entry.route, {
      timeoutMs: entry.timeoutMs,
      intervalMs: entry.intervalMs,
      probeTimeoutMs: entry.probeTimeoutMs,
      protocol: entry.protocol,
      onProgress: (progress) => {
        readinessProgress.set(entry.key, {
          ...progress,
          ready: Boolean(progress?.ready),
          stage: progress?.stage || 'starting',
          portOpen: Boolean(progress?.portOpen),
          lastError: progress?.lastError || null
        });
        summarizeReadiness();
      }
    });
    if (!ready) {
      throw new Error(`${readinessKindLabel(entry)} '${entry.label}' did not become ready within ${entry.timeoutMs}ms.`);
    }
    const elapsedMs = Number(readinessProgress.get(entry.key)?.elapsedMs || 0);
    const elapsedSec = Math.floor(elapsedMs / 1000);
    readinessProgress.set(entry.key, {
      ...(readinessProgress.get(entry.key) || {}),
      ready: true,
      stage: 'ready',
      portOpen: true,
      elapsedMs
    });
    console.log(`[start] ${entry.label}: ready after ${elapsedSec}s.`);
    summarizeReadiness({ force: true });
  }));
}

async function waitForManifestReadiness({ key, label, kind = 'dependency', manifest, route }, options = {}) {
  try {
    const node = {
      id: key || label,
      shortAgentName: label,
      isStatic: kind === 'static',
      manifest
    };
    const entry = buildBlockingReadinessEntryFromNode(node, route, label);
    entry.kind = kind;
    entry.label = label;
    if (kind === 'reinstall' && entry.protocol !== 'script') {
      Object.assign(entry, resolveManifestReadinessWaitOptions(manifest, 15000));
    }
    await waitForReadinessEntries([entry], options);
  } catch (error) {
    const readinessError = new Error(error?.message || String(error), { cause: error });
    readinessError.code = 'PLOINKY_READINESS_FAILED';
    throw readinessError;
  }
}

async function activatePreparedRuntimeAfterReadiness({
  result,
  routeKey,
  repoName,
  shortAgentName,
  agentPath,
  alias = '',
}) {
  if (!result?.requiresEdgeActivation) return false;
  if (!result?.containerName || !result?.registryRecord) {
    throw new Error('runtime replacement activation requires one exact returned container and registry record');
  }
  if (!result?.preparationLease) {
    throw new Error('runtime replacement activation requires its exact preparation lease');
  }
  try {
    await mergeRoutingConfig((cfg) => {
      const agents = workspaceSvc.loadAgents();
      agents[result.containerName] = result.registryRecord;
      workspaceSvc.saveAgents(agents, { coordinate: false });
      cfg.routes = cfg.routes || {};
      cfg.routes[routeKey] = {
        ...(cfg.routes[routeKey] || {}),
        container: result.containerName,
        hostPath: agentPath,
        repo: repoName,
        agent: shortAgentName,
        ...(alias ? { alias } : {}),
        ...(result.hostPort ? { hostPort: result.hostPort } : {}),
        ...(result.serviceTargets && Object.keys(result.serviceTargets).length
          ? { serviceTargets: result.serviceTargets }
          : {}),
      };
      if (!result.hostPort) delete cfg.routes[routeKey].hostPort;
      if (!result.serviceTargets || !Object.keys(result.serviceTargets).length) {
        delete cfg.routes[routeKey].serviceTargets;
      }
      return cfg;
    }, {
      reason: 'runtime-replacement-ready',
      preparationLease: result.preparationLease,
    });
    return true;
  } catch (error) {
    try {
      inactivateEdgeRoutingGeneration('runtime-replacement-activation-failed', {
        preserveSelectedGeneration: true,
      });
    } catch (_) {}
    try {
      abortEdgeRoutingPreparation(result.preparationLease, {
        reason: 'runtime-replacement-activation-failed',
      });
    } catch (_) {}
    throw error;
  }
}

async function resolveAndPersistStartRouterPort(staticAgentArg, portArg, {
  coordinate = true,
} = {}) {
  const configuredStatic = workspaceSvc.getConfig()?.static;
  const isInitialRouterStartup = Boolean(staticAgentArg) && !configuredStatic?.agent;
  const resolvedStartPort = isInitialRouterStartup
    ? resolveInitialRouterPort({ explicitPort: portArg })
    : resolvePersistedRouterPort({ explicitPort: portArg });
  const update = (current) => {
    if (Object.prototype.hasOwnProperty.call(current, 'port')) {
      const lockedPort = parseRouterPort(current.port, { source: 'persisted router port' });
      if (lockedPort !== resolvedStartPort) {
        const error = new Error(`explicit router port ${resolvedStartPort} does not match persisted router port ${lockedPort}`);
        error.code = 'PLOINKY_ROUTER_PORT_MISMATCH';
        throw error;
      }
    }
    return {
      ...current,
      port: resolvedStartPort,
      routes: current.routes || {},
    };
  };
  if (coordinate) {
    await mergeRoutingConfig(update);
  } else {
    const current = readRoutingConfig();
    writeRoutingConfig(update(current), { coordinate: false });
  }
  return resolvedStartPort;
}

function assertStaticPreinstallSucceeded(result) {
  if (result?.success === true) return result;
  throw new Error(`static preinstall hook failed: ${result?.message || 'unknown hook failure'}`);
}

async function startWorkspace(staticAgentArg, portArg, {
  killRouterIfRunning,
  branchPolicy,
} = {}) {
  // The workspace mutation lease covers source initialization, candidate
  // writes, both inactive prelaunch preparations, and every subsequent start.
  // Only the final post-provider lease may authorize runtime targets.
  resetPreinstallRunInProcess();
  const workspaceStartLock = createWorkspaceStartLock();
  let workspacePreparationLease = null;
  try {
  initializeFreshEdgeRoutingSources({ workspaceRoot: PLOINKY_WORKSPACE_ROOT });
  inactivateEdgeRoutingGeneration('workspace-start-prepare', { workspaceRoot: PLOINKY_WORKSPACE_ROOT });
  const resolvedStartPort = await resolveAndPersistStartRouterPort(staticAgentArg, portArg, {
    coordinate: false,
  });
  let routerReadyForStart = false;
  let routerPortForStart = 0;
  let routerContainerForStart = '';
  const ensureRouterReadyForStart = async ({ staticAgent, staticPort, repoName, shortAgentName }) => {
    const container = dockerSvc.getAgentContainerName(shortAgentName || staticAgent, repoName || '');
    if (routerReadyForStart) {
      if (routerPortForStart !== staticPort || routerContainerForStart !== container) {
        throw new Error('start: resolved static routing identity changed after the router listener became ready');
      }
      const routingCandidate = readRoutingConfig();
      writeRoutingConfig({
        ...routingCandidate,
        port: staticPort,
        static: { agent: staticAgent, container },
        routes: routingCandidate.routes || {},
      }, { coordinate: false });
      return container;
    }

    const routingCandidate = readRoutingConfig();
    writeRoutingConfig({
      ...routingCandidate,
      port: staticPort,
      static: { agent: staticAgent, container },
      routes: routingCandidate.routes || {},
    }, { coordinate: false });
    console.log(`Static: agent=${utils.colorize(staticAgent, 'cyan')} port=${utils.colorize(String(staticPort), 'yellow')}`);
    try {
      await waitForRouterReady(staticPort, null, 300);
      routerReadyForStart = true;
      routerPortForStart = staticPort;
      routerContainerForStart = container;
      console.log('[start] Existing router TCP listener is ready.');
      return container;
    } catch (_) {
      // No TCP listener exists. Replace only the router process.
    }
    if (typeof killRouterIfRunning === 'function') {
      try { killRouterIfRunning(); } catch (_) {}
    }
    const runningDir = RUNNING_DIR;
    fs.mkdirSync(runningDir, { recursive: true });
    const routerPath = path.resolve(__dirname, '../server/Watchdog.js');
    const routerPidFile = path.join(runningDir, 'router.pid');
    const child = spawnWatchdog(routerPath, staticPort, routerPidFile);
    try { fs.writeFileSync(routerPidFile, String(child.pid)); } catch (_) {}
    child.unref();
    await waitForRouterReady(staticPort, child);
    routerReadyForStart = true;
    routerPortForStart = staticPort;
    routerContainerForStart = container;
    console.log(`[start] Watchdog launched in background (pid ${child.pid}); router TCP listener is ready.`);
    return container;
  };
    if (staticAgentArg) {
      let aliasResolved = null;
      try {
        const resolvedAliasRecord = agentsSvc.resolveEnabledAgentRecord(staticAgentArg);
        if (resolvedAliasRecord && resolvedAliasRecord.record && resolvedAliasRecord.record.alias) {
          aliasResolved = `${resolvedAliasRecord.record.repoName}/${resolvedAliasRecord.record.agentName}`;
        }
      } catch (_) {
        aliasResolved = null;
      }
      const portNum = resolvedStartPort;
      const cfg = workspaceSvc.getConfig() || {};
      cfg.static = { agent: aliasResolved || staticAgentArg, port: portNum };
      workspaceSvc.setConfig(cfg);
    }
    const cfg0 = workspaceSvc.getConfig() || {};
    const staticAgentCfg = cfg0?.static?.agent;
    let normalizedStaticAgent = staticAgentCfg;
    if (staticAgentCfg) {
      try {
        const aliasRecord = agentsSvc.resolveEnabledAgentRecord(staticAgentCfg);
        if (aliasRecord && aliasRecord.record && aliasRecord.record.alias) {
          normalizedStaticAgent = `${aliasRecord.record.repoName}/${aliasRecord.record.agentName}`;
        }
      } catch (_) {
        normalizedStaticAgent = staticAgentCfg;
      }
    }
    if (!cfg0.static || !cfg0.static.agent || !cfg0.static.port) {
      throw new Error('start: missing static agent or port. Usage: start <staticAgent> <port> (first time).');
    }
    const staticAgent = normalizedStaticAgent || cfg0.static.agent;
    const staticPort = parseRouterPort(cfg0.static.port, { source: 'workspace static router port' });
    if (staticPort !== resolvedStartPort) {
      throw new Error(`start: workspace static router port ${staticPort} does not match persisted router port ${resolvedStartPort}`);
    }
    let staticRepoName = null;
    let staticShortAgent = null;

    try {
      const resolvedStaticAgent = utils.findAgent(staticAgent);
      staticRepoName = resolvedStaticAgent.repo;
      staticShortAgent = resolvedStaticAgent.shortAgentName;
    } catch (e) {
      throw new Error(`start: Agent '${staticAgent}' not found in any repo. Use 'enable agent <repo/name>' or check repos.`);
    }
    await ensureRouterReadyForStart({
      staticAgent,
      staticPort,
      repoName: staticRepoName,
      shortAgentName: staticShortAgent,
    });

    // Install/prepare the complete manifest repo graph without starting any
    // consumer, then compile one target-less inactive edge generation. Static
    // preinstall and config-provider hooks receive that exact topology before
    // any agent process or container is allowed to start.
    try {
      await prepareManifestRepositories(cfg0.static.agent, {
        branchPolicy,
        profile: getActiveProfile(),
      });
    } catch (err) {
      throw new Error(`Failed to prepare manifest repositories for '${cfg0.static.agent}': ${err?.message || err}`);
    }
    const providerRegistry = deduplicateAgentRegistry(
      workspaceSvc.loadAgents(),
      dockerSvc.getAgentContainerName,
    );
    let dependencyGraph;
    try {
      dependencyGraph = resolveWorkspaceDependencyGraph({
        staticAgentRef: staticAgent,
        registry: providerRegistry,
      });
    } catch (graphErr) {
      throw new Error(`Failed to resolve dependency graph for '${staticAgent}': ${graphErr.message}`);
    }

    let reg = providerRegistry;
    workspaceSvc.saveAgents(reg);

    const { getAgentContainerName, ensureAgentService } = dockerSvc;

    const waitClassification = classifyDependencyGraphWaitMode(dependencyGraph);
    const extraRuntimeNodes = resolveExtraEnabledRuntimeNodes(
      dependencyGraph,
      reg,
      dockerSvc.getAgentContainerName,
    );
    let preparedGraph = ensureGraphNodesEnabled(dependencyGraph, reg, {
      deferredNodeIds: waitClassification.noWait,
      additionalNodes: extraRuntimeNodes,
    });
    workspacePreparationLease = preparedGraph?.preparedGeneration?.preparationLease || null;
    if (preparedGraph?.preparedGeneration?.selector?.state !== 'inactive') {
      throw new Error('start: graph prelaunch generation did not remain inactive');
    }

    // Run the static (main) agent preinstall only after the inactive topology
    // exists. This hook may populate values consumed by startup config
    // providers, but it must never observe raw candidate files before their
    // coordinated generation has been captured and validated.
    try {
      const staticAgentForPreinstall = cfg0.static.agent;
      if (staticAgentForPreinstall) {
        const resolved = utils.findAgent(staticAgentForPreinstall);
        if (resolved) {
          const agentPath = path.dirname(resolved.manifestPath);
          const activeProfile = getActiveProfile();
          const profileConfig = getProfileConfig(`${resolved.repo}/${resolved.shortAgentName}`, activeProfile);
          if (profileConfig?.preinstall) {
            console.log(`[start] Running preinstall hook for ${resolved.shortAgentName} (profile: ${activeProfile})...`);
            const hookValue = isInlineCommand(profileConfig.preinstall)
              ? profileConfig.preinstall
              : path.join(agentPath, profileConfig.preinstall);

            const envVars = getProfileEnvVars(resolved.shortAgentName, resolved.repo, activeProfile, {});
            let manifestEnv = {};
            try {
              const manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
              manifestEnv = buildEnvMap(manifest, profileConfig, {
                agentName: resolved.shortAgentName,
                repoName: resolved.repo,
              });
            } catch (_) {}
            const secrets = profileConfig.secrets ? getSecrets(profileConfig.secrets) : {};
            const hookEnv = {
              ...createEnvWithSecrets({ ...envVars, ...manifestEnv }, secrets),
              ...edgeRuntimeEnvironment('host', { workspaceRoot: PLOINKY_WORKSPACE_ROOT }),
            };

            const result = executeHostHook(hookValue, hookEnv, { cwd: PLOINKY_WORKSPACE_ROOT });
            assertStaticPreinstallSucceeded(result);
            markPreinstallRunInProcess(resolved.shortAgentName, resolved.repo, activeProfile);
          }
        }
      }
    } catch (preErr) {
      throw new Error(`start: static preinstall preflight failed: ${preErr?.message || preErr}`);
    }

    try {
      const providerResult = await applyStartupConfigProvidersForGraph({
        dependencyGraph,
        profileName: getActiveProfile(),
        workspaceRoot: PLOINKY_WORKSPACE_ROOT,
      });
      if (providerResult.providers.length) {
        const appliedNames = providerResult.applied.map((entry) => entry.name);
        const appliedSummary = appliedNames.length ? appliedNames.join(', ') : 'no changed values';
        console.log(`[start] Startup config providers applied: ${appliedSummary}`);
        for (const warning of providerResult.warnings) {
          console.warn(`[start] Config provider warning: ${warning}`);
        }
      }
    } catch (providerErr) {
      throw new Error(`Startup config provider preflight failed: ${providerErr?.message || providerErr}`);
    }

    // Preinstall/provider output can change a retained runtime's effective
    // environment after the early topology generation was captured. Re-check
    // predecessor identities now and replace the early lease before any launch.
    // The early batch persisted newly enabled records, so reload them before
    // re-preparation; otherwise they would be mistaken for missing a second
    // time instead of retaining their already-fresh, never-launched tuple.
    reg = deduplicateAgentRegistry(workspaceSvc.loadAgents(), getAgentContainerName);
    const postProviderPreparation = reprepareGraphAfterStartupProviders(
      dependencyGraph,
      reg,
      preparedGraph,
      {
        deferredNodeIds: waitClassification.noWait,
        additionalNodes: extraRuntimeNodes,
      },
    );
    preparedGraph = postProviderPreparation.preparedGraph;
    workspacePreparationLease = preparedGraph?.preparedGeneration?.preparationLease || null;

    const newlyPreparedContainers = new Set(postProviderPreparation.preparedContainerNames);
    reg = deduplicateAgentRegistry(workspaceSvc.loadAgents(), getAgentContainerName);
    let cfg = readRoutingConfig();
    cfg.routes = cfg.routes || {};

    const allNames = Object.keys(reg || {}).filter((name) => name !== '_config');
    const graphWaves = topologicallyGroupDependencyGraph(dependencyGraph);
    const { noWait: noWaitNodeIds } = waitClassification;
    const graphRegistryNames = new Set();
    const registryNameByNodeId = new Map();
    const graphWaveNames = graphWaves.map((waveNodeIds) => waveNodeIds.map((nodeId) => {
      const node = dependencyGraph.nodes.get(nodeId);
      const registryEntry = findRegistryEntryForGraphNode(reg, node, getAgentContainerName);
      if (!registryEntry) {
        throw new Error(`Graph node '${nodeId}' is not enabled in the workspace registry.`);
      }
      graphRegistryNames.add(registryEntry.key);
      registryNameByNodeId.set(nodeId, registryEntry.key);
      return registryEntry.key;
    }));
    if (noWaitNodeIds.size) {
      const labels = Array.from(noWaitNodeIds).map((nodeId) => {
        const node = dependencyGraph.nodes.get(nodeId);
        return node ? formatGraphNodeLabel(node, staticAgent) : nodeId;
      });
      console.log(`[start] No-wait dependencies (background launch): ${labels.join(', ')}`);
    }

    const staticNode = dependencyGraph.nodes.get(dependencyGraph.staticNodeId);
    const staticRegistryEntry = findRegistryEntryForGraphNode(reg, staticNode, getAgentContainerName);
    const staticContainer = staticRegistryEntry?.key || getAgentContainerName(staticShortAgent || staticAgent, staticRepoName || '');

    if (Number(cfg.port) !== staticPort
        || cfg.static?.agent !== staticAgent
        || cfg.static?.container !== staticContainer) {
      throw new Error('start: prepared routing generation does not contain the exact static Router identity');
    }
    const updateRoutes = async (targetNames = [], { allowFailures = false } = {}) => {
      if (!Array.isArray(targetNames) || !targetNames.length) {
        return { failedAgents: [], routeResults: [] };
      }
      cfg.routes = cfg.routes || {};
      const failedAgents = [];
      const routeResults = await Promise.all(targetNames.map(async (name) => {
        const rec = reg[name];
        if (!rec || !rec.agentName) return null;
        const shortAgentName = rec.agentName;
        const manifestRef = rec.repoName ? `${rec.repoName}/${shortAgentName}` : shortAgentName;
        try {
          const manifestPath0 = findAgentManifest(manifestRef);
          const manifest = JSON.parse(fs.readFileSync(manifestPath0, 'utf8'));
          const agentPath = path.dirname(manifestPath0);
          const repoName = rec.repoName || path.basename(path.dirname(agentPath));
          const routeKey = rec.alias || shortAgentName;
          const routerEndpoint = resolveManifestRouterEndpoint(manifest, {
            explicitPort: staticPort,
            persistedProfileName: rec.profile,
            path: `manifest(${repoName}/${shortAgentName})`,
          });
          const launchProfile = resolveManifestRuntimeProfile(manifest, {
            agentName: `${repoName}/${shortAgentName}`,
            profileName: rec.profile || undefined,
            path: `manifest(${repoName}/${shortAgentName})`,
          });
          const preparedHostModeCapability = launchProfile.network.mode === 'host'
            ? prepareHostModeCapabilityForInactiveGeneration({
                agentId: `agent:${repoName}/${shortAgentName}`,
                instanceId: rec.instanceId,
                enableGeneration: rec.enableGeneration,
                routeKey,
                containerName: name,
              })
            : undefined;
          const { containerName, hostPort, serviceTargets, registryRecord } = ensureAgentService(shortAgentName, manifest, agentPath, {
            containerName: name,
            alias: rec.alias,
            routerEndpoint,
            profileName: rec.profile || undefined,
            instanceId: rec.instanceId,
            enableGeneration: rec.enableGeneration,
            forceRecreate: newlyPreparedContainers.has(name),
            preservePreparedRegistryRecord: true,
            preparationLease: workspacePreparationLease,
            preparedHostModeCapability,
          });
          if (!registryRecord) {
            throw new Error(`runtime '${containerName}' returned no exact registry record`);
          }
          const executionMode = resolveAgentExecutionMode(manifest);
          const resolvedHostPort = hostPort || (
            executionMode.type === 'start_only' ? 0 : cfg.routes[routeKey]?.hostPort
          );
          const nextRoute = {
            ...(cfg.routes[routeKey] || {}),
            container: containerName,
            hostPath: agentPath,
            repo: repoName,
            agent: shortAgentName,
            ...(rec.alias ? { alias: rec.alias } : {}),
            ...(resolvedHostPort ? { hostPort: resolvedHostPort } : {}),
            ...(serviceTargets && Object.keys(serviceTargets).length ? { serviceTargets } : {})
          };
          if (!resolvedHostPort) delete nextRoute.hostPort;
          if (!serviceTargets || !Object.keys(serviceTargets).length) delete nextRoute.serviceTargets;
          return {
            ok: true,
            containerName,
            registryRecord,
            shortAgentName,
            routeKey,
            route: nextRoute,
            manifest,
          };
        } catch (agentErr) {
          console.error(`[start] Failed to start agent '${shortAgentName}': ${agentErr.message}`);
          return {
            ok: false,
            shortAgentName
          };
        }
      }));
      for (const result of routeResults) {
        if (!result) continue;
        if (!result.ok) {
          failedAgents.push(result.shortAgentName);
          continue;
        }
        cfg.routes[result.routeKey] = result.route;
      }
      cfg = await mergeRoutingConfig((current) => {
        for (const result of routeResults) {
          if (!result?.ok) continue;
          reg[result.containerName] = result.registryRecord;
        }
        const next = {
          ...current,
          ...cfg,
          routes: {
            ...(cfg.routes || {}),
            ...(current.routes || {})
          }
        };
        for (const result of routeResults) {
          if (!result?.ok) continue;
          next.routes[result.routeKey] = result.route;
        }
        return next;
      }, { coordinate: false });
      if (failedAgents.length > 0) {
        const message = `${failedAgents.length} agent(s) failed to start: ${failedAgents.join(', ')}`;
        if (allowFailures) {
          console.warn(`[start] ${message}`);
          return { failedAgents, routeResults: routeResults.filter((result) => result?.ok) };
        }
        throw new Error(message);
      }
      return { failedAgents, routeResults: routeResults.filter((result) => result?.ok) };
    };

    const deferredNoWaitLaunches = [];
    for (let waveIndex = 0; waveIndex < graphWaves.length; waveIndex += 1) {
      const waveNodeIds = graphWaves[waveIndex];
      const waveNodes = waveNodeIds
        .map((nodeId) => dependencyGraph.nodes.get(nodeId))
        .filter(Boolean);
      if (!waveNodes.length) continue;

      // Blocking nodes follow the wave-by-wave start/readiness path. Defer
      // detached no-wait workers until every coordinated blocking launch is
      // complete so their independent route applies cannot transiently
      // inactivate an exact host-generation capability during process create.
      const blockingNodes = [];
      const blockingNames = [];
      const noWaitWaveNodes = [];
      for (const node of waveNodes) {
        const registryName = registryNameByNodeId.get(node.id);
        if (noWaitNodeIds.has(node.id)) {
          noWaitWaveNodes.push({ node, registryName });
        } else {
          blockingNodes.push(node);
          if (registryName) blockingNames.push(registryName);
        }
      }

      const blockingLabel = blockingNodes.length
        ? blockingNodes.map((node) => formatGraphNodeLabel(node, staticAgent)).join(', ')
        : '<none>';
      const noWaitLabel = noWaitWaveNodes.length
        ? noWaitWaveNodes.map(({ node }) => formatGraphNodeLabel(node, staticAgent)).join(', ')
        : '';
      const waveSummary = noWaitLabel
        ? `${blockingLabel}${noWaitLabel ? ` (no-wait: ${noWaitLabel})` : ''}`
        : blockingLabel;
      console.log(`[start] Dependency wave ${waveIndex + 1}/${graphWaves.length}: ${waveSummary}`);

      deferredNoWaitLaunches.push(...noWaitWaveNodes);

      if (blockingNames.length) {
        await updateRoutes(blockingNames);
      }

      if (!blockingNodes.length) continue;

      const readinessEntries = blockingNodes.map((node) => {
        const registryName = registryNameByNodeId.get(node.id);
        const registryRecord = registryName ? reg[registryName] : null;
        const routeKey = registryRecord?.alias || node.alias || node.shortAgentName;
        const route = cfg.routes?.[routeKey] || null;
        return buildBlockingReadinessEntryFromNode(node, route, staticAgent);
      });

      await waitForReadinessEntries(readinessEntries);
    }

    const additionalStartup = partitionAdditionalStartupAgents({
      registry: reg,
      names: allNames,
      graphRegistryNames,
      loadManifest: loadRegistryManifest,
      isRuntimeRunning: isRegistryRuntimeRunning,
    });
    if (additionalStartup.inactiveManual.length) {
      cfg = await mergeRoutingConfig((current) => {
        const routes = removeInactiveManualRoutes({
          ...(current.routes || {}),
          ...(cfg.routes || {}),
        }, additionalStartup.inactiveManual);
        return {
          ...current,
          ...cfg,
          routes,
        };
      }, { coordinate: false });
      console.log(`[start] Leaving ${additionalStartup.inactiveManual.length} manual agent(s) stopped: ${additionalStartup.inactiveManual.map(({ name }) => name).join(', ')}`);
    }

    const activeManualNames = additionalStartup.activeManual.map(({ name }) => name);
    if (additionalStartup.automatic.length) {
      console.log(`[start] Starting ${additionalStartup.automatic.length} additional enabled agent(s) outside the dependency graph: ${additionalStartup.automatic.join(', ')}`);
    }
    if (activeManualNames.length) {
      console.log(`[start] Retaining ${activeManualNames.length} explicitly active manual agent(s): ${activeManualNames.join(', ')}`);
    }
    const additionalNames = [...additionalStartup.automatic, ...activeManualNames];
    if (additionalNames.length) {
      const extra = await updateRoutes(additionalNames, { allowFailures: true });
      if (extra.failedAgents.length === 0) {
        const extraReadiness = extra.routeResults.map((result) => buildBlockingReadinessEntryFromNode({
          id: `extra:${result.routeKey}`,
          shortAgentName: result.shortAgentName,
          isStatic: false,
          manifest: result.manifest,
        }, result.route, result.shortAgentName));
        await waitForReadinessEntries(extraReadiness);
      } else {
        throw new Error('additional runtime failure left edge selectors inactive; repair and run start again');
      }
    }

    // Runtime-only registry metadata may change while the lifecycle binding
    // remains exact. Persist it once, after all capability-sensitive launches
    // have completed, so one wave cannot invalidate the selector-bound host
    // launch token needed by a later wave.
    await mergeRoutingConfig((current) => {
      workspaceSvc.saveAgents(reg, { coordinate: false });
      return current;
    }, {
      reason: 'workspace-runtime-graph-ready',
      preparationLease: workspacePreparationLease,
    });
    workspacePreparationLease = null;

    let previousNoWaitStatusFile = '';
    for (const { node, registryName } of deferredNoWaitLaunches) {
      if (!registryName) {
        console.warn(`[start] no-wait node '${formatGraphNodeLabel(node, staticAgent)}' missing registry entry; skipping background launch.`);
        continue;
      }
      const rec = reg[registryName] || {};
      const routeKey = rec.alias || node.shortAgentName;
      try {
        const { pid, logFile, statusFile } = spawnNoWaitWorker({
          node,
          registryName,
          routeKey,
          registryAlias: rec.alias || node.alias || '',
          routerPort: staticPort,
          forceRecreate: newlyPreparedContainers.has(registryName),
          waitForStatusFile: previousNoWaitStatusFile,
        });
        previousNoWaitStatusFile = statusFile;
        console.log(`[start] ${formatGraphNodeLabel(node, staticAgent)}: no-wait launch started (pid ${pid}). log=${logFile} status=${statusFile}`);
      } catch (spawnErr) {
        console.error(`[start] no-wait launch for '${formatGraphNodeLabel(node, staticAgent)}' failed to spawn: ${spawnErr?.message || spawnErr}`);
      }
    }

    console.log(`[start] Watchdog will automatically restart the server if it crashes.`);
    console.log(`[start] Server logs: ${path.join(LOGS_DIR, 'router.log')}`);
    console.log(`[start] Watchdog logs: ${path.join(LOGS_DIR, 'watchdog.log')}`);
    console.log(`[start] Dashboard: http://127.0.0.1:${staticPort}/dashboard`);
  } catch (e) {
    if (workspacePreparationLease) {
      try {
        abortEdgeRoutingPreparation(workspacePreparationLease, {
          reason: 'workspace-start-failed',
        });
      } catch (_) {}
      workspacePreparationLease = null;
    }
    const message = e?.message || String(e);
    if (message.startsWith('start:') || message.startsWith('start (workspace) failed:')) {
      throw e;
    }
    throw new Error(`start (workspace) failed: ${message}`);
  } finally {
    releaseWorkspaceStartLock(workspaceStartLock);
  }
}

export async function runCliWithDependencies(agentName, args, dependencies) {
  if (!agentName) { throw new Error('Usage: cli <agentName> [args...]'); }
  const {
    env,
    resolveEnabledAgentRecord,
    findAgent,
    enableAgent,
    readManifest,
    ensureAgentService,
    getAgentContainerName,
    resolveAgentReadinessProtocol: resolveAgentReadinessProtocolImpl = resolveAgentReadinessProtocol,
    waitForManifestReadiness: waitForManifestReadinessImpl = waitForManifestReadiness,
    waitForAgentReady: waitForAgentReadyImpl,
    activateRuntimeAfterReadiness: activateRuntimeAfterReadinessImpl = activatePreparedRuntimeAfterReadiness,
    loadAgentsMap: loadAgentsMapImpl,
    attachInteractive,
    attachBwrapInteractive,
    attachSeatbeltInteractive,
    resolveRouterEndpointForManifest: resolveRouterEndpointForManifestImpl = resolveManifestRouterEndpoint,
    projectPath,
    debugLog = () => {},
    log = () => {},
    warn = () => {},
    error = () => {},
    withSuspendedInput = callback => callback(),
  } = dependencies;
  const suppressLauncherLogs = env.PLOINKY_NO_TTY === '1';
  let registryRecord = null;
  let manifestLookup = agentName;
  let routerEndpoint;
  try {
    registryRecord = resolveEnabledAgentRecord(agentName);
  } catch (err) {
    error(err?.message || err);
    return;
  }

  if (!registryRecord) {
    let autoEnableRef = null;
    let autoEnableManifestPath = '';
    try {
      const resolved = findAgent(agentName);
      autoEnableRef = `${resolved.repo}/${resolved.shortAgentName}`;
      manifestLookup = autoEnableRef;
      autoEnableManifestPath = resolved.manifestPath;
    } catch (err) {
      error(`Agent '${agentName}' is not found.`);
      if (err?.message) {
        error(err.message);
      }
      return;
    }

    const manifestBeforeEnable = readManifest(autoEnableManifestPath);
    routerEndpoint = resolveRouterEndpointForManifestImpl(manifestBeforeEnable, {
      path: `manifest(${autoEnableRef})`,
    });

    try {
      await enableAgent(autoEnableRef, 'global');
    } catch (err) {
      error(`Failed to enable '${agentName}' in global mode: ${err?.message || err}`);
      return;
    }

    try {
      registryRecord = resolveEnabledAgentRecord(agentName);
      if (!registryRecord) {
        registryRecord = resolveEnabledAgentRecord(autoEnableRef);
      }
    } catch (err) {
      error(err?.message || err);
      return;
    }
  }

  const resolvedManifestRef = registryRecord
    ? `${registryRecord.record.repoName}/${registryRecord.record.agentName}`
    : manifestLookup;
  const { manifestPath, shortAgentName } = findAgent(resolvedManifestRef);
  const manifest = readManifest(manifestPath);
  resolveManifestStartup(manifest);
  if (routerEndpoint === undefined) {
    routerEndpoint = resolveRouterEndpointForManifestImpl(manifest, {
      persistedProfileName: registryRecord?.record?.profile,
      path: `manifest(${resolvedManifestRef})`,
    });
  }
  const cliBase = getCliCmd(manifest);
  if (!cliBase || !cliBase.trim()) { throw new Error(`Manifest for '${shortAgentName}' has no 'cli' command.`); }

  // Separate SSO args from regular args — SSO context is passed as env vars,
  // not CLI flags, so plain shell CLIs (/bin/sh) don't crash on unknown options.
  const ssoArgs = (args || []).filter(a => /^--sso-/.test(a));
  const regularArgs = (args || []).filter(a => !/^--sso-/.test(a));
  const ssoExports = ssoArgs.map(a => {
    const match = a.match(/^--sso-(.+?)=(.*)$/);
    if (!match) return '';
    const envName = 'SSO_' + match[1].toUpperCase().replace(/-/g, '_');
    return `${envName}=${shellQuote(match[2])}`;
  }).filter(Boolean);
  const ssoPrefix = ssoExports.length ? 'export ' + ssoExports.join(' ') + '; ' : '';
  const rawCmd = ssoPrefix + cliBase + (regularArgs.length ? (' ' + regularArgs.join(' ')) : '');
  const cmd = wrapCliWithWebchat(rawCmd, env);
  const agentDir = path.dirname(manifestPath);
  const repoName = path.basename(path.dirname(agentDir));
  debugLog(`[runCli] agent=${agentName} container=${registryRecord?.containerName || getAgentContainerName(shortAgentName, repoName)}`);
  const containerInfo = ensureAgentService(shortAgentName, manifest, agentDir, {
    containerName: registryRecord?.containerName,
    alias: registryRecord?.record?.alias,
    routerEndpoint,
  });
  const containerName = (containerInfo && containerInfo.containerName)
    || registryRecord?.containerName
    || getAgentContainerName(shortAgentName, repoName);
  const readinessProtocol = resolveAgentReadinessProtocolImpl(manifest);
  if (readinessProtocol === 'script') {
    await waitForManifestReadinessImpl({
      key: `cli:${shortAgentName}`,
      label: shortAgentName,
      manifest,
      route: {
        container: containerName,
        hostPort: containerInfo?.hostPort || 0,
        ...(containerInfo?.serviceTargets ? { serviceTargets: containerInfo.serviceTargets } : {})
      }
    });
  } else if (readinessProtocol !== 'none') {
    const hostPort = containerInfo?.hostPort;
    if (!hostPort) {
      if (containerInfo?.requiresEdgeActivation) {
        throw new Error(`Agent '${shortAgentName}' replacement cannot activate without a resolved '${readinessProtocol}' readiness target.`);
      }
      if (!suppressLauncherLogs) {
        warn(`[cli] warning: cannot wait for '${shortAgentName}' readiness because no host port was resolved.`);
      }
    } else {
      if (!suppressLauncherLogs) {
        log(`[cli] Waiting for '${shortAgentName}' readiness (${readinessProtocol}) on port ${hostPort}...`);
      }
      const ready = await waitForAgentReadyImpl({ hostPort }, {
        timeoutMs: 600000,
        protocol: readinessProtocol,
      });
      if (!ready) {
        throw new Error(`Agent '${shortAgentName}' did not become ready before CLI attach.`);
      }
    }
  }

  await activateRuntimeAfterReadinessImpl({
    result: containerInfo,
    routeKey: registryRecord?.record?.alias || shortAgentName,
    repoName,
    shortAgentName,
    agentPath: agentDir,
    alias: registryRecord?.record?.alias || '',
  });

  // Determine actual runtime from registry (may differ from manifest if sandbox
  // failed and fell back to container during ensureAgentService)
  const agents = loadAgentsMapImpl();
  const registryEntry = agents[containerName] || {};
  const actualRuntime = registryEntry.runtime;

  if (!suppressLauncherLogs) {
    const identity = resolveAgentAttachmentIdentity(
      shortAgentName,
      containerName,
      agents,
    );
    for (const line of formatAgentAttachmentBanner(identity)) {
      log(line);
    }
  }

  if (actualRuntime === 'bwrap') {
    const attach = attachBwrapInteractive
      || (await import('./bwrap/bwrapServiceManager.js')).attachBwrapInteractive;
    withSuspendedInput(() => {
      attach(shortAgentName, manifest, agentDir, projectPath, cmd, { containerName, routerEndpoint });
    });
  } else if (actualRuntime === 'seatbelt') {
    const attach = attachSeatbeltInteractive
      || (await import('./seatbelt/seatbeltServiceManager.js')).attachSeatbeltInteractive;
    withSuspendedInput(() => {
      attach(shortAgentName, manifest, agentDir, projectPath, cmd, { containerName, routerEndpoint });
    });
  } else {
    withSuspendedInput(() => {
      attachInteractive(containerName, projectPath, cmd);
    });
  }
}

async function runCli(agentName, args) {
  const { ensureAgentService, attachInteractive, getAgentContainerName } = dockerSvc;
  return runCliWithDependencies(agentName, args, {
    env: process.env,
    resolveEnabledAgentRecord: (...callArgs) => agentsSvc.resolveEnabledAgentRecord(...callArgs),
    findAgent: (...callArgs) => utils.findAgent(...callArgs),
    enableAgent: (...callArgs) => agentsSvc.enableAgent(...callArgs),
    readManifest: manifestPath => JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    ensureAgentService,
    getAgentContainerName,
    resolveAgentReadinessProtocol,
    waitForManifestReadiness,
    waitForAgentReady,
    loadAgentsMap,
    attachInteractive,
    projectPath: PLOINKY_CWD,
    debugLog: (...callArgs) => utils.debugLog(...callArgs),
    log: (...callArgs) => console.log(...callArgs),
    warn: (...callArgs) => console.warn(...callArgs),
    error: (...callArgs) => console.error(...callArgs),
    withSuspendedInput: runWithSuspendedInput,
  });
}

async function runShell(agentName) {
  if (!agentName) { throw new Error('Usage: shell <agentName>'); }
  let registryRecord = null;
  try {
    registryRecord = agentsSvc.resolveEnabledAgentRecord(agentName);
  } catch (err) {
    console.error(err?.message || err);
    return;
  }
  const manifestLookup = registryRecord
    ? `${registryRecord.record.repoName}/${registryRecord.record.agentName}`
    : agentName;
  const { manifestPath, shortAgentName } = utils.findAgent(manifestLookup);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const routerEndpoint = resolveManifestRouterEndpoint(manifest, {
    persistedProfileName: registryRecord?.record?.profile,
    path: `manifest(${manifestLookup})`,
  });
  const { ensureAgentService, attachInteractive, getConfiguredProjectPath, getAgentContainerName } = dockerSvc;
  const agentDir = path.dirname(manifestPath);
  const repoName = path.basename(path.dirname(agentDir));
  const registeredContainerName = registryRecord?.containerName || getAgentContainerName(shortAgentName, repoName);
  const containerInfo = ensureAgentService(shortAgentName, manifest, agentDir, {
    containerName: registeredContainerName,
    alias: registryRecord?.record?.alias,
    routerEndpoint,
  });
  const containerName = (containerInfo && containerInfo.containerName)
    || registeredContainerName;
  await waitForManifestReadiness({
    key: `shell:${shortAgentName}`,
    label: shortAgentName,
    kind: 'dependency',
    manifest,
    route: {
      container: containerName,
      hostPort: containerInfo?.hostPort || 0,
      ...(containerInfo?.serviceTargets ? { serviceTargets: containerInfo.serviceTargets } : {}),
    },
  });
  await activatePreparedRuntimeAfterReadiness({
    result: containerInfo,
    routeKey: registryRecord?.record?.alias || shortAgentName,
    repoName,
    shortAgentName,
    agentPath: agentDir,
    alias: registryRecord?.record?.alias || '',
  });
  const cmd = '/bin/sh';
  const projPath = getConfiguredProjectPath(shortAgentName, repoName, registryRecord?.record?.alias);

  // Determine actual runtime from registry (may differ from manifest if sandbox
  // failed and fell back to container during ensureAgentService)
  const agents = loadAgentsMap();
  const registryEntry = agents[containerName] || {};
  const actualRuntime = registryEntry.runtime;

  if (actualRuntime === 'bwrap') {
    console.log(`[shell] bwrap agent: ${shortAgentName}`);
    console.log(`[shell] command: ${cmd}`);
    const { attachBwrapInteractive } = await import('./bwrap/bwrapServiceManager.js');
    runWithSuspendedInput(() => {
      attachBwrapInteractive(shortAgentName, manifest, agentDir, projPath, cmd, { containerName, routerEndpoint });
    });
  } else if (actualRuntime === 'seatbelt') {
    console.log(`[shell] seatbelt agent: ${shortAgentName}`);
    console.log(`[shell] command: ${cmd}`);
    const { attachSeatbeltInteractive } = await import('./seatbelt/seatbeltServiceManager.js');
    runWithSuspendedInput(() => {
      attachSeatbeltInteractive(shortAgentName, manifest, agentDir, projPath, cmd, { containerName, routerEndpoint });
    });
  } else {
    console.log(`[shell] container: ${containerName}`);
    console.log(`[shell] command: ${cmd}`);
    console.log(`[shell] agent: ${shortAgentName}`);
    runWithSuspendedInput(() => {
      attachInteractive(containerName, projPath, cmd);
    });
  }
}

async function reinstallAgent(agentName) {
    const routerPort = resolvePersistedRouterPort();
    if (!agentName) { throw new Error('Usage: reinstall <name> | reinstall agent <name>'); }

    const { getAgentContainerName, isContainerRunning, ensureAgentService } = dockerSvc;
    let registryRecord = null;
    try {
        registryRecord = agentsSvc.resolveEnabledAgentRecord(agentName);
    } catch (err) {
        console.error(err?.message || err);
        return;
    }

    let resolved;
    try {
        const lookup = registryRecord
            ? `${registryRecord.record.repoName}/${registryRecord.record.agentName}`
            : agentName;
        resolved = utils.findAgent(lookup);
    } catch (err) {
        console.error(err?.message || `Agent '${agentName}' not found.`);
        return;
    }

    const containerName = registryRecord?.containerName || getAgentContainerName(resolved.shortAgentName, resolved.repo);

    // Read manifest early to determine runtime
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
    } catch (err) {
        console.error(`Failed to read manifest for '${agentName}': ${err?.message || err}`);
        return;
    }
    const routerEndpoint = resolveManifestRouterEndpoint(manifest, {
        explicitPort: routerPort,
        persistedProfileName: registryRecord?.record?.profile,
        path: `manifest(${resolved.repo}/${resolved.shortAgentName})`,
    });

    const agentRuntime = getRuntimeForAgent(manifest);
    const bwrapRunning = isSandboxRuntime(agentRuntime)
        && Boolean(registryRecord?.record?.instanceId && registryRecord?.record?.enableGeneration)
        && isBwrapProcessRunning(containerName, {
            instanceId: registryRecord.record.instanceId,
            enableGeneration: registryRecord.record.enableGeneration,
        });

    if (!isContainerRunning(containerName) && !bwrapRunning) {
        console.error(`Agent '${agentName}' is not running.`);
        return;
    }

    console.log(`Reinstalling (re-creating) agent '${agentName}'...`);

    try {
        await withMaintenanceLock(containerName, {
            operation: 'reinstall',
            metadata: {
                agent: resolved.shortAgentName,
                repo: resolved.repo,
            },
        }, async () => {
            const short = resolved.shortAgentName;
            const agentPath = path.dirname(resolved.manifestPath);

            // The shared runtime manager owns inactivation and physical
            // replacement for every backend, including host sandboxes.
            const reinstallResult = await ensureAgentService(short, manifest, agentPath, {
                containerName,
                alias: registryRecord?.record?.alias,
                forceRecreate: true,
                routerEndpoint,
            });
            const { containerName: newContainerName, hostPort, serviceTargets } = reinstallResult;

            const repoName = path.basename(path.dirname(agentPath));
            const routeKey = registryRecord?.record.alias || short;

            await waitForManifestReadiness({
                key: `reinstall:${routeKey}`,
                label: short,
                kind: 'reinstall',
                manifest,
                route: {
                    container: newContainerName,
                    hostPort: hostPort || 0,
                    ...(serviceTargets ? { serviceTargets } : {})
                }
            });

            await activatePreparedRuntimeAfterReadiness({
                result: reinstallResult,
                routeKey,
                repoName,
                shortAgentName: short,
                agentPath,
                alias: registryRecord?.record?.alias || '',
            });

            const isRouterUp = (p) => {
                try {
                    const out = execSync(`lsof -t -i :${p} -sTCP:LISTEN`, { stdio: 'pipe' }).toString().trim();
                    if (out) return true;
                } catch(_) {}
                try {
                    const out = execSync('ss -ltnp', { stdio: 'pipe' }).toString();
                    return out.includes(`:${p}`) && out.includes('LISTEN');
                } catch(_) { return false; }
            };
            if (!isRouterUp(routerPort)) {
                const runningDir = RUNNING_DIR;
                fs.mkdirSync(runningDir, { recursive: true });
                const routerPath = path.resolve(__dirname, '../server/Watchdog.js');
                const routerPidFile = path.join(runningDir, 'router.pid');
                const child = spawnWatchdog(routerPath, routerPort, routerPidFile);
                try { fs.writeFileSync(routerPidFile, String(child.pid)); } catch(_) {}
                child.unref();
                console.log(`[reinstall] Watchdog launched (pid ${child.pid}) on port ${routerPort}.`);
                console.log(`[reinstall] Watchdog will automatically restart the server if needed.`);
            }
            console.log(`[reinstall] reinstalled '${short}' [container: ${newContainerName}]`);
        });
    } catch (e) {
        console.error(`[reinstall] ${agentName}: ${e?.message||e}`);
        throw e;
    }
}

export {
  assertStaticPreinstallSucceeded,
  buildBlockingReadinessEntryFromNode,
  activatePreparedRuntimeAfterReadiness,
  ensureGraphNodesEnabled,
  reprepareGraphAfterStartupProviders,
  resolveExtraEnabledRuntimeNodes,
  resolveManifestRouterEndpoint,
  resolveAndPersistStartRouterPort,
  resolveGraphNodeExecutionRecord,
  waitForRouterReady,
  waitForManifestReadiness,
  waitForReadinessEntries,
  startWorkspace,
  runCli,
  runShell,
  reinstallAgent
};
