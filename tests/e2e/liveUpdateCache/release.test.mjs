import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestFixture, installPureGuards, generationManifest, H } from './test_support.mjs';
import { validateManifest } from './manifest.mjs';
import { expectedLiveFromManifest } from './live_admission.mjs';
import { createReleasePhases, functionalRecord } from './release.mjs';
import { gpuWiringIdentityOf } from './engine.mjs';
import { REQUIRED_GATES, RELEASE_GENERATIONS } from './contracts.mjs';
installPureGuards();

const R1_START = Date.parse('2026-10-04T12:29:50Z'), R2_START = Date.parse('2026-10-04T12:50:00Z');
const OO = 'AssistOSExplorer/onlyOffice', EX = 'AssistOSExplorer/explorer', OPTIONAL_NAMES = ['onlyOffice', 'webmeetScribeAgent', 'webmeetStt'].map(agent => `AssistOSExplorer/${agent}`);
const refusal = /canonical-epoch-changed|workspace-not-live|live-binding-mismatch/;

// A fabricated pair of release generations. `faults` flips single behaviours; observation numbers (per generation) are, for R1:
// U7c entry 1; Copilot before 2 and after 3. For R2: U7d entry 1; UA before 2, first post 3, second post 4; OnlyOffice before 5, after 6,
// refresh 7; WebMeet before 8 and after 9.
function build({ faults = {}, patch1, patch2, patchBase } = {}) {
    const { value: manifest } = manifestFixture(); patchBase?.(manifest);
    const r1 = validateManifest(generationManifest(manifest, 'R1', patch1)), r2 = validateManifest(generationManifest(manifest, 'R2', patch2)), calls = [];
    let wall = R1_START + 40000; const stage = { done: new Set(), observed: { R1: 0, R2: 0 } };
    const moves = faults.moves ?? ['UA'], hit = marker => stage.done.has(marker);
    const observedFor = (m, addedGraph, id) => { const expected = expectedLiveFromManifest(m, addedGraph), n = ++stage.observed[id];
        const generation = faults.driftOnObserve?.[id] === n ? 'g-drift' : `g-${1 + moves.filter(hit).length}`;
        const rowTag = name => (faults.replacedRows ?? []).filter(entry => hit(entry.after) && entry.rows.includes(name)).length + (faults.runtimeDriftOnObserve?.[id] === n ? 100 : 0);
        // The registry set is what the product actually holds: the default graph, plus the three optional agents once the activation ran,
        // plus whatever a fault adds. It is independent of which rows the observer is asked to project.
        const optionalNames = (m.activation ?? []).map(entry => entry.name), registry = [...m.graph.map(entry => entry.name), ...(id === 'R2' && (hit('UA') || faults.preActivated) ? optionalNames : []),
            ...(id === 'R1' ? (faults.r1Optional ?? []) : []), ...((faults.registryExtra?.[id] ?? []).filter(row => row.when === undefined || hit(row.when)).map(row => row.name))];
        const observed = { registryAgents: registry, hostPlatform: 'linux', engine: 'podman', rootless: true, running: true, initialized: true, activeGeneration: generation, pendingActivation: false, recoveryBarrier: false, workspace: { ...expected.workspace }, box: { ...expected.box },
            candidate: structuredClone(expected.candidate), publications: expected.publications, sourceMounts: expected.sourceMounts, engineIdentity: expected.engineIdentity,
            graph: expected.requiredGraph.map(entry => ({ name: entry.name, graphGeneration: generation, running: true, runtimeId: `r${rowTag(entry.name)}`, instanceId: 'i', enableGeneration: 'e', ready: faults.notReady?.[id] !== true, externalHealth: true, noWaitState: null })) };
        if (faults.boxChangesAfter?.[id] && hit(faults.boxChangesAfter[id])) observed.box.id = H('other-box'); return observed; };
    const ports = {
        release: { async load(role) { calls.push(`load:${role}`); return role === 'R1' ? r1 : r2; },
            observerFor: m => { const id = m.runId === r1.runId ? 'R1' : 'R2'; return { admit: async () => { calls.push(`admit:${id}`); return { phase: 'U0', admitted: true, activeGeneration: 'g-1', runtimes: 1 }; },
                observe: async ({ addedGraph } = {}) => { calls.push(`observe:${id}${addedGraph ? '+' : ''}`); return observedFor(m, addedGraph, id); } }; } },
        gates: { async run(gate) { calls.push(`gate:${gate}`); wall += 1000; const base = { name: gate, runId: `r-${gate}`, discovered: 1, passed: 1, failed: 0, skipped: 0, retries: 0, ignoredErrors: 0, closed: true, startedAt: new Date(wall).toISOString(), finishedAt: new Date(wall + 500).toISOString() };
            stage.done.add(gate); return faults.skipGate === gate ? { ...base, passed: 0, skipped: 1 } : base; } },
        activation: { async prepare() { calls.push('ua:prepare'); wall += faults.prepareMs ?? 30000; return { exitCode: 0, clean: true }; }, async start() { calls.push('ua:start'); return { runId: 'ua' }; },
            async execute() { calls.push('ua:execute'); wall += faults.activationMs ?? 457000; stage.done.add('UA'); return { exitCode: 0 }; }, async finish() { calls.push('ua:finish'); },
            async verify() { calls.push('ua:verify'); wall += faults.postMs ?? 0; if (faults.receiptInvalidAt === calls.filter(call => call === 'ua:verify').length) throw Object.assign(new Error('activation-receipt-invalid'), { code: 'activation-receipt-invalid' }); return { receiptSha256: H('receipt') }; } },
        browser: { async close() { calls.push('browser-close'); return { closed: true }; }, openContexts: () => faults.openContext ? 1 : 0 }, custody: { snapshot: () => [{ settled: faults.unsettled !== true }] },
        fixture: { state: () => ({ prepared: faults.fixtureLeft === true, container: null }) } };
    const functionalObserved = observedFor(manifest, undefined, 'R1'); stage.observed.R1 = 0;
    const state = { functional: functionalRecord({ manifest, observed: functionalObserved, finishedAt: '2026-10-04T12:20:00.000Z', frozen: true, cleanupComplete: true }) }; Object.assign(state, faults.stateOverride ?? {});
    const ctx = { manifest, ports, state, check() {}, wallNow: () => wall, latchClean: () => faults.latchDirty !== true };
    return { manifest, r1, r2, calls, ports, state, ctx, stage, phases: createReleasePhases(ctx), setWall: ms => { wall = ms; }, wallNow: () => wall, advance: ms => { wall += ms; } };
}
async function throughR1(h) { await h.phases.U7c(); await h.phases.U8a(); h.setWall(R2_START + 60000); }
async function throughUA(h) { await throughR1(h); await h.phases.U7d(); await h.phases.UA(); }
async function all(faults) { const h = build(typeof faults === 'object' && faults && !faults.faults ? { faults } : (faults ?? {})); await throughUA(h); await h.phases.U8b(); return h; }
const codeIs = code => error => error.code === code;

