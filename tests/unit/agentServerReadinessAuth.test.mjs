import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { computeRchTool } from '../../Agent/lib/requestHash.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const AGENT_SERVER = path.join(REPO_ROOT, 'Agent/server/AgentServer.mjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-server-readiness-'));
const originalCwd = process.cwd();
const savedEnvironment = new Map();

function setTemporaryEnvironment(name, value) {
    if (!savedEnvironment.has(name)) savedEnvironment.set(name, process.env[name]);
    process.env[name] = value;
}

setTemporaryEnvironment('PLOINKY_WORKSPACE_ROOT', tempDir);
setTemporaryEnvironment('PLOINKY_MASTER_KEY', '8'.repeat(64));
process.chdir(tempDir);
const { installGeneratedRouterRuntime } = await import(`../helpers/generatedRouterRuntime.mjs?readiness=${Date.now()}`);
const {
    MCP_READINESS_PROBE_HEADER,
    MCP_READINESS_PROBE_PATH,
    MCP_READINESS_PROBE_TOOL,
    MCP_READINESS_PROBE_VALUE,
} = await import(`../../Agent/lib/invocationAuth.mjs?readiness=${Date.now()}`);

const principalId = 'agent:test/readiness';
const agentSecretHex = 'a'.repeat(64);
const runtime = installGeneratedRouterRuntime({
    origin: 'http://127.0.0.1:8080',
    publicAuthority: '127.0.0.1:8080',
    tempDir,
    agentPrincipal: principalId,
});
for (const [name, value] of Object.entries(runtime.env)) {
    if (!savedEnvironment.has(name)) savedEnvironment.set(name, process.env[name]);
    process.env[name] = value;
}
process.chdir(originalCwd);

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const [name, value] of savedEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
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

async function waitForExit(child, output, timeoutMs = 3000) {
    const result = await Promise.race([
        once(child, 'exit').then(([code, signal]) => ({ code, signal })),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(`AgentServer did not fail closed:\n${output()}`)),
            timeoutMs,
        )),
    ]);
    return result;
}

async function assertPortIsClosed(port) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
}

async function startAgentServer(t) {
    const port = await getFreePort();
    const configPath = path.join(tempDir, 'mcp-config.json');
    fs.writeFileSync(configPath, '{}\n', { mode: 0o600 });
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd: tempDir,
        env: {
            ...isolatedAgentServerEnv(),
            ...runtime.env,
            PORT: String(port),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_CONFIG: configPath,
            PLOINKY_RUNTIME: 'container',
            PLOINKY_WORKSPACE_ROOT: tempDir,
            PLOINKY_MASTER_KEY: '8'.repeat(64),
            PLOINKY_AGENT_SECRET: agentSecretHex,
            PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await Promise.race([
                once(child, 'exit'),
                new Promise((resolve) => setTimeout(resolve, 1000)),
            ]);
        }
    });
    await waitForHealth(port, () => output);
    return port;
}

function mintReadinessToken(params) {
    const now = Math.floor(Date.now() / 1000);
    return signHmacJwt({
        secret: Buffer.from(agentSecretHex, 'hex'),
        payload: {
            typ: 'router-request',
            iss: 'ploinky-router',
            aud: principalId,
            sub: 'ploinky-readiness',
            actor: { kind: 'system', id: 'ploinky-readiness', roles: [] },
            method: 'POST',
            path: MCP_READINESS_PROBE_PATH,
            tool: MCP_READINESS_PROBE_TOOL,
            rch: computeRchTool({
                method: 'POST',
                path: MCP_READINESS_PROBE_PATH,
                tool: MCP_READINESS_PROBE_TOOL,
                arguments: params,
            }),
            jti: crypto.randomBytes(12).toString('base64url'),
            iat: now,
            exp: now + 30,
        },
    });
}

test('AgentServer exits before listen when no credential context can be bootstrapped', async () => {
    const port = await getFreePort();
    const childEnv = isolatedAgentServerEnv();
    delete childEnv.PLOINKY_RUNTIME;
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd: tempDir,
        env: {
            ...childEnv,
            PORT: String(port),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });

    const result = await waitForExit(child, () => output);
    assert.notEqual(result.code, 0, output);
    assert.match(output, /PLOINKY_AGENT_CREDENTIAL_RUNTIME_INVALID|runtime credential selection must be exact/);
    assert.doesNotMatch(output, /Streamable HTTP listening|No configuration file found/);
    await assertPortIsClosed(port);
});

test('AgentServer rejects descriptor and generated identity mismatch before listen', async () => {
    const port = await getFreePort();
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd: tempDir,
        env: {
            ...isolatedAgentServerEnv(),
            ...runtime.env,
            PORT: String(port),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_RUNTIME: 'container',
            PLOINKY_WORKSPACE_ROOT: tempDir,
            PLOINKY_MASTER_KEY: '8'.repeat(64),
            PLOINKY_AGENT_ID: 'agent:test/wrong-identity',
            PLOINKY_AGENT_SECRET: agentSecretHex,
            PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });

    const result = await waitForExit(child, () => output);
    assert.notEqual(result.code, 0, output);
    assert.match(output, /runtime-owned PLOINKY_AGENT_ID disagrees with the signed descriptor/);
    assert.doesNotMatch(output, /Streamable HTTP listening|No configuration file found/);
    await assertPortIsClosed(port);
});

async function postInitialize(port, body, { probeValue, token } = {}) {
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
    };
    if (probeValue !== undefined) headers[MCP_READINESS_PROBE_HEADER] = probeValue;
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`http://127.0.0.1:${port}${MCP_READINESS_PROBE_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const text = await response.text();
    return { response, text };
}

test('readiness initialize is authenticated before an MCP session is created', async (t) => {
    const port = await startAgentServer(t);
    const params = {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'readiness-test', version: '1.0.0' },
    };
    const body = { jsonrpc: '2.0', id: 'readiness-init', method: 'initialize', params };

    const missing = await postInitialize(port, body, { probeValue: MCP_READINESS_PROBE_VALUE });
    assert.equal(missing.response.status, 401, missing.text);
    assert.equal(missing.response.headers.get('mcp-session-id'), null);
    assert.match(missing.text, /missing router-request token/);

    const wrongParams = { ...params, clientInfo: { ...params.clientInfo, version: 'different' } };
    const mismatched = await postInitialize(port, body, {
        probeValue: MCP_READINESS_PROBE_VALUE,
        token: mintReadinessToken(wrongParams),
    });
    assert.equal(mismatched.response.status, 401, mismatched.text);
    assert.equal(mismatched.response.headers.get('mcp-session-id'), null);
    assert.match(mismatched.text, /request hash mismatch/);

    const ordinary = await postInitialize(port, body, { probeValue: 'V1' });
    assert.equal(ordinary.response.status, 200, ordinary.text);
    assert.ok(ordinary.response.headers.get('mcp-session-id'));

    const token = mintReadinessToken(params);
    const accepted = await postInitialize(port, body, {
        probeValue: MCP_READINESS_PROBE_VALUE,
        token,
    });
    assert.equal(accepted.response.status, 200, accepted.text);
    assert.ok(accepted.response.headers.get('mcp-session-id'));

    const replayed = await postInitialize(port, body, {
        probeValue: MCP_READINESS_PROBE_VALUE,
        token,
    });
    assert.equal(replayed.response.status, 401, replayed.text);
    assert.equal(replayed.response.headers.get('mcp-session-id'), null);
    assert.match(replayed.text, /already been consumed/);
});
