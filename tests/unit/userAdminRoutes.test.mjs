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

function responseCookie(result, name) {
    const header = result.headers.get('set-cookie');
    const values = Array.isArray(header) ? header : [header];
    for (const value of values.filter(Boolean)) {
        const match = String(value).match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
        if (match) return `${name}=${match[1]}`;
    }
    return '';
}

test('provider user administration enforces capabilities, CRUD, pagination, and mutation proofs', async (t) => {
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
    let result;
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
        updateUser: authService.updateUser,
        deleteUser: authService.deleteUser,
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
    authService.updateUser = async (payload) => {
        providerCalls.push({ operation: 'updateUser', payload });
        return { id: payload.userId, email: payload.email, roles: payload.roles };
    };
    authService.deleteUser = async (payload) => {
        providerCalls.push({ operation: 'deleteUser', payload });
        return { id: payload.userId };
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

        for (const csrf of ['missing', 'invalid']) {
            const before = providerCalls.filter(call => call.operation === 'createUser').length;
            result = await invoke(authHandlers.handleUserAdminRoutes, {
                method: 'POST', url: '/api/agents/explorer/users', cookie: 'ploinky_sso=sso-admin-session',
                body: { email: 'blocked@example.test', password: 'long-password' }, csrf, routePlan: ssoRoutePlan,
            });
            assert.equal(result.statusCode, 403);
            assert.equal(providerCalls.filter(call => call.operation === 'createUser').length, before);
        }
        const publicPlan = {
            ...ssoRoutePlan, ok: true, kind: 'router-surface', surface: 'user-admin', listener: 'public',
            hostSelection: { kind: 'agent-root', record: { routeKey: 'explorer' } },
            forwarding: { protocol: 'https', authority: 'explorer.example.test' },
        };
        result = await invoke(authHandlers.handleUserAdminRoutes, {
            url: '/api/agents/explorer/users', cookie: 'ploinky_sso=sso-admin-session',
            host: 'explorer.example.test', origin: 'https://explorer.example.test', routePlan: publicPlan,
        });
        assert.equal(result.statusCode, 200);
        const proofCookie = responseCookie(result, 'ploinky_user_admin_csrf');
        assert.ok(proofCookie);
        const update = {
            method: 'PATCH', url: '/api/agents/explorer/users/provider-member',
            cookie: `ploinky_sso=sso-admin-session; ${proofCookie}`, csrf: 'browser',
            host: 'explorer.example.test', origin: 'https://explorer.example.test', routePlan: publicPlan,
            body: { email: 'changed@example.test', roles: ['user'] },
        };
        result = await invoke(authHandlers.handleUserAdminRoutes, update);
        assert.equal(result.statusCode, 200, JSON.stringify(result.body));
        assert.equal(providerCalls.filter(call => call.operation === 'updateUser').at(-1).payload.actorUserId, 'persisto-admin');
        assert.equal(providerCalls.filter(call => call.operation === 'updateUser').at(-1).payload.userId, 'provider-member');
        const updateCount = providerCalls.filter(call => call.operation === 'updateUser').length;
        for (const override of [
            { origin: 'https://attacker.example.test' },
            { cookie: 'ploinky_sso=sso-admin-session' },
            { routePlan: { ...publicPlan, lease: { ...publicPlan.lease, id: 'different-generation' } } },
        ]) {
            result = await invoke(authHandlers.handleUserAdminRoutes, { ...update, ...override });
            assert.equal(result.statusCode, 403);
        }
        assert.equal(providerCalls.filter(call => call.operation === 'updateUser').length, updateCount);
        result = await invoke(authHandlers.handleUserAdminRoutes, {
            method: 'DELETE', url: '/api/agents/explorer/users/provider-member',
            cookie: 'ploinky_sso=sso-admin-session', routePlan: ssoRoutePlan,
        });
        assert.equal(result.statusCode, 200);
        assert.deepEqual(providerCalls.filter(call => call.operation === 'deleteUser').at(-1).payload,
            { userId: 'provider-member', actorUserId: 'persisto-admin' });
        for (const method of ['GET', 'PATCH']) {
            result = await invoke(authHandlers.handleUserAdminRoutes, {
                method, url: '/api/agents/explorer/settings', cookie: 'ploinky_sso=sso-admin-session',
                body: { loginBrandingName: 'retired' }, routePlan: ssoRoutePlan,
            });
            assert.equal(result.statusCode, 404);
        }
        authService.isConfigured = () => false;
        result = await invoke(authHandlers.handleUserAdminRoutes, {
            url: '/api/agents/explorer/users', cookie: 'ploinky_sso=sso-admin-session', routePlan: ssoRoutePlan,
        });
        assert.equal(result.statusCode, 503);
        assert.equal(result.body.error, 'sso_not_configured');
    } finally {
        Object.assign(authService, originals);
    }
});
