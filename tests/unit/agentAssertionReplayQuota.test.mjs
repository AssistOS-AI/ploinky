import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signAgentAssertion, signAgentHttpAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { computeRchTool } from '../../Agent/lib/requestHash.mjs';

// The Router keeps one Agent Assertion replay cache per surface. These tests
// import only names that exist before the change and drive each surface with a
// small per-caller quota passed through createTokenReplayCache().

// Agent secrets derive from the master key, which also reads workspace state
// from cwd; mirror the existing assertion test harness.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-assertion-quota-'));
const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);

const suffix = `?test=${Date.now()}-${Math.random()}`;
const { createTokenReplayCache } = await import(`../../cli/server/security/tokens/JwsCodec.js${suffix}`);
const { verifyAgentAssertion } = await import(`../../cli/server/mcp-proxy/invocationMinter.js${suffix}`);
const {
    handleOpenAiAgentDiscoveryRoute,
    OPENAI_AGENT_DISCOVERY_PATH,
    OPENAI_AGENT_DISCOVERY_TOOL,
    OPENAI_AGENT_DISCOVERY_TARGET,
} = await import(`../../cli/server/openAiAgentDiscovery.js${suffix}`);
const { verifyAndMintAgentOpenAiCall } = await import(`../../cli/server/agentOpenAiDelegation.js${suffix}`);
const marketplaceModule = await import(`../../cli/server/authHandlers/marketplaceRoutes.js${suffix}`);
const { deriveAgentRequestSecret } = await import(`../../cli/utils/security/masterKey.js${suffix}`);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = originalMasterKey;
});

const T0 = Math.floor(Date.now() / 1000) * 1000;
const AGENT_A = 'agent:fixtures/flooder';
const AGENT_B = 'agent:fixtures/bystander';
const MCP_TARGET = 'agent:fixtures/target';
const MCP_TOOL = 'echo';
const MCP_ARGUMENTS = { value: 1 };
const CHAT_PATH = '/v1/chat/completions';
const CHAT_TOOL = '__openai_chat_completions__';
const CHAT_ROUTE_KEY = 'llmAssistant';
const CHAT_ROUTE = { repo: 'fixtures', agent: 'llmAssistant', hostPort: 7501 };
const CHAT_BODY = Buffer.from(JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'hi' }] }));

function envFor(agentId) {
    return { PLOINKY_AGENT_ID: agentId, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(agentId) };
}

function useMockedClock(t) {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
}

function verifyMcpAssertion(agentId, replayCache) {
    const token = signAgentAssertion({
        method: 'POST',
        path: '/mcp',
        targetAgent: MCP_TARGET,
        tool: MCP_TOOL,
        argumentsObj: MCP_ARGUMENTS,
        env: envFor(agentId),
    });
    return verifyAgentAssertion({
        token,
        method: 'POST',
        path: '/mcp',
        tool: MCP_TOOL,
        rch: computeRchTool({ method: 'POST', path: '/mcp', tool: MCP_TOOL, arguments: MCP_ARGUMENTS }),
        targetAgentId: MCP_TARGET,
        replayCache,
    });
}

function mockResponse() {
    const res = {
        statusCode: null,
        chunks: [],
        writeHead(status) { this.statusCode = status; },
        end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); },
    };
    res.json = () => JSON.parse(Buffer.concat(res.chunks).toString('utf8'));
    return res;
}

function callDiscovery(agentId, replayCache) {
    const token = signAgentHttpAssertion({
        method: 'GET',
        path: OPENAI_AGENT_DISCOVERY_PATH,
        body: Buffer.alloc(0),
        targetAgent: OPENAI_AGENT_DISCOVERY_TARGET,
        tool: OPENAI_AGENT_DISCOVERY_TOOL,
        env: envFor(agentId),
    });
    const res = mockResponse();
    const handled = handleOpenAiAgentDiscoveryRoute(
        { method: 'GET', headers: { authorization: `Bearer ${token}` } },
        res,
        { pathname: OPENAI_AGENT_DISCOVERY_PATH },
        { routing: { routes: {} }, replayCache },
    );
    assert.equal(handled, true);
    return res;
}

