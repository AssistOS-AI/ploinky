// Optional real-model cases. These use ordinary GPU access or explicit CPU
// withdrawal, without hardware budgets, MPS, or machine lifecycle operations.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { AGENT_INSPECT, HASH, IMAGE_REF, checkedJson, digest, keys, liveSourceDigest } from './liveCommon.mjs';
import { fixtureContainerName, rewriteLlmManifest } from './liveFixture.mjs';
import { LLM_MODELS, LLM_REF } from './liveLlmNames.mjs';
import { LLM_TOOL_CALL, MODEL_PROCESS_FACTS, llmToolWords, validateLlmModelPins } from './liveLlmCommands.mjs';
import { llmCleanupProof } from './liveLlmCases.mjs';
import { createGpuGate, gpuCleanupProof, gpuQueryArgv } from './liveGpuGate.mjs';
import { createHostProc } from './liveGpuHost.mjs';
import { createModelHostGuard, observeAppleMachine, parseModelHostSample } from './liveModelHostGuard.mjs';
import { MODEL_SOURCE_VIEW, modelMountFacts, modelSourceLayout, observeModelStage } from './liveModelSource.mjs';

export const MODEL_PROFILES = Object.freeze({
    apple: { block: 'mac-model-venus', case: 'LIVE-L6', platform: 'darwin', backend: 'venus', runner: 'llama.cpp-vulkan', executable: '/opt/llama.cpp-vulkan/llama-server' },
    nvidia: { block: 'apparatus-model-nvidia', case: 'LIVE-L4', platform: 'linux', backend: 'dedicated', runner: 'llama.cpp', executable: '/opt/llama.cpp/llama-server' },
    cpu: { block: 'apparatus-model-cpu', case: 'LIVE-L5', platform: 'linux', backend: 'cpu', runner: 'llama.cpp', executable: '/opt/llama.cpp/llama-server' },
});
const check = (condition, message) => { if (!condition) throw new Error(message); };

export function modelPlan(run) {
    const profile = run.target.execution;
    const spec = MODEL_PROFILES[profile.model.profile];
    const core = ['container', 'exec', '--user', 'podman', '<BOX_ID>'];
    const nested = [...core, 'podman', '--cgroup-manager=cgroupfs'];
    const command = (id, argv, deadlineMs = 30000) => ({ id, binary: profile.engine.path, argv, deadlineMs });
    const tool = (name, args) => command(`model-${name}`, [...core, 'node', '-e', '<LLM_TOOL_CALL>', ...llmToolWords(name, args, { model: LLM_MODELS.small })], 290000);
    return [
        command('model-box-contract', ['container', 'inspect', '--format', MODEL_CONTAINER_INSPECT, '<BOX_ID>']),
        command('model-agent-source', [...nested, 'container', 'inspect', '--format', MODEL_CONTAINER_INSPECT, '<AGENT_ID>']),
        command('model-source-view', [...nested, 'container', 'exec', '<AGENT_ID>', 'node', '-e', '<MODEL_SOURCE_VIEW>', '<PINNED_SOURCE_AND_DEPENDENCY_PATHS>']),
        { id: 'model-source', action: `Rehash ${profile.provision.workspace.path}/local-llms/local-llm against ${profile.provision.llm.treeDigest}, allowing only the recorded manifest.container rewrite` },
        ...(profile.model.profile === 'apple' ? [
            command('model-machine-list', ['machine', 'list', '--format', 'json']),
            command('model-machine-inspect', ['machine', 'inspect', profile.model.apple.machine]),
            command('model-machine-connection', ['system', 'connection', 'list', '--format', 'json']),
            ...['kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage'].map(key => ({ id: `model-host-${key}`, binary: '/usr/sbin/sysctl', argv: ['-n', key], deadlineMs: 10000 })),
            { id: 'model-host-krunkit', binary: '/bin/ps', argv: ['-axo', 'pid=,rss=,comm='], deadlineMs: 10000 },
        ] : []),
        tool('local_llm_overview', {}),
        tool('local_llm_run', { requestId: `model-${run.runId}`, modelId: LLM_MODELS.small, runnerId: spec.runner, params: {}, replace: false }),
        tool('local_llm_status', {}),
        command('model-process-facts', [...nested, 'container', 'exec', '<AGENT_ID>', 'node', '-e', '<MODEL_PROCESS_FACTS>', profile.model.executable.path]),
        tool('local_llm_test_prompt', { prompt: 'Name one colour.', maxTokens: 64 }),
        tool('local_llm_stop', {}),
    ];
}

