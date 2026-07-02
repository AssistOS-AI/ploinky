import { execSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    assertManifestEnvProfileCompleteness,
    buildEnvFlags,
    formatEnvFlag,
    getExposedNames,
    getManifestEnvSpecs,
    getManifestEnvNames,
    resolveManifestImage,
    resolveVarValue
} from '../secretVars.js';
import { buildAgentIdentityEnv, RESERVED_AGENT_ENV_NAMES } from '../agentIdentityEnv.js';
import { debugLog } from '../utils.js';
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
    parseHostPort,
    parseManifestPorts,
    saveAgentsMap,
    syncAgentMcpConfig
} from './common.js';
import { clearLivenessState } from './healthProbes.js';
import { stopAndRemove } from './containerFleet.js';
import { buildContainerSecurityArgs, resolveContainerSecurity } from './containerSecurity.js';
import { DEFAULT_AGENT_ENTRY, launchAgentSidecar, readManifestAgentCommand, readManifestStartCommand, splitCommandArgs } from './agentCommands.js';
import { AGENTS_DATA_DIR, PLOINKY_DIR, ROUTING_FILE, PLOINKY_WORKSPACE_ROOT } from '../config.js';
import {
    planRuntimeResources,
    applyRuntimeResourceEnv,
    ensurePersistentStorageHostDir
} from '../runtimeResourcePlanner.js';
import { deriveAgentPrincipalId } from '../agentIdentity.js';
import { ensureSharedHostDir, runPostinstallHook } from './agentHooks.js';
import { ensureBwrapService } from '../bwrap/bwrapServiceManager.js';
import { ensureSeatbeltService } from '../seatbelt/seatbeltServiceManager.js';
import { detectShellForImage, SHELL_FALLBACK_DIRECT } from './shellDetection.js';
import {
    detectContainerRuntimeKey,
    detectRuntimeKeyForAgent,
} from '../dependencyRuntimeKey.js';
import { nodeModulesDir, prepareAgentCache } from '../dependencyCache.js';
import {
    runPreContainerLifecycle,
    runProfileLifecycle
} from '../lifecycleHooks.js';
import {
    formatMissingSecretsError,
    getSecrets,
    validateSecrets
} from '../secretInjector.js';
import {
    getActiveProfile,
    getDefaultMountModes,
    getProfileConfig,
    getProfileEnvVars,
    mergeProfiles
} from '../profileService.js';
import {
    createProfileServerPublish,
    resolvePublishedProfileServer,
    resolveProfileServer
} from '../profileServer.js';
import {
    getAgentWorkDir,
    getAgentCodePath,
    getAgentSkillsPath
} from '../workspaceStructure.js';
import {
    prepareFreshRuntimeRoot,
    runtimeSegment
} from '../runtimeStaging.js';
import {
    ensureManifestVolumeHostPath,
    readManifestVolumeOptions,
    resolveManifestVolumeHostPath
} from '../manifestVolumePolicy.js';
import {
    isLlmRuntimeManifest,
    prepareLlmStartup,
} from '../llmRuntimeIntegration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_LIB_PATH = path.resolve(__dirname, '../../../Agent');
const AGENT_PRIVATE_KEY_CONTAINER_PATH = '/run/ploinky-agent.key';
const PODMAN_STAGED_NODE_OPTIONS = ['--preserve-symlinks', '--preserve-symlinks-main'];
const PODMAN_RUNTIME_ROOT = path.join(PLOINKY_DIR, 'container-runtime');
const LLM_RUNTIME_MCP_PORT = 9000;
const LLM_RUNTIME_INFERENCE_PORT = 8080;
const LLM_MODEL_SECRET_FILE_ENV = 'PLOINKY_MODEL_SECRET_FILE';
const LLM_MODEL_SECRET_CONTAINER_PATH = '/run/secrets/hf_token';
const LLM_RUNTIME_BASE_ENV_NAMES = Object.freeze([
    'HF_HOME',
    'PLOINKY_MODELS_DIR',
    'PLOINKY_DERIVED_DIR',
    'PLOINKY_RUNTIME_DIR',
    'PLOINKY_LAUNCHERS_DIR',
    'PLOINKY_MCP_PORT',
    'PLOINKY_INFERENCE_PORT',
]);
const LLM_RUNTIME_AUTH_ENV_NAMES = Object.freeze([
    'PLOINKY_INVOCATION_AUTH_MODULE',
    'PLOINKY_REQUEST_HASH_MODULE',
]);
const LLM_RUNTIME_MANAGED_ENV_NAMES = Object.freeze([
    ...LLM_RUNTIME_BASE_ENV_NAMES,
    ...LLM_RUNTIME_AUTH_ENV_NAMES,
    LLM_MODEL_SECRET_FILE_ENV,
]);
const RETIRED_LLM_RUNTIME_ENV_NAMES = new Set([
    'PLOINKY_LLM_PUBLIC_PORT',
    'PLOINKY_LLM_MCP_PORT',
    'PLOINKY_LLM_CONTROL_PORT',
    'PLOINKY_LLM_LAUNCHERS_DIR',
]);
const LLM_SECRET_ONLY_ENV_NAMES = new Set(['HF_TOKEN']);
const LLM_RESERVED_MOUNT_TARGETS = ['/workspace', '/models', '/runtime'];

