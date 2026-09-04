import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { loadAgents, saveAgents } from './workspace.js';
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
import { resolveAgentExecutionMode, resolveAgentReadinessProtocol, resolveManifestReadinessWaitOptions } from './runtime/startupReadiness.js';
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
import {
    RESERVED_AGENT_REGISTRY_KEYS,
    resolveEnabledAgentRecordFromMap,
} from './agentRegistryResolver.js';
import { retireNoWaitRunMarkers } from '../commands/noWaitMarkerLifecycle.js';
import { resolveManifestAuthMode } from './manifestAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const AGENT_LIB_PATH = path.resolve(__dirname, '../../Agent');
const RESERVED_AGENT_KEYS = RESERVED_AGENT_REGISTRY_KEYS;
const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const AUTH_MODES = new Set(['none', 'sso', 'guest']);
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
    if (normalized === 'local' || normalized === 'pwd') {
        throw new Error('Local password authentication is no longer supported; use --auth sso.');
    }
    if (!AUTH_MODES.has(normalized)) {
        throw new Error(`Unknown auth mode '${authMode}'. Allowed: none | guest | sso`);
    }
    return normalized;
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

export async function waitForEnabledAgentReadiness(shortAgentName, manifest, started, {
    networkMode = '',
    generationDigest = '',
    waitUntilReady = waitForAgentReady,
    containerWaitRunning = waitForContainerRunning,
    sandboxIsRunning = isBwrapProcessRunning,
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
    const runtime = String(started?.runtime || started?.registryRecord?.runtime || 'container').trim().toLowerCase();
    const runtimeInstanceName = String(started?.containerName || '').trim();
    const runtimeIdentity = {
        instanceId: String(started?.registryRecord?.instanceId || '').trim(),
        enableGeneration: String(started?.registryRecord?.enableGeneration || '').trim(),
    };
    let runtimeExited = false;
    let livenessCheckWarning = null;
    const beforeProbe = () => {
        try {
            const running = runtime === 'bwrap' || runtime === 'seatbelt'
                ? sandboxIsRunning(runtimeInstanceName, runtimeIdentity)
                : containerWaitRunning(
                    String(started?.containerId || started?.registryRecord?.containerId || runtimeInstanceName),
                    1,
                    1,
                    {
                        runtime: ['docker', 'podman'].includes(runtime) ? runtime : undefined,
                        totalTimeoutMs: 5000,
                        throwOnControlPlaneTimeout: true,
                    },
                );
            runtimeExited = !running;
            return running;
        } catch (error) {
            // A transient runtime control-plane timeout is not proof that the
            // exact process exited. Preserve readiness retries and retain the
            // warning in case the semantic probe eventually times out.
            livenessCheckWarning = error;
            return true;
        }
    };
    const ready = await waitUntilReady(readinessRoute, {
        ...resolveManifestReadinessWaitOptions(manifest, 120000, {
            timeoutMs: process.env.PLOINKY_ENABLE_AGENT_READY_TIMEOUT_MS,
            intervalMs: process.env.PLOINKY_ENABLE_AGENT_READY_INTERVAL_MS,
            probeTimeoutMs: process.env.PLOINKY_ENABLE_AGENT_READY_PROBE_TIMEOUT_MS,
        }),
        protocol,
        beforeProbe,
    });
    if (!ready && runtimeExited) {
        throw new Error(
            `${runtime} runtime '${runtimeInstanceName || shortAgentName}' exited before readiness protocol '${protocol}' succeeded`,
        );
    }
    if (!ready) {
        const warning = livenessCheckWarning?.message
            ? `; runtime liveness check warning: ${livenessCheckWarning.message}`
            : '';
        throw new Error(`readiness protocol '${protocol}' did not succeed${warning}`);
    }
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
    admitManifestRuntimeCapabilities(manifest, admissionOptions);
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
    const manifestAuthMode = resolveManifestAuthMode(manifest);
    const authMode = authModeParam === undefined || authModeParam === null || String(authModeParam).trim() === ''
        ? manifestAuthMode
        : normalizeAuthMode(authModeParam);
    if (manifestAuthMode === 'sso' && authMode !== 'sso') {
        throw new Error('Manifest requires SSO authentication; --auth cannot override it.');
    }
    if (Object.hasOwn(authOptions, 'username') || Object.hasOwn(authOptions, 'password')) {
        throw new Error('Local password authentication options are no longer supported.');
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
    record.auth = { mode: authMode };
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
    retireNoWaitMarkers = retireNoWaitRunMarkers,
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
        // A fixed current-marker may outlive a prior disable/remove, so a
        // genuinely new registry key has no predecessor record with which to
        // discover it. Retire every requested container: constrain an existing
        // marker to its exact predecessor tuple, or retire a secure orphan by
        // name before the new tuple can be persisted.
        const supersededNoWaitRecords = plans.map(({ containerName }) => {
            const predecessor = previousAgents?.[containerName];
            return predecessor?.type === 'agent'
                ? { containerName, record: predecessor }
                : containerName;
        });
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
                retireNoWaitMarkers(supersededNoWaitRecords);
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
                retireNoWaitMarkers(supersededNoWaitRecords);
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
        try {
            if (preparedGeneration?.preparationLease) {
                abortEdgeRoutingPreparation(preparedGeneration.preparationLease, {
                    reason: 'agent-enable-batch-prepare-failed',
                });
            }
        } catch (_) {}
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
                if (finalLease?.mode === 'additive') {
                    commitAdditiveEdgeRoutingGeneration(finalLease, {
                        routing: finalRouting,
                        agents: finalAgents,
                        applyLockCapability,
                    });
                    return;
                }
                // Same-name re-enable cannot shadow its predecessor. Its earlier
                // replacement preparation already made routing inactive; publish
                // the ready locator, then activate only the exact
                // replacement lease. No stale predecessor selector is restored.
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
        if (failedCandidate?.containerName
            && failedCandidate?.cleanupReceipt
            && failedCandidate.exactCleanupPerformed !== true) {
            try {
                cleanupExactAgentRuntimeCandidate(failedCandidate);
            } catch (cleanupError) {
                error.message = `${error.message}; exact candidate cleanup failed: ${cleanupError?.message || cleanupError}`;
            }
        }
        try {
            const failedLease = started?.preparationLease
                || prepared?.preparedGeneration?.preparationLease;
            if (failedLease) {
                abortEdgeRoutingPreparation(failedLease, {
                    reason: 'agent-enable-start-failed',
                });
            }
        } catch (_) {}
        throw wrapLifecycleError(
            `enable agent: failed to start '${shortAgentName}': ${error?.message || error}`,
            error,
        );
    }
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
    withApplyLock = withEdgeGenerationApplyLock,
    retireNoWaitMarkersImpl = retireNoWaitRunMarkers,
} = {}) {
    return withApplyLock((applyLockCapability) => {
        inactivateGeneration(reason, { applyLockCapability });
        retireNoWaitMarkersImpl(disabledRecords.map(({ containerName, record }) => (
            record?.type === 'agent'
                ? { containerName, record }
                : containerName
        )));
        const routing = removeDisabledRoutes(readRoutingImpl(), disabledRecords);
        saveAgentsImpl(map, { coordinate: false, applyLockCapability });
        writeRoutingImpl(routing, { coordinate: false, applyLockCapability });
        const prepared = prepareGeneration({ reason, applyLockCapability });
        if (prepared?.selector?.state !== 'inactive') {
            throw new Error('disable agent: prepared route-removal generation did not remain inactive');
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
        try {
            if (prepared?.preparationLease) {
                abortPreparation(prepared.preparationLease, { reason: `${reason}-failed` });
            }
        } catch (_) {}
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
    const containerRecords = {};
    for (const { containerName, record } of disabledRecords) {
        if (isSandboxRuntimeImpl(record?.runtime)) {
            stopSandboxImpl(containerName);
            if (sandboxRunningImpl(containerName)) {
                throw new Error(`sandbox runtime '${containerName}' is still running`);
            }
        } else {
            containerTargets.push(containerName);
            containerRecords[containerName] = record;
        }
    }
    if (containerTargets.length === 1) {
        stopAndRemoveImpl(containerTargets[0], { records: containerRecords });
    } else if (containerTargets.length > 1) {
        stopAndRemoveManyImpl(containerTargets, { records: containerRecords });
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
                try {
                    abortPreparation(prepared.preparationLease, {
                        reason: 'agent-disable-static-runtime-removal-failed',
                    });
                } catch (_) {}
                throw new Error(`disable agent: failed to stop and remove static runtime '${staticContainer}': ${error?.message || error}`);
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
        try { abortPreparation(prepared.preparationLease, { reason: 'agent-disable-runtime-removal-failed' }); } catch (_) {}
        throw new Error(`disable agent: failed to stop and remove container '${containerName}': ${error?.message || error}`);
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
        try { abortPreparation(prepared.preparationLease, { reason: 'agent-disable-batch-runtime-removal-failed' }); } catch (_) {}
        throw new Error(`disable agents: failed to stop and remove containers: ${error?.message || error}`);
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

// Loading wrapper around the one pure resolver. Every precedence, ambiguity,
// and malformed-reference rule lives in `agentRegistryResolver.js` so the
// read-only log command and the loading command handlers cannot drift apart.
export function resolveEnabledAgentRecord(agentRef) {
    const input = typeof agentRef === 'string' ? agentRef.trim() : '';
    if (!input) return null;
    return resolveEnabledAgentRecordFromMap(input, loadAgents());
}
