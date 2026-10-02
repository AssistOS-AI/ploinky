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
import { executeCleanupRun, executeLiveRun, liveSourceDigest, validateExecutionProfile, validateProfile } from '../hardware-limits/liveHarness.mjs';
import { provisionRun } from '../hardware-limits/liveFixture.mjs';
import { buildConcreteManifest, renderSummary, summaryPathFor } from '../hardware-limits/liveManifest.mjs';
import { writeUstar } from '../hardware-limits/liveStage.mjs';
import { engineIdentityDigest, hostRecordPaths } from '../hardware-limits/liveCommon.mjs';
import { fakeEngineInfo, ok, worldState } from '../hardware-limits/fakeLiveEngine.mjs';
import { createGpuWorld } from '../hardware-limits/fakeLiveGpu.mjs';
import { createGpuGate, gpuQueryArgv } from '../hardware-limits/liveGpuGate.mjs';
import { parseGpuInventory, parseGpuMemory } from '../hardware-limits/liveGpu.mjs';
import { createHostProc } from '../hardware-limits/liveGpuHost.mjs';
import { createGpuCases, compactEvidence } from '../hardware-limits/liveGpuCases.mjs';
import {
    ADMIN_REQUEST, MPS_KILL_OWNED_DAEMON, MPS_OBSERVE, assertMpsControlCommand, classifyMpsReply, controlHelperExecArgv, controlHelperRunArgv, parseProbeResult, probeBoundMiB, probeExecArgv,
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
    w.cleanup = () => executeCleanupRun({ run: w.run, persist, processProvider: fake.provider, hostIdentity, remoteArrival: true });
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
    for (const program of [ADMIN_REQUEST, MPS_OBSERVE, MPS_KILL_OWNED_DAEMON]) assert.doesNotThrow(() => new vm.Script(`(async()=>{${program}})`));
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
    assert.deepEqual(evidence.applied.gpu.serverDefault, { smPercent: 25, vramMiB: 1044 });
    assert.equal(evidence.daemon.box.cgroup, '0::/ploinky/core'); assert.deepEqual(evidence.daemon.host.uid, { real: 1000, effective: 1000, saved: 1000, fs: 1000 });
    assert.deepEqual(evidence.readbackForms, { sm: { form: 'integer-percentage', value: 25 }, memory: { form: 'integer-with-M-or-G', bytes: 1044 * 1048576 } });
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
    assert.deepEqual([rounding.overheadMiB, rounding.stepMiB, rounding.fullSmCount, rounding.expectedSmShare, rounding.planEvidence.matchesFull], [148, 128, 30, 8, true]);
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
    assert.deepEqual(e.defaultChange.new.serverDefault, { smPercent: 50, vramMiB: 2088 });
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
    assert.ok(candidate.some(args => args.join(' ') === '--port 23456 --udp-port 34567 restart hwlfixture/probe'));
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
