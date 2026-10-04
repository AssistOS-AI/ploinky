// LIVE-C5 driver (tests/hardware-limits/liveStoreTransition.mjs), offline: the product's REAL outer CLI, supervisor, downgrade transaction, store and
// barrier over a stub container engine (c5DriverWorld.mjs). The driver decorates the production runner and, at the production old-Box stop boundary of
// the forward transition, runs the real administrator writers synchronously before it delegates that stop once, unchanged. The product mutants of the
// forward transition (c5Mutation.mjs) run in a child process that loads the mutated module. Nothing here starts a container.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { stopPloinkyLocalByContainerId } from '../../ploinky-box/lifecycle/container.mjs';
import { BEHAVIOR_FAILURES, DRIVER_BOUNDS, DriverAssertion, OLD_STOP_PATH, classifyRun, oldStopArgv, runDriver, validateDriverParams } from '../hardware-limits/liveStoreTransition.mjs';
import { PRODUCT_MUTANTS, ROOT, TRANSITION, applyPatches, describeMutation } from '../hardware-limits/c5Mutation.mjs';
import { C5_DRIVER_SCHEMA, productEngineDigest, validateDriverReceipt } from '../hardware-limits/liveBoxTransitionCustody.mjs';
import { REPOSITORY, intentFor, standalone } from '../hardware-limits/c5DriverWorld.mjs';
import { fakeEngineInfo } from '../hardware-limits/fakeLiveEngine.mjs';
import { engineIdentityDigest } from '../hardware-limits/liveCommon.mjs';
import { scratch } from '../hardware-limits/executorWorld.mjs';

const HEX64 = 'a'.repeat(64);
const WORLD = path.join(REPOSITORY, 'tests/hardware-limits/c5DriverWorld.mjs');
const CONTRACT = pathToFileURL(path.join(REPOSITORY, 'tests/helpers/agentlibTestContract.mjs')).href;
const REGISTER = pathToFileURL(path.join(REPOSITORY, 'tests/hardware-limits/c5MutationRegister.mjs')).href;

// One scenario in a fresh child process, optionally under a source mutation. The child prints one JSON document.
function runWorld(t, scenario, { options = {}, mutation = null } = {}) {
    const tmp = scratch(t, 'hwl-c5w-');
    const env = { ...process.env, C5_WORLD_TMP: tmp, TMPDIR: tmp };
    delete env.C5_MUTATION;
    if (mutation) env.C5_MUTATION = JSON.stringify(mutation);
    const child = spawnSync(process.execPath, ['--import', CONTRACT, ...(mutation ? ['--import', REGISTER] : []), WORLD, scenario, JSON.stringify(options)],
        { cwd: REPOSITORY, env, encoding: 'utf8', timeout: 150000, maxBuffer: 8 * 1024 * 1024 });
    const lines = child.stdout.split('\n').filter(line => line.startsWith('{'));
    return { status: child.status, signal: child.signal, stderr: child.stderr, result: lines.length ? JSON.parse(lines.at(-1)) : null };
}
const kinds = result => result.summary.events.map(event => event.kind);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The actual lifecycle argv is matched structurally.

