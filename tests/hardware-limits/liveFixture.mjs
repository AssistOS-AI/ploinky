// Owned CPU fixture provisioning for LIVE-C1, LIVE-C2 and LIVE-A1. From a
// proposed manifest it creates a fresh task workspace, preflights the
// selected ports, records the unrelated inventory, generates the fixture
// agents inside that workspace only, and starts the gate-on Box through the
// absolute candidate. Every receipt is persisted before later work depends on
// it, and any failure runs the owned cleanup: provisioning never reports PASS
// for a fixture it could not fully record.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import crypto from 'node:crypto';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity, resolveWorkspaceIdentity, workspacePathHash, workspaceSlug } from '../../ploinky-box/identity.mjs';
import { assertBoxWorkspaceRoot } from '../../ploinky-box/contract/workspace-root.mjs';
import { EXIT } from './fixtures.mjs';
import {
    AGENT_INSPECT, ID, IMAGE_REF, INSPECT, OWNER_MARKER, absolute, blocked, candidateEnv, checkedJson, digest,
    HOST_RECORD_DIRECTORIES, hostRecordPaths, jsonDigest, keys, liveSourceDigest, observeEngineIdentity, workspaceSocketProblem,
} from './liveCommon.mjs';
import { runBoundedProcess } from './liveProcess.mjs';
import { createJournal, recordHostRecords, runOwnedCleanup } from './liveCleanup.mjs';
import { createHostProc } from './liveGpuHost.mjs';
import { createGpuGate, gpuCleanupProof, gpuQueryArgv } from './liveGpuGate.mjs';
import { LLM_AGENT, LLM_REF, LLM_REPOSITORY } from './liveLlmNames.mjs';

export const FIXTURE_REPOSITORY = 'hwlfixture';
export const FIXTURE_HARDWARE_LIMITS = Object.freeze({ memory: '64m', cpus: '0.5', pidsLimit: 64 });
const ROLES = Object.freeze(['memory', 'cpu', 'pids']);
// The apparatus-mps fixture: two GPU share clients and one unrelated CPU agent
// (the CPU fixture's own limits). The GPU agents need room for a CUDA context.
export const GPU_FIXTURE_HARDWARE_LIMITS = Object.freeze({ memory: '2g', cpus: '1', pidsLimit: 128 });
export const GPU_ROLES = Object.freeze(['probe', 'peer']);
export const GPU_PROBE_TARGET = 'probe/mpsprobe.py';
// The local-llm fixture (apparatus-local-llm and apparatus-vllm): one owned agent, the local-llm
// candidate's own, which declares no limits of its own: the administrator's Apply sets them.
export { LLM_AGENT, LLM_REF, LLM_REPOSITORY };

// The fixture agents a selection needs. C2 needs three distinct owned agents
// (memory, cpu and pids pressure); C1 and A1 need one. Every agent carries all
// three limits, because the live inspection requires them on each agent.
export function fixturePlan(cases) {
    if (cases.some(id => String(id).startsWith('LIVE-L'))) {
        return [{ name: LLM_AGENT, role: 'llm', repository: LLM_REPOSITORY, hardwareLimits: null }];
    }
    if (cases.some(id => String(id).startsWith('LIVE-P'))) {
        return [
            { name: 'probe', role: 'probe', hardwareLimits: { ...GPU_FIXTURE_HARDWARE_LIMITS } },
            { name: 'peer', role: 'peer', hardwareLimits: { ...GPU_FIXTURE_HARDWARE_LIMITS } },
            { name: 'cpu', role: 'cpu', hardwareLimits: { ...FIXTURE_HARDWARE_LIMITS } },
        ];
    }
    const roles = cases.includes('LIVE-C2') ? ROLES : ['memory'];
    return roles.map(role => ({ name: role, role, hardwareLimits: { ...FIXTURE_HARDWARE_LIMITS } }));
}

