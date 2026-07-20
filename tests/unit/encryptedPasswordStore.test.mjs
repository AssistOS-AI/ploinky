import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const ENV_KEY = '1'.repeat(64);
const FILE_KEY = '2'.repeat(64);

test('encrypted password store round-trips and enforces the master key', async (t) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-password-store-'));
    const previousCwd = process.cwd();
    const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
    process.chdir(workspace);
    writeFileSync(path.join(workspace, '.env'), `PLOINKY_MASTER_KEY=${FILE_KEY}\n`);
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

    const store = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/utils/security/encryptedPasswordStore.js')).href}?test=${Date.now()}`);
    store.setUsersPayload('PLOINKY_AUTH_ALPHA_USERS', {
        version: 1,
        users: [
            {
                id: 'local:alice',
                username: 'alice',
                name: 'Alice',
                email: 'alice@example.com',
                passwordHash: 'scrypt$secret-hash',
                roles: ['local'],
                rev: 3,
            },
        ],
    });

    const payload = store.getUsersPayload('PLOINKY_AUTH_ALPHA_USERS');
    assert.equal(payload.version, 1);
    assert.equal(payload.users[0].username, 'alice');
    assert.equal(payload.users[0].rev, 3);

    const encryptedText = readFileSync(store.PASSWORD_STORE_FILE, 'utf8');
    // Packed-base64 envelope: a single line of base64 + trailing newline, no JSON braces.
    assert.match(encryptedText, /^[A-Za-z0-9+/]+={0,2}\n?$/);
    assert.doesNotMatch(encryptedText, /alice|alice@example\.com|scrypt\$secret-hash|PLOINKY_AUTH_ALPHA_USERS/);

    // process.env wins over .env: the file was encrypted with ENV_KEY (set in
    // process.env above), so removing process.env should leave only FILE_KEY
    // available from the on-disk .env, which can no longer decrypt.
    delete process.env.PLOINKY_MASTER_KEY;
    assert.throws(
        () => store.getUsersPayload('PLOINKY_AUTH_ALPHA_USERS'),
        /Unable to decrypt encrypted password store: .*Check PLOINKY_MASTER_KEY.*\.env.*\.ploinky\/master-key/s,
        '.env uses a different key, so process env must have taken precedence while writing',
    );

    // Now overwrite the .env to ENV_KEY and confirm the on-disk fallback path
    // actually drives decryption when process.env is unset.
    writeFileSync(path.join(workspace, '.env'), `PLOINKY_MASTER_KEY=${ENV_KEY}\n`);
    assert.equal(store.getUsersPayload('PLOINKY_AUTH_ALPHA_USERS').users[0].username, 'alice');

    writeFileSync(path.join(workspace, '.env'), '');
    assert.throws(
        () => store.getUsersPayload('PLOINKY_AUTH_ALPHA_USERS'),
        /Unable to decrypt encrypted password store: .*Check PLOINKY_MASTER_KEY.*\.env.*\.ploinky\/master-key/s,
    );

    // Arbitrary strings are now accepted as seeds, so the wrong seed produces
    // a decryption failure rather than a validation failure.
    process.env.PLOINKY_MASTER_KEY = 'abc';
    assert.throws(
        () => store.getUsersPayload('PLOINKY_AUTH_ALPHA_USERS'),
        /Unable to decrypt encrypted password store: .*Check PLOINKY_MASTER_KEY.*\.env.*\.ploinky\/master-key/s,
    );
});
