import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as utils from './utils.js';
import * as agentsSvc from './agents.js';
import * as workspaceSvc from './workspace.js';
import * as dockerSvc from './docker/index.js';
import { getRuntimeForAgent, isSandboxRuntime, loadAgentsMap } from './docker/common.js';
import { isBwrapProcessRunning, stopBwrapProcess } from './bwrap/bwrapFleet.js';
import * as inputState from './inputState.js';
import { applyManifestDirectives } from './bootstrapManifest.js';
import { executeHostHook, markPreinstallRunInProcess, resetPreinstallRunInProcess, isInlineCommand } from './lifecycleHooks.js';
import { getActiveProfile, getProfileConfig, getProfileEnvVars } from './profileService.js';
import { getSecrets, createEnvWithSecrets, loadEnvFile } from './secretInjector.js';
import { readSecretsFile } from './encryptedSecretsFile.js';
import { buildEnvMap } from './secretVars.js';
import { resolveAgentReadinessProtocol } from './startupReadiness.js';
import { LOGS_DIR, PLOINKY_CWD, PLOINKY_WORKSPACE_ROOT, ROUTING_FILE, RUNNING_DIR } from './config.js';
import { classifyDependencyGraphWaitMode, resolveWorkspaceDependencyGraph, topologicallyGroupDependencyGraph } from './workspaceDependencyGraph.js';
import { mergeRoutingConfig, readRoutingConfig } from './routingFile.js';
import { waitForAgentReady } from '../server/utils/agentReadiness.js';

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
      PLOINKY_ROUTER_PID_FILE: routerPidFile
    }
  });
  logStdio.closeParentFds();
  return child;
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

