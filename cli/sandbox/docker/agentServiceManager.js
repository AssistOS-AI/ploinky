import { execFileSync, execSync, spawnSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import net from 'node:net';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    assertManifestEnvProfileCompleteness,
    buildEnvFlags,
    formatEnvFlag,
    getExposedNames,
    getManifestEnvNames,
    resolveManifestImage,
    resolveVarValue
} from '../../utils/security/secretVars.js';
import { buildAgentIdentityEnv, RESERVED_AGENT_ENV_NAMES } from '../../utils/security/agentIdentityEnv.js';
import { debugLog } from '../../utils/utils.js';
import {
    CONTAINER_CONFIG_PATH,
    containerExists,
    computeEnvHash,
    createHostSandboxStartupError,
    flagsToArgs,
    getAgentContainerName,
    getConfiguredProjectPath,
    getContainerLabel,
    getRuntime,
    getRuntimeForAgent,
    isContainerRunning,
    isSandboxRuntime,
    loadAgentsMap,
    saveAgentsMap,
    syncAgentMcpConfig
} from './common.js';
import { clearLivenessState } from './healthProbes.js';
import { stopAndRemove } from './containerFleet.js';
import { buildContainerSecurityArgs, resolveContainerSecurity } from './containerSecurity.js';
import { DEFAULT_AGENT_ENTRY, launchAgentSidecar, readManifestAgentCommand, readManifestStartCommand, splitCommandArgs } from './agentCommands.js';
import { AGENTS_DATA_DIR, PLOINKY_DIR, ROUTING_FILE, PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import {
    planRuntimeResources,
    applyRuntimeResourceEnv,
    ensurePersistentStorageHostDir
} from '../../utils/runtime/runtimeResourcePlanner.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { ensureSharedHostDir, runPostinstallHook } from './agentHooks.js';
import { ensureBwrapService } from '../bwrap/bwrapServiceManager.js';
import { ensureSeatbeltService } from '../seatbelt/seatbeltServiceManager.js';
import { detectShellForImage, SHELL_FALLBACK_DIRECT } from './shellDetection.js';
import { detectRuntimeKeyForAgent } from '../../utils/dependencies/dependencyRuntimeKey.js';
import { nodeModulesDir, prepareAgentCache } from '../../utils/dependencies/dependencyCache.js';
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
import {
    getAgentWorkDir,
    getAgentCodePath,
    getAgentSkillsPath
} from '../../utils/workspaceStructure.js';
import {
    prepareFreshRuntimeRoot,
    runtimeSegment
} from '../../utils/runtime/runtimeStaging.js';
import {
    ensureManifestVolumeHostPath,
    readManifestVolumeOptions,
    resolveManifestVolumeHostPath
} from '../../utils/runtime/manifestVolumePolicy.js';
import {
    isLlmRuntimeManifest,
    prepareLlmStartup,
} from './llmRuntimeIntegration.js';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_LIB_PATH = path.resolve(__dirname, '../../../Agent');
const LLM_RUNTIME_SHARED_PATH = path.join(PLOINKY_WORKSPACE_ROOT, 'llm-runtime', 'shared');
function resolveLlmRuntimeSharedPath(agentPath) {
    // Prefer the shared runtime that ships inside the agent's own repo so
    // clone-based deploys (llm-runtime under .ploinky/repos) mount the real
    // runtime-agent; fall back to the workspace-root sibling (dev layout).
    try {
        const repoShared = path.join(path.dirname(agentPath), 'shared');
        if (fs.existsSync(path.join(repoShared, 'runtime-agent'))) return repoShared;
    } catch (_) { /* fall through to dev-layout default */ }
    return LLM_RUNTIME_SHARED_PATH;
}
const AGENT_PRIVATE_KEY_CONTAINER_PATH = '/run/ploinky-agent.key';
const PODMAN_STAGED_NODE_OPTIONS = ['--preserve-symlinks', '--preserve-symlinks-main'];
const PODMAN_RUNTIME_ROOT = path.join(PLOINKY_DIR, 'container-runtime');
const BOX_TRANSPORT_PATH = '/run/ploinky/box-transport.json';

function inspectRuntimeIdentity(runtime, containerName) {
    const parsed = JSON.parse(execFileSync(runtime, ['inspect', containerName], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
    }));
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    const containerId = String(record?.Id || record?.ID || '').trim().toLowerCase();
    const networkMode = String(record?.HostConfig?.NetworkMode || record?.NetworkSettings?.NetworkMode || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(containerId) || !networkMode) {
        throw new Error(`[runtime] ${containerName}: incomplete immutable container identity`);
    }
    return { containerId, networkMode };
}

function hasReusableRuntimeIdentity(existingRecord, runtime, runtimeIdentity, targetAgentId) {
    const recordedContainerId = String(existingRecord?.containerId || '').trim().toLowerCase();
    const recordedNetworkMode = String(existingRecord?.networkMode || '').trim().toLowerCase();
    return existingRecord?.type === 'agent'
        && existingRecord?.runtime === runtime
        && recordedContainerId === runtimeIdentity.containerId
        && recordedNetworkMode === runtimeIdentity.networkMode
        && existingRecord?.targetAgentId === targetAgentId
        && Boolean(String(existingRecord?.enableGeneration || '').trim())
        && Boolean(String(existingRecord?.effectiveInstanceId || '').trim());
}

