// Frozen measurement configuration and evidence validation. No process or network I/O.
import crypto from 'node:crypto';
import { keys } from './liveCommon.mjs';
import { assertModelHostSample } from './liveModelHostGuard.mjs';
import { imageSourceIdentity, imageSourceIdHash } from '../../agentlib/contract.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hex = value => crypto.createHash('sha256').update(value).digest('hex');
const sha = value => /^[a-f0-9]{64}$/.test(value || '');
export const MEASUREMENT_MODEL = 'qwen2.5-1.5b-instruct-q4_k_m';
export const MEASUREMENT_PROMPT = Object.freeze({ version: 'colour-v1', text: 'Name one colour.', maxTokens: 64 });
export const MEASUREMENT_DEADLINES = Object.freeze({
    coreMs: 30000, hostSampleMs: 10000, startMs: 1200000, blockMs: 1200000, modelLoadMs: 1200000,
    toolMs: 290000, promptMs: 240000, pollMs: 1000, monitorMs: 2000, stopMs: 60000, cleanupMs: 300000,
    actionMs: 2400000, sessionMs: 7200000, handshakeMs: 2000, disconnectMs: 750, settlementMs: 5000,
    ownerSettlementMs: 10000, cleanupEpochMs: 360000, cleanupSupervisorMs: 390000, restorationMs: 300000, escalationMs: 5000,
});
export const MEASUREMENT_SCENARIOS = Object.freeze({
    'baseline-v1': 'LIVE-M1', 'longer-context-v1': 'LIVE-M2', 'two-slots-v1': 'LIVE-M3',
    'larger-model-v1': 'LIVE-M4', 'load-cancel-v1': 'LIVE-M5', 'generation-cancel-v1': 'LIVE-M6',
});

export function normalizeMeasurement(value, catalogPins, profile) {
    check(['apple', 'apple-cpu'].includes(profile), 'Measurements require an exact Mac profile');
    keys(value, ['schema', 'comparisonId', 'cohort', 'scenario'], 'measurement', ['baselineContext']);
    const baselineContext = value.baselineContext ?? 4096;
    check(value.schema === 1 && /^[a-f0-9]{32}$/.test(value.comparisonId) && [1, 2].includes(value.cohort)
        && Object.hasOwn(MEASUREMENT_SCENARIOS, value.scenario) && [512, 1024, 2048, 4096].includes(baselineContext), 'Invalid measurement configuration');
    check(profile === 'apple' || value.scenario === 'baseline-v1', 'Additional measurements are Venus-only');
    if (catalogPins) {
        const model = catalogPins[value.scenario === 'larger-model-v1' ? 'larger' : 'small'];
        check(model?.id === (value.scenario === 'larger-model-v1' ? MEASUREMENT_MODEL : 'qwen2.5-0.5b-instruct-q4_k_m')
            && /^[a-f0-9]{40}$/.test(model.commit) && sha(model.sha256) && Number.isSafeInteger(model.size) && model.size > 0,
        'Measurement model pin mismatch');
    }
    return Object.freeze({ schema: 1, comparisonId: value.comparisonId, cohort: value.cohort, scenario: value.scenario, baselineContext });
}

export function measurementCases(profile, configuration) {
    const smoke = profile === 'apple' ? 'LIVE-L6' : profile === 'apple-cpu' ? 'LIVE-L7' : null;
    if (!configuration) return smoke ? [smoke] : [];
    const config = normalizeMeasurement(configuration, null, profile);
    return config.scenario === 'baseline-v1' ? [smoke, 'LIVE-M1'] : [MEASUREMENT_SCENARIOS[config.scenario]];
}

export function measurementParams(config) {
    return Object.freeze({ ctxSize: config.scenario === 'longer-context-v1' ? 8192 : config.baselineContext,
        parallel: config.scenario === 'two-slots-v1' ? 2 : 1, loadMode: 'none' });
}

