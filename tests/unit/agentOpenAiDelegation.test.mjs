import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRchHttp, computeRchTool, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { signAgentAssertion, signAgentHttpAssertion } from '../../Agent/lib/agentAssertion.mjs';
import {
    verifyRouterRequestFromHeaders,
    verifyOpenAiServiceAuthInfoFromHeaders,
} from '../../Agent/lib/invocationAuth.mjs';

const OPENAI_PATH = '/v1/chat/completions';
const OPENAI_TOOL = '__openai_chat_completions__';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-openai-deleg-'));
const originalCwd = process.cwd();
const originalMasterKey = process.env.PLOINKY_MASTER_KEY;

// A routing.json whose route carries repo+agent so the target principal resolves
// directly (resolveTargetAgentPrincipal reads route.repo/route.agent first).
const targetAgentDir = path.join(tempDir, '.ploinky', 'repos', 'AssistOSExplorer', 'llmAssistant');
fs.mkdirSync(targetAgentDir, { recursive: true });
fs.writeFileSync(path.join(targetAgentDir, 'manifest.json'), JSON.stringify({ about: 'llm assistant fixture' }, null, 2));
fs.writeFileSync(path.join(tempDir, '.ploinky', 'routing.json'), JSON.stringify({
    routes: {
        llmAssistant: { repo: 'AssistOSExplorer', agent: 'llmAssistant', hostPath: targetAgentDir, hostPort: 7501 },
    },
}, null, 2));
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);

const moduleSuffix = `?test=${Date.now()}-${Math.random()}`;
const {
    isDelegatedAgentOpenAiCall,
    verifyAndMintAgentOpenAiCall,
} = await import(`../../cli/server/agentOpenAiDelegation.js${moduleSuffix}`);
const { verifyAgentAssertion } = await import(`../../cli/server/mcp-proxy/invocationMinter.js${moduleSuffix}`);
const { deriveAgentRequestSecret } = await import(`../../cli/services/masterKey.js${moduleSuffix}`);

const SOURCE_AGENT = 'agent:AssistOSExplorer/soulGateway';
const TARGET_ROUTE = 'llmAssistant';
const TARGET_AGENT = 'agent:AssistOSExplorer/llmAssistant';
const ROUTE = { repo: 'AssistOSExplorer', agent: 'llmAssistant', hostPath: targetAgentDir, hostPort: 7501 };
const BODY = Buffer.from(JSON.stringify({ model: 'axl/fast', messages: [{ role: 'user', content: 'hi' }] }));

function envFor(agentId) {
    return { PLOINKY_AGENT_ID: agentId, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(agentId) };
}

// The target agent's env: holds ONLY its own per-agent secret + id (DS013).
function targetEnv() {
    return { PLOINKY_AGENT_ID: TARGET_AGENT, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(TARGET_AGENT) };
}

function makeReq({ method = 'POST', bearer, headers = {} } = {}) {
    return {
        method,
        headers: {
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
            ...headers,
        },
    };
}

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = originalMasterKey;
});

// ---------------------------------------------------------------------------
// 1. signAgentHttpAssertion binds the body via computeRchHttp; a computeRchTool
//    assertion for the same surface is REJECTED (proves HTTP binding).
// ---------------------------------------------------------------------------

test('signAgentHttpAssertion verifies via verifyAgentAssertion with computeRchHttp', () => {
    const token = signAgentHttpAssertion({
        method: 'POST',
        path: OPENAI_PATH,
        body: BODY,
        targetAgent: TARGET_ROUTE,
        tool: OPENAI_TOOL,
        env: envFor(SOURCE_AGENT),
    });
    const rch = computeRchHttp({
        method: 'POST',
        path: OPENAI_PATH,
        query: '',
        bodyHash: sha256RawBodyHash(BODY),
    });
    const result = verifyAgentAssertion({
        token,
        method: 'POST',
        path: OPENAI_PATH,
        tool: OPENAI_TOOL,
        rch,
        targetAgentId: TARGET_ROUTE,
        replayCache: createMemoryReplayCache(),
    });
    assert.equal(result.callerPrincipal, SOURCE_AGENT);
    assert.equal(result.payload.tool, OPENAI_TOOL);
});

