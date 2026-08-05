import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as utils from '../utils/utils.js';
import * as agentsSvc from '../utils/agents.js';
import * as workspaceSvc from '../utils/workspace.js';
import * as dockerSvc from '../sandbox/docker/index.js';
import {
  computeEnvHash,
  getContainerLabel,
  getRuntime,
  getRuntimeForAgent,
  isSandboxRuntime,
  loadAgentsMap,
} from '../sandbox/docker/common.js';
import {
  buildRuntimeNetworkPlan,
  buildRuntimeRouterEnv,
  resolvePublishedPortMappings,
} from '../sandbox/docker/agentServiceManager.js';
import { isBwrapProcessRunning } from '../sandbox/bwrap/bwrapFleet.js';
import * as inputState from './inputState.js';
import { prepareDefaultBootRepositories } from './ploinkyboot.js';
import { prepareManifestRepositories } from '../utils/runtime/bootstrapManifest.js';
import { buildLifecycleHookEnv, executeHostHook, markPreinstallRunInProcess, resetPreinstallRunInProcess, isInlineCommand } from '../utils/runtime/lifecycleHooks.js';
import { getActiveProfile, getProfileConfig, resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import { loadEnvFile } from '../utils/security/secretInjector.js';
import { readSecretsFile } from '../utils/security/encryptedSecretsFile.js';
import { getExposedNames, getManifestEnvNames } from '../utils/security/secretVars.js';
import {
  isLlmRuntimeManifest,
  prepareLlmStartup,
  resolveLlmRuntimeAdmissionContext,
} from '../sandbox/docker/llmRuntimeIntegration.js';
import { resolveAgentExecutionMode, resolveAgentReadinessProtocol } from '../utils/runtime/startupReadiness.js';
import { normalizeProbeConfig, runContainerScriptReadiness } from '../sandbox/docker/healthProbes.js';
import { applyStartupConfigProvidersForGraph } from '../sandbox/startupConfigProviders.js';
import { acquireWorkspaceMutationLease, releaseWorkspaceStartLock, withMaintenanceLock } from '../utils/runtime/maintenanceLocks.js';
import {
  AGENTS_DATA_DIR,
  LOGS_DIR,
  PLOINKY_DIR,
  PLOINKY_CWD,
  PLOINKY_WORKSPACE_ROOT,
  REPOS_DIR,
  RUNNING_DIR,
} from '../utils/config.js';
import { classifyDependencyGraphWaitMode, resolveWorkspaceDependencyGraph, topologicallyGroupDependencyGraph } from '../utils/workspaceDependencyGraph.js';
import {
  mergeRoutingConfig,
  mergeRuntimeRoute,
  readRoutingConfig,
  writeRoutingConfig,
} from '../server/routingFile.js';
import {
  abortEdgeRoutingPreparation,
  initializeFreshEdgeRoutingSources,
  inactivateEdgeRoutingGeneration,
  prepareHostModeCapabilityForInactiveGeneration,
} from '../sandbox/edgeGeneration.js';
import { applyEdgeRoutingGeneration } from '../sandbox/coordinatedEdgeApply.js';
import {
  finalizeStartupRoutes,
  partitionAdditionalStartupAgents,
  resolveManifestStartup,
} from '../utils/runtime/manifestStartup.js';
import {
  buildRelayReadinessRoute,
  waitForAgentReady,
} from '../server/utils/agentReadiness.js';
import {
  createNetworkLifecycleAdapter,
  withNetworkLifecycleLock,
} from '../sandbox/networkLifecycle.js';
import { networkContractHash } from '../sandbox/networkContract.js';
import {
  admitManifestRuntimeCapabilities,
  assertRuntimeAdmissionCurrent,
} from '../sandbox/runtimeCapabilities.js';
import { getAgentDataDir } from '../utils/workspaceStructure.js';
import {
  formatAgentAttachmentBanner,
  resolveAgentAttachmentIdentity,
} from '../sandbox/layerIdentification.js';
import {
  assertRouterEndpoint,
  parseRouterPort,
  resolveInitialRouterPort,
  resolvePersistedRouterPort,
  resolveRouterEndpoint,
} from '../sandbox/routerPort.js';
import {
  createRouterProcessRecord,
  killRouterIfRunning as stopManagedRouter,
  publishPreparedRouterProcessRecord,
  requireRouterStopCompleted,
  terminateExactRouterProcess,
  terminateRouterProcessRecordIfExact,
} from './sessionControl.js';

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

function childHasExited(child) {
  return (child?.exitCode !== null && child?.exitCode !== undefined)
    || (child?.signalCode !== null && child?.signalCode !== undefined);
}

async function acquireSpawnedRouterProcessRecord(child, {
  workspaceRoot = PLOINKY_WORKSPACE_ROOT,
  timeoutMs = 2000,
  retryMs = 20,
  createRecord = createRouterProcessRecord,
  now = Date.now,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0
      || !Number.isSafeInteger(retryMs) || retryMs < 1) {
    throw new Error('Router owner identity acquisition bounds are invalid');
  }
  const deadline = now() + timeoutMs;
  let lastIdentityError = null;
  while (true) {
    if (childHasExited(child)) {
      const error = new Error(
        `Watchdog exited before its exact Router owner identity was acquired (${child.exitCode ?? child.signalCode})`,
      );
      error.code = 'PLOINKY_ROUTER_OWNER_LAUNCH_EXITED';
      throw error;
    }
    try {
      return createRecord(child.pid, workspaceRoot);
    } catch (error) {
      if (error?.code !== 'PLOINKY_ROUTER_OWNER_IDENTITY_UNVERIFIED') throw error;
      lastIdentityError = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await delay(Math.min(retryMs, remaining));
  }
  const error = new Error(
    `Watchdog pid ${child.pid} did not acquire an exact Router owner identity within ${timeoutMs}ms`,
    { cause: lastIdentityError },
  );
  error.code = 'PLOINKY_ROUTER_OWNER_IDENTITY_TIMEOUT';
  throw error;
}

async function waitForSpawnedChildExit(child, timeoutMs, {
  now = Date.now,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = now() + timeoutMs;
  while (!childHasExited(child) && now() < deadline) {
    await delay(Math.min(20, Math.max(1, deadline - now())));
  }
  return childHasExited(child);
}

async function terminateSpawnedWatchdogHandle(child, {
  timeoutMs = 1000,
  killTimeoutMs = 1000,
  ...waitDependencies
} = {}) {
  if (childHasExited(child)) return Object.freeze({ stopped: true, signal: null });
  let termSent = false;
  try { termSent = child.kill('SIGTERM') !== false; } catch (_) { }
  if (termSent && await waitForSpawnedChildExit(child, timeoutMs, waitDependencies)) {
    return Object.freeze({ stopped: true, signal: 'SIGTERM' });
  }
  if (childHasExited(child)) return Object.freeze({ stopped: true, signal: 'SIGTERM' });
  let killSent = false;
  try { killSent = child.kill('SIGKILL') !== false; } catch (_) { }
  if (killSent && await waitForSpawnedChildExit(child, killTimeoutMs, waitDependencies)) {
    return Object.freeze({ stopped: true, signal: 'SIGKILL' });
  }
  return Object.freeze({ stopped: false, reason: 'spawn-handle-kill-timeout' });
}

function routerLaunchCleanupError(label, originalFailure, cleanupFailure) {
  const cleanupDetail = cleanupFailure?.message
    || cleanupFailure?.reason
    || String(cleanupFailure || 'unknown cleanup failure');
  const error = new Error(
    `${label}: exact Watchdog launch cleanup failed after '${originalFailure?.message || originalFailure}': ${cleanupDetail}`,
    { cause: cleanupFailure instanceof Error ? cleanupFailure : originalFailure },
  );
  error.code = 'PLOINKY_ROUTER_LAUNCH_CLEANUP_FAILED';
  Object.defineProperty(error, 'originalFailure', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: originalFailure,
  });
  return error;
}

function exactRouterCleanupSucceeded(result) {
  return result?.stopped === true
    || result?.reason === 'stale-process'
    || result?.reason === 'stale-record';
}

async function launchManagedWatchdog({
  routerPath,
  port,
  routerPidFile,
  label,
}, {
  spawnWatchdogImpl = spawnWatchdog,
  acquireRecord = acquireSpawnedRouterProcessRecord,
  publishRecord = publishPreparedRouterProcessRecord,
  terminateExact = terminateExactRouterProcess,
  terminateRecorded = terminateRouterProcessRecordIfExact,
  waitForReady = waitForRouterReady,
  workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
  const child = spawnWatchdogImpl(routerPath, port, routerPidFile);
  let record = null;
  let published = false;
  try {
    record = await acquireRecord(child, { workspaceRoot });
    publishRecord(routerPidFile, record, workspaceRoot);
    published = true;
    child.unref();
    try {
      await waitForReady(port, child);
    } catch (readinessError) {
      let cleanupResult;
      try {
        cleanupResult = terminateRecorded(routerPidFile, workspaceRoot, record);
      } catch (cleanupError) {
        throw routerLaunchCleanupError(label, readinessError, cleanupError);
      }
      if (!exactRouterCleanupSucceeded(cleanupResult)) {
        throw routerLaunchCleanupError(label, readinessError, cleanupResult);
      }
      throw readinessError;
    }
    return Object.freeze({ child, record });
  } catch (launchError) {
    if (published) throw launchError;
    let cleanupResult;
    try {
      if (record) {
        try {
          cleanupResult = terminateExact(record);
        } catch (_) {
          cleanupResult = await terminateSpawnedWatchdogHandle(child);
        }
        if (!exactRouterCleanupSucceeded(cleanupResult)) {
          cleanupResult = await terminateSpawnedWatchdogHandle(child);
        }
      } else {
        cleanupResult = await terminateSpawnedWatchdogHandle(child);
      }
    } catch (cleanupError) {
      throw routerLaunchCleanupError(label, launchError, cleanupError);
    }
    if (!exactRouterCleanupSucceeded(cleanupResult)) {
      throw routerLaunchCleanupError(label, launchError, cleanupResult);
    }
    throw launchError;
  }
}

function requireRouterReplacementStopped(result, label) {
  try {
    return requireRouterStopCompleted(result, label);
  } catch (cause) {
    const error = new Error(
      `${label}: refusing to launch a replacement Watchdog because exact Router ownership cleanup did not complete (${result?.reason || 'invalid-result'})`,
      { cause },
    );
    error.code = 'PLOINKY_ROUTER_REPLACEMENT_REFUSED';
    throw error;
  }
}

function stopRouterForReplacement(killRouterIfRunningImpl, label) {
  if (typeof killRouterIfRunningImpl !== 'function') {
    throw new Error(`${label}: exact Router ownership cleanup is unavailable`);
  }
  return requireRouterReplacementStopped(killRouterIfRunningImpl(), label);
}

async function probeRouterHealthSocket(socketPath, { timeoutMs = 250 } = {}) {
  let socketStat;
  try {
    socketStat = fs.lstatSync(socketPath);
  } catch (_) {
    return false;
  }
  if (!socketStat.isSocket()) return false;
  if (typeof process.getuid === 'function' && socketStat.uid !== process.getuid()) return false;
  if ((socketStat.mode & 0o777) !== 0o600) return false;

  return new Promise((resolve) => {
    let settled = false;
    let body = '';
    let request;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      request?.destroy();
      finish(false);
    }, timeoutMs);
    request = http.get({
      socketPath,
      path: '/health',
      method: 'GET',
      headers: { Connection: 'close' },
    }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16 * 1024) request.destroy();
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          finish(
            response.statusCode === 200
            && health?.status === 'healthy'
            && Number.isSafeInteger(health?.pid)
            && health.pid > 0,
          );
        } catch (_) {
          finish(false);
        }
      });
    });
    request.once('error', () => finish(false));
  });
}

