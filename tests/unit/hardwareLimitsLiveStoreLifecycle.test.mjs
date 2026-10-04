// LIVE-C5, the actual lifecycle section of the case (restart on, writer first, transition first, the replacement's own proof, custody and cleanup),
// offline. The orchestration is the REAL case over the REAL harness; the driver runs for real, in-process, over the product's real supervisor,
// transition and store with a stub engine behind the supervisor's runner (c5DriverWorld.mjs), and the fake engine's container table follows that
// world (fakeLiveStore.mjs). Nothing starts a container.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LIVE_CASES, executeCleanupRun, executeLiveRun, validateProfile } from '../hardware-limits/liveHarness.mjs';
import { provisionRun } from '../hardware-limits/liveFixture.mjs';
import { createFakeStore } from '../hardware-limits/fakeLiveStore.mjs';
import { ENGINE_HOST, world, free } from '../hardware-limits/executorWorld.mjs';
import { artifactPathFor, c5CleanupProofName } from '../hardware-limits/liveCommon.mjs';
import { C5_BOX_SCHEMA, C5_DRIVER_NAME, c5IntentOf, validateC5BoxReceipts } from '../hardware-limits/liveBoxTransitionCustody.mjs';
import { WRITER_FIRST_CODE, assertWriterFirstRefusal, parseDriverSummary, transportProblem } from '../hardware-limits/liveStoreLifecycle.mjs';
import { C5_CLEANUP_PROOF, C5_LIVE_ARTIFACTS, c5CleanupProofProblem, c5RequiredArtifacts } from '../hardware-limits/liveStage.mjs';
import { writePrivateJson } from '../hardware-limits/fixtures.mjs';
import { clearAgentLimits, readStoreSnapshot, setAgentLimits } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { OVERRIDES } from '../hardware-limits/liveStoreCommands.mjs';

const BLOCK = 'apparatus-store';
const REPOSITORY = fs.realpathSync(new URL('../..', import.meta.url).pathname);
const SECCOMP = fs.readFileSync(path.join(REPOSITORY, 'ploinky-box/seccomp/podman-nested-pid-fallback.json'));
const real = ms => new Promise(resolve => setTimeout(resolve, ms));
const SEAMS = { sleep: real, polling: { deadlineMs: 15000, intervalMs: 20 }, routerPolling: { deadlineMs: 15000, intervalMs: 20 }, http: async () => ({ status: 200, contentType: 'text/html', body: '' }) };
const LIFECYCLE_KEYS = ['restart-on', 'writer-first', 'writer-first-clear', 'transition-first', 'final-generation', 'c5-receipt'];

async function liveWorld(t, { faults = {}, lifecycleFaults = {} } = {}) {
    const w = world(t, { block: BLOCK, extraSource: { 'ploinky-box/seccomp/podman-nested-pid-fallback.json': SECCOMP } });
    const workspace = w.run.target.execution.provision.workspace.path;
    const fake = createFakeStore({ base: { provider: w.engineProvider, node: w.node, statePath: w.statePath }, workspace, home: w.home, faults,
        lifecycle: { source: w.run.target.execution.source.root, ports: w.run.ports, world: lifecycleFaults, engineHost: ENGINE_HOST } });
    const report = await provisionRun({ run: w.run, persist: w.persist, processProvider: fake.provider, portProbe: free, hostIdentity: w.hostIdentity, remoteArrival: w.remote, validateProfile });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    return { w, fake, workspace };
}
async function liveRun(context, { seams = SEAMS } = {}) {
    const { w, fake } = context;
    const artifacts = new Map();
    const report = await executeLiveRun({ run: w.run, hostIdentity: w.hostIdentity, processProvider: fake.provider, persist: w.persist, remoteArrival: true,
        artifacts: (name, value) => artifacts.set(name, structuredClone(value)), artifactPath: name => artifactPathFor(w.runPath, name), storeSeams: seams });
    return { report, artifacts, case: report.cases.find(entry => entry.id === 'LIVE-C5') };
}
const state = context => JSON.parse(fs.readFileSync(context.w.statePath, 'utf8'));
const boxIds = context => Object.keys(state(context).boxes);

