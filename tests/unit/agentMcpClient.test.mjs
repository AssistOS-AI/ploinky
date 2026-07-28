import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-client-'));
const originalCwd = process.cwd();
const originalRouterUrl = process.env.PLOINKY_ROUTER_URL;
const originalRouterAuthority = process.env.PLOINKY_ROUTER_AUTHORITY;
const originalAgentId = process.env.PLOINKY_AGENT_ID;
const originalAgentSecret = process.env.PLOINKY_AGENT_SECRET;
const originalPollInterval = process.env.PLOINKY_MCP_TASK_POLL_INTERVAL_MS;

process.chdir(tempDir);
process.env.PLOINKY_AGENT_ID = 'agent:AssistOSExplorer/onlyOffice';
process.env.PLOINKY_AGENT_SECRET = 'a'.repeat(64);
process.env.PLOINKY_MCP_TASK_POLL_INTERVAL_MS = '10';

const {
    createAgentClient,
    getRouterAuthority,
    setAgentTaskObserver,
} = await import('../../Agent/client/AgentMcpClient.mjs');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalRouterUrl === undefined) delete process.env.PLOINKY_ROUTER_URL;
    else process.env.PLOINKY_ROUTER_URL = originalRouterUrl;
    if (originalRouterAuthority === undefined) delete process.env.PLOINKY_ROUTER_AUTHORITY;
    else process.env.PLOINKY_ROUTER_AUTHORITY = originalRouterAuthority;
    if (originalAgentId === undefined) delete process.env.PLOINKY_AGENT_ID;
    else process.env.PLOINKY_AGENT_ID = originalAgentId;
    if (originalAgentSecret === undefined) delete process.env.PLOINKY_AGENT_SECRET;
    else process.env.PLOINKY_AGENT_SECRET = originalAgentSecret;
    if (originalPollInterval === undefined) delete process.env.PLOINKY_MCP_TASK_POLL_INTERVAL_MS;
    else process.env.PLOINKY_MCP_TASK_POLL_INTERVAL_MS = originalPollInterval;
});

async function withCaptureServer(t, onRequest) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => onRequest(req, Buffer.concat(chunks), res));
    });
    const port = await listen(server);
    process.env.PLOINKY_ROUTER_URL = `http://127.0.0.1:${port}`;
    delete process.env.PLOINKY_ROUTER_AUTHORITY;
    t.after(async () => {
        await close(server);
    });
}

test('createAgentClient requires a valid nonempty PLOINKY_ROUTER_URL without fallback synthesis', async () => {
    const previousUrl = process.env.PLOINKY_ROUTER_URL;
    const previousPort = process.env.PLOINKY_ROUTER_PORT;
    try {
        delete process.env.PLOINKY_ROUTER_URL;
        process.env.PLOINKY_ROUTER_PORT = '65535';
        await assert.rejects(
            () => createAgentClient('dpuAgent'),
            /PLOINKY_ROUTER_URL is required/,
        );

        for (const invalid of ['', '   ', 'not-a-url', 'file:///tmp/router', 'http://user:pass@localhost:8080', 'http://localhost:8080/router']) {
            process.env.PLOINKY_ROUTER_URL = invalid;
            await assert.rejects(
                () => createAgentClient('dpuAgent'),
                /PLOINKY_ROUTER_URL/,
            );
        }
    } finally {
        if (previousUrl === undefined) delete process.env.PLOINKY_ROUTER_URL;
        else process.env.PLOINKY_ROUTER_URL = previousUrl;
        if (previousPort === undefined) delete process.env.PLOINKY_ROUTER_PORT;
        else process.env.PLOINKY_ROUTER_PORT = previousPort;
    }
});

test('createAgentClient separates the Router transport address from its canonical authority', async (t) => {
    let capturedHost = '';
    await withCaptureServer(t, (req, _body, res) => {
        capturedHost = req.headers.host || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { ok: true } }));
    });
    process.env.PLOINKY_ROUTER_AUTHORITY = 'router.example:19090';

    const client = await createAgentClient('dpuAgent');
    assert.deepEqual(await client.callTool('dpu_workspace_roots', {}), { ok: true });
    assert.equal(capturedHost, 'router.example:19090');
});

