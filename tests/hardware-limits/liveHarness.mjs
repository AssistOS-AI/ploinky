// Test-only owned-fixture execution. Unsupported acceptance cases stay BLOCKED.
// Preparing or editing a manifest is never authorization to execute it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { EXIT, validateRunManifest, writePrivateJson } from './fixtures.mjs';
import { runBoundedProcess, requireTransport } from './liveProcess.mjs';
import { assertRemoteArrival } from './liveRemote.mjs';
import {
    HASH, ID, INSPECT, absolute, assertWorkspace, blocked, bounded, candidateEnv, checkedJson, digest, hostRecordPaths,
    jsonDigest, keys, liveSourceDigest, receipt,
} from './liveCommon.mjs';
import { recordHostRecords, runOwnedCleanup } from './liveCleanup.mjs';
import { provisionRun, validateProvisionPlan } from './liveFixture.mjs';
import { stageAndDispatch } from './liveStage.mjs';
import {
    CORE_LAYOUT, MEMBERSHIP as PROCESS_MEMBERSHIP, HELD_ALLOCATION, ALLOCATION_HANDSHAKE, LEAF_OBSERVATION, assertCoreLayout,
} from './liveCaseCommands.mjs';

export const LIVE_CASES = Object.freeze({
    'mac-cpu': ['LIVE-C1', 'LIVE-C2', 'LIVE-C3', 'LIVE-C4', 'LIVE-C5', 'LIVE-C6', 'LIVE-C7'],
    'mac-adversarial': ['LIVE-S1', 'LIVE-S2'],
    'mac-explorer': ['LIVE-X0', 'LIVE-X1'],
    'apparatus-cpu': ['LIVE-A1'],
    'apparatus-mps': ['LIVE-P1', 'LIVE-P2', 'LIVE-P3', 'LIVE-P4'],
    'apparatus-local-llm': ['LIVE-L1', 'LIVE-L2'],
    'apparatus-vllm': ['LIVE-L3'],
});
export const UNSUPPORTED = Object.freeze({
    'LIVE-C3': 'Actual D4 graph, routing and asynchronous optional-child fixtures are not implemented.',
    'LIVE-C4': 'Actual stored-policy downgrade/no-mutation fixture is not implemented.',
    'LIVE-C5': 'Host/in-Box writer and barrier interleaving fixture is not implemented.',
    'LIVE-C6': 'Live authority-helper post-probe observation fixture is not implemented.',
    'LIVE-C7': 'Host bind/GPU/reapply/rollback generation matrix is not implemented.',
    'LIVE-S1': 'Capable namespace attack fixture and ownership proof are not implemented.',
    'LIVE-S2': 'Guard-removal and reachability fixture is not implemented.',
    'LIVE-X0': 'Fresh complete Explorer graph readiness inventory is not implemented.',
    'LIVE-X1': 'Fresh browser account, UI mutation and screenshot fixture is not implemented.',
    'LIVE-P1': 'Remote provisioning, actual UID mapping and driver readback qualification are not implemented.',
    'LIVE-P2': 'Owned live CUDA SM/VRAM and bypass fixture is not implemented.',
    'LIVE-P3': 'Actual daemon crash/drain/restart cohort fixture is not implemented.',
    'LIVE-P4': 'Owned writable-pipe control helper fixture is not implemented.',
    'LIVE-L1': 'Fresh model-data, runner and browser inference fixture is not implemented.',
    'LIVE-L2': 'Live model stop/replacement/refusal fixture is not implemented.',
    'LIVE-L3': 'Actual vLLM denominator and pinned model qualification fixture is not implemented.',
});
export { assertWorkspace, jsonDigest, liveSourceDigest };
export const LIVE_ACTIONS = Object.freeze(['provision', 'live', 'cleanup']);

