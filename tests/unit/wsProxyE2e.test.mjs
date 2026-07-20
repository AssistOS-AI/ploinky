import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acceptWebSocketUpgrade, WebSocket } from '../../cli/server/utils/websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '5'.repeat(64);

test('router proxies authenticated WebSocket upgrades to HTTP-service agents', async (t) => {
    let captured = null;
    let router = null;
    let ws = null;
    const upstream = http.createServer();
    upstream.on('upgrade', (req, socket, head) => {
        captured = {
            url: req.url,
            authInfo: req.headers['x-ploinky-auth-info'],
            headers: req.headers,
        };
        const ws = acceptWebSocketUpgrade(req, socket, head);
        ws?.on('message', (message) => {
            ws.send(`echo:${message.toString('utf8')}`);
        });
    });
    const upstreamPort = await listen(upstream);

    const fixture = createRoutingFixture(upstreamPort);
    const previousEnv = setFixtureEnv(fixture);
    t.after(async () => {
        if (ws) await closeWebSocket(ws);
        if (router) await stopChild(router);
        await close(upstream);
        restoreEnv(previousEnv);
        rmSync(fixture.workspace, { recursive: true, force: true });
    });

    const [
        { createMemoryReplayCache },
        { computeRchHttp },
        { verifyRouterRequestToken },
        { deriveAgentRequestSecret },
        edgeGeneration,
        localService,
    ] = await Promise.all([
        import('../../Agent/lib/jwtVerify.mjs'),
        import('../../Agent/lib/requestHash.mjs'),
        import('../../Agent/lib/requestSignedTokens.mjs'),
        import(`../../cli/utils/security/masterKey.js?e2e=${Date.now()}`),
        import(`../../cli/sandbox/edgeGeneration.js?e2e=${Date.now()}`),
        import(`../../cli/server/auth/localService.js?e2e=${Date.now()}`),
    ]);
    const authPolicy = { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' };
    localService.createLocalAuthUser({
        policy: authPolicy,
        username: 'admin',
        password: 'correct horse battery staple',
        roles: ['admin'],
    });
    const login = localService.authenticateLocalUser({
        policy: authPolicy,
        username: 'admin',
        password: 'correct horse battery staple',
    });

    edgeGeneration.applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'ws-proxy-e2e-fixture',
    });
    const routerPort = 8080;
    router = spawn(process.execPath, ['cli/server/RoutingServer.js'], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            PORT: String(routerPort),
            PLOINKY_WORKSPACE_ROOT: fixture.workspace,
            PLOINKY_ROUTING_FILE: fixture.routingFile,
            PLOINKY_MASTER_KEY: MASTER_KEY,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = captureChildOutput(router);
    await waitForRouter(router, output, routerPort);

    const connected = await connectWebSocketWithStatus({
        url: `ws://127.0.0.1:${routerPort}/services/demo/management/ws/logs?tail=1`,
        headers: {
            cookie: `ploinky_jwt=${login.sessionId}`,
            forwarded: 'host=attacker.invalid;proto=https',
            'x-forwarded-host': 'attacker.invalid',
            'x-forwarded-proto': 'https',
        },
    });
    const { statusCode } = connected;
    ws = connected.ws;

    assert.equal(statusCode, 101);
    ws.send('ping');
    const message = await waitForMessage(ws);

    assert.equal(message.toString('utf8'), 'echo:ping');
    assert.equal(captured?.url, '/internal/management/ws/logs?tail=1');
    assert.equal(typeof captured?.authInfo, 'string');
    assert.equal(captured?.headers.host, '127.0.0.1:8080');
    assert.equal(captured?.headers['x-forwarded-host'], '127.0.0.1:8080');
    assert.equal(captured?.headers['x-forwarded-proto'], 'http');
    assert.equal(captured?.headers.forwarded, undefined);

    const authInfo = JSON.parse(captured.authInfo);
    assert.equal(authInfo.user.id, 'local:admin');
    assert.equal(typeof authInfo.invocationToken, 'string');
    assert.deepEqual(authInfo.invocationBody, {
        method: 'GET',
        externalPath: '/services/demo/management/ws/logs',
        path: '/internal/management/ws/logs',
        search: '?tail=1',
        routeKey: 'demoService',
        bodyHash: sha256BodyHash(''),
    });

    const verified = verifyRouterRequestToken(authInfo.invocationToken, {
        secret: deriveAgentRequestSecret('agent:fixtures/demoService', { encoding: 'buffer' }),
        expectedAudience: 'agent:fixtures/demoService',
        tool: '__http_service__',
        method: authInfo.invocationBody.method,
        path: authInfo.invocationBody.path,
        rch: computeRchHttp({
            method: authInfo.invocationBody.method,
            path: authInfo.invocationBody.path,
            query: authInfo.invocationBody.search,
            bodyHash: authInfo.invocationBody.bodyHash,
        }),
        replayCache: createMemoryReplayCache(),
    });
    assert.equal(verified.payload.typ, 'router-request');
    assert.equal(verified.payload.sub, 'user:local:admin');

    await closeWebSocket(ws);
    ws = null;
    await stopChild(router);
    router = null;
});

