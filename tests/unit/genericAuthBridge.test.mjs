import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-bridge-'));
fs.mkdirSync(path.join(tempDir, '.ploinky'), { recursive: true });

// Install a fake SSO provider agent under .ploinky/repos/fake/fakeProvider/
const providerDir = path.join(tempDir, '.ploinky', 'repos', 'fake', 'fakeProvider');
fs.mkdirSync(path.join(providerDir, 'runtime'), { recursive: true });
fs.writeFileSync(
    path.join(providerDir, 'manifest.json'),
    JSON.stringify({
        ssoProvider: true,
    }, null, 2)
);
fs.writeFileSync(
    path.join(providerDir, 'runtime', 'index.mjs'),
    `
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const CALL_LOG = process.env.__FAKE_PROVIDER_LOG;
function recordCall(op, payload) {
    try {
        const existing = existsSync(CALL_LOG) ? JSON.parse(readFileSync(CALL_LOG, 'utf8')) : [];
        existing.push({ op, payload });
        writeFileSync(CALL_LOG, JSON.stringify(existing));
    } catch {}
}
export function resolveProviderConfig({ providerConfig = {} } = {}) {
    return {
        issuerBaseUrl: providerConfig.issuerBaseUrl || 'https://fake.test',
        clientId: providerConfig.clientId || 'fake-client'
    };
}
export function createProvider({ getConfig }) {
    return {
        name: 'fake/fakeProvider',
        async sso_begin_login({ redirectUri, prompt }) {
            const cfg = await getConfig();
            recordCall('sso_begin_login', { redirectUri, prompt, config: cfg });
            return {
                authorizationUrl: 'https://fake.test/auth?state=PROVIDER_STATE',
                providerState: 'PROVIDER_STATE',
                expiresAt: Date.now() + 60_000
            };
        },
        async sso_handle_callback({ redirectUri, query, providerState }) {
            recordCall('sso_handle_callback', { redirectUri, query, providerState });
            return {
                user: { id: 'u1', sub: 'u1', username: 'alice', email: 'alice@test', roles: ['dev'], raw: {} },
                providerSession: {
                    provider: 'fake/fakeProvider',
                    tokens: { accessToken: 'AT', idToken: 'ID', refreshToken: 'RT', scope: 'openid', tokenType: 'Bearer' },
                    expiresAt: Date.now() + 60_000,
                    refreshExpiresAt: Date.now() + 120_000
                }
            };
        },
        async sso_validate_session({ providerSession }) {
            recordCall('sso_validate_session', { providerSession });
            return { user: { id: 'u1', sub: 'u1', username: 'alice' }, providerSession };
        },
        async sso_refresh_session({ providerSession }) {
            recordCall('sso_refresh_session', { providerSession });
            if (process.env.__FAKE_PROVIDER_REFRESH_DELAY === '1') {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            if (process.env.__FAKE_PROVIDER_REFRESH_FAIL === '1') throw new Error('refresh rejected');
            const roles = process.env.__FAKE_PROVIDER_ROLES
                ? process.env.__FAKE_PROVIDER_ROLES.split(',')
                : undefined;
            return {
                user: { id: 'u1', sub: 'u1', username: 'alice', ...(roles ? { roles } : {}) },
                providerSession: { ...providerSession, tokens: { ...providerSession.tokens, accessToken: 'AT2' } }
            };
        },
        async sso_logout({ providerSession, postLogoutRedirectUri }) {
            recordCall('sso_logout', { providerSession, postLogoutRedirectUri });
            return { redirectUrl: 'https://fake.test/logout' };
        },
        async sso_admin_list_users(payload) {
            recordCall('sso_admin_list_users', payload);
            return { users: [{ id: 'u1', username: 'alice', roles: ['admin'] }], availableRoles: ['admin', 'user'] };
        },
        async sso_admin_create_user(payload) {
            recordCall('sso_admin_create_user', payload);
            return { id: 'u2', username: payload.username, roles: payload.roles || ['user'] };
        },
        async sso_admin_update_user(payload) {
            recordCall('sso_admin_update_user', payload);
            return { id: payload.userId, username: payload.username, roles: payload.roles || ['user'] };
        },
        async sso_admin_delete_user(payload) {
            recordCall('sso_admin_delete_user', payload);
            return { id: payload.userId, status: 'blocked' };
        },
        invalidateCaches() {}
    };
}
    `
);

