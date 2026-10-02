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
    hostRecordPaths, jsonDigest, keys, liveSourceDigest, observeEngineIdentity, workspaceSocketProblem,
} from './liveCommon.mjs';
import { runBoundedProcess } from './liveProcess.mjs';
import { createJournal, recordHostRecords, runOwnedCleanup } from './liveCleanup.mjs';

export const FIXTURE_REPOSITORY = 'hwlfixture';
export const FIXTURE_HARDWARE_LIMITS = Object.freeze({ memory: '64m', cpus: '0.5', pidsLimit: 64 });
const ROLES = Object.freeze(['memory', 'cpu', 'pids']);

// The fixture agents a selection needs. C2 needs three distinct owned agents
// (memory, cpu and pids pressure); C1 and A1 need one. Every agent carries all
// three limits, because the live inspection requires them on each agent.
export function fixturePlan(cases) {
    const roles = cases.includes('LIVE-C2') ? ROLES : ['memory'];
    return roles.map(role => ({ name: role, role, hardwareLimits: { ...FIXTURE_HARDWARE_LIMITS } }));
}

// The fixture manifest, readiness none, the pinned image and the limits
// declared through the neutral hardwareLimits field (never the deprecated
// llmRuntime.runtimePolicy.resources). The root agent enables the other
// fixture agents.
export function fixtureManifest(agent, { image, agents }) {
    const manifest = {
        container: image,
        agent: 'node -e "setInterval(()=>{},3600000)"',
        readiness: { protocol: 'none' },
        hardwareLimits: { ...agent.hardwareLimits },
    };
    const others = agents.filter(value => value.name !== agent.name);
    if (agent.name === agents[0].name && others.length) manifest.enable = others.map(value => `${FIXTURE_REPOSITORY}/${value.name}`);
    return manifest;
}

// Production's nested container name for one workspace agent
// (cli/sandbox/docker/common.js getAgentContainerName).
export function fixtureContainerName(workspace, agentName) {
    const safe = value => String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const hash = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 8);
    return `ploinky_${safe(FIXTURE_REPOSITORY)}_${safe(agentName)}_${safe(path.basename(workspace))}_${hash}`;
}

export function proposedWorkspaceIdentity(workspacePath) {
    assertBoxWorkspaceRoot(workspacePath);
    const pathHash = workspacePathHash(workspacePath);
    return { pathHash, instance: `ploinky-box-${workspaceSlug(workspacePath)}-${pathHash}` };
}

export function startArgs(profile, ports) {
    return [profile.candidate.path, '--port', String(ports.tcp), '--udp-port', String(ports.udp), 'start', profile.fixtures.cpu.ref];
}

export function validateProvisionPlan(value, run) {
    keys(value, ['revision', 'repository', 'image', 'boxImage', 'agents', 'workspace'], 'provision plan');
    if (!/^[a-f0-9]{40}$/.test(value.revision) || value.repository !== FIXTURE_REPOSITORY
        || !IMAGE_REF.test(value.image) || !IMAGE_REF.test(value.boxImage)) throw new Error('Invalid provision pins');
    keys(value.workspace, ['parent', 'parentMode', 'path'], 'provision workspace');
    if (!absolute(value.workspace.parent) || !absolute(value.workspace.path) || path.dirname(value.workspace.path) !== value.workspace.parent
        || !['create', 'staged'].includes(value.workspace.parentMode)) throw new Error('Invalid provision workspace');
    if (!Array.isArray(value.agents) || !value.agents.length || value.agents.length > 3) throw new Error('Invalid fixture agents');
    const names = new Set();
    for (const agent of value.agents) {
        keys(agent, ['name', 'role', 'hardwareLimits'], 'fixture agent');
        keys(agent.hardwareLimits, ['memory', 'cpus', 'pidsLimit'], 'fixture hardwareLimits');
        if (!ROLES.includes(agent.name) || agent.role !== agent.name || names.has(agent.name)
            || jsonDigest(agent.hardwareLimits) !== jsonDigest(FIXTURE_HARDWARE_LIMITS)) throw new Error('Invalid fixture agent');
        names.add(agent.name);
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
    run, persist = () => {}, processProvider = runBoundedProcess, signal, portProbe = probeLocalPorts, remoteArrival = false,
    hostIdentity = { hostname: os.hostname(), platform: process.platform, home: fs.realpathSync(os.homedir()) },
    validateProfile,
} = {}) {
    const limitations = [];
    let profile;
    try {
        if (run.state !== 'proposed' || run.operations.length || run.ownedBoxes.length || run.ownedPaths.length
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
    if (liveSourceDigest(profile.source.root) !== profile.source.digest) { limitations.push('Candidate source changed'); return provisionReport(run, 'BLOCKED', limitations); }

    const journaled = createJournal({ run, persist, processProvider, signal });
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
        const repository = path.join(anchor, 'repos', FIXTURE_REPOSITORY);
        for (const directory of [anchor, path.join(anchor, 'repos'), repository]) fs.mkdirSync(directory, { mode: 0o755 });
        const files = {};
        for (const agent of plan.agents) {
            fs.mkdirSync(path.join(repository, agent.name), { mode: 0o755 });
            const target = path.join(repository, agent.name, 'manifest.json');
            const bytes = `${JSON.stringify(fixtureManifest(agent, { image: plan.image, agents: plan.agents }), null, 2)}\n`;
            fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
            files[path.relative(workspace.path, target)] = digest(bytes);
        }
        const resolved = resolveWorkspaceIdentity({ env: {}, cwd: () => workspace.path });
        if (resolved.workspaceRoot !== workspace.path || resolved.instance !== instance) throw new Error('The fixture workspace does not resolve to itself');
        observed(fixtureOp, { resultArtifact: jsonDigest(files), files });

        // 5. Start the gate-on Box through the absolute candidate.
        // Host records were proved absent before this start, so every exact
        // record of the instance that exists afterwards is this run's, even
        // when the start itself fails.
        try {
            // The Box identity is deterministic, so it is recorded on the
            // intent before the process that creates it can run.
            await journaled('fixture-start', profile.node.path, startArgs(profile, run.ports), {
                cwd: workspace.path, env: { ...env, PLOINKY_BOX_HARDWARE_LIMITS: 'on' }, deadlineMs: run.deadlines.startMs || 1200000,
                box: { name: identity.instance, pathHash: identity.pathHash },
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
        profile.box = { id: box.id, created: box.created, image: box.image, contractDigest: jsonDigest({ labels: box.labels, mounts: box.mounts }), pathHash: identity.pathHash, instance };
        run.ownedBoxes.push({ id: box.id, created: box.created, contractDigest: profile.box.contractDigest, operation: 'fixture-start' });
        run.operations.push({ id: 'fixture-created', kind: 'fixture-created', state: 'observed', resourceIds: [box.id], argvDigest: null, resultArtifact: profile.box.contractDigest });
        persist();

        // Agent identities inside the owned Box, by production's exact names.
        const nested = ['container', 'exec', '--user', 'podman', box.id, 'podman', '--cgroup-manager=cgroupfs'];
        for (const agent of plan.agents) {
            const name = fixtureContainerName(workspace.path, agent.name);
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
