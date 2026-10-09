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
    if (process.env.__FAKE_PROVIDER_CONFIG_FAIL === '1') throw new Error('fixture configuration unreadable');
    return {
        issuerBaseUrl: providerConfig.issuerBaseUrl || 'https://fake.test',
        clientId: providerConfig.clientId || 'fake-client',
        ...(providerConfig.redirectUri ? { redirectUri: providerConfig.redirectUri } : {}),
        ...(providerConfig.canonicalLoginOrigin ? { canonicalLoginOrigin: providerConfig.canonicalLoginOrigin } : {}),
    };
}
export function createProvider({ getConfig }) {
    return {
        name: 'fake/fakeProvider',
        async sso_begin_login({ redirectUri, prompt, returnTo, supportsCanonicalLoginOrigin }) {
            const cfg = await getConfig();
            recordCall('sso_begin_login', { redirectUri, prompt, returnTo, supportsCanonicalLoginOrigin, config: cfg });
            if (process.env.__FAKE_PROVIDER_BEGIN_DELAY === '1') {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (process.env.__FAKE_PROVIDER_BEGIN_RESPONSE) {
                return JSON.parse(process.env.__FAKE_PROVIDER_BEGIN_RESPONSE);
            }
            if (supportsCanonicalLoginOrigin === true && cfg.canonicalLoginOrigin
                && new URL(redirectUri).origin !== cfg.canonicalLoginOrigin) {
                return { canonicalLoginOrigin: cfg.canonicalLoginOrigin };
            }
            return {
                authorizationUrl: 'https://fake.test/auth?state=PROVIDER_STATE',
                providerState: 'PROVIDER_STATE',
                expiresAt: process.env.__FAKE_PROVIDER_ISO_EXPIRY === '1' ? new Date(Date.now() + 60_000).toISOString() : Date.now() + 60_000
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
        async sso_refresh_session({ providerSession, signal }) {
            recordCall('sso_refresh_session', { providerSession });
            if (globalThis.__bridgeValidationFixture) return globalThis.__bridgeValidationFixture(providerSession, { signal });
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

const { onAuthenticationSessionInvalidated } = await import('../../cli/server/auth/sessionEvents.js');
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
    const { redirectUrl, state, browserBinding } = await bridge.beginLogin({
        baseUrl: 'http://127.0.0.1:8080',
        returnTo: '/webchat/'
    });
    // The bridge replaces the provider's own `state` with a core-owned one
    // so the browser presents our key on the callback.
    assert.ok(redirectUrl.includes(`state=${state}`));

    const callback = await bridge.handleCallback({
        code: 'auth-code',
        state,
        browserBinding,
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
    // The provider sees the validated return path only as information.
    assert.equal(readCalls().find((c) => c.op === 'sso_begin_login').payload.returnTo, '/webchat/');
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

test('canonical login hints restart only between exact loopback origins without browser state', async (t) => {
    t.after(() => { delete process.env.__FAKE_PROVIDER_BEGIN_RESPONSE; });
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {} });
    for (const [baseUrl, canonicalLoginOrigin] of [
        ['http://localhost:8080', 'http://127.0.0.1:8080'],
        ['http://[::1]:8080', 'http://127.0.0.1:8080'],
        ['http://127.0.0.1', 'http://localhost'],
        ['https://localhost', 'https://[::1]'],
    ]) {
        process.env.__FAKE_PROVIDER_BEGIN_RESPONSE = JSON.stringify({ canonicalLoginOrigin });
        const bridge = createGenericAuthBridge();
        const result = await bridge.beginLogin({ baseUrl });
        assert.deepEqual(result, { restartLogin: true, canonicalLoginOrigin });
        assert.equal(readCalls().at(-1).payload.supportsCanonicalLoginOrigin, true);
        await assert.rejects(bridge.handleCallback({
            state: result.state, browserBinding: result.browserBinding, code: 'copied-code', baseUrl,
        }), /Invalid or expired authorization state/);
    }
});

test('malformed or unsafe canonical hints fail closed even when a fallback authorization URL exists', async (t) => {
    t.after(() => { delete process.env.__FAKE_PROVIDER_BEGIN_RESPONSE; });
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {} });
    const baseUrl = 'http://localhost:8080';
    for (const canonicalLoginOrigin of [
        null, {}, [], 123, '',
        'http://127.0.0.1:8080/', 'http://127.0.0.1:8080/auth/login',
        'http://127.0.0.1:8080?next=evil', 'http://127.0.0.1:8080#fragment',
        'http://127.0.0.1:8080\r\n', 'http://127.0.0.1:\t8080', ' http://127.0.0.1:8080',
        'http://attacker:password@127.0.0.1:8080', 'http://127.0.0.1.evil.test:8080',
        'http://evil.test:8080', 'http://127.0.0.2:8080', 'http://app.localhost:8080',
        'http://127.1:8080', 'http://2130706433:8080', 'HTTP://127.0.0.1:8080',
        'http://127.0.0.1:8081', 'https://127.0.0.1:8080', 'ftp://127.0.0.1:8080',
        'http://localhost:8080', '//127.0.0.1:8080',
    ]) {
        process.env.__FAKE_PROVIDER_BEGIN_RESPONSE = JSON.stringify({ canonicalLoginOrigin });
        await assert.rejects(createGenericAuthBridge().beginLogin({ baseUrl }), /Invalid canonical login origin/);
    }
    for (const extra of [{ authorizationUrl: 'https://fake.test/auth' }, { providerState: 'unwanted-state' }]) {
        process.env.__FAKE_PROVIDER_BEGIN_RESPONSE = JSON.stringify({ canonicalLoginOrigin: 'http://127.0.0.1:8080', ...extra });
        await assert.rejects(createGenericAuthBridge().beginLogin({ baseUrl }), /Invalid canonical login origin/);
    }
    process.env.__FAKE_PROVIDER_BEGIN_RESPONSE = JSON.stringify({ canonicalLoginOrigin: 'http://127.0.0.1:8080' });
    await assert.rejects(createGenericAuthBridge().beginLogin({ baseUrl: 'http://public.example:8080' }), /Invalid canonical login origin/);
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {
        redirectUri: 'http://127.0.0.1:8080/auth/callback',
    } });
    await assert.rejects(createGenericAuthBridge().beginLogin({ baseUrl }), /Invalid canonical login origin/);
});

test('canonical hints cannot survive a provider configuration reload in flight', async (t) => {
    t.after(() => {
        delete process.env.__FAKE_PROVIDER_BEGIN_DELAY;
        delete process.env.__FAKE_PROVIDER_BEGIN_RESPONSE;
    });
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {} });
    process.env.__FAKE_PROVIDER_BEGIN_RESPONSE = JSON.stringify({ canonicalLoginOrigin: 'http://127.0.0.1:8080' });
    process.env.__FAKE_PROVIDER_BEGIN_DELAY = '1';
    const bridge = createGenericAuthBridge();
    const callCount = readCalls().length;
    const login = bridge.beginLogin({ baseUrl: 'http://localhost:8080' });
    while (readCalls().length === callCount) await new Promise((resolve) => setTimeout(resolve, 1));
    bridge.reloadConfig();
    await assert.rejects(login, /Authorization configuration changed/);
});

