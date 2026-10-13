// Synthetic, offline evidence. Never used as a hardware observation.
import { APU_PARAMS, prepareApuModel } from './liveApuPins.mjs';
import { apuRequestId } from './liveApuEvidence.mjs';
export function fakeApuPin(profile = 'amd-apu') {
    return { profile, imageConfigDigest: `sha256:${'b'.repeat(64)}`, imageParentDigest: `sha256:${'c'.repeat(64)}`, cibRevision: 'd'.repeat(40),
        executable: { path: profile === 'amd-apu-cpu' ? '/opt/llama.cpp/llama-server' : '/opt/llama.cpp-vulkan/llama-server', sha256: 'e'.repeat(64), version: 'b11159' },
        amd: { pci: { vendor: '0x1002', device: '0x1638', revision: '0xc8', subsystemVendor: '0x1002', subsystemDevice: '0x1638' },
            render: { path: '/dev/dri/renderD128', major: 226, minor: 128, mode: '0666', driver: 'amdgpu' },
            host: { kernel: '6.8.0-test', os: 'ubuntu 24.04', memTotalBytes: 16 * 2 ** 30, availableBytes: 12 * 2 ** 30, umaLabel: 'C0' },
            memory: { vramTotalBytes: 2 ** 30, gttTotalBytes: 8 * 2 ** 30 },
            vulkan: { deviceName: 'AMD Radeon Graphics', deviceType: 'PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU', driverID: 'DRIVER_ID_MESA_RADV',
                deviceID: '0x1638', driverInfo: 'Mesa 25.3.6', apiVersion: '1.3.0', heaps: [{ sizeBytes: 9 * 2 ** 30, flags: 'DEVICE_LOCAL' }] },
            devices: { name: 'AMD Radeon Graphics', totalBytes: 9 * 2 ** 30, freeBytes: 8 * 2 ** 30 } } };
}
export const fakeApuCatalog = () => ({ models: [{ id: 'small', sources: { gguf: { size: 500000000 } }, memory: { kvBytesPerToken: 65536 } }] });
export function fakeApuActivity(sampledMonotonicMs = 1) {
    return { schema: 1, controllerInstanceId: 'controller-01234567', sampledMonotonicMs, modelJobsStarted: 1, runnerInstallsStarted: 2,
        modelLookupsStarted: 3, activeModelJobs: 0, activeRunnerInstalls: 0, activeModelLookups: 0, runnerRunning: false, valid: true };
}
export function fakeApuLaunch(requestId) {
    return { controllerInstanceId: 'controller-01234567', deploymentId: 'deployment-1', requestId, pid: 42,
        command: '/opt/llama.cpp-vulkan/llama-server', launchSeq: 2, logSeqStart: 0, startedMonotonicMs: 100,
        guardStop: null, running: true, firstSeq: 1, nextSeq: 5 };
}
export function fakeApuProof(caseId = 'LIVE-L11') {
    const model = prepareApuModel(fakeApuPin(caseId === 'LIVE-L10' ? 'amd-apu-pressure' : 'amd-apu'), fakeApuCatalog());
    const requestId = apuRequestId('a'.repeat(32), caseId);
    const launch = fakeApuLaunch(requestId);
    const process = { pid: 42, start: '1234', pgid: 42, exe: launch.command, sha256: model.executable.sha256 };
    const absence = { groupAbsent: true, pid: 42, start: '1234', pgid: 42 };
    const proof = { schema: 1, runId: 'a'.repeat(32), block: `linux-model-${model.profile}`, profile: model.profile, case: caseId, status: 'pass', requestId,
        before: { method: 'agent-procfs/v1', phase: 'idle', processes: [], monotonicMs: 1 },
        after: { method: 'agent-procfs/v1', phase: 'idle', processes: [], monotonicMs: 200 },
        launch, process, loadObservedPhase: 'starting', loadObservedSeq: 3, stopAfterSeq: 4,
        trace: { launch: structuredClone(launch), events: [{ seq: 1, kind: 'phase-starting' }, { seq: 2, kind: 'launch' },
            { seq: 3, kind: 'load-begin' }, { seq: 4, kind: 'other' }, { seq: 5, kind: 'phase-idle' }], nextSeq: 5, problem: null },
        stop: { tool: 'local_llm_stop', route: 'local-llm', requestId, deploymentId: launch.deploymentId,
            startedMonotonicMs: 130, settledMonotonicMs: 140, idleMonotonicMs: 150, settled: true, phase: 'idle', absence },
        hostGuard: { tripped: false, samples: [{ totalBytes: 16 * 2 ** 30, availableBytes: 12 * 2 ** 30, swapTotalBytes: 0, swapUsedBytes: 0, psiFull: 0 }] },
        env: { switchMatched: true, floorMatched: caseId === 'LIVE-L10', unexpectedSwitch: false, unexpectedFloor: false } };
    if (caseId === 'LIVE-L9') {
        const selected = model.refusal.selected;
        proof.refusal = { configuration: selected, status: selected.status, constraint: selected.constraint,
            method: 'controller-acquisition-no-entry/v1', certifiedTransferredBytes: 0, pre: fakeApuActivity(1), post: fakeApuActivity(4),
            apuAttempt: { schema: 1, attemptId: 'attempt-012345678', controllerInstanceId: 'controller-01234567', requestId,
                modelId: selected.modelId, runnerId: selected.runnerId, params: selected.params, boundary: 'initial-admission',
                before: fakeApuActivity(2), after: fakeApuActivity(3) } };
    }
    if (caseId === 'LIVE-L10') {
        proof.launch.guardStop = { kind: 'host-memory-floor', seq: 3, floorBytes: model.guardFloorBytes, availableBytes: 12 * 2 ** 30,
            killRequestedMonotonicMs: 1100, settledMonotonicMs: 1101, settlement: 'resolved', valid: true };
        proof.terminal = { phase: 'error', deploymentId: launch.deploymentId, floorCause: true }; proof.absence = absence;
    }
    if (caseId === 'LIVE-L12') {
        proof.promptRequestId = 'prompt-01234567';
        proof.generation = { kind: 'server-generation-start', controllerInstanceId: launch.controllerInstanceId,
            deploymentId: launch.deploymentId, pid: 42, start: '1234', requestId: proof.promptRequestId, monotonicMs: 120 };
        proof.requestSettlement = { requestId: proof.promptRequestId, cancelledByStop: true, settled: true, monotonicMs: 140 };
    }
    return { model, proof, params: APU_PARAMS };
}
