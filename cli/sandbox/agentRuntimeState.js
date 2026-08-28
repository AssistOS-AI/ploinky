import { getBwrapPid, isBwrapProcessRunning } from './bwrap/bwrapFleet.js';
import { collectLiveAgentContainers, collectLiveAgentContainersAsync, getAgentsRegistry } from './docker/containerRegistry.js';
import { loadActiveEdgeRoutingGeneration } from './edgeGeneration.js';

const HOST_SANDBOX_RUNTIMES = new Set(['bwrap', 'seatbelt']);

function normalizeRuntime(record) {
    const recorded = String(record?.runtime || '').trim().toLowerCase();
    return recorded || 'container';
}

function loadActiveRoutes() {
    try {
        return loadActiveEdgeRoutingGeneration().generation.routing?.routes || {};
    } catch (_) {
        return {};
    }
}

function hasActiveRoutePort(routes, containerName, record = {}) {
    const routeMatchesRuntime = (entry) => {
        if (!entry || entry.disabled === true) return false;
        const runtimeContainer = String(containerName || '');
        const routeContainer = String(entry.container || '');
        if (runtimeContainer && routeContainer && runtimeContainer !== routeContainer) return false;

        const runtimeRepo = String(record.repoName || '');
        const runtimeAgent = String(record.agentName || '');
        if (runtimeRepo && runtimeAgent) {
            return runtimeRepo === String(entry.repo || '')
                && runtimeAgent === String(entry.agent || '');
        }
        return Boolean(runtimeContainer && routeContainer && runtimeContainer === routeContainer);
    };
    const preferredKeys = [...new Set([record.alias, record.agentName].map((value) => String(value || '')).filter(Boolean))];
    const route = preferredKeys
        .map((key) => routes?.[key])
        .find(routeMatchesRuntime)
        || Object.values(routes || {}).find(routeMatchesRuntime);
    const hostPort = Number(route?.hostPort || 0);
    return Number.isSafeInteger(hostPort) && hostPort > 0 && hostPort <= 65535;
}

function usableRuntimeState(state, routes, containerName, record) {
    const processRunning = state?.running === true;
    const running = processRunning && hasActiveRoutePort(routes, containerName, record);
    return {
        ...(state || {}),
        status: processRunning && !running ? 'starting' : String(state?.status || (running ? 'running' : 'stopped')).toLowerCase(),
        running,
        pid: Number(state?.pid || 0),
    };
}

function stoppedRuntimeEntry(containerName, record, runtime) {
    return {
        containerName,
        agentName: String(record?.agentName || '-'),
        repoName: String(record?.repoName || '-'),
        runtime,
        enabled: true,
        containerImage: record?.containerImage || '-',
        createdAt: record?.createdAt || '-',
        projectPath: record?.projectPath || '-',
        agentLib: record?.agentLib || null,
        state: {
            status: 'stopped',
            running: false,
            pid: 0,
        },
        config: record?.config || {},
    };
}

/**
 * Return one backend-neutral state record for every enabled agent runtime and
 * retain any live OCI runtime that no longer has a registry record.
 */
function collectAgentRuntimeStates(options = {}) {
    const registry = options.registry || getAgentsRegistry() || {};
    const liveContainers = Object.hasOwn(options, 'liveContainers')
        ? (options.liveContainers || [])
        : (options.collectContainers || collectLiveAgentContainers)() || [];
    const sandboxRunning = options.isSandboxRunning || isBwrapProcessRunning;
    const sandboxPid = options.getSandboxPid || getBwrapPid;
    const routes = Object.hasOwn(options, 'routes') ? (options.routes || {}) : loadActiveRoutes();
    const containersByName = new Map(liveContainers.map((entry) => [String(entry?.containerName || ''), entry]));
    const matchedContainers = new Set();
    const states = [];

    for (const [containerName, record] of Object.entries(registry)) {
        if (!record || record.type !== 'agent') continue;
        const liveEntry = containersByName.get(containerName) || null;
        const runtime = normalizeRuntime(record);

        if (HOST_SANDBOX_RUNTIMES.has(runtime)) {
            const processRunning = Boolean(sandboxRunning(record.agentName));
            const pid = processRunning ? Number(sandboxPid(record.agentName) || record.pid || 0) : 0;
            states.push({
                ...stoppedRuntimeEntry(containerName, record, runtime),
                state: usableRuntimeState({
                    status: processRunning ? 'running' : 'stopped',
                    running: processRunning,
                    pid,
                }, routes, containerName, record),
            });
            continue;
        }

        if (liveEntry) {
            matchedContainers.add(containerName);
            states.push({
                ...liveEntry,
                agentName: String(record.agentName || liveEntry.agentName || '-'),
                repoName: String(record.repoName || liveEntry.repoName || '-'),
                runtime,
                enabled: true,
                agentLib: record.agentLib || null,
                state: usableRuntimeState({
                    ...(liveEntry.state || {}),
                    status: String(liveEntry.state?.status || 'running').toLowerCase(),
                    running: Boolean(liveEntry.state?.running),
                    pid: Number(liveEntry.state?.pid || 0),
                }, routes, containerName, record),
            });
            continue;
        }

        states.push(stoppedRuntimeEntry(containerName, record, runtime));
    }

    for (const liveEntry of liveContainers) {
        const containerName = String(liveEntry?.containerName || '');
        if (!containerName || matchedContainers.has(containerName)) continue;
        states.push({
            ...liveEntry,
            runtime: 'container',
            enabled: false,
            state: usableRuntimeState(liveEntry.state, routes, containerName, liveEntry),
        });
    }

    return states;
}

async function collectAgentRuntimeStatesAsync(options = {}) {
    const liveContainers = Object.hasOwn(options, 'liveContainers')
        ? (options.liveContainers || [])
        : await (options.collectContainers || collectLiveAgentContainersAsync)();
    return collectAgentRuntimeStates({ ...options, liveContainers });
}

export {
    HOST_SANDBOX_RUNTIMES,
    collectAgentRuntimeStates,
    collectAgentRuntimeStatesAsync,
};
