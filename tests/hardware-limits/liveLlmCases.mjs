// The apparatus-local-llm executors (LIVE-L1, LIVE-L2) and the apparatus-vllm
// executor (LIVE-L3; plan sections 12, 12.2, 15.4 to 15.6 and 18.10) over the
// GPU case kit of liveGpuCases.mjs: the same idle gate (with amendment A5), the
// same administrator channel, Apply, daemon and ownership proofs, and the same
// cleanup. Budgets are set only through the administrator path (the hardware
// limits store and Apply); the model is driven only through the local-llm
// agent's own MCP tools, reached through the Router with the local operator
// session. Nothing here changes the compute mode, signals a process it does
// not own, or touches a resource that is not recorded.
//
// Every case writes its evidence BEFORE asserting. A busy GPU, a missing
// prerequisite (an install that cannot work here, no vLLM lock entry, too
// little disk or RAM), an unavailable administrator channel and the refusal that
// is correct before a reviewed qualification entry exists are BLOCKED, never PASS.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpuMaxMatches } from '../../cli/sandbox/hardwareLimits/cpuQuota.mjs';
import { resolveMemoryPercent } from '../../cli/sandbox/hardwareLimits/resolve.mjs';
import { blocked, boundedTail, checkedJson, commandTails } from './liveCommon.mjs';
import { LEAF_OBSERVATION } from './liveCaseCommands.mjs';
import { agentLeaf, createHostProc } from './liveGpuHost.mjs';
import { createGpuCases } from './liveGpuCases.mjs';
import { MIB, shareMemoryMiB } from './liveGpuCommands.mjs';
import { INSTALL_SAMPLES_HEAD, INSTALL_SAMPLES_TAIL, LLM_SOURCE_DIRECTORY } from './liveLlmNames.mjs';
import {
    GIB, INFERENCE_CADENCE, INSUFFICIENT_RAM, L1_MIN_RAM_BYTES, L1_PROMPT, LLM_BUDGET, LLM_FIXTURE, LLM_IMAGE_DIGESTS, LLM_LEAF_SAMPLE, LLM_MODELS, LLM_REF, LLM_RUNNER_PROCESSES, LLM_TOOL_CALL, VLLM_SHARE,
    INFERENCE_MIN_IN_FLIGHT, analyzeInference, classifyObservation, insufficientMemoryPercent, llmToolWords, parseLeafSample, runnerEnvironmentProblems, sourceUnavailable, stageTwoFreeThreshold, summarizeGpuCheck, vllmToolWords,
} from './liveLlmCommands.mjs';

const needs = (condition, message) => { if (!condition) throw blocked(message); };
const expects = (condition, message) => { if (!condition) throw new Error(message); };
const TUPLE_FIELDS = Object.freeze(['runnerLockDigest', 'driverVersion', 'gpuPciDeviceId', 'computeCapability', 'deviceTotalBytes']);
const ACTIVE = Object.freeze(['downloading', 'copying', 'verifying', 'starting', 'loading', 'ready', 'stopping']);

export const LLM_DEFAULT_TIMINGS = Object.freeze({
    pollMs: 3000, toolMs: 90000, promptMs: 290000, stopMs: 90000, readyMs: 180000, installPollMs: 15000, calibrateMs: 600000, prerequisiteMs: 120000,
    inferenceSampleMs: INFERENCE_CADENCE.sampleMs, inferenceGpuMs: INFERENCE_CADENCE.gpuMs,
    // The sustained load of L1 (LLM1): requests follow each other until the in-flight minimums are met, but no new request starts
    // after sustainedMs (about a minute) or after sustainedRequests requests. A model too fast to be measured inside that bound is BLOCKED.
    sustainedMs: 75000, sustainedRequests: 40,
});


