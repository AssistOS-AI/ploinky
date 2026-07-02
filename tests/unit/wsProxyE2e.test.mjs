import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRchHttp } from '../../Agent/lib/requestHash.mjs';
import { verifyRouterRequestToken } from '../../Agent/lib/requestSignedTokens.mjs';
import { deriveAgentRequestSecret } from '../../cli/services/masterKey.js';
import { acceptWebSocketUpgrade, WebSocket } from '../../cli/server/utils/websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '5'.repeat(64);

test('router proxies authenticated WebSocket upgrades to HTTP-service agents', async (t) => {
    let captured = null;
    let router = null;
    let ws = null;
    let explorer = null;
    const upstream = http.createServer();
    upstream.on('upgrade', (req, socket, head) => {
        captured = {
            url: req.url,
            authInfo: req.headers['x-ploinky-auth-info'],
        };
        const ws = acceptWebSocketUpgrade(req, socket, head);
        ws?.on('message', (message) => {
            ws.send(`echo:${message.toString('utf8')}`);
        });
    });
    const upstreamPort = await listen(upstream);
    explorer = createReadyMcpServer();
    const explorerPort = await listen(explorer);

    const fixture = createRoutingFixture(upstreamPort, explorerPort);
    const previousEnv = setFixtureEnv(fixture);
    t.after(async () => {
        if (ws) await closeWebSocket(ws);
        if (router) await stopChild(router);
        if (explorer) await close(explorer);
        await close(upstream);
        restoreEnv(previousEnv);
        rmSync(fixture.workspace, { recursive: true, force: true });
    });

    const routerPort = await getFreePort();
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
    const ssoCookie = await loginWithFakeSso(routerPort);

    let connected;
    try {
        connected = await connectWebSocketWithStatus({
            url: `ws://127.0.0.1:${routerPort}/services/demo/management/ws/logs?tail=1`,
            headers: {
                cookie: ssoCookie,
            },
        });
    } catch (err) {
        throw new Error(`${err?.message || err}\nrouter stdout:\n${output.stdout}\nrouter stderr:\n${output.stderr}\nrouter log:\n${readRouterLog(fixture)}`);
    }
    const { statusCode } = connected;
    ws = connected.ws;

    assert.equal(statusCode, 101);
    ws.send('ping');
    const message = await waitForMessage(ws);

    assert.equal(message.toString('utf8'), 'echo:ping');
    assert.equal(captured?.url, '/internal/management/ws/logs?tail=1');
    assert.equal(typeof captured?.authInfo, 'string');

    const authInfo = JSON.parse(captured.authInfo);
    assert.equal(authInfo.user.id, 'sso:admin');
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
    assert.equal(verified.payload.sub, 'user:sso:admin');

    await closeWebSocket(ws);
    ws = null;
    await stopChild(router);
    router = null;
});

