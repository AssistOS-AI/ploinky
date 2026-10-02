// Offline tests of the live-runner foundation: provisioning, remote staging,
// crash-resumable cleanup and concrete manifests. Every engine, candidate and
// SSH host is a file-backed fake (tests/hardware-limits/fakeLiveEngine.mjs);
// nothing here starts a container, opens SSH or uses a GPU or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { writePrivateJson } from '../hardware-limits/fixtures.mjs';
import { executeCleanupRun, jsonDigest, liveSourceDigest, runLiveCommand, validateExecutionProfile, validateProfile } from '../hardware-limits/liveHarness.mjs';
import { FIXTURE_HARDWARE_LIMITS, FIXTURE_REPOSITORY, fixtureContainerName, fixtureManifest, fixturePlan, provisionRun, validateProvisionPlan } from '../hardware-limits/liveFixture.mjs';
import { admitManifestRuntimeCapabilities, validateManifestRuntimeCapabilities } from '../../cli/sandbox/runtimeCapabilities.js';
import { deprecatedHardwareDeclarations } from '../../cli/sandbox/hardwareLimits/declaredLimits.mjs';
import { buildConcreteManifest, summaryPathFor } from '../hardware-limits/liveManifest.mjs';
import { ARTIFACT_LIMITS, requiredArtifacts, stageAndDispatch, writeUstar } from '../hardware-limits/liveStage.mjs';
import { AGENT_INSPECT, ENGINE_INFO_ARGV, INSPECT, MAX_TAIL_BYTES, NESTED_CONTAINER_INSPECT, NESTED_LIST_FORMAT, PS_IDENTITY_FORMAT, boxPsArgv, engineIdentityDigest, engineIdentityFacts, hostRecordPaths, observeEngineIdentity, quarantinePath, workspaceSocketProblem } from '../hardware-limits/liveCommon.mjs';
import { CRASH_EXIT, FAKE_CONNECTIONS, createFakeSsh, createFakeWorld, evaluateTemplate, fakeEngineInfo, ok, unsupportedFormat, worldState } from '../hardware-limits/fakeLiveEngine.mjs';

const hash = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const REPO = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const CHILD = path.join(REPO, 'tests', 'hardware-limits', 'fakeLiveChild.mjs');
const ENGINE_HOST = { arch: 'test', os: 'linux', hostname: 'fake-engine', id: 'engine-1' };
const IMAGE = `docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}`;
const BOX_IMAGE = `docker.io/assistos/ploinky-box@sha256:${'b'.repeat(64)}`;
const UNRELATED = [{ id: 'e'.repeat(64), created: '2026-09-01T00:00:00Z', image: 'f'.repeat(64), labels: {}, mounts: [{ Source: '/elsewhere' }] }];
const free = async () => ({ tcp: true, udp: true });
const exists = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
// A live workspace must leave room for the CLI's Unix sockets, so the
// workspace parent root is a short task-owned directory: the temporary
// directory when it is short enough, else /tmp. It is removed afterwards.
function shortParent(t) {
    const base = [os.tmpdir(), '/tmp'].map(value => fs.realpathSync(value)).find(value => Buffer.byteLength(value) <= 24);
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(base, 'hwl-')));
    t.after(() => {
        const open = target => { const stat = fs.lstatSync(target); if (!stat.isDirectory()) return; fs.chmodSync(target, 0o700); for (const name of fs.readdirSync(target)) open(path.join(target, name)); };
        if (exists(parent)) { open(parent); fs.rmSync(parent, { recursive: true, force: true }); }
    });
    return parent;
}

function scratch(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-l1-')));
    t.after(() => {
        const open = target => { const stat = fs.lstatSync(target); if (!stat.isDirectory()) return; fs.chmodSync(target, 0o700); for (const name of fs.readdirSync(target)) open(path.join(target, name)); };
        if (exists(root)) { open(root); fs.rmSync(root, { recursive: true, force: true }); }
    });
    return root;
}

// One fake world: a candidate source, a fake engine binary, a host home, an
// evidence directory and a concrete manifest built by the real builder.
function world(t, { block = 'mac-cpu', platform = null, stagedRoot = true, faults = {}, suffix = 'claude' } = {}) {
    const root = scratch(t);
    const remote = block === 'apparatus-cpu';
    const directory = name => { const target = path.join(root, name); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); return target; };
    const home = directory('home');
    const source = directory('source');
    fs.mkdirSync(path.join(source, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// fixture candidate\n');
    fs.mkdirSync(path.join(source, 'tests', 'hardware-limits'), { recursive: true });
    fs.writeFileSync(path.join(source, 'tests', 'hardware-limits', 'verify.mjs'), '// fixture runner\n');
    const bin = directory('bin');
    const engine = path.join(bin, 'podman'); fs.writeFileSync(engine, 'fake engine\n');
    const ssh = path.join(bin, 'ssh'); fs.writeFileSync(ssh, 'fake ssh\n');
    const knownHosts = path.join(root, 'known_hosts'); fs.writeFileSync(knownHosts, '192.168.1.63 ssh-ed25519 AAAAfixture\n');
    const evidence = directory('evidence');
    const parentRoot = shortParent(t);
    const node = fs.realpathSync(process.execPath);
    const hostIdentity = remote ? { hostname: 'apparatus', platform: 'linux', home } : { hostname: os.hostname(), platform: platform || process.platform, home };
    const pins = {
        schema: 1, host: hostIdentity, node: { path: node, digest: hash(fs.readFileSync(node)) },
        engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: engineIdentityDigest(fakeEngineInfo(ENGINE_HOST)) }, boxImage: BOX_IMAGE,
        ...(remote ? { ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '100.76.22.69', hostKeyAlias: '192.168.1.63', user: 'skutner', knownHosts, identityFile: null } } : { workspaceParentRoot: parentRoot }),
    };
    const runId = crypto.randomBytes(16).toString('hex');
    const candidate = { root: source, digest: liveSourceDigest(source), revision: 'c'.repeat(40) };
    if (remote) {
        const payloadPath = path.join(evidence, `candidate-${runId}.tar`);
        candidate.payload = { path: payloadPath, ...writeUstar(source, payloadPath) };
    }
    const run = buildConcreteManifest({
        block, runId, configDigest: hash('config'), casesDigest: hash('cases'), documentSuffix: suffix, pins, candidate, image: IMAGE,
        ports: { tcp: 23456, udp: 34567 }, unsupported: {},
    });
    const remoteRoot = remote ? run.target.stage.root : null;
    if (remote && stagedRoot) {
        fs.mkdirSync(remoteRoot, { recursive: true }); fs.chmodSync(remoteRoot, 0o700);
        fs.writeFileSync(path.join(remoteRoot, '.ploinky-hwl-owner'), runId, { mode: 0o600 });
        fs.cpSync(source, path.join(remoteRoot, 'source'), { recursive: true });
    }
    const runPath = path.join(evidence, `run_${suffix}.json`);
    writePrivateJson(runPath, run);
    const statePath = path.join(root, 'world_claude.json');
    const engineProvider = createFakeWorld({ statePath, node, engine, host: ENGINE_HOST, unrelated: UNRELATED, faults });
    const contextPath = path.join(root, 'context_claude.json');
    fs.writeFileSync(contextPath, JSON.stringify({ node, engine, host: ENGINE_HOST, hostIdentity, remoteArrival: remote }));
    const persist = () => writePrivateJson(runPath, run);
    return { root, home, source, engine, ssh, knownHosts, evidence, node, pins, run, runId, runPath, statePath, engineProvider, contextPath, hostIdentity, remote, remoteRoot, persist };
}

const provision = (w, options = {}) => provisionRun({
    run: w.run, persist: w.persist, processProvider: w.engineProvider, portProbe: options.portProbe || free,
    hostIdentity: w.hostIdentity, remoteArrival: w.remote, validateProfile,
});
const reload = w => { w.run = JSON.parse(fs.readFileSync(w.runPath, 'utf8')); return w.run; };
const cleanup = w => executeCleanupRun({ run: w.run, persist: w.persist, processProvider: w.engineProvider, hostIdentity: w.hostIdentity, remoteArrival: w.remote });
function child(w, mode, crash = '') {
    const result = spawnSync(process.execPath, [CHILD, mode, w.runPath, w.statePath, w.contextPath, crash], {
        cwd: REPO, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: w.home, TMPDIR: process.env.TMPDIR },
    });
    return { status: result.status, report: result.status === 0 ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}
// Nothing owned remains: Box, workspace, quarantine, parent or host record.
function assertNothingOwned(w) {
    const state = worldState(w.statePath);
    assert.deepEqual(Object.keys(state.boxes), []);
    const plan = w.run.target.execution.provision;
    for (const target of [plan.workspace.path, quarantinePath(plan.workspace.path, w.runId), ...(plan.workspace.parentMode === 'create' ? [plan.workspace.parent] : []),
        ...hostRecordPaths(w.home, w.run.workspace.instance)]) assert.equal(exists(target), false, target);
}

test('L1.provision-mac-c1-c2-success', async t => {
    const w = world(t);
    const writes = [];
    const persist = () => { writes.push(JSON.parse(JSON.stringify(w.run))); w.persist(); };
    const report = await provisionRun({ run: w.run, persist, processProvider: w.engineProvider, portProbe: free, hostIdentity: w.hostIdentity, validateProfile });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    const profile = validateExecutionProfile(w.run);
    const plan = profile.provision;
    assert.equal(profile.workspace.path, plan.workspace.path); assert.equal(profile.workspace.marker, w.runId);
    assert.equal(fs.readFileSync(path.join(plan.workspace.path, '.ploinky-hwl-owner'), 'utf8'), w.runId);
    assert.deepEqual(profile.agents.map(agent => agent.role).sort(), ['cpu', 'memory', 'pids']);
    assert.equal(w.run.ownedBoxes.length, 1); assert.equal(w.run.ownedBoxes[0].id, profile.box.id);
    assert.ok(w.run.operations.some(op => op.id === 'fixture-created' && op.resourceIds.includes(profile.box.id)));
    assert.deepEqual(w.run.preInventory.containers, [{ id: UNRELATED[0].id, created: UNRELATED[0].created, image: UNRELATED[0].image }]);
    // The fixture agents exist only inside the new workspace, pinned and limited.
    for (const agent of plan.agents) {
        const manifest = JSON.parse(fs.readFileSync(path.join(plan.workspace.path, '.ploinky', 'repos', FIXTURE_REPOSITORY, agent.name, 'manifest.json'), 'utf8'));
        assert.equal(manifest.container, IMAGE); assert.deepEqual(manifest.readiness, { protocol: 'none' });
        assert.deepEqual(manifest.hardwareLimits, { memory: '64m', cpus: '0.5', pidsLimit: 64 });
        assert.equal(Object.hasOwn(manifest, 'llmRuntime'), false, 'the fixture never declares the deprecated path');
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plan.workspace.path, '.ploinky', 'repos', FIXTURE_REPOSITORY, 'memory', 'manifest.json'))).enable, ['hwlfixture/cpu', 'hwlfixture/pids']);
    // The exact start argv, gate on, pinned Box image, from the workspace.
    const start = worldState(w.statePath).calls.find(call => call.kind === 'start');
    assert.deepEqual(start.args, [profile.candidate.path, '--port', '23456', '--udp-port', '34567', 'start', 'hwlfixture/memory']);
    assert.equal(start.binary, w.node); assert.equal(start.cwd, plan.workspace.path); assert.equal(start.gate, 'on'); assert.equal(start.boxImage, BOX_IMAGE);
    assert.ok(start.path.startsWith(`${path.dirname(w.engine)}:`));
    // Host records the start created are recorded exactly.
    assert.deepEqual(w.run.ownedPaths.filter(entry => entry.role === 'host-record').map(entry => entry.path).sort(),
        hostRecordPaths(w.home, profile.box.instance).filter(target => exists(target)).sort());
    // Every receipt was persisted before later work depended on it.
    const index = predicate => writes.findIndex(predicate);
    const receipt = index(run => run.target.execution.workspace !== null);
    const ports = index(run => run.operations.some(op => op.kind === 'port-preflight'));
    const startIntent = index(run => run.operations.some(op => op.kind === 'fixture-start'));
    const boxReceipt = index(run => run.ownedBoxes.length === 1);
    assert.ok(receipt >= 0 && receipt < ports && ports < startIntent && startIntent < boxReceipt, JSON.stringify({ receipt, ports, startIntent, boxReceipt }));
    assert.equal(index(run => run.operations.some(op => op.kind === 'workspace-parent-create' && op.state === 'intent')) < index(run => run.ownedPaths.some(entry => entry.role === 'workspace-parent')), true);
    // The provisioned run cleans up to nothing.
    const cleaned = await cleanup(w);
    assert.equal(cleaned.verdict, 'PASS', JSON.stringify(w.run.cleanup)); assertNothingOwned(w);
    assert.equal(worldState(w.statePath).destroyCalls, 1);
});

