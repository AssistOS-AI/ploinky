import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { ROUTING_FILE } from '../../utils/config.js';
import { DIRECT_CLI_PATH } from '../../utils/directCli.js';
import { admitProviderManifestCli } from '../../utils/providerCliAdmission.js';

function trimCommand(value) {
    if (!value) return '';
    const text = String(value).trim();
    return text.length ? text : '';
}

function normalizeCliArgs(rawArgs) {
    if (!Array.isArray(rawArgs)) {
        return [];
    }
    return rawArgs.map((entry) => {
        if (typeof entry !== 'string' || entry.includes('\0')) {
            const error = new Error('WebChat provider argv must contain exact strings');
            error.code = 'PLOINKY_WEBCHAT_ARGV_INVALID';
            error.status = 400;
            throw error;
        }
        return entry;
    });
}

function readRoutingConfig(routingFilePath) {
    try {
        const raw = fs.readFileSync(routingFilePath, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function extractManifestCli(manifest) {
    if (!manifest || typeof manifest !== 'object') return '';
    const candidates = [
        manifest.cli,
        manifest.commands && manifest.commands.cli,
        manifest.run,
        manifest.commands && manifest.commands.run
    ];
    for (const entry of candidates) {
        const candidate = trimCommand(entry);
        if (candidate) return candidate;
    }
    return '';
}

function extractManifestWebchatOptions(manifest) {
    const webchat = manifest && typeof manifest === 'object' && manifest.webchat && typeof manifest.webchat === 'object'
        ? manifest.webchat
        : {};
    return {
        forwardEnvelope: webchat.forwardEnvelope === true || webchat.forwardEnvelope === 'true'
            || webchat.forwardEnvelope === 1 || webchat.forwardEnvelope === '1'
    };
}

function resolveStaticAgentDetails(routingFilePath) {
    const cfg = readRoutingConfig(routingFilePath);
    if (!cfg || !cfg.static) {
        return { agentName: '', hostPath: '', containerName: '', alias: '' };
    }
    const agentName = trimCommand(cfg.static.agent);
    const routes = cfg.routes && typeof cfg.routes === 'object' ? cfg.routes : {};
    const shortAgentName = agentName.includes('/') ? agentName.split('/').pop() : agentName;
    const routeEntry = routes[agentName] || routes[shortAgentName] || Object.values(routes).find((route) => {
        const routeRef = route?.repo && route?.agent ? `${route.repo}/${route.agent}` : '';
        return routeRef === agentName;
    }) || {};
    const hostPath = trimCommand(routeEntry.hostPath || cfg.static.hostPath);
    const containerName = trimCommand(cfg.static.container);
    const alias = trimCommand(routeEntry.alias || cfg.static.alias);
    return { agentName, hostPath, containerName, alias };
}

function resolveCliTarget(record = {}, fallbackName = '') {
    // Priority: alias > agent name (fallback) > container name
    // The CLI command expects agent names or aliases, not container names
    const alias = trimCommand(record.alias);
    if (alias) return alias;
    // Prefer agent name over container name - container names cause lookup issues
    const agentName = trimCommand(fallbackName);
    if (agentName) return agentName;
    const container = trimCommand(record.container);
    if (container) return container;
    return '';
}

function buildHostCliLaunch(cliTarget, options = {}) {
    const target = trimCommand(cliTarget);
    const workdir = typeof options.workdir === 'string' ? options.workdir : '';
    const cwd = typeof options.hostWorkdir === 'string' ? options.hostWorkdir : '';
    if (!target
        || target.includes('\0')
        || target.startsWith('-')
        || !workdir
        || workdir.includes('\0')
        || !cwd
        || cwd.includes('\0')) {
        return null;
    }
    const cliArgs = normalizeCliArgs(options.cliArgs);
    return Object.freeze({
        executable: DIRECT_CLI_PATH,
        argv: Object.freeze(['cli', target, '--workdir', workdir, '--', ...cliArgs]),
        cwd,
    });
}

function buildLaunchCacheKey(agentName, launch) {
    if (!launch) return `webchat:${agentName || 'unset'}:unavailable`;
    const digest = createHash('sha256')
        .update(JSON.stringify([launch.executable, launch.argv, launch.cwd]))
        .digest('hex');
    return `webchat:${agentName}:${digest}`;
}

function resolveWebchatCommands(options = {}) {
    const routingFilePath = options.routingFilePath || ROUTING_FILE;
    const { agentName: staticAgentName, hostPath, containerName, alias } = resolveStaticAgentDetails(routingFilePath);

    if (!staticAgentName || !hostPath) {
        return { executable: '', argv: [], source: 'unset', agentName: '' };
    }

    const manifestPath = options.manifestPathOverride || path.join(hostPath, 'manifest.json');
    let manifestCli = '';
    let webchatOptions = { forwardEnvelope: false };
    try {
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            manifestCli = extractManifestCli(manifest);
            admitProviderManifestCli(manifestCli, { manifestPath });
            webchatOptions = extractManifestWebchatOptions(manifest);
        }
    } catch (error) {
        if (error?.code === 'PLOINKY_PROVIDER_CLI_INVALID'
            || error?.code === 'PLOINKY_PROVIDER_CONFIG_INVALID') {
            throw error;
        }
        manifestCli = '';
    }

    if (!manifestCli) {
        // If we have an agent but no manifest command, we should still return the agent name
        // as other features like blob storage might depend on it.
        // The TTY factory will simply have no command to run, which is handled elsewhere.
        return {
            executable: '',
            argv: [],
            source: 'unset',
            agentName: staticAgentName,
            unsupportedReason: 'PLOINKY_WEBCHAT_CLI_UNAVAILABLE',
            ...webchatOptions,
        };
    }

    const cliTarget = resolveCliTarget({ alias, container: containerName }, staticAgentName);
    const launch = buildHostCliLaunch(cliTarget, options);
    return {
        executable: launch?.executable || '',
        argv: launch?.argv || [],
        cwd: launch?.cwd || '',
        source: 'manifest',
        agentName: staticAgentName,
        cliTarget,
        ...webchatOptions,
        cacheKey: buildLaunchCacheKey(staticAgentName, launch),
        unsupportedReason: launch ? '' : 'PLOINKY_WORKDIR_REQUIRED',
    };
}

function resolveWebchatCommandsForAgent(agentRef, options = {}) {
    const routingFilePath = options.routingFilePath || ROUTING_FILE;
    const routing = readRoutingConfig(routingFilePath);
    if (!routing) return null;
    const routes = routing.routes || {};
    let record = routes[agentRef];
    if (!record) {
        const staticAgent = trimCommand(routing.static?.agent);
        if (staticAgent && staticAgent === agentRef) {
            const shortAgentName = staticAgent.includes('/') ? staticAgent.split('/').pop() : staticAgent;
            record = routes[staticAgent] || routes[shortAgentName] || routing.static;
        }
    }

    if (!record || !record.hostPath) {
        return null;
    }

    const manifestPath = path.join(record.hostPath, 'manifest.json');
    let manifestCli = '';
    let webchatOptions = { forwardEnvelope: false };
    try {
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            manifestCli = extractManifestCli(manifest);
            admitProviderManifestCli(manifestCli, { manifestPath });
            webchatOptions = extractManifestWebchatOptions(manifest);
        }
    } catch (error) {
        if (error?.code === 'PLOINKY_PROVIDER_CLI_INVALID'
            || error?.code === 'PLOINKY_PROVIDER_CONFIG_INVALID') {
            throw error;
        }
        manifestCli = '';
    }
    const cliTarget = resolveCliTarget(record, agentRef);
    const launch = manifestCli ? buildHostCliLaunch(cliTarget, options) : null;
    return {
        executable: launch?.executable || '',
        argv: launch?.argv || [],
        cwd: launch?.cwd || '',
        source: 'manifest',
        agentName: agentRef,
        cliTarget,
        ...webchatOptions,
        cacheKey: buildLaunchCacheKey(agentRef, launch),
        unsupportedReason: launch
            ? ''
            : (manifestCli ? 'PLOINKY_WORKDIR_REQUIRED' : 'PLOINKY_WEBCHAT_CLI_UNAVAILABLE'),
    };
}

export {
    resolveWebchatCommands,
    resolveWebchatCommandsForAgent,
    extractManifestCli,
    extractManifestWebchatOptions,
    trimCommand
};