export function validateModelPins(model, block) {
    keys(model, ['profile', 'imageConfigDigest', 'imageParentDigest', 'cibRevision', 'executable'], 'model pins', ['apple']);
    const spec = MODEL_PROFILES[model.profile];
    check(spec && spec.block === block, 'Model profile and block disagree');
    check(HASH.test(model.imageConfigDigest) && HASH.test(model.imageParentDigest) && /^[a-f0-9]{40}$/.test(model.cibRevision), 'Invalid immutable model image pins');
    keys(model.executable, ['path', 'sha256', 'version'], 'model executable');
    check(model.executable.path === spec.executable && /^[a-f0-9]{64}$/.test(model.executable.sha256) && model.executable.version === 'b11159', 'Invalid pinned model executable');
    if (model.profile === 'apple') {
        keys(model.apple, ['machine', 'connection', 'uri', 'provider', 'renderNode'], 'Apple pins');
        check(model.apple.provider === 'libkrun' && /^[A-Za-z0-9_.-]{1,80}$/.test(model.apple.machine)
            && /^[A-Za-z0-9_.-]{1,100}$/.test(model.apple.connection) && /^ssh:\/\/[^\s\0]{1,250}$/.test(model.apple.uri)
            && /^\/dev\/dri\/renderD\d+$/.test(model.apple.renderNode), 'Invalid Apple machine pins');
    } else check(model.apple === undefined, 'Only Apple profile has machine pins');
    return spec;
}

export function validateModelProfile(profile, block) {
    const spec = validateModelPins(profile.model, block);
    check(profile.host.platform === spec.platform && profile.cases.join(',') === spec.case, 'Model platform or case mismatch');
    keys(profile.llm, ['image', 'revision', 'models'], 'model local-llm');
    check(IMAGE_REF.test(profile.llm.image) && profile.llm.image === profile.provision.image
        && profile.llm.revision === profile.provision.llm.revision, 'Model source/image pins disagree');
    validateLlmModelPins(profile.llm.models);
    check(profile.provision.ordinarySource === true && profile.fixtures.llm.ref === LLM_REF, 'Model requires ordinary staged source');
    check(profile.provision.llm.sourcePath === `${profile.source.root}/.hwl-local-llms/local-llm`, 'Model frozen source path mismatch');
    if (profile.model.profile === 'nvidia') {
        const gpu = profile.gpu;
        keys(gpu, ['uuid', 'name', 'driverVersion', 'memoryMiB', 'smi'], 'ordinary NVIDIA pins');
        keys(gpu.smi, ['path', 'digest'], 'NVIDIA observer');
        check(/^GPU-[a-fA-F0-9-]{8,64}$/.test(gpu.uuid) && typeof gpu.name === 'string' && gpu.name.length > 0 && gpu.name.length <= 256
            && /^[0-9]+(?:\.[0-9]+)+$/.test(gpu.driverVersion) && Number.isInteger(gpu.memoryMiB) && gpu.memoryMiB >= 1024
            && /^\/[A-Za-z0-9/_.-]+$/.test(gpu.smi.path)
            && HASH.test(gpu.smi.digest) && profile.provision.gpu?.uuid === gpu.uuid, 'Invalid ordinary NVIDIA pins');
    } else check(profile.gpu === undefined, 'CPU/Apple model must not carry NVIDIA pins');
    check(profile.model.profile === 'cpu' ? profile.provision.gpu === undefined : profile.provision.gpu?.grantAgents?.join(',') === LLM_REF, 'Model GPU grant mismatch');
    return spec;
}

