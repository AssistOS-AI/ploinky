import fs from 'fs';
import { execSync, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getExposedNames, getManifestEnvNames, formatEnvFlag } from '../secretVars.js';
import { debugLog } from '../utils.js';
import { getActiveProfile, getProfileConfig } from '../profileService.js';
import {
    CONTAINER_CONFIG_PATH,
    PLOINKY_MANAGED_LABEL,
    containerExists,
    getAgentContainerName,
    getConfiguredProjectPath,
    getRuntime,
    getSecretsForAgent,
    isContainerRunning,
    loadAgentsMap,
    parseManifestPorts,
    saveAgentsMap,
    syncAgentMcpConfig,
    computeEnvHash,
    getContainerLabel,
    REPOS_DIR,
    waitForContainerRunning
} from './common.js';
import { loadAgents } from '../workspace.js';
import { getAgentWorkDir } from '../workspaceStructure.js';
import { SHARED_DIR } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureSharedHostDir() {
    const dir = SHARED_DIR;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
}

function joinShellCommandParts(parts) {
    return parts.filter((part) => String(part || '').trim()).join(' ');
}

function buildInteractiveCommandCreateCommand({
    runtime,
    containerName,
    mountOption = '',
    portOptions = '',
    envVars = '',
    containerImage,
} = {}) {
    return joinShellCommandParts([
        runtime,
        'create',
        '-it',
        '--name',
        containerName,
        '--label',
        PLOINKY_MANAGED_LABEL,
        mountOption,
        portOptions,
        envVars,
        containerImage,
        '/bin/sh -lc "while :; do sleep 3600; done"',
    ]);
}

function buildInteractiveAgentCreateCommand({
    runtime,
    containerName,
    envHash,
    projectDir,
    homeDir,
    agentLibPath,
    absAgentPath,
    sharedDir,
    volumeSuffix = '',
    readOnlySuffix = ':ro',
    portOptions = '',
    envVars = '',
    containerImage,
} = {}) {
    return joinShellCommandParts([
        runtime,
        'create',
        '-it',
        '--name',
        containerName,
        '--label',
        PLOINKY_MANAGED_LABEL,
        '--label',
        `ploinky.envhash=${envHash}`,
        `-v "${projectDir}:${projectDir}${volumeSuffix}"`,
        path.resolve(projectDir) === path.resolve(homeDir)
            ? ''
            : `-v "${homeDir}:/root${volumeSuffix}"`,
        `-v "${agentLibPath}:/Agent${readOnlySuffix}"`,
        `-v "${absAgentPath}:/code${readOnlySuffix}"`,
        `-v "${sharedDir}:/shared${volumeSuffix}"`,
        portOptions,
        envVars,
        containerImage,
        '/bin/sh -lc "while :; do sleep 3600; done"',
    ]);
}

