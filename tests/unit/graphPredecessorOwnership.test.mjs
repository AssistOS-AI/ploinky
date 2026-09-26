// A workspace start rotates the identity of every stopped or changed graph
// runtime and persists that rotated registry before it removes the
// predecessors. The registry record keeps the predecessor's container ID under
// the fresh tuple, so once the start stops between that write and the last
// removal (a cancelled update's rollback, a transient engine failure), the
// next start can no longer prove that it owns the predecessors still present:
// "[workspaceGraph:...:runtimeStopped] preserved container ... because exact
// immutable ownership/removal was not proven", and the rollback cannot
// restore the graph. Every engine call here goes to the stateful fake engine
// behind the real exact-removal routine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { installFakeEngine } from './dependencyStoreFakeEngine.mjs';
import { tempRoot } from './dependencyStoreFixtures.mjs';

const DRIVER = path.resolve(import.meta.dirname, 'graphPredecessorOwnershipDriver.mjs');
const AGENTS = ['alpha', 'beta', 'gamma'];
const MANIFEST = { container: 'node:20', start: 'node index.js', network: { mode: 'none' }, readiness: { protocol: 'none' } };
const INSTANCE_LABEL = 'io.assistos.ploinky.instance-id';
const GENERATION_LABEL = 'io.assistos.ploinky.enable-generation';

// Fails the named engine command once for one exact container ID, then
// behaves as the fake engine again.
const SHIM_SOURCE = String.raw`#!/usr/bin/env node
const fs = require('fs'); const { spawnSync } = require('child_process');
const argv = process.argv.slice(2);
const rule = process.env.FAKE_SHIM_RULE ? JSON.parse(process.env.FAKE_SHIM_RULE) : null;
if (rule && argv.includes(rule.id) && argv.slice(0, rule.command.length).join(' ') === rule.command.join(' ')
    && (!rule.once || !fs.existsSync(rule.once))) {
  if (rule.once) fs.writeFileSync(rule.once, '1');
  process.stderr.write(rule.stderr + '\n');
  process.exit(rule.status);
}
const run = spawnSync(process.env.FAKE_SHIM_ENGINE, argv, { stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
`;

function workspace(t) {
    const root = fs.realpathSync(tempRoot(t, 'graph-predecessor-'));
    const ws = path.join(root, 'ws');
    for (const name of AGENTS) {
        const dir = path.join(ws, '.ploinky', 'repos', 'repo', name);
        fs.mkdirSync(path.join(dir, 'code'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
        fs.writeFileSync(path.join(dir, 'code', 'index.js'), 'console.log(1)\n');
    }
    fs.mkdirSync(path.join(ws, '.ploinky', 'data'), { recursive: true });
    const engine = installFakeEngine(root, { engines: ['podman'] });
    const shimDir = path.join(root, 'shim-bin');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'podman'), SHIM_SOURCE, { mode: 0o755 });
    const env = {
        ...process.env,
        ...engine.env,
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
    const drive = (phase, argument, { killed = false, rule = null } = {}) => {
        const run = spawnSync(process.execPath, [DRIVER, phase, ...(argument ? [JSON.stringify(argument)] : [])], {
            cwd: ws,
            env: rule ? {
                ...env,
                PATH: [shimDir, env.PATH].join(path.delimiter),
                FAKE_SHIM_ENGINE: path.join(engine.binDir, 'podman'),
                FAKE_SHIM_RULE: JSON.stringify(rule),
            } : env,
            encoding: 'utf8',
            timeout: 120_000,
        });
        if (killed) {
            assert.equal(run.signal, 'SIGKILL', `${phase} was expected to stop mid-way: ${run.stdout}\n${run.stderr}`);
            return null;
        }
        assert.equal(run.status, 0, `${phase}: ${run.stdout}\n${run.stderr}`);
        return JSON.parse(run.stdout.trim().split('\n').at(-1));
    };
    return { root, ws, engine, drive };
}

const container = (name) => `ploinky_repo_${name}`;

function engineContainers(w) {
    return Object.fromEntries(Object.values(w.engine.state().containers).map((entry) => [entry.Name, {
        id: entry.Id,
        instanceId: entry.Labels[INSTANCE_LABEL],
        enableGeneration: entry.Labels[GENERATION_LABEL],
        status: entry.State.Status,
    }]));
}

function registry(w) {
    return JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'));
}

// The state a stopped start leaves: the predecessors it had not removed yet
// still carry their own tuple, while the registry names them by container ID
// under the rotated tuple.
function assertRotatedAheadOfPresentPredecessors(w, setup, present) {
    const containers = engineContainers(w);
    const records = registry(w);
    for (const name of present) {
        assert.equal(containers[container(name)].id, setup.containerIds[name]);
        assert.equal(containers[container(name)].instanceId, `${name}-instance`);
        const record = records[container(name)];
        assert.equal(record.containerId, setup.containerIds[name], `${name} keeps its predecessor container ID`);
        assert.notEqual(record.instanceId, `${name}-instance`, `${name} was rotated before its removal`);
        assert.notEqual(record.enableGeneration, `${name}-generation`);
    }
}

function assertEveryPredecessorRemoved(w, setup) {
    const ids = new Set(Object.values(engineContainers(w)).map((entry) => entry.id));
    for (const name of AGENTS) assert.equal(ids.has(setup.containerIds[name]), false, `${name} predecessor removed`);
}

function receiptFiles(w, kind) {
    const dir = path.join(w.ws, '.ploinky', 'run', kind);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name)) : [];
}

