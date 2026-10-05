// Step-4 executors (release plan C8b), checkpoint E2: LIVE-C3 (hardware availability over the dependency graph) and LIVE-C3V (the Router's own
// controls while the static agent is the blocked fixture). Offline: the engine, the product's availability, the Router's HTTP answers and the
// nested engine are the model of fakeLiveAvailability.mjs over REAL fixture manifests in a temporary workspace; nothing starts a container.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { candidateArgvProblem, candidateOperationsOf } from '../hardware-limits/candidateArgv.mjs';
import { CONCRETE_BLOCKS, renderSummary, validatePins } from '../hardware-limits/liveManifest.mjs';
import { LIVE_CASES, UNSUPPORTED, executeCleanupRun, executeLiveRun, validateProfile } from '../hardware-limits/liveHarness.mjs';
import { FIXTURE_REPOSITORY, fixtureContainerName, fixtureManifest, fixturePlan, provisionRun, validateProvisionPlan } from '../hardware-limits/liveFixture.mjs';
import { C3_AGENTS, C3V_AGENTS, D4_REASON_CODE, ROUTER_CONTROLS_PORTS, STORED_OVERRIDE, UNENFORCEABLE_CODE, VARIANT_III_EVIDENCE, assertBlockedBy, assertControllersUnchanged, assertNestedStates,
    assertReady, assertRefused, assertRoutes, assertSetterRefused, assertStaticTerminal, d4Manifest, parseNestedStates, withEnable } from '../hardware-limits/liveAvailabilityCommands.mjs';
import { createFakeAvailability } from '../hardware-limits/fakeLiveAvailability.mjs';
import { BOX_IMAGE, exists, free, world } from '../hardware-limits/executorWorld.mjs';

const C3 = 'apparatus-availability';
const C3VB = 'apparatus-router-controls';
const quickPolling = { deadlineMs: 400, intervalMs: 1 };

async function liveWorld(t, { block = C3, faults = {}, ports } = {}) {
    const w = world(t, { block, ...(ports ? { ports } : {}) });
    const workspace = w.run.target.execution.provision.workspace.path;
    const root = block === C3 ? 'a' : 's';
    const fake = createFakeAvailability({ base: { provider: w.engineProvider, node: w.node }, workspace, root, faults });
    const report = await provisionRun({ run: w.run, persist: w.persist, processProvider: fake.provider, portProbe: free, hostIdentity: w.hostIdentity, remoteArrival: w.remote, validateProfile });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    return { w, fake, workspace };
}
async function liveRun(context, { polling = quickPolling, mutate = null, http = null, fsApi = null } = {}) {
    const { w, fake } = context;
    const artifacts = new Map();
    const provider = mutate ? async (binary, args, options) => { mutate(args); return fake.provider(binary, args, options); } : fake.provider;
    const report = await executeLiveRun({ run: w.run, hostIdentity: w.hostIdentity, processProvider: provider, persist: w.persist, remoteArrival: true,
        artifacts: (name, value) => artifacts.set(name, structuredClone(value)), availabilitySeams: { http: http || fake.http, polling, sleep: async () => {}, ...(fsApi ? { fsApi } : {}) } });
    return { report, artifacts, case: report.cases.find(entry => /^LIVE-C3/.test(entry.id)) };
}
const restarts = fake => fake.model.calls.filter(call => call.args[1] === 'restart');
const candidateCalls = (fake, word) => fake.model.calls.filter(call => call.args[0]?.endsWith('ploinky-box.mjs') && call.args[1] === word);

// ---------------------------------------------------------------------------------------------------------------------------------
// Wiring: the blocks, the fixtures and the manifest the monitor approves.

