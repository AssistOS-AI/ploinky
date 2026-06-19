import { resolveVarValue } from '../../services/secretVars.js';
import fs from 'fs';
import os from 'os';
import { configCache } from '../utils/configCache.js';
import { logBootEvent } from '../utils/logger.js';
import { getAppName } from '../authHandlers.js';
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
 * Load PTY library (optional dependency)
 */
async function loadPtyLibrary() {
    try {
        const ptyModule = await import('node-pty');
        return ptyModule.default || ptyModule;
    } catch (error) {
        const reason = error?.message || error;
        console.warn('node-pty not found, TTY features will be disabled.');
        if (reason) {
            console.warn(`node-pty load failure: ${reason}`);
        }
        logBootEvent('pty_unavailable', { reason: reason || 'unknown' });
        return null;
    }
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
async function loadTTYModules(pty) {
    let webttyTTYModule = {};
    let webchatTTYModule = {};

    if (pty) {
        try {
            webttyTTYModule = await loadTTYModule('../webtty/tty.js', '../webtty/webtty-ttyFactory.js');
        } catch (_) {
            console.warn('WebTTY TTY factory unavailable.');
        }

        try {
            webchatTTYModule = await loadTTYModule('../webchat/tty.js', '../webchat/webchat-ttyFactory.js');
        } catch (_) {
            console.warn('WebChat TTY factory unavailable.');
        }
    }

    return { webttyTTYModule, webchatTTYModule };
}

/**
 * Build a local TTY factory with defaults
 */
function buildLocalFactory(createFactoryFn, pty, defaults = {}) {
    if (!pty || !createFactoryFn) return null;
    const safeWorkdir = resolveSafeHostWorkdir(defaults.workdir);
    return createFactoryFn({ ptyLib: pty, ...defaults, workdir: safeWorkdir });
}

/**
 * Create WebTTY factory configuration
 */
function createWebttyFactoryConfig(pty, webttyTTYModule) {
    const {
        createTTYFactory: createWebTTYTTYFactory,
        createLocalTTYFactory: createWebTTYLocalFactory
    } = webttyTTYModule;

    return () => configCache.getOrCreate(
        'webtty',
        () => ({
            shell: resolveVarValue('WEBTTY_SHELL'),
            command: process.env.WEBTTY_COMMAND || '',
            container: process.env.WEBTTY_CONTAINER || 'ploinky_interactive'
        }),
        (config) => {
            if (!pty) {
                logBootEvent('webtty_factory_disabled', { reason: 'pty_unavailable' });
                return { factory: null, label: '-', runtime: 'disabled' };
            }
            if (createWebTTYLocalFactory) {
                const command = config.shell || config.command;
                const factory = buildLocalFactory(createWebTTYLocalFactory, pty, { command });
                if (factory) {
                    logBootEvent('webtty_local_process_factory_ready', { command: command || null });
                }
                return {
                    factory,
                    label: command ? command : 'local shell',
                    runtime: 'local'
                };
            }
            if (createWebTTYTTYFactory) {
                const factory = createWebTTYTTYFactory({ ptyLib: pty, runtime: 'docker', containerName: config.container });
                logBootEvent('webtty_container_factory_ready', { containerName: config.container });
                return {
                    factory,
                    label: config.container,
                    runtime: 'docker'
                };
            }
            logBootEvent('webtty_factory_disabled', { reason: 'no_factory_available' });
            return { factory: null, label: '-', runtime: 'disabled' };
        }
    );
}

/**
 * Create WebChat factory configuration
 */
function createWebchatFactoryConfig(pty, webchatTTYModule, resolvedWebchatCommands) {
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
        if (!pty) {
            logBootEvent('webchat_factory_disabled', { reason: 'pty_unavailable' });
            return { factory: null, label: '-', runtime: 'disabled', agentName: config.agentName || '', unavailableReason: '' };
        }
        const hostWorkdir = resolveHostWorkdir(config);
        if (createWebChatLocalFactory) {
            const command = config.hostCommand;
            const factory = buildLocalFactory(createWebChatLocalFactory, pty, { command, workdir: hostWorkdir });
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
                ptyLib: pty,
                runtime: 'docker',
                containerName: containerLabel,
                entry,
                workdir: '/code'
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
    // Load PTY library
    const pty = await loadPtyLibrary();

    // Load TTY modules
    const { webttyTTYModule, webchatTTYModule } = await loadTTYModules(pty);

    // Resolve webchat commands
    const resolvedWebchatCommands = resolveWebchatCommands();
    if (resolvedWebchatCommands.source === 'manifest' && resolvedWebchatCommands.agentName) {
        logBootEvent('webchat_manifest_cli_fallback', { agent: resolvedWebchatCommands.agentName });
    }

    // Create factory configurations
    const getWebttyFactory = createWebttyFactoryConfig(pty, webttyTTYModule);
    const getWebchatFactory = createWebchatFactoryConfig(pty, webchatTTYModule, resolvedWebchatCommands);

    return {
        pty,
        getWebttyFactory,
        getWebchatFactory
    };
}

/**
 * Create service configuration object
 */
function createServiceConfig(getWebttyFactory, getWebchatFactory) {
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
        get webtty() {
            const factory = getWebttyFactory();
            return {
                ttyFactory: factory.factory,
                agentName: 'Router',
                containerName: factory.label,
                runtime: factory.runtime
            };
        },
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
