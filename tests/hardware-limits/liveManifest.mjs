// Concrete run manifests and their human approval summaries for the blocks
// with implemented executors (mac-cpu: LIVE-C1/C2; apparatus-cpu: LIVE-A1;
// apparatus-mps: LIVE-P1 to LIVE-P4).
// Building a manifest reads local files only: no engine, SSH or network call.
// A manifest is a proposal; only separate execution-time authorization
// bindings (provision, live, cleanup) let the runner act on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WANTED_CONTROLLERS } from '../../ploinky-box/entrypoint/cgroupDelegation.mjs';
import { ENGINE_CONNECTIONS_ARGV, ENGINE_INFO_ARGV, HOST_RECORD_DIRECTORIES, IMAGE_REF, OWNER_MARKER, UNIX_SOCKET_PATH_LIMIT, WORKSPACE_SOCKET_NAME, digest, keys, liveSourceDigest, AGENT_INSPECT, INSPECT } from './liveCommon.mjs';
import { FIXTURE_AGENT_COMMAND, FIXTURE_REPOSITORY, GPU_PROBE_TARGET, fixtureContainerName, fixtureManifest, fixturePlan, proposedWorkspaceIdentity, rewriteLlmManifest, startArgs } from './liveFixture.mjs';
import { INSTALL_SAMPLES_HEAD, INSTALL_SAMPLES_TAIL, LLM_MODELS, LLM_REF, LLM_REPOSITORY, LLM_SOURCE_DIRECTORY } from './liveLlmNames.mjs';
import {
    INFERENCE_CADENCE, INFERENCE_TOLERANCE, INSUFFICIENT_RAM, L1_PROMPT, LLM_BUDGET, LLM_IMAGE_DIGESTS, LLM_IMAGE_FILES, LLM_LEAF_SAMPLE, LLM_RUNNER_PROCESSES, LLM_TOOL_CALL, PLAYGROUND_DECISION, VLLM_SHARE, insufficientMemoryPercent, llmToolWords, vllmToolWords,
} from './liveLlmCommands.mjs';
import { gpuQueryArgv } from './liveGpuGate.mjs';
import {
    ADMIN_REQUEST, GPU_SHARES, MPS_CLIENT_PIPE, PROBE_FILE, TIGHTER_CLIENT, controlHelperRunArgv, probeBoundMiB, probeExecArgv, shareMemoryMiB,
} from './liveGpuCommands.mjs';
import { AUTHORITY_HELPER_PROGRAM, DELAYED_ALLOCATION } from './liveHelperCommands.mjs';
import { remoteRoot, remoteReportName } from './liveStage.mjs';
import { DOCUMENT_SUFFIXES, GPU_TOLERATED_MAX, GPU_TOLERATED_MAX_MIB } from './fixtures.mjs';
import { sshOptions } from './liveRemote.mjs';

export const CONCRETE_BLOCKS = Object.freeze({
    'mac-cpu': { platform: 'darwin', remote: false, cases: ['LIVE-C1', 'LIVE-C2'] },
    'apparatus-cpu': { platform: 'linux', remote: true, cases: ['LIVE-A1'] },
    // C1 and C2 on native Linux (release plan C8b): the same owned CPU fixture and executors as mac-cpu, on the apparatus.
    'apparatus-core': { platform: 'linux', remote: true, cases: ['LIVE-C1', 'LIVE-C2'] },
    // C6: the Router authority helper's post-probe peak, measured through the product's observation seam (inside the owned Box).
    'apparatus-authority': { platform: 'linux', remote: true, cases: ['LIVE-C6'] },
    'apparatus-mps': { platform: 'linux', remote: true, cases: ['LIVE-P1', 'LIVE-P2', 'LIVE-P3', 'LIVE-P4'], gpu: true },
    // The local-llm candidate in its own owned workspace, behind the same idle gate: budgets and a llama.cpp
    // model (L1, L2), and vLLM under an MPS share in two stages (L3).
    'apparatus-local-llm': { platform: 'linux', remote: true, cases: ['LIVE-L1', 'LIVE-L2'], gpu: true, llm: true },
    'apparatus-vllm': { platform: 'linux', remote: true, cases: ['LIVE-L3'], gpu: true, llm: true, vllm: true },
});
// The pass condition of each executor case, copied from the spec's section 15.4 row (and its amendment) without weakening, so the
// approver sees exactly what a PASS means. `row` names the spec line; `procedure` is what the runner does; `passes` the observable
// artifact; `evidence` the files the case writes. The summary prints every selected case that has an entry.
export const CASE_PASS_CONDITIONS = Object.freeze({
    'LIVE-C1': {
        row: 'spec 15.4 LIVE-C1 (:1322) with amendment A4',
        procedure: 'The owned CPU fixture (memory, cpu and pids agents, 64m/0.5 CPU/64 pids, readiness none) is started with the gate on and started again without the flag; the Box and workload cgroups and owners are inspected read-only (no write is ever attempted).',
        passes: 'Saved gate on; PID 1 and the core exec under /ploinky/core; the cgroup root directory and its cgroup.procs, cgroup.subtree_control and cgroup.threads are owned by uid 0 (A4: every other present interface file at / is owned by uid 0 or by the Box runtime uid 1000, nothing else), /ploinky/core entirely uid 0, the delegated files and parents uid 1000; no aggregate cap; exact leaf values and conmon placement compatible with lifecycle and cleanup.',
        evidence: 'core-layout observation in the run manifest; repeat-gate-on-start and repeat-saved-gate-start tails; nested-containers listings',
    },
    'LIVE-C2': {
        row: 'spec 15.4 LIVE-C2 (:1323)',
        procedure: 'Touched allocations above the leaf memory cap are made inside the memory agent while the leaf events are observed from outside the limited leaf; a bounded CPU burn and a process-count pressure run in the cpu and pids agents. The runner does not assume which process the kernel OOM kills.',
        passes: 'memory.max=67108864; memory.swap.max=0; cpu.max=50000 100000 (the exact-integer comparison tolerates the engine truncating the quota by 1 microsecond); pids.max=64; the leaf oom_kill delta, the throttled delta and the pids max-event delta are all positive on the SAME leaf identity (dev and inode) as the container identity.',
        evidence: 'per-agent same-leaf samples and post-exit samples',
    },
    'LIVE-C6': {
        row: 'spec 15.4 LIVE-C6 (:1327)',
        procedure: 'A reviewed fixed program runs inside the owned Box as the Box user through the product modules at /opt/ploinky: it prepares the fixture agent\'s exact managed-network plan, captures its exact edge generation lease and runs the product\'s own attestRouterAuthority and runContainerAuthorityProbe unchanged, adding only the post-probe/pre-cleanup observation seam. A first run is the real probe; a second run delays and allocates 16 MiB inside the helper\'s probe exec (after 2000 ms) to prove the sampling order. The program text is fixed in tests/hardware-limits/liveHelperCommands.mjs (sha256:' + crypto.createHash('sha256').update(AUTHORITY_HELPER_PROGRAM).digest('hex') + ').',
        passes: 'Real attestation success (an attestation identity and exactly two observations); an immutable helper container and image ID; the helper is placed (placement enforced) in the delegated hierarchy and has memory.max=67108864 (64m); the post-probe observation runs after the probe exec ended and its observation was consumed, before cleanup; the real probe\'s final memory.peak is at most 48 MiB for 64m (otherwise the creation and the proof are updated together to 128m with at most 96 MiB in a reviewed change and a new candidate, never a silent increase); the delayed probe\'s peak carries its late allocation (the real peak plus at least 8 MiB) and its exec lasted at least the delay; no authority helper container remains afterwards.',
        evidence: 'authority-helper-real and authority-helper-delayed artifacts (events with microsecond timestamps, helper identity, leaf readings), authority-helper-cleanup',
    },
});

export const DEADLINES = Object.freeze({
    coreMs: 30000, startMs: 20 * 60 * 1000, destroyMs: 5 * 60 * 1000, fullGraphMs: 20 * 60 * 1000,
    modelLoadMs: 20 * 60 * 1000, cleanupMs: 5 * 60 * 1000, stagingMs: 10 * 60 * 1000, blockMs: 20 * 60 * 1000,
});
// The GPU block needs longer than the CPU ones: P3 alone runs six Applies.
export const GPU_DEADLINES = Object.freeze({ ...DEADLINES, blockMs: 24 * 60 * 1000 });
// The local-llm blocks (L1, L2) load a model after two Applies, inside the GPU block deadline. The vLLM block (L3) installs 3.9 GB of
// wheels and loads a 2.7 GB snapshot: it has its own deadlines, VLLM_DEADLINES below, which the SSH dispatch allows (up to 18,000,000 ms
// for the block, cleanup and margin), and the install and the load are bounded inside them. An install or a load that does not fit
// is BLOCKED with the progress it made, never an indefinite poll.
export const LLM_DEADLINES = Object.freeze({ ...GPU_DEADLINES });
// The vLLM install is bounded by throughput, not by a short clock: a hard cap of 3.5 h for the pinned 3.88 GB wheel set (the product
// measured about 0.4 MB/s, a raw PyPI probe 1.5 to 2 MB/s) and a stall window: BLOCKED when the download shows no progress for 10 minutes.
// The block deadline holds the cap, the prerequisites, the calibration, the model load and a margin.
export const VLLM_INSTALL_CAP_MS = 3.5 * 60 * 60 * 1000;
export const VLLM_INSTALL_STALL_MS = 10 * 60 * 1000;
export const VLLM_DEADLINES = Object.freeze({ ...GPU_DEADLINES, blockMs: 15_300_000, installMs: VLLM_INSTALL_CAP_MS, installStallMs: VLLM_INSTALL_STALL_MS, modelLoadMs: 8 * 60 * 1000 });
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE = /^\/[A-Za-z0-9/_.-]+$/;
const canonicalFile = file => path.isAbsolute(file) && fs.realpathSync(file) === file && fs.statSync(file).isFile();

