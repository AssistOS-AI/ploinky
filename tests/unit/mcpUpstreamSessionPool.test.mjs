import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { computeRchTool } from '../../Agent/lib/requestHash.mjs';
import {
    createUpstreamSessionPool,
    isUpstreamPoolEnabled,
    poolKeyForRoutePlan,
} from '../../cli/server/mcp-proxy/upstreamSessionPool.js';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const AGENT_SERVER = path.join(REPO_ROOT, 'Agent/server/AgentServer.mjs');
const AUDIENCE = 'agent:PoolTest/echoAgent';

// MCP SDK the Box image supplies (review IMP-5). Recorded on 2026-10-06 from the
// measurement Box's image-supplied copy, `.ploinky/box/dependencies/mcp-sdk/
// .ploinky-box-mcp-sdk.json` (supplying image sha256:535c281e…), whose
// index.mjs hashed to the value below. Override with
// PLOINKY_TEST_BOX_MCP_SDK_COMMIT when testing against another image.
const BOX_IMAGE_MCP_SDK = Object.freeze({
    commit: process.env.PLOINKY_TEST_BOX_MCP_SDK_COMMIT || '7efe9d17f52a625743e411089d3a6879f6f89156',
    indexSha256: process.env.PLOINKY_TEST_BOX_MCP_SDK_COMMIT
        ? ''
        : '3993e9f31f2cafe25d697ffe5930d84877236437377c7073159f18c1195c7d1e',
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

async function stopChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    let timer;
    child.kill('SIGTERM');
    try {
        await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
        }
    } finally {
        clearTimeout(timer);
    }
}

async function createTempDir(t) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-pool-'));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
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
    const deadline = Date.now() + 5000;
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

async function writeEchoAgentConfig(tmp) {
    const configPath = path.join(tmp, 'mcp-config.json');
    const toolScript = path.join(tmp, 'echo-actor.mjs');
    const invocations = path.join(tmp, 'invocations.jsonl');
    await fs.writeFile(toolScript, [
        "import fs from 'node:fs';",
        "let text = ''; for await (const chunk of process.stdin) text += chunk;",
        "const { input, metadata } = JSON.parse(text);",
        "await new Promise(resolve => setTimeout(resolve, 20));",
        "const result = { input, actor: metadata.invocation.actor, jti: metadata.invocation.jti };",
        `fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify(result) + '\\n');`,
        "console.log(JSON.stringify(result));",
    ].join('\n'));
    const inputSchema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
    await fs.writeFile(configPath, JSON.stringify({ tools: [{
        name: 'actor', command: process.execPath, args: [toolScript], cwd: tmp, inputSchema,
    }] }));
    return { configPath, invocations };
}

async function startAgentServer(t, { tmp, configPath, secret, port = null, audience = AUDIENCE }) {
    const agentPort = port || await getFreePort();
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd: tmp,
        env: {
            ...isolatedAgentServerEnv(),
            HOME: tmp,
            PORT: String(agentPort),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_CONFIG: configPath,
            PLOINKY_AGENT_SECRET: Buffer.isBuffer(secret) ? secret.toString('hex') : String(secret),
            PLOINKY_AGENT_ID: audience,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    t.after(() => stopChild(child));
    await waitForHealth(agentPort, () => output);
    return { child, port: agentPort, output: () => output };
}

// Records every request the pool sends and forwards it to the agent on a fresh
// connection, so restarts behind it never leave stale forwarder sockets.
async function startForwarder(t, targetPort) {
    const state = { targetPort, log: [] };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            let message = null;
            try { message = JSON.parse(body.toString('utf8')); } catch { /* not JSON */ }
            state.log.push({
                httpMethod: req.method,
                rpc: message?.method || '',
                id: message?.id,
                sessionId: req.headers['mcp-session-id'] || '',
                authorization: req.headers.authorization || '',
            });
            const headers = { ...req.headers };
            delete headers.host;
            delete headers.connection;
            delete headers['keep-alive'];
            const upstream = http.request({
                host: '127.0.0.1',
                port: state.targetPort,
                method: req.method,
                path: req.url,
                headers,
                agent: false,
            }, (response) => {
                const responseHeaders = { ...response.headers };
                delete responseHeaders.connection;
                delete responseHeaders['keep-alive'];
                delete responseHeaders['transfer-encoding'];
                res.writeHead(response.statusCode || 502, responseHeaders);
                response.pipe(res);
            });
            upstream.on('error', (error) => {
                if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
                res.end(String(error?.code || error?.message || 'forward failed'));
            });
            upstream.end(body);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.port = server.address().port;
    state.server = server;
    state.close = async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
    };
    t.after(() => (server.listening ? state.close() : undefined));
    return state;
}

