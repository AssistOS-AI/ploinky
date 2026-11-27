import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeActivationIntent, writeActivationReceipt } from '../../cli/sandbox/activationRecords.mjs';
import { sealEdgeSelector, selectorIdentity } from '../../cli/sandbox/edgeSelectorRecord.mjs';
import { classifyFailedActivation, postStopSelectorBound, readActivationEvidence } from '../../ploinky-box/activationRecovery.mjs';
import { isReadOnlyGeneric } from '../../ploinky-box/command/route.mjs';
import { writeGraphSkillScope } from '../../ploinky-box/graphSkillScope.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { buildHostSkillScope } from '../../ploinky-box/skillScope.mjs';
import {
    createBoxSupervisor,
    formatUpdateStateLines,
    isActivationRecoveryBarrier,
    runBoundedActivationStart,
    runBoundedCoreCommand,
    runBoundedRestartCommand,
    selectActivationStart,
} from '../../ploinky-box/supervisor.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { createProcessRunner, isProcessRunner } from '../../ploinky-box/process.mjs';
import { agentLibFixture, agentLibFixtureLabels, agentLibFixtureMounts } from '../helpers/agentlibFixture.mjs';
import { BOX_IMAGE_REFERENCE, BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { isInBoxStop, writeInBoxStopSelector } from '../helpers/fakeInBoxStop.mjs';
import { fakeUpdateCore } from '../helpers/fakeUpdateCore.mjs';
import { PERMISSIVE_HOST_STATE_GUARD } from '../helpers/hostStateFixture.mjs';

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

// --- Host scenarios: a real supervisor with fake engine, reconcile and health
// seams. The fake in-Box command plays the start or restart: it writes the
// write-once intent and the selector exactly where the real one does.

const BOX = 'a'.repeat(64);
const GEN_OLD = `sha256:${'0'.repeat(64)}`;
const GEN_NEW = `sha256:${'1'.repeat(64)}`;
const CODE = 'PLOINKY_BOX_ACTIVATION_RECOVERY_REQUIRED';

function capture() {
    let value = '';
    return { isTTY: false, write(chunk) { value += String(chunk); return true; }, value: () => value };
}

function exitRun(status = 0, { quiescence = 'confirmed', cause = 'exited' } = {}) {
    return {
        cause, status, signal: null, clientExited: true, escalation: null, tails: { stdout: '', stderr: '' },
        quiescence: { state: quiescence, method: 'fixture', detail: quiescence === 'confirmed' ? '' : 'engine unavailable' },
    };
}

function world(t, {
    discoveredRunning = false,
    outerRollbackAction = 'reused-preserved',
    lockManager = null,
    stopBehavior = 'stop-selector',
    preparedAction = 'reused',
    preparedId = BOX,
    restoredId = BOX,
    store: injectedStore = null,
} = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-q30-host-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.ploinky', 'data', 'edge-routing'), { recursive: true, mode: 0o700 });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    writeGraphSkillScope(identity, buildHostSkillScope(workspace, workspace), { assertHeld() {} });
    const selection = agentLibFixture(workspace);
    const store = injectedStore || createMemoryUpdateHostState();
    const events = [];
    const stdout = capture();
    const stderr = capture();
    const state = {
        boxStatus: 'running',
        stopBehavior,
        probe: () => ({ ok: true, pids: [] }),
        healthFailures: [],
        inBox: null,
        postStopChecks: 0,
        evidenceHook: null,
        graph: { running: true, configured: true },
        discoveredRunning,
        // The workspace's currently owned Box and the engine status of each id.
        ownedId: BOX,
        statusOf: null,
    };
    const ownership = (running, id = state.ownedId) => ({
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: { container: { id, runtime: { running, status: running ? 'running' : 'exited' } } },
    });
    const prepared = {
        action: preparedAction,
        ownership: ownership(true, preparedId),
        hostPort: 8080,
        mediaHostPort: 7882,
        previousAgentLib: selection,
        validate() {},
        finalize() { events.push('finalize'); },
        async rollback() {
            events.push('rollback');
            return { action: outerRollbackAction, containerId: restoredId, hostPort: 8080, mediaHostPort: 7882, agentLib: selection };
        },
    };
    const markerFile = path.join(workspace, '.ploinky', 'data', 'edge-routing', 'activation-barrier.json');
    const runner = {
        run(_command, args) {
            events.push(['run', args.at(-1)]);
            if (!isInBoxStop(args)) return;
            events.push('stop');
            if (state.stopBehavior === 'throw') throw new Error('the in-Box stop failed');
            if (state.stopBehavior === 'stop-selector') writeInBoxStopSelector(workspace);
            if (state.stopBehavior === 'apply-failed') writeInBoxStopSelector(workspace, { reason: 'apply-failed' });
            if (state.stopBehavior === 'wrong-previous') writeInBoxStopSelector(workspace, { previousGeneration: `sha256:${'9'.repeat(64)}` });
            if (state.stopBehavior === 'active') writeLive(workspace, active(GEN_NEW));
        },
        query(_command, args, options = {}) {
            if (args[0] === 'container' && args[1] === 'inspect' && args.includes('{{.State.Status}}')) {
                const status = state.statusOf ? state.statusOf(args.at(-1)) : state.boxStatus;
                return status === 'absent'
                    ? { ok: false, status: 125, stderr: 'Error: no such container' }
                    : { ok: true, stdout: `${status}\n` };
            }
            if (args.includes('/opt/ploinky/ploinky-box/entrypoint/activation-barrier-marker.mjs')) {
                const action = args.at(-1);
                const payload = JSON.parse(options.input);
                events.push(['marker', action, payload.state ?? null, payload.operationId]);
                if (action === 'write') fs.writeFileSync(markerFile, options.input, { mode: 0o600 });
                else fs.rmSync(markerFile, { force: true });
                return { ok: true, stdout: `${JSON.stringify({ digest: crypto.createHash('sha256').update(options.input).digest('hex') })}\n` };
            }
            return { ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: state.graph.configured }) };
        },
        async stream(_command, args) {
            events.push(['stream', args]);
            return { ok: true, status: 0, stdout: '', stderr: '' };
        },
    };
    const inBoxCore = async (_engine, _id, argv, _hostPort, _mediaPort, _runner, options) => {
        events.push(['core', [...argv], options.activationContext ?? null]);
        return (state.inBox || inBoxPublishes())({ argv, options, workspace });
    };
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: workspace,
        lockManager: lockManager || { async acquire() { events.push('lock'); return { assertHeld() {}, release() { events.push('release'); } }; } },
        discover: () => ownership(state.discoveredRunning),
        repositoryRoot: root,
        env: {},
        stdout,
        stderr,
        updateHostState: store,
        runner,
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        updateWorkspacePloinky: async () => null,
        updateAgentLib: async () => ({ selection, changed: false, previous: selection }),
        selectAgentLib: async () => ({ selection }),
        reconcile: async () => { events.push('reconcile'); return prepared; },
        runRestartCore: inBoxCore,
        startActivationCore: inBoxCore,
        runUpdateCore: fakeUpdateCore({ onCall({ argv }) { events.push(['core', [...argv], null]); } }),
        runCoreCommand: runBoundedCoreCommand,
        probeUpdateQuiescence: (options) => { events.push('probe'); return state.probe(options); },
        createCancellation: () => ({ arm() {}, async dispose() {}, async signalReceived() { return null; } }),
        resolveHostReachableIpv4: async () => '',
        healthCheck: async () => {
            events.push('health');
            const failure = state.healthFailures.shift();
            if (failure) throw failure;
        },
        revalidateAgentLibSource() {},
        commitAgentLibSelection() { events.push('commit-agentlib'); },
        readAgentLibActive: () => null,
        restoreAgentLibActive() {},
        checkPostStopSelector: (pre, post) => { state.postStopChecks += 1; return postStopSelectorBound(pre, post); },
        readEvidence: (...args) => {
            const evidence = readActivationEvidence(...args);
            state.evidenceHook?.(args);
            return evidence;
        },
    });
    // The serving predecessor graph.
    writeLive(workspace, active(GEN_OLD));
    return { supervisor, identity, workspace, store, events, state, stdout, stderr, markerFile, selection, prepared };
}

