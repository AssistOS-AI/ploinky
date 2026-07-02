import test from 'node:test';
import assert from 'node:assert/strict';

import * as hardwareDetection from '../../cli/services/hardwareDetection.js';

const {
    detectHardware,
    normalizeArch,
    normalizePlatform,
    summarizeAcceleratorFamilies,
} = hardwareDetection;

test('normalizeArch maps Node and uname variants to amd64/arm64', () => {
    assert.equal(normalizeArch('x64'), 'amd64');
    assert.equal(normalizeArch('x86_64'), 'amd64');
    assert.equal(normalizeArch('amd64'), 'amd64');
    assert.equal(normalizeArch('arm64'), 'arm64');
    assert.equal(normalizeArch('aarch64'), 'arm64');
    assert.equal(normalizeArch('unknown'), 'unknown');
    assert.equal(normalizeArch(''), null);
});

test('normalizePlatform maps to canonical OCI platform strings', () => {
    assert.equal(normalizePlatform('x64'), 'linux/amd64');
    assert.equal(normalizePlatform('aarch64'), 'linux/arm64');
    assert.equal(normalizePlatform('mips'), null);
});

test('summarizeAcceleratorFamilies always includes cpu and adds confirmed gpu families', () => {
    assert.deepEqual(summarizeAcceleratorFamilies({}), ['cpu']);
    assert.deepEqual(summarizeAcceleratorFamilies({ nvidiaSmi: { ok: true } }), ['cpu', 'nvidia-cuda']);
    assert.deepEqual(
        summarizeAcceleratorFamilies({ kfdDevice: { ok: true }, driDevice: { ok: true } }),
        ['cpu'],
        'ROCm requires a runtime confirmation probe in addition to /dev/kfd and /dev/dri',
    );
    assert.deepEqual(
        summarizeAcceleratorFamilies({ driDevice: { ok: true } }),
        ['cpu'],
        'Vulkan/OpenVINO must not be inferred from /dev/dri alone',
    );
    const both = summarizeAcceleratorFamilies({
        kfdDevice: { ok: true },
        driDevice: { ok: true },
        amdSmi: { ok: true },
        vulkanInfo: { ok: true, stdoutSnippet: 'GPU id = 0 (Example Renderer)' },
        intelPci: { ok: true, stdoutSnippet: '00:02.0 VGA compatible controller [0300]: Intel Corporation [8086:1234]' },
    });
    assert.deepEqual(both.sort(), ['amd-rocm', 'cpu', 'intel-openvino', 'vulkan'].sort());
});

test('parseNvidiaComputeCapability returns the highest valid compute capability', () => {
    assert.equal(typeof hardwareDetection.parseNvidiaComputeCapability, 'function');
    assert.equal(hardwareDetection.parseNvidiaComputeCapability('12.1\n8.9\n'), '12.1');
    assert.equal(hardwareDetection.parseNvidiaComputeCapability('8.9\n12.2\n12.1\n'), '12.2');
    assert.equal(hardwareDetection.parseNvidiaComputeCapability('not available\n'), null);
});

test('detectHardware populates NVIDIA compute capability when query probe succeeds', () => {
    const hardware = detectHardware({
        runtime: 'docker',
        arch: 'arm64',
        probes: {
            nvidiaSmi: { kind: 'command', command: 'true' },
            nvidiaComputeCapability: { kind: 'command', command: 'printf', args: ['12.1\n8.9\n'] },
        },
        dockerInspect: () => ({ platform: 'linux/arm64', arch: 'arm64', rawArch: 'aarch64', rawOsType: 'linux' }),
    });
    assert.deepEqual(hardware.acceleratorFamilies, ['cpu', 'nvidia-cuda']);
    assert.deepEqual(hardware.acceleratorDetails, {
        'nvidia-cuda': { computeCapability: '12.1' },
    });
});

test('detectHardware parses NVIDIA compute capability from full probe output', () => {
    const hardware = detectHardware({
        runtime: 'docker',
        arch: 'arm64',
        probes: {
            nvidiaSmi: { kind: 'command', command: 'true' },
            nvidiaComputeCapability: { kind: 'command', command: 'printf', args: ['8.0\n8.0\n8.0\n12.1\n'] },
        },
        dockerInspect: () => ({ platform: 'linux/arm64', arch: 'arm64', rawArch: 'aarch64', rawOsType: 'linux' }),
    });
    assert.equal(hardware.probes.nvidiaComputeCapability.stdoutSnippet, '8.0\n8.0\n8.0');
    assert.deepEqual(hardware.acceleratorDetails, {
        'nvidia-cuda': { computeCapability: '12.1' },
    });
});

test('detectHardware uses injected daemon inspector for docker', () => {
    const fakeInspect = () => ({ platform: 'linux/amd64', arch: 'amd64', rawArch: 'x86_64', rawOsType: 'linux' });
    const hardware = detectHardware({
        runtime: 'docker',
        arch: 'x64',
        probes: {},
        dockerInspect: fakeInspect,
    });
    assert.equal(hardware.runtime, 'docker');
    assert.equal(hardware.ociPlatform, 'linux/amd64');
    assert.equal(hardware.nodeArch, 'amd64');
    assert.deepEqual(hardware.acceleratorFamilies, ['cpu']);
});

test('detectHardware uses injected podman inspector and parses arch', () => {
    const fakeInspect = () => ({ platform: 'linux/arm64', arch: 'arm64', rawArch: 'aarch64', rawOsType: 'linux' });
    const hardware = detectHardware({
        runtime: 'podman',
        arch: 'arm64',
        probes: {},
        podmanInspect: fakeInspect,
    });
    assert.equal(hardware.ociPlatform, 'linux/arm64');
    assert.equal(hardware.nodeArch, 'arm64');
});

test('detectHardware falls back to node platform when no daemon inspection succeeds', () => {
    const hardware = detectHardware({
        runtime: 'docker',
        arch: 'x64',
        probes: {},
        dockerInspect: () => null,
    });
    assert.equal(hardware.ociPlatform, 'linux/amd64');
});
