// Conservative collection (P2e): every required root is retained, only
// proven-unreferenced owned objects are removed, and unknown evidence skips.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createCacheStore } from '../../cli/utils/dependencies/store/objectStore.mjs';
import { buildAgentInstallPlan, buildSeedInstallPlan } from '../../cli/utils/dependencies/store/installContract.mjs';
import { collectDependencyObjects, engineMountInspector } from '../../cli/utils/dependencies/store/collector.mjs';
import { installFakeEngine } from './dependencyStoreFakeEngine.mjs';
import {
    currentWriterIdentity,
    defaultProveBuildQuiescent,
    defaultProveReaderQuiescent,
    readBootScope,
} from '../../cli/utils/dependencies/store/receipts.mjs';
import { fakeInstaller, fakeLease, hostProvider, makeAgentLib, tempRoot } from './dependencyStoreFixtures.mjs';

const GLOBAL = Object.freeze({ name: 'g', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } });

function deadProcessIdentity() {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    return { pid: Number(child.stdout), processStart: 'gone', bootScope: readBootScope() };
}

function world(t, { root = tempRoot(t, 'depstore-gc-') } = {}) {
    const agentLib = makeAgentLib(root);
    const provider = hostProvider({ agentLib });
    const { lease, assertLease } = fakeLease();
    const containers = new Set();
    const inspectContainer = ({ name }) => (containers.has(name) ? 'present' : 'absent');
    const store = createCacheStore({
        depsDir: path.join(root, '.ploinky', 'deps'),
        workspaceRoot: root,
        assertLease,
        checkDiskSpace: () => ({ ok: true }),
        proveReaderQuiescent: (receipt) => defaultProveReaderQuiescent(receipt, { inspectContainer }),
        proveBuildQuiescent: (receipt) => defaultProveBuildQuiescent(receipt, { inspectContainer }),
    });
    const installer = fakeInstaller();
    const plan = (registration, extra = {}) => buildAgentInstallPlan({
        provider, globalPackage: GLOBAL, registration, agentLibSelection: agentLib,
        agentPackage: { selection: 'code', relativePath: `${registration}/code/package.json`, sha256: 'f'.repeat(64), manifest: { name: registration, dependencies: { dep: extra.version || '1.0.0' } } },
        ...extra.plan,
    });
    const build = (registration, consumer, extra = {}) => store.ensureGeneration(lease, plan(registration, extra), { installer, consumer: { phase: 'created', ...consumer } });
    const seedPlan = buildSeedInstallPlan({ provider, globalPackage: GLOBAL, agentLibSelection: agentLib });
    const state = { agents: {}, mounts: [], engine: true, edge: { selector: 'active', preparationOutstanding: false } };
    const collect = (overrides = {}) => collectDependencyObjects({
        lease,
        store,
        workspaceRoot: root,
        depsDir: path.join(root, '.ploinky', 'deps'),
        assertLease,
        loadAgents: () => state.agents,
        inspectMounts: () => (state.engine ? { available: true, mounts: state.mounts } : { available: false, reason: 'engine down' }),
        readEdgeState: () => state.edge,
        ...overrides,
    });
    return { root, store, lease, installer, build, seedPlan, state, containers, collect, provider, agentLib };
}

const admittedRecord = (generation, runtime = 'podman') => ({
    type: 'agent', runtime,
    dependencies: { schema: 1, mode: 'store', objectId: generation.objectId, inputKey: generation.inputKey, generationId: generation.generationId,
        payloadPath: generation.payloadPath, nodeModulesPath: generation.nodeModulesPath },
    config: { binds: [{ source: generation.nodeModulesPath, target: '/code/node_modules', ro: true }] },
});