test('callbacks require the initiating browser proof and remain single-use across concurrent tabs', async () => {
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {} });
    const bridge = createGenericAuthBridge();
    const first = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080', returnTo: '/first' });
    const second = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080', returnTo: '/second' });
    assert.notEqual(first.browserBinding, second.browserBinding);
    assert.equal(first.redirectUrl.includes(first.browserBinding), false);
    const callbacksBefore = readCalls().filter((call) => call.op === 'sso_handle_callback').length;
    for (const browserBinding of [undefined, '', second.browserBinding, `${first.browserBinding}x`]) {
        await assert.rejects(bridge.handleCallback({ code: 'code', state: first.state, browserBinding }), /browser binding/);
    }
    assert.equal(readCalls().filter((call) => call.op === 'sso_handle_callback').length, callbacksBefore);
    const results = await Promise.allSettled([
        bridge.handleCallback({ code: 'code', state: first.state, browserBinding: first.browserBinding }),
        bridge.handleCallback({ code: 'code', state: first.state, browserBinding: first.browserBinding }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'fulfilled').value.redirectTo, '/first');
    const callback = await bridge.handleCallback({ code: 'code', state: second.state, browserBinding: second.browserBinding });
    assert.equal(callback.redirectTo, '/second');
});

test('pending login expires at numeric or ISO provider expiry and cannot survive a configuration reload', async (t) => {
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {} });
    let now = Date.now();
    const bridge = createGenericAuthBridge({ now: () => now });
    const login = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' });
    now = login.expiresAt;
    await assert.rejects(bridge.handleCallback({ code: 'code', ...login }), /Invalid or expired/);
    t.after(() => { delete process.env.__FAKE_PROVIDER_ISO_EXPIRY; });
    process.env.__FAKE_PROVIDER_ISO_EXPIRY = '1';
    now = Date.now();
    const isoLogin = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' });
    assert.ok(isoLogin.expiresAt <= now + 61_000);
    now = isoLogin.expiresAt;
    await assert.rejects(bridge.handleCallback({ code: 'code', ...isoLogin }), /Invalid or expired/);
    now = Date.now();
    const second = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' });
    bridge.reloadConfig();
    await assert.rejects(bridge.handleCallback({ code: 'code', ...second }), /Invalid or expired/);
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
    const { state, browserBinding } = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' });
    const callback = await bridge.handleCallback({
        code: 'auth-code',
        state,
        browserBinding,
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

test('response-free SSO validation coalesces callers admitted before provider dispatch', async (t) => {
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
    const { state, browserBinding } = await bridge.beginLogin({ baseUrl: 'http://127.0.0.1:8080' });
    const callback = await bridge.handleCallback({
        code: 'auth-code',
        state,
        browserBinding,
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

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function freshFixture(t, options = {}) {
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {} });
    const bridge = createGenericAuthBridge(options);
    const { state, browserBinding } = await bridge.beginLogin({ baseUrl: 'http://localhost:8080' });
    const { sessionId } = await bridge.handleCallback({ state, browserBinding, code: 'fixture', baseUrl: 'http://localhost:8080' });
    t.after(() => { delete globalThis.__bridgeValidationFixture; });
    return { bridge, sessionId };
}

function described(providerSession, roles = ['admin'], id = 'u1') {
    return { user: { id, roles, capabilities: roles.includes('admin') ? ['admin.control'] : [] },
        providerSession: { ...providerSession, tokens: { accessToken: 'current-fixture' } } };
}

test('freshness workload records provider calls and admission latency without a TTL exception', async (t) => {
    for (const [label, sessions, width, rounds] of [['serial-one', 1, 1, 50], ['concurrent-one', 1, 10, 5], ['concurrent-four', 4, 8, 5]]) {
        const { bridge, sessionId } = await freshFixture(t);
        const ids = [sessionId];
        for (let i = 1; i < sessions; i += 1) {
            const pending = await bridge.beginLogin({ baseUrl: 'http://localhost:8080' });
            ids.push((await bridge.handleCallback({ ...pending, code: 'fixture', baseUrl: 'http://localhost:8080' })).sessionId);
        }
        let calls = 0;
        globalThis.__bridgeValidationFixture = async providerSession => {
            calls += 1;
            await new Promise(resolve => setImmediate(resolve));
            return described(providerSession);
        };
        const durations = [];
        for (let round = 0; round < rounds; round += 1) {
            await Promise.all(Array.from({ length: width }, async (_, i) => {
                const start = performance.now();
                const result = await bridge.validateSession(ids[i % ids.length]);
                assert.equal(result.user.id, 'u1');
                durations.push(performance.now() - start);
            }));
        }
        durations.sort((a, b) => a - b);
        t.diagnostic(JSON.stringify({ workload: label, admissions: width * rounds, providerCalls: calls,
            settled: durations.length, p50Ms: +durations[Math.floor(durations.length * 0.5)].toFixed(3),
            p95Ms: +durations[Math.floor(durations.length * 0.95)].toFixed(3) }));
    }
});

test('every admission sees completed demotion despite a positive configured TTL', async (t) => {
    const { bridge, sessionId } = await freshFixture(t, { ssoValidationIntervalMs: 60_000 });
    let roles = ['admin'];
    let calls = 0;
    globalThis.__bridgeValidationFixture = providerSession => { calls += 1; return described(providerSession, roles); };
    const previous = await bridge.validateSession(sessionId);
    roles = ['user'];
    const current = await bridge.validateSession(sessionId);
    assert.deepEqual(current.user.roles, ['user']);
    assert.deepEqual(previous.user.roles, ['admin'], 'the previous request keeps its own coherent snapshot');
    assert.equal(calls, 2);
});

test('late arrivals queue a fresh cohort and never share a pre-demotion dispatch', async (t) => {
    const { bridge, sessionId } = await freshFixture(t);
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    let roles = ['admin'];
    let active = 0;
    let maximum = 0;
    globalThis.__bridgeValidationFixture = async providerSession => {
        calls += 1;
        maximum = Math.max(maximum, ++active);
        const result = described(providerSession, [...roles]);
        if (calls === 1) { entered.resolve(); await release.promise; }
        active -= 1;
        return result;
    };
    const first = bridge.validateSession(sessionId);
    await entered.promise;
    roles = ['user'];
    const late = Array.from({ length: 8 }, () => bridge.validateSession(sessionId));
    release.resolve();
    assert.deepEqual((await first).user.roles, ['admin']);
    for (const result of await Promise.all(late)) assert.deepEqual(result.user.roles, ['user']);
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
});

test('explicit refresh shares the lane, preserves rotation order and returns its own token metadata', async (t) => {
    const { bridge, sessionId } = await freshFixture(t);
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    globalThis.__bridgeValidationFixture = async providerSession => {
        const sequence = ++calls;
        if (sequence === 1) { entered.resolve(); await release.promise; }
        else assert.equal(providerSession.tokens.accessToken, 'rotation-1');
        return { user: { id: 'u1', roles: [sequence === 1 ? 'admin' : 'user'] },
            providerSession: { expiresAt: Date.now() + 60_000, tokens: { accessToken: `rotation-${sequence}` } } };
    };
    const first = bridge.validateSession(sessionId);
    await entered.promise;
    const second = bridge.refreshSession(sessionId);
    release.resolve();
    const [previous, refreshed] = await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.deepEqual(previous.user.roles, ['admin']);
    assert.deepEqual(refreshed.user.roles, ['user']);
    assert.equal(previous.tokens.accessToken, 'rotation-1');
    assert.equal(refreshed.accessToken, 'rotation-2');
    assert.equal(refreshed.scope, null);
    assert.equal(bridge.getSession(sessionId).tokens.idToken, undefined);
});

test('a changed provider configuration refuses in-flight authority without requiring a TTL expiry', async (t) => {
    const { bridge, sessionId } = await freshFixture(t);
    const entered = deferred();
    const release = deferred();
    globalThis.__bridgeValidationFixture = async providerSession => {
        entered.resolve(); await release.promise; return described(providerSession);
    };
    const pending = bridge.validateSession(sessionId);
    await entered.promise;
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: { clientId: 'changed-client' } });
    release.resolve();
    assert.equal(await pending, null);
    assert.deepEqual(bridge.getSession(sessionId).user.roles, ['dev']);
    globalThis.__bridgeValidationFixture = providerSession => described(providerSession, ['user']);
    assert.deepEqual((await bridge.validateSession(sessionId)).user.roles, ['user']);
});

test('provider refusal settles both an active and a later queued cohort', async (t) => {
    const { bridge, sessionId } = await freshFixture(t);
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    globalThis.__bridgeValidationFixture = async () => {
        calls += 1; entered.resolve(); await release.promise; throw new Error('fixture refusal');
    };
    const first = bridge.validateSession(sessionId);
    await entered.promise;
    const queued = bridge.validateSession(sessionId);
    release.resolve();
    assert.deepEqual(await Promise.all([first, queued]), [null, null]);
    assert.equal(calls, 1);
});

for (const invalidate of ['revokeSession', 'logout', 'reloadConfig']) {
    test(`${invalidate} fences pending refresh and queued validation without resurrection`, async (t) => {
        const { bridge, sessionId } = await freshFixture(t);
        const entered = deferred();
        const release = deferred();
        globalThis.__bridgeValidationFixture = async providerSession => {
            entered.resolve(); await release.promise; return described(providerSession);
        };
        const refresh = bridge.refreshSession(sessionId).then(() => 'accepted', () => 'refused');
        await entered.promise;
        const queued = bridge.validateSession(sessionId);
        await bridge[invalidate](sessionId);
        release.resolve();
        assert.equal(await refresh, 'refused');
        assert.equal(await queued, null);
        if (invalidate !== 'reloadConfig') assert.equal(bridge.getSession(sessionId), null);
        else assert.deepEqual(bridge.getSession(sessionId).user.roles, ['dev']);
    });
}

for (const outcome of ['failure', 'null', 'missing-user', 'changed-user']) {
    test(`provider ${outcome} settles every caller without cached authority`, async (t) => {
        const { bridge, sessionId } = await freshFixture(t);
        globalThis.__bridgeValidationFixture = providerSession => described(providerSession);
        await bridge.validateSession(sessionId);
        globalThis.__bridgeValidationFixture = providerSession => {
            if (outcome === 'failure') throw new Error('fixture provider refused');
            if (outcome === 'null') return null;
            if (outcome === 'missing-user') return { providerSession };
            return described(providerSession, ['admin'], 'different-account');
        };
        const results = await Promise.all(Array.from({ length: 6 }, () => bridge.validateSession(sessionId)));
        assert.ok(results.every(result => result === null));
        assert.equal(bridge.getSession(sessionId), null);
    });
}

function providerUnavailable() {
    return Object.assign(new Error('fixture provider unreachable'), { providerUnavailable: true });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function recordInvalidations(t) {
    const events = [];
    t.after(onAuthenticationSessionInvalidated(event => events.push(event)));
    return events;
}

test('an unavailable provider denies the admission retryably, keeps the session and recovers with one call', async (t) => {
    const { bridge, sessionId } = await freshFixture(t);
    const invalidations = recordInvalidations(t);
    let calls = 0;
    let down = true;
    globalThis.__bridgeValidationFixture = async providerSession => {
        calls += 1;
        if (down) throw providerUnavailable();
        return described(providerSession, ['user']);
    };
    await assert.rejects(bridge.validateSession(sessionId, { reportUnavailable: true }),
        { code: 'SSO_PROVIDER_UNAVAILABLE' });
    assert.equal(await bridge.validateSession(sessionId), null, 'plain callers still receive a denial');
    assert.ok(bridge.getSession(sessionId), 'an undecided validation does not end the session');
    assert.equal(invalidations.length, 0);
    down = false;
    const before = calls;
    const recovered = await bridge.validateSession(sessionId, { reportUnavailable: true });
    assert.deepEqual(recovered.user.roles, ['user']);
    assert.equal(calls - before, 1);
});

test('a provider configuration read failure denies without ending the session', async (t) => {
    const { bridge, sessionId } = await freshFixture(t);
    t.after(() => { delete process.env.__FAKE_PROVIDER_CONFIG_FAIL; });
    globalThis.__bridgeValidationFixture = providerSession => described(providerSession, ['user']);
    process.env.__FAKE_PROVIDER_CONFIG_FAIL = '1';
    await assert.rejects(bridge.validateSession(sessionId, { reportUnavailable: true }),
        { code: 'SSO_PROVIDER_UNAVAILABLE' });
    assert.ok(bridge.getSession(sessionId));
    delete process.env.__FAKE_PROVIDER_CONFIG_FAIL;
    assert.deepEqual((await bridge.validateSession(sessionId)).user.roles, ['user']);
});

test('a definitive provider refusal still ends the session and reports a plain denial', async (t) => {
    const { bridge, sessionId } = await freshFixture(t);
    const invalidations = recordInvalidations(t);
    globalThis.__bridgeValidationFixture = async () => {
        throw Object.assign(new Error('session_revoked'), { code: 'session_revoked', statusCode: 401 });
    };
    assert.equal(await bridge.validateSession(sessionId, { reportUnavailable: true }), null);
    assert.equal(bridge.getSession(sessionId), null);
    assert.deepEqual(invalidations.map(event => [event.sessionId, event.reason]), [[sessionId, 'validation_failed']]);
});

test('a hung provider is bounded: the cohort is denied, later callers dispatch afresh and the late result is discarded', async (t) => {
    const { bridge, sessionId } = await freshFixture(t, { validationDeadlineMs: 50 });
    const invalidations = recordInvalidations(t);
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    let calls = 0;
    let hungSignal = null;
    globalThis.__bridgeValidationFixture = async (providerSession, { signal } = {}) => {
        const sequence = ++calls;
        if (sequence === 1) {
            hungSignal = signal;
            entered.resolve();
            await release.promise;
            return described(providerSession, ['stale-admin']);
        }
        return described(providerSession, ['user']);
    };
    const hung = bridge.validateSession(sessionId, { reportUnavailable: true })
        .then(() => 'granted', error => error.code);
    await entered.promise;
    const queued = bridge.validateSession(sessionId);
    assert.equal(await Promise.race([hung, sleep(1000).then(() => 'still pending')]), 'SSO_PROVIDER_UNAVAILABLE');
    assert.ok(bridge.getSession(sessionId), 'the deadline does not end the session');
    assert.equal(hungSignal?.aborted, true, 'the provider is told to stop');
    const queuedResult = await Promise.race([queued, sleep(1000).then(() => 'still pending')]);
    assert.deepEqual(queuedResult?.user?.roles, ['user'], 'a caller queued behind the hung call gets a fresh dispatch');
    assert.deepEqual((await bridge.validateSession(sessionId)).user.roles, ['user']);
    assert.equal(calls, 3);
    release.resolve();
    await sleep(20);
    assert.deepEqual(bridge.getSession(sessionId).user.roles, ['user'], 'the late result is never published');
    assert.deepEqual((await bridge.validateSession(sessionId)).user.roles, ['user']);
    assert.equal(invalidations.length, 0);
});

test('a late refusal from an abandoned provider call cannot end the session', async (t) => {
    const { bridge, sessionId } = await freshFixture(t, { validationDeadlineMs: 50 });
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    let calls = 0;
    globalThis.__bridgeValidationFixture = async providerSession => {
        if (++calls === 1) {
            entered.resolve();
            await release.promise;
            throw new Error('late fixture refusal');
        }
        return described(providerSession, ['user']);
    };
    const hung = bridge.validateSession(sessionId);
    await entered.promise;
    assert.equal(await Promise.race([hung, sleep(1000).then(() => 'still pending')]), null);
    release.resolve();
    await sleep(20);
    assert.ok(bridge.getSession(sessionId), 'the abandoned call deleted nothing');
    assert.deepEqual((await bridge.validateSession(sessionId)).user.roles, ['user']);
});

test('a configuration reload releases a hung provider call so new admissions do not wait for it', async (t) => {
    const { bridge, sessionId } = await freshFixture(t);
    const entered = deferred();
    let calls = 0;
    globalThis.__bridgeValidationFixture = async (providerSession, { signal } = {}) => {
        if (++calls === 1) {
            entered.resolve();
            await new Promise((resolve, reject) => {
                if (!signal) return;
                signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { providerUnavailable: true })),
                    { once: true });
            });
        }
        return described(providerSession, ['user']);
    };
    const stale = bridge.validateSession(sessionId);
    await entered.promise;
    bridge.reloadConfig();
    assert.equal(await stale, null);
    const fresh = await Promise.race([bridge.validateSession(sessionId), sleep(1000).then(() => 'still pending')]);
    assert.deepEqual(fresh?.user?.roles, ['user']);
    assert.equal(calls, 2);
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


test('real bridge and browser routes reject copied callbacks and issue a session only to the initiating browser', async () => {
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {} });
    const { handleAuthRoutes } = await import('../../cli/server/authHandlers/authRoutes.js');
    const { authService } = await import('../../cli/server/authHandlers/shared.js');
    authService.reloadConfig();
    const snapshot = {
        generation: 'binding-test-generation',
        agents: { explorer: { type: 'agent', agentName: 'explorer', repoName: 'fixture', auth: { mode: 'sso' } } },
        routing: { static: { agent: 'explorer' }, routes: { explorer: { agent: 'explorer', repo: 'fixture', hostPort: 0 } } },
        manifests: {},
    };
    const routePlan = {
        ok: false,
        hostSelection: { kind: 'control', host: 'localhost' },
        snapshot,
        lease: { id: snapshot.generation, snapshot, commit: () => true },
    };
    const request = async (url, cookie = '') => {
        const req = { method: 'GET', url, headers: { host: 'localhost', cookie, accept: 'application/json' }, socket: {} };
        const res = {
            statusCode: 200, headers: new Map(), body: '',
            setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
            getHeader(name) { return this.headers.get(name.toLowerCase()); },
            writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); },
            end(chunk = '') { this.body += chunk; },
        };
        await handleAuthRoutes(req, res, new URL(url, 'http://localhost'), { routePlan });
        return res;
    };
    const login = await request('/auth/login?returnTo=%2Fexplorer%2F');
    assert.equal(login.statusCode, 200, login.body);
    const loginCookie = String(login.getHeader('set-cookie'));
    assert.match(loginCookie, /^ploinky_sso_login_[A-Za-z0-9_-]{22}=/);
    assert.match(loginCookie, /Path=\/; HttpOnly; SameSite=Lax; Max-Age=60/);
    assert.doesNotMatch(loginCookie, /Domain=/);
    const browserCookie = loginCookie.split(';')[0];
    const [cookieName, browserProof] = browserCookie.split('=');
    assert.equal(login.body.includes(browserProof), false);
    const state = cookieName.slice('ploinky_sso_login_'.length);
    const callbackUrl = `/auth/callback?code=fixture-code&state=${state}`;
    for (const cookie of ['', `${cookieName}=wrong-browser-proof`]) {
        const rejected = await request(callbackUrl, cookie);
        assert.equal(rejected.statusCode, 400);
        assert.equal(JSON.parse(rejected.body).error, 'invalid_authorization_browser');
        assert.equal(rejected.getHeader('set-cookie'), undefined);
    }
    const callback = await request(callbackUrl, browserCookie);
    assert.equal(callback.statusCode, 302, callback.body);
    assert.equal(callback.getHeader('location'), '/explorer/');
    const cookies = callback.getHeader('set-cookie');
    assert.ok(cookies.some((cookie) => cookie.startsWith('ploinky_sso=')));
    assert.ok(cookies.some((cookie) => cookie.startsWith(`${cookieName}=`) && cookie.includes('Max-Age=0')));
    const replay = await request(callbackUrl, browserCookie);
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.getHeader('set-cookie'), undefined);

    routePlan.ok = true;
    routePlan.kind = 'router-surface';
    routePlan.surface = 'browser-auth';
    routePlan.hostSelection = { kind: 'agent-root', host: 'explorer.example.test', record: { routeKey: 'explorer' } };
    routePlan.forwarding = { protocol: 'https', authority: 'explorer.example.test' };
    const secureLogin = await request('/auth/login');
    assert.equal(secureLogin.statusCode, 200, secureLogin.body);
    const secureCookie = String(secureLogin.getHeader('set-cookie'));
    assert.match(secureCookie, /^__Host-ploinky_sso_login_/);
    assert.match(secureCookie, /; Secure;/);
    assert.match(secureCookie, /; Path=\//);
});

