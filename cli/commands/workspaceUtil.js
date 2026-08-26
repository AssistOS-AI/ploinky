import fs from 'fs';
import path from 'path';
import net from 'net';
import { randomUUID } from 'node:crypto';
import { spawn, execSync } from 'child_process';
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
import { removeExactRegisteredContainer } from '../sandbox/docker/containerFleet.js';
import { isBwrapProcessRunning } from '../sandbox/bwrap/bwrapFleet.js';
import * as inputState from './inputState.js';
import { MAX_NO_WAIT_BARRIER_ENTRIES, MAX_NO_WAIT_WAVE_INDEX } from './noWaitWorker.js';
import {
  noWaitRunScopedLogPath,
  noWaitRunScopedStatusPath,
} from './noWaitPaths.js';
import { prepareDefaultBootRepositories } from './ploinkyboot.js';
import { prepareManifestRepositories } from '../utils/runtime/bootstrapManifest.js';
import { buildLifecycleHookEnv, executeHostHook, markPreinstallRunInProcess, resetPreinstallRunInProcess, isInlineCommand } from '../utils/runtime/lifecycleHooks.js';
import { getActiveProfile, getProfileConfig, resolveManifestRuntimeProfile } from '../utils/runtime/profileService.js';
import { loadEnvFile } from '../utils/security/secretInjector.js';
import { readSecretsFile } from '../utils/security/encryptedSecretsFile.js';
import {
  sanitizeManagedMasterKeyEnvironment,
} from '../utils/security/masterKey.js';
import { getExposedNames, getManifestEnvNames } from '../utils/security/secretVars.js';
import {
  isLlmRuntimeManifest,
  prepareLlmStartup,
  resolveLlmRuntimeAdmissionContext,
} from '../sandbox/docker/llmRuntimeIntegration.js';
import { resolveAgentExecutionMode, resolveAgentReadinessProtocol } from '../utils/runtime/startupReadiness.js';
import { normalizeProbeConfig, runContainerScriptReadiness } from '../sandbox/docker/healthProbes.js';
import { applyStartupConfigProvidersForGraph } from '../sandbox/startupConfigProviders.js';
import { createWorkspaceStartLock, releaseWorkspaceStartLock, withMaintenanceLock } from '../utils/runtime/maintenanceLocks.js';
import {
  AGENTS_DATA_DIR,
  LOGS_DIR,
  PLOINKY_CWD,
  PLOINKY_DIR,
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
import { deriveAgentPrincipalId } from '../utils/security/agentIdentity.js';
import {
  GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE,
  readVerifiedGeneratedRouterDescriptorFile,
} from '../utils/security/generatedRouterDescriptor.js';
import { sanitizeDiagnosticText } from '../utils/diagnosticText.js';
import { waitForChildSpawn } from '../utils/childSpawn.js';
import {
  assertSafeRelativeSegment,
  ensureVerifiedProducerDirectory,
} from '../utils/verifiedReadOnlyFile.js';
import {
  assertRouterEndpoint,
  parseRouterPort,
  resolveInitialRouterPort,
  resolvePersistedRouterPort,
  resolveRouterEndpoint,
} from '../sandbox/routerPort.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// One run-scoped log per detached worker. Two starts of the same agent must
// never share a file: interleaved output from a superseded run is unreadable,
// and a follower bound to the current run would show a predecessor's lines.
// Exclusive creation makes a collision a spawn failure instead of an append.
function createRunScopedLogStdio(logFile) {
  ensureVerifiedProducerDirectory({
    trustedRoot: PLOINKY_WORKSPACE_ROOT,
    relativeSegments: ['.ploinky', 'logs', 'no-wait'],
    mode: 0o700,
  });
  // A single descriptor carries both streams so interleaved worker output
  // keeps one append offset.
  let descriptor;
  let opened;
  try {
    descriptor = fs.openSync(logFile, 'wx', 0o600);
    opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new Error('no-wait log producer did not open one regular file');
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    if (opened) {
      try {
        const current = fs.lstatSync(logFile);
        if (current.dev === opened.dev && current.ino === opened.ino) fs.unlinkSync(logFile);
      } catch (_) {}
    }
    throw error;
  }
  return {
    stdio: ['ignore', descriptor, descriptor],
    closeParentFds() {
      try { fs.closeSync(descriptor); } catch (_) {}
    },
    discard() {
      try { fs.closeSync(descriptor); } catch (_) {}
      try {
        const current = fs.lstatSync(logFile);
        if (current.dev === opened.dev && current.ino === opened.ino) fs.unlinkSync(logFile);
      } catch (_) {}
    },
  };
}

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
// cycles without depending on the operator having `export`'d each one. Managed
// Boxes then remove PLOINKY_MASTER_KEY because core reads its owned key file.
export function sanitizeRouterEnvironment(environment, { managedBox } = {}) {
  return sanitizeManagedMasterKeyEnvironment(environment, { managedBox });
}

export function buildRouterEnv({ managedBox } = {}) {
  let envFile = {};
  try { envFile = loadEnvFile() || {}; } catch (_) { envFile = {}; }
  let secrets = {};
  try { secrets = readSecretsFile() || {}; } catch (_) { secrets = {}; }
  return sanitizeRouterEnvironment(
    { ...envFile, ...secrets, ...process.env },
    { managedBox },
  );
}

async function spawnNoWaitWorker({
  node,
  registryName,
  routeKey,
  registryAlias,
  routerPort,
  forceRecreate = false,
  runId,
  runStartedAtMs,
  waveIndex,
  statusFile,
  waitForStatuses = [],
}) {
  const containerName = registryName;
  const noWaitStatusDir = path.join(RUNNING_DIR, 'no-wait');
  // Derived from the same validated container name and run UUID as the
  // run-scoped status, so a marker, a status, and a log always agree on which
  // run they describe.
  const logFile = noWaitRunScopedLogPath(containerName, runId);
  const canonicalStatusFile = path.join(noWaitStatusDir, `${containerName}.json`);
  const resolvedStatusFile = noWaitCoordinationStatusPath(containerName, runId);
  if (statusFile && path.resolve(statusFile) !== resolvedStatusFile) {
    throw new Error(`no-wait worker '${containerName}' was scheduled with a foreign coordination status file`);
  }
  if (!Number.isSafeInteger(waveIndex) || waveIndex < 0
      || waveIndex > MAX_NO_WAIT_WAVE_INDEX) {
    throw new Error(
      `no-wait worker '${containerName}' requires one exact wave index between 0 and ${MAX_NO_WAIT_WAVE_INDEX}`,
    );
  }
  const workerScript = path.resolve(__dirname, 'noWaitWorker.js');
  // Every run-scoped argument is mandatory and unconditional. An omitted flag
  // must never let a worker silently select another coordination protocol.
  const args = [
    workerScript,
    '--container', containerName,
    '--short-agent', node.shortAgentName,
    '--repo', node.repoName,
    '--manifest-path', node.manifestPath,
    '--agent-path', node.agentPath,
    '--route-key', String(routeKey || registryAlias || node.shortAgentName),
    '--run-id', runId,
    '--run-started-at-ms', String(exactNoWaitRunStartedAtMs(runStartedAtMs)),
    '--wave-index', String(waveIndex),
    '--status-file', resolvedStatusFile,
    '--wait-for-statuses', JSON.stringify(waitForStatuses || []),
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
  // An open or spawn failure must surface as a spawn failure so the caller
  // publishes the bounded, redacted terminal status. Silently downgrading to
  // ignored stdio would leave a valid-looking worker with no diagnostics.
  const logStdio = createRunScopedLogStdio(logFile);
  try {
    writeNoWaitRunMarker({
      registryName,
      runId,
      runStartedAtMs,
      waveIndex,
      statusFile: resolvedStatusFile,
    });
  } catch (error) {
    // The marker was not published, so this task-owned, unexposed log can be
    // removed. A spawn failure after publication deliberately retains it.
    logStdio.discard();
    throw error;
  }
  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: logStdio.stdio,
      env: { ...process.env }
    });
    await waitForChildSpawn(child, {
      label: `no-wait worker '${containerName}'`,
    });
  } finally {
    logStdio.closeParentFds();
  }
  child.unref();
  return {
    pid: child.pid,
    logFile,
    statusFile: resolvedStatusFile,
    canonicalStatusFile,
  };
}