// The execution profile. A complete profile (live) needs the workspace
// receipt, the owned Box, its agents and the durable fixture receipt. A
// partial profile (provisioning, and cleanup after an interrupted
// provisioning) may lack any of them; cleanup then works from whatever
// receipts and intents the manifest holds.
export function validateProfile(run, { partial = false } = {}) {
    validateRunManifest(run);
    const profile = run.target.execution;
    keys(profile, ['protocol', 'host', 'node', 'candidate', 'engine', 'source', 'workspace', 'box', 'agents', 'cases'], 'execution profile', ['fixtures', 'provision']);
    if (profile.fixtures !== undefined) {
        keys(profile.fixtures, [], 'fixtures', ['cpu']);
        if (profile.fixtures.cpu !== undefined) {
            keys(profile.fixtures.cpu, ['ref'], 'CPU fixture');
            if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(profile.fixtures.cpu.ref)) throw new Error('Invalid CPU fixture reference');
        }
    }
    if (profile.protocol !== 'owned-fixture-v1') throw new Error('Unsupported execution profile');
    keys(profile.host, ['hostname', 'platform', 'home'], 'host');
    if (!absolute(profile.host.home) || !bounded(profile.host.hostname, 255) || !['darwin', 'linux'].includes(profile.host.platform)) throw new Error('Invalid host');
    for (const name of ['node', 'candidate', 'engine']) {
        keys(profile[name], name === 'engine' ? ['path', 'digest', 'identityDigest'] : ['path', 'digest'], name);
        if (name === 'engine' && !HASH.test(profile.engine.identityDigest)) throw new Error('Missing engine service identity');
        if (!absolute(profile[name].path) || !HASH.test(profile[name].digest)) throw new Error(`Invalid ${name} pin`);
    }
    if (profile.provision !== undefined) validateProvisionPlan(profile.provision, run);
    const workspacePath = profile.workspace?.path || profile.provision?.workspace.path;
    keys(profile.source, ['root', 'digest'], 'source');
    if (!absolute(profile.source.root) || !HASH.test(profile.source.digest)
        || !profile.candidate.path.startsWith(profile.source.root + path.sep)
        || !workspacePath || workspacePath.startsWith(profile.source.root + path.sep)) throw new Error('Invalid disjoint source pin');
    if (!partial || profile.workspace !== null) {
        receipt(profile.workspace);
        if (profile.workspace.marker !== run.runId) throw new Error('Foreign workspace marker');
        if (profile.provision && profile.workspace.path !== profile.provision.workspace.path) throw new Error('Workspace receipt is not the proposed workspace');
    }
    if (!partial || profile.box !== null) {
        keys(profile.box, ['id', 'created', 'image', 'contractDigest', 'pathHash', 'instance'], 'Box');
        if (!ID.test(profile.box.id) || !ID.test(profile.box.image.replace(/^sha256:/, ''))
            || !HASH.test(profile.box.contractDigest) || !bounded(profile.box.created, 128)
            || !/^[a-f0-9]{12}$/.test(profile.box.pathHash) || !bounded(profile.box.instance, 128)) throw new Error('Invalid Box identity');
    }
    if (!Array.isArray(profile.agents) || profile.agents.length > 3) throw new Error('Invalid agents');
    const ids = new Set();
    const roles = new Set();
    for (const agent of profile.agents) {
        keys(agent, ['id', 'created', 'image', 'role'], 'agent');
        if (!ID.test(agent.id) || !ID.test(agent.image.replace(/^sha256:/, '')) || !bounded(agent.created, 128)
            || !['memory', 'cpu', 'pids'].includes(agent.role) || ids.has(agent.id) || roles.has(agent.role)) throw new Error('Invalid agent identity');
        ids.add(agent.id); roles.add(agent.role);
    }
    if (!Array.isArray(profile.cases) || !profile.cases.length || profile.cases.length > 20
        || new Set(profile.cases).size !== profile.cases.length
        || profile.cases.some(id => !LIVE_CASES[run.block].includes(id))) throw new Error('Invalid case selection');
    if (!partial) {
        if (profile.cases.includes('LIVE-C2') && (profile.agents.length !== 3 || roles.size !== 3)) throw new Error('C2 requires three distinct owned agents');
        if (profile.provision && (profile.agents.length !== profile.provision.agents.length
            || profile.provision.agents.some(agent => !roles.has(agent.role)))) throw new Error('Provisioned agents differ from the fixture plan');
        if (run.ownedBoxes.length !== 1) throw new Error('Only one immutable owned Box is supported');
        keys(run.preInventory, ['containers'], 'before inventory');
        if (!run.ownedBoxes.some(box => box.id === profile.box.id && box.created === profile.box.created)) throw new Error('Missing Box receipt');
        if (!run.operations.some(op => op.id === 'fixture-created' && op.state === 'observed'
            && op.resourceIds?.includes(profile.box.id))) throw new Error('Missing durable fixture creation receipt');
    } else {
        if (run.ownedBoxes.length > 1) throw new Error('Only one immutable owned Box is supported');
        keys(run.preInventory, [], 'before inventory', ['containers']);
    }
    if (run.preInventory.containers !== undefined && (!Array.isArray(run.preInventory.containers) || run.preInventory.containers.length > 256
        || run.preInventory.containers.some(value => !ID.test(value.id) || !bounded(value.created, 128) || !bounded(value.image, 128)))) throw new Error('Invalid before inventory');
    if (run.ownedProcesses.length) throw new Error('This executor cannot clean extra recorded processes or paths');
    validateOwnedPaths(run, profile);
    return profile;
}

