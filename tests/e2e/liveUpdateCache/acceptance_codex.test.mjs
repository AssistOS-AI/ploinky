import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPureGuards, generationManifest, H } from './test_support_codex.mjs';
import { createWorld } from './world_support_codex.mjs';
import { createMemoryFs } from './fake_fs_support_codex.mjs';
import { createStopLatch, createOwnedCustody } from './execution_codex.mjs';
import { validateManifest } from './manifest_codex.mjs';
import { expectedLiveFromManifest } from './live_admission_codex.mjs';
import { executeAcceptance, verifyFunctionalFile, verifyRelease1File } from './acceptance_codex.mjs';
import { REQUIRED_PHASES, PHASE_CAPS_MS, TOTAL_CAP_MS } from './contracts_codex.mjs';
installPureGuards();

const WALL_BASE = Date.parse('2026-10-04T12:30:30Z'), R2_START = Date.parse('2026-10-04T12:50:00Z');
const STATUSES = (pass, fail = null) => REQUIRED_PHASES.map((name, index) => (index < pass ? 'PASS' : index === fail ? 'FAIL' : 'UNRUN'));

function build(faults = {}, { files = {}, patchBase, patch1, patch2 } = {}) {
    const h = createWorld(faults), { manifest } = h.world; manifest.grant.endsAtMs += 7200000; patchBase?.(manifest);
    const release1 = validateManifest(generationManifest(manifest, 'R1', r => { r.box.startedAt = '2026-10-04T12:31:00Z'; r.epochs.functional.startedAt = r.box.startedAt; patch1?.(r); })), release2 = validateManifest(generationManifest(manifest, 'R2', patch2));
    const time = { t: 0 }, io = createMemoryFs({ [`${manifest.evidence.root}/.keep`]: '', ...files }), closes = []; io.setMode(manifest.evidence.root, 0o040700);
    const clock = { mono: () => time.t, wall: () => WALL_BASE + time.t + (faults.wallLate ?? 0), delay: async ms => { time.t += ms; await new Promise(resolve => setTimeout(resolve, 1)); } };
    const observedFor = (m, added) => { const expected = expectedLiveFromManifest(m, added);
        return { registryAgents: [...m.graph.map(entry => entry.name), ...(added ? m.activation.map(entry => entry.name) : [])], hostPlatform: 'linux', engine: 'podman', rootless: true, running: true, initialized: true, activeGeneration: 'g-1', pendingActivation: false, recoveryBarrier: false, workspace: { ...expected.workspace }, box: { ...expected.box }, candidate: structuredClone(expected.candidate),
            publications: expected.publications, sourceMounts: expected.sourceMounts, engineIdentity: expected.engineIdentity, graph: expected.requiredGraph.map(entry => ({ name: entry.name, graphGeneration: 'g-1', running: true, runtimeId: 'r', instanceId: 'i', enableGeneration: 'e', ready: true, externalHealth: true, noWaitState: null })) }; };
    let gateOffset = 0; const custody = createOwnedCustody(), latch = createStopLatch(), ports = h.ports, loads = [], activation = [];
    const baseObserve = ports.observer.observe; ports.observer.observe = async () => (faults.slowPhase ? (time.t += 0, baseObserve()) : baseObserve());
    if (faults.slowAdmit) { const original = ports.observer.admit; ports.observer.admit = async () => { time.t += PHASE_CAPS_MS.U0 + 1; return original(); }; }
    if (faults.silentLatch) { const original = ports.cache.cli; ports.cache.cli = async (...args) => { latch.stop('worker-error'); return original(...args); }; }
    if (faults.slowPhase) { const original = ports.fixture.prepare; ports.fixture.prepare = async () => { time.t += PHASE_CAPS_MS[faults.slowPhase] + 1; return original(); }; }
    Object.assign(ports, { custody, browser: { ...ports.browser, async close() { closes.push('close'); return { closed: true }; }, openContexts: () => 0 },
        release: { async load(role) { loads.push(role); return role === 'R1' ? release1 : release2; }, observerFor: m => ({ admit: async () => ({ phase: 'U0', admitted: true, activeGeneration: 'g-1', runtimes: 1 }), observe: async ({ addedGraph } = {}) => observedFor(m, addedGraph) }) },
        gates: { async run(gate) { gateOffset += 1000; ports.gateLog.push(gate); const wall = clock.wall() + gateOffset; time.t += faults.gateMs ?? 0;
            return { name: gate, runId: `r-${gate}`, discovered: 1, passed: faults.skipGate === gate ? 0 : 1, failed: 0, skipped: faults.skipGate === gate ? 1 : 0, retries: 0, ignoredErrors: 0, closed: true, startedAt: new Date(wall).toISOString(), finishedAt: new Date(wall + 500).toISOString() }; } },
        activation: { async prepare() { activation.push('prepare'); time.t += 30000; return { exitCode: 0, clean: true }; }, async start() { activation.push('start'); return { runId: 'ua' }; }, async execute() { activation.push('execute'); time.t += 457000; return { exitCode: 0 }; },
            async finish() { activation.push('finish'); }, async verify() { activation.push('verify'); return { receiptSha256: H('receipt') }; } },
        close: async () => { closes.push('ports-close'); } }); ports.gateLog = [];
    const inputs = { probeAgentImage: 'x', releaseManifest: '/r.json', expectedUpdates: h.ctx.inputs.expectedUpdates };
    let created = 0; const createPorts = async () => { created += 1; return ports; };
    const writes = [];
    const run = (extra = {}) => executeAcceptance({ manifest, inputs, createPorts, io, clock, hostFacts: { platform: 'linux', uid: manifest.host.uid }, latch, custody, write: event => writes.push(event), ...extra });
    // The operator's fixture steps between invocations: each places its manifest and moves the clock to the matching generation age.
    const setRelease = () => { time.t += 120000; io.setFile(manifest.evidence.release, JSON.stringify(release1)); };
    const setRelease2 = (ageMs = 60000) => { time.t = Math.max(time.t, R2_START + ageMs - WALL_BASE); io.setFile(manifest.evidence.release2, JSON.stringify(release2)); };
    return { ...h, manifest, release1, release2, io, clock, time, run, closes, createdPorts: () => created, writes, latch, custody, setRelease, setRelease2, loads, activation, gateLog: () => ports.gateLog,
        invocation1: () => run(), invocation2: async () => { setRelease(); return run(); }, invocation3: async () => { setRelease2(); return run(); } };
}
const rejects = (promise, code, label) => assert.rejects(promise, error => error.code === code, label);
// The AC-L3 predicate of the SPEC (as amended by CL-1), evaluated in-process.
function acL3(r) {
    const want = { Copilot: 570000, OnlyOffice: 1020000, WebMeet: 150000 }, a = r.admissions, g = r.releaseGenerations;
    return r.acceptance === 'UC_STAGE_PASS' && r.ucOverallAcceptance === 'OPEN' && JSON.stringify(r.pendingRequirements) === '["AC-L4-G-BASE"]' && Array.isArray(a) && a.length === 3 && a.map(x => x.gate).join() === 'Copilot,OnlyOffice,WebMeet'
        && a.every(x => x.generationRemainingMs === want[x.gate] && x.boxAgeMs >= 0 && x.imageAgeMs >= 0 && x.boxAgeMs + x.generationRemainingMs <= 1800000 && x.imageAgeMs + x.generationRemainingMs <= 14400000)
        && Array.isArray(g) && g.length === 2 && new Set(g.map(x => x.boxId)).size === 2 && new Set(g.map(x => x.imageId)).size === 1;
}

