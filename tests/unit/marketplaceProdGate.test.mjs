import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

// AC7: the Marketplace table, the four resources, the 403 rules and the
// permission fields, all under the captured PROD.

const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'marketplace-prod-'));
const previousCwd = process.cwd();
const previousKey = process.env.PLOINKY_MASTER_KEY;
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '4'.repeat(64);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
fs.mkdirSync('.ploinky');
const { handleMarketplaceRoutes } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const table = await import('../../cli/server/authHandlers/marketplaceMutations.mjs');
const { authService, SSO_AUTH_COOKIE_NAME } = await import('../../cli/server/authHandlers/shared.js');
const { mintBrowserCsrfToken } = await import('../../cli/server/browserMutationSecurity.js');
const { PROD_GATES_FILE, writeProdGates } = await import('../../cli/utils/runtime/mcpProdGates.mjs');

const admin = { sessionId: 'prod-gate-admin', user: { id: 'admin', roles: ['admin'] } };
const originalConfigured = authService.isConfigured;
const originalValidate = authService.validateSession;
authService.isConfigured = () => true;
authService.validateSession = async (id) => (id === admin.sessionId ? admin : null);
test.after(() => {
    authService.isConfigured = originalConfigured;
    authService.validateSession = originalValidate;
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY; else process.env.PLOINKY_MASTER_KEY = previousKey;
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const snapshot = { generation: 'g', agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: { mode: 'sso' } } }, routing: { static: { agent: 'shell' }, routes: { shell: { agent: 'shell', repo: 'repo' } } }, manifests: {} };
const plan = () => ({ ok: true, kind: 'router-surface', surface: 'marketplace-ui', listener: 'public', hostSelection: { kind: 'agent-root', record: { routeKey: 'shell' } }, forwarding: { protocol: 'https', authority: 'explorer.example.test' }, snapshot, lease: { id: 'g', snapshot, commit: () => true } });

function mockResponse() {
    const res = { status: 0, headers: {}, body: undefined };
    res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
    res.writeHead = (status) => { res.status = status; };
    res.end = (value) => { res.body = value === undefined ? undefined : JSON.parse(value); res.ended = true; };
    return res;
}

const calls = { enable: [], disable: [], uninstall: [], worker: [] };
const guards = () => ({
    enableAgentAction: async (body) => { calls.enable.push(body.agentRef); return { result: { status: 'enabled' } }; },
    disableAgentAction: async (ref) => { calls.disable.push(ref); return { status: 'removed' }; },
    uninstallRepositoryAction: async (body) => { calls.uninstall.push(body); return {}; },
    repositoryWorker: async (operation) => { calls.worker.push(operation); return {}; },
    repositoryWorkerEligibility: () => true,
});

async function send({ method = 'POST', resource = 'agents', body, prod, bearer = false, csrf = true, headers = {} } = {}) {
    const req = Readable.from(method === 'GET' || method === 'HEAD' ? [] : [Buffer.from(JSON.stringify(body ?? {}))]);
    req.method = method;
    req.headers = { host: 'explorer.example.test', origin: 'https://explorer.example.test', ...headers };
    if (bearer) {
        req.headers.authorization = 'Bearer not-a-real-assertion';
    } else {
        req.headers.cookie = `${SSO_AUTH_COOKIE_NAME}=${admin.sessionId}`;
        req.session = admin;
        if (csrf && method !== 'GET' && method !== 'HEAD') {
            req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({ req, routePlan: plan(), authContext: { boundHostRouteKey: 'shell' }, sessionId: admin.sessionId });
        }
    }
    const res = mockResponse();
    const readCalls = [];
    const options = {
        routePlan: plan(),
        agentListOptions: { summaries: [], liveContainers: [] },
        collectContainers: async () => [],
        ...guards(),
        ...(prod === undefined ? {} : { readProd: () => { readCalls.push(1); return prod; } }),
    };
    const handled = await handleMarketplaceRoutes(req, res, new URL(`https://explorer.example.test/api/marketplace/${resource}`), options);
    return { res, handled, reads: readCalls.length };
}