function liveSelectorFile(workspace) {
    return path.join(workspace, '.ploinky', 'data', 'edge-routing', 'active.json');
}

function writeLive(workspace, selector) {
    fs.writeFileSync(liveSelectorFile(workspace), JSON.stringify(selector, null, 2), { mode: 0o600 });
    return selector;
}

function readLive(workspace) {
    return JSON.parse(fs.readFileSync(liveSelectorFile(workspace), 'utf8'));
}

function requestOf(context) {
    return { ...context, context };
}

// The in-Box start/restart: inactivate, write the intent, rename, then end.
function inBoxPublishes({ status = 0, receipt = 'committed', quiescence = 'confirmed' } = {}) {
    return ({ options, workspace }) => {
        const predecessor = writeLive(workspace, inactive({ generation: GEN_OLD, previousGeneration: GEN_OLD }));
        const intended = active(GEN_NEW);
        const intent = writeActivationIntent({
            workspaceRoot: workspace, request: requestOf(options.activationContext), intended, predecessor, policyStaged: false,
        });
        writeLive(workspace, intended);
        if (receipt) {
            writeActivationReceipt({ workspaceRoot: workspace, operationId: options.activationContext.operationId, intentDigest: intent.digest, outcome: receipt });
        }
        return exitRun(status, { quiescence });
    };
}

// A failure before the intent: the in-Box command only inactivated.
function inBoxFailsBeforeIntent() {
    return ({ workspace }) => {
        writeLive(workspace, inactive({ generation: GEN_OLD, previousGeneration: GEN_OLD, reason: 'cli-workspace-restart' }));
        return exitRun(1);
    };
}

// A failure after the intent and before the rename (W1).
function inBoxFailsAfterIntent({ receipt = 'not-committed', rewriteSelector = true } = {}) {
    return ({ options, workspace }) => {
        const predecessor = writeLive(workspace, inactive({ generation: GEN_OLD, previousGeneration: GEN_OLD }));
        const intent = writeActivationIntent({
            workspaceRoot: workspace, request: requestOf(options.activationContext), intended: active(GEN_NEW), predecessor, policyStaged: false,
        });
        if (receipt) {
            writeActivationReceipt({ workspaceRoot: workspace, operationId: options.activationContext.operationId, intentDigest: intent.digest, outcome: receipt });
        }
        if (rewriteSelector) writeLive(workspace, inactive({ generation: GEN_NEW, previousGeneration: GEN_OLD, reason: 'apply-failed' }));
        return exitRun(1);
    };
}

const stops = (events) => events.filter((event) => event === 'stop').length;
const rollbacks = (events) => events.filter((event) => event === 'rollback').length;
const restores = (events) => events.filter((event) => Array.isArray(event) && event[0] === 'stream'
    && event[1].includes('/opt/ploinky/bin/ploinky-local') && event[1].at(-3) === 'start');
const coreCalls = (events) => events.filter((event) => Array.isArray(event) && event[0] === 'core');
const markerCalls = (events, action) => events.filter((event) => Array.isArray(event) && event[0] === 'marker' && event[1] === action);
const barrierOf = (fixture) => fixture.store.read('update-recovery', fixture.identity.instance);

function restoreContextOf(event) {
    const value = envValues(event[1]).find((entry) => entry.startsWith('PLOINKY_ACTIVATION_CONTEXT='));
    return value ? JSON.parse(value.slice('PLOINKY_ACTIVATION_CONTEXT='.length)) : null;
}

const TRANSACTIONS = {
    start: (supervisor) => supervisor.runStartTransaction(['start', 'agent']),
    restart: (supervisor) => supervisor.runRestartTransaction(['restart']),
};

