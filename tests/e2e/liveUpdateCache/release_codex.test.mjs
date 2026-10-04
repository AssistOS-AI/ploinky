import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestFixture, installPureGuards, H } from './test_support_codex.mjs';
import { validateManifest } from './manifest_codex.mjs';
import { expectedLiveFromManifest } from './live_admission_codex.mjs';
import { createReleasePhases, functionalRecord } from './release_codex.mjs';
import { REQUIRED_GATES } from './contracts_codex.mjs';
installPureGuards();

function releaseManifestFrom(manifest, patch = () => {}) {
    const release = structuredClone(manifest), runId = 'update-cache-20261004T123000Z-feedc0de_codex', root = `/home/skutner/work/evidence/${runId}`;
    Object.assign(release, { runId }); release.evidence = { root, functional: `${root}/functional_codex.json`, release: `${root}/release_codex.json`, receipt: `${root}/receipt_codex.json`, sourceManifest: `${root}/sources_codex.json` };
    release.box = { ...release.box, id: H('box-release'), startedAt: '2026-10-04T12:29:50Z' }; release.workspace = { ...release.workspace, ino: 4242 };
    release.negativeScopes = { optional: `${release.workspace.path}/UpdateE2E-${runId}`, required: `${release.workspace.path}/UpdateE2E-${runId}` };
    release.epochs.functional = { ...release.epochs.functional, boxId: release.box.id, startedAt: release.box.startedAt }; release.grant = { ...release.grant, startsAtMs: release.grant.startsAtMs, endsAtMs: release.grant.endsAtMs + 3600000 };
    patch(release); return validateManifest(release);
}

function build({ faults = {}, patch } = {}) {
    const { value: manifest } = manifestFixture(), release = releaseManifestFrom(manifest, patch), calls = []; let wall = Date.parse('2026-10-04T12:30:30Z');
    const observedFor = (m, generation = 'g-1', tag = 0) => { const expected = expectedLiveFromManifest(m);
        return { hostPlatform: 'linux', engine: 'podman', rootless: true, running: true, initialized: true, activeGeneration: generation, pendingActivation: false, recoveryBarrier: false, workspace: { ...expected.workspace }, box: { ...expected.box },
            candidate: structuredClone(expected.candidate), publications: expected.publications, sourceMounts: expected.sourceMounts, engineIdentity: expected.engineIdentity,
            graph: m.graph.map(entry => ({ name: entry.name, graphGeneration: generation, running: true, runtimeId: `r${tag}`, instanceId: 'i', enableGeneration: 'e', ready: faults.notReady !== true, externalHealth: true, noWaitState: null })) }; };
    let gateIndex = 0, observeCalls = 0;
    const ports = { release: { async load() { calls.push('load'); return release; },
            observerFor: m => ({ admit: async () => { calls.push('admit'); return { phase: 'U0', admitted: true, activeGeneration: 'g-1', runtimes: 1 }; },
                observe: async () => { calls.push('observe'); observeCalls += 1;
                    const generation = faults.driftOnObserve === observeCalls ? 'g-drift' : `g-${1 + (faults.generationMoves ?? []).filter(n => n <= gateIndex).length}`;
                    const observed = observedFor(m, generation, (faults.runtimeReplacedAfter ?? []).filter(n => n <= gateIndex).length + (faults.runtimeDriftOnObserve === observeCalls ? 100 : 0)); if (faults.boxChangesAfterGate !== undefined && gateIndex === faults.boxChangesAfterGate) observed.box.id = H('other-box'); return observed; } }) },
        gates: { async run(gate) { calls.push(`gate:${gate}`); gateIndex += 1; wall += 1000; const base = { name: gate, runId: `r-${gate}`, discovered: 1, passed: 1, failed: 0, skipped: 0, retries: 0, ignoredErrors: 0, closed: true, startedAt: new Date(wall).toISOString(), finishedAt: new Date(wall + 500).toISOString() };
            return faults.skipGate === gate ? { ...base, passed: 0, skipped: 1 } : base; } },
        browser: { async close() { calls.push('browser-close'); return { closed: true }; }, openContexts: () => faults.openContext ? 1 : 0 }, custody: { snapshot: () => [{ settled: faults.unsettled !== true }] },
        fixture: { state: () => ({ prepared: faults.fixtureLeft === true, container: null }) } };
    const functionalObserved = observedFor(manifest);
    const state = { functional: functionalRecord({ manifest, observed: functionalObserved, finishedAt: '2026-10-04T12:20:00.000Z', frozen: true, cleanupComplete: true }) }; Object.assign(state, faults.stateOverride ?? {});
    const ctx = { manifest, ports, state, check() {}, wallNow: () => wall, latchClean: () => faults.latchDirty !== true };
    return { manifest, release, calls, ports, state, ctx, phases: createReleasePhases(ctx), advance: ms => { wall += ms; } };
}

