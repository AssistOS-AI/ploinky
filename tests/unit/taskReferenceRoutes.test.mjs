import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const savedKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '2'.repeat(64);

const { signAgentAssertion } = await import('../../Agent/lib/agentAssertion.mjs');
const { verifyRouterRequestFromHeaders } = await import('../../Agent/lib/invocationAuth.mjs');
const { createMemoryReplayCache } = await import('../../Agent/lib/jwtVerify.mjs');
const { computeRchHttp, sha256RawBodyHash } = await import('../../Agent/lib/requestHash.mjs');
const { resolveEdgeRoutePlan } = await import('../../cli/server/edgeRoutePlan.js');
const { handleTaskReferenceRequest } = await import('../../cli/server/executionProvider/taskReferenceRoutes.mjs');
const { mintUserDelegationGrant } = await import('../../cli/server/mcp-proxy/userDelegationGrant.js');
const { FileSystemPolicyStateStore } = await import('../../cli/server/policy/FileSystemPolicyStateStore.js');
const { McpToolPolicy } = await import('../../cli/server/policy/McpToolPolicy.js');
const { PolicyStateRepository } = await import('../../cli/server/policy/PolicyStateRepository.js');
const { deriveAgentRequestSecret, deriveSubkey } = await import('../../cli/utils/security/masterKey.js');
const { domainFixture } = await import('./directDomainFixtures.mjs');
const { startAgentServer } = await import('./helpers/agentServerProcess.mjs');
const { taskReferenceTool } = await import('./helpers/taskReferenceToolScript.mjs');

