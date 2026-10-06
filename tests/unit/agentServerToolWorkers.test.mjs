// AgentServer wiring of the tool worker pools (toolWorkerPool.mjs):
// routing, result compatibility, verification before dispatch, the
// PLOINKY_TOOL_WORKERS kill switch, completion log lines, the code identity
// hook and the optional spawn limiter. The pool itself is covered by
// toolWorkerPool.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { computeRchTool } from '../../Agent/lib/requestHash.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const AGENT_SERVER = path.join(REPO_ROOT, 'Agent/server/AgentServer.mjs');
const IDENTITY_SYMBOL = 'ploinky.agentServer.toolCodeIdentity';
const startedWorkerPids = new Set();

function isolatedAgentServerEnv() {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if (name.startsWith('PLOINKY_AGENT_') || name.startsWith('PLOINKY_ROUTER_')
            || name.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_') || name.startsWith('PLOINKY_TOOL_WORKER')
            || name === 'PLOINKY_INTERNAL_ROUTER_URL' || name === 'PLOINKY_EDGE_TOPOLOGY_FILE') {
            delete env[name];
        }
    }
    return env;
}

function groupAlive(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

// Last-resort cleanup so a failing assertion never leaks a worker group.
test.after(() => {
    for (const pid of startedWorkerPids) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
});

// A fixture agent: one implementation, run either as a CLI (spawn mode,
// envelope on stdin) or by a tool worker (worker mode). Worker loads and
// worker calls are logged so tests can tell the modes apart.
async function createFixtureAgent(t) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tool-workers-'));
    // Tool code lives in code/ (the agent code directory); logs, config and
    // HOME stay outside it, so writing them never changes the code identity.
    const code = path.join(tmp, 'code');
    const logs = path.join(tmp, 'logs');
    await fs.mkdir(code);
    await fs.mkdir(logs);
    const files = {
        impl: path.join(code, 'impl.mjs'),
        cli: path.join(code, 'cli.mjs'),
        worker: path.join(code, 'worker.mjs'),
        preload: path.join(tmp, 'identity-preload.mjs'),
        identity: path.join(tmp, 'identity.txt'),
        loads: path.join(logs, 'loads.log'),
        calls: path.join(logs, 'calls.log'),
        marks: path.join(logs, 'marks.log'),
        spans: path.join(logs, 'spans.log'),
        config: path.join(tmp, 'mcp-config.json'),
    };
    await fs.writeFile(files.impl, `
import fs from 'node:fs';
export async function runTool({ mode, stdout, stderr }) {
    switch (mode) {
    case 'pid': stdout.write(String(process.pid)); return 0;
    case 'text': stdout.write('plain text result'); return 0;
    case 'json': stdout.write(JSON.stringify({ ok: true, items: [1, 2, 3] })); return 0;
    case 'empty': return 0;
    case 'sentinel': stdout.write('__EMPTY_TEXT_SENTINEL__'); return 0;
    case 'stderr': stdout.write('out'); stderr.write('warning line\\n'); return 0;
    case 'fail': stdout.write(JSON.stringify({ ok: false, error: 'bad_input', message: 'it broke' })); return 1;
    case 'mark': fs.appendFileSync(${JSON.stringify(files.marks)}, process.pid + '\\n'); stdout.write('marked'); return 0;
    case 'slow': {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        fs.appendFileSync(${JSON.stringify(files.spans)}, start + ' ' + Date.now() + '\\n');
        stdout.write(String(process.pid));
        return 0;
    }
    case 'sleep': await new Promise((resolve) => setTimeout(resolve, 3000)); stdout.write(String(process.pid)); return 0;
    default: stderr.write('unknown mode ' + mode + '\\n'); return 2;
    }
}
`);
    await fs.writeFile(files.cli, `
import { runTool } from ${JSON.stringify(files.impl)};
let text = '';
for await (const chunk of process.stdin) text += chunk;
process.exitCode = await runTool({ mode: process.env.FIXTURE_MODE, stdout: process.stdout, stderr: process.stderr });
`);
    await fs.writeFile(files.worker, `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runTool } from ${JSON.stringify(files.impl)};
fs.appendFileSync(${JSON.stringify(files.loads)}, process.pid + '\\n');
const { serveToolWorker } = await import(pathToFileURL(process.env.PLOINKY_TOOL_WORKER_MODULE).href);
await serveToolWorker(async ({ toolName, toolEnv, stdout, stderr }) => {
    fs.appendFileSync(${JSON.stringify(files.calls)}, process.pid + ' ' + toolName + '\\n');
    return runTool({ mode: toolEnv.FIXTURE_MODE, stdout, stderr });
});
`);
    // Test-only identity source: the identity is the content of a file, so a
    // test can change it. A missing file makes the hook throw.
    await fs.writeFile(files.preload, `
import fs from 'node:fs';
globalThis[Symbol.for(${JSON.stringify(IDENTITY_SYMBOL)})] = () => fs.readFileSync(${JSON.stringify(files.identity)}, 'utf8');
`);
    await fs.writeFile(files.identity, 'identity-1');
    t.after(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });
    return { tmp, code, files, createdAt: Date.now() };
}

