import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ArchitectureSelectionError,
    selectArchitecture,
} from '../../cli/sandbox/docker/llmArchitectureSelector.js';

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
    architectures.set('nvidia-cuda-amd64', {
        id: 'nvidia-cuda-amd64',
        status: 'stable',
        platform: 'linux/amd64',
        accelerator: { family: 'nvidia-cuda' },
        match: { requiredProbes: ['nvidiaSmi'], containerRuntimes: ['docker'] },
        image: 'nvidia-cuda-amd64',
        runtimePolicy: { platform: 'linux/amd64', gpus: 'all' },
        fallbackPriority: 10,
    });
    architectures.set('nvidia-cuda-cdi-amd64', {
        id: 'nvidia-cuda-cdi-amd64',
        status: 'stable',
        platform: 'linux/amd64',
        accelerator: { family: 'nvidia-cuda' },
        match: { requiredProbes: ['nvidiaCdi'], containerRuntimes: ['podman'] },
        image: 'nvidia-cuda-amd64',
        runtimePolicy: {
            platform: 'linux/amd64',
            devices: [{ type: 'cdi', value: 'nvidia.com/gpu=all' }],
        },
        fallbackPriority: 10,
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
    images.set('nvidia-cuda-amd64', { id: 'nvidia-cuda-amd64', ref: 'reg/llm-nvidia-cuda-amd64:dev', platform: 'linux/amd64', digest: 'sha256:' + 'a'.repeat(64) });
    return {
        catalogId: 'test/catalog',
        catalogRef: 'local:test',
        defaultFallback: 'cpu-amd64',
        architectures,
        images,
        ...overrides,
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
    assert.equal(selected.architectureId, 'nvidia-cuda-amd64');
    assert.equal(selected.acceleratorFamily, 'nvidia-cuda');
    assert.equal(selected.imageDigest, 'sha256:' + 'a'.repeat(64));
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
    assert.equal(selected.architectureId, 'nvidia-cuda-amd64');
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
            env: { PLOINKY_LLM_ARCHITECTURE_ID: 'nvidia-cuda-amd64' },
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

test('selectArchitecture allows image override but loses catalog digest', () => {
    const catalog = makeCatalog();
    const hardware = {
        runtime: 'docker',
        ociPlatform: 'linux/amd64',
        acceleratorFamilies: ['cpu', 'nvidia-cuda'],
        probes: { nvidiaSmi: { ok: true } },
    };
    const selected = selectArchitecture(catalog, hardware, {
        agentName: 'baseLocal',
        env: { PLOINKY_LLM_AGENT_IMAGE: 'registry.example.com/custom:1.0' },
    });
    assert.equal(selected.imageRef, 'registry.example.com/custom:1.0');
    assert.equal(selected.imageDigest, null);
    assert.equal(selected.imageSource, 'env-override');
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
    assert.equal(selected.architectureId, 'nvidia-cuda-cdi-amd64');
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
            entry.archId === 'nvidia-cuda-amd64'
            && entry.reasons.some((reason) => reason.includes('podman does not support --gpus'))
        )),
    );
});
