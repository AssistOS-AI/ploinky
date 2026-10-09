import fs from 'fs';
import path from 'path';
import { ROUTING_FILE } from '../../utils/config.js';
import { DIRECT_CLI_PATH } from '../../utils/directCli.js';

function trimCommand(value) {
    if (!value) return '';
    const text = String(value).trim();
    return text.length ? text : '';
}

function shellEscapeCommandArg(value) {
    const text = trimCommand(value);
    if (!text) return '';
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

function normalizeCliArgs(rawArgs) {
    if (!Array.isArray(rawArgs)) {
        return [];
    }
    return rawArgs
        .map((entry) => trimCommand(entry))
        .filter(Boolean);
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

function resolveStaticAgentDetails(routingFilePath, cfg = readRoutingConfig(routingFilePath)) {
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

function buildHostCliCommand(cliTarget, options = {}) {
    const target = trimCommand(cliTarget);
    if (!target) {
        return '';
    }
    let command = `${shellEscapeCommandArg(DIRECT_CLI_PATH)} cli ${target}`;
    const cliArgs = normalizeCliArgs(options.cliArgs);
    if (cliArgs.length) {
        command += ` ${cliArgs.map((arg) => shellEscapeCommandArg(arg)).join(' ')}`;
    }
    return command;
}

function resolveWebchatCommands(options = {}) {
    const routingFilePath = options.routingFilePath || ROUTING_FILE;
    const { agentName: staticAgentName, hostPath, containerName, alias } = resolveStaticAgentDetails(routingFilePath);

    if (!staticAgentName || !hostPath) {
        return { host: '', container: '', source: 'unset', agentName: '' };
    }

    const manifestPath = options.manifestPathOverride || path.join(hostPath, 'manifest.json');
    let manifestCli = '';
    let webchatOptions = { forwardEnvelope: false };
    try {
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            manifestCli = extractManifestCli(manifest);
            webchatOptions = extractManifestWebchatOptions(manifest);
        }
    } catch (_) {
        manifestCli = '';
    }

    if (!manifestCli) {
        // If we have an agent but no manifest command, we should still return the agent name
        // as other features like blob storage might depend on it.
        // The TTY factory will simply have no command to run, which is handled elsewhere.
        return { host: '', container: '', source: 'unset', agentName: staticAgentName, ...webchatOptions };
    }

    const cliTarget = resolveCliTarget({ alias, container: containerName }, staticAgentName);
    const hostCommand = buildHostCliCommand(cliTarget, options);
    return {
        host: hostCommand,
        container: manifestCli,
        source: 'manifest',
        agentName: staticAgentName,
        cliTarget,
        ...webchatOptions,
        cacheKey: 'webchat'
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
            webchatOptions = extractManifestWebchatOptions(manifest);
        }
    } catch (_) {
        manifestCli = '';
    }
    const cliTarget = resolveCliTarget(record, agentRef);
    const hostCommand = buildHostCliCommand(cliTarget, options);
    const cacheSuffix = normalizeCliArgs(options.cliArgs).join('\u0000');
    return {
        host: hostCommand,
        container: manifestCli,
        source: 'manifest',
        agentName: agentRef,
        cliTarget,
        ...webchatOptions,
        cacheKey: cacheSuffix ? `webchat:${agentRef}:${cacheSuffix}` : `webchat:${agentRef}`
    };
}

async function readRoutingConfigAsync(routingFilePath) {
    try {
        return JSON.parse(await fs.promises.readFile(routingFilePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

async function readManifestCommandsAsync(manifestPath) {
    try {
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        return { manifestCli: extractManifestCli(manifest), ...extractManifestWebchatOptions(manifest) };
    } catch (_) {
        return { manifestCli: '', forwardEnvelope: false };
    }
}

async function resolveWebchatCommandsAsync(options = {}) {
    const routingFilePath = options.routingFilePath || ROUTING_FILE;
    const routing = await readRoutingConfigAsync(routingFilePath);
    const { agentName, hostPath, containerName, alias } = resolveStaticAgentDetails(routingFilePath, routing);
    if (!agentName || !hostPath) return { host: '', container: '', source: 'unset', agentName: '' };
    const { manifestCli, ...webchatOptions } = await readManifestCommandsAsync(
        options.manifestPathOverride || path.join(hostPath, 'manifest.json')
    );
    if (!manifestCli) return { host: '', container: '', source: 'unset', agentName, ...webchatOptions };
    const cliTarget = resolveCliTarget({ alias, container: containerName }, agentName);
    return {
        host: buildHostCliCommand(cliTarget, options), container: manifestCli, source: 'manifest',
        agentName, cliTarget, ...webchatOptions, cacheKey: 'webchat'
    };
}

async function resolveWebchatCommandsForAgentAsync(agentRef, options = {}) {
    const routing = await readRoutingConfigAsync(options.routingFilePath || ROUTING_FILE);
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
    if (!record || !record.hostPath) return null;
    const { manifestCli, ...webchatOptions } = await readManifestCommandsAsync(path.join(record.hostPath, 'manifest.json'));
    const cliTarget = resolveCliTarget(record, agentRef);
    const cacheSuffix = normalizeCliArgs(options.cliArgs).join('\u0000');
    return {
        host: buildHostCliCommand(cliTarget, options), container: manifestCli, source: 'manifest',
        agentName: agentRef, cliTarget, ...webchatOptions,
        cacheKey: cacheSuffix ? `webchat:${agentRef}:${cacheSuffix}` : `webchat:${agentRef}`
    };
}

const WEBCHAT_PROVENANCE_FIELDS = ['routeKey', 'hostPath', 'container', 'alias', 'repo', 'agent', 'cliTarget'];

// The executable identity of one enabled route: where its manifest lives and
// which `ploinky cli` target it launches. Both the Router authorization
// snapshot and the on-disk routing file are reduced with this same rule so a
// WebChat launch can prove it runs the target its authorization admitted.
function webchatRouteProvenance(routing, routeKey) {
    const key = trimCommand(routeKey);
    const routes = routing?.routes && typeof routing.routes === 'object' ? routing.routes : {};
    const route = key && Object.hasOwn(routes, key) ? routes[key] : null;
    if (!route || typeof route !== 'object' || route.disabled) return null;
    const staticAgent = trimCommand(routing?.static?.agent);
    const shortStatic = staticAgent.includes('/') ? staticAgent.split('/').pop() : staticAgent;
    const isStatic = Boolean(staticAgent) && (
        staticAgent === key
        || shortStatic === key
        || (route.repo && route.agent && `${route.repo}/${route.agent}` === staticAgent)
    );
    return {
        routeKey: key,
        hostPath: trimCommand(route.hostPath || (isStatic ? routing?.static?.hostPath : '')),
        container: trimCommand(route.container),
        alias: trimCommand(route.alias),
        repo: trimCommand(route.repo),
        agent: trimCommand(route.agent),
        cliTarget: resolveCliTarget(route, key),
    };
}

function manifestWebchatDeclaration(manifest) {
    const surface = manifest && typeof manifest === 'object' ? manifest.webchat : undefined;
    const value = typeof surface === 'string' ? surface : surface?.auth;
    return String(value || '').trim().toLowerCase();
}

async function readManifestAsync(manifestPath) {
    try {
        return JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    } catch (_) {
        return null;
    }
}

// Resolves the commands for exactly the target bound by Router authorization.
// The caller never supplies an agent name: the target, its executable
// provenance and its declared WebChat policy come from the authorization
// snapshot and must still match the routing file and manifest on disk.
async function resolveWebchatCommandsForBindingAsync(binding, options = {}) {
    const expected = binding?.targetRoute;
    const routeKey = trimCommand(binding?.target);
    if (!routeKey || !expected || expected.routeKey !== routeKey || !expected.hostPath) {
        return { changed: true };
    }
    const routing = await readRoutingConfigAsync(options.routingFilePath || ROUTING_FILE);
    const actual = routing ? webchatRouteProvenance(routing, routeKey) : null;
    if (!actual || WEBCHAT_PROVENANCE_FIELDS.some((field) => actual[field] !== expected[field])) {
        return { changed: true };
    }
    const manifest = await readManifestAsync(path.join(actual.hostPath, 'manifest.json'));
    if (!manifest || manifestWebchatDeclaration(manifest) !== String(binding.declaration || '')) {
        return { changed: true };
    }
    const cliArgs = normalizeCliArgs(options.cliArgs);
    const cacheSuffix = cliArgs.join('\u0000');
    return {
        host: buildHostCliCommand(actual.cliTarget, { cliArgs }),
        container: extractManifestCli(manifest),
        source: 'manifest',
        agentName: routeKey,
        cliTarget: actual.cliTarget,
        cliArgs,
        provenance: { ...actual, generation: String(binding.generation || '') },
        ...extractManifestWebchatOptions(manifest),
        cacheKey: cacheSuffix ? `webchat:${routeKey}:${cacheSuffix}` : `webchat:${routeKey}`
    };
}

export {
    resolveWebchatCommands,
    resolveWebchatCommandsForAgent,
    resolveWebchatCommandsAsync,
    resolveWebchatCommandsForAgentAsync,
    resolveWebchatCommandsForBindingAsync,
    webchatRouteProvenance,
    manifestWebchatDeclaration,
    extractManifestCli,
    extractManifestWebchatOptions,
    trimCommand
};
