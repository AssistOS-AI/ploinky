import {
    isSandboxOwnerRunning,
    readServiceOwner,
    serviceOwnerKey,
} from './bwrap/bwrapFleet.js';
import { collectLiveAgentContainers, getAgentsRegistry } from './docker/containerRegistry.js';

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
        state: {
            status: 'stopped',
            running: false,
            pid: 0,
        },
        config: record?.config || {},
    };
}

function registryRuntimeIdentity(record) {
    const instanceId = typeof record?.instanceId === 'string' ? record.instanceId : '';
    const enableGeneration = typeof record?.enableGeneration === 'string'
        ? record.enableGeneration
        : '';
    if (!instanceId
        || !enableGeneration
        || instanceId !== instanceId.trim()
        || enableGeneration !== enableGeneration.trim()) {
        return null;
    }
    return Object.freeze({ instanceId, enableGeneration });
}

function hostRuntimeOwnership(containerName, record, owner) {
    return {
        role: 'service',
        runtimeKey: containerName,
        ownerKey: owner?.ownerKey || serviceOwnerKey(containerName),
        instanceId: owner?.instanceId || String(record?.instanceId || ''),
        enableGeneration: owner?.enableGeneration || String(record?.enableGeneration || ''),
        homeKey: owner?.homeKey || String(record?.homeKey || containerName),
        workdir: owner?.workdir || String(record?.workdir || record?.projectPath || '-'),
        logPath: owner?.logPath || String(record?.logPath || '-'),
        taskId: '',
        provider: '',
        processIdentity: owner?.processIdentity || '',
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
    const readSandboxServiceOwner = options.readSandboxServiceOwner || readServiceOwner;
    const sandboxOwnerRunning = options.isSandboxOwnerRunning || isSandboxOwnerRunning;
    const containersByName = new Map(liveContainers.map((entry) => [String(entry?.containerName || ''), entry]));
    const matchedContainers = new Set();
    const states = [];

    for (const [containerName, record] of Object.entries(registry)) {
        if (!record || record.type !== 'agent') continue;
        const liveEntry = containersByName.get(containerName) || null;
        const runtime = normalizeRuntime(record);

        if (HOST_SANDBOX_RUNTIMES.has(runtime)) {
            const owner = readSandboxServiceOwner(containerName);
            const runtimeIdentity = registryRuntimeIdentity(record);
            const identityMatches = Boolean(owner
                && runtimeIdentity
                && owner.instanceId === runtimeIdentity.instanceId
                && owner.enableGeneration === runtimeIdentity.enableGeneration);
            const running = identityMatches && Boolean(sandboxOwnerRunning(owner.ownerKey, {
                ...runtimeIdentity,
                role: 'service',
                runtimeKey: containerName,
            }));
            states.push({
                ...stoppedRuntimeEntry(containerName, record, runtime),
                ...hostRuntimeOwnership(containerName, record, owner),
                state: {
                    status: running ? 'running' : 'stopped',
                    running,
                    pid: running ? owner.pid : 0,
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

export {
    HOST_SANDBOX_RUNTIMES,
    collectAgentRuntimeStates,
};