test('invocation 1: without an R1 fixture the functional epoch settles, B1 is accepted, the epoch is frozen and the run reports AWAITING with no pass and no final receipt', async () => {
    const h = build(); const receipt = await h.invocation1();
    assert.equal(receipt.acceptance, 'UNQUALIFIED'); assert.equal(receipt.status, 'AWAITING_RELEASE_FIXTURE'); assert.equal(receipt.exitCode, 3); assert.equal(receipt.resourceDisposition, 'FUNCTIONAL_EPOCH_SETTLED');
    assert.deepEqual(receipt.phases.map(row => row.status), STATUSES(9)); assert.ok(receipt.phases.slice(0, 9).every(row => row.qualified === true));
    assert.equal(receipt.admissions.length, 1); assert.equal(receipt.admissions[0].point, 'B1'); assert.equal(receipt.admissions[0].accepted, true); assert.equal(receipt.admissions[0].reserveMs, 6150000);
    assert.equal(h.io.files.has(h.manifest.evidence.receipt), false); assert.equal(h.io.files.has(h.manifest.evidence.functional), true); assert.equal(h.io.files.has(h.manifest.evidence.release1Record), false);
    const frozen = JSON.parse(h.io.files.get(h.manifest.evidence.functional)); assert.equal(frozen.receipts.length, 9); assert.equal(frozen.record.browserGateCredit, 0); assert.equal(verifyFunctionalFile(frozen, h.manifest), frozen);
    assert.deepEqual(h.closes, ['ports-close']); assert.ok(h.world.calls.indexOf('cleanup:true') > h.world.calls.indexOf('browser-verify')); assert.ok(h.writes.length >= 9); assert.deepEqual(h.loads, []);
});

