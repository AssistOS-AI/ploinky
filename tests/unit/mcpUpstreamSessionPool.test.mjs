import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
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
            || name === 'PLOINKY_EDGE_TOPOLOGY_FILE'
            || name === 'PLOINKY_MASTER_KEY'
            || name === 'PLOINKY_WORKSPACE_ROOT') {
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
                at: Date.now(),
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
                state.sessions = (state.sessions || 0) + 1;
                json({ jsonrpc: '2.0', id: message.id, result: {
                    protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' },
                } }, { 'mcp-session-id': `${state.sessionId}-${state.sessions}` });
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

async function startEchoAgentBehindForwarder(t, { port = null, secret = crypto.randomBytes(32), audience = AUDIENCE } = {}) {
    const tmp = await createTempDir(t);
    const { configPath, invocations } = await writeEchoAgentConfig(tmp);
    const agent = await startAgentServer(t, { tmp, configPath, secret, port, audience });
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
    assert.equal(count(upstream.log.slice(warm), (row) => row.httpMethod === 'POST'), 0, 'warm key: no POST sent');
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

test('idle sessions, LRU overflow and closeAll evict entries with a best-effort DELETE', async (t) => {
    const upstream = await startFakeUpstream(t);
    let clock = 1_000_000;
    const pool = newPool(t, { maxEntries: 2, now: () => clock });
    const call = (routeKey) => pool.request({
        key: keyFor({ port: upstream.port, routeKey }), hostPort: upstream.port, method: 'tools/call',
        params: { name: 'x', arguments: {} }, headers: { authorization: 'Bearer test-token' }, beforeDial: () => true,
    });
    const sessionOf = (routeKey) => pool.snapshot().entries
        .find((entry) => entry.key === keyFor({ port: upstream.port, routeKey }))?.sessionId;
    const deleted = (sessionId) => upstream.log.some((row) => row.httpMethod === 'DELETE' && row.sessionId === sessionId);

    await call('agentA');
    const idleSession = sessionOf('agentA');
    clock += 60_001;
    await call('agentA');
    assert.ok(await waitFor(() => deleted(idleSession)), 'idle > 60 s: DELETE');
    assert.notEqual(sessionOf('agentA'), idleSession);
    assert.equal(count(upstream.log, (row) => row.rpc === 'initialize'), 2);

    const lruVictim = sessionOf('agentA');
    await call('agentB');
    await call('agentC');
    assert.ok(await waitFor(() => deleted(lruVictim)), 'LRU overflow: DELETE of the least recently used entry');
    assert.deepEqual(pool.snapshot().entries.map((entry) => JSON.parse(entry.key)[0]), ['agentB', 'agentC']);

    const remaining = pool.snapshot().entries.map((entry) => entry.sessionId);
    await pool.closeAll();
    for (const sessionId of remaining) assert.equal(deleted(sessionId), true, `closeAll: DELETE ${sessionId}`);
    assert.deepEqual(pool.snapshot().entries, []);
    assert.equal(pool.snapshot().counters.deletes, 4);
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

// ---------------------------------------------------------------------------
// Proxy integration (cli/server/mcp-proxy/index.js) through handleAgentMcpRequest:
// readiness cache, kill switch, SDK fallback and the generation check.

const PROXY_CONTAINER = 'pool-echo-agent-container';
const PROXY_USER = { id: 'alice', username: 'alice', roles: ['user'] };
const PROXY_ACTOR = { kind: 'user', id: 'user:alice', roles: ['user'] };
let proxyFixturePromise = null;
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(['PLOINKY_MASTER_KEY', 'PLOINKY_WORKSPACE_ROOT', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MCP_UPSTREAM_POOL']
    .map((name) => [name, process.env[name]]));

test.after(async () => {
    if (!proxyFixturePromise) return;
    const { workspace, proxy } = await proxyFixturePromise;
    await proxy.agentUpstreamSessionPool.closeAll();
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fsSync.rmSync(workspace, { recursive: true, force: true });
});

function loadProxyFixture() {
    if (proxyFixturePromise) return proxyFixturePromise;
    proxyFixturePromise = (async () => {
        const workspace = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mcp-pool-proxy-'));
        const ploinkyDir = path.join(workspace, '.ploinky');
        const agentDir = path.join(ploinkyDir, 'repos', 'PoolTest', 'echoAgent');
        fsSync.mkdirSync(agentDir, { recursive: true });
        fsSync.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({ about: 'pool proxy fixture' }));
        fsSync.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({ routes: { echoAgent: {
            repo: 'PoolTest', agent: 'echoAgent', container: PROXY_CONTAINER, hostPath: agentDir, hostPort: 7401,
        } } }));
        fsSync.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({ [PROXY_CONTAINER]: {
            type: 'agent', repoName: 'PoolTest', agentName: 'echoAgent',
            instanceId: 'proxy-instance', enableGeneration: 'proxy-enable', auth: { mode: 'none' },
        } }));
        fsSync.mkdirSync(path.join(ploinkyDir, 'data', 'edge-routing'), { recursive: true });
        fsSync.mkdirSync(path.join(ploinkyDir, 'data', 'router-security'), { recursive: true });
        fsSync.writeFileSync(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), JSON.stringify({ hosts: {} }));
        fsSync.writeFileSync(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), JSON.stringify({
            schema: 'router-policy',
            httpRoutes: [],
            mcpTools: [{ agent: 'echoAgent', tool: 'actor', access: 'authenticated', enabled: true }],
        }));
        process.chdir(workspace);
        process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
        process.env.PLOINKY_WORKSPACE_ROOT = workspace;
        process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
        const { applyEdgeRoutingGeneration } = await import('../../cli/sandbox/edgeGeneration.js');
        applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'mcp-upstream-pool-test-fixture' });
        const proxy = await import('../../cli/server/mcp-proxy/index.js');
        const { deriveAgentRequestSecret } = await import('../../cli/utils/security/masterKey.js');
        const audience = proxy.buildInvocationContextForProviderCall({
            req: { user: PROXY_USER }, agentName: 'echoAgent', toolName: 'actor', toolArgs: {},
        }).payload.aud;
        assert.match(audience, /^agent:/);
        return { workspace, proxy, audience, secret: deriveAgentRequestSecret(audience) };
    })();
    return proxyFixturePromise;
}

function proxyRoute(port, lease, manifest) {
    const route = { repo: 'PoolTest', agent: 'echoAgent', container: PROXY_CONTAINER, hostPort: port };
    const snapshot = {
        routing: { routes: { echoAgent: route } },
        agents: { [PROXY_CONTAINER]: {
            type: 'agent', repoName: 'PoolTest', agentName: 'echoAgent',
            containerId: 'd'.repeat(64), instanceId: 'proxy-instance', enableGeneration: 'proxy-enable',
        } },
        ...(manifest === undefined ? {} : { manifests: { echoAgent: manifest } }),
    };
    const routePlan = {
        ok: true,
        kind: 'agent-root',
        routeKey: 'echoAgent',
        lease: { id: lease, snapshot },
        target: { hostname: '127.0.0.1', hostPort: port },
        route,
        snapshot,
    };
    return { route, routePlan, key: poolKeyForRoutePlan(routePlan) };
}