function tool(fx, name, mode, extra = {}) {
    return {
        name,
        command: process.execPath,
        args: [fx.files.cli],
        cwd: fx.code,
        env: { FIXTURE_MODE: mode },
        ...extra,
    };
}

function workerPool(fx, extra = {}) {
    return { command: process.execPath, args: [fx.files.worker], cwd: fx.code, size: 2, ...extra };
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function startServer(t, fx, config, { env = {}, identity = true, ipc = false } = {}) {
    await fs.writeFile(fx.files.config, JSON.stringify(config));
    const secret = crypto.randomBytes(32);
    const audience = 'agent:tool-workers-test';
    const port = await freePort();
    const nodeArgs = identity ? ['--import', fx.files.preload, AGENT_SERVER] : [AGENT_SERVER];
    const child = spawn(process.execPath, nodeArgs, {
        cwd: fx.tmp,
        env: {
            ...isolatedAgentServerEnv(), HOME: fx.tmp, PORT: String(port), PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_CONFIG: fx.files.config, PLOINKY_AGENT_SECRET: secret.toString('hex'),
            PLOINKY_AGENT_ID: audience, AGENT_NAME: 'fixture-agent', PLOINKY_CODE_DIR: fx.code, ...env,
        },
        stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
        }
    });
    const deadline = Date.now() + 5000;
    for (;;) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* retry */ }
        if (Date.now() > deadline) throw new Error(`AgentServer did not start:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const server = { child, port, secret, audience, output: () => output, nextId: 1 };
    server.sessionId = await initSession(server);
    return server;
}

async function post(server, body, { sessionId, token } = {}) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId) { headers['mcp-session-id'] = sessionId; headers['mcp-protocol-version'] = '2025-06-18'; }
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep the raw text */ }
    return { response, text, json };
}

async function initSession(server) {
    const init = await post(server, {
        jsonrpc: '2.0', id: 'init', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tool-workers-test', version: '1' } },
    });
    const sessionId = init.response.headers.get('mcp-session-id');
    assert.ok(sessionId, init.text);
    return sessionId;
}

function mintToken(server, toolName, { secret = server.secret, args = {} } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return signHmacJwt({
        secret,
        payload: {
            typ: 'router-request', iss: 'ploinky-router', aud: server.audience, sub: 'user:test',
            actor: { kind: 'user', id: 'user:test', roles: ['user'] }, method: 'POST', path: '/mcp', tool: toolName,
            rch: computeRchTool({ method: 'POST', path: '/mcp', tool: toolName, arguments: args }),
            jti: crypto.randomBytes(12).toString('base64url'), iat: now, exp: now + 60,
        },
    });
}

async function callTool(server, toolName, { token = mintToken(server, toolName), sessionId = server.sessionId } = {}) {
    const id = server.nextId++;
    const reply = await post(server, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: {} } }, { sessionId, token });
    assert.ok(reply.json, reply.text);
    return reply.json;
}

function okText(reply) {
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.notEqual(reply.result?.isError, true, JSON.stringify(reply));
    return reply.result.content[0].text;
}

function readLines(file) {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function workerLoads(fx) {
    const pids = readLines(fx.files.loads).map(Number);
    for (const pid of pids) startedWorkerPids.add(pid);
    return pids;
}

async function waitFor(predicate, { timeoutMs = 5000, message = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for ${message}`);
}

