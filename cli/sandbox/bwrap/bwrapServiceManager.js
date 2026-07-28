import { execSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    assertManifestEnvProfileCompleteness,
    buildEnvMap,
    formatEnvFlag,
    getExposedNames,
    getManifestEnvNames,
    resolveVarValue
} from '../../utils/security/secretVars.js';
import { buildAgentIdentityEnv, stripReservedAgentEnv } from '../../utils/security/agentIdentityEnv.js';
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
import {
    CODE_DIR,
    DEPS_DIR,
    LOGS_DIR,
    PLOINKY_DIR,
    PROFILE_FILE,
    ROUTING_FILE,
    SECRETS_FILE,
    SERVERS_CONFIG_FILE,
    PLOINKY_WORKSPACE_ROOT
} from '../../utils/config.js';
import {
    planRuntimeResources,
    applyRuntimeResourceEnv,
    ensurePersistentStorageHostDir
} from '../../utils/runtime/runtimeResourcePlanner.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
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
    assertBwrapPidSlotAvailable,
    isBwrapProcessRunning,
    normalizeSandboxRuntimeIdentity,
    stopBwrapProcess,
    saveBwrapPid,
    clearBwrapPid,
    getBwrapPid
} from './bwrapFleet.js';
import {
    ensureManifestVolumeHostPath,
    readManifestVolumeOptions,
    resolveManifestVolumeHostPath
} from '../../utils/runtime/manifestVolumePolicy.js';
import { assertRouterEndpoint, selectedRouterHostPort } from '../routerPort.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_LIB_PATH = path.resolve(__dirname, '../../../Agent');
const AGENT_PRIVATE_KEY_CONTAINER_PATH = '/run/ploinky-agent.key';

const BWRAP_PATH = '/usr/bin/bwrap';

function resolveBwrapRuntimeProfile(agentName, manifest, agentPath, options = {}, existingRecord = {}) {
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
        runtime: 'bwrap',
    });
    return resolution;
}

function resolveSandboxRouterEndpoint(options = {}, networkMode = 'host') {
    if (options && typeof options === 'object' && Object.prototype.hasOwnProperty.call(options, 'routerHost')) {
        throw new Error('routerHost overrides are not supported; pass the validated routerEndpoint');
    }
    return assertRouterEndpoint(options?.routerEndpoint, networkMode, { explicitPort: options?.routerPort });
}

function resolveBwrapAgentNodeModules({
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
        family: 'bwrap',
        repoName,
        agentName,
        agentCodePath,
    });
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

