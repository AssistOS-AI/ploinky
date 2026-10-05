// M-NW-01 D2-S: the lock-free, change-keyed, bounded hardware-availability
// resolver. Real workspace, real edge generation, real durable store, and
// statuses written by the real worker writer. Typed denials come only from
// validated `active` evidence and gated committed entries; every other class
// leaves the route on its generic fail-closed disposition.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeFreshEdgeRoutingSources, resolveEdgeGenerationPaths } from '../../cli/sandbox/edgeGeneration.js';
import { readHardwareAvailabilityPolicy } from '../../cli/sandbox/hardwareAvailabilityStore.mjs';
import { dispatchAgentStartupAfterRouterSurfaces } from '../../cli/server/agentStartupDispatch.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import {
    EVIDENCE_CLASSES,
    createHardwareAvailabilityResolverCache,
    resolveEffectiveHardwareAvailability,
} from '../../cli/server/hardwareAvailabilityResolver.mjs';
import { commit, fsError, slotFor, spyFs } from './hardwareAvailabilityFixtures.mjs';
import {
    RUN_STARTED_AT_MS,
    containerOf,
    countingFs,
    entryFor,
    makeWorld,
    refusalOutcome,
    runProbeSync,
    uuid,
} from './hardwareAvailabilityResolverFixtures.mjs';

const fresh = () => createHardwareAvailabilityResolverCache();

// One resolver evaluation of alpha with a fresh cache (so no earlier read is reused).
function evaluate(world, options = {}) {
    const result = world.resolve({ cache: fresh(), ...options });
    return {
        result,
        denial: result.denials.get('alpha') || null,
        projection: result.projections.get('alpha') || null,
        evidenceClass: result.slots.get('alpha')?.evidenceClass ?? null,
    };
}

function staged(world, routeKey = 'alpha', overrides = {}) {
    return world.stageSlot(routeKey, overrides);
}

const OUTCOME_KEYS = ['code', 'enableGeneration', 'fix', 'instanceId', 'key', 'reason', 'reasonCode', 'rootKey', 'state'];

function assertTypedFrom(denial, outcome, { instanceId = 'alpha-instance', enableGeneration = 'alpha-generation' } = {}) {
    assert.deepEqual(Object.keys(denial).sort(), OUTCOME_KEYS, 'exactly the compiled denial shape');
    assert.equal(denial.state, 'refused');
    assert.equal(denial.code, outcome.code);
    assert.equal(denial.reasonCode, outcome.reasonCode);
    assert.equal(denial.reason, outcome.reason);
    assert.equal(denial.fix, outcome.fix);
    assert.equal(denial.key, outcome.key);
    assert.equal(denial.instanceId, instanceId);
    assert.equal(denial.enableGeneration, enableGeneration);
}

// The generation compiles only when the route's container has a registry record; give the renamed one its own tuple.
function addRenamedContainer(world) {
    const agents = world.readAgents();
    agents.ploinky_fixtures_renamed = { ...agents[containerOf('alpha')], instanceId: 'renamed-instance', enableGeneration: 'renamed-generation' };
    world.writeAgents(agents);
}

const alphaOutcome = (reason) => refusalOutcome(containerOf('alpha'), { ref: 'fixtures/alpha', ...(reason === undefined ? {} : { reason }) });

function quiet(t) {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
}

function request({ routeKey = 'alpha', pathname = '/api/data', accept = 'application/json' } = {}) {
    return { method: 'GET', url: `/${routeKey}${pathname}`, headers: { host: '127.0.0.1:18080', accept } };
}

class MockResponse {
    constructor() { this.statusCode = 0; this.headers = {}; this.body = ''; }
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; this.headers = { ...headers }; }
    end(body = '') { this.body += body === undefined ? '' : String(body); }
}

async function dispatch(req, plan) {
    const res = new MockResponse();
    let lifecycleReads = 0;
    const handled = await dispatchAgentStartupAfterRouterSurfaces({
        req, res, parsedUrl: plan.parsedUrl, routePlan: plan,
        ensureRouteAccess: async () => ({ ok: true }),
        inspectPublication: () => ({ ok: true, canPublishHttp: true }),
        resolveStartupState: async () => { lifecycleReads += 1; return { state: 'starting' }; },
    });
    return { handled, res, lifecycleReads };
}

