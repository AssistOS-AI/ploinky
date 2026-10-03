// Offline tests of the apparatus-mps executors (LIVE-P1 to LIVE-P4): the GPU
// idle gate, the probe protocol, provisioning with the GPU grant, the four
// cases with their pass and failure or BLOCKED paths, cleanup of the grant and
// policy records, and the evidence bounds. Every engine, nvidia-smi, MPS
// daemon, host process table and CUDA probe is the in-memory fake of
// tests/hardware-limits/fakeLiveGpu.mjs over the file-backed fake engine world:
// nothing here starts a container, opens SSH, uses a GPU or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writePrivateJson } from '../hardware-limits/fixtures.mjs';
import { failureEvidenceNames } from '../hardware-limits/liveCommon.mjs';
import { judgeArtifacts, requiredArtifacts } from '../hardware-limits/liveStage.mjs';
import { executeCleanupRun, executeLiveRun, liveSourceDigest, validateExecutionProfile, validateProfile } from '../hardware-limits/liveHarness.mjs';
import { provisionRun } from '../hardware-limits/liveFixture.mjs';
import { candidateArgvProblem, candidateOperationsOf, isCandidateArgv } from '../hardware-limits/candidateArgv.mjs';
import { buildConcreteManifest, renderSummary, summaryPathFor } from '../hardware-limits/liveManifest.mjs';
import { writeUstar } from '../hardware-limits/liveStage.mjs';
import { engineIdentityDigest, hostRecordPaths } from '../hardware-limits/liveCommon.mjs';
import { fakeEngineInfo, ok, worldState } from '../hardware-limits/fakeLiveEngine.mjs';
import { createGpuWorld } from '../hardware-limits/fakeLiveGpu.mjs';
import { createGpuGate, gpuQueryArgv, isToleratedRecord } from '../hardware-limits/liveGpuGate.mjs';
import { parseGpuInventory, parseGpuMemory } from '../hardware-limits/liveGpu.mjs';
import { createHostProc } from '../hardware-limits/liveGpuHost.mjs';
import { createGpuCases, compactEvidence } from '../hardware-limits/liveGpuCases.mjs';
import {
    ADMIN_REQUEST, GPU_GRANT_FACTS, MPS_FAILURE_EVIDENCE, MPS_KILL_OWNED_DAEMON, MPS_OBSERVE, assertMpsControlCommand, classifyMpsReply, controlHelperExecArgv, controlHelperRunArgv, parseProbeResult, probeBoundMiB, probeExecArgv,
} from '../hardware-limits/liveGpuCommands.mjs';

const REPO = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const hash = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const ENGINE_HOST = { arch: 'test', os: 'linux', hostname: 'fake-engine', id: 'engine-1' };
const IMAGE = `docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}`;
const BOX_IMAGE = `docker.io/assistos/ploinky-box@sha256:${'b'.repeat(64)}`;
const UNRELATED = [{ id: 'e'.repeat(64), created: '2026-09-01T00:00:00Z', image: 'f'.repeat(64), labels: {}, mounts: [{ Source: '/elsewhere' }] }];
const GPU_UUID = 'GPU-905b8484-3b1e-30f6-defd-05d44f00f692';
const free = async () => ({ tcp: true, udp: true });
const exists = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const FAST = { sampleMs: 1, settleMs: 1, settleSamples: 2, monitorMs: 4, afterApplyMs: 0, serverWaitMs: 2000, controlMs: 20000 };

function scratch(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-gpu-')));
    t.after(() => {
        const open = target => { const stat = fs.lstatSync(target); if (!stat.isDirectory()) return; fs.chmodSync(target, 0o700); for (const name of fs.readdirSync(target)) open(path.join(target, name)); };
        if (exists(root)) { open(root); fs.rmSync(root, { recursive: true, force: true }); }
    });
    return root;
}

// One fake apparatus: a candidate source holding the real CUDA probe file, pinned
// NVIDIA tools, a staged remote root and the concrete apparatus-mps manifest
// built by the real builder.
function gpuWorld(t, { faults = {}, suffix = 'claude', existingGrantDirectory = true, gpuOverrides = {} } = {}) {
    const root = scratch(t);
    const directory = name => { const target = path.join(root, name); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); return target; };
    const home = directory('home');
    const source = directory('source');
    fs.mkdirSync(path.join(source, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// fixture candidate\n');
    fs.mkdirSync(path.join(source, 'tests', 'hardware-limits'), { recursive: true });
    fs.writeFileSync(path.join(source, 'tests', 'hardware-limits', 'verify.mjs'), '// fixture runner\n');
    const probeBytes = fs.readFileSync(path.join(REPO, 'tests', 'hardware-limits', 'mpsprobe.py'));
    fs.writeFileSync(path.join(source, 'tests', 'hardware-limits', 'mpsprobe.py'), probeBytes);
    const bin = directory('bin');
    const engine = path.join(bin, 'podman'); fs.writeFileSync(engine, 'fake engine\n');
    const ssh = path.join(bin, 'ssh'); fs.writeFileSync(ssh, 'fake ssh\n');
    const tools = Object.fromEntries(['nvidia-smi', 'nvidia-cuda-mps-control', 'nvidia-cuda-mps-server'].map(name => { const file = path.join(bin, name); fs.writeFileSync(file, `fake ${name}\n`); return [name, file]; }));
    const knownHosts = path.join(root, 'known_hosts'); fs.writeFileSync(knownHosts, '192.168.1.63 ssh-ed25519 AAAAfixture\n');
    const evidence = directory('evidence');
    const node = fs.realpathSync(process.execPath);
    if (existingGrantDirectory) fs.mkdirSync(path.join(home, '.ploinky-box', 'gpu-grants'), { recursive: true, mode: 0o700 });
    const hostIdentity = { hostname: 'apparatus', platform: 'linux', home };
    const gpu = { uuid: GPU_UUID, name: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '595.91.07', memoryMiB: 6144, smCount: 30, smi: tools['nvidia-smi'], mpsControl: tools['nvidia-cuda-mps-control'], mpsServer: tools['nvidia-cuda-mps-server'], ...gpuOverrides };
    const pins = {
        schema: 1, host: hostIdentity, node: { path: node, digest: hash(fs.readFileSync(node)) },
        engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: engineIdentityDigest(fakeEngineInfo(ENGINE_HOST)) }, boxImage: BOX_IMAGE,
        ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '100.76.22.69', hostKeyAlias: '192.168.1.63', user: 'skutner', knownHosts, identityFile: null },
        gpu: {
            uuid: gpu.uuid, name: gpu.name, driverVersion: gpu.driverVersion, memoryMiB: gpu.memoryMiB, expectedSmCount: 30,
            smi: { path: gpu.smi, digest: hash(fs.readFileSync(gpu.smi)) }, mpsControl: { path: gpu.mpsControl, digest: hash(fs.readFileSync(gpu.mpsControl)) }, mpsServer: { path: gpu.mpsServer, digest: hash(fs.readFileSync(gpu.mpsServer)) },
        },
    };
    const runId = crypto.randomBytes(16).toString('hex');
    const candidate = { root: source, digest: liveSourceDigest(source), revision: 'c'.repeat(40) };
    const payloadPath = path.join(evidence, `candidate-${runId}.tar`);
    candidate.payload = { path: payloadPath, ...writeUstar(source, payloadPath) };
    const run = buildConcreteManifest({
        block: 'apparatus-mps', runId, configDigest: hash('config'), casesDigest: hash('cases'), documentSuffix: suffix, pins, candidate, image: IMAGE,
        ports: { tcp: 23456, udp: 34567 }, unsupported: {},
    });
    const remoteRoot = run.target.stage.root;
    fs.mkdirSync(remoteRoot, { recursive: true }); fs.chmodSync(remoteRoot, 0o700);
    fs.writeFileSync(path.join(remoteRoot, '.ploinky-hwl-owner'), runId, { mode: 0o600 });
    fs.cpSync(source, path.join(remoteRoot, 'source'), { recursive: true });
    const runPath = path.join(evidence, `run_${suffix}.json`);
    writePrivateJson(runPath, run);
    const statePath = path.join(root, 'world_claude.json');
    const fake = createGpuWorld({ statePath, node, engine, host: ENGINE_HOST, gpu, faults, unrelated: UNRELATED });
    const artifacts = new Map();
    const persist = () => writePrivateJson(runPath, run);
    const w = { root, home, source, evidence, engine, node, pins, run, runId, runPath, statePath, remoteRoot, hostIdentity, gpu, fake, artifacts, persist, probeBytes };
    w.provision = (options = {}) => provisionRun({
        run: w.run, persist, processProvider: fake.provider, portProbe: free, hostIdentity, remoteArrival: true, validateProfile, hostProc: fake.hostProc,
        artifacts: (name, value) => artifacts.set(name, structuredClone(value)), ...options,
    });
    w.live = (options = {}) => executeLiveRun({
        run: w.run, persist, processProvider: fake.provider, hostIdentity, remoteArrival: true, hostProc: fake.hostProc, gpuTimings: { ...FAST, ...(options.timings || {}) },
        artifacts: (name, value) => artifacts.set(name, structuredClone(value)), ...options,
    });
    w.cleanup = (options = {}) => executeCleanupRun({
        run: w.run, persist, processProvider: fake.provider, hostIdentity, remoteArrival: true, hostProc: fake.hostProc,
        artifacts: (name, value) => artifacts.set(name, structuredClone(value)), ...options,
    });
    w.faults = faults;
    return w;
}
async function provisioned(t, options) {
    const w = gpuWorld(t, options);
    const report = await w.provision();
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    return w;
}
const caseOf = (report, id) => report.cases.find(entry => entry.id === id);
// Run the selected cases on a provisioned world and return the report.
async function liveCases(w, ids, options = {}) {
    w.run.target.execution.cases = ids;
    return w.live(options);
}

// --- nvidia-smi XML and the gate ---------------------------------------------------------
const UUID = 'GPU-01234567-1234';
const row = (pid, type = 'C') => `<process_info><gpu_instance>N/A</gpu_instance><compute_instance>N/A</compute_instance><pid>${pid}</pid><type>${type}</type><process_name>x</process_name><used_memory>12 MiB</used_memory></process_info>`;
const smiXml = ({ rows = '', uuid = UUID, mode = 'Default', total = 6144, used = 13 } = {}) => `<?xml version="1.0" ?>\n<!DOCTYPE nvidia_smi_log SYSTEM "nvsmi_device_v12.dtd">\n<nvidia_smi_log><gpu id="00000000:01:00.0"><uuid>${uuid}</uuid><compute_mode>${mode}</compute_mode><fb_memory_usage><total>${total} MiB</total><reserved>201 MiB</reserved><used>${used} MiB</used><free>${total - used} MiB</free></fb_memory_usage><bar1_memory_usage><total>256 MiB</total><used>1 MiB</used><free>255 MiB</free></bar1_memory_usage><processes>${rows}</processes></gpu></nvidia_smi_log>\n`;
// A stand-alone gate over a scripted nvidia-smi and a scripted host process table.
function scriptedGate({ replies, procs = new Map(), prefix = '/box', expectedMemoryMiB = 6144 }) {
    let call = 0;
    const host = {
        bootId: () => 'boot-1',
        observe: pid => (procs.has(pid) ? { bootId: 'boot-1', hostPid: pid, ...procs.get(pid) } : null),
    };
    const query = async () => { const reply = replies[Math.min(call, replies.length - 1)]; call += 1; return typeof reply === 'function' ? reply() : reply; };
    const gate = createGpuGate({ query, uuid: UUID, host, boxPrefix: prefix, expectedMemoryMiB, intervalMs: 3 });
    return { gate, procs, calls: () => call };
}
const smiOk = xml => ok(xml);
const proc = (cgroup, extra = {}) => ({ startIdentity: '10', ppid: 1, cgroup, nspid: [1], uid: { real: 1000, effective: 1000, saved: 1000, fs: 1000 }, ...extra });
const blockedWith = (reason) => error => error.code === 'LIVE_PREREQUISITE_MISSING' && error.gate?.reason === reason;

test('G1.gate-initial-idle-records-uuid-mode-and-memory', async () => {
    const { gate } = scriptedGate({ replies: [smiOk(smiXml())] });
    const baseline = await gate.initial();
    assert.equal(baseline.uuid, UUID); assert.equal(baseline.computeMode, 'Default');
    assert.deepEqual(baseline.memory, { totalMiB: 6144, usedMiB: 13, freeMiB: 6131 });
    assert.equal(gate.baseline, baseline);
});

test('G1.gate-initial-blocks-on-a-query-error-malformed-unsupported-wrong-device-mode-memory-or-any-process', async () => {
    const cases = [
        ['query exits nonzero', ok('', { status: 9, stderr: 'NVIDIA-SMI has failed' }), 'query_error'],
        ['query times out', ok('', { status: null, timedOut: true }), 'query_error'],
        ['truncated XML', smiOk(smiXml().slice(0, 200)), 'unsupported_output'],
        ['not XML at all', smiOk('Failed to initialize NVML: Driver/library version mismatch\n'), 'unsupported_output'],
        ['custom entity', smiOk(smiXml().replace('<nvidia_smi_log>', '<!ENTITY x "y"><nvidia_smi_log>')), 'unsupported_output'],
        ['stray ampersand', smiOk(smiXml({ rows: row(5).replace('x', 'a & b') })), 'unsupported_output'],
        ['two devices', smiOk(smiXml().replace('</nvidia_smi_log>', '<gpu id="2"></gpu></nvidia_smi_log>')), 'unsupported_output'],
        ['another device', smiOk(smiXml({ uuid: 'GPU-87654321-4321' })), 'device_or_mode_mismatch'],
        ['Exclusive_Process mode', smiOk(smiXml({ mode: 'Exclusive_Process' })), 'device_or_mode_mismatch'],
        ['process inventory N/A', smiOk(smiXml({ rows: 'N/A' })), 'activity_unknown'],
        ['process inventory Not Supported', smiOk(smiXml({ rows: 'Not Supported' })), 'activity_unknown'],
        ['unknown activity grammar', smiOk(smiXml({ rows: '<mystery/>' })), 'activity_unknown'],
        ['no processes element', smiOk(smiXml().replace(/<processes>[\s\S]*<\/processes>/, '')), 'activity_unknown'],
        ['process with a non-numeric PID', smiOk(smiXml({ rows: row('N/A') })), 'unsupported_output'],
        ['process of an unknown type', smiOk(smiXml({ rows: row(7, 'X') })), 'unsupported_output'],
        ['memory element missing', smiOk(smiXml().replace(/<fb_memory_usage>[\s\S]*<\/fb_memory_usage>/, '')), 'unsupported_output'],
        ['memory in another unit', smiOk(smiXml().replace('<total>6144 MiB</total>', '<total>6 GiB</total>')), 'unsupported_output'],
        ['a different total memory', smiOk(smiXml({ total: 8192 })), 'unexpected_device_memory'],
        ['a compute process', smiOk(smiXml({ rows: row(123) })), 'gpu_busy'],
        ['a graphics process', smiOk(smiXml({ rows: row(123, 'G') })), 'gpu_busy'],
        ['an MPS server nobody registered', smiOk(smiXml({ rows: row(123, 'M+C') })), 'gpu_busy'],
    ];
    for (const [label, reply, reason] of cases) {
        const { gate } = scriptedGate({ replies: [reply] });
        await assert.rejects(gate.initial(), blockedWith(reason), `${label} must be blocked as ${reason}`);
        assert.equal(gate.baseline, null, label);
    }
});

test('G1.gate-foreign-process-blocks-and-is-named', async () => {
    const { gate, procs } = scriptedGate({ replies: [smiOk(smiXml()), smiOk(smiXml({ rows: row(123) })), smiOk(smiXml({ rows: `${row(123)}${row(124, 'G')}` }))] });
    await gate.initial();
    procs.set(123, proc('/elsewhere'));
    await assert.rejects(gate.check('op'), error => blockedWith('gpu_busy')(error) && JSON.stringify(error.gate.foreign) === '[123]');
    await assert.rejects(gate.check('op2'), error => blockedWith('gpu_busy')(error) && JSON.stringify(error.gate.foreign) === '[123,124]');
    // A foreign process that merely lives in the Box's own cgroup tree is still not registered.
    const inBox = scriptedGate({ replies: [smiOk(smiXml({ rows: row(500) }))], procs: new Map([[500, proc('/box/ploinky/core', { ppid: 1 })]]) });
    await assert.rejects(inBox.gate.check('op'), blockedWith('gpu_busy'));
});

test('G1.gate-owned-mps-processes-are-excluded-only-with-full-provenance', async () => {
    const procs = new Map([
        [900, proc('/box/ploinky/core', { startIdentity: '90' })], // the registered daemon
        [901, proc('/box/ploinky/core', { startIdentity: '91', ppid: 900 })], // its server
        [950, proc('/box/ploinky/agents/libpod-a', { startIdentity: '95', ppid: 3 })], // a client inside a registered owned leaf
    ]);
    const server = smiOk(smiXml({ rows: row(901, 'M+C') }));
    const both = smiOk(smiXml({ rows: `${row(901, 'M+C')}${row(950, 'C')}` }));
    const mixed = smiOk(smiXml({ rows: `${row(901, 'M+C')}${row(777)}` }));
    const { gate } = scriptedGate({ replies: [smiOk(smiXml()), server, both, mixed], procs });
    await gate.initial();
    gate.registerDaemon(900); gate.registerLeaf('/box/ploinky/agents/libpod-a');
    const first = await gate.check('server'); assert.deepEqual(first.owned, [901]);
    const second = await gate.check('server and client'); assert.deepEqual(second.owned.sort(), [901, 950]);
    // An owned PID next to a foreign one still blocks, naming only the foreign one.
    procs.set(777, proc('/elsewhere'));
    await assert.rejects(gate.check('mixed'), error => blockedWith('gpu_busy')(error) && JSON.stringify(error.gate.foreign) === '[777]');
});

test('G1.gate-an-owned-pid-without-its-provenance-tuple-blocks', async () => {
    const base = () => new Map([[900, proc('/box/ploinky/core', { startIdentity: '90' })], [901, proc('/box/ploinky/core', { startIdentity: '91', ppid: 900 })]]);
    const listed = smiOk(smiXml({ rows: row(901, 'M+C') }));
    const cases = [
        ['the server is the child of an unregistered process', procs => { procs.set(901, proc('/box/ploinky/core', { startIdentity: '91', ppid: 800 })); procs.set(800, proc('/box/ploinky/core')); }, 'gpu_busy'],
        ['the daemon PID was reused (another start time)', procs => { procs.set(900, proc('/box/ploinky/core', { startIdentity: '999' })); }, 'gpu_busy'],
        ['the server is outside the exact Box cgroup', procs => { procs.set(901, proc('/other-box/ploinky/core', { startIdentity: '91', ppid: 900 })); }, 'gpu_busy'],
        ['the server is beneath the Box but not in /ploinky/core', procs => { procs.set(901, proc('/box/ploinky/agents/libpod-z', { startIdentity: '91', ppid: 900 })); }, 'gpu_busy'],
        ['the server is gone from /proc', procs => { procs.delete(901); }, 'gpu_busy'],
    ];
    for (const [label, mutate, reason] of cases) {
        const procs = base();
        const { gate } = scriptedGate({ replies: [smiOk(smiXml()), listed], procs });
        await gate.initial(); gate.registerDaemon(900);
        mutate(procs);
        await assert.rejects(gate.check('op'), blockedWith(reason), label);
    }
    // A registered record whose tuple changed (reused PID) blocks even though the PID is registered.
    const procs = base();
    const { gate } = scriptedGate({ replies: [smiOk(smiXml()), listed, listed], procs });
    await gate.initial(); gate.registerDaemon(900);
    await gate.check('discover the server');
    procs.set(901, proc('/box/ploinky/core', { startIdentity: '4242', ppid: 900 }));
    await assert.rejects(gate.check('reused'), blockedWith('owned_provenance_unproved'));
    // Registration itself needs the cgroup ancestry.
    assert.throws(() => scriptedGate({ replies: [], procs: new Map([[5, proc('/elsewhere')]]) }).gate.registerDaemon(5), blockedWith('owned_provenance_unproved'));
    assert.throws(() => scriptedGate({ replies: [], procs: new Map() }).gate.registerServer(5), blockedWith('owned_provenance_unproved'));
    assert.throws(() => scriptedGate({ replies: [] }).gate.registerLeaf('/box'), /beneath the exact Box/);
});

test('G1.gate-a-listed-process-that-vanished-is-re-queried-not-blamed', async () => {
    const procs = new Map([[900, proc('/box/ploinky/core', { startIdentity: '90' })], [901, proc('/box/ploinky/core', { startIdentity: '91', ppid: 900 })]]);
    const listed = smiOk(smiXml({ rows: row(901, 'M+C') }));
    // The MPS server leaves between the inventory and the host lookup: the next inventory is empty and the gate passes.
    const { gate } = scriptedGate({ replies: [smiOk(smiXml()), listed, listed, smiOk(smiXml())], procs });
    await gate.initial(); gate.registerDaemon(900);
    await gate.check('server listed');
    procs.delete(901);
    const calm = await gate.check('server gone before the lookup');
    assert.deepEqual(calm.owned, []);
    // A listed PID that stays listed but is not on the host at all is judged, after the bounded re-reads.
    const ghost = scriptedGate({ replies: [smiOk(smiXml()), smiOk(smiXml({ rows: row(4242) }))], procs: new Map() });
    await ghost.gate.initial();
    await assert.rejects(ghost.gate.check('ghost'), blockedWith('gpu_busy'));
    assert.equal(ghost.calls(), 5, 'one initial query, then the check and three re-reads');
});

test('G1.gate-free-memory-and-real-nvidia-smi-grammar', async () => {
    const real = smiXml({ rows: row(901, 'M+C').replace('>x<', '>nvidia-cuda-mps-server &amp; co<') });
    assert.deepEqual(parseGpuInventory(smiOk(real), UUID).processes, [{ pid: 901, type: 'M+C' }]);
    assert.deepEqual(parseGpuMemory(smiOk(real)), { totalMiB: 6144, usedMiB: 13, freeMiB: 6131 });
    assert.throws(() => parseGpuMemory(smiOk(smiXml().replace('<used>13 MiB</used>', '<used>9999999 MiB</used>'))), /Inconsistent GPU memory/);
    const { gate } = scriptedGate({ replies: [smiOk(smiXml()), smiOk(smiXml({ used: 5800 }))] });
    await gate.initial();
    await assert.rejects(gate.check('probe', { minFreeMiB: 2048 }), blockedWith('insufficient_free_memory'));
});

test('G1.gate-a-foreign-process-appearing-mid-probe-aborts-the-probe-and-trips-the-gate', async () => {
    let busy = false;
    const replies = [smiOk(smiXml()), () => smiOk(smiXml({ rows: busy ? row(321) : '' }))];
    const { gate, procs } = scriptedGate({ replies });
    procs.set(321, proc('/elsewhere'));
    await gate.initial();
    let aborted = false; let started = 0;
    const task = signal => new Promise(resolve => {
        started += 1; setTimeout(() => { busy = true; }, 10);
        signal.addEventListener('abort', () => { aborted = true; resolve('aborted'); });
        setTimeout(() => resolve('finished'), 2000);
    });
    await assert.rejects(gate.monitor(task, { every: 3 }), blockedWith('foreign_process_appeared'));
    assert.equal(aborted, true, 'the probe command was aborted'); assert.equal(started, 1);
    assert.ok(gate.tripped, 'the gate is tripped');
    // No new work: every later check fails at once, without a query.
    const before = gate.history.length;
    await assert.rejects(gate.check('after'), blockedWith('foreign_process_appeared'));
    assert.equal(gate.history.length, before);
    // A task that finishes with the GPU idle returns its value.
    const calm = scriptedGate({ replies: [smiOk(smiXml())] });
    await calm.gate.initial();
    assert.equal(await calm.gate.monitor(() => new Promise(resolve => setTimeout(() => resolve('done'), 15)), { every: 3 }), 'done');
});

