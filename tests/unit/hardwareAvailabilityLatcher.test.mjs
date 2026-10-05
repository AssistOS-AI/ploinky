// M-NW-01 D2-S step 6: the Router-process latcher (D2S.11). RECOVERY ONLY: it resolves slots whose run
// already reached a terminal status and never creates an activation, so nothing here earns A7/A8 credit.
// Real workspace, real edge generation, real durable store and apply lock, and statuses written by the
// real worker writer. The workspace lease and network lock live under the process-wide workspace root, so
// the in-process leaves record those two calls with spies and the real-lock leaves run in a child process
// whose workspace is the fixture.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareAdditiveEdgeRoutingGeneration, withEdgeGenerationApplyLock } from '../../cli/sandbox/edgeGeneration.js';
import { planNoWaitAvailabilitySlots } from '../../cli/commands/noWaitAvailabilitySlots.js';
import { createHardwareAvailabilityLatcher } from '../../cli/server/hardwareAvailabilityLatcher.mjs';
import { createHardwareAvailabilityResolverCache } from '../../cli/server/hardwareAvailabilityResolver.mjs';
import { applyPatches } from '../hardware-limits/c5Mutation.mjs';
import { slotFor } from './hardwareAvailabilityFixtures.mjs';
import { RUN_STARTED_AT_MS, containerOf, makeWorld, refusalOutcome } from './hardwareAvailabilityResolverFixtures.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const hrefOf = (relative) => pathToFileURL(path.join(ROOT, relative)).href;
// A source-text leaf reads the source the way the loaders hand it to the code: with the mutation of a mutant run applied.
const SRC = (relative) => {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const mutation = process.env.C5_MUTATION ? JSON.parse(process.env.C5_MUTATION) : null;
    return mutation && mutation.file === relative ? applyPatches(text, mutation.patches) : text;
};
const DRIVER = path.join(ROOT, 'tests/unit/hardwareAvailabilityLatcherDriver.mjs');
const LATCHED = 'hardware_availability_latched';
const DEFERRED = 'hardware_availability_latch_deferred';

const quiet = (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await sleep(5);
    }
}
const policyBytes = (world) => crypto.createHash('sha256').update(fs.readFileSync(world.paths.availabilityPolicyFile)).digest('hex');
const freshEvaluation = (world) => world.resolve({ cache: createHardwareAvailabilityResolverCache() });
const denialOf = (world, routeKey = 'alpha') => freshEvaluation(world).denials.get(routeKey) || null;
const codeError = (code) => Object.assign(new Error(code), { code });

// A latcher over the world with every lock call recorded. The workspace lease and network lock are
// spies (their files belong to the process-wide workspace); the apply lock is the real one.
function latcherOf(world, { behaviors = {}, retryMs = 20, pollMs = 60_000, context = null, timers } = {}) {
    const calls = [];
    const logs = [];
    let renames = 0;
    const locks = {
        createLease: (options) => {
            calls.push({ lock: 'lease', operation: options?.operation, context: context?.getStore() });
            behaviors.createLease?.();
            return { token: 'spy-lease', operation: options?.operation };
        },
        releaseLease: () => { calls.push({ lock: 'lease-release' }); return true; },
        runWithLease: (lease, fn) => { calls.push({ lock: 'run-with-lease' }); return fn(); },
        networkLock: (callback, options) => {
            calls.push({ lock: 'network', waitMs: options?.waitMs });
            behaviors.network?.();
            return callback({});
        },
        applyLock: (callback, options) => {
            calls.push({ lock: 'apply' });
            behaviors.apply?.();
            return withEdgeGenerationApplyLock(callback, options);
        },
    };
    const latcher = createHardwareAvailabilityLatcher({
        workspaceRoot: world.root,
        runningDir: world.runningDir,
        log: (type, data) => logs.push({ type, ...data }),
        locks,
        hooks: { beforeRename: () => { renames += 1; } },
        retryMs,
        pollMs,
        ...(timers ? { timers } : {}),
    });
    return { latcher, calls, logs, renames: () => renames, kinds: () => calls.map((call) => call.lock) };
}

