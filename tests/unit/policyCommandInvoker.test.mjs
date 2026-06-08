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
const { HttpRouteWhitelist } = await import(`../../cli/server/policy/HttpRouteWhitelist.js${moduleSuffix}`);
const {
    HttpWhitelistAddCommand,
    HttpWhitelistRemoveCommand,
    HttpWhitelistCheckCommand,
    HttpWhitelistListCommand,
} = await import(`../../cli/server/policy/commands/httpWhitelistCommands.js${moduleSuffix}`);
const {
    McpPolicySetCommand,
    McpPolicyGetCommand,
    McpPolicyListCommand,
} = await import(`../../cli/server/policy/commands/mcpPolicyCommands.js${moduleSuffix}`);

const auditFile = path.join(tempDir, '.ploinky', 'data', 'router-security', 'policy-audit.log');
const repo = new PolicyStateRepository();
const whitelist = new HttpRouteWhitelist({ repository: repo });
const shareAllow = { authorize: async () => ({ allowed: true }) };
// All seven commands are wired exactly as the composition root wires them, so
// the invoker dispatch/authorization path is exercised for every command.
const registry = new PolicyCommandRegistry()
    .register(new HttpWhitelistAddCommand({ repository: repo, authorizer: shareAllow }))
    .register(new HttpWhitelistRemoveCommand({ repository: repo, authorizer: shareAllow }))
    .register(new HttpWhitelistCheckCommand({ whitelist }))
    .register(new HttpWhitelistListCommand({ repository: repo }))
    .register(new McpPolicySetCommand({ repository: repo }))
    .register(new McpPolicyGetCommand({ repository: repo }))
    .register(new McpPolicyListCommand({ repository: repo }));
const invoker = new PolicyCommandInvoker({
    registry,
    auditLog: new PolicyAuditLog(),
    getSession: (cookie) => (
        cookie === 'admin' ? { user: { id: 'local:admin', username: 'admin', roles: ['user', 'admin'] } }
            : cookie === 'user' ? { user: { id: 'local:bob', username: 'bob', roles: ['user'] } }
                : null
    ),
    isAdminUser: (u) => Array.isArray(u?.roles) && u.roles.includes('admin'),
});

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

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
    req.url = '/whitelist/command';
    req.headers = { host: 'localhost', ...(cookie ? { cookie: `ploinky_jwt=${cookie}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
    req.socket = { encrypted: false };
    return req;
}

async function call(opts) {
    const res = new MockResponse();
    await invoker.handle(makeRequest(opts), res);
    let json = {};
    try { json = JSON.parse(res.body || '{}'); } catch { /* leave */ }
    return { status: res.statusCode, json };
}

test('non-POST is rejected', async () => {
    const r = await call({ method: 'GET', cookie: 'admin' });
    assert.equal(r.status, 405);
});

test('no session cookie → 401 AUTH_REQUIRED', async () => {
    const r = await call({ body: { command: 'mcp.policy.list' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'AUTH_REQUIRED');
});

test('unknown command → 400 UNKNOWN_COMMAND', async () => {
    const r = await call({ cookie: 'admin', body: { command: 'frobnicate' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'UNKNOWN_COMMAND');
});

test('non-admin mcp.policy.set → 403 ADMIN_REQUIRED', async () => {
    const r = await call({ cookie: 'user', body: { command: 'mcp.policy.set', agent: 'dpu', tool: 'x', access: 'admin' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'ADMIN_REQUIRED');
});

test('admin mcp.policy.set → 200, persists, and is audited without tokens', async () => {
    const r = await call({ cookie: 'admin', body: { command: 'mcp.policy.set', agent: 'dpu', tool: 'x', access: 'internal' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(repo.getMcpToolEntry('dpu', 'x').access, 'internal');

    const audit = fs.readFileSync(auditFile, 'utf8');
    assert.match(audit, /"command":"mcp.policy.set"/);
    assert.doesNotMatch(audit, /Bearer |eyJ/);
});

test('the invoker dispatches and authorizes all seven commands for an admin', async () => {
    // Seed a route + a policy entry so the read/check commands have data.
    await call({ cookie: 'admin', body: { command: 'http.whitelist.add', path: '/explorer/pub/*' } });
    await call({ cookie: 'admin', body: { command: 'mcp.policy.set', agent: 'dpu', tool: 'y', access: 'authenticated' } });

    const cases = [
        { command: 'http.whitelist.add', path: '/explorer/pub2/*' },
        { command: 'http.whitelist.remove', path: '/explorer/pub2/*' },
        { command: 'http.whitelist.check', path: '/explorer/pub/file' },
        { command: 'http.whitelist.list' },
        { command: 'mcp.policy.set', agent: 'dpu', tool: 'z', access: 'internal' },
        { command: 'mcp.policy.get', agent: 'dpu', tool: 'y' },
        { command: 'mcp.policy.list' },
    ];
    for (const body of cases) {
        const r = await call({ cookie: 'admin', body });
        assert.equal(r.status, 200, `${body.command} → ${r.status} ${JSON.stringify(r.json)}`);
        assert.equal(r.json.ok, true, `${body.command} not ok`);
    }
});

test('read commands honor their authorization class through the invoker', async () => {
    // http.whitelist.list/check are any-authenticated; mcp.policy.* are admin-only.
    const listAsUser = await call({ cookie: 'user', body: { command: 'http.whitelist.list' } });
    assert.equal(listAsUser.status, 200);
    assert.equal(listAsUser.json.ok, true);

    const mcpGetAsUser = await call({ cookie: 'user', body: { command: 'mcp.policy.get', agent: 'dpu', tool: 'y' } });
    assert.equal(mcpGetAsUser.status, 403);
    assert.equal(mcpGetAsUser.json.error.code, 'ADMIN_REQUIRED');

    const mcpListAsUser = await call({ cookie: 'user', body: { command: 'mcp.policy.list' } });
    assert.equal(mcpListAsUser.status, 403);
    assert.equal(mcpListAsUser.json.error.code, 'ADMIN_REQUIRED');
});