async function fails(t, spec, pattern, { cleanup = 'complete' } = {}) {
    const context = await liveWorld(t, spec);
    const outcome = await liveRun(context, spec.seams ? { seams: spec.seams } : {});
    assert.equal(outcome.case.result, 'fail', JSON.stringify(outcome.case).slice(0, 900));
    assert.match(outcome.case.reason, pattern, outcome.case.reason);
    assert.equal(outcome.report.cleanup.state, cleanup, JSON.stringify(outcome.report.cleanup.failures));
    assert.equal(context.fake.model.children.size, 0, 'no program, holder or writer is left running');
    return { ...outcome, context };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------

test('X5.c5-lifecycle-restart-on-writer-first-and-transition-first-pass-over-the-real-product-and-cleanup-destroys-the-replacement', async t => {
    const context = await liveWorld(t);
    const original = boxIds(context)[0];
    const { fake, w } = context;
    const result = await liveRun(context);
    assert.equal(result.case.result, 'pass', JSON.stringify(result.case).slice(0, 1200));
    assert.equal(result.report.verdict, 'PASS');
    assert.equal(result.report.cleanup.state, 'complete');
    const evidence = result.case.evidence;
    for (const key of LIFECYCLE_KEYS) { assert.ok(evidence[key], key); assert.ok(result.artifacts.has(`store-${key}`), `required artifact store-${key}`); }
    // The gate-on restart kept the original immutable outer Box.
    assert.deepEqual(fake.model.restarts, [{ gate: 'on' }]);
    assert.equal(evidence['restart-on'].box.id, original);
    // Writer first: the typed refusal, zero lifecycle operations, nothing changed; the host clear gives T.
    assert.equal(evidence['writer-first'].refusal.code, WRITER_FIRST_CODE);
    assert.equal(evidence['writer-first'].refusal.runCalls, 0);
    assert.equal(evidence['writer-first-clear'].token.revision, evidence['writer-first-clear'].previous.revision + 1);
    // Transition first: both administrator writers were refused by the product's own barrier at the production stop boundary.
    const transition = evidence['transition-first'];
    assert.deepEqual(transition.replies, { set: { status: 409, error: 'hardware_limits_transition' }, clear: { status: 409, error: 'hardware_limits_transition' } });
    assert.deepEqual(transition.token, evidence['writer-first-clear'].token);
    assert.equal(transition.attempts.length, 1);
    assert.equal(transition.attempts[0].stage, 'candidate');
    assert.equal(transition.finalContainerId, transition.final.id);
    assert.notEqual(transition.final.id, original);
    assert.ok(Object.values(transition.final.checks).every(Boolean), JSON.stringify(transition.final.checks));
    assert.equal(transition.final.gate, false);
    // The order of the real driver runs, and the write-ahead: the invocation intent precedes the driver operation in the manifest.
    assert.deepEqual(fake.model.driverRuns.map(entry => entry.mode), ['writer-first', 'transition', 'destroy']);
    assert.equal(fake.model.driverRuns[2].expectedContainerId, transition.final.id, 'cleanup destroyed exactly the proven replacement');
    const operations = w.run.operations;
    const intent = c5IntentOf(w.run);
    const driverOp = operations.find(op => op.kind === C5_DRIVER_NAME);
    assert.ok(operations.indexOf(intent) >= 0 && operations.indexOf(intent) < operations.indexOf(driverOp), 'the intent is durable before the driver runs');
    assert.deepEqual([intent.state, driverOp.state, driverOp.result.status, intent.driverResult.settlementForced], ['observed', 'observed', 0, false]);
    assert.deepEqual(Object.keys(driverOp.result).sort(), ['cancelled', 'errorCode', 'signal', 'status', 'timedOut', 'truncated'], 'the journaled operation still keeps status flags only, never output')
    // The case installed and removed no barrier of its own in the new section: the only helper barrier calls are the diagnostic step 6.
    const programs = fake.model.programs.map(program => program.mode);
    assert.equal(programs.filter(mode => mode === 'barrier-begin').length, 1);
    assert.equal(programs.filter(mode => mode === 'barrier-remove').length, 1);
    const lifecycleStart = operations.findIndex(op => op.kind === 'c5-restart-on');
    assert.ok(lifecycleStart > 0);
    assert.equal(operations.slice(lifecycleStart).some(op => /store-barrier/.test(op.kind)), false);
    // Custody: the original receipt is the anchor, and ONE linked candidate generation, proved through the product's own records.
    const linked = w.run.ownedBoxes.filter(box => box.id !== original);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].schema, C5_BOX_SCHEMA);
    assert.deepEqual([linked[0].stage, linked[0].predecessorId, linked[0].id, linked[0].provenance], ['candidate', original, transition.final.id, 'product-attempt-cid-full-id-inspect']);
    assert.doesNotThrow(() => validateC5BoxReceipts(w.run, w.run.target.execution));
    assert.doesNotThrow(() => validateProfile(w.run, { partial: true }));
    // Cleanup left nothing: no Box, and the proof of this action names the whole chain absent.
    assert.deepEqual(boxIds(context), []);
    const proof = result.artifacts.get(c5CleanupProofName('live'));
    assert.deepEqual([proof.action, proof.chain, proof.absent, proof.remaining], ['live', [original, transition.final.id], [original, transition.final.id], []]);
    assert.equal(proof.destroyedThrough, 'exact-id driver');
});

