import { spawnSync } from 'child_process';
import path from 'path';
import { debugLog } from '../../utils/utils.js';
import {
    NETWORK_LABELS,
    workspaceNetworkIdentity,
} from '../networkLifecycle.js';
import { NETWORK_SCHEMA_VERSION } from '../networkContract.js';
import { loadAgentsMap } from './common.js';

const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const WORKSPACE_HASH_PATTERN = /^[a-f0-9]{12}$/;
const CONTRACT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_GENERATION_PATTERN = /^[a-f0-9]{64}$/;

function exactLabelText(value) {
    return typeof value === 'string' && value !== '' && value === value.trim();
}

function inspectOwnership(data, expectedName, expectedIdentity = {}) {
    const labels = data?.Config?.Labels || {};
    const rawContainerId = data?.Id ?? data?.ID;
    const containerId = typeof rawContainerId === 'string' ? rawContainerId : '';
    const rawName = data?.Name;
    const inspectedName = typeof rawName === 'string' && rawName.startsWith('/')
        ? rawName.slice(1)
        : rawName;
    const instanceId = labels[NETWORK_LABELS.instanceId];
    const enableGeneration = labels[NETWORK_LABELS.enableGeneration];
    const releaseGeneration = String(labels[NETWORK_LABELS.releaseGeneration] || '');
    const workspaceHash = expectedIdentity?.workspaceHash;
    const expectedContainerId = expectedIdentity?.containerId;
    const expectedInstanceId = expectedIdentity?.instanceId;
    const expectedEnableGeneration = expectedIdentity?.enableGeneration;
    const expectedReleaseGeneration = String(expectedIdentity?.releaseGeneration || '');
    const exactExpectedIdentity = WORKSPACE_HASH_PATTERN.test(workspaceHash)
        && CONTAINER_ID_PATTERN.test(expectedContainerId)
        && exactLabelText(expectedInstanceId)
        && exactLabelText(expectedEnableGeneration)
        && (expectedReleaseGeneration === ''
            || RELEASE_GENERATION_PATTERN.test(expectedReleaseGeneration));
    const ownershipVerified = exactExpectedIdentity
        && CONTAINER_ID_PATTERN.test(containerId)
        && containerId === expectedContainerId
        && inspectedName === expectedName
        && labels[NETWORK_LABELS.managed] === '1'
        && labels[NETWORK_LABELS.resource] === 'agent'
        && labels[NETWORK_LABELS.schema] === NETWORK_SCHEMA_VERSION
        && labels[NETWORK_LABELS.workspace] === workspaceHash
        && CONTRACT_HASH_PATTERN.test(labels[NETWORK_LABELS.contract])
        && instanceId === expectedInstanceId
        && enableGeneration === expectedEnableGeneration
        && releaseGeneration === expectedReleaseGeneration;
    return {
        containerId,
        instanceId: exactLabelText(instanceId) ? instanceId : '',
        enableGeneration: exactLabelText(enableGeneration) ? enableGeneration : '',
        releaseGeneration,
        ownershipVerified,
    };
}

function parseAgentInfoFromMounts(mounts = []) {
    let repoName = '-';
    let agentName = '-';
    for (const mount of mounts) {
        if (mount.Destination === '/code' && mount.Source) {
            const parts = mount.Source.split(path.sep).filter(Boolean);
            const reposIdx = parts.lastIndexOf('repos');
            if (reposIdx !== -1 && reposIdx + 2 < parts.length) {
                repoName = parts[reposIdx + 1];
                agentName = parts[reposIdx + 2];
                break;
            }
        }
    }
    return { repoName, agentName };
}

function formatPortBindings(bindings = {}, defaultContainerPort = '') {
    const results = [];
    for (const [containerSpec, hostEntries] of Object.entries(bindings || {})) {
        const containerPort = parseInt(containerSpec, 10) || parseInt(containerSpec.split('/')[0], 10) || defaultContainerPort;
        if (Array.isArray(hostEntries)) {
            for (const entry of hostEntries) {
                if (!entry) continue;
                results.push({
                    hostIp: entry.HostIp || '127.0.0.1',
                    hostPort: entry.HostPort || '',
                    containerPort
                });
            }
        }
    }
    return results;
}

function getAgentsRegistry() {
    return loadAgentsMap();
}

/**
 * Inspect only immutable Podman IDs already admitted in this workspace's
 * registry. Global name discovery would allow a foreign or predecessor
 * runtime to become lifecycle authority again.
 */
function collectLiveAgentContainers({
    registry = loadAgentsMap(),
    workspaceHash = workspaceNetworkIdentity().hash,
    spawnSyncImpl = spawnSync,
} = {}) {
    if (!WORKSPACE_HASH_PATTERN.test(workspaceHash)) return [];
    const runtime = 'podman';
    const results = [];
    for (const [name, record] of Object.entries(registry || {})) {
        if (record?.type !== 'agent'
            || record.runtime !== runtime
            || !CONTAINER_ID_PATTERN.test(record.containerId)
            || !exactLabelText(record.instanceId)
            || !exactLabelText(record.enableGeneration)) {
            continue;
        }
        try {
            const inspected = spawnSyncImpl(
                runtime,
                ['container', 'inspect', record.containerId],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
            );
            if (inspected?.error || inspected?.status !== 0) continue;
            const parsed = JSON.parse(String(inspected?.stdout || ''));
            if (!Array.isArray(parsed) || parsed.length !== 1) continue;
            const data = parsed[0];
            const ownership = inspectOwnership(data, name, {
                workspaceHash,
                containerId: record.containerId,
                instanceId: record.instanceId,
                enableGeneration: record.enableGeneration,
                releaseGeneration: record.releaseGeneration,
            });
            if (!ownership.ownershipVerified || data?.State?.Running !== true) continue;
            const mounts = Array.isArray(data.Mounts) ? data.Mounts : [];
            const envPairs = Array.isArray(data.Config?.Env) ? data.Config.Env : [];
            const env = envPairs.map((entry) => {
                const idx = entry.indexOf('=');
                const key = idx === -1 ? entry : entry.slice(0, idx);
                return { name: key, value: idx === -1 ? '' : entry.slice(idx + 1) };
            });
            const mountIdentity = parseAgentInfoFromMounts(mounts);
            const ports = formatPortBindings(data.NetworkSettings?.Ports || {});
            results.push({
                containerName: name,
                runtime,
                ...ownership,
                agentName: exactLabelText(record.agentName)
                    ? record.agentName
                    : (env.find((entry) => entry.name === 'AGENT_NAME')?.value || mountIdentity.agentName),
                repoName: exactLabelText(record.repoName) ? record.repoName : mountIdentity.repoName,
                containerImage: data.Config?.Image || record.containerImage || '-',
                createdAt: data.Created || record.createdAt || '-',
                projectPath: record.projectPath || data.Config?.WorkingDir || '-',
                state: {
                    status: data.State?.Status || 'running',
                    running: true,
                    pid: data.State?.Pid || 0
                },
                config: {
                    binds: mounts.map((mount) => ({ source: mount.Source, target: mount.Destination })),
                    env,
                    ports
                }
            });
        } catch (error) {
            debugLog(`collectLiveAgentContainers: ${name} ${error?.message || error}`);
        }
    }
    return results;
}

export {
    collectLiveAgentContainers,
    formatPortBindings,
    getAgentsRegistry,
    inspectOwnership,
    parseAgentInfoFromMounts
};
