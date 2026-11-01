import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reserveAgentCgroup, verifyAgentCgroupSubtree, cleanupOwnedContainerCgroup,
    waitForAgentCgroupSubtree, CGROUP_ENTRYPOINT, CGROUP_HELPER_DIRECTORY, CGROUP_HELPER_SOURCE, CGROUP_SUBTREE_PATH } from '../../cli/sandbox/cgroupSubtree.mjs';
import { readRuntimeCandidate, writeRuntimeCandidate, commitRuntimeCandidateCgroup } from '../../cli/sandbox/runtimeCandidateStore.js';
import { removeExactContainerAndDescriptor } from '../../cli/sandbox/docker/containerFleet.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';
import { preparedCgroupFs } from '../hardware-limits/fakeCgroupFs.mjs';

const ID = 'a'.repeat(64);
const ROOT = `/ploinky/agents/libpod-${ID}`;
const CONTEXT = { schemaVersion: 1, ready: true, parent: '/ploinky/agents', cgroupNamespace: 'cgroup:[100]',
    pidNamespace: 'pid:[100]', controllers: ['cpu', 'memory', 'pids'], reason: null };
const DESCRIPTOR = { cgroupDelegation: CONTEXT, boxContext: { markerIdentity: 'exact-box-generation' } };

function fixture(t) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-cgroup-lifecycle-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const reservation = reserveAgentCgroup(DESCRIPTOR, ID);
    const record = { type: 'agent', repoName: 'repo', agentName: 'agent', runtime: 'podman', containerId: ID,
        instanceId: 'instance-current', enableGeneration: 'generation-current', cgroupSubtree: reservation, config: { binds: [] } };
    const candidate = { operationId: crypto.randomUUID(), containerName: 'exact-agent', containerId: ID,
        runtime: 'podman', runtimeNetwork: { mode: 'default' }, registryRecord: record };
    return { workspaceRoot, record, candidate: writeRuntimeCandidate(candidate, { workspaceRoot }) };
}

function nativeFs() {
    const fake = preparedCgroupFs();
    fake.addGroup('/ploinky/agents', { uid: 1000 });
    fake.addGroup(ROOT, { uid: 1000 });
    fake.addGroup(`${ROOT}/core`, { uid: 1000 });
    fake.addGroup(`${ROOT}/workloads`, { uid: 1000 });
    fake.addGroup('/ploinky/agents/sibling', { uid: 1000 });
    fake.placePid(321, `${ROOT}/core`);
    for (const current of [ROOT, `${ROOT}/workloads`]) {
        fake.groups.get(current).values.set('cgroup.type', 'domain');
        for (const controller of ['cpu', 'memory', 'pids']) fake.groups.get(current).subtree.add(controller);
    }
    const ids = new WeakMap(); let next = 10;
    const stat = (target) => {
        const value = fake.lstatSync(target), group = fake.groups.get(fake.resolve(target).rel);
        if (!ids.has(group)) ids.set(group, next++);
        return { ...value, dev: 1, ino: ids.get(group) };
    };
    const fsApi = new Proxy(fs, { get(original, key) {
        if (key === 'readlinkSync') return (target) => {
            if (target === '/proc/self/ns/cgroup') return CONTEXT.cgroupNamespace;
            if (target === '/proc/self/ns/pid') return CONTEXT.pidNamespace;
            if (target === '/proc/321/ns/cgroup') return 'cgroup:[200]';
            if (target === '/proc/321/ns/pid') return 'pid:[200]';
            return fs.readlinkSync(target);
        };
        if (key === 'readFileSync') return (target, ...args) => {
            if (target === '/proc/321/stat') return '321 (init) S ' + Array(18).fill('0').join(' ') + ' 1234';
            if (target === '/proc/321/mountinfo') return '36 1 0:31 / /sys/fs/cgroup ro,nosuid,nodev,noexec - cgroup2 cgroup2 rw,nsdelegate\n'
                + '37 1 0:31 / /run/ploinky/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup2 rw,nsdelegate\n';
            if (typeof target === 'string' && (target.startsWith('/sys/fs/cgroup') || target.startsWith('/proc/321/'))) return fake.readFileSync(target);
            return fs.readFileSync(target, ...args);
        };
        if (key === 'lstatSync') return (target) => target === '/proc/321/root/run/ploinky/cgroup'
            ? stat(`/sys/fs/cgroup${ROOT}`) : typeof target === 'string' && target.startsWith('/sys/fs/cgroup')
                ? stat(target) : fs.lstatSync(target);
        if (key === 'statfsSync') return () => ({ type: 0x63677270 });
        if (key === 'readdirSync') return (target, options) => {
            if (!target.startsWith('/sys/fs/cgroup')) return fs.readdirSync(target, options);
            const names = fake.readdirSync(target);
            return options?.withFileTypes ? names.map((name) => ({ name, isDirectory: () => true, isSymbolicLink: () => false })) : names;
        };
        if (key === 'rmdirSync') return (target) => fake.rmdirSync(target);
        return original[key];
    } });
    const identity = stat(`/sys/fs/cgroup${ROOT}`);
    return { fake, fsApi, reservation: { ...reserveAgentCgroup(DESCRIPTOR, ID),
        nativeRoot: { path: ROOT, dev: String(identity.dev), ino: String(identity.ino) } } };
}