// --- AC4: keep after a post-selector failure -------------------------------

for (const [name, invoke] of Object.entries(TRANSACTIONS)) {
    test(`H1 (${name}): a nonzero exit after publication keeps the graph behind an activated barrier`, async (t) => {
        const fixture = world(t);
        fixture.state.inBox = inBoxPublishes({ status: 1 });
        await assert.rejects(invoke(fixture.supervisor), (error) => {
            assert.equal(error.code, CODE);
            assert.equal(error.activation.outcome, 'kept-activated');
            assert.equal(error.activation.graphMutated, true);
            assert.match(error.message, new RegExp(`^The workspace ${name} activated the new version \\(edge generation 111111111111, activation [0-9a-f]{8}\\) but failed while settling it: `));
            assert.match(error.message, /nothing was stopped or rolled back\. Run `ploinky restart` to settle it, or `ploinky stop` to stop it\. Until then start, update, single-agent restart, bind and GPU changes are refused\. \[PLOINKY_BOX_ACTIVATION_RECOVERY_REQUIRED\]$/);
            return true;
        });
        assert.equal(stops(fixture.events), 0, 'Q30: host must not stop a kept graph');
        assert.equal(rollbacks(fixture.events), 0);
        const barrier = barrierOf(fixture);
        assert.equal(barrier.schema, 'ploinky-activation-recovery');
        assert.equal(barrier.state, 'activated');
        assert.equal(barrier.operation, name);
        assert.equal(barrier.intended.generation, GEN_NEW);
        assert.deepEqual(markerCalls(fixture.events, 'write').map((event) => event[2]), ['activated']);
        assert.equal(markerCalls(fixture.events, 'write')[0][3], barrier.operationId);
        assert.equal(readLive(fixture.workspace).generation, GEN_NEW, 'the new version is still selected');
    });

    test(`H13 (${name}): a clean exit followed by a failed health check keeps the graph`, async (t) => {
        const fixture = world(t);
        fixture.state.inBox = inBoxPublishes({ status: 0 });
        fixture.state.healthFailures.push(new Error('Router health failed'));
        await assert.rejects(invoke(fixture.supervisor), (error) => {
            assert.equal(error.code, CODE);
            assert.equal(error.activation.outcome, 'kept-activated');
            assert.match(error.message, /Router health failed/);
            return true;
        });
        assert.equal(stops(fixture.events), 0, 'Q30: host must not stop a kept graph');
        assert.equal(rollbacks(fixture.events), 0);
        assert.equal(barrierOf(fixture).state, 'activated');
    });
}

test('H14 (update): a full update whose activation fails after publication keeps the graph and records an uncertain activation', async (t) => {
    const fixture = world(t, { discoveredRunning: true });
    fixture.state.inBox = inBoxPublishes({ status: 1 });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), (error) => {
        assert.equal(error.code, CODE);
        assert.equal(error.activation.outcome, 'kept-activated');
        const record = error.updateRecords.find((entry) => entry.phase === 'activation' && entry.id === 'workspace-graph');
        assert.equal(record.outcome, 'uncertain');
        assert.equal(record.code, 'kept-activated');
        assert.ok(error.updateRecords.some((entry) => entry.phase === 'registered-repository'), 'the verified inputs are kept');
        return true;
    });
    assert.equal(stops(fixture.events), 0);
    assert.equal(rollbacks(fixture.events), 0);
    assert.equal(barrierOf(fixture).operation, 'update');
    const restart = coreCalls(fixture.events).find((event) => event[1][0] === 'restart');
    assert.equal(restart[2].operation, 'update');
    assert.equal(restart[2].purpose, 'activate');
});

// --- AC6: the table through the host ---------------------------------------

test('H2-H7: each decision row reaches the host as a rollback or a kept graph', async (t) => {
    const cases = [
        ['H2 (R5)', inBoxFailsAfterIntent({ receipt: 'not-committed' }), 'rollback'],
        ['H3 (R2a)', inBoxFailsBeforeIntent(), 'rollback'],
        ['H4 (R2b -> R7)', ({ workspace }) => { writeLive(workspace, active(`sha256:${'7'.repeat(64)}`)); return exitRun(1); }, 'kept-indeterminate'],
        ['H5 (truncated intent)', ({ options, workspace }) => {
            fs.mkdirSync(path.dirname(activationRecordPathFor(workspace, options)), { recursive: true, mode: 0o700 });
            fs.writeFileSync(activationRecordPathFor(workspace, options), '{"schema":"ploinky-activation-intent"', { mode: 0o600 });
            return exitRun(1);
        }, 'kept-indeterminate'],
        ['H5 (9 KiB intent)', ({ options, workspace }) => {
            fs.mkdirSync(path.dirname(activationRecordPathFor(workspace, options)), { recursive: true, mode: 0o700 });
            fs.writeFileSync(activationRecordPathFor(workspace, options), `{"pad":"${'x'.repeat(9 * 1024)}"}`, { mode: 0o600 });
            return exitRun(1);
        }, 'kept-indeterminate'],
        ['H6 (foreign context)', ({ options, workspace }) => {
            const foreign = { ...options.activationContext, containerId: 'd'.repeat(64) };
            writeActivationIntent({ workspaceRoot: workspace, request: requestOf(foreign), intended: active(GEN_NEW), predecessor: null, policyStaged: false });
            return exitRun(1);
        }, 'kept-indeterminate'],
        ['H7 (linked intent)', ({ options, workspace }) => {
            const written = writeActivationIntent({ workspaceRoot: workspace, request: requestOf(options.activationContext), intended: active(GEN_NEW), predecessor: null, policyStaged: false });
            fs.linkSync(written.path, `${written.path}.second-name`);
            return exitRun(1);
        }, 'kept-indeterminate'],
    ];
    for (const [label, inBox, expected] of cases) {
        const fixture = world(t);
        fixture.state.inBox = inBox;
        await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), (error) => {
            assert.equal(error.activation.outcome, expected === 'rollback' ? 'restored' : expected, label);
            return true;
        });
        if (expected === 'rollback') {
            assert.equal(stops(fixture.events), 1, label);
            assert.equal(restores(fixture.events).length, 1, label);
            assert.equal(barrierOf(fixture), null, label);
        } else {
            assert.equal(stops(fixture.events), 0, label);
            assert.equal(barrierOf(fixture).state, 'indeterminate', label);
        }
    }
});

