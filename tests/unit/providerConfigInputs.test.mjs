import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The SSO bridge's memo of configuration inputs: every hit revalidates the
// file stamp and the master-seed identity, failures are never memoized, and
// the provider's own configuration code and the process environment are read
// live on every resolution.
const originalCwd = process.cwd();
const originalEnv = {
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    FIXTURE_LIVE_VALUE: process.env.FIXTURE_LIVE_VALUE,
};
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-config-inputs-'));
const ploinkyDir = path.join(workspace, '.ploinky');
const dataDir = path.join(ploinkyDir, 'data');
const providerDir = path.join(ploinkyDir, 'repos', 'fixture', 'identity');
fs.mkdirSync(path.join(providerDir, 'runtime'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = SEED_A;
delete process.env.FIXTURE_LIVE_VALUE;

fs.writeFileSync(path.join(providerDir, 'manifest.json'), JSON.stringify({
    ssoProvider: true,
    profiles: { default: { env: { FIXTURE_SHARED_SECRET: { sharedGeneratedSecret: true } } } },
}));
fs.writeFileSync(path.join(providerDir, 'runtime', 'index.mjs'), `
export function resolveProviderConfig({ readValue }) {
    return {
        explicit: readValue('FIXTURE_EXPLICIT_SECRET'),
        live: readValue('FIXTURE_LIVE_VALUE', 'unset'),
        shared: readValue('FIXTURE_SHARED_SECRET'),
    };
}
export function createProvider({ getConfig }) {
    return {
        async sso_begin_login() {
            const config = await getConfig();
            globalThis.__configInputsSeen = config;
            return { authorizationUrl: 'https://identity.test/login', providerState: 'fixture' };
        },
        async sso_handle_callback() {
            return { user: { id: 'u1', roles: ['admin'] }, providerSession: { expiresAt: Date.now() + 60_000 } };
        },
        async sso_refresh_session({ providerSession }) {
            return globalThis.__configInputsValidation(providerSession);
        },
        async sso_logout() { return {}; },
    };
}
`);
fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
    _config: { sso: { enabled: true, providerAgent: 'fixture/identity' } },
    identity: { type: 'agent', repoName: 'fixture', agentName: 'identity', profile: 'default' },
}));

const { createProviderConfigInputs } = await import('../../cli/server/auth/providerConfigInputs.js');
const { createGenericAuthBridge } = await import('../../cli/server/auth/genericAuthBridge.js');
const { setEnvVar, parseSecrets } = await import('../../cli/utils/security/secretVars.js');
const { deriveSubkey, deriveSubkeyFromSeed, deriveWorkspaceSecret } = await import('../../cli/utils/security/masterKey.js');
const { SECRETS_FILE } = await import('../../cli/utils/config.js');

test.after(() => {
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    delete globalThis.__configInputsSeen;
    delete globalThis.__configInputsValidation;
    fs.rmSync(workspace, { recursive: true, force: true });
});

// The .secrets envelope (encryptedSecretsFile.js): base64(iv | tag | AES-256-GCM).
function packSecrets(seed, secrets) {
    const key = deriveSubkeyFromSeed(seed, 'storage/secrets');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify({ version: 1, secrets }), 'utf8'), cipher.final()]);
    return `${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}\n`;
}

// A whole-second timestamp utimes can restore exactly.
const FIXED_TIME = new Date(1_700_000_000_000);

// Writes `text` with the fixed mtime, as the state a reader then memoizes.
function writePinned(file, text) {
    fs.writeFileSync(file, text);
    fs.utimesSync(file, FIXED_TIME, FIXED_TIME);
}

// Same inode, same size, same mtime as the pinned state: only ctimeNs reveals
// the rewrite.
function rewriteKeepingSizeAndMtime(file, text) {
    const before = fs.statSync(file, { bigint: true });
    assert.equal(before.mtimeNs, BigInt(FIXED_TIME.getTime()) * 1_000_000n, 'the memoized state is pinned');
    assert.equal(Buffer.byteLength(text), Number(before.size), 'fixture keeps the size');
    fs.writeFileSync(file, text);
    fs.utimesSync(file, FIXED_TIME, FIXED_TIME);
    const after = fs.statSync(file, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs, 'fixture restores mtime');
}

