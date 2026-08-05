import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { loadAgents, saveAgents } from './workspace.js';
import {
    resolveMasterKey,
    setUsersPayload,
    setUsersPayloadBatchTransactional,
} from './security/encryptedPasswordStore.js';
import { hashPassword } from './security/localAuthPasswords.js';
import {
    getAgentContainerName,
    parseManifestPorts,
    containerExists,
    isContainerRunning,
    waitForContainerRunning,
    stopAndRemove,
    stopAndRemoveMany,
    cleanupExactAgentRuntimeCandidate,
    ensureAgentService
} from '../sandbox/docker/index.js';
import { findAgent } from './utils.js';
import { getRuntimeForAgent, isSandboxRuntime } from '../sandbox/docker/common.js';
import { resolveLlmRuntimeAdmissionContext } from '../sandbox/docker/llmRuntimeIntegration.js';
import { isBwrapProcessRunning, stopBwrapProcess } from '../sandbox/bwrap/bwrapFleet.js';
import { REPOS_DIR, PLOINKY_WORKSPACE_ROOT } from './config.js';
import { resolveManifestRuntimeProfile } from './runtime/profileService.js';
import { resolveRouterEndpoint } from '../sandbox/routerPort.js';
import { resolveAgentExecutionMode, resolveAgentReadinessProtocol } from './runtime/startupReadiness.js';
import { normalizeProbeConfig, runContainerScriptReadiness } from '../sandbox/docker/healthProbes.js';
import {
    buildRelayReadinessRoute,
    waitForAgentReady,
} from '../server/utils/agentReadiness.js';
import { InMemoryPolicyStateStore } from '../server/policy/InMemoryPolicyStateStore.js';
import { McpToolPolicy } from '../server/policy/McpToolPolicy.js';
import { PolicyStateRepository } from '../server/policy/PolicyStateRepository.js';
import {
    mergeRuntimeRoute,
    readRoutingConfig,
    writeRoutingConfig,
} from '../server/routingFile.js';
import {
    initializeFreshEdgeRoutingSources,
    abortEdgeRoutingPreparation,
    commitAdditiveEdgeRoutingGeneration,
    inactivateEdgeRoutingGeneration,
    prepareAdditiveEdgeRoutingGeneration,
    prepareEdgeRoutingGeneration,
    prepareHostModeCapabilityForInactiveGeneration,
    withEdgeGenerationApplyLock,
} from '../sandbox/edgeGeneration.js';
import { applyEdgeRoutingGeneration } from '../sandbox/coordinatedEdgeApply.js';
import { resolveManifestStartup } from './runtime/manifestStartup.js';
import { withNetworkLifecycleLock } from '../sandbox/networkLifecycle.js';
import { withWorkspaceMutationLease } from './runtime/maintenanceLocks.js';
import {
    admitManifestRuntimeCapabilities,
    assertRuntimeAdmissionCurrent,
} from '../sandbox/runtimeCapabilities.js';
import {
    createAgentSymlinks,
    removeAgentSymlinks,
    createAgentWorkDir,
    removeAgentWorkDir,
    getAgentDataDir
} from './workspaceStructure.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const AGENT_LIB_PATH = path.resolve(__dirname, '../../Agent');
const RESERVED_AGENT_KEYS = new Set(['_config']);
const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const AUTH_MODES = new Set(['none', 'local', 'pwd', 'sso', 'guest']);
export const DEFAULT_ENABLE_AGENT_MODE = 'isolated';
export const ENABLE_AGENT_MODES = Object.freeze(['isolated', 'global', 'devel']);
const ENABLE_AGENT_MODE_SET = new Set(ENABLE_AGENT_MODES);

function wrapLifecycleError(message, cause) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    for (const field of ['code', 'status', 'context', 'cleanupReceipt']) {
        if (cause?.[field] !== undefined) error[field] = cause[field];
    }
    return error;
}

function attachAgentRecoveryCandidate(error, candidate) {
    if (!error || typeof error !== 'object' || !candidate) return error;
    const frozenCandidate = Object.isFrozen(candidate)
        ? candidate
        : Object.freeze({ ...candidate });
    const descriptor = Object.getOwnPropertyDescriptor(error, 'ploinkyRestartCandidate');
    if (!descriptor || descriptor.configurable === true) {
        Object.defineProperty(error, 'ploinkyRestartCandidate', {
            configurable: true,
            enumerable: false,
            writable: false,
            value: frozenCandidate,
        });
    }
    return error;
}

export function recoverFailedAgentEnableCandidate(failedCandidate, failedLease, originalFailure, {
    abortPreparation = abortEdgeRoutingPreparation,
    cleanupCandidate: cleanupCandidateImpl = cleanupExactAgentRuntimeCandidate,
    reason = 'agent-enable-start-failed',
    operation = 'enable-agent recovery',
} = {}) {
    if (originalFailure?.code === 'PLOINKY_RECOVERY_ABORT_FAILED') {
        throw originalFailure;
    }
    const attachedDescriptor = originalFailure && typeof originalFailure === 'object'
        ? Object.getOwnPropertyDescriptor(originalFailure, 'ploinkyRestartCandidate')
        : null;
    const attachedCandidate = attachedDescriptor
        && attachedDescriptor.writable === false
        && attachedDescriptor.value
        && typeof attachedDescriptor.value === 'object'
        && Object.isFrozen(attachedDescriptor.value)
        ? attachedDescriptor.value
        : null;
    if (attachedCandidate) failedCandidate = attachedCandidate;
    const preparationLease = failedCandidate?.preparationLease || failedLease || null;
    let cleanupCandidate = failedCandidate;
    if (preparationLease && failedCandidate?.preparationAbortedBeforeCleanup !== true) {
        try {
            abortPreparation(preparationLease, { reason });
        } catch (abortError) {
            const recoveryError = new Error(
                `${operation} could not abort the exact edge preparation; preserving its failed runtime state: ${abortError?.message || abortError}`,
                { cause: abortError },
            );
            recoveryError.code = 'PLOINKY_RECOVERY_ABORT_FAILED';
            Object.defineProperty(recoveryError, 'originalFailure', {
                configurable: false,
                enumerable: false,
                writable: false,
                value: originalFailure,
            });
            Object.defineProperty(recoveryError, 'ploinkyRecoveryPreparation', {
                configurable: false,
                enumerable: false,
                writable: false,
                value: Object.freeze({
                    preparationLease,
                    reason,
                    preparationAbortFailed: true,
                    preparationAbortedBeforeCleanup: false,
                }),
            });
            if (failedCandidate) {
                Object.defineProperty(recoveryError, 'ploinkyRestartCandidate', {
                    configurable: false,
                    enumerable: false,
                    writable: false,
                    value: Object.freeze({
                        ...failedCandidate,
                        exactCleanupPerformed: false,
                        preparationAbortFailed: true,
                        preparationAbortedBeforeCleanup: false,
                    }),
                });
            }
            throw recoveryError;
        }
        if (failedCandidate) {
            cleanupCandidate = Object.freeze({
                ...failedCandidate,
                preparationAbortFailed: false,
                preparationAbortedBeforeCleanup: true,
            });
        }
    } else if (failedCandidate && !Object.isFrozen(failedCandidate)) {
        cleanupCandidate = Object.freeze({ ...failedCandidate });
    }
    if (cleanupCandidate) attachAgentRecoveryCandidate(originalFailure, cleanupCandidate);
    if (cleanupCandidate?.containerName
        && cleanupCandidate?.cleanupReceipt
        && cleanupCandidate.exactCleanupPerformed !== true) {
        try {
            cleanupCandidateImpl(cleanupCandidate);
            cleanupCandidate = Object.freeze({
                ...cleanupCandidate,
                exactCleanupPerformed: true,
            });
            attachAgentRecoveryCandidate(originalFailure, cleanupCandidate);
        } catch (cleanupError) {
            originalFailure.message = `${originalFailure.message}; exact candidate cleanup failed: ${cleanupError?.message || cleanupError}`;
        }
    }
    return cleanupCandidate || true;
}

