import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    CATALOG_VALIDATION_CONTRACT,
    CatalogValidationError,
    loadCatalog,
    validateRuntimePolicy,
    validateArchitectureRecord,
    validateImageRecord,
} from '../../cli/services/llmArchitectureCatalog.js';

function makeValidCatalog(rootPath) {
    fs.mkdirSync(path.join(rootPath, 'architectures'), { recursive: true });
    fs.mkdirSync(path.join(rootPath, 'images'), { recursive: true });
    fs.writeFileSync(path.join(rootPath, 'catalog.json'), JSON.stringify({
        schemaVersion: 1,
        catalogId: 'test/catalog',
        updatedAt: '2026-05-28',
        defaultFallback: 'cpu-amd64',
        architectures: [
            { id: 'cpu-amd64', path: 'architectures/cpu-amd64.json' },
        ],
        images: [
            { id: 'cpu-amd64', path: 'images/cpu-amd64.json' },
        ],
    }));
    fs.writeFileSync(path.join(rootPath, 'architectures/cpu-amd64.json'), JSON.stringify({
        id: 'cpu-amd64',
        status: 'stable',
        platform: 'linux/amd64',
        accelerator: { family: 'cpu' },
        match: { requiredProbes: [], containerRuntimes: ['docker', 'podman'] },
        image: 'cpu-amd64',
        runtimePolicy: {
            platform: 'linux/amd64',
            resources: { memory: '4g', cpus: '2', pidsLimit: 512, shmSize: '128m' },
            ipc: 'default',
        },
        engineDefaults: { enginePort: 8080, runtimePort: 9000 },
        fallbackPriority: 100,
    }));
    fs.writeFileSync(path.join(rootPath, 'images/cpu-amd64.json'), JSON.stringify({
        id: 'cpu-amd64',
        ref: 'docker.io/assistos/llm-runtime:cpu-amd64',
        platform: 'linux/amd64',
        engines: ['llamacpp'],
        build: {
            context: 'container-image-builds',
            dockerfile: 'container-image-builds/images/llm-runtime-cpu/Dockerfile',
            workflow: 'container-image-builds/.github/workflows/publish-llm-runtime-images.yml',
            engineVersionsLock: 'container-image-builds/images/llm-runtime-cpu/engineVersions.lock.json',
        },
    }));
}

