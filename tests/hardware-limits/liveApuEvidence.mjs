import { APU_CASES, APU_PARAMS, APU_STOP_MS, validateRefusal, pressureFloor } from './liveApuPins.mjs';
import { jsonDigest, HASH } from './liveCommon.mjs';
import { assertLinuxIdentity, assertLinuxHostSample, LINUX_HOST_LIMITS } from './liveLinuxHostGuard.mjs';
import { validateAmdBaseline, validateAmdCheck, AMD_IDLE_LIMITS } from './liveAmdGpuGate.mjs';
import { assertAmdDeviceArguments, assertAppleRenderFacts } from './liveModelDevices.mjs';
import { validateApuDeployment, apuAllocationBytes } from './liveApuDeployment.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => jsonDigest(a) === jsonDigest(b);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => Number.isFinite(value) && value >= 0;
export const APU_OUTCOMES = Object.freeze(['pass', 'fail', 'blocked', 'not-exercised', 'pending']);
export const apuRequestId = (runId, caseId) => `apu-${runId}-${caseId.slice(5).toLowerCase()}`;

export function validateApuHostProof(proof, model, { requireUntripped = true } = {}) {
    check(proof?.schema === 1 && same(proof.thresholds, LINUX_HOST_LIMITS) && typeof proof.tripped === 'boolean'
        && (!requireUntripped || proof.tripped === false) && Array.isArray(proof.samples)
        && proof.samples.length > 0 && proof.samples.length <= LINUX_HOST_LIMITS.samples, 'APU host guard history unavailable');
    check(proof.baseline && typeof proof.baseline === 'object', 'APU host guard baseline unavailable');
    assertLinuxIdentity(proof.baseline, model.amd); assertLinuxHostSample(proof.baseline);
    let last = -1;
    for (const row of proof.samples) {
        check(time(row.monotonicMs) && row.monotonicMs >= last, 'APU host guard clock invalid'); last = row.monotonicMs;
        assertLinuxIdentity(row, model.amd);
        if (requireUntripped || proof.tripped === false) assertLinuxHostSample(row, proof.baseline);
    }
}

export function validateApuIdleProof(proof, { requireUntripped = true, requireFinal = false, runId, profile,
    caseId = null, afterMonotonicMs = null, allocationRecords = null } = {}) {
    check(proof?.schema === 1 && same(proof.thresholds, AMD_IDLE_LIMITS) && typeof proof.tripped === 'boolean'
        && (!requireUntripped || proof.tripped === false) && Array.isArray(proof.history)
        && proof.history.length > 0 && proof.history.length <= AMD_IDLE_LIMITS.samples, 'AMD idle history unavailable');
    validateAmdBaseline(proof.baseline);
    const samples = []; let started = -1;
    for (const [index, receipt] of proof.history.entries()) {
        validateAmdCheck(receipt, proof.baseline, { requireComplete: requireUntripped || proof.tripped === false });
        check(receipt.sequence === index + 1 && receipt.startedMonotonicMs >= started, 'AMD check order differs'); started = receipt.startedMonotonicMs;
        check(receipt.context === null || profile && APU_CASES[profile.model.profile]?.includes(receipt.context?.case)
            && receipt.context.requestId === apuRequestId(runId, receipt.context.case), 'AMD check case identity differs');
        if (receipt.allocationAllowanceBytes === 0) check(receipt.allocationEvidence === null, 'AMD zero allowance has unexpected allocation evidence');
        else {
            check(receipt.context && receipt.allocationAllowanceBytes === apuAllocationBytes(receipt.allocationEvidence,
                { runId, profile, caseId: receipt.context.case, requestId: receipt.context.requestId }), 'AMD allocation allowance differs from runner buffers');
            if (allocationRecords && (caseId === null || receipt.context.case === caseId)) {
                const records = allocationRecords.get(receipt.context.case);
                check(Array.isArray(records) && records.length <= 1800 && records.some(value => same(value, receipt.allocationEvidence)),
                    'AMD allocation allowance lacks its recorded case buffer observation');
            }
        }
        samples.push(...receipt.samples);
    }
    check(samples.length <= AMD_IDLE_LIMITS.samples, 'AMD sample history bound exceeded');
    samples.sort((a, b) => a.sequence - b.sequence);
    for (const [index, row] of samples.entries()) check(row.sequence === index + 1
        && (!index || row.monotonicMs > samples[index - 1].monotonicMs), 'AMD sample sequence or clock differs');
    if (requireFinal) check(proof.history.at(-1).purpose === 'final' && proof.history.at(-1).state === 'complete', 'AMD final five-second idle window unavailable');
    if (caseId !== null) check(time(afterMonotonicMs) && proof.history.some(receipt => receipt.context?.case === caseId
        && receipt.context.requestId === apuRequestId(runId, caseId) && receipt.idleMode === 'idle' && receipt.state === 'complete'
        && receipt.allocationAllowanceBytes === 0 && receipt.startedMonotonicMs >= afterMonotonicMs), 'AMD current-case initial idle window unavailable');
}

