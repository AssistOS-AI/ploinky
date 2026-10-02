import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { runBoundedProcess } from '../hardware-limits/liveProcess.mjs';
import { parseGpuInventory, requireGpuIdle } from '../hardware-limits/liveGpu.mjs';
import {
    assertWorkspace, executeLiveRun, jsonDigest, readPrivateJson, runLiveCommand,
    validateAuthorization, validateExecutionProfile, liveSourceDigest,
} from '../hardware-limits/liveHarness.mjs';

const hash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const ok = stdout => ({ status: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false, cancelled: false, errorCode: null });
function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-live-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const fixtureHome = path.join(root, 'home'); fs.mkdirSync(fixtureHome);
    const runId = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(workspace, '.ploinky-hwl-owner'), runId);
    const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
    const candidate = path.join(sourceRoot, 'candidate.mjs'); fs.writeFileSync(candidate, '// fixture only\n');
    const engine = path.join(root, 'engine'); fs.writeFileSync(engine, 'fixture\n');
    const node = fs.realpathSync(process.execPath);
    const stat = fs.statSync(workspace); const identity = buildWorkspaceIdentity(workspace);
    const host = { arch: 'test', os: process.platform, hostname: 'test-engine', id: 'engine-id' };
    const box = { id: 'a'.repeat(64), created: '2026-10-01T00:00:00Z', image: 'b'.repeat(64), labels: { [BOX_LABELS.pathHash]: identity.pathHash, [BOX_LABELS.role]: 'box' }, mounts: [], running: true };
    const agents = ['memory', 'cpu', 'pids'].map((role, i) => ({ id: String(i + 1).repeat(64), created: box.created, image: 'c'.repeat(64), role }));
    const profile = {
        protocol: 'owned-fixture-v1', host: { hostname: os.hostname(), platform: process.platform, home: fixtureHome },
        node: { path: node, digest: hash(fs.readFileSync(node)) },
        candidate: { path: candidate, digest: hash(fs.readFileSync(candidate)) },
        engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: jsonDigest(host) },
        source: { root: sourceRoot, digest: liveSourceDigest(sourceRoot) },
        workspace: { path: workspace, uid: stat.uid, dev: String(stat.dev), ino: String(stat.ino), marker: runId },
        box: { id: box.id, created: box.created, image: box.image, contractDigest: jsonDigest({ labels: box.labels, mounts: box.mounts }), pathHash: identity.pathHash, instance: identity.instance },
        agents, cases: ['LIVE-C2'],
    };
    const run = { schema: 1, runId, configDigest: hash('config'), casesDigest: hash('cases'), block: 'mac-cpu', target: { engine: null, ssh: null, execution: profile }, state: 'proposed', workspace: {}, ports: {}, deadlines: {}, images: [], ownedBoxes: [{ id: box.id, created: box.created }], ownedProcesses: [], ownedPaths: [{ path: workspace }], preInventory: { containers: [] }, operations: [{ id: 'fixture-created', state: 'observed', resourceIds: [box.id] }], cleanup: { state: 'not-started', steps: [], failures: [] } };
    const calls = []; let destroyed = false; let active = null; let pressured = false;
    const provider = async (binary, args, options) => {
        calls.push({ binary, args, options });
        if (binary === node) { destroyed = true; return ok(''); }
        if (args[0] === 'info') return ok(JSON.stringify(host));
        if (args.includes('ps')) return ok(destroyed ? '' : box.id + '\n');
        if (args[0] === 'container' && args[1] === 'inspect') return ok(JSON.stringify(box));
        if (args.includes('inspect')) {
            active = agents.find(agent => agent.id === args.at(-1));
            return ok(JSON.stringify({ ...active, running: true, pid: 123, startedAt: "2026-10-01T01:00:00Z", memory: 67108864, memorySwap: 67108864, nanoCpus: 500000000, pidsLimit: 64 }));
        }
        const script = args[args.indexOf('-e') + 1];
        if (script?.includes('const pid=')) { pressured = false; return ok(`0::/ploinky/agents/${active.id}\n`); }
        if (script?.includes('const names=')) return ok(JSON.stringify({ identity: { dev: '1', ino: '23' }, 'memory.max': '67108864\n', 'memory.swap.max': '0\n', 'cpu.max': '50000 100000\n', 'pids.max': '64\n', 'memory.events': `oom_kill ${pressured ? 1 : 0}\n`, 'cpu.stat': `nr_throttled ${pressured ? 1 : 0}\n`, 'pids.events': `max ${pressured ? 1 : 0}\n` }));
        pressured = true;
        await new Promise(resolve => setTimeout(resolve, 2));
        return ok('');
    };
    return { root, workspace, run, profile, box, host, calls, provider };
}