test('G1.gate-only-reads-nvidia-smi-and-never-signals', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1']);
    assert.equal(caseOf(report, 'LIVE-P1').result, 'pass', JSON.stringify(caseOf(report, 'LIVE-P1')));
    const smi = w.fake.model.calls.filter(call => call.binary === w.gpu.smi);
    assert.ok(smi.length >= 3, 'the gate queried before the GPU operations');
    for (const call of smi) assert.deepEqual(call.args, gpuQueryArgv(GPU_UUID), 'every nvidia-smi call is the read-only XML query');
    assert.equal(w.fake.model.signals.length, 0, 'P1 signals nothing');
    for (const file of ['liveGpuGate.mjs', 'liveGpuHost.mjs']) {
        const source = fs.readFileSync(path.join(REPO, 'tests', 'hardware-limits', file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
        assert.equal(/process\.kill|\.kill\(|-c EXCLUSIVE|compute-mode|--compute/.test(source), false, `${file} neither signals nor sets a compute mode`);
    }
});

// --- Probe protocol -------------------------------------------------------------------------
const probeResult = (report, status = 0, extra = {}) => ok(`${JSON.stringify(report)}\n`, { status, ...extra });
const complete = (over = {}) => ({ ok: true, status: 'complete', termination: 'allocation_oom', driverApiVersion: 13010, containerPid: 7, containerUid: 1000, smCount: 6, allocatedMiB: 896, boundMiB: 1408, memGetInfo: { freeBytes: 5000000000, totalBytes: 6442450944 }, mpsEnv: {}, ...over });

test('G1.probe-protocol-parses-complete-allocation-oom-and-bound-reports', () => {
    assert.equal(parseProbeResult(probeResult(complete()), { maxMiB: 1408 }).allocatedMiB, 896);
    assert.equal(parseProbeResult(probeResult(complete({ termination: 'bound', allocatedMiB: 1408 })), { maxMiB: 1408 }).termination, 'bound');
    assert.equal(parseProbeResult(probeResult(complete({ allocatedMiB: 0 })), { maxMiB: 1408 }).allocatedMiB, 0);
    assert.equal(probeBoundMiB(1044), 1408); assert.equal(probeBoundMiB(1024), 1280); assert.equal(probeBoundMiB(512), 768);
});

test('G1.probe-protocol-distinguishes-allocation-oom-from-initialization-and-protocol-errors', () => {
    // An expected allocation failure is a complete report, never an error.
    assert.doesNotThrow(() => parseProbeResult(probeResult(complete()), { maxMiB: 1408 }));
    // An initialization or protocol failure is a failure with the probe's own step.
    assert.throws(() => parseProbeResult(probeResult({ ok: false, status: 'failed', step: 'cuInit', error: 'CUDA_ERROR_NO_DEVICE' }, 2), { maxMiB: 1408 }), error => /CUDA probe failed at cuInit: CUDA_ERROR_NO_DEVICE/.test(error.message) && error.code !== 'LIVE_PREREQUISITE_MISSING');
    assert.throws(() => parseProbeResult(probeResult({ ok: false, status: 'failed', step: 'cuMemAlloc', error: 'CUDA_ERROR_ILLEGAL_ADDRESS' }, 2), { maxMiB: 1408 }), /cuMemAlloc: CUDA_ERROR_ILLEGAL_ADDRESS/);
    assert.throws(() => parseProbeResult(probeResult({ ok: false, status: 'failed', step: 'deadline', error: 'probe exceeded 30 seconds' }, 2), { maxMiB: 1408 }), /deadline/);
    // An unsupported driver call, or a missing driver library, is a prerequisite.
    assert.throws(() => parseProbeResult(probeResult({ ok: false, status: 'blocked', step: 'cuCtxGetExecAffinity', error: 'driver symbol unavailable' }, 3), { maxMiB: 1408 }), error => error.code === 'LIVE_PREREQUISITE_MISSING');
    assert.throws(() => parseProbeResult(probeResult({ ok: false, status: 'failed', step: 'python', error: 'OSError: libcuda.so.1: cannot open shared object file' }, 2), { maxMiB: 1408 }), error => error.code === 'LIVE_PREREQUISITE_MISSING');
    // Transport and report faults are never a pass.
    for (const [label, result] of [['timeout', ok('', { timedOut: true, status: null })], ['truncated', probeResult(complete(), 0, { truncated: true })], ['signal', probeResult(complete(), 0, { signal: 'SIGKILL' })], ['cancelled', probeResult(complete(), 0, { cancelled: true })], ['invalid JSON', ok('not json\n')], ['empty', ok('')]]) {
        assert.throws(() => parseProbeResult(result, { maxMiB: 1408 }), label);
    }
    // The probe never started (python3 or the staged file missing from the image): a prerequisite, with the engine's words.
    for (const [status, stderr] of [[127, 'Error: crun: executable file `python3` not found in $PATH: No such file or directory'], [126, 'OCI permission denied'], [2, "python3: can't open file '/code/mpsprobe.py': [Errno 2] No such file or directory"]]) {
        assert.throws(() => parseProbeResult(ok('', { status, stderr }), { maxMiB: 1408 }), error => error.code === 'LIVE_PREREQUISITE_MISSING' && /cannot start in the fixture image/.test(error.message), String(status));
    }
    assert.throws(() => parseProbeResult(probeResult(complete({ termination: 'bound', allocatedMiB: 1024 })), { maxMiB: 1408 }), /below its bound/);
    assert.throws(() => parseProbeResult(probeResult(complete({ boundMiB: 1280 })), { maxMiB: 1408 }));
    assert.throws(() => parseProbeResult(probeResult(complete({ containerUid: 0 })), { maxMiB: 1408 }));
    assert.throws(() => parseProbeResult(probeResult(complete({ cleanupErrors: ['cuMemFree:1'] })), { maxMiB: 1408 }));
    assert.throws(() => parseProbeResult(probeResult(complete({ allocatedMiB: 2048 })), { maxMiB: 1408 }));
});

test('G1.programs-and-argument-builders-take-only-validated-words', () => {
    for (const program of [ADMIN_REQUEST, GPU_GRANT_FACTS, MPS_OBSERVE, MPS_KILL_OWNED_DAEMON]) assert.doesNotThrow(() => new vm.Script(`(async()=>{${program}})`));
    const id = 'a'.repeat(64);
    assert.deepEqual(probeExecArgv({ containerId: id, maxMiB: 1408 }), ['container', 'exec', id, 'python3', '/code/mpsprobe.py', '--max-mib', '1408']);
    assert.deepEqual(probeExecArgv({ containerId: id, maxMiB: 768, set: { CUDA_MPS_PINNED_DEVICE_MEM_LIMIT: '0=512M' } }).slice(0, 4), ['container', 'exec', '--env', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=512M']);
    assert.deepEqual(probeExecArgv({ containerId: id, maxMiB: 1408, unset: ['CUDA_MPS_PIPE_DIRECTORY'] }).slice(2, 7), [id, 'env', '-u', 'CUDA_MPS_PIPE_DIRECTORY', 'python3']);
    for (const bad of [{ containerId: 'x', maxMiB: 1408 }, { containerId: id, maxMiB: 100 }, { containerId: id, maxMiB: 9000 }, { containerId: id, maxMiB: 1409 },
        { containerId: id, maxMiB: 1408, set: { PATH: '/x' } }, { containerId: id, maxMiB: 1408, set: { CUDA_MPS_PIPE_DIRECTORY: 'a b' } }, { containerId: id, maxMiB: 1408, unset: ['HOME'] }]) {
        assert.throws(() => probeExecArgv(bad), JSON.stringify(bad));
    }
    for (const good of ['get_server_list', 'get_default_active_thread_percentage', 'get_default_device_pinned_mem_limit 0', 'set_active_thread_percentage 123 100', 'set_device_pinned_mem_limit 123 0 64M']) assert.equal(assertMpsControlCommand(good), good);
    for (const bad of ['quit', 'start_server -uid 1000', 'get_server_list; id', 'set_default_active_thread_percentage 25', 'set_active_thread_percentage 1 1000', 'get_server_list\nquit', '']) assert.throws(() => assertMpsControlCommand(bad), bad);
    const run = controlHelperRunArgv({ name: `hwl-${'a'.repeat(12)}-ctl-rw`, image: IMAGE, pipeDirectory: `/run/ploinky/mps/pipe-${'b'.repeat(32)}`, writable: true, runId: 'c'.repeat(32) });
    assert.ok(run.includes('--userns=keep-id:uid=1000,gid=1000') && run.includes('--volume') && run.includes('/usr/local/nvidia/bin/nvidia-cuda-mps-control:/x:ro') && run.includes('--cgroup-parent=/ploinky/system'));
    assert.ok(run.some(word => word.endsWith(':z,rw')) && !run.some(word => word.endsWith(':z,ro')));
    assert.ok(controlHelperRunArgv({ name: `hwl-${'a'.repeat(12)}-ctl-ro`, image: IMAGE, pipeDirectory: `/run/ploinky/mps/pipe-${'b'.repeat(32)}`, writable: false, runId: 'c'.repeat(32) }).some(word => word.endsWith(':z,ro')));
    assert.throws(() => controlHelperRunArgv({ name: 'evil', image: IMAGE, pipeDirectory: '/etc', writable: true, runId: 'c'.repeat(32) }));
    assert.deepEqual(controlHelperExecArgv({ containerId: id, command: 'get_server_list' }).slice(-5), ['sh', '-c', 'printf "%s\\n" "$1" | /x', 'sh', 'get_server_list']);
    assert.deepEqual([classifyMpsReply('1044M\n'), classifyMpsReply('25\n'), classifyMpsReply('1044 MiB'), classifyMpsReply('')].map(value => value.form), ['integer-with-M-or-G', 'integer-percentage', 'other', 'empty']);
});

test('G1.evidence-is-bounded-for-the-report-and-keeps-the-verdict', () => {
    const huge = { caseId: 'LIVE-P2', result: 'pass', steps: Array.from({ length: 400 }, (_, index) => ({ name: `step-${index}`, value: { text: 'x'.repeat(5000) } })) };
    const bounded = compactEvidence(huge, 150000);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 150000);
    assert.equal(bounded.caseId, 'LIVE-P2');
    const impossible = compactEvidence({ caseId: 'LIVE-P3', failure: { message: 'boom' }, blob: 'y'.repeat(5_000_000) }, 100);
    assert.equal(impossible.truncated, true); assert.equal(impossible.failure.message, 'boom');
    const small = { caseId: 'LIVE-P1', steps: [] };
    assert.equal(compactEvidence(small), small);
});

// A host process observer over a scripted /proc.
test('G1.host-observer-reads-the-tuple-and-refuses-unsupported-grammar', t => {
    const root = scratch(t);
    const proc = path.join(root, 'proc'); const cg = path.join(root, 'cg');
    fs.mkdirSync(path.join(proc, 'sys', 'kernel', 'random'), { recursive: true });
    fs.writeFileSync(path.join(proc, 'sys', 'kernel', 'random', 'boot_id'), '11111111-2222-4333-8444-555555555555\n');
    fs.mkdirSync(path.join(proc, '77'));
    fs.writeFileSync(path.join(proc, '77', 'stat'), '77 (node (x)) S 5 77 77 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 987654 1000 100 18446744073709551615');
    fs.writeFileSync(path.join(proc, '77', 'status'), 'Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nNSpid:\t77\t12\n');
    fs.writeFileSync(path.join(proc, '77', 'cgroup'), '0::/a/b\n');
    fs.mkdirSync(path.join(cg, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(cg, 'a', 'b', 'cgroup.procs'), '77\n');
    const host = createHostProc({ procRoot: proc, cgroupRoot: cg });
    assert.deepEqual(host.observe(77), { bootId: '11111111-2222-4333-8444-555555555555', hostPid: 77, startIdentity: '987654', ppid: 5, cgroup: '/a/b', nspid: [77, 12], uid: { real: 1000, effective: 1000, saved: 1000, fs: 1000 } });
    assert.equal(host.observe(78), null);
    assert.deepEqual(host.cgroupProcs('/a/b'), [77]); assert.equal(host.cgroupProcs('/a/c'), null);
    fs.writeFileSync(path.join(proc, '77', 'cgroup'), '1:name=systemd:/x\n0::/a\n');
    assert.equal(host.observe(77).cgroup, null, 'a hybrid hierarchy proves no unified cgroup');
    fs.writeFileSync(path.join(proc, '77', 'status'), 'Name:\tnode\n');
    assert.throws(() => host.observe(77), /status grammar/);
    fs.writeFileSync(path.join(cg, 'a', 'b', 'cgroup.procs'), '77\nabc\n');
    assert.throws(() => host.cgroupProcs('/a/b'), /cgroup\.procs grammar/);
    fs.writeFileSync(path.join(proc, 'sys', 'kernel', 'random', 'boot_id'), 'not-a-boot-id\n');
    assert.throws(() => host.bootId(), /boot identity/);
});

// --- Provisioning ------------------------------------------------------------------------------
test('G1.provision-gpu-grants-before-the-first-start-and-records-the-host-records', async t => {
    const w = await provisioned(t);
    const profile = validateExecutionProfile(w.run);
    assert.deepEqual(profile.agents.map(agent => agent.role).sort(), ['cpu', 'peer', 'probe']);
    assert.equal(profile.fixtures.gpu.ref, 'hwlfixture/probe');
    // The grant ran through the product path BEFORE the start, naming exactly the two share clients.
    const order = w.fake.model.calls.filter(call => call.binary === w.node).map(call => call.args);
    const grant = order.findIndex(args => args.includes('gpu')); const start = order.findIndex(args => args.includes('start'));
    assert.ok(grant >= 0 && start > grant, 'gpu grant precedes the first start');
    assert.deepEqual(order[grant], [profile.candidate.path, 'gpu', 'grant', '--agent', 'hwlfixture/probe', '--agent', 'hwlfixture/peer']);
    // The probe file is written from the pinned bytes, and only into the probe agent.
    const written = path.join(profile.workspace.path, '.ploinky', 'repos', 'hwlfixture', 'probe', 'mpsprobe.py');
    assert.equal(hash(fs.readFileSync(written)), profile.gpu.probe.digest); assert.equal(hash(w.probeBytes), profile.gpu.probe.digest);
    assert.equal(exists(path.join(profile.workspace.path, '.ploinky', 'repos', 'hwlfixture', 'peer', 'mpsprobe.py')), false);
    // The fixture manifests: pinned image, non-GPU manifests (the share, not a manifest flag, attaches the device), the limits that fit a CUDA context.
    const manifest = JSON.parse(fs.readFileSync(path.join(profile.workspace.path, '.ploinky', 'repos', 'hwlfixture', 'probe', 'manifest.json'), 'utf8'));
    assert.equal(manifest.container, IMAGE); assert.deepEqual(manifest.hardwareLimits, { memory: '2g', cpus: '1', pidsLimit: 128 });
    assert.deepEqual(manifest.enable, ['hwlfixture/peer', 'hwlfixture/cpu']); assert.equal(Object.hasOwn(manifest, 'containerSecurity'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile.workspace.path, '.ploinky', 'repos', 'hwlfixture', 'cpu', 'manifest.json'), 'utf8')).hardwareLimits, { memory: '64m', cpus: '0.5', pidsLimit: 64 });
    // The initial gate ran before anything was created, and its baseline is a persisted artifact.
    assert.equal(w.artifacts.get('gpu-initial-gate').baseline.uuid, GPU_UUID);
    const ops = w.run.operations.map(op => op.kind);
    assert.ok(ops.indexOf('gpu-initial-gate') < ops.indexOf('workspace-create') && ops.indexOf('gpu-grant') < ops.indexOf('fixture-start'), ops.join(','));
    // Every host record the grant and the start created is recorded exactly; gpu-grants existed before and is not.
    const recorded = w.run.ownedPaths.filter(entry => entry.role === 'host-record').map(entry => entry.path).sort();
    assert.deepEqual(recorded, hostRecordPaths(w.home, profile.box.instance).filter(target => exists(target)).sort());
    assert.ok(recorded.some(target => target.includes('/gpu-grants/')));
    assert.equal(w.run.ownedPaths.some(entry => entry.role === 'host-created-directory' && entry.path.endsWith('gpu-grants')), false);
    assert.equal(exists(path.join(w.home, '.ploinky-box', 'gpu-grants')), true);
});

test('G1.provision-gpu-gate-busy-blocks-before-anything-is-created', async t => {
    for (const [label, faults] of [['a foreign compute process', { smiTransform: xml => xml.replace('<processes></processes>', '<processes><process_info><pid>555</pid><type>C</type></process_info></processes>') }],
        ['exclusive mode', { smiComputeMode: 'Exclusive_Process' }], ['inventory N/A', { smiProcessesNA: true }], ['another device', { smiOtherUuid: true }], ['nvidia-smi fails', { smiExit: { at: 1 } }]]) {
        const w = gpuWorld(t, { faults });
        const report = await w.provision();
        assert.equal(report.verdict, 'BLOCKED', `${label}: ${JSON.stringify(report.limitations)}`);
        assert.match(report.limitations[0], /GPU idle gate blocked/, label);
        assert.equal(exists(path.join(w.remoteRoot, 'workspace')), false, `${label}: no workspace`);
        const state = worldState(w.statePath);
        assert.deepEqual([state.startCalls, state.destroyCalls, Object.keys(state.boxes).length], [0, 0, 0], `${label}: the engine saw no mutation`);
        assert.equal(w.fake.model.grantCalls.length, 0, label);
        assert.equal(exists(path.join(w.home, '.ploinky-box', 'gpu-grants')), true);
    }
});

test('G1.provision-gpu-grant-failure-or-missing-wiring-is-blocked-and-cleans-up', async t => {
    for (const [label, faults] of [['the grant fails', { grantFails: true }], ['the Box has no GPU wiring', { noGpuWiring: true }]]) {
        const w = gpuWorld(t, { faults });
        const report = await w.provision();
        assert.equal(report.verdict, 'BLOCKED', `${label}: ${JSON.stringify(report.limitations)}`);
        assert.equal(w.run.cleanup.state, 'complete', `${label}: ${JSON.stringify(w.run.cleanup.failures)}`);
        assert.equal(exists(path.join(w.remoteRoot, 'workspace')), false, label);
        assert.deepEqual(hostRecordPaths(w.home, w.run.workspace.instance).filter(target => exists(target)), [], `${label}: no host record remains`);
        assert.equal(exists(path.join(w.home, '.ploinky-box', 'gpu-grants')), true, `${label}: the existing parent stays`);
        assert.equal(Object.keys(worldState(w.statePath).boxes).length, 0, label);
    }
});

test('G1.provision-gpu-refuses-a-changed-nvidia-tool-or-probe-digest', async t => {
    const w = gpuWorld(t);
    fs.writeFileSync(w.gpu.mpsControl, 'replaced tool\n');
    const report = await w.provision();
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations[0], /NVIDIA tool mpsControl identity changed/);
    assert.equal(exists(w.statePath), false);
    const second = gpuWorld(t);
    fs.writeFileSync(path.join(second.run.target.execution.source.root, 'tests', 'hardware-limits', 'mpsprobe.py'), '# replaced\n');
    const refused = await second.provision();
    assert.notEqual(refused.verdict, 'PASS'); assert.equal(exists(path.join(second.remoteRoot, 'workspace', '.ploinky', 'repos', 'hwlfixture', 'probe', 'mpsprobe.py')), false);
});

test('G1.cleanup-removes-the-recorded-grant-and-policy-records-and-keeps-the-gpu-grants-directory', async t => {
    for (const existing of [true, false]) {
        const w = await provisioned(t, { existingGrantDirectory: existing });
        const instance = w.run.workspace.instance;
        const grantRecord = path.join(w.home, '.ploinky-box', 'gpu-grants', `${instance}.json`);
        const policyDirectory = path.join(w.home, '.ploinky-box', 'hardware-limits', instance);
        assert.equal(exists(grantRecord), true); assert.equal(exists(policyDirectory), true);
        // A neighbour's record in the same shared directory is never touched.
        const neighbour = path.join(w.home, '.ploinky-box', 'gpu-grants', 'ploinky-box-other-0123456789ab.json');
        fs.mkdirSync(path.dirname(neighbour), { recursive: true }); fs.writeFileSync(neighbour, '{"mine":false}');
        const report = await w.cleanup();
        assert.equal(report.verdict, 'PASS', JSON.stringify(w.run.cleanup));
        assert.deepEqual(hostRecordPaths(w.home, instance).filter(target => exists(target)), [], 'exactly the recorded grant and policy records are gone');
        assert.equal(fs.readFileSync(neighbour, 'utf8'), '{"mine":false}');
        assert.equal(exists(path.join(w.home, '.ploinky-box', 'gpu-grants')), true, `the gpu-grants directory stays (existed before: ${existing})`);
        assert.equal(exists(path.join(w.remoteRoot, 'workspace')), false);
    }
    // When this run created the shared parent and nothing else lives in it, it goes.
    const alone = await provisioned(t, { existingGrantDirectory: false });
    const created = alone.run.ownedPaths.filter(entry => entry.role === 'host-created-directory').map(entry => path.basename(entry.path));
    assert.ok(created.includes('gpu-grants'));
    assert.equal((await alone.cleanup()).verdict, 'PASS');
    assert.equal(exists(path.join(alone.home, '.ploinky-box', 'gpu-grants')), false);
});

// --- LIVE-P1 -----------------------------------------------------------------------------------------
const nothingOwned = w => {
    assert.equal(w.run.cleanup.state, 'complete', JSON.stringify(w.run.cleanup));
    assert.equal(exists(path.join(w.remoteRoot, 'workspace')), false);
    assert.deepEqual(Object.keys(worldState(w.statePath).boxes), []);
    assert.deepEqual(hostRecordPaths(w.home, w.run.workspace.instance).filter(target => exists(target)), []);
};
const probeCalls = w => w.fake.model.calls.filter(call => call.args.includes('/code/mpsprobe.py'));

test('G1.P1-passes-daemon-defaults-host-uid-labels-and-minimal-environment', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1']);
    const p1 = caseOf(report, 'LIVE-P1');
    assert.equal(p1.result, 'pass', JSON.stringify(p1));
    const evidence = p1.evidence;
    assert.equal(evidence.gateBaseline.uuid, GPU_UUID); assert.equal(evidence.gateBaseline.computeMode, 'Default');
    // The daemon default is the 1044-MiB share rounded up to a whole GiB (A6); the status names the share it came from.
    assert.deepEqual(evidence.applied.gpu.serverDefault, { smPercent: 25, vramMiB: 2048, shareMemoryMiB: 1044 });
    assert.equal(evidence.daemon.box.cgroup, '0::/ploinky/core'); assert.deepEqual(evidence.daemon.host.uid, { real: 1000, effective: 1000, saved: 1000, fs: 1000 });
    assert.deepEqual(evidence.readbackForms, { sm: { form: 'integer-percentage', value: 25 }, memory: { form: 'integer-with-M-or-G', bytes: 2048 * 1048576 } });
    assert.deepEqual(evidence.client.env.sort(), ['CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=25', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=1044M', 'CUDA_MPS_PIPE_DIRECTORY=/run/ploinky-mps-pipe']);
    assert.deepEqual(Object.keys(evidence.client.labels).filter(key => key.startsWith('ploinky.mps')), ['ploinky.mpsgeneration']);
    assert.ok(evidence.clientHostProcesses.length > 0);
    // The share was set only through the administrator route: one save, one Apply, never a control command.
    const posts = w.fake.model.programs.filter(program => program.program === 'admin' && program.method === 'POST').map(program => JSON.parse(program.body).action);
    assert.deepEqual(posts, ['set_agent_limits', 'apply']);
    assert.equal(w.fake.model.controlLog.length, 0); assert.equal(w.fake.model.signals.length, 0);
    assert.deepEqual(w.fake.model.applyCalls, [['ploinky_hwlfixture_probe_' + path.basename(w.run.target.execution.workspace.path) + '_' + crypto.createHash('sha256').update(w.run.target.execution.workspace.path).digest('hex').slice(0, 8)]]);
    nothingOwned(w);
    assert.ok(w.artifacts.has('gpu-final-observation')); assert.deepEqual(w.artifacts.get('gpu-final-observation').processes, []);
});

test('G1.P1-is-blocked-when-a-prerequisite-is-missing-and-never-passes', async t => {
    const faults = [
        ['the administrator route answers 401', { adminStatus: 401 }, /administrator route answered 401/],
        ['the administrator route is missing', { adminStatus: 404 }, /answered 404/],
        ['MPS sharing is not eligible', { gpuIneligible: true }, /not eligible/],
        ['the memory default reply has an unsupported wire format', { memoryReplyForm: mib => `${mib} MiB\n` }, /unsupported wire format/],
        ['the fixture image user is not a numeric non-root UID:GID', { imageUser: 'node' }, /not a non-root numeric UID:GID/],
        ['the fixture image runs as root', { imageUser: '0:0' }, /not a non-root numeric UID:GID/],
    ];
    for (const [label, fault, message] of faults) {
        const w = await provisioned(t, { faults: fault });
        const report = await liveCases(w, ['LIVE-P1']);
        const p1 = caseOf(report, 'LIVE-P1');
        assert.equal(p1.result, 'blocked', `${label}: ${JSON.stringify(p1)}`); assert.match(p1.reason, message, label);
        assert.notEqual(report.verdict, 'PASS'); assert.ok(p1.evidence?.steps, `${label}: evidence was written before the verdict`);
        nothingOwned(w);
    }
    // An ineligible report records the read-only grant facts and the reported reason before it blocks, and never mutates.
    const ineligible = await provisioned(t, { faults: { gpuIneligible: true } });
    const ineligibleReport = await liveCases(ineligible, ['LIVE-P1']);
    const evidence = caseOf(ineligibleReport, 'LIVE-P1').evidence;
    assert.deepEqual(ineligible.fake.model.programs.filter(program => program.program === 'grant-facts').length, 1);
    assert.equal(evidence.gpuStatusReason.reason, 'GPU sharing is not qualified in this Box.');
    assert.equal(evidence.grantFacts.smi.bare.status, 127); assert.equal(evidence.grantFacts.smi.withLoaderPath.status, 0);
    assert.equal(ineligible.fake.model.programs.filter(program => program.program === 'admin' && program.method === 'POST').length, 0, 'nothing was applied');
    nothingOwned(ineligible);
    // A GPU that turned busy between provisioning and the live run blocks at the initial gate, before any GPU operation.
    const busy = await provisioned(t);
    busy.fake.addForeign(555);
    const report = await liveCases(busy, ['LIVE-P1']);
    assert.equal(caseOf(report, 'LIVE-P1').result, 'blocked'); assert.match(caseOf(report, 'LIVE-P1').reason, /gpu_busy/);
    assert.equal(busy.fake.model.programs.filter(program => program.program === 'admin').length, 0, 'no administrator request was made');
    nothingOwned(busy);
});

test('G1.P1-fails-on-a-wrong-uid-extra-environment-tool-bind-or-readonly-pipe', async t => {
    for (const [label, fault, message] of [
        ['the daemon does not run as uid 1000', { daemonUid0: true }, /does not run as uid 1000/],
        ['the client carries an extra CUDA variable', { extraCudaEnv: true }, /not exactly the three MPS variables/],
        ['the client holds an MPS tool binary', { clientHoldsTool: true }, /MPS tool binary or the state directory/],
        ['the pipe is not bound writable', { readOnlyPipe: true }, /not bound writable/],
    ]) {
        const w = await provisioned(t, { faults: fault });
        const report = await liveCases(w, ['LIVE-P1']);
        const p1 = caseOf(report, 'LIVE-P1');
        assert.equal(p1.result, 'fail', `${label}: ${JSON.stringify(p1).slice(0, 400)}`); assert.match(p1.reason, message, label);
        assert.equal(report.verdict, 'FAIL'); assert.ok(p1.evidence.daemon || p1.evidence.applied, `${label}: the evidence precedes the assertion`);
        nothingOwned(w);
    }
});

// --- LIVE-P2 -----------------------------------------------------------------------------------------
test('G1.P2-passes-share-tighter-values-and-bypass-with-recorded-rounding', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P2']);
    const p2 = caseOf(report, 'LIVE-P2');
    assert.equal(p2.result, 'pass', JSON.stringify(p2).slice(0, 600));
    const { measurements, rounding, share } = p2.evidence;
    assert.equal(share.capMiB, 1044); assert.equal(share.deviceUuid, GPU_UUID);
    assert.deepEqual([measurements.share.smCount, measurements.share.allocatedMiB, measurements.share.termination], [6, 896, 'allocation_oom']);
    assert.ok(measurements.tighterSm.smCount <= measurements.share.smCount); assert.ok(measurements.tighterMemory.allocatedMiB <= 512);
    assert.deepEqual([measurements.bypass.smCount, measurements.bypass.allocatedMiB, measurements.bypass.termination], [30, 1408, 'bound']);
    assert.ok(Object.values(measurements.bypass.mpsEnv).every(value => value === null), 'the bypass really dropped the MPS environment');
    assert.deepEqual([rounding.overheadMiB, rounding.stepMiB, rounding.pinnedFullSmCount, rounding.bypassSmCount, rounding.expectedSmShare, rounding.bypassMatchesPinned], [148, 128, 30, 30, 8, true]);
    // After every probe settled, the GPU and the MPS state are recorded (the A1 pattern), before any assertion.
    const afterSteps = p2.evidence.steps.filter(step => step.name.startsWith('probe-after:'));
    assert.deepEqual(afterSteps.map(step => step.name), ['probe-after:share', 'probe-after:tighter-sm', 'probe-after:tighter-memory', 'probe-after:bypass']);
    for (const step of afterSteps) { assert.equal(step.value.mpsAfter.daemonAlive, true); assert.equal(step.value.after.length, 2); assert.ok(step.value.after.every(sample => sample.freeMiB > 5000)); }
    assert.ok(afterSteps[0].value.mpsAfter.servers.length === 1, 'the MPS server the probe started is listed');
    // The exact probe commands, each after a gate query, the bypass through `env -u`.
    const argvs = probeCalls(w).map(call => call.args.slice(call.args.indexOf('container', 5)));
    assert.equal(argvs.length, 4);
    assert.deepEqual(argvs[0].slice(-4), ['python3', '/code/mpsprobe.py', '--max-mib', '1408']);
    assert.ok(argvs[1].includes('--env') && argvs[1].includes('CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=10'));
    assert.ok(argvs[2].includes('CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=512M') && argvs[2].at(-1) === '768');
    assert.ok(argvs[3].includes('env') && argvs[3].filter(word => word === '-u').length === 3);
    nothingOwned(w);
});

test('G1.P2-a-bypass-that-allocates-at-or-below-the-cap-fails', async t => {
    // A defect in the bypass (it behaves like the share) must fail the case, never pass it.
    const w = await provisioned(t, { faults: { bypassCapped: true } });
    const report = await liveCases(w, ['LIVE-P2']);
    const p2 = caseOf(report, 'LIVE-P2');
    assert.equal(p2.result, 'fail', JSON.stringify(p2).slice(0, 500)); assert.match(p2.reason, /bypass did not allocate above the 1044-MiB cap/);
    assert.equal(p2.evidence.measurements.bypass.termination, 'allocation_oom'); assert.ok(p2.evidence.measurements.bypass.allocatedMiB <= 1044);
    nothingOwned(w);
});

test('G1.P2-fails-when-the-share-does-not-cap-and-reports-probe-errors-with-their-step', async t => {
    const uncapped = await provisioned(t, { faults: { noCap: true } });
    const report = await liveCases(uncapped, ['LIVE-P2']);
    assert.equal(caseOf(report, 'LIVE-P2').result, 'fail'); assert.match(caseOf(report, 'LIVE-P2').reason, /did not cap allocations inside the calibrated range/);
    for (const [label, fault, result, message] of [
        ['a CUDA initialization error', { probeInit: true }, 'fail', /CUDA probe failed at cuInit: CUDA_ERROR_NO_DEVICE/],
        ['an unsupported driver call', { probeBlocked: true }, 'blocked', /CUDA probe unsupported: cuCtxGetExecAffinity/],
        ['libcuda missing at the wired path', { probeLibcuda: true }, 'blocked', /cannot load the driver library/],
    ]) {
        const w = await provisioned(t, { faults: fault });
        const r = await liveCases(w, ['LIVE-P2']);
        assert.equal(caseOf(r, 'LIVE-P2').result, result, label); assert.match(caseOf(r, 'LIVE-P2').reason, message, label);
        assert.equal(probeCalls(w).length, 1, `${label}: no further probe after the first failed`);
        nothingOwned(w);
    }
});

test('G1.P2-a-foreign-process-appearing-during-a-probe-blocks-and-starts-no-new-work', async t => {
    const w = await provisioned(t, { faults: { foreignDuringProbe: true, probeMs: 400 } });
    const report = await liveCases(w, ['LIVE-P2']);
    const p2 = caseOf(report, 'LIVE-P2');
    assert.equal(p2.result, 'blocked', JSON.stringify(p2).slice(0, 500)); assert.match(p2.reason, /foreign_process_appeared/);
    assert.equal(probeCalls(w).length, 1, 'no second probe starts after a foreign user appeared');
    assert.equal(w.fake.model.signals.length, 0, 'no process is signalled by the case');
    assert.equal(p2.evidence.gate.tripped.reason, 'foreign_process_appeared'); assert.deepEqual(p2.evidence.gate.tripped.foreign, [777777]);
    nothingOwned(w);
});

// --- LIVE-P3 -----------------------------------------------------------------------------------------
test('G1.P3-passes-drain-before-quit-final-clear-host-clear-restart-and-an-owned-daemon-crash', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P3']);
    const p3 = caseOf(report, 'LIVE-P3');
    assert.equal(p3.result, 'pass', JSON.stringify(p3).slice(0, 800));
    const e = p3.evidence;
    // Own-share change under the same default recreates only the peer.
    assert.equal(e.ownShareChange.probeSame, true); assert.equal(e.ownShareChange.daemonSame, true);
    // The default change: a new generation and daemon, a recreated cohort, drained before the quit.
    assert.notEqual(e.defaultChange.old.generation, e.defaultChange.new.generation); assert.notEqual(e.defaultChange.old.pid, e.defaultChange.new.pid);
    assert.deepEqual(e.defaultChange.new.serverDefault, { smPercent: 50, vramMiB: 3072, shareMemoryMiB: 2088 });
    assert.equal(e.defaultChangeTimeline.violation, null); assert.equal(e.defaultChangeTimeline.daemonGone, true); assert.ok(e.defaultChangeTimeline.samples > 3);
    assert.equal(e.defaultChangeTimeline.drainWindowObserved, true, 'the window between the last drained client and the quit was sampled');
    for (const key of ['finalClearTimeline', 'restartTimeline']) { assert.equal(e[key].ok, true, key); assert.equal(e[key].violation, null, key); }
    // The order the fake product performed, as the host would have seen it.
    const events = w.fake.model.events.join(' ');
    assert.match(events, /drain:probe drain:peer quit start create:probe create:peer/, events);
    assert.match(events, /drain:probe quit create:probe/, 'the final clear quits without starting another daemon');
    // The final clear and the host clear + restart leave no MPS state on the replacements.
    for (const key of ['daemonAbsent:final clear through Apply', 'daemonAbsent:host clear and ordinary restart']) assert.deepEqual([e[key].observedDaemon, e[key].oldAlive, e[key].daemonStatus], [false, false, 'stopped'], key);
    // The crash killed exactly one process: the owned daemon, after both layers proved it.
    assert.equal(w.fake.model.signals.length, 1); assert.equal(w.fake.model.signals[0].signal, 'SIGKILL'); assert.equal(w.fake.model.signals[0].hostPid, e.crash.killed.pid);
    assert.notEqual(e.recovery.generation, e.recovery.old);
    // CPU agents were never restarted, at any step.
    for (const step of e.steps.filter(entry => entry.name.startsWith('cpu-agent:'))) assert.equal(step.value.unchanged, true, step.name);
    assert.ok(e.steps.filter(entry => entry.name.startsWith('cpu-agent:')).length >= 6);
    // The host clear and the restart used the supported product commands.
    const candidate = w.fake.model.calls.filter(call => call.binary === w.node).map(call => call.args.slice(1));
    assert.ok(candidate.some(args => args.join(' ') === 'limits clear --agent hwlfixture/probe'));
    assert.ok(candidate.some(args => args.join(' ') === 'restart hwlfixture/probe'), 'the restart carries no port: --port and --udp-port are valid only before start, diagnose or repair');
    nothingOwned(w);
});

