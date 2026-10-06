// M-NW-01 D2-S: the frozen v1 `slots` schema of the hardware-availability policy,
// and start's staging of slots (the shared planner in its `staging` and `resolve`
// modes, one D1 commit, parent-known nodes without a slot). The latcher is a
// separate slice.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { publishNoWaitRunMarker, retireNoWaitRunMarkers } from '../../cli/commands/noWaitMarkerLifecycle.js';
import {
    HARDWARE_AVAILABILITY_RESOLVE_REVISION_CHANGED,
    commitNoWaitAvailabilitySlotPlan,
    planNoWaitAvailabilitySlots,
    stageNoWaitAvailabilitySlots,
} from '../../cli/commands/noWaitAvailabilitySlots.js';
import { retireDestroyedBoxNoWaitMarkers } from '../../ploinky-box/noWaitCleanup.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { initializeFreshEdgeRoutingSources, withEdgeGenerationApplyLock } from '../../cli/sandbox/edgeGeneration.js';
import { readHardwareAvailabilityPolicy } from '../../cli/sandbox/hardwareAvailabilityStore.mjs';
import { SCHEMA, commit, entryFor, makeWorkspace, sha256, slotFor, uuid } from './hardwareAvailabilityFixtures.mjs';
import { createHardwareAvailabilityResolverCache } from '../../cli/server/hardwareAvailabilityResolver.mjs';
import { RUN_STARTED_AT_MS, containerOf, makeWorld } from './hardwareAvailabilityResolverFixtures.mjs';

const UNREADABLE = 'HARDWARE_AVAILABILITY_POLICY_UNREADABLE';
const readStore = (paths) => readHardwareAvailabilityPolicy({ paths });

// The revision formula, computed independently of the implementation.
function independentStable(value) {
    if (Array.isArray(value)) return value.map(independentStable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, independentStable(value[key])]));
    return value;
}
const independentRevision = ({ schema, storeId, entries, slots }) => `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(independentStable({ schema, storeId, entries, slots }))).digest('hex')}`;

function newStore(t, entries = { alpha: entryFor('alpha') }) {
    const workspace = makeWorkspace(t);
    initializeFreshEdgeRoutingSources({ workspaceRoot: workspace.root });
    commit(workspace.root, workspace.paths, { expectedRevision: readStore(workspace.paths).revision, entries });
    return workspace;
}

// A required case is one leaf test; a failing variant is named in its message.
const inVariant = (label, run) => {
    try { return run(); } catch (error) {
        if (error instanceof Error) error.message = `[${label}] ${error.message}`;
        throw error;
    }
};