function activationRecordPathFor(workspace, options) {
    return path.join(workspace, '.ploinky', 'data', 'edge-routing', 'activations', `${options.activationContext.operationId}.intent.json`);
}

// --- AC7: death versus nonzero exit ---------------------------------------

test('H8: a killed in-Box command (137) whose end the engine confirmed still keeps a published graph', async (t) => {
    const fixture = world(t);
    fixture.state.inBox = inBoxPublishes({ status: 137, receipt: null });
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), (error) => error.activation.outcome === 'kept-activated');
    assert.equal(stops(fixture.events), 0);
});

test('H9: an unconfirmed writer leaves a writer barrier that converts, refuses, and is settled by a whole restart', async (t) => {
    const fixture = world(t);
    fixture.state.inBox = inBoxPublishes({ status: 1, quiescence: 'uncertain' });
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), { code: 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN' });
    const writer = barrierOf(fixture);
    assert.equal(writer.schema, 'ploinky-update-recovery');
    assert.equal(writer.activation.operationId, writer.nonce);
    assert.deepEqual(markerCalls(fixture.events, 'write').map((event) => [event[2], event[3]]), [['writer', writer.nonce]]);
    assert.equal(stops(fixture.events), 0);
    // A whole restart while the writer is still unconfirmed is refused.
    fixture.state.probe = () => ({ ok: false, detail: 'the engine is unavailable' });
    const before = coreCalls(fixture.events).length;
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), { code: 'PLOINKY_BOX_UPDATE_RECOVERY_REQUIRED' });
    assert.equal(coreCalls(fixture.events).length, before, 'zero core calls');
    // Once confirmed, a start converts it (live = intended) and is refused.
    fixture.state.probe = () => ({ ok: true, pids: [] });
    await assert.rejects(fixture.supervisor.runStartTransaction(['start', 'agent']), (error) => {
        assert.equal(error.code, CODE);
        assert.match(error.message, /^An earlier restart \([0-9a-f]{8}\) left a workspace version whose settlement requires recovery \(activated\); no new mutation was started\./);
        return true;
    });
    const converted = barrierOf(fixture);
    assert.equal(converted.schema, 'ploinky-activation-recovery');
    assert.equal(converted.state, 'activated');
    assert.equal(converted.operationId, writer.nonce);
    assert.deepEqual(markerCalls(fixture.events, 'write').at(-1).slice(2), ['activated', writer.nonce]);
    assert.equal(coreCalls(fixture.events).length, before);
    // A later start is refused; a whole restart settles.
    await assert.rejects(fixture.supervisor.runStartTransaction(['start', 'agent']), { code: CODE });
    fixture.state.inBox = inBoxPublishes({ status: 0 });
    await fixture.supervisor.runRestartTransaction(['restart']);
    const settle = coreCalls(fixture.events).at(-1)[2];
    assert.equal(settle.purpose, 'settle');
    assert.equal(settle.settlesOperationId, writer.nonce);
    assert.equal(barrierOf(fixture), null);
    assert.match(fixture.stdout.value(), new RegExp(`Activation recovery settled: the earlier restart \\(${writer.nonce.slice(0, 8)}\\) was superseded by this restart\\.`));
});

// --- AC8: a second command while the barrier is held -----------------------

async function heldBarrier(t, options = {}) {
    const fixture = world(t, options);
    fixture.state.inBox = inBoxPublishes({ status: 1 });
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), { code: CODE });
    return fixture;
}

test('H10: every graph mutation is refused while an activation barrier is held, before any core call or reconcile', async (t) => {
    const fixture = await heldBarrier(t);
    const held = barrierOf(fixture);
    const refusals = [
        ['start', (s) => s.runStartTransaction(['start', 'agent'])],
        ['update', (s) => s.runUpdateTransaction(['update'])],
        ['update repos', (s) => s.runUpdateTransaction(['update', 'repos'], { request: { kind: 'repos' } })],
        ['targeted restart', (s) => s.runTargetedRestartTransaction(['restart', 'agent'])],
        ['bind', (s) => s.runBindTransaction({ address: '127.0.0.1', hostPort: 8080 })],
        ['gpu grant', (s) => s.runGpuGrantTransaction({})],
        ['edge set', (s) => s.runEdgeSetTransaction(Buffer.from('{}'))],
        ['generic', (s) => s.prepareBoxForCommand()],
    ];
    for (const [label, invoke] of refusals) {
        const calls = coreCalls(fixture.events).length;
        const reconciles = fixture.events.filter((event) => event === 'reconcile').length;
        await assert.rejects(invoke(fixture.supervisor), (error) => {
            assert.equal(error.code, CODE, label);
            assert.match(error.message, /^An earlier restart \([0-9a-f]{8}\) left a workspace version whose settlement requires recovery \(activated\)/, label);
            return true;
        });
        assert.equal(coreCalls(fixture.events).length, calls, `${label}: zero core calls`);
        assert.equal(fixture.events.filter((event) => event === 'reconcile').length, reconciles, `${label}: zero reconcile`);
    }
    assert.deepEqual(barrierOf(fixture), held, 'refusals leave the barrier unchanged');
    // A read-only generic command takes the inspect-only path, never a reconcile.
    const reconciles = fixture.events.filter((event) => event === 'reconcile').length;
    await assert.rejects(fixture.supervisor.prepareBoxForCommand({ readOnly: true }), (error) => {
        assert.equal(error.code, CODE);
        assert.match(error.message, /^An activation recovery barrier is held, so this command may only read the running Box/);
        return true;
    });
    assert.equal(fixture.events.filter((event) => event === 'reconcile').length, reconciles);
    // A whole restart settles it; a stop of a stopped Box would too.
    fixture.state.inBox = inBoxPublishes({ status: 0 });
    await fixture.supervisor.runRestartTransaction(['restart']);
    assert.equal(barrierOf(fixture), null);
});