test('R1 admits an unactivated fresh Box and runs Copilot, then R2 is activated by UA and runs OnlyOffice and WebMeet, each gate with before and after proof of its own generation', async () => {
    const h = build(); const u7c = await h.phases.U7c();
    assert.deepEqual(u7c, { phase: 'U7c', fresh: true, workspaceRecreated: true, sameCandidate: true, sameImage: true, generation: 'g-1', boxName: h.r1.box.name, browserGateCredit: 0 });
    const u8a = await h.phases.U8a(); assert.deepEqual(u8a.gates.map(gate => gate.name), ['Copilot']); assert.deepEqual(h.calls.filter(call => call.startsWith('gate:')), ['gate:Copilot']);
    assert.equal(h.calls.some(call => call.startsWith('ua:')), false, 'R1 is never activated');
    const record = h.state.release1Record; assert.equal(record.boxId, h.r1.box.id); assert.equal(record.boxName, h.r1.box.name); assert.equal(record.imageId, h.r1.box.imageId); assert.equal(record.gpuGrantLabelPresent, true);
    assert.equal(record.copilotGate.before.boxId, h.r1.box.id); assert.equal(record.copilotGate.admission.generationRemainingMs, 570000); assert.equal(record.copilotGate.admission.campaignReserveMs, 4200000);
    h.setWall(R2_START + 60000);
    const u7d = await h.phases.U7d(); assert.deepEqual(u7d, { phase: 'U7d', fresh: true, workspaceRecreated: true, distinctFromR1: true, sameCandidate: true, sameImage: true, generation: 'g-1', boxName: h.r2.box.name, browserGateCredit: 0 });
    const ua = await h.phases.UA(); assert.equal(ua.activation.receiptSha256, H('receipt')); assert.deepEqual(ua.activation.install, { exitCode: 0, clean: true });
    assert.equal(ua.activation.before.runtimes.length + 3, ua.activation.after.runtimes.length); assert.notEqual(ua.activation.before.generation, ua.activation.after.generation, 'the edge generation moved inside the activation window');
    const u8b = await h.phases.U8b(); assert.deepEqual(u8b.gates.map(gate => gate.name), ['OnlyOffice', 'WebMeet']);
    assert.deepEqual(h.calls.filter(call => /^(gate|ua|load):/.test(call)), ['load:R1', 'gate:Copilot', 'load:R2', 'ua:prepare', 'ua:start', 'ua:execute', 'ua:finish', 'ua:verify', 'ua:verify', 'gate:OnlyOffice', 'ua:verify', 'gate:WebMeet'], 'the activation receipt is re-checked before each R2 gate');
    assert.deepEqual(h.state.gates.map(gate => gate.name), REQUIRED_GATES);
    assert.deepEqual(h.state.gates.map(gate => gate.before.boxId), [h.r1.box.id, h.r2.box.id, h.r2.box.id]); assert.deepEqual(h.state.gates.map(gate => gate.after.boxId), [h.r1.box.id, h.r2.box.id, h.r2.box.id]);
    assert.deepEqual(h.state.admissions.map(row => [row.gate, row.generationRemainingMs, row.campaignReserveMs]), [['Copilot', 570000, 4200000], ['OnlyOffice', 1020000, 1620000], ['WebMeet', 150000, 0]]);
    assert.ok(h.state.admissions.every(row => row.boxAgeMs >= 0 && row.imageAgeMs >= 0 && row.boxAgeMs + row.generationRemainingMs <= 1800000 && row.imageAgeMs + row.generationRemainingMs <= 14400000));
    assert.deepEqual(h.state.releaseGenerations.map(row => [row.id, row.boxId, row.boxName, row.imageId, row.gpuGrantLabelPresent]), [['R1', h.r1.box.id, h.r1.box.name, h.manifest.box.imageId, true], ['R2', h.r2.box.id, h.r2.box.name, h.manifest.box.imageId, true]]);
    assert.deepEqual(RELEASE_GENERATIONS.map(row => row.id), ['R1', 'R2']);
    const u9 = await h.phases.U9(); assert.deepEqual(u9, { phase: 'U9', browserClosed: true, unsettledCommands: 0, openContexts: 0, ownedServer: 'absent', ownedFiles: 'absent' });
    assert.equal(h.calls.filter(call => call === 'admit:R1').length, 1); assert.equal(h.calls.filter(call => call === 'admit:R2').length, 1, 'each fresh deployment is admitted from scratch exactly once before its gates');
});