// Timers that measure every scheduled synchronous section: the CPU time it used and its wall time. The
// latcher's scheduled work is exactly what can block the Router's event loop.
function measuredTimers(sections) {
    const measure = (callback) => () => {
        const cpuStart = process.cpuUsage();
        const wallStart = performance.now();
        try {
            return callback();
        } finally {
            const cpu = process.cpuUsage(cpuStart);
            sections.push({ cpuMs: (cpu.user + cpu.system) / 1000, wallMs: performance.now() - wallStart });
        }
    };
    return {
        setTimeout: (callback, delay) => setTimeout(measure(callback), delay),
        clearTimeout: (handle) => clearTimeout(handle),
        setInterval: (callback, delay) => setInterval(callback, delay),
        clearInterval: (handle) => clearInterval(handle),
    };
}

function terminalAlpha(world, extra = {}) {
    const slot = world.stageSlot('alpha');
    world.writeWorker('alpha', slot, { kind: 'hardware', ...extra });
    return slot;
}

test('NW1.S-the-latcher-resolves-terminal-slots-fail-fast-in-one-rename-with-fencing-and-cause', async (t) => {
    quiet(t);

    // ---- the commit: one rename, the locks in order and fail-fast, the original cause logged as recovery
    {
        const world = makeWorld(t);
        const slot = terminalAlpha(world, { reason: 'the original cause' });
        const status = world.readStatus(slot);
        const before = freshEvaluation(world);
        const probe = latcherOf(world);
        const result = probe.latcher.attempt();
        assert.equal(result.outcome, 'committed');
        assert.equal(probe.renames(), 1, 'one rename of the policy');
        assert.deepEqual(probe.kinds(), ['lease', 'run-with-lease', 'network', 'apply', 'lease-release'], 'lease, network lock, apply lock, in that order, then released');
        assert.equal(probe.calls[0].operation, 'hardware-availability-latch');
        assert.equal(probe.calls.find((call) => call.lock === 'network').waitMs, 0, 'the network lock never waits');
        const store = world.store();
        assert.deepEqual(Object.keys(store.slots), [], 'the slot is resolved in the same commit');
        assert.equal(store.entries.alpha.source.runId, slot.runId);
        const after = freshEvaluation(world);
        assert.equal(after.revision, before.revision, 'the effective revision is unchanged by the commit');
        assert.deepEqual(probe.logs.map((line) => line.type), [LATCHED]);
        assert.deepEqual(probe.logs[0], {
            type: LATCHED,
            routeKey: 'alpha',
            key: containerOf('alpha'),
            runId: slot.runId,
            runStartedAtMs: RUN_STARTED_AT_MS,
            finishedAtMs: status.finishedAtMs,
            code: status.error.hardwareOutcome.code,
            reasonCode: status.error.hardwareOutcome.reasonCode,
            resolution: 'latched',
            recovery: true,
        }, 'the original identity and cause, labelled as recovery');
        assert.equal(probe.latcher.attempt().outcome, 'idle', 'nothing is left to resolve');
    }

    // ---- no lock is taken unless every pre-filter condition holds
    const noLockCalls = (probe, world, bytes, expected, label) => {
        const result = probe.latcher.attempt();
        assert.equal(result.outcome, expected.outcome, label);
        if (expected.reason) assert.equal(result.reason, expected.reason, label);
        assert.deepEqual(probe.calls, [], `${label}: no lock call`);
        assert.equal(policyBytes(world), bytes, `${label}: the policy is untouched`);
    };
    {
        const world = makeWorld(t);
        const probe = latcherOf(world);
        noLockCalls(probe, world, policyBytes(world), { outcome: 'idle' }, 'no slot');
        const slot = world.stageSlot('alpha');
        world.writeWorker('alpha', slot, { kind: 'starting' });
        noLockCalls(probe, world, policyBytes(world), { outcome: 'idle' }, 'a pending slot');
    }
    {
        const world = makeWorld(t);
        terminalAlpha(world);
        world.inactivate();
        noLockCalls(latcherOf(world), world, policyBytes(world), { outcome: 'deferred', reason: 'selector-inactive' }, 'an inactive selector');
    }
    {
        const world = makeWorld(t);
        terminalAlpha(world);
        withEdgeGenerationApplyLock((applyLockCapability) => prepareAdditiveEdgeRoutingGeneration({
            workspaceRoot: world.root, applyLockCapability, reason: 'fixture-preparation',
        }), { workspaceRoot: world.root });
        noLockCalls(latcherOf(world), world, policyBytes(world), { outcome: 'deferred', reason: 'preparation-outstanding' }, 'an outstanding preparation');
    }
    {
        const world = makeWorld(t);
        terminalAlpha(world);
        fs.writeFileSync(world.paths.availabilityPolicyFile, '{ not json');
        noLockCalls(latcherOf(world), world, crypto.createHash('sha256').update('{ not json').digest('hex'), { outcome: 'deferred', reason: 'store-unreadable' }, 'an unreadable store');
    }

    // ---- fencing: only own-pid terminal evidence of exactly this run is resolved
    {
        const routes = { alpha: {}, gamma: {}, delta: {}, epsilon: {}, zeta: {}, eta: {} };
        const world = makeWorld(t, { routes });
        const slots = Object.fromEntries(Object.keys(routes).map((routeKey) => [routeKey, world.stageSlot(routeKey)]));
        world.writeWorker('alpha', slots.alpha, { kind: 'hardware' });
        world.rewriteStatus(slots.alpha, (document) => { delete document.pid; });                                      // unowned
        world.writeWorker('gamma', slots.gamma, { kind: 'hardware', outcome: refusalOutcome(containerOf('someone-else')) }); // outcome of another key: invalid
        fs.writeFileSync(world.statusPath(slots.delta), 'not json');                                                    // invalid
        world.writeWorker('epsilon', slots.epsilon, { kind: 'starting' });                                              // pending
        // zeta has no status: missing
        const bytes = policyBytes(world);
        const probe = latcherOf(world);
        noLockCalls(probe, world, bytes, { outcome: 'idle' }, 'unowned, mismatched, invalid, pending and missing evidence');
        assert.deepEqual(Object.keys(world.store().slots).sort(), Object.keys(routes).sort(), 'none of them is resolved');
        // One terminal slot among them is resolved, and only that one.
        world.writeWorker('eta', slots.eta, { kind: 'running' });
        assert.equal(probe.latcher.attempt().outcome, 'committed');
        assert.deepEqual(Object.keys(world.store().slots).sort(), ['alpha', 'delta', 'epsilon', 'gamma', 'zeta'], 'only the succeeded run was resolved');
        assert.deepEqual(Object.keys(world.store().entries), [], 'and nothing was latched');
        const retired = probe.logs.find((line) => line.type === LATCHED && line.routeKey === 'eta');
        assert.deepEqual([retired.resolution, retired.key, retired.runStartedAtMs, retired.recovery], ['retired', containerOf('eta'), RUN_STARTED_AT_MS, true], 'a retired slot is logged with its identity');
    }

    // ---- every busy lock defers, never fails, never stops the latcher
    const deferrals = {
        PLOINKY_WORKSPACE_MUTATION_BUSY: { behaviors: { createLease: () => { throw codeError('PLOINKY_WORKSPACE_MUTATION_BUSY'); } }, leased: false },
        PLOINKY_WORKSPACE_MUTATION_RECOVERY_REQUIRED: { behaviors: { createLease: () => { throw codeError('PLOINKY_WORKSPACE_MUTATION_RECOVERY_REQUIRED'); } }, leased: false },
        PLOINKY_NETWORK_LIFECYCLE_BUSY: { behaviors: { network: () => { throw codeError('PLOINKY_NETWORK_LIFECYCLE_BUSY'); } }, leased: true },
        EDGE_PREPARATION_BUSY: { behaviors: { apply: () => { throw codeError('EDGE_PREPARATION_BUSY'); } }, leased: true },
        EDGE_GENERATION_BUSY: { behaviors: {}, leased: true, realHold: true },
    };
    for (const [code, { behaviors, leased, realHold }] of Object.entries(deferrals)) {
        const world = makeWorld(t);
        terminalAlpha(world, { reason: `cause behind ${code}` });
        const bytes = policyBytes(world);
        const probe = latcherOf(world, { behaviors });
        const attemptBlocked = () => (realHold
            ? withEdgeGenerationApplyLock(() => probe.latcher.attempt(), { workspaceRoot: world.root })
            : probe.latcher.attempt());
        for (let index = 0; index < 3; index += 1) {
            const result = attemptBlocked();
            assert.deepEqual([result.outcome, result.reason], ['deferred', code], code);
        }
        assert.equal(policyBytes(world), bytes, `${code}: nothing was written`);
        assert.equal(probe.kinds().filter((kind) => kind === 'lease-release').length, leased ? 3 : 0, `${code}: a taken lease is always released`);
        assert.equal(probe.logs.filter((line) => line.type === DEFERRED).length, 1, `${code}: logged once per state change`);
        assert.equal(probe.logs.find((line) => line.type === DEFERRED).reason, code);
        // Unblocked, the same latcher resolves the slot: the deferral is not a stop.
        for (const name of Object.keys(behaviors)) delete behaviors[name];
        assert.equal(probe.latcher.attempt().outcome, 'committed', `${code}: resumes once unblocked`);
        assert.deepEqual(Object.keys(world.store().slots), []);
        assert.equal(denialOf(world).reason, `cause behind ${code}`, `${code}: the original cause survives the deferral`);
    }
    // Through the scheduler: the retry runs until the lock frees, for every deferral code.
    for (const code of Object.keys(deferrals)) {
        const world = makeWorld(t);
        terminalAlpha(world, { reason: `scheduled ${code}` });
        let blocked = 3;
        const behaviors = {};
        const hold = () => { if (blocked > 0) { blocked -= 1; throw codeError(code); } };
        if (code.startsWith('PLOINKY_WORKSPACE')) behaviors.createLease = hold;
        else if (code === 'PLOINKY_NETWORK_LIFECYCLE_BUSY') behaviors.network = hold;
        else behaviors.apply = hold;
        const probe = latcherOf(world, { behaviors });
        probe.latcher.start();
        t.after(() => probe.latcher.stop());
        await waitFor(() => Object.keys(world.store().slots).length === 0, `${code} to retry and resolve`);
        assert.equal(blocked, 0, `${code}: it was deferred first`);
        assert.equal(probe.logs.filter((line) => line.type === LATCHED).length, 1);
        probe.latcher.stop();
    }

    // ---- a Router that starts with a terminal slot already on disk latches it at its first unblocked attempt
    {
        const world = makeWorld(t);
        terminalAlpha(world, { reason: 'before the respawn' });
        const probe = latcherOf(world);
        probe.latcher.start();
        t.after(() => probe.latcher.stop());
        await waitFor(() => Object.keys(world.store().slots).length === 0, 'the first attempt');
        assert.equal(world.store().entries.alpha.projection.problem.reason, 'before the respawn');
        probe.latcher.stop();
    }

    // ---- a resolver signal only schedules: no lock call is ever made inside a capture's call stack, and the
    //      attempt does not inherit the capture's async context
    {
        const world = makeWorld(t);
        const context = new AsyncLocalStorage();
        const probe = latcherOf(world, { context });
        probe.latcher.start();
        t.after(() => probe.latcher.stop());
        await sleep(30);
        assert.deepEqual(probe.calls, [], 'nothing to do yet');
        terminalAlpha(world);
        context.run('capture-context', () => { world.resolve({ cache: createHardwareAvailabilityResolverCache() }); });
        assert.deepEqual(probe.calls, [], 'the signal made no lock call inside the capture');
        await waitFor(() => Object.keys(world.store().slots).length === 0, 'the signalled attempt');
        assert.equal(probe.calls.find((call) => call.lock === 'lease').context, undefined, 'the attempt ran outside the signalling capture\'s context');
        probe.latcher.stop();
    }
    // Captures during a deferral do not storm the locks.
    {
        const world = makeWorld(t);
        terminalAlpha(world);
        const probe = latcherOf(world, { retryMs: 300, behaviors: { createLease: () => { throw codeError('PLOINKY_WORKSPACE_MUTATION_BUSY'); } } });
        probe.latcher.start();
        t.after(() => probe.latcher.stop());
        await waitFor(() => probe.kinds().includes('lease'), 'the first deferral');
        for (let index = 0; index < 100; index += 1) world.resolve({ cache: createHardwareAvailabilityResolverCache() });
        await sleep(40);
        assert.ok(probe.kinds().filter((kind) => kind === 'lease').length <= 2, `a blocked latcher is not signalled into a storm (${probe.kinds().length} calls)`);
        probe.latcher.stop();
        const count = probe.calls.length;
        world.resolve({ cache: createHardwareAvailabilityResolverCache() });
        await sleep(40);
        assert.equal(probe.calls.length, count, 'a stopped latcher ignores signals');
    }

    // ---- the resolve invariant: an aborted plan keeps the state and its log line is labelled as recovery too
    {
        const world = makeWorld(t);
        terminalAlpha(world);
        const bytes = policyBytes(world);
        const logs = [];
        const dropsTheDenial = (input) => ({ ...planNoWaitAvailabilitySlots(input), resolved: { entries: {}, slots: {} } });
        const latcher = createHardwareAvailabilityLatcher({
            workspaceRoot: world.root, runningDir: world.runningDir, log: (type, data) => logs.push({ type, ...data }), planner: dropsTheDenial,
            locks: { createLease: () => ({}), releaseLease: () => true, runWithLease: (lease, fn) => fn(), networkLock: (callback) => callback({}), applyLock: withEdgeGenerationApplyLock },
        });
        assert.equal(latcher.attempt().outcome, 'failed');
        assert.equal(policyBytes(world), bytes, 'nothing was committed');
        const aborted = logs.find((line) => line.type === 'hardware_availability_resolve_aborted');
        assert.ok(aborted, 'the abort is logged');
        assert.equal(aborted.recovery, true, 'and labelled as recovery');
    }

    // ---- bounds: 256 slots in one commit, in scheduled synchronous sections that each stay within 200 ms
    {
        const names = Array.from({ length: 256 }, (_, index) => `r${String(index).padStart(3, '0')}`);
        const world = makeWorld(t, { routes: Object.fromEntries(names.map((name) => [name, {}])) });
        // A heartbeat watches the event loop while the latcher resolves 256 slots, and the gate is its largest gap
        // (wall clock, so a blocking wait inside the locked commit is seen as well as CPU work). Each scheduled
        // synchronous section is also measured; its CPU time is reported only. A run is measured up to three times and
        // passes with its best, so a transient load spike does not fail it while a gap that really is too long fails all three.
        const measurements = [];
        for (let round = 0; round < 3; round += 1) {
            world.commitStore({ entries: {}, slots: Object.fromEntries(names.map((name) => [name, slotFor(name, { key: containerOf(name), runStartedAtMs: RUN_STARTED_AT_MS })])) });
            for (const name of names) world.writeWorker(name, world.store().slots[name], { kind: 'hardware', reason: 'x' });
            const sections = [];
            const probe = latcherOf(world, { timers: measuredTimers(sections) });
            let last = performance.now();
            let gapMs = 0;
            const heartbeat = setInterval(() => {
                const at = performance.now();
                gapMs = Math.max(gapMs, at - last);
                last = at;
            }, 2);
            last = performance.now();
            probe.latcher.start();
            try {
                await waitFor(() => Object.keys(world.store().slots).length === 0, 'the 256-slot commit', 60_000);
            } finally {
                clearInterval(heartbeat);
                probe.latcher.stop();
            }
            assert.equal(probe.renames(), 1, 'one rename for all 256 slots');
            assert.equal(Object.keys(world.store().entries).length, 256);
            assert.equal(probe.logs.filter((line) => line.type === LATCHED).length, 256);
            assert.ok(sections.length >= 2, 'the attempt ran as at least two scheduled sections (read, then commit)');
            measurements.push({
                cpuMs: Math.max(...sections.map((section) => section.cpuMs)),
                wallMs: Math.max(...sections.map((section) => section.wallMs)),
                gapMs,
            });
            if (measurements.at(-1).gapMs <= 200) break;
        }
        t.diagnostic(`256 slots: ${measurements.map((m) => `longest section ${m.cpuMs.toFixed(1)} ms CPU / ${m.wallMs.toFixed(1)} ms wall, heartbeat gap ${m.gapMs.toFixed(1)} ms (gated)`).join('; ')}; load average ${os.loadavg()[0].toFixed(1)} on ${os.cpus().length} CPUs`);
        assert.ok(measurements.some((m) => m.gapMs <= 200), `every 256-slot run blocked the event loop for more than 200 ms (heartbeat gaps ${measurements.map((m) => m.gapMs.toFixed(1)).join(', ')} ms)`);
    }

    // ---- the same fail-fast behavior with the REAL workspace lease, network lock and apply lock
    for (const hold of ['lease', 'network', 'apply']) {
        const world = makeWorld(t);
        terminalAlpha(world);
        const run = runLatcherDriver(world, 'contend', { hold });
        assert.equal(run.blocked.outcome.outcome, 'deferred', `${hold} held: deferred`);
        assert.equal(run.blocked.unchanged, true, `${hold} held: nothing written`);
        assert.equal(run.blocked.renames, 0);
        assert.ok(run.blocked.cpuMs <= 200, `${hold} held: the attempt used ${run.blocked.cpuMs.toFixed(1)} ms of CPU`);
        assert.ok(run.blocked.durationMs <= 5000, `${hold} held: the attempt returned in ${run.blocked.durationMs.toFixed(1)} ms (a latcher that waited on the lock would not)`);
        assert.deepEqual(run.blockedCalls.map((call) => call.lock), {
            lease: ['lease'],
            network: ['lease', 'network', 'lease-release'],
            apply: ['lease', 'network', 'apply', 'lease-release'],
        }[hold], `${hold} held: the attempt stopped at the held lock and released what it took`);
        for (const call of run.blockedCalls.filter((entry) => entry.lock === 'network')) assert.equal(call.waitMs, 0);
        assert.equal(run.second.outcome.outcome, 'committed', `${hold} released: the next attempt commits`);
        assert.equal(run.second.renames, 1);
        assert.deepEqual(run.second.snapshot.slots, []);
        assert.deepEqual(run.second.snapshot.entries, ['alpha']);
        assert.ok(run.second.cpuMs <= 200);
        assert.equal(run.logs.filter((line) => line.type === LATCHED).length, 1);
    }
});

