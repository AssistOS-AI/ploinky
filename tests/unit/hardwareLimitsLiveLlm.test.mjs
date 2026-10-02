// Offline tests of the apparatus-local-llm and apparatus-vllm executors (round G2):
// LIVE-L1, LIVE-L2 and LIVE-L3 (step 0, stage 1 and stage 2), the concrete manifests
// and approval summaries, provisioning of the local-llm candidate, the in-Box and
// in-agent programs, and the cleanup of model data. Every engine, nvidia-smi, MPS
// daemon, host process table, MCP tool and model is the in-memory fake of
// tests/hardware-limits/fakeLiveLlm.mjs over the fake GPU world: nothing here starts
// a container, opens SSH, uses a GPU, downloads a model or touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writePrivateJson } from '../hardware-limits/fixtures.mjs';
import { createLiveAdapter, executeCleanupRun, executeLiveRun, liveSourceDigest, validateProfile } from '../hardware-limits/liveHarness.mjs';
import { provisionRun } from '../hardware-limits/liveFixture.mjs';
import { buildConcreteManifest, llmPlan, renderSummary, summaryPathFor } from '../hardware-limits/liveManifest.mjs';
import { writeUstar } from '../hardware-limits/liveStage.mjs';
import { engineIdentityDigest, hostRecordPaths } from '../hardware-limits/liveCommon.mjs';
import { fakeEngineInfo, worldState } from '../hardware-limits/fakeLiveEngine.mjs';
import { createLlmWorld } from '../hardware-limits/fakeLiveLlm.mjs';
import { LEAF_OBSERVATION } from '../hardware-limits/liveCaseCommands.mjs';
import {
    LOCAL_LLM_RUNNER_ENV, isSecretName, runnerEnvironmentProblems, runnerProductNames,
    INFERENCE_MIN_IN_FLIGHT, INFERENCE_TOLERANCE, INSUFFICIENT_RAM, LLM_BUDGET, LLM_IMAGE_DIGESTS, LLM_LEAF_SAMPLE, LLM_MODELS, LLM_RUNNER_PROCESSES, LLM_TOOL_CALL, VLLM_SHARE, VLLM_TOOL_PATH,
    analyzeInference, insufficientMemoryPercent, llmToolWords, parseLeafSample, summarizeGpuCheck, validateLlmModelPins, validateLlmProfile, vllmToolWords,
} from '../hardware-limits/liveLlmCommands.mjs';
import { resolveMemoryPercent } from '../../cli/sandbox/hardwareLimits/resolve.mjs';

const REPO = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const hex = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => `sha256:${hex(value)}`;
const MIB = 1048576; const GIB = 1024 * MIB;
const ENGINE_HOST = { arch: 'test', os: 'linux', hostname: 'fake-engine', id: 'engine-1' };
const LLM_IMAGE = `docker.io/assistos/local-llm@sha256:${'c'.repeat(64)}`;
const BOX_IMAGE = `docker.io/assistos/ploinky-box@sha256:${'b'.repeat(64)}`;
const UNRELATED = [{ id: 'e'.repeat(64), created: '2026-09-01T00:00:00Z', image: 'f'.repeat(64), labels: {}, mounts: [{ Source: '/elsewhere' }] }];
const GPU_UUID = 'GPU-905b8484-3b1e-30f6-defd-05d44f00f692';
const free = async () => ({ tcp: true, udp: true });
const exists = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const FAST = { sampleMs: 1, settleMs: 1, settleSamples: 2, monitorMs: 4, afterApplyMs: 0, serverWaitMs: 2000, controlMs: 20000, pollMs: 1, installPollMs: 1, readyMs: 2000, stopMs: 5000, promptMs: 5000, toolMs: 20000, calibrateMs: 20000, inferenceSampleMs: 1, inferenceGpuMs: 4 };
// The pins of the image's vLLM lock entry the operator observed (the real entry has 197 files and 3,879,736,753 bytes).
const VLLM_PINS = Object.freeze({ version: '0.30.0', runnerLockDigest: hex('vllm lock entry'), files: 197, downloadBytes: 3879736753 });
const SMALL_FILE = { repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', commit: '9217f5db79a29953eb74d5343926648285ec7e67', size: 491400032, sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db' };
const AWQ_FILES = [['config.json', 904, 'cf74d403'], ['generation_config.json', 239, '2325da0f'], ['merges.txt', 1671853, '8831e4f1'], ['model.safetensors', 2666027672, 'a7043493'], ['tokenizer.json', 11422654, 'aeb13307'], ['tokenizer_config.json', 9732, 'd5d09f07'], ['vocab.json', 2776833, 'ca10d7e9']]
    .map(([name, size, prefix]) => ({ path: name, size, sha256: `${prefix}${hex(name).slice(8)}` }));
const AWQ_COMMIT = '74d4bd2bd4bff9cafc9345221320bffb08b406a3';

function scratch(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-llm-')));
    t.after(() => {
        const open = target => { const stat = fs.lstatSync(target); if (!stat.isDirectory()) return; fs.chmodSync(target, 0o700); for (const name of fs.readdirSync(target)) open(path.join(target, name)); };
        if (exists(root)) { open(root); fs.rmSync(root, { recursive: true, force: true }); }
    });
    return root;
}

// The local-llm candidate's tree, as the frozen payload carries it (.hwl-local-llms/local-llm): its manifest
// (naming the tag, not the digest), its catalog with the two pinned models, the calibration tool and the
// qualification module the second stage asks (stand-ins of the candidate's own files).
const ORIGINAL_MANIFEST = { name: 'local-llm', container: 'docker.io/assistos/local-llm:latest', agent: 'exec node /code/src/main.mjs', readiness: { protocol: 'mcp' }, volumes: { '.data/local-llm': '/data' }, containerSecurity: { gpu: true, shmSize: '8g' } };
const CATALOG = {
    schema: 'local-llm.catalog/v3',
    models: [
        { id: LLM_MODELS.small, sources: { gguf: { type: 'huggingface', repo: SMALL_FILE.repo, file: SMALL_FILE.file, revision: SMALL_FILE.commit, commit: SMALL_FILE.commit, size: SMALL_FILE.size, sha256: SMALL_FILE.sha256 } } },
        { id: LLM_MODELS.awq, sources: { hf: { type: 'hf-snapshot', repo: 'Qwen/Qwen3-4B-AWQ', revision: AWQ_COMMIT, commit: AWQ_COMMIT, files: AWQ_FILES } } },
    ],
};
const TOOL_STUB = `import { createHash } from 'node:crypto';
export const CALIBRATION_SCHEMA = 'local-llm.vllm-mps-calibration/v1';
export const TUPLE_FIELDS = ['runnerLockDigest', 'driverVersion', 'gpuPciDeviceId', 'computeCapability', 'deviceTotalBytes'];
const canonical = (value) => (Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value ?? null));
export function evidenceDigest(document) { const { evidenceDigest: _own, ...rest } = document || {}; return createHash('sha256').update(canonical(rest)).digest('hex'); }
`;
const qualificationStub = entries => `const ENTRIES = ${JSON.stringify(entries)};
export function resolveVllmMpsQualification(tuple) {
    const match = ENTRIES.find((entry) => ['runnerLockDigest', 'driverVersion', 'gpuPciDeviceId', 'computeCapability', 'deviceTotalBytes'].every((field) => entry[field] === tuple[field]));
    return match ? { qualified: true, denominator: 'physical-device', evidenceDigest: match.evidenceDigest } : { qualified: false, code: 'vllm_mps_unqualified' };
}
`;
function writeLlmTree(base, { entries = [] } = {}) {
    const tree = path.join(base, '.hwl-local-llms', 'local-llm');
    for (const directory of ['catalog', 'tools', path.join('src', 'controller')]) fs.mkdirSync(path.join(tree, directory), { recursive: true });
    fs.writeFileSync(path.join(tree, 'manifest.json'), `${JSON.stringify(ORIGINAL_MANIFEST, null, 4)}\n`);
    fs.writeFileSync(path.join(tree, 'catalog', 'models.json'), JSON.stringify(CATALOG));
    fs.writeFileSync(path.join(tree, 'tools', 'vllm_mps_calibration.mjs'), TOOL_STUB);
    fs.writeFileSync(path.join(tree, 'src', 'controller', 'vllmMpsQualification.mjs'), qualificationStub(entries));
    fs.writeFileSync(path.join(tree, 'src', 'main.mjs'), '// agent\n');
    return tree;
}

// One fake apparatus for a local-llm block: the candidate source carrying the local-llm tree, pinned NVIDIA tools, a
// staged remote root and the concrete manifest built by the real builder, over the fake local-llm world.
function llmWorld(t, { block = 'apparatus-local-llm', faults = {}, vllm = null, qualified = false, suffix = 'claude', envelope, display = null, entries = null } = {}) {
    const root = scratch(t);
    const directory = name => { const target = path.join(root, name); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); return target; };
    const home = directory('home');
    const source = directory('source');
    fs.mkdirSync(path.join(source, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// fixture candidate\n');
    fs.mkdirSync(path.join(source, 'tests', 'hardware-limits'), { recursive: true });
    fs.writeFileSync(path.join(source, 'tests', 'hardware-limits', 'verify.mjs'), '// fixture runner\n');
    // The reviewed data of the frozen candidate: the entry stage 2 expects, unless a test names its own entries.
    const reviewed = entries ?? (vllm?.stage === 'qualified' && vllm.calibration?.expectQualified ? [{ ...vllm.calibration.tuple, denominator: 'physical-device', evidenceDigest: vllm.calibration.evidenceDigest }] : []);
    writeLlmTree(source, { entries: reviewed });
    const bin = directory('bin');
    const engine = path.join(bin, 'podman'); fs.writeFileSync(engine, 'fake engine\n');
    const ssh = path.join(bin, 'ssh'); fs.writeFileSync(ssh, 'fake ssh\n');
    const tools = Object.fromEntries(['nvidia-smi', 'nvidia-cuda-mps-control', 'nvidia-cuda-mps-server'].map(name => { const file = path.join(bin, name); fs.writeFileSync(file, `fake ${name}\n`); return [name, file]; }));
    const knownHosts = path.join(root, 'known_hosts'); fs.writeFileSync(knownHosts, '192.168.1.63 ssh-ed25519 AAAAfixture\n');
    const evidence = directory('evidence');
    const node = fs.realpathSync(process.execPath);
    fs.mkdirSync(path.join(home, '.ploinky-box', 'gpu-grants'), { recursive: true, mode: 0o700 });
    const hostIdentity = { hostname: 'apparatus', platform: 'linux', home };
    const gpu = { uuid: GPU_UUID, name: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '595.91.07', memoryMiB: 6144, smCount: 30, smi: tools['nvidia-smi'], mpsControl: tools['nvidia-cuda-mps-control'], mpsServer: tools['nvidia-cuda-mps-server'] };
    const isVllm = block === 'apparatus-vllm';
    const pins = {
        schema: 1, host: hostIdentity, node: { path: node, digest: hash(fs.readFileSync(node)) },
        engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: engineIdentityDigest(fakeEngineInfo(ENGINE_HOST)) }, boxImage: BOX_IMAGE,
        ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '100.76.22.69', hostKeyAlias: '192.168.1.63', user: 'skutner', knownHosts, identityFile: null },
        gpu: {
            uuid: gpu.uuid, name: gpu.name, driverVersion: gpu.driverVersion, memoryMiB: gpu.memoryMiB, expectedSmCount: 30,
            smi: { path: gpu.smi, digest: hash(fs.readFileSync(gpu.smi)) }, mpsControl: { path: gpu.mpsControl, digest: hash(fs.readFileSync(gpu.mpsControl)) }, mpsServer: { path: gpu.mpsServer, digest: hash(fs.readFileSync(gpu.mpsServer)) },
        },
        llm: { image: LLM_IMAGE, ...(isVllm ? { vllm: { ...VLLM_PINS } } : {}) },
    };
    const runId = crypto.randomBytes(16).toString('hex');
    const candidate = { root: source, digest: liveSourceDigest(source), revision: 'c'.repeat(40), llm: { revision: 'd'.repeat(40) } };
    const payloadPath = path.join(evidence, `candidate-${runId}.tar`);
    candidate.payload = { path: payloadPath, ...writeUstar(source, payloadPath) };
    const stage = vllm ?? (isVllm ? { stage: 'calibration' } : null);
    const run = buildConcreteManifest({
        block, runId, configDigest: hash('config'), casesDigest: hash('cases'), documentSuffix: suffix, pins, candidate, image: LLM_IMAGE,
        ports: { tcp: 23456, udp: 34567 }, unsupported: {}, vllm: stage,
    });
    const remoteRoot = run.target.stage.root;
    fs.mkdirSync(remoteRoot, { recursive: true }); fs.chmodSync(remoteRoot, 0o700);
    fs.writeFileSync(path.join(remoteRoot, '.ploinky-hwl-owner'), runId, { mode: 0o600 });
    fs.cpSync(source, path.join(remoteRoot, 'source'), { recursive: true });
    const runPath = path.join(evidence, `run_${suffix}.json`);
    writePrivateJson(runPath, run);
    const statePath = path.join(root, 'world_claude.json');
    const profileLlm = run.target.execution.llm;
    const fake = createLlmWorld({ statePath, node, engine, host: ENGINE_HOST, gpu, faults, unrelated: UNRELATED, envelope, llm: { models: profileLlm.models, vllm: profileLlm.vllm, qualified } });
    if (display) fake.addDisplay(display);
    const artifacts = new Map();
    const persist = () => writePrivateJson(runPath, run);
    const w = { root, home, source, evidence, engine, node, pins, run, runId, runPath, statePath, remoteRoot, hostIdentity, gpu, fake, artifacts, persist, faults };
    const options = () => ({ run: w.run, persist, processProvider: fake.provider, hostIdentity, remoteArrival: true, hostProc: fake.hostProc, artifacts: (name, value) => artifacts.set(name, structuredClone(value)) });
    w.provision = (extra = {}) => provisionRun({ ...options(), portProbe: free, validateProfile, ...extra });
    w.live = (extra = {}) => executeLiveRun({ ...options(), gpuTimings: { ...FAST, ...(extra.timings || {}) }, ...extra });
    w.cleanup = (extra = {}) => executeCleanupRun({ ...options(), ...extra });
    return w;
}
async function provisioned(t, options) {
    const w = llmWorld(t, options);
    const report = await w.provision();
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    return w;
}
const caseOf = (report, id) => report.cases.find(entry => entry.id === id);
async function liveCases(w, ids, extra = {}) { w.run.target.execution.cases = ids; return w.live(extra); }
const nothingOwned = w => {
    const state = worldState(w.statePath);
    assert.deepEqual(Object.keys(state.boxes), []);
    const plan = w.run.target.execution.provision;
    for (const target of [plan.workspace.path, path.join(path.dirname(plan.workspace.path), `.hwl-removing-${w.runId}`), ...hostRecordPaths(w.home, w.run.workspace.instance)]) assert.equal(exists(target), false, target);
};
const toolCalls = (w, name) => w.fake.llm.toolLog.filter(entry => entry.name === name);
const stepNames = (w, id) => w.artifacts.get(`gpu-${id}`)?.steps.map(step => step.name) ?? [];

// --- Provisioning -------------------------------------------------------------------------------
test('G2.provision-copies-the-local-llm-tree-pins-its-image-and-grants-the-gpu-before-the-start', async t => {
    const w = await provisioned(t);
    const profile = validateProfile(w.run);
    assert.deepEqual(profile.agents.map(agent => agent.role), ['llm']); assert.equal(profile.fixtures.llm.ref, 'local-llms/local-llm');
    const repository = path.join(profile.workspace.path, '.ploinky', 'repos', 'local-llms', 'local-llm');
    // The tree is the frozen one, byte for byte, but for the image reference of its manifest.
    const frozen = path.join(w.source, '.hwl-local-llms', 'local-llm');
    for (const file of ['catalog/models.json', 'tools/vllm_mps_calibration.mjs', 'src/controller/vllmMpsQualification.mjs', 'src/main.mjs']) assert.equal(fs.readFileSync(path.join(repository, file), 'utf8'), fs.readFileSync(path.join(frozen, file), 'utf8'), file);
    const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'manifest.json'), 'utf8'));
    assert.equal(manifest.container, LLM_IMAGE); assert.deepEqual({ ...manifest, container: null }, { ...ORIGINAL_MANIFEST, container: null });
    assert.equal(hash(fs.readFileSync(path.join(repository, 'manifest.json'))), profile.provision.llm.manifest.rewrittenDigest);
    assert.equal(profile.provision.llm.manifest.originalContainer, ORIGINAL_MANIFEST.container);
    assert.equal(exists(path.join(profile.workspace.path, '.ploinky', 'repos', 'hwlfixture')), false, 'no generated fixture repository');
    const order = w.fake.model.calls.filter(call => call.binary === w.node).map(call => call.args);
    const grant = order.findIndex(args => args.includes('gpu')); const start = order.findIndex(args => args.includes('start'));
    assert.ok(grant >= 0 && start > grant, 'gpu grant precedes the first start');
    assert.deepEqual(order[grant], [profile.candidate.path, 'gpu', 'grant', '--agent', 'local-llms/local-llm']);
    assert.deepEqual(order[start], [profile.candidate.path, '--port', '23456', '--udp-port', '34567', 'start', 'local-llms/local-llm']);
    assert.equal(w.artifacts.get('gpu-initial-gate').baseline.uuid, GPU_UUID);
    assert.equal(profile.provision.image, LLM_IMAGE); assert.equal(w.run.images[0].ref, LLM_IMAGE);
});