test.after(() => {
    if (savedKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = savedKey;
});

// Fictional agents: `explorer` declares task references at /explorer/task-refs
// on its private port 7300; `unrelated` serves task-reference tools; `mailer`
// is an agent caller on the private listener and declares no provider.
const PROVIDER = 'agent:fixtures/explorer';
const AGENT_CALLER = 'agent:fixtures/mailer';
const ID = 'T'.repeat(22);
const ORIGIN = 'AAAAAAAAAAAAAAAAAAAAAA';
const USER_A = { id: 'user-a', username: 'alice', roles: ['user'] };
const USER_B = { id: 'user-b', username: 'bob', roles: ['user'] };
const GUEST = { id: 'guest:visitor', roles: ['guest'] };

async function harness(t) {
    // The fictional provider: verifies every request's Router claims itself.
    const hits = [];
    const provider = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const [pathOnly, query = ''] = req.url.split('?');
            const search = query ? `?${query}` : '';
            const authInfo = JSON.parse(req.headers['x-ploinky-auth-info'] || '{}');
            const verified = verifyRouterRequestFromHeaders({ authorization: `Bearer ${authInfo.invocationToken || ''}` }, {
                env: { PLOINKY_AGENT_ID: PROVIDER, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(PROVIDER) },
                replayCache: createMemoryReplayCache(),
                method: req.method,
                path: pathOnly,
                tool: '__task_ref__',
                rch: computeRchHttp({ method: req.method, path: pathOnly, query: search, bodyHash: sha256RawBodyHash(body) }),
            });
            hits.push({
                method: req.method, url: req.url, body: body.toString('utf8'), verified,
                rawAuthInfo: req.headers['x-ploinky-auth-info'] || '', authorization: req.headers.authorization,
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => provider.close(resolve)));
    const providerPort = provider.address().port;

    const agent = await startAgentServer(t, {
        agentId: 'agent:fixtures/unrelated',
        secret: deriveAgentRequestSecret('agent:fixtures/unrelated', { encoding: 'buffer' }),
        tools: (dir) => [
            taskReferenceTool(dir, { name: 'start_job' }),
            taskReferenceTool(dir, { name: 'hidden_job' }),
            taskReferenceTool(dir, { name: 'agent_job' }),
            taskReferenceTool(dir, { name: 'mailer_job', provider: 'mailer' }),
        ],
    });
    const world = domainFixture(t, { mode: 'dual' });
    const manifestFile = (name) => path.join(world.root, 'fixtures', name, 'manifest.json');
    const explorer = JSON.parse(fs.readFileSync(manifestFile('explorer'), 'utf8'));
    explorer.executionProvider = { version: 1, port: 7300, taskReferences: { path: '/explorer/task-refs' } };
    fs.writeFileSync(manifestFile('explorer'), JSON.stringify(explorer));
    world.routing.routes.unrelated.hostPort = agent.port;
    world.write(world.paths.routingFile, world.routing);
    world.apply();
    const newGeneration = () => {
        const manifest = JSON.parse(fs.readFileSync(manifestFile('bizanso'), 'utf8'));
        manifest.note = (manifest.note || 0) + 1;
        fs.writeFileSync(manifestFile('bizanso'), JSON.stringify(manifest));
        world.apply();
    };

    const policyFile = path.join(world.root, 'taskref-policy.json');
    fs.writeFileSync(policyFile, JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [
        { agent: 'unrelated', tool: 'start_job', access: 'authenticated', enabled: true },
        { agent: 'unrelated', tool: 'mailer_job', access: 'authenticated', enabled: true },
        { agent: 'unrelated', tool: 'hidden_job', access: 'admin', enabled: true },
        { agent: 'unrelated', tool: 'agent_job', access: 'internal', enabled: true },
    ] }));
    const toolPolicy = new McpToolPolicy({
        repository: new PolicyStateRepository({ store: new FileSystemPolicyStateStore({ file: () => policyFile, coordinate: false }) }),
    });

    // Relay stand-in: the lease is rechecked at checkout and before OPEN, as
    // RuntimeRelayManager does; OPEN connects to the fictional provider.
    const opened = [];
    const relay = { beforeCheckout: null };
    const stale = () => Object.assign(new Error('runtimeRelay: generation lease is stale'), { code: 'EDGE_GENERATION_CHANGED' });
    const relayManager = {
        async checkout({ lease, authorized }) {
            assert.equal(authorized, true);
            relay.beforeCheckout?.();
            if (!lease || lease.commit() !== true) throw stale();
            return {
                async openRequest({ plan }) {
                    if (lease.commit() !== true) throw stale();
                    opened.push({ port: plan.port, targetPath: plan.targetPath, query: plan.query });
                    const socket = net.connect(providerPort, '127.0.0.1');
                    await once(socket, 'connect');
                    socket.abandon = () => socket.destroy();
                    return socket;
                },
                close() {},
            };
        },
    };

    const router = http.createServer(async (req, res) => {
        const listener = req.headers['x-test-listener'] || 'public';
        if (req.headers['x-test-user']) req.user = JSON.parse(req.headers['x-test-user']);
        delete req.headers['x-test-listener'];
        delete req.headers['x-test-user'];
        if (listener === 'private') req.ploinkyListenerClass = 'private';
        const plan = resolveEdgeRoutePlan({ req, listener });
        if (!plan.ok) {
            res.writeHead(plan.status || 404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: plan.code }));
            return;
        }
        assert.equal(plan.kind, 'task-reference');
        await handleTaskReferenceRequest({ req, res, plan, relayManager, toolPolicy });
    });
    await new Promise((resolve) => router.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => router.close(resolve)));

    const send = ({ listener = 'public', method = 'GET', target, body, user, headers = {} }) => new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const request = http.request({
            host: '127.0.0.1', port: router.address().port, method, path: target,
            headers: {
                host: listener === 'private' ? '127.0.0.1:8081' : '127.0.0.1:8080',
                'x-test-listener': listener,
                ...(user ? { 'x-test-user': JSON.stringify(user) } : {}),
                ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
                ...headers,
            },
        }, (response) => {
            const chunks = [];
            response.on('data', (c) => chunks.push(c));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: response.statusCode, text, json });
            });
        });
        request.on('error', reject);
        request.end(payload || undefined);
    });
    return { hits, opened, relay, send, newGeneration };
}

