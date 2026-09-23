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
    assert.deepEqual(state.store.read(state.identity), { vendor: 'nvidia', agents: [AGENT], admitted: null });

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
            && /GPU grant stale: .*version mismatch.*; re-run `ploinky gpu grant`/.test(error.message),
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
            events.push(`grant-write:${grant.agents.join(',')}:${admitted?.state || 'none'}`);
            value = Object.freeze({ vendor: grant.vendor, agents: [...grant.agents], admitted });
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
    assert.deepEqual(store.value, { vendor: 'nvidia', agents: [AGENT], admitted: { fingerprint: requested.fingerprint, state: 'active', reason: null } });
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

test('revoking while running removes the wiring and then clears the record', async (t) => {
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
    await assert.rejects(() => supervisor.runGpuRevokeTransaction({ agents: ['lab/unknown'] }), /does not name lab\/unknown/);
    const full = await supervisor.runGpuRevokeTransaction({});
    assert.equal(seen.at(-1), null);
    assert.equal(store.value, null);
    assert.equal(full.grant, null);
    inOrder(events.slice(events.lastIndexOf('lock')), ['lock', 'start-core', 'health', 'grant-clear', 'finalize', 'release']);
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
    inOrder(events, ['grant-clear', 'finalize', 'outer-rollback', 'restore-graph', 'grant-restore:local-llms/local-llm']);
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
    const grant = parseOuterArguments(['gpu', 'grant', 'nvidia', '--agent', AGENT, '--agent=lab/other']);
    assert.deepEqual(grant.gpu, { action: 'grant', vendor: 'nvidia', agents: [AGENT, 'lab/other'] });
    assert.deepEqual(routeOuterCommand(grant), { kind: 'gpu-grant', vendor: 'nvidia', agents: [AGENT, 'lab/other'] });
    assert.equal(routeOuterCommand(parseOuterArguments(['gpu'])).kind, 'gpu-status');
    assert.equal(routeOuterCommand(parseOuterArguments(['gpu', 'revoke'])).kind, 'gpu-revoke');
    for (const argv of [
        ['gpu', 'grant', 'nvidia'],
        ['gpu', 'grant', '--agent', AGENT],
        ['gpu', 'grant', 'nvidia', 'amd', '--agent', AGENT],
        ['gpu', 'grant', 'nvidia', '--agent'],
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
    for (const argv of [['gpu', 'grant', 'nvidia', '--agent', AGENT], ['gpu', 'revoke'], ['gpu', 'status']]) {
        const code = await runOuterCli(argv, { supervisor, execute, detectInsideBox: () => false, output, errorOutput: output, env: {} });
        assert.equal(code, 0);
    }
    assert.deepEqual(calls, [['grant', { vendor: 'nvidia', agents: [AGENT] }], ['revoke', { agents: [] }], ['status']]);
    assert.match(output.text, /Host GPU: unavailable \(no driver\)/);
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
    await assert.rejects(
        () => gpuSupervisor(box, events, { gpuGrantStore: createGpuGrantStore(), reconcile: async () => assert.fail('refused first') })
            .runGpuRevokeTransaction({ agents: ['lab/unknown'] }),
        /does not name lab\/unknown/,
    );
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
