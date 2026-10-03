// Step-4 executors (release plan C8b), checkpoint E1: the foreign-workspace guard, C1/C2 on native Linux and C6.
// Offline: every engine, candidate and SSH host is a fake; nothing starts a container, opens SSH or uses a GPU or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { candidateArgvProblem, candidateOperationsOf, isCandidateArgv } from '../hardware-limits/candidateArgv.mjs';
import { CASE_PASS_CONDITIONS, CONCRETE_BLOCKS, renderSummary } from '../hardware-limits/liveManifest.mjs';
import { LIVE_CASES, UNSUPPORTED, executeCleanupRun, executeLiveRun, validateProfile } from '../hardware-limits/liveHarness.mjs';
import { provisionRun } from '../hardware-limits/liveFixture.mjs';
import { CORE_LAYOUT, LEAF_OBSERVATION, MEMBERSHIP } from '../hardware-limits/liveCaseCommands.mjs';
import { FOREIGN_WORKSPACE_DIRECTORIES, foreignWorkspaceProblem } from '../hardware-limits/liveCommon.mjs';
import { worldState } from '../hardware-limits/fakeLiveEngine.mjs';
import { productionLayout } from '../hardware-limits/coreLayoutWorld.mjs';
import { BOX_IMAGE, exists, free, world } from '../hardware-limits/executorWorld.mjs';
import { BOX_CONTRACT_INSPECT } from '../hardware-limits/liveCommon.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';

const ok = stdout => ({ status: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false, cancelled: false, errorCode: null, settlementForced: false });
const provision = (w, options = {}) => provisionRun({
    run: w.run, persist: w.persist, processProvider: options.processProvider || w.engineProvider, portProbe: free, hostIdentity: w.hostIdentity, remoteArrival: w.remote, validateProfile,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The foreign-workspace guard (plan C7): ABORT before any mutation.

test('X4.foreign-guard-refuses-a-workspace-stage-or-cwd-under-the-other-sessions-directories-and-a-derived-box-name', t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-fg-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const foreign = FOREIGN_WORKSPACE_DIRECTORIES.map(directory => path.join(home, directory));
    assert.deepEqual(FOREIGN_WORKSPACE_DIRECTORIES, ['work/testExplorerFresh', 'cleanup-repair-claude-20261002']);
    for (const directory of foreign) fs.mkdirSync(directory, { recursive: true });
    for (const directory of foreign) {
        for (const candidate of [directory, path.join(directory, 'workspace'), path.join(directory, 'a', 'b', 'c')]) {
            assert.match(foreignWorkspaceProblem({ homes: [home], paths: [candidate] }), /Foreign-workspace guard: .* is under /, candidate);
        }
    }
    // Neither a sibling that merely shares the prefix nor the parent is under the directory.
    assert.equal(foreignWorkspaceProblem({ homes: [home], paths: [`${foreign[0]}2/workspace`, path.join(home, 'work'), home, path.join(home, 'work', 'mine')] }), null);
    // A symlink alias into a foreign directory is judged where it leads, and so is a path that does not exist yet.
    const alias = path.join(home, 'alias'); fs.symlinkSync(foreign[0], alias);
    assert.match(foreignWorkspaceProblem({ homes: [home], paths: [path.join(alias, 'fresh', 'workspace')] }), /Foreign-workspace guard/);
    // The other session's Box name, with or without the engine's leading slash, case-insensitively.
    for (const name of ['ploinky-box-testexplorerfresh-9d2ec627469d', '/ploinky-box-testexplorerfresh-0123456789ab', 'ploinky-box-TestExplorerFresh-abcdef012345']) {
        assert.match(foreignWorkspaceProblem({ homes: [home], names: [name] }), /matches the other session's/, name);
    }
    assert.equal(foreignWorkspaceProblem({ homes: [home], names: ['ploinky-box-hwl-9d2ec627469d', 'ploinky-box-explorer-0123456789ab'] }), null);
    // Several homes: every one is checked (the pinned home and this process's own).
    assert.match(foreignWorkspaceProblem({ homes: ['/nonexistent-home', home], paths: [path.join(foreign[1], 'x')] }), /Foreign-workspace guard/);
});

test('X4.foreign-guard-aborts-provision-live-and-cleanup-before-any-command', async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-fg-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const parentRoot = path.join(home, 'work', 'testExplorerFresh');
    const w = world(t, { block: 'mac-cpu', home, parentRoot });
    const commands = [];
    const provider = async (...args) => { commands.push(args); return w.engineProvider(...args); };
    const report = await provision(w, { processProvider: provider });
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations.join(' '), /Foreign-workspace guard/);
    assert.equal(commands.length, 0, 'not one command ran'); assert.equal(exists(w.run.target.execution.provision.workspace.parent), false, 'nothing was created');
    assert.equal(w.run.operations.length, 0); assert.equal(w.run.ownedPaths.length, 0);
    // live and cleanup over a (hand-completed) profile whose workspace is under the directory: refused with zero commands.
    for (const run of [w.run]) {
        run.target.execution.workspace = { path: run.target.execution.provision.workspace.path, uid: 0, dev: '1', ino: '1', marker: w.runId };
        for (const action of [executeLiveRun, executeCleanupRun]) {
            const result = await action({ run, hostIdentity: w.hostIdentity, processProvider: provider, persist: w.persist });
            assert.notEqual(result.verdict, 'PASS'); assert.match(result.limitations.join(' '), /Foreign-workspace guard/);
        }
    }
    assert.equal(commands.length, 0);
});