function completionLines(server) {
    return server.output().split('\n').filter((line) => line.startsWith('[AgentServer/MCP] tool='));
}

test('S1: an opted-in tool reuses at most `size` warm workers; a tool without a worker spawns per call', async (t) => {
    const fx = await createFixtureAgent(t);
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx, { size: 2 }) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' }), tool(fx, 'pid_spawn', 'pid')],
    });
    const workerPids = [];
    for (let batch = 0; batch < 4; batch += 1) {
        const replies = await Promise.all(Array.from({ length: 5 }, () => callTool(server, 'pid_worker')));
        workerPids.push(...replies.map((reply) => Number(okText(reply))));
    }
    const loads = workerLoads(fx);
    assert.equal(workerPids.length, 20);
    assert.ok(loads.length >= 1 && loads.length <= 2, `worker loads: ${loads.join(',')}`);
    for (const pid of workerPids) assert.ok(loads.includes(pid), `pid ${pid} did not come from a warm worker`);
    assert.equal(readLines(fx.files.calls).length, 20);

    const spawnPids = [];
    for (let i = 0; i < 20; i += 1) spawnPids.push(Number(okText(await callTool(server, 'pid_spawn'))));
    assert.equal(new Set(spawnPids).size, 20, 'every spawn-mode call runs in its own process');
    // A second worker the pool started for the parallel batches may finish
    // loading only now, so compare against the final load list.
    const finalLoads = workerLoads(fx);
    assert.ok(finalLoads.length <= 2, `worker loads: ${finalLoads.join(',')}`);
    for (const pid of spawnPids) assert.ok(!finalLoads.includes(pid), `spawn-mode pid ${pid} is a worker`);
    assert.equal(readLines(fx.files.calls).length, 20, 'no spawn-mode call ran in a worker');
});

test('S2: a call without a valid invocation token never reaches a worker', async (t) => {
    const fx = await createFixtureAgent(t);
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' })],
    });
    const missing = await post(server, { jsonrpc: '2.0', id: 'm', method: 'tools/call', params: { name: 'pid_worker', arguments: {} } },
        { sessionId: server.sessionId });
    assert.ok(missing.json?.error || missing.json?.result?.isError === true, missing.text);
    const forged = await callTool(server, 'pid_worker', { token: mintToken(server, 'pid_worker', { secret: crypto.randomBytes(32) }) });
    assert.ok(forged.error || forged.result?.isError === true, JSON.stringify(forged));
    const wrongTool = await callTool(server, 'pid_worker', { token: mintToken(server, 'other_tool') });
    assert.ok(wrongTool.error || wrongTool.result?.isError === true, JSON.stringify(wrongTool));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(readLines(fx.files.calls), [], 'no rejected call reached a worker');
    assert.deepEqual(workerLoads(fx), [], 'no worker was started for rejected calls');

    // Positive control: a verified call is served by a worker.
    const pid = Number(okText(await callTool(server, 'pid_worker')));
    assert.deepEqual(workerLoads(fx), [pid]);
    assert.deepEqual(readLines(fx.files.calls), [`${pid} pid_worker`]);
});

test('S3: results are identical in spawn and worker mode', async (t) => {
    const fx = await createFixtureAgent(t);
    const modes = ['text', 'json', 'empty', 'sentinel', 'stderr', 'fail'];
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx) },
        tools: modes.flatMap((mode) => [tool(fx, `${mode}_w`, mode, { worker: 'fx' }), tool(fx, `${mode}_s`, mode)]),
    });
    for (const mode of modes) {
        const viaWorker = await callTool(server, `${mode}_w`);
        const viaSpawn = await callTool(server, `${mode}_s`);
        delete viaWorker.id;
        delete viaSpawn.id;
        assert.deepEqual(viaWorker, viaSpawn, `mode ${mode}`);
    }
    // The worker path really ran: one worker call per mode.
    assert.deepEqual(readLines(fx.files.calls).map((line) => line.split(' ')[1]), modes.map((mode) => `${mode}_w`));
    const sample = await callTool(server, 'empty_w');
    assert.equal(okText(sample), '(no output)');
    const failed = await callTool(server, 'fail_w');
    assert.match(JSON.stringify(failed), /bad_input: it broke/);
});