function absence(proof) {
    check(proof?.method === 'agent-procfs/v1' && proof.phase === 'idle' && Array.isArray(proof.processes)
        && proof.processes.length === 0 && time(proof.monotonicMs), 'APU case did not begin idle without an owned runner');
}
function launchIdentity(proof, requestId) {
    const launch = proof.launch; const process = proof.process;
    check(launch && /^[A-Za-z0-9_.-]{1,128}$/.test(launch.controllerInstanceId || '')
        && /^[A-Za-z0-9_.-]{1,128}$/.test(launch.deploymentId || '') && launch.requestId === requestId
        && integer(launch.logSeqStart) && integer(launch.launchSeq) && launch.launchSeq > launch.logSeqStart
        && time(launch.startedMonotonicMs) && launch.command === '/opt/llama.cpp-vulkan/llama-server'
        && Number.isSafeInteger(launch.pid) && launch.pid > 0, 'APU current launch unavailable');
    check(process && process.pid === launch.pid && process.exe === launch.command && /^[0-9]+$/.test(process.start || '')
        && Number.isSafeInteger(process.pgid) && process.pgid > 0 && /^[a-f0-9]{64}$/.test(process.sha256 || ''), 'APU process identity unavailable');
    return launch;
}
function groupAbsent(value, process) {
    check(value?.groupAbsent === true && ['pid', 'pgid', 'start'].every(key => value[key] === process[key]), 'APU runner group absence unavailable');
}
function settledStop(value, proof) {
    check(value?.tool === 'local_llm_stop' && value.route === 'local-llm' && value.requestId === proof.requestId
        && value.deploymentId === proof.launch.deploymentId && time(value.startedMonotonicMs) && time(value.settledMonotonicMs)
        && time(value.idleMonotonicMs) && value.settledMonotonicMs >= value.startedMonotonicMs
        && value.idleMonotonicMs >= value.settledMonotonicMs && value.idleMonotonicMs - value.startedMonotonicMs <= APU_STOP_MS
        && value.settled === true && value.phase === 'idle', 'APU routed Stop settlement unavailable');
    groupAbsent(value.absence, proof.process);
}

export function validateApuRefusal(proof, model) {
    const pin = validateRefusal(model.refusal, model.amd);
    check(pin.outcome === 'refusable' && same(proof.refusal?.configuration, pin.selected), 'APU refusal configuration differs');
    const value = proof.refusal; const attempt = value.apuAttempt;
    check(value.status === pin.selected.status && value.constraint === pin.selected.constraint
        && value.method === 'controller-acquisition-no-entry/v1' && value.certifiedTransferredBytes === 0,
    'APU refusal status, constraint or zero-acquisition witness differs');
    check(attempt?.schema === 1 && /^[A-Za-z0-9-]{8,128}$/.test(attempt.attemptId || '')
        && attempt.boundary === 'initial-admission' && attempt.requestId === proof.requestId
        && attempt.modelId === pin.selected.modelId && attempt.runnerId === pin.selected.runnerId
        && same(attempt.params, pin.selected.params), 'APU refusal attempt identity differs');
    const observations = [value.pre, attempt.before, attempt.after, value.post];
    const started = ['modelJobsStarted', 'runnerInstallsStarted', 'modelLookupsStarted'];
    const active = ['activeModelJobs', 'activeRunnerInstalls', 'activeModelLookups'];
    for (let index = 0; index < observations.length; index += 1) {
        const row = observations[index];
        check(row?.schema === 1 && row.valid === true && row.controllerInstanceId === attempt.controllerInstanceId
            && /^[A-Za-z0-9-]{8,128}$/.test(row.controllerInstanceId || '') && time(row.sampledMonotonicMs)
            && (!index || row.sampledMonotonicMs >= observations[index - 1].sampledMonotonicMs)
            && started.every(key => integer(row[key]) && row[key] === observations[0][key])
            && active.every(key => row[key] === 0) && row.runnerRunning === false, 'APU acquisition activity invalid or changed');
    }
    absence(proof.after);
}

