const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIMES = new Set(['podman', 'docker']);

export function normalizeRelayDescriptor(input = {}) {
    const kind = String(input.kind || 'container-exec-stdio');
    const runtime = String(input.runtime || '');
    const containerId = String(input.containerId || '').trim().toLowerCase();
    const containerName = String(input.containerName || '').trim();
    const targetAgentId = String(input.targetAgentId || '').trim();
    const effectiveInstanceId = String(input.effectiveInstanceId || '').trim();
    const networkMode = String(input.networkMode || '').trim().toLowerCase();
    if (kind !== 'container-exec-stdio') throw new Error('relayConfinement: unsupported relay kind');
    if (!RUNTIMES.has(runtime)) throw new Error('relayConfinement: docker or podman runtime required');
    if (!CONTAINER_ID_PATTERN.test(containerId)) throw new Error('relayConfinement: immutable full container id required');
    if (!containerName || !targetAgentId || !effectiveInstanceId) throw new Error('relayConfinement: complete owner identity required');
    if (!networkMode || networkMode === 'host' || networkMode === 'none') {
        throw new Error('relayConfinement: dedicated container networking required');
    }
    return Object.freeze({ kind, runtime, containerId, containerName, targetAgentId, effectiveInstanceId, networkMode });
}

export function verifyInspectedContainer(descriptor, inspection) {
    const relay = normalizeRelayDescriptor(descriptor);
    const record = Array.isArray(inspection) ? inspection[0] : inspection;
    const actualId = String(record?.Id || record?.ID || '').trim().toLowerCase();
    const running = record?.State?.Running === true || String(record?.State?.Status || '').toLowerCase() === 'running';
    const networkMode = String(record?.HostConfig?.NetworkMode || record?.NetworkSettings?.NetworkMode || '').trim().toLowerCase();
    const actualName = String(record?.Name || '').replace(/^\//, '');
    if (actualId !== relay.containerId) throw new Error('relayConfinement: stale container identity');
    if (!running) throw new Error('relayConfinement: container is not running');
    if (actualName && actualName !== relay.containerName) throw new Error('relayConfinement: container name/identity mismatch');
    if (!networkMode || networkMode === 'host' || networkMode === 'none') {
        throw new Error('relayConfinement: inspected container is not network-confined');
    }
    if (networkMode !== relay.networkMode) throw new Error('relayConfinement: container network changed');
    return relay;
}

export default { normalizeRelayDescriptor, verifyInspectedContainer };
