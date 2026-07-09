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

const {
    applyStartupConfigProviders,
    applyStartupConfigProvidersForGraph,
    buildProviderSubprocessEnv,
    collectStartupConfigProviderEntries,
    redactProviderValue,
} = providerModule;
const { readSecretsFile } = secretsModule;

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
        repoName: 'basic',
        shortAgentName: 'web-publishing',
        agentPath: tempDir,
        profileName: 'default',
        manifest: {
            providesConfig: {
                command: 'node runtime/provider.mjs',
                outputs: [
                    { name: 'ONLYOFFICE_PUBLIC_URL', sensitive: false },
                    { name: 'WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN', sensitive: true },
                ],
            },
            profiles: {
                default: {
                    env: [
                        'WEB_PUBLISHING_BASE_DOMAIN=example.test',
                        'PLOINKY_MASTER_KEY',
                    ],
                },
            },
        },
        profileConfig: {
            env: [
                'WEB_PUBLISHING_BASE_DOMAIN=example.test',
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
                    { agent: 'basic/web-publishing global', profile: 'default' },
                ],
            },
            qa: {
                configProviders: [
                    { agent: 'basic/web-publishing global', profile: 'qa' },
                ],
            },
        },
    };

    assert.deepEqual(
        collectStartupConfigProviderEntries(manifest, manifest.profiles.qa),
        [{ agent: 'basic/web-publishing global', profile: 'qa' }]
    );
});

test('buildProviderSubprocessEnv includes only allowlisted runtime and provider inputs', () => {
    const env = buildProviderSubprocessEnv({
        provider: providerDescriptor(),
        workspaceRoot: tempDir,
        profileName: 'qa',
    });

    assert.equal(env.PLOINKY_WORKSPACE_ROOT, tempDir);
    assert.equal(env.PLOINKY_PROFILE, 'qa');
    assert.equal(env.PLOINKY_PROVIDER_AGENT, 'basic/web-publishing');
    assert.equal(env.PLOINKY_PROVIDER_AGENT_ID, 'agent:basic/web-publishing');
    assert.equal(env.WEB_PUBLISHING_BASE_DOMAIN, 'example.test');
    assert.equal(env.PLOINKY_MASTER_KEY, undefined);
    assert.equal(env.PLOINKY_DERIVED_MASTER_KEY, undefined);
    assert.equal(env.PLOINKY_AGENT_SECRET, undefined);
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
                    name: 'ONLYOFFICE_PUBLIC_URL',
                    value: 'https://office.example.test',
                    sensitive: false,
                    source: 'generated',
                },
                {
                    name: 'WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN',
                    value: 'secret-token-value',
                    sensitive: true,
                    source: 'tunnel-token',
                },
            ],
            warnings: [],
        }),
    });

    assert.equal(result.applied.length, 2);
    assert.deepEqual(readSecretsFile(), {
        ONLYOFFICE_PUBLIC_URL: 'https://office.example.test',
        WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN: 'secret-token-value',
    });

    const metadataPath = path.join(tempDir, '.ploinky', 'config-providers', 'web-publishing.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    assert.equal(metadata.providerAgentId, 'agent:basic/web-publishing');
    assert.equal(metadata.outputs.length, 2);
    assert.doesNotMatch(JSON.stringify(metadata), /secret-token-value|https:\/\/office\.example\.test/);
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
                    { name: 'CLOUDFLARED_TUNNEL_TOKEN', value: 'legacy', sensitive: true },
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
                        name: 'WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN',
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
            protectedOutputNames: new Set(['ONLYOFFICE_PUBLIC_URL']),
            runProviderCommand: () => ({
                version: 1,
                values: [
                    {
                        name: 'ONLYOFFICE_PUBLIC_URL',
                        value: 'https://office.example.test',
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
    assert.equal(redactProviderValue('PUBLIC_URL', 'https://office.example.test', false), '[redacted]');
});

test('applyStartupConfigProvidersForGraph runs active profile providers from the dependency graph', async () => {
    writeRepoManifest('basic', 'web-publishing-graph', {
        providesConfig: {
            command: 'node runtime/provider.mjs',
            outputs: [
                { name: 'GRAPH_PROVIDER_PUBLIC_URL', sensitive: false },
            ],
        },
        profiles: {
            default: {
                env: [
                    'WEB_PUBLISHING_BASE_DOMAIN=graph.example.test',
                ],
            },
        },
    });
    writeRepoManifest('app', 'explorer-graph', {
        container: 'node:20-alpine',
        profiles: {
            default: {
                configProviders: [
                    { agent: 'basic/web-publishing-graph global', profile: 'default' },
                ],
            },
        },
        enable: [
            'basic/web-publishing-graph global',
        ],
    });

    const graphModule = await import(`../../cli/services/workspaceDependencyGraph.js${moduleSuffix}&graph=1`);
    const graph = graphModule.resolveWorkspaceDependencyGraph({
        staticAgentRef: 'app/explorer-graph',
    });
    const result = await applyStartupConfigProvidersForGraph({
        dependencyGraph: graph,
        workspaceRoot: tempDir,
        profileName: 'default',
        runProviderCommand: ({ env }) => {
            assert.equal(env.PLOINKY_PROVIDER_AGENT, 'basic/web-publishing-graph');
            assert.equal(env.WEB_PUBLISHING_BASE_DOMAIN, 'graph.example.test');
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
    writeRepoManifest('basic', 'generated-secret-provider', {
        providesConfig: {
            command: 'node runtime/provider.mjs',
            outputs: [
                { name: 'ONLYOFFICE_JWT_SECRET', sensitive: true },
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
                    { agent: 'basic/generated-secret-provider global', profile: 'default' },
                ],
            },
        },
        enable: [
            'basic/generated-secret-provider global',
        ],
        env: [
            {
                name: 'JWT_SECRET',
                varName: 'ONLYOFFICE_JWT_SECRET',
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
                        name: 'ONLYOFFICE_JWT_SECRET',
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
