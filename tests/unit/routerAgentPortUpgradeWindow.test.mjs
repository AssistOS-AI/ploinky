import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PRELOAD = path.join(REPO_ROOT, 'tests/helpers/routerTemplatePreload.mjs');
const PENDING_PRELOAD = path.join(REPO_ROOT, 'tests/helpers/routerPendingSessionPreload.mjs');
const ROUTER = path.join(REPO_ROOT, 'cli/server/RoutingServer.js');
const UPGRADE_PATH = '/base-agent-additional-server/alpha/7000/socket';

function writeJson(target, value) {
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

// Real RoutingServer.js in a child with the SSO session backend stubbed; a
// ploinky_sso=pending cookie keeps the access check pending until released.
async function startRouter(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'upgwin-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const alphaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    for (const directory of [edgeDir, policyDir, path.join(alphaDir, 'web')]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    writeJson(path.join(alphaDir, 'manifest.json'), {
        ploinky: 'sso enable',
        sso: { providerAgent: 'identity' },
        routerAccess: { requiredCapability: 'app.access' },
    });
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        static: { agent: 'alpha', port: 7777 },
        routes: { alpha: {
            repo: 'fixtures', agent: 'alpha', container: 'alpha-container',
            hostPath: alphaDir, hostPort: 43102,
        } },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        'alpha-container': {
            type: 'agent', repoName: 'fixtures', agentName: 'alpha', instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation', profile: 'default', auth: { mode: 'sso' },
            runtime: 'podman', containerId: 'a'.repeat(64),
        },
    });
    writeJson(path.join(edgeDir, 'desired.json'), {
        hosts: { 'alpha.example.test': { agent: 'fixtures/alpha', routerSurfaces: [] } },
        cloudflare: { tunnelTokenSecret: 'publication/test-connector' },
    });
    writeJson(path.join(policyDir, 'policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    const port = await freePort();
    const savedEnv = {
        root: process.env.PLOINKY_WORKSPACE_ROOT, hostPort: process.env.PLOINKY_ROUTER_HOST_PORT,
        media: process.env.PLOINKY_MEDIA_HOST_PORT,
    };
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_ROUTER_HOST_PORT = String(port);
    process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'upgrade-window', publicationState: 'ready' });
    for (const [key, value] of [['PLOINKY_WORKSPACE_ROOT', savedEnv.root], ['PLOINKY_ROUTER_HOST_PORT', savedEnv.hostPort], ['PLOINKY_MEDIA_HOST_PORT', savedEnv.media]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if ((name.startsWith('PLOINKY_') && name !== 'PLOINKY_AGENTLIB_DIR') || name === 'PORT') delete env[name];
    }
    const child = spawn(process.execPath, ['--import', PRELOAD, '--import', PENDING_PRELOAD, ROUTER], {
        cwd: workspace,
        env: {
            ...env,
            HOME: workspace,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_ROUTER_HOST_PORT: String(port),
            PLOINKY_MEDIA_HOST_PORT: '17891',
            PLOINKY_MASTER_KEY: '7'.repeat(64),
            PLOINKY_ROUTER_HEALTH_SOCKET: path.join(workspace, 'h.sock'),
            PLOINKY_TEST_PUBLIC_PORT: String(port),
            PLOINKY_TEST_REPO_ROOT: REPO_ROOT,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout.on('data', (c) => { output += c.toString('utf8'); });
    child.stderr.on('data', (c) => { output += c.toString('utf8'); });
    const messages = [];
    child.on('message', (message) => { messages.push(message); });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
        }
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    const deadline = Date.now() + 15000;
    while (!/Ploinky server running/.test(output)) {
        if (child.exitCode !== null) throw new Error(`router exited:\n${output}`);
        if (Date.now() > deadline) throw new Error(`router did not start:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { child, port, messages, getOutput: () => output };
}

async function waitFor(predicate, what, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

test('real router: client reset while the agent-port upgrade access check is pending raises no uncaught exception and the router keeps answering', async (t) => {
    const { child, port, messages, getOutput } = await startRouter(t);
    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    await once(client, 'connect');
    client.write([
        `GET ${UPGRADE_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Origin: http://127.0.0.1:${port}`,
        'Cookie: ploinky_sso=pending',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 5).toString('base64')}`,
        '',
        '',
    ].join('\r\n'));

    await waitFor(() => messages.some((m) => m?.type === 'validate-started'), `pending access check; output:\n${getOutput()}`);
    client.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.send({ type: 'release' });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const health = await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health', headers: { host: `127.0.0.1:${port}` } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.setTimeout(3000, () => req.destroy(new Error('router did not answer /health')));
        req.on('error', reject);
    });
    assert.ok(health >= 100 && health < 600, `router answered with status ${health}`);

    assert.equal(child.exitCode, null, `router exited (code ${child.exitCode}, signal ${child.signalCode}):\n${getOutput()}`);
    assert.equal(child.signalCode, null);
    assert.doesNotMatch(getOutput(), /ECONNRESET|Unhandled 'error'|uncaught/i, getOutput());
});