test('an unlabelled generation is recorded as such and the label state is per generation', async () => {
    const h = await all({}); assert.equal(h.state.releaseGenerations[0].gpuGrantLabelPresent, true);
    const plain = build({ patch1: r => { r.engine.gpuWiringIdentity = gpuWiringIdentityOf({}); } }); await throughUA(plain); await plain.phases.U8b();
    assert.deepEqual(plain.state.releaseGenerations.map(row => row.gpuGrantLabelPresent), [false, true]);
});

test('U7c refuses a release epoch that is not a different Box over a recreated workspace with the identical candidate and image', async () => {
    const cases = [
        ['same Box ID', { patch1: r => { r.box.id = H('box'); r.epochs.functional.boxId = r.box.id; } }, 'release-fixture-not-fresh'],
        ['same workspace identity', { patch1: r => { r.workspace.ino = 99; } }, 'release-fixture-not-fresh'],
        ['start before the functional epoch ended', { patch1: r => { r.box.startedAt = '2026-10-04T12:10:00Z'; r.epochs.functional.startedAt = r.box.startedAt; } }, 'release-fixture-not-fresh'],
        ['another image', { patch1: r => { r.box.imageId = H('other-image'); r.epochs.functional.imageId = r.box.imageId; r.epochs.release.sameImageId = r.box.imageId; } }, 'release-candidate-mismatch'],
        ['another pushed commit', { patch1: r => { const repo = r.candidate.repositories[1]; repo.commit = H('moved').slice(0, 40); repo.pushedCommit = repo.commit; repo.defaultCommit = repo.commit; } }, 'release-candidate-mismatch'],
        ['R1 declaring an activation', { patch1: r => { r.activation = null; Object.assign(r, { activation: [] }); } }, 'activation-declaration'],
    ];
    for (const [label, options, code] of cases) {
        if (code === 'activation-declaration') { assert.throws(() => build(options), codeIs(code), label); continue; }
        const h = build(options); await assert.rejects(h.phases.U7c(), codeIs(code), label); assert.equal(h.calls.some(call => call.startsWith('gate:')), false, label);
    }
    const shared = build(); shared.r1.evidence.root = shared.manifest.evidence.root; await assert.rejects(shared.phases.U7c(), codeIs('release-manifest-binding'));
    const sameRun = build(); sameRun.r1.runId = sameRun.manifest.runId; await assert.rejects(sameRun.phases.U7c(), codeIs('release-manifest-binding'));
    const activated = build(); activated.r1.activation = structuredClone(activated.r2.activation); await assert.rejects(activated.phases.U7c(), codeIs('release-manifest-binding'));
    await assert.rejects(build({ faults: { stateOverride: { functional: null } } }).phases.U7c(), codeIs('functional-epoch-missing'));
    for (const bad of [{ cleanupComplete: false }, { frozen: false }]) {
        const h = build(); h.state.functional = functionalRecord({ manifest: h.manifest, observed: { workspace: { dev: 1, ino: 99 }, candidate: { repositories: [] } }, finishedAt: '2026-10-04T12:20:00.000Z', ...{ frozen: true, cleanupComplete: true }, ...bad });
        await assert.rejects(h.phases.U7c(), codeIs('functional-epoch-unsettled'), JSON.stringify(bad));
    }
});

