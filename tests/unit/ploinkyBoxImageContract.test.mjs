import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    IMAGE_CONTRACT,
    IMAGE_PROBE_TIMEOUT_MS,
    WEBTTY_NATIVE_PROBE_TIMEOUT_MS,
    inspectAndValidateImage,
    inspectAndValidateExistingImage,
    normalizeImageInspect,
    probeImageBinaries,
    probeWebttyNativeRuntime,
    validateImageContract,
} from '../../ploinky-box/contract/image.mjs';
import {
    nativeRuntimeExpectation,
} from '../../core-services/webtty/native-runtime.mjs';

function validRecord({ architecture = 'arm64' } = {}) {
    return [{
        Id: 'sha256:image-id',
        Os: 'linux',
        Architecture: architecture,
        Config: {
            User: IMAGE_CONTRACT.user,
            WorkingDir: IMAGE_CONTRACT.workdir,
            Env: Object.entries(IMAGE_CONTRACT.environment).map(([key, value]) => `${key}=${value}`),
            Entrypoint: [IMAGE_CONTRACT.entrypoint],
            Cmd: [],
            Volumes: {},
            Labels: {},
        },
    }];
}

function validNativeProbe({ architecture = 'arm64', ...overrides } = {}) {
    return {
        ...nativeRuntimeExpectation({ platform: 'linux', architecture }),
        nativeArtifactSha256: 'a'.repeat(64),
        sourceSha: 'b'.repeat(40),
        uid: 1000,
        gid: 1000,
        pty: {
            import: true,
            input: true,
            output: true,
            resize: true,
            exit: true,
            reap: true,
            identity: true,
        },
        ...overrides,
    };
}

function admissionRunner({
    firstRecord = validRecord(),
    secondRecord = firstRecord,
    nativeProbe = validNativeProbe({ architecture: firstRecord[0].Architecture }),
} = {}) {
    const calls = [];
    let inspections = 0;
    return {
        calls,
        query(engine, args, options) {
            calls.push({ engine, args, options });
            if (args[0] === 'image' && args[1] === 'inspect') {
                const record = inspections++ === 0 ? firstRecord : secondRecord;
                return { ok: true, stdout: JSON.stringify(record), stderr: '' };
            }
            if (args.includes('--entrypoint=/bin/bash')) {
                return {
                    ok: true,
                    stdout: binaries.map((binary) => (
                        binary.startsWith('/') ? binary : `/usr/bin/${binary}`
                    )).join('\n'),
                    stderr: '',
                };
            }
            if (args.includes('--entrypoint=/usr/local/bin/node')) {
                return { ok: true, stdout: JSON.stringify(nativeProbe), stderr: '' };
            }
            return { ok: false, stdout: '', stderr: `unexpected ${args.join(' ')}` };
        },
    };
}

const binaries = [
    ...IMAGE_CONTRACT.requiredBinaries,
    IMAGE_CONTRACT.networkHelpers[0],
];

test('complete semantic image metadata validates to an immutable image handle', () => {
    const normalized = normalizeImageInspect(validRecord());
    const result = validateImageContract(normalized, 'runtime', { availableBinaries: binaries });
    assert.equal(result.immutableId, 'sha256:image-id');
});

test('every required image field has a field-specific fail-closed diagnostic', () => {
    const mutations = [
        ['image ID', (record) => { record[0].Id = ''; }],
        ['Config.Labels', (record) => { record[0].Config.Labels.unexpected = 'present'; }],
        ['Config.Labels', (record) => { record[0].Config.Labels = []; }],
        ['Config.User', (record) => { record[0].Config.User = 'root'; }],
        ['Config.WorkingDir', (record) => { record[0].Config.WorkingDir = '/tmp'; }],
        ['Config.Env', (record) => { record[0].Config.Env.pop(); }],
        ['Config.Env', (record) => { record[0].Config.Env.push('EXTRA=1'); }],
        ['Config.Entrypoint', (record) => { record[0].Config.Entrypoint = 'not-an-array'; }],
        ['Config.Cmd', (record) => { record[0].Config.Cmd = ['serve']; }],
        ['Config.Volumes', (record) => { record[0].Config.Volumes = { '/data': {} }; }],
    ];
    for (const [field, mutate] of mutations) {
        const record = validRecord();
        mutate(record);
        assert.throws(
            () => validateImageContract(normalizeImageInspect(record), 'runtime', {
                availableBinaries: binaries,
            }),
            new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        );
    }
});