// Operator-supplied pins from earlier read-only observation. prepare-live
// verifies every local file pin it can read; remote and engine-service pins
// are rechecked by the runner on arrival, before any mutation.
export function validatePins(value, block) {
    const spec = CONCRETE_BLOCKS[block];
    keys(value, ['schema', 'host', 'node', 'engine', 'boxImage'], 'pins', ['ssh', 'workspaceParentRoot', 'ports', 'gpu', 'llm']);
    if (value.schema !== 1) throw new Error('Unsupported pins schema');
    keys(value.host, ['hostname', 'platform', 'home'], 'pinned host');
    keys(value.node, ['path', 'digest'], 'pinned node');
    keys(value.engine, ['path', 'digest', 'identityDigest'], 'pinned engine');
    if (!/^[A-Za-z0-9.-]{1,255}$/.test(value.host.hostname) || value.host.platform !== spec.platform || !SAFE.test(value.host.home)
        || !SAFE.test(value.node.path) || !SAFE.test(value.engine.path) || ![value.node.digest, value.engine.digest, value.engine.identityDigest].every(item => HASH.test(item))
        || !IMAGE_REF.test(value.boxImage)) throw new Error('Invalid pins');
    if (value.ports !== undefined) {
        keys(value.ports, ['tcp', 'udp'], 'pinned ports');
        if (![value.ports.tcp, value.ports.udp].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || value.ports.tcp === value.ports.udp) throw new Error('Invalid pinned ports');
    }
    // The observed GPU device and NVIDIA tools: required for the GPU block and
    // refused for every other (a CPU block never names a GPU).
    if (spec.gpu) {
        keys(value.gpu, ['uuid', 'name', 'driverVersion', 'memoryMiB', 'expectedSmCount', 'smi', 'mpsControl', 'mpsServer'], 'pinned GPU');
        for (const tool of ['smi', 'mpsControl', 'mpsServer']) {
            keys(value.gpu[tool], ['path', 'digest'], `pinned GPU tool ${tool}`);
            if (!SAFE.test(value.gpu[tool].path) || !HASH.test(value.gpu[tool].digest)) throw new Error(`Invalid pinned GPU tool ${tool}`);
        }
        if (!/^GPU-[a-fA-F0-9-]{8,64}$/.test(value.gpu.uuid) || typeof value.gpu.name !== 'string' || !value.gpu.name || value.gpu.name.length > 256
            || !/^[0-9]+(?:\.[0-9]+)+$/.test(value.gpu.driverVersion) || !Number.isInteger(value.gpu.memoryMiB) || value.gpu.memoryMiB < 1024
            || !Number.isInteger(value.gpu.expectedSmCount) || value.gpu.expectedSmCount < 1) throw new Error('Invalid pinned GPU device');
    } else if (value.gpu !== undefined) throw new Error('A non-GPU block names no GPU');
    // The immutable local-llm image (and, for vLLM, the pins of the image's lock entry) the operator observed.
    if (spec.llm) {
        keys(value.llm, ['image'], 'pinned local-llm', spec.vllm ? ['vllm'] : []);
        if (!IMAGE_REF.test(value.llm.image)) throw new Error('The local-llm image must be an immutable digest reference');
        if (spec.vllm) {
            keys(value.llm.vllm, ['version', 'runnerLockDigest', 'files', 'downloadBytes'], 'pinned vLLM lock entry');
            vllmToolWords('prerequisites', { pins: value.llm.vllm });
        }
    } else if (value.llm !== undefined) throw new Error('Only the local-llm blocks name a local-llm image');
    if (spec.remote) {
        if (value.workspaceParentRoot !== undefined) throw new Error('Apparatus workspaces live under the remote run root');
        keys(value.ssh, ['alias', 'sshBinary', 'address', 'hostKeyAlias', 'user', 'knownHosts', 'identityFile'], 'pinned SSH');
        if (!/^[A-Za-z0-9.-]{1,64}$/.test(value.ssh.alias) || !canonicalFile(value.ssh.sshBinary) || !canonicalFile(value.ssh.knownHosts)
            || !(value.ssh.identityFile === null || SAFE.test(value.ssh.identityFile))) throw new Error('Invalid SSH pins');
    } else {
        if (value.ssh !== undefined && value.ssh !== null) throw new Error('A local block has no SSH target');
        if (!SAFE.test(value.workspaceParentRoot || '') || fs.realpathSync(value.workspaceParentRoot) !== value.workspaceParentRoot) throw new Error('The workspace parent root must be canonical');
        // Local pins are verified now; the runner rechecks them before acting.
        if (value.host.hostname !== os.hostname() || value.host.platform !== process.platform || value.host.home !== fs.realpathSync(os.homedir())) throw new Error('Pinned host is not this host');
        for (const [file, expected] of [[value.node.path, value.node.digest], [value.engine.path, value.engine.digest]]) {
            if (!canonicalFile(file) || digest(fs.readFileSync(file)) !== expected) throw new Error(`Local pin does not match ${file}`);
        }
    }
    return value;
}

// The immutable fixture image: the ploinky-node digest on line 2 of
// Explorer's explorer/manifest.json.
export function explorerFixtureImage(explorerRoot) {
    const file = path.join(explorerRoot, 'explorer', 'manifest.json');
    const text = fs.readFileSync(file, 'utf8');
    const image = JSON.parse(text).container;
    if (!/^docker\.io\/assistos\/ploinky-node@sha256:[a-f0-9]{64}$/.test(image) || !text.split('\n')[1]?.includes(`"${image}"`)) {
        throw new Error('Explorer manifest line 2 does not pin the ploinky-node image digest');
    }
    return image;
}

export function selectPorts(pins) {
    if (pins.ports) return { tcp: pins.ports.tcp, udp: pins.ports.udp };
    return { tcp: crypto.randomInt(20000, 30000), udp: crypto.randomInt(30000, 40000) };
}

// The run's workspace: under the remote run root for a staged block, else
// under the pinned short task-owned workspaceParentRoot.
export function proposedWorkspace(block, pins, runId) {
    const spec = CONCRETE_BLOCKS[block];
    if (!spec) throw new Error(`Block ${block} has no implemented executor`);
    const parent = spec.remote ? remoteRoot(pins.host.home, runId) : path.join(pins.workspaceParentRoot, `ploinky-hwl-${runId}`);
    return { parent, path: path.join(parent, 'workspace') };
}

// The pins of the local-llm candidate carried in the frozen payload (.hwl-local-llms/local-llm): its
// tree digest, its manifest before and after the image is pinned, and the two models' catalog pins
// the live cases compare the agent's own catalog with.
export function describeLlmCandidate({ root, sourceRoot, revision, image }) {
    const local = path.join(root, LLM_SOURCE_DIRECTORY, 'local-llm');
    const bytes = fs.readFileSync(path.join(local, 'manifest.json'));
    const catalog = JSON.parse(fs.readFileSync(path.join(local, 'catalog', 'models.json'), 'utf8'));
    const model = id => { const found = catalog.models.find(entry => entry.id === id); if (!found) throw new Error(`The local-llm catalog has no model ${id}`); return found; };
    const gguf = model(LLM_MODELS.small).sources.gguf;
    const hf = model(LLM_MODELS.awq).sources.hf;
    const files = hf.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 }));
    return {
        revision, sourcePath: `${sourceRoot}/${LLM_SOURCE_DIRECTORY}/local-llm`, treeDigest: liveSourceDigest(local),
        manifest: { originalContainer: JSON.parse(bytes).container, originalDigest: digest(bytes), rewrittenDigest: digest(rewriteLlmManifest(bytes, image)) },
        models: {
            small: { id: LLM_MODELS.small, repo: gguf.repo, file: gguf.file, commit: gguf.commit, size: gguf.size, sha256: gguf.sha256 },
            awq: { id: LLM_MODELS.awq, repo: hf.repo, commit: hf.commit, size: files.reduce((sum, file) => sum + file.size, 0), files },
        },
    };
}

// `vllm` is the stage of an apparatus-vllm run: { stage: 'calibration' } or
// { stage: 'qualified', calibration: { evidenceDigest, tuple, expectQualified } }.
export function buildConcreteManifest({ block, runId, configDigest, casesDigest, documentSuffix, pins, candidate, image, ports, unsupported, vllm = null }) {
    const spec = CONCRETE_BLOCKS[block];
    if (!spec) throw new Error(`Block ${block} has no implemented executor`);
    if (Boolean(spec.vllm) !== Boolean(vllm)) throw new Error(spec.vllm ? 'The vLLM block needs its stage' : 'Only the vLLM block has stages');
    const remote = spec.remote;
    const root = remote ? remoteRoot(pins.host.home, runId) : null;
    const { parent, path: workspacePath } = proposedWorkspace(block, pins, runId);
    const identity = proposedWorkspaceIdentity(workspacePath);
    const sourceRoot = remote ? `${root}/source` : candidate.root;
    const candidateFile = path.join(candidate.root, 'ploinky-box', 'bin', 'ploinky-box.mjs');
    const agents = fixturePlan(spec.cases);
    // The local-llm candidate runs from its own immutable image, not the Explorer's fixture image.
    if (spec.llm) image = pins.llm.image;
    const llmCandidate = spec.llm ? describeLlmCandidate({ root: candidate.root, sourceRoot, revision: candidate.llm.revision, image }) : null;
    const execution = {
        protocol: 'owned-fixture-v1',
        host: { ...pins.host },
        node: { ...pins.node },
        candidate: { path: path.join(sourceRoot, 'ploinky-box', 'bin', 'ploinky-box.mjs'), digest: digest(fs.readFileSync(candidateFile)) },
        engine: { ...pins.engine },
        source: { root: sourceRoot, digest: candidate.digest },
        workspace: null,
        box: null,
        agents: [],
        cases: [...spec.cases],
        fixtures: spec.llm ? { llm: { ref: LLM_REF } } : spec.gpu ? { gpu: { ref: `${FIXTURE_REPOSITORY}/${agents[0].name}` } } : { cpu: { ref: `${FIXTURE_REPOSITORY}/${agents[0].name}` } },
        provision: {
            revision: candidate.revision, repository: spec.llm ? LLM_REPOSITORY : FIXTURE_REPOSITORY, image, boxImage: pins.boxImage, agents,
            workspace: { parent, parentMode: remote ? 'staged' : 'create', path: workspacePath },
        },
    };
    if (spec.llm) {
        const { models, ...plan } = llmCandidate;
        execution.gpu = { ...pins.gpu };
        execution.provision.gpu = { uuid: pins.gpu.uuid, grantAgents: [LLM_REF] };
        execution.provision.llm = plan;
        execution.llm = {
            image, revision: llmCandidate.revision, models, budget: { ...LLM_BUDGET, gpu: { ...LLM_BUDGET.gpu } }, playground: { ...PLAYGROUND_DECISION },
            vllm: spec.vllm ? { stage: vllm.stage, share: { ...VLLM_SHARE }, pins: { ...pins.llm.vllm }, calibration: vllm.stage === 'qualified' ? vllm.calibration : null } : null,
        };
    } else if (spec.gpu) {
        // The CUDA probe file travels in the frozen candidate; its digest is pinned
        // here and rechecked when the runner writes it into the probe agent.
        const probeSource = `${sourceRoot}/tests/hardware-limits/${PROBE_FILE}`;
        const probeDigest = digest(fs.readFileSync(path.join(candidate.root, 'tests', 'hardware-limits', PROBE_FILE)));
        execution.gpu = { ...pins.gpu, probe: { sourcePath: probeSource, digest: probeDigest } };
        execution.provision.gpu = {
            uuid: pins.gpu.uuid, grantAgents: agents.filter(agent => agent.name !== 'cpu').map(agent => `${FIXTURE_REPOSITORY}/${agent.name}`),
            probe: { sourcePath: probeSource, digest: probeDigest, target: GPU_PROBE_TARGET },
        };
    }
    const target = {
        engine: { binary: pins.engine.path, kind: 'podman', identity: pins.engine.identityDigest },
        ssh: remote ? { alias: pins.ssh.alias, expectedAddress: pins.ssh.address, expectedHostKeyAlias: pins.ssh.hostKeyAlias } : null,
        note: 'Proposal only. Each action (provision, live, cleanup) needs its own separate execution-time authorization binding over the exact manifest bytes; no file grants permission.',
        cases: [...spec.cases],
        unsupported,
        execution,
    };
    if (remote) {
        target.remote = {
            sshBinary: pins.ssh.sshBinary, sshDigest: digest(fs.readFileSync(pins.ssh.sshBinary)), address: pins.ssh.address,
            hostKeyAlias: pins.ssh.hostKeyAlias, user: pins.ssh.user, knownHosts: pins.ssh.knownHosts,
            knownHostsDigest: digest(fs.readFileSync(pins.ssh.knownHosts)), identityFile: pins.ssh.identityFile,
            runPath: `${root}/run/run_${documentSuffix}.json`, authorizationPath: `${root}/run/authorization_provision.json`,
        };
        target.stage = { root, payloadPath: candidate.payload.path, payloadDigest: candidate.payload.digest, payloadBytes: candidate.payload.bytes };
    }
    const run = {
        schema: 1, runId, configDigest, casesDigest, block, target, state: 'proposed',
        workspace: { proposedParent: parent, proposedPath: workspacePath, instance: identity.instance, pathHash: identity.pathHash },
        ports: { tcp: ports.tcp, udp: ports.udp },
        deadlines: { ...(spec.vllm ? VLLM_DEADLINES : spec.llm ? LLM_DEADLINES : spec.gpu ? GPU_DEADLINES : DEADLINES) },
        images: [
            { role: 'fixture-agent', ref: image, source: spec.llm ? 'operator pins (local-llm image)' : 'AssistOSExplorer explorer/manifest.json line 2' },
            { role: 'box', ref: pins.boxImage, source: 'operator pins' },
        ],
        ownedBoxes: [], ownedProcesses: [], ownedPaths: [], preInventory: {}, operations: [],
        ...(spec.gpu ? { toleratedProcesses: [] } : {}),
        cleanup: { state: 'not-started', steps: [], failures: [] },
    };
    target.plan = plannedCommands(run);
    return run;
}

