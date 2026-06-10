import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mcp-delegations-'));
const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '8'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const {
    resolveMcpToolDelegations,
    normalizeMcpDelegationEntries,
    buildMcpDelegationsForUserCall,
    deriveDelegationKey,
} = await import(`../../cli/server/mcp-proxy/mcpDelegations.js${moduleSuffix}`);
const { verifyUserDelegationGrant } = await import(`../../cli/server/mcp-proxy/userDelegationGrant.js${moduleSuffix}`);
const { deriveSubkey } = await import(`../../cli/services/masterKey.js${moduleSuffix}`);

const SOURCE_DIR = path.join(tempDir, 'agents', 'gitAgent');
fs.mkdirSync(SOURCE_DIR, { recursive: true });
fs.writeFileSync(path.join(SOURCE_DIR, 'mcp-config.json'), JSON.stringify({
    tools: [
        {
            name: 'git_auth_store_token',
            delegations: [
                {
                    key: 'dpuGitSecrets',
                    targetAgentId: 'agent:./dpuAgent',
                    tools: ['dpu_secret_put', 'dpu_secret_grant'],
                    scopes: ['secret:write', 'secret:grant'],
                    ttlSeconds: 120,
                },
            ],
        },
        { name: 'git_status' },
    ],
}, null, 2));

const ROUTE = { repo: 'AchillesIDE', agent: 'gitAgent', hostPath: SOURCE_DIR };
const ROUTES = { gitAgent: ROUTE };

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = originalMasterKey;
});

test('resolveMcpToolDelegations expands relative targets and returns normalized entries', () => {
    const entries = resolveMcpToolDelegations({ routeKey: 'gitAgent', toolName: 'git_auth_store_token', routes: ROUTES });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, 'dpuGitSecrets');
    assert.equal(entries[0].targetAgentId, 'agent:AchillesIDE/dpuAgent');
    assert.equal(entries[0].sourceAgentId, 'agent:AchillesIDE/gitAgent');
    assert.deepEqual(entries[0].tools, ['dpu_secret_put', 'dpu_secret_grant']);
    assert.deepEqual(entries[0].scope, ['secret:write', 'secret:grant']);
    assert.equal(entries[0].ttlSeconds, 120);
});

test('resolveMcpToolDelegations returns [] for tools without delegations and unknown routes', () => {
    assert.deepEqual(resolveMcpToolDelegations({ routeKey: 'gitAgent', toolName: 'git_status', routes: ROUTES }), []);
    assert.deepEqual(resolveMcpToolDelegations({ routeKey: 'missing', toolName: 'git_auth_store_token', routes: ROUTES }), []);
});

test('normalizeMcpDelegationEntries rejects traversal targets, empty tools, empty scopes, bad ttl', () => {
    const base = { targetAgentId: 'agent:AchillesIDE/dpuAgent', tools: ['dpu_secret_get'], scopes: ['secret:read'], ttlSeconds: 120 };
    const ctx = { route: ROUTE, toolName: 'git_auth_status', sourceAgentId: 'agent:AchillesIDE/gitAgent' };
    assert.throws(() => normalizeMcpDelegationEntries([{ ...base, targetAgentId: 'agent:../evil' }], ctx), /invalid targetAgentId/);
    assert.throws(() => normalizeMcpDelegationEntries([{ ...base, tools: [] }], ctx), /empty delegation tools/);
    assert.throws(() => normalizeMcpDelegationEntries([{ ...base, scopes: [] }], ctx), /empty delegation scopes/);
    assert.throws(() => normalizeMcpDelegationEntries([{ ...base, ttlSeconds: 5 }], ctx), /invalid ttlSeconds/);
    assert.throws(() => normalizeMcpDelegationEntries([{ ...base, ttlSeconds: 999999 }], ctx), /invalid ttlSeconds/);
});

test('deriveDelegationKey prefers explicit key, then scope, then target agent name', () => {
    assert.equal(deriveDelegationKey({ key: 'dpuGitSecrets' }, 0), 'dpuGitSecrets');
    assert.equal(deriveDelegationKey({ scope: ['dpu:confidential:read'] }, 0), 'dpuConfidential');
    assert.equal(deriveDelegationKey({ targetAgentId: 'agent:AchillesIDE/dpuAgent' }, 0), 'dpu');
});

test('buildMcpDelegationsForUserCall mints verifiable grants for non-guest users only', () => {
    const req = { user: { id: 'local:admin', username: 'admin', email: '', roles: ['admin'] } };
    const out = buildMcpDelegationsForUserCall({ req, routeKey: 'gitAgent', toolName: 'git_auth_store_token', routes: ROUTES });
    assert.ok(out.dpuGitSecrets.token);
    assert.equal(out.dpuGitSecrets.targetAgentId, 'agent:AchillesIDE/dpuAgent');

    const verified = verifyUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32),
        token: out.dpuGitSecrets.token,
        expectedSourceAgentId: 'agent:AchillesIDE/gitAgent',
        expectedTargetAgentId: 'agent:AchillesIDE/dpuAgent',
        expectedTool: 'dpu_secret_put',
    });
    assert.equal(verified.user.id, 'local:admin');
    assert.deepEqual(verified.delegation.scope, ['secret:write', 'secret:grant']);

    const guestReq = { user: { id: 'guest-1', username: 'guest', roles: ['guest'] } };
    assert.equal(buildMcpDelegationsForUserCall({ req: guestReq, routeKey: 'gitAgent', toolName: 'git_auth_store_token', routes: ROUTES }), undefined);
    assert.equal(buildMcpDelegationsForUserCall({ req: {}, routeKey: 'gitAgent', toolName: 'git_auth_store_token', routes: ROUTES }), undefined);
    assert.equal(buildMcpDelegationsForUserCall({ req, routeKey: 'gitAgent', toolName: 'git_status', routes: ROUTES }), undefined);
});
