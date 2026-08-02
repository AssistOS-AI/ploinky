import { execSync, spawnSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    assertManifestEnvProfileCompleteness,
    buildEnvMap,
    buildEnvFlags,
    formatEnvFlag,
    getExposedNames,
    getManifestEnvNames,
    resolveManifestImage,
    resolveVarValue
} from '../../utils/security/secretVars.js';
import {
    buildAgentCredentialEnv,
    buildAgentPrincipalEnv,
    RESERVED_AGENT_ENV_NAMES,
} from '../../utils/security/agentIdentityEnv.js';
import {
    GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE,
    GENERATED_ROUTER_LOCAL_STREAMING,
    GENERATED_ROUTER_DESCRIPTOR_SCHEMA,
    GENERATED_ROUTER_TRANSPORT_VERSION,
    buildGeneratedRouterDescriptorEnv,
    createGeneratedRouterDescriptorPayload,
    readVerifiedGeneratedRouterDescriptorFile,
    semanticTopologyDigest,
    signGeneratedRouterDescriptorEnvelope,
    writeGeneratedRouterDescriptorFile,
} from '../../utils/security/generatedRouterDescriptor.js';
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
    ensureImagePresent,
    isContainerRunning,
    isSandboxRuntime,
    loadAgentsMap,
    managedContainerLabelArgs,
    parseHostPort,
    parseManifestPorts,
    saveAgentsMap,
    syncAgentMcpConfig
} from './common.js';
import { clearLivenessState, runContainerScriptReadiness } from './healthProbes.js';
import { stopAndRemove } from './containerFleet.js';
import {
    TARGETED_DRAIN_ACKNOWLEDGEMENT,
    drainAndRemoveTargetedContainer,
    drainTargetedContainer,
} from './targetedContainerLifecycle.js';
import { buildContainerSecurityArgs, resolveContainerSecurity } from './containerSecurity.js';
import { DEFAULT_AGENT_ENTRY, launchAgentSidecar, readManifestAgentCommand, readManifestStartCommand, splitCommandArgs } from './agentCommands.js';
import { AGENTS_DATA_DIR, PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import {
    planRuntimeResources,
    applyRuntimeResourceEnv,
    ensurePersistentStorageHostDir
} from '../../utils/runtime/runtimeResourcePlanner.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { ensureSharedHostDir, runPostinstallHook } from './agentHooks.js';
import { ensureBwrapService } from '../bwrap/bwrapServiceManager.js';
import { isBwrapProcessRunning, stopBwrapProcess } from '../bwrap/bwrapFleet.js';
import { ensureSeatbeltService } from '../seatbelt/seatbeltServiceManager.js';
import { detectShellForImage, SHELL_FALLBACK_DIRECT } from './shellDetection.js';
import { detectRuntimeKeyForAgent, isNoNodeRuntimeKey } from '../../utils/dependencies/dependencyRuntimeKey.js';
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
    getDefaultMountModes,
    getProfileEnvVars,
    resolveManifestRuntimeProfile
} from '../../utils/runtime/profileService.js';
import { resolveAgentExecutionMode, resolveAgentReadinessProtocol } from '../../utils/runtime/startupReadiness.js';
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
    resolveManifestVolumeHostPath
} from '../../utils/runtime/manifestVolumePolicy.js';
import {
    isLlmRuntimeManifest,
    prepareLlmStartup,
} from './llmRuntimeIntegration.js';
import {
    assertHostSandboxNetworkCompatibility,
    assertNetworkStartupCompatibility,
    canonicalizeNetwork,
    networkContractHash,
} from '../networkContract.js';
import {
    assertNetworkLifecycleCapability,
    createNetworkLifecycleAdapter,
    withNetworkLifecycleLock,
} from '../networkLifecycle.js';
import { effectiveInstanceKey } from '../../utils/workspaceDependencyGraph.js';
import {
    INITIAL_ROUTER_PORT,
    ROUTER_ENV_NAMES,
    assertRouterEndpoint,
    buildRouterEndpoint,
} from '../routerPort.js';
import {
    abortEdgeRoutingPreparation,
    assertHostModeGenerationCapability,
    createRouterAttestationGenerationLease,
    edgeRuntimeEnvironment,
    edgeTopologyMount,
    inactivateEdgeRoutingGeneration,
    prepareEdgeRoutingGeneration as prepareEdgeRoutingGenerationRaw,
    prepareHostModeCapabilityForInactiveGeneration,
    withEdgeGenerationApplyLock,
} from '../edgeGeneration.js';
import {
    attestRouterAuthority,
    buildRouterAuthorityTopologyIntent,
    managedImageUserNamespace,
    ROUTER_AUTHORITY_HELPER_IMAGE,
    runContainerAuthorityProbe,
} from '../routerAuthorityAttestation.js';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_LIB_PATH = path.resolve(__dirname, '../../../Agent');
const LLM_RUNTIME_SHARED_PATH = path.join(PLOINKY_WORKSPACE_ROOT, 'llm-runtime', 'shared');

function attachRestartCandidate(error, candidate) {
    const failure = error && typeof error === 'object'
        ? error
        : new Error(String(error || 'managed runtime launch failed'));
    const prior = failure.ploinkyRestartCandidate && typeof failure.ploinkyRestartCandidate === 'object'
        ? failure.ploinkyRestartCandidate
        : {};
    Object.defineProperty(failure, 'ploinkyRestartCandidate', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: Object.freeze({ ...prior, ...candidate }),
    });
    return failure;
}
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
const ROUTER_DESCRIPTOR_HOST_DIR = path.join(PLOINKY_DIR, 'run', 'router-descriptors');

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

function shouldPodmanChownManifestVolume(resolvedHostPath, options = {}) {
    if (options?.readOnly === true) return false;
    if (options?.podmanChown === true) return true;
    if (options?.podmanChown === false) return false;

    const dataRoot = path.resolve(PLOINKY_DIR, 'data');
    const resolved = path.resolve(resolvedHostPath);
    return isPathWithin(resolved, dataRoot);
}

function podmanManifestVolumeMountSuffix(resolvedHostPath, options = {}) {
    if (options?.readOnly === true) return ':z,ro';
    return shouldPodmanChownManifestVolume(resolvedHostPath, options) ? ':z,U' : ':z';
}

function manifestVolumeMountSuffix(runtime, resolvedHostPath, options = {}) {
    if (runtime === 'podman') {
        return podmanManifestVolumeMountSuffix(resolvedHostPath, options);
    }
    return options?.readOnly === true ? ':ro' : '';
}

function readVolumeOptions(source) {
    return source?.volumeOptions && typeof source.volumeOptions === 'object'
        ? source.volumeOptions
        : {};
}

function mergeManifestVolumes(manifest, profileConfig = null) {
    return {
        ...(manifest?.volumes && typeof manifest.volumes === 'object' ? manifest.volumes : {}),
        ...(profileConfig?.volumes && typeof profileConfig.volumes === 'object' ? profileConfig.volumes : {}),
    };
}

function mergeManifestVolumeOptions(manifest, profileConfig = null) {
    return {
        ...readVolumeOptions(manifest),
        ...readVolumeOptions(profileConfig),
    };
}

function getVolumeOptionsForContainerPath(volumeOptions, containerPath) {
    return volumeOptions[containerPath]
        || volumeOptions[String(containerPath || '').replace(/\/+$/, '')]
        || {};
}

