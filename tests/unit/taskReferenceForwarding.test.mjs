import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

// The Router policy store is resolved from the workspace root at import time:
// pin it to a private directory before the Router modules load.
const importRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taskref-forwarding-')));
const saved = { root: process.env.PLOINKY_WORKSPACE_ROOT, key: process.env.PLOINKY_MASTER_KEY };
process.env.PLOINKY_WORKSPACE_ROOT = importRoot;
process.env.PLOINKY_MASTER_KEY = '3'.repeat(64);
fs.mkdirSync(path.join(importRoot, '.ploinky', 'data', 'router-security'), { recursive: true });
fs.writeFileSync(path.join(importRoot, '.ploinky', 'data', 'router-security', 'policy-state.json'), JSON.stringify({
    schema: 'router-policy',
    httpRoutes: [],
    mcpTools: [{ agent: 'unrelated', tool: 'start_job', access: 'authenticated', enabled: true }],
}));

const { signAgentAssertion } = await import('../../Agent/lib/agentAssertion.mjs');
const { createMemoryReplayCache } = await import('../../Agent/lib/jwtVerify.mjs');
const { verifyRouterRequestToken } = await import('../../Agent/lib/requestSignedTokens.mjs');
const { handleAgentMcpRequest } = await import('../../cli/server/mcp-proxy/index.js');
const { handleRouterMcp } = await import('../../cli/server/routerHandlers.js');
const { mintUserDelegationGrant } = await import('../../cli/server/mcp-proxy/userDelegationGrant.js');
const { taskReferenceOriginBinding } = await import('../../cli/server/executionProvider/originToken.mjs');
const { deriveAgentRequestSecret, deriveSubkey } = await import('../../cli/utils/security/masterKey.js');
const { domainFixture } = await import('./directDomainFixtures.mjs');
const { startAgentServer } = await import('./helpers/agentServerProcess.mjs');
const { taskReferenceTool } = await import('./helpers/taskReferenceToolScript.mjs');

