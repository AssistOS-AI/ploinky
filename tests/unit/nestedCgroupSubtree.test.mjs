import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { admitManifestRuntimeCapabilities, renderContainerSecurityArgs, renderRuntimePolicyArgs,
    validateManifestRuntimeCapabilities, assertCgroupAdmissionCurrent } from '../../cli/sandbox/runtimeCapabilities.js';
import { observeCgroupSubtreeContext, prepareCgroupSubtreeParent } from '../../cli/sandbox/cgroupSubtree.mjs';
import { prepareAgentCgroupSubtree, verifyNamespaceDiff, CGROUP_MOUNT } from '../../cli/sandbox/docker/cgroupSubtreePrepare.mjs';
import { declaredCgroupSubtreeAgents } from '../../ploinky-box/cgroupSubtree.mjs';
import { stripReservedAgentEnv } from '../../cli/utils/security/agentIdentityEnv.js';
import { FakeCgroupFs, SELF_PID, preparedCgroupFs } from '../hardware-limits/fakeCgroupFs.mjs';

const CONTROLLERS = ['cpu', 'memory', 'pids'];
export const READY = Object.freeze({ schemaVersion: 1, ready: true, parent: '/ploinky/agents',
    cgroupNamespace: 'cgroup:[100]', pidNamespace: 'pid:[100]', controllers: Object.freeze(CONTROLLERS), reason: null });
const MANIFEST = { containerSecurity: { nestedPodman: true, cgroupSubtree: true } };
const admit = (manifest = MANIFEST, options = {}) => admitManifestRuntimeCapabilities(manifest,
    { insideBox: true, runtime: 'podman', cgroupContext: READY, hardwareContext: { gate: 'off' }, ...options });

