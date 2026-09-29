import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import http from 'node:http';

import { signAgentHttpAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-marketplace-agent-'));
const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = 'm'.repeat(64);

const suffix = `?test=${Date.now()}`;
const marketplaceModule = await import(`../../cli/server/authHandlers/marketplaceRoutes.js${suffix}`);
const { deriveAgentRequestSecret } = await import(`../../cli/utils/security/masterKey.js${suffix}`);

const caller = 'agent:repo/caller';
const agentEnv = {
    PLOINKY_AGENT_ID: caller,
    PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(caller),
};

test('RepositoryClient signs each repository action for the current Marketplace routes', async (t) => {
    const originalEnvironment = { ...process.env };
    const { installGeneratedRouterRuntime } = await import('../helpers/generatedRouterRuntime.mjs');
    const { createRepositoryClient } = await import('../../Agent/client/RepositoryClient.mjs');
    const requests = [];
    const replayCache = createMemoryReplayCache();
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks);
        const body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : null;
        const tool = req.method === 'GET' ? 'marketplace.read'
            : body.action === 'install_repo' ? 'repositories.prepare' : `repositories.${body.action}`;
        try {
            const verified = marketplaceModule.__testables.verifyMarketplaceAgentRequest({
                req, method: req.method, requestPath: req.url, tool, rawBody, replayCache,
            });
            assert.equal(verified.callerPrincipal, caller);
            requests.push({ method: req.method, path: req.url, tool });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, repositories: [], result: { conflicts: [] } }));
        } catch {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'agent_assertion_rejected' }));
        }
    });
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        for (const key of Object.keys(process.env)) {
            if (!Object.hasOwn(originalEnvironment, key)) delete process.env[key];
        }
        Object.assign(process.env, originalEnvironment);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    installGeneratedRouterRuntime({ origin: `http://127.0.0.1:${server.address().port}`, tempDir, agentPrincipal: caller });
    Object.assign(process.env, agentEnv);
    const client = createRepositoryClient();
    await client.listRepositories();
    await client.install({ repos: [], skillRepos: [] });
    await client.remove([]);
    await client.prepareRepository({ url: 'https://example.test/skills.git', name: 'skills' });
    assert.deepEqual(requests, [
        { method: 'GET', path: '/api/marketplace/list-repos', tool: 'marketplace.read' },
        { method: 'POST', path: '/api/marketplace/repos', tool: 'repositories.install' },
        { method: 'POST', path: '/api/marketplace/repos', tool: 'repositories.remove' },
        { method: 'POST', path: '/api/marketplace/repos', tool: 'repositories.prepare' },
        { method: 'GET', path: '/api/marketplace/list-repos', tool: 'marketplace.read' },
    ]);
});