test('Router login restarts on the canonical origin before creating a fresh cookie and callback state', async () => {
    const canonicalOrigin = 'http://127.0.0.1:8080';
    writeWorkspaceSsoConfig({ enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {
        canonicalLoginOrigin: canonicalOrigin,
    } });
    const { handleAuthRoutes } = await import('../../cli/server/authHandlers/authRoutes.js');
    const { authService } = await import('../../cli/server/authHandlers/shared.js');
    authService.reloadConfig();
    const snapshot = {
        generation: 'canonical-origin-generation',
        agents: { explorer: { type: 'agent', agentName: 'explorer', repoName: 'fixture', auth: { mode: 'sso' } } },
        routing: { static: { agent: 'explorer' }, routes: { explorer: { agent: 'explorer', repo: 'fixture', hostPort: 0 } } },
        manifests: {},
    };
    const request = async (url, cookie = '') => {
        const parsedUrl = new URL(url);
        const routePlan = {
            ok: false,
            hostSelection: { kind: 'control', host: parsedUrl.hostname },
            snapshot,
            lease: { id: snapshot.generation, snapshot, commit: () => true },
        };
        const req = { method: 'GET', url, headers: { host: parsedUrl.host, cookie, accept: 'application/json' }, socket: {} };
        const res = {
            statusCode: 200, headers: new Map(), body: '',
            setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
            getHeader(name) { return this.headers.get(name.toLowerCase()); },
            writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); },
            end(chunk = '') { this.body += chunk; },
        };
        await handleAuthRoutes(req, res, parsedUrl, { routePlan });
        return res;
    };
    const returnTo = '/explorer/index.html?view=list#file-exp/Confidential/My%20Space';
    const aliasUrl = new URL('/auth/login', 'http://localhost:8080');
    aliasUrl.search = new URLSearchParams({
        returnTo, prompt: 'select_account', agent: 'explorer', state: 'old-state', requestId: 'old-request',
    }).toString();
    const oldCookie = `ploinky_sso_login_${'o'.repeat(22)}=old-browser-proof`;
    const alias = await request(aliasUrl.href, oldCookie);
    assert.equal(alias.statusCode, 303, alias.body);
    assert.equal(alias.getHeader('cache-control'), 'no-store');
    assert.equal(alias.getHeader('set-cookie'), undefined);
    assert.equal(alias.body, '');
    const canonicalUrl = new URL(alias.getHeader('location'));
    assert.equal(canonicalUrl.origin, canonicalOrigin);
    assert.equal(canonicalUrl.pathname, '/auth/login');
    assert.deepEqual(Object.fromEntries(canonicalUrl.searchParams), { returnTo, prompt: 'select_account', agent: 'explorer' });

    const login = await request(canonicalUrl.href);
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.getHeader('location'), undefined);
    const cookie = String(login.getHeader('set-cookie'));
    assert.match(cookie, /^ploinky_sso_login_[A-Za-z0-9_-]{22}=/);
    assert.match(cookie, /Path=\/; HttpOnly; SameSite=Lax; Max-Age=60/);
    assert.doesNotMatch(cookie, /Domain=|old-browser-proof/);
    const browserCookie = cookie.split(';')[0];
    const [cookieName, browserProof] = browserCookie.split('=');
    assert.equal(login.body.includes(browserProof), false);
    const state = cookieName.slice('ploinky_sso_login_'.length);
    const callbackUrl = `${canonicalOrigin}/auth/callback?code=fixture-code&state=${state}`;
    const rejected = await request(callbackUrl, oldCookie);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.getHeader('set-cookie'), undefined);
    const callback = await request(callbackUrl, browserCookie);
    assert.equal(callback.statusCode, 302, callback.body);
    assert.equal(callback.getHeader('location'), returnTo);
    assert.ok(callback.getHeader('set-cookie').some((value) => value.startsWith('ploinky_sso=')));
});
