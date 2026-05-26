import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-profile-'));
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const profileServiceUrl = new URL('../../cli/services/profileService.js', import.meta.url);
const secretInjectorUrl = new URL('../../cli/services/secretInjector.js', import.meta.url);
const workspaceStructureUrl = new URL('../../cli/services/workspaceStructure.js', import.meta.url);
const encryptedSecretsUrl = new URL('../../cli/services/encryptedSecretsFile.js', import.meta.url);

const profileService = await import(`${profileServiceUrl.href}${moduleSuffix}`);
const secretInjector = await import(`${secretInjectorUrl.href}${moduleSuffix}`);
const workspaceStructure = await import(`${workspaceStructureUrl.href}${moduleSuffix}`);
const { setSecretValue } = await import(`${encryptedSecretsUrl.href}${moduleSuffix}`);

function clearSecretsFile() {
    const secretsPath = path.join(tempDir, '.ploinky', '.secrets');
    fs.rmSync(secretsPath, { force: true });
}

const {
    getActiveProfile,
    setActiveProfile,
    getProfileConfig,
    listProfiles,
    validateProfile,
    getDefaultMountModes,
    getProfileEnvVars,
    getValidProfiles,
    isValidProfile,
} = profileService;

const {
    loadSecretsFile,
    getSecret,
    getSecrets,
    validateSecrets,
    buildSecretEnvFlags,
    formatMissingSecretsError
} = secretInjector;

const {
    createAgentSymlinks,
    removeAgentSymlinks,
    createAgentWorkDir,
    getAgentWorkDir
} = workspaceStructure;

function writeManifest(repoName, agentName, manifest) {
    const agentDir = path.join(tempDir, '.ploinky', 'repos', repoName, agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
        path.join(agentDir, 'manifest.json'),
        JSON.stringify(manifest, null, 4)
    );
    return agentDir;
}

test.after(() => {
    process.chdir(originalCwd);
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_MASTER_KEY;
    } else {
        process.env.PLOINKY_MASTER_KEY = originalMasterKey;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('getActiveProfile defaults to default when profile file is missing', () => {
    assert.strictEqual(getActiveProfile(), 'default');
});

test('setActiveProfile rejects invalid profile names', () => {
    const result = setActiveProfile('staging');
    assert.strictEqual(result.success, false);
    assert.match(result.message, /Invalid profile/);
});

test('setActiveProfile writes profile file and getActiveProfile reads it', () => {
    writeManifest('repo-setprofile', 'agent-setprofile', {
        profiles: { default: {}, qa: {} },
    });

    const result = setActiveProfile('qa');
    assert.strictEqual(result.success, true);
    assert.strictEqual(getActiveProfile(), 'qa');

    const profilePath = path.join(tempDir, '.ploinky', 'profile');
    assert.strictEqual(fs.readFileSync(profilePath, 'utf8').trim(), 'qa');
});

test('listProfiles returns manifest profiles and defaultProfile', () => {
    writeManifest('repo-one', 'agent-one', {
        profiles: {
            dev: {},
            qa: {}
        },
        defaultProfile: 'qa'
    });

    const result = listProfiles('repo-one/agent-one');
    assert.deepStrictEqual(result.profiles.sort(), ['dev', 'qa']);
    assert.strictEqual(result.defaultProfile, 'qa');
});

test('getProfileConfig returns the profile config when present', () => {
    writeManifest('repo-two', 'agent-two', {
        profiles: {
            default: { env: { NODE_ENV: 'default' } },
            dev: { env: { NODE_ENV: 'development' } }
        }
    });

    const config = getProfileConfig('repo-two/agent-two', 'dev');
    // Result is merged: default + dev (dev overrides)
    assert.deepStrictEqual(config, { env: { NODE_ENV: 'development' } });
});

test('getProfileConfig lets active profile network replace default network', () => {
    writeManifest('repo-network', 'agent-network', {
        profiles: {
            default: {
                network: {
                    name: 'webmeet',
                    aliases: ['webmeetLivekitServer'],
                },
            },
            prod: {
                network: {
                    mode: 'host',
                },
            },
        },
    });

    const config = getProfileConfig('repo-network/agent-network', 'prod');
    assert.deepStrictEqual(config.network, { mode: 'host' });
});

test('validateProfile reports missing secrets', () => {
    writeManifest('repo-three', 'agent-three', {
        profiles: {
            default: {},
            dev: { secrets: ['TEST_SECRET'] }
        }
    });

    const previousValue = process.env.TEST_SECRET;
    delete process.env.TEST_SECRET;

    const result = validateProfile('repo-three/agent-three', 'dev');
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some(issue => issue.includes('Missing required secret')));

    if (previousValue !== undefined) {
        process.env.TEST_SECRET = previousValue;
    }
});

test('validateProfile reports required non-sensitive env without profile defaults', () => {
    writeManifest('repo-profile-env', 'agent-profile-env', {
        profiles: {
            default: {},
            prod: {
                env: [
                    {
                        name: 'PUBLIC_ENDPOINT',
                        required: true
                    },
                    {
                        name: 'SERVICE_API_KEY',
                        required: true
                    }
                ]
            }
        }
    });

    const result = validateProfile('repo-profile-env/agent-profile-env', 'prod');
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some(issue => issue.includes('PUBLIC_ENDPOINT')));
    assert.ok(!result.issues.some(issue => issue.includes('SERVICE_API_KEY')));
});