test('getRouterAuthority rejects unsafe authority syntax', () => {
    const previous = process.env.PLOINKY_ROUTER_AUTHORITY;
    try {
        for (const invalid of ['router.example:', 'user@router.example:8080', 'router.example/path', 'router.example?query']) {
            process.env.PLOINKY_ROUTER_AUTHORITY = invalid;
            assert.throws(() => getRouterAuthority('http://127.0.0.1:8080'), /invalid PLOINKY_ROUTER_AUTHORITY/);
        }
    } finally {
        if (previous === undefined) delete process.env.PLOINKY_ROUTER_AUTHORITY;
        else process.env.PLOINKY_ROUTER_AUTHORITY = previous;
    }
});

test('createAgentClient sends no delegation header by default', async (t) => {
    let captured = null;
    await withCaptureServer(t, (req, body, res) => {
        captured = { headers: req.headers, body: body.toString('utf8') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { ok: true } }));
    });
    const client = await createAgentClient('dpuAgent');
    const result = await client.callTool('dpu_confidential_get', { id: 'doc-1' });

    assert.deepEqual(result, { ok: true });
    assert.equal(typeof captured.headers.authorization, 'string');
    assert.equal(captured.headers['x-ploinky-user-delegation'], undefined);
});

test('createAgentClient sends x-ploinky-user-delegation when configured', async (t) => {
    let captured = null;
    await withCaptureServer(t, (req, body, res) => {
        captured = { headers: req.headers, body: body.toString('utf8') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { ok: true } }));
    });
    const client = await createAgentClient('dpuAgent', { userDelegationToken: 'delegation-token-1' });
    await client.callTool('dpu_confidential_get', { id: 'doc-1' });

    assert.equal(captured.headers['x-ploinky-user-delegation'], 'delegation-token-1');
});

test('createAgentClient unwraps JSON text tool results from MCP content envelopes', async (t) => {
    await withCaptureServer(t, (_req, _body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: '1',
            result: {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            roots: {
                                mySpace: {
                                    id: 'root-1'
                                }
                            }
                        })
                    }
                ]
            }
        }));
    });
    const client = await createAgentClient('dpuAgent', { userDelegationToken: 'delegation-token-1' });
    const result = await client.callTool('dpu_workspace_roots', {});

    assert.deepEqual(result, {
        roots: {
            mySpace: {
                id: 'root-1'
            }
        }
    });
});

test('per-call delegation token overrides client delegation token', async (t) => {
    let captured = null;
    await withCaptureServer(t, (req, body, res) => {
        captured = { headers: req.headers, body: body.toString('utf8') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { ok: true } }));
    });
    const client = await createAgentClient('dpuAgent', { userDelegationToken: 'delegation-token-1' });
    await client.callTool('dpu_confidential_update', { id: 'doc-1' }, { userDelegationToken: 'delegation-token-2' });

    assert.equal(captured.headers['x-ploinky-user-delegation'], 'delegation-token-2');
});

test('createAgentClient rejects non-string delegation tokens', async () => {
    const client = await createAgentClient('dpuAgent');
    await assert.rejects(
        () => client.callTool('dpu_confidential_get', { id: 'doc-1' }, { userDelegationToken: 123 }),
        /userDelegationToken must be a string/,
    );
});

test('callTool waits for an asynchronous task and does not apply the observer', async (t) => {
    let statusRequests = 0;
    await withCaptureServer(t, (req, _body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET') {
            statusRequests += 1;
            res.end(JSON.stringify({
                task: {
                    id: 'task-wait',
                    status: 'completed',
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ ok: true, outputText: 'finished' }),
                        }],
                    },
                },
            }));
            return;
        }
        res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: '1',
            result: { metadata: { taskId: 'task-wait', status: 'queued' } },
        }));
    });
    let observations = 0;
    const removeObserver = setAgentTaskObserver(async () => {
        observations += 1;
        return { detached: true };
    });
    t.after(removeObserver);

    const client = await createAgentClient('asyncAgent');
    const updates = [];
    const result = await client.callTool('execute-task', { prompt: 'wait' }, {
        onTaskUpdate: (task) => updates.push(task),
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.ok, true);
    assert.equal(result.outputText, 'finished');
    assert.deepEqual(updates.map((task) => task.status), ['queued', 'completed']);
    assert.equal(statusRequests, 1);
    assert.equal(observations, 0);
});

