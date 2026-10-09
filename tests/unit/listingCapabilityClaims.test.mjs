import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { verifyHttpRouteAuthInfoFromHeaders, verifyRouterRequestFromHeaders } from '../../Agent/lib/invocationAuth.mjs';
import { authInfoFromInvocation } from '../../Agent/lib/invocation-auth.mjs';
import { computeRchTool, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { RouterRequestTokenService, normalizeActor } from '../../cli/server/security/tokens/RouterRequestTokenService.js';

// The contract limit is stated here, not imported, so this file loads against
// any revision and fails on behaviour where the claim is missing.
const MAX_ACTOR_CAPABILITIES = 64;

// The signed listing capability claim is exercised through both real minting
// paths (HTTP route auth-info and MCP provider call) and the real receivers
// (HTTP route verifier, the AgentServer router-request verifier and the
// authInfoFromInvocation normalizer). No capability may come from a plain
// header, a guest, a delegated call or a malformed session value.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-listing-claims-'));
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(['PLOINKY_MASTER_KEY', 'PLOINKY_WORKSPACE_ROOT', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_SECURE_WIRE']
    .map((key) => [key, process.env[key]]));
const ploinkyDir = path.join(tempDir, '.ploinky');
const agentDir = path.join(ploinkyDir, 'repos', 'fixtures', 'listing');
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({ about: 'listing claim fixture' }));
fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({ routes: {
    listing: { repo: 'fixtures', agent: 'listing', container: 'listing-container', hostPath: agentDir, hostPort: 7411 },
} }));
fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({ 'listing-container': {
    type: 'agent', repoName: 'fixtures', agentName: 'listing', instanceId: 'listing-instance',
    enableGeneration: 'listing-enable-generation', auth: { mode: 'none' },
} }));
fs.mkdirSync(path.join(ploinkyDir, 'data', 'edge-routing'), { recursive: true });
fs.mkdirSync(path.join(ploinkyDir, 'data', 'router-security'), { recursive: true });
fs.writeFileSync(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), JSON.stringify({ hosts: {} }));
fs.writeFileSync(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), JSON.stringify({
    schema: 'router-policy', httpRoutes: [], mcpTools: [],
}));
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
process.env.PLOINKY_WORKSPACE_ROOT = tempDir;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
delete process.env.PLOINKY_SECURE_WIRE;

const moduleSuffix = `?listing=${Date.now()}`;
const { applyEdgeRoutingGeneration } = await import(`../../cli/sandbox/edgeGeneration.js${moduleSuffix}`);
applyEdgeRoutingGeneration({ workspaceRoot: tempDir, reason: 'listing-claims-test-fixture' });
const { buildHttpRouteAuthInfoHeader } = await import(`../../cli/server/routerHandlers.js${moduleSuffix}`);
const { buildInvocationContextForProviderCall } = await import(`../../cli/server/mcp-proxy/index.js${moduleSuffix}`);
const { deriveAgentRequestSecret } = await import(`../../cli/utils/security/masterKey.js${moduleSuffix}`);

const TARGET = 'agent:fixtures/listing';
const ENV = { PLOINKY_AGENT_ID: TARGET, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(TARGET) };
const DEFINITION = { includeAuthInfo: true, issueInvocation: true, routeKey: 'listing', route: { repo: 'fixtures', agent: 'listing' } };
const ROUTE_PATH = '/api/robots';
const EXTERNAL = `/base-agent-additional-server/listing/3001${ROUTE_PATH}`;

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function sessionUser(overrides = {}) {
    return { id: 'member-1', username: 'member', email: 'member@example.test', roles: ['user'], capabilities: ['explorer.access'], ...overrides };
}

function httpHeaders(user, { search = '', method = 'GET', bodyHash = sha256RawBodyHash('') } = {}) {
    const req = { method, url: `${EXTERNAL}${search}`, headers: {}, user };
    const parsedUrl = new URL(`http://127.0.0.1:8080${EXTERNAL}${search}`);
    return buildHttpRouteAuthInfoHeader(req, parsedUrl, DEFINITION, { bodyHash, routePath: ROUTE_PATH });
}

