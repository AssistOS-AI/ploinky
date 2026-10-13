// Offline controls. No model, engine, machine or inference is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { imageSourceIdentity, imageSourceIdHash } from '../../agentlib/contract.mjs';
import { pathToFileURL } from 'node:url';
import { LLM_TOOL_CALL } from '../hardware-limits/liveLlmCommands.mjs';
import { normalizeMeasurement, measurementCases, measurementParams, validateMeasurementReceipt,
    validateMeasurementComparison, cancellationOutcome, MEASUREMENT_DEADLINES, assertCachePreparation } from '../hardware-limits/liveModelMeasurements.mjs';
import { createMeasurementExecutor, observeCachedWeights, MEASUREMENT_WEIGHTS, MEASUREMENT_MEMORY, MEASUREMENT_RUNNER, MEASUREMENT_GROUP } from '../hardware-limits/liveModelMeasurementCommands.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const small = { id: 'qwen2.5-0.5b-instruct-q4_k_m', repo: 'Qwen/model', file: 'model.gguf', commit: 'a'.repeat(40), size: 500, sha256: 'b'.repeat(64) };
const larger = { ...small, id: 'qwen2.5-1.5b-instruct-q4_k_m', file: 'larger.gguf', size: 1000 };
const config = scenario => normalizeMeasurement({ schema: 1, comparisonId: 'a'.repeat(32), cohort: 1, scenario }, { small, larger }, 'apple');
const cache = { policy: 'existing-best-effort-per-file-drop', phase: 'complete', filesConsidered: 1, attempts: 1,
    reportedSuccesses: 0, reportedFailures: 1, skippedNonRegular: 0, observationErrors: 0 };