test('U7d refuses an R2 that is not distinct from the functional epoch and R1, later than the Copilot gate, with the identical candidate and its own activation declaration', async () => {
    const cases = [
        ['R2 reuses the R1 Box', { patch2: r => { r.box.id = H('box-R1'); r.epochs.functional.boxId = r.box.id; } }, 'release-fixture-not-fresh'],
        ['R2 reuses the functional Box', { patch2: r => { r.box.id = H('box'); r.epochs.functional.boxId = r.box.id; } }, 'release-fixture-not-fresh'],
        ['R2 reuses the R1 workspace', { patch2: r => { r.workspace.ino = 4242; } }, 'release-fixture-not-fresh'],
        ['R2 reuses the functional workspace', { patch2: r => { r.workspace.ino = 99; } }, 'release-fixture-not-fresh'],
        ['R2 started before the Copilot gate finished', { patch2: r => { r.box.startedAt = '2026-10-04T12:30:00Z'; r.epochs.functional.startedAt = r.box.startedAt; } }, 'release-fixture-not-fresh'],
        ['another image', { patch2: r => { r.box.imageId = H('other-image'); r.epochs.functional.imageId = r.box.imageId; r.epochs.release.sameImageId = r.box.imageId; } }, 'release-candidate-mismatch'],
        ['another pushed commit', { patch2: r => { const repo = r.candidate.repositories[1]; repo.commit = H('moved').slice(0, 40); repo.pushedCommit = repo.commit; repo.defaultCommit = repo.commit; } }, 'release-candidate-mismatch'],
        ['no activation declaration', { patch2: r => { r.activation = null; } }, 'release-manifest-binding'],
        ['R2 not ready', { faults: { notReady: { R2: true } } }, 'graph-not-ready'],
    ];
    for (const [label, options, code] of cases) { const h = build(options); await throughR1(h); await assert.rejects(h.phases.U7d(), codeIs(code), label); assert.equal(h.calls.some(call => call.startsWith('ua:') || call === 'gate:OnlyOffice'), false, label); }
    const shared = build(); await throughR1(shared); shared.r2.evidence.root = shared.manifest.evidence.root; await assert.rejects(shared.phases.U7d(), codeIs('release-manifest-binding'));
    await assert.rejects(build().phases.U7d(), codeIs('release-epoch1-missing')); await assert.rejects(build({ faults: { stateOverride: { functional: null } } }).phases.U7d(), codeIs('release-epoch1-missing'));
});

