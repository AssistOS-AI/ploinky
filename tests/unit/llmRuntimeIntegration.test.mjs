import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    isLlmRuntimeManifest,
    prepareLlmStartup,
} from '../../cli/sandbox/docker/llmRuntimeIntegration.js';

function withTempDirs(fn) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-llm-integration-'));
    const agentsRoot = path.join(workspace, '.ploinky', 'agents');
    fs.mkdirSync(agentsRoot, { recursive: true });
    const catalogRoot = path.join(workspace, 'catalog');
    fs.mkdirSync(path.join(catalogRoot, 'architectures'), { recursive: true });
    fs.mkdirSync(path.join(catalogRoot, 'images'), { recursive: true });

    fs.writeFileSync(path.join(catalogRoot, 'catalog.json'), JSON.stringify({
        schemaVersion: 1,
        catalogId: 'test/catalog',
        defaultFallback: 'cpu-amd64',
        architectures: [{ id: 'cpu-amd64', path: 'architectures/cpu-amd64.json' }],
        images: [{ id: 'cpu-amd64', path: 'images/cpu-amd64.json' }],
    }));
    fs.writeFileSync(path.join(catalogRoot, 'architectures/cpu-amd64.json'), JSON.stringify({
        id: 'cpu-amd64',
        status: 'stable',
        platform: 'linux/amd64',
        accelerator: { family: 'cpu' },
        match: { requiredProbes: [] },
        image: 'cpu-amd64',
        runtimePolicy: {
            platform: 'linux/amd64',
            resources: { memory: '4g', cpus: '2', pidsLimit: 512, shmSize: '128m' },
            ipc: 'default',
        },
        engineDefaults: { enginePort: 8080, runtimePort: 9000 },
    }));
    fs.writeFileSync(path.join(catalogRoot, 'images/cpu-amd64.json'), JSON.stringify({
        id: 'cpu-amd64',
        ref: 'reg.example.com/llm-cpu-amd64:dev',
        platform: 'linux/amd64',
    }));

    try {
        return fn({ workspace, agentsRoot, catalogRoot });
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

test('isLlmRuntimeManifest returns false when not opted in', () => {
    assert.equal(isLlmRuntimeManifest({}, null), false);
    assert.equal(isLlmRuntimeManifest({ llmRuntime: {} }, null), false);
    assert.equal(isLlmRuntimeManifest({ llmRuntime: { enabled: true } }, null), true);
    assert.equal(isLlmRuntimeManifest({}, { llmRuntime: { enabled: true } }), true);
});

test('prepareLlmStartup short-circuits for non-LLM manifests', () => {
    const result = prepareLlmStartup({
        runtime: 'docker',
        manifest: {},
        profileConfig: null,
        agentName: 'whatever',
        env: {},
        agentWorkDirRoot: '/tmp',
    });
    assert.equal(result.enabled, false);
});

test('prepareLlmStartup selects catalog architecture and writes state file', () => {
    withTempDirs(({ agentsRoot, catalogRoot }) => {
        const result = prepareLlmStartup({
            runtime: 'docker',
            manifest: { llmRuntime: { enabled: true } },
            profileConfig: null,
            agentName: 'baseLocal',
            env: {
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            agentWorkDirRoot: agentsRoot,
            manifestEnvNames: [
                'HF_TOKEN',
                'HUGGING_FACE_HUB_TOKEN',
                'OPENAI_API_KEY',
                'ANTHROPIC_API_KEY',
                'PLOINKY_MASTER_KEY',
                'PLOINKY_AGENT_PRINCIPAL',
            ],
            envHash: 'envhash-abc',
            effectiveNetwork: null,
        });
        assert.equal(result.enabled, true);
        assert.equal(result.identity, 'baseLocal');
        assert.equal(result.selection.architectureId, 'cpu-amd64');
        assert.equal(result.selection.imageRef, 'reg.example.com/llm-cpu-amd64:dev');
        assert.ok(result.policyHash);
        assert.ok(result.reuseHash);
        assert.ok(result.runArgs.length > 0);
        assert.ok(result.labels['ploinky.llm.architecture']);
        assert.equal(result.labels['ploinky.llm.architecture'], 'cpu-amd64');
        assert.equal(result.labels['ploinky.reusehash'], result.reuseHash);
        assert.equal(result.modelDir, path.join(agentsRoot, 'baseLocal', 'models'));
        assert.ok(fs.existsSync(result.modelDir), 'model directory must be created for the /models mount');

        const stateFile = path.join(agentsRoot, 'baseLocal', 'runtime', 'selected-architecture.json');
        assert.ok(fs.existsSync(stateFile), 'state file must be written');
        const stateBytes = fs.readFileSync(stateFile, 'utf8');
        assert.ok(!stateBytes.includes('HF_TOKEN'), 'state file must not list HF_TOKEN as exposed env');
        const stateJson = JSON.parse(stateBytes);
        assert.equal(stateJson.architecture.id, 'cpu-amd64');
        assert.equal(stateJson.catalog.id, 'test/catalog');
        assert.ok(Array.isArray(stateJson.envExposed));
        assert.ok(!stateJson.envExposed.includes('HF_TOKEN'));
        assert.ok(!stateJson.envExposed.includes('HUGGING_FACE_HUB_TOKEN'));
        assert.ok(!stateJson.envExposed.includes('OPENAI_API_KEY'));
        assert.ok(!stateJson.envExposed.includes('ANTHROPIC_API_KEY'));
        assert.ok(!stateJson.envExposed.includes('PLOINKY_MASTER_KEY'));
        assert.ok(stateJson.envExposed.includes('PLOINKY_AGENT_PRINCIPAL'));
    });
});

test('prepareLlmStartup writeState:false skips state file write', () => {
    withTempDirs(({ agentsRoot, catalogRoot }) => {
        const result = prepareLlmStartup({
            runtime: 'docker',
            manifest: { llmRuntime: { enabled: true } },
            profileConfig: null,
            agentName: 'baseLocal',
            env: {
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            agentWorkDirRoot: agentsRoot,
            envHash: 'envhash-abc',
            writeState: false,
        });
        assert.equal(result.enabled, true);
        assert.equal(result.stateDir, null);
        assert.equal(result.modelDir, path.join(agentsRoot, 'baseLocal', 'models'));
        assert.ok(fs.existsSync(result.modelDir), 'writeState:false still prepares model storage');
        const stateFile = path.join(agentsRoot, 'baseLocal', 'runtime', 'selected-architecture.json');
        assert.equal(fs.existsSync(stateFile), false);
    });
});

test('prepareLlmStartup reuse hash changes when image digest or policy changes', () => {
    withTempDirs(({ agentsRoot, catalogRoot }) => {
        const baseResult = prepareLlmStartup({
            runtime: 'docker',
            manifest: { llmRuntime: { enabled: true } },
            profileConfig: null,
            agentName: 'baseLocal',
            env: {
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            agentWorkDirRoot: agentsRoot,
            envHash: 'envhash-abc',
            writeState: false,
        });

        // Mutate the catalog image digest and re-run.
        const imgFile = path.join(catalogRoot, 'images', 'cpu-amd64.json');
        const img = JSON.parse(fs.readFileSync(imgFile, 'utf8'));
        img.digest = 'sha256:' + 'a'.repeat(64);
        fs.writeFileSync(imgFile, JSON.stringify(img));

        const afterDigest = prepareLlmStartup({
            runtime: 'docker',
            manifest: { llmRuntime: { enabled: true } },
            profileConfig: null,
            agentName: 'baseLocal',
            env: {
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
            },
            agentWorkDirRoot: agentsRoot,
            envHash: 'envhash-abc',
            writeState: false,
        });

        assert.notEqual(baseResult.reuseHash, afterDigest.reuseHash, 'reuse hash must change when image digest changes');
    });
});
