import { assertRouteKeyAvailable } from './reservedRouteKeys.js';

const AUTOMATIC_STARTUP = 'automatic';
const MANUAL_STARTUP = 'manual';
const STARTUP_VALUES = new Set([AUTOMATIC_STARTUP, MANUAL_STARTUP]);

function resolveManifestStartup(manifest = {}) {
    if (manifest?.startup === undefined) return AUTOMATIC_STARTUP;
    if (typeof manifest.startup !== 'string' || !STARTUP_VALUES.has(manifest.startup)) {
        throw new Error("manifest startup must be 'automatic' or 'manual'");
    }
    return manifest.startup;
}

function partitionAdditionalStartupAgents({
    registry = {},
    names = [],
    graphRegistryNames = new Set(),
    loadManifest,
    isRuntimeRunning,
} = {}) {
    const automatic = [];
    const activeManual = [];
    const inactiveManual = [];

    for (const name of names) {
        if (graphRegistryNames.has(name)) continue;
        const record = registry[name];
        if (!record?.agentName || !record?.repoName) {
            automatic.push(name);
            continue;
        }
        const manifest = loadManifest(record, name);
        const startup = resolveManifestStartup(manifest);
        if (startup === AUTOMATIC_STARTUP) {
            automatic.push(name);
            continue;
        }
        const routeKey = assertRouteKeyAvailable(record.alias || record.agentName, { label: 'Agent route key' });
        const entry = {
            name,
            routeKey,
        };
        if (isRuntimeRunning(name, record)) activeManual.push(entry);
        else inactiveManual.push(entry);
    }

    return { automatic, activeManual, inactiveManual };
}

function shouldMonitorManifestRuntime(manifest, { hasRoute = false } = {}) {
    return resolveManifestStartup(manifest) === AUTOMATIC_STARTUP || Boolean(hasRoute);
}

function removeInactiveManualRoutes(routes = {}, inactiveManual = []) {
    const nextRoutes = { ...(routes || {}) };
    for (const entry of inactiveManual) {
        const routeKey = String(entry?.routeKey || '').trim();
        if (routeKey) delete nextRoutes[routeKey];
    }
    return nextRoutes;
}

export {
    AUTOMATIC_STARTUP,
    MANUAL_STARTUP,
    partitionAdditionalStartupAgents,
    removeInactiveManualRoutes,
    resolveManifestStartup,
    shouldMonitorManifestRuntime,
};
