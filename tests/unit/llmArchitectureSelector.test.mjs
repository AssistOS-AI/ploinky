import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ArchitectureSelectionError,
    selectArchitecture,
} from '../../cli/services/llmArchitectureSelector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localArchitectureRoot = path.resolve(__dirname, '..', '..', '..', 'local-llm-architectures');

function readLocalCatalogJson(kind, id) {
    return JSON.parse(fs.readFileSync(path.join(localArchitectureRoot, kind, `${id}.json`), 'utf8'));
}

function makeCatalog(overrides = {}) {
    const architectures = new Map();
    const images = new Map();
    architectures.set('cpu-amd64', {
        id: 'cpu-amd64',
        status: 'stable',
        platform: 'linux/amd64',
        accelerator: { family: 'cpu' },
        match: { requiredProbes: [] },
        image: 'cpu-amd64',
        runtimePolicy: { platform: 'linux/amd64' },
        fallbackPriority: 100,
    });
    architectures.set('cpu-arm64', {
        id: 'cpu-arm64',
        status: 'stable',
        platform: 'linux/arm64',
        accelerator: { family: 'cpu' },
        match: { requiredProbes: [] },
        image: 'cpu-arm64',
        runtimePolicy: { platform: 'linux/arm64' },
        fallbackPriority: 110,
    });
    architectures.set('nvidia-amd64', {
        id: 'nvidia-amd64',
        status: 'stable',
        platform: 'linux/amd64',
        accelerator: { family: 'nvidia-cuda' },
        match: { requiredProbes: ['nvidiaSmi'], containerRuntimes: ['docker'] },
        image: 'nvidia-amd64',
        runtimePolicy: { platform: 'linux/amd64', gpus: 'all' },
        fallbackPriority: 10,
    });
    architectures.set('nvidia-cdi-amd64', {
        id: 'nvidia-cdi-amd64',
        status: 'stable',
        platform: 'linux/amd64',
        accelerator: { family: 'nvidia-cuda' },
        match: { requiredProbes: ['nvidiaCdi'], containerRuntimes: ['podman'] },
        image: 'nvidia-amd64',
        runtimePolicy: {
            platform: 'linux/amd64',
            devices: [{ type: 'cdi', value: 'nvidia.com/gpu=all' }],
        },
        fallbackPriority: 10,
    });
    architectures.set('nvidia-spark-arm64-sm121', {
        id: 'nvidia-spark-arm64-sm121',
        status: 'stable',
        platform: 'linux/arm64',
        accelerator: { family: 'nvidia-cuda', minimumComputeCapability: '12.1' },
        match: { requiredProbes: ['nvidiaSmi'], containerRuntimes: ['docker'] },
        image: 'nvidia-spark-arm64-sm121',
        runtimePolicy: { platform: 'linux/arm64', gpus: 'all' },
        fallbackPriority: 20,
    });
    architectures.set('vulkan-arm64-experimental', {
        id: 'vulkan-arm64-experimental',
        status: 'experimental',
        platform: 'linux/arm64',
        accelerator: { family: 'vulkan' },
        match: { requiredProbes: ['driDevice'] },
        image: 'cpu-arm64',
        runtimePolicy: { platform: 'linux/arm64' },
        fallbackPriority: 50,
    });
    images.set('cpu-amd64', { id: 'cpu-amd64', ref: 'reg/llm-cpu-amd64:dev', platform: 'linux/amd64' });
    images.set('cpu-arm64', { id: 'cpu-arm64', ref: 'reg/llm-cpu-arm64:dev', platform: 'linux/arm64' });
    images.set('nvidia-amd64', { id: 'nvidia-amd64', ref: 'docker.io/assistos/llm-runtime:nvidia-amd64', platform: 'linux/amd64', engines: ['llamacpp', 'vllm', 'sglang', 'trtllm'], digest: 'sha256:' + 'a'.repeat(64) });
    images.set('nvidia-spark-arm64-sm121', { id: 'nvidia-spark-arm64-sm121', ref: 'docker.io/assistos/llm-runtime:nvidia-spark-arm64-sm121', platform: 'linux/arm64', engines: ['llamacpp', 'sglang', 'trtllm'] });
    return {
        catalogId: 'test/catalog',
        catalogRef: 'local:test',
        defaultFallback: 'cpu-amd64',
        architectures,
        images,
        ...overrides,
    };
}

