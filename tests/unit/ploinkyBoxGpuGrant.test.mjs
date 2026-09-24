import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import {
    BOX_GPU_CDI_DEVICE,
    BOX_GPU_CDI_SPEC_PATH,
    BOX_GPU_MARKER_PATH,
    BOX_IMAGE_REFERENCE,
    BOX_LABELS,
    BOX_READY_LINE,
    BOX_ROUTER_HEALTH_SOCKET,
    BOX_TMPFS,
    BOX_USERNS,
} from '../../ploinky-box/constants.mjs';
import { validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import {
    buildGpuWiring,
    createGpuGrantStore,
    discoverNvidiaGpu,
    gpuGenerationDirectory,
    observeContainerGpuWiring,
    parseLdconfigCache,
    parseNvidiaDriverVersion,
    resolveGpuWiring,
} from '../../ploinky-box/gpuGrant.mjs';
import { writeGraphSkillScope } from '../../ploinky-box/graphSkillScope.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { assertRouterBindingStateConfined } from '../../ploinky-box/routerBinding.mjs';
import { readBoxGpuGrant } from '../../ploinky-box/lib/gpuGrantMarker.mjs';
import { containerCreateArgs } from '../../ploinky-box/lifecycle/container.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';
import {
    nestedPodmanSeccompProfileContract,
    nestedPodmanSeccompProfilePath,
} from '../../ploinky-box/seccomp.mjs';
import { buildHostSkillScope } from '../../ploinky-box/skillScope.mjs';
import {
    createBoxSupervisor,
    formatGpuGrantResult,
    formatGpuGrantStatus,
} from '../../ploinky-box/supervisor.mjs';
import {
    admitManifestRuntimeCapabilities,
    assertRuntimeAdmissionCurrent,
    renderRuntimePolicyArgs,
} from '../../cli/sandbox/runtimeCapabilities.js';
import {
    agentLibFixture,
    agentLibFixtureEnv,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
} from '../helpers/agentlibFixture.mjs';

const DRIVER = '595.91.07';
const LIB = '/usr/lib/x86_64-linux-gnu';
const AGENT = 'local-llms/local-llm';
const GRANT = Object.freeze({ vendor: 'nvidia', agents: [AGENT] });
const DATA_FINGERPRINTS = Object.freeze({ dependencies: 'd'.repeat(64), images: 'f'.repeat(64) });
const TMPFS_CREATE_ARGUMENT = `${BOX_TMPFS.destination}:${BOX_TMPFS.options.join(',')}`;
const TMPFS_INSPECTED_OPTIONS = Object.freeze([
    ...BOX_TMPFS.options.filter((option) => option !== 'notmpcopyup'),
    'rprivate',
].sort());
const OLD_ID = 'e'.repeat(64);
const OLD_IMAGE = 'd'.repeat(64);
const DEVICE_NUMBERS = Object.freeze({
    '/dev/nvidia0': [195, 0],
    '/dev/nvidiactl': [195, 255],
    '/dev/nvidia-uvm': [507, 0],
});

function errno(code) {
    return Object.assign(new Error(code), { code });
}

/**
 * A fixture sysroot: character-device nodes, the ldconfig cache, the kernel
 * module version and the driver files, all behind the fs seam.
 */
function fakeHost({
    kernel = DRIVER,
    library = DRIVER,
    missing = [],
    inaccessible = [],
    mtimeMs = 1_786_317_226_000,
} = {}) {
    const files = new Map();
    const links = new Map();
    const lines = [];
    const addLibrary = (soname, real) => {
        files.set(real, { size: real.length * 1000, mtimeMs });
        const linkPath = `${LIB}/${soname}`;
        if (linkPath !== real) links.set(linkPath, real);
        if (!missing.includes(soname)) lines.push(`\t${soname} (libc6,x86-64) => ${linkPath}`);
    };
    addLibrary('libcuda.so.1', `${LIB}/libcuda.so.${library}`);
    addLibrary('libnvidia-ptxjitcompiler.so.1', `${LIB}/libnvidia-ptxjitcompiler.so.${library}`);
    addLibrary('libnvidia-ml.so.1', `${LIB}/libnvidia-ml.so.${library}`);
    addLibrary('libnvidia-nvvm.so.4', `${LIB}/libnvidia-nvvm.so.${library}`);
    addLibrary(`libnvidia-gpucomp.so.${library}`, `${LIB}/libnvidia-gpucomp.so.${library}`);
    lines.push(`\tlibcuda.so.1 (libc6) => /usr/lib/i386-linux-gnu/libcuda.so.1`);
    files.set('/usr/bin/nvidia-smi', { size: 1_259_616, mtimeMs });
    const fsApi = {
        readFileSync(target) {
            if (target === '/proc/driver/nvidia/version') {
                return `NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  ${kernel}  Release Build\n`;
            }
            throw errno('ENOENT');
        },
        statSync(target) {
            if (Object.hasOwn(DEVICE_NUMBERS, target)) {
                if (missing.includes(target)) throw errno('ENOENT');
                const [major, minor] = DEVICE_NUMBERS[target];
                return { isCharacterDevice: () => true, isFile: () => false, rdev: (major << 8) | minor };
            }
            const file = files.get(target);
            if (!file) throw errno('ENOENT');
            return { isCharacterDevice: () => false, isFile: () => true, ...file };
        },
        accessSync(target) {
            if (inaccessible.includes(target)) throw errno('EACCES');
        },
        realpathSync(target) {
            if (links.has(target)) return links.get(target);
            if (files.has(target)) return target;
            throw errno('ENOENT');
        },
    };
    return {
        fsApi,
        discover: () => discoverNvidiaGpu({
            fsApi,
            readLdconfig: () => `${lines.length} libs found in cache\n${lines.join('\n')}\n`,
            smiCandidates: ['/usr/bin/nvidia-smi'],
        }),
    };
}

// A kept wiring's host driver files and device nodes are checked through the
// real fs module. Tests route only those host paths to a fake host, so they
// behave the same on machines with and without an NVIDIA driver.
function useFakeHostFiles(t, host) {
    const realStat = fs.statSync;
    const realAccess = fs.accessSync;
    const isHostPath = (target) => typeof target === 'string'
        && (target.startsWith(`${LIB}/`) || target.startsWith('/dev/nvidia') || target === '/usr/bin/nvidia-smi');
    t.mock.method(fs, 'statSync', (target, ...rest) => (
        isHostPath(target) ? host.fsApi.statSync(target) : realStat.call(fs, target, ...rest)));
    t.mock.method(fs, 'accessSync', (target, ...rest) => (
        isHostPath(target) ? host.fsApi.accessSync(target) : realAccess.call(fs, target, ...rest)));
}

function workspaceFixture(t, name = 'workspace') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-gpu-grant-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const workspace = path.join(root, name);
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    return { root, home, identity, lock, store: createGpuGrantStore({ homeDirectory: home }) };
}

function activeWiring(identity, { grant = GRANT, host = fakeHost(), homeDirectory = os.homedir() } = {}) {
    return buildGpuWiring({ identity, grant, discovery: host.discover(), homeDirectory });
}

// ---------------------------------------------------------------------------
// Discovery, wiring and the Box CDI spec
// ---------------------------------------------------------------------------

test('discovery on a fixture sysroot yields a deterministic device, bind and Box CDI spec set', (t) => {
    const state = workspaceFixture(t);
    const discovery = fakeHost().discover();
    assert.equal(discovery.driverVersion, DRIVER);
    assert.deepEqual(discovery.devices, [
        { path: '/dev/nvidia0', major: 195, minor: 0 },
        { path: '/dev/nvidiactl', major: 195, minor: 255 },
        { path: '/dev/nvidia-uvm', major: 507, minor: 0 },
    ]);
    assert.deepEqual(discovery.libraries.map((library) => [library.soname, library.source]), [
        ['libcuda.so.1', `${LIB}/libcuda.so.${DRIVER}`],
        ['libnvidia-ptxjitcompiler.so.1', `${LIB}/libnvidia-ptxjitcompiler.so.${DRIVER}`],
        ['libnvidia-ml.so.1', `${LIB}/libnvidia-ml.so.${DRIVER}`],
        ['libnvidia-nvvm.so.4', `${LIB}/libnvidia-nvvm.so.${DRIVER}`],
        [`libnvidia-gpucomp.so.${DRIVER}`, `${LIB}/libnvidia-gpucomp.so.${DRIVER}`],
    ]);

    const wiring = buildGpuWiring({ identity: state.identity, grant: GRANT, discovery, homeDirectory: state.home });
    const again = buildGpuWiring({ identity: state.identity, grant: GRANT, discovery, homeDirectory: state.home });
    assert.equal(wiring.fingerprint, again.fingerprint);
    assert.match(wiring.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(wiring.state, 'active');
    // /dev/nvidia-uvm-tools is deliberately not part of the minimal set.
    assert.deepEqual(wiring.devices, ['/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm']);
    const generation = gpuGenerationDirectory(state.identity, wiring.fingerprint, state.home);
    assert.equal(generation, path.join(state.home, '.ploinky-box', 'gpu-grants', state.identity.instance, wiring.fingerprint));
    assert.deepEqual(wiring.mounts, [
        { source: path.join(generation, 'box.json'), destination: BOX_GPU_CDI_SPEC_PATH },
        { source: path.join(generation, 'marker.json'), destination: BOX_GPU_MARKER_PATH },
        { source: '/usr/bin/nvidia-smi', destination: '/usr/local/nvidia/bin/nvidia-smi' },
        { source: `${LIB}/libcuda.so.${DRIVER}`, destination: '/usr/local/nvidia/lib64/libcuda.so.1' },
        { source: `${LIB}/libnvidia-gpucomp.so.${DRIVER}`, destination: `/usr/local/nvidia/lib64/libnvidia-gpucomp.so.${DRIVER}` },
        { source: `${LIB}/libnvidia-ml.so.${DRIVER}`, destination: '/usr/local/nvidia/lib64/libnvidia-ml.so.1' },
        { source: `${LIB}/libnvidia-nvvm.so.${DRIVER}`, destination: '/usr/local/nvidia/lib64/libnvidia-nvvm.so.4' },
        { source: `${LIB}/libnvidia-ptxjitcompiler.so.${DRIVER}`, destination: '/usr/local/nvidia/lib64/libnvidia-ptxjitcompiler.so.1' },
    ]);

    const spec = JSON.parse(wiring.files.find((file) => file.path.endsWith('box.json')).content);
    assert.equal(spec.kind, 'ploinky.local/gpu');
    assert.deepEqual(spec.devices.map((device) => device.name), ['all']);
    assert.deepEqual(spec.devices[0].containerEdits.deviceNodes, wiring.devices.map((device) => ({ path: device })));
    const inBoxTargets = new Set(wiring.mounts.map((mount) => mount.destination));
    for (const mount of spec.containerEdits.mounts) {
        // Every source the nested Podman reads is an in-Box bind target, never
        // a host-only path, and it is mounted read-only at the same path.
        assert.equal(inBoxTargets.has(mount.hostPath), true, mount.hostPath);
        assert.equal(mount.containerPath, mount.hostPath);
        assert.equal(mount.hostPath.startsWith(LIB), false);
        assert.equal(mount.options.includes('ro'), true);
    }
    const specText = JSON.stringify(spec);
    assert.doesNotMatch(specText, /"env"|"hooks"|createContainer|update-ldcache/);

    // The operator decision and the driver are both part of the fingerprint.
    const otherAgents = buildGpuWiring({
        identity: state.identity,
        grant: { vendor: 'nvidia', agents: [AGENT, 'lab/other'] },
        discovery,
        homeDirectory: state.home,
    });
    assert.notEqual(otherAgents.fingerprint, wiring.fingerprint);
    const updated = buildGpuWiring({
        identity: state.identity,
        grant: GRANT,
        discovery: fakeHost({ kernel: '600.10', library: '600.10' }).discover(),
        homeDirectory: state.home,
    });
    assert.notEqual(updated.fingerprint, wiring.fingerprint);
});

test('Box create arguments add only the grant devices, read-only binds and label', (t) => {
    const state = workspaceFixture(t);
    const seccomp = nestedPodmanSeccompProfilePath(state.root);
    fs.mkdirSync(path.dirname(seccomp), { recursive: true });
    fs.copyFileSync(new URL('../../ploinky-box/seccomp/podman-nested-pid-fallback.json', import.meta.url), seccomp);
    const wiring = activeWiring(state.identity, { homeDirectory: state.home });
    const base = {
        identity: state.identity,
        dataFingerprints: DATA_FINGERPRINTS,
        agentLib: agentLibFixture(state.identity.workspaceRoot),
        imageId: 'a'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8090,
        repositoryRoot: state.root,
        cidfile: path.join(state.root, 'cid'),
    };
    const plain = containerCreateArgs(base);
    const granted = containerCreateArgs({ ...base, gpu: wiring });
    const values = (args, flag) => args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
    assert.deepEqual(values(granted, '--device'), ['/dev/fuse', '/dev/net/tun', ...wiring.devices]);
    assert.deepEqual(values(granted, '--env'), values(plain, '--env'));
    assert.deepEqual(values(granted, '--security-opt'), values(plain, '--security-opt'));
    const addedVolumes = values(granted, '--volume').filter((value) => !values(plain, '--volume').includes(value));
    assert.deepEqual(addedVolumes, wiring.mounts.map((mount) => `${mount.source}:${mount.destination}:ro`));
    assert.deepEqual(
        values(granted, '--label').filter((value) => !values(plain, '--label').includes(value)),
        [`${BOX_LABELS.gpuGrant}=${wiring.fingerprint}`],
    );
    for (const forbidden of ['--privileged', '--cap-add', '--cdi-spec-dir', '--gpus']) {
        assert.equal(granted.some((value) => value.startsWith(forbidden)), false, forbidden);
    }
});

test('discovery refuses missing or inaccessible nodes, missing libraries, and an updated but not rebooted driver', () => {
    const refuses = (host, pattern) => assert.throws(
        () => host.discover(),
        (error) => error.code === 'PLOINKY_BOX_GPU_DISCOVERY_FAILED' && pattern.test(error.message),
    );
    refuses(fakeHost({ missing: ['/dev/nvidia-uvm'] }), /\/dev\/nvidia-uvm is missing/);
    refuses(fakeHost({ inaccessible: ['/dev/nvidiactl'] }), /\/dev\/nvidiactl is not readable and writable/);
    refuses(fakeHost({ missing: ['libnvidia-ml.so.1'] }), /libnvidia-ml\.so\.1 is not in the ldconfig cache/);
    refuses(
        fakeHost({ kernel: '595.91.07', library: '600.10' }),
        /version mismatch: the kernel module is 595\.91\.07 but libcuda\.so\.1 is libcuda\.so\.600\.10; reboot/,
    );
    assert.equal(parseNvidiaDriverVersion('NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.14  Thu Feb 22'), '550.54.14');
    assert.deepEqual([...parseLdconfigCache('\tlibcuda.so.1 (libc6) => /usr/lib32/libcuda.so.1\n').keys()], []);
});

test('a failed discovery wires only a stale-grant marker (D12)', (t) => {
    const state = workspaceFixture(t);
    const stale = resolveGpuWiring(state.identity, GRANT, {
        discover: () => fakeHost({ kernel: '595.91.07', library: '600.10' }).discover(),
        homeDirectory: state.home,
    });
    assert.equal(stale.state, 'stale');
    assert.match(stale.reason, /version mismatch/);
    assert.deepEqual(stale.devices, []);
    assert.deepEqual(stale.mounts.map((mount) => mount.destination), [BOX_GPU_MARKER_PATH]);
    assert.equal(stale.files.length, 1);
    const marker = JSON.parse(stale.files[0].content);
    assert.equal(marker.state, 'stale');
    assert.equal(marker.cdiDevice, null);
    assert.equal(marker.specSha256, null);
    assert.throws(
        () => resolveGpuWiring(state.identity, GRANT, { discover: () => { throw new Error('unexpected'); } }),
        /unexpected/,
    );
});

// ---------------------------------------------------------------------------
// Host-only record, generation files and confinement
// ---------------------------------------------------------------------------

test('the grant record is private host state for one exact workspace', (t) => {
    const state = workspaceFixture(t);
    assert.equal(state.store.read(state.identity), null);
    state.store.write(state.identity, GRANT, state.lock, { admitted: null });
    const target = state.store.pathFor(state.identity);
    assert.equal(path.dirname(target), path.join(state.home, '.ploinky-box', 'gpu-grants'));
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(state.store.directory).mode & 0o777, 0o700);
    // D14 adds denies to the decision; a record without them keeps its bytes.
    assert.deepEqual(state.store.read(state.identity),
        { vendor: 'nvidia', agents: [AGENT], denied: [], workspaceDenied: false, admitted: null });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(target, 'utf8'))).sort(),
        ['admitted', 'agents', 'instance', 'pathHash', 'vendor', 'version', 'workspaceRoot']);

    // A record planted inside the writable workspace is never consulted.
    const planted = path.join(state.identity.workspaceRoot, '.ploinky', 'gpu-grants');
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, `${state.identity.instance}.json`), fs.readFileSync(target));
    state.store.clear(state.identity, state.lock);
    assert.equal(state.store.read(state.identity), null);

    state.store.write(state.identity, GRANT, state.lock);
    const valid = fs.readFileSync(target, 'utf8');
    const rejects = (pattern) => assert.throws(
        () => state.store.read(state.identity),
        (error) => error.code === 'PLOINKY_BOX_GPU_GRANT_STATE_INVALID' && pattern.test(error.message),
    );
    const decoy = path.join(state.root, 'decoy.json');
    fs.writeFileSync(decoy, valid, { mode: 0o600 });
    fs.rmSync(target);
    fs.symlinkSync(decoy, target);
    rejects(/non-symlink/);
    fs.rmSync(target);
    fs.linkSync(decoy, target);
    rejects(/non-linked/);
    fs.rmSync(target);
    fs.writeFileSync(target, valid, { mode: 0o640 });
    fs.chmodSync(target, 0o640);
    rejects(/private to the current user/);
    fs.rmSync(target);
    fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(valid), pathHash: '0'.repeat(12) }), { mode: 0o600 });
    rejects(/belongs to another workspace/);
    fs.rmSync(target);
    fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(valid), agents: ['not a selector'] }), { mode: 0o600 });
    rejects(/REPO\/AGENT/);
    assert.throws(() => state.store.write(state.identity, GRANT, null), /workspace mutation lock/);
});

