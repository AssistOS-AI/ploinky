import fs from 'fs';
import os from 'os';
import { configCache } from './configCache.js';
import { logBootEvent } from './logger.js';
import { getAppName } from '../authHandlers/index.js';
import { resolveWebchatCommands, resolveWebchatCommandsAsync } from '../webchat/commandResolver.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';

function tryGetCwd() {
    try {
        return process.cwd();
    } catch (_) {
        return '';
    }
}

function resolveSafeHostWorkdir(preferred = '') {
    const candidates = [
        preferred,
        tryGetCwd(),
        process.env.PWD || '',
        os.homedir(),
        '/',
    ];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (_) { }
    }
    return '/';
}

/**
 * Load a TTY module relative to this file
 */
async function loadTTYModule(relativePath) {
    const mod = await import(new URL(relativePath, import.meta.url));
    return mod.default || mod;
}

/**
 * Load all TTY modules
 */
async function loadTTYModules() {
    let webchatTTYModule = {};
    try {
        webchatTTYModule = await loadTTYModule('../webchat/tty.js');
    } catch (_) {
        console.warn('WebChat TTY factory unavailable.');
    }
    return { webchatTTYModule };
}

/**
 * Build a local TTY factory with defaults
 */
function buildLocalFactory(createFactoryFn, defaults = {}, { verifiedWorkdir = false } = {}) {
    if (!createFactoryFn) return null;
    const safeWorkdir = verifiedWorkdir ? defaults.workdir : resolveSafeHostWorkdir(defaults.workdir);
    return createFactoryFn({ ...defaults, workdir: safeWorkdir });
}

/**
 * Create WebChat factory configuration
 */
function createWebchatFactoryConfig(webchatTTYModule, resolvedWebchatCommands) {
    const {
        createTTYFactory: createWebChatTTYFactory,
        createLocalTTYFactory: createWebChatLocalFactory
    } = webchatTTYModule;

    const buildCacheKey = (commands) => commands?.cacheKey || (commands?.agentName ? `webchat:${commands.agentName}` : 'webchat');
    const buildConfig = (commands) => ({
        hostCommand: commands?.host || '',
        containerCommand: commands?.container || '',
        source: commands?.source || 'unset',
        agentName: commands?.agentName || '',
        forwardEnvelope: commands?.forwardEnvelope === true,
        runtimeScope: commands?.runtimeScope === 'principal' ? 'principal' : 'shared',
        unsupportedReason: commands?.unsupportedReason || ''
    });
    const resolveHostWorkdir = (config) => {
        // webchat hostCommand runs the direct execution-plane CLI for an agent.
        // That command must run from the *workspace root* so it sees the correct
        // `.ploinky/` state (installed repos, enabled agents). If it runs from
        // `agents/<name>/`, Ploinky bootstraps a new `.ploinky/` and then fails
        // with: "Agent '<name>' not found".
        return resolveSafeHostWorkdir(PLOINKY_WORKSPACE_ROOT);
    };

    const buildFactoryResult = (config, { workspaceRoot = '' } = {}) => {
        // Request callers pass the root already confined by the async preamble.
        const hostWorkdir = workspaceRoot || resolveHostWorkdir(config);
        if (createWebChatLocalFactory) {
            const command = config.hostCommand;
            const factory = buildLocalFactory(createWebChatLocalFactory, {
                command,
                workdir: hostWorkdir,
                startupProtocol: Boolean(command),
            }, { verifiedWorkdir: Boolean(workspaceRoot) });
            if (factory) {
                logBootEvent('webchat_local_process_factory_ready', {
                    command: command || null,
                    source: config.source
                });
            }
            return {
                factory,
                label: command ? command : 'local shell',
                runtime: 'local',
                agentName: config.agentName || '',
                forwardEnvelope: config.forwardEnvelope === true,
                runtimeScope: config.runtimeScope,
                unavailableReason: ''
            };
        }
        if (createWebChatTTYFactory) {
            const entry = config.containerCommand;
            const containerLabel = config.agentName || 'webchat_agent';
            const factory = createWebChatTTYFactory({
                runtime: 'docker',
                containerName: containerLabel,
                entry,
                workdir: '/code',
            });
            logBootEvent('webchat_container_factory_ready', {
                containerName: containerLabel,
                command: entry || null,
                source: config.source
            });
            return {
                factory,
                label: containerLabel,
                runtime: 'docker',
                agentName: config.agentName || '',
                forwardEnvelope: config.forwardEnvelope === true,
                runtimeScope: config.runtimeScope,
                unavailableReason: ''
            };
        }
        logBootEvent('webchat_factory_disabled', { reason: 'no_factory_available' });
        return { factory: null, label: '-', runtime: 'disabled', agentName: config.agentName || '', unavailableReason: '' };
    };

    const getFactory = (commandsOverride = null, options = {}) => {
        let commands = commandsOverride || resolvedWebchatCommands;
        if (!commandsOverride && (!commands || (!commands.host && !commands.container && !commands.agentName))) {
            commands = resolveWebchatCommands();
        }
        if (!commands) {
            return { factory: null, label: '-', runtime: 'disabled', agentName: '' };
        }
        const cacheKey = buildCacheKey(commands);
        return configCache.getOrCreate(
            cacheKey,
            () => buildConfig(commands),
            config => buildFactoryResult(config, options)
        );
    };
    getFactory.resolveCommandsForRequest = async () => {
        if (!resolvedWebchatCommands
            || (!resolvedWebchatCommands.host && !resolvedWebchatCommands.container && !resolvedWebchatCommands.agentName)) {
            return resolveWebchatCommandsAsync();
        }
        return resolvedWebchatCommands;
    };
    return getFactory;
}