test('NW1.S-latched-causes-survive-evidence-deletion-and-rewrites', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slot = terminalAlpha(world, { reason: 'the latched cause' });
    const probe = latcherOf(world);
    assert.equal(probe.latcher.attempt().outcome, 'committed');
    const baseline = denialOf(world);
    assert.equal(baseline.reason, 'the latched cause');
    const entries = JSON.stringify(world.store().entries);
    const rewrites = {
        'starting': (document) => { document.state = 'starting'; delete document.error; delete document.finishedAt; delete document.finishedAtMs; },
        'running': (document) => { document.state = 'running'; delete document.error; delete document.finishedAt; delete document.finishedAtMs; },
        'pid-less': (document) => { delete document.pid; },
        'generic failure': (document) => { delete document.error.hardwareOutcome; delete document.error.code; },
        'a different cause': (document) => { document.error.hardwareOutcome = refusalOutcome(slot.key, { reason: 'a forged cause' }); },
        'invalid content': () => 'not json at all',
    };
    const original = world.readStatus(slot);
    for (const [label, rewrite] of Object.entries(rewrites)) {
        world.rewriteStatus(slot, () => { const document = structuredClone(original); return rewrite(document) ?? document; });
        assert.deepEqual(denialOf(world), baseline, `${label}: the same denial`);
        assert.equal(JSON.stringify(world.store().entries), entries, `${label}: the entry is untouched`);
    }
    world.removeStatus(slot);
    assert.deepEqual(denialOf(world), baseline, 'deletion: the same denial');
    assert.equal(probe.latcher.attempt().outcome, 'idle', 'the latcher has nothing left to do');
    assert.equal(JSON.stringify(world.store().entries), entries);

    // A succeeded run is resolved without a denial, and deleting its evidence afterwards leaves none.
    const clean = makeWorld(t);
    const ok = clean.stageSlot('alpha');
    clean.writeWorker('alpha', ok, { kind: 'running' });
    const cleanProbe = latcherOf(clean);
    assert.equal(cleanProbe.latcher.attempt().outcome, 'committed');
    assert.deepEqual([clean.store().entries, clean.store().slots], [{}, {}]);
    assert.equal(denialOf(clean), null);
    clean.removeStatus(ok);
    assert.equal(denialOf(clean), null, 'deletion after a succeeded resolution leaves no denial');
});