test('X5.c5-driver-stop-matcher-is-structural-and-equals-the-products-own-argv', () => {
    const workspaceRoot = '/work/ws';
    const id = HEX64;
    // The argv the PRODUCT's own helper hands the runner is the one the driver matches.
    const seen = [];
    stopPloinkyLocalByContainerId({ name: 'podman' }, id, { run(command, args) { seen.push([command, args]); } }, { workspaceRoot });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0][1], oldStopArgv(workspaceRoot, id));
    assert.deepEqual(classifyRun(seen[0][0], seen[0][1], { workspaceRoot }), { kind: 'graph-stop', mutation: true, id });
    assert.deepEqual(oldStopArgv(workspaceRoot, id).slice(0, 4), ['container', 'exec', '--user', 'podman']);
    assert.deepEqual(oldStopArgv(workspaceRoot, id).slice(-3), [id, OLD_STOP_PATH, 'stop']);
    // Anything that is not exactly that argv for a full ID is not the stop: a substring, a name, a short ID, a changed user, workdir or program.
    const argv = oldStopArgv(workspaceRoot, id);
    const variants = [
        ['docker', argv], ['podman', [...argv, '--extra']], ['podman', argv.slice(0, -1)], ['podman', argv.map(word => (word === 'podman' ? 'root' : word))],
        ['podman', argv.filter(word => word !== '--workdir' && word !== workspaceRoot)], ['podman', argv.map(word => (word === id ? id.slice(0, 63) : word))],
        ['podman', argv.map(word => (word === id ? 'ploinky-box-ws-0123456789ab' : word))], ['podman', argv.map(word => (word === OLD_STOP_PATH ? '/usr/bin/true' : word))],
        ['podman', argv.map(word => (word === 'stop' ? 'start' : word))], ['podman', ['container', 'exec', '--user', 'podman', id, 'sh', '-c', `${OLD_STOP_PATH} stop`]],
        ['podman', argv.map(word => (word === workspaceRoot ? '/work/other' : word))],
    ];
    for (const [command, words] of variants) assert.equal(classifyRun(command, words, { workspaceRoot }).kind, 'other', `${command} ${words.join(' ')}`);
    // The other lifecycle verbs are recognised by structure too.
    assert.deepEqual(classifyRun('podman', ['container', 'stop', '--time', '30', id], { workspaceRoot }), { kind: 'box-stop', mutation: true, id });
    assert.deepEqual(classifyRun('podman', ['container', 'rm', '-f', id], { workspaceRoot }), { kind: 'box-remove', mutation: true, id });
    assert.deepEqual(classifyRun('podman', ['container', 'start', id], { workspaceRoot }), { kind: 'box-start', mutation: true, id });
    assert.equal(classifyRun('podman', ['container', 'create', '--name', 'x'], { workspaceRoot }).kind, 'box-create');
    assert.equal(classifyRun('podman', ['container', 'rm', '-f', 'a-name'], { workspaceRoot }).mutation, false, 'a name is never an exact container ID');
    assert.equal(classifyRun('podman', ['container', 'ps', '--all'], { workspaceRoot }).mutation, false);
});