test('S4: PLOINKY_TOOL_WORKERS=0 runs every call as a fresh process', async (t) => {
    const fx = await createFixtureAgent(t);
    const config = {
        toolWorkers: { fx: workerPool(fx) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' })],
    };
    const disabled = await startServer(t, fx, config, { env: { PLOINKY_TOOL_WORKERS: '0' } });
    const pids = [];
    for (let i = 0; i < 5; i += 1) pids.push(Number(okText(await callTool(disabled, 'pid_worker'))));
    assert.equal(new Set(pids).size, 5);
    assert.deepEqual(workerLoads(fx), []);
    assert.match(disabled.output(), /PLOINKY_TOOL_WORKERS=0: tool workers are disabled/);
    assert.equal(completionLines(disabled).filter((line) => / mode=spawn /.test(line)).length, 5);

    // Control: the same config without the switch uses warm workers.
    const enabled = await startServer(t, fx, config);
    const warm = [];
    for (let i = 0; i < 5; i += 1) warm.push(Number(okText(await callTool(enabled, 'pid_worker'))));
    const loads = workerLoads(fx);
    assert.equal(loads.length, 1);
    assert.deepEqual(new Set(warm), new Set(loads));
});

test('S5: tools that cannot use their pool log one warning and keep their existing path', async (t) => {
    const fx = await createFixtureAgent(t);
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx) },
        tools: [
            tool(fx, 'async_worker', 'mark', { worker: 'fx', async: true }),
            tool(fx, 'unknown_pool', 'pid', { worker: 'nope' }),
            tool(fx, 'other_cwd', 'pid', { worker: 'fx', cwd: os.tmpdir() }),
        ],
    });
    const queued = await callTool(server, 'async_worker');
    assert.match(okText(queued), /Task 'async_worker' queued with id/);
    await waitFor(() => readLines(fx.files.marks).length === 1, { message: 'the queued task to run' });

    const unknownPids = [Number(okText(await callTool(server, 'unknown_pool'))), Number(okText(await callTool(server, 'unknown_pool')))];
    const cwdPids = [Number(okText(await callTool(server, 'other_cwd'))), Number(okText(await callTool(server, 'other_cwd'))) ];
    assert.equal(new Set([...unknownPids, ...cwdPids]).size, 4);
    // A second session re-registers the tools without repeating the warnings.
    server.sessionId = await initSession(server);
    okText(await callTool(server, 'unknown_pool'));

    assert.deepEqual(workerLoads(fx), [], 'no worker was started');
    const out = server.output();
    const count = (pattern) => out.split('\n').filter((line) => pattern.test(line)).length;
    assert.equal(count(/tool 'async_worker' runs as a fresh process: async tools run through the task queue/), 1, out);
    assert.equal(count(/tool 'unknown_pool' runs as a fresh process: tool worker pool 'nope' is not available/), 1, out);
    assert.equal(count(/tool 'other_cwd' runs as a fresh process: its cwd differs from the cwd of tool worker pool 'fx'/), 1, out);
});

test('S7: one completion line per call, naming the pool, and no payload lines by default', async (t) => {
    const fx = await createFixtureAgent(t);
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' }), tool(fx, 'fail_worker', 'fail', { worker: 'fx' }), tool(fx, 'pid_spawn', 'pid')],
    });
    for (let i = 0; i < 3; i += 1) okText(await callTool(server, 'pid_worker'));
    await callTool(server, 'fail_worker');
    okText(await callTool(server, 'pid_spawn'));
    await waitFor(() => completionLines(server).length >= 5, { message: 'five completion lines' });
    const lines = completionLines(server);
    assert.equal(lines.length, 5, server.output());
    for (const line of lines.slice(0, 3)) assert.match(line, /^\[AgentServer\/MCP\] tool=pid_worker mode=worker:fx ms=\d+ outcome=ok$/);
    assert.match(lines[3], /^\[AgentServer\/MCP\] tool=fail_worker mode=worker:fx ms=\d+ outcome=error$/);
    assert.match(lines[4], /^\[AgentServer\/MCP\] tool=pid_spawn mode=spawn ms=\d+ outcome=ok$/);
    assert.equal(server.output().split('\n').filter((line) => /payload:|' args:|' context:/.test(line)).length, 0);
});

