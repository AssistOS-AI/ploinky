import { spawnSync } from 'node:child_process';
import { readBoxGpuGrant } from '../../../ploinky-box/lib/gpuGrantMarker.mjs';
import { createMpsStateStore, createMpsDaemonBackend } from './mps.mjs';
import { MpsError, observeMpsGpu, inspectMpsImage, resolveMpsShare } from './mpsEligibility.mjs';

/** Bounded observations only: never prepares an image or starts a daemon. */
export function readMpsStatus({ workspaceRoot, readGrant = readBoxGpuGrant, observeGpu = observeMpsGpu,
    readState = () => createMpsStateStore().read(), backend = createMpsDaemonBackend() } = {}) {
    let internal = {};
    const finish = (value) => Object.defineProperties(value, { facts: { value: internal.facts }, grant: { value: internal.grant } });
    const result = { eligible: false, mode: 'unavailable', assurance: 'best-effort', daemonStatus: 'unknown', serverDefault: null, mpsGeneration: null };
    try {
        const grant = readGrant({ workspaceRoot });
        if (!grant.valid || grant.state !== 'active' || !grant.mps) throw new MpsError('Active GPU wiring and both host MPS tools are required. Restart the Box after installing the matching driver tools.');
        const gpu = observeGpu();
        internal = { facts: gpu, grant };
        Object.assign(result, { eligible: true, mode: 'mps-shared', memoryModel: gpu.memoryModel, name: gpu.name, deviceUuid: gpu.uuid, driverVersion: gpu.driverVersion, deviceMemoryBytes: gpu.memoryMiB * 1048576, wiringFingerprint: grant.fingerprint });
        const state = readState();
        if (!state || (state.status === 'inactive' && !state.daemon && !state.pipeDirectory)) return finish({ ...result, daemonStatus: 'stopped' });
        const owned = backend.observe(state).state;
        const sameHardware = state.serverDefault?.deviceUuid === gpu.uuid && state.serverDefault?.driverVersion === gpu.driverVersion && state.serverDefault?.wiringFingerprint === grant.fingerprint;
        const verified = sameHardware && owned === 'owned' && state.status === 'ready' && backend.verify(state);
        result.daemonStatus = verified ? 'ready' : owned === 'gone' ? 'lost' : 'pending';
        if (verified) {
            result.serverDefault = { smPercent: state.serverDefault.smPercent, vramMiB: state.serverDefault.memoryMiB };
            result.mpsGeneration = `${state.daemonGeneration}:${state.configurationGeneration}`;
        }
        result.pendingClients = (Array.isArray(state.pendingClients) ? state.pendingClients : []).slice(0, 256).map(({ key, instanceId, enableGeneration }) => ({ key, instanceId, enableGeneration }));
        if (!verified) result.reason = 'MPS generation requires lifecycle recovery before clients can be ready.';
        return finish(result);
    } catch (_) {
        return finish({ ...result, eligible: false, reason: 'GPU sharing facts or daemon ownership could not be verified. Inspect GPU wiring and MPS tools, then retry.', code: 'gpu_sharing_unavailable' });
    }
}

export function inspectPreparedMpsImage(image, { runtime = 'podman', query = spawnSync } = {}) {
    if (!['podman', 'docker'].includes(runtime) || typeof image !== 'string' || !image || image.startsWith('-') || image.length > 4096) throw new MpsError('A prepared container image is required', 'image_preparation_required');
    const reply = query(runtime, ['image', 'inspect', image], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (reply.status !== 0 || reply.error || reply.signal) throw new MpsError('Prepare the selected image through normal agent startup before saving its GPU share', 'image_preparation_required');
    try { return JSON.parse(reply.stdout); } catch (_) { throw new MpsError('The prepared image cannot be inspected', 'image_preparation_required'); }
}

export function inspectMpsTargetEligibility({ image, networkMode, agentRef, gpuShare, workspaceRoot, status },
    { inspectImage = inspectPreparedMpsImage, readGrant = readBoxGpuGrant, fsApi } = {}) {
    if (!status?.eligible) throw new MpsError(status?.reason || 'GPU sharing is unavailable');
    const grant = readGrant({ workspaceRoot });
    if (!grant.valid || grant.state !== 'active' || !grant.agents?.includes(agentRef) || grant.fingerprint !== status.wiringFingerprint) throw new MpsError('This exact agent does not have current GPU access. Check host GPU grants and restart the Box.');
    const prepared = inspectMpsImage({ image, networkMode }, { inspectImage });
    const share = resolveMpsShare(gpuShare, { memoryModel: status.memoryModel, memoryMiB: status.deviceMemoryBytes / 1048576, uuid: status.deviceUuid, driverVersion: status.driverVersion }, { grant, fsApi });
    return { ...status, imageUserKnown: true, imageId: prepared.imageId, imageUser: prepared.imageUser, share };
}
