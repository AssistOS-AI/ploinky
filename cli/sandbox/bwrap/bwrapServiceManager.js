import { execSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnTrustedInteractiveLaunch } from './interactive.js';
import { shouldAllocateInteractiveTty } from '../interactiveProcess.js';
import {
    assertManifestEnvProfileCompleteness,
    buildEnvMap,
    formatEnvFlag,
    getExposedNames,
    getManifestEnvSpecs,
    getManifestEnvNames,
    resolveVarValue
} from '../../utils/security/secretVars.js';
import { buildAgentPrincipalEnv, stripReservedAgentEnv } from '../../utils/security/agentIdentityEnv.js';
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
    getAgentSkillsPath,
    ensureAgentHomeAbi,
} from '../../utils/workspaceStructure.js';
import { ensureAgentCacheForFamily } from '../../utils/dependencies/dependencyCache.js';
import {
    assertBwrapPidSlotAvailable,
    assertExactServiceOwner,
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
import { assertRouterEndpoint } from '../routerPort.js';
import {
    pruneStaleRuntimeEntries,
    runtimeSegment
} from '../../utils/runtime/runtimeStaging.js';
import {
    admitManifestRuntimeCapabilities,
    assertRuntimeAdmissionCurrent,
    runtimeCapabilityDigest,
} from '../runtimeCapabilities.js';
import { assertHostModeGenerationCapability } from '../edgeGeneration.js';
import { buildRouterAuthorityTopologyIntent } from '../routerAuthorityAttestation.js';
import { IMAGE_CONTRACT } from '../../../ploinky-box/contract/image.mjs';
import {
    BWRAP_HOME_SOURCE_KINDS,
    TRUSTED_SERVICE_ENV,
    buildTrustedInteractivePolicy,
    buildTrustedServicePolicy,
    encodeBwrapLaunchDescriptor,
    isTrustedServiceReservedEnvName,
    normalizeTrustedInteractiveWorkdir,
} from '../../../Agent/lib/providerSandbox.mjs';
import {
    BWRAP_AGENT_CREDENTIAL_FILE,
    BWRAP_AGENT_CREDENTIAL_MAX_BYTES,
    buildBwrapAgentCredential,
} from './bwrapAgentCredential.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_LIB_PATH = path.resolve(__dirname, '../../../Agent');
const AGENT_PRIVATE_KEY_CONTAINER_PATH = '/run/ploinky-agent.key';
const BWRAP_RUNTIME_ROOT = path.join(DEPS_DIR, 'bwrap-runtime');
const BWRAP_NODE_RUNTIME_PATH = '/opt/ploinky-node';
const BWRAP_HELPER_PATH = IMAGE_CONTRACT.bwrapHelper;

function trustedServicePolicyError(message, code = 'PLOINKY_BWRAP_SERVICE_POLICY_INVALID') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function assertTrustedServiceEnvName(name, source) {
    const normalized = typeof name === 'string' ? name.trim() : '';
    if (!normalized) return;
    if (isTrustedServiceReservedEnvName(normalized)
        || normalized === '*'
        || normalized.startsWith('PLOINKY_') && normalized.includes('*')) {
        throw trustedServicePolicyError(
            `trusted coding service ${source} declares reserved environment name ${normalized}`,
            'PLOINKY_BWRAP_SERVICE_ENV_RESERVED',
        );
    }
}

function inspectTrustedServiceEnvValue(value, source) {
    if (typeof value !== 'string') return;
    const references = value.matchAll(/\{\{(?:secret|var|generatedSecret):\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g);
    for (const match of references) assertTrustedServiceEnvName(match[1], source);
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        assertTrustedServiceEnvName(value.slice(1), source);
    }
}

function assertTrustedServiceRawConfiguration(manifest, profileConfig, runtimeResourcePlan = null) {
    for (const [source, env] of [
        ['manifest env', manifest?.env],
        ['profile env', profileConfig?.env],
    ]) {
        if (env === undefined || env === null) continue;
        for (const spec of getManifestEnvSpecs({ env }, null)) {
            assertTrustedServiceEnvName(spec.insideName, source);
            assertTrustedServiceEnvName(spec.sourceName, `${source} source`);
        }
        if (Array.isArray(env)) {
            for (const entry of env) {
                if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
                    inspectTrustedServiceEnvValue(entry.value ?? entry.default, source);
                } else if (typeof entry === 'string') {
                    inspectTrustedServiceEnvValue(entry.slice(entry.indexOf('=') + 1), source);
                }
            }
        } else if (typeof env === 'object') {
            for (const value of Object.values(env)) {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    inspectTrustedServiceEnvValue(value.value ?? value.default, source);
                } else {
                    inspectTrustedServiceEnvValue(value, source);
                }
            }
        }
    }

    for (const [source, expose] of [
        ['manifest expose', manifest?.expose],
        ['profile expose', profileConfig?.expose],
    ]) {
        if (Array.isArray(expose)) {
            for (const spec of expose) {
                assertTrustedServiceEnvName(spec?.name, source);
                assertTrustedServiceEnvName(spec?.ref, `${source} source`);
                inspectTrustedServiceEnvValue(spec?.value, source);
            }
        } else if (expose && typeof expose === 'object') {
            for (const [name, value] of Object.entries(expose)) {
                assertTrustedServiceEnvName(name, source);
                inspectTrustedServiceEnvValue(value, source);
            }
        }
    }

    for (const secretName of profileConfig?.secrets || []) {
        assertTrustedServiceEnvName(secretName, 'profile secrets');
    }
    for (const [name, value] of Object.entries(manifest?.runtime?.resources?.env || {})) {
        assertTrustedServiceEnvName(name, 'runtime resource env');
        inspectTrustedServiceEnvValue(value, 'runtime resource env source');
    }
    for (const name of Object.keys(runtimeResourcePlan?.env || {})) {
        assertTrustedServiceEnvName(name, 'runtime resource plan env');
    }
}