test('AC-12: B1 at the functional finalizer accepts at its limit and, beyond it, stops the campaign with exit 3 before any release-side launch and freezes nothing', async () => {
    const refused = build({}, { patchBase: m => { m.box.imageCreatedAt = '2026-10-04T04:00:00Z'; } }); const receipt = await refused.invocation1();
    assert.equal(receipt.exitCode, 3); assert.equal(receipt.status, 'RELEASE_IMAGE_WINDOW_INSUFFICIENT'); assert.equal(receipt.acceptance, 'UNQUALIFIED'); assert.equal(receipt.reason, 'campaign-image-window-insufficient');
    assert.equal(refused.io.files.has(refused.manifest.evidence.functional), false); assert.deepEqual(refused.loads, []); assert.deepEqual(receipt.phases.map(row => row.status), STATUSES(9));
    // Exact boundary: the image age at the finalizer plus 6,150,000 ms is at most 14,400,000 ms.
    const probe = build(); await probe.invocation1(); const finalizedAt = probe.clock.wall();
    const atLimit = build({}, { patchBase: m => { m.box.imageCreatedAt = new Date(finalizedAt - (14400000 - 6150000)).toISOString(); } }); assert.equal((await atLimit.invocation1()).status, 'AWAITING_RELEASE_FIXTURE');
    const past = build({}, { patchBase: m => { m.box.imageCreatedAt = new Date(finalizedAt - (14400000 - 6150000) - 1).toISOString(); } }); assert.equal((await past.invocation1()).status, 'RELEASE_IMAGE_WINDOW_INSUFFICIENT');
});

test('invocation 2 runs R1 (U7c, U8a) once, creates release1_codex.json exclusively and reports AWAITING_SECOND_RELEASE_FIXTURE; a repeat is refused before anything launches', async () => {
    const h = build(); await h.invocation1(); const receipt = await h.invocation2();
    assert.equal(receipt.acceptance, 'UNQUALIFIED'); assert.equal(receipt.status, 'AWAITING_SECOND_RELEASE_FIXTURE'); assert.equal(receipt.exitCode, 3); assert.deepEqual(receipt.phases.map(row => row.status), STATUSES(11));
    assert.deepEqual(h.gateLog(), ['Copilot'], 'Copilot ran once, on R1'); assert.deepEqual(h.activation, [], 'R1 is never activated'); assert.deepEqual(h.loads, ['R1']);
    assert.deepEqual(receipt.admissions.map(row => [row.gate, row.generationRemainingMs]), [['Copilot', 570000]]);
    const file = JSON.parse(h.io.files.get(h.manifest.evidence.release1Record)); assert.equal(file.kind, 'release-epoch-1'); assert.equal(file.runId, h.manifest.runId); assert.deepEqual(file.receipts.map(row => row.phase), ['U7c', 'U8a']);
    assert.equal(file.record.boxId, h.release1.box.id); assert.equal(file.record.boxName, h.release1.box.name); assert.equal(file.record.copilotGate.name, 'Copilot'); assert.equal(file.record.copilotGate.passed, 1); assert.equal(file.record.imageId, h.manifest.box.imageId);
    assert.equal(verifyRelease1File(file, h.manifest, JSON.parse(h.io.files.get(h.manifest.evidence.functional))), file);
    assert.equal(h.io.files.has(h.manifest.evidence.receipt), false);
    const before = h.io.files.get(h.manifest.evidence.release1Record).toString(), ports = h.createdPorts(), gates = h.gateLog().length;
    await rejects(h.run(), 'release2-fixture-absent'); assert.equal(h.createdPorts(), ports, 'no adapter was created'); assert.equal(h.gateLog().length, gates); assert.equal(h.io.files.get(h.manifest.evidence.release1Record).toString(), before, 'release1_codex.json is never rewritten');
});

