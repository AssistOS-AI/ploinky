import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-wlcmds-'));
const originalCwd = process.cwd();
process.chdir(tempDir);

const moduleSuffix = `?t=${Date.now()}`;
const { PolicyStateRepository } = await import(`../../cli/server/policy/PolicyStateRepository.js${moduleSuffix}`);
const { HttpRouteWhitelist } = await import(`../../cli/server/policy/HttpRouteWhitelist.js${moduleSuffix}`);
const { HttpWhitelistAddCommand, HttpWhitelistRemoveCommand, HttpWhitelistCheckCommand, HttpWhitelistListCommand } =
    await import(`../../cli/server/policy/commands/httpWhitelistCommands.js${moduleSuffix}`);
const { McpPolicySetCommand, McpPolicyGetCommand, McpPolicyListCommand } =
    await import(`../../cli/server/policy/commands/mcpPolicyCommands.js${moduleSuffix}`);

const policyFile = path.join(tempDir, '.ploinky', 'data', 'router-security', 'policy-state.json');
const repo = new PolicyStateRepository();
const whitelist = new HttpRouteWhitelist({ repository: repo });
const allow = { authorize: async () => ({ allowed: true }) };
const deny = { authorize: async () => ({ allowed: false }) };

const ADMIN = { id: 'local:admin', username: 'admin', roles: ['user', 'admin'] };
const USER = { id: 'local:bob', username: 'bob', roles: ['user'] };

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// Run authorize → execute the way the invoker does.
async function run(cmd, ctx) {
    const authz = await cmd.authorize(ctx);
    if (!authz.ok) return authz;
    return cmd.execute(ctx);
}

test('admin add → reachable by guest; duplicate → POLICY_ENTRY_EXISTS', async () => {
    const add = new HttpWhitelistAddCommand({ repository: repo, authorizer: deny });
    const r = await run(add, { body: { path: '/explorer/public-view/folder/*' }, user: ADMIN, isAdmin: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(whitelist.isReachableByGuest('/explorer/public-view/folder/readme.md', 'GET'), true);
    assert.deepEqual(r.audit, { path: '/explorer/public-view/folder/*' });

    const dup = await run(add, { body: { path: '/explorer/public-view/folder/*' }, user: ADMIN, isAdmin: true });
    assert.equal(dup.status, 409);
    assert.equal(dup.error.code, 'POLICY_ENTRY_EXISTS');
});

test('internal route is rejected at authorize', async () => {
    const add = new HttpWhitelistAddCommand({ repository: repo, authorizer: deny });
    const r = await run(add, { body: { path: '/auth/login' }, user: ADMIN, isAdmin: true });
    assert.equal(r.status, 400);
    assert.equal(r.error.code, 'INTERNAL_ROUTE_NOT_ALLOWED');
});

test('invalid wildcard is rejected', async () => {
    const add = new HttpWhitelistAddCommand({ repository: repo, authorizer: deny });
    const r = await run(add, { body: { path: '/a/*/b' }, user: ADMIN, isAdmin: true });
    assert.equal(r.error.code, 'INVALID_WILDCARD');
});

test('normal user publishes only when the share authorizer approves (deny by default)', async () => {
    const denied = await run(new HttpWhitelistAddCommand({ repository: repo, authorizer: deny }),
        { body: { path: '/explorer/shared/a' }, user: USER, isAdmin: false });
    assert.equal(denied.status, 403);
    assert.equal(denied.error.code, 'FORBIDDEN');

    const approved = await run(new HttpWhitelistAddCommand({ repository: repo, authorizer: allow }),
        { body: { path: '/explorer/shared/a' }, user: USER, isAdmin: false });
    assert.equal(approved.ok, true, JSON.stringify(approved));
});

test('remove non-existent → POLICY_ENTRY_NOT_FOUND', async () => {
    const r = await run(new HttpWhitelistRemoveCommand({ repository: repo, authorizer: deny }),
        { body: { path: '/never/added' }, user: ADMIN, isAdmin: true });
    assert.equal(r.status, 404);
    assert.equal(r.error.code, 'POLICY_ENTRY_NOT_FOUND');
});

test('mcp.policy.set requires admin, rejects invalid access, persists for admin', async () => {
    const set = new McpPolicySetCommand({ repository: repo });
    const nonAdmin = await run(set, { body: { agent: 'dpu', tool: 'x', access: 'admin' }, user: USER, isAdmin: false });
    assert.equal(nonAdmin.status, 403);
    assert.equal(nonAdmin.error.code, 'ADMIN_REQUIRED');

    const bad = await run(set, { body: { agent: 'dpu', tool: 'x', access: 'superuser' }, user: ADMIN, isAdmin: true });
    assert.equal(bad.error.code, 'UNKNOWN_COMMAND');

    const ok = await run(set, { body: { agent: 'dpu', tool: 'x', access: 'admin' }, user: ADMIN, isAdmin: true });
    assert.equal(ok.ok, true);
    const entry = repo.getMcpToolEntry('dpu', 'x');
    assert.equal(entry.access, 'admin');
    assert.equal(entry.source, 'admin');
    assert.equal(entry.updatedBy, 'user:local:admin');
    assert.deepEqual(ok.audit, { agent: 'dpu', tool: 'x', access: 'admin' });
});

test('check command reports public status', async () => {
    const r = await run(new HttpWhitelistCheckCommand({ whitelist }), { body: { path: '/explorer/public-view/folder/a' }, user: USER, isAdmin: false });
    assert.equal(r.ok, true);
    assert.equal(r.data.public, true);
});

test('http.whitelist.list returns persisted routes for any authenticated user', async () => {
    const list = new HttpWhitelistListCommand({ repository: repo });
    const r = await run(list, { body: {}, user: USER, isAdmin: false });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.data.httpRoutes));
    assert.ok(r.data.httpRoutes.some((e) => e.path === '/explorer/public-view/folder/*'));
});