test('dependency store collection retains every required root and removes only proven-unreferenced objects', (t) => {
    const w = world(t);
    const liveProcess = currentWriterIdentity();
    const admitted = w.build('reg-admitted', { kind: 'container', containerName: 'agent_a', engine: 'podman', key: 'a' });
    w.containers.add('agent_a');
    w.state.agents.agent_a = admittedRecord(admitted);
    const stopped = w.build('reg-stopped', { kind: 'container', containerName: 'agent_stopped', engine: 'podman', key: 's' });
    w.state.mounts.push(stopped.nodeModulesPath);
    const attached = w.build('reg-attached', { kind: 'bwrap-attachment', process: liveProcess });
    const detached = w.build('reg-detached', { kind: 'seatbelt-attachment', process: deadProcessIdentity() });
    const failedCandidate = w.build('reg-failed', { kind: 'container', containerName: 'agent_failed__candidate_0123456789ab', engine: 'podman', key: 'f' });
    const seed = w.store.ensureGeneration(w.lease, w.seedPlan, { installer: w.installer, consumer: { kind: 'seed-copy', process: deadProcessIdentity() } });
    const reused = w.build('reg-pid-reuse', { kind: 'bwrap-service', process: { ...liveProcess, processStart: 'another-process' } });
    w.state.agents.agent_reused = admittedRecord(reused, 'bwrap');
    // A paused no-wait builder: its writer is alive and its object incomplete.
    const pausedId = '12345678-1234-4234-8234-123456789abc';
    fs.mkdirSync(path.join(w.store.paths.objects, pausedId, 'payload'), { recursive: true });
    fs.writeFileSync(path.join(w.store.paths.buildReceipts, `${pausedId}.json`), JSON.stringify({
        receiptId: pausedId, token: 't', state: 'building', installer: { kind: 'container-npm', containerName: 'ploinky-deps-x' },
        installerStarted: true, writer: liveProcess,
    }));

    const report = w.collect();
    assert.equal(report.skipped, null, JSON.stringify(report));
    const retainedIds = new Map(report.retained.map((item) => [item.objectId, item.reasons]));
    assert.ok(retainedIds.get(admitted.objectId)?.includes('admitted-record'));
    assert.ok(retainedIds.get(stopped.objectId)?.includes('container-mount'), 'stopped predecessor retained by its actual mount');
    assert.ok(retainedIds.get(attached.objectId)?.includes('reader:bwrap-attachment'), 'live attachment retained');
    assert.ok(retainedIds.get(seed.objectId)?.includes('seed-index'), 'needed seed retained');
    assert.ok(retainedIds.get(reused.objectId)?.includes('admitted-record'), 'PID reuse ends the receipt, but the admitted record still roots the object');
    assert.ok(retainedIds.get(pausedId)?.includes('build-writer-unproven'), 'paused builder retained');
    assert.deepEqual(report.removed.sort(), [detached.objectId, failedCandidate.objectId].sort());
    for (const id of report.removed) assert.equal(fs.existsSync(path.join(w.store.paths.objects, id)), false);
    assert.equal(w.store.readIndex(failedCandidate.inputKey), null, 'index entries of removed objects are removed');
    assert.ok(fs.existsSync(admitted.payloadPath));
    assert.ok(report.retainedBytesByReason['admitted-record'] > 0);
    assert.equal(w.store.listReaderReceipts().some((receipt) => receipt.objectId === detached.objectId), false);
    assert.equal(w.store.listReaderReceipts().some((receipt) => receipt.consumer?.process?.processStart === 'another-process'), false);
});