test('G1.P3-a-daemon-that-quits-before-its-clients-drain-fails', async t => {
    const w = await provisioned(t, { faults: { quitBeforeDrain: true } });
    const report = await liveCases(w, ['LIVE-P3']);
    const p3 = caseOf(report, 'LIVE-P3');
    assert.equal(p3.result, 'fail', JSON.stringify(p3).slice(0, 600)); assert.match(p3.reason, /old daemon was gone while an old client still ran/);
    assert.notEqual(p3.evidence.defaultChangeTimeline.violation, null);
    nothingOwned(w);
});

test('G1.P3-fails-when-an-unrelated-cpu-agent-is-restarted', async t => {
    const w = await provisioned(t, { faults: { restartCpu: true } });
    const report = await liveCases(w, ['LIVE-P3']);
    const p3 = caseOf(report, 'LIVE-P3');
    assert.equal(p3.result, 'fail', JSON.stringify(p3).slice(0, 600)); assert.match(p3.reason, /unrelated CPU agent was restarted/);
    nothingOwned(w);
});

test('G1.P3-the-crash-case-kills-only-an-owned-daemon-and-refuses-anything-it-cannot-prove', async t => {
    // The Box's own program refuses (the state does not name the daemon): BLOCKED, nothing signalled.
    const refused = await provisioned(t, { faults: { boxRefusesKill: true } });
    const report = await liveCases(refused, ['LIVE-P3']);
    assert.equal(caseOf(report, 'LIVE-P3').result, 'blocked'); assert.match(caseOf(report, 'LIVE-P3').reason, /refused to kill the daemon/);
    assert.equal(refused.fake.model.signals.length, 0);
    nothingOwned(refused);

    // The daemon's PID is reused between its identity proof and the kill: the host proof fails FIRST,
    // so the program is never even invoked and nothing is signalled.
    const w = await provisioned(t);
    const cases = createGpuCases({
        profile: w.run.target.execution, run: w.run, command: null, engine: null, core: null, nested: null, inspectBox: null, safeArtifact: () => {}, persist: () => {}, processProvider: null,
    });
    void cases;
    const adapter = await adapterOf(w);
    await adapter.internals.prepare();
    await adapter.internals.settleShares('crash', { probe: { smPercent: 25, vramPercent: 17 } }, adapter.internals.evidenceFor('LIVE-P3'));
    const identity = await adapter.internals.daemonIdentity();
    assert.ok(identity.daemon);
    w.fake.reusePid(identity.daemon.host.hostPid);
    await assert.rejects(adapter.internals.killOwnedDaemon(adapter.internals.evidenceFor('LIVE-P3'), identity.daemon), error => error.code === 'LIVE_PREREQUISITE_MISSING' && /not provably the owned process; nothing was signalled/.test(error.message));
    assert.equal(w.fake.model.programs.filter(program => program.program === 'kill').length, 0, 'the kill program was never invoked');
    assert.equal(w.fake.model.signals.length, 0);

    // A process that is not in the Box at all cannot even be mapped, so it cannot be named for a kill.
    const foreign = await provisioned(t);
    const other = await adapterOf(foreign);
    await other.internals.prepare();
    await other.internals.settleShares('crash', { probe: { smPercent: 25, vramPercent: 17 } }, other.internals.evidenceFor('LIVE-P3'));
    const live = foreign.fake.model.daemon;
    foreign.fake.model.procs.get(live.hostPid).cgroup = '/user.slice/not-this-box';
    await assert.rejects(other.internals.daemonIdentity(), error => error.code === 'LIVE_PREREQUISITE_MISSING' && /cannot be mapped to exactly one host process/.test(error.message));
    assert.equal(foreign.fake.model.signals.length, 0);
});

// A live adapter over a provisioned world, for tests of a single building block.
async function adapterOf(w, timings = FAST) {
    const { createLiveAdapter } = await import('../hardware-limits/liveHarness.mjs');
    const profile = validateExecutionProfile(w.run);
    const controller = new AbortController();
    const adapter = createLiveAdapter(profile, { processProvider: w.fake.provider, signal: controller.signal, cleanupSignal: controller.signal, persist: w.persist, run: w.run, artifacts: (name, value) => w.artifacts.set(name, structuredClone(value)), hostProc: w.fake.hostProc, gpuTimings: timings });
    await adapter.inspectBox();
    return adapter.gpu;
}

// --- LIVE-P4 -----------------------------------------------------------------------------------------
test('G1.P4-records-the-accepted-control-mutation-the-pipe-comparison-and-reconciles', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P4']);
    const p4 = caseOf(report, 'LIVE-P4');
    assert.equal(p4.result, 'pass', JSON.stringify(p4).slice(0, 800));
    const e = p4.evidence;
    assert.equal(e.controlMutation.widenSm.accepted, true); assert.equal(e.controlMutation.setMemory.accepted, true);
    assert.match(e.controlMutation.limitation, /best-effort, not a security boundary/);
    assert.deepEqual([e.pipeComparison.writable.mount.RW, e.pipeComparison.readOnly.mount.RW], [true, false]);
    assert.equal(e.pipeComparison.readOnly.connected, true, 'the read-only bind does not stop a socket connection (recorded, not presumed)');
    assert.deepEqual(w.fake.model.controlLog.map(entry => entry.command.replace(/ \d+ /, ' N ')), ['set_active_thread_percentage N 100', 'set_device_pinned_mem_limit N 0 64M']);
    // The helpers are the plan's: keep-id mapping, the control binary read-only at /x, both pipe modes; removed by exact ID.
    const runs = w.fake.model.calls.filter(call => call.args.includes('run') && call.args.includes('--detach')).map(call => call.args);
    assert.equal(runs.length, 2); assert.ok(runs.every(args => args.includes('--userns=keep-id:uid=1000,gid=1000') && args.includes('/usr/local/nvidia/bin/nvidia-cuda-mps-control:/x:ro')));
    assert.equal(w.fake.model.helpers.size, 0, 'both helpers were removed');
    // The new client after the mutation sets 100 itself; the reconcile cycle restores the configured defaults before the next measurement.
    assert.ok(e.afterMutation.smCount > 0); assert.equal(e.reconciled.serverDefault.smPercent, 25); assert.notEqual(e.reconciled.generation, e.reconciled.previous);
    assert.equal(e.afterReconcile.smCount, 6, 'the reconciled share is not widened'); assert.equal(e.afterReconcile.termination, 'allocation_oom');
    assert.equal(w.fake.model.widened, true);
    nothingOwned(w);
});

test('G1.P4-a-denied-or-refused-control-command-is-recorded-and-does-not-upgrade-the-assurance', async t => {
    const denied = await provisioned(t, { faults: { controlDenied: true, roConnectRefused: true } });
    const report = await liveCases(denied, ['LIVE-P4']);
    const p4 = caseOf(report, 'LIVE-P4');
    assert.equal(p4.result, 'pass', JSON.stringify(p4).slice(0, 500));
    assert.equal(p4.evidence.controlMutation.widenSm.accepted, false); assert.equal(p4.evidence.pipeComparison.readOnly.connected, false);
    assert.match(p4.evidence.controlMutation.limitation, /best-effort, not a security boundary/);
    nothingOwned(denied);
});

test('G1.P4-is-blocked-when-a-helper-cannot-be-created-or-cannot-reach-the-daemon', async t => {
    for (const [label, fault, message] of [['the helper cannot be created', { helperRunFails: true }, /control helper container could not be created/], ['the helper cannot reach the daemon', { helperCannotConnect: true }, /cannot read the owned daemon's server list/]]) {
        const w = await provisioned(t, { faults: fault });
        const report = await liveCases(w, ['LIVE-P4']);
        const p4 = caseOf(report, 'LIVE-P4');
        assert.equal(p4.result, 'blocked', `${label}: ${JSON.stringify(p4).slice(0, 400)}`); assert.match(p4.reason, message, label);
        assert.equal(w.fake.model.helpers.size, 0, `${label}: no helper is left`); assert.equal(w.fake.model.signals.length, 0);
        nothingOwned(w);
    }
});

// --- The whole block ---------------------------------------------------------------------------------
test('G1.live-run-passes-all-four-cases-then-cleans-up-with-the-gpu-observation', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1', 'LIVE-P2', 'LIVE-P3', 'LIVE-P4']);
    assert.deepEqual(report.cases.map(entry => [entry.id, entry.result]), [['LIVE-P1', 'pass'], ['LIVE-P2', 'pass'], ['LIVE-P3', 'pass'], ['LIVE-P4', 'pass']], JSON.stringify(report.limitations));
    assert.equal(report.verdict, 'PASS'); assert.equal(report.exitCode, 0);
    nothingOwned(w);
    assert.deepEqual(w.artifacts.get('gpu-final-observation').processes, []);
    for (const id of ['live-p1', 'live-p2', 'live-p3', 'live-p4']) assert.equal(w.artifacts.get(`gpu-${id}`).result, 'pass', id);
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 800000, 'the report fits the remote transport');
    assert.ok(Buffer.byteLength(JSON.stringify(w.run)) < 190000, 'the journal stays within its bound');
    assert.ok(w.run.operations.length < 200, `journaled operations: ${w.run.operations.length}`);
});

test('G1.live-run-writes-evidence-before-it-asserts-and-cleans-up-in-finally', async t => {
    const w = await provisioned(t, { faults: { bypassCapped: true } });
    const report = await liveCases(w, ['LIVE-P1', 'LIVE-P2']);
    assert.deepEqual(report.cases.slice(0, 2).map(entry => entry.result), ['pass', 'fail']); assert.equal(report.verdict, 'FAIL');
    const artifact = w.artifacts.get('gpu-live-p2');
    assert.ok(artifact.measurements && artifact.rounding, 'the measurements were written');
    assert.match(artifact.failure.message, /bypass did not allocate above/); assert.ok(artifact.steps.some(step => step.name === 'probe:bypass'));
    nothingOwned(w);
});

test('G1.live-run-block-deadline-comes-from-the-manifest', async t => {
    const w = await provisioned(t);
    assert.equal(w.run.deadlines.blockMs, 24 * 60 * 1000);
    const { dispatchRemoteRun } = await import('../hardware-limits/liveRemote.mjs');
    const seen = [];
    const run = JSON.parse(JSON.stringify(w.run));
    const report = { schema: 1, runId: run.runId, action: 'live', verdict: 'PASS', exitCode: 0, cases: [], cleanup: run.cleanup, limitations: [] };
    await dispatchRemoteRun({ run, action: 'live', cwd: w.evidence, manifestDigest: hash('x'), processProvider: async (binary, args, options) => { seen.push(options.deadlineMs); return ok(JSON.stringify(report)); } }).catch(() => {});
    assert.deepEqual(seen, [1770000], 'the dispatch deadline covers the GPU block, its cleanup and a margin, within the transport maximum');
});