test('L1.provision-fixture-start-keeps-bounded-redacted-output-tails', async t => {
    const w = world(t);
    const artifacts = new Map();
    const noisy = `${'y'.repeat(30000)}\nPLOINKY_MASTER_KEY=hunter2hunter2\n[start] Router: http://127.0.0.1:23456\n`;
    const processProvider = async (binary, args, options) => {
        const result = await w.engineProvider(binary, args, options);
        return binary === w.node && args.includes('start') ? { ...result, stdout: noisy, stderr: 'Authorization: Bearer abcdefghijklmnop\n' } : result;
    };
    const report = await provisionRun({ run: w.run, persist: w.persist, processProvider, portProbe: free, hostIdentity: w.hostIdentity, validateProfile, artifacts: (name, value) => artifacts.set(name, structuredClone(value)) });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    const tails = artifacts.get('fixture-start');
    assert.equal(tails.status, 0); assert.equal(tails.kind, 'fixture-start');
    assert.ok(Buffer.byteLength(tails.stdoutTail) <= MAX_TAIL_BYTES); assert.ok(tails.stdoutDroppedBytes > 0);
    assert.match(tails.stdoutTail, /\[start\] Router: http:\/\/127\.0\.0\.1:23456/);
    assert.match(tails.stdoutTail, /PLOINKY_MASTER_KEY=\[redacted\]/); assert.match(tails.stderrTail, /Bearer \[redacted\]/);
    for (const secret of ['hunter2', 'abcdefghijklmnop']) assert.equal(JSON.stringify(tails).includes(secret) || JSON.stringify(w.run).includes(secret), false, secret);
    const op = w.run.operations.find(value => value.kind === 'fixture-start');
    assert.equal(op.artifact, 'fixture-start'); assert.equal(Object.hasOwn(op, 'stdout'), false);
    await cleanup(w); assertNothingOwned(w);
});

test('L1.provision-failed-fixture-start-still-leaves-its-tails', async t => {
    const w = world(t, { faults: { start: { status: 7 } } });
    const artifacts = new Map();
    const report = await provisionRun({ run: w.run, persist: w.persist, processProvider: w.engineProvider, portProbe: free, hostIdentity: w.hostIdentity, validateProfile, artifacts: (name, value) => artifacts.set(name, structuredClone(value)) });
    assert.equal(report.verdict, 'FAIL'); assert.match(report.limitations[0], /Live command failed/);
    const tails = artifacts.get('fixture-start');
    assert.equal(tails.status, 7); assert.match(tails.stderrTail, /start failed/);
});

test('L1.provision-apparatus-a1-staged-success', async t => {
    const w = world(t, { block: 'apparatus-cpu' });
    const report = await provision(w);
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    const profile = validateExecutionProfile(w.run);
    assert.equal(profile.provision.workspace.parentMode, 'staged');
    assert.equal(profile.workspace.path, path.join(w.remoteRoot, 'workspace'));
    assert.deepEqual(profile.agents.map(agent => agent.role), ['memory']);
    assert.ok(!w.run.ownedPaths.some(entry => entry.role === 'workspace-parent'));
    // Without a remote arrival an SSH target never runs locally.
    const local = world(t, { block: 'apparatus-cpu' });
    const refused = await provisionRun({ run: local.run, persist: local.persist, processProvider: local.engineProvider, portProbe: free, hostIdentity: local.hostIdentity, validateProfile });
    assert.equal(refused.verdict, 'BLOCKED'); assert.equal(exists(local.statePath), false);
    assert.equal((await cleanup(w)).verdict, 'PASS'); assertNothingOwned(w);
    assert.equal(exists(w.remoteRoot), true, 'the staged root is removed only by the staging owner');
});

test('L1.provision-failure-boundaries-clean-up', async t => {
    const failures = [
        ['engine identity', { info: { host: { ...ENGINE_HOST, id: 'other' } } }, 'BLOCKED'],
        ['pre-inventory', { ps: { at: 1, result: { ...ok(''), status: 125 } } }, 'FAIL'],
        ['start exits nonzero', { start: { status: 1 } }, 'FAIL'],
        ['start creates no Box', { start: { noBox: true } }, 'FAIL'],
        ['Box inventory fails', { ps: { at: 2, result: { ...ok(''), status: 125 } } }, 'FAIL'],
        ['agent image differs', { 'agent-inspect': { patch: { imageName: 'docker.io/other/image:latest' } } }, 'FAIL'],
        ['agent missing', { 'agent-inspect': { at: 2, result: { ...ok(''), status: 125 } } }, 'FAIL'],
    ];
    for (const [label, faults, verdict] of failures) {
        const w = world(t, { faults });
        const report = await provision(w);
        assert.equal(report.verdict, verdict, `${label}: ${JSON.stringify(report.limitations)} ${JSON.stringify(w.run.cleanup)}`);
        assert.equal(w.run.cleanup.state, 'complete', `${label}: ${JSON.stringify(w.run.cleanup.failures)}`);
        assert.equal(reload(w).state, 'complete', label);
        assertNothingOwned(w);
        const state = worldState(w.statePath);
        assert.equal(state.destroyCalls, state.startCalls && !faults.start?.noBox ? 1 : 0, label);
    }
});

// The fake evaluates `--format` like Podman: Go struct field names only. Real
// Podman 5.7 and 6.0 reject `{{json .Id}}` (exit 125); the harness once did
// exactly that and the lenient fake hid it.
test('L1.fake-engine-templates-are-strict', async t => {
    const podmanShape = /^Error: template: inspect:1:\d+: executing "inspect" at <\.Id>: can't evaluate field Id in type interface \{\}$/;
    const model = { ID: 'x'.repeat(64), Config: { Labels: { a: 'b' } }, State: { Running: true } };
    const rejected = evaluateTemplate('{"id":{{json .Id}}}', 'inspect', model);
    assert.equal(typeof rejected, 'object'); assert.equal(rejected.status, 125); assert.match(rejected.stderr, podmanShape);
    assert.equal(evaluateTemplate('{"id":{{json .ID}}}', 'inspect', model), `{"id":"${'x'.repeat(64)}"}`);
    assert.equal(evaluateTemplate('{{.ID}}', 'inspect', model), 'x'.repeat(64));
    assert.equal(evaluateTemplate('{{json .Config.Labels}}', 'inspect', model), '{"a":"b"}');
    // Nested fields, JSON key spellings and unknown fields are refused too.
    for (const template of ['{{json .Config.Bogus}}', '{{json .State.running}}', '{{json .state}}', '{{json .HostConfig.Memory.Deep}}', '{{.id}}']) {
        const result = evaluateTemplate(template, 'inspect', model);
        assert.equal(result.status, 125, template); assert.match(result.stderr, /can't evaluate field \w+ in type interface \{\}/, template);
    }
    assert.equal(evaluateTemplate('{{json .}}', 'inspect', model).status, 125);
    assert.equal(evaluateTemplate('{{bogus .ID}}', 'inspect', model).status, 125);
    assert.equal(evaluateTemplate('{{.Id}} {{.Names}}', 'ps', {}).status, 125);
    assert.equal(evaluateTemplate('{{.Host}}', 'info', {}).status, 125);
    assert.equal(evaluateTemplate('{{json .}}', 'info', { host: 1 }), '{"host":1}');
    // Every template the harness really sends is supported, argv by argv.
    for (const args of [['container', 'inspect', '--format', INSPECT, 'id'], ['container', 'exec', 'box', 'podman', 'container', 'inspect', '--format', AGENT_INSPECT, 'name'],
        [...boxPsArgv('0'.repeat(12))], ['container', 'ps', '--all', '--no-trunc', '--format', '{{.ID}}'], [...ENGINE_INFO_ARGV],
        // The evidence-only nested listing and per-container inspect.
        ['container', 'exec', 'box', 'podman', '--cgroup-manager=cgroupfs', 'container', 'ps', '--all', '--no-trunc', '--format', NESTED_LIST_FORMAT],
        ['container', 'exec', 'box', 'podman', '--cgroup-manager=cgroupfs', 'container', 'inspect', '--format', NESTED_CONTAINER_INSPECT, 'id']]) assert.equal(unsupportedFormat(args), null, args.join(' '));
    // The new State fields are addressed by Go name; JSON-key spellings and fields the fake does not know are refused.
    for (const spelled of ['.State.OOMKilled>.State.oomKilled', '.State.ExitCode>.State.exitCode', '.State.Status>.State.status', '.State.FinishedAt>.State.Dead']) {
        const [from, to] = spelled.split('>');
        assert.equal(unsupportedFormat(['container', 'inspect', '--format', NESTED_CONTAINER_INSPECT.replace(from, to), 'id']).status, 125, spelled);
    }
    assert.equal(unsupportedFormat(['container', 'inspect', '--format', INSPECT.replace('.ID', '.Id'), 'id']).status, 125);
    // The same strictness holds through the file-backed engine of the world.
    const w = await provisioned(t);
    const [box] = Object.values(worldState(w.statePath).boxes);
    const run = (...args) => w.engineProvider(w.engine, args, { cwd: w.home, env: { HOME: w.home } });
    const bad = await run('container', 'inspect', '--format', '{"id":{{json .Id}}}', box.id);
    assert.equal(bad.status, 125); assert.match(bad.stderr, podmanShape); assert.equal(bad.stdout, '');
    assert.equal(JSON.parse((await run('container', 'inspect', '--format', INSPECT, box.id)).stdout).id, box.id);
    const row = (await run(...boxPsArgv(buildWorkspaceIdentity(w.run.target.execution.workspace.path).pathHash))).stdout;
    assert.equal(row, `${box.id} ${box.name}\n`); assert.equal(PS_IDENTITY_FORMAT, '{{.ID}} {{.Names}}');
    assert.equal((await run('container', 'ps', '--all', '--no-trunc', '--filter', `label=${BOX_LABELS.pathHash}=${'0'.repeat(12)}`, '--format', '{{.ID}}')).stdout, '');
    assert.equal((await run('container', 'ps', '--all', '--format', '{{.Id}}')).status, 125);
    assert.equal((await run('container', 'ps', '--all', '--filter', 'bogus=1', '--format', '{{.ID}}')).status, 125);
    // The nested engine answers the evidence listing through the same strict templates.
    const nestedArgs = ['container', 'exec', '--user', 'podman', box.id, 'podman', '--cgroup-manager=cgroupfs'];
    const listed = (await run(...nestedArgs, 'container', 'ps', '--all', '--no-trunc', '--format', NESTED_LIST_FORMAT)).stdout.trim().split(/\s+/);
    assert.equal(listed.length, 3);
    const one = JSON.parse((await run(...nestedArgs, 'container', 'inspect', '--format', NESTED_CONTAINER_INSPECT, listed[0])).stdout);
    assert.deepEqual([one.id, one.status, one.running, one.exitCode, one.oomKilled], [listed[0], 'running', true, 0, false]);
    assert.equal((await run(...nestedArgs, 'container', 'inspect', '--format', NESTED_CONTAINER_INSPECT.replace('.State.OOMKilled', '.State.oomKilled'), listed[0])).status, 125);
    const missing = await run(...nestedArgs, 'container', 'inspect', '--format', NESTED_CONTAINER_INSPECT, '9'.repeat(64));
    assert.equal(missing.status, 125); assert.match(missing.stderr, /no such container/);
});

// Provision creates the Box, then the post-create inspect fails (as `.Id` did
// on a real engine). The Box was never receipted, but its deterministic
// identity was recorded on the fixture-start intent before the process ran,
// so cleanup still finds and destroys exactly it.
const INSPECT_FAILS = { ...ok(''), status: 125, stderr: 'Error: template: inspect:1:7: executing "inspect" at <.Id>: can\'t evaluate field Id in type interface {}' };
// Provision with a failing post-create inspect; `tamper(box)` alters the
// Box right after production creates it.
async function provisionWithBrokenInspect(t, tamper = () => {}) {
    const w = world(t, { faults: { inspect: { at: 2, result: INSPECT_FAILS } } });
    const writes = [];
    const processProvider = async (binary, args, options) => {
        const result = await w.engineProvider(binary, args, options);
        if (binary === w.node && args.includes('start')) {
            const state = worldState(w.statePath);
            for (const box of Object.values(state.boxes)) tamper(box);
            fs.writeFileSync(w.statePath, JSON.stringify(state));
        }
        return result;
    };
    const persist = () => {
        const op = w.run.operations.find(value => value.kind === 'fixture-start');
        writes.push({ box: op?.box ?? null, state: op?.state ?? null, startCalls: fs.existsSync(w.statePath) ? worldState(w.statePath).startCalls : 0 });
        w.persist();
    };
    const report = await provisionRun({ run: w.run, persist, processProvider, portProbe: free, hostIdentity: w.hostIdentity, validateProfile });
    return { w, writes, report };
}

test('L1.provision-box-inspect-failure-still-records-and-cleans-the-box', async t => {
    const { w, writes, report } = await provisionWithBrokenInspect(t);
    const identity = { instance: w.run.workspace.instance, pathHash: w.run.workspace.pathHash };
    assert.equal(report.verdict, 'FAIL'); assert.match(report.limitations[0], /Live command failed/);
    // No Box receipt, but the identity is on the fixture-start intent, durable before the process could run.
    assert.deepEqual(w.run.ownedBoxes, []);
    assert.deepEqual(w.run.operations.find(op => op.kind === 'fixture-start').box, { name: identity.instance, pathHash: identity.pathHash });
    const first = writes.find(entry => entry.box);
    assert.equal(first.state, 'intent'); assert.equal(first.startCalls, 0, 'recorded before start ran');
    // Cleanup found it by the recorded identity (name and label) and destroyed it with the candidate.
    assert.equal(w.run.cleanup.state, 'complete', JSON.stringify(w.run.cleanup.failures));
    const state = worldState(w.statePath);
    const query = state.calls.find(call => call.kind === 'ps-filter');
    assert.deepEqual(query.args, boxPsArgv(identity.pathHash));
    assert.equal(state.destroyCalls, 1); assert.equal(state.calls.find(call => call.kind === 'destroy').args.slice(-2).join(' '), 'destroy --delete-cache');
    assertNothingOwned(w);
});

test('L1.cleanup-refuses-a-box-that-does-not-match-the-recorded-identity', async t => {
    const cases = [
        ['label differs', box => { box.labels[BOX_LABELS.pathHash] = 'f'.repeat(12); }, /Workspace remains mounted/],
        ['name differs', box => { box.name = 'someone-elses-box'; }, /has another name; preserving everything/],
        ['role label differs', box => { box.labels[BOX_LABELS.role] = 'agent'; }, /is not a Box of this workspace/],
        ['workspace is not mounted', box => { box.mounts = [{ Source: '/elsewhere', Destination: '/elsewhere' }]; }, /does not mount the owned workspace/],
    ];
    for (const [label, tamper, message] of cases) {
        const { w, report } = await provisionWithBrokenInspect(t, tamper);
        assert.equal(report.verdict, 'FAIL', label);
        assert.equal(w.run.cleanup.state, 'failed', `${label}: ${JSON.stringify(w.run.cleanup)}`);
        assert.match(w.run.cleanup.failures[0], message, label);
        const state = worldState(w.statePath);
        assert.equal(Object.keys(state.boxes).length, 1, `${label}: the Box is preserved`); assert.equal(state.destroyCalls, 0, label);
        assert.equal(exists(w.run.target.execution.provision.workspace.path), true, `${label}: the workspace is preserved`);
    }
    // A manifest whose recorded identity names another workspace is refused before any query.
    const { w } = await provisionWithBrokenInspect(t, box => { box.name = 'x'; });
    const op = w.run.operations.find(value => value.kind === 'fixture-start');
    op.box = { name: 'ploinky-box-other-000000000000', pathHash: '0'.repeat(12) };
    w.run.cleanup = { state: 'not-started', steps: [], failures: [] };
    const report = await cleanup(w);
    assert.equal(report.verdict, 'FAIL'); assert.match(w.run.cleanup.failures[0], /recorded fixture-start Box identity is not this workspace/);
    assert.equal(worldState(w.statePath).destroyCalls, 0);
});

test('L1.provision-port-collision-aborts', async t => {
    for (const ports of [{ tcp: false, udp: true }, { tcp: true, udp: false }]) {
        const w = world(t);
        const report = await provision(w, { portProbe: async () => ports });
        assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations[0], /port collision/);
        assert.ok(!worldState(w.statePath).calls.some(call => call.kind === 'start'));
        assert.equal(w.run.cleanup.state, 'complete'); assertNothingOwned(w);
    }
});

