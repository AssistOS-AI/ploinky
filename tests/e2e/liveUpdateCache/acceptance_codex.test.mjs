import test from 'node:test';
import assert from 'node:assert/strict';
import { installPureGuards, H } from './test_support_codex.mjs';
import { createWorld } from './world_support_codex.mjs';
import { createMemoryFs } from './fake_fs_support_codex.mjs';
import { createStopLatch, createOwnedCustody } from './execution_codex.mjs';
import { validateManifest } from './manifest_codex.mjs';
import { expectedLiveFromManifest } from './live_admission_codex.mjs';
import { executeAcceptance, verifyFunctionalFile } from './acceptance_codex.mjs';
import { REQUIRED_PHASES, PHASE_CAPS_MS, TOTAL_CAP_MS } from './contracts_codex.mjs';
installPureGuards();

function releaseManifestFrom(manifest) {
    const release = structuredClone(manifest), runId = 'update-cache-20261004T123000Z-feedc0de_codex', root = `/home/skutner/work/evidence/${runId}`;
    Object.assign(release, { runId }); release.evidence = { root, functional: `${root}/functional_codex.json`, release: `${root}/release_codex.json`, receipt: `${root}/receipt_codex.json`, sourceManifest: `${root}/sources_codex.json` };
    release.box = { ...release.box, id: H('box-release'), startedAt: '2026-10-04T12:31:00Z' }; release.workspace = { ...release.workspace, ino: 4242 };
    release.negativeScopes = { optional: `${release.workspace.path}/UpdateE2E-${runId}`, required: `${release.workspace.path}/UpdateE2E-${runId}` };
    release.epochs.functional = { ...release.epochs.functional, boxId: release.box.id, startedAt: release.box.startedAt }; release.grant = { ...release.grant, endsAtMs: release.grant.endsAtMs + 7200000 };
    return validateManifest(release);
}

function build(faults = {}, { files = {} } = {}) {
    const h = createWorld(faults), { manifest } = h.world; manifest.grant.endsAtMs += 7200000; const release = releaseManifestFrom(manifest), time = { t: 0 }, io = createMemoryFs({ [`${manifest.evidence.root}/.keep`]: '', ...files }), closes = [], wallBase = Date.parse('2026-10-04T12:30:30Z'); io.setMode(manifest.evidence.root, 0o040700);
    const clock = { mono: () => time.t, wall: () => wallBase + time.t + (faults.wallLate ?? 0), delay: async ms => { time.t += ms; } };
    const observedFor = m => { const expected = expectedLiveFromManifest(m);
        return { hostPlatform: 'linux', engine: 'podman', rootless: true, running: true, initialized: true, activeGeneration: 'g-1', pendingActivation: false, recoveryBarrier: false, workspace: { ...expected.workspace }, box: { ...expected.box }, candidate: structuredClone(expected.candidate),
            publications: expected.publications, sourceMounts: expected.sourceMounts, engineIdentity: expected.engineIdentity, graph: m.graph.map(entry => ({ name: entry.name, graphGeneration: 'g-1', running: true, runtimeId: 'r', instanceId: 'i', enableGeneration: 'e', ready: true, externalHealth: true, noWaitState: null })) }; };
    let wallAtGate = 0; const custody = createOwnedCustody(), latch = createStopLatch(); const ports = h.ports;
    // Functional observation after cleanup carries the identity of the settled functional workspace.
    const baseObserve = ports.observer.observe; ports.observer.observe = async () => (faults.slowPhase ? (time.t += 0, baseObserve()) : baseObserve());
    if (faults.slowAdmit) { const original = ports.observer.admit; ports.observer.admit = async () => { time.t += PHASE_CAPS_MS.U0 + 1; return original(); }; }
    if (faults.silentLatch) { const original = ports.cache.cli; ports.cache.cli = async (...args) => { latch.stop('worker-error'); return original(...args); }; }
    if (faults.slowPhase) { const original = ports.fixture.prepare; ports.fixture.prepare = async () => { time.t += PHASE_CAPS_MS[faults.slowPhase] + 1; return original(); }; }
    Object.assign(ports, { custody, browser: { ...ports.browser, async close() { closes.push('close'); return { closed: true }; }, openContexts: () => 0 },
        release: { async load() { return release; }, observerFor: m => ({ admit: async () => ({ phase: 'U0', admitted: true, activeGeneration: 'g-1', runtimes: 1 }), observe: async () => observedFor(m) }) },
        gates: { async run(gate) { wallAtGate += 1000; const wall = clock.wall() + wallAtGate; time.t += faults.gateMs ?? 0; return { name: gate, runId: `r-${gate}`, discovered: 1, passed: faults.skipGate === gate ? 0 : 1, failed: 0, skipped: faults.skipGate === gate ? 1 : 0, retries: 0, ignoredErrors: 0, closed: true, startedAt: new Date(wall).toISOString(), finishedAt: new Date(wall + 500).toISOString() }; } }, close: async () => { closes.push('ports-close'); } });
    const inputs = { probeAgentImage: 'x', releaseManifest: '/r.json', expectedUpdates: h.ctx.inputs.expectedUpdates };
    let created = 0; const createPorts = async () => { created += 1; return ports; };
    const writes = [];
    const run = (extra = {}) => executeAcceptance({ manifest, inputs, createPorts, io, clock, hostFacts: { platform: 'linux', uid: manifest.host.uid }, latch, custody, write: event => writes.push(event), ...extra });
    return { ...h, manifest, release, io, clock, time, run, closes, createdPorts: () => created, writes, latch, custody, setRelease: () => { time.t += 120000; io.setFile(manifest.evidence.release, JSON.stringify(release)); } };
}