test('NW1.S-activation-is-the-run-scoped-rename', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slot = staged(world);
    const outcome = alphaOutcome();
    let before = null;
    let after = null;
    const spy = spyFs({
        renameSync: (from, to) => {
            if (to === world.statusPath(slot)) before = evaluate(world);
            fs.renameSync(from, to);
            if (to === world.statusPath(slot)) after = evaluate(world);
        },
    });
    const finishedAtMs = Date.now();
    const report = world.writeWorker('alpha', slot, { finishedAtMs, fsApi: spy.api });
    // The canonical file is already renamed and visible: only the run-scoped rename activates.
    assert.ok(fs.existsSync(path.join(world.statusDir, `${slot.key}.json`)));
    assert.equal(before.denial, null, 'no denial before the run-scoped rename');
    assert.equal(before.evidenceClass, 'missing');
    assertTypedFrom(after.denial, outcome);
    assert.equal(after.evidenceClass, 'active');
    assert.equal(after.projection.observedAt, new Date(finishedAtMs).toISOString(), 'observedAt is the validated finish time');
    assert.ok(report.visibleAtMs - report.finishedAtMs < 5000, `T_vis - T_f = ${report.visibleAtMs - report.finishedAtMs} ms`);
    assert.ok(report.durableAtMs >= report.visibleAtMs);
    // The cross-process half: another process, with no lease and no HTTP, reads the typed denial with its cause fields after the rename.
    const probeOptions = { workspaceRoot: world.root, routeKey: 'alpha', pollIntervalMs: 20, deadlineMs: 5000, routerPid: process.pid };
    const seen = runProbeSync(probeOptions);
    assert.notEqual(seen.pid, process.pid, 'read from another process');
    assert.equal(seen.observed, true);
    assert.equal(seen.evaluation.slot.evidenceClass, 'active');
    assertTypedFrom(seen.evaluation.denial, outcome);
    assert.equal(seen.admin.code, outcome.code);
    assert.equal(seen.admin.cause, outcome.reason);
    assert.equal(seen.readiness.ready, false);
    // ... and before the rename it saw none: a run staged but not yet activated (nothing written) yields no denial from another process either.
    const quietWorld = makeWorld(t);
    quietWorld.stageSlot('alpha');
    const unseen = runProbeSync({ ...probeOptions, workspaceRoot: quietWorld.root, deadlineMs: 300 });
    assert.equal(unseen.observed, false);
    assert.equal(unseen.evaluation.slot.evidenceClass, 'missing');
    assert.equal(unseen.evaluation.denial, null);
});

