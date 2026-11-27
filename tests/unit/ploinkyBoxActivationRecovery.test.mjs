import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sealEdgeSelector, selectorIdentity } from '../../cli/sandbox/edgeSelectorRecord.mjs';
import { classifyFailedActivation, postStopSelectorBound } from '../../ploinky-box/activationRecovery.mjs';
import {
    runBoundedActivationStart,
    runBoundedCoreCommand,
    runBoundedRestartCommand,
} from '../../ploinky-box/supervisor.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';

const GEN_A = `sha256:${'a'.repeat(64)}`;
const GEN_B = `sha256:${'b'.repeat(64)}`;

function active(generation = GEN_B) {
    return sealEdgeSelector({
        schemaVersion: 1, state: 'active', generation, publicationState: 'ready',
        activationId: crypto.randomUUID(), activatedAt: new Date().toISOString(),
    });
}

function inactive({ generation = GEN_B, previousGeneration = GEN_A, reason = 'coordinated-apply' } = {}) {
    return sealEdgeSelector({
        schemaVersion: 1, state: 'inactive', generation, previousGeneration, reason,
        activationId: crypto.randomUUID(), changedAt: new Date().toISOString(),
    });
}

const valid = (value, extra = {}) => ({ state: 'valid', value, ...extra });
const absent = { state: 'absent' };

function evidence({ live = absent, intent = absent, receipt = absent, directories = { state: 'valid' } } = {}) {
    return { directories, live, intent, receipt };
}

function intentFor(intended, predecessor) {
    return valid({ intended: selectorIdentity(intended), predecessor: selectorIdentity(predecessor) });
}

// --- AC6: one pure case per row ------------------------------------------

test('the decision table keeps the graph unless the predecessor is proven in force (R1-R7, P-W1L)', () => {
    const predecessor = inactive();
    const intended = active();
    const baselineActive = active(GEN_A);
    const notCommitted = valid({ outcome: 'not-committed' });
    const committed = valid({ outcome: 'committed' });
    const rows = [
        ['R1', evidence({ directories: { state: 'invalid', reason: 'not private' } }), null, 'kept-indeterminate'],
        ['R2a absent', evidence(), null, 'rollback'],
        ['R2a inactive', evidence({ live: valid(inactive()) }), selectorIdentity(baselineActive), 'rollback'],
        ['R2a baseline', evidence({ live: valid(baselineActive) }), selectorIdentity(baselineActive), 'rollback'],
        ['R2 other active is R7', evidence({ live: valid(active()) }), selectorIdentity(baselineActive), 'kept-indeterminate'],
        ['R2 absent with unknown baseline is R7', evidence(), 'unknown', 'kept-indeterminate'],
        ['R3', evidence({ intent: { state: 'invalid', reason: 'foreign' }, live: valid(predecessor) }), null, 'kept-indeterminate'],
        ['R4 no receipt', evidence({ intent: intentFor(intended, predecessor), live: valid(intended) }), null, 'kept-activated'],
        ['R4 committed', evidence({ intent: intentFor(intended, predecessor), live: valid(intended), receipt: committed }), null, 'kept-activated'],
        ['R5', evidence({ intent: intentFor(intended, predecessor), live: valid(inactive()), receipt: notCommitted }), null, 'rollback'],
        ['R6 no receipt', evidence({ intent: intentFor(intended, predecessor), live: valid(predecessor) }), null, 'rollback'],
        // The predecessor is always inactive, so R5 already decides this case.
        ['R5 predecessor not committed', evidence({ intent: intentFor(intended, predecessor), live: valid(predecessor), receipt: notCommitted }), null, 'rollback'],
        ['R7 invalid receipt', evidence({ intent: intentFor(intended, predecessor), live: valid(intended), receipt: { state: 'invalid', reason: 'digest-mismatch' } }), null, 'kept-indeterminate'],
        ['R7 committed without R4', evidence({ intent: intentFor(intended, predecessor), live: valid(predecessor), receipt: committed }), null, 'kept-indeterminate'],
        ['R7 not committed, active non-intended', evidence({ intent: intentFor(intended, predecessor), live: valid(active()), receipt: notCommitted }), null, 'kept-indeterminate'],
        ['R7 unreadable live', evidence({ intent: intentFor(intended, predecessor), live: { state: 'invalid', reason: 'symlink' } }), null, 'kept-indeterminate'],
        // P-W1L: W1 threw before the rename, its not-committed receipt was lost,
        // and the catch wrote a fresh inactive selector.
        ['P-W1L', evidence({ intent: intentFor(intended, predecessor), live: valid(inactive()) }), null, 'kept-indeterminate'],
    ];
    for (const [label, input, baseline, expected] of rows) {
        const decision = classifyFailedActivation({ evidence: input, baseline });
        assert.equal(decision.verdict, expected, label);
        assert.equal(decision.row, label.split(' ')[0].replace(/^R2$/, 'R7').replace('P-W1L', 'R7'), label);
    }
});

