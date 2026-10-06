import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import * as browserClientModule from '../../Agent/client/MCPBrowserClient.js';

const { createAgentClient } = browserClientModule;
const CSRF_HEADER = 'x-ploinky-browser-csrf-token';
const ORIGINAL_WINDOW = globalThis.window;

function readJson(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')));
    });
}

function sendJson(res, status, payload, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
}

// A Router stand-in: /auth/token mints the current proof for the route; every
// mutation must carry it. `state.proof` changes to simulate a new generation.
async function startRouter(t, { routeKey = 'dpuAgent', onToolCall, onTaskStatus } = {}) {
    const state = {
        proof: 'v1.generation-1',
        generation: 'generation-1',
        proofRequests: 0,
        mutations: [],
        rejected: 0,
        unauthorizedOnce: false,
    };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        if (req.method === 'GET' && url.pathname === '/auth/token') {
            state.proofRequests += 1;
            assert.equal(url.searchParams.get('mutationRoute'), routeKey);
            // Delay so that concurrent callers overlap with one in-flight fetch.
            await new Promise((resolve) => setTimeout(resolve, 20));
            sendJson(res, 200, {
                ok: true,
                browserMutation: {
                    origin: `http://${req.headers.host}`,
                    csrfToken: state.proof,
                    generation: state.generation,
                    routeKey,
                },
            });
            return;
        }
        if (req.method === 'GET' && url.pathname === `/${routeKey}/task`) {
            sendJson(res, 200, { task: onTaskStatus(url.searchParams.get('taskId')) });
            return;
        }
        if (req.method === 'DELETE') {
            state.mutations.push({ method: 'DELETE', csrf: req.headers[CSRF_HEADER] });
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(500);
            res.end('unexpected request');
            return;
        }
        const body = await readJson(req);
        state.mutations.push({ method: body.method, csrf: req.headers[CSRF_HEADER] });
        if (state.unauthorizedOnce) {
            state.unauthorizedOnce = false;
            sendJson(res, 401, { error: 'not_authenticated' });
            return;
        }
        if (req.headers[CSRF_HEADER] !== state.proof) {
            state.rejected += 1;
            sendJson(res, 403, { error: 'browser_csrf_invalid' });
            return;
        }
        const headers = { 'mcp-session-id': 'session-proof-cache', 'mcp-protocol-version': '2025-06-18' };
        if (body.method === 'initialize') {
            sendJson(res, 200, {
                jsonrpc: '2.0',
                id: body.id,
                result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } },
            }, headers);
            return;
        }
        if (body.method === 'notifications/initialized') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (body.method === 'tools/call') {
            const result = onToolCall ? onToolCall(body.params) : { content: [{ type: 'text', text: 'ok' }] };
            sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result }, headers);
            return;
        }
        res.writeHead(500);
        res.end('unexpected request');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const origin = `http://127.0.0.1:${port}`;
    globalThis.window = { location: { href: `${origin}/${routeKey}/index.html`, origin } };
    t.after(async () => {
        if (ORIGINAL_WINDOW === undefined) delete globalThis.window;
        else globalThis.window = ORIGINAL_WINDOW;
        browserClientModule.clearBrowserMutationProofs?.();
        await new Promise((resolve) => server.close(resolve));
    });
    return { state, origin, endpoint: `${origin}/${routeKey}/mcp` };
}

test('one browser mutation proof serves 5 + 3 mutations across two clients of a route', async (t) => {
    const { state, endpoint } = await startRouter(t);
    const first = createAgentClient(endpoint);
    const second = createAgentClient(endpoint);

    // Concurrent connects share one in-flight proof fetch.
    await Promise.all([first.connect(), second.connect()]);
    await first.callTool('a', {});
    await Promise.all([first.callTool('b', {}), first.callTool('c', {})]);
    await second.callTool('d', {});

    assert.equal(state.mutations.length, 8);
    assert.equal(state.proofRequests, 1);
    assert.ok(state.mutations.every((entry) => entry.csrf === 'v1.generation-1'));
    assert.equal(state.rejected, 0);
});

