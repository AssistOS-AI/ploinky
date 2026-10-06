import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agents-'));

function writeManifest(repoName, agentName, manifest, { clearMemo = true } = {}) {
    // The agent index is memoized; fixtures that expect to see their own writes
    // clear it. The memo tests below pass clearMemo: false to observe it.
    if (clearMemo) registryModule?.__internal?.clearAgentIndexMemo();
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

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function writeActiveSelector(generationChar) {
    const body = {
        schemaVersion: 1,
        state: 'active',
        generation: `sha256:${generationChar.repeat(64)}`,
        publicationState: 'published',
        activationId: `activation-${generationChar}`,
        activatedAt: '2026-10-06T00:00:00.000Z',
    };
    const selectorDigest = `sha256:${crypto.createHash('sha256')
        .update(Buffer.from(JSON.stringify(stable(body)))).digest('hex')}`;
    const edgeDir = path.join(tempDir, '.ploinky', 'data', 'edge-routing');
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.writeFileSync(path.join(edgeDir, 'active.json'), JSON.stringify({ ...body, selectorDigest }));
}

test('agent index memo bounds staleness to its TTL for principal lookup and SSO providers', (t) => {
    writeActiveSelector('a');
    writeManifest('memo', 'baseline', { about: 'seeds the memo' });
    const realNow = Date.now();
    let now = realNow;
    t.mock.method(Date, 'now', () => now);

    const first = buildAgentIndex();
    assert.equal(buildAgentIndex(), first, 'second call inside the TTL reuses the index');

    writeManifest('memo', 'lateSso', { ssoProvider: true }, { clearMemo: false });
    assert.equal(getAgentDescriptorByPrincipal('agent:memo/lateSso'), null, 'in-place add stays hidden inside the TTL');
    assert.equal(listSsoProviders().some((d) => d.agentRef === 'memo/lateSso'), false);

    now = realNow + __internal.AGENT_INDEX_TTL_MS - 1;
    assert.equal(getAgentDescriptorByPrincipal('agent:memo/lateSso'), null, 'still hidden 1 ms before the TTL');

    now = realNow + __internal.AGENT_INDEX_TTL_MS;
    assert.equal(getAgentDescriptorByPrincipal('agent:memo/lateSso')?.agentRef, 'memo/lateSso');
    assert.equal(listSsoProviders().some((d) => d.agentRef === 'memo/lateSso'), true);
});

test('a change of the active generation clears the agent index memo before the TTL', (t) => {
    writeActiveSelector('b');
    writeManifest('memo', 'seed', { about: 'seeds the memo' });
    t.mock.method(Date, 'now', () => 1_000_000);

    const first = buildAgentIndex();
    writeManifest('memo', 'afterGeneration', { ssoProvider: true }, { clearMemo: false });
    assert.equal(getAgentDescriptorByPrincipal('agent:memo/afterGeneration'), null);
    assert.equal(buildAgentIndex(), first);

    writeActiveSelector('c');
    assert.equal(getAgentDescriptorByPrincipal('agent:memo/afterGeneration')?.agentRef, 'memo/afterGeneration');
    assert.equal(listSsoProviders().some((d) => d.agentRef === 'memo/afterGeneration'), true);
    assert.notEqual(buildAgentIndex(), first);
});