test('H10: the read-only generic allowlist and the commands it refuses', () => {
    for (const [command, args] of [['list', ['agents']], ['list', ['repos']], ['list', ['routes']], ['echo', ['X']],
        ['profile', []], ['profile', ['list']], ['profile', ['show']], ['profile', ['current']], ['profile', ['validate', 'prod']], ['profile', ['check']]]) {
        assert.equal(isReadOnlyGeneric(command, args), true, `${command} ${args.join(' ')}`);
    }
    for (const [command, args] of [['enable', ['agent', 'x']], ['shutdown', []], ['canary', ['abort', 'a/b']], ['var', ['X', '1']],
        ['vars', []], ['profile', ['prod']], ['list', []], ['list', ['agents', 'extra']], ['echo', []], ['disable', ['agent', 'x']],
        ['reinstall', ['agent', 'x']], ['expose', ['x']], ['add', ['repo', 'x']]]) {
        assert.equal(isReadOnlyGeneric(command, args), false, `${command} ${args.join(' ')}`);
    }
});

test('H10: two concurrent mutations under a serializing lock leave the second refused', async (t) => {
    let tail = Promise.resolve();
    const lockManager = {
        async acquire() {
            let release;
            const previous = tail;
            tail = new Promise((resolve) => { release = resolve; });
            await previous;
            return { assertHeld() {}, release() { release(); } };
        },
    };
    const fixture = world(t, { lockManager });
    fixture.state.inBox = inBoxPublishes({ status: 1 });
    const first = fixture.supervisor.runStartTransaction(['start', 'agent']);
    const second = fixture.supervisor.runStartTransaction(['start', 'agent']);
    const [one, two] = await Promise.allSettled([first, second]);
    assert.equal(one.reason?.activation?.outcome, 'kept-activated');
    assert.equal(two.reason?.code, CODE);
    assert.match(two.reason.message, /^An earlier start/);
    assert.equal(coreCalls(fixture.events).length, 1, 'only the first reached the Box');
});

// --- AC9: a settle restart that fails before publication ---------------------

test('H11: a settle restart that fails before publication restores the kept graph with a restore context and keeps the barrier', async (t) => {
    const fixture = await heldBarrier(t);
    const held = structuredClone(barrierOf(fixture));
    const markerBefore = fs.readFileSync(fixture.markerFile);
    fixture.state.inBox = inBoxFailsBeforeIntent();
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), (error) => {
        assert.equal(error.activation.outcome, 'restored');
        return true;
    });
    const settle = coreCalls(fixture.events).at(-1)[2];
    assert.equal(settle.purpose, 'settle');
    assert.equal(settle.settlesOperationId, held.operationId);
    assert.deepEqual(barrierOf(fixture), held, 'the original barrier stays deep-equal');
    assert.deepEqual(fs.readFileSync(fixture.markerFile), markerBefore, 'the marker stays');
    assert.deepEqual(markerCalls(fixture.events, 'remove'), [], 'the marker is never removed');
    const restore = restores(fixture.events);
    assert.equal(restore.length, 1);
    const context = restoreContextOf(restore[0]);
    assert.equal(context.purpose, 'restore');
    assert.equal(context.operation, 'start');
    assert.equal(context.settlesOperationId, null);
    assert.match(context.operationId, /^[0-9a-f]{32}$/);
    assert.notEqual(context.operationId, held.operationId);
    assert.equal(context.containerId, BOX, 'the restored Box');
});

// --- AC9b: a real rollback restores over the stop's own selector -------------

test('AC9b: R2a, R5 and R6 rollbacks restore exactly once over the selector the in-Box stop wrote', async (t) => {
    for (const [label, inBox] of [
        ['R2a', inBoxFailsBeforeIntent()],
        ['R5', inBoxFailsAfterIntent({ receipt: 'not-committed' })],
        ['R6', inBoxFailsAfterIntent({ receipt: null, rewriteSelector: false })],
    ]) {
        const fixture = world(t);
        fixture.state.inBox = inBox;
        await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), (error) => {
            assert.equal(error.activation.outcome, 'restored', label);
            return true;
        });
        assert.equal(readLive(fixture.workspace).reason, 'cli-workspace-stop', `${label}: the stop rewrote the selector`);
        assert.equal(restores(fixture.events).length, 1, label);
        assert.equal(restoreContextOf(restores(fixture.events)[0]).purpose, 'restore', label);
        assert.equal(barrierOf(fixture), null, label);
    }
});

// --- AC10: the pre-stop check ------------------------------------------------

test('H12: a selector that changes between the decision and the stop stops nothing and keeps the graph', async (t) => {
    const fixture = world(t);
    fixture.state.inBox = inBoxFailsBeforeIntent();
    fixture.state.evidenceHook = ([, operationId]) => {
        if (!operationId) return;
        fixture.state.evidenceHook = null;
        writeLive(fixture.workspace, active(`sha256:${'8'.repeat(64)}`));
    };
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), (error) => {
        assert.equal(error.code, CODE);
        assert.equal(error.activation.outcome, 'kept-indeterminate');
        assert.match(error.message, /^The workspace restart failed after it may have activated a new version \(the routing selector changed before the rollback could stop the graph\): /);
        return true;
    });
    assert.equal(stops(fixture.events), 0, 'zero ploinky-local stop calls');
    assert.equal(rollbacks(fixture.events), 0, 'zero rollback calls');
    assert.equal(barrierOf(fixture).state, 'indeterminate');
});

