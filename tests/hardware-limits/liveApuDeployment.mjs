import { APU_CASES, APU_PARAMS } from './liveApuPins.mjs';
import { jsonDigest } from './liveCommon.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const identity = ['controllerInstanceId', 'deploymentId', 'requestId', 'pid', 'command', 'launchSeq', 'logSeqStart', 'startedMonotonicMs'];
const requestFor = (runId, caseId) => `apu-${runId}-${caseId.slice(5).toLowerCase()}`;

// The local-llm controller's weight-transfer phases (TRANSFER_PHASES in
// src/controller/deployments.mjs). For controller-fetched GGUF weights they
// all precede the runner launch: a Run clears the APU launch record, and
// launchRunner sets it only after the transfer and the pre-load recheck.
export const APU_TRANSFER_PHASES = Object.freeze(['downloading', 'copying', 'verifying']);
const LAUNCH_PHASES = Object.freeze(['starting', 'ready', 'stopping', 'idle', 'paused', 'error']);

// Admission/transfer/starting/error observations bind the requested deployment
// without imposing the functional case's ready state or inference answer.
export function validateApuDeployment(state, { profile, requestId, launch = null, requireLaunch = false }) {
    const deployment = state?.deployment; const pins = profile.llm.models.small;
    const backend = profile.model.profile === 'amd-apu-cpu' ? 'cpu' : 'apu';
    const runner = backend === 'cpu' ? 'llama.cpp' : 'llama.cpp-vulkan';
    const observed = state?.apuObservation;
    const launchObserved = Boolean(requireLaunch || observed || launch);
    check(state?.profile === backend && deployment?.profile === backend
        && /^[A-Za-z0-9_.-]{1,128}$/.test(deployment.id || '') && deployment.requestId === requestId
        && deployment.modelId === pins.id && deployment.runnerId === runner
        && (LAUNCH_PHASES.includes(state.phase) || APU_TRANSFER_PHASES.includes(state.phase) && !launchObserved)
        && deployment.phase === state.phase && jsonDigest(deployment.params) === jsonDigest(APU_PARAMS)
        && ['repo', 'file', 'commit', 'size', 'sha256'].every(key => deployment.artifact?.[key] === pins[key]),
    'APU launched deployment model, artifact or parameters differ');
    if (launchObserved) {
        check(backend === 'apu' && observed && /^[A-Za-z0-9_.-]{1,128}$/.test(observed.controllerInstanceId || '')
            && observed.deploymentId === deployment.id && observed.requestId === requestId
            && observed.command === profile.model.executable.path && Number.isSafeInteger(observed.pid) && observed.pid > 0
            && Number.isSafeInteger(observed.logSeqStart) && observed.logSeqStart >= 0
            && deployment.logSeqStart === observed.logSeqStart && Number.isSafeInteger(observed.launchSeq)
            && observed.launchSeq > observed.logSeqStart && Number.isFinite(observed.startedMonotonicMs) && observed.startedMonotonicMs >= 0
            && (!launch || identity.every(key => observed[key] === launch[key])), 'APU launched deployment identity differs');
    }
    return state;
}

export function captureApuAllocation(state, { caseId, requestId }) {
    return { case: caseId, requestId, status: structuredClone({ phase: state.phase, profile: state.profile,
        deployment: state.deployment, apuObservation: Object.fromEntries(identity.map(key => [key, state.apuObservation?.[key]])) }), nextSeq: state.nextSeq,
        buffers: Object.fromEntries(['modelMiB', 'kvMiB', 'computeMiB'].map(key => [key, state.runnerReport?.[key] ?? null])),
        overheadBytes: 268435456 };
}

export function apuAllocationBytes(evidence, { runId, profile, caseId, requestId }) {
    check(evidence && evidence.case === caseId && evidence.requestId === requestId
        && APU_CASES[profile.model.profile]?.includes(caseId) && caseId !== 'LIVE-L9'
        && requestId === requestFor(runId, caseId), 'AMD allocation evidence belongs to another case');
    validateApuDeployment(evidence.status, { profile, requestId, requireLaunch: true });
    check(Number.isSafeInteger(evidence.nextSeq) && evidence.nextSeq >= evidence.status.apuObservation.launchSeq
        && evidence.overheadBytes === 268435456 && evidence.buffers && Object.keys(evidence.buffers).sort().join(',') === 'computeMiB,kvMiB,modelMiB',
    'AMD allocation report unavailable');
    const values = Object.values(evidence.buffers);
    check(values.every(value => value === null || Number.isFinite(value) && value >= 0), 'AMD allocation buffers invalid');
    const bytes = Math.ceil(values.reduce((sum, value) => sum + (value ?? 0), 0) * 1048576) + evidence.overheadBytes;
    check(Number.isSafeInteger(bytes) && bytes >= evidence.overheadBytes, 'AMD allocation allowance unsafe');
    return bytes;
}