async function waitForRouterReady(port, child, timeoutMs = 15000, {
  createConnection = net.createConnection,
  healthSocketPath = process.env.PLOINKY_ROUTER_HEALTH_SOCKET
    || path.join(PLOINKY_DIR, 'run', 'router-health.sock'),
  probeHealthSocket = probeRouterHealthSocket,
} = {}) {
  const validatedPort = parseRouterPort(port, { source: 'router readiness port' });
  const deadline = Date.now() + timeoutMs;
  let observedTcpListener = false;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      const error = new Error(`router exited before exact workspace readiness (exit ${child.exitCode})`);
      error.code = 'PLOINKY_ROUTER_NOT_READY';
      throw error;
    }
    const tcpReady = await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: validatedPort });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(250, () => done(false));
    });
    observedTcpListener ||= tcpReady;
    const exactWorkspaceReady = await probeHealthSocket(healthSocketPath, { timeoutMs: 250 });
    if (tcpReady && exactWorkspaceReady) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (observedTcpListener) {
    const error = new Error(
      `port 127.0.0.1:${validatedPort} is occupied without the exact workspace Router health socket`,
    );
    error.code = 'PLOINKY_ROUTER_WORKSPACE_MISMATCH';
    throw error;
  }
  const error = new Error(
    `router did not become ready at 127.0.0.1:${validatedPort} with health socket ${healthSocketPath}`,
  );
  error.code = 'PLOINKY_ROUTER_NOT_READY';
  throw error;
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