function agentAssertion({ method, target, args, caller = AGENT_CALLER, targetAgent = 'explorer' }) {
    return signAgentAssertion({
        method, path: target.split('?')[0], targetAgent, tool: '__task_ref__', argumentsObj: args,
        env: { PLOINKY_AGENT_ID: caller, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(caller) },
    });
}

test('descriptor: a visible tool returns its provider; hidden, unknown and unavailable-provider tools share one 404', async (t) => {
    const h = await harness(t);
    const visible = await h.send({ target: '/task-refs/descriptor?agent=unrelated&tool=start_job', user: USER_A });
    assert.equal(visible.status, 200, visible.text);
    assert.deepEqual(visible.json, { version: 1, provider: 'explorer' });
    const misses = [];
    for (const tool of ['hidden_job', 'no_such_tool', 'mailer_job']) {
        misses.push(await h.send({ target: `/task-refs/descriptor?agent=unrelated&tool=${tool}`, user: USER_A }));
    }
    misses.push(await h.send({ target: '/task-refs/descriptor?agent=nonexistent&tool=start_job', user: USER_A }));
    for (const miss of misses) {
        assert.equal(miss.status, 404, miss.text);
        assert.equal(miss.text, misses[0].text, 'indistinguishable');
    }
    // An agent caller on the private listener sees only internal tools.
    const args = { op: 'descriptor', agent: 'unrelated', tool: 'agent_job' };
    const target = '/task-refs/descriptor?agent=unrelated&tool=agent_job';
    const agentVisible = await h.send({ listener: 'private', target, headers: { authorization: `Bearer ${agentAssertion({ method: 'GET', target, args, targetAgent: 'unrelated' })}` } });
    assert.deepEqual(agentVisible.json, { version: 1, provider: 'explorer' }, agentVisible.text);
    const hiddenTarget = '/task-refs/descriptor?agent=unrelated&tool=start_job';
    const agentHidden = await h.send({ listener: 'private', target: hiddenTarget, headers: { authorization: `Bearer ${agentAssertion({ method: 'GET', target: hiddenTarget, args: { ...args, tool: 'start_job' }, targetAgent: 'unrelated' })}` } });
    assert.equal(agentHidden.status, 404);
    assert.equal(agentHidden.text, misses[0].text);
    // A delegated agent caller gets the same 404 (interface §2.2 known limitation).
    const grant = mintUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32), ttlSeconds: 60, sourceAgentId: AGENT_CALLER,
        user: USER_A, targetAgentId: PROVIDER, tools: ['__task_ref__'], scopes: ['execution:owner'],
    }).token;
    const delegated = await h.send({ listener: 'private', target, headers: {
        authorization: `Bearer ${agentAssertion({ method: 'GET', target, args, targetAgent: 'unrelated' })}`, 'x-ploinky-user-delegation': grant,
    } });
    assert.equal(delegated.status, 404);
    assert.equal(delegated.text, misses[0].text);
    assert.equal(h.hits.length, 0, 'the descriptor never contacts the provider');
});

