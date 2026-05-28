import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const originalGeneratedTestSecret = process.env.GENERATED_SECRET_TEST_SECRET;
const originalSharedSecret = process.env.SHARED_GENERATED_SECRET;
const originalSoulGatewayApiKey = process.env.SOUL_GATEWAY_API_KEY;
const originalSoulGatewayBaseUrl = process.env.SOUL_GATEWAY_BASE_URL;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-generated-env-'));
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
process.env.GENERATED_SECRET_TEST_SECRET = 'operator-value';
process.env.SHARED_GENERATED_SECRET = 'operator-shared-value';

const moduleSuffix = `?test=${Date.now()}`;
const { buildEnvMap, validateManifestEnvProfileCompleteness } = await import(`../../cli/services/secretVars.js${moduleSuffix}`);
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
    if (originalSoulGatewayApiKey === undefined) {
        delete process.env.SOUL_GATEWAY_API_KEY;
    } else {
        process.env.SOUL_GATEWAY_API_KEY = originalSoulGatewayApiKey;
    }
    if (originalSoulGatewayBaseUrl === undefined) {
        delete process.env.SOUL_GATEWAY_BASE_URL;
    } else {
        process.env.SOUL_GATEWAY_BASE_URL = originalSoulGatewayBaseUrl;
    }
});

function withSoulGatewayEnv(values, fn) {
    const previousApiKey = process.env.SOUL_GATEWAY_API_KEY;
    const previousBaseUrl = process.env.SOUL_GATEWAY_BASE_URL;
    try {
        if (Object.prototype.hasOwnProperty.call(values, 'SOUL_GATEWAY_API_KEY')) {
            process.env.SOUL_GATEWAY_API_KEY = values.SOUL_GATEWAY_API_KEY;
        } else {
            delete process.env.SOUL_GATEWAY_API_KEY;
        }
        if (Object.prototype.hasOwnProperty.call(values, 'SOUL_GATEWAY_BASE_URL')) {
            process.env.SOUL_GATEWAY_BASE_URL = values.SOUL_GATEWAY_BASE_URL;
        } else {
            delete process.env.SOUL_GATEWAY_BASE_URL;
        }
        return fn();
    } finally {
        if (previousApiKey === undefined) {
            delete process.env.SOUL_GATEWAY_API_KEY;
        } else {
            process.env.SOUL_GATEWAY_API_KEY = previousApiKey;
        }
        if (previousBaseUrl === undefined) {
            delete process.env.SOUL_GATEWAY_BASE_URL;
        } else {
            process.env.SOUL_GATEWAY_BASE_URL = previousBaseUrl;
        }
    }
}

function soulGatewayConsumerManifest() {
    return {
        env: [
            {
                name: 'SOUL_GATEWAY_API_KEY',
                sharedGeneratedSecret: true,
                explicitOverride: true,
            },
            {
                name: 'SOUL_GATEWAY_BASE_URL',
                value: '',
            },
        ],
    };
}

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

test('sharedGeneratedSecret overrides can opt into explicit values when companions are present', () => {
    withSoulGatewayEnv({
        SOUL_GATEWAY_API_KEY: 'external-soul-key',
        SOUL_GATEWAY_BASE_URL: 'https://soul.example.test/v1',
    }, () => {
        const env = buildEnvMap(soulGatewayConsumerManifest(), null, {
            repoName: 'AssistOSExplorer',
            agentName: 'llmAssistant',
        });

        assert.equal(env.SOUL_GATEWAY_API_KEY, 'external-soul-key');
        assert.equal(env.PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY, 'explicit');
        assert.equal(env.SOUL_GATEWAY_BASE_URL, 'https://soul.example.test/v1');
    });
});

test('sharedGeneratedSecret override can accept an explicit key without an explicit base URL', () => {
    withSoulGatewayEnv({
        SOUL_GATEWAY_API_KEY: 'external-soul-key',
    }, () => {
        const env = buildEnvMap(soulGatewayConsumerManifest(), null, {
            repoName: 'AssistOSExplorer',
            agentName: 'llmAssistant',
        });

        assert.equal(env.SOUL_GATEWAY_API_KEY, 'external-soul-key');
        assert.equal(env.PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY, 'explicit');
        assert.equal(env.SOUL_GATEWAY_BASE_URL, '');
    });
});

test('sharedGeneratedSecret companion requirements can still require a complete explicit pair', () => {
    const manifest = {
        env: [
            {
                name: 'SOUL_GATEWAY_API_KEY',
                sharedGeneratedSecret: true,
                explicitOverrideRequires: ['SOUL_GATEWAY_BASE_URL'],
            },
            {
                name: 'SOUL_GATEWAY_BASE_URL',
                value: '',
            },
        ],
    };

    withSoulGatewayEnv({
        SOUL_GATEWAY_API_KEY: 'external-soul-key',
    }, () => {
        const env = buildEnvMap(manifest, null, {
            repoName: 'AssistOSExplorer',
            agentName: 'llmAssistant',
        });

        assert.equal(env.SOUL_GATEWAY_API_KEY, deriveWorkspaceSecret({
            name: 'SOUL_GATEWAY_API_KEY',
        }));
        assert.equal(env.PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY, 'generated');
        assert.equal(env.SOUL_GATEWAY_BASE_URL, '');
    });
});

test('generated local Soul Gateway key can coexist with remote provider key alias', () => {
    const manifest = {
        env: {
            SOUL_GATEWAY_API_KEY: {
                sharedGeneratedSecret: true,
            },
            SOUL_GATEWAY_PROVIDER_API_KEY: {
                varName: 'SOUL_GATEWAY_API_KEY',
                default: '',
            },
        },
    };

    withSoulGatewayEnv({
        SOUL_GATEWAY_API_KEY: 'external-soul-key',
    }, () => {
        const env = buildEnvMap(manifest, null, {
            repoName: 'proxies',
            agentName: 'soul-gateway',
        });

        assert.equal(env.SOUL_GATEWAY_API_KEY, deriveWorkspaceSecret({
            name: 'SOUL_GATEWAY_API_KEY',
        }));
        assert.equal(env.PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY, 'generated');
        assert.equal(env.SOUL_GATEWAY_PROVIDER_API_KEY, 'external-soul-key');
    });
});

test('sharedGeneratedSecret override can resolve from workspace .env', () => {
    withSoulGatewayEnv({}, () => {
        const envFilePath = path.join(tempDir, '.env');
        fs.writeFileSync(envFilePath, [
            'SOUL_GATEWAY_API_KEY=env-file-soul-key',
            'SOUL_GATEWAY_BASE_URL=https://env-file-soul.example.test/v1',
            '',
        ].join('\n'));
        try {
            const env = buildEnvMap(soulGatewayConsumerManifest(), null, {
                repoName: 'AssistOSExplorer',
                agentName: 'llmAssistant',
            });

            assert.equal(env.SOUL_GATEWAY_API_KEY, 'env-file-soul-key');
            assert.equal(env.PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY, 'explicit');
            assert.equal(env.SOUL_GATEWAY_BASE_URL, 'https://env-file-soul.example.test/v1');
        } finally {
            fs.rmSync(envFilePath, { force: true });
        }
    });
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