test('AC-3 and AC-4 in the flow: R1 Copilot, R2 OnlyOffice and R2 WebMeet are admitted at their per-generation limit and refused one millisecond later', async () => {
    const copilot = async age => { const h = build(); await h.phases.U7c(); h.setWall(R1_START + age); return h; };
    await (await copilot(1230000)).phases.U8a(); const lateCopilot = await copilot(1230001); await assert.rejects(lateCopilot.phases.U8a(), codeIs('box-freshness-insufficient')); assert.equal(lateCopilot.calls.includes('gate:Copilot'), false);
    const oo = async age => { const h = build(); await throughUA(h); h.setWall(R2_START + age); return h; };
    await (await oo(780000)).phases.U8b(); const lateOO = await oo(780001); await assert.rejects(lateOO.phases.U8b(), codeIs('box-freshness-insufficient')); assert.equal(lateOO.calls.includes('gate:OnlyOffice'), false);
    // WebMeet is admitted on its own remaining work (150,000) after OnlyOffice has run.
    const wm = async limit => { const h = build({ faults: { postMs: 0 } }); await throughUA(h); h.setWall(R2_START + 780000); const run = h.ports.gates.run; h.ports.gates.run = async gate => { const row = await run(gate); if (gate === 'OnlyOffice') h.setWall(R2_START + limit); return row; }; return h; };
    await (await wm(1650000)).phases.U8b(); const lateWM = await wm(1650001); await assert.rejects(lateWM.phases.U8b(), codeIs('box-freshness-insufficient')); assert.equal(lateWM.calls.includes('gate:WebMeet'), false);
});

test('an activation that runs over its guard fails closed at the OnlyOffice admission and never starts the gate', async () => {
    const run = async activationMs => { const h = build({ faults: { activationMs, prepareMs: 30000, postMs: 60000 } }); await throughR1(h); h.setWall(R2_START + 150000); await h.phases.U7d(); await h.phases.UA(); return h; };
    await (await run(540000)).phases.U8b();
    const slow = await run(540001); await assert.rejects(slow.phases.U8b(), codeIs('box-freshness-insufficient')); assert.equal(slow.calls.includes('gate:OnlyOffice'), false);
});

test('UA is guarded before it launches and refuses a bad receipt before any R2 gate', async () => {
    const early = build(); await throughR1(early); early.setWall(R2_START + 150001); await early.phases.U7d(); await assert.rejects(early.phases.UA(), codeIs('activation-window-insufficient')); assert.equal(early.calls.some(call => call.startsWith('ua:')), false);
    const invalid = build({ faults: { receiptInvalidAt: 1 } }); await throughR1(invalid); await invalid.phases.U7d(); await assert.rejects(invalid.phases.UA(), codeIs('activation-receipt-invalid')); await assert.rejects(invalid.phases.U8b(), codeIs('activation-missing'));
    assert.equal(invalid.calls.some(call => call.startsWith('gate:') && call !== 'gate:Copilot'), false);
    const beforeUA = build(); await throughR1(beforeUA); await beforeUA.phases.U7d(); await assert.rejects(beforeUA.phases.U8b(), codeIs('activation-missing'));
    const restarted = build({ faults: { receiptInvalidAt: 3 } }); await throughUA(restarted); await assert.rejects(restarted.phases.U8b(), codeIs('activation-receipt-invalid'));
    assert.equal(restarted.calls.includes('gate:OnlyOffice'), true); assert.equal(restarted.calls.includes('gate:WebMeet'), false, 'a Box restart between the gates invalidates the proof before WebMeet');
    const first = build({ faults: { receiptInvalidAt: 2 } }); await throughUA(first); await assert.rejects(first.phases.U8b(), codeIs('activation-receipt-invalid')); assert.equal(first.calls.includes('gate:OnlyOffice'), false);
    const unreachable = build(); unreachable.state.r2 = undefined; await assert.rejects(unreachable.phases.UA(), codeIs('release-epoch2-missing'));
});