function isSameOrInside(candidate, parent) {
    if (!candidate || !parent) return false;
    const resolvedCandidate = path.resolve(candidate);
    const resolvedParent = path.resolve(parent);
    const relative = path.relative(resolvedParent, resolvedCandidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function addReadOnlyOverlay(args, hostPath, cwd, seen) {
    if (!hostPath || !isSameOrInside(hostPath, cwd) || !fs.existsSync(hostPath)) return;
    const resolved = path.resolve(hostPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    args.push('--ro-bind', resolved, resolved);
}

function addProtectedWorkspaceOverlays(args, options) {
    const {
        agentCodePath,
        nodeModulesDir,
        cwd,
        codeReadOnly,
    } = options;
    const seen = new Set();
    const nodeModulesParent = nodeModulesDir ? path.dirname(nodeModulesDir) : '';

    addReadOnlyOverlay(args, DEPS_DIR, cwd, seen);
    addReadOnlyOverlay(args, nodeModulesParent, cwd, seen);
    addReadOnlyOverlay(args, path.join(agentCodePath || '', 'node_modules'), cwd, seen);
    addReadOnlyOverlay(args, CODE_DIR, cwd, seen);
    addReadOnlyOverlay(args, path.join(PLOINKY_DIR, 'seatbelt-runtime'), cwd, seen);
    addReadOnlyOverlay(args, SECRETS_FILE, cwd, seen);
    addReadOnlyOverlay(args, PROFILE_FILE, cwd, seen);
    addReadOnlyOverlay(args, ROUTING_FILE, cwd, seen);
    addReadOnlyOverlay(args, SERVERS_CONFIG_FILE, cwd, seen);

    if (codeReadOnly) {
        addReadOnlyOverlay(args, agentCodePath, cwd, seen);
    }
}

/**
 * Build the bwrap argument array for running a Node.js agent in a sandbox.
 */
function buildBwrapArgs(options) {
    const {
        agentCodePath,
        agentLibPath,
        nodeModulesDir,
        sharedDir,
        cwd,
        skillsPath,
        envMap,
        codeReadOnly,
        skillsReadOnly,
        volumes,
        agentPrivateKeyPath
    } = options;

    const args = [];

    // System libraries (read-only)
    args.push('--ro-bind', '/usr', '/usr');
    if (fs.existsSync('/lib')) args.push('--ro-bind', '/lib', '/lib');
    if (fs.existsSync('/lib64')) args.push('--ro-bind', '/lib64', '/lib64');

    // /bin and /sbin — could be real dirs or symlinks to /usr/bin
    try {
        const binStat = fs.lstatSync('/bin');
        if (binStat.isSymbolicLink()) {
            args.push('--symlink', fs.readlinkSync('/bin'), '/bin');
        } else {
            args.push('--ro-bind', '/bin', '/bin');
        }
    } catch (_) {
        args.push('--symlink', 'usr/bin', '/bin');
    }
    try {
        const sbinStat = fs.lstatSync('/sbin');
        if (sbinStat.isSymbolicLink()) {
            args.push('--symlink', fs.readlinkSync('/sbin'), '/sbin');
        } else {
            args.push('--ro-bind', '/sbin', '/sbin');
        }
    } catch (_) {
        args.push('--symlink', 'usr/sbin', '/sbin');
    }

    // Essential /etc files (read-only)
    const etcFiles = [
        '/etc/resolv.conf', '/etc/hosts', '/etc/passwd', '/etc/group',
        '/etc/nsswitch.conf', '/etc/ld.so.cache'
    ];
    for (const f of etcFiles) {
        if (fs.existsSync(f)) args.push('--ro-bind', f, f);
    }
    // SSL/TLS certificates and other /etc directories
    const etcDirs = ['/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/alternatives', '/etc/crypto-policies'];
    for (const d of etcDirs) {
        if (fs.existsSync(d)) args.push('--ro-bind', d, d);
    }

    // Special filesystems
    args.push('--proc', '/proc');
    args.push('--dev', '/dev');
    args.push('--tmpfs', '/tmp');

    // Agent library (always read-only)
    args.push('--ro-bind', agentLibPath, '/Agent');

    // Agent code (rw in dev, ro in qa/prod)
    if (codeReadOnly) {
        args.push('--ro-bind', agentCodePath, '/code');
    } else {
        args.push('--bind', agentCodePath, '/code');
    }

    // node_modules — read-only prepared cache (see ploinky/cli/utils/dependencies/dependencyCache.js).
    // Mounted at both paths so AgentServer.mjs (/Agent/server/) can resolve modules.
    args.push('--ro-bind', nodeModulesDir, '/code/node_modules');
    args.push('--ro-bind', nodeModulesDir, '/Agent/node_modules');

    // Shared directory
    args.push('--bind', sharedDir, '/shared');

    if (agentPrivateKeyPath && fs.existsSync(agentPrivateKeyPath)) {
        args.push('--ro-bind', agentPrivateKeyPath, AGENT_PRIVATE_KEY_CONTAINER_PATH);
    }

    // CWD passthrough (workspace agent dir)
    args.push('--bind', cwd, cwd);

    // Skills directory (if exists)
    if (skillsPath && fs.existsSync(skillsPath)) {
        if (skillsReadOnly) {
            args.push('--ro-bind', skillsPath, '/code/skills');
        } else {
            args.push('--bind', skillsPath, '/code/skills');
        }
    }

    // Custom volumes from manifest
    if (volumes && typeof volumes === 'object') {
        const volumeOptions = options.volumeOptions || {};
        for (const [hostPath, containerPath] of Object.entries(volumes)) {
            const resolvedHostPath = resolveManifestVolumeHostPath(hostPath);
            const mountOptions = volumeOptions[containerPath]
                || volumeOptions[String(containerPath || '').replace(/\/+$/, '')]
                || {};
            ensureManifestVolumeHostPath(resolvedHostPath, containerPath, mountOptions);
            args.push(mountOptions.readOnly === true ? '--ro-bind' : '--bind', resolvedHostPath, containerPath);
        }
    }

    // Runtime-resources persistent storage (declarative, provider-agnostic)
    if (options.runtimeResourcePlan && options.runtimeResourcePlan.persistentStorage) {
        const ps = options.runtimeResourcePlan.persistentStorage;
        ensurePersistentStorageHostDir(options.runtimeResourcePlan);
        args.push('--bind', ps.hostPath, ps.containerPath);
    }

    addProtectedWorkspaceOverlays(args, {
        agentCodePath,
        nodeModulesDir,
        cwd,
        codeReadOnly,
    });

    // Process isolation — do NOT unshare network (agents need host network)
    // NOTE: --die-with-parent is intentionally omitted. Agent processes must survive
    // the ploinky CLI exit (daemon mode). Cleanup is handled by ploinky stop/destroy
    // and the containerMonitor.
    // NOTE: --new-session is intentionally omitted. It creates a new PGID for the sandbox
    // child process, making process group kills miss the children. --unshare-pid already
    // provides PID namespace isolation which prevents sandbox processes from signaling
    // host processes.
    args.push('--unshare-pid');

    // Environment: clear all, then set explicitly
    args.push('--clearenv');
    for (const [key, value] of Object.entries(envMap || {})) {
        if (value !== undefined && value !== null) {
            args.push('--setenv', key, String(value));
        }
    }

    // Working directory
    args.push('--chdir', '/code');

    return args;
}

/**
 * Build the full environment map for a bwrap agent.
 * Mirrors the env construction in startAgentContainer.
 */
function buildFullEnvMap(agentName, manifest, profileConfig, agentWorkDir, repoName, activeProfile, runtimeName = 'bwrap', runtimeResourcePlan = null, routerEndpoint = undefined, runtimeIdentity = undefined) {
    const endpoint = assertRouterEndpoint(routerEndpoint, 'host');

    // Start with manifest env vars (resolved from secrets)
    const env = buildEnvMap(manifest, profileConfig, { agentName, repoName, forRuntime: true });

    // Ploinky internal vars
    env.PLOINKY_MCP_CONFIG_PATH = CONTAINER_CONFIG_PATH;
    env.AGENT_NAME = agentName;
    env.WORKSPACE_PATH = agentWorkDir;
    env.PLOINKY_WORKSPACE_ROOT = PLOINKY_WORKSPACE_ROOT;
    env.PLOINKY_RUNTIME = runtimeName;

    // Manifest-declared runtime.resources.env (post template expansion).
    if (runtimeResourcePlan) {
        const resourceEnv = applyRuntimeResourceEnv(runtimeResourcePlan);
        for (const [k, v] of Object.entries(resourceEnv)) {
            env[k] = v;
        }
    }

    // Per-agent identity is asserted LAST (below), after all config layers, so it
    // cannot be overridden by profile/manifest/secret env.

    // Profile env vars
    const profileEnv = profileConfig?.env;
    if (profileEnv && typeof profileEnv === 'object' && !Array.isArray(profileEnv)) {
        for (const [key, value] of Object.entries(profileEnv)) {
            if (key && value !== undefined && typeof value !== 'object' && !Object.prototype.hasOwnProperty.call(env, key)) {
                env[key] = String(value);
            }
        }
    }

    // System profile env vars
    const profileEnvVars = getProfileEnvVars(agentName, repoName, activeProfile, {
        containerName: `bwrap_${agentName}`,
        containerId: `bwrap_${agentName}`
    });
    if (profileEnvVars && typeof profileEnvVars === 'object') {
        for (const [key, value] of Object.entries(profileEnvVars)) {
            if (key) env[key] = value ?? '';
        }
    }

    // SSO client credentials
    const agentClientIdVar = `PLOINKY_AGENT_${agentName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_ID`;
    const agentClientSecretVar = `PLOINKY_AGENT_${agentName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_SECRET`;
    const agentClientId = resolveVarValue(agentClientIdVar) || resolveVarValue('PLOINKY_AGENT_CLIENT_ID');
    const agentClientSecret = resolveVarValue(agentClientSecretVar) || resolveVarValue('PLOINKY_AGENT_CLIENT_SECRET');
    if (agentClientId) env.PLOINKY_AGENT_CLIENT_ID = agentClientId;
    if (agentClientSecret) env.PLOINKY_AGENT_CLIENT_SECRET = agentClientSecret;

    // Profile secrets
    if (profileConfig?.secrets && profileConfig.secrets.length > 0) {
        const secretValidation = validateSecrets(profileConfig.secrets);
        if (!secretValidation.valid) {
            throw new Error(formatMissingSecretsError(secretValidation.missing, activeProfile));
        }
        const profileSecrets = getSecrets(profileConfig.secrets);
        if (profileSecrets) {
            for (const [key, value] of Object.entries(profileSecrets)) {
                if (key) env[key] = value ?? '';
            }
        }
    }

    // Essential system vars
    env.NODE_PATH = '/code/node_modules';
    env.HOME = agentWorkDir;
    env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

    // Final, authoritative agent identity (DS013): strip any reserved name a
    // config layer may have set (master keys, or an identity override) and assert
    // this agent's id + derived secret last so nothing can override them.
    stripReservedAgentEnv(env);
    const exactRuntimeIdentity = runtimeIdentity === undefined
        ? undefined
        : normalizeSandboxRuntimeIdentity(runtimeIdentity);
    Object.assign(
        env,
        buildAgentIdentityEnv(
            deriveAgentPrincipalId(repoName, agentName),
            exactRuntimeIdentity,
        ),
    );

    // Router discovery is a runtime contract, not user configuration. Assert it
    // after every manifest, profile, environment, and secret layer.
    Object.assign(env, endpoint.env);
    env.PLOINKY_ROUTER_AUTHORITY = `127.0.0.1:${selectedRouterHostPort()}`;

    return env;
}

/**
 * Build the shell command that runs inside the bwrap sandbox.
 *
 * No runtime `npm install` — dependencies are prepared on the host
 * via `prepareAgentCache` and mounted read-only at /code/node_modules.
 * Only manifest-declared install hooks run here.
 */
function buildBwrapEntryCommand(agentName, manifest, profileConfig) {
    const { raw: explicitAgentCmd } = readManifestAgentCommand(manifest);
    const startCmd = readManifestStartCommand(manifest);
    const useStartEntry = Boolean(startCmd);

    const manifestInstallCmd = String(profileConfig?.install || manifest?.install || '').trim();

    let entryCmd;
    if (useStartEntry && explicitAgentCmd) {
        entryCmd = manifestInstallCmd
            ? `cd /code && ${manifestInstallCmd} && (${startCmd} &) && exec ${explicitAgentCmd}`
            : `cd /code && (${startCmd} &) && exec ${explicitAgentCmd}`;
    } else if (useStartEntry) {
        entryCmd = manifestInstallCmd
            ? `cd /code && ${manifestInstallCmd} && ${startCmd}`
            : `cd /code && ${startCmd}`;
    } else if (explicitAgentCmd) {
        entryCmd = manifestInstallCmd
            ? `cd /code && ${manifestInstallCmd} && ${explicitAgentCmd}`
            : `cd /code && ${explicitAgentCmd}`;
    } else {
        entryCmd = manifestInstallCmd
            ? `${manifestInstallCmd} && sh /Agent/server/AgentServer.sh`
            : 'sh /Agent/server/AgentServer.sh';
    }

    return entryCmd;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildShellCommand(argv) {
    return argv.map((arg) => shellQuote(arg)).join(' ');
}

function buildBwrapInteractiveCommand(workdir, entryCommand, options = {}) {
    const wd = workdir || '/code';
    const rawCommand = entryCommand && String(entryCommand).trim()
        ? String(entryCommand).trim()
        : 'exec /bin/bash || exec /bin/sh';
    const command = options.forceInteractiveShell && rawCommand === '/bin/sh'
        ? 'if command -v /bin/bash >/dev/null 2>&1; then exec /bin/bash -i; else exec /bin/sh -i; fi'
        : rawCommand;
    return `cd ${shellQuote(wd)} && ${command}`;
}

function sanitizeHistoryName(value) {
    return String(value || 'agent').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function spawnBwrapInteractive(bwrapArgs, options = {}) {
    const usePty = options.usePty === true;
    const scriptPath = '/usr/bin/script';
    if (usePty && fs.existsSync(scriptPath)) {
        const command = buildShellCommand([BWRAP_PATH, ...bwrapArgs]);
        return spawnSync(scriptPath, ['-qfec', command, '/dev/null'], { stdio: 'inherit' });
    }
    return spawnSync(BWRAP_PATH, bwrapArgs, { stdio: 'inherit' });
}

/**
 * Start a bwrap-sandboxed agent process.
 */
function startBwrapProcess(agentName, manifest, agentPath, options = {}) {
    const repoName = path.basename(path.dirname(agentPath));
    const alias = options.alias;
    const containerName = options.containerName || getAgentContainerName(agentName, repoName);
    const runtimeIdentity = normalizeSandboxRuntimeIdentity(options);
    assertBwrapPidSlotAvailable(containerName);
    const cwd = getConfiguredProjectPath(agentName, repoName, alias);
    const sharedDir = ensureSharedHostDir();

    // Profile and network are resolved atomically before any sandbox work.
    const profileRecord = loadAgentsMap()[containerName] || {};
    const profileResolution = resolveBwrapRuntimeProfile(agentName, manifest, agentPath, options, profileRecord);
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    const routerEndpoint = resolveSandboxRouterEndpoint(options, profileResolution.network.mode);

    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const envHash = computeEnvHash(manifest, profileConfig, routerEndpoint.env, { agentName, repoName });
    const { codeReadOnly, skillsReadOnly } = getProfileMountModes(activeProfile, profileConfig || {});

    // Resolve paths
    const agentCodePath = resolveSymlinkPath(getAgentCodePath(agentName));
    const agentSkillsPath = resolveSymlinkPath(getAgentSkillsPath(agentName));
    const agentWorkDir = cwd;
    const runtimeResourcePlan = planRuntimeResources(manifest, { agentName, repoName });

    // Pre-container lifecycle (workspace init, symlinks, preinstall HOST hook)
    const preLifecycle = runPreContainerLifecycle(agentName, repoName, agentPath, activeProfile);
    if (!preLifecycle.success) {
        throw new Error(`[profile] ${agentName}: pre-container lifecycle failed: ${preLifecycle.errors.join('; ')}`);
    }

    // Ensure work directory and MCP config
    fs.mkdirSync(agentWorkDir, { recursive: true });
    syncAgentMcpConfig(containerName, path.resolve(agentPath), alias || agentName, { workDir: agentWorkDir });

    // Prepare node dependencies via prepared cache (see dependencyCache.js).
    // Non-Node agents (start-only, no package.json) still get an empty
    // node_modules so the mount resolves.
    const agentHasPackageJson = fs.existsSync(path.join(agentCodePath, 'package.json'));
    const startCmd = readManifestStartCommand(manifest);
    const needsCoreDeps = !startCmd || agentHasPackageJson;
    const nodeModulesDir = resolveBwrapAgentNodeModules({
        repoName,
        agentName,
        agentCodePath,
        agentWorkDir,
        needsCoreDeps,
    });

    // Port resolution — with shared host network, hostPort === containerPort
    // Must happen before env map so PORT is set correctly
    const { portMappings } = parseManifestPorts(manifest, profileConfig);
    let allPortMappings = [...portMappings];
    if (!allPortMappings.length) {
        const existingAgents = loadAgentsMap();
        const existingRecord = existingAgents[containerName] || {};
        const hostPort = options.preferredHostPort || existingRecord?.config?.ports?.[0]?.hostPort || (10000 + Math.floor(Math.random() * 50000));
        allPortMappings = [{ containerPort: hostPort, hostPort }];
    }
    const hostPort = allPortMappings[0]?.hostPort;

    // Build environment map
    const envMap = buildFullEnvMap(agentName, manifest, profileConfig, agentWorkDir, repoName, activeProfile, 'bwrap', runtimeResourcePlan, routerEndpoint, runtimeIdentity);
    const agentPrivateKeyPath = envMap.__PLOINKY_AGENT_PRIVATE_KEY_HOST_PATH || '';
    delete envMap.__PLOINKY_AGENT_PRIVATE_KEY_HOST_PATH;

    // Set PORT env var so the agent binds to the correct host port
    if (hostPort) {
        envMap.PORT = String(hostPort);
    }

    // Build bwrap arguments
    const bwrapArgs = buildBwrapArgs({
        agentCodePath,
        agentLibPath: AGENT_LIB_PATH,
        nodeModulesDir,
        sharedDir,
        cwd,
        skillsPath: agentSkillsPath,
        envMap,
        codeReadOnly,
        skillsReadOnly,
        volumes: manifest.volumes,
        volumeOptions: readManifestVolumeOptions(manifest),
        runtimeResourcePlan,
        agentPrivateKeyPath
    });

    // Build the entry command
    const entryCmd = buildBwrapEntryCommand(agentName, manifest, profileConfig);

    // Add the command to run
    bwrapArgs.push('--', 'sh', '-c', entryCmd);

    // Ensure logs directory exists
    const logsDir = LOGS_DIR;
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFile = path.join(logsDir, `${agentName}-bwrap.log`);

    console.log(`[bwrap] ${agentName}: starting sandbox (profile=${activeProfile}, cwd='${cwd}')`);
    debugLog(`[bwrap] ${agentName}: entry command: sh -c "${entryCmd}"`);
    debugLog(`[bwrap] ${agentName}: log file: ${logFile}`);

    // Spawn detached bwrap process
    const logFd = fs.openSync(logFile, 'a');
    const child = spawn(BWRAP_PATH, bwrapArgs, {
        detached: true,
        stdio: ['ignore', logFd, logFd]
    });
    child.unref();
    fs.closeSync(logFd);

    if (!child.pid) {
        throw new Error(`[bwrap] ${agentName}: failed to spawn bwrap process`);
    }

    // Wait briefly and verify the process didn't crash immediately
    // (e.g. AppArmor blocking user namespaces, missing dependencies)
    // Detached+unref'd processes become zombies when they die, so kill -0
    // still returns true. Check /proc/PID/status for zombie state instead.
    spawnSync('sleep', ['0.5']);
    let processAlive = false;
    try {
        const statusContent = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
        const stateLine = statusContent.split('\n').find(l => l.startsWith('State:')) || '';
        processAlive = !stateLine.includes('Z (zombie)');
    } catch {
        processAlive = false;  // /proc/PID gone = process fully reaped
    }
    if (!processAlive) {
        // Process died — read the log for the error message
        let reason = 'unknown error';
        try {
            const logContent = fs.readFileSync(logFile, 'utf8').trim();
            const lastLine = logContent.split('\n').pop();
            if (lastLine) reason = lastLine;
        } catch {}
        throw new Error(`bwrap process exited immediately: ${reason}`);
    }

    // Save PID
    try {
        saveBwrapPid(containerName, child.pid, runtimeIdentity);
    } catch (error) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { }
        try { process.kill(child.pid, 'SIGKILL'); } catch (_) { }
        throw error;
    }
    console.log(`[bwrap] ${agentName}: started with PID ${child.pid}`);

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
        runtime: 'bwrap',
        pid: child.pid,
        containerImage: 'host (bwrap)',
        envHash,
        createdAt: existingRecord.createdAt || new Date().toISOString(),
        projectPath: cwd,
        runMode: existingRecord.runMode,
        develRepo: existingRecord.develRepo,
        profile: activeProfile,
        type: 'agent',
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        config: {
            binds: [
                { source: AGENT_LIB_PATH, target: '/Agent', ro: true },
                { source: agentCodePath, target: '/code', ro: codeReadOnly },
                { source: sharedDir, target: '/shared' },
                ...(fs.existsSync(agentSkillsPath) ? [{ source: agentSkillsPath, target: '/skills', ro: skillsReadOnly }] : []),
                { source: cwd, target: cwd }
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

    // Run profile lifecycle hooks (hosthook_aftercreation, postinstall HOST hooks)
    // Note: install hooks run inside the bwrap entrypoint, not via podman exec
    try {
        if (profileConfig) {
            const lifecycleResult = runProfileLifecycle(agentName, activeProfile, {
                containerName,
                agentPath,
                repoName,
                manifest,
                skipInstallHooks: true  // Install runs inside bwrap entrypoint
            });
            if (!lifecycleResult.success) {
                const details = lifecycleResult.errors.join('; ');
                console.warn(`[bwrap] ${agentName}: lifecycle warning: ${details}`);
            }
        }
    } catch (error) {
        console.warn(`[bwrap] ${agentName}: lifecycle hook error: ${error.message}`);
    }

    syncAgentMcpConfig(containerName, path.resolve(agentPath), agentName);

    const returnPort = allPortMappings.find((p) => p.containerPort === 7000)?.hostPort || allPortMappings[0]?.hostPort || 0;
    return {
        containerName,
        hostPort: returnPort,
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
 * Returns { containerName, hostPort } matching the shape from ensureAgentService.
 */
function ensureBwrapService(agentName, manifest, agentPath, options = {}) {
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

    // Profile config and host-network compatibility are validated even when the
    // existing sandbox can otherwise be reused.
    const profileResolution = resolveBwrapRuntimeProfile(agentName, manifest, agentPath, {
        ...(options && typeof options === 'object' ? options : {}),
        profileName: profileNameOverride,
    }, existingRecord);
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    const routerEndpoint = resolveSandboxRouterEndpoint(options, profileResolution.network.mode);

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
        console.log(`[bwrap] ${agentName}: force recreating...`);
        stopBwrapProcess(containerName);
        exactRuntimeRunning = false;
    }

    if (!forceRecreate && !exactRuntimeRunning && stopBwrapProcess(containerName)) {
        console.log(`[bwrap] ${agentName}: runtime generation changed, replacing stale sandbox...`);
    }

    // Check if already running
    if (exactRuntimeRunning) {
        // Compare env hash
        const desired = computeEnvHash(manifest, profileConfig, routerEndpoint.env, { agentName, repoName });
        const current = existingRecord.envHash || '';
        if (desired && desired !== current) {
            console.log(`[bwrap] ${agentName}: env hash changed, restarting...`);
            stopBwrapProcess(containerName);
        } else {
            debugLog(`[bwrap] ${agentName}: already running (PID ${getBwrapPid(containerName, runtimeIdentity)})`);
            const hostPort = allPortMappings[0]?.hostPort || 0;
            syncAgentMcpConfig(containerName, agentPath, agentName);
            return {
                containerName,
                hostPort,
                registryRecord: structuredClone(existingRecord),
            };
        }
    }

    // Start the process
    return startBwrapProcess(agentName, manifest, agentPath, {
        preferredHostPort: allPortMappings[0]?.hostPort,
        containerName,
        alias: aliasOverride,
        profileName: activeProfile,
        profileResolution,
        routerEndpoint,
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        preservePreparedRegistryRecord: options.preservePreparedRegistryRecord,
    });
}

/**
 * Spawn an interactive bwrap session (for `ploinky cli` / `ploinky shell`).
 * Creates a NEW bwrap sandbox with the same mount layout as the running agent,
 * but runs the given command instead of the agent server.
 * Uses --die-with-parent so the session is cleaned up when the parent exits.
 */
function attachBwrapInteractive(agentName, manifest, agentPath, workdir, entryCommand, options = {}) {
    const repoName = path.basename(path.dirname(agentPath));
    const containerName = options.containerName || getAgentContainerName(agentName, repoName);
    const agents = loadAgentsMap();
    const record = agents[containerName];

    if (!record || record.runtime !== 'bwrap') {
        throw new Error(`[bwrap] ${agentName}: not running as bwrap agent`);
    }
    const runtimeIdentity = normalizeSandboxRuntimeIdentity(record);

    // Use the running record's persisted profile unless the caller explicitly
    // selected another valid profile for this interactive sandbox.
    const profileResolution = resolveBwrapRuntimeProfile(agentName, manifest, agentPath, options, record);
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    const routerEndpoint = resolveSandboxRouterEndpoint(options, profileResolution.network.mode);

    // Resolve paths
    const agentCodePath = resolveSymlinkPath(getAgentCodePath(agentName));
    const agentSkillsPath = resolveSymlinkPath(getAgentSkillsPath(agentName));
    const agentWorkDir = record.projectPath || getAgentWorkDir(agentName);
    const sharedDir = ensureSharedHostDir();
    const agentHasPackageJson = fs.existsSync(path.join(agentCodePath, 'package.json'));
    const startCmd = readManifestStartCommand(manifest);
    const needsCoreDeps = !startCmd || agentHasPackageJson;
    const nodeModulesDir = resolveBwrapAgentNodeModules({
        repoName,
        agentName,
        agentCodePath,
        agentWorkDir,
        needsCoreDeps,
    });
    const { codeReadOnly, skillsReadOnly } = getProfileMountModes(activeProfile, profileConfig || {});

    // Build environment (same as running agent)
    const runtimeResourcePlan = planRuntimeResources(manifest, { agentName, repoName });
    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const envMap = buildFullEnvMap(agentName, manifest, profileConfig, agentWorkDir, repoName, activeProfile, 'bwrap', runtimeResourcePlan, routerEndpoint, runtimeIdentity);
    const agentPrivateKeyPath = envMap.__PLOINKY_AGENT_PRIVATE_KEY_HOST_PATH || '';
    delete envMap.__PLOINKY_AGENT_PRIVATE_KEY_HOST_PATH;
    const hostPort = record.config?.ports?.[0]?.hostPort;
    if (hostPort) envMap.PORT = String(hostPort);
    const forceInteractiveShell = entryCommand && String(entryCommand).trim() === '/bin/sh' && process.stdin.isTTY;
    if (forceInteractiveShell) {
        for (const key of ['TERM', 'COLORTERM', 'LINES', 'COLUMNS']) {
            if (process.env[key]) envMap[key] = process.env[key];
        }
        envMap.HISTFILE = `/shared/.ploinky-${sanitizeHistoryName(agentName)}-shell-history`;
        envMap.HISTSIZE = '5000';
        envMap.HISTFILESIZE = '10000';
        envMap.PS1 = '$ ';
    }

    // Build bwrap args (same mounts as the running agent)
    const bwrapArgs = buildBwrapArgs({
        agentCodePath,
        agentLibPath: AGENT_LIB_PATH,
        nodeModulesDir,
        sharedDir,
        cwd: record.projectPath || agentWorkDir,
        skillsPath: agentSkillsPath,
        envMap,
        codeReadOnly,
        skillsReadOnly,
        volumes: manifest.volumes,
        volumeOptions: readManifestVolumeOptions(manifest),
        runtimeResourcePlan,
        agentPrivateKeyPath
    });

    // For interactive sessions, die-with-parent IS appropriate
    // (unlike daemon agents which must outlive the CLI)
    bwrapArgs.push('--die-with-parent');

    // Build command
    const shellCommand = buildBwrapInteractiveCommand(workdir, entryCommand, { forceInteractiveShell });
    bwrapArgs.push('--', 'sh', '-lc', shellCommand);

    debugLog(`[bwrap] ${agentName}: interactive session: sh -lc ${JSON.stringify(shellCommand)}`);

    const result = spawnBwrapInteractive(bwrapArgs, { usePty: process.stdin.isTTY });
    return result.status ?? 0;
}

export {
    ensureBwrapService,
    resolveBwrapRuntimeProfile,
    startBwrapProcess,
    buildBwrapArgs,
    buildFullEnvMap,
    buildBwrapInteractiveCommand,
    buildShellCommand,
    attachBwrapInteractive,
    BWRAP_PATH
};
