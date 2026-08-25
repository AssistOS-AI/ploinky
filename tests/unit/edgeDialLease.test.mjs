import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    createAgentRouteEntries,
    createLeaseCommittedAgent,
    handleRouterMcp,
    proxyHttpBuffered,
    proxyHttpPassthrough,
} from '../../cli/server/routerHandlers.js';
import { serveAgentStaticRequest } from '../../cli/server/static/index.js';

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

test('stale HTTP/SSE and buffered leases return 503 before opening a target connection', async () => {
    const streamingReq = new PassThrough();
    streamingReq.method = 'GET';
    streamingReq.headers = { accept: 'text/event-stream' };
    const streamingRes = responseCapture();
    proxyHttpPassthrough(streamingReq, streamingRes, 9, '/events', {}, {
        beforeDial: () => false,
    });
    streamingReq.end();
    await streamingRes.completed;
    assert.equal(streamingRes.statusCode, 503);
    assert.match(streamingRes.body, /edge_generation_changed/);

    const bufferedReq = new PassThrough();
    bufferedReq.method = 'POST';
    bufferedReq.headers = { 'content-type': 'application/json' };
    const bufferedRes = responseCapture();
    proxyHttpBuffered(
        bufferedReq,
        bufferedRes,
        9,
        '/submit',
        Buffer.from('{"ok":true}'),
        {},
        { beforeDial: () => false },
    );
    await bufferedRes.completed;
    assert.equal(bufferedRes.statusCode, 503);
    assert.match(bufferedRes.body, /edge_generation_changed/);
});

test('aggregate MCP clients refuse a stale captured generation before dialing', async () => {
    const routePlan = {
        lease: {
            snapshot: {
                routing: {
                    routes: {
                        captured: { hostPort: 9 },
                        draining: { hostPort: 10, draining: true },
                    },
                },
            },
            commit: () => false,
        },
    };
    const entries = createAgentRouteEntries(routePlan);
    assert.deepEqual(entries.map((entry) => entry.agentName), ['captured']);
    await assert.rejects(
        entries[0].client.listTools(),
        (error) => error?.code === 'EDGE_GENERATION_CHANGED',
    );
});

test('aggregate MCP request returns 503 when its captured lease is stale', async () => {
    const routePlan = {
        lease: {
            snapshot: {
                routing: { routes: { captured: { hostPort: 9 } } },
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

    assert.equal(res.statusCode, 503);
    assert.match(res.body, /edge_generation_changed/);
});

test('agent static dispatch refuses a stale generation before opening a file', async (t) => {
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
