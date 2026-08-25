import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import {
    computeRchHttp,
    computeRchTool,
    sha256RawBodyHash,
} from '../../Agent/lib/requestHash.mjs';

// Agent-assertion signing derives a per-agent secret from the master key, which
// in turn reads workspace state from cwd; mirror the agentAssertion test harness.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-discovery-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = 'd'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const {
    buildOpenAiAgentDiscovery,
    handleOpenAiAgentDiscoveryRoute,
    OPENAI_AGENT_DISCOVERY_PATH,
    OPENAI_AGENT_DISCOVERY_TOOL,
    OPENAI_AGENT_DISCOVERY_TARGET,
} = await import(`../../cli/server/openAiAgentDiscovery.js${moduleSuffix}`);
const { deriveAgentRequestSecret } = await import(`../../cli/utils/security/masterKey.js${moduleSuffix}`);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

// A fake manifest reader that also records every (routeKey, route) pair it was
// asked about, and proves the builder never inspects `route.manifestPath`.
function makeManifestReader(manifestByRouteKey) {
    const seen = [];
    const reader = (routeKey, routes) => {
        const route = routes?.[routeKey];
        seen.push({ routeKey, route });
        // If the production reader ever started keying off route.manifestPath this
        // mirror would have to as well; we deliberately ignore it.
        return manifestByRouteKey[routeKey] || null;
    };
    reader.seen = seen;
    return reader;
}

const ROUTES = {
    // Enabled, active port, manifest WITHOUT endpoints.chatCompletions.
    llmAssistant: { hostPort: 4101, hostPath: '/ignored', repo: 'AssistOSExplorer', agent: 'llmAssistant' },
    // Enabled, active port, manifest WITH chat config (streaming on).
    soplangAgent: { hostPort: 4102, hostPath: '/ignored', repo: 'AssistOSExplorer', agent: 'soplangAgent' },
    // Disabled — must be excluded even though it has a port + manifest.
    disabledAgent: { hostPort: 4103, disabled: true, repo: 'AssistOSExplorer', agent: 'disabledAgent' },
    // Draining — its identity remains enabled, but discovery must admit no new work.
    drainingAgent: { hostPort: 4105, draining: true, repo: 'AssistOSExplorer', agent: 'drainingAgent' },
    // No host port — must be excluded.
    portlessAgent: { repo: 'AssistOSExplorer', agent: 'portlessAgent' },
    // Active port but manifest cannot be resolved — must be excluded.
    manifestlessAgent: { hostPort: 4104, repo: 'AssistOSExplorer', agent: 'manifestlessAgent' },
};

const MANIFESTS = {
    llmAssistant: { name: 'LLM Assistant', version: '1.2.3' },
    soplangAgent: {
        name: 'Soplang Agent',
        version: '0.9.0',
        endpoints: { chatCompletions: { command: '/chat', supportsStream: true } },
    },
    disabledAgent: { name: 'Disabled Agent', version: '1.0.0' },
    drainingAgent: { name: 'Draining Agent', version: '1.0.0' },
    manifestlessAgent: null,
};

test('builder includes a manifest-less-chat route and marks usesDefaultOpenAiResponder true', () => {
    const reader = makeManifestReader(MANIFESTS);
    const { complete, agents } = buildOpenAiAgentDiscovery({ routes: ROUTES, readManifest: reader });

    assert.equal(complete, true);
    const llm = agents.find((a) => a.routeKey === 'llmAssistant');
    assert.ok(llm, 'llmAssistant should be discovered');
    assert.equal(llm.usesDefaultOpenAiResponder, true);
    assert.equal(llm.supportsStreaming, true);
    assert.equal(llm.responderKind, 'llm');
    assert.equal(llm.subjectId, 'agent:AssistOSExplorer/llmAssistant');
    assert.equal(llm.repo, 'AssistOSExplorer');
    assert.equal(llm.agent, 'llmAssistant');
    assert.equal(llm.name, 'LLM Assistant');
    assert.equal(llm.routerPath, '/llmAssistant');
    assert.equal(llm.chatCompletionsPath, '/v1/chat/completions');
    assert.deepEqual(llm.manifest, { name: 'LLM Assistant', version: '1.2.3' });
});

test('builder marks usesDefaultOpenAiResponder false (and streaming) when manifest chat config exists', () => {
    const reader = makeManifestReader(MANIFESTS);
    const { agents } = buildOpenAiAgentDiscovery({ routes: ROUTES, readManifest: reader });
    const sop = agents.find((a) => a.routeKey === 'soplangAgent');
    assert.ok(sop, 'soplangAgent should be discovered');
    assert.equal(sop.usesDefaultOpenAiResponder, false);
    assert.equal(sop.supportsStreaming, true);
    assert.equal(sop.responderKind, 'command');
});

