import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '4'.repeat(64);

const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const originalWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-required-capability-'));
const ploinkyDir = path.join(workspace, '.ploinky');
const explorerDir = path.join(ploinkyDir, 'repos', 'AchillesIDE', 'explorer');
const providerDir = path.join(ploinkyDir, 'repos', 'fake', 'fakeProvider');

mkdirSync(explorerDir, { recursive: true });
mkdirSync(path.join(providerDir, 'runtime'), { recursive: true });
writeFileSync(path.join(explorerDir, 'manifest.json'), JSON.stringify({
    routerAccess: {
        requiredCapability: 'explorer.access',
    },
}, null, 2));
writeFileSync(path.join(providerDir, 'manifest.json'), JSON.stringify({
    ssoProvider: true,
}, null, 2));
writeFileSync(path.join(providerDir, 'runtime', 'index.mjs'), `
export function resolveProviderConfig({ providerConfig = {} } = {}) {
    return {
        issuerBaseUrl: providerConfig.issuerBaseUrl || 'https://fake.test',
        clientId: providerConfig.clientId || 'fake-client'
    };
}

export function createProvider() {
    return {
        async sso_begin_login() {
            return {
                authorizationUrl: 'https://fake.test/auth?state=PROVIDER_STATE',
                providerState: 'PROVIDER_STATE',
                expiresAt: Date.now() + 60_000
            };
        },
        async sso_handle_callback() {
            return {
                user: {
                    id: 'u1',
                    username: 'alice',
                    email: 'alice@test',
                    roles: ['user'],
                    capabilities: ['initial.access']
                },
                providerSession: {
                    provider: 'fake/fakeProvider',
                    tokens: { accessToken: 'AT', refreshToken: 'RT', tokenType: 'Bearer' },
                    expiresAt: Date.now() + 60_000,
                    refreshExpiresAt: Date.now() + 120_000
                }
            };
        },
        async sso_refresh_session({ providerSession }) {
            return {
                user: {
                    id: 'u1',
                    username: 'alice',
                    email: 'alice@test',
                    roles: ['user'],
                    capabilities: ['refreshed.access']
                },
                providerSession: {
                    ...providerSession,
                    tokens: { ...(providerSession?.tokens || {}), accessToken: 'AT2' },
                    expiresAt: Date.now() + 60_000,
                    refreshExpiresAt: Date.now() + 120_000
                }
            };
        },
        async sso_logout() {
            return { redirectUrl: 'https://fake.test/logout' };
        }
    };
}
`);
writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
    explorer: {
        type: 'agent',
        agentName: 'explorer',
        repoName: 'AchillesIDE',
        auth: { mode: 'sso' },
    },
    _config: {
        sso: {
            enabled: true,
            providerAgent: 'fake/fakeProvider',
            providerConfig: {
                issuerBaseUrl: 'https://fake.test',
                clientId: 'fake-client',
            },
        },
    },
}, null, 2));
writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
    routes: {
        explorer: {
            agent: 'explorer',
            repo: 'AchillesIDE',
            hostPort: 55289,
            hostPath: explorerDir,
        },
    },
    static: {
        agent: 'explorer',
        hostPath: explorerDir,
    },
}, null, 2));

process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const { evaluateRequiredCapability } = await import(`../../cli/server/authHandlers/requiredCapability.mjs${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_MASTER_KEY;
    } else {
        process.env.PLOINKY_MASTER_KEY = originalMasterKey;
    }
    if (originalWorkspaceRoot === undefined) {
        delete process.env.PLOINKY_WORKSPACE_ROOT;
    } else {
        process.env.PLOINKY_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
    rmSync(workspace, { recursive: true, force: true });
});

class MockResponse {
    constructor() {
        this.statusCode = 200;
        this.headers = new Map();
        this.body = '';
    }

    setHeader(name, value) {
        this.headers.set(String(name).toLowerCase(), value);
    }

    getHeader(name) {
        return this.headers.get(String(name).toLowerCase());
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        for (const [name, value] of Object.entries(headers || {})) {
            this.setHeader(name, value);
        }
    }

    end(chunk = '') {
        this.body += chunk ? String(chunk) : '';
    }
}

function makeRequest({ method = 'GET', url, cookie = '', accept = 'application/json' }) {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.headers = {
        accept,
        host: 'localhost',
        ...(cookie ? { cookie } : {}),
    };
    req.socket = { encrypted: false };
    return req;
}

async function importAuthHandlers() {
    const nonce = `${Date.now()}-${Math.random()}`;
    return import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/authHandlers/index.js')).href}?test=${nonce}`);
}

async function importGenericAuthBridge() {
    const nonce = `${Date.now()}-${Math.random()}`;
    return import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/auth/genericAuthBridge.js')).href}?test=${nonce}`);
}

test('capability gate', () => {
    const record = { routerAccess: { requiredCapability: 'explorer.access' } };
    assert.equal(evaluateRequiredCapability(record, { capabilities: ['explorer.access'] }).ok, true);
    assert.equal(evaluateRequiredCapability(record, { capabilities: ['selfregistered.dashboard.access'] }).ok, false);
    assert.equal(evaluateRequiredCapability(record, { roles: ['admin'], capabilities: [] }).ok, false);
    assert.equal(evaluateRequiredCapability({}, { capabilities: [] }).ok, true);
});

test('authenticated route denies user missing manifest required capability', async (t) => {
    const authHandlers = await importAuthHandlers();
    const originalIsConfigured = authHandlers.authService.isConfigured;
    const originalGetSession = authHandlers.authService.getSession;
    authHandlers.authService.isConfigured = () => true;
    authHandlers.authService.getSession = (id) => id === 'sso-cookie-1'
        ? {
            user: { id: 'sso:alice', username: 'alice', roles: ['user'], capabilities: [] },
            expiresAt: Date.now() + 60_000,
        }
        : null;
    t.after(() => {
        authHandlers.authService.isConfigured = originalIsConfigured;
        authHandlers.authService.getSession = originalGetSession;
    });

    const req = makeRequest({
        method: 'GET',
        url: '/explorer/settings',
        cookie: 'ploinky_sso=sso-cookie-1',
    });
    const res = new MockResponse();
    const result = await authHandlers.ensureHttpRouteAccess(
        req,
        res,
        new URL(req.url, 'http://localhost'),
        { access: 'authenticated', routeKey: 'explorer', source: 'policy' },
    );
    const body = JSON.parse(res.body || '{}');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'CAPABILITY_REQUIRED');
    assert.equal(res.statusCode, 403);
    assert.deepEqual(body, { ok: false, error: 'CAPABILITY_REQUIRED' });
});

test('SSO refresh stores refreshed user capabilities', async () => {
    const { createGenericAuthBridge } = await importGenericAuthBridge();
    const bridge = createGenericAuthBridge();
    const login = await bridge.beginLogin({
        baseUrl: 'http://127.0.0.1:8080',
        returnTo: '/explorer/settings',
    });
    const callback = await bridge.handleCallback({
        code: 'auth-code',
        state: login.state,
        baseUrl: 'http://127.0.0.1:8080',
    });
    assert.deepEqual(bridge.getSession(callback.sessionId).user.capabilities, ['initial.access']);

    await bridge.refreshSession(callback.sessionId);

    assert.deepEqual(bridge.getSession(callback.sessionId).user.capabilities, ['refreshed.access']);
});