test('NW1.S-only-validated-active-evidence-yields-a-typed-denial', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slotFresh = () => staged(world);
    const expectClass = (label, expectedClass, { denial: wantDenial = false, nowMs } = {}) => {
        const got = evaluate(world, nowMs === undefined ? {} : { nowMs });
        assert.equal(got.evidenceClass, expectedClass, `${label}: class`);
        assert.equal(got.denial !== null, wantDenial, `${label}: denial`);
        if (!wantDenial) assert.equal(got.result.denials.size, 0, `${label}: no denial for any route`);
        return got;
    };
    assert.deepEqual(EVIDENCE_CLASSES, ['missing', 'pending', 'succeeded', 'succeeded-unowned', 'unowned', 'failed-generic', 'invalid', 'active']);

    // missing (and its informational past-grace label): never a denial.
    let slot = slotFresh();
    expectClass('missing within the grace', 'missing', { nowMs: slot.runStartedAtMs + slot.startupGraceMs });
    assert.equal(evaluate(world, { nowMs: slot.runStartedAtMs + slot.startupGraceMs }).result.diagnostics[0].label, undefined);
    const past = expectClass('missing past the grace', 'missing', { nowMs: slot.runStartedAtMs + slot.startupGraceMs + 1 });
    assert.equal(past.result.diagnostics[0].label, 'missing-past-grace', 'the label is diagnostic only');

    // own pid: starting, running, failed without an outcome.
    slot = slotFresh(); world.writeWorker('alpha', slot, { kind: 'starting' });
    expectClass('pending', 'pending');
    slot = slotFresh(); world.writeWorker('alpha', slot, { kind: 'running' });
    expectClass('succeeded', 'succeeded');
    slot = slotFresh(); world.writeWorker('alpha', slot, { kind: 'generic' });
    expectClass('failed-generic', 'failed-generic');

    // no own pid: running (the Watchdog rebind), starting, failed (with and without a typed outcome).
    slot = slotFresh(); world.writeWorker('alpha', slot, { kind: 'running' });
    world.rewriteStatus(slot, (document) => { delete document.pid; });
    expectClass('succeeded-unowned', 'succeeded-unowned');
    slot = slotFresh(); world.writeWorker('alpha', slot, { kind: 'starting' });
    world.rewriteStatus(slot, (document) => { delete document.pid; });
    expectClass('unowned starting', 'unowned');
    slot = slotFresh(); world.writeWorker('alpha', slot, { kind: 'hardware' });
    world.rewriteStatus(slot, (document) => { delete document.pid; });
    expectClass('unowned failed with a typed outcome', 'unowned');
    slot = slotFresh(); world.writeWorker('alpha', slot, { kind: 'generic' });
    world.rewriteStatus(slot, (document) => { delete document.pid; });
    expectClass('unowned failed', 'unowned');

    // invalid: each variant of an otherwise active status.
    const invalid = {
        'unparseable JSON': () => '{not json',
        'a JSON array': () => '[]',
        'a status of another instance': (document) => { document.instanceId = 'other-instance'; },
        'a status of another run': (document) => { document.runId = uuid(); },
        'a status of another enable generation': (document) => { document.enableGeneration = 'other-generation'; },
        'a status of another wave': (document) => { document.waveIndex = 7; },
        'a status of another run start': (document) => { document.runStartedAtMs += 1; },
        'a status of another route': (document) => { document.routeKey = 'beta'; },
        'a status of another container': (document) => { document.containerName = 'ploinky_fixtures_beta'; },
        'an unknown state': (document) => { document.state = 'weird'; },
        'a non-integer pid': (document) => { document.pid = '12'; },
        'a zero pid': (document) => { document.pid = 0; },
        'a bad outcome': (document) => { document.error.hardwareOutcome = { garbage: true }; },
        'an outcome code that differs from the status code': (document) => { document.error.code = 'SOMETHING_ELSE'; },
        'an outcome for another key': 'other-key',
        'a finishedAt that is not the ISO of its milliseconds': (document) => { document.finishedAt = 'yesterday'; },
        'a zero finishedAtMs': (document) => { document.finishedAtMs = 0; document.finishedAt = new Date(0).toISOString(); },
        'a fractional finishedAtMs': (document) => { document.finishedAtMs += 0.5; },
        'unordered timestamps (T3)': (document) => {
            document.sequencePhaseStartedAtMs = document.finishedAtMs + 10;
            document.sequencePhaseStartedAt = new Date(document.sequencePhaseStartedAtMs).toISOString();
        },
    };
    for (const [label, change] of Object.entries(invalid)) {
        slot = slotFresh();
        if (change === 'other-key') {
            world.writeWorker('alpha', slot, { kind: 'hardware', outcome: refusalOutcome('ploinky_fixtures_other', { ref: 'fixtures/other' }) });
        } else {
            world.writeWorker('alpha', slot, { kind: 'hardware' });
            world.rewriteStatus(slot, change);
        }
        expectClass(label, 'invalid');
    }
    slot = slotFresh(); world.writeWorker('alpha', slot, { kind: 'hardware' });
    const elsewhere = path.join(world.root, 'elsewhere.json');
    fs.copyFileSync(world.statusPath(slot), elsewhere);
    fs.rmSync(world.statusPath(slot));
    fs.symlinkSync(elsewhere, world.statusPath(slot));
    expectClass('a symlink at the status path', 'invalid');
    slot = slotFresh(); fs.mkdirSync(world.statusPath(slot));
    expectClass('a directory at the status path', 'invalid');
    slot = slotFresh(); fs.writeFileSync(world.statusPath(slot), `{"pad":"${'x'.repeat(300 * 1024)}"}`);
    expectClass('an oversize status', 'invalid');

    // active: the only typed class.
    slot = slotFresh(); world.writeWorker('alpha', slot, { kind: 'hardware' });
    const active = expectClass('active', 'active', { denial: true });
    assertTypedFrom(active.denial, alphaOutcome());
    assert.equal(active.result.denials.size, 1, 'only the slotted route is denied');
    // An unslotted status is never read or activated: gamma has an activation on disk but no slot.
    const gammaSlot = slotFor('gamma', { key: containerOf('gamma'), runStartedAtMs: RUN_STARTED_AT_MS });
    world.writeWorker('gamma', gammaSlot, { kind: 'hardware' });
    const unslotted = countingFs();
    const scanned = world.resolve({ cache: fresh(), fsApi: unslotted.api });
    assert.equal(scanned.denials.has('gamma'), false, 'an unslotted status activates nothing');
    assert.equal(unslotted.count('readdirSync'), 0, 'the status directory is never listed');
    assert.ok(!unslotted.calls.some((call) => call.op === 'openSync' && call.target === world.statusPath(gammaSlot)), 'an unslotted status is never opened');

    // T4 is time-dependent and is applied per capture: a finish in the future is invalid, then active once its time has come.
    slot = slotFresh();
    const finishedAtMs = RUN_STARTED_AT_MS + 120_000;
    world.writeWorker('alpha', slot, { kind: 'hardware', finishedAtMs });
    const shared = fresh();
    assert.equal(evaluate(world, { nowMs: finishedAtMs - 1001, cache: shared }).evidenceClass, 'invalid', 'now + 1001: T4');
    assert.equal(world.resolve({ nowMs: finishedAtMs - 1001, cache: shared }).slots.get('alpha').evidenceClass, 'invalid');
    assert.equal(world.resolve({ nowMs: finishedAtMs - 1000, cache: shared }).slots.get('alpha').evidenceClass, 'active', 'now + 1000 is the boundary');
    assert.equal(world.resolve({ nowMs: finishedAtMs + 5000, cache: shared }).slots.get('alpha').evidenceClass, 'active');
});