// Minimal JSON MCP upstream; `onRpc` may answer a message itself and return true.
async function startFakeUpstream(t, { onRpc = null, keepAliveTimeout = null } = {}) {
    const state = { log: [], connections: 0, sessionId: `fake-${crypto.randomUUID()}` };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', async () => {
            let message = null;
            try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
            state.log.push({
                httpMethod: req.method,
                rpc: message?.method || '',
                id: message?.id,
                sessionId: req.headers['mcp-session-id'] || '',
                authorization: req.headers.authorization || '',
            });
            if (req.method === 'DELETE') {
                res.writeHead(200);
                res.end();
                return;
            }
            if (onRpc && await onRpc({ req, res, message, state })) return;
            const json = (body, extra = {}) => {
                const data = Buffer.from(JSON.stringify(body));
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': data.length, ...extra });
                res.end(data);
            };
            if (message?.method === 'initialize') {
                json({ jsonrpc: '2.0', id: message.id, result: {
                    protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' },
                } }, { 'mcp-session-id': state.sessionId });
                return;
            }
            if (message?.method === 'notifications/initialized') {
                res.writeHead(202);
                res.end();
                return;
            }
            if (message?.method === 'tools/call') {
                json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'fake-ok' }] } });
                return;
            }
            json({ jsonrpc: '2.0', id: message?.id ?? null, result: {} });
        });
    });
    server.on('connection', () => { state.connections += 1; });
    if (keepAliveTimeout !== null) server.keepAliveTimeout = keepAliveTimeout;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.port = server.address().port;
    t.after(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
    });
    return state;
}

function mintRouterRequest({ secret, tool, args = {}, actor, audience = AUDIENCE }) {
    const now = Math.floor(Date.now() / 1000);
    return signHmacJwt({
        secret,
        payload: {
            typ: 'router-request',
            iss: 'ploinky-router',
            aud: audience,
            sub: actor.id,
            actor,
            method: 'POST',
            path: '/mcp',
            tool,
            rch: computeRchTool({ method: 'POST', path: '/mcp', tool, arguments: args }),
            jti: crypto.randomBytes(12).toString('base64url'),
            iat: now,
            exp: now + 30,
        },
    });
}

function jtiOf(authorization) {
    const token = String(authorization || '').replace(/^Bearer\s+/i, '');
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).jti;
}

function keyFor({ lease = 'lease-1', port, routeKey = 'echoAgent' } = {}) {
    return JSON.stringify([routeKey, lease, port, 'c'.repeat(64), 'instance-1', 'enable-1']);
}

const ALICE = { kind: 'user', id: 'user:alice', roles: ['admin'] };
const BOB = { kind: 'user', id: 'user:bob', roles: ['user'] };

// Per-attempt header factory: every call mints a new token and records it.
function minter(secret, actor, args, mints) {
    return () => {
        const token = mintRouterRequest({ secret, tool: 'actor', args, actor });
        const authorization = `Bearer ${token}`;
        mints.push(authorization);
        return { authorization };
    };
}

function toolPayload(message) {
    assert.equal(message.error, undefined, JSON.stringify(message));
    assert.equal(message.result?.isError, undefined, JSON.stringify(message));
    return JSON.parse(message.result.content[0].text);
}

function count(log, predicate) {
    return log.filter(predicate).length;
}

async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
}