test('loadCatalog accepts a valid catalog with required relationships', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-valid-'));
    try {
        makeValidCatalog(tmp);
        const result = loadCatalog({ env: { PLOINKY_LLM_ARCHITECTURES_PATH: tmp } });
        assert.equal(result.catalogId, 'test/catalog');
        assert.equal(result.source, 'path');
        assert.ok(result.architectures.has('cpu-amd64'));
        assert.ok(result.images.has('cpu-amd64'));
        assert.equal(result.defaultFallback, 'cpu-amd64');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('loadCatalog rejects unknown runtime policy fields', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-bad-'));
    try {
        makeValidCatalog(tmp);
        const badArch = JSON.parse(fs.readFileSync(path.join(tmp, 'architectures/cpu-amd64.json'), 'utf8'));
        badArch.runtimePolicy.rawArgs = ['--privileged'];
        fs.writeFileSync(path.join(tmp, 'architectures/cpu-amd64.json'), JSON.stringify(badArch));
        assert.throws(
            () => loadCatalog({ env: { PLOINKY_LLM_ARCHITECTURES_PATH: tmp } }),
            (err) => err instanceof CatalogValidationError && /rawArgs|unknown field/.test(err.message),
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('loadCatalog rejects path traversal in architecture references', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-traverse-'));
    try {
        fs.mkdirSync(path.join(tmp, 'architectures'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'images'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'catalog.json'), JSON.stringify({
            schemaVersion: 1,
            catalogId: 'test/escape',
            architectures: [{ id: 'cpu-amd64', path: 'architectures/../../etc/passwd' }],
            images: [{ id: 'cpu-amd64', path: 'images/cpu-amd64.json' }],
        }));
        assert.throws(
            () => loadCatalog({ env: { PLOINKY_LLM_ARCHITECTURES_PATH: tmp } }),
            /catalog\.json\.architectures\[0\]\.path: invalid value|escapes catalog root/i,
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('loadCatalog rejects catalog whose architecture references an unknown image', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-unknown-img-'));
    try {
        makeValidCatalog(tmp);
        const badArch = JSON.parse(fs.readFileSync(path.join(tmp, 'architectures/cpu-amd64.json'), 'utf8'));
        badArch.image = 'nonexistent';
        fs.writeFileSync(path.join(tmp, 'architectures/cpu-amd64.json'), JSON.stringify(badArch));
        assert.throws(
            () => loadCatalog({ env: { PLOINKY_LLM_ARCHITECTURES_PATH: tmp } }),
            /references unknown image/,
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('loadCatalog rejects architecture and image platform mismatch', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-platform-img-'));
    try {
        makeValidCatalog(tmp);
        const image = JSON.parse(fs.readFileSync(path.join(tmp, 'images/cpu-amd64.json'), 'utf8'));
        image.platform = 'linux/arm64';
        fs.writeFileSync(path.join(tmp, 'images/cpu-amd64.json'), JSON.stringify(image));
        assert.throws(
            () => loadCatalog({ env: { PLOINKY_LLM_ARCHITECTURES_PATH: tmp } }),
            /platform 'linux\/arm64' does not match architecture platform 'linux\/amd64'/,
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('loadCatalog rejects architecture and runtime policy platform mismatch', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-platform-policy-'));
    try {
        makeValidCatalog(tmp);
        const arch = JSON.parse(fs.readFileSync(path.join(tmp, 'architectures/cpu-amd64.json'), 'utf8'));
        arch.runtimePolicy.platform = 'linux/arm64';
        fs.writeFileSync(path.join(tmp, 'architectures/cpu-amd64.json'), JSON.stringify(arch));
        assert.throws(
            () => loadCatalog({ env: { PLOINKY_LLM_ARCHITECTURES_PATH: tmp } }),
            /runtimePolicy\.platform 'linux\/arm64' does not match architecture platform 'linux\/amd64'/,
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('validateImageRecord accepts engine inventory, build workflow metadata, and optional digest', () => {
    assert.doesNotThrow(() => validateImageRecord({
        id: 'nvidia-amd64',
        ref: 'docker.io/assistos/llm-runtime:nvidia-amd64',
        digest: 'sha256:' + 'a'.repeat(64),
        platform: 'linux/amd64',
        engines: ['llamacpp', 'vllm', 'sglang', 'trtllm'],
        build: {
            context: 'container-image-builds',
            dockerfile: 'container-image-builds/images/llm-runtime-nvidia-amd64/Dockerfile',
            workflow: 'container-image-builds/.github/workflows/publish-llm-runtime-images.yml',
            engineVersionsLock: 'container-image-builds/images/llm-runtime-nvidia-amd64/engineVersions.lock.json',
        },
    }, 'image'));
});

test('validateImageRecord accepts safe external catalog build topology', () => {
    assert.doesNotThrow(() => validateImageRecord({
        id: 'cpu-amd64',
        ref: 'ghcr.io/acme/llm-runtime:cpu-amd64',
        platform: 'linux/amd64',
        engines: ['llamacpp'],
        build: {
            context: 'runtime-images',
            dockerfile: 'runtime-images/acme/Dockerfile',
            workflow: '.github/workflows/publish.yml',
            engineVersionsLock: 'runtime-images/acme/engineVersions.lock.json',
        },
    }, 'image'));
});

test('validateImageRecord rejects unsafe image metadata shapes', () => {
    const base = {
        id: 'cpu-amd64',
        ref: 'docker.io/assistos/llm-runtime:cpu-amd64',
        platform: 'linux/amd64',
        engines: ['llamacpp'],
        build: {
            context: 'container-image-builds',
            dockerfile: 'container-image-builds/images/llm-runtime-cpu/Dockerfile',
            workflow: 'container-image-builds/.github/workflows/publish-llm-runtime-images.yml',
            engineVersionsLock: 'container-image-builds/images/llm-runtime-cpu/engineVersions.lock.json',
        },
    };
    assert.throws(
        () => validateImageRecord({ ...base, modelIds: ['org/model'] }, 'image'),
        /unknown field 'modelIds'/,
    );
    assert.throws(
        () => validateImageRecord({ ...base, ref: 'docker.io/assistos/${AGENT_IMAGE_NAME}:cpu-amd64' }, 'image'),
        /ref: invalid/,
    );
    assert.throws(
        () => validateImageRecord({ ...base, digest: 'sha256:nothex' }, 'image'),
        /digest: must be sha256:<64 hex>/,
    );
    assert.throws(
        () => validateImageRecord({ ...base, engines: ['llamacpp', 'bash'] }, 'image'),
        /engines: unsupported engine 'bash'/,
    );
    assert.throws(
        () => validateImageRecord({
            ...base,
            build: { ...base.build, context: '../container-image-builds' },
        }, 'image'),
        /build\.context: invalid/,
    );
    assert.throws(
        () => validateImageRecord({
            ...base,
            build: { ...base.build, args: ['--privileged'] },
        }, 'image'),
        /unknown field 'args'/,
    );
});

test('validateImageRecord accepts safe build paths and rejects unsafe build paths', () => {
    const base = {
        id: 'cpu-amd64',
        ref: 'docker.io/assistos/llm-runtime:cpu-amd64',
        platform: 'linux/amd64',
        engines: ['llamacpp'],
        build: {
            context: 'container-image-builds',
            dockerfile: 'container-image-builds/images/llm-runtime-cpu/Dockerfile',
            workflow: 'container-image-builds/.github/workflows/publish-llm-runtime-images.yml',
            engineVersionsLock: 'container-image-builds/images/llm-runtime-cpu/engineVersions.lock.json',
        },
    };
    const examplesByField = {
        context: {
            accepted: ['container-image-builds', 'runtime-images', 'build/families/cpu'],
            rejected: ['container-image-builds/', '/container-image-builds', '../container-image-builds', 'container-${REPO}'],
        },
        dockerfile: {
            accepted: [
                'container-image-builds/images/llm-runtime-cpu/Dockerfile',
                'container-image-builds/images/llm-runtime-nvidia-spark-arm64-sm121/Dockerfile',
                'Dockerfile.amd64',
                'images/llm-runtime-cpu/Dockerfile',
                'runtime-images/acme/Dockerfile',
            ],
            rejected: ['/runtime-images/acme/Dockerfile', '../container-image-builds/images/llm-runtime-cpu/Dockerfile', 'runtime-images//Dockerfile', 'runtime-images/${IMAGE}/Dockerfile'],
        },
        workflow: {
            accepted: [
                'container-image-builds/.github/workflows/publish-llm-runtime-images.yml',
                '.github/workflows/build-llm-runtime.yml',
                'container-image-builds/.github/workflows/build-llm-runtime.yml',
                'container-image-builds/.github/workflows/publish-llm-runtime-images.yaml',
                '.github/workflows/publish.yml',
            ],
            rejected: ['/workflows/publish.yml', '../container-image-builds/.github/workflows/publish-llm-runtime-images.yml', '.github//workflows/publish.yml', '.github/workflows/${WORKFLOW}.yml'],
        },
        engineVersionsLock: {
            accepted: [
                'container-image-builds/images/llm-runtime-cpu/engineVersions.lock.json',
                'container-image-builds/images/llm-runtime-nvidia-amd64/engineVersions.lock.json',
                'llm-runtime/engine-versions.lock',
                'container-image-builds/images/llm-runtime-cpu/engine-versions.lock',
                'container-image-builds/images/llm-runtime-cpu/engineVersions.lock',
                'runtime-images/acme/engineVersions.lock.json',
            ],
            rejected: ['/runtime-images/acme/engineVersions.lock.json', '../container-image-builds/images/llm-runtime-cpu/engineVersions.lock.json', 'runtime-images//engineVersions.lock.json', 'runtime-images/${IMAGE}/engineVersions.lock.json'],
        },
    };
    for (const [field, examples] of Object.entries(examplesByField)) {
        for (const accepted of examples.accepted) {
            assert.doesNotThrow(
                () => validateImageRecord({ ...base, build: { ...base.build, [field]: accepted } }, 'image'),
                `${field} ${accepted} should be accepted`,
            );
        }
        for (const rejected of examples.rejected) {
            assert.throws(
                () => validateImageRecord({ ...base, build: { ...base.build, [field]: rejected } }, 'image'),
                new RegExp(`build\\.${field}: invalid`),
                `${field} ${rejected} should be rejected`,
            );
        }
    }
});

test('validateRuntimePolicy validates CDI device assignment syntax', () => {
    for (const value of ['nvidia.com/gpu=all', 'nvidia.com/gpu=0']) {
        assert.doesNotThrow(
            () => validateRuntimePolicy({
                devices: [{ type: 'cdi', value }],
            }, 'test'),
            `${value} should be accepted`,
        );
    }
    assert.throws(
        () => validateRuntimePolicy({
            devices: [{ type: 'cdi', value: 'nvidia.com/gpu' }],
        }, 'test'),
        /invalid CDI device/,
    );
});

test('catalog validation contract exposes supported security options', () => {
    assert.deepEqual(
        Array.from(CATALOG_VALIDATION_CONTRACT.securityOpt).sort(),
        ['label=disable', 'seccomp=unconfined'].sort(),
    );
});

test('validateRuntimePolicy accepts supported security options', () => {
    for (const opt of ['label=disable', 'seccomp=unconfined']) {
        assert.doesNotThrow(
            () => validateRuntimePolicy({ securityOpt: [opt] }, 'test'),
            `${opt} should be accepted`,
        );
    }
});

test('validateRuntimePolicy rejects arbitrary host devices', () => {
    for (const hostPath of ['/dev/kfd', '/dev/dri', '/dev/dri/renderD128', '/dev/accel', '/dev/accel/accel0']) {
        assert.doesNotThrow(
            () => validateRuntimePolicy({
                devices: [{ type: 'hostDevice', hostPath }],
            }, 'test'),
            `${hostPath} should be accepted`,
        );
    }
    assert.throws(
        () => validateRuntimePolicy({
            devices: [{ type: 'hostDevice', hostPath: '/dev/sda' }],
        }, 'test'),
        /host device path/,
    );
    assert.throws(
        () => validateRuntimePolicy({
            devices: [{ type: 'hostDevice', hostPath: '/dev/nvidia0' }],
        }, 'test'),
        /host device path/,
    );
    for (const hostPath of ['/dev/dri/../sda', '/dev/accel/../../sda', '/dev/dri/./renderD128', '/dev/kfd/child']) {
        assert.throws(
            () => validateRuntimePolicy({
                devices: [{ type: 'hostDevice', hostPath }],
            }, 'test'),
            /host device path/,
            `${hostPath} should be rejected`,
        );
    }
    assert.throws(
        () => validateRuntimePolicy({
            devices: [{ type: 'hostDevice', hostPath: '/etc/shadow' }],
        }, 'test'),
        /invalid host device path/,
    );
    assert.throws(
        () => validateRuntimePolicy({
            devices: [{ type: 'hostDevice', hostPath: '/dev/${GPU}' }],
        }, 'test'),
        /invalid host device path/,
    );
    assert.throws(
        () => validateRuntimePolicy({
            env: { LD_PRELOAD: '/tmp/hook.so' },
        }, 'test'),
        /unknown field 'env'/,
    );
});

test('validateRuntimePolicy rejects incomplete typed devices', () => {
    assert.throws(
        () => validateRuntimePolicy({
            devices: [{ type: 'cdi' }],
        }, 'test'),
        /invalid CDI device/,
    );
    assert.throws(
        () => validateRuntimePolicy({
            devices: [{ type: 'hostDevice' }],
        }, 'test'),
        /invalid host device path/,
    );
});

test('validateArchitectureRecord rejects unknown top-level fields', () => {
    assert.throws(
        () => validateArchitectureRecord({
            id: 'x',
            status: 'stable',
            platform: 'linux/amd64',
            accelerator: { family: 'cpu' },
            image: 'x',
            extra: true,
        }, 'arch'),
        /unknown field 'extra'/,
    );
});

test('loadCatalog default workspace catalog passes validation', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    const defaultCatalogPath = path.join(repoRoot, 'local-llm-architectures');
    if (!fs.existsSync(defaultCatalogPath)) {
        assert.fail(`expected workspace catalog at ${defaultCatalogPath}`);
    }
    const result = loadCatalog({ env: { PLOINKY_LLM_ARCHITECTURES_PATH: defaultCatalogPath } });
    assert.equal(result.catalogId, 'local-llm-architectures/default');
    assert.ok(result.architectures.has('cpu-amd64'));
    assert.ok(result.architectures.has('cpu-arm64'));
    assert.ok(result.architectures.has('nvidia-amd64'));
    assert.ok(result.architectures.has('nvidia-spark-arm64-sm121'));
    assert.ok(result.images.has('intel-amd64'));
});
