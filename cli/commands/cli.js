import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { debugLog, findAgent } from '../utils/utils.js';
import { isKnownCommand } from './commandRegistry.js';
import { showHelp } from './help.js';
import * as envSvc from '../utils/security/secretVars.js';
import * as agentsSvc from '../utils/agents.js';
import { listRepos, listAgents, listCurrentAgents, listRoutes, statusWorkspace } from '../utils/status.js';
import { runLogCommand } from './logCommands.js';
import { activeForegroundSignal } from './foregroundCommand.js';
import {
    startWorkspace,
    runCli,
    runShell,
    reinstallAgent,
    waitForManifestReadiness,
    activatePreparedRuntimeAfterReadiness,
    cleanupFailedPreparedRuntime,
    admitDirectAgentRuntimeManifest,
} from './workspaceUtil.js';
import {
    withMaintenanceLock,
    withWorkspaceMutationLease,
} from '../utils/runtime/maintenanceLocks.js';
import { printComponentAccess } from '../server/utils/routerEnv.js';
import {
    getAgentContainerName,
    getRuntime,
    containerExists,
    isContainerRunning,
    stopConfiguredAgents,
    destroyWorkspaceContainers,
    ensureAgentService
} from '../sandbox/docker/index.js';
import { getRuntimeForAgent, isSandboxRuntime } from '../sandbox/docker/common.js';
import { isBwrapProcessRunning } from '../sandbox/bwrap/bwrapFleet.js';
import * as workspaceSvc from '../utils/workspace.js';
import { handleSystemCommand, handleInvalidCommand, resetLlmInvokerCache } from './llmSystemCommands.js';
import * as inputState from './inputState.js';
import {
    getRepoNames,
    getAgentNames,
    installRepo,
    addRepo,
    enableRepo,
    disableRepo,
    uninstallRepo,
    updateRepo,
    updatePloinkyRepos,
    updateAllRepos,
    enableAgent,
    findAgentManifest,
} from './repoAgentCommands.js';
import { parseStartArgs } from '../utils/repos.js';
import { resolveAgentlibBranchRef } from '../utils/dependencies/dependencyInstaller.js';
import {
    handleVarsCommand,
    handleVarCommand,
    handleEchoCommand,
    handleExposeCommand,
} from './envVarCommands.js';
import { handleDefaultSkillsCommand } from './skillsCommands.js';
import { runSettingsMenu } from './settingsMenu.js';
import { handleProfileCommand } from './profileCommands.js';
import {
    cleanupSessionContainers,
    destroyAll,
    killRouterIfRunning,
    shutdownSession,
} from './sessionControl.js';
import { handleSsoCommand } from './ssoCommands.js';
import { handleDepsCommand } from './depsCommands.js';
import { disableHostSandbox, enableHostSandbox, handleSandboxCommand } from './sandboxCommands.js';
import ClientCommands from './client.js';
import {
    getValidProfiles,
    isValidProfile,
    resolveManifestRuntimeProfile,
    setActiveProfile,
} from '../utils/runtime/profileService.js';
import { resolvePersistedRouterPort, resolveRouterEndpoint } from '../sandbox/routerPort.js';
import { runOuterRuntimeShell } from '../sandbox/runtimeShell.js';
import { createNetworkLifecycleAdapter, withNetworkLifecycleLock } from '../sandbox/networkLifecycle.js';
import {
    inactivateEdgeRoutingGeneration,
    initializeFreshEdgeRoutingSources,
} from '../sandbox/edgeGeneration.js';
import {
    assertNoLiveNoWaitWorkers,
    quiesceNoWaitWorkers,
    waitForNoWaitWorkersToSettle,
} from './noWaitQuiescence.js';

let llmAgentsLoadPromise = null;
const ENABLE_AGENT_CLI_TOKENS = Object.freeze({
    alias: 'as',
    auth: '--auth',
    user: '--user',
    password: '--password',
});
const ENABLE_AGENT_CLI_TOKEN_SET = new Set(Object.values(ENABLE_AGENT_CLI_TOKENS));

async function ensureLlmAgentsLoaded() {
    if (!llmAgentsLoadPromise) {
        llmAgentsLoadPromise = import('achillesAgentLib/LLMAgents').catch((error) => {
            llmAgentsLoadPromise = null;
            throw error;
        });
    }
    return llmAgentsLoadPromise;
}