test('a rejected proof is refreshed exactly once and the mutation is retried', async (t) => {
    const { state, endpoint } = await startRouter(t);
    const client = createAgentClient(endpoint);
    await client.connect();
    assert.equal(state.proofRequests, 1);

    // A new generation: the Router now accepts only the new proof.
    state.proof = 'v1.generation-2';
    state.generation = 'generation-2';
    const result = await client.callTool('after_generation_change', {});
    assert.equal(result.content[0].text, 'ok');
    assert.equal(state.rejected, 1);
    assert.equal(state.proofRequests, 2);
    const calls = state.mutations.filter((entry) => entry.method === 'tools/call');
    assert.deepEqual(calls.map((entry) => entry.csrf), ['v1.generation-1', 'v1.generation-2']);

    // Concurrent mutations rejected with the same stale proof share one refresh.
    state.proof = 'v1.generation-3';
    state.generation = 'generation-3';
    const results = await Promise.all([
        client.callTool('x', {}), client.callTool('y', {}), client.callTool('z', {}),
    ]);
    assert.ok(results.every((entry) => entry.content[0].text === 'ok'));
    assert.equal(state.proofRequests, 3);
});

test('a 401 and close() both drop the shared proof', async (t) => {
    const { state, endpoint } = await startRouter(t);
    const client = createAgentClient(endpoint);
    await client.connect();
    assert.equal(state.proofRequests, 1);

    state.unauthorizedOnce = true;
    await assert.rejects(() => client.callTool('denied', {}), /HTTP 401/);
    await client.callTool('after_login', {});
    assert.equal(state.proofRequests, 2);

    await client.close();
    const next = createAgentClient(endpoint);
    await next.connect();
    assert.equal(state.proofRequests, 3);
});

test('proofs are never shared across origins for the same route', async (t) => {
    const routerA = await startRouter(t);
    const clientA = createAgentClient(routerA.endpoint);
    await clientA.connect();

    const routerB = await startRouter(t);
    routerB.state.proof = 'v1.other-origin';
    const clientB = createAgentClient(routerB.endpoint);
    await clientB.connect();

    // Each origin fetched its own single proof for its two mutations, and
    // origin B never received origin A's proof.
    assert.equal(routerA.state.mutations.length, 2);
    assert.equal(routerB.state.mutations.length, 2);
    assert.equal(routerA.state.proofRequests, 1);
    assert.equal(routerB.state.proofRequests, 1);
    assert.ok(routerB.state.mutations.every((entry) => entry.csrf === 'v1.other-origin'));
    assert.equal(routerB.state.rejected, 0);
});

test('a task completing at 1.2 s is reported by 2.0 s', async (t) => {
    let queuedAt = 0;
    const polls = [];
    const { endpoint } = await startRouter(t, {
        onToolCall: () => {
            queuedAt = Date.now();
            return { content: [{ type: 'text', text: 'queued' }], metadata: { taskId: 'task-fast', agent: 'dpuAgent', status: 'queued' } };
        },
        onTaskStatus: (taskId) => {
            const elapsed = Date.now() - queuedAt;
            polls.push(elapsed);
            const done = elapsed >= 1200;
            return {
                id: taskId,
                toolName: 'slow_tool',
                status: done ? 'completed' : 'running',
                result: done ? { content: [{ type: 'text', text: 'done' }], metadata: {} } : undefined,
            };
        },
    });
    const client = createAgentClient(endpoint);
    const result = await client.callTool('slow_tool', {});
    const reportedAfter = Date.now() - queuedAt;

    assert.equal(result.content[0].text, 'done');
    assert.ok(reportedAfter >= 1200, `reported too early: ${reportedAfter} ms`);
    assert.ok(reportedAfter <= 2000, `reported after ${reportedAfter} ms (polls at ${polls.join(', ')} ms)`);
});

test('task polling restarts its back-off when the status changes', async (t) => {
    let queuedAt = 0;
    const polls = [];
    const { endpoint } = await startRouter(t, {
        onToolCall: () => {
            queuedAt = Date.now();
            return { content: [{ type: 'text', text: 'queued' }], metadata: { taskId: 'task-reset', agent: 'dpuAgent', status: 'queued' } };
        },
        onTaskStatus: (taskId) => {
            const elapsed = Date.now() - queuedAt;
            polls.push(elapsed);
            const status = elapsed >= 2200 ? 'completed' : elapsed >= 900 ? 'running' : 'queued';
            return {
                id: taskId,
                toolName: 'staged_tool',
                status,
                result: status === 'completed' ? { content: [{ type: 'text', text: 'done' }], metadata: {} } : undefined,
            };
        },
    });
    const client = createAgentClient(endpoint);
    const result = await client.callTool('staged_tool', {});
    const reportedAfter = Date.now() - queuedAt;

    // Polls near 0, 250, 750 (queued), 1750 (running: back-off restarts), 2000, 2500.
    // Without the restart the poll after 1750 ms would come at 3750 ms.
    assert.equal(result.content[0].text, 'done');
    assert.ok(reportedAfter <= 3000, `reported after ${reportedAfter} ms (polls at ${polls.join(', ')} ms)`);
});