test('X4.c3-blocks-fixtures-and-pins-are-wired-and-the-dedicated-workspace-has-its-own-ports', async t => {
    assert.deepEqual(CONCRETE_BLOCKS[C3], { platform: 'linux', remote: true, cases: ['LIVE-C3'], availability: true });
    assert.deepEqual([CONCRETE_BLOCKS[C3VB].cases, CONCRETE_BLOCKS[C3VB].ports], [['LIVE-C3V'], { tcp: 18090, udp: 17892 }]);
    assert.deepEqual(LIVE_CASES[C3], ['LIVE-C3']); assert.deepEqual(LIVE_CASES[C3VB], ['LIVE-C3V']);
    assert.equal(UNSUPPORTED['LIVE-C3'], undefined, 'LIVE-C3 is implemented');
    assert.deepEqual(ROUTER_CONTROLS_PORTS, { tcp: 18090, udp: 17892 });
    // The fixtures: a (root), b, c, x declare no limits; the static agent s alone for C3-v.
    assert.deepEqual(fixturePlan(['LIVE-C3']), C3_AGENTS.map(name => ({ name, role: name, hardwareLimits: null })));
    assert.deepEqual(fixturePlan(['LIVE-C3V']), [{ name: 's', role: 's', hardwareLimits: null }]);
    const w = world(t, { block: C3 });
    const plan = w.run.target.execution.provision;
    assert.doesNotThrow(() => validateProvisionPlan(plan, w.run));
    const manifest = name => fixtureManifest(plan.agents.find(agent => agent.name === name), { image: plan.image, agents: plan.agents });
    assert.deepEqual(manifest('a').enable, ['hwlfixture/b', 'hwlfixture/c', 'hwlfixture/x']);
    for (const name of C3_AGENTS) assert.equal(Object.hasOwn(manifest(name), 'hardwareLimits'), false, `${name} declares no limits of its own`);
    assert.equal(w.run.target.execution.fixtures.availability.ref, 'hwlfixture/a');
    assert.equal(w.run.deadlines.blockMs, 60 * 60 * 1000);
    // The plan validator refuses an inconsistent availability plan: limits on an agent, an unknown set of agents, a GPU or another mix.
    const tamper = change => { const copy = structuredClone(plan); change(copy); return () => validateProvisionPlan(copy, w.run); };
    assert.throws(tamper(copy => { copy.agents[1].hardwareLimits = { memory: '64m', cpus: '0.5', pidsLimit: 64 }; }));
    assert.throws(tamper(copy => { copy.agents.pop(); }), /availability fixture plan is inconsistent/);
    assert.throws(tamper(copy => { copy.agents.push({ name: 's', role: 's', hardwareLimits: null }); }), /Invalid fixture agents|inconsistent/);
    assert.throws(tamper(copy => { copy.agents[0].role = 'b'; }));
    // The dedicated workspace: its pair is the manifest default, distinct from 18080/17882, and a pin of the other pair is refused.
    const v = world(t, { block: C3VB, ports: ROUTER_CONTROLS_PORTS });
    assert.deepEqual(v.run.ports, { tcp: 18090, udp: 17892 });
    assert.equal(v.run.target.execution.fixtures.availability.ref, 'hwlfixture/s');
    for (const reserved of [{ tcp: 18080, udp: 17893 }, { tcp: 18091, udp: 17882 }]) assert.throws(() => validatePins({ ...v.pins, ports: reserved }, C3VB), /distinct from 18080\/17882/);
    assert.doesNotThrow(() => validatePins({ ...v.pins, ports: { tcp: 18091, udp: 17893 } }, C3VB));
    const { selectPorts } = await import('../hardware-limits/liveManifest.mjs');
    assert.deepEqual(selectPorts({}, C3VB), { tcp: 18090, udp: 17892 });
    assert.deepEqual(selectPorts({ ports: { tcp: 20001, udp: 30001 } }, C3VB), { tcp: 20001, udp: 30001 });
});