function resolveRetainedGraphNodeExecutionRecord(node, record, {
  workspaceRoot = PLOINKY_WORKSPACE_ROOT,
  getAgentDataDirImpl = getAgentDataDir,
} = {}) {
  const runMode = String(record?.runMode || agentsSvc.DEFAULT_ENABLE_AGENT_MODE).trim().toLowerCase();
  const instanceName = node.alias || record?.alias || node.shortAgentName;
  let projectPath;
  let develRepo;

  if (runMode === agentsSvc.DEFAULT_ENABLE_AGENT_MODE) {
    projectPath = getAgentDataDirImpl(instanceName);
  } else if (runMode === 'global') {
    projectPath = workspaceRoot;
  } else if (runMode === 'devel') {
    develRepo = String(record?.develRepo || '').trim();
    projectPath = String(record?.projectPath || '').trim();
    if (!develRepo || !projectPath || !fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      throw new Error(
        `Retained graph node '${node.id}' has an incomplete devel execution record; re-enable it with an exact repository.`,
      );
    }
    projectPath = path.resolve(projectPath);
  } else {
    throw new Error(
      `Retained graph node '${node.id}' has unknown mode '${runMode}'. Allowed: ${agentsSvc.ENABLE_AGENT_MODES.join(' | ')}`,
    );
  }

  // The static agent owns the workspace-facing process contract even when it
  // was originally enabled as an isolated instance. Conversely, an isolated
  // agent that is no longer static must return to its per-instance data root.
  // Stage that transition before the immutable generation is prepared so
  // runtime finalization never changes a lifecycle-bound projectPath.
  if (node.isStatic) projectPath = workspaceRoot;

  return { runMode, projectPath, develRepo };
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
    if (!String(record?.instanceId || '').trim()
        || !String(record?.enableGeneration || '').trim()) return false;
    return isBwrapProcessRunning(containerName, {
      instanceId: record.instanceId,
      enableGeneration: record.enableGeneration,
    });
  }
  return dockerSvc.isContainerRunning(containerName);
}

export function admitWorkspaceGraphRuntimeCapabilities(graph, {
  additionalNodes = [],
} = {}) {
  const nodes = [
    ...Array.from(graph?.nodes?.values?.() || []),
    ...(Array.isArray(additionalNodes) ? additionalNodes : []),
  ].sort((a, b) => a.id.localeCompare(b.id));

  const admissions = [];
  for (const node of nodes) {
    const manifestPath = node.manifestPath
      || (node.agentPath ? path.join(node.agentPath, 'manifest.json') : '');
    const hasExactManifestFile = manifestPath && fs.existsSync(manifestPath);
    const manifestBytes = hasExactManifestFile
      ? fs.readFileSync(manifestPath)
      : Buffer.from(JSON.stringify(node.manifest || {}));
    const manifest = hasExactManifestFile
      ? JSON.parse(manifestBytes.toString('utf8'))
      : node.manifest || {};
    const profileResolution = resolveManifestRuntimeProfile(manifest, {
      agentName: `${node.repoName}/${node.shortAgentName}`,
      // In-memory graph fixtures have no independent profile namespace to
      // resolve. Production graph nodes always carry the exact manifest path.
      profileName: hasExactManifestFile ? (node.profile || undefined) : undefined,
      path: `manifest(${node.repoName}/${node.shortAgentName})`,
    });
    const runtime = getRuntimeForAgent(manifest);
    const runtimeKind = isSandboxRuntime(runtime) ? runtime : 'container';
    const llmAdmissionContext = runtimeKind === 'container'
      ? resolveLlmRuntimeAdmissionContext({
        runtime,
        manifest,
        profileConfig: profileResolution.profileConfig,
        agentName: node.shortAgentName,
        alias: node.alias,
        env: process.env,
      })
      : { catalogPolicy: null, catalogIdentity: null };
    const admission = admitManifestRuntimeCapabilities(manifest, {
      manifestBytes,
      manifestPath: manifestPath || `manifest(${node.repoName}/${node.shortAgentName})`,
      agentId: `${node.repoName}/${node.shortAgentName}`,
      profileName: profileResolution.resolvedProfileName,
      profileConfig: profileResolution.profileConfig,
      network: profileResolution.network,
      runtime,
      runtimeKind,
      catalogPolicy: llmAdmissionContext.catalogPolicy,
      catalogIdentity: llmAdmissionContext.catalogIdentity,
    });
    admissions.push(Object.freeze({
      nodeId: node.id,
      manifestPath: hasExactManifestFile ? manifestPath : '',
      manifestBytesBase64: Buffer.from(manifestBytes).toString('base64'),
      profileName: profileResolution.resolvedProfileName,
      runtimeKind,
      admission,
    }));
  }
  return Object.freeze(admissions);
}

export function assertWorkspaceGraphAdmissionsCurrent(admissions) {
  for (const record of admissions || []) {
    const manifestBytes = record.manifestPath
      ? fs.readFileSync(record.manifestPath)
      : Buffer.from(record.manifestBytesBase64, 'base64');
    assertRuntimeAdmissionCurrent(record.admission, {
      manifestBytes,
      profileName: record.profileName,
      runtimeKind: record.runtimeKind,
    });
  }
  return admissions;
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

  // Keep the physical preparation boundary independently fail-closed even
  // though startWorkspace performs the same complete-graph gate before locks.
  admitWorkspaceGraphRuntimeCapabilities(graph, { additionalNodes });

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
      : resolveRetainedGraphNodeExecutionRecord(node, existing.rec, executionRecordOptions);
    const executionChanged = executionRecordDiffers(existing.rec, expectedExecution);
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
  // predecessor's resolved hostPort here would make the topology
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
    }, { hostPort: null });
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
  })), {
    reason: 'workspace-graph-enable-prelaunch',
    availabilityMode: 'replacement',
  });
  if (prepared?.preparedGeneration?.selector?.state !== 'inactive') {
    const invalidPreparation = new Error(
      'workspace graph prelaunch generation unexpectedly became active',
    );
    abortWorkspacePreparationForRecovery(
      prepared?.preparedGeneration?.preparationLease,
      invalidPreparation,
      'workspace-graph-preparation-invalid',
      { abortPreparationImpl: abortPreparation },
    );
    throw invalidPreparation;
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
        plan.existing.rec,
      );
    }
  } catch (error) {
    try {
      inactivateGeneration('workspace-graph-runtime-removal-failed', {
        preserveSelectedGeneration: true,
      });
    } catch (_) {}
    abortWorkspacePreparationForRecovery(
      prepared?.preparedGeneration?.preparationLease,
      error,
      'workspace-graph-runtime-removal-failed',
      { abortPreparationImpl: abortPreparation },
    );
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
  onInitialPreparationAborted = () => {},
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

  abortWorkspacePreparationForRecovery(
    initialLease,
    new Error('start: could not retire the early preparation before startup-provider identity re-evaluation'),
    'workspace-start-provider-reprepare',
    { abortPreparationImpl: abortPreparation },
  );
  onInitialPreparationAborted(initialLease);

  const preparedGraph = ensureGraphNodesEnabledImpl(graph, reg, {
    ...graphEnableOptions,
    abortPreparation,
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
    const invalidPreparation = new Error(
      'start: post-provider graph generation did not remain inactive',
    );
    abortWorkspacePreparationForRecovery(
      preparedGraph?.preparedGeneration?.preparationLease,
      invalidPreparation,
      'workspace-start-provider-reprepare-invalid',
      { abortPreparationImpl: abortPreparation },
    );
    throw invalidPreparation;
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
  const hasRelayTarget = Boolean(route?.relay && route?.primaryService?.port);
  if (!route?.hostPort && !hasRelayTarget && entry.protocol !== 'none') {
    if (entry.protocol === 'script') {
      return entry;
    }
    if (resolveAgentExecutionMode(node.manifest).type === 'start_only') {
      throw new Error(
        `${node.isStatic ? 'Static agent' : 'Dependent agent'} '${formatGraphNodeLabel(node, staticLabel)}' is start-only but has no reachable readiness contract. `
        + 'Declare readiness.port, health.readiness.script, or readiness.protocol none.'
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
  if (stage === 'waiting_for_relay') {
    return `still waiting (${elapsedSec}s/${timeoutSec}s): confined relay target not ready${lastError ? `, last probe=${lastError}` : ''}`;
  }
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
    };
    if (!result.hostPort) delete cfg.routes[routeKey].hostPort;
    return cfg;
  }, {
    reason: 'runtime-replacement-ready',
    preparationLease: result.preparationLease,
  });
  return true;
}

export function abortWorkspacePreparationForRecovery(preparationLease, originalFailure, reason, {
  abortPreparationImpl = abortEdgeRoutingPreparation,
} = {}) {
  if (originalFailure?.code === 'PLOINKY_RECOVERY_ABORT_FAILED') throw originalFailure;
  if (!preparationLease) return false;
  try {
    abortPreparationImpl(preparationLease, { reason });
  } catch (abortError) {
    const recoveryError = new Error(
      `workspace recovery could not abort the exact edge preparation for '${reason}'; preserving its failure evidence: ${abortError?.message || abortError}`,
      { cause: abortError },
    );
    recoveryError.code = 'PLOINKY_RECOVERY_ABORT_FAILED';
    Object.defineProperty(recoveryError, 'originalFailure', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: originalFailure,
    });
    Object.defineProperty(recoveryError, 'ploinkyRecoveryPreparation', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        preparationLease,
        reason,
        preparationAbortFailed: true,
        preparationAbortedBeforeCleanup: false,
      }),
    });
    throw recoveryError;
  }
  return true;
}

