import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mkey-'));
const originalCwd = process.cwd();
process.chdir(tempDir);

const moduleSuffix = `?test=${Date.now()}`;
const {
    deriveAgentSecret,
    deriveSubkey,
    deriveDerivedMasterKey,
    resolveMasterKey,
    MASTER_KEY_VAR,
} = await import(`../../cli/services/masterKey.js${moduleSuffix}`);

let freshImportCounter = 0;
async function importFreshMasterKeyModule(label) {
    freshImportCounter += 1;
    return import(`../../cli/services/masterKey.js?test=${Date.now()}-${freshImportCounter}-${label}`);
}

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test.beforeEach(() => {
    delete process.env[MASTER_KEY_VAR];
    delete process.env.PLOINKY_WORKSPACE_ROOT;
});

test('resolveMasterKey creates a persistent fallback when neither process.env nor .env defines the key', () => {
    const errors = [];
    const originalError = console.error;
    console.error = (msg) => { errors.push(String(msg)); };
    try {
        const key = resolveMasterKey();
        const fallbackSeedPath = path.join(tempDir, '.ploinky', 'master-key');
        const fallbackSeed = fs.readFileSync(fallbackSeedPath, 'utf8').trim();
        const expected = crypto.createHash('sha256').update(fallbackSeed, 'utf8').digest();
        assert.equal(key.length, 32);
        assert.match(fallbackSeed, /^[0-9a-f]{64}$/);
        assert.deepEqual(key, expected);
        assert.deepEqual(resolveMasterKey(), expected);
        assert.ok(
            errors.some((m) => m.includes('[ploinky]') && m.includes(MASTER_KEY_VAR) && m.includes('generated fallback')),
            'expected a generated fallback warning to be logged via console.error'
        );
    } finally {
        console.error = originalError;
    }
});