export function validateExecutionProfile(run) {
    return validateProfile(run);
}

// Owned paths are exactly: the workspace, the task-owned temporary parent
// this run created, and host records of this exact instance. Anything else
// cannot be cleaned and refuses the manifest.
function validateOwnedPaths(run, profile) {
    const instance = profile.box?.instance || run.workspace?.instance;
    const allowedRecords = instance && /^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/.test(instance) ? hostRecordPaths(profile.host.home, instance) : [];
    const seen = new Set();
    for (const entry of run.ownedPaths) {
        if (!entry || seen.has(entry.path)) throw new Error('This executor cannot clean extra recorded processes or paths');
        seen.add(entry.path);
        if (entry.role === undefined || entry.role === 'workspace') {
            keys(entry, ['path'], 'owned workspace path', ['role']);
            if (entry.path !== profile.workspace?.path) throw new Error('This executor cannot clean extra recorded processes or paths');
        } else if (entry.role === 'workspace-parent') {
            keys(entry, ['path', 'role', 'type', 'uid', 'dev', 'ino', 'marker'], 'owned workspace parent');
            if (profile.provision?.workspace.parentMode !== 'create' || entry.path !== profile.provision.workspace.parent
                || entry.type !== 'directory' || entry.marker !== run.runId || !Number.isSafeInteger(entry.uid)
                || !/^\d+$/.test(entry.dev) || !/^\d+$/.test(entry.ino)) throw new Error('Invalid owned workspace parent');
        } else if (entry.role === 'host-record') {
            keys(entry, ['path', 'role', 'type', 'uid', 'dev', 'ino'], 'owned host record');
            if (!allowedRecords.includes(entry.path) || !['file', 'directory'].includes(entry.type) || !Number.isSafeInteger(entry.uid)
                || !/^\d+$/.test(entry.dev) || !/^\d+$/.test(entry.ino)) throw new Error('Refusing an unrecorded or non-exact host record');
        } else throw new Error('This executor cannot clean extra recorded processes or paths');
    }
}

// This record binds an operator's separate execution-time authorization to
// an exact input. It is not consent, and prepare-live never creates it.
export function validateAuthorization(run, bytes, authorization, action) {
    keys(authorization, ['schema', 'runId', 'manifestDigest', 'targetDigest', 'action'], 'authorization binding');
    if (authorization.schema !== 1 || authorization.runId !== run.runId || authorization.action !== action
        || authorization.manifestDigest !== digest(bytes) || authorization.targetDigest !== jsonDigest(run.target)) {
        throw new Error('Execution authorization binding does not match exact manifest, target and action');
    }
}

export function readPrivateJson(file, maxBytes = 262144) {
    if (!absolute(file) || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error('Noncanonical evidence path');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()
            || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) throw new Error('Unsafe private evidence file');
        const bytes = fs.readFileSync(fd);
        return { value: JSON.parse(bytes), bytes };
    } finally { fs.closeSync(fd); }
}

