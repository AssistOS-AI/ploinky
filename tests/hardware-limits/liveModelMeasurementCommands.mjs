// Fixed, bounded in-agent observers. Arguments identify pins, never commands or paths.
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { MEASUREMENT_DEADLINES, MEASUREMENT_PROMPT, measurementParams, measurementArtifactName,
    validateMeasurementReceipt, cancellationOutcome, summarizeMeasurementTrials } from './liveModelMeasurements.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export function createMeasurementExecutor(ctx) {
    const { run, profile, spec, tool, prepare, observe, write, monitor, sourceProof, hostProof, assertBackend } = ctx;
    const config = profile.model.measurement;
    let count = 0;
    return async function execute(caseId) {
        const params = measurementParams(config); const model = profile.llm.models[caseId === 'LIVE-M4' ? 'larger' : 'small'];
        const receipt = { schema: 1, runId: run.runId, case: caseId, profile: profile.model.profile, configuration: config,
            status: 'blocked', params, model, prompt: { version: MEASUREMENT_PROMPT.version, sha256: hash(MEASUREMENT_PROMPT.text), maxTokens: 64 },
            identity: null, context: null, loads: [], trials: [], stop: null, artifacts: [] };
        const documents = new Map(); const start = performance.now();
        const deadline = start + MEASUREMENT_DEADLINES.blockMs;
        const remaining = () => { const left = Math.floor(deadline - performance.now()); check(left > 0, 'Measurement block deadline expired'); return left; };
        const save = (trial, phase, type, value) => {
            const name = measurementArtifactName(caseId, trial, phase);
            check(!documents.has(name), 'Measurement artifact overwrite');
            const doc = { schema: 1, runId: run.runId, case: caseId, name, configuration: config, value };
            const bytes = Buffer.from(JSON.stringify(doc, null, 2) + '\n');
            documents.set(name, bytes); write(name, doc);
            receipt.artifacts.push({ name, sha256: hash(bytes), type }); return name;
        };
        const clock = (startedMs, endedMs = performance.now()) => ({ clock: 'performance.now', startedMs, endedMs, elapsedMs: endedMs - startedMs });
        let current; let binding;
        const call = (name, args, signal, label, budget = remaining()) => tool(name, args, signal, false,
            { label: `${caseId.toLowerCase()}-${label}-${++count}`, model: model.id, deadlineMs: Math.min(budget, remaining(), MEASUREMENT_DEADLINES.toolMs) });
        const read = (kind, program, args, signal, bound = 30000) => observe(kind, program, args, signal, Math.min(bound, remaining()));
        async function status(signal) { return call('local_llm_status', {}, signal, 'status'); }
        async function captureBinding(state, signal) {
            const facts = await ctx.processes(signal, Math.min(30000, remaining()));
            const startup = state.startupObservation;
            check(startup?.runnerIdentity && facts.length === 1 && facts[0].pid === startup.runnerIdentity.pid, 'Runner observation identity unavailable');
            const process = facts[0];
            check(process.exe === profile.model.executable.path && process.sha256 === profile.model.executable.sha256, 'Runner executable identity changed');
            const detail = await read('runner', MEASUREMENT_RUNNER, [String(process.pid)], signal);
            check(detail.start === process.start && Number.isInteger(detail.resolvedThreads) && detail.resolvedThreads > 0, 'Runner thread/start facts unavailable');
            return { controllerEpoch: startup.controllerEpoch, deploymentId: startup.deploymentId,
                modelId: state.deployment?.modelId, runnerId: state.deployment?.runnerId, runnerIdentity: startup.runnerIdentity,
                process, processGroup: { pid: detail.pid, pgid: detail.pgid, start: detail.start }, resolvedThreads: detail.resolvedThreads,
                shaderCacheIdentity: detail.shaderCacheIdentity, flags: detail.flags };
        }
        async function stop(signal, label, expected = binding, began = performance.now()) {
            const left = Math.floor(60000 - (performance.now() - began)); check(left > 0, 'Stop deadline expired');
            const stopSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(left, remaining()))]);
            const budget = () => Math.max(1, Math.floor(60000 - (performance.now() - began)));
            const response = await call('local_llm_stop', {}, stopSignal, `${label}-stop`, budget());
            let state; let absence;
            for (;;) {
                state = await call('local_llm_status', {}, stopSignal, `${label}-idle`, budget());
                absence = expected ? await read('group', MEASUREMENT_GROUP, [JSON.stringify(expected.processGroup)], stopSignal, budget())
                    : { groupAbsent: (await ctx.processes(stopSignal, Math.min(budget(), remaining()))).length === 0 };
                if (expected) check(['pid', 'pgid', 'start'].every(key => absence[key] === expected.processGroup[key]), 'Runner group observation identity mismatch');
                if (state.phase === 'idle' && absence.groupAbsent === true) break;
                check(performance.now() - began < 60000, 'Stop deadline expired');
                await delay(Math.min(1000, budget()), undefined, { signal: stopSignal });
            }
            const result = { binding: expected, stopObservation: response.stopObservation || state.stopObservation,
                idle: true, groupAbsent: true, absence, clock: 'performance.now', startedMs: began, elapsedMs: performance.now() - began, status: state };
            save(label, 'stop', 'stop', result); return result;
        }
        async function ready(signal, label) {
            for (;;) {
                current = await status(signal);
                if (current.phase === 'ready') return current;
                check(!['error', 'paused'].includes(current.phase) && !['error', 'paused'].includes(current.deployment?.phase), 'Model load failed');
                await delay(Math.min(1000, remaining()), undefined, { signal });
            }
        }
        const launch = (signal, label) => call('local_llm_run', { requestId: `m-${run.runId}-${++count}`, modelId: model.id,
            runnerId: spec.runner, params, replace: false }, signal, `${label}-run`);
        async function load(signal, id) {
            const began = performance.now(); const response = await launch(signal, id); const state = await ready(signal, id);
            const timing = clock(began); binding = await captureBinding(state, signal);
            const returned = response.params || response.deployment?.params;
            for (const [key, value] of Object.entries(params)) check(state.deployment?.params?.[key] === value && returned?.[key] === value, 'Normalized parameter mismatch');
            receipt.context = state.context;
            const load = { id, ...timing, binding, startupObservation: state.startupObservation, pollMs: 1000,
                weightsReused: true, pageCacheState: 'unverified', shaderCachePolicy: 'unchanged-no-harness-purge' };
            load.artifact = save(id, 'load', 'load', load); receipt.loads.push(load);
            save(id, 'memory', 'memory', { binding, sample: await read('memory', MEASUREMENT_MEMORY, [], signal) });
        }
        async function prompt(signal, id) {
            const sampling = new AbortController(); signal = AbortSignal.any([signal, sampling.signal]);
            const samples = [{ monotonicMs: performance.now(), sample: await read('memory', MEASUREMENT_MEMORY, [], signal) }];
            let finished = false; let timer; let wake; let sampleFailure;
            const startedMs = performance.now();
            const pending = call('local_llm_test_prompt', { prompt: MEASUREMENT_PROMPT.text, maxTokens: 64 }, signal, id, 240000)
                .finally(() => { finished = true; clearTimeout(timer); wake?.(); });
            const sampler = (async () => {
                while (!finished) {
                    await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, Math.min(1000, remaining())); });
                    if (finished) break;
                    try { samples.push({ monotonicMs: performance.now(), sample: await read('memory', MEASUREMENT_MEMORY, [], signal) }); }
                    catch (error) { sampleFailure = error; sampling.abort(error); break; }
                }
            })().catch(error => { sampleFailure = error; sampling.abort(error); });
            try {
                const answer = await pending; const endedMs = performance.now(); await sampler;
                if (sampleFailure) throw sampleFailure;
                samples.push({ monotonicMs: performance.now(), sample: await read('memory', MEASUREMENT_MEMORY, [], signal) });
                const trial = { id, ...clock(startedMs, endedMs), binding, answer: { ...answer, outputTokens: answer.outputTokens ?? answer.completionTokens },
                    promptProcessingRate: Number.isFinite(answer.promptTokensPerSecond) ? answer.promptTokensPerSecond : null };
                assertBackend(current, answer, [binding.process], model);
                trial.artifact = save(id, 'prompt', 'prompt', trial); receipt.trials.push(trial); return trial;
            } finally {
                finished = true; clearTimeout(timer); wake?.(); await sampler;
                const cumulative = samples.map(value => Number(value.sample.cgroup['memory.peak'])).filter(value => value > 0);
                save(id, 'memory', 'memory', { binding, sample: samples.at(-1).sample,
                    window: { startedMs, endedMs: performance.now(), samples, peakKind: cumulative.length ? 'cumulative' : 'sampled',
                        peakBytes: Math.max(...samples.map(value => Number(value.sample.cgroup['memory.current'])), ...cumulative) } });
            }
        }
        try {
            receipt.identity = await prepare();
            await monitor(async hostSignal => {
                const signal = AbortSignal.any([hostSignal, AbortSignal.timeout(remaining()), ...(ctx.signal ? [ctx.signal] : [])]);
                const host = await hostProof(signal, Math.min(10000, remaining()));
                Object.assign(receipt.identity, host); save('cohort', 'host', 'host', host);
                save('cohort', 'source-before', 'source', await sourceProof(signal));
                await stop(signal, 'initial', null);
                const preview = await call('local_llm_overview', { preview: { modelId: model.id, runnerId: spec.runner, params } }, signal, 'preview');
                if (preview.preview?.admission?.status !== 'ok') {
                    receipt.status = 'refused'; throw new Error('Measurement configuration was not admitted');
                }
                await launch(signal, 'acquisition'); await ready(signal, 'acquisition'); binding = await captureBinding(current, signal);
                receipt.backend = { profile: current.profile, device: current.runnerReport?.device || null,
                    offloadedLayers: current.runnerReport?.offloaded?.layers || 0, process: binding.process };
                save('acquisition', 'runtime', 'runtime', { binding, backend: receipt.backend });
                save('acquisition', 'memory', 'memory', { binding, sample: await read('memory', MEASUREMENT_MEMORY, [], signal) });
                await stop(signal, 'acquisition');
                save('cohort', 'weights-before', 'weights', await read('weights', MEASUREMENT_WEIGHTS, [JSON.stringify(model)], signal));
                if (caseId === 'LIVE-M5') {
                    await launch(signal, 'load-cancel');
                    for (;;) {
                        current = await status(signal);
                        if (current.startupObservation?.loadingObserved || current.startupObservation?.firstAcceptedHealthSequence || current.phase === 'ready') break;
                        check(!['error', 'idle', 'paused'].includes(current.phase), 'No loading observation');
                        await delay(Math.min(1000, remaining()), undefined, { signal });
                    }
                    binding = await captureBinding(current, signal); receipt.stop = await stop(signal, 'load-cancel');
                    receipt.status = cancellationOutcome(caseId, receipt.stop);
                } else {
                    await load(signal, 'fresh');
                    if (caseId === 'LIVE-M6') {
                        receipt.loads = []; const observationId = `measure_${run.runId}`;
                        const promptController = new AbortController();
                        const promptSignal = AbortSignal.any([signal, promptController.signal]);
                        let settled = false; let settledAt = null; let stopTimer;
                        const pending = call('local_llm_test_prompt', { prompt: MEASUREMENT_PROMPT.text, maxTokens: 64, observationId }, promptSignal, 'observed', 240000)
                            .then(answer => { settledAt = performance.now(); return { succeeded: true, answer, errorCode: null }; }, error => {
                                settledAt = performance.now(); return { succeeded: false, errorCode: /^[a-z][a-z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'tool_error' };
                            })
                            .finally(() => { settled = true; });
                        try {
                            let observed;
                            for (;;) {
                                current = await status(signal); observed = current.promptObservations?.find(item => item.id === observationId);
                                if (observed?.firstTokenPresent || settled) break;
                                await delay(Math.min(1000, remaining()), undefined, { signal });
                            }
                            const alreadySettled = settled; const stopStarted = performance.now();
                            stopTimer = setTimeout(() => promptController.abort(Error('Stop settlement deadline expired')), Math.min(60000, remaining()));
                            const stopRemaining = () => { const value = Math.floor(60000 - (performance.now() - stopStarted)); check(value > 0, 'Stop settlement deadline expired'); return value; };
                            receipt.stop = await stop(promptSignal, 'generation-cancel', binding, stopStarted); const result = await pending;
                            receipt.stop.promptObservationId = observationId;
                            receipt.stop.promptSucceeded = result.succeeded;
                            receipt.stop.promptSettlement = { succeeded: result.succeeded, errorCode: result.errorCode,
                                elapsedMs: alreadySettled ? 0 : Math.max(0, settledAt - stopStarted) };
                            const terminal = await call('local_llm_status', {}, promptSignal, 'generation-terminal', stopRemaining());
                            receipt.stop.promptObservation = terminal.promptObservations?.find(item => item.id === observationId);
                            save('generation-cancel', 'observation', 'cancellation', receipt.stop);
                            receipt.status = cancellationOutcome(caseId, receipt.stop);
                        } finally {
                            clearTimeout(stopTimer);
                            if (!settled) promptController.abort(Error('Observed measurement finished without prompt settlement'));
                            await pending;
                        }
                    } else {
                        if (caseId === 'LIVE-M3') {
                            const concurrent = new AbortController(); const pairSignal = AbortSignal.any([signal, concurrent.signal]);
                            const results = await Promise.allSettled(['concurrent-1', 'concurrent-2'].map(id => prompt(pairSignal, id).catch(error => { concurrent.abort(error); throw error; })));
                            const failure = results.find(value => value.status === 'rejected'); if (failure) throw failure.reason;
                            receipt.trials.sort((a, b) => a.id.localeCompare(b.id));
                        } else for (const id of ['warmup', 'trial-1', 'trial-2', 'trial-3']) await prompt(signal, id);
                        receipt.stop = await stop(signal, 'fresh');
                        if (caseId === 'LIVE-M1') { await load(signal, 'reload'); receipt.stop = await stop(signal, 'reload'); }
                        receipt.status = 'pass';
                    }
                }
                save('cohort', 'weights-after', 'weights', await read('weights', MEASUREMENT_WEIGHTS, [JSON.stringify(model)], signal));
                save('cohort', 'source-after', 'source', await sourceProof(signal));
                save('cohort', 'host-after', 'host', await hostProof(signal, Math.min(10000, remaining())));
            });
            receipt.summary = summarizeMeasurementTrials(receipt.trials);
            validateMeasurementReceipt(receipt, { run, runId: run.runId, caseId, profile: profile.model.profile, configuration: config, readArtifact: name => documents.get(name) });
            return receipt;
        } catch (error) {
            if (receipt.status === 'pass') receipt.status = 'failed';
            receipt.reason = String(error.message).slice(0, 400);
            throw Object.assign(error, { evidence: receipt });
        } finally { write(`measurement-${caseId.toLowerCase()}`, receipt); }
    };
}
export function observeCachedWeights(pin, root, { fs, path, crypto, artifactPaths }) {
    const files = pin.files || [{ file: pin.file, size: pin.size, sha256: pin.sha256 }];
    if (!Array.isArray(files) || !files.length || files.length > 64) throw Error('Invalid shard count');
    const results = [];
    for (const part of files) {
        const artifact = { ...pin, ...part, file: part.file || part.path };
        const file = artifactPaths({ root, artifact }).file;
        const relative = path.relative(root, file);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Weights escape root');
        let cursor = root;
        for (const item of relative.split(path.sep)) {
            cursor = path.join(cursor, item);
            if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('Symlink in weights path');
        }
        if (fs.realpathSync(root) !== root || fs.realpathSync(file) !== file) throw Error('Weights root changed');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = fs.fstatSync(fd); const hash = crypto.createHash('sha256'); let size = 0;
        try {
            if (!before.isFile() || before.size !== artifact.size) throw Error('Weights type or size mismatch');
            const buffer = Buffer.alloc(1048576);
            for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break; size += n; hash.update(buffer.subarray(0, n)); }
            const after = fs.fstatSync(fd);
            const current = fs.lstatSync(file);
            if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
                || current.isSymbolicLink() || current.ino !== after.ino || current.dev !== after.dev || fs.realpathSync(file) !== file) throw Error('Weights changed');
        } finally { fs.closeSync(fd); }
        const sha256 = hash.digest('hex');
        if (size !== artifact.size || sha256 !== artifact.sha256) throw Error('Weights hash mismatch');
        results.push({ file: artifact.file, size, sha256 });
    }
    return { root: 'controller-gguf-cache', files: results, weightsReused: true, pageCacheState: 'unverified', shaderCachePolicy: 'unchanged-no-harness-purge' };
}