// The approval summary must list every GPU operation the executors really perform: the
// nvidia-smi, nested-engine and candidate commands of a whole run, with their identities
// replaced by the plan's placeholders, are each a command of the plan.
test('G1.manifest-plan-lists-every-gpu-operation-the-executors-perform', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1', 'LIVE-P2', 'LIVE-P3', 'LIVE-P4']);
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    const { gpuPlan } = await import('../hardware-limits/liveManifest.mjs');
    const profile = w.run.target.execution;
    const plan = gpuPlan(w.run);
    const kindOf = binary => (binary === w.gpu.smi ? 'SMI' : binary === w.engine ? 'ENGINE' : 'NODE');
    const planned = [...plan.operations, ...w.run.target.plan.provision].filter(entry => entry.argv)
        .map(entry => [kindOf(entry.binary), ...entry.argv.map(word => (word === profile.candidate.path ? '<CANDIDATE>' : word))]);
    const wordPattern = word => new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<SERVER_PID>/g, '[1-9][0-9]*').replace(/<PIPE>/g, '[a-f0-9]{32}').replace(/<HOLDER>/g, '[\\s\\S]+').replace(/<(?:PROBE|HELPER|CONTAINER|NEW_CONTAINER)_ID>/g, '[a-f0-9]{64}')}$`);
    const inPlan = executed => planned.some(candidate => candidate.length === executed.length && candidate.every((word, index) => wordPattern(word).test(executed[index])));
    const boxId = profile.box.id;
    const unplanned = [];
    let probes = 0; let controls = 0; let helpers = 0; let removals = 0; let grants = 0; let smi = 0;
    for (const call of w.fake.model.calls) {
        const kind = kindOf(call.binary);
        const args = call.args.map(word => (word === profile.candidate.path ? '<CANDIDATE>' : word === boxId ? '<BOX_ID>' : word));
        const inner = kind === 'ENGINE' && args[0] === 'container' && args[1] === 'exec' ? args.slice(5) : [];
        const gpuOperation = kind === 'SMI'
            || (kind === 'NODE' && args.some(word => ['gpu', 'limits', 'restart'].includes(word)))
            || (inner[0] === 'podman' && (inner.some(word => /mpsprobe\.py/.test(word) || word === '-c' || word.endsWith('| /x')) || inner.includes('run') || (inner[2] === 'container' && inner[3] === 'rm')));
        if (!gpuOperation) continue;
        probes += inner.some(word => /mpsprobe\.py/.test(word)) ? 1 : 0; controls += inner.some(word => word.endsWith('| /x')) ? 1 : 0; helpers += inner.includes('run') ? 1 : 0;
        removals += inner[3] === 'rm' ? 1 : 0; grants += args.includes('grant') ? 1 : 0; smi += kind === 'SMI' ? 1 : 0;
        if (!inPlan([kind, ...args])) unplanned.push(`${kind} ${args.join(' ').slice(0, 200)}`);
    }
    assert.deepEqual(unplanned, [], 'every executed GPU operation is a command of the plan');
    assert.ok(probes >= 6 && controls === 6 && helpers === 2 && removals === 2 && grants === 1 && smi > 20, JSON.stringify({ probes, controls, helpers, removals, grants, smi }));
    const ids = plan.operations.map(entry => entry.id);
    for (const id of ['gpu-initial-gate', 'gpu-grant', 'P1-apply', 'P2-probe-bypass', 'P3-apply-default-change', 'P3-kill-owned-daemon', 'P3-host-clear', 'P3-restart-agent', 'P4-helper-create-rw', 'P4-control-rw-widen-sm', 'P4-probe-after-reconcile', 'gpu-final-observation']) assert.ok(ids.includes(id), id);
});

// --- The in-Box programs run for real against stand-ins of what they read ------------------------
const localize = (program, replacements) => Object.entries(replacements).reduce((text, [from, to]) => text.split(from).join(to), program);
// Asynchronous on purpose: the administrator program talks to a server in this very process.
function runProgram(program, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', program, ...args], { env: { PATH: process.env.PATH, ...(process.env.PLOINKY_AGENTLIB_DIR ? { PLOINKY_AGENTLIB_DIR: process.env.PLOINKY_AGENTLIB_DIR } : {}), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
}
// A fake /proc entry and the state file the programs read, for one fake daemon process.
function fakeMpsHost(t, { pid, start = '424242', uid = process.getuid(), cgroup = '0::/ploinky/core', pipeEnv = true, executable = process.execPath } = {}) {
    const root = scratch(t);
    const mps = path.join(root, 'mps'); const proc = path.join(root, 'proc'); const pipe = path.join(mps, `pipe-${'a'.repeat(32)}`); const log = path.join(mps, `log-${'a'.repeat(32)}`);
    for (const directory of [mps, pipe, log, path.join(proc, String(pid))]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const exe = fs.statSync(executable);
    const state = { schema: 1, status: 'ready', daemonGeneration: 'g1', configurationGeneration: 'c1', serverDefault: { smPercent: 25, memoryMiB: 1044 }, pipeDirectory: pipe, logDirectory: log,
        daemon: { pid, startTime: start, executableDev: exe.dev, executableIno: exe.ino }, tools: { control: { dev: 1, ino: 2 }, server: { dev: 1, ino: 3 } }, pendingClients: [{ key: 'k1' }], oldClients: [], desiredClients: [{ key: 'k2' }] };
    fs.writeFileSync(path.join(mps, 'state.json'), JSON.stringify(state), { mode: 0o600 });
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (nvidia-cuda-mps) S 1 ${pid} ${pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000 1`);
    fs.writeFileSync(path.join(proc, String(pid), 'status'), `Name:\tnvidia-cuda-mps\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    fs.writeFileSync(path.join(proc, String(pid), 'cgroup'), `${cgroup}\n`);
    fs.writeFileSync(path.join(proc, String(pid), 'environ'), pipeEnv ? `PATH=/usr/bin\0CUDA_MPS_PIPE_DIRECTORY=${pipe}\0` : 'PATH=/usr/bin\0');
    fs.symlinkSync(executable, path.join(proc, String(pid), 'exe'));
    const control = path.join(root, 'mps-control');
    fs.writeFileSync(control, `#!${process.execPath}\nlet input='';process.stdin.on('data',d=>input+=d).on('end',()=>{const c=input.trim();const r={'get_default_active_thread_percentage':'25\\n','get_default_device_pinned_mem_limit 0':'1044M\\n','get_server_list':'4321\\n'};process.stdout.write(r[c]??'');process.exit(r[c]===undefined?1:0);});\n`, { mode: 0o755 });
    return { root, mps, proc, control, pipe, state, localize: program => localize(program, { '/run/ploinky/mps': mps, '/proc/': `${proc}/`, '/usr/local/nvidia/bin/nvidia-cuda-mps-control': control }) };
}

test('G1.mps-observe-program-reads-the-state-the-daemon-facts-and-the-three-control-replies', async t => {
    const fake = fakeMpsHost(t, { pid: 777 });
    const run = await runProgram(fake.localize(MPS_OBSERVE), [], {});
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual([out.state.status, out.state.daemonGeneration, out.state.serverDefault, out.state.pendingClients, out.state.desiredClients], ['ready', 'g1', { smPercent: 25, memoryMiB: 1044 }, ['k1'], ['k2']]);
    assert.deepEqual([out.daemon.pid, out.daemon.alive, out.daemon.startTime, out.daemon.cgroup, out.daemon.pipeEnvMatches], [777, true, '424242', '0::/ploinky/core', true]);
    assert.ok(out.daemon.status.some(line => line === `Uid:\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}`));
    assert.deepEqual(out.control.map(reply => [reply.command, reply.status, reply.stdout]), [['get_default_active_thread_percentage', 0, '25\n'], ['get_default_device_pinned_mem_limit 0', 0, '1044M\n'], ['get_server_list', 0, '4321\n']]);
    // No daemon process: the state is read, the daemon is reported dead and no control query is made.
    fs.rmSync(path.join(fake.proc, '777'), { recursive: true });
    const dead = JSON.parse((await runProgram(fake.localize(MPS_OBSERVE), [], {})).stdout);
    assert.deepEqual([dead.daemon.alive, dead.control], [false, null]);
    // A world-readable state file is unsafe and refused.
    fs.chmodSync(path.join(fake.mps, 'state.json'), 0o644);
    assert.notEqual((await runProgram(fake.localize(MPS_OBSERVE), [], {})).status, 0);
});

test('G1.mps-kill-program-refuses-everything-it-cannot-prove-and-signals-only-the-proven-daemon', async t => {
    const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const refusals = [
        ['another start time', { start: '424242' }, ['START_OFFSET']],
        ['a daemon the state does not name', { start: '424242' }, ['PID_OFFSET']],
        ['a different uid', { uid: process.getuid() + 1 }, []],
        ['another cgroup', { cgroup: '0::/ploinky/agents/libpod-x' }, []],
        ['a pipe environment that differs', { pipeEnv: false }, []],
    ];
    for (const [label, fakeOptions, flag] of refusals) {
        const child = sleeper(); t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
        const fake = fakeMpsHost(t, { pid: child.pid, ...fakeOptions });
        const start = flag[0] === 'START_OFFSET' ? '1' : fakeOptions.start || '424242';
        const pid = flag[0] === 'PID_OFFSET' ? child.pid + 1 : child.pid;
        const run = await runProgram(fake.localize(MPS_KILL_OWNED_DAEMON), [String(pid), start], {});
        assert.equal(run.status, 0, `${label}: ${run.stderr}`); assert.equal(JSON.parse(run.stdout).killed, false, label); assert.ok(JSON.parse(run.stdout).refused, label);
        assert.equal(alive(child.pid), true, `${label}: the process was not signalled`);
    }
    // Everything proven: exactly that process is killed.
    const child = sleeper(); const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal)));
    const fake = fakeMpsHost(t, { pid: child.pid });
    const run = await runProgram(fake.localize(MPS_KILL_OWNED_DAEMON), [String(child.pid), '424242'], {});
    assert.deepEqual(JSON.parse(run.stdout), { killed: true, pid: child.pid, start: '424242' });
    assert.equal(await exited, 'SIGKILL');
    // Invalid identities are refused before anything is read.
    assert.notEqual((await runProgram(fake.localize(MPS_KILL_OWNED_DAEMON), ['1', '1'], {})).status, 0);
    assert.notEqual((await runProgram(fake.localize(MPS_KILL_OWNED_DAEMON), ['abc', '1'], {})).status, 0);
});

test('G1.administrator-request-program-authenticates-against-the-products-own-verifiers', async t => {
    // The program mints the local operator session and the control-origin CSRF token the way the
    // product does; here the product's own verifiers judge them (same workspace key), and a wrong
    // key or a wrong origin is refused, so a pass is not a stand-in's agreement.
    const key = 'f'.repeat(64);
    const previous = process.env.PLOINKY_MASTER_KEY;
    process.env.PLOINKY_MASTER_KEY = key;
    t.after(() => { if (previous === undefined) delete process.env.PLOINKY_MASTER_KEY; else process.env.PLOINKY_MASTER_KEY = previous; });
    const { verifySessionJwt } = await import('../../cli/server/auth/localService.js');
    const { verifyAdminMutationRequest } = await import('../../cli/server/adminControlSecurity.js');
    const { localSessionAllowedForRoutePlan } = await import('../../cli/server/authHandlers/authContext.js');
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const token = /(?:^|;\s*)ploinky_jwt=([^;]+)/.exec(req.headers.cookie || '')?.[1];
            let verdict = { status: 401, text: '{"error":"not_authenticated"}' };
            try {
                const payload = verifySessionJwt(token);
                req.session = { _jwtPayload: payload, user: payload.usr }; req.sessionId = token;
                const admin = localSessionAllowedForRoutePlan(req.session) && payload.usr.roles.includes('admin');
                const csrf = req.method === 'POST' ? verifyAdminMutationRequest(req, token) : { ok: true };
                seen.push({ method: req.method, url: req.url, host: req.headers.host, admin, csrf, body });
                verdict = admin && csrf.ok ? { status: 200, text: JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null, token: { epoch: 'e', revision: 1 } }) } : { status: 403, text: JSON.stringify({ ok: false, error: csrf.code || 'admin_required' }) };
            } catch (error) { verdict = { status: 401, text: JSON.stringify({ error: String(error.message).slice(0, 80) }) }; }
            res.writeHead(verdict.status, { 'Content-Type': 'application/json' }); res.end(verdict.text);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const port = server.address().port;
    const program = localize(ADMIN_REQUEST, { '/opt/ploinky/': `${REPO}/`, "const host='127.0.0.1:8080'": `const host='127.0.0.1:${port}'`, 'port:8080': `port:${port}` });
    const bodyText = JSON.stringify({ action: 'apply', expectedToken: { epoch: 'e', revision: 1 }, containers: ['k'] });
    const get = JSON.parse((await runProgram(program, ['GET', ''], { PLOINKY_MASTER_KEY: key })).stdout);
    assert.equal(get.status, 200, get.text); assert.equal(JSON.parse(get.text).ok, true);
    const post = JSON.parse((await runProgram(program, ['POST', bodyText], { PLOINKY_MASTER_KEY: key })).stdout);
    assert.equal(post.status, 200, post.text); assert.deepEqual(JSON.parse(post.text).echo, JSON.parse(bodyText));
    assert.deepEqual(seen.map(entry => [entry.method, entry.url, entry.host, entry.admin, entry.csrf.ok]), [['GET', '/api/marketplace/hardware-limits', `127.0.0.1:${port}`, true, true], ['POST', '/api/marketplace/hardware-limits', `127.0.0.1:${port}`, true, true]]);
    // The wrong workspace key cannot mint a session the router accepts.
    const forged = JSON.parse((await runProgram(program, ['POST', bodyText], { PLOINKY_MASTER_KEY: '0'.repeat(64) })).stdout);
    assert.ok([401, 403].includes(forged.status), JSON.stringify(forged));
    // An oversized or invalid request is refused by the program before any connection.
    assert.notEqual((await runProgram(program, ['DELETE', ''], { PLOINKY_MASTER_KEY: key })).status, 0);
    assert.notEqual((await runProgram(program, ['POST', 'x'.repeat(20000)], { PLOINKY_MASTER_KEY: key })).status, 0);
});

// --- Plan and profile validation -------------------------------------------------------------------
test('G1.gpu-plan-and-profile-validation-refuse-inconsistent-fixtures-and-pins', async t => {
    const { validateProvisionPlan } = await import('../hardware-limits/liveFixture.mjs');
    const w = gpuWorld(t);
    const plan = () => structuredClone(w.run.target.execution.provision);
    assert.doesNotThrow(() => validateProvisionPlan(plan(), w.run));
    const mutate = (label, change) => { const value = plan(); change(value); assert.throws(() => validateProvisionPlan(value, w.run), label); };
    mutate('GPU agents without a GPU plan', value => { delete value.gpu; });
    mutate('a GPU plan over CPU agents', value => { value.agents = value.agents.filter(agent => agent.name === 'cpu'); });
    mutate('missing the cpu agent', value => { value.agents = value.agents.filter(agent => agent.name !== 'cpu'); });
    mutate('another agent order', value => { value.agents.reverse(); });
    mutate('limits that are not the GPU fixture limits', value => { value.agents[0].hardwareLimits.memory = '64m'; });
    mutate('a cpu agent with GPU limits', value => { value.agents[2].hardwareLimits = { memory: '2g', cpus: '1', pidsLimit: 128 }; });
    mutate('a grant that names the cpu agent', value => { value.gpu.grantAgents = ['hwlfixture/probe', 'hwlfixture/peer', 'hwlfixture/cpu']; });
    mutate('a short device UUID', value => { value.gpu.uuid = 'GPU-1'; });
    mutate('another probe target', value => { value.gpu.probe.target = '../escape.py'; });
    mutate('an unknown field', value => { value.gpu.extra = 1; });
    // The profile: the cases need the pins, and the pins must agree with the plan.
    const clone = () => structuredClone(w.run);
    for (const [label, change] of [
        ['no GPU pins', run => { delete run.target.execution.gpu; }],
        ['a pin of another device than the plan', run => { run.target.execution.gpu.uuid = 'GPU-87654321-4321-4321-8321-123456789abc'; }],
        ['a relative tool path', run => { run.target.execution.gpu.smi.path = 'nvidia-smi'; }],
        ['a probe pin outside the candidate source', run => { run.target.execution.gpu.probe.sourcePath = '/tmp/mpsprobe.py'; }],
        ['a probe digest that differs from the plan', run => { run.target.execution.gpu.probe.digest = hash('other'); }],
        ['no GPU fixture reference', run => { delete run.target.execution.fixtures.gpu; run.target.execution.fixtures.cpu = { ref: 'hwlfixture/probe' }; }],
        ['an extra pin field', run => { run.target.execution.gpu.extra = 1; }],
    ]) {
        const run = clone(); change(run);
        assert.throws(() => validateProfile(run, { partial: true }), label);
    }
    assert.doesNotThrow(() => validateProfile(clone(), { partial: true }));
});

// --- GF4: an ambiguous process inventory is unsupported ------------------------------------------
test('G1.gate-an-ambiguous-process-inventory-is-unsupported-whichever-section-comes-first', async () => {
    const busy = `<processes>${row(456, 'G')}</processes>`;
    const empty = '<processes></processes>';
    const wrap = body => smiXml().replace(empty, body);
    for (const [label, body] of [['empty then busy', empty + busy], ['busy then empty', busy + empty], ['two empty sections', empty + empty], ['two busy sections', busy + busy]]) {
        assert.throws(() => parseGpuInventory(smiOk(wrap(body)), UUID), /Ambiguous GPU process inventory structure/, label);
        const { gate } = scriptedGate({ replies: [smiOk(wrap(body)), smiOk(wrap(body))] });
        await assert.rejects(gate.initial(), blockedWith('unsupported_output'), `${label}: the initial gate is blocked as unsupported`);
        const later = scriptedGate({ replies: [smiOk(smiXml()), smiOk(wrap(body))] });
        await later.gate.initial();
        await assert.rejects(later.gate.check('op'), blockedWith('unsupported_output'), `${label}: a later check is blocked as unsupported too`);
    }
    // A section outside the selected device, an unbalanced tag and a missing device element are unsupported as well.
    assert.throws(() => parseGpuInventory(smiOk(smiXml().replace('</gpu>', `</gpu>${empty}`)), UUID), /Ambiguous GPU process inventory structure/);
    assert.throws(() => parseGpuInventory(smiOk(smiXml().replace(empty, '<processes>')), UUID), /Ambiguous GPU process inventory structure|Unsupported GPU inventory/);
    assert.throws(() => parseGpuInventory(smiOk(smiXml().replace('</gpu>', '</gpu></gpu>')), UUID), /Unsupported GPU inventory/);
    // Controls: exactly one section is read, whether empty or busy.
    assert.deepEqual(parseGpuInventory(smiOk(wrap(empty)), UUID).processes, []);
    assert.deepEqual(parseGpuInventory(smiOk(wrap(busy)), UUID).processes, [{ pid: 456, type: 'G' }]);
    const { gate } = scriptedGate({ replies: [smiOk(wrap(busy))] });
    await assert.rejects(gate.initial(), blockedWith('gpu_busy'));
});

// --- GF2: the bypass must see the pinned full-device SM count --------------------------------------
test('G1.P2-a-bypass-that-sees-fewer-sms-than-the-pinned-device-fails-and-keeps-the-evidence', async t => {
    // 24 SMs against the pinned 30: the bypass is itself restricted, so it proves nothing about the unrestricted device.
    const restricted = await provisioned(t, { gpuOverrides: { smCount: 24 } });
    const report = await liveCases(restricted, ['LIVE-P2']);
    const p2 = caseOf(report, 'LIVE-P2');
    assert.equal(p2.result, 'fail', JSON.stringify(p2).slice(0, 500));
    assert.match(p2.reason, /bypass SM count 24 differs from the pinned full-device count 30/);
    assert.deepEqual([p2.evidence.rounding.bypassSmCount, p2.evidence.rounding.pinnedFullSmCount, p2.evidence.rounding.bypassMatchesPinned], [24, 30, false]);
    assert.ok(p2.evidence.measurements.bypass && p2.evidence.measurements.share, 'the measurements are kept');
    nothingOwned(restricted);
    // A device with MORE SMs than pinned fails the same way: the pin is exact, not a lower bound.
    const larger = await provisioned(t, { gpuOverrides: { smCount: 36 } });
    const bigger = caseOf(await liveCases(larger, ['LIVE-P2']), 'LIVE-P2');
    assert.equal(bigger.result, 'fail'); assert.match(bigger.reason, /bypass SM count 36 differs from the pinned full-device count 30/);
    // The 30-versus-30 control passes (the whole-block and P2 tests above run it).
    const control = await provisioned(t);
    const passed = caseOf(await liveCases(control, ['LIVE-P2']), 'LIVE-P2');
    assert.equal(passed.result, 'pass'); assert.equal(passed.evidence.rounding.bypassMatchesPinned, true);
});

// --- GF3: P4 observes the SM change before the independent memory setter -------------------------------
test('G1.P4-the-sm-observation-precedes-the-independent-memory-setter-and-is-not-confounded', async t => {
    // The fake models an ACCEPTED low per-server memory limit that makes the next context creation fail.
    const w = await provisioned(t, { faults: { memorySetterBreaksNextContext: true } });
    const report = await liveCases(w, ['LIVE-P4']);
    const p4 = caseOf(report, 'LIVE-P4');
    assert.equal(p4.result, 'pass', JSON.stringify(p4).slice(0, 700));
    const names = p4.evidence.steps.map(step => step.name);
    const at = name => names.indexOf(name);
    assert.ok(at('control:rw-widen-sm') >= 0 && at('control:rw-widen-sm') < at('probe:after-sm-mutation') && at('probe:after-sm-mutation') < at('control:rw-set-memory') && at('control:rw-set-memory') < at('probe:after-memory-mutation'), names.join(','));
    // The SM observation completed in a context that was not affected by the memory setter.
    assert.ok(p4.evidence.afterMutation.smCount > 0); assert.equal(p4.evidence.afterMutation.termination, 'allocation_oom');
    // The memory setter's effect is recorded as an observation: the next context failed, and the case did not fail for it.
    assert.deepEqual([p4.evidence.controlMutation.setMemory.accepted, p4.evidence.controlMutation.setMemory.effect.observed, p4.evidence.controlMutation.setMemory.effect.contextCreated], [true, true, false]);
    assert.match(p4.evidence.controlMutation.setMemory.effect.error, /cuCtxCreate: CUDA_ERROR_OUT_OF_MEMORY/);
    // The owned daemon was reconciled afterwards: a new generation, with the limit gone.
    assert.notEqual(p4.evidence.reconciled.generation, p4.evidence.reconciled.previous); assert.equal(w.fake.model.memoryLimited, false);
    assert.equal(p4.evidence.afterReconcile.smCount, 6);
    nothingOwned(w);
    // A DENIED memory setter is not reported as isolation: no effect is claimed, the limitation text stays.
    const denied = await provisioned(t, { faults: { controlDenied: true } });
    const quiet = caseOf(await liveCases(denied, ['LIVE-P4']), 'LIVE-P4');
    assert.equal(quiet.result, 'pass');
    assert.deepEqual([quiet.evidence.controlMutation.setMemory.accepted, quiet.evidence.controlMutation.setMemory.effect.observed], [false, false]);
    assert.match(quiet.evidence.controlMutation.setMemory.effect.reason, /denied or did not answer/); assert.match(quiet.evidence.controlMutation.limitation, /not a security boundary/);
    assert.equal(quiet.evidence.steps.some(step => step.name === 'probe:after-memory-mutation'), false, 'no context is tried after a denied setter');
});

