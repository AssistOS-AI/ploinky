import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    applyEdgeRoutingGeneration,
    inactivateEdgeRoutingGeneration,
} from '../../cli/sandbox/edgeGeneration.js';
import { commitRoutePlan, resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import {
    createAgentRouteEntries,
    createLeaseCommittedAgent,
    handleRouterMcp,
    proxyHttpBuffered,
    proxyHttpPassthrough,
} from '../../cli/server/routerHandlers.js';
import { serveAgentStaticRequest } from '../../cli/server/static/index.js';
import { proxyWsUpgrade } from '../../cli/server/wsServiceProxy.js';

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address().port);
        });
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

function responseCapture() {
    let resolve;
    const completed = new Promise((done) => { resolve = done; });
    return {
        headersSent: false,
        statusCode: 0,
        headers: {},
        body: '',
        completed,
        writeHead(statusCode, headers = {}) {
            this.statusCode = statusCode;
            this.headers = { ...headers };
            this.headersSent = true;
            return this;
        },
        end(value = '') {
            this.body += Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
            resolve();
        },
    };
}

function createActiveGenerationFixture(t, targetPort) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-dial-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const manifestDir = path.join(ploinkyDir, 'repos', 'fixtures', 'events');
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.mkdirSync(policyDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({
        httpServices: [{
            slug: 'events',
            externalPrefix: '/public-services/events/',
            internalPrefix: '/',
            access: 'public',
        }],
    }));
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'events', port: 7777 },
        routes: {
            events: {
                repo: 'fixtures',
                agent: 'events',
                container: 'events-container',
                hostPath: manifestDir,
                hostPort: targetPort,
            },
        },
    }));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        'events-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'events',
            instanceId: 'events-instance',
            enableGeneration: 'events-enable-generation',
            auth: { mode: 'none' },
        },
    }));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({
        schemaVersion: 1,
        hosts: {},
        security: {
            hostNetworkAllowedInstances: [],
            internalServiceConsumers: {},
        },
    }));
    const policyFile = path.join(policyDir, 'policy-state.json');
    fs.writeFileSync(policyFile, JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    }));

    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const previousRouterHostPort = process.env.PLOINKY_ROUTER_HOST_PORT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    t.after(() => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        if (previousRouterHostPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
        else process.env.PLOINKY_ROUTER_HOST_PORT = previousRouterHostPort;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'real-dial-lease-fixture' });
    return { workspace, policyFile };
}

class SocketCapture extends EventEmitter {
    constructor() {
        super();
        this.output = '';
        this.destroyed = false;
        this.completed = new Promise((resolve) => { this.resolve = resolve; });
    }

    write(value) {
        this.output += Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
        return true;
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.resolve();
        this.emit('close');
    }
}

test('lease guard runs synchronously inside the actual connection factory', async () => {
    let guardCalls = 0;
    let connectionFactoryCalls = 0;
    const agent = createLeaseCommittedAgent(() => {
        guardCalls += 1;
        return false;
    }, {
        createConnection() {
            connectionFactoryCalls += 1;
            throw new Error('connection factory must not run for a stale lease');
        },
    });
    await new Promise((resolve, reject) => {
        const request = agent.createConnection({ host: '127.0.0.1', port: 9 }, (error) => {
            try {
                assert.equal(error.code, 'EDGE_GENERATION_CHANGED');
                resolve();
            } catch (assertionError) {
                reject(assertionError);
            }
        });
        assert.equal(request, undefined);
        assert.equal(guardCalls, 1);
        assert.equal(connectionFactoryCalls, 0);
    });
});

test('stale HTTP/SSE and buffered leases return 503 without touching the target', async (t) => {
    let targetConnections = 0;
    const target = net.createServer((socket) => {
        targetConnections += 1;
        socket.destroy();
    });
    const port = await listen(target);
    t.after(() => close(target));

    let streamingGuardCalls = 0;
    const streamingReq = new PassThrough();
    streamingReq.method = 'GET';
    streamingReq.headers = { accept: 'text/event-stream' };
    const streamingRes = responseCapture();
    proxyHttpPassthrough(streamingReq, streamingRes, port, '/events', {}, {
        beforeDial: () => {
            streamingGuardCalls += 1;
            return false;
        },
    });
    streamingReq.end();
    await streamingRes.completed;
    assert.equal(streamingRes.statusCode, 503);
    assert.match(streamingRes.body, /edge_generation_changed/);
    assert.equal(streamingGuardCalls, 1);

    let bufferedGuardCalls = 0;
    const bufferedReq = new PassThrough();
    bufferedReq.method = 'POST';
    bufferedReq.headers = { 'content-type': 'application/json' };
    const bufferedRes = responseCapture();
    proxyHttpBuffered(bufferedReq, bufferedRes, port, '/submit', Buffer.from('{"ok":true}'), {}, {
        beforeDial: () => {
            bufferedGuardCalls += 1;
            return false;
        },
    });
    await bufferedRes.completed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bufferedRes.statusCode, 503);
    assert.match(bufferedRes.body, /edge_generation_changed/);
    assert.equal(bufferedGuardCalls, 1);
    assert.equal(targetConnections, 0);
});

test('stale WebSocket lease returns 503 without creating a target TCP connection', async (t) => {
    let targetConnections = 0;
    const target = net.createServer((socket) => {
        targetConnections += 1;
        socket.destroy();
    });
    const port = await listen(target);
    t.after(() => close(target));

    let guardCalls = 0;
    const socket = new SocketCapture();
    proxyWsUpgrade({
        socket,
        head: Buffer.alloc(0),
        hostPort: port,
        upstreamPath: '/socket',
        forwardHeaders: { connection: 'Upgrade', upgrade: 'websocket' },
        extraResponseHeaders: {},
        beforeDial: () => {
            guardCalls += 1;
            return false;
        },
    });
    await socket.completed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(socket.output, /^HTTP\/1\.1 503 Service Unavailable/m);
    assert.equal(guardCalls, 1);
    assert.equal(targetConnections, 0);
});