test('N-B: invocation 2 always ends after U8a with AWAITING_SECOND_RELEASE_FIXTURE, even when release2_codex.json appears while it runs', async () => {
    const h = build(); await h.invocation1(); h.setRelease();
    const run = h.ports.gates.run; h.ports.gates.run = async gate => { const row = await run(gate); h.io.setFile(h.manifest.evidence.release2, JSON.stringify(h.release2)); return row; };   // the operator's second fixture lands during the Copilot gate
    const receipt = await h.run();
    assert.equal(receipt.status, 'AWAITING_SECOND_RELEASE_FIXTURE'); assert.equal(receipt.exitCode, 3); assert.equal(receipt.acceptance, 'UNQUALIFIED'); assert.deepEqual(receipt.phases.map(row => row.status), STATUSES(11));
    assert.deepEqual(h.loads, ['R1'], 'R2 was never loaded'); assert.deepEqual(h.activation, [], 'no activation ran'); assert.deepEqual(h.gateLog(), ['Copilot']); assert.equal(h.io.files.has(h.manifest.evidence.release1Record), true); assert.equal(h.io.files.has(h.manifest.evidence.receipt), false);
    // Invocation 3 then continues from exactly that state.
    h.setRelease2(); const final = await h.run(); assert.equal(final.acceptance, 'UC_STAGE_PASS', `${final.failedPhase}:${final.reason}`); assert.deepEqual(h.loads, ['R1', 'R2']);
});

test('N-B: release2_codex.json without release1_codex.json is refused at startup before any adapter exists', async () => {
    for (const withFunctional of [false, true]) {
        const h = build(); if (withFunctional) { await h.invocation1(); h.setRelease(); } h.setRelease2();
        const created = h.createdPorts(); await rejects(h.run(), 'release2-fixture-premature', String(withFunctional)); assert.equal(h.createdPorts(), created, 'no adapter was created'); assert.deepEqual(h.gateLog(), []); assert.deepEqual(h.loads, []);
    }
    const fresh = build(); fresh.setRelease2(); await rejects(fresh.run(), 'release2-fixture-premature'); assert.equal(fresh.createdPorts(), 0);
    const fine = build(); await fine.invocation1(); await fine.invocation2(); fine.setRelease2(); assert.equal((await fine.run()).acceptance, 'UC_STAGE_PASS');
});

test('invocation 3 runs R2 (U7d, UA, U8b, U9) and completes the UC STAGE only: UC_STAGE_PASS with overall acceptance OPEN and AC-L4 G-BASE pending', async () => {
    const h = build(); await h.invocation1(); await h.invocation2(); const receipt = await h.invocation3();
    assert.equal(receipt.acceptance, 'UC_STAGE_PASS', `${receipt.failedPhase}:${receipt.reason}`); assert.equal(receipt.exitCode, 0); assert.equal(receipt.ucOverallAcceptance, 'OPEN'); assert.deepEqual(receipt.pendingRequirements, ['AC-L4-G-BASE']); assert.equal(receipt.status, 'UC_STAGE_COMPLETE');
    assert.deepEqual(receipt.phases.map(row => row.phase), REQUIRED_PHASES); assert.equal(REQUIRED_PHASES.length, 15); assert.ok(receipt.phases.every(row => row.status === 'PASS' && row.qualified === true), 'all 15 phases');
    assert.deepEqual(receipt.gates.map(gate => gate.name), ['Copilot', 'OnlyOffice', 'WebMeet']); assert.ok(receipt.gates.every(gate => gate.discovered === 1 && gate.passed === 1 && gate.skipped === 0 && gate.retries === 0));
    assert.deepEqual(h.gateLog(), ['Copilot', 'OnlyOffice', 'WebMeet'], 'each gate ran exactly once across the three invocations'); assert.deepEqual(h.loads, ['R1', 'R2']); assert.deepEqual(h.activation, ['prepare', 'start', 'execute', 'finish', 'verify', 'verify', 'verify']);
    assert.deepEqual(receipt.releaseGenerations.map(row => [row.id, row.boxId, row.boxName]), [['R1', h.release1.box.id, h.release1.box.name], ['R2', h.release2.box.id, h.release2.box.name]]);
    assert.equal(receipt.activation.receiptSha256, H('receipt')); assert.equal(receipt.activation.after.runtimes.length, receipt.activation.before.runtimes.length + 3); assert.deepEqual(receipt.activation.install, { exitCode: 0, clean: true });
    assert.equal(acL3(receipt), true, 'the AC-L3 predicate'); assert.equal(JSON.parse(h.io.files.get(h.manifest.evidence.receipt)).acceptance, 'UC_STAGE_PASS'); assert.equal(JSON.parse(h.io.files.get(h.manifest.evidence.receipt)).ucOverallAcceptance, 'OPEN');
    assert.equal(h.world.calls.filter(call => call.startsWith('update:')).length, 2, 'the later invocations perform no second functional update');
    assert.ok(receipt.budget.elapsedMs <= TOTAL_CAP_MS); assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|\/ws\//); assert.doesNotMatch(JSON.stringify(receipt), /"acceptance":"PASS"/);
    await rejects(h.run(), 'receipt-exists', 'a published receipt is never overwritten or re-run');
});