export function validateApuLoadCancellation(proof, { allowReady = false } = {}) {
    const launch = launchIdentity(proof, proof.requestId);
    const trace = proof.trace;
    check(trace && trace.problem === null && same(trace.launch, launch) && Array.isArray(trace.events)
        && trace.events.length > 0 && trace.events.length <= 2000, 'APU load trace incomplete');
    let cursor = launch.logSeqStart;
    for (const event of trace.events) {
        check(event.seq === ++cursor && ['launch', 'load-begin', 'phase-starting', 'phase-ready', 'phase-stopping', 'phase-idle', 'phase-error', 'guard-floor', 'other'].includes(event.kind), 'APU load trace sequence gap');
    }
    check(trace.nextSeq === cursor, 'APU load trace terminal sequence differs');
    const launchEvent = trace.events.find(event => event.seq === launch.launchSeq);
    const marker = trace.events.find(event => event.kind === 'load-begin' && event.seq > launch.launchSeq);
    const idle = trace.events.find(event => event.kind === 'phase-idle' && event.seq > launch.launchSeq);
    check(launchEvent?.kind === 'launch' && marker && idle && marker.seq < idle.seq
        && proof.loadObservedPhase === 'starting' && proof.loadObservedSeq === marker.seq
        && integer(proof.stopAfterSeq) && proof.stopAfterSeq >= marker.seq && proof.stopAfterSeq < idle.seq,
    'APU tensor-load trigger or idle unavailable');
    settledStop(proof.stop, proof);
    const ready = trace.events.some(event => event.kind === 'phase-ready' && event.seq < idle.seq);
    check(allowReady ? ready : !ready, allowReady ? 'APU not-exercised lacks ready race' : 'APU reached ready before idle');
}

export function validateApuGuard(proof, model) {
    const launch = launchIdentity(proof, proof.requestId); const guard = launch.guardStop;
    check(guard?.kind === 'host-memory-floor' && guard.valid === true && guard.settlement === 'resolved'
        && guard.floorBytes === pressureFloor(model.amd.host.memTotalBytes) && integer(guard.availableBytes)
        && guard.availableBytes < guard.floorBytes && guard.availableBytes <= model.amd.host.memTotalBytes
        && integer(guard.seq) && guard.seq > launch.launchSeq && time(guard.killRequestedMonotonicMs)
        && time(guard.settledMonotonicMs) && guard.settledMonotonicMs >= guard.killRequestedMonotonicMs
        && guard.killRequestedMonotonicMs >= launch.startedMonotonicMs
        && guard.killRequestedMonotonicMs - launch.startedMonotonicMs <= 1000
        && proof.terminal?.phase === 'error' && proof.terminal.deploymentId === launch.deploymentId
        && proof.terminal.floorCause === true && proof.hostGuard?.tripped === false, 'APU guard stop proof unavailable');
    groupAbsent(proof.absence, proof.process);
}

export function validateApuGenerationCancellation(proof) {
    launchIdentity(proof, proof.requestId);
    const trigger = proof.generation;
    check(trigger?.kind === 'server-generation-start' && trigger.controllerInstanceId === proof.launch.controllerInstanceId
        && trigger.deploymentId === proof.launch.deploymentId && trigger.pid === proof.process.pid && trigger.start === proof.process.start
        && trigger.requestId === proof.promptRequestId && /^[A-Za-z0-9_-]{8,128}$/.test(trigger.requestId || '')
        && time(trigger.monotonicMs) && trigger.monotonicMs < proof.stop?.startedMonotonicMs
        && proof.requestSettlement?.requestId === trigger.requestId && proof.requestSettlement.cancelledByStop === true
        && proof.requestSettlement.settled === true && time(proof.requestSettlement.monotonicMs)
        && proof.requestSettlement.monotonicMs >= proof.stop.startedMonotonicMs
        && proof.requestSettlement.monotonicMs - proof.stop.startedMonotonicMs <= APU_STOP_MS, 'APU generation trigger or request settlement unavailable');
    settledStop(proof.stop, proof);
}