test('L1.provision-refuses-preexisting-workspace', async t => {
    // mac: the task parent already exists with foreign content.
    const w = world(t);
    const parent = w.run.target.execution.provision.workspace.parent;
    fs.mkdirSync(parent); fs.writeFileSync(path.join(parent, 'foreign.txt'), 'keep');
    const report = await provision(w);
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations[0], /Refusing pre-existing path/);
    assert.equal(fs.readFileSync(path.join(parent, 'foreign.txt'), 'utf8'), 'keep');
    assert.ok(!worldState(w.statePath).calls.some(call => call.kind === 'start'));
    // apparatus: the workspace already exists inside the staged root.
    const a = world(t, { block: 'apparatus-cpu' });
    const workspace = a.run.target.execution.provision.workspace.path;
    fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'foreign.txt'), 'keep');
    const second = await provision(a);
    assert.equal(second.verdict, 'BLOCKED');
    assert.equal(fs.readFileSync(path.join(workspace, 'foreign.txt'), 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(workspace), ['foreign.txt']);
});

test('L1.provision-refuses-existing-host-record', async t => {
    const w = world(t);
    const record = hostRecordPaths(w.home, w.run.workspace.instance)[2];
    fs.mkdirSync(path.dirname(record), { recursive: true }); fs.writeFileSync(record, '{"foreign":true}');
    const report = await provision(w);
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations[0], /not task-owned/);
    assert.equal(fs.readFileSync(record, 'utf8'), '{"foreign":true}');
    assert.equal(exists(w.run.target.execution.provision.workspace.parent), false);
    assert.deepEqual(worldState(w.statePath).calls.map(call => call.kind), ['info']);
});

test('L1.provision-requires-separate-authorization', async t => {
    const w = world(t);
    const authorizationPath = path.join(w.evidence, 'authorization_claude.json');
    const bind = action => writePrivateJson(authorizationPath, { schema: 1, runId: w.runId, manifestDigest: hash(fs.readFileSync(w.runPath)), targetDigest: jsonDigest(w.run.target), action });
    await assert.rejects(runLiveCommand({ runPath: w.runPath, action: 'provision', processProvider: w.engineProvider }), /APPROVAL REQUIRED/);
    bind('live');
    await assert.rejects(runLiveCommand({ runPath: w.runPath, authorizationPath, action: 'provision', processProvider: w.engineProvider }), /authorization binding/);
    assert.equal(exists(w.statePath), false);
    bind('provision');
    const report = await runLiveCommand({ runPath: w.runPath, authorizationPath, action: 'provision', processProvider: w.engineProvider, portProbe: free, hostIdentity: w.hostIdentity });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.evidence, 'report_provision.json'))).verdict, 'PASS');
    // The provisioned manifest needs a new binding for live: the old one no longer matches.
    await assert.rejects(runLiveCommand({ runPath: w.runPath, authorizationPath, action: 'provision', processProvider: w.engineProvider }), /authorization binding/);
    reload(w); assert.equal((await cleanup(w)).verdict, 'PASS');
});

// --- Remote staging -------------------------------------------------------

function stagedWorld(t, sshFaults = {}, { suffix = 'claude' } = {}) {
    const w = world(t, { block: 'apparatus-cpu', stagedRoot: false, suffix });
    const remoteRun = w.run.target.remote.runPath;
    const dispatch = async (words) => {
        const option = name => words[words.indexOf(name) + 1];
        const previous = process.env.SSH_CONNECTION;
        process.env.SSH_CONNECTION = '10.0.0.2 50000 100.76.22.69 22';
        try {
            const report = await runLiveCommand({ runPath: option('--run'), authorizationPath: option('--authorization'), action: words[2], processProvider: w.engineProvider,
                remoteLocal: option('--remote-local'), expectedManifestDigest: option('--expected-manifest-digest'), portProbe: free, hostIdentity: w.hostIdentity });
            return ok(`${JSON.stringify(report, null, 2)}\n`, { status: report.exitCode });
        } finally { if (previous === undefined) delete process.env.SSH_CONNECTION; else process.env.SSH_CONNECTION = previous; }
    };
    const ssh = createFakeSsh({ sshBinary: w.ssh, address: '100.76.22.69', hostname: 'apparatus', faults: sshFaults, dispatch });
    const authorize = action => {
        const file = path.join(w.evidence, `authorization_${action}_${suffix}.json`);
        writePrivateJson(file, { schema: 1, runId: w.runId, manifestDigest: hash(fs.readFileSync(w.runPath)), targetDigest: jsonDigest(reload(w).target), action });
        return file;
    };
    const act = action => runLiveCommand({ runPath: w.runPath, authorizationPath: authorize(action), action, processProvider: ssh.provider });
    return { ...w, ssh, act, remoteRun };
}

test('L1.stage-roundtrip-provision-and-cleanup', async t => {
    const w = stagedWorld(t);
    const report = await w.act('provision');
    assert.equal(report.verdict, 'PASS', JSON.stringify(report));
    // The local manifest is now the fetched remote one, byte for byte.
    assert.equal(hash(fs.readFileSync(w.runPath)), hash(fs.readFileSync(w.remoteRun)));
    const run = reload(w);
    assert.equal(run.state, 'running'); assert.ok(run.target.execution.box);
    assert.equal(report.staging.removed, false); assert.equal(exists(w.remoteRoot), true);
    assert.equal(liveSourceDigest(path.join(w.remoteRoot, 'source')), run.target.execution.source.digest);
    assert.equal(fs.statSync(w.remoteRoot).mode & 0o777, 0o700);
    // Every remote call went through the pinned options and the fixed words.
    for (const call of w.ssh.calls) {
        for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'HostKeyAlias=192.168.1.63', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'ForwardX11=no']) assert.ok(call.args.includes(option), option);
        assert.ok(call.args.includes('/dev/null')); assert.equal(call.args[call.args.indexOf('-l') + 1], 'skutner');
    }
    const dispatch = w.ssh.calls.find(call => call.words[1]?.endsWith('/verify.mjs'));
    assert.deepEqual(dispatch.words.slice(2, 5), ['provision', '--run', w.remoteRun]);
    assert.ok(fs.existsSync(path.join(w.evidence, 'report_provision_remote_claude.json')));
    // Cleanup over a fresh binding: remote cleanup PASS, then the owned root goes.
    const cleaned = await w.act('cleanup');
    assert.equal(cleaned.verdict, 'PASS', JSON.stringify(cleaned));
    assert.equal(cleaned.staging.removed, true); assert.equal(exists(w.remoteRoot), false);
    assert.equal(reload(w).state, 'complete');
    assert.deepEqual(Object.keys(worldState(w.statePath).boxes), []);
});

test('L1.stage-payload-digest-mismatch-refuses', async t => {
    const w = stagedWorld(t, { sha256sum: { at: 1, wrong: true } });
    const report = await w.act('provision');
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations.join(' '), /payload digest mismatch/);
    assert.ok(!w.ssh.calls.some(call => ['tar'].includes(call.words[0]) || call.words[1]?.endsWith('/verify.mjs')));
    assert.equal(exists(w.remoteRoot), true, 'staging is preserved for an owned cleanup');
    const journal = JSON.parse(fs.readFileSync(path.join(w.evidence, `staging_${w.runId}_claude.json`)));
    assert.equal(journal.staged, false); assert.deepEqual(journal.dispatches, []);
    // With nothing dispatched, cleanup proves and removes only the owned root.
    const cleaned = await w.act('cleanup');
    assert.equal(cleaned.verdict, 'PASS'); assert.equal(exists(w.remoteRoot), false);
});

test('L1.stage-forced-settlement-preserves', async t => {
    const w = stagedWorld(t, { dd: { at: 2, result: { ...ok(''), settlementForced: true } } });
    const report = await w.act('provision');
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations.join(' '), /transport incomplete/);
    assert.equal(w.ssh.calls.at(-1).words[0], 'dd');
    assert.equal(exists(w.remoteRoot), true);
    assert.equal(fs.readFileSync(path.join(w.remoteRoot, '.ploinky-hwl-owner'), 'utf8'), w.runId);
});

test('L1.stage-wrong-host-identity-refuses', async t => {
    const w = stagedWorld(t, { uname: { hostname: 'some-other-host' } });
    const report = await w.act('provision');
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations.join(' '), /Remote host identity mismatch/);
    assert.deepEqual(w.ssh.calls.map(call => call.words[0]), ['uname']);
    assert.equal(exists(w.remoteRoot), false);
    // A changed local known-hosts pin refuses before any SSH process.
    const pinned = stagedWorld(t);
    fs.appendFileSync(pinned.knownHosts, '10.0.0.9 ssh-ed25519 AAAAother\n');
    const refused = await pinned.act('provision');
    assert.equal(refused.verdict, 'BLOCKED'); assert.match(refused.limitations.join(' '), /known-hosts pin changed/);
    assert.equal(pinned.ssh.calls.length, 0);
});