test('HLIVE.authorization-exact-target-action-and-bytes', t => {
    const { run } = fixture(t); const bytes = Buffer.from(JSON.stringify(run));
    const authorization = { schema: 1, runId: run.runId, manifestDigest: hash(bytes), targetDigest: jsonDigest(run.target), action: 'live' };
    assert.doesNotThrow(() => validateAuthorization(run, bytes, authorization, 'live'));
    assert.throws(() => validateAuthorization(run, bytes, authorization, 'cleanup'));
    assert.throws(() => validateAuthorization(run, Buffer.concat([bytes, Buffer.from(' ')]), authorization, 'live'));
    assert.throws(() => validateAuthorization({ ...run, target: {} }, bytes, authorization, 'live'));
});
test('HLIVE.missing-authorization-zero-commands', async t => {
    const { root, run } = fixture(t); const runPath = path.join(root, 'run_codex.json');
    fs.writeFileSync(runPath, JSON.stringify(run), { mode: 0o600 });
    await assert.rejects(runLiveCommand({ runPath, action: 'live', processProvider: () => { throw Error('must not run'); } }), /APPROVAL REQUIRED/);
});
test('HLIVE.profile-rejects-arbitrary-command-and-duplicate-agent', t => {
    const { run } = fixture(t); validateExecutionProfile(run);
    run.target.execution.command = 'rm'; assert.throws(() => validateExecutionProfile(run));
    delete run.target.execution.command;
    run.target.execution.agents[1].id = run.target.execution.agents[0].id;
    assert.throws(() => validateExecutionProfile(run));
});
test('HLIVE.private-evidence-symlink-hardlink-and-permissions', t => {
    const { root } = fixture(t); const file = path.join(root, 'read_codex.json');
    fs.writeFileSync(file, '{}', { mode: 0o600 }); assert.deepEqual(readPrivateJson(file).value, {});
    const link = path.join(root, 'link_codex.json'); fs.symlinkSync(file, link); assert.throws(() => readPrivateJson(link));
    fs.unlinkSync(link); fs.linkSync(file, link); assert.throws(() => readPrivateJson(file));
    fs.unlinkSync(link); fs.chmodSync(file, 0o644); assert.throws(() => readPrivateJson(file));
});
test('HLIVE.workspace-replacement-refuses-before-process', async t => {
    const f = fixture(t); fs.renameSync(f.workspace, f.workspace + '-old'); fs.mkdirSync(f.workspace);
    fs.writeFileSync(path.join(f.workspace, '.ploinky-hwl-owner'), f.run.runId);
    assert.throws(() => assertWorkspace(f.profile));
    await assert.rejects(executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider })); assert.equal(f.calls.length, 0);
});
test('HLIVE.ssh-no-local-fallback', async t => {
    const f = fixture(t); f.run.target.ssh = { alias: 'ubuntu-codex' };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider });
    assert.equal(report.verdict, 'BLOCKED'); assert.equal(f.calls.length, 0);
});
test('HLIVE.engine-service-mismatch-no-pressure-or-destroy', async t => {
    const f = fixture(t); f.profile.engine.identityDigest = hash('wrong');
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider });
    assert.equal(report.verdict, 'FAIL'); assert.equal(f.calls.length, 1); assert.ok(fs.existsSync(f.workspace));
});
test('HLIVE.same-leaf-event-deltas-and-incomplete-block', async t => {
    const f = fixture(t); let persisted = 0;
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider, persist: () => { persisted++; } });
    assert.equal(report.cases.find(value => value.id === 'LIVE-C2').result, 'pass', JSON.stringify(report));
    assert.equal(report.verdict, 'BLOCKED'); assert.equal(report.cleanup.state, 'complete');
    assert.equal(fs.existsSync(f.workspace), false); assert.ok(persisted > 20);
    assert.ok(f.calls.filter(value => value.args.includes('--cgroup-manager=cgroupfs')).every(value => value.args.indexOf('--cgroup-manager=cgroupfs') === value.args.lastIndexOf('podman') + 1));
});
test('HLIVE.no-event-delta-is-failure-with-cleanup', async t => {
    const f = fixture(t);
    const provider = async (...args) => {
        const result = await f.provider(...args);
        if (args[1].some(arg => arg.includes('const names='))) result.stdout = result.stdout.replace(/\\n/g, '\\n').replace(/1\\n/g, '0\\n');
        return result;
    };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: provider });
    assert.equal(report.verdict, 'FAIL'); assert.equal(report.cleanup.state, 'complete');
});
test('HLIVE.destroy-failure-preserves-workspace-and-original-error', async t => {
    const f = fixture(t);
    const provider = async (binary, args, options) => {
        if (binary === f.profile.node.path) return { ...ok(''), status: 1 };
        const result = await f.provider(binary, args, options);
        if (args.some(arg => arg.includes('const names='))) result.stdout = '{}';
        return result;
    };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: provider });
    assert.equal(report.verdict, 'FAIL'); assert.ok(report.limitations.length); assert.equal(report.cleanup.state, 'failed');
    assert.ok(report.cleanup.failures.length); assert.ok(fs.existsSync(f.workspace));
});
test('HLIVE.foreign-replacement-blocks-cleanup-deletion', async t => {
    const f = fixture(t); const foreign = 'd'.repeat(64); let destroyed = false;
    const provider = async (binary, args, options) => {
        if (binary === f.profile.node.path) { destroyed = true; return ok(''); }
        if (destroyed && args.includes('ps')) return ok(foreign);
        if (destroyed && args.includes('inspect')) return ok(JSON.stringify({ ...f.box, id: foreign }));
        return f.provider(binary, args, options);
    };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, action: 'cleanup', processProvider: provider });
    assert.equal(report.verdict, 'FAIL'); assert.ok(fs.existsSync(f.workspace));
});
test('HLIVE.cleanup-resumes-after-exact-box-already-absent', async t => {
    const f = fixture(t);
    const provider = async (binary, args, options) => args.includes('ps') ? ok('') : f.provider(binary, args, options);
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, action: 'cleanup', processProvider: provider });
    assert.equal(report.verdict, 'PASS'); assert.equal(fs.existsSync(f.workspace), false);
    assert.ok(!f.calls.some(value => value.binary === f.profile.node.path));
});
test('HLIVE.transport-timeout-output-bound-and-cancel', async t => {
    const { root } = fixture(t); const env = { PATH: process.env.PATH };
    const timeout = await runBoundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, env, deadlineMs: 20 });
    assert.equal(timeout.timedOut, true);
    const overflow = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { cwd: root, env, maxBytes: 128 });
    assert.equal(overflow.truncated, true); assert.ok(overflow.stdout.length <= 128);
    const controller = new AbortController(); controller.abort();
    const cancel = await runBoundedProcess(process.execPath, [], { cwd: root, env, signal: controller.signal, spawnProcess: () => { throw Error('must not spawn'); } });
    assert.equal(cancel.cancelled, true);
});