test('AC-L3 predicate: an empty or partial receipt, a Copilot with the whole remaining work and a plain PASS are not accepted', async () => {
    const h = build(); await h.invocation1(); await h.invocation2(); const receipt = JSON.parse(JSON.stringify(await h.invocation3())); assert.equal(acL3(receipt), true);
    assert.equal(acL3({ ...receipt, admissions: [] }), false); assert.equal(acL3({ ...receipt, acceptance: 'PASS' }), false); assert.equal(acL3({ ...receipt, ucOverallAcceptance: 'PASS' }), false); assert.equal(acL3({ ...receipt, pendingRequirements: [] }), false);
    const wide = structuredClone(receipt); wide.admissions[0].generationRemainingMs = 1590000; assert.equal(acL3(wide), false);
    const sameBox = structuredClone(receipt); sameBox.releaseGenerations[1].boxId = sameBox.releaseGenerations[0].boxId; assert.equal(acL3(sameBox), false);
});

test('AC-11: a tampered, forged or orphaned release1_codex.json is release-epoch1-invalid before any adapter exists', async () => {
    const base = build(); await base.invocation1(); await base.invocation2(); const good = JSON.parse(base.io.files.get(base.manifest.evidence.release1Record)), functional = base.io.files.get(base.manifest.evidence.functional);
    const forge = (patch, { reseal = false } = {}) => { const h = build(); h.io.setFile(h.manifest.evidence.functional, functional); h.setRelease2(); const file = structuredClone(good); patch(file); h.io.setFile(h.manifest.evidence.release1Record, JSON.stringify(file)); return h; };
    for (const [label, patch] of [['other run', f => { f.runId = 'other'; }], ['tampered record Box', f => { f.record.boxId = H('x'); }], ['tampered receipt', f => { f.receipts[0].evidenceSha256 = H('x'); }], ['reordered receipts', f => { f.receipts.reverse(); }],
        ['dropped receipt', f => { f.receipts.pop(); }], ['skipped phase', f => { f.receipts[1].status = 'SKIP'; }], ['unknown kind', f => { f.kind = 'x'; }], ['skipped Copilot', f => { f.record.copilotGate.skipped = 1; }], ['no sha', f => { delete f.sha256; }]]) {
        const h = forge(patch); await rejects(h.run(), 'release-epoch1-invalid', label); assert.equal(h.createdPorts(), 0, label);
    }
    const resealed = forge(file => { file.record.copilotGate.skipped = 1; }); await rejects(resealed.run(), 'release-epoch1-invalid');
    const orphan = build(); orphan.setRelease2(); orphan.io.setFile(orphan.manifest.evidence.release1Record, JSON.stringify(good)); await rejects(orphan.run(), 'release-epoch1-invalid', 'a record without a functional epoch'); assert.equal(orphan.createdPorts(), 0);
    const foreignFunctional = forge(() => {}); const tamperedFunctional = JSON.parse(functional.toString()); tamperedFunctional.record.boxId = H('y'); foreignFunctional.io.setFile(foreignFunctional.manifest.evidence.functional, JSON.stringify(tamperedFunctional)); await rejects(foreignFunctional.run(), 'functional-receipt-invalid');
    const missing2 = build(); missing2.io.setFile(missing2.manifest.evidence.functional, functional); missing2.io.setFile(missing2.manifest.evidence.release1Record, JSON.stringify(good)); await rejects(missing2.run(), 'release2-fixture-absent'); assert.equal(missing2.createdPorts(), 0);
});