function wrapCliWithWebchat(command) {
  const trimmed = (command || '').trim();
  if (!trimmed) return trimmed;
  if (process.env.PLOINKY_SKIP_MANIFEST_CLI_WEBCHAT === '1') {
    return trimmed;
  }
  const enableWrap = process.env.PLOINKY_MANIFEST_CLI_WEBCHAT === '1';
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

function ensureGraphNodesEnabled(graph, reg) {
  const nodes = Array.from(graph?.nodes?.values?.() || [])
    .filter((node) => !node.isStatic)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const node of nodes) {
    const existing = findRegistryEntryForGraphNode(reg, node, dockerSvc.getAgentContainerName);
    if (existing) {
      if (node.profile && existing.rec.profile !== node.profile) {
        existing.rec.profile = node.profile;
        reg[existing.key] = existing.rec;
        workspaceSvc.saveAgents(reg);
      }
      continue;
    }
    agentsSvc.enableAgent(node.enableSpec || node.agentRef, undefined, undefined, node.alias || undefined, undefined, {
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

  return {
    key: node.id,
    label: formatGraphNodeLabel(node, staticLabel),
    kind: node.isStatic ? 'static' : 'dependency',
    route,
    protocol: resolveAgentReadinessProtocol(node.manifest),
    timeoutMs,
    intervalMs,
    probeTimeoutMs
  };
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
  if (!route?.hostPort && entry.protocol !== 'none') {
    throw new Error(`${node.isStatic ? 'Static agent' : 'Dependent agent'} '${formatGraphNodeLabel(node, staticLabel)}' did not expose a host port.`);
  }
  return entry;
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

async function waitForReadinessEntries(readinessEntries) {
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
    const waitLabel = entry.kind === 'static' ? 'static agent' : 'dependent agent';
    if (entry.protocol === 'none') {
      console.log(`[start] Marking ${waitLabel} '${entry.label}' ready (no port-bound readiness probe).`);
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
    const ready = await waitForAgentReady(entry.route, {
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
      throw new Error(`${entry.kind === 'static' ? 'Static agent' : 'Dependent agent'} '${entry.label}' did not become ready within ${entry.timeoutMs}ms.`);
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

async function startWorkspace(staticAgentArg, portArg, { refreshComponentToken, ensureComponentToken, enableAgent, killRouterIfRunning, branchPolicy } = {}) {
  // Clear the in-process preinstall dedup set so each workspace start (e.g.
  // a `restart` re-entering this function in the same CLI process) re-runs
  // hooks that may need to regenerate runtime files.
  resetPreinstallRunInProcess();
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
            console.error(`start: failed to enable agent '${staticAgentArg}': ${e?.message || e}`);
            return;
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
      console.error('start: missing static agent or port. Usage: start <staticAgent> <port> (first time).');
      return;
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

    const staticAgent = normalizedStaticAgent || cfg0.static.agent;
    const staticPort = cfg0.static.port;
    let staticRepoName = null;
    let staticShortAgent = null;

    try {
      const resolvedStaticAgent = utils.findAgent(staticAgent);
      staticRepoName = resolvedStaticAgent.repo;
      staticShortAgent = resolvedStaticAgent.shortAgentName;
    } catch (e) {
      console.error(`start: static agent '${staticAgent}' not found in any repo. Use 'enable agent <repo/name>' or check repos.`);
      return;
    }

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
    console.log(`Static: agent=${utils.colorize(staticAgent, 'cyan')} port=${utils.colorize(String(staticPort), 'yellow')}`);
    if (typeof killRouterIfRunning === 'function') {
      try { killRouterIfRunning(); } catch (_) {}
    }
    const runningDir = RUNNING_DIR;
    fs.mkdirSync(runningDir, { recursive: true });
    const routerPath = path.resolve(__dirname, '../server/Watchdog.js');
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
            routerPort: staticPort
          });
          const nextRoute = {
            ...(cfg.routes[routeKey] || {}),
            container: containerName,
            hostPath: agentPath,
            repo: repoName,
            agent: shortAgentName,
            ...(rec.alias ? { alias: rec.alias } : {}),
            hostPort: hostPort || cfg.routes[routeKey]?.hostPort,
            ...(additionalServerPort ? { additionalServerPort } : {})
          };
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

    const routerPidFile = path.join(runningDir, 'router.pid');
    const child = spawnWatchdog(routerPath, staticPort, routerPidFile);
    try { fs.writeFileSync(routerPidFile, String(child.pid)); } catch (_) {}
    // Detach so the CLI can exit while the router keeps running.
    child.unref();
    console.log(`[start] Watchdog launched in background (pid ${child.pid}).`);
    console.log(`[start] Watchdog will automatically restart the server if it crashes.`);
    console.log(`[start] Server logs: ${path.join(LOGS_DIR, 'router.log')}`);
    console.log(`[start] Watchdog logs: ${path.join(LOGS_DIR, 'watchdog.log')}`);
    console.log(`[start] Dashboard: http://127.0.0.1:${staticPort}/dashboard`);
  } catch (e) {
    console.error('start (workspace) failed:', e.message);
  }
}

async function runCli(agentName, args) {
  if (!agentName) { throw new Error('Usage: cli <agentName> [args...]'); }
  const suppressLauncherLogs = process.env.PLOINKY_NO_TTY === '1';
  let registryRecord = null;
  let manifestLookup = agentName;
  try {
    registryRecord = agentsSvc.resolveEnabledAgentRecord(agentName);
  } catch (err) {
    console.error(err?.message || err);
    return;
  }

  if (!registryRecord) {
    let autoEnableRef = null;
    try {
      const resolved = utils.findAgent(agentName);
      autoEnableRef = `${resolved.repo}/${resolved.shortAgentName}`;
      manifestLookup = autoEnableRef;
    } catch (err) {
      console.error(`Agent '${agentName}' is not found.`);
      if (err?.message) {
        console.error(err.message);
      }
      return;
    }

    try {
      agentsSvc.enableAgent(autoEnableRef, 'global');
    } catch (err) {
      console.error(`Failed to enable '${agentName}' in global mode: ${err?.message || err}`);
      return;
    }

    try {
      registryRecord = agentsSvc.resolveEnabledAgentRecord(agentName);
      if (!registryRecord) {
        registryRecord = agentsSvc.resolveEnabledAgentRecord(autoEnableRef);
      }
    } catch (err) {
      console.error(err?.message || err);
      return;
    }
  }

  const resolvedManifestRef = registryRecord
    ? `${registryRecord.record.repoName}/${registryRecord.record.agentName}`
    : manifestLookup;
  const { manifestPath, shortAgentName } = utils.findAgent(resolvedManifestRef);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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
  const cmd = wrapCliWithWebchat(rawCmd);
  const { ensureAgentService, attachInteractive, getConfiguredProjectPath, getAgentContainerName } = dockerSvc;
  const agentDir = path.dirname(manifestPath);
  const repoName = path.basename(path.dirname(agentDir));
  utils.debugLog(`[runCli] agent=${agentName} container=${registryRecord?.containerName || getAgentContainerName(shortAgentName, repoName)}`);
  const containerInfo = ensureAgentService(shortAgentName, manifest, agentDir, { containerName: registryRecord?.containerName, alias: registryRecord?.record?.alias });
  const containerName = (containerInfo && containerInfo.containerName)
    || registryRecord?.containerName
    || getAgentContainerName(shortAgentName, repoName);
  const readinessProtocol = resolveAgentReadinessProtocol(manifest);
  if (readinessProtocol !== 'none') {
    const hostPort = containerInfo?.hostPort;
    if (!hostPort) {
      if (!suppressLauncherLogs) {
        console.warn(`[cli] warning: cannot wait for '${shortAgentName}' readiness because no host port was resolved.`);
      }
    } else {
      if (!suppressLauncherLogs) {
        console.log(`[cli] Waiting for '${shortAgentName}' readiness (${readinessProtocol}) on port ${hostPort}...`);
      }
      const ready = await waitForAgentReady({ hostPort }, {
        timeoutMs: 600000,
        protocol: readinessProtocol,
      });
      if (!ready) {
        throw new Error(`Agent '${shortAgentName}' did not become ready before CLI attach.`);
      }
    }
  }
  const projPath = PLOINKY_CWD;

  // Determine actual runtime from registry (may differ from manifest if sandbox
  // failed and fell back to container during ensureAgentService)
  const agents = loadAgentsMap();
  const registryEntry = agents[containerName] || {};
  const actualRuntime = registryEntry.runtime;

  if (actualRuntime === 'bwrap') {
    const { attachBwrapInteractive } = await import('./bwrap/bwrapServiceManager.js');
    runWithSuspendedInput(() => {
      attachBwrapInteractive(shortAgentName, manifest, agentDir, projPath, cmd, { containerName });
    });
  } else if (actualRuntime === 'seatbelt') {
    const { attachSeatbeltInteractive } = await import('./seatbelt/seatbeltServiceManager.js');
    runWithSuspendedInput(() => {
      attachSeatbeltInteractive(shortAgentName, manifest, agentDir, projPath, cmd, { containerName });
    });
  } else {
    runWithSuspendedInput(() => {
      attachInteractive(containerName, projPath, cmd);
    });
  }
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

async function reinstallAgent(agentName) {
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

        const readinessProtocol = resolveAgentReadinessProtocol(manifest);
        if (!hostPort && readinessProtocol !== 'none') {
            throw new Error(`Failed to resolve host port for restarted agent '${short}'.`);
        }
        console.log(`[reinstall] reinstalled '${short}' [container: ${newContainerName}]`);

        // Routing update logic from original restart command
        try {
            const routingFile = ROUTING_FILE;
            let cfg = { routes: {} };
            try { cfg = JSON.parse(fs.readFileSync(routingFile, 'utf8')) || { routes: {} }; } catch(_) {}
            cfg.routes = cfg.routes || {};
            const repoName = path.basename(path.dirname(agentPath));
            const routeKey = registryRecord?.record.alias || short;
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

            if (readinessProtocol !== 'none') {
                const readinessWait = resolveManifestReadinessWaitOptions(manifest, 15000);
                const ready = await waitForAgentReady({ hostPort }, {
                    timeoutMs: readinessWait.timeoutMs,
                    intervalMs: readinessWait.intervalMs,
                    probeTimeoutMs: readinessWait.probeTimeoutMs,
                    protocol: readinessProtocol,
                });
                if (!ready) {
                    console.error(`[reinstall] warning: agent '${short}' (host port ${hostPort}) is not ready yet; if requests 502, run 'ploinky restart'.`);
                }
            }

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
    } catch (e) {
        console.error(`[reinstall] ${agentName}: ${e?.message||e}`);
    }
}

export {
  buildBlockingReadinessEntryFromNode,
  startWorkspace,
  runCli,
  runShell,
  reinstallAgent
};