test('all four operations reach the declared provider path with independently verified, request-bound claims', async (t) => {
    const h = await harness(t);
    const control = { operationId: 'op-1', op: 'stop' };
    const cases = [
        { method: 'GET', target: `/task-refs/explorer/${ID}`, url: `/explorer/task-refs/${ID}` },
        { method: 'GET', target: `/task-refs/explorer/${ID}/events?after=3&limit=7`, url: `/explorer/task-refs/${ID}/events?after=3&limit=7` },
        { method: 'POST', target: `/task-refs/explorer/${ID}/control`, url: `/explorer/task-refs/${ID}/control`, body: control },
        { method: 'POST', target: '/task-refs/explorer/lookup', url: '/explorer/task-refs/lookup', body: { originRequestId: ORIGIN } },
    ];
    for (const entry of cases) {
        const response = await h.send({ method: entry.method, target: entry.target, body: entry.body, user: USER_A });
        assert.equal(response.status, 200, `${entry.target}: ${response.text}`);
        const hit = h.hits.at(-1);
        assert.equal(hit.method, entry.method);
        assert.equal(hit.url, entry.url);
        assert.equal(hit.body, entry.body ? JSON.stringify(entry.body) : '');
        assert.equal(hit.verified.ok, true, `${entry.target}: ${hit.verified.reason}`);
        const claims = hit.verified.payload;
        assert.equal(claims.aud, PROVIDER);
        assert.equal(claims.tool, '__task_ref__');
        assert.deepEqual({ kind: claims.actor.kind, id: claims.actor.id }, { kind: 'user', id: 'user:user-a' });
        assert.equal(claims.originKey, entry.url.endsWith('/lookup') ? 'user:user-a' : undefined);
    }
    assert.ok(h.opened.every((open) => open.port === 7300), 'only the declared private port is opened');
});

test('lookup is bound to the verified direct caller: two users and an agent with the same origin id get distinct keys; a delegation does not replace the agent key', async (t) => {
    const h = await harness(t);
    for (const user of [USER_A, USER_B]) {
        const response = await h.send({ method: 'POST', target: '/task-refs/explorer/lookup', body: { originRequestId: ORIGIN }, user });
        assert.equal(response.status, 200, response.text);
        assert.equal(h.hits.at(-1).verified.payload.originKey, `user:${user.id}`);
    }
    const target = '/task-refs/explorer/lookup';
    const lookupBody = JSON.stringify({ originRequestId: ORIGIN });
    const args = { provider: 'explorer', op: 'lookup', originRequestId: ORIGIN, bodyHash: sha256RawBodyHash(Buffer.from(lookupBody)) };
    const grant = mintUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32), ttlSeconds: 60, sourceAgentId: AGENT_CALLER,
        user: USER_A, targetAgentId: PROVIDER, tools: ['__task_ref__'], scopes: ['execution:owner'],
    }).token;
    const plain = await h.send({ listener: 'private', method: 'POST', target, body: lookupBody,
        headers: { authorization: `Bearer ${agentAssertion({ method: 'POST', target, args })}` } });
    assert.equal(plain.status, 200, plain.text);
    const plainClaims = h.hits.at(-1).verified.payload;
    assert.equal(plainClaims.originKey, AGENT_CALLER);
    assert.equal(plainClaims.usr, undefined);
    const delegated = await h.send({ listener: 'private', method: 'POST', target, body: lookupBody,
        headers: { authorization: `Bearer ${agentAssertion({ method: 'POST', target, args })}`, 'x-ploinky-user-delegation': grant } });
    assert.equal(delegated.status, 200, delegated.text);
    const delegatedClaims = h.hits.at(-1).verified.payload;
    assert.equal(delegatedClaims.originKey, AGENT_CALLER, 'the delegation never replaces the direct-caller key');
    assert.equal(delegatedClaims.usr.id, USER_A.id);
    assert.equal(delegatedClaims.caller.id, AGENT_CALLER);
    assert.equal(h.hits.at(-1).rawAuthInfo.includes(grant), false, 'the grant bytes are not forwarded');
});

