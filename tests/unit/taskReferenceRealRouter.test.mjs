import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { startRealRouterWorld } from './helpers/realRouterWorld.mjs';

// The real RoutingServer and AgentServer (verifier harness: fake SSO provider
// through the real /auth/login and /auth/callback, a podman shim running the
// real RuntimeHttpRelay, fictional provider servers recording every request).
// The world has no `routing.static`.
const ID = 'A'.repeat(22);
const ORIGIN = 'O'.repeat(22);
const FORGED = 'forged-origin-sentinel-5e1b';
const ROOT_ORIGIN = 'https://root.synthetic.test';

function decode(token) {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
}

test('real Router: S3a session, mutation-proof and pooled origin-token paths', { timeout: 120_000 }, async (t) => {
    const W = await startRealRouterWorld(t);
    const secretOf = (principal) => W.mk.deriveAgentRequestSecret(principal, { encoding: 'buffer' });
    const env = (principal) => ({ PLOINKY_AGENT_ID: principal, PLOINKY_AGENT_SECRET: W.mk.deriveAgentRequestSecret(principal) });
    const alice = await W.login('alice');
    const bob = await W.login('bob');
    const gina = await W.login('gina');
    const browser = (user, extra = {}) => ({ cookie: user.cookie, origin: ROOT_ORIGIN, 'x-ploinky-browser-csrf-token': user.csrf, ...extra });
    const send = (method, target, headers, body) => W.request({
        method, target, host: W.rootHost, body, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    });
    const verifyForward = (hit) => {
        const url = new URL(hit.url, 'http://x');
        const token = JSON.parse(hit.headers['x-ploinky-auth-info'] || '{}').invocationToken;
        return W.signed.verifyRouterRequestToken(token, {
            secret: secretOf(W.P.explorer), expectedAudience: W.P.explorer, method: hit.method, path: url.pathname, tool: '__task_ref__',
            rch: W.reqHash.computeRchHttp({ method: hit.method, path: url.pathname, query: url.search, bodyHash: W.reqHash.sha256RawBodyHash(hit.bodyRaw) }),
            replayCache: W.jwtVerify.createMemoryReplayCache(),
        }).payload;
    };
    const seen = (label) => {
        const file = path.join(W.agentDir, `seen-${label}.json`);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    };
    const verifyOrigin = (token, expected) => {
        const payload = W.signed.verifyRouterRequestToken(token, {
            secret: secretOf(W.P.explorer), expectedAudience: W.P.explorer, method: 'ORIGIN', path: '/origin', tool: '__task_ref_origin__',
            rch: W.originLib.taskReferenceOriginBinding(expected).rch, replayCache: W.jwtVerify.createMemoryReplayCache(),
        }).payload;
        assert.deepEqual(payload.origin, expected);
        return payload;
    };

    await t.test('D2a: a browser session reaches read, events and descriptor without routing.static, on the root and control hosts', async () => {
        assert.equal(W.activeGeneration().generation.routing.static, undefined, 'the world has no static agent');
        for (const host of [W.rootHost, `127.0.0.1:${W.ports.pub}`]) {
            for (const target of [`/task-refs/explorer/${ID}`, `/task-refs/explorer/${ID}/events?after=0&limit=5`]) {
                const before = W.received.prov.length;
                const response = await W.request({ target, host, headers: { cookie: alice.cookie } });
                assert.equal(response.status, 200, `${host} ${target}: ${response.body}`);
                assert.equal(W.received.prov.length, before + 1);
                const claims = verifyForward(W.received.prov.at(-1));
                assert.equal(claims.actor.id, 'user:user-alice');
                assert.equal(claims.originKey, undefined);
            }
        }
        const descriptor = await send('GET', '/task-refs/descriptor?agent=unrelated&tool=start_job', { cookie: alice.cookie });
        assert.equal(descriptor.status, 200, descriptor.body);
        assert.deepEqual(JSON.parse(descriptor.body), { version: 1, provider: 'explorer' });
        const anonymous = await send('GET', `/task-refs/explorer/${ID}`, {});
        assert.ok([401, 302].includes(anonymous.status), `anonymous: ${anonymous.status} ${anonymous.body}`);
    });

    await t.test('D2b: POST control and lookup pass the browser mutation proof with a valid CSRF token and Origin, and fail without', async () => {
        for (const user of [alice, bob]) {
            const before = W.received.prov.length;
            const control = await send('POST', `/task-refs/explorer/${ID}/control`, browser(user), JSON.stringify({ operationId: `op-${user.code}`, op: 'stop' }));
            assert.equal(control.status, 200, `control ${user.code}: ${control.body}`);
            const lookup = await send('POST', '/task-refs/explorer/lookup', browser(user), JSON.stringify({ originRequestId: ORIGIN }));
            assert.equal(lookup.status, 200, `lookup ${user.code}: ${lookup.body}`);
            assert.equal(W.received.prov.length, before + 2);
            const lookupClaims = verifyForward(W.received.prov.at(-1));
            assert.equal(lookupClaims.originKey, `user:user-${user.code}`, 'two users with one origin id get their own keys');
        }
        const before = W.received.prov.length;
        const body = JSON.stringify({ operationId: 'op-x', op: 'stop' });
        const withoutCsrf = await send('POST', `/task-refs/explorer/${ID}/control`, { cookie: alice.cookie.replace(/ploinky_browser_csrf=[^;]*;?\s*/, ''), origin: ROOT_ORIGIN }, body);
        assert.equal(withoutCsrf.status, 403, withoutCsrf.body);
        const wrongOrigin = await send('POST', `/task-refs/explorer/${ID}/control`, browser(alice, { origin: 'https://evil.synthetic.test' }), body);
        assert.equal(wrongOrigin.status, 403, wrongOrigin.body);
        const crossUserCsrf = await send('POST', '/task-refs/explorer/lookup', browser(alice, { 'x-ploinky-browser-csrf-token': bob.csrf }), JSON.stringify({ originRequestId: ORIGIN }));
        assert.equal(crossUserCsrf.status, 403, crossUserCsrf.body);
        assert.equal(W.received.prov.length, before, 'refused mutations never reach the provider');
    });

    await t.test('guest: a guest-role session is refused by the task-reference handler', async () => {
        const before = W.received.prov.length;
        const read = await send('GET', `/task-refs/explorer/${ID}`, { cookie: gina.cookie });
        assert.equal(read.status, 403, read.body);
        assert.match(read.body, /task_reference_guest_refused/);
        assert.equal(W.received.prov.length, before);
    });

    const mcpHeaders = (extra = {}) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });
    const mcpInit = async (headers) => {
        const response = await W.request({ method: 'POST', target: '/unrelated/mcp', host: W.rootHost, headers: mcpHeaders(headers),
            body: JSON.stringify({ jsonrpc: '2.0', id: 'i', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
        const sid = response.headers['mcp-session-id'];
        assert.ok(sid, `${response.status} ${response.body}`);
        return sid;
    };
    const mcpCall = (headers, sid, tool, args, host = W.rootHost) => W.request({
        method: 'POST', target: '/unrelated/mcp', host,
        headers: mcpHeaders({ ...headers, ...(sid ? { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' } : {}) }),
        body: JSON.stringify({ jsonrpc: '2.0', id: args.label, method: 'tools/call', params: { name: tool, arguments: args } }),
    });

    await t.test('D1: pooled per-agent MCP calls deliver each caller its own origin token (interleaved users, delegated agent, plain agent, guest)', async () => {
        const [sa, sb, sg] = await Promise.all([mcpInit(browser(alice)), mcpInit(browser(bob)), mcpInit(browser(gina))]);
        const calls = await Promise.all([
            mcpCall(browser(alice), sa, 'start_job', { originRequestId: ORIGIN, label: 'pool-a1' }),
            mcpCall(browser(bob), sb, 'start_job', { originRequestId: ORIGIN, label: 'pool-b1' }),
            mcpCall(browser(alice, { 'x-ploinky-auth-info': JSON.stringify({ taskRefOrigin: FORGED }) }), sa, 'start_job', { originRequestId: ORIGIN, label: 'pool-a2' }),
            mcpCall(browser(bob), sb, 'start_job', { originRequestId: ORIGIN, label: 'pool-b2' }),
        ]);
        for (const call of calls) assert.equal(JSON.parse(call.body).result?.metadata?.taskRef?.provider, 'explorer', call.body);
        const tokens = new Set();
        for (const [label, key] of [['pool-a1', 'user:user-alice'], ['pool-a2', 'user:user-alice'], ['pool-b1', 'user:user-bob'], ['pool-b2', 'user:user-bob']]) {
            const record = seen(label);
            assert.ok(record?.taskRefOrigin, `${label}: the pooled call delivered a token`);
            assert.equal(JSON.stringify(record).includes(FORGED), false, `${label}: forged inbound auth-info never reaches the tool`);
            verifyOrigin(record.taskRefOrigin, { originKey: key, originRequestId: ORIGIN, agent: W.P.unrelated, tool: 'start_job' });
            tokens.add(record.taskRefOrigin);
        }
        assert.equal(tokens.size, 4, 'every call carried its own token');

        const caller = W.P.mailer;
        const loop = `127.0.0.1:${W.ports.pub}`;
        const delegatedArgs = { originRequestId: ORIGIN, label: 'pool-delegated' };
        const assertion = W.assertionLib.signAgentAssertion({ method: 'POST', path: '/mcp', targetAgent: 'unrelated', tool: 'start_job', argumentsObj: delegatedArgs, env: env(caller) });
        const grant = W.grantLib.mintUserDelegationGrant({ signingSecret: W.mk.deriveSubkey('router-user-delegation', 32), ttlSeconds: 60, sourceAgentId: caller,
            user: { id: 'user-alice', username: 'alice', roles: ['user'] }, targetAgentId: W.P.unrelated, tools: ['start_job'], scopes: ['jobs:start'] }).token;
        const delegated = await mcpCall({ authorization: `Bearer ${assertion}`, 'x-ploinky-user-delegation': grant }, null, 'start_job', delegatedArgs, loop);
        assert.equal(delegated.status, 200, delegated.body);
        verifyOrigin(seen('pool-delegated')?.taskRefOrigin, { originKey: caller, originRequestId: ORIGIN, agent: W.P.unrelated, tool: 'start_job' });

        const plainArgs = { originRequestId: ORIGIN, label: 'pool-agent' };
        const plainAssertion = W.assertionLib.signAgentAssertion({ method: 'POST', path: '/mcp', targetAgent: 'unrelated', tool: 'agent_job', argumentsObj: plainArgs, env: env(caller) });
        const plain = await mcpCall({ authorization: `Bearer ${plainAssertion}` }, null, 'agent_job', plainArgs, loop);
        assert.equal(plain.status, 200, plain.body);
        verifyOrigin(seen('pool-agent')?.taskRefOrigin, { originKey: caller, originRequestId: ORIGIN, agent: W.P.unrelated, tool: 'agent_job' });

        const guestCall = await mcpCall(browser(gina), sg, 'start_job', { originRequestId: ORIGIN, label: 'pool-guest' });
        const guestSeen = seen('pool-guest');
        assert.ok(!guestSeen || guestSeen.taskRefOrigin === '', `a guest never receives an origin token: ${guestCall.body}`);
    });

    await t.test('private listener: assertions bind the control body and events query (F3); bodies over 64 KiB are refused (R10)', async () => {
        const PRIV = `127.0.0.1:${W.ports.priv}`;
        const bearer = (method, target, args) => W.assertionLib.signAgentAssertion({
            method, path: target.split('?')[0], targetAgent: 'explorer', tool: '__task_ref__', argumentsObj: args, env: env(W.P.mailer),
        });
        const priv = (method, target, args, body) => W.request({ port: W.ports.priv, host: PRIV, method, target, body,
            headers: { authorization: `Bearer ${bearer(method, target, args)}`, ...(body ? { 'content-type': 'application/json' } : {}) } });
        const control = `/task-refs/explorer/${ID}/control`;
        const signed = JSON.stringify({ operationId: 'op-p', op: 'message', payload: { text: 'hi' } });
        const hashOf = (body) => W.reqHash.sha256RawBodyHash(Buffer.from(body));
        const before = W.received.prov.length;
        const ok = await priv('POST', control, { provider: 'explorer', op: 'control', id: ID, bodyHash: hashOf(signed) }, signed);
        assert.equal(ok.status, 200, ok.body);
        assert.equal(W.received.prov.at(-1).body, signed);
        const swapped = await priv('POST', control, { provider: 'explorer', op: 'control', id: ID, bodyHash: hashOf(signed) }, JSON.stringify({ operationId: 'op-s', op: 'stop' }));
        assert.equal(swapped.status, 401, swapped.body);
        const events = `/task-refs/explorer/${ID}/events?after=7&limit=1000`;
        const unsigned = await priv('GET', events, { provider: 'explorer', op: 'events', id: ID, query: 'after=3&limit=7' });
        assert.equal(unsigned.status, 401, unsigned.body);
        const big = JSON.stringify({ operationId: 'op-b', op: 'message', payload: 'x'.repeat(70 * 1024) });
        const oversized = await priv('POST', control, { provider: 'explorer', op: 'control', id: ID, bodyHash: hashOf(big) }, big);
        assert.equal(oversized.status, 413, oversized.body);
        assert.equal(W.received.prov.length, before + 1, 'only the signed control request reached the provider');
    });

    await t.test('the debug logs of the Router and AgentServer contain no delivered token', async () => {
        const logs = fs.readFileSync(W.routerLog, 'utf8') + fs.readFileSync(W.agentLog, 'utf8');
        assert.match(logs, /Tool 'start_job' context:/, 'positive control: AgentServer debug logging is on');
        for (const label of ['pool-a1', 'pool-b1', 'pool-delegated', 'pool-agent']) {
            const token = seen(label).taskRefOrigin;
            for (const part of token.split('.').slice(1)) assert.equal(logs.includes(part), false, `${label} token leaked`);
            assert.equal(logs.includes(decode(token).jti), false);
        }
        for (const user of [alice, bob]) for (const value of Object.values(user.jar)) assert.equal(logs.includes(value), false, 'session cookie leaked');
    });
});

test('real Router with routing.static: the session and the mutation proof behave the same', { timeout: 120_000 }, async (t) => {
    const W = await startRealRouterWorld(t, { staticAgent: 'explorer' });
    assert.equal(W.activeGeneration().generation.routing.static.agent, 'explorer');
    const alice = await W.login('alice');
    const headers = { cookie: alice.cookie, origin: ROOT_ORIGIN, 'x-ploinky-browser-csrf-token': alice.csrf, 'content-type': 'application/json' };
    const before = W.received.prov.length;
    const read = await W.request({ target: `/task-refs/explorer/${ID}`, host: W.rootHost, headers: { cookie: alice.cookie } });
    assert.equal(read.status, 200, read.body);
    const control = await W.request({ method: 'POST', target: `/task-refs/explorer/${ID}/control`, host: W.rootHost, headers, body: JSON.stringify({ operationId: 'op-s', op: 'stop' }) });
    assert.equal(control.status, 200, control.body);
    const lookup = await W.request({ method: 'POST', target: '/task-refs/explorer/lookup', host: W.rootHost, headers, body: JSON.stringify({ originRequestId: ORIGIN }) });
    assert.equal(lookup.status, 200, lookup.body);
    const refused = await W.request({ method: 'POST', target: '/task-refs/explorer/lookup', host: W.rootHost, headers: { ...headers, origin: 'https://evil.synthetic.test' }, body: JSON.stringify({ originRequestId: ORIGIN }) });
    assert.equal(refused.status, 403, refused.body);
    assert.equal(W.received.prov.length, before + 3);
});
