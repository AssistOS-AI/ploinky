import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { signAgentAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { deriveAgentRequestSecret } from '../../cli/services/masterKey.js';
import { mintUserDelegationGrant } from '../../cli/server/mcp-proxy/userDelegationGrant.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mcp-delegation-'));
const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
const repoDir = path.join(tempDir, '.ploinky', 'repos', 'AssistOSExplorer', 'dpuAgent');

fs.mkdirSync(repoDir, { recursive: true });
fs.writeFileSync(path.join(repoDir, 'manifest.json'), JSON.stringify({ about: 'dpu agent test fixture' }, null, 2));
const gitRepoDir = path.join(tempDir, '.ploinky', 'repos', 'AssistOSExplorer', 'gitAgent');
fs.mkdirSync(gitRepoDir, { recursive: true });
fs.writeFileSync(path.join(gitRepoDir, 'manifest.json'), JSON.stringify({ about: 'git agent test fixture' }, null, 2));
fs.writeFileSync(path.join(gitRepoDir, 'mcp-config.json'), JSON.stringify({
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
fs.writeFileSync(path.join(tempDir, '.ploinky', 'routing.json'), JSON.stringify({
    routes: {
        gitAgent: { repo: 'AssistOSExplorer', agent: 'gitAgent', hostPath: gitRepoDir, hostPort: 7401 },
    },
}, null, 2));
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '9'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const { verifyDelegatedAgentToolCall, buildInvocationContextForProviderCall } = await import(`../../cli/server/mcp-proxy/index.js${moduleSuffix}`);
const { deriveSubkey } = await import(`../../cli/services/masterKey.js${moduleSuffix}`);
const { verifyUserDelegationGrant } = await import(`../../cli/server/mcp-proxy/userDelegationGrant.js${moduleSuffix}`);

const SOURCE_AGENT = 'agent:AssistOSExplorer/onlyOffice';
const TARGET_ROUTE = 'dpuAgent';
const TARGET_AGENT = 'agent:AssistOSExplorer/dpuAgent';
const TOOL = 'dpu_confidential_get';
const ARGS = { id: 'doc-1' };

function envFor(agentId) {
    return { PLOINKY_AGENT_ID: agentId, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(agentId) };
}

function makeReq({ assertion, delegationToken }) {
    return {
        headers: {
            authorization: `Bearer ${assertion}`,
            ...(delegationToken ? { 'x-ploinky-user-delegation': delegationToken } : {}),
        },
    };
}

function mintDelegation(overrides = {}) {
    const signingSecret = deriveSubkey('router-user-delegation', 32);
    return mintUserDelegationGrant({
        signingSecret,
        now: new Date(overrides.now || Date.now()),
        ttlSeconds: overrides.ttlSeconds || 1800,
        sourceAgentId: overrides.sourceAgentId || SOURCE_AGENT,
        service: {
            routeKey: 'onlyOffice',
            externalPrefix: '/services/onlyoffice/',
            internalPrefix: '/control/',
            internalPath: '/control/office/session',
        },
        user: overrides.user || { id: 'local:alice', username: 'alice', roles: ['user'] },
        targetAgentId: overrides.targetAgentId || TARGET_AGENT,
        tools: overrides.tools || [TOOL, 'dpu_confidential_update'],
        scopes: ['dpu:confidential:read', 'dpu:confidential:write'],
    });
}

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = originalMasterKey;
});

test('mcp proxy verifies agent assertion before user delegation grant', () => {
    const { token: delegationToken } = mintDelegation({ sourceAgentId: 'agent:AssistOSExplorer/otherAgent' });
    const assertion = signAgentAssertion({
        targetAgent: TARGET_ROUTE,
        tool: TOOL,
        argumentsObj: ARGS,
        env: envFor(SOURCE_AGENT),
    });
    assert.throws(() => verifyDelegatedAgentToolCall({
        req: makeReq({ assertion, delegationToken }),
        agentName: TARGET_ROUTE,
        toolName: TOOL,
        rawArgs: { ...ARGS, id: 'tampered' },
        assertionCache: createMemoryReplayCache(),
        userDelegationCache: createMemoryReplayCache(),
    }), /request hash mismatch/);
});

test('mcp proxy mints router request with caller agent and usr user claims', () => {
    const { token: delegationToken } = mintDelegation();
    const assertion = signAgentAssertion({
        targetAgent: TARGET_ROUTE,
        tool: TOOL,
        argumentsObj: ARGS,
        env: envFor(SOURCE_AGENT),
    });
    const verified = verifyDelegatedAgentToolCall({
        req: makeReq({ assertion, delegationToken }),
        agentName: TARGET_ROUTE,
        toolName: TOOL,
        rawArgs: ARGS,
        assertionCache: createMemoryReplayCache(),
        userDelegationCache: createMemoryReplayCache(),
    });
    const ctx = buildInvocationContextForProviderCall({
        req: { delegatedAgentVerified: verified },
        agentName: TARGET_ROUTE,
        toolName: TOOL,
        toolArgs: ARGS,
    });

    assert.equal(ctx.payload.sub, SOURCE_AGENT);
    assert.equal(ctx.payload.actor.kind, 'agent');
    assert.equal(ctx.payload.caller.id, SOURCE_AGENT);
    assert.equal(ctx.payload.usr.id, 'local:alice');
    assert.equal(ctx.payload.delegation.sourceAgentId, SOURCE_AGENT);
    assert.equal(ctx.payload.delegations, undefined);
    assert.equal(ctx.payload.delegation.sourceAgentId, SOURCE_AGENT);
});

test('mcp proxy rejects a valid grant from the wrong source agent', () => {
    const { token: delegationToken } = mintDelegation({ sourceAgentId: 'agent:AssistOSExplorer/notOnlyOffice' });
    const assertion = signAgentAssertion({
        targetAgent: TARGET_ROUTE,
        tool: TOOL,
        argumentsObj: ARGS,
        env: envFor(SOURCE_AGENT),
    });
    assert.throws(() => verifyDelegatedAgentToolCall({
        req: makeReq({ assertion, delegationToken }),
        agentName: TARGET_ROUTE,
        toolName: TOOL,
        rawArgs: ARGS,
        assertionCache: createMemoryReplayCache(),
        userDelegationCache: createMemoryReplayCache(),
    }), /delegation source mismatch/);
});

test('mcp proxy rejects a grant for the wrong target agent', () => {
    const { token: delegationToken } = mintDelegation({ targetAgentId: 'agent:AssistOSExplorer/gitAgent' });
    const assertion = signAgentAssertion({
        targetAgent: TARGET_ROUTE,
        tool: TOOL,
        argumentsObj: ARGS,
        env: envFor(SOURCE_AGENT),
    });
    assert.throws(() => verifyDelegatedAgentToolCall({
        req: makeReq({ assertion, delegationToken }),
        agentName: TARGET_ROUTE,
        toolName: TOOL,
        rawArgs: ARGS,
        assertionCache: createMemoryReplayCache(),
        userDelegationCache: createMemoryReplayCache(),
    }), /delegation target mismatch/);
});

test('mcp proxy reuses one delegation grant across multiple scoped tool calls until expiry', () => {
    const { token: delegationToken } = mintDelegation();
    const firstAssertion = signAgentAssertion({
        targetAgent: TARGET_ROUTE,
        tool: TOOL,
        argumentsObj: ARGS,
        env: envFor(SOURCE_AGENT),
    });
    const updateArgs = { id: 'doc-1', content: 'updated' };
    const secondAssertion = signAgentAssertion({
        targetAgent: TARGET_ROUTE,
        tool: 'dpu_confidential_update',
        argumentsObj: updateArgs,
        env: envFor(SOURCE_AGENT),
    });
    const delegationCache = createMemoryReplayCache();
    const first = verifyDelegatedAgentToolCall({
        req: makeReq({ assertion: firstAssertion, delegationToken }),
        agentName: TARGET_ROUTE,
        toolName: TOOL,
        rawArgs: ARGS,
        assertionCache: createMemoryReplayCache(),
        userDelegationCache: delegationCache,
    });
    assert.equal(first.userDelegation.user.id, 'local:alice');
    const second = verifyDelegatedAgentToolCall({
        req: makeReq({ assertion: secondAssertion, delegationToken }),
        agentName: TARGET_ROUTE,
        toolName: 'dpu_confidential_update',
        rawArgs: updateArgs,
        assertionCache: createMemoryReplayCache(),
        userDelegationCache: delegationCache,
    });
    assert.equal(second.userDelegation.user.id, 'local:alice');
});

test('mcp proxy rejects expired delegation grants', () => {
    const assertion = signAgentAssertion({
        targetAgent: TARGET_ROUTE,
        tool: TOOL,
        argumentsObj: ARGS,
        env: envFor(SOURCE_AGENT),
    });
    const { token: expiredToken } = mintDelegation({ now: '2026-06-09T10:00:00.000Z', ttlSeconds: 30 });
    assert.throws(() => verifyDelegatedAgentToolCall({
        req: makeReq({ assertion, delegationToken: expiredToken }),
        agentName: TARGET_ROUTE,
        toolName: TOOL,
        rawArgs: ARGS,
        assertionCache: createMemoryReplayCache(),
        userDelegationCache: createMemoryReplayCache(),
    }), /delegation expired/);
});

test('user-originated configured tool call mints delegations on the shared mint path', () => {
    const ctx = buildInvocationContextForProviderCall({
        req: { user: { id: 'local:admin', username: 'admin', email: '', roles: ['admin'] } },
        agentName: 'gitAgent',
        toolName: 'git_auth_store_token',
        toolArgs: { token: 'redacted-by-test' },
    });
    assert.equal(ctx.payload.actor.kind, 'user');
    const entry = ctx.payload.delegations.dpuGitSecrets;
    assert.ok(entry.token);
    assert.equal(entry.targetAgentId, 'agent:AssistOSExplorer/dpuAgent');

    const verified = verifyUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32),
        token: entry.token,
        expectedSourceAgentId: 'agent:AssistOSExplorer/gitAgent',
        expectedTargetAgentId: 'agent:AssistOSExplorer/dpuAgent',
        expectedTool: 'dpu_secret_put',
    });
    assert.equal(verified.user.id, 'local:admin');
});

test('user call to an unconfigured tool mints no delegations', () => {
    const ctx = buildInvocationContextForProviderCall({
        req: { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } },
        agentName: 'gitAgent',
        toolName: 'git_status',
        toolArgs: { path: '/tmp/x' },
    });
    assert.equal(ctx.payload.delegations, undefined);
});

test('guest call to a configured tool mints no delegations', () => {
    const ctx = buildInvocationContextForProviderCall({
        req: { user: { id: 'guest-1', username: 'guest', roles: ['guest'] } },
        agentName: 'gitAgent',
        toolName: 'git_auth_store_token',
        toolArgs: { token: 'redacted-by-test' },
    });
    assert.equal(ctx.payload.delegations, undefined);
});
