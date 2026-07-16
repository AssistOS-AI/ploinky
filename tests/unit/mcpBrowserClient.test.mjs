import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAgentClient } from '../../Agent/client/MCPBrowserClient.js';

test('MCP browser client forwards configured request headers', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(req.headers['x-test-auth'] || '');
        if (req.method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === 'GET') {
            res.writeHead(405);
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
                    'mcp-protocol-version': '2025-06-18',
                });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: {},
                        serverInfo: { name: 'test', version: '1.0.0' },
                    },
                }));
                return;
            }

            if (body.method === 'notifications/initialized') {
                res.writeHead(204);
                res.end();
                return;
            }

            res.writeHead(500);
            res.end('unexpected request');
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const client = createAgentClient(`http://127.0.0.1:${port}/mcp`, {
            requestHeaders: {
                'x-test-auth': 'router-issued',
            },
        });
        await client.connect();
        await client.close();
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    assert.ok(seen.length >= 2);
    assert.ok(seen.every((value) => value === 'router-issued'));
});

test('MCP browser client treats agent-first MCP routes as router proxy endpoints', async () => {
    const seenMethods = [];
    const server = http.createServer((req, res) => {
        seenMethods.push(req.method);
        if (req.method !== 'POST' && req.method !== 'DELETE') {
            res.writeHead(500);
            res.end('unexpected stream probe');
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
                    'mcp-protocol-version': '2025-06-18',
                });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: {},
                        serverInfo: { name: 'test', version: '1.0.0' },
                    },
                }));
                return;
            }

            if (body.method === 'notifications/initialized') {
                res.writeHead(204);
                res.end();
                return;
            }

            res.writeHead(500);
            res.end('unexpected request');
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const client = createAgentClient(`http://127.0.0.1:${port}/dpuAgent/mcp`);
        await client.connect();
        await client.close();
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    assert.ok(seenMethods.length >= 2);
    assert.equal(seenMethods.includes('GET'), false);
});

test('MCP browser client forwards only a caller-selected enable mode', async () => {
    const requests = [];
    let running = false;
    const server = http.createServer((req, res) => {
        if (req.url !== '/api/marketplace') {
            res.writeHead(404);
            res.end();
            return;
        }
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
            requests.push({ method: req.method, body });
            if (body?.action === 'enable_agent') running = true;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                marketplace: {
                    agents: [{ ref: 'repo/worker', name: 'worker', running, status: running ? 'running' : 'inactive' }],
                },
            }));
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const client = createAgentClient(`http://127.0.0.1:${port}/worker/mcp`);
        const status = await client.ensureAgentRunning('repo/worker', { mode: 'global' });
        assert.equal(status.running, true);
        running = false;
        await client.ensureAgentRunning('repo/worker');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    assert.deepEqual(requests, [
        { method: 'GET', body: null },
        {
            method: 'POST',
            body: { action: 'enable_agent', agentRef: 'repo/worker', mode: 'global' },
        },
        { method: 'GET', body: null },
        {
            method: 'POST',
            body: { action: 'enable_agent', agentRef: 'repo/worker' },
        },
    ]);
});

test('MCP browser client skips enable_agent for an already running agent', async () => {
    const methods = [];
    const server = http.createServer((req, res) => {
        methods.push(req.method);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            marketplace: {
                agents: [{ ref: 'repo/worker', name: 'worker', running: true, status: 'running' }],
            },
        }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const client = createAgentClient(`http://127.0.0.1:${port}/worker/mcp`);
        await client.ensureAgentRunning('repo/worker');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    assert.deepEqual(methods, ['GET']);
});