test('refusals never reach the provider: guests, anonymous callers, malformed ids, events queries and bodies, unavailable providers', async (t) => {
    const h = await harness(t);
    const refusals = [
        [{ target: `/task-refs/explorer/${ID}`, user: GUEST }, 403],
        [{ target: `/task-refs/explorer/${ID}` }, 401],
        [{ target: '/task-refs/explorer/short', user: USER_A }, 400],
        [{ target: `/task-refs/explorer/${ID}/events?after=1&after=2&limit=3`, user: USER_A }, 400],
        [{ target: `/task-refs/explorer/${ID}/events?limit=3&after=1`, user: USER_A }, 400],
        [{ target: `/task-refs/explorer/${ID}/events?after=0&limit=0`, user: USER_A }, 400],
        [{ target: `/task-refs/explorer/${ID}/events?after=0&limit=5&x=1`, user: USER_A }, 400],
        [{ target: `/task-refs/explorer/${ID}?x=1`, user: USER_A }, 400],
        [{ method: 'POST', target: '/task-refs/explorer/lookup', body: { originRequestId: 'short' }, user: USER_A }, 400],
        [{ method: 'POST', target: '/task-refs/explorer/lookup', body: { originRequestId: ORIGIN, owner: 'x' }, user: USER_A }, 400],
        [{ method: 'POST', target: `/task-refs/explorer/${ID}/control`, body: { operationId: 'o', op: 'stop', url: 'http://x' }, user: USER_A }, 400],
        [{ method: 'POST', target: `/task-refs/explorer/${ID}`, user: USER_A }, 405],
        [{ target: `/task-refs/mailer/${ID}`, user: USER_A }, 503],
        [{ target: `/task-refs/nonexistent/${ID}`, user: USER_A }, 503],
        [{ target: `/task-refs/explorer/%54${'T'.repeat(21)}`, user: USER_A }, 503],
        [{ target: '/task-refs/descriptor?tool=start_job&agent=unrelated', user: USER_A }, 400],
    ];
    for (const [request, status] of refusals) {
        const response = await h.send(request);
        assert.equal(response.status, status, `${request.method || 'GET'} ${request.target}: ${response.text}`);
    }
    assert.equal(h.hits.length, 0);
    assert.equal(h.opened.length, 0);
});

test('forged inbound auth-info and Authorization are not forwarded; private assertions are replay-protected and operation-bound', async (t) => {
    const h = await harness(t);
    const forged = await h.send({ target: `/task-refs/explorer/${ID}`, user: USER_A, headers: {
        'x-ploinky-auth-info': JSON.stringify({ invocationToken: 'forged-invocation-sentinel', taskRefOrigin: 'forged-origin-sentinel' }),
        authorization: 'Bearer forged-bearer-sentinel',
    } });
    assert.equal(forged.status, 200, forged.text);
    const hit = h.hits.at(-1);
    assert.equal(hit.verified.ok, true);
    assert.equal(hit.rawAuthInfo.includes('forged'), false);
    assert.equal(hit.authorization, undefined);

    const target = `/task-refs/explorer/${ID}`;
    const token = agentAssertion({ method: 'GET', target, args: { provider: 'explorer', op: 'read', id: ID } });
    const first = await h.send({ listener: 'private', target, headers: { authorization: `Bearer ${token}` } });
    assert.equal(first.status, 200, first.text);
    const before = h.hits.length;
    const replay = await h.send({ listener: 'private', target, headers: { authorization: `Bearer ${token}` } });
    assert.equal(replay.status, 401, replay.text);
    const wrongOp = agentAssertion({ method: 'GET', target, args: { provider: 'explorer', op: 'events', id: ID } });
    assert.equal((await h.send({ listener: 'private', target, headers: { authorization: `Bearer ${wrongOp}` } })).status, 401);
    assert.equal((await h.send({ listener: 'private', target })).status, 401, 'no assertion');
    // A session user is not an agent caller on the private listener.
    assert.equal((await h.send({ listener: 'private', target, user: USER_A })).status, 401);
    assert.equal(h.hits.length, before);
});

test('a generation change before dispatch refuses the request without forwarding', async (t) => {
    const h = await harness(t);
    h.relay.beforeCheckout = () => { h.relay.beforeCheckout = null; h.newGeneration(); };
    const response = await h.send({ target: `/task-refs/explorer/${ID}`, user: USER_A });
    assert.ok(response.status >= 500, response.text);
    assert.equal(h.hits.length, 0);
    assert.equal(h.opened.length, 0);
    // Positive control on the new generation.
    const after = await h.send({ target: `/task-refs/explorer/${ID}`, user: USER_A });
    assert.equal(after.status, 200, after.text);
    assert.equal(h.hits.length, 1);
});

