import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mcptp-'));
const originalCwd = process.cwd();
process.chdir(tempDir);

const moduleSuffix = `?t=${Date.now()}`;
const { PolicyStateRepository } = await import(`../../cli/server/policy/PolicyStateRepository.js${moduleSuffix}`);
const { McpToolPolicy } = await import(`../../cli/server/policy/McpToolPolicy.js${moduleSuffix}`);
const { Caller } = await import(`../../cli/server/policy/Caller.js${moduleSuffix}`);

const policyFile = path.join(tempDir, '.ploinky', 'data', 'router-security', 'policy-state.json');
const repo = new PolicyStateRepository();
const policy = new McpToolPolicy({ repository: repo });

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function writePolicy(mcpTools = [], httpRoutes = []) {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, JSON.stringify({ schema: 'router-policy', httpRoutes, mcpTools }, null, 2));
    repo.invalidate();
}

function mcpEntry(agent, tool, access, extra = {}) {
    return { agent, tool, access, source: 'admin', enabled: true, createdAt: 't', createdBy: 't', updatedAt: 't', updatedBy: 't', ...extra };
}

const USER = new Caller({ kind: 'user', isAdmin: false, roles: ['user'] });
const ADMIN = new Caller({ kind: 'user', isAdmin: true, roles: ['user', 'admin'] });
const GUEST = new Caller({ kind: 'guest', isAdmin: false, roles: ['guest'] });
const AGENT = new Caller({ kind: 'agent', id: 'agent:a/b' });
const DELEGATED_AGENT = new Caller({
    kind: 'agent',
    id: 'agent:AssistOSExplorer/onlyOffice',
    delegatedUser: { id: 'local:alice', username: 'alice', roles: ['user'] },
    delegatedTool: 'authed',
    sourceAgentId: 'agent:AssistOSExplorer/onlyOffice',
});

test('accessFromTags maps tags and rejects invalid combos', () => {
    assert.deepEqual(policy.accessFromTags([]), { access: 'authenticated' });
    assert.deepEqual(policy.accessFromTags(['internal']), { access: 'internal' });
    assert.deepEqual(policy.accessFromTags(['admin']), { access: 'admin' });
    assert.ok(policy.accessFromTags(['internal', 'admin']).invalid);
    assert.ok(policy.accessFromTags(['mystery']).invalid);
});

test('bootstrapDefaults adds defaults but a persisted entry always wins', () => {
    writePolicy([mcpEntry('explorer', 'docs_search', 'admin', { source: 'admin' })]);
    policy.bootstrapDefaults([
        { agent: 'explorer', tool: 'docs_search', access: 'authenticated' },
        { agent: 'explorer', tool: 'index_refresh', access: 'internal' },
    ]);
    assert.equal(repo.getMcpToolEntry('explorer', 'docs_search').access, 'admin');
    const refresh = repo.getMcpToolEntry('explorer', 'index_refresh');
    assert.equal(refresh.access, 'internal');
    assert.equal(refresh.source, 'mcp-config');
});

test('collectDefaults keys policy on the route key, not route.agent (alias safety)', () => {
    // Enforcement evaluates `agent` = the URL route segment, so bootstrap must
    // persist defaults under the route key. An aliased route (routeKey != agent)
    // must yield a default keyed on the alias the caller actually hits.
    const agentDir = path.join(tempDir, 'alias-agent-dir');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'mcp-config.json'), JSON.stringify({
        tools: [{ name: 'do_thing', tags: [] }, { name: 'admin_thing', tags: ['admin'] }],
    }));
    const defaults = policy.collectDefaults({
        myAlias: {
            hostPath: agentDir,
            agent: 'realAgentName',
            mcpConfig: { tools: [{ name: 'do_thing', tags: [] }, { name: 'admin_thing', tags: ['admin'] }] },
        },
    });
    assert.deepEqual(defaults, [
        { agent: 'myAlias', tool: 'do_thing', access: 'authenticated' },
        { agent: 'myAlias', tool: 'admin_thing', access: 'admin' },
    ]);
});

test('evaluate enforces the access-class matrix (fail-closed on missing/disabled)', () => {
    writePolicy([
        mcpEntry('a', 'authed', 'authenticated'),
        mcpEntry('a', 'adminTool', 'admin'),
        mcpEntry('a', 'internalTool', 'internal'),
        mcpEntry('a', 'disabledTool', 'authenticated', { enabled: false }),
    ]);
    assert.equal(policy.evaluate({ agent: 'a', tool: 'authed', caller: USER }).allow, true);
    assert.equal(policy.evaluate({ agent: 'a', tool: 'authed', caller: ADMIN }).allow, true);
    assert.equal(policy.evaluate({ agent: 'a', tool: 'authed', caller: GUEST }).allow, true);
    assert.equal(policy.evaluate({ agent: 'a', tool: 'authed', caller: AGENT }).code, 'AGENT_POLICY_DENIED');
    assert.equal(policy.evaluate({ agent: 'a', tool: 'adminTool', caller: ADMIN }).allow, true);
    assert.equal(policy.evaluate({ agent: 'a', tool: 'adminTool', caller: USER }).code, 'ADMIN_REQUIRED');
    assert.equal(policy.evaluate({ agent: 'a', tool: 'adminTool', caller: GUEST }).code, 'ADMIN_REQUIRED');
    assert.equal(policy.evaluate({ agent: 'a', tool: 'adminTool', caller: AGENT }).code, 'AGENT_POLICY_DENIED');
    assert.equal(policy.evaluate({ agent: 'a', tool: 'internalTool', caller: AGENT }).allow, true);
    assert.equal(policy.evaluate({ agent: 'a', tool: 'internalTool', caller: USER }).code, 'AGENT_POLICY_DENIED');
    assert.equal(policy.evaluate({ agent: 'a', tool: 'internalTool', caller: ADMIN }).code, 'AGENT_POLICY_DENIED');
    assert.equal(policy.evaluate({ agent: 'a', tool: 'disabledTool', caller: USER }).code, 'AGENT_POLICY_DENIED');
    assert.equal(policy.evaluate({ agent: 'a', tool: 'missing', caller: USER }).code, 'AGENT_POLICY_DENIED');
});