test('identity: a changed code identity replaces the warm worker before the next call', async (t) => {
    const fx = await createFixtureAgent(t);
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx, { size: 1 }) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' })],
    });
    const first = Number(okText(await callTool(server, 'pid_worker')));
    assert.equal(Number(okText(await callTool(server, 'pid_worker'))), first, 'an unchanged identity reuses the worker');
    await fs.writeFile(fx.files.identity, 'identity-2');
    const second = Number(okText(await callTool(server, 'pid_worker')));
    assert.notEqual(second, first, 'the worker spawned under the old identity served a call');
    assert.deepEqual(workerLoads(fx), [first, second]);
    await waitFor(() => !groupAlive(first), { message: 'the retired worker to exit' });
    assert.equal(Number(okText(await callTool(server, 'pid_worker'))), second);
});

test('identity: a failing identity hook sends the call to a fresh process', async (t) => {
    const fx = await createFixtureAgent(t);
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' })],
    });
    const warm = Number(okText(await callTool(server, 'pid_worker')));
    await fs.rm(fx.files.identity);
    const pids = [Number(okText(await callTool(server, 'pid_worker'))), Number(okText(await callTool(server, 'pid_worker')))];
    assert.equal(new Set([warm, ...pids]).size, 3, 'calls ran outside the warm worker');
    assert.deepEqual(workerLoads(fx), [warm]);
    await waitFor(() => completionLines(server).length >= 3, { message: 'three completion lines' });
    const lines = completionLines(server);
    assert.match(lines[0], / mode=worker:fx /);
    assert.match(lines[1], / mode=spawn /);
    assert.match(lines[2], / mode=spawn /);
});

test('default identity: new or edited tool code runs as a fresh process until it settles, then in a new worker', async (t) => {
    const fx = await createFixtureAgent(t);
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx, { size: 1, idleTimeoutMs: 600000, maxCallsPerWorker: 10000 }) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' })],
    }, { identity: false });
    const settle = async (since) => {
        const wait = since + 2300 - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    };
    const pid = async () => Number(okText(await callTool(server, 'pid_worker')));

    if (Date.now() - fx.createdAt < 1500) {
        const early = await pid();
        assert.ok(!workerLoads(fx).includes(early), 'code written moments ago runs as a fresh process');
    }
    await settle(fx.createdAt);
    const original = await pid();
    assert.deepEqual(workerLoads(fx), [original], 'settled code runs in a warm worker');
    assert.equal(await pid(), original);

    await fs.appendFile(fx.files.impl, '// edited\n');
    const editedAt = Date.now();
    const duringWindow = await pid();
    assert.notEqual(duringWindow, original);
    assert.ok(!workerLoads(fx).includes(duringWindow), 'inside the racy window the call runs as a fresh process');
    await settle(editedAt);
    assert.ok(groupAlive(original), 'the original worker is still alive after the window');
    const replaced = await pid();
    assert.notEqual(replaced, original, 'the worker loaded before the edit served a call');
    assert.deepEqual(workerLoads(fx), [original, replaced]);
    assert.match(server.output(), /tool code changed; replacing the worker/);
    await waitFor(() => !groupAlive(original), { message: 'the retired worker to exit' });
});

function maxOverlap(spans) {
    const events = spans.flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current = 0;
    let max = 0;
    for (const [, delta] of events) {
        current += delta;
        max = Math.max(max, current);
    }
    return max;
}

