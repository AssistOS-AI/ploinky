import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

// The Router's auth service is a module singleton whose store states are
// one-way, so these route checks run in their own process.
const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-sso-logout-'));
const providerDir = path.join(tempDir, '.ploinky', 'repos', 'fake', 'fakeProvider');
fs.mkdirSync(path.join(providerDir, 'runtime'), { recursive: true });
fs.writeFileSync(path.join(providerDir, 'manifest.json'), JSON.stringify({ ssoProvider: true }));
fs.writeFileSync(path.join(providerDir, 'runtime', 'index.mjs'), `
export function resolveProviderConfig() { return { issuerBaseUrl: 'https://fake.test', clientId: 'fake-client' }; }
export function createProvider() {
    return {
        async sso_begin_login() {
            return { authorizationUrl: 'https://fake.test/auth?state=P', providerState: 'P', expiresAt: Date.now() + 60_000 };
        },
        async sso_handle_callback() {
            return { user: { id: 'u1', username: 'alice' },
                providerSession: { tokens: { accessToken: 'AT' }, expiresAt: Date.now() + 60_000 } };
        },
        async sso_refresh_session({ providerSession }) { return { user: { id: 'u1', username: 'alice' }, providerSession }; },
        async sso_logout() { return { redirectUrl: 'https://fake.test/logout' }; },
    };
}
`);
fs.writeFileSync(path.join(tempDir, '.ploinky', 'agents.json'), JSON.stringify({
    _config: { sso: { enabled: true, providerAgent: 'fake/fakeProvider', providerConfig: {} } },
}));
process.chdir(tempDir);
test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const { handleAuthRoutes } = await import('../../cli/server/authHandlers/authRoutes.js');
const { authService } = await import('../../cli/server/authHandlers/shared.js');
const { BROWSER_CSRF_COOKIE_NAME } = await import('../../cli/server/browserMutationSecurity.js');

const snapshot = {
    generation: 'logout-persistence-generation',
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

async function request(url, { method = 'GET', cookie = '', body, headers = {} } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.headers = {
        host: 'localhost', accept: 'application/json', cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
    };
    req.socket = { encrypted: false };
    const res = {
        statusCode: 200, headers: new Map(), body: '',
        setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
        getHeader(name) { return this.headers.get(name.toLowerCase()); },
        writeHead(status, extra = {}) { this.statusCode = status; for (const [name, value] of Object.entries(extra)) this.setHeader(name, value); },
        end(chunk = '') { this.body += chunk; },
    };
    await handleAuthRoutes(req, res, new URL(url, 'http://localhost'), { routePlan });
    return res;
}

function setCookies(res) {
    const value = res.getHeader('set-cookie');
    return value === undefined ? [] : [].concat(value).map(String);
}

function cookieValue(res, name) {
    const cookie = setCookies(res).find(entry => entry.startsWith(`${name}=`));
    return cookie ? cookie.split(';')[0].slice(name.length + 1) : '';
}

test('logout and callback answer 503 while the store is not open, and a non-durable logout is never reported as done', async () => {
    const fail = {};
    const failing = (name) => (...args) => {
        if (fail[name]) throw Object.assign(new Error(`injected ${fail[name]}`), { code: fail[name] });
        return fs[name](...args);
    };
    const key = crypto.randomBytes(32);
    authService.configureSessionPersistence({
        directory: path.join(tempDir, '.ploinky', 'data', 'router-security'),
        deriveKey: () => Buffer.from(key),
        fsApi: { ...fs, renameSync: failing('renameSync'), unlinkSync: failing('unlinkSync') },
    });

    const unopenedLogout = await request('/auth/logout', { cookie: 'ploinky_sso=existing-cookie' });
    assert.equal(unopenedLogout.statusCode, 503);
    assert.equal(JSON.parse(unopenedLogout.body).error, 'authentication_unavailable');
    assert.equal(unopenedLogout.getHeader('retry-after'), '5');
    assert.equal(unopenedLogout.getHeader('cache-control'), 'no-store');
    assert.deepEqual(setCookies(unopenedLogout), [], 'the session cookie is kept');

    const login = await request('/auth/login?returnTo=%2Fexplorer%2F');
    assert.equal(login.statusCode, 303, login.body);
    const bindingCookie = setCookies(login)[0].split(';')[0];
    const state = bindingCookie.split('=')[0].slice('ploinky_sso_login_'.length);
    const callbackUrl = `/auth/callback?code=fixture-code&state=${state}`;
    const unopenedCallback = await request(callbackUrl, { cookie: bindingCookie });
    assert.equal(unopenedCallback.statusCode, 503, unopenedCallback.body);
    assert.equal(JSON.parse(unopenedCallback.body).error, 'authentication_unavailable');
    assert.equal(unopenedCallback.getHeader('retry-after'), '5');
    assert.deepEqual(setCookies(unopenedCallback), []);

    assert.deepEqual(authService.openSessionStore(), { restored: 0, dropped: 0, rejected: null });
    const callback = await request(callbackUrl, { cookie: bindingCookie });
    assert.equal(callback.statusCode, 302, callback.body);
    const sessionId = cookieValue(callback, 'ploinky_sso');
    const csrfToken = cookieValue(callback, BROWSER_CSRF_COOKIE_NAME);
    assert.ok(sessionId && csrfToken);

    fail.renameSync = 'EROFS';
    fail.unlinkSync = 'EROFS';
    const logout = await request('/auth/logout', {
        method: 'POST',
        cookie: `ploinky_sso=${sessionId}; ${BROWSER_CSRF_COOKIE_NAME}=${csrfToken}`,
        body: { csrfToken },
        headers: { origin: 'http://localhost' },
    });
    assert.equal(logout.statusCode, 503, logout.body);
    assert.deepEqual(JSON.parse(logout.body), { ok: false, error: 'logout_not_persisted' });
    assert.equal(logout.getHeader('cache-control'), 'no-store');
    assert.equal(logout.getHeader('location'), undefined);
    const cleared = setCookies(logout);
    assert.ok(cleared.some(entry => entry.startsWith('ploinky_sso=;') && entry.includes('Max-Age=0')));
    assert.ok(cleared.some(entry => entry.startsWith(`${BROWSER_CSRF_COOKIE_NAME}=;`) && entry.includes('Max-Age=0')));
    assert.equal(authService.getSession(sessionId), null);

    delete fail.renameSync;
    delete fail.unlinkSync;
    authService.closeSessionStore();
    const closedLogout = await request('/auth/logout', { cookie: `ploinky_sso=${sessionId}` });
    assert.equal(closedLogout.statusCode, 503);
    assert.deepEqual(setCookies(closedLogout), []);
});