function makeLocalIntelVulkanCatalog() {
    const architectures = new Map();
    const images = new Map();
    architectures.set('cpu-amd64', {
        id: 'cpu-amd64',
        status: 'stable',
        platform: 'linux/amd64',
        accelerator: { family: 'cpu' },
        match: { requiredProbes: [] },
        image: 'cpu-amd64',
        runtimePolicy: { platform: 'linux/amd64' },
        fallbackPriority: 100,
    });
    architectures.set('intel-amd64', readLocalCatalogJson('architectures', 'intel-amd64'));
    architectures.set('vulkan-amd64', readLocalCatalogJson('architectures', 'vulkan-amd64'));
    images.set('cpu-amd64', { id: 'cpu-amd64', ref: 'reg/llm-cpu-amd64:dev', platform: 'linux/amd64' });
    images.set('intel-amd64', readLocalCatalogJson('images', 'intel-amd64'));
    images.set('vulkan-amd64', readLocalCatalogJson('images', 'vulkan-amd64'));
    return {
        catalogId: 'test/local-intel-vulkan',
        catalogRef: 'local:test',
        defaultFallback: 'cpu-amd64',
        architectures,
        images,
    };
}

test('selectArchitecture prefers nvidia when probes pass', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        nodePlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        probes: { nvidiaSmi: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'nvidia-amd64');
    assert.equal(selected.acceleratorFamily, 'nvidia-cuda');
    assert.equal(selected.imageRef, 'docker.io/assistos/llm-runtime:nvidia-amd64');
    assert.equal(selected.imageDigest, 'sha256:' + 'a'.repeat(64));
    assert.equal(selected.imageSource, 'catalog');
});

test('selectArchitecture treats catalog image refs as literals and rejects templates', () => {
    const catalog = makeCatalog();
    catalog.images.set('nvidia-amd64', {
        ...catalog.images.get('nvidia-amd64'),
        ref: 'docker.io/assistos/${AGENT_IMAGE_NAME}:dev',
    });
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        nodePlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        probes: { nvidiaSmi: { ok: true } },
    };
    assert.throws(
        () => selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} }),
        (err) => err instanceof ArchitectureSelectionError
            && /image 'nvidia-amd64'/.test(err.message)
            && /template|literal|invalid|resolved/i.test(err.message),
    );
});

test('selectArchitecture prefers Intel OpenVINO over generic Vulkan when Intel probes pass', () => {
    const catalog = makeLocalIntelVulkanCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        nodePlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu', 'vulkan', 'intel-openvino'],
        probes: {
            driDevice: { ok: true },
            intelPci: { ok: true },
            vulkanInfo: { ok: true },
        },
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'intel-amd64');
});

test('selectArchitecture uses Spark-specific NVIDIA ARM64 architecture', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/arm64',
        nodePlatform: 'linux/arm64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        acceleratorDetails: { 'nvidia-cuda': { computeCapability: '12.1' } },
        probes: { nvidiaSmi: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'nvidia-spark-arm64-sm121');
    assert.equal(selected.imageId, 'nvidia-spark-arm64-sm121');
    assert.equal(selected.imageRef, 'docker.io/assistos/llm-runtime:nvidia-spark-arm64-sm121');
});

test('selectArchitecture excludes Spark NVIDIA ARM64 below minimum compute capability', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/arm64',
        nodePlatform: 'linux/arm64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        acceleratorDetails: { 'nvidia-cuda': { computeCapability: '12.0' } },
        probes: { nvidiaSmi: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'cpu-arm64');
    assert.ok(selected.explanation.filterRejections.some((entry) => (
        entry.archId === 'nvidia-spark-arm64-sm121'
        && entry.reasons.includes('minimum-compute-capability-unmet')
    )));
});