function workspaceRuntimeCandidateIdentity(candidate) {
  const record = candidate?.registryRecord || {};
  const exactIdentity = [
    candidate?.containerId,
    candidate?.containerName,
    record.runtime,
    record.instanceId,
    record.enableGeneration,
    candidate?.preparationLease?.transactionId,
    candidate?.preparationLease?.preparedGeneration,
  ].map((part) => String(part || '')).join('\u0000');
  return exactIdentity.replaceAll('\u0000', '') ? exactIdentity : null;
}

function attachWorkspaceRuntimeCandidateEvidence(error, candidates, {
  preferCandidates = false,
} = {}) {
  if (!error || typeof error !== 'object') return error;
  const suppliedCandidates = Array.isArray(candidates) ? candidates : [];
  const existingCandidates = [];
  if (Array.isArray(error.ploinkyRestartCandidates)) {
    existingCandidates.push(...error.ploinkyRestartCandidates);
  }
  if (error.ploinkyRestartCandidate) existingCandidates.push(error.ploinkyRestartCandidate);
  const combined = preferCandidates
    ? [...existingCandidates, ...suppliedCandidates]
    : [...suppliedCandidates, ...existingCandidates];

  const evidenceByIdentity = new Map();
  const anonymousEvidence = [];
  for (const candidate of combined) {
    if (!candidate || typeof candidate !== 'object') continue;
    const frozenCandidate = Object.isFrozen(candidate)
      ? candidate
      : Object.freeze({ ...candidate });
    const identity = workspaceRuntimeCandidateIdentity(frozenCandidate);
    if (identity) evidenceByIdentity.set(identity, frozenCandidate);
    else if (!anonymousEvidence.includes(candidate)) anonymousEvidence.push(frozenCandidate);
  }
  const evidence = Object.freeze([...evidenceByIdentity.values(), ...anonymousEvidence]);
  if (!evidence.length) return error;

  const pluralDescriptor = Object.getOwnPropertyDescriptor(error, 'ploinkyRestartCandidates');
  if (!pluralDescriptor || pluralDescriptor.configurable === true) {
    Object.defineProperty(error, 'ploinkyRestartCandidates', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: evidence,
    });
  }
  const singularDescriptor = Object.getOwnPropertyDescriptor(error, 'ploinkyRestartCandidate');
  if (!singularDescriptor || singularDescriptor.configurable === true) {
    const preferredSingular = preferCandidates && suppliedCandidates.length
      ? suppliedCandidates[suppliedCandidates.length - 1]
      : evidence[evidence.length - 1];
    Object.defineProperty(error, 'ploinkyRestartCandidate', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: preferredSingular,
    });
  }
  return error;
}

export function cleanupFailedPreparedRuntime(result, error, reason = 'runtime-replacement-readiness-failed', {
  cleanupExactAgentRuntimeCandidateImpl = dockerSvc.cleanupExactAgentRuntimeCandidate,
  abortEdgeRoutingPreparationImpl = abortEdgeRoutingPreparation,
} = {}) {
  if (error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED') throw error;
  const attachedCandidateDescriptor = result == null && error && typeof error === 'object'
    ? Object.getOwnPropertyDescriptor(error, 'ploinkyRestartCandidate')
    : null;
  const attachedCandidate = attachedCandidateDescriptor
    && Object.hasOwn(attachedCandidateDescriptor, 'value')
    && attachedCandidateDescriptor.writable === false
    && attachedCandidateDescriptor.value
    && typeof attachedCandidateDescriptor.value === 'object'
    && Object.isFrozen(attachedCandidateDescriptor.value)
    ? attachedCandidateDescriptor.value
    : null;
  const candidate = result && typeof result === 'object'
    ? result
    : attachedCandidate;
  if (!candidate) return;
  if (!candidate.preparationLease) return;
  let cleanupCandidate = candidate;
  if (candidate.preparationAbortedBeforeCleanup !== true) {
    try {
      abortEdgeRoutingPreparationImpl(candidate.preparationLease, { reason });
    } catch (abortError) {
      const recoveryError = new Error(
        `runtime recovery could not abort the exact edge preparation for '${candidate.containerName || 'unknown candidate'}'; preserving its failed runtime candidate: ${abortError?.message || abortError}`,
        { cause: abortError },
      );
      recoveryError.code = 'PLOINKY_RECOVERY_ABORT_FAILED';
      Object.defineProperty(recoveryError, 'originalFailure', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: error,
      });
      Object.defineProperty(recoveryError, 'ploinkyRestartCandidate', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: Object.freeze({
          ...candidate,
          exactCleanupPerformed: false,
          preparationAbortFailed: true,
          preparationAbortedBeforeCleanup: false,
        }),
      });
      throw recoveryError;
    }
    cleanupCandidate = Object.freeze({
      ...candidate,
      preparationAbortFailed: false,
      preparationAbortedBeforeCleanup: true,
    });
  } else if (!Object.isFrozen(cleanupCandidate)) {
    cleanupCandidate = Object.freeze({ ...cleanupCandidate });
  }
  attachWorkspaceRuntimeCandidateEvidence(error, [cleanupCandidate]);
  if (cleanupCandidate.exactCleanupPerformed === true) return;
  if (cleanupCandidate.preparationLease
      && cleanupCandidate.containerName
      && cleanupCandidate.registryRecord
      && cleanupCandidate.cleanupReceipt) {
    try {
      cleanupExactAgentRuntimeCandidateImpl(cleanupCandidate);
      cleanupCandidate = Object.freeze({
        ...cleanupCandidate,
        exactCleanupPerformed: true,
      });
      attachWorkspaceRuntimeCandidateEvidence(error, [cleanupCandidate], {
        preferCandidates: true,
      });
    } catch (cleanupError) {
      error.message += `; exact readiness-failure cleanup: ${cleanupError?.message || cleanupError}`;
    }
  }
}