export function assertModelObservation({ spec, model, pins, status, answer, processes, imageId }) {
    check(imageId.replace(/^sha256:/, '') === model.imageConfigDigest.slice(7), 'Model image config digest mismatch');
    check(status.profile === spec.backend && status.phase === 'ready' && status.deployment?.profile === spec.backend
        && status.deployment.modelId === LLM_MODELS.small && status.deployment.runnerId === spec.runner, 'Wrong model, runner, or backend');
    const artifact = status.deployment.artifact;
    check(artifact && ['repo', 'file', 'commit', 'size', 'sha256'].every(key => artifact[key] === pins[key]), 'Model artifact digest mismatch');
    check(typeof answer.text === 'string' && answer.text.trim().length > 0 && answer.modelId === LLM_MODELS.small && answer.runnerId === spec.runner
        && Number.isFinite(answer.generationTokensPerSecond) && answer.generationTokensPerSecond > 0, 'Empty or unmeasured model response');
    check(Array.isArray(processes) && processes.length === 1, 'Expected one observed model process');
    const proc = processes[0];
    keys(proc, ['pid', 'start', 'exe', 'sha256', 'args', 'gpuNodes', 'cudaVisible', 'icd', 'layers', 'mps', 'nvidiaLibrary'], 'safe model process facts');
    keys(proc.args, ['--device', '--n-gpu-layers', '-ngl', '--fit'], 'safe model arguments');
    check(proc.exe === model.executable.path && proc.sha256 === model.executable.sha256 && proc.mps === false && typeof proc.nvidiaLibrary === 'boolean' && /^[0-9]+$/.test(proc.start)
        && Number.isInteger(proc.pid) && proc.pid > 0, 'Wrong executable or MPS environment');
    if (model.profile === 'cpu') {
        check(proc.args?.['--device'] === 'none' && proc.args['--n-gpu-layers'] === '0' && proc.args['--fit'] === 'off'
            && proc.args['-ngl'] === null && proc.cudaVisible === '' && !proc.nvidiaLibrary && proc.icd === null
            && Array.isArray(proc.gpuNodes) && proc.gpuNodes.length === 0, 'CPU runner has GPU launch facts');
        check(!status.runnerReport?.device || /^CPU/.test(status.runnerReport.device), 'CPU runner reports a GPU');
        check(!status.runnerReport?.offloaded?.layers, 'CPU runner offloaded layers');
    } else {
        check((model.profile === 'apple' ? /^Vulkan0(?: \([^\n]+\))?$/ : /^CUDA0(?: \([^\n]+\))?$/).test(status.runnerReport?.device || '')
            && Number.isInteger(status.runnerReport?.offloaded?.layers) && status.runnerReport.offloaded.layers > 0, 'GPU backend or positive offload missing');
        if (model.profile === 'apple') check(proc.args?.['--device'] === 'Vulkan0'
            && proc.icd === '/opt/local-llm/vulkan/icd.d/virtio_icd.json' && proc.layers === '~all~' && !proc.nvidiaLibrary, 'Wrong Venus ICD or process backend');
    }
}

export const MODEL_CONTAINER_INSPECT = AGENT_INSPECT.slice(0, -1) + ',"devices":{{json .HostConfig.Devices}}}';
export function assertModelContainer(value, { profile, role }) {
    check(value && Array.isArray(value.mounts), 'Missing model container mount evidence');
    if (role === 'agent') {
        const owned = profile.agents.find(agent => agent.role === 'llm');
        check(owned && value.id === owned.id && value.created === owned.created && value.image === owned.image
            && value.imageName === profile.llm.image && value.running === true, 'Model agent identity changed');
        modelSourceLayout(profile, value);
    }
    check(!value.labels?.[BOX_LABELS.hardwareLimits] || value.labels[BOX_LABELS.hardwareLimits] === 'off', 'Model Box budgets must be off');
    if (profile.model.profile === 'cpu') {
        const allowed = role === 'box' ? ['/dev/fuse', '/dev/net/tun'] : [];
        check(Array.isArray(value.devices) && value.devices.every(device => allowed.includes(device?.PathOnHost) && device.PathInContainer === device.PathOnHost)
            && !value.mounts.some(mount => /nvidia|cuda|\/dev\/dri|cdi/i.test(`${mount.Source} ${mount.Destination}`)), 'CPU container has GPU/CDI devices or mounts');
    }
    if (profile.model.profile === 'apple') {
        check(Array.isArray(value.devices) && value.devices.some(device => device.PathOnHost === profile.model.apple.renderNode
            && device.PathInContainer === profile.model.apple.renderNode), 'Venus render device missing');
    }
}