test('G2.provision-blocks-a-changed-tree-or-manifest-and-an-image-the-agent-was-not-created-from', async t => {
    // The staged source digest is checked first; these are the pins the copy itself re-proves.
    for (const [label, mutate, pattern] of [
        ['a tree digest that is not the staged tree', w => { w.run.target.execution.provision.llm.treeDigest = hash('another tree'); }, /staged local-llm tree differs from the digest pinned/],
        ['an original manifest digest that is not the staged one', w => { w.run.target.execution.provision.llm.manifest.originalDigest = hash('another manifest'); }, /staged local-llm manifest differs from the digest pinned/],
        ['a rewritten manifest digest that is not what the rewrite gives', w => { w.run.target.execution.provision.llm.manifest.rewrittenDigest = hash('another rewrite'); }, /rewritten local-llm manifest differs from the digest pinned/],
        ['an original image other than the staged manifest\'s', w => { w.run.target.execution.provision.llm.manifest.originalContainer = 'docker.io/assistos/local-llm:other'; }, /names another image than the one pinned/],
    ]) {
        const w = llmWorld(t);
        mutate(w);
        const report = await w.provision();
        assert.equal(report.verdict, 'BLOCKED', `${label}: ${JSON.stringify(report.limitations)}`);
        assert.match(report.limitations[0], pattern, label);
        const state = worldState(w.statePath);
        assert.deepEqual([state.startCalls, Object.keys(state.boxes).length], [0, 0], `${label}: nothing was started`);
        assert.equal(w.fake.model.grantCalls.length, 0, label);
        nothingOwned(w);
    }
    // The plan validators refuse inconsistent local-llm provision plans.
    const w = llmWorld(t);
    const plan = w.run.target.execution.provision;
    for (const [label, mutate] of [
        ['another repository', p => { p.repository = 'hwlfixture'; }], ['a GPU grant for another agent', p => { p.gpu.grantAgents = ['hwlfixture/probe']; }],
        ['an agent with generated limits', p => { p.agents[0].hardwareLimits = { memory: '2g', cpus: '1', pidsLimit: 1 }; }], ['a mutable image tag', p => { p.image = 'docker.io/assistos/local-llm:latest'; }],
        ['a tree digest that is not a digest', p => { p.llm.treeDigest = 'sha256:short'; }], ['a CUDA probe in the plan', p => { p.gpu.probe = { sourcePath: '/x', digest: hash('p'), target: 'probe/mpsprobe.py' }; }],
    ]) {
        const run = structuredClone(w.run); mutate(run.target.execution.provision);
        assert.throws(() => validateProfile(run, { partial: true }), undefined, label);
    }
    assert.ok(plan.llm.treeDigest.startsWith('sha256:'));
});

// --- LIVE-L1 ------------------------------------------------------------------------------------
test('G2.L1-passes-budget-cgroup-runner-environment-uid-generation-text-and-digests', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-L1']);
    const l1 = caseOf(report, 'LIVE-L1');
    assert.equal(l1.result, 'pass', JSON.stringify(l1));
    // Only L1 was selected: the block is not PASS until L2 has run too, and cleanup is complete.
    assert.equal(report.verdict, 'BLOCKED'); assert.equal(report.cleanup.state, 'complete'); assert.equal(caseOf(report, 'LIVE-L2').reason, 'Not selected or no completed enforcement evidence');
    const artifact = w.artifacts.get('gpu-live-l1');
    // The budget as Apply applied it: 4 CPUs, 25 % of the envelope, the 50 % share.
    const cap = resolveMemoryPercent(25, 32 * GIB);
    assert.equal(artifact['cgroup:L1']['memory.max'], String(cap)); assert.equal(artifact['cgroup:L1']['cpu.max'], '400000 100000');
    assert.deepEqual(w.fake.model.store.policies['local-llms/local-llm'], { cpus: 4, memoryPercent: 25, gpu: { smPercent: 50, vramPercent: 50 } }, 'the saved budget is the plan\'s 4 CPUs, 25 % RAM and 50 % GPU');
    const saved = toolCalls(w, 'local_llm_run');
    assert.equal(saved.length, 1); assert.deepEqual([saved[0].args.modelId, saved[0].args.runnerId, saved[0].args.replace], [LLM_MODELS.small, 'llama.cpp', false]);
    // The runner's environment is exactly the three MPS variables, and no secret; the user and the generation.
    assert.deepEqual(Object.keys(artifact.runner[0].cuda).sort(), ['CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT', 'CUDA_MPS_PIPE_DIRECTORY']);
    assert.equal(artifact.runner[0].cuda.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT, '0=3072M'); assert.equal(artifact.runner[0].cuda.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE, '50');
    assert.equal(artifact.runner[0].envNames.some(name => /TOKEN|KEY|SECRET/.test(name)), false);
    assert.equal(artifact['agent:L1'].image, LLM_IMAGE); assert.match(artifact['agent:L1'].labels['ploinky.mpsgeneration'], /^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
    // The response and the digests of what ran.
    assert.equal(artifact.response.text, 'Pong.'); assert.equal(artifact.response.modelId, LLM_MODELS.small);
    assert.equal(artifact.digests.model.verified, true); assert.equal(artifact.digests.model.pinned.sha256, SMALL_FILE.sha256);
    assert.match(artifact.digests.runner.sha256, /^[0-9a-f]{64}$/); assert.equal(artifact.digests.image, LLM_IMAGE);
    assert.equal(l1.evidence.playground.mode, 'tool'); assert.match(l1.evidence.playground.reason, /Explorer/);
    // Public admission accepted the model under the budget before the Run, and nothing else was run.
    assert.equal(artifact['overview:after-apply'].preview.admission.status, 'ok');
    assert.equal(artifact['overview:before'].deployment, null);
    // The unrelated host process table is untouched and cleanup is certified.
    assert.equal(w.fake.model.signals.length, 0);
    assert.deepEqual(w.artifacts.get('gpu-final-observation').processes, []);
    assert.deepEqual(w.artifacts.get('llm-cleanup-proof').remaining, []);
    nothingOwned(w);
});

test('G2.L1-fails-on-a-wrong-cap-an-extra-or-missing-cuda-variable-a-leaked-secret-a-root-runner-no-text-or-another-model', async t => {
    const cases = [
        ['a memory.max that is not the saved percentage', { memoryMaxWrong: true }, /memory\.max is/],
        ['a cpu.max that is not 4 CPUs', { cpuMaxWrong: true }, /cpu\.max is/],
        ['an extra CUDA variable in the runner', { runnerExtraCuda: true }, /not exactly the three MPS variables/],
        ['a runner that lost the memory limit', { runnerDropsShare: true }, /not exactly the three MPS variables/],
        ['a secret in the runner environment', { runnerLeaksToken: true }, /secret-looking variables: LOCAL_LLM_CONTROL_TOKEN/],
        ['a runner that runs as root', { runnerRoot: true }, /does not run as one non-root user/],
        ['no text', { emptyText: true }, /returned no text/],
        ['an answer from another model', { wrongModel: true }, /returned no text/],
        ['another model deployed than the pinned one', { deployedOtherModel: true }, /not the pinned model/],
        ['a catalog that differs from the pins', { catalogDrift: true }, /differs from the pins/],
        ['public admission that refuses the budget', { admissionRefusesBudget: true }, /Public admission refuses/],
        ['a model that fails to load', { loadFails: true }, /deployment failed/],
    ];
    for (const [label, faults, pattern] of cases) {
        const w = await provisioned(t, { faults });
        const report = await liveCases(w, ['LIVE-L1']);
        const l1 = caseOf(report, 'LIVE-L1');
        assert.equal(l1.result, 'fail', `${label}: ${JSON.stringify(l1).slice(0, 600)}`); assert.match(l1.reason, pattern, label);
        assert.equal(report.verdict, 'FAIL', label);
        const artifact = w.artifacts.get('gpu-live-l1');
        assert.match(artifact.failure.message, pattern, `${label}: the evidence was written before the assertion`);
        assert.ok(artifact.steps.length > 0, label);
        nothingOwned(w);
    }
});

test('G2.L1-is-blocked-when-the-box-envelope-or-the-data-or-the-route-or-the-gpu-cannot-support-it', async t => {
    const cases = [
        ['an envelope with fewer CPUs than the budget', { envelope: { cpus: 2, memoryBytes: 32 * GIB } }, {}, /fewer than the 4 of the budget/],
        ['an envelope whose 25 % cannot hold the model', { envelope: { cpus: 16, memoryBytes: 8 * GIB } }, {}, /needs at least/],
        ['an unreadable envelope', {}, { envelope: null }, /envelope is not readable/],
        ['the Router route that does not offer the tool', {}, { noAgentRoute: true }, /did not answer through the Router/],
        ['an agent that does not answer', {}, { agentDown: true }, /did not answer/],
        ['an ineligible GPU', {}, { gpuIneligible: true }, /MPS sharing is not eligible/],
        ['a user the share cannot use', {}, { imageUser: 'root' }, /not a non-root numeric UID:GID/],
    ];
    for (const [label, world, faults, pattern] of cases) {
        const w = await provisioned(t, { ...world, faults });
        const report = await liveCases(w, ['LIVE-L1'], { timings: { readyMs: 30 } });
        const l1 = caseOf(report, 'LIVE-L1');
        assert.equal(l1.result, 'blocked', `${label}: ${JSON.stringify(l1).slice(0, 500)}`); assert.match(l1.reason, pattern, label);
        assert.equal(report.verdict, 'BLOCKED', label);
        assert.equal(toolCalls(w, 'local_llm_run').length, 0, `${label}: no Run was attempted`);
        nothingOwned(w);
    }
    // Data that is not fresh: the weights are already there.
    const w = await provisioned(t);
    w.fake.llm.downloaded.small = true;
    const report = await liveCases(w, ['LIVE-L1']);
    assert.equal(caseOf(report, 'LIVE-L1').result, 'blocked'); assert.match(caseOf(report, 'LIVE-L1').reason, /model data is not fresh/);
});

// --- LIVE-L1 measurements while the model generates -------------------------------------------------------
test('G2.L1-measures-cpu-memory-and-gpu-while-the-request-generates-and-records-the-evidence-first', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-L1']);
    const l1 = caseOf(report, 'LIVE-L1');
    assert.equal(l1.result, 'pass', JSON.stringify(l1).slice(0, 800));
    const inference = w.artifacts.get('gpu-live-l1').inference;
    // Sampling began before the request was sent, continued while it generated, and ended after the response.
    assert.deepEqual([inference.cgroupSamples[0].label, inference.cgroupSamples.at(-1).label], ['before-send', 'after-response']);
    assert.ok(inference.samples.inFlightCgroup >= 2, JSON.stringify(inference.samples)); assert.ok(inference.samples.inFlightGpu >= 1, JSON.stringify(inference.samples));
    assert.equal(inference.gpuSamples[0].label, 'before-send'); assert.equal(inference.gpuSamples.at(-1).label, 'after-response');
    const send = w.fake.llm.toolLog.findIndex(entry => entry.name === 'local_llm_test_prompt');
    assert.ok(send >= 0 && w.fake.llm.samples.slice(0, w.fake.llm.samples.length).some(entry => entry.generating), 'a sample saw the model generating');
    assert.equal(w.fake.llm.samples.filter(entry => entry.generating).length, inference.samples.inFlightCgroup, 'every in-flight sample was taken while the request ran');
    // CPU: usage over the window below the 4-CPU quota, throttling recorded; memory: the peak under memory.max, no swap, no kill.
    assert.equal(inference.cpu.cpus, 4); assert.ok(inference.cpu.windowUs > 0 && inference.cpu.usageUsec > 0 && inference.cpu.usageUsec <= inference.cpu.allowedUsec, JSON.stringify(inference.cpu));
    assert.ok(inference.cpu.averageCpus < 4 && inference.cpu.peakIntervalCpus > 0, JSON.stringify(inference.cpu)); assert.equal(inference.cpu.nrThrottled, 0);
    const cap = resolveMemoryPercent(25, 32 * GIB);
    assert.equal(inference.memory.capBytes, cap); assert.ok(inference.memory.peakBytes > 0 && inference.memory.peakBytes <= cap); assert.equal(inference.memory.swapMaxSeenBytes, 0); assert.equal(inference.memory.oomKillDelta, 0);
    // GPU: the runner's own rows by its verified host PID, below the pinned limit, with the utilisation seen mid-generation.
    assert.equal(inference.gpuSamples.length >= 3, true); assert.equal(inference.runner.length, 1); assert.ok(inference.runner[0].hostPid > 0 && inference.runner[0].startIdentity);
    assert.equal(inference.gpuSamples.some(sample => sample.runnerListed === 1), true); assert.equal(inference.gpu.basis, 'runner-pid'); assert.equal(inference.gpu.utilizationMaxPercent, 45);
    assert.deepEqual([inference.violations, inference.blockers], [[], []]);
    assert.equal(w.fake.model.signals.length, 0); nothingOwned(w);
});