export function shouldTrackWorkspaceRuntimeCandidate(result) {
  return result?.requiresEdgeActivation === true
    && Boolean(result.preparationLease)
    && Boolean(result.containerName)
    && Boolean(result.registryRecord)
    && Boolean(result.cleanupReceipt);
}

export function cleanupWorkspaceRuntimeCandidates(candidates, error, {
  cleanupExactAgentRuntimeCandidateImpl = dockerSvc.cleanupExactAgentRuntimeCandidate,
  abortEdgeRoutingPreparationImpl = abortEdgeRoutingPreparation,
  preparationLease = null,
  preparationAbortedBeforeCleanup = false,
} = {}) {
  if (!Array.isArray(candidates)) return;
  if (error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED') {
    attachWorkspaceRuntimeCandidateEvidence(error, candidates);
    throw error;
  }
  const attachedEvidence = [
    ...(Array.isArray(error?.ploinkyRestartCandidates) ? error.ploinkyRestartCandidates : []),
    ...(error?.ploinkyRestartCandidate ? [error.ploinkyRestartCandidate] : []),
  ];
  const attachedEvidenceByIdentity = new Map(attachedEvidence
    .filter((candidate) => candidate && typeof candidate === 'object' && Object.isFrozen(candidate))
    .map((candidate) => [workspaceRuntimeCandidateIdentity(candidate), candidate])
    .filter(([identity]) => identity));
  const trackedCandidates = candidates
    .filter((candidate) => shouldTrackWorkspaceRuntimeCandidate(candidate))
    .map((candidate) => (
      attachedEvidenceByIdentity.get(workspaceRuntimeCandidateIdentity(candidate)) || candidate
    ));
  const preparationRecords = [];
  const rememberPreparation = (lease, alreadyAborted) => {
    if (!lease) return;
    const known = preparationRecords.find((entry) => entry.lease === lease);
    if (known) {
      known.alreadyAborted ||= alreadyAborted;
      return;
    }
    preparationRecords.push({ lease, alreadyAborted: Boolean(alreadyAborted) });
  };
  rememberPreparation(preparationLease, preparationAbortedBeforeCleanup);
  for (const candidate of trackedCandidates) {
    rememberPreparation(
      candidate.preparationLease,
      candidate.preparationAbortedBeforeCleanup === true,
    );
  }
  const abortedPreparations = new Set();
  for (const preparation of preparationRecords) {
    if (preparation.alreadyAborted) {
      abortedPreparations.add(preparation.lease);
      continue;
    }
    try {
      abortEdgeRoutingPreparationImpl(preparation.lease, { reason: 'workspace-start-failed' });
      abortedPreparations.add(preparation.lease);
    } catch (abortError) {
      const preservedCandidates = Object.freeze(trackedCandidates
        .map((candidate) => Object.freeze({
          ...candidate,
          exactCleanupPerformed: false,
          preparationAbortFailed: candidate.preparationLease === preparation.lease,
          preparationAbortedBeforeCleanup: abortedPreparations.has(candidate.preparationLease),
        })));
      const recoveryError = new Error(
        `workspace recovery could not abort the exact edge preparation; preserving all failed runtime candidates: ${abortError?.message || abortError}`,
        { cause: abortError },
      );
      recoveryError.code = 'PLOINKY_RECOVERY_ABORT_FAILED';
      Object.defineProperty(recoveryError, 'originalFailure', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: error,
      });
      Object.defineProperty(recoveryError, 'ploinkyRestartCandidates', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: preservedCandidates,
      });
      if (preservedCandidates.length) {
        Object.defineProperty(recoveryError, 'ploinkyRestartCandidate', {
          configurable: true,
          enumerable: false,
          writable: false,
          value: preservedCandidates[preservedCandidates.length - 1],
        });
      }
      throw recoveryError;
    }
  }
  const cleanupCandidates = trackedCandidates.map((candidate) => Object.freeze({
    ...candidate,
    preparationAbortFailed: false,
    preparationAbortedBeforeCleanup: abortedPreparations.has(candidate.preparationLease),
  }));
  const cleanupCandidateByOriginal = new Map(
    trackedCandidates.map((candidate, index) => [candidate, cleanupCandidates[index]]),
  );
  attachWorkspaceRuntimeCandidateEvidence(error, cleanupCandidates);
  const cleanedCandidateIds = new Set();
  for (const candidate of [...trackedCandidates].reverse()) {
    if (!shouldTrackWorkspaceRuntimeCandidate(candidate)) continue;
    if (candidate.exactCleanupPerformed === true) continue;
    const cleanupCandidate = cleanupCandidateByOriginal.get(candidate) || candidate;
    const candidateId = String(candidate.containerId || '') || [
      candidate.registryRecord.runtime,
      candidate.containerName,
      candidate.registryRecord.instanceId,
      candidate.registryRecord.enableGeneration,
    ].map((part) => String(part || '')).join(':');
    if (cleanedCandidateIds.has(candidateId)) continue;
    cleanedCandidateIds.add(candidateId);
    try {
      cleanupExactAgentRuntimeCandidateImpl(cleanupCandidate);
      const completedCandidate = Object.freeze({
        ...cleanupCandidate,
        exactCleanupPerformed: true,
      });
      const completedIdentity = workspaceRuntimeCandidateIdentity(completedCandidate);
      for (let index = 0; index < cleanupCandidates.length; index += 1) {
        if (workspaceRuntimeCandidateIdentity(cleanupCandidates[index]) === completedIdentity) {
          cleanupCandidates[index] = completedCandidate;
        }
      }
    } catch (cleanupError) {
      error.message += `; exact workspace candidate cleanup: ${cleanupError?.message || cleanupError}`;
    }
  }
  attachWorkspaceRuntimeCandidateEvidence(error, cleanupCandidates, {
    preferCandidates: true,
  });
  candidates.length = 0;
}