export function measurementArtifactName(caseId, trial, phase) {
    check(/^LIVE-M[1-6]$/.test(caseId) && /^[a-z0-9-]{1,64}$/.test(trial) && /^[a-z0-9-]{1,64}$/.test(phase), 'Invalid measurement artifact identity');
    return `measurement-${caseId.toLowerCase()}-${trial}-${phase}`;
}

export function summarizeMeasurementTrials(trials) {
    const measured = trials.filter(trial => trial.id !== 'warmup');
    const metric = select => {
        const values = measured.map(select).filter(value => Number.isFinite(value)).sort((a, b) => a - b);
        if (values.length !== measured.length || !values.length) return null;
        const middle = Math.floor(values.length / 2);
        return { count: values.length, median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
            min: values[0], max: values.at(-1) };
    };
    return { latencyMs: metric(trial => trial.elapsedMs), generationTokensPerSecond: metric(trial => trial.answer.generationTokensPerSecond),
        promptTokensPerSecond: metric(trial => trial.promptProcessingRate) };
}

export function assertCachePreparation(value, binding) {
    check(value?.controllerEpoch === binding.controllerEpoch && value.deploymentId === binding.deploymentId
        && (!binding.runnerIdentity || equal(value.runnerIdentity, binding.runnerIdentity)), 'Stale cache preparation');
    const cache = value.pageCachePreparation;
    keys(cache, ['policy', 'phase', 'filesConsidered', 'attempts', 'reportedSuccesses', 'reportedFailures', 'skippedNonRegular', 'observationErrors'], 'cache preparation');
    check(cache.policy === 'existing-best-effort-per-file-drop' && cache.phase === 'complete', 'Missing completed cache preparation');
    for (const key of ['filesConsidered', 'attempts', 'reportedSuccesses', 'reportedFailures', 'skippedNonRegular', 'observationErrors']) {
        check(Number.isSafeInteger(cache[key]) && cache[key] >= 0 && cache[key] <= 1024, 'Invalid cache preparation counts');
    }
    check(cache.filesConsidered > 0 && cache.attempts + cache.skippedNonRegular <= cache.filesConsidered
        && cache.reportedSuccesses + cache.reportedFailures <= cache.attempts, 'Contradictory cache preparation');
    return cache;
}

export function assertMeasurementContext(context, params) {
    keys(context, ['totalContext', 'perRequestContext', 'parallel', 'kvUnified'], 'context descriptor');
    check(context.totalContext === params.ctxSize && context.parallel === params.parallel && typeof context.kvUnified === 'boolean'
        && context.perRequestContext === (context.kvUnified ? params.ctxSize : Math.floor(params.ctxSize / params.parallel)), 'Context descriptor mismatch');
}

function interval(value, bound) {
    check(value?.clock === 'performance.now' && Number.isFinite(value.startedMs) && value.startedMs >= 0
        && Number.isFinite(value.endedMs) && value.endedMs >= value.startedMs && value.endedMs - value.startedMs <= bound
        && value.elapsedMs === value.endedMs - value.startedMs, 'Invalid measurement clock or deadline');
}

function runnerIdentity(value) {
    check(value && typeof value.controllerEpoch === 'string' && value.controllerEpoch.length > 0 && typeof value.deploymentId === 'string'
        && typeof value.runnerIdentity?.runnerStartId === 'string' && Number.isSafeInteger(value.runnerIdentity.pid)
        && value.runnerIdentity.pid > 0 && value.process?.pid === value.runnerIdentity.pid
        && /^[0-9]+$/.test(value.process.start) && sha(value.process.sha256) && typeof value.process.exe === 'string', 'Missing bound runner identity');
}

