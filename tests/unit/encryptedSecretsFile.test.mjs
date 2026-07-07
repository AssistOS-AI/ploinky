import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const ENV_KEY = '3'.repeat(64);
const FILE_KEY = '4'.repeat(64);

test('encrypted .secrets round-trips and enforces the master key', async (t) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-secrets-file-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    mkdirSync(ploinkyDir, { recursive: true });
    writeFileSync(path.join(workspace, '.env'), `PLOINKY_MASTER_KEY=${FILE_KEY}\n`);

    const previousCwd = process.cwd();
    const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
    process.chdir(workspace);
    process.env.PLOINKY_MASTER_KEY = ENV_KEY;
    t.after(() => {
        process.chdir(previousCwd);
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_MASTER_KEY;
        } else {
            process.env.PLOINKY_MASTER_KEY = previousMasterKey;
        }
        rmSync(workspace, { recursive: true, force: true });
    });

    const nonce = Date.now();
    const store = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/services/encryptedSecretsFile.js')).href}?test=${nonce}`);

    assert.deepEqual(store.readSecretsFile(), {});

    store.setSecretValue('WEBDASHBOARD_TOKEN', 'token-value');
    store.setSecretValue('ONLYOFFICE_JWT_SECRET', 'office-secret');
    assert.deepEqual(store.readSecretsFile(), {
        WEBDASHBOARD_TOKEN: 'token-value',
        ONLYOFFICE_JWT_SECRET: 'office-secret',
    });

    let encryptedText = readFileSync(path.join(ploinkyDir, '.secrets'), 'utf8');
    // Packed-base64 envelope: a single line of base64 + trailing newline, no JSON braces.
    assert.match(encryptedText, /^[A-Za-z0-9+/]+={0,2}\n?$/);
    assert.doesNotMatch(encryptedText, /token-value|office-secret|WEBDASHBOARD_TOKEN|ONLYOFFICE_JWT_SECRET/);

    store.setSecretValue('DPU_MASTER_KEY', 'dpu-secret');
    assert.equal(store.readSecretsFile().DPU_MASTER_KEY, 'dpu-secret');
    encryptedText = readFileSync(path.join(ploinkyDir, '.secrets'), 'utf8');
    assert.doesNotMatch(encryptedText, /dpu-secret|DPU_MASTER_KEY/);

    store.deleteSecretValue('WEBDASHBOARD_TOKEN');
    assert.equal(store.readSecretsFile().WEBDASHBOARD_TOKEN, undefined);

    // process.env wins over .env: the file was encrypted with ENV_KEY (set in
    // process.env above), so removing process.env should leave only FILE_KEY
    // available from the on-disk .env, which can no longer decrypt.
    delete process.env.PLOINKY_MASTER_KEY;
    assert.throws(
        () => store.readSecretsFile(),
        /Unable to decrypt .ploinky\/.secrets: .*Check PLOINKY_MASTER_KEY.*\.env.*\.ploinky\/master-key/s,
        '.env uses a different key, so process env must have taken precedence while writing',
    );

    // Now overwrite the .env to ENV_KEY and confirm the on-disk fallback path
    // actually drives decryption when process.env is unset.
    writeFileSync(path.join(workspace, '.env'), `PLOINKY_MASTER_KEY=${ENV_KEY}\n`);
    assert.equal(store.readSecretsFile().DPU_MASTER_KEY, 'dpu-secret');

    writeFileSync(path.join(workspace, '.env'), '');
    assert.throws(
        () => store.readSecretsFile(),
        /Unable to decrypt \.ploinky\/\.secrets: .*Check PLOINKY_MASTER_KEY.*\.env.*\.ploinky\/master-key/s,
    );

    // Arbitrary strings are now accepted as seeds, so the wrong seed produces
    // a decryption failure rather than a validation failure.
    process.env.PLOINKY_MASTER_KEY = 'abc';
    assert.throws(
        () => store.readSecretsFile(),
        /Unable to decrypt .ploinky\/.secrets: .*Check PLOINKY_MASTER_KEY.*\.env.*\.ploinky\/master-key/s,
    );
});
