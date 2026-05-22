import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAgentClient } from '../../cli/server/AgentClient.js';

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
