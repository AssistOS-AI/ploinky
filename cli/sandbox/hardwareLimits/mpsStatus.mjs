import { spawnSync } from 'node:child_process';
import { readBoxGpuGrant } from '../../../ploinky-box/lib/gpuGrantMarker.mjs';
import { createMpsStateStore, createMpsDaemonBackend } from './mps.mjs';
import { MpsError, observeMpsGpu, inspectMpsImage, resolveMpsShare, unsupportedGpuMemoryModelReason, UNSUPPORTED_GPU_MEMORY_MODEL_FIX } from './mpsEligibility.mjs';

const GENERIC_FIX = 'Inspect GPU wiring and MPS tools, then retry.';
const oneLine = (value, limit = 400) => String(value ?? '').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);

// Why this Box's grant marker does not allow MPS, specifically: no marker, an invalid one, wiring that is not
// active, the host's MPS tools that were not discovered when the Box was created, or tools that no longer match.
export function mpsGrantProblem(grant) {
    if (!grant?.present) return 'No GPU grant marker is mounted in this Box, so there is no GPU wiring.';
    if (!grant.valid) return `The GPU grant marker is invalid: ${oneLine(grant.problem)}.`;
    if (grant.state !== 'active') return `The GPU wiring is ${oneLine(grant.state, 40)}${grant.reason ? ` (${oneLine(grant.reason)})` : ''}, not active.`;
    if (grant.mpsProblem) return `The MPS tools of the wiring cannot be used in this Box: ${oneLine(grant.mpsProblem)}.`;
    if (grant.mpsDiscoveryProblem) return `The host's MPS tools were not wired when the Box was created: ${oneLine(grant.mpsDiscoveryProblem)}.`;
    return 'The GPU wiring carries no MPS tools: the Box was created without the hardware-limits gate, or the host has no MPS tools.';
}

/** Bounded observations only: never prepares an image or starts a daemon. */
export function readMpsStatus({ workspaceRoot, readGrant = readBoxGpuGrant, observeGpu = observeMpsGpu,
    readState = () => createMpsStateStore().read(), backend = createMpsDaemonBackend() } = {}) {
    let internal = {};
    const finish = (value) => Object.defineProperties(value, { facts: { value: internal.facts }, grant: { value: internal.grant } });
    const result = { eligible: false, mode: 'unavailable', assurance: 'best-effort', daemonStatus: 'unknown', serverDefault: null, mpsGeneration: null };
    try {
        const grant = readGrant({ workspaceRoot });
        if (!grant.valid || grant.state !== 'active' || !grant.mps) throw new MpsError(`${mpsGrantProblem(grant)} Active GPU wiring and both host MPS tools are required.`);
        const gpu = observeGpu();
        internal = { facts: gpu, grant };
        Object.assign(result, { eligible: true, mode: 'mps-shared', memoryModel: gpu.memoryModel, name: gpu.name, deviceUuid: gpu.uuid, driverVersion: gpu.driverVersion, deviceMemoryBytes: gpu.memoryMiB * 1048576, wiringFingerprint: grant.fingerprint });
        const state = readState();
        if (!state || (state.status === 'inactive' && !state.daemon && !state.pipeDirectory)) return finish({ ...result, daemonStatus: 'stopped' });
        const owned = backend.observe(state).state;
        const sameHardware = state.serverDefault?.deviceUuid === gpu.uuid && state.serverDefault?.driverVersion === gpu.driverVersion && state.serverDefault?.wiringFingerprint === grant.fingerprint;
        // Daemon health comes from the daemon itself: an owned process whose
        // defaults read back. A failed or pending client (state.status
        // 'pending', pendingClients) never makes a healthy daemon look lost.
        const verified = sameHardware && owned === 'owned' && Boolean(state.daemonGeneration && state.configurationGeneration) && backend.verify(state);
        result.daemonStatus = verified ? 'ready' : owned === 'gone' ? 'lost' : 'pending';
        if (verified) {
            // vramMiB is the daemon's configured default (a whole GiB); shareMemoryMiB is the largest share it was derived from.
            result.serverDefault = { smPercent: state.serverDefault.smPercent, vramMiB: state.serverDefault.memoryMiB, shareMemoryMiB: state.serverDefault.shareMemoryMiB ?? null };
            result.mpsGeneration = `${state.daemonGeneration}:${state.configurationGeneration}`;
        }
        result.pendingClients = (Array.isArray(state.pendingClients) ? state.pendingClients : []).slice(0, 256).map(({ key, instanceId, enableGeneration }) => ({ key, instanceId, enableGeneration }));
        result.clientsPending = result.pendingClients.length > 0 || state.status === 'pending';
        if (!verified) result.reason = 'MPS generation requires lifecycle recovery before clients can be ready.';
        return finish(result);
    } catch (error) {
        // A unified or unknown memory model is a definite refusal (§9.3),
        // not an unverifiable fact: keep the model and name it was refused for.
        if (error?.memoryModel === 'unified' || error?.memoryModel === 'unknown') {
            return finish({ ...result, eligible: false, memoryModel: error.memoryModel, name: String(error.gpuName || '').slice(0, 256),
                reason: `${unsupportedGpuMemoryModelReason(error.gpuName)} ${UNSUPPORTED_GPU_MEMORY_MODEL_FIX}`, code: 'gpu_sharing_unavailable' });
        }
        // The specific cause, bounded and one line, with the generic recovery step kept as the fix.
        const cause = oneLine(error?.message) || 'an unreadable fact';
        return finish({ ...result, eligible: false, reason: `GPU sharing facts or daemon ownership could not be verified: ${cause}`.slice(0, 600), code: 'gpu_sharing_unavailable', fix: GENERIC_FIX, ...(error?.code && error.code !== 'gpu_sharing_unavailable' && /^[a-z_]{3,64}$/.test(String(error.code)) ? { causeCode: error.code } : {}) });
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