test('G1.P4-always-reconciles-the-owned-daemon-even-when-the-case-fails-or-is-blocked', async t => {
    // A blocked helper (cannot reach the daemon) still reconciles; a case failure after the mutation too.
    const blockedCase = await provisioned(t, { faults: { helperCannotConnect: true } });
    const report = await liveCases(blockedCase, ['LIVE-P4']);
    const p4 = caseOf(report, 'LIVE-P4');
    assert.equal(p4.result, 'blocked'); assert.ok(p4.evidence.reconciled, 'the daemon was reconciled although the case was blocked');
    assert.equal(blockedCase.fake.model.helpers.size, 0);
    nothingOwned(blockedCase);
    // A tripped gate starts no new work: the reconcile is skipped and cleanup stops the owned clients.
    const tripped = await provisioned(t, { faults: { foreignDuringProbe: true, probeMs: 400 } });
    const r2 = await liveCases(tripped, ['LIVE-P4']);
    const t4 = caseOf(r2, 'LIVE-P4');
    assert.equal(t4.result, 'blocked'); assert.match(t4.reason, /foreign_process_appeared/);
    assert.equal(t4.evidence.reconciled, undefined); assert.ok(t4.evidence.steps.some(step => step.name === 'reconcile-skipped'));
    nothingOwned(tripped);
});

// --- GF1: cleanup is certified only by a SUCCESSFUL final GPU observation -------------------------------
const liveWithFinalFault = async (w, faults, fault, ids = ['LIVE-P1']) => {
    const original = w.fake.provider;
    // The fault starts when the Box has been destroyed, i.e. at the final observation only.
    const processProvider = async (binary, args, options) => {
        const result = await original(binary, args, options);
        if (binary === w.node && args.includes('destroy')) Object.assign(faults, fault);
        return result;
    };
    w.run.target.execution.cases = ids;
    return executeLiveRun({
        run: w.run, persist: w.persist, processProvider, hostIdentity: w.hostIdentity, remoteArrival: true, hostProc: w.fake.hostProc, gpuTimings: FAST,
        artifacts: (name, value) => w.artifacts.set(name, structuredClone(value)),
    });
};
const FINAL_FAULTS = [
    ['the final query exits nonzero', { smiExit: {} }],
    ['the final query times out', { smiTimeout: true }],
    ['the final reply is truncated XML', { smiTransform: xml => xml.slice(0, 120) }],
    ['the final process inventory is unavailable', { smiProcessesNA: true }],
    ['the final reply is ambiguous (two process sections)', { smiTransform: xml => xml.replace('</gpu>', '<processes></processes></gpu>') }],
    ['the compute mode is no longer Default', { smiComputeMode: 'Exclusive_Process' }],
    ['the device is another one', { smiOtherUuid: true }],
];

test('G1.gf1-a-missing-malformed-or-timed-out-final-gpu-observation-never-certifies-cleanup-or-a-pass', async t => {
    for (const [label, fault] of FINAL_FAULTS) {
        const faults = {};
        const w = await provisioned(t, { faults });
        const report = await liveWithFinalFault(w, faults, fault);
        // The case outcome is preserved, the overall result and the cleanup are not a pass.
        assert.equal(caseOf(report, 'LIVE-P1').result, 'pass', label);
        assert.equal(report.verdict, 'FAIL', label); assert.equal(report.exitCode, 1, label);
        assert.equal(w.run.cleanup.state, 'failed', label); assert.notEqual(w.run.state, 'complete', label);
        assert.match(w.run.cleanup.failures.at(-1), /final GPU observation failed, so cleanup is not certified/, label);
        assert.equal(w.artifacts.get('gpu-final-observation').error !== null, true, `${label}: the failed observation is evidence`);
        // The recovery records survive in the manifest, in memory and on disk, each with its full tuple.
        assert.ok(w.run.ownedProcesses.length >= 1 && w.run.ownedProcesses.some(entry => entry.role === 'mps-server'), label);
        assert.ok(w.run.ownedProcesses.every(entry => entry.kind === 'gpu-process' && ['mps-server', 'mps-client'].includes(entry.role) && entry.hostPid > 0 && entry.bootId && /^\d+$/.test(entry.startIdentity) && entry.cgroup.startsWith('/') && Number.isSafeInteger(entry.ppid)), label);
        assert.deepEqual(JSON.parse(fs.readFileSync(w.runPath, 'utf8')).ownedProcesses, w.run.ownedProcesses, `${label}: persisted`);
        assert.doesNotThrow(() => validateProfile(w.run, { partial: true }), label);
        // The Box itself is gone and nothing foreign was signalled.
        assert.deepEqual(Object.keys(worldState(w.statePath).boxes), [], label); assert.equal(w.fake.model.signals.length, 0, label);
    }
    // After P2 the manifest also holds the clients the bypass probe registered, each with its tuple.
    const faults = {};
    const w = await provisioned(t, { faults });
    const report = await liveWithFinalFault(w, faults, { smiExit: {} }, ['LIVE-P2']);
    assert.equal(caseOf(report, 'LIVE-P2').result, 'pass'); assert.equal(w.run.cleanup.state, 'failed');
    assert.ok(w.run.ownedProcesses.some(entry => entry.role === 'mps-server') && w.run.ownedProcesses.some(entry => entry.role === 'mps-client'), JSON.stringify(w.run.ownedProcesses.map(entry => entry.role)));
    // The retry proves every one of them gone.
    delete faults.smiExit;
    assert.equal((await w.cleanup()).verdict, 'PASS');
    assert.ok(w.artifacts.get('gpu-final-observation').registered >= 2); assert.deepEqual(w.artifacts.get('gpu-final-observation').survivors, []);
});

test('G1.gf1-standalone-cleanup-needs-the-final-gpu-observation-and-a-retry-passes-once-it-works', async t => {
    // Resumed after a live run whose final observation failed: the standalone cleanup is not a PASS while the query is unavailable.
    const faults = {};
    const w = await provisioned(t, { faults });
    const live = await liveWithFinalFault(w, faults, { smiExit: {} });
    assert.equal(live.verdict, 'FAIL');
    const records = structuredClone(w.run.ownedProcesses);
    const unavailable = await w.cleanup();
    assert.equal(unavailable.verdict, 'FAIL'); assert.equal(w.run.cleanup.state, 'failed'); assert.match(w.run.cleanup.failures.at(-1), /final GPU observation failed/);
    assert.deepEqual(w.run.ownedProcesses, records, 'the recovery records are kept for the retry');
    // The retry passes once the query works, and certifies it with a successful observation.
    delete faults.smiExit;
    const retried = await w.cleanup();
    assert.equal(retried.verdict, 'PASS', JSON.stringify(w.run.cleanup)); assert.equal(w.run.cleanup.state, 'complete'); assert.equal(w.run.state, 'complete');
    assert.deepEqual(w.artifacts.get('gpu-final-observation').processes, []); assert.equal(w.artifacts.get('gpu-final-observation').error, null);
    assert.ok(w.artifacts.get('gpu-final-observation').registered >= 1, 'the registered owned processes were checked');
    assert.deepEqual(w.run.ownedProcesses, records);
    nothingOwned(w);
    // A fixture that never ran a case is held to the same proof: no GPU query, no PASS.
    const freshFaults = {};
    const fresh = await provisioned(t, { faults: freshFaults });
    freshFaults.smiExit = {};
    const never = await fresh.cleanup();
    assert.equal(never.verdict, 'FAIL'); assert.equal(fresh.run.cleanup.state, 'failed');
    delete fresh.faults.smiExit;
    assert.equal((await fresh.cleanup()).verdict, 'PASS'); nothingOwned(fresh);
});

test('G1.gf1-an-owned-process-that-survives-the-destruction-fails-cleanup-and-is-not-signalled', async t => {
    const w = await provisioned(t, { faults: { survivorAfterDestroy: true } });
    w.run.target.execution.cases = ['LIVE-P1'];
    const report = await w.live();
    assert.equal(caseOf(report, 'LIVE-P1').result, 'pass'); assert.equal(report.verdict, 'FAIL');
    assert.equal(w.run.cleanup.state, 'failed'); assert.match(w.run.cleanup.failures.at(-1), /An owned GPU process survived the destruction of its Box: mps-server \d+; it was not signalled/);
    const survivors = w.artifacts.get('gpu-final-observation').survivors;
    assert.equal(survivors.length, 1); assert.equal(w.fake.model.signals.length, 0, 'nothing was signalled');
    // A standalone retry still fails while the process lives, and passes once its owner has stopped it.
    assert.equal((await w.cleanup()).verdict, 'FAIL');
    w.fake.model.procs.clear();
    assert.equal((await w.cleanup()).verdict, 'PASS'); assert.equal(w.run.cleanup.state, 'complete');
    // A process that merely reuses a registered PID (another start identity) is not ours and is not a survivor.
    const reused = await provisioned(t);
    reused.run.target.execution.cases = ['LIVE-P1'];
    const original = reused.fake.provider;
    await reused.live({ processProvider: async (binary, args, options) => { const result = await original(binary, args, options); if (binary === reused.node && args.includes('destroy')) for (const entry of reused.run.ownedProcesses) reused.fake.model.procs.set(entry.hostPid, { hostPid: entry.hostPid, start: '999999', ppid: 1, cgroup: '/elsewhere', nspid: [entry.hostPid], uid: 1000 }); return result; } });
    assert.equal(reused.run.cleanup.state, 'complete', JSON.stringify(reused.run.cleanup.failures));
});

test('G1.gf1-a-gpu-fixture-whose-provisioning-failed-is-certified-clean-only-by-a-successful-final-observation', async t => {
    // The grant fails; the cleanup that follows needs the final observation, whose query (the second) is unavailable.
    const faults = { grantFails: true, smiExit: { at: 2 } };
    const w = gpuWorld(t, { faults });
    const report = await w.provision();
    assert.equal(report.verdict, 'FAIL', JSON.stringify(report.limitations)); assert.equal(w.run.cleanup.state, 'failed');
    assert.match(w.run.cleanup.failures.at(-1), /final GPU observation failed/);
    assert.deepEqual(Object.keys(worldState(w.statePath).boxes), [], 'the resources were cleaned; only the certification is missing');
    delete faults.smiExit;
    assert.equal((await w.cleanup()).verdict, 'PASS'); nothingOwned(w);
});

test('G1.gf1-only-registered-gpu-processes-may-be-recorded-in-the-manifest', async t => {
    const w = await provisioned(t);
    const record = { kind: 'gpu-process', role: 'mps-server', hostPid: 4242, bootId: 'boot-1', startIdentity: '123', cgroup: '/box/ploinky/core', ppid: 1 };
    const withRecords = entries => { const run = structuredClone(w.run); run.ownedProcesses = entries; return run; };
    assert.doesNotThrow(() => validateProfile(withRecords([record])));
    for (const [label, entry] of [['another kind', { ...record, kind: 'process' }], ['another role', { ...record, role: 'foreign' }], ['a missing field', (({ ppid, ...rest }) => rest)(record)], ['an extra field', { ...record, extra: 1 }], ['a non-numeric start identity', { ...record, startIdentity: 'x' }], ['a bare PID', 4242]]) {
        assert.throws(() => validateProfile(withRecords([entry])), /cannot clean extra recorded processes or paths/, label);
    }
    // A CPU block records no process at all.
    const cpu = structuredClone(w.run); cpu.target.execution.gpu = undefined; cpu.ownedProcesses = [record];
    assert.throws(() => validateProfile(cpu, { partial: true }));
});

// --- Amendment A5: a recorded display process does not make the GPU busy -------------------------
const displayRow = (pid, type = 'G', mib = 2, name = '/usr/bin/gnome-shell') => `<process_info><gpu_instance_id>N/A</gpu_instance_id><compute_instance_id>N/A</compute_instance_id><pid>${pid}</pid><type>${type}</type><process_name>${name}</process_name><used_memory>${mib} MiB</used_memory></process_info>`;
const GNOME = 2899;
const desktop = (extra = {}) => proc('/user.slice/user-1000.slice/session-2.scope', { startIdentity: '777', ...extra });
// A scripted gate whose first check is, or is not, the run's first (the recording one), over a host with a desktop.
function displayGate({ replies, procs = new Map([[GNOME, desktop()]]), record = true, tolerated = [] }) {
    const recorded = [];
    const scripted = scriptedGate({ replies, procs });
    void scripted;
    let call = 0;
    const host = { bootId: () => 'boot-1', observe: pid => (procs.has(pid) ? { bootId: 'boot-1', hostPid: pid, ...procs.get(pid) } : null) };
    const query = async () => { const reply = replies[Math.min(call, replies.length - 1)]; call += 1; return typeof reply === 'function' ? reply() : reply; };
    const gate = createGpuGate({ query, uuid: UUID, host, boxPrefix: '/box', expectedMemoryMiB: 6144, intervalMs: 3, retryMs: 1, recordTolerated: record, tolerated, onTolerate: entry => recorded.push(entry) });
    return { gate, procs, recorded, calls: () => call };
}
const withRows = (...rows) => smiOk(smiXml({ rows: rows.join('') }));
const GNOME_RECORD = { kind: 'gpu-tolerated', hostPid: GNOME, bootId: 'boot-1', startIdentity: '777', name: '/usr/bin/gnome-shell', type: 'G', memoryMiB: 2 };

test('A5.a-graphics-only-display-process-is-recorded-at-the-first-check-and-tolerated-after', async () => {
    const { gate, recorded } = displayGate({ replies: [withRows(displayRow(GNOME)), withRows(displayRow(GNOME)), withRows(displayRow(GNOME))] });
    const baseline = await gate.initial();
    assert.deepEqual(recorded, [GNOME_RECORD]); assert.ok(isToleratedRecord(recorded[0]));
    assert.deepEqual(baseline.tolerated, [GNOME_RECORD]);
    const checked = await gate.check('op');
    assert.deepEqual(checked.tolerated, [GNOME]); assert.deepEqual(checked.owned, []);
    await gate.check('op-2');
    // The tolerated set is in the evidence of every check.
    assert.ok(gate.history.every(entry => JSON.stringify(entry.tolerated) === `[${GNOME}]`), JSON.stringify(gate.history));
    assert.deepEqual(gate.summary().tolerated, [GNOME_RECORD]);
    // Free-memory checks use the actual free memory: the display's MiB is part of what nvidia-smi reports used.
    const small = displayGate({ replies: [withRows(displayRow(GNOME)), smiOk(smiXml({ rows: displayRow(GNOME), used: 5000 }))] });
    await small.gate.initial();
    await assert.rejects(small.gate.check('probe', { minFreeMiB: 2048 }), blockedWith('insufficient_free_memory'));
    // Exactly 64 MiB is within the limit: the single control.
    const edge = displayGate({ procs: new Map([[10, desktop()]]), replies: [withRows(displayRow(10, 'G', 64))] });
    await edge.gate.initial();
    assert.equal(edge.recorded.length, 1);
});

test('A5.a-recorded-display-process-is-blocked-when-it-gains-compute-grows-over-the-limit-or-its-pid-is-reused', async () => {
    const first = withRows(displayRow(GNOME));
    const cases = [
        ['it turns into C+G', withRows(displayRow(GNOME, 'C+G')), () => {}, 'type_changed'],
        ['it turns into C', withRows(displayRow(GNOME, 'C')), () => {}, 'type_changed'],
        ['it becomes an MPS client', withRows(displayRow(GNOME, 'M+C')), () => {}, 'type_changed'],
        ['it grows over 64 MiB', withRows(displayRow(GNOME, 'G', 65)), () => {}, 'memory_over_limit'],
        ['its PID is reused with another start identity', first, procs => procs.set(GNOME, desktop({ startIdentity: '9999' })), 'identity_changed'],
        ['its PID is reused after a reboot (another boot identity)', first, procs => procs.set(GNOME, { ...desktop(), bootId: 'boot-2' }), 'identity_changed'],
        ['its memory is no longer printed', smiOk(smiXml({ rows: displayRow(GNOME).replace('<used_memory>2 MiB</used_memory>', '<used_memory>N/A</used_memory>') })), () => {}, 'memory_over_limit'],
    ];
    for (const [label, later, mutate, why] of cases) {
        const { gate, procs } = displayGate({ replies: [first, later] });
        await gate.initial();
        mutate(procs);
        await assert.rejects(gate.check('op'), error => blockedWith('gpu_busy')(error) && error.gate.why === why && JSON.stringify(error.gate.foreign) === `[${GNOME}]`, label);
    }
    // Controls: the same process unchanged, and at exactly 64 MiB, still passes.
    const same = displayGate({ replies: [first, withRows(displayRow(GNOME, 'G', 64))] });
    await same.gate.initial();
    assert.deepEqual((await same.gate.check('op')).tolerated, [GNOME]);
});

test('A5.a-process-that-was-not-recorded-at-the-first-check-is-never-tolerated-later', async () => {
    const procs = new Map([[GNOME, desktop()], [3000, desktop({ startIdentity: '801' })]]);
    for (const [label, rows] of [['a new graphics process', [displayRow(GNOME), displayRow(3000)]], ['a new compute process', [displayRow(GNOME), displayRow(3000, 'C', 500)]]]) {
        const { gate } = displayGate({ procs, replies: [withRows(displayRow(GNOME)), withRows(...rows)] });
        await gate.initial();
        await assert.rejects(gate.check('op'), error => blockedWith('gpu_busy')(error) && JSON.stringify(error.gate.foreign) === '[3000]' && error.gate.why === 'not_recorded', label);
    }
    // A later action's initial check (no recording) tolerates only what the run recorded.
    const unrecorded = displayGate({ record: false, replies: [withRows(displayRow(GNOME))] });
    await assert.rejects(unrecorded.gate.initial(), blockedWith('gpu_busy'));
    const recordedOnly = displayGate({ record: false, tolerated: [GNOME_RECORD], replies: [withRows(displayRow(GNOME))] });
    assert.deepEqual((await recordedOnly.gate.initial()).tolerated, [GNOME_RECORD]);
    const another = displayGate({ record: false, tolerated: [GNOME_RECORD], procs, replies: [withRows(displayRow(GNOME), displayRow(3000))] });
    await assert.rejects(another.gate.initial(), blockedWith('gpu_busy'));
    // A gate that never records (the default) tolerates nothing: any listed process blocks, as in G1.
    const { gate } = scriptedGate({ replies: [smiOk(smiXml({ rows: displayRow(GNOME) }))], procs: new Map([[GNOME, desktop()]]) });
    await assert.rejects(gate.initial(), blockedWith('gpu_busy'));
});

test('A5.the-first-check-blocks-compute-an-oversized-or-unmeasured-process-a-second-graphics-process-and-an-unproven-identity', async () => {
    const two = new Map([[10, desktop({ startIdentity: '700' })], [11, desktop({ startIdentity: '701' })]]);
    const cases = [
        ['a compute process', [displayRow(GNOME, 'C')], undefined, 'gpu_busy'],
        ['an MPS server', [displayRow(GNOME, 'M+C')], undefined, 'gpu_busy'],
        ['compute and graphics', [displayRow(GNOME, 'C+G')], undefined, 'gpu_busy'],
        ['a display process over 64 MiB', [displayRow(GNOME, 'G', 65)], undefined, 'gpu_busy'],
        ['a display process whose memory is not printed', [displayRow(GNOME).replace('2 MiB', 'N/A')], undefined, 'gpu_busy'],
        ['a tolerable process beside a compute one', [displayRow(GNOME), displayRow(3000, 'C')], new Map([[GNOME, desktop()], [3000, desktop()]]), 'gpu_busy'],
        ['a second foreign graphics process', [displayRow(10), displayRow(11)], two, 'gpu_busy'],
        ['a display process whose host identity cannot be proved', [displayRow(GNOME)], new Map(), 'display_identity_unproved'],
    ];
    for (const [label, rows, procs, reason] of cases) {
        const { gate, recorded } = displayGate({ replies: [withRows(...rows)], ...(procs ? { procs } : {}) });
        await assert.rejects(gate.initial(), blockedWith(reason), label);
        assert.deepEqual(recorded, [], `${label}: nothing is recorded`);
        assert.equal(gate.baseline, null, label);
    }
    // An unparseable memory element is unsupported output, not a tolerated process.
    const bad = displayGate({ replies: [smiOk(smiXml({ rows: displayRow(GNOME).replace('2 MiB', '2 GiB') }))] });
    await assert.rejects(bad.gate.initial(), blockedWith('unsupported_output'));
});

test('A5.a-recorded-display-process-that-disappears-is-logged-and-never-fails', async () => {
    const { gate, procs } = displayGate({ replies: [withRows(displayRow(GNOME)), smiOk(smiXml()), withRows(displayRow(GNOME))] });
    await gate.initial();
    procs.delete(GNOME);
    const gone = await gate.check('gone');
    assert.deepEqual(gone.vanished, [GNOME]); assert.deepEqual(gone.tolerated, []);
    assert.deepEqual(gate.history.at(-1).vanished, [GNOME]);
    assert.deepEqual(gate.summary().vanishedTolerated, [GNOME]);
    // The same process (same identity) coming back is still the recorded one.
    procs.set(GNOME, desktop());
    assert.deepEqual((await gate.check('back')).tolerated, [GNOME]);
    // A different process that reuses the PID after it vanished is not.
    const reused = displayGate({ replies: [withRows(displayRow(GNOME)), smiOk(smiXml()), withRows(displayRow(GNOME))] });
    await reused.gate.initial(); reused.procs.delete(GNOME);
    await reused.gate.check('gone');
    reused.procs.set(GNOME, desktop({ startIdentity: '31337' }));
    await assert.rejects(reused.gate.check('reused'), error => blockedWith('gpu_busy')(error) && error.gate.why === 'identity_changed');
});

test('A5.owned-pid-exclusion-and-foreign-blocking-are-unchanged-beside-a-tolerated-process', async () => {
    const procs = new Map([
        [GNOME, desktop()],
        [900, proc('/box/ploinky/core', { startIdentity: '90' })], [901, proc('/box/ploinky/core', { startIdentity: '91', ppid: 900 })],
    ]);
    const mixed = withRows(displayRow(GNOME), displayRow(901, 'M+C', 300, 'nvidia-cuda-mps-server'));
    const { gate } = displayGate({ procs, replies: [withRows(displayRow(GNOME)), mixed, withRows(displayRow(GNOME), displayRow(901, 'M+C', 300), displayRow(777, 'C', 100))] });
    await gate.initial(); gate.registerDaemon(900);
    const both = await gate.check('server and desktop');
    assert.deepEqual(both.owned, [901]); assert.deepEqual(both.tolerated, [GNOME]);
    // The desktop never excuses a foreign compute process, and only that one is named.
    procs.set(777, desktop({ startIdentity: '900' }));
    await assert.rejects(gate.check('foreign'), error => blockedWith('gpu_busy')(error) && JSON.stringify(error.gate.foreign) === '[777]');
    // An owned PID without provenance still blocks.
    const bare = displayGate({ procs, replies: [withRows(displayRow(GNOME)), mixed] });
    await bare.gate.initial(); bare.gate.registerDaemon(900);
    procs.set(901, proc('/other-box/ploinky/core', { startIdentity: '91', ppid: 900 }));
    await assert.rejects(bare.gate.check('op'), blockedWith('gpu_busy'));
});

