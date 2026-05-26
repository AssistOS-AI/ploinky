import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const originalDerivedTestSecret = process.env.DERIVED_MASTER_TEST_SECRET;
const originalGeneratedTestSecret = process.env.GENERATED_SECRET_TEST_SECRET;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-derived-env-'));
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
process.env.DERIVED_MASTER_TEST_SECRET = 'operator-value';
process.env.GENERATED_SECRET_TEST_SECRET = 'operator-value';

const moduleSuffix = `?test=${Date.now()}`;
const { buildEnvMap, validateManifestEnvProfileCompleteness } = await import(`../../cli/services/secretVars.js${moduleSuffix}`);
const { deriveAgentSecret } = await import(`../../cli/services/masterKey.js${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_MASTER_KEY;
    } else {
        process.env.PLOINKY_MASTER_KEY = originalMasterKey;
    }
    if (originalDerivedTestSecret === undefined) {
        delete process.env.DERIVED_MASTER_TEST_SECRET;
    } else {
        process.env.DERIVED_MASTER_TEST_SECRET = originalDerivedTestSecret;
    }
    if (originalGeneratedTestSecret === undefined) {
        delete process.env.GENERATED_SECRET_TEST_SECRET;
    } else {
        process.env.GENERATED_SECRET_TEST_SECRET = originalGeneratedTestSecret;
    }
});

test('buildEnvMap derives derived-master env entries from the derived master key', () => {
    const manifest = {
        env: [
            {
                name: 'DERIVED_MASTER_TEST_SECRET',
                derive: 'derived-master',
            },
        ],
    };
    const env = buildEnvMap(manifest, null, {
        repoName: 'repo-one',
        agentName: 'agent-one',
    });
    assert.equal(env.DERIVED_MASTER_TEST_SECRET, deriveAgentSecret({
        repoName: 'repo-one',
        agentName: 'agent-one',
        name: 'DERIVED_MASTER_TEST_SECRET',
    }));
    assert.notEqual(env.DERIVED_MASTER_TEST_SECRET, 'operator-value');
});

test('buildEnvMap can share a derived-master identity across agents', () => {
    const manifest = {
        env: [
            {
                name: 'SHARED_SECRET',
                derive: 'derived-master',
                deriveRepoName: 'logical-repo',
                deriveAgentName: 'logical-agent',
                deriveName: 'shared-secret',
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
    assert.equal(first.SHARED_SECRET, second.SHARED_SECRET);
    assert.equal(first.SHARED_SECRET, deriveAgentSecret({
        repoName: 'logical-repo',
        agentName: 'logical-agent',
        name: 'shared-secret',
    }));
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

test('generatedSecret and derived-master env entries produce same value for migrated manifest secrets', () => {
    const generatedManifest = {
        env: [
            {
                name: 'PLOINKY_WEBMEET_MASTER_KEY',
                generatedSecret: true,
            },
        ],
    };
    const derivedManifest = {
        env: [
            {
                name: 'PLOINKY_WEBMEET_MASTER_KEY',
                derive: 'derived-master',
            },
        ],
    };
    const options = {
        repoName: 'AssistOSExplorer',
        agentName: 'webmeetAgent',
    };

    const generatedEnv = buildEnvMap(generatedManifest, null, options);
    const derivedEnv = buildEnvMap(derivedManifest, null, options);

    assert.equal(generatedEnv.PLOINKY_WEBMEET_MASTER_KEY, derivedEnv.PLOINKY_WEBMEET_MASTER_KEY);
    assert.equal(generatedEnv.PLOINKY_WEBMEET_MASTER_KEY, deriveAgentSecret({
        ...options,
        name: 'PLOINKY_WEBMEET_MASTER_KEY',
    }));
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
