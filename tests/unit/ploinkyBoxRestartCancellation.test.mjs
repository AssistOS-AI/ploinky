import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createUpdateCancellation } from '../../cli/commands/updateCancellation.js';
import { writeGraphSkillScope } from '../../ploinky-box/graphSkillScope.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { buildHostSkillScope } from '../../ploinky-box/skillScope.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { runUpdateExec } from '../../ploinky-box/update/coreRunner.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';

// An operator Ctrl+C, or a lost engine connection, during an ordinary
// workspace `ploinky restart`. The exec client ending never ends the in-Box
// restart, so the host must own the signal until the engine proves that
// restart's writer stopped, or leave a durable barrier, before anything else
// touches the graph. The process reference records what the real host would
// do: a signal with no listener would end it, and `kill` is the default
// action raised again. The engine's view of the in-Box writer is `writer`.

const CONTAINER_ID = 'b'.repeat(64);

function sink() {
    return { isTTY: false, write() {} };
}

function signalProcess() {
    const events = [];
    return Object.assign(new EventEmitter(), {
        pid: 4242,
        kills: [],
        events,
        kill(pid, name) { this.kills.push([pid, name]); events.push(['kill', name]); },
    });
}

// The engine answers for one in-Box restart writer (pid 777) until a signal
// in `stopsOn` reaches it.
function inBoxWriter(events, { stopsOn = ['TERM'] } = {}) {
    const writer = {
        alive: true,
        probes: [],
        probe() {
            writer.probes.push(writer.alive);
            return { ok: true, pids: writer.alive ? [777] : [] };
        },
        killInBox(pids, signal) {
            events.push(['in-box-kill', signal, [...pids]]);
            if (stopsOn.includes(signal)) writer.alive = false;
        },
    };
    return writer;
}

// The real restart runner around a real exec client; the engine probe and
// in-Box kill are the writer's. `behavior` may change between restarts.
function realRestartCore(processRef, writer, behavior) {
    return async (_engine, _id, argv, _port, _media, _runner, options) => {
        processRef.events.push(['restart-core', [...argv], options.operationId]);
        const running = runUpdateExec({
            command: process.execPath,
            args: ['-e', behavior.script],
            nonce: options.operationId,
            stdout: sink(),
            stderr: sink(),
            processRef,
            termGraceMs: behavior.termGraceMs ?? 2_000,
            killGraceMs: behavior.killGraceMs ?? 2_000,
            probeIntervalMs: 5,
            probe: writer.probe,
            killInBox: writer.killInBox,
        });
        behavior.afterStart?.();
        return running;
    };
}

// Before the fix the workspace restart ran through the generic core command;
// the same in-Box restart is replayed there so the old route stays observable.
function coreCommand(processRef, { onRestart = null } = {}) {
    return async (_engine, _id, argv) => {
        processRef.events.push(['core', [...argv]]);
        if (argv.includes('restart')) await onRestart?.();
    };
}

function emitSigintAfterStart(processRef, atSignal) {
    return () => setTimeout(() => {
        atSignal.push(processRef.listenerCount('SIGINT'));
        processRef.emit('SIGINT');
    }, 50);
}

function scenario(t, { processRef, writer, runRestartCore, runCoreCommand, probeUpdateQuiescence }) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-restart-cancel-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    // The running graph was admitted before, so a rollback can restore it.
    writeGraphSkillScope(identity, buildHostSkillScope(root, root), { assertHeld() {} });
    const selection = agentLibFixture(identity.workspaceRoot);
    const store = createMemoryUpdateHostState();
    const events = processRef.events;
    const ownership = () => ({
        state: 'owned',
        engine: { name: 'fixture-engine', identity: 'engine' },
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
            events.push('outer-rollback');
            return { action: 'reused-preserved', containerId: CONTAINER_ID, hostPort: 8080, mediaHostPort: 7882, agentLib: selection };
        },
    };
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: { async acquire() { return { assertHeld() {}, release() {} }; } },
        discover: () => ownership(),
        env: {},
        stdout: sink(),
        stderr: sink(),
        updateHostState: store,
        runner: {
            // The in-Box `ploinky-local stop` of a rollback, and whether the
            // restart writer still ran when it stopped the graph.
            run(_command, args) { events.push(['run', args.at(-1), writer.alive]); },
            async stream(_command, args) { events.push(['stream', args.at(-1)]); return { ok: true, status: 0, stdout: '', stderr: '' }; },
            query: () => ({ ok: true, stdout: '' }),
        },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        selectAgentLib: async () => ({ selection }),
        reconcile: async () => { events.push('reconcile'); return prepared; },
        runCoreCommand,
        runRestartCore,
        createCancellation: () => createUpdateCancellation({ processRef }),
        probeUpdateQuiescence: probeUpdateQuiescence || (() => writer.probe()),
        resolveHostReachableIpv4: async () => '',
        healthCheck: async () => { events.push('health'); },
        revalidateAgentLibSource() {},
        commitAgentLibSelection() { events.push('commit-agentlib'); },
        readAgentLibActive: () => null,
        restoreAgentLibActive() {},
    });
    return { supervisor, identity, store, events };
}