export function cancellationOutcome(caseId, value) {
    const stop = value?.stopObservation;
    if (!stop || !value.binding || !equal(stop.runnerIdentity, value.binding.runnerIdentity)
        || stop.controllerEpoch !== value.binding.controllerEpoch || stop.deploymentId !== value.binding.deploymentId) return 'blocked';
    if (value.idle !== true || value.groupAbsent !== true || !Number.isFinite(value.elapsedMs) || value.elapsedMs > 60000) return 'failed';
    if (value.status?.phase !== 'idle' || value.absence?.groupAbsent !== true
        || !['pid', 'pgid', 'start'].every(key => value.absence[key] === value.binding.processGroup?.[key])) return 'blocked';
    if (caseId === 'LIVE-M5') {
        if (stop.startupObservation?.controllerEpoch !== stop.controllerEpoch || stop.startupObservation?.deploymentId !== stop.deploymentId
            || !equal(stop.startupObservation?.runnerIdentity, stop.runnerIdentity) || stop.startupObservation.observationErrors !== 0) return 'blocked';
        if (stop.firstAcceptedHealthSequence !== null || stop.phaseAtStop !== 'starting') return 'not-exercised';
        if (stop.runnerRunning !== true || !stop.startupObservation?.loadingObserved
            || stop.latestHealthObservation?.status !== 503 || stop.latestHealthObservation.accepted !== false) return 'not-exercised';
        return stop.latestHealthObservation.sequence < stop.sequence ? 'pass' : 'failed';
    }
    const prompt = value.promptObservation;
    if (!prompt || !equal(prompt.runnerIdentity, stop.runnerIdentity) || prompt.controllerEpoch !== stop.controllerEpoch
        || prompt.deploymentId !== stop.deploymentId || prompt.modelId !== value.binding.modelId || prompt.runnerId !== value.binding.runnerId
        || !/^[A-Za-z0-9_-]{8,128}$/.test(value.promptObservationId || '')
        || prompt.id !== value.promptObservationId) return 'blocked';
    if (prompt.outcome === 'success' || value.promptSucceeded === true || value.promptSettlement?.succeeded === true) return 'not-exercised';
    const sequence = value => Number.isSafeInteger(value) && value > 0;
    const cancellation = prompt.cancellation;
    const settlement = value.promptSettlement;
    return prompt.firstTokenPresent === true && Number.isInteger(prompt.firstTokenSequence)
        && [prompt.firstTokenSequence, prompt.stopSequence, prompt.stopNotificationSequence, prompt.terminalSequence].every(sequence)
        && prompt.firstTokenSequence < prompt.stopSequence && prompt.stopSequence === stop.sequence
        && prompt.stopSequence < prompt.stopNotificationSequence && prompt.stopNotificationSequence < prompt.terminalSequence && prompt.phase === 'terminal'
        && prompt.outcome === 'interrupted-after-stop' && prompt.errorCode === 'prompt_cancelled_by_stop'
        && cancellation?.mechanism === 'controller-stop-abort-v1' && cancellation.stopSequence === prompt.stopSequence
        && cancellation.notificationSequence === prompt.stopNotificationSequence
        && value.clock === 'performance.now' && Number.isFinite(value.startedMs) && value.startedMs >= 0
        && settlement?.succeeded === false && settlement.errorCode === 'prompt_cancelled_by_stop'
        && Number.isFinite(settlement.elapsedMs) && settlement.elapsedMs >= 0 && settlement.elapsedMs <= 60000
        && value.promptSucceeded === false ? 'pass' : 'blocked';
}