test('L1.stage-fetched-manifest-digest-mismatch-refuses', async t => {
    const w = stagedWorld(t, { cat: { tamper: (text, target) => (target.endsWith('/run/run_claude.json') ? text.replace('"running"', '"complete"') : text) } });
    const before = fs.readFileSync(w.runPath);
    const report = await w.act('provision');
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations.join(' '), /Fetched remote manifest digest mismatch/);
    assert.deepEqual(fs.readFileSync(w.runPath), before);
});

// --- Crash-resumable cleanup ---------------------------------------------

async function provisioned(t, options) {
    const w = world(t, options);
    const report = await provision(w);
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    return w;
}
// Crash a fresh cleanup process at the named boundary, then resume in a
// second fresh process from the manifest alone.
function crashThenResume(w, point, inspectBoundary = () => {}) {
    const crashed = child(w, 'cleanup', point);
    assert.equal(crashed.status, CRASH_EXIT, crashed.stderr);
    inspectBoundary(reload(w));
    const resumed = child(w, 'cleanup');
    assert.equal(resumed.status, 0, resumed.stderr);
    reload(w);
    return resumed.report;
}

test('L1.cleanup-resume-before-destroy', async t => {
    const w = await provisioned(t);
    const report = crashThenResume(w, 'before-destroy', () => {
        assert.equal(Object.keys(worldState(w.statePath).boxes).length, 1); assert.equal(worldState(w.statePath).destroyCalls, 0);
    });
    assert.equal(report.verdict, 'PASS', JSON.stringify(w.run.cleanup)); assertNothingOwned(w);
    assert.equal(worldState(w.statePath).destroyCalls, 1);
});

test('L1.cleanup-resume-after-destroy-before-removal-intent', async t => {
    const w = await provisioned(t);
    const report = crashThenResume(w, 'after-destroy', run => {
        assert.equal(worldState(w.statePath).destroyCalls, 1); assert.ok(!run.cleanup.steps.some(step => step.id === 'workspace-removal'));
        assert.equal(exists(run.target.execution.workspace.path), true);
    });
    assert.equal(report.verdict, 'PASS', JSON.stringify(w.run.cleanup)); assertNothingOwned(w);
    assert.equal(worldState(w.statePath).destroyCalls, 1, 'the absent Box is proven, not destroyed again');
});

test('L1.cleanup-resume-after-intent-before-rename', async t => {
    const w = await provisioned(t);
    const report = crashThenResume(w, 'after-removal-intent', run => {
        assert.equal(exists(run.target.execution.workspace.path), true);
        assert.equal(exists(quarantinePath(run.target.execution.workspace.path, w.runId)), false);
    });
    assert.equal(report.verdict, 'PASS', JSON.stringify(w.run.cleanup)); assertNothingOwned(w);
});

test('L1.cleanup-resume-after-rename-before-removal', async t => {
    const w = await provisioned(t);
    const report = crashThenResume(w, 'after-rename', run => {
        assert.equal(exists(run.target.execution.workspace.path), false);
        assert.equal(fs.readFileSync(path.join(quarantinePath(run.target.execution.workspace.path, w.runId), '.ploinky-hwl-owner'), 'utf8'), w.runId);
    });
    assert.equal(report.verdict, 'PASS', JSON.stringify(w.run.cleanup)); assertNothingOwned(w);
});

test('L1.cleanup-resume-after-removal-before-complete', async t => {
    const w = await provisioned(t);
    const report = crashThenResume(w, 'after-removal', run => {
        const step = run.cleanup.steps.find(entry => entry.id === 'workspace-removal');
        assert.equal(step.state, 'intent'); assert.ok(step.quarantine);
        assert.equal(exists(step.quarantine), false); assert.equal(exists(run.target.execution.workspace.path), false);
    });
    assert.equal(report.verdict, 'PASS', JSON.stringify(w.run.cleanup)); assertNothingOwned(w);
});

test('L1.cleanup-preserves-quarantine-with-wrong-marker', async t => {
    const w = await provisioned(t);
    const crashed = child(w, 'cleanup', 'after-rename');
    assert.equal(crashed.status, CRASH_EXIT, crashed.stderr);
    const quarantine = reload(w).cleanup.steps.find(entry => entry.id === 'workspace-removal').quarantine;
    fs.writeFileSync(path.join(quarantine, '.ploinky-hwl-owner'), 'f'.repeat(32));
    const resumed = child(w, 'cleanup');
    assert.equal(resumed.report.verdict, 'FAIL'); assert.match(reload(w).cleanup.failures.join(' '), /marker changed/);
    assert.equal(exists(quarantine), true); assert.ok(fs.readdirSync(quarantine).includes('.ploinky'));
});

test('L1.cleanup-after-interrupted-provision-without-receipts', async t => {
    for (const extra of [false, true]) {
        const w = world(t);
        const crashed = child(w, 'provision', 'workspace-before-receipt');
        assert.equal(crashed.status, CRASH_EXIT, crashed.stderr);
        const run = reload(w);
        const workspace = run.target.execution.provision.workspace.path;
        assert.equal(run.target.execution.workspace, null); assert.equal(fs.readFileSync(path.join(workspace, '.ploinky-hwl-owner'), 'utf8'), w.runId);
        if (extra) fs.writeFileSync(path.join(workspace, 'foreign.txt'), 'keep');
        const resumed = child(w, 'cleanup');
        assert.equal(resumed.status, 0, resumed.stderr);
        if (extra) {
            assert.equal(resumed.report.verdict, 'FAIL'); assert.equal(fs.readFileSync(path.join(workspace, 'foreign.txt'), 'utf8'), 'keep');
        } else {
            assert.equal(resumed.report.verdict, 'PASS', JSON.stringify(reload(w).cleanup));
            assert.equal(exists(workspace), false); assert.equal(exists(run.target.execution.provision.workspace.parent), false);
        }
    }
});