function verifyHttp(headers, overrides = {}) {
    return verifyHttpRouteAuthInfoFromHeaders(headers, {
        env: ENV, replayCache: createMemoryReplayCache(), method: 'GET', path: ROUTE_PATH, query: '', body: Buffer.alloc(0), ...overrides,
    });
}

function mcpContext(req, { toolName = 'robot_list', toolArgs = {} } = {}) {
    return buildInvocationContextForProviderCall({ req, agentName: 'listing', toolName, toolArgs });
}

// Mirrors AgentServer.verifyInvocationForRequest: the rch is recomputed from the
// actual MCP surface and the router-request verifier checks it.
function verifyMcp(token, { tool = 'robot_list', args = {}, replayCache = createMemoryReplayCache(), env = ENV } = {}) {
    return verifyRouterRequestFromHeaders({ authorization: `Bearer ${token}` }, {
        env, replayCache, method: 'POST', path: '/mcp', tool, rch: computeRchTool({ method: 'POST', path: '/mcp', tool, arguments: args }),
    });
}

test('HTTP route minting signs the session capabilities for a direct user and the real verifier exposes them', () => {
    const headers = httpHeaders(sessionUser({ capabilities: ['explorer.access', 'explorer.access', 'books:read'] }));
    const verified = verifyHttp(headers);
    assert.equal(verified.ok, true, verified.reason);
    assert.equal(verified.payload.sub, 'user:member-1');
    assert.deepEqual(verified.payload.actor, {
        kind: 'user', id: 'user:member-1', roles: ['user'], capabilities: ['explorer.access', 'books:read'],
    });
    // The unsigned compatibility body never carries capabilities.
    const plain = JSON.parse(headers['x-ploinky-auth-info']);
    assert.equal('capabilities' in plain.user, false);
});

test('MCP minting signs the capabilities and they survive the AgentServer verifier and normalizer', () => {
    const ctx = mcpContext({ user: sessionUser() });
    assert.deepEqual(ctx.payload.actor.capabilities, ['explorer.access']);
    const verified = verifyMcp(ctx.token);
    assert.equal(verified.ok, true, verified.reason);
    const authInfo = authInfoFromInvocation(verified.payload, { invocationToken: verified.rawToken });
    assert.deepEqual(authInfo.invocation.actor, { kind: 'user', id: 'user:member-1', roles: ['user'], capabilities: ['explorer.access'] });
    assert.equal(authInfo.principalId, 'user:member-1');
    assert.equal(authInfo.invocation.subject, 'user:member-1');
    assert.equal(authInfo.invocation.delegation, null);
    assert.equal('capabilities' in authInfo.user, false, 'capabilities stay on the signed actor only');
});

test('guest roles in any spelling, guest kinds and admin+guest never receive a claim on either path', () => {
    for (const roles of [['guest'], [' GUEST '], ['admin', 'guest'], ['admin', ' Guest']]) {
        const user = sessionUser({ roles, capabilities: ['explorer.access'] });
        const http = verifyHttp(httpHeaders(user));
        assert.equal(http.ok, true, http.reason);
        assert.equal(http.payload.actor.kind, 'guest', `HTTP kind for ${JSON.stringify(roles)}`);
        assert.equal('capabilities' in http.payload.actor, false, `HTTP claim for ${JSON.stringify(roles)}`);
        const mcp = mcpContext({ user });
        assert.equal(mcp.payload.actor.kind, 'guest', `MCP kind for ${JSON.stringify(roles)}`);
        assert.equal('capabilities' in mcp.payload.actor, false, `MCP claim for ${JSON.stringify(roles)}`);
    }
    assert.equal('capabilities' in normalizeActor({ kind: 'guest', id: 'guest:x', roles: [], capabilities: ['explorer.access'] }), false);
    assert.equal('capabilities' in normalizeActor({ kind: 'agent', id: 'agent:a/b', roles: [], capabilities: ['explorer.access'] }), false);
});