const refused = (result, resource, action) => {
    assert.equal(result.res.status, 403, JSON.stringify(result.res.body));
    assert.deepEqual(result.res.body, { ok: false, error: 'disabled_in_production', resource, ...(action !== undefined ? { action } : {}) });
};

test('the table lists exactly the four resources, with repository operations disabled and agent enable/disable allowed', () => {
    assert.deepEqual(Object.keys(table.MARKETPLACE_MUTATIONS), ['repos', 'agents', 'cache', 'hardware-limits']);
    assert.equal(Object.isFrozen(table.MARKETPLACE_MUTATIONS), true);
    assert.equal(Object.isFrozen(table.MARKETPLACE_MUTATIONS.repos), true);
    assert.equal(Object.isFrozen(table.MARKETPLACE_MUTATIONS.agents), true);
    assert.deepEqual(table.marketplaceActions('repos'), ['install', 'remove', 'install_repo', 'uninstall_repo']);
    assert.deepEqual(table.marketplaceActions('agents'), ['enable_agent', 'disable_agent']);
    assert.deepEqual(table.marketplaceActions('cache'), []);
    for (const resource of ['repos', 'agents', 'cache', 'hardware-limits']) assert.equal(table.isProdAllowedResource(resource), true, resource);
    for (const resource of ['restart', 'list-repos', '', 'constructor', '__proto__', 'toString', undefined, null]) {
        assert.equal(table.isProdAllowedResource(resource), false, String(resource));
    }
    for (const action of ['enable_agent', 'disable_agent']) assert.equal(table.isProdAllowedAction('agents', action), true, action);
    for (const action of ['install', 'remove', 'install_repo', 'uninstall_repo']) {
        assert.equal(table.isProdAllowedAction('repos', action), false, action);
        // An action only counts under its own resource.
        assert.equal(table.isProdAllowedAction('agents', action), false, action);
    }
    for (const action of ['restart_agent', 'reinstall_agent', '', 'constructor', '__proto__', undefined]) {
        assert.equal(table.isProdAllowedAction('agents', action), false, String(action));
    }
    // `cache` and `hardware-limits` have no action table: the action check does not apply to them.
    assert.equal(table.isProdAllowedAction('cache', 'purge'), false);
    assert.equal(table.isProdAllowedAction('constructor', 'x'), false);
});

test('the handler action lists are the table keys, with and without PROD', async () => {
    for (const [resource, actions] of [['repos', table.marketplaceActions('repos')], ['agents', table.marketplaceActions('agents')]]) {
        for (const action of actions) {
            const result = await send({ resource, body: { action }, prod: false });
            assert.notEqual(result.res.body?.error, 'unknown_action', `${resource}/${action}`);
        }
        for (const action of ['restart_agent', 'reinstall_agent', 'not_an_action']) {
            const result = await send({ resource, body: { action }, prod: false });
            assert.equal(result.res.status, 400, `${resource}/${action}`);
            assert.equal(result.res.body.error, 'unknown_action');
        }
    }
    // An action of the other resource is unknown to this one.
    assert.equal((await send({ resource: 'agents', body: { action: 'install' }, prod: false })).res.body.error, 'unknown_action');
    assert.equal((await send({ resource: 'repos', body: { action: 'enable_agent' }, prod: false })).res.body.error, 'unknown_action');
});

test('under PROD an unlisted resource is refused at the handler top, before authentication and any body read', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const result = await send({ method, resource: 'restart', prod: true, csrf: false, headers: { cookie: '' } });
        refused(result, 'restart');
    }
    // list-repos is a GET-only resource: a mutation of it is refused too.
    refused(await send({ method: 'POST', resource: 'list-repos', prod: true }), 'list-repos');
    // An agent (bearer) caller is refused identically.
    refused(await send({ resource: 'restart', prod: true, bearer: true }), 'restart');
    // The same request without PROD is an ordinary 404.
    const off = await send({ resource: 'restart', prod: false });
    assert.equal(off.res.status, 404);
    assert.equal(off.res.body.error, 'not_found');
});

