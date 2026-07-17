import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const originalUnsafeMaster = process.env.PLOINKY_DERIVED_MASTER_KEY;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-config-provider-'));

process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '8'.repeat(64);
process.env.PLOINKY_DERIVED_MASTER_KEY = 'must-not-be-forwarded';

const moduleSuffix = `?test=${Date.now()}`;
const providerModule = await import(`../../cli/services/startupConfigProviders.js${moduleSuffix}`);
const secretsModule = await import(`../../cli/services/encryptedSecretsFile.js${moduleSuffix}`);
const identityEnvModule = await import(`../../cli/services/agentIdentityEnv.js${moduleSuffix}`);

const {
    applyStartupConfigProviders,
    applyStartupConfigProvidersForGraph,
    buildProviderSubprocessEnv,
    collectStartupConfigProviderEntries,
    redactProviderValue,
} = providerModule;
const { readSecretsFile } = secretsModule;
const { RESERVED_AGENT_ENV_NAMES } = identityEnvModule;

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_MASTER_KEY;
    } else {
        process.env.PLOINKY_MASTER_KEY = originalMasterKey;
    }
    if (originalUnsafeMaster === undefined) {
        delete process.env.PLOINKY_DERIVED_MASTER_KEY;
    } else {
        process.env.PLOINKY_DERIVED_MASTER_KEY = originalUnsafeMaster;
    }
});

function providerDescriptor(overrides = {}) {
    return {
        repoName: 'example',
        shortAgentName: 'config-provider',
        agentPath: tempDir,
        profileName: 'default',
        manifest: {
            providesConfig: {
                command: 'node runtime/provider.mjs',
                outputs: [
                    { name: 'EXAMPLE_PUBLIC_URL', sensitive: false },
                    { name: 'EXAMPLE_PROVIDER_TOKEN', sensitive: true },
                ],
            },
            profiles: {
                default: {
                    env: [
                        'EXAMPLE_REGION=eu-test-1',
                        'PLOINKY_MASTER_KEY',
                    ],
                },
            },
        },
        profileConfig: {
            env: [
                'EXAMPLE_REGION=eu-test-1',
                'PLOINKY_MASTER_KEY',
            ],
        },
        ...overrides,
    };
}