test('X5.c5-lifecycle-the-gate-on-restart-must-keep-the-original-box-and-answer-and-a-replacement-is-preserved-unadopted', async t => {
    const replaced = await fails(t, { faults: { restartReplacesBox: true } }, /did not keep the original immutable outer Box/, { cleanup: 'failed' });
    // The unproven replacement is never adopted by name or path hash: cleanup refuses and leaves it.
    assert.match(replaced.report.cleanup.failures.join(' '), /Foreign replacement Box occupies workspace/);
    assert.equal(boxIds(replaced.context).length, 1);
    await fails(t, { faults: { restartExit: 1 } }, /The whole restart with the gate on: did not exit 0/);
    await fails(t, { faults: { adminDownAfterRestart: true }, seams: { ...SEAMS, routerPolling: { deadlineMs: 150, intervalMs: 20 } } }, /Router's administrator route never answered/);
});

test('X5.c5-lifecycle-a-gate-off-restart-that-is-not-refused-in-the-writer-first-order-is-a-failure-and-no-mutation-reaches-the-engine', async t => {
    // The stored policy vanishes before the writer-first restart, so the product proceeds into its transition: the decoration refuses the first
    // lifecycle mutation before it reaches the engine.
    const spec = { faults: { beforeDriver: async (mode, { context }) => {
        if (mode !== 'writer-first') return;
        clearAgentLimits({ paths: context.hostPaths, identity: context.identity, agentRef: 'hwlfixture/s', actor: { id: 'host', name: 'test' } });
    } } };
    const outcome = await fails(t, spec, /A lifecycle operation reached the engine runner in the writer-first order|was not refused with PLOINKY_BOX_HARDWARE_LIMITS_STORED/);
    assert.equal(outcome.case.reason.includes('PLOINKY_BOX_HARDWARE_LIMITS_STORED'), true);
    // Only the writer-first driver ran, the old Box was never stopped, and cleanup destroyed the original through the ordinary candidate destroy.
    assert.deepEqual(outcome.context.fake.model.driverRuns.map(entry => entry.mode), ['writer-first']);
    assert.equal(outcome.context.fake.model.world.containers.size, 1);
    assert.equal(c5IntentOf(outcome.context.w.run), null, 'no downgrade invocation was recorded');
});

test('X5.c5-lifecycle-a-production-rollback-fails-the-requested-transition-and-cleanup-follows-the-rollback-generation-exactly', async t => {
    const outcome = await fails(t, { lifecycleFaults: { failFirstGateOffCreate: true } }, /did not commit the desired-off generation \(PLOINKY_BOX_HARDWARE_TRANSITION_ROLLED_BACK/);
    const { w } = outcome.context;
    const linked = w.run.ownedBoxes.filter(box => box.stage);
    assert.deepEqual(linked.map(box => box.stage), ['rollback'], 'the rollback generation is the one admitted, through the product\'s own attempt record and CID');
    // The original ID is gone and the exact rollback generation was destroyed.
    assert.deepEqual(boxIds(outcome.context), []);
    const modes = outcome.context.fake.model.driverRuns;
    assert.deepEqual(modes.map(entry => entry.mode), ['writer-first', 'transition', 'destroy']);
    assert.equal(modes[2].expectedContainerId, linked[0].id);
    const proof = outcome.artifacts.get(c5CleanupProofName('live'));
    assert.equal(proof.chain.length, 2);
    assert.equal(proof.chain[1], linked[0].id);
});

test('X5.c5-lifecycle-a-timeout-is-never-a-pass-and-a-forced-settlement-preserves-the-chain-for-a-later-cleanup', async t => {
    const timedOut = await fails(t, { faults: { driverTimeout: 'transition' } }, /gate-off lifecycle driver timed out; that is neither a refusal nor a pass/);
    assert.equal(c5IntentOf(timedOut.context.w.run).state, 'observed');
    // A forced settlement is not proof that the driver's process group ended: cleanup preserves everything.
    const forced = await fails(t, { faults: { driverForcedSettlement: 'transition' } }, /needed a forced settlement/, { cleanup: 'failed' });
    assert.match(forced.report.cleanup.failures.join(' '), /not proven settled by the owned transport/);
    assert.equal(boxIds(forced.context).length, 1, 'the replacement is preserved');
});

test('X5.c5-lifecycle-a-writer-first-refusal-that-moved-the-stamp-the-policy-or-the-box-is-a-failure-naming-what-changed', async t => {
    const stamp = { faults: { afterDriver: (mode, { store }) => {
        if (mode !== 'writer-first') return;
        const snapshot = readStoreSnapshot({ paths: store.hostPaths, identity: store.identity });
        setAgentLimits({ paths: store.hostPaths, identity: store.identity, expectedToken: snapshot.token, agentRef: 'hwlfixture/s', limits: OVERRIDES.high, installedRefs: new Set(['hwlfixture/s']),
            capabilities: { gate: 'on', controllers: ['cpu', 'memory', 'pids'] }, envelope: { memoryBytes: 8 * 1024 ** 3, cpus: 4 }, actor: { id: 'test', name: 'test' }, lockOptions: { deadlineMs: 250 }, beforeCommit: () => true });
    } } };
    const moved = await fails(t, stamp, /The refused writer-first restart changed the Box, the policy, the stamp, the gate or the transitions/);
    assert.deepEqual(moved.context.fake.model.driverRuns.map(entry => entry.mode), ['writer-first']);
    // A Box whose process changed behind the refusal is a change as well, even though the typed refusal itself was right.
    await fails(t, { faults: { afterDriver: (mode, { statePath }) => {
        if (mode !== 'writer-first') return;
        const file = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        for (const box of Object.values(file.boxes)) box.pid = 4242;
        fs.writeFileSync(statePath, JSON.stringify(file));
    } } }, /The refused writer-first restart changed the Box, the policy, the stamp, the gate or the transitions/);
});

test('X5.c5-lifecycle-a-cancelled-driver-records-how-it-ended-so-a-proved-exit-is-cleaned-and-a-forced-one-is-preserved', async t => {
    // The block timer or an abort cancels the driver: the process group ended (its exit was proved), so the replacement the product committed is
    // followed by cleanup; the case itself is never a pass.
    const cancelled = await fails(t, { faults: { driverCancelled: 'transition' } }, /gate-off lifecycle driver was cancelled; that is neither a refusal nor a pass/);
    const intent = c5IntentOf(cancelled.context.w.run);
    assert.deepEqual([intent.state, intent.driverResult.cancelled, intent.driverResult.settlementForced], ['observed', true, false]);
    assert.deepEqual(boxIds(cancelled.context), [], 'cleanup destroyed the proven replacement');
    // A cancellation that needed a forced settlement does not prove the group ended: cleanup preserves everything.
    const forced = await fails(t, { faults: { driverCancelled: 'transition', driverForcedSettlement: 'transition' } }, /was cancelled/, { cleanup: 'failed' });
    assert.match(forced.report.cleanup.failures.join(' '), /not proven settled by the owned transport/);
    assert.equal(c5IntentOf(forced.context.w.run).driverResult.settlementForced, true);
    assert.equal(boxIds(forced.context).length, 1, 'the replacement is preserved');
});

test('X5.c5-lifecycle-the-drivers-primary-assertion-failure-stays-the-answer-and-a-missing-or-altered-receipt-is-refused', async t => {
    const primary = { kind: 'writer-outcome', message: 'The in-Box setter was not refused with hardware_limits_transition at the production stop boundary (HTTP 200, , committed)' };
    await fails(t, { faults: { afterDriver: (mode, { receiptPath }) => {
        if (mode !== 'transition') return;
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        writePrivateJson(receiptPath, { ...receipt, primaryFailure: primary, outcome: { ...receipt.outcome, state: 'failed', errorCode: 'PLOINKY_BOX_HARDWARE_TRANSITION_ROLLED_BACK' } });
    } } }, /The in-Box setter was not refused with hardware_limits_transition at the production stop boundary/);
    // A lost receipt leaves a committed replacement the product's journal alone cannot attribute to this invocation: cleanup preserves it.
    const lost = await fails(t, { faults: { afterDriver: (mode, { receiptPath }) => { if (mode === 'transition') fs.rmSync(receiptPath); } } }, /The lifecycle driver left no receipt/, { cleanup: 'failed' });
    assert.match(lost.report.cleanup.failures.join(' '), /unattributed product transition exists and the original Box is gone/);
    assert.equal(boxIds(lost.context).length, 1, 'the unattributed replacement is preserved, never adopted by name');
    const altered = await fails(t, { faults: { afterDriver: (mode, { receiptPath }) => {
        if (mode !== 'transition') return;
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        writePrivateJson(receiptPath, { ...receipt, binding: { ...receipt.binding, rootBoxId: 'c'.repeat(64) } });
    } } }, /The driver receipt is not valid/, { cleanup: 'failed' });
    assert.match(altered.report.cleanup.failures.join(' '), /invalid driver receipt or binding/);
    assert.equal(boxIds(altered.context).length, 1);
    // A driver that printed no summary cannot be certified, whatever its receipt says.
    await fails(t, { faults: { afterDriver: (mode, ctx) => { if (mode === 'transition') ctx.summary = { schema: 2 }; } } }, /did not commit the desired-off generation/);
});

test('X5.c5-lifecycle-the-final-proof-of-the-replacement-names-what-is-wrong-with-it', async t => {
    // After the driver, the replacement is inspected on its own: each deviation of the engine's own record is named by its check.
    const editReplacement = edit => ({ faults: { afterDriver: (mode, { receiptPath, statePath }) => {
        if (mode !== 'transition') return;
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        const file = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        edit(file.boxes[receipt.finalContainerId], file, receipt);
        fs.writeFileSync(statePath, JSON.stringify(file));
    } } });
    for (const [label, edit, pattern, cleanup] of [
        // A changed label or mount also changes the contract the receipt recorded, so cleanup refuses to destroy what it can no longer prove.
        ['a hardware label on the replacement', box => { box.labels['io.assistos.ploinky-box.hardware-limits'] = 'f'.repeat(64); }, /\(.*noHardwareLabel/, 'failed'],
        ['a hardware store bind on the replacement', box => { box.mounts.push({ Type: 'bind', Source: '/x', Destination: '/run/ploinky/hardware-limits', RW: true }); }, /\(.*noHardwareBinds/, 'failed'],
        ['a third publication', box => { box.portBindings['9999/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '9999' }]; }, /\(.*publications/, 'complete'],
        ['a replacement that is not running', box => { box.running = false; }, /\(.*running/, 'complete'],
        ['another source mounted', box => { box.mounts = box.mounts.map(mount => (mount.Destination === '/opt/ploinky' ? { ...mount, Source: '/other/source' } : mount)); }, /\(.*sourceMounted/, 'failed'],
        ['the old immutable ID still listed', (box, file, receipt) => { file.boxes[receipt.originalReceipt.id] = { ...box, id: receipt.originalReceipt.id }; }, /multiple current generations|old immutable Box ID is still present/, 'failed'],
    ]) {
        const outcome = await fails(t, editReplacement(edit), pattern, { cleanup });
        assert.ok(outcome.context.fake.model.driverRuns.some(entry => entry.mode === 'transition'), label);
    }
    // The Router of the replacement must answer /auth/login with 200.
    await fails(t, { seams: { ...SEAMS, http: async () => ({ status: 503, contentType: 'text/html' }) } }, /does not answer \/auth\/login with HTTP 200/);
});

test('X5.c5-lifecycle-artifacts-and-the-stager-require-the-c5-evidence-and-a-cleanup-proof-of-this-action-and-run', () => {
    // A PASS is certified only with the lifecycle evidence, the driver receipt of this invocation and, for the cleanup action, its own proof.
    const profile = { cases: ['LIVE-C5'], gpu: undefined };
    const pass = { verdict: 'PASS' };
    const invocation = 'a'.repeat(32);
    const fetched = { operations: [{ kind: 'c5-downgrade', driverReceiptName: `${C5_DRIVER_NAME}-${invocation}` }] };
    assert.deepEqual(c5RequiredArtifacts({ profile, action: 'live', remoteReport: pass, fetched }), [...C5_LIVE_ARTIFACTS, `${C5_DRIVER_NAME}-${invocation}`]);
    assert.deepEqual(c5RequiredArtifacts({ profile, action: 'cleanup', remoteReport: pass }), [C5_CLEANUP_PROOF]);
    assert.deepEqual(c5RequiredArtifacts({ profile, action: 'provision', remoteReport: pass }), []);
    assert.deepEqual(c5RequiredArtifacts({ profile, action: 'live', remoteReport: { verdict: 'FAIL' }, fetched }), []);
    assert.ok(c5RequiredArtifacts({ profile, action: 'live', remoteReport: pass, fetched: null }).includes('c5-transition-driver-missing-invocation'), 'a live PASS without a recorded invocation can never be complete');
    // The cleanup proof must be this run's, written by a cleanup action, with a valid chain entirely absent.
    const runId = 'b'.repeat(32);
    const id = value => value.repeat(64);
    const proof = { schema: 1, runId, action: 'cleanup', at: 5, chain: [id('c'), id('d')], absent: [id('c'), id('d')], remaining: [] };
    const bytes = value => Buffer.from(JSON.stringify(value));
    assert.equal(c5CleanupProofProblem(bytes(proof), { runId }), null);
    for (const [label, value, pattern] of [
        ['another run', { ...proof, runId: 'e'.repeat(32) }, /another run/], ['the live action', { ...proof, action: 'live' }, /not by this cleanup/],
        ['no time', { ...proof, at: 0 }, /no time/], ['an empty chain', { ...proof, chain: [], absent: [] }, /no valid chain/], ['a short ID', { ...proof, chain: ['abc'], absent: ['abc'] }, /no valid chain/],
        ['something remaining', { ...proof, remaining: [id('c')] }, /does not show every Box/], ['a different absent list', { ...proof, absent: [id('c')] }, /does not show every Box/],
    ]) assert.match(c5CleanupProofProblem(bytes(value), { runId }), pattern, label);
    assert.match(c5CleanupProofProblem(Buffer.from('not json'), { runId }), /not JSON/);
});

test('X5.c5-lifecycle-evaluators-accept-only-the-typed-refusal-with-zero-mutations-and-judge-transport-first', () => {
    const summary = (overrides = {}) => ({ schema: 1, outcome: { state: 'success', typedRefusal: true, errorCode: WRITER_FIRST_CODE, mutations: 0, message: 'x' }, mutations: [], runCalls: 0, ...overrides });
    const ok = { status: 0, stdout: `${JSON.stringify(summary())}\n`, timedOut: false };
    assert.equal(assertWriterFirstRefusal(ok, summary()), null);
    for (const [label, result, value, pattern] of [
        ['a timeout', { ...ok, timedOut: true }, summary(), /timed out; that is not a typed refusal/],
        ['a cancellation', { ...ok, cancelled: true }, summary(), /was cancelled/],
        ['a truncation', { ...ok, truncated: true }, summary(), /was truncated/],
        ['a forced settlement', { ...ok, settlementForced: true }, summary(), /forced settlement/],
        ['no summary', ok, null, /printed no summary/],
        ['a nonzero exit alone', { ...ok, status: 1 }, summary({ outcome: { state: 'failed', typedRefusal: false, errorCode: null } }), /nonzero exit alone is not the typed refusal/],
        ['another error code', ok, summary({ outcome: { state: 'failed', typedRefusal: false, errorCode: 'PLOINKY_BOX_HARDWARE_STATE_INVALID' } }), /was not refused with PLOINKY_BOX_HARDWARE_LIMITS_STORED/],
        ['a mutation', ok, summary({ mutations: [{ kind: 'box-stop' }] }), /lifecycle operation reached the engine runner/],
        ['a runner call', ok, summary({ runCalls: 2 }), /lifecycle operation reached the engine runner/],
    ]) assert.match(assertWriterFirstRefusal(result, value), pattern, label);
    assert.equal(transportProblem({ status: 0 }), null);
    assert.match(transportProblem({ errorCode: 'ENOENT' }), /failed to run/);
    assert.match(transportProblem({ signal: 'SIGKILL' }), /killed by SIGKILL/);
    assert.deepEqual(parseDriverSummary({ stdout: 'noise\n{"schema":1,"a":2}\n' }), { schema: 1, a: 2 });
    assert.equal(parseDriverSummary({ stdout: '{"schema":2}\n' }), null);
    assert.equal(parseDriverSummary({ stdout: 'not json\n' }), null);
    assert.ok(LIVE_CASES[BLOCK].includes('LIVE-C5'));
    assert.equal(typeof executeCleanupRun, 'function');
});