test('plain agent is denied for authenticated tools', () => {
    writePolicy([mcpEntry('a', 'authed', 'authenticated')]);
    const result = policy.evaluate({ agent: 'a', tool: 'authed', caller: AGENT });
    assert.equal(result.allow, false);
    assert.equal(result.code, 'AGENT_POLICY_DENIED');
});

test('agent with verified user delegation may call listed authenticated tool', () => {
    writePolicy([mcpEntry('a', 'authed', 'authenticated')]);
    const result = policy.evaluate({ agent: 'a', tool: 'authed', caller: DELEGATED_AGENT });
    assert.equal(result.allow, true);
    assert.equal(result.delegated, true);
});

test('delegated agent is denied for tools outside the grant', () => {
    writePolicy([mcpEntry('a', 'other', 'authenticated')]);
    const result = policy.evaluate({ agent: 'a', tool: 'other', caller: DELEGATED_AGENT });
    assert.equal(result.allow, false);
    assert.equal(result.code, 'AGENT_POLICY_DENIED');
});

test('delegated agent is denied when mcp policy denies the source target tool tuple', () => {
    writePolicy([mcpEntry('a', 'authed', 'internal')]);
    const result = policy.evaluate({ agent: 'a', tool: 'authed', caller: DELEGATED_AGENT });
    assert.equal(result.allow, false);
    assert.equal(result.code, 'AGENT_POLICY_DENIED');
});

test('delegated agent does not gain admin or internal access', () => {
    writePolicy([
        mcpEntry('a', 'adminTool', 'admin'),
        mcpEntry('a', 'internalTool', 'internal'),
    ]);
    assert.equal(policy.evaluate({ agent: 'a', tool: 'adminTool', caller: DELEGATED_AGENT }).code, 'AGENT_POLICY_DENIED');
    assert.equal(policy.evaluate({ agent: 'a', tool: 'internalTool', caller: DELEGATED_AGENT }).code, 'AGENT_POLICY_DENIED');
});

test('Caller.fromRequest classifies users, admins, guests, and agents', () => {
    assert.equal(Caller.fromRequest({ user: { roles: ['user'] } }).kind, 'user');
    assert.equal(Caller.fromRequest({ user: { roles: ['user'] } }).isAdmin, false);
    assert.equal(Caller.fromRequest({ user: { username: 'admin', roles: ['user', 'admin'] } }).isAdmin, true);
    assert.equal(Caller.fromRequest({ user: { roles: ['guest'] } }).kind, 'guest');
    assert.equal(Caller.fromRequest({ user: { roles: ['guest', 'admin'] } }).isAdmin, false);
    assert.equal(Caller.fromRequest({ delegatedAgentVerified: { callerPrincipal: 'agent:x/y' } }).kind, 'agent');
    const delegated = Caller.fromRequest({
        delegatedAgentVerified: {
            callerPrincipal: 'agent:x/y',
            userDelegation: {
                user: { id: 'local:alice', username: 'alice', roles: ['user'] },
                delegation: { tool: 'docs_search', sourceAgentId: 'agent:x/y' },
            },
        },
    });
    assert.equal(delegated.delegatedUser.id, 'local:alice');
    assert.equal(delegated.delegatedTool, 'docs_search');
    assert.equal(Caller.fromRequest({}).kind, 'none');
});

test('filterTools hides tools the caller cannot invoke', () => {
    writePolicy([
        mcpEntry('a', 'pub', 'authenticated'),
        mcpEntry('a', 'adm', 'admin'),
        mcpEntry('a', 'int', 'internal'),
    ]);
    const tools = [{ name: 'pub' }, { name: 'adm' }, { name: 'int' }, { name: 'unknown' }];
    assert.deepEqual(policy.filterTools('a', tools, USER).map((t) => t.name), ['pub']);
    assert.deepEqual(policy.filterTools('a', tools, ADMIN).map((t) => t.name), ['pub', 'adm']);
    assert.deepEqual(policy.filterTools('a', tools, AGENT).map((t) => t.name), ['int']);
});

test('evaluateResource gates resources as an authenticated-class capability', () => {
    // Resources have no per-resource admin/internal model (deferred); a session
    // caller may read, an internal/agent or anonymous caller may not.
    assert.equal(policy.evaluateResource({ caller: USER }).allow, true);
    assert.equal(policy.evaluateResource({ caller: ADMIN }).allow, true);
    assert.equal(policy.evaluateResource({ caller: GUEST }).allow, true);
    const agentDecision = policy.evaluateResource({ caller: AGENT });
    assert.equal(agentDecision.allow, false);
    assert.equal(agentDecision.code, 'AGENT_POLICY_DENIED');
    const anonDecision = policy.evaluateResource({ caller: new Caller({ kind: 'none' }) });
    assert.equal(anonDecision.allow, false);
    assert.equal(anonDecision.code, 'AUTH_REQUIRED');
});

test('a corrupt policy fails closed (deny with persistence error)', () => {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, '{ not valid json');
    repo.invalidate();
    const result = policy.evaluate({ agent: 'a', tool: 'pub', caller: USER });
    assert.equal(result.allow, false);
    assert.equal(result.code, 'POLICY_PERSISTENCE_ERROR');
});
