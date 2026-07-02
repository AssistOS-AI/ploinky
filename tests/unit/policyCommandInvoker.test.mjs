import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-invoker-'));
const originalCwd = process.cwd();
process.chdir(tempDir);

const moduleSuffix = `?t=${Date.now()}`;
const { PolicyStateRepository } = await import(`../../cli/server/policy/PolicyStateRepository.js${moduleSuffix}`);
const { PolicyAuditLog } = await import(`../../cli/server/policy/PolicyAuditLog.js${moduleSuffix}`);
const { PolicyCommandRegistry } = await import(`../../cli/server/policy/PolicyCommandRegistry.js${moduleSuffix}`);
const { PolicyCommandInvoker } = await import(`../../cli/server/policy/PolicyCommandInvoker.js${moduleSuffix}`);
const { HttpRouteAccessPolicy } = await import(`../../cli/server/policy/HttpRouteAccessPolicy.js${moduleSuffix}`);
const {
    HttpRouteSetCommand,
    HttpRouteRemoveCommand,
    HttpRouteCheckCommand,
    HttpRouteListCommand,
} = await import(`../../cli/server/policy/commands/httpRouteCommands.js${moduleSuffix}`);
const {
    McpPolicySetCommand,
    McpPolicyGetCommand,
    McpPolicyListCommand,
} = await import(`../../cli/server/policy/commands/mcpPolicyCommands.js${moduleSuffix}`);

const auditFile = path.join(tempDir, '.ploinky', 'data', 'router-security', 'policy-audit.log');
const policyFile = path.join(tempDir, '.ploinky', 'data', 'router-security', 'policy-state.json');
const repo = new PolicyStateRepository();
const shareAllow = { authorize: async () => ({ allowed: true }) };

function makeRouteAccessPolicy() {
    return new HttpRouteAccessPolicy({
        repository: repo,
        manifestRouteProvider: () => [],
        httpServiceProvider: () => [],
        routeDefaultProvider: ({ routeKey }) => ({ access: 'authenticated', routeKey, source: 'routeDefault' }),
    });
}

function makeInvoker(authorizer = shareAllow) {
    const routeAccessPolicy = makeRouteAccessPolicy();
    const registry = new PolicyCommandRegistry()
        .register(new HttpRouteSetCommand({ repository: repo, authorizer }))
        .register(new HttpRouteRemoveCommand({ repository: repo, authorizer }))
        .register(new HttpRouteCheckCommand({ routeAccessPolicy }))
        .register(new HttpRouteListCommand({ repository: repo }))
        .register(new McpPolicySetCommand({ repository: repo }))
        .register(new McpPolicyGetCommand({ repository: repo }))
        .register(new McpPolicyListCommand({ repository: repo }));
    return new PolicyCommandInvoker({
        registry,
        auditLog: new PolicyAuditLog(),
        getSession: (cookie) => (
            cookie === 'admin' ? { user: { id: 'sso:admin', username: 'admin', roles: ['user', 'admin'] } }
                : cookie === 'user' ? { user: { id: 'sso:bob', username: 'bob', roles: ['user'] } }
                    : null
        ),
        isAdminUser: (u) => Array.isArray(u?.roles) && u.roles.includes('admin'),
    });
}

let invoker = makeInvoker();

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function writePolicy({ httpRoutes = [], mcpTools = [] } = {}) {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, JSON.stringify({ schema: 'router-policy', httpRoutes, mcpTools }, null, 2));
    repo.invalidate();
}

function resetPolicy() {
    writePolicy();
}

class MockResponse {
    constructor() { this.statusCode = 200; this.body = ''; }
    writeHead(code) { this.statusCode = code; return this; }
    setHeader() {}
    end(chunk = '') { this.body += chunk ? String(chunk) : ''; }
}