const listeners = processRef => [processRef.listenerCount('SIGINT'), processRef.listenerCount('SIGTERM')];
const settled = promise => promise.then(() => null, error => error);
const indexOf = (events, predicate) => events.findIndex(event => Array.isArray(event) && predicate(event));

test('Ctrl+C during a workspace restart is held until the engine proves the restart writer stopped, then the prior graph is restored', async (t) => {
    const processRef = signalProcess();
    const writer = inBoxWriter(processRef.events);
    const atSignal = [];
    const replay = emitSigintAfterStart(processRef, atSignal);
    const fixture = scenario(t, {
        processRef,
        writer,
        runRestartCore: realRestartCore(processRef, writer, { script: 'setInterval(() => {}, 1000)', afterStart: replay }),
        runCoreCommand: coreCommand(processRef, { onRestart: async () => { replay(); await new Promise(r => setTimeout(r, 100)); } }),
    });
    const failure = await settled(fixture.supervisor.runRestartTransaction(['restart']));
    assert.deepEqual(atSignal, [2], 'the runner and the host both own SIGINT while the in-Box restart runs');
    assert.equal(failure?.code, 'PLOINKY_BOX_UPDATE_RESTART_FAILED');
    assert.match(failure.message, /In-box restart failed \(signal:SIGINT/);
    assert.equal(failure.activation?.outcome, 'restored');
    const events = fixture.events;
    const [restart] = events.filter(event => event[0] === 'restart-core');
    assert.deepEqual(restart[1], ['restart']);
    assert.match(restart[2], /^[0-9a-f]{32}$/, 'the restart carries its own operation marker');
    const kill = indexOf(events, event => event[0] === 'in-box-kill');
    const stop = indexOf(events, event => event[0] === 'run' && event[1] === 'stop');
    assert.deepEqual(events[kill], ['in-box-kill', 'TERM', [777]], 'only the restart writer the engine named was signalled');
    assert.ok(kill >= 0 && stop > kill, 'the writer was proven stopped before the rollback stopped the graph');
    assert.deepEqual(events[stop], ['run', 'stop', false]);
    assert.deepEqual(events.filter(event => event[0] === 'core').map(event => event[1]), [['start', 'agent', '8080']],
        'the prior graph was restored');
    assert.ok(events.indexOf('health') > stop);
    assert.equal(events.includes('commit-agentlib'), false, 'a cancelled restart is never admitted');
    assert.equal(fixture.store.read('update-recovery', fixture.identity.instance), null, 'the engine proved the writer stopped');
    assert.deepEqual(processRef.kills, [], 'the restart failure reports the signal; it is not raised again');
    assert.deepEqual(listeners(processRef), [0, 0]);
});

test('a restart writer the engine cannot prove stopped leaves a restart barrier, is never rolled back, and blocks the next restart', async (t) => {
    const processRef = signalProcess();
    const writer = inBoxWriter(processRef.events, { stopsOn: [] });
    const behavior = { script: 'setInterval(() => {}, 1000)', termGraceMs: 50, killGraceMs: 50 };
    behavior.afterStart = emitSigintAfterStart(processRef, []);
    const barrierProbes = [];
    const fixture = scenario(t, {
        processRef,
        writer,
        runRestartCore: realRestartCore(processRef, writer, behavior),
        runCoreCommand: coreCommand(processRef, { onRestart: async () => { behavior.afterStart(); await new Promise(r => setTimeout(r, 100)); } }),
        probeUpdateQuiescence: ({ marker }) => { barrierProbes.push(marker); return writer.probe(); },
    });
    const failure = await settled(fixture.supervisor.runRestartTransaction(['restart']));
    const barrier = fixture.store.read('update-recovery', fixture.identity.instance);
    assert.equal(barrier?.operation, 'restart', 'a durable barrier names the unproven restart writer');
    assert.equal(failure?.code, 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN');
    assert.match(failure.message, /graph restart ended abnormally \(signal:SIGINT\)[\s\S]*A recovery record now blocks new mutations/);
    assert.equal(barrier.cause, 'signal:SIGINT');
    const [restart] = fixture.events.filter(event => event[0] === 'restart-core');
    assert.equal(barrier.marker, `PLOINKY_UPDATE_OPERATION=${restart[2]}`, 'the barrier names exactly this restart');
    assert.deepEqual(fixture.events.filter(event => event[0] === 'in-box-kill').map(event => event[1]), ['TERM', 'KILL']);
    assert.equal(indexOf(fixture.events, event => event[0] === 'run'), -1, 'a Box whose restart writer may run is not stopped');
    assert.equal(fixture.events.includes('outer-rollback'), false);
    assert.equal(fixture.events.some(event => event[0] === 'core'), false, 'nothing restores a graph over a live writer');
    assert.deepEqual(processRef.kills, []);
    assert.deepEqual(listeners(processRef), [0, 0]);

    // The next restart is refused before any Box mutation while the writer runs.
    await assert.rejects(fixture.supervisor.runRestartTransaction(['restart']), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_UPDATE_RECOVERY_REQUIRED');
        assert.match(error.message, /^An earlier graph restart in this workspace may still be running inside the Box/);
        return true;
    });
    assert.deepEqual(barrierProbes, [barrier.marker]);
    assert.equal(fixture.events.filter(event => event === 'reconcile').length, 1);

    // Once the engine proves it stopped, the barrier is cleared and the restart runs.
    writer.alive = false;
    behavior.script = 'process.exit(0)';
    behavior.afterStart = null;
    await fixture.supervisor.runRestartTransaction(['restart']);
    assert.equal(fixture.store.read('update-recovery', fixture.identity.instance), null);
    assert.ok(fixture.events.includes('commit-agentlib'));
    assert.deepEqual(listeners(processRef), [0, 0]);
});

test('a lost engine connection during a workspace restart stops its writer before the rollback touches the graph', async (t) => {
    const processRef = signalProcess();
    const writer = inBoxWriter(processRef.events);
    const fixture = scenario(t, {
        processRef,
        writer,
        // The engine client ends with 125 while the in-Box restart keeps running.
        runRestartCore: realRestartCore(processRef, writer, { script: 'process.exit(125)' }),
        runCoreCommand: coreCommand(processRef, {
            onRestart: () => { throw new Error('In-box restart failed with status 125'); },
        }),
    });
    const failure = await settled(fixture.supervisor.runRestartTransaction(['restart']));
    const kill = indexOf(fixture.events, event => event[0] === 'in-box-kill');
    const stop = indexOf(fixture.events, event => event[0] === 'run' && event[1] === 'stop');
    assert.ok(stop >= 0);
    assert.deepEqual(fixture.events[stop], ['run', 'stop', false], 'the rollback stop never ran beside the live restart writer');
    assert.ok(kill >= 0 && kill < stop);
    assert.equal(failure?.code, 'PLOINKY_BOX_UPDATE_RESTART_FAILED');
    assert.match(failure.message, /status 125/);
    assert.deepEqual(processRef.kills, []);
    assert.deepEqual(listeners(processRef), [0, 0]);
});

test('an uninterrupted workspace restart keeps its argv, carries its marker and needs no engine proof', async (t) => {
    const processRef = signalProcess();
    const writer = inBoxWriter(processRef.events);
    const fixture = scenario(t, {
        processRef,
        writer,
        runRestartCore: realRestartCore(processRef, writer, { script: 'process.exit(0)' }),
        runCoreCommand: coreCommand(processRef),
    });
    await fixture.supervisor.runRestartTransaction(['restart', '--debug']);
    const restarts = fixture.events.filter(event => event[0] === 'restart-core');
    assert.equal(restarts.length, 1);
    assert.deepEqual(restarts[0][1], ['restart', '--debug']);
    assert.match(restarts[0][2], /^[0-9a-f]{32}$/);
    assert.deepEqual(writer.probes, [], 'a normal exit is its own proof');
    assert.ok(fixture.events.includes('commit-agentlib'));
    assert.equal(fixture.events.some(event => event[0] === 'core'), false);
    assert.deepEqual(processRef.kills, []);
    assert.deepEqual(listeners(processRef), [0, 0]);
});