function world(scenario = 'baseline-v1', modelProfile = 'apple', cohort = 1) {
    const configuration = normalizeMeasurement({ ...config(scenario), cohort }, { small, larger }, modelProfile);
    const params = measurementParams(configuration); const model = scenario === 'larger-model-v1' ? larger : small;
    const cpu = modelProfile === 'apple-cpu'; const runner = cpu ? 'llama.cpp' : 'llama.cpp-vulkan';
    const profile = { model: { profile: modelProfile, measurement: configuration, executable: { path: `/opt/${runner}/llama-server`, sha256: 'd'.repeat(64) } },
        llm: { models: { small, larger }, revision: 'a'.repeat(40), image: 'registry/model@sha256:' + '9'.repeat(64) } };
    const run = { runId: (cpu ? 'b' : 'a').repeat(30) + '0' + cohort, block: cpu ? 'mac-model-cpu' : 'mac-model-venus', target: { execution: profile }, cleanup: { state: 'complete', failures: [] } }; const artifacts = new Map(); const calls = [];
    let running = false; let epoch = 0; let state; let observation; let resolvePrompt; let sequence = 0;
    const proc = () => ({ pid: 42, start: String(100 + epoch), exe: profile.model.executable.path, sha256: profile.model.executable.sha256,
        args: cpu ? { '--device': 'none', '--n-gpu-layers': '0', '--fit': 'off' } : { '--device': 'Vulkan0' },
        icd: cpu ? null : '/opt/local-llm/vulkan/icd.d/virtio_icd.json', layers: cpu ? null : '~all~', cudaVisible: cpu ? '' : null, gpuNodes: [], mps: false, nvidiaLibrary: false });
    const source = { path: '/offline/workspace/local-llms/local-llm', originalTreeDigest: 'sha256:' + 'a'.repeat(64), manifest: { originalDigest: 'sha256:' + 'b'.repeat(64), rewrittenDigest: 'sha256:' + 'c'.repeat(64) },
        stagedTreeDigest: 'sha256:' + 'e'.repeat(64), binding: { stage: '/offline/workspace/.ploinky/container-runtime/code', files: 1, treeDigest: 'sha256:' + 'e'.repeat(64),
            dependency: { objectId: '11111111-2222-4333-8444-555555555555', generationId: 'f'.repeat(64), inputKey: 'a'.repeat(64), treeDigest: 'b'.repeat(64), packageSha256: 'c'.repeat(64),
                nodeModulesPath: '/offline/workspace/.ploinky/deps/store/objects/11111111-2222-4333-8444-555555555555/payload/node_modules' },
            provider: { mode: 'image', path: '/opt/ploinky-agentlib', supplyingImageId: 'sha256:' + '4'.repeat(64), boxId: '3'.repeat(64),
                sourceIdHash: imageSourceIdHash(imageSourceIdentity('sha256:' + '4'.repeat(64))) } } };
    profile.workspace = { path: '/offline/workspace' };
    profile.provision = { revision: 'b'.repeat(40), llm: { treeDigest: source.originalTreeDigest, manifest: source.manifest } };
    profile.box = { id: '3'.repeat(64), image: '4'.repeat(64) };
    profile.agents = [{ id: '2'.repeat(64), role: 'llm', image: '5'.repeat(64) }]; profile.model.imageConfigDigest = 'sha256:' + '5'.repeat(64);
    const host = { host: { chip: 'Offline Apple', ramBytes: 16 * 2 ** 30, osVersion: 'offline' },
        vm: { cpus: 4, ramBytes: 6 * 2 ** 30, provider: 'libkrun' },
        guard: { samples: [{ memoryLevel: 50, pressure: 1, swapMiB: 0, krunkitRssMiB: 1024 }] } };
    const memory = { vm: { totalBytes: 6 * 2 ** 30, availableBytes: 4 * 2 ** 30 },
        cgroup: { 'memory.current': '1000', 'memory.peak': '2000', 'memory.max': 'max', 'memory.swap.current': '0', 'memory.events': 'oom_kill 0' }, peakKind: 'cumulative' };
    const tool = async (name, args, signal, cleanup, options) => {
        assert.ok(options.deadlineMs > 0 && options.deadlineMs <= MEASUREMENT_DEADLINES.toolMs); calls.push({ name, args, label: options.label });
        if (name === 'local_llm_overview') return { preview: { admission: { status: 'ok' } } };
        if (name === 'local_llm_run') {
            running = true; epoch++;
            const health = { status: scenario === 'load-cancel-v1' && epoch > 1 ? 503 : 200, accepted: !(scenario === 'load-cancel-v1' && epoch > 1), sequence: ++sequence, monotonicMs: 1 };
            state = { phase: health.accepted ? 'ready' : 'starting', profile: cpu ? 'cpu' : 'venus', runnerReport: { device: cpu ? 'CPU' : 'Vulkan0', offloaded: { layers: cpu ? 0 : 25 } }, deployment: { id: `deployment-${epoch}`, params, modelId: model.id, runnerId: runner }, context: { totalContext: params.ctxSize,
                perRequestContext: Math.floor(params.ctxSize / params.parallel), parallel: params.parallel, kvUnified: false },
            startupObservation: { controllerEpoch: 'epoch', deploymentId: `deployment-${epoch}`, runnerIdentity: { runnerStartId: `runner-${epoch}`, pid: 42 },
                loadingObserved: !health.accepted, latestHealthObservation: health, firstAcceptedHealthSequence: health.accepted ? health.sequence : null,
                observationErrors: 0, pageCachePreparation: copy(cache) } };
            return { deployment: { params } };
        }
        if (name === 'local_llm_status') return running ? { ...copy(state), promptObservations: observation ? [copy(observation)] : [] }
            : { phase: 'idle', promptObservations: observation ? [copy(observation)] : [] };
        if (name === 'local_llm_test_prompt') {
            if (args.observationId) {
                observation = { id: args.observationId, modelId: model.id, runnerId: runner, ...copy(state.startupObservation), phase: 'active', firstTokenPresent: true, firstTokenSequence: ++sequence };
                return new Promise((resolve, reject) => { resolvePrompt = reject; });
            }
            await new Promise(resolve => setTimeout(resolve, 2));
            return { text: 'Blue', modelId: model.id, runnerId: runner, generationTokensPerSecond: 10, completionTokens: 2 };
        }
        if (name === 'local_llm_stop') {
            const startup = state?.startupObservation;
            const stopObservation = startup ? { controllerEpoch: startup.controllerEpoch, deploymentId: startup.deploymentId,
                runnerIdentity: startup.runnerIdentity, phaseAtStop: state.phase, runnerRunning: running, sequence: ++sequence,
                latestHealthObservation: startup.latestHealthObservation, firstAcceptedHealthSequence: startup.firstAcceptedHealthSequence,
                startupObservation: copy(startup), monotonicMs: 2 } : null;
            running = false;
            if (resolvePrompt) {
                observation.stopSequence = stopObservation.sequence; observation.stopNotificationSequence = ++sequence; observation.terminalSequence = ++sequence;
                observation.cancellation = { mechanism: 'controller-stop-abort-v1', stopSequence: observation.stopSequence, notificationSequence: observation.stopNotificationSequence };
                observation.phase = 'terminal'; observation.outcome = 'interrupted-after-stop'; observation.errorCode = 'prompt_cancelled_by_stop';
                resolvePrompt(Object.assign(Error('cancelled'), { code: 'prompt_cancelled_by_stop' })); resolvePrompt = null;
            }
            return { stopObservation };
        }
        throw Error('Unexpected tool');
    };
    const executor = createMeasurementExecutor({ run, profile, spec: { runner }, tool,
        prepare: async () => ({ source: copy(source), agent: { id: '2'.repeat(64), image: '5'.repeat(64) }, box: copy(profile.box) }),
        write: (name, value) => artifacts.set(name, Buffer.from(JSON.stringify(value, null, 2) + '\n')),
        monitor: work => work(new AbortController().signal), sourceProof: async () => copy(source), hostProof: async () => copy(host),
        processes: async () => running ? [proc()] : [], assertBackend: () => {},
        observe: async (kind, program, args) => {
            if (program === MEASUREMENT_WEIGHTS) { const m = JSON.parse(args[0]); return { root: 'controller-gguf-cache', files: [{ file: m.file, size: m.size, sha256: m.sha256 }], weightsReused: true, pageCacheState: 'unverified', shaderCachePolicy: 'unchanged-no-harness-purge' }; }
            if (program === MEASUREMENT_MEMORY) return copy(memory);
            if (program === MEASUREMENT_RUNNER) return { ...proc(), pgid: 42, resolvedThreads: 4, shaderCacheIdentity: cpu ? null : 'a'.repeat(64), flags: { '--threads': '4' } };
            if (program === MEASUREMENT_GROUP) return { ...JSON.parse(args[0]), groupAbsent: !running };
            throw Error('Unexpected observer');
        } });
    return { executor, artifacts, calls, run, profile, configuration, validate: receipt => validateMeasurementReceipt(receipt,
        { run, runId: run.runId, caseId: receipt.case, profile: modelProfile, configuration, readArtifact: name => artifacts.get(name) }) };
}

