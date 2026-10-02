// Native (Seatbelt and bwrap) graph replacement and predecessor ownership.
//
// Every scenario runs in nativeGraphPredecessorDriver.mjs, a child process
// bound to its own temporary workspace, so PID records, receipts and the edge
// files never touch the repository. The driver only ever signals children it
// spawned itself. Stub `podman`/`docker` executables record any container
// engine call.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { tempRoot } from './dependencyStoreFixtures.mjs';
import {
    CONTAINER,
    driveWiring,
    registration,
    stepValue,
    wiringWorkspace,
} from './dependencyStoreWiringHarness.mjs';

const DRIVER = path.resolve(import.meta.dirname, 'nativeGraphPredecessorDriver.mjs');
const RUNTIMES = ['seatbelt', 'bwrap'];

function workspace(t) {
    const root = tempRoot(t, 'native-graph-');
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.ploinky'), { recursive: true });
    // The router port an initial workspace start persisted.
    fs.writeFileSync(path.join(ws, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080, routes: {} }));
    const bin = path.join(root, 'engine-bin');
    fs.mkdirSync(bin);
    const log = path.join(root, 'engine-calls.log');
    for (const name of ['podman', 'docker']) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $@" >> "${log}"\nexit 1\n`, { mode: 0o755 });
    }
    return { root, ws, bin, log };
}

