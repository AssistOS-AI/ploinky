import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    CATALOG_VALIDATION_CONTRACT,
    CatalogValidationError,
    DEFAULT_CATALOG_REF,
    DEFAULT_CATALOG_REPO_URL,
    loadCatalog,
    redactCatalogRepoUrl,
    resolveCatalogRootFromEnv,
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

function gitTestEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_CONFIG')) {
            delete env[key];
        }
    }
    return env;
}

function git(args, cwd) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: gitTestEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function fileUrl(filePath) {
    return pathToFileURL(filePath).href;
}

function credentialedFileUrl(filePath) {
    return fileUrl(filePath).replace(/^file:\/\//, 'file://user:super-secret@');
}

function withProcessEnv(overrides, fn) {
    const previous = new Map();
    for (const key of Object.keys(overrides)) {
        previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
        process.env[key] = overrides[key];
    }
    try {
        return fn();
    } finally {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

function initGitCatalog(rootPath, branch = 'main') {
    makeValidCatalog(rootPath);
    git(['init', '--quiet', '-b', branch], rootPath);
    git(['config', 'user.email', 'catalog-tests@example.invalid'], rootPath);
    git(['config', 'user.name', 'Catalog Tests'], rootPath);
    git(['add', '.'], rootPath);
    git(['commit', '--quiet', '-m', 'catalog'], rootPath);
    return git(['rev-parse', 'HEAD'], rootPath);
}

test('loadCatalog uses explicit path before any remote source', () => {
    const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-path-first-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-cache-'));
    try {
        makeValidCatalog(catalogRoot);
        const result = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_PATH: catalogRoot,
                PLOINKY_LLM_ARCHITECTURES_REPO: 'file:///does/not/exist',
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        });

        assert.equal(result.source, 'path');
        assert.equal(result.repoUrl, null);
        assert.equal(result.requestedRef, null);
        assert.equal(result.catalogRoot, path.resolve(catalogRoot));
        assert.equal(result.catalogId, 'test/catalog');
    } finally {
        fs.rmSync(catalogRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

test('redactCatalogRepoUrl removes URL userinfo from provenance values', () => {
    assert.equal(
        redactCatalogRepoUrl('https://user:super-secret@example.invalid/org/repo.git'),
        'https://example.invalid/org/repo.git',
    );
    assert.equal(
        redactCatalogRepoUrl('file://user:super-secret@/tmp/local-llm-architectures'),
        'file:///tmp/local-llm-architectures',
    );
    assert.equal(
        redactCatalogRepoUrl('ssh://git:super-secret@example.invalid/org/repo.git'),
        'ssh://example.invalid/org/repo.git',
    );
    assert.equal(
        redactCatalogRepoUrl('git@example.invalid:org/repo.git'),
        'git@example.invalid:org/repo.git',
    );
});

test('loadCatalog clones configured remote catalog into cache', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-remote-src-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-remote-cache-'));
    try {
        const commit = initGitCatalog(sourceRoot, 'main');
        const repoUrl = fileUrl(sourceRoot);
        const result = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_REPO: repoUrl,
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        });

        assert.equal(result.source, 'git');
        assert.equal(result.repoUrl, repoUrl);
        assert.equal(result.requestedRef, 'main');
        assert.equal(result.catalogRef, commit);
        assert.equal(result.catalogId, 'test/catalog');
        assert.ok(result.catalogRoot.startsWith(path.resolve(cacheDir)));
        assert.ok(fs.existsSync(path.join(result.catalogRoot, '.git')));
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

test('loadCatalog redacts credentialed remote catalog URLs from metadata', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-remote-secret-src-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-remote-secret-cache-'));
    try {
        initGitCatalog(sourceRoot, 'main');
        const rawRepoUrl = credentialedFileUrl(sourceRoot);
        const safeRepoUrl = fileUrl(sourceRoot);
        const result = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_REPO: rawRepoUrl,
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        });

        assert.equal(result.source, 'git');
        assert.equal(result.repoUrl, safeRepoUrl);
        assert.equal(result.repoUrl.includes('super-secret'), false);
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

test('loadCatalog redacts credentialed remote catalog URLs from fetch errors', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-secret-fail-cache-'));
    try {
        assert.throws(
            () => loadCatalog({
                env: {
                    PLOINKY_LLM_ARCHITECTURES_REPO: 'file://user:super-secret@/path/that/does/not/exist',
                    PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                    PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
                },
            }),
            (err) => err instanceof CatalogValidationError
                && /Unable to fetch LLM architecture catalog/.test(err.message)
                && !err.message.includes('super-secret')
                && !String(err.repoUrl).includes('super-secret')
                && !String(err.fetchError).includes('super-secret'),
        );
    } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

test('loadCatalog file remotes ignore hostile ambient Git protocol config', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-hostile-git-src-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-hostile-git-cache-'));
    try {
        const commit = initGitCatalog(sourceRoot, 'main');
        const repoUrl = fileUrl(sourceRoot);
        const result = withProcessEnv({
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'protocol.file.allow',
            GIT_CONFIG_VALUE_0: 'never',
        }, () => loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_REPO: repoUrl,
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        }));

        assert.equal(result.repoUrl, repoUrl);
        assert.equal(result.catalogRef, commit);
        assert.equal(result.catalogId, 'test/catalog');
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

test('loadCatalog clones default remote catalog when no path or repo env is set', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-default-src-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-default-cache-'));
    try {
        const commit = initGitCatalog(sourceRoot, DEFAULT_CATALOG_REF);
        const repoUrl = fileUrl(sourceRoot);
        const result = loadCatalog({
            env: {
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
            defaultRepoUrl: repoUrl,
            defaultRef: DEFAULT_CATALOG_REF,
        });

        assert.equal(DEFAULT_CATALOG_REPO_URL, 'https://github.com/AssistOS-AI/local-llm-architectures.git');
        assert.equal(DEFAULT_CATALOG_REF, 'main');
        assert.equal(result.source, 'default-remote');
        assert.equal(result.repoUrl, repoUrl);
        assert.equal(result.requestedRef, 'main');
        assert.equal(result.catalogRef, commit);
        assert.equal(result.catalogId, 'test/catalog');
        assert.ok(result.catalogRoot.startsWith(path.resolve(cacheDir)));
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

test('loadCatalog honors env ref for default remote catalog', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-default-ref-src-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-default-ref-cache-'));
    try {
        initGitCatalog(sourceRoot, 'main');
        git(['checkout', '--quiet', '-b', 'dev'], sourceRoot);
        const catalogPath = path.join(sourceRoot, 'catalog.json');
        const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
        catalog.catalogId = 'test/dev-catalog';
        fs.writeFileSync(catalogPath, JSON.stringify(catalog));
        git(['add', 'catalog.json'], sourceRoot);
        git(['commit', '--quiet', '-m', 'dev catalog'], sourceRoot);
        const devCommit = git(['rev-parse', 'HEAD'], sourceRoot);

        const repoUrl = fileUrl(sourceRoot);
        const result = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_REF: 'dev',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
            defaultRepoUrl: repoUrl,
            defaultRef: 'main',
        });

        assert.equal(result.source, 'default-remote');
        assert.equal(result.requestedRef, 'dev');
        assert.equal(result.catalogId, 'test/dev-catalog');
        assert.equal(result.catalogRef, devCommit);
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

test('loadCatalog uses existing cached checkout when remote update fails', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-cache-src-'));
    const removedRoot = `${sourceRoot}.removed`;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-cache-dir-'));
    try {
        const commit = initGitCatalog(sourceRoot, 'main');
        const repoUrl = fileUrl(sourceRoot);
        const first = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_REPO: repoUrl,
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        });
        assert.equal(first.catalogRef, commit);

        fs.renameSync(sourceRoot, removedRoot);

        const second = loadCatalog({
            env: {
                PLOINKY_LLM_ARCHITECTURES_REPO: repoUrl,
                PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
            },
        });
        assert.equal(second.source, 'git');
        assert.equal(second.repoUrl, repoUrl);
        assert.equal(second.requestedRef, 'main');
        assert.equal(second.catalogRef, commit);
        assert.equal(second.catalogRoot, first.catalogRoot);
        assert.equal(second.catalogId, 'test/catalog');
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(removedRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

test('loadCatalog fails clearly when remote catalog cannot be fetched and no cache exists', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-empty-cache-'));
    try {
        assert.throws(
            () => loadCatalog({
                env: {
                    PLOINKY_LLM_ARCHITECTURES_REPO: 'file:///path/that/does/not/exist',
                    PLOINKY_LLM_ARCHITECTURES_REF: 'main',
                    PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
                },
            }),
            (err) => err instanceof CatalogValidationError
                && /Unable to fetch LLM architecture catalog/.test(err.message)
                && /PLOINKY_LLM_ARCHITECTURES_PATH/.test(err.message)
                && /PLOINKY_LLM_ARCHITECTURES_REPO/.test(err.message),
        );
    } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

test('resolveCatalogRootFromEnv returns default-remote metadata for the built-in source', () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-resolve-src-'));
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-catalog-resolve-cache-'));
    try {
        initGitCatalog(sourceRoot, 'main');
        const repoUrl = fileUrl(sourceRoot);
        const resolved = resolveCatalogRootFromEnv({
            PLOINKY_LLM_CATALOG_CACHE_DIR: cacheDir,
        }, {
            defaultRepoUrl: repoUrl,
            defaultRef: 'main',
        });

        assert.equal(resolved.source, 'default-remote');
        assert.equal(resolved.repoUrl, repoUrl);
        assert.equal(resolved.requestedRef, 'main');
        assert.ok(resolved.rootPath.startsWith(path.resolve(cacheDir)));
    } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }
});

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

test('local workspace catalog passes validation when explicitly configured by path', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    const defaultCatalogPath = path.join(repoRoot, 'local-llm-architectures');
    if (!fs.existsSync(defaultCatalogPath)) {
        assert.fail(`expected workspace catalog at ${defaultCatalogPath}`);
    }
    const result = loadCatalog({ env: { PLOINKY_LLM_ARCHITECTURES_PATH: defaultCatalogPath } });
    assert.equal(result.source, 'path');
    assert.equal(result.catalogId, 'local-llm-architectures/default');
    assert.ok(result.architectures.has('cpu-amd64'));
    assert.ok(result.architectures.has('cpu-arm64'));
    assert.ok(result.architectures.has('nvidia-amd64'));
    assert.ok(result.architectures.has('nvidia-spark-arm64-sm121'));
    assert.ok(result.images.has('intel-amd64'));
});
