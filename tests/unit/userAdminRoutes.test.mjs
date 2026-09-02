import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '3'.repeat(64);
let mintAdminCsrfToken = null;
let getLocalSession = null;

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

function makeRequest({
    method = 'GET',
    url,
    body,
    cookie = '',
    csrf = 'valid',
    host = 'localhost',
    origin = '',
}) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = Readable.from(chunks);
    req.method = method;
    req.url = url;
    req.headers = {
        accept: 'application/json',
        host,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    req.socket = { encrypted: false };
    if (['POST', 'PATCH', 'DELETE'].includes(method) && csrf !== 'missing') {
        req.headers.origin = origin || 'http://localhost';
        const authCookiePart = String(cookie).split(';').map((part) => part.trim()).find((part) => (
            part.startsWith('ploinky_jwt=') || part.startsWith('ploinky_sso=')
        ));
        const sessionId = authCookiePart ? authCookiePart.slice(authCookiePart.indexOf('=') + 1) : '';
        req.session = getLocalSession?.(sessionId) || null;
        if (csrf !== 'browser') req.headers['x-ploinky-csrf-token'] = csrf === 'valid' && mintAdminCsrfToken
            ? mintAdminCsrfToken({ sessionId, req })
            : 'v1.invalid';
    }
    return req;
}

