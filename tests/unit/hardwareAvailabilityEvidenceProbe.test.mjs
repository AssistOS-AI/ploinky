// M-NW-01 D2-S, LS33 (D2S.8 assertion (1), rev6 F4): durable activation is
// proved WITHOUT HTTP, by a separate process that runs the resolver lock-free
// against the generation the selector names. The receipt binds the status
// identity and hash, polls from before the run started, records its first
// typed observation, cross-checks the worker's T_vis against the status file's
// ctime read through the probe's own descriptor, and carries the readiness and
// administrator projections of the SAME evaluation. A failed fsync is never
// credited.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { fsError, spyFs } from './hardwareAvailabilityFixtures.mjs';
import { CREDIT_WINDOW_MS, CTIME_TOLERANCE_MS, creditReceipt, namedGeneration } from './hardwareAvailabilityEvidenceProbe.mjs';
import { containerOf, makeWorld, startProbe } from './hardwareAvailabilityResolverFixtures.mjs';

const CAUSE = /Hardware limits are off for this workspace/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const P = 20;

function quiet(t) {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
}

// Start the probe, THEN stage the run (so polling begins before the run started) and write the worker's terminal status.
async function scenario(t, world, { fsApi, beforeWrite, afterWrite, probeOptions, lateByMs } = {}) {
    const probe = await startProbe(t, world, probeOptions);
    const runStartedAtMs = Date.now();
    const slot = world.stageSlot('alpha', { runStartedAtMs });
    if (beforeWrite) beforeWrite(slot);
    // `lateByMs`: the worker finished at runStartedAtMs + 30 but its durable rename comes this much later.
    await sleep(lateByMs ? lateByMs : 30);   // finishedAtMs must follow the run's sequence phase
    const finishedAtMs = lateByMs ? runStartedAtMs + 30 : Date.now();
    const report = world.writeWorker('alpha', slot, { kind: 'hardware', finishedAtMs, ...(fsApi ? { fsApi } : {}) });
    // The worker's own return value is the receipt's log line; nothing is hand-built.
    const delivered = afterWrite ? afterWrite(report) : report;
    fs.writeFileSync(probe.reportFile, JSON.stringify(delivered));
    return { slot, report, finishedAtMs, receipt: await probe.done };
}