test('A5.provision-records-the-tolerated-set-in-the-run-manifest-and-the-live-cases-keep-to-it', async t => {
    const w = gpuWorld(t);
    w.fake.addDisplay(GNOME);
    const report = await w.provision();
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    assert.equal(w.run.toleratedProcesses.length, 1);
    const [record] = w.run.toleratedProcesses;
    assert.deepEqual([record.kind, record.hostPid, record.name, record.type, record.memoryMiB], ['gpu-tolerated', GNOME, '/usr/bin/gnome-shell', 'G', 2]);
    assert.match(record.bootId, /^[0-9a-f-]+$/); assert.match(record.startIdentity, /^[0-9]+$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(w.runPath, 'utf8')).toleratedProcesses, w.run.toleratedProcesses, 'the record is durable');
    assert.deepEqual(w.artifacts.get('gpu-initial-gate').tolerated, w.run.toleratedProcesses, 'the gate evidence states the recorded set');
    assert.doesNotThrow(() => validateProfile(w.run));
    const live = await liveCases(w, ['LIVE-P1', 'LIVE-P2']);
    assert.deepEqual(live.cases.slice(0, 2).map(entry => entry.result), ['pass', 'pass'], JSON.stringify(live.limitations));
    assert.deepEqual(w.artifacts.get('gpu-live-p1').gate.tolerated, w.run.toleratedProcesses, 'the case evidence states the tolerated set');
    assert.ok(w.artifacts.get('gpu-live-p1').gate.last.tolerated.includes(GNOME));
    // The desktop process is never signalled or touched.
    assert.equal(w.fake.model.signals.length, 0);
    assert.ok(w.fake.hostProc.observe(GNOME), 'the tolerated process is still there');
    assert.equal(live.cleanup.state, 'complete');
});

test('A5.a-tolerated-process-that-gains-compute-after-provisioning-blocks-the-live-run-and-a-compute-process-blocks-provisioning', async t => {
    const w = gpuWorld(t);
    w.fake.addDisplay(GNOME);
    assert.equal((await w.provision()).verdict, 'PASS');
    w.fake.model.foreign.find(entry => entry.pid === GNOME).type = 'C+G';
    const live = await liveCases(w, ['LIVE-P1']);
    assert.equal(caseOf(live, 'LIVE-P1').result, 'blocked', JSON.stringify(live.limitations));
    assert.match(live.limitations[0], /GPU idle gate blocked: gpu_busy/);
    // Provisioning with a foreign compute process, an oversized one or a second display process records nothing and creates nothing.
    for (const [label, setup] of [['compute', f => f.addDisplay(GNOME, { type: 'C' })], ['oversized', f => f.addDisplay(GNOME, { mib: 65 })], ['two', f => { f.addDisplay(GNOME); f.addDisplay(GNOME + 1); }]]) {
        const blockedWorld = gpuWorld(t);
        setup(blockedWorld.fake);
        const blockedReport = await blockedWorld.provision();
        assert.equal(blockedReport.verdict, 'BLOCKED', `${label}: ${JSON.stringify(blockedReport.limitations)}`);
        assert.deepEqual(blockedWorld.run.toleratedProcesses, [], label);
        assert.equal(exists(path.join(blockedWorld.remoteRoot, 'workspace')), false, label);
    }
});

test('A5.the-manifest-validates-the-tolerated-records-and-the-approval-summary-states-the-rule', async t => {
    const w = await provisioned(t);
    const withTolerated = entries => { const run = structuredClone(w.run); run.toleratedProcesses = entries; return run; };
    assert.doesNotThrow(() => validateProfile(withTolerated([GNOME_RECORD])));
    for (const [label, entries] of [
        ['a compute type', [{ ...GNOME_RECORD, type: 'C+G' }]], ['over the memory limit', [{ ...GNOME_RECORD, memoryMiB: 65 }]], ['a missing field', [(({ name, ...rest }) => rest)(GNOME_RECORD)]],
        ['an extra field', [{ ...GNOME_RECORD, extra: 1 }]], ['another kind', [{ ...GNOME_RECORD, kind: 'gpu-process' }]], ['a bare PID', [GNOME]],
        ['a duplicate PID', [GNOME_RECORD, GNOME_RECORD]], ['a second record', [GNOME_RECORD, { ...GNOME_RECORD, hostPid: GNOME + 1 }]],
    ]) assert.throws(() => validateProfile(withTolerated(entries)), /tolerated display process|Invalid tolerated|exceeds 1 entries/, label);
    const cpu = structuredClone(w.run); cpu.target.execution.gpu = undefined; cpu.toleratedProcesses = [GNOME_RECORD];
    assert.throws(() => validateProfile(cpu, { partial: true }));
    const summary = renderSummary(w.run, w.runPath);
    for (const text of ['amendment A5', 'one recorded display process', 'one foreign process', 'toleratedProcesses', 'type exactly `G`', 'at most 64 MiB', 'the only foreign process allowed is the recorded one', 'second foreign graphics process', 'never touches, signals or reprioritises']) assert.ok(summary.includes(text), text);
    assert.deepEqual(w.run.toleratedProcesses, [], 'the proposal records none: the first check does');
    // The notes of the plan and of the summary's operation table say what is enforced: one recorded display process, never four, never "must be empty".
    const gateNote = w.run.target.plan.provision.find(entry => entry.id === 'gpu-initial-gate').note;
    assert.ok(gateNote.includes('at most ONE recorded graphics-only (type G) display process of at most 64 MiB, present at this first check with a proven host identity') && !/at most 4|four/.test(gateNote), gateNote);
    assert.ok(summary.includes('except for at most one recorded graphics-only (type G) display process of at most 64 MiB, present at this first check with a proven identity (amendment A5)'));
    assert.equal(summary.includes('the process list must be empty)'), false); assert.equal(/at most 4 graphics|four display/.test(summary), false);
});

// --- Y2: the evidence a failed MPS case keeps before its Box is destroyed ---------------------------------------
const CAUSE = { step: 'daemon-start', errorClass: 'MpsError', code: 'gpu_sharing_unavailable', message: 'MPS daemon readiness failed at set defaults: MPS control failed (exit 1, stderr: cannot open log)' };
const FAILURE_PARTS = ['mps-state', 'mps-logs', 'router-logs', 'apply-response'];

test('Y2.a-failed-first-apply-keeps-the-mps-state-logs-router-tails-and-the-apply-response-before-cleanup', async t => {
    const w = await provisioned(t, { faults: { applyStatus: 409, applyBody: { ok: false, status: 409, error: 'apply_failed', results: [{ cause: CAUSE }] }, controlLogSecret: true, logApply: 'apply failed', lastProblem: { code: 'gpu_sharing_unavailable', message: 'MPS transition is incomplete', cause: CAUSE } } });
    const logs = path.join(w.run.target.execution.workspace.path, '.ploinky', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'router.log'), 'EARLIER router line\n'); fs.writeFileSync(path.join(logs, 'watchdog.log'), 'EARLIER watchdog line\n');
    const report = await liveCases(w, ['LIVE-P1']);
    assert.equal(caseOf(report, 'LIVE-P1').result, 'fail');
    for (const part of FAILURE_PARTS) assert.ok(w.artifacts.has(`gpu-live-p1-${part}`), `${part} is a run artifact`);
    assert.deepEqual(failureEvidenceNames('LIVE-P1'), FAILURE_PARTS.map(part => `gpu-live-p1-${part}`));
    // The MPS state, with the product's last problem and its cause.
    const state = w.artifacts.get('gpu-live-p1-mps-state');
    assert.equal(state.state.status, 'pending'); assert.deepEqual(state.state.lastProblem.cause, CAUSE); assert.equal(state.state.pendingClients[0].phase, 'pending');
    // The MPS logs: bounded, redacted.
    const mpsLogs = w.artifacts.get('gpu-live-p1-mps-logs');
    assert.equal(mpsLogs.unavailable, undefined);
    assert.deepEqual(mpsLogs.directories, []); // no daemon was ever started in this world
    // The Router and Watchdog tails cover the Apply window only, not what was there before.
    const routerLogs = w.artifacts.get('gpu-live-p1-router-logs');
    assert.equal(routerLogs.router.window, 'since-apply-start'); assert.match(routerLogs.router.text, /\[router\.log\] apply failed/); assert.equal(routerLogs.router.text.includes('EARLIER'), false);
    assert.match(routerLogs.watchdog.text, /\[watchdog\.log\] apply failed/); assert.equal(routerLogs.watchdog.text.includes('EARLIER'), false);
    // The Apply response, complete.
    const apply = w.artifacts.get('gpu-live-p1-apply-response').apply;
    assert.equal(apply.status, 409); assert.equal(JSON.parse(apply.response).results[0].cause.step, 'daemon-start'); assert.equal(apply.refs[0], 'hwlfixture/probe');
    // The case evidence names what was written, and it was written before the Box was destroyed.
    const caseEvidence = w.artifacts.get('gpu-live-p1');
    assert.deepEqual(caseEvidence.failureEvidence, { artifacts: failureEvidenceNames('LIVE-P1'), written: Object.fromEntries(FAILURE_PARTS.map(part => [part, 'written'])) });
    const calls = w.fake.model.calls;
    const captured = calls.findIndex(call => call.args.includes(MPS_FAILURE_EVIDENCE));
    const destroyed = calls.findIndex(call => call.args.includes('destroy'));
    assert.ok(captured >= 0 && destroyed > captured, `evidence ${captured} before destroy ${destroyed}`);
    nothingOwned(w);
});

test('Y2.the-daemons-logs-are-kept-redacted-and-bounded-when-a-daemon-exists', async t => {
    // P2 fails on its measurements, with the daemon up: its control and server logs are in the evidence.
    const w = await provisioned(t, { faults: { bypassCapped: true, controlLogSecret: true } });
    const report = await liveCases(w, ['LIVE-P1', 'LIVE-P2']);
    assert.deepEqual(report.cases.slice(0, 2).map(entry => entry.result), ['pass', 'fail']);
    const mpsLogs = w.artifacts.get('gpu-live-p2-mps-logs');
    assert.equal(mpsLogs.directories.length, 1);
    const [control, server] = mpsLogs.directories[0].files;
    assert.deepEqual([control.name, server.name], ['control.log', 'server.log']);
    assert.match(control.tail, /\[fake\] control log of /);
    assert.equal(control.tail.includes('abcdef123456'), false); assert.equal(control.tail.includes('ghijklmnopqrstu'), false);
    assert.match(control.tail, /token=\[redacted\]/);
    assert.equal(w.artifacts.get('gpu-live-p2-mps-state').state.status, 'ready');
    // A passing case writes no failure evidence.
    for (const part of FAILURE_PARTS) assert.equal(w.artifacts.has(`gpu-live-p1-${part}`), false);
    nothingOwned(w);
});

test('Y2.an-unreadable-source-is-recorded-as-unavailable-and-never-hides-the-failure', async t => {
    const w = await provisioned(t, { faults: { applyStatus: 409, evidenceProgramFails: true } });
    const report = await liveCases(w, ['LIVE-P1']);
    const entry = caseOf(report, 'LIVE-P1');
    assert.equal(entry.result, 'fail'); assert.match(entry.reason, /Apply of hwlfixture\/probe failed: 409/);
    assert.match(w.artifacts.get('gpu-live-p1-mps-state').unavailable, /./); assert.match(w.artifacts.get('gpu-live-p1-mps-logs').unavailable, /./);
    // No router.log exists in this workspace: recorded, not thrown.
    assert.match(w.artifacts.get('gpu-live-p1-router-logs').router.unavailable, /ENOENT/);
    assert.equal(w.artifacts.get('gpu-live-p1-apply-response').apply.status, 409);
    assert.deepEqual(Object.values(w.artifacts.get('gpu-live-p1').failureEvidence.written), ['written', 'written', 'written', 'written']);
    nothingOwned(w);
});

test('Y2.a-blocked-case-before-any-apply-says-so-and-a-failing-artifact-writer-is-recorded', async t => {
    const w = await provisioned(t, { faults: { gpuIneligible: true } });
    w.run.target.execution.cases = ['LIVE-P1'];
    const report = await w.live({ artifacts: (name, value) => { if (name === 'gpu-live-p1-mps-logs') throw new Error('disk full'); w.artifacts.set(name, structuredClone(value)); } });
    const entry = caseOf(report, 'LIVE-P1');
    assert.equal(entry.result, 'blocked');
    assert.deepEqual(w.artifacts.get('gpu-live-p1-apply-response').apply, undefined);
    assert.equal(w.artifacts.get('gpu-live-p1-apply-response').unavailable, 'no Apply was sent before the failure');
    assert.equal(w.artifacts.has('gpu-live-p1-mps-logs'), false);
    const written = w.artifacts.get('gpu-live-p1').failureEvidence.written;
    assert.match(written['mps-logs'].error, /disk full/);
    assert.deepEqual([written['mps-state'], written['router-logs'], written['apply-response']], ['written', 'written', 'written']);
    nothingOwned(w);
});

test('Y2.a-failed-or-blocked-mps-case-that-ran-requires-its-failure-evidence-and-a-missing-item-is-reported', () => {
    const profile = { gpu: { uuid: 'GPU-x' } };
    const remoteReport = { verdict: 'FAIL', cases: [
        { id: 'LIVE-P1', result: 'fail', evidence: {} }, { id: 'LIVE-P2', result: 'blocked', reason: 'Not selected or no completed enforcement evidence' },
        { id: 'LIVE-P3', result: 'blocked', evidence: { truncated: true } }, { id: 'LIVE-P4', result: 'pass', evidence: {} }, { id: 'LIVE-L1', result: 'fail', evidence: {} },
    ] };
    assert.deepEqual(requiredArtifacts({ profile, action: 'live', remoteReport }), [...failureEvidenceNames('LIVE-P1'), ...failureEvidenceNames('LIVE-P3')], 'only the cases that ran and failed or were blocked, only MPS cases');
    assert.deepEqual(requiredArtifacts({ profile, action: 'cleanup', remoteReport }), []);
    assert.deepEqual(requiredArtifacts({ profile: {}, action: 'live', remoteReport }), []);
    assert.deepEqual(requiredArtifacts({ profile, action: 'live', remoteReport: { verdict: 'PASS', cases: [{ id: 'LIVE-P1', result: 'pass' }] } }), ['gpu-live-p1'], 'a passing run still needs its case evidence only');
    // A failed run keeps its verdict and reports the missing evidence; a passing run with missing evidence is not certified.
    const missing = failureEvidenceNames('LIVE-P1');
    const failed = judgeArtifacts(remoteReport, { complete: false, missingRequired: missing, failures: [] });
    assert.equal(failed.verdict, 'FAIL'); assert.match(failed.limitations.join(' '), /Failure evidence is incomplete \(missing required gpu-live-p1-mps-state; missing required gpu-live-p1-mps-logs/);
    assert.deepEqual(judgeArtifacts(remoteReport, { complete: true, missingRequired: [], failures: [] }), remoteReport);
    const passed = judgeArtifacts({ verdict: 'PASS', exitCode: 0, cases: [] }, { complete: false, missingRequired: ['gpu-live-p1'], failures: [] });
    assert.equal(passed.verdict, 'BLOCKED');
});

test('Y2.the-failure-evidence-program-reads-state-last-problem-and-bounded-logs-read-only', async t => {
    const fake = fakeMpsHost(t, { pid: 777 });
    const state = JSON.parse(fs.readFileSync(path.join(fake.mps, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(fake.mps, 'state.json'), JSON.stringify({ ...state, status: 'pending', transitionId: 'tid', pendingClients: [{ key: 'k1', phase: 'launching', containerId: 'c'.repeat(64) }], drainedClients: ['x'],
        lastProblem: { code: 'gpu_sharing_unavailable', message: 'MPS transition is incomplete', cause: CAUSE } }), { mode: 0o600 });
    const log = path.join(fake.mps, `log-${'a'.repeat(32)}`);
    fs.writeFileSync(path.join(log, 'control.log'), `${'x'.repeat(10000)}\nTAIL control line\n`);
    fs.writeFileSync(path.join(log, 'server.log'), 'server line\n');
    fs.writeFileSync(path.join(log, 'weird name.log'), 'ignored\n');
    fs.mkdirSync(path.join(fake.mps, `log-${'b'.repeat(32)}`), { mode: 0o700 });
    fs.symlinkSync('/etc/hostname', path.join(log, 'linked.log'));
    const run = await runProgram(fake.localize(MPS_FAILURE_EVIDENCE), [], {});
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual([out.state.status, out.state.transitionId, out.state.pendingClients, out.state.drainedClients], ['pending', 'tid', [{ key: 'k1', phase: 'launching', containerId: 'c'.repeat(12) }], 1]);
    assert.deepEqual(out.state.lastProblem, { code: 'gpu_sharing_unavailable', message: 'MPS transition is incomplete', cause: CAUSE });
    assert.deepEqual([out.daemon.pid, out.daemon.alive, out.daemon.cgroup], [777, true, '0::/ploinky/core']);
    const files = Object.fromEntries(out.logs.flatMap(directory => directory.files.map(file => [`${path.basename(directory.directory)}/${file.name}`, file])));
    assert.match(files[`log-${'a'.repeat(32)}/control.log`].tail, /TAIL control line\n$/);
    assert.ok(files[`log-${'a'.repeat(32)}/control.log`].tail.length <= 6144, 'bounded to the last bytes');
    assert.equal(files[`log-${'a'.repeat(32)}/server.log`].tail, 'server line\n');
    assert.equal(Object.keys(files).some(name => /weird/.test(name)), false, 'only plainly named files');
    assert.ok(files[`log-${'a'.repeat(32)}/linked.log`].error, 'a symbolic link is never followed');
    assert.ok(out.entries.includes('state.json') && out.logs.length === 2);
    // Read-only: nothing was written or removed, and no control command ran.
    assert.deepEqual(fs.readdirSync(fake.mps).sort(), [`log-${'a'.repeat(32)}`, `log-${'b'.repeat(32)}`, `pipe-${'a'.repeat(32)}`, 'state.json'].sort());
    // No state at all: logs are still read from the owned log directories.
    fs.rmSync(path.join(fake.mps, 'state.json'));
    const bare = JSON.parse((await runProgram(fake.localize(MPS_FAILURE_EVIDENCE), [], {})).stdout);
    assert.equal(bare.state, null); assert.equal(bare.daemon, null); assert.equal(bare.logs.length, 2);
});

// --- Y4: every step of the cleanup order is journaled, run or skipped, never left out --------------------------
test('Y4.a-live-run-journals-the-helper-stop-and-the-identity-proof-in-the-plan-order', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1']);
    assert.equal(caseOf(report, 'LIVE-P1').result, 'pass', JSON.stringify(report.limitations)); assert.equal(w.run.cleanup.state, 'complete');
    assert.deepEqual(w.run.cleanup.steps.map(entry => [entry.id, entry.state]), [['gpu-stop-owned-helpers', 'complete'], ['revalidate-identity', 'complete'], ['destroy-box', 'complete'], ['host-records', 'complete'], ['workspace-removal', 'complete'], ['verify-absent', 'complete']]);
    const stop = w.run.cleanup.steps[0];
    assert.deepEqual([stop.helpers, stop.removed], [0, 0], 'no helper was registered, and the step says so');
    assert.deepEqual(w.run.target.plan.cleanup.map(entry => entry.id).slice(0, 3), ['gpu-stop-owned-helpers', 'revalidate-identity', 'destroy-box']);
    nothingOwned(w);
});

test('Y4.a-standalone-cleanup-journals-the-helper-stop-as-skipped-with-its-reason-and-still-proves-identity', async t => {
    const w = await provisioned(t);
    const report = await w.cleanup();
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    assert.deepEqual(w.run.cleanup.steps.map(entry => [entry.id, entry.state]), [['gpu-stop-owned-helpers', 'skipped'], ['revalidate-identity', 'complete'], ['destroy-box', 'complete'], ['host-records', 'complete'], ['workspace-removal', 'complete'], ['verify-absent', 'complete']]);
    assert.match(w.run.cleanup.steps[0].reason, /no helper is registered in this process; the nested containers go with the Box/);
    nothingOwned(w);
});

test('Y4.a-failed-identity-proof-stays-at-intent-and-nothing-after-it-runs', async t => {
    const w = await provisioned(t);
    w.run.target.execution.engine.identityDigest = hash('another engine service');
    const report = await w.cleanup();
    assert.equal(report.verdict, 'FAIL');
    assert.match(w.run.cleanup.failures.join(' '), /Engine service identity changed/);
    assert.deepEqual(w.run.cleanup.steps.map(entry => [entry.id, entry.state]), [['gpu-stop-owned-helpers', 'skipped'], ['revalidate-identity', 'intent']]);
    assert.equal(worldState(w.statePath).destroyCalls ?? 0, 0, 'the Box was not destroyed');
});

// W1: the runner classifies the SM reply with the product's grammar.
test('W1.the-runner-classifies-the-sm-reply-with-the-products-strict-decimal-grammar', () => {
    for (const [text, value] of [['25', 25], ['25.0', 25], ['25.00\n', 25], ['100.0', 100]]) assert.deepEqual(classifyMpsReply(text), { form: 'integer-percentage', value }, JSON.stringify(text));
    for (const text of ['25.5', '025', '0', '0.0', '101', '25.0.0', '25 %', '1e2']) assert.equal(classifyMpsReply(text).form, 'other', JSON.stringify(text));
});

// W2: a P1 pass keeps the daemon's own readback replies as the captured fixture.
test('W2.a-p1-pass-copies-the-journaled-readback-into-its-case-artifact', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1']);
    assert.equal(caseOf(report, 'LIVE-P1').result, 'pass', JSON.stringify(report.limitations));
    const readback = w.artifacts.get('gpu-live-p1').lastReadback;
    assert.deepEqual(Object.keys(readback).sort(), ['at', 'memory', 'servers', 'sm']);
    assert.match(readback.memory, /^[1-9]\d*[MG]$/); assert.equal(readback.sm, '25.0', 'the fake answers the SM default in the captured form'); 
    nothingOwned(w);
});

// --- W3: the image identity of a share client the product recreated from the immutable image ID --------------------
test('W3.a-share-client-recreated-by-image-id-passes-with-the-id-as-its-image-name', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1']);
    assert.equal(caseOf(report, 'LIVE-P1').result, 'pass', JSON.stringify(report.limitations).slice(0, 500));
    // The fake models the product: the recreated probe was created from the ID, so that is the name the engine reports.
    const probe = w.fake.model.agents.get('probe') ?? null;
    assert.ok(w.artifacts.get('gpu-live-p1').client.id);
    assert.equal(probe, null, 'the Box and its agents are gone after cleanup');
    nothingOwned(w);
});

test('W3.a-recreated-share-client-with-another-image-id-or-a-foreign-image-name-fails', async t => {
    for (const [label, faults, pattern] of [
        ['another image ID', { recreatedImageId: 'd'.repeat(64) }, /Agent probe is not the pinned running instance \(image d{12}, created from d{64}\)/],
        ['a foreign image name', { recreatedImageName: `docker.io/other/node@sha256:${'e'.repeat(64)}` }, /Agent probe is not the pinned running instance .*created from docker\.io\/other\/node@sha256:e+/],
    ]) {
        const w = await provisioned(t, { faults });
        const entry = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
        assert.equal(entry.result, 'fail', `${label}: ${JSON.stringify(entry).slice(0, 400)}`); assert.match(entry.reason, pattern, label);
        nothingOwned(w);
    }
});

test('W3.the-fixture-start-instance-must-still-be-created-from-the-digest-reference', async t => {
    // Before any recreate the strict check holds: an agent created from a different reference is not the pinned instance.
    const w = await provisioned(t);
    const profile = w.run.target.execution;
    profile.provision.image = `docker.io/assistos/ploinky-node@sha256:${'f'.repeat(64)}`;
    const entry = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
    assert.notEqual(entry.result, 'pass');
});