test('MEASURE.configuration-is-exact-frozen-and-Linux-CPU-stays-separate', () => {
    const valid = config('baseline-v1'); assert.equal(Object.isFrozen(valid), true);
    assert.deepEqual(measurementCases('apple', valid), ['LIVE-L6', 'LIVE-M1']);
    assert.deepEqual(measurementCases('apple-cpu', valid), ['LIVE-L7', 'LIVE-M1']);
    for (const change of [{ command: 'x' }, { prompt: 'x' }, { trialCount: 1 }, { comparisonId: 'A'.repeat(32) }, { cohort: 3 }, { baselineContext: 8192 }, { scenario: 'unknown' }]) {
        assert.throws(() => normalizeMeasurement({ ...valid, ...change }, { small }, 'apple'));
    }
    for (const profile of ['cpu', 'nvidia', 'venus', '']) assert.throws(() => normalizeMeasurement(valid, { small }, profile));
    assert.throws(() => normalizeMeasurement(config('longer-context-v1'), { small }, 'apple-cpu'));
    assert.throws(() => normalizeMeasurement(valid, { small: { ...small, id: 'other' } }, 'apple'));
});

test('MEASURE.all-six-executors-retain-exact-trials-and-reload-policy-offline', async () => {
    for (const [scenario, id] of Object.entries({ 'baseline-v1': 'LIVE-M1', 'longer-context-v1': 'LIVE-M2', 'two-slots-v1': 'LIVE-M3',
        'larger-model-v1': 'LIVE-M4', 'load-cancel-v1': 'LIVE-M5', 'generation-cancel-v1': 'LIVE-M6' })) {
        const w = world(scenario); const receipt = await w.executor(id); assert.equal(receipt.status, 'pass'); w.validate(receipt);
        const prompts = w.calls.filter(call => call.name === 'local_llm_test_prompt');
        assert.equal(prompts.length, id === 'LIVE-M3' ? 2 : id === 'LIVE-M5' ? 0 : id === 'LIVE-M6' ? 1 : 4);
        assert.equal(new Set(w.calls.map(call => call.label)).size, w.calls.length);
        for (const call of w.calls.filter(call => call.name === 'local_llm_run')) assert.deepEqual(call.args.params, measurementParams(w.configuration));
        if (id === 'LIVE-M1') { assert.equal(receipt.loads.length, 2); assert.equal(receipt.loads[0].pageCacheState, 'unverified'); assert.equal(receipt.loads[1].startupObservation.pageCachePreparation.reportedFailures, 1); }
    }
});