test.after(() => {
    process.chdir(originalCwd);
    if (originalMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = originalMasterKey;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Marketplace verifies an agent-signed enable request and rejects replay', () => {
    const rawBody = Buffer.from(JSON.stringify({
        action: 'enable_agent',
        agentRef: 'repo/worker',
        mode: 'global',
    }));
    const token = signAgentHttpAssertion({
        method: 'POST',
        path: marketplaceModule.MARKETPLACE_PATH,
        body: rawBody,
        targetAgent: marketplaceModule.MARKETPLACE_AGENT_TARGET,
        tool: marketplaceModule.MARKETPLACE_ENABLE_TOOL,
        env: agentEnv,
    });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const replayCache = createMemoryReplayCache();
    const verified = marketplaceModule.__testables.verifyMarketplaceAgentRequest({
        req,
        method: 'POST',
        tool: marketplaceModule.MARKETPLACE_ENABLE_TOOL,
        rawBody,
        replayCache,
    });
    assert.equal(verified.callerPrincipal, caller);
    assert.throws(() => marketplaceModule.__testables.verifyMarketplaceAgentRequest({
        req,
        method: 'POST',
        tool: marketplaceModule.MARKETPLACE_ENABLE_TOOL,
        rawBody,
        replayCache,
    }), /replay|jti/i);
});

test('Marketplace assertion is bound to the exact body', () => {
    const signedBody = Buffer.from(JSON.stringify({ action: 'enable_agent', agentRef: 'repo/worker' }));
    const token = signAgentHttpAssertion({
        method: 'POST',
        path: marketplaceModule.MARKETPLACE_PATH,
        body: signedBody,
        targetAgent: marketplaceModule.MARKETPLACE_AGENT_TARGET,
        tool: marketplaceModule.MARKETPLACE_ENABLE_TOOL,
        env: agentEnv,
    });
    assert.throws(() => marketplaceModule.__testables.verifyMarketplaceAgentRequest({
        req: { headers: { authorization: `Bearer ${token}` } },
        method: 'POST',
        tool: marketplaceModule.MARKETPLACE_ENABLE_TOOL,
        rawBody: Buffer.from(JSON.stringify({ action: 'disable_agent', agentRef: 'repo/worker' })),
        replayCache: createMemoryReplayCache(),
    }), /request hash|rch/i);
});

test('Marketplace assertion is bound to the exact query', () => {
    const token = signAgentHttpAssertion({
        method: 'GET',
        path: marketplaceModule.MARKETPLACE_PATH,
        query: '',
        targetAgent: marketplaceModule.MARKETPLACE_AGENT_TARGET,
        tool: marketplaceModule.MARKETPLACE_READ_TOOL,
        env: agentEnv,
    });
    assert.throws(() => marketplaceModule.__testables.verifyMarketplaceAgentRequest({
        req: { headers: { authorization: `Bearer ${token}` } },
        method: 'GET',
        query: 'unexpected=1',
        tool: marketplaceModule.MARKETPLACE_READ_TOOL,
        replayCache: createMemoryReplayCache(),
    }), /request hash|rch/i);
});

test('Marketplace rejects agent mutation actions other than enable_agent', async () => {
    const req = Readable.from([Buffer.from(JSON.stringify({
        action: 'disable_agent',
        agentRef: 'repo/worker',
    }))]);
    req.method = 'POST';
    req.headers = { authorization: 'Bearer invalid-but-present' };
    const response = {
        statusCode: null,
        payload: '',
        writeHead(statusCode) {
            this.statusCode = statusCode;
        },
        end(payload = '') {
            this.payload = String(payload);
        },
    };

    const handled = await marketplaceModule.handleMarketplaceRoutes(
        req,
        response,
        new URL('http://localhost/api/marketplace/agents')
    );

    assert.equal(handled, true);
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.payload).error, 'agent_action_forbidden');
});

for (const resource of ['install', 'remove']) {
    test(`Repository ${resource} assertion is bound to its path and operation`, () => {
        const requestPath = `${marketplaceModule.MARKETPLACE_PATH}/repos`;
        const tool = `repositories.${resource}`;
        const rawBody = Buffer.from(JSON.stringify({ action: resource }));
        const token = signAgentHttpAssertion({ method: 'POST', path: requestPath, body: rawBody,
            targetAgent: marketplaceModule.MARKETPLACE_AGENT_TARGET, tool, env: agentEnv });
        const options = { req: { headers: { authorization: `Bearer ${token}` } },
            method: 'POST', tool, rawBody, requestPath };
        assert.equal(marketplaceModule.__testables.verifyMarketplaceAgentRequest({ ...options,
            replayCache: createMemoryReplayCache() }).callerPrincipal, caller);
        assert.throws(() => marketplaceModule.__testables.verifyMarketplaceAgentRequest({ ...options,
            requestPath: `${marketplaceModule.MARKETPLACE_PATH}/agents`, replayCache: createMemoryReplayCache() }));
        assert.throws(() => marketplaceModule.__testables.verifyMarketplaceAgentRequest({ ...options,
            tool: 'repositories.other', replayCache: createMemoryReplayCache() }));
    });
}
