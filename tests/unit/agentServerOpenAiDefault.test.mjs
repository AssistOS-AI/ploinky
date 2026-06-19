/**
 * HTTP-level integration tests for AgentServer's OpenAI Chat Completions route.
 *
 * Spawns the real AgentServer process against temporary manifest/config
 * fixtures on an ephemeral port and exercises POST /v1/chat/completions:
 *   - chatCompletions.model:"none" (opt-out) -> inert capability responder (200).
 *   - that inert response is OpenAI-compatible and lists MCP tool names.
 *   - stream:true on the inert responder -> OpenAI-compatible 400 error.
 *   - With endpoints.chatCompletions.command -> configured handler still runs.
 *
 * NOTE: as of the agentic-default-responder change, an agent with NO
 * endpoints.chatCompletions now routes to the LLM agentic responder (not the
 * inert listing); the inert path is reached via model:"none"/"off". The agentic
 * default path is covered at the unit level in tests/unit/openAiChatConfig.test.mjs.
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
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.resolve(__dirname, '../../Agent/server/AgentServer.mjs');

const OPENAI_PATH = '/v1/chat/completions';
const OPENAI_TOOL = '__openai_chat_completions__';

// Master key shared by the parent (token signer) and the spawned AgentServer
// child (token verifier). Set in the parent BEFORE deriveAgentRequestSecret is
// imported/called, and passed to the child via env.
const ROUTER_OPENAI_MASTER_KEY = 'd'.repeat(64);
process.env.PLOINKY_MASTER_KEY = process.env.PLOINKY_MASTER_KEY || ROUTER_OPENAI_MASTER_KEY;

// Import the REAL per-agent secret derivation so the token we sign here is one
// the AgentServer (running with the same master key) accepts. Other suites
// (httpServiceInvocation) import this router service the same way.
const { deriveAgentRequestSecret } = await import('../../cli/services/masterKey.js');

function buildRouterRequestAuthInfo({ agentId, body, overrides = {} }) {
    const secret = deriveAgentRequestSecret(agentId, { encoding: 'buffer' });
    const now = Math.floor(Date.now() / 1000);
    const bodyHash = sha256RawBodyHash(body);
    const rch = computeRchHttp({ method: 'POST', path: OPENAI_PATH, query: '', bodyHash });
    const payload = {
        typ: 'router-request',
        iss: 'ploinky-router',
        aud: agentId,
        sub: 'agent:AssistOSExplorer/soulGateway',
        actor: { kind: 'agent', id: 'agent:AssistOSExplorer/soulGateway', roles: [] },
        method: 'POST',
        path: OPENAI_PATH,
        tool: OPENAI_TOOL,
        rch,
        jti: crypto.randomBytes(12).toString('base64url'),
        iat: now,
        exp: now + 30,
        ...overrides,
    };
    const token = signHmacJwt({ payload, secret });
    return JSON.stringify({
        invocationToken: token,
        invocationBody: { method: 'POST', path: OPENAI_PATH, search: '', routeKey: 'llmAssistant', bodyHash },
    });
}

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

test('opt-out (model:none) responder: 200 + OpenAI-compatible body listing tool names', async () => {
    const agentId = 'agent:AssistOSExplorer/llmAssistant';
    const srv = await startServer({
        // model:"none" opts out of the agentic LLM default and keeps the inert
        // capability/listability responder.
        manifest: { name: 'llmAssistant', endpoints: { chatCompletions: { model: 'none' } } },
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

test('opt-out (model:none) responder: stream:true returns OpenAI-compatible 400 error', async () => {
    const srv = await startServer({
        manifest: { name: 'llmAssistant', endpoints: { chatCompletions: { model: 'none' } } },
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

// A configured handler that records execution by appending to a marker file, so a
// rejected request can be proven to NEVER reach the handler.
function writeMarkerHandler(dir) {
    const handlerPath = path.join(dir, 'marker-handler.mjs');
    const markerPath = path.join(dir, 'handler-ran.marker');
    fs.writeFileSync(handlerPath,
        'import fs from "node:fs";\n'
        + `fs.appendFileSync(${JSON.stringify(markerPath)}, "ran\\n");\n`
        + 'let raw = "";\n'
        + 'process.stdin.on("data", c => { raw += c; });\n'
        + 'process.stdin.on("end", () => {\n'
        + '    process.stdout.write(JSON.stringify({\n'
        + '        id: "chatcmpl-marker",\n'
        + '        object: "chat.completion",\n'
        + '        choices: [{ index: 0, message: { role: "assistant", content: "MARKER_HANDLER_RAN" }, finish_reason: "stop" }]\n'
        + '    }));\n'
        + '});\n'
    );
    return { handlerPath, markerPath };
}

test('router-minted OpenAI token: valid token is accepted and the handler runs', async () => {
    const agentId = 'agent:AssistOSExplorer/llmAssistant';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsrv-openai-ok-'));
    const { handlerPath, markerPath } = writeMarkerHandler(dir);
    const srv = await startServer({
        manifest: {
            name: 'llmAssistant',
            endpoints: { chatCompletions: { command: process.execPath, args: [handlerPath] } },
        },
        agentId,
        extraEnv: {
            PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
            PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(agentId),
        },
    });
    try {
        const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
        const res = await fetch(`http://127.0.0.1:${srv.port}${OPENAI_PATH}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-ploinky-auth-info': buildRouterRequestAuthInfo({ agentId, body }),
            },
            body,
        });
        const text = await res.text();
        assert.equal(res.status, 200, text);
        const json = JSON.parse(text);
        assert.equal(json.id, 'chatcmpl-marker');
        assert.equal(json.choices[0].message.content, 'MARKER_HANDLER_RAN');
        assert.equal(fs.existsSync(markerPath), true, 'handler must have run for a valid token');
    } finally {
        await srv.stop();
    }
});

test('router-minted OpenAI token: forged/tampered token is 401 and the handler does NOT run', async () => {
    const agentId = 'agent:AssistOSExplorer/llmAssistant';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsrv-openai-bad-'));
    const { handlerPath, markerPath } = writeMarkerHandler(dir);
    const srv = await startServer({
        manifest: {
            name: 'llmAssistant',
            endpoints: { chatCompletions: { command: process.execPath, args: [handlerPath] } },
        },
        agentId,
        extraEnv: {
            PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
            PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(agentId),
        },
    });
    try {
        const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
        // (a) A token signed with the WRONG secret (forged) is rejected.
        const forgedSecret = crypto.randomBytes(32);
        const now = Math.floor(Date.now() / 1000);
        const bodyHash = sha256RawBodyHash(body);
        const rch = computeRchHttp({ method: 'POST', path: OPENAI_PATH, query: '', bodyHash });
        const forgedToken = signHmacJwt({
            payload: {
                typ: 'router-request', iss: 'ploinky-router', aud: agentId,
                sub: 'agent:AssistOSExplorer/soulGateway',
                actor: { kind: 'agent', id: 'agent:AssistOSExplorer/soulGateway', roles: [] },
                method: 'POST', path: OPENAI_PATH, tool: OPENAI_TOOL, rch,
                jti: crypto.randomBytes(12).toString('base64url'), iat: now, exp: now + 30,
            },
            secret: forgedSecret,
        });
        const forgedHeader = JSON.stringify({
            invocationToken: forgedToken,
            invocationBody: { method: 'POST', path: OPENAI_PATH, search: '', routeKey: 'llmAssistant', bodyHash },
        });
        const forgedRes = await fetch(`http://127.0.0.1:${srv.port}${OPENAI_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-ploinky-auth-info': forgedHeader },
            body,
        });
        assert.equal(forgedRes.status, 401, 'forged token must be rejected');

        // (b) A VALID token, but the body is changed after signing -> body-hash mismatch -> 401.
        const validHeaderForOriginalBody = buildRouterRequestAuthInfo({ agentId, body });
        const tamperedRes = await fetch(`http://127.0.0.1:${srv.port}${OPENAI_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-ploinky-auth-info': validHeaderForOriginalBody },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'TAMPERED' }] }),
        });
        assert.equal(tamperedRes.status, 401, 'body changed after signing must be rejected');

        assert.equal(fs.existsSync(markerPath), false, 'handler must NOT run for any rejected token');
    } finally {
        await srv.stop();
    }
});