test('NW1.S-the-latcher-is-wired-after-metrics-start-and-stopped-first', () => {
    const router = SRC('cli/server/RoutingServer.js');
    const calls = router.match(/hardwareAvailabilityLatcher\.(start|stop)\(/g) || [];
    assert.deepEqual(calls.sort(), ['hardwareAvailabilityLatcher.start(', 'hardwareAvailabilityLatcher.stop('], 'one start and one stop');
    const metrics = router.indexOf('workspaceMetricsMonitor.start();');
    const start = router.indexOf('hardwareAvailabilityLatcher.start();');
    assert.ok(metrics > 0 && start > metrics, 'start() follows workspaceMetricsMonitor.start()');
    const beforeClose = /beforeClose: \[async \(\) => \{\n(\s*)([^\n]+)\n/.exec(router);
    assert.ok(beforeClose, 'the beforeClose hook is found');
    assert.equal(beforeClose[2], 'hardwareAvailabilityLatcher.stop();', 'the first statement of beforeClose stops the latcher');
    // S5: the latcher never waits and never uses the waiting lock helpers.
    const latcher = SRC('cli/server/hardwareAvailabilityLatcher.mjs');
    assert.doesNotMatch(latcher, /Atomics\.wait|acquireWorkspaceMutationLease|withWorkspaceMutationLease\(|withHeldOrAcquiredWorkspaceMutationLease|withActiveNoWaitWorkerLifecycleLease|withNetworkLifecycleLockAsync|withNetworkLifecycleLockReclaimingStoppedOwner/);
    // S2: only the reviewed modules commit the policy or retire entries.
    assert.match(latcher, /commitNoWaitAvailabilitySlotPlan\(/);
});

// ---------------------------------------------------------------- real child processes

function driverArgs(phase, argument) {
    return [
        '--import', hrefOf('tests/helpers/agentlibTestContract.mjs'),
        '--import', hrefOf('tests/helpers/engineSpawnGuard.mjs'),
        ...(process.env.C5_MUTATION ? ['--import', hrefOf('tests/hardware-limits/c5MutationRegister.mjs')] : []),
        DRIVER, phase, JSON.stringify(argument),
    ];
}
function driverEnv(world) {
    const env = { ...process.env, PLOINKY_WORKSPACE_ROOT: world.root, PLOINKY_ROUTER_HOST_PORT: '18080', PLOINKY_MEDIA_HOST_PORT: '17891' };
    delete env.NODE_TEST_CONTEXT;
    return env;
}
function parseDriver(stdout, stderr, status) {
    const line = String(stdout).trim().split('\n').filter(Boolean).pop();
    if (!line) throw new Error(`the latcher driver wrote no result (exit ${status}): ${String(stderr).slice(-800)}`);
    const value = JSON.parse(line);
    if (value.driverError) throw new Error(`the latcher driver failed: ${value.driverError.slice(0, 1500)}`);
    return value;
}
function runLatcherDriver(world, phase, argument = {}) {
    const child = spawnSync(process.execPath, driverArgs(phase, argument), { cwd: ROOT, env: driverEnv(world), encoding: 'utf8', timeout: 120_000 });
    return parseDriver(child.stdout, child.stderr, child.status);
}

async function killLatcherAt(t, world, pauseAt) {
    const signalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-sig-'));
    t.after(() => fs.rmSync(signalDir, { recursive: true, force: true }));
    const child = spawn(process.execPath, driverArgs('pause', { pauseAt, signalDir }), { cwd: ROOT, env: driverEnv(world), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    let early = null;
    exited.then((value) => { early = value; });
    const marker = path.join(signalDir, `paused.${pauseAt}`);
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(marker)) {
        if (early) throw new Error(`the latcher driver ended before pausing at ${pauseAt}: ${JSON.stringify(early)}\n${output}`);
        if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`the latcher driver did not reach ${pauseAt}\n${output}`); }
        await sleep(10);
    }
    child.kill('SIGKILL');
    const result = await exited;
    assert.equal(result.signal, 'SIGKILL');
    return { pid: child.pid };
}

test('NW1.S-a-killed-latcher-leaves-either-the-active-slot-or-the-latched-entry', async (t) => {
    quiet(t);
    const storeNames = (world) => fs.readdirSync(world.paths.availabilityStoreDir).sort();
    for (const pauseAt of ['beforeRename', 'afterRename']) {
        const world = makeWorld(t);
        const slot = terminalAlpha(world, { reason: `killed at ${pauseAt}` });
        const baseline = denialOf(world);
        assert.equal(baseline.reason, `killed at ${pauseAt}`);
        const bytes = policyBytes(world);
        const { pid } = await killLatcherAt(t, world, pauseAt);
        const after = world.store();
        assert.equal(denialOf(world).reason, baseline.reason, `${pauseAt}: the denial is the same cause`);
        if (pauseAt === 'beforeRename') {
            assert.equal(policyBytes(world), bytes, 'killed before the rename: the policy is byte-identical');
            assert.deepEqual([Object.keys(after.entries), Object.keys(after.slots)], [[], ['alpha']], 'the active slot remains');
            assert.ok(storeNames(world).some((name) => name.startsWith(`.policy.json.${pid}.`)), 'the dead owner left its temp');
        } else {
            assert.deepEqual([Object.keys(after.entries), Object.keys(after.slots)], [['alpha'], []], 'killed after the rename: the entry is committed and the slot gone');
            assert.equal(after.entries.alpha.source.runId, slot.runId);
        }
        // The stale lease, apply lock and network lock of the dead owner are reclaimed by the existing rules, and a
        // fresh latcher then resolves what is left (the network lock only after its stale-owner grace).
        const recovered = runLatcherDriver(world, 'recover', { timeoutMs: 40_000 });
        assert.deepEqual(recovered.snapshot.slots, [], `${pauseAt}: nothing is left unresolved`);
        assert.deepEqual(recovered.snapshot.entries, ['alpha']);
        assert.equal(denialOf(world).reason, baseline.reason, `${pauseAt}: still the original cause after recovery`);
        assert.deepEqual(storeNames(world), ['policy.json'], `${pauseAt}: the dead owner's temp is swept`);
        if (pauseAt === 'beforeRename') {
            assert.ok(recovered.logs.some((line) => line.type === LATCHED && line.recovery === true), 'the recovery latch is logged as recovery');
        }
    }
});