// The controller's path resolver ships in the pworker engine package, which Ploinky binds read-only from the agent's
// dependency store at /code/node_modules. It is imported by this absolute path, not by the package name: an eval'd
// script resolves a bare specifier from its working directory, and NODE_PATH does not apply to ES modules.
export const MEASUREMENT_DOWNLOADER_MODULE = '/code/node_modules/pworker/lib/local-llm/controller/downloader.mjs';

export const MEASUREMENT_WEIGHTS = `
(async()=>{
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {artifactPaths}=await import(${JSON.stringify(MEASUREMENT_DOWNLOADER_MODULE)});
const observe=${observeCachedWeights.toString()};
process.stdout.write(JSON.stringify(observe(JSON.parse(process.argv[1]),'/data/models/gguf',{fs,path,crypto,artifactPaths})));
})().catch(()=>{process.stderr.write('Bounded weights observation failed');process.exitCode=3;});`;

export const MEASUREMENT_MEMORY = String.raw`
const fs=require('node:fs');
const read=(file,optional=false)=>{try{const s=fs.statSync(file);if(s.size>65536)throw Error('Observation too large');const v=fs.readFileSync(file,'utf8');if(v.length>65536)throw Error('Observation too large');return v.trim();}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}};
const self=read('/proc/self/cgroup');if(!/^0::\/\s*$/.test(self))throw Error('Agent cgroup namespace is not rooted');
const memory={};for(const name of ['memory.current','memory.peak','memory.max','memory.swap.current','memory.events'])memory[name]=read('/sys/fs/cgroup/'+name,name==='memory.peak');
const vm=read('/proc/meminfo');const pick=(name)=>{const m=new RegExp('^'+name+':\\s+(\\d+) kB$','m').exec(vm);if(!m)throw Error('VM memory unavailable');return Number(m[1])*1024;};
process.stdout.write(JSON.stringify({vm:{totalBytes:pick('MemTotal'),availableBytes:pick('MemAvailable'),swapTotalBytes:pick('SwapTotal'),swapFreeBytes:pick('SwapFree')},cgroup:memory,peakKind:memory['memory.peak']===null?'unavailable':'cumulative'}));`;