// A PATH that holds only `node` and `ps`: no container engine can be found.
function engineLessPath(w) {
    const dir = path.join(w.root, 'no-engine-bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(dir, 'node'));
    // The native sandbox launcher stays reachable; only container engines are absent.
    for (const tool of ['ps', 'sandbox-exec', 'bwrap']) {
        const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
        if (found) fs.symlinkSync(fs.realpathSync(found), path.join(dir, tool));
    }
    return dir;
}

function drive(w, scenario, argument = {}, { timeout = 60_000, noEngine = false } = {}) {
    const run = spawnSync(process.execPath, [DRIVER, scenario, JSON.stringify(argument)], {
        cwd: w.ws,
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: w.ws,
            PLOINKY_CWD: w.ws,
            HOME: path.join(w.root, 'home'),
            PATH: noEngine ? engineLessPath(w) : [w.bin, process.env.PATH].join(path.delimiter),
            NATIVE_ENGINE_LOG: w.log,
        },
        encoding: 'utf8',
        timeout,
    });
    assert.equal(run.status, 0, `${scenario}: ${run.stdout}\n${run.stderr}`);
    return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

for (const runtime of RUNTIMES) {
    test(`production restaging of a stopped ${runtime} record reaches the native removal dispatch without a container engine`, (t) => {
        const w = workspace(t);
        const result = drive(w, 'restage', { runtime });
        assert.equal(result.ok, true, `restaging must not fail: ${result.code} ${result.message}`);
        assert.equal(result.changed.length, 1, 'the stopped runtime is the one changed container');
        assert.ok(result.events.includes('registry-saved'), 'the rotated registry was published');
        assert.notEqual(result.registryTuple.instanceId, 'old-instance', 'the successor tuple is fresh');
        assert.equal(result.receiptsLeft, 0, 'the predecessor proof is retired once the predecessor is absent');
        assert.deepEqual(result.engineCalls, [], 'a native predecessor never reaches a container engine');
        assert.deepEqual(result.signals, [], 'a stopped runtime has nothing to signal');
        assert.equal(result.bystanderAlive, true);
        assert.equal(result.bystanderRecord, true);
    });
}

test('a stop whose signals are all denied neither clears the PID record nor reports the process stopped', (t) => {
    const w = workspace(t);
    const result = drive(w, 'legacy-denied-signals');
    assert.equal(result.stopped, false, 'a process that still runs is not stopped');
    assert.equal(result.recordKept, true, 'the PID record stays as ownership evidence');
    assert.equal(result.alive, true);
    assert.ok(result.signals.length > 0, 'the stop did try to signal');
});

test('an identity-probe failure never deletes a PID record or signals the process', (t) => {
    const w = workspace(t);
    const result = drive(w, 'legacy-identity-failure');
    assert.equal(result.running, false, 'an unverified process is not reported as exactly running');
    assert.equal(result.stopped, false);
    assert.equal(result.recordKept, true, 'unknown is not absence: the record is untouched');
    assert.deepEqual(result.signals, [], 'nothing is signalled without a verified owner');
    assert.equal(result.alive, true);
});

for (const runtime of RUNTIMES) {
    test(`native additional startup liveness follows the exact runtime key and tuple (${runtime}, aliases and repositories sharing a short name)`, (t) => {
        const w = workspace(t);
        const result = drive(w, 'extra-startup', { runtime });
        assert.deepEqual(result.errors, {});
        assert.equal(result.running.repoA, true, 'repository A runs under its own key');
        assert.equal(result.running.repoB, false, 'repository B shares the short name but owns no process');
        assert.equal(result.running.alias, true, 'the alias runs under its own key');
        assert.equal(result.staleTuple, false, 'a replaced tuple is not the running runtime');
        assert.deepEqual(result.active, [result.keys.alias, result.keys.repoA].sort());
        assert.deepEqual(result.inactive, [result.keys.repoB]);
    });
}

// ------------------------------------------------------------------
// Forced recreate and an unexpected occupant, through the production
// managers (the bwrap manager runs under the Bubblewrap host shim and a fake
// bwrap; Seatbelt runs the dispatcher with a fake sandbox-exec on macOS).

const HERE = import.meta.dirname;
const SHIM = path.join(HERE, 'dependencyStoreBwrapHostShim.mjs');
const BWRAP_MANIFEST = { 'lite-sandbox': true, start: 'node index.js', network: { mode: 'host' }, readiness: { protocol: 'none' } };
const OCCUPANT = { instanceId: 'occupant-instance', enableGeneration: 'occupant-generation' };

// A fake bwrap that stays alive like a sandbox. Launches are recorded by the
// spawning process itself (FAKE_BWRAP_SPAWN_LOG, written by the child_process
// shim at spawn time), never by the fake's own startup, so neither a positive
// nor a "no launch" assertion can race the fake's first line.
function fakeBwrap(root) {
    const file = path.join(root, 'fake-bwrap');
    const log = path.join(root, 'fake-bwrap-launches.jsonl');
    fs.writeFileSync(file, `#!${process.execPath}\nsetTimeout(() => {}, 25000);\n`, { mode: 0o755 });
    const pids = new Set();
    return {
        file,
        log,
        pids,
        launches() {
            const entries = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
            for (const entry of entries) pids.add(entry.pid);
            return entries;
        },
    };
}

function killQuietly(pid) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

function alive(pid) {
    try { process.kill(pid, 0); } catch (error) { return error?.code === 'EPERM'; }
    const state = String(spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout || '').trim();
    return Boolean(state) && !state.startsWith('Z');
}

// A process this test spawned, bound to `key` under `tuple` by the production
// PID-record writer, run in a child process against the workspace.
function occupy(w, key, tuple) {
    const child = spawnSync(process.execPath, ['-e', 'const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 25000)"], { detached: true, stdio: "ignore" }); c.unref(); process.stdout.write(String(c.pid))'], { encoding: 'utf8' });
    const pid = Number(child.stdout);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const save = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        const fleet = await import(${JSON.stringify(new URL('../../cli/sandbox/bwrap/bwrapFleet.js', import.meta.url).href)});
        fleet.saveBwrapPid(${JSON.stringify(key)}, ${pid}, ${JSON.stringify(tuple)});
    `], { cwd: w.ws, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: w.ws }, encoding: 'utf8' });
    assert.equal(save.status, 0, save.stderr);
    return pid;
}

function pidRecordOf(w, key) {
    try {
        return JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'bwrap-pids', `${key}.pid`), 'utf8'));
    } catch {
        return null;
    }
}

function bwrapOccupantFixture(t) {
    const w = wiringWorkspace(t, { manifest: BWRAP_MANIFEST, prefix: 'native-bwrap-' });
    const bwrap = fakeBwrap(w.root);
    t.after(() => {
        bwrap.launches();
        for (const pid of bwrap.pids) killQuietly(pid);
    });
    const drive = (steps) => {
        try {
            return driveWiring(w, steps, { nodeArgs: ['--import', SHIM], env: { FAKE_BWRAP: bwrap.file, FAKE_BWRAP_SPAWN_LOG: bwrap.log } });
        } finally {
            bwrap.launches();
        }
    };
    const occupant = occupy(w, CONTAINER, OCCUPANT);
    t.after(() => killQuietly(occupant));
    const record = {
        ...registration({ instanceId: 'successor-instance', enableGeneration: 'successor-generation' }),
        runtime: 'bwrap',
        projectPath: path.join(w.ws, '.data', 'demo'),
    };
    const setup = [
        { action: 'init-edge' },
        { action: 'register', containerName: CONTAINER, record },
    ];
    return { w, bwrap, drive, occupant, setup };
}

test('a forced bwrap recreate is refused while an unexpected occupant holds the slot', (t) => {
    const { w, bwrap, drive, occupant, setup } = bwrapOccupantFixture(t);
    const refused = drive([
        ...setup,
        { label: 'forced', action: 'bwrap-ensure', containerName: CONTAINER, options: { forceRecreate: true }, allowFailure: true },
    ]);
    assert.equal(refused.forced.ok, false, 'a forced recreate is refused while an unexpected occupant holds the slot');
    assert.equal(refused.forced.code, 'PLOINKY_SANDBOX_PID_SLOT_BUSY');
    assert.equal(alive(occupant), true, 'the unexpected occupant was not signalled');
    assert.equal(pidRecordOf(w, CONTAINER)?.instanceId, OCCUPANT.instanceId, 'its PID record is untouched');
    assert.equal(bwrap.launches().length, 0, 'no successor was launched');
});

test('a bwrap recreate stops exactly the predecessor the caller named', (t) => {
    const { w, bwrap, drive, occupant, setup } = bwrapOccupantFixture(t);
    const replaced = drive([
        ...setup,
        { label: 'expected', action: 'bwrap-ensure', containerName: CONTAINER, options: { forceRecreate: true, expectedPredecessor: OCCUPANT } },
    ]);
    const started = stepValue(replaced, 'expected');
    assert.equal(alive(occupant), false, 'the named predecessor exited');
    assert.equal(bwrap.launches().length, 1, 'exactly one successor was launched');
    assert.equal(started.pid, bwrap.launches()[0].pid);
    assert.equal(pidRecordOf(w, CONTAINER)?.instanceId, 'successor-instance', 'the slot now carries the admitted successor');
});

const SEATBELT_SKIP = process.platform !== 'darwin' && 'seatbelt runs on macOS only';
const SEATBELT_MANIFEST = { 'lite-sandbox': true, start: 'node index.js', network: { mode: 'host' }, readiness: { protocol: 'none' } };

function seatbeltStart(w, record, label, options = {}) {
    return [
        { action: 'register', containerName: CONTAINER, record: { ...registration(record), runtime: 'seatbelt', projectPath: path.join(w.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label, action: 'ensure-with-lease', hostRouter: true, containerName: CONTAINER, startPath: true, activate: true, routeKey: 'demo', ...options },
    ];
}

function seatbeltOccupantFixture(t) {
    const w = wiringWorkspace(t, { manifest: SEATBELT_MANIFEST, prefix: 'native-seatbelt-' });
    const pids = new Set();
    t.after(() => { for (const pid of pids) killQuietly(pid); });
    const first = stepValue(driveWiring(w, [
        { action: 'init-edge' },
        { action: 'enable-sandbox' },
        ...seatbeltStart(w, {}, 'first'),
    ]), 'first');
    pids.add(first.pid);
    assert.equal(first.runtime, 'seatbelt');
    assert.equal(alive(first.pid), true);
    return { w, pids, first };
}

const SEATBELT_SUCCESSOR = { instanceId: 'inst-2', enableGeneration: 'gen-2' };

test('a forced seatbelt recreate is refused while an unexpected occupant holds the slot', { skip: SEATBELT_SKIP }, (t) => {
    const { w, first } = seatbeltOccupantFixture(t);
    const refused = driveWiring(w, seatbeltStart(w, SEATBELT_SUCCESSOR, 'forced', {
        allowFailure: true,
        options: { forceRecreate: true },
    }));
    assert.equal(refused.forced.ok, false, 'a forced recreate is refused while an unexpected occupant holds the slot');
    assert.equal(refused.forced.causeCode, 'PLOINKY_SANDBOX_PID_SLOT_BUSY');
    assert.equal(alive(first.pid), true, 'the unexpected occupant was not signalled');
    assert.equal(pidRecordOf(w, CONTAINER)?.instanceId, 'inst-1', 'its PID record is untouched');
});

test('a seatbelt recreate stops exactly the predecessor the caller named', { skip: SEATBELT_SKIP }, (t) => {
    const { w, pids, first } = seatbeltOccupantFixture(t);
    const replaced = stepValue(driveWiring(w, seatbeltStart(w, SEATBELT_SUCCESSOR, 'expected', {
        options: { forceRecreate: true, expectedPredecessor: { instanceId: 'inst-1', enableGeneration: 'gen-1' } },
    })), 'expected');
    pids.add(replaced.pid);
    assert.notEqual(replaced.pid, first.pid);
    assert.equal(alive(first.pid), false, 'the named predecessor exited');
    assert.equal(alive(replaced.pid), true);
    assert.equal(pidRecordOf(w, CONTAINER)?.instanceId, 'inst-2', 'the slot now carries the admitted successor');
});

// ------------------------------------------------------------------
// The structured observation (absent, live-exact, live-foreign, unknown) and
// the termination postconditions, with real child processes.

test('observeSandboxRuntime distinguishes verified absence, exact and foreign owners, and unknown, and never deletes', (t) => {
    const w = workspace(t);
    const out = drive(w, 'observe-matrix');
    assert.deepEqual(out.noDirectory, { state: 'absent', reason: 'pid-directory-missing', hasRecord: false });
    assert.deepEqual(out.noRecord, { state: 'absent', reason: 'no-record', hasRecord: false });
    assert.deepEqual(out.liveExact, { state: 'live-exact', reason: 'live', hasRecord: true });
    assert.deepEqual(out.liveForeign, { state: 'live-foreign', reason: 'foreign-tuple', hasRecord: true });
    assert.equal(out.liveUntyped.state, 'live-exact', 'without an expected tuple any exact live owner is reported');
    assert.deepEqual(out.pidReuse, { state: 'absent', reason: 'stale-record-pid-reused', hasRecord: true });
    assert.equal(out.pidReuseRecordKept, true, 'observing never deletes, even a stale record');
    assert.equal(out.zombieState, 'Z', 'the fixture produced an unreaped zombie');
    assert.equal(out.zombieStillSignalable, true, 'kill(pid, 0) alone cannot tell a zombie from a live process');
    assert.deepEqual(out.zombie, { state: 'absent', reason: 'stale-record-zombie', hasRecord: true });
    assert.equal(out.zombieRecordKept, true);
    assert.deepEqual(out.exitedPid, { state: 'absent', reason: 'stale-record', hasRecord: true });
    for (const name of ['invalidRecord', 'legacyRecord']) {
        assert.deepEqual(out[name], { state: 'unknown', reason: 'invalid-record', hasRecord: false }, name);
    }
    for (const name of ['symlinkRecord', 'directoryRecord']) {
        assert.deepEqual(out[name], { state: 'unknown', reason: 'record-unreadable', hasRecord: false }, name);
    }
    assert.deepEqual(out.probeFailure, { state: 'unknown', reason: 'identity-probe-failed', hasRecord: true });
    assert.equal(out.epermStillExact.state, 'live-exact', 'EPERM on the signal probe still proves the process exists');
    assert.deepEqual(out.signalProbeError, { state: 'unknown', reason: 'signal-probe-EIO', hasRecord: true });
    for (const key of out.keys) {
        assert.ok(out.filesAfter.includes(`${key}.pid`), `${key}: no observation deleted its record`);
    }
});

test('stopExactSandboxProcess signals only a live-exact owner and claims a stop only once the process is observed gone', (t) => {
    const w = workspace(t);
    const out = drive(w, 'stop-matrix');

    assert.deepEqual(out.stop, { state: 'stopped', reason: 'exited' });
    assert.equal(out.stopRecordGone, true, 'the record goes only after the exit was observed');
    assert.equal(out.stopZombieSignalable, true, 'the stopped child is an unreaped zombie, so zombie detection is what proves the exit');
    assert.equal(out.stopAlive, false);

    assert.equal(out.denied.state, 'failed');
    assert.match(out.denied.reason, /^signal-denied-EPERM$/);
    assert.deepEqual(out.deniedSignals, ['SIGTERM:group', 'SIGTERM:leader'], 'denied: the group, then the leader, is tried once');
    assert.equal(out.deniedRecordKept, true, 'denied signals keep the PID record');
    assert.equal(out.deniedAlive, true);

    assert.deepEqual(out.survivor, { state: 'failed', reason: 'still-alive-after-kill' });
    assert.deepEqual(out.survivorSignals, ['SIGTERM', 'SIGKILL'], 'TERM, then KILL after the timeout');
    assert.equal(out.survivorRecordKept, true);
    assert.equal(out.survivorAlive, true);

    assert.deepEqual(out.unavailable, { state: 'failed', reason: 'observation-unknown:identity-probe-failed' });
    assert.equal(out.unavailableSignals, 0, 'an owner that cannot be verified is never signalled');
    assert.equal(out.unavailableRecordKept, true);
    assert.equal(out.unavailableAlive, true);

    assert.deepEqual(out.foreign, { state: 'refused', reason: 'foreign-tuple' });
    assert.equal(out.foreignSignals, 0);
    assert.equal(out.foreignRecordKept, true);
    assert.equal(out.foreignAlive, true);

    assert.deepEqual(out.leader, { state: 'stopped', reason: 'exited' });
    assert.deepEqual(out.leaderSignals, ['SIGTERM:group', 'SIGTERM:leader'], 'an ESRCH from the group falls back to the leader');
    assert.equal(out.leaderAlive, false);

    assert.equal(out.reused.state, 'absent', 'a reused PID is a stale record');
    assert.equal(out.reusedSignals, 0, 'the unrelated process holding the reused PID is never signalled');
    assert.equal(out.reusedStaleRecordRemoved, true, 'the stale record goes by compare-and-delete');
    assert.equal(out.reusedAlive, true);

    assert.deepEqual(out.replaced, { state: 'failed', reason: 'owner-changed' });
    assert.equal(out.replacedSignals, 0, 'a record replaced after observation is re-checked before the first signal');
    assert.equal(out.replacedRecordInstance, 'replaced-instance', 'the newer record is untouched');
    assert.equal(out.replacedAlive, true);

    assert.deepEqual(out.batchStopped, out.keys.slice(0, 2), 'a batch reports exactly the keys it stopped');
    assert.deepEqual(out.batchAlive, { a: false, b: false, c: true });
    assert.equal(out.batchForeignRecordKept, true);
});

// ------------------------------------------------------------------
// Graph replacement: unchanged reuse, changed replacement, refused stops.

for (const runtime of RUNTIMES) {
    test(`a healthy unchanged ${runtime} runtime is reused: same tuple, same process, no stop and no receipt`, (t) => {
        const result = drive(workspace(t), 'unchanged', { runtime });
        assert.equal(result.ok, true, result.message);
        assert.deepEqual(result.changed, [], 'nothing is replaced');
        assert.equal(result.registryTuple.instanceId, 'old-instance', 'the tuple is not rotated');
        assert.equal(result.receiptWrites, 0, 'no predecessor proof is written for a runtime that stays');
        assert.equal(result.receiptsLeft, 0);
        assert.deepEqual(result.removals, [], 'no removal is dispatched');
        assert.deepEqual(result.signals, [], 'nothing is signalled');
        assert.equal(result.alive, true);
        assert.equal(result.pidRecordIntact, true);
    });

    test(`a changed ${runtime} runtime is replaced: only the captured predecessor exits and the successor tuple is fresh`, (t) => {
        const result = drive(workspace(t), 'restage', { runtime, live: true });
        assert.equal(result.ok, true, `${result.code} ${result.message}`);
        assert.equal(result.changed.length, 1);
        assert.ok(result.events.some((entry) => /^remove:workspaceGraph:demo\/background:envHashChanged$/.test(entry)));
        assert.equal(result.predecessorAlive, false, 'the predecessor exited');
        assert.equal(result.predecessorRecord, null, 'its PID record went with it, after the exit was observed');
        assert.deepEqual(result.signals.map((entry) => entry.signal), ['SIGTERM'], 'one TERM, to the captured predecessor');
        assert.notEqual(result.registryTuple.instanceId, 'old-instance');
        assert.notEqual(result.registryTuple.enableGeneration, 'old-enable');
        assert.equal(result.receiptsLeft, 0, 'the predecessor proof is retired after the removal');
        assert.equal(result.bystanderAlive, true, 'an unrelated runtime is untouched');
        assert.equal(result.bystanderRecord, true);
        assert.deepEqual(result.engineCalls, []);
    });

    test(`${runtime}: denied TERM and KILL keep the old proof, launch nothing, and leave routing inactive until a clean start recovers`, (t) => {
        const result = drive(workspace(t), 'graph-denied', { runtime });
        const first = result.first;
        assert.equal(first.ok, false);
        assert.equal(first.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
        assert.equal(first.alive, true, 'the predecessor still runs');
        assert.equal(first.pidRecordIntact, true, 'its PID record is untouched');
        assert.deepEqual([...new Set(first.signals)], ['SIGTERM'], 'a denied TERM is not escalated into a claim of success');
        assert.equal(first.receipts.length, 1, 'the predecessor proof is retained');
        assert.equal(first.receipts[0].runtime, runtime);
        assert.deepEqual(first.receipts[0].predecessor, { instanceId: 'old-instance', enableGeneration: 'old-enable' });
        assert.ok(first.receipts[0].process?.pid > 0 && first.receipts[0].process.processIdentity, 'the captured process evidence is in the receipt');
        assert.equal(first.events.at(-1), 'inactive', 'the failed removal leaves the selected generation inactive');
        assert.ok(!first.events.includes('activate'), 'no route was activated');
        assert.deepEqual(result.second.labels.length, 1, 'recovery removes the predecessor named by the retained receipt');
        assert.equal(result.second.ok, true, result.second.message);
        assert.equal(result.second.alive, false);
        assert.equal(result.second.pidRecordGone, true);
        assert.equal(result.second.receiptsLeft, 0, 'the proof is retired once the predecessor is observed gone');
        assert.deepEqual(result.second.signals, ['SIGTERM']);
    });

    test(`${runtime}: an owner that cannot be verified refuses the graph before anything is inactivated, rotated or signalled`, (t) => {
        const result = drive(workspace(t), 'graph-unknown', { runtime });
        for (const mode of ['liveness', 'capture']) {
            assert.equal(result[mode].ok, false, mode);
            assert.equal(result[mode].code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS', mode);
            assert.deepEqual(result[mode].events, [], `${mode}: refused during validation, before routing was revoked`);
        }
        assert.equal(result.receiptsLeft, 0);
        assert.deepEqual(result.signals, []);
        assert.equal(result.alive, true);
        assert.equal(result.pidRecordIntact, true);
    });

    test(`${runtime}: the removal dispatch signals only the exact predecessor for every state of its slot`, (t) => {
        const out = drive(workspace(t), 'removal-slots', { runtime });
        assert.equal(out.reused.ok, true, 'a reused PID is a stale record');
        assert.equal(out.reused.value.state, 'absent');
        assert.equal(out.reused.alive, true, 'the process that holds the reused PID is not the predecessor');
        assert.equal(out.reused.staleRecordRemoved, true);

        assert.equal(out.successor.ok, true, 'a newer successor in the slot proves the predecessor absent');
        assert.equal(out.successor.value.state, 'absent');
        assert.equal(out.successor.alive, true, 'the successor is never signalled');
        assert.equal(out.successor.recordIntact, true, 'its PID record is never deleted');

        assert.equal(out.mismatch.ok, false, 'a record that does not match the captured process refuses removal');
        assert.equal(out.mismatch.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
        assert.equal(out.mismatch.alive, true);
        assert.equal(out.mismatch.recordIntact, true);
        assert.equal(out.mismatchReceiptKept, true, 'the proof stays until ownership is resolved');

        assert.equal(out.exact.ok, true);
        assert.equal(out.exact.value.state, 'removed');
        assert.equal(out.exact.alive, false);
        assert.equal(out.exact.recordGone, true);

        assert.equal(out.absent.ok, true);
        assert.equal(out.absent.value.state, 'absent');
        assert.deepEqual(out.signals, [{ pid: out.pids.exact, signal: 'SIGTERM' }].map((entry) => ({ pid: -entry.pid, signal: entry.signal })), 'the only signal went to the exact predecessor');
        assert.equal(out.receiptsLeft, 1, 'only the unresolved proof remains');
    });
}

// ------------------------------------------------------------------
// Backend switches, crashes at every transition, mixed graphs, and the
// replacement reason's choice of probe.

for (const runtime of RUNTIMES) {
    for (const live of [true, false]) {
        test(`native to container (${runtime}, ${live ? 'live' : 'stopped'} predecessor): the predecessor's backend removes it and no container engine is reached`, (t) => {
            const out = drive(workspace(t), 'backend-switch', { runtime, from: 'native', live });
            assert.equal(out.ok, true, `${out.code} ${out.message}`);
            assert.deepEqual(out.labels, ['workspaceGraph:demo/background:runtimeBackendChanged']);
            assert.deepEqual(out.containerCalls, []);
            assert.deepEqual(out.engineCalls, []);
            assert.notEqual(out.registryTuple.instanceId, 'old-instance', 'the successor tuple is fresh');
            assert.equal(out.receiptsLeft, 0);
            assert.equal(out.predecessorRecordGone, true);
            if (live) {
                assert.equal(out.predecessorAlive, false, 'a live native predecessor is stopped by its own backend');
                assert.deepEqual(out.signals, ['SIGTERM']);
            } else {
                assert.deepEqual(out.signals, [], 'a stopped predecessor needs no signal');
            }
            assert.equal(out.bystanderAlive, true);
        });

        test(`container to native (${runtime}, ${live ? 'live' : 'stopped'} predecessor): the container backend removes it and no native process is touched`, (t) => {
            const out = drive(workspace(t), 'backend-switch', { runtime, from: 'container', live });
            assert.equal(out.ok, true, `${out.code} ${out.message}`);
            assert.deepEqual(out.labels, ['workspaceGraph:demo/background:runtimeBackendChanged']);
            assert.deepEqual(out.containerCalls, live ? [{ name: 'ploinky_demo_background_ws_deadbeef', containerId: 'a'.repeat(64) }] : []);
            assert.deepEqual(out.signals, [], 'no native signal for a container predecessor');
            assert.equal(out.receiptsLeft, 0, 'the container proof is retired after the exact removal');
            assert.notEqual(out.registryTuple.instanceId, 'old-instance');
            assert.equal(out.bystanderAlive, true);
        });
    }
}