async function startEchoAgentBehindForwarder(t, { port = null } = {}) {
    const tmp = await createTempDir(t);
    const { configPath, invocations } = await writeEchoAgentConfig(tmp);
    const secret = crypto.randomBytes(32);
    const agent = await startAgentServer(t, { tmp, configPath, secret, port });
    const forwarder = await startForwarder(t, agent.port);
    return { tmp, configPath, invocations, secret, agent, forwarder };
}

function newPool(t, options = {}) {
    const pool = createUpstreamSessionPool(options);
    t.after(() => pool.closeAll());
    return pool;
}

test('poolKeyForRoutePlan requires every key part and ignores the caller', () => {
    const plan = {
        routeKey: 'echoAgent',
        lease: { id: 'lease-1' },
        target: { hostname: '127.0.0.1', hostPort: 7001 },
        route: { container: 'echo-container', hostPort: 7001 },
        snapshot: { agents: { 'echo-container': { containerId: 'a'.repeat(64), instanceId: 'i-1', enableGeneration: 'g-1' } } },
    };
    const key = poolKeyForRoutePlan(plan);
    assert.deepEqual(JSON.parse(key), ['echoAgent', 'lease-1', 7001, 'a'.repeat(64), 'i-1', 'g-1']);
    assert.equal(poolKeyForRoutePlan({ ...plan, user: { id: 'other' } }), key);
    for (const mutate of [
        (p) => { p.routeKey = ''; },
        (p) => { p.lease = {}; },
        (p) => { p.target = null; },
        (p) => { p.route = { hostPort: 7001 }; },
        (p) => { p.route.hostPort = 7002; },
        (p) => { p.snapshot.agents['echo-container'].containerId = ''; },
        (p) => { p.snapshot.agents['echo-container'].instanceId = ''; },
        (p) => { p.snapshot.agents['echo-container'].enableGeneration = ''; },
    ]) {
        const copy = structuredClone(plan);
        mutate(copy);
        assert.equal(poolKeyForRoutePlan(copy), null);
    }
    assert.equal(poolKeyForRoutePlan(null), null);
    assert.equal(isUpstreamPoolEnabled({}), true);
    assert.equal(isUpstreamPoolEnabled({ PLOINKY_MCP_UPSTREAM_POOL: '0' }), false);
});

test('B5-1: warm pooled session sends one tools/call POST per call with a fresh token and the caller actor', async (t) => {
    const { secret, forwarder, invocations } = await startEchoAgentBehindForwarder(t);
    const pool = newPool(t);
    const key = keyFor({ port: forwarder.port });
    const mints = [];
    const call = (index, actor) => pool.request({
        key, hostPort: forwarder.port, method: 'tools/call',
        params: { name: 'actor', arguments: { label: `call-${index}` } },
        headers: minter(secret, actor, { label: `call-${index}` }, mints),
        beforeDial: () => true,
    });
    toolPayload(await call('warm', ALICE));
    const before = forwarder.log.length;
    for (let index = 0; index < 20; index += 1) {
        const actor = index % 2 ? BOB : ALICE;
        const verified = toolPayload(await call(index, actor));
        assert.deepEqual(verified.actor, actor);
        assert.deepEqual(verified.input, { label: `call-${index}` });
    }
    const after = forwarder.log.slice(before);
    assert.equal(count(after, (row) => row.rpc === 'tools/call'), 20);
    assert.equal(count(after, (row) => row.rpc === 'initialize'), 0);
    assert.equal(after.length, 20, 'no other upstream request after warm-up');
    const jtis = after.map((row) => jtiOf(row.authorization));
    assert.equal(new Set(jtis).size, 20, 'every call carries a distinct jti');
    assert.equal(mints.length, 21);
    const executed = (await fs.readFile(invocations, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(new Set(executed.map((row) => row.jti)).size, executed.length);
});

test('B5-2: concurrent calls alternating actors on one key share one session and keep each actor', async (t) => {
    const { secret, forwarder } = await startEchoAgentBehindForwarder(t);
    const pool = newPool(t);
    const key = keyFor({ port: forwarder.port });
    const mints = [];
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => {
        const actor = index % 2 ? BOB : ALICE;
        const args = { label: `concurrent-${index}` };
        return pool.request({
            key, hostPort: forwarder.port, method: 'tools/call',
            params: { name: 'actor', arguments: args },
            headers: minter(secret, actor, args, mints),
            beforeDial: () => true,
        }).then((message) => ({ index, actor, args, verified: toolPayload(message) }));
    }));
    for (const { actor, args, verified } of results) {
        assert.deepEqual(verified.actor, actor, `actor for ${args.label}`);
        assert.deepEqual(verified.input, args);
    }
    assert.equal(count(forwarder.log, (row) => row.rpc === 'initialize'), 1, 'exactly one initialize');
    const calls = forwarder.log.filter((row) => row.rpc === 'tools/call');
    assert.equal(calls.length, 8);
    assert.equal(new Set(calls.map((row) => row.sessionId)).size, 1, 'all calls on one session');
    assert.equal(new Set(calls.map((row) => row.id)).size, 8, 'unique JSON-RPC ids per entry');
    assert.equal(new Set(calls.map((row) => jtiOf(row.authorization))).size, 8);
});