test('the grant state refuses workspaces or caches that alias the host control-state directory', (t) => {
    const state = workspaceFixture(t);
    const inside = path.join(state.home, '.ploinky-box', 'gpu-grants', 'ws');
    fs.mkdirSync(path.join(inside, '.ploinky'), { recursive: true });
    const aliased = buildWorkspaceIdentity(inside, { markerFound: true });
    assert.throws(
        () => state.store.read(aliased),
        (error) => error.code === 'PLOINKY_BOX_ROUTER_BINDING_STATE_INVALID' && /overlaps writable Box source/.test(error.message),
    );
});

test('the grant state refuses a workspace that is a bind-mount alias of the gpu-grants directory', (t) => {
    const state = workspaceFixture(t);
    const grants = path.join(state.home, '.ploinky-box', 'gpu-grants');
    fs.mkdirSync(grants, { recursive: true, mode: 0o700 });
    const grantsStat = fs.statSync(grants);
    const workspace = state.identity.workspaceRoot;
    // A bind mount shows the same device and inode under another path, which
    // realpath cannot see; only the gpu-grants identity check catches it.
    const fsApi = {
        ...fs,
        statSync(target, options) {
            const stat = fs.statSync(target, options);
            if (path.resolve(target) !== workspace) return stat;
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: grantsStat.dev, ino: grantsStat.ino });
        },
    };
    assert.doesNotThrow(() => assertRouterBindingStateConfined(state.identity, { homeDirectory: state.home }));
    assert.throws(
        () => assertRouterBindingStateConfined(state.identity, { homeDirectory: state.home, fsApi }),
        /overlaps writable Box source/,
    );
});

test('an observed wiring must bind its own generation files, and a stale one nothing else', (t) => {
    const state = boxFixture(t);
    const wiring = activeWiring(state.identity);
    const handle = containerHandle(state, { gpu: wiring });
    assert.equal(observeContainerGpuWiring(handle, { identity: state.identity }).state, 'active');
    const moved = (destination) => {
        const copy = structuredClone(handle);
        const mount = copy.runtime.mounts.find((entry) => entry.destination === destination);
        mount.source = path.join(path.dirname(path.dirname(mount.source)), 'f'.repeat(64), path.basename(mount.source));
        return copy;
    };
    assert.throws(() => observeContainerGpuWiring(moved(BOX_GPU_MARKER_PATH), { identity: state.identity }),
        /grant marker is not its generation marker/);
    assert.throws(() => observeContainerGpuWiring(moved(BOX_GPU_CDI_SPEC_PATH), { identity: state.identity }),
        /CDI spec is not its generation spec/);

    const stale = structuredClone(handle);
    stale.runtime.mounts = stale.runtime.mounts.filter((mount) => !mount.destination.startsWith('/usr/local/nvidia/')
        && mount.destination !== BOX_GPU_CDI_SPEC_PATH);
    stale.runtime.createCommand = stale.runtime.createCommand.filter((arg, index, all) => !(
        (arg === '--device' && String(all[index + 1]).startsWith('/dev/nvidia')) || String(arg).startsWith('/dev/nvidia')));
    assert.equal(observeContainerGpuWiring(stale, { identity: state.identity }).state, 'stale');
    const staleWithDevices = structuredClone(stale);
    staleWithDevices.runtime.createCommand.push('--device', '/dev/nvidia0');
    assert.throws(() => observeContainerGpuWiring(staleWithDevices, { identity: state.identity }),
        /stale GPU grant still has GPU devices or libraries/);
    const staleWithLibrary = structuredClone(stale);
    staleWithLibrary.runtime.mounts.push({ type: 'bind', name: '', source: `${LIB}/libcuda.so.${DRIVER}`,
        destination: '/usr/local/nvidia/lib64/libcuda.so.1', rw: false });
    assert.throws(() => observeContainerGpuWiring(staleWithLibrary, { identity: state.identity }),
        /stale GPU grant still has GPU devices or libraries/);
});

test('D14 an observed marker-only Box is revoked when its own generation marker says so, and stale otherwise', (t) => {
    const state = boxFixture(t);
    const observe = (wiring) => observeContainerGpuWiring(containerHandle(state, { gpu: wiring }),
        { identity: state.identity, homeDirectory: state.home });
    const revokedWiring = (denials) => buildGpuWiring({
        identity: state.identity, grant: { vendor: 'nvidia' }, revoked: true, ...denials, homeDirectory: state.home,
    });
    const stale = buildGpuWiring({ identity: state.identity, grant: GRANT,
        failure: new Error('Unable to read the NVIDIA kernel module version'), homeDirectory: state.home });
    state.store.materialize(state.identity, stale, state.lock);
    assert.equal(observe(stale).state, 'stale');
    const workspaceRevoked = revokedWiring({ workspaceDenied: true });
    state.store.materialize(state.identity, workspaceRevoked, state.lock);
    assert.equal(observe(workspaceRevoked).state, 'revoked');
    const agentRevoked = revokedWiring({ denied: [AGENT] });
    state.store.materialize(state.identity, agentRevoked, state.lock);
    const observed = observe(agentRevoked);
    assert.deepEqual([observed.fingerprint, observed.state], [agentRevoked.fingerprint, 'revoked']);
    // Without its generation marker (pruned or unreadable) a marker-only Box reads as stale.
    fs.rmSync(path.join(gpuGenerationDirectory(state.identity, agentRevoked.fingerprint, state.home), 'marker.json'));
    assert.equal(observe(agentRevoked).state, 'stale');
});

test('generation files are content addressed, private and pruned only by name', (t) => {
    const state = workspaceFixture(t);
    const first = activeWiring(state.identity, { homeDirectory: state.home });
    const second = activeWiring(state.identity, { homeDirectory: state.home, host: fakeHost({ mtimeMs: 1 }) });
    state.store.materialize(state.identity, first, state.lock);
    state.store.materialize(state.identity, first, state.lock);
    state.store.materialize(state.identity, second, state.lock);
    for (const file of first.files) {
        assert.equal(fs.readFileSync(file.path, 'utf8'), file.content);
        assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
    }
    fs.writeFileSync(first.files[0].path, 'tampered', { mode: 0o600 });
    assert.throws(() => state.store.materialize(state.identity, first, state.lock), /does not match its fingerprint/);
    assert.deepEqual(state.store.prune(state.identity, [second.fingerprint], state.lock), [first.fingerprint]);
    assert.equal(fs.existsSync(path.dirname(second.files[0].path)), true);
    assert.deepEqual(state.store.prune(state.identity, [], state.lock), [second.fingerprint]);
    assert.equal(fs.existsSync(path.join(state.store.directory, state.identity.instance)), false);
});

test('two workspaces keep separate grants and generations', (t) => {
    const left = workspaceFixture(t, 'left');
    const rightWorkspace = path.join(left.root, 'right');
    fs.mkdirSync(path.join(rightWorkspace, '.ploinky'), { recursive: true });
    const right = buildWorkspaceIdentity(rightWorkspace, { markerFound: true });
    const rightLock = { assertHeld(instance) { assert.equal(instance, right.instance); } };
    left.store.write(left.identity, GRANT, left.lock);
    assert.equal(left.store.read(right), null);
    const leftWiring = activeWiring(left.identity, { homeDirectory: left.home });
    const rightWiring = activeWiring(right, { homeDirectory: left.home });
    assert.notEqual(leftWiring.fingerprint, rightWiring.fingerprint);
    left.store.materialize(left.identity, leftWiring, left.lock);
    left.store.materialize(right, rightWiring, rightLock);
    left.store.prune(right, [], rightLock);
    assert.equal(fs.existsSync(leftWiring.files[0].path), true);
    assert.throws(() => left.store.write(right, GRANT, left.lock));
});

// ---------------------------------------------------------------------------
// The in-Box view of the grant and runtime admission
// ---------------------------------------------------------------------------

function boxMarkerFixture(t, { grant = GRANT, stale = false } = {}) {
    const state = workspaceFixture(t);
    const wiring = stale
        ? resolveGpuWiring(state.identity, grant, {
            discover: () => fakeHost({ library: '600.10' }).discover(),
            homeDirectory: state.home,
        })
        : activeWiring(state.identity, { grant, homeDirectory: state.home });
    state.store.materialize(state.identity, wiring, state.lock);
    const byDestination = Object.fromEntries(wiring.mounts.map((mount) => [mount.destination, mount.source]));
    const boxMarker = path.join(state.root, 'ploinky-box');
    fs.writeFileSync(boxMarker, 'assistos/ploinky-box\n');
    return {
        ...state,
        wiring,
        markerPath: byDestination[BOX_GPU_MARKER_PATH],
        specPath: byDestination[BOX_GPU_CDI_SPEC_PATH] || path.join(state.root, 'absent-spec.json'),
        boxMarker,
    };
}

function admit(box, runtimePolicy, { agentId = AGENT, markerPath = box.markerPath, specPath = box.specPath, runtime = 'podman' } = {}) {
    return admitManifestRuntimeCapabilities({ llmRuntime: { runtimePolicy } }, {
        agentId,
        runtime,
        boxMarkerOptions: { markerPath: box.boxMarker },
        gpuGrantOptions: { markerPath, specPath },
        workspaceRoot: box.identity.workspaceRoot,
    });
}

const GRANTED_DEVICE = Object.freeze({ devices: [{ type: 'cdi', value: BOX_GPU_CDI_DEVICE }] });

