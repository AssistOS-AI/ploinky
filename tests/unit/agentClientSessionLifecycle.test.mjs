import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAgentClient } from '../../cli/server/AgentClient.js';

test('the request guard blocks later dispatch after an awaited SDK initialization', async (t) => {
    let held;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const seen = [];
    const server = http.createServer((req, res) => {
        if (req.method === 'DELETE') { seen.push('DELETE'); res.writeHead(204); res.end(); return; }
        if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const message = JSON.parse(Buffer.concat(chunks));
            seen.push(message.method);
            if (message.method === 'initialize') {
                held = () => {
                    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-upstream-session' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
                        protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
                    } }));
                };
                entered();
            } else { res.writeHead(202); res.end(); }
        });
    });
    const port = await listen(server);
    let live = true;
    const client = createAgentClient(`http://127.0.0.1:${port}/mcp`, { beforeDispatch: () => {
        if (!live) throw new Error('browser session ended');
    } });
    t.after(async () => { held?.(); await client.close(); await closeServer(server); });
    const pending = client.listTools();
    await waiting;
    live = false;
    held();
    held = null;
    await assert.rejects(pending, /browser session ended/);
    await client.close();
    assert.equal(seen.includes('tools/list'), false);
    assert.equal(seen.includes('notifications/initialized'), false);
});

async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
}

async function closeServer(server) {
    await new Promise((resolve) => server.close(resolve));
}

test('router AgentClient terminates the upstream MCP session on close', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({
            method: req.method,
            sessionId: req.headers['mcp-session-id'] || null
        });

        if (req.method === 'GET') {
            res.writeHead(405, { Allow: 'POST, DELETE' });
            res.end();
            return;
        }

        if (req.method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
        }

        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            if (body.method === 'initialize') {
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'mcp-session-id': 'session-1',
                    'mcp-protocol-version': '2025-06-18'
                });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'test-agent', version: '1.0.0' }
                    }
                }));
                return;
            }
            if (body.method === 'notifications/initialized') {
                res.writeHead(202);
                res.end();
                return;
            }
            if (body.method === 'tools/list') {
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'mcp-session-id': 'session-1',
                    'mcp-protocol-version': '2025-06-18'
                });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: { tools: [] }
                }));
                return;
            }
            res.writeHead(500);
            res.end('unexpected request');
        });
    });

    const port = await listen(server);
    try {
        const client = createAgentClient(`http://127.0.0.1:${port}/mcp`);
        await client.listTools();
        await client.close();
    } finally {
        await closeServer(server);
    }

    const deleteRequest = seen.find(entry => entry.method === 'DELETE');
    assert.ok(deleteRequest, 'expected close() to send DELETE');
    assert.equal(deleteRequest.sessionId, 'session-1');
});

test('router AgentClient bounds initialization against a non-MCP listener', async () => {
    const server = http.createServer((req) => {
        req.resume();
    });

    const port = await listen(server);
    const startedAt = Date.now();
    try {
        const client = createAgentClient(`http://127.0.0.1:${port}/mcp`, {
            requestTimeoutMs: 50,
        });
        await assert.rejects(client.listTools(), /Request timed out/);
        await client.close();
    } finally {
        await closeServer(server);
    }
    assert.ok(Date.now() - startedAt < 1000, 'initialization timeout must be bounded');
});