// The fixture agent's process. Ploinky starts a manifest `agent` as `<shell> -c "cd <cwd> && <agent>"` under its control
// entrypoint, which forwards SIGTERM, SIGINT and SIGHUP to that shell and treats only EXIT ZERO as the application's drain
// acknowledgement (Agent/server/AgentEntrypoint.sh forward_termination; cli/sandbox/docker/targetedContainerLifecycle.js
// assertCleanTermination: "Signal termination (including 143) is never an acknowledgement"). So, like local-llm
// (`exec node /code/src/main.mjs`), the fixture agent execs its node process, which becomes the signalled main process, and
// exits 0 at once on each of the three signals. The ready line only lets a test know the handlers are installed.
export const FIXTURE_AGENT_COMMAND = 'exec node -e "for (const s of [\'SIGTERM\',\'SIGINT\',\'SIGHUP\']) process.on(s, () => process.exit(0)); console.log(\'fixture agent ready\'); setInterval(() => {}, 3600000)"';

// The fixture manifest, readiness none, the pinned image and the limits
// declared through the neutral hardwareLimits field (never the deprecated
// llmRuntime.runtimePolicy.resources). The root agent enables the other
// fixture agents.
export function fixtureManifest(agent, { image, agents }) {
    const manifest = {
        container: image,
        agent: FIXTURE_AGENT_COMMAND,
        readiness: { protocol: 'none' },
        hardwareLimits: { ...agent.hardwareLimits },
    };
    const others = agents.filter(value => value.name !== agent.name);
    if (agent.name === agents[0].name && others.length) manifest.enable = others.map(value => `${FIXTURE_REPOSITORY}/${value.name}`);
    return manifest;
}

// Production's nested container name for one workspace agent
// (cli/sandbox/docker/common.js getAgentContainerName).
export function fixtureContainerName(workspace, agentName, repository = FIXTURE_REPOSITORY) {
    const safe = value => String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const hash = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 8);
    return `ploinky_${safe(repository)}_${safe(agentName)}_${safe(path.basename(workspace))}_${hash}`;
}

// The local-llm candidate's manifest with its image pinned immutably: the candidate's own
// bytes, one field replaced, serialized the same way every time so the digest is a pin.
export function rewriteLlmManifest(bytes, image) {
    const manifest = JSON.parse(bytes);
    if (typeof manifest.container !== 'string' || !manifest.container) throw new Error('The local-llm manifest has no container image');
    return `${JSON.stringify({ ...manifest, container: image }, null, 2)}\n`;
}

export function proposedWorkspaceIdentity(workspacePath) {
    assertBoxWorkspaceRoot(workspacePath);
    const pathHash = workspacePathHash(workspacePath);
    return { pathHash, instance: `ploinky-box-${workspaceSlug(workspacePath)}-${pathHash}` };
}

export function startArgs(profile, ports) {
    return [profile.candidate.path, '--port', String(ports.tcp), '--udp-port', String(ports.udp), 'start', (profile.fixtures.llm || profile.fixtures.gpu || profile.fixtures.cpu).ref];
}