test('callToolWithoutWait applies the observer and returns without polling', async (t) => {
    let statusRequests = 0;
    await withCaptureServer(t, (req, _body, res) => {
        if (req.method === 'GET') {
            statusRequests += 1;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: '1',
            result: { metadata: { taskId: 'task-detach', status: 'queued' } },
        }));
    });
    const observations = [];
    const removeObserver = setAgentTaskObserver(async (task) => {
        observations.push(task);
        return { detached: true, id: 'local-task', description: 'Detached task' };
    });
    t.after(removeObserver);

    const client = await createAgentClient('asyncAgent');
    const result = await client.callToolWithoutWait('execute-task', { prompt: 'detach' });

    assert.equal(observations.length, 1);
    assert.equal(observations[0].taskId, 'task-detach');
    assert.equal(result.metadata.backgroundTask.detached, true);
    assert.equal(result.metadata.backgroundTask.id, 'local-task');
    assert.equal(statusRequests, 0);
});

test('task observer status callbacks stay pinned to the client router', async (t) => {
    let firstRouterPosts = 0;
    let firstRouterGets = 0;
    let secondRouterRequests = 0;
    const firstRouter = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET') {
            firstRouterGets += 1;
            res.end(JSON.stringify({
                task: { id: 'task-pinned', status: 'completed' },
            }));
            return;
        }
        firstRouterPosts += 1;
        req.resume();
        req.on('end', () => {
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: '1',
                result: { metadata: { taskId: 'task-pinned', status: 'queued' } },
            }));
        });
    });
    const secondRouter = http.createServer((req, res) => {
        secondRouterRequests += 1;
        req.resume();
        req.on('end', () => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'wrong router' }));
        });
    });
    const firstPort = await listen(firstRouter);
    const secondPort = await listen(secondRouter);
    const previousRouterUrl = process.env.PLOINKY_ROUTER_URL;
    t.after(async () => {
        if (previousRouterUrl === undefined) delete process.env.PLOINKY_ROUTER_URL;
        else process.env.PLOINKY_ROUTER_URL = previousRouterUrl;
        await Promise.all([close(firstRouter), close(secondRouter)]);
    });

    process.env.PLOINKY_ROUTER_URL = `http://127.0.0.1:${firstPort}`;
    const client = await createAgentClient('asyncAgent');
    process.env.PLOINKY_ROUTER_URL = `http://127.0.0.1:${secondPort}`;
    const removeObserver = setAgentTaskObserver(async (task) => {
        const status = await task.getTaskStatus();
        assert.equal(status.id, 'task-pinned');
        return { detached: true, id: 'local-pinned', description: 'Pinned task' };
    });
    t.after(removeObserver);

    const result = await client.callToolWithoutWait('execute-task', { prompt: 'pin router' });

    assert.equal(result.metadata.backgroundTask.id, 'local-pinned');
    assert.equal(firstRouterPosts, 1);
    assert.equal(firstRouterGets, 1);
    assert.equal(secondRouterRequests, 0);
});

test('cancelTask sends a request-bound agent assertion through the router', async (t) => {
    let captured = null;
    await withCaptureServer(t, (req, body, res) => {
        captured = { method: req.method, url: req.url, headers: req.headers, body: body.toString('utf8') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ task: { id: 'remote-1', status: 'cancelling' } }));
    });
    const client = await createAgentClient('asyncAgent');
    const task = await client.cancelTask('remote-1');
    assert.equal(task.status, 'cancelling');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/asyncAgent/task/cancel');
    assert.deepEqual(JSON.parse(captured.body), { taskId: 'remote-1' });
    assert.match(captured.headers.authorization, /^Bearer /);
});
