import {
    isSandboxOwnerRunning,
    collectServiceOwnersReadOnly,
    serviceOwnerKey,
} from './bwrap/bwrapFleet.js';
import { collectLiveAgentContainers, getAgentsRegistry } from './docker/containerRegistry.js';
import { classifyProviderTaskOwnersReadOnly } from './providerTaskOwnership.js';
import { loadActiveEdgeRoutingGeneration } from './edgeGeneration.js';

const HOST_SANDBOX_RUNTIMES = new Set(['bwrap', 'seatbelt']);
const AGENT_RUNTIME_STATE_INVALID_CODE = 'PLOINKY_AGENT_RUNTIME_STATE_INVALID';
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_GENERATION_PATTERN = /^[a-f0-9]{64}$/;

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
    const releaseGeneration = String(record?.releaseGeneration || '');
    if (releaseGeneration && !RELEASE_GENERATION_PATTERN.test(releaseGeneration)) {
        throw invalidRuntimeState(containerName, 'requires an exact releaseGeneration');
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
        && exactIdentityText(entry?.enableGeneration)
        && (String(entry?.releaseGeneration || '') === ''
            || RELEASE_GENERATION_PATTERN.test(String(entry.releaseGeneration)));
}

function podmanIdentityKey(containerName, identity) {
    return [
        containerName,
        identity.containerId,
        identity.instanceId,
        identity.enableGeneration,
        String(identity.releaseGeneration || ''),
    ].join('\0');
}

function publicLiveRuntimeEntry(entry) {
    const {
        containerId: _containerId,
        enableGeneration: _enableGeneration,
        instanceId: _instanceId,
        releaseGeneration: _releaseGeneration,
        ownershipVerified: _ownershipVerified,
        ...visible
    } = entry;
    return visible;
}

function effectiveRuntimeAlias(containerName, record) {
    const alias = String(record?.alias || record?.agentName || containerName);
    return exactIdentityText(alias) && !/[\u0000-\u001f\u007f]/u.test(alias)
        ? alias
        : containerName;
}

function podmanLogSource(record) {
    return `podman://${String(record.containerId)}`;
}

function exactAuthenticatedReadiness(active, containerName, record, running) {
    if (!running || active?.selector?.state !== 'active'
        || active?.selector?.publicationState !== 'ready') return 'not-ready';
    const selected = active?.generation?.agents?.[containerName];
    return selected?.type === 'agent'
        && selected.runtime === record.runtime
        && selected.instanceId === record.instanceId
        && selected.enableGeneration === record.enableGeneration
        && String(selected.releaseGeneration || '') === String(record.releaseGeneration || '')
        ? 'ready'
        : 'not-ready';
}

