import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { debugLog } from '../../utils/utils.js';
import {
    CONTAINER_CONFIG_PATH,
    computeEnvHash,
    getAgentContainerName,
    getConfiguredProjectPath,
    loadAgentsMap,
    parseManifestPorts,
    saveAgentsMap,
    syncAgentMcpConfig
} from '../docker/common.js';
import {
    DEFAULT_AGENT_ENTRY,
    readManifestAgentCommand,
    readManifestStartCommand
} from '../docker/agentCommands.js';
import { LOGS_DIR, PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { ensureSharedHostDir } from '../docker/agentHooks.js';
import {
    runPreContainerLifecycle,
    runProfileLifecycle
} from '../../utils/runtime/lifecycleHooks.js';
import {
    formatMissingSecretsError,
    getSecrets,
    validateSecrets
} from '../../utils/security/secretInjector.js';
import {
    getActiveProfile,
    getDefaultMountModes,
    getProfileConfig,
    getProfileEnvVars,
    mergeProfiles
} from '../../utils/runtime/profileService.js';
import { resolveProfileServer } from '../../utils/runtime/profileServer.js';
import {
    getAgentWorkDir,
    getAgentCodePath,
    getAgentSkillsPath
} from '../../utils/workspaceStructure.js';
import { ensureAgentCacheForFamily } from '../../utils/dependencies/dependencyCache.js';
import {
    assertManifestEnvProfileCompleteness,
    getExposedNames,
    getManifestEnvNames
} from '../../utils/security/secretVars.js';
import {
    ensurePersistentStorageHostDir,
    planRuntimeResources
} from '../../utils/runtime/runtimeResourcePlanner.js';
import {
    pruneStaleRuntimeEntries,
    runtimeSegment,
} from '../../utils/runtime/runtimeStaging.js';
// Reuse bwrap PID management (platform-agnostic)
import {
    isBwrapProcessRunning,
    stopBwrapProcess,
    saveBwrapPid,
    clearBwrapPid,
    getBwrapPid
} from '../bwrap/bwrapFleet.js';
// Reuse env map builder from bwrap (with runtimeName param)
import { buildFullEnvMap } from '../bwrap/bwrapServiceManager.js';
// Seatbelt profile generator
import { buildSeatbeltProfile, writeSeatbeltProfile } from './seatbeltProfile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_LIB_PATH = path.resolve(__dirname, '../../../Agent');
const DEFAULT_SEATBELT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SEATBELT_RUNTIME_ROOT = path.join(PLOINKY_DIR, 'seatbelt-runtime');

function resolveSymlinkPath(symlinkPath) {
    try {
        if (fs.existsSync(symlinkPath)) {
            const stat = fs.lstatSync(symlinkPath);
            if (stat.isSymbolicLink()) {
                return fs.realpathSync(symlinkPath);
            }
        }
    } catch (err) {
        debugLog(`Warning: could not resolve symlink ${symlinkPath}: ${err.message}`);
    }
    return symlinkPath;
}

function dedupePathSegments(segments) {
    const seen = new Set();
    const result = [];
    for (const segment of segments) {
        if (!segment || typeof segment !== 'string') continue;
        const trimmed = segment.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

function buildSeatbeltPathEnv() {
    const nodeDir = path.dirname(process.execPath);
    return dedupePathSegments([
        nodeDir,
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        ...(process.env.PATH || '').split(':'),
        ...DEFAULT_SEATBELT_PATH.split(':')
    ]).join(':');
}

function addHostToolPrefix(readPaths, candidatePath) {
    if (!candidatePath) return;
    const resolved = path.resolve(candidatePath);
    const binDir = path.dirname(resolved);
    const runtimeRoot = path.dirname(binDir);
    if (resolved.startsWith('/opt/homebrew/')) {
        readPaths.add('/opt/homebrew');
        return;
    }
    if (resolved.startsWith('/opt/local/')) {
        readPaths.add('/opt/local');
        return;
    }
    if (resolved.startsWith('/nix/')) {
        readPaths.add('/nix');
        return;
    }
    if (path.basename(binDir) === 'bin' && path.basename(resolved) === 'node') {
        readPaths.add(runtimeRoot);
        return;
    }
    readPaths.add(binDir);
}

function getSeatbeltExtraReadPaths() {
    const readPaths = new Set();
    addHostToolPrefix(readPaths, process.execPath);
    try {
        addHostToolPrefix(readPaths, fs.realpathSync(process.execPath));
    } catch {
        // Ignore realpath failures; process.execPath is still included.
    }
    for (const segment of (process.env.PATH || '').split(':')) {
        if (segment.startsWith('/opt/homebrew/')) readPaths.add('/opt/homebrew');
        if (segment.startsWith('/opt/local/')) readPaths.add('/opt/local');
        if (segment.startsWith('/nix/')) readPaths.add('/nix');
    }
    return Array.from(readPaths);
}

function ensureSeatbeltAgentLibDir(agentName, nodeModulesDir) {
    const runtimeRoot = path.join(SEATBELT_RUNTIME_ROOT, runtimeSegment(agentName));
    const stagedAgentLibPath = path.join(runtimeRoot, `Agent-${process.pid}-${Date.now()}`);
    const sourceNodeModules = path.join(AGENT_LIB_PATH, 'node_modules');

    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.cpSync(AGENT_LIB_PATH, stagedAgentLibPath, {
        recursive: true,
        filter(sourcePath) {
            const resolvedSource = path.resolve(sourcePath);
            return resolvedSource !== sourceNodeModules
                && !resolvedSource.startsWith(`${sourceNodeModules}${path.sep}`);
        }
    });
    fs.symlinkSync(nodeModulesDir, path.join(stagedAgentLibPath, 'node_modules'), 'dir');
    return stagedAgentLibPath;
}

function ensureSeatbeltCodeNodeModules(agentName, agentCodePath, nodeModulesDir) {
    const linkPath = path.join(agentCodePath, 'node_modules');
    const expectedTarget = fs.realpathSync(nodeModulesDir);
    try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
            let currentTarget;
            try {
                currentTarget = fs.realpathSync(linkPath);
            } catch (err) {
                if (!err || err.code !== 'ENOENT') {
                    throw err;
                }
                fs.unlinkSync(linkPath);
                currentTarget = null;
            }
            if (currentTarget === expectedTarget) {
                return linkPath;
            }
            if (currentTarget) {
                fs.unlinkSync(linkPath);
            }
        } else {
            throw new Error(
                `[seatbelt] ${agentName}: ${linkPath} exists and is not the Ploinky-managed `
                + 'dependency-cache symlink. Remove or move that node_modules directory, then restart.'
            );
        }
    } catch (err) {
        if (!err || err.code !== 'ENOENT') {
            throw new Error(`[seatbelt] ${agentName}: failed to inspect ${linkPath}: ${err.message}`);
        }
    }
    fs.symlinkSync(nodeModulesDir, linkPath, 'dir');
    return linkPath;
}

function normalizeMountMode(mode, fallback) {
    if (mode === 'ro' || mode === 'rw') return mode;
    return fallback;
}

function getProfileMountModes(profile, profileConfig = {}) {
    const defaultMounts = getDefaultMountModes(profile);
    const mounts = profileConfig?.mounts || {};
    const codeMode = normalizeMountMode(mounts.code, defaultMounts.code);
    const skillsMode = normalizeMountMode(mounts.skills, defaultMounts.skills);
    return {
        codeReadOnly: codeMode === 'ro',
        skillsReadOnly: skillsMode === 'ro'
    };
}

/**
 * Rewrite mcp-config.json for seatbelt: copy it to the agent work dir
 * and replace /code/ references with the real code path.
 * Returns the path to the rewritten copy, or null if no mcp-config exists.
 */
function rewriteMcpConfig(agentName, agentCodePath, agentWorkDir, agentLibPath = AGENT_LIB_PATH) {
    const sourcePath = path.join(agentWorkDir, 'mcp-config.json');
    if (!fs.existsSync(sourcePath)) return null;

    try {
        let content = fs.readFileSync(sourcePath, 'utf8');
        // Replace /code/ references with the real agent code path
        content = content.replace(/\/code\//g, agentCodePath + '/');
        content = content.replace(/\/code"/g, agentCodePath + '"');
        content = content.replace(/\/Agent\//g, agentLibPath + '/');
        content = content.replace(/\/Agent"/g, agentLibPath + '"');
        const rewrittenPath = path.join(agentWorkDir, 'mcp-config.seatbelt.json');
        fs.writeFileSync(rewrittenPath, content, 'utf8');
        return rewrittenPath;
    } catch (err) {
        debugLog(`[seatbelt] ${agentName}: failed to rewrite mcp-config: ${err.message}`);
        return null;
    }
}

/**
 * Build the shell command that runs inside the seatbelt sandbox.
 * Like buildBwrapEntryCommand but replaces /code/ and /Agent/ with real paths.
 */
function buildSeatbeltEntryCommand(agentName, manifest, profileConfig, realPaths) {
    const { agentCodePath, agentLibPath } = realPaths;
    const { raw: explicitAgentCmd } = readManifestAgentCommand(manifest);
    const startCmd = readManifestStartCommand(manifest);
    const useStartEntry = Boolean(startCmd);

    // Dependencies are prepared before sandbox launch and exposed read-only via
    // the seatbelt profile. The sandboxed process never runs npm install.
    const manifestInstallCmd = String(profileConfig?.install || manifest?.install || '').trim();

    const rewritePath = (cmd) => {
        if (!cmd) return cmd;
        return cmd
            .replace(/\/code\//g, agentCodePath + '/')
            .replace(/\/code(?=["'\s;|&$]|$)/g, agentCodePath)
            .replace(/\/Agent\//g, agentLibPath + '/')
            .replace(/\/Agent(?=["'\s;|&$]|$)/g, agentLibPath);
    };

    const rewrittenInstall = manifestInstallCmd ? rewritePath(manifestInstallCmd) : '';

    let entryCmd;
    if (useStartEntry && explicitAgentCmd) {
        const rewrittenStart = rewritePath(startCmd);
        const rewrittenAgent = rewritePath(explicitAgentCmd);
        entryCmd = rewrittenInstall
            ? `cd ${agentCodePath} && ${rewrittenInstall} && (${rewrittenStart} &) && exec ${rewrittenAgent}`
            : `cd ${agentCodePath} && (${rewrittenStart} &) && exec ${rewrittenAgent}`;
    } else if (useStartEntry) {
        const rewrittenStart = rewritePath(startCmd);
        entryCmd = rewrittenInstall
            ? `cd ${agentCodePath} && ${rewrittenInstall} && ${rewrittenStart}`
            : `cd ${agentCodePath} && ${rewrittenStart}`;
    } else if (explicitAgentCmd) {
        const rewrittenAgent = rewritePath(explicitAgentCmd);
        entryCmd = rewrittenInstall
            ? `cd ${agentCodePath} && ${rewrittenInstall} && ${rewrittenAgent}`
            : `cd ${agentCodePath} && ${rewrittenAgent}`;
    } else {
        entryCmd = rewrittenInstall
            ? `${rewrittenInstall} && sh ${agentLibPath}/server/AgentServer.sh`
            : `sh ${agentLibPath}/server/AgentServer.sh`;
    }

    return entryCmd;
}

function resolveSeatbeltAgentNodeModules({
    repoName,
    agentName,
    agentCodePath,
    agentWorkDir,
    needsCoreDeps,
}) {
    if (!needsCoreDeps) {
        const fallback = path.join(agentWorkDir, 'node_modules');
        if (!fs.existsSync(fallback)) {
            fs.mkdirSync(fallback, { recursive: true });
        }
        return fallback;
    }
    return ensureAgentCacheForFamily({
        family: 'seatbelt',
        repoName,
        agentName,
        agentCodePath,
    });
}

/**
 * Start a seatbelt-sandboxed agent process.
 */
function startSeatbeltProcess(agentName, manifest, agentPath, options = {}) {
    const repoName = path.basename(path.dirname(agentPath));
    const alias = options.alias;
    const cwd = getConfiguredProjectPath(agentName, repoName, alias);
    const sharedDir = ensureSharedHostDir();

    // Profile configuration
    const activeProfile = getActiveProfile();
    const hasProfileConfig = Boolean(manifest?.profiles && Object.keys(manifest.profiles).length > 0);
    const profileConfig = hasProfileConfig
        ? getProfileConfig(`${repoName}/${agentName}`, activeProfile)
        : null;
    if (hasProfileConfig && !profileConfig) {
        const availableProfiles = Object.keys(manifest.profiles || {});
        throw new Error(`[profile] ${agentName}: profile '${activeProfile}' not found. Available: ${availableProfiles.join(', ')}`);
    }

    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const envHash = computeEnvHash(manifest, profileConfig, {}, { agentName, repoName });
    const { codeReadOnly, skillsReadOnly } = getProfileMountModes(activeProfile, profileConfig || {});

    // Resolve paths (real host paths — no mount namespaces)
    const agentCodePath = resolveSymlinkPath(getAgentCodePath(agentName));
    const agentSkillsPath = resolveSymlinkPath(getAgentSkillsPath(agentName));
    const agentWorkDir = cwd;

    // Pre-container lifecycle
    const preLifecycle = runPreContainerLifecycle(agentName, repoName, agentPath, activeProfile);
    if (!preLifecycle.success) {
        throw new Error(`[profile] ${agentName}: pre-container lifecycle failed: ${preLifecycle.errors.join('; ')}`);
    }

    // Ensure work directory and MCP config
    fs.mkdirSync(agentWorkDir, { recursive: true });
    syncAgentMcpConfig(`seatbelt_${agentName}`, path.resolve(agentPath), alias || agentName, { workDir: agentWorkDir });

    // Prepare or reuse the host dependency cache (see dependencyCache.js).
    const agentHasPackageJson = fs.existsSync(path.join(agentCodePath, 'package.json'));
    const startCmd = readManifestStartCommand(manifest);
    const needsCoreDeps = !startCmd || agentHasPackageJson;
    const nodeModulesDir = resolveSeatbeltAgentNodeModules({
        repoName,
        agentName,
        agentCodePath,
        agentWorkDir,
        needsCoreDeps,
    });
    ensureSeatbeltCodeNodeModules(agentName, agentCodePath, nodeModulesDir);
    const seatbeltAgentLibPath = ensureSeatbeltAgentLibDir(agentName, nodeModulesDir);

    // Port resolution — with shared host network, hostPort === containerPort
    const { portMappings } = parseManifestPorts(manifest, profileConfig);
    const additionalServerPort = resolveProfileServer(manifest, profileConfig, { runtimeMode: 'host' });
    let allPortMappings = [...portMappings];
    if (!allPortMappings.length) {
        const containerName = options.containerName || getAgentContainerName(agentName, repoName);
        const existingAgents = loadAgentsMap();
        const existingRecord = existingAgents[containerName] || {};
        const hostPort = options.preferredHostPort || existingRecord?.config?.ports?.[0]?.hostPort || (10000 + Math.floor(Math.random() * 50000));
        allPortMappings = [{ containerPort: hostPort, hostPort }];
    }
    const hostPort = allPortMappings[0]?.hostPort;

    const runtimeResourcePlan = planRuntimeResources(manifest, { useHostStoragePath: true, agentName, repoName });
    ensurePersistentStorageHostDir(runtimeResourcePlan);

    // Build environment map (reuse bwrap's builder with 'seatbelt' runtimeName)
    const envMap = buildFullEnvMap(agentName, manifest, profileConfig, agentWorkDir, repoName, activeProfile, 'seatbelt', runtimeResourcePlan);

    // Set PORT env var
    if (hostPort) {
        envMap.PORT = String(hostPort);
    }

    // Seatbelt-specific env vars: real paths for AgentServer.sh/mjs
    envMap.PLOINKY_AGENT_LIB_DIR = seatbeltAgentLibPath;
    envMap.PLOINKY_INVOCATION_AUTH_MODULE = path.join(seatbeltAgentLibPath, 'lib/invocation-auth.mjs');
    envMap.PLOINKY_CODE_DIR = agentCodePath;

    // NODE_PATH for module resolution
    envMap.NODE_PATH = nodeModulesDir;
    envMap.HOME = agentWorkDir;
    envMap.PATH = buildSeatbeltPathEnv();

    // Rewrite mcp-config.json for real paths
    const rewrittenMcpConfig = rewriteMcpConfig(agentName, agentCodePath, agentWorkDir, seatbeltAgentLibPath);
    if (rewrittenMcpConfig) {
        envMap.PLOINKY_MCP_CONFIG_PATH = rewrittenMcpConfig;
    }

    // Generate seatbelt profile
    const profileContent = buildSeatbeltProfile({
        agentCodePath,
        agentLibPath: seatbeltAgentLibPath,
        nodeModulesDir,
        agentWorkDir,
        sharedDir,
        cwd,
        skillsPath: agentSkillsPath,
        codeReadOnly,
        skillsReadOnly,
        volumes: manifest.volumes,
        workspaceRoot: PLOINKY_WORKSPACE_ROOT,
        extraReadPaths: getSeatbeltExtraReadPaths(),
        extraWritePaths: [
            LOGS_DIR,
            ...(runtimeResourcePlan.persistentStorage?.hostPath ? [runtimeResourcePlan.persistentStorage.hostPath] : [])
        ]
    });
    const profilePath = writeSeatbeltProfile(agentName, profileContent);

    // Build entry command with real paths
    const entryCmd = buildSeatbeltEntryCommand(agentName, manifest, profileConfig, {
        agentCodePath,
        agentLibPath: seatbeltAgentLibPath,
        agentWorkDir
    });

    // Ensure logs directory exists
    const logsDir = LOGS_DIR;
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, `${agentName}-seatbelt.log`);

    console.log(`[seatbelt] ${agentName}: starting sandbox (profile=${activeProfile}, cwd='${cwd}')`);
    debugLog(`[seatbelt] ${agentName}: entry command: sh -c "${entryCmd}"`);
    debugLog(`[seatbelt] ${agentName}: seatbelt profile: ${profilePath}`);
    debugLog(`[seatbelt] ${agentName}: log file: ${logFile}`);

    // Spawn detached sandbox-exec process
    const logFd = fs.openSync(logFile, 'a');
    const child = spawn('sandbox-exec', ['-f', profilePath, 'sh', '-c', entryCmd], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: envMap,
        cwd
    });
    child.unref();
    fs.closeSync(logFd);

    if (!child.pid) {
        throw new Error(`[seatbelt] ${agentName}: failed to spawn sandbox-exec process`);
    }

    // Wait briefly then verify the process is actually alive (not a zombie or already exited)
    spawnSync('sleep', ['0.5']);
    let processAlive = false;
    try {
        // macOS: use ps to check process state (no /proc filesystem)
        const psResult = spawnSync('ps', ['-p', String(child.pid), '-o', 'state='], { stdio: 'pipe' });
        if (psResult.status === 0) {
            const state = (psResult.stdout || '').toString().trim();
            // 'Z' = zombie on macOS/BSD
            processAlive = state.length > 0 && !state.startsWith('Z');
        }
    } catch {
        processAlive = false;
    }
    if (!processAlive) {
        let reason = 'unknown error';
        try {
            const logContent = fs.readFileSync(logFile, 'utf8').trim();
            const lastLine = logContent.split('\n').pop();
            if (lastLine) reason = lastLine;
        } catch { /* ignore */ }
        clearBwrapPid(agentName);
        throw new Error(`seatbelt process exited immediately: ${reason}`);
    }

    // Save PID (reuse bwrap PID management)
    saveBwrapPid(agentName, child.pid);
    console.log(`[seatbelt] ${agentName}: started with PID ${child.pid}`);

    // Save to agents map
    const containerName = options.containerName || getAgentContainerName(agentName, repoName);
    const agents = loadAgentsMap();
    const existingRecord = agents[containerName] || {};
    const declaredEnvNames = [
        ...getManifestEnvNames(manifest, profileConfig),
        ...getExposedNames(manifest, profileConfig)
    ];

    agents[containerName] = {
        agentName,
        repoName,
        runtime: 'seatbelt',
        pid: child.pid,
        containerImage: 'host (seatbelt)',
        envHash,
        createdAt: existingRecord.createdAt || new Date().toISOString(),
        projectPath: cwd,
        runtimeStaging: {
            agentLibPath: seatbeltAgentLibPath
        },
        runMode: existingRecord.runMode,
        develRepo: existingRecord.develRepo,
        profile: activeProfile,
        type: 'agent',
        config: {
            binds: [
                { source: AGENT_LIB_PATH, target: AGENT_LIB_PATH, ro: true },
                { source: agentCodePath, target: agentCodePath, ro: codeReadOnly },
                { source: sharedDir, target: sharedDir },
                ...(fs.existsSync(agentSkillsPath) ? [{ source: agentSkillsPath, target: agentSkillsPath, ro: skillsReadOnly }] : []),
                { source: cwd, target: cwd }
            ],
            env: Array.from(new Set(declaredEnvNames)).map((name) => ({ name })),
            ports: allPortMappings,
            ...(additionalServerPort ? { additionalServerPort } : {})
        }
    };
    if (existingRecord.auth) {
        agents[containerName].auth = existingRecord.auth;
    }

    if (existingRecord.alias || options.alias) {
        agents[containerName].alias = options.alias || existingRecord.alias;
    }
    saveAgentsMap(agents);

    // Run profile lifecycle hooks
    try {
        if (profileConfig) {
            const lifecycleResult = runProfileLifecycle(agentName, activeProfile, {
                containerName,
                agentPath,
                repoName,
                manifest,
                skipInstallHooks: true
            });
            if (!lifecycleResult.success) {
                const details = lifecycleResult.errors.join('; ');
                console.warn(`[seatbelt] ${agentName}: lifecycle warning: ${details}`);
            }
        }
    } catch (error) {
        console.warn(`[seatbelt] ${agentName}: lifecycle hook error: ${error.message}`);
    }

    syncAgentMcpConfig(containerName, path.resolve(agentPath), agentName);

    const returnPort = allPortMappings.find((p) => p.containerPort === 7000)?.hostPort || allPortMappings[0]?.hostPort || 0;
    return { containerName, hostPort: returnPort, additionalServerPort };
}

/**
 * Idempotent service start — check if already running, compare env hash, start/restart as needed.
 */
function ensureSeatbeltService(agentName, manifest, agentPath, options = {}) {
    let preferredHostPort;
    let containerOverride;
    let aliasOverride;
    let forceRecreate = false;

    if (typeof options === 'number') {
        preferredHostPort = options;
    } else if (options && typeof options === 'object') {
        preferredHostPort = options.preferredHostPort;
        containerOverride = options.containerName;
        aliasOverride = options.alias;
        forceRecreate = options.forceRecreate === true;
    }

    const repoName = path.basename(path.dirname(agentPath));
    const containerName = containerOverride || getAgentContainerName(agentName, repoName);
    const snapshot = loadAgentsMap();
    const existingRecord = snapshot[containerName] || {};

    if (!aliasOverride && existingRecord.alias) {
        aliasOverride = existingRecord.alias;
    }

    // Profile config for env hash comparison
    const activeProfile = getActiveProfile();
    const hasProfileConfig = Boolean(manifest?.profiles && Object.keys(manifest.profiles).length > 0);
    const profileConfig = hasProfileConfig
        ? getProfileConfig(`${repoName}/${agentName}`, activeProfile)
        : null;

    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const { portMappings } = parseManifestPorts(manifest, profileConfig);
    const additionalServerPort = resolveProfileServer(manifest, profileConfig, { runtimeMode: 'host' });
    let allPortMappings = [...portMappings];
    if (!allPortMappings.length) {
        const hostPort = preferredHostPort || existingRecord?.config?.ports?.[0]?.hostPort || (10000 + Math.floor(Math.random() * 50000));
        allPortMappings = [{ containerPort: hostPort, hostPort }];
    }

    // Force recreate
    if (forceRecreate && isBwrapProcessRunning(agentName)) {
        console.log(`[seatbelt] ${agentName}: force recreating...`);
        stopBwrapProcess(agentName);
    }

    // Check if already running
    if (isBwrapProcessRunning(agentName)) {
        const desired = computeEnvHash(manifest, profileConfig, {}, { agentName, repoName });
        const current = existingRecord.envHash || '';
        if (desired && desired !== current) {
            console.log(`[seatbelt] ${agentName}: env hash changed, restarting...`);
            stopBwrapProcess(agentName);
        } else {
            debugLog(`[seatbelt] ${agentName}: already running (PID ${getBwrapPid(agentName)})`);
            const hostPort = allPortMappings[0]?.hostPort || 0;
            syncAgentMcpConfig(containerName, agentPath, agentName);
            return { containerName, hostPort, additionalServerPort };
        }
    }

    // Start the process. Sweep stale Agent-<pid>-<ts> directories rather than
    // wiping the per-agent root: a concurrent `ploinky cli`/`ploinky shell`
    // attached via attachSeatbeltInteractive may still hold a sibling staged
    // dir that we must not delete.
    fs.mkdirSync(SEATBELT_RUNTIME_ROOT, { recursive: true });
    const seatbeltAgentRoot = path.join(SEATBELT_RUNTIME_ROOT, runtimeSegment(agentName));
    fs.mkdirSync(seatbeltAgentRoot, { recursive: true });
    pruneStaleRuntimeEntries(seatbeltAgentRoot);
    return startSeatbeltProcess(agentName, manifest, agentPath, {
        preferredHostPort: allPortMappings[0]?.hostPort,
        containerName,
        alias: aliasOverride
    });
}

/**
 * Spawn an interactive seatbelt session (for `ploinky cli` / `ploinky shell`).
 */
function attachSeatbeltInteractive(agentName, manifest, agentPath, workdir, entryCommand, options = {}) {
    const repoName = path.basename(path.dirname(agentPath));
    const containerName = options.containerName || getAgentContainerName(agentName, repoName);
    const agents = loadAgentsMap();
    const record = agents[containerName];

    if (!record || record.runtime !== 'seatbelt') {
        throw new Error(`[seatbelt] ${agentName}: not running as seatbelt agent`);
    }

    // Profile configuration
    const activeProfile = getActiveProfile();
    const hasProfileConfig = Boolean(manifest?.profiles && Object.keys(manifest.profiles).length > 0);
    const profileConfig = hasProfileConfig
        ? getProfileConfig(`${repoName}/${agentName}`, activeProfile)
        : null;

    // Resolve paths
    const agentCodePath = resolveSymlinkPath(getAgentCodePath(agentName));
    const agentSkillsPath = resolveSymlinkPath(getAgentSkillsPath(agentName));
    const agentWorkDir = record.projectPath || getAgentWorkDir(agentName);
    const sharedDir = ensureSharedHostDir();
    const agentHasPackageJson = fs.existsSync(path.join(agentCodePath, 'package.json'));
    const startCmd = readManifestStartCommand(manifest);
    const needsCoreDeps = !startCmd || agentHasPackageJson;
    const nodeModulesDir = resolveSeatbeltAgentNodeModules({
        repoName,
        agentName,
        agentCodePath,
        agentWorkDir,
        needsCoreDeps,
    });
    ensureSeatbeltCodeNodeModules(agentName, agentCodePath, nodeModulesDir);
    // Sweep stale interactive sessions whose owning processes have exited
    // before staging a new Agent dir for this attach. Keep the live service's
    // staged Agent dir: it was created by the launcher process, not by the
    // long-running sandbox PID, so PID-based pruning alone would remove it.
    const serviceAgentLibPath = record.runtimeStaging?.agentLibPath;
    if (serviceAgentLibPath) {
        try {
            pruneStaleRuntimeEntries(path.join(SEATBELT_RUNTIME_ROOT, runtimeSegment(agentName)), {
                keepPaths: [serviceAgentLibPath]
            });
        } catch (_) {}
    }
    const seatbeltAgentLibPath = ensureSeatbeltAgentLibDir(agentName, nodeModulesDir);
    const { codeReadOnly, skillsReadOnly } = getProfileMountModes(activeProfile, profileConfig || {});

    const runtimeResourcePlan = planRuntimeResources(manifest, { useHostStoragePath: true, agentName, repoName });
    ensurePersistentStorageHostDir(runtimeResourcePlan);

    // Build environment (same as running agent)
    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const envMap = buildFullEnvMap(agentName, manifest, profileConfig, agentWorkDir, repoName, activeProfile, 'seatbelt', runtimeResourcePlan);
    const hostPort = record.config?.ports?.[0]?.hostPort;
    if (hostPort) envMap.PORT = String(hostPort);
    envMap.PLOINKY_AGENT_LIB_DIR = seatbeltAgentLibPath;
    envMap.PLOINKY_INVOCATION_AUTH_MODULE = path.join(seatbeltAgentLibPath, 'lib/invocation-auth.mjs');
    envMap.PLOINKY_CODE_DIR = agentCodePath;
    envMap.NODE_PATH = nodeModulesDir;
    envMap.HOME = agentWorkDir;
    envMap.PATH = buildSeatbeltPathEnv();

    // Rewrite mcp-config
    const rewrittenMcpConfig = rewriteMcpConfig(agentName, agentCodePath, agentWorkDir, seatbeltAgentLibPath);
    if (rewrittenMcpConfig) {
        envMap.PLOINKY_MCP_CONFIG_PATH = rewrittenMcpConfig;
    }

    // Generate seatbelt profile
    const profileContent = buildSeatbeltProfile({
        agentCodePath,
        agentLibPath: seatbeltAgentLibPath,
        nodeModulesDir,
        agentWorkDir,
        sharedDir,
        cwd: record.projectPath || agentWorkDir,
        skillsPath: agentSkillsPath,
        codeReadOnly,
        skillsReadOnly,
        volumes: manifest.volumes,
        workspaceRoot: PLOINKY_WORKSPACE_ROOT,
        extraReadPaths: getSeatbeltExtraReadPaths(),
        extraWritePaths: [
            LOGS_DIR,
            ...(runtimeResourcePlan.persistentStorage?.hostPath ? [runtimeResourcePlan.persistentStorage.hostPath] : [])
        ]
    });
    const profilePath = writeSeatbeltProfile(agentName, profileContent);

    // Build command
    const wd = workdir || agentCodePath;
    const cmd = entryCommand && String(entryCommand).trim()
        ? entryCommand
        : 'exec /bin/bash || exec /bin/sh';

    // Rewrite /code/ and /Agent/ in the command to real paths
    const rewrittenCmd = cmd
        .replace(/\/code\//g, agentCodePath + '/')
        .replace(/\/code(?=["'\s;|&$]|$)/g, agentCodePath)
        .replace(/\/Agent\//g, seatbeltAgentLibPath + '/')
        .replace(/\/Agent(?=["'\s;|&$]|$)/g, seatbeltAgentLibPath);

    debugLog(`[seatbelt] ${agentName}: interactive session: sh -lc "cd '${wd}' && ${rewrittenCmd}"`);

    const result = spawnSync('sandbox-exec', ['-f', profilePath, 'sh', '-lc', `cd '${wd}' && ${rewrittenCmd}`], {
        stdio: 'inherit',
        env: envMap,
        cwd: record.projectPath || agentWorkDir
    });
    return result.status ?? 0;
}

export {
    ensureSeatbeltService,
    startSeatbeltProcess,
    attachSeatbeltInteractive,
    rewriteMcpConfig,
    buildSeatbeltEntryCommand,
    buildSeatbeltPathEnv,
    getSeatbeltExtraReadPaths,
    ensureSeatbeltAgentLibDir,
    ensureSeatbeltCodeNodeModules
};