// Exercise the real loop tool bridge in the same module instance as the MCP
// listener. Only the responder is replaced; no model/inference is invoked.
async function addLoopPreload(fx) {
    await fs.appendFile(fx.files.preload, `
const { __buildAgenticCompletion } = await import(${JSON.stringify(AGENT_SERVER)});
const config = JSON.parse(fs.readFileSync(${JSON.stringify(fx.files.config)}, 'utf8'));
process.on('message', async ({ id, toolName, count }) => {
    try {
        const results = await Promise.all(Array.from({ length: count }, () => __buildAgenticCompletion({
            body: { messages: [] }, manifest: {}, config, agentId: 'agent:test',
            runResponder: ({ toolsMap }) => toolsMap[toolName].handler(null, '{}'),
        })));
        process.send({ id, results });
    } catch (error) {
        process.send({ id, error: String(error) });
    }
});
process.channel.unref();
`);
}

function callLoopTools(server, toolName, count) {
    const id = server.nextId++;
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            server.child.off('message', onMessage);
            server.child.off('exit', onExit);
        };
        const onMessage = (message) => {
            if (message.id !== id) return;
            cleanup();
            if (message.error) reject(new Error(message.error));
            else resolve(message.results);
        };
        const onExit = () => { cleanup(); reject(new Error('AgentServer exited before loop completion')); };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('AgentServer loop did not complete within 30 s'));
        }, 30_000);
        server.child.on('message', onMessage);
        server.child.once('exit', onExit);
        server.child.send({ id, toolName, count }, (error) => {
            if (error) { cleanup(); reject(error); }
        });
    });
}

