import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    callsNamed,
    createWorkspaceCheckout,
    installFsCallCounter,
    installGitSpawnCounter,
    readsOf,
} from './agentLookupCostProbe.mjs';

// The SSO provider path (ensureProvider -> provider module + config reader)
// resolves the provider through the active route: one fresh read of that
// provider's manifest, under the route's hostPath, and no repository scan.
//
// The provider's repository AchillesIDE is registered with a URL and supplied
// by a workspace checkout under another folder name whose origin matches, so a
// repository-path lookup scans the workspace and spawns git. The route's
// hostPath is deliberately not that repository path, so the test also proves
// which manifest is read.

const originalCwd = process.cwd();
const originalEnv = {
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    FIXTURE_RUNTIME_SECRET: process.env.FIXTURE_RUNTIME_SECRET,
};
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-routed-'));
const ploinkyDir = path.join(workspace, '.ploinky');
const checkout = path.join(workspace, 'AssistOSExplorer');
const checkoutProviderDir = path.join(checkout, 'identity');
const routedProviderDir = path.join(ploinkyDir, 'repos', 'AchillesIDE', 'identity');
const routedManifestPath = path.join(routedProviderDir, 'manifest.json');
const checkoutManifestPath = path.join(checkoutProviderDir, 'manifest.json');

function providerManifest(secretSpec) {
    return {
        ssoProvider: true,
        profiles: { default: { env: { FIXTURE_RUNTIME_SECRET: secretSpec } } },
    };
}
function providerRuntime(label) {
    return `
export function resolveProviderConfig({ readValue }) {
    return { runtimeSecret: readValue('FIXTURE_RUNTIME_SECRET', 'fallback-value'), label: '${label}' };
}
export function createProvider({ getConfig }) {
    return { async sso_begin_login() {
        const config = await getConfig();
        return { authorizationUrl: 'https://identity.test/' + config.label, providerState: 'state-' + config.label };
    } };
}
`;
}
function writeProvider(dir, manifest, label) {
    fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'runtime', 'index.mjs'), providerRuntime(label));
}

createWorkspaceCheckout(checkout);
// The checkout's copy declares no shared secret; the routed copy declares one.
writeProvider(checkoutProviderDir, { ssoProvider: true, profiles: { default: { env: {} } } }, 'checkout');
writeProvider(routedProviderDir, providerManifest({ sharedGeneratedSecret: true }), 'routed');

fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
    routes: {
        identity: {
            repo: 'AchillesIDE',
            agent: 'identity',
            container: 'c-identity',
            hostPath: routedProviderDir,
            hostPort: 7501,
        },
    },
}));
fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
    _config: { sso: { enabled: true, providerAgent: 'AchillesIDE/identity' } },
    'c-identity': {
        type: 'agent',
        repoName: 'AchillesIDE',
        agentName: 'identity',
        profile: 'default',
        instanceId: 'identity-instance',
        enableGeneration: 'identity-enable',
        auth: { mode: 'none' },
    },
}));
fs.mkdirSync(path.join(ploinkyDir, 'data', 'edge-routing'), { recursive: true });
fs.mkdirSync(path.join(ploinkyDir, 'data', 'router-security'), { recursive: true });
fs.writeFileSync(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), JSON.stringify({ hosts: {} }));
fs.writeFileSync(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), JSON.stringify({
    schema: 'router-policy',
    httpRoutes: [],
    mcpTools: [],
}));
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
delete process.env.FIXTURE_RUNTIME_SECRET;

const gitSpawns = installGitSpawnCounter(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-routed-git-')));
const fsCounter = installFsCallCounter();

const { applyEdgeRoutingGeneration } = await import('../../cli/sandbox/edgeGeneration.js');
const { resolveAgentRepositoryPath } = await import('../../cli/utils/agentRepositorySource.mjs');
const { buildEnvMap } = await import('../../cli/utils/security/secretVars.js');
const { resolveManifestRuntimeProfile } = await import('../../cli/utils/runtime/profileService.js');
const { createProviderConfigReader } = await import('../../cli/server/auth/providerConfigValues.js');
const { createGenericAuthBridge } = await import('../../cli/server/auth/genericAuthBridge.js');
applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'provider-routed-test-fixture' });