// A new inode with the same size and mtime: rename-replace.
function renameReplaceKeepingSizeAndMtime(file, text) {
    const before = fs.statSync(file, { bigint: true });
    assert.equal(before.mtimeNs, BigInt(FIXED_TIME.getTime()) * 1_000_000n, 'the memoized state is pinned');
    const temporary = `${file}.replace.tmp`;
    fs.writeFileSync(temporary, text);
    fs.utimesSync(temporary, FIXED_TIME, FIXED_TIME);
    fs.renameSync(temporary, file);
    const after = fs.statSync(file, { bigint: true });
    assert.notEqual(after.ino, before.ino, 'fixture replaced the inode');
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
}

test('JSON inputs: every hit sees same-size, ctime-only and rename-replace changes', () => {
    const inputs = createProviderConfigInputs();
    const file = path.join(workspace, 'doc.json');
    writePinned(file, JSON.stringify({ value: 'aaaa' }));
    const first = inputs.readJson(file);
    assert.deepEqual(first, { value: 'aaaa' });
    assert.ok(Object.isFrozen(first));
    assert.equal(inputs.readJson(file), first, 'an unchanged file is a hit');
    assert.equal(inputs.stats().jsonHits, 1);

    rewriteKeepingSizeAndMtime(file, JSON.stringify({ value: 'bbbb' }));
    assert.deepEqual(inputs.readJson(file), { value: 'bbbb' }, 'ctime alone invalidates');
    fs.utimesSync(file, FIXED_TIME, FIXED_TIME);
    assert.deepEqual(inputs.readJson(file), { value: 'bbbb' });

    renameReplaceKeepingSizeAndMtime(file, JSON.stringify({ value: 'cccc' }));
    assert.deepEqual(inputs.readJson(file), { value: 'cccc' }, 'a new inode invalidates');

    fs.writeFileSync(file, JSON.stringify({ value: 'dddd' }));
    assert.deepEqual(inputs.readJson(file), { value: 'dddd' });
});

test('JSON inputs: missing and corrupt files fail every time and are never memoized', () => {
    const inputs = createProviderConfigInputs();
    const file = path.join(workspace, 'flaky.json');
    writePinned(file, JSON.stringify({ value: 'good' }));
    assert.deepEqual(inputs.readJson(file), { value: 'good' });
    rewriteKeepingSizeAndMtime(file, '{"value":"g'.padEnd(16, ' '));
    assert.throws(() => inputs.readJson(file), SyntaxError);
    assert.throws(() => inputs.readJson(file), SyntaxError, 'a parse failure is not cached');
    fs.writeFileSync(file, JSON.stringify({ value: 'fixed' }));
    assert.deepEqual(inputs.readJson(file), { value: 'fixed' });
    fs.rmSync(file);
    assert.throws(() => inputs.readJson(file), { code: 'ENOENT' });
    assert.throws(() => inputs.readJson(file), { code: 'ENOENT' });
    fs.writeFileSync(file, JSON.stringify({ value: 'back' }));
    assert.deepEqual(inputs.readJson(file), { value: 'back' });
});

test('the seed-derived subkey equals the subkey the rest of Ploinky derives', () => {
    assert.deepEqual(deriveSubkeyFromSeed(SEED_A, 'storage/secrets'), deriveSubkey('storage/secrets'));
    assert.equal(
        deriveWorkspaceSecret({ name: 'FIXTURE', derivedMasterSecret: deriveSubkeyFromSeed(SEED_A, 'derived-master') }),
        deriveWorkspaceSecret({ name: 'FIXTURE' }),
    );
});