test('NW1.S-obsolete-run-and-superseded-slot-writes-are-ignored', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const first = staged(world);
    // A late write of an earlier run (its own file name) is never read once the slot names a newer run.
    const second = staged(world);
    world.writeWorker('alpha', first, { kind: 'hardware', reason: 'OLD RUN CAUSE' });
    assert.ok(fs.existsSync(world.statusPath(first)));
    let got = evaluate(world);
    assert.equal(got.denial, null, 'the superseded run\'s activation is ignored');
    assert.equal(got.evidenceClass, 'missing');
    assert.equal(got.result.slots.get('alpha').runId, second.runId);
    // An old run's document dropped into the current slot's file name does not match the slot identity.
    world.writeWorker('alpha', first, { kind: 'hardware', reason: 'OLD RUN CAUSE' });
    fs.copyFileSync(world.statusPath(first), world.statusPath(second));
    got = evaluate(world);
    assert.equal(got.denial, null);
    assert.equal(got.evidenceClass, 'invalid');
    // The current run's own activation wins, with its own cause.
    fs.rmSync(world.statusPath(second));
    world.writeWorker('alpha', second, { kind: 'hardware', reason: 'CURRENT RUN CAUSE' });
    got = evaluate(world);
    assert.equal(got.denial.reason, 'CURRENT RUN CAUSE');
    assert.equal(got.result.slots.get('alpha').runId, second.runId);
    // A slot superseded later (a new start) is again judged only on its own file.
    const third = staged(world);
    got = evaluate(world);
    assert.equal(got.denial, null);
    assert.equal(got.evidenceClass, 'missing');
    assert.equal(got.result.slots.get('alpha').runId, third.runId);
});

test('NW1.S-slots-apply-only-to-the-captured-current-tuple-and-target-less-route', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slot = staged(world);
    world.writeWorker('alpha', slot, { kind: 'hardware' });
    assertTypedFrom(evaluate(world).denial, alphaOutcome());

    // A rotated tuple: the captured generation names another instance, so the slot does not apply.
    const original = world.readAgents();
    const rotated = JSON.parse(JSON.stringify(original));
    rotated[containerOf('alpha')].instanceId = 'alpha-instance-2';
    world.writeAgents(rotated);
    world.apply('rotated-instance');
    let got = evaluate(world);
    assert.equal(got.denial, null, 'rotated instance');
    assert.equal(got.evidenceClass, null, 'a non-applicable slot is not reported');
    rotated[containerOf('alpha')].instanceId = original[containerOf('alpha')].instanceId;
    rotated[containerOf('alpha')].enableGeneration = 'alpha-generation-2';
    world.writeAgents(rotated);
    world.apply('rotated-enable-generation');
    assert.equal(evaluate(world).denial, null, 'rotated enable generation');
    world.writeAgents(original);
    world.apply('restored-tuple');
    assertTypedFrom(evaluate(world).denial, alphaOutcome());

    // A route that names another container.
    const routing = world.readRouting();
    const keep = JSON.parse(JSON.stringify(routing));
    routing.routes.alpha.container = 'ploinky_fixtures_renamed';
    world.writeRouting(routing);
    addRenamedContainer(world);
    world.apply('other-container');
    assert.equal(evaluate(world).denial, null, 'the route names another container');
    world.writeRouting(keep);

    // A targeted route (the agent runs with a runtime target): the run succeeded first.
    world.writeWorker('alpha', slot, { kind: 'running' });
    const targeted = JSON.parse(JSON.stringify(keep));
    targeted.routes.alpha.hostPort = 43111;
    world.writeRouting(targeted);
    world.apply('targeted');
    got = evaluate(world);
    assert.equal(got.denial, null, 'a targeted route is never denied from the store');
    assert.equal(got.evidenceClass, null);
    // A late activation written after success, on a route that has since gained a target.
    world.writeWorker('alpha', slot, { kind: 'hardware', reason: 'LATE CAUSE' });
    assert.equal(evaluate(world).denial, null, 'a late write after success never denies a route with a target');

    // A removed agent.
    const removed = JSON.parse(JSON.stringify(keep));
    delete removed.routes.alpha;
    world.writeRouting(removed);
    const agents = world.readAgents();
    delete agents[containerOf('alpha')];
    world.writeAgents(agents);
    world.apply('removed');
    assert.equal(evaluate(world).denial, null, 'a removed agent');
    assert.equal(evaluate(world).result.slots.size, 0);
});