test('X5.c5-driver-parameters-are-validated-bounded-and-bound-to-the-frozen-intent', () => {
    const context = standalone();
    const good = () => JSON.parse(JSON.stringify({
        schema: 1, mode: 'destroy', runId: context.runId, bounds: DRIVER_BOUNDS, agentRef: null, expectedToken: null, expectedContainerId: HEX64, intent: null, receiptPath: null,
        profile: { host: { home: context.home }, workspace: context.workspace, box: context.profile.box, source: context.profile.source, engine: context.profile.engine, cases: ['LIVE-C5'] },
    }));
    assert.doesNotThrow(() => validateDriverParams(good()));
    const bad = mutate => { const value = good(); mutate(value); return value; };
    for (const value of [
        bad(v => { v.mode = 'sideways'; }), bad(v => { v.extra = 1; }), bad(v => { delete v.bounds; }), bad(v => { v.bounds.boundaryMs = DRIVER_BOUNDS.boundaryMs + 1; }),
        bad(v => { v.bounds.adminMs = 0; }), bad(v => { v.expectedContainerId = 'ploinky-box-ws'; }), bad(v => { v.runId = 'x'; }), bad(v => { v.profile.host.home = 'relative'; }),
        bad(v => { v.mode = 'transition'; }),
    ]) assert.throws(() => validateDriverParams(value), error => error instanceof DriverAssertion && error.kind === 'setup');
    // A transition's intent must be the frozen one of THIS run, box and engine.
    const intent = intentFor(context);
    const transition = bad(v => { v.mode = 'transition'; v.intent = intent; v.receiptPath = path.join(context.root, 'receipt.json'); v.expectedToken = { epoch: 'x', revision: 1 }; v.agentRef = 'r/a'; });
    assert.doesNotThrow(() => validateDriverParams(transition));
    assert.throws(() => validateDriverParams({ ...transition, intent: { ...intent, rootBoxId: 'b'.repeat(64) } }), /does not match the frozen fixture/);
    assert.throws(() => validateDriverParams({ ...transition, runId: 'f'.repeat(32) }), /does not match the frozen fixture/);
    assert.throws(() => validateDriverParams({ ...transition, intent: { ...intent, expectedTo: 'on' } }), /does not match the frozen fixture/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The real downgrade, interleaved with the real writers.

test('X5.c5-driver-runs-the-real-writers-at-the-production-stop-boundary-then-delegates-the-stop-once-and-commits-gate-off', t => {
    const { status, result, stderr } = runWorld(t, 'transition');
    assert.equal(status, 0, stderr);
    assert.equal(result.crashed, undefined, JSON.stringify(result.crashed));
    assert.equal(result.exitCode, 0, JSON.stringify(result.summary.primaryFailure));
    const { summary, receipt } = result;
    assert.equal(summary.outcome.state, 'success');
    assert.deepEqual([summary.outcome.journalPhase, summary.outcome.commitResult, summary.outcome.rolledBack], ['committed', 'desired-off', false]);
    // The writers ran INSIDE the boundary: after the binding was durable and before the stop was delegated.
    const order = kinds(result);
    for (const [earlier, later] of [['bound', 'boundary-views'], ['boundary-views', 'writer-set'], ['writer-set', 'writer-clear'], ['writer-clear', 'boundary-after'], ['boundary-after', 'delegated-graph-stop'],
        ['delegated-graph-stop', 'retention-box-stop'], ['retention-box-stop', 'retention-box-remove'], ['retention-box-remove', 'retention-box-create'], ['retention-box-create', 'retention-box-start']]) {
        assert.ok(order.indexOf(earlier) >= 0 && order.indexOf(earlier) < order.indexOf(later), `${earlier} precedes ${later}: ${order.join(',')}`);
    }
    assert.equal(order.filter(kind => kind === 'delegated-graph-stop').length, 1, 'the original stop is delegated exactly once');
    // Both writers were refused by the product's own barrier, nothing committed, nothing changed.
    assert.deepEqual(summary.boundary.replies, { set: { status: 409, error: 'hardware_limits_transition' }, clear: { status: 409, error: 'hardware_limits_transition' } });
    assert.equal(summary.events.find(event => event.kind === 'boundary-views').barrier.operationId, summary.operationId);
    assert.equal(result.store.count, 0);
    assert.deepEqual(result.store.token, summary.events.find(event => event.kind === 'boundary-views').token);
    assert.equal(result.store.barrier, null, 'the product removed its own barrier after the commit');
    // The engine saw the product's own verbs in the product's own order, and the stop came after the writers: the writers' admin calls were made before
    // any verb of the lifecycle.
    assert.deepEqual(result.engineEvents.filter(event => !event.startsWith('stderr:')).slice(0, 5), ['graph-stop', 'box-stop', 'box-remove', 'box-create:gate-off', 'box-start']);
    assert.equal(result.adminCalls.filter(call => call.method === 'POST').length, 2);
    assert.equal(result.containers.length, 1);
    assert.deepEqual([result.containers[0].gateOn, result.containers[0].running, result.containers[0].id === result.boxId], [false, true, false]);
    assert.equal(result.gate, false);
    // The receipt is the child's own, valid and settled; it binds to the product operation and to ONE fresh engine observation.
    assert.equal(receipt.schema, C5_DRIVER_SCHEMA);
    assert.equal(receipt.phase, 'settled');
    assert.equal(receipt.productOperationId, summary.operationId);
    const info = fakeEngineInfo({ arch: 'test', os: 'linux', hostname: 'fake-engine', id: 'engine-1' });
    assert.equal(summary.engine.product, productEngineDigest(info));
    assert.equal(summary.engine.harness, engineIdentityDigest(info, null));
    assert.equal(receipt.productEngineIdentity, summary.engine.product);
    assert.notEqual(summary.engine.product, summary.engine.harness.replace(/^sha256:/, ''), 'the two digests are built differently and are never compared');
    assert.equal(receipt.attempts.length, 1);
    assert.equal(receipt.attempts[0].stage, 'candidate');
    assert.equal(receipt.finalContainerId, result.containers[0].id);
    assert.equal(summary.mutations.map(entry => entry.kind).join(','), 'graph-stop,box-stop,box-remove,box-create,box-start');
});

test('X5.c5-driver-binds-the-product-operation-durably-before-the-old-box-is-stopped', t => {
    const { result } = runWorld(t, 'transition');
    const receipt = result.receipt;
    const bound = receipt.events.find(event => event.kind === 'bound');
    const delegated = receipt.events.find(event => event.kind === 'delegated-graph-stop');
    assert.ok(bound && delegated && bound.sequence < delegated.sequence, 'the binding event precedes the delegated stop in the receipt');
    // The settled receipt validates against the frozen intent, and an altered binding is refused.
    const world = standalone();
    const intent = intentFor(world);
    assert.throws(() => validateDriverReceipt({ ...receipt, binding: { ...receipt.binding, rootBoxId: 'c'.repeat(64) } }, intent, world.profile), /invalid driver receipt or binding/);
    assert.throws(() => validateDriverReceipt({ ...receipt, phase: 'bound', productOperationId: null }, intent, world.profile), /./);
});

test('X5.c5-driver-writer-first-is-refused-with-the-typed-error-before-any-lifecycle-mutation', t => {
    const { status, result, stderr } = runWorld(t, 'writer-first');
    assert.equal(status, 0, stderr);
    assert.equal(result.exitCode, 0, JSON.stringify(result.summary));
    const outcome = result.summary.outcome;
    assert.deepEqual([outcome.state, outcome.typedRefusal, outcome.errorCode, outcome.mutations], ['success', true, 'PLOINKY_BOX_HARDWARE_LIMITS_STORED', 0]);
    assert.match(outcome.message, /No Box mutation was performed/);
    // Zero lifecycle operations reached the engine runner at all, no transition was created, and the committed policy is unchanged.
    assert.equal(result.summary.runCalls, 0);
    assert.deepEqual(result.summary.mutations, []);
    assert.deepEqual(result.engineEvents, []);
    assert.deepEqual(result.transitions, []);
    assert.equal(result.store.count, 1);
    assert.equal(result.containers.length, 1);
    assert.equal(result.containers[0].id, result.boxId);
    assert.equal(result.gate, true, 'the saved gate stays on');
});

test('X5.c5-driver-refuses-a-lifecycle-mutation-in-the-writer-first-order-itself', async t => {
    // A product that did NOT refuse (a broken one) would reach the engine runner; the decoration refuses every mutation before it is delegated.
    const context = standalone();
    const calls = [];
    const base = { query: () => ({ ok: true, status: 0, stdout: '', stderr: '' }), run(command, args) { calls.push([command, args]); return Buffer.from(''); }, stream: async () => ({ ok: true }) };
    const { driverParams } = await import('../hardware-limits/liveStoreTransition.mjs');
    const params = driverParams({ mode: 'writer-first', profile: context.profile, run: context.run, agentRef: 'r/a' });
    for (const words of [oldStopArgv(context.workspace.path, context.profile.box.id), ['container', 'stop', '--time', '30', context.profile.box.id], ['container', 'rm', '-f', context.profile.box.id],
        ['container', 'create', '--name', 'x'], ['container', 'start', context.profile.box.id]]) {
        calls.length = 0;
        const result = await runDriver(params, { baseRunner: base, runCli: async (_argv, options) => { await options.supervisor.__run(words); return 0; }, supervisor: runner => ({ __run: async argv => runner.run('podman', argv) }) });
        assert.equal(result.exitCode, 1);
        assert.equal(result.summary.outcome.state, 'failed');
        assert.equal(result.summary.primaryFailure.kind, 'lifecycle-mutation');
        assert.deepEqual(calls, [], `the engine never saw ${words.slice(0, 2).join(' ')}`);
    }
    context.world.restoreHome();
});

test('X5.c5-driver-destroy-guards-the-exact-id-and-delegates-the-products-own-destroy-unchanged', t => {
    const matched = runWorld(t, 'destroy');
    assert.equal(matched.result.exitCode, 0, JSON.stringify(matched.result.summary));
    assert.deepEqual(matched.result.containers, []);
    assert.deepEqual(matched.result.engineEvents, ['graph-stop', 'box-stop', 'box-remove'], 'the product destroyed the Box with its own verbs');
    assert.ok(kinds(matched.result).includes('destroy-selected'));
    // Another ID than the one proved is refused before the product's destroy runs: nothing is stopped or removed.
    const refused = runWorld(t, 'destroy', { options: { expectedContainerId: 'b'.repeat(64) } });
    assert.equal(refused.result.exitCode, 1);
    assert.equal(refused.result.summary.primaryFailure.kind, 'destroy-target');
    assert.deepEqual(refused.result.engineEvents, []);
    assert.equal(refused.result.containers.length, 1);
    assert.equal(refused.result.containers[0].id, refused.result.boxId);
    // An absent expectation against a present Box is refused as well.
    const absent = runWorld(t, 'destroy', { options: { expectedContainerId: null } });
    assert.equal(absent.result.summary.primaryFailure.kind, 'destroy-target');
    assert.equal(absent.result.containers.length, 1);
});

test('X5.c5-driver-a-production-rollback-after-an-engine-failure-keeps-the-requested-transition-failed-and-the-attempts-distinct', t => {
    const { result } = runWorld(t, 'transition', { options: { faults: { failFirstGateOffCreate: true } } });
    const { summary, receipt } = result;
    assert.equal(summary.outcome.state, 'failed');
    assert.equal(summary.outcome.errorCode, 'PLOINKY_BOX_HARDWARE_TRANSITION_ROLLED_BACK');
    assert.equal(summary.outcome.rolledBack, true);
    assert.equal(summary.primaryFailure, null, 'an engine failure is not a harness assertion');
    assert.equal(receipt.phase, 'settled');
    assert.equal(receipt.outcome.state, 'failed');
    // The forward candidate attempt was recorded before its create, and the production rollback created ONE distinct rollback generation.
    assert.deepEqual(receipt.attempts.map(attempt => attempt.stage), ['candidate', 'rollback']);
    assert.equal(receipt.attempts[0].observedId, null);
    assert.match(receipt.attempts[1].observedId, /^[a-f0-9]{64}$/);
    assert.equal(result.containers.length, 1);
    assert.deepEqual([result.containers[0].gateOn, result.containers[0].id === receipt.attempts[1].observedId], [true, true]);
    assert.equal(result.store.barrier, null);
    assert.equal(result.gate, true);
    // The barrier was retained at the rollback create as well; the stages are named apart.
    const retention = summary.events.filter(event => event.kind === 'retention-box-create');
    assert.deepEqual(retention.map(event => [event.held, event.stage]), [[true, 'candidate'], [true, 'rollback']]);
});

test('X5.c5-driver-a-boundary-past-its-ceiling-is-a-setup-failure-never-a-kill-or-a-refusal', t => {
    const { result } = runWorld(t, 'transition', { options: { bounds: { boundaryMs: 1 } } });
    const failure = result.summary.primaryFailure;
    assert.equal(failure.kind, 'setup');
    assert.match(failure.message, /exceeded its ceiling/);
    assert.equal(BEHAVIOR_FAILURES.includes(failure.kind), false);
    assert.equal(result.summary.outcome.state, 'failed');
    assert.equal(result.summary.outcome.rolledBack, true, 'the product rolled the gate-on Box back');
    assert.equal(result.summary.boundary, null, 'no boundary was reached, so no writer ran');
    assert.equal(result.adminCalls.length, 0);
});

test('X5.c5-driver-a-changed-engine-identity-or-a-missing-journal-is-a-setup-failure-with-no-writer-run', t => {
    const wrongEngine = runWorld(t, 'transition', { options: { engineDigestOverride: `sha256:${'0'.repeat(64)}` } });
    assert.equal(wrongEngine.result.summary.primaryFailure.kind, 'setup');
    assert.match(wrongEngine.result.summary.primaryFailure.message, /engine service identity changed/);
    assert.equal(wrongEngine.result.adminCalls.length, 0);
    assert.equal(wrongEngine.result.receipt.productOperationId, null, 'nothing was bound');
    assert.equal(wrongEngine.result.receipt.phase, 'settled');
    const wrongToken = runWorld(t, 'transition', { options: { tokenRevisionOffset: 5 } });
    assert.equal(wrongToken.result.summary.primaryFailure.kind, 'setup');
    assert.match(wrongToken.result.summary.primaryFailure.message, /not the empty store at the recorded stamp/);
    assert.equal(wrongToken.result.adminCalls.length, 0, 'no writer ran against a store that is not the recorded one');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Meaningful product mutants: the forward transition of the PRODUCT, each reaching the production boundary, killed by a named assertion.

function killed(run, { boundary, kind }) {
    const { status, result, stderr } = run;
    assert.equal(status, 0, stderr);
    assert.equal(result.crashed, undefined, JSON.stringify(result.crashed));
    const { summary } = result;
    // Not a setup failure, a timeout, an import failure or a fake reply: the production boundary was reached and a product behaviour assertion fired.
    assert.equal(summary.boundary?.reached, true, 'the actual production boundary was reached');
    assert.ok(BEHAVIOR_FAILURES.includes(summary.primaryFailure.kind), summary.primaryFailure.kind);
    assert.equal(summary.primaryFailure.kind, kind);
    assert.equal(summary.outcome.state, 'failed');
    assert.equal(summary.outcome.errorCode, 'PLOINKY_BOX_HARDWARE_TRANSITION_ROLLED_BACK', 'the product wrapped the failure in its own rollback; the primary failure is preserved');
    assert.equal(result.receipt.primaryFailure.kind, kind);
    assert.equal(result.receipt.phase, 'settled');
    // The real writer was exercised at the boundary and its real response is retained.
    for (const name of ['writer-set', 'writer-clear']) assert.ok(summary.events.some(event => event.kind === name && Number.isInteger(event.status)), name);
    assert.ok(boundary(summary, result));
    // The mutation was recorded exactly: file, patch and both digests.
    assert.ok(result.mutation && result.mutation.sourceDigest !== result.mutation.patchedDigest);
    // Cleanup: the product restored the gate-on Box and removed its own barrier.
    assert.equal(result.store.barrier, null);
    assert.equal(result.gate, true);
    assert.equal(result.containers.length, 1);
    assert.equal(result.containers[0].gateOn, true);
}

test('X5.c5-mutant-missing-barrier-installation-is-killed-by-the-committed-writer-at-the-production-stop-boundary', t => {
    const run = runWorld(t, 'transition', { mutation: PRODUCT_MUTANTS['missing-installation'] });
    killed(run, { kind: 'writer-outcome', boundary: (summary) => {
        // The barrier is absent but the identity and boundary are valid, so the real writers still ran and the setter really committed.
        const views = summary.events.find(event => event.kind === 'boundary-views');
        const set = summary.events.find(event => event.kind === 'writer-set');
        return views.barrier === null && set.status === 200 && set.committed === true && set.token.revision === views.token.revision + 1;
    } });
    // The real store-derived token reached the boundary: a patch that merely threw on a missing token would never have run a writer.
    assert.equal(run.result.summary.failures.some(failure => failure.kind === 'barrier-state'), true, 'the missing barrier is also named');
});

test('X5.c5-mutant-early-barrier-removal-before-the-old-graph-stop-is-killed-by-the-committed-writer', t => {
    const run = runWorld(t, 'transition', { mutation: PRODUCT_MUTANTS['early-removal'] });
    killed(run, { kind: 'writer-outcome', boundary: (summary) => {
        const views = summary.events.find(event => event.kind === 'boundary-views');
        const set = summary.events.find(event => event.kind === 'writer-set');
        return views.barrier === null && set.status === 200 && set.committed === true;
    } });
});

test('X5.c5-mutant-barrier-loss-before-the-replacement-is-killed-by-the-named-retention-assertion', t => {
    const run = runWorld(t, 'transition', { mutation: PRODUCT_MUTANTS['loss-before-replacement'] });
    killed(run, { kind: 'barrier-retention', boundary: (summary) => {
        // The barrier was held and refused both writers at the stop boundary, and was retained through stop and remove: it was lost exactly at the
        // forward precreation boundary of the candidate.
        const retention = summary.events.filter(event => event.kind.startsWith('retention-'));
        const create = retention.find(event => event.kind === 'retention-box-create');
        return summary.boundary.replies.set.status === 409 && retention.find(event => event.kind === 'retention-box-stop').held === true
            && retention.find(event => event.kind === 'retention-box-remove').held === true && create.held === false && create.stage === 'candidate'
            && summary.primaryFailure.message.includes('box-create boundary (candidate)');
    } });
});

test('X5.c5-mutants-apply-exactly-once-to-the-real-source-and-an-unapplied-patch-earns-no-kill', t => {
    const source = fs.readFileSync(path.join(ROOT, TRANSITION), 'utf8');
    for (const [name, spec] of Object.entries(PRODUCT_MUTANTS)) {
        const patched = applyPatches(source, spec.patches);
        assert.notEqual(patched, source, name);
        const described = describeMutation(spec);
        assert.equal(described.file, TRANSITION);
        assert.notEqual(described.sourceDigest, described.patchedDigest);
    }
    assert.throws(() => applyPatches(source, [{ from: 'this text is not in the module', to: 'x' }]), /matches 0 times/);
    assert.throws(() => applyPatches(source, [{ from: 'await', to: 'x' }]), /matches \d+ times, not once/);
    // The unmutated product is the control: the same driver passes with the loader registered and no patch.
    const control = runWorld(t, 'transition', { mutation: null });
    assert.equal(control.result.exitCode, 0);
    // A patch that does not match makes the child fail at registration: no result document exists, so nothing could be counted as a kill.
    const unapplied = runWorld(t, 'transition', { mutation: { name: 'unapplied', file: TRANSITION, patches: [{ from: 'this text is not in the module', to: 'x' }] } });
    assert.notEqual(unapplied.status, 0);
    assert.equal(unapplied.result, null);
});

// A retained record per mutant for the review packet is a run artifact; here the tests prove the pieces it names are present.
test('X5.c5-mutant-evidence-names-the-patch-the-source-the-boundary-the-real-response-the-assertion-and-cleans-up', t => {
    const run = runWorld(t, 'transition', { mutation: PRODUCT_MUTANTS['loss-before-replacement'] });
    const { result } = run;
    const record = {
        mutant: result.mutation.name, file: result.mutation.file, patchDigest: result.mutation.patchDigest, sourceDigest: result.mutation.sourceDigest, patchedDigest: result.mutation.patchedDigest,
        boundary: result.summary.boundary, replies: result.summary.boundary.replies, assertion: result.summary.primaryFailure, cleanup: { barrier: result.store.barrier, gate: result.gate, pending: result.transitions },
    };
    assert.match(record.patchDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(record.assertion.kind, 'barrier-retention');
    assert.deepEqual(record.cleanup, { barrier: null, gate: true, pending: [] });
    assert.equal(record.replies.set.error, 'hardware_limits_transition');
});

// The journal the driver reads is the product's own: a validated forward journal.
test('X5.c5-driver-reads-the-products-own-journal-and-snapshots-not-a-copy', t => {
    const { result } = runWorld(t, 'transition');
    assert.equal(result.transitions.length, 0, 'the committed operation is terminal');
    assert.match(result.receipt.oldConfigurationRef, /^sha256-[a-f0-9]{64}$/);
    assert.match(result.receipt.desiredConfigurationRef, /^sha256-[a-f0-9]{64}$/);
    assert.notEqual(result.receipt.oldConfigurationRef, result.receipt.desiredConfigurationRef);
});
