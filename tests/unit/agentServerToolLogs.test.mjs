import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { computeRchTool } from '../../Agent/lib/requestHash.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const AGENT_SERVER = path.join(REPO_ROOT, 'Agent/server/AgentServer.mjs');

function cleanEnv() {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if (name.startsWith('PLOINKY_AGENT_') || name.startsWith('PLOINKY_ROUTER_')
            || name.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_')
            || name === 'PLOINKY_INTERNAL_ROUTER_URL' || name === 'PLOINKY_EDGE_TOPOLOGY_FILE') {
            delete env[name];
        }
    }
    return env;
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function startServer(t, { extraEnv = {} } = {}) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tool-logs-'));
    const secret = crypto.randomBytes(32);
    const audience = 'agent:tool-logs-test';
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({ tools: [
        { name: 'okTool', command: process.execPath, args: ['-e', 'console.log("done")'], cwd: tmp },
        { name: 'failTool', command: process.execPath, args: ['-e', 'process.exit(3)'], cwd: tmp },
    ] }));
    const port = await freePort();
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd: tmp,
        env: {
            ...cleanEnv(), HOME: tmp, PORT: String(port), PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_CONFIG: configPath, PLOINKY_AGENT_SECRET: secret.toString('hex'),
            PLOINKY_AGENT_ID: audience, ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => { output += c.toString('utf8'); });
    child.stderr.on('data', (c) => { output += c.toString('utf8'); });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
        }
        await fs.rm(tmp, { recursive: true, force: true });
    });
    const deadline = Date.now() + 5000;
    for (;;) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* retry */ }
        if (Date.now() > deadline) throw new Error(`AgentServer did not start:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { port, secret, audience, output: () => output };
}

async function post(port, body, { sessionId, token } = {}) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId) { headers['mcp-session-id'] = sessionId; headers['mcp-protocol-version'] = '2025-06-18'; }
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { response, text: await response.text() };
}

async function initSession(port) {
    const init = await post(port, {
        jsonrpc: '2.0', id: 'i', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const sessionId = init.response.headers.get('mcp-session-id');
    assert.ok(sessionId, init.text);
    return sessionId;
}

function callTool(server, sessionId, tool, id) {
    const now = Math.floor(Date.now() / 1000);
    const token = signHmacJwt({
        secret: server.secret,
        payload: {
            typ: 'router-request', iss: 'ploinky-router', aud: server.audience, sub: 'user:test',
            actor: { kind: 'user', id: 'user:test', roles: ['user'] }, method: 'POST', path: '/mcp', tool,
            rch: computeRchTool({ method: 'POST', path: '/mcp', tool, arguments: {} }),
            jti: crypto.randomBytes(12).toString('base64url'), iat: now, exp: now + 30,
        },
    });
    return post(server.port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: {} } }, { sessionId, token });
}

async function settle(server, expectedLines) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        if (server.output().split('\n').filter((l) => l.includes('tool=')).length >= expectedLines) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

test('each tool call prints one completion line and no per-call detail lines by default', async (t) => {
    const server = await startServer(t);
    const s1 = await initSession(server.port);
    const s2 = await initSession(server.port);
    await callTool(server, s1, 'okTool', 1);
    await callTool(server, s2, 'failTool', 2);
    await settle(server, 2);
    const out = server.output();
    const lines = out.split('\n');
    const completion = lines.filter((l) => /\[AgentServer\/MCP\] tool=/.test(l));
    assert.equal(completion.length, 2, out);
    assert.match(completion[0], /^\[AgentServer\/MCP\] tool=okTool mode=spawn ms=\d+ outcome=ok$/);
    assert.match(completion[1], /^\[AgentServer\/MCP\] tool=failTool mode=spawn ms=\d+ outcome=error$/);
    assert.equal(lines.filter((l) => /payload:|' args:|' context:/.test(l)).length, 0, out);
    assert.equal(lines.filter((l) => l.includes('Loaded config from') || l.includes('No configuration file found')).length, 1,
        'config load is logged once per process, not once per session');
});

test('PLOINKY_AGENT_TOOL_DEBUG_LOGS=1 restores the detailed per-call lines', async (t) => {
    const server = await startServer(t, { extraEnv: { PLOINKY_AGENT_TOOL_DEBUG_LOGS: '1' } });
    const sessionId = await initSession(server.port);
    await callTool(server, sessionId, 'okTool', 1);
    await settle(server, 1);
    const out = server.output();
    assert.equal(out.split('\n').filter((l) => /\[AgentServer\/MCP\] tool=okTool /.test(l)).length, 1, out);
    assert.match(out, /Tool 'okTool' args:/);
    assert.match(out, /Tool 'okTool' context:/);
    assert.match(out, /Tool 'okTool' payload:/);
});