test('MEASURE.missing-duplicate-swapped-and-rehashed-contradictory-evidence-refuses', async () => {
    const w = world(); const original = await w.executor('LIVE-M1');
    for (const mutate of [r => r.trials.pop(), r => r.trials.push(copy(r.trials[0])), r => r.trials.reverse(), r => r.loads.pop(),
        r => { r.trials[1].answer.outputTokens++; }, r => { r.loads[0].startupObservation.deploymentId = 'stale'; },
        r => { r.context.perRequestContext++; }, r => { r.model.sha256 = '0'.repeat(64); }, r => r.artifacts.pop()]) {
        const bad = copy(original); mutate(bad); assert.throws(() => w.validate(bad));
    }
    const changed = copy(original); const entry = changed.artifacts.find(a => a.type === 'prompt');
    const saved = w.artifacts.get(entry.name); const doc = JSON.parse(saved); doc.value.answer.outputTokens = 999;
    const bytes = Buffer.from(JSON.stringify(doc)); w.artifacts.set(entry.name, bytes); entry.sha256 = hash(bytes);
    assert.throws(() => w.validate(changed), /contradicts/); w.artifacts.set(entry.name, saved);
    const missingHost = copy(original); const host = missingHost.artifacts.find(a => a.type === 'host');
    w.artifacts.delete(host.name); assert.throws(() => w.validate(missingHost));
});

test('MEASURE.source-receipt-must-match-complete-hashed-dependency-and-provider', async () => {
    const w = world(); const original = await w.executor('LIVE-M1');
    for (const mutate of [r => { r.identity.source.binding.dependency.generationId = '0'.repeat(64); },
        r => { r.identity.source.binding.provider.sourceIdHash = '0'.repeat(64); }, r => { delete r.identity.source.binding.provider; },
        r => { delete r.identity.source.binding.dependency; }]) {
        const changed = copy(original); mutate(changed); assert.throws(() => w.validate(changed), /source|binding|identity/i);
    }
    const changed = copy(original);
    for (const entry of changed.artifacts.filter(value => value.type === 'source')) {
        const doc = JSON.parse(w.artifacts.get(entry.name)); doc.value.binding.dependency.generationId = '0'.repeat(64);
        const bytes = Buffer.from(JSON.stringify(doc)); w.artifacts.set(entry.name, bytes); entry.sha256 = hash(bytes);
    }
    assert.throws(() => w.validate(changed), /source|binding|identity/i);
});

