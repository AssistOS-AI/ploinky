import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { computeRchTool } from '../../Agent/lib/requestHash.mjs';
import { createAgentServerContainerEnvironment } from '../helpers/agentServerCredentialRuntime.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const AGENT_SERVER = path.join(REPO_ROOT, 'Agent/server/AgentServer.mjs');
const credentialWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-server-credential-workspace-'));
const agentServersByTempDir = new Map();

test.after(async () => {
    await fs.rm(credentialWorkspace, { recursive: true, force: true });
});

function isolatedAgentServerEnv() {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if (name.startsWith('PLOINKY_AGENT_')
            || name.startsWith('PLOINKY_ROUTER_')
            || name.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_')
            || name === 'PLOINKY_INTERNAL_ROUTER_URL'
            || name === 'PLOINKY_EDGE_TOPOLOGY_FILE') {
            delete env[name];
        }
    }
    return env;
}

async function createTempDir(t) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-server-session-'));
    agentServersByTempDir.set(tmp, new Set());
    t.after(async () => {
        const children = agentServersByTempDir.get(tmp) || [];
        for (const child of children) {
            await terminateExactChild(child);
        }
        agentServersByTempDir.delete(tmp);
        await fs.rm(tmp, { recursive: true, force: true });
    });
    return tmp;
}

function waitForExactChildExit(child, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (exited) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.off('exit', onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        child.once('exit', onExit);

        // Close the gap between the initial state check and listener registration.
        if (child.exitCode !== null || child.signalCode !== null) {
            finish(true);
        }
    });
}

async function terminateExactChild(child) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;

    child.kill('SIGTERM');
    if (await waitForExactChildExit(child, 1000)) return;

    child.kill('SIGKILL');
    if (!await waitForExactChildExit(child, 2000)) {
        throw new Error(`AgentServer child ${child.pid} did not exit after SIGKILL`);
    }
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

async function startAgentServer(t, {
    tmp,
    configPath,
    env = {},
    agentPrincipal = 'agent:test/agent-server',
    agentSecret = 'a'.repeat(64),
}) {
    const port = await getFreePort();
    const credentialEnv = await createAgentServerContainerEnvironment({
        tempDir: credentialWorkspace,
        agentPrincipal,
        agentSecret,
    });
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd: tmp,
        env: {
            ...isolatedAgentServerEnv(),
            ...env,
            ...credentialEnv,
            PORT: String(port),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_CONFIG: configPath,
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
    const trackedChildren = agentServersByTempDir.get(tmp);
    assert.ok(trackedChildren, `AgentServer temp directory is not registered for teardown: ${tmp}`);
    trackedChildren.add(child);

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

function mintRouterRequest({ secret, audience, tool, args = {}, method = 'POST', reqPath = '/mcp' }) {
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method, path: reqPath, tool, arguments: args });
    return signHmacJwt({
        secret,
        payload: {
            typ: 'router-request',
            iss: 'ploinky-router',
            aud: audience,
            sub: 'user:test',
            actor: { kind: 'user', id: 'user:test', roles: ['user'] },
            method,
            path: reqPath,
            tool,
            rch,
            jti: crypto.randomBytes(12).toString('base64url'),
            iat: now,
            exp: now + 30
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

test('AgentServer serves static files from the agent code directory', async (t) => {
    const tmp = await createTempDir(t);
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({ tools: [] }));
    await fs.mkdir(path.join(tmp, 'assets'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'index.html'), '<!doctype html><title>Agent App</title>');
    await fs.writeFile(path.join(tmp, 'assets', 'app.css'), 'body { color: black; }');

    const { port } = await startAgentServer(t, {
        tmp,
        configPath,
        env: { PLOINKY_CODE_DIR: tmp }
    });

    const index = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') || '', /text\/html/);
    assert.match(await index.text(), /Agent App/);

    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.css`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') || '', /text\/css/);
    assert.match(await asset.text(), /color: black/);
});

test('AgentServer rejects static path traversal', async (t) => {
    const tmp = await createTempDir(t);
    const outside = await createTempDir(t);
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({ tools: [] }));
    await fs.writeFile(path.join(tmp, 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');

    const { port } = await startAgentServer(t, {
        tmp,
        configPath,
        env: { PLOINKY_CODE_DIR: tmp }
    });

    const response = await fetch(`http://127.0.0.1:${port}/..%2F${path.basename(outside)}%2Fsecret.txt`);
    assert.equal(response.status, 404);
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
    const audience = 'agent:test/test-agent';
    const { port } = await startAgentServer(t, {
        tmp,
        configPath,
        env: {
            MCP_SESSION_IDLE_TIMEOUT_MS: '100',
            MCP_SESSION_GC_INTERVAL_MS: '25',
        },
        agentPrincipal: audience,
        agentSecret: secret.toString('hex'),
    });

    const sessionId = await initializeSession(port);
    await mcpPost(port, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    }, { sessionId });

    const token = mintRouterRequest({ secret, audience, tool: 'slow', args: {} });
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

test('AgentServer cancels an asynchronous task only with a matching Router Request', async (t) => {
    const tmp = await createTempDir(t);
    const slowScript = path.join(tmp, 'slow-async-tool.mjs');
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(slowScript, [
        "import { setTimeout as sleep } from 'node:timers/promises';",
        "await sleep(10_000);",
        "console.log('unexpected-completion');"
    ].join('\n'));
    await fs.writeFile(configPath, JSON.stringify({
        tools: [{
            name: 'slow-async',
            command: process.execPath,
            args: [slowScript],
            inputSchema: {},
            async: true
        }]
    }, null, 2));

    const secret = crypto.randomBytes(32);
    const audience = 'agent:test/test-agent';
    const { port } = await startAgentServer(t, {
        tmp,
        configPath,
        agentPrincipal: audience,
        agentSecret: secret.toString('hex'),
    });
    const sessionId = await initializeSession(port);
    await mcpPost(port, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    }, { sessionId });

    const call = await mcpPost(port, {
        jsonrpc: '2.0',
        id: 'call-slow-async',
        method: 'tools/call',
        params: { name: 'slow-async', arguments: {} }
    }, {
        sessionId,
        authorization: `Bearer ${mintRouterRequest({
            secret,
            audience,
            tool: 'slow-async',
            args: {}
        })}`
    });
    assert.equal(call.status, 200, call.text);
    const taskId = call.json?.result?.metadata?.taskId;
    assert.ok(taskId, call.text);

    const body = JSON.stringify({ taskId });
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/task/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
    });
    assert.equal(unauthenticated.status, 401);

    const token = mintRouterRequest({
        secret,
        audience,
        tool: '__task_cancel__',
        args: { taskId },
        reqPath: '/task/cancel'
    });
    const cancelled = await fetch(`http://127.0.0.1:${port}/task/cancel`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
        },
        body
    });
    const cancelledText = await cancelled.text();
    assert.equal(cancelled.status, 200, cancelledText);
    const payload = JSON.parse(cancelledText);
    assert.match(payload.task?.status || '', /^(cancelling|cancelled)$/);
});
