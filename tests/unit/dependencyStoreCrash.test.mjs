import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createCacheStore } from '../../cli/utils/dependencies/store/objectStore.mjs';
import { buildSeedInstallPlan } from '../../cli/utils/dependencies/store/installContract.mjs';
import { fakeInstaller, fakeLease, hostProvider, makeAgentLib, tempRoot } from './dependencyStoreFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'dependencyStoreChildWorker.mjs');
const GLOBAL = Object.freeze({ name: 'g', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } });
const CONSUMER = Object.freeze({ kind: 'test-parent', process: { pid: process.pid } });

function fixture(t) {
    const root = tempRoot(t, 'depstore-crash-');
    const agentLib = makeAgentLib(root);
    const plan = buildSeedInstallPlan({ provider: hostProvider({ agentLib }), globalPackage: GLOBAL, agentLibSelection: agentLib });
    const depsDir = path.join(root, '.ploinky', 'deps');
    const { lease, assertLease } = fakeLease();
    const store = createCacheStore({ depsDir, workspaceRoot: root, assertLease, checkDiskSpace: () => ({ ok: true }) });
    return { root, plan: JSON.parse(JSON.stringify(plan)), depsDir, lease, store };
}

function childEnv(root) {
    const env = { ...process.env, PLOINKY_WORKSPACE_ROOT: root, PLOINKY_ROOT: root };
    return env;
}

function writeConfig(root, name, config) {
    const file = path.join(root, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
}

const CRASH_EXPECTATIONS = [
    ['receipt-published', { hit: false, classification: 'receipt-only-reclaimable' }],
    ['object-allocated', { hit: false, classification: 'unpublished-reclaimable' }],
    ['payload-installed', { hit: false, classification: 'unpublished-retained' }],
    ['verified', { hit: false, classification: 'unpublished-retained' }],
    ['manifest-written', { hit: false, classification: 'unpublished-retained' }],
    ['completion-written', { hit: false, classification: 'complete-unindexed' }],
    ['index-published', { hit: true, classification: 'rooted' }],
    ['reader-published', { hit: true, classification: 'rooted' }],
];

for (const [stage, expected] of CRASH_EXPECTATIONS) {
    test(`dependency store crash: a builder killed at ${stage} never yields an incomplete hit`, (t) => {
        const { root, plan, depsDir, lease, store } = fixture(t);
        const config = writeConfig(root, 'crash', {
            depsDir, workspaceRoot: root, plan, crashAt: stage, out: path.join(root, 'out.json'),
        });
        const child = spawnSync(process.execPath, [WORKER, config], { env: childEnv(root), encoding: 'utf8', timeout: 60_000 });
        assert.equal(child.status, 137, child.stderr);
        const before = store.describeObjects();
        assert.equal(before.length, 1);
        const crashed = before[0];
        assert.equal(crashed.classification, expected.classification, JSON.stringify(crashed));
        assert.equal(crashed.retain, !expected.classification.includes('reclaimable'));

        const installer = fakeInstaller();
        const result = store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER });
        if (expected.hit) {
            assert.equal(result.status, 'hit');
            assert.equal(result.objectId, crashed.objectId);
            assert.equal(installer.calls.length, 0);
        } else {
            assert.equal(result.status, 'built');
            assert.notEqual(result.objectId, crashed.objectId, 'the interrupted object is never admitted');
            assert.equal(installer.calls.length, 1);
            if (crashed.path) assert.ok(fs.existsSync(crashed.path), 'interrupted objects are retained, not deleted');
        }
        assert.equal(store.validateObject(result.objectId, { inputKey: plan.inputKey }).valid, true);
    });
}

function waitForFile(file, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
}

async function pausedChild(t, stage) {
    const ctx = fixture(t);
    const signal = path.join(ctx.root, 'paused.signal');
    const config = writeConfig(ctx.root, 'pause', {
        depsDir: ctx.depsDir, workspaceRoot: ctx.root, plan: ctx.plan, pauseAt: stage, signal, out: path.join(ctx.root, 'out.json'),
    });
    const child = spawn(process.execPath, [WORKER, config], { env: childEnv(ctx.root), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
    waitForFile(signal);
    return { ...ctx, child, exited };
}

test('dependency store crash: a live paused writer retains its object; death before any installer proves quiescence', async (t) => {
    const { store, child, exited } = await pausedChild(t, 'object-allocated');
    const live = store.describeObjects();
    assert.equal(live.length, 1);
    assert.equal(live[0].classification, 'unpublished-retained');
    assert.match(live[0].reasons.join(' '), /writer: process alive/);
    child.kill('SIGKILL');
    await exited;
    const dead = store.describeObjects();
    assert.equal(dead[0].classification, 'unpublished-reclaimable');
    assert.equal(dead[0].retain, false);
    assert.ok(fs.existsSync(dead[0].path), 'describing never deletes');
});

test('dependency store crash: a dead writer whose installer started stays retained without installer quiescence proof', async (t) => {
    const { store, child, exited } = await pausedChild(t, 'payload-installed');
    child.kill('SIGKILL');
    await exited;
    const [entry] = store.describeObjects();
    assert.equal(entry.classification, 'unpublished-retained');
    assert.match(entry.buildReceipt.quiescence.reason, /cannot be proven stopped/);
});

test('dependency store crash: two processes serialized by the real workspace lease build once', async (t) => {
    const ctx = fixture(t);
    const counter = path.join(ctx.root, 'installs.log');
    const run = (name) => {
        const out = path.join(ctx.root, `${name}.out.json`);
        const config = writeConfig(ctx.root, name, {
            depsDir: ctx.depsDir, workspaceRoot: ctx.root, plan: ctx.plan, realLease: true, counter, installDelayMs: 300, out,
        });
        const child = spawn(process.execPath, [WORKER, config], { env: childEnv(ctx.root), stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr, out })));
    };
    const results = await Promise.all([run('a'), run('b')]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const outputs = results.map((result) => JSON.parse(fs.readFileSync(result.out, 'utf8')));
    assert.deepEqual(outputs.map((item) => item.status).sort(), ['built', 'hit']);
    assert.equal(outputs[0].objectId, outputs[1].objectId);
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'npm ran exactly once');
});