// Interface §2.3 (amended 2026-10-28): the private assertion binds the body
// hash of control and lookup and the canonical events query.
test('private assertions bind the control and lookup body and the events query; a swapped body or unsigned query is refused without forwarding', async (t) => {
    const h = await harness(t);
    const controlTarget = `/task-refs/explorer/${ID}/control`;
    const signedBody = JSON.stringify({ operationId: 'op-1', op: 'message', payload: { text: 'hi' } });
    const controlArgs = (body) => ({ provider: 'explorer', op: 'control', id: ID, bodyHash: sha256RawBodyHash(Buffer.from(body)) });
    const send = (method, target, body, args) => h.send({ listener: 'private', method, target, body,
        headers: { authorization: `Bearer ${agentAssertion({ method, target, args })}` } });

    const ok = await send('POST', controlTarget, signedBody, controlArgs(signedBody));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(h.hits.at(-1).body, signedBody, 'positive control: the signed body is forwarded');
    const before = h.hits.length;
    const swapped = await send('POST', controlTarget, JSON.stringify({ operationId: 'op-swapped', op: 'stop' }), controlArgs(signedBody));
    assert.equal(swapped.status, 401, `swapped control body: ${swapped.text}`);
    const legacy = await send('POST', controlTarget, signedBody, { provider: 'explorer', op: 'control', id: ID });
    assert.equal(legacy.status, 401, 'an assertion without bodyHash is refused');

    const eventsTarget = (query) => `/task-refs/explorer/${ID}/events${query ? `?${query}` : ''}`;
    const eventsArgs = (query) => ({ provider: 'explorer', op: 'events', id: ID, query });
    const window = await send('GET', eventsTarget('after=3&limit=7'), undefined, eventsArgs('after=3&limit=7'));
    assert.equal(window.status, 200, window.text);
    const afterWindow = h.hits.length;
    const unsigned = await send('GET', eventsTarget('after=7&limit=1000'), undefined, eventsArgs('after=3&limit=7'));
    assert.equal(unsigned.status, 401, `unsigned events query: ${unsigned.text}`);
    const noQuery = await send('GET', eventsTarget('after=7&limit=1000'), undefined, { provider: 'explorer', op: 'events', id: ID });
    assert.equal(noQuery.status, 401);

    const lookupTarget = '/task-refs/explorer/lookup';
    const lookupBody = JSON.stringify({ originRequestId: ORIGIN });
    const respaced = JSON.stringify({ originRequestId: ORIGIN }, null, 1);
    const lookupArgs = { provider: 'explorer', op: 'lookup', originRequestId: ORIGIN, bodyHash: sha256RawBodyHash(Buffer.from(lookupBody)) };
    assert.equal((await send('POST', lookupTarget, respaced, lookupArgs)).status, 401, 'a different body byte sequence is refused');
    assert.equal(h.hits.length, afterWindow, 'no refused request reached the provider');
    assert.equal(before + 1, afterWindow, 'only the signed events window was forwarded in between');
});

test('a private task-reference body larger than 64 KiB is refused before authentication', async (t) => {
    const h = await harness(t);
    const target = `/task-refs/explorer/${ID}/control`;
    const big = JSON.stringify({ operationId: 'op', op: 'message', payload: 'x'.repeat(70 * 1024) });
    const response = await h.send({ listener: 'private', method: 'POST', target, body: big,
        headers: { authorization: `Bearer ${agentAssertion({ method: 'POST', target, args: { provider: 'explorer', op: 'control', id: ID, bodyHash: sha256RawBodyHash(Buffer.from(big)) } })}` } });
    assert.equal(response.status, 413, response.text);
    assert.equal(h.hits.length, 0);
});