export function preferredHostPortForNetworkMode(existingRoute, networkMode) {
    if (String(networkMode || '').trim().toLowerCase() === 'none') return undefined;
    return Number(existingRoute?.hostPort || 0) || undefined;
}

export function isEnableAgentMode(value) {
    return ENABLE_AGENT_MODE_SET.has(String(value || '').trim().toLowerCase());
}

function formatEnableAgentModes() {
    return ENABLE_AGENT_MODES.join(' | ');
}

function normalizeAlias(aliasInput) {
    if (aliasInput === undefined || aliasInput === null) {
        return '';
    }
    if (typeof aliasInput === 'string' && !aliasInput.trim()) {
        return '';
    }
    const alias = String(aliasInput).trim();
    if (!alias) return '';
    if (!ALIAS_PATTERN.test(alias)) {
        throw new Error("Alias must start with a letter or number and may contain only letters, numbers, '.', '_' or '-'.");
    }
    if (RESERVED_AGENT_KEYS.has(alias)) {
        throw new Error(`Alias '${alias}' is reserved. Choose a different alias.`);
    }
    return alias;
}

function normalizeAuthMode(authMode) {
    const normalized = String(authMode || 'none').trim().toLowerCase();
    if (!AUTH_MODES.has(normalized)) {
        throw new Error(`Unknown auth mode '${authMode}'. Allowed: none | pwd | sso`);
    }
    return normalized === 'pwd' ? 'local' : normalized;
}

function buildDefaultLocalAuthVars(routeKey) {
    const suffix = String(routeKey || 'agent')
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase() || 'AGENT';
    return {
        usersVar: `PLOINKY_AUTH_${suffix}_USERS`
    };
}

export function verifyEnabledAgentStarted(shortAgentName, runtimeInstanceName, {
    runtime = 'container',
    isRunning = isContainerRunning,
    waitRunning = waitForContainerRunning,
    isSandboxRunning = isBwrapProcessRunning,
    log = console.log
} = {}) {
    if (!runtimeInstanceName) {
        throw new Error(`enable agent: failed to start '${shortAgentName}': no runtime instance was returned.`);
    }
    const sandboxRuntime = runtime === 'bwrap' || runtime === 'seatbelt';
    const running = sandboxRuntime
        ? isSandboxRunning(runtimeInstanceName)
        : isRunning(runtimeInstanceName) || waitRunning(runtimeInstanceName, 40, 250);
    if (!running) {
        const details = sandboxRuntime
            ? `${runtime} process '${shortAgentName}' exited during startup. Check sandbox logs for details.`
            : `container '${runtimeInstanceName}' exited during startup. Check container logs for details.`;
        throw new Error(`enable agent: failed to start '${shortAgentName}': ${details}`);
    }
    log(`Agent '${shortAgentName}' started successfully with ${runtime} runtime '${runtimeInstanceName}'.`);
}

async function waitForEnabledAgentReadiness(shortAgentName, manifest, started, {
    networkMode = '',
    generationDigest = '',
} = {}) {
    const protocol = resolveAgentReadinessProtocol(manifest);
    if (protocol === 'none') return;
    if (protocol === 'script') {
        const probe = normalizeProbeConfig('readiness', manifest?.health?.readiness);
        const result = await Promise.resolve(runContainerScriptReadiness(
            shortAgentName,
            started?.containerName,
            probe,
        ));
        if (result?.status !== 'success') {
            const detail = result?.detail ? `, output='${result.detail}'` : '';
            throw new Error(`readiness script failed (${result?.reason || 'unknown failure'}${detail})`);
        }
        return;
    }
    const readinessRoute = buildRelayReadinessRoute({
        route: {
            container: started?.containerName,
            hostPort: Number(started?.hostPort || 0),
        },
        manifest,
        runtimeResult: started,
        networkMode,
        generationDigest,
    });
    if (!readinessRoute.hostPort && !readinessRoute.relay) {
        throw new Error(`readiness protocol '${protocol}' requires one resolved private target or readiness.port`);
    }
    const ready = await waitForAgentReady(readinessRoute, {
        timeoutMs: Number.parseInt(process.env.PLOINKY_ENABLE_AGENT_READY_TIMEOUT_MS || '120000', 10),
        intervalMs: Number.parseInt(process.env.PLOINKY_ENABLE_AGENT_READY_INTERVAL_MS || '250', 10),
        probeTimeoutMs: Number.parseInt(process.env.PLOINKY_ENABLE_AGENT_READY_PROBE_TIMEOUT_MS || '1000', 10),
        protocol,
    });
    if (!ready) throw new Error(`readiness protocol '${protocol}' did not succeed`);
}