const uuid = 'GPU-01234567-1234';
const xml = rows => `<nvidia_smi_log><gpu id="0000"><uuid>${uuid}</uuid><compute_mode>Default</compute_mode><processes>${rows}</processes></gpu></nvidia_smi_log>`;
const processXml = (pid, type) => `<process_info><pid>${pid}</pid><type>${type}</type></process_info>`;
test('HLIVE.gpu-graphics-busy-and-unknown-activity-block', async () => {
    await assert.rejects(requireGpuIdle({ query: async () => ok(xml(processXml(123, 'G'))), expectedUuid: uuid, initial: true }), /gpu_busy/);
    assert.throws(() => parseGpuInventory(ok(xml('N/A')), uuid));
    assert.throws(() => parseGpuInventory(ok(xml('').replace('Default', 'Exclusive_Process')), uuid));
    assert.throws(() => parseGpuInventory(ok(xml('').replace(uuid, 'GPU-87654321-1234')), uuid));
});
test('HLIVE.gpu-owned-pid-exact-and-reuse-proof', async () => {
    const record = { hostPid: 12, startIdentity: 'start', bootId: 'boot', role: 'mps-client' };
    const settings = { expectedUuid: uuid, owned: [record], bootId: 'boot', boxCgroupPrefix: '/owned', observe: async () => ({ ...record, cgroup: '/owned/client' }) };
    await requireGpuIdle({ ...settings, query: async () => ok(xml(processXml(12, 'C'))) });
    await assert.rejects(requireGpuIdle({ ...settings, query: async () => ok(xml(processXml(123, 'C'))) }), /gpu_busy/);
    await assert.rejects(requireGpuIdle({ ...settings, query: async () => ok(xml(processXml(12, 'C'))), observe: async () => ({ ...record, startIdentity: 'reused', cgroup: '/owned/client' }) }), /provenance/);
});

test('HLIVE.source-drift-blocks-before-process', async t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.profile.source.root, 'import.mjs'), '// changed');
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: f.provider });
    assert.equal(report.verdict, 'BLOCKED'); assert.equal(f.calls.length, 0);
});
test('HLIVE.leaf-inode-change-cannot-prove-enforcement', async t => {
    const f = fixture(t); let observations = 0;
    const provider = async (...args) => {
        const result = await f.provider(...args);
        if (args[1].some(arg => arg.includes('const names='))) {
            const leaf = JSON.parse(result.stdout); leaf.identity.ino = String(++observations); result.stdout = JSON.stringify(leaf);
        }
        return result;
    };
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, processProvider: provider });
    assert.equal(report.verdict, 'FAIL'); assert.match(report.cases.find(row => row.id === 'LIVE-C2').reason, /identity changed/);
});
test('HLIVE.host-state-left-behind-prevents-workspace-deletion', async t => {
    const f = fixture(t); const directory = path.join(f.profile.host.home, '.ploinky-box', 'hardware-limits');
    fs.mkdirSync(directory, { recursive: true }); const record = path.join(directory, f.profile.box.instance + '.json');
    fs.writeFileSync(record, '{}'); t.after(() => fs.rmSync(record, { force: true }));
    const report = await executeLiveRun({ run: f.run, hostIdentity: f.profile.host, action: 'cleanup', processProvider: f.provider });
    assert.equal(report.verdict, 'FAIL'); assert.ok(fs.existsSync(f.workspace));
    assert.match(report.cleanup.failures[0], /host state/);
});
