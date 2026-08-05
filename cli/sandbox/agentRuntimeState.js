import {
    isSandboxOwnerRunning,
    readServiceOwner,
    serviceOwnerKey,
} from './bwrap/bwrapFleet.js';
import { collectLiveAgentContainers, getAgentsRegistry } from './docker/containerRegistry.js';

const HOST_SANDBOX_RUNTIMES = new Set(['bwrap', 'seatbelt']);
const AGENT_RUNTIME_STATE_INVALID_CODE = 'PLOINKY_AGENT_RUNTIME_STATE_INVALID';
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;

function invalidRuntimeState(containerName, message) {
    const error = new Error(`agent runtime state '${containerName}' ${message}`);
    error.code = AGENT_RUNTIME_STATE_INVALID_CODE;
    return error;
}

function exactIdentityText(value) {
    return typeof value === 'string' && value !== '' && value === value.trim();
}

function validateRegistryRuntime(containerName, record) {
    const runtime = record?.runtime;
    if (runtime !== 'podman' && !HOST_SANDBOX_RUNTIMES.has(runtime)) {
        throw invalidRuntimeState(
            containerName,
            "requires exact runtime 'podman', 'bwrap', or 'seatbelt'",
        );
    }
    for (const field of ['instanceId', 'enableGeneration']) {
        if (!exactIdentityText(record?.[field])) {
            throw invalidRuntimeState(containerName, `requires exact ${field}`);
        }
    }
    if (runtime === 'podman' && !CONTAINER_ID_PATTERN.test(String(record?.containerId || ''))) {
        throw invalidRuntimeState(containerName, 'requires an immutable lowercase 64-hex containerId');
    }
    if (HOST_SANDBOX_RUNTIMES.has(runtime)
        && record?.homeKey !== `${containerName}.sandbox-v2`) {
        throw invalidRuntimeState(containerName, 'requires its exact sandbox-v2 HOME key');
    }
    return runtime;
}

function validLivePodmanIdentity(entry) {
    return entry?.runtime === 'podman'
        && entry?.ownershipVerified === true
        && CONTAINER_ID_PATTERN.test(String(entry?.containerId || ''))
        && exactIdentityText(entry?.instanceId)
        && exactIdentityText(entry?.enableGeneration);
}

function podmanIdentityKey(containerName, identity) {
    return [
        containerName,
        identity.containerId,
        identity.instanceId,
        identity.enableGeneration,
    ].join('\0');
}

function publicLiveRuntimeEntry(entry) {
    const {
        containerId: _containerId,
        enableGeneration: _enableGeneration,
        instanceId: _instanceId,
        ownershipVerified: _ownershipVerified,
        ...visible
    } = entry;
    return visible;
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
        homeKey: owner?.homeKey || record.homeKey,
        workdir: owner?.workdir || String(record?.workdir || record?.projectPath || '-'),
        logPath: owner?.logPath || String(record?.logPath || '-'),
        taskId: '',
        provider: '',
        processIdentity: owner?.processIdentity || '',
    };
}

/** Return one backend-neutral state record for every enabled agent runtime. */
function collectAgentRuntimeStates(options = {}) {
    const registry = options.registry || getAgentsRegistry() || {};
    const managedRecords = Object.entries(registry).filter(([, record]) => (
        record && record.type === 'agent'
    ));
    const runtimeByName = new Map(managedRecords.map(([containerName, record]) => [
        containerName,
        validateRegistryRuntime(containerName, record),
    ]));
    const hasPodmanRuntime = Array.from(runtimeByName.values()).includes('podman');
    const liveContainers = hasPodmanRuntime
        ? (Object.hasOwn(options, 'liveContainers')
            ? (options.liveContainers || [])
            : (options.collectContainers || collectLiveAgentContainers)() || [])
        : [];
    const readSandboxServiceOwner = options.readSandboxServiceOwner || readServiceOwner;
    const sandboxOwnerRunning = options.isSandboxOwnerRunning || isSandboxOwnerRunning;
    const containersByIdentity = new Map(liveContainers
        .filter(validLivePodmanIdentity)
        .map((entry) => [
            podmanIdentityKey(String(entry.containerName || ''), entry),
            entry,
        ]));
    const states = [];

    for (const [containerName, record] of managedRecords) {
        const runtime = runtimeByName.get(containerName);

        if (HOST_SANDBOX_RUNTIMES.has(runtime)) {
            const owner = readSandboxServiceOwner(containerName);
            const runtimeIdentity = registryRuntimeIdentity(record);
            const identityMatches = Boolean(owner
                && runtimeIdentity
                && owner.instanceId === runtimeIdentity.instanceId
                && owner.enableGeneration === runtimeIdentity.enableGeneration
                && owner.homeKey === record.homeKey);
            const running = identityMatches && Boolean(sandboxOwnerRunning(owner.ownerKey, {
                ...runtimeIdentity,
                role: 'service',
                runtimeKey: containerName,
            }));
            states.push({
                ...stoppedRuntimeEntry(containerName, record, runtime),
                ...hostRuntimeOwnership(containerName, record, identityMatches ? owner : null),
                state: {
                    status: running ? 'running' : 'stopped',
                    running,
                    pid: running ? owner.pid : 0,
                },
            });
            continue;
        }

        const liveIdentityKey = podmanIdentityKey(containerName, record);
        const liveEntry = containersByIdentity.get(liveIdentityKey) || null;
        if (liveEntry) {
            states.push({
                ...publicLiveRuntimeEntry(liveEntry),
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

    return states;
}

export {
    AGENT_RUNTIME_STATE_INVALID_CODE,
    HOST_SANDBOX_RUNTIMES,
    collectAgentRuntimeStates,
};