function collectManifestVolumeEntries(manifest, profileConfig = null) {
    const volumes = mergeManifestVolumes(manifest, profileConfig);
    const volumeOptions = mergeManifestVolumeOptions(manifest, profileConfig);
    return Object.entries(volumes).map(([hostPath, containerPath]) => ({
        hostPath,
        containerPath,
        resolvedHostPath: resolveManifestVolumeHostPath(hostPath),
        options: getVolumeOptionsForContainerPath(volumeOptions, containerPath),
    }));
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

function resolveReusablePodmanStagedMounts(existingRecord, runtimeRoot) {
    const binds = Array.isArray(existingRecord?.config?.binds) ? existingRecord.config.binds : [];
    const resolvedRoot = path.resolve(String(runtimeRoot || ''));
    if (!resolvedRoot || !fs.existsSync(resolvedRoot)) return null;

    const resolveTarget = (target, prefix) => {
        const matches = binds.filter((bind) => String(bind?.target || '') === target);
        if (matches.length !== 1) return null;
        const source = path.resolve(String(matches[0]?.source || ''));
        if (!isPathWithin(source, resolvedRoot)
            || !new RegExp(`^${prefix}-\\d+-\\d+$`).test(path.basename(source))) return null;
        try {
            const identity = fs.lstatSync(source);
            if (!identity.isDirectory() || identity.isSymbolicLink()) return null;
            const realSource = fs.realpathSync(source);
            const realRoot = fs.realpathSync(resolvedRoot);
            if (!isPathWithin(realSource, realRoot)) return null;
        } catch (_) {
            return null;
        }
        return source;
    };

    const agentLibMountPath = resolveTarget('/Agent', 'Agent');
    const codeMountPath = resolveTarget('/code', 'code');
    if (!agentLibMountPath || !codeMountPath) return null;
    return Object.freeze({ agentLibMountPath, codeMountPath });
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

function resolveDependencyCachePreparation({
    needsCoreDeps = false,
    agentHasPackageJson = false,
    isLlmRuntime = false,
    runtimeKey = '',
} = {}) {
    if (!needsCoreDeps) {
        return { prepare: false, fatal: false, reason: 'no-core-deps' };
    }
    if (!isNoNodeRuntimeKey(runtimeKey)) {
        return { prepare: true, fatal: false, reason: 'node-runtime' };
    }
    if (agentHasPackageJson) {
        return {
            prepare: false,
            fatal: true,
            reason: 'no-node-image',
            message: 'container image has no Node binary but the agent has package.json dependencies',
        };
    }
    if (isLlmRuntime) {
        return {
            prepare: false,
            fatal: true,
            reason: 'no-node-image',
            message: 'container image has no Node binary but the LLM runtime requires Node dependency preparation',
        };
    }
    return { prepare: false, fatal: false, reason: 'no-node-image' };
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

function buildRuntimeRouterEnv(runtime, options = {}) {
    const mode = String(options.networkMode || 'default').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(options, 'routerHost')) {
        throw new Error('routerHost overrides are not supported; pass the validated routerEndpoint');
    }
    const endpoint = assertRouterEndpoint(options.routerEndpoint, mode, {
        explicitPort: options.routerPort,
    });
    if (!endpoint) return {};
    return {
        ...endpoint.env,
        ...edgeRuntimeEnvironment(mode),
        PLOINKY_ROUTER_HOST: endpoint.host,
        PLOINKY_ROUTER_PORT: '8080',
    };
}

function buildDefaultPodmanNetworkArgs(platform = process.platform) {
    return [
        '--network', platform === 'darwin' ? 'pasta' : 'pasta:--map-gw',
        ...(platform === 'darwin' ? ['--no-hosts'] : []),
    ];
}

function buildBoxPodmanHostArgs({
    fsApi = fs,
    markerPath,
    managedNetwork = false,
} = {}) {
    const markerOptions = { fsApi };
    if (markerPath) markerOptions.markerPath = markerPath;
    if (!isInsideBox(markerOptions)) return [];
    // Managed default/bridge launches receive this exact mapping from the
    // network lifecycle transaction. Adding it here as well produces two
    // HostConfig.ExtraHosts entries, which the fail-closed verifier rejects.
    if (managedNetwork) return [];
    return ['--add-host', 'host.containers.internal:host-gateway'];
}
function appendRuntimeRouterEnvFlags(envStrings, routerEnv) {
    for (const [name, value] of Object.entries(routerEnv || {})) {
        envStrings.push(formatEnvFlag(name, value));
    }
}

function replaceRuntimeRouterEnvFlags(envStrings, routerEnv) {
    const prefixes = ROUTER_ENV_NAMES.map((name) => `-e ${name}=`);
    for (let index = envStrings.length - 1; index >= 0; index -= 1) {
        if (prefixes.some((prefix) => String(envStrings[index] || '').startsWith(prefix))) {
            envStrings.splice(index, 1);
        }
    }
    appendRuntimeRouterEnvFlags(envStrings, routerEnv);
}

function stripReservedAndRestoreRuntimeRouterEnvFlags(envStrings, routerEnv) {
    const reservedPrefixes = RESERVED_AGENT_ENV_NAMES.map((name) => `-e ${name}=`);
    for (let index = envStrings.length - 1; index >= 0; index -= 1) {
        const entry = String(envStrings[index] || '');
        if (reservedPrefixes.some((prefix) => entry.startsWith(prefix))
            || entry.startsWith('-e PLOINKY_ENV_SOURCE_PLOINKY_')) {
            envStrings.splice(index, 1);
        }
    }
    appendRuntimeRouterEnvFlags(envStrings, routerEnv);
}

function ensureManifestVolumeHostPaths(manifest, profileConfig = null) {
    for (const { resolvedHostPath, containerPath, options } of collectManifestVolumeEntries(manifest, profileConfig)) {
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

function buildRuntimeNetworkPlan(runtime, manifestNetwork, options = {}) {
    const network = canonicalizeNetwork(manifestNetwork, { path: options.path || 'manifest.network' });
    if (network.mode === 'host') {
        return {
            mode: 'host',
            args: ['--network', 'host'],
            useHostNetwork: true,
            boxNetworkCompat: false,
            hashEnv: { PLOINKY_NETWORK_MODE: 'host' },
        };
    }
    if (network.mode === 'none') {
        return {
            mode: 'none',
            args: ['--network', 'none'],
            useHostNetwork: false,
            boxNetworkCompat: false,
            hashEnv: { PLOINKY_NETWORK_MODE: 'none' },
        };
    }
    return {
        mode: network.mode,
        args: [],
        useHostNetwork: false,
        boxNetworkCompat: true,
        requiresManagedNetwork: true,
        hashEnv: { PLOINKY_NETWORK_MODE: network.mode },
    };
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

function normalizeTargetedRestart(value) {
    if (value === undefined || value === null || value === false) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('targetedRestart must be an internal coordinated-restart contract object');
    }
    if (value.acknowledgement !== TARGETED_DRAIN_ACKNOWLEDGEMENT) {
        throw new Error(`targetedRestart.acknowledgement must be '${TARGETED_DRAIN_ACKNOWLEDGEMENT}'`);
    }
    if (!Array.isArray(value.affectedSelectors) || value.affectedSelectors.length < 1) {
        throw new Error('targetedRestart.affectedSelectors must identify at least one exact selector');
    }
    if (typeof value.assertSelectorsInactive !== 'function') {
        throw new Error('targetedRestart.assertSelectorsInactive must prove the exact affected selectors are inactive');
    }
    return Object.freeze({
        acknowledgement: value.acknowledgement,
        affectedSelectors: Object.freeze([...value.affectedSelectors]),
        assertSelectorsInactive: value.assertSelectorsInactive,
        ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    });
}

export function removeAgentContainerForRecreate(containerName, label = 'executionModeChanged') {
    const runtime = getRuntime();
    removeContainerForRecreate(runtime, containerName, label);
}

function buildPersistentAgentRunArgs({
    runtime,
    containerName,
    envHash,
    containerWorkdir,
    agentLibMountPath,
    codeMountPath,
    codeMountMode = '',
    useNestedDependencyMounts = false,
    preparedNodeModulesDir = '',
    sharedDir,
    cwd,
    cwdMountTarget,
    isolatedHome = true,
    agentHomeDir = '',
} = {}) {
    const nodeModulesMount = runtime === 'podman' ? ':z,ro' : ':ro';
    const args = [
        'run', '-d', '--init', '--name', containerName,
        ...managedContainerLabelArgs(),
        '--label', `ploinky.envhash=${envHash}`,
        // Nested Podman must materialize only the binds authorized below. OCI
        // VOLUME declarations would otherwise create unmanaged anonymous mounts.
        ...(runtime === 'podman' ? ['--image-volume=ignore'] : []),
        '-w', containerWorkdir,
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
        '-v', `${cwd}:${cwdMountTarget}${runtime === 'podman' ? ':z' : ''}`,
    ];
    if (!isolatedHome) {
        args.push('-v', `${agentHomeDir}:/root${runtime === 'podman' ? ':z' : ''}`);
    }
    return args;
}

function managedUserNamespaceFromAttestation(attested) {
    const target = attested?.evidence?.target;
    if (!target || typeof target.user !== 'string') {
        throw new Error('managed candidate attestation lacks the image user projection');
    }
    return managedImageUserNamespace(target.user);
}

function managedBindMountFromValue(value) {
    const text = String(value || '');
    const parts = text.split(':');
    if (parts.length < 2) throw new Error(`managed runtime volume '${text}' is invalid`);
    const source = path.resolve(parts.shift());
    const destination = String(parts.shift() || '');
    const options = parts.join(':').split(',').filter(Boolean);
    return Object.freeze({ source, destination, rw: !options.includes('ro') });
}

function appendExactManagedBindMount(args, value) {
    const incoming = managedBindMountFromValue(value);
    for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] !== '-v' && args[index] !== '--volume') continue;
        const existingValue = String(args[index + 1] || '');
        const existing = managedBindMountFromValue(existingValue);
        if (existing.destination !== incoming.destination) continue;
        if (existingValue === String(value)) return false;
        throw new Error(`managed runtime volume target '${incoming.destination}' has conflicting bind grants`);
    }
    args.push('-v', String(value));
    return true;
}

function expectedBindMountsFromArgs(args, descriptorHostFile = '') {
    const specs = [];
    for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] !== '-v' && args[index] !== '--volume') continue;
        specs.push(managedBindMountFromValue(args[index + 1]));
    }
    if (descriptorHostFile) {
        specs.push(Object.freeze({
            source: path.resolve(descriptorHostFile),
            destination: GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE,
            rw: false,
        }));
    }
    return Object.freeze(specs);
}

function hasExactManagedMountContract(record, expectedMounts) {
    const actual = Array.isArray(record?.Mounts) ? record.Mounts : [];
    if (actual.length !== expectedMounts.length) return false;
    const expectedByTarget = new Map();
    for (const mount of expectedMounts) {
        if (!mount.destination || expectedByTarget.has(mount.destination)) return false;
        expectedByTarget.set(mount.destination, mount);
    }
    const observedTargets = new Set();
    for (const mount of actual) {
        const destination = String(mount?.Destination || '');
        const expected = expectedByTarget.get(destination);
        if (!expected || observedTargets.has(destination)
            || String(mount?.Type || 'bind') !== 'bind'
            || path.resolve(String(mount?.Source || '')) !== expected.source
            || Boolean(mount?.RW) !== expected.rw) {
            return false;
        }
        observedTargets.add(destination);
    }
    return observedTargets.size === expectedByTarget.size;
}

function hasExactManagedEnv(record, expectedEnv) {
    const values = new Map();
    for (const entry of record?.Config?.Env || []) {
        const text = String(entry || '');
        const separator = text.indexOf('=');
        const name = separator < 1 ? text : text.slice(0, separator);
        const value = separator < 1 ? '' : text.slice(separator + 1);
        const current = values.get(name) || [];
        current.push(value);
        values.set(name, current);
    }
    return Object.entries(expectedEnv).every(([name, value]) => {
        const observed = values.get(name) || [];
        return observed.length === 1 && observed[0] === String(value);
    });
}