// F2: the immutable-ID half of the identity check. A recreated share client whose name is the digest reference (so the name
// half passes) but whose image ID is another image's must fail: the name alone never proves the instance.
test('F2.a-recreated-share-client-from-a-foreign-image-id-fails-even-when-its-name-is-the-digest-reference', async t => {
    const faults = { recreatedImageId: 'd'.repeat(64) };
    const w = await provisioned(t, { faults });
    // The name the engine reports is the pinned digest reference itself; only the ID is foreign.
    Object.defineProperty(faults, 'recreatedImageName', { get: () => w.fake.model.image, enumerable: true });
    const entry = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
    assert.equal(entry.result, 'fail', JSON.stringify(entry).slice(0, 400));
    assert.match(entry.reason, /Agent probe is not the pinned running instance \(image d{12}, created from docker\.io\/assistos\/ploinky-node@sha256:a+\)/);
    nothingOwned(w);
});

// --- V3: the runner expects the product's whole-GiB server default; each client keeps its exact share ---------------
test('V3.p1-expects-the-rounded-default-and-the-exact-client-share', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1']);
    const p1 = caseOf(report, 'LIVE-P1');
    assert.equal(p1.result, 'pass', JSON.stringify(p1).slice(0, 600));
    const e = p1.evidence;
    assert.deepEqual(e.expectedDefault, { shareMiB: 1044, defaultMiB: 2048 });
    assert.deepEqual(e.applied.gpu.serverDefault, { smPercent: 25, vramMiB: 2048, shareMemoryMiB: 1044 });
    // The daemon's readback is the captured form: a whole GiB, 2G; the client environment stays the exact 1044M.
    assert.match(e.lastReadback.memory, /^2G$/);
    assert.deepEqual(e.readbackForms.memory, { form: 'integer-with-M-or-G', bytes: 2048 * 1048576 });
    assert.ok(e.client.env.includes('CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=1044M'), JSON.stringify(e.client.env));
    nothingOwned(w);
});

test('V3.p1-fails-when-the-daemon-default-is-the-raw-share-instead-of-the-rounded-value', async t => {
    const w = await provisioned(t, { faults: { rawServerDefault: true } });
    const entry = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
    assert.equal(entry.result, 'fail', JSON.stringify(entry).slice(0, 400));
    assert.match(entry.reason, /not ready with the saved defaults 25%\/2048M for a 1044M share/);
    nothingOwned(w);
});

test('V3.p3-raising-the-share-changes-the-default-from-2-to-3-gib-and-drains-before-the-quit', async t => {
    const w = await provisioned(t);
    const p3 = caseOf(await liveCases(w, ['LIVE-P3']), 'LIVE-P3');
    assert.equal(p3.result, 'pass', JSON.stringify(p3).slice(0, 600));
    assert.deepEqual(p3.evidence.expectedDefaults, { first: 2048, raised: 3072 });
    assert.equal(p3.evidence.defaultChange.new.serverDefault.vramMiB, 3072);
    assert.equal(p3.evidence.defaultChangeTimeline.violation, null); assert.equal(p3.evidence.defaultChangeTimeline.daemonGone, true);
    nothingOwned(w);
});

test('V3.p4-the-reconciled-daemon-carries-the-rounded-default', async t => {
    const w = await provisioned(t);
    const p4 = caseOf(await liveCases(w, ['LIVE-P4']), 'LIVE-P4');
    assert.equal(p4.result, 'pass', JSON.stringify(p4).slice(0, 600));
    assert.equal(p4.evidence.reconciled.serverDefault.vramMiB, 2048);
    assert.equal(p4.evidence.reconciled.readbacks['get_default_device_pinned_mem_limit 0'], '2G');
    nothingOwned(w);
});

test('V3.p2-still-passes-when-the-driver-truncates-a-client-value-to-a-whole-gib', async t => {
    // P2 uses the client's own cap; low = max(128, cap - 640) = 404 MiB. A 1044M value applied as 1024M still allocates inside it.
    const w = await provisioned(t, { faults: { truncateClientCap: true } });
    const p2 = caseOf(await liveCases(w, ['LIVE-P2']), 'LIVE-P2');
    assert.equal(p2.result, 'pass', JSON.stringify(p2).slice(0, 600));
    const share = p2.evidence.measurements?.share ?? p2.evidence.rounding;
    assert.ok(p2.evidence.rounding.capMiB === 1044 && p2.evidence.rounding.shareAllocatedMiB >= 404 && p2.evidence.rounding.shareAllocatedMiB <= 1024, JSON.stringify(share).slice(0, 300));
    nothingOwned(w);
});

// --- U3: the fakes model the targeted drain of a fixture agent -----------------------------------------------------------
test('U3.the-compliant-fixture-agent-drains-with-exit-zero-and-the-recreate-proceeds', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1']);
    const p1 = caseOf(report, 'LIVE-P1');
    assert.equal(p1.result, 'pass', JSON.stringify(p1).slice(0, 500));
    // The exit code the drain saw is the one measured from the manifest's own agent command, run as a real process.
    assert.deepEqual(w.fake.model.drainExits, { probe: 0, peer: 0, cpu: 0 });
    nothingOwned(w);
});

test('U3.a-fixture-agent-that-dies-on-sigterm-fails-apply-at-client-launch-with-the-targeted-drain-refusal', async t => {
    // The previous fixture command has no signal handler: SIGTERM kills it (143) and the product refuses removal and recreate.
    const w = await provisioned(t, { faults: { base: { fixtureAgentCommand: 'node -e "setInterval(()=>{},3600000)"' } } });
    const report = await liveCases(w, ['LIVE-P1']);
    const p1 = caseOf(report, 'LIVE-P1');
    assert.equal(p1.result, 'fail', JSON.stringify(p1).slice(0, 500));
    assert.match(p1.reason, /Apply of hwlfixture\/probe failed: 409/);
    assert.match(p1.reason, /TARGETED_DRAIN_FAILED/); assert.match(p1.reason, /did not exit cleanly \(exit=143\); refusing removal or recreate/);
    assert.deepEqual(w.fake.model.drainExits, { probe: 143, peer: 143, cpu: 143 });
    assert.equal(report.verdict, 'FAIL');
    nothingOwned(w);
});

// --- R12-c(i): the case reason of a failed Apply leads with its parsed cause --------------------------------------------
test('R12c.a-failed-apply-reason-carries-the-parsed-cause-before-the-cut-response-text', async t => {
    // The response puts 600 characters before its cause: the 400-character cut of the text alone would lose the cause.
    const w = await provisioned(t, { faults: { base: { fixtureAgentCommand: 'node -e "setInterval(()=>{},3600000)"' }, applyBodyPadding: 600 } });
    const p1 = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
    assert.equal(p1.result, 'fail', JSON.stringify(p1).slice(0, 300));
    assert.match(p1.reason, /^Apply of hwlfixture\/probe failed: 409 \(client-launch: Error \(TARGETED_DRAIN_FAILED\): targeted drain for '[^']+' did not exit cleanly \(exit=143\); refusing removal or recreate\) /);
    assert.equal(p1.reason.includes('"cause"'), false, 'the cause was cut out of the text, so only the parsed form carries it');
    nothingOwned(w);
});

test('R12c.the-fake-daemon-answers-the-sm-default-in-the-captured-form-and-the-runner-accepts-it', async t => {
    const w = await provisioned(t);
    const p1 = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
    assert.equal(p1.result, 'pass', JSON.stringify(p1).slice(0, 300));
    const replies = Object.fromEntries(p1.evidence.daemon.controlReplies.map(reply => [reply.command, reply.stdout]));
    assert.equal(replies.get_default_active_thread_percentage, '25.0\n'); assert.equal(replies['get_default_device_pinned_mem_limit 0'], '2G\n');
    assert.deepEqual(p1.evidence.readbackForms.sm, { form: 'integer-percentage', value: 25 });
    nothingOwned(w);
});

// --- P3R: every candidate CLI argv of the runner is accepted by the candidate's real outer parser ---------------------------
test('P3R.the-candidate-parser-refuses-ports-before-restart-as-live-attempt-7-saw-and-accepts-them-before-start', () => {
    assert.equal(candidateArgvProblem(['/x/ploinky-box/bin/ploinky-box.mjs', '--port', '23456', '--udp-port', '34567', 'restart', 'hwlfixture/probe']), '--port is valid only before start, diagnose, or repair');
    assert.equal(candidateArgvProblem(['/x/ploinky-box/bin/ploinky-box.mjs', '--udp-port', '34567', 'restart', 'a/b']), '--udp-port is valid only before start, diagnose, or repair');
    assert.equal(candidateArgvProblem(['/x/ploinky-box/bin/ploinky-box.mjs', '--port', '23456', '--udp-port', '34567', 'start', 'hwlfixture/probe']), null);
    assert.equal(candidateArgvProblem(['/usr/bin/podman', '--port', '1', 'restart']), null, 'only the candidate CLI is judged');
});

test('P3R.every-candidate-argv-of-the-apparatus-mps-manifest-and-of-its-cases-is-accepted-and-restart-carries-no-port', async t => {
    const w = await provisioned(t);
    const operations = candidateOperationsOf(w.run);
    const ids = operations.map(operation => operation.id);
    for (const id of ['gpu-grant', 'fixture-start', 'destroy-box', 'P3-host-clear', 'P3-restart-agent']) assert.ok(ids.includes(id), `${id} in ${ids}`);
    for (const operation of operations) assert.equal(candidateArgvProblem(operation.argv), null, `${operation.id}: ${operation.argv.join(' ')}`);
    assert.deepEqual(operations.find(operation => operation.id === 'P3-restart-agent').argv.slice(1), ['restart', 'hwlfixture/probe']);
    // The case code: every candidate command the run really issued went through the fake's use of the real parser.
    const report = await liveCases(w, ['LIVE-P1', 'LIVE-P2', 'LIVE-P3', 'LIVE-P4']);
    assert.deepEqual(report.cases.map(entry => entry.result), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(report.limitations).slice(0, 300));
    const issued = w.fake.model.calls.filter(call => isCandidateArgv(call.args)).map(call => call.args);
    for (const argv of issued) assert.equal(candidateArgvProblem(argv), null, argv.join(' '));
    assert.ok(issued.some(argv => argv.includes('restart')) && issued.some(argv => argv.includes('limits')) && issued.some(argv => argv.includes('grant')) && issued.some(argv => argv.includes('start')) && issued.some(argv => argv.includes('destroy')));
    assert.deepEqual(issued.find(argv => argv.includes('restart')).slice(1), ['restart', 'hwlfixture/probe']);
    nothingOwned(w);
});

test('P3R.a-runner-argv-with-ports-before-restart-fails-an-offline-p3-as-attempt-7-did', async t => {
    // The fake's candidate refuses it with the parser's own message and exit 1, so P3 cannot pass with such an argv.
    const w = await provisioned(t);
    const candidate = w.run.target.execution.candidate.path;
    const refused = await w.fake.provider(w.run.target.execution.node.path, [candidate, '--port', '23456', '--udp-port', '34567', 'restart', 'hwlfixture/probe'], { cwd: w.run.target.execution.workspace.path, env: { HOME: w.home } });
    assert.deepEqual([refused.status, refused.stderr], [1, 'ploinky: --port is valid only before start, diagnose, or repair']);
    assert.equal((await w.cleanup()).verdict, 'PASS');
    nothingOwned(w);
});

// --- P3R-4: the evidence records the basis of each recreate's drain acknowledgement ---------------------------------------
test('P3R.p1-and-p3-record-the-drain-acknowledgement-basis-for-every-apply-and-the-restart', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P1', 'LIVE-P3']);
    assert.deepEqual(['LIVE-P1', 'LIVE-P3'].map(id => caseOf(report, id).result), ['pass', 'pass'], JSON.stringify(report.limitations).slice(0, 300));
    const basis = { exitStatus: 'not exposed by the product', basis: 'running-before-and-applied-implies-assertCleanTermination-passed (exit 0)', source: 'cli/sandbox/docker/targetedContainerLifecycle.js:107-122' };
    const p1 = w.artifacts.get('gpu-live-p1').drainAcknowledgements;
    assert.equal(p1.length, 1);
    // Only the probe was replaced; the peer kept its container and is not credited with a drain it never had.
    assert.deepEqual({ ...p1[0], clientsBefore: p1[0].clientsBefore.map(entry => [entry.role, entry.running]), clients: p1[0].clients.map(entry => [entry.role, entry.outcome]) },
        { label: 'p1', refs: ['hwlfixture/probe'], applyStatus: 200, results: [{ state: 'applied' }], expanded: 0, clientsBefore: [['probe', true], ['peer', true]], clients: [['probe', 'replaced'], ['peer', 'unchanged']], acknowledged: ['probe'], unchanged: ['peer'], notAcknowledged: [], ...basis });
    const p3 = w.artifacts.get('gpu-live-p3');
    assert.ok(p3.drainAcknowledgements.length >= 5, JSON.stringify(p3.drainAcknowledgements.map(entry => entry.label)));
    assert.ok(p3.drainAcknowledgements.every(entry => entry.applyStatus === 200 && entry.results.every(result => result.state === 'applied') && entry.basis === basis.basis && entry.source === basis.source && Array.isArray(entry.clientsBefore)));
    assert.deepEqual(p3.restartDrainAcknowledgement, { command: 'restart', acknowledged: true, ...basis });
    nothingOwned(w);
    // A refused drain is a failed Apply: no acknowledgement is recorded for it.
    const refused = await provisioned(t, { faults: { base: { fixtureAgentCommand: 'node -e "setInterval(()=>{},3600000)"' } } });
    await liveCases(refused, ['LIVE-P1']);
    assert.equal(refused.artifacts.get('gpu-live-p1').drainAcknowledgements, undefined);
    nothingOwned(refused);
});

// --- R12-c(iv): the runner assertions on the whole-GiB default that no test could fail -------------------------------------
test('R12c.p1-fails-when-the-status-names-another-share-than-the-one-the-default-came-from', async t => {
    const w = await provisioned(t, { faults: { statusShareMiB: 999 } });
    const entry = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
    assert.equal(entry.result, 'fail', JSON.stringify(entry).slice(0, 300));
    assert.match(entry.reason, /The status names 999 MiB as the share the default came from, not 1044/);
    nothingOwned(w);
});

test('R12c.p3-fails-when-the-first-default-is-not-the-rounded-value-and-when-the-raised-share-does-not-change-the-default', async t => {
    // The first default is the raw share instead of the rounded one.
    const raw = await provisioned(t, { faults: { rawServerDefault: true } });
    const rawCase = caseOf(await liveCases(raw, ['LIVE-P3']), 'LIVE-P3');
    assert.equal(rawCase.result, 'fail', JSON.stringify(rawCase).slice(0, 300));
    assert.match(rawCase.reason, /The first default is 1044 MiB, not 2048/);
    nothingOwned(raw);
    // On a 3012-MiB device the 17% (512 MiB) and 34% (1024 MiB) shares round to the same 1 GiB default, so the default-change case cannot run.
    const same = await provisioned(t, { gpuOverrides: { memoryMiB: 3012 } });
    const sameCase = caseOf(await liveCases(same, ['LIVE-P3']), 'LIVE-P3');
    assert.equal(sameCase.result, 'fail', JSON.stringify(sameCase).slice(0, 300));
    assert.match(sameCase.reason, /The raised share does not change the server default \(1024 MiB for both\)/);
    assert.deepEqual(same.artifacts.get('gpu-live-p3').expectedDefaults, { first: 1024, raised: 1024 });
    nothingOwned(same);
});

// --- M-EVID-03: a restart that did not succeed never records a drain acknowledgement --------------------------------------
test('M-EVID-03.a-restart-that-fails-times-out-or-cannot-spawn-records-its-real-outcome-and-no-acknowledgement', async t => {
    for (const [label, restartResult, expected] of [
        ['a nonzero exit', { status: 1, stderr: 'ploinky: synthetic pre-action refusal' }, { status: 1, signal: null, timedOut: false, transportError: null, stderr: 'ploinky: synthetic pre-action refusal' }],
        ['a timeout', { status: null, signal: 'SIGKILL', timedOut: true }, { status: null, signal: 'SIGKILL', timedOut: true, transportError: null, stderr: '' }],
        ['a spawn error', { status: null, errorCode: 'ENOENT' }, { status: null, signal: null, timedOut: false, transportError: 'ENOENT', stderr: '' }],
    ]) {
        const w = await provisioned(t, { faults: { restartResult } });
        const p3 = caseOf(await liveCases(w, ['LIVE-P3']), 'LIVE-P3');
        assert.equal(p3.result, 'fail', `${label}: ${JSON.stringify(p3).slice(0, 300)}`);
        const record = w.artifacts.get('gpu-live-p3').restartDrainAcknowledgement;
        assert.deepEqual(record, { command: 'restart', acknowledged: false, outcome: expected }, label);
        assert.equal(JSON.stringify(record).includes('assertCleanTermination'), false, `${label}: no acknowledgement basis is claimed`);
        nothingOwned(w);
    }
    // The positive control: a successful restart carries the acknowledgement and the basis.
    const ok = await provisioned(t);
    const p3 = caseOf(await liveCases(ok, ['LIVE-P3']), 'LIVE-P3');
    assert.equal(p3.result, 'pass', JSON.stringify(p3).slice(0, 300));
    const record = ok.artifacts.get('gpu-live-p3').restartDrainAcknowledgement;
    assert.equal(record.acknowledged, true); assert.match(record.basis, /assertCleanTermination/);
    nothingOwned(ok);
});

// --- R14-b: a failed captured command carries its cause in the case reason ------------------------------------------------------
test('R14b.a-failed-host-clear-restart-or-kill-reports-its-exit-timeout-or-error-and-stderr-in-the-case-reason', async t => {
    const failures = [
        ['a nonzero exit', { status: 1, stderr: 'ploinky: synthetic pre-action refusal' }, /\bfailed \(exit 1\): ploinky: synthetic pre-action refusal/],
        ['a timeout', { status: null, signal: 'SIGKILL', timedOut: true }, /\bfailed \(timed out, killed by SIGKILL\)/],
        ['a transport error', { status: null, errorCode: 'ENOENT' }, /\bfailed \(error ENOENT\)/],
    ];
    for (const [command, fault, id] of [['gpu-host-clear', 'limitsClearResult', 'P3'], ['gpu-restart', 'restartResult', 'P3'], ['gpu-kill-owned-daemon', 'killResult', 'P3']]) {
        for (const [label, result, pattern] of failures) {
            const w = await provisioned(t, { faults: { [fault]: result } });
            const entry = caseOf(await liveCases(w, ['LIVE-P3']), `LIVE-${id}`);
            assert.equal(entry.result, 'fail', `${command} ${label}: ${JSON.stringify(entry).slice(0, 300)}`);
            assert.match(entry.reason, new RegExp(`^${command} ${pattern.source}`), `${command} ${label}: ${entry.reason}`);
            assert.equal(/returned incomplete output/.test(entry.reason), false, 'not the generic transport message');
            nothingOwned(w);
        }
    }
});

// --- R14-c: a client that was not running is never recorded as acknowledged --------------------------------------------------
test('R14c.a-client-that-was-not-running-before-the-apply-is-never-recorded-as-acknowledged', async t => {
    // The probe stops by itself between its save and the Apply: the drain never reached a running container.
    const stopped = await provisioned(t, { faults: { stopOnSave: 'probe' } });
    const report = await liveCases(stopped, ['LIVE-P1']);
    const p1 = caseOf(report, 'LIVE-P1');
    assert.equal(p1.result, 'pass', JSON.stringify(p1).slice(0, 300));
    const [entry] = stopped.artifacts.get('gpu-live-p1').drainAcknowledgements;
    assert.deepEqual(entry.clientsBefore.map(client => [client.role, client.running]), [['probe', false], ['peer', true]]);
    assert.deepEqual([entry.acknowledged, entry.unchanged, entry.notAcknowledged], [[], ['peer'], [{ role: 'probe', outcome: 'replaced-not-running-before' }]], 'the stopped probe is replaced but never recorded as exit-0 acknowledged');
    nothingOwned(stopped);
    // The control: every client was running, so every client is acknowledged by observation.
    const running = await provisioned(t);
    await liveCases(running, ['LIVE-P1']);
    const [control] = running.artifacts.get('gpu-live-p1').drainAcknowledgements;
    assert.deepEqual([control.acknowledged, control.unchanged, control.notAcknowledged], [['probe'], ['peer'], []]);
    nothingOwned(running);
});

// --- S3: the immediate status read is the acceptance; a later convergence is only diagnosed, and the truth is captured ---------
test('S3.a-status-that-is-stale-right-after-the-apply-fails-the-case-and-records-that-it-settled-later-and-what-the-container-was', async t => {
    // The status keeps showing the recreated probe as stopped for 300 ms: the immediate read is stale, a later one is not.
    const w = await provisioned(t, { faults: { statusLagMs: 300 } });
    const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: { convergenceMs: 5000, convergencePollMs: 10 } }), 'LIVE-P1');
    assert.equal(p1.result, 'fail', JSON.stringify(p1).slice(0, 400));
    // The lag renders as the product's S1 does (starting and applied) and the Apply says its status is not fresh.
    assert.match(p1.reason, /^The status was not settled right after the Apply of hwlfixture\/probe \(the Apply did not report a fresh status \(statusFresh is not true: the status may predate it\); hwlfixture\/probe: availability starting/);
    assert.match(p1.reason, /it settled \d+ ms later, which is a lagging status and not an acceptance/);
    const unsettled = w.artifacts.get('gpu-live-p1').statusUnsettled;
    assert.equal(unsettled.convergence.converged, true); assert.ok(unsettled.convergence.afterMs > 0 && unsettled.convergence.afterMs < 5000);
    assert.deepEqual([unsettled.immediate[0].availability, unsettled.immediate[0].limitsState, unsettled.last[0].availability, unsettled.last[0].limitsState], ['starting', 'applied', 'ready', 'applied']);
    assert.deepEqual([unsettled.statusFresh, unsettled.statusWaitMs], [false, 12]); assert.match(unsettled.readStartedAt, /^\d{4}-\d\d-\d\dT/); assert.equal('metricsSampledAt' in unsettled, false);
    // The container's own state, read-only: running, so the lag was the status.
    assert.deepEqual([unsettled.containers[0].state.running, unsettled.containers[0].state.status, unsettled.containers[0].state.exitCode, unsettled.containers[0].state.oomKilled], [true, 'running', 0, false]);
    assert.match(unsettled.containers[0].state.id, /^[a-f0-9]{64}$/); assert.ok('startedAt' in unsettled.containers[0].state && 'finishedAt' in unsettled.containers[0].state);
    nothingOwned(w);
});

test('S3.a-container-that-really-stopped-fails-with-its-exit-code-and-its-log-tail', async t => {
    const w = await provisioned(t, { faults: { stopAfterApply: 'probe', stopOomKilled: true, containerLogs: 'serving\nOut of memory: Killed process 7 (python3) token=synthetic-secret-value\n' } });
    const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: { convergenceMs: 150, convergencePollMs: 10 } }), 'LIVE-P1');
    assert.equal(p1.result, 'fail', JSON.stringify(p1).slice(0, 400));
    assert.match(p1.reason, /it did not settle within 150 ms \(\d+ poll\(s\) in a window of \d+ ms\); the container: hwlfixture\/probe exited exit 137 oom-killed/);
    const unsettled = w.artifacts.get('gpu-live-p1').statusUnsettled;
    assert.equal(unsettled.convergence.converged, false); assert.equal(unsettled.convergence.afterMs, null);
    const [container] = unsettled.containers;
    assert.deepEqual([container.state.running, container.state.status, container.state.exitCode, container.state.oomKilled], [false, 'exited', 137, true]);
    assert.match(container.state.finishedAt, /^\d{4}-/);
    // The log tail is bounded and redacted like every other capture.
    assert.match(container.logsTail, /Out of memory: Killed process 7/); assert.equal(container.logsTail.includes('synthetic-secret-value'), false);
    nothingOwned(w);
});

test('S3.a-fresh-immediate-status-passes-and-records-nothing-unsettled', async t => {
    const w = await provisioned(t);
    const p1 = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
    assert.equal(p1.result, 'pass', JSON.stringify(p1).slice(0, 300));
    assert.equal(w.artifacts.get('gpu-live-p1').statusUnsettled, undefined);
    nothingOwned(w);
});