test('H12b: an active selector after the stop is never restored over', async (t) => {
    const fixture = world(t, { stopBehavior: 'active' });
    fixture.state.inBox = inBoxFailsBeforeIntent();
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), (error) => {
        assert.equal(error.activation.outcome, 'recovery-required');
        assert.equal(error.code, CODE);
        return true;
    });
    assert.equal(restores(fixture.events).length, 0);
    assert.equal(barrierOf(fixture).state, 'indeterminate');
});

// --- AC10c: the post-stop binding -------------------------------------------

test('AC10c: a post-stop selector this stop did not write skips the restore; the preserved selector restores', async (t) => {
    for (const behavior of ['apply-failed', 'wrong-previous']) {
        const fixture = world(t, { stopBehavior: behavior });
        fixture.state.inBox = inBoxFailsBeforeIntent();
        await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), (error) => {
            assert.equal(error.activation.outcome, 'recovery-required', behavior);
            assert.match(error.message, /the routing selector after that stop is not the one the stop wrote/, behavior);
            return true;
        });
        assert.equal(restores(fixture.events).length, 0, behavior);
        assert.equal(barrierOf(fixture).state, 'indeterminate', behavior);
        assert.equal(markerCalls(fixture.events, 'write').at(-1)[2], 'indeterminate', behavior);
    }
    const preserved = world(t, { stopBehavior: 'preserved' });
    preserved.state.inBox = inBoxFailsBeforeIntent();
    await assert.rejects(preserved.supervisor.runRestartTransaction(['restart']), (error) => error.activation.outcome === 'restored');
    assert.equal(restores(preserved.events).length, 1);
    assert.equal(barrierOf(preserved), null);
});

// --- AC10d: an in-Box stop failure keeps today's handling ---------------------

test('AC10d: when the in-Box stop throws the outer rollback decides, as before', async (t) => {
    const restored = world(t, { stopBehavior: 'throw', outerRollbackAction: 'restored' });
    restored.state.inBox = inBoxFailsBeforeIntent();
    await assert.rejects(restored.supervisor.runRestartTransaction(['restart']), (error) => error.activation.outcome === 'restored');
    assert.equal(restores(restored.events).length, 1);
    assert.equal(restored.state.postStopChecks, 0, 'postStopSelectorBound is never called');
    const preserved = world(t, { stopBehavior: 'throw', outerRollbackAction: 'reused-preserved' });
    preserved.state.inBox = inBoxFailsBeforeIntent();
    await assert.rejects(preserved.supervisor.runRestartTransaction(['restart']), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_TRANSACTION_ROLLBACK_FAILED');
        assert.match(error.message, /candidate graph stop: the in-Box stop failed/);
        return true;
    });
    assert.equal(preserved.state.postStopChecks, 0);
    assert.equal(barrierOf(preserved), null);
});

// --- AC17: the stop proof ----------------------------------------------------

test('H17: only a stopped or absent Box ends the barrier; paused and running keep it', async (t) => {
    const fixture = await heldBarrier(t);
    assert.ok(fs.existsSync(fixture.markerFile));
    // The stop sees the running Box (the barrier's restart ran with the
    // profile preflight out of the way).
    fixture.state.discoveredRunning = true;
    fixture.state.boxStatus = 'paused';
    await fixture.supervisor.runStopTransaction();
    assert.ok(barrierOf(fixture), 'a paused Box keeps the barrier');
    assert.ok(fs.existsSync(fixture.markerFile), 'and the marker');
    assert.match(fixture.stderr.value(), /Warning: the Box could not be proven stopped \(paused\); the activation recovery record and its in-Box guard were kept/);
    fixture.state.boxStatus = 'running';
    await assert.rejects(fixture.supervisor.runStartTransaction(['start', 'agent']), { code: CODE });
    assert.ok(barrierOf(fixture), 'a running Box is not proof');
    fixture.state.boxStatus = 'exited';
    await fixture.supervisor.runStopTransaction();
    assert.equal(barrierOf(fixture), null, 'an exited Box ends it');
    assert.equal(fs.existsSync(fixture.markerFile), false, 'the host unlinked the marker');
    assert.match(fixture.stderr.value(), /left an activation recovery record, but its Box is stopped; the record and its in-Box guard were cleared/);
});

test('H10: a read-only generic command adopts the running Box under a barrier without reconciling it', async (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-q30-generic-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.ploinky', 'data', 'edge-routing'), { recursive: true, mode: 0o700 });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const agentLib = agentLibFixture(workspace);
    const ownership = {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: {
            container: {
                id: BOX,
                labels: {
                    ...agentLibFixtureLabels(agentLib), [BOX_LABELS.imageRef]: BOX_IMAGE_REFERENCE,
                    [BOX_LABELS.routerHostPort]: '8080', [BOX_LABELS.mediaHostPort]: '7882',
                },
                runtime: { running: true, status: 'running', imageId: 'b'.repeat(64), mounts: agentLibFixtureMounts(agentLib, workspace) },
            },
        },
    };
    const store = createMemoryUpdateHostState();
    store.write('update-recovery', identity.instance, {
        schema: 'ploinky-activation-recovery', version: 1, instance: identity.instance, workspaceRoot: identity.workspaceRoot,
        containerId: BOX, operation: 'start', operationId: 'c'.repeat(32), state: 'indeterminate',
        intended: null, observed: null, cause: 'fixture', createdAt: new Date().toISOString(),
    });
    const events = [];
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        env: {},
        resolveIdentity: () => identity,
        launchCwd: workspace,
        lockManager: { async acquire() { return { assertHeld() {}, release() {} }; } },
        discover: () => ownership,
        updateHostState: store,
        runner: {
            run(_command, args) { events.push(['run', args[0]]); },
            query: () => ({ ok: true, status: 0, stdout: JSON.stringify({ state: 'running', initialized: true, routingConfigured: true, trackedAgents: 1, runningAgents: 1, warnings: [] }) }),
        },
        selectAgentLib: async () => ({ selection: agentLib, mode: 'local' }),
        reconcile: async () => { events.push('reconcile'); throw new Error('a read-only command must not reconcile'); },
        validateExistingImage: () => ({ immutableId: `sha256:${'b'.repeat(64)}` }),
        validateContainer: () => {},
        stdout: capture(),
        stderr: capture(),
    });
    const adopted = await supervisor.prepareBoxForCommand({ readOnly: true });
    assert.equal(adopted.action, 'adopted');
    assert.equal(adopted.containerId, BOX);
    await assert.rejects(supervisor.prepareBoxForCommand(), { code: CODE });
    assert.equal(events.includes('reconcile'), false);
    assert.ok(store.read('update-recovery', identity.instance), 'the barrier is kept');
});