test('under PROD repos and agents refuse an action the table does not allow, after the single body parse', async () => {
    for (const list of Object.values(calls)) list.length = 0;
    for (const body of [
        { action: 'restart_agent', agentRef: 'repo/worker' },
        { action: 'reinstall_agent', agentRef: 'repo/worker' },
        { action: 'not_an_action' },
        {},
    ]) {
        refused(await send({ resource: 'agents', body, prod: true }), 'agents', String(body.action || ''));
    }
    for (const action of ['install', 'remove', 'install_repo', 'uninstall_repo']) {
        refused(await send({ resource: 'repos', body: { action, url: 'https://example.test/r.git', paths: [], target: 'x' }, prod: true }), 'repos', action);
    }
    // Nothing behind the refusal ran.
    assert.deepEqual(calls.uninstall, []);
    assert.deepEqual(calls.worker, []);
    // A body that is not JSON is still the ordinary 400: the action check follows the parse.
    const req = Readable.from([Buffer.from('{not json')]);
    req.method = 'POST';
    req.headers = { host: 'explorer.example.test', origin: 'https://explorer.example.test', cookie: `${SSO_AUTH_COOKIE_NAME}=${admin.sessionId}` };
    req.session = admin;
    req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({ req, routePlan: plan(), authContext: { boundHostRouteKey: 'shell' }, sessionId: admin.sessionId });
    const res = mockResponse();
    await handleMarketplaceRoutes(req, res, new URL('https://explorer.example.test/api/marketplace/agents'), { routePlan: plan(), readProd: () => true, ...guards() });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_json');
});

test('under PROD an agent (bearer) caller is refused the same repository and unlisted actions', async () => {
    refused(await send({ resource: 'repos', body: { action: 'install_repo', url: 'https://example.test/r.git' }, prod: true, bearer: true }), 'repos', 'install_repo');
    refused(await send({ resource: 'agents', body: { action: 'restart_agent' }, prod: true, bearer: true }), 'agents', 'restart_agent');
});

test('under PROD enable_agent and disable_agent behave as today', async () => {
    calls.enable.length = 0;
    calls.disable.length = 0;
    const enable = await send({ resource: 'agents', body: { action: 'enable_agent', agentRef: 'repo/worker', mode: 'global' }, prod: true });
    assert.equal(enable.res.status, 200, JSON.stringify(enable.res.body));
    assert.equal(enable.res.body.action, 'enable_agent');
    const disable = await send({ resource: 'agents', body: { action: 'disable_agent', agentRef: 'repo/worker' }, prod: true });
    assert.equal(disable.res.status, 200, JSON.stringify(disable.res.body));
    assert.deepEqual(calls.enable, ['repo/worker']);
    assert.deepEqual(calls.disable, ['repo/worker']);
    // The response is the same shape as without PROD.
    const off = await send({ resource: 'agents', body: { action: 'enable_agent', agentRef: 'repo/worker', mode: 'global' }, prod: false });
    assert.equal(off.res.status, 200);
    assert.deepEqual(Object.keys(off.res.body).sort(), Object.keys(enable.res.body).sort());
});

test('under PROD the cache and hardware-limits POSTs are not refused by the table and keep their own handling', async () => {
    for (const resource of ['cache', 'hardware-limits']) {
        const withProd = await send({ resource, body: {}, prod: true });
        const without = await send({ resource, body: {}, prod: false });
        assert.notEqual(withProd.res.body?.error, 'disabled_in_production', resource);
        // The answer is whatever the resource's own handler gives, with or without PROD.
        assert.equal(withProd.res.status, without.res.status, resource);
        assert.deepEqual(withProd.res.body, without.res.body, resource);
    }
});