test('NW1.S-per-capture-cost-is-bounded-and-change-keyed', (t) => {
    quiet(t);
    // 256 applicable slots whose evidence has not been written: one lstat each, no read.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwr-cost-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    initializeFreshEdgeRoutingSources({ workspaceRoot: root });
    const paths = resolveEdgeGenerationPaths({ workspaceRoot: root });
    const runningDir = path.join(root, '.ploinky', 'running');
    const statusDir = path.join(runningDir, 'no-wait');
    fs.mkdirSync(statusDir, { recursive: true });
    const names = Array.from({ length: 256 }, (_, index) => `s${index}`);
    const slots = Object.fromEntries(names.map((name) => [name, slotFor(name)]));
    commit(root, paths, { expectedRevision: readHardwareAvailabilityPolicy({ paths }).revision, slots });
    const generationFor = ({ targeted = false } = {}) => ({
        agents: Object.fromEntries(names.map((name) => [containerOf(name), { instanceId: `${name}-instance`, enableGeneration: `${name}-generation` }])),
        routing: { routes: Object.fromEntries(names.map((name) => [name, { container: containerOf(name), ...(targeted ? { hostPort: 40000 } : {}) }])) },
    });
    const generation = generationFor();
    const spy = countingFs();
    const cache = fresh();
    const underStatus = (target) => typeof target === 'string' && target.startsWith(statusDir);
    const run = () => resolveEffectiveHardwareAvailability({ generation, paths, runningDir, nowMs: Date.now(), fsApi: spy.api, cache });

    let result = run();
    assert.equal(result.slots.size, 256);
    assert.equal(spy.count('lstatSync', underStatus), 256, 'one lstat per applicable slot');
    assert.equal(spy.count('openSync', underStatus), 0, 'no evidence is read when none exists');
    assert.equal(spy.count('openSync', (target) => target === paths.availabilityPolicyFile), 1, 'the first capture reads the store once');
    spy.reset();
    result = run();
    assert.equal(spy.count('lstatSync', underStatus), 256);
    assert.ok(spy.count('lstatSync') <= 256 + 3, `at most 256 evidence lstats plus the three-stat store key (${spy.count('lstatSync')})`);
    assert.equal(spy.count('openSync'), 0, 'zero reads when nothing changed');
    assert.equal(spy.count('readSync'), 0);
    assert.equal(spy.count('readdirSync'), 0, 'never a directory listing');

    // Three files appear: one read each, then none while unchanged.
    for (const name of ['s3', 's9', 's200']) fs.writeFileSync(path.join(statusDir, slots[name].statusFile), '{"x":1}');
    spy.reset();
    run();
    assert.equal(spy.count('openSync', underStatus), 3, 'one read per changed file');
    spy.reset();
    run();
    assert.equal(spy.count('openSync'), 0, 'unchanged evidence is not re-read');
    // One of them changes in place: exactly one more read.
    fs.writeFileSync(path.join(statusDir, slots.s9.statusFile), '{"x":2222}');
    spy.reset();
    run();
    assert.equal(spy.count('openSync', underStatus), 1, 'only the changed file is re-read');
    // A committed policy change re-reads the store once.
    commit(root, paths, { expectedRevision: readHardwareAvailabilityPolicy({ paths }).revision, entries: { s1: entryFor('s1') } });
    spy.reset();
    run();
    assert.equal(spy.count('openSync', (target) => target === paths.availabilityPolicyFile), 1, 'a changed store is re-read once');
    spy.reset();
    run();
    assert.equal(spy.count('openSync', (target) => target === paths.availabilityPolicyFile), 0);

    // All routes targeted: no evidence lstat at all.
    const targetedGeneration = generationFor({ targeted: true });
    spy.reset();
    const targeted = resolveEffectiveHardwareAvailability({ generation: targetedGeneration, paths, runningDir, nowMs: Date.now(), fsApi: spy.api, cache });
    assert.equal(targeted.slots.size, 0);
    assert.equal(spy.count('lstatSync', underStatus), 0, 'no evidence lstat when every route has a target');
    assert.equal(targeted.denials.size, 0);

    // The cache follows changes: an activation appears at the next capture, with no stale answer.
    const world = makeWorld(t);
    const slot = staged(world);
    const worldCache = fresh();
    const counting = countingFs();
    const worldRun = () => world.resolve({ cache: worldCache, fsApi: counting.api });
    assert.equal(worldRun().denials.size, 0);
    world.writeWorker('alpha', slot, { kind: 'starting' });
    assert.equal(worldRun().slots.get('alpha').evidenceClass, 'pending');
    counting.reset();
    worldRun();
    assert.equal(counting.count('openSync', (target) => target?.startsWith(world.statusDir)), 0);
    world.writeWorker('alpha', slot, { kind: 'hardware' });
    assert.equal(worldRun().denials.size, 1, 'a changed file is seen at the next capture');
    counting.reset();
    worldRun();
    assert.equal(counting.count('openSync', (target) => target?.startsWith(world.statusDir)), 0, 'and not re-read after that');
    world.removeStatus(slot);
    assert.equal(worldRun().denials.size, 0, 'a deletion is seen at the next capture');
});

