import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APU_CASES, validateApuPins, prepareApuModel, pressureFloor, deriveRefusal, validateRefusal, apuAdmission } from '../hardware-limits/liveApuPins.mjs';
import { fakeApuPin, fakeApuCatalog, fakeApuProof, fakeApuLaunch } from '../hardware-limits/fakeApuEvidence.mjs';
import { projectApuEvidence, createApuTrace } from '../hardware-limits/liveApuProjection.mjs';
import { validateApuRefusal, validateApuGuard, validateApuLoadCancellation, validateApuGenerationCancellation } from '../hardware-limits/liveApuEvidence.mjs';
import { assertLinuxHostSample, createLinuxHostGuard } from '../hardware-limits/liveLinuxHostGuard.mjs';
import { validateAmdBaseline, createAmdGpuGate } from '../hardware-limits/liveAmdGpuGate.mjs';
import { rewriteLlmManifest } from '../hardware-limits/liveFixture.mjs';
import { MODEL_PROFILES } from '../hardware-limits/liveModelCases.mjs';
import { LLM_TOOL_CALL } from '../hardware-limits/liveLlmCommands.mjs';
import { assertAmdDeviceArguments } from '../hardware-limits/liveModelDevices.mjs';

test('APU exact case map preserves Apple L7 and reserves L13', () => {
    assert.deepEqual(APU_CASES, { 'amd-apu': ['LIVE-L13', 'LIVE-L9', 'LIVE-L11', 'LIVE-L12'], 'amd-apu-pressure': ['LIVE-L10'], 'amd-apu-cpu': ['LIVE-L8'] });
    assert.equal(MODEL_PROFILES['apple-cpu'].case, 'LIVE-L7');
});
test('APU pressure preparation and exact default rewrite share the strict predicate', () => {
    const model = prepareApuModel(fakeApuPin('amd-apu-pressure'), fakeApuCatalog());
    const original = { container: 'old', profiles: { default: { env: { LOCAL_LLM_AMD_APU: { required: false }, LOCAL_LLM_APU_GUARD_FLOOR_BYTES: { required: false }, OTHER: { required: false } } } } };
    const value = JSON.parse(rewriteLlmManifest(JSON.stringify(original), 'image', model));
    assert.equal(value.profiles.default.env.LOCAL_LLM_AMD_APU.default, 'experimental');
    assert.equal(value.profiles.default.env.LOCAL_LLM_APU_GUARD_FLOOR_BYTES.default, String(model.amd.host.memTotalBytes + 2 ** 30));
    assert.deepEqual(value.profiles.default.env.OTHER, { required: false });
    validateApuPins(model, { prepared: true });
    for (const n of [model.amd.host.memTotalBytes - 1, model.amd.host.memTotalBytes, model.guardFloorBytes + 1, null]) {
        assert.throws(() => validateApuPins({ ...model, guardFloorBytes: n }, { prepared: true }));
    }
    assert.throws(() => pressureFloor(Number.MAX_SAFE_INTEGER));
    const other = prepareApuModel(fakeApuPin(), fakeApuCatalog()); other.guardFloorBytes = model.guardFloorBytes;
    assert.throws(() => validateApuPins(other, { prepared: true }));
});
for (const mutate of [m => delete m.amd.pci.device, m => m.amd.render.minor++, m => m.amd.pci.vendor = 'GPU-01234567',
    m => m.amd.render.path = '/dev/dri', m => m.amd.render.mode = '0660', m => delete m.env.LOCAL_LLM_AMD_APU,
    m => m.env.LOCAL_LLM_APU_GUARD_FLOOR_BYTES = '1']) test(`APU invalid pins ${mutate}`, () => {
    const model = prepareApuModel(fakeApuPin(), fakeApuCatalog()); mutate(model);
    assert.throws(() => validateApuPins(model, { prepared: true }));
});
test('APU refusal derives smallest refusing context and validates no-refusal outcome', () => {
    const model = prepareApuModel(fakeApuPin(), fakeApuCatalog());
    const selected = model.refusal.selected; assert.ok(selected);
    validateRefusal(model.refusal, model.amd);
    if (selected.params.ctxSize > 512) assert.equal(apuAdmission(model.refusal.catalog[0], { ...selected.params, ctxSize: selected.params.ctxSize - 1 }, model.amd).status, 'ok');
    const pin = structuredClone(model.amd); pin.host.memTotalBytes = pin.host.availableBytes = pin.devices.totalBytes = pin.devices.freeBytes = 2 ** 49;
    assert.equal(deriveRefusal(model.refusal.catalog, pin).outcome, 'not-exercised');
    model.refusal.outcome = 'not-exercised'; assert.throws(() => validateRefusal(model.refusal, model.amd));
});

