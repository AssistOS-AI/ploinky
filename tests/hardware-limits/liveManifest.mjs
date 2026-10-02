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
import { ENGINE_CONNECTIONS_ARGV, ENGINE_INFO_ARGV, HOST_RECORD_DIRECTORIES, IMAGE_REF, OWNER_MARKER, UNIX_SOCKET_PATH_LIMIT, WORKSPACE_SOCKET_NAME, digest, keys, AGENT_INSPECT, INSPECT } from './liveCommon.mjs';
import { FIXTURE_REPOSITORY, GPU_PROBE_TARGET, fixtureContainerName, fixtureManifest, fixturePlan, proposedWorkspaceIdentity, startArgs } from './liveFixture.mjs';
import { gpuQueryArgv } from './liveGpuGate.mjs';
import {
    ADMIN_REQUEST, GPU_SHARES, MPS_CLIENT_PIPE, PROBE_FILE, TIGHTER_CLIENT, controlHelperRunArgv, probeBoundMiB, probeExecArgv, shareMemoryMiB,
} from './liveGpuCommands.mjs';
import { remoteRoot, remoteReportName } from './liveStage.mjs';
import { DOCUMENT_SUFFIXES, GPU_TOLERATED_MAX, GPU_TOLERATED_MAX_MIB } from './fixtures.mjs';
import { sshOptions } from './liveRemote.mjs';

export const CONCRETE_BLOCKS = Object.freeze({
    'mac-cpu': { platform: 'darwin', remote: false, cases: ['LIVE-C1', 'LIVE-C2'] },
    'apparatus-cpu': { platform: 'linux', remote: true, cases: ['LIVE-A1'] },
    'apparatus-mps': { platform: 'linux', remote: true, cases: ['LIVE-P1', 'LIVE-P2', 'LIVE-P3', 'LIVE-P4'], gpu: true },
});
export const DEADLINES = Object.freeze({
    coreMs: 30000, startMs: 20 * 60 * 1000, destroyMs: 5 * 60 * 1000, fullGraphMs: 20 * 60 * 1000,
    modelLoadMs: 20 * 60 * 1000, cleanupMs: 5 * 60 * 1000, stagingMs: 10 * 60 * 1000, blockMs: 20 * 60 * 1000,
});
// The GPU block needs longer than the CPU ones: P3 alone runs six Applies.
export const GPU_DEADLINES = Object.freeze({ ...DEADLINES, blockMs: 24 * 60 * 1000 });
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE = /^\/[A-Za-z0-9/_.-]+$/;
const canonicalFile = file => path.isAbsolute(file) && fs.realpathSync(file) === file && fs.statSync(file).isFile();

