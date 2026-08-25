import { getBwrapPid, isBwrapProcessRunning } from './bwrap/bwrapFleet.js';
import { collectLiveAgentContainers, collectLiveAgentContainersAsync, getAgentsRegistry } from './docker/containerRegistry.js';

const HOST_SANDBOX_RUNTIMES = new Set(['bwrap', 'seatbelt']);

function normalizeRuntime(record) {
    const recorded = String(record?.runtime || '').trim().toLowerCase();
    return recorded || 'container';
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
        agentLibAttestation: record?.agentLibAttestation || null,
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
    const containersByName = new Map(liveContainers.map((entry) => [String(entry?.containerName || ''), entry]));
    const matchedContainers = new Set();
    const states = [];

    for (const [containerName, record] of Object.entries(registry)) {
        if (!record || record.type !== 'agent') continue;
        const liveEntry = containersByName.get(containerName) || null;
        const runtime = normalizeRuntime(record);

        if (HOST_SANDBOX_RUNTIMES.has(runtime)) {
            const running = Boolean(sandboxRunning(record.agentName));
            const pid = running ? Number(sandboxPid(record.agentName) || record.pid || 0) : 0;
            states.push({
                ...stoppedRuntimeEntry(containerName, record, runtime),
                state: {
                    status: running ? 'running' : 'stopped',
                    running,
                    pid,
                },
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
                agentLibAttestation: record.agentLibAttestation || null,
                state: {
                    ...(liveEntry.state || {}),
                    status: String(liveEntry.state?.status || 'running').toLowerCase(),
                    running: Boolean(liveEntry.state?.running),
                    pid: Number(liveEntry.state?.pid || 0),
                },
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