test('NW1.S-frozen-v1-slot-schema-and-cross-field-rules-refuse-without-a-partial-write', async (t) => {
    // Accepted: the full frozen shape, with the revision over {schema, storeId, entries, slots}.
    const ok = newStore(t);
    const slots = { beta: slotFor('beta', { startupGraceMs: 0 }), gamma: slotFor('gamma', { startupGraceMs: 300000 }) };
    const committed = commit(ok.root, ok.paths, { expectedRevision: readStore(ok.paths).revision, slots });
    assert.equal(committed.committed, true);
    const read = readStore(ok.paths);
    assert.deepEqual(read.slots, slots);
    assert.deepEqual(Object.keys(read.entries), ['alpha']);
    const file = JSON.parse(fs.readFileSync(ok.paths.availabilityPolicyFile, 'utf8'));
    assert.deepEqual(Object.keys(file).sort(), ['entries', 'revision', 'schema', 'slots', 'storeId']);
    assert.equal(file.schema, SCHEMA);
    assert.equal(file.revision, independentRevision(file));
    assert.notEqual(file.revision, independentRevision({ ...file, slots: {} }), 'the slots are part of the revision');
    // An entry and a slot of one route with different run ids coexist.
    const alphaSlot = slotFor('alpha');
    commit(ok.root, ok.paths, { expectedRevision: read.revision, slots: { ...slots, alpha: alphaSlot } });
    assert.equal(readStore(ok.paths).slots.alpha.runId, alphaSlot.runId);

    const mutate = (change) => () => { const slot = slotFor('beta'); change(slot); return { beta: slot }; };
    const refused = {
        '257 slots': [() => Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`s${index}`, slotFor(`s${index}`)])), 'HARDWARE_AVAILABILITY_POLICY_FULL'],
        'an unsupported extra key': [mutate((slot) => { slot.extra = 1; })],
        'a missing key': [mutate((slot) => { delete slot.waveIndex; })],
        'a key with a path separator': [() => ({ beta: slotFor('beta', { key: '../beta', statusFile: `../beta.${uuid()}.json` }) })],
        'an empty key': [mutate((slot) => { slot.key = ''; })],
        'an instance id equal to the enable generation': [mutate((slot) => { slot.enableGeneration = slot.instanceId; })],
        'an unsafe instance id': [mutate((slot) => { slot.instanceId = 'has space'; })],
        'a non-canonical run id (upper case)': [mutate((slot) => { slot.runId = slot.runId.toUpperCase(); slot.statusFile = `${slot.key}.${slot.runId}.json`; })],
        'a run id that is not a uuid': [mutate((slot) => { slot.runId = 'run-1'; slot.statusFile = `${slot.key}.run-1.json`; })],
        'a status file that is not key.runId.json': [mutate((slot) => { slot.statusFile = 'other.json'; })],
        'a wave index over the protocol bound': [mutate((slot) => { slot.waveIndex = 1024; })],
        'a negative run start': [mutate((slot) => { slot.runStartedAtMs = -1; })],
        'a missing startupGraceMs': [mutate((slot) => { delete slot.startupGraceMs; })],
        'a negative startupGraceMs': [mutate((slot) => { slot.startupGraceMs = -1; })],
        'a startupGraceMs over the protocol bound': [mutate((slot) => { slot.startupGraceMs = 300001; })],
        'a fractional startupGraceMs': [mutate((slot) => { slot.startupGraceMs = 1.5; })],
        'a string startupGraceMs': [mutate((slot) => { slot.startupGraceMs = '60'; })],
        'two slots for one key': [() => ({ beta: slotFor('beta', { key: 'ploinky_fixtures_beta' }), betaTwo: slotFor('betaTwo', { key: 'ploinky_fixtures_beta' }) })],
        'a reserved route key': [() => JSON.parse(`{"__proto__": ${JSON.stringify(slotFor('beta'))}}`)],
        'a slot that is not an object': [() => ({ beta: 'slot' })],
    };
    for (const [label, [build, code = 'HARDWARE_AVAILABILITY_POLICY_INVALID']] of Object.entries(refused)) {
        inVariant(label, () => {
            const workspace = newStore(t);
            const bytes = sha256(workspace.paths.availabilityPolicyFile);
            assert.throws(() => commit(workspace.root, workspace.paths, { expectedRevision: readStore(workspace.paths).revision, slots: build() }), (error) => error.code === code, label);
            assert.equal(sha256(workspace.paths.availabilityPolicyFile), bytes, 'the old policy is intact');
            assert.deepEqual(fs.readdirSync(workspace.paths.availabilityStoreDir), ['policy.json'], 'no temp and no partial write');
        });
    }

    inVariant('an entry and a slot of one route sharing a run id', () => {
        const sharedRun = uuid();
        const workspace = newStore(t, { alpha: entryFor('alpha', { runId: sharedRun }) });
        const bytes = sha256(workspace.paths.availabilityPolicyFile);
        assert.throws(() => commit(workspace.root, workspace.paths, {
            expectedRevision: readStore(workspace.paths).revision,
            slots: { alpha: slotFor('alpha', { runId: sharedRun }) },
        }), (error) => error.code === 'HARDWARE_AVAILABILITY_POLICY_INVALID' && /share a run id/.test(error.message));
        assert.equal(sha256(workspace.paths.availabilityPolicyFile), bytes);
        assert.deepEqual(fs.readdirSync(workspace.paths.availabilityStoreDir), ['policy.json']);
    });

    // A policy file edited by hand is judged by the same rules, even with a recomputed revision.
    inVariant('the reader refuses hand-written violations with a valid revision', () => {
        for (const damage of [
            (document) => { delete document.slots.beta.startupGraceMs; },
            (document) => { document.slots.beta.startupGraceMs = 300001; },
            (document) => { document.slots.alpha = slotFor('alpha', { runId: document.entries.alpha.source.runId }); },
        ]) {
            const workspace = newStore(t);
            commit(workspace.root, workspace.paths, { expectedRevision: readStore(workspace.paths).revision, slots: { beta: slotFor('beta') } });
            const document = JSON.parse(fs.readFileSync(workspace.paths.availabilityPolicyFile, 'utf8'));
            damage(document);
            document.revision = independentRevision(document);
            fs.writeFileSync(workspace.paths.availabilityPolicyFile, JSON.stringify(document));
            assert.throws(() => readStore(workspace.paths), (error) => error.code === UNREADABLE);
        }
    });
});