test('G2.L1-fails-when-the-cpu-use-exceeds-the-quota-memory-exceeds-the-cap-swap-is-used-the-kernel-kills-or-the-gpu-memory-exceeds-the-share', async t => {
    const cases = [
        ['CPU use above the 4-CPU quota during the inference', { cpuOverQuota: true }, /CPU use (?:over the inference window|between two samples) was/],
        ['a memory peak above memory.max', { memoryOverCap: true }, /memory peak \d+ exceeded memory\.max/],
        ['swap in use', { swapSeen: true }, /used \d+ bytes of swap/],
        ['an OOM kill during the inference', { oomKilled: true }, /OOM kill/],
        ['runner device memory above the share\'s pinned limit', { gpuOverShare: true }, /The runner held 3600 MiB of device memory, above the share's pinned limit 3072 MiB/],
        ['an owned MPS server holding more than the share when the driver lists only it', { gpuOverShare: true, mpsServerOnly: true }, /The owned GPU processes held 3720 MiB/],
    ];
    for (const [label, faults, pattern] of cases) {
        const w = await provisioned(t, { faults });
        const report = await liveCases(w, ['LIVE-L1']);
        const l1 = caseOf(report, 'LIVE-L1');
        assert.equal(l1.result, 'fail', `${label}: ${JSON.stringify(l1).slice(0, 500)}`); assert.match(l1.reason, pattern, label);
        assert.equal(report.verdict, 'FAIL', label);
        // The evidence was written before the verdict, and names the breach.
        const inference = w.artifacts.get('gpu-live-l1').inference;
        assert.ok(inference.violations.some(entry => pattern.test(entry)), `${label}: ${JSON.stringify(inference.violations)}`);
        assert.ok(inference.samples.inFlightCgroup >= 1 && inference.samples.inFlightGpu >= 1, label);
        assert.ok(w.artifacts.get('gpu-live-l1').response.text, `${label}: the response was recorded too`);
        assert.equal(w.fake.model.signals.length, 0, label); nothingOwned(w);
    }
});

test('G2.L1-passes-when-the-driver-lists-only-the-owned-mps-server-and-without-memory-peak-and-records-which-basis-it-used', async t => {
    for (const [label, faults, basis] of [['only the server is listed', { mpsServerOnly: true }, 'owned-mps-server'], ['no memory.peak file', { noMemoryPeak: true }, 'runner-pid']]) {
        const w = await provisioned(t, { faults });
        const l1 = caseOf(await liveCases(w, ['LIVE-L1']), 'LIVE-L1');
        assert.equal(l1.result, 'pass', `${label}: ${JSON.stringify(l1).slice(0, 500)}`);
        const inference = w.artifacts.get('gpu-live-l1').inference;
        assert.equal(inference.gpu.basis, basis, label); assert.equal(inference.memory.peakFromMemoryPeak, !faults.noMemoryPeak, label);
        nothingOwned(w);
    }
});

test('G2.L1-is-blocked-and-cleans-up-when-a-foreign-gpu-process-appears-while-the-model-generates', async t => {
    const w = await provisioned(t, { faults: { foreignDuringPrompt: true } });
    const report = await liveCases(w, ['LIVE-L1']);
    const l1 = caseOf(report, 'LIVE-L1');
    assert.equal(l1.result, 'blocked', JSON.stringify(l1).slice(0, 500)); assert.match(l1.reason, /GPU idle gate blocked: (?:gpu_busy|foreign_process_appeared)/);
    assert.equal(report.verdict, 'BLOCKED');
    const artifact = w.artifacts.get('gpu-live-l1');
    assert.match(artifact.inference.failure, /GPU idle gate blocked/); assert.ok(artifact.inference.samples.inFlightCgroup >= 1, 'what was measured before the abort is the evidence');
    assert.equal(artifact.response, undefined, 'no response is accepted after the gate tripped');
    assert.equal(report.cleanup.state, 'complete'); assert.equal(w.fake.model.signals.length, 0, 'the foreign process is never signalled'); nothingOwned(w);
});

test('G2.the-inference-analysis-fails-each-budget-breach-blocks-each-missing-measurement-and-allows-only-its-documented-tolerance', () => {
    const SHARE = 3072; const CAP = 8 * GIB;
    const leaf = (atUs, usageUsec, extra = {}) => ({ label: 'in-flight', atUs, usageUsec, nrPeriods: 1, nrThrottled: 0, throttledUsec: 0, cpuMax: '400000 100000', memoryMax: String(CAP), swapMax: '0', memoryCurrent: GIB, memoryPeak: GIB, swapCurrent: 0, oom: 0, oomKill: 0, memoryHigh: 0, memoryMaxEvents: 0, ...extra });
    const gpuSample = (extra = {}) => ({ label: 'in-flight', usedMiB: 700, utilizationPercent: 40, rows: [], runnerMiB: 600, ownedMiB: 900, runnerListed: 1, ownedListed: 2, ...extra });
    const analyze = (cgroup, gpu = [gpuSample(), gpuSample()], extra = {}) => analyzeInference({ cgroup, gpu, cpus: 4, memoryCapBytes: CAP, shareMiB: SHARE, ...extra });
    const healthy = [leaf(0, 0), leaf(1_000_000, 2_000_000), leaf(2_000_000, 4_000_000)];
    const base = analyze(healthy);
    assert.deepEqual([base.violations, base.blockers], [[], []]); assert.equal(base.summary.cpu.averageCpus, 2); assert.equal(base.summary.cpu.usageUsec, 4_000_000);
    // CPU: exactly the quota passes; the 10 % ratio plus one period of slack is the whole tolerance.
    const allowance = Math.floor(4 * 2_000_000 * (1 + INFERENCE_TOLERANCE.cpuRatio) + 4 * 100000 * INFERENCE_TOLERANCE.cpuPeriodsOfSlack);
    assert.deepEqual(analyze([leaf(0, 0), leaf(2_000_000, allowance)]).violations, []);
    assert.match(analyze([leaf(0, 0), leaf(2_000_000, allowance + 1)]).violations.join(), /CPU use over the inference window was/);
    assert.match(analyze([leaf(0, 0), leaf(1_000_000, 100_000), leaf(2_000_000, 100_000 + 6_000_000)]).violations.join(), /between two samples/, 'a burst between two samples is caught even when the window average is low');
    assert.match(analyze([leaf(0, 100), leaf(1_000_000, 50)]).violations.join(), /does not advance sensibly/);
    assert.match(analyze([leaf(0, 0), leaf(1_000_000, 10, { cpuMax: '800000 100000' })]).violations.join(), /cpu\.max is 800000 100000, not 4 CPUs/);
    assert.deepEqual(analyze([leaf(0, 0), leaf(1_000_000, 10, { cpuMax: '399999 100000' })]).violations, [], 'the engine\'s truncated quota (N-1) is the same quota');
    // Memory: the peak is the larger of memory.peak and every memory.current.
    assert.match(analyze([leaf(0, 0), leaf(1_000_000, 10, { memoryPeak: CAP + 1 })]).violations.join(), /memory peak \d+ exceeded/);
    assert.match(analyze([leaf(0, 0), leaf(1_000_000, 10, { memoryCurrent: CAP + 1, memoryPeak: null })]).violations.join(), /memory peak \d+ exceeded/);
    assert.deepEqual(analyze([leaf(0, 0), leaf(1_000_000, 10, { memoryCurrent: CAP, memoryPeak: CAP })]).violations, []);
    assert.match(analyze([leaf(0, 0), leaf(1_000_000, 10, { swapCurrent: 4096 })]).violations.join(), /4096 bytes of swap/);
    assert.match(analyze([leaf(0, 0), leaf(1_000_000, 10, { oomKill: 1 })]).violations.join(), /OOM kill/);
    assert.match(analyze([leaf(0, 0, { oomKill: 2 }), leaf(1_000_000, 10, { oomKill: 2 })]).violations.join(), /OOM kill/, 'a non-zero count at the end is a kill');
    assert.match(analyze([leaf(0, 0), leaf(1_000_000, 10, { memoryMax: String(CAP - 1) })]).violations.join(), /memory\.max is/);
    // GPU: the runner's rows, else the owned server's, against the pinned limit plus the context allowance.
    const limit = SHARE + INFERENCE_TOLERANCE.gpuContextMiB;
    assert.deepEqual(analyze(healthy, [gpuSample({ runnerMiB: limit }), gpuSample()]).violations, []);
    assert.match(analyze(healthy, [gpuSample({ runnerMiB: limit + 1 })]).violations.join(), /runner held 3329 MiB/);
    assert.match(analyze(healthy, [gpuSample({ runnerMiB: null, ownedMiB: limit + 1 })]).violations.join(), /owned GPU processes held 3329 MiB/);
    const serverOnly = analyze(healthy, [gpuSample({ runnerMiB: null, runnerListed: 0, ownedMiB: 800 })]);
    assert.deepEqual([serverOnly.violations, serverOnly.summary.gpu.basis], [[], 'owned-mps-server']);
    assert.equal(analyze(healthy, [gpuSample({ utilizationPercent: 70 }), gpuSample({ utilizationPercent: null })]).summary.gpu.utilizationMaxPercent, 70);
    // What cannot be measured is a blocker, never a pass.
    assert.match(analyze(healthy, [gpuSample({ runnerMiB: null, ownedMiB: null, runnerListed: 0, ownedListed: 0 })]).blockers.join(), /No process row of the runner or of the owned MPS server/);
    assert.match(analyze(healthy, []).blockers.join(), /No process row/);
    assert.match(analyze([leaf(0, 0)]).blockers.join(), /cgroup samples around the inference are missing/);
    assert.match(analyze([leaf(null, 0), leaf(1, 1)]).blockers.join(), /missing or unreadable/);
    assert.match(analyze([leaf(0, 0), leaf(1_000_000, 10, { swapCurrent: null })]).blockers.join(), /memory\.swap\.current/);
    assert.match(analyze([leaf(0, 0), leaf(1_000_000, 10, { memoryCurrent: null })]).blockers.join(), /memory\.current/);
    // The parsers: the leaf program's raw reply and the gate's check.
    const parsed = parseLeafSample({ atNs: '5000000000', 'cpu.stat': 'usage_usec 70\nuser_usec 60\nnr_periods 5\nnr_throttled 2\nthrottled_usec 900\n', 'cpu.max': '400000 100000\n', 'memory.max': '1000\n', 'memory.swap.max': '0\n', 'memory.current': '12\n', 'memory.swap.current': '0\n', 'memory.peak': null, 'memory.events': 'low 0\nhigh 1\nmax 3\noom 0\noom_kill 0\n' });
    assert.deepEqual([parsed.atUs, parsed.usageUsec, parsed.nrThrottled, parsed.throttledUsec, parsed.memoryCurrent, parsed.memoryPeak, parsed.memoryMax, parsed.memoryHigh, parsed.memoryMaxEvents, parsed.oomKill], [5_000_000, 70, 2, 900, 12, null, '1000', 1, 3, 0]);
    const summary = summarizeGpuCheck('x', { inventory: { details: [{ pid: 10, type: 'C', memoryMiB: 600 }, { pid: 11, type: 'M+C', memoryMiB: 300 }, { pid: 12, type: 'G', memoryMiB: 2 }] }, memory: { usedMiB: 913 }, utilization: 33, owned: [10, 11] }, [10]);
    assert.deepEqual([summary.runnerMiB, summary.ownedMiB, summary.runnerListed, summary.ownedListed, summary.utilizationPercent], [600, 900, 1, 2, 33]);
    assert.equal(summarizeGpuCheck('x', { inventory: { details: [{ pid: 10, type: 'C', memoryMiB: null }] }, memory: {}, owned: [10] }, [10]).runnerMiB, null, 'a row without memory is not a measurement');
});

test('G2.the-leaf-sample-program-reads-only-the-agent-leaf-files-and-refuses-another-path', async t => {
    assert.doesNotThrow(() => new vm.Script(`(async()=>{${LLM_LEAF_SAMPLE}})`));
    const root = scratch(t);
    const leaf = path.join(root, 'leaf'); fs.mkdirSync(leaf);
    const files = { 'cpu.stat': 'usage_usec 5\nnr_throttled 1\nthrottled_usec 2\n', 'cpu.max': '400000 100000\n', 'memory.max': '1024\n', 'memory.swap.max': '0\n', 'memory.current': '7\n', 'memory.swap.current': '0\n', 'memory.events': 'oom 0\noom_kill 0\n' };
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(leaf, name), text);
    // The program only accepts a canonical path under /sys/fs/cgroup/ploinky/agents; the test stands in the directory for it.
    const program = LLM_LEAF_SAMPLE.replace('/^\\/sys\\/fs\\/cgroup\\/ploinky\\/agents\\/[A-Za-z0-9_.-]+$/', '/^.*$/');
    const run = await runProgram(program, [leaf], {});
    assert.equal(run.status, 0, run.stderr);
    const raw = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(raw).sort(), ['atNs', 'cpu.max', 'cpu.stat', 'memory.current', 'memory.events', 'memory.max', 'memory.peak', 'memory.swap.current', 'memory.swap.max']);
    assert.equal(raw['memory.peak'], null, 'an absent memory.peak is null');
    assert.deepEqual([parseLeafSample(raw).usageUsec, parseLeafSample(raw).memoryCurrent, parseLeafSample(raw).nrThrottled], [5, 7, 1]);
    const refused = await runProgram(LLM_LEAF_SAMPLE, [leaf], {});
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Noncanonical leaf/);
    const traversal = await runProgram(LLM_LEAF_SAMPLE, ['/sys/fs/cgroup/ploinky/agents/../../x'], {});
    assert.notEqual(traversal.status, 0);
});

// --- LIVE-L2 ------------------------------------------------------------------------------------
test('G2.L2-stops-saves-an-insufficient-budget-applies-verifies-the-cap-and-sees-the-run-refused-before-launch', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-L1', 'LIVE-L2']);
    assert.deepEqual(report.cases.map(entry => [entry.id, entry.result]), [['LIVE-L1', 'pass'], ['LIVE-L2', 'pass']], JSON.stringify(report.limitations));
    const artifact = w.artifacts.get('gpu-live-l2');
    const planned = insufficientMemoryPercent(32 * GIB);
    assert.deepEqual([planned.percent, planned.capBytes], [3, resolveMemoryPercent(3, 32 * GIB)]); assert.ok(planned.capBytes < 1.75 * GIB);
    assert.equal(artifact['cgroup:L2']['memory.max'], String(planned.capBytes));
    assert.notEqual(artifact.replacement.id, artifact.replaced.id, 'Apply replaced the instance that ran the model');
    assert.equal(artifact.refusal.accepted, false); assert.match(artifact.refusal.error.code, /^admission_(?:incompatible|insufficient_now)$/); assert.match(artifact.refusal.error.message, /\bRAM\b/);
    assert.equal(artifact.afterRefusal.runnerProcesses, 0); assert.ok(['idle', undefined].includes(artifact.afterRefusal.phase));
    // The order: the model was stopped, the budget saved and applied, and only then a new Run was attempted (and refused).
    const log = w.fake.llm.toolLog.map(entry => entry.name);
    const stop = log.lastIndexOf('local_llm_stop'); const runs = log.map((name, index) => (name === 'local_llm_run' ? index : -1)).filter(index => index >= 0);
    assert.ok(stop > runs[0], 'the first Run (L1) came first, then the stop'); assert.equal(runs.length, 2); assert.ok(runs[1] > stop, 'the second Run followed the stop');
    const applies = w.fake.model.applyCalls.length;
    assert.ok(applies >= 2, 'Apply ran for L1 and again for the insufficient budget');
    assert.deepEqual(w.fake.llm.refusals, [{ modelId: LLM_MODELS.small, runnerId: 'llama.cpp', status: 'insufficient-now' }]);
    assert.equal(w.fake.llm.runner, null, 'no runner exists after the refusal');
    nothingOwned(w);
});

test('G2.L2-fails-when-the-run-is-accepted-launches-before-refusing-the-cap-is-wrong-or-the-reason-is-not-the-budget', async t => {
    for (const [label, faults, pattern] of [
        ['a Run accepted although the budget cannot hold the model', { runAcceptedAnyway: true }, /accepted although the saved RAM budget/],
        ['a cap that is not the saved one', { memoryMaxWrong: true }, /memory\.max is/],
        ['a refusal that is not about RAM', { refusalAsPlainText: true, admissionRefusesBudget: true }, /not an admission refusal|does not give the RAM budget/],
    ]) {
        const w = await provisioned(t, { faults });
        const report = await liveCases(w, ['LIVE-L2']);
        const l2 = caseOf(report, 'LIVE-L2');
        assert.equal(l2.result, 'fail', `${label}: ${JSON.stringify(l2).slice(0, 500)}`); assert.match(l2.reason, pattern, label);
        // An accepted Run is stopped at once so nothing keeps running.
        if (faults.runAcceptedAnyway) assert.ok(w.fake.llm.stops >= 1, 'the unsafe run was stopped');
        nothingOwned(w);
    }
});

test('G2.L2-is-blocked-without-a-viable-insufficient-percentage-and-never-tests-the-old-model-or-an-unapplied-setting', async t => {
    // No whole percentage of a 256 GiB envelope is a cap between 640 MiB and 1280 MiB.
    const huge = await provisioned(t, { envelope: { cpus: 16, memoryBytes: 256 * GIB } });
    const blockedReport = await liveCases(huge, ['LIVE-L2']);
    assert.equal(caseOf(blockedReport, 'LIVE-L2').result, 'blocked'); assert.match(caseOf(blockedReport, 'LIVE-L2').reason, /known-insufficient budget cannot be saved/);
    assert.equal(toolCalls(huge, 'local_llm_run').length, 0);
    // L2 alone: no model is running, and the single Run it attempts follows the Apply that replaced the agent.
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-L2']);
    assert.equal(caseOf(report, 'LIVE-L2').result, 'pass', JSON.stringify(report.limitations));
    const log = w.fake.llm.toolLog.map(entry => entry.name);
    assert.equal(log.includes('local_llm_stop'), false, 'there was no model to stop');
    assert.equal(w.fake.model.applyCalls.length, 1);
    const calls = w.fake.model.calls.filter(call => call.args.includes('-e')).map(call => (call.args.includes(LLM_TOOL_CALL) ? `tool:${call.args[call.args.indexOf(LLM_TOOL_CALL) + 1]}` : call.args[call.args.indexOf('-e') + 1].includes('"apply"') ? 'admin' : 'other'));
    assert.ok(calls.lastIndexOf('tool:local_llm_run') > -1);
    // The numbers: the cap is below admission's need plus margin, above what the controller needs.
    for (const gibs of [8, 16, 31, 32, 64, 96, 128]) {
        const found = insufficientMemoryPercent(gibs * GIB);
        if (gibs === 128) { assert.equal(found, null, '1 % of 128 GiB is 1.28 GiB, still within range'); continue; }
        assert.ok(found && found.capBytes >= INSUFFICIENT_RAM.minCapBytes && found.capBytes <= INSUFFICIENT_RAM.maxCapBytes, `${gibs} GiB: ${JSON.stringify(found)}`);
        assert.ok(found.capBytes < 1.75 * GIB, 'below admission\'s need plus margin');
    }
});