function predecessorReceipts(w) {
    return receiptFiles(w, 'runtime-predecessors').map((file) => ({ file, ...JSON.parse(fs.readFileSync(file, 'utf8')) }));
}

function candidateReceipts(w) {
    return receiptFiles(w, 'runtime-candidates').map((file) => ({ file, ...JSON.parse(fs.readFileSync(file, 'utf8')) }));
}

function editEngine(w, edit) {
    const state = w.engine.state();
    edit(state.containers);
    fs.writeFileSync(w.engine.stateFile, JSON.stringify(state, null, 2));
}

// The live rollback's starting point: beta removed, the start killed at
// gamma, alpha never reached. gamma's and alpha's receipts remain.
function killedAtGamma(t, setupArgument) {
    const w = workspace(t);
    const setup = w.drive('setup', setupArgument);
    w.drive('stage', { killAt: container('gamma') }, { killed: true });
    return { w, setup };
}

test('a start stopped during predecessor removal leaves the next start able to remove the rest exactly', (t) => {
    const w = workspace(t);
    const setup = w.drive('setup');
    assert.deepEqual(Object.keys(engineContainers(w)).sort(), AGENTS.map(container));

    // Stopped as the live rollback found it: removal runs in node-id order
    // (the two enabled agents outside the graph, then the static node), so
    // beta is removed, the start stops at gamma, and alpha was never reached.
    w.drive('stage', { killAt: container('gamma') }, { killed: true });
    assert.deepEqual(Object.keys(engineContainers(w)).sort(), [container('alpha'), container('gamma')]);
    assertRotatedAheadOfPresentPredecessors(w, setup, ['alpha', 'gamma']);
    // beta's proof was retired with beta; the two still present keep theirs,
    // bound to the rotated tuple and naming the predecessor's own tuple.
    const records = registry(w);
    const receipts = predecessorReceipts(w);
    assert.deepEqual(receipts.map((receipt) => receipt.containerName).sort(), [container('alpha'), container('gamma')]);
    for (const receipt of receipts) {
        const name = receipt.predecessor.agentName;
        assert.equal(receipt.successor.instanceId, records[container(name)].instanceId);
        assert.equal(receipt.predecessor.instanceId, `${name}-instance`);
        assert.equal(receipt.predecessor.enableGeneration, `${name}-generation`);
        assert.equal(receipt.predecessor.containerId, setup.containerIds[name]);
    }

    const restored = w.drive('stage');
    assert.equal(restored.staged, true, JSON.stringify(restored));
    assert.deepEqual([...restored.changedContainers].sort(), AGENTS.map(container));
    assertEveryPredecessorRemoved(w, setup);
    assert.deepEqual(predecessorReceipts(w), []);
});