export const MEASUREMENT_RUNNER = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');const pid=Number(process.argv[1]);
if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid runner PID');
const stat=()=>{const s=fs.readFileSync('/proc/'+pid+'/stat','utf8');const f=s.slice(s.lastIndexOf(')')+2).split(' ');return {start:f[19],pgid:Number(f[2])};};
const before=stat();const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');const safe={};
const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0');const cache=env.filter(value=>value.startsWith('MESA_SHADER_CACHE_DIR='));
if(cache.length>1||cache.some(value=>value.length>512))throw Error('Shader cache observation unavailable');
const shaderCacheIdentity=cache.length?crypto.createHash('sha256').update(cache[0]).digest('hex'):null;
for(const key of ['--threads','-c','--ctx-size','-np','--parallel','--device','--n-gpu-layers','--fit']){const hits=args.flatMap((v,i)=>v===key?[args[i+1]]:[]);if(hits.length>1||hits.some(v=>!v||v.length>128))throw Error('Invalid safe runner flag');safe[key]=hits[0]??null;}
const after=stat();if(before.start!==after.start||before.pgid!==after.pgid)throw Error('Runner changed');
process.stdout.write(JSON.stringify({pid,...before,flags:safe,resolvedThreads:Number(safe['--threads']),shaderCacheIdentity}));`;

// A group receipt is observed inside the exact pinned agent container. It is never used to signal a PID.
export const MEASUREMENT_GROUP = String.raw`
const fs=require('node:fs');const pin=JSON.parse(process.argv[1]);
if(!Number.isInteger(pin.pid)||pin.pid<1||!Number.isInteger(pin.pgid)||pin.pgid<1||!/^\d+$/.test(pin.start))throw Error('Invalid process receipt');
const names=fs.readdirSync('/proc').filter(v=>/^\d+$/.test(v));if(names.length>4096)throw Error('Process bound exceeded');let absent=true;
for(const name of names){try{const s=fs.readFileSync('/proc/'+name+'/stat','utf8');const f=s.slice(s.lastIndexOf(')')+2).split(' ');
if(Number(name)===pin.pid&&f[19]!==pin.start)throw Error('Runner PID reused');if(Number(f[2])===pin.pgid&&f[0]!=='Z')absent=false;
}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e;}}
process.stdout.write(JSON.stringify({groupAbsent:absent,pid:pin.pid,pgid:pin.pgid,start:pin.start}));`;