test('the first refusal stops the run: later phases are unrun, nothing is cleaned up by guesswork and the verdict is nonzero', async () => {
    const h = build({ updateKeepsObject: true }); const receipt = await h.run();
    assert.equal(receipt.acceptance, 'FAIL'); assert.equal(receipt.exitCode, 1); assert.equal(receipt.failedPhase, 'U4'); assert.match(receipt.reason, /^[a-z][a-z0-9-]*$/);
    assert.deepEqual(receipt.phases.map(row => row.status), STATUSES(4, 4));
    assert.equal(h.world.calls.some(call => call.startsWith('cleanup:') || call === 'fixture-cleanup' || call === 'negative-restore'), false); assert.equal(h.io.files.has(h.manifest.evidence.receipt), false); assert.equal(h.io.files.has(h.manifest.evidence.functional), false);
    assert.deepEqual(h.closes, ['ports-close']); assert.equal(receipt.resourceDisposition, 'OWNED_RESOURCES_RETAINED_FOR_REVIEW');
});

test('a failure persists a recovery record naming the owned identities before anything is closed', async () => {
    const h = build({ updateKeepsObject: true }); const order = []; const record = h.ports.recovery.record; h.ports.recovery.record = (label, value) => { order.push(`record:${label}`); return record(label, value); };
    const close = h.ports.close; h.ports.close = async () => { order.push('close'); return close(); };
    const receipt = await h.run(); assert.equal(receipt.failedPhase, 'U4'); assert.match(receipt.recoveryRecord, /^recovery_\d+_failure_codex\.json$/);
    assert.ok(order.indexOf('record:failure') >= 0 && order.indexOf('record:failure') < order.indexOf('close'), 'recorded before the ports are closed');
    const failure = h.world.recovered.find(row => row.label === 'failure').value; assert.deepEqual(failure.passedPhases, ['U0', 'U1', 'U2', 'U3']); assert.equal(failure.failedPhase, 'U4'); assert.equal(failure.withinDeadline, true);
    assert.equal(failure.fixture.container.id, H('server'), 'the exact owned container is named for manual recovery'); assert.deepEqual(failure.fixture.aliases.length, 2);
    const failing = build({ updateKeepsObject: true }); failing.ports.recovery.record = () => { throw new Error('PRIVATE'); }; const survived = await failing.run();
    assert.equal(survived.acceptance, 'FAIL'); assert.equal(survived.recoveryRecord, null); assert.doesNotMatch(JSON.stringify(survived), /PRIVATE/);
});

test('a phase that exceeds its own cap is a failed phase even when its work succeeded', async () => {
    const h = build({ slowPhase: 'U3' }); const receipt = await h.run(); assert.equal(receipt.acceptance, 'FAIL'); assert.equal(receipt.failedPhase, 'U3'); assert.equal(receipt.reason, 'phase-budget-expired');
});

test('a phase that finishes late without any later check and a phase that latches without throwing never pass', async () => {
    const late = await build({ slowAdmit: true }).run(); assert.equal(late.acceptance, 'FAIL'); assert.equal(late.failedPhase, 'U0'); assert.equal(late.reason, 'phase-budget-expired');
    const silent = await build({ silentLatch: true }).run(); assert.equal(silent.acceptance, 'FAIL'); assert.equal(silent.failedPhase, 'U2'); assert.equal(silent.reason, 'run-uncertain'); assert.equal(silent.resourceDisposition, 'HANDOFF_REQUIRED');
});

