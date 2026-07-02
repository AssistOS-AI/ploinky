import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

const TEST_GIT_CONFIG = [
    ['commit.gpgsign', 'false'],
    ['protocol.file.allow', 'always'],
];

function withIsolatedGitEnv(workspace, fn) {
    const emptyGlobalConfig = path.join(workspace, 'empty-gitconfig');
    fs.writeFileSync(emptyGlobalConfig, '');

    const originalGitEnv = new Map();
    for (const name of Object.keys(process.env)) {
        if (!name.startsWith('GIT_CONFIG')) continue;
        originalGitEnv.set(name, process.env[name]);
        delete process.env[name];
    }

    const controlledGitEnv = {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: emptyGlobalConfig,
        GIT_CONFIG_COUNT: String(TEST_GIT_CONFIG.length),
    };
    for (const [index, [key, value]] of TEST_GIT_CONFIG.entries()) {
        controlledGitEnv[`GIT_CONFIG_KEY_${index}`] = key;
        controlledGitEnv[`GIT_CONFIG_VALUE_${index}`] = value;
    }
    for (const [name, value] of Object.entries(controlledGitEnv)) {
        process.env[name] = value;
    }

    try {
        return fn();
    } finally {
        for (const name of Object.keys(controlledGitEnv)) {
            delete process.env[name];
        }
        for (const [name, value] of originalGitEnv.entries()) {
            process.env[name] = value;
        }
    }
}

function git(args, cwd) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function fileUrl(filePath) {
    return pathToFileURL(filePath).href;
}

function credentialedFileUrl(filePath) {
    return fileUrl(filePath).replace(/^file:\/\//, 'file://user:super-secret@');
}

function initCatalogGitRepo(catalogRoot) {
    git(['init', '--quiet', '-b', 'main'], catalogRoot);
    git(['config', 'user.email', 'runtime-integration@example.invalid'], catalogRoot);
    git(['config', 'user.name', 'Runtime Integration Tests'], catalogRoot);
    git(['add', '.'], catalogRoot);
    git(['commit', '--quiet', '-m', 'catalog'], catalogRoot);
    return git(['rev-parse', 'HEAD'], catalogRoot);
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
        assert.equal(result.reuseKey.catalogSource, 'path');
        assert.equal(result.reuseKey.catalogRepoUrl, null);
        assert.equal(result.reuseKey.catalogRequestedRef, null);
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
        assert.equal(stateJson.catalog.source, 'path');
        assert.equal(stateJson.catalog.repoUrl, null);
        assert.equal(stateJson.catalog.requestedRef, null);
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

test('prepareLlmStartup records remote catalog provenance from configured repo', () => {
    withTempDirs(({ agentsRoot, catalogRoot, workspace }) => {
        withIsolatedGitEnv(workspace, () => {
            const commit = initCatalogGitRepo(catalogRoot);
            const cacheDir = path.join(workspace, '.ploinky', 'llm-catalog-cache');
            const repoUrl = fileUrl(catalogRoot);
            const rawRepoUrl = credentialedFileUrl(catalogRoot);

            const result = prepareLlmStartup({
                runtime: 'docker',
                manifest: { llmRuntime: { enabled: true } },
                profileConfig: null,
                agentName: 'baseLocal',
                env: {
                    PLOINKY_LLM_ARCHITECTURES_REPO: rawRepoUrl,
                    PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                    PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
                    PLOINKY_LLM_FORCE_PLATFORM: 'linux/amd64',
                },
                agentWorkDirRoot: agentsRoot,
                envHash: 'envhash-remote',
                effectiveNetwork: null,
            });

            assert.equal(JSON.stringify(result).includes('super-secret'), false);
            assert.equal(result.selection.catalogSource, 'git');
            assert.equal(result.selection.catalogRepoUrl, repoUrl);
            assert.equal(result.selection.catalogRequestedRef, 'main');
            assert.equal(result.selection.catalogRef, commit);
            assert.equal(result.reuseKey.catalogSource, 'git');
            assert.equal(result.reuseKey.catalogRepoUrl, repoUrl);
            assert.equal(result.reuseKey.catalogRequestedRef, 'main');
            assert.equal(result.reuseKey.catalogRef, commit);

            const stateFile = path.join(agentsRoot, 'baseLocal', 'runtime', 'selected-architecture.json');
            const stateJson = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            assert.deepEqual(stateJson.catalog, {
                id: 'test/catalog',
                ref: commit,
                source: 'git',
                repoUrl,
                requestedRef: 'main',
            });
        });
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