test('NW1.S-the-resolver-discloses-only-the-validated-outcome', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slot = staged(world);
    const secrets = ['SECRET-MESSAGE-4711', 'SECRET-STACK-4711', 'SECRET-LOG-TAIL-4711', 'SECRET-DETAIL-4711', 'SECRET-TOP-LEVEL-4711'];
    world.writeWorker('alpha', slot, {
        kind: 'hardware',
        errorExtra: { message: secrets[0], stack: secrets[1], runtimeLogTail: secrets[2], readinessDetail: secrets[3] },
        statusExtra: { note: secrets[4], env: { TOKEN: secrets[4] } },
    });
    const got = evaluate(world);
    assertTypedFrom(got.denial, alphaOutcome());
    const serialized = JSON.stringify({
        denials: [...got.result.denials], projections: [...got.result.projections], slots: [...got.result.slots], diagnostics: got.result.diagnostics,
    });
    for (const secret of secrets) assert.ok(!serialized.includes(secret), `${secret} must not appear in the resolver output`);
    // The projection carries exactly the validated outcome and the slot's identity.
    assert.deepEqual(JSON.parse(JSON.stringify(got.projection.problem)), JSON.parse(JSON.stringify(alphaOutcome())));
    assert.equal(got.projection.instanceId, slot.instanceId);
    assert.equal(got.projection.enableGeneration, slot.enableGeneration);
});

test('NW1.S-manifest-drift-and-restoration-neither-clear-nor-create-an-activation', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const manifest = path.join(world.ploinkyDir, 'repos', 'fixtures', 'alpha', 'manifest.json');
    const original = fs.readFileSync(manifest);
    const spy = countingFs();
    const run = () => world.resolve({ cache: fresh(), fsApi: spy.api });
    const drift = () => fs.writeFileSync(manifest, JSON.stringify({ routerAccess: { httpRoutes: [] }, drifted: true }));
    const restore = () => fs.writeFileSync(manifest, original);

    // Before T_vis: no evidence. Drift and restoration create nothing.
    const missing = staged(world);
    drift();
    assert.equal(run().denials.size, 0, 'drift before any evidence');
    restore();
    assert.equal(run().denials.size, 0, 'restoration before any evidence');

    // After T_vis: an activation, then drift and restoration neither clear nor change it.
    world.writeWorker('alpha', missing, { kind: 'hardware' });
    const baseline = run();
    assertTypedFrom(baseline.denials.get('alpha'), alphaOutcome());
    drift();
    const drifted = run();
    assert.equal(drifted.revision, baseline.revision, 'drift does not clear the activation');
    assert.deepEqual([...drifted.denials], [...baseline.denials]);
    restore();
    const restored = run();
    assert.equal(restored.revision, baseline.revision, 'restoration does not change it');

    // A non-active class stays non-denying through drift and restoration.
    const pending = staged(world);
    world.writeWorker('alpha', pending, { kind: 'starting' });
    drift();
    assert.equal(run().denials.size, 0);
    restore();
    assert.equal(run().denials.size, 0);

    // The resolver reads only status evidence and the store: never a manifest, routing or agents source.
    // No marker, no canonical status, no listing: only the slots' own run-scoped files and the store.
    const opened = spy.calls.filter((call) => call.op === 'openSync' || call.op === 'readFileSync').map((call) => call.target);
    assert.ok(opened.length > 0);
    const allowed = new Set([world.statusPath(missing), world.statusPath(pending), world.paths.availabilityPolicyFile, world.paths.availabilityWitnessFile]);
    for (const target of opened) assert.ok(allowed.has(target), `unexpected read of ${target}`);
    assert.equal(spy.count('readdirSync'), 0);
});