function openRouterSession(proxy) {
    const sessionId = crypto.randomUUID();
    proxy.agentSessionStore.set(sessionId, { agentName: 'echoAgent', baseUrl: 'http://127.0.0.1/mcp' });
    return sessionId;
}

function readinessSpy(result = true) {
    const spy = { calls: 0, result };
    spy.fn = async () => { spy.calls += 1; return spy.result; };
    return spy;
}

let proxyRpcId = 0;
function toolsCall(label) {
    proxyRpcId += 1;
    return { jsonrpc: '2.0', id: proxyRpcId, method: 'tools/call', params: { name: 'actor', arguments: { label } } };
}

async function proxyCall(proxy, { route, routePlan, sessionId, body, pool, waitForAgentReady, beforeDial = () => true, agent = null }) {
    const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]);
    req.method = 'POST';
    req.url = '/echoAgent/mcp';
    req.headers = { host: 'localhost', 'content-type': 'application/json', 'mcp-session-id': sessionId };
    req.user = PROXY_USER;
    if (agent) req.agent = agent;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const res = {
        statusCode: 0,
        body: '',
        writeHead(statusCode) { this.statusCode = statusCode; },
        end(chunk = '') { this.body += String(chunk); finish(); },
    };
    await proxy.handleAgentMcpRequest(req, res, route, 'echoAgent', { beforeDial, routePlan, pool, waitForAgentReady });
    await done;
    return { status: res.statusCode, json: JSON.parse(res.body), sessionStoreSize: proxy.agentSessionStore.size };
}

function proxyToolPayload(json) {
    assert.equal(json.error, undefined, JSON.stringify(json));
    assert.equal(json.result?.isError, undefined, JSON.stringify(json));
    return JSON.parse(json.result.content[0].text);
}

test('B5-8: the readiness cache skips the probe while pooled calls succeed and is cleared by ECONNREFUSED', async (t) => {
    const { proxy, audience, secret } = await loadProxyFixture();
    const { forwarder } = await startEchoAgentBehindForwarder(t, { secret, audience });
    const pool = newPool(t);
    const readiness = readinessSpy(true);
    const { route, routePlan, key } = proxyRoute(forwarder.port, 'lease-b5-8');
    const sessionId = openRouterSession(proxy);
    const call = (label) => proxyCall(proxy, { route, routePlan, sessionId, pool, waitForAgentReady: readiness.fn, body: toolsCall(label) });
    const startedAt = Date.now();
    for (let index = 0; index < 10; index += 1) {
        const verified = proxyToolPayload((await call(`b5-8-${index}`)).json);
        assert.deepEqual(verified.actor, PROXY_ACTOR);
        assert.deepEqual(verified.input, { label: `b5-8-${index}` });
    }
    assert.ok(Date.now() - startedAt < 10_000, 'the 10 calls ran inside the 10 s readiness TTL');
    assert.equal(readiness.calls, 1, '10 calls -> 1 readiness probe');
    assert.equal(count(forwarder.log, (row) => row.rpc === 'initialize'), 1);
    assert.equal(count(forwarder.log, (row) => row.rpc === 'tools/call'), 10);
    const listed = await proxyCall(proxy, { route, routePlan, sessionId, pool, waitForAgentReady: readiness.fn,
        body: { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} } });
    assert.deepEqual(listed.json.result.tools.map((tool) => tool.name), ['actor']);
    assert.equal(readiness.calls, 1);
    assert.equal(count(forwarder.log, (row) => row.rpc === 'initialize'), 1);
    assert.equal(pool.isReady(key), true);

    await forwarder.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    readiness.result = false;
    const requestsBefore = pool.snapshot().counters.requests;
    const refused = await call('b5-8-refused');
    assert.match(refused.json.error?.message || '', /still starting/);
    assert.equal(readiness.calls, 2, 'cache hit, then one readiness check before the single retry');
    assert.equal(pool.snapshot().counters.requests, requestsBefore + 1, 'one refused attempt');
    assert.equal(pool.isReady(key), false);
    const next = await call('b5-8-next');
    assert.equal(readiness.calls, 3, 'the next call probes again');
    assert.match(next.json.error?.message || '', /still starting/);
    assert.equal(pool.snapshot().counters.requests, requestsBefore + 1, 'no upstream request without readiness');
});

test('B5-10: PLOINKY_MCP_UPSTREAM_POOL=0 restores one upstream initialize per call; unset pools again', async (t) => {
    const { proxy, audience, secret } = await loadProxyFixture();
    const { forwarder } = await startEchoAgentBehindForwarder(t, { secret, audience });
    const pool = newPool(t);
    const readiness = readinessSpy(true);
    const { route, routePlan } = proxyRoute(forwarder.port, 'lease-b5-10');
    const sessionId = openRouterSession(proxy);
    const prior = process.env.PLOINKY_MCP_UPSTREAM_POOL;
    t.after(() => {
        if (prior === undefined) delete process.env.PLOINKY_MCP_UPSTREAM_POOL;
        else process.env.PLOINKY_MCP_UPSTREAM_POOL = prior;
    });
    const initializes = () => count(forwarder.log, (row) => row.rpc === 'initialize');
    const callFive = async (phase) => {
        for (let index = 0; index < 5; index += 1) {
            const verified = proxyToolPayload((await proxyCall(proxy, {
                route, routePlan, sessionId, pool, waitForAgentReady: readiness.fn, body: toolsCall(`${phase}-${index}`),
            })).json);
            assert.deepEqual(verified.actor, PROXY_ACTOR);
        }
    };
    delete process.env.PLOINKY_MCP_UPSTREAM_POOL;
    await callFive('pooled');
    assert.equal(initializes(), 1, 'pooled: one initialize for five calls');
    assert.equal(readiness.calls, 1);
    const pooledRequests = pool.snapshot().counters.requests;

    process.env.PLOINKY_MCP_UPSTREAM_POOL = '0';
    await callFive('kill-switch');
    assert.equal(initializes(), 1 + 5, 'kill switch: one initialize per call');
    assert.equal(readiness.calls, 1 + 5, 'kill switch: one readiness probe per call');
    assert.equal(pool.snapshot().counters.requests, pooledRequests, 'kill switch: the pool is not used');

    delete process.env.PLOINKY_MCP_UPSTREAM_POOL;
    await callFive('pooled-again');
    assert.equal(initializes(), 1 + 5, 'pooled again: the existing session is reused');
});