for (const runtime of RUNTIMES) {
    for (const stage of ['receipt', 'registry', 'removal', 'terminated']) {
        for (const to of ['native', 'container']) {
            test(`${runtime}: a crash after "${stage}" while switching to ${to === 'native' ? 'a fresh native runtime' : 'a container'} recovers by exact ownership operations`, (t) => {
                const out = drive(workspace(t), 'crash', { runtime, stage, live: true, to });
                assert.equal(out.afterCrash.code, 'SIMULATED_CRASH');
                const rotated = stage !== 'receipt';
                assert.equal(Boolean(out.afterCrash.persistedTuple), rotated, 'the rotated registry exists only from the registry write on');
                assert.equal(out.afterCrash.alive, stage !== 'terminated', 'the predecessor has been terminated only by then');
                assert.equal(out.afterCrash.receipts, 1, 'the proof is durable at every crash point');
                assert.equal(out.recovery.ok, true, out.recovery.message);
                assert.equal(out.recovery.alive, false, 'the predecessor is gone after recovery');
                assert.equal(out.recovery.pidRecordGone, true);
                assert.equal(out.recovery.bystanderAlive, true, 'recovery never touches another runtime');
                assert.deepEqual(out.recovery.engineCalls, [], 'no container engine call at any point');
                assert.equal(out.recovery.receiptsLeft, stage === 'receipt' ? 1 : 0,
                    'recovery retires the proof (a receipt keyed by a tuple that was never persisted stays inert)');
                assert.equal(out.recovery.labels.length, 1);
                if (stage === 'terminated') {
                    assert.deepEqual(out.recovery.signals, [], 'an already-terminated predecessor is not signalled again');
                } else {
                    assert.deepEqual(out.recovery.signals, ['SIGTERM'], 'recovery terminates the predecessor exactly once');
                }
            });
        }
    }
}