test('a delegated agent call never signs the delegated user capabilities', () => {
    const ctx = mcpContext({
        user: sessionUser({ roles: ['admin'] }),
        delegatedAgentVerified: {
            callerPrincipal: 'agent:fixtures/source',
            userDelegation: {
                user: { id: 'member-1', username: 'member', roles: ['admin'], capabilities: ['explorer.access'] },
                delegation: { jti: 'grant-1', scope: ['robots:list'], sourceAgentId: 'agent:fixtures/source', targetAgentId: TARGET },
            },
        },
    });
    assert.equal(ctx.payload.actor.kind, 'agent');
    assert.equal('capabilities' in ctx.payload.actor, false);
    assert.equal('capabilities' in ctx.payload.usr, false);
    const authInfo = authInfoFromInvocation(verifyMcp(ctx.token).payload);
    assert.deepEqual(authInfo.invocation.actor.capabilities, []);
    assert.notEqual(authInfo.invocation.delegation, null);
});

test('malformed, non-array and oversized capability inputs omit the claim or keep only exact valid strings', () => {
    const cases = [
        [undefined, undefined],
        ['explorer.access', undefined],
        [{ 0: 'explorer.access', length: 1 }, undefined],
        [[], undefined],
        [[' explorer.access', 'explorer.access ', 'EXPLORER ACCESS', 1, null, {}, ['explorer.access'], 'a'.repeat(129)], undefined],
        [[' explorer.access', 'explorer.access', 42, 'b'.repeat(128)], ['explorer.access', 'b'.repeat(128)]],
        [Array.from({ length: MAX_ACTOR_CAPABILITIES }, (_, i) => `cap.${i}`), Array.from({ length: MAX_ACTOR_CAPABILITIES }, (_, i) => `cap.${i}`)],
        [Array.from({ length: MAX_ACTOR_CAPABILITIES + 1 }, (_, i) => `cap.${i}`), undefined],
        // The limit applies after filtering and de-duplication.
        [[...Array.from({ length: MAX_ACTOR_CAPABILITIES }, (_, i) => `cap.${i}`), 'cap.0', ' bad'], Array.from({ length: MAX_ACTOR_CAPABILITIES }, (_, i) => `cap.${i}`)],
    ];
    for (const [input, expected] of cases) {
        const actor = normalizeActor({ kind: 'user', id: 'user:member-1', roles: ['user'], capabilities: input });
        assert.deepEqual(actor.capabilities, expected, `input ${JSON.stringify(input)?.slice(0, 80)}`);
        assert.equal('capabilities' in actor, expected !== undefined);
        const http = verifyHttp(httpHeaders(sessionUser({ capabilities: input })));
        assert.equal(http.ok, true, http.reason);
        assert.deepEqual(http.payload.actor.capabilities, expected);
        assert.deepEqual(mcpContext({ user: sessionUser({ capabilities: input }) }).payload.actor.capabilities, expected);
    }
});

test('existing payloads without capabilities stay byte-compatible', async () => {
    const signed = [];
    const service = new RouterRequestTokenService({
        jwsCodec: { signHmacJwt: async (input) => { signed.push(input); return 'rr.jwt'; } },
        resolveAgentSecret: async () => 'secret',
        now: () => new Date('2026-10-09T00:00:00.000Z'),
        randomId: () => 'nonce',
    });
    await service.mint({ targetAgentId: TARGET, sub: 'user:x', actor: { kind: 'user', id: 'user:x', roles: ['user'] }, method: 'GET', path: '/x', rch: 'r' });
    assert.equal(JSON.stringify(signed[0].payload.actor), '{"kind":"user","id":"user:x","roles":["user"]}');
});

