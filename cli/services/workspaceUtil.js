import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as utils from './utils.js';
import * as agentsSvc from './agents.js';
import * as workspaceSvc from './workspace.js';
import * as dockerSvc from './docker/index.js';
import { getRuntimeForAgent, isSandboxRuntime, loadAgentsMap } from './docker/common.js';
import { isBwrapProcessRunning, stopBwrapProcess } from './bwrap/bwrapFleet.js';
import * as inputState from './inputState.js';
import { applyManifestDirectives, prepareManifestRepositories } from './bootstrapManifest.js';
import { executeHostHook, markPreinstallRunInProcess, resetPreinstallRunInProcess, isInlineCommand } from './lifecycleHooks.js';
import { getActiveProfile, getProfileConfig, getProfileEnvVars } from './profileService.js';
import { getSecrets, createEnvWithSecrets, loadEnvFile } from './secretInjector.js';
import { readSecretsFile } from './encryptedSecretsFile.js';
import { buildEnvMap } from './secretVars.js';
import { resolveAgentExecutionMode, resolveAgentReadinessProtocol } from './startupReadiness.js';
import { normalizeProbeConfig, runContainerScriptReadiness } from './docker/healthProbes.js';
import { applyStartupConfigProvidersForGraph } from './startupConfigProviders.js';
import { createWorkspaceStartLock, releaseWorkspaceStartLock, withMaintenanceLock } from './maintenanceLocks.js';
import { LOGS_DIR, PLOINKY_CWD, PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT, REPOS_DIR, ROUTING_FILE, RUNNING_DIR } from './config.js';
import { classifyDependencyGraphWaitMode, resolveWorkspaceDependencyGraph, topologicallyGroupDependencyGraph } from './workspaceDependencyGraph.js';
import { mergeRoutingConfig, readRoutingConfig } from './routingFile.js';
import { waitForAgentReady } from '../server/utils/agentReadiness.js';
import { getAgentDataDir } from './workspaceStructure.js';
import {
  formatAgentAttachmentBanner,
  resolveAgentAttachmentIdentity,
} from './layerIdentification.js';
import { preflightBoxPublicationForCommand } from './boxPublicationCoverage.js';

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

function spawnNoWaitWorker({ node, registryName, routeKey, registryAlias, routerPort }) {
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

async function waitForRouterReady(socketPath, port, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`router exited before Unix listener became ready (exit ${child.exitCode})`);
    }
    const unixReady = await new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(250, () => done(false));
    });
    const tcpReady = unixReady && await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(250, () => done(false));
    });
    if (unixReady && tcpReady) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`router listeners did not become ready at ${socketPath} and 127.0.0.1:${port}`);
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

function ensureGraphNodesEnabled(graph, reg, {
  enableAgent = agentsSvc.enableAgent,
  removeAgentContainerForRecreate = dockerSvc.removeAgentContainerForRecreate,
  saveAgents = workspaceSvc.saveAgents,
  executionRecordOptions,
} = {}) {
  const nodes = Array.from(graph?.nodes?.values?.() || [])
    .filter((node) => !node.isStatic)
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
    existingPlans.push({ node, existing, expectedExecution, executionChanged, profileChanged });
  }

  // Removal is deliberately completed before any run-mode registry field is
  // changed. A safe-removal failure therefore leaves agents.json describing
  // the still-existing container, and retrying remains deterministic.
  for (const plan of existingPlans) {
    if (!plan.executionChanged) continue;
    removeAgentContainerForRecreate(
      plan.existing.key,
      `workspaceGraph:${plan.node.id}:executionModeChanged`,
    );
  }

  let registryChanged = false;
  for (const plan of existingPlans) {
    if (!plan.executionChanged && !plan.profileChanged) continue;
    const nextRecord = { ...plan.existing.rec };
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
    reg[plan.existing.key] = nextRecord;
    registryChanged = true;
  }
  if (registryChanged) {
    saveAgents(reg);
  }

  for (const node of missingNodes) {
    enableAgent(node.enableSpec || node.agentRef, undefined, undefined, node.alias || undefined, undefined, {
      profile: node.profile || undefined,
    });
  }
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

  const protocol = resolveAgentReadinessProtocol(node.manifest, {
    additionalServerPort: route?.additionalServerPort
  });
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
        + 'Declare health.readiness.script, a private additionalServerPort/openPorts route, or readiness.protocol none.'
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

