// Step-4 executors (release plan C8b), checkpoint E3a: LIVE-C5 on native Linux (spec 15.4 :1326): a host writer and an in-Box writer of the hardware
// policy store over the shared mount and its lock, the downgrade barrier interleaved with both, and stale-lock recovery with a stopped Box.
// Offline. The store, its lock, its stamp, its barrier and the recovery are the PRODUCT's own modules running over a real private directory; the
// reviewed STORE_PROGRAM runs for real as a node child process; only the Router route, the CLI glue and the engine are the model of
// fakeLiveStore.mjs. Nothing here starts a container.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { candidateArgvProblem, candidateOperationsOf } from '../hardware-limits/candidateArgv.mjs';
import { CASE_PASS_CONDITIONS, CONCRETE_BLOCKS, renderSummary, validatePins } from '../hardware-limits/liveManifest.mjs';
import { LIVE_CASES, UNSUPPORTED, executeLiveRun, validateProfile } from '../hardware-limits/liveHarness.mjs';
import { fixturePlan, provisionRun, validateProvisionPlan } from '../hardware-limits/liveFixture.mjs';
import {
    BARRIER_MESSAGE, BOX_PRODUCT_ROOT, BOX_STORE_ROOT, C5_AGENTS, OVERRIDES, RECOVERY_REFUSALS, STORE_BOUNDS, STORE_LOCK_DEADLINE_MS, STORE_PROGRAM, assertCommitted, assertHolderReleased, assertHostClearRefused, assertLockNotStolen,
    assertRefusedWrite, assertSameStore, assertValidStore, boxProgramWords, hostProgramWords, hostStoreRoot, parseProgramLines, sameLock, sameOwner, storeProgramParams, tokenKey,
} from '../hardware-limits/liveStoreCommands.mjs';
import { createFakeStore } from '../hardware-limits/fakeLiveStore.mjs';
import { world, free, scratch } from '../hardware-limits/executorWorld.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { BOX_STORE_ROOT as PRODUCT_BOX_STORE_ROOT, hardwareStorePaths, initializeStore, setAgentLimits, readStoreSnapshot } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { STORE_BUSY_MESSAGE, recoverStaleStoreLock } from '../../cli/sandbox/hardwareLimits/storeLock.mjs';

const BLOCK = 'apparatus-store';
const REPOSITORY = fs.realpathSync(new URL('../..', import.meta.url).pathname);
const real = ms => new Promise(resolve => setTimeout(resolve, ms));
const SEAMS = { sleep: real, polling: { deadlineMs: 15000, intervalMs: 20 } };
const CASE_KEYS = ['baseline', 'visibility', 'cas-race', 'stale-setter', 'host-box-race', 'lock-host-held', 'lock-box-held', 'barrier', 'stale-box-lock', 'stale-host-live', 'stale-host-dead', 'final'];

