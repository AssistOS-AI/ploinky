import fs from 'fs';
import os from 'os';
import { configCache } from '../utils/configCache.js';
import { logBootEvent } from '../utils/logger.js';
import { getAppName } from '../authHandlers/index.js';
import { resolveWebchatCommands, resolveWebchatCommandsForAgent } from '../webchat/commandResolver.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../services/config.js';

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
 * Load TTY module with fallback support
 */
async function loadTTYModule(primaryRelative, legacyRelative) {
    const currentUrl = import.meta.url;
    try {
        const mod = await import(new URL(primaryRelative, currentUrl));
        return mod.default || mod;
    } catch (primaryError) {
        if (legacyRelative) {
            try {
                const legacy = await import(new URL(legacyRelative, currentUrl));
                return legacy.default || legacy;
            } catch (_) { }
        }
        throw primaryError;
    }
}

/**
 * Load all TTY modules
 */
async function loadTTYModules() {
    let webchatTTYModule = {};
    try {
        webchatTTYModule = await loadTTYModule('../webchat/tty.js', '../webchat/webchat-ttyFactory.js');
    } catch (_) {
        console.warn('WebChat TTY factory unavailable.');
    }
    return { webchatTTYModule };
}

/**
 * Build a local TTY factory with defaults
 */
function buildLocalFactory(createFactoryFn, defaults = {}) {
    if (!createFactoryFn) return null;
    const safeWorkdir = resolveSafeHostWorkdir(defaults.workdir);
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
        unsupportedReason: commands?.unsupportedReason || ''
    });
    const resolveHostWorkdir = (config) => {
        // webchat hostCommand frequently runs `ploinky cli <agent>`.
        // That command must run from the *workspace root* so it sees the correct
        // `.ploinky/` state (enabled repos, enabled agents). If it runs from
        // `agents/<name>/`, Ploinky bootstraps a new `.ploinky/` and then fails
        // with: "Agent '<name>' not found".
        return resolveSafeHostWorkdir(PLOINKY_WORKSPACE_ROOT);
    };

    const buildFactoryResult = (config) => {
        const hostWorkdir = resolveHostWorkdir(config);
        if (createWebChatLocalFactory) {
            const command = config.hostCommand;
            const factory = buildLocalFactory(createWebChatLocalFactory, { command, workdir: hostWorkdir });
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
                unavailableReason: ''
            };
        }
        logBootEvent('webchat_factory_disabled', { reason: 'no_factory_available' });
        return { factory: null, label: '-', runtime: 'disabled', agentName: config.agentName || '', unavailableReason: '' };
    };

    return (commandsOverride = null) => {
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
            buildFactoryResult
        );
    };
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

    const wrapWebchatFactory = (factoryResult) => {
        const base = {
            ttyFactory: factoryResult.factory,
            agentName: factoryResult.agentName || appName || 'ChatAgent',
            containerName: factoryResult.label,
            runtime: factoryResult.runtime,
            forwardEnvelope: factoryResult.forwardEnvelope === true,
            unavailableReason: factoryResult.unavailableReason || ''
        };
        base.getFactoryForCommands = (commands) => {
            if (!commands) return null;
            const nextFactory = getWebchatFactory(commands);
            return wrapWebchatFactory(nextFactory);
        };
        return base;
    };

    return {
        get webchat() {
            return wrapWebchatFactory(getWebchatFactory());
        },
        dashboard: {
            agentName: 'Dashboard',
            containerName: '-',
            runtime: 'local'
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