export function validateMeasurementReceipt(receipt, { run, runId, caseId, profile, configuration, readArtifact }) {
    const config = normalizeMeasurement(configuration, null, profile);
    const execution = run?.target?.execution;
    check(run?.runId === runId && execution?.model?.profile === profile && equal(execution.model.measurement, config), 'Missing frozen run binding');
    check(receipt?.schema === 1 && receipt.runId === runId && receipt.case === caseId && receipt.profile === profile
        && equal(receipt.configuration, config) && MEASUREMENT_SCENARIOS[config.scenario] === caseId, 'Foreign measurement receipt');
    check(receipt.status === 'pass', 'Measurement did not pass');
    check(equal(receipt.params, measurementParams(config)), 'Measurement parameters changed');
    check(receipt.prompt?.version === MEASUREMENT_PROMPT.version && receipt.prompt.sha256 === hex(MEASUREMENT_PROMPT.text)
        && receipt.prompt.maxTokens === 64, 'Measurement prompt changed');
    check(sha(receipt.model?.sha256) && /^[a-f0-9]{40}$/.test(receipt.model?.commit), 'Missing model source binding');
    check(receipt.identity?.source && receipt.identity?.agent?.id && receipt.identity?.box?.id, 'Missing runtime source binding');
    const modelPin = execution.llm.models[config.scenario === 'larger-model-v1' ? 'larger' : 'small'];
    check(equal(receipt.model, modelPin) && receipt.identity.box.id === execution.box.id
        && receipt.identity.box.image === execution.box.image && receipt.identity.agent.id === execution.agents.find(a => a.role === 'llm')?.id
        && receipt.identity.agent.image.replace(/^sha256:/, '') === execution.model.imageConfigDigest.replace(/^sha256:/, '')
        && receipt.identity.source.originalTreeDigest === execution.provision.llm.treeDigest
        && equal(receipt.identity.source.manifest, execution.provision.llm.manifest), 'Measurement identity differs from frozen source/image/model pins');
    const pinnedRunner = binding => {
        runnerIdentity(binding);
        check(binding.process.exe === execution.model.executable.path && binding.process.sha256 === execution.model.executable.sha256,
            'Measurement runner differs from frozen executable');
        check(binding.modelId === modelPin.id && binding.runnerId === (profile === 'apple' ? 'llama.cpp-vulkan' : 'llama.cpp'), 'Measurement runner model identity differs');
        check(Number.isInteger(binding.resolvedThreads) && binding.resolvedThreads > 0 && binding.resolvedThreads <= 4096
            && (profile === 'apple' ? sha(binding.shaderCacheIdentity) : binding.shaderCacheIdentity === null), 'Missing resolved threads or shader cache identity');
    };
    check(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0 && typeof readArtifact === 'function', 'Missing measurement artifacts');
    const names = new Set(); const types = new Set(); const documents = new Map();
    for (const artifact of receipt.artifacts) {
        keys(artifact, ['name', 'sha256', 'type'], 'measurement artifact');
        check(artifact.name.startsWith(`measurement-${caseId.toLowerCase()}-`) && /^[a-z0-9-]+$/.test(artifact.name)
            && !names.has(artifact.name) && sha(artifact.sha256), 'Duplicate or foreign measurement artifact');
        names.add(artifact.name); types.add(artifact.type);
        const bytes = readArtifact(artifact.name);
        check(hex(bytes) === artifact.sha256, 'Measurement artifact digest mismatch');
        const doc = JSON.parse(Buffer.from(bytes).toString('utf8'));
        check(doc.runId === runId && doc.case === caseId && doc.name === artifact.name && equal(doc.configuration, config), 'Measurement artifact binding mismatch');
        documents.set(artifact.name, doc.value);
    }
    for (const type of ['source', 'host', 'memory', 'stop', 'weights']) check(types.has(type), `Missing measurement ${type} artifact`);
    const required = (trial, phase) => {
        const name = measurementArtifactName(caseId, trial, phase);
        check(documents.has(name), `Missing required artifact ${name}`); return documents.get(name);
    };
    const sourceBefore = required('cohort', 'source-before'); const sourceAfter = required('cohort', 'source-after');
    check(equal(sourceBefore, sourceAfter) && equal(sourceBefore, receipt.identity.source)
        && sourceBefore.binding?.treeDigest === sourceBefore.stagedTreeDigest && sourceBefore.binding?.dependency?.generationId
        && sourceBefore.binding?.provider?.sourceIdHash, 'Changed or incomplete source binding');
    const sourceBinding = sourceBefore.binding;
    keys(sourceBinding, ['stage', 'dependency', 'provider', 'treeDigest', 'files'], 'measurement source binding');
    keys(sourceBinding.dependency, ['objectId', 'generationId', 'inputKey', 'nodeModulesPath', 'treeDigest', 'packageSha256'], 'measurement dependency identity');
    keys(sourceBinding.provider, ['mode', 'path', 'sourceIdHash', 'supplyingImageId', 'boxId'], 'measurement provider identity');
    const supplier = `sha256:${execution.box.image.replace(/^sha256:/, '')}`;
    check(sourceBinding.provider.mode === 'image' && sourceBinding.provider.path === '/opt/ploinky-agentlib'
        && sourceBinding.provider.supplyingImageId === supplier && sourceBinding.provider.boxId === execution.box.id
        && sourceBinding.provider.sourceIdHash === imageSourceIdHash(imageSourceIdentity(supplier)), 'Source provider differs from frozen Box identity');
    const dep = sourceBinding.dependency;
    check(['generationId', 'inputKey', 'treeDigest', 'packageSha256'].every(key => sha(dep[key]))
        && /^[a-f0-9-]{36}$/.test(dep.objectId) && Number.isSafeInteger(sourceBinding.files) && sourceBinding.files > 0
        && dep.nodeModulesPath === `${execution.workspace.path}/.ploinky/deps/store/objects/${dep.objectId}/payload/node_modules`
        && sourceBefore.path === `${execution.workspace.path}/local-llms/local-llm`
        && sourceBinding.stage.startsWith(`${execution.workspace.path}/.ploinky/container-runtime/`), 'Source dependency escaped frozen workspace');
    for (const phase of ['host', 'host-after']) {
        const host = required('cohort', phase);
        check(equal(host.host, receipt.identity.host) && equal(host.vm, receipt.identity.vm)
            && Array.isArray(host.guard?.samples) && host.guard.samples.length > 0, 'Missing or changed host/VM observations');
        for (const sample of host.guard.samples) assertModelHostSample(sample, host.guard.samples[0]);
    }
    const weights = required('cohort', 'weights-before');
    check(equal(weights, required('cohort', 'weights-after')) && weights.root === 'controller-gguf-cache' && weights.weightsReused === true,
        'Weights changed across measurement');
    const expectedFiles = receipt.model.files || [{ file: receipt.model.file, size: receipt.model.size, sha256: receipt.model.sha256 }];
    check(equal(weights.files, expectedFiles), 'Cached artifact hash or shard mismatch');
    const runtime = required('acquisition', 'runtime'); pinnedRunner(runtime.binding);
    check(equal(runtime.backend, receipt.backend) && equal(runtime.backend.process, runtime.binding.process), 'Backend receipt contradicts runtime');
    const backend = receipt.backend; const process = backend.process;
    if (profile === 'apple') check(backend.profile === 'venus' && /^Vulkan0(?: \([^\n]+\))?$/.test(backend.device || '')
        && Number.isInteger(backend.offloadedLayers) && backend.offloadedLayers > 0 && process.args?.['--device'] === 'Vulkan0'
        && process.icd === '/opt/local-llm/vulkan/icd.d/virtio_icd.json' && process.layers === '~all~' && process.mps === false && process.nvidiaLibrary === false, 'Venus offload proof missing');
    else check(backend.profile === 'cpu' && (!backend.device || /^CPU/.test(backend.device)) && backend.offloadedLayers === 0
        && process.args?.['--device'] === 'none' && process.args['--n-gpu-layers'] === '0' && process.args['--fit'] === 'off'
        && process.cudaVisible === '' && process.mps === false && process.nvidiaLibrary === false && process.icd === null
        && Array.isArray(process.gpuNodes) && process.gpuNodes.length === 0, 'CPU measurement has GPU facts');
    for (const artifact of receipt.artifacts.filter(a => a.type === 'memory')) {
        const value = documents.get(artifact.name); pinnedRunner(value?.binding);
        const sample = value.sample;
        check(sample?.vm?.totalBytes > 0 && Number.isFinite(sample.vm.availableBytes) && sample.vm.availableBytes >= 0
            && sample.vm.availableBytes <= sample.vm.totalBytes && sample.peakKind === (sample.cgroup?.['memory.peak'] === null ? 'unavailable' : 'cumulative'), 'Invalid VM memory sample');
        for (const key of ['memory.current', 'memory.swap.current']) check(/^\d+$/.test(sample.cgroup[key]), 'Missing cgroup memory sample');
        check(/^(?:\d+|max)$/.test(sample.cgroup['memory.max']) && typeof sample.cgroup['memory.events'] === 'string'
            && /(?:^|\n)oom_kill \d+(?:\n|$)/.test(sample.cgroup['memory.events']), 'Missing cgroup limit/event observation');
    }
    const trials = receipt.trials;
    const expected = caseId === 'LIVE-M3' ? ['concurrent-1', 'concurrent-2'] : ['LIVE-M5', 'LIVE-M6'].includes(caseId) ? [] : ['warmup', 'trial-1', 'trial-2', 'trial-3'];
    check(Array.isArray(trials) && equal(trials.map(trial => trial.id), expected), 'Missing, duplicated or reordered prompt trial');
    if (trials.length) assertMeasurementContext(receipt.context, receipt.params);
    check(equal(receipt.summary, summarizeMeasurementTrials(trials)), 'Measurement summary omits or changes trials');
    for (const trial of trials) {
        interval(trial, MEASUREMENT_DEADLINES.promptMs);
        pinnedRunner(trial.binding);
        const { artifact: pointer, ...facts } = trial;
        check(equal(documents.get(pointer), facts), 'Prompt artifact contradicts trial receipt');
        const memory = required(trial.id, 'memory');
        check(equal(memory.binding, trial.binding), 'Prompt memory window belongs to another runner');
        const window = memory.window;
        check(window?.startedMs === trial.startedMs && window.endedMs >= trial.endedMs && Array.isArray(window.samples)
            && window.samples.length >= 2 && window.samples.length <= 242
            && window.samples[0].monotonicMs <= trial.startedMs && window.samples.at(-1).monotonicMs >= trial.endedMs,
        'Incomplete prompt memory window');
        let previous = -1;
        for (const sample of window.samples) {
            check(sample.monotonicMs >= previous && /^\d+$/.test(sample.sample?.cgroup?.['memory.current']), 'Missing or reordered memory sample');
            previous = sample.monotonicMs;
        }
        const cumulative = window.samples.map(value => Number(value.sample.cgroup['memory.peak'])).filter(value => value > 0);
        check(window.peakKind === (cumulative.length ? 'cumulative' : 'sampled') && window.peakBytes
            === Math.max(...window.samples.map(value => Number(value.sample.cgroup['memory.current'])), ...cumulative), 'Contradictory peak measurement');
        check(names.has(trial.artifact) && trial.answer?.text?.trim() && trial.answer.modelId === receipt.model.id
            && trial.answer.truncated !== true && Number.isInteger(trial.answer.outputTokens) && trial.answer.outputTokens > 0 && trial.answer.outputTokens <= 64
            && Number.isFinite(trial.answer.generationTokensPerSecond) && trial.answer.generationTokensPerSecond > 0,
        'Incomplete prompt trial');
    }
    if (caseId === 'LIVE-M3') check(Math.max(...trials.map(t => t.startedMs)) < Math.min(...trials.map(t => t.endedMs)), 'Concurrent trials did not overlap');
    else for (let i = 1; i < trials.length; i++) check(trials[i].startedMs >= trials[i - 1].endedMs, 'Sequential prompt trials overlapped');
    const expectedLoads = caseId === 'LIVE-M1' ? ['fresh', 'reload'] : ['LIVE-M5', 'LIVE-M6'].includes(caseId) ? [] : ['fresh'];
    check(Array.isArray(receipt.loads) && equal(receipt.loads.map(load => load.id), expectedLoads), 'Missing load trial');
    for (const load of receipt.loads) {
        interval(load, MEASUREMENT_DEADLINES.modelLoadMs); pinnedRunner(load.binding);
        const { artifact: pointer, ...facts } = load;
        check(equal(documents.get(pointer), facts), 'Load artifact contradicts trial receipt');
        check(equal(required(load.id, 'memory').binding, load.binding), 'Load memory window belongs to another runner');
        assertCachePreparation(load.startupObservation, load.binding);
        check(load.weightsReused === true && load.pageCacheState === 'unverified' && load.shaderCachePolicy === 'unchanged-no-harness-purge'
            && load.pollMs === 1000 && names.has(load.artifact), 'Unproven cached-weight load');
    }
    if (receipt.loads.length === 2) check(!equal(receipt.loads[0].binding.runnerIdentity, receipt.loads[1].binding.runnerIdentity)
        && (receipt.loads[0].binding.process.pid !== receipt.loads[1].binding.process.pid || receipt.loads[0].binding.process.start !== receipt.loads[1].binding.process.start)
        && receipt.loads[0].binding.controllerEpoch === receipt.loads[1].binding.controllerEpoch
        && receipt.loads[0].binding.shaderCacheIdentity === receipt.loads[1].binding.shaderCacheIdentity, 'Reload did not replace the runner in the same agent/cache location');
    if (['LIVE-M5', 'LIVE-M6'].includes(caseId)) {
        check(cancellationOutcome(caseId, receipt.stop) === 'pass', 'Cancellation was not exercised');
        const saved = caseId === 'LIVE-M6' ? required('generation-cancel', 'observation') : required('load-cancel', 'stop');
        check(equal(saved, receipt.stop), 'Cancellation artifact contradicts receipt');
    } else {
        check(receipt.stop?.idle === true && receipt.stop.groupAbsent === true && receipt.stop.elapsedMs <= 60000
            && receipt.stop.status?.phase === 'idle' && receipt.stop.absence?.groupAbsent === true
            && ['pid', 'pgid', 'start'].every(key => receipt.stop.absence[key] === receipt.stop.binding.processGroup?.[key]), 'Missing bounded Stop proof');
        check(equal(required(caseId === 'LIVE-M1' ? 'reload' : 'fresh', 'stop'), receipt.stop), 'Stop artifact contradicts receipt');
    }
    return receipt;
}