async function liveWorld(t, { faults = {}, block = BLOCK } = {}) {
    const w = world(t, { block });
    const workspace = w.run.target.execution.provision.workspace.path;
    const fake = createFakeStore({ base: { provider: w.engineProvider, node: w.node, statePath: w.statePath }, workspace, home: w.home, faults });
    const report = await provisionRun({ run: w.run, persist: w.persist, processProvider: fake.provider, portProbe: free, hostIdentity: w.hostIdentity, remoteArrival: w.remote, validateProfile });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    return { w, fake, workspace };
}
async function liveRun(context, { mutate = null, seams = SEAMS } = {}) {
    const { w, fake } = context;
    const artifacts = new Map();
    const provider = mutate ? async (binary, args, options) => { mutate(args); return fake.provider(binary, args, options); } : fake.provider;
    const report = await executeLiveRun({ run: w.run, hostIdentity: w.hostIdentity, processProvider: provider, persist: w.persist, remoteArrival: true,
        artifacts: (name, value) => artifacts.set(name, structuredClone(value)), storeSeams: seams });
    return { report, artifacts, case: report.cases.find(entry => entry.id === 'LIVE-C5') };
}
const failsWith = async (t, faults, pattern, { result = 'fail', seams } = {}) => {
    const context = await liveWorld(t, { faults });
    const outcome = await liveRun(context, seams ? { seams } : {});
    assert.equal(outcome.case.result, result, `${JSON.stringify(faults)}: ${JSON.stringify(outcome.case).slice(0, 700)}`);
    assert.match(outcome.case.reason, pattern, `${JSON.stringify(faults)}: ${outcome.case.reason}`);
    assert.equal(outcome.report.cleanup.state, 'complete', 'the cleanup action still destroys the Box and removes everything');
    assert.equal(context.fake.model.children.size, 0, 'no program, holder or writer is left running when the case returns');
    return { ...outcome, context };
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Wiring: the block, the fixture, the summary the monitor approves.

test('X5.c5-block-fixture-pins-and-deadlines-are-wired', t => {
    assert.deepEqual(CONCRETE_BLOCKS[BLOCK], { platform: 'linux', remote: true, cases: ['LIVE-C5'], store: true });
    assert.deepEqual(LIVE_CASES[BLOCK], ['LIVE-C5']);
    assert.equal(UNSUPPORTED['LIVE-C5'], undefined, 'LIVE-C5 is implemented');
    assert.deepEqual(fixturePlan(['LIVE-C5']), C5_AGENTS.map(name => ({ name, role: name, hardwareLimits: null })));
    const w = world(t, { block: BLOCK });
    assert.doesNotThrow(() => validateProvisionPlan(w.run.target.execution.provision, w.run));
    assert.equal(w.run.target.execution.fixtures.store.ref, 'hwlfixture/s');
    assert.equal(w.run.deadlines.blockMs, 30 * 60 * 1000);
    assert.doesNotThrow(() => validatePins(w.pins, BLOCK));
    // The profile is consistent: LIVE-C5 needs the owned agent s alone.
    const profile = structuredClone(w.run); profile.target.execution.cases = ['LIVE-C5'];
    assert.doesNotThrow(() => validateProfile(profile, { partial: true }));
});

test('X5.c5-manifest-and-summary-name-the-spec-row-the-writers-the-program-every-bound-and-the-open-points-and-every-candidate-argv-is-accepted', t => {
    const w = world(t, { block: BLOCK });
    const summary = renderSummary(w.run, w.runPath);
    const sha = crypto.createHash('sha256').update(STORE_PROGRAM).digest('hex');
    for (const text of ['| LIVE-C5 | spec 15.4 LIVE-C5 (:1326', '## Store fixture', '## Foreign-workspace guard', 'limits clear --agent hwlfixture/s', "the Router's administrator route", sha, 'STORE_PROGRAM in tests/hardware-limits/liveStoreCommands.mjs',
        BOX_STORE_ROOT, BOX_PRODUCT_ROOT, hostStoreRoot(w.run.target.execution.host.home, w.run.workspace.instance), `${STORE_BOUNDS.holdMs} ms`, `${STORE_BOUNDS.staleHoldMs} ms`,
        `${STORE_BOUNDS.raceRounds} race rounds`, 'STOPPED by `ploinky stop`', 'destroys it with `destroy --delete-cache`', 'keep-id mapping', 'never deleted by the runner', 'C5-hold-host', 'C5-hold-box', 'C5-abandon-host-lock',
        'C5-barrier-begin', 'C5-gate-off-check', 'C5-stop', '<STORE_PROGRAM>', 'One conflicting mutation wins and the other conflicts', 'No lost clear', 'No live lock theft', 'a gate-off start is refused stored_limits_present']) {
        assert.ok(summary.includes(text), text);
    }
    // The pass condition carries the spec's four clauses, unchanged.
    const passes = CASE_PASS_CONDITIONS['LIVE-C5'].passes;
    for (const clause of ['One conflicting mutation wins and the other conflicts', 'No lost clear', 'no gate-off Box with newly committed policy', 'No live lock theft']) assert.ok(passes.toLowerCase().includes(clause.toLowerCase()) || summary.toLowerCase().includes(clause.toLowerCase()), clause);
    const operations = candidateOperationsOf(w.run);
    assert.ok(operations.length >= 2);
    for (const operation of operations) assert.equal(candidateArgvProblem(operation.argv), null, operation.argv.join(' '));
    assert.ok(operations.some(entry => entry.argv[1] === 'stop') && operations.some(entry => entry.argv[1] === 'limits' && entry.argv[2] === 'clear'));
    assert.equal(summary.includes(w.pins.ssh.identityFile ?? 'no-identity'), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The reviewed program, for real, over a real store.

function realStore(t) {
    const root = scratch(t, 'hwl-c5-');
    const home = path.join(root, 'home'); fs.mkdirSync(home, { mode: 0o700 });
    const workspace = path.join(root, 'ws'); fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(fs.realpathSync(workspace));
    const paths = hardwareStorePaths({ identity, homeDirectory: home });
    initializeStore({ paths, identity });
    const profile = { host: { home }, source: { root: REPOSITORY } };
    const run = (mode, extra = {}, domain = 'host') => new Promise(resolve => {
        const params = storeProgramParams({ profile, identity, domain, mode, ...extra });
        const child = spawn(process.execPath, hostProgramWords(params), { env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', (code, signal) => resolve({ status: code, signal, stdout, stderr, lines: parseProgramLines(stdout) }));
    });
    return { home, identity, paths, profile, run };
}

test('X5.c5-params-and-argv-use-the-products-own-roots-and-the-box-exec-runs-as-the-box-user', () => {
    assert.equal(BOX_STORE_ROOT, PRODUCT_BOX_STORE_ROOT); assert.equal(BOX_STORE_ROOT, '/run/ploinky/hardware-limits'); assert.equal(BOX_PRODUCT_ROOT, '/opt/ploinky');
    const identity = { instance: 'ploinky-box-ws-abcdef012345', pathHash: 'abcdef012345', workspaceRoot: '/work/ws' };
    const profile = { host: { home: '/home/x' }, source: { root: '/staged/source' } };
    const host = storeProgramParams({ profile, identity, domain: 'host', mode: 'inspect' });
    assert.equal(host.storeRoot, hardwareStorePaths({ identity, homeDirectory: '/home/x' }).storeRoot); assert.equal(host.root, '/staged/source'); assert.equal(host.home, '/home/x');
    const box = storeProgramParams({ profile, identity, domain: 'box', mode: 'hold', holdMs: 7 });
    assert.equal(box.storeRoot, BOX_STORE_ROOT); assert.equal(box.root, BOX_PRODUCT_ROOT); assert.equal(box.home, undefined); assert.equal(box.holdMs, 7);
    assert.deepEqual(boxProgramWords('b'.repeat(64), box).slice(0, 7), ['container', 'exec', '--user', 'podman', 'b'.repeat(64), 'node', '--input-type=module']);
    assert.deepEqual(boxProgramWords('b'.repeat(64), box).slice(-2), [STORE_PROGRAM, JSON.stringify(box)]);
    assert.deepEqual(hostProgramWords(host).slice(0, 2), ['--input-type=module', '-e']);
    assert.throws(() => storeProgramParams({ profile, identity, domain: 'sideways', mode: 'inspect' }));
    // A held lock outlasts the product's own wait by a margin, and the stale holder is bounded far above the stop it waits for.
    assert.ok(STORE_BOUNDS.holdMs >= STORE_LOCK_DEADLINE_MS + 5000, 'a live holder outlasts the contender\'s wait');
    assert.ok(STORE_BOUNDS.staleHoldMs > 2 * STORE_BOUNDS.holdMs && STORE_BOUNDS.staleHoldMs <= 300000);
});

test('X5.c5-the-program-inspects-holds-abandons-and-reports-the-product-s-own-answers-over-a-real-store', async t => {
    const store = realStore(t);
    // inspect: the fresh store as the product reads it.
    const fresh = await store.run('inspect');
    assert.equal(fresh.status, 0, fresh.stderr);
    const view = assertValidStore(fresh.lines[0], 'fresh');
    assert.deepEqual([view.count, view.lock, view.barrier, view.quarantined, view.token.revision, view.uid], [0, null, null, [], 1, process.getuid()]);
    // hold: a live holder shows its lock; a second holder is refused store_busy (never takes it); the first releases its own lock.
    const holder = store.run('hold', { holdMs: 1500 });
    for (let i = 0; i < 200 && !(await store.run('inspect')).lines?.[0]?.lock; i += 1) await real(25);
    const during = assertValidStore((await store.run('inspect')).lines[0], 'during');
    assert.equal(during.lock.domain, 'host'); assert.equal(during.lock.pid !== process.pid, true);
    const contender = await store.run('hold', { holdMs: 0, acquireMs: 100 });
    assert.deepEqual([contender.lines[0].ok, contender.lines[0].code, contender.lines[0].status], [false, 'store_busy', 409]);
    assert.match(contender.lines[0].message, new RegExp(STORE_BUSY_MESSAGE.slice(0, 30)));
    const held = await holder;
    assert.equal(held.status, 0, held.stderr);
    assert.deepEqual(held.lines.map(line => line.phase), ['held', 'released']);
    assert.equal(held.lines[0].token, during.lock.token);
    assert.doesNotThrow(() => assertHolderReleased(held.lines, 'holder'));
    assert.equal(assertValidStore((await store.run('inspect')).lines[0], 'after').lock, null);
    // stale: the lock stays behind with a dead pid; the product's own recovery quarantines it and the program reads the quarantine.
    const abandoned = await store.run('stale');
    assert.equal(abandoned.lines[0].phase, 'held'); assert.equal(abandoned.status, 0);
    const left = assertValidStore((await store.run('inspect')).lines[0], 'left');
    assert.equal(left.lock.token, abandoned.lines[0].token); assert.equal(left.lock.pid, abandoned.lines[0].pid);
    const recovered = recoverStaleStoreLock({ storeRoot: store.paths.storeRoot, hostLock: { assertHeld() {} }, instance: store.identity.instance, inspectBox: () => ({ state: 'stopped' }) });
    assert.equal(recovered.recovered, true);
    const quarantined = assertValidStore((await store.run('inspect')).lines[0], 'quarantined');
    assert.deepEqual([quarantined.lock, quarantined.quarantined.length, quarantined.quarantined[0].ownerToken], [null, 1, abandoned.lines[0].token]);
});

test('X5.c5-the-program-installs-and-removes-the-barrier-and-a-gate-off-check-sees-the-store-the-product-sees', async t => {
    const store = realStore(t);
    const operationId = crypto.randomBytes(16).toString('hex');
    assert.equal((await store.run('gate-off-check')).lines[0].ok, true);
    const begun = (await store.run('barrier-begin', { operationId })).lines[0];
    assert.deepEqual([begun.ok, begun.operationId], [true, operationId]);
    const pending = assertValidStore((await store.run('inspect')).lines[0], 'barrier');
    assert.equal(pending.barrier.operationId, operationId);
    // Another operation cannot install a second barrier, and a write is refused while it is pending.
    const second = (await store.run('barrier-begin', { operationId: crypto.randomBytes(16).toString('hex') })).lines[0];
    assert.deepEqual([second.ok, second.code], [false, 'hardware_limits_transition']);
    assert.throws(() => setAgentLimits({ paths: store.paths, identity: store.identity, agentRef: 'hwlfixture/s', limits: OVERRIDES.low, installedRefs: new Set(['hwlfixture/s']), envelope: { memoryBytes: 8 * 1024 ** 3, cpus: 4 } }), { code: 'hardware_limits_transition' });
    assert.equal((await store.run('barrier-remove', { operationId })).lines[0].removed, true);
    assert.equal(assertValidStore((await store.run('inspect')).lines[0], 'removed').barrier, null);
    // A committed policy makes a gate-off start refuse (U9).
    setAgentLimits({ paths: store.paths, identity: store.identity, agentRef: 'hwlfixture/s', limits: OVERRIDES.low, installedRefs: new Set(['hwlfixture/s']), envelope: { memoryBytes: 8 * 1024 ** 3, cpus: 4 } });
    const refused = (await store.run('gate-off-check')).lines[0];
    assert.deepEqual([refused.ok, refused.code], [false, 'stored_limits_present']);
    assert.equal(readStoreSnapshot({ paths: store.paths, identity: store.identity }).agents.size, 1);
});

test('X5.c5-the-program-refuses-another-workspace-a-wrong-store-root-and-invalid-parameters', async t => {
    const store = realStore(t);
    const params = storeProgramParams({ profile: store.profile, identity: store.identity, domain: 'host', mode: 'inspect' });
    const run = override => new Promise(resolve => {
        const child = spawn(process.execPath, hostProgramWords({ ...params, ...override }), { env: { PATH: process.env.PATH, HOME: store.home }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = ''; let stdout = '';
        child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.on('data', chunk => { stdout += chunk; });
        child.on('close', code => resolve({ code, stderr, stdout }));
    });
    for (const [label, override, pattern] of [
        ['a store root this workspace does not derive', { storeRoot: path.join(store.home, 'elsewhere') }, /not the one this workspace derives/],
        ['a mode the program does not know', { mode: 'rewrite' }, /Invalid store program parameters/],
        ['a relative product root', { root: 'src' }, /Invalid store program parameters/],
        ['a hold beyond its bound', { holdMs: 400000 }, /Invalid store program parameters/],
        ['an operation id that is not 128-bit hex', { operationId: 'x' }, /Invalid store program parameters/],
        ['another instance name', { instance: 'not-an-instance' }, /Invalid store program parameters/],
    ]) {
        const result = await run(override);
        assert.notEqual(result.code, 0, label); assert.match(result.stderr, pattern, label); assert.equal(result.stdout, '', label);
    }
    // Another workspace's identity reading this store is refused as identity_changed, never read.
    const other = await run({ instance: store.identity.instance.replace(/[a-f0-9]{12}$/, '000000000000'), pathHash: '000000000000', storeRoot: store.paths.storeRoot });
    assert.notEqual(other.code, 0);
});

test('X5.c5-the-evaluators-accept-exactly-what-they-describe', () => {
    const token = { epoch: 'a'.repeat(32), revision: 4 };
    const view = (domain, extra = {}) => ({ ok: true, mode: 'inspect', domain, status: 'valid', storeId: 'b'.repeat(32), token, count: 0, agents: {}, lock: null, barrier: null, quarantined: [], uid: 1000, ...extra });
    assert.doesNotThrow(() => assertSameStore(view('host'), view('box'), 'v'));
    for (const [label, box] of [['another store', view('box', { storeId: 'c'.repeat(32) })], ['another stamp', view('box', { token: { ...token, revision: 5 } })], ['other entries', view('box', { count: 1, agents: { x: {} } })],
        ['the host twice', view('host')]]) assert.throws(() => assertSameStore(view('host'), box, label), /store|policy|views/, label);
    assert.throws(() => assertValidStore({ ok: false, code: 'store_unreadable', message: 'x' }, 'x'), /could not be inspected/);
    assert.throws(() => assertValidStore(view('host', { status: 'unreadable' }), 'x'), /not valid/);
    // A committed write, and the typed refusals.
    assert.deepEqual(assertCommitted({ status: 200, body: { ok: true, committed: true, token } }, 'w'), token);
    for (const reply of [{ status: 200, body: { ok: true, committed: false, token } }, { status: 409, body: { ok: false, error: 'revision_conflict' } }, null]) assert.throws(() => assertCommitted(reply, 'w'), /not committed/);
    assert.deepEqual(assertRefusedWrite({ status: 409, body: { ok: false, error: 'revision_conflict' } }, 'revision_conflict', 'r'), { status: 409, error: 'revision_conflict' });
    for (const reply of [{ status: 409, body: { ok: false, error: 'store_busy' } }, { status: 200, body: { ok: false, error: 'revision_conflict' } }, { status: 409, body: { ok: false, error: 'revision_conflict', committed: true } }, { status: 409, body: { ok: true, error: 'revision_conflict' } }]) {
        assert.throws(() => assertRefusedWrite(reply, 'revision_conflict', 'r'), /expected a 409 revision_conflict/);
    }
    // Locks: the same owner on both sides of the mount; the same directory on one side; a holder's own release.
    const lock = { malformed: false, token: 't'.repeat(32), pid: 7, hostname: 'h', domain: 'host', dev: 1, ino: 2 };
    assert.equal(sameOwner(lock, { ...lock, dev: 9, ino: 9 }), true); assert.equal(sameLock(lock, { ...lock, dev: 9 }), false); assert.equal(sameOwner(lock, { ...lock, pid: 8 }), false);
    assert.doesNotThrow(() => assertLockNotStolen(lock, { ...lock }, 'l'));
    for (const after of [null, { ...lock, token: 'u'.repeat(32) }, { ...lock, ino: 3 }]) assert.throws(() => assertLockNotStolen(lock, after, 'l'), /changed hands or was removed/);
    assert.doesNotThrow(() => assertHolderReleased([{ phase: 'held' }, { ok: true, phase: 'released', token: 't', heldMs: 3 }], 'h'));
    for (const lines of [[{ ok: true, phase: 'held' }], [{ ok: false, phase: 'release-refused', code: 'store_busy' }], null]) assert.throws(() => assertHolderReleased(lines, 'h'), /did not release/);
    // The host clear's refusal must be for the named reason.
    assert.doesNotThrow(() => assertHostClearRefused({ status: 1, stderr: 'the lock is not proven stopped or absent' }, RECOVERY_REFUSALS.running, 'c'));
    for (const result of [{ status: 0, stdout: 'not proven stopped or absent' }, { status: 1, stderr: 'something else' }, { status: 1, timedOut: true, stderr: 'not proven stopped or absent' }]) assert.throws(() => assertHostClearRefused(result, RECOVERY_REFUSALS.running, 'c'), /was not refused|another reason/);
    assert.equal(tokenKey(token), `${'a'.repeat(32)}:4`);
    assert.match(`A gate-on to gate-off transition is pending; run`, new RegExp(BARRIER_MESSAGE));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The case.

test('X5.c5-passes-every-step-over-the-real-store-and-leaves-the-box-stopped-for-the-cleanup-action', async t => {
    const context = await liveWorld(t);
    const { fake, w } = context;
    const result = await liveRun(context);
    assert.equal(result.case.result, 'pass', JSON.stringify(result.case).slice(0, 900));
    assert.equal(result.report.verdict, 'PASS'); assert.equal(result.report.cleanup.state, 'complete');
    const e = result.case.evidence;
    for (const key of CASE_KEYS) { assert.ok(e[key], key); assert.ok(result.artifacts.has(`store-${key}`), `artifact store-${key}`); }
    // 1: one store seen from both sides, and an in-Box write seen by the host.
    assert.equal(e.baseline.uid, e.baseline.boxUid); assert.deepEqual(e.visibility.entry, OVERRIDES.low);
    // 2: exactly one of two in-Box setters of one stamp wins.
    assert.equal(e['cas-race'].loser, 'revision_conflict'); assert.ok([OVERRIDES.low, OVERRIDES.high].some(value => JSON.stringify(value) === JSON.stringify(e['cas-race'].winner)));
    // 3 and 4: the stale setter is refused and the clear is not lost; every race round ends with the entry gone.
    assert.equal(e['stale-setter'].refused, 'revision_conflict'); assert.equal(e['stale-setter'].entries, 0);
    assert.equal(e['host-box-race'].rounds.length, STORE_BOUNDS.raceRounds);
    for (const round of e['host-box-race'].rounds) assert.ok(['setter-then-clear', 'clear-then-refused-setter'].includes(round.order), round.order);
    // 5: live locks are never taken and each holder released its own lock.
    assert.equal(e['lock-host-held'].refused, 'store_busy'); assert.equal(e['lock-host-held'].lock.domain, 'host'); assert.equal(e['lock-box-held'].lock.domain, 'box');
    assert.equal(e['lock-host-held'].holder.token, e['lock-host-held'].lock.token); assert.equal(e['lock-box-held'].holder.token, e['lock-box-held'].lock.token);
    // 6: the barrier refuses both writers and the gate-off check follows the store.
    assert.deepEqual([e.barrier.setter, e.barrier.clear, e.barrier.hostClear, e.barrier.gateOffSeesEmpty, e.barrier.gateOffAfterCommit, e.barrier.gateOffAfterClear], ['hardware_limits_transition', 'hardware_limits_transition', 'refused', true, 'stored_limits_present', 'empty']);
    // 7: both stale locks were recovered and kept; the live one was not touched; the Box stayed stopped.
    assert.equal(e['stale-box-lock'].boxRunning, false); assert.equal(e['stale-box-lock'].quarantined.length, 1);
    assert.equal(e['stale-host-live'].refused, 'holder still running'); assert.equal(e['stale-host-dead'].quarantined.length, 2);
    assert.equal(e.final.boxStopped, true); assert.equal(fake.model.stops, 1);
    // Every program, writer and holder was settled: nothing is left running, and the cleanup removed the Box.
    assert.equal(fake.model.boxChildren.size, 0);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).boxes).length, 0);
    // The administrator channel was not used after the stop; the host stop ran once, with no port option.
    const stops = fake.model.calls.filter(call => call.args[1] === 'stop');
    assert.equal(stops.length, 1); assert.deepEqual(stops[0].args.slice(1), ['stop']);
});

test('X5.c5-is-blocked-never-passed-when-a-prerequisite-is-missing', async t => {
    // The administrator channel does not answer.
    await failsWith(t, { adminDown: true }, /administrator channel did not answer/, { result: 'blocked' });
    // A store that already holds an entry is not an empty start.
    const context = await liveWorld(t);
    context.fake.ensureStore();
    const { identity, hostPaths } = context.fake.context();
    setAgentLimits({ paths: hostPaths, identity, agentRef: 'hwlfixture/s', limits: OVERRIDES.low, installedRefs: new Set(['hwlfixture/s']), envelope: { memoryBytes: 8 * 1024 ** 3, cpus: 4 } });
    const outcome = await liveRun(context);
    assert.equal(outcome.case.result, 'blocked'); assert.match(outcome.case.reason, /needs an empty store to start/);
});

test('X5.c5-fails-when-the-box-and-the-host-do-not-read-one-store-or-run-as-different-users', async t => {
    await failsWith(t, { mutateProgram: (domain, mode, lines) => (domain === 'box' && mode === 'inspect' ? lines.map(line => ({ ...line, storeId: 'c'.repeat(32) })) : lines) }, /baseline: the host and the Box see different stores/);
    await failsWith(t, { boxUid: 4242 }, /keep-id mapping that makes both the store's owner does not hold/);
});

test('X5.c5-fails-when-two-in-box-setters-of-one-stamp-both-win-or-a-stale-setter-is-accepted-and-the-clear-is-lost', async t => {
    // The in-Box setter ignores the stamp: both racers commit.
    await failsWith(t, { lostUpdate: true }, /did not produce exactly one winner \(2\)/);
});

test('X5.c5-fails-when-the-host-clear-does-not-commit-and-when-the-store-is-not-the-product-s', async t => {
    await failsWith(t, { hostClearNoop: true }, /host clear did not commit exactly one new stamp/);
});

test('X5.c5-fails-when-a-live-lock-is-taken-by-either-side', async t => {
    // The in-Box writer removes a held host lock and commits instead of being refused.
    await failsWith(t, { stealLock: true }, /expected a 409 store_busy/);
    // The host recovery believes the Box is stopped while it runs and takes the Box holder's lock.
    await failsWith(t, { hostIgnoresBox: true }, /host clear against a live Box lock: the host clear was not refused/);
    // The host recovery judges a live host holder dead.
    await failsWith(t, { liveHostRecovered: true }, /host clear against a live host lock: the host clear was not refused/);
});

test('X5.c5-fails-when-the-barrier-does-not-hold-a-write-back', async t => {
    await failsWith(t, { ignoreBarrier: true }, /expected a 409 hardware_limits_transition/);
});

test('X5.c5-fails-when-a-stale-lock-is-not-preserved-or-the-stop-does-not-leave-the-box-holder-s-lock-stale', async t => {
    await failsWith(t, { deleteQuarantine: true }, /not preserved as the one quarantined lock/);
    // The stop does not end the Box holder: it releases its own lock before the host looks, so no stale lock is left.
    await failsWith(t, { stopKeepsBoxChildren: true, holdMs: 600 }, /did not survive the stop as the same stale lock|stale Box lock/);
});

test('X5.c5-fails-when-a-holder-s-own-release-is-refused-because-its-lock-was-replaced', async t => {
    await failsWith(t, { mutateProgram: (domain, mode, lines) => (domain === 'host' && mode === 'hold' && lines.some(line => line.phase === 'released') ? lines.map(line => (line.phase === 'released' ? { ...line, ok: false, phase: 'release-refused', code: 'store_busy' } : line)) : lines) }, /The host holder: the holder did not release its own lock/);
});

test('X5.c5-sets-and-clears-only-the-stored-override-of-the-fixture-agent-and-leaves-nothing-running', async t => {
    const context = await liveWorld(t);
    const result = await liveRun(context);
    assert.equal(result.case.result, 'pass', JSON.stringify(result.case).slice(0, 600));
    const bodies = context.fake.model.adminCalls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body));
    assert.ok(bodies.length >= 10);
    for (const body of bodies) {
        assert.equal(body.agentRef, 'hwlfixture/s'); assert.ok(['set_agent_limits', 'clear_agent_limits'].includes(body.action), body.action);
        if (body.action === 'set_agent_limits') assert.ok([OVERRIDES.low, OVERRIDES.high].some(value => JSON.stringify(value) === JSON.stringify(body.limits)), JSON.stringify(body.limits));
    }
    for (const call of context.fake.model.calls.filter(entry => entry.args[1] === 'limits')) assert.deepEqual(call.args.slice(1, 4), ['limits', 'clear', '--agent']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Every check of the case has its negative: a product (or a runner) that breaks one pass condition is a FAIL naming it.

test('X5.c5-is-blocked-when-the-box-is-not-running-and-fails-when-a-lock-or-a-barrier-is-already-there', async t => {
    const stopped = await liveWorld(t);
    await stopped.fake.provider(stopped.w.node, [stopped.w.run.target.execution.candidate.path, 'stop'], { cwd: stopped.workspace });
    const notRunning = await liveRun(stopped);
    assert.equal(notRunning.case.result, 'blocked'); assert.match(notRunning.case.reason, /The owned Box is not running/);
    const locked = await liveWorld(t);
    locked.fake.ensureStore();
    const { hostPaths } = locked.fake.context();
    fs.mkdirSync(path.join(hostPaths.storeRoot, 'write.lock'), { mode: 0o700 });
    fs.writeFileSync(path.join(hostPaths.storeRoot, 'write.lock', 'owner.json'), `${JSON.stringify({ token: 'e'.repeat(32), pid: 1, hostname: 'x', domain: 'host', operation: 'x', acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    const withLock = await liveRun(locked);
    assert.equal(withLock.case.result, 'fail'); assert.match(withLock.case.reason, /baseline: a store lock is present/);
    const barred = await liveWorld(t);
    barred.fake.ensureStore();
    const paths = barred.fake.context();
    const { beginDowngradeBarrier } = await import('../../cli/sandbox/hardwareLimits/store.mjs');
    beginDowngradeBarrier({ paths: paths.hostPaths, identity: paths.identity, operationId: 'd'.repeat(32) });
    const withBarrier = await liveRun(barred);
    assert.equal(withBarrier.case.result, 'fail'); assert.match(withBarrier.case.reason, /baseline: a downgrade barrier is pending/);
});

test('X5.c5-fails-when-the-route-and-the-host-read-different-stamps-or-an-in-box-write-is-not-what-the-host-reads', async t => {
    await failsWith(t, { adminTokenOffset: 1 }, /read different stamps/);
    await failsWith(t, { setNoop: true }, /The in-Box write is not what the host reads/);
});

test('X5.c5-fails-when-the-losing-setter-is-not-refused-with-revision-conflict-and-when-a-stale-setter-is-accepted-or-changes-the-store', async t => {
    await failsWith(t, { errorCodes: { revision_conflict: 'store_busy' } }, /The losing setter: expected a 409 revision_conflict/);
    // The third write of the case is the stale setter after the host clear.
    await failsWith(t, { lostUpdateFrom: 4 }, /The in-Box setter that read the stamp before the host clear: expected a 409 revision_conflict/);
    // Refused, yet the store changed: the clear was lost.
    await failsWith(t, { refuseButWrite: true }, /clear was lost|does not hold exactly the winner|did not commit exactly one new stamp|changed the store/);
});

test('X5.c5-orders-each-race-round-by-the-stamp-and-passes-both-orders', async t => {
    // The host clear starts later than the in-Box setter: the setter commits first and the clear lands after it.
    const context = await liveWorld(t, { faults: { hostClearDelayMs: 60 } });
    const result = await liveRun(context);
    assert.equal(result.case.result, 'pass', JSON.stringify(result.case).slice(0, 600));
    for (const round of result.case.evidence['host-box-race'].rounds) assert.equal(round.order, 'setter-then-clear');
    // The default order (the clear first) is the other one.
    const other = await liveRun(await liveWorld(t));
    for (const round of other.case.evidence['host-box-race'].rounds) assert.equal(round.order, 'clear-then-refused-setter');
});

test('X5.c5-fails-when-a-lock-is-not-visible-through-the-mount-or-is-a-different-lock-on-the-two-sides', async t => {
    const hide = (domain, mode, lines) => (domain === 'box' && mode === 'inspect' ? lines.map(line => ({ ...line, lock: null })) : lines);
    await failsWith(t, { mutateProgram: hide }, /never became visible in the box view/, { seams: { sleep: real, polling: { deadlineMs: 300, intervalMs: 20 } } });
    const other = (domain, mode, lines) => (domain === 'box' && mode === 'inspect' ? lines.map(line => (line.lock ? { ...line, lock: { ...line.lock, token: 'f'.repeat(32) } } : line)) : lines);
    await failsWith(t, { mutateProgram: other }, /The Box and the host do not see the same lock/);
    const hostOnly = (domain, mode, lines) => (domain === 'host' && mode === 'inspect' ? lines.map(line => (line.lock?.domain === 'box' ? { ...line, lock: null } : line)) : lines);
    await failsWith(t, { mutateProgram: hostOnly }, /never became visible in the host view/, { seams: { sleep: real, polling: { deadlineMs: 300, intervalMs: 20 } } });
});

// A live lock that the product took, replaced, or quarantined, as the host's second look (after the refused writer) reports it.
function afterRefusal(ref, { domain, boxRunning, tamper }) {
    let sight = null;
    return (d, mode, lines) => {
        if (d !== 'host' || mode !== 'inspect' || !lines[0]?.lock || lines[0].lock.domain !== domain || ref.fake.boxRunning() !== boxRunning) return lines;
        const writers = ref.fake.model.adminCalls.filter(call => call.method === 'POST').length + ref.fake.model.calls.filter(call => call.args[1] === 'limits').length;
        if (sight === null) { sight = writers; return lines; }
        return writers > sight ? [tamper(lines[0]), ...lines.slice(1)] : lines;
    };
}
test('X5.c5-fails-when-a-refused-writer-changed-the-store-or-the-lock-it-was-refused-by', async t => {
    const retoken = line => ({ ...line, lock: { ...line.lock, token: 'f'.repeat(32) } });
    const requarantine = line => ({ ...line, quarantined: [...line.quarantined, { name: 'write.lock.stale-1-aa', ownerToken: 'x' }] });
    const restamp = line => ({ ...line, token: { ...line.token, revision: line.token.revision + 1 } });
    for (const [label, spec, pattern] of [
        ['a host lock replaced while its holder lives', { domain: 'host', boxRunning: true, tamper: retoken }, /The host lock: the lock changed hands or was removed/],
        ['a store changed by the refused in-Box setter', { domain: 'host', boxRunning: true, tamper: restamp }, /The refused in-Box setter changed the store/],
        ['a Box lock replaced while its holder lives', { domain: 'box', boxRunning: true, tamper: retoken }, /The Box lock: the lock changed hands or was removed/],
        ['a store changed by the refused host clear', { domain: 'box', boxRunning: true, tamper: restamp }, /The refused host clear changed the store/],
        ['a live Box lock quarantined', { domain: 'box', boxRunning: true, tamper: requarantine }, /A live Box lock was quarantined/],
        ['a live host lock replaced with the Box stopped', { domain: 'host', boxRunning: false, tamper: retoken }, /The live host lock: the lock changed hands or was removed/],
        ['a live host lock quarantined with the Box stopped', { domain: 'host', boxRunning: false, tamper: requarantine }, /A live host lock was quarantined/],
    ]) {
        const ref = { fake: null };
        const context = await liveWorld(t, { faults: { mutateProgram: afterRefusal(ref, spec) } });
        ref.fake = context.fake;
        const outcome = await liveRun(context);
        assert.equal(outcome.case.result, 'fail', `${label}: ${JSON.stringify(outcome.case).slice(0, 500)}`);
        assert.match(outcome.case.reason, pattern, label);
    }
});

test('X5.c5-fails-when-the-barrier-leaves-a-gap-or-a-gate-off-start-does-not-follow-the-store', async t => {
    const barrierSeen = (domain, mode, lines) => (domain === 'box' && mode === 'inspect' ? lines.map(line => ({ ...line, barrier: null })) : lines);
    await failsWith(t, { mutateProgram: barrierSeen }, /The barrier is not the same one on both sides of the mount/);
    // The gate-off check reports a non-empty store under the barrier.
    await failsWith(t, { mutateProgram: (domain, mode, lines, n) => (mode === 'gate-off-check' && n === 1 ? lines.map(line => ({ ...line, count: 1 })) : lines) }, /gate-off start does not see the empty store/);
    // A gate-off start is not refused after a policy was committed (the second check of the case).
    await failsWith(t, { mutateProgram: (domain, mode, lines, n) => (mode === 'gate-off-check' && n === 2 ? lines.map(line => ({ ...line, ok: true })) : lines) }, /A gate-off start is not refused although a policy was committed/);
    // And it is still refused after the clear (the third check).
    await failsWith(t, { mutateProgram: (domain, mode, lines, n) => (mode === 'gate-off-check' && n === 3 ? lines.map(line => ({ ...line, ok: false, code: 'stored_limits_present' })) : lines) }, /A gate-off start is still refused after the clear/);
    // The barrier cannot be installed.
    await failsWith(t, { mutateProgram: (domain, mode, lines) => (mode === 'barrier-begin' ? lines.map(line => ({ ...line, ok: false, code: 'store_busy', message: 'busy' })) : lines) }, /downgrade barrier could not be installed/);
});

test('X5.c5-removes-the-barrier-even-when-the-case-fails-and-says-when-it-could-not', async t => {
    // The product ignores the barrier, so the writes commit under it; the barrier is still removed, and the removal that the product refuses is recorded.
    const outcome = await failsWith(t, { ignoreBarrier: true }, /expected a 409 hardware_limits_transition .*\(The downgrade barrier could not be removed \(stored_limits_present/);
    assert.equal(outcome.context.fake.model.programs.filter(entry => entry.mode === 'barrier-remove').length, 1);
    // A removal that cannot run on a passing barrier is itself a FAIL.
    await failsWith(t, { mutateProgram: (domain, mode, lines) => (mode === 'barrier-remove' ? lines.map(line => ({ ...line, ok: false, code: 'hardware_limits_transition', message: 'another operation' })) : lines) }, /The downgrade barrier could not be removed \(hardware_limits_transition: another operation\)/);
});

test('X5.c5-fails-when-a-stale-lock-is-recovered-without-one-committed-clear-or-the-abandoned-holder-is-alive-or-another-lock', async t => {
    // The recovering host clear does nothing (still exits 0): the stale lock stays and no clear commits.
    await failsWith(t, { hostClearNoopFrom: 9 }, /The stale Box lock was not recovered into exactly one committed clear/);
    await failsWith(t, { hostClearNoopFrom: 11 }, /The abandoned host lock was not recovered into exactly one committed clear/);
    // The process that abandoned the lock is judged still running.
    const context = await liveWorld(t);
    const alive = await liveRun(context, { seams: { ...SEAMS, isDead: () => false } });
    assert.equal(alive.case.result, 'fail'); assert.match(alive.case.reason, /is still running/);
    // The abandoned program does not hold the lock, or the lock seen is not the one it took.
    await failsWith(t, { mutateProgram: (domain, mode, lines) => (mode === 'stale' ? lines.map(line => ({ ...line, ok: false, code: 'store_busy' })) : lines) }, /The abandoned host lock could not be created/);
    let abandoned = null;
    await failsWith(t, { mutateProgram: (domain, mode, lines) => {
        if (mode === 'stale') abandoned = lines[0].token;
        return mode === 'inspect' && abandoned && lines[0].lock?.token === abandoned ? lines.map(line => ({ ...line, lock: { ...line.lock, token: '9'.repeat(32) } })) : lines;
    } }, /The abandoned lock is not the one the program took/);
});

test('X5.c5-fails-when-the-box-is-still-running-after-the-stop-and-when-the-stop-fails', async t => {
    await failsWith(t, { stopKeepsBoxRunning: true }, /Box is still running after the host stop/);
    const context = await liveWorld(t);
    const outcome = await liveRun(context, { mutate: args => { if (args[1] === 'stop') args.splice(1, 1, 'status'); } });
    assert.equal(outcome.case.result, 'fail'); assert.match(outcome.case.reason, /The Box is still running after the host stop|The host stop/);
});

test('X5.c5-fails-when-a-holder-ends-without-its-own-verified-release', async t => {
    // A holder whose last word is only that it held the lock never proved a release: it is a FAIL, not a pass.
    await failsWith(t, { mutateProgram: (domain, mode, lines) => (mode === 'hold' && domain === 'host' ? lines.slice(0, 1) : lines) }, /The host holder: the holder did not release its own lock/);
});

test('X5.c5-fails-naming-the-write-that-was-not-committed', async t => {
    // The n-th write of the case: 1 the first, 5 the seeding of race round 1, 11 the seeding of the lock case, 13 the write after the host holder released,
    // 14 the write after the barrier was removed, 15 the seeding of the stale case (writes refused by the barrier never reach the count).
    for (const [post, label] of [[1, 'The first in-Box write'], [5, 'Round 1: the seeding write'], [11, 'The seeding write of the lock case'], [13, 'The in-Box write after the host holder released'],
        [14, 'The in-Box write after the barrier was removed'], [15, 'The seeding write of the stale case']]) {
        await failsWith(t, { rejectPost: post }, new RegExp(`${label}: the write was not committed`));
    }
});

test('X5.c5-fails-naming-the-host-command-that-did-not-exit-zero-or-did-nothing', async t => {
    // The n-th host clear of the case: 1 after the stamp was read, 2 the first race round, 6 after the Box holder released, 8 after the barrier, 9 the recovery with the
    // Box stopped, 11 the recovery of the dead host lock.
    for (const [call, label] of [[1, 'The host clear'], [2, 'Round 1: the host clear'], [6, 'The host clear after the Box holder released'], [8, 'The host clear after the barrier'],
        [9, 'The host clear with the stopped Box'], [11, 'The host clear of a dead host lock with the Box stopped']]) {
        await failsWith(t, { hostClearFailAt: call }, new RegExp(`${label}: did not exit 0`));
    }
    await failsWith(t, { hostClearNoopAt: 6 }, /The host clear after the release left the entry/);
    await failsWith(t, { stopExit: 1 }, /The host stop: did not exit 0/);
});

test('X5.c5-fails-when-the-store-is-not-what-each-step-requires', async t => {
    // The n-th host inspection of the case: 2 after the in-Box write (the Box view n=2 too), 3 after the CAS race, 5 after the stale setter, 6 the first race round.
    const host = (n, change) => (domain, mode, lines, count) => (domain === 'host' && mode === 'inspect' && count === n ? lines.map(line => ({ ...line, ...change(line) })) : lines);
    await failsWith(t, { mutateProgram: host(3, () => ({ agents: { 'hwlfixture/s': { memoryPercent: 99 } } })) }, /does not hold exactly the winner of the race/);
    await failsWith(t, { mutateProgram: host(5, () => ({ count: 1, agents: { 'hwlfixture/s': { memoryPercent: 20 } } })) }, /refused stale setter changed the store: the clear was lost/);
    await failsWith(t, { mutateProgram: host(6, line => ({ token: { ...line.token, revision: line.token.revision + 1 } })) }, /Round 1: the clear was lost or the stamp does not fit either order/);
    await failsWith(t, { mutateProgram: (domain, mode, lines, count) => (domain === 'box' && mode === 'inspect' && count === 2 ? lines.map(line => ({ ...line, storeId: 'c'.repeat(32) })) : lines) }, /after the in-Box write: the host and the Box see different stores/);
    await failsWith(t, { rejectPost: 6 }, /Round 1: the setter: expected a 409 revision_conflict/);
    // A Box lock the Box reads with another owner than the host reads.
    await failsWith(t, { mutateProgram: (domain, mode, lines) => (domain === 'box' && mode === 'inspect' && lines[0].lock?.domain === 'box' ? lines.map(line => ({ ...line, lock: { ...line.lock, token: 'f'.repeat(32) } })) : lines) }, /The host and the Box do not see the same lock/);
});

test('X5.c5-fails-when-the-barrier-survives-its-removal-or-the-host-ignores-it-or-the-store-moves-under-it', async t => {
    let removed = false;
    await failsWith(t, { mutateProgram: (domain, mode, lines) => {
        if (mode === 'barrier-remove') { removed = true; return lines; }
        if (removed && domain === 'host' && mode === 'inspect') { removed = false; return lines.map(line => ({ ...line, barrier: { malformed: false, operationId: 'e'.repeat(32) } })); }
        return lines;
    } }, /after the barrier: a downgrade barrier is pending/);
    await failsWith(t, { hostIgnoresBarrier: true }, /The host clear under the barrier: the host clear was not refused/);
    let begun = false; let looks = 0;
    await failsWith(t, { mutateProgram: (domain, mode, lines) => {
        if (mode === 'barrier-begin') { begun = true; return lines; }
        if (begun && domain === 'host' && mode === 'inspect' && (looks += 1) === 2) return lines.map(line => ({ ...line, token: { ...line.token, revision: line.token.revision + 1 } }));
        return lines;
    } }, /A write was committed while the barrier was pending/);
});

test('X5.c5-fails-when-a-second-recovery-does-not-preserve-its-lock-and-when-the-live-host-holder-does-not-release', async t => {
    await failsWith(t, { deleteQuarantineFrom: 11 }, /The abandoned host lock was not preserved as a quarantined lock/);
    await failsWith(t, { mutateProgram: (domain, mode, lines, count) => (domain === 'host' && mode === 'hold' && count === 2 ? lines.slice(0, 1) : lines) }, /The live host holder: the holder did not release its own lock/);
});

// A fixture agent that declares no limits is listed as that fixture agent; the local-llm blocks keep their own row (tests/unit/hardwareLimitsLiveLlm.test.mjs).
test('X5.the-approval-summary-lists-the-fixture-agents-that-declare-no-limits-and-names-no-local-llm-agent', t => {
    for (const [block, agents] of [[BLOCK, ['s']], ['apparatus-availability', ['a', 'b', 'c', 'x']], ['apparatus-router-controls', ['s']]]) {
        const w = world(t, { block, ...(block === 'apparatus-router-controls' ? { ports: { tcp: 18090, udp: 17892 } } : {}) });
        const summary = renderSummary(w.run, w.runPath);
        for (const name of agents) assert.ok(summary.includes(`| Fixture agent hwlfixture/${name} | declares no hardware limits of its own`), `${block}: ${name}`);
        assert.equal(summary.includes('| Agent local-llms/local-llm |'), false, `${block} names no local-llm agent`);
    }
});