test('the in-Box marker is trusted only for this workspace and its mounted spec', (t) => {
    const box = boxMarkerFixture(t);
    const view = readBoxGpuGrant({ workspaceRoot: box.identity.workspaceRoot, markerPath: box.markerPath, specPath: box.specPath });
    assert.equal(view.valid, true);
    assert.equal(view.state, 'active');
    assert.deepEqual(view.agents, [AGENT]);
    assert.equal(view.fingerprint, box.wiring.fingerprint);
    const foreign = readBoxGpuGrant({ workspaceRoot: path.join(box.root, 'other'), markerPath: box.markerPath, specPath: box.specPath });
    assert.match(foreign.problem, /another workspace/);
    const otherSpec = path.join(box.root, 'other-spec.json');
    fs.writeFileSync(otherSpec, '{}\n');
    const mismatched = readBoxGpuGrant({ workspaceRoot: box.identity.workspaceRoot, markerPath: box.markerPath, specPath: otherSpec });
    assert.match(mismatched.problem, /does not match the mounted CDI spec/);
    assert.deepEqual(
        readBoxGpuGrant({ workspaceRoot: box.identity.workspaceRoot, markerPath: path.join(box.root, 'none'), specPath: box.specPath }),
        { present: false },
    );
});

test('admission allows the one granted CDI device for a named agent and renders it', (t) => {
    const box = boxMarkerFixture(t);
    const admission = admit(box, GRANTED_DEVICE);
    assert.equal(admission.descriptor.gpuGrant.admitted, true);
    const args = renderRuntimePolicyArgs(admission.descriptor, { runtime: 'podman' });
    assert.deepEqual(args.slice(args.indexOf('--device'), args.indexOf('--device') + 2), ['--device', BOX_GPU_CDI_DEVICE]);
    assert.doesNotThrow(() => assertRuntimeAdmissionCurrent(admission, {
        boxMarkerOptions: { markerPath: box.boxMarker },
    }));
    // Revocation or replacement of the grant is caught immediately before launch.
    fs.rmSync(box.markerPath);
    assert.throws(
        () => assertRuntimeAdmissionCurrent(admission, { boxMarkerOptions: { markerPath: box.boxMarker } }),
        (error) => error.code === 'PLOINKY_RUNTIME_INPUT_CHANGED' && /GPU grant changed/.test(error.message),
    );
});

test('admission rejects CDI without a grant, for an unnamed agent, or for another CDI id', (t) => {
    const box = boxMarkerFixture(t);
    const rejects = (fn, pattern) => assert.throws(fn, (error) => (
        error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED'
        && error.context.unsupported.includes('cdi')
        && pattern.test(error.message)
    ));
    rejects(() => admit(box, GRANTED_DEVICE, { markerPath: path.join(box.root, 'no-marker') }), /no GPU grant/);
    rejects(() => admit(box, GRANTED_DEVICE, { agentId: 'lab/other' }), /does not name lab\/other/);
    rejects(() => admit(box, { devices: [{ type: 'cdi', value: 'nvidia.com/gpu=all' }] }), /only the single device ploinky\.local\/gpu=all/);
    rejects(() => admit(box, { devices: [
        { type: 'cdi', value: BOX_GPU_CDI_DEVICE },
        { type: 'cdi', value: 'nvidia.com/gpu=all' },
    ] }), /only the single device/);
});

test('a stale grant fails only GPU-requesting agents, with the actionable message', (t) => {
    const box = boxMarkerFixture(t, { stale: true });
    assert.throws(
        () => admit(box, GRANTED_DEVICE),
        (error) => error.context.unsupported.includes('cdi')
            && /GPU grant stale: .*version mismatch.*; fix the host GPU driver, then run `ploinky restart` on the host/.test(error.message),
    );
    assert.doesNotThrow(() => admit(box, {}));
});