// --- LIVE-L3 ------------------------------------------------------------------------------------
test('G2.vllm-step-zero-blocks-with-the-exact-prerequisite-and-never-passes', async t => {
    for (const [label, faults, pattern] of [
        ['no vLLM entry in the pinned image\'s lock', { vllmNoEntry: true }, /vllm_entry_missing: The image's runner lock has no vLLM entry/],
        ['too little disk', { vllmDiskShort: true }, /insufficient_disk: Not enough free disk/],
        ['a driver older than the CUDA wheels need', { vllmDriverOld: true }, /driver_too_old/],
    ]) {
        for (const stage of ['calibration', 'qualified']) {
            const vllm = stage === 'calibration' ? null : { stage, calibration: { evidenceDigest: hex('evidence'), tuple: { runnerLockDigest: VLLM_PINS.runnerLockDigest, driverVersion: '595.91.07', gpuPciDeviceId: '0x252010DE', computeCapability: '8.6', deviceTotalBytes: 6144 * MIB }, expectQualified: true } };
            const w = await provisioned(t, { block: 'apparatus-vllm', faults, vllm, qualified: true });
            const report = await liveCases(w, ['LIVE-L3']);
            const l3 = caseOf(report, 'LIVE-L3');
            assert.equal(l3.result, 'blocked', `${label}/${stage}: ${JSON.stringify(l3).slice(0, 500)}`); assert.match(l3.reason, /LIVE-L3 step 0: vLLM cannot be installed from the pinned image on this host/); assert.match(l3.reason, pattern, label);
            assert.equal(report.verdict, 'BLOCKED');
            // Nothing was applied, installed or launched.
            assert.equal(w.fake.model.applyCalls.length, 0, `${label}: no Apply`);
            assert.deepEqual(['local_llm_runner_install', 'local_llm_run', 'local_llm_test_prompt'].map(name => toolCalls(w, name).length), [0, 0, 0], label);
            assert.equal(w.artifacts.get('gpu-live-l3').prerequisites.ok, false);
            nothingOwned(w);
        }
    }
    // Pins that differ from the image's lock entry are a failure of the pin, never an install.
    const w = await provisioned(t, { block: 'apparatus-vllm', faults: { vllmWrongPins: true } });
    const report = await liveCases(w, ['LIVE-L3']);
    assert.equal(caseOf(report, 'LIVE-L3').result, 'fail'); assert.match(caseOf(report, 'LIVE-L3').reason, /differs from the pinned lock entry/);
    assert.equal(toolCalls(w, 'local_llm_runner_install').length, 0);
});

test('G2.vllm-install-failure-pause-refusal-or-timeout-is-blocked-with-the-progress-and-never-passes', async t => {
    for (const [label, faults, pattern, timings] of [
        ['a failed install', { installError: true }, /vLLM install failed on this host: Installing vllm failed/, {}],
        ['a paused install', { installPaused: true }, /vLLM install paused: Not enough free disk/, {}],
        ['an install the product refuses', { installRefused: true }, /runner install refused vLLM \(runner_unavailable\)/, {}],
        ['an install that does not finish in time', { installStalls: true }, /did not finish within 50 ms/, { installDeadline: 50 }],
    ]) {
        const w = await provisioned(t, { block: 'apparatus-vllm', faults });
        if (timings.installDeadline) w.run.deadlines.installMs = timings.installDeadline;
        const report = await liveCases(w, ['LIVE-L3'], { timings: { installPollMs: 5 } });
        const l3 = caseOf(report, 'LIVE-L3');
        assert.equal(l3.result, 'blocked', `${label}: ${JSON.stringify(l3).slice(0, 500)}`); assert.match(l3.reason, pattern, label);
        assert.equal(toolCalls(w, 'local_llm_run').length, 0, label);
        assert.ok(stepNames(w, 'live-l3').some(name => name === 'install') || faults.installRefused, `${label}: the install progress is evidence`);
        nothingOwned(w);
    }
});

test('G2.vllm-stage-one-calibrates-without-a-model-computes-the-tuple-and-proposes-the-reviewed-entry', async t => {
    const w = await provisioned(t, { block: 'apparatus-vllm' });
    const report = await liveCases(w, ['LIVE-L3']);
    const l3 = caseOf(report, 'LIVE-L3');
    assert.equal(l3.result, 'pass', JSON.stringify(l3).slice(0, 800)); assert.equal(report.verdict, 'PASS');
    // Order: the prerequisite check, the share, the install, the calibration; no model was launched.
    assert.deepEqual(w.fake.llm.vllmCalls.map(call => call.command), ['prerequisites', 'calibrate']);
    assert.deepEqual(w.fake.llm.vllmCalls[0].pins, VLLM_PINS);
    assert.equal(w.fake.llm.vllmCalls[1].hostNvmlBytes, 6144 * MIB, 'the host NVML total is passed for the comparison');
    assert.deepEqual(['local_llm_run', 'local_llm_test_prompt', 'local_llm_stop'].map(name => toolCalls(w, name).length), [0, 0, 0]);
    assert.equal(toolCalls(w, 'local_llm_runner_install').length, 1);
    assert.deepEqual(toolCalls(w, 'local_llm_runner_install')[0].args, { runnerId: 'vllm', acceptLicence: false });
    const artifact = w.artifacts.get('gpu-live-l3');
    const saved = w.artifacts.get('llm-l3-calibration');
    assert.equal(artifact.stage, 'calibration'); assert.equal(artifact.prerequisites.ok, true);
    assert.equal(saved.evidence.evidenceDigest, l3.evidence.evidenceDigest ?? saved.evidence.evidenceDigest);
    assert.equal(artifact.proposedEntry.entry.evidenceDigest, saved.evidence.evidenceDigest);
    assert.deepEqual(Object.keys(artifact.proposedEntry.entry), ['runnerLockDigest', 'driverVersion', 'gpuPciDeviceId', 'computeCapability', 'deviceTotalBytes', 'denominator', 'evidenceDigest']);
    assert.equal(artifact.proposedEntry.entry.runnerLockDigest, VLLM_PINS.runnerLockDigest); assert.equal(artifact.proposedEntry.entry.denominator, 'physical-device');
    assert.equal(artifact.calibration.verdict.qualifiable, true);
    // Stage 1 modifies no source: the staged candidate is exactly the approved one.
    assert.equal(liveSourceDigest(w.run.target.execution.source.root.startsWith(w.remoteRoot) ? path.join(w.remoteRoot, 'source') : w.source), w.run.target.execution.source.digest);
    assert.equal(l3.evidence.stage, 'calibration'); assert.equal(l3.evidence.denominator, 'physical-device');
    // The share and the install ran in the replacement instance, with the share applied at its documented size.
    assert.deepEqual(w.fake.model.store.policies['local-llms/local-llm'] ?? { gpu: VLLM_SHARE }, { gpu: VLLM_SHARE });
    nothingOwned(w);
});

test('G2.vllm-stage-one-is-blocked-for-a-share-denominator-an-unsupported-device-or-an-unusable-proposal', async t => {
    for (const [label, faults, pattern] of [
        ['a denominator that follows the share', { denominator: 'share' }, /denominator the installed vLLM sees under MPS is share/],
        ['a device the wheel does not support', { archUnsupported: true }, /archSupported failed/],
        ['a calibration that cannot run', { calibrateBlocked: true }, /the calibration could not run: vllm_not_installed/],
    ]) {
        const w = await provisioned(t, { block: 'apparatus-vllm', faults });
        const report = await liveCases(w, ['LIVE-L3']);
        const l3 = caseOf(report, 'LIVE-L3');
        assert.equal(l3.result, 'blocked', `${label}: ${JSON.stringify(l3).slice(0, 500)}`); assert.match(l3.reason, pattern, label);
        assert.equal(w.artifacts.get('gpu-live-l3').proposedEntry ?? null, null, `${label}: no entry is proposed`);
        nothingOwned(w);
    }
    for (const [label, faults, pattern] of [
        ['no proposal for a qualifiable result', { noProposal: true }, /proposed no reviewed entry/],
        ['a proposal for other evidence', { proposalWrongDigest: true }, /proposed no reviewed entry/],
    ]) {
        const w = await provisioned(t, { block: 'apparatus-vllm', faults });
        const l3 = caseOf(await liveCases(w, ['LIVE-L3']), 'LIVE-L3');
        assert.equal(l3.result, 'fail', label); assert.match(l3.reason, pattern, label);
    }
});

const stageTwo = (expectQualified, tuple = { runnerLockDigest: VLLM_PINS.runnerLockDigest, driverVersion: '595.91.07', gpuPciDeviceId: '0x252010DE', computeCapability: '8.6', deviceTotalBytes: 6144 * MIB }) => ({ stage: 'qualified', calibration: { evidenceDigest: hex('stage one evidence'), tuple, expectQualified } });

test('G2.vllm-stage-two-observes-vllm_mps_unqualified-before-the-data-entry-and-reports-it-blocked', async t => {
    const w = await provisioned(t, { block: 'apparatus-vllm', vllm: stageTwo(false), qualified: false });
    const report = await liveCases(w, ['LIVE-L3']);
    const l3 = caseOf(report, 'LIVE-L3');
    assert.equal(l3.result, 'blocked', JSON.stringify(l3).slice(0, 500)); assert.equal(report.verdict, 'BLOCKED');
    assert.match(l3.reason, /vllm_mps_unqualified was observed before the qualification data entry/); assert.match(l3.reason, /correct behaviour/);
    const artifact = w.artifacts.get('gpu-live-l3');
    assert.equal(artifact.publicAdmission.reasonCode, 'vllm_mps_unqualified');
    assert.deepEqual([artifact.refusalObserved.refused, artifact.refusalObserved.runnerProcesses, artifact.refusalObserved.error.details.admission.reasonCode], [true, 0, 'vllm_mps_unqualified']);
    assert.equal(w.fake.llm.runner, null); assert.equal(toolCalls(w, 'local_llm_test_prompt').length, 0);
    assert.equal(report.cleanup.state, 'complete'); nothingOwned(w);
});

test('G2.vllm-stage-two-qualified-after-the-data-entry-starts-the-model-through-public-admission-and-gets-text', async t => {
    const w = await provisioned(t, { block: 'apparatus-vllm', vllm: stageTwo(true), qualified: true });
    const report = await liveCases(w, ['LIVE-L3']);
    const l3 = caseOf(report, 'LIVE-L3');
    assert.equal(l3.result, 'pass', JSON.stringify(l3).slice(0, 800)); assert.equal(report.verdict, 'PASS');
    const artifact = w.artifacts.get('gpu-live-l3');
    assert.equal(artifact.publicAdmission.status, 'ok'); assert.equal(artifact.publicAdmission.estimate.gpuMemoryUtilization, 0.81);
    const runs = toolCalls(w, 'local_llm_run'); assert.equal(runs.length, 1); assert.deepEqual([runs[0].args.modelId, runs[0].args.runnerId], [LLM_MODELS.awq, 'vllm']);
    assert.equal(artifact.response.text, 'Pong.');
    assert.deepEqual(Object.keys(artifact.runner[0].cuda).sort(), ['CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT', 'CUDA_MPS_PIPE_DIRECTORY']);
    assert.equal(artifact.runner[0].cuda.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT, '0=5529M');
    // Bounded share evidence, and the model, runner and qualification digests.
    assert.equal(artifact.shareEvidence.shareMiB, 5529); assert.ok(artifact.shareEvidence.peakUsedMiB - artifact.shareEvidence.baselineUsedMiB <= 5529 + 256, JSON.stringify(artifact.shareEvidence));
    assert.equal(artifact.digests.model.pinned.size, AWQ_FILES.reduce((sum, file) => sum + file.size, 0)); assert.equal(artifact.digests.model.controller.commit, AWQ_COMMIT);
    assert.equal(artifact.digests.runner.runnerLockDigest, VLLM_PINS.runnerLockDigest); assert.equal(artifact.digests.qualification.evidenceDigest, hex('stage one evidence'));
    assert.equal(artifact.digests.runner.install.version, '0.30.0');
    nothingOwned(w);
    assert.deepEqual(w.artifacts.get('llm-cleanup-proof').remaining, []);
});

test('G2.vllm-stage-two-fails-when-admitted-without-an-entry-refused-with-one-without-text-over-the-share-or-blocks-for-an-unfit-share', async t => {
    for (const [label, options, pattern, result] of [
        ['admitted although the candidate holds no entry', { vllm: stageTwo(false), qualified: true }, /admitted although the candidate holds no matching reviewed qualification entry/, 'fail'],
        ['refused although the candidate holds the entry', { vllm: stageTwo(true), qualified: false }, /yet production refuses it as vllm_mps_unqualified/, 'fail'],
        ['no text', { vllm: stageTwo(true), qualified: true, faults: { emptyText: true } }, /returned no text/, 'fail'],
        ['a device that held more than the share', { vllm: stageTwo(true), qualified: true, faults: { vllmOverShare: true } }, /while the share is 5529 MiB/, 'fail'],
        ['a model that fails to load', { vllm: stageTwo(true), qualified: true, faults: { loadFails: true } }, /deployment failed/, 'fail'],
        ['a runner environment with another CUDA variable', { vllm: stageTwo(true), qualified: true, faults: { runnerExtraCuda: true } }, /not exactly the three MPS variables/, 'fail'],
    ]) {
        const w = await provisioned(t, { block: 'apparatus-vllm', ...options });
        const l3 = caseOf(await liveCases(w, ['LIVE-L3']), 'LIVE-L3');
        assert.equal(l3.result, result, `${label}: ${JSON.stringify(l3).slice(0, 500)}`); assert.match(l3.reason, pattern, label);
        nothingOwned(w);
    }
    // A share admission does not fit is BLOCKED with admission's own reason: the documented share is insufficient.
    const w = await provisioned(t, { block: 'apparatus-vllm', vllm: stageTwo(true), qualified: true, faults: { admissionNoFit: true } });
    const l3 = caseOf(await liveCases(w, ['LIVE-L3']), 'LIVE-L3');
    assert.equal(l3.result, 'blocked', JSON.stringify(l3).slice(0, 500)); assert.match(l3.reason, /does not admit qwen3-4b-awq at the 90% share \(incompatible: Needs about 4\.4 GiB/);
    assert.equal(toolCalls(w, 'local_llm_run').length, 0); nothingOwned(w);
});

// --- The idle gate (amendment A5) and the cleanup of model data --------------------------------------
test('G2.the-gate-tolerates-one-recorded-display-process-for-every-local-llm-block-and-blocks-the-rest', async t => {
    for (const block of ['apparatus-local-llm', 'apparatus-vllm']) {
        const w = llmWorld(t, { block, display: 2899 });
        const report = await w.provision();
        assert.equal(report.verdict, 'PASS', `${block}: ${JSON.stringify(report.limitations)}`);
        assert.deepEqual(w.run.toleratedProcesses.map(entry => [entry.hostPid, entry.type, entry.memoryMiB]), [[2899, 'G', 2]], block);
        assert.deepEqual(w.artifacts.get('gpu-initial-gate').tolerated, w.run.toleratedProcesses);
    }
    // L1 runs beside the recorded process and records it in every check; nothing signals it.
    const w = await provisioned(t, { display: 2899 });
    const live = await liveCases(w, ['LIVE-L1', 'LIVE-L2']);
    assert.deepEqual(live.cases.map(entry => entry.result), ['pass', 'pass'], JSON.stringify(live.limitations));
    assert.ok(w.artifacts.get('gpu-live-l1').gate.last.tolerated.includes(2899)); assert.equal(w.fake.model.signals.length, 0);
    assert.ok(w.fake.hostProc.observe(2899), 'the display process was never touched');
    // A second graphics process, a compute process or a process that gained compute blocks, for both blocks.
    for (const block of ['apparatus-local-llm', 'apparatus-vllm']) {
        const second = llmWorld(t, { block });
        second.fake.addDisplay(2899); second.fake.addDisplay(2900);
        assert.equal((await second.provision()).verdict, 'BLOCKED', `${block}: a second graphics process`);
        const compute = llmWorld(t, { block });
        compute.fake.addDisplay(2899, { type: 'C' });
        assert.equal((await compute.provision()).verdict, 'BLOCKED', `${block}: a compute process`);
        assert.deepEqual([second.run.toleratedProcesses, compute.run.toleratedProcesses], [[], []]);
    }
    const grown = await provisioned(t, { display: 2899 });
    grown.fake.model.foreign.find(entry => entry.pid === 2899).type = 'C+G';
    const blockedReport = await liveCases(grown, ['LIVE-L1']);
    assert.equal(caseOf(blockedReport, 'LIVE-L1').result, 'blocked'); assert.match(blockedReport.limitations[0], /GPU idle gate blocked: gpu_busy/);
    assert.equal(toolCalls(grown, 'local_llm_run').length, 0, 'no new work started after the gate blocked');
});

test('G2.cleanup-inventories-and-removes-model-data-runner-caches-subordinate-owned-files-and-records-and-proves-it', async t => {
    // L1 downloads the small model; the vLLM block also installs the runner: both leave data under /data.
    for (const [label, options, cases] of [['L1', {}, ['LIVE-L1']], ['vLLM stage 2', { block: 'apparatus-vllm', vllm: stageTwo(true), qualified: true }, ['LIVE-L3']]]) {
        const w = await provisioned(t, options);
        const workspace = w.run.target.execution.workspace.path;
        // A file owned by a subordinate UID cannot be removed by the runner: the bounded `podman unshare` removal handles it.
        const locked = path.join(workspace, '.data', 'local-llm', 'locked');
        fs.mkdirSync(locked, { recursive: true }); fs.writeFileSync(path.join(locked, 'owned-by-subordinate'), 'x'); fs.chmodSync(locked, 0o500);
        const report = await liveCases(w, cases);
        assert.equal(report.cleanup.state, 'complete', `${label}: ${JSON.stringify(report.cleanup)}`);
        assert.equal(caseOf(report, cases[0]).result, 'pass', `${label}: ${JSON.stringify(report.limitations)}`);
        const inventory = w.artifacts.get('llm-cleanup-inventory');
        assert.ok(inventory.bytes > 0 && inventory.top.length > 0, `${label}: the model data was inventoried before it was removed: ${JSON.stringify(inventory)}`);
        assert.ok(inventory.top.some(entry => /weights\.bin|cache\.whl/.test(entry.path)), label);
        assert.equal(worldState(w.statePath).unshare.length >= 1, true, `${label}: the subordinate-owned data went through the bounded unshare removal`);
        assert.deepEqual(w.artifacts.get('llm-cleanup-proof').remaining, [], label);
        assert.equal(exists(path.join(workspace, '.data')), false, `${label}: the model data is gone`);
        nothingOwned(w);
        assert.deepEqual(w.artifacts.get('gpu-final-observation').processes, [], label);
    }
});

test('G2.cleanup-is-not-certified-while-the-owned-model-data-remains', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-L1']);
    assert.equal(report.cleanup.state, 'complete');
    const profile = validateProfile(w.run);
    const workspace = profile.workspace.path;
    const adapter = createLiveAdapter(profile, { processProvider: w.fake.provider, persist: w.persist, run: w.run, artifacts: (name, value) => w.artifacts.set(name, structuredClone(value)), hostProc: w.fake.hostProc, gpuTimings: FAST });
    // The data comes back (an incomplete removal): the cleanup proof fails and names it.
    fs.mkdirSync(path.join(workspace, '.data', 'local-llm', 'models'), { recursive: true }); fs.writeFileSync(path.join(workspace, '.data', 'local-llm', 'models', 'weights.bin'), 'left behind');
    await assert.rejects(adapter.llm.afterCleanup(), error => error.code === 'LIVE_LLM_DATA_REMAINS' && error.message.includes(path.join(workspace, '.data')));
    assert.deepEqual(w.artifacts.get('llm-cleanup-proof').remaining, [workspace, path.join(workspace, '.data')]);
    // Without the data the same proof passes.
    fs.rmSync(workspace, { recursive: true, force: true });
    await assert.doesNotReject(adapter.llm.afterCleanup());
    assert.deepEqual(w.artifacts.get('llm-cleanup-proof').remaining, []);
});

// --- Plans, programs and validation ------------------------------------------------------------------
test('G2.manifest-plan-lists-every-llm-operation-the-executors-perform', async t => {
    for (const [label, options, cases] of [
        ['local-llm', {}, ['LIVE-L1', 'LIVE-L2']],
        ['vLLM stage 1', { block: 'apparatus-vllm' }, ['LIVE-L3']],
        ['vLLM stage 2', { block: 'apparatus-vllm', vllm: stageTwo(true), qualified: true }, ['LIVE-L3']],
    ]) {
        const w = await provisioned(t, options);
        const report = await liveCases(w, cases);
        assert.equal(report.verdict, 'PASS', `${label}: ${JSON.stringify(report.limitations)}`);
        const profile = w.run.target.execution;
        const plan = llmPlan(w.run);
        const planned = plan.operations.filter(entry => entry.argv);
        const toolsPlanned = planned.filter(entry => entry.argv.includes('<LLM_TOOL_CALL>')).map(entry => `${entry.argv[entry.argv.indexOf('<LLM_TOOL_CALL>') + 1]}`);
        const plannedAgent = planned.filter(entry => entry.argv.includes('container') && entry.argv.includes('<AGENT_ID>')).map(entry => entry.argv.slice(entry.argv.indexOf('<AGENT_ID>') + 1).map(word => (word === LLM_RUNNER_PROCESSES ? '<LLM_RUNNER_PROCESSES>' : word)));
        const boxId = profile.box.id;
        const unplanned = [];
        let smi = 0; let tools = 0; let agentExecs = 0;
        for (const call of w.fake.model.calls) {
            const args = call.args.map(word => (word === profile.candidate.path ? '<CANDIDATE>' : word === boxId ? '<BOX_ID>' : word));
            if (call.binary === w.gpu.smi) { smi += 1; if (!planned.some(entry => entry.binary === w.gpu.smi && JSON.stringify(entry.argv) === JSON.stringify(call.args))) unplanned.push(`smi ${args.join(' ')}`); continue; }
            if (call.binary === w.node) {
                if (args.includes('grant') && JSON.stringify(args) !== JSON.stringify(['<CANDIDATE>', 'gpu', 'grant', '--agent', 'local-llms/local-llm'])) unplanned.push(`grant ${args.join(' ')}`);
                continue;
            }
            const inner = args[0] === 'container' && args[1] === 'exec' ? args.slice(5) : [];
            if (inner[0] === 'node' && inner[1] === '-e' && inner[2] === LLM_TOOL_CALL) { tools += 1; if (!toolsPlanned.includes(inner[3])) unplanned.push(`tool ${inner[3]}`); }
            if (inner[0] === 'podman' && inner[2] === 'container' && inner[3] === 'exec' && inner[5] === 'node') {
                agentExecs += 1;
                const words = inner.slice(5).map(word => (word === LLM_RUNNER_PROCESSES ? '<LLM_RUNNER_PROCESSES>' : word === LLM_IMAGE_DIGESTS ? '<LLM_IMAGE_DIGESTS>' : word));
                if (!plannedAgent.some(entry => entry.length === words.length + 0 && entry.every((word, index) => word === words[index] || (word === '<LLM_IMAGE_DIGESTS>' && words[index] === '<LLM_IMAGE_DIGESTS>')))) unplanned.push(`agent ${words.join(' ').slice(0, 160)}`);
            }
        }
        assert.deepEqual(unplanned, [], `${label}: every executed GPU or product operation is a command of the plan`);
        assert.ok(smi >= 6 && tools > 4 && agentExecs >= 2, `${label}: ${JSON.stringify({ smi, tools, agentExecs })}`);
        const ids = plan.operations.map(entry => entry.id);
        for (const id of ['gpu-initial-gate', 'gpu-grant', 'gpu-final-observation', ...(cases.includes('LIVE-L1') ? ['L1-apply', 'L1-run', 'L1-runner-env', 'L2-run', 'L2-stop', 'L2-save-insufficient'] : ['L3-step0-prerequisites', 'L3-apply', 'L3-install'])]) assert.ok(ids.includes(id), `${label}: ${id}`);
        // Every planned tool call is one the in-Box program allows, and the admin calls name only the local-llm agent.
        for (const entry of planned.filter(value => value.argv.includes('<LLM_TOOL_CALL>'))) assert.doesNotThrow(() => llmToolWords(entry.argv[entry.argv.indexOf('<LLM_TOOL_CALL>') + 1], JSON.parse(entry.argv[entry.argv.indexOf('<LLM_TOOL_CALL>') + 2].replaceAll('<REQUEST_ID>', 'abcdefgh').replaceAll('<PROMPT>', 'x'))), entry.id);
        for (const posted of w.fake.model.applyCalls) assert.equal(posted.length, 1);
        assert.ok(Buffer.byteLength(JSON.stringify(report)) < 800000 && Buffer.byteLength(JSON.stringify(w.run)) < 190000 && w.run.operations.length < 200, `${label}: ${w.run.operations.length} journaled operations`);
    }
});

const localize = (program, replacements) => Object.entries(replacements).reduce((text, [from, to]) => text.split(from).join(to), program);
function runProgram(program, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', program, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
}

test('G2.the-tool-program-validates-resolves-the-agent-projects-the-reply-and-reports-a-refusal-as-data', async t => {
    const root = scratch(t);
    // Stand-ins of the two modules the program imports from /opt/ploinky: the session minting and the MCP client.
    const auth = path.join(root, 'localService.mjs'); const client = path.join(root, 'MCPBrowserClient.mjs'); const scenario = path.join(root, 'scenario.json'); const seen = path.join(root, 'seen.json');
    fs.writeFileSync(auth, 'export const mintSessionJwt = () => "jwt-token";\n');
    fs.writeFileSync(client, `import fs from 'node:fs';
export function createAgentClient(url, options) {
    const scenario = JSON.parse(fs.readFileSync(process.env.HWL_SCENARIO, 'utf8'));
    fs.writeFileSync(process.env.HWL_SEEN, JSON.stringify({ url, options, calls: [] }));
    const record = (entry) => { const seen = JSON.parse(fs.readFileSync(process.env.HWL_SEEN, 'utf8')); seen.calls.push(entry); fs.writeFileSync(process.env.HWL_SEEN, JSON.stringify(seen)); };
    return { listTools: async () => scenario.tools, callTool: async (name, args, meta) => { record({ name, args, meta }); return scenario.reply; }, close: async () => { record({ closed: true }); } };
}
`);
    const program = localize(LLM_TOOL_CALL, { '/opt/ploinky/cli/server/auth/localService.js': `file://${auth}`, '/opt/ploinky/Agent/client/MCPBrowserClient.js': `file://${client}` });
    const router = agent => ({ name: 'x', annotations: { router: { agent } } });
    const run = async (words, { tools = [{ ...router('local-llm'), name: words[0] }], reply = { content: [{ type: 'text', text: '{}' }] } } = {}) => {
        fs.writeFileSync(scenario, JSON.stringify({ tools, reply }));
        const result = await runProgram(program, words, { HWL_SCENARIO: scenario, HWL_SEEN: seen });
        return { ...result, doc: result.stdout ? JSON.parse(result.stdout) : null, seen: exists(seen) ? JSON.parse(fs.readFileSync(seen, 'utf8')) : null };
    };
    // The overview is projected to the fields the cases read, whatever the reply's size.
    const models = Array.from({ length: 300 }, (_, index) => ({ id: `model-${index}`, description: 'x'.repeat(500), sources: {}, weights: {}, runners: {} }));
    const overview = { profile: 'dedicated', limits: { budget: { cpus: 4, memoryBytes: 8 * GIB, source: 'ploinky' } }, hardware: { gpu: { available: true, name: 'GPU', processes: Array(500).fill({ pid: 1 }), driverVersion: '595.91.07' }, memory: { totalBytes: 1, availableBytes: 1 }, cpus: 16 },
        runners: [{ id: 'vllm', installed: true, version: '0.30.0', install: { state: { phase: 'installed', download: { bytes: 1, total: 1 } }, installed: true } }], models: [...models, { id: LLM_MODELS.small, sources: { gguf: { sha256: 'a'.repeat(64) } }, weights: { gguf: { size: 5, download: { state: 'absent' }, acquisition: { bytesNeeded: 5 }, runners: ['llama.cpp'] } }, runners: { 'llama.cpp': { format: 'gguf', size: 5, params: {}, admission: { status: 'ok', reason: null, estimate: { ramBytes: 1 } } } } }],
        deployment: null, preview: { modelId: LLM_MODELS.small, runnerId: 'llama.cpp', admission: { status: 'incompatible', reasonCode: 'vllm_mps_unqualified', reason: 'r', estimate: {} } }, gatewayModel: 'g' };
    const answered = await run(llmToolWords('local_llm_overview', { preview: { modelId: LLM_MODELS.small, runnerId: 'llama.cpp', params: {} } }, { model: LLM_MODELS.small }), { reply: { content: [{ type: 'text', text: JSON.stringify(overview) }] } });
    assert.equal(answered.status, 0, answered.stderr); assert.equal(answered.doc.ok, true); assert.equal(answered.doc.agent, 'local-llm');
    assert.ok(answered.stdout.length < 6000, `projected: ${answered.stdout.length}`);
    assert.deepEqual([answered.doc.result.limits.budget.cpus, answered.doc.result.model.id, answered.doc.result.model.weights.gguf.download.state, answered.doc.result.preview.admission.reasonCode, answered.doc.result.runners[0].install.phase], [4, LLM_MODELS.small, 'absent', 'vllm_mps_unqualified', 'installed']);
    assert.equal(answered.doc.result.hardware.gpu.processes, undefined);
    // The session cookie is the product's local operator session, to the Router's MCP endpoint, naming the agent.
    assert.equal(answered.seen.url, 'http://127.0.0.1:8080/mcp'); assert.deepEqual(answered.seen.options.requestHeaders, { cookie: 'ploinky_jwt=jwt-token' });
    assert.deepEqual(answered.seen.calls[0].meta, { agent: 'local-llm' }); assert.deepEqual(answered.seen.calls.at(-1), { closed: true });
    // A refusal is data: an MCP error carrying the tool's JSON, or only its message.
    const json = await run(llmToolWords('local_llm_run', { requestId: 'abcdefgh1', modelId: LLM_MODELS.small, runnerId: 'llama.cpp', params: {}, replace: false }), { reply: { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'admission_insufficient_now', message: 'Needs about 0.8 GiB of RAM; 0.5 GiB is available now.', details: { admission: { status: 'insufficient-now', reason: 'r', reasonCode: null, estimate: { ramBytes: 1 } } } }) }] } });
    assert.deepEqual([json.status, json.doc.ok, json.doc.error.code, json.doc.error.details.admission.status], [0, false, 'admission_insufficient_now', 'insufficient-now']);
    const plain = await run(llmToolWords('local_llm_run', { requestId: 'abcdefgh1', modelId: LLM_MODELS.small, runnerId: 'llama.cpp' }), { reply: { isError: true, content: [{ type: 'text', text: 'MCP error -32000: admission_incompatible: Needs about 0.8 GiB of RAM.' }] } });
    assert.deepEqual([plain.doc.ok, plain.doc.error.code, /RAM/.test(plain.doc.error.message)], [false, 'admission_incompatible', true]);
    const documentRefusal = await run(llmToolWords('local_llm_stop'), { reply: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'busy', message: 'busy now' }) }] } });
    assert.deepEqual([documentRefusal.doc.ok, documentRefusal.doc.error.code], [false, 'busy']);
    // The agent must be exactly one.
    for (const [label, tools] of [['none', []], ['two', [{ ...router('a'), name: 'local_llm_status' }, { ...router('b'), name: 'local_llm_status' }]]]) {
        const refused = await run(llmToolWords('local_llm_status'), { tools });
        assert.equal(refused.status, 3, label); assert.equal(refused.doc.error.code, 'agent_not_found', label);
    }
    // Only the six tools, with validated arguments: anything else exits 3 before the client is created.
    for (const [label, words] of [
        ['a tool that is not allowed', ['local_llm_weights_delete', '{}', '{}']], ['another runner to install', ['local_llm_runner_install', '{"runnerId":"tabbyapi","acceptLicence":false}', '{}']],
        ['a licence acceptance', ['local_llm_runner_install', '{"runnerId":"vllm","acceptLicence":true}', '{}']], ['a bad request id', ['local_llm_run', '{"requestId":"x","modelId":"m","runnerId":"r"}', '{}']],
        ['an extra argument', ['local_llm_stop', '{"force":true}', '{}']], ['a long prompt', ['local_llm_test_prompt', JSON.stringify({ prompt: 'x'.repeat(201), maxTokens: 8 }), '{}']],
        ['too many tokens', ['local_llm_test_prompt', '{"prompt":"x","maxTokens":513}', '{}']], ['a bad model in a preview', ['local_llm_overview', '{"preview":{"modelId":"../x","runnerId":"r"}}', '{}']], ['invalid JSON', ['local_llm_status', '{', '{}']],
    ]) {
        fs.rmSync(seen, { force: true });
        const refused = await run(words);
        assert.equal(refused.status, 3, label); assert.equal(refused.doc.ok, false, label); assert.equal(refused.seen, null, `${label}: no client was created`);
    }
    // The argv builders refuse the same, before a process exists.
    assert.throws(() => llmToolWords('local_llm_weights_delete', {})); assert.throws(() => llmToolWords('local_llm_status', { sinceSeq: 'x'.repeat(5000) }));
    assert.throws(() => llmToolWords('local_llm_overview', {}, { model: 'Not Valid' }));
});