test('a computeRchTool assertion is rejected on the HTTP surface (proves body binding)', () => {
    // Sign the same {method,path,tool} via the MCP signer (computeRchTool over the
    // body-as-arguments). The HTTP verifier expects computeRchHttp(rawBodyHash), so
    // the request-hash must not match.
    const mcpToken = signAgentAssertion({
        method: 'POST',
        path: OPENAI_PATH,
        tool: OPENAI_TOOL,
        argumentsObj: JSON.parse(BODY.toString('utf8')),
        targetAgent: TARGET_ROUTE,
        env: envFor(SOURCE_AGENT),
    });
    const httpRch = computeRchHttp({
        method: 'POST',
        path: OPENAI_PATH,
        query: '',
        bodyHash: sha256RawBodyHash(BODY),
    });
    assert.notEqual(
        computeRchTool({ method: 'POST', path: OPENAI_PATH, tool: OPENAI_TOOL, arguments: JSON.parse(BODY.toString('utf8')) }),
        httpRch,
    );
    assert.throws(() => verifyAgentAssertion({
        token: mcpToken,
        method: 'POST',
        path: OPENAI_PATH,
        tool: OPENAI_TOOL,
        rch: httpRch,
        targetAgentId: TARGET_ROUTE,
        replayCache: createMemoryReplayCache(),
    }), /request hash mismatch/);
});

// ---------------------------------------------------------------------------
// 2. Path-exact bypass predicate.
// ---------------------------------------------------------------------------

test('isDelegatedAgentOpenAiCall is path-exact and method-exact', () => {
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const baseReq = makeReq({ bearer });
    // Exact match.
    assert.equal(isDelegatedAgentOpenAiCall({ agentName: TARGET_ROUTE, method: 'POST', agentProxyPath: OPENAI_PATH, req: baseReq }), true);
    // Wrong path / trailing segment / query string / sibling path.
    assert.equal(isDelegatedAgentOpenAiCall({ agentName: TARGET_ROUTE, method: 'POST', agentProxyPath: '/v1/chat/completions/x', req: baseReq }), false);
    assert.equal(isDelegatedAgentOpenAiCall({ agentName: TARGET_ROUTE, method: 'POST', agentProxyPath: '/v1/chat/completions?x=1', req: baseReq }), false);
    assert.equal(isDelegatedAgentOpenAiCall({ agentName: TARGET_ROUTE, method: 'POST', agentProxyPath: '/v1/other', req: baseReq }), false);
    assert.equal(isDelegatedAgentOpenAiCall({ agentName: TARGET_ROUTE, method: 'POST', agentProxyPath: '/mcp', req: baseReq }), false);
    // Wrong method.
    assert.equal(isDelegatedAgentOpenAiCall({ agentName: TARGET_ROUTE, method: 'GET', agentProxyPath: OPENAI_PATH, req: baseReq }), false);
    // No agent / no assertion.
    assert.equal(isDelegatedAgentOpenAiCall({ agentName: null, method: 'POST', agentProxyPath: OPENAI_PATH, req: baseReq }), false);
    assert.equal(isDelegatedAgentOpenAiCall({ agentName: TARGET_ROUTE, method: 'POST', agentProxyPath: OPENAI_PATH, req: makeReq({}) }), false);
});

// ---------------------------------------------------------------------------
// 3. verifyAndMintAgentOpenAiCall accept + mint, and the full reject matrix.
// ---------------------------------------------------------------------------