// ---------------------------------------------------------------- staging (D2S.4) and the shared planner

const GRACE_MS = 60000;
const quiet = (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
};
const logged = (t) => {
    const lines = [];
    return { lines, log: (type, data) => lines.push({ type, ...data }) };
};

function newSlot(world, routeKey, overrides = {}) {
    return slotFor(routeKey, { key: containerOf(routeKey), runStartedAtMs: RUN_STARTED_AT_MS, ...overrides });
}

// start's bound no-wait schedule for the given runs (one wave).
function scheduleOf(world, slots) {
    return [Object.entries(slots).map(([routeKey, slot]) => ({
        registryName: slot.key,
        node: { id: `fixtures/${routeKey}` },
        statusFile: world.statusPath(slot),
        identity: world.identityOf(routeKey, slot),
    }))];
}

// The real staging entry point (one commit under the apply lock) for the runs start is about to spawn.
function stage(world, slots = {}, extra = {}) {
    return stageNoWaitAvailabilitySlots({
        schedule: scheduleOf(world, slots), workspaceRoot: world.root, startupGraceMs: GRACE_MS, runningDir: world.runningDir, ...extra,
    });
}

// The shared planner in resolve mode, exactly as the latcher will call it.
function resolveNow(world, extra = {}) {
    return withEdgeGenerationApplyLock((applyLockCapability) => commitNoWaitAvailabilitySlotPlan({
        mode: 'resolve', workspaceRoot: world.root, applyLockCapability, runningDir: world.runningDir, ...extra,
    }), { workspaceRoot: world.root });
}

function renameSpy(world) {
    const renames = [];
    const api = { ...fs, constants: fs.constants, renameSync: (from, to) => { renames.push(to); return fs.renameSync(from, to); } };
    return { api, policyRenames: () => renames.filter((target) => target === world.paths.availabilityPolicyFile).length };
}

const freshEvaluation = (world) => world.resolve({ cache: createHardwareAvailabilityResolverCache() });
const denialOf = (world, routeKey = 'alpha') => freshEvaluation(world).denials.get(routeKey) || null;
const policyBytes = (world) => sha256(world.paths.availabilityPolicyFile);