export function validateApuReceipt(proof, { runId, block, profile, caseId, reportedStatus = null, functional }) {
    const model = profile.model;
    check(block === `linux-model-${model.profile}` && APU_CASES[model.profile]?.includes(caseId) && proof?.schema === 1 && proof.runId === runId
        && proof.block === block && proof.profile === model.profile && proof.case === caseId, 'APU receipt identity mismatch');
    check(APU_OUTCOMES.includes(proof.status) && (reportedStatus === null || reportedStatus === proof.status), 'APU receipt/report status disagreement');
    if (proof.status !== 'pass') {
        check(typeof proof.reason === 'string' && proof.reason.length > 0 && proof.reason.length <= 400, 'APU nonpassing receipt lacks reason');
        if (proof.status === 'not-exercised') {
            if (caseId === 'LIVE-L9') check(validateRefusal(model.refusal, model.amd).outcome === 'not-exercised'
                && same(proof.derivation, model.refusal), 'APU no-refusal derivation unavailable');
            else if (caseId === 'LIVE-L11') {
                validateApuDeployment(proof.deployment, { profile, requestId: proof.requestId, launch: proof.launch, requireLaunch: true });
                validateApuLoadCancellation(proof, { allowReady: true });
            }
            else throw new Error('APU case cannot be not-exercised');
        }
        return proof;
    }
    check(proof.requestId === apuRequestId(runId, caseId), 'APU case request differs');
    absence(proof.before);
    const owned = profile.agents.find(agent => agent.role === 'llm');
    const binding = proof.source?.binding;
    check(proof.agent?.id === owned?.id && proof.agent?.image === owned?.image && proof.agent?.created === owned?.created
        && `sha256:${String(proof.agent.image).replace(/^sha256:/, '')}` === model.imageConfigDigest
        && proof.box?.id === profile.box?.id && proof.box?.image === profile.box?.image
        && proof.source.originalTreeDigest === profile.provision.llm.treeDigest && HASH.test(proof.source.stagedTreeDigest || '')
        && binding?.treeDigest === proof.source.stagedTreeDigest && proof.source.path === `${profile.provision.workspace.path}/local-llms/local-llm`
        && binding.code === proof.source.path
        && /^[a-f0-9]{64}$/.test(binding?.dependency?.generationId || '') && binding.provider?.mode === 'image'
        && binding.provider.path === '/opt/ploinky-agentlib' && /^[a-f0-9]{64}$/.test(binding.provider.sourceIdHash || '')
        && binding.provider.boxId === profile.box.id && binding.provider.supplyingImageId === `sha256:${profile.box.image.replace(/^sha256:/, '')}`
        && Number.isInteger(binding.files) && binding.files > 0 && same(proof.sourceAfter, proof.source), 'APU runtime source/provider binding differs');
    check(proof.env?.switchMatched === (model.profile !== 'amd-apu-cpu') && proof.env?.floorMatched === (model.profile === 'amd-apu-pressure')
        && proof.env?.unexpectedSwitch === false && proof.env?.unexpectedFloor === false, 'APU environment proof differs');
    validateApuHostProof(proof.hostGuard, model);
    if (model.profile !== 'amd-apu-cpu') {
        validateApuIdleProof(proof.gpuGate, { runId, profile, caseId, afterMonotonicMs: proof.before.monotonicMs,
            allocationRecords: new Map([[caseId, proof.bufferObservations || []]]) });
        check(proof.discovery?.qualification === false && same(proof.discovery.vulkan, model.amd.vulkan)
            && same(proof.discovery.devices, model.amd.devices), 'AMD discovery identity differs');
        for (const role of ['box', 'agent']) {
            assertAmdDeviceArguments(proof.devices?.[role], { renderNode: model.amd.render.path, role });
            const node = assertAppleRenderFacts(proof.devices?.[role], { renderNode: model.amd.render.path, role });
            check(node.rdev === model.amd.render.major * 256 + model.amd.render.minor % 256 + Math.floor(model.amd.render.minor / 256) * 1048576
                && (node.mode & 511) === parseInt(model.amd.render.mode, 8), 'AMD observed node differs from pins');
        }
    }
    if (proof.process) check(proof.process.sha256 === model.executable.sha256, 'APU runner executable hash differs');
    if (['LIVE-L10', 'LIVE-L11', 'LIVE-L12'].includes(caseId)) validateApuDeployment(proof.deployment,
        { profile, requestId: proof.requestId, launch: proof.launch, requireLaunch: true });
    if (['LIVE-L13', 'LIVE-L8'].includes(caseId)) {
        check(typeof functional === 'function', 'APU functional validator unavailable'); functional(proof);
        check(proof.deployment?.deployment?.requestId === proof.requestId && same(proof.deployment.deployment.params, APU_PARAMS), 'APU functional request/params differ');
        absence(proof.after);
        if (caseId === 'LIVE-L8') check(proof.comparison?.prompt === 'Name one colour.' && proof.comparison.maxTokens === 64
            && proof.comparison.build === 'b11159' && integer(proof.comparison.threads) && proof.comparison.threads > 0
            && proof.comparison.cache === 'fresh-owned-workspace', 'APU CPU comparison metadata unavailable');
    } else if (caseId === 'LIVE-L9') validateApuRefusal(proof, model);
    else if (caseId === 'LIVE-L10') validateApuGuard(proof, model);
    else if (caseId === 'LIVE-L11') validateApuLoadCancellation(proof);
    else if (caseId === 'LIVE-L12') validateApuGenerationCancellation(proof);
    return proof;
}