// Verify staged bytes without reading the managed-repository fallback. The
// manifest is the sole deliberate change; compare every other source byte.
export function assertModelSource(profile) {
    const original = profile.provision.llm;
    check(liveSourceDigest(original.sourcePath) === original.treeDigest, 'Frozen model source changed');
    const target = path.join(profile.workspace.path, 'local-llms', 'local-llm');
    const visit = (from, to) => {
        check(fs.lstatSync(to).isDirectory() && !fs.lstatSync(to).isSymbolicLink(), 'Model source directory changed');
        const names = fs.readdirSync(from).sort();
        check(JSON.stringify(names) === JSON.stringify(fs.readdirSync(to).sort()), 'Model source entries changed');
        for (const name of names) {
            const a = path.join(from, name); const b = path.join(to, name); const stat = fs.lstatSync(a);
            if (stat.isDirectory()) visit(a, b);
            else {
                check(stat.isFile() && fs.lstatSync(b).isFile() && !fs.lstatSync(b).isSymbolicLink(), 'Model source file changed');
                const bytes = fs.readFileSync(a);
                check(digest(fs.readFileSync(b)) === digest(a === path.join(original.sourcePath, 'manifest.json') ? rewriteLlmManifest(bytes, profile.llm.image) : bytes), 'Staged model source bytes changed');
            }
        }
    };
    visit(original.sourcePath, target);
    return { path: target, originalTreeDigest: original.treeDigest, stagedTreeDigest: liveSourceDigest(target), manifest: original.manifest };
}

