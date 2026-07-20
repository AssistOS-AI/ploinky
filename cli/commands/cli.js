import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { debugLog, findAgent } from '../utils/utils.js';
import { isKnownCommand } from './commandRegistry.js';
import { showHelp } from './help.js';
import * as envSvc from '../utils/security/secretVars.js';
import * as agentsSvc from '../utils/agents.js';
import { listRepos, listAgents, listCurrentAgents, listRoutes, statusWorkspace } from '../utils/status.js';
import { logsTail, showLast } from './logUtils.js';
import { startWorkspace, runCli, runShell, reinstallAgent } from './workspaceUtil.js';
import { withMaintenanceLock } from '../utils/runtime/maintenanceLocks.js';
import { refreshComponentToken, ensureComponentToken } from '../server/utils/routerEnv.js';
import {
    getAgentContainerName,
    getRuntime,
    containerExists,
    isContainerRunning,
    parseManifestPorts,
    resolveHostPortFromRuntime,
    stopConfiguredAgents,
    destroyWorkspaceContainers,
    ensureAgentService
} from '../sandbox/docker/index.js';
import { getRuntimeForAgent, isSandboxRuntime } from '../sandbox/docker/common.js';
import { isBwrapProcessRunning, stopBwrapProcess } from '../sandbox/bwrap/bwrapFleet.js';
import * as workspaceSvc from '../utils/workspace.js';
import { handleSystemCommand, handleInvalidCommand, resetLlmInvokerCache } from './llmSystemCommands.js';
import * as inputState from './inputState.js';
import {
    getRepoNames,
    getAgentNames,
    installRepo,
    addRepo,
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
import { ROUTING_FILE } from '../utils/config.js';
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
import { getActiveProfile, getProfileConfig } from '../utils/runtime/profileService.js';
import { resolveProfileServer } from '../utils/runtime/profileServer.js';

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
    if (String(tokens[0] || '').toLowerCase() === 'repo') {
        tokens.shift();
    }
    const url = tokens[0];
    const name = tokens[1] || null;
    if (!branch && tokens[2]) branch = tokens[2];
    return { url, name, branch };
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




async function handleCommand(args) {
    const [command, ...options] = args;
    switch (command) {
        case 'shell':
            if (!options[0]) { showHelp(); break; }
            await runShell(options[0]);
            break;
        case 'cli':
            if (!options[0]) { showHelp(); break; }
            await runCli(options[0], options.slice(1));
            break;
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
            if (options[0] === 'agent') {
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
            // The global --branch also drives the achillesAgentLib used by agent
            // containers (best-effort: the branch when the achillesAgentLib remote
            // has it, else the pinned #master). Propagated via PLOINKY_AGENTLIB_REF,
            // read host-side by readGlobalDepsPackage and inherited by the
            // Watchdog/router via buildRouterEnv.
            const agentlibRef = resolveAgentlibBranchRef(startParsed.branchPolicy);
            if (agentlibRef) {
                process.env.PLOINKY_AGENTLIB_REF = agentlibRef;
            }
            await startWorkspace(startParsed.staticAgent, startParsed.port, {
                refreshComponentToken,
                ensureComponentToken,
                enableAgent,
                killRouterIfRunning,
                branchPolicy: startParsed.branchPolicy,
            });
            break;
        }
        // 'route' and 'probe' commands removed (replaced by start/status and client commands)
        case 'webchat': {
            const argsList = (options || []).filter(Boolean);
            let rotate = false;
            const positional = [];
            for (const arg of argsList) {
                if (String(arg).startsWith('--')) {
                    if (arg === '--rotate') rotate = true;
                } else {
                    positional.push(arg);
                }
            }

            if (rotate) refreshComponentToken('webchat');
            else ensureComponentToken('webchat');

            if (!rotate && positional.length) {
                console.warn('webchat: argument-based configuration has been removed; this command now only prints the access URL.');
            }
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
            const rotate = (options || []).includes('--rotate');
            if (rotate) await refreshComponentToken('dashboard');
            else ensureComponentToken('dashboard');
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
        case 'restart': {
            const target = (options[0] || '').trim();
            if (target && target.toLowerCase() === 'router') {
                const cfg = workspaceSvc.getConfig();
                if (!cfg || !cfg.static || !cfg.static.agent || !cfg.static.port) {
                    console.error('restart router: start is not configured. Run: start <staticAgent> <port> first.');
                    break;
                }
                console.log('[restart] Restarting RoutingServer (containers untouched)...');
                killRouterIfRunning();
                await startWorkspace(undefined, undefined, {
                    refreshComponentToken,
                    ensureComponentToken,
                    enableAgent,
                    killRouterIfRunning: () => { }
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
                try {
                    manifest = JSON.parse(fs.readFileSync(resolved.manifestPath, 'utf8'));
                } catch (err) {
                    console.error(`Failed to read manifest for '${agentName}': ${err?.message || err}`);
                    return;
                }

                const agentRuntime = getRuntimeForAgent(manifest);
                const containerName = registryRecord?.containerName || getAgentContainerName(resolved.shortAgentName, resolved.repo);

                if (isSandboxRuntime(agentRuntime)) {
                    // Sandbox restart: stop process, then re-create via ensureAgentService
                    const bwrapRunning = isBwrapProcessRunning(resolved.shortAgentName);
                    const containerAlsoRunning = isContainerRunning(containerName);
                    const containerPresent = containerAlsoRunning || containerExists(containerName) || Boolean(registryRecord?.containerName);
                    if (!bwrapRunning && !containerPresent) {
                        console.error(`Agent '${agentName}' has no existing container. Run 'ploinky reinstall ${agentName}'.`);
                        return;
                    }

                    if (!bwrapRunning && !containerAlsoRunning && containerPresent) {
                        const runtime = getRuntime();
                        console.log(`Starting (${runtime}) agent '${agentName}'...`);
                        try {
                            await withMaintenanceLock(containerName, {
                                operation: 'start',
                                metadata: {
                                    agent: resolved.shortAgentName,
                                    repo: resolved.repo,
                                },
                            }, async () => {
                                execSync(`${runtime} start ${containerName}`, { stdio: 'inherit' });
                            });
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
                        }, async () => {
                            // Stop existing process (bwrap or container if transitioning)
                            if (bwrapRunning) {
                                stopBwrapProcess(resolved.shortAgentName);
                            }
                            if (containerAlsoRunning) {
                                try {
                                    const { stopAndRemove } = await import('../sandbox/docker/containerFleet.js');
                                    stopAndRemove(containerName);
                                } catch (_) {}
                            }

                            const agentPath = path.dirname(resolved.manifestPath);
                            const { containerName: newContainerName, hostPort, additionalServerPort } = ensureAgentService(resolved.shortAgentName, manifest, agentPath, {
                                containerName,
                                alias: registryRecord?.record?.alias,
                                forceRecreate: true
                            });

                            if (!hostPort) {
                                throw new Error(`Failed to resolve host port for restarted agent '${resolved.shortAgentName}'.`);
                            }

                            try {
                                const routingFile = ROUTING_FILE;
                                let cfg = { routes: {} };
                                try { cfg = JSON.parse(fs.readFileSync(routingFile, 'utf8')) || { routes: {} }; } catch (_) {}
                                cfg.routes = cfg.routes || {};
                                const repoName = registryRecord?.record?.repoName || resolved.repo;
                                const routeKey = registryRecord?.record?.alias || resolved.shortAgentName;
                                cfg.routes[routeKey] = cfg.routes[routeKey] || {};
                                cfg.routes[routeKey].container = newContainerName;
                                cfg.routes[routeKey].hostPath = agentPath;
                                cfg.routes[routeKey].repo = repoName;
                                cfg.routes[routeKey].agent = resolved.shortAgentName;
                                if (registryRecord?.record?.alias) cfg.routes[routeKey].alias = registryRecord.record.alias;
                                cfg.routes[routeKey].hostPort = hostPort;
                                if (additionalServerPort) {
                                    cfg.routes[routeKey].additionalServerPort = additionalServerPort;
                                } else {
                                    delete cfg.routes[routeKey].additionalServerPort;
                                }

                                const staticAgent = String(cfg.static?.agent || '').trim();
                                if (staticAgent) {
                                    const matches = new Set([resolved.shortAgentName, `${repoName}/${resolved.shortAgentName}`, `${repoName}:${resolved.shortAgentName}`]);
                                    if (registryRecord?.record?.alias) {
                                        matches.add(registryRecord.record.alias);
                                    }
                                    if (matches.has(staticAgent)) {
                                        cfg.static.container = newContainerName;
                                    }
                                }

                                fs.writeFileSync(routingFile, JSON.stringify(cfg, null, 2));
                            } catch (routingError) {
                                throw new Error(`routing update failed: ${routingError?.message || routingError}`);
                            }
                        });

                        console.log(`✓ Agent restarted (${agentRuntime}).`);
                    } catch (e) {
                        console.error(`Failed to restart agent '${agentName}' via ${agentRuntime}: ${e.message}`);
                    }
                } else {
                    // Container restart: keep the watchdog from racing a split stop/start.
                    const runtime = getRuntime();
                    const containerRunning = isContainerRunning(containerName);
                    const containerPresent = containerRunning || containerExists(containerName) || Boolean(registryRecord?.containerName);
                    if (!containerPresent) {
                        console.error(`Agent '${agentName}' has no existing container. Run 'ploinky reinstall ${agentName}'.`);
                        return;
                    }

                    const runtimeAction = containerRunning ? 'restart' : 'start';
                    console.log(`${containerRunning ? 'Restarting' : 'Starting'} (${runtime}) agent '${agentName}'...`);
                    try {
                        await withMaintenanceLock(containerName, {
                            operation: runtimeAction,
                            metadata: {
                                agent: resolved.shortAgentName,
                                repo: resolved.repo,
                            },
                        }, async () => {
                            execSync(`${runtime} ${runtimeAction} ${containerName}`, { stdio: 'inherit' });
                            try {
                                const { portMappings } = parseManifestPorts(manifest);
                                const containerPortCandidates = portMappings
                                    .map((mapping) => mapping?.containerPort)
                                    .filter((port) => typeof port === 'number' && port > 0);
                                if (!containerPortCandidates.includes(7000)) {
                                    containerPortCandidates.push(7000);
                                }
                                const hostPort = resolveHostPortFromRuntime(containerName, containerPortCandidates);
                                if (hostPort) {
                                    let cfg = { routes: {} };
                                    try { cfg = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) || { routes: {} }; } catch (_) {}
                                    cfg.routes = cfg.routes || {};
                                    const repoName = registryRecord?.record?.repoName || resolved.repo;
                                    const routeKey = registryRecord?.record?.alias || resolved.shortAgentName;
                                    cfg.routes[routeKey] = cfg.routes[routeKey] || {};
                                    cfg.routes[routeKey].container = containerName;
                                    cfg.routes[routeKey].hostPath = path.dirname(resolved.manifestPath);
                                    cfg.routes[routeKey].repo = repoName;
                                    cfg.routes[routeKey].agent = resolved.shortAgentName;
                                    if (registryRecord?.record?.alias) cfg.routes[routeKey].alias = registryRecord.record.alias;
                                    cfg.routes[routeKey].hostPort = hostPort;
                                    const activeProfile = getActiveProfile();
                                    const profileConfig = getProfileConfig(`${repoName}/${resolved.shortAgentName}`, activeProfile);
                                    const additionalServerPort = resolveProfileServer(manifest, profileConfig, { runtimeMode: 'container' });
                                    if (additionalServerPort) {
                                        cfg.routes[routeKey].additionalServerPort = additionalServerPort;
                                    } else {
                                        delete cfg.routes[routeKey].additionalServerPort;
                                    }

                                    const staticAgent = String(cfg.static?.agent || '').trim();
                                    if (staticAgent) {
                                        const matches = new Set([resolved.shortAgentName, `${repoName}/${resolved.shortAgentName}`, `${repoName}:${resolved.shortAgentName}`]);
                                        if (registryRecord?.record?.alias) {
                                            matches.add(registryRecord.record.alias);
                                        }
                                        if (matches.has(staticAgent)) {
                                            cfg.static.container = containerName;
                                        }
                                    }

                                    fs.writeFileSync(ROUTING_FILE, JSON.stringify(cfg, null, 2));
                                }
                            } catch (routeError) {
                                console.warn(`[restart] Agent '${agentName}' restarted, but routing update failed: ${routeError?.message || routeError}`);
                            }
                        });
                        console.log(`✓ Agent ${containerRunning ? 'restarted' : 'started'}.`);
                    } catch (e) {
                        console.error(`Failed to ${runtimeAction} container ${containerName}: ${e.message}`);
                    }
                }
            } else {
                const cfg = workspaceSvc.getConfig();
                if (!cfg || !cfg.static || !cfg.static.agent || !cfg.static.port) { console.error('restart: start is not configured. Run: start <staticAgent> <port>'); break; }
                console.log('[restart] Stopping Router and configured agents...');
                killRouterIfRunning();
                console.log('[restart] Stopping configured agent containers...');
                const list = stopConfiguredAgents();
                if (list.length) { console.log('[restart] Stopped containers:'); list.forEach(n => console.log(` - ${n}`)); }
                else { console.log('[restart] No containers to stop.'); }
                console.log('[restart] Starting workspace...');
                await startWorkspace(undefined, undefined, { refreshComponentToken, ensureComponentToken, enableAgent, killRouterIfRunning });
                console.log('[restart] Done.');
            }
            break;
        }
        case 'delete':
            showHelp();
            break;
        case 'shutdown': {
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
            if (options.length) {
                showHelp(['stop']);
                break;
            }
            console.log('[stop] Stopping RoutingServer...');
            killRouterIfRunning();
            console.log('[stop] Stopping configured agent containers...');
            const list = stopConfiguredAgents();
            if (list.length) {
                console.log('[stop] Stopped containers:');
                list.forEach(n => console.log(` - ${n}`));
            }
            console.log(`Stopped ${list.length} configured agent containers.`);
            break;
        }
        case 'destroy':
            console.log('[destroy] Stopping RoutingServer...');
            killRouterIfRunning();
            console.log('[destroy] Removing all workspace containers...');
            await destroyAll();
            break;
        case 'logs': {
            const sub = options[0];
            if (sub === 'tail') {
                const kind = options[1] || 'router';
                if (kind !== 'router') { console.log('Only router logs are available.'); break; }
                await logsTail('router');
            } else if (sub === 'last') {
                const count = options[1] || '200';
                const kind = options[2];
                if (kind && kind !== 'router') { console.log('Only router logs are available.'); break; }
                showLast(count, 'router');
            } else { console.log("Usage: logs tail [router] | logs last <count>"); }
            break;
        }
        case 'clean':
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