// --- postStopSelectorBound -----------------------------------------------

test('the post-stop selector is bound only to the stop this rollback ran', () => {
    const preActive = active(GEN_B);
    const preInactive = inactive({ generation: GEN_B, previousGeneration: GEN_A });
    const stopOf = (pre) => inactive({
        generation: undefined,
        previousGeneration: pre?.state === 'active' ? pre.generation : (pre?.previousGeneration || ''),
        reason: 'cli-workspace-stop',
    });
    assert.equal(postStopSelectorBound(preActive, stopOf(preActive)), true);
    assert.equal(postStopSelectorBound(preInactive, stopOf(preInactive)), true);
    assert.equal(postStopSelectorBound(null, stopOf(null)), true, 'an absent pre-stop selector derives an empty previous generation');
    assert.equal(postStopSelectorBound(preActive, inactive({ previousGeneration: GEN_B, reason: 'apply-failed' })), false, 'another reason');
    assert.equal(postStopSelectorBound(preActive, inactive({ previousGeneration: GEN_A, reason: 'cli-workspace-stop' })), false, 'wrong previous generation');
    assert.equal(postStopSelectorBound(preActive, null), false);
    assert.equal(postStopSelectorBound(preActive, active()), false);
    // The stop's preserved branch keeps the exact inactive selector.
    assert.equal(postStopSelectorBound(preInactive, preInactive), true);
    assert.equal(postStopSelectorBound(preActive, preActive), false, 'an unchanged active selector was not stopped');
});

// --- AC11 / H15: the activation start runner ------------------------------

const RUNNER_CONTAINER = 'f'.repeat(64);
const RUNNER_OPERATION = '9'.repeat(32);

function quietStream() {
    return { isTTY: false, write() { return true; } };
}

// A fake exec client: emits the given stdout chunks, then exits.
function fakeSpawn(chunks, { status = 0 } = {}) {
    const spawned = [];
    const spawnImpl = (command, args) => {
        spawned.push([command, [...args]]);
        const child = new EventEmitter();
        child.pid = 4242;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
            for (const chunk of chunks) child.stdout.emit('data', Buffer.from(chunk));
            child.emit('close', status, null);
        });
        return child;
    };
    return { spawnImpl, spawned };
}

function runnerFixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-activation-runner-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, agentLib: agentLibFixture(root) };
}

const activationContext = (root) => ({
    schema: 'ploinky-activation-context', version: 1, operation: 'start', purpose: 'activate',
    settlesOperationId: null, operationId: RUNNER_OPERATION, instance: 'ploinky-box-workspace-123456789abc',
    containerId: RUNNER_CONTAINER, workspaceRoot: root,
});

function envValues(args) {
    return args.flatMap((value, index) => (value === '--env' ? [args[index + 1]] : []));
}

test('H15: the start runner finds the Router line beyond the bounded tail and carries the marker and context', async (t) => {
    const { root, agentLib } = runnerFixture(t);
    const routerLine = '[start] Router: http://127.0.0.1:19090';
    // The line arrives split across two chunks and more than 16 KiB follow it.
    const { spawnImpl, spawned } = fakeSpawn(['[start] Rout', `er: http://127.0.0.1:19090\n`, `${'x'.repeat(1024)}\n`.repeat(20)]);
    const run = await runBoundedActivationStart({ name: 'podman' }, RUNNER_CONTAINER, ['start', 'demo', '8080'], 19090, 7882,
        { query: () => ({ ok: true, stdout: '[]' }) }, {
            workspaceRoot: root, stdout: quietStream(), stderr: quietStream(), agentLib,
            operationId: RUNNER_OPERATION, activationContext: activationContext(root),
            runnerOptions: { spawnImpl, forwardedSignals: [] },
        });
    assert.equal(run.status, 0);
    assert.deepEqual(run.matchedLines, [routerLine]);
    assert.equal(run.tails.stdout.includes('Router'), false, 'the line is beyond the 16 KiB tail');
    const env = envValues(spawned[0][1]);
    assert.ok(env.includes(`PLOINKY_UPDATE_OPERATION=${RUNNER_OPERATION}`));
    const context = env.find((value) => value.startsWith('PLOINKY_ACTIVATION_CONTEXT='));
    assert.deepEqual(JSON.parse(context.slice('PLOINKY_ACTIVATION_CONTEXT='.length)), activationContext(root));
    assert.deepEqual(spawned[0][1].slice(-4), ['/opt/ploinky/bin/ploinky-local', 'start', 'demo', '8080']);
});