test('verifyAndMintAgentOpenAiCall accepts a valid assertion and mints a body-bound router token', () => {
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const result = verifyAndMintAgentOpenAiCall({
        token: bearer,
        routeKey: TARGET_ROUTE,
        route: ROUTE,
        body: BODY,
        replayCache: createMemoryReplayCache(),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.callerPrincipal, SOURCE_AGENT);
    assert.equal(result.targetAgentId, TARGET_AGENT);

    // The minted token is in x-ploinky-auth-info, signed with the TARGET secret,
    // and its rch matches computeRchHttp over the exact body.
    const authInfo = JSON.parse(result.authInfoHeader['x-ploinky-auth-info']);
    assert.equal(authInfo.invocationBody.bodyHash, sha256RawBodyHash(BODY));
    const expectedRch = computeRchHttp({ method: 'POST', path: OPENAI_PATH, query: '', bodyHash: sha256RawBodyHash(BODY) });

    const verified = verifyOpenAiServiceAuthInfoFromHeaders(result.authInfoHeader, {
        env: targetEnv(),
        replayCache: createMemoryReplayCache(),
        body: BODY,
    });
    assert.equal(verified.ok, true, verified.reason);
    assert.equal(verified.payload.typ, 'router-request');
    assert.equal(verified.payload.tool, OPENAI_TOOL);
    assert.equal(verified.payload.aud, TARGET_AGENT);
    assert.equal(verified.payload.rch, expectedRch);
    assert.equal(verified.payload.actor.kind, 'agent');
    assert.equal(verified.payload.sub, SOURCE_AGENT);
});

test('verifyAndMintAgentOpenAiCall rejects a missing assertion', () => {
    const result = verifyAndMintAgentOpenAiCall({ token: '', routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.error, 'agent_assertion_required');
});

test('verifyAndMintAgentOpenAiCall rejects a wrong-secret (forged) assertion', () => {
    // iss claims the source agent, but the token is HMAC'd with a DIFFERENT secret.
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchHttp({ method: 'POST', path: OPENAI_PATH, query: '', bodyHash: sha256RawBodyHash(BODY) });
    const forged = signHmacJwt({
        payload: {
            typ: 'agent-assertion', iss: SOURCE_AGENT, sub: SOURCE_AGENT, aud: 'ploinky-router',
            targetAgent: TARGET_ROUTE, method: 'POST', path: OPENAI_PATH, tool: OPENAI_TOOL, rch,
            iat: now, exp: now + 60, jti: 'forge-openai-1',
        },
        secret: deriveAgentRequestSecret('agent:AssistOSExplorer/imposter', { encoding: 'buffer' }),
    });
    const result = verifyAndMintAgentOpenAiCall({ token: forged, routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
});

test('verifyAndMintAgentOpenAiCall rejects a body changed after signing (wrong bodyHash)', () => {
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const tamperedBody = Buffer.from(JSON.stringify({ model: 'axl/fast', messages: [{ role: 'user', content: 'TAMPERED' }] }));
    const result = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: TARGET_ROUTE, route: ROUTE, body: tamperedBody, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
});

test('verifyAndMintAgentOpenAiCall rejects an assertion bound to a different target agent', () => {
    // Source signs for a DIFFERENT route; router resolves THIS route's principal.
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: 'someOtherRoute', tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const result = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
});

test('verifyAndMintAgentOpenAiCall rejects an assertion signed for the wrong path', () => {
    const bearer = signAgentHttpAssertion({ path: '/v1/embeddings', body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const result = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
});

test('verifyAndMintAgentOpenAiCall rejects a replayed assertion jti (shared cache)', () => {
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const replayCache = createMemoryReplayCache();
    const first = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache });
    assert.equal(first.ok, true, first.error);
    const second = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache });
    assert.equal(second.ok, false);
    assert.equal(second.status, 401);
});

test('verifyAndMintAgentOpenAiCall fails closed when the route principal cannot be resolved', () => {
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const result = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: 'orphan', route: { hostPort: 7777 }, body: BODY, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
});

// ---------------------------------------------------------------------------
// 4. The minted router token is NOT accepted on the wrong surface (defence in
//    depth): tool/audience/body all bind.
// ---------------------------------------------------------------------------

test('the minted router token is rejected when the agent recomputes a different body hash', () => {
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const result = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, true, result.error);

    const verified = verifyOpenAiServiceAuthInfoFromHeaders(result.authInfoHeader, {
        env: targetEnv(),
        replayCache: createMemoryReplayCache(),
        body: Buffer.from(JSON.stringify({ model: 'axl/fast', messages: [{ role: 'user', content: 'different' }] })),
    });
    assert.equal(verified.ok, false);
    assert.match(verified.reason, /request hash mismatch/);
});

test('the minted router token is rejected by the MCP/tool router-request verifier (tool mismatch)', () => {
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const result = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, true, result.error);
    const token = JSON.parse(result.authInfoHeader['x-ploinky-auth-info']).invocationToken;

    // Try to pass it off as a generic bearer router-request for an MCP tool call.
    const verified = verifyRouterRequestFromHeaders({ authorization: `Bearer ${token}` }, {
        env: targetEnv(),
        replayCache: createMemoryReplayCache(),
        method: 'POST',
        path: '/mcp',
        tool: 'some_mcp_tool',
        rch: computeRchTool({ method: 'POST', path: '/mcp', tool: 'some_mcp_tool', arguments: {} }),
    });
    assert.equal(verified.ok, false);
});

// ---------------------------------------------------------------------------
// 5. AgentServer-equivalent verification: only a valid router-minted token is
//    accepted; the verifier never emits legacy identity headers.
// ---------------------------------------------------------------------------

test('verifyOpenAiServiceAuthInfoFromHeaders rejects an absent token envelope', () => {
    const verified = verifyOpenAiServiceAuthInfoFromHeaders({ 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'x' } }) }, {
        env: targetEnv(),
        replayCache: createMemoryReplayCache(),
        body: BODY,
    });
    assert.equal(verified.ok, false);
    assert.match(verified.reason, /missing OpenAI service invocation token/);
});