test('a skipped canonical gate, an uncertain latch and a late wall clock never produce a stage pass', async () => {
    const skippedCopilot = build({ skipGate: 'Copilot' }); await skippedCopilot.invocation1(); const r1 = await skippedCopilot.invocation2(); assert.equal(r1.acceptance, 'FAIL'); assert.equal(r1.failedPhase, 'U8a'); assert.equal(skippedCopilot.io.files.has(skippedCopilot.manifest.evidence.release1Record), false); assert.equal(skippedCopilot.io.files.has(skippedCopilot.manifest.evidence.receipt), false);
    const skipped = build({ skipGate: 'OnlyOffice' }); await skipped.invocation1(); await skipped.invocation2(); const result = await skipped.invocation3(); assert.equal(result.acceptance, 'FAIL'); assert.equal(result.failedPhase, 'U8b'); assert.equal(skipped.io.files.has(skipped.manifest.evidence.receipt), false); assert.notEqual(result.ucOverallAcceptance, 'OPEN');
    const dirty = build(); dirty.latch.stop('worker-error'); const refused = await dirty.run(); assert.equal(refused.acceptance, 'FAIL'); assert.equal(refused.failedPhase, 'U0'); assert.equal(refused.reason, 'run-uncertain'); assert.equal(refused.resourceDisposition, 'HANDOFF_REQUIRED');
    await assert.rejects(build({ wallLate: 7200000 }).run(), error => error.code === 'schedule-insufficient');
});

test('the run refuses before any adapter exists on an unqualified host, with an existing receipt, or with a forged functional file', async () => {
    const host = build(); await rejects(host.run({ hostFacts: { platform: 'darwin', uid: host.manifest.host.uid } }), 'runtime-host-unqualified'); assert.equal(host.createdPorts(), 0);
    const existing = build({}, {}); existing.io.setFile(existing.manifest.evidence.receipt, '{}'); await rejects(existing.run(), 'receipt-exists'); assert.equal(existing.createdPorts(), 0);
    const base = build(); await base.invocation1(); const good = JSON.parse(base.io.files.get(base.manifest.evidence.functional));
    const forge = patch => { const h = build(); const file = structuredClone(good); patch(file); h.io.setFile(h.manifest.evidence.functional, JSON.stringify(file)); h.setRelease(); return h; };
    for (const [label, patch] of [['other run', f => { f.runId = 'other'; }], ['tampered receipt', f => { f.receipts[2].evidenceSha256 = H('x'); }], ['tampered record', f => { f.record.browserGateCredit = 1; }], ['reordered receipts', f => { f.receipts.reverse(); }],
        ['dropped receipt', f => { f.receipts.pop(); }], ['skipped phase', f => { f.receipts[4].status = 'SKIP'; }], ['unknown kind', f => { f.kind = 'x'; }]]) {
        const h = forge(patch); await rejects(h.run(), 'functional-receipt-invalid', label); assert.equal(h.createdPorts(), 0, label);
    }
    const resealed = forge(file => { file.receipts[2].status = 'SKIP'; }); await rejects(resealed.run(), 'functional-receipt-invalid');
});

test('each invocation admits only the remaining suffix of the grant window, not the whole schedule again', async () => {
    const suffix2 = PHASE_CAPS_MS.U7c + PHASE_CAPS_MS.U8a + PHASE_CAPS_MS.U7d + PHASE_CAPS_MS.UA + PHASE_CAPS_MS.U8b + PHASE_CAPS_MS.U9, suffix3 = PHASE_CAPS_MS.U7d + PHASE_CAPS_MS.UA + PHASE_CAPS_MS.U8b + PHASE_CAPS_MS.U9;
    assert.equal(suffix3, 3480000);
    const fits = build(); await fits.invocation1(); fits.setRelease(); fits.manifest.grant.endsAtMs = fits.clock.wall() + suffix2; assert.equal((await fits.run()).status, 'AWAITING_SECOND_RELEASE_FIXTURE');
    const short = build(); await short.invocation1(); short.setRelease(); short.manifest.grant.endsAtMs = short.clock.wall() + suffix2 - 1;
    await rejects(short.run(), 'schedule-insufficient'); assert.equal(short.gateLog().length === 0 && !short.io.files.has(short.manifest.evidence.release1Record), true);
    const third = build(); await third.invocation1(); await third.invocation2(); third.setRelease2(); third.manifest.grant.endsAtMs = third.clock.wall() + suffix3; const passed = await third.run(); assert.equal(passed.acceptance, 'UC_STAGE_PASS', `${passed.failedPhase}:${passed.reason}`);
    const shortThird = build(); await shortThird.invocation1(); await shortThird.invocation2(); shortThird.setRelease2(); shortThird.manifest.grant.endsAtMs = shortThird.clock.wall() + suffix3 - 1;
    await rejects(shortThird.run(), 'schedule-insufficient'); assert.deepEqual(shortThird.gateLog(), ['Copilot'], 'no R2 gate ran'); assert.deepEqual(shortThird.activation, []);
});

