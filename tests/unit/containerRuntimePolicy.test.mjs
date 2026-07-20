import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RuntimePolicyError,
    buildEffectivePolicy,
    computeRuntimePolicyHash,
    emitRunArgs,
    validatePolicyShape,
} from '../../cli/sandbox/docker/containerRuntimePolicy.js';

test('validatePolicyShape rejects rawArgs', () => {
    assert.throws(
        () => validatePolicyShape({ rawArgs: ['--something'] }, 'policy'),
        (err) => err instanceof RuntimePolicyError && /rawArgs is not permitted/.test(err.message),
    );
});

test('validatePolicyShape rejects implicit privileged', () => {
    assert.throws(
        () => validatePolicyShape({ privileged: true }, 'policy'),
        /implicit privileged is not permitted/,
    );
});

test('validatePolicyShape rejects unknown keys', () => {
    assert.throws(
        () => validatePolicyShape({ network: 'host' }, 'policy'),
        /unknown field 'network'/,
    );
});

test('validatePolicyShape rejects manifest volume fields inside runtime policy', () => {
    assert.throws(
        () => validatePolicyShape({ volumes: { '/host': '/data' } }, 'policy'),
        /'volumes' is not permitted inside runtime policy/,
    );
});

test('validatePolicyShape rejects arbitrary host devices', () => {
    assert.throws(
        () => validatePolicyShape({
            devices: [{ type: 'hostDevice', hostPath: '/etc/passwd' }],
        }, 'policy'),
        /must start with \/dev\/|not in the allowlist/,
    );
    assert.throws(
        () => validatePolicyShape({
            devices: [{ type: 'hostDevice', hostPath: '/dev/sda' }],
        }, 'policy'),
        /not in the allowlist/,
    );
});

test('validatePolicyShape accepts allowlisted CDI devices', () => {
    const normalized = validatePolicyShape({
        devices: [{ type: 'cdi', value: 'nvidia.com/gpu=all' }],
    }, 'policy', { runtime: 'podman' });
    assert.equal(normalized.devices[0].value, 'nvidia.com/gpu=all');
});

test('emitRunArgs emits CDI device entries for podman NVIDIA policies', () => {
    const normalized = validatePolicyShape({
        devices: [{ type: 'cdi', value: 'nvidia.com/gpu=all' }],
    }, 'policy', { runtime: 'podman' });
    const args = emitRunArgs(normalized, { runtime: 'podman' });
    assert.deepEqual(args, ['--device', 'nvidia.com/gpu=all']);
});

test('validatePolicyShape rejects CDI on docker by default', () => {
    assert.throws(
        () => validatePolicyShape({
            devices: [{ type: 'cdi', value: 'nvidia.com/gpu=all' }],
        }, 'policy', { runtime: 'docker' }),
        /CDI devices are only supported on podman/,
    );
});

test('emitRunArgs emits --gpus all for docker but rejects --gpus for podman', () => {
    const dockerArgs = emitRunArgs({ gpus: 'all', platform: 'linux/amd64' }, { runtime: 'docker' });
    assert.ok(dockerArgs.includes('--gpus'));
    assert.ok(dockerArgs.includes('all'));
    assert.ok(dockerArgs.includes('--platform'));
    assert.ok(dockerArgs.includes('linux/amd64'));

    assert.throws(
        () => validatePolicyShape({ gpus: 'all' }, 'policy', { runtime: 'podman' }),
        /podman does not support --gpus/,
    );
});

test('emitRunArgs emits --device entries for ROCm host devices and label=disable', () => {
    const policy = validatePolicyShape({
        platform: 'linux/amd64',
        devices: [
            { type: 'hostDevice', hostPath: '/dev/kfd' },
            { type: 'hostDevice', hostPath: '/dev/dri' },
        ],
        securityOpt: ['label=disable'],
        ipc: 'host',
    }, 'policy', { runtime: 'docker' });
    const args = emitRunArgs(policy, { runtime: 'docker' });
    assert.ok(args.includes('/dev/kfd'));
    assert.ok(args.includes('/dev/dri'));
    assert.ok(args.includes('label=disable'));
    assert.ok(args.includes('host'));
});

test('emitRunArgs emits memlock ulimit and shm-size for GPU policies', () => {
    const policy = validatePolicyShape({
        resources: {
            memory: '8g',
            shmSize: '1g',
            ulimits: { memlock: { soft: -1, hard: -1 } },
        },
    }, 'policy', { runtime: 'docker' });
    const args = emitRunArgs(policy, { runtime: 'docker' });
    assert.ok(args.includes('--memory'));
    assert.ok(args.includes('8g'));
    assert.ok(args.includes('--shm-size'));
    assert.ok(args.includes('1g'));
    assert.ok(args.includes('--ulimit'));
    assert.ok(args.some((a) => a.startsWith('memlock=')));
});

test('buildEffectivePolicy merges catalog and override layers and validates result', () => {
    const merged = buildEffectivePolicy({
        catalogPolicy: { platform: 'linux/amd64', resources: { memory: '4g' } },
        overridePolicy: { resources: { memory: '6g', cpus: '4' } },
    }, { runtime: 'docker' });
    assert.equal(merged.platform, 'linux/amd64');
    assert.equal(merged.resources.memory, '6g');
    assert.equal(merged.resources.cpus, '4');
});

test('computeRuntimePolicyHash is stable for equal canonical policies and changes when fields change', () => {
    const a = computeRuntimePolicyHash({ platform: 'linux/amd64', resources: { memory: '4g', cpus: '2' } });
    const b = computeRuntimePolicyHash({ resources: { cpus: '2', memory: '4g' }, platform: 'linux/amd64' });
    assert.equal(a, b);
    const c = computeRuntimePolicyHash({ platform: 'linux/amd64', resources: { memory: '8g', cpus: '2' } });
    assert.notEqual(a, c);
});