test('adversarial: wrong signature, audience, method, path, query, body, tool and replay are rejected', () => {
    const user = sessionUser();
    const headers = httpHeaders(user, { search: '?view=1' });
    const good = { query: '?view=1' };
    assert.equal(verifyHttp(headers, good).ok, true);
    const authInfo = JSON.parse(headers['x-ploinky-auth-info']);
    const [h, p, s] = authInfo.invocationToken.split('.');
    const tamper = (token) => ({ 'x-ploinky-auth-info': JSON.stringify({ ...authInfo, invocationToken: token }) });
    // Forge a broader claim by editing the payload; the HMAC no longer matches.
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), actor: { kind: 'user', id: 'user:member-1', roles: ['admin'], capabilities: ['explorer.access'] } })).toString('base64url');
    const rejected = [
        ['signature', verifyHttp(tamper(`${h}.${p}.${s.slice(0, -2)}AA`), good)],
        ['forged payload', verifyHttp(tamper(`${h}.${forgedPayload}.${s}`), good)],
        ['audience', verifyHttp(headers, { ...good, env: { PLOINKY_AGENT_ID: 'agent:fixtures/other', PLOINKY_AGENT_SECRET: deriveAgentRequestSecret('agent:fixtures/other') } })],
        ['wrong secret', verifyHttp(headers, { ...good, env: { ...ENV, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret('agent:fixtures/other') } })],
        ['method', verifyHttp(headers, { ...good, method: 'POST' })],
        ['path', verifyHttp(headers, { ...good, path: '/api/robots/x' })],
        ['query', verifyHttp(headers, { query: '?view=2' })],
        ['body', verifyHttp(headers, { ...good, body: Buffer.from('x') })],
    ];
    for (const [name, result] of rejected) assert.equal(result.ok, false, name);
    const cache = createMemoryReplayCache();
    assert.equal(verifyHttp(headers, { ...good, replayCache: cache }).ok, true);
    assert.equal(verifyHttp(headers, { ...good, replayCache: cache }).ok, false, 'replay');

    const ctx = mcpContext({ user }, { toolName: 'robot_list', toolArgs: {} });
    assert.equal(verifyMcp(ctx.token, { tool: 'robot_delete' }).ok, false, 'tool');
    assert.equal(verifyMcp(ctx.token, { args: { robotName: 'x' } }).ok, false, 'arguments');
    const mcpCache = createMemoryReplayCache();
    assert.equal(verifyMcp(ctx.token, { replayCache: mcpCache }).ok, true);
    assert.equal(verifyMcp(ctx.token, { replayCache: mcpCache }).ok, false, 'MCP replay');
});

test('worst-case claim size through both minting paths is measured, not truncated', () => {
    const capabilities = Array.from({ length: MAX_ACTOR_CAPABILITIES }, (_, i) => `${String(i).padStart(2, '0')}${'c'.repeat(126)}`);
    const user = sessionUser({ id: 'u'.repeat(64), username: 'n'.repeat(64), email: `${'e'.repeat(50)}@example.test`, roles: ['user', 'admin'], capabilities });
    const header = httpHeaders(user)['x-ploinky-auth-info'];
    const verified = verifyHttp({ 'x-ploinky-auth-info': header });
    assert.equal(verified.ok, true, verified.reason);
    assert.equal(verified.payload.actor.capabilities.length, MAX_ACTOR_CAPABILITIES);
    const mcpToken = mcpContext({ user }).token;
    // Node's default maximum HTTP header size is 16 KiB for all headers.
    process.stdout.write(`# worst-case x-ploinky-auth-info bytes=${Buffer.byteLength(header)} mcp-bearer bytes=${Buffer.byteLength(`Bearer ${mcpToken}`)}\n`);
    assert.ok(Buffer.byteLength(header) < 16 * 1024);
    assert.ok(Buffer.byteLength(`Bearer ${mcpToken}`) < 16 * 1024);
});