function runCommandInContainer(agentName, repoName, manifest, command, interactive = false) {
    const runtime = getRuntime();
    const containerName = getAgentContainerName(agentName, repoName);
    let agents = loadAgentsMap();
    const projectDir = getConfiguredProjectPath(agentName, repoName);
    const homeDir = getAgentWorkDir(agentName);

    const sharedDir = ensureSharedHostDir();
    try { fs.mkdirSync(homeDir, { recursive: true }); } catch (_) {}

    let firstRun = false;
    debugLog(`Checking if container '${containerName}' exists...`);
    if (!containerExists(containerName)) {
        console.log(`Creating container '${containerName}' for agent '${agentName}'...`);
        const envVarParts = [
            ...getSecretsForAgent(manifest, { agentName, repoName }),
            formatEnvFlag('PLOINKY_MCP_CONFIG_PATH', CONTAINER_CONFIG_PATH),
            formatEnvFlag('HOME', '/root'),
            // Set NODE_PATH to project directory node_modules (in the passthrough mount)
            formatEnvFlag('NODE_PATH', `${projectDir}/node_modules`)
        ];
        const envVars = envVarParts.join(' ');
        const mountOptions = runtime === 'podman'
            ? [
                `--mount type=bind,source="${projectDir}",destination="${projectDir}",relabel=shared`,
                ...(path.resolve(projectDir) === path.resolve(homeDir) ? [] : [
                    `--mount type=bind,source="${homeDir}",destination="/root",relabel=shared`
                ]),
                `--mount type=bind,source="${sharedDir}",destination="/shared",relabel=shared`
            ]
            : [
                `-v "${projectDir}:${projectDir}"`,
                ...(path.resolve(projectDir) === path.resolve(homeDir) ? [] : [
                    `-v "${homeDir}:/root"`
                ]),
                `-v "${sharedDir}:/shared"`
            ];
        const mountOption = mountOptions.join(' ');

        const { publishArgs: manifestPorts, portMappings } = parseManifestPorts(manifest);
        const portOptions = manifestPorts.map(p => `-p ${p}`).join(' ');

        let containerImage = manifest.container;
        let createOutput;
        let containerId;

        try {
            const createCommand = buildInteractiveCommandCreateCommand({
                runtime,
                containerName,
                mountOption,
                portOptions,
                envVars,
                containerImage,
            });
            debugLog(`Executing create command: ${createCommand}`);
            createOutput = execSync(createCommand, { stdio: ['pipe', 'pipe', 'inherit'] }).toString().trim();
            containerId = createOutput;
        } catch (error) {
            if (runtime === 'podman' && error.message.includes('short-name')) {
                debugLog(`Short-name resolution failed, trying with docker.io prefix...`);

                if (!containerImage.includes('/')) {
                    containerImage = `docker.io/library/${containerImage}`;
                } else if (!containerImage.startsWith('docker.io/') && !containerImage.includes('.')) {
                    containerImage = `docker.io/${containerImage}`;
                }

                console.log(`Retrying with full registry name: ${containerImage}`);
                const retryCommand = buildInteractiveCommandCreateCommand({
                    runtime,
                    containerName,
                    mountOption,
                    portOptions,
                    envVars,
                    containerImage,
                });
                debugLog(`Executing retry command: ${retryCommand}`);

                try {
                    createOutput = execSync(retryCommand, { stdio: ['pipe', 'pipe', 'inherit'] }).toString().trim();
                    containerId = createOutput;
                    manifest.container = containerImage;
                } catch (retryError) {
                    console.error(`Failed to create container even with full registry name.`);
                    throw retryError;
                }
            } else {
                throw error;
            }
        }

        const declaredEnvNames = [
            ...getManifestEnvNames(manifest, null, { forRuntime: true }),
            ...getExposedNames(manifest, null, { forRuntime: true })
        ];
        agents[containerName] = {
            agentName,
            repoName,
            containerId,
            containerImage,
            createdAt: new Date().toISOString(),
            projectPath: projectDir,
            type: 'interactive',
            config: {
                binds: [
                    { source: projectDir, target: projectDir },
                    ...(path.resolve(projectDir) === path.resolve(homeDir) ? [] : [{ source: homeDir, target: '/root' }]),
                    { source: sharedDir, target: '/shared' }
                ],
                env: Array.from(new Set(declaredEnvNames)).map(name => ({ name })),
                ports: portMappings
            }
        };
        saveAgentsMap(agents);
        debugLog(`Updated agents file with container ID: ${containerId}`);
        firstRun = true;
    }

    if (!isContainerRunning(containerName)) {
        try {
            const stateCommand = `${runtime} ps -a --format "{{.Names}}\t{{.Status}}" | grep "^${containerName}"`;
            const stateResult = execSync(stateCommand, { stdio: 'pipe' }).toString().trim();
            debugLog(`Container state: ${stateResult}`);

            if (stateResult.includes('Exited')) {
                debugLog(`Container is in Exited state, starting it...`);
            } else if (stateResult && !stateResult.includes('Up')) {
                debugLog(`Container is in unexpected state, attempting to stop first...`);
                try {
                    execSync(`${runtime} stop ${containerName}`, { stdio: 'pipe' });
                } catch (e) {
                    debugLog(`Could not stop container: ${e.message}`);
                }
            }
        } catch (e) {
            debugLog(`Could not check container state: ${e.message}`);
        }

        const startCommand = `${runtime} start ${containerName}`;
        debugLog(`Executing start command: ${startCommand}`);
        try {
            execSync(startCommand, { stdio: 'inherit' });
        } catch (error) {
            console.error(`Error starting container. Try removing it with: ${runtime} rm ${containerName}`);
            throw error;
        }
    }

    if (firstRun && manifest.install) {
        const ready = waitForContainerRunning(containerName);
        if (!ready) {
            console.warn(`[install] ${agentName}: container not running after creation; skipping install.`);
        } else {
            console.log(`[install] ${agentName}: cd '${projectDir}' && ${manifest.install}`);
            const installCommand = `${runtime} exec ${interactive ? '-it' : ''} ${containerName} sh -lc "cd '${projectDir}' && ${manifest.install}"`;
            debugLog(`Executing install command: ${installCommand}`);
            execSync(installCommand, { stdio: 'inherit' });
        }
    }

    console.log(`Running command in '${agentName}': ${command}`);
    let bashCommand;
    let envVars = '';

    if (interactive && command === '/bin/sh') {
        bashCommand = `cd '${projectDir}' && exec sh`;
    } else {
        bashCommand = `cd '${projectDir}' && ${command}`;
    }

    const execCommand = `${runtime} exec ${interactive ? '-it' : ''} ${envVars} ${containerName} sh -lc "${bashCommand}"`;
    debugLog(`Executing run command: ${execCommand}`);

    if (interactive) {
        console.log(`[Ploinky] Attaching to container '${containerName}' (interactive TTY).`);
        console.log(`[Ploinky] Working directory in container: ${projectDir}`);
        console.log(`[Ploinky] Exit the program or shell to return to the Ploinky prompt.`);
        const args = ['exec'];
        if (interactive) args.push('-it');
        if (envVars) args.push(...envVars.split(' '));
        args.push(containerName, 'sh', '-lc', bashCommand);

        debugLog(`Running interactive session with args: ${args.join(' ')}`);

        const result = spawnSync(runtime, args, {
            stdio: 'inherit',
            shell: false
        });

        debugLog(`Container session ended with code ${result.status}`);
        console.log(`[Ploinky] Detached from container '${containerName}'. Exit code: ${result.status ?? 'unknown'}`);
    } else {
        const t0 = Date.now();
        let code = 0;
        try {
            execSync(execCommand, { stdio: 'inherit' });
        } catch (error) {
            code = (error && typeof error.status === 'number') ? error.status : 1;
            debugLog(`Caught error during ${runtime} exec. Exit code: ${code}`);
        } finally {
            const dt = Date.now() - t0;
            console.log(`[Ploinky] Command finished in ${dt} ms with exit code ${code}.`);
        }
    }
}

