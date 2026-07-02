import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    isLlmRuntimeManifest,
    prepareLlmStartup,
} from '../../cli/services/llmRuntimeIntegration.js';

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
        digest: 'sha256:' + 'b'.repeat(64),
        platform: 'linux/amd64',
        engines: ['llamacpp'],
        build: {
            context: 'container-image-builds',
            dockerfile: 'container-image-builds/images/llm-runtime-cpu/Dockerfile',
            workflow: 'container-image-builds/.github/workflows/publish-llm-runtime-images.yml',
            engineVersionsLock: 'container-image-builds/images/llm-runtime-cpu/engineVersions.lock.json',
        },
    }));

    try {
        return fn({ workspace, agentsRoot, catalogRoot });
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

function computeReuseHashForTest(parts) {
    const sorted = Object.keys(parts).sort().reduce((acc, key) => {
        acc[key] = parts[key];
        return acc;
    }, {});
    return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertMode(filePath, expectedMode) {
    if (process.platform === 'win32') return;
    assert.equal((fs.statSync(filePath).mode & 0o777), expectedMode);
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
                HF_TOKEN: 'super-secret-token',
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
        assert.equal(result.selection.imageDigest, 'sha256:' + 'b'.repeat(64));
        assert.equal(result.imageRef, 'reg.example.com/llm-cpu-amd64:dev');
        assert.equal(result.imageDigest, 'sha256:' + 'b'.repeat(64));
        assert.equal(result.imageRunRef, `reg.example.com/llm-cpu-amd64:dev@sha256:${'b'.repeat(64)}`);
        assert.ok(result.policyHash);
        assert.ok(result.reuseHash);
        assert.deepEqual(result.reuseKey.startupContract, {
            version: 2,
            mounts: ['/workspace', '/models', '/runtime'],
            env: {
                HF_HOME: '/models/hf-cache',
                PLOINKY_MODELS_DIR: '/models/artifacts',
                PLOINKY_DERIVED_DIR: '/models/derived',
                PLOINKY_RUNTIME_DIR: '/runtime',
                PLOINKY_LAUNCHERS_DIR: '/workspace/modelLaunchers',
                PLOINKY_MCP_PORT: '9000',
                PLOINKY_INFERENCE_PORT: '8080',
                PLOINKY_INVOCATION_AUTH_MODULE: '/Agent/lib/invocationAuth.mjs',
                PLOINKY_REQUEST_HASH_MODULE: '/Agent/lib/requestHash.mjs',
            },
            publish: [
                { hostIp: '127.0.0.1', containerPort: 9000, protocol: 'tcp' },
                { hostIp: '127.0.0.1', containerPort: 8080, protocol: 'tcp' },
            ],
        });
        assert.ok(result.runArgs.length > 0);
        assert.ok(result.labels['ploinky.llm.architecture']);
        assert.equal(result.labels['ploinky.llm.architecture'], 'cpu-amd64');
        assert.equal(result.labels['ploinky.reusehash'], result.reuseHash);
        assert.equal(result.reuseHash, computeReuseHashForTest(result.reuseKey));
        const invocationAuthChanged = cloneJson(result.reuseKey);
        invocationAuthChanged.startupContract.env.PLOINKY_INVOCATION_AUTH_MODULE = '/Agent/lib/customInvocationAuth.mjs';
        assert.notEqual(
            computeReuseHashForTest(invocationAuthChanged),
            result.reuseHash,
            'reuse hash must change when invocation auth module path changes',
        );
        const requestHashChanged = cloneJson(result.reuseKey);
        requestHashChanged.startupContract.env.PLOINKY_REQUEST_HASH_MODULE = '/Agent/lib/customRequestHash.mjs';
        assert.notEqual(
            computeReuseHashForTest(requestHashChanged),
            result.reuseHash,
            'reuse hash must change when request hash module path changes',
        );
        assert.equal(result.modelDir, path.join(agentsRoot, 'baseLocal', 'models'));
        assert.ok(fs.existsSync(result.modelDir), 'model directory must be created for the /models mount');
        assertMode(path.join(agentsRoot, 'baseLocal', 'runtime'), 0o700);
        assertMode(result.modelDir, 0o700);

        const stateFile = path.join(agentsRoot, 'baseLocal', 'runtime', 'selected-architecture.json');
        assert.ok(fs.existsSync(stateFile), 'state file must be written');
        assertMode(stateFile, 0o600);
        const stateBytes = fs.readFileSync(stateFile, 'utf8');
        assert.ok(!stateBytes.includes('HF_TOKEN'), 'state file must not list HF_TOKEN as exposed env');
        const stateJson = JSON.parse(stateBytes);
        assert.equal(stateJson.architecture.id, 'cpu-amd64');
        assert.equal(stateJson.catalog.id, 'test/catalog');
        assert.equal(stateJson.architecture.imageRef, 'reg.example.com/llm-cpu-amd64:dev');
        assert.equal(stateJson.architecture.imageDigest, 'sha256:' + 'b'.repeat(64));
        assert.equal(stateJson.architecture.platform, 'linux/amd64');
        assert.equal(stateJson.runtimePolicyHash, result.policyHash);
        assert.deepEqual(stateJson.resourcePolicy, {
            memory: '4g',
            cpus: '2',
            pidsLimit: 512,
            shmSize: '128m',
        });
        assert.deepEqual(stateJson.engineInventory, {
            engines: ['llamacpp'],
            mcp: { containerPort: 9000 },
            inference: { containerPort: 8080 },
        });
        assert.equal(Object.hasOwn(stateJson, 'envExposed'), false);

        const lockFile = path.join(agentsRoot, 'baseLocal', 'runtime', 'llm-runtime-lock.json');
        assert.ok(fs.existsSync(lockFile), 'runtime lockfile must be written');
        assertMode(lockFile, 0o600);
        const lockJson = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        assert.equal(lockJson.image.ref, 'reg.example.com/llm-cpu-amd64:dev');
        assert.equal(lockJson.image.digest, 'sha256:' + 'b'.repeat(64));
        assert.equal(lockJson.architecture.id, 'cpu-amd64');
        assert.equal(lockJson.runtimePolicyHash, result.policyHash);
        assert.deepEqual(lockJson.engineInventory, stateJson.engineInventory);
        const serializedState = JSON.stringify({ stateJson, lockJson });
        assert.equal(serializedState.includes('HF_TOKEN'), false);
        assert.equal(serializedState.includes('super-secret-token'), false);
    });
});