test.after(() => {
    gitSpawns.restore();
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

function expectedSharedSecret() {
    const manifest = JSON.parse(fs.readFileSync(routedManifestPath, 'utf8'));
    const { profileConfig } = resolveManifestRuntimeProfile(manifest, { persistedProfileName: 'default' });
    return buildEnvMap(manifest, profileConfig, {
        repoName: 'AchillesIDE', agentName: 'identity', forRuntime: true,
    }).FIXTURE_RUNTIME_SECRET;
}

function measured(fn) {
    const spawnsBefore = gitSpawns.count();
    const result = fsCounter.measure(fn);
    return { ...result, spawns: gitSpawns.count() - spawnsBefore };
}

test('T6: the config reader reads the routed provider manifest once, with no scan', () => {
    // Fixture validity: a repository-path lookup would scan, spawn git and
    // name the checkout, which is not the route's hostPath.
    const before = gitSpawns.count();
    assert.equal(resolveAgentRepositoryPath('AchillesIDE'), checkout);
    assert.ok(gitSpawns.count() - before > 0, 'the repository-path lookup spawns git');
    assert.notEqual(path.join(resolveAgentRepositoryPath('AchillesIDE'), 'identity'), routedProviderDir);

    const { result: readValue, error, calls, spawns } = measured(
        () => createProviderConfigReader('AchillesIDE/identity', () => 'explicit-fallback'));
    assert.equal(error, null);
    assert.equal(spawns, 0);
    assert.equal(callsNamed(calls, 'readdirSync'), 0);
    assert.equal(readsOf(calls, routedManifestPath), 1, 'exactly one read of the routed manifest');
    assert.equal(readsOf(calls, checkoutManifestPath), 0, 'the repository-path manifest is never read');
    const secret = readValue('FIXTURE_RUNTIME_SECRET');
    assert.ok(secret.length >= 32);
    assert.equal(secret, expectedSharedSecret());
});

test('T6: an edit of the provider manifest env specs is visible on the next reader', () => {
    assert.ok(createProviderConfigReader('AchillesIDE/identity', () => 'explicit-fallback')('FIXTURE_RUNTIME_SECRET').length >= 32);
    // Mark the shared secret runtime:false: it must no longer reach the Router.
    fs.writeFileSync(routedManifestPath, JSON.stringify(providerManifest({ sharedGeneratedSecret: true, runtime: false })));
    const { result: readValue, calls, spawns } = measured(
        () => createProviderConfigReader('AchillesIDE/identity', (names, fallback) => fallback));
    assert.equal(spawns, 0);
    assert.equal(readsOf(calls, routedManifestPath), 1);
    assert.equal(readValue('FIXTURE_RUNTIME_SECRET', 'caller-fallback'), 'caller-fallback');
    // And back.
    fs.writeFileSync(routedManifestPath, JSON.stringify(providerManifest({ sharedGeneratedSecret: true })));
    assert.equal(createProviderConfigReader('AchillesIDE/identity', () => 'x')('FIXTURE_RUNTIME_SECRET'), expectedSharedSecret());
});

test('T6: ensureProvider (beginLogin) uses the routed provider with no scan', async () => {
    const bridge = createGenericAuthBridge();
    const spawnsBefore = gitSpawns.count();
    const { result, error, calls } = await fsCounter.measureAsync(
        () => bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' }));
    assert.equal(error, null);
    assert.equal(gitSpawns.count() - spawnsBefore, 0);
    assert.equal(callsNamed(calls, 'readdirSync'), 0);
    assert.match(result.redirectUrl, /^https:\/\/identity\.test\/routed/, 'the routed provider module ran');
    // The bridge reads the manifest through its validated memo: open, then
    // fstat and read the handle. Either way only the routed manifest is used.
    const opensOf = (file) => calls.filter((call) => call.name === 'openSync' && path.resolve(call.target) === path.resolve(file)).length;
    assert.ok(readsOf(calls, routedManifestPath) + opensOf(routedManifestPath) >= 1);
    assert.equal(readsOf(calls, checkoutManifestPath) + opensOf(checkoutManifestPath), 0);
});
