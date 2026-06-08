import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Run inside a throwaway cwd with an explicit master key so derivation is
// deterministic and no real workspace/.env leaks in.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-envinject-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = 'a1b2c3d4'.repeat(8);

const moduleSuffix = `?test=${Date.now()}`;
const { buildFullEnvMap } = await import(`../../cli/services/bwrap/bwrapServiceManager.js${moduleSuffix}`);
const { deriveAgentRequestSecret, deriveDerivedMasterKey } = await import(`../../cli/services/masterKey.js${moduleSuffix}`);
const { deriveAgentPrincipalId } = await import(`../../cli/services/agentIdentity.js${moduleSuffix}`);
// The single identity injector that docker, bwrap, and lifecycle all route through.
const { buildAgentIdentityEnv, stripReservedAgentEnv } = await import(`../../cli/services/agentIdentityEnv.js${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function envForAgent(repoName, agentName) {
    const workDir = path.join(tempDir, 'work', agentName);
    fs.mkdirSync(workDir, { recursive: true });
    return buildFullEnvMap(agentName, {}, {}, workDir, repoName, 'dev');
}

test('injected env carries PLOINKY_AGENT_ID + PLOINKY_AGENT_SECRET = the canonical per-agent values', () => {
    const env = envForAgent('AssistOSExplorer', 'dpuAgent');
    const principal = deriveAgentPrincipalId('AssistOSExplorer', 'dpuAgent');
    assert.equal(env.PLOINKY_AGENT_ID, principal);
    assert.equal(env.PLOINKY_AGENT_ID, 'agent:AssistOSExplorer/dpuAgent');
    assert.equal(env.PLOINKY_AGENT_SECRET, deriveAgentRequestSecret(principal));
    assert.match(env.PLOINKY_AGENT_SECRET, /^[0-9a-f]{64}$/);
});

test('two different agents receive DIFFERENT per-agent secrets', () => {
    const a = envForAgent('AssistOSExplorer', 'dpuAgent');
    const b = envForAgent('AssistOSExplorer', 'gitAgent');
    assert.notEqual(a.PLOINKY_AGENT_SECRET, b.PLOINKY_AGENT_SECRET);
    assert.notEqual(a.PLOINKY_AGENT_ID, b.PLOINKY_AGENT_ID);
});

test('the shared derived-master key is NEVER injected anymore', () => {
    const env = envForAgent('AssistOSExplorer', 'dpuAgent');
    assert.equal(env.PLOINKY_DERIVED_MASTER_KEY, undefined);
    // And the agent secret is not the old shared value either.
    assert.notEqual(env.PLOINKY_AGENT_SECRET, deriveDerivedMasterKey().toString('hex'));
});

test('the workspace master key is NEVER injected into an agent', () => {
    const env = envForAgent('AssistOSExplorer', 'dpuAgent');
    assert.equal(env.PLOINKY_MASTER_KEY, undefined);
});

test('buildAgentIdentityEnv is the single shared injector (docker, bwrap, lifecycle)', () => {
    const principal = deriveAgentPrincipalId('AssistOSExplorer', 'dpuAgent');
    const idEnv = buildAgentIdentityEnv(principal);
    // Exactly the three identity keys — no master / derived-master ever leaks.
    assert.deepEqual(Object.keys(idEnv).sort(), ['PLOINKY_AGENT_ID', 'PLOINKY_AGENT_PRINCIPAL', 'PLOINKY_AGENT_SECRET']);
    assert.equal(idEnv.PLOINKY_AGENT_ID, principal);
    assert.equal(idEnv.PLOINKY_AGENT_PRINCIPAL, principal);
    assert.equal(idEnv.PLOINKY_AGENT_SECRET, deriveAgentRequestSecret(principal));
    assert.match(idEnv.PLOINKY_AGENT_SECRET, /^[0-9a-f]{64}$/);
    assert.notEqual(idEnv.PLOINKY_AGENT_SECRET, deriveDerivedMasterKey().toString('hex'));
});

test('buildAgentIdentityEnv fails closed without a principal id', () => {
    assert.throws(() => buildAgentIdentityEnv(''), /principalId is required/);
    assert.throws(() => buildAgentIdentityEnv(null), /principalId is required/);
});

test('stripReservedAgentEnv drops master + identity names, keeps the rest', () => {
    const env = {
        FOO: 'keep', BAR: 'also-keep',
        PLOINKY_MASTER_KEY: 'x', PLOINKY_DERIVED_MASTER_KEY: 'y',
        PLOINKY_AGENT_ID: 'z', PLOINKY_AGENT_PRINCIPAL: 'p', PLOINKY_AGENT_SECRET: 's',
    };
    stripReservedAgentEnv(env);
    assert.deepEqual(Object.keys(env).sort(), ['BAR', 'FOO']);
});

test('profile config cannot inject a master key or override the agent secret (bwrap)', () => {
    const workDir = path.join(tempDir, 'work', 'hardened');
    fs.mkdirSync(workDir, { recursive: true });
    const principal = deriveAgentPrincipalId('AssistOSExplorer', 'dpuAgent');
    // A profile that maliciously tries to leak the master and override the secret.
    const env = buildFullEnvMap('dpuAgent', {}, {
        env: { PLOINKY_MASTER_KEY: 'leak', PLOINKY_AGENT_SECRET: 'override', SAFE: 'ok' },
    }, workDir, 'AssistOSExplorer', 'dev');
    assert.equal(env.SAFE, 'ok');                              // ordinary env survives
    assert.equal(env.PLOINKY_MASTER_KEY, undefined);          // master never injected
    assert.equal(env.PLOINKY_DERIVED_MASTER_KEY, undefined);
    assert.equal(env.PLOINKY_AGENT_SECRET, deriveAgentRequestSecret(principal)); // authoritative wins
});

test('the bwrap full env map matches the shared identity injector exactly', () => {
    // Docker and lifecycle build identity env through the same helper, so proving
    // bwrap's full env map equals buildAgentIdentityEnv covers all three paths.
    const env = envForAgent('AssistOSExplorer', 'gitAgent');
    const idEnv = buildAgentIdentityEnv(deriveAgentPrincipalId('AssistOSExplorer', 'gitAgent'));
    assert.equal(env.PLOINKY_AGENT_ID, idEnv.PLOINKY_AGENT_ID);
    assert.equal(env.PLOINKY_AGENT_PRINCIPAL, idEnv.PLOINKY_AGENT_PRINCIPAL);
    assert.equal(env.PLOINKY_AGENT_SECRET, idEnv.PLOINKY_AGENT_SECRET);
});