test('X4.foreign-guard-aborts-when-the-working-directory-is-under-the-other-sessions-directory', async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-fg-')));
    const cwd = process.cwd();
    t.after(() => { process.chdir(cwd); fs.rmSync(home, { recursive: true, force: true }); });
    const here = path.join(home, 'cleanup-repair-claude-20261002', 'sub'); fs.mkdirSync(here, { recursive: true });
    const w = world(t, { block: 'apparatus-core', home });
    const commands = [];
    process.chdir(here);
    const report = await provision(w, { processProvider: async (...args) => { commands.push(args); return w.engineProvider(...args); } });
    process.chdir(cwd);
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations.join(' '), /Foreign-workspace guard/);
    assert.equal(commands.length, 0);
});

test('X4.foreign-guard-refuses-a-derived-box-name-of-the-other-session', async t => {
    const w = world(t, { block: 'apparatus-core' });
    w.run.workspace.instance = 'ploinky-box-testexplorerfresh-9d2ec627469d';
    const commands = [];
    // A hand-edited instance would also fail the identity check; the guard speaks first.
    const report = await executeLiveRun({ run: w.run, hostIdentity: w.hostIdentity, processProvider: async (...args) => { commands.push(args); return ok(''); }, persist: w.persist });
    assert.notEqual(report.verdict, 'PASS'); assert.equal(commands.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// C1/C2 on native Linux: the block, its manifest and summary, the real parser, provisioning and cleanup, and a live C1 with A4 ownership.

test('X4.apparatus-core-block-is-a-linux-remote-block-with-the-c1-and-c2-executors-and-no-unsupported-entry', () => {
    assert.deepEqual(CONCRETE_BLOCKS['apparatus-core'], { platform: 'linux', remote: true, cases: ['LIVE-C1', 'LIVE-C2'] });
    assert.deepEqual(LIVE_CASES['apparatus-core'], ['LIVE-C1', 'LIVE-C2']);
    assert.deepEqual(['LIVE-C1', 'LIVE-C2'].filter(id => UNSUPPORTED[id]), []);
    assert.equal(CONCRETE_BLOCKS['mac-cpu'].platform, 'darwin', 'the Mac block stays Mac-bound');
});

test('X4.apparatus-core-manifest-and-summary-name-the-pass-conditions-the-guard-and-the-owned-resources', t => {
    const w = world(t, { block: 'apparatus-core' });
    const profile = w.run.target.execution;
    assert.equal(profile.host.platform, 'linux'); assert.deepEqual(profile.cases, ['LIVE-C1', 'LIVE-C2']);
    assert.deepEqual(profile.provision.agents.map(agent => agent.role), ['memory', 'cpu', 'pids']);
    assert.ok(w.run.target.remote && w.run.target.stage.root.startsWith(`${w.home}/.cache/ploinky-hwlimits/`));
    assert.equal(profile.provision.boxImage, BOX_IMAGE);
    const summary = renderSummary(w.run, w.runPath);
    for (const text of ['## Pass conditions (the spec rows, unchanged)', '## Foreign-workspace guard', 'spec 15.4 LIVE-C1 (:1322) with amendment A4', 'uid 0 or by the Box runtime uid 1000',
        'spec 15.4 LIVE-C2 (:1323)', 'memory.max=67108864', 'SAME leaf identity', 'testExplorerFresh', 'cleanup-repair-claude-20261002', 'ploinky-box-testexplorerfresh-*', 'apparatus-core']) {
        assert.ok(summary.includes(text), text);
    }
    for (const id of ['LIVE-C1', 'LIVE-C2']) assert.ok(CASE_PASS_CONDITIONS[id].passes && CASE_PASS_CONDITIONS[id].row);
});

test('X4.apparatus-core-every-candidate-argv-is-accepted-by-the-real-parser-and-provision-and-cleanup-leave-nothing', async t => {
    const w = world(t, { block: 'apparatus-core' });
    const operations = candidateOperationsOf(w.run);
    assert.ok(operations.some(operation => operation.id === 'fixture-start') && operations.some(operation => operation.id === 'destroy-box'));
    for (const operation of operations) assert.equal(candidateArgvProblem(operation.argv), null, operation.argv.join(' '));
    const report = await provision(w);
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    for (const call of worldState(w.statePath).calls.filter(value => isCandidateArgv(value.args))) assert.equal(candidateArgvProblem(call.args), null, call.args.join(' '));
    const cleaned = await executeCleanupRun({ run: w.run, persist: w.persist, processProvider: w.engineProvider, hostIdentity: w.hostIdentity, remoteArrival: true });
    assert.equal(cleaned.verdict, 'PASS', JSON.stringify(w.run.cleanup));
    assert.deepEqual(Object.keys(worldState(w.statePath).boxes), []);
});

// A provisioned apparatus-core run, the C1 observation supplied by the production-preparation layout (the observer program itself runs over it).
async function liveC1(t, { layout, mutate = null } = {}) {
    const patch = { pid: 123, startedAt: '2026-10-02T00:02:00Z', conmonPid: 456, memory: 67108864, memorySwap: 67108864, pidsLimit: 64, nanoCpus: 500000000 };
    const w = world(t, { block: 'apparatus-core', faults: { 'agent-inspect': { patch } } });
    const report = await provision(w);
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    w.run.target.execution.cases = ['LIVE-C1'];
    const kinds = [];
    const provider = async (binary, args, options) => {
        if (args.includes(CORE_LAYOUT)) { kinds.push('layout'); return ok(JSON.stringify(layout)); }
        if (args.includes(MEMBERSHIP)) return ok(JSON.stringify({ pid: Number(args.at(-1)), start: '100', cgroup: args.at(-1) === '456' ? '0::/ploinky/core\n' : '0::/ploinky/agents/task\n' }));
        if (args.includes(LEAF_OBSERVATION)) return ok(JSON.stringify({ identity: { dev: '1', ino: '2' }, 'memory.max': '67108864\n', 'memory.swap.max': '0\n', 'memory.current': '1\n', 'memory.swap.current': '0\n', 'memory.events': 'oom_kill 0\n', 'cpu.max': '50000 100000\n', 'cpu.stat': 'nr_throttled 0\n', 'pids.max': '64\n', 'pids.events': 'max 0\n' }));
        return w.engineProvider(binary, args, options);
    };
    const live = await executeLiveRun({ run: w.run, hostIdentity: w.hostIdentity, processProvider: mutate ? mutate(provider) : provider, persist: w.persist, remoteArrival: true });
    return { w, live, kinds, row: live.cases.find(entry => entry.id === 'LIVE-C1') };
}

test('X4.apparatus-core-c1-passes-on-a-native-linux-layout-with-the-a4-ownership-and-fails-on-another-owner', async t => {
    const { layout: produced } = await productionLayout();
    // A4: every other interface file at / is uid 0 or the Box runtime uid 1000 (the engine-owned shape of a keep-id Box); the three delegation
    // files stay uid 0. Both shapes pass.
    const layout = structuredClone(produced);
    for (const name of ['cpu.max', 'memory.max', 'pids.max', 'cgroup.controllers']) if (layout.paths['/'].files[name]?.present !== false) layout.paths['/'].files[name].uid = 1000;
    assert.ok(Object.values(layout.paths['/'].files).some(file => file.present !== false && file.uid === 1000));
    assert.equal((await liveC1(t, { layout: produced })).row.result, 'pass');
    const pass = await liveC1(t, { layout });
    assert.equal(pass.row.result, 'pass', JSON.stringify(pass.row)); assert.deepEqual(pass.kinds, ['layout']);
    assert.equal(pass.live.verdict, 'BLOCKED', 'the block passes only with C2 as well');
    // The same layout with one root interface file owned by another uid is a FAIL with the observation attached.
    const wrong = structuredClone(layout); wrong.paths['/'].files['memory.max'].uid = 4242;
    const failed = await liveC1(t, { layout: wrong });
    assert.equal(failed.row.result, 'fail'); assert.match(failed.row.reason, /ownership mismatch/); assert.deepEqual(failed.row.evidence.layout, wrong);
    // A root delegation file owned by 1000 is also refused (A4 keeps cgroup.procs, cgroup.subtree_control and cgroup.threads at uid 0).
    const delegation = structuredClone(layout); delegation.paths['/'].files['cgroup.procs'].uid = 1000;
    assert.equal((await liveC1(t, { layout: delegation })).row.result, 'fail');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// C6: the Router authority helper through the post-probe/pre-cleanup observation seam (spec 15.4 :1327).
import { spawnSync } from 'node:child_process';
import {
    AUTHORITY_HELPER_PROGRAM, DELAYED_ALLOCATION, HELPER_MEMORY_BYTES, HELPER_PEAK_MAX_BYTES, assertDelayedSamplingOrder, assertHelperObservation, assertRealHelperPeak, helperProgramArgv,
} from '../hardware-limits/liveHelperCommands.mjs';

const MiB = 1024 * 1024;
const HELPER_ID = 'd'.repeat(64);
// A helper observation as the in-Box program writes it: lifecycle events in microseconds, the leaf readings, the attested helper.
function observation({ mode = 'real', peak = 30 * MiB, max = HELPER_MEMORY_BYTES, placement = 'enforced', leaf = `libpod-${HELPER_ID}`, order = null, execMs = 120, attestation = `sha256:${'e'.repeat(64)}`, helperId = HELPER_ID, external = [{ host: 'a', status: 401 }, { host: 'b', status: 421 }], delayed = mode === 'delayed' } = {}) {
    const base = 1_000_000;
    const events = order || [
        { name: 'register', atUs: base }, { name: 'probe-exec-begin', atUs: base + 10 }, { name: 'probe-exec-end', atUs: base + 10 + execMs * 1000, status: 0 },
        { name: 'consume', atUs: base + 20 + execMs * 1000 }, { name: 'observe', atUs: base + 30 + execMs * 1000, helperId, placement }, { name: 'sample', atUs: base + 40 + execMs * 1000 },
    ];
    return {
        schema: 1, mode, attestationId: attestation, helper: { id: helperId, image: `sha256:${'f'.repeat(64)}`, user: '65534:65534' }, external,
        observed: { helperId, placement, leaf, leafError: null, memoryPeak: `${peak}\n`, memoryMax: `${max}\n`, memoryCurrent: '100\n', memoryEvents: 'oom_kill 0\n' },
        events, execBegan: true, delayedPlanned: delayed ? { bytes: DELAYED_ALLOCATION.bytes, delayMs: DELAYED_ALLOCATION.delayMs } : null,
    };
}
const delayedObservation = (overrides = {}) => observation({ mode: 'delayed', peak: 30 * MiB + DELAYED_ALLOCATION.bytes, execMs: DELAYED_ALLOCATION.delayMs + 300, ...overrides });

test('X4.c6-a-real-helper-observation-passes-only-with-attestation-identity-placement-order-and-a-readable-peak', () => {
    const facts = assertRealHelperPeak(observation());
    assert.equal(facts.peakBytes, 30 * MiB); assert.equal(facts.maxBytes, 67108864);
    // Real attestation success: no identity, or a probe without exactly two observations, is not a success.
    assert.throws(() => assertHelperObservation(observation({ attestation: '' })), /Real attestation did not succeed/);
    assert.throws(() => assertHelperObservation(observation({ external: [{ host: 'a', status: 401 }] })), /exactly two observations/);
    assert.throws(() => assertHelperObservation(observation({ external: [{ host: 'a', status: 401 }, { host: 'b' }] })), /exactly two observations/);
    // An immutable helper identity.
    assert.throws(() => assertHelperObservation(observation({ helperId: 'podman-helper' })), /immutable container and image ID/);
    const wrongHelper = observation(); wrongHelper.observed.helperId = 'a'.repeat(64);
    assert.throws(() => assertHelperObservation(wrongHelper), /not made for the attested helper/);
    // Placement: an unplaced helper's peak is not the enforced helper's, and it needs a leaf.
    assert.throws(() => assertHelperObservation(observation({ placement: 'recorded, not enforced' })), /not placed in the delegated hierarchy/);
    assert.throws(() => assertHelperObservation(observation({ leaf: null })), /has no leaf under \/ploinky\/system/);
    // The recorded 64m: another memory.max is another helper.
    assert.throws(() => assertHelperObservation(observation({ max: 134217728 })), /not the recorded 67108864 \(64m\)/);
    for (const peak of ['', 'x', '0', '-1']) { const value = observation(); value.observed.memoryPeak = peak; assert.throws(() => assertHelperObservation(value), /memory\.peak is missing/, JSON.stringify(peak)); }
    const noMax = observation(); noMax.observed.memoryMax = null; assert.throws(() => assertHelperObservation(noMax), /memory\.max is missing/);
    // The lifecycle order: the seam runs after the exec ended and the observation was consumed.
    const at = (mutate) => { const value = observation(); mutate(value.events); return value; };
    assert.throws(() => assertHelperObservation(at(events => { events.find(event => event.name === 'observe').atUs = 1_000_005; })), /sampled out of order/);
    assert.throws(() => assertHelperObservation(at(events => { events.find(event => event.name === 'sample').atUs = 1_000_005; })), /sampled out of order/);
    assert.throws(() => assertHelperObservation(at(events => { events.find(event => event.name === 'consume').atUs = 9_000_000; })), /sampled out of order/);
    assert.throws(() => assertHelperObservation(at(events => { events.find(event => event.name === 'probe-exec-end').status = 1; })), /did not end successfully/);
    assert.throws(() => assertHelperObservation(at(events => { events.splice(events.findIndex(event => event.name === 'observe'), 1); })), /'observe' events instead of exactly one/);
    assert.throws(() => assertHelperObservation(at(events => { events.push({ ...events[0], name: 'sample' }); })), /'sample' events instead of exactly one/);
    // The wrong mode is refused.
    assert.throws(() => assertHelperObservation(observation({ mode: 'delayed' }), { mode: 'real' }), /another mode/);
});

test('X4.c6-the-real-peak-is-at-most-48-mib-at-64m-and-a-larger-need-is-a-reviewed-redesign-never-a-silent-increase', () => {
    assert.equal(HELPER_PEAK_MAX_BYTES, 48 * MiB); assert.equal(HELPER_MEMORY_BYTES, 64 * MiB);
    assert.doesNotThrow(() => assertRealHelperPeak(observation({ peak: 48 * MiB })));
    assert.throws(() => assertRealHelperPeak(observation({ peak: 48 * MiB + 1 })), /over the 50331648 bytes allowed at 64m.*128m with at most 96 MiB.*new candidate/s);
    assert.throws(() => assertRealHelperPeak(observation({ peak: 60 * MiB })), /memory\.peak is 62914560 bytes/);
    // A peak above the leaf's own cap cannot be a real reading.
    assert.throws(() => assertRealHelperPeak(observation({ peak: 65 * MiB })), /exceeds its own memory\.max/);
});

test('X4.c6-the-delayed-allocating-probe-proves-the-sampling-order-and-an-early-sample-or-a-missing-allocation-fails', () => {
    const real = observation();
    const facts = assertDelayedSamplingOrder(delayedObservation(), real);
    assert.ok(facts.delayedPeakBytes >= facts.realPeakBytes + DELAYED_ALLOCATION.minPeakIncreaseBytes); assert.ok(facts.execMs >= DELAYED_ALLOCATION.delayMs);
    // The late allocation is missing from the peak: the sample was taken before it (or the peak is not final).
    assert.throws(() => assertDelayedSamplingOrder(delayedObservation({ peak: 30 * MiB + 4 * MiB }), real), /does not carry its late allocation/);
    assert.throws(() => assertDelayedSamplingOrder(delayedObservation({ peak: 30 * MiB }), real), /does not carry its late allocation/);
    assert.doesNotThrow(() => assertDelayedSamplingOrder(delayedObservation({ peak: 30 * MiB + DELAYED_ALLOCATION.minPeakIncreaseBytes }), real));
    // The exec was shorter than the delay: the allocation did not happen inside the probe.
    assert.throws(() => assertDelayedSamplingOrder(delayedObservation({ execMs: DELAYED_ALLOCATION.delayMs - 500 }), real), /shorter than its 2000 ms delay/);
    // Sampled before the exec ended.
    const early = delayedObservation(); early.events.find(event => event.name === 'sample').atUs = 1_000_005;
    assert.throws(() => assertDelayedSamplingOrder(early, real), /sampled out of order/);
    // A delayed run that did not carry the approved allocation and delay.
    for (const planned of [{ bytes: 1024, delayMs: DELAYED_ALLOCATION.delayMs }, { bytes: DELAYED_ALLOCATION.bytes, delayMs: 1 }, null]) {
        const value = delayedObservation(); value.delayedPlanned = planned;
        assert.throws(() => assertDelayedSamplingOrder(value, real), /did not carry the approved allocation and delay/);
    }
    // The delayed observation must itself be a valid helper observation of the delayed mode.
    assert.throws(() => assertDelayedSamplingOrder(observation(), real), /another mode/);
    assert.throws(() => assertDelayedSamplingOrder(delayedObservation({ placement: 'recorded, not enforced' }), real), /not placed/);
});

// The reviewed program, run for real over a stub product tree and a stub cgroup tree: it must wire the seam, report the lifecycle events and rewrite only
// the helper's probe exec in delayed mode.
function stubTree(t, { peak = String(30 * MiB), max = String(HELPER_MEMORY_BYTES), noLeaf = false } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-c6-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (relative, text) => { const file = path.join(root, 'product', relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    write('package.json', '{"type":"module"}');
    const log = path.join(root, 'calls.jsonl');
    const podman = path.join(root, 'podman-stub'); fs.writeFileSync(podman, `#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' ${JSON.stringify(log)} "$@"\nprintf '[{"host":"a","status":401},{"host":"b","status":421}]'\n`, { mode: 0o755 });
    write('cli/sandbox/networkLifecycle.js', `export function createNetworkLifecycleAdapter(options) { return { prepare(network, agent, opts) { return { mode: network.mode, runtimeProof: { engine: 'podman' }, networkFingerprint: 'sha256:' + 'a'.repeat(64), agent, instanceKey: opts.instanceKey, options }; } }; }`);
    write('cli/sandbox/edgeGeneration.js', `export function createRouterAttestationGenerationLease(options) { return { id: 'g', snapshot: { routing: { static: { agent: 'hwlfixture/memory' } } }, owner: options.expectedOwner, commit: () => true }; }\nexport function edgeRuntimeEnvironment() { return { PLOINKY_EDGE_TOPOLOGY_FILE: '/edge/topology.json' }; }`);
    write('cli/sandbox/routerAuthorityAttestation.js', `
export function buildRouterAuthorityTopologyIntent(options) { return { ...options }; }
export function attestRouterAuthority({ intent, generationLease, runProbe }) {
  const probe = runProbe({ intent, nonce: 'n'.repeat(64), registerObservation() {}, consumeObservation() { return []; } });
  return { attestationId: 'sha256:' + 'e'.repeat(64), evidence: { helper: probe.helper, external: probe.external } };
}
export function runContainerAuthorityProbe(options) {
  options.registerObservation();
  const result = options.commandRunner.run(${JSON.stringify(podman)}, ['exec', '--user', '65534:65534', ${JSON.stringify(HELPER_ID)}, 'node', '-e', 'PROBE', 'origin', 'first', 'second', 'nonce'], {});
  if (result.status !== 0) throw new Error('probe failed');
  options.consumeObservation();
  options.observeCompletedProbe({ helperId: ${JSON.stringify(HELPER_ID)}, placement: options.placement.status });
  return { external: JSON.parse(String(result.stdout)), helper: { id: ${JSON.stringify(HELPER_ID)}, image: 'sha256:' + 'f'.repeat(64), user: '65534:65534' } };
}`);
    write('cli/sandbox/hardwareLimits/delegation.mjs', `export function authorityHelperPlacementFromContext(context) { return { status: context.placed ? 'enforced' : 'recorded, not enforced' }; }`);
    write('cli/sandbox/hardwareLimits/requestedLimits.mjs', `export function captureHardwareContext() { return { placed: true }; }`);
    write('cli/utils/agentRegistrySnapshot.js', `export function readAgentRegistrySnapshot() { return { 'ploinky_hwlfixture_memory_x_1': { instanceId: 'i1', enableGeneration: 'g1' } }; }`);
    write('cli/utils/workspaceDependencyGraph.js', `export function effectiveInstanceKey(repo, agent, alias) { return repo + '/' + agent + ':' + alias; }`);
    write('cli/utils/security/agentIdentity.js', `export function deriveAgentPrincipalId(repo, agent) { return 'agent:' + repo + '/' + agent; }`);
    write('ploinky-box/lib/boxMarker.mjs', `export function isInsideBox() { return true; }`);
    const cgroup = path.join(root, 'cg');
    if (!noLeaf) {
        const leaf = path.join(cgroup, 'ploinky', 'system', `libpod-${HELPER_ID}`); fs.mkdirSync(leaf, { recursive: true });
        for (const [name, value] of Object.entries({ 'memory.peak': peak, 'memory.max': max, 'memory.current': '1000', 'memory.events': 'oom_kill 0' })) fs.writeFileSync(path.join(leaf, name), `${value}\n`);
    }
    return { root: path.join(root, 'product'), cgroup, log };
}
const runProgram = (stub, mode, extra = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', AUTHORITY_HELPER_PROGRAM, JSON.stringify({
    root: stub.root, cgroupRoot: stub.cgroup, mode, routerPort: 23456, containerName: 'ploinky_hwlfixture_memory_x_1', repoName: 'hwlfixture', agentName: 'memory', image: 'img@sha256:x',
    ...(mode === 'delayed' ? { delayed: { bytes: DELAYED_ALLOCATION.bytes, delayMs: DELAYED_ALLOCATION.delayMs } } : {}), ...extra,
})], { encoding: 'utf8', timeout: 20000 });

test('X4.c6-the-program-runs-the-products-probe-with-only-the-seam-and-rewrites-only-the-delayed-probe-exec', t => {
    const stub = stubTree(t);
    const real = runProgram(stub, 'real');
    assert.equal(real.status, 0, real.stderr);
    const value = JSON.parse(real.stdout);
    assert.doesNotThrow(() => assertRealHelperPeak(value));
    assert.deepEqual(value.events.map(event => event.name), ['register', 'probe-exec-begin', 'probe-exec-end', 'consume', 'observe', 'sample']);
    assert.equal(value.observed.leaf, `libpod-${HELPER_ID}`); assert.equal(value.observed.memoryPeak.trim(), String(30 * MiB));
    // The real run's exec is the product's own argv, untouched.
    const calls = fs.readFileSync(stub.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls[0], ['exec', '--user', '65534:65534', HELPER_ID, 'node', '-e', 'PROBE', 'origin', 'first', 'second', 'nonce']);
    // The delayed run prefixes ONLY the probe script, keeping the product's script and every other argument.
    fs.rmSync(stub.log);
    const delayed = runProgram(stub, 'delayed');
    assert.equal(delayed.status, 0, delayed.stderr);
    const [exec] = fs.readFileSync(stub.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(exec.length, 11);
    assert.deepEqual([...exec.slice(0, 6), ...exec.slice(7)], ['exec', '--user', '65534:65534', HELPER_ID, 'node', '-e', 'origin', 'first', 'second', 'nonce']);
    assert.ok(exec[6].endsWith('PROBE') && exec[6].startsWith(';setTimeout(()=>{globalThis.__hold=Buffer.alloc(16777216,1)},2000);'), exec[6]);
    assert.equal(JSON.parse(delayed.stdout).delayedPlanned.delayMs, 2000);
});

test('X4.c6-the-program-fails-closed-without-a-registry-record-an-unplaced-helper-or-a-failed-probe', t => {
    const stub = stubTree(t);
    const bad = runProgram(stub, 'real', { containerName: 'ploinky_other' });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /no exact registry record/);
    for (const params of [{ mode: 'neither' }, { containerName: 'bad name' }]) { const refused = runProgram(stub, params.mode || 'real', params); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Invalid helper-probe parameters/); }
    const noLeaf = stubTree(t, { noLeaf: true });
    const value = JSON.parse(runProgram(noLeaf, 'real').stdout);
    assert.equal(value.observed.leaf, null); assert.throws(() => assertRealHelperPeak(value), /has no leaf under/);
    // The program's argv carries every manifest value as one JSON argument, never as source text.
    const argv = helperProgramArgv({ boxId: 'b'.repeat(64), workspace: '/ws', routerPort: 23456, params: { mode: 'real', root: '/opt/ploinky' } });
    assert.deepEqual(argv.slice(0, 8), ['container', 'exec', '--user', 'podman', '--workdir', '/ws', '--env', 'PLOINKY_ROUTER_HOST_PORT=23456']);
    assert.equal(argv.at(-2), AUTHORITY_HELPER_PROGRAM); assert.equal(JSON.parse(argv.at(-1)).mode, 'real');
    assert.equal(AUTHORITY_HELPER_PROGRAM.includes('23456'), false);
});

// A provisioned apparatus-authority run whose in-Box program answers are scripted: the executor, its persistence and its cleanup.
async function liveC6(t, { real = observation(), delayed = delayedObservation(), left = '', failProgram = null, calls = [] } = {}) {
    const patch = { pid: 123, startedAt: '2026-10-02T00:02:00Z', conmonPid: 456, memory: 67108864, memorySwap: 67108864, pidsLimit: 64, nanoCpus: 500000000 };
    const w = world(t, { block: 'apparatus-authority', faults: { 'agent-inspect': { patch } } });
    const report = await provision(w);
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    const artifacts = new Map();
    const provider = async (binary, args, options) => {
        if (args.includes(AUTHORITY_HELPER_PROGRAM)) {
            const mode = JSON.parse(args.at(-1)).mode; calls.push(mode);
            if (failProgram === mode) return { ...ok(''), status: 1, stderr: 'Error: no exact registry record\nPLOINKY_MASTER_KEY=hunter2hunter2' };
            return ok(JSON.stringify(mode === 'real' ? real : delayed));
        }
        if (args.includes('label=io.assistos.ploinky.authority-helper')) { calls.push('cleanup-proof'); return ok(left); }
        return w.engineProvider(binary, args, options);
    };
    const live = await executeLiveRun({ run: w.run, hostIdentity: w.hostIdentity, processProvider: provider, persist: w.persist, remoteArrival: true, artifacts: (name, value) => artifacts.set(name, structuredClone(value)) });
    return { w, live, row: live.cases.find(entry => entry.id === 'LIVE-C6'), artifacts, calls };
}

test('X4.c6-the-executor-runs-the-real-and-the-delayed-probe-persists-both-and-passes-only-when-every-condition-holds', async t => {
    const pass = await liveC6(t);
    assert.equal(pass.row.result, 'pass', JSON.stringify(pass.row)); assert.equal(pass.live.verdict, 'PASS'); assert.equal(pass.live.cleanup.state, 'complete');
    assert.deepEqual(pass.calls, ['real', 'delayed', 'cleanup-proof']);
    assert.equal(pass.row.evidence.real.helperId, HELPER_ID); assert.equal(pass.row.evidence.real.peakBytes, 30 * MiB); assert.deepEqual(pass.row.evidence.helperRemaining, []);
    assert.ok(pass.artifacts.has('authority-helper-real') && pass.artifacts.has('authority-helper-delayed') && pass.artifacts.has('authority-helper-cleanup'));
    assert.deepEqual(Object.keys(worldState(pass.w.statePath).boxes), [], 'the owned Box is destroyed by the cleanup');
    // A peak over 48 MiB: FAIL with the real observation attached, the delayed run never starts, and the cleanup still runs.
    const heavy = await liveC6(t, { real: observation({ peak: 49 * MiB }) });
    assert.equal(heavy.row.result, 'fail'); assert.match(heavy.row.reason, /over the 50331648 bytes allowed at 64m/); assert.deepEqual(heavy.calls, ['real']);
    assert.equal(heavy.row.evidence.real.observed.memoryPeak.trim(), String(49 * MiB)); assert.equal(heavy.live.cleanup.state, 'complete');
    // A delayed run that does not carry its allocation: FAIL naming the sampling order.
    const early = await liveC6(t, { delayed: delayedObservation({ peak: 30 * MiB }) });
    assert.equal(early.row.result, 'fail'); assert.match(early.row.reason, /does not carry its late allocation/);
    // A helper container left behind: FAIL.
    const left = await liveC6(t, { left: `${'1'.repeat(64)}\n` });
    assert.equal(left.row.result, 'fail'); assert.match(left.row.reason, /authority helper container remains/);
    // The program itself failing: FAIL with bounded, redacted tails and no pass.
    const failed = await liveC6(t, { failProgram: 'real' });
    assert.equal(failed.row.result, 'fail'); assert.match(failed.row.reason, /did not complete: exit 1/);
    assert.equal(JSON.stringify(failed.row.evidence).includes('hunter2'), false); assert.deepEqual(failed.calls, ['real']);
    for (const outcome of [heavy, early, left, failed]) assert.notEqual(outcome.live.verdict, 'PASS');
});

test('X4.c6-manifest-and-summary-show-the-program-the-bounds-and-the-guard-and-every-candidate-argv-is-accepted', async t => {
    const w = world(t, { block: 'apparatus-authority' });
    assert.deepEqual(w.run.target.execution.cases, ['LIVE-C6']); assert.deepEqual(w.run.target.execution.provision.agents.map(agent => agent.role), ['memory']);
    const ids = w.run.target.plan.live.map(step => step.id);
    assert.deepEqual(ids, ['C6-helper-real', 'C6-helper-delayed', 'C6-helper-cleanup-proof']);
    const summary = renderSummary(w.run, w.runPath);
    for (const text of ['spec 15.4 LIVE-C6 (:1327)', 'at most 48 MiB for 64m', '128m with at most 96 MiB', 'local-llm'].slice(0, 3)) assert.ok(summary.includes(text), text);
    const programDigest = crypto.createHash('sha256').update(AUTHORITY_HELPER_PROGRAM).digest('hex');
    assert.ok(summary.includes(`sha256:${programDigest}`), 'the approver sees the digest of the fixed in-Box program');
    for (const text of ['C6-helper-real', 'C6-helper-delayed', 'C6-helper-cleanup-proof', '16 MiB', '2000 ms', '## Foreign-workspace guard', 'apparatus-authority']) assert.ok(summary.includes(text), text);
    for (const operation of candidateOperationsOf(w.run)) assert.equal(candidateArgvProblem(operation.argv), null, operation.argv.join(' '));
    assert.deepEqual(['LIVE-C6'].filter(id => UNSUPPORTED[id]), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// R21-2: the provisioned Box's labels, image, privileges and publications are saved as run artifacts (every block, apparatus-cpu included).
test('R21.provision-saves-the-box-labels-image-privileges-and-publications-as-artifacts-in-every-block', async t => {
    for (const block of ['apparatus-cpu', 'apparatus-core', 'mac-cpu']) {
        const w = world(t, { block });
        const artifacts = new Map();
        const report = await provision(w, { artifacts: (name, value) => artifacts.set(name, structuredClone(value)) });
        assert.equal(report.verdict, 'PASS', `${block}: ${JSON.stringify(report.limitations)}`);
        assert.deepEqual(report.limitations, [], block);
        const box = w.run.target.execution.box;
        const inspect = artifacts.get('box-inspect');
        assert.equal(inspect.id, box.id, block); assert.equal(inspect.image, box.image, block); assert.equal(inspect.running, true, block);
        assert.equal(inspect.labels[BOX_LABELS.role], 'box', block); assert.match(inspect.labels[BOX_LABELS.hardwareLimits], /^[a-f0-9]{64}$/, block);
        assert.equal(inspect.labels[BOX_LABELS.imageRef], BOX_IMAGE, block);
        assert.ok(inspect.mounts.some(mount => mount.destination && typeof mount.rw === 'boolean' && mount.source), block);
        const contract = artifacts.get('box-contract');
        assert.equal(contract.id, box.id, block); assert.equal(contract.image, box.image, block); assert.deepEqual(contract.labels, inspect.labels, block);
        assert.equal(contract.privileged, false, block); assert.deepEqual(contract.capAdd, ['SYS_ADMIN', 'NET_ADMIN'], block); assert.deepEqual(contract.securityOpt, ['label=disable'], block);
        assert.deepEqual(Object.keys(contract.publications).sort(), ['7882/udp', '8080/tcp'], block);
        assert.equal(contract.publications['8080/tcp'][0].HostIp, '127.0.0.1', `${block}: the Router publication is loopback`);
        // The contract query is one journaled, read-only, identified command.
        const op = w.run.operations.find(entry => entry.kind === 'box-contract');
        assert.deepEqual([op.state, op.resourceIds], ['observed', [box.id]], block);
        assert.equal(op.argvDigest !== null, true, block);
    }
});

test('R21.a-box-contract-query-that-fails-is-recorded-as-a-limitation-and-never-fails-provisioning', async t => {
    const w = world(t, { block: 'apparatus-cpu' });
    const artifacts = new Map();
    const provider = async (binary, args, options) => (args.includes(BOX_CONTRACT_INSPECT) ? { ...ok(''), status: 125, stderr: "Error: can't evaluate field Privileged" } : w.engineProvider(binary, args, options));
    const report = await provision(w, { processProvider: provider, artifacts: (name, value) => artifacts.set(name, structuredClone(value)) });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    // Nothing is hidden: the limitation names it and the saved artifact says the observation was unavailable. The Box inspect artifact is unaffected.
    assert.equal(report.limitations.length, 1); assert.match(report.limitations[0], /The Box privilege and publication contract could not be observed: /);
    assert.deepEqual(Object.keys(artifacts.get('box-contract')), ['unavailable']); assert.match(artifacts.get('box-contract').unavailable, /Live command failed|did not return|exit/i);
    assert.equal(artifacts.get('box-inspect').id, w.run.target.execution.box.id);
    assert.equal(w.run.operations.find(entry => entry.kind === 'box-contract').state, 'observed');
    // Cleanup still destroys the owned Box and proves it absent.
    const cleanup = await executeCleanupRun({ run: w.run, hostIdentity: w.hostIdentity, processProvider: w.engineProvider, persist: w.persist, remoteArrival: w.remote });
    assert.equal(cleanup.verdict, 'PASS', JSON.stringify(cleanup.limitations)); assert.equal(exists(w.run.target.execution.workspace.path), false);
});

test('R21.the-box-contract-observation-is-planned-shown-and-uses-parser-clean-read-only-argv', async t => {
    const w = world(t, { block: 'apparatus-cpu' });
    const step = w.run.target.plan.provision.find(entry => entry.id === 'box-contract');
    assert.deepEqual(step.argv.slice(0, 3), ['container', 'inspect', '--format']); assert.equal(step.argv[3], BOX_CONTRACT_INSPECT); assert.equal(step.argv.at(-1), '<BOX_ID>');
    const ids = w.run.target.plan.provision.map(entry => entry.id);
    assert.ok(ids.indexOf('box-inspect') < ids.indexOf('box-contract') && ids.indexOf('box-contract') < ids.findIndex(id => id.startsWith('agent-inspect')), ids.join(','));
    const summary = renderSummary(w.run, w.runPath);
    assert.ok(summary.includes('box-contract') && summary.includes('<BOX_CONTRACT_FORMAT>') && !summary.includes('HostConfig.Privileged'), 'the long template is named, never printed');
});