test('prepareLlmStartup removes selected-architecture temp file when atomic rename fails', () => {
    withTempDirs(({ agentsRoot, catalogRoot }) => {
        const originalRenameSync = fs.renameSync;
        let renameAttempted = false;
        fs.renameSync = (from, to) => {
            if (path.basename(to) === 'selected-architecture.json') {
                renameAttempted = true;
                assert.equal(fs.existsSync(from), true, 'staged temp file should exist before rename');
                throw new Error('simulated selected-state rename failure');
            }
            return originalRenameSync(from, to);
        };
        try {
            assert.throws(
                () => prepareLlmStartup({
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
                }),
                /simulated selected-state rename failure/,
            );
        } finally {
            fs.renameSync = originalRenameSync;
        }

        assert.equal(renameAttempted, true, 'state write should rename a temp file into place');
        const runtimeDir = path.join(agentsRoot, 'baseLocal', 'runtime');
        assert.equal(fs.existsSync(path.join(runtimeDir, 'selected-architecture.json')), false);
        if (fs.existsSync(runtimeDir)) {
            const leftovers = fs.readdirSync(runtimeDir)
                .filter((name) => name.includes('.tmp-'));
            assert.deepEqual(leftovers, []);
        }
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
        const lockFile = path.join(agentsRoot, 'baseLocal', 'runtime', 'llm-runtime-lock.json');
        assert.equal(fs.existsSync(lockFile), false);
    });
});

test('prepareLlmStartup uses tag ref as run ref when catalog digest is absent', () => {
    withTempDirs(({ agentsRoot, catalogRoot }) => {
        const imgFile = path.join(catalogRoot, 'images', 'cpu-amd64.json');
        const img = JSON.parse(fs.readFileSync(imgFile, 'utf8'));
        delete img.digest;
        fs.writeFileSync(imgFile, JSON.stringify(img));

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

        assert.equal(result.imageRef, 'reg.example.com/llm-cpu-amd64:dev');
        assert.equal(result.imageDigest, null);
        assert.equal(result.imageRunRef, 'reg.example.com/llm-cpu-amd64:dev');
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