test('a fresh release fixture over the same pushed commit map and image is admitted and the gates run in fixed order with before and after proof', async () => {
    const h = build(); const u7c = await h.phases.U7c(); assert.deepEqual(u7c, { phase: 'U7c', fresh: true, workspaceRecreated: true, sameCandidate: true, sameImage: true, generation: 'g-1', browserGateCredit: 0 });
    const u8 = await h.phases.U8(); assert.deepEqual(u8.gates.map(gate => gate.name), REQUIRED_GATES); assert.deepEqual(h.calls.filter(call => call.startsWith('gate:')), REQUIRED_GATES.map(gate => `gate:${gate}`));
    assert.ok(h.state.gates.every(gate => gate.before.boxId === h.release.box.id && gate.after.boxId === h.release.box.id && gate.before.workspaceIdentity === gate.after.workspaceIdentity));
    const u9 = await h.phases.U9(); assert.deepEqual(u9, { phase: 'U9', browserClosed: true, unsettledCommands: 0, openContexts: 0, ownedServer: 'absent', ownedFiles: 'absent' });
    assert.equal(h.calls.filter(call => call === 'admit').length, 1, 'the fresh deployment is admitted from scratch exactly once before any gate');
});

test('U7c refuses a release epoch that is not a different Box over a recreated workspace with the identical candidate and image', async () => {
    const cases = [
        ['same Box ID', r => { r.box.id = H('box'); r.epochs.functional.boxId = r.box.id; }, 'release-fixture-not-fresh'],
        ['same workspace identity', r => { r.workspace.ino = 99; }, 'release-fixture-not-fresh'],
        ['start before the functional epoch ended', r => { r.box.startedAt = '2026-10-04T12:10:00Z'; r.epochs.functional.startedAt = r.box.startedAt; }, 'release-fixture-not-fresh'],
        ['another image', r => { r.box.imageId = H('other-image'); r.epochs.functional.imageId = r.box.imageId; r.epochs.release.sameImageId = r.box.imageId; }, 'candidate-epoch-mismatch'],
        ['another pushed commit', r => { const repo = r.candidate.repositories[1]; repo.commit = H('moved').slice(0, 40); repo.pushedCommit = repo.commit; repo.defaultCommit = repo.commit; }, 'candidate-epoch-mismatch'],
    ];
    for (const [label, patch, code] of cases) {
        const h = build({ patch }); await assert.rejects(h.phases.U7c(), error => error.code === code, label); assert.equal(h.calls.some(call => call.startsWith('gate:')), false, label);
    }
    const shared = build(); shared.release.evidence.root = shared.manifest.evidence.root; await assert.rejects(shared.phases.U7c(), error => error.code === 'release-manifest-binding');
    const sameRun = build(); sameRun.release.runId = sameRun.manifest.runId; await assert.rejects(sameRun.phases.U7c(), error => error.code === 'release-manifest-binding');
    await assert.rejects(build({ faults: { stateOverride: { functional: null } } }).phases.U7c(), error => error.code === 'functional-epoch-missing');
    for (const bad of [{ cleanupComplete: false }, { frozen: false }]) {
        const h = build(); h.state.functional = functionalRecord({ manifest: h.manifest, observed: { workspace: { dev: 1, ino: 99 }, candidate: { repositories: [] } }, finishedAt: '2026-10-04T12:20:00.000Z', ...{ frozen: true, cleanupComplete: true }, ...bad });
        await assert.rejects(h.phases.U7c(), error => error.code === 'functional-epoch-unsettled', JSON.stringify(bad));
    }
});