export function buildWorkspaceRuntimeRegistry(preflightRegistry, workspaceConfig) {
  return {
    ...(preflightRegistry || {}),
    _config: structuredClone(workspaceConfig || {}),
  };
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

function buildDashboardUrl(staticPort, env = process.env) {
  const publicAuthority = String(env.PLOINKY_PUBLIC_AUTHORITY || '').trim();
  return publicAuthority
    ? `http://${publicAuthority}/dashboard`
    : `http://127.0.0.1:${staticPort}/dashboard`;
}

export function preflightWorkspaceStartRuntimeCapabilities(staticAgentArg) {
  const configured = workspaceSvc.getConfig()?.static?.agent || '';
  let staticAgent = String(staticAgentArg || configured || '').trim();
  if (!staticAgent) {
    throw new Error('start: missing static agent or port. Usage: start <staticAgent> <port> (first time).');
  }
  try {
    const aliasRecord = agentsSvc.resolveEnabledAgentRecord(staticAgent);
    if (aliasRecord?.record?.alias) {
      staticAgent = `${aliasRecord.record.repoName}/${aliasRecord.record.agentName}`;
    }
  } catch (_) {
    // Graph resolution below owns the canonical not-found/ambiguity error.
  }
  const registry = deduplicateAgentRegistry(
    workspaceSvc.loadAgents(),
    dockerSvc.getAgentContainerName,
  );
  const graph = resolveWorkspaceDependencyGraph({
    staticAgentRef: staticAgent,
    registry,
  });
  const additionalNodes = resolveExtraEnabledRuntimeNodes(
    graph,
    registry,
    dockerSvc.getAgentContainerName,
  );
  const admissions = admitWorkspaceGraphRuntimeCapabilities(graph, { additionalNodes });
  return Object.freeze({ graph, registry, additionalNodes, admissions });
}

async function startWorkspace(staticAgentArg, portArg, {
  killRouterIfRunning = stopManagedRouter,
  launchManagedWatchdogImpl = launchManagedWatchdog,
  branchPolicy,
} = {}) {
  // Acquire every declared dependency source before resolving the complete
  // graph. A fresh workspace cannot admit repositories that do not exist yet.
  // Repository preparation remains ahead of authoritative workspace mutation,
  // then the exact resulting graph is admitted and retained.
  // The same admission is revalidated under the start lock before the first
  // selector, route, config, or Router write.
  const requestedStaticAgent = String(
    staticAgentArg || workspaceSvc.getConfig()?.static?.agent || '',
  ).trim();
  if (!requestedStaticAgent) {
    throw new Error('start: missing static agent or port. Usage: start <staticAgent> <port> (first time).');
  }
  try {
    prepareDefaultBootRepositories({
      branchPolicy,
      staticAgent: requestedStaticAgent,
    });
    await prepareManifestRepositories(requestedStaticAgent, {
      branchPolicy,
      profile: getActiveProfile(),
    });
  } catch (err) {
    throw new Error(`Failed to prepare manifest repositories for '${requestedStaticAgent}': ${err?.message || err}`);
  }
  const admittedStart = preflightWorkspaceStartRuntimeCapabilities(staticAgentArg);
  // The workspace mutation lease covers source initialization, candidate
  // writes, both inactive prelaunch preparations, and every subsequent start.
  // Only the final post-provider lease may authorize runtime targets.
  resetPreinstallRunInProcess();
  const workspaceStartLock = await acquireWorkspaceMutationLease({
    operation: 'workspace-start',
  });
  let workspacePreparationLease = null;
  const workspaceRuntimeCandidates = [];
  try {
  return await withNetworkLifecycleLock(async (networkLifecycleCapability) => {
  try {
  assertWorkspaceGraphAdmissionsCurrent(admittedStart.admissions);
  const lockedStart = preflightWorkspaceStartRuntimeCapabilities(staticAgentArg);
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
      console.log('[start] Existing exact-workspace Router listener is ready.');
      return container;
    } catch (error) {
      if (error?.code !== 'PLOINKY_ROUTER_NOT_READY') throw error;
      // No Router listener exists for this workspace. Replace only its managed process.
    }
    stopRouterForReplacement(killRouterIfRunning, 'start');
    const runningDir = RUNNING_DIR;
    fs.mkdirSync(runningDir, { recursive: true });
    const routerPath = path.resolve(__dirname, '../server/Watchdog.js');
    const routerPidFile = path.join(runningDir, 'router.pid');
    const { child } = await launchManagedWatchdogImpl({
      routerPath,
      port: staticPort,
      routerPidFile,
      label: 'start',
    });
    routerReadyForStart = true;
    routerPortForStart = staticPort;
    routerContainerForStart = container;
    console.log(`[start] Watchdog launched in background (pid ${child.pid}); exact-workspace Router is ready.`);
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

    // Compile the already prepared and admitted complete manifest graph into
    // one target-less inactive edge generation. Static
    // preinstall and config-provider hooks receive that exact topology before
    // any agent process or container is allowed to start.
    assertWorkspaceGraphAdmissionsCurrent(lockedStart.admissions);
    const providerRegistry = buildWorkspaceRuntimeRegistry(lockedStart.registry, cfg0);
    const dependencyGraph = lockedStart.graph;

    let reg = providerRegistry;
    workspaceSvc.saveAgents(reg);

    const { getAgentContainerName, ensureAgentService } = dockerSvc;

    const waitClassification = classifyDependencyGraphWaitMode(dependencyGraph);
    const extraRuntimeNodes = lockedStart.additionalNodes;
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

            const hookEnv = buildLifecycleHookEnv({
              agentName: resolved.shortAgentName,
              repoName: resolved.repo,
              profileName: activeProfile,
              profileConfig,
              agentPath,
            });

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
        onInitialPreparationAborted(abortedLease) {
          if (workspacePreparationLease !== abortedLease) {
            throw new Error('start: retired preparation lease did not match workspace recovery state');
          }
          workspacePreparationLease = null;
        },
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
          const runtimeResult = ensureAgentService(shortAgentName, manifest, agentPath, {
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
            networkLifecycleCapability,
          });
          if (shouldTrackWorkspaceRuntimeCandidate(runtimeResult)) {
            workspaceRuntimeCandidates.push(runtimeResult);
          }
          const {
            containerName,
            hostPort,
            registryRecord,
          } = runtimeResult;
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
          };
          if (!resolvedHostPort) delete nextRoute.hostPort;
          const readinessRoute = buildRelayReadinessRoute({
            route: nextRoute,
            manifest,
            runtimeResult,
            networkMode: launchProfile.network.mode,
            generationDigest: workspacePreparationLease?.preparedGeneration || '',
          });
          return {
            ok: true,
            containerName,
            registryRecord,
            shortAgentName,
            routeKey,
            route: nextRoute,
            readinessRoute,
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

      const blockingLaunch = blockingNames.length
        ? await updateRoutes(blockingNames)
        : { routeResults: [] };

      if (!blockingNodes.length) continue;

      const readinessEntries = blockingNodes.map((node) => {
        const registryName = registryNameByNodeId.get(node.id);
        const registryRecord = registryName ? reg[registryName] : null;
        const routeKey = registryRecord?.alias || node.alias || node.shortAgentName;
        const launchResult = blockingLaunch.routeResults.find((result) => result.routeKey === routeKey);
        const route = launchResult?.readinessRoute || cfg.routes?.[routeKey] || null;
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
        const routes = finalizeStartupRoutes(
          cfg.routes,
          current.routes,
          additionalStartup.inactiveManual,
        );
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
        }, result.readinessRoute || result.route, result.shortAgentName));
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
    workspaceRuntimeCandidates.length = 0;

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
    console.log(`[start] Dashboard: ${buildDashboardUrl(staticPort)}`);
  } catch (e) {
    const failedCandidate = e?.ploinkyRestartCandidate || null;
    cleanupWorkspaceRuntimeCandidates(workspaceRuntimeCandidates, e, {
      preparationLease: workspacePreparationLease,
      preparationAbortedBeforeCleanup:
        failedCandidate?.preparationAbortedBeforeCleanup === true,
      preparationAbortFailed: failedCandidate?.preparationAbortFailed === true,
    });
    workspacePreparationLease = null;
    const message = e?.message || String(e);
    if (message.startsWith('start:') || message.startsWith('start (workspace) failed:')) {
      throw e;
    }
    throw new Error(`start (workspace) failed: ${message}`);
  }
  });
  } finally {
    releaseWorkspaceStartLock(workspaceStartLock);
  }
}

