// A strict, in-memory fake of the local-llm agent for the apparatus-local-llm and
// apparatus-vllm executor tests. It extends the fake GPU world
// (fakeLiveGpu.mjs): the Box, nvidia-smi, the host process table, the MPS
// daemon, the administrator route with CPU, RAM and GPU limits, the nested
// engine and the candidate's commands are that world's. This adds what the local-llm cases touch:
// the agent's MCP tools behind the Router (overview, status, run, stop, runner
// install, test prompt), its admission under the saved budget, a model that
// downloads, loads and answers, its runner processes and their environment, the
// cgroup leaf values of the agent, the image's file digests and the vLLM
// calibration tool. No GPU, engine, model, SSH host or network is touched.
//
// Strictness: a tool, program or nested command it does not model is a failed
// command (exit 125). A fault can make any step fail, refuse, stall or lie.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveMemoryPercent } from '../../cli/sandbox/hardwareLimits/resolve.mjs';
import { ok } from './fakeLiveEngine.mjs';
import { createGpuWorld } from './fakeLiveGpu.mjs';
import { LEAF_OBSERVATION } from './liveCaseCommands.mjs';
import { shareMemoryMiB } from './liveGpuCommands.mjs';
import { LLM_AGENT, LLM_IMAGE_DIGESTS, LLM_LEAF_SAMPLE, LLM_MODELS, LOCAL_LLM_RUNNER_ENV, LLM_REPOSITORY, LLM_RUNNER_PROCESSES, LLM_TOOL_CALL, VLLM_TOOL_PATH } from './liveLlmCommands.mjs';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const hex = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const failed = (stderr, status = 125) => ok('', { status, stderr });
const gib = bytes => `${(bytes / GIB).toFixed(1)} GiB`;
const canonical = value => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null));
const FIX = 'Use a qualified runner or clear this GPU share; this vLLM/driver/device combination needs MPS qualification.';
const WORLD = Object.freeze({ repository: LLM_REPOSITORY, roles: Object.freeze(['llm']), names: Object.freeze({ llm: LLM_AGENT }), clients: Object.freeze(['llm']) });