test('host devices, --gpus, host IPC and security options stay rejected with a grant', (t) => {
    const box = boxMarkerFixture(t);
    assert.throws(() => admit(box, { devices: [{ type: 'hostDevice', hostPath: '/dev/nvidia0' }] }), /\/dev\/nvidia0.*not in the allowlist/);
    assert.throws(() => admit(box, { gpus: 'all' }), /podman does not support --gpus/);
    const unsupported = (policy, capability, options = {}) => assert.throws(
        () => admit(box, policy, options),
        (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED'
            && error.context.unsupported.includes(capability),
        capability,
    );
    unsupported({ devices: [{ type: 'hostDevice', hostPath: '/dev/dri' }] }, 'devices');
    unsupported({ devices: [{ type: 'cdi', value: BOX_GPU_CDI_DEVICE }, { type: 'hostDevice', hostPath: '/dev/dri' }] }, 'devices');
    unsupported({ gpus: 'all' }, 'gpu', { runtime: '' });
    unsupported({ ...GRANTED_DEVICE, ipc: 'host' }, 'host-ipc');
    unsupported({ ...GRANTED_DEVICE, securityOpt: ['label=disable'] }, 'security-options');
});

test('runtimePolicy.resources.shmSize renders without llmRuntime.enabled', () => {
    const admission = admitManifestRuntimeCapabilities({
        llmRuntime: { runtimePolicy: { resources: { shmSize: '2g' } } },
    }, { agentId: AGENT, runtime: 'podman', insideBox: true });
    assert.equal(admission.descriptor.capabilities.llmRuntime, false);
    const args = renderRuntimePolicyArgs(admission.descriptor, { runtime: 'podman' });
    assert.deepEqual(args.slice(args.indexOf('--shm-size'), args.indexOf('--shm-size') + 2), ['--shm-size', '2g']);
});

// ---------------------------------------------------------------------------
// The Box contract and reconciliation
// ---------------------------------------------------------------------------

function boxFixture(t) {
    const state = workspaceFixture(t);
    const seccomp = nestedPodmanSeccompProfilePath(state.root);
    fs.mkdirSync(path.dirname(seccomp), { recursive: true });
    fs.copyFileSync(new URL('../../ploinky-box/seccomp/podman-nested-pid-fallback.json', import.meta.url), seccomp);
    const lockPath = path.join(state.root, 'lock');
    fs.mkdirSync(lockPath);
    return {
        ...state,
        lock: { path: lockPath, assertHeld(instance) { assert.equal(instance, state.identity.instance); } },
        agentLib: agentLibFixture(state.identity.workspaceRoot),
    };
}

function containerHandle(state, { id = OLD_ID, imageId = OLD_IMAGE, hostPort = 8090, running = true, gpu = null } = {}) {
    return {
        id,
        labels: {
            ...agentLibFixtureLabels(state.agentLib),
            [BOX_LABELS.pathHash]: state.identity.pathHash,
            [BOX_LABELS.role]: 'box',
            [BOX_LABELS.imageRef]: BOX_IMAGE_REFERENCE,
            [BOX_LABELS.routerHostPort]: String(hostPort),
            [BOX_LABELS.mediaHostPort]: '7882',
            [BOX_LABELS.seccompFingerprint]: nestedPodmanSeccompProfileContract(state.root).fingerprint,
            [BOX_LABELS.dependenciesFingerprint]: DATA_FINGERPRINTS.dependencies,
            [BOX_LABELS.imagesFingerprint]: DATA_FINGERPRINTS.images,
            ...(gpu ? { [BOX_LABELS.gpuGrant]: gpu.fingerprint } : {}),
        },
        runtime: {
            complete: true,
            imageId,
            configuredImage: imageId,
            user: 'podman',
            workingDir: state.identity.workspaceRoot,
            createCommand: [
                'podman', 'container', 'create', '--init', '--userns', BOX_USERNS,
                '--device', '/dev/fuse', '--device', '/dev/net/tun',
                ...(gpu ? gpu.devices.flatMap((device) => ['--device', device]) : []),
                '--tmpfs', TMPFS_CREATE_ARGUMENT,
            ],
            environment: {
                ...IMAGE_CONTRACT.environment,
                PLOINKY_WORKSPACE_ROOT: state.identity.workspaceRoot,
                ...agentLibFixtureEnv(state.agentLib),
                PLOINKY_PRIVATE_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_AUTHORITY: `127.0.0.1:${hostPort}`,
                PLOINKY_ROUTER_HEALTH_SOCKET: BOX_ROUTER_HEALTH_SOCKET,
                HOSTNAME: id.slice(0, 12),
            },
            publications: [
                { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '7882' },
                { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: String(hostPort) },
            ],
            running,
            status: running ? 'running' : 'exited',
            init: true,
            usernsMode: 'private',
            privileged: false,
            securityOptions: ['label=disable', 'unmask=ALL', `seccomp=${nestedPodmanSeccompProfilePath(state.root)}`],
            // Rootless Podman on this host reports no devices; the recorded
            // create arguments are then the proof (the validator's CreateCommand path).
            devices: [],
            tmpfs: [{ destination: BOX_TMPFS.destination, options: [...TMPFS_INSPECTED_OPTIONS] }],
            mounts: [
                { type: 'bind', name: '', source: state.identity.dataPaths.images, destination: '/home/podman/.local/share/ploinky-images', rw: true },
                { type: 'bind', name: '', source: state.root, destination: '/opt/ploinky', rw: false },
                { type: 'bind', name: '', source: state.identity.dataPaths.dependencies, destination: '/opt/ploinky/node_modules', rw: true },
                { type: 'bind', name: '', source: state.identity.workspaceRoot, destination: state.identity.workspaceRoot, rw: true },
                ...agentLibFixtureMounts(state.agentLib, state.identity.workspaceRoot),
                ...(gpu ? gpu.mounts.map((mount) => ({ type: 'bind', name: '', source: mount.source, destination: mount.destination, rw: false })) : []),
            ].sort((left, right) => left.destination.localeCompare(right.destination)),
        },
    };
}

function desiredFor(state, gpu) {
    return {
        identity: state.identity,
        dataFingerprints: DATA_FINGERPRINTS,
        agentLib: state.agentLib,
        hostPort: 8090,
        imageId: OLD_IMAGE,
        imageRef: BOX_IMAGE_REFERENCE,
        repositoryRoot: state.root,
        gpu,
    };
}

test('the Box contract accepts exactly the grant devices, binds and label', (t) => {
    const state = boxFixture(t);
    const wiring = activeWiring(state.identity);
    const handle = containerHandle(state, { gpu: wiring });
    assert.doesNotThrow(() => validateContainerConfiguration(handle, desiredFor(state, wiring)));
    assert.doesNotThrow(() => validateContainerConfiguration(handle, desiredFor(state, undefined)));
    const observed = observeContainerGpuWiring(handle, { identity: state.identity });
    assert.equal(observed.fingerprint, wiring.fingerprint);
    assert.deepEqual(observed.devices, wiring.devices);

    // The populated HostConfig.Devices form must list the same set.
    const inspected = structuredClone(handle);
    inspected.runtime.devices = ['/dev/fuse', '/dev/net/tun', ...wiring.devices]
        .map((device) => ({ hostPath: device, containerPath: device, permissions: 'rwm' }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.doesNotThrow(() => validateContainerConfiguration(inspected, desiredFor(state, wiring)));
    inspected.runtime.devices.pop();
    assert.throws(() => validateContainerConfiguration(inspected, desiredFor(state, wiring)), /device set is incompatible/);

    const extraDevice = structuredClone(handle);
    extraDevice.runtime.createCommand.push('--device', '/dev/nvidia-uvm-tools');
    assert.throws(() => validateContainerConfiguration(extraDevice, desiredFor(state, wiring)), /device set is incompatible/);
    const extraMount = structuredClone(handle);
    extraMount.runtime.mounts.push({ type: 'bind', name: '', source: `${LIB}/libEGL.so.1`, destination: '/usr/local/nvidia/lib64/libEGL.so.1', rw: false });
    assert.throws(() => validateContainerConfiguration(extraMount, desiredFor(state, wiring)), /mount set is incompatible/);
    const writableMount = structuredClone(handle);
    writableMount.runtime.mounts.find((mount) => mount.destination === BOX_GPU_MARKER_PATH).rw = true;
    assert.throws(() => validateContainerConfiguration(writableMount, desiredFor(state, wiring)), /is incompatible/);
    const extraLabel = structuredClone(handle);
    extraLabel.labels['io.assistos.ploinky-box.gpu-extra'] = 'x';
    assert.throws(() => validateContainerConfiguration(extraLabel, desiredFor(state, wiring)), /label set is incompatible/);
    // A Box without the grant is not accepted as a granted one, and vice versa.
    assert.throws(() => validateContainerConfiguration(containerHandle(state), desiredFor(state, wiring)), /incompatible/);
    assert.throws(() => validateContainerConfiguration(handle, desiredFor(state, null)), /incompatible/);
});

function optionValues(args, name) {
    return args.flatMap((value, index) => (value === name ? [args[index + 1]] : []));
}

// The fake engine records a created Box exactly as its create arguments
// describe it, including GPU devices, read-only binds and the grant label.
function harness(state, { initial = null, failCandidateReady = false } = {}) {
    const calls = [];
    const materialized = [];
    let current = initial;
    let createCount = 0;
    const runner = {
        run(command, args) {
            calls.push(['run', command, ...args]);
            if (args[0] === 'container' && args[1] === 'create') {
                createCount += 1;
                const id = createCount === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
                fs.writeFileSync(args[args.indexOf('--cidfile') + 1], `${id}\n`, { mode: 0o600 });
                const hostPort = Number(optionValues(args, '--publish')[0].split(':')[1]);
                const created = containerHandle(state, { id, imageId: args.at(-1), hostPort, running: false });
                created.runtime.createCommand = ['podman', ...args.slice(0, args.indexOf('--cidfile'))];
                for (const label of optionValues(args, '--label')) {
                    const separator = label.indexOf('=');
                    created.labels[label.slice(0, separator)] = label.slice(separator + 1);
                }
                const known = new Set(created.runtime.mounts.map((mount) => mount.destination));
                for (const volume of optionValues(args, '--volume')) {
                    const [source, destination, mode] = volume.split(':');
                    if (known.has(destination)) continue;
                    created.runtime.mounts.push({ type: 'bind', name: '', source, destination, rw: mode !== 'ro' });
                }
                created.runtime.mounts.sort((left, right) => left.destination.localeCompare(right.destination));
                current = created;
            }
            if (args[0] === 'container' && args[1] === 'start') current.runtime.running = true;
            if (args[0] === 'container' && args[1] === 'stop') current.runtime.running = false;
            if (args[0] === 'container' && args[1] === 'rm') current = null;
        },
        async stream(command, args) {
            calls.push(['stream', command, ...args]);
            return { ok: true, status: 0 };
        },
        query() {
            return { ok: true, stdout: `${BOX_READY_LINE}\n` };
        },
    };
    const seams = {
        async preflight(options) {
            return { ...options, recheckAfterRelease: { tcp: false, udp: false } };
        },
        async recheckReleased() {},
        validateImage: () => ({ immutableId: 'c'.repeat(64) }),
        validateExistingImage: (_engine, imageId) => ({ immutableId: imageId }),
        removeContainer(engine, id, selectedRunner) { selectedRunner.run(engine.name, ['container', 'rm', '-f', id]); },
        stopPloinkyLocal() {},
        async startAndWaitReady(engine, id, selectedRunner) {
            selectedRunner.run(engine.name, ['container', 'start', id]);
            if (failCandidateReady && id === 'a'.repeat(64)) throw new Error('ready timeout');
        },
        discover: () => (current ? { state: 'owned', handles: { container: current } } : { state: 'absent', handles: null }),
        ensureDataPaths: () => ({ paths: state.identity.dataPaths, fingerprints: DATA_FINGERPRINTS, created: [] }),
        inspectDataPaths: () => ({ paths: state.identity.dataPaths, fingerprints: DATA_FINGERPRINTS }),
        revalidateDataPaths: () => ({ paths: state.identity.dataPaths, fingerprints: DATA_FINGERPRINTS }),
        retireStartLock() {},
        retireEdgePreparation() {},
        materializeGpu(identity, wiring, lock) {
            lock.assertHeld(identity.instance);
            if (wiring) materialized.push(wiring.fingerprint);
        },
        token: (kind) => (kind === 'candidate' ? '1'.repeat(24) : '2'.repeat(24)),
    };
    return { runner, seams, calls, materialized, current: () => current };
}

function reconcileArguments(state, h, initial, extra = {}) {
    return {
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: initial ? { state: 'owned', handles: { container: initial } } : { state: 'absent', handles: null },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
        imagePolicy: 'preserve',
        stdout: { write() {} },
        stderr: { write() {} },
        ...extra,
    };
}

test('a new or changed wiring replaces the Box; the same or kept wiring reuses it', async (t) => {
    const state = boxFixture(t);
    const wiring = activeWiring(state.identity);
    const plain = containerHandle(state);

    const grant = harness(state, { initial: plain });
    const granted = await reconcileBoxContainer(reconcileArguments(state, grant, plain, { gpu: wiring }), grant.seams);
    granted.finalize();
    assert.equal(granted.action, 'replaced');
    assert.equal(granted.gpu.fingerprint, wiring.fingerprint);
    assert.equal(granted.previousGpu, null);
    assert.deepEqual(grant.materialized, [wiring.fingerprint]);
    const createArgs = grant.calls.find((call) => call[2] === 'container' && call[3] === 'create');
    assert.deepEqual(optionValues(createArgs, '--device'), ['/dev/fuse', '/dev/net/tun', ...wiring.devices]);
    assert.equal(createArgs.includes(`${BOX_LABELS.gpuGrant}=${wiring.fingerprint}`), true);

    const withGpu = grant.current();
    const same = harness(state, { initial: withGpu });
    const reused = await reconcileBoxContainer(reconcileArguments(state, same, withGpu, { gpu: wiring }), same.seams);
    assert.equal(reused.action, 'reused');
    const kept = await reconcileBoxContainer(reconcileArguments(state, same, withGpu), same.seams);
    assert.equal(kept.action, 'reused');
    assert.equal(kept.gpu.fingerprint, wiring.fingerprint);
    assert.equal(same.calls.some((call) => call[3] === 'create'), false);

    // A driver update changes the fingerprint and therefore the Box.
    const updated = activeWiring(state.identity, { host: fakeHost({ kernel: '600.10', library: '600.10' }) });
    const driver = harness(state, { initial: withGpu });
    const replaced = await reconcileBoxContainer(reconcileArguments(state, driver, withGpu, { gpu: updated }), driver.seams);
    assert.equal(replaced.action, 'replaced');
    assert.equal(replaced.previousGpu.fingerprint, wiring.fingerprint);

    // Revocation (null) removes the wiring.
    const revoke = harness(state, { initial: withGpu });
    const revoked = await reconcileBoxContainer(reconcileArguments(state, revoke, withGpu, { gpu: null }), revoke.seams);
    assert.equal(revoked.action, 'replaced');
    assert.equal(revoked.gpu, null);
    assert.equal(optionValues(revoke.calls.find((call) => call[3] === 'create'), '--device').length, 2);
});

test('a failed replacement restores the old Box with its own GPU wiring', async (t) => {
    const state = boxFixture(t);
    const wiring = activeWiring(state.identity);
    const old = containerHandle(state, { gpu: wiring });
    const h = harness(state, { initial: old, failCandidateReady: true });
    await assert.rejects(
        () => reconcileBoxContainer(reconcileArguments(state, h, old, { gpu: null }), h.seams),
        (error) => error.boxRollback?.action === 'restored' && error.boxRollback.gpu.fingerprint === wiring.fingerprint,
    );
    const creates = h.calls.filter((call) => call[3] === 'create');
    assert.equal(creates.length, 2);
    assert.deepEqual(optionValues(creates[1], '--device'), ['/dev/fuse', '/dev/net/tun', ...wiring.devices]);
    assert.equal(h.current().labels[BOX_LABELS.gpuGrant], wiring.fingerprint);
});

// ---------------------------------------------------------------------------
// Supervisor lifecycle: grant, repeat, revoke, driver change, rollback
// ---------------------------------------------------------------------------

function fakeLockManager(root, events) {
    return {
        async acquire(instance) {
            const lockPath = fs.mkdtempSync(path.join(root, 'supervisor-lock-'));
            events.push('lock');
            let released = false;
            return {
                path: lockPath,
                assertHeld(expected) {
                    assert.equal(released, false);
                    assert.equal(expected, instance);
                },
                release() {
                    released = true;
                    events.push('release');
                },
            };
        },
    };
}

function memoryGpuStore(events, initial = null) {
    let value = initial;
    return {
        homeDirectory: os.homedir(),
        get value() { return value; },
        read() { return value; },
        write(identity, grant, lock, { admitted = null } = {}) {
            lock.assertHeld(identity.instance);
            const denied = [...(grant.denied || [])];
            const workspaceDenied = grant.workspaceDenied === true;
            events.push(`grant-write:${grant.agents.join(',')}:${admitted?.state || 'none'}`
                + `${denied.length ? `:denied=${denied.join(',')}` : ''}${workspaceDenied ? ':workspace-denied' : ''}`);
            value = Object.freeze({ vendor: grant.vendor, agents: [...grant.agents], denied, workspaceDenied, admitted });
            return value;
        },
        clear(identity, lock) {
            lock.assertHeld(identity.instance);
            events.push('grant-clear');
            value = null;
        },
        restore(identity, previous, lock) {
            lock.assertHeld(identity.instance);
            events.push(`grant-restore:${previous ? previous.agents.join(',') : 'none'}`);
            value = previous;
        },
        materialize() {},
        prune(identity, keep, lock) {
            lock.assertHeld(identity.instance);
            events.push(`prune:${keep.length}`);
            return [];
        },
    };
}

function graphBox(t, { gpu = null, running = true } = {}) {
    const state = boxFixture(t);
    fs.writeFileSync(path.join(state.identity.anchorPath, 'routing.json'), JSON.stringify({
        static: { agent: 'explorer' },
        port: 8080,
        routes: {},
    }));
    const scopeEnv = buildHostSkillScope(state.identity.workspaceRoot, state.identity.workspaceRoot);
    writeGraphSkillScope(state.identity, scopeEnv, { assertHeld(instance) { assert.equal(instance, state.identity.instance); } });
    const container = containerHandle(state, { gpu: gpu ? gpu(state) : null, running });
    return { ...state, scopeEnv, container, ownership: { state: 'owned', engine: { name: 'podman', identity: 'engine' }, handles: { container } } };
}

function gpuSupervisor(box, events, overrides = {}) {
    return createBoxSupervisor({
        env: {},
        platform: 'linux',
        resolveIdentity: () => box.identity,
        launchCwd: box.identity.workspaceRoot,
        lockManager: fakeLockManager(box.root, events),
        discover: () => box.ownership,
        repositoryRoot: box.root,
        runner: {
            run(_command, args) { events.push(`run:${args.join(' ')}`); },
            async stream(_command, args) {
                events.push(`stream:${args.at(-1)}`);
                return { ok: true, status: 0 };
            },
            query() {
                return { ok: true, status: 0, stdout: JSON.stringify({
                    state: 'running', initialized: true, routingConfigured: true, trackedAgents: 1, runningAgents: 1, warnings: [],
                }) };
            },
        },
        gpuGrantStore: memoryGpuStore(events),
        discoverGpuDevices: () => fakeHost().discover(),
        routerBindingStore: { read: () => null, write: () => assert.fail('GPU grants never save a Router binding'), restore() {} },
        resolveHostReachableIpv4: async () => '127.0.0.1',
        selectAgentLib: async () => assert.fail('a GPU grant keeps the mounted AgentLib generation'),
        commitAgentLibSelection: () => assert.fail('a GPU grant must not advance AgentLib state'),
        stdout: { write() {} },
        stderr: { write() {} },
        ...overrides,
    });
}

function inOrder(events, markers) {
    const indexes = markers.map((marker) => events.findIndex((event) => event.startsWith(marker)));
    assert.equal(indexes.every((index) => index >= 0), true, `${JSON.stringify(markers)} in ${JSON.stringify(events)}`);
    assert.deepEqual([...indexes].sort((left, right) => left - right), indexes, JSON.stringify(events));
}

function prepared(box, action, gpu, events) {
    return {
        action,
        ownership: box.ownership,
        hostPort: 8090,
        mediaHostPort: 7882,
        routerBinding: { address: '127.0.0.1', hostPort: 8090, hosts: null },
        gpu,
        finalize() { events.push('finalize'); },
        async rollback() {
            events.push('outer-rollback');
            return { action: 'restored', containerId: box.container.id, hostPort: 8090, mediaHostPort: 7882, agentLib: box.agentLib };
        },
    };
}

test('grant replaces the Box, restarts the graph, proves health, then saves the record', async (t) => {
    const box = graphBox(t);
    const events = [];
    const store = memoryGpuStore(events);
    let requested;
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        async reconcile(options) {
            options.lock.assertHeld(box.identity.instance);
            assert.equal(options.imagePolicy, 'preserve');
            assert.equal(options.routerBinding, null);
            requested = options.gpu;
            events.push('reconcile');
            return prepared(box, 'replaced', options.gpu, events);
        },
        async startCore(_engine, _id, argv) {
            assert.deepEqual(argv, ['start', 'explorer', '8080']);
            events.push('start-core');
        },
        async healthCheck() { events.push('health'); },
    });
    const result = await supervisor.runGpuGrantTransaction({ vendor: 'nvidia', agents: [AGENT] });
    assert.equal(result.action, 'replaced');
    assert.equal(requested.state, 'active');
    assert.deepEqual(requested.agents, [AGENT]);
    assert.deepEqual(store.value, {
        vendor: 'nvidia', agents: [AGENT], denied: [], workspaceDenied: false,
        admitted: { fingerprint: requested.fingerprint, state: 'active', reason: null },
    });
    inOrder(events, ['lock', 'reconcile', 'stream:/opt/ploinky/bin/ploinky-install-deps', 'start-core', 'health', 'grant-write', 'finalize', 'prune', 'release']);
    assert.match(formatGpuGrantResult(result), new RegExp(`GPU grant for ${box.identity.instance}: nvidia for ${AGENT}`));
});

test('a repeated grant is idempotent: health is proven and nothing restarts', async (t) => {
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    const events = [];
    const wiring = activeWiring(box.identity);
    const store = memoryGpuStore(events, Object.freeze({ vendor: 'nvidia', agents: [AGENT], admitted: { fingerprint: wiring.fingerprint, state: 'active', reason: null } }));
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        async reconcile(options) {
            assert.equal(options.gpu.fingerprint, wiring.fingerprint);
            return prepared(box, 'reused', options.gpu, events);
        },
        startCore: async () => assert.fail('an unchanged grant does not restart the graph'),
        async healthCheck() { events.push('health'); },
    });
    const result = await supervisor.runGpuGrantTransaction({ vendor: 'nvidia', agents: [AGENT] });
    assert.equal(result.action, 'unchanged');
    assert.equal(result.graphStarted, false);
    assert.equal(events.includes('health'), true);
    assert.equal(events.some((event) => event.startsWith('run:') || event.startsWith('stream:')), false);
});

test('revoking while running removes the wiring and then records the workspace revoke', async (t) => {
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    const events = [];
    const store = memoryGpuStore(events, Object.freeze({ vendor: 'nvidia', agents: [AGENT, 'lab/other'], admitted: null }));
    const seen = [];
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        async reconcile(options) {
            seen.push(options.gpu);
            return prepared(box, 'replaced', options.gpu, events);
        },
        async startCore() { events.push('start-core'); },
        async healthCheck() { events.push('health'); },
    });
    const partial = await supervisor.runGpuRevokeTransaction({ agents: ['lab/other'] });
    assert.deepEqual(seen[0].agents, [AGENT]);
    assert.deepEqual(store.value.agents, [AGENT]);
    assert.equal(partial.grant.agents.length, 1);
    // D14: revoking an agent the operator never granted records a deny that
    // would override its manifest; it declares nothing here, so the wiring stays.
    await supervisor.runGpuRevokeTransaction({ agents: ['lab/unknown'] });
    assert.deepEqual(seen.at(-1).agents, [AGENT]);
    // Both per-agent revokes are recorded as denies (D14).
    assert.deepEqual(store.value.denied, ['lab/other', 'lab/unknown']);
    // A whole revoke withdraws every grant and persists the workspace revoke.
    const full = await supervisor.runGpuRevokeTransaction({});
    assert.equal(seen.at(-1), null);
    assert.deepEqual({ agents: store.value.agents, denied: store.value.denied, workspaceDenied: store.value.workspaceDenied },
        { agents: [], denied: ['lab/other', 'lab/unknown'], workspaceDenied: true });
    assert.deepEqual(full.grant.agents, []);
    inOrder(events.slice(events.lastIndexOf('lock')),
        ['lock', 'start-core', 'health', 'grant-write::none:denied=lab/other,lab/unknown:workspace-denied', 'finalize', 'release']);
});