test('NW1.S-staging-and-latch-resolution-follow-newer-run-precedence', async (t) => {
    quiet(t);
    // R1 ran and was refused (its cause is E1 once resolved); R2 is the next run of the same, retained tuple.
    async function afterFirstRun(reason = 'first cause') {
        const world = makeWorld(t);
        const s1 = newSlot(world, 'alpha');
        await stage(world, { alpha: s1 });
        assert.deepEqual(Object.keys(world.store().slots), ['alpha']);
        world.writeWorker('alpha', s1, { kind: 'hardware', reason });
        assert.equal(denialOf(world).reason, reason, 'S1 is active: a typed denial');
        return { world, s1 };
    }
    // (iv) and staging itself: the next start latches the active retained slot and adds R2's slot in ONE rename.
    {
        const { world, s1 } = await afterFirstRun();
        const s2 = newSlot(world, 'alpha');
        const spy = renameSpy(world);
        await stage(world, { alpha: s2 }, { fsApi: spy.api });
        assert.equal(spy.policyRenames(), 1, 'latch, retire and add are one rename');
        const store = world.store();
        assert.equal(store.entries.alpha.source.runId, s1.runId, 'S1 was latched into an entry');
        assert.match(JSON.stringify(store.entries.alpha.projection), /first cause/);
        assert.equal(store.slots.alpha.runId, s2.runId, 'R2 has its own slot, S1 is retired');
        assert.equal(store.slots.alpha.startupGraceMs, GRACE_MS);
        assert.equal(denialOf(world), null, 'R2 is missing: the newer applicable slot suppresses E1');
        world.writeWorker('alpha', s2, { kind: 'starting' });
        assert.equal(denialOf(world), null, '(iv) R2 pending: E1 suppressed');
    }
    // (ii) R2 succeeds target-less: S2 suppresses E1 and the resolution retires both, in one rename.
    {
        const { world } = await afterFirstRun();
        const s2 = newSlot(world, 'alpha');
        await stage(world, { alpha: s2 });
        world.writeWorker('alpha', s2, { kind: 'running' });
        const spy = renameSpy(world);
        const resolved = await resolveNow(world, { fsApi: spy.api });
        assert.equal(spy.policyRenames(), 1);
        assert.deepEqual(resolved.plan.resolutions.map((entry) => [entry.routeKey, entry.resolution]), [['alpha', 'retired']]);
        assert.deepEqual([world.store().entries, world.store().slots], [{}, {}], 'S2 and E1 are both retired');
        assert.equal(denialOf(world), null);
    }
    // (ii-b) the same resolution through the NEXT start's staging.
    {
        const { world } = await afterFirstRun();
        const s2 = newSlot(world, 'alpha');
        await stage(world, { alpha: s2 });
        world.writeWorker('alpha', s2, { kind: 'running' });
        await stage(world, {});
        assert.deepEqual([world.store().entries, world.store().slots], [{}, {}]);
    }
    // (iii) R2 is refused: R2's cause, not a conflict, and E2 replaces E1.
    {
        const { world } = await afterFirstRun('first cause');
        const s2 = newSlot(world, 'alpha');
        await stage(world, { alpha: s2 });
        world.writeWorker('alpha', s2, { kind: 'hardware', reason: 'second cause' });
        assert.equal(denialOf(world).reason, 'second cause', 'the newer active slot decides');
        const spy = renameSpy(world);
        await resolveNow(world, { fsApi: spy.api });
        assert.equal(spy.policyRenames(), 1);
        const store = world.store();
        assert.deepEqual(Object.keys(store.slots), []);
        assert.equal(store.entries.alpha.source.runId, s2.runId, 'E2 replaced E1');
        assert.match(JSON.stringify(store.entries.alpha.projection), /second cause/);
        assert.equal(denialOf(world).reason, 'second cause');
    }
    // (v) R2 fails generically: no denial, and E1 is retired.
    {
        const { world } = await afterFirstRun();
        const s2 = newSlot(world, 'alpha');
        await stage(world, { alpha: s2 });
        world.writeWorker('alpha', s2, { kind: 'generic' });
        await resolveNow(world);
        assert.deepEqual([world.store().entries, world.store().slots], [{}, {}]);
        assert.equal(denialOf(world), null);
    }
    // (i) R2 succeeds with a hostPort: no denial (E1 is gated by the target), and the next staging retires S2 and E1.
    {
        const { world } = await afterFirstRun();
        const s2 = newSlot(world, 'alpha');
        await stage(world, { alpha: s2 });
        const routing = world.readRouting();
        routing.routes.alpha.hostPort = 43111;
        world.writeRouting(routing);
        const agents = world.readAgents();
        agents[containerOf('alpha')] = { ...agents[containerOf('alpha')], runtime: 'podman', containerId: 'c'.repeat(64) };
        world.writeAgents(agents);
        world.apply('alpha-publishes-a-target');
        assert.equal(denialOf(world), null, 'a targeted route is never denied by a committed entry');
        assert.ok(world.store().entries.alpha, 'E1 is still committed before the next resolution');
        await stage(world, {});
        assert.deepEqual([world.store().entries, world.store().slots], [{}, {}], 'E1 is retired at resolution');
    }
    // Stale entries (a rotated tuple) are retired by staging; a current entry stays when nothing resolves; an identical plan writes nothing.
    {
        const world = makeWorld(t);
        world.commitStore({ entries: { alpha: entryFor('alpha', { instanceId: 'rotated-instance' }), gamma: entryFor('gamma') } });
        const spy = renameSpy(world);
        await stage(world, {}, { fsApi: spy.api });
        assert.deepEqual(Object.keys(world.store().entries), ['gamma'], 'the rotated-tuple entry is retired, the current one stays');
        assert.equal(spy.policyRenames(), 1);
        const bytes = policyBytes(world);
        await stage(world, {}, { fsApi: spy.api });
        assert.equal(spy.policyRenames(), 1, 'an unchanged plan commits nothing');
        assert.equal(policyBytes(world), bytes);
        assert.equal(denialOf(world, 'gamma').key, containerOf('gamma'));
    }
});