test('an active authorized plan inactivated before the real HTTP, SSE, and WebSocket dial creates zero target connections', async (t) => {
    let targetConnections = 0;
    const target = net.createServer((socket) => {
        targetConnections += 1;
        socket.destroy();
    });
    const port = await listen(target);
    t.after(() => close(target));
    const fixture = createActiveGenerationFixture(t, port);

    const routeReq = {
        method: 'GET',
        url: '/public-services/events/stream?topic=lease',
        headers: { host: 'localhost' },
    };
    const routePlan = resolveEdgeRoutePlan({
        req: routeReq,
        parsedUrl: new URL(routeReq.url, 'http://localhost'),
        listener: 'public',
    });
    assert.equal(routePlan.ok, true);
    assert.equal(routePlan.decision.access, 'public');
    assert.equal(routePlan.target.hostPort, port);

    // This is a real candidate mutation after authorization. Candidate bytes
    // alone remain inert, then the coordinated invalidation revokes the exact
    // lease before each connection factory reaches net.createConnection().
    fs.writeFileSync(fixture.policyFile, JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [{ path: '/public-services/events/*', access: 'deny' }],
        mcpTools: [],
    }));
    inactivateEdgeRoutingGeneration('post-authorization-test-mutation', {
        workspaceRoot: fixture.workspace,
    });

    const guardCalls = { http: 0, sse: 0, ws: 0 };
    const httpReq = new PassThrough();
    httpReq.method = 'POST';
    httpReq.headers = { 'content-type': 'application/json' };
    const httpRes = responseCapture();
    proxyHttpBuffered(
        httpReq,
        httpRes,
        routePlan.target.hostPort,
        routePlan.upstreamPath,
        Buffer.from('{"ok":true}'),
        {},
        {
            beforeDial: () => {
                guardCalls.http += 1;
                return commitRoutePlan(routePlan);
            },
        },
    );

    const sseReq = new PassThrough();
    sseReq.method = 'GET';
    sseReq.headers = { accept: 'text/event-stream' };
    const sseRes = responseCapture();
    proxyHttpPassthrough(
        sseReq,
        sseRes,
        routePlan.target.hostPort,
        routePlan.upstreamPath,
        {},
        {
            beforeDial: () => {
                guardCalls.sse += 1;
                return commitRoutePlan(routePlan);
            },
        },
    );
    sseReq.end();

    const wsSocket = new SocketCapture();
    proxyWsUpgrade({
        socket: wsSocket,
        head: Buffer.alloc(0),
        hostPort: routePlan.target.hostPort,
        upstreamPath: routePlan.upstreamPath,
        forwardHeaders: { connection: 'Upgrade', upgrade: 'websocket' },
        extraResponseHeaders: {},
        beforeDial: () => {
            guardCalls.ws += 1;
            return commitRoutePlan(routePlan);
        },
    });

    await Promise.all([httpRes.completed, sseRes.completed, wsSocket.completed]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(httpRes.statusCode, 503);
    assert.match(httpRes.body, /edge_generation_changed/);
    assert.equal(sseRes.statusCode, 503);
    assert.match(sseRes.body, /edge_generation_changed/);
    assert.match(wsSocket.output, /^HTTP\/1\.1 503 Service Unavailable/m);
    assert.deepEqual(guardCalls, { http: 1, sse: 1, ws: 1 });
    assert.equal(targetConnections, 0);
});

test('aggregate MCP clients use only the captured generation and create zero connections after inactivation', async (t) => {
    let targetConnections = 0;
    const target = net.createServer((socket) => {
        targetConnections += 1;
        socket.destroy();
    });
    const port = await listen(target);
    t.after(() => close(target));

    let active = true;
    const routePlan = {
        lease: {
            snapshot: {
                routing: {
                    routes: {
                        captured: { hostPort: port },
                    },
                },
            },
            commit: () => active,
        },
    };
    const entries = createAgentRouteEntries(routePlan);
    assert.deepEqual(entries.map((entry) => entry.agentName), ['captured']);
    active = false;

    await assert.rejects(
        entries[0].client.listTools(),
        (error) => error?.code === 'EDGE_GENERATION_CHANGED',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(targetConnections, 0);
});

test('aggregate MCP request returns 503 and creates zero target connections when its captured lease is stale', async (t) => {
    let targetConnections = 0;
    const target = net.createServer((socket) => {
        targetConnections += 1;
        socket.destroy();
    });
    const port = await listen(target);
    t.after(() => close(target));
    const routePlan = {
        lease: {
            snapshot: {
                routing: { routes: { captured: { hostPort: port } } },
            },
            commit: () => false,
        },
    };
    const req = new PassThrough();
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json' };
    const res = responseCapture();

    await handleRouterMcp(req, res, routePlan);
    req.end(JSON.stringify({ command: 'list_tools' }));
    await res.completed;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.statusCode, 503);
    assert.match(res.body, /edge_generation_changed/);
    assert.equal(targetConnections, 0);
});

test('agent static dispatch uses its captured host path and refuses a stale generation before opening the file', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-static-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>captured</h1>');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const res = responseCapture();
    const handled = await serveAgentStaticRequest({
        url: '/captured/index.html',
        headers: { host: 'localhost' },
    }, res, {
        routeKey: 'captured',
        hostPath: root,
        beforeRead: () => false,
    });

    await res.completed;
    assert.equal(handled, true);
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /edge_generation_changed/);
});