test('C1: root boolean declaration only, nested prerequisite, backend refusal and reserved volume boundaries', () => {
    for (const value of [null, 1, 'true', {}, []]) assert.throws(() => validateManifestRuntimeCapabilities({
        containerSecurity: { nestedPodman: true, cgroupSubtree: value },
    }), { code: 'PLOINKY_MANIFEST_SECURITY_INVALID' });
    for (const manifest of [{ containerSecurity: { cgroupSubtree: true } }, { cgroupSubtree: true },
        { profiles: { alternate: { cgroupSubtree: true } } }, { cgroupDelegation: READY },
        { runtime: { resources: { cgroupSubtree: true } } }, { security: { cgroupSubtree: true } },
        { profiles: { alternate: { runtime: { containerSecurity: { cgroupSubtree: true } } } } }]) {
        assert.throws(() => validateManifestRuntimeCapabilities(manifest), { code: 'PLOINKY_MANIFEST_SECURITY_INVALID' });
    }
    assert.throws(() => validateManifestRuntimeCapabilities({ profiles: { alternate: { containerSecurity: MANIFEST.containerSecurity } } }),
        { code: 'PLOINKY_MANIFEST_SECURITY_PROFILE_UNSUPPORTED' });
    for (const options of [{ runtime: 'docker' }, { runtimeKind: 'bwrap' }, { insideBox: false }]) {
        assert.throws(() => admit(MANIFEST, options), { code: 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED' });
    }
    for (const target of ['/run', '/run/ploinky/cgroup', '/run/ploinky-cgroup/tools', '/']) {
        assert.throws(() => admit({ ...MANIFEST, volumes: { data: target } }), { code: 'PLOINKY_MANIFEST_SECURITY_INVALID' });
        assert.throws(() => admit({ ...MANIFEST, runtime: { resources: { persistentStorage: {
            key: 'own-data', containerPath: target } } } }), { code: 'PLOINKY_MANIFEST_SECURITY_INVALID' });
    }
});

test('C1/C11: separate gate-off delegation placement; false/absent ordinary argv and nested privileges unchanged', () => {
    const descriptor = admit().descriptor;
    assert.equal(descriptor.hardwarePlacement, undefined);
    assert.equal(Object.isFrozen(descriptor.cgroupDelegation), true);
    const args = renderRuntimePolicyArgs(descriptor, { runtime: 'podman' });
    for (const flag of ['--cgroups=enabled', '--cgroupns=private', '--cgroup-parent=/ploinky/agents', '--pid=private']) {
        assert.equal(args.filter((value) => value === flag).length, 1);
    }
    const ordinary = admit({ containerSecurity: { nestedPodman: true } }).descriptor;
    const disabled = admit({ containerSecurity: { nestedPodman: true, cgroupSubtree: false } }).descriptor;
    assert.deepEqual(renderRuntimePolicyArgs(disabled, { runtime: 'podman' }), renderRuntimePolicyArgs(ordinary, { runtime: 'podman' }));
    assert.deepEqual(renderContainerSecurityArgs(descriptor), renderContainerSecurityArgs(ordinary));
    assert.throws(() => admit(MANIFEST, { cgroupContext: { ready: false } }), (error) => (
        error.code === 'PLOINKY_CGROUP_DELEGATION_UNAVAILABLE'
        && error.message.startsWith('cgroup delegation not prepared yet; run ploinky restart')
    ));
    assert.throws(() => assertCgroupAdmissionCurrent(admit(), { cgroupContext: { ...READY, pidNamespace: 'pid:[101]' } }),
        { code: 'PLOINKY_CGROUP_DELEGATION_UNAVAILABLE' });
    const env = stripReservedAgentEnv({ PLOINKY_CGROUP_SUBTREE: '/forged', ORDINARY: 'kept' });
    assert.deepEqual(env, { ORDINARY: 'kept' });
});

test('C1: observation is read-only and parent preparation writes only delegated agents controls', () => {
    const fake = preparedCgroupFs();
    fake.statfsSync = () => ({ type: 0x63677270 });
    fake.readlinkSync = (target) => target.endsWith('/pid') ? READY.pidNamespace : READY.cgroupNamespace;
    const context = observeCgroupSubtreeContext({ fsApi: fake,
        query: () => ({ ok: true, stdout: JSON.stringify({ host: { ociRuntime: { name: 'crun' }, cgroupManager: 'cgroupfs' } }) }) });
    assert.equal(context.ready, true);
    assert.deepEqual(fake.writes, []);
    prepareCgroupSubtreeParent(context, { fsApi: fake });
    assert.ok(fake.writes.length);
    assert.ok(fake.writes.every(({ path: target }) => target === '/sys/fs/cgroup/ploinky/agents/cgroup.subtree_control'));
    assert.equal(fake.groups.has('/ploinky/system'), false);
});

test('host scanner accepts only bounded regular qualifying declarations including linked directories', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-scan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (relative, manifest) => { const file = path.join(root, relative, 'manifest.json');
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(manifest)); return file; };
    write('repo/agent', MANIFEST);
    write('.ploinky/repos/installed/agent', MANIFEST);
    write('repo/nonnested', { containerSecurity: { cgroupSubtree: true } });
    const bad = write('repo/symlink', MANIFEST);
    fs.renameSync(bad, `${bad}.target`); fs.symlinkSync(`${bad}.target`, bad);
    assert.deepEqual(declaredCgroupSubtreeAgents(root), ['installed/agent', 'repo/agent']);
    assert.equal(Object.isFrozen(declaredCgroupSubtreeAgents(root)), true);
});