// The full planned command list. Identifiers known only after provisioning
// appear as placeholders; the runner builds each argv from the same helpers.
export function plannedCommands(run) {
    const profile = run.target.execution;
    const plan = profile.provision;
    const engine = profile.engine.path;
    const node = profile.node.path;
    const workspace = plan.workspace.path;
    const box = '<BOX_ID>';
    const core = ['container', 'exec', '--user', 'podman', box];
    const nested = [...core, 'podman', '--cgroup-manager=cgroupfs'];
    const env = { PLOINKY_BOX_HARDWARE_LIMITS: 'on', PLOINKY_BOX_IMAGE: plan.boxImage };
    const ps = ['container', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}'];
    const provision = [
        { id: 'engine-identity', binary: engine, argv: [...ENGINE_INFO_ARGV], deadlineMs: run.deadlines.coreMs, note: 'Stable facts only: host arch/os/hostname/kernel, engine version, store graphRoot/runRoot and the service socket; a remote client adds its one default connection (name and URI). A missing fact refuses the run.' },
        { id: 'engine-connection', binary: engine, argv: [...ENGINE_CONNECTIONS_ARGV], deadlineMs: run.deadlines.coreMs, note: 'Only when the service is remote.' },
        { id: 'host-records-absent', action: `Refuse unless ${HOST_RECORD_DIRECTORIES.map(name => `~/.ploinky-box/${name}/${run.workspace.instance}{,.json}`).join(', ')} are all absent` },
        ...(profile.gpu ? [{ id: 'gpu-initial-gate', binary: profile.gpu.smi.path, argv: gpuQueryArgv(profile.gpu.uuid), deadlineMs: run.deadlines.coreMs, note: 'The initial GPU idle gate, before anything is created: success, strict XML, the pinned UUID and memory, compute mode Default, a supported activity inventory and an empty process list, except for at most ONE recorded graphics-only (type G) display process of at most 64 MiB, present at this first check with a proven host identity (amendment A5), which is recorded in toleratedProcesses of the run manifest. Nothing else runs if it is not met.' }] : []),
        ...(plan.workspace.parentMode === 'create'
            ? [{ id: 'workspace-parent-create', action: `mkdir ${plan.workspace.parent} (0700, refuse if it exists) and write ${OWNER_MARKER}=${run.runId}` }]
            : [{ id: 'workspace-parent-staged', action: `Require the staged private root ${plan.workspace.parent} (0700, marker ${run.runId})` }]),
        { id: 'workspace-create', action: `mkdir ${workspace} (0755, refuse if it exists), write ${OWNER_MARKER}, record uid/dev/ino` },
        { id: 'port-preflight', action: `Bind-test TCP 127.0.0.1:${run.ports.tcp} and 0.0.0.0:${run.ports.tcp}, UDP 0.0.0.0:${run.ports.udp}; any collision aborts` },
        { id: 'pre-inventory', binary: engine, argv: ps, deadlineMs: run.deadlines.coreMs },
        { id: 'pre-inventory-inspect', binary: engine, argv: ['container', 'inspect', '--format', INSPECT, '<CONTAINER_ID>'], deadlineMs: run.deadlines.coreMs },
        ...(plan.llm
            ? [{ id: 'fixture-write-local-llm', action: `Copy the frozen local-llm tree ${plan.llm.sourcePath} (${plan.llm.treeDigest}, revision ${plan.llm.revision}) byte for byte to ${workspace}/.ploinky/repos/${LLM_REPOSITORY}/local-llm; its manifest (${plan.llm.manifest.originalDigest}, image ${plan.llm.manifest.originalContainer}) is rewritten to the immutable image ${plan.image} and must then be ${plan.llm.manifest.rewrittenDigest}. The model data and the runner caches are created by the agent under ${workspace}/.data/local-llm and ${workspace}/.data/shared, inside the new workspace only` }]
            : plan.agents.map(agent => ({ id: `fixture-write-${agent.name}`, action: `Write ${workspace}/.ploinky/repos/${FIXTURE_REPOSITORY}/${agent.name}/manifest.json`, content: fixtureManifest(agent, { image: plan.image, agents: plan.agents }) }))),
        ...(profile.gpu ? [
            ...(profile.gpu.probe ? [{ id: 'fixture-write-probe-file', action: `Copy ${profile.gpu.probe.sourcePath} (${profile.gpu.probe.digest}) to ${workspace}/.ploinky/repos/${FIXTURE_REPOSITORY}/${GPU_PROBE_TARGET}; the nested engine stages it at /code/${PROBE_FILE}` }] : []),
            { id: 'gpu-grant', binary: node, argv: [profile.candidate.path, 'gpu', 'grant', ...plan.gpu.grantAgents.flatMap(ref => ['--agent', ref])], cwd: workspace, env: {}, deadlineMs: run.deadlines.coreMs,
                note: 'The supported product path: records the grant under ~/.ploinky-box/gpu-grants and discovers the host driver. No Box exists yet, so the next start applies it.' },
        ] : []),
        { id: 'fixture-start', binary: node, argv: startArgs(profile, run.ports), cwd: workspace, env, deadlineMs: run.deadlines.startMs,
            note: 'Production start creates the gate-on Box and runs its bounded root preparation before graph work; this is the declared provisioning step that may change cgroup state.' },
        { id: 'box-inventory', binary: engine, argv: ps, deadlineMs: run.deadlines.coreMs },
        { id: 'box-inspect', binary: engine, argv: ['container', 'inspect', '--format', INSPECT, '<NEW_CONTAINER_ID>'], deadlineMs: run.deadlines.coreMs },
        ...plan.agents.map(agent => ({ id: `agent-inspect-${agent.name}`, binary: engine, argv: [...nested, 'container', 'inspect', '--format', AGENT_INSPECT, fixtureContainerName(workspace, agent.name)], deadlineMs: run.deadlines.coreMs })),
        { id: 'host-records', action: 'Record the exact host records of this instance that now exist (path, type, uid, dev, ino)' },
    ];
    const live = [];
    const ports = ['--port', String(run.ports.tcp), '--udp-port', String(run.ports.udp)];
    if (profile.cases.includes('LIVE-C1')) live.push(
        { id: 'C1-repeat-gate-on-start', binary: node, argv: [profile.candidate.path, ...ports, 'start', profile.fixtures.cpu.ref], cwd: workspace, env, deadlineMs: run.deadlines.startMs },
        { id: 'C1-repeat-saved-gate-start', binary: node, argv: [profile.candidate.path, ...ports, 'start', profile.fixtures.cpu.ref], cwd: workspace, env: { PLOINKY_BOX_IMAGE: plan.boxImage }, deadlineMs: run.deadlines.startMs },
        { id: 'C1-core-layout', binary: engine, argv: [...core, 'node', '-e', '<CORE_LAYOUT>'], deadlineMs: run.deadlines.coreMs, note: `Read-only observation as uid 1000, persisted before assertion; required controllers = ${WANTED_CONTROLLERS.join('/')} offered by the root cgroup.controllers` },
        { id: 'C1-placement-and-leaf', binary: engine, argv: [...core, 'node', '-e', '<MEMBERSHIP|LEAF_OBSERVATION>', '<PID|LEAF>'], deadlineMs: run.deadlines.coreMs },
    );
    if (profile.cases.includes('LIVE-C2')) for (const role of ['memory', 'cpu', 'pids']) live.push(
        { id: `C2-${role}-pressure`, binary: engine, argv: [...nested, 'container', 'exec', `<${role.toUpperCase()}_AGENT_ID>`, 'node', '-e', `<${role.toUpperCase()}_PRESSURE>`], deadlineMs: 15000 },
        { id: `C2-${role}-observer`, binary: engine, argv: [...core, 'node', '-e', '<LEAF_OBSERVER>', '<VERIFIED_LEAF>'], deadlineMs: 5000 },
    );
    if (profile.cases.includes('LIVE-C6')) live.push(
        { id: 'C6-helper-real', binary: engine, argv: ['container', 'exec', '--user', 'podman', '--workdir', workspace, '--env', `PLOINKY_ROUTER_HOST_PORT=${run.ports.tcp}`, box, 'node', '--input-type=module', '-e', '<AUTHORITY_HELPER_PROGRAM>', '<PARAMS mode=real>'], deadlineMs: 120000, note: 'Runs the product\'s own attestation and helper probe once, with the post-probe observation seam; reads the helper leaf\'s memory.peak/max' },
        { id: 'C6-helper-delayed', binary: engine, argv: ['container', 'exec', '--user', 'podman', '--workdir', workspace, '--env', `PLOINKY_ROUTER_HOST_PORT=${run.ports.tcp}`, box, 'node', '--input-type=module', '-e', '<AUTHORITY_HELPER_PROGRAM>', `<PARAMS mode=delayed bytes=${DELAYED_ALLOCATION.bytes} delayMs=${DELAYED_ALLOCATION.delayMs}>`], deadlineMs: 120000, note: 'The same run with an allocating, delayed probe exec to prove the sampling order' },
        { id: 'C6-helper-cleanup-proof', binary: engine, argv: [...nested, 'container', 'ps', '--all', '--no-trunc', '--filter', 'label=io.assistos.ploinky.authority-helper', '--format', '{{.ID}}'], deadlineMs: run.deadlines.coreMs, note: 'No authority helper container remains' },
    );
    if (profile.cases.includes('LIVE-A1')) live.push(
        { id: 'A1-held-allocation', binary: engine, argv: [...nested, 'container', 'exec', '<MEMORY_AGENT_ID>', 'node', '-e', '<HELD_ALLOCATION>', run.runId], deadlineMs: 25000 },
        { id: 'A1-handshake', binary: engine, argv: [...nested, 'container', 'exec', '<MEMORY_AGENT_ID>', 'node', '-e', '<ALLOCATION_HANDSHAKE>', run.runId, 'observe|release'], deadlineMs: 5000 },
        { id: 'A1-leaf-observer', binary: engine, argv: [...core, 'node', '-e', '<LEAF_OBSERVATION>', '<VERIFIED_LEAF>'], deadlineMs: 5000 },
    );
    if (profile.llm) live.push(...llmPlan(run).commands);
    else if (profile.gpu) live.push(...gpuPlan(run).commands);
    const cleanup = [
        ...(profile.gpu ? [{ id: 'gpu-stop-owned-helpers', action: 'Remove the control helpers by exact recorded identity (name and run label re-proved first). The probes and the holder end with their commands or with the Box; nothing foreign is ever signalled.' }] : []),
        { id: 'revalidate-identity', binary: engine, argv: [...ENGINE_INFO_ARGV], action: 'Recheck engine identity (with its default connection when remote), workspace receipt and marker, or the run-derived quarantine' },
        { id: 'destroy-box', binary: node, argv: [profile.candidate.path, 'destroy', '--delete-cache'], cwd: workspace, deadlineMs: run.deadlines.destroyMs, action: 'Only when the recorded Box exists, or, when its receipt was never persisted, the one container found by the name and path-hash label recorded at fixture-start (`container ps --all --filter label=<path-hash label>=<hash> --format "{{.ID}} {{.Names}}"`) that also proves the Box role and a mount of exactly this workspace; then prove it absent and compare the unrelated inventory' },
        { id: 'host-records', action: `Remove only recorded ~/.ploinky-box/{${HOST_RECORD_DIRECTORIES.join(',')}}/${run.workspace.instance}[.json]; any unrecorded one refuses the step` },
        { id: 'workspace-removal', action: `Prove no container mounts ${workspace}; rename it to ${path.join(path.dirname(workspace), `.hwl-removing-${run.runId}`)}; reprove uid/dev/ino and marker; remove (marker last)` },
        ...(plan.workspace.parentMode === 'create' ? [{ id: 'workspace-parent-removal', action: `Remove ${plan.workspace.parent} only while it holds nothing but its marker` }] : []),
        { id: 'verify-absent', binary: engine, argv: ps, action: 'No owned Box, workspace, quarantine, parent or host record remains' },
        ...(profile.gpu ? [{ id: 'gpu-final-observation', binary: profile.gpu.smi.path, argv: gpuQueryArgv(profile.gpu.uuid), deadlineMs: 30000, action: 'The GPU shows none of the runner\'s registered processes; compute mode is read, never written' }] : []),
    ];
    const result = { provision, live, cleanup };
    if (run.target.remote) {
        const ssh = [run.target.remote.sshBinary, ...sshOptions(run.target.remote), run.target.remote.address];
        const root = run.target.stage.root;
        result.staging = [
            { id: 'remote-host', argv: [...ssh, 'uname', '-n'], expect: profile.host.hostname },
            { id: 'remote-root', argv: [...ssh, 'mkdir', '-m', '0700', '--', root], action: 'Refuse if it exists; upload the owner marker; record dev/ino/uid' },
            { id: 'payload', argv: [...ssh, 'dd', `of=${root}/payload.tar`, 'conv=excl,fsync', 'status=none'], verify: `sha256sum == ${run.target.stage.payloadDigest}` },
            { id: 'extract', argv: [...ssh, 'tar', '-x', '--no-same-owner', '-f', `${root}/payload.tar`, '-C', `${root}/source`] },
            { id: 'manifest-and-authorization', action: `dd the exact authorized manifest bytes to ${run.target.remote.runPath} and the binding to ${root}/run/authorization_ACTION_DIGEST.json; chmod 0600; sha256sum verify` },
            { id: 'dispatch', argv: [...ssh, profile.node.path, `${profile.source.root}/tests/hardware-limits/verify.mjs`, 'ACTION', '--run', run.target.remote.runPath, '--authorization', '<STAGED_BINDING>', '--remote-local', run.runId, '--expected-manifest-digest', '<MANIFEST_DIGEST>'] },
            { id: 'fetch', action: `sha256sum then cat ${run.target.remote.runPath} and ${root}/run/${remoteReportName('ACTION')}; digests must match; the fetched manifest replaces the local one` },
            { id: 'fetch-run-artifacts', argv: [...ssh, 'ls', '-1A', '--', `${root}/run`], action: `After every dispatch and before any removal: list ${root}/run, and for each regular file named exactly <run>_<name>_<suffix>.json (at most 512 files of at most 8 MiB, 64 MiB in all; never a symlink, a directory, an authorization binding or a name that suggests a credential) stat, sha256sum and cat it, verify the digest after transfer (three attempts) and write it beside the local manifest with mode 0600. A required proof that is missing or corrupt keeps the staging root and the run is BLOCKED, never certified` },
            { id: 'remove-staging', argv: [...ssh, 'rm', '-rf', '--', root], action: 'Only after a fetched remote cleanup PASS with complete run artifacts, or when no remote run was ever dispatched; identity re-proved first' },
        ];
    }
    return result;
}