test('MEASURE.health-and-generation-cancellation-reject-unobserved-or-successful-races', async () => {
    const load = await world('load-cancel-v1').executor('LIVE-M5');
    for (const mutate of [s => { s.stopObservation.phaseAtStop = 'ready'; }, s => { s.stopObservation.firstAcceptedHealthSequence = 1; },
        s => { s.stopObservation.latestHealthObservation.status = 200; }, s => { s.stopObservation.startupObservation.loadingObserved = false; }]) {
        const value = copy(load.stop); mutate(value); assert.notEqual(cancellationOutcome('LIVE-M5', value), 'pass');
    }
    const generation = await world('generation-cancel-v1').executor('LIVE-M6');
    for (const mutate of [s => { s.promptSucceeded = true; }, s => { s.promptObservation.outcome = 'success'; },
        s => { s.promptObservation.firstTokenPresent = false; }, s => { s.binding.runnerIdentity.runnerStartId = 'stale'; },
        s => { s.promptObservation.errorCode = 'runner_unreachable'; }, s => { s.promptObservation.errorCode = 'observation_reply_lost'; },
        s => { s.promptObservationId = 'foreign_observation'; }, s => { s.promptSettlement.errorCode = 'observation_incomplete'; },
        s => { s.promptObservation.cancellation.mechanism = 'generic-network-error'; }, s => { s.promptObservation.stopNotificationSequence = s.promptObservation.stopSequence; },
        s => { s.promptObservation.cancellation.notificationSequence++; }, s => { s.promptSettlement.elapsedMs = 60001; },
        s => { s.elapsedMs = 60001; }, s => { s.groupAbsent = false; }]) {
        const value = copy(generation.stop); mutate(value); assert.notEqual(cancellationOutcome('LIVE-M6', value), 'pass');
    }
});

test('MEASURE.generated-routed-projection-and-error-reach-real-cancellation-consumer', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-wire-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const auth = path.join(root, 'auth.mjs'); const client = path.join(root, 'client.mjs');
    fs.writeFileSync(auth, 'export const mintSessionJwt=()=>"private-session-marker";');
    const program = LLM_TOOL_CALL.replace('/opt/ploinky/cli/server/auth/localService.js', pathToFileURL(auth).href)
        .replace('/opt/ploinky/Agent/client/MCPBrowserClient.js', pathToFileURL(client).href);
    const receipt = await world('generation-cancel-v1').executor('LIVE-M6');
    const execute = (observation, errorCode = 'prompt_cancelled_by_stop') => {
        const status = { phase: 'idle', promptObservations: [observation] };
        fs.writeFileSync(client, `export const createAgentClient=()=>({listTools:async()=>['local_llm_status','local_llm_test_prompt'].map(name=>({name,agent:'local-llm'})),
callTool:async(name)=>name==='local_llm_status'?{json:${JSON.stringify(status)}}:{isError:true,content:[{type:'text',text:JSON.stringify({error:${JSON.stringify(errorCode)},message:'fixture'})}]},close:async()=>{}});`);
        const call = (name, args) => {
            const output = spawnSync(process.execPath, ['-e', program, name, JSON.stringify(args), '{"agent":"local-llm","budgetMs":5000}'], { encoding: 'utf8', timeout: 6000, maxBuffer: 65536 });
            assert.equal(output.status, 0, output.stderr); assert.ok(!output.stdout.includes('private-session-marker')); return JSON.parse(output.stdout);
        };
        const projected = call('local_llm_status', {}).result.promptObservations[0];
        const failed = call('local_llm_test_prompt', { prompt: 'Name one colour.', maxTokens: 64, observationId: receipt.stop.promptObservationId });
        return { projected, failed, stop: { ...copy(receipt.stop), promptObservation: projected,
            promptSettlement: { ...receipt.stop.promptSettlement, errorCode: failed.error.code } } };
    };
    const observation = { ...copy(receipt.stop.promptObservation), lease: 'private-session-marker', targetUrl: 'private-session-marker',
        cancellation: { ...receipt.stop.promptObservation.cancellation, token: 'private-session-marker' } };
    const valid = execute(observation); assert.equal(cancellationOutcome('LIVE-M6', valid.stop), 'pass');
    assert.equal(valid.projected.lease, undefined); assert.equal(valid.projected.targetUrl, undefined); assert.equal(valid.projected.cancellation.token, undefined);
    for (const mutate of [o => { delete o.stopNotificationSequence; }, o => { delete o.cancellation; },
        o => { o.cancellation.stopSequence++; }, o => { o.id = 'different_observation'; }, o => { o.stopSequence++; }]) {
        const changed = copy(observation); mutate(changed); assert.notEqual(cancellationOutcome('LIVE-M6', execute(changed).stop), 'pass');
    }
    for (const code of ['prompt_transport_failed', 'prompt_stream_invalid', 'observation_incomplete', 'prompt_timeout']) {
        assert.notEqual(cancellationOutcome('LIVE-M6', execute(observation, code).stop), 'pass');
    }
});

