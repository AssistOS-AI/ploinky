import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createUpdateCancellation } from '../../cli/commands/updateCancellation.js';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { runUpdateExec } from '../../ploinky-box/update/coreRunner.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';
import { fakeRestartCore, fakeUpdateCore } from '../helpers/fakeUpdateCore.mjs';

// A signal that reaches the host while it proves that an in-Box writer
// stopped. The real update runner handed its SIGINT/SIGTERM listeners back
// when the exec client ended, so without another owner a signal there ends
// the real host before its recovery barrier exists. This process reference
// records what the host would do instead: a signal with no listener would
// end the process, and `kill` is the default action raised again.

const CONTAINER_ID = 'a'.repeat(64);

function sink() {
    return { isTTY: false, write() {} };
}

function signalProcess() {
    return Object.assign(new EventEmitter(), {
        pid: 4242,
        kills: [],
        kill(pid, name) { this.kills.push([pid, name]); },
    });
}

// The real runner around a real exec client. The engine probe and the in-Box
// kill are the test's; the probe sees how many SIGINT listeners the host has.
function realRunner(processRef, { script = 'process.exit(0)', probeOnSuccess = true, probe, afterStart = null }) {
    return (nonce) => {
        const running = runUpdateExec({
            command: process.execPath,
            args: ['-e', script],
            nonce,
            probeOnSuccess,
            stdout: sink(),
            stderr: sink(),
            processRef,
            termGraceMs: 2_000,
            killGraceMs: 2_000,
            probeIntervalMs: 5,
            probe,
            killInBox: () => {},
        });
        afterStart?.();
        return running;
    };
}

// Emits SIGINT from inside the engine probe, as a Ctrl+C during the proof.
function probeWithSignal(processRef, answer) {
    const seen = [];
    return {
        seen,
        probe() {
            if (!seen.length) {
                seen.push(processRef.listenerCount('SIGINT'));
                processRef.emit('SIGINT');
            }
            return answer;
        },
    };
}

function scenario(t, {
    runUpdateCore,
    runRestartCore = null,
    processRef,
    report = 'valid',
    probeUpdateQuiescence = () => ({ ok: true, pids: [] }),
}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-proof-signals-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const selection = agentLibFixture(identity.workspaceRoot);
    const store = createMemoryUpdateHostState();
    const events = [];
    const ownership = () => ({
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: { container: { id: CONTAINER_ID, runtime: { running: true } } },
    });
    const prepared = {
        action: 'reused',
        ownership: ownership(),
        hostPort: 8080,
        mediaHostPort: 7882,
        previousAgentLib: selection,
        validate() {},
        finalize() {},
        async rollback() {
            events.push('rollback');
            return { action: 'reused-preserved', containerId: CONTAINER_ID, hostPort: 8080, mediaHostPort: 7882, agentLib: selection };
        },
    };
    const writeReport = fakeUpdateCore({ report });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: {
            async acquire() {
                return { assertHeld() {}, release() {} };
            },
        },
        discover: () => ownership(),
        env: {},
        stdout: sink(),
        stderr: sink(),
        updateHostState: store,
        runner: {
            run() {},
            // An active graph: a verified full update restarts it.
            query: () => ({ ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: true }) }),
        },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        updateWorkspacePloinky: async () => null,
        updateAgentLib: async () => ({ selection, changed: false, previous: selection }),
        selectAgentLib: async () => ({ selection }),
        reconcile: async () => prepared,
        runCoreCommand: async (_engine, _id, argv) => { events.push(['core', [...argv]]); },
        runUpdateCore: async (...args) => {
            const options = args[6];
            await writeReport(...args);
            events.push(['core', [...args[2]]]);
            return runUpdateCore(options.reportNonce);
        },
        runRestartCore: runRestartCore
            ? async (...args) => { events.push(['core', [...args[2]]]); return runRestartCore(args[6].operationId); }
            : fakeRestartCore(async (_engine, _id, argv) => { events.push(['core', [...argv]]); }),
        createCancellation: () => createUpdateCancellation({ processRef }),
        probeUpdateQuiescence,
        resolveHostReachableIpv4: async () => '',
        healthCheck: async () => {},
        revalidateAgentLibSource() {},
        commitAgentLibSelection() { events.push('commit-agentlib'); },
        readAgentLibActive: () => null,
        restoreAgentLibActive() {},
    });
    return { supervisor, identity, store, events };
}

const coreCalls = events => events.filter(event => Array.isArray(event) && event[0] === 'core').map(event => event[1]);
const listeners = processRef => [processRef.listenerCount('SIGINT'), processRef.listenerCount('SIGTERM')];

test('a signal while the host proves the in-Box update stopped cannot end it before the recovery barrier', async (t) => {
    const processRef = signalProcess();
    // A Ctrl+C also ends the engine query the host is waiting on.
    const proof = probeWithSignal(processRef, { ok: false, detail: 'the engine query was interrupted' });
    const fixture = scenario(t, { processRef, runUpdateCore: realRunner(processRef, { probe: proof.probe }) });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN');
        assert.match(error.message, /A recovery record now blocks new mutations/);
        return true;
    });
    assert.ok(proof.seen[0] > 0, 'the host still owned SIGINT when it arrived during the proof');
    const barrier = fixture.store.read('update-recovery', fixture.identity.instance);
    assert.equal(barrier?.operation, 'update');
    assert.equal(barrier.detail, 'the engine query was interrupted');
    assert.deepEqual(coreCalls(fixture.events), [['update']], 'nothing after the unproven writer');
    assert.deepEqual(processRef.kills, [], 'the recovery error reports the signal; it is not raised again first');
    assert.deepEqual(listeners(processRef), [0, 0], 'the signals were handed back');
});