const TRUSTED_SERVICE_PLATFORM_PROJECTION_NAMES = new Set([
    ...Object.keys(TRUSTED_SERVICE_ENV),
    'AGENT_NAME',
    'PORT',
    'PLOINKY_AGENT_NAME',
    'PLOINKY_REPO_NAME',
    'PLOINKY_CWD',
    'PLOINKY_AGENT_ID',
    'PLOINKY_AGENT_PRINCIPAL',
    'PLOINKY_AGENT_INSTANCE_ID',
    'PLOINKY_AGENT_ENABLE_GENERATION',
    'PLOINKY_ENV_SOURCE_PLOINKY_AGENT_ID',
    'PLOINKY_ENV_SOURCE_PLOINKY_AGENT_PRINCIPAL',
    'PLOINKY_ENV_SOURCE_PLOINKY_AGENT_INSTANCE_ID',
    'PLOINKY_ENV_SOURCE_PLOINKY_AGENT_ENABLE_GENERATION',
]);

function buildTrustedServiceDynamicEnvironment(envMap) {
    const dynamicEnvironment = {};
    for (const [name, value] of Object.entries(envMap || {})) {
        if (value === undefined || value === null) continue;
        if (isTrustedServiceReservedEnvName(name)) {
            if (!TRUSTED_SERVICE_PLATFORM_PROJECTION_NAMES.has(name)) {
                throw trustedServicePolicyError(
                    `trusted coding service produced unowned reserved environment name ${name}`,
                    'PLOINKY_BWRAP_SERVICE_ENV_RESERVED',
                );
            }
            continue;
        }
        dynamicEnvironment[name] = String(value);
    }
    return dynamicEnvironment;
}

function assertTrustedServiceInputs(manifest, profileConfig, runtimeResourcePlan) {
    assertTrustedServiceRawConfiguration(manifest, profileConfig, runtimeResourcePlan);
    const manifestVolumes = manifest?.volumes && typeof manifest.volumes === 'object'
        ? Object.keys(manifest.volumes)
        : [];
    const profileVolumes = profileConfig?.volumes && typeof profileConfig.volumes === 'object'
        ? Object.keys(profileConfig.volumes)
        : [];
    if (manifestVolumes.length || profileVolumes.length) {
        throw trustedServicePolicyError('trusted coding services do not admit manifest or profile volumes');
    }
    if (runtimeResourcePlan?.persistentStorage) {
        throw trustedServicePolicyError('trusted coding services do not admit runtime persistent-storage mounts');
    }
}

function assertTrustedBwrapHelper() {
    let stat;
    try {
        stat = fs.lstatSync(BWRAP_HELPER_PATH);
    } catch (cause) {
        throw trustedServicePolicyError(
            `trusted bwrap launcher is unavailable at ${BWRAP_HELPER_PATH}`,
            'PLOINKY_BWRAP_HELPER_UNAVAILABLE',
        );
    }
    if (stat.isSymbolicLink()
        || !stat.isFile()
        || stat.uid !== 0
        || stat.gid !== 0
        || (stat.mode & 0o7777) !== 0o755) {
        throw trustedServicePolicyError(
            'trusted bwrap launcher must be an immutable root-owned 0755 regular file',
            'PLOINKY_BWRAP_HELPER_INVALID',
        );
    }
    try {
        fs.accessSync(BWRAP_HELPER_PATH, fs.constants.X_OK);
    } catch (_) {
        throw trustedServicePolicyError(
            'trusted bwrap launcher is not executable',
            'PLOINKY_BWRAP_HELPER_INVALID',
        );
    }
}

function buildTrustedServiceLaunch(options) {
    const policy = buildTrustedServicePolicy(options);
    return Object.freeze({
        ...policy,
        descriptor: encodeBwrapLaunchDescriptor(policy.records),
        helperPath: BWRAP_HELPER_PATH,
    });
}

function buildTrustedInteractiveLaunch(options) {
    const policy = buildTrustedInteractivePolicy(options);
    return Object.freeze({
        ...policy,
        descriptor: encodeBwrapLaunchDescriptor(policy.records),
        helperPath: BWRAP_HELPER_PATH,
    });
}

function normalizeManagedInteractiveWorkdir(value) {
    if (typeof value !== 'string' || value.includes('\0')
        || value.split('/').includes('..')) {
        throw trustedServicePolicyError(
            'interactive WORKDIR is invalid',
            'PLOINKY_WORKDIR_INVALID',
        );
    }
    if (!path.isAbsolute(value) || value === '/workspace' || value.startsWith('/workspace/')) {
        return normalizeTrustedInteractiveWorkdir(value);
    }
    const workspaceRoot = path.resolve(PLOINKY_WORKSPACE_ROOT);
    const candidate = path.resolve(value);
    const relative = path.relative(workspaceRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw trustedServicePolicyError(
            'interactive WORKDIR is outside the workspace',
            'PLOINKY_WORKDIR_INVALID',
        );
    }
    return normalizeTrustedInteractiveWorkdir(relative);
}