test('MEASURE.cache-preparation-retains-false-and-thrown-results-without-eviction-claim', () => {
    const binding = { controllerEpoch: 'a', deploymentId: 'b' };
    for (const summary of [cache, { ...cache, reportedFailures: 0, reportedSuccesses: 1 }, { ...cache, reportedFailures: 0, observationErrors: 1 }]) {
        assertCachePreparation({ ...binding, pageCachePreparation: summary }, binding);
    }
    for (const summary of [{ ...cache, phase: 'pending' }, { ...cache, attempts: 0 }, { ...cache, filesConsidered: 0 }]) {
        assert.throws(() => assertCachePreparation({ ...binding, pageCachePreparation: summary }, binding));
    }
    assert.throws(() => assertCachePreparation({ ...binding, deploymentId: 'old', pageCachePreparation: cache }, binding));
});

test('MEASURE.comparison-never-accepts-incomplete-or-duplicate-pairs', () => {
    assert.throws(() => validateMeasurementComparison([]));
    assert.throws(() => validateMeasurementComparison([{}, {}, {}, {}]));
});

async function finalizedBundle(profile, cohort) {
    const w = world('baseline-v1', profile, cohort); const receipt = await w.executor('LIVE-M1');
    const artifacts = [...w.artifacts].map(([name, bytes]) => ({ path: name, sha256: hash(bytes), type: 'measurement', outcome: 'pass' }));
    const add = (path, value, type) => {
        const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); w.artifacts.set(path, bytes);
        artifacts.push({ path, sha256: hash(bytes), type, outcome: 'pass' }); return hash(bytes);
    };
    const executionManifestSha256 = add('execution-manifest.json', { schema: 1, runId: w.run.runId, profile, block: w.run.block,
        target: w.run.target, configuration: w.configuration, candidate: { sha256: '8'.repeat(64) } }, 'execution-manifest');
    add('smoke.json', { runId: w.run.runId, case: profile === 'apple' ? 'LIVE-L6' : 'LIVE-L7', profile, status: 'pass' }, 'smoke');
    add('report_cleanup.json', { runId: w.run.runId, action: 'cleanup', verdict: 'PASS', exitCode: 0 }, 'cleanup');
    for (const action of ['provision', 'live', 'cleanup']) add(`${action}/action-ownership.json`, { binding: { runId: w.run.runId, action }, settled: true, exitCode: 0,
        transport: { settled: true, unresolved: [] } }, 'settlement');
    add('s7/d10-orig-running.txt', 'false\n', 'restoration');
    add('s7/A15-result.txt', 'restored connection=podman-machine-default running=false verify=ok\n', 'restoration');
    for (const type of ['containers', 'images']) for (const side of ['pre', 'post']) add(`s7/d10-${side}-${type}.txt`, 'unrelated\n', 'restoration');
    const reviews = ['code-review', 'implementation-verification'].map(type => ({ type, path: `${type}.txt`, sha256: add(`${type}.txt`, 'offline fixture', 'review') }));
    add('review-receipt.json', { runId: w.run.runId, executionManifestSha256, candidateSha256: '8'.repeat(64), outcome: 'pass', artifacts: reviews }, 'review');
    return { run: w.run, receipt, index: { schema: 1, runId: w.run.runId, executionManifestSha256, artifacts,
        outcome: 'pass', settlement: true, cleanup: true, restoration: true }, readArtifact: name => w.artifacts.get(name), artifacts: w.artifacts };
}

