import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { debugLog } from '../../utils/utils.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
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
import { openSandboxLogHandle, readSandboxCrashLog } from '../sandboxLogFiles.js';
import { sanitizeDiagnosticText } from '../../utils/diagnosticText.js';
import { guardSpawnedChild } from '../../utils/childSpawn.js';
import { ensureSharedHostDir } from '../docker/agentHooks.js';
import {
    ensureManifestVolumeHostPath,
    readManifestVolumeOptions,
    resolveManifestVolumeHostPath,
} from '../../utils/runtime/manifestVolumePolicy.js';
import {
    AGENT_DATA_POLICY_CODE,
    assertCanonicalAgentDataPath,
    ensureAgentDataDirectory,
} from '../../utils/runtime/agentDataPathPolicy.js';
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
    getDefaultMountModes,
    getProfileEnvVars,
    mergeProfiles,
    resolveManifestRuntimeProfile
} from '../../utils/runtime/profileService.js';
import {
    assertHostSandboxNetworkCompatibility,
    assertNetworkStartupCompatibility,
} from '../networkContract.js';
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
    assertBwrapPidSlotAvailable,
    isBwrapProcessRunning,
    normalizeSandboxRuntimeIdentity,
    stopBwrapProcess,
    saveBwrapPid,
    clearBwrapPid,
    getBwrapPid
} from '../bwrap/bwrapFleet.js';
// Reuse env map builder from bwrap (with runtimeName param)
import { buildFullEnvMap } from '../bwrap/bwrapServiceManager.js';
import { agentLibGrant, agentLibReuseProblem, agentLibRuntimeRecord } from '../agentLibGrant.js';
import { detectHostRuntimeKey } from '../../utils/dependencies/dependencyRuntimeKey.js';
// Seatbelt profile generator
import { buildSeatbeltProfile, writeSeatbeltProfile } from './seatbeltProfile.js';
import { assertRouterEndpoint } from '../routerPort.js';
import {
    admitManifestRuntimeCapabilities,
    assertRuntimeAdmissionCurrent,
} from '../runtimeCapabilities.js';
import { assertHostModeGenerationCapability } from '../edgeGeneration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_LIB_PATH = path.resolve(__dirname, '../../../Agent');

function resolveSeatbeltRuntimeProfile(agentName, manifest, agentPath, options = {}, existingRecord = {}) {
    const repoName = path.basename(path.dirname(agentPath));
    const manifestPath = `manifest(${repoName}/${agentName})`;
    const resolution = options.profileResolution || resolveManifestRuntimeProfile(manifest, {
        agentName: `${repoName}/${agentName}`,
        profileName: options.profileName,
        persistedProfileName: existingRecord.profile,
        path: manifestPath,
    });
    assertNetworkStartupCompatibility(manifest, resolution.profileConfig, resolution.network, {
        path: manifestPath,
    });
    assertHostSandboxNetworkCompatibility(resolution.network, {
        path: `${manifestPath}.network`,
        runtime: 'seatbelt',
    });
    return resolution;
}

function admitSeatbeltBoundary(agentName, manifest, agentPath, options, profileResolution) {
    const repoName = path.basename(path.dirname(agentPath));
    const optionBag = options && typeof options === 'object' ? options : {};
    const manifestPath = path.join(agentPath, 'manifest.json');
    const manifestBytes = optionBag.manifestBytes !== undefined
        ? Buffer.from(optionBag.manifestBytes)
        : (fs.existsSync(manifestPath)
            ? fs.readFileSync(manifestPath)
            : Buffer.from(JSON.stringify(manifest), 'utf8'));
    const admission = admitManifestRuntimeCapabilities(manifest, {
        manifestBytes,
        manifestPath,
        agentId: `${repoName}/${agentName}`,
        profileName: profileResolution.resolvedProfileName,
        profileConfig: profileResolution.profileConfig,
        network: profileResolution.network,
        runtimeKind: 'seatbelt',
    });
    if (optionBag.runtimeAdmission) {
        assertRuntimeAdmissionCurrent(optionBag.runtimeAdmission, {
            manifestBytes,
            profileName: profileResolution.resolvedProfileName,
            runtimeKind: 'seatbelt',
            descriptor: admission.descriptor,
        });
    }
    return Object.freeze({
        admission: optionBag.runtimeAdmission || admission,
        manifestBytes,
    });
}

