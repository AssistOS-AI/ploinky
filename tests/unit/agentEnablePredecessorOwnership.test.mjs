// An explicit re-enable of a host or none agent that changes more than its
// runtime identity stages an inactive replacement: it rotates the registered
// tuple before it launches the successor. The predecessor container still
// carries its own tuple, so the launch can remove it only with proof of that
// tuple. Without it the launch preserved the predecessor ("exact immutable
// ownership/removal was not proven") and left the rotated record naming no
// container ID, so no later enable or start could replace it either. Every
// engine call here goes to the stateful fake engine behind the real
// exact-removal routine; nothing reaches a real engine.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { installFakeEngine } from './dependencyStoreFakeEngine.mjs';
import { tempRoot } from './dependencyStoreFixtures.mjs';

const DRIVER = path.resolve(import.meta.dirname, 'agentEnablePredecessorOwnershipDriver.mjs');
const INSTANCE_LABEL = 'io.assistos.ploinky.instance-id';
const GENERATION_LABEL = 'io.assistos.ploinky.enable-generation';
const WORKSPACE_LABEL = 'io.assistos.ploinky.workspace';
// cli/sandbox/networkLifecycle.js NETWORK_LOCK_STALE_GRACE_MS (not imported:
// the production config module would bind this process to a workspace).
const NETWORK_LOCK_STALE_GRACE_MS = 5_000;
assert.match(
    fs.readFileSync(new URL('../../cli/sandbox/networkLifecycle.js', import.meta.url), 'utf8'),
    /export const NETWORK_LOCK_STALE_GRACE_MS = 5_000;/,
);

// In front of the shared fake engine: answers the single-target status
// inspection an enable uses to verify its started runtime, lists only running
// containers for `ps` when asked (as real engines do), fails one exact command
// for one exact ID (FAKE_SHIM_RULE), and can SIGKILL its caller right after an
// exact removal succeeded (FAKE_SHIM_KILL_CALLER_AFTER_RM).
const SHIM_SOURCE = String.raw`#!/usr/bin/env node
const fs = require('fs'); const { spawnSync } = require('child_process');
const argv = process.argv.slice(2);
const state = () => JSON.parse(fs.readFileSync(process.env.FAKE_ENGINE_STATE, 'utf8'));
const formatIndex = argv.findIndex((value) => value === '--format' || value === '-f');
if ((argv[0] === 'inspect' || (argv[0] === 'container' && argv[1] === 'inspect'))
    && formatIndex > 0 && /State\.Status/.test(argv[formatIndex + 1])) {
  const refs = argv.filter((value, index) => !value.startsWith('-') && index !== formatIndex + 1 && value !== 'inspect' && value !== 'container');
  const found = Object.values(state().containers).find((entry) => refs.includes(entry.Name) || refs.includes(entry.Id));
  if (!found) { process.stderr.write('Error: no such container\n'); process.exit(125); }
  process.stdout.write(found.State.Status + '\n');
  process.exit(0);
}
if (process.env.FAKE_SHIM_RUNNING_PS === '1' && argv[0] === 'ps' && !argv.includes('-a') && !argv.includes('--all')) {
  for (const entry of Object.values(state().containers)) if (entry.State.Running) process.stdout.write(entry.Name + '\n');
  process.exit(0);
}
const rule = process.env.FAKE_SHIM_RULE ? JSON.parse(process.env.FAKE_SHIM_RULE) : null;
if (rule && argv.includes(rule.id) && argv.slice(0, rule.command.length).join(' ') === rule.command.join(' ')) {
  process.stderr.write(rule.stderr + '\n');
  process.exit(rule.status);
}
const run = spawnSync(process.env.FAKE_SHIM_ENGINE, argv, { stdio: 'inherit' });
if (process.env.FAKE_SHIM_KILL_CALLER_AFTER_RM && argv[0] === 'rm' && argv.includes(process.env.FAKE_SHIM_KILL_CALLER_AFTER_RM)
    && run.status === 0) {
  process.kill(process.ppid, 'SIGKILL');
}
process.exit(run.status === null ? 1 : run.status);
`;

const NONE = { container: 'node:20', start: 'node index.js', network: { mode: 'none' }, readiness: { protocol: 'none' } };
const HOST = { ...NONE, network: { mode: 'host' } };
const BRIDGE_NETWORK = { mode: 'bridge', attachments: [{ name: 'core', primary: true }] };
const withNetwork = (mode) => ({ ...NONE, network: mode === 'bridge' ? BRIDGE_NETWORK : { mode } });

