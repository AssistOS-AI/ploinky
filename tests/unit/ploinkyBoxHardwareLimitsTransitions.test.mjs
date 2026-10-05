import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    SimulatedProcessDeath,
    abortHardwareDowngradesForDestroy,
    createTransitionStore,
    digestOf,
    recoverHardwareDowngrades,
    runHardwareDowngrade,
} from '../../ploinky-box/hardwareLimitsTransition.mjs';
import {
    assertPolicyWritesAllowed,
    beginDowngradeBarrier,
    clearAgentLimits,
    hardwareStorePaths,
    initializeStore,
    readBarrier,
    readStoreSnapshot,
    setAgentLimits,
} from '../../cli/sandbox/hardwareLimits/store.mjs';
import { createHardwareGateStore, readLimitsStatus } from '../../ploinky-box/hardwareLimitsGate.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import {
    T_FAULT_EFFECTS,
    T_FAULT_KINDS,
    T_FAULT_SIDES,
} from '../hardware-limits/fixtures.mjs';
import {
    Engine,
    effectsFor,
    loadWorldState,
    worldState,
} from '../hardware-limits/transitionWorld.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INSTALLED = new Set(['demo/agent']);
const CAPABILITIES = { gate: 'on', controllers: ['cpu', 'memory', 'pids'] };
const ENVELOPE = { cpus: 8, memoryBytes: 16 * 1024 ** 3 };

// The simulated engine and effects live in a test module that also runs as a
// fresh recovery process (V6, §6.4): the recovery reloads only the durable
// engine/record state and the on-disk journal, never this process's objects.
const OLD_CONFIG = Object.freeze({ image: 'img@sha256:1', hostPort: 8080, hardware: { fingerprint: 'a'.repeat(64) } });
const DESIRED_CONFIG = Object.freeze({ image: 'img@sha256:1', hostPort: 8080, hardware: null });
const REAPPLY_CONFIG = Object.freeze({ image: 'img@sha256:1', hostPort: 8080, hardware: null, gpu: { fingerprint: 'b'.repeat(64) } });

function world(t, { oldRunning = true, graphRunning = true, reapply = false } = {}) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-transition-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const workspaceRoot = path.join(home, 'workspace');
    fs.mkdirSync(workspaceRoot);
    const identity = Object.freeze({ instance: 'ploinky-box-demo-0123456789ab', pathHash: '0123456789ab', workspaceRoot, dataPaths: {} });
    const paths = hardwareStorePaths({ identity, homeDirectory: home });
    initializeStore({ paths, identity });
    const engine = new Engine();
    const oldId = engine.add(OLD_CONFIG, { running: oldRunning, graphRunning: oldRunning && graphRunning });
    const value = {
        home,
        identity,
        paths,
        engine,
        oldId,
        oldRunning,
        oldGraphRunning: oldRunning && graphRunning,
        reapply,
        records: new Map([['gate', true], ['gpu', 'gpu-decision-1'], ['router', 'router-binding-1']]),
        graphResult: { state: 'ready', optionalPendingKeys: [] },
    };
    return value;
}

function downgradeArgs(w, faults = {}) {
    return {
        identity: w.identity,
        operation: 'restart',
        oldContainerId: w.oldId,
        oldConfiguration: OLD_CONFIG,
        desiredConfiguration: DESIRED_CONFIG,
        graphSnapshot: { schema: 1, coreArgv: ['start', 'explorer', '8080'] },
        oldWasRunning: w.oldRunning,
        oldGraphRunning: w.oldGraphRunning,
        hostRecords: [
            { name: 'gate', old: true, next: false },
            { name: 'gpu', old: 'gpu-decision-1', next: 'gpu-decision-1' },
            { name: 'router', old: 'router-binding-1', next: 'router-binding-1' },
        ],
        reapplyConfiguration: w.reapply ? REAPPLY_CONFIG : null,
        homeDirectory: w.home,
        effects: effectsFor(w),
        faults,
    };
}