function startAgentContainer(agentName, manifest, agentPath, options = {}) {
    const runtime = getRuntime();
    const repoName = path.basename(path.dirname(agentPath));
    const containerName = options.containerName || getAgentContainerName(agentName, repoName);
    const agentSnapshot = loadAgentsMap();
    const existingRecord = agentSnapshot[containerName] || {};
    const runtimeIdentity = options.runtimeIdentity;
    if (!runtimeIdentity?.instanceId || !runtimeIdentity?.enableGeneration) {
        throw new Error(`startAgentContainer(${agentName}) requires an exact instanceId and enableGeneration`);
    }
    const instanceName = options.alias || existingRecord.alias || agentName;
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

    // Resolve profile and network as one selection. Explicit CLI and persisted
    // profile names fail closed; only a missing global profile falls back to
    // this manifest's default profile.
    const profileResolution = options.profileResolution || resolveManifestRuntimeProfile(manifest, {
        agentName: `${repoName}/${agentName}`,
        profileName: options.profileName,
        persistedProfileName: existingRecord.profile,
        path: `manifest(${repoName}/${agentName})`,
    });
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    const manifestNetwork = profileResolution.network;
    assertNetworkStartupCompatibility(manifest, profileConfig, manifestNetwork, {
        path: `manifest(${repoName}/${agentName})`,
    });
    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const runtimeNetworkPlan = buildRuntimeNetworkPlan(runtime, manifestNetwork);
    if (runtimeNetworkPlan.mode === 'host') {
        // A denied host-mode request must not execute a manifest-controlled host
        // hook or perform any image/dependency/runtime work.
        assertHostModeGenerationCapability({
            agentId: deriveAgentPrincipalId(repoName, agentName),
            instanceId: runtimeIdentity.instanceId,
            enableGeneration: runtimeIdentity.enableGeneration,
            routeKey: instanceName,
            containerName,
        }, { preparedCapability: options.preparedHostModeCapability });
    }
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
    const routerEndpoint = assertRouterEndpoint(options.routerEndpoint, runtimeNetworkPlan.mode, {
        explicitPort: options.routerPort,
    });
    const runtimeRouterEnv = buildRuntimeRouterEnv(runtime, {
        routerEndpoint,
        routerPort: options.routerPort,
        networkMode: runtimeNetworkPlan.mode,
    });
    const envHash = computeEnvHash(manifest, profileConfig, {
        ...runtimeRouterEnv,
        ...runtimeNetworkPlan.hashEnv
    }, { agentName, repoName });

    // LLM runtime opt-in: catalog-driven image, hardware-aware policy, reuse hash.
    // Resolved BEFORE dependency cache prep so the cache uses the selected image.
    const llmRuntimeManifest = isLlmRuntimeManifest(manifest, profileConfig);
    let llmStartup = { enabled: false };
    if (llmRuntimeManifest) {
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
                ...getManifestEnvNames(manifest, profileConfig, { forRuntime: true }),
                ...getExposedNames(manifest, profileConfig, { forRuntime: true }),
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
    const needsCoreDeps = !useStartEntry || agentHasPackageJson || llmRuntimeManifest;
    let preparedNodeModulesDir = path.join(agentWorkDir, 'node_modules');
    if (needsCoreDeps) {
        const runtimeKey = detectRuntimeKeyForAgent(manifest, repoName, agentName, profileConfig, image);
        const dependencyPlan = resolveDependencyCachePreparation({
            needsCoreDeps,
            agentHasPackageJson,
            isLlmRuntime: llmRuntimeManifest,
            runtimeKey,
        });
        if (dependencyPlan.fatal) {
            throw new Error(`[deps] ${agentName}: ${dependencyPlan.message}.`);
        }
        if (dependencyPlan.prepare) {
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
            debugLog(`[deps] ${agentName}: Skipping dependency cache prep (${dependencyPlan.reason})`);
            if (!fs.existsSync(preparedNodeModulesDir)) {
                fs.mkdirSync(preparedNodeModulesDir, { recursive: true });
            }
        }
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
    for (const { resolvedHostPath, containerPath, options } of collectManifestVolumeEntries(manifest, profileConfig)) {
        ensureManifestVolumeHostPath(resolvedHostPath, containerPath, options);
        const codeRelPath = runtime === 'podman' ? codeRelativeMountPath(containerPath) : null;
        if (codeRelPath) {
            assertPodmanCodeMountAllowed(codeRelPath, containerPath);
            podmanCodeLinks.set(codeRelPath, {
                hostPath: resolvedHostPath,
                readOnly: options?.readOnly === true,
            });
        } else {
            manifestVolumeMounts.push({ resolvedHostPath, containerPath, options });
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
        const podmanRuntimeRoot = path.join(PODMAN_RUNTIME_ROOT, runtimeSegment(containerName));
        const reusableStagedMounts = options.reuseStagedMounts === true
            ? resolveReusablePodmanStagedMounts(existingRecord, podmanRuntimeRoot)
            : null;
        if (reusableStagedMounts) {
            agentLibMountPath = reusableStagedMounts.agentLibMountPath;
            codeMountPath = reusableStagedMounts.codeMountPath;
        } else {
            prepareFreshRuntimeRoot(podmanRuntimeRoot, PODMAN_RUNTIME_ROOT);
            agentLibMountPath = ensurePodmanStagedAgentLibDir(agentName, preparedNodeModulesDir, {
                runtimeRoot: podmanRuntimeRoot
            });
            codeMountPath = ensurePodmanStagedCodeDir(agentName, agentCodePath, preparedNodeModulesDir, podmanCodeLinks, {
                runtimeRoot: podmanRuntimeRoot
            });
        }
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
    const containerWorkdir = isolatedHome ? '/root' : (String(manifest?.workdir || '/code').trim() || '/code');
    const args = buildPersistentAgentRunArgs({
        runtime,
        containerName,
        envHash,
        containerWorkdir,
        agentLibMountPath,
        codeMountPath,
        codeMountMode,
        useNestedDependencyMounts,
        preparedNodeModulesDir,
        sharedDir,
        cwd,
        cwdMountTarget,
        isolatedHome,
        agentHomeDir,
    });
    const topologyMount = edgeTopologyMount();
    fs.mkdirSync(topologyMount.source, { recursive: true, mode: 0o700 });
    args.push('-v', `${topologyMount.source}:${topologyMount.target}${runtime === 'podman' ? ':z,ro' : ':ro'}`);

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
    const useHostNetwork = runtimeNetworkPlan.useHostNetwork;
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

    const networkLifecycle = createNetworkLifecycleAdapter({ runtime });
    const unmanagedNetworkLifecyclePlan = runtimeNetworkPlan.requiresManagedNetwork
        ? null
        : {
            mode: runtimeNetworkPlan.mode,
            args: runtimeNetworkPlan.args,
            attachments: [],
            created: [],
        };
    args.splice(1, 0, ...networkLifecycle.agentIdentityLabelArgs(manifestNetwork, runtimeIdentity));

    for (const { resolvedHostPath, containerPath, options } of manifestVolumeMounts) {
        const mountSuffix = manifestVolumeMountSuffix(runtime, resolvedHostPath, options);
        appendExactManagedBindMount(args, `${resolvedHostPath}:${containerPath}${mountSuffix}`);
    }
    if (runtime === 'podman') {
        const boxHostArgs = buildBoxPodmanHostArgs({
            managedNetwork: runtimeNetworkPlan.requiresManagedNetwork === true,
        });
        if (boxHostArgs.length) args.splice(1, 0, ...boxHostArgs);
    }

    const { publishArgs: manifestPorts, portMappings } = parseManifestPorts(manifest, profileConfig);
    const runtimePorts = (options && Array.isArray(options.publish)) ? options.publish : [];
    const runtimePortMappings = (options && Array.isArray(options.publishMappings)) ? options.publishMappings : [];
    const effectivePortMappings = [...portMappings, ...runtimePortMappings];
    assertHostPortContract(runtimeNetworkPlan.mode, effectivePortMappings);
    const pubs = (useHostNetwork || runtimeNetworkPlan.mode === 'none')
        ? []
        : [...manifestPorts, ...runtimePorts];
    for (const p of pubs) {
        if (!p) continue;
        args.splice(1, 0, '-p', String(p));
    }

    // Manifest-driven runtime resources (persistent storage + declared env).
    // Replaces former agentName-specific runtime wiring with manifest-driven resources.
    const resourcePlan = planRuntimeResources(manifest, { agentName, repoName });
    if (resourcePlan.persistentStorage) {
        ensurePersistentStorageHostDir(resourcePlan);
        args.push('-v', `${resourcePlan.persistentStorage.hostPath}:${resourcePlan.persistentStorage.containerPath}${runtime === 'podman' ? ':z' : ''}`);
    }

    const envStrings = [
        ...buildEnvFlags(manifest, profileConfig, { agentName, repoName, profileName: activeProfile, forRuntime: true }),
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

    // Router discovery is runtime-owned. Remove every manifest/profile/secret
    // value first; none mode remains empty while routable modes receive only
    // the already validated canonical endpoint.
    // Router discovery and every credential remain absent until the exact
    // managed-network listener attestation succeeds under the network lock.
    // Unmanaged/unsupported paths therefore remain safely non-key-capable.
    replaceRuntimeRouterEnvFlags(envStrings, {});
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
    // re-assert the authoritative Router locators and agent identity LAST so no
    // config can redirect the runtime, inject a master key, or override the
    // agent's derived secret.
    stripReservedAndRestoreRuntimeRouterEnvFlags(envStrings, {});
    // Only non-secret principal fields exist before topology attestation.
    for (const [key, value] of Object.entries(buildAgentPrincipalEnv(
        deriveAgentPrincipalId(path.basename(path.dirname(agentPath)), agentName),
        runtimeIdentity,
    ))) {
        envStrings.push(formatEnvFlag(key, value));
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

    const principalId = deriveAgentPrincipalId(repoName, agentName);
    const computeSemanticEnvHash = (payload) => computeEnvHash(manifest, profileConfig, {
        ...runtimeNetworkPlan.hashEnv,
        PLOINKY_ROUTER_SEMANTIC_TOPOLOGY_DIGEST: payload.semanticTopologyDigest,
        PLOINKY_ROUTER_DESCRIPTOR_SCHEMA: payload.schema,
        PLOINKY_ROUTER_TRANSPORT_VERSION: payload.transportVersion,
        PLOINKY_ROUTER_LOCAL_STREAMING: payload.localStreaming,
        PLOINKY_AGENT_PRINCIPAL: principalId,
        PLOINKY_AGENT_INSTANCE_ID: runtimeIdentity.instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: runtimeIdentity.enableGeneration,
    }, { agentName, repoName });
    const prepareGeneratedRouterAttestation = (plan) => {
        if (runtime !== 'podman' || !['default', 'bridge'].includes(plan?.mode)) {
            throw new Error('generated-local Router credentials require the exact verified managed Podman transaction');
        }
        const generationLease = createRouterAttestationGenerationLease({
            ...(runtimeIdentity.preparationLease
                ? { preparationLease: runtimeIdentity.preparationLease }
                : {}),
            expectedOwner: {
                containerName,
                principal: principalId,
                instanceId: runtimeIdentity.instanceId,
                enableGeneration: runtimeIdentity.enableGeneration,
            },
        });
        const intent = buildRouterAuthorityTopologyIntent({
            networkMode: plan.mode,
            runtimeProof: plan.runtimeProof,
            networkFingerprint: plan.networkFingerprint,
            runtimeKind: 'container',
            edgeTopologyFile: runtimeRouterEnv.PLOINKY_EDGE_TOPOLOGY_FILE,
        });
        const attested = attestRouterAuthority({
            intent,
            generationLease,
            runProbe: ({ intent: probeIntent, nonce }) => runContainerAuthorityProbe({
                runtime,
                plan,
                image,
                intent: probeIntent,
                nonce,
            }),
        });
        // The first commit is owned by attestRouterAuthority immediately after
        // both observations. The second occurs directly before any signing-key
        // access or API-key minting.
        generationLease.checkpoint('pre-credentials');
        return Object.freeze({ generationLease, intent, attested });
    };
    const prepareGeneratedRouterLaunch = (plan) => {
        const { generationLease, intent, attested } = prepareGeneratedRouterAttestation(plan);
        const launchId = randomUUID();
        const payload = createGeneratedRouterDescriptorPayload({
            agentPrincipal: principalId,
            attestationId: attested.attestationId,
            edgeTopologyFile: intent.edgeTopologyFile,
            generationId: runtimeIdentity.enableGeneration,
            instanceId: runtimeIdentity.instanceId,
            internalRouterUrl: intent.internalRouterUrl,
            issuedAtUnixMs: Date.now(),
            launchId,
            listenerClass: intent.listenerClass,
            networkFingerprint: intent.networkFingerprint,
            physicalOrigin: intent.physicalOrigin,
            publicAuthority: intent.publicAuthority,
            requestAuthority: intent.requestAuthority,
            routerHost: intent.routerHost,
            routerPort: intent.routerPort,
            runtimeProof: intent.runtimeProof,
            socketLocalAddressClass: intent.socketLocalAddressClass,
            topology: intent.topology,
        });
        const signed = signGeneratedRouterDescriptorEnvelope(payload);
        const descriptorHostFile = path.join(ROUTER_DESCRIPTOR_HOST_DIR, `${launchId}.json`);
        writeGeneratedRouterDescriptorFile(descriptorHostFile, signed.bytes);
        const descriptorIdentity = fs.lstatSync(descriptorHostFile);
        if (!descriptorIdentity.isFile() || descriptorIdentity.isSymbolicLink()
            || (descriptorIdentity.mode & 0o777) !== 0o600) {
            throw new Error('generated Router descriptor launch artifact identity is invalid');
        }
        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            try {
                const current = fs.lstatSync(descriptorHostFile);
                if (!current.isFile() || current.isSymbolicLink()
                    || current.dev !== descriptorIdentity.dev
                    || current.ino !== descriptorIdentity.ino
                    || (current.mode & 0o777) !== 0o600) {
                    throw new Error('generated Router descriptor launch artifact identity changed before cleanup');
                }
                fs.unlinkSync(descriptorHostFile);
                cleaned = true;
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
                cleaned = true;
            }
        };
        try {
            const launchEnv = Object.freeze({
                ...buildGeneratedRouterDescriptorEnv(payload),
                ...buildAgentCredentialEnv(principalId, runtimeIdentity),
            });
            const semanticEnvHash = computeSemanticEnvHash(payload);
            return Object.freeze({
                attested,
                cleanup,
                descriptorHostFile,
                env: launchEnv,
                envHash: semanticEnvHash,
                generationLease,
            });
        } catch (error) {
            cleanup();
            throw error;
        }
    };

    const inspectGeneratedRouterAdoption = ({ plan, record }) => {
        const { generationLease, intent, attested } = prepareGeneratedRouterAttestation(plan);
        try {
            const descriptorMounts = (record?.Mounts || []).filter((mount) => (
                String(mount?.Destination || '') === GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE
            ));
            if (descriptorMounts.length !== 1 || descriptorMounts[0]?.RW !== false) {
                return { adopted: false, reason: 'descriptor-mount' };
            }
            const descriptorHostFile = path.resolve(String(descriptorMounts[0]?.Source || ''));
            const verified = readVerifiedGeneratedRouterDescriptorFile(descriptorHostFile);
            const payload = verified.payload;
            const expectedSemanticDigest = semanticTopologyDigest({
                listenerClass: intent.listenerClass,
                localStreaming: GENERATED_ROUTER_LOCAL_STREAMING,
                networkFingerprint: intent.networkFingerprint,
                physicalOrigin: intent.physicalOrigin,
                publicAuthority: intent.publicAuthority,
                requestAuthority: intent.requestAuthority,
                runtimeProof: intent.runtimeProof,
                socketLocalAddressClass: intent.socketLocalAddressClass,
                topology: intent.topology,
                transportVersion: GENERATED_ROUTER_TRANSPORT_VERSION,
            });
            const exactPayload = payload.agentPrincipal === principalId
                && payload.instanceId === runtimeIdentity.instanceId
                && payload.generationId === runtimeIdentity.enableGeneration
                && payload.edgeTopologyFile === intent.edgeTopologyFile
                && payload.schema === GENERATED_ROUTER_DESCRIPTOR_SCHEMA
                && payload.transportVersion === GENERATED_ROUTER_TRANSPORT_VERSION
                && payload.localStreaming === GENERATED_ROUTER_LOCAL_STREAMING
                && payload.semanticTopologyDigest === expectedSemanticDigest;
            if (!exactPayload) return { adopted: false, reason: 'descriptor-semantics' };

            const descriptorEnv = buildGeneratedRouterDescriptorEnv(payload);
            const credentialEnv = buildAgentCredentialEnv(principalId, runtimeIdentity);
            const expectedEnv = Object.freeze({ ...descriptorEnv, ...credentialEnv });
            const expectedMounts = expectedBindMountsFromArgs(args, descriptorHostFile);
            const expectedEnvHash = computeSemanticEnvHash(payload);
            if (!hasExactManagedEnv(record, expectedEnv)) {
                return { adopted: false, reason: 'generated-env-contract' };
            }
            if (record?.HostConfig?.Init !== true
                || String(record?.Image || '') !== String(attested.evidence.target.image || '')
                || String(record?.Config?.User || '') !== String(attested.evidence.target.user || '')
                || String(record?.HostConfig?.Annotations?.['io.podman.annotations.userns'] || '')
                    !== managedUserNamespaceFromAttestation(attested)
                || String(record?.Config?.WorkingDir || '') !== containerWorkdir
                || String(record?.Config?.Labels?.['ploinky.envhash'] || record?.Labels?.['ploinky.envhash'] || '') !== expectedEnvHash
                || !hasExactManagedMountContract(record, expectedMounts)) {
                return { adopted: false, reason: 'runtime-contract' };
            }
            generationLease.checkpoint('pre-runtime');
            return {
                adopted: true,
                launch: Object.freeze({
                    adopted: true,
                    attested,
                    descriptorHostFile,
                    env: expectedEnv,
                    generationLease,
                    payload,
                }),
                finalize(finalRecord) {
                    const finalVerified = readVerifiedGeneratedRouterDescriptorFile(descriptorHostFile);
                    if (finalVerified.identity.dev !== verified.identity.dev
                        || finalVerified.identity.ino !== verified.identity.ino
                        || finalVerified.identity.size !== verified.identity.size
                        || finalVerified.payload.semanticTopologyDigest !== expectedSemanticDigest
                        || finalVerified.payload.agentPrincipal !== principalId
                        || finalVerified.payload.instanceId !== runtimeIdentity.instanceId
                        || finalVerified.payload.generationId !== runtimeIdentity.enableGeneration
                        || String(finalRecord?.Config?.WorkingDir || '') !== containerWorkdir
                        || String(finalRecord?.Config?.Labels?.['ploinky.envhash'] || finalRecord?.Labels?.['ploinky.envhash'] || '') !== expectedEnvHash
                        || !hasExactManagedEnv(finalRecord, expectedEnv)
                        || !hasExactManagedMountContract(finalRecord, expectedMounts)) {
                        throw new Error('managed adoption descriptor changed during final inspection');
                    }
                    generationLease.checkpoint('post-inspection');
                    if (generationLease.complete !== true) {
                        throw new Error('managed adoption did not complete all Router generation checkpoints');
                    }
                },
            };
        } catch (error) {
            return { adopted: false, reason: `descriptor-invalid:${error?.code || error?.message || 'unknown'}` };
        }
    };

    const preStartGeneratedRouterLaunch = ({ launch }) => {
        if (!launch) throw new Error('managed generated-local launch is missing before runtime start');
        launch.generationLease.checkpoint('pre-runtime');
    };

    const finalizeGeneratedRouterLaunch = ({ launch, record }) => {
        if (!launch) throw new Error('managed generated-local launch is missing its attested launch state');
        const expectedMounts = expectedBindMountsFromArgs(args, launch.descriptorHostFile);
        if (!hasExactManagedEnv(record, launch.env)) {
            throw new Error('managed candidate generated Router env failed exact inspection');
        }
        const descriptorMounts = (record?.Mounts || []).filter((mount) => (
            String(mount?.Destination || '') === GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE
        ));
        if (descriptorMounts.length !== 1
            || path.resolve(String(descriptorMounts[0]?.Source || '')) !== path.resolve(launch.descriptorHostFile)
            || descriptorMounts[0]?.RW !== false
            || record?.HostConfig?.Init !== true
            || String(record?.Image || '') !== String(launch.attested.evidence.target.image || '')
            || String(record?.Config?.User || '') !== String(launch.attested.evidence.target.user || '')
            || String(record?.HostConfig?.Annotations?.['io.podman.annotations.userns'] || '')
                !== managedUserNamespaceFromAttestation(launch.attested)
            || String(record?.Config?.WorkingDir || '') !== containerWorkdir
            || String(record?.Config?.Labels?.['ploinky.envhash'] || record?.Labels?.['ploinky.envhash'] || '') !== launch.envHash
            || !hasExactManagedMountContract(record, expectedMounts)) {
            throw new Error('managed candidate image/init/user/descriptor inspection failed');
        }
        launch.generationLease.checkpoint('post-inspection');
        if (launch.generationLease.complete !== true) {
            throw new Error('managed candidate did not complete all Router generation checkpoints');
        }
    };

    const detachedIndex = args.indexOf('-d');
    if (detachedIndex !== -1) args.splice(detachedIndex, 1);
    args[0] = 'create';
    console.log(`[start] ${agentName}: ${runtime} create (cwd='${cwd}') -> ${entrySummary}`);
    const createContainer = (plan, launch) => {
        const createArgs = [...args];
        if (plan?.args?.length) createArgs.splice(1, 0, ...plan.args);
        if (launch) {
            for (let index = 0; index < createArgs.length - 1; index += 1) {
                if (createArgs[index] === '--label' && String(createArgs[index + 1]).startsWith('ploinky.envhash=')) {
                    createArgs[index + 1] = `ploinky.envhash=${launch.envHash}`;
                }
            }
            const imageIndex = createArgs.indexOf(image);
            if (imageIndex < 1) throw new Error('managed candidate image position is unavailable');
            const userNamespace = managedUserNamespaceFromAttestation(launch.attested);
            createArgs.splice(imageIndex, 0,
                ...(userNamespace ? [`--userns=${userNamespace}`] : []),
                '-v', `${launch.descriptorHostFile}:${GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE}:z,ro`,
                ...flagsToArgs(Object.entries(launch.env).map(([name, value]) => formatEnvFlag(name, value))),
            );
        } else if (['default', 'bridge'].includes(plan?.mode)) {
            throw new Error('managed generated-local launch state is required before container creation');
        }
        const res = spawnSync(runtime, createArgs, { stdio: 'inherit' });
        if (res.status !== 0) throw new Error(`${runtime} create failed with code ${res.status}`);
    };
    let launchedContainerId = '';
    let generatedLaunch = null;
    let adoptedExistingRuntime = false;
    if (runtimeNetworkPlan.requiresManagedNetwork) {
        // Resolve both the target and fixed probe images before the network
        // transaction. The helper never pulls and never executes target-image
        // entrypoints, including start-only images without Node.js.
        ensureImagePresent(image, { runtime });
        ensureImagePresent(ROUTER_AUTHORITY_HELPER_IMAGE, { runtime });
        const launched = networkLifecycle.runManagedContainerTransaction({
            network: manifestNetwork,
            canonicalAgentId: agentName,
            instanceKey: effectiveInstanceKey(repoName, agentName, options.alias || ''),
            containerName,
            runtimeIdentity,
            createContainer,
            inspectAdoption: inspectGeneratedRouterAdoption,
            prepareLaunch: prepareGeneratedRouterLaunch,
            preStartLaunch: preStartGeneratedRouterLaunch,
            finalizeLaunch: finalizeGeneratedRouterLaunch,
            networkLockWaitMs: options.networkLockWaitMs,
            networkLifecycleCapability: options.networkLifecycleCapability,
        });
        launchedContainerId = String(launched?.containerId || '');
        generatedLaunch = launched?.launch || null;
        adoptedExistingRuntime = launched?.adopted === true;
        clearLivenessState(containerName);
    } else {
        // All manifest/profile/port/image/mount validation above is complete.
        // Only now is the old host/none container deliberately replaced.
        removeContainerForRecreate(runtime, containerName, `startAgentContainer:${agentName}`);
        createContainer(unmanagedNetworkLifecyclePlan);
        launchedContainerId = String(networkLifecycle.finalizeContainer(containerName, unmanagedNetworkLifecyclePlan, {
            network: manifestNetwork,
            runtimeIdentity,
        }) || '');
    }
    if (!launchedContainerId) {
        throw new Error(`startAgentContainer(${agentName}) did not capture an immutable container ID`);
    }
    const exactLaunchReceipt = Object.freeze({
        containerName,
        containerId: launchedContainerId,
        runtimeNetwork: structuredClone(manifestNetwork),
        registryRecord: Object.freeze({
            type: 'agent',
            agentName,
            repoName,
            ...(options.alias ? { alias: options.alias } : {}),
            instanceId: runtimeIdentity.instanceId,
            enableGeneration: runtimeIdentity.enableGeneration,
        }),
    });
    const cleanupExactLaunch = (error) => {
        let exactCleanupPerformed = false;
        try {
            const cleanup = networkLifecycle.removeExactContainer(
                containerName,
                manifestNetwork,
                agentName,
                {
                    expectedContainerId: launchedContainerId,
                    instanceKey: effectiveInstanceKey(repoName, agentName, options.alias || ''),
                    contractHash: networkContractHash(manifestNetwork),
                    instanceId: runtimeIdentity.instanceId,
                    enableGeneration: runtimeIdentity.enableGeneration,
                },
            );
            exactCleanupPerformed = cleanup.removed === true || cleanup.state === 'absent';
            if (!exactCleanupPerformed) {
                appendExactCleanupFailure(error, cleanup.reason || cleanup.state || 'ownership mismatch');
            }
        } catch (cleanupError) {
            appendExactCleanupFailure(error, cleanupError?.message || cleanupError);
        }
        if (exactCleanupPerformed && generatedLaunch?.cleanup) {
            try { generatedLaunch.cleanup(); } catch (cleanupError) {
                appendExactCleanupFailure(error, `descriptor cleanup: ${cleanupError?.message || cleanupError}`);
            }
        } else if (!exactCleanupPerformed && generatedLaunch?.cleanup) {
            appendExactCleanupFailure(error, 'descriptor preserved because exact candidate absence was not proven');
        }
        clearLivenessState(containerName);
        throw attachRestartCandidate(error, {
            ...exactLaunchReceipt,
            exactCleanupPerformed,
        });
    };
    const agents = loadAgentsMap();
    const declaredEnvNames2 = [
        ...getManifestEnvNames(manifest, profileConfig, { forRuntime: true }),
        ...getExposedNames(manifest, profileConfig, { forRuntime: true }),
        ...Object.keys(profileEnv)
    ];
    const llmRuntimeEnvNames = llmStartup.enabled
        ? ['HF_HOME', 'PLOINKY_MODELS_DIR', 'PLOINKY_DERIVED_DIR', 'PLOINKY_RUNTIME_DIR', 'PLOINKY_LAUNCHERS_DIR', 'PLOINKY_MCP_PORT', 'PLOINKY_LLM_PUBLIC_PORT', 'PLOINKY_LLM_MCP_PORT', 'PLOINKY_LLM_CONTROL_PORT', 'PLOINKY_INFERENCE_PORT']
        : [];
    const persistedRecord = agents[containerName] || existingRecord;
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
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        config: {
            binds: [
                { source: agentLibMountPath, target: '/Agent', ro: true },
                { source: topologyMount.source, target: topologyMount.target, ro: true },
                ...(generatedLaunch ? [{
                    source: generatedLaunch.descriptorHostFile,
                    target: GENERATED_ROUTER_DESCRIPTOR_CONTAINER_FILE,
                    ro: true,
                    generatedRouterDescriptor: true,
                }] : []),
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
            env: Array.from(new Set([...declaredEnvNames2, ...llmRuntimeEnvNames])).map((name) => ({ name })),
            ports: runtimeNetworkPlan.mode === 'host' || runtimeNetworkPlan.mode === 'none'
                ? []
                : effectivePortMappings,
        }
    };
    if (persistedRecord.auth) {
        agents[containerName].auth = persistedRecord.auth;
    }

    if (persistedRecord.alias) {
        agents[containerName].alias = persistedRecord.alias;
    }
    if (options.preserveRegistryRecord !== true) saveAgentsMap(agents);
    const registryRecord = structuredClone(agents[containerName]);
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
        cleanupExactLaunch(error);
    }
    if (launchExplicitSidecar) {
        try {
            launchAgentSidecar({ containerName, agentCommand: explicitAgentCmd, agentName });
        } catch (error) {
            cleanupExactLaunch(error);
        }
    }
    try {
        syncAgentMcpConfig(containerName, path.resolve(agentPath), agentName);
    } catch (error) {
        cleanupExactLaunch(error);
    }
    return {
        containerName,
        containerId: launchedContainerId,
        createdByThisLaunch: !adoptedExistingRuntime,
        runtimeNetwork: structuredClone(manifestNetwork),
        registryRecord,
    };
}

function resolveHostPort(containerName, existingRecord, containerPortCandidates) {
    const fromRecord = resolveHostPortFromRecord(existingRecord, containerPortCandidates);
    if (fromRecord) return fromRecord;
    return resolveHostPortFromRuntime(containerName, containerPortCandidates);
}

function resolveHostPortFromRecord(record, containerPortCandidates) {
    const ports = record?.config?.ports;
    if (!Array.isArray(ports) || !ports.length) return 0;
    for (const containerPort of containerPortCandidates) {
        const match = ports.find((p) => p && p.containerPort === containerPort);
        if (match?.hostPort) {
            return match.hostPort;
        }
    }
    return ports[0]?.hostPort || 0;
}

function resolveHostPortFromRuntime(containerName, containerPortCandidates) {
    const runtime = getRuntime();
    for (const containerPort of containerPortCandidates) {
        try {
            const portMap = execSync(`${runtime} port ${containerName} ${containerPort}/tcp`, { stdio: 'pipe' }).toString().trim();
            const hostPort = parseHostPort(portMap);
            if (hostPort) {
                return hostPort;
            }
        } catch (_) {
            // ignore and try next
        }
    }
    return 0;
}

function resolvePublishedPortMappings(containerName, portMappings) {
    if (!Array.isArray(portMappings) || portMappings.length === 0) {
        return [];
    }
    return portMappings.map((mapping) => {
        const hostPort = Number(mapping?.hostPort);
        const containerPort = Number(mapping?.containerPort);
        if (!Number.isFinite(containerPort) || containerPort <= 0) {
            return mapping;
        }
        if (Number.isFinite(hostPort) && hostPort > 0) {
            return mapping;
        }
        const resolvedHostPort = resolveHostPortFromRuntime(containerName, [containerPort]);
        return resolvedHostPort > 0
            ? { ...mapping, hostPort: resolvedHostPort }
            : mapping;
    });
}

function resolveImplicitAgentServerPort(profileConfig = {}, resolvedEnv = null) {
    let rawPort = resolvedEnv && Object.hasOwn(resolvedEnv, 'PORT')
        ? resolvedEnv.PORT
        : profileConfig?.env?.PORT;
    if (rawPort && typeof rawPort === 'object' && !Array.isArray(rawPort)) {
        rawPort = Object.hasOwn(rawPort, 'value')
            ? rawPort.value
            : rawPort.default;
    }
    if (rawPort === undefined || rawPort === null || String(rawPort).trim() === '') {
        return 7000;
    }
    const text = String(rawPort).trim();
    if (!/^[0-9]+$/.test(text)) {
        throw new Error(`implicit AgentServer PORT must be an integer from 1 through 65535, got '${text}'`);
    }
    const port = Number(text);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error(`implicit AgentServer PORT must be an integer from 1 through 65535, got '${text}'`);
    }
    return port;
}

function shouldCreateImplicitAgentServerPublish(
    manifest,
    manifestPorts = [],
    networkMode = 'default',
    portMappings = [],
    agentServerPort = 7000,
) {
    if (networkMode === 'host' || networkMode === 'none') return false;
    if (Array.isArray(portMappings) && portMappings.some(
        (mapping) => Number(mapping?.containerPort) === Number(agentServerPort),
    )) {
        return false;
    }
    return resolveAgentExecutionMode(manifest).type !== 'start_only';
}

function appendUniquePortMapping(portMappings, mapping) {
    const current = Array.isArray(portMappings) ? [...portMappings] : [];
    const containerPort = Number(mapping?.containerPort);
    const protocol = String(mapping?.protocol || 'tcp').trim().toLowerCase() || 'tcp';
    const exists = current.some((entry) => (
        Number(entry?.containerPort) === containerPort
        && (String(entry?.protocol || 'tcp').trim().toLowerCase() || 'tcp') === protocol
    ));
    return exists ? current : [...current, mapping];
}

function assertHostPortContract(networkMode, portMappings) {
    if (networkMode !== 'host') return;
    const remapped = (portMappings || []).find((mapping) => (
        Number(mapping?.hostPort) !== Number(mapping?.containerPort)
    ));
    if (remapped) {
        throw new Error(
            `direct host network mode cannot remap external port ${remapped.hostPort} to private port ${remapped.containerPort}; the ports must match`,
        );
    }
}

export function assertPreparedRegistryRecordPreservation(existingRecord, options = {}, {
    ownerRef = 'agent',
} = {}) {
    if (options.preservePreparedRegistryRecord !== true) return false;
    const stagedInstanceId = String(existingRecord?.instanceId || '');
    const stagedEnableGeneration = String(existingRecord?.enableGeneration || '');
    const requestedInstanceId = String(options.instanceId || stagedInstanceId);
    const requestedEnableGeneration = String(options.enableGeneration || stagedEnableGeneration);
    if (!stagedInstanceId || !stagedEnableGeneration
        || requestedInstanceId !== stagedInstanceId
        || requestedEnableGeneration !== stagedEnableGeneration) {
        throw new Error(
            `preserving the prepared registry record for ${ownerRef} requires its exact staged instanceId/enableGeneration`,
        );
    }
    return true;
}

function mintReplacementRuntimeIdentity(existingRecord, uuid = randomUUID) {
    const instanceId = String(uuid() || '').trim();
    const enableGeneration = String(uuid() || '').trim();
    if (!instanceId || !enableGeneration
        || instanceId === enableGeneration
        || instanceId === String(existingRecord?.instanceId || '')
        || instanceId === String(existingRecord?.enableGeneration || '')
        || enableGeneration === String(existingRecord?.instanceId || '')
        || enableGeneration === String(existingRecord?.enableGeneration || '')) {
        throw new Error('replacement runtime identity mint did not produce a fresh instanceId and enableGeneration');
    }
    return Object.freeze({ instanceId, enableGeneration });
}

export function coordinateReplacementRuntimeIdentity({
    containerName,
    existingRecord,
    reason = 'runtime-replacement',
    networkLifecycleCapability,
} = {}, {
    assertNetworkCapability = assertNetworkLifecycleCapability,
    prepare = prepareEdgeRoutingGenerationRaw,
    inactivate = inactivateEdgeRoutingGeneration,
    loadRegistry = loadAgentsMap,
    saveRegistry = saveAgentsMap,
    withApplyLock = withEdgeGenerationApplyLock,
    uuid = randomUUID,
} = {}) {
    const exactContainerName = String(containerName || '').trim();
    if (!exactContainerName) {
        throw new Error('coordinated runtime replacement requires an exact container name');
    }
    assertNetworkCapability(networkLifecycleCapability);

    const coordinationReason = `runtime-identity-rotation:${String(reason || 'runtime-replacement')}:${exactContainerName}`;
    let runtimeIdentity;
    let prepared;
    withApplyLock((applyLockCapability) => {
        inactivate(coordinationReason, { applyLockCapability });

        const agents = loadRegistry();
        const current = agents?.[exactContainerName];
        if (!current || current.type !== 'agent') {
            throw new Error(`runtime replacement for '${exactContainerName}' requires one exact registered agent record`);
        }
        if (String(current.instanceId || '') !== String(existingRecord?.instanceId || '')
            || String(current.enableGeneration || '') !== String(existingRecord?.enableGeneration || '')) {
            throw new Error(`runtime identity for '${exactContainerName}' changed before coordinated replacement`);
        }

        runtimeIdentity = mintReplacementRuntimeIdentity(current, uuid);
        agents[exactContainerName] = {
            ...current,
            instanceId: runtimeIdentity.instanceId,
            enableGeneration: runtimeIdentity.enableGeneration,
        };
        saveRegistry(agents, { coordinate: false, applyLockCapability });

        try {
            prepared = prepare({ reason: coordinationReason, applyLockCapability });
        } catch (error) {
            try {
                inactivate(`${coordinationReason}:prepare-failed`, {
                    applyLockCapability,
                    preserveSelectedGeneration: true,
                });
            } catch (_) {}
            throw error;
        }
    });
    const preparedRecord = prepared?.generation?.agents?.[exactContainerName];
    if (prepared?.selector?.state !== 'inactive'
        || String(preparedRecord?.instanceId || '') !== runtimeIdentity.instanceId
        || String(preparedRecord?.enableGeneration || '') !== runtimeIdentity.enableGeneration) {
        let aborted = false;
        try {
            if (prepared?.preparationLease) {
                abortEdgeRoutingPreparation(prepared.preparationLease, {
                    reason: `${coordinationReason}:identity-mismatch`,
                });
                aborted = true;
            }
        } catch (_) {}
        if (!aborted) {
            try { inactivate(`${coordinationReason}:identity-mismatch`, { preserveSelectedGeneration: true }); } catch (_) {}
        }
        throw new Error(`coordinated replacement candidate did not remain inactive with the fresh runtime identity for '${exactContainerName}'`);
    }
    return Object.freeze({
        ...runtimeIdentity,
        ...(prepared?.preparationLease ? { preparationLease: prepared.preparationLease } : {}),
    });
}

export function resolveReplacementRuntimeIdentity({
    containerName,
    existingRecord,
    existingRuntime = false,
    recreateReason = null,
    preservePreparedRegistryRecord = false,
    targetedRestart = false,
    requestedInstanceId = '',
    requestedEnableGeneration = '',
    networkLifecycleCapability,
} = {}, dependencies = {}) {
    if (!targetedRestart && !preservePreparedRegistryRecord
        && existingRuntime && !recreateReason) {
        const instanceId = String(existingRecord?.instanceId || '').trim();
        const enableGeneration = String(existingRecord?.enableGeneration || '').trim();
        if (!instanceId || !enableGeneration) {
            throw new Error('runtime reuse requires the exact registered instanceId and enableGeneration');
        }
        return Object.freeze({
            instanceId,
            enableGeneration,
            ...(dependencies.preparationLease
                ? { preparationLease: dependencies.preparationLease }
                : {}),
        });
    }
    if (!targetedRestart && !preservePreparedRegistryRecord && (
        existingRuntime && recreateReason
        || !existingRuntime && existingRecord?.type === 'agent' && !preservePreparedRegistryRecord
    )) {
        return coordinateReplacementRuntimeIdentity({
            containerName,
            existingRecord,
            reason: recreateReason || 'registered-runtime-missing',
            networkLifecycleCapability,
        }, dependencies);
    }
    if (targetedRestart || preservePreparedRegistryRecord) {
        return Object.freeze({
            instanceId: String(requestedInstanceId || existingRecord?.instanceId || ''),
            enableGeneration: String(requestedEnableGeneration || existingRecord?.enableGeneration || ''),
            ...(dependencies.preparationLease ? { preparationLease: dependencies.preparationLease } : {}),
        });
    }
    const uuid = dependencies.uuid || randomUUID;
    return mintReplacementRuntimeIdentity({}, uuid);
}

function ensureAgentService(agentName, manifest, agentPath, options = {}) {
    if (!options || typeof options !== 'object'
        || !Object.prototype.hasOwnProperty.call(options, 'routerEndpoint')
        || options.routerEndpoint === undefined) {
        const error = new Error('ensureAgentService requires a validated routerEndpoint; pass explicit null for network mode none');
        error.code = 'PLOINKY_ROUTER_ENDPOINT_REQUIRED';
        throw error;
    }
    const targetedRestart = normalizeTargetedRestart(options.targetedRestart);
    if (!options.networkLifecycleCapability) {
        return withNetworkLifecycleLock(
            (networkLifecycleCapability) => ensureAgentService(agentName, manifest, agentPath, {
                ...options,
                networkLifecycleCapability,
            }),
            { waitMs: Math.max(0, Number(options.networkLockWaitMs || 0)) },
        );
    }
    assertNetworkLifecycleCapability(options.networkLifecycleCapability);
    let preferredHostPort;
    let containerOverride;
    let aliasOverride;
    let forceRecreate = false;
    let profileNameOverride;
    let routerEndpointOverride;
    let networkLockWaitMs;
    preferredHostPort = options.preferredHostPort;
    containerOverride = options.containerName;
    aliasOverride = options.alias;
    forceRecreate = options.forceRecreate === true;
    profileNameOverride = options.profileName;
    routerEndpointOverride = options.routerEndpoint;
    if (Object.prototype.hasOwnProperty.call(options, 'routerHost')) {
        throw new Error('routerHost overrides are not supported; pass the validated routerEndpoint');
    }
    networkLockWaitMs = options.networkLockWaitMs;

    const repoName = path.basename(path.dirname(agentPath));
    const containerName = containerOverride || getAgentContainerName(agentName, repoName);
    const snapshot = loadAgentsMap();
    const existingRecord = snapshot[containerName] || {};
    const preservePreparedRegistryRecord = assertPreparedRegistryRecordPreservation(
        existingRecord,
        options,
        { ownerRef: `${repoName}/${agentName}` },
    );
    if (!aliasOverride && existingRecord.alias) {
        aliasOverride = existingRecord.alias;
    }

    // Resolve profile and network before backend dispatch so every runtime uses
    // the same effective selection. Explicit CLI and persisted profiles are
    // strict; an unavailable global profile alone may fall back to default.
    const profileResolution = resolveManifestRuntimeProfile(manifest, {
        agentName: `${repoName}/${agentName}`,
        profileName: profileNameOverride,
        persistedProfileName: existingRecord.profile,
        path: `manifest(${repoName}/${agentName})`,
    });
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    const manifestNetwork = profileResolution.network;
    assertNetworkStartupCompatibility(manifest, profileConfig, manifestNetwork, {
        path: `manifest(${repoName}/${agentName})`,
    });
    const routerEndpoint = assertRouterEndpoint(routerEndpointOverride, manifestNetwork.mode);

    // Host sandboxes share the host network namespace. Fail closed unless the
    // effective manifest/profile contract explicitly selects host networking.
    const agentRuntime = getRuntimeForAgent(manifest);
    if (agentRuntime === 'bwrap' || agentRuntime === 'seatbelt') {
        let sandboxRuntimeIdentity = null;
        let sandboxRequiresEdgeActivation = false;
        try {
            assertHostSandboxNetworkCompatibility(manifestNetwork, {
                path: `manifest(${repoName}/${agentName}).network`,
                runtime: agentRuntime,
            });
            if (targetedRestart) {
                throw new Error(`targeted drain/restart is unsupported for ${agentRuntime} runtimes`);
            }
            const registeredIdentity = String(existingRecord.instanceId || '').trim()
                && String(existingRecord.enableGeneration || '').trim()
                ? {
                    instanceId: String(existingRecord.instanceId),
                    enableGeneration: String(existingRecord.enableGeneration),
                }
                : null;
            const anyRuntimeRunning = isBwrapProcessRunning(containerName);
            const runningAtEntry = Boolean(registeredIdentity)
                && isBwrapProcessRunning(containerName, registeredIdentity);
            const desiredEnvHash = computeEnvHash(manifest, profileConfig, routerEndpoint?.env || {}, {
                agentName,
                repoName,
            });
            const currentEnvHash = String(existingRecord.envHash || '');
            const sandboxRecreateReason = forceRecreate
                ? 'forceRecreate'
                : (!runningAtEntry
                    ? (anyRuntimeRunning ? 'runtimeIdentityDrift' : 'sandboxRuntimeStopped')
                    : (desiredEnvHash && desiredEnvHash !== currentEnvHash ? 'envHashChanged' : null));
            const requiresEdgeActivation = Boolean(existingRecord?.type === 'agent' && sandboxRecreateReason);
            const runtimeIdentity = resolveReplacementRuntimeIdentity({
                containerName,
                existingRecord,
                existingRuntime: anyRuntimeRunning,
                recreateReason: sandboxRecreateReason,
                networkLifecycleCapability: options.networkLifecycleCapability,
                preservePreparedRegistryRecord,
                requestedInstanceId: String(options.instanceId || existingRecord.instanceId || ''),
                requestedEnableGeneration: String(options.enableGeneration || existingRecord.enableGeneration || ''),
            }, { preparationLease: options.preparationLease });
            sandboxRuntimeIdentity = runtimeIdentity;
            sandboxRequiresEdgeActivation = requiresEdgeActivation;
            let preparedHostModeCapability = options.preparedHostModeCapability;
            const exactOwner = {
                agentId: deriveAgentPrincipalId(repoName, agentName),
                instanceId: runtimeIdentity.instanceId,
                enableGeneration: runtimeIdentity.enableGeneration,
                routeKey: aliasOverride || agentName,
                containerName,
            };
            if (!preparedHostModeCapability && requiresEdgeActivation) {
                preparedHostModeCapability = prepareHostModeCapabilityForInactiveGeneration(exactOwner);
            }
            assertHostModeGenerationCapability(exactOwner, { preparedCapability: preparedHostModeCapability });
            const sandboxOptions = {
                ...options,
                containerName,
                alias: aliasOverride,
                profileName: activeProfile,
                profileResolution,
                routerEndpoint,
                forceRecreate: Boolean(sandboxRecreateReason),
                instanceId: runtimeIdentity.instanceId,
                enableGeneration: runtimeIdentity.enableGeneration,
                preservePreparedRegistryRecord: preservePreparedRegistryRecord || requiresEdgeActivation,
                preparedHostModeCapability,
            };
            const result = agentRuntime === 'bwrap'
                ? ensureBwrapService(agentName, manifest, agentPath, sandboxOptions)
                : ensureSeatbeltService(agentName, manifest, agentPath, sandboxOptions);
            return {
                ...result,
                runtimeNetwork: structuredClone(manifestNetwork),
                requiresEdgeActivation,
                ...(runtimeIdentity.preparationLease ? { preparationLease: runtimeIdentity.preparationLease } : {}),
            };
        } catch (err) {
            const failure = createHostSandboxStartupError(agentName, agentRuntime, err);
            const identity = {
                instanceId: String(sandboxRuntimeIdentity?.instanceId || options.instanceId || existingRecord.instanceId || ''),
                enableGeneration: String(sandboxRuntimeIdentity?.enableGeneration || options.enableGeneration || existingRecord.enableGeneration || ''),
            };
            let exactCleanupPerformed = false;
            if (identity.instanceId && identity.enableGeneration) {
                try {
                    if (isBwrapProcessRunning(containerName, identity)) {
                        stopBwrapProcess(containerName, { expectedIdentity: identity });
                    }
                    exactCleanupPerformed = !isBwrapProcessRunning(containerName, identity);
                } catch (cleanupError) {
                    appendExactCleanupFailure(failure, cleanupError?.message || cleanupError);
                }
            }
            throw attachRestartCandidate(failure, {
                containerName,
                runtimeNetwork: structuredClone(manifestNetwork),
                registryRecord: {
                    type: 'agent',
                    runtime: agentRuntime,
                    agentName,
                    repoName,
                    ...(aliasOverride ? { alias: aliasOverride } : {}),
                    ...identity,
                },
                requiresEdgeActivation: sandboxRequiresEdgeActivation,
                exactCleanupPerformed,
                ...((sandboxRuntimeIdentity?.preparationLease || options.preparationLease)
                    ? { preparationLease: sandboxRuntimeIdentity?.preparationLease || options.preparationLease }
                    : {}),
            });
        }
    }

    const runtime = getRuntime();
    const existingRuntimeAtEntry = containerExists(containerName);
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
        routerEndpoint,
        networkMode: manifestNetwork.mode,
    });
    const runtimeNetworkPlan = buildRuntimeNetworkPlan(runtime, manifestNetwork);
    const envHashExtra = {
        ...runtimeRouterEnv,
        ...runtimeNetworkPlan.hashEnv
    };

    const { publishArgs: manifestPorts, portMappings } = parseManifestPorts(manifest, profileConfig);
    assertHostPortContract(runtimeNetworkPlan.mode, portMappings);
    const resolvedProfileEnv = buildEnvMap(manifest, profileConfig, {
        agentName,
        repoName,
        profileName: activeProfile,
        forRuntime: true,
    });
    const agentServerPort = resolveImplicitAgentServerPort(profileConfig, resolvedProfileEnv);
    const containerPortCandidates = portMappings
        .map((mapping) => mapping?.containerPort)
        .filter((port) => typeof port === 'number' && port > 0);
    if (shouldCreateImplicitAgentServerPublish(
        manifest,
        manifestPorts,
        runtimeNetworkPlan.mode,
        portMappings,
        agentServerPort,
    )) {
        containerPortCandidates.unshift(agentServerPort);
    }

    const { raw: explicitAgentCmd } = readManifestAgentCommand(manifest);
    const startCmd = readManifestStartCommand(manifest);
    const withParallelAgent = Boolean(startCmd && explicitAgentCmd);
    let recreateReason = targetedRestart ? 'targetedRestart' : (forceRecreate ? 'forceRecreate' : null);
    const requestedEnableGeneration = String(options.enableGeneration || existingRecord.enableGeneration || randomUUID());
    const requestedInstanceId = String(options.instanceId || existingRecord.instanceId || '');
    if (containerExists(containerName) && (!existingRecord.instanceId || !existingRecord.enableGeneration)) {
        recreateReason ||= 'missingRuntimeIdentity';
    }
    if (containerExists(containerName) && (
        (options.instanceId && options.instanceId !== existingRecord.instanceId)
        || (options.enableGeneration && options.enableGeneration !== existingRecord.enableGeneration)
    )) {
        recreateReason ||= 'runtimeIdentityChanged';
    }

    if (containerExists(containerName) && !runtimeNetworkPlan.requiresManagedNetwork) {
        const desired = computeEnvHash(manifest, profileConfig, envHashExtra, { agentName, repoName });
        const current = getContainerLabel(containerName, 'ploinky.envhash');
        if (desired && desired !== current) {
            debugLog(`[ensureAgentService] ${agentName}: env hash changed (current=${current || '<none>'}, desired=${desired.slice(0, 12)}…), recreating container`);
            recreateReason ||= 'envHashChanged';
        }
    }

    // LLM runtime: include architecture/catalog/digest/policy in reuse comparison.
    if (containerExists(containerName) && isLlmRuntimeManifest(manifest, profileConfig)) {
        try {
            const desiredEnvHash = computeEnvHash(manifest, profileConfig, envHashExtra, { agentName, repoName });
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
                    ...getManifestEnvNames(manifest, profileConfig, { forRuntime: true }),
                    ...getExposedNames(manifest, profileConfig, { forRuntime: true }),
                ],
                envHash: desiredEnvHash,
                effectiveNetwork: effectiveNetworkForLlm,
                writeState: false,
            });
            if (probe.enabled) {
                const currentReuse = getContainerLabel(containerName, 'ploinky.reusehash');
                if (probe.reuseHash && probe.reuseHash !== currentReuse) {
                    debugLog(`[ensureAgentService] ${agentName}: LLM reuse hash changed (current=${currentReuse || '<none>'}, desired=${probe.reuseHash.slice(0, 12)}…), recreating container`);
                    recreateReason ||= 'llmReuseHashChanged';
                }
            }
        } catch (err) {
            debugLog(`[ensureAgentService] ${agentName}: LLM reuse-hash check skipped: ${err?.message || err}`);
        }
    }

    // Ownership is independent of the selected transport. Host/none containers
    // still carry the workspace + contract labels, so inspect them before any
    // reuse, start, or replacement decision. Only creation/replacement for
    // default/bridge enters the managed-network transaction below.
    const networkLifecycle = createNetworkLifecycleAdapter({ runtime });
    let inspectedContainerId = null;
    let managedReconciliationPreparationLease = options.preparationLease;
    if (containerExists(containerName)) {
        const contractInspection = networkLifecycle.inspectContainerContract(containerName, manifestNetwork, agentName, {
            instanceKey: effectiveInstanceKey(repoName, agentName, aliasOverride || ''),
            contractHash: networkContractHash(manifestNetwork),
            instanceId: existingRecord.instanceId,
            enableGeneration: existingRecord.enableGeneration,
            requireRuntimeIdentity: true,
        });
        if (contractInspection.state === 'foreign') {
            throw new Error(`refusing to replace foreign/unsupported exact-name container '${containerName}': managed agent identity labels do not match`);
        }
        inspectedContainerId = contractInspection.id;
        if (contractInspection.state === 'owned-drift') {
            const driftReason = contractInspection.reason === 'runtime-identity'
                ? 'runtimeIdentityDrift'
                : 'networkContractDrift';
            debugLog(`[ensureAgentService] ${agentName}: managed runtime contract drifted (${driftReason}); recreating container`);
            recreateReason ||= driftReason;
        } else if (!isContainerRunning(containerName)) {
            // A stopped runtime is an instance replacement, not a process-resume
            // optimization. Its old identity is inactivated and rotated before
            // any host/none/managed process can start again.
            recreateReason ||= 'runtimeStopped';
        }
    }

    if (containerExists(containerName) && !recreateReason) {
        debugLog(`[ensureAgentService] ${agentName}: container exists, checking if running...`);
        let canReuseExisting = true;
        const reuseInspection = networkLifecycle.inspectContainerContract(containerName, manifestNetwork, agentName, {
            instanceKey: effectiveInstanceKey(repoName, agentName, aliasOverride || ''),
            contractHash: networkContractHash(manifestNetwork),
            instanceId: existingRecord.instanceId,
            enableGeneration: existingRecord.enableGeneration,
            requireRuntimeIdentity: true,
        });
        if (reuseInspection.state === 'foreign') {
            throw new Error(`refusing to reuse foreign/unsupported exact-name container '${containerName}': managed agent identity labels do not match`);
        }
        if (reuseInspection.state !== 'exact' || !inspectedContainerId || reuseInspection.id !== inspectedContainerId) {
            canReuseExisting = false;
            recreateReason ||= 'runtimeChangedDuringInspection';
        } else if (!isContainerRunning(containerName)) {
            // Never resume a stopped container under its predecessor identity.
            // Re-enter the coordinated inactive-generation replacement path.
            canReuseExisting = false;
            recreateReason ||= 'runtimeStoppedAfterInspection';
        }
        if (canReuseExisting && runtimeNetworkPlan.requiresManagedNetwork) {
            // Every managed reconciliation, including ordinary healthy reuse,
            // is bound to a fresh inactive generation before authority
            // attestation and exact semantic adoption. The same network
            // capability remains live through inspection, readiness and the
            // caller's later exact activation.
            if (!managedReconciliationPreparationLease) {
                const prepared = prepareEdgeRoutingGenerationRaw({
                    reason: `managed-semantic-adoption:${containerName}`,
                });
                const preparedRecord = prepared?.generation?.agents?.[containerName];
                if (prepared?.selector?.state !== 'inactive'
                    || !prepared?.preparationLease
                    || String(preparedRecord?.instanceId || '') !== String(existingRecord.instanceId || '')
                    || String(preparedRecord?.enableGeneration || '') !== String(existingRecord.enableGeneration || '')) {
                    if (prepared?.preparationLease) {
                        abortEdgeRoutingPreparation(prepared.preparationLease, {
                            reason: `managed-semantic-adoption-invalid:${containerName}`,
                        });
                    }
                    throw new Error(`managed semantic adoption for '${containerName}' did not prepare its exact inactive identity`);
                }
                managedReconciliationPreparationLease = prepared.preparationLease;
            }
            canReuseExisting = false;
        }
        if (canReuseExisting) {
            debugLog(`[ensureAgentService] ${agentName}: returning early (container exists)`);
            if (runtimeNetworkPlan.mode === 'host') {
                assertHostModeGenerationCapability({
                    agentId: deriveAgentPrincipalId(repoName, agentName),
                    instanceId: String(existingRecord.instanceId || ''),
                    enableGeneration: String(existingRecord.enableGeneration || ''),
                    routeKey: aliasOverride || agentName,
                    containerName,
                }, { preparedCapability: options.preparedHostModeCapability });
            }
            const hostPort = runtimeNetworkPlan.mode === 'host'
                ? (containerPortCandidates[0] || 0)
                : (containerPortCandidates.length
                    ? resolveHostPort(containerName, existingRecord, containerPortCandidates)
                    : 0);
            syncAgentMcpConfig(containerName, agentPath, agentName);
            const registryRecord = {
                ...existingRecord,
                runtime,
                containerId: reuseInspection.id,
            };
            return {
                containerName,
                containerId: reuseInspection.id,
                hostPort,
                createdByThisLaunch: false,
                registryRecord: structuredClone(registryRecord),
            };
        }
    }
    if (existingRuntimeAtEntry && !containerExists(containerName)) {
        recreateReason ||= 'runtimeDisappearedAfterInspection';
    }

    let additionalPorts = [];
    let additionalPortMappings = [];
    let allPortMappings = [...portMappings];

    if (shouldCreateImplicitAgentServerPublish(
        manifest,
        manifestPorts,
        runtimeNetworkPlan.mode,
        portMappings,
        agentServerPort,
    )) {
        const hostPort = Number(preferredHostPort || 0);
        const agentServerMapping = {
            containerPort: agentServerPort,
            hostPort,
            hostIp: '127.0.0.1',
            protocol: 'tcp',
        };
        additionalPorts = [`127.0.0.1:${hostPort || ''}:${agentServerPort}`];
        additionalPortMappings.push(agentServerMapping);
        allPortMappings = appendUniquePortMapping(allPortMappings, agentServerMapping);
    }

    const requiresEdgeActivation = !targetedRestart && (
        (existingRuntimeAtEntry && Boolean(recreateReason))
        || (!existingRuntimeAtEntry && existingRecord?.type === 'agent' && !preservePreparedRegistryRecord)
        || Boolean(managedReconciliationPreparationLease)
    );
    const runtimeIdentity = resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord,
        existingRuntime: existingRuntimeAtEntry,
        recreateReason,
        networkLifecycleCapability: options.networkLifecycleCapability,
        preservePreparedRegistryRecord,
        targetedRestart: Boolean(targetedRestart),
        requestedInstanceId,
        requestedEnableGeneration,
    }, { preparationLease: managedReconciliationPreparationLease });
    const preserveRuntimeRegistryRecord = Boolean(targetedRestart)
        || preservePreparedRegistryRecord
        || Boolean(runtimeIdentity.preparationLease);
    let preparedHostModeCapability = options.preparedHostModeCapability;
    if (runtimeNetworkPlan.mode === 'host') {
        const exactOwner = {
            agentId: deriveAgentPrincipalId(repoName, agentName),
            instanceId: runtimeIdentity.instanceId,
            enableGeneration: runtimeIdentity.enableGeneration,
            routeKey: aliasOverride || agentName,
            containerName,
        };
        if (!preparedHostModeCapability && requiresEdgeActivation) {
            preparedHostModeCapability = prepareHostModeCapabilityForInactiveGeneration(exactOwner);
        }
        assertHostModeGenerationCapability(exactOwner, { preparedCapability: preparedHostModeCapability });
    }

    if (targetedRestart) {
        const drainOptions = {
            runtime,
            reason: `coordinated-targeted-restart:${containerName}`,
            acknowledgement: targetedRestart.acknowledgement,
            affectedSelectors: targetedRestart.affectedSelectors,
            assertSelectorsInactive: targetedRestart.assertSelectorsInactive,
            ...(targetedRestart.timeoutMs === undefined ? {} : { timeoutMs: targetedRestart.timeoutMs }),
        };
        if (runtimeNetworkPlan.requiresManagedNetwork) {
            // The managed transaction preserves a stopped predecessor for
            // diagnostics/rollback, but never restarts it after this drain.
            drainTargetedContainer(containerName, drainOptions);
        } else {
            drainAndRemoveTargetedContainer(containerName, drainOptions);
        }
        clearLivenessState(containerName);
    }

    let started = null;
    try {
        started = startAgentContainer(agentName, manifest, agentPath, {
            publish: additionalPorts,
            publishMappings: additionalPortMappings,
            containerName,
            alias: aliasOverride,
            profileName: activeProfile,
            profileResolution,
            routerEndpoint,
            networkLockWaitMs,
            runtimeIdentity,
            preparedHostModeCapability,
            preserveRegistryRecord: preserveRuntimeRegistryRecord,
            reuseStagedMounts: existingRuntimeAtEntry && !recreateReason,
            networkLifecycleCapability: options.networkLifecycleCapability,
        });
    allPortMappings = resolvePublishedPortMappings(containerName, allPortMappings);
    const agentCodePath = getAgentCodePath(agentName);
    const agentSkillsPath = getAgentSkillsPath(agentName);
    const profileEnv = normalizeProfileEnv(profileConfig?.env);
    const { codeReadOnly, skillsReadOnly } = getProfileMountModes(activeProfile, runtime, profileConfig || {});

    const agents = loadAgentsMap();
    const startedRecord = started?.registryRecord || agents[containerName] || {};
    const declaredEnvNames3 = [
        ...getManifestEnvNames(manifest, profileConfig, { forRuntime: true }),
        ...getExposedNames(manifest, profileConfig, { forRuntime: true }),
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
        runtime,
        containerId: started.containerId,
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        config: {
            binds: hasStartedBinds ? startedRecord.config.binds : [
                { source: AGENT_LIB_PATH, target: '/Agent', ro: true },
                { source: agentCodePath, target: '/code', ro: codeReadOnly },
                ...(fs.existsSync(agentSkillsPath) ? [{ source: agentSkillsPath, target: '/code/skills', ro: skillsReadOnly }] : []),
                { source: projPath, target: finalWorkTarget },
                ...(!finalIsolatedHome ? [{ source: finalAgentWorkDir, target: '/root' }] : [])
            ],
            env: Array.from(new Set([...declaredEnvNames3, ...startedEnvNames])).map((name) => ({ name })),
            ports: runtimeNetworkPlan.mode === 'host' || runtimeNetworkPlan.mode === 'none' ? [] : allPortMappings,
        }
    };
    if (existingRecord.auth) {
        agents[containerName].auth = existingRecord.auth;
    }
    if (aliasOverride) {
        agents[containerName].alias = aliasOverride;
    }
    if (!preserveRuntimeRegistryRecord) saveAgentsMap(agents);

    syncAgentMcpConfig(containerName, agentPath, finalInstanceName, { workDir: finalAgentWorkDir });
    const returnPort = runtimeNetworkPlan.mode === 'host'
        ? (allPortMappings.find((p) => p.containerPort === agentServerPort)?.containerPort
            || allPortMappings[0]?.containerPort
            || 0)
        : allPortMappings.find((p) => p.containerPort === agentServerPort)?.hostPort
        || allPortMappings[0]?.hostPort
        || 0;
        return {
            containerName,
            containerId: started?.containerId,
            runtimeNetwork: structuredClone(manifestNetwork),
            hostPort: returnPort,
            createdByThisLaunch: started?.createdByThisLaunch !== false,
            registryRecord: structuredClone(agents[containerName]),
            requiresEdgeActivation,
            ...(runtimeIdentity.preparationLease ? { preparationLease: runtimeIdentity.preparationLease } : {}),
        };
    } catch (error) {
        if (error?.code === 'PLOINKY_SEMANTIC_ADOPTION_MISMATCH'
            && runtimeNetworkPlan.requiresManagedNetwork
            && runtimeIdentity.preparationLease
            && options.semanticAdoptionRetry !== true) {
            abortEdgeRoutingPreparation(runtimeIdentity.preparationLease, {
                reason: `semantic-adoption-mismatch:${containerName}`,
            });
            const rotated = coordinateReplacementRuntimeIdentity({
                containerName,
                existingRecord,
                reason: 'semanticDescriptorMismatch',
                networkLifecycleCapability: options.networkLifecycleCapability,
            });
            return ensureAgentService(agentName, manifest, agentPath, {
                ...options,
                forceRecreate: true,
                preservePreparedRegistryRecord: true,
                instanceId: rotated.instanceId,
                enableGeneration: rotated.enableGeneration,
                preparationLease: rotated.preparationLease,
                semanticAdoptionRetry: true,
            });
        }
        let exactCleanupPerformed = error?.ploinkyRestartCandidate?.exactCleanupPerformed === true;
        const candidateId = String(started?.containerId || error?.ploinkyRestartCandidate?.containerId || '');
        const candidateRecord = started?.registryRecord || error?.ploinkyRestartCandidate?.registryRecord || {
            type: 'agent',
            agentName,
            repoName,
            ...(aliasOverride ? { alias: aliasOverride } : {}),
            instanceId: runtimeIdentity.instanceId,
            enableGeneration: runtimeIdentity.enableGeneration,
        };
        if (!exactCleanupPerformed && candidateId) {
            try {
                const cleanup = removeExactGenerationCandidate({
                    containerName,
                    containerId: candidateId,
                    network: manifestNetwork,
                    record: candidateRecord,
                });
                exactCleanupPerformed = cleanup.removed === true || cleanup.state === 'absent';
            } catch (cleanupError) {
                appendExactCleanupFailure(error, cleanupError?.message || cleanupError);
            }
        }
        throw attachRestartCandidate(error, {
            containerName,
            ...(candidateId ? { containerId: candidateId } : {}),
            runtimeNetwork: structuredClone(manifestNetwork),
            registryRecord: structuredClone(candidateRecord),
            requiresEdgeActivation,
            exactCleanupPerformed,
            ...(runtimeIdentity.preparationLease ? { preparationLease: runtimeIdentity.preparationLease } : {}),
        });
    }
}

