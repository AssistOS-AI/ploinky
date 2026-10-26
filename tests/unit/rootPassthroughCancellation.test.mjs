import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { proxyHttpBuffered, proxyHttpPassthrough } from '../../cli/server/routerHandlers.js';

const SETTLE_MS = 2_000;

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function within(promise, milliseconds = SETTLE_MS) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), milliseconds); }),
    ]).finally(() => clearTimeout(timer));
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closeServer(server) {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => resolve()));
}

// The target records when its request reaches it and when the Router's
// upstream connection to it closes. `respond` decides what it sends back.
async function startTarget(t, respond) {
    const received = deferred();
    const upstreamClosed = deferred();
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            received.resolve({ method: req.method, url: req.url, body: Buffer.concat(chunks) });
            respond(req, res);
        });
        res.once('close', () => upstreamClosed.resolve('closed'));
    });
    const port = await listen(server);
    t.after(() => closeServer(server));
    return { port, received: received.promise, upstreamClosed: upstreamClosed.promise };
}

async function startRouter(t, handle) {
    const routerRequest = deferred();
    const server = http.createServer((req, res) => {
        routerRequest.resolve(req);
        handle(req, res);
    });
    const port = await listen(server);
    t.after(() => closeServer(server));
    return { port, routerRequest: routerRequest.promise };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function bufferedRouter(targetPort) {
    return async (req, res) => {
        const body = await readBody(req);
        proxyHttpBuffered(req, res, targetPort, '/v1/chat/completions', body);
    };
}

function passthroughRouter(targetPort) {
    return (req, res) => {
        proxyHttpPassthrough(req, res, targetPort, '/events');
    };
}

function sendClientRequest(port, { method = 'GET', path = '/', body } = {}) {
    const request = http.request({
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {},
    });
    request.on('error', () => {});
    const response = new Promise((resolve) => request.once('response', resolve));
    request.end(body);
    return { request, response };
}

function holdSseOpen(_req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: first\n\n');
}

function neverRespond() {}

async function assertDisconnectAfterCompleteRequestClosesUpstream(router, target, client, { waitForFirstChunk }) {
    const routerReq = await router.routerRequest;
    if (waitForFirstChunk) {
        const response = await client.response;
        assert.equal(response.statusCode, 200);
        await new Promise((resolve) => response.once('data', resolve));
    } else {
        await target.received;
    }
    // A complete client request never emits `aborted`, so the disconnect is
    // observable to the Router only through the downstream response closing.
    assert.equal(routerReq.complete, true);
    client.request.destroy();
    assert.equal(await within(target.upstreamClosed), 'closed');
}

test('passthrough: downstream close after a complete request destroys an open SSE upstream', async (t) => {
    const target = await startTarget(t, holdSseOpen);
    const router = await startRouter(t, passthroughRouter(target.port));
    const client = sendClientRequest(router.port, { path: '/agent/events' });
    await assertDisconnectAfterCompleteRequestClosesUpstream(router, target, client, { waitForFirstChunk: true });
});

test('passthrough: downstream close before upstream headers destroys the pending upstream', async (t) => {
    const target = await startTarget(t, neverRespond);
    const router = await startRouter(t, passthroughRouter(target.port));
    const client = sendClientRequest(router.port, {
        method: 'POST',
        path: '/agent/submit',
        body: Buffer.from('{"slow":true}'),
    });
    await assertDisconnectAfterCompleteRequestClosesUpstream(router, target, client, { waitForFirstChunk: false });
});

test('buffered: downstream close after headers destroys a streaming delegated completion', async (t) => {
    const target = await startTarget(t, holdSseOpen);
    const router = await startRouter(t, bufferedRouter(target.port));
    const client = sendClientRequest(router.port, {
        method: 'POST',
        path: '/agent/v1/chat/completions',
        body: Buffer.from('{"stream":true}'),
    });
    await assertDisconnectAfterCompleteRequestClosesUpstream(router, target, client, { waitForFirstChunk: true });
});

test('buffered: downstream close before upstream headers cancels a delegated completion', async (t) => {
    const target = await startTarget(t, neverRespond);
    const router = await startRouter(t, bufferedRouter(target.port));
    const client = sendClientRequest(router.port, {
        method: 'POST',
        path: '/agent/v1/chat/completions',
        body: Buffer.from('{"stream":false}'),
    });
    await assertDisconnectAfterCompleteRequestClosesUpstream(router, target, client, { waitForFirstChunk: false });
});

for (const [name, routerFor, request] of [
    ['passthrough', passthroughRouter, { path: '/agent/events' }],
    ['buffered', bufferedRouter, { method: 'POST', path: '/agent/v1/chat/completions', body: Buffer.from('{}') }],
]) {
    test(`${name}: a quiet period after the first chunk is not cut, and no long deadline is armed`, async (t) => {
        // Streaming responders may pause for minutes between chunks within
        // their own budgets, so the Router must not arm its own long deadline
        // (such as the agent-port idle or header timeout) on root routes.
        const longTimers = [];
        const originalSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, delay, ...args) => {
            // Anything longer than this file's own settle wait is a proxy deadline.
            if (Number(delay) > SETTLE_MS) longTimers.push(Number(delay));
            return originalSetTimeout(callback, delay, ...args);
        };
        t.after(() => { globalThis.setTimeout = originalSetTimeout; });
        const target = await startTarget(t, (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: first\n\n');
            const timer = originalSetTimeout(() => res.end('data: after-quiet\n\n'), 600);
            res.once('close', () => clearTimeout(timer));
        });
        const router = await startRouter(t, routerFor(target.port));
        const client = sendClientRequest(router.port, request);
        const response = await client.response;
        const body = await within(readBody(response));

        assert.equal(Buffer.isBuffer(body) ? body.toString('utf8') : body, 'data: first\n\ndata: after-quiet\n\n');
        assert.equal(response.complete, true);
        assert.deepEqual(longTimers, []);
    });

    test(`${name}: an upstream reset mid-stream ends the downstream without appending an error body`, async (t) => {
        const target = await startTarget(t, (req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: partial\n\n');
            setTimeout(() => req.socket.destroy(), 50);
        });
        const router = await startRouter(t, routerFor(target.port));
        const client = sendClientRequest(router.port, request);
        const response = await client.response;
        let received = '';
        response.on('data', (chunk) => { received += chunk.toString('utf8'); });
        response.on('error', () => {});
        const responseClosed = new Promise((resolve) => response.once('close', () => resolve('closed')));

        assert.equal(await within(responseClosed), 'closed');
        assert.equal(received, 'data: partial\n\n');
        assert.equal(response.complete, false);
    });

    test(`${name}: a completed response is relayed intact`, async (t) => {
        const target = await startTarget(t, (req, res) => {
            res.writeHead(201, { 'content-type': 'application/json', 'x-target': 'yes' });
            res.end(JSON.stringify({ method: req.method, url: req.url }));
        });
        const router = await startRouter(t, routerFor(target.port));
        const client = sendClientRequest(router.port, request);
        const response = await client.response;
        const body = await readBody(response);
        const received = await target.received;

        assert.equal(response.statusCode, 201);
        assert.equal(response.headers['x-target'], 'yes');
        assert.deepEqual(JSON.parse(body.toString('utf8')), { method: received.method, url: received.url });
        assert.deepEqual(received.body, request.body || Buffer.alloc(0));
        assert.equal(response.complete, true);
    });
}