export function validateProvisionPlan(value, run) {
    keys(value, ['revision', 'repository', 'image', 'boxImage', 'agents', 'workspace'], 'provision plan', ['gpu', 'llm']);
    const llmFixture = value.llm !== undefined;
    if (!/^[a-f0-9]{40}$/.test(value.revision) || value.repository !== (llmFixture ? LLM_REPOSITORY : FIXTURE_REPOSITORY)
        || !IMAGE_REF.test(value.image) || !IMAGE_REF.test(value.boxImage)) throw new Error('Invalid provision pins');
    keys(value.workspace, ['parent', 'parentMode', 'path'], 'provision workspace');
    if (!absolute(value.workspace.parent) || !absolute(value.workspace.path) || path.dirname(value.workspace.path) !== value.workspace.parent
        || !['create', 'staged'].includes(value.workspace.parentMode)) throw new Error('Invalid provision workspace');
    if (!Array.isArray(value.agents) || !value.agents.length || value.agents.length > 3) throw new Error('Invalid fixture agents');
    const names = new Set();
    for (const agent of value.agents) {
        if (agent.role === 'llm') {
            // The local-llm candidate's own agent: no generated limits, the administrator sets them.
            keys(agent, ['name', 'role', 'repository', 'hardwareLimits'], 'fixture agent');
            if (agent.name !== LLM_AGENT || agent.repository !== LLM_REPOSITORY || agent.hardwareLimits !== null || names.has(agent.name)) throw new Error('Invalid fixture agent');
            names.add(agent.name);
            continue;
        }
        keys(agent, ['name', 'role', 'hardwareLimits'], 'fixture agent');
        keys(agent.hardwareLimits, ['memory', 'cpus', 'pidsLimit'], 'fixture hardwareLimits');
        const expected = GPU_ROLES.includes(agent.name) ? GPU_FIXTURE_HARDWARE_LIMITS : FIXTURE_HARDWARE_LIMITS;
        if (!(ROLES.includes(agent.name) || GPU_ROLES.includes(agent.name)) || agent.role !== agent.name || names.has(agent.name)
            || jsonDigest(agent.hardwareLimits) !== jsonDigest(expected)) throw new Error('Invalid fixture agent');
        names.add(agent.name);
    }
    if (llmFixture) {
        // Exactly the local-llm agent, its frozen tree and manifest pins, and a GPU grant for it alone.
        if (value.agents.map(agent => agent.role).join(',') !== 'llm' || value.gpu === undefined) throw new Error('The local-llm fixture plan is inconsistent');
        keys(value.llm, ['revision', 'sourcePath', 'treeDigest', 'manifest'], 'local-llm provision plan');
        keys(value.llm.manifest, ['originalContainer', 'originalDigest', 'rewrittenDigest'], 'local-llm manifest pins');
        if (!/^[a-f0-9]{40}$/.test(value.llm.revision) || !absolute(value.llm.sourcePath) || !/^sha256:[a-f0-9]{64}$/.test(value.llm.treeDigest)
            || !/^sha256:[a-f0-9]{64}$/.test(value.llm.manifest.originalDigest) || !/^sha256:[a-f0-9]{64}$/.test(value.llm.manifest.rewrittenDigest)
            || typeof value.llm.manifest.originalContainer !== 'string' || !value.llm.manifest.originalContainer) throw new Error('Invalid local-llm provision plan');
        keys(value.gpu, ['uuid', 'grantAgents'], 'GPU provision plan');
        if (!/^GPU-[a-fA-F0-9-]{8,64}$/.test(value.gpu.uuid) || value.gpu.grantAgents?.join(',') !== LLM_REF) throw new Error('Invalid GPU provision plan');
    } else {
        // The GPU fixture is exactly probe (the root), peer and the unrelated cpu agent.
        const gpuFixture = value.agents.some(agent => GPU_ROLES.includes(agent.name));
        if (gpuFixture !== (value.gpu !== undefined) || (gpuFixture && (value.agents.map(agent => agent.name).join(',') !== 'probe,peer,cpu'))) throw new Error('The GPU fixture plan is inconsistent');
        if (value.gpu !== undefined) {
            keys(value.gpu, ['uuid', 'grantAgents', 'probe'], 'GPU provision plan');
            keys(value.gpu.probe, ['sourcePath', 'digest', 'target'], 'GPU probe plan');
            if (!/^GPU-[a-fA-F0-9-]{8,64}$/.test(value.gpu.uuid) || !Array.isArray(value.gpu.grantAgents)
                || value.gpu.grantAgents.join(',') !== `${FIXTURE_REPOSITORY}/probe,${FIXTURE_REPOSITORY}/peer`
                || !absolute(value.gpu.probe.sourcePath) || !/^sha256:[a-f0-9]{64}$/.test(value.gpu.probe.digest) || value.gpu.probe.target !== GPU_PROBE_TARGET) throw new Error('Invalid GPU provision plan');
        }
    }
    if (run && (run.workspace?.proposedPath !== value.workspace.path || run.workspace?.instance !== proposedWorkspaceIdentity(value.workspace.path).instance)) {
        throw new Error('Provision workspace does not match the proposed identity');
    }
    return value;
}

