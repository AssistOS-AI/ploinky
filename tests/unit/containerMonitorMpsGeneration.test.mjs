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
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-mps-'));
const prior = process.env.PLOINKY_WORKSPACE_ROOT; process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const { createContainerMonitor, syncManagedContainers, monitorTick, stopContainerMonitor } = await import('../../cli/server/containerMonitor.js');
test.after(() => { if (prior === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = prior; fs.rmSync(workspace, { recursive: true, force: true }); });
let sequence = 0;
function fixture(t) {
    const name = `gpu${++sequence}`, plain = `plain${sequence}`, root = fs.mkdtempSync(path.join(workspace, 'fixture-'));
    for (const agent of [name, plain]) { const directory = path.join(workspace, '.ploinky/repos/demo', agent); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ container: 'prepared:image', start: 'sleep infinity', network: { mode: 'default' } })); }
    for (const destination of Object.values(MPS_TOOL_PATHS)) fs.writeFileSync(path.join(root, path.basename(destination)), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const mps = discoverMpsTools({ directories: [root] }), mapping = new Map(Object.values(mps).map((tool) => [tool.destination, tool.source]));
    const fsApi = new Proxy(fs, { get(target, key) { const value = target[key]; return typeof value !== 'function' ? value : (...args) => value.call(target, typeof args[0] === 'string' ? mapping.get(args[0]) || args[0] : args[0], ...args.slice(1)); } });
    const pathHash = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 12);
    const wiring = buildGpuWiring({ identity: { workspaceRoot: workspace, pathHash, instance: `ploinky-box-fixture-${pathHash}` }, grant: { vendor: 'nvidia', agents: [`demo/${name}`] }, homeDirectory: root, mps, discovery: { vendor: 'nvidia', driverVersion: '550.1', devices: [{ path: '/dev/nvidia0', major: 195, minor: 0 }], libraries: [{ soname: 'libcuda.so.1', source: '/usr/lib/libcuda.so.550.1', size: 100, mtimeMs: 1 }], tools: [{ name: 'nvidia-smi', source: '/usr/bin/nvidia-smi', size: 100, mtimeMs: 1 }] } });
    const specPath = path.join(root, 'spec.json'), markerPath = path.join(root, 'grant.json'), boxPath = path.join(root, 'box');
    fs.writeFileSync(specPath, wiring.files[0].content); fs.writeFileSync(markerPath, wiring.files.at(-1).content); fs.writeFileSync(boxPath, BOX_MARKER_CONTENT);
    const gpuGrantOptions = { fsApi, specPath, markerPath }, grant = readBoxGpuGrant({ workspaceRoot: workspace, ...gpuGrantOptions }); assert.equal(grant.valid, true);
    const facts = { memoryModel: 'dedicated', memoryMiB: 8192, uuid: 'GPU-12345678-1234-1234-1234-123456789012', driverVersion: '550.1' };
    const record = (agent) => ({ type: 'agent', runtime: 'container', repoName: 'demo', agentName: agent, instanceId: `i-${agent}`, enableGeneration: `g-${agent}`, containerId: (agent === name ? 'a' : 'b').repeat(64) });
    const registry = { [name]: record(name), [plain]: record(plain) }; const events = []; let status = { daemonStatus: 'ready', mpsGeneration: 'daemon:config' }; let reads = 0; let appliedGeneration = 'daemon:config'; let staleIdentity = false;
    const monitor = createContainerMonitor({ config: { INITIAL_BACKOFF_MS: 100000, MAX_BACKOFF_MS: 100000 }, terminalLedgerFile: path.join(root, 'terminal.json'), log: (_level, event, data) => events.push({ event, data }), readMpsStatus: () => { reads++; return status; }, readAppliedObservation: (key) => key === name ? { ...registry[name], instanceId: staleIdentity ? 'foreign' : registry[name].instanceId, mpsGeneration: appliedGeneration } : null });
    t.after(() => stopContainerMonitor(monitor));
    Object.assign(monitor, { workspaceRoot: workspace, gpuGrantOptions, boxMarkerOptions: { markerPath: boxPath }, loadAgents: () => registry, readRoutingConfig: () => ({ routes: {} }), listRunningContainerNames: () => Object.keys(registry), readNoWaitStatus: () => null, inspectWorkspaceStartLock: () => ({ active: false }), startProbeWorker: () => {} });
    monitor.hardwareContext = { gate: 'on', prepared: true, backendReady: true, controllers: ['cpu', 'memory', 'pids'], storeState: 'valid', storeToken: { epoch: 'e'.repeat(32), revision: 1 }, envelope: { cpus: 8, memoryBytes: 8 * 1024 ** 3 }, overrides: new Map([[`demo/${name}`, { gpu: { smPercent: 25, vramPercent: 25 } }]]), gpu: { eligible: true, deviceUuid: facts.uuid, driverVersion: facts.driverVersion, wiringFingerprint: grant.fingerprint, facts, grant, fsApi } };
    return { monitor, registry, name, plain, events, reads: () => reads, status: (next) => { status = next; }, stale: () => { staleIdentity = true; }, apply: (generation) => { appliedGeneration = generation; } };
}
test('MW.healthy matching share is unchanged and one status read occurs per sync', (t) => {
    const f = fixture(t); syncManagedContainers(f.monitor); assert.equal(f.reads(), 1); assert.equal(f.monitor.targets.get(f.name).mpsPending, false); monitorTick(f.monitor);
    assert.equal(f.events.some(({ event }) => event === 'container_restart_scheduled'), false);
});
test('MW.daemon loss restarts HTTP-healthy GPU target but leaves ordinary targets alone', (t) => {
    const f = fixture(t); f.status({ daemonStatus: 'lost', mpsGeneration: null }); monitorTick(f.monitor);
    assert.equal(f.monitor.targets.get(f.name).mpsPending, true); assert.ok(f.monitor.targets.get(f.name).pendingRestartTimer); assert.equal(f.monitor.targets.get(f.plain).pendingRestartTimer, null);
    assert.ok(f.events.some(({ data }) => data?.reason === 'mps_generation_changed'));
});
test('MW.exact applied identity is required for healthy daemon reuse', (t) => { const f = fixture(t); f.stale(); syncManagedContainers(f.monitor); assert.equal(f.monitor.targets.get(f.name).mpsPending, true); });
test('MW.terminal refusal suppresses unchanged state and daemon repair rearms without changing input digest', (t) => {
    const f = fixture(t); f.status({ daemonStatus: 'lost', mpsGeneration: null }); syncManagedContainers(f.monitor); const target = f.monitor.targets.get(f.name); const digest = target.restartInputDigest;
    f.monitor.terminalLedger.set(f.name, { restartInputDigest: digest, mpsFingerprint: target.mpsFingerprint }); syncManagedContainers(f.monitor); assert.equal(f.monitor.targets.has(f.name), false);
    f.status({ daemonStatus: 'ready', mpsGeneration: 'new:config' }); syncManagedContainers(f.monitor); assert.equal(f.monitor.targets.get(f.name).restartInputDigest, digest); assert.equal(f.monitor.terminalLedger.has(f.name), false);
});
test('MW.own generation rebuild cannot stale or clear active attempt', (t) => {
    const f = fixture(t); syncManagedContainers(f.monitor); const target = f.monitor.targets.get(f.name), digest = target.restartInputDigest, fingerprint = target.mpsFingerprint; target.isRestarting = true; target.attemptEpoch = 9;
    f.status({ daemonStatus: 'ready', mpsGeneration: 'new:config' }); syncManagedContainers(f.monitor); assert.equal(target.restartInputDigest, digest); assert.equal(target.mpsFingerprint, fingerprint); assert.equal(target.attemptEpoch, 9); assert.equal(target.isRestarting, true);
    target.isRestarting = false; f.apply('new:config'); syncManagedContainers(f.monitor); assert.equal(target.mpsPending, false);
});
test('MW.no-wait launch and workspace maintenance defer lost-daemon restart', (t) => {
    const f = fixture(t); f.status({ daemonStatus: 'lost', mpsGeneration: null }); f.monitor.readNoWaitStatus = () => ({ state: 'starting' }); monitorTick(f.monitor); assert.equal(f.monitor.targets.get(f.name).pendingRestartTimer, null);
    f.monitor.readNoWaitStatus = () => null; f.monitor.inspectWorkspaceStartLock = () => ({ active: true }); monitorTick(f.monitor); assert.equal(f.monitor.targets.get(f.name).pendingRestartTimer, null);
});

test('MW.multiple share instances use one bounded daemon observation', (t) => {
    const f = fixture(t); f.registry.alias = { ...f.registry[f.name], alias: 'alias', instanceId: 'alias-i', enableGeneration: 'alias-g', containerId: 'c'.repeat(64) };
    syncManagedContainers(f.monitor); assert.equal(f.reads(), 1); assert.equal(f.monitor.targets.get('alias').mpsPending, true);
});
test('MW.no share instances cause no daemon query', (t) => {
    const f = fixture(t); delete f.registry[f.name]; syncManagedContainers(f.monitor); assert.equal(f.reads(), 0); assert.equal(f.monitor.targets.get(f.plain).mpsPending, false);
});