test('a failed replacement reports the previous grant still in force and restores the record', async (t) => {
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    const events = [];
    const saved = Object.freeze({ vendor: 'nvidia', agents: [AGENT], admitted: null });
    const store = memoryGpuStore(events, saved);
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        // Final ownership validation fails after the record was written.
        reconcile: async (options) => ({
            ...prepared(box, 'replaced', options.gpu, events),
            finalize() {
                events.push('finalize');
                throw new Error('final Box validation failed');
            },
        }),
        async startCore() { events.push('start-core'); },
        async runCoreCommand() { events.push('restore-graph'); },
        async healthCheck() { events.push('health'); },
    });
    await assert.rejects(
        () => supervisor.runGpuRevokeTransaction({}),
        (error) => /gpu revoke did not complete; the previous GPU grant \(nvidia for local-llms\/local-llm\) is still in force: final Box validation failed$/
            .test(error.message),
    );
    assert.equal(store.value, saved);
    inOrder(events, ['grant-write::none:workspace-denied', 'finalize', 'outer-rollback', 'restore-graph', 'grant-restore:local-llms/local-llm']);
});

test('start rediscovers the driver: a changed fingerprint is a replacement and is recorded after health', async (t) => {
    const oldWiring = (state) => activeWiring(state.identity);
    const box = graphBox(t, { gpu: oldWiring });
    const events = [];
    const previousFingerprint = oldWiring(box).fingerprint;
    const store = memoryGpuStore(events, Object.freeze({
        vendor: 'nvidia', agents: [AGENT], admitted: { fingerprint: previousFingerprint, state: 'active', reason: null },
    }));
    let requested;
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        discoverGpuDevices: () => fakeHost({ kernel: '600.10', library: '600.10' }).discover(),
        selectAgentLib: async () => ({ selection: box.agentLib }),
        commitAgentLibSelection: () => {},
        revalidateAgentLibSource: () => {},
        async reconcile(options) {
            requested = options.gpu;
            return prepared(box, 'replaced', options.gpu, events);
        },
        async startCore() { events.push('start-core'); },
        async healthCheck() { events.push('health'); },
    });
    await supervisor.runStartTransaction(['start', 'explorer', '8080']);
    assert.notEqual(requested.fingerprint, previousFingerprint);
    assert.equal(store.value.admitted.fingerprint, requested.fingerprint);
    inOrder(events, ['start-core', 'health', 'grant-write', 'finalize', 'prune']);
});

test('start with a failing discovery wires a stale grant and keeps the workspace up', async (t) => {
    const box = graphBox(t);
    const events = [];
    const warnings = [];
    const store = memoryGpuStore(events, Object.freeze({ vendor: 'nvidia', agents: [AGENT], admitted: null }));
    let requested;
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        discoverGpuDevices: () => fakeHost({ missing: ['/dev/nvidia0'] }).discover(),
        selectAgentLib: async () => ({ selection: box.agentLib }),
        commitAgentLibSelection: () => {},
        revalidateAgentLibSource: () => {},
        stderr: { write(text) { warnings.push(text); } },
        async reconcile(options) {
            requested = options.gpu;
            return prepared(box, 'replaced', options.gpu, events);
        },
        async startCore() {},
        async healthCheck() {},
    });
    await supervisor.runStartTransaction(['start', 'explorer', '8080']);
    assert.equal(requested.state, 'stale');
    assert.deepEqual(requested.devices, []);
    assert.equal(store.value.admitted.state, 'stale');
    assert.match(warnings.join(''), /GPU grant stale: NVIDIA device node \/dev\/nvidia0 is missing/);
});

test('ad hoc commands and bind keep an existing Box GPU wiring; without a Box a grant only saves the record', async (t) => {
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    const events = [];
    let requested = 'unset';
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: memoryGpuStore(events, Object.freeze({ vendor: 'nvidia', agents: [AGENT], admitted: null })),
        selectAgentLib: async () => ({ selection: box.agentLib }),
        async reconcile(options) {
            requested = options.gpu;
            return prepared(box, 'reused', box.container.labels ? undefined : null, events);
        },
    });
    await supervisor.prepareBoxForCommand();
    assert.equal(requested, undefined);

    const empty = graphBox(t);
    empty.ownership = { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: null };
    const emptyEvents = [];
    const emptyStore = memoryGpuStore(emptyEvents);
    const saver = gpuSupervisor(empty, emptyEvents, {
        gpuGrantStore: emptyStore,
        reconcile: async () => assert.fail('no Box, nothing to reconcile'),
    });
    const saved = await saver.runGpuGrantTransaction({ vendor: 'nvidia', agents: [AGENT] });
    assert.equal(saved.action, 'saved');
    assert.deepEqual(emptyStore.value.agents, [AGENT]);
    assert.match(formatGpuGrantResult(saved), /next `ploinky start` applies it/);
});

test('grant refuses before any mutation when discovery fails or no graph is configured', async (t) => {
    const box = graphBox(t);
    const events = [];
    const store = memoryGpuStore(events);
    const failing = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        discoverGpuDevices: () => fakeHost({ inaccessible: ['/dev/nvidia0'] }).discover(),
        reconcile: async () => assert.fail('discovery fails first'),
    });
    await assert.rejects(
        () => failing.runGpuGrantTransaction({ vendor: 'nvidia', agents: [AGENT] }),
        { code: 'PLOINKY_BOX_GPU_DISCOVERY_FAILED' },
    );
    await assert.rejects(() => failing.runGpuGrantTransaction({ vendor: 'amd', agents: [AGENT] }), /Unsupported GPU vendor/);
    fs.rmSync(path.join(box.identity.anchorPath, 'routing.json'));
    const noGraph = gpuSupervisor(box, events, { gpuGrantStore: store, reconcile: async () => assert.fail('no graph') });
    await assert.rejects(() => noGraph.runGpuGrantTransaction({ vendor: 'nvidia', agents: [AGENT] }), { code: 'PLOINKY_BOX_GPU_GRAPH_REQUIRED' });
    assert.equal(store.value, null);
    assert.equal(events.some((event) => event.startsWith('grant-write')), false);
});

test('gpu status reports the record, the host and a pending replacement without mutation', (t) => {
    const box = graphBox(t);
    const events = [];
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: memoryGpuStore(events, Object.freeze({ vendor: 'nvidia', agents: [AGENT], admitted: null })),
    });
    const status = supervisor.inspectGpuGrant();
    assert.equal(status.pendingReplacement, true);
    assert.equal(status.host.available, true);
    const text = formatGpuGrantStatus(status);
    assert.match(text, /GPU grant: nvidia for local-llms\/local-llm/);
    assert.match(text, new RegExp(`Host GPU: nvidia driver ${DRIVER.replaceAll('.', '\\.')}`));
    assert.match(text, /Box: running; GPU wiring none/);
    assert.match(text, /next `ploinky start` or `ploinky restart` replaces the Box/);
    assert.equal(events.some((event) => event === 'lock' || event.startsWith('grant-')), false);
});

// ---------------------------------------------------------------------------
// CLI: parsing and host-only routing
// ---------------------------------------------------------------------------

test('gpu commands parse strictly and route only to the host supervisor', async () => {
    const grant = parseOuterArguments(['gpu', 'grant', '--agent', AGENT, '--agent=lab/other']);
    assert.deepEqual(grant.gpu, { action: 'grant', vendor: 'nvidia', agents: [AGENT, 'lab/other'] });
    assert.deepEqual(routeOuterCommand(grant), { kind: 'gpu-grant', vendor: 'nvidia', agents: [AGENT, 'lab/other'] });
    assert.equal(routeOuterCommand(parseOuterArguments(['gpu'])).kind, 'gpu-status');
    assert.equal(routeOuterCommand(parseOuterArguments(['gpu', 'revoke'])).kind, 'gpu-revoke');
    for (const argv of [
        ['gpu', 'grant', '--agent'],
        ['gpu', 'grant', '--vendor', 'nvidia', '--vendor', 'nvidia', '--agent', AGENT],
        ['gpu', 'frob'],
        ['gpu', 'status', 'extra'],
        ['gpu', 'revoke', '--force'],
    ]) {
        assert.throws(() => parseOuterArguments(argv), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' }, argv.join(' '));
    }
    assert.throws(() => routeOuterCommand(parseOuterArguments(['--dry-run', 'gpu', 'status'])), /no --dry-run/);
    assert.throws(() => parseOuterArguments(['--port', '8090', 'gpu', 'status']), /--port is valid only before start/);

    const calls = [];
    const output = { text: '', write(value) { this.text += value; } };
    const supervisor = {
        async runGpuGrantTransaction(request) {
            calls.push(['grant', request]);
            return { identity: { instance: 'ploinky-box-x-000000000000' }, action: 'unchanged', grant: { vendor: 'nvidia', agents: [AGENT] }, gpu: null };
        },
        async runGpuRevokeTransaction(request) {
            calls.push(['revoke', request]);
            return { identity: { instance: 'ploinky-box-x-000000000000' }, action: 'replaced', grant: null, gpu: null };
        },
        inspectGpuGrant() {
            calls.push(['status']);
            return {
                identity: { instance: 'ploinky-box-x-000000000000' }, grant: null, box: 'absent', boxGpu: null,
                host: { available: false, reason: 'no driver' }, desired: null, pendingReplacement: false,
            };
        },
    };
    const execute = () => assert.fail('gpu commands are never forwarded into the Box');
    for (const argv of [['gpu', 'grant', '--agent', AGENT], ['gpu', 'revoke'], ['gpu', 'status']]) {
        const code = await runOuterCli(argv, { supervisor, execute, detectInsideBox: () => false, output, errorOutput: output, env: {} });
        assert.equal(code, 0);
    }
    assert.deepEqual(calls, [['grant', { vendor: 'nvidia', agents: [AGENT] }], ['revoke', { agents: [] }], ['status']]);
    assert.match(output.text, /Host GPU: unavailable \(no driver\)/);
});

test('gpu grant takes no vendor word; --vendor is optional and checked', () => {
    // The only supported vendor is the default.
    assert.deepEqual(parseOuterArguments(['gpu', 'grant', '--agent', AGENT]).gpu,
        { action: 'grant', vendor: 'nvidia', agents: [AGENT] });
    for (const argv of [
        ['gpu', 'grant', '--agent', AGENT, '--vendor', 'nvidia'],
        ['gpu', 'grant', '--vendor=nvidia', '--agent', AGENT],
        ['gpu', 'grant', '--vendor', 'NVIDIA', '--agent', AGENT],
    ]) {
        assert.deepEqual(parseOuterArguments(argv).gpu, { action: 'grant', vendor: 'nvidia', agents: [AGENT] }, argv.join(' '));
    }
    // An unsupported or missing --vendor value is rejected with the supported list.
    for (const argv of [
        ['gpu', 'grant', '--agent', AGENT, '--vendor', 'amd'],
        ['gpu', 'grant', '--agent', AGENT, '--vendor=amd'],
    ]) {
        assert.throws(() => parseOuterArguments(argv),
            (error) => error.code === 'PLOINKY_BOX_ARGUMENT_INVALID' && /Unsupported GPU vendor "amd"; supported: nvidia/.test(error.message),
            argv.join(' '));
    }
    assert.throws(() => parseOuterArguments(['gpu', 'grant', '--agent', AGENT, '--vendor']), /--vendor requires VENDOR/);
    // The positional vendor of the old form is refused with the new usage.
    for (const argv of [
        ['gpu', 'grant', 'nvidia', '--agent', AGENT],
        ['gpu', 'grant', '--agent', AGENT, 'nvidia'],
    ]) {
        assert.throws(() => parseOuterArguments(argv), (error) => error.code === 'PLOINKY_BOX_ARGUMENT_INVALID'
            && /gpu grant takes no VENDOR argument/.test(error.message)
            && /ploinky gpu grant \[--agent REPO\/AGENT\.\.\.\] \[--vendor VENDOR\]/.test(error.message),
        argv.join(' '));
    }
    // D14 reverses the short-grant rule that --agent is required: `gpu grant`
    // alone lifts a workspace revoke so manifest defaults apply again.
    for (const argv of [['gpu', 'grant'], ['gpu', 'grant', '--vendor', 'nvidia']]) {
        assert.deepEqual(parseOuterArguments(argv).gpu, { action: 'grant', vendor: 'nvidia', agents: [] }, argv.join(' '));
    }
    // --vendor belongs to grant only.
    assert.throws(() => parseOuterArguments(['gpu', 'revoke', '--vendor', 'nvidia']), /gpu revoke does not accept option --vendor/);
});

test('the default GPU vendor is the only supported one; several require --vendor', async () => {
    const { GPU_GRANT_VENDORS, defaultGpuVendor } = await import('../../ploinky-box/gpuGrant.mjs');
    assert.equal(typeof defaultGpuVendor, 'function');
    assert.deepEqual([...GPU_GRANT_VENDORS], ['nvidia']);
    assert.equal(defaultGpuVendor(), 'nvidia');
    assert.throws(() => defaultGpuVendor(['nvidia', 'amd']), /choose one with --vendor; supported: nvidia, amd/);
});

// ---------------------------------------------------------------------------
// Regressions against the real store, real observed wirings and the default
// materialize seam (the fakes above cannot see these paths).
// ---------------------------------------------------------------------------

function useTempHome(t, root) {
    const home = path.join(root, 'real-home');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const previous = process.env.HOME;
    process.env.HOME = home;
    t.after(() => {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
    });
    assert.equal(os.homedir(), home);
    return home;
}

test('a GPU Box replaced for another reason keeps its wiring through the default materialize path', async (t) => {
    const state = boxFixture(t);
    useTempHome(t, state.root);
    useFakeHostFiles(t, fakeHost());
    const store = createGpuGrantStore();
    const wiring = activeWiring(state.identity);
    store.materialize(state.identity, wiring, state.lock);
    const old = containerHandle(state, { gpu: wiring });
    const h = harness(state, { initial: old });
    const { materializeGpu: _fake, ...seams } = h.seams;
    // A publication change (another host port) replaces the Box; gpu is left
    // undefined, as bind and ad hoc commands do, so the observed wiring is kept.
    const result = await reconcileBoxContainer(reconcileArguments(state, h, old, { explicitPort: 8091 }), seams);
    result.finalize();
    assert.equal(result.action, 'replaced');
    assert.equal(result.gpu.fingerprint, wiring.fingerprint);
    const create = h.calls.find((call) => call[3] === 'create');
    assert.deepEqual(optionValues(create, '--device'), ['/dev/fuse', '/dev/net/tun', ...wiring.devices]);

    // With its generation files gone, the kept wiring fails before the old Box is touched.
    const again = harness(state, { initial: old });
    const { materializeGpu: _again, ...againSeams } = again.seams;
    store.prune(state.identity, [], state.lock);
    await assert.rejects(
        () => reconcileBoxContainer(reconcileArguments(state, again, old, { explicitPort: 8092 }), againSeams),
        /GPU grant wiring preparation failed: GPU wiring file .* is missing/,
    );
    assert.equal(again.calls.some((call) => call[3] === 'stop' || call[3] === 'rm' || call[3] === 'create'), false);
    assert.equal(again.current(), old);
});

function observedPrepared(box, action, events) {
    return {
        ...prepared(box, action, observeContainerGpuWiring(box.container, { identity: box.identity }), events),
    };
}

test('a repeated grant and a later start record the desired wiring when the Box is reused', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    useFakeHostFiles(t, fakeHost());
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    const events = [];
    const store = createGpuGrantStore();
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        // The real reconcile returns the wiring observed from the reused Box,
        // which has no stale reason and no file contents.
        reconcile: async () => observedPrepared(box, 'reused', events),
        async startCore() { events.push('start-core'); },
        async healthCheck() { events.push('health'); },
        selectAgentLib: async () => ({ selection: box.agentLib }),
        commitAgentLibSelection: () => {},
        revalidateAgentLibSource: () => {},
    });
    const lock = { assertHeld(instance) { assert.equal(instance, box.identity.instance); } };
    // Grant saved before the Box existed: the record has no admitted wiring yet.
    store.write(box.identity, GRANT, lock, { admitted: null });
    await supervisor.runStartTransaction(['start', 'explorer', '8080']);
    const expected = activeWiring(box.identity);
    assert.deepEqual(store.read(box.identity).admitted, { fingerprint: expected.fingerprint, state: 'active', reason: null });
    const repeated = await supervisor.runGpuGrantTransaction({ vendor: 'nvidia', agents: [AGENT] });
    assert.equal(repeated.action, 'unchanged');
    assert.deepEqual(store.read(box.identity).agents, [AGENT]);
    // D14: a deny of an agent that declares nothing is recorded in the real
    // store and leaves the reused Box's wiring as it is.
    const denied = await supervisor.runGpuRevokeTransaction({ agents: ['lab/unknown'] });
    assert.equal(denied.action, 'unchanged');
    assert.deepEqual(store.read(box.identity).agents, [AGENT]);
    assert.deepEqual(store.read(box.identity).denied, ['lab/unknown']);
});