function rawStatus(count = 40) {
    const launch = fakeApuLaunch('request-12345678'); launch.nextSeq = count;
    return { phase: 'starting', profile: 'apu', apuObservation: launch, nextSeq: count,
        deployment: { id: launch.deploymentId, requestId: launch.requestId, profile: 'apu', logSeqStart: 0, params: { ctxSize: 4096, parallel: 1 } },
        logs: Array.from({ length: count }, (_, index) => ({ seq: index + 1, stream: index === 2 ? 'stderr' : 'controller',
            line: index === 0 ? 'phase starting' : index === 1 ? 'starting /opt/llama.cpp-vulkan/llama-server --api-key SECRET_ARG' : index === 2 ? 'loading model tensors, this can take a while...' : 'SECRET_TEXT SECRET_ENV' })) };
}
for (const count of [40, 200]) test(`APU both projections preserve ${count} contiguous events with no raw sentinels`, () => {
    const first = projectApuEvidence(rawStatus(count)); const second = projectApuEvidence(first, 0, true);
    assert.equal(first.logs.length, count); assert.equal(second.logs.length, count); assert.equal(second.coverage.continuous, true);
    assert.doesNotMatch(JSON.stringify(second), /SECRET_|--api-key/);
    const trace = createApuTrace(second.apuObservation); assert.equal(trace.append(second), null);
    assert.equal(trace.snapshot().events[2].kind, 'load-begin');
    // Execute the exact confined helper's projector, not a duplicate algorithm.
    const program = LLM_TOOL_CALL.slice(0, LLM_TOOL_CALL.indexOf('(async()=>{')) + ';process.stdout.write(JSON.stringify(project("local_llm_status",INPUT)));';
    let output = '';
    vm.runInNewContext(program, { INPUT: rawStatus(count), Buffer, process: { argv: ['node', 'local_llm_status', '{}', '{"apu":true}'], stdout: { write: value => output += value }, exit: () => { throw Error('exit'); } } });
    assert.deepEqual(JSON.parse(output), first);
});
for (const mutate of [s => s.logs.shift(), s => s.logs[10].seq++, s => s.logs.reverse(), s => s.nextSeq++, s => s.logs.push({ seq: 201, stream: 'stderr', line: 'secret' })]) test(`APU coverage refuses ${mutate}`, () => {
    const raw = rawStatus(200); mutate(raw); assert.equal(projectApuEvidence(raw).coverage.continuous, false);
});
test('APU trace refuses stale identities, cross-response gaps, resets and overflow', () => {
    for (const change of [s => s.apuObservation.requestId = 'stale', s => s.coverage.sinceSeq = 3, s => s.logs[2].seq = 0]) {
        const first = projectApuEvidence(rawStatus()); const trace = createApuTrace(first.apuObservation); change(first); assert.ok(trace.append(first));
    }
    const first = projectApuEvidence(rawStatus()); assert.ok(createApuTrace(first.apuObservation, { limit: 30 }).append(first));
});

