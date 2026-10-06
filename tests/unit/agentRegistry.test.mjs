import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agents-'));

function writeManifest(repoName, agentName, manifest) {
    const agentDir = path.join(tempDir, '.ploinky', 'repos', repoName, agentName);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
        path.join(agentDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
    );
}

const originalWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = tempDir;
process.chdir(tempDir);

const moduleSuffix = `?test=${Date.now()}`;
const registryModule = await import(`../../cli/utils/agentRegistry.js${moduleSuffix}`);
const {
    buildAgentIndex,
    listSsoProviders,
    resolveAgentDescriptor,
    getAgentDescriptorByPrincipal,
    isSsoProviderManifest,
    canonicalJsonHash,
    __internal,
} = registryModule;

test.after(() => {
    process.chdir(originalCwd);
    if (originalWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalWorkspaceRoot;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('buildAgentIndex surfaces installed agents, runtime resources, principals, and SSO markers', () => {
    writeManifest('dpu', 'dpuAgent', {
        runtime: {
            resources: {
                persistentStorage: { key: 'dpu-data', containerPath: '/dpu-data' },
            },
        },
    });
    writeManifest('basic', 'keycloak', {
        ssoProvider: true,
    });

    const index = buildAgentIndex();
    assert.ok(index.agents.has('dpu/dpuAgent'));
    assert.ok(index.agents.has('basic/keycloak'));
    assert.equal(index.byPrincipal.get('agent:dpu/dpuAgent').agent, 'dpuAgent');
    assert.equal(index.agents.get('dpu/dpuAgent').runtimeResources.persistentStorage.key, 'dpu-data');
    assert.deepEqual(index.ssoProviders.map((d) => d.agentRef), ['basic/keycloak']);
});

test('resolveAgentDescriptor finds by full ref or short name', () => {
    const fullDescriptor = resolveAgentDescriptor('dpu/dpuAgent');
    assert.equal(fullDescriptor.agentRef, 'dpu/dpuAgent');
    const principalDescriptor = getAgentDescriptorByPrincipal('agent:basic/keycloak');
    assert.equal(principalDescriptor.agentRef, 'basic/keycloak');
});

test('listSsoProviders returns only agents marked with ssoProvider true', () => {
    const providers = listSsoProviders();
    assert.deepEqual(providers.map((provider) => provider.agentRef), ['basic/keycloak']);
});

test('isSsoProviderManifest requires explicit true', () => {
    assert.equal(isSsoProviderManifest({ ssoProvider: true }), true);
    assert.equal(isSsoProviderManifest({ ssoProvider: false }), false);
    assert.equal(isSsoProviderManifest({ ssoProvider: 'true' }), false);
});

test('agent registry does not expose DS008 agent public-key storage', () => {
    assert.equal(Object.hasOwn(registryModule, 'registerAgentPublicKey'), false);
    assert.equal(Object.hasOwn(registryModule, 'getRegisteredAgentPublicKey'), false);
});

test('canonicalJsonHash is stable across key order', () => {
    const a = canonicalJsonHash({ tool: 'secret_get', input: { key: 'A', ttl: 60 } });
    const b = canonicalJsonHash({ input: { ttl: 60, key: 'A' }, tool: 'secret_get' });
    assert.equal(a, b);
});

test('buildAgentIndex skips entries whose names fail agentIdentity validation', () => {
    writeManifest('gitTest', 'folder J', { about: 'stray manifest in a non-agent folder' });
    writeManifest('gitTest', 'good agent', { about: 'agent name with whitespace' });

    let index;
    assert.doesNotThrow(() => { index = buildAgentIndex(); });

    assert.equal(index.agents.has('gitTest/folder J'), false);
    assert.equal(index.agents.has('gitTest/good agent'), false);
    assert.ok(index.agents.has('dpu/dpuAgent'));
    assert.ok(index.agents.has('basic/keycloak'));
});

test('a manifest edit or addition is visible on the immediately following call', () => {
    writeManifest('fresh', 'baseline', { about: 'present before the first call' });
    assert.equal(getAgentDescriptorByPrincipal('agent:fresh/baseline')?.agentRef, 'fresh/baseline');
    assert.equal(buildAgentIndex().agents.has('fresh/lateSso'), false);
    assert.equal(getAgentDescriptorByPrincipal('agent:fresh/lateSso'), null);

    // Addition: no clock movement and no cache reset between write and read.
    writeManifest('fresh', 'lateSso', { ssoProvider: true });
    assert.equal(getAgentDescriptorByPrincipal('agent:fresh/lateSso')?.agentRef, 'fresh/lateSso');
    assert.equal(resolveAgentDescriptor('fresh/lateSso')?.ssoProvider, true);
    assert.equal(listSsoProviders().some((d) => d.agentRef === 'fresh/lateSso'), true);
    assert.equal(buildAgentIndex().agents.has('fresh/lateSso'), true);

    // Edit: the SSO marker flips on the very next call of every accessor.
    writeManifest('fresh', 'lateSso', { ssoProvider: false });
    assert.equal(getAgentDescriptorByPrincipal('agent:fresh/lateSso')?.ssoProvider, false);
    assert.equal(resolveAgentDescriptor('fresh/lateSso')?.ssoProvider, false);
    assert.equal(listSsoProviders().some((d) => d.agentRef === 'fresh/lateSso'), false);
    assert.equal(buildAgentIndex().agents.get('fresh/lateSso')?.ssoProvider, false);
});

test('agent registry keeps no cross-request index state', () => {
    assert.equal(Object.hasOwn(__internal, 'clearAgentIndexMemo'), false);
    assert.equal(Object.hasOwn(__internal, 'AGENT_INDEX_TTL_MS'), false);
    assert.notEqual(buildAgentIndex(), buildAgentIndex(), 'each call scans afresh');
});
