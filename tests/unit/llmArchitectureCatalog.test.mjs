import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    CatalogValidationError,
    loadCatalog,
    validateRuntimePolicy,
    validateArchitectureRecord,
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
        ref: 'example.com/llm-cpu-amd64:dev',
        platform: 'linux/amd64',
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
            /escapes catalog root|architectures\/\.\.\/\.\./i,
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

test('validateRuntimePolicy rejects arbitrary host devices', () => {
    assert.throws(
        () => validateRuntimePolicy({
            devices: [{ type: 'hostDevice', hostPath: '/etc/shadow' }],
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
    assert.ok(result.architectures.has('nvidia-cuda-amd64'));
});