test('MEASURE.finalized-comparison-binds-four-pairs-and-refuses-mixed-identities', async () => {
    const cohorts = await Promise.all([finalizedBundle('apple', 1), finalizedBundle('apple-cpu', 1), finalizedBundle('apple', 2), finalizedBundle('apple-cpu', 2)]);
    assert.equal(validateMeasurementComparison(cohorts).status, 'pass');
    for (const change of [bundle => { bundle.index.cleanup = false; }, bundle => { bundle.run.target.execution.llm.models.small.sha256 = '0'.repeat(64); },
        bundle => { bundle.receipt.identity.vm.cpus++; }, bundle => { bundle.receipt.backend.offloadedLayers = 0; },
        bundle => { bundle.index.executionManifestSha256 = '0'.repeat(64); }, bundle => { bundle.index.artifacts.pop(); }]) {
        const index = 0; const original = cohorts[index];
        const changed = { ...original, run: copy(original.run), receipt: copy(original.receipt), index: copy(original.index) }; change(changed);
        assert.throws(() => validateMeasurementComparison([changed, ...cohorts.slice(1)]));
    }
    assert.throws(() => validateMeasurementComparison([cohorts[0], cohorts[0], cohorts[2], cohorts[3]]));
});

test('MEASURE.cached-weights-real-process-checks-hashes-and-refuses-symlink-traversal', t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'measure-weights-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bytes = Buffer.from('offline weights'); const pin = { ...small, size: bytes.length, sha256: hash(bytes) };
    fs.writeFileSync(path.join(root, pin.file), bytes);
    const program = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const observe=${observeCachedWeights.toString()};
const result=observe(JSON.parse(process.argv[1]),process.argv[2],{fs,path,crypto,artifactPaths:({root,artifact})=>({file:path.resolve(root,artifact.file)})});
process.stdout.write(JSON.stringify(result));`;
    const run = value => spawnSync(process.execPath, ['-e', program, JSON.stringify(value), root], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    const valid = run(pin); assert.equal(valid.status, 0, valid.stderr); assert.equal(JSON.parse(valid.stdout).files[0].sha256, pin.sha256);
    assert.notEqual(run({ ...pin, sha256: '0'.repeat(64) }).status, 0);
    assert.notEqual(run({ ...pin, file: '../escape' }).status, 0);
    fs.symlinkSync(path.join(root, pin.file), path.join(root, 'link.gguf'));
    assert.notEqual(run({ ...pin, file: 'link.gguf' }).status, 0);
    let statRead = 0;
    const io = { ...fs, fstatSync: fd => ({ ...fs.fstatSync(fd), isFile: () => true, mtimeMs: ++statRead }) };
    assert.throws(() => observeCachedWeights(pin, root, { fs: io, path, crypto, artifactPaths: ({ root, artifact }) => ({ file: path.join(root, artifact.file) }) }), /changed/);
});
