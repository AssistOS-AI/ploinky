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
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { writePrivateJson } from '../hardware-limits/fixtures.mjs';
import { executeCleanupRun, jsonDigest, liveSourceDigest, runLiveCommand, validateExecutionProfile, validateProfile } from '../hardware-limits/liveHarness.mjs';
import { FIXTURE_REPOSITORY, fixtureContainerName, provisionRun } from '../hardware-limits/liveFixture.mjs';
import { buildConcreteManifest, summaryPathFor } from '../hardware-limits/liveManifest.mjs';
import { writeUstar } from '../hardware-limits/liveStage.mjs';
import { hostRecordPaths, quarantinePath } from '../hardware-limits/liveCommon.mjs';
import { CRASH_EXIT, createFakeSsh, createFakeWorld, ok, worldState } from '../hardware-limits/fakeLiveEngine.mjs';

const hash = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const REPO = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const CHILD = path.join(REPO, 'tests', 'hardware-limits', 'fakeLiveChild.mjs');
const ENGINE_HOST = { arch: 'test', os: 'linux', hostname: 'fake-engine', id: 'engine-1' };
const IMAGE = `docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}`;
const BOX_IMAGE = `docker.io/assistos/ploinky-box@sha256:${'b'.repeat(64)}`;
const UNRELATED = [{ id: 'e'.repeat(64), created: '2026-09-01T00:00:00Z', image: 'f'.repeat(64), labels: {}, mounts: [{ Source: '/elsewhere' }] }];
const free = async () => ({ tcp: true, udp: true });
const exists = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

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
function world(t, { block = 'mac-cpu', platform = null, stagedRoot = true, faults = {} } = {}) {
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
    const parentRoot = directory('tmp');
    const node = fs.realpathSync(process.execPath);
    const hostIdentity = remote ? { hostname: 'apparatus', platform: 'linux', home } : { hostname: os.hostname(), platform: platform || process.platform, home };
    const pins = {
        schema: 1, host: hostIdentity, node: { path: node, digest: hash(fs.readFileSync(node)) },
        engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: jsonDigest(ENGINE_HOST) }, boxImage: BOX_IMAGE,
        ...(remote ? { ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '100.76.22.69', hostKeyAlias: '192.168.1.63', user: 'skutner', knownHosts, identityFile: null } } : { workspaceParentRoot: parentRoot }),
    };
    const runId = crypto.randomBytes(16).toString('hex');
    const candidate = { root: source, digest: liveSourceDigest(source), revision: 'c'.repeat(40) };
    if (remote) {
        const payloadPath = path.join(evidence, `candidate-${runId}.tar`);
        candidate.payload = { path: payloadPath, ...writeUstar(source, payloadPath) };
    }
    const run = buildConcreteManifest({
        block, runId, configDigest: hash('config'), casesDigest: hash('cases'), documentSuffix: 'claude', pins, candidate, image: IMAGE,
        ports: { tcp: 23456, udp: 34567 }, unsupported: {},
    });
    const remoteRoot = remote ? run.target.stage.root : null;
    if (remote && stagedRoot) {
        fs.mkdirSync(remoteRoot, { recursive: true }); fs.chmodSync(remoteRoot, 0o700);
        fs.writeFileSync(path.join(remoteRoot, '.ploinky-hwl-owner'), runId, { mode: 0o600 });
        fs.cpSync(source, path.join(remoteRoot, 'source'), { recursive: true });
    }
    const runPath = path.join(evidence, 'run_claude.json');
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
        assert.deepEqual(manifest.llmRuntime.runtimePolicy.resources, { memory: '64m', cpus: '0.5', pidsLimit: 64 });
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
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.evidence, 'report_provision_codex.json'))).verdict, 'PASS');
    // The provisioned manifest needs a new binding for live: the old one no longer matches.
    await assert.rejects(runLiveCommand({ runPath: w.runPath, authorizationPath, action: 'provision', processProvider: w.engineProvider }), /authorization binding/);
    reload(w); assert.equal((await cleanup(w)).verdict, 'PASS');
});

// --- Remote staging -------------------------------------------------------