test('without a release fixture the functional epoch settles, is frozen and the run reports AWAITING with no pass and no final receipt', async () => {
    const h = build(); const receipt = await h.run();
    assert.equal(receipt.acceptance, 'UNQUALIFIED'); assert.equal(receipt.status, 'AWAITING_RELEASE_FIXTURE'); assert.equal(receipt.exitCode, 3); assert.equal(receipt.resourceDisposition, 'FUNCTIONAL_EPOCH_SETTLED');
    assert.deepEqual(receipt.phases.map(row => row.status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'UNRUN', 'UNRUN', 'UNRUN']); assert.ok(receipt.phases.slice(0, 9).every(row => row.qualified === true));
    assert.equal(h.io.files.has(h.manifest.evidence.receipt), false); assert.equal(h.io.files.has(h.manifest.evidence.functional), true);
    const frozen = JSON.parse(h.io.files.get(h.manifest.evidence.functional)); assert.equal(frozen.receipts.length, 9); assert.equal(frozen.record.browserGateCredit, 0); assert.equal(verifyFunctionalFile(frozen, h.manifest), frozen);
    assert.deepEqual(h.closes, ['ports-close']); assert.ok(h.world.calls.indexOf('cleanup:true') > h.world.calls.indexOf('browser-verify')); assert.ok(h.writes.length >= 9);
});

test('a second invocation with the fresh fixture resumes at U7c, runs the gates and publishes the one aggregate receipt', async () => {
    const h = build(); await h.run(); h.setRelease();
    const receipt = await h.run();
    assert.equal(receipt.acceptance, 'PASS', `${receipt.failedPhase}:${receipt.reason}`); assert.equal(receipt.exitCode, 0); assert.deepEqual(receipt.phases.map(row => row.phase), REQUIRED_PHASES); assert.ok(receipt.phases.every(row => row.status === 'PASS' && row.qualified === true));
    assert.deepEqual(receipt.gates.map(gate => gate.name), ['Copilot', 'OnlyOffice', 'WebMeet']); assert.ok(receipt.gates.every(gate => gate.discovered === 1 && gate.passed === 1 && gate.skipped === 0 && gate.retries === 0));
    assert.equal(h.io.files.has(h.manifest.evidence.receipt), true); assert.equal(JSON.parse(h.io.files.get(h.manifest.evidence.receipt)).acceptance, 'PASS');
    assert.equal(h.world.calls.filter(call => call.startsWith('update:')).length, 2, 'the resumed run performs no second functional update');
    assert.ok(receipt.budget.elapsedMs <= TOTAL_CAP_MS); assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|\/ws\//);
    await assert.rejects(h.run(), error => error.code === 'receipt-exists', 'a published receipt is never overwritten or re-run');
});