for (const runtime of RUNTIMES) {
    for (const containerChanged of [false, true]) {
        test(`mixed graph (${runtime}${containerChanged ? ', changed container' : ', healthy container'}): each predecessor is removed by its own backend`, (t) => {
            const out = drive(workspace(t), 'mixed', { runtime, containerChanged });
            assert.equal(out.ok, true, out.message);
            assert.equal(out.nativeAlive, false);
            assert.deepEqual(out.signals, ['SIGTERM'], 'only the native predecessor was signalled');
            assert.notEqual(out.nativeTuple.instanceId, 'old-instance');
            assert.deepEqual(out.engineCalls, []);
            if (containerChanged) {
                assert.deepEqual(out.containerCalls, [{ name: out.keys.container, containerId: 'a'.repeat(64) }]);
                assert.equal(out.labels.length, 2);
                assert.notEqual(out.containerTuple.instanceId, 'old-instance');
                assert.deepEqual(out.receiptRuntimes, []);
            } else {
                assert.deepEqual(out.containerCalls, [], 'a healthy container is left alone');
                assert.deepEqual(out.labels, ['workspaceGraph:demo/background:envHashChanged']);
                assert.equal(out.containerTuple.instanceId, 'old-instance');
            }
        });
    }

    test(`${runtime}: the replacement reason probes the backend its existing record names`, (t) => {
        const out = drive(workspace(t), 'reasons', { runtime });
        const label = (name) => out[name].labels[0];
        for (const name of Object.keys(out)) assert.equal(out[name].ok, true, `${name}: ${out[name].message}`);
        for (const name of ['nativeToOtherNative', 'nativeToContainer', 'containerToNative']) {
            assert.equal(label(name), 'workspaceGraph:demo/background:runtimeBackendChanged', `${name}: decided before any probe`);
        }
        assert.equal(label('nativeStopped'), 'workspaceGraph:demo/background:sandboxRuntimeStopped');
        assert.equal(label('unlaunchedToNative'), 'workspaceGraph:demo/background:sandboxRuntimeStopped',
            'a record that names no runtime never selects a backend for removal: its native observation is read-only');
        assert.equal(label('containerMissing'), 'workspaceGraph:demo/background:registeredRuntimeMissing');
    });
}