export function createModelCases(ctx) {
    const { profile, run, command, engine, core, nested, inspectBox, safeArtifact, persist, processProvider, signal } = ctx;
    const spec = MODEL_PROFILES[profile.model.profile];
    const timings = { pollMs: 3000, monitorMs: 2000, ...ctx.timings };
    const write = (name, value) => { const problem = safeArtifact(name, value); if (problem) throw new Error(`Mandatory model artifact unavailable: ${problem}`); };
    let gpu; let apple; let launched = false;
    const host = ctx.host || createHostProc();
    const tool = async (name, args, abort, cleanup = false) => {
        const result = await command(`model-${name}`, profile.engine.path, [...core, 'node', '-e', LLM_TOOL_CALL, ...llmToolWords(name, args, { model: LLM_MODELS.small })],
            { deadlineMs: 290000, maxBytes: 65536, abort, cleanup, journal: !['local_llm_status', 'local_llm_overview'].includes(name) });
        const doc = checkedJson(result);
        check(doc.ok === true && doc.agent === LLM_REF, 'Model Router MCP reply failed or names another agent');
        if (name === 'local_llm_status') {
            const { phase, profile: backend, deployment, runnerReport } = doc.result;
            return { phase, profile: backend, deployment, runnerReport };
        }
        return doc.result;
    };
    async function prepare() {
        const box = await inspectBox();
        const agentName = fixtureContainerName(profile.workspace.path, 'local-llm', 'local-llms');
        const boxFacts = checkedJson(await engine('model-box', ['container', 'inspect', '--format', MODEL_CONTAINER_INSPECT, box.id]));
        const agent = checkedJson(await engine('model-agent', [...nested, 'container', 'inspect', '--format', MODEL_CONTAINER_INSPECT, agentName]));
        write('model-container-mounts', { schema: 1, runId: run.runId, box: modelMountFacts(boxFacts), agent: modelMountFacts(agent) });
        assertModelContainer(boxFacts, { profile, role: 'box' });
        assertModelContainer(agent, { profile, role: 'agent' });
        const source = assertModelSource(profile);
        source.binding = await sourceBinding(agent, boxFacts, source.stagedTreeDigest, 'before');
        if (profile.model.profile === 'apple') {
            const machine = await observeAppleMachine({ profile, engine });
            write('model-apple-machine', machine);
            apple = createModelHostGuard({ intervalMs: timings.monitorMs, write: value => write('model-a15-host-guard', value), sample: async () => {
                await observeAppleMachine({ profile, engine });
                const sample = async (binary, args) => (await command('model-host-sample', binary, args, { deadlineMs: 10000, maxBytes: 65536, journal: false })).stdout;
                return parseModelHostSample({ memoryLevel: await sample('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']), pressure: await sample('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']), swap: await sample('/usr/sbin/sysctl', ['-n', 'vm.swapusage']), processes: await sample('/bin/ps', ['-axo', 'pid=,rss=,comm=']) });
            } });
            await apple.check();
        }
        if (profile.gpu) {
            const observed = host.observe(box.pid);
            const prefix = observed?.cgroup?.match(new RegExp(`^(.*\\/libpod-${box.id}(?:\\.scope)?(?:\\/container)?)(?:\\/.*)?$`))?.[1];
            check(prefix, 'Ordinary GPU Box ancestry unavailable');
            gpu = createGpuGate({ query: () => processProvider(profile.gpu.smi.path, gpuQueryArgv(profile.gpu.uuid), { cwd: profile.host.home, env: { PATH: '/usr/bin:/bin', HOME: profile.host.home }, deadlineMs: 30000, maxBytes: 1048576, signal }),
                host, uuid: profile.gpu.uuid, expectedMemoryMiB: profile.gpu.memoryMiB, boxPrefix: prefix, tolerated: run.toleratedProcesses || [], intervalMs: timings.monitorMs,
                onRegister: record => { run.ownedProcesses.push({ kind: 'gpu-process', ...record }); persist(); } });
            // Register only the exact agent leaf. Foreign processes remain fatal.
            const leaves = [];
            let visited = 0;
            const findLeaf = (directory, depth) => {
                check(++visited <= 128 && depth <= 8, 'Ordinary GPU ancestry observation exceeded its bound');
                for (const name of new Set(host.cgroupDirectories(directory) || [])) {
                    check(/^[A-Za-z0-9_.:@-]+$/.test(name), 'Invalid observed cgroup directory');
                    const child = `${directory}/${name}`;
                    // The host observer returns readdir entries, including controller
                    // files. Only a readable cgroup directory consumes the walk bound.
                    if (host.cgroupProcs(child) === null) continue;
                    if (name === `libpod-${agent.id}` || name === `libpod-${agent.id}.scope`) leaves.push(child);
                    else findLeaf(child, depth + 1);
                }
            };
            findLeaf(prefix, 0);
            check(leaves.length === 1 && host.cgroupProcs(leaves[0]) !== null, 'Ordinary GPU agent ancestry unavailable');
            gpu.registerLeaf(leaves[0]);
            await gpu.initial();
        }
        return { box: { id: box.id, image: box.image }, agent: { id: agent.id, image: agent.image, created: agent.created }, source };
    }
    async function sourceBinding(agent, box, expectedTreeDigest, label, abort = null) {
        const name = `model-source-binding-${label}`;
        const stage = observeModelStage(profile, agent, { box, write: facts => write(name, { runId: run.runId, ...facts }) });
        const view = checkedJson(await engine('model-source-view', [...nested, 'container', 'exec', agent.id, 'node', '-e', MODEL_SOURCE_VIEW, JSON.stringify(stage.view)], { abort, maxBytes: 1048576 }));
        write(name, { runId: run.runId, ...stage, namespace: view });
        check(view.complete === true && view.treeDigest === expectedTreeDigest, 'Model namespace code does not resolve to the pinned source bytes');
        return { stage: stage.layout.stage, dependency: stage.dependency, provider: stage.provider, treeDigest: view.treeDigest, files: view.files.length };
    }
    async function liveModel() {
        const evidence = { schema: 1, runId: run.runId, case: spec.case, profile: profile.model.profile, status: 'running' };
        try {
            Object.assign(evidence, await prepare());
            const overview = await tool('local_llm_overview', {});
            check(overview.profile === spec.backend && overview.runners?.some(runner => runner.id === spec.runner && runner.installed === true && runner.version === 'b11159'), 'Pinned runner/version or profile unavailable');
            check(!overview.limits?.budget?.gpuShare, 'Model overview reports an MPS share');
            if (profile.gpu) check(overview.hardware?.gpu?.driverVersion === profile.gpu.driverVersion && overview.hardware.gpu.name === profile.gpu.name, 'Observed NVIDIA device differs from pins');
            const monitor = work => apple ? apple.monitor(work) : gpu ? gpu.monitor(work) : work(signal);
            await monitor(async abort => {
                if (gpu) await gpu.check('model-before-run');
                launched = true;
                await tool('local_llm_run', { requestId: `model-${run.runId}`, modelId: LLM_MODELS.small, runnerId: spec.runner, params: {}, replace: false }, abort);
                const end = Date.now() + run.deadlines.modelLoadMs;
                for (;;) {
                    check(!signal?.aborted && !abort?.aborted, 'Model load cancelled');
                    evidence.deployment = await tool('local_llm_status', {}, abort);
                    if (evidence.deployment.phase === 'ready') break;
                    check(!['error', 'paused'].includes(evidence.deployment.deployment?.phase) && Date.now() < end, 'Model did not become ready within its deadline');
                    await delay(timings.pollMs, undefined, { signal: abort });
                }
                const agent = profile.agents[0];
                const facts = checkedJson(await engine('model-process-facts', [...nested, 'container', 'exec', agent.id, 'node', '-e', MODEL_PROCESS_FACTS, profile.model.executable.path], { abort, maxBytes: 16384 }));
                evidence.processes = facts.processes;
                if (gpu) await gpu.check('model-before-prompt');
                evidence.answer = await tool('local_llm_test_prompt', { prompt: 'Name one colour.', maxTokens: 64 }, abort);
                if (gpu) await gpu.check('model-after-prompt');
                assertModelObservation({ spec, model: profile.model, pins: profile.llm.models.small, status: evidence.deployment, answer: evidence.answer, processes: facts.processes, imageId: agent.image });
                check(assertModelSource(profile).stagedTreeDigest === evidence.source.stagedTreeDigest, 'Staged model source changed during inference');
                const after = checkedJson(await engine('model-agent-after', [...nested, 'container', 'inspect', '--format', MODEL_CONTAINER_INSPECT, agent.id], { abort }));
                const boxAfter = checkedJson(await engine('model-box-after', ['container', 'inspect', '--format', MODEL_CONTAINER_INSPECT, profile.box.id], { abort }));
                write('model-container-mounts-after', { schema: 1, runId: run.runId, box: modelMountFacts(boxAfter), agent: modelMountFacts(after) });
                assertModelContainer(after, { profile, role: 'agent' });
                assertModelContainer(boxAfter, { profile, role: 'box' });
                const afterBinding = await sourceBinding(after, boxAfter, evidence.source.stagedTreeDigest, 'after', abort);
                check(afterBinding.stage === evidence.source.binding.stage && afterBinding.dependency.generationId === evidence.source.binding.dependency.generationId, 'Model source stage or dependency changed during inference');
            });
            evidence.status = 'pass';
            return evidence;
        } catch (error) { evidence.status = 'fail'; evidence.reason = String(error.message).slice(0, 400); throw Object.assign(error, { evidence }); }
        finally { write(`model-${spec.case.toLowerCase()}`, evidence); }
    }
    async function beforeCleanup() {
        if (!launched) return;
        await tool('local_llm_stop', {}, null, true);
        const status = await tool('local_llm_status', {}, null, true);
        check(!['ready', 'starting', 'loading', 'downloading', 'stopping'].includes(status.phase), 'Model stop did not settle');
        write('model-stop-proof', { runId: run.runId, phase: status.phase });
    }
    async function afterCleanup() {
        if (profile.gpu) await gpuCleanupProof({ run, profile, processProvider, signal: ctx.cleanupSignal, hostProc: host, artifacts: write });
        llmCleanupProof({ workspace: profile.workspace.path, runId: run.runId, action: 'live', write });
    }
    return { liveModel, beforeCleanup, afterCleanup };
}