function removeExactGenerationCandidate({
    containerName,
    containerId,
    network,
    record,
} = {}) {
    const cleanup = createNetworkLifecycleAdapter({ runtime: getRuntime() }).removeExactContainer(
        containerName,
        network,
        record.agentName,
        {
            expectedContainerId: containerId,
            instanceKey: effectiveInstanceKey(record.repoName, record.agentName, record.alias || ''),
            contractHash: networkContractHash(network),
            instanceId: record.instanceId,
            enableGeneration: record.enableGeneration,
        },
    );
    if (cleanup.removed !== true && cleanup.state !== 'absent') {
        throw new Error(`exact failed candidate was preserved (${cleanup.reason || cleanup.state || 'ownership mismatch'})`);
    }
    clearLivenessState(containerName);
    return cleanup;
}

export function cleanupExactAgentRuntimeCandidate(candidate) {
    const containerName = String(candidate?.containerName || '').trim();
    const record = candidate?.registryRecord;
    if (!containerName || !record || record.type !== 'agent'
        || !String(record.instanceId || '').trim()
        || !String(record.enableGeneration || '').trim()) {
        throw new Error('exact runtime candidate cleanup requires its name and immutable registry identity');
    }
    if (record.runtime === 'bwrap' || record.runtime === 'seatbelt') {
        const identity = {
            instanceId: record.instanceId,
            enableGeneration: record.enableGeneration,
        };
        if (!isBwrapProcessRunning(containerName, identity)) {
            return { removed: false, state: 'absent' };
        }
        const removed = stopBwrapProcess(containerName, { expectedIdentity: identity });
        if (!removed || isBwrapProcessRunning(containerName, identity)) {
            throw new Error('exact sandbox candidate remained live after cleanup');
        }
        clearLivenessState(containerName);
        return { removed: true, state: 'removed' };
    }
    const containerId = String(candidate?.containerId || '').trim();
    if (!containerId || !candidate?.runtimeNetwork) {
        throw new Error('exact container candidate cleanup requires its immutable ID and runtime network');
    }
    return removeExactGenerationCandidate({
        containerName,
        containerId,
        network: candidate.runtimeNetwork,
        record,
    });
}