function validServicePort(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    const port = Number.parseInt(text, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function resolveRuntimePrimaryService(manifest, profileConfig = null) {
    const startCommand = readManifestStartCommand(manifest);
    const agentCommand = readManifestAgentCommand(manifest).raw;
    if (!startCommand || agentCommand) return { port: 7000 };

    const portSetting = profileConfig?.env?.PORT;
    const profilePort = validServicePort(
        portSetting && typeof portSetting === 'object' ? portSetting.default : portSetting,
    );
    return profilePort ? { port: profilePort } : null;
}

function manifestHasRuntimePrimaryService(manifest, profileConfig = null) {
    return Boolean(resolveRuntimePrimaryService(manifest, profileConfig));
}

function manifestNeedsCoreDependencies(manifest, profileConfig = null, options = {}) {
    const hasStartCommand = Boolean(readManifestStartCommand(manifest));
    return !hasStartCommand
        || options.agentHasPackageJson === true
        || options.llmRuntime === true
        || manifestHasRuntimePrimaryService(manifest, profileConfig);
}

function buildRuntimeServiceDescriptor({
    runtime,
    containerName,
    agentName,
    repoName,
    manifest,
    profileConfig = null,
    existingRecord = {},
}) {
    const { containerId, networkMode } = inspectRuntimeIdentity(runtime, containerName);
    const targetAgentId = deriveAgentPrincipalId(repoName, agentName);
    const enableGeneration = String(existingRecord.enableGeneration || randomUUID());
    const effectiveInstanceId = String(existingRecord.effectiveInstanceId || `${targetAgentId}@${enableGeneration}`);
    const confined = networkMode !== 'host' && networkMode !== 'none';
    return {
        containerName,
        runtime,
        containerId,
        networkMode,
        targetAgentId,
        effectiveInstanceId,
        enableGeneration,
        relay: confined ? {
            kind: 'container-exec-stdio',
            runtime,
            containerId,
            containerName,
            targetAgentId,
            effectiveInstanceId,
            networkMode,
        } : null,
        primaryService: resolveRuntimePrimaryService(manifest, profileConfig),
    };
}

function buildUnconfinedServiceDescriptor(runtime, started, agentName, repoName) {
    const existingRecord = loadAgentsMap()[started.containerName] || {};
    const targetAgentId = deriveAgentPrincipalId(repoName, agentName);
    const enableGeneration = String(existingRecord.enableGeneration || randomUUID());
    return {
        ...started,
        runtime,
        networkMode: 'host',
        targetAgentId,
        enableGeneration,
        effectiveInstanceId: String(existingRecord.effectiveInstanceId || `${targetAgentId}@${enableGeneration}`),
        relay: null,
        primaryService: null,
    };
}

function pathTypeForSymlink(sourcePath) {
    try {
        return fs.statSync(sourcePath).isDirectory() ? 'dir' : 'file';
    } catch (_) {
        return 'file';
    }
}

function normalizeStagedRelPath(relPath) {
    return String(relPath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
}

function hasStagedOverrideDescendant(relPath, overrideRelPaths) {
    const prefix = relPath ? `${relPath}/` : '';
    for (const overridePath of overrideRelPaths) {
        if (overridePath.startsWith(prefix) && overridePath !== relPath) {
            return true;
        }
    }
    return false;
}

function stageSourceTreeWithOverrides(sourceDir, stagedDir, overrideRelPaths, baseRel = '') {
    if (!fs.existsSync(sourceDir)) return;
    fs.mkdirSync(stagedDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const relPath = normalizeStagedRelPath(baseRel ? `${baseRel}/${entry.name}` : entry.name);
        if (!relPath || overrideRelPaths.has(relPath)) continue;

        const sourcePath = path.join(sourceDir, entry.name);
        const stagedPath = path.join(stagedDir, entry.name);
        if (entry.isDirectory() && hasStagedOverrideDescendant(relPath, overrideRelPaths)) {
            stageSourceTreeWithOverrides(sourcePath, stagedPath, overrideRelPaths, relPath);
            continue;
        }
        fs.symlinkSync(sourcePath, stagedPath, pathTypeForSymlink(sourcePath));
    }
}

function writeStagedSymlink(stagedCodePath, relPath, hostPath) {
    const normalizedRelPath = normalizeStagedRelPath(relPath);
    if (!normalizedRelPath) return;
    const linkPath = path.join(stagedCodePath, ...normalizedRelPath.split('/'));
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
        fs.rmSync(linkPath, { recursive: true, force: true });
    } catch (_) {}
    fs.symlinkSync(hostPath, linkPath, pathTypeForSymlink(hostPath));
}

function normalizeCodeLinkSpec(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return {
            hostPath: value.hostPath,
            readOnly: value.readOnly === true
        };
    }
    return {
        hostPath: value,
        readOnly: false
    };
}

function assertPodmanCodeMountAllowed(relPath, containerPath = '') {
    const normalizedRelPath = normalizeStagedRelPath(relPath);
    if (normalizedRelPath === 'node_modules' || normalizedRelPath.startsWith('node_modules/')) {
        throw new Error(
            `[podman] manifest volume '${containerPath || `/code/${normalizedRelPath}`}' targets reserved /code/node_modules. `
            + 'Dependencies are prepared by Ploinky and mounted read-only.'
        );
    }
}

function setPodmanTargetMount(mounts, hostPath, readOnly) {
    if (!hostPath) return;
    const resolvedHostPath = path.resolve(hostPath);
    if (!fs.existsSync(resolvedHostPath)) return;
    if (mounts.has(resolvedHostPath)) {
        mounts.delete(resolvedHostPath);
    }
    mounts.set(resolvedHostPath, {
        source: resolvedHostPath,
        target: resolvedHostPath,
        ro: readOnly === true
    });
}

function buildPodmanStagedTargetMounts(options = {}) {
    const {
        agentCodePath,
        nodeModulesDir,
        codeLinks = new Map(),
        codeReadOnly = false
    } = options;
    const mounts = new Map();

    setPodmanTargetMount(mounts, agentCodePath, codeReadOnly);
    for (const [relPath, rawSpec] of codeLinks.entries()) {
        const normalizedRelPath = normalizeStagedRelPath(relPath);
        if (!normalizedRelPath) continue;
        assertPodmanCodeMountAllowed(normalizedRelPath);
        const spec = normalizeCodeLinkSpec(rawSpec);
        setPodmanTargetMount(mounts, spec.hostPath, spec.readOnly);
    }

    // Dependency caches are protected even when a broader workspace/cwd bind is rw.
    setPodmanTargetMount(mounts, nodeModulesDir, true);
    return Array.from(mounts.values());
}

function podmanMountSuffix(readOnly) {
    // Podman remote on macOS has parsed absolute self-mounts incorrectly with
    // ':ro,z', creating paths that end in 'o,z'. ':z,ro' preserves the target.
    return readOnly ? ':z,ro' : ':z';
}

function ensurePodmanStagedAgentLibDir(agentName, nodeModulesDir, options = {}) {
    if (!options || typeof options.runtimeRoot !== 'string' || !options.runtimeRoot) {
        throw new Error('ensurePodmanStagedAgentLibDir: options.runtimeRoot is required');
    }
    const runtimeRoot = options.runtimeRoot;
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

function ensurePodmanStagedCodeDir(agentName, agentCodePath, nodeModulesDir, codeLinks = new Map(), options = {}) {
    if (!options || typeof options.runtimeRoot !== 'string' || !options.runtimeRoot) {
        throw new Error('ensurePodmanStagedCodeDir: options.runtimeRoot is required');
    }
    const runtimeRoot = options.runtimeRoot;
    const stagedCodePath = path.join(runtimeRoot, `code-${process.pid}-${Date.now()}`);
    const normalizedLinks = new Map();
    for (const [relPath, hostPath] of codeLinks.entries()) {
        const normalizedRelPath = normalizeStagedRelPath(relPath);
        if (normalizedRelPath) {
            assertPodmanCodeMountAllowed(normalizedRelPath);
            normalizedLinks.set(normalizedRelPath, normalizeCodeLinkSpec(hostPath).hostPath);
        }
    }
    normalizedLinks.set('node_modules', nodeModulesDir);

    fs.mkdirSync(stagedCodePath, { recursive: true });
    stageSourceTreeWithOverrides(agentCodePath, stagedCodePath, new Set(normalizedLinks.keys()));
    for (const [relPath, hostPath] of normalizedLinks.entries()) {
        writeStagedSymlink(stagedCodePath, relPath, hostPath);
    }
    return stagedCodePath;
}

function codeRelativeMountPath(containerPath) {
    const normalized = String(containerPath || '').replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!normalized.startsWith('/code/')) return null;
    return normalizeStagedRelPath(normalized.slice('/code/'.length));
}

function isPathWithin(childPath, parentPath) {
    const relativePath = path.relative(parentPath, childPath);
    return relativePath === ''
        || (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function decodeFormattedEnvValue(rawValue) {
    const raw = String(rawValue || '');
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
        return raw
            .slice(1, -1)
            .replace(/\\n/g, '\n')
            .replace(/\\(["\\$`])/g, '$1');
    }
    return raw;
}

function getLastFormattedEnvValue(envStrings, name) {
    const prefix = `-e ${name}=`;
    for (let i = envStrings.length - 1; i >= 0; i -= 1) {
        const entry = String(envStrings[i] || '');
        if (entry.startsWith(prefix)) {
            return decodeFormattedEnvValue(entry.slice(prefix.length));
        }
    }
    return '';
}

function mergeNodeOptions(existingValue, requiredOptions = []) {
    const parts = String(existingValue || '').split(/\s+/).filter(Boolean);
    const seen = new Set(parts);
    for (const option of requiredOptions) {
        if (!option || seen.has(option)) continue;
        parts.push(option);
        seen.add(option);
    }
    return parts.join(' ');
}

/**
 * Resolve a symlink path to its actual target.
 * If the path is not a symlink or doesn't exist, returns the original path.
 * @param {string} symlinkPath - The path that might be a symlink
 * @returns {string} The resolved real path, or original if not a symlink
 */
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

function resolveRouterHostForRuntime(runtime) {
    if (runtime === 'podman') {
        return 'host.containers.internal';
    }
    if (runtime === 'docker') {
        return 'host.docker.internal';
    }
    return '127.0.0.1';
}

function normalizeRouterPort(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '';
}

function readRouterPortFromRoutingFile() {
    try {
        if (!fs.existsSync(ROUTING_FILE)) return '';
        const routing = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) || {};
        return normalizeRouterPort(routing.port);
    } catch (_) {
        return '';
    }
}

function buildRuntimeRouterEnv(runtime, options = {}) {
    const routerPort = normalizeRouterPort(options.routerPort)
        || readRouterPortFromRoutingFile()
        || '8080';
    const routerHost = String(options.routerHost || '').trim()
        || resolveRouterHostForRuntime(runtime);
    const routerAuthority = String(options.routerAuthority || process.env.PLOINKY_PUBLIC_AUTHORITY || '').trim()
        || `${String(process.env.PLOINKY_PUBLIC_BIND || '127.0.0.1').trim()}:${routerPort}`;
    return {
        PLOINKY_ROUTER_PORT: routerPort,
        PLOINKY_ROUTER_HOST: routerHost,
        PLOINKY_ROUTER_URL: `http://${routerHost}:${routerPort}`,
        PLOINKY_ROUTER_AUTHORITY: routerAuthority,
    };
}

function buildDefaultPodmanNetworkArgs(platform = process.platform) {
    return [
        '--network', platform === 'darwin' ? 'pasta' : 'pasta:--map-gw',
        ...(platform === 'darwin' ? ['--no-hosts'] : []),
    ];
}

function validBoxTransportAddress(value) {
    const address = String(value || '').trim();
    if (net.isIP(address) !== 4) return '';
    const firstOctet = Number(address.split('.')[0]);
    return firstOctet > 0 && firstOctet !== 127 && firstOctet < 224 ? address : '';
}

function buildBoxPodmanHostArgs({
    fsApi = fs,
    markerPath,
    transportPath = BOX_TRANSPORT_PATH,
} = {}) {
    const markerOptions = { fsApi };
    if (markerPath) markerOptions.markerPath = markerPath;
    if (!isInsideBox(markerOptions)) return [];

    let stat;
    try {
        stat = fsApi.lstatSync(transportPath);
    } catch (error) {
        throw new Error(`Unable to inspect Ploinky Box transport state ${transportPath}`, { cause: error });
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Ploinky Box transport state is not a single regular file: ${transportPath}`);
    }

    let transport;
    try {
        transport = JSON.parse(fsApi.readFileSync(transportPath, 'utf8'));
    } catch (error) {
        throw new Error(`Unable to parse Ploinky Box transport state ${transportPath}`, { cause: error });
    }
    const address = validBoxTransportAddress(transport?.address);
    if (!address) {
        throw new Error(`Ploinky Box transport state lacks a routable IPv4 address: ${transportPath}`);
    }
    return ['--add-host', `host.containers.internal:${address}`];
}

function appendRuntimeRouterEnvFlags(envStrings, routerEnv) {
    for (const [name, value] of Object.entries(routerEnv || {})) {
        envStrings.push(formatEnvFlag(name, value));
    }
}

function ensureManifestVolumeHostPaths(manifest) {
    if (!manifest?.volumes || typeof manifest.volumes !== 'object') return;
    const volumeOptions = readManifestVolumeOptions(manifest);
    for (const [hostPath, containerPath] of Object.entries(manifest.volumes)) {
        const resolvedHostPath = resolveManifestVolumeHostPath(hostPath);
        const options = volumeOptions[containerPath]
            || volumeOptions[String(containerPath || '').replace(/\/+$/, '')]
            || {};
        ensureManifestVolumeHostPath(resolvedHostPath, containerPath, options);
    }
}

/**
 * Get mount mode based on active profile.
 * In dev profile, mounts are rw. In qa/prod, mounts are ro.
 * @param {string} profile - The active profile
 * @param {string} runtime - Container runtime (docker/podman)
 * @param {object} profileConfig - Profile configuration
 * @returns {{ codeMountMode: string, skillsMountMode: string, codeReadOnly: boolean, skillsReadOnly: boolean }}
 */
function getProfileMountModes(profile, runtime, profileConfig = {}) {
    const defaultMounts = getDefaultMountModes(profile);
    const mounts = profileConfig?.mounts || {};
    const codeMode = normalizeMountMode(mounts.code, defaultMounts.code);
    const skillsMode = normalizeMountMode(mounts.skills, defaultMounts.skills);
    const roSuffix = runtime === 'podman' ? ':z,ro' : ':ro';
    const rwSuffix = runtime === 'podman' ? ':z' : '';

    return {
        codeMountMode: codeMode === 'ro' ? roSuffix : rwSuffix,
        skillsMountMode: skillsMode === 'ro' ? roSuffix : rwSuffix,
        codeReadOnly: codeMode === 'ro',
        skillsReadOnly: skillsMode === 'ro'
    };
}

function normalizeMountMode(mode, fallback) {
    if (mode === 'ro' || mode === 'rw') {
        return mode;
    }
    return fallback;
}

function ensureNamedRuntimeNetwork(runtime, networkName) {
    if (!networkName) return;
    try {
        execSync(`${runtime} network inspect ${networkName}`, { stdio: 'ignore' });
    } catch (_) {
        execSync(`${runtime} network create ${networkName}`, { stdio: 'inherit' });
    }
}

function normalizeProfileEnv(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(env)) {
        if (!key) continue;
        // Handle complex env specs with varName/default - skip these as they're handled by buildEnvFlags
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            // Complex spec like { varName: "...", default: "..." } - skip, handled by buildEnvFlags
            continue;
        }
        normalized[String(key)] = value === undefined ? '' : String(value);
    }
    return normalized;
}

function appendEnvFlagsFromMap(envFlags, envMap) {
    if (!envMap || typeof envMap !== 'object' || Array.isArray(envMap)) {
        return;
    }
    for (const [name, value] of Object.entries(envMap)) {
        if (!name) continue;
        envFlags.push(formatEnvFlag(String(name), value ?? ''));
    }
}

function isMissingContainerRemoval(stderr) {
    return /no such container|no container with name|does not exist|not found/i.test(String(stderr || ''));
}

function describeRuntimeFailure(result) {
    if (result?.error) return result.error.message;
    const stderr = String(result?.stderr || '').trim();
    return stderr || `exit code ${result?.status}`;
}

function removeContainerForRecreate(runtime, containerName, label) {
    spawnSync(runtime, ['stop', containerName], { stdio: 'ignore' });
    const rmResult = spawnSync(runtime, ['rm', '-f', containerName], {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8'
    });
    const rmFailed = Boolean(rmResult.error) || rmResult.status !== 0;
    const rmStderr = String(rmResult.stderr || '').trim();
    if (rmFailed && !isMissingContainerRemoval(rmStderr)) {
        throw new Error(
            `[${label}] container '${containerName}' could not be removed by ${runtime} rm -f. `
            + 'Refusing to recreate because the existing container may still hold staged bind mounts. '
            + describeRuntimeFailure(rmResult)
        );
    }
    if (containerExists(containerName)) {
        throw new Error(
            `[${label}] container '${containerName}' still exists after ${runtime} rm -f. `
            + 'Refusing to recreate; investigate the runtime before retrying.'
            + (rmStderr ? ` Last rm error: ${rmStderr}` : '')
        );
    }
    clearLivenessState(containerName);
}

function startAgentContainer(agentName, manifest, agentPath, options = {}) {
    const runtime = getRuntime();
    const repoName = path.basename(path.dirname(agentPath));
    const containerName = options.containerName || getAgentContainerName(agentName, repoName);
    const agentSnapshot = loadAgentsMap();
    const existingRecord = agentSnapshot[containerName] || {};
    const instanceName = options.alias || existingRecord.alias || agentName;
    removeContainerForRecreate(runtime, containerName, `startAgentContainer:${agentName}`);

    const { raw: explicitAgentCmd } = readManifestAgentCommand(manifest);
    const startCmd = readManifestStartCommand(manifest);
    const useStartEntry = Boolean(startCmd);
    const launchExplicitSidecar = Boolean(startCmd && explicitAgentCmd);
    const cwd = getConfiguredProjectPath(agentName, path.basename(path.dirname(agentPath)), options.alias);
    const isolatedHome = (existingRecord.runMode || 'isolated') === 'isolated';
    const agentHomeDir = getAgentWorkDir(instanceName);
    const containerCwd = isolatedHome ? '/root' : cwd;
    const cwdMountTarget = isolatedHome ? '/root' : cwd;
    const sharedDir = ensureSharedHostDir();
    const llmRuntimeSharedPath = resolveLlmRuntimeSharedPath(agentPath);

    // Get active profile and configuration
    const activeProfile = String(options.profileName || getActiveProfile()).trim() || getActiveProfile();
    const hasProfileConfig = Boolean(manifest?.profiles && Object.keys(manifest.profiles).length > 0);
    const profileConfig = hasProfileConfig
        ? getProfileConfig(`${repoName}/${agentName}`, activeProfile)
        : null;
    if (hasProfileConfig && !profileConfig) {
        const availableProfiles = Object.keys(manifest.profiles || {});
        throw new Error(`[profile] ${agentName}: profile '${activeProfile}' not found. Available: ${availableProfiles.join(', ')}`);
    }
    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });

    // Ensure workspace structure exists and run preinstall [HOST] before any
    // image-dependent work. Hooks may build local images or seed vars that image
    // resolution and dependency-cache probes consume.
    const preLifecycle = runPreContainerLifecycle(agentName, repoName, agentPath, activeProfile);
    if (!preLifecycle.success) {
        throw new Error(`[profile] ${agentName}: pre-container lifecycle failed: ${preLifecycle.errors.join('; ')}`);
    }

    // LLM-runtime agents receive their image from the hardware-aware catalog
    // (resolved below), so a manifest `container` placeholder that cannot resolve
    // here (e.g. ${PLOINKY_BASE_LOCAL_IMAGE} with no value) must not be fatal.
    let manifestImage = null;
    try {
        manifestImage = resolveManifestImage(manifest, profileConfig, { agentName, repoName });
    } catch (err) {
        if (!isLlmRuntimeManifest(manifest, profileConfig)) throw err;
    }
    let image = manifestImage;
    const useProfileLifecycle = Boolean(profileConfig);
    const runtimeRouterEnv = buildRuntimeRouterEnv(runtime, options);
    const envHash = computeEnvHash(manifest, profileConfig, runtimeRouterEnv, { agentName, repoName });

    // LLM runtime opt-in: catalog-driven image, hardware-aware policy, reuse hash.
    // Resolved BEFORE dependency cache prep so the cache uses the selected image.
    let llmStartup = { enabled: false };
    if (isLlmRuntimeManifest(manifest, profileConfig)) {
        const effectiveNetworkForLlm = profileConfig?.network ?? manifest?.network ?? null;
        llmStartup = prepareLlmStartup({
            runtime,
            manifest,
            profileConfig,
            agentName,
            alias: options.alias,
            env: process.env,
            agentWorkDirRoot: AGENTS_DATA_DIR,
            manifestEnvNames: [
                ...getManifestEnvNames(manifest, profileConfig),
                ...getExposedNames(manifest, profileConfig),
            ],
            envHash,
            effectiveNetwork: effectiveNetworkForLlm,
        });
        if (llmStartup.enabled && llmStartup.imageRef) {
            image = llmStartup.imageRef;
            debugLog(`[llm-runtime] ${agentName}: catalog-selected image ${image} (arch ${llmStartup.selection.architectureId})`);
        }
    }

    if (!image) {
        throw new Error(`[image] ${agentName}: no container image resolved (manifest container unresolved and no catalog image selected).`);
    }

    // Get profile mount modes (profile overrides default if provided)
    const {
        codeMountMode,
        skillsMountMode,
        codeReadOnly,
        skillsReadOnly
    } = getProfileMountModes(activeProfile, runtime, profileConfig || {});

    // New workspace structure paths
    const agentWorkDir = agentHomeDir;
    const agentCodePathSymlink = getAgentCodePath(agentName);
    const agentSkillsPathSymlink = getAgentSkillsPath(agentName);

    // Resolve symlinks to get actual paths - ensures container mounts work correctly
    // The paths might be symlinks like $CWD/code/agent -> .ploinky/repos/repo/agent
    const agentCodePath = resolveSymlinkPath(agentCodePathSymlink);
    const agentSkillsPath = resolveSymlinkPath(agentSkillsPathSymlink);

    // Ensure persistent agent home exists before container start.
    fs.mkdirSync(agentHomeDir, { recursive: true });
    // Ensure MCP config is staged in the persistent agent home before container start.
    syncAgentMcpConfig(containerName, path.resolve(agentPath), instanceName, { workDir: agentWorkDir });

    // INSTALL PHASE — runtime containers never run npm install. Dependency
    // preparation happens here, before runtime boot, via a dedicated cache.
    const agentHasPackageJson = fs.existsSync(path.join(agentCodePath, 'package.json'));
    const needsCoreDeps = manifestNeedsCoreDependencies(manifest, profileConfig, {
        agentHasPackageJson,
        llmRuntime: isLlmRuntimeManifest(manifest, profileConfig),
    });
    let preparedNodeModulesDir = path.join(agentWorkDir, 'node_modules');
    if (needsCoreDeps) {
        const runtimeKey = detectRuntimeKeyForAgent(manifest, repoName, agentName, profileConfig, image);
        const agentPackagePath = agentHasPackageJson ? path.join(agentCodePath, 'package.json') : null;
        const prepared = prepareAgentCache({
            repoName,
            agentName,
            runtimeKey,
            agentPackagePath,
            image,
            runtime,
        });
        preparedNodeModulesDir = nodeModulesDir(prepared.cachePath);
        debugLog(`[deps] ${agentName}: prepared dependency cache ready at ${preparedNodeModulesDir}`);
    } else {
        debugLog(`[deps] ${agentName}: Skipping dependency cache prep (uses start command, no package.json)`);
        if (!fs.existsSync(preparedNodeModulesDir)) {
            fs.mkdirSync(preparedNodeModulesDir, { recursive: true });
        }
    }

    // Manifest / profile install hook (e.g. coral-agent's installPrerequisites.sh)
    const manifestInstallCmd = String(profileConfig?.install || manifest?.install || '').trim();
    const combinedInstallCmd = manifestInstallCmd;

    const podmanCodeLinks = new Map();
    const manifestVolumeMounts = [];
    if (manifest.volumes && typeof manifest.volumes === 'object') {
        const volumeOptions = readManifestVolumeOptions(manifest);
        for (const [hostPath, containerPath] of Object.entries(manifest.volumes)) {
            const resolvedHostPath = resolveManifestVolumeHostPath(hostPath);
            const options = volumeOptions[containerPath]
                || volumeOptions[String(containerPath || '').replace(/\/+$/, '')]
                || {};
            ensureManifestVolumeHostPath(resolvedHostPath, containerPath, options);
            const codeRelPath = runtime === 'podman' ? codeRelativeMountPath(containerPath) : null;
            if (codeRelPath) {
                assertPodmanCodeMountAllowed(codeRelPath, containerPath);
                podmanCodeLinks.set(codeRelPath, { hostPath: resolvedHostPath, readOnly: false });
            } else {
                manifestVolumeMounts.push({ resolvedHostPath, containerPath });
            }
        }
    }

    const skillsPathExists = fs.existsSync(agentSkillsPath);
    const skillsPathInsideCode = skillsPathExists && isPathWithin(agentSkillsPath, agentCodePath);
    if (runtime === 'podman' && skillsPathExists && !skillsPathInsideCode) {
        podmanCodeLinks.set('skills', { hostPath: agentSkillsPath, readOnly: skillsReadOnly });
    }

    let agentLibMountPath = AGENT_LIB_PATH;
    let codeMountPath = agentCodePath;
    const useNestedDependencyMounts = runtime !== 'podman';
    let podmanStagedTargetMounts = [];
    if (runtime === 'podman') {
        fs.mkdirSync(PODMAN_RUNTIME_ROOT, { recursive: true });
        const podmanRuntimeRoot = prepareFreshRuntimeRoot(
            path.join(PODMAN_RUNTIME_ROOT, runtimeSegment(containerName)),
            PODMAN_RUNTIME_ROOT
        );
        agentLibMountPath = ensurePodmanStagedAgentLibDir(agentName, preparedNodeModulesDir, {
            runtimeRoot: podmanRuntimeRoot
        });
        codeMountPath = ensurePodmanStagedCodeDir(agentName, agentCodePath, preparedNodeModulesDir, podmanCodeLinks, {
            runtimeRoot: podmanRuntimeRoot
        });
        // Podman cannot use Docker-style nested /code/node_modules mounts on the
        // staged symlink tree. Mount each symlink target at its real path instead,
        // with source/dependency targets read-only when the profile requires it.
        podmanStagedTargetMounts = buildPodmanStagedTargetMounts({
            agentCodePath,
            nodeModulesDir: preparedNodeModulesDir,
            codeLinks: podmanCodeLinks,
            codeReadOnly
        });
    }

    // Ensure the agent home directory exists on host.
    fs.mkdirSync(agentHomeDir, { recursive: true });

    // Build volume mount arguments using new workspace structure
    // Prepared node_modules are mounted read-only; runtime containers never mutate deps.
    const nodeModulesMount = runtime === 'podman' ? ':z,ro' : ':ro';
    const containerWorkdir = isolatedHome ? '/root' : (String(manifest?.workdir || '/code').trim() || '/code');
    const args = ['run', '-d', '--name', containerName, '--label', `ploinky.envhash=${envHash}`, '-w', containerWorkdir,
        // Agent library (always ro)
        '-v', `${agentLibMountPath}:/Agent${runtime === 'podman' ? ':z,ro' : ':ro'}`,
        // Code directory - profile dependent (rw in dev, ro in qa/prod)
        '-v', `${codeMountPath}:/code${codeMountMode}`,
        ...(useNestedDependencyMounts ? [
            // node_modules mounts - ESM resolution walks up from script location
            // Mount at both /code/node_modules (for agent code) and /Agent/node_modules (for AgentServer.mjs)
            '-v', `${preparedNodeModulesDir}:/code/node_modules${nodeModulesMount}`,
            '-v', `${preparedNodeModulesDir}:/Agent/node_modules${nodeModulesMount}`,
        ] : []),
        // Shared directory
        '-v', `${sharedDir}:/shared${runtime === 'podman' ? ':z' : ''}`,
        // CWD passthrough. Isolated agents receive their host data dir as /root.
        '-v', `${cwd}:${cwdMountTarget}${runtime === 'podman' ? ':z' : ''}`
    ];

    if (!isolatedHome) {
        args.push('-v', `${agentHomeDir}:/root${runtime === 'podman' ? ':z' : ''}`);
    }

    // LLM runtime: expose persistent model storage at /models and selected
    // architecture/runtime state at /runtime. These are identity-specific so
    // agent aliases keep separate caches and process state.
    if (llmStartup.enabled && llmStartup.modelDir) {
        args.push('-v', `${llmStartup.modelDir}:/models${runtime === 'podman' ? ':z' : ''}`);
    }
    if (llmStartup.enabled && llmStartup.stateDir) {
        args.push('-v', `${llmStartup.stateDir}:/runtime${runtime === 'podman' ? ':z' : ''}`);
    }
    if (llmStartup.enabled && fs.existsSync(llmRuntimeSharedPath)) {
        args.push('-v', `${llmRuntimeSharedPath}:/Agent/llm-runtime${runtime === 'podman' ? ':z,ro' : ':ro'}`);
    }

    if (runtime === 'podman') {
        for (const mount of podmanStagedTargetMounts) {
            args.push('-v', `${mount.source}:${mount.target}${podmanMountSuffix(mount.ro)}`);
        }
    }

    // Mount skills directory if it exists
    if (skillsPathExists && !skillsPathInsideCode && runtime !== 'podman') {
        args.push('-v', `${agentSkillsPath}:/code/skills${skillsMountMode}`);
    }
    // Profile-level network overrides root manifest.network (mirrors how ports/env behave).
    // Lets one manifest declare e.g. host networking for prod and bridge networking for dev.
    const profileNetwork = profileConfig?.network && typeof profileConfig.network === 'object' ? profileConfig.network : null;
    const rootNetwork = manifest?.network && typeof manifest.network === 'object' ? manifest.network : null;
    const manifestNetwork = profileNetwork || rootNetwork;
    const manifestNetworkMode = String(manifestNetwork?.mode || '').trim().toLowerCase();
    const manifestNetworkName = String(manifestNetwork?.name || '').trim();
    const manifestNetworkAliases = Array.isArray(manifestNetwork?.aliases)
        ? manifestNetwork.aliases.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const useHostNetwork = manifestNetworkMode === 'host';
    const containerSecurityArgs = buildContainerSecurityArgs(resolveContainerSecurity(manifest, profileConfig));
    if (containerSecurityArgs.length) {
        args.splice(1, 0, ...containerSecurityArgs);
    }

    // LLM runtime: emit catalog-derived runtime policy args (platform, devices,
    // memory, shm, gpus, ipc) and labels (architecture, catalog, policy hash,
    // image digest, reuse hash). These go BEFORE the image so they apply to
    // `run`. Non-LLM agents are untouched.
    if (llmStartup.enabled) {
        if (Array.isArray(llmStartup.runArgs) && llmStartup.runArgs.length) {
            args.splice(1, 0, ...llmStartup.runArgs);
        }
        for (const [labelKey, labelValue] of Object.entries(llmStartup.labels || {})) {
            if (labelValue === '' || labelValue === null || labelValue === undefined) continue;
            args.splice(1, 0, '--label', `${labelKey}=${labelValue}`);
        }
    }

    if (useHostNetwork) {
        args.splice(1, 0, '--network', 'host');
        if (runtime === 'podman') {
            args.splice(1, 0, '--replace');
        }
    } else if (manifestNetworkName) {
        ensureNamedRuntimeNetwork(runtime, manifestNetworkName);
        args.splice(1, 0, '--network', manifestNetworkName);
        for (const alias of manifestNetworkAliases) {
            args.splice(1, 0, '--network-alias', alias);
        }
        if (runtime === 'podman') {
            args.splice(1, 0, '--replace');
        }
    } else if (runtime === 'podman') {
        args.splice(1, 0, ...buildDefaultPodmanNetworkArgs());
        args.splice(1, 0, '--replace');
    } else if (runtime === 'docker') {
        args.splice(1, 0, '--add-host', 'host.docker.internal:host-gateway');
    }
    if (runtime === 'podman') {
        const boxHostArgs = buildBoxPodmanHostArgs();
        if (boxHostArgs.length) args.splice(1, 0, ...boxHostArgs);
    }

    for (const { resolvedHostPath, containerPath } of manifestVolumeMounts) {
        args.push('-v', `${resolvedHostPath}:${containerPath}${runtime === 'podman' ? ':z' : ''}`);
    }

    // Manifest-driven runtime resources (persistent storage + declared env).
    // Replaces former agentName-specific runtime wiring with manifest-driven resources.
    const resourcePlan = planRuntimeResources(manifest, { agentName, repoName });
    if (resourcePlan.persistentStorage) {
        ensurePersistentStorageHostDir(resourcePlan);
        args.push('-v', `${resourcePlan.persistentStorage.hostPath}:${resourcePlan.persistentStorage.containerPath}${runtime === 'podman' ? ':z' : ''}`);
    }

    const envStrings = [
        ...buildEnvFlags(manifest, profileConfig, { agentName, repoName, profileName: activeProfile }),
        formatEnvFlag('PLOINKY_MCP_CONFIG_PATH', CONTAINER_CONFIG_PATH)
    ];
    envStrings.push(formatEnvFlag('AGENT_NAME', agentName));
    envStrings.push(formatEnvFlag('WORKSPACE_PATH', isolatedHome ? '/root' : cwd));
    envStrings.push(formatEnvFlag('PLOINKY_WORKSPACE_ROOT', PLOINKY_WORKSPACE_ROOT));
    envStrings.push(formatEnvFlag('HOME', '/root'));
    // Apply env from manifest.runtime.resources.env (templates expanded).
    for (const [envKey, envValue] of Object.entries(applyRuntimeResourceEnv(resourcePlan))) {
        envStrings.push(formatEnvFlag(envKey, envValue));
    }

    try {
        const repoName = path.basename(path.dirname(agentPath));
        // Per-agent request-signing identity (DS013). Each agent receives ONLY
        // its own id + secret — never the master key, never the shared
        // derived-master key, never another agent's secret.
        for (const [key, value] of Object.entries(buildAgentIdentityEnv(deriveAgentPrincipalId(repoName, agentName)))) {
            envStrings.push(formatEnvFlag(key, value));
        }
    } catch (err) {
        debugLog(`[invocationAuth] could not set agent identity for ${agentName}: ${err?.message || err}`);
    }

    const profileEnv = normalizeProfileEnv(profileConfig?.env);
    // Primitive profile env values are already resolved by buildEnvFlags above.
    // Appending them again here would let defaults override operator-provided
    // vars, for example clearing an explicit gateway base URL override with "".

    const profileEnvVars = getProfileEnvVars(agentName, repoName, activeProfile, {
        containerName,
        containerId: containerName
    });
    appendEnvFlagsFromMap(envStrings, profileEnvVars);

    const agentClientIdVar = `PLOINKY_AGENT_${agentName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_ID`;
    const agentClientSecretVar = `PLOINKY_AGENT_${agentName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_SECRET`;
    const agentClientId = resolveVarValue(agentClientIdVar) || resolveVarValue('PLOINKY_AGENT_CLIENT_ID');
    const agentClientSecret = resolveVarValue(agentClientSecretVar) || resolveVarValue('PLOINKY_AGENT_CLIENT_SECRET');

    if (agentClientId) {
        envStrings.push(formatEnvFlag('PLOINKY_AGENT_CLIENT_ID', agentClientId));
    }
    if (agentClientSecret) {
        envStrings.push(formatEnvFlag('PLOINKY_AGENT_CLIENT_SECRET', agentClientSecret));
    }

    if (profileConfig?.secrets && profileConfig.secrets.length > 0) {
        const secretValidation = validateSecrets(profileConfig.secrets);
        if (!secretValidation.valid) {
            throw new Error(formatMissingSecretsError(secretValidation.missing, activeProfile));
        }
        const profileSecrets = getSecrets(profileConfig.secrets);
        appendEnvFlagsFromMap(envStrings, profileSecrets);
    }

    appendRuntimeRouterEnvFlags(envStrings, runtimeRouterEnv);
    if (llmStartup.enabled) {
        envStrings.push(formatEnvFlag('HF_HOME', '/models/hf-cache'));
        envStrings.push(formatEnvFlag('PLOINKY_MODELS_DIR', '/models/artifacts'));
        envStrings.push(formatEnvFlag('PLOINKY_DERIVED_DIR', '/models/derived'));
        envStrings.push(formatEnvFlag('PLOINKY_RUNTIME_DIR', '/runtime'));
        envStrings.push(formatEnvFlag('PLOINKY_LAUNCHERS_DIR', '/opt/ploinky/launchers'));
        envStrings.push(formatEnvFlag('PLOINKY_MCP_PORT', '9000'));
        envStrings.push(formatEnvFlag('PLOINKY_LLM_PUBLIC_PORT', '9000'));
        envStrings.push(formatEnvFlag('PLOINKY_LLM_MCP_PORT', '9001'));
        envStrings.push(formatEnvFlag('PLOINKY_LLM_CONTROL_PORT', '9002'));
        envStrings.push(formatEnvFlag('PLOINKY_INFERENCE_PORT', '8080'));
    }

    // DS013/DS011: strip any reserved identity/master env FLAG a config layer
    // emitted (manifest env, runtime resources, profile env/secrets), then
    // re-assert the authoritative agent identity LAST so no config can inject a
    // master key or override the agent's derived secret.
    const reservedEnvPrefixes = RESERVED_AGENT_ENV_NAMES.map((name) => `-e ${name}=`);
    for (let i = envStrings.length - 1; i >= 0; i -= 1) {
        if (reservedEnvPrefixes.some((prefix) => String(envStrings[i] || '').startsWith(prefix))) {
            envStrings.splice(i, 1);
        }
    }
    try {
        for (const [key, value] of Object.entries(buildAgentIdentityEnv(deriveAgentPrincipalId(path.basename(path.dirname(agentPath)), agentName)))) {
            envStrings.push(formatEnvFlag(key, value));
        }
    } catch (err) {
        debugLog(`[invocationAuth] could not set agent identity for ${agentName}: ${err?.message || err}`);
    }
    envStrings.push(formatEnvFlag('HOME', '/root'));

    const envFlags = flagsToArgs(envStrings);
    if (envFlags.length) args.push(...envFlags);
    if (runtime === 'podman') {
        const nodeOptions = mergeNodeOptions(
            getLastFormattedEnvValue(envStrings, 'NODE_OPTIONS'),
            PODMAN_STAGED_NODE_OPTIONS
        );
        args.push(...flagsToArgs([formatEnvFlag('NODE_OPTIONS', nodeOptions)]));
    }
    // NODE_PATH is needed because AgentServer.mjs runs from /Agent/server/, not /code/
    // Node.js module resolution walks up from script location, so it won't find /code/node_modules
    args.push('-e', `NODE_PATH=/code/node_modules`);

    const manifestEntrypoint = typeof manifest?.entrypoint === 'string' ? manifest.entrypoint.trim() : '';
    if (manifestEntrypoint) {
        args.push('--entrypoint', manifestEntrypoint);
    }
    args.push(image);
    let entrySummary = DEFAULT_AGENT_ENTRY;
    if (useStartEntry) {
        const startArgs = splitCommandArgs(startCmd);
        if (!startArgs.length) {
            throw new Error(`[start] ${agentName}: manifest.start is defined but empty.`);
        }
        // Run install command before start script if defined
        if (combinedInstallCmd) {
            console.log(`[install] ${agentName}: entrypoint deps + manifest hooks`);
            const fullCmd = `cd ${containerCwd} && ${combinedInstallCmd} && ${startArgs.join(' ')}`;
            args.push('sh', '-c', fullCmd);
            entrySummary = `sh -c "cd ${containerCwd} && <install> && ${startArgs.join(' ')}"`;

        } else {
            args.push(...startArgs);
            entrySummary = startArgs.join(' ');
        }
    } else if (explicitAgentCmd) {
        const shellPath = detectShellForImage(agentName, image, runtime);
        if (shellPath === SHELL_FALLBACK_DIRECT) {
            throw new Error(`[start] ${agentName}: no supported shell found to execute agent command.`);
        }
        // Run install command before agent command
        if (combinedInstallCmd) {
            console.log(`[install] ${agentName}: entrypoint deps + manifest hooks`);
        }
        const fullCmd = combinedInstallCmd
            ? `cd ${containerCwd} && ${combinedInstallCmd} && ${explicitAgentCmd}`
            : `cd ${containerCwd} && ${explicitAgentCmd}`;
        args.push(shellPath, '-lc', fullCmd);
        entrySummary = combinedInstallCmd
            ? `${shellPath} -lc "cd ${containerCwd} && <install> && ${explicitAgentCmd}"`
            : `${shellPath} -lc "cd ${containerCwd} && ${explicitAgentCmd}"`;
    } else {
        // Run preinstall + install in main container before default agent server
        if (combinedInstallCmd) {
            args.push('sh', '-c', `${combinedInstallCmd} && sh /Agent/server/AgentServer.sh`);
            entrySummary = `sh -c "<install> && sh /Agent/server/AgentServer.sh"`;
        } else {
            args.push('sh', '/Agent/server/AgentServer.sh');
        }
    }

    console.log(`[start] ${agentName}: ${runtime} run (cwd='${cwd}') -> ${entrySummary}`);
    const res = spawnSync(runtime, args, { stdio: 'inherit' });
    if (res.status !== 0) { throw new Error(`${runtime} run failed with code ${res.status}`); }
    const agents = loadAgentsMap();
    const declaredEnvNames2 = [
        ...getManifestEnvNames(manifest, profileConfig),
        ...getExposedNames(manifest, profileConfig),
        ...Object.keys(profileEnv)
    ];
    const llmRuntimeEnvNames = llmStartup.enabled
        ? ['HF_HOME', 'PLOINKY_MODELS_DIR', 'PLOINKY_DERIVED_DIR', 'PLOINKY_RUNTIME_DIR', 'PLOINKY_LAUNCHERS_DIR', 'PLOINKY_MCP_PORT', 'PLOINKY_LLM_PUBLIC_PORT', 'PLOINKY_LLM_MCP_PORT', 'PLOINKY_LLM_CONTROL_PORT', 'PLOINKY_INFERENCE_PORT']
        : [];
    const persistedRecord = agents[containerName] || existingRecord;
    const runtimeService = buildRuntimeServiceDescriptor({
        runtime, containerName, agentName, repoName, manifest, profileConfig,
        existingRecord: persistedRecord,
    });
    agents[containerName] = {
        agentName,
        repoName,
        containerImage: image,
        ...(manifestImage && manifestImage !== image ? { manifestImage } : {}),
        ...(llmStartup.enabled ? {
            llmRuntime: {
                architectureId: llmStartup.selection.architectureId,
                catalogId: llmStartup.selection.catalogId,
                catalogRef: llmStartup.selection.catalogRef,
                platform: llmStartup.selection.platform,
                imageDigest: llmStartup.imageDigest,
                policyHash: llmStartup.policyHash,
                reuseHash: llmStartup.reuseHash,
            },
        } : {}),
        createdAt: persistedRecord.createdAt || new Date().toISOString(),
        projectPath: cwd,
        runMode: persistedRecord.runMode,
        develRepo: persistedRecord.develRepo,
        profile: activeProfile,
        type: 'agent',
        runtime: runtimeService.runtime,
        containerId: runtimeService.containerId,
        networkMode: runtimeService.networkMode,
        targetAgentId: runtimeService.targetAgentId,
        effectiveInstanceId: runtimeService.effectiveInstanceId,
        enableGeneration: runtimeService.enableGeneration,
        primaryService: runtimeService.primaryService,
        config: {
            binds: [
                { source: agentLibMountPath, target: '/Agent', ro: true },
                { source: codeMountPath, target: '/code', ro: codeReadOnly },
                ...(useNestedDependencyMounts ? [
                    { source: preparedNodeModulesDir, target: '/code/node_modules', ro: true },
                    { source: preparedNodeModulesDir, target: '/Agent/node_modules', ro: true },
                ] : []),
                ...(runtime === 'podman' ? podmanStagedTargetMounts : []),
                { source: sharedDir, target: '/shared' },
                ...(!isolatedHome ? [{ source: agentHomeDir, target: '/root' }] : []),
                ...(llmStartup.enabled && llmStartup.modelDir ? [{ source: llmStartup.modelDir, target: '/models' }] : []),
                ...(llmStartup.enabled && llmStartup.stateDir ? [{ source: llmStartup.stateDir, target: '/runtime' }] : []),
                ...(llmStartup.enabled && fs.existsSync(llmRuntimeSharedPath) ? [{ source: llmRuntimeSharedPath, target: '/Agent/llm-runtime', ro: true }] : []),
                ...(skillsPathExists && !skillsPathInsideCode && runtime !== 'podman' ? [{ source: agentSkillsPath, target: '/code/skills', ro: skillsReadOnly }] : []),
                { source: cwd, target: cwdMountTarget }
            ],
            env: Array.from(new Set([...declaredEnvNames2, ...llmRuntimeEnvNames])).map((name) => ({ name }))
        }
    };
    if (persistedRecord.auth) {
        agents[containerName].auth = persistedRecord.auth;
    }

    if (persistedRecord.alias) {
        agents[containerName].alias = persistedRecord.alias;
    }
    saveAgentsMap(agents);
    try {
        if (useProfileLifecycle) {
            const lifecycleResult = runProfileLifecycle(agentName, activeProfile, {
                    containerName,
                    agentPath,
                    repoName,
                    manifest,
                    skipInstallHooks: true
                });
            if (!lifecycleResult.success) {
                const details = lifecycleResult.errors.join('; ');
                throw new Error(`[profile] ${agentName}: lifecycle failed (${details})`);
            }
        } else {
            // Preinstall already ran before container start. Runtime containers no
            // longer install dependencies; only postinstall hooks run after boot.
            runPostinstallHook(agentName, containerName, manifest, cwd);
        }
    } catch (error) {
        try { stopAndRemove(containerName); } catch (_) { }
        throw error;
    }
    if (launchExplicitSidecar) {
        try {
            launchAgentSidecar({ containerName, agentCommand: explicitAgentCmd, agentName });
        } catch (error) {
            try { stopAndRemove(containerName); } catch (_) { }
            throw error;
        }
    }
    syncAgentMcpConfig(containerName, path.resolve(agentPath), agentName);
    return containerName;
}

function ensureAgentService(agentName, manifest, agentPath, options = {}) {
    // Check if this agent should use a sandbox runtime instead of containers
    const agentRuntime = getRuntimeForAgent(manifest);
    if (agentRuntime === 'bwrap') {
        try {
            const started = ensureBwrapService(agentName, manifest, agentPath, options);
            return buildUnconfinedServiceDescriptor('bwrap', started, agentName, path.basename(path.dirname(agentPath)));
        } catch (err) {
            throw createHostSandboxStartupError(agentName, 'bwrap', err);
        }
    }
    if (agentRuntime === 'seatbelt') {
        try {
            const started = ensureSeatbeltService(agentName, manifest, agentPath, options);
            return buildUnconfinedServiceDescriptor('seatbelt', started, agentName, path.basename(path.dirname(agentPath)));
        } catch (err) {
            throw createHostSandboxStartupError(agentName, 'seatbelt', err);
        }
    }
    const runtime = getRuntime();

    let containerOverride;
    let aliasOverride;
    let forceRecreate = false;
    let profileNameOverride;
    let routerPortOverride;
    let routerHostOverride;
    if (options && typeof options === 'object') {
        containerOverride = options.containerName;
        aliasOverride = options.alias;
        forceRecreate = options.forceRecreate === true;
        profileNameOverride = options.profileName;
        routerPortOverride = options.routerPort;
        routerHostOverride = options.routerHost;
    }

    const repoName = path.basename(path.dirname(agentPath));
    const containerName = containerOverride || getAgentContainerName(agentName, repoName);
    const snapshot = loadAgentsMap();
    const existingRecord = snapshot[containerName] || {};
    if (!aliasOverride && existingRecord.alias) {
        aliasOverride = existingRecord.alias;
    }

    // Resolve profile config early - needed for port resolution
    const activeProfile = String(profileNameOverride || existingRecord.profile || getActiveProfile()).trim() || getActiveProfile();
    const hasProfileConfig = Boolean(manifest?.profiles && Object.keys(manifest.profiles).length > 0);
    const profileConfig = hasProfileConfig
        ? getProfileConfig(`${repoName}/${agentName}`, activeProfile)
        : null;
    if (hasProfileConfig && !profileConfig) {
        const availableProfiles = Object.keys(manifest.profiles || {});
        throw new Error(`[profile] ${agentName}: profile '${activeProfile}' not found. Available: ${availableProfiles.join(', ')}`);
    }
    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    // LLM-runtime agents get their real image from the hardware-aware catalog in
    // startAgentContainer; tolerate an unresolved manifest container placeholder
    // here (this `image` is only a record fallback below).
    let image = '';
    try {
        image = resolveManifestImage(manifest, profileConfig, { agentName, repoName });
    } catch (err) {
        if (!isLlmRuntimeManifest(manifest, profileConfig)) throw err;
    }
    const runtimeRouterEnv = buildRuntimeRouterEnv(runtime, {
        routerPort: routerPortOverride,
        routerHost: routerHostOverride
    });

    const { raw: explicitAgentCmd } = readManifestAgentCommand(manifest);
    const startCmd = readManifestStartCommand(manifest);
    const withParallelAgent = Boolean(startCmd && explicitAgentCmd);

    if (forceRecreate && containerExists(containerName)) {
        removeContainerForRecreate(runtime, containerName, `ensureAgentService:${agentName}:forceRecreate`);
    }

    if (containerExists(containerName)) {
        const runtimeIdentity = inspectRuntimeIdentity(runtime, containerName);
        const targetAgentId = deriveAgentPrincipalId(repoName, agentName);
        if (!hasReusableRuntimeIdentity(existingRecord, runtime, runtimeIdentity, targetAgentId)) {
            console.log(`[start] ${agentName}: existing container is not tracked by this workspace generation; recreating.`);
            removeContainerForRecreate(runtime, containerName, `ensureAgentService:${agentName}:untrackedContainer`);
        }
    }

    if (containerExists(containerName)) {
        const desired = computeEnvHash(manifest, profileConfig, runtimeRouterEnv, { agentName, repoName });
        const current = getContainerLabel(containerName, 'ploinky.envhash');
        if (desired && desired !== current) {
            debugLog(`[ensureAgentService] ${agentName}: env hash changed (current=${current || '<none>'}, desired=${desired.slice(0, 12)}…), recreating container`);
            removeContainerForRecreate(runtime, containerName, `ensureAgentService:${agentName}:envHashChanged`);
        }
    }

    // LLM runtime: include architecture/catalog/digest/policy in reuse comparison.
    if (containerExists(containerName) && isLlmRuntimeManifest(manifest, profileConfig)) {
        try {
            const desiredEnvHash = computeEnvHash(manifest, profileConfig, runtimeRouterEnv, { agentName, repoName });
            const effectiveNetworkForLlm = profileConfig?.network ?? manifest?.network ?? null;
            const probe = prepareLlmStartup({
                runtime,
                manifest,
                profileConfig,
                agentName,
                alias: aliasOverride,
                env: process.env,
                agentWorkDirRoot: AGENTS_DATA_DIR,
                manifestEnvNames: [
                    ...getManifestEnvNames(manifest, profileConfig),
                    ...getExposedNames(manifest, profileConfig),
                ],
                envHash: desiredEnvHash,
                effectiveNetwork: effectiveNetworkForLlm,
                writeState: false,
            });
            if (probe.enabled) {
                const currentReuse = getContainerLabel(containerName, 'ploinky.reusehash');
                if (probe.reuseHash && probe.reuseHash !== currentReuse) {
                    debugLog(`[ensureAgentService] ${agentName}: LLM reuse hash changed (current=${currentReuse || '<none>'}, desired=${probe.reuseHash.slice(0, 12)}…), recreating container`);
                    removeContainerForRecreate(runtime, containerName, `ensureAgentService:${agentName}:llmReuseHashChanged`);
                }
            }
        } catch (err) {
            debugLog(`[ensureAgentService] ${agentName}: LLM reuse-hash check skipped: ${err?.message || err}`);
        }
    }

    if (containerExists(containerName)) {
        debugLog(`[ensureAgentService] ${agentName}: container exists, checking if running...`);
        let canReuseExisting = true;
        if (!isContainerRunning(containerName)) {
            ensureManifestVolumeHostPaths(manifest);
            syncAgentMcpConfig(containerName, agentPath, agentName);
            try {
                // Capture stderr so an expected reuse failure does not dump an
                // alarming raw runtime error. The common case is a prepared
                // dependency cache that `ploinky update` removed (a moving git dep
                // advanced): the container's node_modules bind-mount source is gone,
                // so `podman start` fails its getxattr check. We recreate from
                // scratch below, which rebuilds the cache cleanly.
                execSync(`${runtime} start ${containerName}`, { stdio: ['ignore', 'inherit', 'pipe'] });
            } catch (e) {
                canReuseExisting = false;
                const detail = String(e?.stderr || '').trim() || e?.message || 'unknown error';
                console.log(`[start] ${agentName}: cannot reuse existing container; recreating.`);
                debugLog(`[ensureAgentService] ${agentName}: reuse via '${runtime} start' failed (${detail}); recreating.`);
                removeContainerForRecreate(runtime, containerName, `ensureAgentService:${agentName}:failedStart`);
            }
            if (canReuseExisting && withParallelAgent) {
                try {
                    launchAgentSidecar({ containerName, agentCommand: explicitAgentCmd, agentName });
                } catch (error) {
                    try { stopAndRemove(containerName); } catch (_) { }
                    throw error;
                }
            }
        }
        if (canReuseExisting) {
            debugLog(`[ensureAgentService] ${agentName}: returning early (container exists)`);
            syncAgentMcpConfig(containerName, agentPath, agentName);
            return buildRuntimeServiceDescriptor({
                runtime, containerName, agentName, repoName, manifest, profileConfig, existingRecord,
            });
        }
    }

    startAgentContainer(agentName, manifest, agentPath, {
        containerName,
        alias: aliasOverride,
        profileName: activeProfile,
        routerPort: runtimeRouterEnv.PLOINKY_ROUTER_PORT,
        routerHost: runtimeRouterEnv.PLOINKY_ROUTER_HOST
    });
    const runtimeService = buildRuntimeServiceDescriptor({
        runtime, containerName, agentName, repoName, manifest, profileConfig, existingRecord,
    });

    const agentCodePath = getAgentCodePath(agentName);
    const agentSkillsPath = getAgentSkillsPath(agentName);
    const profileEnv = normalizeProfileEnv(profileConfig?.env);
    const { codeReadOnly, skillsReadOnly } = getProfileMountModes(activeProfile, runtime, profileConfig || {});

    const agents = loadAgentsMap();
    const startedRecord = agents[containerName] || {};
    const declaredEnvNames3 = [
        ...getManifestEnvNames(manifest, profileConfig),
        ...getExposedNames(manifest, profileConfig),
        ...Object.keys(profileEnv)
    ];
    let projPath = getConfiguredProjectPath(agentName, path.basename(path.dirname(agentPath)), aliasOverride);
    if (!projPath) {
        projPath = existingRecord.projectPath;
    }
    const finalInstanceName = aliasOverride || existingRecord.alias || agentName;
    const finalIsolatedHome = (existingRecord.runMode || 'isolated') === 'isolated';
    const finalAgentWorkDir = getAgentWorkDir(finalInstanceName);
    const finalWorkTarget = finalIsolatedHome ? '/root' : projPath;
    const hasStartedBinds = Array.isArray(startedRecord.config?.binds) && startedRecord.config.binds.length > 0;
    const startedEnvNames = Array.isArray(startedRecord.config?.env)
        ? startedRecord.config.env.map((entry) => String(entry?.name || '').trim()).filter(Boolean)
        : [];
    if (!hasStartedBinds && runtime === 'podman') {
        // Podman relies on the staged code/Agent dirs and the per-target
        // self-mounts created in startAgentContainer. The literal fallback
        // below would record unstaged paths and miss the dependency cache
        // self-mount; refuse rather than silently writing a broken record.
        throw new Error(
            `[ensureAgentService] ${agentName}: missing podman bind record after startAgentContainer; refusing to write a fallback bind list.`
        );
    }
    agents[containerName] = {
        agentName,
        repoName,
        containerImage: startedRecord.containerImage || image,
        ...(startedRecord.manifestImage ? { manifestImage: startedRecord.manifestImage } : {}),
        ...(startedRecord.llmRuntime ? { llmRuntime: startedRecord.llmRuntime } : {}),
        createdAt: existingRecord.createdAt || new Date().toISOString(),
        projectPath: projPath,
        runMode: existingRecord.runMode,
        develRepo: existingRecord.develRepo,
        profile: activeProfile,
        type: 'agent',
        runtime: runtimeService.runtime,
        containerId: runtimeService.containerId,
        networkMode: runtimeService.networkMode,
        targetAgentId: runtimeService.targetAgentId,
        effectiveInstanceId: runtimeService.effectiveInstanceId,
        enableGeneration: runtimeService.enableGeneration,
        primaryService: runtimeService.primaryService,
        config: {
            binds: hasStartedBinds ? startedRecord.config.binds : [
                { source: AGENT_LIB_PATH, target: '/Agent', ro: true },
                { source: agentCodePath, target: '/code', ro: codeReadOnly },
                ...(fs.existsSync(agentSkillsPath) ? [{ source: agentSkillsPath, target: '/code/skills', ro: skillsReadOnly }] : []),
                { source: projPath, target: finalWorkTarget },
                ...(!finalIsolatedHome ? [{ source: finalAgentWorkDir, target: '/root' }] : [])
            ],
            env: Array.from(new Set([...declaredEnvNames3, ...startedEnvNames])).map((name) => ({ name }))
        }
    };
    if (existingRecord.auth) {
        agents[containerName].auth = existingRecord.auth;
    }
    if (aliasOverride) {
        agents[containerName].alias = aliasOverride;
    }
    saveAgentsMap(agents);

    syncAgentMcpConfig(containerName, agentPath, finalInstanceName, { workDir: finalAgentWorkDir });
    return runtimeService;
}

export {
    assertPodmanCodeMountAllowed,
    buildBoxPodmanHostArgs,
    buildDefaultPodmanNetworkArgs,
    buildPodmanStagedTargetMounts,
    buildRuntimeRouterEnv,
    codeRelativeMountPath,
    ensureAgentService,
    ensureManifestVolumeHostPath,
    ensurePodmanStagedCodeDir,
    hasReusableRuntimeIdentity,
    manifestHasRuntimePrimaryService,
    manifestNeedsCoreDependencies,
    resolveRuntimePrimaryService,
    mergeNodeOptions,
    podmanMountSuffix,
    startAgentContainer
};