// The run identity and its derived file names live in `noWaitPaths.js` so the
// read-only `logs` observer can share them without importing this pipeline.
function noWaitCoordinationStatusPath(containerName, runId, {
  runningDir = RUNNING_DIR,
} = {}) {
  return noWaitRunScopedStatusPath(containerName, runId, { runningDir });
}

// One run start is shared by every worker in the run. Queued workers derive
// their cumulative wave budget from it, so it must be an exact epoch integer
// rather than a per-worker clock sample.
function exactNoWaitRunStartedAtMs(value) {
  const runStartedAtMs = Number(value);
  if (!Number.isSafeInteger(runStartedAtMs) || runStartedAtMs < 0) {
    throw new Error('no-wait run start must be one exact non-negative epoch millisecond integer');
  }
  return runStartedAtMs;
}

export function buildNoWaitLaunchSchedule(deferredNoWaitWaves, {
  runId,
  runStartedAtMs,
  runningDir = RUNNING_DIR,
} = {}) {
  const exactRunStartedAtMs = exactNoWaitRunStartedAtMs(runStartedAtMs);
  const waves = (Array.isArray(deferredNoWaitWaves) ? deferredNoWaitWaves : [])
    .map((entries) => (Array.isArray(entries) ? entries.filter(Boolean) : []))
    .filter((entries) => entries.length > 0);
  // The worker rejects any wave index beyond this bound. Fail in the
  // foreground rather than reporting detached launches whose workers would
  // exit before publishing a status and stall every later wave.
  if (waves.length > MAX_NO_WAIT_WAVE_INDEX + 1) {
    throw new Error(
      `no-wait launch schedule has ${waves.length} waves, which exceeds the supported maximum of ${MAX_NO_WAIT_WAVE_INDEX + 1}`,
    );
  }
  const statusByNodeId = new Map();
  const nodeIdByStatus = new Map();
  waves.forEach((entries, waveIndex) => {
    for (const entry of entries) {
      if (!entry?.node?.id || !entry.registryName) continue;
      if (statusByNodeId.has(entry.node.id)) {
        throw new Error(`no-wait launch schedule repeats graph node '${entry.node.id}'`);
      }
      const statusPath = noWaitCoordinationStatusPath(entry.registryName, runId, { runningDir });
      if (nodeIdByStatus.has(statusPath)) {
        throw new Error(
          `no-wait launch schedule maps '${entry.node.id}' and '${nodeIdByStatus.get(statusPath)}' to one status file`,
        );
      }
      nodeIdByStatus.set(statusPath, entry.node.id);
      // The recorded wave index belongs to the referenced target, not to the
      // worker that will wait for it. A waiter needs the target's wave to bind
      // the observed status and to size its cumulative queued budget.
      statusByNodeId.set(entry.node.id, Object.freeze({
        nodeId: entry.node.id,
        path: statusPath,
        runId,
        waveIndex,
      }));
    }
  });

  // A worker waits for its own dependencies and nothing else. Gating on every
  // member of the immediately preceding wave made an agent wait on peers it has
  // no relationship with: in a measured run soul-gateway, whose only dependency
  // is default-local-llm, sat idle behind an unrelated onlyOffice launch. The
  // dependency graph already expresses the ordering that correctness needs.
  return waves.map((entries, waveIndex) => {
    const scheduled = entries.map((entry) => {
      const directDependencyIds = new Set(entry.node?.dependencies || []);
      const references = new Map();
      const addReference = (reference, directDependency) => {
        if (!reference) return;
        // The worker rejects a barrier entry that does not name a strictly
        // earlier wave, exiting before it can publish a status while the parent
        // still reports a successful spawn. Reject it here instead.
        if (reference.waveIndex >= waveIndex) {
          throw new Error(
            `no-wait launch schedule points '${entry.node.id}' in wave ${waveIndex} at '${reference.nodeId}' in wave ${reference.waveIndex}`,
          );
        }
        const existing = references.get(reference.path);
        if (existing && (existing.nodeId !== reference.nodeId
          || existing.runId !== reference.runId
          || existing.waveIndex !== reference.waveIndex)) {
          throw new Error(
            `no-wait launch schedule maps two distinct barrier identities to '${path.basename(reference.path)}'`,
          );
        }
        references.set(reference.path, {
          ...reference,
          directDependency: Boolean(directDependency || existing?.directDependency),
        });
      };
      for (const dependencyId of directDependencyIds) {
        addReference(statusByNodeId.get(dependencyId), true);
      }
      // The worker rejects a barrier larger than this, and would exit during
      // argument parsing without publishing a terminal status while the parent
      // reported a successful spawn. Fail in the foreground instead.
      if (references.size > MAX_NO_WAIT_BARRIER_ENTRIES) {
        throw new Error(
          `no-wait launch schedule gives '${entry.node.id}' ${references.size} barrier entries, which exceeds the supported maximum of ${MAX_NO_WAIT_BARRIER_ENTRIES}`,
        );
      }
      return Object.freeze({
        ...entry,
        waveIndex,
        runId,
        runStartedAtMs: exactRunStartedAtMs,
        statusFile: statusByNodeId.get(entry.node.id)?.path || '',
        waitForStatuses: Object.freeze(Array.from(references.values(), Object.freeze)),
      });
    });
    return Object.freeze(scheduled);
  });
}

