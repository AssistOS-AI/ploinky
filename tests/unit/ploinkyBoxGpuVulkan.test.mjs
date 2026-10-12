import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGpuWiring, discoverGpu, discoverNvidiaGpu, vulkanFallbackOf, resolveDesiredGpuWiring,
    observeContainerGpuWiring, createGpuGrantStore, gpuWiringCreateArgs } from '../../ploinky-box/gpuGrant.mjs';
import { classifyRenderFacts, discoverVulkanRenderNode, nvidiaAbsent, queryMachineRenderNodes,
    MACHINE_RENDER_QUERY, revalidateRenderNode } from '../../ploinky-box/gpuVulkan.mjs';
import { createBoxSupervisor, formatGpuGrantStatus } from '../../ploinky-box/supervisor.mjs';
import { inspectSelectedMachine } from '../../ploinky-box/repair/automatic.mjs';
import { buildEngineProcessEnvironment } from '../../ploinky-box/process.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { makeTree } from './fixtures/render-query/make-trees.mjs';

const DRIVER = '595.91.07';
// Each fixture host names its architecture, so discovery never depends on the
// machine running the tests.
const HOST_ARCHES = Object.freeze({
    x64: Object.freeze({ lib: '/usr/lib/x86_64-linux-gnu', flag: 'x86-64', machine: 'x86_64' }),
    arm64: Object.freeze({ lib: '/usr/lib/aarch64-linux-gnu', flag: 'AArch64', machine: 'aarch64' }),
});
const LIB = HOST_ARCHES.x64.lib;
const AGENT = 'local-llms/local-llm';
const GRANT = Object.freeze({ vendor: 'nvidia', agents: [AGENT] });
const DATA_FINGERPRINTS = Object.freeze({ dependencies: 'd'.repeat(64), images: 'f'.repeat(64) });
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
    arch = 'x64',
    discoverArch = arch,
    kernel = DRIVER,
    library = DRIVER,
    missing = [],
    inaccessible = [],
    mtimeMs = 1_786_317_226_000,
    flags = (flag) => `libc6,${flag}`,
    leadingLines = [],
    // Real file names that differ from the default `<name>.so.<library>`.
    realNames = {},
    nvvm70 = null,
} = {}) {
    const { lib, flag, machine } = HOST_ARCHES[arch];
    const files = new Map();
    const links = new Map();
    const lines = [...leadingLines];
    const addLibrary = (soname, defaultReal) => {
        const real = realNames[soname] ? `${lib}/${realNames[soname]}` : defaultReal;
        files.set(real, { size: real.length * 1000, mtimeMs });
        const linkPath = `${lib}/${soname}`;
        if (linkPath !== real) links.set(linkPath, real);
        if (!missing.includes(soname)) lines.push(`\t${soname} (${flags(flag)}) => ${linkPath}`);
    };
    addLibrary('libcuda.so.1', `${lib}/libcuda.so.${library}`);
    addLibrary('libnvidia-ptxjitcompiler.so.1', `${lib}/libnvidia-ptxjitcompiler.so.${library}`);
    addLibrary('libnvidia-ml.so.1', `${lib}/libnvidia-ml.so.${library}`);
    addLibrary('libnvidia-nvvm.so.4', `${lib}/libnvidia-nvvm.so.${library}`);
    addLibrary(`libnvidia-gpucomp.so.${library}`, `${lib}/libnvidia-gpucomp.so.${library}`);
    if (nvvm70) addLibrary('libnvidia-nvvm70.so.4', `${lib}/${nvvm70}`);
    lines.push(arch === 'x64'
        ? '\tlibcuda.so.1 (libc6) => /usr/lib/i386-linux-gnu/libcuda.so.1'
        : '\tlibcuda.so.1 (libc6,hard-float) => /usr/lib/arm-linux-gnueabihf/libcuda.so.1');
    files.set('/usr/bin/nvidia-smi', { size: 1_259_616, mtimeMs });
    const fsApi = {
        readFileSync(target) {
            if (target === '/proc/driver/nvidia/version') {
                return `NVRM version: NVIDIA UNIX Open Kernel Module for ${machine}  ${kernel}  Release Build\n`;
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
    const readLdconfig = () => `${lines.length} libs found in cache\n${lines.join('\n')}\n`;
    return {
        fsApi,
        lib,
        readLdconfig,
        discover: () => discoverNvidiaGpu({
            arch: discoverArch,
            fsApi,
            readLdconfig,
            smiCandidates: ['/usr/bin/nvidia-smi'],
        }),
    };
}

const GOLDEN = JSON.parse(fs.readFileSync(new URL('./fixtures/gpu-base-17a800c1.json', import.meta.url), 'utf8'));
const IDENTITY = { instance: 'ploinky-box-golden-0123456789ab', pathHash: '0123456789ab', workspaceRoot: '/workspace/golden' };
const BASE_REASON = 'The NVIDIA kernel module is not loaded (/proc/driver/nvidia/version: ENOENT)';
const wire = (discovery, more = {}) => buildGpuWiring({ identity: IDENTITY, grant: GRANT, discovery, homeDirectory: '/home/golden', ...more });
const linux = (tree) => ({ ...tree, platform: 'linux', procVersionPath: `${tree.root}/proc/driver/nvidia/version` });
const REPORT = fs.readFileSync(new URL('./fixtures/render-query/venus-machine-query.txt', import.meta.url), 'utf8');

function machineRunner({ connections, machines, inspected, report = REPORT, failureAt = null } = {}) {
    const calls = [];
    const name = 'ploinky-gpu';
    const runner = { query(command, args, options) {
        calls.push({ command, args, options });
        if (calls.length === failureAt) return { ok: false, status: 1, stdout: '', error: new Error('timeout') };
        const result = args[0] === 'system' ? connections ?? [{ Name: name, Default: true, IsMachine: true, URI: 'ssh://fixture', Identity: '/fixture/key' }]
            : args[1] === 'list' ? machines ?? [{ Name: name, VMType: 'libkrun', Running: true }]
                : args[1] === 'inspect' ? inspected ?? [{ Name: name, Rootful: false, State: 'running', Created: '2026-10-12' }]
                    : report;
        return { ok: true, status: 0, stdout: typeof result === 'string' ? result : JSON.stringify(result) };
    } };
    return { runner, calls };
}

function mac(options = {}) {
    const fixture = machineRunner(options);
    return { ...fixture, options: { platform: 'darwin', env: {}, engineRunner: fixture.runner } };
}

function observed(wiring) {
    return { name: IDENTITY.instance, labels: { [BOX_LABELS.gpuGrant]: wiring.fingerprint }, runtime: {
        createCommand: gpuWiringCreateArgs(wiring).devices,
        mounts: wiring.mounts.map((entry) => ({ ...entry, type: 'bind', rw: false })),
    } };
}

test('QA fixture: virtio-pci node with a virtio_gpu child is refused on Linux; NVIDIA error object and stale fingerprint unchanged', (t) => {
    const tree = makeTree(t, 'qa');
    // Use the base path in NVIDIA's diagnostic while using the fixture root for absence.
    const options = { ...linux(tree), procVersionPath: '/proc/driver/nvidia/version' };
    let error;
    try { discoverGpu('nvidia', options); } catch (caught) { error = caught; }
    assert.equal(error.message, BASE_REASON);
    assert.equal(error.code, 'PLOINKY_BOX_GPU_DISCOVERY_FAILED');
    assert.match(vulkanFallbackOf(error), /virtio_gpu via virtio-pci.*granted only inside/);
    assert.equal(Object.hasOwn(error, 'vulkanReason'), false);
    const stale = wire(null, { failure: error });
    assert.deepEqual(stale, GOLDEN[BASE_REASON]);
    assert.equal(vulkanFallbackOf(error), vulkanFallbackOf(error));
});

test('QA fixture: manifest-only declaration gives no wiring; gpu status names virtio_gpu', (t) => {
    const tree = makeTree(t, 'qa');
    let error;
    const discover = () => {
        try { return discoverGpu('nvidia', linux(tree)); } catch (caught) { error = caught; throw caught; }
    };
    assert.equal(resolveDesiredGpuWiring(IDENTITY, null, [AGENT], { discover }), null);
    const status = formatGpuGrantStatus({ identity: IDENTITY, grant: null, box: 'absent',
        host: { available: false, reason: error.message, vulkanReason: vulkanFallbackOf(error) } });
    assert.match(status, /Host GPU: unavailable \(The NVIDIA kernel module/);
    assert.match(status, /Vulkan render node: .*virtio_gpu/);
});

test('amdgpu 0666 node gives one device, vendor vulkan, CDI with one deviceNode and no containerEdits', (t) => {
    const discovery = discoverGpu('nvidia', linux(makeTree(t)));
    assert.equal(discovery.vendor, 'vulkan');
    assert.deepEqual(discovery.devices, [{ path: '/dev/dri/renderD128', major: 226, minor: 128 }]);
    const wiring = wire(discovery);
    const spec = JSON.parse(wiring.files[0].content);
    assert.deepEqual(Object.keys(spec), ['cdiVersion', 'kind', 'devices']);
    assert.deepEqual(spec.devices[0].containerEdits, { deviceNodes: [{ path: '/dev/dri/renderD128' }] });
    assert.equal(wiring.vendor, 'vulkan');
    assert.equal(JSON.parse(wiring.files[1].content).vendor, 'vulkan');
    assert.deepEqual(wiring.mounts.map((m) => m.destination).sort(), ['/etc/cdi/ploinky-gpu.json', '/etc/ploinky-box-gpu-grant.json'].sort());
    const args = gpuWiringCreateArgs(wiring).devices;
    assert.equal(args.filter((x) => x === '--device').length, 1);
    assert.equal(args.some((x) => /--(?:privileged|cap-add|security-opt|publish|group-add|gpus)/.test(x)), false);
    const status = formatGpuGrantStatus({ identity: IDENTITY, grant: null, box: 'absent', host: {
        available: true, vendor: discovery.vendor, driver: discovery.driver, driverVersion: discovery.driverVersion,
        devices: wiring.devices, libraries: [],
    } });
    assert.match(status, /Host GPU: vulkan render node \/dev\/dri\/renderD128 \(amdgpu; amdgpu /);
    assert.deepEqual(wire(discovery), wiring);
});

test('amdgpu 0660 node is refused with DRIVERS=="amdgpu" and the every-user warning', (t) => {
    for (const mode of [0o20660, 0o20664]) {
        assert.throws(() => discoverVulkanRenderNode(linux(makeTree(t, 'amd', { mode }))),
            (e) => /DRIVERS=="amdgpu"/.test(e.message) && /every local user submit work/.test(e.message));
    }
});

test('darwin 0660 node is refused with DRIVERS=="<transport>" from its ancestry, inside the machine, and the every-user warning', () => {
    for (const transport of ['virtio-mmio', 'virtio-pci']) {
        const fixture = mac({ report: REPORT.replace('21b6', '21b0').replace('virtio-mmio', transport) });
        assert.throws(() => discoverVulkanRenderNode(fixture.options),
            (e) => e.message.includes(`DRIVERS=="${transport}"`) && /inside the Podman machine/.test(e.message)
                && /every local user submit work/.test(e.message));
    }
});

test('access check failure refuses a 0666 node', (t) => {
    const tree = makeTree(t);
    tree.fsApi.accessSync = () => { throw errno('EACCES'); };
    assert.throws(() => discoverVulkanRenderNode(linux(tree)), /not readable and writable by this user/);
});

test('two amdgpu nodes: only the larger VRAM node is granted; a tie picks the lower minor', (t) => {
    const tree = makeTree(t);
    tree.addNode({ name: 'renderD129', vramBytes: '17179869184' });
    assert.deepEqual(discoverVulkanRenderNode(linux(tree)).devices, [{ path: '/dev/dri/renderD129', major: 226, minor: 129 }]);
    fs.writeFileSync(`${tree.root}/sys/devices/renderD129/mem_info_vram_total`, '8589934592');
    assert.equal(discoverVulkanRenderNode(linux(tree)).devices[0].minor, 128);
    fs.rmSync(`${tree.root}/sys/devices/renderD128/mem_info_vram_total`);
    assert.equal(discoverVulkanRenderNode(linux(tree)).devices[0].minor, 129);
});

test('render node checks: renderD127, renderD0128, rdev mismatch, sysfs dev mismatch, symlink, non-char', (t) => {
    for (const [change, reason] of [[{ name: 'renderD127' }, /not a render node name/],
        [{ name: 'renderD0128' }, /not a render node name/], [{ minor: 129 }, /not a character device/],
        [{ sysDev: '226:129' }, /sysfs entry does not match/], [{ mode: 0o120777, link: true }, /not a character device/],
        [{ mode: 0o100666 }, /not a character device/], [{ transport: null }, /no bound driver/],
        [{ vramBytes: null }, /VRAM size is unreadable/]]) {
        assert.throws(() => discoverVulkanRenderNode(linux(makeTree(t, 'amd', change))), reason);
    }
});

test('classifier: two virtio_gpu children, wrong virtio device id, unknown transport are refused', () => {
    const base = { name: 'renderD128', rawMode: 0o20666, major: 226, minor: 128, sysDev: '226:128',
        transport: 'virtio-mmio', rw: true, children: [{ name: 'virtio0', driver: 'virtio_gpu', device: '0x0010' }] };
    for (const change of [{ children: [...base.children, { ...base.children[0], name: 'virtio1' }] },
        { children: [{ ...base.children[0], device: '0x0001' }] }, { transport: 'virtio_gpu' }]) {
        assert.equal(classifyRenderFacts({ ...base, ...change }, { platform: 'darwin' }).accepted, false);
    }
});

test('NVIDIA absence: module present, /dev/nvidia*, PCI 0x10de, unreadable sysfs all block fallback', (t) => {
    for (const kind of ['module', 'node', 'pci', 'unreadable']) {
        const tree = makeTree(t);
        assert.equal(nvidiaAbsent(linux(tree)), true);
        if (kind === 'module') {
            fs.mkdirSync(`${tree.root}/proc/driver/nvidia`, { recursive: true });
            fs.writeFileSync(`${tree.root}/proc/driver/nvidia/version`, 'broken');
        } else if (kind === 'node') fs.writeFileSync(`${tree.root}/dev/nvidia-broken`, '');
        else {
            fs.mkdirSync(`${tree.root}/sys/bus/pci/devices/0000:01:00.0`);
            if (kind === 'pci') fs.writeFileSync(`${tree.root}/sys/bus/pci/devices/0000:01:00.0/vendor`, '0x10de');
        }
        assert.equal(nvidiaAbsent(linux(tree)), false);
        assert.throws(() => discoverGpu('nvidia', linux(tree)), (e) => vulkanFallbackOf(e) === null);
    }
    assert.equal(nvidiaAbsent({ platform: 'win32' }), false);
});

test('broken NVIDIA plus AMD keeps the NVIDIA error: mismatch, missing node, missing nvidia-smi, inaccessible node', (t) => {
    for (const changes of [{ library: '1.2' }, { missing: ['/dev/nvidia0'] }, { missing: ['nvidia-smi'] }, { inaccessible: ['/dev/nvidia0'] }]) {
        const host = fakeHost(changes);
        const tree = makeTree(t);
        const fsApi = Object.create(host.fsApi);
        fsApi.lstatSync = (p) => p.endsWith('/proc/driver/nvidia/version') ? {} : tree.fsApi.lstatSync(p);
        const options = { ...linux(tree), fsApi, procVersionPath: '/proc/driver/nvidia/version', arch: 'x64',
            readLdconfig: host.readLdconfig, smiCandidates: changes.missing?.includes('nvidia-smi') ? [] : ['/usr/bin/nvidia-smi'] };
        let original;
        try { discoverNvidiaGpu(options); } catch (e) { original = e; }
        assert.ok(original);
        assert.throws(() => discoverGpu('nvidia', options), (e) => e.message === original.message && vulkanFallbackOf(e) === null);
    }
});

test('NVIDIA failure with an nvidia-drm render node keeps the error object and fingerprint', (t) => {
    const tree = makeTree(t, 'amd', { transport: 'nvidia-drm', vendor: '0x10de' });
    fs.writeFileSync(`${tree.root}/dev/nvidia0`, '');
    const options = { ...linux(tree), procVersionPath: '/proc/driver/nvidia/version' };
    assert.throws(() => discoverGpu('nvidia', options), (e) => {
        assert.equal(vulkanFallbackOf(e), null);
        assert.deepEqual(wire(null, { failure: e }), GOLDEN[BASE_REASON]);
        return true;
    });
});

test('healthy NVIDIA plus AMD gives the base NVIDIA fingerprint, marker and CDI bytes', (t) => {
    for (const arch of ['x64', 'arm64']) {
        const host = fakeHost({ arch });
        const tree = makeTree(t);
        const fsApi = Object.create(host.fsApi);
        fsApi.lstatSync = tree.fsApi.lstatSync;
        fsApi.readdirSync = fs.readdirSync;
        const discovery = discoverGpu('nvidia', { ...linux(tree), arch, fsApi,
            procVersionPath: '/proc/driver/nvidia/version', readLdconfig: host.readLdconfig, smiCandidates: ['/usr/bin/nvidia-smi'] });
        assert.deepEqual(wire(discovery), GOLDEN[arch]);
    }
    assert.deepEqual(wire(null, { revoked: true, workspaceDenied: true }), GOLDEN.revoked);
    for (const reason of Object.keys(GOLDEN).filter((key) => key.startsWith('NVIDIA') || key.startsWith('The NVIDIA'))) {
        assert.deepEqual(wire(null, { failure: new Error(reason) }), GOLDEN[reason]);
    }
});

test('MPS gate on a Vulkan wiring records mpsProblem and binds no MPS tools', (t) => {
    const discovery = discoverVulkanRenderNode(linux(makeTree(t)));
    const wiring = resolveDesiredGpuWiring(IDENTITY, GRANT, [], { discover: () => discovery, mpsEnabled: true,
        discoverMps: () => assert.fail('Vulkan must not discover NVIDIA MPS tools') });
    assert.equal(wiring.mpsProblem, "GPU shares need NVIDIA MPS; this Box's GPU is a Vulkan render node");
    assert.equal(wiring.mps, undefined);
    assert.equal(wiring.mounts.length, 2);
});

test('darwin: applehv refused; libkrun accepted; wrong name, rootful, remote engine, stopped refused', () => {
    assert.equal(discoverVulkanRenderNode(mac().options).driver, 'virtio_gpu');
    for (const [change, reason] of [
        [{ machines: [{ Name: 'ploinky-gpu', VMType: 'applehv', Running: true }] }, /needs a libkrun machine/],
        [{ machines: [{ Name: 'wrong', VMType: 'libkrun', Running: true }] }, /no single default/],
        [{ inspected: [{ Name: 'ploinky-gpu', Rootful: true }] }, /is rootful/],
        [{ machines: [{ Name: 'ploinky-gpu', VMType: 'libkrun', Running: false }] }, /not running/],
        [{ connections: [{ Name: 'ploinky-gpu', Default: true, IsMachine: false }] }, /no single default/],
        [{ connections: [] }, /no single default/], [{ machines: [] }, /no single default/],
        [{ inspected: [{ Name: 'other', Rootful: false }] }, /no single default/],
    ]) assert.throws(() => discoverVulkanRenderNode(mac(change).options), reason);
    for (const key of ['CONTAINER_HOST', 'PODMAN_HOST']) {
        const fixture = mac();
        assert.throws(() => discoverVulkanRenderNode({ ...fixture.options, env: { [key]: 'remote' } }), /remote Podman engine/);
        assert.equal(fixture.calls.length, 0);
    }
});

test('darwin: machine ssh argv has no separator and the constant query; timeout, oversize and malformed output refused', () => {
    const fixture = mac();
    discoverVulkanRenderNode(fixture.options);
    assert.deepEqual(fixture.calls.at(-1), { command: 'podman', args: ['machine', 'ssh', 'ploinky-gpu', MACHINE_RENDER_QUERY],
        options: { timeoutMs: 10_000 } });
    for (const options of [{ failureAt: 4 }, { report: 'x'.repeat(65537) }, { report: 'bad' }]) {
        assert.throws(() => discoverVulkanRenderNode(mac(options).options), /machine query/);
    }
    for (const failureAt of [1, 2, 3]) assert.throws(() => discoverVulkanRenderNode(mac({ failureAt }).options));
});

test('darwin: every query runs through the engine runner; ambient PODMAN_CONNECTIONS_CONF, CONTAINERS_CONF and CONTAINER_HOST never reach podman', (t) => {
    const tree = makeTree(t, 'empty');
    // A local stand-in records exactly the environment seen by real child processes.
    const program = `#!${process.execPath}\nconst fs=require('node:fs');\n`
        + `fs.appendFileSync(${JSON.stringify(`${tree.root}/seen.jsonl`)},JSON.stringify(process.env)+'\\n');\n`
        + `const a=process.argv.slice(2); const n='ploinky-gpu';\n`
        + `console.log(a[0]==='system'?JSON.stringify([{Name:n,Default:true,IsMachine:true}]):`
        + `a[1]==='list'?JSON.stringify([{Name:n,VMType:'libkrun',Running:true}]):`
        + `a[1]==='inspect'?JSON.stringify([{Name:n,Rootful:false}]):${JSON.stringify(REPORT.trimEnd())});\n`;
    fs.writeFileSync(`${tree.root}/bin/podman`, program, { mode: 0o755 });
    const env = { PATH: `${tree.root}/bin:/usr/bin:/bin`, HOME: tree.root,
        PODMAN_CONNECTIONS_CONF: '/untrusted', CONTAINERS_CONF: '/untrusted' };
    assert.equal(discoverVulkanRenderNode({ platform: 'darwin', env }).vendor, 'vulkan');
    const seen = fs.readFileSync(`${tree.root}/seen.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(seen.length, 4);
    for (const child of seen) for (const key of ['PODMAN_CONNECTIONS_CONF', 'CONTAINERS_CONF', 'CONTAINER_HOST', 'PODMAN_HOST']) {
        assert.equal(child[key], undefined);
    }
    assert.throws(() => discoverVulkanRenderNode({ platform: 'darwin', env: { ...env, CONTAINER_HOST: 'remote' } }), /remote Podman/);
    assert.equal(fs.readFileSync(`${tree.root}/seen.jsonl`, 'utf8').trim().split('\n').length, 4);
    const fixture = mac();
    discoverVulkanRenderNode({ ...fixture.options, env });
    assert.equal(fixture.calls.length, 4);
    assert.ok(fixture.calls.every((call) => call.options.timeoutMs === 10_000 && !Object.hasOwn(call.options, 'env')));
});

test('darwin: identical runner output selects the same machine as inspectSelectedMachine', () => {
    const fixture = mac();
    const selected = inspectSelectedMachine({ runner: fixture.runner, platform: 'darwin', env: {} });
    const discovered = discoverVulkanRenderNode(fixture.options);
    assert.equal(selected.machineName, 'ploinky-gpu');
    assert.equal(discovered.driverVersion, `virtio_gpu ${selected.machineName} 7.1.3-200.fc44.aarch64`);
    assert.deepEqual(fixture.calls.slice(0, 3), fixture.calls.slice(3, 6));
});

test('darwin: supervisor default discovery and grant store receive the supervisor runner', (t) => {
    const tree = makeTree(t, 'empty');
    fs.mkdirSync(`${tree.root}/home`, { mode: 0o700 });
    fs.mkdirSync(`${tree.root}/workspace`);
    const identity = buildWorkspaceIdentity(`${tree.root}/workspace`, { markerFound: true });
    t.mock.method(os, 'homedir', () => `${tree.root}/home`);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    const fixture = mac();
    const supervisor = createBoxSupervisor({ runner: fixture.runner, resolveIdentity: () => identity,
        discover: () => ({ state: 'absent' }), scanGpuAgents: () => [AGENT], hardwareGateStore: { read: () => null } });
    const status = supervisor.inspectGpuGrant();
    assert.equal(status.host.vendor, 'vulkan');
    assert.equal(status.desired.vendor, 'vulkan');
    assert.equal(fixture.calls.length, 8);
    // The default store uses the host-only home, while the discovery uses the selected engine.
    assert.equal(status.grant, null);
    assert.ok(status.desired.files.every((file) => file.path.startsWith(`${tree.root}/home/.ploinky-box/gpu-grants/`)));
});

test('observer round-trips one render node and refuses two', (t) => {
    const wiring = wire(discoverVulkanRenderNode(linux(makeTree(t))));
    const handle = observed(wiring);
    assert.deepEqual(observeContainerGpuWiring(handle, { identity: IDENTITY, homeDirectory: '/home/golden' }).devices, wiring.devices);
    handle.runtime.createCommand.push('--device', '/dev/dri/renderD129');
    assert.throws(() => observeContainerGpuWiring(handle), /more than one render/);
});

test('kept wiring: Linux render node revalidated with D9; darwin revalidated through the engine runner, never a host stat', (t) => {
    for (const platform of ['linux', 'darwin']) {
        const tree = makeTree(t);
        const home = `${tree.root}/home`;
        fs.mkdirSync(home, { mode: 0o700 });
        const workspace = `${tree.root}/workspace`;
        fs.mkdirSync(workspace);
        const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
        const fixture = mac();
        let report = REPORT;
        const engineRunner = { query(command, args, options) {
            return args[1] === 'ssh' ? { ok: true, stdout: report } : fixture.runner.query(command, args, options);
        } };
        const options = platform === 'linux' ? linux(tree) : { ...fixture.options, engineRunner };
        const wiring = buildGpuWiring({ identity, grant: GRANT, discovery: discoverVulkanRenderNode(options), homeDirectory: home });
        const fsApi = Object.create(fs);
        fsApi.statSync = (target, ...args) => {
            assert.equal(String(target).startsWith('/dev/dri/'), false, 'render nodes must not use host stat');
            return fs.statSync(target, ...args);
        };
        const store = createGpuGrantStore({ homeDirectory: home, fsApi, platform, engineRunner,
            renderOptions: platform === 'linux' ? tree : { env: {} } });
        const lock = { assertHeld(value) { assert.equal(value, identity.instance); } };
        store.materialize(identity, wiring, lock);
        const kept = observeContainerGpuWiring(observed(wiring), { identity, homeDirectory: home });
        store.materialize(identity, kept, lock);
        if (platform === 'linux') fs.writeFileSync(`${tree.root}/.stat/renderD128`, '21b0 e2 80\n');
        else report = REPORT.replace('21b6', '21b0');
        assert.throws(() => store.materialize(identity, kept, lock), /group-only/);
    }
});

test('downgrade: per-agent revoke keeps render wiring for a second consumer; workspace revoke removes it', (t) => {
    const discovery = discoverVulkanRenderNode(linux(makeTree(t)));
    const declared = [AGENT, 'other/consumer'];
    const options = { discover: () => discovery };
    const all = resolveDesiredGpuWiring(IDENTITY, null, declared, options);
    const denied = resolveDesiredGpuWiring(IDENTITY, { vendor: 'nvidia', agents: [], denied: [AGENT] }, declared, options);
    assert.deepEqual(denied.devices, all.devices);
    assert.deepEqual(denied.agents, ['other/consumer']);
    const revoked = resolveDesiredGpuWiring(IDENTITY, { vendor: 'nvidia', agents: [], workspaceDenied: true }, declared, options);
    assert.equal(revoked.state, 'revoked');
    assert.deepEqual(revoked.devices, []);
    assert.equal(revoked.mounts.length, 1);
    assert.equal(revoked.mounts.some((entry) => entry.destination === '/etc/cdi/ploinky-gpu.json'), false);
    assert.equal(resolveDesiredGpuWiring(IDENTITY, null, declared, options).fingerprint, all.fingerprint);
});