// ------------------------------------------------------------------
// Candidate cleanup after a failed readiness: the exact candidate is removed,
// a different tuple in the slot is never touched, and an unverifiable slot is
// ambiguity rather than absence.

for (const scenario of [
    { name: 'the exact candidate is stopped and its record removed', tamper: null },
    { name: 'a different tuple in the slot proves the candidate absent and is left untouched', tamper: 'foreign' },
    { name: 'an unverifiable slot is ambiguity, never absence', tamper: 'invalid' },
]) {
    test(`seatbelt candidate cleanup: ${scenario.name}`, { skip: SEATBELT_SKIP }, (t) => {
        const w = wiringWorkspace(t, { manifest: SEATBELT_MANIFEST, prefix: 'native-cleanup-' });
        const pids = new Set();
        t.after(() => { for (const pid of pids) killQuietly(pid); });
        const started = stepValue(driveWiring(w, [
            { action: 'init-edge' },
            { action: 'enable-sandbox' },
            ...seatbeltStart(w, {}, 'candidate', { activate: false, cleanupCandidate: { tamper: scenario.tamper } }),
        ]), 'candidate');
        pids.add(started.pid);
        const pidFileBytes = fs.existsSync(path.join(w.ws, '.ploinky', 'bwrap-pids', `${CONTAINER}.pid`))
            ? fs.readFileSync(path.join(w.ws, '.ploinky', 'bwrap-pids', `${CONTAINER}.pid`), 'utf8')
            : null;
        const cleanup = started.cleanup;
        if (scenario.tamper === null) {
            assert.deepEqual(cleanup, { ok: true, value: { removed: true, state: 'removed' } });
            assert.equal(alive(started.pid), false, 'the exact candidate exited');
            assert.equal(pidFileBytes, null, 'its record was removed after the exit was observed');
        } else if (scenario.tamper === 'foreign') {
            assert.deepEqual(cleanup, { ok: true, value: { removed: false, state: 'absent' } });
            assert.equal(alive(started.pid), true, 'the other tuple\'s process is never signalled');
            assert.equal(JSON.parse(pidFileBytes).instanceId, 'foreign-instance', 'and its record is never deleted');
        } else {
            assert.equal(cleanup.ok, false, 'an unverifiable slot is not "absent"');
            assert.equal(cleanup.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
            assert.equal(alive(started.pid), true);
            assert.equal(pidFileBytes, '{"pid": 1}\n', 'the unverifiable record is preserved for the operator');
        }
    });
}

// ------------------------------------------------------------------
// `ploinky stop` and `destroy`: slot-wide operator stops that obey the same
// postconditions and never report a failed stop as a removal.

for (const runtime of RUNTIMES) {
    test(`${runtime}: stop reports only the runtimes whose exit it observed`, (t) => {
        for (const deny of [false, true]) {
            const out = drive(workspace(t), 'operator-stop', { runtime, deny });
            if (!deny) {
                assert.deepEqual(out.stopped, [out.keys.live]);
                assert.equal(out.liveAlive, false);
                assert.equal(out.liveRecordKept, false, 'the record goes after the exit was observed');
            } else {
                assert.deepEqual(out.stopped, [], 'denied signals are not a stop');
                assert.equal(out.liveAlive, true);
                assert.equal(out.liveRecordKept, true, 'the evidence stays');
            }
            assert.equal(out.unverifiableAlive, true, 'an unverifiable runtime is preserved, never claimed stopped');
            assert.equal(out.unverifiableRecordIntact, true);
        }
    });

    test(`${runtime}: destroy never reports a native runtime removed unless its process is gone`, (t) => {
        const refused = drive(workspace(t), 'operator-stop', { runtime, deny: true, destroy: true });
        assert.deepEqual(refused.removed, [refused.keys.stopped], 'only the runtime that never had a process counts as removed');
        assert.deepEqual(refused.preserved.sort((a, b) => a.name.localeCompare(b.name)), [
            { name: refused.keys.live, touched: true },
            { name: refused.keys.unverifiable, touched: false },
        ].sort((a, b) => a.name.localeCompare(b.name)), 'the live runtime was signalled in vain; the unverifiable one was never touched');
        assert.equal(refused.liveAlive, true);
        assert.equal(refused.liveRecordKept, true);

        const normal = drive(workspace(t), 'operator-stop', { runtime, deny: false, destroy: true });
        assert.deepEqual(normal.removed.sort(), [normal.keys.live, normal.keys.stopped].sort());
        assert.equal(normal.liveAlive, false);
        assert.deepEqual(normal.preserved.map((entry) => entry.name), [normal.keys.unverifiable]);
        assert.equal(normal.unverifiableAlive, true);
    });
}

// ------------------------------------------------------------------
// Static wiring pins (not behaviour): which tuple each caller hands the
// dispatcher as `expectedPredecessor`. The behaviour behind them is covered
// above; these only guard that a caller cannot silently stop passing it.

test('every replacing caller names its expected predecessor from its own source', () => {
    const read = (file) => fs.readFileSync(path.resolve(HERE, '../..', file), 'utf8');
    const cli = read('cli/commands/cli.js');
    const workspace = read('cli/commands/workspaceUtil.js');
    const agents = read('cli/utils/agents.js');
    const monitor = read('cli/server/containerMonitor.js');

    // Graph launches: the predecessor was already removed by the graph step.
    assert.match(workspace, /forceRecreate: newlyPreparedContainers\.has\(name\),\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*expectedPredecessor: null,/);
    // CLI start and shell, and `cli.js` start/restart: the registry tuple read before the call.
    assert.equal((workspace.match(/expectedPredecessor: registeredRuntimeTuple\(registryRecord\?\.record\)/g) || []).length, 2);
    // Reinstall evaluates its own source standalone, so it names the tuple inline.
    assert.match(workspace, /expectedPredecessor: registryRecord\?\.record\?\.instanceId && registryRecord\?\.record\?\.enableGeneration\s*\?\s*\{\s*instanceId: registryRecord\.record\.instanceId,\s*enableGeneration: registryRecord\.record\.enableGeneration,\s*\}\s*:\s*null,/);
    assert.equal((cli.match(/expectedPredecessor: registeredRuntimeTuple\(registryRecord\?\.record\)/g) || []).length, 2);
    // enableAgent: the record captured before the batch rotated the registry.
    assert.match(agents, /expectedPredecessor: registeredRuntimeTuple\(prepared\.previousAgents\?\.\[containerName\]\)/);
    // Watchdog restart: the record captured with the restart attempt.
    assert.match(monitor, /expectedPredecessor: registeredRuntimeTuple\(restartRecord\)/);
});

test('Linux: process identity is the /proc start tick and a zombie is read from /proc state, with ps unusable', { skip: process.platform !== 'linux' && 'procfs is Linux-only' }, (t) => {
    const out = drive(workspace(t), 'procfs');
    assert.match(out.identity, /^linux-proc:\d+$/);
    assert.match(out.stat, /^[RSD]$/, 'a live process');
    assert.equal(out.live, 'live-exact', '/proc alone proves ownership');
    assert.equal(out.zombieSeen, true);
    assert.deepEqual(out.afterKill, { state: 'absent', reason: 'stale-record-zombie' });
});

// ------------------------------------------------------------------
// A record that names no runtime must never select a backend by itself. A
// prepared record carries no runtime until it is finalized, and a native
// candidate can already be live for its exact tuple (a failed first start).

for (const runtime of RUNTIMES) {
    test(`${runtime}: a runtime-less prepared record with a live native candidate is stopped by the next start, and its proof is never retired on a wrong-backend absence`, (t) => {
        const out = drive(workspace(t), 'runtimeless-graph', { runtime, mode: 'changed' });
        assert.equal(out.ok, true, `${out.code} ${out.message}`);
        assert.deepEqual(out.labels, ['workspaceGraph:demo/background:envHashChanged']);
        assert.equal(out.alive, false, 'the exact native candidate was stopped');
        assert.equal(out.pidRecordGone, true);
        assert.deepEqual(out.signals, ['SIGTERM']);
        assert.equal(out.receiptsLeft, 0, 'retired after the exact removal, not before');
        assert.notEqual(out.registryTuple.instanceId, 'old-instance');
        assert.deepEqual(out.engineCalls, [], 'no container engine is consulted for a native owner');
        assert.equal(out.bystanderAlive, true);
        assert.equal(out.slotAfter, 'empty', 'the successor is not left facing an occupied slot');
    });

    test(`${runtime}: a runtime-less candidate whose stop is denied is retained with its receipt, and the next start recovers it instead of staying SLOT_BUSY`, (t) => {
        const out = drive(workspace(t), 'runtimeless-graph', { runtime, mode: 'denied' });
        assert.equal(out.denied.ok, false);
        assert.equal(out.denied.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
        assert.equal(out.denied.alive, true, 'the real process is conservatively retained');
        assert.equal(out.denied.recordKept, true);
        assert.equal(out.denied.receipts.length, 1, 'its ownership receipt is not lost');
        assert.equal(out.denied.receipts[0].runtime, runtime, 'and names the native kind');
        assert.ok(out.denied.receipts[0].process?.pid > 0, 'with the captured process');
        assert.equal(out.recovery.ok, true, out.recovery.message);
        assert.deepEqual(out.recovery.signals, ['SIGTERM']);
        assert.equal(out.alive, false);
        assert.equal(out.receiptsLeft, 0);
        assert.equal(out.slotAfter, 'empty', 'the slot is free for the successor after recovery');
    });

    test(`${runtime}: a runtime-less record with a live native candidate that must become a container is removed natively`, (t) => {
        const out = drive(workspace(t), 'runtimeless-graph', { runtime, mode: 'to-container' });
        assert.equal(out.ok, true, `${out.code} ${out.message}`);
        assert.deepEqual(out.labels, ['workspaceGraph:demo/background:runtimeBackendChanged']);
        assert.equal(out.alive, false);
        assert.deepEqual(out.engineCalls, []);
        assert.equal(out.receiptsLeft, 0);
    });

    test(`${runtime}: a healthy runtime-less native candidate is reused, and a stale one needs no signal`, (t) => {
        const reused = drive(workspace(t), 'runtimeless-graph', { runtime, mode: 'unchanged' });
        assert.equal(reused.ok, true, `${reused.code} ${reused.message}`);
        assert.deepEqual(reused.labels, []);
        assert.equal(reused.alive, true);
        assert.deepEqual(reused.signals, []);
        // (An absent record with a container engine present is a container record
        // by default; its engine must then prove the absence, see the no-engine tests.)
        for (const mode of ['stale']) {
            const out = drive(workspace(t), 'runtimeless-graph', { runtime, mode });
            assert.equal(out.ok, true, `${mode}: ${out.code} ${out.message}`);
            assert.deepEqual(out.signals, [], mode);
            assert.equal(out.receiptsLeft, 0, mode);
            assert.equal(out.bystanderAlive, true);
        }
    });
}

const HOST_NATIVE = process.platform === 'darwin' ? 'seatbelt' : 'bwrap';

for (const mode of ['changed', 'absent', 'denied']) {
    test(`a runtime-less record with no container engine on the machine never ends the process (${mode}): it is handled natively`, (t) => {
        const w = workspace(t);
        // drive() asserts a zero exit status: process.exit(1) from a missing engine would fail here.
        const out = drive(w, 'runtimeless-graph', { runtime: HOST_NATIVE, mode, enableSandbox: true }, { noEngine: true });
        if (mode === 'denied') {
            assert.equal(out.denied.code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
            assert.equal(out.denied.alive, true);
            assert.equal(out.denied.receipts.length, 1, 'the receipt survives the refusal');
            assert.equal(out.recovery.ok, true, out.recovery.message);
            assert.equal(out.alive, false, 'the retained process is recovered by the next start');
            assert.equal(out.slotAfter, 'empty');
            assert.equal(out.receiptsLeft, 0);
            return;
        }
        assert.equal(out.ok, true, `${out.code} ${out.message}`);
        assert.equal(out.receiptsLeft, 0);
        if (mode === 'changed') {
            assert.equal(out.alive, false, 'the live native candidate is stopped exactly');
            assert.deepEqual(out.signals, ['SIGTERM']);
        } else {
            assert.deepEqual(out.signals, []);
        }
    });
}

for (const runtime of RUNTIMES) {
    test(`${runtime}: stop and destroy reach a native candidate whose record names no runtime`, (t) => {
        const stopped = drive(workspace(t), 'operator-stop', { runtime, runtimeless: true, deny: false });
        assert.deepEqual(stopped.stopped, [stopped.keys.live]);
        assert.equal(stopped.liveAlive, false);
        assert.equal(stopped.unverifiableAlive, true, 'an unverifiable owner is preserved');
        assert.equal(stopped.unverifiableRecordIntact, true);

        const refused = drive(workspace(t), 'operator-stop', { runtime, runtimeless: true, deny: true, destroy: true });
        assert.deepEqual(refused.removed, [], 'a denied stop is never a removal');
        assert.equal(refused.liveAlive, true);
        assert.equal(refused.liveRecordKept, true);

        const destroyed = drive(workspace(t), 'operator-stop', { runtime, runtimeless: true, deny: false, destroy: true });
        assert.deepEqual(destroyed.removed, [destroyed.keys.live]);
        assert.equal(destroyed.liveAlive, false);
        assert.deepEqual(destroyed.preserved.map((entry) => entry.name), [destroyed.keys.unverifiable]);
    });
}

test('stop reaches a runtime-less native candidate with no container engine on the machine', (t) => {
    const out = drive(workspace(t), 'operator-stop', { runtime: HOST_NATIVE, runtimeless: true, deny: false }, { noEngine: true });
    assert.deepEqual(out.stopped, [out.keys.live]);
    assert.equal(out.liveAlive, false);
    assert.equal(out.unverifiableAlive, true);
});

test('the Seatbelt shared-link guard counts every consumer as live unless its absence is verified', (t) => {
    const out = drive(workspace(t), 'seatbelt-consumers');
    assert.deepEqual(out.consumers, [out.keys.exact, out.keys.foreign, out.keys.unverifiable].sort(),
        'exact, a live process under another tuple, and an unverifiable one are live; absent and stale are not');
});

// ------------------------------------------------------------------
// The dispatcher's verdict on a failed native start: a cleanup that cannot be
// verified is never recorded as proven (loaded lazily: the production module
// sets PLOINKY_WORKSPACE_ROOT for this process).

test('a failed native start is "cleaned" only on a verified absence; unknown stays unproven', async () => {
    const { resolveSandboxFailureCleanup } = await import('../../cli/sandbox/docker/agentServiceManager.js');
    const candidate = { instanceId: 'cand-i', enableGeneration: 'cand-g' };
    const observed = (state, reason = 'x') => () => ({ state, reason, record: null });
    const stops = [];
    const stopImpl = (name, identity) => { stops.push([name, identity]); return { state: 'stopped' }; };
    const run = (extra) => resolveSandboxFailureCleanup({ containerName: 'k', candidateIdentity: candidate, stopImpl, ...extra });

    // The manager threw after launching, and its own cleanup left the slot unknown.
    assert.equal(run({ launch: null, error: new Error('x'), observeImpl: observed('unknown', 'identity-probe-failed') }).performed, false);
    assert.match(run({ launch: null, error: new Error('x'), observeImpl: observed('unknown', 'identity-probe-failed') }).detail, /could not be verified/);
    // The manager said its cleanup failed.
    assert.equal(run({ launch: null, error: Object.assign(new Error('x'), { exactCleanupFailed: true }), observeImpl: observed('absent') }).performed, false);
    // Absent, a foreign tuple, or a reused exact runtime that is not this call's: clean, and nothing is stopped.
    for (const state of ['absent', 'live-foreign', 'live-exact']) {
        assert.equal(run({ launch: null, error: new Error('x'), observeImpl: observed(state) }).performed, true, state);
    }
    assert.equal(run({ launch: null, error: new Error('x'), candidateIdentity: {}, observeImpl: observed('unknown') }).performed, true, 'nothing was staged');
    assert.deepEqual(stops, []);

    // The manager returned: a reuse is no candidate; a launch is stopped by its exact tuple.
    assert.equal(run({ launch: { createdByThisLaunch: false }, observeImpl: observed('unknown') }).performed, true);
    assert.equal(run({ launch: { createdByThisLaunch: true }, observeImpl: observed('unknown') }).performed, false);
    assert.equal(run({ launch: { createdByThisLaunch: true }, observeImpl: observed('live-exact') }).performed, true);
    assert.deepEqual(stops, [['k', candidate]]);
});