test('NW1.S-parent-known-nodes-get-no-slot-and-pid-less-statuses-never-activate', async (t) => {
    quiet(t);
    const world = makeWorld(t);
    const alpha = newSlot(world, 'alpha');
    const gamma = newSlot(world, 'gamma');
    // The parent settled alpha from graph metadata: it is not in the spawn set and gets no slot.
    await stage(world, { alpha, gamma }, { isParentKnown: (entry) => entry.identity.routeKey === 'alpha' });
    assert.deepEqual(Object.keys(world.store().slots), ['gamma'], 'only the spawned run has a slot');
    // A typed status for alpha, which has no slot, activates nothing.
    world.writeWorker('alpha', alpha, { kind: 'hardware' });
    assert.equal(denialOf(world), null, 'alpha has no slot, so its status is never evidence');
    // A pid-less terminal status for a slotted run never activates and the shared planner never latches it.
    world.writeWorker('gamma', gamma, { kind: 'hardware' });
    world.rewriteStatus(gamma, (document) => { delete document.pid; });
    assert.equal(denialOf(world, 'gamma'), null, 'pid-less evidence yields no denial');
    const bytes = policyBytes(world);
    await resolveNow(world);
    assert.equal(policyBytes(world), bytes, 'resolve never latches pid-less evidence');
    assert.ok(world.store().slots.gamma, 'the slot is kept, still unresolved');
});