test('release gates refuse an unready fixture, a changed outer Box, a skipped gate and expired validity without renewal', async () => {
    await assert.rejects(async () => { const h = build({ faults: { notReady: true } }); await h.phases.U7c(); }, error => error.code === 'graph-not-ready');
    for (const after of [1, 3]) { const changed = build({ faults: { boxChangesAfterGate: after } }); await changed.phases.U7c(); await assert.rejects(changed.phases.U8(), error => error.code === 'live-binding-mismatch' || error.code === 'box-binding-invalid', `after gate ${after}`); }
    const skipped = build({ faults: { skipGate: 'OnlyOffice' } }); await skipped.phases.U7c(); await assert.rejects(skipped.phases.U8(), error => error.code === 'canonical-gate-invalid'); assert.equal(skipped.calls.includes('gate:WebMeet'), false);
    const late = build(); await late.phases.U7c(); late.advance(200000); await assert.rejects(late.phases.U8(), error => error.code === 'box-freshness-insufficient'); assert.equal(late.calls.some(call => call.startsWith('gate:')), false);
    const aged = build({ patch: r => { r.box.imageCreatedAt = '2026-10-04T07:00:00Z'; } }); await aged.phases.U7c(); await assert.rejects(aged.phases.U8(), error => error.code === 'image-freshness-insufficient');
});

test('the epoch may move only inside the OnlyOffice bracket: generation and runtime tuples hold across Copilot, between gates and across WebMeet', async () => {
    const run = async faults => { const h = build({ faults }); await h.phases.U7c(); await h.phases.U8(); return h; };
    // Observation order after U7c: Copilot before(2) after(3); OnlyOffice before(4) after(5) refresh(6); WebMeet before(7) after(8).
    const allowed = await run({ generationMoves: [2], runtimeReplacedAfter: [2] });
    assert.deepEqual(allowed.state.gates.map(gate => [gate.before.generation, gate.after.generation]), [['g-1', 'g-1'], ['g-1', 'g-2'], ['g-2', 'g-2']]);
    assert.notEqual(allowed.state.gates[1].after.runtimes[0][1], allowed.state.gates[1].before.runtimes[0][1], 'the targeted restart replaced the runtime inside its bracket');
    assert.equal(allowed.state.gates[2].before.runtimes[0][1], allowed.state.gates[1].after.runtimes[0][1], 'WebMeet starts from the refreshed epoch');
    for (const [label, faults] of [['generation moves during Copilot', { generationMoves: [1] }], ['generation moves during WebMeet', { generationMoves: [3] }], ['runtime replaced during Copilot', { runtimeReplacedAfter: [1] }], ['runtime replaced during WebMeet', { runtimeReplacedAfter: [3] }],
        ['drift before OnlyOffice', { driftOnObserve: 4 }], ['unstable refresh after OnlyOffice', { driftOnObserve: 6 }], ['drift before WebMeet', { driftOnObserve: 7 }], ['drift after WebMeet', { driftOnObserve: 8 }], ['drift before Copilot', { driftOnObserve: 2 }],
        ['runtime-only drift in the OnlyOffice refresh', { runtimeDriftOnObserve: 6 }], ['runtime-only drift before WebMeet', { runtimeDriftOnObserve: 7 }], ['runtime-only drift before OnlyOffice', { runtimeDriftOnObserve: 4 }]]) {
        const h = build({ faults }); await h.phases.U7c(); await assert.rejects(h.phases.U8(), error => /canonical-epoch-changed|workspace-not-live|live-binding-mismatch/.test(error.code), label);
        if (label.includes('Copilot') || label.includes('before OnlyOffice')) assert.equal(h.calls.includes('gate:WebMeet'), false, label);
    }
});

test('U9 refuses any unsettled owned command, open browser context, remaining fixture or dirty run', async () => {
    for (const faults of [{ unsettled: true }, { openContext: true }, { fixtureLeft: true }]) { const h = build({ faults }); await assert.rejects(h.phases.U9(), error => error.code === 'owned-resource-unsettled'); }
    await assert.rejects(build({ faults: { latchDirty: true } }).phases.U9(), error => error.code === 'writers-not-quiescent');
});