test('dependency store collection skips entirely on unavailable or unresolved evidence', (t) => {
    const w = world(t);
    const orphan = w.build('reg-orphan', { kind: 'container', containerName: 'gone', engine: 'podman', key: 'o' });
    w.state.agents.other = { type: 'agent', runtime: 'podman', config: { binds: [] } };
    w.state.engine = false;
    assert.match(w.collect().skipped, /engine unavailable/);
    w.state.engine = true;
    w.state.edge = { selector: 'inactive', preparationOutstanding: false };
    assert.match(w.collect().skipped, /selector is inactive/);
    w.state.edge = { selector: 'active', preparationOutstanding: true };
    assert.match(w.collect().skipped, /preparation is outstanding/);
    w.state.edge = { selector: 'active', preparationOutstanding: false };
    assert.match(w.collect({ loadAgents: () => { throw new Error('corrupt'); } }).skipped, /registry unreadable/);
    const candidates = path.join(w.root, '.ploinky', 'run', 'runtime-candidates');
    fs.mkdirSync(candidates, { recursive: true });
    fs.writeFileSync(path.join(candidates, 'broken.json'), '{');
    assert.match(w.collect().skipped, /runtime candidate broken\.json unreadable/);
    assert.ok(fs.existsSync(orphan.payloadPath), 'nothing was removed while evidence was uncertain');
    // A readable durable candidate (a missing registry record) roots its object.
    fs.writeFileSync(path.join(candidates, 'broken.json'), JSON.stringify({ registryRecord: admittedRecord(orphan) }));
    const report = w.collect();
    assert.equal(report.skipped, null);
    assert.ok(report.retained.find((item) => item.objectId === orphan.objectId).reasons.includes('admitted-record'));
});

