import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = 'a'.repeat(64);

test('local auth credentials update through the encrypted password store', async (t) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-local-auth-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    mkdirSync(ploinkyDir, { recursive: true });
    writeFileSync(path.join(ploinkyDir, '.secrets'), '# test secrets\n');

    const previousCwd = process.cwd();
    const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
    process.chdir(workspace);
    process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
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
    const localService = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/auth/localService.js')).href}?test=${nonce}`);
    const passwordStore = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/utils/security/encryptedPasswordStore.js')).href}?test=${nonce}`);
    const passwords = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/utils/security/localAuthPasswords.js')).href}?test=${nonce}`);

    const policy = {
        usersVar: 'PLOINKY_AUTH_TEST_USERS',
    };

    passwordStore.setUsersPayload(policy.usersVar, {
        version: 1,
        users: [
            {
                id: 'local:admin',
                username: 'admin',
                name: 'admin',
                email: null,
                passwordHash: passwords.hashPassword('adminpass'),
                roles: ['local', 'admin'],
                rev: 1,
            },
            {
                id: 'local:reviewer',
                username: 'reviewer',
                name: 'reviewer',
                email: null,
                passwordHash: passwords.hashPassword('reviewpass'),
                roles: ['local'],
                rev: 1,
            },
        ],
    });

    const login = localService.authenticateLocalUser({
        username: 'admin',
        password: 'adminpass',
        policy,
        routeKey: 'explorer',
    });

    assert.ok(login.sessionId, 'expected a local auth session id');
    assert.equal(localService.getSession(login.sessionId, { policy })?.user?.username, 'admin');

    const update = localService.updateLocalCredentials({
        currentPassword: 'adminpass',
        nextUsername: 'maintainer',
        nextPassword: 'newpass123',
        policy,
        sessionUser: login.user,
    });

    assert.equal(update.username, 'maintainer');
    assert.equal(update.usernameChanged, true);
    assert.equal(update.passwordChanged, true);
    assert.equal(localService.getSession(login.sessionId, { policy }), null, 'old session should be revoked by rev change');

    const secretsText = readFileSync(path.join(ploinkyDir, '.secrets'), 'utf8');
    assert.doesNotMatch(secretsText, /PLOINKY_AUTH_TEST_USERS/);
    assert.doesNotMatch(secretsText, /PLOINKY_DERIVED_MASTER_KEY/);
    const encryptedText = readFileSync(passwordStore.PASSWORD_STORE_FILE, 'utf8');
    assert.doesNotMatch(encryptedText, /maintainer|reviewer|adminpass|reviewpass|newpass123/);

    const storedUsers = passwordStore.getUsersPayload(policy.usersVar);
    const maintainer = storedUsers.users.find((entry) => entry.username === 'maintainer');
    const reviewer = storedUsers.users.find((entry) => entry.username === 'reviewer');
    assert.ok(maintainer);
    assert.ok(reviewer);
    assert.equal(passwords.verifyPasswordHash('newpass123', maintainer.passwordHash), true);
    assert.equal(passwords.verifyPasswordHash('adminpass', maintainer.passwordHash), false);
    assert.equal(passwords.verifyPasswordHash('reviewpass', reviewer.passwordHash), true);

    const relogin = localService.authenticateLocalUser({
        username: 'maintainer',
        password: 'newpass123',
        policy,
        routeKey: 'explorer',
    });
    assert.ok(relogin.sessionId, 'expected login with updated credentials to succeed');
});