test('release gates refuse an unready fixture, a changed outer Box, a skipped gate and an aged campaign image without renewal', async () => {
    await assert.rejects(build({ faults: { notReady: { R1: true } } }).phases.U7c(), codeIs('graph-not-ready'));
    const changed = build({ faults: { boxChangesAfter: { R1: 'Copilot' } } }); await changed.phases.U7c(); await assert.rejects(changed.phases.U8a(), error => error.code === 'live-binding-mismatch' || error.code === 'box-binding-invalid');
    const changedR2 = build({ faults: { boxChangesAfter: { R2: 'OnlyOffice' } } }); await throughUA(changedR2); await assert.rejects(changedR2.phases.U8b(), error => error.code === 'live-binding-mismatch' || error.code === 'box-binding-invalid'); assert.equal(changedR2.calls.includes('gate:WebMeet'), false);
    const skipped = build({ faults: { skipGate: 'Copilot' } }); await skipped.phases.U7c(); await assert.rejects(skipped.phases.U8a(), codeIs('canonical-gate-invalid')); assert.equal(skipped.state.release1Record, undefined, 'no R1 record without a passed Copilot gate');
    const skippedOO = build({ faults: { skipGate: 'OnlyOffice' } }); await throughUA(skippedOO); await assert.rejects(skippedOO.phases.U8b(), codeIs('canonical-gate-invalid')); assert.equal(skippedOO.calls.includes('gate:WebMeet'), false);
    const late = build(); await late.phases.U7c(); late.advance(1200000); await assert.rejects(late.phases.U8a(), codeIs('box-freshness-insufficient')); assert.equal(late.calls.some(call => call.startsWith('gate:')), false);
    const aged = build({ patch1: r => { r.box.imageCreatedAt = '2026-10-04T08:00:00Z'; } }); await aged.phases.U7c(); await assert.rejects(aged.phases.U8a(), codeIs('campaign-image-window-insufficient')); assert.equal(aged.calls.includes('gate:Copilot'), false, 'B2 refuses before the Copilot launch');
    const agedR2 = build({ patch2: r => { r.box.imageCreatedAt = '2026-10-04T08:00:00Z'; } }); await throughR1(agedR2); await agedR2.phases.U7d(); await assert.rejects(agedR2.phases.UA(), codeIs('campaign-image-window-insufficient')); assert.equal(agedR2.calls.includes('ua:execute'), false, 'B3 refuses before UA-1');
});