process.chdir(tempDir);

const callLogPath = path.join(tempDir, 'fake-provider-calls.json');
process.env.__FAKE_PROVIDER_LOG = callLogPath;

function readCalls() {
    if (!fs.existsSync(callLogPath)) return [];
    return JSON.parse(fs.readFileSync(callLogPath, 'utf8'));
}

function writeWorkspaceSsoConfig(nextSso) {
    const agentsPath = path.join(tempDir, '.ploinky', 'agents.json');
    const existing = fs.existsSync(agentsPath)
        ? JSON.parse(fs.readFileSync(agentsPath, 'utf8'))
        : {};
    existing._config = {
        ...(existing._config || {}),
        sso: nextSso
    };
    fs.writeFileSync(agentsPath, JSON.stringify(existing, null, 2));
}

const moduleSuffix = `?test=${Date.now()}`;
const bridgeModule = await import(`../../cli/server/auth/genericAuthBridge.js${moduleSuffix}`);
const { createGenericAuthBridge } = bridgeModule;

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('generic bridge requires configured SSO provider', async () => {
    const bridge = createGenericAuthBridge();
    await assert.rejects(
        bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' }),
        /SSO is not configured/
    );
});

test('generic bridge orchestrates begin/callback/refresh/logout through provider', async () => {
    writeWorkspaceSsoConfig({
        enabled: true,
        providerAgent: 'fake/fakeProvider',
        providerConfig: {
            issuerBaseUrl: 'https://fake.test',
            clientId: 'fake-client'
        }
    });

    const bridge = createGenericAuthBridge();
    const { redirectUrl, state } = await bridge.beginLogin({
        baseUrl: 'http://127.0.0.1:8080',
        returnTo: '/webchat/'
    });
    // The bridge replaces the provider's own `state` with a core-owned one
    // so the browser presents our key on the callback.
    assert.ok(redirectUrl.includes(`state=${state}`));

    const callback = await bridge.handleCallback({
        code: 'auth-code',
        state,
        baseUrl: 'http://127.0.0.1:8080'
    });
    assert.equal(callback.user.username, 'alice');
    assert.equal(callback.redirectTo, '/webchat/');

    const refreshed = await bridge.refreshSession(callback.sessionId);
    assert.equal(refreshed.accessToken, 'AT2');

    const loggedOut = await bridge.logout(callback.sessionId, { baseUrl: 'http://127.0.0.1:8080' });
    assert.equal(loggedOut.redirect, 'https://fake.test/logout');

    // Verify provider received each operation
    const ops = readCalls().map((c) => c.op);
    assert.ok(ops.includes('sso_begin_login'));
    assert.ok(ops.includes('sso_handle_callback'));
    assert.ok(ops.includes('sso_refresh_session'));
    assert.ok(ops.includes('sso_logout'));
});

test('bridge rejects unknown state on callback', async () => {
    writeWorkspaceSsoConfig({
        enabled: true,
        providerAgent: 'fake/fakeProvider',
        providerConfig: {
            issuerBaseUrl: 'https://fake.test',
            clientId: 'fake-client'
        }
    });
    const bridge = createGenericAuthBridge();
    await assert.rejects(
        bridge.handleCallback({ code: 'x', state: 'bogus', baseUrl: 'http://127.0.0.1:8080' }),
        /Invalid or expired/
    );
});