for (const [caseId, validate] of [['LIVE-L9', (p, m) => validateApuRefusal(p, m)], ['LIVE-L10', validateApuGuard],
    ['LIVE-L11', validateApuLoadCancellation], ['LIVE-L12', validateApuGenerationCancellation]]) test(`APU ${caseId} complete semantic positive control needs no answer`, () => {
    const { proof, model } = fakeApuProof(caseId); validate(proof, model); assert.equal(proof.answer, undefined);
});
for (const mutate of [p => p.refusal.certifiedTransferredBytes = 1, p => p.refusal.constraint = 'C4', p => p.refusal.status = 'ok',
    p => p.refusal.post.modelJobsStarted++, p => p.refusal.post.runnerInstallsStarted++, p => p.refusal.post.modelLookupsStarted++,
    p => p.refusal.apuAttempt.before.activeModelLookups++, p => p.refusal.pre.activeModelJobs++, p => p.refusal.post.activeRunnerInstalls++,
    p => p.refusal.post.controllerInstanceId = 'other-epoch', p => p.refusal.pre.valid = false, p => p.refusal.post.sampledMonotonicMs = 0,
    p => p.refusal.apuAttempt.requestId = 'other', p => p.after.processes.push({ pid: 1 })]) test(`APU L9 corruption ${mutate}`, () => {
    const { proof, model } = fakeApuProof('LIVE-L9'); mutate(proof); assert.throws(() => validateApuRefusal(proof, model));
});
for (const mutate of [p => p.launch.guardStop.killRequestedMonotonicMs = 1100.001, p => p.launch.guardStop.killRequestedMonotonicMs = 99,
    p => p.launch.guardStop.settlement = 'pending', p => p.launch.guardStop.settlement = 'rejected', p => p.launch.guardStop.kind = 'psi',
    p => p.launch.guardStop.valid = false, p => p.terminal.phase = 'idle', p => p.absence.groupAbsent = false, p => p.process.pid++, p => p.hostGuard.tripped = true]) test(`APU L10 corruption ${mutate}`, () => {
    const { proof, model } = fakeApuProof('LIVE-L10'); mutate(proof); assert.throws(() => validateApuGuard(proof, model));
});
for (const mutate of [p => p.trace.events[2].kind = 'other', p => p.trace.events[3].kind = 'phase-ready', p => p.trace.events[3].seq++,
    p => p.trace.launch.requestId = 'stale', p => p.stop.settled = false, p => p.stop.absence.groupAbsent = false,
    p => p.stop.idleMonotonicMs = 60131, p => p.loadObservedPhase = 'ready']) test(`APU L11 corruption ${mutate}`, () => {
    const { proof } = fakeApuProof(); mutate(proof); assert.throws(() => validateApuLoadCancellation(proof));
});
test('APU L11 ready race is not-exercised; stopping phase is optional', () => {
    const { proof } = fakeApuProof(); validateApuLoadCancellation(proof);
    proof.trace.events[3].kind = 'phase-ready'; validateApuLoadCancellation(proof, { allowReady: true });
});
for (const mutate of [p => delete p.generation, p => p.generation.requestId = 'wrong-request', p => p.generation.start = 'stale',
    p => p.generation.monotonicMs = 140, p => p.requestSettlement.cancelledByStop = false, p => p.requestSettlement.settled = false,
    p => p.stop.absence.groupAbsent = false]) test(`APU L12 synthetic corruption ${mutate}`, () => {
    const { proof } = fakeApuProof('LIVE-L12'); mutate(proof); assert.throws(() => validateApuGenerationCancellation(proof));
});
const hostSample = () => ({ totalBytes: 16 * 2 ** 30, availableBytes: 12 * 2 ** 30, swapTotalBytes: 4 * 2 ** 30, swapUsedBytes: 0, psiFull: 0 });
test('Linux host guard enforces every boundary and unreadable samples', async () => {
    const baseline = hostSample(); assertLinuxHostSample(baseline);
    for (const delta of [{ availableBytes: 2 ** 31 - 1 }, { psiFull: 10 }, { swapUsedBytes: 2 ** 30 + 1 }, { availableBytes: null }, { psiFull: NaN }, { availableBytes: 17 * 2 ** 30 }]) {
        assert.throws(() => assertLinuxHostSample({ ...baseline, ...delta }, baseline));
    }
    assertLinuxHostSample({ ...baseline, availableBytes: 2 ** 31, swapUsedBytes: 2 ** 30, psiFull: 9.99 }, baseline);
    const evidence = []; const guard = createLinuxHostGuard({ sample: async () => { throw Error('unreadable'); }, write: v => evidence.push(v) });
    await assert.rejects(guard.check()); assert.equal(evidence.at(-1).tripped, true);
});
const baseline = () => ({ samples: Array.from({ length: 31 }, (_, index) => ({ monotonicMs: index * 2000, busyPercent: 1, vramUsedBytes: 1000, gttUsedBytes: 1000 })) });
test('AMD idle gate requires a stable 60-second baseline and catches foreign growth', async () => {
    validateAmdBaseline(baseline());
    for (const mutate of [b => b.samples.pop(), b => b.samples[10].monotonicMs++, b => b.samples.forEach(r => r.busyPercent = 11), b => b.samples[3].gttUsedBytes += 536870913]) {
        const b = baseline(); mutate(b); if (String(mutate).includes('monotonicMs++')) b.samples[10].monotonicMs += 10000;
        assert.throws(() => validateAmdBaseline(b));
    }
    let clock = 61000; let growth = 0;
    const gate = createAmdGpuGate({ baseline: baseline(), sample: async () => ({ busyPercent: 1, vramUsedBytes: 1000, gttUsedBytes: 1000 + growth }), clock: () => clock,
        wait: async ms => { clock += ms; } });
    await gate.initial(); await gate.check(); growth = 536870913; clock++;
    await assert.rejects(gate.check({ idle: false }), /growth/); assert.equal(gate.snapshot().tripped, true);
});
test('AMD device argv proof is exact, with one CDI and no extra Box node', () => {
    const box = { recordedDevices: ['/dev/fuse', '/dev/net/tun', '/dev/dri/renderD128'], devices: [] };
    const agent = { recordedDevices: ['ploinky.local/gpu=all'], devices: [] };
    assertAmdDeviceArguments(box, { role: 'box', renderNode: '/dev/dri/renderD128' });
    assertAmdDeviceArguments(agent, { role: 'agent', renderNode: '/dev/dri/renderD128' });
    for (const devices of [[], ['/dev/dri'], ['ploinky.local/gpu=all', '/dev/kfd']]) assert.throws(() => assertAmdDeviceArguments({ ...agent, recordedDevices: devices }, { role: 'agent', renderNode: '/dev/dri/renderD128' }));
    box.recordedDevices.push('/dev/kfd'); assert.throws(() => assertAmdDeviceArguments(box, { role: 'box', renderNode: '/dev/dri/renderD128' }));
});