test('L1.cleanup-removes-exact-recorded-host-records', async t => {
    const w = await provisioned(t);
    const instance = w.run.workspace.instance;
    const recorded = w.run.ownedPaths.filter(entry => entry.role === 'host-record').map(entry => entry.path).sort();
    assert.deepEqual(recorded, [path.join(w.home, '.ploinky-box', 'hardware-limits', instance), path.join(w.home, '.ploinky-box', 'hardware-limits', `${instance}.json`)]);
    // Similar names and another instance's records are not ours.
    const directory = path.join(w.home, '.ploinky-box', 'hardware-limits');
    const neighbours = [`${instance}.json.bak`, `${instance}-copy`, 'ploinky-box-workspace-000000000000.json'].map(name => path.join(directory, name));
    for (const target of neighbours) fs.writeFileSync(target, 'keep');
    const report = await cleanup(w);
    assert.equal(report.verdict, 'PASS', JSON.stringify(w.run.cleanup));
    for (const target of recorded) assert.equal(exists(target), false);
    for (const target of neighbours) assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

// O11: a shared host-record directory the run created is removed once empty;
// one that existed before the run, or that holds anything else, is kept.
test('L1.cleanup-removes-the-host-record-directory-this-run-created-when-empty', async t => {
    const w = world(t);
    const directory = path.join(w.home, '.ploinky-box', 'hardware-limits');
    assert.equal(exists(directory), false, 'the directory is absent before the run');
    assert.equal(exists(path.join(w.home, '.ploinky-box')), false);
    const report = await provision(w);
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    assert.equal(exists(directory), true, 'the start created it');
    const preflight = w.run.operations.filter(op => op.kind === 'host-directory-preflight');
    assert.deepEqual(preflight.map(op => [op.directory, op.existed]), [['hardware-limits', false], ['gpu-grants', false], ['router-bindings', false]]);
    const created = w.run.ownedPaths.filter(entry => entry.role === 'host-created-directory');
    assert.deepEqual(created.map(entry => entry.path), [directory], 'only the directory that exists now is recorded');
    const result = await cleanup(w);
    assert.equal(result.verdict, 'PASS', JSON.stringify(w.run.cleanup));
    assert.equal(exists(directory), false, 'the run-created, now empty directory is removed');
    assert.equal(exists(path.join(w.home, '.ploinky-box')), true, 'the shared parent is never removed');
});

test('L1.cleanup-keeps-a-host-record-directory-that-existed-before-the-run', async t => {
    const w = world(t);
    const directory = path.join(w.home, '.ploinky-box', 'hardware-limits');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const report = await provision(w);
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    assert.deepEqual(w.run.operations.filter(op => op.kind === 'host-directory-preflight').map(op => [op.directory, op.existed]), [['hardware-limits', true], ['gpu-grants', false], ['router-bindings', false]]);
    assert.equal(w.run.ownedPaths.some(entry => entry.role === 'host-created-directory'), false);
    const result = await cleanup(w);
    assert.equal(result.verdict, 'PASS', JSON.stringify(w.run.cleanup));
    assert.equal(exists(directory), true, 'a pre-existing directory is kept even though it is empty');
    assert.deepEqual(fs.readdirSync(directory), []);
});

test('L1.cleanup-keeps-a-run-created-host-record-directory-that-holds-something-else', async t => {
    const w = await provisioned(t);
    const directory = path.join(w.home, '.ploinky-box', 'hardware-limits');
    fs.writeFileSync(path.join(directory, 'someone-elses.json'), 'keep');
    const result = await cleanup(w);
    assert.equal(result.verdict, 'PASS', JSON.stringify(w.run.cleanup));
    assert.equal(fs.readFileSync(path.join(directory, 'someone-elses.json'), 'utf8'), 'keep');
});

test('L1.cleanup-refuses-unrecorded-host-record', async t => {
    const w = await provisioned(t);
    const unrecorded = hostRecordPaths(w.home, w.run.workspace.instance).find(target => target.includes('/router-bindings/') && target.endsWith('.json'));
    fs.mkdirSync(path.dirname(unrecorded), { recursive: true }); fs.writeFileSync(unrecorded, '{}');
    const recorded = w.run.ownedPaths.filter(entry => entry.role === 'host-record').map(entry => entry.path);
    const report = await cleanup(w);
    assert.equal(report.verdict, 'FAIL'); assert.match(w.run.cleanup.failures[0], /Unrecorded host state remains at router-bindings\//);
    assert.equal(exists(unrecorded), true);
    for (const target of recorded) assert.equal(exists(target), true, 'nothing is removed when one record is unrecorded');
    assert.equal(exists(w.run.target.execution.workspace.path), true);
    // A manifest that names a non-exact record is refused outright.
    w.run.ownedPaths.push({ path: path.join(w.home, '.ploinky-box', 'hardware-limits', 'other.json'), role: 'host-record', type: 'file', uid: 1, dev: '1', ino: '1' });
    assert.throws(() => validateProfile(w.run, { partial: true }), /non-exact host record/);
});

test('L1.cleanup-final-inventory-change-fails', async t => {
    const w = await provisioned(t);
    let listings = 0;
    const late = 'd'.repeat(64);
    const provider = async (binary, args, options) => {
        const result = await w.engineProvider(binary, args, options);
        if (args[0] === 'container' && args[1] === 'ps' && ++listings === 3) result.stdout += `${late}\n`;
        return result;
    };
    const report = await executeCleanupRun({ run: w.run, persist: w.persist, processProvider: provider, hostIdentity: w.hostIdentity });
    assert.equal(report.verdict, 'FAIL'); assert.match(w.run.cleanup.failures[0], /inventory changed at final verification/);
    assert.equal(w.run.cleanup.steps.find(step => step.id === 'verify-absent').state, 'intent');
    assert.ok(!worldState(w.statePath).calls.some(call => call.args.includes(late) && call.kind !== 'ps'), 'the unrelated container is never touched');
});

test('L1.cleanup-refuses-changed-host-record-identity', async t => {
    const w = await provisioned(t);
    const directory = w.run.ownedPaths.find(entry => entry.role === 'host-record' && entry.type === 'directory').path;
    fs.renameSync(directory, `${directory}-moved`); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'foreign'), 'keep');
    const report = await cleanup(w);
    assert.equal(report.verdict, 'FAIL'); assert.match(w.run.cleanup.failures[0], /directory identity changed/);
    assert.equal(fs.readFileSync(path.join(directory, 'foreign'), 'utf8'), 'keep');
});

test('L1.cleanup-unshare-for-subordinate-owned-files', async t => {
    for (const platform of ['linux', 'darwin']) {
        const w = await provisioned(t, { platform });
        const sub = path.join(w.run.target.execution.workspace.path, 'agent-data');
        fs.mkdirSync(sub); fs.writeFileSync(path.join(sub, 'owned-by-subordinate'), 'x'); fs.chmodSync(sub, 0o500);
        const report = await cleanup(w);
        const unshare = worldState(w.statePath).unshare;
        if (platform === 'linux') {
            assert.equal(report.verdict, 'PASS', JSON.stringify(w.run.cleanup));
            const quarantine = quarantinePath(w.run.target.execution.workspace.path, w.runId);
            assert.deepEqual(unshare, [['unshare', '/bin/rm', '-rf', '--', path.join(quarantine, 'agent-data')]]);
            assertNothingOwned(w);
        } else {
            assert.equal(report.verdict, 'FAIL'); assert.deepEqual(unshare, []);
            assert.equal(exists(quarantinePath(w.run.target.execution.workspace.path, w.runId)), true);
        }
    }
});

// --- Concrete manifests -------------------------------------------------------

function gitRepo(root) {
    const run = args => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    run(['init', '-q']);
    run(['add', '-A']);
    run(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']);
    return run(['rev-parse', 'HEAD']);
}
function treeDigestOf(root) {
    const rows = [];
    const walk = (directory, relative = '') => {
        for (const name of fs.readdirSync(directory).sort()) {
            if (name === '.git') continue;
            const target = path.join(directory, name); const rel = relative ? `${relative}/${name}` : name;
            const stat = fs.lstatSync(target);
            if (stat.isDirectory()) walk(target, rel);
            else if (stat.isFile()) rows.push(`${rel}\0${hash(fs.readFileSync(target)).slice(7)}`);
        }
    };
    walk(root); return hash(rows.join('\n'));
}
function prepareFixture(t, { suffix = 'claude' } = {}) {
    const root = scratch(t);
    const ploinky = path.join(root, 'ploinky');
    fs.mkdirSync(path.join(ploinky, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// candidate\n');
    fs.mkdirSync(path.join(ploinky, 'tests', 'hardware-limits'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'tests', 'hardware-limits', 'verify.mjs'), '// runner\n');
    fs.writeFileSync(path.join(ploinky, 'tests', 'hardware-limits', 'mpsprobe.py'), '# the CUDA probe\n');
    const revision = gitRepo(ploinky);
    const explorer = path.join(root, 'explorer'); fs.mkdirSync(path.join(explorer, 'explorer'), { recursive: true });
    fs.writeFileSync(path.join(explorer, 'explorer', 'manifest.json'), `{\n    "container": "${IMAGE}",\n    "lite-sandbox": true\n}\n`);
    const dependency = path.join(root, 'deps', 'smalldep'); fs.mkdirSync(dependency, { recursive: true }); fs.writeFileSync(path.join(dependency, 'index.js'), 'export default 1;\n');
    const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence, { mode: 0o700 });
    const casesPath = path.join(evidence, `cases_${suffix}.json`); writePrivateJson(casesPath, { schema: 1, cases: [] });
    const entry = candidateRoot => ({ baselineRevision: '0'.repeat(40), baselineExport: root, baselineStage: null, candidateRoot, sourceDigest: hash('x'), instructionDigests: {} });
    const config = {
        schema: 1, runId: crypto.randomBytes(16).toString('hex'), createdAt: new Date().toISOString(), documentSuffix: suffix,
        node: { absoluteExecutable: fs.realpathSync(process.execPath), version: process.version },
        repos: { ploinky: entry(ploinky), explorer: entry(explorer), localLlms: entry(root), images: { ...entry(null), candidateRoot: null } },
        dependencies: [{ name: 'smalldep', realpath: dependency, revision: null, treeDigest: treeDigestOf(dependency) }],
        evidenceRoot: evidence, casesPath, casesDigest: hash(fs.readFileSync(casesPath)), engine: null, ssh: null,
    };
    const configPath = path.join(evidence, `config_${suffix}.json`); writePrivateJson(configPath, config);
    const engine = path.join(root, 'podman'); fs.writeFileSync(engine, 'fake engine\n');
    const parentRoot = shortParent(t);
    const node = fs.realpathSync(process.execPath);
    const macPins = {
        schema: 1, host: { hostname: os.hostname(), platform: process.platform, home: fs.realpathSync(os.homedir()) },
        node: { path: node, digest: hash(fs.readFileSync(node)) }, engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: engineIdentityDigest(fakeEngineInfo(ENGINE_HOST)) },
        boxImage: BOX_IMAGE, workspaceParentRoot: parentRoot, ports: { tcp: 24680, udp: 35791 },
    };
    const ssh = path.join(root, 'ssh'); fs.writeFileSync(ssh, 'fake ssh\n');
    const knownHosts = path.join(root, 'known_hosts'); fs.writeFileSync(knownHosts, '192.168.1.63 ssh-ed25519 AAAAfixture\n');
    const apparatusPins = {
        schema: 1, host: { hostname: 'apparatus', platform: 'linux', home: '/home/skutner' },
        node: { path: '/usr/bin/node', digest: hash('remote node') }, engine: { path: '/usr/bin/podman', digest: hash('remote podman'), identityDigest: engineIdentityDigest(fakeEngineInfo(ENGINE_HOST)) },
        boxImage: BOX_IMAGE, ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '100.76.22.69', hostKeyAlias: '192.168.1.63', user: 'skutner', knownHosts, identityFile: null },
    };
    const pinsFile = (name, value) => { const file = path.join(evidence, name); writePrivateJson(file, value); return file; };
    // The observed GPU device and NVIDIA tools of the apparatus (paths only: prepare-live opens no SSH).
    const gpuPins = {
        uuid: 'GPU-905b8484-3b1e-30f6-defd-05d44f00f692', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '595.91.07', memoryMiB: 6144, expectedSmCount: 30,
        smi: { path: '/usr/bin/nvidia-smi', digest: hash('smi') }, mpsControl: { path: '/usr/bin/nvidia-cuda-mps-control', digest: hash('control') }, mpsServer: { path: '/usr/bin/nvidia-cuda-mps-server', digest: hash('server') },
    };
    return { root, ploinky, revision, evidence, configPath, macPins, apparatusPins, gpuPins, pinsFile };
}
async function verifyMain() { return (await import('../hardware-limits/verify.mjs')).main; }

test('L1.prepare-live-mac-cpu-concrete-manifest-and-summary', async t => {
    const f = prepareFixture(t);
    const main = await verifyMain();
    const runPath = path.join(f.evidence, 'mac-cpu-run_claude.json');
    const args = ['prepare-live', '--config', f.configPath, '--block', 'mac-cpu', '--run', runPath, '--pins', f.pinsFile('pins_claude.json', f.macPins)];
    if (process.platform !== 'darwin') { await assert.rejects(main(args), /Invalid pins/); return; }
    assert.equal(await main(args), 0);
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    const profile = validateProfile(run, { partial: true });
    assert.equal(run.state, 'proposed'); assert.deepEqual(profile.cases, ['LIVE-C1', 'LIVE-C2']); assert.deepEqual(run.target.cases, ['LIVE-C1', 'LIVE-C2']);
    assert.deepEqual(Object.keys(run.target.unsupported), ['LIVE-C3', 'LIVE-C4', 'LIVE-C5', 'LIVE-C6', 'LIVE-C7']);
    assert.equal(profile.provision.revision, f.revision);
    assert.equal(profile.source.root, path.join(f.evidence, `candidate-${run.runId}`));
    assert.equal(liveSourceDigest(profile.source.root), profile.source.digest);
    assert.equal(fs.readFileSync(path.join(profile.source.root, 'node_modules', 'smalldep', 'index.js'), 'utf8'), 'export default 1;\n');
    assert.deepEqual(profile.node, f.macPins.node); assert.deepEqual(profile.engine, f.macPins.engine); assert.deepEqual(profile.host, f.macPins.host);
    assert.deepEqual(run.ports, { tcp: 24680, udp: 35791 }); assert.equal(run.deadlines.startMs, 1200000); assert.equal(run.deadlines.cleanupMs, 300000);
    assert.deepEqual(run.images.map(image => image.ref), [IMAGE, BOX_IMAGE]);
    assert.equal(profile.provision.workspace.parent, path.join(f.macPins.workspaceParentRoot, `ploinky-hwl-${run.runId}`));
    assert.equal(run.workspace.instance, buildWorkspaceIdentity(profile.provision.workspace.path, { lstatSync: () => ({ dev: 0, ino: 0, mode: 0, isSymbolicLink: () => false }) }).instance);
    const start = run.target.plan.provision.find(entry => entry.id === 'fixture-start');
    assert.deepEqual(start.argv, [profile.candidate.path, '--port', '24680', '--udp-port', '35791', 'start', 'hwlfixture/memory']);
    assert.deepEqual(start.env, { PLOINKY_BOX_HARDWARE_LIMITS: 'on', PLOINKY_BOX_IMAGE: BOX_IMAGE });
    assert.deepEqual(run.target.plan.cleanup.map(entry => entry.id), ['revalidate-identity', 'destroy-box', 'host-records', 'workspace-removal', 'workspace-parent-removal', 'verify-absent']);
    assert.ok(run.target.plan.live.some(entry => entry.id === 'C1-core-layout') && run.target.plan.live.some(entry => entry.id === 'C2-pids-pressure'));
    assert.equal(run.target.ssh, null); assert.equal(run.target.remote, undefined);
    const summary = fs.readFileSync(summaryPathFor(runPath, 'claude'), 'utf8');
    assert.equal(summaryPathFor(runPath, 'claude'), path.join(f.evidence, 'mac-cpu-run_summary_claude.md'));
    for (const text of ['Nothing has run', 'TCP 24680', 'UDP 35791', profile.provision.workspace.path, 'memory 64m, cpus 0.5, pids 64', BOX_IMAGE, IMAGE,
        'destroy --delete-cache', 'LIVE-C3 | not run', f.revision, os.hostname(),
        'PLOINKY_BOX_HARDWARE_LIMITS=on', '$SOURCE/ploinky-box/bin/ploinky-box.mjs --port 24680 --udp-port 35791 start hwlfixture/memory`']) assert.ok(summary.includes(text), text);
    assert.equal(fs.statSync(runPath).mode & 0o077, 0); assert.equal(fs.statSync(summaryPathFor(runPath, 'claude')).mode & 0o077, 0);
});

// O4: evidence names carry the configured document suffix (claude or codex),
// exactly once before the extension: the run summary, the staging journal, the
// fetched remote report and the self-test report.
test('L1.evidence-names-use-the-configured-document-suffix', async t => {
    assert.equal(summaryPathFor('/x/run_codex.json', 'codex'), '/x/run_summary_codex.md');
    assert.equal(summaryPathFor('/x/run_claude.json', 'claude'), '/x/run_summary_claude.md');
    assert.equal(summaryPathFor('/x/run.json', 'codex'), '/x/run_summary_codex.md');
    for (const bad of [undefined, '', 'gpt', 'claude_codex']) assert.throws(() => summaryPathFor('/x/run.json', bad), /configured document suffix/);
    const { selfTestReportPath } = await import('../hardware-limits/verify.mjs');
    assert.equal(selfTestReportPath('/e', 'codex'), '/e/report_self-test_codex.json');
    assert.equal(selfTestReportPath('/e', 'claude'), '/e/report_self-test_claude.json');
    assert.throws(() => selfTestReportPath('/e', 'other'), /claude or codex/);
    // prepare-live writes the summary with the configured suffix (codex here).
    if (process.platform === 'darwin') {
        const f = prepareFixture(t, { suffix: 'codex' });
        const main = await verifyMain();
        const runPath = path.join(f.evidence, 'mac-cpu-run_codex.json');
        assert.equal(await main(['prepare-live', '--config', f.configPath, '--block', 'mac-cpu', '--run', runPath, '--pins', f.pinsFile('pins_codex.json', f.macPins)]), 0);
        assert.ok(exists(path.join(f.evidence, 'mac-cpu-run_summary_codex.md')));
        assert.equal(fs.readdirSync(f.evidence).some(name => name.includes('_claude')), false, 'no claude-named evidence is written for a codex run');
    }
    // The staging journal and the fetched remote report use it too.
    const w = stagedWorld(t, {}, { suffix: 'codex' });
    assert.equal(path.basename(w.remoteRun), 'run_codex.json');
    const report = await w.act('provision');
    assert.equal(report.verdict, 'PASS', JSON.stringify(report));
    assert.ok(exists(path.join(w.evidence, `staging_${w.runId}_codex.json`)));
    assert.ok(exists(path.join(w.evidence, 'report_provision_remote_codex.json')));
    assert.equal(fs.readdirSync(w.evidence).filter(name => name.includes('_claude')).length, 0, `no claude-named evidence: ${fs.readdirSync(w.evidence).join(', ')}`);
});

test('L1.prepare-live-apparatus-cpu-concrete-manifest-and-summary', async t => {
    const f = prepareFixture(t);
    const main = await verifyMain();
    const runPath = path.join(f.evidence, 'apparatus-cpu-run_claude.json');
    assert.equal(await main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-cpu', '--run', runPath, '--pins', f.pinsFile('pins_claude.json', f.apparatusPins)]), 0);
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    const profile = validateProfile(run, { partial: true });
    const root = `/home/skutner/.cache/ploinky-hwlimits/${run.runId}`;
    assert.deepEqual(profile.cases, ['LIVE-A1']); assert.deepEqual(profile.provision.agents.map(agent => agent.name), ['memory']);
    assert.deepEqual(run.target.ssh, { alias: 'ubuntu-codex', expectedAddress: '100.76.22.69', expectedHostKeyAlias: '192.168.1.63' });
    assert.equal(run.target.remote.address, '100.76.22.69'); assert.equal(run.target.remote.hostKeyAlias, '192.168.1.63'); assert.equal(run.target.remote.user, 'skutner');
    assert.equal(run.target.remote.runPath, `${root}/run/run_claude.json`);
    assert.equal(profile.source.root, `${root}/source`); assert.equal(profile.provision.workspace.path, `${root}/workspace`);
    assert.equal(profile.provision.workspace.parentMode, 'staged');
    // The staged payload is the frozen candidate, digest-pinned.
    const payload = fs.readFileSync(run.target.stage.payloadPath);
    assert.equal(hash(payload), run.target.stage.payloadDigest); assert.equal(payload.length, run.target.stage.payloadBytes);
    const extracted = path.join(f.root, 'extracted'); fs.mkdirSync(extracted);
    assert.equal(spawnSync('tar', ['-x', '-f', run.target.stage.payloadPath, '-C', extracted]).status, 0);
    assert.equal(liveSourceDigest(fs.realpathSync(extracted)), profile.source.digest);
    assert.ok(run.target.plan.staging.some(entry => entry.id === 'remove-staging'));
    const summary = fs.readFileSync(summaryPathFor(runPath, 'claude'), 'utf8');
    for (const text of ['skutner@100.76.22.69', 'HostKeyAlias 192.168.1.63', root, 'LIVE-A1 | executed', 'fetched remote cleanup PASS']) assert.ok(summary.includes(text), text);
    // Nothing is unsupported here: no empty case list, and no agent name in the runtime summary file name.
    assert.deepEqual(run.target.unsupported, {}); assert.ok(!/Cases\s+stay BLOCKED/.test(summary)); assert.ok(summary.includes('No case is unsupported on this target.'));
    assert.equal(path.basename(summaryPathFor(runPath, 'claude')), 'apparatus-cpu-run_summary_claude.md');
});

test('G1.prepare-live-apparatus-mps-concrete-manifest-and-summary', async t => {
    const f = prepareFixture(t);
    const main = await verifyMain();
    const runPath = path.join(f.evidence, 'apparatus-mps-run_claude.json');
    assert.equal(await main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-mps', '--run', runPath, '--pins', f.pinsFile('pins_claude.json', { ...f.apparatusPins, gpu: f.gpuPins })]), 0);
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    const profile = validateProfile(run, { partial: true });
    const root = `/home/skutner/.cache/ploinky-hwlimits/${run.runId}`;
    assert.deepEqual(profile.cases, ['LIVE-P1', 'LIVE-P2', 'LIVE-P3', 'LIVE-P4']); assert.deepEqual(run.target.unsupported, {});
    assert.deepEqual(profile.provision.agents.map(agent => [agent.name, agent.hardwareLimits.memory]), [['probe', '2g'], ['peer', '2g'], ['cpu', '64m']]);
    assert.equal(profile.fixtures.gpu.ref, 'hwlfixture/probe'); assert.equal(profile.fixtures.cpu, undefined);
    assert.equal(run.deadlines.blockMs, 24 * 60 * 1000);
    // The pins: the device and the three NVIDIA tools, and the probe file pinned from the FROZEN candidate.
    assert.deepEqual({ ...profile.gpu, probe: undefined }, { ...f.gpuPins, probe: undefined });
    const frozenProbe = fs.readFileSync(path.join(f.evidence, `candidate-${run.runId}`, 'tests', 'hardware-limits', 'mpsprobe.py'));
    assert.deepEqual(profile.gpu.probe, { sourcePath: `${root}/source/tests/hardware-limits/mpsprobe.py`, digest: hash(frozenProbe) });
    assert.deepEqual(profile.provision.gpu, { uuid: f.gpuPins.uuid, grantAgents: ['hwlfixture/probe', 'hwlfixture/peer'], probe: { ...profile.gpu.probe, target: 'probe/mpsprobe.py' } });
    // The plan: the gate, the grant before the start, every case's commands, the cleanup bracket.
    const provisionIds = run.target.plan.provision.map(entry => entry.id);
    assert.ok(provisionIds.indexOf('gpu-initial-gate') < provisionIds.indexOf('gpu-grant') && provisionIds.indexOf('gpu-grant') < provisionIds.indexOf('fixture-start'), provisionIds.join(','));
    assert.deepEqual(run.target.plan.cleanup.map(entry => entry.id), ['gpu-stop-owned-helpers', 'revalidate-identity', 'destroy-box', 'host-records', 'workspace-removal', 'verify-absent', 'gpu-final-observation']);
    for (const id of ['P1-apply', 'P2-probe-bypass', 'P3-kill-owned-daemon', 'P4-control-rw-widen-sm', 'P4-probe-after-reconcile']) assert.ok(run.target.plan.live.some(entry => entry.id === id), id);
    const summary = fs.readFileSync(summaryPathFor(runPath, 'claude'), 'utf8');
    for (const text of [
        '## GPU idle gate', 'compute mode is Default', 'a bare PID, UID or name never excludes', 'the runner never changes the compute mode and never signals a foreign process', f.gpuPins.uuid,
        '## GPU operations', 'P1-apply', 'P2-probe-bypass', 'P3-apply-default-change', 'P3-kill-owned-daemon', 'P3-restart-agent', 'P4-control-rw-widen-sm', 'gpu-final-observation',
        '## Images, tools and digests', IMAGE, BOX_IMAGE, f.gpuPins.smi.digest, f.gpuPins.mpsControl.digest, f.gpuPins.mpsServer.digest, profile.gpu.probe.digest,
        '## Grant and policy records', `~/.ploinky-box/gpu-grants/${run.workspace.instance}.json`, `~/.ploinky-box/hardware-limits/${run.workspace.instance}/`, 'already exists and stays',
        'Order: gpu-stop-owned-helpers, revalidate-identity, destroy-box, host-records, workspace-removal, verify-absent, gpu-final-observation', 'No case is unsupported on this target.',
    ]) assert.ok(summary.includes(text), text);
    assert.equal(fs.statSync(runPath).mode & 0o077, 0);
    // A GPU block without GPU pins, or with malformed ones, is refused before anything is written; a CPU block names no GPU.
    for (const [label, pins] of [['no GPU pins', f.apparatusPins], ['a short UUID', { ...f.apparatusPins, gpu: { ...f.gpuPins, uuid: 'GPU-1' } }], ['a relative tool path', { ...f.apparatusPins, gpu: { ...f.gpuPins, smi: { path: 'nvidia-smi', digest: hash('smi') } } }],
        ['an extra field', { ...f.apparatusPins, gpu: { ...f.gpuPins, extra: 1 } }]]) {
        const refused = path.join(f.evidence, `refused-${label.replaceAll(' ', '-')}_claude.json`);
        await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-mps', '--run', refused, '--pins', f.pinsFile('pins_refused_claude.json', pins)]), /pinned GPU|Invalid pinned|fields/, label);
        assert.equal(exists(refused), false, label);
    }
    await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'apparatus-cpu', '--run', path.join(f.evidence, 'cpu-gpu_claude.json'), '--pins', f.pinsFile('pins_cpu_gpu_claude.json', { ...f.apparatusPins, gpu: f.gpuPins })]), /names no GPU/);
});