test('dependency store collection requires the workspace lease', (t) => {
    const w = world(t);
    assert.throws(() => w.collect({ lease: { forged: true } }), { code: 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED' });
});

test('dependency store collection retains precreation reservations even if the future container is absent', (t) => {
    const w = world(t);
    const pending = w.build('pending', { kind: 'container', engine: 'podman', containerName: 'not-created', phase: 'creating' });
    const receipt = w.store.listReaderReceipts().find(item => item.objectId === pending.objectId);
    assert.equal(receipt.writer.pid, process.pid, 'the creating owner is still alive');
    assert.equal(defaultProveReaderQuiescent(receipt, { inspectContainer: () => 'absent' }).quiescent, false);
    assert.equal(defaultProveReaderQuiescent({ ...receipt, writer: deadProcessIdentity() }, { inspectContainer: () => 'absent' }).quiescent, false,
        'launcher death does not prove that its engine client cannot still create the container');
    assert.equal(w.collect().removed.includes(pending.objectId), false);
    assert.ok(fs.existsSync(pending.payloadPath));
});

test('dependency store collection does not infer absent containers from an empty registry and unavailable engine', (t) => {
    const w = world(t);
    const orphan = w.build('reg-orphan', { kind: 'container', containerName: 'gone', engine: 'podman', key: 'o', containerId: 'd'.repeat(64) });
    w.state.engine = false;
    const report = w.collect();
    assert.match(report.skipped, /engine unavailable/);
    assert.deepEqual(report.removed, []);
    assert.ok(fs.existsSync(orphan.payloadPath));
});

test('dependency store attachment pinning requires the lease and a new pin prevents any object rename', (t) => {
    const w = world(t);
    const orphan = w.build('orphan', { kind: 'container', engine: 'podman', containerName: 'gone' });
    assert.throws(() => w.store.acquireAttachmentReceipt({}, orphan, { kind: 'bwrap-attachment' }),
        { code: 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED' });
    const directory = path.join(w.store.paths.objects, orphan.objectId);
    const rename = fs.renameSync;
    let moved = false;
    let handle;
    try {
        fs.renameSync = (from, to) => {
            if (from === directory) moved = true;
            return rename(from, to);
        };
        const report = w.collect({ hooks: { beforeTombstone() {
            handle = w.store.acquireAttachmentReceipt(w.lease, orphan, { kind: 'bwrap-attachment', process: currentWriterIdentity() });
        } } });
        assert.deepEqual(report.removed, []);
        assert.equal(moved, false, 'a validated consumer never sees a temporarily missing payload');
    } finally {
        fs.renameSync = rename;
        if (handle) w.store.releaseReaderReceipt(handle);
    }
});

test('dependency store collection touches only the exact store objects, even when the workspace path contains a store segment', (t) => {
    const outer = tempRoot(t, 'depstore-gc-segment-');
    const root = path.join(outer, 'x', 'store', 'ws');
    fs.mkdirSync(root, { recursive: true });
    const w = world(t, { root });
    const deps = path.join(root, '.ploinky', 'deps');
    assert.equal(w.store.paths.objects, path.join(deps, 'store', 'objects'));
    // Directories and files that are not store objects are unknown to Ploinky.
    const foreign = [
        path.join(deps, 'global', 'container-linux-x64-glibc-node20', 'node_modules', 'x', 'index.js'),
        path.join(deps, 'agents', 'repo', 'a', 'container-linux-x64-glibc-node20', 'stamp.json'),
        path.join(deps, 'store-old', 'objects', '12345678-1234-4234-8234-123456789abc', 'payload', 'kept.txt'),
        path.join(deps, 'user-notes.txt'),
        path.join(outer, 'x', 'store', 'objects', '12345678-1234-4234-8234-123456789abd', 'payload', 'kept.txt'),
        path.join(outer, 'x', 'store', 'sibling.txt'),
    ];
    for (const file of foreign) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'keep');
    }
    const bound = w.build('reg-bound', { kind: 'container', containerName: 'bound', engine: 'podman', key: 'b', containerId: 'b'.repeat(64) });
    w.state.agents.bound = { type: 'agent', runtime: 'podman', config: { binds: [{ source: bound.nodeModulesPath, target: '/code/node_modules', ro: true }] } };
    const mounted = w.build('reg-mounted', { kind: 'container', containerName: 'mounted', engine: 'podman', key: 'm', containerId: 'c'.repeat(64) });
    w.state.mounts.push(mounted.nodeModulesPath);
    const orphan = w.build('reg-orphan', { kind: 'container', containerName: 'gone', engine: 'podman', key: 'o', containerId: 'd'.repeat(64) });
    const report = w.collect();
    assert.equal(report.skipped, null, JSON.stringify(report));
    assert.deepEqual(report.removed, [orphan.objectId], 'collection ran and removed only the unreferenced store object');
    const retained = new Map(report.retained.map((item) => [item.objectId, item.reasons]));
    assert.deepEqual(retained.get(bound.objectId), ['registry-bind']);
    assert.deepEqual(retained.get(mounted.objectId), ['container-mount']);
    assert.ok(fs.existsSync(bound.payloadPath) && fs.existsSync(mounted.payloadPath));
    for (const file of foreign) assert.equal(fs.readFileSync(file, 'utf8'), 'keep', `${file} is preserved`);
    assert.deepEqual(Object.keys(report).sort(), ['removed', 'retained', 'retainedBytesByReason', 'skipped']);
});

test('dependency store collection restores an object an attachment adopted just before deletion', (t) => {
    const w = world(t);
    const orphan = w.build('reg-orphan', { kind: 'container', containerName: 'gone', engine: 'podman', key: 'o' });
    let attached = null;
    const report = w.collect({
        hooks: {
            beforeTombstone(objectId) {
                if (objectId !== orphan.objectId) return;
                // A lease-owning callback pins before deletion. The collector
                // must never rename a newly pinned object, even temporarily.
                attached = w.store.acquireAttachmentReceipt(w.lease, orphan, { kind: 'seatbelt-attachment', process: currentWriterIdentity() });
            },
        },
    });
    assert.ok(attached, 'the attachment validated successfully before the tombstone');
    assert.deepEqual(report.removed, []);
    assert.ok(fs.existsSync(orphan.payloadPath), 'restored from its tombstone');
    assert.equal(w.store.validateObject(orphan.objectId, { inputKey: orphan.inputKey }).valid, true);
    assert.equal(fs.readdirSync(w.store.paths.objects).some((name) => name.startsWith('.tombstone-')), false);
    w.store.releaseReaderReceipt(attached);
    // An attachment arriving after the tombstone fails closed and leaves no receipt.
    let failure = null;
    const second = w.collect({
        hooks: {
            beforeTombstone() {},
        },
        inspectMounts: () => ({ available: true, mounts: [] }),
    });
    assert.deepEqual(second.removed, [orphan.objectId]);
    try { w.store.acquireAttachmentReceipt(w.lease, orphan, { kind: 'bwrap-attachment', process: currentWriterIdentity() }); } catch (error) { failure = error; }
    assert.equal(failure?.code, 'PLOINKY_DEPS_GENERATION_INVALID');
    assert.equal(w.store.listReaderReceipts().length, 0);
});

test('dependency store collection finishes or restores leftover tombstones from a crash', (t) => {
    const w = world(t);
    const kept = w.build('reg-kept', { kind: 'bwrap-attachment', process: currentWriterIdentity() });
    const gone = w.build('reg-gone', { kind: 'bwrap-attachment', process: deadProcessIdentity() });
    fs.renameSync(path.join(w.store.paths.objects, kept.objectId), path.join(w.store.paths.objects, `.tombstone-${kept.objectId}-0badcafe`));
    fs.renameSync(path.join(w.store.paths.objects, gone.objectId), path.join(w.store.paths.objects, `.tombstone-${gone.objectId}-0badcafe`));
    w.store.listReaderReceipts().filter((receipt) => receipt.objectId === gone.objectId)
        .forEach((receipt) => fs.rmSync(path.join(w.store.paths.readerReceipts, `${receipt.receiptId}.json`)));
    w.collect();
    assert.ok(fs.existsSync(kept.payloadPath), 'a receipt-backed tombstone is restored');
    assert.equal(fs.readdirSync(w.store.paths.objects).some((name) => name.startsWith('.tombstone-')), false);
});

test('dependency store collection inspects every engine container, including stopped and unlabeled ones', (t) => {
    const root = tempRoot(t, 'depstore-inspector-');
    const engine = installFakeEngine(root, { engines: ['podman'] });
    const depsDir = path.join(root, 'ws', '.ploinky', 'deps');
    fs.writeFileSync(engine.stateFile, JSON.stringify({ installs: [], containers: {
        running: { Id: 'a'.repeat(64), Name: 'running', Labels: { managed: '1' }, State: { Running: true }, Mounts: [{ Source: path.join(depsDir, 'store', 'objects', 'x', 'payload', 'node_modules') }] },
        stopped: { Id: 'b'.repeat(64), Name: 'stopped', Labels: {}, State: { Running: false }, Mounts: [{ Source: path.join(depsDir, 'store', 'objects', 'y', 'payload', 'node_modules') }, { Source: '/elsewhere' }] },
    } }));
    const spawn = (command, args, options) => spawnSync(command, args, { ...options, env: { ...process.env, ...engine.env } });
    const inspect = engineMountInspector({ getRuntime: () => path.join(engine.binDir, 'podman'), depsDir, spawn });
    const result = inspect();
    assert.equal(result.available, true);
    assert.equal(result.containers, 2);
    assert.deepEqual(result.mounts.sort(), [
        path.join(depsDir, 'store', 'objects', 'x', 'payload', 'node_modules'),
        path.join(depsDir, 'store', 'objects', 'y', 'payload', 'node_modules'),
    ].sort());
    const failingList = engineMountInspector({ getRuntime: () => 'podman', depsDir, spawn: () => ({ status: 125 }) })();
    assert.equal(failingList.available, false);
    let call = 0;
    const failingInspect = engineMountInspector({ getRuntime: () => 'podman', depsDir, spawn: () => (++call === 1 ? { status: 0, stdout: 'abc\n' } : { status: 125 }) })();
    assert.equal(failingInspect.available, false);
    assert.equal(engineMountInspector({ getRuntime: () => { throw new Error('none'); }, depsDir })().available, false);
});

test('dependency store collection retains a superseded seed while a live seed copy reads it', (t) => {
    const w = world(t);
    const superseded = w.store.ensureGeneration(w.lease, w.seedPlan, { installer: w.installer, consumer: { kind: 'seed-copy', process: currentWriterIdentity() } });
    // Supersede the index entry (as a changed seed key would).
    fs.rmSync(path.join(w.store.paths.index, `${superseded.inputKey}.json`));
    const report = w.collect();
    assert.ok(report.retained.find((item) => item.objectId === superseded.objectId)?.reasons.includes('reader:seed-copy'));
    assert.ok(fs.existsSync(superseded.payloadPath));
});