export function validateMeasurementComparison(cohorts) {
    check(Array.isArray(cohorts) && cohorts.length === 4, 'Comparison needs two complete baseline pairs');
    const seen = new Set(); const runIds = new Set(); let baseline;
    for (const cohort of cohorts) {
        const { run, receipt, index, readArtifact } = cohort;
        check(!runIds.has(run.runId), 'Comparison reused a cohort run'); runIds.add(run.runId);
        const profile = run.target.execution.model.profile; const config = run.target.execution.model.measurement;
        check(config?.scenario === 'baseline-v1', 'Comparison requires baseline measurements');
        validateMeasurementReceipt(receipt, { run, runId: run.runId, caseId: 'LIVE-M1', profile, configuration: config, readArtifact });
        const key = `${config.cohort}/${profile}`; check(!seen.has(key), 'Duplicate comparison cohort'); seen.add(key);
        check(index?.schema === 1 && index.runId === run.runId && index.outcome === 'pass'
            && index.settlement === true && index.cleanup === true && index.restoration === true
            && sha(index.executionManifestSha256) && Array.isArray(index.artifacts), 'Incomplete final evidence index');
        const paths = new Set(); const indexed = new Map();
        for (const artifact of index.artifacts) {
            check(typeof artifact.path === 'string' && !artifact.path.includes('..') && !artifact.path.startsWith('/') && !paths.has(artifact.path)
                && sha(artifact.sha256) && artifact.outcome === 'pass' && hex(readArtifact(artifact.path)) === artifact.sha256, 'Incomplete final evidence artifact');
            paths.add(artifact.path);
            indexed.set(artifact.path, { ...artifact, bytes: readArtifact(artifact.path) });
        }
        for (const type of ['execution-manifest', 'measurement', 'smoke', 'settlement', 'cleanup', 'restoration', 'review']) {
            check(index.artifacts.some(a => a.type === type), `Final evidence index lacks ${type}`);
        }
        const json = name => { check(indexed.has(name), `Final evidence index lacks ${name}`); return JSON.parse(indexed.get(name).bytes); };
        const execution = json('execution-manifest.json');
        check(indexed.get('execution-manifest.json').sha256 === index.executionManifestSha256 && execution.runId === run.runId
            && execution.profile === profile && execution.block === run.block && equal(execution.configuration, config), 'Execution manifest identity mismatch');
        for (const field of ['host', 'node', 'engine', 'source', 'candidate', 'llm', 'model', 'cases', 'provision']) {
            check(equal(execution.target?.execution?.[field], run.target.execution[field]), 'Execution identity changed after freeze');
        }
        const measurements = [...indexed.values()].filter(a => a.type === 'measurement').map(a => { try { return JSON.parse(a.bytes); } catch { return null; } });
        check(measurements.some(value => equal(value, receipt)), 'Final index lacks this exact measurement receipt');
        const smoke = [...indexed.values()].filter(a => a.type === 'smoke').map(a => JSON.parse(a.bytes));
        check(smoke.some(value => value.runId === run.runId && value.case === (profile === 'apple' ? 'LIVE-L6' : 'LIVE-L7')
            && value.profile === profile && value.status === 'pass'), 'Final index lacks matching smoke');
        const cleanup = json('report_cleanup.json');
        check(cleanup.runId === run.runId && cleanup.action === 'cleanup' && cleanup.verdict === 'PASS' && cleanup.exitCode === 0
            && run.cleanup?.state === 'complete' && run.cleanup.failures?.length === 0, 'Incomplete canonical cleanup');
        const actions = [...indexed.values()].filter(a => a.path.endsWith('/action-ownership.json')).map(a => JSON.parse(a.bytes));
        for (const action of ['provision', 'live', 'cleanup']) check(actions.some(value => value.binding?.runId === run.runId
            && value.binding.action === action && value.settled === true && value.exitCode === 0
            && value.transport?.settled === true && value.transport.unresolved?.length === 0), 'Incomplete action settlement');
        const original = Buffer.from(indexed.get('s7/d10-orig-running.txt')?.bytes || '').toString().trim();
        check(['true', 'false'].includes(original) && Buffer.from(indexed.get('s7/A15-result.txt')?.bytes || '').toString()
            === `restored connection=podman-machine-default running=${original} verify=ok\n`, 'Incomplete recorded-state restoration');
        for (const type of ['containers', 'images']) {
            const before = indexed.get(`s7/d10-pre-${type}.txt`); const after = indexed.get(`s7/d10-post-${type}.txt`);
            check(before && after && before.sha256 === after.sha256, 'Unrelated resources changed');
        }
        const review = json('review-receipt.json');
        check(review.runId === run.runId && review.executionManifestSha256 === index.executionManifestSha256
            && review.candidateSha256 === execution.candidate?.sha256 && review.outcome === 'pass'
            && Array.isArray(review.artifacts) && review.artifacts.length === 2, 'Missing bound independent review');
        for (const type of ['code-review', 'implementation-verification']) {
            const artifact = review.artifacts.find(value => value.type === type);
            check(artifact && indexed.get(artifact.path)?.sha256 === artifact.sha256, 'Missing independent review evidence');
        }
        const comparable = { comparisonId: config.comparisonId, model: receipt.model, params: receipt.params, context: receipt.context,
            prompt: receipt.prompt, host: receipt.identity.host, vm: receipt.identity.vm,
            source: { ploinky: run.target.execution.provision.revision, localLlms: run.target.execution.llm.revision,
                tree: receipt.identity.source.stagedTreeDigest, dependency: receipt.identity.source.binding.dependency.generationId,
                provider: receipt.identity.source.binding.provider.sourceIdHash },
            image: run.target.execution.llm.image, imageConfig: run.target.execution.model.imageConfigDigest,
            imageParent: run.target.execution.model.imageParentDigest, cibRevision: run.target.execution.model.cibRevision };
        check(comparable.host && comparable.vm, 'Missing host/VM measurement identity');
        if (baseline) check(equal(baseline, comparable), 'Comparison configuration or identity mismatch'); else baseline = comparable;
    }
    check(['1/apple', '1/apple-cpu', '2/apple', '2/apple-cpu'].every(key => seen.has(key)), 'Incomplete comparison pair');
    return { status: 'pass', comparisonId: baseline.comparisonId, hardwareOnly: false };
}