test('L1.prepare-live-other-blocks-stay-unsupported', async t => {
    const f = prepareFixture(t);
    const main = await verifyMain();
    // apparatus-mps has concrete executors since round G1; the rest stay unsupported.
    for (const block of ['mac-adversarial', 'mac-explorer', 'apparatus-local-llm', 'apparatus-vllm']) {
        const runPath = path.join(f.evidence, `${block}-run_claude.json`);
        assert.equal(await main(['prepare-live', '--config', f.configPath, '--block', block, '--run', runPath]), 0);
        const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
        assert.match(run.target.note, /^Unsupported block/); assert.equal(run.target.execution, undefined);
        assert.ok(Object.keys(run.target.unsupported).length > 0);
        assert.equal(exists(summaryPathFor(runPath, 'claude')), false);
    }
    await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'mac-cpu', '--run', path.join(f.evidence, 'no-pins_claude.json')]), /needs --pins/);
});

test('L1.prepare-live-refuses-mismatched-local-pins', async t => {
    const f = prepareFixture(t);
    const main = await verifyMain();
    const runPath = path.join(f.evidence, 'mac-cpu-run_claude.json');
    for (const pins of [
        { ...f.macPins, node: { ...f.macPins.node, digest: hash('other node') } },
        { ...f.macPins, engine: { ...f.macPins.engine, digest: hash('other engine') } },
        { ...f.macPins, host: { ...f.macPins.host, hostname: 'another-host' } },
        { ...f.macPins, boxImage: 'docker.io/assistos/ploinky-box:latest' },
    ]) {
        await assert.rejects(main(['prepare-live', '--config', f.configPath, '--block', 'mac-cpu', '--run', runPath, '--pins', f.pinsFile('pins_claude.json', pins)]), /pin|Pinned host|Invalid pins/);
        assert.equal(exists(runPath), false);
    }
});

test('L1.fixture-declares-hardware-limits', () => {
    // Every fixture agent declares its limits through hardwareLimits, which
    // production validates and admits as the agent's manifest request.
    const agents = fixturePlan(['LIVE-C1', 'LIVE-C2']);
    assert.deepEqual(agents.map(agent => agent.name), ['memory', 'cpu', 'pids']);
    for (const agent of agents) {
        const manifest = fixtureManifest(agent, { image: IMAGE, agents });
        assert.deepEqual(manifest.hardwareLimits, FIXTURE_HARDWARE_LIMITS);
        assert.equal(Object.hasOwn(manifest, 'llmRuntime'), false);
        assert.deepEqual(deprecatedHardwareDeclarations(manifest), []);
        assert.doesNotThrow(() => validateManifestRuntimeCapabilities(manifest));
        const admission = admitManifestRuntimeCapabilities(manifest, { agentId: `${FIXTURE_REPOSITORY}/${agent.name}`, runtime: 'podman', insideBox: false });
        assert.deepEqual(admission.descriptor.hardwareRequest, [
            { field: 'memory', value: '64m', source: 'manifest' },
            { field: 'cpus', value: '0.5', source: 'manifest' },
            { field: 'pidsLimit', value: '64', source: 'manifest' },
        ]);
    }
});

test('L1.fixture-plan-validation-requires-hardware-limits', () => {
    const plan = (agents) => ({
        revision: 'c'.repeat(40), repository: FIXTURE_REPOSITORY, image: IMAGE, boxImage: BOX_IMAGE, agents,
        workspace: { parent: '/tmp/hwl-parent', parentMode: 'create', path: '/tmp/hwl-parent/workspace' },
    });
    assert.doesNotThrow(() => validateProvisionPlan(plan(fixturePlan(['LIVE-C2']))));
    // The old plan key (the deprecated llmRuntime.runtimePolicy.resources
    // values) and any other limit values are refused.
    const legacy = fixturePlan(['LIVE-C1']).map(({ hardwareLimits, ...agent }) => ({ ...agent, resources: hardwareLimits }));
    assert.throws(() => validateProvisionPlan(plan(legacy)), /Invalid fixture agent fields/);
    const changed = fixturePlan(['LIVE-C1']).map(agent => ({ ...agent, hardwareLimits: { ...agent.hardwareLimits, memory: '128m' } }));
    assert.throws(() => validateProvisionPlan(plan(changed)), /Invalid fixture agent$/);
    const extra = fixturePlan(['LIVE-C1']).map(agent => ({ ...agent, hardwareLimits: { ...agent.hardwareLimits, gpu: 'all' } }));
    assert.throws(() => validateProvisionPlan(plan(extra)), /Invalid fixture hardwareLimits fields/);
});