function parseEnableAgentArgs(rawOptions = []) {
    const tokens = rawOptions
        .filter(arg => arg !== undefined && arg !== null)
        .map(arg => (typeof arg === 'string' ? arg.trim() : arg))
        .filter(arg => !(typeof arg === 'string' && arg.length === 0));

    if (!tokens.length) {
        return { agentName: undefined, mode: undefined, repoName: undefined, alias: undefined };
    }

    let alias;
    let authMode;
    let username;
    let password;
    let aliasIndex = -1;
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (typeof token === 'string' && token.toLowerCase() === ENABLE_AGENT_CLI_TOKENS.alias) {
            aliasIndex = i;
            break;
        }
    }

    if (aliasIndex !== -1) {
        alias = tokens.slice(aliasIndex + 1).join(' ').trim();
        tokens.splice(aliasIndex);
        if (!alias) {
            throw new Error("Usage: enable agent <name|repo/name> [isolated|global|devel [repoName]] [as <alias>]");
        }
    }

    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (typeof token === 'string' && token.toLowerCase() === ENABLE_AGENT_CLI_TOKENS.auth) {
            const next = tokens[i + 1];
            if (!next || typeof next !== 'string') {
                throw new Error("Usage: enable agent <name|repo/name> [isolated|global|devel [repoName]] [--auth none|pwd|sso] [--user <name> --password <value>] [as <alias>]");
            }
            authMode = next.trim().toLowerCase();
            tokens.splice(i, 2);
            i -= 1;
            continue;
        }
        if (typeof token === 'string' && token.toLowerCase() === ENABLE_AGENT_CLI_TOKENS.user) {
            const next = tokens[i + 1];
            if (!next || typeof next !== 'string') {
                throw new Error("Usage: enable agent <name|repo/name> [isolated|global|devel [repoName]] [--auth none|pwd|sso] [--user <name> --password <value>] [as <alias>]");
            }
            username = next.trim();
            tokens.splice(i, 2);
            i -= 1;
            continue;
        }
        if (typeof token === 'string' && token.toLowerCase() === ENABLE_AGENT_CLI_TOKENS.password) {
            const next = tokens[i + 1];
            if (!next || typeof next !== 'string') {
                throw new Error("Usage: enable agent <name|repo/name> [isolated|global|devel [repoName]] [--auth none|pwd|sso] [--user <name> --password <value>] [as <alias>]");
            }
            password = next;
            tokens.splice(i, 2);
            i -= 1;
        }
    }

    return {
        agentName: tokens[0],
        mode: tokens[1],
        repoName: tokens[2],
        alias,
        authMode,
        username,
        password,
    };
}

function parseInstallRepoArgs(options = []) {
    const tokens = [...options];
    const branchIdx = tokens.indexOf('--branch');
    let branch = null;
    if (branchIdx !== -1 && tokens[branchIdx + 1]) {
        branch = tokens[branchIdx + 1];
        tokens.splice(branchIdx, 2);
    }
    if (['repo', 'repository'].includes(String(tokens[0] || '').toLowerCase())) {
        tokens.shift();
    }
    const url = tokens[0];
    const name = tokens[1] || null;
    if (!branch && tokens[2]) branch = tokens[2];
    return { url, name, branch };
}

function parseRepoToggleArgs(options = []) {
    const parsed = parseInstallRepoArgs(options);
    return { repoName: parsed.url, branch: parsed.branch };
}

function parseUninstallRepoTarget(options = []) {
    const tokens = [...options];
    if (String(tokens[0] || '').toLowerCase() === 'repo') {
        tokens.shift();
    }
    return tokens[0];
}

function hasAgentEnableSyntax(options = []) {
    return options.slice(1).some((token) => {
        const normalized = String(token || '').trim().toLowerCase();
        return agentsSvc.isEnableAgentMode(normalized) || ENABLE_AGENT_CLI_TOKEN_SET.has(normalized);
    });
}

export async function handleCliCommand(options = [], {
    runOuterRuntimeShellImpl = runOuterRuntimeShell,
    runAgentCliImpl = runCli,
} = {}) {
    if (options.length === 0) return runOuterRuntimeShellImpl();
    return runAgentCliImpl(options[0], options.slice(1));
}