// Host TCP (loopback and wildcard) and UDP (wildcard) availability. The
// probe binds and immediately closes; a collision aborts provisioning.
export async function probeLocalPorts({ tcp, udp }) {
    const tcpFree = host => new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen({ port: tcp, host, exclusive: true }, () => server.close(() => resolve(true)));
    });
    const udpFree = () => new Promise(resolve => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', () => { socket.close(); resolve(false); });
        socket.bind({ port: udp, address: '0.0.0.0', exclusive: true }, () => socket.close(() => resolve(true)));
    });
    return { tcp: (await tcpFree('127.0.0.1')) && (await tcpFree('0.0.0.0')), udp: await udpFree() };
}

function provisionReport(run, verdict, limitations) {
    return { schema: 1, runId: run.runId, action: 'provision', verdict, exitCode: EXIT[verdict], cases: [], cleanup: run.cleanup, limitations };
}

export async function provisionRun({
    run, persist = () => {}, processProvider = runBoundedProcess, signal, portProbe = probeLocalPorts, remoteArrival = false, artifacts = () => {},
    hostIdentity = { hostname: os.hostname(), platform: process.platform, home: fs.realpathSync(os.homedir()) },
    validateProfile, hostProc,
} = {}) {
    const limitations = [];
    let profile;
    try {
        if (run.state !== 'proposed' || run.operations.length || run.ownedBoxes.length || run.ownedPaths.length || run.toleratedProcesses?.length
            || run.cleanup.state !== 'not-started') throw new Error('Provisioning needs a fresh proposed manifest');
        profile = validateProfile(run, { partial: true });
        if (profile.workspace || profile.box || profile.agents.length || !profile.provision) throw new Error('Provisioning needs an unprovisioned execution profile');
        validateProvisionPlan(profile.provision, run);
        if (!Number.isInteger(run.ports.tcp) || !Number.isInteger(run.ports.udp) || run.ports.tcp === run.ports.udp
            || [run.ports.tcp, run.ports.udp].some(port => port < 1024 || port > 65535)) throw new Error('Provisioning needs separate selected TCP and UDP ports');
        // A locally created workspace sits under the pinned parent root; the
        // staged remote root is fixed by the runner and checked by prepare-live.
        const socketProblem = profile.provision.workspace.parentMode === 'create' ? workspaceSocketProblem(profile.provision.workspace.path) : null;
        if (socketProblem) throw new Error(socketProblem);
    } catch (error) { limitations.push(error.message); return provisionReport(run, 'BLOCKED', limitations); }
    if (run.target.ssh !== null && run.target.ssh !== undefined && !remoteArrival) {
        limitations.push('SSH target requires remote staging; no local fallback is permitted'); return provisionReport(run, 'BLOCKED', limitations);
    }
    if (profile.host.hostname !== hostIdentity.hostname || profile.host.platform !== hostIdentity.platform || profile.host.home !== hostIdentity.home) {
        limitations.push('Exact local host identity mismatch'); return provisionReport(run, 'BLOCKED', limitations);
    }
    for (const name of ['node', 'candidate', 'engine']) {
        const file = profile[name];
        if (fs.realpathSync(file.path) !== file.path || digest(fs.readFileSync(file.path)) !== file.digest) {
            limitations.push(`${name} executable identity changed`); return provisionReport(run, 'BLOCKED', limitations);
        }
    }
    // The pinned NVIDIA tools, by canonical path and content, before any GPU command.
    for (const name of ['smi', 'mpsControl', 'mpsServer']) {
        const file = profile.gpu?.[name];
        if (file && (!fs.existsSync(file.path) || fs.realpathSync(file.path) !== file.path || digest(fs.readFileSync(file.path)) !== file.digest)) {
            limitations.push(`NVIDIA tool ${name} identity changed`); return provisionReport(run, 'BLOCKED', limitations);
        }
    }
    if (liveSourceDigest(profile.source.root) !== profile.source.digest) { limitations.push('Candidate source changed'); return provisionReport(run, 'BLOCKED', limitations); }

    const journaled = createJournal({ run, persist, processProvider, signal, artifacts });
    const env = candidateEnv(profile);
    const plan = profile.provision;
    const engine = (kind, args, options = {}) => journaled(kind, profile.engine.path, args, { cwd: profile.host.home, env, deadlineMs: run.deadlines.coreMs || 30000, ...options });
    const intent = (kind, extra = {}) => { const op = { id: `provision-${run.operations.length + 1}`, kind, state: 'intent', resourceIds: [], argvDigest: null, resultArtifact: null, ...extra }; run.operations.push(op); persist(); return op; };
    const observed = (op, extra = {}) => { Object.assign(op, { state: 'observed' }, extra); persist(); };
    let mutated = false;
    try {
        run.state = 'running'; persist();
        // Engine identity, before any mutation.
        let engineIdentity;
        try { engineIdentity = await observeEngineIdentity((kind, argv) => engine(kind, argv)); } catch (error) { throw error?.code === 'ENGINE_IDENTITY_INCOMPLETE' ? blocked(error.message) : error; }
        if (engineIdentity !== profile.engine.identityDigest) throw blocked('Engine service identity changed');
        // No host record may already exist for this fresh instance.
        const instance = run.workspace.instance;
        const existing = hostRecordPaths(profile.host.home, instance).filter(target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
        if (existing.length) throw blocked('Host state already exists for the proposed workspace instance; it is not task-owned');
        // Which shared host-record directories exist before this run: one
        // that is absent now and present after the start was created by it.
        for (const directory of HOST_RECORD_DIRECTORIES) {
            const target = path.join(profile.host.home, '.ploinky-box', directory);
            let existed = true;
            try { fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; existed = false; }
            observed(intent('host-directory-preflight', { directory }), { existed });
        }

        // The GPU idle gate runs before anything is created: a busy, foreign,
        // unsupported or wrong-mode GPU is BLOCKED with nothing to clean up.
        if (plan.gpu) {
            // This is the run's FIRST gate check (amendment A5): a display process it
            // tolerates is recorded in the run manifest, with its identity, before anything is created.
            const gate = createGpuGate({
                query: () => processProvider(profile.gpu.smi.path, gpuQueryArgv(profile.gpu.uuid), { cwd: profile.host.home, env: { PATH: '/usr/bin:/bin', HOME: profile.host.home }, deadlineMs: 30000, maxBytes: 1048576, signal }),
                uuid: profile.gpu.uuid, host: hostProc || createHostProc(), boxPrefix: '/before-the-box', expectedMemoryMiB: profile.gpu.memoryMiB,
                recordTolerated: true,
                onTolerate: record => { run.toleratedProcesses ||= []; run.toleratedProcesses.push(record); persist(); },
            });
            let baseline;
            try { baseline = await gate.initial(); }
            finally { artifacts('gpu-initial-gate', { baseline: gate.baseline, tolerated: gate.tolerated, history: gate.history }); }
            observed(intent('gpu-initial-gate'), { result: { uuid: baseline.uuid, computeMode: baseline.computeMode, memory: baseline.memory } });
        }

        // 1. The workspace, refusing any pre-existing path.
        mutated = true;
        if (plan.workspace.parentMode === 'create') {
            const parent = createOwnedDirectory('workspace-parent-create', plan.workspace.parent, 0o700);
            run.ownedPaths.push({ ...parent, role: 'workspace-parent', type: 'directory' }); persist();
        } else assertStagedParent(plan.workspace.parent);
        const workspace = createOwnedDirectory('workspace-create', plan.workspace.path, 0o755);
        profile.workspace = workspace;
        run.ownedPaths.push({ path: workspace.path, role: 'workspace' });
        Object.assign(run.workspace, { uid: workspace.uid, dev: workspace.dev, ino: workspace.ino, marker: workspace.marker });
        persist();
        const identity = buildWorkspaceIdentity(workspace.path);
        if (identity.instance !== instance || identity.pathHash !== run.workspace.pathHash) throw new Error('Created workspace identity differs from the proposal');

        // 2. Separate free host ports.
        const portOp = intent('port-preflight', { resourceIds: [String(run.ports.tcp), String(run.ports.udp)] });
        const ports = await portProbe({ tcp: run.ports.tcp, udp: run.ports.udp });
        observed(portOp, { result: { tcp: ports?.tcp === true, udp: ports?.udp === true } });
        if (ports?.tcp !== true || ports?.udp !== true) throw blocked(`Selected host port collision (tcp ${run.ports.tcp}: ${ports?.tcp ? 'free' : 'busy'}, udp ${run.ports.udp}: ${ports?.udp ? 'free' : 'busy'})`);

        // 3. The sanitized inventory of unrelated containers.
        const ids = await listIds('pre-inventory');
        const containers = [];
        for (const id of ids) {
            const value = checkedJson(await engine('pre-inventory-inspect', ['container', 'inspect', '--format', INSPECT, id]));
            if (value.id !== id || value.labels?.[BOX_LABELS.pathHash] === identity.pathHash
                || value.mounts?.some(mount => mount.Source === workspace.path || String(mount.Source).startsWith(`${workspace.path}/`))) throw blocked('An existing container already claims the new workspace');
            containers.push({ id: value.id, created: value.created, image: value.image });
        }
        run.preInventory = { containers }; persist();

        // 4. The fixture agents, only inside the new workspace.
        const fixtureOp = intent('fixture-write');
        const anchor = path.join(workspace.path, '.ploinky');
        const repository = path.join(anchor, 'repos', plan.repository);
        for (const directory of [anchor, path.join(anchor, 'repos'), repository]) fs.mkdirSync(directory, { mode: 0o755 });
        const files = {};
        if (plan.llm) {
            // The local-llm candidate: its frozen tree, copied byte for byte, and its manifest with the image pinned.
            installLlmAgent({ plan, repository, workspacePath: workspace.path, files });
        } else {
            for (const agent of plan.agents) {
                fs.mkdirSync(path.join(repository, agent.name), { mode: 0o755 });
                const target = path.join(repository, agent.name, 'manifest.json');
                const bytes = `${JSON.stringify(fixtureManifest(agent, { image: plan.image, agents: plan.agents }), null, 2)}\n`;
                fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
                files[path.relative(workspace.path, target)] = digest(bytes);
            }
        }
        // The CUDA probe is test-only data in the probe agent's directory, so
        // the nested engine stages it at /code/mpsprobe.py; its bytes are pinned.
        if (plan.gpu?.probe) {
            const bytes = fs.readFileSync(plan.gpu.probe.sourcePath);
            if (digest(bytes) !== plan.gpu.probe.digest) throw blocked('The staged CUDA probe differs from the digest pinned in the manifest');
            const target = path.join(repository, plan.gpu.probe.target);
            fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
            files[path.relative(workspace.path, target)] = digest(bytes);
        }
        const resolved = resolveWorkspaceIdentity({ env: {}, cwd: () => workspace.path });
        if (resolved.workspaceRoot !== workspace.path || resolved.instance !== instance) throw new Error('The fixture workspace does not resolve to itself');
        observed(fixtureOp, { resultArtifact: jsonDigest(files), files });

        // 4b. The GPU grant, through the supported product path, before the
        //     first start (no Box exists yet, so the next start applies it).
        //     Its host records are recorded at once, whether or not it succeeds.
        if (plan.gpu) {
            try {
                await journaled('gpu-grant', profile.node.path, [profile.candidate.path, 'gpu', 'grant', ...plan.gpu.grantAgents.flatMap(ref => ['--agent', ref])],
                    { cwd: workspace.path, env, deadlineMs: run.deadlines.coreMs || 30000, capture: 'gpu-grant' });
            } catch (error) { throw blocked(`The GPU grant did not complete: ${String(error.message).slice(0, 300)}`); }
            finally { recordHostRecords(run, profile, instance); persist(); }
        }

        // 5. Start the gate-on Box through the absolute candidate.
        // Host records were proved absent before this start, so every exact
        // record of the instance that exists afterwards is this run's, even
        // when the start itself fails.
        try {
            // The Box identity is deterministic, so it is recorded on the
            // intent before the process that creates it can run.
            await journaled('fixture-start', profile.node.path, startArgs(profile, run.ports), {
                cwd: workspace.path, env: { ...env, PLOINKY_BOX_HARDWARE_LIMITS: 'on' }, deadlineMs: run.deadlines.startMs || 1200000,
                box: { name: identity.instance, pathHash: identity.pathHash }, capture: 'fixture-start',
            });
        } finally { recordHostRecords(run, profile, instance); persist(); }
        const after = await listIds('box-inventory');
        const before = new Set(containers.map(value => value.id));
        const boxes = [];
        for (const id of after.filter(value => !before.has(value))) {
            const value = checkedJson(await engine('box-inspect', ['container', 'inspect', '--format', INSPECT, id]));
            if (value.labels?.[BOX_LABELS.pathHash] === identity.pathHash && value.labels?.[BOX_LABELS.role] === 'box') boxes.push(value);
        }
        if (boxes.length !== 1) throw new Error(`Expected exactly one new Box for the workspace, found ${boxes.length}`);
        const box = boxes[0];
        if (!ID.test(box.id) || !ID.test(String(box.image).replace(/^sha256:/, '')) || typeof box.created !== 'string'
            || !Array.isArray(box.mounts) || !box.mounts.some(mount => mount.Source === workspace.path)
            || !/^[a-f0-9]{64}$/.test(box.labels?.[BOX_LABELS.hardwareLimits] || '')
            || box.labels?.[BOX_LABELS.imageRef] !== plan.boxImage || box.running !== true) throw new Error('The new Box is not the pinned gate-on Box of this workspace');
        if (plan.gpu) {
            const bound = destination => box.mounts.find(mount => mount.Destination === destination);
            if (!/^[a-f0-9]{64}$/.test(box.labels?.[BOX_LABELS.gpuGrant] || '')
                || !['nvidia-cuda-mps-control', 'nvidia-cuda-mps-server', 'nvidia-smi'].every(name => bound(`/usr/local/nvidia/bin/${name}`)?.RW === false)
                || bound('/usr/local/nvidia/lib64/libcuda.so.1')?.RW !== false) throw blocked('The Box was created without the GPU and MPS tool wiring (read-only NVIDIA tools and libcuda); check the host driver and the GPU grant');
        }
        profile.box = { id: box.id, created: box.created, image: box.image, contractDigest: jsonDigest({ labels: box.labels, mounts: box.mounts }), pathHash: identity.pathHash, instance };
        run.ownedBoxes.push({ id: box.id, created: box.created, contractDigest: profile.box.contractDigest, operation: 'fixture-start' });
        run.operations.push({ id: 'fixture-created', kind: 'fixture-created', state: 'observed', resourceIds: [box.id], argvDigest: null, resultArtifact: profile.box.contractDigest });
        persist();

        // Agent identities inside the owned Box, by production's exact names.
        const nested = ['container', 'exec', '--user', 'podman', box.id, 'podman', '--cgroup-manager=cgroupfs'];
        for (const agent of plan.agents) {
            const name = fixtureContainerName(workspace.path, agent.name, agent.repository || FIXTURE_REPOSITORY);
            const value = checkedJson(await engine('agent-inspect', [...nested, 'container', 'inspect', '--format', AGENT_INSPECT, name], { resourceIds: [box.id] }));
            if (!ID.test(value.id) || !ID.test(String(value.image).replace(/^sha256:/, '')) || typeof value.created !== 'string'
                || String(value.name).replace(/^\//, '') !== name || value.imageName !== plan.image || value.running !== true) throw new Error(`Fixture agent ${agent.name} is not the pinned running instance`);
            profile.agents.push({ id: value.id, created: value.created, image: value.image, role: agent.role });
            persist();
        }
        validateProfile(run);
        return provisionReport(run, 'PASS', limitations);
    } catch (error) {
        limitations.push(error.message);
        if (!mutated && error.code === 'LIVE_PREREQUISITE_MISSING') { run.state = 'complete'; run.cleanup.state = 'complete'; persist(); return provisionReport(run, 'BLOCKED', limitations); }
        run.state = 'cleanup-required'; run.cleanup.state = 'running'; persist();
        try {
            await runOwnedCleanup({ run, profile, persist, processProvider, signal });
            // A GPU fixture is certified clean only after a successful final GPU observation.
            if (profile.gpu) await gpuCleanupProof({ run, profile, processProvider, signal, hostProc, artifacts });
            run.cleanup.state = 'complete'; run.state = 'complete';
        } catch (cleanupError) { run.cleanup.state = 'failed'; run.cleanup.failures.push(cleanupError.message); }
        persist();
        const verdict = run.cleanup.state === 'complete' && error.code === 'LIVE_PREREQUISITE_MISSING' ? 'BLOCKED' : 'FAIL';
        return provisionReport(run, verdict, limitations);
    }

    async function listIds(kind) {
        const result = await engine(kind, ['container', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}']);
        const ids = result.stdout.trim() ? result.stdout.trim().split(/\s+/) : [];
        if (ids.length > 256 || ids.some(id => !ID.test(id))) throw new Error('Unsupported container inventory');
        return ids;
    }

    // mkdir never follows or reuses: an existing path is refused untouched.
    // The intent is persisted first, so a crash leaves a recorded path whose
    // emptiness or exact marker proves ownership.
    function createOwnedDirectory(kind, target, mode) {
        const op = intent(kind, { path: target });
        try { fs.mkdirSync(target, { mode }); }
        catch (error) {
            if (error.code === 'EEXIST') { op.state = 'observed'; op.result = { refused: 'pre-existing' }; op.kind = `${kind}-refused`; persist(); throw blocked(`Refusing pre-existing path ${target}`); }
            throw error;
        }
        fs.chmodSync(target, mode);
        fs.writeFileSync(path.join(target, OWNER_MARKER), run.runId, { flag: 'wx', mode: 0o600 });
        const stat = fs.lstatSync(target);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw new Error(`Created path is not canonical: ${target}`);
        const value = { path: target, uid: stat.uid, dev: String(stat.dev), ino: String(stat.ino), marker: run.runId };
        observed(op, { resultArtifact: jsonDigest(value) });
        return value;
    }

    // The staged apparatus root already exists: it must be canonical, private
    // and owned by this user, and carry this run's marker.
    function assertStagedParent(parent) {
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent || (stat.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
            || fs.readFileSync(path.join(parent, OWNER_MARKER), 'utf8') !== run.runId) throw blocked('The staged remote root is not this run\'s private root');
    }
}

// Copy the frozen local-llm tree into <repository>/local-llm and pin its image. Both the tree
// and the manifest are checked against the digests the approved manifest recorded, so what the
// Box runs is exactly what was approved: only the image reference differs from the candidate.
function installLlmAgent({ plan, repository, workspacePath, files }) {
    const llm = plan.llm;
    if (liveSourceDigest(llm.sourcePath) !== llm.treeDigest) throw blocked('The staged local-llm tree differs from the digest pinned in the manifest');
    const target = path.join(repository, LLM_AGENT);
    const copy = (from, to) => {
        fs.mkdirSync(to, { mode: 0o755 });
        for (const name of fs.readdirSync(from).sort()) {
            const source = path.join(from, name); const stat = fs.lstatSync(source);
            if (stat.isDirectory()) copy(source, path.join(to, name));
            else if (stat.isFile()) fs.copyFileSync(source, path.join(to, name), fs.constants.COPYFILE_EXCL);
            else throw new Error(`The local-llm tree holds a link or special file: ${name}`);
        }
    };
    copy(llm.sourcePath, target);
    const manifestFile = path.join(target, 'manifest.json');
    const original = fs.readFileSync(manifestFile);
    if (digest(original) !== llm.manifest.originalDigest) throw blocked('The staged local-llm manifest differs from the digest pinned in the manifest');
    if (JSON.parse(original).container !== llm.manifest.originalContainer) throw blocked('The staged local-llm manifest names another image than the one pinned in the manifest');
    const rewritten = rewriteLlmManifest(original, plan.image);
    if (digest(rewritten) !== llm.manifest.rewrittenDigest) throw blocked('The rewritten local-llm manifest differs from the digest pinned in the manifest');
    fs.writeFileSync(manifestFile, rewritten, { mode: 0o644 });
    files[path.relative(workspacePath, target)] = llm.treeDigest;
    files[path.relative(workspacePath, manifestFile)] = digest(rewritten);
}
