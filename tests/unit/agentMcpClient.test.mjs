import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-client-'));
const originalCwd = process.cwd();
const originalRouterUrl = process.env.PLOINKY_ROUTER_URL;
const originalAgentId = process.env.PLOINKY_AGENT_ID;
const originalAgentSecret = process.env.PLOINKY_AGENT_SECRET;

process.chdir(tempDir);
process.env.PLOINKY_AGENT_ID = 'agent:AssistOSExplorer/onlyOffice';
process.env.PLOINKY_AGENT_SECRET = 'a'.repeat(64);

const { createAgentClient } = await import('../../Agent/client/AgentMcpClient.mjs');

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
    if (originalAgentId === undefined) delete process.env.PLOINKY_AGENT_ID;
    else process.env.PLOINKY_AGENT_ID = originalAgentId;
    if (originalAgentSecret === undefined) delete process.env.PLOINKY_AGENT_SECRET;
    else process.env.PLOINKY_AGENT_SECRET = originalAgentSecret;
});

async function withCaptureServer(t, onRequest) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => onRequest(req, Buffer.concat(chunks), res));
    });
    const port = await listen(server);
    process.env.PLOINKY_ROUTER_URL = `http://127.0.0.1:${port}`;
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