test('resolveMasterKey warns when using the built-in fallback seed', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mkey-builtin-'));
    const previousCwd = process.cwd();
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const errors = [];
    const originalError = console.error;
    console.error = (msg) => { errors.push(String(msg)); };
    try {
        const blockedPath = path.join(workspace, '.ploinky', 'master-key');
        fs.mkdirSync(blockedPath, { recursive: true });
        process.chdir(workspace);
        process.env.PLOINKY_WORKSPACE_ROOT = workspace;

        const freshModule = await importFreshMasterKeyModule('built-in-fallback-warning');
        const key = freshModule.resolveMasterKey({ purpose: 'test encrypted storage' });
        const expected = crypto
            .createHash('sha256')
            .update('ploinky-default-master-key-v1', 'utf8')
            .digest();

        assert.deepEqual(key, expected);
        assert.ok(
            errors.some((m) => (
                m.includes('[ploinky]')
                && m.includes(MASTER_KEY_VAR)
                && m.includes('insecure built-in fallback seed')
                && m.includes('Could not persist')
                && m.includes('Set PLOINKY_MASTER_KEY')
            )),
            'expected a built-in fallback warning to be logged via console.error'
        );
    } finally {
        console.error = originalError;
        process.chdir(previousCwd);
        if (previousRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        }
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('resolveMasterKey ignores stale explicit workspace roots that are not directories', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mkey-root-'));
    const previousCwd = process.cwd();
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    try {
        fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
        process.chdir(workspace);
        process.env.PLOINKY_WORKSPACE_ROOT = path.join(workspace, 'missing-root');

        const freshModule = await importFreshMasterKeyModule('stale-workspace-root');
        freshModule.resolveMasterKey();

        assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'master-key')), true);
        assert.equal(fs.existsSync(path.join(workspace, 'missing-root')), false);
    } finally {
        process.chdir(previousCwd);
        if (previousRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        }
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('resolveMasterKey does not overwrite an empty generated key file', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mkey-empty-'));
    const previousCwd = process.cwd();
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    try {
        const keyPath = path.join(workspace, '.ploinky', 'master-key');
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        fs.writeFileSync(keyPath, '');
        process.chdir(workspace);
        process.env.PLOINKY_WORKSPACE_ROOT = workspace;

        const freshModule = await importFreshMasterKeyModule('empty-generated-key');
        const key = freshModule.resolveMasterKey();
        const expected = crypto
            .createHash('sha256')
            .update('ploinky-default-master-key-v1', 'utf8')
            .digest();

        assert.deepEqual(key, expected);
        assert.equal(fs.readFileSync(keyPath, 'utf8'), '');
    } finally {
        process.chdir(previousCwd);
        if (previousRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        }
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('resolveMasterKey falls back to a .env walked up from the current directory', () => {
    const seed = 'a'.repeat(64);
    fs.writeFileSync(path.join(tempDir, '.env'), `${MASTER_KEY_VAR}=${seed}\n`);
    try {
        const key = resolveMasterKey();
        const expected = crypto.createHash('sha256').update(seed, 'utf8').digest();
        assert.equal(key.length, 32);
        assert.deepEqual(key, expected);
    } finally {
        fs.rmSync(path.join(tempDir, '.env'), { force: true });
    }
});

test('process.env value takes precedence over .env value when both define the key', () => {
    const fileSeed = 'a'.repeat(64);
    const envSeed = 'b'.repeat(64);
    fs.writeFileSync(path.join(tempDir, '.env'), `${MASTER_KEY_VAR}=${fileSeed}\n`);
    process.env[MASTER_KEY_VAR] = envSeed;
    try {
        const expected = crypto.createHash('sha256').update(envSeed, 'utf8').digest();
        assert.deepEqual(resolveMasterKey(), expected);
    } finally {
        fs.rmSync(path.join(tempDir, '.env'), { force: true });
    }
});

test('resolveMasterKey accepts arbitrary strings as seeds and derives via SHA-256', () => {
    process.env[MASTER_KEY_VAR] = 'an-operator-passphrase';
    const key = resolveMasterKey();
    assert.equal(key.length, 32);
    // Deterministic: same seed always produces the same key
    process.env[MASTER_KEY_VAR] = 'an-operator-passphrase';
    assert.deepEqual(resolveMasterKey(), key);
});

test('deriveSubkey produces distinct, deterministic 32-byte subkeys per purpose', () => {
    process.env[MASTER_KEY_VAR] = 'c'.repeat(64);
    const invocation = deriveSubkey('invocation');
    const session = deriveSubkey('session');
    const storageSecrets = deriveSubkey('storage/secrets');
    const storagePasswords = deriveSubkey('storage/passwords');
    assert.equal(invocation.length, 32);
    // Each purpose yields a distinct subkey (domain separation via HKDF info)
    assert.notDeepEqual(invocation, session);
    assert.notDeepEqual(invocation, storageSecrets);
    assert.notDeepEqual(storageSecrets, storagePasswords);
    // None of them equals the master key itself
    assert.notDeepEqual(invocation, resolveMasterKey());
    // Deterministic per (master, purpose) pair
    assert.deepEqual(deriveSubkey('invocation'), invocation);
});

test('deriveDerivedMasterKey is the derived-master subkey', () => {
    process.env[MASTER_KEY_VAR] = 'd'.repeat(64);
    assert.deepEqual(deriveDerivedMasterKey(), deriveSubkey('derived-master'));
    assert.notDeepEqual(deriveDerivedMasterKey(), deriveSubkey('invocation'));
});

test('deriveAgentSecret derives deterministic per-agent secrets from the derived master key', () => {
    process.env[MASTER_KEY_VAR] = 'e'.repeat(64);

    const dpuKey = deriveAgentSecret({
        repoName: 'AssistOSExplorer',
        agentName: 'dpuAgent',
        name: 'DPU_MASTER_KEY',
    });
    const dpuKeyAgain = deriveAgentSecret({
        repoName: 'AssistOSExplorer',
        agentName: 'dpuAgent',
        name: 'DPU_MASTER_KEY',
    });
    const livekitKey = deriveAgentSecret({
        repoName: 'AssistOSExplorer',
        agentName: 'webmeetLivekitServer',
        name: 'WEBMEET_LIVEKIT_API_SECRET',
    });

    assert.equal(dpuKey.length, 64);
    assert.equal(dpuKey, dpuKeyAgain);
    assert.notEqual(dpuKey, livekitKey);
    assert.notEqual(dpuKey, deriveDerivedMasterKey().toString('hex'));
    assert.notEqual(dpuKey, resolveMasterKey().toString('hex'));
});