test('revoking named agents without a record refuses instead of revoking everything', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    const supervisor = gpuSupervisor(box, [], {
        gpuGrantStore: createGpuGrantStore(),
        reconcile: async () => assert.fail('refused before reconciliation'),
    });
    await assert.rejects(() => supervisor.runGpuRevokeTransaction({ agents: [AGENT] }), /No GPU grant is recorded/);
});

test('a kept wiring whose driver files were removed refuses before the old Box is touched', async (t) => {
    const state = boxFixture(t);
    useTempHome(t, state.root);
    // The Box was wired for driver 590.1; a package upgrade replaced its
    // versioned library files with 595.91.07 ones, while the running Box pins
    // the old inodes.
    useFakeHostFiles(t, fakeHost());
    const store = createGpuGrantStore();
    const wiring = activeWiring(state.identity, { host: fakeHost({ kernel: '590.1', library: '590.1' }) });
    const old = containerHandle(state, { gpu: wiring });
    const h = harness(state, { initial: old });
    const { materializeGpu: _fake, ...seams } = h.seams;
    store.materialize(state.identity, wiring, state.lock);
    await assert.rejects(
        () => reconcileBoxContainer(reconcileArguments(state, h, old, { explicitPort: 8091 }), seams),
        /libcuda\.so\.590\.1, which is missing or unreadable \(ENOENT\); the host driver changed\. Run `ploinky restart`/,
    );
    assert.equal(h.calls.some((call) => ['stop', 'rm', 'create'].includes(call[3])), false);
    assert.equal(h.current(), old);
});

test('a kept wiring whose device node disappeared refuses with restart guidance', (t) => {
    const fixture = workspaceFixture(t);
    const wiring = activeWiring(fixture.identity, { homeDirectory: fixture.home });
    fixture.store.materialize(fixture.identity, wiring, fixture.lock);
    const kept = { ...wiring, files: undefined };
    useFakeHostFiles(t, fakeHost());
    assert.doesNotThrow(() => fixture.store.materialize(fixture.identity, kept, fixture.lock));
    t.mock.restoreAll();
    useFakeHostFiles(t, fakeHost({ missing: ['/dev/nvidia-uvm'] }));
    assert.throws(
        () => fixture.store.materialize(fixture.identity, kept, fixture.lock),
        /binds \/dev\/nvidia-uvm, which is missing \(ENOENT\); the host driver changed/,
    );
});

test('a failed revoke with no grant record names the Box GPU wiring that stays in force', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    const events = [];
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: memoryGpuStore(events, null),
        reconcile: async () => {
            throw Object.assign(new Error('candidate ready timeout'), {
                boxRollback: { action: 'preserved', containerId: box.container.id, oldStopAttempted: false, oldStartAttempted: false },
            });
        },
    });
    const fingerprint = box.container.labels[BOX_LABELS.gpuGrant];
    await assert.rejects(
        () => supervisor.runGpuRevokeTransaction({ agents: [] }),
        (error) => {
            assert.match(error.message, new RegExp(`the Box GPU wiring ${fingerprint} \\(active\\) is still in force`));
            assert.doesNotMatch(error.message, /\(none\)/);
            return true;
        },
    );
});

test('revoking on a Box without a graph points to destroy, not to starting agents', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    fs.rmSync(path.join(box.identity.anchorPath, 'routing.json'));
    const events = [];
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: memoryGpuStore(events, null),
        reconcile: async () => assert.fail('no graph'),
    });
    await assert.rejects(
        () => supervisor.runGpuRevokeTransaction({ agents: [] }),
        (error) => {
            assert.equal(error.code, 'PLOINKY_BOX_GPU_GRAPH_REQUIRED');
            assert.match(error.message, /ploinky destroy/);
            assert.match(error.message, /ploinky gpu revoke/);
            return true;
        },
    );
    await assert.rejects(
        () => supervisor.runGpuGrantTransaction({ vendor: 'nvidia', agents: ['lab/other'] }),
        (error) => error.code === 'PLOINKY_BOX_GPU_GRAPH_REQUIRED' && /run `ploinky start AGENT` first/.test(error.message),
    );
    // A grant that leaves the Box's wiring exactly as it is needs no graph:
    // only the record changes.
    const same = await supervisor.runGpuGrantTransaction({ vendor: 'nvidia', agents: [AGENT] });
    assert.equal(same.action, 'unchanged');
    assert.equal(events.filter((event) => /^(run|stream):/.test(event)).length, 0);
    assert.ok(events.includes('grant-write:local-llms/local-llm:active'));
});

const GPU_REQUEST = Object.freeze({ runtimePolicy: { devices: [{ type: 'cdi', value: 'ploinky.local/gpu=all' }] } });

// Records an enabled agent the way the in-Box CLI does: a registry entry in
// agents.json and a route whose hostPath holds the manifest.
function enableAgentRecord(box, { repo, agent, profile = 'default', manifest }) {
    const registryPath = path.join(box.identity.anchorPath, 'agents.json');
    const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : { _config: {} };
    registry[`ploinky_${repo}_${agent}`] = { type: 'agent', repoName: repo, agentName: agent, profile };
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    const agentDirectory = path.join(box.identity.workspaceRoot, repo, agent);
    fs.mkdirSync(agentDirectory, { recursive: true });
    if (manifest !== undefined) {
        fs.writeFileSync(path.join(agentDirectory, 'manifest.json'),
            typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    }
    const routingPath = path.join(box.identity.anchorPath, 'routing.json');
    const routing = JSON.parse(fs.readFileSync(routingPath, 'utf8'));
    routing.routes[agent] = { container: `ploinky_${repo}_${agent}`, hostPath: agentDirectory, repo, agent };
    fs.writeFileSync(routingPath, JSON.stringify(routing));
    return agentDirectory;
}

function reconcileReached(box) {
    return async () => {
        throw Object.assign(new Error('reached reconcile'), {
            boxRollback: { action: 'preserved', containerId: box.container.id, oldStopAttempted: false, oldStartAttempted: false },
        });
    };
}

test('revoke refuses before touching the Box while an enabled agent still requests the GPU', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    const PROFILED = 'tools/profiled';
    enableAgentRecord(box, { repo: 'local-llms', agent: 'local-llm', manifest: { llmRuntime: GPU_REQUEST } });
    enableAgentRecord(box, {
        repo: 'tools', agent: 'profiled', profile: 'gpu', manifest: { profiles: { gpu: { llmRuntime: GPU_REQUEST } } },
    });
    const events = [];
    const store = memoryGpuStore(events, Object.freeze({ vendor: 'nvidia', agents: [AGENT, PROFILED], admitted: null }));
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        reconcile: async () => assert.fail('refused before any Box change'),
    });
    await assert.rejects(
        () => supervisor.runGpuRevokeTransaction({ agents: [] }),
        (error) => {
            assert.equal(error.code, 'PLOINKY_BOX_GPU_AGENTS_ENABLED');
            assert.match(error.message, /enabled agents local-llms\/local-llm, tools\/profiled request the GPU/);
            assert.match(error.message, /`ploinky disable agent local-llms\/local-llm`/);
            assert.match(error.message, /`ploinky destroy`/);
            return true;
        },
    );
    await assert.rejects(
        () => supervisor.runGpuRevokeTransaction({ agents: [AGENT] }),
        (error) => error.code === 'PLOINKY_BOX_GPU_AGENTS_ENABLED'
            && /enabled agent local-llms\/local-llm requests the GPU/.test(error.message)
            && !/tools\/profiled/.test(error.message),
    );
    assert.deepEqual(events.filter((event) => /^(run|stream|grant-|prune)/.test(event)), []);
    assert.deepEqual(store.value.agents, [AGENT, PROFILED]);
});

test('the revoke pre-check skips agents that stay granted, request no GPU, or cannot be read', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    // Stays granted.
    enableAgentRecord(box, { repo: 'local-llms', agent: 'local-llm', manifest: { llmRuntime: GPU_REQUEST } });
    // No GPU request, or only in a profile the record does not select.
    enableAgentRecord(box, { repo: 'tools', agent: 'cpu', manifest: { llmRuntime: { runtimePolicy: {} } } });
    enableAgentRecord(box, { repo: 'tools', agent: 'unselected', manifest: { profiles: { gpu: { llmRuntime: GPU_REQUEST } } } });
    // Unreadable: a symlinked manifest, invalid JSON, a directory, no manifest.
    const linked = enableAgentRecord(box, { repo: 'tools', agent: 'linked' });
    const target = path.join(probe.root, 'outside-manifest.json');
    fs.writeFileSync(target, JSON.stringify({ llmRuntime: GPU_REQUEST }));
    fs.symlinkSync(target, path.join(linked, 'manifest.json'));
    enableAgentRecord(box, { repo: 'tools', agent: 'garbage', manifest: '{"llmRuntime": ' });
    const directory = enableAgentRecord(box, { repo: 'tools', agent: 'directory' });
    fs.mkdirSync(path.join(directory, 'manifest.json'));
    enableAgentRecord(box, { repo: 'tools', agent: 'missing' });
    const removed = ['tools/cpu', 'tools/unselected', 'tools/linked', 'tools/garbage', 'tools/directory', 'tools/missing'];
    const events = [];
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: memoryGpuStore(events, Object.freeze({ vendor: 'nvidia', agents: [AGENT, ...removed], admitted: null })),
        reconcile: reconcileReached(box),
    });
    await assert.rejects(
        () => supervisor.runGpuRevokeTransaction({ agents: removed }),
        (error) => error.code !== 'PLOINKY_BOX_GPU_AGENTS_ENABLED' && /reached reconcile/.test(error.message),
    );
    // An unreadable registry leaves the decision to the graph restart.
    fs.writeFileSync(path.join(box.identity.anchorPath, 'agents.json'), '{"ploinky_local-llms_local-llm": ');
    await assert.rejects(
        () => supervisor.runGpuRevokeTransaction({ agents: [] }),
        (error) => error.code !== 'PLOINKY_BOX_GPU_AGENTS_ENABLED' && /reached reconcile/.test(error.message),
    );
});

// ---------------------------------------------------------------------------
// D14: manifest-declared GPU access (`containerSecurity.gpu`), with the
// operator's grant and revoke as overrides. New functions are loaded
// dynamically so each test fails on its own against the pre-D14 code.
// ---------------------------------------------------------------------------

const GPU_MODULE = '../../ploinky-box/gpuGrant.mjs';
const DECLARED_MANIFEST = Object.freeze({ agent: 'node main.mjs', containerSecurity: { gpu: true } });

function wiredBox(t, makeWiring) {
    const state = workspaceFixture(t);
    const wiring = makeWiring ? makeWiring(state) : null;
    if (wiring) state.store.materialize(state.identity, wiring, state.lock);
    const byDestination = Object.fromEntries((wiring?.mounts || []).map((mount) => [mount.destination, mount.source]));
    const boxMarker = path.join(state.root, 'ploinky-box');
    fs.writeFileSync(boxMarker, 'assistos/ploinky-box\n');
    return {
        ...state,
        wiring,
        markerPath: byDestination[BOX_GPU_MARKER_PATH] || path.join(state.root, 'absent-marker.json'),
        specPath: byDestination[BOX_GPU_CDI_SPEC_PATH] || path.join(state.root, 'absent-spec.json'),
        boxMarker,
    };
}

