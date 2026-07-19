import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const originalGeneratedTestSecret = process.env.GENERATED_SECRET_TEST_SECRET;
const originalSharedSecret = process.env.SHARED_GENERATED_SECRET;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-generated-env-'));
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
process.env.GENERATED_SECRET_TEST_SECRET = 'operator-value';
process.env.SHARED_GENERATED_SECRET = 'operator-shared-value';

const moduleSuffix = `?test=${Date.now()}`;
const {
    buildEnvFlags,
    buildEnvMap,
    getExposedNames,
    getManifestEnvNames,
    getManifestEnvSpecs,
    validateManifestEnvProfileCompleteness,
} = await import(`../../cli/services/secretVars.js${moduleSuffix}`);
const { deriveAgentSecret, deriveWorkspaceSecret } = await import(`../../cli/services/masterKey.js${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_MASTER_KEY;
    } else {
        process.env.PLOINKY_MASTER_KEY = originalMasterKey;
    }
    if (originalGeneratedTestSecret === undefined) {
        delete process.env.GENERATED_SECRET_TEST_SECRET;
    } else {
        process.env.GENERATED_SECRET_TEST_SECRET = originalGeneratedTestSecret;
    }
    if (originalSharedSecret === undefined) {
        delete process.env.SHARED_GENERATED_SECRET;
    } else {
        process.env.SHARED_GENERATED_SECRET = originalSharedSecret;
    }
});

test('buildEnvMap derives generatedSecret entries from the current agent identity', () => {
    const manifest = {
        env: [
            {
                name: 'GENERATED_SECRET_TEST_SECRET',
                generatedSecret: true,
            },
        ],
    };
    const env = buildEnvMap(manifest, null, {
        repoName: 'repo-one',
        agentName: 'agent-one',
    });
    assert.equal(env.GENERATED_SECRET_TEST_SECRET, deriveAgentSecret({
        repoName: 'repo-one',
        agentName: 'agent-one',
        name: 'GENERATED_SECRET_TEST_SECRET',
    }));
    assert.notEqual(env.GENERATED_SECRET_TEST_SECRET, 'operator-value');
});

test('generatedSecret entries are scoped per agent by default', () => {
    const manifest = {
        env: [
            {
                name: 'GENERATED_SECRET_TEST_SECRET',
                generatedSecret: true,
            },
        ],
    };
    const first = buildEnvMap(manifest, null, {
        repoName: 'repo-one',
        agentName: 'agent-one',
    });
    const second = buildEnvMap(manifest, null, {
        repoName: 'repo-one',
        agentName: 'agent-two',
    });
    assert.notEqual(first.GENERATED_SECRET_TEST_SECRET, second.GENERATED_SECRET_TEST_SECRET);
});

test('sharedGeneratedSecret entries share by source env name', () => {
    const manifest = {
        env: [
            {
                name: 'SHARED_GENERATED_SECRET',
                sharedGeneratedSecret: true,
            },
        ],
    };
    const first = buildEnvMap(manifest, null, {
        repoName: 'repo-one',
        agentName: 'agent-one',
    });
    const second = buildEnvMap(manifest, null, {
        repoName: 'repo-two',
        agentName: 'agent-two',
    });
    assert.equal(first.SHARED_GENERATED_SECRET, second.SHARED_GENERATED_SECRET);
    assert.equal(first.SHARED_GENERATED_SECRET, deriveWorkspaceSecret({
        name: 'SHARED_GENERATED_SECRET',
    }));
    assert.notEqual(first.SHARED_GENERATED_SECRET, 'operator-shared-value');
});

test('sharedGeneratedSecret entries can derive from varName', () => {
    const manifest = {
        env: [
            {
                name: 'JWT_SECRET',
                varName: 'ONLYOFFICE_JWT_SECRET',
                sharedGeneratedSecret: true,
            },
        ],
    };
    const env = buildEnvMap(manifest, null, {
        repoName: 'AssistOSExplorer',
        agentName: 'onlyOffice',
    });
    assert.equal(env.JWT_SECRET, deriveWorkspaceSecret({
        name: 'ONLYOFFICE_JWT_SECRET',
    }));
});

test('runtime false env remains available to host hooks but is omitted from runtime injection', () => {
    const manifest = {
        env: [
            {
                name: 'SHARED_GENERATED_SECRET',
                sharedGeneratedSecret: true,
                runtime: false,
            },
        ],
    };
    const options = {
        repoName: 'repo-one',
        agentName: 'agent-one',
    };

    const hostEnv = buildEnvMap(manifest, null, options);
    assert.equal(hostEnv.SHARED_GENERATED_SECRET, deriveWorkspaceSecret({
        name: 'SHARED_GENERATED_SECRET',
    }));
    assert.equal(hostEnv.PLOINKY_ENV_SOURCE_SHARED_GENERATED_SECRET, 'generated');

    const runtimeEnv = buildEnvMap(manifest, null, { ...options, forRuntime: true });
    assert.equal(Object.hasOwn(runtimeEnv, 'SHARED_GENERATED_SECRET'), false);
    assert.equal(Object.hasOwn(runtimeEnv, 'PLOINKY_ENV_SOURCE_SHARED_GENERATED_SECRET'), false);
    assert.deepEqual(buildEnvFlags(manifest, null, { ...options, forRuntime: true }), []);
    assert.deepEqual(getManifestEnvNames(manifest, null, { forRuntime: true }), []);
    assert.equal(getManifestEnvSpecs(manifest)[0].runtime, false);
});

test('runtime false dominates duplicate expose declarations at every runtime boundary', () => {
    const options = {
        repoName: 'repo-one',
        agentName: 'agent-one',
        forRuntime: true,
    };
    const objectExposeManifest = {
        env: [{
            name: 'SHARED_GENERATED_SECRET',
            sharedGeneratedSecret: true,
            runtime: false,
        }],
        expose: {
            SHARED_GENERATED_SECRET: 'resurrected',
            SAFE_RUNTIME_VALUE: 'visible',
        },
    };

    assert.deepEqual(buildEnvMap(objectExposeManifest, null, options), {
        SAFE_RUNTIME_VALUE: 'visible',
    });
    assert.deepEqual(buildEnvFlags(objectExposeManifest, null, options), [
        '-e SAFE_RUNTIME_VALUE="visible"',
    ]);
    assert.deepEqual(getExposedNames(objectExposeManifest, null, { forRuntime: true }), [
        'SAFE_RUNTIME_VALUE',
    ]);

    const arrayExposeManifest = {
        ...objectExposeManifest,
        expose: [
            { name: 'SHARED_GENERATED_SECRET', value: 'resurrected' },
            { name: 'SAFE_RUNTIME_VALUE', value: 'visible' },
        ],
    };
    assert.deepEqual(buildEnvMap(arrayExposeManifest, null, options), {
        SAFE_RUNTIME_VALUE: 'visible',
    });
    assert.deepEqual(getExposedNames(arrayExposeManifest, null, { forRuntime: true }), [
        'SAFE_RUNTIME_VALUE',
    ]);
});

test('runtime false is supported in object-form env and must be boolean', () => {
    const manifest = {
        env: {
            SHARED_GENERATED_SECRET: {
                sharedGeneratedSecret: true,
                runtime: false,
            },
        },
    };
    assert.deepEqual(buildEnvMap(manifest, null, {
        repoName: 'repo-one',
        agentName: 'agent-one',
        forRuntime: true,
    }), {});
    assert.throws(
        () => getManifestEnvSpecs({ env: [{ name: 'BAD_RUNTIME', runtime: 'false' }] }),
        /field 'runtime' must be a boolean/,
    );
    assert.throws(
        () => getManifestEnvSpecs({ env: { BAD_RUNTIME: { runtime: 0 } } }),
        /field 'runtime' must be a boolean/,
    );
});

test('generatedSecret works in object-form env declarations', () => {
    const manifest = {
        env: {
            GENERATED_SECRET_TEST_SECRET: {
                generatedSecret: true,
            },
        },
    };
    const env = buildEnvMap(manifest, null, {
        repoName: 'repo-one',
        agentName: 'agent-one',
    });
    assert.equal(env.GENERATED_SECRET_TEST_SECRET, deriveAgentSecret({
        repoName: 'repo-one',
        agentName: 'agent-one',
        name: 'GENERATED_SECRET_TEST_SECRET',
    }));
});

test('required generatedSecret entries do not need profile defaults', () => {
    const manifest = {
        profiles: {
            prod: {
                env: [
                    {
                        name: 'GENERATED_SECRET_TEST_SECRET',
                        required: true,
                        generatedSecret: true,
                    },
                ],
            },
        },
    };

    const result = validateManifestEnvProfileCompleteness(manifest, manifest.profiles.prod, {
        profileName: 'prod',
    });

    assert.equal(result.valid, true);
});

test('legacy manifest derivation fields are rejected', () => {
    const manifest = {
        env: [
            {
                name: 'OLD_SECRET',
                derive: 'derived-master',
            },
        ],
    };
    assert.throws(() => buildEnvMap(manifest, null, {
        repoName: 'repo-one',
        agentName: 'agent-one',
    }), error => {
        assert.equal(error.code, 'PLOINKY_LEGACY_DERIVED_MASTER_ENV');
        assert.match(error.message, /generatedSecret/);
        return true;
    });
});

test('removed generatedSecretScope field is rejected', () => {
    const manifest = {
        env: [
            {
                name: 'OLD_SHARED_SECRET',
                generatedSecret: true,
                generatedSecretScope: 'workspace',
            },
        ],
    };
    assert.throws(() => buildEnvMap(manifest, null, {
        repoName: 'repo-one',
        agentName: 'agent-one',
    }), error => {
        assert.equal(error.code, 'PLOINKY_REMOVED_GENERATED_SECRET_SCOPE');
        assert.match(error.message, /sharedGeneratedSecret/);
        return true;
    });
});