// The proof that the owned model data is gone: the workspace, its `.data` and the run's quarantine no longer exist. It is
// written by EVERY action that certifies a cleanup of an LLM block (the live run's own cleanup, and a standalone or resumed
// `cleanup`), and carries the run, the action and the time, so the stager can refuse a proof another action left behind.
export function llmCleanupProof({ workspace, runId, action, write, now = Date.now }) {
    const gone = target => { try { fs.lstatSync(target); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
    const remaining = [workspace, path.join(workspace, '.data'), path.join(path.dirname(workspace), `.hwl-removing-${runId}`)].filter(target => !gone(target));
    write('llm-cleanup-proof', { schema: 1, runId, action, at: now(), remaining });
    if (remaining.length) throw Object.assign(new Error(`The owned model data remains after cleanup: ${remaining.join(', ')}`), { code: 'LIVE_LLM_DATA_REMAINS' });
    return remaining;
}

export function createLlmCases(ctx) {
    const { profile, run, command, engine, core, nested, safeArtifact } = ctx;
    const host = ctx.host || createHostProc();
    const kit = createGpuCases({ ...ctx, host, fixture: LLM_FIXTURE });
    const k = kit.internals;
    const { admin, runCase, applyShares, agentEntry, observe, sleep } = k;
    const gpu = profile.gpu;
    const llm = profile.llm;
    const workspace = profile.workspace.path;
    const timings = { ...LLM_DEFAULT_TIMINGS, ...k.timings };
    // The install's hard cap and its stall window (no download progress): see VLLM_DEADLINES in liveManifest.mjs.
    const installMs = Number.isInteger(run.deadlines?.installMs) ? run.deadlines.installMs : 12 * 60 * 1000;
    const installStallMs = Number.isInteger(run.deadlines?.installStallMs) ? run.deadlines.installStallMs : 10 * 60 * 1000;
    const modelLoadMs = Number.isInteger(run.deadlines?.modelLoadMs) ? run.deadlines.modelLoadMs : 20 * 60 * 1000;
    let captureCounter = 0;
    const ref = LLM_REF;

    // ---------------------------------------------------------------------
    // The local-llm agent's MCP tools, through the Router, in the Box.
    async function tool(kind, name, args = {}, { view = {}, deadlineMs = timings.toolMs, mutating = false, abort = null } = {}) {
        const words = llmToolWords(name, args, view);
        const result = await command(`llm-${kind}`, profile.engine.path, [...core, 'node', '-e', LLM_TOOL_CALL, ...words],
            { deadlineMs, journal: mutating, tolerate: true, capture: mutating ? `llm-${kind}-${++captureCounter}` : null, abort });
        if (result.cancelled) throw new Error('The local-llm tool call was cancelled');
        let reply = null;
        try { reply = JSON.parse(result.stdout); } catch { reply = null; }
        if (!reply || typeof reply.ok !== 'boolean') throw blocked(`The local-llm tool ${name} gave no document (exit ${result.status}): ${boundedTail(result.stderr || result.stdout, 300).text}`);
        return reply;
    }
    // A tool call that must succeed. The product route not answering is a prerequisite.
    async function toolOk(kind, name, args, options) {
        const reply = await tool(kind, name, args, options);
        if (reply.ok) return reply.result;
        const { code, message } = reply.error || {};
        if (['agent_not_found', 'transport', 'too_large'].includes(code)) throw blocked(`The local-llm agent did not answer through the Router (${code}): ${String(message).slice(0, 300)}`);
        throw Object.assign(new Error(`${name} failed (${code}): ${String(message).slice(0, 400)}`), { toolError: reply.error });
    }
    // The agent restarts when Apply replaces it: wait until its tools answer again.
    async function agentAnswering(evidence, label) {
        const deadline = Date.now() + timings.readyMs;
        let last = null;
        for (;;) {
            try { await toolOk(`ready-${label}`, 'local_llm_status', {}); evidence.step(`answering:${label}`); return; }
            catch (error) { last = error; if (error.code !== 'LIVE_PREREQUISITE_MISSING') throw error; }
            if (Date.now() > deadline) throw blocked(`The local-llm agent did not answer within ${timings.readyMs} ms of being replaced: ${String(last?.message).slice(0, 200)}`);
            await sleep(timings.pollMs);
        }
    }
    // Poll the deployment until `done` says so; a failed or paused deployment ends the wait.
    async function waitDeployment(evidence, label, { done, signal, deadlineMs, timeout = 'fail' }) {
        const started = Date.now(); let samples = 0; let last = null;
        for (;;) {
            if (signal?.aborted) throw Object.assign(new Error('The wait was aborted'), { aborted: true });
            last = await toolOk(`status-${label}`, 'local_llm_status', {});
            if (samples % 10 === 0) evidence.step(`status:${label}`, { phase: last.phase, download: last.deployment?.download ?? null, error: last.deployment?.error ?? null });
            samples += 1;
            if (done(last)) return last;
            if (last.deployment?.phase === 'error') {
                // An unreachable model source is a missing prerequisite of the host (BLOCKED); anything else is a failure.
                if (sourceUnavailable(last.deployment.error)) throw blocked(`The model source is unavailable from this host: ${String(last.deployment.error).slice(0, 300)}`);
                throw Object.assign(new Error(`The deployment failed: ${String(last.deployment.error).slice(0, 300)}`), { status: last });
            }
            if (last.deployment?.phase === 'paused') throw blocked(`The deployment paused: ${String(last.deployment.pausedReason || last.deployment.error).slice(0, 300)}`);
            if (Date.now() - started > deadlineMs) {
                const message = `${label} did not finish within ${deadlineMs} ms (phase ${last.phase})`;
                throw timeout === 'blocked' ? blocked(message) : new Error(message);
            }
            await sleep(timings.pollMs);
        }
    }
    const requestId = tag => `hwl${run.runId.slice(0, 16)}${tag}${Date.now().toString(36)}`.slice(0, 64);

    // The processes of the agent's runner, by what they are, inside its own PID namespace.
    async function runnerProcesses(agent, matcher) {
        const found = checkedJson(await observe('llm-runner-processes', [...nested, 'container', 'exec', agent.id, 'node', '-e', LLM_RUNNER_PROCESSES, matcher], { deadlineMs: 30000 }));
        expects(Array.isArray(found.processes), 'The runner process scan gave no list');
        return found.processes;
    }
    // The agent leaf's cgroup interface files, read by the Box user (read-only).
    async function leafValues(agent) {
        const prepared = k.getPrepared();
        const hostLeaf = agentLeaf(host, prepared.prefix, agent.id);
        needs(hostLeaf !== null, 'The cgroup leaf of the local-llm agent cannot be proved beneath the exact Box');
        const inBox = `/sys/fs/cgroup${hostLeaf.slice(prepared.prefix.length)}`;
        return { hostLeaf, inBox, values: checkedJson(await observe('llm-leaf', [...core, 'node', '-e', LEAF_OBSERVATION, inBox], { deadlineMs: 20000 })) };
    }
    const trim = value => String(value ?? '').trim();
    // The agent leaf's canonical path as the Box sees it, and on the host, proved beneath the exact Box.
    function leafPaths(agent) {
        const prepared = k.getPrepared();
        const hostLeaf = agentLeaf(host, prepared.prefix, agent.id);
        needs(hostLeaf !== null, 'The cgroup leaf of the local-llm agent cannot be proved beneath the exact Box');
        return { hostLeaf, inBox: `/sys/fs/cgroup${hostLeaf.slice(prepared.prefix.length)}` };
    }

    function requireShareable(state, evidence) {
        evidence.put('administratorState', { gate: state.gate, gpu: state.gpu, envelope: state.envelope });
        needs(state.gate?.state === 'on', 'The Box hardware-limits gate is not on');
        needs(state.gpu?.eligible === true && state.gpu.mode === 'mps-shared', `MPS sharing is not eligible in this Box: ${String(state.gpu?.reason || 'no reason').slice(0, 300)}`);
        needs(state.gpu.deviceUuid === gpu.uuid && state.gpu.memoryModel === 'dedicated' && state.gpu.driverVersion === gpu.driverVersion && state.gpu.deviceMemoryBytes === gpu.memoryMiB * MIB,
            'The Box reports another device, memory model, driver version or memory than the pinned ones');
        needs(Number.isSafeInteger(state.envelope?.memoryBytes) && state.envelope.memoryBytes > 0 && state.envelope.cpus >= 1, 'The Box memory and CPU envelope is not readable, so the budgets cannot be resolved');
    }
    // The share clients' exact facts after an Apply, and the daemon registered with the gate.
    async function appliedAgent(evidence, { limits, state, label }) {
        const { gate } = k.getPrepared();
        const entry = agentEntry(state, ref);
        expects(entry?.containers?.length === 1, `${label}: ${ref} does not have exactly one running instance after Apply`);
        const container = entry.containers[0];
        expects(container.limitsState === 'applied' && container.mpsGeneration === state.gpu.mpsGeneration, `${label}: the instance is not applied at the daemon generation`);
        const identity = await daemonIdentity();
        needs(identity.daemon, `${label}: no owned MPS daemon is observable after Apply`);
        gate.registerDaemon(identity.daemon.host.hostPid);
        const agent = await agentNow();
        k.registerOwned(agent);
        evidence.put(`agent:${label}`, { id: agent.id, created: agent.created, user: agent.user, imageId: agent.image, imageName: agent.imageName, labels: agent.labels, env: (agent.env || []).filter(value => /^CUDA_/.test(value)), generation: identity.daemon.generation });
        k.assertClientShare(agent, limits.gpu, state, identity.daemon, { totalMiB: gpu.memoryMiB, label: `${label} agent` });
        // The agent's host UID is the daemon's: one owner for the whole cohort.
        const leaf = agentLeaf(host, k.getPrepared().prefix, agent.id);
        const processes = k.hostProcessesOf(leaf);
        expects(processes.length > 0 && processes.every(value => Object.values(value.uid).every(uid => uid === identity.daemon.host.uid.effective)), `${label}: an agent process does not run as the daemon's host UID`);
        return { agent, identity };
    }
    const daemonIdentity = () => k.daemonIdentity();
    const agentNow = () => k.agentNow('llm');

    // The cgroup values and the agent's own view of its budget, against what Apply saved.
    async function verifyBudget(evidence, { agent, limits, envelope, label }) {
        const memoryBytes = resolveMemoryPercent(limits.memoryPercent, envelope.memoryBytes);
        const { values, inBox } = await leafValues(agent);
        evidence.put(`cgroup:${label}`, { leaf: inBox, 'memory.max': trim(values['memory.max']), 'memory.swap.max': trim(values['memory.swap.max']), 'cpu.max': trim(values['cpu.max']), 'pids.max': trim(values['pids.max']), expectedMemoryBytes: memoryBytes, expectedCpus: limits.cpus });
        expects(trim(values['memory.max']) === String(memoryBytes), `${label}: memory.max is ${trim(values['memory.max'])}, not the saved ${limits.memoryPercent}% of the envelope (${memoryBytes})`);
        // The swap CAP, not only the swap in use: an unlimited, nonzero or missing allowance is not the hardware limit.
        expects(trim(values['memory.swap.max']) === '0', `${label}: memory.swap.max is ${trim(values['memory.swap.max']) || '(missing)'}, not 0`);
        expects(cpuMaxMatches(values['cpu.max'], String(limits.cpus)), `${label}: cpu.max is ${trim(values['cpu.max'])}, not ${limits.cpus} CPUs`);
        return { memoryBytes, values };
    }
    // What the agent itself reports: the overview budget is read from its own cgroup and environment.
    async function agentView(evidence, label, { modelId = LLM_MODELS.small, runnerId = 'llama.cpp' } = {}) {
        const overview = await toolOk(`overview-${label}`, 'local_llm_overview', { preview: { modelId, runnerId, params: {} } }, { view: { model: modelId } });
        evidence.put(`overview:${label}`, { profile: overview.profile, limits: overview.limits, gpu: overview.hardware?.gpu, memory: overview.hardware?.memory, preview: overview.preview, model: overview.model?.runners?.[runnerId], deployment: overview.deployment });
        return overview;
    }
    function expectBudget(overview, { memoryBytes, cpus, gpuShare, label }) {
        const budget = overview.limits?.budget;
        expects(budget && budget.source === 'ploinky', `${label}: the agent reports no Ploinky budget`);
        expects(budget.memoryBytes === memoryBytes, `${label}: the agent's budget memory is ${budget.memoryBytes}, not ${memoryBytes}`);
        expects(Number.isFinite(budget.cpus) && Math.abs(budget.cpus - cpus) <= 0.0001, `${label}: the agent's budget CPUs are ${budget.cpus}, not ${cpus}`);
        expects(budget.gpuShare && budget.gpuShare.smPercent === gpuShare.smPercent && budget.gpuShare.vramBytes === shareMemoryMiB(gpuShare.vramPercent, gpu.memoryMiB) * MIB && budget.gpuShare.assurance === 'best-effort',
            `${label}: the agent's GPU share is ${JSON.stringify(budget.gpuShare)}, not ${gpuShare.smPercent}% / ${gpuShare.vramPercent}%`);
    }
    function pinned(model, pins) {
        const gguf = model?.sources?.gguf;
        expects(gguf && gguf.sha256 === pins.sha256 && gguf.size === pins.size && gguf.commit === pins.commit && gguf.repo === pins.repo && gguf.file === pins.file,
            'The agent\'s catalog entry for the small model differs from the pins in the approved manifest');
    }
    async function imageDigests(agent) {
        return checkedJson(await observe('llm-image-digests', [...nested, 'container', 'exec', agent.id, 'node', '-e', LLM_IMAGE_DIGESTS], { deadlineMs: 120000 }));
    }
    // A runner's environment (liveLlmCommands.runnerEnvironmentProblems): exactly the saved share's three MPS variables, the
    // product's own CUDA cache variable and nothing secret that the product does not itself emit for this runner.
    function expectRunnerEnvironment(processes, share, label, { runner }) {
        expects(processes.length >= 1, `${label}: no runner process was found in the agent`);
        const memory = `0=${shareMemoryMiB(share.vramPercent, gpu.memoryMiB)}M`;
        for (const process of processes) {
            const problems = runnerEnvironmentProblems(process, { share: { smPercent: share.smPercent, memory }, runnerId: runner, label });
            expects(problems.length === 0, problems.join('; '));
        }
    }

    // =====================================================================
    // The runner's host PIDs, by verified identity: each in-agent runner process (its PID in the agent's
    // namespace and its start time) must map to exactly one host process of the agent's own leaf whose
    // innermost namespace PID and start identity are the same.
    function runnerHostIdentities(agent, runnerProcessList) {
        const leaf = leafPaths(agent).hostLeaf;
        const candidates = k.hostProcessesOf(leaf);
        return runnerProcessList.map(inner => {
            const matches = candidates.filter(observed => observed.nspid.length === 3 && observed.nspid.at(-1) === inner.pid && String(observed.startIdentity) === String(inner.start));
            needs(matches.length === 1, `The runner process ${inner.pid} cannot be mapped to exactly one host process of the agent's cgroup (${matches.length})`);
            return { hostPid: matches[0].hostPid, bootId: matches[0].bootId, startIdentity: matches[0].startIdentity, innerPid: inner.pid };
        });
    }

    // The text request, with the budget measured WHILE it generates. Sampling starts before the request is sent
    // and ends after the response completed: cgroup samples (CPU accounting, memory counters) at a bounded
    // interval, and the GPU at the gate's own cadence (every sample is also the idle gate: a foreign process
    // appearing mid-inference aborts the request). The evidence is written first; the analysis decides after.
    async function measuredInference(evidence, { agent, gate, limits, memoryCapBytes, runnerIdentities, label }) {
        const { inBox } = leafPaths(agent);
        const shareMiB = shareMemoryMiB(limits.gpu.vramPercent, gpu.memoryMiB);
        const hostPids = runnerIdentities.map(entry => entry.hostPid);
        const cgroup = []; const gpuSamples = []; let identityLost = null;
        // Every observation carries the real time its read or check started and the time it returned. A sample taken while the
        // inference ran is labelled `in-flight` only by `relabel` below, from those times and the request windows.
        const sampleLeaf = async name => {
            const startedAt = Date.now();
            const raw = checkedJson(await observe('llm-leaf-sample', [...core, 'node', '-e', LLM_LEAF_SAMPLE, inBox], { deadlineMs: 20000 }));
            cgroup.push({ label: name, startedAt, endedAt: Date.now(), ...parseLeafSample(raw) });
        };
        const sampleGpu = (name, checked, timing = null) => {
            gpuSamples.push({ ...summarizeGpuCheck(name, checked, hostPids), startedAt: timing?.startedAt ?? Date.now(), endedAt: timing?.endedAt ?? Date.now() });
            for (const entry of runnerIdentities) {
                const now = host.observe(entry.hostPid);
                if (!now || now.startIdentity !== entry.startIdentity || now.bootId !== entry.bootId) identityLost = identityLost ?? `The runner host process ${entry.hostPid} no longer has its recorded identity (${name})`;
            }
        };
        let answer = null; let failure = null;
        const startedAt = Date.now();
        // Only a sample taken while a request is outstanding is in flight; the gaps between requests are labelled and never count.
        // `windows` holds every request's [sent, settled) interval in real time. A pending sample is in flight only when its whole
        // [startedAt, endedAt] lies inside ONE request's window; one that overlaps a window without lying inside it is `late` (kept as
        // evidence, never counted); one outside every window is `between-requests`. A request that starts later never vouches for it.
        const windows = [];
        const relabel = () => {
            for (const sample of [...cgroup, ...gpuSamples]) {
                if (!['pending', 'in-flight', 'late', 'between-requests'].includes(sample.label)) continue;
                sample.label = classifyObservation(sample, windows);
            }
        };
        const load = { boundMs: timings.sustainedMs, maxRequests: timings.sustainedRequests, requests: 0, completionTokens: 0, invalidResponses: 0, stoppedBy: null };
        const inFlight = list => list.filter(sample => sample.label === 'in-flight').length;
        try {
            // Before the request is sent: the first CPU/memory sample and the first GPU row.
            await sampleLeaf('before-send');
            sampleGpu('before-send', await gate.check(`${label}-inference-start`));
            answer = await gate.monitor(async abort => {
                // One request, sampled while it is outstanding. Only the first is journaled; it is the evidence response.
                const oneRequest = async first => {
                    const own = new AbortController();
                    const signal = AbortSignal.any([abort, own.signal]);
                    let done = false;
                    const window = { sent: Date.now(), settled: null }; windows.push(window);
                    const request = toolOk(first ? `prompt-${label.toLowerCase()}` : `prompt-${label.toLowerCase()}-more`, 'local_llm_test_prompt', { ...L1_PROMPT }, { deadlineMs: timings.promptMs, mutating: first, abort: signal }).finally(() => { done = true; window.settled = Date.now(); });
                    const settled = request.then(() => null, () => null);
                    try {
                        while (!done) {
                            await Promise.race([settled, sleep(timings.inferenceSampleMs)]);
                            if (done) break;
                            await sampleLeaf('pending');
                        }
                    } catch (error) { own.abort(); await settled; throw error; }
                    return request;
                };
                // Sustained load: back-to-back requests until both minimums were met by samples taken while a request was
                // outstanding, bounded in time and in count. The first valid response is the evidence; a later invalid one is a breach.
                const sustainedUntil = Date.now() + timings.sustainedMs;
                let kept = null;
                for (;;) {
                    load.requests += 1;
                    const reply = await oneRequest(load.requests === 1);
                    relabel();
                    load.completionTokens += Number.isFinite(Number(reply.completionTokens)) ? Number(reply.completionTokens) : 0;
                    if (kept === null) kept = reply; else if (typeof reply.text !== 'string' || !reply.text.trim()) load.invalidResponses += 1;
                    if (inFlight(cgroup) >= INFERENCE_MIN_IN_FLIGHT.cgroup && inFlight(gpuSamples) >= INFERENCE_MIN_IN_FLIGHT.gpu) { load.stoppedBy = 'minimums-met'; break; }
                    if (Date.now() >= sustainedUntil) { load.stoppedBy = 'time-bound'; break; }
                    if (load.requests >= load.maxRequests) { load.stoppedBy = 'request-bound'; break; }
                }
                return kept;
            }, { every: timings.inferenceGpuMs, onCheck: (checked, timing) => sampleGpu('pending', checked, timing) });
            await sampleLeaf('after-response');
            sampleGpu('after-response', await gate.check(`${label}-inference-end`));
        } catch (error) { failure = error; }
        relabel();
        const analysis = analyzeInference({ cgroup, gpu: gpuSamples, cpus: limits.cpus, memoryCapBytes, shareMiB });
        if (identityLost) analysis.violations.push(identityLost);
        if (load.invalidResponses > 0) analysis.violations.push(`${load.invalidResponses} later response(s) of the sustained load carried no text`);
        const trimSamples = list => (list.length <= 120 ? list : [...list.slice(0, 60), ...list.slice(-60)]);
        evidence.put('inference', {
            runner: runnerIdentities, windowMs: Date.now() - startedAt, load, requestWindows: windows.slice(0, 120), late: { cgroup: cgroup.filter(sample => sample.label === 'late').length, gpu: gpuSamples.filter(sample => sample.label === 'late').length }, ...analysis.summary, violations: analysis.violations, blockers: analysis.blockers,
            cgroupSamples: trimSamples(cgroup), gpuSamples: trimSamples(gpuSamples), failure: failure ? String(failure.message ?? failure).slice(0, 300) : null,
        });
        if (failure) throw failure;
        return { answer, analysis };
    }

    // =====================================================================
    // LIVE-L1: Apply 4 CPU / 25 % RAM / 50 % GPU, launch the small GGUF model with
    // llama.cpp, inspect the runner, get a valid text response.
    async function liveL1() {
        return runCase('LIVE-L1', async evidence => {
            const prepared = await k.prepare();
            const { gate } = prepared;
            evidence.put('gateBaseline', gate.baseline);
            await gate.check('L1-start');
            const before = await admin.state();
            requireShareable(before, evidence);
            const envelope = before.envelope;
            const limits = llm.budget;
            needs(envelope.cpus >= limits.cpus, `The Box envelope offers ${envelope.cpus} CPUs, fewer than the ${limits.cpus} of the budget`);
            const ramBytes = resolveMemoryPercent(limits.memoryPercent, envelope.memoryBytes);
            needs(ramBytes >= L1_MIN_RAM_BYTES, `${limits.memoryPercent}% of the Box's ${envelope.memoryBytes} bytes is ${ramBytes}; the model needs at least ${L1_MIN_RAM_BYTES} under its 1 GiB margin`);
            // Fresh model data and the pinned image: nothing downloaded, no other model in use.
            const baseline = await agentNow();
            k.registerOwned(baseline);
            // Identity is the immutable image ID recorded at the fixture start; the name is the digest reference or that same ID (a recreate by ID).
            const baselineImage = k.pinnedImageIdentity('llm', baseline);
            evidence.put('image', { configured: baseline.imageName, pinned: llm.image, id: baseline.id, imageId: baseline.image, ...baselineImage });
            expects(baselineImage.ok, 'The local-llm agent is not the pinned instance of the pinned immutable image');
            await agentAnswering(evidence, 'l1-before');
            const fresh = await agentView(evidence, 'before');
            pinned(fresh.model, llm.models.small);
            const weights = fresh.model.weights.gguf;
            needs(weights?.download?.state === 'absent', `The model data is not fresh: the small model's weights are ${JSON.stringify(weights?.download)}`);
            expects(fresh.deployment === null || !ACTIVE.includes(fresh.deployment.phase), 'A model is already running in the fresh workspace');

            // The budgets, through the administrator path.
            const applied = await applyShares('l1', { [ref]: limits }, [ref], evidence);
            const { agent, identity } = await appliedAgent(evidence, { limits, state: applied.state, label: 'L1' });
            evidence.put('daemon', { generation: identity.daemon.generation, pid: identity.daemon.host.hostPid, uid: identity.daemon.host.uid });
            const cap = await verifyBudget(evidence, { agent, limits, envelope, label: 'L1' });
            await agentAnswering(evidence, 'l1-after');
            const view = await agentView(evidence, 'after-apply');
            expectBudget(view, { memoryBytes: cap.memoryBytes, cpus: limits.cpus, gpuShare: limits.gpu, label: 'L1' });
            expects(view.preview?.admission?.status === 'ok', `Public admission refuses the small model under the budget: ${view.preview?.admission?.status} ${view.preview?.admission?.reason}`);

            // Launch with llama.cpp, watched by the gate until it is ready.
            await gate.check('L1-before-run', { minFreeMiB: shareMemoryMiB(limits.gpu.vramPercent, gpu.memoryMiB) + 256 });
            const accepted = await toolOk('run-l1', 'local_llm_run', { requestId: requestId('l1'), modelId: LLM_MODELS.small, runnerId: 'llama.cpp', params: {}, replace: false }, { mutating: true });
            evidence.step('run-accepted', { accepted: accepted?.accepted ?? null, deployment: accepted?.deployment?.phase ?? null });
            const ready = await gate.monitor(abort => waitDeployment(evidence, 'l1-ready', { done: status => status.phase === 'ready', signal: abort, deadlineMs: modelLoadMs, timeout: 'blocked' }));
            const deployment = ready.deployment;
            evidence.put('deployment', deployment);
            expects(deployment.modelId === LLM_MODELS.small && deployment.runnerId === 'llama.cpp', 'The deployment is not the requested model on llama.cpp');

            // The runner: environment, user, and the generation it runs under.
            const processes = await runnerProcesses(agent, 'llama-server');
            evidence.put('runner', processes.map(value => ({ pid: value.pid, exe: value.exe, uid: value.uid, start: value.start, envNames: value.envNames, cuda: value.cuda })));
            expectRunnerEnvironment(processes, limits.gpu, 'L1', { runner: 'llama.cpp' });
            const stillThere = await agentNow();
            expects(stillThere.id === agent.id && stillThere.startedAt === agent.startedAt, 'The agent was restarted while the model ran');
            const generation = (await admin.state()).gpu.mpsGeneration;
            expects(generation === applied.state.gpu.mpsGeneration && stillThere.labels['ploinky.mpsgeneration'] === generation, 'The agent does not run under the daemon generation Apply created');
            const leaf = agentLeaf(host, prepared.prefix, agent.id);
            const hostRunner = k.hostProcessesOf(leaf);
            expects(hostRunner.length > 0 && hostRunner.every(value => Object.values(value.uid).every(uid => uid === identity.daemon.host.uid.effective)), 'A process of the agent runs as another host UID than the daemon');

            // A valid text response (the Playground's own tool, see PLAYGROUND_DECISION), measured while it generates.
            const runnerIdentities = runnerHostIdentities(agent, processes);
            await gate.check('L1-before-prompt');
            const { answer, analysis } = await measuredInference(evidence, { agent, gate, limits, memoryCapBytes: cap.memoryBytes, runnerIdentities, label: 'L1' });
            evidence.put('response', { text: String(answer.text).slice(0, 400), finishReason: answer.finishReason, modelId: answer.modelId, runnerId: answer.runnerId, completionTokens: answer.completionTokens, via: answer.via });
            expects(typeof answer.text === 'string' && answer.text.trim().length > 0 && answer.modelId === LLM_MODELS.small && answer.runnerId === 'llama.cpp', 'The model returned no text');
            // The measurements decide only now that the evidence is written: a measurement that could not be made is BLOCKED, a breach fails.
            expects(analysis.violations.length === 0, `The budget was not held while the model generated: ${analysis.violations.join('; ')}`);
            needs(analysis.blockers.length === 0, `The inference could not be measured: ${analysis.blockers.join('; ')}`);

            // The digests of what ran.
            const image = await imageDigests(agent);
            const artifact = deployment.artifact;
            evidence.put('digests', {
                image: llm.image, imageFiles: image.files, sourceContract: image.contract,
                model: { id: LLM_MODELS.small, pinned: llm.models.small, controller: artifact, verified: artifact?.sha256 === llm.models.small.sha256 && artifact?.size === llm.models.small.size && artifact?.commit === llm.models.small.commit },
                runner: { id: 'llama.cpp', executable: '/opt/llama.cpp/llama-server', sha256: image.files['/opt/llama.cpp/llama-server']?.sha256 ?? null },
            });
            expects(artifact?.sha256 === llm.models.small.sha256 && artifact?.size === llm.models.small.size && artifact?.commit === llm.models.small.commit, 'The deployed artifact is not the pinned model');
            needs(image.files['/opt/llama.cpp/llama-server']?.sha256, 'The image holds no llama-server to record a runner digest for');
            return { playground: llm.playground, responseText: String(answer.text).slice(0, 200) };
        });
    }

    // =====================================================================
    // LIVE-L2: stop the model, save a known-insufficient RAM budget, Apply, resolve the
    // replacement, verify the new cap, and see a new Run refused before any launch.
    async function liveL2() {
        return runCase('LIVE-L2', async evidence => {
            const prepared = await k.prepare();
            const { gate } = prepared;
            await gate.check('L2-start');
            const before = await admin.state();
            requireShareable(before, evidence);
            const envelope = before.envelope;
            const insufficient = insufficientMemoryPercent(envelope.memoryBytes);
            needs(insufficient, `No whole percentage of the Box's ${envelope.memoryBytes} bytes gives a RAM cap between ${INSUFFICIENT_RAM.minCapBytes} and ${INSUFFICIENT_RAM.maxCapBytes} bytes, so a known-insufficient budget cannot be saved`);
            const limits = { cpus: llm.budget.cpus, memoryPercent: insufficient.percent, gpu: llm.budget.gpu };
            needs(envelope.cpus >= limits.cpus, `The Box envelope offers ${envelope.cpus} CPUs, fewer than the ${limits.cpus} of the budget`);
            evidence.put('insufficientBudget', { limits, capBytes: insufficient.capBytes, minCapBytes: INSUFFICIENT_RAM.minCapBytes, maxCapBytes: INSUFFICIENT_RAM.maxCapBytes, ramNeedBytes: 768 * MIB, marginBytes: GIB });
            const old = await agentNow();
            k.registerOwned(old);
            evidence.put('replaced', { id: old.id, created: old.created, startedAt: old.startedAt });

            // 1. Stop the model. The old running model is never what is tested.
            await agentAnswering(evidence, 'l2-before');
            const status = await toolOk('status-l2-start', 'local_llm_status', {});
            evidence.put('statusBeforeStop', { phase: status.phase, deployment: status.deployment });
            if (ACTIVE.includes(status.phase)) {
                await toolOk('stop-l2', 'local_llm_stop', {}, { mutating: true });
                await waitDeployment(evidence, 'l2-stopped', { done: value => !ACTIVE.includes(value.phase), deadlineMs: timings.stopMs });
            }
            const running = await runnerProcesses(old, 'llama-server');
            expects(running.length === 0, 'A runner process remains after the model was stopped');

            // 2. Save the insufficient budget, Apply it, resolve the replacement.
            const applied = await applyShares('l2', { [ref]: limits }, [ref], evidence);
            const { agent } = await appliedAgent(evidence, { limits, state: applied.state, label: 'L2' });
            expects(agent.id !== old.id, 'Apply did not replace the agent: the instance is the one that ran the model');
            evidence.put('replacement', { id: agent.id, created: agent.created, startedAt: agent.startedAt });

            // 3. The new cap, from the cgroup and from the agent itself.
            const cap = await verifyBudget(evidence, { agent, limits, envelope, label: 'L2' });
            expects(cap.memoryBytes === insufficient.capBytes, `The resolved cap ${cap.memoryBytes} is not the planned ${insufficient.capBytes}`);
            await agentAnswering(evidence, 'l2-after');
            const view = await agentView(evidence, 'after-apply');
            expectBudget(view, { memoryBytes: cap.memoryBytes, cpus: limits.cpus, gpuShare: limits.gpu, label: 'L2' });
            expects(view.deployment === null || !ACTIVE.includes(view.deployment.phase), 'The replacement already runs a model');

            // 4. A new Run is refused with the budget reason, before any launch.
            await gate.check('L2-before-run');
            const attempt = await tool('run-l2', 'local_llm_run', { requestId: requestId('l2'), modelId: LLM_MODELS.small, runnerId: 'llama.cpp', params: {}, replace: false }, { mutating: true });
            evidence.put('refusal', { accepted: attempt.ok, error: attempt.ok ? null : attempt.error });
            if (attempt.ok) {
                // The unsafe outcome: stop it so nothing keeps running, then fail.
                try { await toolOk('stop-l2-unsafe', 'local_llm_stop', {}, { mutating: true }); } catch { /* the failure below is the verdict */ }
                throw new Error('A Run was accepted although the saved RAM budget cannot hold the model');
            }
            const refusal = attempt.error;
            expects(/^admission_(?:incompatible|insufficient_now)$/.test(refusal.code), `The refusal is ${refusal.code}, not an admission refusal`);
            expects(/\bRAM\b/.test(String(refusal.message)), `The refusal does not give the RAM budget as its reason: ${String(refusal.message).slice(0, 200)}`);
            if (refusal.details?.admission) expects(['incompatible', 'insufficient-now'].includes(refusal.details.admission.status), 'The refusal carries another admission status');

            // 5. Nothing launched: no deployment, no runner process, no GPU client of the model.
            const after = await toolOk('status-l2-end', 'local_llm_status', {});
            const processes = await runnerProcesses(agent, 'llama-server');
            evidence.put('afterRefusal', { phase: after.phase, deployment: after.deployment, runnerProcesses: processes.length });
            expects(!ACTIVE.includes(after.phase) && (after.deployment === null || !ACTIVE.includes(after.deployment.phase)) && processes.length === 0, 'The refused Run left a deployment or a runner behind');
            return { refusal: { code: refusal.code, message: String(refusal.message).slice(0, 300), capBytes: insufficient.capBytes } };
        });
    }

    // =====================================================================
    // LIVE-L3: vLLM under an MPS share (plan 12.2). Step 0 checks that the install can work
    // here; stage 1 calibrates (no model launch); stage 2 starts the model through the
    // product's public admission, which refuses until a reviewed tuple is in the data.
    // A tool's document counts only when its process ended normally: a timeout, a signal, truncated output, a spawn
    // error, a cancellation or a forced settlement never certifies it, whatever stdout holds. A nonzero exit status is
    // allowed (the tool reports a blocker that way) because that is a normal completion, judged by its document.
    function vllmDocument(result, label, evidence) {
        const abnormal = [result?.timedOut && 'timed out', result?.signal && `killed by ${result.signal}`, result?.truncated && 'output truncated', result?.errorCode && `error ${result.errorCode}`,
            result?.cancelled && 'cancelled', result?.settlementForced && 'forced settlement', !Number.isInteger(result?.status) && 'no exit status'].filter(Boolean);
        if (abnormal.length) {
            // The failed process stays evidence: its flags and bounded, redacted tails.
            const record = { label, abnormal, ...commandTails(result ?? {}, { maxBytes: 4096 }) };
            safeArtifact('llm-l3-process-failure', record);
            evidence?.put('processFailure', { label, abnormal, status: result?.status ?? null, signal: result?.signal ?? null, timedOut: Boolean(result?.timedOut) });
            throw new Error(`${label} did not complete normally (${abnormal.join(', ')}); its output is not accepted`);
        }
        let doc = null;
        try { doc = JSON.parse(result.stdout); } catch { doc = null; }
        if (!doc || typeof doc.ok !== 'boolean') throw blocked(`${label} gave no document (exit ${result.status}): ${boundedTail(result.stderr || result.stdout, 300).text}`);
        // A success document is only trusted from a process that exited successfully. A tool's own documented blocker report
        // (ok:false, its nonzero exit) is still a normally completed report; a nonzero exit that claims success is not evidence.
        if (doc.ok === true && result.status !== 0) {
            const abnormalExit = [`exit ${result.status} with a document claiming success`];
            safeArtifact('llm-l3-process-failure', { label, abnormal: abnormalExit, claimedOk: true, ...commandTails(result, { maxBytes: 4096 }) });
            evidence?.put('processFailure', { label, abnormal: abnormalExit, status: result.status, signal: null, timedOut: false, claimedOk: true });
            throw new Error(`${label} did not complete normally (${abnormalExit.join(', ')}); its output is not accepted`);
        }
        return doc;
    }
    const blockerText = doc => (doc.blockers || []).map(entry => `${entry.code}: ${entry.message}`).join('; ').slice(0, 900);

    async function installVllm(evidence, gate, agent) {
        await gate.check('L3-install');
        const reply = await tool('install-vllm', 'local_llm_runner_install', { runnerId: 'vllm', acceptLicence: false }, { mutating: true });
        evidence.put('installRequest', reply.ok ? { ok: true } : reply.error);
        if (!reply.ok) throw blocked(`The product's runner install refused vLLM (${reply.error.code}): ${String(reply.error.message).slice(0, 300)}`);
        const started = Date.now(); let samples = 0; let last = null;
        // Throughput evidence and the stall check: progress is any change of the phase, the downloaded bytes or the installing state.
        // The evidence keeps the first INSTALL_SAMPLES_HEAD and the newest INSTALL_SAMPLES_TAIL samples, and the first and the last
        // download sample always (the last one is where the downloaded bytes last grew), so the throughput spans the whole download
        // however many polls it took and is not diluted by the build that follows it.
        const head = []; const tail = []; let sampleCount = 0; let firstDownload = null; let lastDownload = null;
        let signature = null; let progressAt = started;
        const recordSample = (sample) => {
            sampleCount += 1;
            if (Number.isFinite(sample.bytes)) { firstDownload ||= sample; if (!lastDownload || sample.bytes > lastDownload.bytes) lastDownload = sample; }
            if (head.length < INSTALL_SAMPLES_HEAD) head.push(sample);
            else { tail.push(sample); if (tail.length > INSTALL_SAMPLES_TAIL) tail.shift(); }
        };
        const putThroughput = (outcome) => {
            const kept = [...new Set([...head, ...(firstDownload ? [firstDownload] : []), ...tail, ...(lastDownload ? [lastDownload] : [])])].sort((a, b) => a.atMs - b.atMs);
            const seconds = firstDownload && lastDownload ? (lastDownload.atMs - firstDownload.atMs) / 1000 : 0;
            evidence.put('installThroughput', { capMs: installMs, stallMs: installStallMs, outcome, elapsedMs: Date.now() - started, bytesPerSecond: seconds > 0 ? Math.round((lastDownload.bytes - firstDownload.bytes) / seconds) : null, sampleCount, samplesDropped: sampleCount - kept.length, samples: kept });
        };
        const sampleInstall = overview => overview.runners.find(entry => entry.id === 'vllm')?.install ?? null;
        // The gate is watched across the whole wait, the pause between two polls included: a foreign process that appears
        // while the install runs aborts the wait at once (a 15 s sleep outside the monitor left it unwatched).
        const pause = (ms, abort) => Promise.race([sleep(ms), new Promise(resolve => { if (abort.aborted) resolve(); else abort.addEventListener('abort', resolve, { once: true }); })]);
        for (;;) {
            let overview;
            let finished = false;
            await gate.monitor(async abort => {
                overview = await toolOk('install-poll', 'local_llm_overview', {}, { view: {}, abort });
                finished = ['installed', 'error', 'paused'].includes(sampleInstall(overview)?.phase) || Date.now() - started > installMs;
                if (!finished) await pause(timings.installPollMs, abort);
            });
            last = sampleInstall(overview);
            const now = Date.now();
            const nextSignature = JSON.stringify([last?.phase ?? null, last?.download?.bytes ?? null, last?.installing ?? null]);
            if (nextSignature !== signature) { signature = nextSignature; progressAt = now; }
            recordSample({ atMs: now - started, phase: last?.phase ?? null, bytes: Number.isFinite(last?.download?.bytes) ? last.download.bytes : null });
            if (samples % 8 === 0 && samples < 400) evidence.step('install', { phase: last?.phase, download: last?.download, installing: last?.installing, version: last?.version });
            samples += 1;
            if (last?.phase === 'installed') { putThroughput('installed'); evidence.put('install', { ...last, elapsedMs: Date.now() - started }); return last; }
            if (last?.phase === 'error') { putThroughput('error'); throw blocked(`The product's vLLM install failed on this host: ${String(last.error).slice(0, 400)}`); }
            if (last?.phase === 'paused') { putThroughput('paused'); throw blocked(`The vLLM install paused: ${String(last.pausedReason || last.error).slice(0, 300)}`); }
            // STALL: no progress for the stall window is BLOCKED well before the cap (the install cannot finish at that rate). It applies
            // only while the product DOWNLOADS. The 'installing' phase (uv venv, then uv pip install of the wheel set, with UV_NO_PROGRESS=1;
            // local-llms deployments.mjs startInstallJob, runnerInstaller.mjs build) exposes no step or byte count and updates nothing until
            // 'installed', so a healthy build there is bounded by the hard cap only.
            if (last?.phase !== 'installing' && now - progressAt > installStallMs) { putThroughput('stalled'); throw blocked(`The vLLM install made no progress for ${installStallMs} ms (phase ${last?.phase}, ${JSON.stringify(last?.download)}); it is BLOCKED, never a pass`); }
            if (Date.now() - started > installMs) { putThroughput('cap'); throw blocked(`The vLLM install did not finish within ${installMs} ms (phase ${last?.phase}, ${JSON.stringify(last?.download)})`); }
        }
    }

    async function liveL3() {
        return runCase('LIVE-L3', async evidence => {
            const l3 = llm.vllm;
            const prepared = await k.prepare();
            const { gate } = prepared;
            evidence.put('stage', l3.stage);
            evidence.put('gateBaseline', gate.baseline);
            await gate.check('L3-start');
            let agent = await agentNow();
            k.registerOwned(agent);
            const startImage = k.pinnedImageIdentity('llm', agent);
            evidence.put('image', { pinned: llm.image, id: agent.id, imageId: agent.image, ...startImage });
            expects(startImage.ok, 'The local-llm agent is not the pinned instance of the pinned immutable image');
            await agentAnswering(evidence, 'l3-start');

            // STEP 0: does the pinned image's lock offer a vLLM install that can work here?
            await gate.check('L3-step0');
            const pre = vllmDocument(await observe('llm-vllm-prerequisites', [...nested, 'container', 'exec', agent.id, 'node', ...vllmToolWords('prerequisites', { pins: l3.pins })], { deadlineMs: timings.prerequisiteMs, tolerate: true }), 'The prerequisite check', evidence);
            evidence.put('prerequisites', pre);
            if (!pre.ok) throw blocked(`LIVE-L3 step 0: vLLM cannot be installed from the pinned image on this host: ${blockerText(pre)}`);
            expects(pre.facts?.lock?.vllm?.runnerLockDigest === l3.pins.runnerLockDigest && pre.facts.driverVersion === gpu.driverVersion, 'The prerequisite report differs from the pinned lock entry or driver');
            // Stage 2 runs a model only for the tuple stage 1 calibrated, on the hardware the live pins name, with the evidence production qualifies.
            if (l3.stage === 'qualified') await bindQualification(evidence, { pre, cal: l3.calibration });

            // The share, through Apply. It comes before the install: the runnable copy lives in the container, which Apply replaces.
            const state0 = await admin.state();
            requireShareable(state0, evidence);
            const limits = { gpu: l3.share };
            const applied = await applyShares('l3', { [ref]: limits }, [ref], evidence);
            const shared = await appliedAgent(evidence, { limits, state: applied.state, label: 'L3' });
            agent = shared.agent;
            await agentAnswering(evidence, 'l3-after-apply');

            // The product's runner install, from the pinned lock.
            await installVllm(evidence, gate, agent);
            const overview = await agentView(evidence, 'installed', { modelId: LLM_MODELS.awq, runnerId: 'vllm' });
            const vllmRunner = overview.runners?.find(entry => entry.id === 'vllm');
            expects(vllmRunner?.installed === true && vllmRunner.version === l3.pins.version, `The overview reports vLLM ${vllmRunner?.version}, not the pinned ${l3.pins.version}`);

            if (l3.stage === 'calibration') return stageOne(evidence, { gate, agent });
            return stageTwo(evidence, { gate, agent, installed: vllmRunner.install });
        });
    }

    // STAGE 1: calibration. No model is launched; the tool runs the bounded owned queries.
    async function stageOne(evidence, { gate, agent }) {
        await gate.check('L3-calibrate');
        const hostNvmlBytes = gate.baseline.memory.totalMiB * MIB;
        const result = await gate.monitor(abort => observe('llm-vllm-calibrate', [...nested, 'container', 'exec', agent.id, 'node', ...vllmToolWords('calibrate', { hostNvmlBytes })], { deadlineMs: timings.calibrateMs, tolerate: true, abort }));
        const doc = vllmDocument(result, 'The calibration', evidence);
        safeArtifact('llm-l3-calibration', doc);
        evidence.put('calibration', doc.evidence ? { ok: doc.ok, blockers: doc.blockers, verdict: doc.evidence.verdict, tuple: doc.evidence.tuple, evidenceDigest: doc.evidence.evidenceDigest, denominator: doc.evidence.denominator, measurements: doc.evidence.measurements, argv: doc.evidence.argv, admission: doc.evidence.admission, sizing: doc.evidence.sizing } : { ok: doc.ok, blockers: doc.blockers });
        if (!doc.ok) throw blocked(`LIVE-L3 stage 1: the calibration could not run: ${blockerText(doc)}`);
        const verdict = doc.evidence.verdict;
        evidence.put('proposedEntry', doc.proposed ?? null);
        if (!verdict.qualifiable) {
            throw blocked(`LIVE-L3 stage 1: the denominator the installed vLLM sees under MPS is ${verdict.denominator}, and the checks ${verdict.failed.join(', ')} failed, so no qualification entry can be proposed; vLLM under MPS stays unavailable until this is corrected and retested`);
        }
        expects(doc.proposed?.entry && doc.proposed.entry.evidenceDigest === doc.evidence.evidenceDigest && doc.proposed.entry.denominator === 'physical-device', 'The calibration proposed no reviewed entry for its own evidence');
        expects(JSON.stringify(Object.keys(doc.proposed.entry).slice(0, 5)) === JSON.stringify(Object.keys(doc.evidence.tuple)), 'The proposed entry does not carry the tuple fields in production\'s order');
        return { stage: 'calibration', evidenceDigest: doc.evidence.evidenceDigest, proposedEntry: doc.proposed.entry, proposedSource: doc.proposed.source, denominator: verdict.denominator };
    }

    // The tuple production derives for this host, from the step 0 facts (the agent's own readGpu and its lock entry's digest:
    // the same inputs vllmMpsTuple reads), and what production's resolver, over the frozen candidate's reviewed data,
    // says about it. Run follows only when both are exactly what stage 1 pinned and what the live pins say.
    const qualify = ctx.qualify || (async tuple => {
        const file = path.join(profile.source.root, LLM_SOURCE_DIRECTORY, 'local-llm', 'src', 'controller', 'vllmMpsQualification.mjs');
        return (await import(pathToFileURL(file).href)).resolveVllmMpsQualification(tuple);
    });
    async function bindQualification(evidence, { pre, cal }) {
        const facts = pre.facts ?? {};
        const actual = { runnerLockDigest: facts.lock?.vllm?.runnerLockDigest, driverVersion: facts.driverVersion, gpuPciDeviceId: facts.gpu?.device?.pciDeviceId, computeCapability: facts.gpu?.device?.computeCapability, deviceTotalBytes: facts.gpu?.totalBytes };
        const differing = TUPLE_FIELDS.filter(field => actual[field] !== cal.tuple[field]);
        evidence.put('qualificationBinding', { pinned: cal.tuple, actual, evidenceDigest: cal.evidenceDigest, differing });
        needs(differing.length === 0, `LIVE-L3 stage 2: the tuple this host reports differs from the stage 1 pin in ${differing.join(', ')} (reported ${JSON.stringify(Object.fromEntries(differing.map(field => [field, actual[field]])))}); the calibration does not describe this host, so calibrate it again`);
        needs(cal.tuple.driverVersion === gpu.driverVersion && cal.tuple.deviceTotalBytes === gpu.memoryMiB * MIB, `LIVE-L3 stage 2: the stage 1 pin (driver ${cal.tuple.driverVersion}, ${cal.tuple.deviceTotalBytes} bytes) differs from the live pins (driver ${gpu.driverVersion}, ${gpu.memoryMiB * MIB} bytes)`);
        let resolved;
        try { resolved = await qualify(actual); } catch (error) { throw blocked(`LIVE-L3 stage 2: production's qualification data cannot be read from the frozen candidate (${String(error?.message || error).slice(0, 200)})`); }
        evidence.put('qualificationResolved', { qualified: resolved?.qualified === true, evidenceDigest: resolved?.evidenceDigest ?? null });
        if (cal.expectQualified) needs(resolved?.qualified === true && resolved.evidenceDigest === cal.evidenceDigest, `LIVE-L3 stage 2: production qualifies this host's tuple ${resolved?.qualified === true ? `with evidence ${resolved.evidenceDigest}` : 'by no entry'}, not with the stage 1 evidence ${cal.evidenceDigest}`);
        else needs(resolved?.qualified !== true, `LIVE-L3 stage 2: production already qualifies this host's tuple (evidence ${resolved?.evidenceDigest}) although the stage 2 pin records no reviewed entry for it`);
    }

    // STAGE 2: normal public admission and a real model. A missing or mismatched tuple must
    // be refused with vllm_mps_unqualified, which is reported (BLOCKED) and is the correct
    // behaviour before the data entry.
    async function stageTwo(evidence, { gate, agent, installed }) {
        const cal = llm.vllm.calibration;
        const preview = await toolOk('preview-l3', 'local_llm_overview', { preview: { modelId: LLM_MODELS.awq, runnerId: 'vllm', params: {} } }, { view: { model: LLM_MODELS.awq } });
        const admission = preview.preview?.admission;
        evidence.put('publicAdmission', admission);
        const unqualified = admission?.reasonCode === 'vllm_mps_unqualified';
        if (unqualified) {
            expects(!cal.expectQualified, 'The candidate holds the reviewed entry for the calibrated tuple, yet production refuses it as vllm_mps_unqualified: the tuple the live host reports differs from the calibrated one');
            // The refusal at Run is the same one, before any launch.
            await gate.check('L3-refusal');
            const attempt = await tool('run-l3-refused', 'local_llm_run', { requestId: requestId('l3'), modelId: LLM_MODELS.awq, runnerId: 'vllm', params: {}, replace: false }, { mutating: true });
            // The refusal is confirmed from sources the tool route does not flatten. The real route turns a tool error into text
            // ("admission_incompatible: <message>", Agent/server/AgentServer.mjs) and drops the refusal's `details`, so the code
            // of the error is only half of it: the reason code comes from the admission preview taken after the attempt (a plain
            // overview document), and "nothing launched" from the deployment status and the runner processes.
            const after = await toolOk('preview-l3-after', 'local_llm_overview', { preview: { modelId: LLM_MODELS.awq, runnerId: 'vllm', params: {} } }, { view: { model: LLM_MODELS.awq } });
            const afterAdmission = after.preview?.admission;
            const status = await toolOk('status-l3-refused', 'local_llm_status', {});
            const processes = await runnerProcesses(agent, 'vllm');
            const detailed = !attempt.ok ? attempt.error.details?.admission?.reasonCode : undefined;
            // The Run's OWN cause is what its refusal says: the details when the route keeps them, otherwise its code and message. The
            // preview taken afterwards describes the host at that later time and never stands in for it (production checks that the
            // GPU's capacity is readable before it checks the qualification, so the two can differ).
            const runCode = attempt.ok ? null : attempt.error.code;
            const refused = !attempt.ok && /^admission_(?:incompatible|insufficient_now)$/.test(runCode)
                && (detailed !== undefined ? detailed === 'vllm_mps_unqualified' : runCode === 'admission_incompatible' && afterAdmission?.reasonCode === 'vllm_mps_unqualified');
            // A flattened admission_insufficient_now is a refusal for its own reason (the host cannot be measured or has no room now).
            const otherCause = !attempt.ok && !refused && runCode === 'admission_insufficient_now' && detailed === undefined;
            const launched = ACTIVE.includes(status.phase) || (status.deployment ? ACTIVE.includes(status.deployment.phase) : false);
            evidence.put('refusalObserved', { refused, error: attempt.ok ? null : attempt.error, runCause: attempt.ok ? null : { code: runCode, reasonCode: detailed ?? null, message: String(attempt.error.message ?? '').slice(0, 300) }, previewReasonCode: afterAdmission?.reasonCode ?? null, detailsReasonCode: detailed ?? null, phase: status.phase, runnerProcesses: processes.length });
            if (attempt.ok) { try { await toolOk('stop-l3-unsafe', 'local_llm_stop', {}, { mutating: true }); } catch { /* the failure below is the verdict */ } }
            if (otherCause && !launched && processes.length === 0) {
                throw blocked(`LIVE-L3 stage 2: the Run was refused as ${runCode} (${String(attempt.error.message).slice(0, 200)}), which is its own cause and not the expected vllm_mps_unqualified refusal; the admission preview taken afterwards (${afterAdmission?.reasonCode ?? 'no reason code'}) does not describe that Run. The model has not run. Run stage 2 again when the host reports its GPU memory.`);
            }
            expects(refused && !launched && processes.length === 0, 'vLLM under MPS was not refused as vllm_mps_unqualified before any launch');
            throw blocked(`LIVE-L3 stage 2: vllm_mps_unqualified was observed before the qualification data entry (${String(admission.reason).slice(0, 200)}); that is the correct behaviour, and the model has not run. Add the reviewed entry from the stage 1 evidence and run stage 2 again.`);
        }
        expects(cal.expectQualified, 'vLLM under MPS was admitted although the candidate holds no matching reviewed qualification entry');
        needs(admission?.status === 'ok', `Public admission does not admit ${LLM_MODELS.awq} at the ${VLLM_SHARE.vramPercent}% share (${admission?.status}: ${String(admission?.reason).slice(0, 300)}); the documented share is insufficient on this host`);

        const threshold = stageTwoFreeThreshold({ estimateGpuBytes: admission?.estimate?.gpuBytes, shareMiB: shareMemoryMiB(llm.vllm.share.vramPercent, gpu.memoryMiB) });
        evidence.put('freeMemoryThreshold', threshold);
        await gate.check('L3-before-run', { minFreeMiB: threshold.minFreeMiB });
        await toolOk('run-l3', 'local_llm_run', { requestId: requestId('l3'), modelId: LLM_MODELS.awq, runnerId: 'vllm', params: {}, replace: false }, { mutating: true });
        const ready = await gate.monitor(abort => waitDeployment(evidence, 'l3-ready', { done: status => status.phase === 'ready', signal: abort, deadlineMs: modelLoadMs, timeout: 'blocked' }));
        evidence.put('deployment', ready.deployment);
        evidence.put('runnerReport', ready.runnerReport);
        const processes = await runnerProcesses(agent, 'vllm');
        evidence.put('runner', processes.map(value => ({ pid: value.pid, uid: value.uid, start: value.start, envNames: value.envNames, cuda: value.cuda })));
        expectRunnerEnvironment(processes, llm.vllm.share, 'L3', { runner: 'vllm' });
        await gate.check('L3-before-prompt');
        const answer = await gate.monitor(abort => toolOk('prompt-l3', 'local_llm_test_prompt', { prompt: 'Name one colour. /no_think', maxTokens: 256 }, { deadlineMs: timings.promptMs, mutating: true, abort }));
        evidence.put('response', { text: String(answer.text).slice(0, 400), reasoningChars: answer.reasoningChars, finishReason: answer.finishReason, modelId: answer.modelId, runnerId: answer.runnerId });
        expects(typeof answer.text === 'string' && answer.text.trim().length > 0 && answer.modelId === LLM_MODELS.awq && answer.runnerId === 'vllm', 'The model returned no text');
        // Bounded share evidence: what the device held while the model ran never went beyond the share.
        const shareMiB = shareMemoryMiB(llm.vllm.share.vramPercent, gpu.memoryMiB);
        const used = gate.history.map(entry => entry.usedMiB).filter(Number.isFinite);
        const peak = Math.max(...used);
        const baselineUsed = gate.baseline.memory.usedMiB;
        evidence.put('shareEvidence', { shareMiB, baselineUsedMiB: baselineUsed, peakUsedMiB: peak, checks: used.length, tolerated: gate.tolerated.map(entry => ({ pid: entry.hostPid, memoryMiB: entry.memoryMiB })) });
        expects(peak - baselineUsed <= shareMiB + 256, `The device held ${peak} MiB (${baselineUsed} before) while the share is ${shareMiB} MiB`);
        const artifact = ready.deployment.artifact;
        evidence.put('digests', {
            image: llm.image, model: { id: LLM_MODELS.awq, pinned: llm.models.awq, controller: artifact ? { repo: artifact.repo, commit: artifact.commit, size: artifact.size, files: artifact.files ?? null } : null },
            runner: { id: 'vllm', version: llm.vllm.pins.version, runnerLockDigest: llm.vllm.pins.runnerLockDigest, install: installed },
            qualification: { evidenceDigest: cal.evidenceDigest, tuple: cal.tuple },
        });
        expects(artifact && artifact.commit === llm.models.awq.commit && artifact.size === llm.models.awq.size, 'The deployed snapshot is not the pinned model');
        return { stage: 'qualified', responseText: String(answer.text).slice(0, 200), evidenceDigest: cal.evidenceDigest };
    }

    // ---------------------------------------------------------------------
    // Cleanup. The model data, the runner caches and the runnable copies live under the
    // workspace (`.data`) and in the Box, so the product cleanup removes them with the
    // workspace and the Box; this inventories them before and proves them gone after.
    const dataRoot = () => path.join(workspace, '.data');
    function inventory(root, limit = 4000) {
        const rows = []; let bytes = 0; let unreadable = 0;
        const walk = (directory, depth) => {
            let names = [];
            try { names = fs.readdirSync(directory).sort(); } catch { unreadable += 1; return; }
            for (const name of names) {
                if (rows.length >= limit) return;
                const target = path.join(directory, name);
                let stat;
                try { stat = fs.lstatSync(target); } catch { unreadable += 1; continue; }
                if (stat.isDirectory() && !stat.isSymbolicLink()) { if (depth < 6) walk(target, depth + 1); } else if (stat.isFile()) { bytes += stat.size; rows.push({ path: path.relative(root, target), bytes: stat.size }); }
            }
        };
        walk(root, 0);
        return { root, entries: rows.length, bytes, unreadable, top: rows.sort((a, b) => b.bytes - a.bytes).slice(0, 12) };
    }
    async function beforeCleanup() {
        const notes = await kit.beforeCleanup();
        try { const found = inventory(dataRoot()); safeArtifact('llm-cleanup-inventory', found); notes.push({ name: 'model-data', value: { bytes: found.bytes, entries: found.entries } }); }
        catch (error) { notes.push({ name: 'model-data', value: String(error?.message || error).slice(0, 200) }); }
        return notes;
    }
    // After the product cleanup the model data must be gone: the workspace, its `.data` and the
    // run's quarantine, as well as the GPU (nothing of ours may remain on it).
    async function afterCleanup() {
        const observation = await kit.afterCleanup();
        llmCleanupProof({ workspace, runId: run.runId, action: 'live', write: (name, value) => { const problem = safeArtifact(name, value); if (problem) throw new Error(`The cleanup proof could not be written: ${problem}`); } });
        return observation;
    }

    return { liveL1, liveL2, liveL3, beforeCleanup, afterCleanup, internals: { ...k, tool, toolOk, waitDeployment, runnerProcesses, leafValues, inventory } };
}