test('H13 (update): a full update whose activation exits cleanly but fails its health check keeps the graph', async (t) => {
    const fixture = world(t, { discoveredRunning: true });
    fixture.state.inBox = inBoxPublishes({ status: 0 });
    fixture.state.healthFailures.push(new Error('Router health failed'));
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), (error) => {
        assert.equal(error.code, CODE);
        assert.equal(error.activation.outcome, 'kept-activated');
        assert.ok(error.updateRecords.some((entry) => entry.phase === 'activation' && entry.code === 'kept-activated'));
        return true;
    });
    assert.equal(stops(fixture.events), 0, 'Q30: host must not stop a kept graph');
    assert.equal(rollbacks(fixture.events), 0);
    assert.equal(barrierOf(fixture).operation, 'update');
});

test('the production start runs the bounded activation runner; an injected seam or runner keeps the injected path', async () => {
    assert.equal(selectActivationStart({ defaultRunner: true }), runBoundedActivationStart);
    // Only a runner that really spawns engine commands selects it.
    assert.equal(isProcessRunner(createProcessRunner()), true);
    assert.equal(isProcessRunner({ run() {}, query() {}, stream() {} }), false);
    const injected = async () => {};
    assert.equal(selectActivationStart({ startActivationCore: injected, defaultRunner: true }), injected);
    const legacy = selectActivationStart({ defaultRunner: false });
    assert.notEqual(legacy, runBoundedActivationStart, 'a fixture runner never reaches the real engine spawn');
    const thrown = new Error('core failed');
    const failing = selectActivationStart({ startCore: async () => { throw thrown; }, defaultRunner: true });
    const run = await failing();
    assert.equal(run.status, 1);
    assert.equal(run.thrown, thrown);
    assert.equal(run.quiescence.state, 'confirmed');
    assert.equal((await selectActivationStart({ startCore: async () => {}, defaultRunner: true })()).status, 0);
});

test('a converted writer barrier keeps a null baseline, so an absent selector still proves the predecessor', async (t) => {
    const fixture = world(t);
    // A first start in a workspace with no selector yet: the baseline is null.
    fs.rmSync(liveSelectorFile(fixture.workspace));
    fixture.state.inBox = () => exitRun(1, { quiescence: 'uncertain' });
    await assert.rejects(fixture.supervisor.runStartTransaction(['start', 'agent']), { code: 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN' });
    assert.equal(barrierOf(fixture).activation.baseline, null);
    // Quiescent now, with no intent and still no selector: R2a, the barrier is cleared.
    fixture.state.inBox = inBoxPublishes({ status: 0 });
    await fixture.supervisor.runStartTransaction(['start', 'agent']);
    assert.equal(barrierOf(fixture), null);
    assert.deepEqual(markerCalls(fixture.events, 'remove').map((event) => event[3]), [markerCalls(fixture.events, 'write')[0][3]]);
});

// --- Review fixes (S2-F1, S2-F2, S2-F3 and the minor items) ------------------

const REPLACED_BOX = 'd'.repeat(64);
const RESTORED_BOX = 'e'.repeat(64);

test('H11b (S2-F1): a settle restart that replaces the Box and fails before publication keeps the barrier on the restored Box', async (t) => {
    const fixture = world(t, { restoredId: RESTORED_BOX, outerRollbackAction: 'restored' });
    fixture.state.inBox = inBoxPublishes({ status: 1 });
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), { code: CODE });
    const held = structuredClone(barrierOf(fixture));
    assert.equal(held.containerId, BOX);
    // The settle restart replaces the Box and fails before it publishes; the
    // rollback recreates the old Box under a new id and restores the kept graph.
    fixture.prepared.action = 'replaced';
    fixture.prepared.ownership = { ...fixture.prepared.ownership, handles: { container: { id: REPLACED_BOX, runtime: { running: true, status: 'running' } } } };
    fixture.state.inBox = inBoxFailsBeforeIntent();
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), (error) => error.activation.outcome === 'restored');
    assert.equal(restoreContextOf(restores(fixture.events).at(-1)).containerId, RESTORED_BOX);
    // Now the workspace owns the restored Box; the barrier's Box no longer exists.
    fixture.state.ownedId = RESTORED_BOX;
    fixture.state.statusOf = (id) => (id === RESTORED_BOX ? 'running' : 'absent');
    await assert.rejects(fixture.supervisor.runStartTransaction(['start', 'agent']), (error) => {
        assert.equal(error.code, CODE);
        assert.match(error.message, new RegExp(`\\(${held.operationId.slice(0, 8)}\\)`));
        return true;
    });
    assert.equal(barrierOf(fixture)?.operationId, held.operationId, 'the barrier stays while the restored Box serves the unsettled version');
    assert.equal(barrierOf(fixture).containerId, RESTORED_BOX, 'it now names the restored Box');
    assert.ok(fs.existsSync(fixture.markerFile), 'and the marker stays');
    // A proven stop of the restored Box still ends it.
    fixture.state.discoveredRunning = true;
    fixture.state.statusOf = (id) => (id === RESTORED_BOX ? 'exited' : 'absent');
    await fixture.supervisor.runStopTransaction();
    assert.equal(barrierOf(fixture), null);
});