function admitManifest(box, manifest, { agentId = AGENT } = {}) {
    return admitManifestRuntimeCapabilities(manifest, {
        agentId,
        runtime: 'podman',
        boxMarkerOptions: { markerPath: box.boxMarker },
        gpuGrantOptions: { markerPath: box.markerPath, specPath: box.specPath },
        workspaceRoot: box.identity.workspaceRoot,
    });
}

function refusedWith(pattern) {
    return (error) => error.context?.unsupported?.includes('cdi') && pattern.test(error.message);
}

test('D14 field: containerSecurity.gpu is a root-only boolean that attaches only the one CDI device when available', async () => {
    const { validateManifestRuntimeCapabilities, resolveEffectiveRuntimeCapabilities } = await import('../../cli/sandbox/runtimeCapabilities.js');
    assert.equal(validateManifestRuntimeCapabilities(DECLARED_MANIFEST).containerSecurity.gpu, true);
    // Only a declaring agent's validated block carries the field.
    assert.deepEqual(validateManifestRuntimeCapabilities({ containerSecurity: { gpu: false } }).containerSecurity,
        { privileged: false, nestedPodman: false });
    assert.deepEqual(validateManifestRuntimeCapabilities({}).containerSecurity, { privileged: false, nestedPodman: false });
    assert.throws(() => validateManifestRuntimeCapabilities({ containerSecurity: { gpu: 'yes' } }),
        /manifest\.containerSecurity\.gpu must be boolean/);
    assert.throws(() => validateManifestRuntimeCapabilities({ profiles: { gpu: { containerSecurity: { gpu: true } } } }),
        /containerSecurity is root-only/);
    assert.throws(() => validateManifestRuntimeCapabilities({ gpu: true }), /manifest\.gpu is not a supported runtime capability field/);
    // Outside a Box nothing can be attached: the agent is admitted without a device.
    const declared = resolveEffectiveRuntimeCapabilities(DECLARED_MANIFEST, { agentId: AGENT, workspaceRoot: '/golden/ws', runtime: 'podman' });
    assert.equal((declared.runtimePolicy.devices || []).length, 0);
    assert.equal(declared.gpuAttach.attached, false);
    assert.match(declared.gpuAttach.reason, /not running in a Ploinky Box/);
    // Declaring it next to the operator-path entry keeps one device, on the strict path.
    const both = resolveEffectiveRuntimeCapabilities({ ...DECLARED_MANIFEST, llmRuntime: { runtimePolicy: GRANTED_DEVICE } },
        { agentId: AGENT, workspaceRoot: '/golden/ws', runtime: 'podman' });
    assert.deepEqual(both.runtimePolicy.devices, [{ type: 'cdi', value: BOX_GPU_CDI_DEVICE }]);
});

test('D14 golden: agents without the field, operator grants and their wiring keep their bytes', async () => {
    const crypto = await import('node:crypto');
    const { resolveEffectiveRuntimeCapabilities, runtimeCapabilityDigest } = await import('../../cli/sandbox/runtimeCapabilities.js');
    const gpu = await import(GPU_MODULE);
    assert.equal(typeof gpu.resolveDesiredGpuWiring, 'function');
    // Values computed with the pre-D14 code (69bfdb4c) for these fixed inputs.
    const identity = { instance: 'ploinky-box-golden-0123456789ab', pathHash: '0123456789ab', workspaceRoot: '/golden/ws' };
    const discovery = {
        vendor: 'nvidia', driverVersion: '595.91.07',
        devices: [
            { path: '/dev/nvidia0', major: 195, minor: 0 },
            { path: '/dev/nvidiactl', major: 195, minor: 255 },
            { path: '/dev/nvidia-uvm', major: 507, minor: 0 },
        ],
        libraries: [
            { soname: 'libcuda.so.1', source: '/usr/lib/x86_64-linux-gnu/libcuda.so.595.91.07' },
            { soname: 'libnvidia-ml.so.1', source: '/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.595.91.07' },
        ],
        tools: [{ name: 'nvidia-smi', source: '/usr/bin/nvidia-smi' }],
    };
    const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
    const marker = (wiring) => wiring.files.find((file) => file.path.endsWith('marker.json')).content;
    const grant = { vendor: 'nvidia', agents: [AGENT] };
    const active = gpu.buildGpuWiring({ identity, grant, discovery, homeDirectory: '/golden/home' });
    assert.equal(active.fingerprint, '0fead200bc4847bb01b08c9b6abebb9a8b01008aacec983bff4fd9daa3fff60f');
    assert.equal(sha(marker(active)), '68006b1850309910a3153befe931d63f7b321477e9dff4102c12cdc0d1e3bb53');
    const stale = gpu.buildGpuWiring({ identity, grant, failure: new Error('Unable to read the NVIDIA kernel module version'), homeDirectory: '/golden/home' });
    assert.equal(stale.fingerprint, 'ebf1f08471ebd3facf4e93a3b40b2a3d2cde3f3b335f5f167a67568e00d7d25d');
    assert.equal(sha(marker(stale)), 'd487cbeba75577d3fa31b92536452411b0069a8cf3ea6ea9893b3d23a55857e9');
    // The same effective set reached through a manifest, or with a deny that
    // hides no declared agent, keeps the operator grant's fingerprint.
    const discover = () => discovery;
    const viaManifest = gpu.resolveDesiredGpuWiring(identity, null, [AGENT], { discover, homeDirectory: '/golden/home' });
    const withIneffectiveDeny = gpu.resolveDesiredGpuWiring(identity, { agents: [AGENT], denied: ['lab/cpu'] }, [],
        { discover, homeDirectory: '/golden/home' });
    assert.equal(viaManifest.fingerprint, active.fingerprint);
    assert.equal(withIneffectiveDeny.fingerprint, active.fingerprint);
    const digest = (manifest, agentId) => runtimeCapabilityDigest(resolveEffectiveRuntimeCapabilities(manifest, {
        agentId, workspaceRoot: '/golden/ws', manifestDigest: 'sha256:golden', runtime: 'podman',
    }));
    assert.equal(digest({ agent: 'node server.mjs', volumes: { '.data/x': '/data' } }, 'lab/plain'),
        'sha256:1eb1252926a3b316fcd135e23b86ca5aa4412f08826163f45a6b40eef3c513bd');
    assert.equal(digest({ agent: 'node main.mjs', llmRuntime: { runtimePolicy: GRANTED_DEVICE } }, AGENT),
        'sha256:49bfc698e2581667bd7ecf40507975c7a12a02defc3ca38c367d3c35b584a399');
});

test('D14 effective set: manifest, operator grant, per-agent deny, workspace deny and re-grant', async () => {
    const { effectiveGpuAccess, normalizeGpuDecision } = await import(GPU_MODULE);
    const DECLARED = 'lab/declared';
    const OPERATOR = 'lab/operator';
    const summary = (access) => ({ agents: [...access.agents], denied: [...access.denied], workspaceDenied: access.workspaceDenied });
    // Manifest only.
    assert.deepEqual(summary(effectiveGpuAccess(null, [DECLARED])), { agents: [DECLARED], denied: [], workspaceDenied: false });
    assert.deepEqual(effectiveGpuAccess(null, [DECLARED]).sources, [{ agent: DECLARED, sources: ['manifest'] }]);
    // Operator grant on top.
    const granted = effectiveGpuAccess({ agents: [OPERATOR] }, [DECLARED]);
    assert.deepEqual(granted.agents, [DECLARED, OPERATOR]);
    assert.deepEqual(granted.sources, [{ agent: DECLARED, sources: ['manifest'] }, { agent: OPERATOR, sources: ['operator'] }]);
    // A per-agent deny overrides the manifest; a deny of an undeclared agent hides nothing.
    assert.deepEqual(summary(effectiveGpuAccess({ denied: [DECLARED] }, [DECLARED])), { agents: [], denied: [DECLARED], workspaceDenied: false });
    assert.deepEqual(summary(effectiveGpuAccess({ denied: ['lab/cpu'] }, [DECLARED])), { agents: [DECLARED], denied: [], workspaceDenied: false });
    // A workspace deny hides every manifest default but keeps explicit grants.
    assert.deepEqual(summary(effectiveGpuAccess({ workspaceDenied: true }, [DECLARED])), { agents: [], denied: [], workspaceDenied: true });
    assert.deepEqual(summary(effectiveGpuAccess({ agents: [OPERATOR], workspaceDenied: true }, [DECLARED])),
        { agents: [OPERATOR], denied: [], workspaceDenied: true });
    // Lifting the workspace deny restores the manifest default.
    assert.deepEqual(summary(effectiveGpuAccess(normalizeGpuDecision({ workspaceDenied: false, denied: [] }), [DECLARED])),
        { agents: [DECLARED], denied: [], workspaceDenied: false });
    assert.throws(() => normalizeGpuDecision({ agents: [DECLARED], denied: [DECLARED] }), /both grant and deny/);
    assert.equal(normalizeGpuDecision({ agents: [], denied: [], workspaceDenied: false }), null);
});

test('D14 commands: revoke denies and grant lifts, per agent and for the whole workspace', async (t) => {
    const box = graphBox(t);
    const events = [];
    const store = memoryGpuStore(events);
    const seen = [];
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: store,
        scanGpuAgents: () => [AGENT],
        async reconcile(options) {
            seen.push(options.gpu);
            return prepared(box, 'replaced', options.gpu, events);
        },
        async startCore() { events.push('start-core'); },
        async healthCheck() { events.push('health'); },
    });
    const record = () => (store.value
        ? { agents: store.value.agents, denied: store.value.denied, workspaceDenied: store.value.workspaceDenied }
        : null);
    // local-llm is declared by its manifest; nothing is enabled, so the
    // revoke pre-check has nothing to protect.
    await supervisor.runGpuRevokeTransaction({ agents: [AGENT] });
    assert.deepEqual(record(), { agents: [], denied: [AGENT], workspaceDenied: false });
    assert.equal(seen.at(-1).state, 'revoked');
    assert.deepEqual(seen.at(-1).denied, [AGENT]);
    await supervisor.runGpuGrantTransaction({ agents: [AGENT] });
    assert.deepEqual(record(), { agents: [AGENT], denied: [], workspaceDenied: false });
    assert.equal(seen.at(-1).state, 'active');
    assert.deepEqual(seen.at(-1).agents, [AGENT]);
    await supervisor.runGpuRevokeTransaction({});
    assert.deepEqual(record(), { agents: [], denied: [], workspaceDenied: true });
    assert.equal(seen.at(-1).state, 'revoked');
    assert.equal(seen.at(-1).workspaceDenied, true);
    // `gpu grant` alone lifts the workspace deny: the manifest default is back
    // and no operator record remains.
    const regranted = await supervisor.runGpuGrantTransaction({});
    assert.equal(store.value, null);
    assert.equal(seen.at(-1).state, 'active');
    assert.deepEqual(regranted.access.sources, [{ agent: AGENT, sources: ['manifest'] }]);
});

function gpuEnv(args) {
    const values = {};
    for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] !== '--env') continue;
        const [key, ...rest] = args[index + 1].split('=');
        values[key] = rest.join('=');
    }
    return values;
}

test('D14 admission: a declaring agent gets the device when wired, and otherwise starts without it and is told why', async (t) => {
    const gpu = await import(GPU_MODULE);
    const desired = (decision, declared) => (state) => gpu.resolveDesiredGpuWiring(state.identity, decision, declared, {
        discover: () => fakeHost().discover(), homeDirectory: state.home,
    });
    const args = (admission) => renderRuntimePolicyArgs(admission.descriptor, { runtime: 'podman' });
    // Attached: the active wiring names it because its manifest declares the GPU.
    const admittedBox = wiredBox(t, desired(null, [AGENT]));
    const admitted = admitManifest(admittedBox, DECLARED_MANIFEST);
    assert.equal(admitted.descriptor.gpuGrant.admitted, true);
    assert.deepEqual(args(admitted).slice(0, 2), ['--device', BOX_GPU_CDI_DEVICE]);
    assert.deepEqual(gpuEnv(args(admitted)), { PLOINKY_GPU_STATUS: 'attached' });
    const unavailable = (box, pattern) => {
        const admission = admitManifest(box, DECLARED_MANIFEST);
        assert.equal(args(admission).includes('--device'), false);
        const env = gpuEnv(args(admission));
        assert.equal(env.PLOINKY_GPU_STATUS, 'unavailable');
        assert.match(env.PLOINKY_GPU_REASON, pattern);
    };
    // Per-agent revoke: a marker-only revoked wiring names the deny.
    const deniedBox = wiredBox(t, desired({ denied: [AGENT] }, [AGENT]));
    assert.equal(deniedBox.wiring.state, 'revoked');
    assert.equal(deniedBox.wiring.devices.length, 0);
    unavailable(deniedBox, /^GPU access for local-llms\/local-llm was revoked by the operator; on the host run `ploinky gpu grant --agent local-llms\/local-llm`$/);
    // Workspace revoke.
    unavailable(wiredBox(t, desired({ workspaceDenied: true }, [AGENT])),
        /revoked for this workspace by the operator; on the host run `ploinky gpu grant` to restore manifest defaults, or `ploinky gpu grant --agent local-llms\/local-llm`/);
    // Declared after the Box was prepared: no wiring yet, or wiring for others only.
    const notApplied = /^GPU not applied to this Box yet; on the host run `ploinky start` \(`ploinky gpu status` shows whether the host has a usable GPU\)$/;
    unavailable(wiredBox(t, null), notApplied);
    unavailable(wiredBox(t, desired(null, ['lab/other'])), notApplied);
    // The operator path keeps its strict refusal and its own guidance.
    assert.throws(() => admitManifest(wiredBox(t, null), { llmRuntime: { runtimePolicy: GRANTED_DEVICE } }), refusedWith(
        /this workspace has no GPU grant for local-llms\/local-llm; on the host run `ploinky gpu grant --agent local-llms\/local-llm`/));
    assert.throws(() => admitManifest(deniedBox, { ...DECLARED_MANIFEST, llmRuntime: { runtimePolicy: GRANTED_DEVICE } }),
        refusedWith(/was revoked by the operator/));
    // Other devices stay refused even for a declaring, attached agent.
    for (const [extra, unsupported] of [
        [{ gpus: 'all' }, 'gpu'],
        [{ ipc: 'host' }, 'host-ipc'],
        [{ securityOpt: ['label=disable'] }, 'security-options'],
    ]) {
        // Podman already rejects --gpus when the policy is validated.
        assert.throws(() => admitManifest(admittedBox, { ...DECLARED_MANIFEST, llmRuntime: { runtimePolicy: extra } }),
            (error) => error.context?.unsupported?.includes(unsupported) || /does not support --gpus/.test(error.message),
            unsupported);
    }
    assert.throws(() => admitManifest(admittedBox, {
        ...DECLARED_MANIFEST,
        llmRuntime: { runtimePolicy: { devices: [{ type: 'cdi', value: 'nvidia.com/gpu=all' }] } },
    }), refusedWith(/admits only the single device ploinky\.local\/gpu=all/));
});