test('the epoch may move only inside the declared windows: R1 and WebMeet hold exactly, UA admits the edge generation and the three runtimes, OnlyOffice may restart only itself', async () => {
    const allowed = await all({ moves: ['UA', 'OnlyOffice'], replacedRows: [{ after: 'OnlyOffice', rows: [OO] }] });
    assert.deepEqual(allowed.state.gates.map(gate => [gate.name, gate.before.generation, gate.after.generation]), [['Copilot', 'g-1', 'g-1'], ['OnlyOffice', 'g-2', 'g-3'], ['WebMeet', 'g-3', 'g-3']]);
    const rowOf = (index, side, name) => allowed.state.gates[index][side].runtimes.find(row => row[0] === name);
    assert.notEqual(rowOf(1, 'after', OO)[1], rowOf(1, 'before', OO)[1], 'the targeted restart replaced the OnlyOffice runtime inside its bracket'); assert.deepEqual(rowOf(1, 'after', EX), rowOf(1, 'before', EX), 'no other runtime moved');
    assert.deepEqual(rowOf(2, 'before', OO), rowOf(1, 'after', OO), 'WebMeet starts from the refreshed epoch');
    assert.equal(allowed.state.gates[1].before.runtimes.length, allowed.manifest.graph.length + allowed.r2.activation.length, 'R2 gates observe the default graph plus the three activated runtimes');
    await all({ moves: ['UA', 'OnlyOffice'] }); await all({ moves: [] });
    const runR2 = async faults => { const h = build({ faults }); await throughUA(h); await h.phases.U8b(); };
    for (const [label, faults] of [['non-OnlyOffice runtime replaced in the OnlyOffice window', { replacedRows: [{ after: 'OnlyOffice', rows: [EX] }] }], ['OnlyOffice and another runtime replaced together', { replacedRows: [{ after: 'OnlyOffice', rows: [OO, EX] }] }],
        ['OnlyOffice runtime replaced during WebMeet', { replacedRows: [{ after: 'WebMeet', rows: [OO] }] }], ['a default runtime replaced during the activation window', { replacedRows: [{ after: 'UA', rows: [EX] }] }]]) {
        await assert.rejects(runR2(faults), error => refusal.test(error.code) || error.code === 'activation-epoch-changed', label);
    }
    // A change that happens between two phases and then stays: only the comparison with the epoch last proved can see it.
    const stickyR1 = build({ faults: { replacedRows: [{ after: 'between', rows: [EX] }] } }); await stickyR1.phases.U7c(); stickyR1.stage.done.add('between'); await assert.rejects(stickyR1.phases.U8a(), codeIs('canonical-epoch-changed')); assert.equal(stickyR1.calls.includes('gate:Copilot'), false);
    const stickyR2 = build({ faults: { replacedRows: [{ after: 'between', rows: [EX] }] } }); await throughUA(stickyR2); stickyR2.stage.done.add('between'); await assert.rejects(stickyR2.phases.U8b(), codeIs('canonical-epoch-changed')); assert.equal(stickyR2.calls.includes('gate:OnlyOffice'), false);
    const stickyUA = build({ faults: { replacedRows: [{ after: 'between', rows: [EX] }] } }); await throughR1(stickyUA); await stickyUA.phases.U7d(); stickyUA.stage.done.add('between'); await assert.rejects(stickyUA.phases.UA(), codeIs('canonical-epoch-changed')); assert.equal(stickyUA.calls.includes('ua:execute'), false);
    for (const [label, faults] of [['generation moves during Copilot', { moves: ['Copilot'] }], ['generation moves during WebMeet', { moves: ['UA', 'WebMeet'] }],
        ['runtime replaced during Copilot', { replacedRows: [{ after: 'Copilot', rows: [EX] }] }], ['runtime replaced during WebMeet', { replacedRows: [{ after: 'WebMeet', rows: [EX] }] }]]) {
        const h = build({ faults }); await assert.rejects(async () => { await throughUA(h); await h.phases.U8b(); }, error => refusal.test(error.code), label);
    }
    for (const [label, faults, phase] of [['drift before Copilot', { driftOnObserve: { R1: 2 } }, 'R1'], ['drift after Copilot', { driftOnObserve: { R1: 3 } }, 'R1'], ['drift at the UA before-epoch', { driftOnObserve: { R2: 2 } }, 'R2'], ['drift at the first post-activation epoch', { driftOnObserve: { R2: 3 } }, 'R2'],
        ['unstable second post-activation epoch', { runtimeDriftOnObserve: { R2: 4 } }, 'R2'], ['drift before OnlyOffice', { driftOnObserve: { R2: 5 } }, 'R2'], ['unstable refresh after OnlyOffice', { driftOnObserve: { R2: 7 } }, 'R2'], ['drift before WebMeet', { driftOnObserve: { R2: 8 } }, 'R2'],
        ['drift after WebMeet', { driftOnObserve: { R2: 9 } }, 'R2'], ['runtime-only drift before OnlyOffice', { runtimeDriftOnObserve: { R2: 5 } }, 'R2'], ['runtime-only drift before WebMeet', { runtimeDriftOnObserve: { R2: 8 } }, 'R2']]) {
        const h = build({ faults }); await assert.rejects(async () => { await throughUA(h); await h.phases.U8b(); }, error => refusal.test(error.code), label); assert.ok(phase);
        if (/Copilot/.test(label)) assert.equal(h.calls.includes('load:R2'), false, label);
    }
});

