import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { signHmacJwt, bodyHashForRequest } from '../../Agent/lib/jwtSign.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const AGENT_SERVER = path.join(REPO_ROOT, 'Agent/server/AgentServer.mjs');

async function createTempDir(t) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-server-session-'));
    t.after(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });
    return tmp;
}

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function waitForHealth(port, output) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) return;
        } catch {
            // Retry until the subprocess starts listening.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`AgentServer did not become healthy:\n${output()}`);
}

async function startAgentServer(t, { tmp, configPath, env = {} }) {
    const port = await getFreePort();
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd: tmp,
        env: {
            ...process.env,
            PORT: String(port),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_CONFIG: configPath,
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });

    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await Promise.race([
                once(child, 'exit'),
                new Promise((resolve) => setTimeout(resolve, 1000))
            ]);
        }
    });

    await waitForHealth(port, () => output);
    return { port, output: () => output };
}

async function mcpPost(port, body, options = {}) {
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
    };
    if (options.sessionId) {
        headers['mcp-session-id'] = options.sessionId;
        headers['mcp-protocol-version'] = '2025-06-18';
    }
    if (options.authorization) {
        headers.authorization = options.authorization;
    }
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // Keep the raw text for assertion diagnostics.
    }
    return { response, status: response.status, headers: response.headers, text, json };
}

async function initializeSession(port) {
    const init = await mcpPost(port, {
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'session-test', version: '1.0.0' }
        }
    });
    assert.equal(init.status, 200, init.text);
    const sessionId = init.headers.get('mcp-session-id');
    assert.ok(sessionId, 'expected mcp-session-id header');
    return sessionId;
}

function mintInvocation({ secret, audience, tool, args = {} }) {
    const now = Math.floor(Date.now() / 1000);
    const bodyObject = { tool, arguments: args };
    return signHmacJwt({
        secret,
        payload: {
            typ: 'invocation',
            iss: 'ploinky-router',
            aud: audience,
            sub: 'user:test',
            caller: 'router:first-party',
            tool,
            scope: [],
            bh: bodyHashForRequest(bodyObject),
            usr: { id: 'test', username: 'test', roles: ['local'] },
            jti: crypto.randomBytes(12).toString('base64url'),
            iat: now,
            exp: now + 60
        }
    });
}

test('AgentServer routes DELETE /mcp to the active SDK transport', async (t) => {
    const tmp = await createTempDir(t);
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    const { port } = await startAgentServer(t, { tmp, configPath });

    const sessionId = await initializeSession(port);
    const deleted = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'DELETE',
        headers: {
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-06-18'
        }
    });
    assert.equal(deleted.status, 200);

    const afterDelete = await mcpPost(port, {
        jsonrpc: '2.0',
        id: 'tools-after-delete',
        method: 'tools/list',
        params: {}
    }, { sessionId });
    assert.equal(afterDelete.status, 400);
    assert.match(afterDelete.text, /Missing session/);
});

test('AgentServer idle GC reaps sessions that are not explicitly deleted', async (t) => {
    const tmp = await createTempDir(t);
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    const { port } = await startAgentServer(t, {
        tmp,
        configPath,
        env: {
            MCP_SESSION_IDLE_TIMEOUT_MS: '75',
            MCP_SESSION_GC_INTERVAL_MS: '25'
        }
    });

    const sessionId = await initializeSession(port);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const afterIdle = await mcpPost(port, {
        jsonrpc: '2.0',
        id: 'tools-after-idle',
        method: 'tools/list',
        params: {}
    }, { sessionId });
    assert.equal(afterIdle.status, 400);
    assert.match(afterIdle.text, /Missing session/);
});

test('AgentServer idle GC does not close a session while a tool response is in flight', async (t) => {
    const tmp = await createTempDir(t);
    const slowScript = path.join(tmp, 'slow-tool.mjs');
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(slowScript, [
        "import { setTimeout as sleep } from 'node:timers/promises';",
        "await sleep(Number(process.argv[2] || 350));",
        "console.log('slow-ok');"
    ].join('\n'));
    await fs.writeFile(configPath, JSON.stringify({
        tools: [{
            name: 'slow',
            command: process.execPath,
            args: [slowScript, '350'],
            inputSchema: {}
        }]
    }, null, 2));

    const secret = crypto.randomBytes(32);
    const audience = 'agent:test-agent';
    const { port } = await startAgentServer(t, {
        tmp,
        configPath,
        env: {
            MCP_SESSION_IDLE_TIMEOUT_MS: '100',
            MCP_SESSION_GC_INTERVAL_MS: '25',
            PLOINKY_DERIVED_MASTER_KEY: secret.toString('hex'),
            PLOINKY_AGENT_PRINCIPAL: audience
        }
    });

    const sessionId = await initializeSession(port);
    await mcpPost(port, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    }, { sessionId });

    const token = mintInvocation({ secret, audience, tool: 'slow', args: {} });
    const call = await mcpPost(port, {
        jsonrpc: '2.0',
        id: 'call-slow',
        method: 'tools/call',
        params: { name: 'slow', arguments: {} }
    }, {
        sessionId,
        authorization: `Bearer ${token}`
    });
    assert.equal(call.status, 200, call.text);
    assert.equal(call.json?.error, undefined, call.text);
    assert.match(call.json?.result?.content?.[0]?.text || '', /slow-ok/);

    const stillAlive = await mcpPost(port, {
        jsonrpc: '2.0',
        id: 'tools-after-slow-call',
        method: 'tools/list',
        params: {}
    }, { sessionId });
    assert.equal(stillAlive.status, 200, stillAlive.text);
    assert.equal(stillAlive.json?.error, undefined, stillAlive.text);
});