function assertReceipt(world, receipt, { slot, report, finishedAtMs }, { selectorState = 'active', generationSource = 'selector.generation', generationUsed } = {}) {
    assert.equal(receipt.observed, true);
    assert.notEqual(receipt.pid, process.pid, 'the probe is a separate process');
    assert.equal(receipt.routerPid, process.pid);
    assert.equal(receipt.selectorState, selectorState);
    assert.equal(receipt.generationSource, generationSource);
    assert.equal(receipt.generationUsed, generationUsed);
    assert.equal(receipt.evaluation.denial.state, 'refused');
    assert.equal(receipt.evaluation.slot.evidenceClass, 'active');
    assert.equal(receipt.evaluation.slot.runId, slot.runId);
    // Clock: polling began before the run started and before T_f; the first typed observation is within T_f + 5000 + P.
    assert.ok(receipt.clock.pollingStartedAtMs <= slot.runStartedAtMs, 'polling began at or before runStartedAtMs');
    assert.ok(receipt.clock.pollingStartedAtMs <= finishedAtMs, 'polling began before T_f');
    assert.ok(receipt.clock.firstActiveObservedAtMs >= report.visibleAtMs - P, 'not before the rename');
    assert.ok(receipt.clock.firstActiveObservedAtMs <= finishedAtMs + CREDIT_WINDOW_MS + receipt.clock.pollIntervalMs);
    assert.ok(receipt.clock.pollIntervalMs <= 50);
    assert.ok(Number.isFinite(receipt.clock.firstActiveObservedMonoMs) && Number.isFinite(receipt.clock.pollingStartedMonoMs));
    // Identity: the slot and status identity and the status hash, read through the probe's own descriptor.
    const bytes = fs.readFileSync(world.statusPath(slot));
    assert.equal(receipt.status.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(receipt.status.file, slot.statusFile);
    assert.deepEqual(receipt.status.identity, {
        containerName: slot.key, instanceId: slot.instanceId, enableGeneration: slot.enableGeneration,
        runId: slot.runId, runStartedAtMs: slot.runStartedAtMs, waveIndex: slot.waveIndex, statusFile: slot.statusFile,
    });
    // The ctime cross-check: T_vis from the worker against the file's ctime.
    assert.ok(Math.abs(receipt.status.ctimeMs - report.visibleAtMs) <= CTIME_TOLERANCE_MS, `ctime ${receipt.status.ctimeMs} vs T_vis ${report.visibleAtMs}`);
    // T_f is the status file's own validated finishedAtMs, and it is recorded.
    assert.equal(receipt.status.finishedAtMs, finishedAtMs);
    assert.equal(receipt.checks.workerFinishMatchesStatus, true);
    // The SAME evaluation's projections are MIRRORS, labelled as such: they cannot fail, so they credit nothing.
    assert.equal(receipt.mirrorLabel, 'mirrored-from-the-observed-evaluation-not-the-real-readers');
    assert.deepEqual(receipt.mirroredReadiness, { availability: 'refused', ready: false });
    assert.equal(receipt.mirroredAdmin.availability, 'refused');
    assert.equal(receipt.mirroredAdmin.code, receipt.evaluation.denial.code);
    assert.equal(receipt.mirroredAdmin.reasonCode, 'gate_off');
    assert.match(receipt.mirroredAdmin.cause, CAUSE);
    assert.equal(receipt.evaluation.denial.reason, receipt.mirroredAdmin.cause, 'the admin cause is the denial\'s cause');
    // The REAL readers (metrics and the administrator handler's default store reader) are recorded as they answered.
    assert.equal(receipt.realReaders.reader, 'readStoreAvailabilityProjections');
    if (selectorState === 'active') {
        assert.equal(receipt.realReaders.returned, 'projections');
        assert.equal(receipt.realReaders.projectionForRoute, true);
        assert.deepEqual(receipt.realReaders.readiness, { availability: 'refused', ready: false });
        assert.equal(receipt.realReaders.admin.availability, 'refused');
        assert.equal(receipt.realReaders.admin.code, receipt.evaluation.denial.code);
        assert.match(receipt.realReaders.admin.cause, CAUSE);
        assert.equal(receipt.adminReadinessCredited, true);
    } else {
        // The default reader answers null for an inactive selector: the Router denies on that basis, and the real
        // readers show NO typed denial, which must be recorded as such and never credited.
        assert.equal(receipt.realReaders.returned, 'null');
        assert.equal(receipt.realReaders.projectionForRoute, false);
        assert.equal(receipt.realReaders.admin.code, null);
        assert.equal(receipt.realReaders.readiness.availability === 'refused', false);
        assert.equal(receipt.adminReadinessCredited, false, 'no admin or readiness credit from the mirror');
    }
}

test('NW1.S-durable-activation-is-proved-without-http-against-the-named-generation', async (t) => {
    quiet(t);
    // ---- the pure credit rule: every boundary
    const base = { pollingStartedAtMs: 1000, runStartedAtMs: 1000, tFinMs: 2000, workerFinishedAtMs: 2000, tVisMs: 2001, durableAtMs: 2002, ctimeMs: 2001, firstActiveObservedAtMs: 2010, pollIntervalMs: P };
    const credit = (change) => creditReceipt({ ...base, ...change });
    assert.equal(credit({}).credited, true);
    assert.equal(credit({ firstActiveObservedAtMs: 2000 + CREDIT_WINDOW_MS + P }).credited, true, 'exactly T_f + 5000 + P');
    assert.equal(credit({ firstActiveObservedAtMs: 2000 + CREDIT_WINDOW_MS + P + 1 }).credited, false, 'one ms past the window');
    assert.equal(credit({ firstActiveObservedAtMs: 2000 + CREDIT_WINDOW_MS + P + 1 }).checks.observedInWindow, false);
    assert.equal(credit({ ctimeMs: 2001 + CTIME_TOLERANCE_MS, firstActiveObservedAtMs: 2100 }).credited, true, 'ctime exactly 50 ms from T_vis');
    assert.equal(credit({ ctimeMs: 2001 + CTIME_TOLERANCE_MS + 1, firstActiveObservedAtMs: 3000 }).checks.ctimeMatchesVisible, false, 'ctime off by 51 ms');
    assert.equal(credit({ ctimeMs: 2001 - CTIME_TOLERANCE_MS - 1 }).credited, false);
    assert.equal(credit({ ctimeMs: 2011, tVisMs: 2011, firstActiveObservedAtMs: 2010 }).checks.ctimeBeforeObservation, false, 'ctime after the first observation');
    assert.equal(credit({ ctimeMs: Number.NaN }).credited, false);
    assert.equal(credit({ pollingStartedAtMs: 2001, runStartedAtMs: 3000 }).checks.pollingStartedBeforeFinish, false, 'polling after T_f');
    assert.equal(credit({ pollingStartedAtMs: 1500, runStartedAtMs: 1400 }).checks.pollingStartedBeforeRun, false, 'polling after the run started');
    assert.equal(credit({ workerFinishedAtMs: 2001 }).credited, false, 'a worker line whose finishedAtMs differs from the status file\'s');
    assert.equal(credit({ workerFinishedAtMs: 2001 }).checks.workerFinishMatchesStatus, false);
    assert.equal(credit({ workerFinishedAtMs: undefined }).credited, false, 'no worker finish is not credited');
    assert.equal(credit({ tFinMs: Number.NaN, workerFinishedAtMs: Number.NaN }).credited, false);
    assert.equal(credit({ durableAtMs: 2000 + CREDIT_WINDOW_MS }).credited, true);
    assert.equal(credit({ durableAtMs: 2000 + CREDIT_WINDOW_MS + 1 }).credited, false);
    assert.equal(credit({ durableAtMs: undefined, durabilityError: 'EIO' }).credited, false, 'a recorded durability error is not credited');
    assert.equal(credit({ durabilityError: 'EIO' }).checks.durable, false);
    assert.equal(credit({ durableAtMs: undefined, durabilitySkipped: 'EINVAL' }).credited, false, 'a skipped directory fsync is not credited');
    assert.equal(credit({ durabilitySkipped: 'EINVAL' }).checks.durable, false, 'even beside a durability time');
    // namedGeneration: the selector's own field, even while inactive.
    assert.deepEqual(namedGeneration({ generation: 'sha256:a', previousGeneration: 'sha256:b' }), { id: 'sha256:a', source: 'selector.generation' });
    assert.deepEqual(namedGeneration({ generation: '', previousGeneration: 'sha256:b' }), { id: 'sha256:b', source: 'selector.previousGeneration' });

    // ---- active selector: credited
    {
        const world = makeWorld(t);
        const generation = world.selection().generation;
        const run = await scenario(t, world);
        assertReceipt(world, run.receipt, run, { generationUsed: generation });
        assert.equal(run.receipt.checks.pollingStartedBeforeRun, true);
        assert.equal(run.receipt.checks.probeIsSeparateProcess, true);
        assert.equal(run.receipt.credited, true);
        assert.ok(Number.isSafeInteger(run.report.durableAtMs) && run.report.durabilityError === undefined);
    }
    // ---- the selector moves while the probe polls: it follows the generation the selector names NOW, not the one it saw first
    {
        const world = makeWorld(t, { routes: { alpha: { hostPort: 43101 }, beta: { hostPort: 43102 }, gamma: {} } });
        const first = world.selection().generation;
        let second = null;
        // alpha is targeted in the first generation (no slot can apply there) and target-less in the second.
        const run = await scenario(t, world, {
            beforeWrite: () => {
                const routing = world.readRouting();
                delete routing.routes.alpha.hostPort;
                world.writeRouting(routing);
                const agents = world.readAgents();
                delete agents[containerOf('alpha')].runtime;
                delete agents[containerOf('alpha')].containerId;
                world.writeAgents(agents);
                second = world.apply('alpha-becomes-target-less');
            },
        });
        assert.notEqual(second, first);
        assert.equal(world.selection().generation, second);
        assertReceipt(world, run.receipt, run, { generationUsed: second });
        assert.equal(run.receipt.credited, true);
    }
    // ---- inactive selector: the probe uses the generation the selector still names, and records which field it used
    {
        const world = makeWorld(t);
        const generation = world.selection().generation;
        const run = await scenario(t, world, { beforeWrite: () => world.inactivate('sibling-replacement-preparation') });
        assert.equal(world.selection().state, 'inactive');
        assertReceipt(world, run.receipt, run, { selectorState: 'inactive', generationSource: 'selector.previousGeneration', generationUsed: generation });
        assert.equal(run.receipt.credited, true);
    }
    // ---- a failed directory fsync: visible, typed, but NOT credited
    {
        const world = makeWorld(t);
        const generation = world.selection().generation;
        const failing = spyFs({
            fsyncSync: (descriptor, resolved) => {
                fs.fsyncSync(descriptor);
                if (resolved === world.statusDir) throw fsError('EIO');
            },
        });
        const run = await scenario(t, world, { fsApi: failing.api });
        assert.equal(run.report.durabilityError, 'EIO');
        assert.equal(run.report.durableAtMs, undefined, 'the worker credits no durability time');
        assert.equal(run.receipt.observed, true, 'the visible status still activates the denial');
        assertReceipt(world, run.receipt, run, { generationUsed: generation });
        assert.equal(run.receipt.checks.durable, false);
        assert.equal(run.receipt.credited, false, 'a failed fsync is not credited');
    }
    // ---- a forged T_vis (the worker line disagrees with the file's ctime) voids the receipt
    {
        const world = makeWorld(t);
        const run = await scenario(t, world, { afterWrite: (report) => ({ ...report, visibleAtMs: report.visibleAtMs + 500 }) });
        assert.equal(run.receipt.observed, true);
        assert.ok(Math.abs(run.receipt.status.ctimeMs - run.receipt.worker.visibleAtMs) > CTIME_TOLERANCE_MS);
        assert.equal(run.receipt.checks.ctimeMatchesVisible, false);
        assert.equal(run.receipt.credited, false, 'a ctime mismatch voids the receipt');
    }
    // ---- an end-to-end observation outside the window: the run finished at T_f, but the worker's durable rename comes 5.3 s later
    {
        const world = makeWorld(t);
        const run = await scenario(t, world, { lateByMs: CREDIT_WINDOW_MS + 300 });
        assert.equal(run.receipt.observed, true);
        assert.equal(run.receipt.status.finishedAtMs, run.finishedAtMs, 'T_f is the status file\'s validated finish time');
        assert.ok(run.receipt.clock.firstActiveObservedAtMs > run.finishedAtMs + CREDIT_WINDOW_MS + run.receipt.clock.pollIntervalMs, 'the first typed observation is past T_f + 5000 + P');
        assert.equal(run.receipt.checks.observedInWindow, false);
        assert.equal(run.receipt.credited, false, 'a late activation is not credited');
    }
    // ---- a forged worker line: T_f comes from the status file's validated finishedAtMs, so a line claiming another finish voids the receipt
    {
        const world = makeWorld(t);
        const run = await scenario(t, world, { afterWrite: (report) => ({ ...report, finishedAtMs: report.finishedAtMs - 60_000 }) });
        assert.equal(run.receipt.observed, true);
        assert.equal(run.receipt.status.finishedAtMs, run.finishedAtMs, 'T_f is the status file\'s');
        assert.equal(run.receipt.worker.finishedAtMs, run.finishedAtMs - 60_000);
        assert.equal(run.receipt.checks.workerFinishMatchesStatus, false);
        assert.equal(run.receipt.checks.observedInWindow, true, 'the window is measured from the status file\'s T_f, not the forged line');
        assert.equal(run.receipt.credited, false, 'a forged worker finish voids the receipt');
    }
    // ---- no activation: an honest negative receipt
    {
        const world = makeWorld(t);
        world.stageSlot('alpha', { runStartedAtMs: Date.now() });
        const probe = await startProbe(t, world, { deadlineMs: 400 });
        const receipt = await probe.done;
        assert.equal(receipt.observed, false);
        assert.equal(receipt.credited, false);
        assert.equal(receipt.evaluation.slot.evidenceClass, 'missing');
    }
});