test('NW1.S-a-resolve-commit-never-changes-the-effective-revision', async (t) => {
    quiet(t);
    const cases = {
        'an active slot is latched': (world, slot) => world.writeWorker('alpha', slot, { kind: 'hardware' }),
        'a succeeded slot with an older same-tuple entry is retired with it': (world, slot) => {
            world.commitStore({ entries: { alpha: entryFor('alpha') } });
            world.writeWorker('alpha', slot, { kind: 'running' });
        },
        'a failed-generic slot is retired': (world, slot) => world.writeWorker('alpha', slot, { kind: 'generic' }),
        'an active slot replaces an older entry of another run': (world, slot) => {
            world.commitStore({ entries: { alpha: entryFor('alpha', { reason: 'older cause' }) } });
            world.writeWorker('alpha', slot, { kind: 'hardware', reason: 'newer cause' });
        },
    };
    for (const [label, arrange] of Object.entries(cases)) {
        const world = makeWorld(t);
        const slot = world.stageSlot('alpha', { runStartedAtMs: RUN_STARTED_AT_MS });
        arrange(world, slot);
        const before = freshEvaluation(world);
        const { result, effectiveRevision } = resolveNow(world);
        const after = freshEvaluation(world);
        assert.equal(result.committed, true, label);
        assert.equal(effectiveRevision.before, effectiveRevision.after, label);
        assert.equal(before.revision, after.revision, `${label}: the revision a capture sees is unchanged by the commit`);
        assert.deepEqual([...before.denials.keys()], [...after.denials.keys()], label);
        assert.deepEqual(Object.keys(world.store().slots), [], `${label}: the slot was resolved`);
    }
    // A forced plan that would change the effective revision aborts and keeps the state.
    {
        const world = makeWorld(t);
        const slot = world.stageSlot('alpha', { runStartedAtMs: RUN_STARTED_AT_MS });
        world.writeWorker('alpha', slot, { kind: 'hardware' });
        const bytes = policyBytes(world);
        const { lines, log } = logged(t);
        const dropsTheDenial = (input) => ({ ...planNoWaitAvailabilitySlots(input), resolved: { entries: {}, slots: {} } });
        assert.throws(() => withEdgeGenerationApplyLock((applyLockCapability) => commitNoWaitAvailabilitySlotPlan({
            mode: 'resolve', workspaceRoot: world.root, applyLockCapability, runningDir: world.runningDir, plan: dropsTheDenial, log,
        }), { workspaceRoot: world.root }), { code: HARDWARE_AVAILABILITY_RESOLVE_REVISION_CHANGED });
        assert.equal(policyBytes(world), bytes, 'nothing was committed');
        assert.deepEqual(lines.map((line) => line.type), ['hardware_availability_resolve_aborted']);
        assert.ok(world.store().slots.alpha, 'the slot is still staged');
    }
});

test('NW1.S-marker-retirement-box-cleanup-and-watchdog-documents-never-erase-an-activation', async (t) => {
    quiet(t);
    const world = makeWorld(t);
    const slot = world.stageSlot('alpha', { runStartedAtMs: RUN_STARTED_AT_MS });
    world.writeWorker('alpha', slot, { kind: 'hardware' });
    const identity = world.identityOf('alpha', slot);
    const marker = path.join(world.statusDir, `${slot.key}.current.json`);
    const revision = () => freshEvaluation(world).revision;
    const baseline = revision();
    assert.equal(denialOf(world).key, slot.key);
    const statusBytes = sha256(world.statusPath(slot));
    // The Watchdog's rebind binds a replacement back to the run: a marker and a pid-less `running` canonical document.
    publishNoWaitRunMarker(identity, { runningDir: world.runningDir });
    fs.writeFileSync(path.join(world.statusDir, `${slot.key}.json`), JSON.stringify({ state: 'running', containerName: slot.key }));
    assert.equal(revision(), baseline, 'publishing a marker and a canonical document changes nothing');
    // The real marker retirement used by enable, disable and start.
    retireNoWaitRunMarkers([slot.key], { runningDir: world.runningDir });
    assert.equal(fs.existsSync(marker), false, 'the marker is retired');
    assert.equal(revision(), baseline, 'retiring the marker never erases the activation');
    // The destroyed Box's marker cleanup, in its own child process.
    publishNoWaitRunMarker(identity, { runningDir: world.runningDir });
    const boxIdentity = buildWorkspaceIdentity(world.root, { markerFound: true });
    retireDestroyedBoxNoWaitMarkers({ identity: boxIdentity, lock: { assertHeld() {} } });
    assert.equal(fs.existsSync(marker), false, 'the Box cleanup retired the marker');
    assert.equal(revision(), baseline, 'the Box cleanup never erases the activation');
    assert.equal(sha256(world.statusPath(slot)), statusBytes, 'the run-scoped status is untouched');
    assert.equal(denialOf(world).key, slot.key);
});
