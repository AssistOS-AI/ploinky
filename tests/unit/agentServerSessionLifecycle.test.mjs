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

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { computeRchTool } from '../../Agent/lib/requestHash.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const AGENT_SERVER = path.join(REPO_ROOT, 'Agent/server/AgentServer.mjs');
const fixtureServers = new Map();

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
    t.after(async () => {
        for (const child of fixtureServers.get(tmp) || []) {
            if (child.exitCode !== null || child.signalCode !== null) continue;
            const exited = once(child, 'exit');
            let timer;
            child.kill('SIGTERM');
            try {
                await Promise.race([
                    exited,
                    new Promise((resolve) => { timer = setTimeout(resolve, 5000); }),
                ]);
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                    await exited;
                }
            } finally {
                clearTimeout(timer);
            }
        }
        fixtureServers.delete(tmp);
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

async function startAgentServer(t, { tmp, cwd = tmp, configPath, env = {} }) {
    const port = await getFreePort();
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd,
        env: {
            ...isolatedAgentServerEnv(),
            HOME: tmp,
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

    if (!fixtureServers.has(tmp)) fixtureServers.set(tmp, []);
    fixtureServers.get(tmp).push(child);

    await waitForHealth(port, () => output);
    return { child, port, output: () => output };
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

function mintRouterRequest({ secret, audience, tool, args = {}, method = 'POST', reqPath = '/mcp', actor = { kind: 'user', id: 'user:test', roles: ['user'] } }) {
    const now = Math.floor(Date.now() / 1000);
    const rch = computeRchTool({ method, path: reqPath, tool, arguments: args });
    return signHmacJwt({
        secret,
        payload: {
            typ: 'router-request',
            iss: 'ploinky-router',
            aud: audience,
            sub: actor.id,
            actor,
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

test('AgentServer advertises full standard schemas and rejects signed invalid arguments before dispatch', async t => {
    const tmp = await createTempDir(t);
    const configPath = path.join(tmp, 'mcp-config.json');
    const toolScript = path.join(tmp, 'echo-input.mjs');
    const invocations = path.join(tmp, 'invocations.jsonl');
    await fs.writeFile(toolScript, [
        "import fs from 'node:fs';",
        "let text = ''; for await (const chunk of process.stdin) text += chunk;",
        "const { input } = JSON.parse(text);",
        `fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify(input) + '\\n');`,
        "console.log(JSON.stringify(input));",
    ].join('\n'));
    const inputSchema = { type: 'object', properties: {
        amount: { type: 'integer', minimum: 1, maximum: 10 },
        code: { type: 'string', minLength: 3, maxLength: 4, pattern: '^a', enum: ['abc', 'abcd', 'bad'] },
        roles: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['user', 'admin'] } },
        details: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false },
        variables: { type: 'object', additionalProperties: true },
        redirectUri: { type: 'string', format: 'uri' },
    }, required: ['amount', 'code', 'roles', 'details'], additionalProperties: false, minProperties: 4 };
    const patchSchema = { type: 'object', properties: { displayName: { type: 'string', maxLength: 20 } }, minProperties: 1, additionalProperties: false };
    const legacySchema = { name: { type: 'string' }, type: 'string', optionalFlag: { type: 'boolean', optional: true } };
    await fs.writeFile(configPath, JSON.stringify({ tools: [
        { name: 'standard', inputSchema }, { name: 'patch', inputSchema: patchSchema }, { name: 'legacy', inputSchema: legacySchema },
    ].map(tool => ({ ...tool, command: process.execPath, args: [toolScript], cwd: tmp })) }));
    const secret = crypto.randomBytes(32);
    const audience = 'agent:schema-test';
    const { port } = await startAgentServer(t, { tmp, configPath, env: {
        PLOINKY_AGENT_SECRET: secret.toString('hex'), PLOINKY_AGENT_ID: audience,
    } });
    const sessionId = await initializeSession(port);
    const listed = await mcpPost(port, { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }, { sessionId });
    assert.deepEqual(listed.json.result.tools.find(tool => tool.name === 'standard').inputSchema, inputSchema);
    assert.deepEqual(listed.json.result.tools.find(tool => tool.name === 'patch').inputSchema, patchSchema);
    const legacyListed = listed.json.result.tools.find(tool => tool.name === 'legacy').inputSchema;
    assert.equal(legacyListed.properties.name.type, 'string');
    assert.deepEqual(legacyListed.required, ['name', 'type']);
    let id = 0;
    const call = (tool, args) => mcpPost(port, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }, {
        sessionId, authorization: `Bearer ${mintRouterRequest({ secret, audience, tool, args })}`,
    });
    const valid = { amount: 1, code: 'abc', roles: ['user', 'admin'], details: { enabled: true }, variables: { arbitrary: { value: 1 } }, redirectUri: 'https://example.test/callback' };
    for (const [tool, args] of [['standard', valid], ['patch', { displayName: 'Owner' }], ['legacy', { name: 'owner', type: 'legacy' }]]) {
        const result = await call(tool, args);
        assert.equal(result.json.error, undefined, result.text);
        assert.equal(result.json.result.isError, undefined, result.text);
        assert.deepEqual(JSON.parse(result.json.result.content[0].text), args);
    }
    for (const args of [
        { ...valid, amount: -1 }, { ...valid, amount: 1.5 }, { ...valid, amount: 11 },
        { ...valid, extra: true }, { ...valid, amount: undefined },
        { ...valid, code: 'ab' }, { ...valid, code: 'bad' }, { ...valid, code: 'abcde' },
        { ...valid, roles: [] }, { ...valid, roles: ['user', 'user'] }, { ...valid, roles: ['invalid'] },
        { ...valid, details: {} }, { ...valid, details: { enabled: true, extra: true } },
        { ...valid, redirectUri: '/relative' },
    ]) {
        // Sign the exact JSON payload, including omission of undefined fields.
        const result = await call('standard', JSON.parse(JSON.stringify(args)));
        assert.equal(result.json.error?.code, -32602, result.text);
    }
    const emptyPatch = await call('patch', {});
    assert.equal(emptyPatch.json.error?.code, -32602, emptyPatch.text);
    const executed = (await fs.readFile(invocations, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(executed, [valid, { displayName: 'Owner' }, { name: 'owner', type: 'legacy' }]);
});

test('AgentServer shares only schemas across concurrent sessions and verifies every actor and replay independently', async t => {
    const tmp = await createTempDir(t);
    const configPath = path.join(tmp, 'mcp-config.json');
    const toolScript = path.join(tmp, 'echo-actor.mjs');
    const invocations = path.join(tmp, 'verified-invocations.jsonl');
    await fs.writeFile(toolScript, [
        "import fs from 'node:fs';",
        "let text = ''; for await (const chunk of process.stdin) text += chunk;",
        "const { input, metadata } = JSON.parse(text);",
        "await new Promise(resolve => setTimeout(resolve, 20));",
        "const result = { input, actor: metadata.invocation.actor };",
        `fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify(result) + '\\n');`,
        "console.log(JSON.stringify(result));",
    ].join('\n'));
    const inputSchema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
    await fs.writeFile(configPath, JSON.stringify({ tools: [{
        name: 'actor', command: process.execPath, args: [toolScript], cwd: tmp, inputSchema,
    }] }));
    const secret = crypto.randomBytes(32);
    const audience = 'agent:schema-actor-test';
    const { port } = await startAgentServer(t, { tmp, configPath, env: {
        PLOINKY_AGENT_SECRET: secret.toString('hex'), PLOINKY_AGENT_ID: audience,
    } });
    const sessions = await Promise.all(Array.from({ length: 3 }, () => initializeSession(port)));
    assert.equal(new Set(sessions).size, 3, 'each initialization retains an independent session');
    const actors = [
        { kind: 'user', id: 'user:alice', roles: ['admin'] },
        { kind: 'user', id: 'user:bob', roles: ['user'] },
    ];
    let id = 0;
    const call = (sessionId, args, token) => mcpPost(port, {
        jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'actor', arguments: args },
    }, { sessionId, ...(token ? { authorization: `Bearer ${token}` } : {}) });
    let replayToken;
    let replayArgs;
    const expected = [];
    for (let round = 0; round < 3; round += 1) {
        const calls = actors.map(async (actor, index) => {
            const args = { label: `round-${round}-${index}` };
            const token = mintRouterRequest({ secret, audience, tool: 'actor', args, actor });
            if (round === 0 && index === 0) { replayToken = token; replayArgs = args; }
            const result = await call(sessions[(round + index) % sessions.length], args, token);
            assert.equal(result.json?.result?.isError, undefined, result.text);
            assert.equal(result.json?.error, undefined, result.text);
            const verified = JSON.parse(result.json.result.content[0].text);
            assert.deepEqual(verified, { input: args, actor });
            expected.push(verified);
        });
        await Promise.all(calls);
    }
    const replayed = await call(sessions[2], replayArgs, replayToken);
    assert.equal(replayed.json.result.isError, true, replayed.text);
    assert.match(replayed.json.result.content[0].text, /Invocation rejected/);
    const unsigned = await call(sessions[0], { label: 'unsigned' });
    assert.equal(unsigned.json.result.isError, true, unsigned.text);
    assert.match(unsigned.json.result.content[0].text, /missing secure wire headers/);
    const signedArgs = { label: 'signed' };
    const token = mintRouterRequest({ secret, audience, tool: 'actor', args: signedArgs, actor: actors[1] });
    const tampered = await call(sessions[1], { label: 'tampered' }, token);
    assert.equal(tampered.json.result.isError, true, tampered.text);
    assert.match(tampered.json.result.content[0].text, /Invocation rejected/);
    const invalidArgs = { label: 42 };
    const invalid = await call(sessions[2], invalidArgs, mintRouterRequest({ secret, audience, tool: 'actor', args: invalidArgs, actor: actors[0] }));
    assert.equal(invalid.json.error?.code, -32602, invalid.text);
    const listed = await mcpPost(port, { jsonrpc: '2.0', id: ++id, method: 'tools/list' }, { sessionId: sessions[2] });
    assert.deepEqual(listed.json.result.tools[0].inputSchema, inputSchema);
    const executed = (await fs.readFile(invocations, 'utf8')).trim().split('\n').map(JSON.parse);
    const byLabel = (left, right) => left.input.label.localeCompare(right.input.label);
    assert.deepEqual(executed.sort(byLabel), expected.sort(byLabel), 'rejected calls must never dispatch');
});

test('AgentServer cannot initialize tools with unsupported or malformed input schemas', async t => {
    const tmp = await createTempDir(t);
    for (const [index, inputSchema] of [
        { type: 'object', anyOf: [{ required: ['id'] }] },
        { type: 'object', properties: { value: { type: 'string', format: 'unsupported' } } },
        { type: 'object', properties: null },
    ].entries()) {
        const configPath = path.join(tmp, `invalid-${index}.json`);
        await fs.writeFile(configPath, JSON.stringify({ tools: [{ name: 'invalid', command: process.execPath, args: ['-e', 'process.exit(99)'], inputSchema }] }));
        const { port, output } = await startAgentServer(t, { tmp, configPath });
        const result = await mcpPost(port, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: {
            protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'schema-test', version: '1' },
        } });
        assert.equal(result.status, 500, result.text);
        assert.equal(result.headers.get('mcp-session-id'), null);
        assert.equal(result.json.error?.code, -32603);
        assert.match(output(), /Failed to build inputSchema/);
    }
});

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

test('AgentServer acknowledges SIGTERM only after closing its listener', async (t) => {
    const tmp = await createTempDir(t);
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    const { child, port, output } = await startAgentServer(t, { tmp, configPath });

    assert.equal(child.kill('SIGTERM'), true);
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, output());
    assert.equal(code, 0, output());
    await assert.rejects(
        fetch(`http://127.0.0.1:${port}/health`),
        /fetch failed|ECONNREFUSED/,
    );
});

test('AgentServer persists restart state in writable HOME when its code cwd is read-only', async (t) => {
    const tmp = await createTempDir(t);
    const codeDir = path.join(tmp, 'code');
    const homeDir = path.join(tmp, 'home');
    const configPath = path.join(codeDir, 'mcp-config.json');
    await fs.mkdir(codeDir);
    await fs.mkdir(homeDir);
    await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    const persistedTask = {
        id: 'restored-task',
        toolName: 'demo',
        commandSpec: { command: '/bin/false', args: [], cwd: '/', env: {} },
        payload: { source: 'restart-regression' },
        status: 'failed',
        timeoutMs: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        error: 'expected persisted failure',
        logRetention: 'bounded',
        continuationTool: '',
    };
    await fs.writeFile(
        path.join(homeDir, '.tasksQueue'),
        JSON.stringify([persistedTask], null, 2),
    );
    await fs.chmod(codeDir, 0o555);
    try {
        for (let generation = 0; generation < 2; generation += 1) {
            const { child, output } = await startAgentServer(t, {
                tmp,
                cwd: codeDir,
                configPath,
                env: {
                    HOME: homeDir,
                    PLOINKY_CODE_DIR: codeDir,
                },
            });

            assert.equal(child.kill('SIGTERM'), true);
            const [code, signal] = await once(child, 'exit');
            assert.equal(signal, null, output());
            assert.equal(code, 0, output());
            const persisted = JSON.parse(
                await fs.readFile(path.join(homeDir, '.tasksQueue'), 'utf8'),
            );
            assert.equal(persisted.length, 1);
            assert.equal(persisted[0].id, persistedTask.id);
            assert.equal(persisted[0].status, 'failed');
            assert.equal(persisted[0].error, persistedTask.error);
        }
        await assert.rejects(
            fs.access(path.join(codeDir, '.tasksQueue')),
            error => error?.code === 'ENOENT',
        );
    } finally {
        await fs.chmod(codeDir, 0o755).catch(() => {});
    }
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
    const audience = 'agent:test-agent';
    const { port } = await startAgentServer(t, {
        tmp,
        configPath,
        env: {
            MCP_SESSION_IDLE_TIMEOUT_MS: '100',
            MCP_SESSION_GC_INTERVAL_MS: '25',
            PLOINKY_AGENT_SECRET: secret.toString('hex'),
            PLOINKY_AGENT_ID: audience
        }
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
    const audience = 'agent:test-agent';
    const { port } = await startAgentServer(t, {
        tmp,
        configPath,
        env: {
            PLOINKY_AGENT_SECRET: secret.toString('hex'),
            PLOINKY_AGENT_ID: audience
        }
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
    await unauthenticated.arrayBuffer();
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