export function admitDirectAgentRuntimeManifest(manifest, {
  manifestPath = '',
  manifestBytes,
  agentId = '',
  profileName,
  persistedProfileName,
} = {}) {
  const exactBytes = manifestBytes === undefined
    ? (manifestPath && fs.existsSync(manifestPath)
      ? fs.readFileSync(manifestPath)
      : Buffer.from(JSON.stringify(manifest || {})))
    : manifestBytes;
  const exactManifest = JSON.parse(Buffer.from(exactBytes).toString('utf8'));
  if (JSON.stringify(exactManifest) !== JSON.stringify(manifest)) {
    const error = new Error(`runtime manifest bytes changed before admission for '${agentId || manifestPath}'`);
    error.code = 'PLOINKY_RUNTIME_INPUT_CHANGED';
    error.status = 409;
    throw error;
  }
  const profileResolution = resolveManifestRuntimeProfile(exactManifest, {
    agentName: agentId,
    profileName,
    persistedProfileName,
    path: `manifest(${agentId || manifestPath})`,
  });
  const runtime = getRuntimeForAgent(exactManifest);
  const runtimeKind = isSandboxRuntime(runtime) ? runtime : 'container';
  const llmAdmissionContext = runtimeKind === 'container'
    ? resolveLlmRuntimeAdmissionContext({
      runtime,
      manifest: exactManifest,
      profileConfig: profileResolution.profileConfig,
      agentName: String(agentId || '').split('/').pop(),
      env: process.env,
    })
    : { catalogPolicy: null, catalogIdentity: null };
  const runtimeAdmission = admitManifestRuntimeCapabilities(exactManifest, {
    manifestBytes: exactBytes,
    manifestPath,
    agentId,
    profileName: profileResolution.resolvedProfileName,
    profileConfig: profileResolution.profileConfig,
    network: profileResolution.network,
    runtime,
    runtimeKind,
    catalogPolicy: llmAdmissionContext.catalogPolicy,
    catalogIdentity: llmAdmissionContext.catalogIdentity,
  });
  return Object.freeze({ runtimeAdmission, profileResolution, runtime, runtimeKind });
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
    withMaintenanceLock: withMaintenanceLockImpl = withMaintenanceLock,
    withNetworkLifecycleLock: withNetworkLifecycleLockImpl = withNetworkLifecycleLock,
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
    admitRuntimeManifest = admitDirectAgentRuntimeManifest,
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
  const directAdmission = admitRuntimeManifest(manifest, {
    manifestPath,
    agentId: resolvedManifestRef,
    persistedProfileName: registryRecord?.record?.profile,
  });
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
  const initialContainerName = registryRecord?.containerName || getAgentContainerName(shortAgentName, repoName);
  debugLog(`[runCli] agent=${agentName} container=${initialContainerName}`);
  let containerInfo = null;
  let containerName = initialContainerName;
  await withMaintenanceLockImpl(initialContainerName, {
    operation: 'cli-start',
    metadata: {
      agent: shortAgentName,
      repo: repoName,
    },
  }, async () => {
    const refreshedRecord = loadAgentsMapImpl()?.[initialContainerName];
    if (refreshedRecord?.type === 'agent') {
      registryRecord = { containerName: initialContainerName, record: refreshedRecord };
    }
    const lifecycleResult = await withNetworkLifecycleLockImpl(async (networkLifecycleCapability) => {
      let result = null;
      try {
        result = ensureAgentService(shortAgentName, manifest, agentDir, {
          containerName: registryRecord?.containerName,
          alias: registryRecord?.record?.alias,
          routerEndpoint,
          runtimeAdmission: directAdmission.runtimeAdmission,
          networkLifecycleCapability,
        });
        const exactContainerName = result?.containerName
          || registryRecord?.containerName
          || initialContainerName;
        const cliReadinessRoute = buildRelayReadinessRoute({
          route: {
            container: exactContainerName,
            hostPort: result?.hostPort || 0,
          },
          manifest,
          runtimeResult: result,
          networkMode: routerEndpoint?.mode || '',
          generationDigest: result?.preparationLease?.preparedGeneration || '',
        });
        const readinessProtocol = resolveAgentReadinessProtocolImpl(manifest);
        if (readinessProtocol === 'script') {
          await waitForManifestReadinessImpl({
            key: `cli:${shortAgentName}`,
            label: shortAgentName,
            manifest,
            route: cliReadinessRoute,
          });
        } else if (readinessProtocol !== 'none') {
          const hasReadinessTarget = Boolean(cliReadinessRoute.hostPort || cliReadinessRoute.relay);
          if (!hasReadinessTarget) {
            if (result?.requiresEdgeActivation) {
              throw new Error(`Agent '${shortAgentName}' replacement cannot activate without a resolved '${readinessProtocol}' readiness target.`);
            }
            if (!suppressLauncherLogs) {
              warn(`[cli] warning: cannot wait for '${shortAgentName}' readiness because no host port or confined relay target was resolved.`);
            }
          } else {
            if (!suppressLauncherLogs) {
              log(`[cli] Waiting for '${shortAgentName}' readiness (${readinessProtocol})...`);
            }
            const ready = await waitForAgentReadyImpl(cliReadinessRoute, {
              timeoutMs: 600000,
              protocol: readinessProtocol,
            });
            if (!ready) {
              throw new Error(`Agent '${shortAgentName}' did not become ready before CLI attach.`);
            }
          }
        }
        await activateRuntimeAfterReadinessImpl({
          result,
          routeKey: registryRecord?.record?.alias || shortAgentName,
          repoName,
          shortAgentName,
          agentPath: agentDir,
          alias: registryRecord?.record?.alias || '',
          networkLifecycleCapability,
        });
        return { containerInfo: result, containerName: exactContainerName };
      } catch (error) {
        cleanupFailedPreparedRuntime(result, error);
        throw error;
      }
    });
    containerInfo = lifecycleResult.containerInfo;
    containerName = lifecycleResult.containerName;
  });

  // Determine actual runtime from registry (may differ from manifest if sandbox
  // failed and fell back to container during ensureAgentService)
  const agents = loadAgentsMapImpl();
  const registryEntry = agents[containerName] || {};
  const actualRuntime = registryEntry.runtime;

  let exitCode = 0;
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
      || (await import('../sandbox/bwrap/bwrapServiceManager.js')).attachBwrapInteractive;
    exitCode = withSuspendedInput(() => {
      return attach(shortAgentName, manifest, agentDir, projectPath, cmd, { containerName, routerEndpoint });
    });
  } else if (actualRuntime === 'seatbelt') {
    const attach = attachSeatbeltInteractive
      || (await import('../sandbox/seatbelt/seatbeltServiceManager.js')).attachSeatbeltInteractive;
    exitCode = withSuspendedInput(() => {
      return attach(shortAgentName, manifest, agentDir, projectPath, cmd, { containerName, routerEndpoint });
    });
  } else {
    exitCode = withSuspendedInput(() => {
      return attachInteractive(containerName, projectPath, cmd);
    });
  }
  return Number.isInteger(exitCode) ? exitCode : 0;
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
  const directAdmission = admitDirectAgentRuntimeManifest(manifest, {
    manifestPath,
    agentId: manifestLookup,
    persistedProfileName: registryRecord?.record?.profile,
  });
  const routerEndpoint = resolveManifestRouterEndpoint(manifest, {
    persistedProfileName: registryRecord?.record?.profile,
    path: `manifest(${manifestLookup})`,
  });
  const { ensureAgentService, attachInteractive, getConfiguredProjectPath, getAgentContainerName } = dockerSvc;
  const agentDir = path.dirname(manifestPath);
  const repoName = path.basename(path.dirname(agentDir));
  const registeredContainerName = registryRecord?.containerName || getAgentContainerName(shortAgentName, repoName);
  const { containerInfo, containerName } = await withNetworkLifecycleLock(async (networkLifecycleCapability) => {
    let result = null;
    try {
      result = ensureAgentService(shortAgentName, manifest, agentDir, {
        containerName: registeredContainerName,
        alias: registryRecord?.record?.alias,
        routerEndpoint,
        runtimeAdmission: directAdmission.runtimeAdmission,
        networkLifecycleCapability,
      });
      const exactContainerName = result?.containerName || registeredContainerName;
      const shellReadinessRoute = buildRelayReadinessRoute({
        route: {
          container: exactContainerName,
          hostPort: result?.hostPort || 0,
        },
        manifest,
        runtimeResult: result,
        networkMode: routerEndpoint?.mode || '',
        generationDigest: result?.preparationLease?.preparedGeneration || '',
      });
      await waitForManifestReadiness({
        key: `shell:${shortAgentName}`,
        label: shortAgentName,
        kind: 'dependency',
        manifest,
        route: shellReadinessRoute,
      });
      await activatePreparedRuntimeAfterReadiness({
        result,
        routeKey: registryRecord?.record?.alias || shortAgentName,
        repoName,
        shortAgentName,
        agentPath: agentDir,
        alias: registryRecord?.record?.alias || '',
      });
      return { containerInfo: result, containerName: exactContainerName };
    } catch (error) {
      cleanupFailedPreparedRuntime(result, error);
      throw error;
    }
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
    const { attachBwrapInteractive } = await import('../sandbox/bwrap/bwrapServiceManager.js');
    runWithSuspendedInput(() => {
      attachBwrapInteractive(shortAgentName, manifest, agentDir, projPath, cmd, { containerName, routerEndpoint });
    });
  } else if (actualRuntime === 'seatbelt') {
    console.log(`[shell] seatbelt agent: ${shortAgentName}`);
    console.log(`[shell] command: ${cmd}`);
    const { attachSeatbeltInteractive } = await import('../sandbox/seatbelt/seatbeltServiceManager.js');
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

async function reinstallAgent(agentName, {
    killRouterIfRunningImpl = stopManagedRouter,
    launchManagedWatchdogImpl = launchManagedWatchdog,
} = {}) {
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
    const directAdmission = admitDirectAgentRuntimeManifest(manifest, {
        manifestPath: resolved.manifestPath,
        agentId: `${resolved.repo}/${resolved.shortAgentName}`,
        persistedProfileName: registryRecord?.record?.profile,
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
          return await withNetworkLifecycleLock(async (networkLifecycleCapability) => {
            let reinstallResult = null;
            try {
            const short = resolved.shortAgentName;
            const agentPath = path.dirname(resolved.manifestPath);

            // The shared runtime manager owns inactivation and physical
            // replacement for every backend, including host sandboxes.
            reinstallResult = await ensureAgentService(short, manifest, agentPath, {
                containerName,
                alias: registryRecord?.record?.alias,
                forceRecreate: true,
                routerEndpoint,
                runtimeAdmission: directAdmission.runtimeAdmission,
                networkLifecycleCapability,
            });
            const { containerName: newContainerName, hostPort } = reinstallResult;

            const repoName = path.basename(path.dirname(agentPath));
            const routeKey = registryRecord?.record.alias || short;
            const reinstallReadinessRoute = buildRelayReadinessRoute({
                route: {
                    container: newContainerName,
                    hostPort: hostPort || 0,
                },
                manifest,
                runtimeResult: reinstallResult,
                networkMode: routerEndpoint?.mode || '',
                generationDigest: reinstallResult?.preparationLease?.preparedGeneration || '',
            });

            await waitForManifestReadiness({
                key: `reinstall:${routeKey}`,
                label: short,
                kind: 'reinstall',
                manifest,
                route: reinstallReadinessRoute,
            });

            await activatePreparedRuntimeAfterReadiness({
                result: reinstallResult,
                routeKey,
                repoName,
                shortAgentName: short,
                agentPath,
                alias: registryRecord?.record?.alias || '',
            });

            let routerIsReady = false;
            try {
                await waitForRouterReady(routerPort, null, 300);
                routerIsReady = true;
            } catch (routerError) {
                if (routerError?.code !== 'PLOINKY_ROUTER_NOT_READY') throw routerError;
            }
            if (!routerIsReady) {
                stopRouterForReplacement(killRouterIfRunningImpl, 'reinstall');
                const runningDir = RUNNING_DIR;
                fs.mkdirSync(runningDir, { recursive: true });
                const routerPath = path.resolve(__dirname, '../server/Watchdog.js');
                const routerPidFile = path.join(runningDir, 'router.pid');
                const { child } = await launchManagedWatchdogImpl({
                    routerPath,
                    port: routerPort,
                    routerPidFile,
                    label: 'reinstall',
                });
                console.log(`[reinstall] Watchdog launched (pid ${child.pid}) on port ${routerPort}.`);
                console.log('[reinstall] Exact-workspace Router readiness verified; Watchdog will restart it if needed.');
            }
            console.log(`[reinstall] reinstalled '${short}' [container: ${newContainerName}]`);
            } catch (error) {
              cleanupFailedPreparedRuntime(reinstallResult, error, 'runtime-reinstall-readiness-failed');
              throw error;
            }
          });
        });
    } catch (e) {
        console.error(`[reinstall] ${agentName}: ${e?.message||e}`);
        throw e;
    }
}

export {
  assertStaticPreinstallSucceeded,
  buildDashboardUrl,
  buildBlockingReadinessEntryFromNode,
  activatePreparedRuntimeAfterReadiness,
  ensureGraphNodesEnabled,
  reprepareGraphAfterStartupProviders,
  resolveExtraEnabledRuntimeNodes,
  resolveManifestRouterEndpoint,
  resolveAndPersistStartRouterPort,
  resolveGraphNodeExecutionRecord,
  resolveRetainedGraphNodeExecutionRecord,
  acquireSpawnedRouterProcessRecord,
  launchManagedWatchdog,
  probeRouterHealthSocket,
  requireRouterReplacementStopped,
  stopRouterForReplacement,
  waitForRouterReady,
  waitForManifestReadiness,
  waitForReadinessEntries,
  startWorkspace,
  runCli,
  runShell,
  reinstallAgent
};