function appendExactCleanupFailure(error, detail) {
    if (error && typeof error === 'object') {
        error.message = `${error.message}; exact candidate cleanup failed: ${detail}`;
    }
}

function restartGenerationCapabilityRuntime({
    generation,
    owner,
    affectedSelectors,
    assertSelectorsInactive,
    preparedHostModeCapability,
    networkLifecycleCapability,
} = {}, {
    ensureService = ensureAgentService,
    isRunning = isContainerRunning,
    resolveProfile = resolveManifestRuntimeProfile,
    resolveReadinessProtocol = resolveAgentReadinessProtocol,
    runScriptReadiness = runContainerScriptReadiness,
    removeCandidate = removeExactGenerationCandidate,
    assertLifecycleCapability = assertNetworkLifecycleCapability,
} = {}) {
    if (!generation || !owner || !preparedHostModeCapability) {
        throw new Error('coordinated capability-runtime restart requires an immutable generation, owner, and prepared capability');
    }
    assertLifecycleCapability(networkLifecycleCapability);
    const exactOwner = (generation.compiled?.security?.hostNetworkCapabilities || []).find((entry) => (
        entry.agentId === owner.agentId
        && entry.instanceId === owner.instanceId
        && entry.enableGeneration === owner.enableGeneration
        && entry.routeKey === owner.routeKey
        && entry.containerName === owner.containerName
    ));
    if (!exactOwner) {
        throw new Error('coordinated capability-runtime restart owner is not present in the immutable generation');
    }
    const route = generation.routing?.routes?.[owner.routeKey];
    const manifest = generation.manifests?.[owner.routeKey];
    const record = generation.agents?.[owner.containerName];
    if (!route || !manifest || !record || record.type !== 'agent'
        || String(route.container || '') !== owner.containerName
        || `agent:${record.repoName}/${record.agentName}` !== owner.agentId
        || String(record.instanceId || '') !== owner.instanceId
        || String(record.enableGeneration || '') !== owner.enableGeneration) {
        throw new Error('coordinated capability-runtime restart could not resolve one exact captured runtime record');
    }
    const agentPath = String(route.hostPath || '').trim();
    if (!agentPath) throw new Error('coordinated capability-runtime restart owner has no captured manifest path');
    const profileResolution = resolveProfile(manifest, {
        agentName: `${record.repoName}/${record.agentName}`,
        profileName: record.profile || undefined,
        path: `manifest(${record.repoName}/${record.agentName})`,
    });
    if (profileResolution.network.mode !== 'host') {
        throw new Error('media capability runtime must resolve to exact host network mode');
    }
    const result = ensureService(record.agentName, manifest, agentPath, {
        containerName: owner.containerName,
        alias: record.alias || undefined,
        profileName: profileResolution.resolvedProfileName,
        profileResolution,
        routerEndpoint: buildRouterEndpoint('host', INITIAL_ROUTER_PORT),
        forceRecreate: true,
        instanceId: owner.instanceId,
        enableGeneration: owner.enableGeneration,
        preparedHostModeCapability,
        targetedRestart: {
            acknowledgement: TARGETED_DRAIN_ACKNOWLEDGEMENT,
            affectedSelectors,
            assertSelectorsInactive,
        },
        networkLifecycleCapability,
    });
    try {
        if (result?.containerName !== owner.containerName
            || !String(result?.containerId || '')
            || !isRunning(owner.containerName)) {
            throw new Error(`coordinated capability-runtime restart did not start exact container '${owner.containerName}' with an immutable ID`);
        }
        const readinessProtocol = resolveReadinessProtocol(manifest);
        if (readinessProtocol !== 'script') {
            throw new Error('media capability runtime requires an exact semantic script readiness probe before generation activation');
        }
        const readiness = runScriptReadiness(record.agentName, owner.containerName, manifest?.health?.readiness);
        if (readiness && typeof readiness.then === 'function') {
            throw new Error('media capability runtime readiness must complete synchronously before selector commit');
        }
        if (readiness?.status !== 'success') {
            const detail = readiness?.detail ? `, output='${readiness.detail}'` : '';
            throw new Error(`media capability runtime semantic readiness failed (${readiness?.reason || 'unknown failure'}${detail})`);
        }
    } catch (error) {
        if (result?.containerName === owner.containerName && String(result?.containerId || '')) {
            try {
                removeCandidate({
                    containerName: owner.containerName,
                    containerId: result.containerId,
                    network: profileResolution.network,
                    record,
                });
            } catch (cleanupError) {
                appendExactCleanupFailure(error, cleanupError?.message || cleanupError);
            }
        } else {
            appendExactCleanupFailure(error, 'candidate receipt did not contain the expected name and immutable ID');
        }
        throw error;
    }
    return result;
}

