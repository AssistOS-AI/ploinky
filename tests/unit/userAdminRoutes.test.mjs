import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '3'.repeat(64);

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

function makeRequest({ method = 'GET', url, body, cookie = '' }) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = Readable.from(chunks);
    req.method = method;
    req.url = url;
    req.headers = {
        accept: 'application/json',
        host: 'localhost',
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    req.socket = { encrypted: false };
    return req;
}

async function invoke(handler, options) {
    const req = makeRequest(options);
    const res = new MockResponse();
    const parsedUrl = new URL(options.url, 'http://localhost');
    const handled = await handler(req, res, parsedUrl);
    return {
        handled,
        statusCode: res.statusCode,
        headers: res.headers,
        body: res.body ? JSON.parse(res.body) : null,
    };
}

function authCookie(sessionId) {
    return `ploinky_jwt=${sessionId}`;
}

function userRecord(passwords, {
    username,
    password,
    roles = ['local'],
    rev = 1,
}) {
    return {
        id: `local:${username}`,
        username,
        name: username,
        email: null,
        passwordHash: passwords.hashPassword(password),
        roles,
        rev,
    };
}

test('user admin routes enforce admin access, CRUD, rev invalidation, and agent isolation', async (t) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-user-admin-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    mkdirSync(ploinkyDir, { recursive: true });

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
    const authHandlers = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/authHandlers/index.js')).href}?test=${nonce}`);
    const localService = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/auth/localService.js')).href}?test=${nonce}`);
    const passwordStore = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/utils/security/encryptedPasswordStore.js')).href}?test=${nonce}`);
    const passwords = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/utils/security/localAuthPasswords.js')).href}?test=${nonce}`);

    const explorerPolicy = { usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' };
    const dpuPolicy = { usersVar: 'PLOINKY_AUTH_DPUAGENT_USERS' };
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'AssistOSExplorer',
            auth: { mode: 'local', ...explorerPolicy },
        },
        dpuAgent: {
            type: 'agent',
            agentName: 'dpuAgent',
            repoName: 'AssistOSExplorer',
            auth: { mode: 'local', ...dpuPolicy },
        },
    }, null, 2));

    passwordStore.setUsersPayload(explorerPolicy.usersVar, {
        version: 1,
        users: [
            userRecord(passwords, {
                username: 'admin',
                password: 'adminpass',
                roles: ['local', 'admin'],
            }),
            userRecord(passwords, {
                username: 'user',
                password: 'userpass',
                roles: ['local'],
            }),
        ],
    });
    passwordStore.setUsersPayload(dpuPolicy.usersVar, {
        version: 1,
        users: [
            userRecord(passwords, {
                username: 'admin',
                password: 'dpupass',
                roles: ['local', 'admin'],
            }),
        ],
    });

    const explorerAdmin = localService.authenticateLocalUser({
        username: 'admin',
        password: 'adminpass',
        policy: explorerPolicy,
        routeKey: 'explorer',
    });
    const explorerUser = localService.authenticateLocalUser({
        username: 'user',
        password: 'userpass',
        policy: explorerPolicy,
        routeKey: 'explorer',
    });
    const dpuAdmin = localService.authenticateLocalUser({
        username: 'admin',
        password: 'dpupass',
        policy: dpuPolicy,
        routeKey: 'dpuAgent',
    });

    let result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/users',
        cookie: authCookie(explorerAdmin.sessionId),
    });
    assert.equal(result.handled, true);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.users.map((user) => user.username), ['admin', 'user']);
    assert.match(String(result.headers.get('set-cookie') || ''), /ploinky_jwt=/);

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/settings',
        cookie: authCookie(explorerAdmin.sessionId),
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.settings.loginBrandingName, 'Login');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'PATCH',
        url: '/api/agents/explorer/settings',
        cookie: authCookie(explorerAdmin.sessionId),
        body: {
            loginBrandingName: 'Acme Workspace',
        },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.settings.loginBrandingName, 'Acme Workspace');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/users',
        cookie: authCookie(explorerUser.sessionId),
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.error, 'admin_required');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/dpuAgent/users',
        cookie: authCookie(explorerAdmin.sessionId),
    });
    assert.equal(result.statusCode, 401);
    assert.equal(result.body.error, 'authentication_required');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'POST',
        url: '/api/agents/explorer/users',
        cookie: authCookie(explorerAdmin.sessionId),
        body: {
            username: 'editor',
            password: 'editorpass',
            name: 'Editor',
            email: 'editor@example.com',
            roles: ['editor'],
        },
    });
    assert.equal(result.statusCode, 201);
    assert.equal(result.body.user.username, 'editor');
    assert.deepEqual(result.body.user.roles, ['user', 'editor']);

    const editorLogin = localService.authenticateLocalUser({
        username: 'editor',
        password: 'editorpass',
        policy: explorerPolicy,
        routeKey: 'explorer',
    });

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'PATCH',
        url: '/api/agents/explorer/users/local%3Aeditor',
        cookie: authCookie(explorerAdmin.sessionId),
        body: {
            roles: ['admin'],
            password: 'editorpass2',
        },
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.user.roles, ['user', 'admin']);
    assert.equal(localService.getSession(editorLogin.sessionId, { policy: explorerPolicy }), null);

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/dpuAgent/users',
        cookie: authCookie(dpuAdmin.sessionId),
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.users.map((user) => user.username), ['admin']);

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'DELETE',
        url: '/api/agents/explorer/users/local%3Aeditor',
        cookie: authCookie(explorerAdmin.sessionId),
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.deleted, true);

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'DELETE',
        url: '/api/agents/explorer/users/local%3Aadmin',
        cookie: authCookie(explorerAdmin.sessionId),
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error, 'last_admin_required');
});