function helperFixture() {
    const fake = new FakeCgroupFs({ cgroupRoot: CGROUP_MOUNT });
    const inodes = new WeakMap(); let sequence = 1; let mounted = false; let privateMount = false;
    const mounts = [];
    const fsApi = {
        readFileSync(target) {
            if (target === '/proc/self/mountinfo') return '36 25 0:31 / /sys/fs/cgroup ro,nosuid,nodev,noexec - cgroup2 cgroup2 rw,nsdelegate\n'
                + (mounted ? `37 25 0:31 / ${CGROUP_MOUNT} rw,nosuid,nodev,noexec ${privateMount ? '' : 'shared:9 '}- cgroup2 cgroup2 rw,nsdelegate\n` : '');
            if (target.endsWith('/cgroup.type')) return 'domain';
            return fake.readFileSync(target);
        },
        lstatSync(target) {
            if (target === '/run' || target === '/run/ploinky') return { isDirectory: () => true, isSymbolicLink: () => false, dev: 2, ino: 99 };
            if (target === '/sys/fs/cgroup') target = CGROUP_MOUNT;
            const stat = fake.lstatSync(target);
            const group = fake.groups.get(fake.resolve(target).rel);
            if (!inodes.has(group)) inodes.set(group, sequence++);
            return { ...stat, dev: 1, ino: inodes.get(group) };
        },
        readlinkSync(target) {
            if (/\/ns\/pid$/.test(target)) return 'pid:[200]';
            if (/\/ns\/cgroup$/.test(target)) return 'cgroup:[200]';
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
        statfsSync: () => ({ type: 0x63677270 }),
        readdirSync: (target) => fake.readdirSync(target),
        mkdirSync: (target) => fake.mkdirSync(target),
        writeFileSync: (target, value) => fake.writeFileSync(target, value),
    };
    return { fake, fsApi, mounts, options: { boxCgroup: READY.cgroupNamespace, boxPid: READY.pidNamespace, fsApi,
        getuid: () => 0, sleep: async () => {}, mount(command, args) {
            mounts.push([command, args]);
            if (args[0] === '-t') mounted = true;
            else privateMount = true;
            return { status: 0 };
        } } };
}

test('C1/C9: startup evacuates only direct own tasks before controllers; repeated preparation preserves workload children', async () => {
    const fixture = helperFixture();
    const first = await prepareAgentCgroupSubtree(fixture.options);
    assert.equal(first.prepared, true);
    assert.deepEqual([...fixture.fake.groups.get('/core').procs].sort((a, b) => a - b), [1, 77, SELF_PID]);
    assert.equal(fixture.fake.groups.get('/').procs.size, 0);
    assert.equal(fixture.fake.groups.get('/workloads').procs.size, 0);
    for (const current of ['/', '/workloads']) assert.deepEqual([...fixture.fake.groups.get(current).subtree], CONTROLLERS);
    fixture.fake.addGroup('/workloads/child'); fixture.fake.placePid(888, '/workloads/child');
    await prepareAgentCgroupSubtree(fixture.options);
    assert.equal(fixture.fake.pidGroup.get(888), '/workloads/child');
    assert.equal(fixture.mounts.length, 2, 'one mount and one private-propagation operation only');
    assert.ok(fixture.fake.writes.every(({ path: target }) => !/(memory\.max|cpu\.max|pids\.max)/.test(target)));
});

test('startup rejects Box-shared namespaces and wrong filesystem before task/controller writes', async () => {
    const shared = helperFixture();
    shared.options.boxPid = 'pid:[200]';
    await assert.rejects(prepareAgentCgroupSubtree(shared.options), /private/);
    assert.deepEqual(shared.fake.writes, []); assert.deepEqual(shared.mounts, []);
    const wrong = helperFixture(); wrong.fsApi.statfsSync = () => ({ type: 0 });
    await assert.rejects(prepareAgentCgroupSubtree(wrong.options), /cgroup2/);
    assert.deepEqual(wrong.fake.writes, []); assert.deepEqual(wrong.mounts, []);
    assert.throws(() => verifyNamespaceDiff({ ...wrong.options, boxCgroup: 'invalid' }), /Box namespaces/);
});

test('startup refuses symlink targets, stacked mounts and failed controller readback without repair', async () => {
    const symlink = helperFixture(), originalStat = symlink.fsApi.lstatSync;
    symlink.fsApi.lstatSync = (target) => target === CGROUP_MOUNT
        ? { isDirectory: () => false, isSymbolicLink: () => true } : originalStat(target);
    await assert.rejects(prepareAgentCgroupSubtree(symlink.options), /real directory/);
    assert.deepEqual(symlink.mounts, []);
    const stacked = helperFixture();
    await prepareAgentCgroupSubtree(stacked.options);
    const beforeWrites = stacked.fake.writes.length, readFile = stacked.fsApi.readFileSync;
    stacked.fsApi.readFileSync = (target) => target === '/proc/self/mountinfo'
        ? readFile(target) + `99 25 0:31 / ${CGROUP_MOUNT} rw,nosuid,nodev,noexec - cgroup2 cgroup2 rw,nsdelegate\n`
        : readFile(target);
    await assert.rejects(prepareAgentCgroupSubtree(stacked.options), /stacked/);
    assert.equal(stacked.fake.writes.length, beforeWrites);
    assert.equal(stacked.mounts.length, 2);
    const ignored = helperFixture(); ignored.fake.hooks.ignoreEnable = (_group, controller) => controller === 'pids';
    await assert.rejects(prepareAgentCgroupSubtree(ignored.options), /readback/);
});