async function startWorkspace(staticAgentArg, portArg, {
  refreshComponentToken,
  ensureComponentToken,
  enableAgent,
  killRouterIfRunning,
  branchPolicy,
  publicationPreflightComplete = false,
} = {}) {
  const preflightArgs = [];
  if (staticAgentArg) preflightArgs.push(String(staticAgentArg));
  if (portArg) preflightArgs.push(String(portArg));
  if (branchPolicy?.branch) preflightArgs.push(`--branch=${branchPolicy.branch}`);
  for (const [repoName, branch] of Object.entries(branchPolicy?.repoBranches || {})) {
    preflightArgs.push(`--repo-branch=${repoName}=${branch}`);
  }
  if (branchPolicy?.fallback) preflightArgs.push(`--branch-fallback=${branchPolicy.fallback}`);
  if (branchPolicy?.resetRepos) preflightArgs.push('--reset-repos');
  if (!publicationPreflightComplete) {
    await preflightBoxPublicationForCommand('start', preflightArgs);
  }
  let routerReadyForStart = false;
  let routerPortForStart = 0;
  let routerContainerForStart = '';
  const ensureRouterReadyForStart = async ({ staticAgent, staticPort, repoName, shortAgentName }) => {
    const container = dockerSvc.getAgentContainerName(shortAgentName || staticAgent, repoName || '');
    if (routerReadyForStart) {
      if (routerPortForStart !== staticPort || routerContainerForStart !== container) {
        throw new Error('start: resolved static routing identity changed after the router listener became ready');
      }
      await mergeRoutingConfig((current) => ({
        ...current,
        port: staticPort,
        static: { agent: staticAgent, container },
        routes: current.routes || {},
      }));
      return container;
    }

    await mergeRoutingConfig((current) => ({
      ...current,
      port: staticPort,
      static: { agent: staticAgent, container },
      routes: current.routes || {},
    }));
    console.log(`Static: agent=${utils.colorize(staticAgent, 'cyan')} port=${utils.colorize(String(staticPort), 'yellow')}`);
    try {
      await waitForRouterReady(path.join(PLOINKY_DIR, 'run', 'router.sock'), staticPort, null, 300);
      routerReadyForStart = true;
      routerPortForStart = staticPort;
      routerContainerForStart = container;
      console.log('[start] Existing router listeners are ready; preserving their Unix socket for the managed gateway.');
      return container;
    } catch (_) {
      // No complete listener pair exists. Replace only the router process; the
      // exact-owned gateway will deliberately reconcile its socket bind if one
      // exists from an interrupted or explicit router restart.
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
    await waitForRouterReady(path.join(PLOINKY_DIR, 'run', 'router.sock'), staticPort, child);
    routerReadyForStart = true;
    routerPortForStart = staticPort;
    routerContainerForStart = container;
    console.log(`[start] Watchdog launched in background (pid ${child.pid}); router listeners are ready.`);
    return container;
  };
  // Clear the in-process preinstall dedup set so each workspace start (e.g.
  // a `restart` re-entering this function in the same CLI process) re-runs
  // hooks that may need to regenerate runtime files.
  resetPreinstallRunInProcess();
  const workspaceStartLock = createWorkspaceStartLock();
  try {
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
      let alreadyEnabled = false;
      let resolvedAgent = null;
      try {
        resolvedAgent = utils.findAgent(aliasResolved || staticAgentArg);
      } catch (_) { resolvedAgent = null; }

      if (resolvedAgent) {
        try {
          const agentsMap = workspaceSvc.loadAgents();
          const expectedKey = dockerSvc.getAgentContainerName(resolvedAgent.shortAgentName, resolvedAgent.repo);
          const existingByKey = agentsMap[expectedKey];
          if (existingByKey && existingByKey.type === 'agent') {
            alreadyEnabled = true;
          } else {
            alreadyEnabled = Object.values(agentsMap).some((value) => (
              value && value.type === 'agent' &&
              value.agentName === resolvedAgent.shortAgentName &&
              value.repoName === resolvedAgent.repo
            ));
          }
        } catch (_) {
          alreadyEnabled = false;
        }
        await ensureRouterReadyForStart({
          staticAgent: aliasResolved || staticAgentArg,
          staticPort: parseInt(portArg || '0', 10) || 8080,
          repoName: resolvedAgent.repo,
          shortAgentName: resolvedAgent.shortAgentName,
        });
      }

        if (!alreadyEnabled) {
          if (enableAgent) {
          await enableAgent(staticAgentArg);
          } else {
            try {
            const info = agentsSvc.enableAgent(staticAgentArg);
            if (info && info.shortAgentName) {
              console.log(`✓ Agent '${info.shortAgentName}' from repo '${info.repoName}' enabled. Use 'start' to start all configured agents.`);
            }
          } catch (e) {
            throw new Error(`start: failed to enable agent '${staticAgentArg}': ${e?.message || e}`);
          }
        }
      } else {
        utils.debugLog(`startWorkspace: static agent '${staticAgentArg}' already enabled; reusing existing record.`);
      }
      const portNum = parseInt(portArg || '0', 10) || 8080;
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
    if (typeof refreshComponentToken === 'function' || typeof ensureComponentToken === 'function') {
      try {
        const ensureToken = ensureComponentToken || refreshComponentToken;
        if (ensureComponentToken) {
          ensureComponentToken('webchat', { quiet: true });
        }
        refreshComponentToken && refreshComponentToken('dashboard', { quiet: true });
      } catch (e) {
        utils.debugLog('Failed to refresh component tokens:', e.message);
      }
    }
    // Run preinstall hook for the static (main) agent BEFORE starting dependencies.
    // This allows the main agent's preinstall to set ploinky vars that dependencies need.
    // Note: This only runs the preinstall hook; workspace init/symlinks are done in agentServiceManager.
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
            // For inline commands, pass as-is; for script paths, join with agentPath
            const hookValue = isInlineCommand(profileConfig.preinstall)
              ? profileConfig.preinstall
              : path.join(agentPath, profileConfig.preinstall);
            
            // Build environment for the hook
            const envVars = getProfileEnvVars(resolved.shortAgentName, resolved.repo, activeProfile, {});
            let manifestEnv = {};
            try {
              const manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
              manifestEnv = buildEnvMap(manifest, profileConfig, {
                agentName: resolved.shortAgentName,
                repoName: resolved.repo
              });
            } catch (_) { }
            const secrets = profileConfig.secrets ? getSecrets(profileConfig.secrets) : {};
            const hookEnv = createEnvWithSecrets({ ...envVars, ...manifestEnv }, secrets);
            
            const result = executeHostHook(hookValue, hookEnv, { cwd: PLOINKY_WORKSPACE_ROOT });
            if (!result.success) {
              console.error(`[start] Preinstall failed: ${result.message}`);
            } else {
              markPreinstallRunInProcess(resolved.shortAgentName, resolved.repo, activeProfile);
            }
          }
        }
      }
    } catch (preErr) {
      console.error(`[start] Preinstall hook error: ${preErr.message}`);
    }

    const staticAgent = normalizedStaticAgent || cfg0.static.agent;
    const staticPort = cfg0.static.port;
    let staticRepoName = null;
    let staticShortAgent = null;

    try {
      const resolvedStaticAgent = utils.findAgent(staticAgent);
      staticRepoName = resolvedStaticAgent.repo;
      staticShortAgent = resolvedStaticAgent.shortAgentName;
    } catch (e) {
      throw new Error(`start: static agent '${staticAgent}' not found in any repo. Use 'enable agent <repo/name>' or check repos.`);
    }
    await ensureRouterReadyForStart({
      staticAgent,
      staticPort,
      repoName: staticRepoName,
      shortAgentName: staticShortAgent,
    });

    // Providers must run before manifest enable directives start dependent
    // agents. First install/prepare the complete manifest repo graph without
    // enabling anything, resolve a planning graph from those manifests, and
    // apply provider output. The ordinary enable pass may then start every
    // dependency with the provider-populated environment on its first launch.
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
    let providerDependencyGraph;
    try {
      providerDependencyGraph = resolveWorkspaceDependencyGraph({
        staticAgentRef: staticAgent,
        registry: providerRegistry,
      });
    } catch (graphErr) {
      throw new Error(`Failed to resolve provider dependency graph for '${staticAgent}': ${graphErr.message}`);
    }
    try {
      const providerResult = await applyStartupConfigProvidersForGraph({
        dependencyGraph: providerDependencyGraph,
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

    try {
      await applyManifestDirectives(cfg0.static.agent, { branchPolicy });
    } catch (err) {
      throw new Error(`Failed to apply manifest directives for '${cfg0.static.agent}': ${err?.message || err}`);
    }
    let reg = deduplicateAgentRegistry(workspaceSvc.loadAgents(), dockerSvc.getAgentContainerName);
    workspaceSvc.saveAgents(reg);

    const { getAgentContainerName, ensureAgentService } = dockerSvc;
    let cfg = readRoutingConfig();
    cfg.routes = cfg.routes || {};

    let dependencyGraph;
    try {
      dependencyGraph = resolveWorkspaceDependencyGraph({
        staticAgentRef: staticAgent,
        registry: reg
      });
    } catch (graphErr) {
      throw new Error(`Failed to resolve dependency graph for '${staticAgent}': ${graphErr.message}`);
    }

    ensureGraphNodesEnabled(dependencyGraph, reg);
    reg = deduplicateAgentRegistry(workspaceSvc.loadAgents(), getAgentContainerName);
    workspaceSvc.saveAgents(reg);

    const allNames = Object.keys(reg || {}).filter((name) => name !== '_config');
    const graphWaves = topologicallyGroupDependencyGraph(dependencyGraph);
    const { noWait: noWaitNodeIds } = classifyDependencyGraphWaitMode(dependencyGraph);
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

    cfg.port = staticPort;
    cfg.static = { agent: staticAgent, container: staticContainer };
    cfg = await mergeRoutingConfig((current) => ({
      ...current,
      ...cfg,
      routes: {
        ...(current.routes || {}),
        ...(cfg.routes || {})
      }
    }));
    const updateRoutes = async (targetNames = [], { allowFailures = false } = {}) => {
      if (!Array.isArray(targetNames) || !targetNames.length) {
        return;
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
          const { containerName, hostPort, additionalServerPort } = ensureAgentService(shortAgentName, manifest, agentPath, {
            containerName: name,
            alias: rec.alias,
            routerPort: staticPort,
            profileName: rec.profile || undefined
          });
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
            ...(additionalServerPort ? { additionalServerPort } : {})
          };
          if (!resolvedHostPort) delete nextRoute.hostPort;
          if (!additionalServerPort) delete nextRoute.additionalServerPort;
          return {
            ok: true,
            shortAgentName,
            routeKey,
            route: nextRoute
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
      });
      if (failedAgents.length > 0) {
        const message = `${failedAgents.length} agent(s) failed to start: ${failedAgents.join(', ')}`;
        if (allowFailures) {
          console.warn(`[start] ${message}`);
          return;
        }
        throw new Error(message);
      }
    };

    for (let waveIndex = 0; waveIndex < graphWaves.length; waveIndex += 1) {
      const waveNodeIds = graphWaves[waveIndex];
      const waveNodes = waveNodeIds
        .map((nodeId) => dependencyGraph.nodes.get(nodeId))
        .filter(Boolean);
      if (!waveNodes.length) continue;

      // Split the wave: blocking nodes follow the existing wave-by-wave
      // ensureAgentService + readiness path; no-wait nodes get spawned as
      // detached background workers that report their progress through
      // .ploinky/logs/no-wait/ and .ploinky/running/no-wait/ without delaying
      // later waves or the static agent.
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

      for (const { node, registryName } of noWaitWaveNodes) {
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
            routerPort: staticPort
          });
          console.log(`[start] ${formatGraphNodeLabel(node, staticAgent)}: no-wait launch started (pid ${pid}). log=${logFile} status=${statusFile}`);
        } catch (spawnErr) {
          console.error(`[start] no-wait launch for '${formatGraphNodeLabel(node, staticAgent)}' failed to spawn: ${spawnErr?.message || spawnErr}`);
        }
      }

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

    const extraNames = allNames.filter((name) => !graphRegistryNames.has(name));
    if (extraNames.length) {
      console.log(`[start] Starting ${extraNames.length} additional enabled agent(s) outside the dependency graph: ${extraNames.join(', ')}`);
      await updateRoutes(extraNames, { allowFailures: true });
    }

    console.log(`[start] Watchdog will automatically restart the server if it crashes.`);
    console.log(`[start] Server logs: ${path.join(LOGS_DIR, 'router.log')}`);
    console.log(`[start] Watchdog logs: ${path.join(LOGS_DIR, 'watchdog.log')}`);
    console.log(`[start] Dashboard: http://127.0.0.1:${staticPort}/dashboard`);
  } catch (e) {
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
    loadAgentsMap: loadAgentsMapImpl,
    attachInteractive,
    attachBwrapInteractive,
    attachSeatbeltInteractive,
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
  try {
    registryRecord = resolveEnabledAgentRecord(agentName);
  } catch (err) {
    error(err?.message || err);
    return;
  }

  if (!registryRecord) {
    let autoEnableRef = null;
    try {
      const resolved = findAgent(agentName);
      autoEnableRef = `${resolved.repo}/${resolved.shortAgentName}`;
      manifestLookup = autoEnableRef;
    } catch (err) {
      error(`Agent '${agentName}' is not found.`);
      if (err?.message) {
        error(err.message);
      }
      return;
    }

    try {
      enableAgent(autoEnableRef, 'global');
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
  const containerInfo = ensureAgentService(shortAgentName, manifest, agentDir, { containerName: registryRecord?.containerName, alias: registryRecord?.record?.alias });
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
        ...(containerInfo?.additionalServerPort ? { additionalServerPort: containerInfo.additionalServerPort } : {})
      }
    });
  } else if (readinessProtocol !== 'none') {
    const hostPort = containerInfo?.hostPort;
    if (!hostPort) {
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
      attach(shortAgentName, manifest, agentDir, projectPath, cmd, { containerName });
    });
  } else if (actualRuntime === 'seatbelt') {
    const attach = attachSeatbeltInteractive
      || (await import('./seatbelt/seatbeltServiceManager.js')).attachSeatbeltInteractive;
    withSuspendedInput(() => {
      attach(shortAgentName, manifest, agentDir, projectPath, cmd, { containerName });
    });
  } else {
    withSuspendedInput(() => {
      attachInteractive(containerName, projectPath, cmd);
    });
  }
}