test('responderKind: command when manifest has a chat command', () => {
    const { agents } = buildOpenAiAgentDiscovery({
        routes: { demo: { hostPort: 5, repo: 'r', agent: 'demo' } },
        readManifest: () => ({ name: 'demo', endpoints: { chatCompletions: { command: '/h' } } }),
    });
    assert.equal(agents[0].responderKind, 'command');
    assert.equal(agents[0].usesDefaultOpenAiResponder, false);
});

test('responderKind: inert when model is none', () => {
    const { agents } = buildOpenAiAgentDiscovery({
        routes: { demo: { hostPort: 5, repo: 'r', agent: 'demo' } },
        readManifest: () => ({ name: 'demo', endpoints: { chatCompletions: { model: 'none' } } }),
    });
    assert.equal(agents[0].responderKind, 'inert');
    assert.equal(agents[0].usesDefaultOpenAiResponder, true);
    assert.equal(agents[0].supportsStreaming, false);
});

test('responderKind: llm + streaming when no chatCompletions block', () => {
    const { agents } = buildOpenAiAgentDiscovery({
        routes: { demo: { hostPort: 5, repo: 'r', agent: 'demo' } },
        readManifest: () => ({ name: 'demo' }),
    });
    assert.equal(agents[0].responderKind, 'llm');
    assert.equal(agents[0].usesDefaultOpenAiResponder, true);
    assert.equal(agents[0].supportsStreaming, true);
});

test('builder omits disabled, draining, portless, and manifest-less routes', () => {
    const reader = makeManifestReader(MANIFESTS);
    const { agents } = buildOpenAiAgentDiscovery({ routes: ROUTES, readManifest: reader });
    const keys = agents.map((a) => a.routeKey).sort();
    assert.deepEqual(keys, ['llmAssistant', 'soplangAgent']);
    assert.equal(agents.some((a) => a.routeKey === 'disabledAgent'), false);
    assert.equal(agents.some((a) => a.routeKey === 'drainingAgent'), false);
    assert.equal(agents.some((a) => a.routeKey === 'portlessAgent'), false);
    assert.equal(agents.some((a) => a.routeKey === 'manifestlessAgent'), false);
});

test('builder never reads route.manifestPath (resolution goes through the injected reader)', () => {
    // Give every route a bogus manifestPath; the reader must be the only source.
    const routesWithManifestPath = Object.fromEntries(
        Object.entries(ROUTES).map(([k, v]) => [k, { ...v, manifestPath: `/bogus/${k}/manifest.json` }]),
    );
    const reader = makeManifestReader(MANIFESTS);
    const { agents } = buildOpenAiAgentDiscovery({ routes: routesWithManifestPath, readManifest: reader });
    // Builder still resolves exactly the two valid agents and the reader saw the
    // route objects (proving the route, not a manifestPath, drives resolution).
    assert.deepEqual(agents.map((a) => a.routeKey).sort(), ['llmAssistant', 'soplangAgent']);
    assert.ok(reader.seen.some((s) => s.routeKey === 'llmAssistant'));
    // Serialized discovery output carries no manifestPath leakage.
    assert.equal(JSON.stringify(agents).includes('manifestPath'), false);
    assert.equal(JSON.stringify(agents).includes('/bogus/'), false);
});

test('builder output contains no 127.0.0.1 or router-port base URLs', () => {
    const reader = makeManifestReader(MANIFESTS);
    const result = buildOpenAiAgentDiscovery({ routes: ROUTES, readManifest: reader });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('127.0.0.1'), false);
    assert.equal(serialized.includes('localhost'), false);
    // The container-internal host ports must never leak into the response.
    assert.equal(serialized.includes('4101'), false);
    assert.equal(serialized.includes('4102'), false);
    // Only relative path fields are emitted.
    for (const agent of result.agents) {
        assert.match(agent.routerPath, /^\/[^/]/);
        assert.equal(agent.chatCompletionsPath, '/v1/chat/completions');
        assert.equal(Object.prototype.hasOwnProperty.call(agent, 'baseUrl'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(agent, 'url'), false);
    }
});

// ---------------------------------------------------------------------------
// HTTP route handler: agent-assertion authentication
// ---------------------------------------------------------------------------

const AGENT_A = 'agent:AssistOSExplorer/llmAssistant';