async function handleCommand(args) {
    const [command, ...options] = args;
    if (command === 'start') {
        const parsed = parseStartArgs(options);
        if (parsed.profile && !isValidProfile(parsed.profile)) {
            throw new Error(`Invalid profile '${parsed.profile}'. Valid profiles are: ${getValidProfiles().join(', ')}`);
        }
    }
    switch (command) {
        case 'shell':
            if (!options[0]) { showHelp(); break; }
            await runShell(options[0]);
            break;
        case 'cli':
            return handleCliCommand(options);
        // 'agent' command removed; use 'enable agent <agentName>' then 'start'
        case 'add':
            {
                const parsed = parseInstallRepoArgs(options);
                addRepo(parsed.url, parsed.name, parsed.branch);
            }
            break;
        case 'install':
            {
                const parsed = parseInstallRepoArgs(options);
                installRepo(parsed.url, parsed.name, parsed.branch);
            }
            break;
        case 'remove':
        case 'uninstall':
            uninstallRepo(parseUninstallRepoTarget(options));
            break;
        case 'vars':
            handleVarsCommand();
            break;
        case 'var':
            handleVarCommand(options);
            break;
        case 'echo':
            handleEchoCommand(options);
            break;
        case 'update':
            {
                const first = String(options[0] || '').trim();
                const firstLower = first.toLowerCase();
                if (!first || firstLower === 'all') {
                    const folderArg = first ? String(options[1] || '').trim() || undefined : undefined;
                    await updateAllRepos(folderArg, { interactiveSession: Boolean(inputState.getInterface?.()) });
                } else if (firstLower === 'repos' || firstLower === 'repositories') {
                    await updatePloinkyRepos();
                } else if (firstLower === 'repo' || firstLower === 'repository') {
                    await updateRepo(options[1]);
                } else {
                    const resolved = path.resolve(first);
                    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                        await updateAllRepos(first, { interactiveSession: Boolean(inputState.getInterface?.()) });
                    } else {
                        await updateRepo(first);
                    }
                }
            }
            break;
        case 'reinstall': {
            const sub = String(options[0] || '').trim();
            const target = sub.toLowerCase() === 'agent'
                ? String(options[1] || '').trim()
                : sub;
            if (target) await reinstallAgent(target);
            else showHelp();
            break;
        }
        case 'enable':
            if (String(options[0] || '').toLowerCase() === 'repo' || String(options[0] || '').toLowerCase() === 'repository') {
                const parsed = parseRepoToggleArgs(options);
                enableRepo(parsed.repoName, parsed.branch);
            }
            else if (options[0] === 'agent') {
                const parsed = parseEnableAgentArgs(options.slice(1));
                await enableAgent(parsed.agentName, parsed.mode, parsed.repoName, parsed.alias, parsed.authMode, parsed.username, parsed.password);
            }
            else if (['sandbox', 'host-sandbox', 'lite-sandbox'].includes(String(options[0] || '').toLowerCase())) {
                enableHostSandbox();
            }
            else {
                if (!options.length) {
                    showHelp();
                    break;
                }
                const parsed = parseEnableAgentArgs(options);
                await enableAgent(parsed.agentName, parsed.mode, parsed.repoName, parsed.alias, parsed.authMode, parsed.username, parsed.password);
            }
            break;
        case 'expose':
            handleExposeCommand(options);
            break;
        case 'default-skills':
            handleDefaultSkillsCommand(options);
            break;
        case 'disable': {
            if (!options.length) {
                showHelp();
                break;
            }

            if (String(options[0] || '').toLowerCase() === 'agents-all') {
                disableAllAgents();
                break;
            }

            if (String(options[0] || '').toLowerCase() === 'repo' || String(options[0] || '').toLowerCase() === 'repository') {
                const parsed = parseRepoToggleArgs(options);
                disableRepo(parsed.repoName);
                break;
            }

            if (['sandbox', 'host-sandbox', 'lite-sandbox'].includes(String(options[0] || '').toLowerCase())) {
                disableHostSandbox();
                break;
            }

            let target = options.join(' ').trim();
            if (options[0] === 'agent') {
                target = options.slice(1).join(' ').trim();
            }

            if (!target) {
                showHelp();
                break;
            }

            try {
                const result = agentsSvc.disableAgent(target);
                switch (result.status) {
                    case 'removed':
                        console.log(`✓ Agent '${result.shortAgentName}' from repo '${result.repoName}' disabled.`);
                        break;
                    case 'not-found':
                        console.log(`Agent '${target}' is not enabled in this workspace.`);
                        break;
                    case 'static-removed':
                        console.log(`✓ Static agent '${target}' configuration cleared.`);
                        break;
                    case 'ambiguous':
                        console.log(`Agent name '${target}' is ambiguous. Please specify one of:`);
                        for (const entry of result.matches || []) {
                            console.log(`  - ${entry}`);
                        }
                        break;
                    default:
                        console.log(`No changes made for agent '${target}'.`);
                        break;
                }
            } catch (error) {
                throw new Error(`disable agent failed: ${error?.message || error}`);
            }
            break;
        }
        // 'run' legacy commands removed; use 'start', 'cli', 'shell', 'console'.
        case 'start': {
            const startParsed = parseStartArgs(options);
            if (startParsed.profile) {
                const profileResult = setActiveProfile(startParsed.profile);
                if (!profileResult.success) {
                    throw new Error(profileResult.message);
                }
            }
            // Outside bounded local development, the global --branch also
            // drives the achillesAgentLib used by agent containers. A selected
            // local archive is authoritative, so branch policy continues for
            // repositories without replacing its fixed PLOINKY_AGENTLIB_REF.
            const localAgentlibSha = String(process.env.PLOINKY_LOCAL_AGENTLIB_SHA || '');
            if (localAgentlibSha && !/^[a-f0-9]{64}$/.test(localAgentlibSha)) {
                throw new Error('PLOINKY_LOCAL_AGENTLIB_SHA must be 64 lowercase hexadecimal characters');
            }
            if (!localAgentlibSha) {
                const agentlibRef = resolveAgentlibBranchRef(startParsed.branchPolicy);
                if (agentlibRef) {
                    process.env.PLOINKY_AGENTLIB_REF = agentlibRef;
                }
            }
            await startWorkspace(startParsed.staticAgent, startParsed.port ?? undefined, {
                enableAgent,
                killRouterIfRunning,
                branchPolicy: startParsed.branchPolicy,
            });
            break;
        }
        // 'route' and 'probe' commands removed (replaced by start/status and client commands)
        case 'webchat': {
            if ((options || []).filter(Boolean).length) throw new Error('Usage: webchat');
            printComponentAccess('webchat');
            break;
        }
        case 'sso':
            await handleSsoCommand(options);
            break;
        case 'sandbox':
            handleSandboxCommand(options);
            break;
        case 'deps':
            await handleDepsCommand(options);
            break;
        case 'dashboard': {
            if ((options || []).filter(Boolean).length) throw new Error('Usage: dashboard');
            printComponentAccess('dashboard');
            break;
        }
        case 'list':
            if (options[0] === 'agents') listAgents();
            else if (options[0] === 'repos') listRepos();
            else if (options[0] === 'routes') listRoutes();
            else showHelp();
            break;
        case 'status':
            await statusWorkspace();
            break;
        case 'network': {
            const subcommand = String(options[0] || '').trim();
            const runtime = getRuntime();
            const adapter = createNetworkLifecycleAdapter({ runtime });
            if (subcommand === 'status') {
                const json = options.slice(1).includes('--json');
                if (options.slice(1).some((value) => value !== '--json')) {
                    throw new Error('Usage: network status [--json]');
                }
                const status = adapter.status();
                if (json) console.log(JSON.stringify(status, null, 2));
                else if (!status.networks.length) console.log('No workspace managed-network resources found.');
                else {
                    status.networks.forEach((record) => console.log(`${record.ownership}\t${record.physicalName}\t${record.logicalName || '-'}`));
                }
                break;
            }
            if (subcommand === 'prune' && options.length === 1) {
                const report = adapter.prune();
                for (const name of report.removed) console.log(`removed\t${name}`);
                for (const record of report.preserved) console.log(`preserved\t${record.name}\t${record.reason}`);
                break;
            }
            throw new Error('Usage: network status [--json] | network prune');
        }
        case 'restart': {
            const target = (options[0] || '').trim();
            if (target && target.toLowerCase() === 'router') {
                const cfg = workspaceSvc.getConfig();
                if (!cfg || !cfg.static || !cfg.static.agent || !cfg.static.port) {
                    console.error('restart router: start is not configured. Run: start <staticAgent> <port> first.');
                    break;
                }
                inactivateEdgeRoutingGeneration('cli-router-restart');
                console.log('[restart] Restarting RoutingServer (containers untouched)...');
                resolvePersistedRouterPort();
                killRouterIfRunning();
                await startWorkspace(undefined, undefined, {
                    enableAgent,
                    killRouterIfRunning: () => { },
                });
                console.log('[restart] RoutingServer restarted.');
                break;
            }

            if (target) {
                const agentName = target;
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
                    resolved = findAgent(lookup);
                } catch (err) {
                    console.error(err?.message || `Agent '${agentName}' not found.`);
                    return;
                }

                // Read manifest and determine runtime
                let manifest;
                let manifestBytes;
                try {
                    manifestBytes = fs.readFileSync(resolved.manifestPath);
                    manifest = JSON.parse(manifestBytes.toString('utf8'));
                } catch (err) {
                    console.error(`Failed to read manifest for '${agentName}': ${err?.message || err}`);
                    return;
                }

                const profileResolution = resolveManifestRuntimeProfile(manifest, {
                    agentName: `${registryRecord?.record?.repoName || resolved.repo}/${resolved.shortAgentName}`,
                    profileName: registryRecord?.record?.profile || undefined,
                    path: `manifest(${registryRecord?.record?.repoName || resolved.repo}/${resolved.shortAgentName})`,
                });
                const directAdmission = admitDirectAgentRuntimeManifest(manifest, {
                    manifestPath: resolved.manifestPath,
                    manifestBytes,
                    agentId: `${registryRecord?.record?.repoName || resolved.repo}/${resolved.shortAgentName}`,
                    profileName: profileResolution.resolvedProfileName,
                });
                const routerEndpoint = resolveRouterEndpoint(profileResolution.network.mode);

                const agentRuntime = getRuntimeForAgent(manifest);
                const containerName = registryRecord?.containerName || getAgentContainerName(resolved.shortAgentName, resolved.repo);

                if (isSandboxRuntime(agentRuntime)) {
                    // Sandbox restart: stop process, then re-create via ensureAgentService
                    const bwrapRunning = Boolean(
                        registryRecord?.record?.instanceId
                        && registryRecord?.record?.enableGeneration,
                    ) && isBwrapProcessRunning(containerName, {
                        instanceId: registryRecord.record.instanceId,
                        enableGeneration: registryRecord.record.enableGeneration,
                    });
                    const containerAlsoRunning = isContainerRunning(containerName);
                    const containerPresent = containerAlsoRunning || containerExists(containerName) || Boolean(registryRecord?.containerName);
                    if (!bwrapRunning && !containerPresent) {
                        console.error(`Agent '${agentName}' has no existing container. Run 'ploinky reinstall ${agentName}'.`);
                        return;
                    }

                    if (!bwrapRunning && !containerAlsoRunning && containerPresent) {
                        console.log(`Starting (${agentRuntime}) agent '${agentName}'...`);
                        try {
                            await withMaintenanceLock(containerName, {
                                operation: 'start',
                                metadata: {
                                    agent: resolved.shortAgentName,
                                    repo: resolved.repo,
                                },
                            }, async () => withNetworkLifecycleLock(async (networkLifecycleCapability) => {
                                const result = ensureAgentService(resolved.shortAgentName, manifest, path.dirname(resolved.manifestPath), {
                                    containerName,
                                    alias: registryRecord?.record?.alias,
                                    profileName: profileResolution.resolvedProfileName,
                                    profileResolution,
                                    routerEndpoint,
                                    runtimeAdmission: directAdmission.runtimeAdmission,
                                    networkLifecycleCapability,
                                });
                                try {
                                    await waitForManifestReadiness({
                                        key: `start:${resolved.shortAgentName}`,
                                        label: resolved.shortAgentName,
                                        kind: 'reinstall',
                                        manifest,
                                        route: {
                                            container: result?.containerName || containerName,
                                            hostPort: result?.hostPort || 0,
                                        },
                                    });
                                    await activatePreparedRuntimeAfterReadiness({
                                        result,
                                        routeKey: registryRecord?.record?.alias || resolved.shortAgentName,
                                        repoName: registryRecord?.record?.repoName || resolved.repo,
                                        shortAgentName: resolved.shortAgentName,
                                        agentPath: path.dirname(resolved.manifestPath),
                                        alias: registryRecord?.record?.alias || '',
                                    });
                                } catch (error) {
                                    cleanupFailedPreparedRuntime(result, error, 'manual-start-readiness-failed');
                                    throw error;
                                }
                            }));
                            console.log('✓ Agent started.');
                        } catch (e) {
                            console.error(`Failed to start container ${containerName}: ${e.message}`);
                        }
                        return;
                    }

                    console.log(`Restarting (${agentRuntime}) agent '${agentName}'...`);

                    try {
                        await withMaintenanceLock(containerName, {
                            operation: 'restart',
                            metadata: {
                                agent: resolved.shortAgentName,
                                repo: resolved.repo,
                            },
                        }, async () => withNetworkLifecycleLock(async (networkLifecycleCapability) => {
                            const agentPath = path.dirname(resolved.manifestPath);
                            const restartResult = ensureAgentService(resolved.shortAgentName, manifest, agentPath, {
                                containerName,
                                alias: registryRecord?.record?.alias,
                                forceRecreate: true,
                                profileName: profileResolution.resolvedProfileName,
                                profileResolution,
                                routerEndpoint,
                                runtimeAdmission: directAdmission.runtimeAdmission,
                                networkLifecycleCapability,
                            });
                            const {
                                containerName: newContainerName,
                                hostPort,
                            } = restartResult;
                            try {
                                await waitForManifestReadiness({
                                    key: `restart:${resolved.shortAgentName}`,
                                    label: resolved.shortAgentName,
                                    kind: 'reinstall',
                                    manifest,
                                    route: {
                                        container: newContainerName,
                                        hostPort: hostPort || 0,
                                    },
                                });

                                await activatePreparedRuntimeAfterReadiness({
                                    result: restartResult,
                                    routeKey: registryRecord?.record?.alias || resolved.shortAgentName,
                                    repoName: registryRecord?.record?.repoName || resolved.repo,
                                    shortAgentName: resolved.shortAgentName,
                                    agentPath,
                                    alias: registryRecord?.record?.alias || '',
                                });
                            } catch (error) {
                                cleanupFailedPreparedRuntime(restartResult, error, 'manual-restart-readiness-failed');
                                throw error;
                            }
                        }));

                        console.log(`✓ Agent restarted (${agentRuntime}).`);
                    } catch (e) {
                        console.error(`Failed to restart agent '${agentName}' via ${agentRuntime}: ${e.message}`);
                    }
                } else {
                    // Recreate through the managed transaction so a manual
                    // restart cannot bypass endpoint, bridge, or ownership
                    // validation on a stopped or legacy container.
                    const containerRunning = isContainerRunning(containerName);
                    const containerPresent = containerRunning || containerExists(containerName) || Boolean(registryRecord?.containerName);
                    if (!containerPresent) {
                        console.error(`Agent '${agentName}' has no existing container. Run 'ploinky reinstall ${agentName}'.`);
                        return;
                    }

                    const runtimeAction = 'restart';
                    console.log(`Restarting (${getRuntime()}) agent '${agentName}'...`);
                    try {
                        await withMaintenanceLock(containerName, {
                            operation: runtimeAction,
                            metadata: {
                                agent: resolved.shortAgentName,
                                repo: resolved.repo,
                            },
                        }, async () => withNetworkLifecycleLock(async (networkLifecycleCapability) => {
                            try {
                                const result = ensureAgentService(resolved.shortAgentName, manifest, path.dirname(resolved.manifestPath), {
                                    containerName,
                                    alias: registryRecord?.record?.alias,
                                    forceRecreate: true,
                                    profileName: profileResolution.resolvedProfileName,
                                    profileResolution,
                                    routerEndpoint,
                                    runtimeAdmission: directAdmission.runtimeAdmission,
                                    networkLifecycleCapability,
                                });
                                try {
                                    await waitForManifestReadiness({
                                        key: `restart:${resolved.shortAgentName}`,
                                        label: resolved.shortAgentName,
                                        kind: 'reinstall',
                                        manifest,
                                        route: {
                                            container: result?.containerName || containerName,
                                            hostPort: result?.hostPort || 0,
                                        },
                                    });
                                    await activatePreparedRuntimeAfterReadiness({
                                        result,
                                        routeKey: registryRecord?.record?.alias || resolved.shortAgentName,
                                        repoName: registryRecord?.record?.repoName || resolved.repo,
                                        shortAgentName: resolved.shortAgentName,
                                        agentPath: path.dirname(resolved.manifestPath),
                                        alias: registryRecord?.record?.alias || '',
                                    });
                                } catch (error) {
                                    cleanupFailedPreparedRuntime(result, error, 'manual-restart-readiness-failed');
                                    throw error;
                                }
                            } catch (routeError) {
                                throw new Error(`managed restart failed: ${routeError?.message || routeError}`);
                            }
                        }));
                        console.log('✓ Agent restarted.');
                    } catch (e) {
                        console.error(`Failed to ${runtimeAction} container ${containerName}: ${e.message}`);
                    }
                }
            } else {
                const cfg = workspaceSvc.getConfig();
                if (!cfg || !cfg.static || !cfg.static.agent || !cfg.static.port) { console.error('restart: start is not configured. Run: start <staticAgent> <port>'); break; }
                resolvePersistedRouterPort();
                inactivateEdgeRoutingGeneration('cli-workspace-restart');
                console.log('[restart] Stopping Router and configured agents...');
                killRouterIfRunning();
                console.log('[restart] Stopping configured agent containers...');
                const list = stopConfiguredAgents();
                if (list.length) { console.log('[restart] Stopped containers:'); list.forEach(n => console.log(` - ${n}`)); }
                else { console.log('[restart] No containers to stop.'); }
                console.log('[restart] Starting workspace...');
                await startWorkspace(undefined, undefined, {
                    enableAgent,
                    killRouterIfRunning,
                });
                console.log('[restart] Done.');
            }
            break;
        }
        case 'delete':
            showHelp();
            break;
        case 'shutdown': {
            inactivateEdgeRoutingGeneration('cli-workspace-shutdown');
            console.log('[shutdown] Stopping RoutingServer...');
            killRouterIfRunning();
            console.log('[shutdown] Removing workspace containers...');
            const list = destroyWorkspaceContainers();
            if (list.length) {
                console.log('[shutdown] Removed containers:');
                list.forEach(n => console.log(` - ${n}`));
            }
            console.log(`Destroyed ${list.length} containers from this workspace (per .ploinky/agents.json).`);
            break;
        }
        case 'stop': {
            const sourceTransition = options.length === 1
                && options[0] === '--source-transition';
            if (options.length && !sourceTransition) {
                showHelp(['stop']);
                break;
            }
            if (sourceTransition) {
                // A detached no-wait worker can own a not-yet-published runtime
                // candidate. Killing that worker would bypass its exact cleanup
                // receipt and can strand a same-name container that no registry
                // record is authorized to remove. Let those bounded startup
                // transactions settle before taking the mutation lease.
                console.log('[stop] Waiting for detached startup workers to settle...');
                await waitForNoWaitWorkersToSettle();
                const list = await withWorkspaceMutationLease({
                    operation: 'agentlib-source-transition-stop',
                }, async () => {
                    // Close the small race between the stable observation above
                    // and lease acquisition before revoking or stopping anything.
                    assertNoLiveNoWaitWorkers();
                    // Development start reaches this hidden transition before
                    // startWorkspace initializes a brand-new workspace. Create
                    // the coordinated empty sources before inactivation so a
                    // lone selector cannot make initialization look partial.
                    initializeFreshEdgeRoutingSources();
                    inactivateEdgeRoutingGeneration('cli-agentlib-source-transition-stop');
                    console.log('[stop] Stopping RoutingServer...');
                    killRouterIfRunning({ strict: true });
                    console.log('[stop] Removing configured agent runtimes for source transition...');
                    const removed = stopConfiguredAgents({ strict: true, remove: true });
                    assertNoLiveNoWaitWorkers();
                    return removed;
                });
                if (list.length) {
                    console.log('[stop] Removed runtimes:');
                    list.forEach(n => console.log(` - ${n}`));
                }
                console.log(`Removed ${list.length} configured agent runtimes for source transition.`);
                break;
            }
            inactivateEdgeRoutingGeneration('cli-workspace-stop');
            console.log('[stop] Stopping RoutingServer...');
            killRouterIfRunning({ strict: true });
            console.log('[stop] Stopping detached no-wait workers...');
            const noWaitWorkers = await quiesceNoWaitWorkers();
            if (noWaitWorkers.length) {
                console.log('[stop] Stopped detached no-wait workers:');
                noWaitWorkers.forEach((worker) => console.log(` - ${worker.containerName}`));
            }
            console.log('[stop] Stopping configured agent containers...');
            const list = stopConfiguredAgents({ strict: true });
            if (list.length) {
                console.log('[stop] Stopped containers:');
                list.forEach(n => console.log(` - ${n}`));
            }
            assertNoLiveNoWaitWorkers();
            console.log(`Stopped ${list.length} configured agent containers.`);
            break;
        }
        case 'destroy':
            inactivateEdgeRoutingGeneration('cli-workspace-destroy');
            console.log('[destroy] Stopping RoutingServer...');
            killRouterIfRunning();
            console.log('[destroy] Removing all workspace containers...');
            await destroyAll();
            break;
        case 'logs':
            // One parser, resolver, and state machine serve the REPL and the
            // lightweight one-shot entry point in cli/index.js.
            return runLogCommand(['logs', ...options], { signal: activeForegroundSignal() });
        case 'clean':
            inactivateEdgeRoutingGeneration('cli-workspace-clean');
            console.log('[clean] Removing all workspace containers...');
            await destroyAll();
            break;
        case 'help':
            showHelp(options);
            break;
        case 'cloud':
            console.log('Cloud commands are not available in this build.');
            break;
        case 'client': {
            await new ClientCommands().handleClientCommand(options);
            break;
        }
        case '/settings': {
            await runSettingsMenu({ onEnvChange: resetLlmInvokerCache });
            break;
        }
        case 'settings': {
            await runSettingsMenu({ onEnvChange: resetLlmInvokerCache });
            break;
        }
        case 'set': {
            console.log("Command renamed to '/settings'.");
            break;
        }
        case 'profile': {
            await handleProfileCommand(options);
            break;
        }
        default: {
            if (!isKnownCommand(command)) {
                const handled = await handleSystemCommand(command, options);
                if (!handled) {
                    try {
                        await ensureLlmAgentsLoaded();
                    } catch (error) {
                        debugLog('LLMAgents preload failed:', error?.message || error);
                    }
                    await handleInvalidCommand(command, options, async (suggestedLine) => {
                        const trimmedSuggestion = (suggestedLine || '').trim();
                        if (!trimmedSuggestion) return;
                        const shellMetaPattern = /[|&;<>(){}\[\]`$]/;
                        if (shellMetaPattern.test(trimmedSuggestion)) {
                            console.log(`[LLM] Executing shell command: ${trimmedSuggestion}`);
                            await new Promise((resolve) => {
                                const restoreInput = inputState.prepareForExternalCommand?.() || (() => {});
                                let finished = false;
                                const finish = () => {
                                    if (finished) return;
                                    finished = true;
                                    try {
                                        restoreInput();
                                    } catch (_) {
                                        /* noop */
                                    }
                                    resolve();
                                };
                                let child;
                                try {
                                    child = spawn(process.env.SHELL || 'bash', ['-lc', trimmedSuggestion], { stdio: 'inherit' });
                                } catch (error) {
                                    console.error(`[LLM] Failed to start suggested command: ${error?.message || error}`);
                                    finish();
                                    return;
                                }
                                child.on('exit', (code) => {
                                    if (code && code !== 0) {
                                        console.error(`[LLM] Command exited with code ${code}`);
                                    }
                                    finish();
                                });
                                child.on('error', (error) => {
                                    console.error(`[LLM] Failed to run suggested command: ${error?.message || error}`);
                                    finish();
                                });
                            });
                            return;
                        }
                        const argsToRun = trimmedSuggestion.split(/\s+/).filter(Boolean);
                        if (!argsToRun.length) return;
                        await handleCommand(argsToRun);
                    });
                }
            } else {
                console.log(`Command '${command}' is currently not supported by this build. Type help to see available options.`);
            }
            break;
        }
    }
}

function disableAllAgents() {
    const agentsMap = workspaceSvc.loadAgents();
    const enabledAgents = Object.entries(agentsMap || {})
        .filter(([containerName, record]) => containerName !== '_config' && record && record.type === 'agent');

    if (!enabledAgents.length) {
        console.log('No enabled agents found in this workspace.');
        return;
    }

    const summary = {
        removed: 0,
        notFound: 0,
        ambiguous: 0,
        staticRemoved: 0,
        unchanged: 0,
        failed: 0,
    };

    for (const [containerName] of enabledAgents) {
        try {
            const result = agentsSvc.disableAgent(containerName);
            switch (result?.status) {
                case 'removed':
                    summary.removed += 1;
                    break;
                case 'not-found':
                    summary.notFound += 1;
                    break;
                case 'ambiguous':
                    summary.ambiguous += 1;
                    break;
                case 'static-removed':
                    summary.staticRemoved += 1;
                    break;
                default:
                    summary.unchanged += 1;
                    break;
            }
        } catch (error) {
            summary.failed += 1;
            console.error(`- Failed to disable '${containerName}': ${error?.message || error}`);
        }
    }

    console.log(`Disable agents-all summary: removed=${summary.removed}, not-found=${summary.notFound}, ambiguous=${summary.ambiguous}, static-removed=${summary.staticRemoved}, unchanged=${summary.unchanged}, failed=${summary.failed}`);
}

export {
    handleCommand,
    getAgentNames,
    getRepoNames,
    findAgentManifest,
    installRepo,
    addRepo,
    uninstallRepo,
    listAgents,
    listRepos,
    listCurrentAgents,
    shutdownSession,
    cleanupSessionContainers,
    destroyAll
};