// --- The real process path ------------------------------------------------
// The CLI entry and the runner's defaults, with NO injected process provider:
// the pinned engine binary and the candidate are real executables that
// interpret the same file-backed fake world (fakeLiveProcess.mjs).
import { writeFakeExecutables } from '../hardware-limits/fakeLiveProcess.mjs';
function realProcessWorld(t, { identityDigest = null, host = ENGINE_HOST } = {}) {
    const root = scratch(t);
    const directory = name => { const target = path.join(root, name); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); return target; };
    const home = directory('home');
    const source = directory('source');
    fs.mkdirSync(path.join(source, 'ploinky-box', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'tests', 'hardware-limits'), { recursive: true });
    fs.writeFileSync(path.join(source, 'tests', 'hardware-limits', 'verify.mjs'), '// fixture runner\n');
    const bin = directory('bin');
    const engine = path.join(bin, 'podman');
    const configPath = path.join(root, 'fake_process.json');
    const node = fs.realpathSync(process.execPath);
    const candidateFile = path.join(source, 'ploinky-box', 'bin', 'ploinky-box.mjs');
    writeFakeExecutables({ configPath, enginePath: engine, candidatePath: candidateFile, node });
    const statePath = path.join(root, 'world.json');
    fs.writeFileSync(configPath, JSON.stringify({ statePath, node, engine, host, unrelated: UNRELATED, candidate: candidateFile }));
    const evidence = directory('evidence');
    const hostIdentity = { hostname: os.hostname(), platform: process.platform, home };
    const pins = {
        schema: 1, host: hostIdentity, node: { path: node, digest: hash(fs.readFileSync(node)) },
        engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: identityDigest || engineIdentityDigest(fakeEngineInfo(host)) },
        boxImage: BOX_IMAGE, workspaceParentRoot: shortParent(t),
    };
    const runId = crypto.randomBytes(16).toString('hex');
    const run = buildConcreteManifest({ block: 'mac-cpu', runId, configDigest: hash('config'), casesDigest: hash('cases'), documentSuffix: 'claude', pins,
        candidate: { root: source, digest: liveSourceDigest(source), revision: 'c'.repeat(40) }, image: IMAGE, ports: { tcp: 23456, udp: 34567 }, unsupported: {} });
    const runPath = path.join(evidence, 'run.json');
    writePrivateJson(runPath, run);
    const authorizationPath = path.join(evidence, 'authorization.json');
    const bind = action => writePrivateJson(authorizationPath, { schema: 1, runId, manifestDigest: hash(fs.readFileSync(runPath)), targetDigest: jsonDigest(JSON.parse(fs.readFileSync(runPath, 'utf8')).target), action });
    // The runner's host identity comes from HOME; run with the fixture home.
    const withHome = async (fn) => { const prior = process.env.HOME; process.env.HOME = home; try { return await fn(); } finally { if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior; } };
    return { root, home, evidence, engine, node, statePath, runPath, authorizationPath, bind, withHome, hostIdentity, get run() { return JSON.parse(fs.readFileSync(runPath, 'utf8')); } };
}
const quiet = async (fn) => { const log = console.log; const error = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = error; } };

test('L1.cli-provision-and-cleanup-run-real-processes-without-an-injected-provider', async t => {
    const main = await verifyMain();
    // The CLI provision entry reaches the real engine binary: the engine
    // service identity is observed through a real process (and refused here,
    // before any mutation, because the pin names another service).
    const refused = realProcessWorld(t, { identityDigest: hash('another engine service') });
    refused.bind('provision');
    assert.equal(await refused.withHome(() => quiet(() => main(['provision', '--run', refused.runPath, '--authorization', refused.authorizationPath]))), 2);
    const blockedReport = JSON.parse(fs.readFileSync(path.join(refused.evidence, 'report_provision.json'), 'utf8'));
    assert.deepEqual(blockedReport.limitations, ['Engine service identity changed'], JSON.stringify(blockedReport));
    assert.deepEqual(worldState(refused.statePath).calls.map(call => [call.kind, call.binary]), [['info', refused.engine]]);
    assert.equal(exists(refused.run.target.execution.provision.workspace.path), false, 'nothing was created');
    // Provisioning with the runner's default provider, then the CLI cleanup
    // entry: every engine and candidate call is a real child process.
    const w = realProcessWorld(t);
    const run = w.run;
    const report = await w.withHome(() => provisionRun({ run, persist: () => writePrivateJson(w.runPath, run), portProbe: free, hostIdentity: w.hostIdentity, validateProfile }));
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    const provisioned = worldState(w.statePath);
    assert.equal(Object.keys(provisioned.boxes).length, 1);
    assert.ok(provisioned.calls.some(call => call.kind === 'start' && call.binary === w.node));
    w.bind('cleanup');
    assert.equal(await w.withHome(() => quiet(() => main(['cleanup', '--run', w.runPath, '--authorization', w.authorizationPath]))), 0);
    const cleaned = JSON.parse(fs.readFileSync(path.join(w.evidence, 'report_cleanup.json'), 'utf8'));
    assert.equal(cleaned.verdict, 'PASS', JSON.stringify(cleaned));
    const state = worldState(w.statePath);
    assert.deepEqual(Object.keys(state.boxes), []);
    assert.equal(state.destroyCalls, 1);
    assert.equal(exists(w.run.target.execution.provision.workspace.path), false);
    assert.deepEqual(fs.readdirSync(w.evidence).filter(name => name.includes('codex')), [], 'runtime artifact names encode no agent name');
});

// The engine service identity uses stable, distinguishing facts and fails
// closed when one is missing.
// R10: an engine whose info does not state whether its service is remote is
// never assumed local (no connection would then be required): it fails closed.
test('L1.engine-identity-requires-the-service-locality-fact', async () => {
    const local = { host: { arch: 'arm64', os: 'linux', hostname: 'h', kernel: '6.12.0', serviceIsRemote: false, remoteSocket: { path: '/run/user/1/podman/podman.sock' } },
        store: { graphRoot: '/g', runRoot: '/r' }, version: { Version: '6.0.1' } };
    assert.doesNotThrow(() => engineIdentityFacts(local));
    for (const value of [undefined, null, 'false', 0, 1, {}]) {
        const info = { ...local, host: { ...local.host, serviceIsRemote: value } };
        assert.throws(() => engineIdentityFacts(info), (error) => error.code === 'ENGINE_IDENTITY_INCOMPLETE' && /host\.serviceIsRemote/.test(error.message), String(value));
    }
    const missing = { ...local, host: Object.fromEntries(Object.entries(local.host).filter(([key]) => key !== 'serviceIsRemote')) };
    assert.throws(() => engineIdentityFacts(missing), { code: 'ENGINE_IDENTITY_INCOMPLETE' });
    // Through the observer: no connection command runs, and it fails.
    const calls = [];
    await assert.rejects(observeEngineIdentity(async (kind) => { calls.push(kind); return ok(JSON.stringify(missing)); }), { code: 'ENGINE_IDENTITY_INCOMPLETE' });
    assert.deepEqual(calls, ['engine-identity']);
});

test('L1.engine-identity-strong-facts-fail-closed', async t => {
    const machine = (uri, graphRoot = '/var/home/core/.local/share/containers/storage') => ({
        info: { host: { arch: 'arm64', os: 'linux', hostname: 'localhost.localdomain', kernel: '6.12.0', serviceIsRemote: true, remoteSocket: { path: '/run/user/501/podman/podman.sock' }, memFree: 1, uptime: '1h' },
            store: { graphRoot, runRoot: '/run/user/501/containers' }, version: { Version: '6.0.1' } },
        connections: [{ Name: 'podman-machine-default', URI: uri, Identity: '/Users/someone/.ssh/machine', Default: true }, { Name: 'other', URI: 'ssh://core@127.0.0.1:1/x', Default: false }],
    });
    const a = machine('ssh://core@127.0.0.1:50123/run/user/501/podman/podman.sock');
    const facts = engineIdentityFacts(a.info, a.connections);
    assert.deepEqual(facts.connection, { name: 'podman-machine-default', uri: a.connections[0].URI });
    assert.equal(JSON.stringify(facts).includes('.ssh'), false, 'no key path or other secret-bearing value');
    // The old {arch, os, hostname, id} identity cannot tell these apart; this one does.
    const b = machine('ssh://core@127.0.0.1:50999/run/user/501/podman/podman.sock');
    assert.notEqual(engineIdentityDigest(a.info, a.connections), engineIdentityDigest(b.info, b.connections));
    const c = machine(a.connections[0].URI, '/var/lib/other/storage');
    assert.notEqual(engineIdentityDigest(a.info, a.connections), engineIdentityDigest(c.info, c.connections));
    // Volatile facts never change it.
    assert.equal(engineIdentityDigest({ ...a.info, host: { ...a.info.host, memFree: 2, uptime: '2h' } }, a.connections), engineIdentityDigest(a.info, a.connections));
    // Missing facts fail closed.
    for (const [label, info, connections] of [
        ['kernel', { ...a.info, host: { ...a.info.host, kernel: '' } }, a.connections],
        ['graphRoot', { ...a.info, store: {} }, a.connections],
        ['engine version', { ...a.info, version: {} }, a.connections],
        ['service socket', { ...a.info, host: { ...a.info.host, remoteSocket: null } }, a.connections],
        ['default connection', a.info, a.connections.map(entry => ({ ...entry, Default: false }))],
        ['one default connection', a.info, a.connections.map(entry => ({ ...entry, Default: true }))],
    ]) assert.throws(() => engineIdentityFacts(info, connections), { code: 'ENGINE_IDENTITY_INCOMPLETE' }, label);
    // Provisioning observes it through the engine: a remote service adds its
    // connection; an incomplete reply is BLOCKED before any mutation.
    const remoteHost = { ...ENGINE_HOST, serviceIsRemote: true };
    const remote = realProcessWorld(t, { host: remoteHost, identityDigest: engineIdentityDigest(fakeEngineInfo(remoteHost), FAKE_CONNECTIONS) });
    const run = remote.run;
    const report = await remote.withHome(() => provisionRun({ run, persist: () => writePrivateJson(remote.runPath, run), portProbe: free, hostIdentity: remote.hostIdentity, validateProfile }));
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.limitations));
    assert.deepEqual(worldState(remote.statePath).calls.slice(0, 2).map(call => call.kind), ['info', 'connections']);
    assert.equal((await remote.withHome(() => executeCleanupRun({ run, persist: () => writePrivateJson(remote.runPath, run), hostIdentity: remote.hostIdentity }))).verdict, 'PASS');
    const w = world(t, { faults: { info: { info: { host: { arch: 'test', os: 'linux', hostname: 'fake-engine' }, version: { Version: '6' } } } } });
    const incomplete = await provision(w);
    assert.equal(incomplete.verdict, 'BLOCKED');
    assert.match(incomplete.limitations[0], /Engine service identity is missing/);
    assert.equal(exists(w.run.target.execution.provision.workspace.path), false);
});