function formattedEnvFlagName(flag) {
    const match = /^-e ([A-Za-z_][A-Za-z0-9_]*)=/.exec(String(flag || ''));
    return match ? match[1] : '';
}

function stripManagedEnvFlags(envStrings, envNames) {
    const blocked = new Set(envNames.filter(Boolean));
    for (let i = envStrings.length - 1; i >= 0; i -= 1) {
        const name = formattedEnvFlagName(envStrings[i]);
        if (name && blocked.has(name)) {
            envStrings.splice(i, 1);
        }
    }
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

function privateTempFilePath(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return path.join(dir, `.${base}.tmp-${nonce}`);
}

function ensurePrivateDirectory(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
    return dir;
}

function writePrivateFile(filePath, value) {
    ensurePrivateDirectory(path.dirname(filePath));
    const tmpPath = privateTempFilePath(filePath);
    let fd = null;
    let cleanupTmp = false;
    try {
        fd = fs.openSync(tmpPath, 'wx', 0o600);
        cleanupTmp = true;
        fs.writeFileSync(fd, value, { encoding: 'utf8' });
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, filePath);
        cleanupTmp = false;
        try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        if (cleanupTmp) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
        }
    }
    return filePath;
}

function llmModelSecretHostPath(identity) {
    const workspaceHash = crypto
        .createHash('sha256')
        .update(PLOINKY_WORKSPACE_ROOT)
        .digest('hex')
        .slice(0, 16);
    const safeIdentity = String(identity || 'agent').replace(/[^A-Za-z0-9._-]/g, '_') || 'agent';
    return path.join(os.tmpdir(), 'ploinky-llm-runtime-secrets', workspaceHash, safeIdentity, 'hf_token');
}

function prepareLlmModelSecretMount(llmStartup, profileSecrets) {
    if (!llmStartup?.enabled || !llmStartup.stateDir) return null;
    if (!Object.prototype.hasOwnProperty.call(profileSecrets || {}, 'HF_TOKEN')) return null;
    const hostPath = llmModelSecretHostPath(llmStartup.identity);
    writePrivateFile(hostPath, String(profileSecrets.HF_TOKEN ?? ''));
    return {
        source: hostPath,
        target: LLM_MODEL_SECRET_CONTAINER_PATH,
        ro: true,
    };
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
    return {
        PLOINKY_ROUTER_PORT: routerPort,
        PLOINKY_ROUTER_HOST: routerHost,
        PLOINKY_ROUTER_URL: `http://${routerHost}:${routerPort}`,
    };
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

function resolveEffectiveManifestNetwork(manifest, profileConfig) {
    const profileNetwork = profileConfig?.network && typeof profileConfig.network === 'object' ? profileConfig.network : null;
    const rootNetwork = manifest?.network && typeof manifest.network === 'object' ? manifest.network : null;
    return profileNetwork || rootNetwork;
}

function assertLlmRuntimeNetworkAllowed(agentName, manifestNetwork) {
    const mode = String(manifestNetwork?.mode || '').trim().toLowerCase();
    const name = String(manifestNetwork?.name || '').trim().toLowerCase();
    if (mode === 'host' || mode === 'container' || mode.startsWith('container:') || mode.startsWith('service:')) {
        throw new Error(
            `[llm-runtime] ${agentName}: network.mode '${mode}' is not supported for LLM runtime containers; `
            + 'runtime ports must be published as 127.0.0.1:<host>:9000 and 127.0.0.1:<host>:8080.'
        );
    }
    if (name === 'host' || name.startsWith('container:') || name.startsWith('service:')) {
        throw new Error(
            `[llm-runtime] ${agentName}: network.name '${name}' is not supported for LLM runtime containers; `
            + 'runtime ports must be published as 127.0.0.1:<host>:9000 and 127.0.0.1:<host>:8080.'
        );
    }
}

function hasManifestEntrypoint(manifest) {
    if (!manifest || !Object.prototype.hasOwnProperty.call(manifest, 'entrypoint')) return false;
    const value = manifest.entrypoint;
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) return value.length > 0;
    return true;
}

function assertLlmRuntimeEntrypointAllowed(agentName, { startCmd, explicitAgentCmd, manifestEntrypoint } = {}) {
    if (startCmd || explicitAgentCmd || manifestEntrypoint) {
        const fields = [];
        if (startCmd) fields.push('start');
        if (explicitAgentCmd) fields.push('agent/commands.run');
        if (manifestEntrypoint) fields.push('entrypoint');
        throw new Error(
            `[llm-runtime] ${agentName}: explicit startup command fields are not supported for LLM runtime manifests`
            + `${fields.length ? ` (${fields.join(', ')})` : ''}; `
            + 'remove manifest start, agent, commands.run, and entrypoint so the image ENTRYPOINT runs.'
        );
    }
}