test('validateProfile accepts complete non-sensitive env defaults and generated secrets', () => {
    writeManifest('repo-profile-complete', 'agent-profile-complete', {
        profiles: {
            default: {},
            prod: {
                env: [
                    {
                        name: 'PUBLIC_ENDPOINT',
                        required: true,
                        default: 'https://example.test'
                    },
                    {
                        name: 'SERVICE_SECRET',
                        required: true
                    },
                    {
                        name: 'GENERATED_SECRET',
                        required: true,
                        generatedSecret: true
                    }
                ]
            }
        }
    });

    const result = validateProfile('repo-profile-complete/agent-profile-complete', 'prod');
    assert.strictEqual(result.valid, true);
});

test('validateProfile succeeds when secrets and hooks are present', () => {
    const agentDir = writeManifest('repo-four', 'agent-four', {
        profiles: {
            default: {},
            dev: {
                secrets: ['TEST_SECRET'],
                hosthook_aftercreation: 'scripts/hook.sh'
            }
        }
    });

    const hookPath = path.join(agentDir, 'scripts', 'hook.sh');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho ok\n');

    const previousValue = process.env.TEST_SECRET;
    process.env.TEST_SECRET = 'present';

    const result = validateProfile('repo-four/agent-four', 'dev');
    assert.strictEqual(result.valid, true);

    if (previousValue !== undefined) {
        process.env.TEST_SECRET = previousValue;
    } else {
        delete process.env.TEST_SECRET;
    }
});

test('validateProfile accepts secrets from .env', () => {
    writeManifest('repo-five', 'agent-five', {
        profiles: {
            default: {},
            dev: { secrets: ['ENV_SECRET'] }
        }
    });

    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'ENV_SECRET=present');

    const result = validateProfile('repo-five/agent-five', 'dev');
    assert.strictEqual(result.valid, true);
});

test('getDefaultMountModes returns rw for default and ro for others', () => {
    assert.deepStrictEqual(getDefaultMountModes('default'), { code: 'rw', skills: 'rw' });
    assert.deepStrictEqual(getDefaultMountModes('dev'), { code: 'rw', skills: 'rw' });
    assert.deepStrictEqual(getDefaultMountModes('prod'), { code: 'ro', skills: 'ro' });
    assert.deepStrictEqual(getDefaultMountModes('embedded'), { code: 'ro', skills: 'ro' });
});

test('getProfileEnvVars includes profile metadata', () => {
    const envVars = getProfileEnvVars('agent-x', 'repo-x', 'qa', {
        containerName: 'container-x',
        containerId: 'container-x'
    });

    assert.strictEqual(envVars.PLOINKY_PROFILE, 'qa');
    assert.strictEqual(envVars.PLOINKY_PROFILE_ENV, 'qa');
    assert.strictEqual(envVars.PLOINKY_AGENT_NAME, 'agent-x');
    assert.strictEqual(envVars.PLOINKY_REPO_NAME, 'repo-x');
    assert.strictEqual(envVars.PLOINKY_CONTAINER_NAME, 'container-x');
    assert.strictEqual(envVars.PLOINKY_CONTAINER_ID, 'container-x');
    assert.strictEqual(path.resolve(envVars.PLOINKY_CWD), fs.realpathSync(tempDir));
});