test('selectArchitecture excludes Spark NVIDIA ARM64 when compute capability is unknown', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/arm64',
        nodePlatform: 'linux/arm64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        probes: { nvidiaSmi: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'cpu-arm64');
    assert.ok(selected.explanation.filterRejections.some((entry) => (
        entry.archId === 'nvidia-spark-arm64-sm121'
        && entry.reasons.includes('compute-capability-unknown')
    )));
});

test('selectArchitecture allows Spark NVIDIA ARM64 above minimum compute capability', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/arm64',
        nodePlatform: 'linux/arm64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        acceleratorDetails: { 'nvidia-cuda': { computeCapability: '12.2' } },
        probes: { nvidiaSmi: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'nvidia-spark-arm64-sm121');
});

test('selectArchitecture falls back to CPU when no accelerator is available', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        nodePlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu'],
        probes: {},
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'cpu-amd64');
    assert.equal(selected.explanation.mode, 'auto');
});

test('selectArchitecture honors compatible PLOINKY_LLM_ARCHITECTURE_ID override', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu'],
        probes: {},
    };
    const selected = selectArchitecture(catalog, hardware, {
        agentName: 'baseLocal',
        env: { PLOINKY_LLM_ARCHITECTURE_ID: 'cpu-amd64' },
    });
    assert.equal(selected.architectureId, 'cpu-amd64');
    assert.equal(selected.explanation.mode, 'override-architecture');
});

test('selectArchitecture ignores stale per-agent architecture override env vars', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        nodePlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        probes: { nvidiaSmi: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, {
        agentName: 'planning-local',
        env: { PLOINKY_PLANNING_LOCAL_ARCHITECTURE_ID: '../etc/shadow' },
    });
    assert.equal(selected.architectureId, 'nvidia-amd64');
    assert.equal(selected.explanation.mode, 'auto');
});

test('selectArchitecture rejects architecture override when platform or probes do not match', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu'],
        probes: {},
    };
    assert.throws(
        () => selectArchitecture(catalog, hardware, {
            agentName: 'baseLocal',
            env: { PLOINKY_LLM_ARCHITECTURE_ID: 'nvidia-amd64' },
        }),
        (err) => err instanceof ArchitectureSelectionError
            && /not compatible/.test(err.message)
            && /accelerator-family-unavailable/.test(err.message)
            && /required-probes-unmet/.test(err.message),
    );
    assert.throws(
        () => selectArchitecture(catalog, hardware, {
            agentName: 'baseLocal',
            env: { PLOINKY_LLM_ARCHITECTURE_ID: 'cpu-arm64' },
        }),
        /platform-mismatch/,
    );
});

test('selectArchitecture rejects unknown architecture override', () => {
    const catalog = makeCatalog();
    assert.throws(
        () => selectArchitecture(catalog, { ociPlatform: 'linux/amd64', acceleratorFamilies: ['cpu'], probes: {} }, {
            agentName: 'baseLocal',
            env: { PLOINKY_LLM_ARCHITECTURE_ID: 'does-not-exist' },
        }),
        (err) => err instanceof ArchitectureSelectionError && /not found in catalog/.test(err.message),
    );
});

test('selectArchitecture rejects invalid override env value', () => {
    const catalog = makeCatalog();
    assert.throws(
        () => selectArchitecture(catalog, { ociPlatform: 'linux/amd64' }, {
            agentName: 'baseLocal',
            env: { PLOINKY_LLM_ARCHITECTURE_ID: '../etc/shadow' },
        }),
        /PLOINKY_LLM_ARCHITECTURE_ID: invalid value/,
    );
});

