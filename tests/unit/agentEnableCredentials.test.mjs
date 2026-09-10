import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-enable-credentials-'));
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '8080';
delete process.env.PLOINKY_MASTER_KEY;
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
const masterKeyFile = path.join(workspace, '.ploinky', 'master-key');
fs.writeFileSync(masterKeyFile, 'saved-test-workspace-master-seed\n', { mode: 0o600 });
fs.writeFileSync(path.join(workspace, '.env'), '');

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const agents = await import('../../cli/utils/agents.js');
const store = await import('../../cli/utils/security/encryptedPasswordStore.js');
const { hashPassword, verifyPasswordHash } = await import('../../cli/utils/security/localAuthPasswords.js');
const usersVar = 'PLOINKY_AUTH_ACCOUNT_APP_USERS';
const savedUsers = { version: 1, users: [{
    id: 'local:operator', username: 'operator', name: 'Saved operator',
    email: 'operator@example.test', roles: ['local', 'admin'], rev: 9,
    passwordHash: hashPassword('saved-operator-test-password'),
}] };

test.after(() => {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(workspace, { recursive: true, force: true });
});

test.beforeEach(() => {
    // Recreate only this test's runtime registries, retaining its saved seed.
    for (const entry of fs.readdirSync(path.join(workspace, '.ploinky'))) {
        if (entry !== 'master-key') fs.rmSync(path.join(workspace, '.ploinky', entry), { recursive: true, force: true });
    }
    const agentDir = path.join(workspace, '.ploinky', 'repos', 'demo', 'account-app');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({
        container: 'node:20-alpine', network: { mode: 'default' }, ploinky: 'pwd enable',
        pwd: { users: [{ username: 'manifest-admin', password: 'manifest-test-password', roles: ['admin'] }] },
    }));
    const initialized = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    fs.writeFileSync(initialized.paths.routingFile, JSON.stringify({ port: 8080, routes: {} }));
});

function prepare(options = {}) {
    return agents.prepareAgentEnableBatch([{ agentName: 'demo/account-app', ...options }], {
        availabilityMode: 'replacement', reason: 'test-preserved-redeploy-credentials',
        retireNoWaitMarkers: () => [],
    });
}

for (const [label, payload] of [['saved accounts', savedUsers], ['intentional empty selection', { version: 1, users: [] }]]) {
    test(`fresh runtime registration preserves ${label} and persisted master seed`, () => {
        store.setUsersPayload(usersVar, payload);
        const previousCiphertext = fs.readFileSync(store.PASSWORD_STORE_FILE);
        const previousSeed = fs.readFileSync(masterKeyFile);
        const prepared = prepare();
        assert.equal(prepared.plans[0].record.auth.usersVar, usersVar);
        assert.deepEqual(store.getUsersPayload(usersVar), payload);
        assert.deepEqual(fs.readFileSync(store.PASSWORD_STORE_FILE), previousCiphertext);
        assert.deepEqual(fs.readFileSync(masterKeyFile), previousSeed);
        if (payload.users.length) {
            assert.equal(verifyPasswordHash('saved-operator-test-password', store.getUsersPayload(usersVar).users[0].passwordHash), true);
        }
        assert.ok(prepared.plans[0].instanceId);
        assert.ok(prepared.plans[0].enableGeneration);
    });
}

test('fresh route seeds manifest accounts without replacing another saved route', () => {
    store.setUsersPayload('PLOINKY_AUTH_OTHER_USERS', savedUsers);
    prepare();
    assert.equal(store.getUsersPayload(usersVar).users[0].username, 'manifest-admin');
    assert.equal(verifyPasswordHash('manifest-test-password', store.getUsersPayload(usersVar).users[0].passwordHash), true);
    assert.deepEqual(store.getUsersPayload('PLOINKY_AUTH_OTHER_USERS'), savedUsers);
});

test('explicit credential override still replaces saved accounts', () => {
    store.setUsersPayload(usersVar, savedUsers);
    const prepared = prepare({ authOptions: { username: 'explicit-admin', password: 'explicit-test-password' } });
    const payload = store.getUsersPayload(usersVar);
    assert.equal(payload.users.length, 1);
    assert.equal(payload.users[0].username, 'explicit-admin');
    assert.deepEqual(payload.users[0].roles, ['local', 'admin']);
    assert.equal(verifyPasswordHash('explicit-test-password', payload.users[0].passwordHash), true);
    assert.equal(prepared.plans[0].credentialUpdate.ifAbsent, undefined);
});

test('manifest seed rechecks saved accounts at final commit after preparation', () => {
    const prepared = prepare();
    store.setUsersPayload(usersVar, savedUsers);
    const savedCiphertext = fs.readFileSync(store.PASSWORD_STORE_FILE);
    const rollback = store.setUsersPayloadBatchTransactional(prepared.plans.map((plan) => plan.credentialUpdate));
    assert.deepEqual(store.getUsersPayload(usersVar), savedUsers);
    assert.deepEqual(fs.readFileSync(store.PASSWORD_STORE_FILE), savedCiphertext);
    rollback();
    assert.deepEqual(fs.readFileSync(store.PASSWORD_STORE_FILE), savedCiphertext);
});
