import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { APU_PARAMS, APU_STOP_MS } from './liveApuPins.mjs';
import { apuRequestId, validateApuReceipt } from './liveApuEvidence.mjs';
import { createApuTrace } from './liveApuProjection.mjs';
import { APU_ENV_FACTS, APU_DISCOVERY } from './liveApuCommands.mjs';
import { MEASUREMENT_RUNNER, MEASUREMENT_GROUP } from './liveModelMeasurementCommands.mjs';
import { createApuHostScope } from './liveApuHost.mjs';
import { blocked, jsonDigest } from './liveCommon.mjs';
import { validateApuDeployment, captureApuAllocation, apuAllocationBytes } from './liveApuDeployment.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => jsonDigest(a) === jsonDigest(b);

export function createApuCases({ run, profile, spec, prepare, tool, read, processes, sourceAfter, write, signal,
    processProvider, persist, functional, timings = {} }) {
    let scope; let lastProcess = null;
    const status = (args, abort, options) => tool('local_llm_status', args, abort, false, options);
    const observeIdle = async (abort, options) => {
        const state = await status({}, abort, options); const rows = await processes(abort);
        check(state.phase === 'idle' && rows.length === 0, 'APU case requires observed idle with no owned runner');
        return { method: 'agent-procfs/v1', phase: state.phase, processes: rows, monotonicMs: performance.now() };
    };
    async function processIdentity(state, abort) {
        const rows = await processes(abort);
        check(rows.length === 1, 'APU current process not observable');
        const proc = rows[0]; const detail = await read('process-group', MEASUREMENT_RUNNER, [String(proc.pid)], abort);
        check(detail.pid === proc.pid && detail.start === proc.start && proc.exe === profile.model.executable.path
            && proc.sha256 === profile.model.executable.sha256 && (!state?.apuObservation || state.apuObservation.pid === proc.pid), 'APU runner identity differs');
        lastProcess = { pid: proc.pid, start: proc.start, pgid: detail.pgid, exe: proc.exe, sha256: proc.sha256 };
        return { process: lastProcess, rows, threads: detail.resolvedThreads };
    }
    async function stop(proof, options, trace = null, cleanup = false) {
        const startedMonotonicMs = performance.now(); const abort = AbortSignal.timeout(APU_STOP_MS);
        const budget = () => { const left = Math.floor(APU_STOP_MS - (performance.now() - startedMonotonicMs)); check(left > 0, 'APU Stop deadline expired'); return left; };
        await tool('local_llm_stop', {}, abort, cleanup, { ...options, label: `${options.label}-stop`, deadlineMs: budget() });
        const settledMonotonicMs = performance.now();
        for (;;) {
            const state = await tool('local_llm_status', trace ? { sinceSeq: trace.nextSeq } : {}, abort, cleanup,
                { ...options, label: `${options.label}-idle`, deadlineMs: budget() });
            if (spec.backend === 'apu' && proof.launch && options.caseId !== 'cleanup') validateApuDeployment(state,
                { profile, requestId: proof.requestId, launch: proof.launch, requireLaunch: true });
            if (trace) trace.append(state);
            const missing = proof.process ? await read('group-absence', MEASUREMENT_GROUP, [JSON.stringify(proof.process)], abort, cleanup, budget()) : null;
            const rows = await processes(abort, cleanup, budget());
            if (state.phase === 'idle' && rows.length === 0 && (!proof.process || missing.groupAbsent === true)) {
                return { tool: 'local_llm_stop', route: 'local-llm', requestId: proof.requestId,
                    deploymentId: proof.launch?.deploymentId || null, startedMonotonicMs, settledMonotonicMs,
                    idleMonotonicMs: performance.now(), settled: true, phase: 'idle', absence: missing };
            }
            await delay(Math.min(timings.pollMs ?? 100, budget()), undefined, { signal: abort });
        }
    }
    async function execute(caseId) {
        const proof = { schema: 1, runId: run.runId, block: run.block, case: caseId, profile: profile.model.profile,
            requestId: apuRequestId(run.runId, caseId), status: 'pending', reason: 'Case has not completed' };
        const options = { caseId, label: caseId.toLowerCase(), deadlineMs: 290000 };
        try {
            check(profile.cases.includes(caseId), 'APU executor case mismatch');
            Object.assign(proof, await prepare());
            scope ||= await createApuHostScope({ run, profile, processProvider, signal, write, persist, timings: timings.apuHost });
            scope.gate?.setCase({ case: caseId, requestId: proof.requestId });
            await scope.host.monitor(async abort => {
                abort = signal ? AbortSignal.any([signal, abort]) : abort;
                proof.before = await observeIdle(abort, options);
                proof.env = await read('env', APU_ENV_FACTS, [JSON.stringify(profile.model.env)], abort);
                if (scope.gate) {
                    scope.gate.setAllowance(0);
                    await scope.gate.check();
                    proof.discovery = await read('discovery', APU_DISCOVERY, [], abort, false, 65000);
                    check(same(proof.discovery.vulkan, profile.model.amd.vulkan)
                        && same(proof.discovery.devices, profile.model.amd.devices), 'AMD in-agent discovery differs from pins');
                    proof.discovery.qualification = false;
                }
                if (caseId === 'LIVE-L12') {
                    proof.status = 'pending'; proof.reason = 'server-generation-observation-unavailable: missing reviewed APU generation binding';
                    proof.sourceRoute = { route: 'local-llm', revision: profile.llm.revision, tool: 'local_llm_test_prompt' };
                    return;
                }
                if (caseId === 'LIVE-L9') {
                    const pinned = profile.model.refusal;
                    if (pinned.outcome === 'not-exercised') {
                        proof.status = 'not-exercised'; proof.reason = 'No catalog configuration is refusable under the pinned C1/C2 values'; proof.derivation = pinned; return;
                    }
                    const pre = (await status({}, abort, options)).apuActivity;
                    const refusal = await tool('local_llm_run', { requestId: proof.requestId, modelId: pinned.selected.modelId,
                        runnerId: pinned.selected.runnerId, params: pinned.selected.params, replace: false }, abort, false,
                    { ...options, model: pinned.selected.modelId, expectedRefusal: true });
                    const post = (await status({}, abort, options)).apuActivity;
                    proof.refusal = { ...refusal, configuration: pinned.selected, pre, post,
                        method: 'controller-acquisition-no-entry/v1', certifiedTransferredBytes: 0 };
                    proof.after = await observeIdle(abort, options);
                } else {
                    await tool('local_llm_run', { requestId: proof.requestId, modelId: profile.llm.models.small.id,
                        runnerId: spec.runner, params: APU_PARAMS, replace: false }, abort, false, options);
                    const end = performance.now() + run.deadlines.modelLoadMs;
                    proof.bufferObservations = [];
                    let trace; let triggered = false;
                    for (;;) {
                        check(performance.now() < end, 'APU load observation deadline expired');
                        abort.throwIfAborted();
                        let state = await status(trace ? { sinceSeq: trace.nextSeq } : {}, abort, options);
                        if (spec.backend === 'apu') validateApuDeployment(state, { profile, requestId: proof.requestId, launch: proof.launch });
                        proof.deployment = state;
                        if (!proof.process && state.apuObservation?.running) {
                            proof.launch = structuredClone(state.apuObservation);
                            Object.assign(proof, await processIdentity(state, abort));
                            if (caseId === 'LIVE-L11') {
                                trace = createApuTrace(proof.launch);
                                const first = await status({ sinceSeq: proof.launch.logSeqStart }, abort, options); trace.append(first); state = first;
                                validateApuDeployment(state, { profile, requestId: proof.requestId, launch: proof.launch, requireLaunch: true });
                                proof.deployment = state;
                            }
                        } else if (trace) trace.append(state);
                        if (scope.gate) {
                            if (state.apuObservation) {
                                const observed = captureApuAllocation(state, { caseId, requestId: proof.requestId });
                                let evidence = proof.bufferObservations.find(value => same({ ...value, nextSeq: 0 }, { ...observed, nextSeq: 0 }));
                                if (!evidence) {
                                    check(proof.bufferObservations.length < 1800, 'APU buffer observation bound exceeded');
                                    evidence = observed; proof.bufferObservations.push(evidence);
                                }
                                const bytes = apuAllocationBytes(evidence, { runId: run.runId, profile, caseId, requestId: proof.requestId });
                                scope.gate.setAllowance(bytes, evidence);
                            } else scope.gate.setAllowance(0);
                        }
                        if (caseId === 'LIVE-L10' && state.phase === 'error') {
                            proof.launch = structuredClone(state.apuObservation);
                            if (!proof.process) { proof.status = 'pending'; proof.reason = 'Current runner process exited before independent identity observation'; return; }
                            proof.absence = await read('guard-absence', MEASUREMENT_GROUP, [JSON.stringify(proof.process)], abort);
                            proof.terminal = { phase: state.phase, deploymentId: state.deployment?.id,
                                floorCause: state.apuObservation?.guardStop?.kind === 'host-memory-floor' };
                            break;
                        }
                        if (caseId === 'LIVE-L11') {
                            const snapshot = trace?.snapshot();
                            const marker = snapshot?.events.find(event => event.kind === 'load-begin' && event.seq > proof.launch.launchSeq);
                            if (snapshot?.problem) { proof.status = 'pending'; proof.reason = `Load observation unavailable: ${snapshot.problem}`; break; }
                            if (marker && state.phase === 'starting') {
                                proof.loadObservedPhase = 'starting'; proof.loadObservedSeq = marker.seq; proof.stopAfterSeq = trace.nextSeq; triggered = true; break;
                            }
                            if (state.phase === 'ready') { proof.status = 'pending'; proof.reason = 'Tensor marker was not observed while starting'; break; }
                        } else if (['LIVE-L13', 'LIVE-L8'].includes(caseId) && state.phase === 'ready') {
                            const facts = await processIdentity(state, abort); proof.processes = facts.rows; proof.process = facts.process;
                            if (scope.gate) await scope.gate.check();
                            proof.answer = await tool('local_llm_test_prompt', { prompt: 'Name one colour.', maxTokens: 64 }, abort, false, options);
                            if (scope.gate) await scope.gate.check();
                            functional(proof);
                            if (caseId === 'LIVE-L8') proof.comparison = { prompt: 'Name one colour.', maxTokens: 64, build: 'b11159', threads: facts.threads, cache: 'fresh-owned-workspace' };
                            break;
                        }
                        if (['error', 'paused'].includes(state.phase)) throw new Error('APU deployment failed before the required observation');
                        await delay(timings.pollMs ?? 100, undefined, { signal: abort });
                    }
                    if (caseId === 'LIVE-L11') {
                        proof.stop = await stop(proof, options, trace); proof.trace = trace?.snapshot() || null;
                        if (triggered && !proof.trace.problem) {
                            const raced = proof.trace.events.some(event => event.kind === 'phase-ready');
                            proof.status = raced ? 'not-exercised' : 'pass'; proof.reason = raced ? 'Observed ready before idle; load cancellation window missed' : '';
                        }
                        return;
                    }
                    if (caseId !== 'LIVE-L10') {
                        proof.stop = await stop(proof, options); proof.after = await observeIdle(abort, options);
                    }
                }
                proof.status = 'pass'; delete proof.reason;
            });
            proof.hostGuard = scope.host.snapshot();
            if (scope.gate) proof.gpuGate = scope.gate.snapshot();
            proof.sourceAfter = await sourceAfter(signal);
            validateApuReceipt(proof, { runId: run.runId, block: run.block, profile, caseId, functional });
            return proof;
        } catch (error) {
            proof.status = error.code === 'LIVE_PREREQUISITE_MISSING' ? 'blocked' : 'fail';
            proof.reason = String(error.message).slice(0, 400);
            throw Object.assign(error, { evidence: proof });
        } finally { write(`model-${caseId.toLowerCase()}`, proof); }
    }
    return { execute, async beforeCleanup() {
        const proof = { requestId: 'cleanup', process: lastProcess, launch: null };
        const settled = await stop(proof, { label: 'apu-cleanup', caseId: 'cleanup' }, null, true);
        write('model-stop-proof', { runId: run.runId, ...settled });
    }, async afterCleanup() { if (scope) await scope.final(); }, get scope() { return scope; } };
}