// Minimal mock response capturing status + JSON body.
function mockResponse() {
    const res = {
        statusCode: null,
        headers: null,
        bodyChunks: [],
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
        end(chunk) { if (chunk) this.bodyChunks.push(chunk); },
    };
    res.json = () => JSON.parse(Buffer.concat(res.bodyChunks.map((c) => Buffer.from(c))).toString('utf8'));
    return res;
}

const PARSED = { pathname: OPENAI_AGENT_DISCOVERY_PATH };
const HTTP_RCH = computeRchHttp({
    method: 'GET',
    path: OPENAI_AGENT_DISCOVERY_PATH,
    query: '',
    bodyHash: sha256RawBodyHash(''),
});

// Sign a discovery Agent Assertion with a caller-chosen rch. We hand-craft via
// signHmacJwt (rather than signAgentAssertion, which always computes a TOOL rch)
// so a test can deliberately bind an HTTP rch or a mismatched TOOL rch.
function signDiscoveryAssertion({
    iss = AGENT_A,
    rch = HTTP_RCH,
    tool = OPENAI_AGENT_DISCOVERY_TOOL,
    target = OPENAI_AGENT_DISCOVERY_TARGET,
    jti = `jti-${Math.random().toString(36).slice(2)}`,
    secretAgent = iss,
    iatOffset = 0,
} = {}) {
    const now = Math.floor(Date.now() / 1000) + iatOffset;
    const payload = {
        typ: 'agent-assertion',
        iss,
        sub: iss,
        aud: 'ploinky-router',
        targetAgent: target,
        method: 'GET',
        path: OPENAI_AGENT_DISCOVERY_PATH,
        tool,
        rch,
        iat: now,
        exp: now + 60,
        jti,
    };
    return signHmacJwt({ payload, secret: deriveAgentRequestSecret(secretAgent, { encoding: 'buffer' }) });
}

function callHandler(token, { replayCache, routing } = {}) {
    const req = { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = mockResponse();
    const handled = handleOpenAiAgentDiscoveryRoute(req, res, PARSED, {
        routing: routing || { routes: {} },
        replayCache: replayCache || createMemoryReplayCache(),
    });
    return { handled, res };
}

test('a valid HTTP Agent Assertion is accepted and returns the discovery inventory', () => {
    const token = signDiscoveryAssertion();
    const { handled, res } = callHandler(token, { routing: { routes: {} } });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.complete, true);
    assert.ok(Array.isArray(body.agents));
});

test('a missing assertion is rejected (401)', () => {
    const { handled, res } = callHandler(null);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().complete, false);
});

test('an assertion whose rch was computed with computeRchTool is rejected (proves computeRchHttp binding)', () => {
    const toolRch = computeRchTool({
        method: 'GET',
        path: OPENAI_AGENT_DISCOVERY_PATH,
        tool: OPENAI_AGENT_DISCOVERY_TOOL,
        arguments: {},
    });
    // Sanity: the two hash schemes differ for the same surface.
    assert.notEqual(toolRch, HTTP_RCH);
    const token = signDiscoveryAssertion({ rch: toolRch });
    const { res } = callHandler(token);
    assert.equal(res.statusCode, 401);
});

test('a tampered assertion (signed with the wrong agent secret) is rejected', () => {
    // iss claims AGENT_A but the token is signed with a different agent's secret.
    const token = signDiscoveryAssertion({ iss: AGENT_A, secretAgent: 'agent:AssistOSExplorer/dpuAgent' });
    const { res } = callHandler(token);
    assert.equal(res.statusCode, 401);
});

test('a wrong-target assertion is rejected', () => {
    const token = signDiscoveryAssertion({ target: 'some-other-agent' });
    const { res } = callHandler(token);
    assert.equal(res.statusCode, 401);
});

test('a replayed assertion jti is rejected on the second call (shared replay cache)', () => {
    const replayCache = createMemoryReplayCache();
    const token = signDiscoveryAssertion({ jti: 'discovery-replay-1' });
    const first = callHandler(token, { replayCache });
    assert.equal(first.res.statusCode, 200);
    const second = callHandler(token, { replayCache });
    assert.equal(second.res.statusCode, 401);
});

test('a non-GET method is rejected with 405', () => {
    const req = { method: 'POST', headers: {} };
    const res = mockResponse();
    const handled = handleOpenAiAgentDiscoveryRoute(req, res, PARSED, { routing: { routes: {} } });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
});

test('the handler declines paths it does not own', () => {
    const req = { method: 'GET', headers: {} };
    const res = mockResponse();
    const handled = handleOpenAiAgentDiscoveryRoute(req, res, { pathname: '/api/router/something-else' }, { routing: { routes: {} } });
    assert.equal(handled, false);
    assert.equal(res.statusCode, null);
});