export function createLlmWorld({ statePath, node, engine, host, gpu, faults = {}, llm, unrelated = [], hostUid = 1000, envelope = null }) {
    const visible = envelope ?? { cpus: 16, memoryBytes: 32 * GIB, provenance: { memory: 'meminfo', cpus: 'parallelism' } };
    const L = {
        agentId: null, deployment: null, phase: 'idle', polls: 0, requests: new Set(), downloaded: { small: false, awq: false }, runner: null, calls: [], toolLog: [], refusals: [],
        install: { phase: null, polls: 0, download: null }, logs: [], seq: 0, prompts: 0, vllmCalls: [], stops: 0, leafReads: 0,
        // The measurements: the leaf's clock and counters (advanced by each sample), whether a request is generating, and how many samples saw it.
        generating: false, clockUs: 5_000_000_000, cpuUsageUsec: 1_000_000, memoryPeak: 0, samples: [], inflightReads: 0, foreignAdded: false,
    };
    let world = null;
    const model = () => world.model;
    const agent = () => model().agents.get('llm');

    // The agent was replaced (Apply, restart): its runner is gone and the controller starts idle; what
    // lives under /data (the downloaded weights, the install cache) stays.
    function sync() {
        const current = agent();
        if (!current || L.agentId === current.id) return current;
        if (L.runner) endRunner();
        L.agentId = current.id; L.deployment = null; L.phase = 'idle'; L.polls = 0;
        return current;
    }
    const limitsOf = a => a?.limits ?? {};
    const capBytes = a => (limitsOf(a).memoryPercent ? resolveMemoryPercent(limitsOf(a).memoryPercent, visible.memoryBytes) : null);
    const budgetOf = a => {
        const limits = limitsOf(a);
        const cap = capBytes(a);
        if (cap === null && limits.cpus === undefined && !a?.share) return null;
        return {
            cpus: limits.cpus ?? null, memoryBytes: cap, source: 'ploinky',
            ...(a?.share ? { gpuShare: { smPercent: a.share.smPercent, vramBytes: shareMemoryMiB(a.share.vramPercent, gpu.memoryMiB) * MIB, assurance: 'best-effort' } } : {}),
        };
    };

    // --- Admission -----------------------------------------------------------------------------
    const qualified = () => faults.qualified === true || llm.qualified === true;
    function admission(modelId, runnerId) {
        const a = agent();
        if (runnerId === 'llama.cpp') {
            if (faults.admissionRefusesBudget) return { status: 'insufficient-now', reason: 'Needs about 0.8 GiB of RAM; 0.1 GiB is available now.', estimate: {} };
            const cap = capBytes(a);
            if (cap === null) return { status: 'ok', reason: null, estimate: { ramBytes: 768 * MIB, gpuBytes: 700 * MIB } };
            const available = cap - 300 * MIB;
            if (768 * MIB > cap) return { status: 'incompatible', reason: `Needs about ${gib(768 * MIB)} of RAM; this machine has ${gib(cap)}.`, estimate: { ramBytes: 768 * MIB } };
            if (768 * MIB > available - GIB) return { status: 'insufficient-now', reason: `Needs about ${gib(768 * MIB)} of RAM; ${gib(available)} is available now.`, estimate: { ramBytes: 768 * MIB } };
            return { status: 'ok', reason: null, estimate: { ramBytes: 768 * MIB, gpuBytes: 700 * MIB } };
        }
        if (runnerId === 'vllm') {
            if (L.install.phase !== 'installed') return { status: 'incompatible', reason: 'vLLM is not installed. An admin can Install it under Runners.', estimate: {} };
            if (!a?.share) return { status: 'ok', reason: null, estimate: {} };
            if (!qualified()) return { status: 'incompatible', reason: FIX, reasonCode: 'vllm_mps_unqualified', estimate: {} };
            if (faults.admissionNoFit) return { status: 'incompatible', reason: 'Needs about 4.4 GiB of GPU memory for its weights and a KV cache for 8192 tokens; vLLM can use about 2.7 GiB of this GPU.', estimate: {} };
            if (a.share.vramPercent < 87) return { status: 'incompatible', reason: 'Needs about 4.4 GiB of GPU memory for its weights and a KV cache for 8192 tokens; vLLM can use about 2.7 GiB of this GPU.', estimate: {} };
            return { status: 'ok', reason: null, estimate: { gpuBytes: 4_695_175_807, gpuMemoryUtilization: 0.81 } };
        }
        return { status: 'incompatible', reason: 'Unknown runner', estimate: {} };
    }

    // --- The catalog the agent reports (what the manifest pins) ----------------------------------
    function modelView(id) {
        const pins = llm.models;
        if (id === LLM_MODELS.small) {
            const source = { type: 'huggingface', repo: pins.small.repo, file: pins.small.file, revision: pins.small.commit, commit: pins.small.commit, size: pins.small.size, sha256: faults.catalogDrift ? hex('drift') : pins.small.sha256 };
            return { id, sources: { gguf: source }, weights: { gguf: { size: source.size, download: { state: L.downloaded.small ? 'complete' : 'absent', bytes: L.downloaded.small ? source.size : 0 }, bytesNeeded: L.downloaded.small ? 0 : source.size, runners: ['llama.cpp'] } },
                runners: { 'llama.cpp': { format: 'gguf', size: source.size, params: {}, admission: admission(id, 'llama.cpp') } } };
        }
        if (id === LLM_MODELS.awq) {
            const source = { type: 'hf-snapshot', repo: pins.awq.repo, revision: pins.awq.commit, commit: pins.awq.commit, size: pins.awq.size, files: pins.awq.files };
            return { id, sources: { hf: source }, weights: { hf: { size: source.size, download: { state: L.downloaded.awq ? 'complete' : 'absent', bytes: 0 }, bytesNeeded: L.downloaded.awq ? 0 : source.size, runners: ['vllm'] } },
                runners: { vllm: { format: 'hf', size: source.size, params: {}, admission: admission(id, 'vllm') } } };
        }
        return null;
    }
    const runnersView = () => [
        { id: 'llama.cpp', displayName: 'llama.cpp', supported: true, installed: true, version: 'b11159', enabled: true },
        { id: 'vllm', displayName: 'vLLM', supported: true, installed: L.install.phase === 'installed', version: llm.vllm?.pins?.version ?? '0.30.0', enabled: true,
            install: L.install.phase ? { phase: L.install.phase, installing: ['downloading', 'installing'].includes(L.install.phase), installed: L.install.phase === 'installed', version: llm.vllm?.pins?.version ?? '0.30.0', download: L.install.download, error: L.install.error ?? null, pausedReason: L.install.pausedReason ?? null } : { phase: null, installing: false, installed: false } },
    ];
    const deploymentView = () => (L.deployment ? { ...L.deployment, phase: L.phase } : null);

    // --- The model's life -----------------------------------------------------------------------
    function startRunner(a) {
        const leaf = world.helpers.leafOf(a);
        const matcher = L.deployment.runnerId === 'vllm' ? 'vllm' : 'llama-server';
        const pid = 3000 + (L.seq += 1);
        const proc = world.helpers.spawn({ cgroup: leaf, ppid: a.proc.hostPid, ns: [model().nextBox++, pid] });
        // The runner's environment is what local-llm's own code composes (localLlmRunnerEnv.json, captured from the
        // controller's runnerEnv and the adapters' buildLaunch): its names, the product's own CUDA_CACHE_PATH, and the share's
        // MPS values from this agent's container environment. A test fault then changes it.
        const env = Object.fromEntries(a.env.map(entry => { const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)]; }));
        const product = LOCAL_LLM_RUNNER_ENV.runners[matcher === 'vllm' ? 'vllm' : 'llama.cpp'];
        const runnerEnv = Object.fromEntries(Object.entries(product).map(([name, entry]) => [name, name.startsWith('CUDA_MPS_') ? env[name] : entry.perStartSecret ? 'per-start-secret' : entry.value]));
        if (faults.runnerExtraCuda) runnerEnv.CUDA_VISIBLE_DEVICES = '0';
        if (faults.runnerDropsShare) delete runnerEnv.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT;
        if (faults.runnerCudaCache) runnerEnv.CUDA_CACHE_PATH = faults.runnerCudaCache;
        if (faults.runnerNoCudaCache) delete runnerEnv.CUDA_CACHE_PATH;
        for (const name of faults.runnerExtraEnv ?? []) runnerEnv[name] = 'x';
        if (faults.runnerLeaksToken) runnerEnv.LOCAL_LLM_CONTROL_TOKEN = 'x';
        const cuda = Object.fromEntries(Object.entries(runnerEnv).filter(([name]) => name.startsWith('CUDA_')));
        const envNames = Object.keys(runnerEnv).sort();
        const allocatedMiB = matcher === 'vllm' ? (faults.vllmOverShare ? 5600 : 4400) : (faults.gpuOverShare ? 3600 : 600);
        L.runner = { proc, matcher, pid, envNames, cuda, uid: faults.runnerRoot ? [0, 0, 0, 0] : [1000, 1000, 1000, 1000], exe: matcher === 'vllm' ? '/opt/runners/vllm/0.30.0/venv/bin/python3.13' : '/opt/llama.cpp/llama-server', usage: { active: true, allocatedMiB } };
        model().probes.push(L.runner.usage);
        // What nvidia-smi lists for it: the runner by its host PID, or (the MPS case on many drivers) only the server holding its memory.
        if (faults.mpsServerOnly) model().serverMiB = allocatedMiB + 120;
        else model().extraRows.push({ pid: proc.hostPid, type: 'C', name: matcher === 'vllm' ? 'python3' : 'llama-server', mib: allocatedMiB });
        world.helpers.ensureServer(a);
    }
    function endRunner() {
        if (!L.runner) return;
        L.runner.usage.active = false;
        model().extraRows = model().extraRows.filter(row => row.pid !== L.runner.proc.hostPid); model().serverMiB = undefined;
        world.helpers.stop(L.runner.proc);
        L.runner = null;
        world.helpers.dropServers();
    }
    function writeModelData(kind) {
        // The weights and the install cache land under the new workspace's /data, on the real file system of the test.
        const base = path.join(model().workspace, '.data', 'local-llm');
        fs.mkdirSync(path.join(base, 'models', kind), { recursive: true });
        fs.writeFileSync(path.join(base, 'models', kind, 'weights.bin'), 'fake weights');
        fs.mkdirSync(path.join(model().workspace, '.data', 'shared'), { recursive: true });
        if (kind === 'awq') { fs.mkdirSync(path.join(base, 'runners', 'vllm'), { recursive: true }); fs.writeFileSync(path.join(base, 'runners', 'vllm', 'cache.whl'), 'fake wheel'); }
    }
    function advance() {
        const a = agent();
        if (!L.deployment || faults.stalled) return;
        L.polls += 1;
        if (L.phase === 'downloading' && faults.downloadFails) { L.phase = 'error'; L.deployment.error = faults.downloadFails; return; }
        if (L.phase === 'downloading' && L.polls >= 1) { L.phase = 'loading'; L.polls = 0; if (L.deployment.modelId === LLM_MODELS.small) L.downloaded.small = true; else L.downloaded.awq = true; writeModelData(L.deployment.modelId === LLM_MODELS.small ? 'small' : 'awq'); return; }
        if (L.phase === 'loading' && L.polls >= (faults.readyAfter ?? 1)) {
            if (faults.loadFails) { L.phase = 'error'; L.deployment.error = 'The runner exited while loading (out of memory).'; return; }
            L.phase = 'ready'; startRunner(a);
        }
    }

    // --- The tools ----------------------------------------------------------------------------------
    const refusal = (code, message, details) => ({ ok: false, agent: 'local-llm', error: { code, message, ...(details ? { details } : {}) } });
    function tool(name, args, view) {
        L.toolLog.push({ name, args, view });
        if (faults.noAgentRoute) return { ok: false, error: { code: 'agent_not_found', message: 'The tool local_llm_overview is offered by 0 agents' } };
        const a = sync();
        if (!a || faults.agentDown) return { ok: false, error: { code: 'transport', message: 'connect ECONNREFUSED 127.0.0.1:8080' } };
        switch (name) {
        case 'local_llm_overview': {
            if (L.install.phase === 'downloading' || L.install.phase === 'installing') {
                L.install.polls += 1;
                if (faults.foreignDuringInstall && L.install.polls === 2) world.addForeign(555);
                const total = llm.vllm?.pins?.downloadBytes ?? 1;
                if (faults.installError && L.install.polls >= 2) { L.install.phase = 'error'; L.install.error = 'Installing vllm failed: no matching distribution found for torch (cp313)'; }
                else if (faults.installPaused && L.install.polls >= 2) { L.install.phase = 'paused'; L.install.pausedReason = 'Not enough free disk to continue the download.'; }
                else if (faults.installStalls) L.install.download = { bytes: Math.floor(total / 10), total, rate: 1000 };
                else if (L.install.polls === 1) L.install.download = { bytes: Math.floor(total / 2), total, rate: 50_000_000 };
                else if (L.install.polls === 2) { L.install.phase = 'installing'; L.install.download = { bytes: total, total, rate: 0 }; }
                else { L.install.phase = 'installed'; writeModelData('vllm-cache'); fs.mkdirSync(path.join(model().workspace, '.data', 'local-llm', 'runners', 'vllm'), { recursive: true }); fs.writeFileSync(path.join(model().workspace, '.data', 'local-llm', 'runners', 'vllm', 'cache.whl'), 'fake wheel'); }
            }
            const wanted = view.model ? modelView(view.model) : null;
            const preview = args.preview ? { modelId: args.preview.modelId, runnerId: args.preview.runnerId, params: {}, admission: admission(args.preview.modelId, args.preview.runnerId) } : undefined;
            return { ok: true, agent: 'local-llm', result: {
                profile: 'dedicated', limits: budgetOf(a) ? { budget: budgetOf(a) } : null,
                hardware: { gpu: { available: true, name: gpu.name, driverVersion: gpu.driverVersion, totalBytes: gpu.memoryMiB * MIB, usedBytes: 13 * MIB, freeBytes: (gpu.memoryMiB - 13) * MIB, memoryModel: 'dedicated', device: { pciDeviceId: '0x252010DE', computeCapability: '8.6' } }, memory: { totalBytes: visible.memoryBytes, availableBytes: visible.memoryBytes - GIB }, cpus: visible.cpus },
                runners: runnersView(), model: wanted, deployment: deploymentView(), preview, gatewayModel: 'soul_gateway/local-llms/local-llm/default',
            } };
        }
        case 'local_llm_status': {
            advance();
            return { ok: true, agent: 'local-llm', result: { phase: L.phase, profile: 'dedicated', deployment: deploymentView(), logs: L.logs.slice(-30), nextSeq: L.seq, runnerReport: L.phase === 'ready' && L.deployment.runnerId === 'vllm' ? { modelMiB: 2549, kvMiB: 1200, totalMiB: 3749 } : {}, memoryGuard: null } };
        }
        case 'local_llm_run': {
            if (L.requests.has(args.requestId)) return { ok: true, agent: 'local-llm', result: { accepted: true, duplicate: true } };
            if (['downloading', 'loading', 'ready', 'starting'].includes(L.phase) && !args.replace) return refusal('busy', `${L.deployment.modelId} on ${L.deployment.runnerId} is ${L.phase}; stop it first or run with replace.`);
            const verdict = admission(args.modelId, args.runnerId);
            if (verdict.status !== 'ok' && !faults.runAcceptedAnyway) {
                L.refusals.push({ modelId: args.modelId, runnerId: args.runnerId, status: verdict.status });
                const code = `admission_${verdict.status.replace('-', '_')}`;
                if (faults.refusalAsPlainText) return { ok: false, agent: 'local-llm', error: { code: 'tool_error', message: verdict.reason } };
                // The real route flattens a tool error into text: the code and the message survive, the details do not.
                if (faults.refusalFlattened) return refusal(code, verdict.reason);
                return refusal(code, verdict.reason, { admission: { status: verdict.status, reason: verdict.reason, reasonCode: verdict.reasonCode ?? null, estimate: verdict.estimate } });
            }
            L.requests.add(args.requestId);
            const downloaded = args.modelId === LLM_MODELS.small ? L.downloaded.small : L.downloaded.awq;
            const artifact = args.modelId === LLM_MODELS.small
                ? { type: 'huggingface', repo: llm.models.small.repo, file: llm.models.small.file, revision: llm.models.small.commit, commit: llm.models.small.commit, size: llm.models.small.size, sha256: faults.deployedOtherModel ? hex('other') : llm.models.small.sha256 }
                : { type: 'hf-snapshot', repo: llm.models.awq.repo, revision: llm.models.awq.commit, commit: llm.models.awq.commit, size: llm.models.awq.size, files: llm.models.awq.files };
            L.deployment = { id: hex(`deployment-${L.seq}-${args.requestId}`).slice(0, 32), modelId: args.modelId, runnerId: args.runnerId, profile: 'dedicated', admission: verdict, artifact, error: null, download: { bytes: 0, total: artifact.size }, createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z' };
            L.phase = downloaded ? 'loading' : 'downloading'; L.polls = 0;
            return { ok: true, agent: 'local-llm', result: { accepted: true, deployment: { phase: L.phase } } };
        }
        case 'local_llm_stop': {
            L.stops += 1;
            endRunner(); L.phase = 'idle'; if (L.deployment) L.deployment.error = null;
            return { ok: true, agent: 'local-llm', result: { deployment: deploymentView() } };
        }
        case 'local_llm_runner_install': {
            if (L.install.phase && !['error', 'paused'].includes(L.install.phase)) return refusal('busy', 'An install is already running.');
            if (faults.installRefused) return refusal('runner_unavailable', 'vLLM is not available on this platform: this image does not include it.');
            L.install = { phase: 'downloading', polls: 0, download: { bytes: 0, total: llm.vllm?.pins?.downloadBytes ?? 1, rate: 0 } };
            return { ok: true, agent: 'local-llm', result: { accepted: true } };
        }
        case 'local_llm_test_prompt': {
            if (L.phase !== 'ready' || !L.runner) return refusal('not_ready', 'No model is ready.');
            L.prompts += 1;
            const text = faults.emptyText ? '' : 'Pong.';
            return { ok: true, agent: 'local-llm', result: { text, truncated: false, reasoningChars: faults.emptyText ? 300 : 0, finishReason: faults.emptyText ? 'length' : 'stop', runnerId: L.deployment.runnerId, modelId: faults.wrongModel ? 'other-model' : L.deployment.modelId, via: 'loopback runner (admin test prompt)', completionTokens: 3 } };
        }
        default: return { ok: false, error: { code: 'invalid', message: 'Unsupported tool' } };
        }
    }

    // --- In-Box and in-agent programs ---------------------------------------------------------------------
    // The swap cap the leaf reports: `0` unless a test sets another value (`max`, a number) or `null` (the file is absent).
    const swapCap = value => (value === null ? null : `${value ?? '0'}\n`);
    const leafPath = a => `/sys/fs/cgroup/ploinky/agents/libpod-${a.id}`;
    function leafValues(target) {
        const a = [...model().agents.values()].find(value => leafPath(value) === target);
        if (!a) return failed('Error: Noncanonical leaf');
        L.leafReads += 1;
        const limits = limitsOf(a);
        const memory = capBytes(a);
        const memoryMax = faults.memoryMaxWrong ? String(memory - MIB) : memory === null ? 'max' : String(memory);
        const cpuMax = limits.cpus === undefined ? 'max 100000' : `${Math.round((faults.cpuMaxWrong ? limits.cpus * 2 : limits.cpus) * 100000)} 100000`;
        return ok(JSON.stringify({ 'memory.max': `${memoryMax}\n`, 'memory.swap.max': swapCap(faults.swapMaxAfterApply), 'memory.current': `${300 * MIB}\n`, 'memory.swap.current': '0\n', 'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n', 'cpu.max': `${cpuMax}\n`, 'cpu.stat': 'nr_throttled 0\n', 'pids.max': 'max\n', 'pids.events': 'max 0\n', identity: { dev: '1', ino: '2' } }));
    }
    // One sample of the leaf's counters. Each read advances the leaf's clock by a step and its CPU time by the rate
    // of what is running (low when idle, a share of the quota while a request generates), so usage / wall time is that rate.
    function leafSample(target) {
        const a = [...model().agents.values()].find(value => leafPath(value) === target);
        if (!a) return failed('Error: Noncanonical leaf');
        const limits = limitsOf(a); const cpus = limits.cpus ?? 4; const cap = capBytes(a);
        const step = faults.sampleStepUs ?? 200_000;
        const rate = L.generating ? (faults.cpuOverQuota ? cpus * 2.5 : cpus * 0.6) : 0.02;
        L.clockUs += step; L.cpuUsageUsec += Math.round(rate * step);
        if (L.generating) L.inflightReads += 1;
        const baseMiB = L.generating ? 900 : 600;
        const current = (L.generating && faults.memoryOverCap && cap !== null) ? cap + 64 * MIB : baseMiB * MIB;
        L.memoryPeak = Math.max(L.memoryPeak, current);
        const swap = L.generating && faults.swapSeen ? 8 * MIB : 0;
        if (L.generating && faults.oomKilled) L.oomKills = 1;
        const kills = L.oomKills ?? 0;
        const cpuMax = limits.cpus === undefined ? 'max 100000' : `${Math.round((faults.cpuMaxWrong ? limits.cpus * 2 : limits.cpus) * 100000)} 100000`;
        const raw = { atNs: String(BigInt(L.clockUs) * 1000n), 'cpu.stat': `usage_usec ${L.cpuUsageUsec}\nuser_usec ${L.cpuUsageUsec}\nsystem_usec 0\nnr_periods ${Math.floor(L.clockUs / 100000)}\nnr_throttled 0\nthrottled_usec 0\n`,
            'cpu.max': `${cpuMax}\n`, 'memory.max': `${faults.memoryMaxWrong ? String(cap - MIB) : cap === null ? 'max' : String(cap)}\n`, 'memory.swap.max': swapCap(faults.swapMaxInSamples), 'memory.current': `${current}\n`, 'memory.swap.current': `${swap}\n`,
            'memory.peak': faults.noMemoryPeak ? null : `${L.memoryPeak}\n`, 'memory.events': `low 0\nhigh 0\nmax 0\noom ${kills}\noom_kill ${kills}\n` };
        L.samples.push({ generating: L.generating });
        return ok(JSON.stringify(raw));
    }
    // A request that takes time: the model generates until the sampler has seen it twice (or a bound passes).
    async function generating(work) {
        L.generating = true; model().gpuUtil = 45;
        if (faults.foreignDuringPrompt && !L.foreignAdded) { L.foreignAdded = true; world.addForeign(555); }
        const until = Date.now() + (faults.generateMs ?? 1500); const wanted = L.inflightReads + (faults.generateReads ?? 4); const queries = model().smiQueries + (faults.generateGpuReads ?? 3);
        try { while ((L.inflightReads < wanted || model().smiQueries < queries) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 1)); return work(); }
        finally { L.generating = false; model().gpuUtil = 0; }
    }
    function runnerProcesses(matcher) {
        if (!L.runner || L.runner.matcher !== matcher) return ok(JSON.stringify({ processes: [] }));
        const r = L.runner;
        return ok(JSON.stringify({ processes: [{ pid: r.pid, exe: r.exe, ppid: 7, start: r.proc.start, uid: r.uid, envNames: r.envNames, cuda: r.cuda }] }));
    }
    const lockPins = () => llm.vllm?.pins;
    function prerequisites(words) {
        const pins = JSON.parse(words[words.indexOf('--pins') + 1]);
        L.vllmCalls.push({ command: 'prerequisites', pins });
        const blockers = [];
        if (faults.vllmNoEntry) blockers.push({ code: 'vllm_entry_missing', message: 'The image\'s runner lock has no vLLM entry (it lists: nothing), so vLLM cannot be installed from this image.', evidence: { runners: [] } });
        if (faults.vllmDiskShort) blockers.push({ code: 'insufficient_disk', message: 'Not enough free disk to install vLLM and hold the model: /data and /opt/runners share one filesystem with 5000000000 bytes free; 20000000000 are needed.', evidence: { need: { dataBytes: 6_000_000_000 } } });
        if (faults.vllmDriverOld) blockers.push({ code: 'driver_too_old', message: 'Driver 570.86.10 is older than the 580 that CUDA 13.0 wheels need.', evidence: {} });
        const digest = faults.vllmWrongPins ? hex('another entry') : pins.runnerLockDigest;
        const doc = { schema: 'local-llm.vllm-prerequisites/v1', ok: blockers.length === 0, blockers, facts: { arch: 'x64', driverVersion: gpu.driverVersion, python: { major: 3, minor: 13 }, gpu: { name: gpu.name, memoryModel: 'dedicated', totalBytes: gpu.memoryMiB * MIB, device: { pciDeviceId: '0x252010DE', computeCapability: '8.6' } }, lock: { sha256: hex('lock'), vllm: { version: pins.version, kind: 'python', runnerLockDigest: digest, files: pins.files, downloadBytes: pins.downloadBytes, distributions: { vllm: pins.version, torch: '2.13.0' }, cudaRuntime: { major: 13, minor: 0 } } }, disk: { sameFilesystem: true } } };
        return ok(`${JSON.stringify(doc)}\n`, { status: doc.ok ? 0 : 3, ...(faults.prerequisitesProcess ?? {}) });
    }
    function calibration(words) {
        const host = Number(words[words.indexOf('--host-nvml-bytes') + 1]);
        L.vllmCalls.push({ command: 'calibrate', hostNvmlBytes: host });
        if (faults.calibrateBlocked) return ok(`${JSON.stringify({ schema: 'local-llm.vllm-mps-calibration/v1', ok: false, blockers: [{ code: 'vllm_not_installed', message: 'vLLM is not installed', evidence: {} }], evidence: null })}\n`, { status: 3 });
        // The calibration process ended abnormally (a complete document may still be on stdout).
        const abnormal = faults.calibrateProcess ?? null;
        const pins = lockPins();
        const share = agent().share;
        const physical = faults.denominator !== 'share';
        const usable = Math.floor(gpu.memoryMiB * MIB * 0.94);
        const shareBytes = shareMemoryMiB(share.vramPercent, gpu.memoryMiB) * MIB;
        const tuple = { runnerLockDigest: pins.runnerLockDigest, driverVersion: gpu.driverVersion, gpuPciDeviceId: '0x252010DE', computeCapability: '8.6', deviceTotalBytes: gpu.memoryMiB * MIB };
        const failedChecks = [...(physical ? [] : ['denominatorIsPhysical', 'matchesIntended']), ...(faults.archUnsupported ? ['archSupported'] : [])];
        const evidence = {
            schema: 'local-llm.vllm-mps-calibration/v1', createdAt: '2026-10-03T10:00:00Z', model: LLM_MODELS.awq, tuple,
            install: { version: pins.version }, lock: { runnerLockDigest: pins.runnerLockDigest, downloadBytes: pins.downloadBytes, files: pins.files },
            share: { smPercent: share.smPercent, vramBytes: shareBytes, tightBytes: 2048 * MIB },
            measurements: { hostNvmlTotalBytes: host, containerNvmlTotalBytes: gpu.memoryMiB * MIB, torchShare: { memGetInfo: { total: physical ? usable : shareBytes } }, torchTight: { memGetInfo: { total: physical ? usable : 2048 * MIB } }, ctypesShare: { total: physical ? usable : shareBytes }, utilization: 0.81 },
            denominator: { denominator: physical ? 'physical-device' : 'share' }, sizing: { lines: [{ file: 'v1/worker/gpu_worker.py', line: 2, text: 'requested_memory = snapshot.total_memory * cache_config.gpu_memory_utilization' }] },
            argv: { command: '/opt/runners/vllm/0.30.0/venv/bin/python', args: ['-m', 'vllm.entrypoints.openai.api_server', '--gpu-memory-utilization', '0.81'] }, admission: { status: 'ok' },
            verdict: { qualifiable: failedChecks.length === 0, denominator: physical ? 'physical-device' : 'share', checks: {}, failed: failedChecks },
        };
        evidence.evidenceDigest = hex(canonical({ ...evidence, evidenceDigest: undefined }));
        const doc = { schema: evidence.schema, ok: true, blockers: [], evidence };
        if (evidence.verdict.qualifiable) {
            const entry = { ...tuple, denominator: 'physical-device', evidenceDigest: evidence.evidenceDigest };
            doc.proposed = faults.noProposal ? undefined : { entry: faults.proposalWrongDigest ? { ...entry, evidenceDigest: hex('x') } : entry, digest: evidence.evidenceDigest, source: '    Object.freeze({ ... }),' };
        }
        return ok(`${JSON.stringify(doc)}\n`, abnormal ?? {});
    }
    async function core({ script, rest }) {
        if (script === LLM_TOOL_CALL) {
            const run = () => ok(JSON.stringify(tool(rest[0], JSON.parse(rest[1]), JSON.parse(rest[2]))));
            return rest[0] === 'local_llm_test_prompt' && L.phase === 'ready' && L.runner && !faults.promptInstant ? generating(run) : run();
        }
        if (script === LEAF_OBSERVATION) return leafValues(rest[0]);
        if (script === LLM_LEAF_SAMPLE) return leafSample(rest[0]);
        return null;
    }
    async function agentExec({ agent: target, command }) {
        sync();
        if (target.id !== agent()?.id) return failed('Error: no such container');
        if (command[0] === 'node' && command[1] === '-e' && command[2] === LLM_RUNNER_PROCESSES) return runnerProcesses(command[3]);
        if (command[0] === 'node' && command[1] === '-e' && command[2] === LLM_IMAGE_DIGESTS) {
            return ok(JSON.stringify({ files: { '/opt/llama.cpp/llama-server': faults.noRunnerBinary ? null : { sha256: hex('llama-server'), size: 123456 }, '/opt/local-llm/source.contract': { sha256: hex('contract'), size: 100 }, '/opt/local-llm/runners.lock.json': { sha256: hex('lock'), size: 1000 } }, contract: 'llama_cpp=b11159\n' }));
        }
        if (command[0] === 'node' && command[1] === VLLM_TOOL_PATH) return command[2] === 'prerequisites' ? prerequisites(command) : command[2] === 'calibrate' ? calibration(command) : failed('unmodeled tool command');
        return null;
    }

    world = createGpuWorld({ statePath, node, engine, host, gpu, faults, unrelated, hostUid, fixture: WORLD, envelope: visible, hooks: { core, agentExec } });
    return { ...world, llm: L, tool, admission, visible };
}
