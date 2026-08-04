import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAgentClient } from '../../cli/server/AgentClient.js';
import { createRootAgentDialContext } from '../../cli/server/rootAgentDial.js';

function dialContextFor(port, commit) {
    return createRootAgentDialContext({
        routePlan: { lease: { snapshot: { agents: {} }, commit } },
        route: { hostPort: port },
        targetPort: port,
    });
}

async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
}

async function closeServer(server) {
    await new Promise((resolve) => server.close(resolve));
}

test('router AgentClient terminates the upstream MCP session on close', async () => {
    const seen = [];
    let socketGuards = 0;
    let serverConnections = 0;
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
    server.on('connection', () => {
        serverConnections += 1;
    });

    const port = await listen(server);
    try {
        const client = createAgentClient(`http://127.0.0.1:${port}/mcp`, {
            dialContext: dialContextFor(port, () => {
                    socketGuards += 1;
                    return true;
                }),
        });
        await client.listTools();
        await client.close();
    } finally {
        await closeServer(server);
    }

    const deleteRequest = seen.find(entry => entry.method === 'DELETE');
    assert.ok(deleteRequest, 'expected close() to send DELETE');
    assert.equal(deleteRequest.sessionId, 'session-1');
    assert.equal(socketGuards, serverConnections, 'every SDK kernel connection must run the socket guard');
    assert.ok(socketGuards >= 2, 'the SDK lifecycle must exercise multiple independently guarded sockets');
});

test('router AgentClient keeps MCP requests live while the SSE socket remains open', async () => {
    const seen = [];
    const openStreams = new Set();
    let socketGuards = 0;
    let serverConnections = 0;
    const server = http.createServer((req, res) => {
        seen.push(req.method);
        if (req.method === 'GET') {
            openStreams.add(res);
            res.once('close', () => openStreams.delete(res));
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                'mcp-session-id': 'session-sse',
                'mcp-protocol-version': '2025-06-18',
            });
            res.write(': connected\n\n');
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
                    'mcp-session-id': 'session-sse',
                    'mcp-protocol-version': '2025-06-18',
                });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'sse-agent', version: '1.0.0' },
                    },
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
                    'mcp-session-id': 'session-sse',
                    'mcp-protocol-version': '2025-06-18',
                });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        tools: [{ name: 'live_during_sse', inputSchema: { type: 'object' } }],
                    },
                }));
                return;
            }
            res.writeHead(500);
            res.end('unexpected request');
        });
    });
    server.on('connection', () => {
        serverConnections += 1;
    });

    const port = await listen(server);
    let client;
    try {
        client = createAgentClient(`http://127.0.0.1:${port}/mcp`, {
            requestTimeoutMs: 500,
            dialContext: dialContextFor(port, () => {
                socketGuards += 1;
                return true;
            }),
        });
        await client.connect();
        for (let attempt = 0; attempt < 50 && !seen.includes('GET'); attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.ok(seen.includes('GET'), 'expected the transport to hold an SSE request open');
        const tools = await client.listTools();
        assert.deepEqual(tools.map(tool => tool.name), ['live_during_sse']);
        await Promise.race([
            client.close(),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('MCP close deadlocked behind the SSE socket')),
                500,
            )),
        ]);
        client = null;
        assert.ok(seen.includes('DELETE'), 'expected close() to terminate the upstream MCP session');
    } finally {
        for (const stream of openStreams) stream.destroy();
        await client?.close().catch(() => {});
        await closeServer(server);
    }
    assert.equal(socketGuards, serverConnections, 'every SSE and request socket must run the guard');
    assert.ok(socketGuards >= 2, 'SSE and MCP requests must use independently guarded sockets');
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
            dialContext: dialContextFor(port, () => true),
        });
        await assert.rejects(client.listTools(), /Request timed out/);
        await client.close();
    } finally {
        await closeServer(server);
    }
    assert.ok(Date.now() - startedAt < 1000, 'initialization timeout must be bounded');
});