export function isGenerationCapabilityRuntimeEffective({
    generation,
    owner,
} = {}, {
    exists = containerExists,
    isRunning = isContainerRunning,
    inspectContainerContract,
} = {}) {
    if (!generation || !owner) return false;
    const exactOwner = (generation.compiled?.security?.hostNetworkCapabilities || []).find((entry) => (
        entry.agentId === owner.agentId
        && entry.instanceId === owner.instanceId
        && entry.enableGeneration === owner.enableGeneration
        && entry.routeKey === owner.routeKey
        && entry.containerName === owner.containerName
    ));
    if (!exactOwner) return false;
    const route = generation.routing?.routes?.[owner.routeKey];
    const manifest = generation.manifests?.[owner.routeKey];
    const record = generation.agents?.[owner.containerName];
    if (!route || !manifest || !record || record.type !== 'agent'
        || String(route.container || '') !== owner.containerName
        || `agent:${record.repoName}/${record.agentName}` !== owner.agentId
        || String(record.instanceId || '') !== owner.instanceId
        || String(record.enableGeneration || '') !== owner.enableGeneration) {
        return false;
    }
    const profileResolution = resolveManifestRuntimeProfile(manifest, {
        agentName: `${record.repoName}/${record.agentName}`,
        profileName: record.profile || undefined,
        path: `manifest(${record.repoName}/${record.agentName})`,
    });
    if (profileResolution.network.mode !== 'host'
        || !exists(owner.containerName)
        || !isRunning(owner.containerName)) {
        return false;
    }
    const inspect = inspectContainerContract || createNetworkLifecycleAdapter({ runtime: getRuntime() })
        .inspectContainerContract;
    const inspection = inspect(owner.containerName, profileResolution.network, record.agentName, {
        instanceKey: effectiveInstanceKey(record.repoName, record.agentName, record.alias || ''),
        contractHash: networkContractHash(profileResolution.network),
        instanceId: owner.instanceId,
        enableGeneration: owner.enableGeneration,
        requireRuntimeIdentity: true,
    });
    return inspection?.state === 'exact';
}