function createRoutingFixture(servicePort) {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ploinky-ws-e2e-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const explorerManifestDir = path.join(ploinkyDir, 'repos', 'fixtures', 'explorer');
    const serviceManifestDir = path.join(ploinkyDir, 'repos', 'fixtures', 'demoService');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const routingFile = path.join(ploinkyDir, 'routing.json');

    mkdirSync(explorerManifestDir, { recursive: true });
    mkdirSync(serviceManifestDir, { recursive: true });
    mkdirSync(edgeDir, { recursive: true });
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(path.join(explorerManifestDir, 'manifest.json'), JSON.stringify({ about: 'Explorer' }, null, 2));
    writeFileSync(path.join(serviceManifestDir, 'manifest.json'), JSON.stringify({
        httpServices: [{
            slug: 'demo',
            externalPrefix: '/services/demo/',
            internalPrefix: '/internal/',
            access: 'authenticated',
        }],
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'fixtures',
            instanceId: 'explorer-instance',
            enableGeneration: 'explorer-enable-generation',
            auth: { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' },
        },
        demoService: {
            type: 'agent',
            agentName: 'demoService',
            repoName: 'fixtures',
            instanceId: 'demo-service-instance',
            enableGeneration: 'demo-service-enable-generation',
            auth: { mode: 'none' },
        },
    }, null, 2));
    writeFileSync(routingFile, JSON.stringify({
        routes: {
            explorer: {
                agent: 'explorer',
                repo: 'fixtures',
                container: 'explorer',
                hostPort: 55289,
                hostPath: explorerManifestDir,
            },
            demoService: {
                agent: 'demoService',
                repo: 'fixtures',
                container: 'demoService',
                hostPort: servicePort,
                hostPath: serviceManifestDir,
            },
        },
        static: {
            agent: 'explorer',
            hostPath: explorerManifestDir,
            port: 8080,
        },
    }, null, 2));
    writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({
        schemaVersion: 1,
        hosts: {},
        security: {
            hostNetworkAllowedInstances: [],
            internalServiceConsumers: {},
        },
    }, null, 2));
    writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    }, null, 2));

    return { workspace, routingFile };
}

function setFixtureEnv(fixture) {
    const previous = {
        PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
        PLOINKY_ROUTING_FILE: process.env.PLOINKY_ROUTING_FILE,
        PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
        PLOINKY_AUTH_EXPLORER_USERS: process.env.PLOINKY_AUTH_EXPLORER_USERS,
    };
    process.env.PLOINKY_WORKSPACE_ROOT = fixture.workspace;
    process.env.PLOINKY_ROUTING_FILE = fixture.routingFile;
    process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
    return previous;
}

function restoreEnv(snapshot) {
    for (const [name, value] of Object.entries(snapshot)) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
}

function captureChildOutput(child) {
    const output = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    return output;
}

async function waitForRouter(child, output, port) {
    const readyText = `Ploinky server running on http://127.0.0.1:${port}`;
    const started = Date.now();
    while (!output.stdout.includes(readyText)) {
        if (child.exitCode !== null) {
            throw new Error(`router exited before listening\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
        }
        if (Date.now() - started > 5000) {
            throw new Error(`timed out waiting for router\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
        }
        await delay(25);
    }
    await delay(50);
}

function connectWebSocketWithStatus({ url, headers = {} }) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const key = crypto.randomBytes(16).toString('base64');
        const req = http.request({
            hostname: urlObj.hostname,
            port: urlObj.port || 80,
            path: `${urlObj.pathname}${urlObj.search}`,
            method: 'GET',
            headers: {
                host: urlObj.host,
                upgrade: 'websocket',
                connection: 'Upgrade',
                'sec-websocket-key': key,
                'sec-websocket-version': '13',
                ...headers,
            },
        });
        req.setTimeout(3000, () => req.destroy(new Error('websocket upgrade timed out')));
        req.on('upgrade', (res, socket, head) => {
            const expectedAccept = crypto.createHash('sha1')
                .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest('base64');
            if (res.headers['sec-websocket-accept'] !== expectedAccept) {
                socket.destroy();
                reject(new Error('invalid sec-websocket-accept'));
                return;
            }
            if (head?.length) socket.unshift(head);
            resolve({ statusCode: res.statusCode, headers: res.headers, ws: new WebSocket(socket, false) });
        });
        req.on('response', (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
                reject(new Error(
                    `expected upgrade, got ${res.statusCode} (${res.headers.location || 'no location'}): `
                    + Buffer.concat(chunks).toString('utf8'),
                ));
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function waitForMessage(ws, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for WebSocket message')), timeoutMs);
        ws.once('message', (message) => {
            clearTimeout(timer);
            resolve(message);
        });
        ws.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

async function stopChild(child) {
    if (child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
        if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    }, 2000);
    try {
        await once(child, 'exit');
    } catch (_) {
        // Ignore teardown races.
    } finally {
        clearTimeout(timer);
    }
}

function closeWebSocket(ws) {
    if (!ws?.socket || ws.socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            try { ws.socket.destroy(); } catch (_) {}
            resolve();
        }, 1500);
        ws.socket.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
        try { ws.close(); } catch (_) {
            try { ws.socket.destroy(); } catch (_) {}
        }
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256BodyHash(body) {
    return crypto.createHash('sha256').update(Buffer.from(body)).digest('base64url');
}