test('X4.c3-manifest-and-summary-name-the-spec-rows-the-edits-the-bounds-and-the-declared-limit-and-every-candidate-argv-is-accepted', t => {
    for (const block of [C3, C3VB]) {
        const w = world(t, { block, ...(block === C3VB ? { ports: ROUTER_CONTROLS_PORTS } : {}) });
        const summary = renderSummary(w.run, w.runPath);
        const row = block === C3 ? 'LIVE-C3' : 'LIVE-C3V';
        for (const text of [`| ${row} | spec 15.4`, '## Availability fixture', '## Foreign-workspace guard', 'memoryPercent 10', 'host-network plus nestedPodman', 'one at a time, each journaled with its before and after digest',
            'restart 1200000 ms', 'settle poll 600000 ms every 5000 ms', 'N-5', `TCP ${w.run.ports.tcp}`]) assert.ok(summary.includes(text), `${block}: ${text}`);
        if (block === C3) {
            for (const text of ['C3-restart-i', 'C3-restart-ii', 'C3-restart-iv', 'C3-setter-refusal', 'Variant iii is declared infeasible and never passed', 'explicitStatusWaitNodeIds', 'Whole restarts | 3', 'PLOINKY_HARDWARE_LIMITS_UNENFORCEABLE',
                'builds no manifest-aware check in the setter route']) assert.ok(summary.includes(text), text);
            assert.ok(w.run.target.plan.live.some(entry => entry.id === 'C3-variant-iii' && entry.action.includes(VARIANT_III_EVIDENCE)));
        } else {
            for (const text of ['C3V-http-static', 'C3V-http-login', 'C3V-limits-clear', 'distinct from 18080/17882', 'Whole restarts | 1', 'own Box, own workspace']) assert.ok(summary.includes(text), text);
        }
        // Every candidate command passes the real outer parser, and a restart carries no port option.
        const operations = candidateOperationsOf(w.run);
        assert.ok(operations.length >= (block === C3 ? 5 : 5));
        for (const operation of operations) assert.equal(candidateArgvProblem(operation.argv), null, operation.argv.join(' '));
        for (const operation of operations.filter(entry => entry.argv[1] === 'restart')) assert.deepEqual(operation.argv.slice(1), ['restart']);
        assert.equal(summary.includes(w.pins.ssh.identityFile ?? 'no-identity'), false);
    }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// LIVE-C3

test('X4.c3-passes-variants-i-ii-and-iv-and-the-setter-refusal-and-ends-blocked-on-the-infeasible-variant-iii-never-passed', async t => {
    const context = await liveWorld(t);
    const { fake, workspace, w } = context;
    const result = await liveRun(context);
    // The case is BLOCKED naming variant iii, with every other variant proven in its evidence; nothing passed silently.
    assert.equal(result.case.result, 'blocked', JSON.stringify(result.case).slice(0, 600));
    assert.match(result.case.reason, /variants i, ii and iv and the setter refusal passed; variant iii .* has no live producer .* \(N-5\)/);
    assert.equal(result.report.verdict, 'BLOCKED'); assert.equal(result.report.cleanup.state, 'complete');
    const evidence = result.case.evidence;
    assert.deepEqual(evidence.variants.iii, { status: 'infeasible', evidence: VARIANT_III_EVIDENCE });
    const keys = Object.fromEntries(C3_AGENTS.map(name => [name, fixtureContainerName(workspace, name)]));
    assert.deepEqual(evidence.agents, keys);
    // (i) b refused with the D4 reason, a blocked by exactly b, c and x ready; the exact routes of b and a inactive; the engine runs only c and x.
    const i = evidence.variants.i;
    assert.deepEqual([i.containers.b.availability, i.containers.b.reasonCode, i.containers.a.availability, i.containers.a.blockedBy, i.containers.c.availability, i.containers.x.availability],
        ['refused', D4_REASON_CODE, 'blocked', keys.b, 'ready', 'ready']);
    assert.deepEqual(i.routes.b, { state: 'refused', reasonCode: D4_REASON_CODE }); assert.equal(i.routes.a.state, 'blocked');
    assert.deepEqual(i.engine, { running: ['c', 'x'], notRunning: ['b', 'a'] });
    // (ii) a ready with b refused; (iv) the extra x refused, a and c ready.
    assert.deepEqual([evidence.variants.ii.containers.a.availability, evidence.variants.ii.containers.b.availability], ['ready', 'refused']);
    assert.deepEqual(evidence.variants.ii.engine, { running: ['a', 'c', 'x'], notRunning: ['b'] });
    assert.deepEqual([evidence.variants.iv.containers.x.availability, evidence.variants.iv.containers.a.availability, evidence.variants.iv.containers.b.availability], ['refused', 'ready', 'refused']);
    // The setter: typed, refused, nothing committed.
    assert.deepEqual([evidence.setter.error, evidence.setter.reasonCode, evidence.setter.tokenUnchanged], [UNENFORCEABLE_CODE, D4_REASON_CODE, true]);
    assert.ok(evidence.setter.reason && evidence.setter.fix);
    assert.deepEqual(evidence.controllersAtEnd, ['cpu', 'memory', 'pids']);
    // Exactly three whole restarts, none with a port option, in the workspace; the stored overrides were saved before the manifest change.
    assert.equal(restarts(fake).length, 3);
    for (const call of restarts(fake)) { assert.deepEqual(call.args.slice(1), ['restart']); assert.equal(call.cwd, workspace); }
    const posts = fake.model.programs.filter(program => program.program === 'admin' && program.method === 'POST').map(program => JSON.parse(program.body));
    assert.deepEqual(posts.map(post => [post.agentRef, post.limits]), [['hwlfixture/b', STORED_OVERRIDE], ['hwlfixture/x', STORED_OVERRIDE], ['hwlfixture/b', STORED_OVERRIDE]]);
    // The manifest edits are exactly: b to D4, a's enable to ii, a's enable to iv and x to D4; every other file is as provisioned, each edit journaled.
    // (The workspace is removed by the cleanup, so the model recorded the fixture after each restart.)
    const [afterI, afterII, afterIV] = fake.model.snapshots;
    const provisioned = name => fixtureManifest(w.run.target.execution.provision.agents.find(agent => agent.name === name), { image: w.run.target.execution.provision.image, agents: w.run.target.execution.provision.agents });
    assert.deepEqual(afterI, { a: provisioned('a'), b: d4Manifest(provisioned('b')), c: provisioned('c'), x: provisioned('x') });
    assert.deepEqual(afterII, { ...afterI, a: withEnable(provisioned('a'), ['hwlfixture/b no-wait', 'hwlfixture/c', 'hwlfixture/x']) });
    assert.deepEqual(afterIV, { a: withEnable(provisioned('a'), ['hwlfixture/b no-wait', 'hwlfixture/c']), b: d4Manifest(provisioned('b')), c: provisioned('c'), x: d4Manifest(provisioned('x')) });
    const edits = w.run.operations.filter(op => op.kind.startsWith('availability-manifest-'));
    assert.deepEqual(edits.map(op => [op.kind, path.basename(path.dirname(op.path)), op.state]), [['availability-manifest-d4', 'b', 'observed'], ['availability-manifest-enable-ii', 'a', 'observed'], ['availability-manifest-enable-iv', 'a', 'observed'], ['availability-manifest-d4', 'x', 'observed']]);
    for (const op of edits) assert.ok(/^sha256:/.test(op.beforeDigest) && /^sha256:/.test(op.afterDigest) && op.beforeDigest !== op.afterDigest);
    // The cleanup destroyed the owned Box and left nothing.
    assert.equal(exists(workspace), false);
    for (const name of ['availability-baseline', 'availability-stored', 'availability-setter', 'availability-variant-i', 'availability-variant-ii', 'availability-variant-iv', 'availability-variant-iii', 'availability-controllers']) assert.ok(result.artifacts.has(name), name);
});

// A scenario that breaks ONE pass condition ends the case as a failure naming it; the cleanup still destroys the Box.
const c3Failures = [
    ['the setter accepts the unenforceable limit', { setterAccepts: true }, /The setter was not refused \(HTTP 200, committed\)/],
    ['a whole restart does not exit 0', { restartStatus: 1 }, /The whole restart did not exit 0/],
    ['the consumer of the refused agent is not blocked', { omitBlocked: true }, /Agent a is not blocked/],
    ['the consumer is blocked by another agent', { blockedByWrong: true }, /Agent a is blocked by .*, root cause .*, not by/],
    ['the refused route keeps a runtime target', { routeKeepsTarget: 'b' }, /b's route still has a runtime target|b's route carries no matching unavailable state/],
    ['the refused agent has no route at all', { dropRoute: 'b' }, /b has no route in the routing source/],
    ['the refused agent still runs in the Box\'s engine', { nestedKeepsRunning: 'b' }, /b runs although it is refused or blocked/],
    ['an optional no-wait child still blocks its parent', { optionalBlocks: true }, /variant ii: Agent a is not ready/],
    ['the extra is not kept in the registry', { extraDropped: true }, /The extra x has no container in the administrator state/],
    ['a delegated controller changes', { controllersChange: true }, /The delegated controllers changed/],
    ['a valid override is answered without being committed', { setterNotCommitted: true }, /A valid RAM override of b was not saved \(HTTP 200\)/],
    ['the refused setter changes the store token', { refusalBumpsToken: true }, /The refused setter changed the store token/],
    ['the refused agent is not shown refused', { notReady: { name: 'b', from: 1 } }, /variant i: Agent b is not refused \(availability starting/],
    ['the graph never settles', { settleAfterPolls: 1000000 }, /variant i: .*\(after \d+ polls/],
    ['an agent is not ready at the start', { notReadyAtStart: 'c' }, /baseline: Agent c is not ready \(availability starting\)/],
    ['the unrelated agent is not ready after the first restart', { notReady: { name: 'c', from: 1 } }, /variant i: Agent c is not ready/],
    ['the extra agent is not ready after the first restart', { notReady: { name: 'x', from: 1 } }, /variant i: Agent x is not ready/],
    ['the unrelated agent is not ready after the second restart', { notReady: { name: 'c', from: 2 } }, /variant ii: Agent c is not ready/],
    ['the extra agent is not ready after the second restart', { notReady: { name: 'x', from: 2 } }, /variant ii: Agent x is not ready/],
    ['the parent of the optional child is not ready after the second restart', { notReady: { name: 'a', from: 2 } }, /variant ii: Agent a is not ready/],
    ['the unrelated agent is not ready after the third restart', { notReady: { name: 'c', from: 3 } }, /variant iv: Agent c is not ready/],
    ['the parent is not ready after the third restart', { notReady: { name: 'a', from: 3 } }, /variant iv: Agent a is not ready/],
];
for (const [label, faults, pattern] of c3Failures) {
    test(`X4.c3-fails-when-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, async t => {
        const context = await liveWorld(t, { faults });
        const result = await liveRun(context);
        assert.equal(result.case.result, 'fail', `${label}: ${JSON.stringify(result.case).slice(0, 500)}`);
        assert.match(result.case.reason, pattern, label);
        assert.equal(result.report.verdict, 'FAIL'); assert.equal(result.report.cleanup.state, 'complete', JSON.stringify(result.report.cleanup.failures));
        assert.equal(exists(context.workspace), false, 'the owned workspace is removed whatever the case did');
    });
}

test('X4.c3-an-asynchronously-published-refusal-is-polled-until-it-settles-and-the-poll-count-is-evidence', async t => {
    const context = await liveWorld(t, { faults: { settleAfterPolls: 3 } });
    const result = await liveRun(context);
    assert.equal(result.case.result, 'blocked', JSON.stringify(result.case).slice(0, 400));
    assert.ok(result.case.evidence.variants.i.polls >= 4, `polls ${result.case.evidence.variants.i.polls}`);
});

test('X4.c3-a-fixture-manifest-changed-by-anyone-but-the-case-fails-before-and-after-every-edit', async t => {
    // Another manifest is changed behind the case's back (after the stored overrides were saved): the next edit refuses to start from it.
    const context = await liveWorld(t);
    let tampered = false;
    const repository = path.join(context.workspace, '.ploinky', 'repos', FIXTURE_REPOSITORY);
    const result = await liveRun(context, { mutate: args => {
        if (!tampered && args.some(value => typeof value === 'string' && value.includes('"set_agent_limits"')) && JSON.parse(args.at(-1)).agentRef === 'hwlfixture/x') {
            tampered = true; fs.appendFileSync(path.join(repository, 'c', 'manifest.json'), ' ');
        }
    } });
    assert.equal(tampered, true);
    assert.equal(result.case.result, 'fail', JSON.stringify(result.case).slice(0, 400));
    assert.match(result.case.reason, /before editing b: the fixture repository differs from what this run recorded in c\/manifest\.json/);
    assert.equal(restarts(context.fake).length, 0, 'nothing restarted from a tampered fixture');
});

test('X4.c3-an-edit-that-changes-another-manifest-fails-after-the-edit-and-nothing-restarts', async t => {
    // The file system seam renames the edited manifest and, in the same step, changes another one: the case proves every other manifest unchanged AFTER the edit.
    const context = await liveWorld(t);
    const repository = path.join(context.workspace, '.ploinky', 'repos', FIXTURE_REPOSITORY);
    const wrapped = new Proxy(fs, { get: (target, name) => (name === 'renameSync' ? (from, to) => { target.renameSync(from, to); if (to.endsWith(path.join('b', 'manifest.json'))) target.appendFileSync(path.join(repository, 'c', 'manifest.json'), ' '); } : target[name]) });
    const result = await liveRun(context, { fsApi: wrapped });
    assert.equal(result.case.result, 'fail', JSON.stringify(result.case).slice(0, 400));
    assert.match(result.case.reason, /after editing b: the fixture repository differs from what this run recorded in c\/manifest\.json/);
    assert.equal(restarts(context.fake).length, 0);
});

test('X4.c3-the-evaluators-refuse-every-wrong-answer-of-the-product', () => {
    const outcome = (over = {}) => ({ ok: false, error: UNENFORCEABLE_CODE, message: 'reason', fix: 'fix', hardwareOutcome: { state: 'refused', reasonCode: D4_REASON_CODE }, ...over });
    const reply = (status, body) => ({ status, body, text: '' });
    assert.doesNotThrow(() => assertSetterRefused(reply(422, outcome())));
    for (const [label, bad] of [
        ['accepted', reply(200, { ok: true, committed: true })], ['wrong status', reply(409, outcome())], ['committed', reply(422, outcome({ committed: true }))], ['untyped', reply(422, outcome({ error: 'invalid_limits' }))],
        ['another reason', reply(422, outcome({ hardwareOutcome: { state: 'refused', reasonCode: 'exceeds_envelope' } }))], ['not refused', reply(422, outcome({ hardwareOutcome: { state: 'blocked', reasonCode: D4_REASON_CODE } }))],
        ['no reason', reply(422, outcome({ message: '' }))], ['no fix', reply(422, outcome({ fix: ' ' }))], ['no reply', null], ['no body', reply(422, null)],
    ]) assert.throws(() => assertSetterRefused(bad), /setter|refusal|reply/i, label);
    const container = (availability, problem = null) => ({ key: 'k', availability, problem });
    const refused = { state: 'refused', code: UNENFORCEABLE_CODE, reasonCode: D4_REASON_CODE, fix: 'fix' };
    assert.doesNotThrow(() => assertRefused(container('refused', refused), 'b'));
    for (const bad of [null, container('ready'), container('refused', { ...refused, reasonCode: 'x' }), container('refused', { ...refused, code: 'x' }), container('refused', { ...refused, fix: '' }), container('refused', { ...refused, state: 'blocked' })]) assert.throws(() => assertRefused(bad, 'b'));
    const blockedProblem = (by, root) => ({ state: 'blocked', blockedBy: { key: by }, rootCause: { key: root } });
    assert.doesNotThrow(() => assertBlockedBy(container('blocked', blockedProblem('B', 'B')), 'B', 'a'));
    for (const bad of [null, container('ready'), container('blocked', blockedProblem('Z', 'B')), container('blocked', blockedProblem('B', 'Z')), container('refused', blockedProblem('B', 'B'))]) assert.throws(() => assertBlockedBy(bad, 'B', 'a'));
    assert.doesNotThrow(() => assertReady(container('ready'), 'c'));
    for (const bad of [null, container('starting'), container('ready', { state: 'refused' })]) assert.throws(() => assertReady(bad, 'c'));
    const route = (extra = {}) => ({ container: 'K', ...extra });
    const projection = { key: 'K', state: 'refused', problem: { reasonCode: D4_REASON_CODE } };
    assert.doesNotThrow(() => assertRoutes({ routes: { b: route({ hardwareAvailability: projection }), c: route({ hostPort: 4 }) } }, { inactive: [['b', 'K']], active: [['c', 'K2']] }));
    for (const routes of [{}, { b: route() }, { b: route({ hardwareAvailability: { ...projection, key: 'other' } }) }, { b: route({ hardwareAvailability: { ...projection, state: 'ready' } }) },
        { b: route({ hardwareAvailability: projection, hostPort: 4 }) }, { b: route({ hardwareAvailability: projection, serviceTargets: [] }) }]) assert.throws(() => assertRoutes({ routes }, { inactive: [['b', 'K']] }));
    assert.throws(() => assertRoutes({ routes: { c: { container: 'K2', hardwareAvailability: projection } } }, { active: [['c', 'K2']] }), /marked unavailable/);
    const id = letter => letter.repeat(64);
    const rows = parseNestedStates(`${id('a')}\t/one\trunning\n${id('b')}\t/two\texited\n`);
    assert.doesNotThrow(() => assertNestedStates(rows, { running: [['one', 'one']], notRunning: [['two', 'two'], ['absent', 'absent']] }));
    assert.throws(() => assertNestedStates(rows, { running: [['two', 'two']] })); assert.throws(() => assertNestedStates(rows, { notRunning: [['one', 'one']] }));
    assert.throws(() => parseNestedStates('not a row\n'));
    assert.deepEqual(assertControllersUnchanged(['pids', 'cpu'], ['cpu', 'pids']), ['cpu', 'pids']);
    for (const [before, after] of [[[], []], [['cpu'], ['cpu', 'memory']], [null, null]]) assert.throws(() => assertControllersUnchanged(before, after));
    assert.deepEqual(d4Manifest({ container: 'i', network: { mode: 'managed', other: 1 }, containerSecurity: { gpu: false } }), { container: 'i', network: { mode: 'host', other: 1 }, containerSecurity: { gpu: false, nestedPodman: true } });
    assert.deepEqual(withEnable({ container: 'i' }, ['r/b no-wait']), { container: 'i', enable: ['r/b no-wait'] });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// LIVE-C3V

const c3vContext = async (t, faults = {}) => liveWorld(t, { block: C3VB, faults, ports: ROUTER_CONTROLS_PORTS });

test('X4.c3v-passes-in-a-dedicated-workspace-with-its-own-ports-and-the-box-is-destroyed-and-absent-afterwards', async t => {
    const context = await c3vContext(t);
    const { fake, workspace, w } = context;
    assert.deepEqual(w.run.ports, { tcp: 18090, udp: 17892 });
    const result = await liveRun(context);
    assert.equal(result.case.result, 'pass', JSON.stringify(result.case).slice(0, 600));
    assert.equal(result.report.verdict, 'PASS'); assert.equal(result.report.cleanup.state, 'complete');
    const evidence = result.case.evidence;
    assert.deepEqual([evidence.ports, evidence['static-route'].status, evidence['static-route'].error, evidence['static-route'].code, evidence['auth-login'].status, evidence['admin-api'].status, evidence['admin-api'].availability],
        [{ tcp: 18090, udp: 17892 }, 503, 'AGENT_HARDWARE_UNAVAILABLE', 'hardware_refused', 200, 200, 'refused']);
    assert.deepEqual([evidence['limits-status'], evidence['limits-clear']], [{ status: 0 }, { status: 0 }]);
    // The probes went to the dedicated pair, the host commands ran in the workspace with the exact argv, and the override is gone.
    assert.ok(fake.model.httpCalls.every(call => call.port === 18090));
    assert.deepEqual(fake.model.httpCalls.map(call => call.path), ['/', '/auth/login']);
    assert.deepEqual(candidateCalls(fake, 'limits').map(call => call.args.slice(1)), [['limits', 'status'], ['limits', 'clear', '--agent', 'hwlfixture/s']]);
    assert.equal(fake.model.overrides.size, 0);
    // Destroyed and proven absent by the cleanup: the Box is not in the engine's world and nothing owned remains.
    assert.equal(exists(workspace), false);
    assert.equal(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).destroyCalls, 1);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).boxes), []);
    for (const name of ['router-controls-static-route', 'router-controls-auth-login', 'router-controls-admin-api', 'router-controls-limits-clear']) assert.ok(result.artifacts.has(name), name);
});

const c3vFailures = [
    ['the static route is a startup page', { staticAnswer: 'startup-page' }, /did not answer a terminal 503 JSON \(HTTP 200/],
    ['the static route does not answer', { staticAnswer: 'unreachable' }, /did not answer a terminal 503 JSON \(HTTP null/],
    ['the login page does not answer 200', { loginStatus: 302 }, /\/auth\/login answered HTTP 302, not 200/],
    ['the host limits status fails', { limitsStatusExit: 2 }, /`ploinky limits status` did not exit 0/],
    ['the host limits clear fails', { limitsClearExit: 1 }, /`ploinky limits clear --agent` did not exit 0/],
    ['the host clear leaves the override', { clearKeepsOverride: true }, /The host clear left the stored override/],
    ['the static fixture never becomes refused', { omitRefusal: true }, /The static fixture is not refused|never/],
    ['the administrator API does not list the static fixture as refused', { adminListEmpty: true }, /The administrator API does not show the blocked static fixture as refused/],
    ['the static fixture is not ready at the start', { notReadyAtStart: 's' }, /baseline: The static fixture is not ready \(availability starting\)/],
];
for (const [label, faults, pattern] of c3vFailures) {
    test(`X4.c3v-fails-when-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, async t => {
        const context = await c3vContext(t, faults);
        const result = await liveRun(context);
        assert.equal(result.case.result, 'fail', `${label}: ${JSON.stringify(result.case).slice(0, 500)}`);
        assert.match(result.case.reason, pattern, label);
        assert.equal(result.report.verdict, 'FAIL'); assert.equal(result.report.cleanup.state, 'complete');
        assert.equal(exists(context.workspace), false);
    });
}

test('X4.c3v-the-administrator-api-or-the-state-unreachable-is-blocked-with-evidence-and-never-passed', async t => {
    const context = await c3vContext(t, { adminStatus: 503 });
    const result = await liveRun(context);
    assert.equal(result.case.result, 'blocked', JSON.stringify(result.case).slice(0, 400));
    assert.match(result.case.reason, /administrator route answered 503/);
    assert.equal(result.report.verdict, 'BLOCKED'); assert.equal(result.report.cleanup.state, 'complete');
});

test('X4.c3v-the-router-answers-are-judged-by-their-own-evaluators', () => {
    const good = { status: 503, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ error: 'AGENT_HARDWARE_UNAVAILABLE', state: 'refused', code: 'hardware_refused', reason: 'r', fix: 'f' }) };
    assert.deepEqual(assertStaticTerminal(good), { status: 503, error: 'AGENT_HARDWARE_UNAVAILABLE', code: 'hardware_refused', state: 'refused' });
    const withBody = patch => ({ ...good, body: JSON.stringify({ ...JSON.parse(good.body), ...patch }) });
    for (const bad of [null, { ...good, status: 200 }, { ...good, status: 502 }, { ...good, contentType: 'text/html' }, { ...good, body: 'not json' }, withBody({ error: 'other' }), withBody({ code: 'startup' }), withBody({ reason: '' }), withBody({ fix: '' })]) assert.throws(() => assertStaticTerminal(bad));
    assert.doesNotThrow(() => assertStaticTerminal(withBody({ code: 'hardware_blocked' })));
    assert.equal(C3V_AGENTS.join(), 's'); assert.equal(BOX_IMAGE.startsWith('docker.io/assistos/ploinky-box@sha256:'), true);
});

test('X4.c3v-a-port-collision-on-the-dedicated-pair-blocks-provisioning-before-any-box-exists', async t => {
    const w = world(t, { block: C3VB, ports: ROUTER_CONTROLS_PORTS });
    const calls = [];
    const report = await provisionRun({ run: w.run, persist: w.persist, processProvider: async (...args) => { calls.push(args); return w.engineProvider(...args); }, portProbe: async ports => { calls.push(['probe', ports]); return { tcp: false, udp: true }; },
        hostIdentity: w.hostIdentity, remoteArrival: w.remote, validateProfile });
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations.join(' '), /Selected host port collision \(tcp 18090: busy, udp 17892: free\)/);
    assert.deepEqual(calls.find(call => call[0] === 'probe')[1], { tcp: 18090, udp: 17892 });
    assert.equal(calls.some(call => call[1]?.includes?.('start')), false, 'the Box was never started');
    const cleanup = await executeCleanupRun({ run: w.run, hostIdentity: w.hostIdentity, processProvider: w.engineProvider, persist: w.persist, remoteArrival: w.remote });
    assert.equal(cleanup.verdict, 'PASS');
});