test('selectArchitecture rejects raw image env overrides', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        probes: { nvidiaSmi: { ok: true } },
    };
    for (const [agentName, env] of [
        ['baseLocal', { PLOINKY_LLM_AGENT_IMAGE: 'registry.example.com/custom:1.0' }],
        ['planning-local', { PLOINKY_PLANNING_LOCAL_IMAGE: 'registry.example.com/custom:1.0' }],
    ]) {
        assert.throws(
            () => selectArchitecture(catalog, hardware, { agentName, env }),
            (err) => err instanceof ArchitectureSelectionError
                && /image override/i.test(err.message)
                && /unsupported/i.test(err.message)
                && /catalog/i.test(err.message),
        );
    }
});

test('selectLlmArchitecture rejects raw image env overrides', async () => {
    const selector = await import('../../cli/services/llmArchitectureSelector.js');
    assert.equal(typeof selector.selectLlmArchitecture, 'function');
    await assert.rejects(
        () => selector.selectLlmArchitecture({
            agentName: 'probe',
            env: { PLOINKY_LLM_AGENT_IMAGE: 'alpine:latest' },
            catalog: makeCatalog(),
            hardware: {
                runtime: 'docker',
                ociPlatform: 'linux/amd64',
                acceleratorFamilies: ['cpu'],
                probes: {},
            },
        }),
        (err) => err instanceof ArchitectureSelectionError
            && /image override/i.test(err.message)
            && /unsupported/i.test(err.message)
            && /catalog/i.test(err.message),
    );
});

test('selectArchitecture excludes experimental architectures by default', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/arm64',
        nodePlatform: 'linux/arm64',
        acceleratorFamilies: ['cpu', 'vulkan'],
        probes: { driDevice: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'cpu-arm64');
});

test('selectArchitecture admits experimental architectures when explicitly enabled', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/arm64',
        nodePlatform: 'linux/arm64',
        acceleratorFamilies: ['cpu', 'vulkan'],
        probes: { driDevice: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, {
        agentName: 'baseLocal',
        env: {},
        allowExperimental: true,
    });
    assert.equal(selected.architectureId, 'vulkan-arm64-experimental');
});

test('selectArchitecture rejects invalid PLOINKY_LLM_FORCE_PLATFORM', () => {
    const catalog = makeCatalog();
    assert.throws(
        () => selectArchitecture(catalog, { ociPlatform: 'linux/amd64' }, {
            agentName: 'baseLocal',
            env: { PLOINKY_LLM_FORCE_PLATFORM: 'linux/risc-v' },
        }),
        /unsupported platform/,
    );
});

test('selectArchitecture does not echo HF_TOKEN in selection state', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu'],
        probes: {},
    };
    const selected = selectArchitecture(catalog, hardware, {
        agentName: 'baseLocal',
        env: { HF_TOKEN: 'hf_supersecret123' },
    });
    const json = JSON.stringify(selected);
    assert.ok(!json.includes('hf_supersecret123'), 'serialized selection must not include HF_TOKEN');
    assert.ok(!json.toLowerCase().includes('hf_token'), 'serialized selection must not echo HF_TOKEN');
});

test('selectArchitecture selects NVIDIA CDI policy for Podman', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'podman',
        ociPlatform: 'linux/amd64',
        nodePlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        probes: { nvidiaCdi: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'nvidia-cdi-amd64');
    assert.deepEqual(selected.runtimePolicy.devices, [{ type: 'cdi', value: 'nvidia.com/gpu=all' }]);
});

test('selectArchitecture excludes Docker --gpus policy for Podman', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'podman',
        ociPlatform: 'linux/amd64',
        nodePlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        probes: { nvidiaSmi: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, { agentName: 'baseLocal', env: {} });
    assert.equal(selected.architectureId, 'cpu-amd64');
    assert.ok(
        selected.explanation.filterRejections.some((entry) => (
            entry.archId === 'nvidia-amd64'
            && entry.reasons.some((reason) => reason.includes('podman does not support --gpus'))
        )),
    );
});