function workspace(t, manifests) {
    const root = fs.realpathSync(tempRoot(t, 'enable-predecessor-'));
    const ws = path.join(root, 'ws');
    let revision = 0;
    const write = (name, manifest) => {
        const dir = path.join(ws, '.ploinky', 'repos', 'repo', name);
        fs.mkdirSync(path.join(dir, 'code'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(dir, 'code', 'index.js'), 'console.log(1)\n');
    };
    // New manifest bytes: an identity-only re-enable would take the withdrawn
    // path beside the active predecessor instead of the inactive replacement.
    const change = (name, manifest) => { revision += 1; write(name, { ...manifest, about: `revision ${revision}` }); };
    for (const [name, manifest] of Object.entries(manifests)) write(name, manifest);
    fs.mkdirSync(path.join(ws, '.ploinky', 'data'), { recursive: true });
    const engine = installFakeEngine(root, { engines: ['podman'] });
    const shimDir = path.join(root, 'shim-bin');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'podman'), SHIM_SOURCE, { mode: 0o755 });
    // Present only so a native successor resolves on Linux as on macOS (the
    // fake engine provides sandbox-exec); no test launches a native runtime.
    fs.writeFileSync(path.join(shimDir, 'bwrap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = {
        ...process.env,
        ...engine.env,
        PATH: [shimDir, engine.env.PATH].join(path.delimiter),
        FAKE_SHIM_ENGINE: path.join(engine.binDir, 'podman'),
        PLOINKY_WORKSPACE_ROOT: ws,
        PLOINKY_ROOT: ws,
        CONTAINER_RUNTIME: 'podman',
        HOME: path.join(root, 'home'),
        PLOINKY_AGENTLIB_FINGERPRINT: 'fixture-fingerprint',
        PLOINKY_AGENTLIB_MODE: 'local',
        PLOINKY_AGENTLIB_SOURCE_ID: 'd'.repeat(64),
        PLOINKY_ROUTER_HOST_PORT: '18080',
        PLOINKY_MEDIA_HOST_PORT: '17891',
    };
    const args = (phase, argument) => [DRIVER, phase, ...(argument ? [JSON.stringify(argument)] : [])];
    const drive = (phase, argument, { killed = false, extraEnv = {} } = {}) => {
        const run = spawnSync(process.execPath, args(phase, argument), {
            cwd: ws, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120_000,
        });
        if (killed) {
            assert.equal(run.signal, 'SIGKILL', `${phase} was expected to stop mid-way: ${run.stdout}\n${run.stderr}`);
            // A killed owner's network lifecycle lock is reclaimable only after
            // its stale-owner grace; an explicit enable inside it is refused busy.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, NETWORK_LOCK_STALE_GRACE_MS + 500);
            return null;
        }
        assert.equal(run.status, 0, `${phase}: ${run.stdout}\n${run.stderr}`);
        return JSON.parse(run.stdout.trim().split('\n').at(-1));
    };
    const driveAsync = (phase, argument) => new Promise((resolve) => {
        const child = spawn(process.execPath, args(phase, argument), { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    drive('init');
    return { root, ws, engine, drive, driveAsync, write, change };
}

function engineContainers(w) {
    return Object.fromEntries(Object.values(w.engine.state().containers).map((entry) => [entry.Name, {
        id: entry.Id,
        instanceId: entry.Labels[INSTANCE_LABEL],
        enableGeneration: entry.Labels[GENERATION_LABEL],
        status: entry.State.Status,
        network: entry.HostConfig.NetworkMode,
    }]));
}

const engineRecord = (w, containerName) => structuredClone(w.engine.state().containers[containerName]);

function editEngine(w, edit) {
    const state = w.engine.state();
    edit(state.containers);
    fs.writeFileSync(w.engine.stateFile, JSON.stringify(state, null, 2));
}

const agentsFile = (w) => path.join(w.ws, '.ploinky', 'agents.json');
const registry = (w) => JSON.parse(fs.readFileSync(agentsFile(w), 'utf8'));
const receiptDir = (w) => path.join(w.ws, '.ploinky', 'run', 'runtime-predecessors');

function receipts(w) {
    const dir = receiptDir(w);
    return fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
            .map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }))
        : [];
}

const calls = (w) => w.engine.calls();
const callIndex = (list, predicate) => list.findIndex(predicate);

function enabled(w, agent, argument = {}, options = {}) {
    const result = w.drive('enable', { agent: `repo/${agent}`, ...argument }, options);
    if (options.killed) return null;
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
}

// The registry, routing generation and runtime agree on one exact successor,
// and no receipt binds it.
function assertCommittedSuccessor(w, containerName, { predecessorId = null } = {}) {
    const record = registry(w)[containerName];
    const containers = engineContainers(w);
    const runtime = containers[containerName];
    assert.ok(runtime, `${containerName} has a runtime`);
    assert.match(String(record.containerId), /^[a-f0-9]{64}$/);
    assert.equal(record.containerId, runtime.id);
    assert.equal(record.runtime, 'podman');
    assert.equal(runtime.instanceId, record.instanceId);
    assert.equal(runtime.enableGeneration, record.enableGeneration);
    assert.equal(runtime.status, 'running');
    if (predecessorId) {
        assert.notEqual(runtime.id, predecessorId);
        assert.equal(Object.values(containers).some((entry) => entry.id === predecessorId), false, 'predecessor removed');
    }
    const generation = w.drive('generation');
    assert.equal(generation.ok, true, JSON.stringify(generation));
    assert.equal(generation.selector, 'active');
    assert.deepEqual(generation.agents[containerName], record, 'the committed generation serves the published record');
    const lookup = w.drive('lookup', { containerName });
    assert.deepEqual(lookup, { ok: true, receipt: null }, 'no receipt binds the completed successor');
}

// ------------------------------------------------------------------
// Successful prepared replacement (the base defect).

for (const [label, manifest] of [['none', NONE], ['host', HOST]]) {
    test(`a prepared ${label} re-enable removes its exact predecessor before creating the successor`, (t) => {
        const w = workspace(t, { media: manifest, bystander: NONE });
        const bystander = enabled(w, 'bystander').result.containerName;
        const containerName = enabled(w, 'media').result.containerName;
        const before = registry(w);
        const predecessorId = before[containerName].containerId;
        const bystanderBefore = { record: before[bystander], runtime: engineContainers(w)[bystander] };
        const callsBefore = calls(w).length;

        w.change('media', manifest);
        const second = enabled(w, 'media');

        // Staging took the inactive replacement and made the predecessor's own
        // tuple durable before it published the rotated record.
        const firstRegistryWrite = second.trace.find((entry) => entry.event === 'registry');
        assert.equal(firstRegistryWrite.selector, 'inactive');
        const receiptWrite = second.trace.findIndex((entry) => entry.event === 'receipt');
        assert.ok(receiptWrite >= 0 && receiptWrite < second.trace.indexOf(firstRegistryWrite), JSON.stringify(second.trace));
        assert.equal(firstRegistryWrite.receipts.length, 1);

        // The exact predecessor ID was removed before the successor was created.
        const after = calls(w).slice(callsBefore);
        const removed = callIndex(after, (argv) => argv[0] === 'rm' && argv.includes(predecessorId));
        const created = callIndex(after, (argv) => argv[0] === 'create' && argv.includes(containerName));
        assert.ok(removed >= 0, 'predecessor removed by immutable ID');
        assert.ok(created > removed, 'successor created only after the exact removal');
        assert.equal(after.filter((argv) => argv[0] === 'rm').length, 1, 'nothing else was removed');

        assertCommittedSuccessor(w, containerName, { predecessorId });
        assert.notEqual(registry(w)[containerName].instanceId, before[containerName].instanceId);
        assert.deepEqual(registry(w)[bystander], bystanderBefore.record, 'the bystander record is unchanged');
        assert.deepEqual(engineContainers(w)[bystander], bystanderBefore.runtime, 'the bystander runtime is unchanged');
        assert.deepEqual(receipts(w), [], 'the consumed receipt was retired');
    });
}

test('repeated prepared re-enables keep one runtime and leave no stale proof', (t) => {
    const w = workspace(t, { media: NONE });
    const containerName = enabled(w, 'media').result.containerName;
    for (let round = 0; round < 3; round += 1) {
        const predecessorId = registry(w)[containerName].containerId;
        w.change('media', NONE);
        enabled(w, 'media');
        assertCommittedSuccessor(w, containerName, { predecessorId });
        assert.deepEqual(Object.keys(engineContainers(w)), [containerName]);
        assert.deepEqual(receipts(w), []);
    }
});

// ------------------------------------------------------------------
// Interruption (process kill; not host power loss).

test('an enable killed after its receipt but before the rotated registry leaves only an inert receipt', (t) => {
    const w = workspace(t, { media: NONE });
    const containerName = enabled(w, 'media').result.containerName;
    const registryBytes = fs.readFileSync(agentsFile(w));
    const runtimeBefore = engineContainers(w);

    w.change('media', NONE);
    enabled(w, 'media', { killAfterReceipt: true }, { killed: true });
    assert.deepEqual(fs.readFileSync(agentsFile(w)), registryBytes, 'the registry was not rotated');
    assert.deepEqual(engineContainers(w), runtimeBefore, 'the predecessor was not touched');
    const [inert] = receipts(w);
    assert.ok(inert, 'the receipt was written first');
    assert.notEqual(inert.successor.instanceId, registry(w)[containerName].instanceId);
    assert.deepEqual(w.drive('lookup', { containerName }), { ok: true, receipt: null }, 'it binds no record');
    assert.equal(w.drive('generation').selector, 'active', 'the receipt precedes inactivation, so the selector stayed active');

    // The next enable proceeds normally; the inert file may remain but never
    // binds the final registry.
    enabled(w, 'media');
    assertCommittedSuccessor(w, containerName, { predecessorId: runtimeBefore[containerName].id });
    assert.deepEqual(receipts(w).map((entry) => entry.name), [inert.name]);
});

function killedAfterRegistry(t, manifest = NONE, { staticRoot = false } = {}) {
    const w = workspace(t, { media: manifest, bystander: NONE, ...(staticRoot ? { root: NONE } : {}) });
    let rootName = null;
    if (staticRoot) {
        // An independent, unchanged static root; the target stays non-static.
        assert.equal(w.drive('static-root', { agent: 'root' }).ok, true);
        rootName = enabled(w, 'root').result.containerName;
    }
    const bystander = enabled(w, 'bystander').result.containerName;
    const containerName = enabled(w, 'media').result.containerName;
    const predecessor = registry(w)[containerName];
    const bystanderRuntime = engineContainers(w)[bystander];
    w.change('media', manifest);
    enabled(w, 'media', { killAfterRegistry: true }, { killed: true });
    return { w, containerName, predecessor, bystander, bystanderRuntime, rootName };
}

test('an enable killed after the rotated registry leaves its predecessor provable and bound', (t) => {
    const { w, containerName, predecessor } = killedAfterRegistry(t);
    const staged = registry(w)[containerName];
    assert.notEqual(staged.instanceId, predecessor.instanceId);
    assert.equal(staged.containerId, predecessor.containerId, 'the rotated record keeps the predecessor container ID');
    assert.equal(staged.runtime, 'podman');
    const runtime = engineContainers(w)[containerName];
    assert.equal(runtime.id, predecessor.containerId);
    assert.equal(runtime.instanceId, predecessor.instanceId, 'the predecessor still carries its own tuple');
    const lookup = w.drive('lookup', { containerName });
    assert.equal(lookup.ok, true, JSON.stringify(lookup));
    assert.equal(lookup.receipt.predecessor.instanceId, predecessor.instanceId);
    assert.equal(lookup.receipt.predecessor.enableGeneration, predecessor.enableGeneration);
    assert.equal(lookup.receipt.predecessor.containerId, predecessor.containerId);
    assert.equal(lookup.receipt.successor.instanceId, staged.instanceId);
    assert.notEqual(w.drive('generation').selector, 'active');
});

test('a workspace start recovers a killed enable: it removes only the original predecessor and retires its proof', (t) => {
    const { w, containerName, predecessor, bystander, rootName } = killedAfterRegistry(t, NONE, { staticRoot: true });
    const untouched = Object.fromEntries([rootName, bystander].map((name) => [name, {
        record: registry(w)[name], runtime: engineRecord(w, name),
    }]));
    const callsBefore = calls(w).length;
    const recovered = w.drive('stage', { staticAgent: 'repo/root' });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    t.diagnostic(`graph replacement: ${JSON.stringify(recovered.lines)}`);
    // Ordinary graph planning selects only the target, for its own reason.
    assert.deepEqual(recovered.changedContainers, [containerName]);
    assert.match(recovered.lines.find((line) => line.includes('replacing its runtime')), /runtimeIdentityDrift/);
    const after = calls(w).slice(callsBefore);
    const removed = callIndex(after, (argv) => argv[0] === 'rm' && argv.includes(predecessor.containerId));
    const created = callIndex(after, (argv) => argv[0] === 'create' && argv.includes(containerName));
    assert.ok(removed >= 0 && created > removed, 'exact predecessor removal precedes the successor');
    assert.equal(after.filter((argv) => argv[0] === 'rm').length, 1, 'only the original predecessor was removed');
    assertCommittedSuccessor(w, containerName, { predecessorId: predecessor.containerId });
    assert.deepEqual(receipts(w), []);
    for (const [name, before] of Object.entries(untouched)) {
        assert.deepEqual(registry(w)[name], before.record, `${name} record unchanged`);
        assert.deepEqual(engineRecord(w, name), before.runtime, `${name} runtime unchanged`);
    }
});

test('a later explicit enable recovers a killed enable by carrying its proof forward', (t) => {
    const { w, containerName, predecessor, bystander, bystanderRuntime } = killedAfterRegistry(t);
    enabled(w, 'media');
    assertCommittedSuccessor(w, containerName, { predecessorId: predecessor.containerId });
    assert.deepEqual(engineContainers(w)[bystander], bystanderRuntime);
    assert.deepEqual(receipts(w), [], 'both the carried and the consumed receipts were retired');
});

test('an enable killed after the exact removal but before retiring the proof leaves that proof bound', (t) => {
    const w = workspace(t, { media: NONE });
    const containerName = enabled(w, 'media').result.containerName;
    const predecessorId = registry(w)[containerName].containerId;
    w.change('media', NONE);
    enabled(w, 'media', {}, { killed: true, extraEnv: { FAKE_SHIM_KILL_CALLER_AFTER_RM: predecessorId } });
    assert.deepEqual(engineContainers(w), {}, 'the predecessor was removed and nothing created');
    const lookup = w.drive('lookup', { containerName });
    assert.equal(lookup.receipt?.predecessor?.containerId, predecessorId, 'its proof is still bound');
    assert.equal(registry(w)[containerName].containerId, predecessorId);
    // A launch killed after preparation leaves its replacement preparation
    // outstanding; outside a Box no enable or start may retire it (the host
    // `ploinky stop` / `ploinky start` of the Box does). Nothing is touched.
    const refused = w.drive('stage', { staticAgent: 'repo/media' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'EDGE_PREPARATION_BUSY', JSON.stringify(refused));
    assert.deepEqual(engineContainers(w), {});
    assert.equal(w.drive('lookup', { containerName }).receipt?.predecessor?.containerId, predecessorId);
});

test('a failed proof retirement after the exact removal aborts before any successor and is recovered once absence is proven', (t) => {
    const w = workspace(t, { media: NONE });
    const containerName = enabled(w, 'media').result.containerName;
    const predecessorId = registry(w)[containerName].containerId;
    w.change('media', NONE);
    const failed = w.drive('enable', { agent: 'repo/media', failReceiptRetire: true });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS', JSON.stringify(failed));
    assert.match(failed.cause, /injected receipt retirement failure/);
    assert.deepEqual(engineContainers(w), {}, 'the predecessor was removed and no successor was created');
    assert.equal(w.drive('lookup', { containerName }).receipt?.predecessor?.containerId, predecessorId);
    assert.notEqual(w.drive('generation').selector, 'active');

    enabled(w, 'media');
    assertCommittedSuccessor(w, containerName, { predecessorId });
    assert.deepEqual(receipts(w), []);
});

// ------------------------------------------------------------------
// Unknown ownership never removes anything and keeps the proof.

for (const [label, mutate, failInspection] of [
    ['another container under the same name', (containers, name) => {
        containers[name] = { ...containers[name], Id: 'f'.repeat(64) };
    }],
    ['the recorded container with a different tuple', (containers, name) => {
        const entry = containers[name];
        entry.Labels = { ...entry.Labels, [INSTANCE_LABEL]: 'foreign-instance' };
        entry.Config.Labels = entry.Labels;
    }],
    ['the recorded container of another workspace', (containers, name) => {
        const entry = containers[name];
        entry.Labels = { ...entry.Labels, [WORKSPACE_LABEL]: 'e'.repeat(64) };
        entry.Config.Labels = entry.Labels;
    }],
    ['an engine that cannot inspect the recorded ID', null, true],
]) {
    test(`a carried predecessor receipt never authorizes removing ${label}`, (t) => {
        const { w, containerName, predecessor } = killedAfterRegistry(t);
        if (mutate) editEngine(w, (containers) => mutate(containers, containerName));
        const before = engineContainers(w);
        const callsBefore = calls(w).length;
        const refused = w.drive('enable', { agent: 'repo/media' }, failInspection ? {
            extraEnv: { FAKE_SHIM_RULE: JSON.stringify({
                command: ['container', 'inspect'], id: predecessor.containerId, status: 125, stderr: 'Error: engine unavailable',
            }) },
        } : {});
        assert.equal(refused.ok, false, JSON.stringify(refused));
        assert.match(refused.message, label.includes('another workspace')
            ? /refusing to replace foreign\/unsupported exact-name container/
            : /preserved container '.*' because exact immutable ownership\/removal was not proven/);
        assert.deepEqual(engineContainers(w), before, 'nothing was stopped, removed or created');
        assert.equal(calls(w).slice(callsBefore).some((argv) => ['rm', 'stop', 'kill', 'create'].includes(argv[0])), false);
        const lookup = w.drive('lookup', { containerName });
        assert.equal(lookup.ok, true, JSON.stringify(lookup));
        assert.equal(lookup.receipt.predecessor.containerId, predecessor.containerId, 'the proof stays bound');
        assert.equal(lookup.receipt.predecessor.instanceId, predecessor.instanceId);
        assert.notEqual(w.drive('generation').selector, 'active', 'no selector was falsely activated');
    });
}

// ------------------------------------------------------------------
// Refusals before any registry publication.

function assertUnpublished(w, registryBytes, runtimeBefore, selector) {
    assert.deepEqual(fs.readFileSync(agentsFile(w)), registryBytes, 'the registry was not rotated');
    assert.deepEqual(engineContainers(w), runtimeBefore, 'the runtime was not touched');
    assert.equal(w.drive('generation').selector, selector);
}

test('a failed receipt write refuses the replacement before the registry or selector changes', (t) => {
    const w = workspace(t, { media: NONE });
    const containerName = enabled(w, 'media').result.containerName;
    const registryBytes = fs.readFileSync(agentsFile(w));
    const runtimeBefore = engineContainers(w);
    w.change('media', NONE);
    const refused = w.drive('enable', { agent: 'repo/media', failReceiptWrite: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'EIO');
    assert.match(refused.message, /injected receipt write failure/);
    assertUnpublished(w, registryBytes, runtimeBefore, 'active');
    assert.deepEqual(receipts(w), []);
    assert.deepEqual(w.drive('lookup', { containerName }), { ok: true, receipt: null });
});

test('a failed registry write after the receipt leaves that receipt inert', (t) => {
    const w = workspace(t, { media: NONE });
    const containerName = enabled(w, 'media').result.containerName;
    const registryBytes = fs.readFileSync(agentsFile(w));
    const runtimeBefore = engineContainers(w);
    w.change('media', NONE);
    const refused = w.drive('enable', { agent: 'repo/media', failRegistryRename: true });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /injected registry write failure/);
    assert.deepEqual(fs.readFileSync(agentsFile(w)), registryBytes);
    assert.deepEqual(engineContainers(w), runtimeBefore);
    assert.equal(receipts(w).length, 1);
    assert.deepEqual(w.drive('lookup', { containerName }), { ok: true, receipt: null });
});

for (const [label, edit, code, pattern] of [
    ['a malformed recorded container ID', { set: { containerId: 'abc' } },
        'PLOINKY_RUNTIME_PREDECESSOR_INVALID', /requires an exact registered predecessor tuple/],
    ['a recorded container engine other than the resolved one', { set: { runtime: 'docker' } },
        'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS', /recorded on the 'docker' engine but its successor resolves to 'podman'/],
]) {
    test(`${label} refuses the replacement before staging`, (t) => {
        const w = workspace(t, { media: NONE });
        const containerName = enabled(w, 'media').result.containerName;
        const edited = w.drive('edit-registry', { containerName, ...edit });
        assert.equal(edited.ok, true, JSON.stringify(edited));
        const registryBytes = fs.readFileSync(agentsFile(w));
        const runtimeBefore = engineContainers(w);
        w.change('media', NONE);
        const refused = w.drive('enable', { agent: 'repo/media' });
        assert.equal(refused.ok, false);
        assert.equal(refused.code, code, JSON.stringify(refused));
        assert.match(refused.message, pattern);
        assertUnpublished(w, registryBytes, runtimeBefore, 'active');
        assert.deepEqual(receipts(w), []);
    });
}

for (const [label, corrupt, code, pattern] of [
    ['an unparseable bound receipt', () => '{"schemaVersion":1,',
        'VERIFIED_FILE_INVALID', /verified JSON is not one valid JSON document/],
    ['a bound receipt naming another container ID', (document) => JSON.stringify({
        ...document, predecessor: { ...document.predecessor, containerId: 'f'.repeat(64) },
    }), 'PLOINKY_RUNTIME_PREDECESSOR_INVALID', /does not match the exact registered record/],
]) {
    test(`${label} refuses the replacement before publication`, (t) => {
        const { w } = killedAfterRegistry(t);
        const [{ name, ...document }] = receipts(w);
        const corrupted = corrupt(document);
        fs.writeFileSync(path.join(receiptDir(w), name), corrupted);
        const registryBytes = fs.readFileSync(agentsFile(w));
        const runtimeBefore = engineContainers(w);
        const selector = w.drive('generation').selector;
        const refused = w.drive('enable', { agent: 'repo/media' });
        assert.equal(refused.ok, false);
        assert.equal(refused.code, code, JSON.stringify(refused));
        assert.match(refused.message, pattern);
        assertUnpublished(w, registryBytes, runtimeBefore, selector);
        assert.equal(fs.readFileSync(path.join(receiptDir(w), name), 'utf8'), corrupted, 'the receipt is preserved');
    });
}

for (const [label, manifest, native] of [
    ['a managed (default) network', withNetwork('default')],
    ['a managed (bridge) network', withNetwork('bridge')],
    ['a native runtime', { ...HOST, 'lite-sandbox': true }, true],
]) {
    test(`pending selected proof refuses a transition to ${label} before publication`, (t) => {
        const { w, containerName } = killedAfterRegistry(t);
        if (native) assert.equal(w.drive('allow-host-sandbox').ok, true);
        const registryBytes = fs.readFileSync(agentsFile(w));
        const runtimeBefore = engineContainers(w);
        const receiptsBefore = receipts(w);
        const selector = w.drive('generation').selector;
        w.change('media', manifest);
        const refused = w.drive('enable', { agent: 'repo/media' });
        assert.equal(refused.ok, false);
        assert.equal(refused.code, 'PLOINKY_RUNTIME_PREDECESSOR_PENDING', JSON.stringify(refused));
        assertUnpublished(w, registryBytes, runtimeBefore, selector);
        assert.deepEqual(receipts(w), receiptsBefore, 'the selected proof is preserved');
        assert.equal(w.drive('lookup', { containerName }).receipt.predecessor.containerId, runtimeBefore[containerName].id);
    });
}

// ------------------------------------------------------------------
// Eligibility follows the resolved successor's launch path.

const BASE_STAGED_KEYS = [
    'agentName', 'auth', 'config', 'containerImage', 'createdAt', 'enableGeneration',
    'instanceId', 'profile', 'projectPath', 'repoName', 'runMode', 'type',
];

function seeded(t, manifests, records) {
    const w = workspace(t, manifests);
    const seededResult = w.drive('seed', { records });
    assert.equal(seededResult.ok, true, JSON.stringify(seededResult));
    return { w, names: seededResult.names };
}

const PREDECESSOR = (agent, extra = {}) => ({
    agent,
    instanceId: `${agent}-instance`,
    enableGeneration: `${agent}-generation`,
    containerId: 'c'.repeat(64),
    runtime: 'podman',
    ...extra,
});

for (const [label, manifest, profile] of [
    ['a default-network re-enable', withNetwork('default')],
    ['a bridge-network re-enable', withNetwork('bridge')],
    ['a top-level host manifest whose selected profile is bridge', {
        ...HOST, profiles: { default: {}, bridged: { network: BRIDGE_NETWORK } },
    }, 'bridged'],
]) {
    test(`${label} stages no receipt and no predecessor provenance`, (t) => {
        const { w, names } = seeded(t, { web: manifest }, [PREDECESSOR('web', profile ? { profile } : {})]);
        w.change('web', manifest);
        const prepared = w.drive('prepare', { agent: 'repo/web', ...(profile ? { profile } : {}) });
        assert.equal(prepared.ok, true, JSON.stringify(prepared));
        assert.equal(prepared.mode, 'replacement');
        assert.deepEqual(Object.keys(prepared.staged).sort(), BASE_STAGED_KEYS, 'the staged record keeps its base shape');
        assert.deepEqual(receipts(w), [], 'no receipt is written for a path that cannot consume it');
        assert.equal(prepared.trace.some((entry) => entry.event === 'receipt'), false);
        assert.deepEqual(w.drive('lookup', { containerName: names.web }), { ok: true, receipt: null });
    });
}

for (const [label, manifest, profile] of [
    ['a managed predecessor re-enabled on a none network', NONE],
    ['a top-level bridge manifest whose selected profile is host', {
        ...withNetwork('bridge'), profiles: { default: {}, hosted: { network: { mode: 'host' } } },
    }, 'hosted'],
]) {
    test(`${label} binds its predecessor before publication`, (t) => {
        const { w, names } = seeded(t, { web: manifest }, [PREDECESSOR('web', profile ? { profile } : {})]);
        w.change('web', manifest);
        const prepared = w.drive('prepare', { agent: 'repo/web', ...(profile ? { profile } : {}) });
        assert.equal(prepared.ok, true, JSON.stringify(prepared));
        assert.equal(prepared.staged.containerId, 'c'.repeat(64));
        assert.equal(prepared.staged.runtime, 'podman');
        const receiptWrite = prepared.trace.findIndex((entry) => entry.event === 'receipt');
        const registryWrite = prepared.trace.findIndex((entry) => entry.event === 'registry');
        assert.ok(receiptWrite >= 0 && receiptWrite < registryWrite, JSON.stringify(prepared.trace));
        const lookup = w.drive('lookup', { containerName: names.web });
        assert.equal(lookup.receipt.predecessor.instanceId, 'web-instance');
        assert.equal(lookup.receipt.successor.instanceId, prepared.staged.instanceId);
    });
}

test('a native predecessor re-enabled as a none container stages no receipt', (t) => {
    const { w, names } = seeded(t, { web: NONE }, [PREDECESSOR('web', { containerId: undefined, runtime: 'seatbelt' })]);
    w.change('web', NONE);
    const prepared = w.drive('prepare', { agent: 'repo/web' });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.deepEqual(Object.keys(prepared.staged).sort(), BASE_STAGED_KEYS);
    assert.deepEqual(receipts(w), []);
    assert.deepEqual(w.drive('lookup', { containerName: names.web }), { ok: true, receipt: null });
});

for (const [label, successor] of [['none', NONE], ['host', HOST]]) {
    test(`an absent managed predecessor is proven absent and a ${label} successor is created (never a present-runtime removal)`, (t) => {
        const { w, names } = seeded(t, { web: withNetwork('default') }, [PREDECESSOR('web')]);
        assert.deepEqual(engineContainers(w), {}, 'the recorded predecessor has no runtime');
        const callsBefore = calls(w).length;
        w.change('web', successor);
        const result = enabled(w, 'web');
        const after = calls(w).slice(callsBefore);
        assert.equal(after.some((argv) => argv[0] === 'rm'), false, 'nothing present was removed');
        assert.ok(after.some((argv) => argv[0] === 'container' && argv[1] === 'inspect' && argv.includes('c'.repeat(64))),
            'its absence was proven by its exact ID');
        const receiptWrite = result.trace.findIndex((entry) => entry.event === 'receipt');
        const registryWrite = result.trace.findIndex((entry) => entry.event === 'registry');
        assert.ok(receiptWrite >= 0 && receiptWrite < registryWrite, JSON.stringify(result.trace));
        assertCommittedSuccessor(w, names.web, { predecessorId: 'c'.repeat(64) });
        assert.deepEqual(receipts(w), []);
    });
}

test('a none runtime re-enabled on a managed network keeps the base managed dispatch outcome', (t) => {
    const w = workspace(t, { media: NONE });
    const containerName = enabled(w, 'media').result.containerName;
    const runtimeBefore = engineContainers(w);
    w.change('media', withNetwork('default'));
    const result = w.drive('enable', { agent: 'repo/media' });
    // The base outcome of this transition: the managed launch refuses the
    // differently contracted predecessor without touching it.
    assert.equal(result.ok, false);
    assert.match(result.message, /refusing to replace foreign\/unsupported exact-name container/);
    assert.deepEqual(engineContainers(w), runtimeBefore);
    assert.equal(result.trace.some((entry) => entry.event === 'receipt'), false);
    assert.deepEqual(receipts(w), []);
    const staged = registry(w)[containerName];
    assert.deepEqual(Object.keys(staged).sort(), BASE_STAGED_KEYS);
    assert.deepEqual(w.drive('lookup', { containerName }), { ok: true, receipt: null });
});

// ------------------------------------------------------------------
// A different effective network contract keeps the existing guard.
//
// The launch inspects a present runtime against its successor's network
// contract hash, so a predecessor of another contract is refused as foreign
// before the receipt consumer is reached. That guard is unchanged: preparation
// has already published the rotated record and its receipt, and the refusal
// must leave the predecessor, its proof and the inactive routing exactly so.

const DESTRUCTIVE = new Set(['rm', 'stop', 'kill', 'create', 'start']);

// A published managed runtime with a signed descriptor (see the driver), or
// a host/none runtime enabled through production.
function presentPredecessor(w, agent, kind) {
    if (kind === 'enabled') {
        const containerName = enabled(w, agent).result.containerName;
        return { containerName, containerId: registry(w)[containerName].containerId };
    }
    const fixture = w.drive('managed-predecessor', {
        agent, network: kind === 'bridge' ? BRIDGE_NETWORK : { mode: kind },
    });
    assert.equal(fixture.ok, true, JSON.stringify(fixture));
    // The rendered semantic label is the one the graph's retained managed
    // recomputation expects, so no replacement reason is manufactured.
    assert.match(fixture.envHash, /^[a-f0-9]{64}$/);
    assert.equal(fixture.retainedEnvHash, fixture.envHash);
    assert.equal(engineRecord(w, fixture.containerName).Labels['ploinky.envhash'], fixture.envHash);
    return fixture;
}

function refusedByContract(w, agent, successor, { profile } = {}) {
    const containerName = Object.keys(registry(w)).find((key) => registry(w)[key]?.agentName === agent);
    const predecessor = registry(w)[containerName];
    const runtimeBefore = engineRecord(w, containerName);
    const callsBefore = calls(w).length;
    w.change(agent, successor);
    const refused = w.drive('enable', { agent: `repo/${agent}`, ...(profile ? { profile } : {}) });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(refused.message, /refusing to replace foreign\/unsupported exact-name container/);
    // The predecessor proof was durable before the rotated record.
    const receiptWrite = refused.trace.findIndex((entry) => entry.event === 'receipt');
    const registryWrite = refused.trace.findIndex((entry) => entry.event === 'registry');
    assert.ok(receiptWrite >= 0 && receiptWrite < registryWrite, JSON.stringify(refused.trace));
    // Runtime: the exact prior ID, labels, mounts and state, untouched.
    assert.deepEqual(engineRecord(w, containerName), runtimeBefore);
    const after = calls(w).slice(callsBefore);
    assert.equal(after.some((argv) => DESTRUCTIVE.has(argv[0])), false, JSON.stringify(after));
    // Registry: the staged successor tuple keeps the original ID and engine.
    const staged = registry(w)[containerName];
    assert.notEqual(staged.instanceId, predecessor.instanceId);
    assert.equal(staged.containerId, predecessor.containerId);
    assert.equal(staged.runtime, 'podman');
    // Receipt: valid selected proof of the original predecessor.
    const lookup = w.drive('lookup', { containerName });
    assert.equal(lookup.ok, true, JSON.stringify(lookup));
    assert.equal(lookup.receipt.successor.instanceId, staged.instanceId);
    assert.equal(lookup.receipt.predecessor.instanceId, predecessor.instanceId);
    assert.equal(lookup.receipt.predecessor.enableGeneration, predecessor.enableGeneration);
    assert.equal(lookup.receipt.predecessor.containerId, predecessor.containerId);
    assert.deepEqual(lookup.receipt.predecessor.config.binds,
        (predecessor.config.binds || []).filter((bind) => bind.generatedRouterDescriptor === true));
    // Routing: the replacement stays inactive; nothing was reactivated.
    const generation = w.drive('generation');
    assert.equal(generation.ok, false);
    assert.equal(generation.selector, 'inactive');
    return { containerName, predecessor, runtimeBefore, staged };
}

for (const [label, kind, successor] of [
    ['a present managed (default) runtime re-enabled as none', 'default', NONE],
    ['a present managed (bridge) runtime re-enabled as host', 'bridge', HOST],
    ['a present none runtime re-enabled as host', 'enabled-none', HOST],
    ['a present host runtime re-enabled as none', 'enabled-host', NONE],
]) {
    test(`${label} keeps the contract refusal, its runtime and its proof`, (t) => {
        const initial = kind === 'enabled-host' ? HOST : kind === 'enabled-none' ? NONE
            : withNetwork(kind);
        const w = workspace(t, { web: initial });
        const present = presentPredecessor(w, 'web', kind.startsWith('enabled') ? 'enabled' : kind);
        const refused = refusedByContract(w, 'web', successor);
        assert.equal(refused.predecessor.containerId, present.containerId);
        if (!kind.startsWith('enabled')) {
            assert.equal(refused.runtimeBefore.Mounts.filter((mount) => mount.Destination === '/run/ploinky/router-descriptor.json').length, 1);
            assert.deepEqual(refused.predecessor.config.binds.map((bind) => bind.source), [present.descriptorFile]);
            assert.ok(fs.existsSync(present.descriptorFile), 'the signed descriptor is preserved');
        }
    });
}

test('a selected profile that changes the effective contract keeps the same refusal', (t) => {
    const manifest = { ...NONE, profiles: { default: {}, hosted: { network: { mode: 'host' } } } };
    const w = workspace(t, { web: manifest });
    presentPredecessor(w, 'web', 'enabled');
    refusedByContract(w, 'web', manifest, { profile: 'hosted' });
});

test('a profile and manifest change that keeps the effective contract still replaces exactly', (t) => {
    const manifest = { ...NONE, profiles: { default: {}, quiet: { network: { mode: 'none' } } } };
    const w = workspace(t, { web: manifest });
    const { containerName, containerId } = presentPredecessor(w, 'web', 'enabled');
    w.change('web', manifest);
    const result = enabled(w, 'web', { profile: 'quiet' });
    assert.equal(result.trace.find((entry) => entry.event === 'registry').selector, 'inactive');
    assertCommittedSuccessor(w, containerName, { predecessorId: containerId });
    assert.equal(registry(w)[containerName].profile, 'quiet');
    assert.deepEqual(receipts(w), []);
});

// The supported recovery of such a refusal is a workspace start whose
// ordinary graph planning selects replacement. The static root is an
// independent, unchanged agent; the refused target stays non-static.
function refusedBesideStaticRoot(t, kind, initial, successor) {
    const w = workspace(t, { root: NONE, web: initial });
    assert.equal(w.drive('static-root', { agent: 'root' }).ok, true);
    const rootName = enabled(w, 'root').result.containerName;
    presentPredecessor(w, 'web', kind);
    const refused = refusedByContract(w, 'web', successor);
    const root = { record: registry(w)[rootName], runtime: engineRecord(w, rootName) };
    return { w, rootName, root, ...refused };
}

for (const [label, kind, initial, successor] of [
    ['a refused managed (default) to none replacement', 'default', withNetwork('default'), NONE],
    ['a refused none to host replacement', 'enabled', NONE, HOST],
]) {
    test(`a workspace start recovers ${label} through ordinary graph planning`, (t) => {
        const { w, rootName, root, containerName, predecessor } = refusedBesideStaticRoot(t, kind, initial, successor);
        const callsBefore = calls(w).length;
        const recovered = w.drive('stage', { staticAgent: 'repo/root' });
        assert.equal(recovered.ok, true, JSON.stringify(recovered));
        t.diagnostic(`graph replacement: ${JSON.stringify(recovered.lines)}`);
        // The graph selected the replacement for its own observed reason; the
        // static root kept its role and was not replaced.
        assert.deepEqual(recovered.changedContainers, [containerName]);
        const reasonLine = recovered.lines.find((line) => line.includes('replacing its runtime'));
        assert.match(reasonLine, /envHash/, 'the ordinary environment-hash drift selects replacement');
        const after = calls(w).slice(callsBefore);
        const removed = callIndex(after, (argv) => argv[0] === 'rm' && argv.includes(predecessor.containerId));
        const created = callIndex(after, (argv) => argv[0] === 'create' && argv.includes(containerName));
        assert.ok(removed >= 0 && created > removed, 'exact predecessor removal precedes the successor');
        assert.equal(after.filter((argv) => argv[0] === 'rm').length, 1);
        assertCommittedSuccessor(w, containerName, { predecessorId: predecessor.containerId });
        assert.equal(engineContainers(w)[containerName].network, successor.network.mode);
        assert.deepEqual(receipts(w), [], 'the carried proof was retired after the exact removal');
        assert.deepEqual(registry(w)[rootName], root.record);
        assert.deepEqual(engineRecord(w, rootName), root.runtime);
        if (kind !== 'enabled') {
            assert.equal(fs.existsSync(predecessor.config.binds[0].source), false, 'its descriptor went with it');
        }
    });
}

test('a graph removal failure after the refusal creates and activates nothing and keeps the proof', (t) => {
    const { w, containerName, predecessor, runtimeBefore } = refusedBesideStaticRoot(t, 'default', withNetwork('default'), NONE);
    const callsBefore = calls(w).length;
    const failed = w.drive('stage', { staticAgent: 'repo/root' }, {
        extraEnv: { FAKE_SHIM_RULE: JSON.stringify({
            command: ['rm'], id: predecessor.containerId, status: 1, stderr: 'Error: transient storage failure',
        }) },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS', JSON.stringify(failed));
    assert.match(failed.message, /preserved container '.*' because exact immutable ownership\/removal was not proven/);
    const after = calls(w).slice(callsBefore);
    assert.equal(after.some((argv) => argv[0] === 'create' || argv[0] === 'start'), false, JSON.stringify(after));
    // The exact removal signalled the predecessor by its immutable ID before
    // the failed rm; everything but its run state is unchanged.
    const { State: _stateAfter, ...runtimeAfter } = engineRecord(w, containerName);
    const { State: _stateBefore, ...runtimeExpected } = runtimeBefore;
    assert.deepEqual(runtimeAfter, runtimeExpected);
    assert.ok(after.filter((argv) => ['kill', 'stop', 'rm'].includes(argv[0]))
        .every((argv) => argv.at(-1) === predecessor.containerId), JSON.stringify(after));
    const lookup = w.drive('lookup', { containerName });
    assert.equal(lookup.receipt?.predecessor?.containerId, predecessor.containerId, 'the carried proof stays bound');
    assert.equal(w.drive('generation').selector, 'inactive');
});

test('a changed predecessor descriptor makes the graph removal refuse without touching the runtime', (t) => {
    const { w, containerName, predecessor, runtimeBefore } = refusedBesideStaticRoot(t, 'default', withNetwork('default'), NONE);
    const descriptorFile = predecessor.config.binds[0].source;
    // No longer the exact private 0600 artifact the launch recorded.
    fs.chmodSync(descriptorFile, 0o644);
    const changed = fs.readFileSync(descriptorFile);
    const callsBefore = calls(w).length;
    const refused = w.drive('stage', { staticAgent: 'repo/root' });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS', JSON.stringify(refused));
    assert.match(refused.cause, /not an exact 0600 regular file/, JSON.stringify(refused));
    assert.equal(calls(w).slice(callsBefore).some((argv) => DESTRUCTIVE.has(argv[0])), false);
    assert.deepEqual(engineRecord(w, containerName), runtimeBefore);
    assert.deepEqual(fs.readFileSync(descriptorFile), changed, 'the descriptor artifact is preserved');
    assert.equal(w.drive('lookup', { containerName }).receipt?.predecessor?.containerId, predecessor.containerId);
});

test('graph planning reaches its own final foreign-contract refusal only with no earlier replacement reason', (t) => {
    const w = workspace(t, { root: NONE, web: NONE });
    assert.equal(w.drive('static-root', { agent: 'root' }).ok, true);
    enabled(w, 'root');
    const { containerName } = presentPredecessor(w, 'web', 'enabled');
    // Control: the same running, exact graph has no replacement reason at all.
    const reused = w.drive('stage', { staticAgent: 'repo/root' });
    assert.equal(reused.ok, true, JSON.stringify(reused));
    assert.deepEqual(reused.changedContainers, []);
    // Only the contract label now differs: env hash, state and tuple still
    // match, so the graph's last check (its contract inspection) refuses.
    editEngine(w, (containers) => {
        const entry = containers[containerName];
        entry.Labels = { ...entry.Labels, 'io.assistos.ploinky.network-contract': 'e'.repeat(64) };
        entry.Config.Labels = entry.Labels;
    });
    const registryBytes = fs.readFileSync(agentsFile(w));
    const runtimeBefore = engineRecord(w, containerName);
    const callsBefore = calls(w).length;
    const refused = w.drive('stage', { staticAgent: 'repo/root' });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /refusing graph replacement of foreign runtime/);
    assert.deepEqual(refused.lines.filter((line) => line.includes('replacing its runtime')), []);
    assert.deepEqual(fs.readFileSync(agentsFile(w)), registryBytes);
    assert.deepEqual(engineRecord(w, containerName), runtimeBefore);
    assert.equal(calls(w).slice(callsBefore).some((argv) => DESTRUCTIVE.has(argv[0])), false);
    assert.deepEqual(receipts(w), []);
});

// ------------------------------------------------------------------
// Serialization: one enable holds the workspace lease across its slow launch.

test('a second enable and a Watchdog tick neither rotate nor replace a runtime while an enable holds the lease', async (t) => {
    const w = workspace(t, { media: NONE });
    const containerName = enabled(w, 'media').result.containerName;
    const predecessorId = registry(w)[containerName].containerId;
    // A stopped predecessor is what a Watchdog would otherwise restart.
    editEngine(w, (containers) => { containers[containerName].State = { Running: false, Status: 'exited' }; });
    w.change('media', NONE);
    const ready = path.join(w.root, 'first-ready');
    const release = path.join(w.root, 'first-release');
    const first = w.driveAsync('enable', { agent: 'repo/media', pauseAfterRegistry: { ready, release } });
    let second = null;
    let heldTuple;
    let events;
    try {
        const deadline = Date.now() + 60_000;
        while (!fs.existsSync(ready)) {
            assert.ok(Date.now() < deadline, 'first enable reached its registry write');
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const heldRegistry = fs.readFileSync(agentsFile(w));
        heldTuple = JSON.parse(heldRegistry)[containerName];
        const callsHeld = calls(w).length;

        second = w.driveAsync('enable', { agent: 'repo/media' });
        const monitored = w.drive('monitor', null, { extraEnv: { FAKE_SHIM_RUNNING_PS: '1' } });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.deepEqual(fs.readFileSync(agentsFile(w)), heldRegistry, 'no second tuple was published during the lease');
        assert.equal(engineContainers(w)[containerName].id, predecessorId);
        assert.equal(calls(w).slice(callsHeld).some((argv) => ['rm', 'create', 'start', 'stop', 'kill'].includes(argv[0])), false,
            JSON.stringify(calls(w).slice(callsHeld)));
        events = monitored.events.map((entry) => entry.event);
        // The Watchdog tick deferred to the operation holding the workspace lease
        // instead of restarting the stopped runtime.
        assert.ok(events.includes('container_monitor_deferred_workspace_start'), JSON.stringify(monitored.events));
        assert.equal(events.some((event) => /restart_success|restart_attempt|scheduling_restart/.test(event)), false,
            JSON.stringify(monitored.events));
    } catch (error) {
        // Never leave the paused enable (or the waiting one) running.
        fs.writeFileSync(release, '1');
        await Promise.allSettled([first, second]);
        throw error;
    }
    fs.writeFileSync(release, '1');
    const [firstRun, secondRun] = await Promise.all([first, second]);
    const firstResult = JSON.parse(firstRun.stdout.trim().split('\n').at(-1));
    assert.equal(firstResult.ok, true, `${firstRun.stdout}\n${firstRun.stderr}`);
    const secondResult = JSON.parse(secondRun.stdout.trim().split('\n').at(-1));
    t.diagnostic(`second enable: ${JSON.stringify({ ok: secondResult.ok, code: secondResult.code ?? null })}`);
    t.diagnostic(`monitor events: ${JSON.stringify(events)}`);
    // The second enable waited for the lease (or reported it busy); either way
    // it acted only on the first enable's published successor.
    if (secondResult.ok) {
        assert.notEqual(registry(w)[containerName].instanceId, heldTuple.instanceId);
    } else {
        assert.match(secondResult.message, /busy|lease|lock/i, JSON.stringify(secondResult));
        assert.equal(registry(w)[containerName].instanceId, heldTuple.instanceId);
    }
    assertCommittedSuccessor(w, containerName, { predecessorId });
    assert.deepEqual(Object.keys(engineContainers(w)), [containerName]);
    assert.deepEqual(receipts(w), []);
});