function makeRequest({ method = 'POST', cookie = '', body } = {}) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = Readable.from(chunks);
    req.method = method;
    req.url = '/policy/command';
    req.headers = { host: 'localhost', ...(cookie ? { cookie: `ploinky_sso=${cookie}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
    req.socket = { encrypted: false };
    return req;
}

async function call(opts, subject = invoker) {
    const res = new MockResponse();
    await subject.handle(makeRequest(opts), res);
    let json = {};
    try { json = JSON.parse(res.body || '{}'); } catch { /* leave */ }
    return { status: res.statusCode, json };
}

test('non-POST is rejected', async () => {
    const r = await call({ method: 'GET', cookie: 'admin' });
    assert.equal(r.status, 405);
});

test('no session cookie -> 401 AUTH_REQUIRED', async () => {
    const r = await call({ body: { command: 'mcp.policy.list' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'AUTH_REQUIRED');
});

test('unknown command -> 400 UNKNOWN_COMMAND', async () => {
    const r = await call({ cookie: 'admin', body: { command: 'frobnicate' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'UNKNOWN_COMMAND');
});

test('non-admin mcp.policy.set -> 403 ADMIN_REQUIRED', async () => {
    const r = await call({ cookie: 'user', body: { command: 'mcp.policy.set', agent: 'dpu', tool: 'x', access: 'admin' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'ADMIN_REQUIRED');
});

test('admin mcp.policy.set -> 200, persists, and is audited without tokens', async () => {
    resetPolicy();
    const r = await call({ cookie: 'admin', body: { command: 'mcp.policy.set', agent: 'dpu', tool: 'x', access: 'internal' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(repo.getMcpToolEntry('dpu', 'x').access, 'internal');

    const audit = fs.readFileSync(auditFile, 'utf8');
    assert.match(audit, /"command":"mcp.policy.set"/);
    assert.doesNotMatch(audit, /Bearer |eyJ/);
});

test('the invoker dispatches and authorizes all seven commands for an admin', async () => {
    resetPolicy();
    await call({ cookie: 'admin', body: { command: 'http.route.set', path: '/explorer/pub/*', access: 'public' } });
    await call({ cookie: 'admin', body: { command: 'mcp.policy.set', agent: 'dpu', tool: 'y', access: 'authenticated' } });

    const cases = [
        { command: 'http.route.set', path: '/explorer/pub2/*', access: 'guest' },
        { command: 'http.route.remove', path: '/explorer/pub2/*' },
        { command: 'http.route.check', path: '/explorer/pub/file' },
        { command: 'http.route.list' },
        { command: 'mcp.policy.set', agent: 'dpu', tool: 'z', access: 'internal' },
        { command: 'mcp.policy.get', agent: 'dpu', tool: 'y' },
        { command: 'mcp.policy.list' },
    ];
    for (const body of cases) {
        const r = await call({ cookie: 'admin', body });
        assert.equal(r.status, 200, `${body.command} -> ${r.status} ${JSON.stringify(r.json)}`);
        assert.equal(r.json.ok, true, `${body.command} not ok`);
    }
});

test('read commands honor their authorization class through the invoker', async () => {
    resetPolicy();
    const listAsUser = await call({ cookie: 'user', body: { command: 'http.route.list' } });
    assert.equal(listAsUser.status, 200);
    assert.equal(listAsUser.json.ok, true);

    const mcpGetAsUser = await call({ cookie: 'user', body: { command: 'mcp.policy.get', agent: 'dpu', tool: 'y' } });
    assert.equal(mcpGetAsUser.status, 403);
    assert.equal(mcpGetAsUser.json.error.code, 'ADMIN_REQUIRED');

    const mcpListAsUser = await call({ cookie: 'user', body: { command: 'mcp.policy.list' } });
    assert.equal(mcpListAsUser.status, 403);
    assert.equal(mcpListAsUser.json.error.code, 'ADMIN_REQUIRED');
});

test('http.route.set rejects removed or invalid access values', async () => {
    resetPolicy();
    for (const access of ['', 'protected', 'none', 'deny']) {
        const r = await call({ cookie: 'admin', body: { command: 'http.route.set', path: '/explorer/pub/*', access } });
        assert.equal(r.status, 400, access);
        assert.equal(r.json.error.code, 'INVALID_ACCESS', access);
    }
});

test('non-admin http.route.set is blocked when the owning share authorizer denies', async () => {
    resetPolicy();
    const denyingInvoker = makeInvoker({ authorize: async () => ({ allowed: false, reason: 'nope' }) });
    const r = await call({ cookie: 'user', body: { command: 'http.route.set', path: '/explorer/pub/*', access: 'public' } }, denyingInvoker);
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'FORBIDDEN');
});

test('non-admin http.route.set passes concrete path, access, and verb to the share authorizer', async () => {
    resetPolicy();
    const calls = [];
    const approvingInvoker = makeInvoker({
        authorize: async (ctx) => {
            calls.push(ctx);
            return { allowed: true, reason: 'ok' };
        },
    });
    const r = await call({ cookie: 'user', body: { command: 'http.route.set', path: '/explorer/pub/*', access: 'guest' } }, approvingInvoker);
    assert.equal(r.status, 200);
    assert.equal(repo.getHttpRouteEntry('/explorer/pub/*').access, 'guest');
    assert.equal(calls.length, 1);
    assert.deepEqual(
        { path: calls[0].normalizedPath, access: calls[0].access, verb: calls[0].verb },
        { path: '/explorer/pub/*', access: 'guest', verb: 'changing' },
    );
});

test('corrupt policy file fails closed for http.route commands', async () => {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, '{ not json');
    repo.invalidate();

    const set = await call({ cookie: 'admin', body: { command: 'http.route.set', path: '/explorer/pub/*', access: 'public' } });
    assert.equal(set.status, 500);
    assert.equal(set.json.error.code, 'POLICY_PERSISTENCE_ERROR');

    const list = await call({ cookie: 'admin', body: { command: 'http.route.list' } });
    assert.equal(list.status, 500);
    assert.equal(list.json.error.code, 'POLICY_PERSISTENCE_ERROR');
});