test('B5-3: replaying an earlier call header on the pooled session is rejected and never dispatches', async (t) => {
    const { secret, forwarder, invocations } = await startEchoAgentBehindForwarder(t);
    const pool = newPool(t);
    const key = keyFor({ port: forwarder.port });
    const mints = [];
    const args = { label: 'replayed' };
    toolPayload(await pool.request({
        key, hostPort: forwarder.port, method: 'tools/call',
        params: { name: 'actor', arguments: args },
        headers: minter(secret, ALICE, args, mints),
        beforeDial: () => true,
    }));
    const executedBefore = (await fs.readFile(invocations, 'utf8')).trim().split('\n').length;
    const replayed = await pool.request({
        key, hostPort: forwarder.port, method: 'tools/call',
        params: { name: 'actor', arguments: args },
        headers: () => ({ authorization: mints[0] }),
        beforeDial: () => true,
    });
    assert.equal(replayed.result?.isError, true, JSON.stringify(replayed));
    assert.match(replayed.result.content[0].text, /Invocation rejected/);
    const executedAfter = (await fs.readFile(invocations, 'utf8')).trim().split('\n').length;
    assert.equal(executedAfter, executedBefore, 'the replayed token never reaches the tool');
    assert.equal(count(forwarder.log, (row) => row.rpc === 'initialize'), 1);
});