function spawnTrustedServiceLaunch(launch, logFd, credentialBytes, dependencyOverrides = {}) {
    const clearCredential = (() => {
        let credentialCleared = false;
        return () => {
            if (credentialCleared || !Buffer.isBuffer(credentialBytes)) return;
            credentialCleared = true;
            credentialBytes.fill(0);
        };
    })();
    if (!Buffer.isBuffer(credentialBytes)
        || credentialBytes.length < 1
        || credentialBytes.length > BWRAP_AGENT_CREDENTIAL_MAX_BYTES) {
        clearCredential();
        throw trustedServicePolicyError(
            'trusted bwrap launcher credential bytes are missing or out of bounds',
            'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
        );
    }
    const assertHelper = dependencyOverrides.assertHelper || assertTrustedBwrapHelper;
    const spawnProcess = dependencyOverrides.spawnProcess || spawn;
    const killProcess = dependencyOverrides.killProcess || ((pid, signal) => process.kill(pid, signal));
    try {
        assertHelper();
    } catch (error) {
        clearCredential();
        throw error;
    }
    let child;
    try {
        child = spawnProcess(BWRAP_HELPER_PATH, [], {
            detached: true,
            stdio: ['ignore', logFd, logFd, 'pipe', 'pipe'],
        });
    } catch (error) {
        clearCredential();
        throw error;
    }
    let spawnFailure = null;
    const killExactChild = () => {
        if (!Number.isSafeInteger(child?.pid) || child.pid < 1) return;
        try { killProcess(-child.pid, 'SIGKILL'); } catch (_) { }
        try { killProcess(child.pid, 'SIGKILL'); } catch (_) { }
    };
    const recordPipeFailure = (error) => {
        if (spawnFailure) return;
        spawnFailure = error instanceof Error ? error : new Error(String(error || 'pipe failure'));
        clearCredential();
        killExactChild();
    };
    if (!child || typeof child.once !== 'function') {
        clearCredential();
        killExactChild();
        throw trustedServicePolicyError(
            'trusted bwrap launcher did not return a child process',
            'PLOINKY_BWRAP_SPAWN_FAILED',
        );
    }
    child.once('error', recordPipeFailure);
    const descriptorPipe = child.stdio?.[3];
    const credentialPipe = child.stdio?.[4];
    if (!descriptorPipe || typeof descriptorPipe.once !== 'function'
        || typeof descriptorPipe.end !== 'function'
        || !credentialPipe || typeof credentialPipe.once !== 'function'
        || typeof credentialPipe.end !== 'function') {
        const error = trustedServicePolicyError(
            'trusted bwrap launcher descriptor and credential pipes were not created',
            'PLOINKY_BWRAP_PIPE_FAILED',
        );
        recordPipeFailure(error);
        throw error;
    }
    descriptorPipe.once('error', recordPipeFailure);
    credentialPipe.once('error', recordPipeFailure);
    try {
        descriptorPipe.end(launch.descriptor);
        if (!spawnFailure) {
            credentialPipe.end(credentialBytes, (error) => {
                if (error) recordPipeFailure(error);
                else clearCredential();
            });
        }
    } catch (error) {
        recordPipeFailure(error);
        throw error;
    }
    return Object.freeze({ child, getSpawnFailure: () => spawnFailure });
}

function admitBwrapBoundary(agentName, manifest, agentPath, options, profileResolution) {
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
        runtimeKind: 'bwrap',
    });
    if (optionBag.runtimeAdmission) {
        assertRuntimeAdmissionCurrent(optionBag.runtimeAdmission, {
            manifestBytes,
            profileName: profileResolution.resolvedProfileName,
            runtimeKind: 'bwrap',
            descriptor: admission.descriptor,
        });
    }
    return Object.freeze({
        admission: optionBag.runtimeAdmission || admission,
        manifestBytes,
    });
}

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