async function terminateServer(server) {
    const exited = once(server.child, 'exit');
    server.child.kill('SIGTERM');
    let timer;
    try {
        return await Promise.race([
            exited,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('AgentServer did not exit within 30 s')), 30_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

for (const route of ['spawn', 'identity fallback', 'degraded fallback']) {
    for (const limit of [2, undefined]) {
        test(`A4: mixed MCP/loop ${route} calls share the spawn limit (${limit ?? 'unset'})`, async (t) => {
            const fx = await createFixtureAgent(t);
            await addLoopPreload(fx);
            const useWorker = route !== 'spawn';
            if (route === 'degraded fallback') {
                // Three real pre-ready exits put the pool into degradation.
                await fs.writeFile(fx.files.worker, 'process.exit(1);\n');
            }
            const server = await startServer(t, fx, {
                ...(limit === undefined ? {} : { maxParallelSyncCalls: limit }),
                toolWorkers: useWorker ? { fx: workerPool(fx, { size: 1 }) } : {},
                tools: [
                    tool(fx, 'slow_tool', 'slow', useWorker ? { worker: 'fx' } : {}),
                    tool(fx, 'pid_worker', 'pid', { worker: 'fx' }),
                ],
            }, { ipc: true });
            let workers = [];
            if (route === 'identity fallback') {
                const pid = Number(okText(await callTool(server, 'pid_worker')));
                workers = workerLoads(fx);
                assert.deepEqual(workers, [pid], 'positive control warmed the pool before identity failure');
                await fs.rm(fx.files.identity);
            } else if (route === 'degraded fallback') {
                assert.ok(Number(okText(await callTool(server, 'pid_worker'))) > 0);
                assert.match(server.output(), /3 consecutive workers exited.*degraded/);
            }

            const otherSession = await initSession(server);
            const [loopResults, mcpResults] = await Promise.all([
                callLoopTools(server, 'slow_tool', 3),
                Promise.all(Array.from({ length: 3 }, (_, index) => callTool(server, 'slow_tool', {
                    sessionId: index % 2 ? otherSession : server.sessionId,
                }))),
            ]);
            assert.equal(loopResults.length, 3);
            const pids = [...loopResults, ...mcpResults.map(okText)].map(Number);
            assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 0), 'every call completed successfully');
            assert.equal(new Set(pids).size, 6, 'every call used its own spawn process exactly once');
            assert.ok(pids.every((pid) => !workers.includes(pid)), 'fallback did not run in the warm worker');
            const spans = readLines(fx.files.spans).map((line) => line.split(' ').map(Number));
            assert.equal(spans.length, 6, 'one execution span per loop/MCP call');
            if (limit === undefined) {
                assert.ok(maxOverlap(spans) >= 4, `unset limit must allow overlap above two: ${JSON.stringify(spans)}`);
            } else {
                assert.equal(maxOverlap(spans), 2, `aggregate loop/MCP overlap: ${JSON.stringify(spans)}`);
            }
            assert.equal(readLines(fx.files.calls).filter((line) => line.endsWith(' slow_tool')).length, 0);
            const [code, signal] = await terminateServer(server);
            assert.equal(code, 0, server.output());
            assert.equal(signal, null);
            for (const pid of workers) assert.equal(groupAlive(pid), false, `worker group ${pid} leaked`);
        });
    }
}

test('maxParallelSyncCalls bounds sync calls that run as fresh processes; absent means unlimited', async (t) => {
    const fx = await createFixtureAgent(t);
    const tools = [tool(fx, 'slow_spawn', 'slow')];
    const limited = await startServer(t, fx, { maxParallelSyncCalls: 2, tools });
    const replies = await Promise.all(Array.from({ length: 6 }, () => callTool(limited, 'slow_spawn')));
    replies.forEach(okText);
    const limitedSpans = readLines(fx.files.spans).map((line) => line.split(' ').map(Number));
    assert.equal(limitedSpans.length, 6);
    assert.equal(maxOverlap(limitedSpans), 2, `spans: ${JSON.stringify(limitedSpans)}`);

    await fs.rm(fx.files.spans);
    const unlimited = await startServer(t, fx, { tools });
    (await Promise.all(Array.from({ length: 6 }, () => callTool(unlimited, 'slow_spawn')))).forEach(okText);
    const unlimitedSpans = readLines(fx.files.spans).map((line) => line.split(' ').map(Number));
    assert.ok(maxOverlap(unlimitedSpans) >= 4, `spans: ${JSON.stringify(unlimitedSpans)}`);
});

test('S6: SIGTERM shuts the pools down, fails the in-flight worker call and exits 0 with no worker left', async (t) => {
    const fx = await createFixtureAgent(t);
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx, { size: 2 }) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' }), tool(fx, 'sleep_worker', 'sleep', { worker: 'fx' })],
    });
    await Promise.all([callTool(server, 'pid_worker'), callTool(server, 'pid_worker')]);
    const inFlight = callTool(server, 'sleep_worker').catch((error) => ({ transportError: String(error) }));
    await waitFor(() => readLines(fx.files.calls).some((line) => line.endsWith(' sleep_worker')), { message: 'the slow call to start' });
    const workers = workerLoads(fx);
    assert.ok(workers.length >= 1);
    for (const pid of workers) assert.ok(groupAlive(pid), `worker ${pid} should be running before SIGTERM`);

    const exited = once(server.child, 'exit');
    server.child.kill('SIGTERM');
    let exitTimer;
    const [code, signal] = await Promise.race([
        exited,
        new Promise((resolve) => { exitTimer = setTimeout(() => resolve(['no exit within 30 s', null]), 30_000); }),
    ]);
    clearTimeout(exitTimer);
    assert.equal(code, 0, server.output());
    assert.equal(signal, null);
    // Checked at once: the server itself killed and awaited every worker group.
    for (const pid of workers) assert.equal(groupAlive(pid), false, `worker group ${pid} outlived the AgentServer`);
    await inFlight;
    assert.doesNotMatch(server.output(), /tool worker processes were still present/);
});

