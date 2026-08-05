import fs from 'fs';
import { configCache } from './configCache.js';
import { logBootEvent } from './logger.js';
import { getAppName } from '../authHandlers/index.js';
import { resolveWebchatCommands } from '../webchat/commandResolver.js';

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
    const workdir = defaults.workdir;
    try {
        const stat = fs.lstatSync(workdir);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(workdir) !== workdir) {
            return null;
        }
        fs.accessSync(defaults.executable, fs.constants.X_OK);
        return createFactoryFn({ ...defaults, workdir });
    } catch (_) {
        return null;
    }
}

/**
 * Create WebChat factory configuration
 */
function createWebchatFactoryConfig(webchatTTYModule, resolvedWebchatCommands) {
    const {
        createLocalTTYFactory: createWebChatLocalFactory
    } = webchatTTYModule;

    const buildCacheKey = (commands) => commands?.cacheKey || (commands?.agentName ? `webchat:${commands.agentName}` : 'webchat');
    const buildConfig = (commands) => ({
        executable: commands?.executable || '',
        argv: Array.isArray(commands?.argv) ? [...commands.argv] : [],
        hostWorkdir: commands?.cwd || '',
        source: commands?.source || 'unset',
        agentName: commands?.agentName || '',
        forwardEnvelope: commands?.forwardEnvelope === true,
        unsupportedReason: commands?.unsupportedReason || ''
    });
    const buildFactoryResult = (config) => {
        if (createWebChatLocalFactory && config.executable && config.argv.length) {
            const factory = buildLocalFactory(createWebChatLocalFactory, {
                executable: config.executable,
                argv: config.argv,
                workdir: config.hostWorkdir,
            });
            if (factory) {
                logBootEvent('webchat_local_process_factory_ready', {
                    agent: config.agentName || null,
                    source: config.source
                });
            }
            return {
                factory,
                label: config.agentName || 'webchat_agent',
                runtime: 'local',
                agentName: config.agentName || '',
                forwardEnvelope: config.forwardEnvelope === true,
                unavailableReason: factory ? '' : 'PLOINKY_WEBCHAT_DIRECT_CLI_UNAVAILABLE'
            };
        }
        const unavailableReason = config.unsupportedReason || 'PLOINKY_WEBCHAT_DIRECT_CLI_UNAVAILABLE';
        logBootEvent('webchat_factory_disabled', {
            agent: config.agentName || null,
            reason: unavailableReason,
        });
        return {
            factory: null,
            label: config.agentName || '-',
            runtime: 'disabled',
            agentName: config.agentName || '',
            unavailableReason,
        };
    };

    return (commandsOverride = null) => {
        let commands = commandsOverride || resolvedWebchatCommands;
        if (!commandsOverride && (!commands || (!commands.executable && !commands.agentName))) {
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
        logBootEvent('webchat_manifest_cli_available', { agent: resolvedWebchatCommands.agentName });
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
    createServiceConfig
};
