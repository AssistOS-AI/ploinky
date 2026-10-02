// Test-only owned-fixture execution. Unsupported acceptance cases stay BLOCKED.
// Preparing or editing a manifest is never authorization to execute it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { EXIT, validateRunManifest, writePrivateJson } from './fixtures.mjs';
import { runBoundedProcess, requireTransport } from './liveProcess.mjs';
import { dispatchRemoteRun, assertRemoteArrival } from './liveRemote.mjs';
import {
    CORE_LAYOUT, MEMBERSHIP as PROCESS_MEMBERSHIP, HELD_ALLOCATION, ALLOCATION_HANDSHAKE, LEAF_OBSERVATION, assertCoreLayout,
    preparationClaim, preparationReportArgs,
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
const ID = /^[a-f0-9]{64}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const digest = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
export const jsonDigest = value => digest(JSON.stringify(value));

function keys(value, required, label, optional = []) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
        || required.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label} fields`);
}
function absolute(value) {
    return typeof value === 'string' && value.length < 4096 && !value.includes('\0')
        && path.isAbsolute(value) && path.normalize(value) === value;
}
function bounded(value, max = 4096) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function receipt(value) {
    keys(value, ['path', 'uid', 'dev', 'ino', 'marker'], 'workspace receipt');
    if (!absolute(value.path) || !Number.isSafeInteger(value.uid) || value.uid < 0
        || !/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino) || !/^[a-f0-9]{32}$/.test(value.marker)) {
        throw new Error('Invalid workspace receipt');
    }
}
export function validateExecutionProfile(run) {
    validateRunManifest(run);
    const profile = run.target.execution;
    keys(profile, ['protocol', 'host', 'node', 'candidate', 'engine', 'source', 'workspace', 'box', 'agents', 'cases'], 'execution profile', ['fixtures']);
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
    keys(profile.source, ['root', 'digest'], 'source');
    if (!absolute(profile.source.root) || !HASH.test(profile.source.digest)
        || !profile.candidate.path.startsWith(profile.source.root + path.sep)
        || profile.workspace.path.startsWith(profile.source.root + path.sep)) throw new Error('Invalid disjoint source pin');
    receipt(profile.workspace);
    if (profile.workspace.marker !== run.runId) throw new Error('Foreign workspace marker');
    keys(profile.box, ['id', 'created', 'image', 'contractDigest', 'pathHash', 'instance'], 'Box');
    if (!ID.test(profile.box.id) || !ID.test(profile.box.image.replace(/^sha256:/, ''))
        || !HASH.test(profile.box.contractDigest) || !bounded(profile.box.created, 128)
        || !/^[a-f0-9]{12}$/.test(profile.box.pathHash) || !bounded(profile.box.instance, 128)) throw new Error('Invalid Box identity');
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
    if (profile.cases.includes('LIVE-C2') && (profile.agents.length !== 3 || roles.size !== 3)) throw new Error('C2 requires three distinct owned agents');
    if (run.ownedBoxes.length !== 1) throw new Error('Only one immutable owned Box is supported');
    keys(run.preInventory, ['containers'], 'before inventory');
    if (!Array.isArray(run.preInventory.containers) || run.preInventory.containers.length > 256
        || run.preInventory.containers.some(value => !ID.test(value.id) || !bounded(value.created, 128) || !bounded(value.image, 128))) throw new Error('Invalid before inventory');
    if (!run.ownedBoxes.some(box => box.id === profile.box.id && box.created === profile.box.created)) throw new Error('Missing Box receipt');
    if (!run.operations.some(op => op.id === 'fixture-created' && op.state === 'observed'
        && op.resourceIds?.includes(profile.box.id))) throw new Error('Missing durable fixture creation receipt');
    if (run.ownedProcesses.length || run.ownedPaths.some(entry => entry.path !== profile.workspace.path)) {
        throw new Error('This executor cannot clean extra recorded processes or paths');
    }
    return profile;
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

export function liveSourceDigest(root) {
    if (fs.realpathSync(root) !== root) throw new Error('Noncanonical candidate source');
    const rows = []; let bytes = 0;
    function walk(directory) {
        for (const name of fs.readdirSync(directory).sort()) {
            if (name === '.git') continue;
            const file = path.join(directory, name); const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) throw new Error('Live candidate must freeze symlink dependencies');
            if (stat.isDirectory()) walk(file);
            else if (stat.isFile()) {
                bytes += stat.size;
                if (rows.length >= 50000 || bytes > 512 * 1024 * 1024) throw new Error('Live source digest bound exceeded');
                rows.push(path.relative(root, file) + '\0' + digest(fs.readFileSync(file)));
            } else throw new Error('Special file in live candidate');
        }
    }
    walk(root); return digest(rows.join('\n'));
}

export function assertWorkspace(profile) {
    const value = profile.workspace;
    const stat = fs.lstatSync(value.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(value.path) !== value.path
        || stat.uid !== value.uid || String(stat.dev) !== value.dev || String(stat.ino) !== value.ino) throw new Error('Workspace ownership changed');
    const markerFd = fs.openSync(path.join(value.path, '.ploinky-hwl-owner'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const markerStat = fs.fstatSync(markerFd);
        if (!markerStat.isFile() || markerStat.nlink !== 1 || markerStat.uid !== value.uid || markerStat.size !== 32
            || fs.readFileSync(markerFd, 'utf8') !== value.marker) throw new Error('Workspace ownership marker changed');
    } finally { fs.closeSync(markerFd); }
    const identity = buildWorkspaceIdentity(value.path);
    if (identity.instance !== profile.box.instance || identity.pathHash !== profile.box.pathHash) throw new Error('Workspace instance changed');
    return identity;
}

const INSPECT = '{"id":{{json .Id}},"created":{{json .Created}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}},"conmonPid":{{json .State.ConmonPid}},"memory":{{json .HostConfig.Memory}},"memorySwap":{{json .HostConfig.MemorySwap}},"nanoCpus":{{json .HostConfig.NanoCpus}},"cpuQuota":{{json .HostConfig.CpuQuota}},"cpuPeriod":{{json .HostConfig.CpuPeriod}},"pidsLimit":{{json .HostConfig.PidsLimit}}}';
const MEMBERSHIP = 'const fs=require("node:fs");const pid=process.argv[1];if(!/^[1-9][0-9]*$/.test(pid))throw Error("Invalid PID");process.stdout.write(fs.readFileSync("/proc/"+pid+"/cgroup","utf8"));';
const OBSERVE = 'const fs=require("node:fs");const p=process.argv[1];if(fs.realpathSync(p)!==p)throw Error("Noncanonical leaf");const names=["memory.max","memory.swap.max","memory.current","memory.swap.current","memory.events","cpu.max","cpu.stat","pids.max","pids.events"];const st=fs.statSync(p);process.stdout.write(JSON.stringify({...Object.fromEntries(names.map(n=>[n,fs.readFileSync(p+"/"+n,"utf8")])),identity:{dev:String(st.dev),ino:String(st.ino)}}));';
const PRESSURE = Object.freeze({
    memory: 'const held=[];const t=setInterval(()=>held.push(Buffer.alloc(8*1024*1024,0x5a)),100);setTimeout(()=>{clearInterval(t);process.exit(0)},12000);',
    cpu: 'const end=Date.now()+5000;while(Date.now()<end){Math.sqrt(Math.random());}',
    pids: 'const {spawn}=require("node:child_process");let pending=0,errors=0;for(let i=0;i<96;i++){pending++;const c=spawn("sleep",["3"]);let done=false;const finish=()=>{if(done)return;done=true;if(--pending===0)process.stdout.write(JSON.stringify({errors})+"\\n");};c.on("error",()=>{errors++;finish();});c.on("close",finish);}',
});
function checkedJson(result) { requireTransport(result); return JSON.parse(result.stdout); }
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
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: profile.host.home, TMPDIR: process.env.TMPDIR };
    let sequence = run.operations.length;
    async function command(kind, binary, args, { deadlineMs = 30000, stress = false, cleanup = false, gate = null } = {}) {
        assertWorkspace(profile);
        if (['pressure', 'destroy-box'].includes(kind) && liveSourceDigest(profile.source.root) !== profile.source.digest) throw new Error('Candidate source changed');
        const op = { id: `live-${++sequence}`, kind, state: 'intent', resourceIds: [profile.box.id], argvDigest: jsonDigest([binary, ...args]), resultArtifact: null };
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
        const existing = await inspectBox();
        if (!/^[a-f0-9]{64}$/.test(existing.labels?.[BOX_LABELS.hardwareLimits] || '')) throw blocked('LIVE-C1 requires a provisioned gate-on Box receipt before its repeat-start checks');
        await command('repeat-gate-on-start', profile.node.path, [profile.candidate.path, 'start', fixture.ref], { gate: 'on', deadlineMs: 1200000 });
        await inspectBox();
        await command('repeat-saved-gate-start', profile.node.path, [profile.candidate.path, 'start', fixture.ref], { deadlineMs: 1200000 });
        await inspectBox();
        // The claimed enforceable controllers come from production's own root
        // preparation report, never from the CORE_LAYOUT observation below:
        // the host does not record the report it receives at start, and
        // ploinky limits status does not observe in-Box preparation. This is
        // the exact fixed command production runs; preparationClaim accepts
        // only already:true, which production reports only for a layout and
        // controller state it found settled and did not change.
        const preparation = preparationClaim((await engine('preparation-report', preparationReportArgs(profile.box.id))).stdout);
        const layout = assertCoreLayout(checkedJson(await engine('core-layout', [...core, 'node', '-e', CORE_LAYOUT])), preparation);
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
        return { preparation, layout, agents, omittedGateRetained: true };
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
        await assertEngine(true);
        // No additional owned background processes are accepted by this
        // profile. Each stress command is bounded and awaited before cleanup.
        const before = await engine('cleanup-inventory', ['container', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}'], { cleanup: true });
        const beforeIds = before.stdout.trim() ? before.stdout.trim().split(/\s+/) : [];
        if (beforeIds.some(id => !ID.test(id))) throw new Error('Unsupported cleanup inventory');
        if (beforeIds.includes(profile.box.id)) {
            await inspectBox({ cleanup: true });
            await command('destroy-box', profile.node.path, [profile.candidate.path, 'destroy', '--delete-cache'], { deadlineMs: 300000, cleanup: true });
        }
        const remaining = await engine('remaining-containers', ['container', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}'], { cleanup: true });
        const ids = remaining.stdout.trim() ? remaining.stdout.trim().split(/\s+/) : [];
        if (ids.some(id => !ID.test(id)) || ids.includes(profile.box.id)) throw new Error('Exact Box absence not proved');
        // Prove there is no replacement under the same workspace identity,
        // and compare unrelated immutable identities without altering them.
        const unrelated = [];
        for (const id of ids) {
            const value = checkedJson(await engine('remaining-mounts', ['container', 'inspect', '--format', INSPECT, id], { cleanup: true }));
            if (value.labels?.[BOX_LABELS.pathHash] === profile.box.pathHash) throw new Error('Foreign replacement Box occupies workspace');
            if (!Array.isArray(value.mounts) || value.mounts.some(m => typeof m.Source !== 'string'
                || m.Source === profile.workspace.path || m.Source.startsWith(`${profile.workspace.path}/`))) throw new Error('Workspace remains mounted or mount inventory unsupported');
            unrelated.push({ id: value.id, created: value.created, image: value.image });
        }
        const sort = values => [...values].sort((a,b) => a.id.localeCompare(b.id));
        if (jsonDigest(sort(unrelated)) !== jsonDigest(sort(run.preInventory.containers))) throw new Error('Unrelated container inventory changed; preserve evidence and do not undo it');
        assertWorkspace(profile);
        const hostRoot = path.join(profile.host.home, '.ploinky-box');
        for (const directory of ['hardware-limits', 'gpu-grants', 'router-bindings']) {
            for (const name of [profile.box.instance, profile.box.instance + '.json']) {
                const target = path.join(hostRoot, directory, name);
                try { fs.lstatSync(target); throw new Error('Candidate destruction left recorded host state; preserve workspace for cleanup: ' + directory); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
        }
        // Extra host records are rejected at validation. Candidate destruction
        // owns its record cleanup; removal of unrecorded state is never inferred.
        run.cleanup.steps.push({ id: 'destroy-box', state: 'complete', artifact: null }); persist();
        run.cleanup.steps.push({ id: 'workspace-removal', state: 'intent', artifact: null }); persist();
        // Persist callbacks may expose a scheduling/interruption boundary.
        // Revalidate after intent, quarantine by rename, then prove the inode
        // again before deleting. A substituted path is never recursively rm'd.
        assertWorkspace(profile);
        const quarantine = path.join(path.dirname(profile.workspace.path), '.hwl-removing-' + run.runId);
        try { fs.lstatSync(quarantine); throw new Error('Cleanup quarantine already exists; retain ownership evidence'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.renameSync(profile.workspace.path, quarantine);
        function assertQuarantine() {
            const st = fs.lstatSync(quarantine);
            if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(quarantine) !== quarantine
                || st.uid !== profile.workspace.uid || String(st.dev) !== profile.workspace.dev || String(st.ino) !== profile.workspace.ino) throw new Error('Cleanup quarantine identity changed');
            const fd = fs.openSync(path.join(quarantine, '.ploinky-hwl-owner'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try { const marker = fs.fstatSync(fd); if (!marker.isFile() || marker.nlink !== 1 || marker.uid !== st.uid || marker.size !== 32 || fs.readFileSync(fd, 'utf8') !== run.runId) throw new Error('Cleanup quarantine marker changed'); }
            finally { fs.closeSync(fd); }
        }
        assertQuarantine();
        run.cleanup.steps.at(-1).quarantine = quarantine; persist();
        assertQuarantine();
        fs.rmSync(quarantine, { recursive: true, force: false });
        run.cleanup.steps.at(-1).state = 'complete'; persist();
    }
    return { cpuCase, coreCase, swapCase, cleanup, inspectBox };
}

function blocked(message) { return Object.assign(new Error(message), { code: 'LIVE_PREREQUISITE_MISSING' }); }

export async function executeLiveRun({ run, action = 'live', persist = () => {}, processProvider, signal,
    remoteArrival = false,
    hostIdentity = { hostname: os.hostname(), platform: process.platform, home: fs.realpathSync(os.homedir()) },
} = {}) {
    const selected = run.target.execution?.cases || LIVE_CASES[run.block];
    const cases = LIVE_CASES[run.block].map(id => ({ id, result: 'blocked', reason: UNSUPPORTED[id] || 'Not selected or no completed enforcement evidence' }));
    const report = { schema: 1, runId: run.runId, action, verdict: 'BLOCKED', exitCode: EXIT.BLOCKED, cases, cleanup: run.cleanup, limitations: [] };
    let profile;
    try { profile = validateExecutionProfile(run); } catch (error) { report.limitations.push(error.message); return report; }
    if (run.target.ssh !== null && run.target.ssh !== undefined && !remoteArrival) {
        report.limitations.push('SSH transport is not implemented; no local fallback is permitted'); return report;
    }
    if (profile.host.hostname !== hostIdentity.hostname || profile.host.platform !== hostIdentity.platform
        || profile.host.home !== hostIdentity.home) {
        report.limitations.push('Exact local host identity mismatch'); return report;
    }
    for (const name of ['node', 'candidate', 'engine']) {
        const file = profile[name];
        if (fs.realpathSync(file.path) !== file.path || digest(fs.readFileSync(file.path)) !== file.digest) {
            report.limitations.push(`${name} executable identity changed`); return report;
        }
    }
    if (action !== 'cleanup' && !selected.some(id => ['LIVE-C1', 'LIVE-C2', 'LIVE-A1'].includes(id))) {
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
        if (entry) Object.assign(entry, { result: error.code === 'LIVE_PREREQUISITE_MISSING' ? 'blocked' : 'fail', reason: error.message });
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

export async function runLiveCommand({ runPath, authorizationPath, action, processProvider, remoteLocal = null, expectedManifestDigest = null } = {}) {
    const { value: run, bytes } = readPrivateJson(runPath);
    validateRunManifest(run);
    if (!authorizationPath) throw new Error('APPROVAL REQUIRED: provide the binding record for separate execution-time approval of this exact target/action');
    const { value: authorization } = readPrivateJson(authorizationPath, 4096);
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
        const report = run.target.ssh && remoteLocal === null
            ? await dispatchRemoteRun({ run, action, cwd: path.dirname(runPath), signal: controller.signal, manifestDigest: authorization.manifestDigest, processProvider })
            : await executeLiveRun({ run, action, persist, processProvider, signal: controller.signal, remoteArrival: remoteLocal !== null });
        writePrivateJson(path.join(path.dirname(runPath), `report_${action}_codex.json`), report);
        return report;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); process.removeListener('SIGHUP', abort); }
}
