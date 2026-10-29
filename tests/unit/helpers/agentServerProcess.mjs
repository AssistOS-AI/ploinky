// Starts a real AgentServer child process with a given MCP configuration and
// speaks raw MCP JSON-RPC to it. Shared by the task-reference tests.
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { signHmacJwt } from '../../../Agent/lib/jwtSign.mjs';
import { computeRchTool } from '../../../Agent/lib/requestHash.mjs';

const REPO_ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
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

export async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

// `tools(tmp)` returns the configured tool list for the temp directory.
export async function startAgentServer(t, { tools, agentId, secret, extraEnv = {}, expectStart = true }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-taskref-'));
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({ tools: tools(tmp) }));
    const port = await freePort();
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd: tmp,
        env: {
            ...cleanEnv(), HOME: tmp, PORT: String(port), PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_CONFIG: configPath, PLOINKY_AGENT_SECRET: Buffer.from(secret).toString('hex'),
            PLOINKY_AGENT_ID: agentId, AGENT_NAME: agentId, ...extraEnv,
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
    if (expectStart) {
        const deadline = Date.now() + 8000;
        for (;;) {
            try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* retry */ }
            if (Date.now() > deadline) throw new Error(`AgentServer did not start:\n${output}`);
            if (child.exitCode !== null) throw new Error(`AgentServer exited:\n${output}`);
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    return { tmp, port, child, secret, agentId, output: () => output };
}

export async function mcpPost(port, body, { sessionId, headers = {} } = {}) {
    const all = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
    if (sessionId) { all['mcp-session-id'] = sessionId; all['mcp-protocol-version'] = '2025-06-18'; }
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: all, body: JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {
        const line = text.split('\n').find((entry) => entry.startsWith('data: '));
        if (line) json = JSON.parse(line.slice(6));
    }
    return { response, text, json };
}

export async function mcpSession(port) {
    const init = await mcpPost(port, {
        jsonrpc: '2.0', id: 'i', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const sessionId = init.response.headers.get('mcp-session-id');
    if (!sessionId) throw new Error(`no MCP session: ${init.text}`);
    return sessionId;
}

// A Router Request for a direct tools/call, signed with the agent's secret.
export function routerToolToken(server, tool, args, { sub = 'user:test', roles = ['user'] } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return signHmacJwt({
        secret: server.secret,
        payload: {
            typ: 'router-request', iss: 'ploinky-router', aud: server.agentId, sub,
            actor: { kind: 'user', id: sub, roles }, method: 'POST', path: '/mcp', tool,
            rch: computeRchTool({ method: 'POST', path: '/mcp', tool, arguments: args }),
            jti: crypto.randomBytes(12).toString('base64url'), iat: now, exp: now + 30,
        },
    });
}

export async function callTool(server, sessionId, tool, args, { id = 1, extraHeaders = {} } = {}) {
    const token = routerToolToken(server, tool, args);
    return mcpPost(server.port, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } },
        { sessionId, headers: { authorization: `Bearer ${token}`, ...extraHeaders } });
}