function callDelegation(agentId, replayCache) {
    const token = signAgentHttpAssertion({
        method: 'POST',
        path: CHAT_PATH,
        body: CHAT_BODY,
        targetAgent: CHAT_ROUTE_KEY,
        tool: CHAT_TOOL,
        env: envFor(agentId),
    });
    return verifyAndMintAgentOpenAiCall({
        token,
        routeKey: CHAT_ROUTE_KEY,
        route: CHAT_ROUTE,
        body: CHAT_BODY,
        replayCache,
    });
}

function verifyMarketplaceRead(agentId, replayCache) {
    const token = signAgentHttpAssertion({
        method: 'GET',
        path: marketplaceModule.MARKETPLACE_PATH,
        body: Buffer.alloc(0),
        targetAgent: marketplaceModule.MARKETPLACE_AGENT_TARGET,
        tool: marketplaceModule.MARKETPLACE_READ_TOOL,
        env: envFor(agentId),
    });
    return marketplaceModule.__testables.verifyMarketplaceAgentRequest({
        req: { headers: { authorization: `Bearer ${token}` } },
        method: 'GET',
        tool: marketplaceModule.MARKETPLACE_READ_TOOL,
        replayCache,
    });
}

test('an agent at its assertion quota is refused while another agent is admitted', (t) => {
    useMockedClock(t);
    const replayCache = createTokenReplayCache({ perCallerMaxSize: 2 });
    assert.equal(verifyMcpAssertion(AGENT_A, replayCache).callerPrincipal, AGENT_A);
    assert.equal(verifyMcpAssertion(AGENT_A, replayCache).callerPrincipal, AGENT_A);
    assert.throws(() => verifyMcpAssertion(AGENT_A, replayCache), { code: 'PLOINKY_REPLAY_QUOTA_EXHAUSTED' });
    assert.equal(verifyMcpAssertion(AGENT_B, replayCache).callerPrincipal, AGENT_B);
});

test('OpenAI discovery answers 429 when the calling agent\'s assertion quota is exhausted', (t) => {
    useMockedClock(t);
    const replayCache = createTokenReplayCache({ perCallerMaxSize: 1 });
    assert.equal(callDiscovery(AGENT_A, replayCache).statusCode, 200);
    const refused = callDiscovery(AGENT_A, replayCache);
    assert.equal(refused.statusCode, 429);
    assert.deepEqual(refused.json(), { complete: false, error: 'replay_quota_exhausted' });
    assert.equal(callDiscovery(AGENT_B, replayCache).statusCode, 200);
});

test('OpenAI delegation answers 429 when the calling agent\'s assertion quota is exhausted', (t) => {
    useMockedClock(t);
    const replayCache = createTokenReplayCache({ perCallerMaxSize: 1 });
    const admitted = callDelegation(AGENT_A, replayCache);
    assert.equal(admitted.ok, true);
    assert.equal(admitted.callerPrincipal, AGENT_A);
    const result = callDelegation(AGENT_A, replayCache);
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.error, 'replay_quota_exhausted');
    assert.equal(callDelegation(AGENT_B, replayCache).ok, true);
});

test('Marketplace assertion verification reports quota exhaustion with its own code', (t) => {
    useMockedClock(t);
    const replayCache = createTokenReplayCache({ perCallerMaxSize: 1 });
    assert.equal(verifyMarketplaceRead(AGENT_A, replayCache).callerPrincipal, AGENT_A);
    assert.throws(() => verifyMarketplaceRead(AGENT_A, replayCache), { code: 'PLOINKY_REPLAY_QUOTA_EXHAUSTED' });
    assert.equal(verifyMarketplaceRead(AGENT_B, replayCache).callerPrincipal, AGENT_B);
});
