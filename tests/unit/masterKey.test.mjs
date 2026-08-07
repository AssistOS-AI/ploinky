import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initializeWorkspaceMasterKey } from '../../ploinky-box/entrypoint/initialize-workspace.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mkey-'));
const originalCwd = process.cwd();
process.chdir(tempDir);

const moduleSuffix = `?test=${Date.now()}`;
const {
    deriveAgentSecret,
    deriveSubkey,
    deriveDerivedMasterKey,
    resolveMasterKey,
    resolveMasterKeySeed,
    sanitizeManagedMasterKeyEnvironment,
    MASTER_KEY_VAR,
} = await import(`../../cli/utils/security/masterKey.js${moduleSuffix}`);

let freshImportCounter = 0;
async function importFreshMasterKeyModule(label) {
    freshImportCounter += 1;
    return import(`../../cli/utils/security/masterKey.js?test=${Date.now()}-${freshImportCounter}-${label}`);
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

test('resolveMasterKey fails when a generated fallback cannot be securely persisted', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mkey-builtin-'));
    const previousCwd = process.cwd();
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    try {
        const blockedPath = path.join(workspace, '.ploinky', 'master-key');
        fs.mkdirSync(blockedPath, { recursive: true });
        process.chdir(workspace);
        process.env.PLOINKY_WORKSPACE_ROOT = workspace;

        const freshModule = await importFreshMasterKeyModule('built-in-fallback-warning');
        assert.throws(
            () => freshModule.resolveMasterKey({ purpose: 'test encrypted storage' }),
            /Unable to persist generated workspace master key/,
        );
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

test('resolveMasterKey does not overwrite or bypass an empty generated key file', async () => {
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
        assert.throws(
            () => freshModule.resolveMasterKey(),
            /Generated master key file exists but is empty/,
        );
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

test('managed Box resolution uses only .ploinky/master-key', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mkey-managed-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    initializeWorkspaceMasterKey({
        workspaceRoot: workspace,
        randomBytes: () => Buffer.from('c'.repeat(64), 'hex'),
    });
    fs.writeFileSync(
        path.join(workspace, '.env'),
        `${MASTER_KEY_VAR}=${'a'.repeat(64)}\nAPPLICATION_VALUE=untouched\n`,
    );
    const nested = path.join(workspace, 'nested');
    fs.mkdirSync(path.join(nested, '.ploinky'), { recursive: true });
    fs.writeFileSync(path.join(nested, '.ploinky', 'master-key'), `${'d'.repeat(64)}\n`, {
        mode: 0o600,
    });
    process.env[MASTER_KEY_VAR] = 'b'.repeat(64);

    assert.equal(resolveMasterKeySeed({
        startDir: nested,
        managedBox: true,
        workspaceRoot: workspace,
    }), 'c'.repeat(64));
    assert.deepEqual(
        resolveMasterKey({ startDir: nested, managedBox: true, workspaceRoot: workspace }),
        crypto.createHash('sha256').update('c'.repeat(64), 'utf8').digest(),
    );
});

test('managed Box resolution never lazily generates a missing key', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mkey-managed-missing-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, '.env'), `${MASTER_KEY_VAR}=${'a'.repeat(64)}\n`);
    process.env[MASTER_KEY_VAR] = 'b'.repeat(64);

    assert.throws(
        () => resolveMasterKeySeed({ managedBox: true, workspaceRoot: workspace }),
        /Unable to read managed workspace master key/i,
    );
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky')), false);
});

test('managed environments retain application values but remove master-key overrides', () => {
    const source = {
        APPLICATION_SETTING: 'preserved',
        [MASTER_KEY_VAR]: 'must-not-be-inherited',
    };
    assert.deepEqual(sanitizeManagedMasterKeyEnvironment(source, { managedBox: true }), {
        APPLICATION_SETTING: 'preserved',
    });
    assert.deepEqual(source, {
        APPLICATION_SETTING: 'preserved',
        [MASTER_KEY_VAR]: 'must-not-be-inherited',
    });
    assert.deepEqual(sanitizeManagedMasterKeyEnvironment(source, { managedBox: false }), source);
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

    const alphaKey = deriveAgentSecret({
        repoName: 'exampleRepo',
        agentName: 'alphaAgent',
        name: 'ALPHA_MASTER_KEY',
    });
    const alphaKeyAgain = deriveAgentSecret({
        repoName: 'exampleRepo',
        agentName: 'alphaAgent',
        name: 'ALPHA_MASTER_KEY',
    });
    const betaKey = deriveAgentSecret({
        repoName: 'exampleRepo',
        agentName: 'betaAgent',
        name: 'BETA_API_SECRET',
    });

    assert.equal(alphaKey.length, 64);
    assert.equal(alphaKey, alphaKeyAgain);
    assert.notEqual(alphaKey, betaKey);
    assert.notEqual(alphaKey, deriveDerivedMasterKey().toString('hex'));
    assert.notEqual(alphaKey, resolveMasterKey().toString('hex'));
});