test('verifyOpenAiServiceAuthInfoFromHeaders rejects a replayed router token', () => {
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const result = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, true, result.error);
    const replayCache = createMemoryReplayCache();
    const first = verifyOpenAiServiceAuthInfoFromHeaders(result.authInfoHeader, { env: targetEnv(), replayCache, body: BODY });
    assert.equal(first.ok, true, first.reason);
    const second = verifyOpenAiServiceAuthInfoFromHeaders(result.authInfoHeader, { env: targetEnv(), replayCache, body: BODY });
    assert.equal(second.ok, false);
    assert.match(second.reason, /already been consumed/);
});

// ---------------------------------------------------------------------------
// 6. No legacy identity headers anywhere on this path. The router-owned header is
//    EXACTLY x-ploinky-auth-info; no x-soul-*, x-agent-name, x-soul-agent.
// ---------------------------------------------------------------------------

test('the minted header set contains only x-ploinky-auth-info and no legacy identity headers', () => {
    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });
    const result = verifyAndMintAgentOpenAiCall({ token: bearer, routeKey: TARGET_ROUTE, route: ROUTE, body: BODY, replayCache: createMemoryReplayCache() });
    assert.equal(result.ok, true, result.error);
    const headerNames = Object.keys(result.authInfoHeader).map((name) => name.toLowerCase());
    assert.deepEqual(headerNames, ['x-ploinky-auth-info']);
    for (const banned of ['x-soul-id', 'x-agent-name', 'x-soul-agent']) {
        assert.equal(banned in result.authInfoHeader, false);
    }
});

// ---------------------------------------------------------------------------
// 7. End-to-end HTTP: handleDelegatedAgentOpenAiCall buffers the body once,
//    forwards the IDENTICAL bytes, strips any client x-ploinky-auth-info, and the
//    upstream agent verifies the router-minted token against the raw bytes.
// ---------------------------------------------------------------------------

test('handleDelegatedAgentOpenAiCall forwards identical bytes the upstream agent verifies', async (t) => {
    const { handleDelegatedAgentOpenAiCall } = await import(`../../cli/server/agentOpenAiDelegation.js?e2e=${Date.now()}-${Math.random()}`);

    let captured = null;
    let upstreamVerified = null;
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks);
            captured = { url: req.url, headers: req.headers, body: rawBody };
            // The upstream agent recomputes the hash over the EXACT bytes it got
            // and verifies the router-minted token (as AgentServer does).
            upstreamVerified = verifyOpenAiServiceAuthInfoFromHeaders(req.headers, {
                env: targetEnv(),
                replayCache: createMemoryReplayCache(),
                body: rawBody,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    const upstreamPort = await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port)));
    t.after(() => new Promise((resolve) => upstream.close(() => resolve())));

    const bearer = signAgentHttpAssertion({ path: OPENAI_PATH, body: BODY, targetAgent: TARGET_ROUTE, tool: OPENAI_TOOL, env: envFor(SOURCE_AGENT) });

    // Drive a real router that calls the handler, so body buffering + proxy run
    // over a real socket.
    const router = http.createServer((req, res) => {
        handleDelegatedAgentOpenAiCall(req, res, { repo: 'AssistOSExplorer', agent: 'llmAssistant', hostPort: upstreamPort }, TARGET_ROUTE, OPENAI_PATH);
    });
    const routerPort = await new Promise((resolve) => router.listen(0, '127.0.0.1', () => resolve(router.address().port)));
    t.after(() => new Promise((resolve) => router.close(() => resolve())));

    const response = await new Promise((resolve, reject) => {
        const reqClient = http.request({
            hostname: '127.0.0.1',
            port: routerPort,
            path: `/${TARGET_ROUTE}${OPENAI_PATH}`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${bearer}`,
                // A spoofed client-supplied router header that MUST be stripped.
                'x-ploinky-auth-info': '{"invocationToken":"spoofed","invocationBody":{}}',
                'content-length': String(BODY.length),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        reqClient.on('error', reject);
        reqClient.end(BODY);
    });

    assert.equal(response.statusCode, 200, response.body);
    // The upstream received the EXACT same bytes the client sent.
    assert.equal(captured.body.toString('utf8'), BODY.toString('utf8'));
    assert.equal(captured.url, OPENAI_PATH);
    // The client-supplied x-ploinky-auth-info was replaced by the router's, and
    // the upstream verification of the router-minted token succeeded.
    assert.notEqual(captured.headers['x-ploinky-auth-info'], '{"invocationToken":"spoofed","invocationBody":{}}');
    assert.equal(upstreamVerified.ok, true, upstreamVerified.reason);
    assert.equal(upstreamVerified.payload.tool, OPENAI_TOOL);
    assert.equal(upstreamVerified.payload.sub, SOURCE_AGENT);
    // No legacy identity headers were forwarded.
    for (const banned of ['x-soul-id', 'x-agent-name', 'x-soul-agent']) {
        assert.equal(captured.headers[banned], undefined);
    }
});