export {
    assertPodmanCodeMountAllowed,
    appendExactManagedBindMount,
    appendUniquePortMapping,
    buildPersistentAgentRunArgs,
    buildBoxPodmanHostArgs,
    buildDefaultPodmanNetworkArgs,
    buildPodmanStagedTargetMounts,
    buildRuntimeNetworkPlan,
    buildRuntimeRouterEnv,
    codeRelativeMountPath,
    collectManifestVolumeEntries,
    ensureAgentService,
    ensureManifestVolumeHostPath,
    ensurePodmanStagedCodeDir,
    resolveReusablePodmanStagedMounts,
    expectedBindMountsFromArgs,
    hasExactManagedEnv,
    hasExactManagedMountContract,
    mergeNodeOptions,
    manifestVolumeMountSuffix,
    podmanManifestVolumeMountSuffix,
    podmanMountSuffix,
    resolveDependencyCachePreparation,
    resolveHostPort,
    resolveHostPortFromRecord,
    resolveHostPortFromRuntime,
    resolveImplicitAgentServerPort,
    resolvePublishedPortMappings,
    restartGenerationCapabilityRuntime,
    replaceRuntimeRouterEnvFlags,
    shouldCreateImplicitAgentServerPublish,
    startAgentContainer,
    stripReservedAndRestoreRuntimeRouterEnvFlags,
};