function stoppedRuntimeEntry(containerName, record, runtime) {
    const effectiveInstance = effectiveRuntimeAlias(containerName, record);
    return {
        role: 'service',
        runtimeKey: containerName,
        ownerKey: runtime === 'podman'
            ? `container:${String(record?.containerId || '')}`
            : serviceOwnerKey(containerName),
        instanceId: String(record?.instanceId || ''),
        enableGeneration: String(record?.enableGeneration || ''),
        releaseGeneration: String(record?.releaseGeneration || ''),
        homeKey: String(record?.homeKey || containerName),
        workdir: String(record?.workdir || record?.projectPath || '-'),
        logPath: runtime === 'podman'
            ? podmanLogSource(record)
            : String(record?.logPath || '-'),
        readiness: 'not-ready',
        alias: effectiveInstance,
        effectiveInstance,
        taskId: '',
        provider: '',
        processIdentity: runtime === 'podman'
            ? `container:${String(record?.containerId || '')}`
            : '',
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
    const releaseGeneration = typeof record?.releaseGeneration === 'string'
        ? record.releaseGeneration
        : '';
    if (!instanceId
        || !enableGeneration
        || instanceId !== instanceId.trim()
        || enableGeneration !== enableGeneration.trim()
        || (releaseGeneration && !RELEASE_GENERATION_PATTERN.test(releaseGeneration))) {
        return null;
    }
    return Object.freeze({ instanceId, enableGeneration, releaseGeneration });
}

function hostRuntimeOwnership(containerName, record, owner) {
    return {
        role: 'service',
        runtimeKey: containerName,
        ownerKey: owner?.ownerKey || serviceOwnerKey(containerName),
        instanceId: owner?.instanceId || String(record?.instanceId || ''),
        enableGeneration: owner?.enableGeneration || String(record?.enableGeneration || ''),
        releaseGeneration: owner?.releaseGeneration || String(record?.releaseGeneration || ''),
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
    const sandboxServiceOwners = options.readSandboxServiceOwner
        ? null
        : new Map((options.collectSandboxServiceOwners || collectServiceOwnersReadOnly)()
            .map((owner) => [owner.runtimeKey, owner]));
    const readSandboxServiceOwner = options.readSandboxServiceOwner
        || ((runtimeKey) => sandboxServiceOwners.get(runtimeKey) || null);
    const sandboxOwnerRunning = options.isSandboxOwnerRunning || isSandboxOwnerRunning;
    const providerClassifications = Object.hasOwn(options, 'providerOwners')
        ? (options.providerOwners || []).map((owner) => ({
            classification: owner.classification || 'live',
            owner: owner.owner || owner,
            processAuthority: 'inner-runtime-attestation',
        }))
        : (options.classifyProviderOwners || classifyProviderTaskOwnersReadOnly)();
    let activeEdgeGeneration = Object.hasOwn(options, 'activeEdgeGeneration')
        ? options.activeEdgeGeneration
        : undefined;
    if (activeEdgeGeneration === undefined) {
        try {
            activeEdgeGeneration = (options.loadActiveGeneration || loadActiveEdgeRoutingGeneration)();
        } catch (_) {
            activeEdgeGeneration = null;
        }
    }
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
                && String(owner.releaseGeneration || '') === runtimeIdentity.releaseGeneration
                && owner.homeKey === record.homeKey);
            const running = identityMatches && Boolean(sandboxOwnerRunning(owner.ownerKey, {
                ...runtimeIdentity,
                role: 'service',
                runtimeKey: containerName,
            }));
            states.push({
                ...stoppedRuntimeEntry(containerName, record, runtime),
                ...hostRuntimeOwnership(containerName, record, identityMatches ? owner : null),
                readiness: exactAuthenticatedReadiness(
                    activeEdgeGeneration,
                    containerName,
                    record,
                    running,
                ),
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
                role: 'service',
                runtimeKey: containerName,
                ownerKey: `container:${record.containerId}`,
                instanceId: record.instanceId,
                enableGeneration: record.enableGeneration,
                releaseGeneration: String(record.releaseGeneration || ''),
                homeKey: containerName,
                workdir: String(record.workdir || record.projectPath || '-'),
                logPath: podmanLogSource(record),
                readiness: exactAuthenticatedReadiness(
                    activeEdgeGeneration,
                    containerName,
                    record,
                    true,
                ),
                alias: effectiveRuntimeAlias(containerName, record),
                effectiveInstance: effectiveRuntimeAlias(containerName, record),
                taskId: '',
                provider: '',
                processIdentity: `container:${record.containerId}`,
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

    const serviceByRuntime = new Map(states
        .filter((state) => state.role === 'service')
        .map((state) => [state.runtimeKey, state]));
    for (const classified of providerClassifications) {
        const owner = classified.owner;
        const record = registry?.[owner?.runtimeKey];
        const exactHomeSelection = record?.runtime === 'podman'
            ? owner?.homeKey === owner?.runtimeKey
            : typeof record?.homeKey === 'string' && record.homeKey === owner?.homeKey;
        const exactSelection = Boolean(record && record.type === 'agent'
            && record.instanceId === owner.instanceId
            && record.enableGeneration === owner.enableGeneration
            && String(record.releaseGeneration || '') === String(owner.releaseGeneration || '')
            && exactHomeSelection);
        let selectionValid = exactSelection;
        if (exactSelection) {
            const selectedRuntime = validateRegistryRuntime(owner.runtimeKey, record);
            const expectedDisplayRuntime = selectedRuntime === 'podman' ? 'container' : selectedRuntime;
            selectionValid = owner.role === 'provider-task' && owner.runtime === expectedDisplayRuntime;
        }
        const parent = serviceByRuntime.get(owner.runtimeKey);
        const parentRunning = Boolean(selectionValid && parent?.state?.running === true);
        const parentReady = Boolean(parentRunning && parent?.readiness === 'ready');
        const live = parentReady && classified.classification === 'live';
        const failedClassification = !selectionValid
            ? 'generation-mismatch'
            : !parentRunning
                ? 'parent-runtime-contained'
                : !parentReady
                    ? 'parent-runtime-not-ready'
                : classified.classification;
        states.push({
            role: 'provider-task',
            runtimeKey: owner.runtimeKey,
            ownerKey: owner.ownerKey,
            containerName: owner.runtimeKey,
            agentName: String(record?.agentName || '-'),
            repoName: String(record?.repoName || '-'),
            runtime: owner.runtime,
            enabled: selectionValid,
            alias: owner.alias,
            effectiveInstance: owner.alias,
            instanceId: owner.instanceId,
            enableGeneration: owner.enableGeneration,
            releaseGeneration: String(owner.releaseGeneration || ''),
            homeKey: owner.homeKey,
            workdir: owner.workdir,
            logPath: owner.logPath,
            taskId: owner.taskId,
            provider: owner.provider,
            mode: owner.mode,
            pid: owner.pid,
            processGroupId: owner.processGroupId,
            processIdentity: owner.processIdentity,
            readiness: owner.readiness,
            classification: failedClassification,
            processAuthority: 'inner-runtime-attestation',
            state: {
                status: live ? 'running' : 'failed',
                running: live,
                pid: owner.pid,
            },
        });
    }

    return states;
}

export {
    AGENT_RUNTIME_STATE_INVALID_CODE,
    HOST_SANDBOX_RUNTIMES,
    collectAgentRuntimeStates,
};