async function invoke(handler, options) {
    const req = makeRequest(options);
    const res = new MockResponse();
    const parsedUrl = new URL(options.url, options.origin || `http://${options.host || 'localhost'}`);
    const handled = await handler(req, res, parsedUrl, {
        routePlan: options.routePlan || null,
    });
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

function responseCookie(result, name) {
    const header = result.headers.get('set-cookie');
    const values = Array.isArray(header) ? header : [header];
    for (const value of values.filter(Boolean)) {
        const match = String(value).match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
        if (match) return `${name}=${match[1]}`;
    }
    return '';
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
    ({ mintAdminCsrfToken } = await import(pathToFileURL(path.join(REPO_ROOT, 'cli/server/adminControlSecurity.js')).href));
    const localService = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/auth/localService.js')).href}?test=${nonce}`);
    ({ getSession: getLocalSession } = await import(pathToFileURL(path.join(REPO_ROOT, 'cli/server/auth/localService.js')).href));
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
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.users.map((user) => user.username), ['admin', 'user']);
    assert.match(String(result.headers.get('set-cookie') || ''), /ploinky_jwt=/);
    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/users?start=1&pageSize=1',
        cookie: authCookie(explorerAdmin.sessionId),
    });
    assert.deepEqual(result.body.users.map((user) => user.username), ['user']);
    assert.equal(result.body.totalCount, 2);
    assert.equal(result.body.start, 1);
    assert.equal(result.body.hasMore, false);

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/settings',
        cookie: authCookie(explorerAdmin.sessionId),
    });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.body.settings.loginBrandingName, 'Login');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'PATCH',
        url: '/api/agents/explorer/settings',
        cookie: authCookie(explorerAdmin.sessionId),
        body: {
            loginBrandingName: 'Acme Workspace',
        },
    });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.body.settings.loginBrandingName, 'Acme Workspace');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/users',
    });
    assert.equal(result.statusCode, 401);
    assert.equal(result.body.error, 'authentication_required');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'PATCH',
        url: '/api/agents/explorer/settings',
        cookie: authCookie(explorerAdmin.sessionId),
        csrf: 'missing',
        body: { loginBrandingName: 'Cross-site mutation' },
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.error, 'control_origin_required');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'PATCH',
        url: '/api/agents/explorer/settings',
        cookie: authCookie(explorerAdmin.sessionId),
        csrf: 'invalid',
        body: { loginBrandingName: 'Invalid mutation proof' },
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.error, 'csrf_invalid');

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

    const publicSnapshot = {
        generation: 'public-generation-a',
        routing: {
            static: { agent: 'explorer' },
            routes: {
                explorer: { repo: 'AssistOSExplorer', agent: 'explorer' },
                dpuAgent: { repo: 'AssistOSExplorer', agent: 'dpuAgent' },
            },
        },
        agents: JSON.parse(readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8')),
        manifests: {},
    };
    const publicRoutePlan = (generation = publicSnapshot.generation, commit = () => true) => ({
        ok: true,
        kind: 'router-surface',
        surface: 'user-admin',
        listener: 'public',
        host: 'explorer.example.test',
        hostSelection: {
            kind: 'agent-root',
            source: 'public-host',
            host: 'explorer.example.test',
            record: { routeKey: 'explorer' },
        },
        forwarding: {
            protocol: 'https',
            authority: 'explorer.example.test',
        },
        snapshot: { ...publicSnapshot, generation },
        lease: {
            id: generation,
            snapshot: { ...publicSnapshot, generation },
            commit,
        },
    });

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/users',
        host: 'explorer.example.test',
        origin: 'https://explorer.example.test',
        cookie: authCookie(explorerAdmin.sessionId),
        routePlan: publicRoutePlan(),
    });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.users.map((user) => user.username), ['admin', 'user']);
    const userAdminProof = responseCookie(result, 'ploinky_user_admin_csrf');
    assert.match(userAdminProof, /^ploinky_user_admin_csrf=v2\./);
    assert.match(
        String(result.headers.get('set-cookie')),
        /ploinky_user_admin_csrf=.*Path=\/api\/agents\/explorer; HttpOnly; SameSite=Strict/,
    );

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/settings',
        host: 'explorer.example.test',
        origin: 'https://explorer.example.test',
        cookie: authCookie(explorerAdmin.sessionId),
        routePlan: publicRoutePlan(),
    });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.body.settings.loginBrandingName, 'Acme Workspace');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'POST',
        url: '/api/agents/explorer/users',
        host: 'explorer.example.test',
        origin: 'https://explorer.example.test',
        cookie: `${authCookie(explorerAdmin.sessionId)}; ${
            userAdminProof.replace('ploinky_user_admin_csrf=', 'ploinky_browser_csrf=')
        }`,
        csrf: 'browser',
        body: {
            username: 'wrong-proof-cookie',
            password: 'wrong-proof-cookie-pass',
        },
        routePlan: publicRoutePlan(),
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.error, 'browser_csrf_invalid');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'POST',
        url: '/api/agents/explorer/users',
        host: 'explorer.example.test',
        origin: 'https://explorer.example.test',
        cookie: `${authCookie(explorerAdmin.sessionId)}; ${userAdminProof}`,
        csrf: 'browser',
        body: {
            username: 'qa-editor',
            password: 'qa-editor-pass',
            roles: ['editor'],
        },
        routePlan: publicRoutePlan(),
    });
    assert.equal(result.statusCode, 201, JSON.stringify(result.body));
    assert.equal(result.body.user.username, 'qa-editor');
    const publicUserId = result.body.user.id;

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'PATCH',
        url: `/api/agents/explorer/users/${encodeURIComponent(publicUserId)}`,
        host: 'explorer.example.test',
        origin: 'https://explorer.example.test',
        cookie: `${authCookie(explorerAdmin.sessionId)}; ${userAdminProof}`,
        csrf: 'browser',
        body: { roles: ['admin'] },
        routePlan: publicRoutePlan(),
    });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.user.roles, ['user', 'admin']);

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'DELETE',
        url: `/api/agents/explorer/users/${encodeURIComponent(publicUserId)}`,
        host: 'explorer.example.test',
        origin: 'https://explorer.example.test',
        cookie: `${authCookie(explorerAdmin.sessionId)}; ${userAdminProof}`,
        csrf: 'browser',
        routePlan: publicRoutePlan(),
    });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.body.deleted, true);

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'POST',
        url: '/api/agents/explorer/users',
        host: 'explorer.example.test',
        origin: 'https://cross-origin.invalid',
        cookie: `${authCookie(explorerAdmin.sessionId)}; ${userAdminProof}`,
        csrf: 'browser',
        body: {
            username: 'cross-origin',
            password: 'cross-origin-pass',
        },
        routePlan: publicRoutePlan(),
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.error, 'browser_origin_required');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'POST',
        url: '/api/agents/explorer/users',
        host: 'explorer.example.test',
        origin: 'https://explorer.example.test',
        cookie: `${authCookie(explorerAdmin.sessionId)}; ${userAdminProof}`,
        csrf: 'browser',
        body: {
            username: 'stale-generation',
            password: 'stale-generation-pass',
        },
        routePlan: publicRoutePlan('public-generation-b'),
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.error, 'browser_csrf_invalid');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/users',
        host: 'explorer.example.test',
        origin: 'https://explorer.example.test',
        cookie: authCookie(explorerUser.sessionId),
        routePlan: publicRoutePlan(),
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.error, 'admin_required');
    assert.equal(responseCookie(result, 'ploinky_user_admin_csrf'), '');

    const ssoSnapshot = {
        generation: 'sso-user-admin-generation',
        routing: {
            static: { agent: 'explorer' },
            routes: { explorer: { repo: 'AssistOSExplorer', agent: 'explorer' } },
        },
        agents: {
            explorer: {
                type: 'agent',
                agentName: 'explorer',
                repoName: 'AssistOSExplorer',
                auth: { mode: 'sso' },
            },
        },
        manifests: {},
    };
    const ssoRoutePlan = {
        snapshot: ssoSnapshot,
        lease: { id: ssoSnapshot.generation, snapshot: ssoSnapshot, commit: () => true },
    };
    const authService = authHandlers.authService;
    const originals = {
        isConfigured: authService.isConfigured,
        validateSession: authService.validateSession,
        listUsers: authService.listUsers,
        createUser: authService.createUser,
    };
    const providerCalls = [];
    authService.isConfigured = () => true;
    authService.validateSession = async (sessionId, options) => {
        providerCalls.push({ operation: 'validateSession', sessionId, options });
        if (sessionId === 'sso-role-only-session') {
            return {
                user: {
                    id: 'role-only-admin',
                    roles: ['admin'],
                    capabilities: [],
                },
                expiresAt: Date.now() + 60_000,
            };
        }
        return sessionId === 'sso-admin-session'
            ? {
                user: {
                    id: 'persisto-admin',
                    username: 'owner@example.test',
                    roles: ['owner'],
                    capabilities: ['admin.users.manage'],
                },
                expiresAt: Date.now() + 60_000,
            }
            : null;
    };
    authService.listUsers = async (payload) => {
        providerCalls.push({ operation: 'listUsers', payload });
        const users = Array.from({ length: 601 }, (_, index) => ({
            id: `persisto-user-${index}`, email: index ? `member-${index}@example.test` : 'member@example.test', roles: ['user'],
        }));
        return {
            users: users.slice(payload.start, payload.start + payload.pageSize),
            totalCount: users.length,
            availableRoles: ['admin', 'user'],
        };
    };
    authService.createUser = async (payload) => {
        providerCalls.push({ operation: 'createUser', payload });
        return { id: 'persisto-new-user', email: payload.email, roles: payload.roles };
    };
    try {
        result = await invoke(authHandlers.handleUserAdminRoutes, {
            url: '/api/agents/explorer/users',
            cookie: 'ploinky_sso=sso-role-only-session',
            routePlan: ssoRoutePlan,
        });
        assert.equal(result.statusCode, 403);
        assert.equal(result.body.error, 'admin_required');

        result = await invoke(authHandlers.handleUserAdminRoutes, {
            url: '/api/agents/explorer/users',
            cookie: 'ploinky_sso=sso-admin-session',
            routePlan: ssoRoutePlan,
        });
        assert.equal(result.statusCode, 200, JSON.stringify(result.body));
        assert.equal(result.body.users[0].email, 'member@example.test');

        result = await invoke(authHandlers.handleUserAdminRoutes, {
            method: 'POST',
            url: '/api/agents/explorer/users',
            cookie: 'ploinky_sso=sso-admin-session',
            body: { email: 'new@example.test', password: 'new-user-pass', roles: ['user'] },
            routePlan: ssoRoutePlan,
        });
        assert.equal(result.statusCode, 201, JSON.stringify(result.body));
        assert.equal(result.body.user.id, 'persisto-new-user');
        assert.equal(providerCalls.filter((call) => call.operation === 'validateSession').length, 3);
        assert.ok(providerCalls
            .filter((call) => call.operation === 'validateSession')
            .every((call) => call.options?.forceRemote === true));
        assert.equal(providerCalls.find((call) => call.operation === 'createUser').payload.actorUserId, 'persisto-admin');
        result = await invoke(authHandlers.handleUserAdminRoutes, {
            url: '/api/agents/explorer/users?start=500&pageSize=100',
            cookie: 'ploinky_sso=sso-admin-session',
            routePlan: ssoRoutePlan,
        });
        assert.equal(result.statusCode, 200);
        assert.equal(result.body.users[0].id, 'persisto-user-500');
        assert.equal(result.body.totalCount, 601);
        assert.equal(result.body.hasMore, true);
        assert.deepEqual(providerCalls.filter((call) => call.operation === 'listUsers').at(-1).payload,
            { actorUserId: 'persisto-admin', start: 500, pageSize: 100 });
        result = await invoke(authHandlers.handleUserAdminRoutes, {
            url: '/api/agents/explorer/users?start=600&pageSize=100',
            cookie: 'ploinky_sso=sso-admin-session',
            routePlan: ssoRoutePlan,
        });
        assert.equal(result.body.users[0].id, 'persisto-user-600');
        assert.equal(result.body.hasMore, false);
        const listCallsBefore = providerCalls.filter((call) => call.operation === 'listUsers').length;
        for (const query of ['start=-1', 'start=1.5', 'start=9007199254740992', 'pageSize=0', 'pageSize=501', 'pageSize=oops']) {
            result = await invoke(authHandlers.handleUserAdminRoutes, {
                url: `/api/agents/explorer/users?${query}`,
                cookie: 'ploinky_sso=sso-admin-session',
                routePlan: ssoRoutePlan,
            });
            assert.equal(result.statusCode, 400, query);
            assert.equal(result.body.error, 'invalid_pagination');
        }
        assert.equal(providerCalls.filter((call) => call.operation === 'listUsers').length, listCallsBefore);
    } finally {
        Object.assign(authService, originals);
    }
});