// A workspace that leaves no room for the CLI's Unix sockets is refused
// before anything is created or staged.
test('L1.workspace-socket-room-refused-early', async t => {
    assert.equal(workspaceSocketProblem('/private/tmp/h/ploinky-hwl-' + 'a'.repeat(32) + '/workspace'), null);
    const long = `/private/tmp/claude-501/${'x'.repeat(120)}/ploinky-hwl-${'a'.repeat(32)}/workspace`;
    assert.match(workspaceSocketProblem(long), /runtime-relay\.sock is \d+ bytes, over the 107-byte limit\. Pin a workspaceParentRoot/);
    // provision: BLOCKED before any process or workspace creation.
    const w = world(t);
    const parent = path.join(w.root, 'p'.repeat(80)); fs.mkdirSync(parent);
    const pins = { ...w.pins, workspaceParentRoot: parent };
    const run = buildConcreteManifest({ block: 'mac-cpu', runId: w.runId, configDigest: hash('config'), casesDigest: hash('cases'), documentSuffix: 'claude', pins,
        candidate: { root: w.source, digest: liveSourceDigest(w.source), revision: 'c'.repeat(40) }, image: IMAGE, ports: { tcp: 23456, udp: 34567 }, unsupported: {} });
    const report = await provisionRun({ run, persist: () => {}, processProvider: w.engineProvider, portProbe: free, hostIdentity: w.hostIdentity, validateProfile });
    assert.equal(report.verdict, 'BLOCKED');
    assert.match(report.limitations[0], /leaves no room for the CLI's Unix sockets/);
    assert.equal(exists(w.statePath), false, 'no engine call');
    assert.equal(exists(run.target.execution.provision.workspace.parent), false);
    // prepare-live: BLOCKED before the candidate is frozen or a manifest written.
    const f = prepareFixture(t);
    const main = await verifyMain();
    const longParent = path.join(f.root, 'q'.repeat(80)); fs.mkdirSync(longParent);
    const runPath = path.join(f.evidence, 'mac-cpu-run_claude.json');
    const args = ['prepare-live', '--config', f.configPath, '--block', 'mac-cpu', '--run', runPath, '--pins', f.pinsFile('pins_long_claude.json', { ...f.macPins, workspaceParentRoot: longParent })];
    if (process.platform !== 'darwin') { await assert.rejects(main(args), /Invalid pins/); return; }
    const before = fs.readdirSync(f.evidence).sort();
    assert.equal(await quiet(() => main(args)), 2);
    assert.deepEqual(fs.readdirSync(f.evidence).sort(), before, 'nothing staged or written');
});

// --- Run artifacts of the remote runner (EV1) -------------------------------
// The runner writes its evidence beside the manifest in the remote run directory: the final GPU
// proof, each case's evidence and captured diagnostics. They must reach the local run directory,
// verified, before a passing cleanup lets the owned staging root go.
async function provisionedStage(t, sshFaults = {}) {
    const w = stagedWorld(t, sshFaults);
    const provisioned = await w.act('provision');
    assert.equal(provisioned.verdict, 'PASS', JSON.stringify(provisioned));
    return w;
}
const remoteRunDirectory = w => path.dirname(w.remoteRun);
const remoteArtifact = (w, part, value) => { const file = path.join(remoteRunDirectory(w), `run_${part}_claude.json`); fs.writeFileSync(file, value, { mode: 0o600 }); return file; };
const localArtifact = (w, part) => path.join(w.evidence, `run_${part}_claude.json`);
// The dispatcher as runLiveCommand calls it, with the staging pieces exposed (a proof the run must have left can be demanded).
function dispatchCleanup(w, extra = {}) {
    const file = path.join(w.evidence, 'authorization_cleanup_claude.json');
    writePrivateJson(file, { schema: 1, runId: w.runId, manifestDigest: hash(fs.readFileSync(w.runPath)), targetDigest: jsonDigest(reload(w).target), action: 'cleanup' });
    return stageAndDispatch({ run: reload(w), bytes: fs.readFileSync(w.runPath), authorizationBytes: fs.readFileSync(file), action: 'cleanup', runPath: w.runPath, processProvider: extra.provider || w.ssh.provider, ...(extra.requiredFor ? { requiredFor: extra.requiredFor } : {}) });
}
// A provider that answers like the fake host, except where `intercept(words, count)` returns a result.
function interposed(w, intercept) {
    const counts = new Map();
    return async (binary, args, options) => {
        const words = args.slice(args.indexOf('100.76.22.69') + 1);
        const key = `${words[0]} ${words.at(-1)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        const replaced = intercept(words, counts.get(key));
        return replaced === undefined ? w.ssh.provider(binary, args, options) : replaced;
    };
}

test('EV1.the-gpu-proof-case-evidence-and-diagnostics-are-kept-byte-identical-before-the-staging-root-is-removed', async t => {
    const w = await provisionedStage(t);
    const proof = remoteArtifact(w, 'gpu-final-observation', `${JSON.stringify({ processes: [], uuid: 'GPU-00000000-0000-0000-0000-000000000000', note: 'unicode é中' }, null, 2)}\n`);
    const evidence = remoteArtifact(w, 'gpu-live-p1', '{"caseId":"LIVE-P1","steps":[]}\n');
    const diagnostics = remoteArtifact(w, 'p1-grant-facts', '{"marker":{"state":"active"},"smi":{"bare":{"status":127}}}\n');
    const before = new Map([['gpu-final-observation', fs.readFileSync(proof)], ['gpu-live-p1', fs.readFileSync(evidence)], ['p1-grant-facts', fs.readFileSync(diagnostics)]]);
    // Things the runner also keeps there, which are never fetched: the authorization binding, a foreign name, an owner marker.
    const authorizations = fs.readdirSync(remoteRunDirectory(w)).filter(name => name.startsWith('authorization_'));
    assert.ok(authorizations.length >= 1);
    const report = await dispatchCleanup(w, { requiredFor: () => ['gpu-final-observation'] });
    assert.equal(report.verdict, 'PASS', JSON.stringify(report));
    assert.equal(report.staging.removed, true); assert.equal(exists(w.remoteRoot), false);
    for (const [part, bytes] of before) {
        const local = localArtifact(w, part);
        assert.deepEqual(fs.readFileSync(local), bytes, `${part} is byte-identical after the remote copy is gone`);
        assert.equal(fs.statSync(local).mode & 0o777, 0o600, part);
        assert.ok(report.artifacts.fetched.some(entry => entry.name === part && entry.sha256 === hash(bytes) && entry.bytes === bytes.length), part);
    }
    assert.equal(report.artifacts.complete, true); assert.deepEqual(report.artifacts.missingRequired, []);
    assert.ok(!w.ssh.calls.some(call => call.words[0] === 'cat' && /\/authorization_/.test(call.words.at(-1))), 'no authorization binding was read');
});

test('EV1.an-interrupted-transfer-is-retried-and-a-failed-one-keeps-the-staging-until-a-retry-succeeds', async t => {
    const w = await provisionedStage(t);
    const proof = remoteArtifact(w, 'gpu-final-observation', '{"processes":[]}\n');
    // One interrupted read of the proof: the bounded retry gets it.
    const flaky = interposed(w, (words, count) => (words[0] === 'cat' && words.at(-1) === proof && count === 1 ? { ...ok(''), settlementForced: true } : undefined));
    const first = await dispatchCleanup(w, { provider: flaky, requiredFor: () => ['gpu-final-observation'] });
    assert.equal(first.verdict, 'PASS', JSON.stringify(first.limitations));
    assert.equal(first.artifacts.complete, true); assert.equal(exists(w.remoteRoot), false);
    assert.deepEqual(fs.readFileSync(localArtifact(w, 'gpu-final-observation')), Buffer.from('{"processes":[]}\n'));
    assert.ok(w.ssh.calls.filter(call => call.words[0] === 'cat' && call.words.at(-1) === proof).length >= 1);
    // A transfer that keeps failing: the evidence is incomplete, the cleanup is not certified and the staging stays.
    const second = await provisionedStage(t);
    const proof2 = remoteArtifact(second, 'gpu-final-observation', '{"processes":[]}\n');
    let reads = 0;
    const dead = interposed(second, words => { if (words[0] === 'cat' && words.at(-1) === proof2) { reads += 1; return { ...ok(''), settlementForced: true }; } return undefined; });
    const failed = await dispatchCleanup(second, { provider: dead, requiredFor: () => ['gpu-final-observation'] });
    assert.equal(reads, ARTIFACT_LIMITS.attempts, 'bounded attempts');
    assert.equal(failed.verdict, 'BLOCKED'); assert.match(failed.limitations.join(' '), /Run evidence is incomplete/);
    assert.equal(failed.staging.removed, false); assert.equal(exists(second.remoteRoot), true, 'the staging root is kept');
    assert.equal(failed.artifacts.complete, false); assert.deepEqual(failed.artifacts.missingRequired, ['gpu-final-observation']);
    // The retry over the same staging, with a healthy transport, fetches the proof and only then removes the root.
    const retry = await dispatchCleanup(second, { requiredFor: () => ['gpu-final-observation'] });
    assert.equal(retry.verdict, 'PASS', JSON.stringify(retry.limitations));
    assert.equal(retry.staging.removed, true); assert.equal(exists(second.remoteRoot), false);
    assert.deepEqual(fs.readFileSync(localArtifact(second, 'gpu-final-observation')), Buffer.from('{"processes":[]}\n'));
});

test('EV1.an-unexpected-name-a-symlink-an-oversized-file-and-a-corrupt-transfer-are-never-copied', async t => {
    const w = await provisionedStage(t);
    const directory = remoteRunDirectory(w);
    const outside = path.join(w.remoteRoot, 'outside.txt'); fs.writeFileSync(outside, 'not an artifact\n');
    fs.symlinkSync(outside, path.join(directory, 'run_linked_claude.json'));
    const big = path.join(directory, 'run_big_claude.json'); fs.writeFileSync(big, ''); fs.truncateSync(big, ARTIFACT_LIMITS.bytes + 1);
    fs.mkdirSync(path.join(directory, 'run_folder_claude.json'));
    for (const name of ['run_Upper_claude.json', 'run_x_claude.json.bak', 'run_x_codex.json', 'other_x_claude.json', 'run_authorization-live_claude.json', 'run_token-file_claude.json', 'notes.txt']) fs.writeFileSync(path.join(directory, name), 'x\n');
    remoteArtifact(w, 'good', '{"ok":true}\n');
    remoteArtifact(w, 'garbled', '{"ok":false}\n');
    // The listing also claims entries a directory cannot hold: an absolute path and a parent reference.
    const lying = interposed(w, words => {
        if (words[0] === 'ls') { const real = fs.readdirSync(directory).sort(); return ok(`${[...real, '/etc/passwd', '../outside.txt', 'a/b_claude.json', ''].join('\n')}`); }
        if (words[0] === 'sha256sum' && words.at(-1).endsWith('run_garbled_claude.json')) return ok(`${'0'.repeat(64)}  ${words.at(-1)}\n`);
        return undefined;
    });
    const report = await dispatchCleanup(w, { provider: lying });
    // 'fixture-start' is the diagnostic the provisioning run itself left; it is allowed and arrives too.
    assert.deepEqual(report.artifacts.fetched.map(entry => entry.name).sort(), ['fixture-start', 'good']);
    assert.deepEqual(report.artifacts.refused.map(entry => [entry.name, entry.reason.replace(/ \(.*/, '').replace(/larger than \d+ bytes/, 'oversized')]).sort(), [['big', 'oversized'], ['folder', 'not a regular file'], ['linked', 'symbolic link']]);
    assert.deepEqual(report.artifacts.failures.map(entry => [entry.name, entry.reason]), [['garbled', 'digest mismatch after transfer']]);
    for (const part of ['linked', 'big', 'folder', 'Upper', 'garbled']) assert.equal(exists(localArtifact(w, part)), false, `${part} was not copied`);
    assert.deepEqual(fs.readdirSync(w.evidence).filter(name => /^run_.+_claude\.json$/.test(name)).sort(), ['run_fixture-start_claude.json', 'run_good_claude.json']);
    for (const call of w.ssh.calls.filter(entry => entry.words[0] === 'cat')) assert.ok(!/outside|linked|big|folder|Upper|bak|codex|authorization|token|notes|passwd/.test(path.basename(call.words.at(-1))) || /run_claude/.test(call.words.at(-1)), call.words.at(-1));
    assert.equal(report.artifacts.complete, false);
    assert.equal(report.staging.removed, false); assert.equal(exists(w.remoteRoot), true, 'a corrupt allowed artifact keeps the staging root');
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations.join(' '), /garbled: digest mismatch after transfer/);
});

test('EV1.a-required-artifact-that-is-missing-keeps-the-staging-and-the-run-is-not-certified', async t => {
    const w = await provisionedStage(t);
    const report = await dispatchCleanup(w, { requiredFor: () => ['gpu-final-observation'] });
    assert.equal(report.verdict, 'BLOCKED'); assert.match(report.limitations.join(' '), /missing required gpu-final-observation/);
    assert.equal(report.staging.removed, false); assert.equal(exists(w.remoteRoot), true);
    assert.equal(report.artifacts.complete, false);
    // The remote cleanup itself passed, so a later retry with the proof present removes the root.
    remoteArtifact(w, 'gpu-final-observation', '{"processes":[]}\n');
    const retry = await dispatchCleanup(w, { requiredFor: () => ['gpu-final-observation'] });
    assert.equal(retry.verdict, 'PASS', JSON.stringify(retry.limitations)); assert.equal(retry.staging.removed, true);
    assert.equal(exists(w.remoteRoot), false);
    assert.ok(exists(localArtifact(w, 'gpu-final-observation')));
});

test('EV1.each-action-names-the-proof-its-pass-needs', () => {
    const gpuProfile = { gpu: { uuid: 'GPU-x' } }; const llmProfile = { gpu: { uuid: 'GPU-x' }, llm: {} };
    assert.deepEqual(requiredArtifacts({ profile: gpuProfile, action: 'cleanup', remoteReport: { verdict: 'PASS' } }), ['gpu-final-observation']);
    assert.deepEqual(requiredArtifacts({ profile: llmProfile, action: 'cleanup', remoteReport: { verdict: 'PASS' } }), ['gpu-final-observation', 'llm-cleanup-proof']);
    assert.deepEqual(requiredArtifacts({ profile: gpuProfile, action: 'provision', remoteReport: { verdict: 'PASS' } }), ['gpu-initial-gate']);
    assert.deepEqual(requiredArtifacts({ profile: gpuProfile, action: 'live', remoteReport: { verdict: 'PASS', cases: [{ id: 'LIVE-P1', result: 'pass' }, { id: 'LIVE-P2', result: 'not-run' }, { id: 'LIVE-P3', result: 'blocked' }] } }), ['gpu-live-p1', 'gpu-live-p3']);
    assert.deepEqual(requiredArtifacts({ profile: gpuProfile, action: 'cleanup', remoteReport: { verdict: 'FAIL' } }), [], 'only a passing result needs proof to be certified');
    assert.deepEqual(requiredArtifacts({ profile: {}, action: 'cleanup', remoteReport: { verdict: 'PASS' } }), [], 'a block without a GPU has no GPU proof');
});
