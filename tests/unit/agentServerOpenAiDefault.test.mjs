/**
 * HTTP-level integration tests for AgentServer's OpenAI Chat Completions route.
 *
 * Spawns the real AgentServer process against temporary manifest/config
 * fixtures on an ephemeral port and exercises POST /v1/chat/completions:
 *   - Without endpoints.chatCompletions  -> default capability responder (200).
 *   - default response is OpenAI-compatible and lists MCP tool names.
 *   - stream:true on the default responder -> OpenAI-compatible 400 error.
 *   - With endpoints.chatCompletions      -> configured handler still runs.
 *
 * The server binds a real socket, so these tests use a child process rather
 * than importing the module (AgentServer.mjs runs main() at import time).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.resolve(__dirname, '../../Agent/server/AgentServer.mjs');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

async function waitForHealth(port, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) return true;
        } catch (_) {
            // server not up yet
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

/**
 * Boot an AgentServer child against a fresh temp dir holding the given manifest
 * and mcp-config. Returns { port, stop } where stop() kills the child.
 */
async function startServer({ manifest, mcpConfig, agentId, extraEnv = {} }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsrv-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (mcpConfig) {
        fs.writeFileSync(path.join(dir, 'mcp-config.json'), JSON.stringify(mcpConfig, null, 2));
    }
    const port = await getFreePort();
    const env = {
        ...process.env,
        PORT: String(port),
        PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
        PLOINKY_AGENT_ID: agentId || '',
        // Point the server's manifest + config loaders at our temp fixtures.
        PLOINKY_AGENT_MANIFEST: path.join(dir, 'manifest.json'),
        MCP_CONFIG_FILE: mcpConfig ? path.join(dir, 'mcp-config.json') : '',
        PLOINKY_CODE_DIR: dir,
        ...extraEnv
    };
    const child = spawn(process.execPath, [SERVER_PATH], {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const logs = [];
    child.stdout.on('data', c => logs.push(c.toString()));
    child.stderr.on('data', c => logs.push(c.toString()));
    const healthy = await waitForHealth(port);
    if (!healthy) {
        child.kill('SIGKILL');
        throw new Error(`AgentServer did not become healthy. Logs:\n${logs.join('')}`);
    }
    const stop = () => new Promise(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 1500);
    });
    return { port, stop, dir, logs };
}

const TOOL_CONFIG = {
    tools: [
        { name: 'parseFile', command: '/bin/true', description: 'Parse a file' },
        { name: 'summarize', command: '/bin/true', description: 'Summarize text' }
    ]
};

test('default responder: 200 + OpenAI-compatible body listing tool names', async () => {
    const agentId = 'agent:AssistOSExplorer/llmAssistant';
    const srv = await startServer({
        manifest: { name: 'llmAssistant' },
        mcpConfig: TOOL_CONFIG,
        agentId
    });
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });
        assert.equal(res.status, 200, 'missing endpoints.chatCompletions returns 200');
        const body = await res.json();
        assert.equal(body.object, 'chat.completion');
        assert.ok(body.id.startsWith('chatcmpl-'));
        assert.equal(body.model, agentId, 'model falls back to PLOINKY_AGENT_ID');
        assert.equal(body.choices[0].message.role, 'assistant');
        assert.equal(body.choices[0].finish_reason, 'stop');
        assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        const content = body.choices[0].message.content;
        assert.ok(content.includes(agentId), 'content names the agent');
        assert.ok(content.includes('parseFile') && content.includes('summarize'), 'content lists MCP tool names');
    } finally {
        await srv.stop();
    }
});

test('default responder: stream:true returns OpenAI-compatible 400 error', async () => {
    const srv = await startServer({
        manifest: { name: 'llmAssistant' },
        mcpConfig: TOOL_CONFIG,
        agentId: 'agent:AssistOSExplorer/llmAssistant'
    });
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stream: true, messages: [] })
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error.type, 'invalid_request_error');
        assert.ok(/stream/i.test(body.error.message), 'error message references streaming');
    } finally {
        await srv.stop();
    }
});

test('configured endpoints.chatCompletions handler still executes', async () => {
    // A tiny handler script that ignores stdin and emits a sentinel completion.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsrv-handler-'));
    const handlerPath = path.join(dir, 'chat-handler.mjs');
    fs.writeFileSync(handlerPath,
        'let raw = "";\n'
        + 'process.stdin.on("data", c => { raw += c; });\n'
        + 'process.stdin.on("end", () => {\n'
        + '    process.stdout.write(JSON.stringify({\n'
        + '        id: "chatcmpl-configured",\n'
        + '        object: "chat.completion",\n'
        + '        choices: [{ index: 0, message: { role: "assistant", content: "CONFIGURED_HANDLER_RAN" }, finish_reason: "stop" }]\n'
        + '    }));\n'
        + '});\n'
    );
    const srv = await startServer({
        manifest: {
            name: 'configuredAgent',
            endpoints: {
                chatCompletions: { command: process.execPath, args: [handlerPath] }
            }
        },
        agentId: 'agent:Workspace/configuredAgent'
    });
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.id, 'chatcmpl-configured', 'configured handler response is returned');
        assert.equal(body.choices[0].message.content, 'CONFIGURED_HANDLER_RAN');
    } finally {
        await srv.stop();
    }
});