const list = values => values.map(value => `\`${value}\``).join(', ');

// The idle-gate checks of every apparatus GPU block (plan section 15.5 with amendment A5), as
// the approval summary states them.
export function gpuGateChecks(profile) {
    const gpu = profile.gpu;
    const uuid = gpu.uuid;
    return [
        [`\`${gpu.smi.path} ${gpuQueryArgv(uuid).join(' ')}\` exits 0 within 30 s with at most 1 MiB of output`, 'a query error blocks'],
        ['the XML parses strictly: one gpu element, no entity, CDATA or ampersand, exactly one uuid and compute_mode, one fb_memory_usage', 'malformed or unsupported output blocks'],
        [`the UUID is \`${uuid}\` and the total memory is ${gpu.memoryMiB} MiB`, 'another device blocks'],
        ['the compute mode is Default', 'any other mode blocks; the runner never changes it'],
        ['the process list is supported (no N/A) and, for the initial gate, empty: no compute or MPS process and no unrecorded graphics process (but for the one display process of amendment A5)', 'an unsupported inventory or any such process blocks'],
        [`amendment A5, one recorded display process: at the run's FIRST gate check (the provision action) ${GPU_TOLERATED_MAX === 1 ? 'one foreign process' : `up to ${GPU_TOLERATED_MAX} foreign processes`} may be recorded as tolerated, of type exactly \`G\` (graphics only, never C, C+G, M+C or any type with compute), using at most ${GPU_TOLERATED_MAX_MIB} MiB, not owned by the run, with a proven host identity (boot id and /proc start time). It is written to toleratedProcesses of the run manifest with its PID, start identity, name, type and memory; the recorded process is also in the gpu-initial-gate evidence and in every check's history`, 'a process that is not of type G, is over the memory limit, is a second foreign graphics process, or whose identity cannot be proved blocks the first check'],
        ['at every later check the only foreign process allowed is the recorded one: same PID and start identity, type still exactly G and memory still within the limit (the subset of that record). The runner never touches, signals or reprioritises a tolerated process and never changes the compute mode', 'a process that was not recorded, one that gained compute, one over the limit, a reused PID (another start identity) or an unprovable identity blocks; the recorded process disappearing is logged, not a failure'],
        ['before EVERY later GPU operation the query is repeated; a listed PID is excluded only if it is a registered owned MPS server (a child of the registered owned daemon in the Box\'s /ploinky/core) or client (inside a registered owned agent leaf) and its tuple is freshly verified: host boot ID, host PID, process start time, cgroup beneath the exact Box scope libpod-<BOX_ID>', 'a bare PID, UID or name never excludes; a changed tuple blocks'],
        ...(profile.llm ? [
            ['free GPU memory (the actual figure, with the tolerated process\'s MiB accounted for) covers the applied share plus 256 MiB before the small model starts, and, for the vLLM model, the model\'s own admission estimate plus 512 MiB of slack (never more than the share plus 256 MiB; the basis and the figure are recorded)', 'less blocks'],
            ['during the runner install, the calibration, the model load and every prompt the gate re-queries every 2 s', 'a foreign process aborts the running command, trips the gate (no later GPU operation starts) and the case is BLOCKED; owned clients are stopped only by cleanup'],
            ['the runner never changes the compute mode and never signals a foreign process', 'this block signals no process at all: the model is stopped through the agent\'s own stop tool and everything else goes with the Box'],
        ] : [
            ['free GPU memory covers the probe bound plus 1 GiB before each CUDA probe', 'less blocks'],
            ['during a probe the gate re-queries every 2 s', 'a foreign process aborts the probe command, trips the gate (no later GPU operation starts) and the case is BLOCKED; owned clients are stopped only by cleanup'],
            ['the runner never changes the compute mode and never signals a foreign process', 'the only signal it can send is the owned-daemon kill of P3, after both layers prove the identity'],
        ]),
    ];
}