function writeNoWaitAtomicJson(target, payload) {
  const resolvedTarget = path.resolve(String(target || ''));
  const targetDirectory = path.dirname(resolvedTarget);
  if (path.basename(targetDirectory) !== 'no-wait') {
    throw new Error('no-wait status publication requires a file in the workspace no-wait directory');
  }
  assertSafeRelativeSegment(path.basename(resolvedTarget), 'no-wait status filename');
  let targetRunningDirectory;
  let workspaceRunningDirectory;
  try {
    targetRunningDirectory = fs.realpathSync(path.dirname(targetDirectory));
    workspaceRunningDirectory = fs.realpathSync(RUNNING_DIR);
  } catch (_) {
    throw new Error('no-wait status publication requires the existing workspace running directory');
  }
  if (targetRunningDirectory !== workspaceRunningDirectory) {
    throw new Error('no-wait status publication requires a file in the workspace no-wait directory');
  }
  ensureVerifiedProducerDirectory({
    trustedRoot: PLOINKY_WORKSPACE_ROOT,
    relativeSegments: ['.ploinky', 'running', 'no-wait'],
    mode: 0o700,
  });
  const temporary = `${resolvedTarget}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, resolvedTarget);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function writeNoWaitRunMarker(entry) {
  const target = path.join(RUNNING_DIR, 'no-wait', `${entry.registryName}.current.json`);
  writeNoWaitAtomicJson(target, {
    runId: entry.runId,
    runStartedAtMs: exactNoWaitRunStartedAtMs(entry.runStartedAtMs),
    statusFile: path.basename(entry.statusFile),
    waveIndex: entry.waveIndex,
    createdAt: new Date().toISOString(),
  });
}

export function writeNoWaitSpawnFailure(entry, error) {
  const finishedAtMs = Date.now();
  // This runs inside the spawn loop's catch. Without an exact coordination
  // path there is nothing to publish, and throwing here would replace the
  // original spawn failure with an unrelated rename error and abort the start.
  const coordinationStatusFile = String(entry?.statusFile || '');
  if (!coordinationStatusFile || !entry?.registryName) {
    throw new Error('no-wait spawn failure requires the exact run-scoped status identity');
  }
  // A spawn failure has to be a valid terminal member of a wave barrier so a
  // dependent worker can make a deterministic dependency decision instead of
  // stalling on a status that never arrives.
  const payload = {
    state: 'failed',
    sequencePhase: 'active',
    phase: 'spawn',
    runId: entry.runId,
    runStartedAtMs: exactNoWaitRunStartedAtMs(entry.runStartedAtMs),
    containerName: entry.registryName,
    shortAgent: entry.node.shortAgentName,
    repoName: entry.node.repoName,
    waveIndex: entry.waveIndex,
    startedAt: new Date(finishedAtMs).toISOString(),
    startedAtMs: finishedAtMs,
    sequencePhaseStartedAt: new Date(finishedAtMs).toISOString(),
    sequencePhaseStartedAtMs: finishedAtMs,
    finishedAt: new Date(finishedAtMs).toISOString(),
    finishedAtMs,
    error: { message: sanitizeDiagnosticText(error) },
  };
  const canonical = path.join(RUNNING_DIR, 'no-wait', `${entry.registryName}.json`);
  // Match the worker's publication protocol: the canonical monitor view must
  // be durable before the run-scoped file releases a dependent wave.
  for (const target of new Set([canonical, entry.statusFile])) {
    writeNoWaitAtomicJson(target, payload);
  }
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

function retainedManagedDescriptorBind(record) {
  const binds = (record?.config?.binds || []).filter((bind) => (
    String(bind?.target || '') === GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE
  ));
  if (binds.length !== 1
      || binds[0]?.generatedRouterDescriptor !== true
      || binds[0]?.ro !== true) {
    return null;
  }
  return binds[0];
}

function computeRetainedManagedEnvHash(node, record, profileConfig, runtimeNetworkPlan, {
  computeEnvHashImpl = computeEnvHash,
  descriptorRoot = path.join(PLOINKY_DIR, 'run', 'router-descriptors'),
  deriveAgentPrincipalIdImpl = deriveAgentPrincipalId,
  readDescriptorFileImpl = readVerifiedGeneratedRouterDescriptorFile,
} = {}) {
  try {
    const bind = retainedManagedDescriptorBind(record);
    if (!bind) return '';
    const root = path.resolve(descriptorRoot);
    const source = path.resolve(String(bind.source || ''));
    const relative = path.relative(root, source);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(relative)
        || relative.startsWith('..')
        || path.isAbsolute(relative)
        || relative.includes(path.sep)) {
      return '';
    }
    const realRoot = fs.realpathSync.native(root);
    const realSource = fs.realpathSync.native(source);
    if (realSource !== path.join(realRoot, relative)) return '';

    const payload = readDescriptorFileImpl(source)?.payload;
    const principalId = deriveAgentPrincipalIdImpl(node.repoName, node.shortAgentName);
    if (payload?.agentPrincipal !== principalId
        || payload?.instanceId !== String(record.instanceId || '')
        || payload?.generationId !== String(record.enableGeneration || '')) {
      return '';
    }
    return computeEnvHashImpl(node.manifest, profileConfig, {
      ...runtimeNetworkPlan.hashEnv,
      PLOINKY_ROUTER_SEMANTIC_TOPOLOGY_DIGEST: payload.semanticTopologyDigest,
      PLOINKY_ROUTER_DESCRIPTOR_SCHEMA: payload.schema,
      PLOINKY_ROUTER_TRANSPORT_VERSION: payload.transportVersion,
      PLOINKY_ROUTER_LOCAL_STREAMING: payload.localStreaming,
      PLOINKY_AGENT_PRINCIPAL: principalId,
      PLOINKY_AGENT_INSTANCE_ID: record.instanceId,
      PLOINKY_AGENT_ENABLE_GENERATION: record.enableGeneration,
    }, { agentName: node.shortAgentName, repoName: node.repoName });
  } catch (_) {
    return '';
  }
}

function removeGraphContainerForRecreate(containerName, label, predecessorRecord, {
  clearLivenessStateImpl = dockerSvc.clearLivenessState,
  containerExistsImpl = dockerSvc.containerExists,
  getRuntimeImpl = dockerSvc.getRuntime,
  removeExactRegisteredContainerImpl = removeExactRegisteredContainer,
} = {}) {
  if (!containerExistsImpl(containerName)) return { removed: false, state: 'absent' };
  try {
    const result = removeExactRegisteredContainerImpl(containerName, predecessorRecord, {
      runtime: getRuntimeImpl(),
    });
    if (result?.removed !== true) {
      throw new Error(`exact predecessor removal returned '${result?.state || 'unknown'}'`);
    }
    clearLivenessStateImpl(containerName);
    return result;
  } catch (cause) {
    const error = new Error(
      `[${label}] preserved container '${containerName}' because exact immutable ownership/removal was not proven`,
      { cause },
    );
    error.code = 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS';
    throw error;
  }
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
  computeRetainedManagedEnvHashImpl = computeRetainedManagedEnvHash,
  retainedManagedEnvHashOptions,
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
  const baseEnvHash = computeEnvHashImpl(
    node.manifest,
    profileResolution.profileConfig,
    { ...runtimeRouterEnv, ...runtimeNetworkPlan.hashEnv },
    { agentName: node.shortAgentName, repoName: node.repoName },
  );
  const desiredEnvHash = runtimeNetworkPlan.requiresManagedNetwork
    ? computeRetainedManagedEnvHashImpl(
        node,
        record,
        profileResolution.profileConfig,
        runtimeNetworkPlan,
        retainedManagedEnvHashOptions,
      )
    : baseEnvHash;
  if (runtimeNetworkPlan.requiresManagedNetwork && !desiredEnvHash) {
    return 'managedRouterDescriptorDrift';
  }
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
      envHash: baseEnvHash,
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
    return isBwrapProcessRunning(record.agentName);
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
  removeAgentContainerForRecreate = removeGraphContainerForRecreate,
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
    existingPlans.push({
      ...preliminary,
      runtimeReason,
      // The desired registry receives a fresh candidate tuple before removal
      // so the inactive generation can be compiled. Keep a detached snapshot
      // as the only ownership proof authorized to remove the predecessor.
      predecessorRecord: structuredClone(existing.rec),
    });
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
        plan.predecessorRecord,
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
}, {
  mergeRouting = mergeRoutingConfig,
  cleanupFailure = cleanupFailedPreparedRuntime,
} = {}) {
  if (!result?.requiresEdgeActivation) return false;
  if (!result?.containerName || !result?.registryRecord) {
    throw new Error('runtime replacement activation requires one exact returned container and registry record');
  }
  if (!result?.preparationLease) {
    throw new Error('runtime replacement activation requires its exact preparation lease');
  }
  try {
    await mergeRouting((cfg) => {
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
  } catch (error) {
    cleanupFailure(
      result,
      error,
      'runtime-replacement-activation-failed',
    );
    throw error;
  }
}

const handledPreparedRuntimeFailures = new WeakSet();

export function cleanupFailedPreparedRuntime(
  result,
  error,
  reason = 'runtime-replacement-readiness-failed',
  {
    cleanupCandidate = dockerSvc.cleanupExactAgentRuntimeCandidate,
    inactivate = inactivateEdgeRoutingGeneration,
    abortPreparation = abortEdgeRoutingPreparation,
  } = {},
) {
  if (!result) return;
  // The activation helper and its lifecycle caller see the same prepared
  // runtime. Cleanup receipts are intentionally single-use authority, so the
  // first failure owner consumes the transaction and every outer catch is a
  // no-op for that exact result.
  if (typeof result === 'object') {
    if (handledPreparedRuntimeFailures.has(result)) return;
    handledPreparedRuntimeFailures.add(result);
  }
  if (result.preparationLease && result.containerName && result.containerId && result.registryRecord) {
    try {
      cleanupCandidate(result);
    } catch (cleanupError) {
      error.message += `; exact runtime-failure cleanup: ${cleanupError?.message || cleanupError}`;
    }
  }
  if (!result.preparationLease) return;
  try {
    inactivate(reason, { preserveSelectedGeneration: true });
  } catch (_) {}
  try {
    abortPreparation(result.preparationLease, { reason });
  } catch (_) {}
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

function buildRouterUrl(staticPort, env = process.env) {
  const publicAuthority = String(env.PLOINKY_PUBLIC_AUTHORITY || '').trim();
  return publicAuthority
    ? `http://${publicAuthority}`
    : `http://127.0.0.1:${staticPort}`;
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
  killRouterIfRunning,
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
  const workspaceStartLock = createWorkspaceStartLock();
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

    // Compile the already prepared and admitted complete manifest graph into
    // one target-less inactive edge generation. Static
    // preinstall and config-provider hooks receive that exact topology before
    // any agent process or container is allowed to start.
    assertWorkspaceGraphAdmissionsCurrent(lockedStart.admissions);
    const providerRegistry = lockedStart.registry;
    const dependencyGraph = lockedStart.graph;

    // The locked admission intentionally precedes the first config mutation,
    // so its registry snapshot cannot contain the static identity persisted
    // above on an initial start. Refresh the non-authorizing workspace config
    // before saving that admitted registry; otherwise this stale write removes
    // `_config.static` and a later zero-argument start cannot recover it.
    let reg = deduplicateAgentRegistry(providerRegistry, dockerSvc.getAgentContainerName);
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
          if (runtimeResult?.requiresEdgeActivation === true
              && runtimeResult?.preparationLease
              && runtimeResult?.containerId) {
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

    const deferredNoWaitWaves = [];
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

      if (noWaitWaveNodes.length) {
        deferredNoWaitWaves.push(noWaitWaveNodes);
      }

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

    const noWaitRunId = randomUUID();
    const noWaitRunStartedAtMs = Date.now();
    const noWaitSchedule = buildNoWaitLaunchSchedule(deferredNoWaitWaves, {
      runId: noWaitRunId,
      runStartedAtMs: noWaitRunStartedAtMs,
    });
    // Clear every public and run-scoped status before spawning any worker.
    // The UUID-scoped coordination paths prevent a late writer from an older
    // detached invocation from satisfying this run's wave barrier.
    if (noWaitSchedule.length) {
      ensureVerifiedProducerDirectory({
        trustedRoot: PLOINKY_WORKSPACE_ROOT,
        relativeSegments: ['.ploinky', 'running', 'no-wait'],
        mode: 0o700,
      });
    }
    for (const entry of noWaitSchedule.flat()) {
      if (!entry.registryName || !entry.statusFile) continue;
      const canonicalStatusFile = path.join(RUNNING_DIR, 'no-wait', `${entry.registryName}.json`);
      for (const target of new Set([canonicalStatusFile, entry.statusFile])) {
        try { fs.unlinkSync(target); } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
    for (const wave of noWaitSchedule) {
      for (const entry of wave) {
        const { node, registryName } = entry;
        if (!registryName) {
          console.warn(`[start] no-wait node '${formatGraphNodeLabel(node, staticAgent)}' missing registry entry; skipping background launch.`);
          continue;
        }
        const rec = reg[registryName] || {};
        const routeKey = rec.alias || node.shortAgentName;
        try {
          const { pid, logFile, statusFile } = await spawnNoWaitWorker({
            node,
            registryName,
            routeKey,
            registryAlias: rec.alias || node.alias || '',
            routerPort: staticPort,
            forceRecreate: newlyPreparedContainers.has(registryName),
            runId: entry.runId,
            runStartedAtMs: entry.runStartedAtMs,
            waveIndex: entry.waveIndex,
            statusFile: entry.statusFile,
            waitForStatuses: entry.waitForStatuses,
          });
          console.log(`[start] ${formatGraphNodeLabel(node, staticAgent)}: no-wait wave ${entry.waveIndex + 1}/${noWaitSchedule.length} launch started (pid ${pid}). log=${logFile} status=${statusFile}`);
        } catch (spawnErr) {
          // Publishing the terminal status is best-effort here. Letting it
          // throw would replace the real spawn failure with a publication
          // error and abort the whole start instead of reporting this node.
          try {
            writeNoWaitSpawnFailure(entry, spawnErr);
          } catch (publishErr) {
            console.error(sanitizeDiagnosticText(
              `[start] no-wait spawn failure status for '${formatGraphNodeLabel(node, staticAgent)}' could not be published: ${sanitizeDiagnosticText(publishErr)}`,
              { singleLine: true },
            ));
          }
          console.error(sanitizeDiagnosticText(
            `[start] no-wait launch for '${formatGraphNodeLabel(node, staticAgent)}' failed to spawn: ${sanitizeDiagnosticText(spawnErr)}`,
            { singleLine: true },
          ));
        }
      }
    }

    console.log(`[start] Watchdog will automatically restart the server if it crashes.`);
    console.log(`[start] Server logs: ${path.join(LOGS_DIR, 'router.log')}`);
    console.log(`[start] Watchdog logs: ${path.join(LOGS_DIR, 'watchdog.log')}`);
    console.log(`[start] Router: ${buildRouterUrl(staticPort)}`);
  } catch (e) {
    const cleanedCandidateIds = new Set();
    for (const candidate of workspaceRuntimeCandidates.reverse()) {
      const candidateId = String(candidate?.containerId || '');
      if (!candidateId || cleanedCandidateIds.has(candidateId)) continue;
      cleanedCandidateIds.add(candidateId);
      try {
        dockerSvc.cleanupExactAgentRuntimeCandidate(candidate);
      } catch (cleanupError) {
        e.message += `; exact workspace candidate cleanup: ${cleanupError?.message || cleanupError}`;
      }
    }
    workspaceRuntimeCandidates.length = 0;
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
    const lifecycleResult = await withNetworkLifecycleLock(async (networkLifecycleCapability) => {
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
  buildRouterUrl,
  buildBlockingReadinessEntryFromNode,
  computeRetainedManagedEnvHash,
  activatePreparedRuntimeAfterReadiness,
  ensureGraphNodesEnabled,
  removeGraphContainerForRecreate,
  reprepareGraphAfterStartupProviders,
  resolveExtraEnabledRuntimeNodes,
  resolveManifestRouterEndpoint,
  resolveAndPersistStartRouterPort,
  resolveGraphNodeExecutionRecord,
  resolveRetainedGraphNodeExecutionRecord,
  waitForRouterReady,
  waitForManifestReadiness,
  waitForReadinessEntries,
  startWorkspace,
  runCli,
  runShell,
  reinstallAgent
};