function createRoutingFixture(servicePort, explorerPort) {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ploinky-ws-e2e-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const explorerManifestDir = path.join(ploinkyDir, 'repos', 'fixtures', 'explorer');
    const serviceManifestDir = path.join(ploinkyDir, 'repos', 'fixtures', 'demoService');
    const providerDir = path.join(ploinkyDir, 'repos', 'fixtures', 'fakeProvider');
    const routingFile = path.join(ploinkyDir, 'routing.json');

    mkdirSync(explorerManifestDir, { recursive: true });
    mkdirSync(serviceManifestDir, { recursive: true });
    mkdirSync(path.join(providerDir, 'runtime'), { recursive: true });
    writeFileSync(path.join(explorerManifestDir, 'manifest.json'), JSON.stringify({ about: 'Explorer' }, null, 2));
    writeFileSync(path.join(serviceManifestDir, 'manifest.json'), JSON.stringify({
        httpServices: [{
            slug: 'demo',
            externalPrefix: '/services/demo/',
            internalPrefix: '/internal/',
            access: 'authenticated',
        }],
    }, null, 2));
    writeFileSync(path.join(providerDir, 'manifest.json'), JSON.stringify({
        ssoProvider: true,
    }, null, 2));
    writeFileSync(path.join(providerDir, 'runtime', 'index.mjs'), `
export function resolveProviderConfig({ providerConfig = {} } = {}) {
    return {
        issuerBaseUrl: providerConfig.issuerBaseUrl || 'https://fake.test',
        clientId: providerConfig.clientId || 'fake-client'
    };
}

export function createProvider() {
    return {
        async sso_begin_login() {
            return {
                authorizationUrl: 'https://fake.test/auth?state=PROVIDER_STATE',
                providerState: 'PROVIDER_STATE',
                expiresAt: Date.now() + 60_000
            };
        },
        async sso_handle_callback() {
            return {
                user: {
                    id: 'sso:admin',
                    username: 'admin',
                    email: 'admin@example.test',
                    roles: ['user', 'admin'],
                    capabilities: ['explorer.access']
                },
                providerSession: {
                    provider: 'fixtures/fakeProvider',
                    tokens: { accessToken: 'AT', tokenType: 'Bearer' },
                    expiresAt: Date.now() + 60_000
                }
            };
        },
        async sso_refresh_session({ providerSession }) {
            return { user: null, providerSession };
        },
        async sso_logout() {
            return { redirectUrl: '/' };
        }
    };
}
`);
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'fixtures',
            auth: { mode: 'sso' },
        },
        demoService: {
            type: 'agent',
            agentName: 'demoService',
            repoName: 'fixtures',
            auth: { mode: 'none' },
        },
        _config: {
            sso: {
                enabled: true,
                providerAgent: 'fixtures/fakeProvider',
                providerConfig: {
                    issuerBaseUrl: 'https://fake.test',
                    clientId: 'fake-client',
                },
            },
        },
    }, null, 2));
    writeFileSync(routingFile, JSON.stringify({
        routes: {
            explorer: {
                agent: 'explorer',
                repo: 'fixtures',
                hostPort: explorerPort,
                hostPath: explorerManifestDir,
            },
            demoService: {
                agent: 'demoService',
                repo: 'fixtures',
                hostPort: servicePort,
                hostPath: serviceManifestDir,
            },
        },
        static: {
            agent: 'explorer',
            hostPath: explorerManifestDir,
        },
    }, null, 2));

    return { workspace, routingFile };
}

function createReadyMcpServer() {
    return http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/mcp') {
            res.writeHead(404);
            res.end();
            return;
        }
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            let body = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            } catch (_) { }
            if (body.method === 'initialize') {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'mcp-session-id': 'ready-session',
                });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'ready', version: '1.0.0' } },
                }));
                return;
            }
            if (body.method === 'notifications/initialized') {
                res.writeHead(204);
                res.end();
                return;
            }
            if (body.method === 'tools/list') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }));
                return;
            }
            res.writeHead(404);
            res.end();
        });
    });
}

function setFixtureEnv(fixture) {
    const previous = {
        PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
        PLOINKY_ROUTING_FILE: process.env.PLOINKY_ROUTING_FILE,
        PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
    };
    process.env.PLOINKY_WORKSPACE_ROOT = fixture.workspace;
    process.env.PLOINKY_ROUTING_FILE = fixture.routingFile;
    process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
    return previous;
}

async function loginWithFakeSso(routerPort) {
    const login = await httpRequest({
        port: routerPort,
        path: '/auth/login?agent=explorer&returnTo=/services/demo/management/ws/logs%3Ftail%3D1',
    });
    assert.equal(login.statusCode, 200);
    const stateMatch = login.body.match(/state=([^"&]+)/);
    assert.ok(stateMatch, login.body);
    const callback = await httpRequest({
        port: routerPort,
        path: `/auth/callback?agent=explorer&code=auth-code&state=${stateMatch[1]}`,
    });
    assert.equal(callback.statusCode, 302);
    const setCookie = String(callback.headers['set-cookie']?.[0] || callback.headers['set-cookie'] || '');
    assert.match(setCookie, /^ploinky_sso=/);
    return setCookie.split(';')[0];
}

function httpRequest({ port, path: requestPath }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            method: 'GET',
            headers: { accept: 'text/html,application/json' },
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
        req.setTimeout(3000, () => req.destroy(new Error('HTTP request timed out')));
        req.on('error', reject);
        req.end();
    });
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

function readRouterLog(fixture) {
    try {
        return readFileSync(path.join(fixture.workspace, '.ploinky', 'logs', 'router.log'), 'utf8');
    } catch (_) {
        return '';
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
                reject(new Error(`expected upgrade, got ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
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

function getFreePort() {
    const server = http.createServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
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
