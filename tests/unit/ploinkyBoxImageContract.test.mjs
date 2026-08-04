import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    IMAGE_CONTRACT,
    IMAGE_PROBE_TIMEOUT_MS,
    inspectAndValidateImage,
    inspectAndValidateExistingImage,
    normalizeImageInspect,
    probeImageBinaries,
    validateImageContract,
} from '../../ploinky-box/contract/image.mjs';

const SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';

function validRecord() {
    return [{
        Id: 'sha256:image-id',
        Config: {
            User: IMAGE_CONTRACT.user,
            WorkingDir: IMAGE_CONTRACT.workdir,
            Env: Object.entries(IMAGE_CONTRACT.environment).map(([key, value]) => `${key}=${value}`),
            Entrypoint: [IMAGE_CONTRACT.entrypoint],
            Cmd: [],
            Volumes: {},
            Labels: {
                [IMAGE_CONTRACT.sourceShaLabel]: SOURCE_SHA,
            },
        },
    }];
}

const binaries = [
    ...IMAGE_CONTRACT.requiredBinaries,
    IMAGE_CONTRACT.networkHelpers[0],
];

test('complete semantic image metadata validates to an immutable image handle', () => {
    const normalized = normalizeImageInspect(validRecord());
    const result = validateImageContract(normalized, 'runtime', { availableBinaries: binaries });
    assert.equal(result.immutableId, 'sha256:image-id');
    assert.equal(result.sourceSha, SOURCE_SHA);
});

test('every required image field has a field-specific fail-closed diagnostic', () => {
    const mutations = [
        ['image ID', (record) => { record[0].Id = ''; }],
        ['Config.Labels', (record) => { record[0].Config.Labels.unexpected = 'present'; }],
        ['Config.Labels', (record) => { record[0].Config.Labels = []; }],
        ['Config.Labels', (record) => { record[0].Config.Labels[IMAGE_CONTRACT.sourceShaLabel] = 'main'; }],
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

test('images with stale, missing, or unexpected source provenance hard-cut before any binary probe matters', () => {
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
    for (const invalidLabels of [{}, {
        [IMAGE_CONTRACT.sourceShaLabel]: SOURCE_SHA.toUpperCase(),
    }]) {
        const invalid = validRecord();
        invalid[0].Config.Labels = invalidLabels;
        assert.throws(
            () => validateImageContract(normalizeImageInspect(invalid), 'old-runtime'),
            (error) => error.code === 'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT',
        );
    }
});

test('an existing owned image is inspected by immutable ID without a binary probe', () => {
    const record = validRecord();
    const calls = [];
    const runner = {
        query(engine, args) {
            calls.push([engine, ...args]);
            return { ok: true, stdout: JSON.stringify(record), stderr: '' };
        },
    };
    const image = inspectAndValidateExistingImage(
        'podman', 'sha256:image-id', 'runtime', runner,
    );
    assert.equal(image.immutableId, 'sha256:image-id');
    assert.deepEqual(calls, [['podman', 'image', 'inspect', 'sha256:image-id']]);

    record[0].Config.Labels['io.assistos.ploinky.unexpected'] = 'retired';
    assert.throws(
        () => inspectAndValidateExistingImage(
            'podman', 'sha256:image-id', 'old-runtime', runner,
        ),
        (error) => error.code === 'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT'
            && /destroy and recreate/i.test(error.message),
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
    probeImageBinaries('podman', 'sha256:image-id', runner, {
        expectedSourceSha: SOURCE_SHA,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.timeoutMs, IMAGE_PROBE_TIMEOUT_MS);
    assert.ok(IMAGE_PROBE_TIMEOUT_MS >= 60_000);
    const probe = calls[0].args.at(-1);
    assert.match(probe, /bubblewrap-0:0\.11\.0-4\.fc44/);
    assert.match(probe, /--bind-fd FD DEST/);
    assert.match(probe, /ploinky-bwrap-launch-v1 source-sha=/);
    assert.match(probe, /openat2-beneath-no-magiclinks-no-symlinks/);
    assert.throws(
        () => probeImageBinaries('podman', 'sha256:image-id', runner),
        /Ploinky source SHA/,
    );
});

test('fresh image validation binds the helper ABI probe to the exact source label', () => {
    const calls = [];
    const runner = {
        query(engine, args) {
            calls.push({ engine, args });
            if (args[0] === 'image') {
                return { ok: true, stdout: JSON.stringify(validRecord()), stderr: '' };
            }
            return {
                ok: true,
                stdout: binaries.map((binary) => (
                    binary.startsWith('/') ? binary : `/usr/bin/${binary}`
                )).join('\n'),
                stderr: '',
            };
        },
    };
    const image = inspectAndValidateImage('podman', 'runtime', runner);
    assert.equal(image.sourceSha, SOURCE_SHA);
    const probe = calls.find(({ args }) => args[0] === 'run').args.at(-1);
    assert.match(probe, new RegExp(`helper_version.*${SOURCE_SHA}`));
    assert.doesNotMatch(probe, /helper_version.*source-sha=\[0-9a-f\]/);
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
    assert.match(entrypoint, /EXPECTED_BUBBLEWRAP_NEVRA='bubblewrap-0:0\.11\.0-4\.fc44'/);
    assert.match(entrypoint, /path-resolution=openat2-beneath-no-magiclinks-no-symlinks/);
    assert.match(entrypoint, /Bubblewrap launcher must not have file capabilities/);
    assert.match(entrypoint, /cannot inspect Bubblewrap launcher file capabilities/);
    assert.match(entrypoint, /command -v getcap/);
    assert.doesNotMatch(entrypoint, /PLOINKY_DISABLE_HOST_SANDBOX/);
});