test('B5-4: an agent restart on the same port evicts the session, re-checks readiness and retries once with a new token', async (t) => {
    const fixture = await startEchoAgentBehindForwarder(t);
    const { secret, forwarder } = fixture;
    const pool = newPool(t);
    const key = keyFor({ port: forwarder.port });
    const warmMints = [];
    toolPayload(await pool.request({
        key, hostPort: forwarder.port, method: 'tools/call',
        params: { name: 'actor', arguments: { label: 'before-restart' } },
        headers: minter(secret, ALICE, { label: 'before-restart' }, warmMints),
        beforeDial: () => true,
    }));
    const oldSession = pool.snapshot().entries[0].sessionId;
    await stopChild(fixture.agent.child);
    await startAgentServer(t, { tmp: fixture.tmp, configPath: fixture.configPath, secret, port: fixture.agent.port });
    const before = forwarder.log.length;
    const mints = [];
    let readinessChecks = 0;
    const verified = toolPayload(await pool.request({
        key, hostPort: forwarder.port, method: 'tools/call',
        params: { name: 'actor', arguments: { label: 'after-restart' } },
        headers: minter(secret, BOB, { label: 'after-restart' }, mints),
        beforeDial: () => true,
        ensureReady: async () => { readinessChecks += 1; return true; },
    }));
    assert.deepEqual(verified.actor, BOB);
    const after = forwarder.log.slice(before).filter((row) => row.httpMethod === 'POST');
    assert.deepEqual(after.map((row) => row.rpc), ['tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
    assert.equal(after[0].sessionId, oldSession);
    assert.notEqual(after[3].sessionId, oldSession);
    assert.equal(mints.length, 2, 'one mint per attempt');
    assert.notEqual(jtiOf(mints[0]), jtiOf(mints[1]), 'the retry never reuses the first jti');
    assert.equal(after[3].authorization, mints[1]);
    assert.equal(verified.jti, jtiOf(mints[1]));
    assert.equal(readinessChecks, 1, 'readiness runs before the retry');
    assert.equal(pool.snapshot().counters.retries, 1);
});

test('B5-5: beforeDial other than true raises EDGE_GENERATION_CHANGED with no upstream POST and no mint', async (t) => {
    const upstream = await startFakeUpstream(t);
    const pool = newPool(t);
    const key = keyFor({ port: upstream.port });
    let mints = 0;
    const headers = () => { mints += 1; return { authorization: 'Bearer test-token' }; };
    for (const beforeDial of [() => false, () => undefined, () => Promise.resolve(true)]) {
        await assert.rejects(pool.request({
            key, hostPort: upstream.port, method: 'tools/call', params: { name: 'x', arguments: {} }, headers, beforeDial,
        }), (error) => error.code === 'EDGE_GENERATION_CHANGED');
    }
    assert.equal(upstream.log.length, 0, 'cold key: nothing sent');
    assert.equal(mints, 0);
    await pool.request({ key, hostPort: upstream.port, method: 'tools/call', params: { name: 'x', arguments: {} }, headers, beforeDial: () => true });
    const warm = upstream.log.length;
    let checks = 0;
    await assert.rejects(pool.request({
        key, hostPort: upstream.port, method: 'tools/call', params: { name: 'x', arguments: {} }, headers,
        beforeDial: () => { checks += 1; return false; },
    }), (error) => error.code === 'EDGE_GENERATION_CHANGED');
    assert.equal(checks, 1);
    assert.equal(upstream.log.length, warm, 'warm key: nothing sent');
    assert.equal(mints, 1, 'no mint after a failed generation check');
    let partialChecks = 0;
    const coldKey = keyFor({ port: upstream.port, lease: 'lease-cold' });
    await assert.rejects(pool.request({
        key: coldKey, hostPort: upstream.port, method: 'tools/call', params: { name: 'x', arguments: {} }, headers,
        beforeDial: () => { partialChecks += 1; return partialChecks === 1; },
    }), (error) => error.code === 'EDGE_GENERATION_CHANGED');
    const coldPosts = upstream.log.slice(warm).filter((row) => row.httpMethod === 'POST').map((row) => row.rpc);
    assert.deepEqual(coldPosts, ['initialize'], 'a check failing during session open stops before the next POST');
});

test('B5-6: a new lease id for the route deletes the old session and opens a new one', async (t) => {
    const { secret, forwarder } = await startEchoAgentBehindForwarder(t);
    const pool = newPool(t);
    const oldKey = keyFor({ port: forwarder.port, lease: 'lease-1' });
    const newKey = keyFor({ port: forwarder.port, lease: 'lease-2' });
    const mints = [];
    const call = (key, label) => pool.request({
        key, hostPort: forwarder.port, method: 'tools/call',
        params: { name: 'actor', arguments: { label } },
        headers: minter(secret, ALICE, { label }, mints),
        beforeDial: () => true,
    });
    toolPayload(await call(oldKey, 'lease-1'));
    const oldSession = pool.snapshot().entries.find((entry) => entry.key === oldKey).sessionId;
    assert.ok(oldSession);
    toolPayload(await call(newKey, 'lease-2'));
    assert.ok(await waitFor(() => forwarder.log.some((row) => row.httpMethod === 'DELETE' && row.sessionId === oldSession)),
        'DELETE for the old session');
    assert.equal(count(forwarder.log, (row) => row.rpc === 'initialize'), 2);
    const snapshot = pool.snapshot();
    assert.deepEqual(snapshot.entries.map((entry) => entry.key), [newKey]);
    assert.notEqual(snapshot.entries[0].sessionId, oldSession);
    assert.equal(pool.isReady(oldKey), false);
});

test('B5-7: a socket reset after the body was sent is not retried', async (t) => {
    const upstream = await startFakeUpstream(t, {
        onRpc: ({ req, message }) => {
            if (message?.method !== 'tools/call') return false;
            req.socket.destroy();
            return true;
        },
    });
    const pool = newPool(t);
    const key = keyFor({ port: upstream.port });
    let mints = 0;
    let readinessChecks = 0;
    await assert.rejects(pool.request({
        key, hostPort: upstream.port, method: 'tools/call', params: { name: 'x', arguments: {} },
        headers: () => { mints += 1; return { authorization: `Bearer token-${mints}` }; },
        beforeDial: () => true,
        ensureReady: async () => { readinessChecks += 1; return true; },
    }), (error) => error.code === 'UPSTREAM_TRANSPORT' && !error.retryable);
    assert.equal(count(upstream.log, (row) => row.rpc === 'tools/call'), 1, 'exactly one attempt');
    assert.equal(mints, 1);
    assert.equal(readinessChecks, 0);
    assert.equal(pool.snapshot().entries.length, 0, 'the entry is evicted');
    assert.equal(pool.isReady(key), false);
});

test('B5-9: snapshot and entries hold no tokens', async (t) => {
    const { secret, forwarder } = await startEchoAgentBehindForwarder(t);
    const pool = newPool(t);
    const key = keyFor({ port: forwarder.port });
    const mints = [];
    for (let index = 0; index < 3; index += 1) {
        const args = { label: `snapshot-${index}` };
        toolPayload(await pool.request({
            key, hostPort: forwarder.port, method: 'tools/call',
            params: { name: 'actor', arguments: args },
            headers: minter(secret, ALICE, args, mints),
            beforeDial: () => true,
        }));
    }
    const serialized = JSON.stringify(pool.snapshot());
    assert.doesNotMatch(serialized, /Bearer|eyJ/);
    for (const authorization of mints) {
        assert.equal(serialized.includes(authorization.slice(7)), false);
    }
    assert.equal(pool.snapshot().entries[0].ready, true);
});

test('B5-11: pooled sockets survive a short server keep-alive and free sockets idle out after 2 s', async (t) => {
    const short = await startFakeUpstream(t, { keepAliveTimeout: 100 });
    const pool = newPool(t);
    const shortKey = keyFor({ port: short.port });
    const call = (key, port) => pool.request({
        key, hostPort: port, method: 'tools/call', params: { name: 'x', arguments: {} },
        headers: { authorization: 'Bearer test-token' }, beforeDial: () => true,
    });
    await call(shortKey, short.port);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const before = short.log.length;
    const message = await call(shortKey, short.port);
    assert.equal(message.result.content[0].text, 'fake-ok');
    assert.deepEqual(short.log.slice(before).map((row) => row.rpc), ['tools/call'], 'exactly one attempt');
    assert.equal(pool.snapshot().counters.retries, 0);

    const long = await startFakeUpstream(t, { keepAliveTimeout: 10_000 });
    const longKey = keyFor({ port: long.port, routeKey: 'otherAgent' });
    await call(longKey, long.port);
    const opened = long.connections;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await call(longKey, long.port);
    assert.equal(long.connections, opened, 'a free socket is reused within 2 s');
    await new Promise((resolve) => setTimeout(resolve, 2_400));
    await call(longKey, long.port);
    assert.equal(long.connections, opened + 1, 'a free socket idle for more than 2 s is not reused');
});

test('B5-12 (pool): non-JSON or mismatched answers evict the entry and mark the key for the SDK path', async (t) => {
    const sse = await startFakeUpstream(t, {
        onRpc: ({ res, message }) => {
            if (message?.method !== 'initialize') return false;
            res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sse-session' });
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {} } })}\n\n`);
            return true;
        },
    });
    const plain = await startFakeUpstream(t, {
        onRpc: ({ res }) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ok');
            return true;
        },
    });
    const wrongId = await startFakeUpstream(t, {
        onRpc: ({ res, message }) => {
            if (message?.method !== 'tools/call') return false;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 'not-the-sent-id', result: {} }));
            return true;
        },
    });
    const pool = newPool(t);
    let mints = 0;
    const headers = () => { mints += 1; return { authorization: 'Bearer test-token' }; };
    const cases = [
        { upstream: sse, routeKey: 'sseAgent', dispatched: false },
        { upstream: plain, routeKey: 'plainAgent', dispatched: false },
        { upstream: wrongId, routeKey: 'wrongIdAgent', dispatched: true },
    ];
    for (const [index, { upstream, routeKey, dispatched }] of cases.entries()) {
        const key = keyFor({ port: upstream.port, routeKey });
        await assert.rejects(pool.request({
            key, hostPort: upstream.port, method: 'tools/call', params: { name: 'x', arguments: {} }, headers,
            beforeDial: () => true,
        }), (error) => error.code === 'UPSTREAM_TRANSPORT' && error.poolMismatch === true && error.dispatched === dispatched);
        assert.equal(pool.usesFallback(key), true);
        assert.equal(pool.isReady(key), false);
        assert.equal(pool.snapshot().counters.fallbacks, index + 1);
        assert.equal(pool.snapshot().entries.some((entry) => entry.key === key), false, 'entry evicted');
    }
    assert.equal(count(sse.log, (row) => row.rpc === 'tools/call'), 0, 'mismatch during session open sends no call');
    assert.equal(count(wrongId.log, (row) => row.rpc === 'tools/call'), 1, 'a dispatched call is never re-sent');
    assert.equal(mints, 1);
    assert.ok(await waitFor(() => sse.log.some((row) => row.httpMethod === 'DELETE' && row.sessionId === 'sse-session')));
});

test('B5-13: the unit-test MCP SDK is the commit the Box image provides', async () => {
    const entry = fileURLToPath(import.meta.resolve('mcp-sdk'));
    const packageDir = path.dirname(entry);
    // AgentServer.mjs and this file resolve mcp-sdk from the same repository
    // node_modules, so this is the SDK test B5-2 ran against.
    let resolvedCommit = '';
    let source = '';
    const provenancePath = path.join(packageDir, '.ploinky-box-mcp-sdk.json');
    if (fsSync.existsSync(provenancePath)) {
        resolvedCommit = String(JSON.parse(fsSync.readFileSync(provenancePath, 'utf8')).commit || '');
        source = provenancePath;
    } else {
        const lockPath = path.join(path.dirname(packageDir), '.package-lock.json');
        const lock = JSON.parse(fsSync.readFileSync(lockPath, 'utf8'));
        const resolved = String(lock?.packages?.[`node_modules/${path.basename(packageDir)}`]?.resolved || '');
        resolvedCommit = resolved.includes('#') ? resolved.slice(resolved.lastIndexOf('#') + 1) : '';
        source = `${lockPath} (${resolved})`;
    }
    const indexSha256 = crypto.createHash('sha256').update(fsSync.readFileSync(entry)).digest('hex');
    const record = { image: BOX_IMAGE_MCP_SDK, resolved: { commit: resolvedCommit, source, indexSha256 } };
    console.log(`[mcp-sdk pin] ${JSON.stringify(record)}`);
    assert.match(resolvedCommit, /^[0-9a-f]{40}$/, `resolved MCP SDK commit unknown: ${JSON.stringify(record)}`);
    assert.equal(resolvedCommit, BOX_IMAGE_MCP_SDK.commit, `MCP SDK commit differs from the Box image: ${JSON.stringify(record)}`);
    if (BOX_IMAGE_MCP_SDK.indexSha256) {
        assert.equal(indexSha256, BOX_IMAGE_MCP_SDK.indexSha256, `MCP SDK bytes differ from the Box image: ${JSON.stringify(record)}`);
    }
});
