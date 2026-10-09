import '../helpers/isolatedWorkspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleRouterMcp } from '../../cli/server/routerHandlers.js';
import { handleAgentMcpRequest, agentSessionStore } from '../../cli/server/mcp-proxy/index.js';
import { admitPublicMcpTarget } from '../../cli/server/mcp-proxy/sessionOwnership.mjs';

function identity(id = 'alice', sid = 'login-a', mode = 'sso') {
    return { user: { id, roles: ['user'] }, authMode: mode, sessionId: sid,
        session: { _jwtPayload: { sid } } };
}

async function request(surface, { actor = identity(), session, method = 'POST', rpc = 'initialize', payload,
    rawHeaders, publicTarget, target = 'echo', ready = async () => true, authorization } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(payload ?? { jsonrpc: '2.0', id: 1, method: rpc }))]);
    Object.assign(req, actor, { method, url: surface === 'router' ? '/mcp' : '/echo/mcp',
        headers: { host: 'localhost', ...(session === undefined ? {} : { 'mcp-session-id': session }) }, rawHeaders });
    if (authorization) req.headers.authorization = authorization;
    if (publicTarget) admitPublicMcpTarget(req, publicTarget);
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const res = { status: 0, headers: {}, body: '',
        writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
        end(body = '') { this.body = String(body); finish(); } };
    if (surface === 'router') await handleRouterMcp(req, res, { routes: {} });
    else await handleAgentMcpRequest(req, res, { hostPort: 1 }, target, { waitForAgentReady: ready });
    await done;
    return { ...res, json: res.body ? JSON.parse(res.body) : null };
}