test('S2-F1: a running owned Box with another id is not a stop proof for a barrier', async (t) => {
    const fixture = await heldBarrier(t);
    fixture.state.ownedId = RESTORED_BOX;
    fixture.state.statusOf = (id) => (id === RESTORED_BOX ? 'running' : 'absent');
    await assert.rejects(fixture.supervisor.prepareBoxForCommand(), { code: CODE });
    assert.ok(barrierOf(fixture));
    assert.ok(fs.existsSync(fixture.markerFile));
});

test('H9b (S2-F2): a settle restart whose writer cannot be proven stopped keeps the settled barrier and marker', async (t) => {
    const fixture = await heldBarrier(t);
    const held = structuredClone(barrierOf(fixture));
    const markerBefore = fs.readFileSync(fixture.markerFile, 'utf8');
    // The settle's in-Box restart inactivated the selector, then hung.
    fixture.state.inBox = ({ workspace }) => {
        writeLive(workspace, inactive({ generation: GEN_OLD, previousGeneration: GEN_NEW, reason: 'cli-workspace-restart' }));
        return exitRun(1, { quiescence: 'uncertain' });
    };
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), { code: 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN' });
    assert.equal(barrierOf(fixture).schema, 'ploinky-update-recovery');
    // Quiescent now: the settle had not published, so the settled barrier comes back.
    await assert.rejects(fixture.supervisor.runStartTransaction(['start', 'agent']), (error) => {
        assert.equal(error.code, CODE);
        assert.match(error.message, new RegExp(`\\(${held.operationId.slice(0, 8)}\\)`));
        return true;
    });
    assert.deepEqual(barrierOf(fixture), held, 'barrier A is restored exactly');
    assert.equal(JSON.parse(fs.readFileSync(fixture.markerFile, 'utf8')).operationId, held.operationId, 'marker A is back');
    assert.equal(JSON.parse(fs.readFileSync(fixture.markerFile, 'utf8')).state, JSON.parse(markerBefore).state);
    fixture.state.inBox = inBoxPublishes({ status: 0 });
    await fixture.supervisor.runRestartTransaction(['restart']);
    const settle = coreCalls(fixture.events).at(-1)[2];
    assert.equal(settle.purpose, 'settle');
    assert.equal(settle.settlesOperationId, held.operationId);
    assert.equal(barrierOf(fixture), null);
});

test('S2-F3: an unreadable recovery record refuses generic mutations, allows reads only of the running Box, and never blocks stop', async (t) => {
    const backing = createMemoryUpdateHostState();
    let failRead = false;
    const store = {
        ...backing,
        read(kind, name) {
            if (failRead && kind === 'update-recovery') throw new Error('the recovery record is corrupt');
            return backing.read(kind, name);
        },
    };
    const fixture = world(t, { store });
    failRead = true;
    await assert.rejects(fixture.supervisor.prepareBoxForCommand(), (error) => {
        assert.equal(error.code, CODE);
        assert.match(error.message, /could not be read \(the recovery record is corrupt\)/);
        return true;
    });
    await assert.rejects(fixture.supervisor.prepareBoxForCommand({ readOnly: true }), (error) => {
        assert.equal(error.code, CODE);
        assert.match(error.message, /^An activation recovery barrier is held, so this command may only read the running Box/);
        return true;
    });
    assert.equal(fixture.events.includes('reconcile'), false);
    fixture.state.discoveredRunning = true;
    fixture.state.boxStatus = 'exited';
    await fixture.supervisor.runStopTransaction();
    assert.match(fixture.stderr.value(), /Warning: the activation recovery record could not be read \(the recovery record is corrupt\)/);
});

test('a settle restart reports the barrier settled only when it removed it', async (t) => {
    const fixture = await heldBarrier(t);
    const held = barrierOf(fixture);
    const other = { ...held, operationId: '7'.repeat(32) };
    fixture.state.inBox = (context) => {
        fixture.store.write('update-recovery', fixture.identity.instance, other);
        return inBoxPublishes({ status: 0 })(context);
    };
    await fixture.supervisor.runRestartTransaction(['restart']);
    assert.doesNotMatch(fixture.stdout.value(), /Activation recovery settled/);
    assert.deepEqual(barrierOf(fixture), other, 'a record that changed meanwhile is kept');
    assert.match(fixture.stderr.value(), /Warning: the activation recovery record changed during the settle restart; it was kept/);
});

test('after a successful settle the host removes a marker the in-Box commit left behind', async (t) => {
    const fixture = await heldBarrier(t);
    const held = barrierOf(fixture);
    // The fake in-Box command, unlike the real one, never removes the marker.
    fixture.state.inBox = inBoxPublishes({ status: 0 });
    await fixture.supervisor.runRestartTransaction(['restart']);
    assert.equal(barrierOf(fixture), null);
    assert.deepEqual(markerCalls(fixture.events, 'remove').map((event) => event[3]), [held.operationId]);
    assert.equal(fs.existsSync(fixture.markerFile), false);
});

test('status prints the activation signal for a writer barrier that carries an activation', () => {
    const writer = {
        schema: 'ploinky-update-recovery', version: 1, operation: 'restart', containerId: BOX, nonce: '6'.repeat(32),
        cause: 'timeout', detail: 'engine unavailable',
        activation: { operation: 'update', operationId: '6'.repeat(32), context: {}, baseline: null },
    };
    const lines = formatUpdateStateLines({ recoveryBarrier: writer });
    assert.match(lines[0], /^Activation recovery required: an earlier update \(66666666\) may have activated a new version /);
    assert.ok(lines.some((line) => line.startsWith('Update recovery required:')), 'the writer detail stays');
    assert.equal(isActivationRecoveryBarrier(writer), true);
    const plain = { ...writer, activation: undefined };
    assert.equal(formatUpdateStateLines({ recoveryBarrier: plain }).some((line) => line.startsWith('Activation recovery required:')), false);
    assert.equal(isActivationRecoveryBarrier(plain), false);
});