const MEMBERSHIP = 'const fs=require("node:fs");const pid=process.argv[1];if(!/^[1-9][0-9]*$/.test(pid))throw Error("Invalid PID");process.stdout.write(fs.readFileSync("/proc/"+pid+"/cgroup","utf8"));';
const OBSERVE = 'const fs=require("node:fs");const p=process.argv[1];if(fs.realpathSync(p)!==p)throw Error("Noncanonical leaf");const names=["memory.max","memory.swap.max","memory.current","memory.swap.current","memory.events","cpu.max","cpu.stat","pids.max","pids.events"];const st=fs.statSync(p);process.stdout.write(JSON.stringify({...Object.fromEntries(names.map(n=>[n,fs.readFileSync(p+"/"+n,"utf8")])),identity:{dev:String(st.dev),ino:String(st.ino)}}));';
const PRESSURE = Object.freeze({
    memory: 'const held=[];const t=setInterval(()=>held.push(Buffer.alloc(8*1024*1024,0x5a)),100);setTimeout(()=>{clearInterval(t);process.exit(0)},12000);',
    cpu: 'const end=Date.now()+5000;while(Date.now()<end){Math.sqrt(Math.random());}',
    pids: 'const {spawn}=require("node:child_process");let pending=0,errors=0;for(let i=0;i<96;i++){pending++;const c=spawn("sleep",["3"]);let done=false;const finish=()=>{if(done)return;done=true;if(--pending===0)process.stdout.write(JSON.stringify({errors})+"\\n");};c.on("error",()=>{errors++;finish();});c.on("close",finish);}',
});
function counter(text, name) {
    const match = String(text).match(new RegExp(`(?:^|\\n)${name} ([0-9]+)(?:\\n|$)`));
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Missing counter ${name}`);
    return Number(match[1]);
}
function requireLeafLimits(leaf) {
    const cpu = String(leaf['cpu.max']).trim().split(/\s+/);
    if (String(leaf['memory.max']).trim() !== '67108864' || String(leaf['memory.swap.max']).trim() !== '0'
        || cpu[0] !== '50000' || cpu[1] !== '100000' || String(leaf['pids.max']).trim() !== '64') throw new Error('Actual leaf limits differ');
}

export function createLiveAdapter(profile, {
    processProvider = runBoundedProcess, signal, cleanupSignal, persist = () => {}, run,
} = {}) {
    const env = candidateEnv(profile);
    async function command(kind, binary, args, { deadlineMs = 30000, stress = false, cleanup = false, gate = null } = {}) {
        assertWorkspace(profile);
        if (['pressure', 'destroy-box'].includes(kind) && liveSourceDigest(profile.source.root) !== profile.source.digest) throw new Error('Candidate source changed');
        const op = { id: `live-${run.operations.length + 1}`, kind, state: 'intent', resourceIds: [profile.box.id], argvDigest: jsonDigest([binary, ...args]), resultArtifact: null };
        if (run.operations.length >= 512 || Buffer.byteLength(JSON.stringify(run)) > 190000) throw new Error('Live journal bound exceeded');
        run.operations.push(op); persist();
        const result = await processProvider(binary, args, { cwd: profile.workspace.path, env: gate === null ? env : { ...env, PLOINKY_BOX_HARDWARE_LIMITS: gate }, deadlineMs, maxBytes: 65536, signal: cleanup ? cleanupSignal : signal });
        op.state = 'observed';
        // Only fixed observation commands return persisted output. Candidate
        // diagnostics may contain credentials; retain status flags alone.
        op.result = { status: result.status, signal: result.signal, timedOut: result.timedOut, truncated: result.truncated, cancelled: result.cancelled, errorCode: result.errorCode };
        persist();
        requireTransport(result, { stress });
        return result;
    }
    const core = ['container', 'exec', '--user', 'podman', profile.box.id];
    const nested = [...core, 'podman', '--cgroup-manager=cgroupfs'];
    const engine = (kind, args, options) => command(kind, profile.engine.path, args, options);
    async function assertEngine(cleanup = false) {
        const host = checkedJson(await engine('engine-identity', ['info', '--format', '{{json .Host}}'], { cleanup }));
        if (jsonDigest({ arch: host.arch, os: host.os, hostname: host.hostname, id: host.id }) !== profile.engine.identityDigest) throw new Error('Engine service identity changed');
    }
    async function inspectBox({ cleanup = false } = {}) {
        await assertEngine(cleanup);
        const box = checkedJson(await engine('inspect-box', ['container', 'inspect', '--format', INSPECT, profile.box.id], { cleanup }));
        const identity = assertWorkspace(profile);
        if (box.id !== profile.box.id || box.created !== profile.box.created || box.image !== profile.box.image
            || box.labels?.[BOX_LABELS.pathHash] !== identity.pathHash || box.labels?.[BOX_LABELS.role] !== 'box'
            || jsonDigest({ labels: box.labels, mounts: box.mounts }) !== profile.box.contractDigest) throw new Error('Box identity/contract changed');
        return box;
    }
    async function inspectAgent(agent) {
        await inspectBox();
        const actual = checkedJson(await engine('inspect-agent', [...nested, 'container', 'inspect', '--format', INSPECT, agent.id]));
        if (actual.id !== agent.id || actual.created !== agent.created || actual.image !== agent.image || actual.running !== true
            || !Number.isSafeInteger(actual.pid) || actual.pid <= 0 || !bounded(actual.startedAt, 128)) throw new Error('Agent identity changed');
        if (actual.memory !== 67108864 || actual.memorySwap !== 67108864 || actual.pidsLimit !== 64
            || !(actual.nanoCpus === 500000000 || actual.cpuQuota === 50000 && actual.cpuPeriod === 100000)) throw new Error('Agent inspect limits differ');
        return actual;
    }
    async function cpuCase() {
        const evidence = [];
        for (const agent of profile.agents) {
            const processIdentity = await inspectAgent(agent);
            const membership = (await engine('leaf-membership', [...core, 'node', '-e', MEMBERSHIP, String(processIdentity.pid)])).stdout.trim();
            const match = membership.match(/^0::(\/ploinky\/agents\/[A-Za-z0-9_.:/-]+)$/);
            if (!match || match[1].split('/').includes('..') || match[1].includes('//')) throw new Error('Unproven agent cgroup membership');
            const leafPath = `/sys/fs/cgroup${match[1]}`;
            const observe = async () => checkedJson(await engine('leaf-observer', [...core, 'node', '-e', OBSERVE, leafPath], { deadlineMs: 5000 }));
            const before = await observe(); requireLeafLimits(before);
            const rechecked = await inspectAgent(agent);
            if (rechecked.pid !== processIdentity.pid || rechecked.startedAt !== processIdentity.startedAt) throw new Error('Agent process generation changed');
            const samples = [before];
            let done = false;
            let observationError = null;
            const pressure = engine('pressure', [...nested, 'container', 'exec', agent.id, 'node', '-e', PRESSURE[agent.role]], { deadlineMs: 15000, stress: true })
                .finally(() => { done = true; });
            // Attach immediately, so an early process error cannot become an
            // unhandled rejection while the observer is collecting evidence.
            pressure.catch(() => {});
            while (!done && samples.length < 300) {
                try { samples.push(await observe()); } catch (error) { observationError = error.message; break; }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            const result = await pressure;
            const [field, key] = agent.role === 'memory' ? ['memory.events', 'oom_kill']
                : agent.role === 'cpu' ? ['cpu.stat', 'nr_throttled'] : ['pids.events', 'max'];
            const baseline = counter(before[field], key);
            if (!before.identity?.dev || !before.identity?.ino || samples.some(sample => jsonDigest(sample.identity) !== jsonDigest(before.identity))) throw new Error('Cgroup leaf identity changed');
            if (!samples.some(sample => counter(sample[field], key) > baseline)) throw new Error(`No same-leaf ${key} delta`);
            evidence.push({ id: agent.id, created: agent.created, pid: processIdentity.pid, startedAt: processIdentity.startedAt, leafPath, role: agent.role, before, samples, status: result.status, observationError });
        }
        return evidence;
    }
    async function coreCase() {
        const fixture = profile.fixtures?.cpu;
        if (!fixture) throw blocked('LIVE-C1 needs the installed immutable CPU fixture reference');
        // C1 proves enforcement only through its owned fixture instance, whose
        // every agent carries memory, cpu and pids limits (inspectAgent).
        if (!profile.agents.length) throw blocked('LIVE-C1 needs its owned fixture instance with memory, cpu and pids limits');
        const existing = await inspectBox();
        if (!/^[a-f0-9]{64}$/.test(existing.labels?.[BOX_LABELS.hardwareLimits] || '')) throw blocked('LIVE-C1 requires a provisioned gate-on Box receipt before its repeat-start checks');
        // The plan's explicit repeat starts use the run's selected ports. Any
        // host record they create for this owned instance is recorded at once.
        const ports = Number.isInteger(run.ports?.tcp) && Number.isInteger(run.ports?.udp)
            ? ['--port', String(run.ports.tcp), '--udp-port', String(run.ports.udp)] : [];
        const startDeadline = Number.isInteger(run.deadlines?.startMs) ? run.deadlines.startMs : 1200000;
        try { await command('repeat-gate-on-start', profile.node.path, [profile.candidate.path, ...ports, 'start', fixture.ref], { gate: 'on', deadlineMs: startDeadline }); }
        finally { if (recordHostRecords(run, profile, profile.box.instance)) persist(); }
        await inspectBox();
        try { await command('repeat-saved-gate-start', profile.node.path, [profile.candidate.path, ...ports, 'start', fixture.ref], { deadlineMs: startDeadline }); }
        finally { if (recordHostRecords(run, profile, profile.box.instance)) persist(); }
        await inspectBox();
        // The proof below only observes; it never runs production's
        // repairing root preparation. The read-only CORE_LAYOUT observation,
        // run as the unprivileged Box user, is persisted as evidence before
        // any assertion, and an unprepared, drifted or wrongly delegated Box
        // fails C1 with that evidence and is left exactly as observed.
        const observation = checkedJson(await engine('core-layout', [...core, 'node', '-e', CORE_LAYOUT]));
        const observationOp = run.operations.at(-1);
        if (observationOp?.kind !== 'core-layout' || Buffer.byteLength(JSON.stringify(observation)) > 32768) throw new Error('Core layout observation cannot be recorded');
        observationOp.observation = observation; persist();
        let delegation;
        try { delegation = assertCoreLayout(observation, { fixtureControllers: FIXTURE_CONTROLLERS }); }
        catch (error) { throw Object.assign(error, { evidence: { layout: observation } }); }
        const agents = [];
        for (const agent of profile.agents) {
            const current = await inspectAgent(agent);
            if (!Number.isSafeInteger(current.conmonPid) || current.conmonPid <= 0) throw blocked('Engine did not expose exact conmon PID');
            const observePid = async pid => checkedJson(await engine('process-placement', [...core, 'node', '-e', PROCESS_MEMBERSHIP, String(pid)]));
            const workload = await observePid(current.pid), conmon = await observePid(current.conmonPid);
            if (!/^0::\/ploinky\/agents\/[A-Za-z0-9_.:/-]+\s*$/.test(workload.cgroup)
                || !/^0::\/ploinky\/(core|agents\/[A-Za-z0-9_.:/-]+)\s*$/.test(conmon.cgroup)) throw new Error('Workload/conmon placement mismatch');
            const leaf = '/sys/fs/cgroup' + workload.cgroup.trim().slice(3);
            const limits = checkedJson(await engine('leaf-observer', [...core, 'node', '-e', LEAF_OBSERVATION, leaf])); requireLeafLimits(limits);
            agents.push({ id: agent.id, workload, conmon, limits });
        }
        return { delegation, layout: observation, agents, omittedGateRetained: true };
    }
    async function swapCase() {
        const agent = profile.agents.find(value => value.role === 'memory');
        if (!agent) throw blocked('LIVE-A1 requires the owned 64-MiB memory fixture instance');
        const original = await inspectAgent(agent);
        const membership = checkedJson(await engine('process-placement', [...core, 'node', '-e', PROCESS_MEMBERSHIP, String(original.pid)]));
        if (!/^0::\/ploinky\/agents\/[A-Za-z0-9_.:/-]+\s*$/.test(membership.cgroup)) throw new Error('Unproven memory fixture cgroup');
        const leaf = '/sys/fs/cgroup' + membership.cgroup.trim().slice(3);
        const observe = async () => checkedJson(await engine('leaf-observer', [...core, 'node', '-e', LEAF_OBSERVATION, leaf], { deadlineMs: 5000 }));
        const before = await observe(); requireLeafLimits(before);
        let finished = false;
        const allocation = engine('held-pressure', [...nested, 'container', 'exec', agent.id, 'node', '-e', HELD_ALLOCATION, run.runId], { deadlineMs: 25000, stress: true }).finally(() => { finished = true; });
        allocation.catch(() => {});
        const aliveSamples = [], pressureSamples = []; let released = false; let receipt = null;
        try {
            const deadline = Date.now() + 20000;
            while (!finished && Date.now() < deadline) {
                if (!released) {
                    receipt = checkedJson(await engine('allocation-ready', [...nested, 'container', 'exec', agent.id, 'node', '-e', ALLOCATION_HANDSHAKE, run.runId, 'observe'], { deadlineMs: 5000 }));
                    if (receipt) {
                        const sample = await observe(); requireLeafLimits(sample);
                        if (sample['memory.swap.current'].trim() !== '0' || Number(sample['memory.current']) < receipt.bytes) throw new Error('Swap appeared or held allocation was not observed alive');
                        if (jsonDigest(sample.identity) !== jsonDigest(before.identity)) throw new Error('Cgroup leaf identity changed');
                        aliveSamples.push(sample);
                        if (aliveSamples.length >= 3) {
                            const current = await inspectAgent(agent);
                            if (current.pid !== original.pid || current.startedAt !== original.startedAt) throw new Error('Memory fixture restarted');
                            const release = checkedJson(await engine('allocation-release', [...nested, 'container', 'exec', agent.id, 'node', '-e', ALLOCATION_HANDSHAKE, run.runId, 'release'], { deadlineMs: 5000 }));
                            if (!release || release.pid !== receipt.pid || release.bytes !== receipt.bytes) throw new Error('Allocation handshake identity changed');
                            released = true;
                        }
                    }
                } else {
                    try { pressureSamples.push(await observe()); } catch { break; }
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        } finally { await allocation; }
        if (!released || aliveSamples.length < 3) throw new Error('No live touched-allocation handshake evidence');
        if (pressureSamples.some(sample => jsonDigest(sample.identity) !== jsonDigest(before.identity))
            || !pressureSamples.some(sample => counter(sample['memory.events'], 'oom_kill') > counter(before['memory.events'], 'oom_kill'))) throw new Error('No same-leaf pressure OOM evidence');
        return { id: agent.id, leaf, receipt, before, aliveSamples, pressureSamples };
    }
    async function cleanup() {
        await runOwnedCleanup({ run, profile, persist, processProvider, signal: cleanupSignal });
    }
    return { cpuCase, coreCase, swapCase, cleanup, inspectBox };
}

// Every fixture agent carries memory, cpu and pids limits (inspectAgent), so
// C1 needs all three controllers from the host.
const FIXTURE_CONTROLLERS = Object.freeze(['cpu', 'memory', 'pids']);

function defaultHostIdentity() {
    return { hostname: os.hostname(), platform: process.platform, home: fs.realpathSync(os.homedir()) };
}

// The pins every live action rechecks before any process: the exact host,
// the node, candidate and engine executables, and the candidate source.
function pinProblem(run, profile, hostIdentity, remoteArrival) {
    if (run.target.ssh !== null && run.target.ssh !== undefined && !remoteArrival) return 'SSH target requires remote staging; no local fallback is permitted';
    if (profile.host.hostname !== hostIdentity.hostname || profile.host.platform !== hostIdentity.platform
        || profile.host.home !== hostIdentity.home) return 'Exact local host identity mismatch';
    for (const name of ['node', 'candidate', 'engine']) {
        const file = profile[name];
        if (fs.realpathSync(file.path) !== file.path || digest(fs.readFileSync(file.path)) !== file.digest) return `${name} executable identity changed`;
    }
    return null;
}

// Standalone cleanup resumes from the manifest alone, including after an
// interrupted provisioning that never recorded a Box or workspace receipt.
export async function executeCleanupRun({ run, persist = () => {}, processProvider, signal, remoteArrival = false, hostIdentity = defaultHostIdentity() } = {}) {
    const cases = LIVE_CASES[run.block].map(id => ({ id, result: 'blocked', reason: UNSUPPORTED[id] || 'Cleanup only' }));
    const report = { schema: 1, runId: run.runId, action: 'cleanup', verdict: 'BLOCKED', exitCode: EXIT.BLOCKED, cases, cleanup: run.cleanup, limitations: [] };
    let profile;
    try { profile = validateProfile(run, { partial: true }); } catch (error) { report.limitations.push(error.message); return report; }
    const problem = pinProblem(run, profile, hostIdentity, remoteArrival);
    if (problem) { report.limitations.push(problem); return report; }
    if (liveSourceDigest(profile.source.root) !== profile.source.digest) { report.limitations.push('Candidate source changed'); return report; }
    run.state = 'cleanup-required'; run.cleanup.state = 'running'; persist();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number.isInteger(run.deadlines?.cleanupMs) ? run.deadlines.cleanupMs : 5 * 60 * 1000);
    try {
        await runOwnedCleanup({ run, profile, persist, processProvider, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
        run.cleanup.state = 'complete'; run.state = 'complete';
    } catch (error) { run.cleanup.state = 'failed'; run.cleanup.failures.push(error.message); }
    finally { clearTimeout(timer); }
    persist();
    report.verdict = run.cleanup.state === 'complete' ? 'PASS' : 'FAIL';
    report.exitCode = EXIT[report.verdict];
    return report;
}

export async function executeLiveRun({ run, action = 'live', persist = () => {}, processProvider, signal,
    remoteArrival = false,
    hostIdentity = defaultHostIdentity(),
} = {}) {
    if (action === 'cleanup') return executeCleanupRun({ run, persist, processProvider, signal, remoteArrival, hostIdentity });
    const selected = run.target.execution?.cases || LIVE_CASES[run.block];
    const cases = LIVE_CASES[run.block].map(id => ({ id, result: 'blocked', reason: UNSUPPORTED[id] || 'Not selected or no completed enforcement evidence' }));
    const report = { schema: 1, runId: run.runId, action, verdict: 'BLOCKED', exitCode: EXIT.BLOCKED, cases, cleanup: run.cleanup, limitations: [] };
    let profile;
    try { profile = validateExecutionProfile(run); } catch (error) { report.limitations.push(error.message); return report; }
    if (run.cleanup.state !== 'not-started') { report.limitations.push('Cleanup has already started for this run; provision a new one'); return report; }
    const problem = pinProblem(run, profile, hostIdentity, remoteArrival);
    if (problem) { report.limitations.push(problem); return report; }
    if (!selected.some(id => ['LIVE-C1', 'LIVE-C2', 'LIVE-A1'].includes(id))) {
        report.limitations.push('Selected cases have no implemented live executor'); return report;
    }
    if (liveSourceDigest(profile.source.root) !== profile.source.digest) { report.limitations.push('Candidate source changed'); return report; }
    assertWorkspace(profile);
    const blockController = new AbortController();
    const cleanupController = new AbortController();
    const blockTimer = setTimeout(() => blockController.abort(), 20 * 60 * 1000);
    const blockSignal = signal ? AbortSignal.any([signal, blockController.signal]) : blockController.signal;
    const adapter = createLiveAdapter(profile, { processProvider, signal: blockSignal, cleanupSignal: cleanupController.signal, persist, run });
    let attempted = false; let activeCase = null;
    try {
        if (action !== 'cleanup') {
            run.state = 'running'; persist();
            await adapter.inspectBox(); attempted = true;
            const executors = { 'LIVE-C1': adapter.coreCase, 'LIVE-C2': adapter.cpuCase, 'LIVE-A1': adapter.swapCase };
            for (const id of selected) {
                activeCase = id;
                if (!executors[id]) continue;
                const evidence = await executors[id]();
                Object.assign(cases.find(value => value.id === id), { result: 'pass', reason: '', evidence });
            }
        }
    } catch (error) {
        const entry = cases.find(value => value.id === activeCase) || cases.find(value => value.id === selected[0]);
        if (entry) Object.assign(entry, { result: error.code === 'LIVE_PREREQUISITE_MISSING' ? 'blocked' : 'fail', reason: error.message, ...(error.evidence ? { evidence: error.evidence } : {}) });
        report.limitations.push(error.message);
    } finally {
        clearTimeout(blockTimer);
        if (attempted || action === 'cleanup') {
            run.state = 'cleanup-required'; run.cleanup.state = 'running'; persist();
            const cleanupTimer = setTimeout(() => cleanupController.abort(), 5 * 60 * 1000);
            try { await adapter.cleanup(); run.cleanup.state = 'complete'; run.state = 'complete'; }
            catch (error) { run.cleanup.state = 'failed'; run.cleanup.failures.push(error.message); }
            finally { clearTimeout(cleanupTimer); }
            persist();
        }
    }
    report.verdict = run.cleanup.state === 'failed' || cases.some(value => value.result === 'fail') ? 'FAIL'
        : action === 'cleanup' && run.cleanup.state === 'complete' ? 'PASS'
            : cases.every(value => value.result === 'pass') && run.cleanup.state === 'complete' ? 'PASS' : 'BLOCKED';
    report.exitCode = EXIT[report.verdict];
    return report;
}

export async function runLiveCommand({
    runPath, authorizationPath, action, processProvider, remoteLocal = null, expectedManifestDigest = null, portProbe, hostIdentity,
} = {}) {
    if (!LIVE_ACTIONS.includes(action)) throw new Error('Unknown live action');
    const { value: run, bytes } = readPrivateJson(runPath);
    validateRunManifest(run);
    if (!authorizationPath) throw new Error('APPROVAL REQUIRED: provide the binding record for separate execution-time approval of this exact target/action');
    const { value: authorization, bytes: authorizationBytes } = readPrivateJson(authorizationPath, 4096);
    validateAuthorization(run, bytes, authorization, action);
    if (remoteLocal !== null) {
        if (remoteLocal !== run.runId) throw new Error('Remote invocation run identity mismatch');
        if (expectedManifestDigest !== digest(bytes)) throw new Error('Remote manifest bytes do not match authorized local input');
        assertRemoteArrival(run);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort); process.once('SIGHUP', abort);
    const persist = () => writePrivateJson(runPath, run);
    try {
        const local = { persist, processProvider, signal: controller.signal, remoteArrival: remoteLocal !== null, ...(hostIdentity ? { hostIdentity } : {}) };
        const report = run.target.ssh && remoteLocal === null
            ? await stageAndDispatch({ run, bytes, authorizationBytes, action, runPath, processProvider, signal: controller.signal })
            : action === 'provision'
                ? await provisionRun({ run, ...local, validateProfile, ...(portProbe ? { portProbe } : {}) })
                : await executeLiveRun({ run, action, ...local });
        writePrivateJson(path.join(path.dirname(runPath), `report_${action}_codex.json`), report);
        return report;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); process.removeListener('SIGHUP', abort); }
}