/**
 * Initialize TTY factories and return configuration
 */
async function initializeTTYFactories() {
    // Load TTY modules
    const { webchatTTYModule } = await loadTTYModules();

    // Resolve webchat commands
    const resolvedWebchatCommands = resolveWebchatCommands();
    if (resolvedWebchatCommands.source === 'manifest' && resolvedWebchatCommands.agentName) {
        logBootEvent('webchat_manifest_cli_fallback', { agent: resolvedWebchatCommands.agentName });
    }

    // Create factory configurations
    const getWebchatFactory = createWebchatFactoryConfig(webchatTTYModule, resolvedWebchatCommands);

    return {
        getWebchatFactory,
    };
}

/**
 * Create service configuration object
 */
function createServiceConfig(getWebchatFactory) {
    const appName = getAppName();

    const wrapWebchatFactory = (factoryResult, factoryOptions = {}) => {
        const base = {
            ttyFactory: factoryResult.factory,
            agentName: factoryResult.agentName || appName || 'ChatAgent',
            containerName: factoryResult.label,
            runtime: factoryResult.runtime,
            forwardEnvelope: factoryResult.forwardEnvelope === true,
            runtimeScope: factoryResult.runtimeScope === 'principal' ? 'principal' : 'shared',
            unavailableReason: factoryResult.unavailableReason || ''
        };
        base.getFactoryForCommands = (commands) => {
            if (!commands) return null;
            const nextFactory = getWebchatFactory(commands, factoryOptions);
            return wrapWebchatFactory(nextFactory, factoryOptions);
        };
        return base;
    };

    return {
        async resolveWebchatForRequest({ req, res, workspaceBase }) {
            const commands = await getWebchatFactory.resolveCommandsForRequest();
            if (req.destroyed || res.destroyed) return null;
            const options = { workspaceRoot: workspaceBase.root };
            return wrapWebchatFactory(getWebchatFactory(commands, options), options);
        },
        get webchat() {
            return wrapWebchatFactory(getWebchatFactory());
        },
        status: {
            agentName: 'Status',
            containerName: '-',
            runtime: 'local'
        }
    };
}

export {
    initializeTTYFactories,
    createServiceConfig,
    resolveSafeHostWorkdir
};