test('D14 GPU-less host: a declared agent starts without the device, and its Box starts without GPU wiring', async (t) => {
    const gpu = await import(GPU_MODULE);
    const noGpu = () => { throw Object.assign(new Error('Unable to read the NVIDIA kernel module version from /proc/driver/nvidia/version'), { code: 'PLOINKY_BOX_GPU_DISCOVERY_FAILED' }); };
    const state = workspaceFixture(t);
    // Manifest only: no wiring at all, exactly today's Box.
    assert.equal(gpu.resolveDesiredGpuWiring(state.identity, null, [AGENT], { discover: noGpu, homeDirectory: state.home }), null);
    // An operator grant keeps today's stale marker.
    assert.equal(gpu.resolveDesiredGpuWiring(state.identity, { agents: [AGENT] }, [AGENT], { discover: noGpu, homeDirectory: state.home }).state, 'stale');
    // gpu grant insists on a working GPU.
    assert.throws(() => gpu.resolveDesiredGpuWiring(state.identity, null, [AGENT], { discover: noGpu, homeDirectory: state.home, strict: true }),
        /NVIDIA kernel module version/);
    // Start on that host: the Box is created without GPU wiring, the note names
    // the declaring agents, and the agent is refused with the guidance.
    const box = graphBox(t);
    const events = [];
    const notes = [];
    let startGpu;
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: memoryGpuStore(events),
        discoverGpuDevices: noGpu,
        scanGpuAgents: () => [AGENT],
        stderr: { write(text) { notes.push(text); } },
        async reconcile(options) { startGpu = options.gpu; return prepared(box, 'reused', options.gpu, events); },
        async startCore() { events.push('start-core'); },
        async healthCheck() { events.push('health'); },
        selectAgentLib: async () => ({ selection: box.agentLib }),
        commitAgentLibSelection: () => {},
        revalidateAgentLibSource: () => {},
    });
    await supervisor.runStartTransaction(['start', 'explorer', '8080']);
    assert.equal(startGpu, null);
    assert.ok(notes.some((text) => /GPU access is declared by local-llms\/local-llm, but this host has no usable GPU; .* start without the GPU/.test(text)));
    // The agent is admitted without a device and told why.
    const admission = admitManifest(wiredBox(t, null), DECLARED_MANIFEST);
    const env = gpuEnv(renderRuntimePolicyArgs(admission.descriptor, { runtime: 'podman' }));
    assert.equal(env.PLOINKY_GPU_STATUS, 'unavailable');
    assert.match(env.PLOINKY_GPU_REASON, /`ploinky gpu status` shows whether the host has a usable GPU/);
});

test('D14 no declarations and no record: no GPU wiring, as before', async (t) => {
    const gpu = await import(GPU_MODULE);
    const state = workspaceFixture(t);
    assert.equal(gpu.resolveDesiredGpuWiring(state.identity, null, [], {
        discover: () => assert.fail('no discovery without a GPU agent'), homeDirectory: state.home,
    }), null);
    const box = graphBox(t);
    const events = [];
    let startGpu;
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: memoryGpuStore(events),
        discoverGpuDevices: () => assert.fail('no discovery without a GPU agent'),
        async reconcile(options) { startGpu = options.gpu; return prepared(box, 'reused', options.gpu, events); },
        async startCore() { events.push('start-core'); },
        async healthCheck() { events.push('health'); },
        selectAgentLib: async () => ({ selection: box.agentLib }),
        commitAgentLibSelection: () => {},
        revalidateAgentLibSource: () => {},
    });
    await supervisor.runStartTransaction(['start', 'explorer', '8080']);
    assert.equal(startGpu, null);
    assert.equal(events.some((event) => event.startsWith('grant-')), false);
});

test('D14 scan: installed repos and workspace checkouts declare GPU access through manifests only', async (t) => {
    const { declaredGpuAgents } = await import(GPU_MODULE);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-gpu-scan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (relative, content) => {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), typeof content === 'string' ? content : JSON.stringify(content));
    };
    write('.ploinky/repos/local-llms/local-llm/manifest.json', DECLARED_MANIFEST);
    write('.ploinky/repos/local-llms/cpu/manifest.json', { containerSecurity: { gpu: false } });
    write('.ploinky/repos/tools/broken/manifest.json', '{"containerSecurity": ');
    write('checkout/gpu-agent/manifest.json', DECLARED_MANIFEST);
    write('.hidden/agent/manifest.json', DECLARED_MANIFEST);
    write('elsewhere.json', DECLARED_MANIFEST);
    fs.mkdirSync(path.join(root, '.ploinky/repos/tools/linked'), { recursive: true });
    fs.symlinkSync(path.join(root, 'elsewhere.json'), path.join(root, '.ploinky/repos/tools/linked/manifest.json'));
    assert.deepEqual([...declaredGpuAgents(root)], ['checkout/gpu-agent', 'local-llms/local-llm']);
    assert.deepEqual([...declaredGpuAgents('relative/path')], []);
});

test('D14 status names each GPU agent with its source, the denies and the workspace revoke', async () => {
    const { effectiveGpuAccess } = await import(GPU_MODULE);
    const base = {
        identity: { instance: 'ploinky-box-x-000000000000' }, box: 'running', boxGpu: null, boxProblem: null,
        host: { available: false, reason: 'no driver' }, desired: null, pendingReplacement: false,
    };
    const manifestOnly = formatGpuGrantStatus({ ...base, grant: null, access: effectiveGpuAccess(null, [AGENT]) });
    assert.match(manifestOnly, /GPU grant: none\nGPU agents: local-llms\/local-llm \(manifest\)\nManifest GPU declarations: local-llms\/local-llm/);
    const mixed = formatGpuGrantStatus({
        ...base,
        grant: { vendor: 'nvidia', agents: ['lab/other'], denied: [AGENT], workspaceDenied: false },
        access: effectiveGpuAccess({ agents: ['lab/other'], denied: [AGENT] }, [AGENT]),
    });
    assert.match(mixed, /GPU grant: nvidia for lab\/other; denied local-llms\/local-llm/);
    assert.match(mixed, /GPU agents: lab\/other \(operator\)/);
    const off = formatGpuGrantStatus({
        ...base,
        grant: { vendor: 'nvidia', agents: [], denied: [], workspaceDenied: true },
        access: effectiveGpuAccess({ workspaceDenied: true }, [AGENT]),
    });
    assert.match(off, /GPU grant: manifest defaults revoked for this workspace\nGPU agents: none/);
});

test('D14 revoke pre-check: a manifest-declared agent does not block a revoke, since it starts without the GPU', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    const box = graphBox(t, { gpu: (state) => activeWiring(state.identity) });
    enableAgentRecord(box, { repo: 'local-llms', agent: 'local-llm', manifest: DECLARED_MANIFEST });
    const events = [];
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: memoryGpuStore(events),
        scanGpuAgents: () => [AGENT],
        reconcile: reconcileReached(box),
    });
    await assert.rejects(() => supervisor.runGpuRevokeTransaction({ agents: [AGENT] }),
        (error) => error.code !== 'PLOINKY_BOX_GPU_AGENTS_ENABLED' && /reached reconcile/.test(error.message));
});

test('D14 first start: a start that installs a declaring repo replaces the Box once, and only then', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    useFakeHostFiles(t, fakeHost());
    for (const [declaredAfterStart, expected] of [[[AGENT], [null, 'active']], [[], [null]]]) {
        const box = graphBox(t);
        const events = [];
        const seen = [];
        let scans = 0;
        // The start returns while its no-wait launches (image pulls) still run.
        const workers = [2, 1, 0];
        const supervisor = gpuSupervisor(box, events, {
            gpuGrantStore: memoryGpuStore(events),
            // Nothing is installed when the host prepares the Box; the in-Box
            // start then clones the repo.
            scanGpuAgents: () => (scans++ === 0 ? [] : declaredAfterStart),
            async reconcile(options) {
                seen.push(options.gpu);
                events.push('reconcile');
                return prepared(box, seen.length === 1 ? 'reused' : 'replaced', options.gpu, events);
            },
            async startCore() { events.push('start-core'); },
            async healthCheck() { events.push('health'); },
            selectAgentLib: async () => ({ selection: box.agentLib }),
            commitAgentLibSelection: () => {},
            revalidateAgentLibSource: () => {},
            countNoWaitWorkers: () => {
                const count = workers.shift();
                events.push(`no-wait:${count}`);
                return count;
            },
            waitDelay: async () => {},
        });
        const result = await supervisor.runStartTransaction(['start', 'explorer', '8080']);
        assert.deepEqual(seen.map((wiring) => wiring?.state ?? null), expected, JSON.stringify(declaredAfterStart));
        const noWait = events.filter((event) => event.startsWith('no-wait:') || event === 'reconcile');
        if (declaredAfterStart.length) {
            assert.deepEqual(seen[1].agents, [AGENT]);
            assert.equal(result.gpuReapplied.action, 'replaced');
            assert.equal(events.filter((event) => event === 'start-core').length, 2);
            // The Box is replaced only once no no-wait launch is left.
            assert.deepEqual(noWait, ['reconcile', 'no-wait:2', 'no-wait:1', 'no-wait:0', 'reconcile']);
        } else {
            assert.equal(result.gpuReapplied, undefined);
            assert.equal(events.filter((event) => event === 'start-core').length, 1);
            // No change to apply: the start never waits for its no-wait launches.
            assert.deepEqual(noWait, ['reconcile']);
        }
    }
});

test('D14 first start: by default the no-wait launches are counted with pgrep in the Box, as the podman user', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    useFakeHostFiles(t, fakeHost());
    const box = graphBox(t);
    const events = [];
    const seen = [];
    const counts = [{ ok: true, status: 0, stdout: '2\n' }, { ok: false, status: 1, stdout: '0\n' }];
    const pgrepCalls = [];
    let scans = 0;
    const supervisor = gpuSupervisor(box, events, {
        gpuGrantStore: memoryGpuStore(events),
        scanGpuAgents: () => (scans++ === 0 ? [] : [AGENT]),
        async reconcile(options) {
            seen.push(options.gpu);
            return prepared(box, seen.length === 1 ? 'reused' : 'replaced', options.gpu, events);
        },
        async startCore() { events.push('start-core'); },
        async healthCheck() { events.push('health'); },
        selectAgentLib: async () => ({ selection: box.agentLib }),
        commitAgentLibSelection: () => {},
        revalidateAgentLibSource: () => {},
        waitDelay: async () => {},
        runner: {
            run(_command, args) { events.push(`run:${args.join(' ')}`); },
            async stream(_command, args) { events.push(`stream:${args.at(-1)}`); return { ok: true, status: 0 }; },
            query(_command, args) {
                if (args.includes('/usr/bin/pgrep')) {
                    pgrepCalls.push(args);
                    return counts.shift();
                }
                return { ok: true, status: 0, stdout: JSON.stringify({
                    state: 'running', initialized: true, routingConfigured: true, trackedAgents: 1, runningAgents: 1, warnings: [],
                }) };
            },
        },
    });
    const result = await supervisor.runStartTransaction(['start', 'explorer', '8080']);
    assert.equal(result.gpuReapplied.action, 'replaced');
    assert.equal(pgrepCalls.length, 2);
    assert.deepEqual(pgrepCalls[0], ['container', 'exec', '--user', 'podman', box.ownership.handles.container.id,
        '/usr/bin/pgrep', '-c', '-f', '/opt/ploinky/cli/commands/noWaitWorker.js']);
});

test('D14 first start: no-wait launches that outlast the bound, or cannot be counted, leave the Box as it is', async (t) => {
    const probe = boxFixture(t);
    useTempHome(t, probe.root);
    useFakeHostFiles(t, fakeHost());
    for (const [count, message] of [
        [() => 1, /1 no-wait agent launch is still running after 31 minutes/],
        [() => null, /could not count the no-wait agent launches in the Box/],
    ]) {
        const box = graphBox(t);
        const events = [];
        const seen = [];
        const output = [];
        let scans = 0;
        let clock = 0;
        const store = memoryGpuStore(events);
        const supervisor = gpuSupervisor(box, events, {
            gpuGrantStore: store,
            scanGpuAgents: () => (scans++ === 0 ? [] : [AGENT]),
            async reconcile(options) {
                seen.push(options.gpu);
                return prepared(box, 'reused', options.gpu, events);
            },
            async startCore() { events.push('start-core'); },
            async healthCheck() { events.push('health'); },
            selectAgentLib: async () => ({ selection: box.agentLib }),
            commitAgentLibSelection: () => {},
            revalidateAgentLibSource: () => {},
            countNoWaitWorkers: count,
            now: () => clock,
            waitDelay: async (milliseconds) => { clock += milliseconds; },
            stderr: { write(text) { output.push(String(text)); } },
        });
        const result = await supervisor.runStartTransaction(['start', 'explorer', '8080']);
        assert.equal(seen.length, 1, 'the Box is not replaced');
        assert.equal(result.gpuReapplied, undefined);
        assert.equal(events.filter((event) => event === 'start-core').length, 1);
        const text = output.join('');
        assert.match(text, message);
        assert.match(text, /the workspace keeps running without that GPU wiring; run `ploinky start` again once they finish/);
        assert.equal(store.value, null, 'no GPU grant record is written');
        assert.deepEqual(events.filter((event) => event.startsWith('grant-')), []);
    }
});