test('B2 and B3 stop the later invocations before the launch they protect', async () => {
    const agedR1 = build({}, { patch1: r => { r.box.imageCreatedAt = '2026-10-04T08:00:00Z'; } }); await agedR1.invocation1(); const stopped = await agedR1.invocation2();
    assert.equal(stopped.acceptance, 'FAIL'); assert.equal(stopped.failedPhase, 'U8a'); assert.equal(stopped.reason, 'campaign-image-window-insufficient'); assert.deepEqual(agedR1.gateLog(), []); assert.equal(agedR1.io.files.has(agedR1.manifest.evidence.release1Record), false);
    const agedR2 = build({}, { patch2: r => { r.box.imageCreatedAt = '2026-10-04T08:00:00Z'; } }); await agedR2.invocation1(); await agedR2.invocation2(); const stoppedUA = await agedR2.invocation3();
    assert.equal(stoppedUA.failedPhase, 'UA'); assert.equal(stoppedUA.reason, 'campaign-image-window-insufficient'); assert.equal(agedR2.activation.includes('execute'), false); assert.deepEqual(agedR2.gateLog(), ['Copilot']);
});

test('an absent, shared or foreign evidence root refuses before any adapter exists', async () => {
    const missing = build(); missing.io.files.delete(`${missing.manifest.evidence.root}/.keep`); await rejects(missing.run(), 'evidence-root-missing'); assert.equal(missing.createdPorts(), 0);
    const loose = build(); loose.io.setMode(loose.manifest.evidence.root, 0o040755); await rejects(loose.run(), 'evidence-root-unprivate'); assert.equal(loose.createdPorts(), 0);
    const foreign = build(), original = foreign.io.lstatSync; foreign.io.lstatSync = name => (name === foreign.manifest.evidence.root ? { ...original(name), uid: 0 } : original(name));
    await rejects(foreign.run(), 'evidence-root-unprivate'); assert.equal(foreign.createdPorts(), 0);
    const link = build(), linkOriginal = link.io.lstatSync; link.io.lstatSync = name => (name === link.manifest.evidence.root ? { ...linkOriginal(name), isSymbolicLink: () => true } : linkOriginal(name));
    await rejects(link.run(), 'evidence-root-unprivate'); assert.equal(link.createdPorts(), 0);
});

test('stage caps are the plan caps and the whole schedule is their exact sum', () => {
    assert.equal(TOTAL_CAP_MS, 14640000); assert.deepEqual(Object.keys(PHASE_CAPS_MS), REQUIRED_PHASES);
});

// AC-17: the runner can complete the UC stage only. These static checks make that directly testable.
const HERE = path.dirname(fileURLToPath(import.meta.url)), sources = () => fs.readdirSync(HERE).filter(name => /_codex\.mjs$/.test(name) && !/\.test\.mjs$/.test(name)).map(name => [name, fs.readFileSync(path.join(HERE, name), 'utf8')]);
test('AC-17 static: no non-test source writes a plain PASS acceptance and ucOverallAcceptance is only ever the literal OPEN or compared against OPEN', () => {
    const all = sources(); assert.ok(all.length > 20);
    for (const [name, text] of all) assert.equal((text.match(/acceptance: 'PASS'/g) ?? []).length, 0, `${name} writes acceptance: 'PASS'`);
    const uses = all.flatMap(([name, text]) => [...text.matchAll(/ucOverallAcceptance[^\n]{0,24}/g)].map(match => [name, match[0]]));
    assert.ok(uses.length >= 2, 'the field is written and checked');
    for (const [name, use] of uses) assert.match(use, /^ucOverallAcceptance(?:: 'OPEN'| === 'OPEN')/, `${name}: ${use}`);
    assert.equal(uses.some(([name, use]) => name === 'acceptance_codex.mjs' && /: 'OPEN'/.test(use)), true);
});