test('NW1.S-an-unlatched-activation-whose-status-disappears-becomes-generic-fail-closed', async (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slot = staged(world);
    world.writeWorker('alpha', slot, { kind: 'hardware' });
    assertTypedFrom(evaluate(world).denial, alphaOutcome());
    // The unlatched activation's status disappears: generic at once, with no grace and no hardware code.
    world.removeStatus(slot);
    for (const nowMs of [slot.runStartedAtMs + 1, slot.runStartedAtMs + slot.startupGraceMs, slot.runStartedAtMs + slot.startupGraceMs + 60_000]) {
        const got = evaluate(world, { nowMs });
        assert.equal(got.denial, null, `no denial at ${nowMs}`);
        assert.equal(got.evidenceClass, 'missing');
        assert.equal(got.result.denials.size, 0);
    }
    // The cached evaluation is not sticky either.
    const cache = fresh();
    world.writeWorker('alpha', slot, { kind: 'hardware' });
    assert.equal(world.resolve({ cache }).denials.size, 1);
    world.removeStatus(slot);
    assert.equal(world.resolve({ cache }).denials.size, 0, 'a deleted unlatched activation does not keep its denial');
    // Rewritten to a non-activating status: the same.
    world.writeWorker('alpha', slot, { kind: 'hardware' });
    assert.equal(world.resolve({ cache }).denials.size, 1);
    world.rewriteStatus(slot, (document) => { document.state = 'starting'; delete document.error; });
    assert.equal(world.resolve({ cache }).denials.size, 0);

    // The route stays target-less and nothing is forwarded: the generic answers, no hardware code.
    const req = request();
    const plan = resolveEdgeRoutePlan({ req, listener: 'public' });
    assert.equal(plan.kind, 'agent-root-pending');
    assert.equal(plan.target, null);
    assert.equal(plan.hardwareAvailability, undefined);
    const api = await dispatch(req, plan);
    assert.equal(api.res.statusCode, 503);
    assert.doesNotMatch(api.res.body, /hardware/i);
});

test('NW1.S-pid-less-or-invalid-evidence-yields-the-generic-disposition', async (t) => {
    quiet(t);
    const world = makeWorld(t);
    const variants = {
        'a pid-less typed failure (the parent spawn-failure status)': (slot) => {
            world.writeWorker('alpha', slot, { kind: 'hardware' });
            world.rewriteStatus(slot, (document) => { delete document.pid; });
        },
        'a pid-less starting status': (slot) => {
            world.writeWorker('alpha', slot, { kind: 'starting' });
            world.rewriteStatus(slot, (document) => { delete document.pid; });
        },
        'a typed failure with a bad outcome': (slot) => {
            world.writeWorker('alpha', slot, { kind: 'hardware' });
            world.rewriteStatus(slot, (document) => { document.error.hardwareOutcome.state = 'exploded'; });
        },
        'a typed failure of another run': (slot) => {
            world.writeWorker('alpha', slot, { kind: 'hardware' });
            world.rewriteStatus(slot, (document) => { document.runId = uuid(); });
        },
        'a status that is not JSON': (slot) => {
            fs.writeFileSync(world.statusPath(slot), 'not json at all');
        },
    };
    for (const [label, build] of Object.entries(variants)) {
        const slot = staged(world);
        build(slot);
        const got = evaluate(world);
        assert.equal(got.denial, null, label);
        assert.equal(got.result.denials.size, 0, label);
        assert.ok(['unowned', 'invalid'].includes(got.evidenceClass), `${label}: ${got.evidenceClass}`);
        const req = request();
        const plan = resolveEdgeRoutePlan({ req, listener: 'public' });
        assert.equal(plan.hardwareAvailability, undefined, label);
        assert.equal(plan.target, null, label);
        const { res } = await dispatch(req, plan);
        assert.equal(res.statusCode, 503, label);
        assert.doesNotMatch(res.body, /hardware/i, label);
    }
});

test('NW1.S-no-store-denial-arises-without-validated-active-evidence-or-a-committed-entry', (t) => {
    quiet(t);
    // Healthy-agent guard: histories the system itself produces never deny.
    const world = makeWorld(t);
    const histories = {
        'a target-less success (network none: no hostPort)': (slot) => world.writeWorker('alpha', slot, { kind: 'running' }),
        'a target-less success with a returned port of zero': (slot) => {
            world.writeWorker('alpha', slot, { kind: 'running', statusExtra: { hostPort: 0 } });
        },
        'a Watchdog rebind (pid-less running)': (slot) => {
            world.writeWorker('alpha', slot, { kind: 'running' });
            world.rewriteStatus(slot, (document) => { delete document.pid; });
        },
        'a success whose status was later deleted': (slot) => {
            world.writeWorker('alpha', slot, { kind: 'running' });
            world.removeStatus(slot);
        },
        'a generic failure': (slot) => world.writeWorker('alpha', slot, { kind: 'generic' }),
        'a slow first status (none yet)': () => {},
        'a first status still starting': (slot) => world.writeWorker('alpha', slot, { kind: 'starting' }),
        'a failure with a typed outcome of another route key': (slot) => {
            world.writeWorker('alpha', slot, { kind: 'hardware', outcome: refusalOutcome('ploinky_fixtures_beta', { ref: 'fixtures/beta' }) });
        },
    };
    for (const [label, build] of Object.entries(histories)) {
        const slot = staged(world);
        build(slot);
        for (const nowMs of [slot.runStartedAtMs + 1, slot.runStartedAtMs + slot.startupGraceMs + 1]) {
            const got = evaluate(world, { nowMs });
            assert.equal(got.denial, null, `${label} at ${nowMs}`);
            assert.equal(got.result.denials.size, 0, label);
            assert.equal(got.result.projections.size, 0, label);
        }
    }
    // No slot and no entry: nothing at all. A slot of a route that has a target: nothing.
    const empty = makeWorld(t);
    assert.equal(empty.resolve({ cache: fresh() }).denials.size, 0);
    assert.equal(empty.resolve({ cache: fresh() }).revision, evaluate(empty).result.revision);
    // A committed entry is the second and last source of a typed denial.
    empty.commitStore({ entries: { alpha: entryFor('alpha') } });
    assertTypedFrom(evaluate(empty).denial, alphaOutcome('Hardware limits are off for this workspace.'));
});

