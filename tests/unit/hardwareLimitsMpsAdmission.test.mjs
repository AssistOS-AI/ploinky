import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGpuWiring } from '../../ploinky-box/gpuGrant.mjs';
import { discoverMpsTools, MPS_TOOL_PATHS } from '../../ploinky-box/lib/mpsTools.mjs';
import { readBoxGpuGrant } from '../../ploinky-box/lib/gpuGrantMarker.mjs';
import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import { admitManifestRuntimeCapabilities, renderRuntimePolicyArgs, hardwareLimitsHashOf, assertHardwareAdmissionCurrent, assertRuntimeAdmissionCurrent, createHardwareLaunchGuard } from '../../cli/sandbox/runtimeCapabilities.js';
import { createMpsLaunch } from '../../cli/sandbox/hardwareLimits/mpsLaunch.mjs';
import { inspectMpsImage } from '../../cli/sandbox/hardwareLimits/mpsEligibility.mjs';
import { preparedCgroupFs } from '../hardware-limits/fakeCgroupFs.mjs';
const imageId = 'a'.repeat(64), containerId = 'b'.repeat(64);
const manifest = { container: 'prepared:image' };
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-admission-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const destination of Object.values(MPS_TOOL_PATHS)) fs.writeFileSync(path.join(root, path.basename(destination)), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const mps = discoverMpsTools({ directories: [root] });
    const mapped = new Map(Object.values(mps).map((tool) => [tool.destination, tool.source]));
    const fsApi = new Proxy(fs, { get(target, key) { const value = target[key]; if (typeof value !== 'function') return value; return (...args) => value.call(target, typeof args[0] === 'string' ? mapped.get(args[0]) || args[0] : args[0], ...args.slice(1)); } });
    const pathHash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
    const identity = { workspaceRoot: root, pathHash, instance: `ploinky-box-fixture-${pathHash}` };
    const discovery = { vendor: 'nvidia', driverVersion: '550.1', devices: [{ path: '/dev/nvidia0', major: 195, minor: 0 }], libraries: [{ soname: 'libcuda.so.1', source: '/usr/lib/libcuda.so.550.1', size: 100, mtimeMs: 1 }], tools: [{ name: 'nvidia-smi', source: '/usr/bin/nvidia-smi', size: 100, mtimeMs: 1 }] };
    const wiring = buildGpuWiring({ identity, grant: { vendor: 'nvidia', agents: ['demo/worker'] }, discovery, homeDirectory: root, mps });
    const specPath = path.join(root, 'cdi.json'), markerPath = path.join(root, 'grant.json'), boxMarker = path.join(root, 'box');
    fs.writeFileSync(specPath, wiring.files[0].content); fs.writeFileSync(markerPath, wiring.files.at(-1).content); fs.writeFileSync(boxMarker, BOX_MARKER_CONTENT);
    const gpuGrantOptions = { specPath, markerPath, fsApi };
    const grant = readBoxGpuGrant({ workspaceRoot: root, ...gpuGrantOptions }); assert.equal(grant.valid, true); assert.ok(grant.mps);
    const facts = { memoryModel: 'dedicated', memoryMiB: 8192, uuid: 'GPU-12345678-1234-1234-1234-123456789012', driverVersion: '550.1' };
    const context = { gate: 'on', prepared: true, backendReady: true, controllers: ['cpu', 'memory', 'pids'], storeState: 'valid', storeToken: { epoch: 'e'.repeat(32), revision: 1 }, envelope: { cpus: 8, memoryBytes: 8 * 1024 ** 3 }, overrides: new Map([['demo/worker', { cpus: 0.5, gpu: { smPercent: 25, vramPercent: 25 } }]]), gpu: { eligible: true, deviceUuid: facts.uuid, driverVersion: facts.driverVersion, wiringFingerprint: grant.fingerprint, facts, grant, fsApi } };
    const options = { agentId: 'demo/worker', runtime: 'podman', workspaceRoot: root, boxMarkerOptions: { markerPath: boxMarker }, gpuGrantOptions, hardwareContext: context };
    return { context, options, mps, fsApi, markerPath, admission: () => admitManifestRuntimeCapabilities(manifest, options) };
}
function launchedFs() {
    const fake = preparedCgroupFs(); fake.addGroup('/ploinky/agents', { uid: 1000 }); fake.addGroup('/ploinky/agents/libpod-fixture', { uid: 1000 });
    fake.groups.get('/ploinky/agents/libpod-fixture').values.set('cpu.max', '50000 100000'); fake.placePid(321, '/ploinky/agents/libpod-fixture');
    fake.readlinkSync = (target) => { if (target === '/proc/self/ns/cgroup') return 'cgroup:[1]'; if (target === '/proc/321/ns/cgroup') return 'cgroup:[2]'; throw Object.assign(Error('absent'), { code: 'ENOENT' }); }; return fake;
}
function guardFixture(f) {
    const admission = f.admission(); const share = admission.descriptor.hardwareGpu;
    const state = { status: 'ready', daemonGeneration: 'daemon', configurationGeneration: 'config', pipeDirectory: `/run/ploinky/mps/pipe-${'c'.repeat(32)}`, serverDefault: { smPercent: share.smPercent, memoryMiB: share.memoryMiB, deviceUuid: share.deviceUuid, driverVersion: share.driverVersion, wiringFingerprint: share.wiringFingerprint } };
    const launch = createMpsLaunch({ key: 'exact', imageId, share, state }); const records = [];
    const inspect = { Id: containerId, Image: imageId, Config: { Labels: { 'ploinky.mpsgeneration': 'daemon:config' }, Env: ['SECRET=not-recorded', 'CUDA_MPS_PIPE_DIRECTORY=/run/ploinky-mps-pipe', 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=25', 'CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=2048M'] }, Mounts: [{ Type: 'bind', Source: state.pipeDirectory, Destination: '/run/ploinky-mps-pipe', RW: true }] };
    const fake = launchedFs();
    const guard = createHardwareLaunchGuard(admission, { key: 'exact', ref: 'demo/worker', runtime: 'podman', instanceId: 'i', enableGeneration: 'g', hardwareContext: f.context, fsApi: fake, mpsLaunch: launch, mpsVerification: { store: { read: () => state }, backend: { verify: () => true } }, recordApplied: (record) => records.push(record), query: (_command, args) => ({ ok: true, stdout: args.includes('{{.State.Pid}}') ? '321\n' : JSON.stringify([inspect]) }) });
    return { guard, records, inspect, fake, state, admission };
}

test('MA.real stored GPU admission resolves share and renders granted CDI with GPU-sensitive hash', (t) => {
    const f = fixture(t); const admission = f.admission(); const share = admission.descriptor.hardwareGpu;
    assert.equal(share.memoryMiB, 2048); assert.equal(share.smPercent, 25);
    const args = renderRuntimePolicyArgs(admission.descriptor, { runtime: 'podman' }); const at = args.indexOf('--device'); assert.deepEqual(args.slice(at, at + 2), ['--device', 'ploinky.local/gpu=all']);
    const hash = hardwareLimitsHashOf(admission.descriptor); assert.match(hash, /^[a-f0-9]{64}$/);
    f.context.overrides.set('demo/worker', { cpus: 0.5, gpu: { smPercent: 50, vramPercent: 25 } });
    assert.notEqual(hardwareLimitsHashOf(f.admission().descriptor), hash);
    assert.throws(() => assertHardwareAdmissionCurrent(admission, { hardwareContext: f.context }), { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' });
});
test('MA.real grant and tool currentness rejects drift', (t) => {
    const f = fixture(t); const admission = f.admission();
    assert.doesNotThrow(() => assertRuntimeAdmissionCurrent(admission, { hardwareContext: f.context, gpuGrantOptions: f.options.gpuGrantOptions }));
    fs.appendFileSync(f.mps.control.source, '# changed\n');
    assert.throws(() => assertHardwareAdmissionCurrent(admission, { hardwareContext: f.context }), { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' });
});
test('MA.missing grant and missing tools refuse actual stored GPU admission', (t) => {
    const f = fixture(t); const original = f.context.gpu.grant;
    for (const grant of [{ ...original, agents: [] }, { ...original, mps: null }]) { f.context.gpu.grant = grant; assert.throws(() => f.admission()); }
});
test('MA.image UID and host network qualification refuse before minting launch', () => {
    for (const [imageUser, networkMode] of [['0:0', 'default'], ['1000:1000', 'host'], ['4294967295:1000', 'bridge']]) assert.throws(() => inspectMpsImage({ image: 'prepared:image', networkMode }, { inspectImage: () => ({ Id: imageId, Config: { User: imageUser } }) }), { code: 'gpu_sharing_unavailable' });
});
test('MA.actual launch guard verifies cgroup and runtime MPS then records filtered applied generation', (t) => {
    const f = guardFixture(fixture(t)); f.guard.createArgs(['create']); f.guard.afterLaunch({ containerId });
    assert.equal(f.records.length, 1); assert.equal(f.records[0].mpsGeneration, 'daemon:config'); assert.equal(f.records[0].cpus, 0.5); assert.equal(f.records[0].gpuShare.memoryMiB, 2048); assert.equal(JSON.stringify(f.records).includes('SECRET'), false);
});
test('MA.actual launch guard refuses adopted generation/environment or cgroup drift before recording', (t) => {
    for (const mutate of [(f) => { f.inspect.Config.Env[2] = 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=100'; }, (f) => { f.inspect.Config.Labels['ploinky.mpsgeneration'] = 'old:config'; }, (f) => { f.fake.groups.get('/ploinky/agents/libpod-fixture').values.set('cpu.max', 'max 100000'); }]) {
        const f = guardFixture(fixture(t)); mutate(f); assert.throws(() => f.guard.afterLaunch({ containerId })); assert.equal(f.records.length, 0);
    }
});

test('MA.actual mounted grant revocation invalidates admitted CDI before launch', (t) => {
    const f = fixture(t); const admission = f.admission();
    const marker = JSON.parse(fs.readFileSync(f.markerPath, 'utf8')); marker.agents = [];
    fs.writeFileSync(f.markerPath, JSON.stringify(marker));
    assert.throws(() => assertRuntimeAdmissionCurrent(admission, { hardwareContext: f.context, gpuGrantOptions: f.options.gpuGrantOptions }), { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' });
    assert.throws(() => f.admission());
});
test('MA.actual launch guard rejects daemon restart before applied observation', (t) => {
    const f = guardFixture(fixture(t)); f.state.daemonGeneration = 'replacement';
    assert.throws(() => f.guard.afterLaunch({ containerId }), /generation/); assert.equal(f.records.length, 0);
});
