import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { signAgentHttpAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { createContainerAgentCredentialContext } from '../../Agent/lib/agentCredentialContext.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-marketplace-agent-'));
const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = 'm'.repeat(64);

const suffix = `?test=${Date.now()}`;
const marketplaceModule = await import(`../../cli/server/authHandlers/marketplaceRoutes.js${suffix}`);
const { deriveAgentRequestSecret } = await import(`../../cli/utils/security/masterKey.js${suffix}`);
const { installGeneratedRouterRuntime } = await import(`../helpers/generatedRouterRuntime.mjs${suffix}`);

const caller = 'agent:repo/caller';
const generatedRuntime = installGeneratedRouterRuntime({
    origin: 'http://127.0.0.1:8080',
    publicAuthority: '127.0.0.1:8080',
    tempDir,
    agentPrincipal: caller,
});
const credentialContext = createContainerAgentCredentialContext({
    ...generatedRuntime.env,
    PLOINKY_RUNTIME: 'container',
    PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(caller),
    PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
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
        credentialContext,
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
        credentialContext,
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
        credentialContext,
    });
    assert.throws(() => marketplaceModule.__testables.verifyMarketplaceAgentRequest({
        req: { headers: { authorization: `Bearer ${token}` } },
        method: 'GET',
        query: 'unexpected=1',
        tool: marketplaceModule.MARKETPLACE_READ_TOOL,
        replayCache: createMemoryReplayCache(),
    }), /request hash|rch/i);
});

test('Marketplace assertion signing rejects a missing credential context', () => {
    assert.throws(() => signAgentHttpAssertion({
        method: 'GET',
        path: marketplaceModule.MARKETPLACE_PATH,
        targetAgent: marketplaceModule.MARKETPLACE_AGENT_TARGET,
        tool: marketplaceModule.MARKETPLACE_READ_TOOL,
    }), (error) => error?.code === 'PLOINKY_AGENT_CREDENTIAL_CONTEXT_REQUIRED');
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
        new URL('http://localhost/api/marketplace')
    );

    assert.equal(handled, true);
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.payload).error, 'agent_action_forbidden');
});