test('secrets: hits revalidate the file stamp and the master-seed identity on every read', () => {
    const file = path.join(workspace, 'unit.secrets');
    let seed = SEED_A;
    const inputs = createProviderConfigInputs({ secretsFile: file, resolveSeed: () => seed });
    writePinned(file, packSecrets(SEED_A, { NAME: 'value-1' }));
    const first = inputs.readSecrets();
    assert.deepEqual(first, { NAME: 'value-1' });
    assert.equal(inputs.readSecrets(), first, 'an unchanged file under the same seed is a hit');
    assert.equal(inputs.stats().secretsHits, 1);

    // Same ciphertext length: same-size rewrite with mtime restored.
    rewriteKeepingSizeAndMtime(file, packSecrets(SEED_A, { NAME: 'value-2' }));
    assert.deepEqual(inputs.readSecrets(), { NAME: 'value-2' }, 'ctime alone invalidates');
    fs.utimesSync(file, FIXED_TIME, FIXED_TIME);
    assert.deepEqual(inputs.readSecrets(), { NAME: 'value-2' });
    renameReplaceKeepingSizeAndMtime(file, packSecrets(SEED_A, { NAME: 'value-3' }));
    assert.deepEqual(inputs.readSecrets(), { NAME: 'value-3' }, 'a new inode invalidates');

    // A different master seed never sees the map decrypted under the old one.
    seed = SEED_B;
    assert.throws(() => inputs.readSecrets(), /Unable to decrypt \.ploinky\/data\/\.secrets/);
    assert.throws(() => inputs.readSecrets(), /Unable to decrypt/, 'a decryption failure is not cached');
    seed = SEED_A;
    assert.deepEqual(inputs.readSecrets(), { NAME: 'value-3' }, 'restoring the seed recovers');

    // A seed resolution failure is a decryption failure, as in readSecretsFile().
    const failing = createProviderConfigInputs({ secretsFile: file, resolveSeed: () => { throw new Error('retired secret present'); } });
    assert.throws(() => failing.readSecrets(), /Unable to decrypt .*retired secret present/);

    fs.rmSync(file);
    assert.deepEqual(inputs.readSecrets(), {}, 'a missing file reads as empty, like readSecretsFile()');
    assert.equal(inputs.stats().secretsEntry, false, 'and is not memoized');
});

test('secrets: the real master-seed precedence is re-resolved on every hit', () => {
    const inputs = createProviderConfigInputs();
    setEnvVar('FIXTURE_UNIT_SECRET', 'from-secrets');
    assert.equal(inputs.readSecrets().FIXTURE_UNIT_SECRET, 'from-secrets');
    assert.equal(inputs.readSecrets().FIXTURE_UNIT_SECRET, 'from-secrets');
    process.env.PLOINKY_MASTER_KEY = SEED_B;
    try {
        assert.throws(() => inputs.readSecrets(), /Unable to decrypt/, 'an environment key change is seen at once');
    } finally {
        process.env.PLOINKY_MASTER_KEY = SEED_A;
    }
    assert.equal(inputs.readSecrets().FIXTURE_UNIT_SECRET, 'from-secrets');
    assert.deepEqual({ ...inputs.readSecrets() }, parseSecrets(), 'the memo equals a fresh decryption');
});

function freshBridge() {
    const configInputs = createProviderConfigInputs();
    return { bridge: createGenericAuthBridge({ configInputs }), configInputs };
}

async function resolvedConfig(bridge) {
    await bridge.beginLogin({ baseUrl: 'http://localhost:8080' });
    return globalThis.__configInputsSeen;
}