test('B5-12 (proxy): a non-JSON upstream is served through the SDK path; a dispatched call is never re-sent', async (t) => {
    const { proxy } = await loadProxyFixture();
    const sse = await startFakeUpstream(t, {
        onRpc: ({ req, res, message, state }) => {
            if (req.method === 'GET') {
                res.writeHead(405);
                res.end();
                return true;
            }
            if (message?.method === 'notifications/initialized') {
                res.writeHead(202);
                res.end();
                return true;
            }
            let result = {};
            if (message?.method === 'initialize') {
                result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sse-fake', version: '1' } };
            } else if (message?.method === 'tools/list') {
                result = { tools: [{ name: 'actor', inputSchema: { type: 'object' } }] };
            } else if (message?.method === 'tools/call') {
                result = { content: [{ type: 'text', text: 'sse-ok' }] };
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': state.sessionId });
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message?.id, result })}\n\n`);
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
    const sessionId = openRouterSession(proxy);
    const readiness = readinessSpy(true);
    const run = async (upstream, lease, pool) => {
        const { route, routePlan, key } = proxyRoute(upstream.port, lease);
        const response = await proxyCall(proxy, { route, routePlan, sessionId, pool, waitForAgentReady: readiness.fn, body: toolsCall(lease) });
        return { response, key };
    };

    const ssePool = newPool(t);
    const sseRun = await run(sse, 'lease-sse', ssePool);
    assert.equal(sseRun.response.json.result?.content?.[0]?.text, 'sse-ok', JSON.stringify(sseRun.response.json));
    assert.equal(ssePool.snapshot().counters.fallbacks, 1, 'fallback counter increments');
    assert.equal(ssePool.usesFallback(sseRun.key), true);
    assert.ok(count(sse.log, (row) => row.rpc === 'initialize') >= 2, 'pool initialize, then the SDK client');
    assert.equal(count(sse.log, (row) => row.rpc === 'tools/call'), 1);
    const poolRequests = ssePool.snapshot().counters.requests;
    const again = await run(sse, 'lease-sse', ssePool);
    assert.equal(again.response.json.result?.content?.[0]?.text, 'sse-ok');
    assert.equal(ssePool.snapshot().counters.requests, poolRequests, 'a fallback key skips the pool');
    assert.equal(ssePool.snapshot().counters.fallbacks, 1);

    const plainPool = newPool(t);
    const plainRun = await run(plain, 'lease-plain', plainPool);
    assert.match(plainRun.response.json.error?.message || '', /content type/i, JSON.stringify(plainRun.response.json));
    assert.doesNotMatch(plainRun.response.json.error.message, /not poolable/, 'the error comes from the SDK path');
    assert.equal(plainPool.snapshot().counters.fallbacks, 1);
    assert.ok(count(plain.log, (row) => row.rpc === 'initialize') >= 2, 'pool initialize, then the SDK client');

    const wrongPool = newPool(t);
    const wrongRun = await run(wrongId, 'lease-wrong-id', wrongPool);
    assert.match(wrongRun.response.json.error?.message || '', /not poolable/);
    assert.equal(count(wrongId.log, (row) => row.rpc === 'tools/call'), 1, 'the dispatched call is not re-sent');
    assert.equal(wrongPool.usesFallback(wrongRun.key), true);
    assert.equal(wrongPool.snapshot().counters.fallbacks, 1);
});

test('proxy: a generation change before the pooled POST fails closed and sends no call', async (t) => {
    const { proxy, audience, secret } = await loadProxyFixture();
    const { forwarder } = await startEchoAgentBehindForwarder(t, { secret, audience });
    const pool = newPool(t);
    const readiness = readinessSpy(true);
    const { route, routePlan } = proxyRoute(forwarder.port, 'lease-generation');
    const sessionId = openRouterSession(proxy);
    proxyToolPayload((await proxyCall(proxy, { route, routePlan, sessionId, pool, waitForAgentReady: readiness.fn, body: toolsCall('warm') })).json);
    const callsBefore = count(forwarder.log, (row) => row.rpc === 'tools/call');
    let checks = 0;
    const stale = await proxyCall(proxy, {
        route, routePlan, sessionId, pool, waitForAgentReady: readiness.fn, body: toolsCall('stale'),
        beforeDial: () => { checks += 1; return false; },
    });
    assert.match(stale.json.error?.message || '', /edge routing generation changed/);
    assert.ok(checks >= 1);
    assert.equal(count(forwarder.log, (row) => row.rpc === 'tools/call'), callsBefore);
});

// ---------------------------------------------------------------------------
// Pool-owned queue: at most 8 requests in flight per entry; a queued request
// runs its generation check and mint only when granted, and its wait is bounded.

async function startHoldingUpstream(t, holdMs) {
    const stats = { concurrentCalls: 0, maxConcurrentCalls: 0 };
    const upstream = await startFakeUpstream(t, {
        onRpc: async ({ res, message }) => {
            if (message?.method !== 'tools/call' && message?.method !== 'tools/list') return false;
            stats.concurrentCalls += 1;
            stats.maxConcurrentCalls = Math.max(stats.maxConcurrentCalls, stats.concurrentCalls);
            const hold = message?.params?.name === 'slow' ? holdMs : 0;
            await new Promise((resolve) => setTimeout(resolve, hold));
            stats.concurrentCalls -= 1;
            const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
                content: [{ type: 'text', text: message?.params?.name || message.method }],
                tools: [],
            } }));
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': data.length });
            res.end(data);
            return true;
        },
    });
    return { upstream, stats };
}

test('queue: a request granted after a generation change is never sent or minted', async (t) => {
    const { upstream, stats } = await startHoldingUpstream(t, 600);
    const pool = newPool(t);
    const key = keyFor({ port: upstream.port });
    const call = (name, extra = {}) => pool.request({
        key, hostPort: upstream.port, method: 'tools/call', params: { name, arguments: {} },
        headers: { authorization: 'Bearer test-token' }, beforeDial: () => true, ...extra,
    });
    await call('warm');
    const slow = Array.from({ length: 8 }, () => call('slow'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    let generationActive = true;
    const checks = [];
    let mints = 0;
    const ninth = call('ninth', {
        headers: () => { mints += 1; return { authorization: 'Bearer ninth' }; },
        beforeDial: () => { checks.push(generationActive); return generationActive; },
    });
    let tenthMints = 0;
    const tenth = call('tenth', { headers: () => { tenthMints += 1; return { authorization: 'Bearer tenth' }; } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(checks, [], 'no generation check while queued');
    generationActive = false;
    await assert.rejects(ninth, (error) => error.code === 'EDGE_GENERATION_CHANGED');
    for (const result of await Promise.allSettled(slow)) assert.equal(result.status, 'fulfilled');
    assert.deepEqual(checks, [false], 'checked once, when granted, after the generation change');
    assert.equal(mints, 0, 'never minted');
    assert.equal(upstream.log.some((row) => row.authorization === 'Bearer ninth'), false, 'never sent');
    assert.ok(stats.maxConcurrentCalls <= 8, `at most 8 in flight, saw ${stats.maxConcurrentCalls}`);
    // A queued request whose own generation check passes still goes out, minted once.
    const tenthResult = await tenth;
    assert.equal(tenthResult.result.content[0].text, 'tenth');
    assert.equal(tenthMints, 1);
});

test('queue: a queued tools/list times out on its own deadline without sending anything', async (t) => {
    const { upstream, stats } = await startHoldingUpstream(t, 1500);
    const pool = newPool(t);
    const key = keyFor({ port: upstream.port });
    const call = (name) => pool.request({
        key, hostPort: upstream.port, method: 'tools/call', params: { name, arguments: {} },
        headers: { authorization: 'Bearer test-token' }, beforeDial: () => true,
    });
    await call('warm');
    const slow = Array.from({ length: 8 }, () => call('slow'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    let checks = 0;
    const startedAt = Date.now();
    await assert.rejects(pool.request({
        key, hostPort: upstream.port, method: 'tools/list', params: {}, headers: null, timeoutMs: 300,
        beforeDial: () => { checks += 1; return true; },
    }), (error) => error.code === 'UPSTREAM_TRANSPORT' && error.timedOut === true && error.queued === true);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 250 && elapsed < 1000, `timed out after ${elapsed} ms, expected about 300 ms`);
    assert.equal(checks, 0);
    assert.equal(pool.isReady(key), false, 'a queue timeout drops readiness');
    for (const result of await Promise.allSettled(slow)) assert.equal(result.status, 'fulfilled');
    assert.equal(upstream.log.some((row) => row.rpc === 'tools/list'), false, 'the timed-out request was never sent');
    assert.ok(stats.maxConcurrentCalls <= 8);
    assert.equal(pool.snapshot().entries.length, 1, 'the busy session itself is kept');
    // FIFO queue still works: a 10th request after the slow batch is served.
    const after = await call('after');
    assert.equal(after.result.content[0].text, 'after');
});

// Each held response is an explicit barrier. No wall-clock delay decides when
// a call has dispatched or a DELETE has been acknowledged.
function shutdownHarness(t, hold = () => false) {
    const log = [];
    const agents = [];
    const observers = [];
    const mints = [];
    let cleaning = false;
    const httpImpl = {
        Agent: class {
            constructor() { this.destroys = 0; agents.push(this); }
            destroy() { this.destroys += 1; }
        },
        request(options) {
            const req = new EventEmitter();
            req.destroy = () => { req.destroyed = true; };
            req.end = (payload) => {
                const message = payload ? JSON.parse(payload.toString()) : null;
                const row = { method: options.method, rpc: message?.method, name: message?.params?.name,
                    sessionId: options.headers['mcp-session-id'], port: options.port, req, settled: false };
                row.reply = ({ status = 200, body, headers = {} } = {}) => {
                    if (row.settled) return;
                    row.settled = true;
                    const res = new EventEmitter();
                    res.statusCode = status;
                    res.headers = { 'content-type': 'application/json', ...headers };
                    if (row.rpc === 'initialize') res.headers['mcp-session-id'] = `session-${options.port}`;
                    res.resume = () => {};
                    req.emit('response', res);
                    const answer = body ?? { jsonrpc: '2.0', id: message?.id,
                        result: { protocolVersion: '2025-06-18', content: [{ type: 'text', text: row.name }] } };
                    if (row.method !== 'DELETE') res.emit('data', Buffer.from(JSON.stringify(answer)));
                    res.emit('end');
                };
                row.fail = () => {
                    if (row.settled) return;
                    row.settled = true;
                    req.emit('error', new Error('controlled transport failure'));
                };
                log.push(row);
                for (const notify of [...observers]) notify();
                if (cleaning || !hold(row)) queueMicrotask(() => row.reply());
            };
            return req;
        },
    };
    const pool = createUpstreamSessionPool({ httpImpl });
    const key = (port = 7001) => keyFor({ port, routeKey: `shutdown-${port}` });
    const call = (name, extra = {}, port = 7001) => pool.request({
        key: key(port), hostPort: port, method: 'tools/call', params: { name, arguments: {} },
        beforeDial: () => true, headers: () => { mints.push(name); return null; }, timeoutMs: 2000, ...extra,
    });
    const until = (predicate) => new Promise((resolve) => {
        const notify = () => {
            if (!predicate(log)) return;
            const index = observers.indexOf(notify);
            if (index >= 0) observers.splice(index, 1);
            resolve();
        };
        observers.push(notify);
        notify();
    });
    t.after(async () => {
        cleaning = true;
        for (const row of log) row.reply();
        await pool.closeAll();
    });
    return { pool, call, key, until, log, agents, mints };
}

const shutdownTurn = () => new Promise((resolve) => setImmediate(resolve));
const shutdownError = (error) => error?.code === 'UPSTREAM_SESSION_LOST'
    && error.retryable === false && !error.poolMismatch && /session closed/.test(error.message);

test('shutdown: new work after close cannot mint or POST', { timeout: 5000 }, async (t) => {
    const h = shutdownHarness(t);
    await h.pool.closeAll();
    const outcome = await h.call('forbidden').then(() => null, (error) => error);
    assert.deepEqual(h.mints, [], 'no credential mint after shutdown');
    assert.deepEqual(h.log, [], 'no initialization or tool POST after shutdown');
    assert.ok(shutdownError(outcome));
    assert.deepEqual(h.agents, [], 'no transport created after shutdown');
});

test('shutdown: closeAll waits for busy replies and DELETE acknowledgment, and closes idle entries promptly',
    { timeout: 5000 }, async (t) => {
        const h = shutdownHarness(t, (row) => row.name === 'slow' || (row.method === 'DELETE' && row.port === 7001));
        await h.call('warm');
        await h.call('idle', {}, 7002);
        const slow = Array.from({ length: 8 }, () => h.call('slow'));
        await h.until((log) => log.filter((row) => row.name === 'slow').length === 8);
        const queued = Array.from({ length: 4 }, () => h.call('queued').catch((error) => error));
        await shutdownTurn();
        let completed = false;
        const closing = h.pool.closeAll();
        closing.then(() => { completed = true; });
        await h.until((log) => log.some((row) => row.method === 'DELETE' && row.port === 7002));
        await shutdownTurn();
        assert.equal(completed, false, 'closeAll must remain pending while busy calls are held');
        assert.equal(h.pool.closeAll(), closing, 'concurrent close calls share completion');
        assert.equal(h.agents[1].destroys, 1, 'idle agent destroyed while busy replies are held');
        assert.equal(h.log.some((row) => row.method === 'DELETE' && row.port === 7001), false);
        for (const error of await Promise.all(queued)) assert.ok(shutdownError(error));
        await assert.rejects(h.call('new'), shutdownError);
        assert.equal(h.mints.includes('queued') || h.mints.includes('new'), false);
        assert.equal(h.log.some((row) => row.name === 'queued' || row.name === 'new'), false);
        for (const row of h.log.filter((row) => row.name === 'slow')) row.reply();
        for (const result of await Promise.all(slow)) assert.equal(result.result.content[0].text, 'slow');
        await h.until((log) => log.some((row) => row.method === 'DELETE' && row.port === 7001));
        await shutdownTurn();
        assert.equal(completed, false, 'closeAll must wait for the busy DELETE acknowledgment');
        assert.equal(h.agents[0].destroys, 0);
        h.log.find((row) => row.method === 'DELETE' && row.port === 7001).reply();
        await closing;
        assert.equal(h.pool.closeAll(), closing, 'completed closure remains idempotent');
        assert.deepEqual(h.agents.map((agent) => agent.destroys), [1, 1]);
        assert.equal(h.log.filter((row) => row.method === 'DELETE').length, 2);
        assert.deepEqual(h.pool.snapshot().entries, []);
        assert.equal(h.pool.isReady(h.key()), false);
    });

test('shutdown: closeAll includes previously retired busy entries', { timeout: 5000 }, async (t) => {
    const h = shutdownHarness(t, (row) => row.name === 'slow' || row.method === 'DELETE');
    await h.call('warm');
    const slow = h.call('slow');
    await h.until((log) => log.some((row) => row.name === 'slow'));
    h.pool.invalidate(h.key());
    assert.deepEqual(h.pool.snapshot().entries, []);
    let completed = false;
    const closing = h.pool.closeAll().then(() => { completed = true; });
    await shutdownTurn();
    assert.equal(completed, false, 'retirement remains owned after removal from the map');
    h.log.find((row) => row.name === 'slow').reply();
    assert.equal((await slow).result.content[0].text, 'slow');
    await h.until((log) => log.some((row) => row.method === 'DELETE'));
    await shutdownTurn();
    assert.equal(completed, false);
    h.log.find((row) => row.method === 'DELETE').reply();
    await closing;
    assert.equal(h.agents[0].destroys, 1);
});

for (const [phase, failure] of [
    ['initialize', false], ['initialize', true],
    ['notifications/initialized', false], ['notifications/initialized', true],
]) {
    test(`shutdown: delayed ${phase} ${failure ? 'failure' : 'success'} cannot continue or lose session cleanup`,
        { timeout: 5000 }, async (t) => {
            const h = shutdownHarness(t, (row) => row.rpc === phase || row.method === 'DELETE');
            const request = h.call('undispatched').catch((error) => error);
            await h.until((log) => log.some((row) => row.rpc === phase));
            let completed = false;
            const closing = h.pool.closeAll().then(() => { completed = true; });
            await shutdownTurn();
            assert.equal(completed, false, 'opening is still owned');
            h.log.find((row) => row.rpc === phase).reply(failure ? { body: { invalid: true }, status: 500 } : {});
            assert.ok(shutdownError(await request));
            await h.until((log) => log.some((row) => row.method === 'DELETE'));
            await shutdownTurn();
            assert.equal(completed, false, 'the late session DELETE is still owned');
            assert.deepEqual(h.mints, []);
            assert.equal(h.log.some((row) => row.name === 'undispatched'), false);
            if (phase === 'initialize') assert.equal(h.log.some((row) => row.rpc === 'notifications/initialized'), false);
            const deletion = h.log.find((row) => row.method === 'DELETE');
            assert.equal(deletion.sessionId, 'session-7001');
            deletion.reply();
            await closing;
            assert.equal(h.agents[0].destroys, 1);
        });
}

for (const outcome of ['ready', 'not-ready', 'failure']) {
    test(`shutdown: suspended retry readiness ${outcome} cannot restart work`, { timeout: 5000 }, async (t) => {
        const h = shutdownHarness(t, (row) => row.name === 'retry');
        let finishReadiness;
        let readinessStarted;
        const entered = new Promise((resolve) => { readinessStarted = resolve; });
        const ready = new Promise((resolve, reject) => {
            finishReadiness = () => outcome === 'failure' ? reject(new Error('readiness failed')) : resolve(outcome === 'ready');
        });
        const request = h.call('retry', { ensureReady: () => { readinessStarted(); return ready; } })
            .catch((error) => error);
        await h.until((log) => log.some((row) => row.name === 'retry'));
        h.log.find((row) => row.name === 'retry').reply({ status: 404 });
        await entered;
        await h.pool.closeAll();
        const posts = h.log.filter((row) => row.method === 'POST').length;
        finishReadiness();
        assert.ok(shutdownError(await request));
        assert.equal(h.log.filter((row) => row.method === 'POST').length, posts);
        assert.deepEqual(h.mints, ['retry']);
        assert.deepEqual(h.pool.snapshot().entries, []);
        assert.deepEqual(h.pool.snapshot().fallbackKeys, []);
    });
}

test('shutdown: late malformed response refuses SDK fallback and does not repopulate fallback state',
    { timeout: 5000 }, async (t) => {
        const h = shutdownHarness(t, (row) => row.name === 'malformed');
        const request = h.call('malformed', { method: 'tools/list' }).catch((error) => error);
        await h.until((log) => log.some((row) => row.name === 'malformed'));
        const closing = h.pool.closeAll();
        h.log.find((row) => row.name === 'malformed').reply({ body: { invalid: true } });
        assert.ok(shutdownError(await request), 'no poolMismatch means the proxy cannot replay through the SDK');
        await closing;
        assert.deepEqual(h.pool.snapshot().fallbackKeys, []);
        assert.equal(h.pool.isReady(h.key()), false);
    });

for (const outcome of ['error', 'timeout']) {
    test(`shutdown: DELETE ${outcome} is bounded and destroys the agent once`, { timeout: 5000 }, async (t) => {
        const h = shutdownHarness(t, (row) => row.method === 'DELETE');
        await h.call('warm');
        const started = Date.now();
        const closing = h.pool.closeAll();
        await h.until((log) => log.some((row) => row.method === 'DELETE'));
        const deletion = h.log.find((row) => row.method === 'DELETE');
        // Keep the fake transport alive while the production DELETE timer is unref'd.
        const keepAlive = setInterval(() => {}, 100);
        try {
            if (outcome === 'error') deletion.fail();
            await closing;
        } finally {
            clearInterval(keepAlive);
        }
        const elapsed = Date.now() - started;
        if (outcome === 'timeout') {
            assert.equal(deletion.req.destroyed, true);
            assert.ok(elapsed >= 900 && elapsed < 3000, `bounded DELETE timeout: ${elapsed} ms`);
        }
        assert.equal(h.pool.closeAll(), closing);
        assert.equal(h.agents[0].destroys, 1);
        assert.equal(h.log.filter((row) => row.method === 'DELETE').length, 1);
    });
}

// ---------------------------------------------------------------------------
// Readiness cache (liveness only): dropped on any upstream failure and on any
// generation change.

test('readiness: every upstream failure drops the readiness entry', async (t) => {
    let mode = 'ok';
    const upstream = await startFakeUpstream(t, {
        onRpc: async ({ req, res, message }) => {
            if (message?.method !== 'tools/call' || mode === 'ok') return false;
            if (mode === 'reset') { req.socket.destroy(); return true; }
            if (mode === 'missing-session') {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }));
                return true;
            }
            if (mode === 'http-500') {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } }));
                return true;
            }
            if (mode === 'mismatch') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: 'other', result: {} }));
                return true;
            }
            if (mode === 'timeout') {
                await new Promise((resolve) => setTimeout(resolve, 400));
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
                return true;
            }
            return false;
        },
    });
    const pool = newPool(t);
    const key = keyFor({ port: upstream.port });
    const call = () => pool.request({
        key, hostPort: upstream.port, method: 'tools/call', params: { name: 'x', arguments: {} },
        headers: { authorization: 'Bearer test-token' }, beforeDial: () => true, timeoutMs: 200,
    });
    for (const failure of ['reset', 'missing-session', 'http-500', 'mismatch', 'timeout']) {
        mode = 'ok';
        await call();
        assert.equal(pool.isReady(key), true, `ready before ${failure}`);
        mode = failure;
        await assert.rejects(call(), (error) => error.code === 'UPSTREAM_TRANSPORT' || error.code === 'UPSTREAM_SESSION_LOST', failure);
        assert.equal(pool.isReady(key), false, `readiness dropped after ${failure}`);
        // The fallback mark from 'mismatch' would hide later keys; clear it.
        pool.invalidate(key);
    }
});

test('readiness: a generation change drops the readiness entry and the session', async (t) => {
    const upstream = await startFakeUpstream(t);
    const pool = newPool(t);
    const key = keyFor({ port: upstream.port, lease: 'lease-1' });
    const call = (callKey, beforeDial = () => true) => pool.request({
        key: callKey, hostPort: upstream.port, method: 'tools/call', params: { name: 'x', arguments: {} },
        headers: { authorization: 'Bearer test-token' }, beforeDial,
    });
    await call(key);
    assert.equal(pool.isReady(key), true);
    await assert.rejects(call(key, () => false), (error) => error.code === 'EDGE_GENERATION_CHANGED');
    assert.equal(pool.isReady(key), false, 'a failed generation check drops readiness');
    assert.equal(pool.snapshot().entries.length, 0, 'and the session of the stale lease');
    await call(key);
    assert.equal(count(upstream.log, (row) => row.rpc === 'initialize'), 2, 'the next call opens a new session');
    assert.equal(pool.isReady(key), true);
    await call(keyFor({ port: upstream.port, lease: 'lease-2' }));
    assert.equal(pool.isReady(key), false, 'a new lease for the route drops the old key');
});

test('readiness (proxy): after a generation change the next call probes again', async (t) => {
    const { proxy, audience, secret } = await loadProxyFixture();
    const { forwarder } = await startEchoAgentBehindForwarder(t, { secret, audience });
    const pool = newPool(t);
    const readiness = readinessSpy(true);
    const { route, routePlan, key } = proxyRoute(forwarder.port, 'lease-readiness-generation');
    const sessionId = openRouterSession(proxy);
    const call = (label, beforeDial = () => true) => proxyCall(proxy, {
        route, routePlan, sessionId, pool, waitForAgentReady: readiness.fn, body: toolsCall(label), beforeDial,
    });
    proxyToolPayload((await call('first')).json);
    proxyToolPayload((await call('cached')).json);
    assert.equal(readiness.calls, 1);
    assert.equal(pool.isReady(key), true);
    const stale = await call('stale', () => false);
    assert.match(stale.json.error?.message || '', /edge routing generation changed/);
    assert.equal(pool.isReady(key), false);
    proxyToolPayload((await call('after')).json);
    assert.equal(readiness.calls, 2, 'the call after a generation change runs the readiness probe');
});

test('provider principal: the supplied lease snapshot determines the target and an empty snapshot refuses', async () => {
    const { proxy, audience } = await loadProxyFixture();
    const { getAgentDescriptorByPrincipal } = await import('../../cli/utils/agentRegistry.js');
    const { deriveAgentPrincipalId } = await import('../../cli/utils/security/agentIdentity.js');
    const expected = deriveAgentPrincipalId('PoolTest', 'echoAgent');
    assert.equal(audience, expected);
    // The removed lookup asked the registry for `agent:<routeKey>`; real
    // principals are `agent:<repo>/<agent>`, so it never matched.
    assert.equal(getAgentDescriptorByPrincipal('agent:echoAgent'), null);
    assert.equal(getAgentDescriptorByPrincipal(expected)?.principalId, expected);
    const mint = (extra) => proxy.buildInvocationContextForProviderCall({
        req: { user: PROXY_USER }, agentName: 'echoAgent', toolName: 'actor', toolArgs: { label: 'x' }, ...extra,
    }).payload;
    const { routePlan } = proxyRoute(7401, 'principal-snapshot');
    for (const extra of [{}, { snapshot: undefined }, { snapshot: routePlan.lease.snapshot }]) {
        const payload = mint(extra);
        assert.equal(payload.aud, expected);
        assert.equal(payload.sub, 'user:alice');
        assert.equal(payload.tool, 'actor');
    }
    assert.throws(() => mint({ snapshot: { agents: {}, routing: { routes: {} } } }),
        /could not resolve provider 'echoAgent'/);
    const otherSnapshot = {
        agents: {},
        routing: { routes: { echoAgent: { repo: 'LeaseTarget', agent: 'echoAgent' } } },
    };
    assert.equal(mint({ snapshot: otherSnapshot }).aud, deriveAgentPrincipalId('LeaseTarget', 'echoAgent'),
        'the supplied lease decides even when the active generation routes the name elsewhere');
});

test('provider principal (proxy): pooled and SDK calls refuse an empty lease snapshot before dispatch', async (t) => {
    const { proxy, audience, secret } = await loadProxyFixture();
    const { forwarder } = await startEchoAgentBehindForwarder(t, { secret, audience });
    const pool = newPool(t);
    const readiness = readinessSpy(true);
    const previous = process.env.PLOINKY_MCP_UPSTREAM_POOL;
    t.after(() => {
        if (previous === undefined) delete process.env.PLOINKY_MCP_UPSTREAM_POOL;
        else process.env.PLOINKY_MCP_UPSTREAM_POOL = previous;
    });
    for (const mode of ['pooled', 'sdk']) {
        if (mode === 'sdk') process.env.PLOINKY_MCP_UPSTREAM_POOL = '0';
        else delete process.env.PLOINKY_MCP_UPSTREAM_POOL;
        const { route, routePlan } = proxyRoute(forwarder.port, `lease-snapshot-${mode}`);
        const sessionId = openRouterSession(proxy);
        const call = (label) => proxyCall(proxy, {
            route, routePlan, sessionId, pool, waitForAgentReady: readiness.fn, body: toolsCall(label),
        });
        assert.deepEqual(proxyToolPayload((await call(`${mode}-valid`)).json).actor, PROXY_ACTOR);
        const callsBefore = count(forwarder.log, (row) => row.rpc === 'tools/call');
        routePlan.lease = { ...routePlan.lease, snapshot: { agents: {}, routing: { routes: {} } } };
        const refused = await call(`${mode}-empty`);
        assert.match(refused.json.error?.message || '', /could not resolve provider 'echoAgent'/);
        assert.equal(count(forwarder.log, (row) => row.rpc === 'tools/call'), callsBefore,
            `${mode}: an empty lease snapshot cannot fall back to the active generation`);
    }
});

// ---------------------------------------------------------------------------
// Deadline at dispatch: a request whose deadline passed before it could be sent
// is not generation-checked, minted or sent.

test('deadline: a session open that uses up the deadline sends and mints nothing', async (t) => {
    const upstream = await startFakeUpstream(t, {
        onRpc: async ({ res, message, state }) => {
            if (message?.method === 'initialize') {
                await new Promise((resolve) => setTimeout(resolve, 150));
                res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `${state.sessionId}-slow` });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }));
                return true;
            }
            if (message?.method === 'notifications/initialized') {
                await new Promise((resolve) => setTimeout(resolve, 100));
                res.writeHead(202);
                res.end();
                return true;
            }
            return false;
        },
    });
    const pool = newPool(t);
    const key = keyFor({ port: upstream.port });
    let mints = 0;
    const startedAt = Date.now();
    const outcome = await pool.request({
        key, hostPort: upstream.port, method: 'tools/list', params: {}, timeoutMs: 200,
        headers: () => { mints += 1; return { authorization: 'Bearer late' }; },
        beforeDial: () => true,
    }).then(() => null, (error) => error);
    assert.ok(Date.now() - startedAt >= 200, 'the session open took longer than the deadline');
    assert.equal(mints, 0, 'never minted');
    assert.equal(upstream.log.some((row) => row.rpc === 'tools/list'), false, 'never sent');
    assert.ok(outcome?.code === 'UPSTREAM_TRANSPORT' && outcome?.timedOut === true, `timed out: ${outcome?.message}`);
    assert.equal(pool.isReady(key), false);
});

test('deadline: a queued request granted after its deadline sends and mints nothing', async () => {
    // Fake transport so the slot release and the stall happen in one macrotask.
    const sent = [];
    const held = [];
    const respond = (req, status, headers, body) => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = headers;
        res.resume = () => {};
        req.emit('response', res);
        if (body !== undefined) res.emit('data', Buffer.from(JSON.stringify(body)));
        res.emit('end');
    };
    const httpImpl = {
        Agent: class { destroy() {} },
        request(options) {
            const req = new EventEmitter();
            req.destroy = (error) => { req.destroyed = true; if (error) setImmediate(() => req.emit('error', error)); };
            req.end = (payload) => {
                const body = payload ? JSON.parse(payload.toString()) : null;
                sent.push({ method: options.method, rpc: body?.method, name: body?.params?.name, timeout: options.timeout });
                if (options.method === 'DELETE') return setImmediate(() => respond(req, 200, {}, undefined));
                if (body.method === 'initialize') {
                    return setImmediate(() => respond(req, 200, { 'content-type': 'application/json', 'mcp-session-id': 's1' },
                        { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }));
                }
                if (body.method === 'notifications/initialized') return setImmediate(() => respond(req, 202, {}, undefined));
                const reply = () => respond(req, 200, { 'content-type': 'application/json' },
                    { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: String(body.params?.name) }] } });
                if (body.params?.name === 'slow') { held.push(reply); return undefined; }
                return setImmediate(() => { if (!req.destroyed) reply(); });
            };
            return req;
        },
    };
    const pool = createUpstreamSessionPool({ httpImpl });
    const key = keyFor({ port: 7001 });
    const call = (name, extra = {}) => pool.request({
        key, hostPort: 7001, method: 'tools/call', params: { name, arguments: {} },
        headers: { authorization: 'Bearer x' }, beforeDial: () => true, timeoutMs: 10_000, ...extra,
    });
    await call('warm');
    const slow = Array.from({ length: 8 }, () => call('slow'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deadline = Date.now() + 200;
    let checks = 0;
    let mints = 0;
    const ninth = call('ninth', {
        timeoutMs: 200,
        beforeDial: () => { checks += 1; return true; },
        headers: () => { mints += 1; return { authorization: 'Bearer ninth' }; },
    });
    setTimeout(() => {
        // An event-loop stall crosses the deadline, then a slot is released in
        // the same macrotask, before the queue timer can run.
        while (Date.now() < deadline + 60) { /* stall */ }
        held.shift()();
    }, 100);
    const outcome = await ninth.then(() => null, (error) => error);
    assert.equal(mints, 0, 'never minted');
    assert.equal(sent.some((row) => row.name === 'ninth'), false, 'never sent');
    assert.equal(checks, 0, 'no generation check');
    assert.ok(outcome?.code === 'UPSTREAM_TRANSPORT' && outcome?.timedOut === true, `timed out: ${outcome?.message}`);
    for (const reply of held.splice(0)) reply();
    for (const result of await Promise.allSettled(slow)) assert.equal(result.status, 'fulfilled');
    await pool.closeAll();
});


// Explicit readiness.protocol in the committed lease manifest (SPEC C, user decision):
// 'tcp' probes the port only and still forwards; 'none' answers without an MCP endpoint.
function protocolSpy(result = true) {
    const spy = { calls: 0, options: [], result };
    spy.fn = async (_route, options) => { spy.calls += 1; spy.options.push(options); return spy.result; };
    return spy;
}

test('explicit readiness.protocol tcp: the probe is a TCP probe and the request is still forwarded upstream', async (t) => {
    const { proxy, audience, secret } = await loadProxyFixture();
    const { forwarder } = await startEchoAgentBehindForwarder(t, { secret, audience });
    for (const [lease, protocol] of [['lease-tcp', 'tcp'], ['lease-tcp-spaced', ' TCP ']]) {
        const pool = newPool(t);
        const readiness = protocolSpy(true);
        const { route, routePlan, key } = proxyRoute(forwarder.port, lease, { readiness: { protocol } });
        const sessionId = openRouterSession(proxy);
        const result = await proxyCall(proxy, { route, routePlan, sessionId, pool, waitForAgentReady: readiness.fn, body: toolsCall('tcp') });
        assert.equal(readiness.calls, 1);
        assert.equal(readiness.options[0].protocol, 'tcp');
        assert.equal(proxyToolPayload(result.json).input.label, 'tcp', 'forwarded to the upstream agent');
        // Only the real upstream exchange marks the pooled key ready; the TCP probe itself created nothing.
        assert.equal(pool.isReady(key), true);
    }
});

test('explicit readiness.protocol tcp: a failed TCP probe gives the existing not-ready answer', async (t) => {
    const { proxy } = await loadProxyFixture();
    const readiness = protocolSpy(false);
    const { route, routePlan } = proxyRoute(7409, 'lease-tcp-down', { readiness: { protocol: 'tcp' } });
    const result = await proxyCall(proxy, { route, routePlan, sessionId: openRouterSession(proxy), pool: newPool(t), waitForAgentReady: readiness.fn, body: toolsCall('x') });
    assert.equal(result.json.error.code, -32000);
    assert.match(result.json.error.message, /still starting/);
});

for (const [name, manifest] of [
    ['mcp', { readiness: { protocol: 'mcp' } }],
    ['absent protocol', { readiness: {} }],
    ['no readiness block', {}],
    ['health.readiness.script only', { health: { readiness: { script: 'ready.sh' } } }],
    ['start without explicit protocol', { start: 'postgres' }],
    ['unknown value', { readiness: { protocol: 'tcpx' } }],
    ['numeric value', { readiness: { protocol: 123 } }],
    ['null value', { readiness: { protocol: null } }],
    ['empty value', { readiness: { protocol: '' } }],
    ['missing manifest', undefined],
]) {
    test(`readiness protocol (${name}): the default MCP probe and normal forwarding are unchanged`, async (t) => {
        const { proxy, audience, secret } = await loadProxyFixture();
        const { forwarder } = await startEchoAgentBehindForwarder(t, { secret, audience });
        const readiness = protocolSpy(true);
        const { route, routePlan } = proxyRoute(forwarder.port, `lease-default-${name.replace(/\W+/g, '-')}`, manifest);
        const result = await proxyCall(proxy, { route, routePlan, sessionId: openRouterSession(proxy), pool: newPool(t), waitForAgentReady: readiness.fn, body: toolsCall('d') });
        assert.equal(readiness.calls, 1);
        assert.equal(Object.hasOwn(readiness.options[0], 'protocol'), false, 'no protocol override');
        assert.equal(proxyToolPayload(result.json).input.label, 'd');
    });
}

test('readiness protocol: a routeKey absent from snapshot.manifests keeps the default path', async (t) => {
    const { proxy, audience, secret } = await loadProxyFixture();
    const { forwarder } = await startEchoAgentBehindForwarder(t, { secret, audience });
    const readiness = protocolSpy(true);
    const { route, routePlan } = proxyRoute(forwarder.port, 'lease-orphan', { readiness: { protocol: 'none' } });
    routePlan.lease.snapshot.manifests = { other: { readiness: { protocol: 'none' } } };
    const result = await proxyCall(proxy, { route, routePlan, sessionId: openRouterSession(proxy), pool: newPool(t), waitForAgentReady: readiness.fn, body: toolsCall('o') });
    assert.equal(readiness.calls, 1);
    assert.equal(proxyToolPayload(result.json).input.label, 'o');
});

test('explicit readiness.protocol none: answers -32601 at once with no probe, session or dial', async (t) => {
    const { proxy } = await loadProxyFixture();
    for (const protocol of ['none', ' NONE ']) {
        const readiness = protocolSpy(true);
        const pool = newPool(t);
        const { route, routePlan } = proxyRoute(7410, `lease-none-${protocol.trim()}`, { readiness: { protocol } });
        const sessionsBefore = proxy.agentSessionStore.size;
        for (const method of ['initialize', 'tools/list']) {
            const started = Date.now();
            const result = await proxyCall(proxy, {
                route, routePlan, sessionId: openRouterSession(proxy), pool, waitForAgentReady: readiness.fn,
                body: { jsonrpc: '2.0', id: 7, method },
            });
            assert.ok(Date.now() - started < 200);
            assert.equal(result.status, 200);
            assert.deepEqual(result.json, {
                jsonrpc: '2.0', id: 7,
                error: { code: -32601, message: "Agent 'echoAgent' does not provide an MCP endpoint." },
            });
        }
        assert.equal(readiness.calls, 0);
        assert.equal(pool.snapshot().entries.length, 0, 'no pool entry');
        assert.equal(proxy.agentSessionStore.size, sessionsBefore + 2, 'only the two sessions this test opened itself');
    }
});

test('explicit readiness.protocol none: a request without an id answers id null and 50 parallel requests are fast', async (t) => {
    const { proxy } = await loadProxyFixture();
    const readiness = protocolSpy(true);
    const { route, routePlan } = proxyRoute(7411, 'lease-none-parallel', { readiness: { protocol: 'none' } });
    const pool = newPool(t);
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 50 }, () => proxyCall(proxy, {
        route, routePlan, sessionId: openRouterSession(proxy), pool, waitForAgentReady: readiness.fn,
        body: { jsonrpc: '2.0', method: 'tools/list' },
    })));
    assert.ok(Date.now() - started < 500);
    for (const result of results) assert.equal(result.json.id, null);
    assert.equal(readiness.calls, 0);
});

test('explicit readiness.protocol none: a failed lease commit gives the existing not-ready answer', async (t) => {
    const { proxy } = await loadProxyFixture();
    const readiness = protocolSpy(true);
    const { route, routePlan } = proxyRoute(7412, 'lease-none-stale', { readiness: { protocol: 'none' } });
    const result = await proxyCall(proxy, {
        route, routePlan, sessionId: openRouterSession(proxy), pool: newPool(t), waitForAgentReady: readiness.fn,
        beforeDial: () => false, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(result.json.error.code, -32000);
    assert.match(result.json.error.message, /still starting/);
    assert.equal(readiness.calls, 0);
    const plain = await proxyCall(proxy, {
        route, routePlan, sessionId: openRouterSession(proxy), pool: newPool(t), waitForAgentReady: readiness.fn,
        beforeDial: () => false, body: 'not json',
    });
    assert.equal(plain.status, 503);
    assert.equal(plain.json.error, 'agent_not_ready');
});

test('explicit readiness.protocol none: authorization precedes the short-circuit', async (t) => {
    const { proxy } = await loadProxyFixture();
    const readiness = protocolSpy(true);
    let commits = 0;
    const { route, routePlan } = proxyRoute(7413, 'lease-none-forbidden', { readiness: { protocol: 'none' } });
    const result = await proxyCall(proxy, {
        route, routePlan, sessionId: openRouterSession(proxy), pool: newPool(t), waitForAgentReady: readiness.fn,
        agent: { name: 'caller', allowedTargets: ['someoneElse'] },
        beforeDial: () => { commits += 1; return true; },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(result.status, 403);
    assert.equal(result.json.error, 'forbidden');
    assert.equal(commits, 0);
});

test('explicit readiness.protocol none: without a callable beforeDial the request keeps the existing path', async (t) => {
    const { proxy } = await loadProxyFixture();
    const readiness = protocolSpy(false);
    const { route, routePlan } = proxyRoute(7414, 'lease-none-nocommit', { readiness: { protocol: 'none' } });
    const result = await proxyCall(proxy, {
        route, routePlan, sessionId: openRouterSession(proxy), pool: newPool(t), waitForAgentReady: readiness.fn,
        beforeDial: null, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(readiness.calls, 1, 'fails closed onto the readiness probe');
    assert.equal(result.json.error.code, -32000);
});

test('explicit readiness.protocol none: a non-JSON-RPC body (and malformed JSON) gets 404 agent_mcp_unavailable', async (t) => {
    const { proxy } = await loadProxyFixture();
    const readiness = protocolSpy(true);
    const { route, routePlan } = proxyRoute(7415, 'lease-none-plain', { readiness: { protocol: 'none' } });
    for (const body of [{ hello: 'world' }, '{malformed']) {
        const result = await proxyCall(proxy, {
            route, routePlan, sessionId: openRouterSession(proxy), pool: newPool(t), waitForAgentReady: readiness.fn, body,
        });
        assert.equal(result.status, 404);
        assert.deepEqual(result.json, { error: 'agent_mcp_unavailable', detail: "Agent 'echoAgent' does not provide an MCP endpoint." });
    }
    assert.equal(readiness.calls, 0);
});