test('a failed predecessor removal leaves the next start able to remove it exactly', (t) => {
    const w = workspace(t);
    const setup = w.drive('setup');

    const failed = w.drive('stage', null, {
        rule: {
            command: ['rm'], id: setup.containerIds.beta, status: 1,
            stderr: 'Error: transient storage failure', once: path.join(w.root, 'rm-failed-once'),
        },
    });
    assert.equal(failed.staged, false);
    assert.equal(failed.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
    assert.deepEqual(failed.removals, [container('beta')]);
    assertRotatedAheadOfPresentPredecessors(w, setup, ['alpha', 'beta', 'gamma']);

    assert.equal(predecessorReceipts(w).length, 3, 'no predecessor was removed, so every proof remains');

    const restored = w.drive('stage');
    assert.equal(restored.staged, true, JSON.stringify(restored));
    assertEveryPredecessorRemoved(w, setup);
    assert.deepEqual(predecessorReceipts(w), []);
});

test('a predecessor its launcher never published stays removable after a stopped start', (t) => {
    const { w, setup } = killedAtGamma(t, { unpublished: ['gamma'] });
    const record = registry(w)[container('gamma')];
    assert.equal(record.containerId, undefined);
    assert.notEqual(record.instanceId, 'gamma-instance');
    assert.equal(engineContainers(w)[container('gamma')].instanceId, 'gamma-instance');
    assert.deepEqual(candidateReceipts(w).map((receipt) => receipt.registryRecord.instanceId), ['gamma-instance']);

    const restored = w.drive('stage');
    assert.equal(restored.staged, true, JSON.stringify(restored));
    assertEveryPredecessorRemoved(w, setup);
    assert.deepEqual(candidateReceipts(w), []);
    assert.deepEqual(predecessorReceipts(w), []);
});

test('a start stopped after launching a rotated runtime but before publishing it stays recoverable', (t) => {
    const w = workspace(t);
    const setup = w.drive('setup');
    const staged = w.drive('stage', { launchAfter: ['alpha'] });
    assert.equal(staged.staged, true, JSON.stringify(staged));
    // The registry still names the removed predecessor; the launch receipt
    // names the runtime created in its place.
    assert.equal(registry(w)[container('alpha')].containerId, setup.containerIds.alpha);
    const [launchReceipt] = candidateReceipts(w);
    assert.equal(launchReceipt.containerId, staged.launched.alpha);
    assert.equal(launchReceipt.predecessorContainerId, setup.containerIds.alpha);
    spawnSync('podman', ['stop', staged.launched.alpha], { env: { ...process.env, ...w.engine.env } });

    const restored = w.drive('stage');
    assert.equal(restored.staged, true, JSON.stringify(restored));
    assert.equal(Object.values(engineContainers(w)).some((entry) => entry.id === staged.launched.alpha), false);
    assert.deepEqual(candidateReceipts(w), []);
});

test('a launch receipt that does not name the registered predecessor is refused', (t) => {
    const w = workspace(t);
    w.drive('setup');
    const staged = w.drive('stage', { launchAfter: ['alpha'] });
    spawnSync('podman', ['stop', staged.launched.alpha], { env: { ...process.env, ...w.engine.env } });
    const [launchReceipt] = candidateReceipts(w);
    const { file, ...document } = launchReceipt;
    fs.writeFileSync(file, JSON.stringify({ ...document, predecessorContainerId: 'e'.repeat(64) }));

    const refused = w.drive('stage');
    assert.equal(refused.staged, false);
    assert.equal(refused.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
    assert.match(refused.cause, /conflicts with the persisted launch receipt/);
    assert.equal(engineContainers(w)[container('alpha')].id, staged.launched.alpha);
});

for (const [label, replace] of [
    ['another container under the same name', (containers) => {
        containers[container('gamma')] = { ...containers[container('gamma')], Id: 'f'.repeat(64) };
    }],
    ['the recorded container with a different tuple', (containers) => {
        const entry = containers[container('gamma')];
        entry.Labels = { ...entry.Labels, [INSTANCE_LABEL]: 'foreign-instance' };
        entry.Config.Labels = entry.Labels;
    }],
]) {
    test(`a predecessor receipt never authorizes removing ${label}`, (t) => {
        const { w } = killedAtGamma(t);
        editEngine(w, replace);
        const before = engineContainers(w);

        const refused = w.drive('stage');
        assert.equal(refused.staged, false);
        assert.equal(refused.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
        assert.match(refused.message, /preserved container 'ploinky_repo_gamma'/);
        assert.deepEqual(engineContainers(w), before);
        assert.ok(predecessorReceipts(w).some((receipt) => receipt.containerName === container('gamma')));
    });
}

test('a predecessor receipt that does not bind to the registered record is refused before any removal', (t) => {
    const { w } = killedAtGamma(t);
    const receipt = predecessorReceipts(w).find((entry) => entry.containerName === container('gamma'));
    const { file, ...document } = receipt;
    fs.writeFileSync(file, JSON.stringify({ ...document, predecessor: { ...document.predecessor, containerId: 'f'.repeat(64) } }));
    const before = engineContainers(w);

    const refused = w.drive('stage');
    assert.equal(refused.staged, false);
    assert.equal(refused.code, 'PLOINKY_RUNTIME_PREDECESSOR_INVALID');
    assert.deepEqual(refused.removals, []);
    assert.deepEqual(engineContainers(w), before);
});

test('a malformed predecessor receipt is refused before any removal', (t) => {
    const { w } = killedAtGamma(t);
    const receipt = predecessorReceipts(w).find((entry) => entry.containerName === container('gamma'));
    fs.writeFileSync(receipt.file, '{"schemaVersion":1,');
    const before = engineContainers(w);

    const refused = w.drive('stage');
    assert.equal(refused.staged, false);
    assert.deepEqual(refused.removals, []);
    assert.deepEqual(engineContainers(w), before);
});

test('a start stopped before its rotated registry is written leaves only inert receipts', (t) => {
    const w = workspace(t);
    const setup = w.drive('setup');
    w.drive('stage', { killBeforeRegistrySave: true }, { killed: true });
    const records = registry(w);
    for (const name of AGENTS) assert.equal(records[container(name)].instanceId, `${name}-instance`);
    const orphans = predecessorReceipts(w);
    assert.equal(orphans.length, 3);

    const restored = w.drive('stage');
    assert.equal(restored.staged, true, JSON.stringify(restored));
    assertEveryPredecessorRemoved(w, setup);
    const current = registry(w);
    assert.deepEqual(predecessorReceipts(w).map((receipt) => receipt.file).sort(), orphans.map((receipt) => receipt.file).sort());
    for (const receipt of predecessorReceipts(w)) {
        assert.notEqual(receipt.successor.instanceId, current[receipt.containerName].instanceId);
    }
});

test('an absent predecessor keeps its receipt until the engine positively reports it missing', (t) => {
    const { w, setup } = killedAtGamma(t);
    // gamma disappeared before its proof was retired; the engine then fails to
    // answer for its exact ID.
    editEngine(w, (containers) => { delete containers[container('gamma')]; });
    const unknown = w.drive('stage', null, {
        rule: { command: ['container', 'inspect'], id: setup.containerIds.gamma, status: 125, stderr: 'Error: engine unavailable' },
    });
    assert.equal(unknown.staged, false);
    assert.equal(unknown.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
    assert.match(unknown.message, /preserved the predecessor receipt of 'ploinky_repo_gamma'/);
    const kept = predecessorReceipts(w).find((receipt) => receipt.containerName === container('gamma'));
    assert.equal(kept.predecessor.containerId, setup.containerIds.gamma);

    const restored = w.drive('stage');
    assert.equal(restored.staged, true, JSON.stringify(restored));
    assertEveryPredecessorRemoved(w, setup);
    assert.deepEqual(predecessorReceipts(w), []);
});