function collectProfileEnvNames(profileConfig) {
    if (!profileConfig?.env || typeof profileConfig.env !== 'object' || Array.isArray(profileConfig.env)) {
        return [];
    }
    return Object.keys(profileConfig.env);
}

function collectProfileSecretNames(profileConfig) {
    if (!Array.isArray(profileConfig?.secrets)) {
        return [];
    }
    return profileConfig.secrets.map((name) => String(name || '').trim()).filter(Boolean);
}

function collectRuntimeResourceEnvNames(manifest) {
    const env = manifest?.runtime?.resources?.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        return [];
    }
    return Object.keys(env);
}

function collectRuntimeResourceEnvTemplateRefs(manifest) {
    const env = manifest?.runtime?.resources?.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        return [];
    }
    const refs = [];
    for (const rawValue of Object.values(env)) {
        if (typeof rawValue !== 'string') continue;
        rawValue.replace(/\{\{([^}]+)\}\}/g, (_match, exprRaw) => {
            const expr = String(exprRaw || '').trim();
            const separatorIndex = expr.indexOf(':');
            if (separatorIndex < 0) return '';
            const referencedName = expr.slice(separatorIndex + 1).trim();
            if (referencedName) refs.push(referencedName);
            return '';
        });
    }
    return refs;
}

function collectDollarEnvRef(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed.startsWith('$')) return '';
    return trimmed.slice(1).trim();
}

function collectManifestExposeSourceRefs(manifest) {
    const exp = manifest?.expose;
    const refs = [];
    if (Array.isArray(exp)) {
        for (const spec of exp) {
            if (!spec || typeof spec !== 'object') continue;
            if (spec.ref) refs.push(String(spec.ref).trim());
            const valueRef = collectDollarEnvRef(spec.value);
            if (valueRef) refs.push(valueRef);
        }
    } else if (exp && typeof exp === 'object') {
        for (const value of Object.values(exp)) {
            const valueRef = collectDollarEnvRef(value);
            if (valueRef) refs.push(valueRef);
        }
    }
    return refs.filter(Boolean);
}

function collectPlainLlmEnvRefs(manifest, profileConfig) {
    const refs = new Set([
        ...getExposedNames(manifest, profileConfig),
        ...collectManifestExposeSourceRefs(manifest),
        ...collectProfileEnvNames(profileConfig),
        ...collectRuntimeResourceEnvNames(manifest),
        ...collectRuntimeResourceEnvTemplateRefs(manifest),
    ]);
    for (const spec of getManifestEnvSpecs(manifest, profileConfig)) {
        if (spec?.insideName) refs.add(spec.insideName);
        if (spec?.sourceName) refs.add(spec.sourceName);
    }
    return refs;
}

function assertNoRetiredLlmRuntimeEnv(agentName, manifest, profileConfig) {
    const envNames = new Set([
        ...collectPlainLlmEnvRefs(manifest, profileConfig),
        ...collectProfileSecretNames(profileConfig),
    ]);
    const retiredNames = Array.from(envNames)
        .map((name) => String(name || '').trim())
        .filter((name) => RETIRED_LLM_RUNTIME_ENV_NAMES.has(name))
        .sort();
    if (!retiredNames.length) return;
    throw new Error(
        `[llm-runtime] ${agentName}: retired LLM runtime env names are not supported: ${retiredNames.join(', ')}. `
        + 'Use the clean runtime contract env names owned by Ploinky.'
    );
}

function assertNoPlainLlmSecretEnv(agentName, manifest, profileConfig) {
    const secretOnlyNames = Array.from(collectPlainLlmEnvRefs(manifest, profileConfig))
        .map((name) => String(name || '').trim())
        .filter((name) => LLM_SECRET_ONLY_ENV_NAMES.has(name))
        .sort();
    if (!secretOnlyNames.length) return;
    throw new Error(
        `[llm-runtime] ${agentName}: ${secretOnlyNames.join(', ')} must be supplied as secret env `
        + 'through profile secrets, not manifest/profile/runtime resource env or env source templates.'
    );
}