function resolveBwrapNodeRuntime(nodeExecPath = process.execPath) {
    let hostNodePath = path.resolve(nodeExecPath);
    try {
        hostNodePath = fs.realpathSync(hostNodePath);
    } catch (_) {
        // The existence check below provides the actionable error.
    }
    if (!fs.existsSync(hostNodePath)) {
        throw new Error(`[bwrap] host Node.js executable is missing: ${hostNodePath}`);
    }
    const hostBinPath = path.dirname(hostNodePath);
    const hostRuntimePath = path.dirname(hostBinPath);
    return {
        hostRuntimePath,
        sandboxRuntimePath: BWRAP_NODE_RUNTIME_PATH,
        sandboxBinPath: `${BWRAP_NODE_RUNTIME_PATH}/bin`,
    };
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

function ensureBwrapAgentLibDir(instanceName, nodeModulesDir, options = {}) {
    const sourceAgentLibPath = options.sourceAgentLibPath || AGENT_LIB_PATH;
    const runtimeBase = options.runtimeRoot || BWRAP_RUNTIME_ROOT;
    const runtimeRoot = path.join(runtimeBase, runtimeSegment(instanceName));
    const stagedAgentLibPath = path.join(
        runtimeRoot,
        `Agent-${process.pid}-${Date.now()}${process.hrtime.bigint()}`
    );
    const sourceNodeModules = path.join(sourceAgentLibPath, 'node_modules');

    if (!fs.existsSync(nodeModulesDir)) {
        throw new Error(`[bwrap] prepared dependency cache is missing: ${nodeModulesDir}`);
    }

    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.cpSync(sourceAgentLibPath, stagedAgentLibPath, {
        recursive: true,
        filter(sourcePath) {
            const resolvedSource = path.resolve(sourcePath);
            return resolvedSource !== sourceNodeModules
                && !resolvedSource.startsWith(`${sourceNodeModules}${path.sep}`);
        }
    });

    // Bubblewrap cannot create /Agent/node_modules after /Agent has been
    // mounted read-only. The empty directory is the mount point for the
    // prepared dependency cache; the cache itself remains outside this copy.
    fs.mkdirSync(path.join(stagedAgentLibPath, 'node_modules'), { recursive: true });

    return stagedAgentLibPath;
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
        cwdMountTarget,
        agentHomeDir,
        nodeRuntimePath,
        skillsPath,
        envMap,
        codeReadOnly,
        skillsReadOnly,
        volumes,
        agentPrivateKeyPath
    } = options;

    const agentNodeModulesMountPoint = path.join(agentLibPath, 'node_modules');
    if (!fs.existsSync(agentNodeModulesMountPoint)) {
        throw new Error(
            `[bwrap] Agent runtime is missing the /Agent/node_modules mount point: ${agentNodeModulesMountPoint}`
        );
    }

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

    // Use the same Node.js distribution that launched Ploinky and prepared the
    // bwrap dependency cache. This keeps the runtime ABI aligned and exposes
    // that distribution's npm to manifest install hooks without making the
    // host installation writable.
    const hostNodeRuntimePath = nodeRuntimePath || resolveBwrapNodeRuntime().hostRuntimePath;
    args.push('--dir', '/opt');
    args.push('--ro-bind', hostNodeRuntimePath, BWRAP_NODE_RUNTIME_PATH);

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

    // Project/workspace access is independent from the persistent agent home.
    // Isolated agents use the home bind as their project mount; global and
    // devel agents retain the selected project at its host-absolute path.
    const projectTarget = cwdMountTarget || cwd;
    const homeDir = agentHomeDir || cwd;
    if (cwd !== homeDir || projectTarget !== '/root') {
        args.push('--bind', cwd, projectTarget);
    }
    args.push('--bind', homeDir, '/root');

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
function buildFullEnvMap(agentName, manifest, profileConfig, workspacePath, repoName, activeProfile, runtimeName = 'bwrap', runtimeResourcePlan = null, routerEndpoint = undefined, runtimeIdentity = undefined) {
    const endpoint = assertRouterEndpoint(routerEndpoint, 'host');
    if (runtimeName === 'bwrap') {
        assertTrustedServiceRawConfiguration(manifest, profileConfig, runtimeResourcePlan);
    }
    // Start with manifest env vars (resolved from secrets)
    const env = buildEnvMap(manifest, profileConfig, { agentName, repoName, forRuntime: true });

    // Ploinky internal vars
    env.PLOINKY_MCP_CONFIG_PATH = runtimeName === 'bwrap'
        ? '/home/agent/mcp-config.json'
        : CONTAINER_CONFIG_PATH;
    env.AGENT_NAME = agentName;
    env.WORKSPACE_PATH = runtimeName === 'bwrap' ? '/workspace' : workspacePath;
    env.PLOINKY_WORKSPACE_ROOT = runtimeName === 'bwrap' ? '/workspace' : PLOINKY_WORKSPACE_ROOT;
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
    const profileEnvVars = getProfileEnvVars(agentName, repoName, activeProfile);
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
    env.HOME = runtimeName === 'bwrap' ? TRUSTED_SERVICE_ENV.HOME : workspacePath;
    env.PATH = runtimeName === 'bwrap'
        ? TRUSTED_SERVICE_ENV.PATH
        : `${BWRAP_NODE_RUNTIME_PATH}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
    if (runtimeName === 'bwrap') {
        env.PLOINKY_MCP_CONFIG_PATH = '/home/agent/mcp-config.json';
        env.WORKSPACE_PATH = '/workspace';
        env.PLOINKY_WORKSPACE_ROOT = '/workspace';
        env.XDG_CONFIG_HOME = TRUSTED_SERVICE_ENV.XDG_CONFIG_HOME;
        env.XDG_CACHE_HOME = TRUSTED_SERVICE_ENV.XDG_CACHE_HOME;
        env.XDG_DATA_HOME = TRUSTED_SERVICE_ENV.XDG_DATA_HOME;
        env.XDG_STATE_HOME = TRUSTED_SERVICE_ENV.XDG_STATE_HOME;
        env.TMPDIR = TRUSTED_SERVICE_ENV.TMPDIR;
        env.PLOINKY_AGENT_BIND_HOST = TRUSTED_SERVICE_ENV.PLOINKY_AGENT_BIND_HOST;
    }
    env.AGENT_NAME = agentName;
    env.PLOINKY_RUNTIME = runtimeName;

    // Exact final-runner equivalence is not yet available for bwrap/seatbelt.
    // Strip every reserved input and emit only non-secret principal fields;
    // no descriptor, Router mirror, request secret, API key, or trust anchor is
    // constructed. Generated-local use therefore fails before key/socket work.
    stripReservedAgentEnv(env);
    const exactRuntimeIdentity = runtimeIdentity === undefined
        ? undefined
        : normalizeSandboxRuntimeIdentity(runtimeIdentity);
    Object.assign(
        env,
        buildAgentPrincipalEnv(
            deriveAgentPrincipalId(repoName, agentName),
            exactRuntimeIdentity,
        ),
    );
    if (runtimeName === 'bwrap') {
        env.PLOINKY_AGENT_CREDENTIAL_FILE = BWRAP_AGENT_CREDENTIAL_FILE;
        env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_CREDENTIAL_FILE = 'generated';
    }

    return env;
}

/**
 * Build the shell command that runs inside the bwrap sandbox.
 *
 * No runtime `npm install` — dependencies are prepared on the host
 * via `prepareAgentCache` and mounted read-only at /code/node_modules.
 * Provider install hooks are never admitted to the long-lived trusted service.
 * A later provider update phase runs them under its own exclusive HOME lease.
 */
function buildBwrapEntryCommand(agentName, manifest, profileConfig) {
    const { raw: explicitAgentCmd } = readManifestAgentCommand(manifest);
    const startCmd = readManifestStartCommand(manifest);
    const useStartEntry = Boolean(startCmd);

    let entryCmd;
    if (useStartEntry && explicitAgentCmd) {
        entryCmd = `cd /code && (${startCmd} &) && exec ${explicitAgentCmd}`;
    } else if (useStartEntry) {
        entryCmd = `cd /code && ${startCmd}`;
    } else if (explicitAgentCmd) {
        entryCmd = `cd /code && exec ${explicitAgentCmd}`;
    } else {
        entryCmd = 'exec /bin/sh /Agent/server/AgentServer.sh';
    }

    return entryCmd;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

/**
 * Start a bwrap-sandboxed agent process.
 */
function startBwrapProcess(agentName, manifest, agentPath, options = {}) {
    const repoName = path.basename(path.dirname(agentPath));
    const containerName = options.containerName || getAgentContainerName(agentName, repoName);
    const agentSnapshot = loadAgentsMap();
    const existingRecord = agentSnapshot[containerName] || {};
    const alias = options.alias || existingRecord.alias;
    const instanceName = containerName;
    const runtimeIdentity = normalizeSandboxRuntimeIdentity(options);
    const cwd = getConfiguredProjectPath(agentName, repoName, alias);
    const workspacePath = '/workspace';

    // Profile and network are resolved atomically before any sandbox work.
    const profileRecord = existingRecord;
    const profileResolution = resolveBwrapRuntimeProfile(agentName, manifest, agentPath, options, profileRecord);
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    // Reject reserved destinations and references before any admission,
    // environment hashing/resolution, or existing-runtime inspection.  The
    // already-running fast path must be subject to the same raw provenance
    // boundary as a fresh launch.
    assertTrustedServiceRawConfiguration(manifest, profileConfig);
    const runtimeBoundary = admitBwrapBoundary(
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
        routeKey: alias || agentName,
        containerName,
    }, { preparedCapability: options.preparedHostModeCapability });
    assertBwrapPidSlotAvailable(containerName);
    const routerEndpoint = resolveSandboxRouterEndpoint(options, profileResolution.network.mode);

    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const envHash = computeEnvHash(manifest, profileConfig, routerEndpoint.env, { agentName, repoName });

    // Resolve paths
    const agentCodePath = resolveSymlinkPath(getAgentCodePath(agentName));
    assertTrustedServiceRawConfiguration(manifest, profileConfig);
    const runtimeResourcePlan = planRuntimeResources(manifest, { agentName, repoName });
    assertTrustedServiceInputs(manifest, profileConfig, runtimeResourcePlan);
    const nodeRuntime = resolveBwrapNodeRuntime();
    const agentHomeState = ensureAgentHomeAbi(
        containerName,
        runtimeIdentity.enableGeneration,
    );
    const agentHomeDir = agentHomeState.homePath;

    // Pre-container lifecycle (workspace init, symlinks, preinstall HOST hook)
    const preLifecycle = runPreContainerLifecycle(agentName, repoName, agentPath, activeProfile);
    if (!preLifecycle.success) {
        throw new Error(`[profile] ${agentName}: pre-container lifecycle failed: ${preLifecycle.errors.join('; ')}`);
    }

    // Ensure work directory and MCP config
    syncAgentMcpConfig(containerName, path.resolve(agentPath), instanceName, { workDir: agentHomeDir });

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
        agentWorkDir: agentHomeDir,
        needsCoreDeps,
    });
    const bwrapAgentRoot = path.join(BWRAP_RUNTIME_ROOT, runtimeSegment(instanceName));
    fs.mkdirSync(bwrapAgentRoot, { recursive: true });
    pruneStaleRuntimeEntries(bwrapAgentRoot);
    const agentLibPath = ensureBwrapAgentLibDir(instanceName, nodeModulesDir);

    // Port resolution — with shared host network, hostPort === containerPort
    // Must happen before env map so PORT is set correctly
    const { portMappings } = parseManifestPorts(manifest, profileConfig);
    let allPortMappings = [...portMappings];
    if (!allPortMappings.length) {
        const hostPort = options.preferredHostPort || existingRecord?.config?.ports?.[0]?.hostPort || (10000 + Math.floor(Math.random() * 50000));
        allPortMappings = [{ containerPort: hostPort, hostPort }];
    }
    const hostPort = allPortMappings.find((mapping) => mapping.containerPort === 7000)?.hostPort
        || allPortMappings[0]?.hostPort;
    if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
        throw trustedServicePolicyError(
            'trusted coding service requires one exact root loopback port',
            'PLOINKY_BWRAP_ROOT_PORT_INVALID',
        );
    }

    const routeKey = alias || agentName;
    const principalId = deriveAgentPrincipalId(repoName, agentName);
    const routerIntent = buildRouterAuthorityTopologyIntent({
        networkMode: profileResolution.network.mode,
        runtimeKind: 'bwrap',
    });
    if (!routerIntent
        || routerIntent.physicalOrigin !== routerEndpoint.url
        || routerIntent.routerHost !== routerEndpoint.host
        || Number(routerIntent.routerPort) !== routerEndpoint.port) {
        throw trustedServicePolicyError(
            'trusted coding service Router topology does not match the admitted host contract',
            'PLOINKY_BWRAP_ROUTER_TOPOLOGY_INVALID',
        );
    }
    const admittedNetworkHash = runtimeBoundary.admission.networkAdmission?.effectiveHash;
    if (!/^[a-f0-9]{64}$/.test(String(admittedNetworkHash || ''))) {
        throw trustedServicePolicyError(
            'trusted coding service network admission hash is missing or malformed',
            'PLOINKY_BWRAP_ROUTER_TOPOLOGY_INVALID',
        );
    }
    const agentCredential = buildBwrapAgentCredential({
        principalId,
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        runtimeKey: containerName,
        routeKey,
        router: {
            physicalOrigin: routerIntent.physicalOrigin,
            requestAuthority: routerIntent.requestAuthority,
            host: routerEndpoint.host,
            port: routerEndpoint.port,
        },
        admission: {
            runtimeKind: 'bwrap',
            manifestDigest: runtimeBoundary.admission.manifestDigest,
            capabilityDigest: runtimeCapabilityDigest(runtimeBoundary.admission.descriptor),
            networkHash: `sha256:${admittedNetworkHash}`,
        },
    });

    // Build environment map
    const envMap = buildFullEnvMap(agentName, manifest, profileConfig, workspacePath, repoName, activeProfile, 'bwrap', runtimeResourcePlan, routerEndpoint, runtimeIdentity);
    if (envMap.__PLOINKY_AGENT_PRIVATE_KEY_HOST_PATH) {
        throw trustedServicePolicyError(
            'trusted coding services do not admit a path-mounted agent credential',
            'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
        );
    }
    delete envMap.__PLOINKY_AGENT_PRIVATE_KEY_HOST_PATH;

    // Set PORT env var so the agent binds to the correct host port
    if (hostPort) {
        envMap.PORT = String(hostPort);
    }

    // Build the entry command
    const entryCmd = buildBwrapEntryCommand(agentName, manifest, profileConfig);
    const trustedEnvironment = buildTrustedServiceDynamicEnvironment(envMap);
    const trustedLaunch = buildTrustedServiceLaunch({
        homeSource: {
            sourceKind: BWRAP_HOME_SOURCE_KINDS.SANDBOX_WORKSPACE_V2,
            homeKey: agentHomeState.homeKey,
        },
        command: ['/bin/sh', '-c', entryCmd],
        nodeRuntimePath: nodeRuntime.hostRuntimePath,
        agentRuntimePath: agentLibPath,
        codePath: agentCodePath,
        codeDependenciesPath: nodeModulesDir,
        agentDependenciesPath: nodeModulesDir,
        environment: trustedEnvironment,
        identity: {
            principalId,
            instanceId: runtimeIdentity.instanceId,
            enableGeneration: runtimeIdentity.enableGeneration,
        },
        agentName,
        repoName,
        listenPort: hostPort,
        credentialFd: 4,
    });

    // Ensure logs directory exists
    const logsDir = LOGS_DIR;
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFile = path.join(logsDir, `${agentName}-bwrap.log`);

    console.log(`[bwrap] ${agentName}: starting sandbox (profile=${activeProfile}, cwd='${cwd}')`);
    debugLog(`[bwrap] ${agentName}: entry command: sh -c "${entryCmd}"`);
    debugLog(`[bwrap] ${agentName}: log file: ${logFile}`);

    // Spawn the immutable launcher only. It reads the complete typed policy
    // from fd 3, pins every source, and execs bwrap without a path fallback.
    assertHostModeGenerationCapability({
        agentId: deriveAgentPrincipalId(repoName, agentName),
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        routeKey: alias || agentName,
        containerName,
    }, { preparedCapability: options.preparedHostModeCapability });
    const logFd = fs.openSync(logFile, 'a');
    let spawned;
    try {
        spawned = spawnTrustedServiceLaunch(trustedLaunch, logFd, agentCredential.bytes);
    } finally {
        fs.closeSync(logFd);
    }
    const { child, getSpawnFailure } = spawned;
    child.unref();

    if (!child.pid) {
        const spawnFailure = getSpawnFailure();
        throw new Error(`[bwrap] ${agentName}: failed to spawn trusted launcher${spawnFailure ? `: ${spawnFailure.message}` : ''}`);
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
            const recentLines = logContent.split('\n').slice(-12).join('\n');
            if (recentLines) reason = recentLines;
        } catch {}
        const spawnFailure = getSpawnFailure();
        if (spawnFailure) reason = spawnFailure.message;
        throw new Error(`trusted bwrap launcher exited immediately: ${reason}`);
    }

    // Save exact service ownership after helper->bwrap exec is known alive.
    let bwrapOwner;
    try {
        bwrapOwner = saveBwrapPid(containerName, child.pid, {
            ...runtimeIdentity,
            homeKey: agentHomeState.homeKey,
            workdir: '/code',
            logPath: logFile,
            routeKey,
            rootPort: hostPort,
            credentialNonceDigest: agentCredential.publicAttestation.nonceDigest,
            credentialExpiresAt: agentCredential.publicAttestation.expiresAt,
            manifestDigest: agentCredential.publicAttestation.admission.manifestDigest,
            admissionDigest: agentCredential.publicAttestation.admissionDigest,
            networkHash: agentCredential.publicAttestation.admission.networkHash,
        });
    } catch (error) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { }
        try { process.kill(child.pid, 'SIGKILL'); } catch (_) { }
        throw error;
    }
    console.log(`[bwrap] ${agentName}: started with PID ${child.pid}`);

    try {
    // Save to agents map
    const agents = loadAgentsMap();
    const currentRecord = agents[containerName] || existingRecord;
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
        createdAt: currentRecord.createdAt || new Date().toISOString(),
        projectPath: cwd,
        runMode: existingRecord.runMode,
        develRepo: existingRecord.develRepo,
        profile: activeProfile,
        type: 'agent',
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        homeKey: agentHomeState.homeKey,
        bwrapOwner,
        runtimeStaging: {
            agentLibPath
        },
        config: {
            binds: [
                { source: agentLibPath, target: '/Agent', ro: true },
                { source: agentCodePath, target: '/code', ro: true },
                { source: nodeModulesDir, target: '/code/node_modules', ro: true },
                { source: nodeModulesDir, target: '/Agent/node_modules', ro: true },
                { source: nodeRuntime.hostRuntimePath, target: BWRAP_NODE_RUNTIME_PATH, ro: true },
                { source: PLOINKY_WORKSPACE_ROOT, target: '/workspace' },
                { source: agentHomeDir, target: '/home/agent' },
            ],
            env: Array.from(new Set(declaredEnvNames)).map((name) => ({ name })),
            ports: allPortMappings,
        }
    };
    if (currentRecord.auth) {
        agents[containerName].auth = currentRecord.auth;
    }

    if (currentRecord.alias || options.alias) {
        agents[containerName].alias = options.alias || currentRecord.alias;
    }
    if (options.preservePreparedRegistryRecord !== true) saveAgentsMap(agents);

    // Run profile lifecycle hooks (hosthook_aftercreation, postinstall HOST hooks)
    // Provider install hooks are deferred to the leased trusted update phase.
    try {
        if (profileConfig) {
            const lifecycleResult = runProfileLifecycle(agentName, activeProfile, {
                containerName,
                agentPath,
                repoName,
                manifest,
                skipInstallHooks: true,
                runtime: 'bwrap',
                runtimeIdentity,
            });
            if (!lifecycleResult.success) {
                const details = lifecycleResult.errors.join('; ');
                console.warn(`[bwrap] ${agentName}: lifecycle warning: ${details}`);
            }
        }
    } catch (error) {
        console.warn(`[bwrap] ${agentName}: lifecycle hook error: ${error.message}`);
    }

    syncAgentMcpConfig(containerName, path.resolve(agentPath), instanceName, { workDir: agentHomeDir });

    return {
        containerName,
        hostPort,
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
    // This is deliberately before admission, hashing, and process inspection:
    // the existing-service fast path must never resolve or reuse a raw
    // reserved environment declaration.
    assertTrustedServiceRawConfiguration(manifest, profileConfig);
    const runtimeBoundary = admitBwrapBoundary(
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
    const routerEndpoint = resolveSandboxRouterEndpoint(options, profileResolution.network.mode);

    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const { portMappings } = parseManifestPorts(manifest, profileConfig);
    let allPortMappings = [...portMappings];
    if (!allPortMappings.length) {
        const hostPort = preferredHostPort || existingRecord?.config?.ports?.[0]?.hostPort || (10000 + Math.floor(Math.random() * 50000));
        allPortMappings = [{ containerPort: hostPort, hostPort }];
    }

    let exactRuntimeRunning = isBwrapProcessRunning(containerName, runtimeIdentity);
    let reusableHomeState = null;

    // Force recreate
    if (forceRecreate) {
        console.log(`[bwrap] ${agentName}: force recreating...`);
        stopBwrapProcess(containerName);
        exactRuntimeRunning = false;
    }

    if (!forceRecreate && !exactRuntimeRunning && stopBwrapProcess(containerName)) {
        console.log(`[bwrap] ${agentName}: runtime generation changed, replacing stale sandbox...`);
    }

    if (exactRuntimeRunning) {
        try {
            reusableHomeState = ensureAgentHomeAbi(
                containerName,
                runtimeIdentity.enableGeneration,
            );
        } catch (error) {
            stopBwrapProcess(containerName, { expectedIdentity: runtimeIdentity });
            throw error;
        }

        if (existingRecord.homeKey !== reusableHomeState.homeKey
            || existingRecord.bwrapOwner?.homeKey !== reusableHomeState.homeKey) {
            console.log(`[bwrap] ${agentName}: sandbox HOME ABI changed, restarting...`);
            if (!stopBwrapProcess(containerName, { expectedIdentity: runtimeIdentity })) {
                throw trustedServicePolicyError(
                    'exact sandbox service could not be stopped after HOME ABI drift',
                    'PLOINKY_HOME_STATE_INCOMPATIBLE',
                );
            }
            exactRuntimeRunning = false;
            reusableHomeState = null;
        }
    }

    if (exactRuntimeRunning) {
        try {
            assertExactServiceOwner(existingRecord.bwrapOwner);
        } catch (error) {
            console.log(`[bwrap] ${agentName}: service ownership or credential generation changed, restarting...`);
            if (!stopBwrapProcess(containerName, { expectedIdentity: runtimeIdentity })) {
                throw error;
            }
            exactRuntimeRunning = false;
        }
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
            const instanceName = containerName;
            syncAgentMcpConfig(containerName, agentPath, instanceName, {
                workDir: reusableHomeState.homePath,
            });
            return {
                containerName,
                hostPort,
                createdByThisLaunch: false,
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
        runtimeAdmission: runtimeBoundary.admission,
        manifestBytes: runtimeBoundary.manifestBytes,
        preparedHostModeCapability: options.preparedHostModeCapability,
    });
}

/**
 * Spawn an interactive bwrap session (for `ploinky cli` / `ploinky shell`).
 * Creates a NEW bwrap sandbox with the same mount layout as the running agent,
 * but runs the given command instead of the agent server.
 * Uses --die-with-parent so the session is cleaned up when the parent exits.
 */
async function attachBwrapInteractive(agentName, manifest, agentPath, workdir, entryCommand, options = {}) {
    const repoName = path.basename(path.dirname(agentPath));
    const containerName = options.containerName || getAgentContainerName(agentName, repoName);
    const agents = loadAgentsMap();
    const record = agents[containerName];

    if (!record || record.runtime !== 'bwrap') {
        throw trustedServicePolicyError(
            `[bwrap] ${agentName}: exact bwrap service is not running`,
            'PLOINKY_MANUAL_RUNTIME_MISMATCH',
        );
    }
    const runtimeIdentity = normalizeSandboxRuntimeIdentity(record);
    const selectedWorkdir = normalizeManagedInteractiveWorkdir(workdir);

    // Use the running record's persisted profile unless the caller explicitly
    // selected another valid profile for this interactive sandbox.
    const profileResolution = resolveBwrapRuntimeProfile(agentName, manifest, agentPath, options, record);
    const activeProfile = profileResolution.resolvedProfileName;
    const profileConfig = profileResolution.profileConfig;
    assertTrustedServiceRawConfiguration(manifest, profileConfig);
    const runtimeBoundary = admitBwrapBoundary(
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
        routeKey: record.alias || agentName,
        containerName,
    });
    const owner = assertExactServiceOwner(record.bwrapOwner);
    const routerEndpoint = resolveSandboxRouterEndpoint(options, profileResolution.network.mode);

    // Resolve immutable sources only after the selected workdir grammar has
    // been admitted. The helper performs the final openat2 revalidation.
    const agentCodePath = resolveSymlinkPath(getAgentCodePath(agentName));
    const instanceName = record.alias || agentName;
    const agentHomeState = ensureAgentHomeAbi(containerName, runtimeIdentity.enableGeneration);
    if (record.homeKey !== agentHomeState.homeKey
        || owner.homeKey !== agentHomeState.homeKey) {
        throw trustedServicePolicyError(
            'interactive attach observed a different sandbox HOME generation',
            'PLOINKY_HOME_STATE_INCOMPATIBLE',
        );
    }
    const agentHomeDir = agentHomeState.homePath;
    const agentHasPackageJson = fs.existsSync(path.join(agentCodePath, 'package.json'));
    const startCmd = readManifestStartCommand(manifest);
    const needsCoreDeps = !startCmd || agentHasPackageJson;
    const nodeModulesDir = resolveBwrapAgentNodeModules({
        repoName,
        agentName,
        agentCodePath,
        agentWorkDir: agentHomeDir,
        needsCoreDeps,
    });
    const bwrapAgentRoot = path.join(BWRAP_RUNTIME_ROOT, runtimeSegment(instanceName));
    fs.mkdirSync(bwrapAgentRoot, { recursive: true });
    const serviceAgentLibPath = record.runtimeStaging?.agentLibPath;
    pruneStaleRuntimeEntries(bwrapAgentRoot, {
        keepPaths: serviceAgentLibPath ? [serviceAgentLibPath] : []
    });
    const agentLibPath = ensureBwrapAgentLibDir(instanceName, nodeModulesDir);

    const runtimeResourcePlan = planRuntimeResources(manifest, { agentName, repoName });
    assertTrustedServiceInputs(manifest, profileConfig, runtimeResourcePlan);
    const nodeRuntime = resolveBwrapNodeRuntime();
    assertManifestEnvProfileCompleteness(manifest, profileConfig, { agentName, repoName, profileName: activeProfile });
    const envMap = buildFullEnvMap(
        agentName,
        manifest,
        profileConfig,
        '/workspace',
        repoName,
        activeProfile,
        'bwrap',
        runtimeResourcePlan,
        routerEndpoint,
        runtimeIdentity,
    );
    if (envMap.__PLOINKY_AGENT_PRIVATE_KEY_HOST_PATH) {
        throw trustedServicePolicyError(
            'interactive bwrap cannot admit a path-mounted agent credential',
            'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
        );
    }
    delete envMap.__PLOINKY_AGENT_PRIVATE_KEY_HOST_PATH;
    const hostPort = record.config?.ports?.[0]?.hostPort;
    if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
        throw trustedServicePolicyError(
            'interactive bwrap requires the exact running root service port',
            'PLOINKY_BWRAP_ROOT_PORT_INVALID',
        );
    }
    envMap.PORT = String(hostPort);
    if (shouldAllocateInteractiveTty()) {
        for (const key of ['TERM', 'COLORTERM', 'LINES', 'COLUMNS']) {
            if (process.env[key]) envMap[key] = process.env[key];
        }
    }

    const routeKey = record.alias || agentName;
    const principalId = deriveAgentPrincipalId(repoName, agentName);
    const routerIntent = buildRouterAuthorityTopologyIntent({
        networkMode: profileResolution.network.mode,
        runtimeKind: 'bwrap',
    });
    if (!routerIntent
        || routerIntent.physicalOrigin !== routerEndpoint.url
        || routerIntent.routerHost !== routerEndpoint.host
        || Number(routerIntent.routerPort) !== routerEndpoint.port) {
        throw trustedServicePolicyError(
            'interactive bwrap Router topology does not match the admitted host contract',
            'PLOINKY_BWRAP_ROUTER_TOPOLOGY_INVALID',
        );
    }
    const admittedNetworkHash = runtimeBoundary.admission.networkAdmission?.effectiveHash;
    if (!/^[a-f0-9]{64}$/.test(String(admittedNetworkHash || ''))) {
        throw trustedServicePolicyError(
            'interactive bwrap network admission hash is missing or malformed',
            'PLOINKY_BWRAP_ROUTER_TOPOLOGY_INVALID',
        );
    }
    const trustedEnvironment = buildTrustedServiceDynamicEnvironment(envMap);
    const trustedLaunch = buildTrustedInteractiveLaunch({
        homeSource: {
            sourceKind: BWRAP_HOME_SOURCE_KINDS.SANDBOX_WORKSPACE_V2,
            homeKey: agentHomeState.homeKey,
        },
        workdir: selectedWorkdir,
        command: ['/bin/sh', '-lc', String(entryCommand || '')],
        nodeRuntimePath: nodeRuntime.hostRuntimePath,
        agentRuntimePath: agentLibPath,
        codePath: agentCodePath,
        codeDependenciesPath: nodeModulesDir,
        agentDependenciesPath: nodeModulesDir,
        environment: trustedEnvironment,
        identity: {
            principalId,
            instanceId: runtimeIdentity.instanceId,
            enableGeneration: runtimeIdentity.enableGeneration,
        },
        agentName,
        repoName,
        listenPort: hostPort,
        credentialFd: 4,
    });
    const agentCredential = buildBwrapAgentCredential({
        principalId,
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
        runtimeKey: containerName,
        routeKey,
        router: {
            physicalOrigin: routerIntent.physicalOrigin,
            requestAuthority: routerIntent.requestAuthority,
            host: routerEndpoint.host,
            port: routerEndpoint.port,
        },
        admission: {
            runtimeKind: 'bwrap',
            manifestDigest: runtimeBoundary.admission.manifestDigest,
            capabilityDigest: runtimeCapabilityDigest(runtimeBoundary.admission.descriptor),
            networkHash: `sha256:${admittedNetworkHash}`,
        },
    });

    debugLog(`[bwrap] ${agentName}: trusted interactive helper workdir=/workspace/${selectedWorkdir}`);

    try {
        assertHostModeGenerationCapability({
            agentId: principalId,
            instanceId: runtimeIdentity.instanceId,
            enableGeneration: runtimeIdentity.enableGeneration,
            routeKey,
            containerName,
        });
        return await spawnTrustedInteractiveLaunch(trustedLaunch, agentCredential.bytes, {
            assertHelper: assertTrustedBwrapHelper,
        });
    } finally {
        try {
            fs.rmSync(agentLibPath, { recursive: true, force: true });
        } catch (_) {}
    }
}

export {
    ensureBwrapService,
    resolveBwrapRuntimeProfile,
    startBwrapProcess,
    buildTrustedServiceLaunch,
    buildTrustedInteractiveLaunch,
    spawnTrustedServiceLaunch,
    buildBwrapArgs,
    buildFullEnvMap,
    buildBwrapInteractiveCommand,
    ensureBwrapAgentLibDir,
    resolveBwrapNodeRuntime,
    attachBwrapInteractive,
    BWRAP_HELPER_PATH
};
