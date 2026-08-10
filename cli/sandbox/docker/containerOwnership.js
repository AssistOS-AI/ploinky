// Non-destructive proof that a registry record still names one exact, owned
// container in this workspace.
//
// The strongest existing ownership predicate lived inside the destructive fleet
// lifecycle code, so read-only callers had no way to reuse it. A registry
// record that merely carries `runtime` and `containerId` is only a candidate:
// during staging the code spreads the predecessor record and rotates just
// `instanceId` and `enableGeneration`, so an old runtime and container id stay
// attached to a fresh tuple. Comparing the recorded tuple against the
// container's own labels is what rejects that staged predecessor, and it is
// also what stops a tampered registry from pointing at a foreign container.
//
// Nothing here inspects by name, enumerates candidates, adopts, repairs, or
// mutates anything.

import { spawnSync as spawnSyncDefault } from 'node:child_process';

import { NETWORK_LABELS, workspaceNetworkIdentity } from '../networkIdentity.js';
import { NETWORK_SCHEMA_VERSION } from '../networkContract.js';

export const IMMUTABLE_CONTAINER_ID = /^[a-f0-9]{64}$/;
export const OCI_LOG_RUNTIMES = Object.freeze(['docker', 'podman']);
const INSPECT_TIMEOUT_MS = 5_000;

export function containerOwnershipError(message) {
    const error = new Error(message);
    error.code = 'CONTAINER_OWNERSHIP_UNPROVEN';
    return error;
}

export function containerLabelsOf(inspected) {
    return inspected?.Config?.Labels || inspected?.Labels || inspected?.labels || {};
}

// Shared by the destructive fleet lifecycle and by read-only observers, so one
// change to the ownership contract cannot apply to only one of them.
export function assertExactContainerOwnership(name, record, inspected, expectedId, workspaceHash) {
    const actualId = String(inspected?.Id || inspected?.ID || '');
    const actualName = String(inspected?.Name || '').replace(/^\//, '');
    if (actualId !== expectedId || actualName !== name) {
        throw containerOwnershipError(
            `container ownership for '${name}' could not prove exact immutable container identity`,
        );
    }
    if (record?.type !== 'agent') {
        throw containerOwnershipError(
            `container ownership for '${name}' requires a current managed-agent registry record`,
        );
    }
    const expectedInstanceId = typeof record?.instanceId === 'string'
        && record.instanceId === record.instanceId.trim() ? record.instanceId : '';
    const expectedEnableGeneration = typeof record?.enableGeneration === 'string'
        && record.enableGeneration === record.enableGeneration.trim() ? record.enableGeneration : '';
    const labels = containerLabelsOf(inspected);
    if (!expectedInstanceId || !expectedEnableGeneration
        || labels?.[NETWORK_LABELS.managed] !== '1'
        || labels?.[NETWORK_LABELS.resource] !== 'agent'
        || labels?.[NETWORK_LABELS.schema] !== NETWORK_SCHEMA_VERSION
        || labels?.[NETWORK_LABELS.workspace] !== workspaceHash
        || !/^[a-f0-9]{64}$/.test(String(labels?.[NETWORK_LABELS.contract] || ''))
        || String(labels?.[NETWORK_LABELS.instanceId] || '') !== expectedInstanceId
        || String(labels?.[NETWORK_LABELS.enableGeneration] || '') !== expectedEnableGeneration
        || inspected?.HostConfig?.Init !== true) {
        throw containerOwnershipError(
            `container ownership for '${name}' could not prove exact managed ownership labels and runtime identity`,
        );
    }
    return inspected;
}

export function inspectExactContainerById(runtime, containerId, {
    spawnSyncImpl = spawnSyncDefault,
} = {}) {
    const result = spawnSyncImpl(runtime, ['container', 'inspect', containerId], {
        encoding: 'utf8',
        timeout: INSPECT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        killSignal: 'SIGKILL',
    });
    if (result?.error) throw result.error;
    if (result?.status !== 0) return null;
    let parsed;
    try {
        parsed = JSON.parse(String(result.stdout || ''));
    } catch (_) {
        // Container inspection includes the full environment. Never attach a
        // parser excerpt from untrusted engine output to an operator-facing
        // diagnostic.
        throw containerOwnershipError('container inspection returned malformed JSON');
    }
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    return record && typeof record === 'object' ? record : null;
}

// Read-only. Returns the proved OCI source for a running or stopped container,
// or throws. A missing container is not retrievable and is not repaired.
export function proveExactOciLogSource(containerName, record, {
    inspect = inspectExactContainerById,
    workspaceIdentity = workspaceNetworkIdentity,
} = {}) {
    const name = String(containerName || '').trim();
    if (!name) {
        throw containerOwnershipError('an OCI log source requires one canonical registry key');
    }
    if (record?.type !== 'agent') {
        throw containerOwnershipError(`'${name}' is not one enabled agent record`);
    }
    const runtime = String(record?.runtime || '').trim();
    if (!OCI_LOG_RUNTIMES.includes(runtime)) {
        throw containerOwnershipError(`'${name}' does not record one supported OCI runtime`);
    }
    const containerId = String(record?.containerId || '').trim();
    if (!IMMUTABLE_CONTAINER_ID.test(containerId)) {
        throw containerOwnershipError(`'${name}' does not record one immutable 64-hex container id`);
    }
    if (typeof record?.instanceId !== 'string'
        || record.instanceId !== record.instanceId.trim()
        || !record.instanceId
        || typeof record?.enableGeneration !== 'string'
        || record.enableGeneration !== record.enableGeneration.trim()
        || !record.enableGeneration) {
        throw containerOwnershipError(`'${name}' does not record one complete runtime identity tuple`);
    }

    const workspaceHash = String(workspaceIdentity()?.hash || '');
    if (!workspaceHash) {
        throw containerOwnershipError(`'${name}' could not resolve the current workspace identity`);
    }

    // Inspect only the recorded immutable id with the recorded runtime; never
    // look a container up by name.
    const inspected = inspect(runtime, containerId);
    if (!inspected) {
        throw containerOwnershipError(`the recorded container for '${name}' no longer exists`);
    }
    assertExactContainerOwnership(name, record, inspected, containerId, workspaceHash);

    return Object.freeze({
        runtime,
        containerId,
        running: inspected?.State?.Running === true,
    });
}