function parsePloinkyDirectives(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue.flatMap((item) => parsePloinkyDirectives(item)).filter(Boolean);
    }
    if (typeof rawValue !== 'string') {
        return [];
    }
    return rawValue
        .split(/[,\n;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

function normalizeManifestPwdUsers(manifest) {
    const users = Array.isArray(manifest?.pwd?.users) ? manifest.pwd.users : [];
    return users
        .map((entry) => {
            const username = String(entry?.username ?? entry?.user ?? '').trim();
            const password = String(entry?.password ?? '');
            const name = String(entry?.name ?? username).trim();
            const email = String(entry?.email ?? '').trim();
            const roles = Array.isArray(entry?.roles) ? entry.roles.map((role) => String(role || '').trim()).filter(Boolean) : [];
            if (!username || !password) {
                return null;
            }
            return {
                id: `local:${username}`,
                username,
                name: name || username,
                email: email || null,
                passwordHash: hashPassword(password),
                roles: roles.length ? Array.from(new Set(['local', ...roles])) : ['local'],
                rev: 1
            };
        })
        .filter(Boolean);
}

function resolveManifestAuthMode(manifest) {
    if (manifest?.guest === true) {
        return 'guest';
    }
    const ploinkyDirectives = parsePloinkyDirectives(manifest?.ploinky);
    if (ploinkyDirectives.includes('pwd enable')) {
        return 'local';
    }
    if (ploinkyDirectives.includes('sso enable')) {
        return 'sso';
    }
    return 'none';
}

export function normalizeEnableArgs(agentName, mode, repoNameParam) {
    if (typeof agentName !== 'string') {
        return { agentName, mode, repoNameParam };
    }
    const trimmed = agentName.trim();
    if (!trimmed) {
        return { agentName: trimmed, mode, repoNameParam };
    }
    if (mode) {
        return { agentName: trimmed, mode, repoNameParam };
    }

    let parsedAgent = trimmed;
    let parsedMode = mode;
    let parsedRepo = repoNameParam;

    const spaceTokens = trimmed.split(/\s+/).filter(Boolean);
    if (spaceTokens.length > 1) {
        const candidateMode = spaceTokens[1].toLowerCase();
        if (isEnableAgentMode(candidateMode)) {
            parsedAgent = spaceTokens[0];
            parsedMode = candidateMode;
            if (candidateMode === 'devel' && parsedRepo === undefined) {
                const remainder = spaceTokens.slice(2).join(' ').trim();
                if (remainder) parsedRepo = remainder;
            }
        }
    }

    if (parsedMode) {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const target = trimmed.slice(0, colonIndex).trim();
    const remainder = trimmed.slice(colonIndex + 1).trim();
    if (!target || !remainder) {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const tokens = remainder.split(/\s+/).filter(Boolean);
    if (!tokens.length) {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const inferredMode = tokens[0].toLowerCase();
    if (!isEnableAgentMode(inferredMode)) {
        return { agentName: parsedAgent, mode: parsedMode, repoNameParam: parsedRepo };
    }

    const repoFromDirective = tokens.slice(1).join(' ');
    return {
        agentName: target,
        mode: inferredMode,
        repoNameParam: inferredMode === 'devel'
            ? (repoNameParam !== undefined ? repoNameParam : repoFromDirective)
            : (repoNameParam !== undefined ? repoNameParam : undefined)
    };
}

function loadRoutingConfig() {
    return readRoutingConfig();
}

function resolveAgentEnableInput({
    agentName,
    mode,
    repoNameParam,
    authOptions = {},
}) {
    const normalized = normalizeEnableArgs(agentName, mode, repoNameParam);
    const { manifestPath, repo: repoName, shortAgentName } = findAgent(normalized.agentName);
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    resolveManifestStartup(manifest);
    const agentPath = path.dirname(manifestPath);
    const profile = typeof authOptions?.profile === 'string' && authOptions.profile.trim()
        ? authOptions.profile.trim().toLowerCase()
        : '';
    const profileResolution = resolveManifestRuntimeProfile(manifest, {
        agentName: `${repoName}/${shortAgentName}`,
        profileName: profile || undefined,
        path: `manifest(${repoName}/${shortAgentName})`,
    });
    const admissionOptions = {
        manifestBytes,
        manifestPath,
        agentId: `${repoName}/${shortAgentName}`,
        profileName: profileResolution.resolvedProfileName,
        profileConfig: profileResolution.profileConfig,
        network: profileResolution.network,
    };
    const selectedRuntime = getRuntimeForAgent(manifest);
    const runtimeKind = isSandboxRuntime(selectedRuntime) ? selectedRuntime : 'container';
    const llmAdmissionContext = runtimeKind === 'container'
        ? resolveLlmRuntimeAdmissionContext({
            runtime: selectedRuntime,
            manifest,
            profileConfig: profileResolution.profileConfig,
            agentName: shortAgentName,
            env: process.env,
        })
        : { catalogPolicy: null, catalogIdentity: null };
    const runtimeAdmission = admitManifestRuntimeCapabilities(manifest, {
        ...admissionOptions,
        runtime: selectedRuntime,
        runtimeKind,
        catalogPolicy: llmAdmissionContext.catalogPolicy,
        catalogIdentity: llmAdmissionContext.catalogIdentity,
    });
    const routerEndpoint = resolveRouterEndpoint(profileResolution.network.mode);
    return {
        agentPath,
        manifest,
        manifestBytes,
        manifestPath,
        normalized,
        profile,
        profileResolution,
        repoName,
        routerEndpoint,
        runtimeAdmission,
        shortAgentName,
    };
}

function planAgentEnable({
    agentName,
    mode,
    repoNameParam,
    aliasParam,
    authModeParam,
    authOptions = {},
}, map, routing, resolvedInput = undefined) {
    const {
        agentPath,
        manifest,
        manifestBytes,
        manifestPath,
        normalized,
        profile,
        profileResolution,
        repoName,
        routerEndpoint,
        runtimeAdmission,
        shortAgentName,
    } = resolvedInput || resolveAgentEnableInput({ agentName, mode, repoNameParam, authOptions });
    const alias = normalizeAlias(aliasParam);
    if (alias) {
        const aliasExists = Object.entries(map || {}).some(([key, value]) => {
            if (key === alias) return true;
            return value && value.type === 'agent' && value.alias === alias;
        });
        if (aliasExists) {
            throw new Error('alias already exists');
        }
    }
    const containerBaseName = alias || shortAgentName;
    const containerName = getAgentContainerName(containerBaseName, repoName);
    const routeKey = alias || shortAgentName;
    const instanceName = alias || shortAgentName;
    const authMode = authModeParam === undefined || authModeParam === null || String(authModeParam).trim() === ''
        ? resolveManifestAuthMode(manifest)
        : normalizeAuthMode(authModeParam);
    const manifestPwdUsers = normalizeManifestPwdUsers(manifest);
    const username = typeof authOptions?.username === 'string' && authOptions.username.trim()
        ? authOptions.username.trim()
        : '';
    const password = typeof authOptions?.password === 'string' && authOptions.password.length
        ? authOptions.password
        : '';
    if ((username || password) && authMode !== 'local') {
        throw new Error('The --user and --password options are only valid with --auth pwd.');
    }
    if ((username && !password) || (!username && password)) {
        throw new Error('Use --user and --password together.');
    }

    const normalizedMode = (normalized.mode || '').toLowerCase();
    let runMode = DEFAULT_ENABLE_AGENT_MODE;
    let projectPath = '';

    if (!normalizedMode || normalizedMode === 'default' || normalizedMode === DEFAULT_ENABLE_AGENT_MODE) {
        runMode = DEFAULT_ENABLE_AGENT_MODE;
        projectPath = getAgentDataDir(instanceName);
    } else if (normalizedMode === 'global') {
        runMode = 'global';
        projectPath = PLOINKY_WORKSPACE_ROOT;
    } else if (normalizedMode === 'devel') {
        const repoCandidate = String(normalized.repoNameParam || '').trim();
        if (!repoCandidate) {
            throw new Error("enable agent devel: missing repoName. Usage: enable agent <name> devel <repoName>");
        }
        const repoPath = path.join(REPOS_DIR, repoCandidate);
        if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
            throw new Error(`Repository '${repoCandidate}' not found in ${path.join(REPOS_DIR)}`);
        }
        runMode = 'devel';
        projectPath = repoPath;
    } else {
        const errorMode = normalized.mode || mode || '';
        throw new Error(`Unknown mode '${errorMode}'. Allowed: ${formatEnableAgentModes()}`);
    }

    const configuredStaticAgent = String(map?._config?.static?.agent || '').trim();
    const isConfiguredStaticAgent = configuredStaticAgent === shortAgentName
        || configuredStaticAgent === `${repoName}/${shortAgentName}`
        || Boolean(alias && configuredStaticAgent === alias);
    if (isConfiguredStaticAgent) {
        projectPath = PLOINKY_WORKSPACE_ROOT;
    }

    // Capture only ports the selected execution/network contract can own. The
    // runtime will later replace dynamic host-port zeros in one coordinated
    // final generation after every prepared process has launched.
    const { portMappings } = parseManifestPorts(manifest);
    const networkMode = profileResolution.network.mode;
    const ports = networkMode === 'host' || networkMode === 'none'
        ? []
        : (portMappings.length > 0
            ? portMappings
            : (resolveAgentExecutionMode(manifest).usesImplicitAgentServer ? [{ containerPort: 7000 }] : []));
    const projectMountTarget = runMode === DEFAULT_ENABLE_AGENT_MODE ? '/root' : projectPath;
    const homePath = getAgentDataDir(instanceName);
    const instanceId = randomUUID();
    const enableGeneration = randomUUID();
    let credentialUpdate = null;
    
    const record = {
        agentName: shortAgentName,
        repoName,
        containerImage: manifest.container || manifest.image || 'node:18-alpine',
        createdAt: new Date().toISOString(),
        projectPath,
        runMode,
        develRepo: runMode === 'devel' ? String(normalized.repoNameParam || '') : undefined,
        type: 'agent',
        instanceId,
        enableGeneration,
        config: {
            binds: [
                { source: projectPath, target: projectMountTarget },
                ...(runMode === DEFAULT_ENABLE_AGENT_MODE ? [] : [{ source: homePath, target: '/root' }]),
                { source: AGENT_LIB_PATH, target: '/Agent' },
                { source: agentPath, target: '/code' }
            ],
            env: [],
            ports
        }
    };
    if (authMode === 'local') {
        resolveMasterKey();
        record.auth = {
            mode: authMode,
            ...buildDefaultLocalAuthVars(routeKey)
        };
        if (username && password) {
            credentialUpdate = {
                usersVar: record.auth.usersVar,
                payload: {
                version: 1,
                users: [{
                    id: `local:${username}`,
                    username,
                    name: username,
                    email: null,
                    passwordHash: hashPassword(password),
                    roles: ['local', 'admin'],
                    rev: 1
                }]
                }
            };
        } else if (manifestPwdUsers.length) {
            credentialUpdate = {
                usersVar: record.auth.usersVar,
                payload: {
                    version: 1,
                    users: manifestPwdUsers
                }
            };
        }
    } else {
        record.auth = { mode: authMode };
    }
    if (alias) {
        record.alias = alias;
    }
    // Persist the exact resolved launch profile in the inactive candidate.
    // Runtime finalization must not introduce a default-profile value that was
    // absent from the preparation digest.
    record.profile = profileResolution.resolvedProfileName;

    routing.routes = routing.routes || {};
    const existingRoute = routing.routes[routeKey] || {};
    const preferredHostPort = preferredHostPortForNetworkMode(
        existingRoute,
        profileResolution.network.mode,
    );

    for (const key of Object.keys(map)) {
        if (RESERVED_AGENT_KEYS.has(key)) continue;
        if (!map[key] || typeof map[key] !== 'object') continue;
        if (alias && key === containerName) continue;
        const r = map[key];
        if (!r || r.type !== 'agent') continue;
        const sameAgent = r.agentName === shortAgentName && r.repoName === repoName;
        if (!sameAgent) continue;
        if (alias || r.alias) continue;
        if (key === containerName) continue;
        try { delete map[key]; } catch (_) {}
    }
    map[containerName] = record;
    routing.routes[routeKey] = mergeRuntimeRoute(existingRoute, {
        container: containerName,
        hostPath: agentPath,
        repo: repoName,
        agent: shortAgentName,
        ...(alias ? { alias } : {}),
    }, { hostPort: null });

    return {
        agentPath,
        alias,
        containerName,
        credentialUpdate,
        enableGeneration,
        existingRoute,
        instanceId,
        instanceName,
        manifest,
        manifestBytes,
        manifestPath,
        preferredHostPort,
        profileResolution,
        record,
        repoName,
        routeKey,
        routerEndpoint,
        runtimeAdmission,
        runMode,
        shortAgentName,
    };
}

function createPreparedWorkspaceStructure(plan) {
    try {
        createAgentWorkDir(plan.instanceName);
        createAgentSymlinks(plan.shortAgentName, plan.repoName, plan.agentPath);
    } catch (error) {
        console.error(`Warning: Failed to create workspace structure for ${plan.shortAgentName}: ${error.message}`);
    }
}

function bootstrapPreparedMcpToolPolicy(routes) {
    const policyFile = path.join(
        PLOINKY_WORKSPACE_ROOT,
        '.ploinky',
        'data',
        'router-security',
        'policy-state.json',
    );
    const document = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    const store = new InMemoryPolicyStateStore({ document });
    const repository = new PolicyStateRepository({ store });
    new McpToolPolicy({ repository }).bootstrap(routes);
    return store.read().document;
}

/**
 * Stage exact identities and target-less routes for a set of agents, then
 * compile one immutable generation before any of their processes start.
 * Requests are ordinary enable-agent argument objects; no request can grant a
 * capability. The already-staged desired state remains the sole authority.
 */
export function prepareAgentEnableBatch(requests, {
    reason = 'agent-enable-batch-prelaunch',
    availabilityMode = 'additive',
} = {}) {
    if (!Array.isArray(requests)) {
        throw new Error('prepare agent enable batch: requests must be an array');
    }

    const resolvedRequests = requests.map((request) => {
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            throw new Error('prepare agent enable batch: each enable batch request must be an object');
        }
        return { request, input: resolveAgentEnableInput(request) };
    });

    for (const { input } of resolvedRequests) {
        const currentBytes = fs.readFileSync(input.manifestPath);
        assertRuntimeAdmissionCurrent(input.runtimeAdmission, {
            manifestBytes: currentBytes,
            profileName: input.profileResolution.resolvedProfileName,
        });
    }
    const initialized = initializeFreshEdgeRoutingSources({ workspaceRoot: PLOINKY_WORKSPACE_ROOT });
    const generationFiles = (() => {
        try { return fs.readdirSync(initialized.paths.generationsDir); } catch (error) {
            if (error?.code === 'ENOENT') return [];
            throw error;
        }
    })();
    const needsEmptyBaseline = !fs.existsSync(initialized.paths.activeSelectorFile)
        && !fs.existsSync(initialized.paths.topologyCurrentFile)
        && generationFiles.length === 0;
    if (needsEmptyBaseline) {
        applyEdgeRoutingGeneration({ reason: 'fresh-edge-empty-baseline' });
    }
    const map = loadAgents();
    const routing = loadRoutingConfig();
    routing.routes = routing.routes || {};
    const previousAgents = structuredClone(map);
    const previousRouting = structuredClone(routing);
    const plans = [];
    let preparedGeneration = null;

    try {
        for (const { request, input } of resolvedRequests) {
            plans.push(planAgentEnable(request, map, routing, input));
        }
        const effectiveAvailabilityMode = availabilityMode === 'additive'
            && plans.some((plan) => previousAgents?.[plan.containerName]?.type === 'agent')
            ? 'replacement'
            : availabilityMode;
        withEdgeGenerationApplyLock((applyLockCapability) => {
            for (const { input } of resolvedRequests) {
                const currentBytes = fs.readFileSync(input.manifestPath);
                assertRuntimeAdmissionCurrent(input.runtimeAdmission, {
                    manifestBytes: currentBytes,
                    profileName: input.profileResolution.resolvedProfileName,
                });
            }
            const policy = bootstrapPreparedMcpToolPolicy(routing.routes);
            const manifestBytes = Object.fromEntries(
                plans.map((plan) => [plan.routeKey, plan.manifestBytes]),
            );
            if (effectiveAvailabilityMode === 'replacement') {
                inactivateEdgeRoutingGeneration(`${reason}:source-stage`, { applyLockCapability });
                for (const plan of plans) {
                    if (!plan.credentialUpdate) continue;
                    setUsersPayload(plan.credentialUpdate.usersVar, plan.credentialUpdate.payload);
                }
                saveAgents(map, { coordinate: false, applyLockCapability });
                writeRoutingConfig(routing, { coordinate: false });
                const policyFile = path.join(
                    PLOINKY_WORKSPACE_ROOT,
                    '.ploinky',
                    'data',
                    'router-security',
                    'policy-state.json',
                );
                fs.writeFileSync(policyFile, JSON.stringify(policy, null, 2));
                preparedGeneration = prepareEdgeRoutingGeneration({ reason, applyLockCapability });
            } else if (effectiveAvailabilityMode === 'additive') {
                preparedGeneration = prepareAdditiveEdgeRoutingGeneration({
                    reason,
                    routing,
                    agents: map,
                    policy,
                    manifestBytes,
                    applyLockCapability,
                });
            } else {
                throw new Error(`unsupported agent enable availability mode '${effectiveAvailabilityMode}'`);
            }
            for (const plan of plans) {
                if (plan.profileResolution.network.mode !== 'host') continue;
                plan.preparedHostModeCapability = prepareHostModeCapabilityForInactiveGeneration({
                    agentId: `agent:${plan.repoName}/${plan.shortAgentName}`,
                    instanceId: plan.instanceId,
                    enableGeneration: plan.enableGeneration,
                    routeKey: plan.routeKey,
                    containerName: plan.containerName,
                }, {
                    preparationLease: preparedGeneration.preparationLease,
                });
            }
        });
    } catch (error) {
        recoverFailedAgentEnableCandidate(
            null,
            preparedGeneration?.preparationLease,
            error,
            {
                reason: 'agent-enable-batch-prepare-failed',
                operation: 'prepare-agent-enable-batch recovery',
            },
        );
        throw wrapLifecycleError(
            `prepare agent enable batch: candidate generation rejected: ${error?.message || error}`,
            error,
        );
    }

    for (const plan of plans) createPreparedWorkspaceStructure(plan);
    return {
        plans,
        previousAgents,
        previousRouting,
        preparedGeneration,
        availabilityMode: preparedGeneration?.preparationLease?.mode || availabilityMode,
    };
}

export async function enableAgent(agentName, mode, repoNameParam, aliasParam, authModeParam, authOptions = {}) {
    return withWorkspaceMutationLease({ operation: 'agent-enable' }, async () => {
    let prepared;
    try {
        prepared = prepareAgentEnableBatch([{
            agentName,
            mode,
            repoNameParam,
            aliasParam,
            authModeParam,
            authOptions,
        }], { reason: 'agent-enable-prelaunch' });
    } catch (error) {
        throw wrapLifecycleError(
            `enable agent: candidate generation rejected: ${error?.message || error}`,
            error,
        );
    }
    const [plan] = prepared.plans;
    const {
        agentPath,
        alias,
        containerName,
        enableGeneration,
        instanceId,
        manifest,
        preferredHostPort,
        profileResolution,
        record,
        repoName,
        routeKey,
        routerEndpoint,
        runtimeAdmission,
        runMode,
        shortAgentName,
    } = plan;

    let started = null;
    try {
        return await withNetworkLifecycleLock(async (networkLifecycleCapability) => {
            console.log(`Starting agent '${shortAgentName}' from repo '${repoName}'...`);
            started = ensureAgentService(shortAgentName, manifest, agentPath, {
                containerName,
                alias: alias || undefined,
                preferredHostPort,
                profileName: profileResolution.resolvedProfileName,
                profileResolution,
                routerEndpoint,
                instanceId,
                enableGeneration,
                forceRecreate: true,
                preservePreparedRegistryRecord: true,
                preparedRegistryRecord: record,
                preparationLease: prepared.preparedGeneration?.preparationLease,
                preparedHostModeCapability: plan.preparedHostModeCapability,
                networkLifecycleCapability,
                runtimeAdmission,
            });
            verifyEnabledAgentStarted(shortAgentName, started?.containerName || containerName, {
                runtime: started?.runtime || started?.registryRecord?.runtime || 'container',
            });
            await waitForEnabledAgentReadiness(shortAgentName, manifest, started, {
                networkMode: profileResolution.network.mode,
                generationDigest: prepared.preparedGeneration?.preparationLease?.preparedGeneration || '',
            });

            const hostPort = profileResolution.network.mode === 'none'
                ? undefined
                : started?.hostPort || preferredHostPort;
            if (!started?.registryRecord) {
                throw new Error(`runtime '${containerName}' returned no exact registry record`);
            }
            const finalAgents = structuredClone(prepared.preparedGeneration.generation.agents);
            finalAgents[started.containerName || containerName] = started.registryRecord;
            const finalRouting = structuredClone(prepared.preparedGeneration.generation.routing);
            finalRouting.routes = finalRouting.routes || {};
            finalRouting.routes[routeKey] = mergeRuntimeRoute(finalRouting.routes[routeKey], {
                container: started?.containerName || containerName,
                hostPath: agentPath,
                repo: repoName,
                agent: shortAgentName,
                ...(alias ? { alias } : {}),
            }, { hostPort });
            const finalLease = started?.preparationLease
                || prepared.preparedGeneration?.preparationLease;
            withEdgeGenerationApplyLock((applyLockCapability) => {
                const commitCredentials = () => {
                    return setUsersPayloadBatchTransactional(
                        prepared.plans
                            .filter((candidate) => candidate.credentialUpdate)
                            .map((candidate) => candidate.credentialUpdate),
                    );
                };
                if (finalLease?.mode === 'additive') {
                    commitAdditiveEdgeRoutingGeneration(finalLease, {
                        routing: finalRouting,
                        agents: finalAgents,
                        applyLockCapability,
                        beforeSelectorCommit: commitCredentials,
                    });
                    return;
                }
                // Same-name re-enable cannot shadow its predecessor. Its earlier
                // replacement preparation already made routing inactive; publish
                // the ready locator and credentials, then activate only the exact
                // replacement lease. No stale predecessor selector is restored.
                commitCredentials();
                saveAgents(finalAgents, { coordinate: false, applyLockCapability });
                writeRoutingConfig(finalRouting, { coordinate: false });
                applyEdgeRoutingGeneration({
                    reason: 'agent-enable-replacement-ready',
                    preparationLease: finalLease,
                    applyLockCapability,
                    networkLifecycleCapability,
                });
            }, { preparationLease: finalLease });

            return { containerName: started?.containerName || containerName, repoName, shortAgentName, alias: alias || undefined, auth: record.auth, runMode, hostPort };
        });
    } catch (error) {
        const failedCandidate = started || error?.ploinkyRestartCandidate || null;
        const failedLease = started?.preparationLease
            || prepared?.preparedGeneration?.preparationLease;
        recoverFailedAgentEnableCandidate(failedCandidate, failedLease, error);
        throw wrapLifecycleError(
            `enable agent: failed to start '${shortAgentName}': ${error?.message || error}`,
            error,
        );
    }
    });
}

function routeKeyForEnabledRecord(record) {
    return String(record?.alias || record?.agentName || '').trim();
}

function removeDisabledRoutes(routing, disabledRecords) {
    const next = routing && typeof routing === 'object' ? routing : { routes: {} };
    next.routes = next.routes && typeof next.routes === 'object' ? next.routes : {};
    for (const { containerName, record } of disabledRecords) {
        const routeKey = routeKeyForEnabledRecord(record);
        const route = next.routes[routeKey];
        const exactOwner = route
            && String(route.repo || '') === String(record?.repoName || '')
            && String(route.agent || '') === String(record?.agentName || '')
            && String(route.alias || '') === String(record?.alias || '');
        if (route && (String(route.container || '') === containerName || exactOwner)) {
            delete next.routes[routeKey];
        }
        if (String(next.static?.container || '') === containerName) {
            delete next.static;
        }
    }
    return next;
}

function stageAgentDisableGeneration(map, disabledRecords, {
    reason,
    inactivateGeneration = inactivateEdgeRoutingGeneration,
    saveAgentsImpl = saveAgents,
    readRoutingImpl = loadRoutingConfig,
    writeRoutingImpl = (routing) => writeRoutingConfig(routing, { coordinate: false }),
    prepareGeneration = prepareEdgeRoutingGeneration,
    abortPreparation = abortEdgeRoutingPreparation,
    withApplyLock = withEdgeGenerationApplyLock,
} = {}) {
    return withApplyLock((applyLockCapability) => {
        inactivateGeneration(reason, { applyLockCapability });
        const routing = removeDisabledRoutes(readRoutingImpl(), disabledRecords);
        saveAgentsImpl(map, { coordinate: false, applyLockCapability });
        writeRoutingImpl(routing, { coordinate: false, applyLockCapability });
        const prepared = prepareGeneration({ reason, applyLockCapability });
        if (prepared?.selector?.state !== 'inactive') {
            const invalidPreparation = new Error(
                'disable agent: prepared route-removal generation did not remain inactive',
            );
            recoverFailedAgentEnableCandidate(
                null,
                prepared?.preparationLease,
                invalidPreparation,
                {
                    abortPreparation,
                    reason: `${reason}-invalid`,
                    operation: 'disable-agent generation-preparation recovery',
                },
            );
            throw invalidPreparation;
        }
        return prepared;
    });
}

function commitAgentDisableGeneration(prepared, {
    reason,
    applyGeneration = applyEdgeRoutingGeneration,
    inactivateGeneration = inactivateEdgeRoutingGeneration,
    abortPreparation = abortEdgeRoutingPreparation,
} = {}) {
    try {
        return applyGeneration({
            reason,
            preparationLease: prepared?.preparationLease,
        });
    } catch (error) {
        try {
            inactivateGeneration(`${reason}-failed`, {
                preserveSelectedGeneration: true,
            });
        } catch (_) {}
        recoverFailedAgentEnableCandidate(null, prepared?.preparationLease, error, {
            abortPreparation,
            reason: `${reason}-failed`,
            operation: 'disable-agent generation-commit recovery',
        });
        throw error;
    }
}

function removeDisabledRuntimes(disabledRecords, {
    stopAndRemoveImpl = stopAndRemove,
    stopAndRemoveManyImpl = stopAndRemoveMany,
    isSandboxRuntimeImpl = isSandboxRuntime,
    stopSandboxImpl = stopBwrapProcess,
    sandboxRunningImpl = isBwrapProcessRunning,
    containerExistsImpl = containerExists,
} = {}) {
    const containerTargets = [];
    for (const { containerName, record } of disabledRecords) {
        if (isSandboxRuntimeImpl(record?.runtime)) {
            stopSandboxImpl(containerName);
            if (sandboxRunningImpl(containerName)) {
                throw new Error(`sandbox runtime '${containerName}' is still running`);
            }
        } else {
            containerTargets.push(containerName);
        }
    }
    if (containerTargets.length === 1) {
        stopAndRemoveImpl(containerTargets[0]);
    } else if (containerTargets.length > 1) {
        stopAndRemoveManyImpl(containerTargets);
    }
    const retained = containerTargets.filter((containerName) => containerExistsImpl(containerName));
    if (retained.length) {
        throw new Error(`runtime removal left existing container(s): ${retained.join(', ')}`);
    }
}

export function disableAgent(agentRef, dependencies = {}) {
    const input = typeof agentRef === 'string' ? agentRef.trim() : '';
    if (!input) {
        throw new Error("disable agent: missing agent name. Usage: disable <agentName>");
    }

    const hasNamespace = /[:/]/.test(input);
    let targetRepo = null;
    let targetAgent = input;

    if (hasNamespace) {
        const parts = input.split(/[:/]/).filter(Boolean);
        if (parts.length !== 2) {
            throw new Error(`disable agent: invalid identifier '${input}'. Use <repo>/<agent>.`);
        }
        [targetRepo, targetAgent] = parts;
    }

    const loadAgentsImpl = dependencies.loadAgentsImpl || loadAgents;
    const applyGeneration = dependencies.applyGeneration || applyEdgeRoutingGeneration;
    const inactivateGeneration = dependencies.inactivateGeneration || inactivateEdgeRoutingGeneration;
    const abortPreparation = dependencies.abortPreparation || abortEdgeRoutingPreparation;
    const map = loadAgentsImpl();
    const config = (map && typeof map._config === 'object') ? map._config : null;
    const directRecord = (map && map[input] && map[input].type === 'agent') ? map[input] : null;

    const clearStaticConfig = ({ repoName, shortName, containerName, rawInput }) => {
        if (!config || !config.static) return false;
        const comparisons = new Set();
        if (shortName) comparisons.add(String(shortName).trim().toLowerCase());
        if (repoName && shortName) {
            const repo = String(repoName).trim().toLowerCase();
            const short = String(shortName).trim().toLowerCase();
            comparisons.add(`${repo}/${short}`);
            comparisons.add(`${repo}:${short}`);
        }
        if (rawInput) comparisons.add(String(rawInput).trim().toLowerCase());

        const staticAgent = String(config.static.agent || '').trim().toLowerCase();
        const staticContainer = String(config.static.container || '').trim();

        const matchesAgent = staticAgent && (comparisons.has(staticAgent));
        const matchesContainer = containerName && staticContainer && staticContainer === containerName;

        if (!matchesAgent && !matchesContainer) return false;

        delete config.static;
        if (Object.keys(config).length === 0) {
            delete map._config;
        } else {
            map._config = config;
        }
        return true;
    };

    const entries = Object.entries(map || {})
        .filter(([key, value]) => key !== '_config' && value && typeof value === 'object')
        .filter(([, value]) => value.type === 'agent');

    const aliasEntry = (!directRecord)
        ? entries.find(([, value]) => {
            if (!value || !value.alias) return false;
            if (value.alias === input) return true;
            if (hasNamespace) {
                return value.alias === targetAgent;
            }
            return false;
        })
        : null;

    let matches;
    if (directRecord) {
        matches = [[input, directRecord]];
    } else if (aliasEntry) {
        matches = [[aliasEntry[0], aliasEntry[1]]];
    } else {
        matches = entries.filter(([, value]) => {
            const repoName = String(value.repoName || '').trim();
            const agentName = String(value.agentName || '').trim();
            if (!agentName) return false;
            if (hasNamespace) {
                return agentName === targetAgent && repoName === targetRepo;
            }
            return agentName === targetAgent;
        });
    }

    if (!matches.length) {
        const staticContainer = String(config?.static?.container || '').trim();
        const staticCleared = clearStaticConfig({ repoName: targetRepo, shortName: targetAgent, rawInput: input, containerName: null });
        if (staticCleared) {
            const disabledStaticRecords = staticContainer ? [{
                containerName: staticContainer,
                record: {
                    agentName: targetAgent,
                    repoName: targetRepo || '',
                },
            }] : [];
            const prepared = stageAgentDisableGeneration(map, disabledStaticRecords, {
                ...dependencies,
                inactivateGeneration,
                abortPreparation,
                reason: 'agent-disable-static-prepare',
            });
            try {
                removeDisabledRuntimes(disabledStaticRecords, dependencies);
            } catch (error) {
                try {
                    inactivateGeneration('agent-disable-static-runtime-removal-failed', {
                        preserveSelectedGeneration: true,
                    });
                } catch (_) {}
                const removalFailure = new Error(
                    `disable agent: failed to stop and remove static runtime '${staticContainer}': ${error?.message || error}`,
                    { cause: error },
                );
                recoverFailedAgentEnableCandidate(null, prepared.preparationLease, removalFailure, {
                    abortPreparation,
                    reason: 'agent-disable-static-runtime-removal-failed',
                    operation: 'disable-agent static-runtime recovery',
                });
                throw removalFailure;
            }
            commitAgentDisableGeneration(prepared, {
                reason: 'agent-disable-static-commit',
                applyGeneration,
                inactivateGeneration,
                abortPreparation,
            });
            return {
                status: 'static-removed',
                requested: input
            };
        }
        return {
            status: 'not-found',
            requested: input
        };
    }

    if (!hasNamespace && !directRecord && matches.length > 1) {
        return {
            status: 'ambiguous',
            requested: input,
            matches: matches.map(([, value]) => `${value.repoName}/${value.agentName}`)
        };
    }

    const [containerName, record] = matches[0];

    delete map[containerName];

    clearStaticConfig({
        repoName: record.repoName,
        shortName: record.agentName,
        containerName,
        rawInput: input
    });

    const disabledRecords = [{ containerName, record }];
    const prepared = stageAgentDisableGeneration(map, disabledRecords, {
        ...dependencies,
        inactivateGeneration,
        abortPreparation,
        reason: 'agent-disable-prepare',
    });
    try {
        removeDisabledRuntimes(disabledRecords, dependencies);
    } catch (error) {
        try {
            inactivateGeneration('agent-disable-runtime-removal-failed', {
                preserveSelectedGeneration: true,
            });
        } catch (_) {}
        const removalFailure = new Error(
            `disable agent: failed to stop and remove container '${containerName}': ${error?.message || error}`,
            { cause: error },
        );
        recoverFailedAgentEnableCandidate(null, prepared.preparationLease, removalFailure, {
            abortPreparation,
            reason: 'agent-disable-runtime-removal-failed',
            operation: 'disable-agent runtime recovery',
        });
        throw removalFailure;
    }
    commitAgentDisableGeneration(prepared, {
        reason: 'agent-disable-commit',
        applyGeneration,
        inactivateGeneration,
        abortPreparation,
    });

    // Remove workspace structure for the agent
    try {
        // Remove symlinks: $CWD/code/<agentName> and $CWD/skills/<agentName>
        removeAgentSymlinks(record.agentName);

        // Note: We don't remove the agent work directory by default to preserve data
        // Use removeAgentWorkDir(record.agentName, true) to force removal if needed
    } catch (err) {
        console.error(`Warning: Failed to remove workspace structure for ${record.agentName}: ${err.message}`);
    }

    return {
        status: 'removed',
        containerName,
        shortAgentName: record.agentName,
        repoName: record.repoName
    };
}

export function disableAgentContainers(containerNames = [], dependencies = {}) {
    const targets = Array.from(new Set((containerNames || [])
        .map(name => String(name || '').trim())
        .filter(Boolean)));
    if (!targets.length) return [];

    const loadAgentsImpl = dependencies.loadAgentsImpl || loadAgents;
    const applyGeneration = dependencies.applyGeneration || applyEdgeRoutingGeneration;
    const inactivateGeneration = dependencies.inactivateGeneration || inactivateEdgeRoutingGeneration;
    const abortPreparation = dependencies.abortPreparation || abortEdgeRoutingPreparation;
    const map = loadAgentsImpl();
    const config = (map && typeof map._config === 'object') ? map._config : null;
    const disabled = [];
    const disabledRuntimeRecords = [];

    const clearStaticConfig = ({ repoName, shortName, containerName }) => {
        if (!config || !config.static) return false;
        const comparisons = new Set();
        if (shortName) comparisons.add(String(shortName).trim().toLowerCase());
        if (repoName && shortName) {
            const repo = String(repoName).trim().toLowerCase();
            const short = String(shortName).trim().toLowerCase();
            comparisons.add(`${repo}/${short}`);
            comparisons.add(`${repo}:${short}`);
        }

        const staticAgent = String(config.static.agent || '').trim().toLowerCase();
        const staticContainer = String(config.static.container || '').trim();
        const matchesAgent = staticAgent && comparisons.has(staticAgent);
        const matchesContainer = containerName && staticContainer && staticContainer === containerName;

        if (!matchesAgent && !matchesContainer) return false;

        delete config.static;
        if (Object.keys(config).length === 0) {
            delete map._config;
        } else {
            map._config = config;
        }
        return true;
    };

    for (const containerName of targets) {
        const record = map?.[containerName];
        if (!record || record.type !== 'agent') {
            disabled.push({
                status: 'not-found',
                containerName
            });
            continue;
        }

        delete map[containerName];
        clearStaticConfig({
            repoName: record.repoName,
            shortName: record.agentName,
            containerName
        });

        disabled.push({
            status: 'removed',
            containerName,
            shortAgentName: record.agentName,
            repoName: record.repoName
        });
        disabledRuntimeRecords.push({ containerName, record });
    }

    if (!disabledRuntimeRecords.length) return disabled;
    const disabledRecords = disabledRuntimeRecords;
    const prepared = stageAgentDisableGeneration(map, disabledRecords, {
        ...dependencies,
        inactivateGeneration,
        abortPreparation,
        reason: 'agent-disable-batch-prepare',
    });
    try {
        removeDisabledRuntimes(disabledRecords, dependencies);
    } catch (error) {
        try {
            inactivateGeneration('agent-disable-batch-runtime-removal-failed', {
                preserveSelectedGeneration: true,
            });
        } catch (_) {}
        const removalFailure = new Error(
            `disable agents: failed to stop and remove containers: ${error?.message || error}`,
            { cause: error },
        );
        recoverFailedAgentEnableCandidate(null, prepared.preparationLease, removalFailure, {
            abortPreparation,
            reason: 'agent-disable-batch-runtime-removal-failed',
            operation: 'disable-agents batch-runtime recovery',
        });
        throw removalFailure;
    }
    commitAgentDisableGeneration(prepared, {
        reason: 'agent-disable-batch-commit',
        applyGeneration,
        inactivateGeneration,
        abortPreparation,
    });

    for (const item of disabled) {
        if (item.status !== 'removed' || !item.shortAgentName) continue;
        try {
            removeAgentSymlinks(item.shortAgentName);
        } catch (err) {
            console.error(`Warning: Failed to remove workspace structure for ${item.shortAgentName}: ${err.message}`);
        }
    }

    return disabled;
}

export function resolveEnabledAgentRecord(agentRef) {
    const input = typeof agentRef === 'string' ? agentRef.trim() : '';
    if (!input) return null;

    const map = loadAgents();
    if (!map || typeof map !== 'object') return null;

    const direct = map[input];
    if (direct && direct.type === 'agent') {
        return { containerName: input, record: direct };
    }

    const hasNamespace = /[:/]/.test(input);
    let repoFilter = null;
    let agentFilter = input;
    if (hasNamespace) {
        const parts = input.split(/[:/]/).filter(Boolean);
        if (parts.length === 2) {
            [repoFilter, agentFilter] = parts;
        }
    }

    let aliasEntry = Object.entries(map || {})
        .filter(([key]) => !RESERVED_AGENT_KEYS.has(key))
        .find(([, value]) => value && value.type === 'agent' && value.alias === input);
    if (!aliasEntry && hasNamespace) {
        aliasEntry = Object.entries(map || {})
            .filter(([key]) => !RESERVED_AGENT_KEYS.has(key))
            .find(([, value]) => value && value.type === 'agent' && value.alias === agentFilter);
    }
    if (aliasEntry) {
        return { containerName: aliasEntry[0], record: aliasEntry[1] };
    }

    const matches = Object.entries(map)
        .filter(([key, value]) => !RESERVED_AGENT_KEYS.has(key) && value && typeof value === 'object')
        .filter(([, value]) => value.type === 'agent')
        .filter(([, value]) => {
            if (!value.agentName) return false;
            if (repoFilter && value.repoName !== repoFilter) return false;
            return value.agentName === agentFilter;
        });

    if (!matches.length) {
        return null;
    }

    if (matches.length > 1) {
        const aliasList = matches.map(([containerName, value]) => value.alias || containerName);
        const err = new Error(`Multiple containers found for agent '${agentRef}'. Use alias: ${aliasList.join(', ')}`);
        err.code = 'AGENT_ALIAS_AMBIGUOUS';
        throw err;
    }

    const [containerName, record] = matches[0];
    return { containerName, record };
}