// Operator-supplied pins from earlier read-only observation. prepare-live
// verifies every local file pin it can read; remote and engine-service pins
// are rechecked by the runner on arrival, before any mutation.
export function validatePins(value, block) {
    const spec = CONCRETE_BLOCKS[block];
    keys(value, ['schema', 'host', 'node', 'engine', 'boxImage'], 'pins', ['ssh', 'workspaceParentRoot', 'ports', 'gpu']);
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

export function buildConcreteManifest({ block, runId, configDigest, casesDigest, documentSuffix, pins, candidate, image, ports, unsupported }) {
    const spec = CONCRETE_BLOCKS[block];
    if (!spec) throw new Error(`Block ${block} has no implemented executor`);
    const remote = spec.remote;
    const root = remote ? remoteRoot(pins.host.home, runId) : null;
    const { parent, path: workspacePath } = proposedWorkspace(block, pins, runId);
    const identity = proposedWorkspaceIdentity(workspacePath);
    const sourceRoot = remote ? `${root}/source` : candidate.root;
    const candidateFile = path.join(candidate.root, 'ploinky-box', 'bin', 'ploinky-box.mjs');
    const agents = fixturePlan(spec.cases);
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
        fixtures: spec.gpu ? { gpu: { ref: `${FIXTURE_REPOSITORY}/${agents[0].name}` } } : { cpu: { ref: `${FIXTURE_REPOSITORY}/${agents[0].name}` } },
        provision: {
            revision: candidate.revision, repository: FIXTURE_REPOSITORY, image, boxImage: pins.boxImage, agents,
            workspace: { parent, parentMode: remote ? 'staged' : 'create', path: workspacePath },
        },
    };
    if (spec.gpu) {
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
        deadlines: { ...(spec.gpu ? GPU_DEADLINES : DEADLINES) },
        images: [
            { role: 'fixture-agent', ref: image, source: 'AssistOSExplorer explorer/manifest.json line 2' },
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
        ...plan.agents.map(agent => ({ id: `fixture-write-${agent.name}`, action: `Write ${workspace}/.ploinky/repos/${FIXTURE_REPOSITORY}/${agent.name}/manifest.json`, content: fixtureManifest(agent, { image: plan.image, agents: plan.agents }) })),
        ...(profile.gpu ? [
            { id: 'fixture-write-probe-file', action: `Copy ${profile.gpu.probe.sourcePath} (${profile.gpu.probe.digest}) to ${workspace}/.ploinky/repos/${FIXTURE_REPOSITORY}/${GPU_PROBE_TARGET}; the nested engine stages it at /code/${PROBE_FILE}` },
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
    if (profile.cases.includes('LIVE-A1')) live.push(
        { id: 'A1-held-allocation', binary: engine, argv: [...nested, 'container', 'exec', '<MEMORY_AGENT_ID>', 'node', '-e', '<HELD_ALLOCATION>', run.runId], deadlineMs: 25000 },
        { id: 'A1-handshake', binary: engine, argv: [...nested, 'container', 'exec', '<MEMORY_AGENT_ID>', 'node', '-e', '<ALLOCATION_HANDSHAKE>', run.runId, 'observe|release'], deadlineMs: 5000 },
        { id: 'A1-leaf-observer', binary: engine, argv: [...core, 'node', '-e', '<LEAF_OBSERVATION>', '<VERIFIED_LEAF>'], deadlineMs: 5000 },
    );
    if (profile.gpu) live.push(...gpuPlan(run).commands);
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
    const ports = ['--port', String(run.ports.tcp), '--udp-port', String(run.ports.udp)];
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
        { case: 'P3', id: 'P3-restart-agent', binary: node, argv: [profile.candidate.path, ...ports, 'restart', 'hwlfixture/probe'], cwd: plan(run).workspace.path, env: {}, deadlineMs: 600000, gpu: true, note: 'An ordinary restart after the host clear: the final-share shutdown logic runs' },
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
    const gateChecks = [
        [`\`${gpu.smi.path} ${gpuQueryArgv(uuid).join(' ')}\` exits 0 within 30 s with at most 1 MiB of output`, 'a query error blocks'],
        ['the XML parses strictly: one gpu element, no entity, CDATA or ampersand, exactly one uuid and compute_mode, one fb_memory_usage', 'malformed or unsupported output blocks'],
        [`the UUID is \`${uuid}\` and the total memory is ${gpu.memoryMiB} MiB`, 'another device blocks'],
        ['the compute mode is Default', 'any other mode blocks; the runner never changes it'],
        ['the process list is supported (no N/A) and, for the initial gate, empty: no compute or MPS process and no unrecorded graphics process (but for the one display process of amendment A5)', 'an unsupported inventory or any such process blocks'],
        [`amendment A5, one recorded display process: at the run's FIRST gate check (the provision action) ${GPU_TOLERATED_MAX === 1 ? 'one foreign process' : `up to ${GPU_TOLERATED_MAX} foreign processes`} may be recorded as tolerated, of type exactly \`G\` (graphics only, never C, C+G, M+C or any type with compute), using at most ${GPU_TOLERATED_MAX_MIB} MiB, not owned by the run, with a proven host identity (boot id and /proc start time). It is written to toleratedProcesses of the run manifest with its PID, start identity, name, type and memory; the recorded process is also in the gpu-initial-gate evidence and in every check's history`, 'a process that is not of type G, is over the memory limit, is a second foreign graphics process, or whose identity cannot be proved blocks the first check'],
        ['at every later check the only foreign process allowed is the recorded one: same PID and start identity, type still exactly G and memory still within the limit (the subset of that record). The runner never touches, signals or reprioritises a tolerated process and never changes the compute mode', 'a process that was not recorded, one that gained compute, one over the limit, a reused PID (another start identity) or an unprovable identity blocks; the recorded process disappearing is logged, not a failure'],
        ['before EVERY later GPU operation the query is repeated; a listed PID is excluded only if it is a registered owned MPS server (a child of the registered owned daemon in the Box\'s /ploinky/core) or client (inside a registered owned agent leaf) and its tuple is freshly verified: host boot ID, host PID, process start time, cgroup beneath the exact Box scope libpod-<BOX_ID>', 'a bare PID, UID or name never excludes; a changed tuple blocks'],
        ['free GPU memory covers the probe bound plus 1 GiB before each CUDA probe', 'less blocks'],
        ['during a probe the gate re-queries every 2 s', 'a foreign process aborts the probe command, trips the gate (no later GPU operation starts) and the case is BLOCKED; owned clients are stopped only by cleanup'],
        ['the runner never changes the compute mode and never signals a foreign process', 'the only signal it can send is the owned-daemon kill of P3, after both layers prove the identity'],
    ];
    return { operations, gateChecks, commands: operations.filter(entry => entry.argv && entry.case !== 'provision' && entry.case !== 'cleanup').map(({ case: caseId, gpu: isGpu, ...entry }) => ({ ...entry, note: `${caseId}${isGpu ? ' (GPU operation)' : ''}${entry.note ? `: ${entry.note}` : ''}` })) };
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
        ...plan.agents.map(agent => `| Fixture agent ${FIXTURE_REPOSITORY}/${agent.name} | hardwareLimits memory ${agent.hardwareLimits.memory}, cpus ${agent.hardwareLimits.cpus}, pids ${agent.hardwareLimits.pidsLimit}, readiness none |`),
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

// The extra approval sections of the GPU block: the idle-gate checks, every
// GPU operation, the images, tools and digests, and the grant and policy records.
function gpuSummary(run) {
    const profile = run.target.execution;
    const gpu = profile.gpu;
    const { operations, gateChecks } = gpuPlan(run);
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
        '## Images, tools and digests',
        '',
        '| Item | Identity |',
        '| --- | --- |',
        `| Fixture image (probe, peer, cpu and the control helper) | \`${profile.provision.image}\` (non-root image user 1000:1000; python3 and ctypes) |`,
        `| Box image | \`${profile.provision.boxImage}\` |`,
        `| nvidia-smi | \`${gpu.smi.path}\` ${gpu.smi.digest} |`,
        `| nvidia-cuda-mps-control | \`${gpu.mpsControl.path}\` ${gpu.mpsControl.digest} |`,
        `| nvidia-cuda-mps-server | \`${gpu.mpsServer.path}\` ${gpu.mpsServer.digest} |`,
        `| CUDA probe (mpsprobe.py) | \`${gpu.probe.sourcePath}\` ${gpu.probe.digest}, staged at /code/mpsprobe.py in the probe agent |`,
        '',
        '## Grant and policy records',
        '',
        '| Record | Created by | Removed by cleanup |',
        '| --- | --- | --- |',
        `| \`~/.ploinky-box/gpu-grants/${instance}.json\` and \`~/.ploinky-box/gpu-grants/${instance}/\` | \`gpu grant\` and the Box start | yes, only when recorded |`,
        `| \`~/.ploinky-box/hardware-limits/${instance}.json\` and \`~/.ploinky-box/hardware-limits/${instance}/\` (the gate record and the policy store holding the saved shares) | the start and the Apply path | yes, only when recorded |`,
        `| \`~/.ploinky-box/router-bindings/${instance}[.json]\` | the start | yes, only when recorded |`,
        '| the parent directories of the three | pre-existing on the host (\`gpu-grants\` already exists and stays) | only a parent this run created, and only while empty |',
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