test('images with stale or unexpected labels hard-cut before any binary probe matters', () => {
    const record = validRecord();
    record[0].Config.Labels['io.assistos.ploinky.unexpected'] = 'retired';
    assert.throws(
        () => validateImageContract(normalizeImageInspect(record), 'old-runtime', {
            availableBinaries: [],
        }),
        (error) => error.code === 'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT'
            && error.message.includes('Config.Labels')
            && /destroy and recreate/i.test(error.message),
    );
});

test('an existing owned image is probed by immutable ID and re-inspected before admission', () => {
    const record = validRecord();
    const runner = admissionRunner({ firstRecord: record });
    const image = inspectAndValidateExistingImage(
        'podman', 'sha256:image-id', 'runtime', runner,
    );
    assert.equal(image.immutableId, 'sha256:image-id');
    assert.deepEqual(runner.calls.map(({ args }) => args.slice(0, 2)), [
        ['image', 'inspect'],
        ['run', '--rm'],
        ['run', '--rm'],
        ['image', 'inspect'],
    ]);
    assert.equal(runner.calls[1].args.includes('sha256:image-id'), true);
    assert.equal(runner.calls[2].args.includes('sha256:image-id'), true);
    assert.equal(runner.calls[2].args.includes('--network=none'), true);
    assert.equal(runner.calls[2].args.includes('--pull=never'), true);
    assert.equal(runner.calls[2].args.at(-1), '--verify');

    record[0].Config.Labels['io.assistos.ploinky.unexpected'] = 'retired';
    const incompatibleRunner = admissionRunner({ firstRecord: record });
    assert.throws(
        () => inspectAndValidateExistingImage(
            'podman', 'sha256:image-id', 'old-runtime', incompatibleRunner,
        ),
        (error) => error.code === 'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT'
            && /destroy and recreate/i.test(error.message),
    );
    assert.equal(incompatibleRunner.calls.length, 1);
});

test('newly obtained images use the same immutable native admission path', () => {
    const runner = admissionRunner();
    const image = inspectAndValidateImage('podman', 'assistos/ploinky-box', runner);
    assert.equal(image.immutableId, 'sha256:image-id');
    assert.deepEqual(runner.calls.filter(({ args }) => args[0] === 'image').map(({ args }) => args[2]), [
        'assistos/ploinky-box',
        'sha256:image-id',
    ]);
    assert.equal(runner.calls.filter(({ args }) => args[0] === 'run').every(({ args }) => (
        args.includes('sha256:image-id')
    )), true);
});

test('native runtime contract is accepted for each supported architecture', () => {
    for (const architecture of ['amd64', 'arm64']) {
        const record = validRecord({ architecture });
        const runner = admissionRunner({
            firstRecord: record,
            nativeProbe: validNativeProbe({ architecture }),
        });
        assert.equal(
            inspectAndValidateExistingImage(
                'podman', 'sha256:image-id', `runtime-${architecture}`, runner,
            ).architecture,
            architecture,
        );
    }
});

test('native runtime failures hard-cut Box admission with bounded categories and no install advice', () => {
    for (const [category, nativeProbe] of [
        ['architecture', validNativeProbe({ architecture: 'amd64' })],
        ['native-artifact-sha256', validNativeProbe({ nativeArtifactSha256: 'tampered' })],
        ['package-lock', validNativeProbe({ packageLockSha256: 'c'.repeat(64) })],
    ]) {
        const runner = admissionRunner({ nativeProbe });
        assert.throws(
            () => inspectAndValidateExistingImage(
                'podman', 'sha256:image-id', 'runtime', runner,
            ),
            (error) => error.code === 'PLOINKY_BOX_WEBTTY_NATIVE_CONTRACT_INVALID'
                && error.message.includes(category)
                && error.message.includes('sha256:image-id')
                && !/npm/i.test(error.message),
        );
    }
});

test('native probe output is bounded and malformed output fails closed', () => {
    for (const stdout of ['not-json', 'x'.repeat(16 * 1024 + 1)]) {
        const runner = {
            query() {
                return { ok: true, stdout, stderr: '' };
            },
        };
        assert.throws(
            () => probeWebttyNativeRuntime(
                'podman',
                'sha256:image-id',
                normalizeImageInspect(validRecord()),
                runner,
            ),
            (error) => error.code === 'PLOINKY_BOX_WEBTTY_NATIVE_CONTRACT_INVALID'
                && /probe-output-(?:json|size)/.test(error.message),
        );
    }
});