test('NW1.S-entries-apply-only-to-current-target-less-routes-and-yield-to-a-newer-applicable-slot', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const entry = entryFor('alpha');
    world.commitStore({ entries: { alpha: entry } });
    const outcome = alphaOutcome('Hardware limits are off for this workspace.');
    assertTypedFrom(evaluate(world).denial, outcome);
    assert.equal(evaluate(world).evidenceClass, null, 'an entry is not a slot');

    // Not current: the captured generation names a rotated tuple.
    const agents = world.readAgents();
    const rotated = JSON.parse(JSON.stringify(agents));
    rotated[containerOf('alpha')].enableGeneration = 'alpha-generation-2';
    world.writeAgents(rotated);
    world.apply('rotated');
    assert.equal(evaluate(world).denial, null, 'a rotated tuple');
    world.writeAgents(agents);
    // Not target-less: the route gained a runtime target.
    const routing = world.readRouting();
    const targeted = JSON.parse(JSON.stringify(routing));
    targeted.routes.alpha.hostPort = 43111;
    world.writeRouting(targeted);
    world.apply('targeted');
    assert.equal(evaluate(world).denial, null, 'a targeted route');
    // Not the route's container.
    const other = JSON.parse(JSON.stringify(routing));
    other.routes.alpha.container = 'ploinky_fixtures_renamed';
    world.writeRouting(other);
    addRenamedContainer(world);
    world.apply('renamed-container');
    assert.equal(evaluate(world).denial, null, 'another container');
    world.writeRouting(routing);
    world.apply('restored');
    assertTypedFrom(evaluate(world).denial, outcome);

    // A newer applicable slot decides, and the entry is suppressed.
    const slot = world.stageSlot('alpha');
    assert.equal(evaluate(world).denial, null, 'a pending newer slot suppresses the entry');
    assert.equal(evaluate(world).evidenceClass, 'missing');
    world.writeWorker('alpha', slot, { kind: 'starting' });
    assert.equal(evaluate(world).denial, null);
    world.writeWorker('alpha', slot, { kind: 'running' });
    assert.equal(evaluate(world).denial, null, 'a succeeded newer slot suppresses the entry');
    world.writeWorker('alpha', slot, { kind: 'hardware', reason: 'NEWER CAUSE' });
    const decided = evaluate(world);
    assert.equal(decided.evidenceClass, 'active');
    assert.equal(decided.denial.reason, 'NEWER CAUSE', 'the slot\'s cause, not the entry\'s');
    // The entry of another route is untouched by alpha's slot.
    world.commitStore({ entries: { ...world.store().entries, gamma: entryFor('gamma') } });
    assert.equal(world.resolve({ cache: fresh() }).denials.get('gamma').key, containerOf('gamma'));
});

test('NW1.S-visible-but-not-durable-evidence-activates', (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slot = staged(world);
    const failing = spyFs({
        fsyncSync: (descriptor, resolved) => {
            fs.fsyncSync(descriptor);
            if (resolved === world.statusDir) throw fsError('EIO');
        },
    });
    const report = world.writeWorker('alpha', slot, { kind: 'hardware', fsApi: failing.api });
    // The write side reports visible-but-not-durable and credits no durability time.
    assert.equal(report.durabilityError, 'EIO');
    assert.equal(report.durableAtMs, undefined);
    assert.ok(Number.isSafeInteger(report.visibleAtMs));
    // The resolver side: the visible status activates the denial regardless.
    const got = evaluate(world);
    assert.equal(got.evidenceClass, 'active');
    assertTypedFrom(got.denial, alphaOutcome());
});