function ensureAgentContainer(agentName, repoName, manifest) {
    const runtime = getRuntime();
    const containerName = getAgentContainerName(agentName, repoName);
    const projectDir = getConfiguredProjectPath(agentName, repoName);
    const homeDir = getAgentWorkDir(agentName);
    const agentLibPath = path.resolve(__dirname, '../../../Agent');
    const agentPath = path.join(REPOS_DIR, repoName, agentName);
    const absAgentPath = path.resolve(agentPath);
    const sharedDir = ensureSharedHostDir();
    try { fs.mkdirSync(homeDir, { recursive: true }); } catch (_) {}
    let agents = loadAgentsMap();

    // Resolve profile config for env hash computation
    const activeProfile = getActiveProfile();
    const hasProfileConfig = Boolean(manifest?.profiles && Object.keys(manifest.profiles).length > 0);
    const profileConfig = hasProfileConfig
        ? getProfileConfig(`${repoName}/${agentName}`, activeProfile)
        : null;

    if (containerExists(containerName)) {
        const desired = computeEnvHash(manifest, profileConfig, {}, { agentName, repoName });
        const current = getContainerLabel(containerName, 'ploinky.envhash');
        if (desired && desired !== current) {
            try { execSync(`${runtime} rm -f ${containerName}`, { stdio: 'ignore' }); } catch (_) {}
        }
    }
    let createdNew = false;
    if (!containerExists(containerName)) {
        console.log(`Creating container '${containerName}' for agent '${agentName}'...`);
        const envVarParts = [
            ...getSecretsForAgent(manifest, { agentName, repoName }),
            formatEnvFlag('HOME', '/root'),
            // Set NODE_PATH to project directory node_modules (in the passthrough mount)
            formatEnvFlag('NODE_PATH', `${projectDir}/node_modules`)
        ];
        const envVars = envVarParts.join(' ');
        const volZ = (runtime === 'podman') ? ':z' : '';
        const roOpt = (runtime === 'podman') ? ':ro,z' : ':ro';
        let containerImage = manifest.container;
        const envHash = computeEnvHash(manifest, profileConfig, {}, { agentName, repoName });
        const { publishArgs: manifestPorts, portMappings } = parseManifestPorts(manifest);
        const portOptions = manifestPorts.map(p => `-p ${p}`).join(' ');
        try {
            const createCommand = buildInteractiveAgentCreateCommand({
                runtime,
                containerName,
                envHash,
                projectDir,
                homeDir,
                agentLibPath,
                absAgentPath,
                sharedDir,
                volumeSuffix: volZ,
                readOnlySuffix: roOpt,
                portOptions,
                envVars,
                containerImage,
            });
            debugLog(`Executing create command: ${createCommand}`);
            execSync(createCommand, { stdio: ['pipe', 'pipe', 'inherit'] });
            createdNew = true;
        } catch (error) {
            if (runtime === 'podman' && String(error.message || '').includes('short-name')) {
                if (!containerImage.includes('/')) containerImage = `docker.io/library/${containerImage}`;
                else if (!containerImage.startsWith('docker.io/') && !containerImage.includes('.')) containerImage = `docker.io/${containerImage}`;
                console.log(`Retrying with full registry name: ${containerImage}`);
                const retryCommand = buildInteractiveAgentCreateCommand({
                    runtime,
                    containerName,
                    envHash,
                    projectDir,
                    homeDir,
                    agentLibPath,
                    absAgentPath,
                    sharedDir,
                    volumeSuffix: volZ,
                    readOnlySuffix: roOpt,
                    portOptions,
                    envVars,
                    containerImage,
                });
                debugLog(`Executing retry command: ${retryCommand}`);
                execSync(retryCommand, { stdio: ['pipe', 'pipe', 'inherit'] });
                manifest.container = containerImage;
                createdNew = true;
            } else {
                console.error('[docker.ensureAgentContainer] create failed:', error.message || error);
                throw error;
            }
        }
        const declaredEnvNamesX = [
            ...getManifestEnvNames(manifest, null, { forRuntime: true }),
            ...getExposedNames(manifest, null, { forRuntime: true })
        ];
        agents[containerName] = {
            agentName,
            repoName,
            containerImage,
            createdAt: new Date().toISOString(),
            projectPath: projectDir,
            type: 'interactive',
            config: {
                binds: [
                    { source: projectDir, target: projectDir },
                    ...(path.resolve(projectDir) === path.resolve(homeDir) ? [] : [{ source: homeDir, target: '/root' }]),
                    { source: agentLibPath, target: '/Agent', ro: true },
                    { source: absAgentPath, target: '/code', ro: true },
                    { source: sharedDir, target: '/shared' }
                ],
                env: Array.from(new Set(declaredEnvNamesX)).map(name => ({ name })),
                ports: portMappings
            }
        };
        saveAgentsMap(agents);
    }
    if (!isContainerRunning(containerName)) {
        const startCommand = `${runtime} start ${containerName}`;
        debugLog(`Executing start command: ${startCommand}`);
        try { execSync(startCommand, { stdio: 'inherit' }); }
        catch (e) { console.error('[docker.ensureAgentContainer] start failed:', e.message || e); throw e; }
    }
    syncAgentMcpConfig(containerName, absAgentPath);
    try {
        if (createdNew && manifest.install && String(manifest.install).trim()) {
            const ready = waitForContainerRunning(containerName);
            if (!ready) {
                console.warn(`[install] ${agentName}: container not running after creation; skipping install.`);
            } else {
                console.log(`[install] ${agentName}: cd '${projectDir}' && ${manifest.install}`);
                const installCommand = `${runtime} exec ${containerName} sh -lc "cd '${projectDir}' && ${manifest.install}"`;
                debugLog(`Executing install command: ${installCommand}`);
                execSync(installCommand, { stdio: 'inherit' });
            }
        }
    } catch (e) {
        console.log(`[install] ${agentName}: ${e?.message || e}`);
    }
    return containerName;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sanitizeHistoryName(value) {
    return String(value || 'agent').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function buildInteractiveShellCommand(entryCommand, allocateTty) {
    const rawCommand = entryCommand && String(entryCommand).trim()
        ? String(entryCommand).trim()
        : 'exec /bin/bash || exec /bin/sh';
    if (allocateTty && rawCommand === '/bin/sh') {
        return "export PS1='# '; if command -v /bin/bash >/dev/null 2>&1; then exec /bin/bash --noprofile --norc -i; else exec /bin/sh -i; fi";
    }
    return rawCommand;
}

function buildTerminalEnvArgs(env = process.env, historyName = '') {
    const args = [];
    for (const key of ['TERM', 'COLORTERM', 'LINES', 'COLUMNS']) {
        if (env[key]) args.push('-e', `${key}=${env[key]}`);
    }
    if (historyName) {
        args.push(
            '-e', `HISTFILE=/shared/.ploinky-${sanitizeHistoryName(historyName)}-shell-history`,
            '-e', 'HISTSIZE=5000',
            '-e', 'HISTFILESIZE=10000'
        );
    }
    return args;
}

function buildExecArgs(containerName, workdir, entryCommand, interactive = true, allocateTty = true, options = {}) {
    const wd = workdir || process.cwd();
    const cmd = buildInteractiveShellCommand(entryCommand, allocateTty);
    const args = ['exec'];
    if (interactive && allocateTty) {
        args.push('-it');  // Full interactive with TTY (for direct terminal use)
        const historyName = Object.prototype.hasOwnProperty.call(options, 'historyName') ? options.historyName : containerName;
        args.push(...buildTerminalEnvArgs(options.env || process.env, historyName));
    } else if (interactive) {
        args.push('-i');   // Interactive stdin only, no TTY (for webchat - ensures stdin EOF propagates)
    }
    args.push(containerName, 'sh', '-lc', `cd ${shellQuote(wd)} && ${cmd}`);
    return args;
}

function resolveContainerWorkdir(containerName, workdir) {
    try {
        const record = loadAgents()?.[containerName];
        if (record?.runMode === 'isolated' && record.projectPath && path.resolve(record.projectPath) === path.resolve(workdir)) {
            return '/root';
        }
    } catch (_) {}
    return workdir;
}

function attachInteractive(containerName, workdir, entryCommand) {
    const runtime = getRuntime();
    // PLOINKY_NO_TTY=1 disables TTY allocation (used by webchat to ensure stdin EOF propagates)
    const allocateTty = process.env.PLOINKY_NO_TTY !== '1';
    const containerWorkdir = resolveContainerWorkdir(containerName, workdir);
    const execArgs = buildExecArgs(containerName, containerWorkdir, entryCommand, true, allocateTty, { historyName: containerName });
    const result = spawnSync(runtime, execArgs, { stdio: 'inherit' });
    return result.status ?? 0;
}

export {
    attachInteractive,
    buildExecArgs,
    buildInteractiveAgentCreateCommand,
    buildInteractiveCommandCreateCommand,
    ensureAgentContainer,
    runCommandInContainer
};