test('bridge: secrets, environment and master key changes are visible on the next resolution', async () => {
    const { bridge, configInputs } = freshBridge();
    setEnvVar('FIXTURE_EXPLICIT_SECRET', 'explicit-1');
    const first = await resolvedConfig(bridge);
    assert.equal(first.explicit, 'explicit-1');
    assert.equal(first.live, 'unset');
    assert.equal(first.shared, deriveWorkspaceSecret({ name: 'FIXTURE_SHARED_SECRET' }));
    await resolvedConfig(bridge);
    assert.ok(configInputs.stats().secretsHits > 0 && configInputs.stats().jsonHits > 0, 'the memo is in use');

    process.env.FIXTURE_LIVE_VALUE = 'live-1';
    try {
        assert.equal((await resolvedConfig(bridge)).live, 'live-1', 'the environment is read live');
    } finally {
        delete process.env.FIXTURE_LIVE_VALUE;
    }
    setEnvVar('FIXTURE_EXPLICIT_SECRET', 'explicit-2');
    assert.equal((await resolvedConfig(bridge)).explicit, 'explicit-2', 'a rewritten .secrets is seen at once');

    process.env.PLOINKY_MASTER_KEY = SEED_B;
    try {
        await assert.rejects(bridge.beginLogin({ baseUrl: 'http://localhost:8080' }), /Unable to decrypt/);
    } finally {
        process.env.PLOINKY_MASTER_KEY = SEED_A;
    }
    const restored = await resolvedConfig(bridge);
    assert.equal(restored.explicit, 'explicit-2');
    assert.equal(restored.shared, deriveWorkspaceSecret({ name: 'FIXTURE_SHARED_SECRET' }));
});

test('bridge: a master key change is an unavailable admission that keeps the session', async () => {
    const { bridge } = freshBridge();
    globalThis.__configInputsValidation = (providerSession) => ({
        user: { id: 'u1', roles: ['admin'] }, providerSession: { ...providerSession, expiresAt: Date.now() + 60_000 },
    });
    const { state, browserBinding } = await bridge.beginLogin({ baseUrl: 'http://localhost:8080' });
    const { sessionId } = await bridge.handleCallback({ state, browserBinding, code: 'c', baseUrl: 'http://localhost:8080' });
    assert.ok(await bridge.validateSession(sessionId, { reportUnavailable: true }));
    process.env.PLOINKY_MASTER_KEY = SEED_B;
    try {
        await assert.rejects(bridge.validateSession(sessionId, { reportUnavailable: true }), { code: 'SSO_PROVIDER_UNAVAILABLE' });
        assert.ok(bridge.getSession(sessionId), 'an undecryptable configuration does not end the session');
    } finally {
        process.env.PLOINKY_MASTER_KEY = SEED_A;
    }
    assert.ok(await bridge.validateSession(sessionId, { reportUnavailable: true }), 'restoring the key recovers');
});

test('bridge: the after-answer fence still catches a secrets change made mid-flight', async () => {
    const { bridge } = freshBridge();
    setEnvVar('FIXTURE_EXPLICIT_SECRET', 'fence-1');
    let release;
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    globalThis.__configInputsValidation = (providerSession) => ({
        user: { id: 'u1', roles: ['admin'] }, providerSession: { ...providerSession, expiresAt: Date.now() + 60_000 },
    });
    const { state, browserBinding } = await bridge.beginLogin({ baseUrl: 'http://localhost:8080' });
    const { sessionId } = await bridge.handleCallback({ state, browserBinding, code: 'c', baseUrl: 'http://localhost:8080' });
    assert.ok(await bridge.validateSession(sessionId));
    globalThis.__configInputsValidation = async (providerSession) => {
        entered();
        await new Promise((resolve) => { release = resolve; });
        return { user: { id: 'u1', roles: ['admin'] }, providerSession };
    };
    const inFlight = bridge.validateSession(sessionId, { reportUnavailable: true }).then(() => 'granted', (error) => error.code);
    await enteredPromise;
    // The same-length value keeps the file size; the rewrite is a rename-replace.
    setEnvVar('FIXTURE_EXPLICIT_SECRET', 'fence-2');
    release();
    assert.equal(await inFlight, 'SSO_PROVIDER_UNAVAILABLE', 'the answer belongs to the old configuration');
    assert.ok(bridge.getSession(sessionId));
});