for (const surface of ['router', 'agent']) {
    test(`${surface}: foreign DELETE preserves the owner session`, async () => {
        const opened = await request(surface);
        const session = opened.headers['mcp-session-id'];
        assert.ok(session);
        const refused = await request(surface, { actor: identity('bob', 'login-b'), session, method: 'DELETE' });
        assert.equal(refused.status, 403);
        assert.equal(refused.json.code, 'MCP_SESSION_FORBIDDEN');
        assert.equal((await request(surface, { session, rpc: 'unknown' })).json.error.code, -32601);
    });
    test(`${surface}: another principal cannot use or delete an owned browser session`, async () => {
        const opened = await request(surface);
        assert.equal(opened.status, 200);
        const session = opened.headers['mcp-session-id'];
        assert.ok(session);
        const owner = await request(surface, { session, rpc: 'unknown' });
        assert.equal(owner.json.error.code, -32601);
        const other = identity('bob', 'login-b');
        const denied = await request(surface, { actor: other, session, rpc: 'unknown' });
        assert.equal(denied.json.error.message, 'Missing or invalid MCP session');
        assert.equal(denied.headers['mcp-session-id'], undefined);
        assert.equal((await request(surface, { actor: other, session, method: 'DELETE' })).status, 403);
        assert.equal((await request(surface, { session, rpc: 'unknown' })).json.error.code, -32601);
        assert.equal((await request(surface, { session, method: 'DELETE' })).status, 204);
        assert.equal((await request(surface, { session, rpc: 'unknown' })).json.error.code, -32000);
    });
    test(`${surface}: every RPC branch rejects foreign ownership before dispatch or acknowledgement`, async () => {
        const session = (await request(surface)).headers['mcp-session-id'];
        let dispatches = 0;
        for (const rpc of ['initialize', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'ping', 'unknown']) {
            const result = await request(surface, { actor: identity('bob', 'login-b'), session, rpc,
                ready: async () => { dispatches += 1; return true; } });
            assert.equal(result.status, 200);
            assert.equal(result.json.error.message, 'Missing or invalid MCP session');
            assert.equal(result.headers['mcp-session-id'], undefined);
        }
        const notification = await request(surface, { actor: identity('bob', 'login-b'), session,
            payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
        assert.equal(notification.status, 403);
        assert.equal(notification.headers['mcp-session-id'], undefined);
        assert.equal(dispatches, 0);
        assert.equal((await request(surface, { session, rpc: 'unknown' })).json.error.code, -32601);
    });
    test(`${surface}: exact headers, login bindings, guest sids and CLI channels are enforced`, async () => {
        for (const actor of [identity(), identity('guest', 'guest-a', 'guest'),
            { ...identity('local:admin', 'cli-a', 'local'), authChannel: 'cli' }]) {
            const session = (await request(surface, { actor })).headers['mcp-session-id'];
            assert.ok(session);
            const reconnected = { ...actor, sessionId: 'new-login', session: { _jwtPayload: { sid: 'new-login' } } };
            assert.equal((await request(surface, { actor: reconnected, session, rpc: 'initialize' })).json.error.code, -32000);
            for (const bad of [[session], `${session},other`, ` ${session}`, `${session} `, '']) {
                assert.equal((await request(surface, { actor, session: bad, rpc: 'initialize' })).json.error.code, -32000);
            }
            const duplicate = await request(surface, { actor, session, rpc: 'initialize',
                rawHeaders: ['Mcp-Session-Id', session, 'mcp-session-id', session] });
            assert.equal(duplicate.json.error.code, -32000);
            const changedRoles = { ...actor, user: { ...actor.user, roles: [] } };
            assert.equal((await request(surface, { actor: changedRoles, session, rpc: 'unknown' })).json.error.code, -32601);
        }
    });
    test(`${surface}: public-none requires trusted target admission and never adopts protected sessions`, async () => {
        const publicActor = {};
        const opened = await request(surface, { actor: publicActor, publicTarget: 'echo' });
        const session = opened.headers['mcp-session-id'];
        assert.ok(session);
        assert.equal((await request(surface, { actor: {}, publicTarget: 'echo', session, rpc: 'unknown' })).json.error.code, -32601);
        assert.equal((await request(surface, { session, rpc: 'unknown' })).json.error.code, -32000);
        assert.equal((await request(surface, { actor: {}, publicTarget: 'other', target: 'other', session, rpc: 'unknown' })).json.error.code, -32000);
        const protectedSession = (await request(surface)).headers['mcp-session-id'];
        assert.equal((await request(surface, { actor: {}, publicTarget: 'echo', session: protectedSession, rpc: 'unknown' })).json.error.code, -32000);
        const missing = await request(surface, { actor: {}, rpc: 'initialize' });
        assert.equal(missing.headers['mcp-session-id'], undefined);
        assert.equal(missing.json.error.code, -32000);
    });
    test(`${surface}: GET remains unsupported and never changes an owned handle`, async () => {
        const session = (await request(surface)).headers['mcp-session-id'];
        assert.equal((await request(surface, { actor: identity('bob', 'other'), method: 'GET', session })).status, 405);
        assert.equal((await request(surface, { session, rpc: 'unknown' })).json.error.code, -32601);
    });
}

test('aggregate batches cannot initialize or notify around a foreign handle', async () => {
    const session = (await request('router')).headers['mcp-session-id'];
    const result = await request('router', { actor: identity('bob', 'other'), session,
        payload: [{ jsonrpc: '2.0', id: 1, method: 'initialize' },
            { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'ping' }] });
    assert.equal(result.headers['mcp-session-id'], undefined);
    assert.equal(result.json.length, 2);
    assert.ok(result.json.every(row => row.error.code === -32000));
});

test('agent: a raw delegated bearer cannot operate browser handles', async () => {
    const session = (await request('agent')).headers['mcp-session-id'];
    for (const rpc of ['initialize', 'tools/call', 'notifications/initialized']) {
        const result = await request('agent', { actor: {}, session, rpc, authorization: 'Bearer unverified-unit-fixture' });
        assert.equal(result.json.error.code, -32000);
        assert.equal(result.headers['mcp-session-id'], undefined);
    }
    assert.equal((await request('agent', { actor: {}, session, method: 'DELETE', authorization: 'Bearer unverified-unit-fixture' })).status, 403);
});

test('agent: deleting during readiness prevents late reinitialization', async () => {
    const session = (await request('agent')).headers['mcp-session-id'];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const pending = request('agent', { session, ready: async () => { entered(); return gate; } });
    await waiting;
    assert.equal((await request('agent', { session, method: 'DELETE' })).status, 204);
    release(true);
    const response = await pending;
    assert.equal(response.json.error.code, -32000);
    assert.equal(response.headers['mcp-session-id'], undefined);
    assert.equal(agentSessionStore.has(session), false);
});

test.after(() => agentSessionStore.clear());