test('loadSecretsFile round-trips values written via setSecretValue', () => {
    clearSecretsFile();
    setSecretValue('PLAIN', 'value');
    setSecretValue('QUOTED', 'value with spaces');
    setSecretValue('SINGLE', 'single value');

    const secrets = loadSecretsFile();
    assert.deepStrictEqual(secrets, {
        PLAIN: 'value',
        QUOTED: 'value with spaces',
        SINGLE: 'single value'
    });
});

test('getSecret prefers environment variables over secrets file', () => {
    clearSecretsFile();
    setSecretValue('OVERRIDE', 'file-value');

    const previousValue = process.env.OVERRIDE;
    process.env.OVERRIDE = 'env-value';

    assert.strictEqual(getSecret('OVERRIDE'), 'env-value');

    if (previousValue !== undefined) {
        process.env.OVERRIDE = previousValue;
    } else {
        delete process.env.OVERRIDE;
    }
});

test('getSecret falls back to .env when other sources are missing', () => {
    clearSecretsFile();
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'ENV_ONLY=env-value');

    const previousValue = process.env.ENV_ONLY;
    delete process.env.ENV_ONLY;

    assert.strictEqual(getSecret('ENV_ONLY'), 'env-value');

    if (previousValue !== undefined) {
        process.env.ENV_ONLY = previousValue;
    }
});

test('validateSecrets uses secrets file when env missing', () => {
    clearSecretsFile();
    setSecretValue('FROM_FILE', 'yes');

    const result = validateSecrets(['FROM_FILE', 'MISSING']);
    assert.deepStrictEqual(result.missing, ['MISSING']);
    assert.strictEqual(result.source.FROM_FILE, '.secrets file');
});

test('validateSecrets records .env file as source', () => {
    clearSecretsFile();
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'FROM_ENV=yes');

    const result = validateSecrets(['FROM_ENV']);
    assert.deepStrictEqual(result.missing, []);
    assert.strictEqual(result.source.FROM_ENV, '.env file');
});

test('buildSecretEnvFlags escapes special values', () => {
    const flags = buildSecretEnvFlags({
        SIMPLE: 'value',
        COMPLEX: 'value with spaces'
    });

    assert.ok(flags.includes('-e SIMPLE=value'));
    assert.ok(flags.includes("-e COMPLEX='value with spaces'"));
});

test('formatMissingSecretsError includes guidance and file path', () => {
    const message = formatMissingSecretsError(['ONE', 'TWO'], 'qa');
    assert.ok(message.includes("Missing required secrets for profile 'qa'"));
    assert.ok(message.includes('ploinky var ONE your_value_here'));
    assert.ok(message.includes(path.join(tempDir, '.env')));
});

test('createAgentSymlinks creates code and skills symlinks', () => {
    const agentName = 'symlink-agent';
    const repoName = 'repo-symlink';
    const agentPath = path.join(tempDir, '.ploinky', 'repos', repoName, agentName);

    fs.mkdirSync(path.join(agentPath, 'code'), { recursive: true });
    fs.mkdirSync(path.join(agentPath, 'skills'), { recursive: true });

    assert.doesNotThrow(() => createAgentSymlinks(agentName, repoName, agentPath));

    const codeLink = path.join(tempDir, '.ploinky', 'code', agentName);
    const skillsLink = path.join(tempDir, '.ploinky', 'skills', agentName);

    assert.ok(fs.lstatSync(codeLink).isSymbolicLink());
    assert.ok(fs.lstatSync(skillsLink).isSymbolicLink());

    const codeTarget = fs.readlinkSync(codeLink);
    const skillsTarget = fs.readlinkSync(skillsLink);

    assert.strictEqual(path.resolve(codeTarget), path.resolve(path.join(agentPath, 'code')));
    assert.strictEqual(path.resolve(skillsTarget), path.resolve(path.join(agentPath, 'skills')));
});

test('createAgentSymlinks skips skills when folder is missing', () => {
    const agentName = 'symlink-no-skills';
    const repoName = 'repo-no-skills';
    const agentPath = path.join(tempDir, '.ploinky', 'repos', repoName, agentName);

    fs.mkdirSync(path.join(agentPath, 'code'), { recursive: true });

    createAgentSymlinks(agentName, repoName, agentPath);

    const skillsLink = path.join(tempDir, '.ploinky', 'skills', agentName);
    assert.ok(!fs.existsSync(skillsLink));
});