test('H15: a clean start that never reported the public Router URL fails', async (t) => {
    const { root, agentLib } = runnerFixture(t);
    const { spawnImpl } = fakeSpawn(['[start] Router: http://127.0.0.1:8080\n', 'done\n']);
    await assert.rejects(runBoundedActivationStart({ name: 'podman' }, RUNNER_CONTAINER, ['start'], 19090, 7882,
        { query: () => ({ ok: true, stdout: '[]' }) }, {
            workspaceRoot: root, stdout: quietStream(), stderr: quietStream(), agentLib,
            operationId: RUNNER_OPERATION, runnerOptions: { spawnImpl, forwardedSignals: [] },
        }), /In-box start did not report the public Router URL http:\/\/127\.0\.0\.1:19090/);
    // A failed start returns its end for the caller to judge; the Router line is not checked.
    const failed = fakeSpawn(['boom\n'], { status: 1 });
    const run = await runBoundedActivationStart({ name: 'podman' }, RUNNER_CONTAINER, ['start'], 19090, 7882,
        { query: () => ({ ok: true, stdout: '[]' }) }, {
            workspaceRoot: root, stdout: quietStream(), stderr: quietStream(), agentLib,
            operationId: RUNNER_OPERATION, runnerOptions: { spawnImpl: failed.spawnImpl, forwardedSignals: [], probeIntervalMs: 1 },
        });
    assert.equal(run.status, 1);
    assert.equal(run.quiescence.state, 'confirmed');
});

test('the restart and generic core runners carry the activation context only when one is given', async (t) => {
    const { root, agentLib } = runnerFixture(t);
    const restart = fakeSpawn([]);
    await runBoundedRestartCommand({ name: 'podman' }, RUNNER_CONTAINER, ['restart'], 8080, 7882,
        { query: () => ({ ok: true, stdout: '[]' }) }, {
            workspaceRoot: root, stdout: quietStream(), stderr: quietStream(), agentLib, operationId: RUNNER_OPERATION,
            activationContext: { ...activationContext(root), operation: 'restart' },
            runnerOptions: { spawnImpl: restart.spawnImpl, forwardedSignals: [] },
        });
    assert.equal(envValues(restart.spawned[0][1]).filter((value) => value.startsWith('PLOINKY_ACTIVATION_CONTEXT=')).length, 1);
    const streamed = [];
    const runner = { stream: async (_command, args) => { streamed.push(args); return { ok: true, status: 0, stdout: '' }; } };
    await runBoundedCoreCommand({ name: 'podman' }, RUNNER_CONTAINER, ['start', 'demo', '8080'], 8080, 7882, runner, {
        workspaceRoot: root, stdout: quietStream(), stderr: quietStream(), agentLib,
        activationContext: { ...activationContext(root), purpose: 'restore' },
    });
    await runBoundedCoreCommand({ name: 'podman' }, RUNNER_CONTAINER, ['status'], 8080, 7882, runner, {
        workspaceRoot: root, stdout: quietStream(), stderr: quietStream(), agentLib,
    });
    assert.equal(JSON.parse(envValues(streamed[0]).find((value) => value.startsWith('PLOINKY_ACTIVATION_CONTEXT=')).split('=').slice(1).join('=')).purpose, 'restore');
    assert.equal(envValues(streamed[1]).some((value) => value.startsWith('PLOINKY_ACTIVATION_CONTEXT=')), false);
    // An invalid context is refused before anything is executed.
    await assert.rejects(runBoundedCoreCommand({ name: 'podman' }, RUNNER_CONTAINER, ['start'], 8080, 7882, runner, {
        workspaceRoot: root, stdout: quietStream(), stderr: quietStream(), agentLib,
        activationContext: { ...activationContext(root), purpose: 'promote' },
    }), { code: 'PLOINKY_ACTIVATION_CONTEXT_INVALID' });
    assert.equal(streamed.length, 2);
});
