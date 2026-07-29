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

test('browser agent-first MCP mutations use an exact route-scoped proof', async () => {
    const originalWindow = globalThis.window;
    const seen = [];
    const server = http.createServer((req, res) => {
        const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
        if (req.method === 'GET' && requestUrl.pathname === '/auth/token') {
            seen.push({
                method: req.method,
                path: requestUrl.pathname,
                agent: requestUrl.searchParams.get('agent'),
                mutationRoute: requestUrl.searchParams.get('mutationRoute'),
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                browserMutation: {
                    origin: `http://${req.headers.host}`,
                    csrfToken: 'v1.route-scoped-proof',
                    generation: 'generation-1',
                    routeKey: 'dpuAgent',
                },
            }));
            return;
        }
        if (req.method === 'DELETE') {
            seen.push({
                method: req.method,
                path: requestUrl.pathname,
                csrf: req.headers['x-ploinky-browser-csrf-token'],
            });
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(500);
            res.end('unexpected request');
            return;
        }
        seen.push({
            method: req.method,
            path: requestUrl.pathname,
            csrf: req.headers['x-ploinky-browser-csrf-token'],
        });
        if (req.headers['x-ploinky-browser-csrf-token'] !== 'v1.route-scoped-proof') {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'browser_csrf_invalid' }));
            return;
        }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            if (body.method === 'initialize') {
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'mcp-session-id': 'session-browser-proof',
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
        globalThis.window = {
            location: {
                href: `http://127.0.0.1:${port}/dpuAgent/index.html`,
                origin: `http://127.0.0.1:${port}`,
            },
        };
        const client = createAgentClient(`http://127.0.0.1:${port}/dpuAgent/mcp`);
        await client.connect();
        await client.close();
    } finally {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
        await new Promise((resolve) => server.close(resolve));
    }

    assert.deepEqual(seen[0], {
        method: 'GET',
        path: '/auth/token',
        agent: null,
        mutationRoute: 'dpuAgent',
    });
    assert.ok(seen.filter((entry) => entry.method === 'POST').length >= 2);
    assert.ok(seen.filter((entry) => entry.method !== 'GET')
        .every((entry) => entry.csrf === 'v1.route-scoped-proof'));
});

test('MCP browser client can close while its aggregate SSE probe is pending', async () => {
    let resolveStreamProbe;
    const streamProbeStarted = new Promise((resolve) => {
        resolveStreamProbe = resolve;
    });
    const server = http.createServer((req, res) => {
        if (req.method === 'GET') {
            resolveStreamProbe();
            req.on('close', () => {
                if (!res.writableEnded) res.end();
            });
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
                    'mcp-session-id': 'session-aggregate',
                });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: {},
                        serverInfo: { name: 'aggregate', version: '1.0.0' },
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
        const client = createAgentClient(`http://127.0.0.1:${port}/mcp`);
        await Promise.all([client.connect(), streamProbeStarted]);
        await client.close();
        await new Promise((resolve) => setImmediate(resolve));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
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

test('MCP browser client binds a tool call to the caller-selected Router agent', async () => {
    let toolCall = null;
    const server = http.createServer((req, res) => {
        if (req.method === 'GET') {
            res.writeHead(405);
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
            const headers = {
                'content-type': 'application/json',
                'mcp-session-id': 'session-agent-binding',
            };
            if (body.method === 'initialize') {
                res.writeHead(200, headers);
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'router', version: '1.0.0' },
                    },
                }));
                return;
            }
            if (body.method === 'notifications/initialized') {
                res.writeHead(204);
                res.end();
                return;
            }
            if (body.method === 'tools/call') {
                toolCall = body.params;
                res.writeHead(200, headers);
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: { content: [{ type: 'text', text: 'ok' }] },
                }));
                return;
            }
            res.writeHead(500);
            res.end('unexpected request');
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const client = createAgentClient(`http://127.0.0.1:${port}/mcp`);
        await client.callTool('run_simulation', { iterations: 10 }, { agent: 'simulator' });
        await client.close();
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    assert.equal(toolCall?._meta?.router?.agent, 'simulator');
});

test('MCP browser client forwards configured authentication while polling an async task', async () => {
    const taskPollHeaders = [];
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url?.startsWith('/demo/task?')) {
            taskPollHeaders.push(req.headers['x-test-auth'] || '');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                task: {
                    id: 'task-1',
                    toolName: 'demo_async_task',
                    status: 'completed',
                    createdAt: '2026-07-27T00:00:00.000Z',
                    updatedAt: '2026-07-27T00:00:01.000Z',
                    result: {
                        content: [{ type: 'text', text: 'Task completed' }],
                        metadata: {},
                    },
                },
            }));
            return;
        }
        if (req.method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(500);
            res.end('unexpected request');
            return;
        }

        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const headers = {
                'content-type': 'application/json',
                'mcp-session-id': 'session-async-task',
            };
            if (body.method === 'initialize') {
                res.writeHead(200, headers);
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'router', version: '1.0.0' },
                    },
                }));
                return;
            }
            if (body.method === 'notifications/initialized') {
                res.writeHead(204);
                res.end();
                return;
            }
            if (body.method === 'tools/call') {
                res.writeHead(200, headers);
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: {
                        content: [{ type: 'text', text: 'Task queued' }],
                        metadata: {
                            taskId: 'task-1',
                            agent: 'demo',
                            status: 'queued',
                        },
                    },
                }));
                return;
            }
            res.writeHead(500);
            res.end('unexpected request');
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const client = createAgentClient(`http://127.0.0.1:${port}/demo/mcp`, {
            requestHeaders: {
                'x-test-auth': 'router-issued',
            },
        });
        const result = await client.callTool('demo_async_task', {}, { agent: 'demo' });
        assert.equal(result.content[0].text, 'Task completed');
        await client.close();
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    assert.deepEqual(taskPollHeaders, ['router-issued']);
});