// --- S5: only a client this Apply REPLACED, and that was running right before it, is acknowledged -----------------------------------
test('S5.drain-acknowledgement-follows-the-containers-that-were-replaced-an-unchanged-peer-a-one-client-change-an-expanded-cohort-and-a-stopped-client', async t => {
    const w = await provisioned(t);
    const report = await liveCases(w, ['LIVE-P3']);
    assert.equal(caseOf(report, 'LIVE-P3').result, 'pass', JSON.stringify(caseOf(report, 'LIVE-P3')).slice(0, 300));
    const byLabel = Object.fromEntries(w.artifacts.get('gpu-live-p3').drainAcknowledgements.map(entry => [entry.label, entry]));
    const outcomes = entry => Object.fromEntries(entry.clients.map(client => [client.role, client.outcome]));
    // The first share is the probe's alone: the peer keeps its container.
    assert.deepEqual([byLabel['p3-probe'].acknowledged, byLabel['p3-probe'].unchanged], [['probe'], ['peer']]);
    // P3 A: the peer's own share changes under the same default; only the peer is replaced, and only the peer is acknowledged.
    assert.deepEqual(outcomes(byLabel['p3-peer']), { probe: 'unchanged', peer: 'replaced' });
    assert.deepEqual([byLabel['p3-peer'].acknowledged, byLabel['p3-peer'].unchanged], [['peer'], ['probe']]);
    // P3 B: a default change expands the cohort beyond the requested probe; both clients were replaced and both are acknowledged.
    assert.deepEqual(outcomes(byLabel['p3-default']), { probe: 'replaced', peer: 'replaced' });
    assert.deepEqual(byLabel['p3-default'].acknowledged, ['probe', 'peer']); assert.equal(byLabel['p3-default'].expanded, 1);
    assert.deepEqual(byLabel['p3-default'].unchanged, []);
    // Every acknowledged client has a different container before and after, and every unchanged one the same.
    for (const entry of Object.values(byLabel)) for (const client of entry.clients) assert.equal(client.outcome === 'unchanged', client.before.id === client.after.id, `${entry.label} ${client.role}`);
    nothingOwned(w);
});

test('S5.a-replaced-client-the-response-does-not-name-is-not-acknowledged', async t => {
    // The response names no key at all: a replacement it does not report cannot be credited with the product's drain.
    const w = await provisioned(t, { faults: { applyUnreported: true } });
    const p1 = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
    assert.equal(p1.result, 'pass', JSON.stringify(p1).slice(0, 300));
    const [entry] = w.artifacts.get('gpu-live-p1').drainAcknowledgements;
    assert.deepEqual([entry.acknowledged, entry.notAcknowledged], [[], [{ role: 'probe', outcome: 'replaced-unreported' }]]);
    nothingOwned(w);
});

// --- M-EVID-05: whatever the diagnostic phase meets, the verdict is the immediate FAIL and the evidence survives ----------------
const STOPPED = { stopAfterApply: 'probe', stopOomKilled: true };
const QUICK_POLL = { convergenceMs: 200, convergencePollMs: 10 };
test('E5.a-diagnostic-poll-that-fails-never-turns-the-immediate-fail-into-a-block-and-the-evidence-survives', async t => {
    for (const [label, mode, pattern] of [['a nonzero exit', 'exit', /administrator channel did not answer \(exit 1\)/], ['a timeout', 'timeout', /administrator channel did not answer \(exit null\)/], ['malformed JSON', 'malformed', /administrator channel did not answer \(exit 0\)/]]) {
        const w = await provisioned(t, { faults: { ...STOPPED, diagnosticGetFault: mode } });
        const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: QUICK_POLL }), 'LIVE-P1');
        assert.equal(p1.result, 'fail', `${label}: ${JSON.stringify(p1).slice(0, 300)}`);
        assert.match(p1.reason, /^The status was not settled right after the Apply of hwlfixture\/probe \(hwlfixture\/probe: availability stopped; hwlfixture\/probe: limitsState unavailable;/, label);
        const record = w.artifacts.get('gpu-live-p1').statusUnsettled;
        assert.equal(record.phase, 'complete', label);
        assert.ok(record.convergence.pollErrors.length >= 1 && pattern.test(record.convergence.pollErrors[0].message), `${label}: ${JSON.stringify(record.convergence.pollErrors[0])}`);
        assert.equal(record.convergence.converged, false);
        // Both moments are captured: right after the immediate failure, and after the watching.
        for (const captured of [record.containers, record.containersAfterPoll]) {
            assert.equal(captured.length, 1, label);
            assert.deepEqual([captured[0].state.running, captured[0].state.exitCode, captured[0].state.oomKilled, captured[0].stateError, captured[0].logsError], [false, 137, true, null, null], label);
            assert.match(captured[0].logsTail, /agent started/, label);
        }
        assert.deepEqual(record.immediate.map(entry => [entry.availability, entry.limitsState]), [['stopped', 'unavailable']]);
        nothingOwned(w);
    }
});

test('E5.a-lagging-status-whose-first-diagnostic-poll-fails-is-still-diagnosed-as-settling-later', async t => {
    const w = await provisioned(t, { faults: { statusLagMs: 300, diagnosticGetFault: 'exit' } });
    const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: { convergenceMs: 5000, convergencePollMs: 10 } }), 'LIVE-P1');
    assert.equal(p1.result, 'fail', JSON.stringify(p1).slice(0, 300));
    const record = w.artifacts.get('gpu-live-p1').statusUnsettled;
    assert.ok(record.convergence.pollErrors.length >= 1);
    assert.equal(record.convergence.converged, true); assert.match(p1.reason, /it settled \d+ ms later, which is a lagging status and not an acceptance/);
    assert.equal(record.containers[0].state.running, true);
    nothingOwned(w);
});

test('E5.a-failed-inspect-or-failed-logs-or-both-leave-the-partial-evidence-and-the-errors-and-still-fail', async t => {
    const cases = [
        ['inspect fails, logs succeed', { truthInspectResult: { status: 1, stderr: 'Error: inspect synthetic failure' } }, entry => entry.state === null && /exit 1: Error: inspect synthetic failure/.test(entry.stateError) && /agent started/.test(entry.logsTail) && entry.logsError === null],
        ['logs fail, inspect succeeds', { truthLogsResult: { status: null, signal: 'SIGKILL', timedOut: true } }, entry => entry.state?.exitCode === 137 && entry.stateError === null && entry.logsTail === null && /timed out, killed by SIGKILL/.test(entry.logsError)],
        ['both fail', { truthInspectResult: { status: 125, stderr: 'Error: no such container' }, truthLogsResult: { status: 1, stderr: 'Error: logs synthetic failure' } }, entry => entry.state === null && /exit 125/.test(entry.stateError) && entry.logsTrusted === false && /exit 1: Error: logs synthetic failure/.test(entry.logsError)],
    ];
    for (const [label, faults, check] of cases) {
        const w = await provisioned(t, { faults: { ...STOPPED, ...faults } });
        const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: QUICK_POLL }), 'LIVE-P1');
        assert.equal(p1.result, 'fail', `${label}: ${JSON.stringify(p1).slice(0, 300)}`);
        assert.match(p1.reason, /^The status was not settled right after the Apply of hwlfixture\/probe/, label);
        const record = w.artifacts.get('gpu-live-p1').statusUnsettled;
        assert.equal(record.phase, 'complete', label);
        for (const captured of [record.containers, record.containersAfterPoll]) { assert.equal(captured.length, 1, label); assert.ok(check(captured[0]), `${label}: ${JSON.stringify(captured[0])}`); }
        nothingOwned(w);
    }
});

// --- T3: the immediate acceptance needs a fresh status and a ready target ------------------------------------------------------
test('T3.a-status-the-apply-calls-fresh-with-a-ready-target-passes-and-records-its-freshness', async t => {
    const w = await provisioned(t);
    const p1 = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
    assert.equal(p1.result, 'pass', JSON.stringify(p1).slice(0, 300));
    const [freshness] = w.artifacts.get('gpu-live-p1').statusFreshness;
    assert.deepEqual({ label: freshness.label, statusFresh: freshness.statusFresh, statusWaitMs: freshness.statusWaitMs }, { label: 'p1', statusFresh: true, statusWaitMs: 12 });
    assert.match(freshness.readStartedAt, /^\d{4}-\d\d-\d\dT/);
    nothingOwned(w);
});

test('T3.a-status-that-is-not-fresh-fails-even-when-the-instance-reads-starting-and-applied-and-a-fresh-status-that-reads-starting-fails-too', async t => {
    const lag = await provisioned(t, { faults: { statusLagMs: 300 } });
    const lagged = caseOf(await liveCases(lag, ['LIVE-P1'], { timings: { convergenceMs: 3000, convergencePollMs: 10 } }), 'LIVE-P1');
    assert.equal(lagged.result, 'fail', JSON.stringify(lagged).slice(0, 300));
    const record = lag.artifacts.get('gpu-live-p1').statusUnsettled;
    assert.deepEqual([record.immediate[0].availability, record.immediate[0].limitsState, record.statusFresh], ['starting', 'applied', false]);
    assert.match(lagged.reason, /did not report a fresh status/);
    nothingOwned(lag);
    // statusFresh true, yet the target still reads starting: after a fresh reconcile it must be ready.
    const starting = await provisioned(t, { faults: { startingAfterApply: true } });
    const entry = caseOf(await liveCases(starting, ['LIVE-P1'], { timings: { convergenceMs: 100, convergencePollMs: 10 } }), 'LIVE-P1');
    assert.equal(entry.result, 'fail', JSON.stringify(entry).slice(0, 300));
    assert.match(entry.reason, /hwlfixture\/probe: availability starting/); assert.equal(/did not report a fresh status/.test(entry.reason), false);
    assert.equal(starting.artifacts.get('gpu-live-p1').statusUnsettled.statusFresh, true);
    nothingOwned(starting);
});

// --- T6: the observation of the clients around an Apply never throws -------------------------------------------------------------
test('T6.a-failed-observation-of-the-clients-is-recorded-as-evidence-the-apply-goes-on-and-no-credit-is-given', async t => {
    for (const [label, mode, pattern] of [['the listing fails', 'ps', /Live command failed/], ['an inspect fails', 'inspect', /Live command failed/]]) {
        const w = await provisioned(t, { faults: { observeFailsBeforeApply: mode } });
        const p1 = caseOf(await liveCases(w, ['LIVE-P1']), 'LIVE-P1');
        assert.equal(p1.result, 'pass', `${label}: ${JSON.stringify(p1).slice(0, 300)}`);
        const [entry] = w.artifacts.get('gpu-live-p1').drainAcknowledgements;
        assert.equal(entry.applyStatus, 200);
        assert.deepEqual(entry.acknowledged, [], `${label}: an unobserved client is never acknowledged`);
        assert.ok(entry.clientsBefore.every(client => client.observed === 'error' && client.running === false && pattern.test(client.observeError)), `${label}: ${JSON.stringify(entry.clientsBefore)}`);
        assert.ok(entry.notAcknowledged.every(client => client.outcome === 'unobserved-before'), label);
        assert.equal(JSON.stringify(entry).includes('SYNTHETIC-SECRET-VALUE-1'), false, 'the error text is bounded and redacted');
        nothingOwned(w);
    }
});

// --- T8: a read that did not finish cleanly never yields an error-free, trusted truth --------------------------------------------
const VALID_INSPECT = JSON.stringify({ id: 'f'.repeat(64), status: 'exited', running: false, exitCode: 137, oomKilled: true, startedAt: '2026-10-03T00:00:00Z', finishedAt: '2026-10-03T00:00:05Z' });
test('T8.a-failed-transport-keeps-its-error-and-marks-the-printed-data-partial-for-the-inspect-and-the-logs', async t => {
    const inspectCases = [
        ['(a) exit 125', { status: 125, stderr: 'Error: synthetic' }, /exit 125/],
        ['(b) a timeout', { status: null, timedOut: true }, /timed out/],
        ['(c) SIGKILL', { status: null, signal: 'SIGKILL' }, /killed by SIGKILL/],
        ['(d) truncated output', { status: 0, truncated: true }, /output truncated/],
    ];
    for (const [label, fault, pattern] of inspectCases) {
        const w = await provisioned(t, { faults: { ...STOPPED, truthInspectResult: { ...fault, stdout: VALID_INSPECT } } });
        const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: QUICK_POLL }), 'LIVE-P1');
        assert.equal(p1.result, 'fail', `${label}: ${JSON.stringify(p1).slice(0, 200)}`);
        const record = w.artifacts.get('gpu-live-p1').statusUnsettled;
        for (const captured of [record.containers, record.containersAfterPoll]) {
            assert.ok(pattern.test(captured[0].stateError), `${label}: ${JSON.stringify(captured[0].stateError)}`);
            assert.equal(captured[0].stateTrusted, false, label);
            assert.equal(captured[0].state.exitCode, 137, `${label}: the printed data is kept, marked partial`);
        }
        // No conclusion about the container is drawn from an untrusted read.
        assert.equal(/exit 137/.test(p1.reason), false, `${label}: ${p1.reason}`);
        nothingOwned(w);
    }
    for (const [label, fault, pattern] of [['(e) truncated logs', { status: 0, truncated: true }, /output truncated/], ['(f) nonzero exit', { status: 1, stderr: 'Error: logs synthetic' }, /exit 1/]]) {
        const w = await provisioned(t, { faults: { ...STOPPED, truthLogsResult: { ...fault, stdout: 'partial log line\n' } } });
        const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: QUICK_POLL }), 'LIVE-P1');
        assert.equal(p1.result, 'fail', label);
        const record = w.artifacts.get('gpu-live-p1').statusUnsettled;
        for (const captured of [record.containers, record.containersAfterPoll]) {
            assert.ok(pattern.test(captured[0].logsError), `${label}: ${captured[0].logsError}`);
            assert.equal(captured[0].logsTrusted, false, label); assert.match(captured[0].logsTail, /partial log line/);
        }
        nothingOwned(w);
    }
    // (g) The normal read is trusted and error-free.
    const normal = await provisioned(t, { faults: STOPPED });
    await liveCases(normal, ['LIVE-P1'], { timings: QUICK_POLL });
    const [captured] = normal.artifacts.get('gpu-live-p1').statusUnsettled.containers;
    assert.deepEqual([captured.stateTrusted, captured.stateError, captured.logsTrusted, captured.logsError], [true, null, true, null]);
    assert.equal(captured.state.exitCode, 137);
    nothingOwned(normal);
});

// --- T10: a long poll error keeps its HTTP status and code; the poll window starts after the first capture ----------------------------
test('T10.a-state-sized-503-poll-error-keeps-its-status-and-code-as-fields-and-a-slow-capture-does-not-use-up-the-poll-window', async t => {
    const w = await provisioned(t, { faults: { ...STOPPED, diagnosticGetFault: 'http503' } });
    const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: QUICK_POLL }), 'LIVE-P1');
    assert.equal(p1.result, 'fail', JSON.stringify(p1).slice(0, 200));
    const [first] = w.artifacts.get('gpu-live-p1').statusUnsettled.convergence.pollErrors;
    assert.deepEqual([first.status, first.code], [503, 'store_unreadable']);
    assert.match(first.message, /^The hardware-limits administrator route answered 503: /, 'the head of the message is kept');
    assert.ok(first.message.length <= 200);
    nothingOwned(w);
    // The first capture takes 300 ms, longer than the 200 ms window: the polls still happen, and the reason says how many.
    const slow = await provisioned(t, { faults: { ...STOPPED, truthDelayMs: 300 } });
    const entry = caseOf(await liveCases(slow, ['LIVE-P1'], { timings: QUICK_POLL }), 'LIVE-P1');
    assert.equal(entry.result, 'fail');
    const convergence = slow.artifacts.get('gpu-live-p1').statusUnsettled.convergence;
    assert.ok(convergence.pollCount >= 3 && convergence.pollWindowMs >= 190, JSON.stringify({ count: convergence.pollCount, window: convergence.pollWindowMs }));
    assert.match(entry.reason, /it did not settle within 200 ms \(\d+ poll\(s\) in a window of \d+ ms\)/);
    nothingOwned(slow);
});

// --- T9: the guarantees of the failure diagnosis are pinned: write order, the listing, redaction, the abort check and the cap -------
const SECRETS = ['SYNTHETIC-SECRET-POLL-1', 'SYNTHETIC-SECRET-READ-2', 'SYNTHETIC-SECRET-STDERR-3'];
test('T9.the-first-artifact-write-holds-the-immediate-failure-before-any-capture-or-poll', async t => {
    const w = await provisioned(t, { faults: STOPPED });
    const phases = [];
    const record = (name, value) => { w.artifacts.set(name, structuredClone(value)); if (name === 'gpu-live-p1' && value.statusUnsettled) phases.push({ phase: value.statusUnsettled.phase, captured: value.statusUnsettled.containers !== null, polls: value.statusUnsettled.convergence.polls.length + value.statusUnsettled.convergence.pollErrors.length, after: value.statusUnsettled.containersAfterPoll !== null }); };
    await liveCases(w, ['LIVE-P1'], { timings: QUICK_POLL, artifacts: record });
    // The very first write that carries the record: the immediate failure only, nothing captured, nothing polled.
    assert.deepEqual(phases[0], { phase: 'immediate-failure', captured: false, polls: 0, after: false });
    const order = phases.map(entry => entry.phase);
    assert.ok(order.indexOf('captured-after-immediate-failure') > order.indexOf('immediate-failure') && order.indexOf('complete') > order.indexOf('captured-after-immediate-failure'), order.join(','));
    assert.ok(phases.some(entry => entry.phase === 'captured-after-immediate-failure' && entry.captured && entry.polls === 0), 'the first capture is written before the first poll');
    assert.ok(phases.filter(entry => entry.polls > 0).length >= 1, 'the polls are written as they happen');
    nothingOwned(w);
});

test('T9.a-failed-container-listing-in-both-captures-still-fails-with-the-evidence-present', async t => {
    const w = await provisioned(t, { faults: { ...STOPPED, listingFailsAfterUnsettled: true } });
    const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: QUICK_POLL }), 'LIVE-P1');
    assert.equal(p1.result, 'fail', JSON.stringify(p1).slice(0, 300));
    const record = w.artifacts.get('gpu-live-p1').statusUnsettled;
    assert.equal(record.phase, 'complete');
    for (const captured of [record.containers, record.containersAfterPoll]) { assert.equal(captured.length, 1); assert.match(captured[0].error, /Live command failed/); }
    assert.deepEqual(record.immediate.map(entry => entry.availability), ['stopped']);
    nothingOwned(w);
});

test('T9.synthetic-secrets-in-a-poll-error-a-thrown-read-and-a-failed-read-stderr-are-redacted', async t => {
    const w = await provisioned(t, { faults: { ...STOPPED, diagnosticGetFault: 'errorText', truthThrows: true } });
    const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: QUICK_POLL }), 'LIVE-P1');
    assert.equal(p1.result, 'fail');
    const record = w.artifacts.get('gpu-live-p1').statusUnsettled;
    assert.ok(record.convergence.pollErrors.length >= 1 && /\[redacted\]/i.test(record.convergence.pollErrors[0].message), JSON.stringify(record.convergence.pollErrors[0]));
    assert.match(record.containers[0].stateError, /\[redacted\]/i);
    for (const secret of SECRETS.slice(0, 2)) assert.equal(JSON.stringify(record).includes(secret), false, secret);
    nothingOwned(w);
    const stderr = await provisioned(t, { faults: { ...STOPPED, truthInspectResult: { status: 125, stderr: 'Error: failed token=SYNTHETIC-SECRET-STDERR-3' } } });
    await liveCases(stderr, ['LIVE-P1'], { timings: QUICK_POLL });
    const stderrRecord = stderr.artifacts.get('gpu-live-p1').statusUnsettled;
    assert.match(stderrRecord.containers[0].stateError, /\[redacted\]/i); assert.equal(JSON.stringify(stderrRecord).includes(SECRETS[2]), false);
    nothingOwned(stderr);
});

test('T9.an-aborted-run-stops-the-polling-at-once-and-the-poll-error-list-is-capped', async t => {
    // The run is aborted while the first capture reads the container: the poll loop must not keep polling to its bound.
    const controller = new AbortController();
    const aborted = await provisioned(t, { faults: { ...STOPPED, onTruthInspect: () => controller.abort() } });
    const t0 = Date.now();
    await liveCases(aborted, ['LIVE-P1'], { timings: { convergenceMs: 5000, convergencePollMs: 10 }, signal: controller.signal });
    const record = aborted.artifacts.get('gpu-live-p1')?.statusUnsettled;
    assert.ok(Date.now() - t0 < 2500, `stopped at once (${Date.now() - t0} ms)`);
    assert.ok(record && record.convergence.pollCount === 0, JSON.stringify(record?.convergence));
    // The error list is capped at 60 entries however long the polls keep failing.
    const w = await provisioned(t, { faults: { ...STOPPED, diagnosticGetFault: 'exit' } });
    await liveCases(w, ['LIVE-P1'], { timings: { convergenceMs: 1500, convergencePollMs: 1 } });
    const capped = w.artifacts.get('gpu-live-p1').statusUnsettled.convergence;
    assert.equal(capped.pollErrors.length, 60); assert.ok(capped.pollCount >= 60);
    nothingOwned(w);
});

// --- R17: unknown freshness, the other transport flags of a truth read, and the persist inside the poll loop -------------------------
test('R17.a-status-freshness-the-apply-response-does-not-state-fails-the-immediate-check', async t => {
    for (const unknown of ['omit', 'null']) {
        const w = await provisioned(t, { faults: { statusFreshUnknown: unknown } });
        const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: { convergenceMs: 100, convergencePollMs: 10 } }), 'LIVE-P1');
        assert.equal(p1.result, 'fail', `${unknown}: ${JSON.stringify(p1).slice(0, 300)}`);
        assert.match(p1.reason, /did not report a fresh status/, unknown);
        const record = w.artifacts.get('gpu-live-p1').statusUnsettled;
        assert.equal(record.statusFresh, null, unknown);
        assert.equal(record.immediate[0].availability, 'ready', 'the instance itself reads ready; only the unknown freshness fails it');
        nothingOwned(w);
    }
});

test('R17.cancelled-forced-settlement-and-error-code-truth-reads-keep-their-error-and-are-never-trusted', async t => {
    for (const [label, flag, pattern, keepsData] of [
        ['cancelled', { cancelled: true }, /cancelled|Live command failed/, false],
        ['forced settlement', { settlementForced: true }, /forced settlement/, true],
        ['an error code', { errorCode: 'ENOENT' }, /error ENOENT/, true],
    ]) {
        const w = await provisioned(t, { faults: { ...STOPPED, truthInspectResult: { status: 0, ...flag, stdout: VALID_INSPECT } } });
        const p1 = caseOf(await liveCases(w, ['LIVE-P1'], { timings: QUICK_POLL }), 'LIVE-P1');
        assert.equal(p1.result, 'fail', `${label}: ${JSON.stringify(p1).slice(0, 200)}`);
        const record = w.artifacts.get('gpu-live-p1').statusUnsettled;
        for (const captured of [record.containers, record.containersAfterPoll]) {
            assert.ok(pattern.test(captured[0].stateError), `${label}: ${JSON.stringify(captured[0].stateError)}`);
            assert.equal(captured[0].stateTrusted, false, label);
            if (keepsData) assert.equal(captured[0].state.exitCode, 137, `${label}: the printed data is kept, marked partial`);
        }
        assert.equal(/exit 137/.test(p1.reason), false, `${label}: no conclusion from an untrusted read`);
        nothingOwned(w);
    }
});