function normalizeContainerMountTarget(containerPath) {
    const normalized = String(containerPath || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/');
    if (!normalized || normalized === '/') return normalized;
    return normalized.replace(/\/+$/, '');
}

function reservedLlmMountForTarget(containerPath) {
    const target = normalizeContainerMountTarget(containerPath);
    return LLM_RESERVED_MOUNT_TARGETS.find((reservedTarget) => (
        target === reservedTarget || target.startsWith(`${reservedTarget}/`)
    )) || '';
}

function assertNoLlmReservedVolumeTargets(agentName, manifest) {
    if (!manifest?.volumes || typeof manifest.volumes !== 'object' || Array.isArray(manifest.volumes)) {
        return;
    }
    for (const containerPath of Object.values(manifest.volumes)) {
        const reservedTarget = reservedLlmMountForTarget(containerPath);
        if (!reservedTarget) continue;
        throw new Error(
            `[llm-runtime] ${agentName}: manifest volume target '${containerPath}' conflicts with reserved `
            + `LLM runtime mount '${reservedTarget}'.`
        );
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

function appendEnvFlagsFromMap(envFlags, envMap, options = {}) {
    if (!envMap || typeof envMap !== 'object' || Array.isArray(envMap)) {
        return;
    }
    const skipNames = options.skipNames instanceof Set ? options.skipNames : new Set();
    for (const [name, value] of Object.entries(envMap)) {
        if (!name) continue;
        if (skipNames.has(String(name))) continue;
        envFlags.push(formatEnvFlag(String(name), value ?? ''));
    }
}

function assertNoLlmReservedRuntimeResourceTargets(agentName, manifest) {
    const persistentStorage = manifest?.runtime?.resources?.persistentStorage;
    if (!persistentStorage || typeof persistentStorage !== 'object' || Array.isArray(persistentStorage)) {
        return;
    }
    const containerPath = persistentStorage.containerPath;
    const reservedTarget = reservedLlmMountForTarget(containerPath);
    if (!reservedTarget) return;
    throw new Error(
        `[llm-runtime] ${agentName}: runtime resource persistent storage containerPath '${containerPath}' conflicts `
        + `with reserved LLM runtime mount '${reservedTarget}'.`
    );
}

function hasContainerPortMapping(mappings, containerPort) {
    return Array.isArray(mappings)
        && mappings.some((mapping) => Number(mapping?.containerPort) === Number(containerPort));
}

function isLlmRuntimeContainerPort(containerPort) {
    const parsed = Number(containerPort);
    return parsed === LLM_RUNTIME_MCP_PORT || parsed === LLM_RUNTIME_INFERENCE_PORT;
}

function publishArgContainerPortSpec(publishArg) {
    const parts = String(publishArg || '').trim().split(':');
    return parts[parts.length - 1] || '';
}

function portSpecIncludesContainerPort(portSpec, containerPort) {
    const raw = String(portSpec || '').split('/')[0].trim();
    const match = raw.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) return false;
    const start = Number.parseInt(match[1], 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    return Number.isInteger(start)
        && Number.isInteger(end)
        && start > 0
        && end >= start
        && Number(containerPort) >= start
        && Number(containerPort) <= end;
}

function publishArgTargetsLlmRuntimePort(publishArg) {
    const containerSpec = publishArgContainerPortSpec(publishArg);
    return portSpecIncludesContainerPort(containerSpec, LLM_RUNTIME_MCP_PORT)
        || portSpecIncludesContainerPort(containerSpec, LLM_RUNTIME_INFERENCE_PORT);
}

function formatPublishArgFromMapping(mapping) {
    const hostPort = Number(mapping?.hostPort);
    const hostPortSpec = Number.isFinite(hostPort) && hostPort > 0 ? String(hostPort) : '';
    const containerPort = Number(mapping?.containerPort);
    const protocol = String(mapping?.protocol || 'tcp').toLowerCase();
    const protocolSuffix = protocol && protocol !== 'tcp' ? `/${protocol}` : '';
    return `127.0.0.1:${hostPortSpec}:${containerPort}${protocolSuffix}`;
}

function ensureLlmRuntimeLoopbackPublish(publishArgs, portMappings) {
    const nextPublishArgs = Array.isArray(publishArgs)
        ? publishArgs.filter((arg) => !publishArgTargetsLlmRuntimePort(arg))
        : [];
    const nextPortMappings = [];
    const llmMappings = new Map();
    for (const mapping of Array.isArray(portMappings) ? portMappings : []) {
        const containerPort = Number(mapping?.containerPort);
        if (!isLlmRuntimeContainerPort(containerPort)) {
            nextPortMappings.push(mapping);
            continue;
        }
        llmMappings.set(containerPort, {
            ...mapping,
            hostIp: '127.0.0.1',
            protocol: 'tcp',
        });
    }
    for (const containerPort of [LLM_RUNTIME_MCP_PORT, LLM_RUNTIME_INFERENCE_PORT]) {
        if (!hasContainerPortMapping(Array.from(llmMappings.values()), containerPort)) {
            llmMappings.set(containerPort, {
                hostIp: '127.0.0.1',
                hostPort: 0,
                containerPort,
                protocol: 'tcp',
            });
        }
        const mapping = llmMappings.get(containerPort);
        nextPublishArgs.push(formatPublishArgFromMapping(mapping));
        nextPortMappings.push(mapping);
    }
    return { publishArgs: nextPublishArgs, portMappings: nextPortMappings };
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
    const manifestEntrypoint = typeof manifest?.entrypoint === 'string' ? manifest.entrypoint.trim() : '';
    const manifestEntrypointOverride = hasManifestEntrypoint(manifest);
    const useStartEntry = Boolean(startCmd);
    const launchExplicitSidecar = Boolean(startCmd && explicitAgentCmd);
    const cwd = getConfiguredProjectPath(agentName, path.basename(path.dirname(agentPath)), options.alias);
    const isolatedHome = (existingRecord.runMode || 'isolated') === 'isolated';
    const agentHomeDir = getAgentWorkDir(instanceName);
    const containerCwd = isolatedHome ? '/root' : cwd;
    const cwdMountTarget = isolatedHome ? '/root' : cwd;
    const sharedDir = ensureSharedHostDir();

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
    const llmRuntimeEnabled = isLlmRuntimeManifest(manifest, profileConfig);
    const effectiveManifestNetwork = resolveEffectiveManifestNetwork(manifest, profileConfig);
    if (llmRuntimeEnabled) {
        assertLlmRuntimeNetworkAllowed(agentName, effectiveManifestNetwork);
        assertLlmRuntimeEntrypointAllowed(agentName, {
            startCmd,
            explicitAgentCmd,
            manifestEntrypoint: manifestEntrypointOverride,
        });
        assertNoRetiredLlmRuntimeEnv(agentName, manifest, profileConfig);
        assertNoPlainLlmSecretEnv(agentName, manifest, profileConfig);
        assertNoLlmReservedVolumeTargets(agentName, manifest);
        assertNoLlmReservedRuntimeResourceTargets(agentName, manifest);
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
    const runtimeRouterEnv = buildRuntimeRouterEnv(runtime, options);
    const envHash = computeEnvHash(manifest, profileConfig, runtimeRouterEnv, { agentName, repoName });

    // LLM runtime opt-in: catalog-driven image, hardware-aware policy, reuse hash.
    // Resolved BEFORE dependency cache prep so the cache uses the selected image.
    let llmStartup = { enabled: false };
    if (llmRuntimeEnabled) {
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
            effectiveNetwork: effectiveManifestNetwork,
        });
        if (llmStartup.enabled && llmStartup.imageRunRef) {
            image = llmStartup.imageRunRef;
            debugLog(`[llm-runtime] ${agentName}: catalog-selected image ${llmStartup.imageRef} (arch ${llmStartup.selection.architectureId})`);
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
    const needsCoreDeps = !useStartEntry || agentHasPackageJson || isLlmRuntimeManifest(manifest, profileConfig);
    let preparedNodeModulesDir = path.join(agentWorkDir, 'node_modules');
    if (needsCoreDeps) {
        const runtimeKey = llmStartup.enabled
            ? detectContainerRuntimeKey({ manifest, profileConfig, repoName, agentName, runtime, image })
            : detectRuntimeKeyForAgent(manifest, repoName, agentName, profileConfig, image);
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
    const defaultContainerWorkdir = llmStartup.enabled ? '/workspace' : (isolatedHome ? '/root' : '/code');
    const containerWorkdir = String(manifest?.workdir || defaultContainerWorkdir).trim() || defaultContainerWorkdir;
    const args = ['run', '-d', '--name', containerName, '--label', `ploinky.envhash=${envHash}`, '-w', containerWorkdir,
        // Agent library (always ro)
        '-v', `${agentLibMountPath}:/Agent${runtime === 'podman' ? ':z,ro' : ':ro'}`,
        // Code directory - profile dependent (rw in dev, ro in qa/prod)
        '-v', `${codeMountPath}:/code${codeMountMode}`,
        ...(llmStartup.enabled ? [
            '-v', `${codeMountPath}:/workspace${codeMountMode}`,
        ] : []),
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
    const manifestNetwork = effectiveManifestNetwork;
    const manifestNetworkMode = String(manifestNetwork?.mode || '').trim().toLowerCase();
    const manifestNetworkName = String(manifestNetwork?.name || '').trim();
    const manifestNetworkAliases = Array.isArray(manifestNetwork?.aliases)
        ? manifestNetwork.aliases.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const useHostNetwork = manifestNetworkMode === 'host';
    const additionalServerPort = resolveProfileServer(manifest, profileConfig, {
        runtimeMode: useHostNetwork ? 'host' : 'container'
    });
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
        args.splice(1, 0, '--network', 'slirp4netns:allow_host_loopback=true');
        args.splice(1, 0, '--replace');
    } else if (runtime === 'docker') {
        args.splice(1, 0, '--add-host', 'host.docker.internal:host-gateway');
    }

    for (const { resolvedHostPath, containerPath } of manifestVolumeMounts) {
        args.push('-v', `${resolvedHostPath}:${containerPath}${runtime === 'podman' ? ':z' : ''}`);
    }

    const { publishArgs: manifestPorts, portMappings } = parseManifestPorts(manifest, profileConfig);
    const runtimePorts = (options && Array.isArray(options.publish)) ? options.publish : [];
    const runtimePortMappings = (options && Array.isArray(options.publishMappings)) ? options.publishMappings : [];
    const llmPublishPlan = llmStartup.enabled
        ? ensureLlmRuntimeLoopbackPublish([...manifestPorts, ...runtimePorts], [...portMappings, ...runtimePortMappings])
        : { publishArgs: [...manifestPorts, ...runtimePorts], portMappings: [...portMappings, ...runtimePortMappings] };
    const basePortMappings = llmPublishPlan.portMappings;
    const profileServerPublish = useHostNetwork ? null : createProfileServerPublish(additionalServerPort, basePortMappings);
    const profileServerPublishArgs = profileServerPublish ? [profileServerPublish.publishArg] : [];
    const effectivePortMappings = profileServerPublish
        ? [...basePortMappings, profileServerPublish.mapping]
        : basePortMappings;
    const pubs = useHostNetwork ? [] : [...llmPublishPlan.publishArgs, ...profileServerPublishArgs];
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

    let llmModelSecretMount = null;
    if (profileConfig?.secrets && profileConfig.secrets.length > 0) {
        const secretValidation = validateSecrets(profileConfig.secrets);
        if (!secretValidation.valid) {
            throw new Error(formatMissingSecretsError(secretValidation.missing, activeProfile));
        }
        const profileSecrets = getSecrets(profileConfig.secrets);
        if (llmStartup.enabled) {
            llmModelSecretMount = prepareLlmModelSecretMount(llmStartup, profileSecrets);
        }
        appendEnvFlagsFromMap(envStrings, profileSecrets, {
            skipNames: llmStartup.enabled ? LLM_SECRET_ONLY_ENV_NAMES : new Set(),
        });
    }

    appendRuntimeRouterEnvFlags(envStrings, runtimeRouterEnv);

    // Config may not supply router-managed identity envs, and non-LLM config may
    // not smuggle the LLM runtime auth module pointers into a normal agent. For
    // LLM agents, strip every clean runtime-managed env before appending the
    // authoritative values below so config cannot override or duplicate them.
    stripManagedEnvFlags(envStrings, [
        ...RESERVED_AGENT_ENV_NAMES,
        ...LLM_RUNTIME_AUTH_ENV_NAMES,
        ...(llmStartup.enabled ? LLM_RUNTIME_MANAGED_ENV_NAMES : []),
    ]);

    // DS013/DS011: re-assert the authoritative agent identity after config layers
    // have been stripped, so no config can inject a master key or override the
    // agent's derived secret.
    try {
        for (const [key, value] of Object.entries(buildAgentIdentityEnv(deriveAgentPrincipalId(path.basename(path.dirname(agentPath)), agentName)))) {
            envStrings.push(formatEnvFlag(key, value));
        }
    } catch (err) {
        debugLog(`[invocationAuth] could not set agent identity for ${agentName}: ${err?.message || err}`);
    }
    envStrings.push(formatEnvFlag('HOME', '/root'));

    if (llmStartup.enabled) {
        envStrings.push(formatEnvFlag('HF_HOME', '/models/hf-cache'));
        envStrings.push(formatEnvFlag('PLOINKY_MODELS_DIR', '/models/artifacts'));
        envStrings.push(formatEnvFlag('PLOINKY_DERIVED_DIR', '/models/derived'));
        envStrings.push(formatEnvFlag('PLOINKY_RUNTIME_DIR', '/runtime'));
        envStrings.push(formatEnvFlag('PLOINKY_LAUNCHERS_DIR', '/workspace/modelLaunchers'));
        envStrings.push(formatEnvFlag('PLOINKY_MCP_PORT', String(LLM_RUNTIME_MCP_PORT)));
        envStrings.push(formatEnvFlag('PLOINKY_INFERENCE_PORT', String(LLM_RUNTIME_INFERENCE_PORT)));
        envStrings.push(formatEnvFlag('PLOINKY_INVOCATION_AUTH_MODULE', '/Agent/lib/invocationAuth.mjs'));
        envStrings.push(formatEnvFlag('PLOINKY_REQUEST_HASH_MODULE', '/Agent/lib/requestHash.mjs'));
        if (llmModelSecretMount) {
            args.push('-v', `${llmModelSecretMount.source}:${llmModelSecretMount.target}${runtime === 'podman' ? ':z,ro' : ':ro'}`);
            envStrings.push(formatEnvFlag(LLM_MODEL_SECRET_FILE_ENV, llmModelSecretMount.target));
        }
    }

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
    } else if (llmStartup.enabled) {
        entrySummary = 'image ENTRYPOINT';
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
    const stateManagedEnvNames = new Set([
        ...RESERVED_AGENT_ENV_NAMES,
        ...LLM_RUNTIME_AUTH_ENV_NAMES,
        ...(llmStartup.enabled ? LLM_RUNTIME_MANAGED_ENV_NAMES : []),
    ]);
    const declaredEnvNames2 = [
        ...getManifestEnvNames(manifest, profileConfig),
        ...getExposedNames(manifest, profileConfig),
        ...Object.keys(profileEnv)
    ].filter((name) => !stateManagedEnvNames.has(name));
    const llmRuntimeEnvNames = llmStartup.enabled
        ? [
            ...LLM_RUNTIME_BASE_ENV_NAMES,
            ...LLM_RUNTIME_AUTH_ENV_NAMES,
            ...(llmModelSecretMount ? [LLM_MODEL_SECRET_FILE_ENV] : []),
        ]
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
                imageRef: llmStartup.imageRef,
                imageDigest: llmStartup.imageDigest,
                imageRunRef: llmStartup.imageRunRef,
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
        config: {
            binds: [
                { source: agentLibMountPath, target: '/Agent', ro: true },
                { source: codeMountPath, target: '/code', ro: codeReadOnly },
                ...(llmStartup.enabled ? [{ source: codeMountPath, target: '/workspace', ro: codeReadOnly }] : []),
                ...(useNestedDependencyMounts ? [
                    { source: preparedNodeModulesDir, target: '/code/node_modules', ro: true },
                    { source: preparedNodeModulesDir, target: '/Agent/node_modules', ro: true },
                ] : []),
                ...(runtime === 'podman' ? podmanStagedTargetMounts : []),
                { source: sharedDir, target: '/shared' },
                ...(!isolatedHome ? [{ source: agentHomeDir, target: '/root' }] : []),
                ...(llmStartup.enabled && llmStartup.modelDir ? [{ source: llmStartup.modelDir, target: '/models' }] : []),
                ...(llmStartup.enabled && llmStartup.stateDir ? [{ source: llmStartup.stateDir, target: '/runtime' }] : []),
                ...(skillsPathExists && !skillsPathInsideCode && runtime !== 'podman' ? [{ source: agentSkillsPath, target: '/code/skills', ro: skillsReadOnly }] : []),
                { source: cwd, target: cwdMountTarget }
            ],
            env: Array.from(new Set([...declaredEnvNames2, ...llmRuntimeEnvNames])).map((name) => ({ name })),
            ports: effectivePortMappings,
            ...(additionalServerPort ? { additionalServerPort } : {})
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

function ensureAgentService(agentName, manifest, agentPath, options = {}) {
    let preferredHostPort;
    let containerOverride;
    let aliasOverride;
    let forceRecreate = false;
    let profileNameOverride;
    let routerPortOverride;
    let routerHostOverride;
    if (typeof options === 'number') {
        preferredHostPort = options;
    } else if (options && typeof options === 'object') {
        preferredHostPort = options.preferredHostPort;
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
    const llmRuntimeEnabled = isLlmRuntimeManifest(manifest, profileConfig);
    const agentRuntime = llmRuntimeEnabled ? getRuntime() : getRuntimeForAgent(manifest);
    if (agentRuntime === 'bwrap') {
        try {
            return ensureBwrapService(agentName, manifest, agentPath, options);
        } catch (err) {
            throw createHostSandboxStartupError(agentName, 'bwrap', err);
        }
    }
    if (agentRuntime === 'seatbelt') {
        try {
            return ensureSeatbeltService(agentName, manifest, agentPath, options);
        } catch (err) {
            throw createHostSandboxStartupError(agentName, 'seatbelt', err);
        }
    }
    const runtime = agentRuntime;
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

    const effectiveManifestNetwork = resolveEffectiveManifestNetwork(manifest, profileConfig);
    if (llmRuntimeEnabled) {
        assertLlmRuntimeNetworkAllowed(agentName, effectiveManifestNetwork);
        assertNoRetiredLlmRuntimeEnv(agentName, manifest, profileConfig);
        assertNoPlainLlmSecretEnv(agentName, manifest, profileConfig);
        assertNoLlmReservedVolumeTargets(agentName, manifest);
        assertNoLlmReservedRuntimeResourceTargets(agentName, manifest);
    }
    const { publishArgs: manifestPorts, portMappings } = parseManifestPorts(manifest, profileConfig);
    const additionalServerPort = resolveProfileServer(manifest, profileConfig, { runtimeMode: 'container' });
    const containerPortCandidates = portMappings
        .map((mapping) => mapping?.containerPort)
        .filter((port) => typeof port === 'number' && port > 0);
    if (!containerPortCandidates.length) {
        if (llmRuntimeEnabled) {
            containerPortCandidates.push(LLM_RUNTIME_MCP_PORT, LLM_RUNTIME_INFERENCE_PORT);
        } else {
            containerPortCandidates.push(7000);
        }
    }

    const { raw: explicitAgentCmd } = readManifestAgentCommand(manifest);
    const startCmd = readManifestStartCommand(manifest);
    const manifestEntrypointOverride = hasManifestEntrypoint(manifest);
    const withParallelAgent = Boolean(startCmd && explicitAgentCmd);
    if (llmRuntimeEnabled) {
        assertLlmRuntimeEntrypointAllowed(agentName, {
            startCmd,
            explicitAgentCmd,
            manifestEntrypoint: manifestEntrypointOverride,
        });
    }

    if (forceRecreate && containerExists(containerName)) {
        removeContainerForRecreate(runtime, containerName, `ensureAgentService:${agentName}:forceRecreate`);
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
    if (containerExists(containerName) && llmRuntimeEnabled) {
        try {
            const desiredEnvHash = computeEnvHash(manifest, profileConfig, runtimeRouterEnv, { agentName, repoName });
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
                effectiveNetwork: effectiveManifestNetwork,
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
            debugLog(`[ensureAgentService] ${agentName}: LLM reuse-hash check failed: ${err?.message || err}; removing existing container.`);
            removeContainerForRecreate(runtime, containerName, `ensureAgentService:${agentName}:llmReuseHashUnavailable`);
            throw err;
        }
    }

    if (containerExists(containerName) && additionalServerPort) {
        const existingPortMappings = resolvePublishedPortMappings(containerName, existingRecord.config?.ports || []);
        const existingProfileServer = resolvePublishedProfileServer(additionalServerPort, existingPortMappings);
        if (!existingProfileServer) {
            debugLog(`[ensureAgentService] ${agentName}: additional server port is not published; recreating container`);
            removeContainerForRecreate(runtime, containerName, `ensureAgentService:${agentName}:profileServerPublishChanged`);
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
            const hostPort = resolveHostPort(containerName, existingRecord, containerPortCandidates);
            const existingPortMappings = resolvePublishedPortMappings(containerName, existingRecord.config?.ports || []);
            const resolvedProfileServer = resolvePublishedProfileServer(additionalServerPort, existingPortMappings) || additionalServerPort;
            syncAgentMcpConfig(containerName, agentPath, agentName);
            return { containerName, hostPort, additionalServerPort: resolvedProfileServer };
        }
    }

    let additionalPorts = [];
    let additionalPortMappings = [];
    let allPortMappings = [...portMappings];

    if (manifestPorts.length === 0) {
        const hostPort = preferredHostPort || (10000 + Math.floor(Math.random() * 50000));
        if (llmRuntimeEnabled) {
            const engineHostPort = 10000 + Math.floor(Math.random() * 50000);
            const mcpMapping = {
                containerPort: LLM_RUNTIME_MCP_PORT,
                hostPort,
                hostIp: '127.0.0.1',
                protocol: 'tcp',
            };
            const inferenceMapping = {
                containerPort: LLM_RUNTIME_INFERENCE_PORT,
                hostPort: engineHostPort,
                hostIp: '127.0.0.1',
                protocol: 'tcp',
            };
            additionalPorts = [
                `127.0.0.1:${hostPort}:${LLM_RUNTIME_MCP_PORT}`,
                `127.0.0.1:${engineHostPort}:${LLM_RUNTIME_INFERENCE_PORT}`,
            ];
            additionalPortMappings.push(mcpMapping, inferenceMapping);
            allPortMappings = [mcpMapping, inferenceMapping];
        } else {
            const agentServerMapping = { containerPort: 7000, hostPort, hostIp: '127.0.0.1', protocol: 'tcp' };
            additionalPorts = [`127.0.0.1:${hostPort}:7000`];
            additionalPortMappings.push(agentServerMapping);
            allPortMappings = [agentServerMapping];
        }
    }

    const profileServerPublish = createProfileServerPublish(additionalServerPort, allPortMappings);
    if (profileServerPublish) {
        additionalPorts.push(profileServerPublish.publishArg);
        additionalPortMappings.push(profileServerPublish.mapping);
        allPortMappings.push(profileServerPublish.mapping);
    }

    startAgentContainer(agentName, manifest, agentPath, {
        publish: additionalPorts,
        publishMappings: additionalPortMappings,
        containerName,
        alias: aliasOverride,
        profileName: activeProfile,
        routerPort: runtimeRouterEnv.PLOINKY_ROUTER_PORT,
        routerHost: runtimeRouterEnv.PLOINKY_ROUTER_HOST
    });
    allPortMappings = resolvePublishedPortMappings(containerName, allPortMappings);
    const resolvedProfileServer = resolvePublishedProfileServer(additionalServerPort, allPortMappings) || additionalServerPort;

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
        config: {
            binds: hasStartedBinds ? startedRecord.config.binds : [
                { source: AGENT_LIB_PATH, target: '/Agent', ro: true },
                { source: agentCodePath, target: '/code', ro: codeReadOnly },
                ...(fs.existsSync(agentSkillsPath) ? [{ source: agentSkillsPath, target: '/code/skills', ro: skillsReadOnly }] : []),
                { source: projPath, target: finalWorkTarget },
                ...(!finalIsolatedHome ? [{ source: finalAgentWorkDir, target: '/root' }] : [])
            ],
            env: Array.from(new Set([...declaredEnvNames3, ...startedEnvNames])).map((name) => ({ name })),
            ports: allPortMappings,
            ...(resolvedProfileServer ? { additionalServerPort: resolvedProfileServer } : {})
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
    const returnPort = allPortMappings.find((p) => p.containerPort === (llmRuntimeEnabled ? LLM_RUNTIME_MCP_PORT : 7000))?.hostPort
        || allPortMappings[0]?.hostPort
        || 0;
    return { containerName, hostPort: returnPort, additionalServerPort: resolvedProfileServer };
}

export {
    assertPodmanCodeMountAllowed,
    buildPodmanStagedTargetMounts,
    buildRuntimeRouterEnv,
    codeRelativeMountPath,
    ensureAgentService,
    ensureManifestVolumeHostPath,
    ensurePodmanStagedCodeDir,
    mergeNodeOptions,
    podmanMountSuffix,
    resolveHostPort,
    resolveHostPortFromRecord,
    resolveHostPortFromRuntime,
    resolvePublishedPortMappings,
    startAgentContainer
};