test('G2.the-agent-programs-read-runner-processes-and-image-files-without-leaking-arguments-or-values', async t => {
    const root = scratch(t);
    const proc = path.join(root, 'proc');
    const make = (pid, { exe, cmd, env, uid = 1000 }) => {
        const directory = path.join(proc, String(pid)); fs.mkdirSync(directory, { recursive: true });
        fs.symlinkSync(exe, path.join(directory, 'exe'));
        fs.writeFileSync(path.join(directory, 'cmdline'), cmd.join('\0'));
        fs.writeFileSync(path.join(directory, 'environ'), `${env.join('\0')}\0`);
        fs.writeFileSync(path.join(directory, 'stat'), `${pid} (llama-server) S 7 ${pid} ${pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 424242 1000 1`);
        fs.writeFileSync(path.join(directory, 'status'), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    };
    make(41, { exe: '/opt/llama.cpp/llama-server', cmd: ['/opt/llama.cpp/llama-server', '--api-key', 'API-KEY-VALUE', '--port', '18080'], env: ['PATH=/usr/bin', 'HF_TOKEN=HF-TOKEN-VALUE', 'CUDA_MPS_PIPE_DIRECTORY=/run/ploinky-mps-pipe', 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=50', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=3072M'] });
    make(42, { exe: '/usr/bin/node', cmd: ['node', '/code/src/main.mjs'], env: ['PATH=/usr/bin', 'LOCAL_LLM_CONTROL_TOKEN=CONTROL-TOKEN'] });
    make(43, { exe: '/opt/runners/vllm/0.30.0/venv/bin/python3.13', cmd: ['python', '-m', 'vllm.entrypoints.openai.api_server', '--model', '/data/m'], env: ['VLLM_API_KEY=VLLM-KEY-VALUE', 'CUDA_MPS_PIPE_DIRECTORY=/run/ploinky-mps-pipe'] });
    const program = localize(LLM_RUNNER_PROCESSES, { '/proc': proc });
    const llama = await runProgram(program, ['llama-server'], {});
    assert.equal(llama.status, 0, llama.stderr);
    const found = JSON.parse(llama.stdout).processes;
    assert.deepEqual(found.map(entry => [entry.pid, entry.exe, entry.ppid, entry.start, entry.uid]), [[41, '/opt/llama.cpp/llama-server', 7, '424242', [1000, 1000, 1000, 1000]]]);
    assert.deepEqual(found[0].cuda, { CUDA_MPS_PIPE_DIRECTORY: '/run/ploinky-mps-pipe', CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: '50', CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: '0=3072M' });
    assert.ok(found[0].envNames.includes('HF_TOKEN'), 'the names of the environment are reported');
    for (const secret of ['API-KEY-VALUE', 'HF-TOKEN-VALUE', 'CONTROL-TOKEN']) assert.equal(llama.stdout.includes(secret), false, `${secret} is never printed`);
    const vllm = await runProgram(program, ['vllm'], {});
    assert.deepEqual(JSON.parse(vllm.stdout).processes.map(entry => entry.pid), [43]); assert.equal(vllm.stdout.includes('VLLM-KEY-VALUE'), false);
    assert.notEqual((await runProgram(program, ['anything-else'], {})).status, 0, 'only the two matchers exist');
    // The image digests: a fixed list of three files, streamed.
    const files = { '/opt/llama.cpp/llama-server': 'server bytes', '/opt/local-llm/source.contract': 'llama_cpp=b11159\n' };
    const mapped = Object.fromEntries(Object.entries(files).map(([name, content]) => { const target = path.join(root, path.basename(name)); fs.writeFileSync(target, content); return [name, target]; }));
    const digests = JSON.parse((await runProgram(localize(LLM_IMAGE_DIGESTS, { '/opt/llama.cpp/llama-server': mapped['/opt/llama.cpp/llama-server'], '/opt/local-llm/source.contract': mapped['/opt/local-llm/source.contract'], '/opt/local-llm/runners.lock.json': path.join(root, 'absent.json') }), [], {})).stdout);
    assert.deepEqual(digests.files[mapped['/opt/llama.cpp/llama-server']], { sha256: hex('server bytes'), size: 12 }); assert.equal(digests.files[path.join(root, 'absent.json')], null); assert.equal(digests.contract, 'llama_cpp=b11159\n');
    // The leaf observer is the G1 read-only program, run on the agent's leaf path only.
    assert.match(LEAF_OBSERVATION, /ploinky\\\/agents\\\//);
});

test('G2.validation-refuses-inconsistent-local-llm-pins-profiles-budgets-and-tool-words', async t => {
    const w = llmWorld(t, { block: 'apparatus-vllm', vllm: stageTwo(true) });
    const profile = w.run.target.execution;
    assert.doesNotThrow(() => validateLlmProfile(profile));
    for (const [label, mutate] of [
        ['another image than the provision plan', p => { p.llm.image = `docker.io/assistos/local-llm@sha256:${'d'.repeat(64)}`; }], ['another budget', p => { p.llm.budget.cpus = 8; }],
        ['another vLLM share', p => { p.llm.vllm.share.vramPercent = 50; }], ['an unknown stage', p => { p.llm.vllm.stage = 'both'; }],
        ['a lock digest that differs from the calibration tuple', p => { p.llm.vllm.calibration.tuple.runnerLockDigest = hex('other'); }], ['a calibration that is not boolean', p => { p.llm.vllm.calibration.expectQualified = 'yes'; }],
        ['a stage 1 that carries a calibration', p => { p.llm.vllm.stage = 'calibration'; }], ['pins with a bad digest', p => { p.llm.vllm.pins.runnerLockDigest = 'x'; }],
        ['another model id', p => { p.llm.models.small.id = 'other'; }], ['a model size that is not the sum of its files', p => { p.llm.models.awq.size += 1; }], ['a playground that is a browser', p => { p.llm.playground.mode = 'browser'; }],
        ['an extra field', p => { p.llm.extra = 1; }],
    ]) {
        const copy = structuredClone(profile); mutate(copy);
        assert.throws(() => validateLlmProfile(copy), undefined, label);
    }
    const local = llmWorld(t);
    const copy = structuredClone(local.run.target.execution); copy.llm.vllm = { stage: 'calibration', share: VLLM_SHARE, pins: VLLM_PINS, calibration: null };
    assert.throws(() => validateLlmProfile(copy), /Only the vLLM block carries vLLM pins/);
    assert.throws(() => { const run = structuredClone(local.run); run.target.execution.cases = ['LIVE-L1']; delete run.target.execution.llm; validateProfile(run, { partial: true }); }, /pins and the selected cases disagree/);
    assert.throws(() => validateLlmModelPins({ ...profile.llm.models, awq: { ...profile.llm.models.awq, files: [] } }));
    // The words of a vLLM tool call.
    assert.deepEqual(vllmToolWords('calibrate', { hostNvmlBytes: 6144 * MIB }), [VLLM_TOOL_PATH, 'calibrate', '--host-nvml-bytes', String(6144 * MIB)]);
    assert.throws(() => vllmToolWords('calibrate', { hostNvmlBytes: 0 })); assert.throws(() => vllmToolWords('prerequisites')); assert.throws(() => vllmToolWords('render'));
    assert.throws(() => vllmToolWords('prerequisites', { pins: { ...VLLM_PINS, version: '0.30' } }));
    assert.equal(INSUFFICIENT_RAM.maxCapBytes, 1280 * MIB); assert.deepEqual({ ...LLM_BUDGET.gpu }, { smPercent: 50, vramPercent: 50 });
    // The block and the stage on the command line of prepare-live are validated with the pins.
    assert.throws(() => llmWorld(t, { block: 'apparatus-local-llm', vllm: { stage: 'calibration' } }), /Only the vLLM block has stages/);
    assert.throws(() => llmWorld(t, { block: 'apparatus-vllm', vllm: undefined, faults: {} }) && (() => { throw new Error('unreachable'); })(), /unreachable/);
});

// --- prepare-live of the two local-llm blocks ---------------------------------------------------------------------
function gitRepo(root) {
    const run = args => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    run(['init', '-q']); run(['add', '-A']);
    run(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']);
    return run(['rev-parse', 'HEAD']);
}
function treeDigestOf(root) {
    const rows = [];
    const walk = (directory, relative = '') => {
        for (const name of fs.readdirSync(directory).sort()) {
            if (name === '.git') continue;
            const target = path.join(directory, name); const rel = relative ? `${relative}/${name}` : name;
            const stat = fs.lstatSync(target);
            if (stat.isDirectory()) walk(target, rel); else if (stat.isFile()) rows.push(`${rel}\0${hash(fs.readFileSync(target)).slice(7)}`);
        }
    };
    walk(root); return hash(rows.join('\n'));
}
// The configuration, the committed Ploinky and local-llms candidates and the pins prepare-live reads (it opens no SSH, engine or GPU).
function prepareLlmFixture(t, { entries = [], suffix = 'claude' } = {}) {
    const root = scratch(t);
    const ploinky = path.join(root, 'ploinky');
    fs.mkdirSync(path.join(ploinky, 'ploinky-box', 'bin'), { recursive: true }); fs.writeFileSync(path.join(ploinky, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// candidate\n');
    fs.mkdirSync(path.join(ploinky, 'tests', 'hardware-limits'), { recursive: true }); fs.writeFileSync(path.join(ploinky, 'tests', 'hardware-limits', 'verify.mjs'), '// runner\n');
    gitRepo(ploinky);
    const explorer = path.join(root, 'explorer'); fs.mkdirSync(path.join(explorer, 'explorer'), { recursive: true });
    fs.writeFileSync(path.join(explorer, 'explorer', 'manifest.json'), `{\n    "container": "docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}",\n    "lite-sandbox": true\n}\n`);
    const llms = path.join(root, 'llms'); fs.mkdirSync(llms);
    const tree = path.join(llms, 'local-llm');
    for (const directory of ['catalog', 'tools', path.join('src', 'controller')]) fs.mkdirSync(path.join(tree, directory), { recursive: true });
    fs.writeFileSync(path.join(tree, 'manifest.json'), `${JSON.stringify(ORIGINAL_MANIFEST, null, 4)}\n`);
    fs.writeFileSync(path.join(tree, 'catalog', 'models.json'), JSON.stringify(CATALOG));
    fs.writeFileSync(path.join(tree, 'tools', 'vllm_mps_calibration.mjs'), TOOL_STUB);
    fs.writeFileSync(path.join(tree, 'src', 'controller', 'vllmMpsQualification.mjs'), qualificationStub(entries));
    fs.writeFileSync(path.join(tree, 'src', 'main.mjs'), '// agent\n');
    const llmsRevision = gitRepo(llms);
    const dependency = path.join(root, 'deps', 'smalldep'); fs.mkdirSync(dependency, { recursive: true }); fs.writeFileSync(path.join(dependency, 'index.js'), 'export default 1;\n');
    const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence, { mode: 0o700 });
    const casesPath = path.join(evidence, `cases_${suffix}.json`); writePrivateJson(casesPath, { schema: 1, cases: [] });
    const entry = candidateRoot => ({ baselineRevision: '0'.repeat(40), baselineExport: root, baselineStage: null, candidateRoot, sourceDigest: hash('x'), instructionDigests: {} });
    const config = {
        schema: 1, runId: crypto.randomBytes(16).toString('hex'), createdAt: new Date().toISOString(), documentSuffix: suffix,
        node: { absoluteExecutable: fs.realpathSync(process.execPath), version: process.version },
        repos: { ploinky: entry(ploinky), explorer: entry(explorer), localLlms: entry(llms), images: { ...entry(null), candidateRoot: null } },
        dependencies: [{ name: 'smalldep', realpath: dependency, revision: null, treeDigest: treeDigestOf(dependency) }],
        evidenceRoot: evidence, casesPath, casesDigest: hash(fs.readFileSync(casesPath)), engine: null, ssh: null,
    };
    const configPath = path.join(evidence, `config_${suffix}.json`); writePrivateJson(configPath, config);
    const ssh = path.join(root, 'ssh'); fs.writeFileSync(ssh, 'fake ssh\n');
    const knownHosts = path.join(root, 'known_hosts'); fs.writeFileSync(knownHosts, '192.168.1.63 ssh-ed25519 AAAAfixture\n');
    const pins = (llm, extra = {}) => ({
        schema: 1, host: { hostname: 'apparatus', platform: 'linux', home: '/home/skutner' }, node: { path: '/usr/bin/node', digest: hash('remote node') },
        engine: { path: '/usr/bin/podman', digest: hash('remote podman'), identityDigest: engineIdentityDigest(fakeEngineInfo(ENGINE_HOST)) }, boxImage: BOX_IMAGE,
        ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '100.76.22.69', hostKeyAlias: '192.168.1.63', user: 'skutner', knownHosts, identityFile: null },
        gpu: { uuid: GPU_UUID, name: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '595.91.07', memoryMiB: 6144, expectedSmCount: 30,
            smi: { path: '/usr/bin/nvidia-smi', digest: hash('smi') }, mpsControl: { path: '/usr/bin/nvidia-cuda-mps-control', digest: hash('control') }, mpsServer: { path: '/usr/bin/nvidia-cuda-mps-server', digest: hash('server') } },
        llm, ...extra,
    });
    const pinsFile = (name, value) => { const file = path.join(evidence, name); writePrivateJson(file, value); return file; };
    return { root, ploinky, llms, llmsRevision, evidence, configPath, pins, pinsFile };
}
async function prepare(f, block, runName, pinsValue, extra = []) {
    const main = (await import('../hardware-limits/verify.mjs')).main;
    const runPath = path.join(f.evidence, `${runName}_claude.json`);
    const code = await main(['prepare-live', '--config', f.configPath, '--block', block, '--run', runPath, '--pins', f.pinsFile(`pins_${runName}_claude.json`, pinsValue), ...extra]);
    return { code, runPath, run: exists(runPath) ? JSON.parse(fs.readFileSync(runPath, 'utf8')) : null };
}

test('G2.prepare-live-apparatus-local-llm-pins-the-image-the-tree-and-the-models-and-writes-the-approval-summary', async t => {
    const f = prepareLlmFixture(t);
    const { code, runPath, run } = await prepare(f, 'apparatus-local-llm', 'llm', f.pins({ image: LLM_IMAGE }));
    assert.equal(code, 0);
    const profile = validateProfile(run, { partial: true });
    assert.deepEqual(profile.cases, ['LIVE-L1', 'LIVE-L2']); assert.deepEqual(run.target.unsupported, {});
    assert.equal(profile.llm.image, LLM_IMAGE); assert.equal(profile.provision.image, LLM_IMAGE); assert.equal(profile.llm.revision, f.llmsRevision);
    assert.deepEqual({ ...profile.llm.budget, gpu: { ...profile.llm.budget.gpu } }, { cpus: 4, memoryPercent: 25, gpu: { smPercent: 50, vramPercent: 50 } });
    assert.equal(profile.llm.models.small.sha256, SMALL_FILE.sha256); assert.equal(profile.llm.models.awq.commit, AWQ_COMMIT); assert.equal(profile.llm.vllm, null);
    assert.deepEqual(profile.provision.gpu, { uuid: GPU_UUID, grantAgents: ['local-llms/local-llm'] });
    // The frozen local-llm tree is pinned by digest, and its manifest rewrite is pinned too.
    const frozen = path.join(f.evidence, `candidate-${run.runId}`, '.hwl-local-llms', 'local-llm');
    assert.equal(profile.provision.llm.treeDigest, liveSourceDigest(frozen)); assert.match(profile.provision.llm.manifest.rewrittenDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(profile.provision.llm.manifest.originalContainer, ORIGINAL_MANIFEST.container);
    assert.equal(run.deadlines.blockMs <= 1470000, true);
    const ids = run.target.plan.live.map(entry => entry.id);
    for (const id of ['L1-apply', 'L1-run', 'L1-leaf-sample', 'L1-prompt', 'L1-runner-env', 'L1-image-digests', 'L2-save-insufficient', 'L2-run']) assert.ok(ids.includes(id), id);
    const provisionIds = run.target.plan.provision.map(entry => entry.id);
    assert.ok(provisionIds.indexOf('gpu-initial-gate') < provisionIds.indexOf('gpu-grant') && provisionIds.indexOf('gpu-grant') < provisionIds.indexOf('fixture-start') && provisionIds.includes('fixture-write-local-llm'), provisionIds.join(','));
    assert.ok(run.target.plan.staging.some(entry => entry.id === 'fetch-run-artifacts'));
    const summary = fs.readFileSync(summaryPathFor(runPath, 'claude'), 'utf8');
    for (const text of [
        '## GPU idle gate', 'at most 64 MiB', '## GPU operations', 'L1-leaf-sample', 'L1-prompt', 'L2-save-insufficient',
        '## Measurements while the model generates (LIVE-L1)', 'cpu.stat usage_usec, nr_throttled, throttled_usec', 'memory.peak', 'the runner\'s device memory is at or below the share\'s pinned limit', 'A foreign GPU process appearing while the model generates aborts the request',
        '## Model data, caches and cleanup', '## Playground', 'Explorer', '## Prerequisites that may block real execution', LLM_IMAGE, f.llmsRevision.slice(0, 12),
    ]) assert.ok(summary.includes(text), text);
    assert.equal(fs.statSync(runPath).mode & 0o077, 0);
    // The image must be an immutable reference, the block needs the device, and only the vLLM block carries vLLM pins.
    for (const [label, pinsValue, pattern] of [
        ['a mutable image tag', f.pins({ image: 'docker.io/assistos/local-llm:latest' }), /immutable digest reference/], ['no llm pins', { ...f.pins({ image: LLM_IMAGE }), llm: undefined }, /pinned local-llm/],
        ['vLLM pins on the local-llm block', f.pins({ image: LLM_IMAGE, vllm: VLLM_PINS }), /fields|Unexpected|vllm/], ['no GPU pins', { ...f.pins({ image: LLM_IMAGE }), gpu: undefined }, /pinned GPU|Invalid pinned|fields/],
        ['an extra llm field', f.pins({ image: LLM_IMAGE, extra: 1 }), /fields|Unexpected|extra/],
    ]) {
        const refused = path.join(f.evidence, `refused-${label.replaceAll(' ', '-')}_claude.json`);
        const main = (await import('../hardware-limits/verify.mjs')).main;
        await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-local-llm', '--run', refused, '--pins', f.pinsFile('pins_refused_claude.json', pinsValue)]), pattern, label);
        assert.equal(exists(refused), false, label);
    }
    // A local-llm pin on another block is refused.
    const main = (await import('../hardware-limits/verify.mjs')).main;
    await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-mps', '--run', path.join(f.evidence, 'mps-llm_claude.json'), '--pins', f.pinsFile('pins_mps_llm_claude.json', f.pins({ image: LLM_IMAGE }))]), /Only the local-llm blocks name a local-llm image/);
    // An uncommitted tracked change in the local-llms candidate is refused: only committed revisions are frozen.
    fs.appendFileSync(path.join(f.llms, 'local-llm', 'src', 'main.mjs'), '// changed\n');
    await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-local-llm', '--run', path.join(f.evidence, 'dirty_claude.json'), '--pins', f.pinsFile('pins_dirty_claude.json', f.pins({ image: LLM_IMAGE }))]), /local-llms candidate has uncommitted tracked changes/);
});

test('G2.prepare-live-apparatus-vllm-stage-one-pins-the-lock-entry-and-asks-for-no-evidence', async t => {
    const f = prepareLlmFixture(t);
    const main = (await import('../hardware-limits/verify.mjs')).main;
    const { code, runPath, run } = await prepare(f, 'apparatus-vllm', 'vllm1', f.pins({ image: LLM_IMAGE, vllm: VLLM_PINS }));
    assert.equal(code, 0);
    const profile = validateProfile(run, { partial: true });
    assert.deepEqual(profile.cases, ['LIVE-L3']); assert.equal(profile.llm.vllm.stage, 'calibration'); assert.equal(profile.llm.vllm.calibration, null);
    assert.deepEqual(profile.llm.vllm.pins, VLLM_PINS); assert.deepEqual(profile.llm.vllm.share, VLLM_SHARE);
    assert.equal(run.deadlines.blockMs, 1470000); assert.equal(run.deadlines.installMs, 12 * 60 * 1000);
    const ids = run.target.plan.live.map(entry => entry.id);
    for (const id of ['L3-step0-prerequisites', 'L3-apply', 'L3-install', 'L3-stage1-calibrate']) assert.ok(ids.includes(id), id);
    assert.ok(!ids.includes('L3-run'), 'stage 1 launches no model');
    const summary = fs.readFileSync(summaryPathFor(runPath, 'claude'), 'utf8');
    for (const text of ['L3-step0-prerequisites', 'L3-stage1-calibrate', 'The image lock has a vLLM entry for linux/amd64 with CUDA wheels, equal to the pins', 'Free disk for the wheels', String(VLLM_PINS.downloadBytes), VLLM_PINS.runnerLockDigest.slice(0, 12)]) assert.ok(summary.includes(text), text);
    // The pins of the lock entry are required and validated; stage 1 takes no evidence; the stage names are checked.
    await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-vllm', '--run', path.join(f.evidence, 'nopins_claude.json'), '--pins', f.pinsFile('pins_nopins_claude.json', f.pins({ image: LLM_IMAGE }))]), /fields|pinned local-llm|vllm/);
    await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-vllm', '--run', path.join(f.evidence, 'badpins_claude.json'), '--pins', f.pinsFile('pins_badpins_claude.json', f.pins({ image: LLM_IMAGE, vllm: { ...VLLM_PINS, runnerLockDigest: 'x' } }))]), /Invalid vLLM lock pins/);
    await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-vllm', '--run', path.join(f.evidence, 'evidence1_claude.json'), '--pins', f.pinsFile('pins_evidence1_claude.json', f.pins({ image: LLM_IMAGE, vllm: VLLM_PINS })), '--calibration-evidence', path.join(f.evidence, 'none.json')]), /stage 1 \(calibration\) takes no --calibration-evidence/);
    await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-vllm', '--run', path.join(f.evidence, 'stage_claude.json'), '--pins', f.pinsFile('pins_stage_claude.json', f.pins({ image: LLM_IMAGE, vllm: VLLM_PINS })), '--stage', 'both']), /--stage must be calibration or qualified/);
});

test('G2.prepare-live-apparatus-vllm-stage-two-checks-the-evidence-with-the-candidates-digest-and-asks-production-whether-the-tuple-is-qualified', async t => {
    const tuple = { runnerLockDigest: VLLM_PINS.runnerLockDigest, driverVersion: '595.91.07', gpuPciDeviceId: '0x252010DE', computeCapability: '8.6', deviceTotalBytes: 6144 * MIB };
    // The stage 1 evidence document, with the digest the candidate's own function gives (the tool stub's canonical form).
    const canonical = value => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null));
    const evidenceFor = (extra = {}) => { const body = { schema: 'local-llm.vllm-mps-calibration/v1', tuple, verdict: { qualifiable: true, failed: [] }, ...extra }; return { ...body, evidenceDigest: hex(canonical(body)) }; };
    const stage2 = (f, name, document, extra = []) => {
        const file = path.join(f.evidence, `${name}-evidence.json`); writePrivateJson(file, document);
        return prepare(f, 'apparatus-vllm', name, f.pins({ image: LLM_IMAGE, vllm: VLLM_PINS }), ['--stage', 'qualified', '--calibration-evidence', file, ...extra]);
    };
    // Before the data entry: the candidate's reviewed data does not hold the tuple, so the live stage expects the refusal.
    const before = prepareLlmFixture(t);
    const document = evidenceFor();
    const first = await stage2(before, 'q-before', document);
    assert.equal(first.code, 0);
    const beforeProfile = validateProfile(first.run, { partial: true });
    assert.equal(beforeProfile.llm.vllm.stage, 'qualified'); assert.equal(beforeProfile.llm.vllm.calibration.evidenceDigest, document.evidenceDigest);
    assert.deepEqual(beforeProfile.llm.vllm.calibration.tuple, tuple); assert.equal(beforeProfile.llm.vllm.calibration.expectQualified, false);
    assert.ok(first.run.target.plan.live.some(entry => entry.id === 'L3-run') && !first.run.target.plan.live.some(entry => entry.id === 'L3-stage1-calibrate'));
    // After it: production's resolver qualifies exactly that tuple and digest, so the live stage expects the model to be admitted.
    const after = prepareLlmFixture(t, { entries: [{ ...tuple, denominator: 'physical-device', evidenceDigest: document.evidenceDigest }] });
    const second = await stage2(after, 'q-after', document);
    assert.equal(second.code, 0); assert.equal(validateProfile(second.run, { partial: true }).llm.vllm.calibration.expectQualified, true);
    const summary = fs.readFileSync(summaryPathFor(second.runPath, 'claude'), 'utf8');
    assert.ok(summary.includes('L3-run'));
    // An entry for another evidence digest does not qualify this evidence.
    const other = prepareLlmFixture(t, { entries: [{ ...tuple, denominator: 'physical-device', evidenceDigest: hex('another evidence') }] });
    assert.equal(validateProfile((await stage2(other, 'q-other', document)).run, { partial: true }).llm.vllm.calibration.expectQualified, false);
    // Evidence that is not qualifiable, that does not match its own digest, that is for another schema, or absent is refused.
    for (const [label, bad, pattern] of [
        ['not qualifiable', evidenceFor({ verdict: { qualifiable: false, failed: ['sizingEvidence'] } }), /not a qualifiable stage 1 document/],
        ['a digest that does not match', { ...evidenceFor(), tuple: { ...tuple, deviceTotalBytes: 1 } }, /matches its own digest|not a qualifiable/],
        ['another schema', evidenceFor({ schema: 'other/v1' }), /not a qualifiable stage 1 document/],
    ]) {
        const f = prepareLlmFixture(t);
        const file = path.join(f.evidence, 'bad-evidence.json'); writePrivateJson(file, bad);
        const main = (await import('../hardware-limits/verify.mjs')).main;
        await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-vllm', '--run', path.join(f.evidence, 'bad_claude.json'), '--pins', f.pinsFile('pins_bad_claude.json', f.pins({ image: LLM_IMAGE, vllm: VLLM_PINS })), '--stage', 'qualified', '--calibration-evidence', file]), pattern, label);
        assert.equal(exists(path.join(f.evidence, 'bad_claude.json')), false, label);
    }
    const f = prepareLlmFixture(t);
    const main = (await import('../hardware-limits/verify.mjs')).main;
    await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-vllm', '--run', path.join(f.evidence, 'noev_claude.json'), '--pins', f.pinsFile('pins_noev_claude.json', f.pins({ image: LLM_IMAGE, vllm: VLLM_PINS })), '--stage', 'qualified']), /stage 2 \(qualified\) needs --calibration-evidence/);
});

// --- LLM1: the measurement must contain real in-flight observations ----------------------------------------------
const leafAt = (label, atUs, usageUsec, extra = {}) => ({ label, atUs, usageUsec, nrPeriods: 1, nrThrottled: 0, throttledUsec: 0, cpuMax: '400000 100000', memoryMax: String(8 * GIB), swapMax: '0', memoryCurrent: GIB, memoryPeak: GIB, swapCurrent: 0, oom: 0, oomKill: 0, memoryHigh: 0, memoryMaxEvents: 0, ...extra });
const gpuAt = (label, extra = {}) => ({ label, usedMiB: 700, utilizationPercent: 40, rows: [], runnerMiB: 600, ownedMiB: 900, runnerListed: 1, ownedListed: 2, ...extra });
const analyzeSamples = (cgroup, gpu) => analyzeInference({ cgroup, gpu, cpus: 4, memoryCapBytes: 8 * GIB, shareMiB: 3072 });
const cgroupRun = inFlight => [leafAt('before-send', 0, 0), ...Array.from({ length: inFlight }, (_, index) => leafAt('in-flight', (index + 1) * 250_000, (index + 1) * 250_000)), leafAt('after-response', (inFlight + 1) * 250_000, (inFlight + 1) * 250_000)];
const gpuRun = inFlight => [gpuAt('before-send'), ...Array.from({ length: inFlight }, () => gpuAt('in-flight')), gpuAt('after-response')];

test('LLM1.L1-with-an-instant-generation-is-blocked-and-never-passes-while-a-long-enough-one-passes', async t => {
    assert.deepEqual(INFERENCE_MIN_IN_FLIGHT, { cgroup: 3, gpu: 2 }, 'the documented minimums');
    // The model answers before either sampler ran: before and after samples exist, no in-flight sample does.
    const instant = await provisioned(t, { faults: { promptInstant: true } });
    const report = await liveCases(instant, ['LIVE-L1']);
    const entry = caseOf(report, 'LIVE-L1');
    assert.equal(entry.result, 'blocked', JSON.stringify(entry).slice(0, 600));
    assert.match(entry.reason, /Only 0 CPU\/RAM sample\(s\) were taken while the model generated \(at least 3 are required\)/);
    assert.match(entry.reason, /Only 0 GPU sample\(s\) were taken while the model generated \(at least 2 are required\)/);
    assert.equal(report.verdict, 'BLOCKED');
    const inference = instant.artifacts.get('gpu-live-l1').inference;
    assert.deepEqual([inference.samples.inFlightCgroup, inference.samples.inFlightGpu], [0, 0]);
    assert.deepEqual([inference.cgroupSamples[0].label, inference.cgroupSamples.at(-1).label], ['before-send', 'after-response'], 'before and after samples exist and do not count');
    assert.deepEqual(inference.violations, []); assert.ok(inference.blockers.length >= 2, 'the evidence names what could not be measured');
    nothingOwned(instant);
    // A long-enough generation (the control) passes with at least the minimum in-flight samples.
    const long = await provisioned(t);
    const control = caseOf(await liveCases(long, ['LIVE-L1']), 'LIVE-L1');
    assert.equal(control.result, 'pass', JSON.stringify(control).slice(0, 500));
    const evidence = long.artifacts.get('gpu-live-l1').inference;
    assert.ok(evidence.samples.inFlightCgroup >= INFERENCE_MIN_IN_FLIGHT.cgroup && evidence.samples.inFlightGpu >= INFERENCE_MIN_IN_FLIGHT.gpu, JSON.stringify(evidence.samples));
    nothingOwned(long);
});

test('LLM1.the-analysis-needs-the-minimum-in-flight-samples-of-each-kind-and-counts-neither-before-nor-after', () => {
    const min = INFERENCE_MIN_IN_FLIGHT;
    const ok = analyzeSamples(cgroupRun(min.cgroup), gpuRun(min.gpu));
    assert.deepEqual([ok.violations, ok.blockers], [[], []], 'exactly the minimum measures');
    const fewCgroup = analyzeSamples(cgroupRun(min.cgroup - 1), gpuRun(min.gpu));
    assert.deepEqual(fewCgroup.violations, []); assert.match(fewCgroup.blockers.join(), /Only 2 CPU\/RAM sample\(s\)/); assert.equal(fewCgroup.blockers.length, 1);
    const fewGpu = analyzeSamples(cgroupRun(min.cgroup), gpuRun(min.gpu - 1));
    assert.match(fewGpu.blockers.join(), /Only 1 GPU sample\(s\)/); assert.equal(fewGpu.blockers.length, 1);
    const none = analyzeSamples(cgroupRun(0), gpuRun(0));
    assert.equal(none.blockers.length, 2, 'only the before and after samples: nothing observed');
    assert.deepEqual([none.summary.samples.cgroup, none.summary.samples.inFlightCgroup, none.summary.samples.gpu, none.summary.samples.inFlightGpu], [2, 0, 2, 0]);
    // Setup or after-response samples relabelled never count, and a breach is still reported beside the blocker.
    const breach = analyzeSamples([leafAt('before-send', 0, 0), leafAt('in-flight', 1_000_000, 100_000_000), leafAt('after-response', 2_000_000, 100_000_100)], gpuRun(min.gpu));
    assert.ok(breach.violations.length >= 1 && breach.blockers.length === 1);
});

// --- LLM2: the swap CAP is part of the budget ---------------------------------------------------------------------
test('LLM2.the-swap-cap-must-be-exactly-zero-after-apply-and-in-every-sample', async t => {
    // Readback after Apply (shared by L1 and L2): unlimited, nonzero and missing are refused; zero is the control.
    for (const [label, value, pattern] of [['unlimited', 'max', /memory\.swap\.max is max, not 0/], ['nonzero', '4096', /memory\.swap\.max is 4096, not 0/], ['missing', null, /memory\.swap\.max is \(missing\), not 0/]]) {
        for (const id of ['LIVE-L1', 'LIVE-L2']) {
            const w = await provisioned(t, { faults: { swapMaxAfterApply: value } });
            const entry = caseOf(await liveCases(w, [id]), id);
            assert.equal(entry.result, 'fail', `${label} ${id}: ${JSON.stringify(entry).slice(0, 400)}`); assert.match(entry.reason, pattern, `${label} ${id}`);
            nothingOwned(w);
        }
    }
    // During inference: unlimited and nonzero fail with the evidence written; a missing file is a measurement that cannot be made.
    for (const [label, value, result, pattern] of [['unlimited', 'max', 'fail', /memory\.swap\.max is max, not 0 \(/], ['nonzero', '4096', 'fail', /memory\.swap\.max is 4096, not 0 \(/], ['missing', null, 'blocked', /memory\.swap\.max could not be read \(/]]) {
        const w = await provisioned(t, { faults: { swapMaxInSamples: value } });
        const entry = caseOf(await liveCases(w, ['LIVE-L1']), 'LIVE-L1');
        assert.equal(entry.result, result, `${label}: ${JSON.stringify(entry).slice(0, 400)}`); assert.match(entry.reason, pattern, label);
        const inference = w.artifacts.get('gpu-live-l1').inference;
        assert.ok([...inference.violations, ...inference.blockers].some(text => pattern.test(text)), `${label}: the evidence was written first`);
        nothingOwned(w);
    }
    // Zero is valid in the readback and in every sample (the existing L1 and L2 passes are the controls).
    const control = await provisioned(t, { faults: { swapMaxAfterApply: '0', swapMaxInSamples: '0' } });
    assert.equal(caseOf(await liveCases(control, ['LIVE-L1']), 'LIVE-L1').result, 'pass');
    nothingOwned(control);
});

test('LLM2.the-analysis-refuses-an-unlimited-nonzero-or-missing-swap-cap-in-any-sample', () => {
    const base = cgroupRun(3); const gpu = gpuRun(2);
    assert.deepEqual([analyzeSamples(base, gpu).violations, analyzeSamples(base, gpu).blockers], [[], []]);
    for (const [value, pattern] of [['max', /memory\.swap\.max is max, not 0 \(in-flight\)/], ['1', /memory\.swap\.max is 1, not 0/], ['', /memory\.swap\.max is , not 0/]]) {
        const samples = base.map((sample, index) => (index === 2 ? { ...sample, swapMax: value } : sample));
        assert.match(analyzeSamples(samples, gpu).violations.join(), pattern, `value '${value}'`);
    }
    const missing = base.map((sample, index) => (index === 2 ? { ...sample, swapMax: null } : sample));
    const result = analyzeSamples(missing, gpu);
    assert.deepEqual(result.violations, []); assert.match(result.blockers.join(), /memory\.swap\.max could not be read \(in-flight\)/);
    assert.deepEqual(parseLeafSample({ atNs: '1', 'cpu.stat': 'usage_usec 1\n', 'memory.swap.max': 'max\n' }).swapMax, 'max');
    assert.equal(parseLeafSample({ atNs: '1', 'cpu.stat': 'usage_usec 1\n' }).swapMax, null);
});

// --- LLM4: stage 1 judges how the calibration process ended, not only its output ----------------------------------
test('LLM4.stage-one-rejects-every-abnormal-completion-whatever-the-document-says-and-keeps-a-normal-completion', async t => {
    for (const [label, process, pattern] of [
        ['a timeout with a complete document', { status: null, signal: 'SIGKILL', timedOut: true }, /timed out, killed by SIGKILL, no exit status/],
        ['a signal', { status: null, signal: 'SIGTERM' }, /killed by SIGTERM/],
        ['truncated output', { truncated: true }, /output truncated/],
        ['a spawn error', { status: null, errorCode: 'ENOENT' }, /error ENOENT/],
        ['a forced settlement', { settlementForced: true }, /forced settlement/],
        ['no exit status', { status: null }, /no exit status/],
        ['a cancellation', { cancelled: true }, /was cancelled/],
    ]) {
        const w = await provisioned(t, { block: 'apparatus-vllm', faults: { calibrateProcess: process } });
        const report = await liveCases(w, ['LIVE-L3']);
        const l3 = caseOf(report, 'LIVE-L3');
        assert.equal(l3.result, 'fail', `${label}: ${JSON.stringify(l3).slice(0, 500)}`); assert.match(l3.reason, pattern, label);
        assert.equal(report.verdict, 'FAIL', label);
        const artifact = w.artifacts.get('gpu-live-l3');
        assert.equal(artifact.proposedEntry, undefined, `${label}: no entry is proposed from a calibration that did not complete`);
        assert.equal(artifact.calibration, undefined, label);
        if (!process.cancelled) {
            assert.deepEqual(w.artifacts.get('llm-l3-process-failure').label, 'The calibration', label);
            assert.equal(w.artifacts.has('llm-l3-calibration'), false, `${label}: the document is not kept as a calibration`);
        }
        nothingOwned(w);
    }
    // The prerequisite check is judged the same way.
    const pre = await provisioned(t, { block: 'apparatus-vllm', faults: { prerequisitesProcess: { status: null, signal: 'SIGKILL', timedOut: true } } });
    const preReport = caseOf(await liveCases(pre, ['LIVE-L3']), 'LIVE-L3');
    assert.equal(preReport.result, 'fail'); assert.match(preReport.reason, /The prerequisite check did not complete normally \(timed out/);
    assert.equal(toolCalls(pre, 'local_llm_runner_install').length, 0); nothingOwned(pre);
    // A normally completed BLOCKED report from the tool stays a BLOCKED report, not an error; a normal success still passes.
    const blockedByTool = await provisioned(t, { block: 'apparatus-vllm', faults: { calibrateBlocked: true } });
    const blockedEntry = caseOf(await liveCases(blockedByTool, ['LIVE-L3']), 'LIVE-L3');
    assert.equal(blockedEntry.result, 'blocked'); assert.match(blockedEntry.reason, /the calibration could not run: vllm_not_installed/);
    assert.equal(blockedByTool.artifacts.has('llm-l3-process-failure'), false); nothingOwned(blockedByTool);
    const prerequisiteBlocked = await provisioned(t, { block: 'apparatus-vllm', faults: { vllmDiskShort: true } });
    assert.match(caseOf(await liveCases(prerequisiteBlocked, ['LIVE-L3']), 'LIVE-L3').reason, /insufficient_disk/);
    const good = await provisioned(t, { block: 'apparatus-vllm' });
    assert.equal(caseOf(await liveCases(good, ['LIVE-L3']), 'LIVE-L3').result, 'pass'); nothingOwned(good);
});

// --- LLM3: stage 2 runs a model only for the tuple stage 1 pinned and the evidence production qualifies -------------
test('LLM3.stage-two-binds-the-hosts-tuple-and-the-qualifying-evidence-to-the-stage-one-pin', async t => {
    const current = { runnerLockDigest: VLLM_PINS.runnerLockDigest, driverVersion: '595.91.07', gpuPciDeviceId: '0x252010DE', computeCapability: '8.6', deviceTotalBytes: 6144 * MIB };
    const old = { ...current, driverVersion: '595.91.06' };
    const entry = (tuple, evidence) => ({ ...tuple, denominator: 'physical-device', evidenceDigest: hex(evidence) });
    // The candidate's data holds BOTH reviewed tuples; public admission qualifies the live (current) one on its own.
    const both = [entry(old, 'old evidence'), entry(current, 'current evidence')];
    const pin = (tuple, evidence, expectQualified = true) => ({ stage: 'qualified', calibration: { evidenceDigest: hex(evidence), tuple, expectQualified } });
    const run = async (vllm, options = {}) => { const w = await provisioned(t, { block: 'apparatus-vllm', vllm, qualified: true, entries: both, ...options }); return { w, l3: caseOf(await liveCases(w, ['LIVE-L3']), 'LIVE-L3') }; };
    // The stage 1 pin is the OLD tuple although the host and public admission are current: BLOCKED, and no model is launched.
    const stale = await run(pin(old, 'old evidence'));
    assert.equal(stale.l3.result, 'blocked', JSON.stringify(stale.l3).slice(0, 600));
    assert.match(stale.l3.reason, /the tuple this host reports differs from the stage 1 pin in driverVersion \(reported \{"driverVersion":"595\.91\.07"\}\)/);
    assert.deepEqual(['local_llm_runner_install', 'local_llm_run', 'local_llm_test_prompt'].map(name => toolCalls(stale.w, name).length), [0, 0, 0], 'nothing was installed or run');
    assert.equal(stale.w.fake.model.applyCalls.length, 0, 'no Apply either');
    const binding = stale.w.artifacts.get('gpu-live-l3').qualificationBinding;
    assert.deepEqual([binding.differing, binding.pinned.driverVersion, binding.actual.driverVersion], [['driverVersion'], '595.91.06', '595.91.07']);
    assert.equal(stale.l3.result === 'pass', false); nothingOwned(stale.w);
    // The matching pin (the current tuple and its own evidence) qualifies the run, and the report names that tuple.
    const match = await run(pin(current, 'current evidence'));
    assert.equal(match.l3.result, 'pass', JSON.stringify(match.l3).slice(0, 600));
    const report = match.w.artifacts.get('gpu-live-l3');
    assert.deepEqual([report.digests.qualification.tuple, report.digests.qualification.evidenceDigest], [current, hex('current evidence')]);
    assert.deepEqual([report.qualificationBinding.differing, report.qualificationResolved], [[], { qualified: true, evidenceDigest: hex('current evidence') }]);
    nothingOwned(match.w);
    // The tuple matches but the evidence the pin names is not the evidence production qualifies it with.
    const wrongEvidence = await run(pin(current, 'some other evidence'));
    assert.equal(wrongEvidence.l3.result, 'blocked'); assert.match(wrongEvidence.l3.reason, /production qualifies this host's tuple with evidence [0-9a-f]{64}, not with the stage 1 evidence /);
    assert.equal(toolCalls(wrongEvidence.w, 'local_llm_run').length, 0); nothingOwned(wrongEvidence.w);
    // A tuple production does not qualify at all.
    const none = await run(pin(current, 'current evidence'), { entries: [entry(old, 'old evidence')] });
    assert.equal(none.l3.result, 'blocked'); assert.match(none.l3.reason, /production qualifies this host's tuple by no entry/);
    assert.equal(toolCalls(none.w, 'local_llm_run').length, 0); nothingOwned(none.w);
    // The pin records no reviewed entry, yet production already qualifies the host's tuple: the pin is stale.
    const stalePin = await run(pin(current, 'current evidence', false));
    assert.equal(stalePin.l3.result, 'blocked'); assert.match(stalePin.l3.reason, /production already qualifies this host's tuple/);
    assert.equal(toolCalls(stalePin.w, 'local_llm_run').length, 0); nothingOwned(stalePin.w);
});

test('LLM3.every-tuple-field-the-stage-one-pin-carries-is-bound-to-what-the-host-reports', async t => {
    const current = { runnerLockDigest: VLLM_PINS.runnerLockDigest, driverVersion: '595.91.07', gpuPciDeviceId: '0x252010DE', computeCapability: '8.6', deviceTotalBytes: 6144 * MIB };
    // (The lock digest of a pin is refused earlier, by the profile, when it is not the pinned lock entry's.)
    for (const [field, value] of [['gpuPciDeviceId', '0x252110DE'], ['computeCapability', '8.9'], ['deviceTotalBytes', 8192 * MIB]]) {
        const tuple = { ...current, [field]: value };
        const w = await provisioned(t, { block: 'apparatus-vllm', vllm: { stage: 'qualified', calibration: { evidenceDigest: hex('e'), tuple, expectQualified: true } }, qualified: true, entries: [{ ...tuple, denominator: 'physical-device', evidenceDigest: hex('e') }] });
        const l3 = caseOf(await liveCases(w, ['LIVE-L3']), 'LIVE-L3');
        assert.equal(l3.result, 'blocked', `${field}: ${JSON.stringify(l3).slice(0, 500)}`); assert.match(l3.reason, new RegExp(`differs from the stage 1 pin in ${field}`), field);
        assert.equal(toolCalls(w, 'local_llm_run').length, 0, field); nothingOwned(w);
    }
});

// --- R2B: the runner-environment check against local-llm's own launch environment -------------------------
// The names come from captureLocalLlmRunnerEnv.mjs, which builds them from local-llm's controller and adapters.
const SHARE = { smPercent: 50, memory: '0=3072M' };
const processOf = (runner, change = {}) => {
    const env = Object.fromEntries(Object.entries(LOCAL_LLM_RUNNER_ENV.runners[runner]).map(([name, entry]) => [name, name.startsWith('CUDA_MPS_') ? { CUDA_MPS_PIPE_DIRECTORY: '/run/ploinky-mps-pipe', CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: '50', CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: '0=3072M' }[name] : entry.perStartSecret ? 'secret' : entry.value]));
    const cuda = Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('CUDA_') && name !== 'CUDA_CACHE_PATH'));
    return { pid: 7, uid: [1000, 1000, 1000, 1000], envNames: Object.keys(env).sort(), cuda, ...change };
};

test('R2B.secret-names-match-whole-underscore-words-and-the-products-own-emitted-names-are-allowed', async t => {
    // vLLM's TIKTOKEN_ENCODINGS_BASE (a vocabulary path, always set by buildLaunch) is not a secret.
    assert.ok(Object.hasOwn(LOCAL_LLM_RUNNER_ENV.runners.vllm, 'TIKTOKEN_ENCODINGS_BASE'), 'buildLaunch emits it');
    for (const name of ['TIKTOKEN_ENCODINGS_BASE', 'TRITON_CACHE_DIR', 'VLLM_NO_USAGE_STATS', 'DO_NOT_TRACK', 'HF_HUB_OFFLINE', 'PATH', 'HOME', 'LD_LIBRARY_PATH', 'MONKEY_BUSINESS', 'KEYBOARD', 'TOKENIZERS_PARALLELISM']) assert.equal(isSecretName(name), false, name);
    for (const name of ['HF_TOKEN', 'FOO_API_KEY', 'API_KEY', 'TOKEN', 'LOCAL_LLM_CONTROL_TOKEN', 'db_password', 'AWS_SECRET_ACCESS_KEY', 'SESSION_COOKIE', 'FOO_APIKEY']) assert.equal(isSecretName(name), true, name);
    // The names the real vLLM and llama.cpp launches emit pass; VLLM_API_KEY is vLLM's own per-start secret and only vLLM's.
    for (const runner of ['llama.cpp', 'vllm']) assert.deepEqual(runnerEnvironmentProblems(processOf(runner), { share: SHARE, runnerId: runner }), [], runner);
    assert.ok(runnerProductNames('vllm').has('VLLM_API_KEY') && !runnerProductNames('llama.cpp').has('VLLM_API_KEY'));
    assert.match(runnerEnvironmentProblems(processOf('llama.cpp', { envNames: [...processOf('llama.cpp').envNames, 'VLLM_API_KEY'] }), { share: SHARE, runnerId: 'llama.cpp' }).join(), /secret-looking variables: VLLM_API_KEY/);
    for (const name of ['HF_TOKEN', 'FOO_API_KEY']) assert.match(runnerEnvironmentProblems(processOf('vllm', { envNames: [...processOf('vllm').envNames, name] }), { share: SHARE, runnerId: 'vllm' }).join(), new RegExp(`secret-looking variables: ${name}`), name);
    // Through the executors: the correct stage 2 run passes with TIKTOKEN_ENCODINGS_BASE in the runner, and a leaked HF_TOKEN fails it.
    const vllm = stageTwo(true);
    const good = await provisioned(t, { block: 'apparatus-vllm', vllm, qualified: true });
    assert.equal(caseOf(await liveCases(good, ['LIVE-L3']), 'LIVE-L3').result, 'pass');
    assert.ok(good.artifacts.get('gpu-live-l3').runner[0].envNames.includes('TIKTOKEN_ENCODINGS_BASE'));
    nothingOwned(good);
    const leaked = await provisioned(t, { block: 'apparatus-vllm', vllm, qualified: true, faults: { runnerExtraEnv: ['HF_TOKEN'] } });
    const failed = caseOf(await liveCases(leaked, ['LIVE-L3']), 'LIVE-L3');
    assert.equal(failed.result, 'fail'); assert.match(failed.reason, /secret-looking variables: HF_TOKEN/);
    nothingOwned(leaked);
});