test('a signal during a proof that confirms the writer stopped cancels the update before activation', async (t) => {
    const processRef = signalProcess();
    const proof = probeWithSignal(processRef, { ok: true, pids: [] });
    const fixture = scenario(t, { processRef, runUpdateCore: realRunner(processRef, { probe: proof.probe }) });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.ok(proof.seen[0] > 0, 'the host still owned SIGINT when it arrived during the proof');
    const cancelled = result.records.filter(record => record.phase === 'command' && record.code === 'cancelled');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].outcome, 'failed');
    assert.match(cancelled[0].reason, /cancelled by SIGINT before activation/);
    assert.deepEqual([result.decision.exitCode, result.decision.activationAllowed, result.activation.outcome], [1, false, 'deferred']);
    assert.deepEqual(coreCalls(fixture.events), [['update']], 'no restart after the cancellation');
    assert.equal(fixture.events.includes('commit-agentlib'), false);
    assert.equal(fixture.store.read('update-recovery', fixture.identity.instance), null, 'the engine proved the writer stopped');
    assert.deepEqual(processRef.kills, []);
    assert.deepEqual(listeners(processRef), [0, 0]);
});

test('a signal while the host re-proves the writer of an invalid report cannot end it before the barrier', async (t) => {
    const processRef = signalProcess();
    const reproof = probeWithSignal(processRef, { ok: false, detail: 'the engine query was interrupted' });
    const fixture = scenario(t, {
        processRef,
        report: 'truncated',
        runUpdateCore: realRunner(processRef, { probe: () => ({ ok: true, pids: [] }) }),
        // After the runner returned: the host's own probe before its barrier.
        probeUpdateQuiescence: reproof.probe,
    });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), { code: 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN' });
    assert.ok(reproof.seen[0] > 0, 'the host still owned SIGINT after the runner handed it back');
    assert.equal(fixture.store.read('update-recovery', fixture.identity.instance)?.detail, 'the engine query was interrupted');
    assert.deepEqual(processRef.kills, []);
    assert.deepEqual(listeners(processRef), [0, 0]);
});

test('a signal that cancels the exec client stays the run cause and is reported once', async (t) => {
    const processRef = signalProcess();
    const atSignal = [];
    const proof = { probe: () => ({ ok: true, pids: [] }) };
    const runUpdateCore = realRunner(processRef, {
        script: 'setInterval(() => {}, 1000)',
        probe: proof.probe,
        afterStart: () => setTimeout(() => {
            atSignal.push(processRef.listenerCount('SIGINT'));
            processRef.emit('SIGINT');
        }, 50),
    });
    const fixture = scenario(t, { processRef, runUpdateCore });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.deepEqual(atSignal, [2], 'the runner and the host both listen while the client runs');
    const runnerRecords = result.records.filter(record => record.id === 'in-box-update-runner');
    assert.deepEqual(runnerRecords.map(record => [record.outcome, record.code]), [['uncertain', 'signal:SIGINT']]);
    assert.equal(result.records.some(record => record.code === 'cancelled'), false, 'the cause already reports it');
    assert.equal(result.decision.activationAllowed, false);
    assert.deepEqual(coreCalls(fixture.events), [['update']]);
    assert.deepEqual(processRef.kills, []);
    assert.deepEqual(listeners(processRef), [0, 0]);
});

test('a signal while the host proves the update restart stopped cannot end it before the restart barrier', async (t) => {
    const processRef = signalProcess();
    const proof = probeWithSignal(processRef, { ok: false, detail: 'the engine query was interrupted' });
    const fixture = scenario(t, {
        processRef,
        runUpdateCore: realRunner(processRef, { probe: () => ({ ok: true, pids: [] }) }),
        // The restart client ends abnormally, so its writers must be proven stopped.
        runRestartCore: realRunner(processRef, { script: 'process.exit(3)', probeOnSuccess: false, probe: proof.probe }),
    });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN');
        assert.match(error.message, /graph restart ended abnormally[\s\S]*A recovery record now blocks new mutations/);
        return true;
    });
    assert.ok(proof.seen[0] > 0, 'the host still owned SIGINT when it arrived during the restart proof');
    assert.equal(fixture.store.read('update-recovery', fixture.identity.instance)?.operation, 'restart');
    assert.deepEqual(coreCalls(fixture.events), [['update'], ['restart']]);
    assert.equal(fixture.events.includes('rollback'), false, 'a Box whose restart writer may run is never rolled back');
    assert.deepEqual(processRef.kills, []);
    assert.deepEqual(listeners(processRef), [0, 0]);
});

test('a signal after a normal restart end keeps its default action', async (t) => {
    const processRef = signalProcess();
    const fixture = scenario(t, {
        processRef,
        runUpdateCore: realRunner(processRef, { probe: () => ({ ok: true, pids: [] }) }),
        runRestartCore: async (operationId) => {
            const run = await realRunner(processRef, { probeOnSuccess: false, probe: () => ({ ok: true, pids: [] }) })(operationId);
            processRef.emit('SIGINT');
            return run;
        },
    });
    await fixture.supervisor.runUpdateTransaction(['update']);
    assert.deepEqual(processRef.kills, [[4242, 'SIGINT']], 'raised again once nothing listens for it');
    assert.deepEqual(listeners(processRef), [0, 0]);
});
