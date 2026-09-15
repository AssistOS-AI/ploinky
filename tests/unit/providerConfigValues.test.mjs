import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-config-'));
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '3'.repeat(64);
const providerDir = path.join(workspace, '.ploinky', 'repos', 'fixture', 'identity');
fs.mkdirSync(path.join(providerDir, 'runtime'), { recursive: true });
const manifest = {
    ssoProvider: true,
    profiles: {
        default: { env: {
            FIXTURE_RUNTIME_SECRET: { sharedGeneratedSecret: true },
            FIXTURE_LIFECYCLE_SECRET: { sharedGeneratedSecret: true, runtime: false },
            FIXTURE_AGENT_PRIVATE_KEY: { generatedSecret: true },
        } },
        alternative: { env: { FIXTURE_RUNTIME_SECRET: { sharedGeneratedSecret: true, varName: 'PROFILE_SECRET' } } },
        explicit: { env: { FIXTURE_RUNTIME_SECRET: { sharedGeneratedSecret: true, explicitOverride: true } } },
    },
};
fs.writeFileSync(path.join(providerDir, 'manifest.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(providerDir, 'runtime', 'index.mjs'), `
export function resolveProviderConfig({ readValue }) {
    return { runtimeSecret: readValue('FIXTURE_RUNTIME_SECRET') };
}
export function createProvider({ getConfig }) {
    return { async sso_begin_login() {
        const config = await getConfig();
        if (config.runtimeSecret !== globalThis.__expectedProviderSecret) throw new Error('provider secret mismatch');
        return { authorizationUrl: 'https://identity.test/login', providerState: 'fixture-state' };
    } };
}
`);
const { buildEnvMap } = await import('../../cli/utils/security/secretVars.js');
const { resolveManifestRuntimeProfile } = await import('../../cli/utils/runtime/profileService.js');
const { createProviderConfigReader } = await import('../../cli/server/auth/providerConfigValues.js');
const { createGenericAuthBridge } = await import('../../cli/server/auth/genericAuthBridge.js');
function setProfile(profile = 'default') {
    fs.writeFileSync(path.join(workspace, '.ploinky', 'agents.json'), JSON.stringify({
        _config: { sso: { enabled: true, providerAgent: 'fixture/identity' } },
        identity: { type: 'agent', repoName: 'fixture', agentName: 'identity', profile },
    }));
}
function serviceEnv(profile) {
    const { profileConfig } = resolveManifestRuntimeProfile(manifest, { persistedProfileName: profile });
    return buildEnvMap(manifest, profileConfig, { repoName: 'fixture', agentName: 'identity', forRuntime: true });
}
test.after(() => {
    process.chdir(originalCwd);
    if (originalMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = originalMasterKey;
    delete process.env.FIXTURE_RUNTIME_SECRET;
    delete globalThis.__expectedProviderSecret;
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('Router and service resolve the same generated secret without stored or exported values', async () => {
    delete process.env.FIXTURE_RUNTIME_SECRET;
    setProfile();
    const expected = serviceEnv('default').FIXTURE_RUNTIME_SECRET;
    assert.ok(expected.length >= 32);
    const readValue = createProviderConfigReader('fixture/identity', () => 'fallback');
    assert.equal(readValue('FIXTURE_RUNTIME_SECRET'), expected);
    assert.equal(readValue('FIXTURE_AGENT_PRIVATE_KEY'), 'fallback', 'private generated agent keys are not exposed');
    globalThis.__expectedProviderSecret = expected;
    const bridge = createGenericAuthBridge();
    const result = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' });
    assert.match(result.redirectUrl, /^https:\/\/identity\.test\/login/);
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky', '.secrets')), false);
});

test('shared secret resolution follows persisted profile and explicit-override policy', () => {
    process.env.FIXTURE_RUNTIME_SECRET = 'deliberate-fixture-override';
    for (const profile of ['default', 'alternative', 'explicit']) {
        setProfile(profile);
        const readValue = createProviderConfigReader('fixture/identity', () => 'fallback');
        assert.equal(readValue('FIXTURE_RUNTIME_SECRET'), serviceEnv(profile).FIXTURE_RUNTIME_SECRET);
    }
    assert.equal(serviceEnv('explicit').FIXTURE_RUNTIME_SECRET, 'deliberate-fixture-override');
    assert.notEqual(serviceEnv('default').FIXTURE_RUNTIME_SECRET, 'deliberate-fixture-override');
    assert.notEqual(serviceEnv('default').FIXTURE_RUNTIME_SECRET, serviceEnv('alternative').FIXTURE_RUNTIME_SECRET);
});

test('provider values honor runtime exclusions and ordered aliases', () => {
    setProfile();
    const configured = {
        EXPLICIT_PRIMARY: 'configured-first-choice',
        FIXTURE_LIFECYCLE_SECRET: 'must-stay-outside-runtime',
    };
    const consulted = [];
    const readValue = createProviderConfigReader('fixture/identity', (names, fallback) => {
        for (const name of [].concat(names)) {
            consulted.push(name);
            if (configured[name]) return configured[name];
        }
        return fallback;
    });
    assert.equal(serviceEnv('default').FIXTURE_LIFECYCLE_SECRET, undefined);
    assert.equal(readValue('FIXTURE_LIFECYCLE_SECRET', 'fallback'), 'fallback');
    assert.equal(consulted.includes('FIXTURE_LIFECYCLE_SECRET'), false);
    assert.equal(readValue(['EXPLICIT_PRIMARY', 'FIXTURE_RUNTIME_SECRET']), 'configured-first-choice');
    assert.equal(readValue(['FIXTURE_RUNTIME_SECRET', 'EXPLICIT_PRIMARY']), serviceEnv('default').FIXTURE_RUNTIME_SECRET);
    assert.equal(readValue(['MISSING', 'FIXTURE_RUNTIME_SECRET']), serviceEnv('default').FIXTURE_RUNTIME_SECRET);
    assert.equal(readValue(['FIXTURE_LIFECYCLE_SECRET', 'EXPLICIT_PRIMARY']), 'configured-first-choice');
    assert.equal(readValue(['MISSING', 'ALSO_MISSING'], 'last-resort'), 'last-resort');
});