function writeRepoManifest(repoName, agentName, manifest) {
    const agentDir = path.join(tempDir, '.ploinky', 'repos', repoName, agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

test('collectStartupConfigProviderEntries reads active profile providers', () => {
    const manifest = {
        profiles: {
            default: {
                configProviders: [
                    { agent: 'example/config-provider global', profile: 'default' },
                ],
            },
            qa: {
                configProviders: [
                    { agent: 'example/config-provider global', profile: 'qa' },
                ],
            },
        },
    };

    assert.deepEqual(
        collectStartupConfigProviderEntries(manifest, manifest.profiles.qa),
        [{ agent: 'example/config-provider global', profile: 'qa' }]
    );
});

test('buildProviderSubprocessEnv includes only allowlisted runtime and provider inputs', () => {
    const reservedOverrides = Object.fromEntries(
        RESERVED_AGENT_ENV_NAMES.map((name) => [name, `attacker-controlled-${name}`]),
    );
    const env = buildProviderSubprocessEnv({
        provider: providerDescriptor({
            manifest: {
                ...providerDescriptor().manifest,
                profiles: {
                    default: {
                        env: reservedOverrides,
                    },
                },
            },
            profileConfig: {
                env: {
                    EXAMPLE_REGION: 'eu-test-1',
                    ...reservedOverrides,
                },
            },
        }),
        workspaceRoot: tempDir,
        profileName: 'qa',
    });

    assert.equal(env.PLOINKY_WORKSPACE_ROOT, tempDir);
    assert.equal(env.PLOINKY_PROFILE, 'qa');
    assert.equal(env.PLOINKY_PROVIDER_AGENT, 'example/config-provider');
    assert.equal(env.PLOINKY_PROVIDER_AGENT_ID, 'agent:example/config-provider');
    assert.equal(env.EXAMPLE_REGION, 'eu-test-1');
    assert.equal(
        env.PLOINKY_EDGE_TOPOLOGY_FILE,
        path.join(tempDir, '.ploinky', 'run', 'edge-topology', 'current.json'),
    );
    assert.equal(env.PLOINKY_ROUTER_URL, 'http://127.0.0.1:8080');
    assert.equal(env.PLOINKY_INTERNAL_ROUTER_URL, 'http://127.0.0.1:8081');
    const authoritativeProviderRuntimeNames = new Set([
        'PLOINKY_EDGE_TOPOLOGY_FILE',
        'PLOINKY_ROUTER_URL',
        'PLOINKY_INTERNAL_ROUTER_URL',
    ]);
    for (const name of RESERVED_AGENT_ENV_NAMES) {
        if (authoritativeProviderRuntimeNames.has(name)) continue;
        assert.equal(env[name], undefined, `${name} must not reach a config-provider process`);
    }
});

test('applyStartupConfigProviders persists declared outputs and redacted metadata', async () => {
    const result = await applyStartupConfigProviders({
        providers: [providerDescriptor()],
        workspaceRoot: tempDir,
        profileName: 'qa',
        runProviderCommand: () => ({
            version: 1,
            values: [
                {
                    name: 'EXAMPLE_PUBLIC_URL',
                    value: 'https://service.example.test',
                    sensitive: false,
                    source: 'generated',
                },
                {
                    name: 'EXAMPLE_PROVIDER_TOKEN',
                    value: 'secret-token-value',
                    sensitive: true,
                    source: 'provider-token',
                },
            ],
            warnings: [],
        }),
    });

    assert.equal(result.applied.length, 2);
    assert.deepEqual(readSecretsFile(), {
        EXAMPLE_PUBLIC_URL: 'https://service.example.test',
        EXAMPLE_PROVIDER_TOKEN: 'secret-token-value',
    });

    const metadataPath = path.join(tempDir, '.ploinky', 'config-providers', 'config-provider.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    assert.equal(metadata.providerAgentId, 'agent:example/config-provider');
    assert.equal(metadata.outputs.length, 2);
    assert.doesNotMatch(JSON.stringify(metadata), /secret-token-value|https:\/\/service\.example\.test/);
    assert.match(JSON.stringify(metadata), /redacted/);
});

test('applyStartupConfigProviders rejects undeclared and reserved outputs', async () => {
    await assert.rejects(
        () => applyStartupConfigProviders({
            providers: [providerDescriptor()],
            workspaceRoot: tempDir,
            profileName: 'qa',
            runProviderCommand: () => ({
                version: 1,
                values: [
                    { name: 'UNDECLARED_PROVIDER_VALUE', value: 'unexpected', sensitive: true },
                ],
            }),
        }),
        /not declared/
    );

    await assert.rejects(
        () => applyStartupConfigProviders({
            providers: [providerDescriptor({
                manifest: {
                    providesConfig: {
                        command: 'node runtime/provider.mjs',
                        outputs: [{ name: 'PLOINKY_MASTER_KEY', sensitive: true }],
                    },
                },
            })],
            workspaceRoot: tempDir,
            profileName: 'qa',
            runProviderCommand: () => ({
                version: 1,
                values: [
                    { name: 'PLOINKY_MASTER_KEY', value: 'oops', sensitive: true },
                ],
            }),
        }),
        /reserved/
    );

    await assert.rejects(
        () => applyStartupConfigProviders({
            providers: [providerDescriptor({
                manifest: {
                    providesConfig: {
                        command: 'node runtime/provider.mjs',
                        outputs: [{ name: 'PLOINKY_EDGE_TOPOLOGY_FILE', sensitive: false }],
                    },
                },
            })],
            workspaceRoot: tempDir,
            profileName: 'qa',
            runProviderCommand: () => ({
                version: 1,
                values: [
                    { name: 'PLOINKY_EDGE_TOPOLOGY_FILE', value: '/forbidden', sensitive: false },
                ],
            }),
        }),
        /reserved/
    );
});

test('applyStartupConfigProviders rejects sensitive flag mismatches and generated secret names', async () => {
    await assert.rejects(
        () => applyStartupConfigProviders({
            providers: [providerDescriptor()],
            workspaceRoot: tempDir,
            profileName: 'qa',
            runProviderCommand: () => ({
                version: 1,
                values: [
                    {
                        name: 'EXAMPLE_PROVIDER_TOKEN',
                        value: 'secret-token-value',
                        sensitive: false,
                    },
                ],
            }),
        }),
        /sensitive flag/
    );

    await assert.rejects(
        () => applyStartupConfigProviders({
            providers: [providerDescriptor()],
            workspaceRoot: tempDir,
            profileName: 'qa',
            protectedOutputNames: new Set(['EXAMPLE_PUBLIC_URL']),
            runProviderCommand: () => ({
                version: 1,
                values: [
                    {
                        name: 'EXAMPLE_PUBLIC_URL',
                        value: 'https://service.example.test',
                        sensitive: false,
                    },
                ],
            }),
        }),
        /generated or shared generated/
    );
});

test('redactProviderValue never returns raw secret material', () => {
    assert.equal(redactProviderValue('TOKEN_NAME', 'secret-token', true), '[redacted]');
    assert.equal(redactProviderValue('PUBLIC_URL', 'https://service.example.test', false), '[redacted]');
});

test('applyStartupConfigProvidersForGraph runs active profile providers from the dependency graph', async () => {
    writeRepoManifest('example', 'config-provider-graph', {
        providesConfig: {
            command: 'node runtime/provider.mjs',
            outputs: [
                { name: 'GRAPH_PROVIDER_PUBLIC_URL', sensitive: false },
            ],
        },
        profiles: {
            default: {
                env: [
                    'EXAMPLE_REGION=graph-test-1',
                ],
            },
        },
    });
    writeRepoManifest('app', 'application-graph', {
        container: 'node:20-alpine',
        profiles: {
            default: {
                configProviders: [
                    { agent: 'example/config-provider-graph global', profile: 'default' },
                ],
            },
        },
        enable: [
            'example/config-provider-graph global',
        ],
    });

    const graphModule = await import(`../../cli/services/workspaceDependencyGraph.js${moduleSuffix}&graph=1`);
    const graph = graphModule.resolveWorkspaceDependencyGraph({
        staticAgentRef: 'app/application-graph',
    });
    const result = await applyStartupConfigProvidersForGraph({
        dependencyGraph: graph,
        workspaceRoot: tempDir,
        profileName: 'default',
        runProviderCommand: ({ env }) => {
            assert.equal(env.PLOINKY_PROVIDER_AGENT, 'example/config-provider-graph');
            assert.equal(env.EXAMPLE_REGION, 'graph-test-1');
            return {
                version: 1,
                values: [
                    {
                        name: 'GRAPH_PROVIDER_PUBLIC_URL',
                        value: 'https://graph.example.test',
                        sensitive: false,
                        source: 'generated',
                    },
                ],
                warnings: [],
            };
        },
    });

    assert.equal(result.applied.some((entry) => entry.name === 'GRAPH_PROVIDER_PUBLIC_URL'), true);
    assert.equal(readSecretsFile().GRAPH_PROVIDER_PUBLIC_URL, 'https://graph.example.test');
});

test('applyStartupConfigProvidersForGraph rejects outputs for graph generated secrets', async () => {
    writeRepoManifest('example', 'generated-secret-provider', {
        providesConfig: {
            command: 'node runtime/provider.mjs',
            outputs: [
                { name: 'EXAMPLE_SHARED_SECRET', sensitive: true },
            ],
        },
        profiles: {
            default: {
                env: [],
            },
        },
    });
    writeRepoManifest('app', 'generated-secret-consumer', {
        container: 'node:20-alpine',
        profiles: {
            default: {
                configProviders: [
                    { agent: 'example/generated-secret-provider global', profile: 'default' },
                ],
            },
        },
        enable: [
            'example/generated-secret-provider global',
        ],
        env: [
            {
                name: 'JWT_SECRET',
                varName: 'EXAMPLE_SHARED_SECRET',
                sharedGeneratedSecret: true,
            },
        ],
    });

    const graphModule = await import(`../../cli/services/workspaceDependencyGraph.js${moduleSuffix}&graph=2`);
    const graph = graphModule.resolveWorkspaceDependencyGraph({
        staticAgentRef: 'app/generated-secret-consumer',
    });

    await assert.rejects(
        () => applyStartupConfigProvidersForGraph({
            dependencyGraph: graph,
            workspaceRoot: tempDir,
            profileName: 'default',
            runProviderCommand: () => ({
                version: 1,
                values: [
                    {
                        name: 'EXAMPLE_SHARED_SECRET',
                        value: 'provider-owned-secret',
                        sensitive: true,
                        source: 'generated',
                    },
                ],
            }),
        }),
        /generated or shared generated/
    );
});