test('native probe process failures expose only a bounded stable category', () => {
    for (const [result, expected] of [
        [{ ok: false, stdout: '', stderr: 'WebTTY native probe failed: contract-artifact-sha256\n' }, 'contract-artifact-sha256'],
        [{ ok: false, stdout: '', stderr: 'untrusted diagnostic with /host/private/path' }, 'probe-failed'],
        [{ ok: false, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }, 'timeout'],
    ]) {
        const runner = { query: () => result };
        assert.throws(
            () => probeWebttyNativeRuntime(
                'podman',
                'sha256:image-id',
                normalizeImageInspect(validRecord()),
                runner,
            ),
            (error) => error.code === 'PLOINKY_BOX_WEBTTY_NATIVE_CONTRACT_INVALID'
                && error.message.includes(expected)
                && !error.message.includes('/host/private/path')
                && /build or pull a compatible runtime image and recreate the Box/.test(error.message),
        );
    }
});

test('image identity is rechecked after probes and an unexpected ID fails closed', () => {
    const changed = validRecord();
    changed[0].Id = 'sha256:different-id';
    const runner = admissionRunner({ secondRecord: changed });
    assert.throws(
        () => inspectAndValidateExistingImage(
            'podman', 'sha256:image-id', 'runtime', runner,
        ),
        /image ID.*sha256:image-id.*sha256:different-id/,
    );
});

test('required binaries and one rootless network helper are mandatory', () => {
    const normalized = normalizeImageInspect(validRecord());
    for (const missing of IMAGE_CONTRACT.requiredBinaries) {
        assert.throws(
            () => validateImageContract(normalized, 'runtime', {
                availableBinaries: binaries.filter((binary) => binary !== missing),
            }),
            new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        );
    }
    assert.throws(
        () => validateImageContract(normalized, 'runtime', {
            availableBinaries: IMAGE_CONTRACT.requiredBinaries,
        }),
        /rootless network helper/,
    );
});

test('fresh image capability probes allow a cold rootless container start', () => {
    const calls = [];
    const runner = {
        query(engine, args, options) {
            calls.push({ engine, args, options });
            return {
                ok: true,
                stdout: binaries.map((binary) => (
                    binary.startsWith('/') ? binary : `/usr/bin/${binary}`
                )).join('\n'),
                stderr: '',
            };
        },
    };
    probeImageBinaries('podman', 'sha256:image-id', runner);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.timeoutMs, IMAGE_PROBE_TIMEOUT_MS);
    assert.ok(IMAGE_PROBE_TIMEOUT_MS >= 60_000);
    assert.match(calls[0].args.at(-1), /test "\$\(id -u\)" -eq 1000/);
    assert.match(calls[0].args.at(-1), /test "\$\(id -g\)" -eq 1000/);
});

test('native image probes are time-bounded', () => {
    const calls = [];
    const runner = {
        query(engine, args, options) {
            calls.push({ engine, args, options });
            return { ok: true, stdout: JSON.stringify(validNativeProbe()), stderr: '' };
        },
    };
    probeWebttyNativeRuntime(
        'podman',
        'sha256:image-id',
        normalizeImageInspect(validRecord()),
        runner,
    );
    assert.equal(calls[0].options.timeoutMs, WEBTTY_NATIVE_PROBE_TIMEOUT_MS);
    assert.ok(WEBTTY_NATIVE_PROBE_TIMEOUT_MS >= 60_000);
});

test('image contract requires cloudflared and entrypoint validates token-file support', () => {
    assert.equal(IMAGE_CONTRACT.requiredBinaries.includes('cloudflared'), true);
    const entrypoint = fs.readFileSync(path.resolve(
        import.meta.dirname,
        '../../ploinky-box/entrypoint/ploinky-box-entrypoint',
    ), 'utf8');
    assert.match(entrypoint, /cloudflared tunnel run --help/);
    assert.match(entrypoint, /--token-file/);
    assert.match(entrypoint, /EXPECTED_CLOUDFLARED_VERSION/);
    assert.match(entrypoint, /process UID must be 1000/);
    assert.match(entrypoint, /process GID must be 1000/);
});

test('entrypoint reports actionable device and SELinux diagnostics', () => {
    const entrypoint = fs.readFileSync(path.resolve(
        import.meta.dirname,
        '../../ploinky-box/entrypoint/ploinky-box-entrypoint',
    ), 'utf8');
    assert.match(entrypoint, /missing or inaccessible inside ploinky-box/);
    assert.match(entrypoint, /Podman accepted --device \$device/);
    assert.match(entrypoint, /SELinux hosts the Box also requires --security-opt label=disable/);
});