test.after(() => {
    fs.rmSync(importRoot, { recursive: true, force: true });
    for (const [name, value] of [['PLOINKY_WORKSPACE_ROOT', saved.root], ['PLOINKY_MASTER_KEY', saved.key]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

// Fictional agents: `unrelated` serves the task-reference tool `start_job`
// for the declared provider `explorer`; `mailer` is a delegated agent caller.
const TOOL_AGENT = 'agent:fixtures/unrelated';
const PROVIDER = 'agent:fixtures/explorer';
const ORIGIN = 'AAAAAAAAAAAAAAAAAAAAAA';
const USER_A = { id: 'user-a', username: 'alice', roles: ['user'] };
const USER_B = { id: 'user-b', username: 'bob', roles: ['user'] };

async function world(t) {
    const agent = await startAgentServer(t, {
        agentId: TOOL_AGENT,
        secret: deriveAgentRequestSecret(TOOL_AGENT, { encoding: 'buffer' }),
        tools: (dir) => [taskReferenceTool(dir)],
    });
    const fixture = domainFixture(t, { mode: 'dual' });
    const file = path.join(fixture.root, 'fixtures', 'explorer', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.executionProvider = { version: 1, port: 7300, taskReferences: { path: '/explorer/task-refs' } };
    fs.writeFileSync(file, JSON.stringify(manifest));
    fixture.routing.routes.unrelated.hostPort = agent.port;
    fixture.write(fixture.paths.routingFile, fixture.routing);
    fixture.apply();
    const snapshot = fixture.active().generation;
    const routePlan = { lease: { snapshot, commit: () => true } };
    return { agent, fixture, snapshot, routePlan, route: snapshot.routing.routes.unrelated };
}

function capture() {
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    return Object.assign(new EventEmitter(), {
        statusCode: 0, headers: {}, body: '', headersSent: false, completed,
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        getHeader(name) { return this.headers[String(name).toLowerCase()]; },
        writeHead(status, headers = {}) {
            this.statusCode = status;
            for (const [key, value] of Object.entries(headers || {})) this.headers[key.toLowerCase()] = value;
            this.headersSent = true;
            return this;
        },
        write(chunk) { this.body += String(chunk); return true; },
        end(chunk = '') { this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''); done(); },
    });
}

function request({ url, body, user, sessionId, headers = {} }) {
    const req = new PassThrough();
    req.method = 'POST';
    req.url = url;
    req.headers = { host: '127.0.0.1:8080', 'content-type': 'application/json', ...headers };
    req.rawHeaders = Object.entries(req.headers).flat();
    if (user) {
        req.user = user;
        req.authMode = 'sso';
        req.sessionId = sessionId;
        req.authChannel = 'browser';
    }
    req.end(JSON.stringify(body));
    return req;
}

async function agentMcp(w, options) {
    const res = capture();
    const req = request({ url: '/unrelated/mcp', ...options });
    await handleAgentMcpRequest(req, res, w.route, 'unrelated', { routePlan: w.routePlan, waitForAgentReady: async () => true });
    await res.completed;
    return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function browserSession(w, user, sessionId) {
    const init = await agentMcp(w, {
        user, sessionId,
        body: { jsonrpc: '2.0', id: 'i', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    });
    const id = init.res.headers['mcp-session-id'];
    assert.ok(id, init.res.body);
    return id;
}

const browserCall = (w, user, sessionId, mcpSessionId, args, headers = {}) => agentMcp(w, {
    user, sessionId, headers: { 'mcp-session-id': mcpSessionId, ...headers },
    body: { jsonrpc: '2.0', id: args.label, method: 'tools/call', params: { name: 'start_job', arguments: args } },
});

function delivered(w, label) {
    const file = path.join(w.agent.tmp, `seen-${label}.json`);
    assert.ok(fs.existsSync(file), `the tool ran for ${label}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function verifyOrigin(token, expected) {
    const payload = verifyRouterRequestToken(token, {
        secret: deriveAgentRequestSecret(PROVIDER, { encoding: 'buffer' }),
        expectedAudience: PROVIDER,
        method: 'ORIGIN',
        path: '/origin',
        tool: '__task_ref_origin__',
        rch: taskReferenceOriginBinding(expected).rch,
        replayCache: createMemoryReplayCache(),
    }).payload;
    assert.deepEqual(payload.origin, expected);
    assert.equal(payload.exp - payload.iat, 30);
    return payload;
}

test('per-agent MCP path: a browser call without any preceding tools/list delivers a verifiable origin token; forged inbound auth-info never reaches the tool', async (t) => {
    const w = await world(t);
    const mcpSessionId = await browserSession(w, USER_A, 'sid-a');
    const call = await browserCall(w, USER_A, 'sid-a', mcpSessionId, { originRequestId: ORIGIN, label: 'first' },
        { 'x-ploinky-auth-info': JSON.stringify({ taskRefOrigin: 'forged-origin-sentinel' }) });
    assert.equal(call.json.result.metadata.taskRef.provider, 'explorer', call.res.body);
    const seen = delivered(w, 'first');
    assert.notEqual(seen.taskRefOrigin, 'forged-origin-sentinel');
    assert.equal(seen.authInfoHeader.includes('forged-origin-sentinel'), false);
    verifyOrigin(seen.taskRefOrigin, { originKey: 'user:user-a', originRequestId: ORIGIN, agent: TOOL_AGENT, tool: 'start_job' });
});

test('per-agent MCP path: interleaved callers with the same origin id get their own direct-caller keys', async (t) => {
    const w = await world(t);
    const [sa, sb] = await Promise.all([browserSession(w, USER_A, 'sid-a'), browserSession(w, USER_B, 'sid-b')]);
    const calls = await Promise.all([
        browserCall(w, USER_A, 'sid-a', sa, { originRequestId: ORIGIN, label: 'a1' }),
        browserCall(w, USER_B, 'sid-b', sb, { originRequestId: ORIGIN, label: 'b1' }),
        browserCall(w, USER_A, 'sid-a', sa, { originRequestId: ORIGIN, label: 'a2' }),
        browserCall(w, USER_B, 'sid-b', sb, { originRequestId: ORIGIN, label: 'b2' }),
    ]);
    for (const call of calls) assert.ok(call.json.result?.metadata?.taskRef, call.res.body);
    for (const [label, key] of [['a1', 'user:user-a'], ['a2', 'user:user-a'], ['b1', 'user:user-b'], ['b2', 'user:user-b']]) {
        verifyOrigin(delivered(w, label).taskRefOrigin, { originKey: key, originRequestId: ORIGIN, agent: TOOL_AGENT, tool: 'start_job' });
    }
});

test('per-agent MCP path: a delegated agent caller is keyed by its own principal, not by the delegated user', async (t) => {
    const w = await world(t);
    const caller = 'agent:fixtures/mailer';
    const args = { originRequestId: ORIGIN, label: 'delegated' };
    const assertion = signAgentAssertion({
        method: 'POST', path: '/mcp', targetAgent: 'unrelated', tool: 'start_job', argumentsObj: args,
        env: { PLOINKY_AGENT_ID: caller, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(caller) },
    });
    const grant = mintUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32), ttlSeconds: 60, sourceAgentId: caller,
        user: USER_A, targetAgentId: TOOL_AGENT, tools: ['start_job'], scopes: ['jobs:start'],
    }).token;
    const call = await agentMcp(w, {
        headers: { authorization: `Bearer ${assertion}`, 'x-ploinky-user-delegation': grant },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_job', arguments: args } },
    });
    assert.ok(call.json.result?.metadata?.taskRef, call.res.body);
    verifyOrigin(delivered(w, 'delegated').taskRefOrigin, { originKey: caller, originRequestId: ORIGIN, agent: TOOL_AGENT, tool: 'start_job' });
});

test('aggregated Router MCP path: the tool call delivers a verifiable origin token for the session user', async (t) => {
    const w = await world(t);
    for (const [user, label] of [[USER_A, 'agg-a'], [USER_B, 'agg-b']]) {
        const res = capture();
        const req = request({
            url: '/mcp', user, sessionId: `sid-${label}`,
            headers: { 'x-ploinky-auth-info': JSON.stringify({ taskRefOrigin: 'forged-origin-sentinel' }) },
            body: { command: 'tool', agent: 'unrelated', tool: 'start_job', arguments: { originRequestId: ORIGIN, label } },
        });
        await handleRouterMcp(req, res, w.routePlan);
        await res.completed;
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(JSON.parse(res.body).result.metadata.taskRef.provider, 'explorer', res.body);
        const seen = delivered(w, label);
        assert.notEqual(seen.taskRefOrigin, 'forged-origin-sentinel');
        verifyOrigin(seen.taskRefOrigin, { originKey: `user:${user.id}`, originRequestId: ORIGIN, agent: TOOL_AGENT, tool: 'start_job' });
    }
});

test('no origin token is minted when the listed provider is not an enabled declared provider', async (t) => {
    const w = await world(t);
    // Withdraw the declaration: the tool still runs, but receives no token.
    const file = path.join(w.fixture.root, 'fixtures', 'explorer', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete manifest.executionProvider;
    fs.writeFileSync(file, JSON.stringify(manifest));
    w.fixture.apply();
    const snapshot = w.fixture.active().generation;
    const res = capture();
    const req = request({
        url: '/mcp', user: USER_A, sessionId: 'sid-u',
        body: { command: 'tool', agent: 'unrelated', tool: 'start_job', arguments: { originRequestId: ORIGIN, label: 'undeclared' } },
    });
    await handleRouterMcp(req, res, { lease: { snapshot, commit: () => true } });
    await res.completed;
    assert.equal(delivered(w, 'undeclared').taskRefOrigin, '');
});
