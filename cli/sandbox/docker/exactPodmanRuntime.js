import { spawnSync } from 'node:child_process';

import { NETWORK_LABELS } from '../networkLifecycle.js';
import { NETWORK_SCHEMA_VERSION } from '../networkContract.js';

export const PODMAN_RUNTIME_IDENTITY_INVALID = 'PLOINKY_PODMAN_RUNTIME_IDENTITY_INVALID';
export const PODMAN_CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;

function identityError(message) {
    const error = new Error(`exact Podman runtime identity ${message}`);
    error.code = PODMAN_RUNTIME_IDENTITY_INVALID;
    return error;
}

function exactText(value) {
    return typeof value === 'string' && value !== '' && value === value.trim();
}

export function requireExactPodmanRuntimeIdentity(input = {}) {
    if (input.runtime !== 'podman') {
        throw identityError("requires runtime exactly 'podman'");
    }
    const containerName = input.containerName;
    if (!exactText(containerName) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerName)) {
        throw identityError('requires one exact containerName');
    }
    const containerId = input.containerId;
    if (!PODMAN_CONTAINER_ID_PATTERN.test(String(containerId || ''))) {
        throw identityError('requires one immutable lowercase 64-hex containerId');
    }
    const instanceId = input.instanceId;
    const enableGeneration = input.enableGeneration;
    const releaseGeneration = String(input.releaseGeneration || '');
    if (!exactText(instanceId) || !exactText(enableGeneration)) {
        throw identityError('requires exact instanceId and enableGeneration');
    }
    if (releaseGeneration && !/^[a-f0-9]{64}$/.test(releaseGeneration)) {
        throw identityError('requires releaseGeneration to be empty or an exact lowercase 64-hex digest');
    }
    return Object.freeze({
        runtime: 'podman',
        containerName,
        containerId,
        instanceId,
        enableGeneration,
        releaseGeneration,
    });
}

function runtimeFailure(result) {
    return String(
        result?.error?.message
        || result?.stderr
        || result?.stdout
        || `exit ${result?.status ?? 'unknown'}`,
    ).trim();
}

export function inspectExactPodmanRuntimeIdentity(input, {
    spawnSyncImpl = spawnSync,
} = {}) {
    const identity = requireExactPodmanRuntimeIdentity(input);
    const result = spawnSyncImpl('podman', ['container', 'inspect', identity.containerId], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
        killSignal: 'SIGKILL',
    });
    if (result?.error || result?.status !== 0) {
        throw identityError(
            `could not inspect immutable container '${identity.containerId}': ${runtimeFailure(result)}`,
        );
    }
    let parsed;
    try {
        parsed = JSON.parse(String(result.stdout || ''));
    } catch (cause) {
        throw identityError(`inspection returned malformed JSON: ${cause.message}`);
    }
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    const labels = record?.Config?.Labels || {};
    const inspectedId = String(record?.Id || record?.ID || '');
    const inspectedName = String(record?.Name || '').replace(/^\//, '');
    if (inspectedId !== identity.containerId
        || inspectedName !== identity.containerName
        || labels[NETWORK_LABELS.managed] !== '1'
        || labels[NETWORK_LABELS.resource] !== 'agent'
        || labels[NETWORK_LABELS.schema] !== NETWORK_SCHEMA_VERSION
        || labels[NETWORK_LABELS.instanceId] !== identity.instanceId
        || labels[NETWORK_LABELS.enableGeneration] !== identity.enableGeneration
        || String(labels[NETWORK_LABELS.releaseGeneration] || '') !== identity.releaseGeneration) {
        throw identityError(
            `does not match the exact managed record for '${identity.containerName}'`,
        );
    }
    return Object.freeze({ identity, inspection: record });
}

export default {
    inspectExactPodmanRuntimeIdentity,
    requireExactPodmanRuntimeIdentity,
};