test('N-A: agents outside the probed rows are observed through the registry set: R1 never carries an optional agent, R2 is not activated before UA and gains exactly three agents during it', async () => {
    const optional = ['AssistOSExplorer/onlyOffice'], all3 = OPTIONAL_NAMES;
    // R1 with an optional agent running is refused at admission, and when it appears later it is refused before the Copilot gate.
    const early = build({ faults: { r1Optional: optional } }); await assert.rejects(early.phases.U7c(), codeIs('release-graph-activated')); assert.equal(early.calls.some(call => call.startsWith('gate:')), false);
    const allOptional = build({ faults: { r1Optional: all3 } }); await assert.rejects(allOptional.phases.U7c(), codeIs('release-graph-activated'));
    const later = build({ faults: { registryExtra: { R1: [{ name: optional[0], when: 'between' }] } } }); await later.phases.U7c(); later.stage.done.add('between'); await assert.rejects(later.phases.U8a(), codeIs('release-graph-activated')); assert.equal(later.calls.includes('gate:Copilot'), false);
    // An unrelated extra agent on R1 is still an epoch change, not an activation.
    const stray = build({ faults: { registryExtra: { R1: [{ name: 'Elsewhere/stray' }] } } }); await assert.rejects(stray.phases.U7c(), codeIs('activation-epoch-changed'));
    // R2 already activated before UA (all three, or only one) is refused at admission and UA never launches.
    for (const faults of [{ preActivated: true }, { registryExtra: { R2: [{ name: optional[0] }] } }]) {
        const h = build({ faults }); await throughR1(h); await assert.rejects(h.phases.U7d(), codeIs('activation-epoch-changed')); assert.equal(h.calls.some(call => call.startsWith('ua:')), false);
    }
    const sticky = build({ faults: { registryExtra: { R2: [{ name: optional[0], when: 'between' }] } } }); await throughR1(sticky); await sticky.phases.U7d(); sticky.stage.done.add('between'); await assert.rejects(sticky.phases.UA(), codeIs('activation-epoch-changed')); assert.equal(sticky.calls.includes('ua:execute'), false, 'an R2 that became activated between U7d and UA is refused before UA-1');
    // A fourth runtime appearing during UA, or after it, is refused; the exact three are accepted.
    const fourth = build({ faults: { registryExtra: { R2: [{ name: 'AssistOSExplorer/webmeetFourth', when: 'UA' }] } } }); await throughR1(fourth); await fourth.phases.U7d(); await assert.rejects(fourth.phases.UA(), codeIs('activation-epoch-changed')); assert.equal(fourth.calls.includes('ua:verify'), true); assert.equal(fourth.state.activation, undefined, 'no activation proof is recorded');
    const duringGate = build({ faults: { registryExtra: { R2: [{ name: 'AssistOSExplorer/webmeetFourth', when: 'OnlyOffice' }] } } }); await throughUA(duringGate); await assert.rejects(duringGate.phases.U8b(), codeIs('activation-epoch-changed')); assert.equal(duringGate.calls.includes('gate:WebMeet'), false);
    const afterUA = build({ faults: { registryExtra: { R2: [{ name: 'AssistOSExplorer/webmeetFourth', when: 'UA' }] } } }); await assert.rejects(throughUA(afterUA), codeIs('activation-epoch-changed'));
    const exact = await all({}); assert.equal(exact.state.gates.length, 3, 'exactly the default graph, then exactly three more, is accepted');
});

test('U9 refuses any unsettled owned command, open browser context, remaining fixture or dirty run', async () => {
    for (const faults of [{ unsettled: true }, { openContext: true }, { fixtureLeft: true }]) { const h = build({ faults }); await assert.rejects(h.phases.U9(), codeIs('owned-resource-unsettled')); }
    await assert.rejects(build({ faults: { latchDirty: true } }).phases.U9(), codeIs('writers-not-quiescent'));
});
