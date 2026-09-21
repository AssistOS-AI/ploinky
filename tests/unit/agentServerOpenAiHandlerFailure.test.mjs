/**
 * tests/unit/agentServerOpenAiHandlerFailure.test.mjs
 *
 * Spawns the real AgentServer against temporary manifests whose
 * `endpoints.chatCompletions` command handler fails in different ways, and
 * checks how each failure reaches the HTTP caller:
 *
 *   - a failure envelope may choose the HTTP status, error type and Retry-After;
 *   - without an envelope, or with a malformed one, the default stays 500;
 *   - a streamed failure carries the same information inside the SSE error
 *     frame, because HTTP 200 is committed before the handler starts;
 *   - a handler that dies after partial output is reported, not passed off as
 *     a completed answer;
 *   - a stream the handler terminated itself is left alone, whatever the exit
 *     code, and an ordinary structured log line is never taken for an envelope.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, '../../Agent/server/AgentServer.mjs');
const OPENAI_PATH = '/v1/chat/completions';

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

// Every handler reads the request from stdin first, as AgentServer's contract
// requires, and only then fails.
const HANDLER_PRELUDE = 'let raw = "";\n'
    + 'process.stdin.on("data", c => { raw += c; });\n'
    + 'process.stdin.on("end", () => {\n'
    + '    const stream = JSON.parse(raw).request.stream === true;\n';

const ENVELOPE = '{"ok":false,"error":"rate_limited","message":"busy","status":429,"type":"rate_limit_error","retryAfter":6.2}';

const HANDLERS = {
    // Buffered: envelope on stdout. Streamed: stdout belongs to the events, so
    // the envelope is the last line of stderr, after ordinary diagnostics.
    envelope: `${HANDLER_PRELUDE}`
        + `    if (stream) { process.stderr.write("diagnostic line\\n" + ${JSON.stringify(ENVELOPE)} + "\\n"); }\n`
        + `    else { process.stdout.write(${JSON.stringify(ENVELOPE)}); }\n`
        + '    process.exitCode = 3;\n});\n',
    plain: `${HANDLER_PRELUDE}    process.stderr.write("boom\\n");\n    process.exitCode = 2;\n});\n`,
    badStatus: `${HANDLER_PRELUDE}`
        + '    process.stdout.write(JSON.stringify({ ok: false, error: "odd", status: 200, type: "Not A Type", retryAfter: -1 }));\n'
        + '    process.exitCode = 1;\n});\n',
    // Writes half an event (no terminating blank line) and then dies.
    partialThenDie: `${HANDLER_PRELUDE}`
        + '    process.stdout.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] }));\n'
        + '    process.stderr.write("died mid-answer\\n");\n'
        + '    process.exitCode = 1;\n});\n',
    // Finishes its stream, terminator included, and only then fails.
    completeThenFail: `${HANDLER_PRELUDE}`
        + '    process.stdout.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "full answer" }, finish_reason: "stop" }] }) + "\\n\\ndata: [DONE]\\n\\n");\n'
        + '    process.stderr.write("cleanup hook failed\\n");\n'
        + '    process.exitCode = 1;\n});\n',
    // Its last stderr line is JSON with a string `error` and a `status`, as a
    // structured logger writes it. It has no `"ok": false`, so it is not an envelope.
    jsonLogLine: `${HANDLER_PRELUDE}`
        + '    process.stderr.write("starting handler\\n" + JSON.stringify({ level: "error", error: "ECONNRESET", status: 503, msg: "upstream retry" }) + "\\n");\n'
        + '    process.exitCode = 1;\n});\n',
};

const JSON_LOG_STDERR = 'starting handler\n{"level":"error","error":"ECONNRESET","status":503,"msg":"upstream retry"}';

async function startServer(handlerName) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsrv-fail-'));
    const handlerPath = path.join(dir, `${handlerName}.mjs`);
    fs.writeFileSync(handlerPath, HANDLERS[handlerName]);
    const manifest = {
        name: 'failingAgent',
        endpoints: { chatCompletions: { command: process.execPath, args: [handlerPath], supportsStream: true } },
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const port = await getFreePort();
    const child = spawn(process.execPath, [SERVER_PATH], {
        cwd: dir,
        env: {
            ...isolatedAgentServerEnv(),
            PORT: String(port),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_ID: 'agent:Workspace/failingAgent',
            PLOINKY_AGENT_MANIFEST: path.join(dir, 'manifest.json'),
            MCP_CONFIG_FILE: '',
            PLOINKY_CODE_DIR: dir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', c => logs.push(c.toString()));
    child.stderr.on('data', c => logs.push(c.toString()));
    if (!(await waitForHealth(port))) {
        child.kill('SIGKILL');
        throw new Error(`AgentServer did not become healthy. Logs:\n${logs.join('')}`);
    }
    const stop = () => new Promise(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(); }, 1500);
    });
    return { port, stop };
}

async function post(port, stream) {
    const res = await fetch(`http://127.0.0.1:${port}${OPENAI_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream }),
    });
    return { res, text: await res.text() };
}

function sseFrames(text) {
    return text.split('\n\n').map(f => f.trim()).filter(Boolean).map(f => f.replace(/^data: /, ''));
}

test('buffered: a failure envelope chooses status, type and Retry-After', async () => {
    const srv = await startServer('envelope');
    try {
        const { res, text } = await post(srv.port, false);
        assert.equal(res.status, 429);
        assert.equal(res.headers.get('retry-after'), '7', 'fractional seconds round up');
        assert.deepEqual(JSON.parse(text), { error: { message: 'rate_limited: busy', type: 'rate_limit_error' } });
    } finally {
        await srv.stop();
    }
});

test('buffered: a failure without an envelope stays HTTP 500', async () => {
    const srv = await startServer('plain');
    try {
        const { res, text } = await post(srv.port, false);
        assert.equal(res.status, 500);
        assert.equal(res.headers.get('retry-after'), null);
        assert.deepEqual(JSON.parse(text), { error: { message: 'boom', type: 'server_error' } });
    } finally {
        await srv.stop();
    }
});

test('buffered: a malformed status, type or retryAfter is ignored', async () => {
    const srv = await startServer('badStatus');
    try {
        const { res, text } = await post(srv.port, false);
        assert.equal(res.status, 500, 'status 200 is not an error status');
        assert.equal(res.headers.get('retry-after'), null);
        assert.deepEqual(JSON.parse(text), { error: { message: 'odd', type: 'server_error' } });
    } finally {
        await srv.stop();
    }
});

test('streamed: the envelope on the last stderr line travels inside the SSE error frame', async () => {
    const srv = await startServer('envelope');
    try {
        const { res, text } = await post(srv.port, true);
        assert.equal(res.status, 200, 'HTTP 200 is committed before the handler starts');
        assert.match(res.headers.get('content-type'), /text\/event-stream/);
        const frames = sseFrames(text);
        assert.deepEqual(JSON.parse(frames[0]), {
            error: { message: 'rate_limited: busy', type: 'rate_limit_error', status: 429 },
        });
        assert.equal(frames[1], '[DONE]');
        assert.equal(frames.length, 2);
    } finally {
        await srv.stop();
    }
});

test('streamed: a failure without an envelope keeps the frame shape it had before', async () => {
    const srv = await startServer('plain');
    try {
        const { text } = await post(srv.port, true);
        const frames = sseFrames(text);
        assert.deepEqual(JSON.parse(frames[0]), { error: { message: 'boom', type: 'server_error' } });
        assert.equal(frames[1], '[DONE]');
    } finally {
        await srv.stop();
    }
});

test('streamed: a handler that dies after partial output is reported', async () => {
    const srv = await startServer('partialThenDie');
    try {
        const { text } = await post(srv.port, true);
        const frames = sseFrames(text);
        assert.equal(frames.length, 3, 'partial event, error frame, [DONE]');
        assert.equal(JSON.parse(frames[0]).choices[0].delta.content, 'partial',
            'the half-written event is closed so it still parses on its own');
        assert.deepEqual(JSON.parse(frames[1]), { error: { message: 'died mid-answer', type: 'server_error' } });
        assert.equal(frames[2], '[DONE]');
    } finally {
        await srv.stop();
    }
});

test('streamed: a stream the handler terminated itself is left alone when it then exits non-zero', async () => {
    const srv = await startServer('completeThenFail');
    try {
        const { text } = await post(srv.port, true);
        const frames = sseFrames(text);
        assert.equal(frames.length, 2, 'the answer and exactly one [DONE]');
        assert.equal(JSON.parse(frames[0]).choices[0].delta.content, 'full answer');
        assert.equal(frames[1], '[DONE]');
        assert.ok(text.endsWith('data: [DONE]\n\n'), 'nothing follows the handler\'s own terminator');
    } finally {
        await srv.stop();
    }
});

test('buffered: a structured log line on stderr does not choose the status or replace the message', async () => {
    const srv = await startServer('jsonLogLine');
    try {
        const { res, text } = await post(srv.port, false);
        assert.equal(res.status, 500);
        assert.deepEqual(JSON.parse(text), { error: { message: JSON_LOG_STDERR, type: 'server_error' } });
    } finally {
        await srv.stop();
    }
});

test('streamed: a structured log line on stderr does not choose the status or replace the message', async () => {
    const srv = await startServer('jsonLogLine');
    try {
        const { text } = await post(srv.port, true);
        const frames = sseFrames(text);
        assert.deepEqual(JSON.parse(frames[0]), { error: { message: JSON_LOG_STDERR, type: 'server_error' } });
        assert.equal(frames[1], '[DONE]');
    } finally {
        await srv.stop();
    }
});