const RECOVERY_CHILD = fileURLToPath(new URL('../hardware-limits/transitionWorld.mjs', import.meta.url));

// Recover in a FRESH node process that reads only durable records: the
// engine/record state file, the journal, snapshots, receipts and barrier.
function recoverInFreshProcess(w) {
    const statePath = path.join(w.home, `recovery-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(statePath, JSON.stringify(worldState(w)), { mode: 0o600 });
    const child = spawnSync(process.execPath, [RECOVERY_CHILD, 'recover', statePath], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    fs.rmSync(statePath, { force: true });
    assert.notEqual(state.pid, process.pid, 'recovery ran in another process');
    loadWorldState(w, state);
    if (state.failure) throw Object.assign(new Error(state.failure.message), { code: state.failure.code });
    return state.results;
}

async function runThenRecover(w, faults) {
    let failure = null;
    try {
        await runHardwareDowngrade(downgradeArgs(w, faults));
    } catch (error) {
        failure = error;
    }
    // The interrupted process is gone: its closures and objects are discarded.
    const recovered = recoverInFreshProcess(w);
    return { failure, recovered };
}

function journals(w) {
    const directory = createTransitionStore({ identity: w.identity, homeDirectory: w.home }).directory;
    let names = [];
    try { names = fs.readdirSync(directory).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)); } catch (_) { return []; }
    return names.map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

function assertCommitted(w) {
    const boxes = [...w.engine.boxes];
    assert.equal(boxes.length, 1, 'exactly one Box exists');
    const [, box] = boxes[0];
    assert.equal(digestOf(box.config), digestOf(w.reapply ? REAPPLY_CONFIG : DESIRED_CONFIG), 'the gate-off Box is the decided target');
    assert.equal(box.running, true);
    assert.equal(box.graphRunning, true);
    assert.equal(w.records.get('gate'), false, 'the gate record is off');
    assert.equal(readBarrier({ paths: w.paths }), null, 'writers are open again');
    assert.deepEqual(journals(w).map((journal) => journal.phase), ['committed']);
}

function assertRolledBack(w) {
    const boxes = [...w.engine.boxes];
    assert.equal(boxes.length, 1, 'exactly one Box exists');
    const [id, box] = boxes[0];
    assert.equal(digestOf(box.config), digestOf(OLD_CONFIG), 'the gate-on configuration is restored');
    assert.equal(box.running, w.oldRunning, 'the prior running state is restored');
    assert.equal(box.graphRunning, w.oldGraphRunning, 'the prior graph state is restored');
    if (box.running && id !== w.oldId) assert.ok(w.engine.prepares.get(id) >= 1, 'a restored gate-on generation is prepared');
    assert.equal(w.records.get('gate'), true, 'the gate record stays on');
    assert.equal(readBarrier({ paths: w.paths }), null, 'the barrier is removed');
    for (const journal of journals(w)) assert.equal(journal.phase, 'rolled-back');
}

test('T.first-on-no-barrier', async (t) => {
    const w = world(t);
    // First enable: no observed gate-on Box, so no journal or barrier.
    const gateStore = createHardwareGateStore({ homeDirectory: w.home });
    assert.equal(gateStore.read(w.identity), null);
    assert.equal(readBarrier({ paths: w.paths }), null);
    assert.deepEqual(journals(w), []);
    // Ordinary token revalidation still governs writes.
    const snapshot = readStoreSnapshot({ paths: w.paths, identity: w.identity });
    assert.doesNotThrow(() => assertPolicyWritesAllowed({ paths: w.paths }));
    setAgentLimits({ paths: w.paths, identity: w.identity, expectedToken: snapshot.token, agentRef: 'demo/agent', limits: { cpus: 1 }, installedRefs: INSTALLED, capabilities: CAPABILITIES, envelope: ENVELOPE });
});

test('T.on-on-no-barrier', async (t) => {
    const w = world(t);
    const before = readStoreSnapshot({ paths: w.paths, identity: w.identity });
    // A gate-on to gate-on replacement never installs a barrier: both
    // generations read the authoritative policy.
    assert.equal(readBarrier({ paths: w.paths }), null);
    assert.deepEqual(journals(w), []);
    assert.doesNotThrow(() => assertPolicyWritesAllowed({ paths: w.paths }));
    assert.equal(readStoreSnapshot({ paths: w.paths, identity: w.identity }).token.revision, before.token.revision);
});

test('T.policy-write-before-barrier', async (t) => {
    const w = world(t);
    const snapshot = readStoreSnapshot({ paths: w.paths, identity: w.identity });
    setAgentLimits({ paths: w.paths, identity: w.identity, expectedToken: snapshot.token, agentRef: 'demo/agent', limits: { cpus: 1 }, installedRefs: INSTALLED, capabilities: CAPABILITIES, envelope: ENVELOPE });
    await assert.rejects(runHardwareDowngrade(downgradeArgs(w)), /stored hardware limits/);
    assertRolledBack(w);
    assert.equal(w.engine.creates, 0, 'the setter won: no Box mutation');
});

test('T.policy-write-after-barrier', async (t) => {
    const w = world(t);
    const snapshot = readStoreSnapshot({ paths: w.paths, identity: w.identity });
    beginDowngradeBarrier({ paths: w.paths, identity: w.identity, operationId: '1'.repeat(32), expectedEmptyToken: snapshot.token });
    assert.throws(() => setAgentLimits({ paths: w.paths, identity: w.identity, expectedToken: snapshot.token, agentRef: 'demo/agent', limits: { cpus: 1 }, installedRefs: INSTALLED, capabilities: CAPABILITIES, envelope: ENVELOPE }),
        (error) => error.code === 'hardware_limits_transition');
    assert.throws(() => clearAgentLimits({ paths: w.paths, identity: w.identity, expectedToken: snapshot.token, agentRef: 'demo/agent' }),
        (error) => error.code === 'hardware_limits_transition');
});

test('T.reads-and-watchdog-during-barrier', async (t) => {
    const w = world(t);
    const snapshot = readStoreSnapshot({ paths: w.paths, identity: w.identity });
    beginDowngradeBarrier({ paths: w.paths, identity: w.identity, operationId: '2'.repeat(32), expectedEmptyToken: snapshot.token });
    // Reads, status and admission inputs remain available under the barrier.
    assert.equal(readStoreSnapshot({ paths: w.paths, identity: w.identity }).status, 'valid');
    const boxPaths = hardwareStorePaths({ identity: w.identity, context: 'box', boxRoot: w.paths.storeRoot });
    assert.equal(readStoreSnapshot({ paths: boxPaths, identity: w.identity }).status, 'valid', 'in-Box admission reads the store');
    const status = readLimitsStatus({ identity: w.identity, gateStore: createHardwareGateStore({ homeDirectory: w.home }), env: {} });
    assert.equal(status.transition.barrier.operationId, '2'.repeat(32));
});

test('T.apply-blocked', async (t) => {
    const w = world(t);
    const snapshot = readStoreSnapshot({ paths: w.paths, identity: w.identity });
    beginDowngradeBarrier({ paths: w.paths, identity: w.identity, operationId: '3'.repeat(32), expectedEmptyToken: snapshot.token });
    assert.throws(() => assertPolicyWritesAllowed({ paths: w.paths }), (error) => error.code === 'hardware_limits_transition' && error.status === 409);
    fs.writeFileSync(w.paths.barrierPath, '{malformed', { mode: 0o600 });
    assert.throws(() => assertPolicyWritesAllowed({ paths: w.paths }), (error) => error.code === 'hardware_limits_transition',
        'a malformed barrier still blocks mutations');
});

test('T.interrupted-old-graph-stopped', async (t) => {
    const w = world(t);
    const { failure } = await runThenRecover(w, { 'inner-stop.after': 'process-death' });
    assert.ok(failure instanceof SimulatedProcessDeath);
    assertRolledBack(w);
    assert.equal(w.engine.creates, 0, 'the old Box was only restarted, never recreated');
});

test('T.optional-cold-child-pending-at-commit', async (t) => {
    const w = world(t);
    w.graphResult = { state: 'starting', optionalPendingKeys: ['ploinky_cold_child_ws'] };
    await runHardwareDowngrade(downgradeArgs(w));
    assertCommitted(w);
    const [journal] = journals(w);
    const store = createTransitionStore({ identity: w.identity, homeDirectory: w.home });
    const graphResult = store.readSnapshot(journal.commitIntent.graphResultRef);
    assert.equal(graphResult.state, 'starting');
    assert.equal(graphResult.optionalPendingCount, 1);
});

test('T.old-stopped-remains-stopped', async (t) => {
    const w = world(t, { oldRunning: false });
    await runThenRecover(w, { 'candidate-start.after': 'io-error' });
    assertRolledBack(w);
    const [[, box]] = [...w.engine.boxes];
    assert.equal(box.running, false);
    assert.equal(box.graphRunning, false);
});

test('T.stopped-downgrade-graph-not-started', async (t) => {
    // R7: a stopped gate-on Box had no running graph; the committed gate-off
    // Box does not start one, and the decision records no graph result.
    const w = world(t, { oldRunning: false });
    await runHardwareDowngrade(downgradeArgs(w));
    const [[, box]] = [...w.engine.boxes];
    assert.equal(digestOf(box.config), digestOf(DESIRED_CONFIG));
    assert.equal(box.graphRunning, false, 'the graph was not running before, so it is not started');
    assert.equal(journals(w)[0].commitIntent.graphResultRef, null);
});

test('T.rollforward-desired-records', async (t) => {
    const w = world(t);
    const { failure } = await runThenRecover(w, { 'desired-gate-write.before': 'process-death' });
    assert.ok(failure instanceof SimulatedProcessDeath);
    assertCommitted(w);
});

test('T.rollforward-restored-records', async (t) => {
    const w = world(t);
    await runThenRecover(w, { 'candidate-graph.after': 'io-error', 'restored-gate-write.before': 'process-death' });
    assertRolledBack(w);
    assert.equal(w.records.get('gate'), true, 'never writes the desired-off records');
});

test('T.ownerless-host-lock', async (t) => {
    const w = world(t);
    const manager = createMutationLockManager({ homeDirectory: w.home, timeoutMs: 100, retryMs: 10 });
    const lockPath = path.join(manager.locksRoot, `${w.identity.instance}.lock`);
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    // An ownerless lock is a transient observation (an acquirer publishes the directory before its owner file): the acquirer keeps waiting
    // and times out, never reclaiming it.
    await assert.rejects(manager.acquire(w.identity.instance), /Timed out waiting for mutation lock/);
    assert.ok(fs.existsSync(lockPath), 'an ownerless lock is preserved, never reclaimed by age');
});

test('T.cid-outside-lock', async (t) => {
    const w = world(t);
    const store = createTransitionStore({ identity: w.identity, homeDirectory: w.home });
    const receipt = store.receiptPath('4'.repeat(32));
    const locksRoot = createMutationLockManager({ homeDirectory: w.home }).locksRoot;
    assert.equal(receipt.startsWith(`${locksRoot}${path.sep}`), false);
    assert.equal(path.dirname(receipt), store.directory);
    // Legacy residue in a stale host lock is preserved, never deleted.
    const manager = createMutationLockManager({ homeDirectory: w.home, timeoutMs: 100, retryMs: 10, kill: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } });
    const lockPath = path.join(manager.locksRoot, `${w.identity.instance}.lock`);
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({ hostname: os.hostname(), pid: 999999, instance: w.identity.instance, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(lockPath, 'candidate-0123456789abcdef.cid'), 'f'.repeat(64));
    await assert.rejects(manager.acquire(w.identity.instance), /unexpected entries/);
    assert.ok(fs.existsSync(path.join(lockPath, 'owner.json')), 'the owner record is not deleted before the residue check');
});

test('T.foreign-id-blocked', async (t) => {
    const w = world(t);
    try {
        await runHardwareDowngrade(downgradeArgs(w, { 'old-remove.after': 'process-death' }));
    } catch (error) {
        assert.ok(error instanceof SimulatedProcessDeath);
    }
    const foreign = w.engine.add({ image: 'someone-else' });
    const results = await recoverHardwareDowngrades({ identity: w.identity, homeDirectory: w.home, effects: effectsFor(w) });
    assert.equal(results[0].phase, 'recovery-blocked');
    assert.ok(w.engine.boxes.has(foreign), 'a foreign Box is never removed');
    assert.ok(readBarrier({ paths: w.paths }), 'the barrier is preserved as evidence');
    assert.equal(journals(w)[0].phase, 'recovery-blocked');
});

test('T.stop-with-broken-store', async (t) => {
    const w = world(t);
    // Stop needs neither the policy store nor its lock.
    fs.mkdirSync(path.join(w.paths.storeRoot, 'write.lock'), { mode: 0o700 });
    fs.writeFileSync(w.paths.policyPath, '{broken', { mode: 0o600 });
    const { createBoxSupervisor } = await import('../../ploinky-box/supervisor.mjs');
    const events = [];
    const supervisor = createBoxSupervisor({
        env: {},
        resolveIdentity: () => ({ ...w.identity, markerFound: true, anchorPath: path.join(w.identity.workspaceRoot, '.ploinky') }),
        lockManager: createMutationLockManager({ homeDirectory: w.home }),
        discover: () => ({ state: 'owned', engine: { name: 'podman', identity: 'engine-1' }, handles: { container: { id: w.oldId, runtime: { running: true } } } }),
        runner: { run(_command, args) { events.push(args.slice(0, 2).join(' ')); } },
        hardwareGateStore: createHardwareGateStore({ homeDirectory: w.home }),
    });
    fs.mkdirSync(path.join(w.identity.workspaceRoot, '.ploinky'), { recursive: true });
    const result = await supervisor.runStopTransaction();
    assert.equal(result.action, 'stopped');
    assert.ok(events.includes('container stop'));
});

test('T.destroy-receipt', async (t) => {
    const w = world(t);
    try {
        await runHardwareDowngrade(downgradeArgs(w, { 'outer-stop.after': 'process-death' }));
    } catch (error) {
        assert.ok(error instanceof SimulatedProcessDeath);
    }
    assert.ok(readBarrier({ paths: w.paths }));
    const aborted = abortHardwareDowngradesForDestroy({ identity: w.identity, homeDirectory: w.home });
    assert.equal(aborted.length, 1);
    assert.equal(readBarrier({ paths: w.paths }), null);
    assert.equal(journals(w)[0].phase, 'aborted-by-destroy');
});

// ---------------------------------------------------------------------------
// §6.4 / §18.3 fault-injection matrix: T.fault.<effect>.<side>.<fault>

const COMMITTING_EFFECTS = new Set([
    'desired-gate-write', 'desired-gpu-record', 'desired-router-record', 'barrier-remove', 'committed-receipt',
]);
const ROLLBACK_EFFECTS = new Set([
    'rollback-create', 'rollback-prepare', 'rollback-graph', 'restored-commit-intent', 'restored-gate-write',
    'restored-gpu-record', 'restored-router-record', 'rolledback-receipt',
]);

function scenarioFor(effect, side, fault) {
    const faults = { [`${effect}.${side}`]: fault };
    const options = {};
    if (effect.startsWith('reapply-')) options.reapply = true;
    if (ROLLBACK_EFFECTS.has(effect)) {
        // Reach the rollback path first with an I/O failure before the
        // decision; rollback-create additionally needs the old Box removed.
        faults['candidate-graph.after'] = 'io-error';
    }
    let expected = 'rolled-back';
    if (COMMITTING_EFFECTS.has(effect)) expected = 'committed';
    if (effect === 'desired-commit-intent' && side === 'after') expected = 'committed';
    if (effect === 'snapshot' || effect === 'prepared-journal') expected = 'untouched';
    return { faults, options, expected };
}

for (const effect of T_FAULT_EFFECTS) {
    for (const side of T_FAULT_SIDES) {
        for (const fault of T_FAULT_KINDS) {
            test(`T.fault.${effect}.${side}.${fault}`, async (t) => {
                const { faults, options, expected } = scenarioFor(effect, side, fault);
                const w = world(t, options);
                const { failure } = await runThenRecover(w, faults);
                if (fault === 'process-death') {
                    assert.ok(failure instanceof SimulatedProcessDeath, `the injected death interrupted the operation (${failure?.message})`);
                }
                if (expected === 'committed') {
                    assertCommitted(w);
                } else if (expected === 'untouched') {
                    // No durable plan existed: nothing destructive happened.
                    const boxes = [...w.engine.boxes];
                    assert.equal(boxes.length, 1);
                    assert.equal(boxes[0][0], w.oldId);
                    assert.equal(boxes[0][1].running, true);
                    assert.equal(readBarrier({ paths: w.paths }), null);
                    assert.equal(w.records.get('gate'), true);
                    for (const journal of journals(w)) assert.equal(journal.phase, 'rolled-back');
                } else {
                    assertRolledBack(w);
                }
                // Never a duplicate create or deletion by name.
                assert.ok(w.engine.creates <= (options.reapply ? 3 : 2), `bounded creates (${w.engine.creates})`);
                assert.equal(w.engine.removedByName, 0);
            });
        }
    }
}

for (const mismatch of ['engineIdentity', 'hostKind']) {
    test(`fresh-process recovery blocks changed ${mismatch} before engine or host effects`, async (t) => {
        const w = world(t);
        await assert.rejects(runHardwareDowngrade(downgradeArgs(w, { 'old-remove.after': 'process-death' })), SimulatedProcessDeath);
        const statePath = path.join(w.home, 'recovery-state.json');
        fs.writeFileSync(statePath, JSON.stringify(worldState(w)));
        const transitionModule = new URL('../../ploinky-box/hardwareLimitsTransition.mjs', import.meta.url).href;
        const worldModule = new URL('../hardware-limits/transitionWorld.mjs', import.meta.url).href;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
            import fs from 'node:fs';
            import { recoverHardwareDowngrades } from ${JSON.stringify(transitionModule)};
            import { Engine, effectsFor } from ${JSON.stringify(worldModule)};
            const state = JSON.parse(fs.readFileSync(process.argv[1]));
            const w = { ...state, engine: new Engine().load(state.engine), records: new Map(state.records) };
            const effects = effectsFor(w);
            effects[${JSON.stringify(mismatch)}] = 'different';
            let effectsRun = 0;
            for (const [name, value] of Object.entries(effects)) if (typeof value === 'function') {
                effects[name] = () => { effectsRun++; throw new Error('unexpected effect ' + name); };
            }
            const results = await recoverHardwareDowngrades({ identity: w.identity, homeDirectory: w.home, effects });
            console.log(JSON.stringify({ results, effectsRun }));
        `, statePath], { encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout);
        assert.equal(result.effectsRun, 0);
        assert.equal(result.results[0].phase, 'recovery-blocked');
        assert.ok(readBarrier({ paths: w.paths }));
        assert.equal(createTransitionStore({ identity: w.identity, homeDirectory: w.home }).listPending()[0].lastProblem.code,
            'ENGINE_IDENTITY_CHANGED');
    });
}