async function runCli(agentName, args, { publicationPreflightComplete = false } = {}) {
  if (!publicationPreflightComplete) {
    await preflightBoxPublicationForCommand('cli', [agentName, ...(args || [])]);
  }
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

async function runShell(agentName, { publicationPreflightComplete = false } = {}) {
  if (!publicationPreflightComplete) {
    await preflightBoxPublicationForCommand('shell', agentName ? [agentName] : []);
  }
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
  const { ensureAgentService, attachInteractive, getConfiguredProjectPath, getAgentContainerName, isContainerRunning } = dockerSvc;
  const agentDir = path.dirname(manifestPath);
  const repoName = path.basename(path.dirname(agentDir));
  const registeredContainerName = registryRecord?.containerName || getAgentContainerName(shortAgentName, repoName);
  let containerName = registeredContainerName;
  if (!isContainerRunning(registeredContainerName)) {
    const containerInfo = ensureAgentService(shortAgentName, manifest, agentDir, { containerName: registeredContainerName, alias: registryRecord?.record?.alias });
    containerName = (containerInfo && containerInfo.containerName)
      || registeredContainerName;
  }
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
      attachBwrapInteractive(shortAgentName, manifest, agentDir, projPath, cmd, { containerName });
    });
  } else if (actualRuntime === 'seatbelt') {
    console.log(`[shell] seatbelt agent: ${shortAgentName}`);
    console.log(`[shell] command: ${cmd}`);
    const { attachSeatbeltInteractive } = await import('./seatbelt/seatbeltServiceManager.js');
    runWithSuspendedInput(() => {
      attachSeatbeltInteractive(shortAgentName, manifest, agentDir, projPath, cmd, { containerName });
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

async function reinstallAgent(agentName, { publicationPreflightComplete = false } = {}) {
    if (!publicationPreflightComplete) {
        await preflightBoxPublicationForCommand('reinstall', agentName ? [agentName] : []);
    }
    if (!agentName) { throw new Error('Usage: reinstall <name> | reinstall agent <name>'); }

    const { getAgentContainerName, isContainerRunning, stopAndRemove, ensureAgentService } = dockerSvc;
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

    const agentRuntime = getRuntimeForAgent(manifest);
    const bwrapRunning = isSandboxRuntime(agentRuntime) && isBwrapProcessRunning(resolved.shortAgentName);

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

            // Stop existing process (bwrap or container)
            if (bwrapRunning) {
                stopBwrapProcess(short);
            }
            stopAndRemove(containerName);
            
            const { containerName: newContainerName, hostPort, additionalServerPort } = await ensureAgentService(short, manifest, agentPath, {
                containerName,
                alias: registryRecord?.record?.alias,
                forceRecreate: true
            });

            console.log(`[reinstall] reinstalled '${short}' [container: ${newContainerName}]`);
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
                    ...(additionalServerPort ? { additionalServerPort } : {})
                }
            });

            // Routing update logic from original restart command
            try {
            const routingFile = ROUTING_FILE;
            let cfg = { routes: {} };
            try { cfg = JSON.parse(fs.readFileSync(routingFile, 'utf8')) || { routes: {} }; } catch(_) {}
            cfg.routes = cfg.routes || {};
            cfg.routes[routeKey] = cfg.routes[routeKey] || {};
            cfg.routes[routeKey].container = newContainerName;
            cfg.routes[routeKey].hostPath = agentPath;
            cfg.routes[routeKey].repo = repoName;
            cfg.routes[routeKey].agent = short;
            if (registryRecord?.record.alias) cfg.routes[routeKey].alias = registryRecord.record.alias;
            if (hostPort) {
                cfg.routes[routeKey].hostPort = hostPort;
            } else {
                delete cfg.routes[routeKey].hostPort;
            }
            if (additionalServerPort) {
                cfg.routes[routeKey].additionalServerPort = additionalServerPort;
            } else {
                delete cfg.routes[routeKey].additionalServerPort;
            }

            const savedCfg = workspaceSvc.getConfig();
            if (!cfg.static && savedCfg?.static?.agent) {
                cfg.static = { ...savedCfg.static };
            }
            const staticAgent = String(cfg.static?.agent || '').trim();
            if (staticAgent) {
                const matches = new Set([short, `${repoName}/${short}`, `${repoName}:${short}`]);
                if (registryRecord?.record?.alias) {
                    matches.add(registryRecord.record.alias);
                }
                if (matches.has(staticAgent)) {
                    cfg.static.container = newContainerName;
                }
            }
            
            let port = 8080;
            if (cfg && cfg.port) { port = parseInt(cfg.port, 10) || port; }
            try {
                const saved = workspaceSvc.getConfig();
                if (saved && saved.static && saved.static.port) {
                    port = parseInt(saved.static.port, 10) || port;
                }
            } catch(_) {}
            cfg.port = port;
            fs.mkdirSync(path.dirname(routingFile), { recursive: true });
            fs.writeFileSync(routingFile, JSON.stringify(cfg, null, 2));

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
            if (!isRouterUp(cfg.port)) {
                const runningDir = RUNNING_DIR;
                fs.mkdirSync(runningDir, { recursive: true });
                const routerPath = path.resolve(__dirname, '../server/Watchdog.js');
                const routerPidFile = path.join(runningDir, 'router.pid');
                const child = spawnWatchdog(routerPath, cfg.port, routerPidFile);
                try { fs.writeFileSync(routerPidFile, String(child.pid)); } catch(_) {}
                child.unref();
                console.log(`[reinstall] Watchdog launched (pid ${child.pid}) on port ${cfg.port}.`);
                console.log(`[reinstall] Watchdog will automatically restart the server if needed.`);
            }
        } catch (e) {
            console.error('[reinstall] routing update/router start failed:', e?.message||e);
        }
        });
    } catch (e) {
        console.error(`[reinstall] ${agentName}: ${e?.message||e}`);
        if (e?.code === 'PLOINKY_READINESS_FAILED') throw e;
    }
}

export {
  buildBlockingReadinessEntryFromNode,
  ensureGraphNodesEnabled,
  resolveGraphNodeExecutionRecord,
  waitForManifestReadiness,
  waitForReadinessEntries,
  startWorkspace,
  runCli,
  runShell,
  reinstallAgent
};