// The GPU block's idle-gate checks and every GPU operation, from the same
// constants the executors use. Identities known only at run time are
// placeholders (<PROBE_ID>, <BOX_ID>, <PIPE>, <SERVER_PID>).
export function gpuPlan(run) {
    const profile = run.target.execution;
    const gpu = profile.gpu;
    const uuid = gpu.uuid;
    const core = ['container', 'exec', '--user', 'podman', '<BOX_ID>'];
    const nested = [...core, 'podman', '--cgroup-manager=cgroupfs'];
    const node = profile.node.path; const engine = profile.engine.path;
    const first = GPU_SHARES.first; const raised = GPU_SHARES.raised;
    const cap = shareMemoryMiB(first.vramPercent, gpu.memoryMiB);
    const raisedCap = shareMemoryMiB(raised.vramPercent, gpu.memoryMiB);
    const probe = (maxMiB, options = {}) => probeExecArgv({ containerId: '0'.repeat(64), maxMiB, ...options }).map(word => (word === '0'.repeat(64) ? '<PROBE_ID>' : word));
    const admin = (id, method, body, extra = {}) => ({ id, binary: engine, argv: [...core, 'node', '-e', '<ADMIN_REQUEST>', method, body], deadlineMs: run.deadlines.coreMs, ...extra });
    const apply = (id, refs) => admin(id, 'POST', `{"action":"apply","expectedToken":<TOKEN>,"containers":[<${refs} registry key>]}`, { deadlineMs: 600000, gpu: true });
    const gate = id => ({ id, binary: gpu.smi.path, argv: gpuQueryArgv(uuid), deadlineMs: 30000, gpu: true, note: 'The per-operation GPU idle gate: query again, exclude only owned PIDs with a freshly verified tuple.' });
    const share = value => `{"smPercent":${value.smPercent},"vramPercent":${value.vramPercent}}`;
    const set = (id, ref, value) => admin(id, 'POST', `{"action":"set_agent_limits","expectedToken":<TOKEN>,"agentRef":"${ref}","limits":{"gpu":${share(value)}}}`);
    const clear = (id, ref) => admin(id, 'POST', `{"action":"clear_agent_limits","expectedToken":<TOKEN>,"agentRef":"${ref}"}`);
    const observeMps = id => ({ id, binary: engine, argv: [...core, 'node', '-e', '<MPS_OBSERVE>'], deadlineMs: 30000, note: 'Read-only: the private state file, the daemon\'s /proc facts and the three read-only control queries get_default_active_thread_percentage, get_default_device_pinned_mem_limit 0 and get_server_list.' });
    const helper = writable => ({ id: `P4-helper-create-${writable ? 'rw' : 'ro'}`, binary: engine, argv: [...nested, ...controlHelperRunArgv({ name: `hwl-${run.runId.slice(0, 12)}-ctl-${writable ? 'rw' : 'ro'}`, image: profile.provision.image, pipeDirectory: `/run/ploinky/mps/pipe-${'0'.repeat(32)}`, writable, runId: run.runId }).map(word => word.replace(`pipe-${'0'.repeat(32)}`, 'pipe-<PIPE>'))], deadlineMs: 60000, gpu: true });
    const control = (id, command) => ({ id, binary: engine, argv: [...nested, 'container', 'exec', '--env', `CUDA_MPS_PIPE_DIRECTORY=${MPS_CLIENT_PIPE}`, '--env', 'LD_LIBRARY_PATH=/usr/local/nvidia/lib64', '<HELPER_ID>', 'sh', '-c', 'printf "%s\\n" "$1" | /x', 'sh', command], deadlineMs: 20000, gpu: true });
    const operations = [
        { case: 'provision', ...gate('gpu-initial-gate'), note: 'The initial gate, before anything is created: the process list must be empty, except for at most one recorded graphics-only (type G) display process of at most 64 MiB, present at this first check with a proven identity (amendment A5)' },
        { case: 'provision', id: 'gpu-grant', action: `${profile.candidate.path} gpu grant --agent ${plan(run).gpu.grantAgents.join(' --agent ')} (host driver discovery; records the grant)`, gpu: true },
        { case: 'P1', ...gate('P1-gate') },
        { case: 'P1', ...admin('P1-admin-state', 'GET', ''), action: 'Read the Box hardware-limits state and the policy store token through the Router route (the local operator session)' },
        { case: 'P1', id: 'p1-grant-facts', binary: engine, argv: [...core, 'node', '-e', '<GPU_GRANT_FACTS>'], deadlineMs: 30000, note: 'Run only when the Box reports GPU sharing unavailable, before the case stops: read-only facts (the grant marker\'s state and MPS fields, the three bound tool files, and one bounded nvidia-smi observation with and without the loader path). Nothing is signalled, started or written.' },
        { case: 'P1', ...set('P1-save-share', 'hwlfixture/probe', first), action: `Save the first share ${first.smPercent}% SM / ${first.vramPercent}% VRAM (${cap} MiB of ${gpu.memoryMiB})` },
        { case: 'P1', ...apply('P1-apply', 'probe'), action: 'Apply starts the MPS daemon (uid 1000, /ploinky/core), sets and reads back both defaults, then recreates the probe as a share client' },
        { case: 'P1', ...observeMps('P1-observe-mps') },
        { case: 'P2', ...gate('P2-gate') },
        { case: 'P2', id: 'P2-probe-share', binary: engine, argv: [...nested, ...probe(probeBoundMiB(cap))], deadlineMs: 55000, gpu: true, note: `${first.smPercent}% share, ${cap} MiB cap; monitored by the gate` },
        { case: 'P2', id: 'P2-probe-tighter-sm', binary: engine, argv: [...nested, ...probe(probeBoundMiB(cap), { set: { CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: String(TIGHTER_CLIENT.smPercent) } })], deadlineMs: 55000, gpu: true },
        { case: 'P2', id: 'P2-probe-tighter-memory', binary: engine, argv: [...nested, ...probe(probeBoundMiB(TIGHTER_CLIENT.memoryMiB), { set: { CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: `0=${TIGHTER_CLIENT.memoryMiB}M` } })], deadlineMs: 55000, gpu: true },
        { case: 'P2', id: 'P2-probe-bypass', binary: engine, argv: [...nested, ...probe(probeBoundMiB(cap), { unset: ['CUDA_MPS_PIPE_DIRECTORY', 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT'] })], deadlineMs: 55000, gpu: true, note: 'No MPS environment: the process uses the GPU outside MPS (Default compute mode)' },
        { case: 'P3', ...set('P3-save-peer-share', 'hwlfixture/peer', first), action: `Own-share change under the same default (${first.smPercent}% / ${cap} MiB)` },
        { case: 'P3', ...apply('P3-apply-peer', 'peer'), action: 'Recreates only the peer; the daemon and the probe stay' },
        { case: 'P3', ...set('P3-raise-default', 'hwlfixture/probe', raised), action: `Raise the server default to ${raised.smPercent}% / ${raisedCap} MiB` },
        { case: 'P3', ...apply('P3-apply-default-change', 'probe'), action: 'Drains the whole cohort first, then quits the old daemon, starts a new generation and recreates the clients; a host-side timeline samples the order' },
        { case: 'P3', ...clear('P3-clear-peer', 'hwlfixture/peer') },
        { case: 'P3', ...apply('P3-apply-clear-peer', 'peer'), action: 'The peer returns to an unshared replacement; the daemon stays' },
        { case: 'P3', ...clear('P3-clear-final', 'hwlfixture/probe') },
        { case: 'P3', ...apply('P3-apply-clear-final', 'probe'), action: 'Final share cleared: drain, quit, verify, unshared replacement without MPS env/bind/label' },
        { case: 'P3', ...set('P3-reshare', 'hwlfixture/probe', first) },
        { case: 'P3', ...apply('P3-apply-reshare', 'probe') },
        { case: 'P3', id: 'P3-host-clear', binary: node, argv: [profile.candidate.path, 'limits', 'clear', '--agent', 'hwlfixture/probe'], cwd: plan(run).workspace.path, env: {}, deadlineMs: 120000, gpu: true },
        { case: 'P3', id: 'P3-restart-agent', binary: node, argv: [profile.candidate.path, 'restart', 'hwlfixture/probe'], cwd: plan(run).workspace.path, env: {}, deadlineMs: 600000, gpu: true, note: 'An ordinary restart after the host clear: the final-share shutdown logic runs' },
        { case: 'P3', id: 'P3-crash-setup', action: 'Share both clients again (one Apply of the probe and the peer)', gpu: true },
        { case: 'P3', id: 'P3-kill-owned-daemon', binary: engine, argv: [...core, 'node', '-e', '<MPS_KILL_OWNED_DAEMON>', '<DAEMON_BOX_PID>', '<DAEMON_START_TIME>'], deadlineMs: 20000, gpu: true, note: 'SIGKILL of the one owned MPS control daemon, only after the host (boot ID, host PID, start time, /ploinky/core under the exact Box, UID) and the Box (state file, /proc start time, UID, executable identity, cgroup, pipe environment) both prove it. Nothing else is signalled; CPU agents are not restarted.' },
        { case: 'P3', ...apply('P3-apply-recover', 'probe'), action: 'Recovery: rebuild the generation and recreate the cohort' },
        { case: 'P4', ...gate('P4-gate') },
        { case: 'P4', id: 'P4-holder', binary: engine, argv: [...nested, 'container', 'exec', '<PROBE_ID>', 'python3', '-c', '<HOLDER>'], deadlineMs: 180000, gpu: true, note: 'Holds one CUDA context (one MPS client) so the daemon has a server to name; aborted by the runner at the end' },
        { case: 'P4', ...helper(true) }, { case: 'P4', ...helper(false) },
        { case: 'P4', ...control('P4-control-rw-list', 'get_server_list') },
        { case: 'P4', ...control('P4-control-rw-sm', 'get_default_active_thread_percentage') },
        { case: 'P4', ...control('P4-control-rw-memory', 'get_default_device_pinned_mem_limit 0') },
        { case: 'P4', ...control('P4-control-rw-widen-sm', 'set_active_thread_percentage <SERVER_PID> 100'), note: 'The documented best-effort limitation: a same-UID client can widen the server' },
        { case: 'P4', id: 'P4-probe-after-sm-mutation', binary: engine, argv: [...nested, ...probe(probeBoundMiB(cap), { set: { CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: '100' } })], deadlineMs: 55000, gpu: true, note: 'A new client sets 100 itself; its SM count is observed BEFORE the independent memory setter' },
        { case: 'P4', ...control('P4-control-rw-set-memory', 'set_device_pinned_mem_limit <SERVER_PID> 0 64M'), note: 'Its effect is observational, never claimed in advance' },
        { case: 'P4', id: 'P4-probe-after-memory-mutation', binary: engine, argv: [...nested, ...probe(384)], deadlineMs: 55000, gpu: true, note: 'Only when the setter was accepted: one more context is tried and what happens is recorded, never asserted' },
        { case: 'P4', ...control('P4-control-ro-list', 'get_server_list'), note: 'The read-only pipe: the connection result is recorded' },
        { case: 'P4', id: 'P4-helper-remove', binary: engine, argv: [...nested, 'container', 'rm', '--force', '<HELPER_ID>'], deadlineMs: 60000, gpu: true, note: 'By exact recorded identity, after its name and run label are re-proved' },
        { case: 'P4', ...clear('P4-reconcile-clear', 'hwlfixture/probe') },
        { case: 'P4', ...apply('P4-reconcile-apply-clear', 'probe'), action: 'Reconcile: drain and quit the test daemon' },
        { case: 'P4', ...set('P4-reconcile-share', 'hwlfixture/probe', first) },
        { case: 'P4', ...apply('P4-reconcile-apply-share', 'probe'), action: 'A fresh daemon with the configured defaults' },
        { case: 'P4', id: 'P4-probe-after-reconcile', binary: engine, argv: [...nested, ...probe(probeBoundMiB(cap))], deadlineMs: 55000, gpu: true, note: 'One more probe shows the share is not widened' },
        { case: 'cleanup', id: 'gpu-final-observation', binary: gpu.smi.path, argv: gpuQueryArgv(uuid), deadlineMs: 30000, gpu: true, note: 'After the Box is destroyed: none of the runner\'s registered GPU processes may remain' },
    ];
    const gateChecks = gpuGateChecks(profile);
    return { operations, gateChecks, commands: operations.filter(entry => entry.argv && entry.case !== 'provision' && entry.case !== 'cleanup').map(({ case: caseId, gpu: isGpu, ...entry }) => ({ ...entry, note: `${caseId}${isGpu ? ' (GPU operation)' : ''}${entry.note ? `: ${entry.note}` : ''}` })) };
}

// Every operation of an apparatus-local-llm or apparatus-vllm run, from the same constants the
// executors use. Identities and values known only at run time are placeholders.
export function llmPlan(run) {
    const profile = run.target.execution;
    const gpu = profile.gpu; const llm = profile.llm; const uuid = gpu.uuid;
    const core = ['container', 'exec', '--user', 'podman', '<BOX_ID>'];
    const nested = [...core, 'podman', '--cgroup-manager=cgroupfs'];
    const engine = profile.engine.path; const node = profile.node.path;
    const ports = ['--port', String(run.ports.tcp), '--udp-port', String(run.ports.udp)];
    void ports; void node;
    const gate = (id, note = 'The per-operation GPU idle gate: query again, exclude only owned PIDs with a freshly verified tuple, tolerate only the recorded display process (A5).') => ({ id, binary: gpu.smi.path, argv: gpuQueryArgv(uuid), deadlineMs: 30000, gpu: true, note });
    const admin = (id, method, body, extra = {}) => ({ id, binary: engine, argv: [...core, 'node', '-e', '<ADMIN_REQUEST>', method, body], deadlineMs: run.deadlines.coreMs, ...extra });
    const apply = (id) => admin(id, 'POST', `{"action":"apply","expectedToken":<TOKEN>,"containers":[<${LLM_REF} registry key>]}`, { deadlineMs: 600000, gpu: true });
    const save = (id, limits) => admin(id, 'POST', `{"action":"set_agent_limits","expectedToken":<TOKEN>,"agentRef":"${LLM_REF}","limits":${limits}}`);
    const tool = (id, name, args, view, extra = {}) => ({ id, binary: engine, argv: [...core, 'node', '-e', '<LLM_TOOL_CALL>', ...llmToolWords(name, args, view)], deadlineMs: 90000, ...extra });
    const agentExec = (id, words, extra = {}) => ({ id, binary: engine, argv: [...nested, 'container', 'exec', '<AGENT_ID>', ...words], deadlineMs: 30000, ...extra });
    const small = LLM_MODELS.small; const awq = LLM_MODELS.awq;
    const budget = JSON.stringify(llm.budget);
    const view = id => ({ model: id });
    const common = [
        { case: 'provision', ...gate('gpu-initial-gate'), note: 'The initial gate, before anything is created (amendment A5 applies: at most one recorded graphics-only display process)' },
        { case: 'provision', id: 'gpu-grant', action: `${profile.candidate.path} gpu grant --agent ${LLM_REF} (host driver discovery; records the grant)`, gpu: true },
    ];
    const l1 = [
        { case: 'L1', ...gate('L1-gate') },
        { case: 'L1', ...admin('L1-admin-state', 'GET', ''), action: 'Read the Box state, the policy store token and the CPU and RAM envelope through the Router route (the local operator session)' },
        { case: 'L1', ...tool('L1-overview-fresh', 'local_llm_overview', { preview: { modelId: small, runnerId: 'llama.cpp', params: {} } }, view(small)), action: 'The agent\'s catalog, pins and download state: the model data must be fresh' },
        { case: 'L1', ...save('L1-save-budget', budget), action: `Save ${llm.budget.cpus} CPUs, ${llm.budget.memoryPercent}% of the Box RAM and the ${llm.budget.gpu.smPercent}% SM / ${llm.budget.gpu.vramPercent}% VRAM share` },
        { case: 'L1', ...apply('L1-apply'), action: 'Apply replaces the agent: the MPS daemon (uid 1000, /ploinky/core) starts and the agent becomes a share client with the saved CPU and RAM limits' },
        { case: 'L1', id: 'L1-observe-mps', binary: engine, argv: [...core, 'node', '-e', '<MPS_OBSERVE>'], deadlineMs: 30000, note: 'Read-only: the daemon, its generation and its pipe' },
        { case: 'L1', id: 'L1-leaf', binary: engine, argv: [...core, 'node', '-e', '<LEAF_OBSERVATION>', '<LEAF>'], deadlineMs: 20000, note: 'Read-only: memory.max and cpu.max of the agent\'s cgroup leaf' },
        { case: 'L1', ...tool('L1-overview-budget', 'local_llm_overview', { preview: { modelId: small, runnerId: 'llama.cpp', params: {} } }, view(small)), action: 'The agent\'s own view of the budget, and public admission of the model under it' },
        { case: 'L1', ...tool('L1-run', 'local_llm_run', { requestId: '<REQUEST_ID>', modelId: small, runnerId: 'llama.cpp', params: {}, replace: false }, {}, { gpu: true }), action: `Run ${small} with llama.cpp (downloads ${llm.models.small.size} bytes into the fresh /data)` },
        { case: 'L1', ...tool('L1-status', 'local_llm_status', {}, {}), action: 'Polled until the model is ready or fails; the gate re-queries every 2 s meanwhile' },
        { case: 'L1', ...agentExec('L1-runner-env', ['node', '-e', '<LLM_RUNNER_PROCESSES>', 'llama-server']), note: 'Read-only: the runner\'s user, the names of its environment and its CUDA variables' },
        { case: 'L1', id: 'L1-leaf-sample', binary: engine, argv: [...core, 'node', '-e', '<LLM_LEAF_SAMPLE>', '<LEAF>'], deadlineMs: 20000, note: `Read-only, repeated while the text request generates: one sample of the agent leaf's cpu.stat (usage_usec, nr_throttled, throttled_usec), cpu.max, memory.current, memory.peak (when the kernel has it), memory.max, memory.swap.current and memory.events, with the Box's monotonic clock; once before the request is sent, every ${INFERENCE_CADENCE.sampleMs} ms (plus the read) until the response completes, and once after` },
        { case: 'L1', ...tool('L1-prompt', 'local_llm_test_prompt', { ...L1_PROMPT }, {}, { deadlineMs: 290000, gpu: true }), action: `The Playground's own tool (see the Playground deviation), sampled as above; the GPU idle gate re-queries nvidia-smi every ${INFERENCE_CADENCE.gpuMs} ms meanwhile (the runner's device memory by its verified host PID, or the owned MPS server's, and the GPU utilisation), and a foreign GPU process appearing aborts the request` },
        { case: 'L1', ...agentExec('L1-image-digests', ['node', '-e', '<LLM_IMAGE_DIGESTS>'], { deadlineMs: 120000 }), note: 'Read-only: sha256 of llama-server, the source contract and the runner lock in the image' },
    ];
    const l2 = [
        { case: 'L2', ...gate('L2-gate') },
        { case: 'L2', ...tool('L2-status', 'local_llm_status', {}, {}), action: 'Is a model running?' },
        { case: 'L2', ...tool('L2-stop', 'local_llm_stop', {}, {}), action: 'Stop the model; the old running model is never what is tested' },
        { case: 'L2', ...save('L2-save-insufficient', '{"cpus":4,"memoryPercent":<PERCENT>,"gpu":{"smPercent":50,"vramPercent":50}}'), action: `Save a known-insufficient RAM budget: the whole percentage of the Box RAM whose cap is the largest at or below ${INSUFFICIENT_RAM.maxCapBytes} bytes (at least ${INSUFFICIENT_RAM.minCapBytes}), under admission's 768 MiB need plus 1 GiB margin` },
        { case: 'L2', ...apply('L2-apply'), action: 'Apply it; the replacement agent has the new cap' },
        { case: 'L2', id: 'L2-leaf', binary: engine, argv: [...core, 'node', '-e', '<LEAF_OBSERVATION>', '<LEAF>'], deadlineMs: 20000, note: 'Read-only: the new memory.max' },
        { case: 'L2', ...tool('L2-overview', 'local_llm_overview', { preview: { modelId: small, runnerId: 'llama.cpp', params: {} } }, view(small)), action: 'The agent\'s own view of the new cap' },
        { case: 'L2', ...tool('L2-run', 'local_llm_run', { requestId: '<REQUEST_ID>', modelId: small, runnerId: 'llama.cpp', params: {}, replace: false }, {}), action: 'A new Run: it must be refused with the RAM budget as its reason before anything launches' },
        { case: 'L2', ...agentExec('L2-runner-processes', ['node', '-e', '<LLM_RUNNER_PROCESSES>', 'llama-server']), note: 'Read-only: no runner process exists after the refusal' },
    ];
    const l3 = [
        { case: 'L3', ...gate('L3-gate') },
        { case: 'L3', ...tool('L3-status', 'local_llm_status', {}, {}), action: 'The agent answers its status tool (after Apply replaces it, and while a model is polled)' },
        { case: 'L3', ...agentExec('L3-step0-prerequisites', ['node', ...vllmToolWords('prerequisites', { pins: llm.vllm?.pins ?? { version: '0.0.0', runnerLockDigest: '0'.repeat(64), files: 1, downloadBytes: 1 } })], { deadlineMs: 120000 }), note: 'Step 0, read-only: the image\'s runner lock has a vLLM entry for linux/amd64 with CUDA wheels, the interpreter, driver, toolchain and disk can take it, and it equals the pins; anything missing is BLOCKED with that exact prerequisite' },
        { case: 'L3', ...admin('L3-admin-state', 'GET', '') },
        { case: 'L3', ...save('L3-save-share', JSON.stringify({ gpu: VLLM_SHARE })), action: `Save the ${VLLM_SHARE.smPercent}% SM / ${VLLM_SHARE.vramPercent}% VRAM share (${Math.floor(VLLM_SHARE.vramPercent * gpu.memoryMiB / 100)} MiB of ${gpu.memoryMiB}): the smallest share admission fits Qwen3-4B-AWQ in is 87%` },
        { case: 'L3', ...apply('L3-apply'), action: 'Apply replaces the agent before the install, because the runnable copy lives in the container' },
        { case: 'L3', ...tool('L3-install', 'local_llm_runner_install', { runnerId: 'vllm', acceptLicence: false }, {}, { gpu: true }), action: `The product's install of vLLM ${llm.vllm?.pins.version ?? ''} from the pinned lock (${llm.vllm?.pins.downloadBytes ?? 0} bytes, ${llm.vllm?.pins.files ?? 0} files)` },
        { case: 'L3', ...tool('L3-install-poll', 'local_llm_overview', {}, {}), action: 'Polled until the install finishes; the gate re-queries every 2 s meanwhile' },
        ...(llm.vllm?.stage === 'calibration' ? [
            { case: 'L3', ...agentExec('L3-stage1-calibrate', ['node', ...vllmToolWords('calibrate', { hostNvmlBytes: gpu.memoryMiB * 1048576 })], { deadlineMs: 600000, gpu: true }), note: 'Stage 1, no model launch: bounded owned queries in the client (torch.cuda.mem_get_info, get_device_properties(0).total_memory, the ctypes cuMemGetInfo) under the saved and a tighter limit, the installed version\'s sizing source, the final argv, and the proposed tuple with its evidence digest' },
        ] : [
            { case: 'L3', ...tool('L3-preview', 'local_llm_overview', { preview: { modelId: awq, runnerId: 'vllm', params: {} } }, view(awq)), action: 'Public admission of the model at the share' },
            { case: 'L3', ...tool('L3-run', 'local_llm_run', { requestId: '<REQUEST_ID>', modelId: awq, runnerId: 'vllm', params: {}, replace: false }, {}, { gpu: true }), action: `Stage 2: Run ${awq} (downloads ${llm.models.awq.size} bytes); before the reviewed entry exists it is refused as vllm_mps_unqualified and nothing launches` },
            { case: 'L3', ...tool('L3-status-ready', 'local_llm_status', {}, {}), action: 'Polled until the model is ready' },
            { case: 'L3', ...agentExec('L3-runner-env', ['node', '-e', '<LLM_RUNNER_PROCESSES>', 'vllm']), note: 'Read-only' },
            { case: 'L3', ...tool('L3-prompt', 'local_llm_test_prompt', { prompt: '<PROMPT>', maxTokens: 256 }, {}, { deadlineMs: 290000, gpu: true }) },
        ]),
    ];
    const operations = [
        ...common,
        ...(profile.cases.includes('LIVE-L1') ? l1 : []),
        ...(profile.cases.includes('LIVE-L2') ? l2 : []),
        ...(profile.cases.includes('LIVE-L3') ? [...l3,
            { case: 'L3', id: 'L3-leaf-and-daemon', binary: engine, argv: [...core, 'node', '-e', '<MPS_OBSERVE>'], deadlineMs: 30000, note: 'Read-only' }] : []),
        { case: 'cleanup', id: 'gpu-final-observation', binary: gpu.smi.path, argv: gpuQueryArgv(uuid), deadlineMs: 30000, gpu: true, note: 'After the Box is destroyed: none of the runner\'s registered GPU processes may remain' },
    ];
    return { operations, gateChecks: gpuGateChecks(profile), commands: operations.filter(entry => entry.argv && entry.case !== 'provision' && entry.case !== 'cleanup').map(({ case: caseId, gpu: isGpu, ...entry }) => ({ ...entry, note: `${caseId}${isGpu ? ' (GPU operation)' : ''}${entry.note ? `: ${entry.note}` : ''}` })) };
}
const plan = run => run.target.execution.provision;

export function renderSummary(run, manifestPath) {
    const profile = run.target.execution;
    const plan = profile.provision;
    const remote = Boolean(run.target.remote);
    const line = (...parts) => parts.join('');
    // Long fixed values are named, never truncated, so every argument that
    // varies between runs (ports, refs, IDs, paths) stays visible.
    const shown = value => (value === INSPECT ? '<INSPECT_FORMAT>' : value === AGENT_INSPECT ? '<AGENT_INSPECT_FORMAT>'
        : value.startsWith(`${profile.source.root}/`) ? `$SOURCE/${value.slice(profile.source.root.length + 1)}` : value);
    const commands = [...run.target.plan.provision, ...run.target.plan.live].filter(entry => entry.argv)
        .map(entry => {
            const env = Object.entries(entry.env || {}).map(([key, value]) => `${key}=${value}`);
            const text = [...env, entry.binary, ...entry.argv].map(shown).join(' ').replaceAll('|', '\\|');
            return `| ${entry.id} | \`${text}\`${entry.cwd ? ` in \`${entry.cwd}\`` : ''} |`;
        });
    const lines = [
        `# Live run proposal ${run.runId} (${run.block})`,
        '',
        `Manifest: \`${manifestPath}\``,
        '',
        'This is a proposal for approval. Nothing has run. Each action needs its own execution-time authorization binding over the exact manifest bytes: `provision` first, then `live` over the provisioned manifest, then `cleanup` if a run was interrupted. Editing this file or the manifest grants nothing.',
        '',
        '## What would run',
        '',
        `| Case | Status |`,
        '| --- | --- |',
        ...profile.cases.map(id => `| ${id} | executed |`),
        ...Object.entries(run.target.unsupported).map(([id, reason]) => `| ${id} | not run: ${reason} |`),
        '',
        ...passConditionsSection(profile),
        '## Where',
        '',
        '| Item | Value |',
        '| --- | --- |',
        `| Host | ${profile.host.hostname} (${profile.host.platform}), home \`${profile.host.home}\` |`,
        remote ? `| SSH route | ${run.target.remote.user}@${run.target.remote.address}, HostKeyAlias ${run.target.remote.hostKeyAlias}, known_hosts \`${run.target.remote.knownHosts}\` (${run.target.remote.knownHostsDigest}), BatchMode, strict host key, no forwarding |` : '| SSH route | none (local block) |',
        `| Engine | \`${profile.engine.path}\` ${profile.engine.digest}, service identity ${profile.engine.identityDigest} |`,
        `| Node | \`${profile.node.path}\` ${profile.node.digest} |`,
        `| Candidate | revision ${plan.revision}, source \`${profile.source.root}\` ${profile.source.digest} |`,
        remote ? `| Staged payload | \`${run.target.stage.payloadPath}\` ${run.target.stage.payloadDigest} (${run.target.stage.payloadBytes} bytes) into \`${run.target.stage.root}\` |` : '| Staged payload | none |',
        '',
        '## Resources',
        '',
        '| Resource | Value |',
        '| --- | --- |',
        `| New workspace | \`${plan.workspace.path}\` (instance ${run.workspace.instance}), refused if it exists |`,
        `| Workspace parent | \`${plan.workspace.parent}\` (${plan.workspace.parentMode === 'create' ? 'created by this run' : 'the staged private remote root'}) |`,
        `| Socket room | \`${path.join(plan.workspace.path, WORKSPACE_SOCKET_NAME)}\` is ${Buffer.byteLength(path.join(plan.workspace.path, WORKSPACE_SOCKET_NAME))} bytes, under the ${UNIX_SOCKET_PATH_LIMIT - 1}-byte Unix socket limit; a longer workspace is refused, so pin a short task-owned workspaceParentRoot |`,
        `| Host ports | TCP ${run.ports.tcp} (Router, loopback), UDP ${run.ports.udp} (media); a collision aborts |`,
        `| Box image | \`${plan.boxImage}\` |`,
        `| Fixture image | \`${plan.image}\` |`,
        ...plan.agents.map(agent => (agent.hardwareLimits ? `| Fixture agent ${FIXTURE_REPOSITORY}/${agent.name} | hardwareLimits memory ${agent.hardwareLimits.memory}, cpus ${agent.hardwareLimits.cpus}, pids ${agent.hardwareLimits.pidsLimit}, readiness none |` : `| Agent ${LLM_REF} | the local-llm candidate's own manifest, which declares no limits; the administrator's Apply sets them |`)),
        `| Deadlines | core ${run.deadlines.coreMs} ms, start ${run.deadlines.startMs} ms, destroy ${run.deadlines.destroyMs} ms, cleanup ${run.deadlines.cleanupMs} ms${remote ? `, staging ${run.deadlines.stagingMs} ms` : ''} |`,
        '',
        '## Commands',
        '',
        'Every command runs as an argument array (shell:false) with a bounded deadline in its own process group. The full list, with environment and placeholders for identities known only after provisioning, is in `target.plan` of the manifest.',
        '',
        `\`$SOURCE\` is \`${profile.source.root}\`; \`<INSPECT_FORMAT>\` and \`<AGENT_INSPECT_FORMAT>\` are the fixed inspect templates in the manifest plan.`,
        '',
        '| Step | Command |',
        '| --- | --- |',
        ...commands,
        '',
        ...(profile.gpu ? gpuSummary(run) : []),
        '## Cleanup',
        '',
        line('Cleanup runs in a finally block after `live`, after any provisioning failure, and as the standalone `cleanup` action. It is journaled in the manifest and resumes from it after a crash. Order: ',
            run.target.plan.cleanup.map(entry => entry.id).join(', '), '. '),
        `It destroys only the recorded Box with \`${path.basename(profile.candidate.path)} destroy --delete-cache\` from the workspace, proves it absent, removes only the recorded host records ${list(HOST_RECORD_DIRECTORIES.map(name => `~/.ploinky-box/${name}/${run.workspace.instance}[.json]`))}, then quarantines and removes the workspace after reproving its uid/dev/ino and marker. A failed destroy or identity proof preserves everything for a later \`cleanup\`. Unrelated containers are compared with the recorded inventory and never changed.`,
        remote ? `The remote staging root \`${run.target.stage.root}\` is removed only after a fetched remote cleanup PASS (or when no remote run was ever dispatched).` : null,
        '',
        '## Not covered',
        '',
        `${Object.keys(run.target.unsupported).length ? `Cases ${list(Object.keys(run.target.unsupported))} stay BLOCKED. ` : 'No case is unsupported on this target. '}${plan.workspace.parentMode === 'create' ? 'Production start may pull the pinned images and fetch the default agent repositories; that network use is part of the live run.' : 'The remote start may pull the pinned images and fetch the default agent repositories; that network use is part of the live run.'}`,
        '',
    ];
    return lines.filter(value => value !== null).join('\n');
}

// The pass conditions of the selected cases, from the spec rows (never weakened), with the guard every preflight applies.
function passConditionsSection(profile) {
    const entries = profile.cases.filter(id => CASE_PASS_CONDITIONS[id]);
    if (!entries.length) return [];
    const cell = value => String(value).replaceAll('|', '\\|');
    return [
        '## Pass conditions (the spec rows, unchanged)',
        '',
        '| Case | Spec row | Procedure | PASS requires | Evidence written |',
        '| --- | --- | --- | --- | --- |',
        ...entries.map(id => { const entry = CASE_PASS_CONDITIONS[id]; return `| ${id} | ${cell(entry.row)} | ${cell(entry.procedure)} | ${cell(entry.passes)} | ${cell(entry.evidence)} |`; }),
        '',
        '## Foreign-workspace guard',
        '',
        `Every preflight (prepare-live, provision, live and cleanup) aborts before any mutation when the workspace, the stage, the candidate or the working directory lies under \`~/work/testExplorerFresh\` or \`~/cleanup-repair-claude-20261002\` (the pinned home ${profile.host.home} and this process's own home are both checked, symlinks resolved), or when a derived Box name matches \`ploinky-box-testexplorerfresh-*\`. The other session's Box, workspace and records are never read, written or signalled.`,
        '',
    ];
}

// The extra approval sections of the GPU block: the idle-gate checks, every
// GPU operation, the images, tools and digests, and the grant and policy records.
function gpuSummary(run) {
    const profile = run.target.execution;
    const gpu = profile.gpu;
    const { operations, gateChecks } = profile.llm ? llmPlan(run) : gpuPlan(run);
    const instance = run.workspace.instance;
    const cell = value => String(value).replaceAll('|', '\\|');
    const text = entry => (entry.argv ? `\`${[entry.binary, ...entry.argv].map(word => (word === profile.engine.path ? '$ENGINE' : word)).join(' ').replaceAll('|', '\\|')}\`` : cell(entry.action || ''));
    return [
        '## GPU idle gate',
        '',
        `The device is ${gpu.name} (\`${gpu.uuid}\`, ${gpu.memoryMiB} MiB, driver ${gpu.driverVersion}). Compute mode is never changed; nothing here is a reservation against another operator. One display process (type G, at most ${GPU_TOLERATED_MAX_MIB} MiB) that is present at the first check is tolerated only under amendment A5, as the rows below state; the process the first check recorded is written to \`toleratedProcesses\` in the run manifest and into the gate evidence once the provision action has run, and is not known before it.`,
        '',
        '| Check | If it fails |',
        '| --- | --- |',
        ...gateChecks.map(([check, fails]) => `| ${cell(check)} | ${cell(fails)} |`),
        '',
        '## GPU operations',
        '',
        'Every GPU-relevant operation, in order. Each one after the first is preceded by the idle gate above. Identities known only at run time are placeholders.',
        '',
        '| Case | Operation | Command or action |',
        '| --- | --- | --- |',
        ...operations.map(entry => `| ${entry.case} | ${cell(entry.id)} | ${text(entry)}${entry.note ? ` (${cell(entry.note)})` : ''} |`),
        '',
        ...(profile.llm ? llmImagesSection(run) : [
            '## Images, tools and digests',
            '',
            '| Item | Identity |',
            '| --- | --- |',
            `| Fixture image (probe, peer, cpu and the control helper) | \`${profile.provision.image}\` (non-root image user 1000:1000; python3 and ctypes) |`,
            `| Fixture agent process (probe, peer, cpu) | \`${FIXTURE_AGENT_COMMAND}\`: the agent execs node, which exits 0 at once on SIGTERM, SIGINT and SIGHUP, so the fixture agents acknowledge a drain with exit 0 as Ploinky's targeted-drain contract requires (a process killed by the signal, exit 143, is refused) |`,
            `| Box image | \`${profile.provision.boxImage}\` |`,
            `| nvidia-smi | \`${gpu.smi.path}\` ${gpu.smi.digest} |`,
            `| nvidia-cuda-mps-control | \`${gpu.mpsControl.path}\` ${gpu.mpsControl.digest} |`,
            `| nvidia-cuda-mps-server | \`${gpu.mpsServer.path}\` ${gpu.mpsServer.digest} |`,
            `| CUDA probe (mpsprobe.py) | \`${gpu.probe.sourcePath}\` ${gpu.probe.digest}, staged at /code/mpsprobe.py in the probe agent |`,
            '',
        ]),
        '## Grant and policy records',
        '',
        '| Record | Created by | Removed by cleanup |',
        '| --- | --- | --- |',
        `| \`~/.ploinky-box/gpu-grants/${instance}.json\` and \`~/.ploinky-box/gpu-grants/${instance}/\` | \`gpu grant\` and the Box start | yes, only when recorded |`,
        `| \`~/.ploinky-box/hardware-limits/${instance}.json\` and \`~/.ploinky-box/hardware-limits/${instance}/\` (the gate record and the policy store holding the saved shares) | the start and the Apply path | yes, only when recorded |`,
        `| \`~/.ploinky-box/router-bindings/${instance}[.json]\` | the start | yes, only when recorded |`,
        '| the parent directories of the three | pre-existing on the host (\`gpu-grants\` already exists and stays) | only a parent this run created, and only while empty |',
        '',
        ...(profile.llm ? llmDataSection(run) : []),
    ];
}

// The images, models, runner-lock pins and expected downloads of a local-llm or vLLM run.
function llmImagesSection(run) {
    const profile = run.target.execution; const gpu = profile.gpu; const llm = profile.llm; const plan = profile.provision;
    const cell = value => String(value).replaceAll('|', '\\|');
    const small = llm.models.small; const awq = llm.models.awq;
    const rows = [
        ['Local-llm image (immutable)', `\`${plan.image}\` (the candidate's manifest names \`${plan.llm.manifest.originalContainer}\`; it is rewritten to this digest, manifest ${plan.llm.manifest.originalDigest} to ${plan.llm.manifest.rewrittenDigest}); pulled by the Box start, size not known before it`],
        ['Local-llm candidate', `revision \`${plan.llm.revision}\`, tree \`${plan.llm.sourcePath}\` ${plan.llm.treeDigest}, copied into the new workspace only`],
        ['Box image', `\`${plan.boxImage}\``],
        ['nvidia-smi', `\`${gpu.smi.path}\` ${gpu.smi.digest}`],
        ['nvidia-cuda-mps-control', `\`${gpu.mpsControl.path}\` ${gpu.mpsControl.digest}`],
        ['nvidia-cuda-mps-server', `\`${gpu.mpsServer.path}\` ${gpu.mpsServer.digest}`],
        ['Runner (llama.cpp)', 'the image\'s /opt/llama.cpp/llama-server (CUDA 12.8 build b11159); its sha256 and the image\'s source contract and runner lock are read in the container and recorded'],
        [`Model ${small.id}`, `${small.repo} ${small.file} at commit \`${small.commit}\`, ${small.size} bytes, sha256 \`${small.sha256}\``],
    ];
    if (profile.cases.includes('LIVE-L3')) {
        const pins = llm.vllm.pins;
        rows.push(
            ['Runner lock entry (vLLM)', `version ${pins.version}, ${pins.files} files, ${pins.downloadBytes} bytes, production lock digest \`${pins.runnerLockDigest}\`; read from the image's /opt/local-llm/runners.lock.json and compared with these pins in step 0`],
            [`Model ${awq.id}`, `${awq.repo} at commit \`${awq.commit}\`, ${awq.files.length} files, ${awq.size} bytes (${awq.files.map(file => `${file.path} ${file.sha256.slice(0, 12)}`).join(', ')})`],
            ['vLLM share', `${llm.vllm.share.smPercent}% SM / ${llm.vllm.share.vramPercent}% VRAM (${Math.floor(llm.vllm.share.vramPercent * gpu.memoryMiB / 100)} MiB): admission fits Qwen3-4B-AWQ at 8192 tokens only from 87%; 50% does not fit`],
            ['Stage', llm.vllm.stage === 'calibration' ? 'stage 1, calibration: no model launch' : `stage 2: ${llm.vllm.calibration.expectQualified ? 'the candidate holds the reviewed entry for evidence ' + llm.vllm.calibration.evidenceDigest : 'the candidate holds NO matching reviewed entry: the correct outcome is a vllm_mps_unqualified refusal (BLOCKED, model not run)'}`],
        );
    }
    const downloads = [
        ['Model data (small GGUF)', `${small.size} bytes into the fresh /data (L1)`],
        ...(profile.cases.includes('LIVE-L3') ? [
            ['vLLM wheels', `${llm.vllm.pins.downloadBytes} bytes into /data/runners (verified cache), then a runnable copy rebuilt in the container (estimated at 3.5 times that)`],
            ['Model data (Qwen3-4B-AWQ snapshot)', `${awq.size} bytes into /data (stage 2 only)`],
        ] : []),
    ];
    return [
        '## Images, models, runner-lock pins and downloads',
        '',
        '| Item | Identity |',
        '| --- | --- |',
        ...rows.map(([item, identity]) => `| ${cell(item)} | ${cell(identity)} |`),
        '',
        '| Expected download | Size |',
        '| --- | --- |',
        ...downloads.map(([item, size]) => `| ${cell(item)} | ${cell(size)} |`),
        '',
    ];
}

// The model data, the Playground deviation, the prerequisites that may block real execution, and the cleanup of model data.
function llmDataSection(run) {
    const profile = run.target.execution; const workspace = profile.provision.workspace.path;
    const cell = value => String(value).replaceAll('|', '\\|');
    const l3 = profile.cases.includes('LIVE-L3');
    return [
        '## Model data, caches and cleanup',
        '',
        '| Data | Where | Removed by cleanup |',
        '| --- | --- | --- |',
        `| Model weights and agent state | \`${workspace}/.data/local-llm\` (the agent's /data) and \`${workspace}/.data/shared\` | yes: with the new workspace, after the Box is destroyed with \`--delete-cache\`; subordinate-owned files go through the bounded \`podman unshare\` removal. The cleanup inventories them before and proves them gone after |`,
        ...(l3 ? [`| vLLM wheel cache | \`${workspace}/.data/local-llm/runners\` | yes: the same |`, '| vLLM runnable copy and caches | the agent container\'s own filesystem (/opt/runners) | yes: with the Box |'] : []),
        '| Unrelated model data | none is reused: the workspace and its /data are new, and the case fails when the model\'s weights are not absent at the start | n/a |',
        '',
        ...(profile.cases.includes('LIVE-L1') ? [
            '## Measurements while the model generates (LIVE-L1)',
            '',
            `The text request is sampled while it generates, and the evidence is written before anything is asserted. The agent leaf's cgroup (resolved by its exact identity) is sampled before the request is sent, every ${INFERENCE_CADENCE.sampleMs} ms (plus the read) until the response completes, and once after. The GPU is re-queried at the idle gate's own cadence of ${INFERENCE_CADENCE.gpuMs} ms.`,
            '',
            '| Resource | Recorded as samples | Asserted |',
            '| --- | --- | --- |',
            `| CPU | cpu.stat usage_usec, nr_throttled, throttled_usec; cpu.max | cpu.max is the applied ${LLM_BUDGET.cpus}-CPU quota in every sample; the use over the inference window, and between neighbouring samples, does not exceed the quota by more than ${INFERENCE_TOLERANCE.cpuRatio * 100}% plus ${INFERENCE_TOLERANCE.cpuPeriodsOfSlack} period of quota (the kernel charges per 100 ms period) |`,
            '| Memory | memory.current, memory.peak when present, memory.max, memory.swap.current, memory.events | the peak (the largest of memory.peak and every memory.current) is at or below memory.max (' + LLM_BUDGET.memoryPercent + '% of the Box RAM); swap is 0; oom_kill neither rises during the window nor is non-zero at its end |',
            `| GPU | the device's process rows (nvidia-smi -q -x): the runner's own rows by its verified host PID, else the owned MPS server's; the GPU utilisation; the runner's MPS environment (exactly the three CUDA_MPS_* variables) | the runner's device memory is at or below the share's pinned limit plus a ${INFERENCE_TOLERANCE.gpuContextMiB} MiB allowance for the CUDA context; every GPU process is ours or the one tolerated display process (A5). A row of neither the runner nor the owned server leaves the run BLOCKED, never PASS |`,
            '',
            'A foreign GPU process appearing while the model generates aborts the request, cleans up and leaves the case BLOCKED.',
            '',
        ] : []),
        '## Playground',
        '',
        cell(profile.llm.playground.reason),
        '',
        '## Prerequisites that may block real execution',
        '',
        '| Prerequisite | Evidence required | If it is missing |',
        '| --- | --- | --- |',
        '| The immutable local-llm image is present or pullable by the nested engine | the Box start pulls `' + cell(profile.provision.image) + '`; its size is not known before | the start fails and the run is cleaned up (BLOCKED when the failure is a missing prerequisite) |',
        `| The Box memory envelope covers the budget | 25% of it must be at least 3 GiB, and a whole percentage must give a cap between ${INSUFFICIENT_RAM.minCapBytes / 1048576} and ${INSUFFICIENT_RAM.maxCapBytes / 1048576} MiB for L2; at least ${LLM_BUDGET.cpus} CPUs | BLOCKED with the envelope |`,
        '| The host can reach the model source (Hugging Face and the network) | the model download | BLOCKED when Hugging Face or the network is unreachable, and when the download pauses (for example for lack of disk). A pin, size or digest mismatch, a deployment that ends in any other error, or a runner exit is a failure |',
        ...(l3 ? [] : [`| The model loads within the block deadline (LIVE-L1) | L1 waits for the deployment to be ready for up to ${run.deadlines.modelLoadMs} ms | BLOCKED with the phase and the download progress; a slow load is never a failure of the case |`]),
        ...(l3 ? [
            '| The image lock has a vLLM entry for linux/amd64 with CUDA wheels, equal to the pins | step 0 reads and compares it | BLOCKED with the exact missing prerequisite; nothing unpinned is ever installed |',
            '| Free disk for the wheels, their runnable copy and the model | step 0 states free and needed bytes per filesystem | BLOCKED |',
            `| The install and the model load fit the block deadline | the install has a hard cap of ${run.deadlines.installMs} ms (${(run.deadlines.installMs / 3600000).toFixed(1)} h) and is BLOCKED when its download shows no progress for ${run.deadlines.installStallMs} ms (${run.deadlines.installStallMs / 60000} min); that stall window applies only while the product is downloading, because the product reports no progress while it builds ('installing': the Python environment and the wheel install), so 'installing' is bounded by the hard cap only; model load within ${run.deadlines.modelLoadMs} ms; the whole block has ${run.deadlines.blockMs} ms (${(run.deadlines.blockMs / 3600000).toFixed(2)} h). The download throughput samples (bytes and time) are recorded: at most ${INSTALL_SAMPLES_HEAD + INSTALL_SAMPLES_TAIL} plus the first and the last download sample are kept (the first ${INSTALL_SAMPLES_HEAD} and the newest ${INSTALL_SAMPLES_TAIL} samples), and the throughput spans the whole download | BLOCKED with the progress made, never PASS |`,
            '| The wheels support the device and the denominator is physical | stage 1 reads torch\'s total under two limits | BLOCKED: vLLM under MPS stays unavailable |',
        ] : []),
        '',
    ];
}

// The summary beside a run manifest carries the configured document suffix
// (claude or codex, exactly once before the extension), like every evidence
// file the implementing agent writes.
export function summaryPathFor(runPath, documentSuffix) {
    if (!DOCUMENT_SUFFIXES.includes(documentSuffix)) throw new Error('The run summary needs the configured document suffix (claude or codex)');
    return `${runPath.replace(/(?:_claude|_codex)?\.json$/, '')}_summary_${documentSuffix}.md`;
}