test('removeAgentSymlinks removes created symlinks', () => {
    const agentName = 'symlink-remove';
    const repoName = 'repo-remove';
    const agentPath = path.join(tempDir, '.ploinky', 'repos', repoName, agentName);

    fs.mkdirSync(path.join(agentPath, 'code'), { recursive: true });
    fs.mkdirSync(path.join(agentPath, 'skills'), { recursive: true });

    createAgentSymlinks(agentName, repoName, agentPath);
    removeAgentSymlinks(agentName);

    const codeLink = path.join(tempDir, '.ploinky', 'code', agentName);
    const skillsLink = path.join(tempDir, '.ploinky', 'skills', agentName);

    assert.ok(!fs.existsSync(codeLink));
    assert.ok(!fs.existsSync(skillsLink));
});

test('createAgentWorkDir creates agent workspace folder', () => {
    const agentName = 'workdir-agent';
    const workDir = createAgentWorkDir(agentName);

    assert.strictEqual(workDir, getAgentWorkDir(agentName));
    assert.ok(fs.statSync(workDir).isDirectory());
});

// --- Semantic (manifest-declared) profile tests ---

test('isValidProfile always accepts default', () => {
    assert.strictEqual(isValidProfile('default'), true);
});

test('isValidProfile rejects unknown profiles when no manifest declares them', () => {
    assert.strictEqual(isValidProfile('staging'), false);
    assert.strictEqual(isValidProfile('canary'), false);
});

test('isValidProfile accepts manifest-declared semantic profiles', () => {
    writeManifest('proxies', 'soul-gateway', {
        profiles: {
            default: { env: {} },
            embedded: { env: { PORT: '7000' } },
            standalone: { env: { PORT: '8042' } },
        },
    });

    assert.strictEqual(isValidProfile('embedded'), true);
    assert.strictEqual(isValidProfile('standalone'), true);
    assert.strictEqual(isValidProfile('nonexistent'), false);
});

test('getValidProfiles includes manifest-declared profiles', () => {
    writeManifest('semantic', 'test-agent', {
        profiles: {
            default: {},
            embedded: {},
        },
    });

    const valid = getValidProfiles();
    assert.ok(valid.includes('default'));
    assert.ok(valid.includes('embedded'));
});

test('setActiveProfile accepts manifest-declared semantic profiles', () => {
    writeManifest('semantic-set', 'agent-set', {
        profiles: {
            default: {},
            embedded: { env: { MODE: 'embedded' } },
        },
    });

    const result = setActiveProfile('embedded');
    assert.strictEqual(result.success, true);
    assert.strictEqual(getActiveProfile(), 'embedded');
});

test('getProfileConfig merges default with semantic profile', () => {
    writeManifest('semantic-merge', 'agent-merge', {
        profiles: {
            default: {
                env: { BASE: 'value', PORT: '8042' },
            },
            embedded: {
                env: { PORT: '7000', MODE: 'embedded' },
            },
        },
    });

    const config = getProfileConfig('semantic-merge/agent-merge', 'embedded');
    assert.deepStrictEqual(config.env, { BASE: 'value', PORT: '7000', MODE: 'embedded' });
});

test('getProfileConfig preserves structured object env specs when merged with array profile env', () => {
    writeManifest('semantic-mixed-env', 'agent-mixed-env', {
        profiles: {
            default: {
                env: {
                    PGHOST: {
                        required: false,
                        default: 'host.containers.internal',
                    },
                    API_TOKEN: {
                        name: 'HOST_API_TOKEN',
                        required: false,
                    },
                },
            },
            embedded: {
                env: [
                    {
                        name: 'PORT',
                        required: false,
                        default: '7000',
                    },
                ],
            },
        },
    });

    const config = getProfileConfig('semantic-mixed-env/agent-mixed-env', 'embedded');
    assert.deepStrictEqual(config.env, [
        {
            name: 'PORT',
            required: false,
            default: '7000',
        },
        {
            name: 'PGHOST',
            required: false,
            default: 'host.containers.internal',
        },
        {
            name: 'API_TOKEN',
            required: false,
            varName: 'HOST_API_TOKEN',
        },
    ]);
});

test('getProfileConfig falls back to default when agent has no matching semantic profile', () => {
    writeManifest('semantic-fallback', 'agent-fallback', {
        profiles: {
            default: { env: { PORT: '8042' } },
            standalone: { env: { PORT: '8042' } },
        },
    });

    const config = getProfileConfig('semantic-fallback/agent-fallback', 'embedded');
    assert.deepStrictEqual(config.env, { PORT: '8042' });
});