test('mcp.policy.get is admin-only and returns the entry (or 404)', async () => {
    const get = new McpPolicyGetCommand({ repository: repo });
    const nonAdmin = await run(get, { body: { agent: 'dpu', tool: 'x' }, user: USER, isAdmin: false });
    assert.equal(nonAdmin.status, 403);
    assert.equal(nonAdmin.error.code, 'ADMIN_REQUIRED');

    const ok = await run(get, { body: { agent: 'dpu', tool: 'x' }, user: ADMIN, isAdmin: true });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.entry.access, 'admin');

    const missing = await run(get, { body: { agent: 'nope', tool: 'nope' }, user: ADMIN, isAdmin: true });
    assert.equal(missing.status, 404);
    assert.equal(missing.error.code, 'POLICY_ENTRY_NOT_FOUND');
});

test('mcp.policy.list is admin-only and lists entries', async () => {
    const list = new McpPolicyListCommand({ repository: repo });
    const nonAdmin = await run(list, { body: {}, user: USER, isAdmin: false });
    assert.equal(nonAdmin.status, 403);
    assert.equal(nonAdmin.error.code, 'ADMIN_REQUIRED');

    const ok = await run(list, { body: {}, user: ADMIN, isAdmin: true });
    assert.equal(ok.ok, true);
    assert.ok(ok.data.mcpTools.some((e) => e.agent === 'dpu' && e.tool === 'x'));
});

test('a corrupt policy makes mutating commands fail closed without clobbering the file', async () => {
    fs.writeFileSync(policyFile, '{ corrupt');
    repo.invalidate();
    const r = await run(new McpPolicySetCommand({ repository: repo }), { body: { agent: 'a', tool: 'b', access: 'authenticated' }, user: ADMIN, isAdmin: true });
    assert.equal(r.status, 500);
    assert.equal(r.error.code, 'POLICY_PERSISTENCE_ERROR');
    assert.equal(fs.readFileSync(policyFile, 'utf8'), '{ corrupt');
});