function inspected() {
    return { Id: ID, Name: '/exact-agent', State: { Running: false, Pid: 321 }, Mounts: [], HostConfig: { Init: true },
        Config: { Labels: { [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'agent',
            [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION, [NETWORK_LABELS.workspace]: 'workspace-identity',
            [NETWORK_LABELS.contract]: 'b'.repeat(64), [NETWORK_LABELS.instanceId]: 'instance-current',
            [NETWORK_LABELS.enableGeneration]: 'generation-current' } } };
}

function fleet(record, workspaceRoot, fsApi, enginePresent = true, legacyFootprint = false) {
    let current = enginePresent ? inspected() : null; const controls = [];
    if (current && legacyFootprint) current.Config.Env = [`PLOINKY_CGROUP_SUBTREE=${CGROUP_SUBTREE_PATH}`];
    const run = () => removeExactContainerAndDescriptor('exact-agent', record, 'podman', {
        inspect: () => current, control: (_runtime, args) => { controls.push(args); if (args[0] === 'rm') current = null; return { status: 0 }; },
        withLock: (callback) => callback(), workspaceIdentity: () => ({ hash: 'workspace-identity' }),
        cgroupCleanupOptions: { workspaceRoot, fsApi },
    });
    return { run, controls, current: () => current };
}

test('C2: launcher death after exact create preserves pre-start reservation through normalization and absent-engine recovery', (t) => {
    const state = fixture(t);
    const loaded = readRuntimeCandidate('exact-agent', state.record, { workspaceRoot: state.workspaceRoot });
    assert.deepEqual(loaded.registryRecord.cgroupSubtree, reserveAgentCgroup(DESCRIPTOR, ID));
    const removal = fleet(loaded.registryRecord, state.workspaceRoot, fs, false);
    assert.throws(removal.run, /reservation remains unresolved/);
    assert.deepEqual(removal.controls, []);
    assert.ok(readRuntimeCandidate('exact-agent', state.record, { workspaceRoot: state.workspaceRoot }));
});

test('legacy delegated footprint without a durable root reservation is preserved before engine removal', (t) => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-cgroup-evidence-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const record = { type: 'agent', repoName: 'repo', agentName: 'agent', containerId: ID,
        instanceId: 'instance-current', enableGeneration: 'generation-current', config: { binds: [] } };
    const removal = fleet(record, workspaceRoot, fs, true, true);
    assert.throws(removal.run, /no durable cleanup reservation/);
    assert.deepEqual(removal.controls, []);
    assert.ok(removal.current());
});

test('C2/C9: actual fleet engine rm cannot retire a busy/unknown hierarchy; empty exact cleanup preserves siblings', (t) => {
    const state = fixture(t), native = nativeFs();
    const saved = commitRuntimeCandidateCgroup(state.candidate, native.reservation, { workspaceRoot: state.workspaceRoot });
    const removal = fleet(saved.registryRecord, state.workspaceRoot, native.fsApi);
    assert.throws(removal.run, /busy/);
    assert.equal(removal.current(), null, 'engine rm succeeded');
    assert.deepEqual(removal.controls, [['rm', '-f', ID]]);
    assert.ok(readRuntimeCandidate('exact-agent', state.record, { workspaceRoot: state.workspaceRoot }));
    native.fake.pidGroup.delete(321); native.fake.groups.get(`${ROOT}/core`).procs.clear();
    const recovered = fleet(saved.registryRecord, state.workspaceRoot, native.fsApi, false);
    assert.equal(recovered.run().found, false);
    assert.equal(native.fake.groups.has(ROOT), false);
    assert.equal(native.fake.groups.has('/ploinky/agents/sibling'), true);
    assert.equal(readRuntimeCandidate('exact-agent', state.record, { workspaceRoot: state.workspaceRoot }), null);
});

test('C2: actual fleet preserves durable receipt on native-root absence read error after successful engine removal', (t) => {
    const state = fixture(t), native = nativeFs();
    const saved = commitRuntimeCandidateCgroup(state.candidate, native.reservation, { workspaceRoot: state.workspaceRoot });
    const denied = new Proxy(native.fsApi, { get(target, key) { return key === 'lstatSync' ? (file) => {
        if (file === `/sys/fs/cgroup${ROOT}`) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return target.lstatSync(file);
    } : target[key]; } });
    const removal = fleet(saved.registryRecord, state.workspaceRoot, denied);
    assert.throws(removal.run, { code: 'EACCES' });
    assert.equal(removal.current(), null);
    assert.ok(readRuntimeCandidate('exact-agent', state.record, { workspaceRoot: state.workspaceRoot }));
});

test('post-start/adoption proof binds namespace, native inode, mount, entrypoint and exactly one provider env', () => {
    const native = nativeFs();
    const record = { ...inspected(), Config: { User: '', Entrypoint: [CGROUP_ENTRYPOINT],
        Cmd: [CONTEXT.cgroupNamespace, CONTEXT.pidNamespace, 'original-command'],
        Env: [`PLOINKY_CGROUP_SUBTREE=${CGROUP_SUBTREE_PATH}`] },
        HostConfig: { PidMode: 'private', CgroupnsMode: 'private' },
        Mounts: [{ Destination: CGROUP_HELPER_DIRECTORY, Source: CGROUP_HELPER_SOURCE, RW: false }] };
    const verify = () => verifyAgentCgroupSubtree({ descriptor: DESCRIPTOR, containerId: ID, fsApi: native.fsApi,
        query: () => ({ ok: true, stdout: JSON.stringify([record]) }) });
    assert.deepEqual(verify().reservation, native.reservation);
    native.fake.groups.get(ROOT).subtree.clear(); native.fake.groups.get(`${ROOT}/workloads`).subtree.clear();
    native.fake.placePid(321, ROOT);
    let attempts = 0, time = 0;
    const settled = waitForAgentCgroupSubtree({ descriptor: DESCRIPTOR, containerId: ID, fsApi: native.fsApi,
        query: () => {
            if (++attempts === 2) {
                native.fake.placePid(321, `${ROOT}/core`);
                for (const group of [ROOT, `${ROOT}/workloads`]) for (const name of CONTEXT.controllers) native.fake.groups.get(group).subtree.add(name);
            }
            return { ok: true, stdout: JSON.stringify([record]) };
        } }, { timeoutMs: 100, now: () => time, pause: () => { time += 10; } });
    assert.equal(attempts, 2);
    assert.deepEqual(settled.reservation, native.reservation);
    record.Config.Env.push(`PLOINKY_CGROUP_SUBTREE=${CGROUP_SUBTREE_PATH}`);
    assert.throws(verify, /env contract mismatch/);
    record.Config.Env.pop(); record.Config.User = '1000';
    assert.throws(verify, /image\/entrypoint/);
    assert.throws(() => cleanupOwnedContainerCgroup({ containerId: ID, record: { cgroupSubtree: {
        ...native.reservation, nativeRoot: { ...native.reservation.nativeRoot, path: '/ploinky/agents/sibling' } } }, fsApi: native.fsApi }), /invalid native-root/);
});