test('S6b: unclean worker shutdown exits nonzero after TaskQueue and listener cleanup', async (t) => {
    const fx = await createFixtureAgent(t);
    const cleanupLog = path.join(fx.tmp, 'cleanup.log');
    await fs.appendFile(fx.files.preload, `
import http from 'node:http';
import { ToolWorkerPool } from ${JSON.stringify(path.join(REPO_ROOT, 'Agent/server/toolWorkerPool.mjs'))};
import { TaskQueue } from ${JSON.stringify(path.join(REPO_ROOT, 'Agent/server/TaskQueue.mjs'))};
const record = (event) => fs.appendFileSync(${JSON.stringify(cleanupLog)}, event + '\\n');
const shutdownPool = ToolWorkerPool.prototype.shutdown;
ToolWorkerPool.prototype.shutdown = async function (options) {
    const result = await shutdownPool.call(this, options);
    if (!result.clean) throw new Error('Fixture worker cleanup actually failed');
    record('workers-cleaned');
    return { clean: false };
};
const shutdownQueue = TaskQueue.prototype.shutdown;
TaskQueue.prototype.shutdown = async function (options) {
    record('queue-started');
    const result = await shutdownQueue.call(this, options);
    record('queue-finished');
    return result;
};
const closeListener = http.Server.prototype.close;
http.Server.prototype.close = function (callback) {
    return closeListener.call(this, (error) => {
        record(error ? 'listener-failed' : 'listener-closed');
        callback?.(error);
    });
};
`);
    const server = await startServer(t, fx, {
        toolWorkers: { fx: workerPool(fx) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' })],
    });
    const pid = Number(okText(await callTool(server, 'pid_worker')));
    assert.deepEqual(workerLoads(fx), [pid]);
    assert.ok(groupAlive(pid));
    const [code, signal] = await terminateServer(server);
    // Check cleanup before the exit assertion so an early throw cannot pass.
    const events = readLines(cleanupLog);
    assert.ok(events.includes('workers-cleaned'), JSON.stringify(events));
    assert.ok(events.indexOf('queue-started') > events.indexOf('workers-cleaned'), JSON.stringify(events));
    assert.ok(events.indexOf('queue-finished') > events.indexOf('queue-started'), JSON.stringify(events));
    assert.ok(events.includes('listener-closed'), JSON.stringify(events));
    assert.ok(!events.includes('listener-failed'), JSON.stringify(events));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(fx.tmp, '.tasksQueue'), 'utf8')), []);
    assert.equal(groupAlive(pid), false, `worker group ${pid} outlived the AgentServer`);
    assert.equal(signal, null);
    assert.equal(code, 1, server.output());
    assert.match(server.output(), /graceful SIGTERM shutdown failed/);
    assert.match(server.output(), /[Tt]ool worker processes were still present/);
});

test('the agentic tool loop runs opted-in tools in their pool and other tools as fresh processes', async (t) => {
    const fx = await createFixtureAgent(t);
    const config = {
        toolWorkers: { fx: workerPool(fx) },
        tools: [tool(fx, 'pid_worker', 'pid', { worker: 'fx' }), tool(fx, 'pid_spawn', 'pid')],
    };
    await fs.writeFile(fx.files.config, JSON.stringify(config));
    const saved = { config: process.env.PLOINKY_AGENT_CONFIG, workers: process.env.PLOINKY_TOOL_WORKERS };
    process.env.PLOINKY_AGENT_CONFIG = fx.files.config;
    delete process.env.PLOINKY_TOOL_WORKERS;
    globalThis[Symbol.for(IDENTITY_SYMBOL)] = () => readFileSync(fx.files.identity, 'utf8');
    const { shutdownToolWorkerPools } = await import('../../Agent/server/toolWorkerPool.mjs');
    t.after(async () => {
        await shutdownToolWorkerPools({ timeoutMs: 5000 });
        if (saved.config === undefined) delete process.env.PLOINKY_AGENT_CONFIG;
        else process.env.PLOINKY_AGENT_CONFIG = saved.config;
        if (saved.workers !== undefined) process.env.PLOINKY_TOOL_WORKERS = saved.workers;
        delete globalThis[Symbol.for(IDENTITY_SYMBOL)];
    });
    const { __buildAgenticCompletion } = await import(`${new URL('../../Agent/server/AgentServer.mjs', import.meta.url).href}?agentic`);
    const outputs = await __buildAgenticCompletion({
        body: { messages: [{ role: 'user', content: 'hi' }] },
        manifest: {},
        config,
        agentId: 'agent:test',
        runResponder: async ({ toolsMap }) => {
            const worker = [];
            const spawned = [];
            for (let i = 0; i < 3; i += 1) worker.push(Number(await toolsMap.pid_worker.handler(null, '{}')));
            for (let i = 0; i < 3; i += 1) spawned.push(Number(await toolsMap.pid_spawn.handler(null, '{}')));
            return { worker, spawned };
        },
    });
    const loads = workerLoads(fx);
    assert.equal(loads.length, 1);
    assert.deepEqual(new Set(outputs.worker), new Set(loads), 'opted-in loop calls ran in the warm worker');
    assert.equal(new Set(outputs.spawned).size, 3);
    for (const pid of outputs.spawned) assert.ok(!loads.includes(pid));
});