test('the first refusal stops the run: later phases are unrun, nothing is cleaned up by guesswork and the verdict is nonzero', async () => {
    const h = build({ updateKeepsObject: true }); const receipt = await h.run();
    assert.equal(receipt.acceptance, 'FAIL'); assert.equal(receipt.exitCode, 1); assert.equal(receipt.failedPhase, 'U4'); assert.match(receipt.reason, /^[a-z][a-z0-9-]*$/);
    assert.deepEqual(receipt.phases.map(row => row.status), ['PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'UNRUN', 'UNRUN', 'UNRUN', 'UNRUN', 'UNRUN', 'UNRUN', 'UNRUN']);
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

test('a skipped canonical gate, an uncertain latch and a late wall clock never produce PASS', async () => {
    const skipped = build({ skipGate: 'OnlyOffice' }); await skipped.run(); skipped.setRelease(); const result = await skipped.run(); assert.equal(result.acceptance, 'FAIL'); assert.equal(result.failedPhase, 'U8'); assert.equal(skipped.io.files.has(skipped.manifest.evidence.receipt), false);
    const dirty = build(); dirty.latch.stop('worker-error'); const refused = await dirty.run(); assert.equal(refused.acceptance, 'FAIL'); assert.equal(refused.failedPhase, 'U0'); assert.equal(refused.reason, 'run-uncertain'); assert.equal(refused.resourceDisposition, 'HANDOFF_REQUIRED');
    await assert.rejects(build({ wallLate: 7200000 }).run(), error => error.code === 'schedule-insufficient');
});

test('the run refuses before any adapter exists on an unqualified host, with an existing receipt, or with a forged functional file', async () => {
    const host = build(); await assert.rejects(host.run({ hostFacts: { platform: 'darwin', uid: host.manifest.host.uid } }), error => error.code === 'runtime-host-unqualified'); assert.equal(host.createdPorts(), 0);
    const existing = build({}, {}); existing.io.setFile(existing.manifest.evidence.receipt, '{}'); await assert.rejects(existing.run(), error => error.code === 'receipt-exists'); assert.equal(existing.createdPorts(), 0);
    const base = build(); await base.run(); const good = JSON.parse(base.io.files.get(base.manifest.evidence.functional));
    const forge = patch => { const h = build(); const file = structuredClone(good); patch(file); h.io.setFile(h.manifest.evidence.functional, JSON.stringify(file)); h.setRelease(); return h; };
    for (const [label, patch] of [['other run', f => { f.runId = 'other'; }], ['tampered receipt', f => { f.receipts[2].evidenceSha256 = H('x'); }], ['tampered record', f => { f.record.browserGateCredit = 1; }], ['reordered receipts', f => { f.receipts.reverse(); }],
        ['dropped receipt', f => { f.receipts.pop(); }], ['skipped phase', f => { f.receipts[4].status = 'SKIP'; }], ['unknown kind', f => { f.kind = 'x'; }]]) {
        const h = forge(patch); await assert.rejects(h.run(), error => error.code === 'functional-receipt-invalid', label); assert.equal(h.createdPorts(), 0, label);
    }
    const resealed = forge(file => { file.receipts[2].status = 'SKIP'; }); await assert.rejects(resealed.run(), error => error.code === 'functional-receipt-invalid');
});

test('a resume admits only the remaining U7c-U9 suffix of the grant window, not the whole schedule again', async () => {
    const suffix = PHASE_CAPS_MS.U7c + PHASE_CAPS_MS.U8 + PHASE_CAPS_MS.U9;
    const fits = build(); await fits.run(); fits.setRelease(); fits.manifest.grant.endsAtMs = fits.clock.wall() + suffix;
    const passed = await fits.run(); assert.equal(passed.acceptance, 'PASS', `${passed.failedPhase}:${passed.reason}`); assert.ok(suffix < TOTAL_CAP_MS);
    const short = build(); await short.run(); short.setRelease(); short.manifest.grant.endsAtMs = short.clock.wall() + suffix - 1;
    await assert.rejects(short.run(), error => error.code === 'schedule-insufficient'); assert.equal(short.world.calls.some(call => call.startsWith('gate:')) || short.io.files.has(short.manifest.evidence.receipt), false);
});

test('an absent, shared or foreign evidence root refuses before any adapter exists', async () => {
    const missing = build(); missing.io.files.delete(`${missing.manifest.evidence.root}/.keep`); await assert.rejects(missing.run(), error => error.code === 'evidence-root-missing'); assert.equal(missing.createdPorts(), 0);
    const loose = build(); loose.io.setMode(loose.manifest.evidence.root, 0o040755); await assert.rejects(loose.run(), error => error.code === 'evidence-root-unprivate'); assert.equal(loose.createdPorts(), 0);
    const foreign = build(), original = foreign.io.lstatSync; foreign.io.lstatSync = name => (name === foreign.manifest.evidence.root ? { ...original(name), uid: 0 } : original(name));
    await assert.rejects(foreign.run(), error => error.code === 'evidence-root-unprivate'); assert.equal(foreign.createdPorts(), 0);
    const link = build(), linkOriginal = link.io.lstatSync; link.io.lstatSync = name => (name === link.manifest.evidence.root ? { ...linkOriginal(name), isSymbolicLink: () => true } : linkOriginal(name));
    await assert.rejects(link.run(), error => error.code === 'evidence-root-unprivate'); assert.equal(link.createdPorts(), 0);
});

test('stage caps are the plan caps and the whole schedule is their exact sum', () => {
    assert.equal(TOTAL_CAP_MS, 12960000); assert.deepEqual(Object.keys(PHASE_CAPS_MS), REQUIRED_PHASES);
});