test('response-free validation refreshes and persists current SSO identity, then fails closed', async (t) => {
    writeWorkspaceSsoConfig({
        enabled: true,
        providerAgent: 'fake/fakeProvider',
        providerConfig: {
            issuerBaseUrl: 'https://fake.test',
            clientId: 'fake-client'
        }
    });
    t.after(() => {
        delete process.env.__FAKE_PROVIDER_ROLES;
        delete process.env.__FAKE_PROVIDER_REFRESH_FAIL;
        delete process.env.__FAKE_PROVIDER_REFRESH_DELAY;
    });
    const bridge = createGenericAuthBridge({ ssoValidationIntervalMs: 0 });
    const { state } = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' });
    const callback = await bridge.handleCallback({
        code: 'auth-code',
        state,
        baseUrl: 'http://127.0.0.1:8080'
    });

    process.env.__FAKE_PROVIDER_ROLES = 'user,admin';
    const validated = await bridge.validateSession(callback.sessionId);
    assert.deepEqual(validated.user.roles, ['user', 'admin']);
    assert.equal(validated.providerSession.tokens.accessToken, 'AT2');
    assert.deepEqual(bridge.getSession(callback.sessionId).user.roles, ['user', 'admin']);

    process.env.__FAKE_PROVIDER_REFRESH_FAIL = '1';
    assert.equal(await bridge.validateSession(callback.sessionId, { forceRemote: true }), null);
    assert.equal(bridge.getSession(callback.sessionId), null);
    const refreshCalls = readCalls().filter((call) => call.op === 'sso_refresh_session');
    assert.ok(refreshCalls.length >= 2);
});

test('response-free SSO validation is single-flight per auth session', async (t) => {
    writeWorkspaceSsoConfig({
        enabled: true,
        providerAgent: 'fake/fakeProvider',
        providerConfig: {
            issuerBaseUrl: 'https://fake.test',
            clientId: 'fake-client'
        }
    });
    t.after(() => { delete process.env.__FAKE_PROVIDER_REFRESH_DELAY; });
    const bridge = createGenericAuthBridge({ ssoValidationIntervalMs: 0 });
    const { state } = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' });
    const callback = await bridge.handleCallback({
        code: 'auth-code',
        state,
        baseUrl: 'http://127.0.0.1:8080'
    });
    const before = readCalls().filter((call) => call.op === 'sso_refresh_session').length;
    process.env.__FAKE_PROVIDER_REFRESH_DELAY = '1';
    const [first, second, third] = await Promise.all([
        bridge.validateSession(callback.sessionId),
        bridge.validateSession(callback.sessionId),
        bridge.validateSession(callback.sessionId),
    ]);
    const after = readCalls().filter((call) => call.op === 'sso_refresh_session').length;
    assert.equal(after - before, 1);
    assert.equal(first.providerSession.tokens.accessToken, 'AT2');
    assert.equal(second, first);
    assert.equal(third, first);
});

test('provider-neutral admin operations are delegated without interpreting provider payloads', async () => {
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {} });
    const bridge = createGenericAuthBridge();
    const listed = await bridge.listUsers({ actorUserId: 'admin-1' });
    const created = await bridge.createUser({ actorUserId: 'admin-1', username: 'bob', roles: ['user'] });
    const updated = await bridge.updateUser({ actorUserId: 'admin-1', userId: 'u2', username: 'robert' });
    const deleted = await bridge.deleteUser({ actorUserId: 'admin-1', userId: 'u2' });

    assert.deepEqual(listed.availableRoles, ['admin', 'user']);
    assert.equal(created.id, 'u2');
    assert.equal(updated.username, 'robert');
    assert.equal(deleted.status, 'blocked');
    const adminCalls = readCalls().filter((call) => call.op.startsWith('sso_admin_'));
    assert.deepEqual(adminCalls.map((call) => call.payload.actorUserId), ['admin-1', 'admin-1', 'admin-1', 'admin-1']);
});