function stagedWorld(t, sshFaults = {}) {
    const w = world(t, { block: 'apparatus-cpu', stagedRoot: false });
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
        const file = path.join(w.evidence, `authorization_${action}_claude.json`);
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
function prepareFixture(t) {
    const root = scratch(t);
    const ploinky = path.join(root, 'ploinky');
    fs.mkdirSync(path.join(ploinky, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// candidate\n');
    fs.mkdirSync(path.join(ploinky, 'tests', 'hardware-limits'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'tests', 'hardware-limits', 'verify.mjs'), '// runner\n');
    const revision = gitRepo(ploinky);
    const explorer = path.join(root, 'explorer'); fs.mkdirSync(path.join(explorer, 'explorer'), { recursive: true });
    fs.writeFileSync(path.join(explorer, 'explorer', 'manifest.json'), `{\n    "container": "${IMAGE}",\n    "lite-sandbox": true\n}\n`);
    const dependency = path.join(root, 'deps', 'smalldep'); fs.mkdirSync(dependency, { recursive: true }); fs.writeFileSync(path.join(dependency, 'index.js'), 'export default 1;\n');
    const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence, { mode: 0o700 });
    const casesPath = path.join(evidence, 'cases_claude.json'); writePrivateJson(casesPath, { schema: 1, cases: [] });
    const entry = candidateRoot => ({ baselineRevision: '0'.repeat(40), baselineExport: root, baselineStage: null, candidateRoot, sourceDigest: hash('x'), instructionDigests: {} });
    const config = {
        schema: 1, runId: crypto.randomBytes(16).toString('hex'), createdAt: new Date().toISOString(), documentSuffix: 'claude',
        node: { absoluteExecutable: fs.realpathSync(process.execPath), version: process.version },
        repos: { ploinky: entry(ploinky), explorer: entry(explorer), localLlms: entry(root), images: { ...entry(null), candidateRoot: null } },
        dependencies: [{ name: 'smalldep', realpath: dependency, revision: null, treeDigest: treeDigestOf(dependency) }],
        evidenceRoot: evidence, casesPath, casesDigest: hash(fs.readFileSync(casesPath)), engine: null, ssh: null,
    };
    const configPath = path.join(evidence, 'config_claude.json'); writePrivateJson(configPath, config);
    const engine = path.join(root, 'podman'); fs.writeFileSync(engine, 'fake engine\n');
    const parentRoot = path.join(root, 'tmp'); fs.mkdirSync(parentRoot);
    const node = fs.realpathSync(process.execPath);
    const macPins = {
        schema: 1, host: { hostname: os.hostname(), platform: process.platform, home: fs.realpathSync(os.homedir()) },
        node: { path: node, digest: hash(fs.readFileSync(node)) }, engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: jsonDigest(ENGINE_HOST) },
        boxImage: BOX_IMAGE, workspaceParentRoot: parentRoot, ports: { tcp: 24680, udp: 35791 },
    };
    const ssh = path.join(root, 'ssh'); fs.writeFileSync(ssh, 'fake ssh\n');
    const knownHosts = path.join(root, 'known_hosts'); fs.writeFileSync(knownHosts, '192.168.1.63 ssh-ed25519 AAAAfixture\n');
    const apparatusPins = {
        schema: 1, host: { hostname: 'apparatus', platform: 'linux', home: '/home/skutner' },
        node: { path: '/usr/bin/node', digest: hash('remote node') }, engine: { path: '/usr/bin/podman', digest: hash('remote podman'), identityDigest: jsonDigest(ENGINE_HOST) },
        boxImage: BOX_IMAGE, ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '100.76.22.69', hostKeyAlias: '192.168.1.63', user: 'skutner', knownHosts, identityFile: null },
    };
    const pinsFile = (name, value) => { const file = path.join(evidence, name); writePrivateJson(file, value); return file; };
    return { root, ploinky, revision, evidence, configPath, macPins, apparatusPins, pinsFile };
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
    const summary = fs.readFileSync(summaryPathFor(runPath), 'utf8');
    assert.equal(summaryPathFor(runPath), path.join(f.evidence, 'mac-cpu-run_summary_claude.md'));
    for (const text of ['Nothing has run', 'TCP 24680', 'UDP 35791', profile.provision.workspace.path, 'memory 64m, cpus 0.5, pids 64', BOX_IMAGE, IMAGE,
        'destroy --delete-cache', 'LIVE-C3 | not run', f.revision, os.hostname()]) assert.ok(summary.includes(text), text);
    assert.equal(fs.statSync(runPath).mode & 0o077, 0); assert.equal(fs.statSync(summaryPathFor(runPath)).mode & 0o077, 0);
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
    const summary = fs.readFileSync(summaryPathFor(runPath), 'utf8');
    for (const text of ['skutner@100.76.22.69', 'HostKeyAlias 192.168.1.63', root, 'LIVE-A1 | executed', 'fetched remote cleanup PASS']) assert.ok(summary.includes(text), text);
});

test('L1.prepare-live-other-blocks-stay-unsupported', async t => {
    const f = prepareFixture(t);
    const main = await verifyMain();
    for (const block of ['mac-adversarial', 'mac-explorer', 'apparatus-mps', 'apparatus-local-llm', 'apparatus-vllm']) {
        const runPath = path.join(f.evidence, `${block}-run_claude.json`);
        assert.equal(await main(['prepare-live', '--config', f.configPath, '--block', block, '--run', runPath]), 0);
        const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
        assert.match(run.target.note, /^Unsupported block/); assert.equal(run.target.execution, undefined);
        assert.ok(Object.keys(run.target.unsupported).length > 0);
        assert.equal(exists(summaryPathFor(runPath)), false);
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