test('GET and HEAD are never refused by the table', async () => {
    for (const resource of ['agents', 'repos', 'list-repos', 'restart']) {
        for (const method of ['GET', 'HEAD']) {
            const result = await send({ method, resource, prod: true });
            assert.notEqual(result.res.body?.error, 'disabled_in_production', `${method} ${resource}`);
        }
    }
});

test('permission fields follow the captured PROD', async () => {
    const on = await send({ method: 'GET', resource: 'agents', prod: true });
    assert.equal(on.res.status, 200, JSON.stringify(on.res.body));
    assert.deepEqual(on.res.body.marketplace.permissions, { canManage: true, canRestart: false, canReinstall: false, production: true });
    const off = await send({ method: 'GET', resource: 'agents', prod: false });
    assert.deepEqual(off.res.body.marketplace.permissions, { canManage: true, canRestart: true, canReinstall: true, production: false });
    // A caller that cannot manage gets false everywhere, PROD or not.
    for (const prod of [true, false]) {
        const req = Readable.from([]);
        req.method = 'GET';
        req.headers = { host: 'explorer.example.test', origin: 'https://explorer.example.test', cookie: `${SSO_AUTH_COOKIE_NAME}=${admin.sessionId}` };
        req.session = admin;
        const original = admin.user.roles;
        admin.user.roles = ['user'];
        try {
            const res = mockResponse();
            await handleMarketplaceRoutes(req, res, new URL('https://explorer.example.test/api/marketplace/agents'), { routePlan: plan(), readProd: () => prod, agentListOptions: { summaries: [], liveContainers: [] }, collectContainers: async () => [] });
            const permissions = res.body?.marketplace?.permissions;
            if (permissions) assert.deepEqual(permissions, { canManage: false, canRestart: false, canReinstall: false, production: prod });
        } finally {
            admin.user.roles = original;
        }
    }
});

test('the handler reads the production state once per request', async () => {
    for (const request of [
        { resource: 'agents', body: { action: 'enable_agent', agentRef: 'repo/worker', mode: 'global' } },
        { resource: 'agents', body: { action: 'restart_agent' } },
        { resource: 'restart' },
        { method: 'GET', resource: 'agents' },
    ]) {
        const result = await send({ ...request, prod: true });
        assert.equal(result.reads, 1, JSON.stringify(request));
    }
});

test('the default reader is the captured file; an absent or unreadable capture is PROD true', async () => {
    fs.rmSync(PROD_GATES_FILE, { force: true });
    // No capture: refused as under PROD.
    refused(await send({ resource: 'restart' }), 'restart');
    refused(await send({ resource: 'repos', body: { action: 'install' } }), 'repos', 'install');
    assert.equal((await send({ method: 'GET', resource: 'agents' })).res.body.marketplace.permissions.production, true);
    // A corrupt capture is PROD true as well.
    fs.mkdirSync(path.dirname(PROD_GATES_FILE), { recursive: true });
    fs.writeFileSync(PROD_GATES_FILE, '{broken');
    refused(await send({ resource: 'restart' }), 'restart');
    // A captured prod:false is today's behaviour.
    writeProdGates({ schema: 1, prod: false, routes: {} });
    assert.equal((await send({ resource: 'restart' })).res.status, 404);
    assert.deepEqual((await send({ method: 'GET', resource: 'agents' })).res.body.marketplace.permissions, { canManage: true, canRestart: true, canReinstall: true, production: false });
    // Flipping the capture is seen on the next request, with no restart of the handler.
    writeProdGates({ schema: 1, prod: true, routes: {} });
    refused(await send({ resource: 'restart' }), 'restart');
    assert.deepEqual((await send({ method: 'GET', resource: 'agents' })).res.body.marketplace.permissions, { canManage: true, canRestart: false, canReinstall: false, production: true });
});