function resolveSeatbeltRouterEndpoint(options = {}, networkMode = 'host') {
    if (options && typeof options === 'object' && Object.prototype.hasOwnProperty.call(options, 'routerHost')) {
        throw new Error('routerHost overrides are not supported; pass the validated routerEndpoint');
    }
    return assertRouterEndpoint(options?.routerEndpoint, networkMode, { explicitPort: options?.routerPort });
}
const DEFAULT_SEATBELT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SEATBELT_RUNTIME_ROOT = path.join(PLOINKY_DIR, 'seatbelt-runtime');
const UNATTESTED_GENERATED_LOCAL_ENV = Object.freeze([
    'PLOINKY_ROUTER_DESCRIPTOR_FILE',
    'PLOINKY_ROUTER_URL',
    'PLOINKY_ROUTER_REQUEST_AUTHORITY',
    'PLOINKY_ROUTER_AUTHORITY',
    'PLOINKY_AGENT_SECRET',
    'PLOINKY_AGENT_PRIVATE_SECRET',
    'PLOINKY_AGENT_API_KEY',
    'PLOINKY_AGENT_API_PUBLIC_KEY',
]);

function assertSeatbeltGeneratedLocalDisabled(env) {
    const leaked = UNATTESTED_GENERATED_LOCAL_ENV.filter((name) => (
        Object.prototype.hasOwnProperty.call(env || {}, name)
    ));
    if (leaked.length) {
        throw new Error(`seatbelt generated-local routing is uncertified; refusing key-capable env (${leaked.join(', ')})`);
    }
}

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
    assertCanonicalAgentDataPath(sourcePath);
    if (!fs.existsSync(sourcePath)) return null;

    try {
        let content = fs.readFileSync(sourcePath, 'utf8');
        // Replace /code/ references with the real agent code path
        content = content.replace(/\/code\//g, agentCodePath + '/');
        content = content.replace(/\/code"/g, agentCodePath + '"');
        content = content.replace(/\/Agent\//g, agentLibPath + '/');
        content = content.replace(/\/Agent"/g, agentLibPath + '"');
        const rewrittenPath = path.join(agentWorkDir, 'mcp-config.seatbelt.json');
        assertCanonicalAgentDataPath(rewrittenPath);
        fs.writeFileSync(rewrittenPath, content, 'utf8');
        assertCanonicalAgentDataPath(rewrittenPath);
        return rewrittenPath;
    } catch (err) {
        if (err?.code === AGENT_DATA_POLICY_CODE) throw err;
        debugLog(`[seatbelt] ${agentName}: failed to rewrite mcp-config: ${err.message}`);
        return null;
    }
}

function ensureSeatbeltManifestVolumePaths(manifest, profileConfig) {
    for (const source of [manifest, profileConfig]) {
        const volumes = source?.volumes && typeof source.volumes === 'object' ? source.volumes : {};
        const volumeOptions = readManifestVolumeOptions(source);
        for (const [hostPath, containerPath] of Object.entries(volumes)) {
            const options = volumeOptions[containerPath]
                || volumeOptions[String(containerPath || '').replace(/\/+$/, '')]
                || {};
            const resolvedHostPath = resolveManifestVolumeHostPath(hostPath, PLOINKY_WORKSPACE_ROOT);
            ensureManifestVolumeHostPath(resolvedHostPath, containerPath, options);
        }
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
        ensureAgentDataDirectory(fallback);
        return fallback;
    }
    return ensureAgentCacheForFamily({
        family: 'seatbelt',
        repoName,
        agentName,
        agentCodePath,
    });
}

function resolveSeatbeltRuntimeLayout({ agentName, alias, cwd }) {
    const canonicalAgentName = String(agentName || '').trim();
    const instanceName = String(alias || canonicalAgentName).trim();
    const cwdInput = String(cwd || '').trim();
    if (!canonicalAgentName || !instanceName || !path.isAbsolute(cwdInput)) {
        throw new Error('[seatbelt] agent runtime layout is invalid');
    }
    return Object.freeze({
        instanceName,
        cwd: path.resolve(cwdInput),
        agentWorkDir: getAgentWorkDir(instanceName),
    });
}

function applySeatbeltRuntimeEnvironment(envMap, layout) {
    envMap.WORKSPACE_PATH = layout.cwd;
    envMap.HOME = layout.agentWorkDir;
    return envMap;
}

function buildSeatbeltRuntimeBinds(layout) {
    return Array.from(new Set([layout.agentWorkDir, layout.cwd].map(value => path.resolve(value))))
        .map(value => ({ source: value, target: value }));
}

/**
 * Start a seatbelt-sandboxed agent process.
 */
function startSeatbeltProcess(agentName, manifest, agentPath, options = {}) {
    const repoName = path.basename(path.dirname(agentPath));
    const containerName = options.containerName || getAgentContainerName(agentName, repoName);
    const profileRecord = loadAgentsMap()[containerName] || {};
    const alias = options.alias || profileRecord.alias;
    const runtimeIdentity = normalizeSandboxRuntimeIdentity(options);
    const layout = resolveSeatbeltRuntimeLayout({
        agentName,
        alias,
        cwd: getConfiguredProjectPath(agentName, repoName, alias),
    });
    const { instanceName, cwd, agentWorkDir } = layout;

    // Profile and network are resolved atomically before any sandbox work.
    const profileResolution = resolveSeatbeltRuntimeProfile(agentName, manifest, agentPath, options, profileRecord);
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    admitSeatbeltBoundary(agentName, manifest, agentPath, options, profileResolution);
    assertHostModeGenerationCapability({
        agentId: deriveAgentPrincipalId(repoName, agentName),
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        routeKey: instanceName,
        containerName,
    }, { preparedCapability: options.preparedHostModeCapability });
    assertBwrapPidSlotAvailable(containerName);
    const routerEndpoint = resolveSeatbeltRouterEndpoint(options, profileResolution.network.mode);

    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const envHash = computeEnvHash(manifest, profileConfig, routerEndpoint.env, { agentName, repoName });
    const { codeReadOnly, skillsReadOnly } = getProfileMountModes(activeProfile, profileConfig || {});
    const sharedDir = ensureSharedHostDir();

    // Resolve paths (real host paths — no mount namespaces)
    const agentCodePath = resolveSymlinkPath(getAgentCodePath(agentName));
    const agentSkillsPath = resolveSymlinkPath(getAgentSkillsPath(agentName));
    // Pre-container lifecycle
    const preLifecycle = runPreContainerLifecycle(agentName, repoName, agentPath, activeProfile);
    if (!preLifecycle.success) {
        throw new Error(`[profile] ${agentName}: pre-container lifecycle failed: ${preLifecycle.errors.join('; ')}`);
    }

    // Ensure work directory and MCP config
    ensureAgentDataDirectory(agentWorkDir);
    syncAgentMcpConfig(containerName, path.resolve(agentPath), instanceName, { workDir: agentWorkDir });

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
    // Seatbelt has no mount namespace, so the grant names the canonical host
    // source directly and the cache symlink targets that same path.
    const grant = agentLibGrant(detectHostRuntimeKey('seatbelt'));

    // Port resolution — with shared host network, hostPort === containerPort
    const { portMappings } = parseManifestPorts(manifest, profileConfig);
    let allPortMappings = [...portMappings];
    if (!allPortMappings.length) {
        const existingAgents = loadAgentsMap();
        const existingRecord = existingAgents[containerName] || {};
        const hostPort = options.preferredHostPort || existingRecord?.config?.ports?.[0]?.hostPort || (10000 + Math.floor(Math.random() * 50000));
        allPortMappings = [{ containerPort: hostPort, hostPort }];
    }
    const hostPort = allPortMappings[0]?.hostPort;

    const runtimeResourcePlan = planRuntimeResources(manifest, { useHostStoragePath: true, agentName, repoName });
    ensurePersistentStorageHostDir(runtimeResourcePlan);

    // Build environment map (reuse bwrap's builder with 'seatbelt' runtimeName)
    const envMap = buildFullEnvMap(agentName, manifest, profileConfig, cwd, repoName, activeProfile, 'seatbelt', runtimeResourcePlan, routerEndpoint, runtimeIdentity, grant);
    assertSeatbeltGeneratedLocalDisabled(envMap);

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
    applySeatbeltRuntimeEnvironment(envMap, layout);
    envMap.PATH = buildSeatbeltPathEnv();

    // Rewrite mcp-config.json for real paths
    const rewrittenMcpConfig = rewriteMcpConfig(agentName, agentCodePath, agentWorkDir, seatbeltAgentLibPath);
    if (rewrittenMcpConfig) {
        envMap.PLOINKY_MCP_CONFIG_PATH = rewrittenMcpConfig;
    }

    // Generate seatbelt profile
    ensureSeatbeltManifestVolumePaths(manifest, profileConfig);
    assertCanonicalAgentDataPath(agentWorkDir);
    assertCanonicalAgentDataPath(sharedDir);
    const profileContent = buildSeatbeltProfile({
        agentCodePath,
        agentLibGrant: grant,
        agentLibPath: seatbeltAgentLibPath,
        nodeModulesDir,
        agentWorkDir,
        sharedDir,
        cwd,
        skillsPath: agentSkillsPath,
        codeReadOnly,
        skillsReadOnly,
        volumes: {
            ...(manifest.volumes || {}),
            ...(profileConfig?.volumes || {}),
        },
        volumeOptions: {
            ...readManifestVolumeOptions(manifest),
            ...readManifestVolumeOptions(profileConfig),
        },
        workspaceRoot: PLOINKY_WORKSPACE_ROOT,
        extraReadPaths: getSeatbeltExtraReadPaths(),
        extraWritePaths: [
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

    const logsDir = LOGS_DIR;
    console.log(`[seatbelt] ${agentName}: starting sandbox (profile=${activeProfile}, cwd='${cwd}')`);
    debugLog(`[seatbelt] ${agentName}: entry command: sh -c "${entryCmd}"`);
    debugLog(`[seatbelt] ${agentName}: seatbelt profile: ${profilePath}`);

    // Spawn detached sandbox-exec process
    assertHostModeGenerationCapability({
        agentId: deriveAgentPrincipalId(repoName, agentName),
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        routeKey: instanceName,
        containerName,
    }, { preparedCapability: options.preparedHostModeCapability });
    // The final log name is derived from this launch's identity tuple and its
    // finalized pid, so it is only knowable once the child exists. Spawn
    // against an exclusive 0600 temporary file and publish it with a
    // no-replace hard link; the child keeps its own descriptor throughout.
    const logHandle = openSandboxLogHandle({
        containerName,
        logsDir,
        workspaceRoot: PLOINKY_WORKSPACE_ROOT,
    });
    let child;
    try {
        child = spawn('sandbox-exec', ['-f', profilePath, 'sh', '-c', entryCmd], {
            detached: true,
            stdio: logHandle.stdio,
            env: envMap,
            cwd
        });
        guardSpawnedChild(child, {
            label: `[seatbelt] ${agentName}: sandbox-exec process`,
            onError: (error) => debugLog(
                `[seatbelt] ${agentName}: child process error: ${sanitizeDiagnosticText(error)}`,
            ),
        });
        const logFile = logHandle.finalize(child.pid, runtimeIdentity);
        debugLog(`[seatbelt] ${agentName}: log file: ${logFile}`);

        spawnSync('sleep', ['0.5']);
        let processAlive = false;
        try {
            const psResult = spawnSync('ps', ['-p', String(child.pid), '-o', 'state='], { stdio: 'pipe' });
            if (psResult.status === 0) {
                const state = (psResult.stdout || '').toString().trim();
                processAlive = state.length > 0 && !state.startsWith('Z');
            }
        } catch {
            processAlive = false;
        }
        if (!processAlive) {
            let reason = 'unknown error';
            try {
                reason = readSandboxCrashLog(containerName, {
                    runtime: 'seatbelt', pid: child.pid, ...runtimeIdentity,
                }, { logsDir }) || reason;
            } catch {}
            throw new Error(`seatbelt process exited immediately: ${sanitizeDiagnosticText(reason)}`);
        }

        saveBwrapPid(containerName, child.pid, runtimeIdentity);
        logHandle.commit();
        child.unref();
    } catch (error) {
        if (child?.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { }
            try { process.kill(child.pid, 'SIGKILL'); } catch (_) { }
        }
        logHandle.discard();
        throw error;
    }
    console.log(`[seatbelt] ${agentName}: started with PID ${child.pid}`);

    try {
    // Save to agents map
    const agents = loadAgentsMap();
    const existingRecord = agents[containerName] || {};
    const declaredEnvNames = [
        ...getManifestEnvNames(manifest, profileConfig, { forRuntime: true }),
        ...getExposedNames(manifest, profileConfig, { forRuntime: true })
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
        agentLib: agentLibRuntimeRecord(grant),
        runMode: existingRecord.runMode,
        develRepo: existingRecord.develRepo,
        profile: activeProfile,
        type: 'agent',
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        config: {
            binds: [
                { source: AGENT_LIB_PATH, target: AGENT_LIB_PATH, ro: true },
                { source: grant.sourceDir, target: grant.runtimePath, ro: true },
                { source: agentCodePath, target: agentCodePath, ro: codeReadOnly },
                { source: sharedDir, target: sharedDir },
                ...(fs.existsSync(agentSkillsPath) ? [{ source: agentSkillsPath, target: agentSkillsPath, ro: skillsReadOnly }] : []),
                ...buildSeatbeltRuntimeBinds(layout)
            ],
            env: Array.from(new Set(declaredEnvNames)).map((name) => ({ name })),
            ports: allPortMappings,
        }
    };
    if (existingRecord.auth) {
        agents[containerName].auth = existingRecord.auth;
    }

    if (existingRecord.alias || options.alias) {
        agents[containerName].alias = options.alias || existingRecord.alias;
    }
    if (options.preservePreparedRegistryRecord !== true) saveAgentsMap(agents);

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

    syncAgentMcpConfig(containerName, path.resolve(agentPath), instanceName, { workDir: agentWorkDir });

    const returnPort = allPortMappings.find((p) => p.containerPort === 7000)?.hostPort || allPortMappings[0]?.hostPort || 0;
    return {
        containerName,
        hostPort: returnPort,
        createdByThisLaunch: true,
        registryRecord: structuredClone(agents[containerName]),
    };
    } catch (error) {
        const stopped = stopBwrapProcess(containerName, { expectedIdentity: runtimeIdentity });
        if (!stopped && isBwrapProcessRunning(containerName, runtimeIdentity)) {
            error.message = `${error.message}; exact sandbox candidate cleanup failed`;
        }
        throw error;
    }
}

/**
 * Idempotent service start — check if already running, compare env hash, start/restart as needed.
 */
function ensureSeatbeltService(agentName, manifest, agentPath, options = {}) {
    let preferredHostPort;
    let containerOverride;
    let aliasOverride;
    let forceRecreate = false;
    let profileNameOverride;

    if (typeof options === 'number') {
        preferredHostPort = options;
    } else if (options && typeof options === 'object') {
        preferredHostPort = options.preferredHostPort;
        containerOverride = options.containerName;
        aliasOverride = options.alias;
        forceRecreate = options.forceRecreate === true;
        profileNameOverride = options.profileName;
    }

    const repoName = path.basename(path.dirname(agentPath));
    const containerName = containerOverride || getAgentContainerName(agentName, repoName);
    const snapshot = loadAgentsMap();
    const existingRecord = snapshot[containerName] || {};
    const runtimeIdentity = normalizeSandboxRuntimeIdentity(options);

    if (!aliasOverride && existingRecord.alias) {
        aliasOverride = existingRecord.alias;
    }
    const reuseLayout = resolveSeatbeltRuntimeLayout({
        agentName,
        alias: aliasOverride,
        cwd: getConfiguredProjectPath(agentName, repoName, aliasOverride),
    });

    // Profile config and host-network compatibility are validated even when the
    // existing sandbox can otherwise be reused.
    const profileResolution = resolveSeatbeltRuntimeProfile(agentName, manifest, agentPath, {
        ...(options && typeof options === 'object' ? options : {}),
        profileName: profileNameOverride,
    }, existingRecord);
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    const runtimeBoundary = admitSeatbeltBoundary(
        agentName,
        manifest,
        agentPath,
        options,
        profileResolution,
    );
    assertHostModeGenerationCapability({
        agentId: deriveAgentPrincipalId(repoName, agentName),
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        routeKey: aliasOverride || agentName,
        containerName,
    }, { preparedCapability: options.preparedHostModeCapability });
    const routerEndpoint = resolveSeatbeltRouterEndpoint(options, profileResolution.network.mode);

    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const { portMappings } = parseManifestPorts(manifest, profileConfig);
    let allPortMappings = [...portMappings];
    if (!allPortMappings.length) {
        const hostPort = preferredHostPort || existingRecord?.config?.ports?.[0]?.hostPort || (10000 + Math.floor(Math.random() * 50000));
        allPortMappings = [{ containerPort: hostPort, hostPort }];
    }

    let exactRuntimeRunning = isBwrapProcessRunning(containerName, runtimeIdentity);

    // Force recreate
    if (forceRecreate) {
        console.log(`[seatbelt] ${agentName}: force recreating...`);
        stopBwrapProcess(containerName);
        exactRuntimeRunning = false;
    }

    if (!forceRecreate && !exactRuntimeRunning && stopBwrapProcess(containerName)) {
        console.log(`[seatbelt] ${agentName}: runtime generation changed, replacing stale sandbox...`);
    }

    // Check if already running
    if (exactRuntimeRunning) {
        const desired = computeEnvHash(manifest, profileConfig, routerEndpoint.env, { agentName, repoName });
        const current = existingRecord.envHash || '';
        // Seatbelt regenerates its profile from the source path, which does not
        // change when the same directory's content does, so the selection is
        // compared explicitly.
        const agentLibProblem = agentLibReuseProblem(
            existingRecord,
            agentLibGrant(detectHostRuntimeKey('seatbelt')),
        );
        if (desired && desired !== current) {
            console.log(`[seatbelt] ${agentName}: env hash changed, restarting...`);
            stopBwrapProcess(containerName);
        } else if (agentLibProblem) {
            console.log(`[seatbelt] ${agentName}: achillesAgentLib selection changed (${agentLibProblem}), restarting...`);
            stopBwrapProcess(containerName);
        } else {
            debugLog(`[seatbelt] ${agentName}: already running (PID ${getBwrapPid(containerName, runtimeIdentity)})`);
            const hostPort = allPortMappings[0]?.hostPort || 0;
            ensureAgentDataDirectory(reuseLayout.agentWorkDir);
            syncAgentMcpConfig(containerName, agentPath, reuseLayout.instanceName, {
                workDir: reuseLayout.agentWorkDir,
            });
            return {
                containerName,
                hostPort,
                createdByThisLaunch: false,
                registryRecord: structuredClone(existingRecord),
            };
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
        alias: aliasOverride,
        profileName: activeProfile,
        profileResolution,
        routerEndpoint,
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        preservePreparedRegistryRecord: options.preservePreparedRegistryRecord,
        runtimeAdmission: runtimeBoundary.admission,
        manifestBytes: runtimeBoundary.manifestBytes,
        preparedHostModeCapability: options.preparedHostModeCapability,
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
    const runtimeIdentity = normalizeSandboxRuntimeIdentity(record);

    // Use the running record's persisted profile unless the caller explicitly
    // selected another valid profile for this interactive sandbox.
    const profileResolution = resolveSeatbeltRuntimeProfile(agentName, manifest, agentPath, options, record);
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    admitSeatbeltBoundary(agentName, manifest, agentPath, options, profileResolution);
    assertHostModeGenerationCapability({
        agentId: deriveAgentPrincipalId(repoName, agentName),
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        routeKey: record.alias || agentName,
        containerName,
    });
    const routerEndpoint = resolveSeatbeltRouterEndpoint(options, profileResolution.network.mode);

    // Resolve paths
    const agentCodePath = resolveSymlinkPath(getAgentCodePath(agentName));
    const agentSkillsPath = resolveSymlinkPath(getAgentSkillsPath(agentName));
    const layout = resolveSeatbeltRuntimeLayout({
        agentName,
        alias: record.alias,
        cwd: record.projectPath || getConfiguredProjectPath(agentName, repoName, record.alias),
    });
    const { instanceName, cwd, agentWorkDir } = layout;
    ensureAgentDataDirectory(agentWorkDir);
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
    // An interactive attach receives exactly the same AgentLib grant as the
    // detached service, so a shell cannot reach a different source.
    const grant = agentLibGrant(detectHostRuntimeKey('seatbelt'));
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
    const envMap = buildFullEnvMap(agentName, manifest, profileConfig, cwd, repoName, activeProfile, 'seatbelt', runtimeResourcePlan, routerEndpoint, runtimeIdentity, grant);
    assertSeatbeltGeneratedLocalDisabled(envMap);
    const hostPort = record.config?.ports?.[0]?.hostPort;
    if (hostPort) envMap.PORT = String(hostPort);
    envMap.PLOINKY_AGENT_LIB_DIR = seatbeltAgentLibPath;
    envMap.PLOINKY_INVOCATION_AUTH_MODULE = path.join(seatbeltAgentLibPath, 'lib/invocation-auth.mjs');
    envMap.PLOINKY_CODE_DIR = agentCodePath;
    envMap.NODE_PATH = nodeModulesDir;
    applySeatbeltRuntimeEnvironment(envMap, layout);
    envMap.PATH = buildSeatbeltPathEnv();

    // Rewrite mcp-config
    const rewrittenMcpConfig = rewriteMcpConfig(agentName, agentCodePath, agentWorkDir, seatbeltAgentLibPath);
    if (rewrittenMcpConfig) {
        envMap.PLOINKY_MCP_CONFIG_PATH = rewrittenMcpConfig;
    }

    // Generate seatbelt profile
    ensureSeatbeltManifestVolumePaths(manifest, profileConfig);
    assertCanonicalAgentDataPath(agentWorkDir);
    assertCanonicalAgentDataPath(sharedDir);
    const profileContent = buildSeatbeltProfile({
        agentCodePath,
        agentLibGrant: grant,
        agentLibPath: seatbeltAgentLibPath,
        nodeModulesDir,
        agentWorkDir,
        sharedDir,
        cwd,
        skillsPath: agentSkillsPath,
        codeReadOnly,
        skillsReadOnly,
        volumes: {
            ...(manifest.volumes || {}),
            ...(profileConfig?.volumes || {}),
        },
        volumeOptions: {
            ...readManifestVolumeOptions(manifest),
            ...readManifestVolumeOptions(profileConfig),
        },
        workspaceRoot: PLOINKY_WORKSPACE_ROOT,
        extraReadPaths: getSeatbeltExtraReadPaths(),
        extraWritePaths: [
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

    assertHostModeGenerationCapability({
        agentId: deriveAgentPrincipalId(repoName, agentName),
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        routeKey: record.alias || agentName,
        containerName,
    });
    options.onReady?.();
    const result = spawnSync('sandbox-exec', ['-f', profilePath, 'sh', '-lc', `cd '${wd}' && ${rewrittenCmd}`], {
        stdio: 'inherit',
        env: envMap,
        cwd
    });
    return result.status ?? 0;
}

export {
    ensureSeatbeltService,
    resolveSeatbeltRuntimeProfile,
    startSeatbeltProcess,
    attachSeatbeltInteractive,
    rewriteMcpConfig,
    buildSeatbeltEntryCommand,
    buildSeatbeltPathEnv,
    getSeatbeltExtraReadPaths,
    ensureSeatbeltAgentLibDir,
    ensureSeatbeltCodeNodeModules,
    resolveSeatbeltRuntimeLayout,
    applySeatbeltRuntimeEnvironment,
    buildSeatbeltRuntimeBinds
};
